// Extract Variable (⌥⌘V), Extract Constant (⌥⌘C), Introduce Field (⌥⌘F), and Extract Method (⌥⌘M), as in
// PhpStorm: with nothing selected, choose among the expressions around the caret; choose whether to replace every
// occurrence; then type the new name in place, with every use following it. Tusk's server reads the code and
// writes the edits (`tusk/extractTargets`, `tusk/extract`, and Extract Method's command); this is the UI.
import type * as L from "vscode-languageserver-protocol";
import { monaco } from "./editor";
import { h } from "./dom";
import { runTuskAction, tuskRequest } from "./lsp";
import { pick, pickNote, type Item } from "./palette";
import { parseTypeDeclarations } from "./phptypes";
import { snippetText } from "./postfix";
import { symbolAt } from "./safedelete";

type Host = { status(text: string): void };
let host: Host;

type Editor = monaco.editor.ICodeEditor;
type Snippets = { insert(template: string, opts?: object): void; cancel(): void; isInSnippet(): boolean };

/** What the server can extract into: `tusk/extractTargets`' and `tusk/extract`'s `kind`. */
export type ExtractKind = "variable" | "constant" | "field" | "parameter";
/**
 * An expression the server offers, with the occurrences the same extraction could replace, itself included, and for
 * each, when it runs only sometimes, the condition, as "when $n > 1 is true": extracted, it would run every time.
 */
export type Target = { range: L.Range; text: string; occurrences: L.Range[]; conditions?: (string | null)[] };
/** The server's edit: `\0` marks each place the new name goes, `name` is its suggestion. */
export type Extraction = { edits: L.TextEdit[]; name: string; type: string | null; constant: boolean };

const snippets = (editor: Editor) => editor.getContribution("snippetController2") as unknown as Snippets;
const toRange = (r: L.Range) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
const fromRange = (r: monaco.IRange): L.Range => ({ start: { line: r.startLineNumber - 1, character: r.startColumn - 1 }, end: { line: r.endLineNumber - 1, character: r.endColumn - 1 } });
const oneLine = (text: string) => (text.length > 80 ? `${text.slice(0, 77)}…` : text).replace(/\s*\n\s*/g, " ");

/** Opens a picker below the caret, as PhpStorm's refactoring popups open. */
export function pickAtCaret(editor: Editor, title: string, items: Item[] | ((q: string) => Item[]), onCancel?: () => void, code = false) {
  const at = editor.getScrolledVisiblePosition(editor.getPosition()!);
  const box = editor.getDomNode()!.getBoundingClientRect();
  const anchor = document.createElement("div");
  anchor.style.cssText = `position:fixed;left:${box.left + (at?.left ?? 0)}px;top:${box.top + (at?.top ?? 0)}px;height:${at?.height ?? 18}px;width:0`;
  document.body.append(anchor);
  const source = typeof items === "function" ? items : (q: string) => items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase()));
  pick(title, source, 0, { value: "", anchor, onCancel, title, numbered: true, code });
  anchor.remove();
}

/**
 * Asks in a popup at the caret, highlighting in the editor what each option would change, with its warning, if any,
 * below the title while it's the one highlighted. Null for Escape.
 */
export function ask<T>(editor: Editor, title: string, options: { label: string; detail?: string; warning?: string; value: T; highlight: L.Range[] }[], code = false): Promise<T | null> {
  const marks = editor.createDecorationsCollection();
  const show = (ranges: L.Range[]) => {
    marks.set(ranges.map((r) => ({ range: toRange(r), options: { className: "refactor-highlight", overviewRuler: { color: "#4a9eff99", position: monaco.editor.OverviewRulerLane.Center } } })));
    if (ranges[0]) editor.revealRangeInCenterIfOutsideViewport(toRange(ranges[0]));
  };
  return new Promise((resolve) => {
    const finish = (value: T | null) => {
      marks.clear();
      editor.focus();
      resolve(value);
    };
    const items: Item[] = options.map((o) => ({
      label: o.label,
      detail: o.detail,
      run: () => finish(o.value),
      preview: () => {
        show(o.highlight);
        pickNote(o.warning);
      },
    }));
    pickAtCaret(editor, title, items, () => finish(null), code);
  });
}

// ---- Hints at the caret ----

const hints = new WeakMap<Editor, () => void>();

/**
 * A hint above the selection's start, as PhpStorm shows one, following it as it moves, until `until` fires or
 * another hint replaces it.
 */
function showHint(editor: Editor, node: HTMLElement, until: (hide: () => void) => monaco.IDisposable[]) {
  hints.get(editor)?.();
  const widget: monaco.editor.IContentWidget = {
    getId: () => "tusk.refactorHint",
    getDomNode: () => node,
    getPosition: () => ({
      position: editor.getSelection()?.getStartPosition() ?? null,
      preference: [monaco.editor.ContentWidgetPositionPreference.ABOVE, monaco.editor.ContentWidgetPositionPreference.BELOW],
    }),
  };
  editor.addContentWidget(widget);
  const moved = editor.onDidChangeCursorSelection(() => editor.layoutContentWidget(widget));
  const hide = () => {
    moved.dispose();
    disposables.forEach((d) => d.dispose());
    editor.removeContentWidget(widget);
    if (hints.get(editor) === hide) hints.delete(editor);
  };
  const disposables = until(hide);
  hints.set(editor, hide);
}

/** Why a refactoring can't run here: a hint at the caret until the caret moves or the text changes, and in the status bar. */
export function refuse(editor: Editor, message: string) {
  host.status(message);
  showHint(editor, h("div", { class: "naming-hint refactor-refusal", role: "alert" }, message), (hide) => {
    const timer = setTimeout(hide, 6000);
    return [editor.onDidChangeCursorPosition(hide), editor.onDidChangeModelContent(hide), editor.onDidBlurEditorText(hide), { dispose: () => clearTimeout(timer) }];
  });
}

// ---- Naming in place ----

const naming = new WeakMap<Editor, monaco.editor.IContextKey<boolean>>();

/** A hint above the name being typed, until naming ends. */
const showNamingHint = (editor: Editor, warning?: string) =>
  showHint(editor, h("div", { class: "naming-hint" }, ...(warning ? [h("span", { class: "naming-warning" }, `⚠ ${warning}`), " · "] : []), h("kbd", {}, "⏎"), " or ", h("kbd", {}, "Esc"), " to finish"), () => []);
const hideNamingHint = (editor: Editor) => hints.get(editor)?.();

/** Enter and Escape finish the name, as in PhpStorm, instead of adding a line at every copy of it. */
function namingKey(editor: Editor): monaco.editor.IContextKey<boolean> {
  const known = naming.get(editor);
  if (known) return known;
  // The app's editors are standalone ones, which can hold their own context keys and commands.
  const standalone = editor as monaco.editor.IStandaloneCodeEditor;
  const key = standalone.createContextKey("tuskNaming", false);
  naming.set(editor, key);
  const done = () => {
    const end = editor.getSelection()?.getEndPosition();
    snippets(editor).cancel();
    key.set(false);
    hideNamingHint(editor);
    if (end) editor.setPosition(end);
  };
  standalone.addCommand(monaco.KeyCode.Enter, done, "tuskNaming && !suggestWidgetVisible");
  standalone.addCommand(monaco.KeyCode.Escape, done, "tuskNaming && !suggestWidgetVisible");
  editor.onDidChangeCursorSelection(() => key.get() && !snippets(editor).isInSnippet() && (key.set(false), hideNamingHint(editor)));
  return key;
}

/**
 * Applies `edits` (`\0` marking where the name goes) as one undoable step, the name a placeholder in every place.
 * Typing then renames them all at once. Edits without the name before the first one with it, such as an import,
 * are applied plainly, so the snippet spans only the code that changes.
 */
function applyNamed(editor: Editor, edits: L.TextEdit[], name: string, warning?: string) {
  const model = editor.getModel()!;
  const offsets = edits.map((e) => ({ start: model.getOffsetAt(toRange(e.range).getStartPosition()), end: model.getOffsetAt(toRange(e.range).getEndPosition()), text: e.newText }));
  offsets.sort((a, b) => a.start - b.start || a.end - b.end);
  const firstNamed = offsets.findIndex((e) => e.text.includes("\0"));
  if (firstNamed < 0) return;
  const plain = offsets.slice(0, firstNamed);
  const named = offsets.slice(firstNamed);
  editor.pushUndoStop();
  let shift = 0;
  if (plain.length) {
    model.pushEditOperations(editor.getSelections(), plain.map((e) => ({ range: monaco.Range.fromPositions(model.getPositionAt(e.start), model.getPositionAt(e.end)), text: e.text })), () => null);
    shift = plain.reduce((n, e) => n + e.text.length - (e.end - e.start), 0);
  }
  const text = model.getValue();
  const [from, to] = [named[0].start + shift, Math.max(...named.map((e) => e.end)) + shift];
  let template = "";
  let at = from;
  for (const e of named) {
    template += snippetText(text.slice(at, e.start + shift)) + snippetText(e.text).replace(/\0/g, `\${1:${name}}`);
    at = e.end + shift;
  }
  template += snippetText(text.slice(at, to));
  editor.setSelection(monaco.Range.fromPositions(model.getPositionAt(from), model.getPositionAt(to)));
  editor.focus();
  snippets(editor).insert(template, { adjustWhitespace: false, undoStopBefore: false, undoStopAfter: true });
  namingKey(editor).set(true);
  showNamingHint(editor, warning);
}

// ---- Choosing ----

export const errorText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));

/** The server's targets for `kind` at the selection, or null after explaining why there are none. */
export async function targetsAt(editor: Editor, kind: ExtractKind, quiet = false): Promise<{ targets: Target[]; snapped: boolean } | null> {
  const model = editor.getModel()!;
  try {
    const found = await tuskRequest<{ targets: Target[]; snapped: boolean }>("tusk/extractTargets", { textDocument: { uri: model.uri.toString() }, range: fromRange(editor.getSelection()!), kind });
    if (!found && !quiet) refuse(editor, "Tusk's PHP server isn't running yet. Try again once it has started.");
    return found;
  } catch (e) {
    if (!quiet) refuse(editor, errorText(e));
    return null;
  }
}

/** The selected expression, or one chosen among those around the caret, for `kind`. Null after a refusal or Escape. */
export async function chosenTarget(editor: Editor, kind: ExtractKind): Promise<Target | null> {
  const found = await targetsAt(editor, kind);
  if (!found) return null;
  const { targets, snapped } = found;
  if (targets.length === 1) {
    if (snapped) host.status(`Extended the selection to the whole expression: ${oneLine(targets[0].text)}`);
    return targets[0];
  }
  return ask(editor, "Expressions", targets.map((t) => ({ label: oneLine(t.text), value: t, highlight: [t.range] })), true);
}

/** What would change about when the occurrences run, for those that run only sometimes. */
export function runsEveryTime(target: Target, all: boolean): string | undefined {
  const own = target.occurrences.findIndex((o) => o.start.line === target.range.start.line && o.start.character === target.range.start.character);
  const conditions = (all ? target.conditions : [target.conditions?.[own]]) ?? [];
  const when = conditions.find((c): c is string => !!c);
  if (!when) return undefined;
  const which = all && conditions.filter(Boolean).length < conditions.length ? "Some will run" : "Will run";
  return `${which} every time, not only ${when}`;
}

/**
 * Whether to replace every occurrence or only the target, as chosen when there are several. An occurrence that runs
 * only sometimes, such as after `&&`, gets its warning in the choice. Null for Escape.
 */
export async function chosenAll(editor: Editor, target: Target): Promise<boolean | null> {
  const n = target.occurrences.length;
  if (n < 2) return false;
  return ask(editor, `${n} occurrences found`, [
    { label: `Replace all ${n} occurrences`, warning: runsEveryTime(target, true), value: true, highlight: target.occurrences },
    { label: "Replace this occurrence only", warning: runsEveryTime(target, false), value: false, highlight: [target.range] },
  ]);
}

/** The server's edit for `target`. Null after a refusal. */
export async function extraction(editor: Editor, kind: ExtractKind, target: Target, all: boolean): Promise<Extraction | null> {
  const model = editor.getModel()!;
  try {
    const found = await tuskRequest<Extraction>("tusk/extract", { textDocument: { uri: model.uri.toString() }, range: target.range, kind, all });
    if (!found) refuse(editor, "Tusk's PHP server isn't running yet. Try again once it has started.");
    return found;
  } catch (e) {
    refuse(editor, errorText(e));
    return null;
  }
}

const phpEditor = (editor: Editor, what: string) => {
  const model = editor.getModel();
  if (model?.getLanguageId() === "php" && !editor.getOption(monaco.editor.EditorOption.readOnly)) return model;
  host.status(`${what} works in PHP files.`);
  return null;
};

/** Choose an expression and its occurrences, then have the server extract them, and type the name in place. */
async function extractInto(editor: Editor, kind: Exclude<ExtractKind, "parameter">, what: string) {
  const model = phpEditor(editor, what);
  if (!model) return;
  const version = model.getVersionId();
  const target = await chosenTarget(editor, kind);
  if (!target) return;
  const all = await chosenAll(editor, target);
  if (all === null) return;
  if (model.getVersionId() !== version) return host.status(`The file changed while choosing. Run ${what} again.`);
  const x = await extraction(editor, kind, target, all);
  if (!x || model.getVersionId() !== version) return;
  applyNamed(editor, x.edits, x.name, runsEveryTime(target, all));
}

export const extractVariable = (editor: Editor) => extractInto(editor, "variable", "Extract Variable");
export const extractConstant = (editor: Editor) => extractInto(editor, "constant", "Extract Constant");
/**
 * Introduce Field (⌥⌘F): puts an expression in a new private property. A constant expression becomes the
 * property's default; anything else is assigned before its first use in the method, as PhpStorm's
 * "initialize in current method". The property's type comes from the analyzer.
 */
export const introduceField = (editor: Editor) => extractInto(editor, "field", "Introduce Field");

// ---- Extract Method ----

export async function extractMethod(editor: Editor) {
  const model = phpEditor(editor, "Extract Method");
  if (!model) return;
  const sel = editor.getSelection()!;
  let range: monaco.IRange = sel;
  if (sel.isEmpty()) {
    const target = await chosenTarget(editor, "variable");
    if (!target) return;
    range = toRange(target.range);
  }
  const before = model.getValue();
  const actions =
    (await tuskRequest<(L.CodeAction | L.Command)[] | null>("textDocument/codeAction", {
      textDocument: { uri: model.uri.toString() },
      range: fromRange(range),
      context: { diagnostics: [], only: ["refactor.extract.method"] },
    }).catch(() => null)) ?? [];
  const action = actions.find((a) => "kind" in a && a.kind === "refactor.extract.method") as L.CodeAction | undefined;
  if (!action?.command) return refuse(editor, "Select whole statements or an expression to extract a method.");
  // The server sends its edit back as workspace/applyEdit, and waits for the editor to apply it before the command returns.
  try {
    await tuskRequest("workspace/executeCommand", { command: action.command.command, arguments: action.command.arguments });
  } catch (e) {
    return refuse(editor, errorText(e));
  }
  const after = model.getValue();
  if (after === before) return refuse(editor, "Couldn't extract a method from this selection.");
  const had = new Set([...before.matchAll(/\bfunction\s+&?(\w+)\s*\(/g)].map((m) => m[1]));
  const name = [...after.matchAll(/\bfunction\s+&?(\w+)\s*\(/g)].map((m) => m[1]).find((n) => !had.has(n));
  if (!name) return;
  // The call and the declaration the server wrote, renamed together, in the same undo step as the extraction.
  const places = [...after.matchAll(new RegExp(`(?:->|::|\\bfunction\\s+&?)(${name})\\s*\\(`, "dg"))].map((m) => ({
    range: fromRange(monaco.Range.fromPositions(model.getPositionAt(m.indices![1]![0]), model.getPositionAt(m.indices![1]![1]))),
    newText: "\0",
  }));
  applyNamed(editor, places, name);
}

// ---- Refactor This ----

const symbolsOf = async (model: monaco.editor.ITextModel) =>
  (await tuskRequest<L.DocumentSymbol[] | null>("textDocument/documentSymbol", { textDocument: { uri: model.uri.toString() } }).catch(() => null)) ?? [];

/**
 * The refactorings that apply at the caret or selection, by action name, and the server's other refactoring
 * actions there, for Refactor This (⌃T).
 */
export async function refactorings(editor: Editor): Promise<{ names: string[]; more: Item[] }> {
  const model = editor.getModel();
  if (!model) return { names: [], more: [] };
  const names = ["Rename"];
  if (model.getLanguageId() !== "php") return { names, more: [] };
  const text = model.getValue();
  const sel = editor.getSelection()!;
  const pos = sel.getPosition();
  const offers = (kind: ExtractKind) => targetsAt(editor, kind, true).then((t) => !!t?.targets.length);
  const [found, variable, constant, field, parameter] = await Promise.all([
    symbolsOf(model).then((s) => symbolAt(s, pos.lineNumber - 1, pos.column - 1)),
    offers("variable"),
    offers("constant"),
    offers("field"),
    offers("parameter"),
  ]);
  if (found && [6, 12].includes(found.symbol.kind)) names.push("Change Signature…");
  if (variable) names.push("Extract Variable…");
  if (constant) names.push("Extract Constant…");
  if (variable || !sel.isEmpty()) names.push("Extract Method…");
  if (field) names.push("Introduce Field…");
  if (parameter) names.push("Introduce Parameter…");
  // The server's own refactorings: Inline when it applies, and others, apart from the extractions above.
  const actions =
    (await tuskRequest<(L.CodeAction | L.Command)[] | null>("textDocument/codeAction", {
      textDocument: { uri: model.uri.toString() },
      range: fromRange(sel),
      context: { diagnostics: [] },
    }).catch(() => null)) ?? [];
  if (actions.some((a) => "kind" in a && a.kind === "refactor.inline")) names.push("Inline…");
  if (found) names.push("Safe Delete…");
  const types = parseTypeDeclarations(text);
  if (types.length === 1) names.push("Move Class…");
  // Pull Members Up needs a parent or an interface; Extract Interface, a class or enum.
  if (types.some((t) => t.kind === "class" && (t.extends.length || t.implements.length))) names.push("Pull Members Up…");
  if (types.some((t) => t.kind === "class" || t.kind === "enum")) names.push("Extract Interface…");
  const more = actions
    .filter((a): a is L.CodeAction => "kind" in a && !!a.kind?.startsWith("refactor") && !(a.kind in interactive))
    .map((a) => ({ label: a.title, run: () => runTuskAction(a) }));
  return { names, more };
}

// ---- The light bulb ----

/** The server's code actions that run here instead, interactively, by kind. refactor.ts adds Inline and Introduce Parameter. */
export const interactive: Record<string, (editor: Editor) => unknown> = {
  "refactor.extract.method": extractMethod,
  "refactor.extract.variable": extractVariable,
  "refactor.extract.constant": extractConstant,
  "refactor.extract.field": introduceField,
};

export function initExtract(h: Host) {
  host = h;
  // Chosen from the light bulb (⌥⏎): the same flow as the shortcut, in the editor that asked.
  monaco.editor.registerCommand("tusk.extract", (_, kind: string, uri: string) => {
    const editor = monaco.editor.getEditors().find((e) => e.hasTextFocus() && e.getModel()?.uri.toString() === uri) ?? monaco.editor.getEditors().find((e) => e.getModel()?.uri.toString() === uri);
    if (editor) void interactive[kind]?.(editor);
  });
}
