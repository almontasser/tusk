// Inline Variable and Change Signature, refactorings written here rather than in the language server. Both refuse, with a
// reason, when the code does something they can't rewrite safely.
import { invoke } from "@tauri-apps/api/core";
import type * as L from "vscode-languageserver-protocol";
import { monaco } from "./editor";
import { applyWorkspaceEdit, tuskRequest, typeSymbol } from "./lsp";
import { constructorCalls, deletionLines, nameResolver, outsideStrings, parseTypeDeclarations, shortenNames, type TypeDeclaration } from "./phptypes";
import { declarationParts, formatArgs, formatParams, matchBracket, planInline, rewriteArgs, splitTopLevel, type Param, type Signature } from "./refactorparse";
import { showRefactorPreview, type Skipped } from "./refactorpreview";
import { constantAt, constantDeclaration, constantRefs, declarationPoint, enclosingFunctionName, expressionsAt, functionScope, inlineCall, reindentCode, inlinedValue, literalType, methodToInline, occurrences, variableName, type Expr, type Inlinable } from "./extractparse";
import { chosenExpression, chosenUses, pickAtCaret } from "./extract";
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

// ---- Inline variable ----

// ---- Inline ----

/** Inline (⌥⌘N), as in PhpStorm: the method or function called or declared at the cursor, the class constant, or else the variable. */
export async function inline(editor: monaco.editor.ICodeEditor) {
  if (!(await inlineMethod(editor)) && !(await inlineConstant(editor))) await inlineVariable(editor);
}

/** Asks in a popup at the caret; null for Escape. */
const choose = (editor: monaco.editor.ICodeEditor, question: string, options: string[]) =>
  new Promise<string | null>((resolve) => pickAtCaret(editor, question, options.map((label) => ({ label, run: () => resolve(label) })), () => resolve(null)));

/**
 * Class names in code moved from the owner's file written in full, so its imports don't matter elsewhere:
 * `X::`, `new X`, `instanceof X`, and `catch (X`. `self::` and `static::` name the owner outside it.
 */
function qualifyNames(code: string, ownerSource: string, owner: string | null, insideOwner: boolean): string {
  const { resolve } = nameResolver(ownerSource);
  const functions = new Map([...ownerSource.matchAll(/^use\s+function\s+([\w\\]+?)(?:\s+as\s+(\w+))?\s*;/gm)].map((m) => [(m[2] ?? m[1].split("\\").pop()!).toLowerCase(), `\\${m[1]}`]));
  return outsideStrings(code, (c) =>
    c
      .replace(/(?<![\\\w$>:])([A-Za-z_][\w\\]*)(?=\s*::)/g, (n) => {
        const lower = n.toLowerCase();
        if (lower === "self" || lower === "static") return insideOwner || !owner ? n : `\\${owner}`;
        return lower === "parent" ? n : `\\${resolve(n)}`;
      })
      .replace(/\b(new|instanceof|catch\s*\()\s+(?![\\$]|class\b|static\b|self\b)([A-Za-z_][\w\\]*)/g, (_, kw: string, n: string) => `${kw} \\${resolve(n)}`)
      // Types in a closure's parameters and return type; PHP's own types are lowercase.
      .replace(/(?<=[(,]\s*\??)(?<![\\\w$])([A-Z][\w\\]*)(?=\s+&?(?:\.\.\.)?\$)/g, (n) => `\\${resolve(n)}`)
      .replace(/(\)\s*:\s*\??)([A-Z][\w\\]*)/g, (_, pre: string, n: string) => `${pre}\\${resolve(n)}`)
      // Functions imported with `use function`.
      .replace(/(?<![\\\w$>:])([a-z_]\w*)(?=\s*\()/gi, (n) => functions.get(n.toLowerCase()) ?? n),
  );
}

/**
 * Inline Method: replaces calls of the method or function at the cursor with its body. From its declaration,
 * every call, then the method goes unless you keep it; from a call, that call or all of them. False when the
 * cursor isn't on a method or function name followed by `(`.
 */
async function inlineMethod(editor: monaco.editor.ICodeEditor): Promise<boolean> {
  const model = editor.getModel();
  const pos = editor.getPosition();
  const word = model && pos ? model.getWordAtPosition(pos) : null;
  if (!model || !pos || !word || model.getLanguageId() !== "php") return false;
  const text = model.getValue();
  const wordStart = model.getOffsetAt({ lineNumber: pos.lineNumber, column: word.startColumn });
  const wordEnd = wordStart + word.word.length;
  if (!/^\s*\(/.test(text.slice(wordEnd)) || /\$$/.test(text.slice(0, wordStart))) return false;
  // The declaration: here, or where Go to Definition leads from a call.
  let def = model;
  let at: L.Position = { line: pos.lineNumber - 1, character: pos.column - 1 };
  const onDeclaration = /\bfunction\s+&?$/.test(text.slice(0, wordStart));
  if (!onDeclaration) {
    if (/\bnew\s+$/.test(text.slice(0, wordStart))) return false;
    const found = await tuskRequest<L.Location[] | L.Location | null>("textDocument/definition", { textDocument: { uri: model.uri.toString() }, position: at }).catch(() => null);
    const loc = Array.isArray(found) ? found[0] : found;
    if (!loc) return host.status(`Can't find the declaration of ${word.word}. Tusk's PHP server must be running.`), true;
    if (!loc.uri.startsWith("file:") || loc.uri.includes(".phar") || loc.uri.includes("/vendor/")) return host.status(`${word.word} is declared in a library, which can't be inlined.`), true;
    def = await host.ensureModel(monaco.Uri.parse(loc.uri).fsPath);
    at = loc.range.start;
  }
  const found = symbolAt(await symbolsOf(def), at.line, at.character);
  if (!found || ![6, 12].includes(found.symbol.kind) || found.symbol.name !== word.word) return false;
  const { symbol, container } = found;
  const label = container ? `${container.name}::${symbol.name}()` : `${symbol.name}()`;
  if (isConstructor(symbol)) return host.status("A constructor can't be inlined."), true;
  const defText = def.getValue();
  const method = methodToInline(defText, offsetAt(defText, symbol.selectionRange.end));
  if ("error" in method) return host.status(`Can't inline ${label}: ${method.error}.`), true;
  const owner = container ? fqnOf(def, container) : null;
  if (container && (await overridesOf(def, container, symbol.name)).length) return host.status(`Can't inline ${label}: a subclass overrides it, so a call may run the override.`), true;

  host.status(`Looking for calls to ${label}…`);
  const refs = (await callsOf(def, symbol, container)).filter(
    (r) => !(r.uri === def.uri.toString() && r.range.start.line >= symbol.range.start.line && r.range.start.line <= symbol.range.end.line),
  );
  const recursive = (await callsOf(def, symbol, container)).length !== refs.length;
  host.status("");
  const here = onDeclaration ? null : refs.find((r) => r.uri === model.uri.toString() && offsetAt(text, r.range.start) === wordStart);
  if (!refs.length) return host.status(`Nothing calls ${label}.`), true;
  const calls = refs.length === 1 ? "the only call" : `all ${refs.length} calls`;
  const all = `Inline ${calls} and remove the ${container ? "method" : "function"}`;
  const keep = `Inline ${calls} and keep it`;
  const options = here && refs.length > 1 ? [all, keep, "Inline this call only"] : [all, keep];
  const answer = await choose(editor, `Inline ${label}`, recursive ? options.filter((o) => o !== all) : options);
  editor.focus();
  if (!answer) return true;
  const chosen = answer === "Inline this call only" ? [here!] : refs;

  const texts = new Map<string, string>();
  const raw = new Map<string, { start: number; end: number; text: string }[]>();
  const skipped: Skipped[] = [];
  let inlined = 0;
  for (const ref of chosen) {
    const path = monaco.Uri.parse(ref.uri).fsPath;
    const source = texts.get(ref.uri) ?? (await textOf(path).catch(() => null));
    if (source === null) continue;
    texts.set(ref.uri, source);
    const line = ref.range.start.line + 1;
    const skip = (reason: string) => skipped.push({ path, line, reason });
    const result = inlineAt(source, offsetAt(source, ref.range.start), symbol.name, method, defText, owner);
    if ("error" in result) {
      skip(result.error);
      continue;
    }
    const edits = raw.get(ref.uri) ?? [];
    if (result.edits.some((e) => edits.some((o) => e.start < o.end && o.start < e.end))) {
      skip("it's inside another call being inlined");
      continue;
    }
    raw.set(ref.uri, [...edits, ...result.edits]);
    inlined++;
  }
  // The declaration goes once every call is inlined, with its docblock.
  if (answer === all && !skipped.length) {
    const lines = defText.split("\n");
    const [first, last] = deletionLines(lines, symbol.range.start.line + 1, symbol.range.end.line + 1);
    const start = offsetAt(defText, { line: first - 1, character: 0 });
    const end = last < lines.length ? offsetAt(defText, { line: last, character: 0 }) : defText.length;
    texts.set(def.uri.toString(), defText);
    raw.set(def.uri.toString(), [...(raw.get(def.uri.toString()) ?? []), { start, end, text: "" }]);
  }
  const changes: Record<string, L.TextEdit[]> = {};
  for (const [u, edits] of raw) changes[u] = edits.map((e) => ({ range: { start: positionAt(texts.get(u)!, e.start), end: positionAt(texts.get(u)!, e.end) }, newText: e.text }));
  const apply = () =>
    applyWorkspaceEdit({ changes }).then(() =>
      host.status(`Inlined ${label} in ${inlined} ${inlined === 1 ? "place" : "places"}${answer === all && !skipped.length ? " and removed it" : ""}.${Object.keys(changes).length > 1 ? " ⌘Z undoes it in every file." : ""}`),
    );
  if (skipped.length) showRefactorPreview(`Inline ${label}`, changes, texts, skipped, apply);
  else await apply();
  return true;
}

/** The edits that inline one call, whose name starts at `nameStart`, or why it can't be. */
function inlineAt(source: string, nameStart: number, name: string, method: Inlinable, ownerSource: string, owner: string | null): { edits: { start: number; end: number; text: string }[] } | { error: string } {
  const nameEnd = nameStart + name.length;
  const paren = source.slice(nameEnd).match(/^\s*\(/);
  if (!paren) return { error: "not a call, such as a callable string" };
  const argsOpen = nameEnd + paren[0].length - 1;
  const argsClose = matchBracket(source, argsOpen);
  if (argsClose < 0) return { error: "its arguments couldn't be read" };
  const inner = source.slice(argsOpen + 1, argsClose);
  if (inner.trim() === "...") return { error: "a first-class callable" };
  const call = expressionsAt(source, nameStart).find((e) => e.end === argsClose + 1 && e.start <= nameStart);
  if (!call) return { error: "the call couldn't be read" };
  const through = source.slice(call.start, nameStart).trim();
  if (through.endsWith("?->")) return { error: "a nullsafe call (?->)" };
  const receiver = through.endsWith("->") ? through.slice(0, -2).trim() : null;
  const types = parseTypeDeclarations(source);
  const inside = owner !== null && [...types].reverse().find((t) => t.offset < nameStart)?.fqn === owner;
  const code = `${method.statements}${method.result ?? ""}`;
  if (owner && !inside) {
    // Outside its class, the body may only reach members that are public there.
    if (/\bparent\s*::/.test(code)) return { error: "the method calls parent::, which means another class here" };
    const hidden = [...code.matchAll(/(?:\$this\s*->\s*|\b(?:self|static)\s*::\s*\$?)(\w+)(\s*\()?/g)].find(
      ([, member, call]) => !new RegExp(call ? `\\bpublic\\s+(?:static\\s+)?function\\s+&?${member}\\b` : `\\bpublic\\s+(?:static\\s+|readonly\\s+)*(?:[?\\w\\\\|]+\\s+)?(?:\\$${member}\\b|const\\s+(?:\\w+\\s+)?${member}\\b)|(?:^|[;{}])\\s*const\\s+${member}\\b`).test(ownerSource),
    );
    if (hidden) return { error: `the method uses ${hidden[1]}, which isn't public outside its class` };
  }
  const qualify = (code: string) => (inside || !owner && source === ownerSource ? code : shortenNames(qualifyNames(code, ownerSource, owner, inside), source));
  const m: Inlinable = {
    ...method,
    statements: qualify(method.statements),
    result: method.result === null ? null : qualify(method.result),
    params: method.params.map((p) => (p.defaultValue ? { ...p, defaultValue: qualify(p.defaultValue) } : p)),
  };
  const [from, to] = functionScope(source, nameStart);
  const taken = new Set([...source.slice(from, to).matchAll(/\$(\w+)/g)].map((x) => x[1]));
  const r = inlineCall(m, splitTopLevel(inner), receiver, taken);
  if ("error" in r) return r;
  const point = declarationPoint(source, [call]);
  if ("error" in point) return point;
  const body = reindentCode(r.body, point.indent);
  const intro = [...r.statements.map((l) => point.indent + l), ...body];
  const pure = (e: string) => /^(\$\w+|-?\d[\d_.]*|'[^']*'|true|false|null)$/i.test(e.trim());
  if (point.replace) {
    // The call is a statement of its own: the body takes its place.
    const semicolon = source.indexOf(";", call.end);
    const tail = r.result && !pure(r.result) ? [`${point.indent}${r.result};`] : [];
    const code = [...intro, ...tail].join("\n").slice(point.indent.length);
    return { edits: [{ start: call.start, end: semicolon + 1, text: code || "" }] };
  }
  if (r.result === null) return { error: "it returns nothing, but the call's value is used" };
  const value = /^[\w$\\]+(\s*(->|::)\s*\$?\w+(\([^()]*\))?)*$|^\w+\([^()]*\)$/.test(r.result.trim()) ? r.result : `(${r.result})`;
  if (!intro.length) return { edits: [{ start: call.start, end: call.end, text: value }] };
  // Statements run before the statement holding the call, which is safe only where nothing else runs first.
  const lead = source.slice(point.offset, call.start);
  const follows = source.slice(call.end).match(/^\s*;/);
  if (!follows || !/^(\$\w+(\s*->\s*\w+|\[[^\]]*\])*\s*=|return|echo|yield|throw)?\s*$/.test(lead)) return { error: "the method has statements, which can't run in the middle of this expression" };
  return {
    edits: [
      { start: point.offset, end: point.offset, text: `${intro.join("\n").slice(point.indent.length)}\n${point.indent}` },
      { start: call.start, end: call.end, text: value },
    ],
  };
}

/**
 * Replaces a class constant with its value, at every use in the project and removing its declaration, or at
 * the use under the cursor only. False when the cursor isn't on a constant.
 */
async function inlineConstant(editor: monaco.editor.ICodeEditor): Promise<boolean> {
  const model = editor.getModel();
  const pos = editor.getPosition();
  const name = model && pos ? model.getWordAtPosition(pos)?.word : undefined;
  if (!model || !pos || !name || model.getLanguageId() !== "php") return false;
  const text = model.getValue();
  const offset = model.getOffsetAt(pos);
  const types = parseTypeDeclarations(text);
  const bodyOf = (source: string, t: TypeDeclaration) => source.indexOf("{", t.offset);
  // On a use (X::NAME) or on the declaration itself.
  const here = constantRefs(text, name).find((r) => r.start <= offset && offset <= r.end);
  const around = [...types].reverse().find((t) => t.offset < offset);
  const declaredHere = around && constantDeclaration(text, name, bodyOf(text, around));
  const onDeclaration = !here && declaredHere && !("error" in declaredHere) && declaredHere.start <= offset && offset <= declaredHere.end;
  if (!here && !onDeclaration) return false;
  const owner = here ? here.owner : around!.fqn;
  const ownerPath = types.some((t) => t.fqn === owner) ? model.uri.fsPath : (await typeSymbol(owner))?.path;
  const ownerText = ownerPath ? await textOf(ownerPath).catch(() => null) : null;
  const ownerType = ownerText ? parseTypeDeclarations(ownerText).find((t) => t.fqn === owner) : undefined;
  const decl = ownerText && ownerType ? constantDeclaration(ownerText, name, bodyOf(ownerText, ownerType)) : null;
  if (!decl) return host.status(`Can't find the declaration of ${owner.split("\\").pop()}::${name} in the project.`), true;
  if ("error" in decl) return host.status(`Can't inline ${name}: ${decl.error}.`), true;

  host.status(`Looking for uses of ${name}…`);
  // Subclasses that don't declare their own reach it as self::, static::, or by their own name.
  const heirs = new Set([owner, ...(await descendantsOf(owner)).filter((d) => !constantDeclaration(d.text, name, bodyOf(d.text, d.type))).map((d) => d.type.fqn)]);
  const matches = await invoke<Match[]>("search_text", { root: host.root(), query: { text: `::\\s*${name}\\b`, regex: true, caseSensitive: true, wholeWord: false }, include: "*.php" });
  const uses: { path: string; text: string; start: number; end: number }[] = [];
  for (const path of new Set([model.uri.fsPath, ...matches.map((m) => m.path)])) {
    const source = await textOf(path).catch(() => null);
    if (source !== null) for (const r of constantRefs(source, name)) if (heirs.has(r.owner)) uses.push({ path, text: source, start: r.start, end: r.end });
  }
  host.status("");
  const label = `${owner.split("\\").pop()}::${name}`;
  let chosen = uses;
  if (here && uses.length > 1) {
    const all = `Inline all ${uses.length} uses and remove ${label}`;
    const answer = await choose(editor, `Inline ${label} = ${decl.value}`, [all, "Inline this use only"]);
    editor.focus();
    if (!answer) return true;
    if (answer !== all) chosen = uses.filter((u) => u.path === model.uri.fsPath && u.start === here.start);
  }
  const changes: Record<string, L.TextEdit[]> = {};
  const edit = (path: string, source: string, start: number, end: number, newText: string) =>
    (changes[monaco.Uri.file(path).toString()] ??= []).push({ range: { start: positionAt(source, start), end: positionAt(source, end) }, newText });
  for (const u of chosen) {
    const inside = [...parseTypeDeclarations(u.text)].reverse().find((t) => t.offset < u.start)?.fqn === owner;
    edit(u.path, u.text, u.start, u.end, shortenNames(inlinedValue(decl.value, ownerText!, owner, inside), u.text));
  }
  // The declaration goes too once nothing uses it, with its docblock and a blank line.
  if (chosen.length === uses.length) {
    const lines = ownerText!.split("\n");
    const [first, last] = deletionLines(lines, positionAt(ownerText!, decl.start).line + 1, positionAt(ownerText!, decl.end).line + 1);
    edit(ownerPath!, ownerText!, offsetAt(ownerText!, { line: first - 1, character: 0 }), last < lines.length ? offsetAt(ownerText!, { line: last, character: 0 }) : ownerText!.length, "");
  }
  await applyWorkspaceEdit({ changes });
  const files = Object.keys(changes).length;
  host.status(`Inlined ${label} in ${chosen.length} ${chosen.length === 1 ? "place" : "places"}${chosen.length === uses.length ? " and removed it" : ""}.${files > 1 ? " ⌘Z undoes it in every file." : ""}`);
  return true;
}

/** Replaces the variable at the cursor with its value everywhere in its function, and removes the assignment. */
export async function inlineVariable(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos || model.getLanguageId() !== "php") return host.status("Inline Variable works in PHP files.");
  const line = model.getLineContent(pos.lineNumber);
  const name = [...line.matchAll(/\$(\w+)/g)].find((m) => pos.column >= m.index! + 1 && pos.column <= m.index! + m[0].length + 1)?.[1];
  if (!name || name === "this") return host.status("Put the cursor on a variable to inline it.");
  // The enclosing function, method, or closure, or the whole file for top-level code.
  const [start, end] = functionScope(model.getValue(), model.getOffsetAt(pos));
  const [from, to] = [model.getPositionAt(start).lineNumber, model.getPositionAt(end).lineNumber];
  const plan = planInline(model.getLinesContent(), name, from, to);
  if ("error" in plan) return host.status(`Can't inline $${name}: ${plan.error}.`);
  const edits: monaco.editor.IIdentifiedSingleEditOperation[] = plan.uses.map((u) => ({
    range: new monaco.Range(u.line, u.column, u.line, u.column + name.length + 1),
    text: plan.value,
  }));
  const [a, z] = [plan.assignment, plan.assignmentEnd];
  edits.push({ range: z < model.getLineCount() ? new monaco.Range(a, 1, z + 1, 1) : new monaco.Range(a, 1, z, model.getLineMaxColumn(z)), text: "" });
  model.pushEditOperations(editor.getSelections(), edits, () => null);
  host.status(`Inlined $${name} in ${plan.uses.length} ${plan.uses.length === 1 ? "place" : "places"}. Undo with ⌘Z.`);
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
export async function changeSignature(editor: monaco.editor.ICodeEditor, introduce?: { expr: Expr; uses: Expr[] }) {
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
    const { expr } = introduce;
    const constant = !!constantAt(text, expr.start, expr.end);
    // The body's variables too, so the parameter doesn't take a local's name.
    const [from, to] = functionScope(text, expr.start);
    const taken = new Set([...params.map((p) => p.name), ...[...text.slice(from, to).matchAll(/\$(\w+)/g)].map((m) => m[1])]);
    const at = params.findIndex((p) => p.variadic);
    focus = at < 0 ? params.length : at;
    params.splice(focus, 0, { text: "", type: literalType(expr.text), name: variableName(expr.text, taken), byRef: false, variadic: false, defaultValue: constant ? expr.text : undefined, callValue: constant ? undefined : expr.text });
  }
  const chosen = await editSignature({ title, kind, heading: introduce ? "Introduce Parameter" : "Change Signature", focus, signature: { modifiers: parts.modifiers, name: parts.name, returnType: parts.returnType, params } });
  editor.focus();
  if (!chosen) return;
  if (model.getVersionId() !== version) return host.status("The file changed while the dialog was open. Run Change Signature again.");
  // The expression's uses become the new parameter, if it's still there.
  const added = introduce && chosen.signature.params.find((p) => !p.from && (p.callValue === introduce.expr.text || p.defaultValue === introduce.expr.text));
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
 * variables, since they don't exist at the call.
 */
export async function introduceParameter(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  if (!model || model.getLanguageId() !== "php") return host.status("Introduce Parameter works in PHP files.");
  const expr = await chosenExpression(editor, "make it a parameter");
  if (!expr) return;
  const text = model.getValue();
  const [from, to] = functionScope(text, expr.start);
  if (from === 0) return host.status("Introduce Parameter works inside a method or function.");
  // In a closure, the parameter would belong to the method around it, which the closure can't see.
  if (!enclosingFunctionName(text, expr.start)) return host.status("Introduce Parameter works in a method or function's own body, not in a closure.");
  if (/\$(?!this\b)\w/.test(expr.text.replace(/'(?:[^'\\]|\\.)*'/g, ""))) return host.status("The expression uses the method's variables, which calls can't pass. Extract a variable instead (⌥⌘V).");
  if (/\$this\b/.test(expr.text)) return host.status("The expression uses $this, which calls outside the class can't pass.");
  const uses = await chosenUses(editor, expr, occurrences(text, expr, from, to));
  if (uses) await changeSignature(editor, { expr, uses });
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
}
