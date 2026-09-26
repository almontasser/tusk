// Extract Variable (⌥⌘V), Extract Constant (⌥⌘C), and Extract Method (⌥⌘M), as in PhpStorm: with nothing
// selected, choose among the expressions around the caret; choose whether to replace every occurrence; then
// type the new name in place, with every use following it. Phpactor writes the extracted method; the rest is
// done here, since its Extract Expression names the variable $newVariable and has no Extract Constant.
import type * as L from "vscode-languageserver-protocol";
import { monaco } from "./editor";
import { applyWorkspaceEdit, phpactorRequest } from "./lsp";
import { pick, type Item } from "./palette";
import { parseTypeDeclarations } from "./phptypes";
import { snippetText } from "./postfix";
import { classProperties, matchBracket } from "./refactorparse";
import { symbolAt } from "./safedelete";
import { constantAt, constantName, constantPoint, declarationPoint, expressionIn, expressionsAt, functionScope, literalType, occurrences, variableName, type Expr } from "./extractparse";

type Host = { status(text: string): void };
let host: Host;

type Editor = monaco.editor.ICodeEditor;
type Snippets = { insert(template: string, opts?: object): void; cancel(): void; isInSnippet(): boolean };

const snippets = (editor: Editor) => editor.getContribution("snippetController2") as unknown as Snippets;
const rangeOf = (model: monaco.editor.ITextModel, e: { start: number; end: number }) => monaco.Range.fromPositions(model.getPositionAt(e.start), model.getPositionAt(e.end));
const oneLine = (text: string) => (text.length > 80 ? `${text.slice(0, 77)}…` : text).replace(/\s*\n\s*/g, " ");

/** Opens a picker below the caret, as PhpStorm's refactoring popups open. */
export function pickAtCaret(editor: Editor, title: string, items: Item[] | ((q: string) => Item[]), onCancel?: () => void) {
  const at = editor.getScrolledVisiblePosition(editor.getPosition()!);
  const box = editor.getDomNode()!.getBoundingClientRect();
  const anchor = document.createElement("div");
  anchor.style.cssText = `position:fixed;left:${box.left + (at?.left ?? 0)}px;top:${box.top + (at?.top ?? 0)}px;height:${at?.height ?? 18}px;width:0`;
  document.body.append(anchor);
  pick(title, typeof items === "function" ? items : () => items, 0, { value: "", anchor, onCancel });
  anchor.remove();
}

/** Asks in a popup at the caret, highlighting in the editor what each option would change. Null for Escape. */
function ask<T>(editor: Editor, title: string, options: { label: string; detail?: string; value: T; highlight: Expr[] }[]): Promise<T | null> {
  const model = editor.getModel()!;
  const marks = editor.createDecorationsCollection();
  const show = (h: Expr[]) => marks.set(h.map((e) => ({ range: rangeOf(model, e), options: { className: "refactor-highlight" } })));
  return new Promise((resolve) => {
    const finish = (value: T | null) => {
      marks.clear();
      editor.focus();
      resolve(value);
    };
    const items: Item[] = options.map((o) => ({ label: o.label, detail: o.detail, run: () => finish(o.value), preview: () => show(o.highlight) }));
    pickAtCaret(editor, title, items, () => finish(null));
  });
}

// ---- Naming in place ----

const naming = new WeakMap<Editor, monaco.editor.IContextKey<boolean>>();

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
    if (end) editor.setPosition(end);
  };
  standalone.addCommand(monaco.KeyCode.Enter, done, "tuskNaming && !suggestWidgetVisible");
  standalone.addCommand(monaco.KeyCode.Escape, done, "tuskNaming && !suggestWidgetVisible");
  editor.onDidChangeCursorSelection(() => key.get() && !snippets(editor).isInSnippet() && key.set(false));
  return key;
}

/**
 * Applies `edits` (offsets in the model's text, `\0` marking where the name goes) as one undoable snippet over
 * the text they span, the name a placeholder in every place. Typing then renames them all at once.
 */
function applyNamed(editor: Editor, edits: { start: number; end: number; text: string }[], name: string) {
  const model = editor.getModel()!;
  const text = model.getValue();
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  const [from, to] = [edits[0].start, Math.max(...edits.map((e) => e.end))];
  let template = "";
  let at = from;
  for (const e of edits) {
    template += snippetText(text.slice(at, e.start)) + snippetText(e.text).replace(/\0/g, `\${1:${name}}`);
    at = e.end;
  }
  template += snippetText(text.slice(at, to));
  editor.setSelection(rangeOf(model, { start: from, end: to }));
  editor.focus();
  snippets(editor).insert(template, { adjustWhitespace: false, undoStopBefore: true, undoStopAfter: true });
  namingKey(editor).set(true);
}

// ---- Shared ----

const symbolsOf = async (model: monaco.editor.ITextModel) =>
  (await phpactorRequest<L.DocumentSymbol[] | null>("textDocument/documentSymbol", { textDocument: { uri: model.uri.toString() } }).catch(() => null)) ?? [];

/** The selected expression, or one chosen among those around the caret. A status explains when there's none. */
export async function chosenExpression(editor: Editor, what: string): Promise<Expr | null> {
  const model = editor.getModel()!;
  const text = model.getValue();
  const sel = editor.getSelection()!;
  if (!sel.isEmpty()) {
    const expr = expressionIn(text, model.getOffsetAt(sel.getStartPosition()), model.getOffsetAt(sel.getEndPosition()));
    if (!expr) host.status(`Select a whole expression to ${what}, such as $a + $b or $user->name.`);
    return expr;
  }
  const list = expressionsAt(text, model.getOffsetAt(sel.getPosition()));
  if (!list.length) return host.status(`Put the cursor in an expression to ${what}.`), null;
  if (list.length === 1) return list[0];
  return ask(editor, "Expressions", list.map((e) => ({ label: oneLine(e.text), value: e, highlight: [e] })));
}

/** Every occurrence, or only `expr`, as chosen when there are several. Null for Escape. */
export async function chosenUses(editor: Editor, expr: Expr, all: Expr[]): Promise<Expr[] | null> {
  if (all.length < 2) return [expr];
  return ask(editor, `${all.length} occurrences of ${oneLine(expr.text)}`, [
    { label: `Replace all ${all.length} occurrences`, value: all, highlight: all },
    { label: "Replace this occurrence only", value: [expr], highlight: [expr] },
  ]);
}

const phpEditor = (editor: Editor, what: string) => {
  const model = editor.getModel();
  if (model?.getLanguageId() === "php" && !editor.getOption(monaco.editor.EditorOption.readOnly)) return model;
  host.status(`${what} works in PHP files.`);
  return null;
};

// ---- Extract Variable ----

export async function extractVariable(editor: Editor) {
  const model = phpEditor(editor, "Extract Variable");
  if (!model) return;
  const version = model.getVersionId();
  const expr = await chosenExpression(editor, "extract it into a variable");
  if (!expr) return;
  const text = model.getValue();
  const [from, to] = functionScope(text, expr.start);
  const uses = await chosenUses(editor, expr, occurrences(text, expr, from, to));
  if (!uses || model.getVersionId() !== version) return;
  const point = declarationPoint(text, uses);
  if ("error" in point) return host.status(`Can't extract ${oneLine(expr.text)}: ${point.error}.`);
  const taken = new Set([...text.slice(from, to).matchAll(/\$(\w+)/g)].map((m) => m[1]));
  const name = variableName(expr.text, taken);
  const edits = point.replace
    ? [{ start: point.replace.start, end: point.replace.end, text: `$\0 = ${expr.text}` }]
    : [{ start: point.offset, end: point.offset, text: `$\0 = ${expr.text};\n${point.indent}` }, ...uses.map((u) => ({ ...u, text: "$\0" }))];
  applyNamed(editor, edits, name);
  host.status("Type the variable's name, then press ⏎.");
}

// ---- Extract Constant ----

export async function extractConstant(editor: Editor) {
  const model = phpEditor(editor, "Extract Constant");
  if (!model) return;
  const version = model.getVersionId();
  const text = model.getValue();
  const sel = editor.getSelection()!;
  const expr = constantAt(text, model.getOffsetAt(sel.getStartPosition()), model.getOffsetAt(sel.getEndPosition()));
  if (!expr) return host.status("Put the cursor on a string or number, or select an expression of literals, to extract a constant.");
  const type = parseTypeDeclarations(text).filter((t) => t.offset <= expr.start).at(-1);
  const open = type ? text.indexOf("{", type.offset) : -1;
  const close = open >= 0 ? matchBracket(text, open) : -1;
  if (!type || close < expr.end) return host.status("Extract Constant works inside a class, trait, interface, or enum.");
  // Constants read the same anywhere in the class, closures included.
  const uses = await chosenUses(editor, expr, occurrences(text, expr, open, close, false));
  if (!uses || model.getVersionId() !== version) return;
  const point = constantPoint(text, open);
  const { insertSpaces, indentSize } = model.getOptions();
  const lineStart = text.lastIndexOf("\n", type.offset) + 1;
  const indent = text.slice(lineStart).match(/^[ \t]*/)![0] + (insertSpaces ? " ".repeat(indentSize) : "\t");
  const next = text.slice(point.offset).split("\n")[0].trim();
  const visibility = type.kind === "interface" ? "public" : "private";
  const declaration = `${point.gapBefore ? "\n" : ""}${indent}${visibility} const \0 = ${expr.text};\n${point.gap && next && next !== "}" ? "\n" : ""}`;
  const taken = new Set([...text.slice(open, close).matchAll(/\bconst\s+(?:[\w\\|?]+\s+)?(\w+)\s*=/g)].map((m) => m[1]));
  applyNamed(editor, [{ start: point.offset, end: point.offset, text: declaration }, ...uses.map((u) => ({ ...u, text: "self::\0" }))], constantName(expr.text, taken));
  host.status("Type the constant's name, then press ⏎.");
}

// ---- Introduce Field ----

/**
 * Introduce Field (⌥⌘F): puts an expression in a new private property. A constant expression becomes the
 * property's default; anything else is assigned before its first use in the method, as PhpStorm's
 * "initialize in current method". The property's type comes from a literal or `new`, when the text tells it.
 */
export async function introduceField(editor: Editor) {
  const model = phpEditor(editor, "Introduce Field");
  if (!model) return;
  const version = model.getVersionId();
  const expr = await chosenExpression(editor, "put it in a field");
  if (!expr) return;
  const text = model.getValue();
  const type = parseTypeDeclarations(text).filter((t) => t.offset <= expr.start).at(-1);
  const open = type ? text.indexOf("{", type.offset) : -1;
  const close = open >= 0 ? matchBracket(text, open) : -1;
  const [from, to] = functionScope(text, expr.start);
  if (!type || close < expr.end || from === 0) return host.status("Introduce Field works in a method of a class or trait.");
  if (type.kind === "interface" || type.kind === "enum") return host.status(`An ${type.kind} can't have properties.`);
  // The method's header, before its body's `{`.
  const isStatic = /\bstatic\s+(?:(?:public|protected|private|final|abstract)\s+)*function\b[^{;]*$|\b(?:public|protected|private)\s+static\s+function\b[^{;]*$/.test(text.slice(0, from - 1));
  const uses = await chosenUses(editor, expr, occurrences(text, expr, from, to));
  if (!uses || model.getVersionId() !== version) return;
  const ref = isStatic ? "self::$\0" : "$this->\0";
  const constant = !!constantAt(text, expr.start, expr.end);
  const edits = uses.map((u) => ({ ...u, text: ref }));
  if (!constant) {
    const point = declarationPoint(text, uses);
    if ("error" in point) return host.status(`Can't introduce a field for ${oneLine(expr.text)}: ${point.error}.`);
    if (point.replace) edits.splice(0, edits.length, { start: point.replace.start, end: point.replace.end, text: `${ref} = ${expr.text}` });
    else edits.push({ start: point.offset, end: point.offset, text: `${ref} = ${expr.text};\n${point.indent}` });
  }
  // The property goes after the class's other properties, or else after its constants and trait uses.
  const { insertSpaces, indentSize } = model.getOptions();
  const indent = text.slice(text.lastIndexOf("\n", type.offset) + 1).match(/^[ \t]*/)![0] + (insertSpaces ? " ".repeat(indentSize) : "\t");
  const props = classProperties(text.slice(open + 1, close)).filter((p) => !p.promoted);
  const kind = literalType(expr.text);
  let declaration = `${indent}private ${isStatic ? "static " : ""}${kind ? `${kind} ` : ""}$\0${constant ? ` = ${expr.text}` : ""};\n`;
  let at: number;
  if (props.length) at = text.indexOf("\n", open + 1 + Math.max(...props.map((p) => p.end))) + 1;
  else {
    const point = constantPoint(text, open);
    at = point.offset;
    const next = text.slice(at).split("\n")[0].trim();
    declaration = `${point.gapBefore || !point.gap ? "\n" : ""}${declaration}${next && next !== "}" ? "\n" : ""}`;
  }
  const taken = new Set(classProperties(text.slice(open + 1, close)).map((p) => p.name));
  applyNamed(editor, [{ start: at, end: at, text: declaration }, ...edits], variableName(expr.text, taken));
  host.status("Type the field's name, then press ⏎.");
}

// ---- Extract Method ----

export async function extractMethod(editor: Editor) {
  const model = phpEditor(editor, "Extract Method");
  if (!model) return;
  const sel = editor.getSelection()!;
  let range: monaco.IRange = sel;
  if (sel.isEmpty()) {
    const expr = await chosenExpression(editor, "extract it into a method");
    if (!expr) return;
    range = rangeOf(model, expr);
  }
  const before = model.getValue();
  const actions =
    (await phpactorRequest<(L.CodeAction | L.Command)[] | null>("textDocument/codeAction", {
      textDocument: { uri: model.uri.toString() },
      range: { start: { line: range.startLineNumber - 1, character: range.startColumn - 1 }, end: { line: range.endLineNumber - 1, character: range.endColumn - 1 } },
      context: { diagnostics: [], only: ["refactor.extract.method"] },
    }).catch(() => null)) ?? [];
  const action = actions.find((a) => "kind" in a && a.kind === "refactor.extract.method") as L.CodeAction | undefined;
  if (!action?.command) return host.status("Select whole statements or an expression to extract a method. Phpactor must be running.");
  // Phpactor sends its edit back as workspace/applyEdit, which applyWorkspaceEdit applies before the command returns.
  await phpactorRequest("workspace/executeCommand", { command: action.command.command, arguments: action.command.arguments });
  const after = model.getValue();
  if (after === before) return host.status("Phpactor couldn't extract a method from this selection.");
  const had = new Set([...before.matchAll(/\bfunction\s+&?(\w+)\s*\(/g)].map((m) => m[1]));
  const name = [...after.matchAll(/\bfunction\s+&?(\w+)\s*\(/g)].map((m) => m[1]).find((n) => !had.has(n));
  if (!name) return;
  // The call and the declaration Phpactor wrote, renamed together.
  const places = [...after.matchAll(new RegExp(`(?:->|::|\\bfunction\\s+&?)(${name})\\s*\\(`, "dg"))].map((m) => ({ start: m.indices![1]![0], end: m.indices![1]![1], text: "\0" }));
  applyNamed(editor, places, name);
  host.status("Type the method's name, then press ⏎.");
}

// ---- Refactor This ----

/**
 * The refactorings that apply at the caret or selection, by action name, and Phpactor's other refactoring
 * actions there, for Refactor This (⌃T).
 */
export async function refactorings(editor: Editor): Promise<{ names: string[]; more: Item[] }> {
  const model = editor.getModel();
  if (!model) return { names: [], more: [] };
  const names = ["Rename"];
  if (model.getLanguageId() !== "php") return { names, more: [] };
  const text = model.getValue();
  const sel = editor.getSelection()!;
  const [start, end] = [model.getOffsetAt(sel.getStartPosition()), model.getOffsetAt(sel.getEndPosition())];
  const pos = sel.getPosition();
  const found = symbolAt(await symbolsOf(model), pos.lineNumber - 1, pos.column - 1);
  const expression = sel.isEmpty() ? expressionsAt(text, start).length > 0 : !!expressionIn(text, start, end);
  if (found && [6, 12].includes(found.symbol.kind)) names.push("Change Signature…");
  if (expression) names.push("Extract Variable…");
  if (constantAt(text, start, end)) names.push("Extract Constant…");
  if (expression || !sel.isEmpty()) names.push("Extract Method…");
  if (expression && found?.container) names.push("Introduce Field…");
  if (expression && found && [6, 12].includes(found.symbol.kind)) names.push("Introduce Parameter…");
  const line = model.getLineContent(pos.lineNumber);
  const onVariable = [...line.matchAll(/\$(\w+)/g)].some((m) => pos.column >= m.index! + 1 && pos.column <= m.index! + m[0].length + 1 && m[1] !== "this");
  const word = model.getWordAtPosition(pos);
  const before = word ? line.slice(0, word.startColumn - 1) : "";
  const onConstant = !!word && (/::\s*$/.test(before) || /\bconst\s+(?:[\w\\|?]+\s+)?$/.test(before));
  const onCall = !!word && /^\s*\(/.test(line.slice(word.endColumn - 1)) && !/(\$|\bnew\s+)$/.test(before);
  if (onVariable || onConstant || onCall) names.push("Inline…");
  if (found) names.push("Safe Delete…");
  if (parseTypeDeclarations(text).length === 1) names.push("Move Class…");
  // Phpactor's own refactorings, other than the extractions above.
  const actions =
    (await phpactorRequest<(L.CodeAction | L.Command)[] | null>("textDocument/codeAction", {
      textDocument: { uri: model.uri.toString() },
      range: { start: { line: sel.startLineNumber - 1, character: sel.startColumn - 1 }, end: { line: sel.endLineNumber - 1, character: sel.endColumn - 1 } },
      context: { diagnostics: [] },
    }).catch(() => null)) ?? [];
  const more = actions
    .filter((a): a is L.CodeAction => "kind" in a && !!a.kind?.startsWith("refactor") && !/^refactor\.extract\.(method|expression|constant)/.test(a.kind))
    .map((a) => ({
      label: a.title,
      run: async () => {
        if (a.edit) await applyWorkspaceEdit(a.edit);
        if (a.command) await phpactorRequest("workspace/executeCommand", { command: a.command.command, arguments: a.command.arguments });
      },
    }));
  return { names, more };
}

export function initExtract(h: Host) {
  host = h;
}
