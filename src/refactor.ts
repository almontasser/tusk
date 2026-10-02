// Inline, Change Signature, Introduce Parameter, and Move Class. Tusk's server reads the code and writes the edits for
// the first three (`tusk/inline`, `tusk/changeSignature`); this is their UI.
import { invoke } from "@tauri-apps/api/core";
import type * as L from "vscode-languageserver-protocol";
import { monaco } from "./editor";
import { applyWorkspaceEdit, tuskRequest } from "./lsp";
import { constructorCalls, parseTypeDeclarations, type TypeDeclaration } from "./phptypes";
import type { Signature } from "./refactorparse";
import { showRefactorPreview, type Skipped } from "./refactorpreview";
import { ask, chosenAll, chosenTarget, errorText, extraction, interactive, refuse, type Target } from "./extract";
import { move } from "./files";
import { pick, rank, type Item } from "./palette";
import { namespaceFor, pathsFor, psr4From } from "./psr4";
import { editSignature } from "./signaturedialog";
import { readText } from "./projectfiles";

type Host = { root(): string; status(text: string): void; ensureModel(path: string): Promise<monaco.editor.ITextModel> };
let host: Host;

const NOT_RUNNING = "Tusk's PHP server isn't running yet. Try again once it has started.";

// ---- Inline ----

/** What `tusk/inlineTarget` says the caret is on, and the choices to offer. */
type InlineTarget = {
  kind: "variable" | "constant" | "method";
  title: string;
  /** Each choice, what it changes, and what it alone would run differently, such as a call that would run twice. */
  choices: { mode: "all" | "keep" | "this"; label: string; detail: string | null; warning: string | null; highlight: L.Range[] }[];
  /** What would run differently whichever choice, such as a call that would run later. */
  warnings: string[];
};
/** A server refactoring's edit, the places it left as they were, and a message for the status bar. */
type ServerEdit = { edit: L.WorkspaceEdit; skipped: { uri: string; line: number; reason: string }[]; message: string };

/**
 * Inline (⌥⌘N), as in PhpStorm: the variable, constant, or method or function call at the caret. Tusk's server
 * reads the code and writes the edit (`tusk/inlineTarget`, `tusk/inline`). This asks which uses to inline, with
 * what each choice changes highlighted and anything that would run differently shown with it, then applies the
 * edit as one undo step, showing first the places the server had to leave.
 */
export async function inline(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos || model.getLanguageId() !== "php" || editor.getOption(monaco.editor.EditorOption.readOnly)) return host.status("Inline works in PHP files.");
  const version = model.getVersionId();
  const at = { textDocument: { uri: model.uri.toString() }, position: { line: pos.lineNumber - 1, character: pos.column - 1 } };
  let target: InlineTarget | null;
  try {
    target = await tuskRequest<InlineTarget>("tusk/inlineTarget", at);
  } catch (e) {
    return refuse(editor, errorText(e));
  }
  if (!target) return refuse(editor, NOT_RUNNING);
  const warningFor = (c: InlineTarget["choices"][number]) => [...target.warnings, c.warning].filter(Boolean).join(" ") || undefined;
  // One choice with nothing to warn about needs no question.
  const mode =
    target.choices.length === 1 && !warningFor(target.choices[0])
      ? target.choices[0].mode
      : await ask(editor, target.title, target.choices.map((c) => ({ label: c.label, detail: c.detail ?? undefined, warning: warningFor(c), value: c.mode, highlight: c.highlight })), true);
  if (!mode) return;
  if (model.getVersionId() !== version) return host.status("The file changed while choosing. Run Inline again.");
  if (target.kind !== "variable") host.status(`${target.title.replace(/ = .*/, "")}: looking for uses…`);
  let result: ServerEdit | null;
  try {
    result = await tuskRequest<ServerEdit>("tusk/inline", { ...at, mode });
  } catch (e) {
    host.status("");
    return refuse(editor, errorText(e));
  }
  if (!result) return refuse(editor, NOT_RUNNING);
  await applyServerEdit(result, target.title.replace(/ = .*/, ""));
}

/** The edit's changes by file, as the refactoring preview lists them. */
function changesOf(edit: L.WorkspaceEdit): Record<string, L.TextEdit[]> {
  const changes: Record<string, L.TextEdit[]> = { ...(edit.changes ?? {}) };
  for (const op of edit.documentChanges ?? []) if (!("kind" in op)) changes[op.textDocument.uri] = op.edits.filter((e): e is L.TextEdit => "range" in e);
  return changes;
}

/**
 * Applies a server refactoring's edit, as one undo step in every file it changes. When the server left places as
 * they were, or `preview` asks, the preview lists the changes and those places with why, and the edit applies from
 * there.
 */
async function applyServerEdit(result: ServerEdit, title: string, preview = false) {
  const changes = changesOf(result.edit);
  const files = Object.keys(changes).length;
  const apply = () => applyWorkspaceEdit(result.edit).then(() => host.status(`${result.message}${files > 1 ? " ⌘Z undoes it in every file." : ""}`));
  if (!result.skipped.length && !preview) return apply();
  const texts = new Map<string, string>();
  for (const uri of new Set([...Object.keys(changes), ...result.skipped.map((s) => s.uri)])) texts.set(uri, await textOf(monaco.Uri.parse(uri).fsPath).catch(() => ""));
  const skipped: Skipped[] = result.skipped.map((s) => ({ path: monaco.Uri.parse(s.uri).fsPath, line: s.line, reason: s.reason }));
  host.status("");
  showRefactorPreview(title, changes, texts, skipped, apply);
}

// ---- Change signature ----

/** A position in text, 0-based as LSP counts it. Columns are UTF-16 units, as JavaScript indexes strings. */
function positionAt(text: string, offset: number): L.Position {
  const before = text.slice(0, offset);
  const line = before.split("\n").length - 1;
  return { line, character: offset - (before.lastIndexOf("\n") + 1) };
}

export const textOf = async (path: string) => monaco.editor.getModel(monaco.Uri.file(path))?.getValue() ?? readText(path);

/** An expression in the source, as offsets. `text` is the source between them. */
type Expr = { start: number; end: number; text: string };
/** Introduce Parameter's expression: the server's target, whether all its occurrences go, and its suggestion. */
type Introduced = { target: Target; all: boolean; expr: Expr; name: string; type: string; constant: boolean };
/** The declaration at the caret, as `tusk/signature` reads it for the dialog. */
type Declared = { kind: "method" | "function" | "constructor"; title: string; signature: Signature };

/**
 * Change Signature (⌘F6): opens the dialog for the method or function at the cursor, then has Tusk's server rewrite
 * its declaration, the methods that override it, and every call (`tusk/signature`, `tusk/changeSignature`). Calls it
 * can't rewrite, and other places to look at, show in the preview first.
 */
export async function changeSignature(editor: monaco.editor.ICodeEditor, introduce?: Introduced) {
  const model = editor.getModel();
  const pos = introduce ? model?.getPositionAt(introduce.expr.start) : editor.getPosition();
  if (!model || !pos || model.getLanguageId() !== "php") return host.status("Change Signature works in PHP files.");
  const at = { textDocument: { uri: model.uri.toString() }, position: { line: pos.lineNumber - 1, character: pos.column - 1 } };
  const version = model.getVersionId();
  let declared: Declared | null;
  try {
    declared = await tuskRequest<Declared>("tusk/signature", at);
  } catch (e) {
    return refuse(editor, errorText(e));
  }
  if (!declared) return refuse(editor, NOT_RUNNING);
  const { kind, title, signature } = declared;
  const params = [...signature.params];
  let focus: number | undefined;
  if (introduce) {
    // Introduce Parameter: a new parameter holding the expression, before a variadic one, as its default when it's a
    // constant, or else as the value passed in existing calls. The server names it apart from the function's
    // variables, and types it.
    const { expr, name, type, constant } = introduce;
    const variadic = params.findIndex((p) => p.variadic);
    focus = variadic < 0 ? params.length : variadic;
    params.splice(focus, 0, { text: "", type, name, byRef: false, variadic: false, defaultValue: constant ? expr.text : undefined, callValue: constant ? undefined : expr.text });
  }
  const heading = introduce ? "Introduce Parameter" : "Change Signature";
  const chosen = await editSignature({ title, kind, heading, focus, signature: { ...signature, params } });
  editor.focus();
  if (!chosen) return;
  if (model.getVersionId() !== version) return host.status(`The file changed while the dialog was open. Run ${heading} again.`);
  // The expression's uses become the new parameter, if it's still there.
  const added = introduce && chosen.signature.params.find((p) => !p.from && (p.callValue === introduce.expr.text || p.defaultValue === introduce.expr.text));
  host.status(`Looking for calls to ${title}…`);
  let result: ServerEdit | null;
  try {
    result = await tuskRequest<ServerEdit>("tusk/changeSignature", {
      ...at,
      signature: chosen.signature,
      introduce: added ? { range: introduce.target.range, all: introduce.all, name: added.name } : undefined,
    });
  } catch (e) {
    host.status("");
    return refuse(editor, errorText(e));
  }
  if (!result) return refuse(editor, NOT_RUNNING);
  await applyServerEdit(result, `${heading} of ${title}`, chosen.preview);
}

/**
 * Calls of a method or function, from Tusk's server, without the declaration. Methods are found through
 * subclasses too (`tusk/memberReferences`). Constructors, called through `new`, come from a text search.
 */
export async function callsOf(model: monaco.editor.ITextModel, symbol: L.DocumentSymbol, container?: L.DocumentSymbol): Promise<L.Location[]> {
  if (isConstructor(symbol) && container) return constructorCallsOf(model, container);
  if (symbol.kind === 6 && container) {
    const calls = await tuskRequest<L.Location[]>("tusk/memberReferences", { class: fqnOf(model, container), method: symbol.name }).catch(() => null);
    if (calls) return calls;
  }
  return (
    (await tuskRequest<L.Location[] | null>("textDocument/references", {
      textDocument: { uri: model.uri.toString() },
      position: symbol.selectionRange.start,
      context: { includeDeclaration: false },
    })) ?? []
  );
}

type Match = { path: string };
type Descendant = { path: string; text: string; type: TypeDeclaration; body: string };

/**
 * Every project type that extends or implements `fqn`, directly or further down, parents before their children.
 * A text search finds them rather than Go to Implementation, which answers from the index and can miss
 * classes the index hasn't seen yet. The search looks for the short name alone, so an `extends` or `implements`
 * list broken over several lines is found, and the file's declarations decide.
 */
export async function descendantsOf(fqn: string): Promise<Descendant[]> {
  const queue = [fqn];
  const seen = new Set(queue);
  const found: Descendant[] = [];
  for (let parent = queue.shift(); parent; parent = queue.shift()) {
    const query = { text: parent.split("\\").pop()!, regex: false, caseSensitive: true, wholeWord: true };
    const matches = await invoke<Match[]>("search_text", { root: host.root(), query, include: "*.php" });
    for (const path of new Set(matches.map((m) => m.path))) {
      const text = await textOf(path).catch(() => null);
      if (text === null) continue;
      const types = parseTypeDeclarations(text);
      types.forEach((type, i) => {
        if (seen.has(type.fqn) || ![...type.extends, ...type.implements].includes(parent)) return;
        seen.add(type.fqn);
        queue.push(type.fqn);
        // The type's text runs to the file's next type.
        found.push({ path, text, type, body: text.slice(type.offset, types[i + 1]?.offset ?? text.length) });
      });
    }
  }
  return found;
}

const fqnOf = (model: monaco.editor.ITextModel, container: L.DocumentSymbol) => {
  const namespace = model.getValue().match(/^\s*namespace\s+([\w\\]+)\s*;/m)?.[1];
  return namespace ? `${namespace}\\${container.name}` : container.name;
};

const isConstructor = (symbol: L.DocumentSymbol) => symbol.kind === 6 && symbol.name.toLowerCase() === "__construct";

/**
 * Calls of a class's constructor: `new` of the class or of a subclass that inherits the constructor, `new self`
 * and `new static` inside them, and `parent::__construct(` in their direct subclasses. Each range is the name
 * before the "(".
 */
async function constructorCallsOf(model: monaco.editor.ITextModel, container: L.DocumentSymbol): Promise<L.Location[]> {
  const fqn = fqnOf(model, container);
  const descendants = await descendantsOf(fqn);
  const classes = new Set([fqn]);
  for (const d of descendants)
    if (classes.has(d.type.extends[0] ?? "") && !/\bfunction\s+&?__construct\s*\(/i.test(d.body)) classes.add(d.type.fqn);
  const alternatives = [...classes].map((c) => c.split("\\").pop()).join("|");
  const query = { text: `\\bnew\\s+\\\\?([\\w\\\\]*\\\\)?(${alternatives})\\s*\\(`, regex: true, caseSensitive: false, wholeWord: false };
  const matches = await invoke<Match[]>("search_text", { root: host.root(), query, include: "*.php" });
  const paths = new Set([model.uri.fsPath, ...descendants.map((d) => d.path), ...matches.map((m) => m.path)]);
  const locations: L.Location[] = [];
  for (const path of paths) {
    const text = await textOf(path).catch(() => null);
    if (text === null) continue;
    for (const [start, end] of constructorCalls(text, classes))
      locations.push({ uri: monaco.Uri.file(path).toString(), range: { start: positionAt(text, start), end: positionAt(text, end) } });
  }
  return locations;
}

// ---- Introduce parameter ----

/**
 * Introduce Parameter (⌥⌘P): turns an expression in a method into a new parameter, through the Change Signature
 * dialog, so the name and position can be set there. Calls pass the expression, which must not use the method's
 * variables, since they don't exist at the call. Tusk's server checks that, names and types the parameter, and
 * writes the edit with the rest of the dialog's changes.
 */
export async function introduceParameter(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  if (!model || model.getLanguageId() !== "php") return host.status("Introduce Parameter works in PHP files.");
  const version = model.getVersionId();
  const target = await chosenTarget(editor, "parameter");
  if (!target) return;
  const all = await chosenAll(editor, target);
  if (all === null) return;
  const x = await extraction(editor, "parameter", target, all);
  if (!x || model.getVersionId() !== version) return;
  const [start, end] = [target.range.start, target.range.end].map((p) => model.getOffsetAt({ lineNumber: p.line + 1, column: p.character + 1 }));
  await changeSignature(editor, { target, all, expr: { start, end, text: model.getValue().slice(start, end) }, name: x.name, type: x.type ?? "", constant: x.constant });
}

// ---- Move class ----

/**
 * Moves the class in the current file to another namespace (F6, as in PhpStorm): into the folder composer.json's
 * PSR-4 map gives that namespace. The file move then has Tusk's server update the namespace and every reference.
 */
export async function moveClass(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  if (!model || model.getLanguageId() !== "php") return host.status("Move Class works in PHP files.");
  const types = parseTypeDeclarations(model.getValue());
  if (types.length !== 1) return host.status(types.length ? `Move Class moves a file with one class; this one declares ${types.length}.` : "This file declares no class to move.");
  const [type] = types;
  const short = type.fqn.split("\\").pop()!;
  const current = type.fqn.slice(0, -short.length - 1);
  const psr4 = psr4From((await readText(`${host.root()}/composer.json`).catch(() => "")) || "{}");
  if (!Object.keys(psr4).length) return host.status("Move Class needs a PSR-4 autoload map in composer.json.");
  // Every namespace that has a folder, from the project's PHP files.
  const files = await invoke<string[]>("list_files", { root: host.root() }).catch(() => [] as string[]);
  const namespaces = [...new Set(files.filter((f) => f.endsWith(".php")).map((f) => namespaceFor(f.replace(/^\//, ""), psr4)).filter((n): n is string => !!n))].sort();
  const target = (ns: string) => pathsFor(ns ? `${ns}\\${short}` : short, psr4)[0];
  const moveTo = (ns: string) => {
    const rel = target(ns);
    if (!rel) return host.status(`No PSR-4 folder in composer.json holds the namespace ${ns}.`);
    const to = `${host.root()}/${rel}`;
    if (to === model.uri.fsPath) return;
    return move(model.uri.fsPath, to);
  };
  const item = (ns: string, isNew = false): Item => ({ label: ns || "(global namespace)", detail: isNew ? `New: ${target(ns) ?? "no PSR-4 folder"}` : target(ns), icon: "codicon-symbol-namespace", run: () => moveTo(ns) });
  pick(
    `Move ${short} to namespace`,
    (q) => {
      const typed = q.trim().replace(/^\\+|\\+$/g, "");
      const valid = /^[A-Za-z_]\w*(\\[A-Za-z_]\w*)*$/.test(typed);
      const existing = rank(typed, namespaces.filter((n) => n !== current).map((n) => item(n)));
      return valid && typed !== current && !namespaces.includes(typed) ? [item(typed, true), ...existing] : existing;
    },
    0,
    { value: current, select: [0, current.length], title: `Move ${short} to namespace` },
  );
}

export function initRefactor(h: Host) {
  host = h;
  interactive["refactor.inline"] = inline;
  interactive["refactor.extract.parameter"] = introduceParameter;
}
