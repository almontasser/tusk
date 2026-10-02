// Inline, Change Signature, Introduce Parameter, and Move Class. Inline is Tusk's server's (this is its UI), and so is
// Introduce Parameter's edit when only the new parameter changes; Change Signature is written here, and refuses, with a
// reason, when the code does something it can't rewrite safely.
import { invoke } from "@tauri-apps/api/core";
import type * as L from "vscode-languageserver-protocol";
import { monaco } from "./editor";
import { applyWorkspaceEdit, tuskRequest } from "./lsp";
import { constructorCalls, inlinedValue, parseTypeDeclarations, shortenNames, type TypeDeclaration } from "./phptypes";
import { declarationParts, formatArgs, formatParams, matchBracket, rewriteArgs, splitTopLevel, type Param, type Signature } from "./refactorparse";
import { showRefactorPreview, type Skipped } from "./refactorpreview";
import { ask, chosenAll, chosenTarget, errorText, extraction, interactive, refuse, type Target } from "./extract";
import { move } from "./files";
import { pick, rank, type Item } from "./palette";
import { namespaceFor, pathsFor, psr4From } from "./psr4";
import { editSignature } from "./signaturedialog";
import { symbolAt } from "./safedelete";
import { readText } from "./projectfiles";

type Host = { root(): string; status(text: string): void; ensureModel(path: string): Promise<monaco.editor.ITextModel> };
let host: Host;

const symbolsOf = async (model: monaco.editor.ITextModel) =>
  (await tuskRequest<L.DocumentSymbol[] | null>("textDocument/documentSymbol", { textDocument: { uri: model.uri.toString() } })) ?? [];

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
  if (!target) return refuse(editor, "Tusk's PHP server isn't running yet. Try again once it has started.");
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
  if (!result) return refuse(editor, "Tusk's PHP server isn't running yet. Try again once it has started.");
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
 * they were, the preview lists them with why, and the edit applies from there.
 */
async function applyServerEdit(result: ServerEdit, title: string) {
  const changes = changesOf(result.edit);
  const files = Object.keys(changes).length;
  const apply = () => applyWorkspaceEdit(result.edit).then(() => host.status(`${result.message}${files > 1 ? " ⌘Z undoes it in every file." : ""}`));
  if (!result.skipped.length) return apply();
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

function offsetAt(text: string, p: L.Position): number {
  let offset = 0;
  for (let i = 0; i < p.line; i++) offset = text.indexOf("\n", offset) + 1;
  return offset + p.character;
}

export const textOf = async (path: string) => monaco.editor.getModel(monaco.Uri.file(path))?.getValue() ?? readText(path);

/**
 * Opens the Change Signature dialog for the method or function at the cursor, then rewrites its declaration, its
 * overrides in classes that extend or implement its class, and every call Tusk's server finds.
 */
/** An expression in the source, as offsets. `text` is the source between them. */
type Expr = { start: number; end: number; text: string };
/** Introduce Parameter's expression: the server's target, whether all its occurrences go, and its suggestion. */
type Introduced = { target: Target; all: boolean; expr: Expr; uses: Expr[]; name: string; type: string; constant: boolean };

export async function changeSignature(editor: monaco.editor.ICodeEditor, introduce?: Introduced) {
  const model = editor.getModel();
  const pos = introduce ? editor.getModel()?.getPositionAt(introduce.expr.start) : editor.getPosition();
  if (!model || !pos || model.getLanguageId() !== "php") return host.status("Change Signature works in PHP files.");
  const found = symbolAt(await symbolsOf(model), pos.lineNumber - 1, pos.column - 1);
  if (!found || ![6, 12].includes(found.symbol.kind)) return host.status("Put the cursor in a method or function to change its signature.");
  const { symbol, container } = found;
  const text = model.getValue();
  const version = model.getVersionId();
  const parts = declarationParts(text, offsetAt(text, symbol.selectionRange.end));
  if (!parts) return host.status(`Can't read the declaration of ${symbol.name}.`);
  const kind = isConstructor(symbol) ? "constructor" : symbol.kind === 6 ? "method" : "function";
  const title = container ? `${container.name}::${symbol.name}` : symbol.name;
  const params = [...parts.params];
  let focus: number | undefined;
  if (introduce) {
    // Introduce Parameter: a new last parameter holding the expression, as its default when it's a constant, or
    // else as the value passed in existing calls.
    // The server names it apart from the function's variables, and types it.
    const { expr, name, type, constant } = introduce;
    const at = params.findIndex((p) => p.variadic);
    focus = at < 0 ? params.length : at;
    params.splice(focus, 0, { text: "", type, name, byRef: false, variadic: false, defaultValue: constant ? expr.text : undefined, callValue: constant ? undefined : expr.text });
  }
  const chosen = await editSignature({ title, kind, heading: introduce ? "Introduce Parameter" : "Change Signature", focus, signature: { modifiers: parts.modifiers, name: parts.name, returnType: parts.returnType, params } });
  editor.focus();
  if (!chosen) return;
  if (model.getVersionId() !== version) return host.status("The file changed while the dialog was open. Run Change Signature again.");
  // The expression's uses become the new parameter, if it's still there.
  const added = introduce && chosen.signature.params.find((p) => !p.from && (p.callValue === introduce.expr.text || p.defaultValue === introduce.expr.text));
  // Only the new parameter changed: Tusk's server writes it, its calls, and overriding methods.
  if (introduce && added && !chosen.preview && onlyAdded(parts, chosen.signature, added)) {
    let result: ServerEdit | null;
    try {
      result = await tuskRequest<ServerEdit>("tusk/introduceParameter", {
        textDocument: { uri: model.uri.toString() },
        range: introduce.target.range,
        all: introduce.all,
        name: added.name,
        type: added.type,
        default: added.defaultValue,
        value: added.callValue === introduce.expr.text ? undefined : added.callValue,
        position: chosen.signature.params.indexOf(added),
      });
    } catch (e) {
      return refuse(editor, errorText(e));
    }
    if (result) return applyServerEdit(result, `Introduce Parameter in ${title}`);
  }
  await plan(model, symbol, container, title, chosen.signature, chosen.preview, added ? introduce!.uses.map((u) => ({ ...u, text: `$${added.name}` })) : []);
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

type Override = { path: string; fqn: string; line: number; nameEnd: number; text: string };

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

/** The method's declarations in every project class that extends or implements its class. */
async function overridesOf(model: monaco.editor.ITextModel, container: L.DocumentSymbol, method: string): Promise<Override[]> {
  const overrides: Override[] = [];
  for (const { path, text, type, body } of await descendantsOf(fqnOf(model, container))) {
    const m = body.match(new RegExp(`\\bfunction\\s+&?${method}\\b`));
    if (!m) continue;
    const nameEnd = type.offset + m.index! + m[0].length;
    overrides.push({ path, fqn: type.fqn, line: positionAt(text, nameEnd).line, nameEnd, text });
  }
  return overrides;
}

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

/**
 * The same change for an override, which may name its parameters differently: parameters match by position,
 * and keep the override's own name, type, and default unless the change set new ones. Parameters only the
 * override has stay, after the others.
 */
function forOverride(before: Param[], after: Param[], own: Param[]): Param[] {
  const mapped = after.map((p) => {
    const i = before.findIndex((b) => b.name === p.from);
    const mine = own[i];
    if (!p.from || !mine) return p;
    const old = before[i];
    return {
      ...p,
      from: mine.name,
      name: p.name === old.name ? mine.name : p.name,
      type: p.type === old.type ? mine.type : p.type,
      defaultValue: p.defaultValue === old.defaultValue ? mine.defaultValue : p.defaultValue,
    };
  });
  return [...mapped, ...own.slice(before.length).map((p) => ({ ...p, from: p.name }))];
}

/** Renames parameters in a declaration's docblock and body, outside its header [headerStart, headerEnd). */
function renameParams(text: string, headerStart: number, headerEnd: number, params: Param[]): { start: number; end: number; text: string }[] {
  const renames = params.filter((p) => p.from && p.from !== p.name);
  if (!renames.length) return [];
  const doc = text.slice(0, headerStart).match(/\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*(?:#\[[^\]]*\]\s*)*$/);
  const brace = text.slice(headerEnd).match(/^\s*\{/);
  const bodyEnd = brace ? matchBracket(text, headerEnd + brace[0].length - 1) : headerEnd;
  const edits: { start: number; end: number; text: string }[] = [];
  for (const [from, to] of [[doc ? headerStart - doc[0].length : headerStart, headerStart], [headerEnd, Math.max(headerEnd, bodyEnd)]])
    for (const p of renames)
      for (const m of text.slice(from, to).matchAll(new RegExp(`\\$${p.from}\\b`, "g"))) edits.push({ start: from + m.index!, end: from + m.index! + m[0].length, text: `$${p.name}` });
  return edits;
}

type Raw = { start: number; end: number; text: string };
/** A call to rewrite: its name and argument list's offsets, and the parameters of the method it calls. */
type Site = { path: string; line: number; nameStart: number; nameEnd: number; argsOpen: number; argsClose: number; before: Param[]; after: Param[]; owner: { fqn: string; text: string } | null };

/** Applies edits (offsets into `text` from `base`) to a slice of it, from the last one back. */
const applyRaw = (text: string, base: number, edits: Raw[]) =>
  [...edits].sort((a, b) => b.start - a.start).reduce((t, e) => t.slice(0, e.start - base) + e.text + t.slice(e.end - base), text);

/** Whether a signature only adds `added` to the declaration's, leaving the rest as it was. */
function onlyAdded(was: { modifiers: string; name: string; returnType: string; params: Param[] }, now: Signature, added: Param): boolean {
  const rest = now.params.filter((p) => p !== added);
  return (
    now.name === was.name &&
    now.modifiers === was.modifiers &&
    now.returnType === was.returnType &&
    rest.length === was.params.length &&
    rest.every((p, i) => {
      const q = was.params[i];
      return p.from === q.name && p.name === q.name && p.type === q.type && p.defaultValue === q.defaultValue && p.byRef === q.byRef && p.variadic === q.variadic;
    })
  );
}

async function plan(model: monaco.editor.ITextModel, symbol: L.DocumentSymbol, container: L.DocumentSymbol | undefined, title: string, s: Signature, preview: boolean, bodyEdits: Raw[] = []) {
  host.status(`Looking for calls to ${symbol.name}…`);
  const texts = new Map<string, string>();
  const raw = new Map<string, Raw[]>();
  const edit = (uri: string, text: string, start: number, end: number, newText: string) => {
    texts.set(uri, text);
    raw.set(uri, [...(raw.get(uri) ?? []), { start, end, text: newText }]);
  };
  /**
   * Rewrites a declaration's header and its parameters' uses. An override keeps its own modifiers, and its own
   * return type unless the change gave the method a new one.
   */
  const declare = (uri: string, text: string, nameEnd: number, params: Param[], own?: { returnTypeWas: string }) => {
    const parts = declarationParts(text, nameEnd);
    if (!parts) return null;
    const mods = own ? parts.modifiers : s.modifiers;
    const returnType = own && parts.returnType !== own.returnTypeWas ? parts.returnType : s.returnType;
    const header = `${mods ? `${mods} ` : ""}function ${parts.byRef ? "&" : ""}${s.name}(${formatParams(params, parts.indent, parts.headerIndent)})${returnType ? `: ${returnType}` : ""}`;
    edit(uri, text, parts.start, parts.end, header);
    for (const r of renameParams(text, parts.start, parts.end, params)) edit(uri, text, r.start, r.end, r.text);
    return parts;
  };

  const uri = model.uri.toString();
  const text = model.getValue();
  const base = declare(uri, text, offsetAt(text, symbol.selectionRange.end), s.params)!;
  for (const e of bodyEdits) edit(uri, text, e.start, e.end, e.text);
  // A subclass's constructor has its own parameters, and calls the parent's through parent::__construct().
  const overrides = symbol.kind === 6 && container && !isConstructor(symbol) ? await overridesOf(model, container, symbol.name) : [];
  // Each group of calls is rewritten against the parameters of the method it calls.
  const baseOwner = container ? { fqn: fqnOf(model, container), text } : null;
  const groups: { refs: L.Location[]; before: Param[]; after: Param[]; owner: Site["owner"] }[] = [{ refs: await callsOf(model, symbol, container), before: base.params, after: s.params, owner: baseOwner }];
  for (const o of overrides) {
    const own = declarationParts(o.text, o.nameEnd)?.params ?? [];
    const after = forOverride(base.params, s.params, own);
    declare(monaco.Uri.file(o.path).toString(), o.text, o.nameEnd, after, { returnTypeWas: base.returnType });
    const refs = (await tuskRequest<L.Location[]>("tusk/memberReferences", { class: o.fqn, method: symbol.name })) ?? [];
    groups.push({ refs, before: own, after, owner: { fqn: o.fqn, text: o.text } });
  }
  const skipped: Skipped[] = [];
  const sites = new Map<string, Site[]>();
  const seen = new Set<string>();
  for (const { refs, before, after, owner } of groups)
    for (const ref of refs) {
      // A call through a subclass can turn up for both the method and its override.
      const id = `${ref.uri}:${ref.range.start.line}:${ref.range.start.character}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const path = monaco.Uri.parse(ref.uri).fsPath;
      const text = texts.get(ref.uri) ?? (await textOf(path).catch(() => null));
      if (text === null) continue;
      texts.set(ref.uri, text);
      const line = ref.range.start.line + 1;
      const nameStart = offsetAt(text, ref.range.start);
      // Declarations, such as an override's, have their own edit.
      if (/\bfunction\s+&?$/.test(text.slice(text.lastIndexOf("\n", nameStart - 1) + 1, nameStart))) continue;
      // The call's parentheses follow the name; a reference without them (a callable string) can't change.
      const nameEnd = offsetAt(text, ref.range.end);
      const paren = text.slice(nameEnd).match(/^\s*\(/);
      if (!paren) {
        skipped.push({ path, line, reason: "not a call, such as a callable string" });
        continue;
      }
      const argsOpen = nameEnd + paren[0].length - 1;
      const argsClose = matchBracket(text, argsOpen);
      if (argsClose < 0) {
        skipped.push({ path, line, reason: "its arguments couldn't be read" });
        continue;
      }
      sites.set(ref.uri, [...(sites.get(ref.uri) ?? []), { path, line, nameStart, nameEnd, argsOpen, argsClose, before, after, owner }]);
    }

  // Calls are rewritten innermost first, and each takes in the edits inside its arguments, such as a nested call
  // or a renamed parameter, so no two edits overlap.
  const renamed = s.name !== base.name && !isConstructor(symbol);
  let calls = 0;
  for (const [siteUri, list] of sites) {
    const text = texts.get(siteUri)!;
    const types = parseTypeDeclarations(text);
    for (const site of list.sort((a, b) => b.argsOpen - a.argsOpen)) {
      const edits = raw.get(siteUri) ?? [];
      const inside = edits.filter((e) => e.start > site.argsOpen && e.end <= site.argsClose);
      const original = text.slice(site.argsOpen + 1, site.argsClose);
      const inner = applyRaw(original, site.argsOpen + 1, inside);
      // A default written into a call must mean the same there: self:: and imported names are spelled out.
      const here = [...types].reverse().find((t) => t.offset < site.nameStart)?.fqn;
      const spell = (value: string | undefined) => (value && site.owner ? shortenNames(inlinedValue(value, site.owner.text, site.owner.fqn, here === site.owner.fqn), text) : value);
      const after = site.after.map((p) => ({ ...p, defaultValue: spell(p.defaultValue), callValue: spell(p.callValue) }));
      const result = rewriteArgs(splitTopLevel(inner), site.before, after);
      if ("error" in result) {
        skipped.push({ path: site.path, line: site.line, reason: result.error });
        continue;
      }
      if (result.args.join("\0") !== splitTopLevel(original).join("\0")) {
        const lineIndent = text.slice(text.lastIndexOf("\n", site.argsOpen) + 1).match(/^[ \t]*/)![0];
        const args = formatArgs(result.args, inner, lineIndent);
        raw.set(siteUri, [...edits.filter((e) => !inside.includes(e)), { start: site.argsOpen + 1, end: site.argsClose, text: args }]);
      }
      if (renamed) edit(siteUri, text, site.nameStart, site.nameEnd, s.name);
      calls++;
    }
  }
  const changes: Record<string, L.TextEdit[]> = {};
  for (const [u, edits] of raw) {
    const t = texts.get(u)!;
    changes[u] = edits.map((e) => ({ range: { start: positionAt(t, e.start), end: positionAt(t, e.end) }, newText: e.text }));
  }
  host.status("");
  const files = Object.keys(changes).length;
  const apply = () =>
    applyWorkspaceEdit({ changes }).then(() =>
      host.status(`Changed ${title} and ${calls} ${calls === 1 ? "call" : "calls"} in ${files} ${files === 1 ? "file" : "files"}.${files > 1 ? " ⌘Z undoes it in all of them." : ""}`),
    );
  // Calls it can't rewrite are worth a look before applying, as PhpStorm shows its conflicts first.
  if (preview || skipped.length) showRefactorPreview(`Change Signature of ${title}`, changes, texts, skipped, apply);
  else await apply();
}

// ---- Introduce parameter ----

/**
 * Introduce Parameter (⌥⌘P): turns an expression in a method into a new parameter, through the Change Signature
 * dialog, so the name and position can be set there. Calls pass the expression, which must not use the method's
 * variables, since they don't exist at the call. Tusk's server checks that, names and types the parameter, and,
 * when only the new parameter changes in the dialog, writes the edit (`tusk/introduceParameter`).
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
  const expr = (r: L.Range): Expr => {
    const [start, end] = [model.getOffsetAt({ lineNumber: r.start.line + 1, column: r.start.character + 1 }), model.getOffsetAt({ lineNumber: r.end.line + 1, column: r.end.character + 1 })];
    return { start, end, text: model.getValue().slice(start, end) };
  };
  const uses = (all ? target.occurrences : [target.range]).map(expr);
  await changeSignature(editor, { target, all, expr: expr(target.range), uses, name: x.name, type: x.type ?? "", constant: x.constant });
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
