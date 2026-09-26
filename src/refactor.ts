// Inline Variable and Change Signature, two refactorings Phpactor doesn't provide. Both refuse, with a
// reason, when the code does something they can't rewrite safely.
import { invoke } from "@tauri-apps/api/core";
import type * as L from "vscode-languageserver-protocol";
import { monaco } from "./editor";
import { applyWorkspaceEdit, PHPACTOR_INDEX, phpactorRequest, toolPath } from "./lsp";
import { pick } from "./palette";
import { constructorCalls, parseTypeDeclarations, type TypeDeclaration } from "./phptypes";
import { matchBracket, parseParams, planInline, rewriteArgs, splitTopLevel } from "./refactorparse";
import { symbolAt } from "./safedelete";
import { readText } from "./projectfiles";

type Host = { root(): string; status(text: string): void };
let host: Host;

const symbolsOf = async (model: monaco.editor.ITextModel) =>
  (await phpactorRequest<L.DocumentSymbol[] | null>("textDocument/documentSymbol", { textDocument: { uri: model.uri.toString() } })) ?? [];

// ---- Inline variable ----

/** Replaces the variable at the cursor with its value everywhere in its function, and removes the assignment. */
export async function inlineVariable(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos || model.getLanguageId() !== "php") return host.status("Inline Variable works in PHP files.");
  const line = model.getLineContent(pos.lineNumber);
  const name = [...line.matchAll(/\$(\w+)/g)].find((m) => pos.column >= m.index! + 1 && pos.column <= m.index! + m[0].length + 1)?.[1];
  if (!name || name === "this") return host.status("Put the cursor on a variable to inline it.");
  // The enclosing method or function, or the whole file for top-level code.
  const found = symbolAt(await symbolsOf(model), pos.lineNumber - 1, pos.column - 1);
  const inFunction = found && [6, 12].includes(found.symbol.kind);
  const [from, to] = inFunction ? [found.symbol.range.start.line + 1, found.symbol.range.end.line + 1] : [1, model.getLineCount()];
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

const textOf = async (path: string) => monaco.editor.getModel(monaco.Uri.file(path))?.getValue() ?? readText(path);

/**
 * Edits a method's or function's parameters and rewrites every call Phpactor finds. A method's overrides in
 * classes that extend or implement its class change with it, and so do their calls.
 */
export async function changeSignature(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos || model.getLanguageId() !== "php") return host.status("Change Signature works in PHP files.");
  const found = symbolAt(await symbolsOf(model), pos.lineNumber - 1, pos.column - 1);
  if (!found || ![6, 12].includes(found.symbol.kind)) return host.status("Put the cursor in a method or function to change its signature.");
  const { symbol, container } = found;
  const text = model.getValue();
  const open = text.indexOf("(", offsetAt(text, symbol.selectionRange.end));
  const close = open >= 0 ? matchBracket(text, open) : -1;
  if (close < 0) return host.status("Can't find the parameter list.");
  const current = text.slice(open + 1, close).replace(/\s*\n\s*/g, " ").trim();
  pick(
    `Parameters of ${symbol.name}: reorder, remove, or add (a new parameter needs a default value)`,
    (q) => [{ label: `Change to ${symbol.name}(${q.trim()})`, run: () => plan(model, symbol, container, open, close, current, q.trim()) }],
    0,
    { value: current },
  );
}

type Member = { references: { line_no: number; col_no: number }[]; file: string };

/**
 * Calls of a method, from Phpactor's command line: it scans the project's files, where the language
 * server's reference search relies on its index and can miss files it hasn't indexed yet. Functions
 * aren't covered by the command, so they use the language server. Constructors, called through `new`,
 * come from a text search.
 */
export async function callsOf(model: monaco.editor.ITextModel, symbol: L.DocumentSymbol, container?: L.DocumentSymbol): Promise<L.Location[]> {
  if (isConstructor(symbol) && container) return constructorCallsOf(model, container);
  if (symbol.kind === 6 && container) {
    const calls = await memberCalls(fqnOf(model, container), symbol.name, { path: model.uri.fsPath, line: symbol.selectionRange.start.line });
    if (calls) return calls;
  }
  return (
    (await phpactorRequest<L.Location[] | null>("textDocument/references", {
      textDocument: { uri: model.uri.toString() },
      position: symbol.selectionRange.start,
      context: { includeDeclaration: false },
    })) ?? []
  );
}

/** References to a class's method from Phpactor's command line, without the declaration (0-based line), or null if it fails. */
async function memberCalls(fqn: string, method: string, declaration: { path: string; line: number }): Promise<L.Location[] | null> {
  const phar = await toolPath("phpactor/phpactor.phar");
  const args = [phar, "references:member", fqn, method, "--format=json", `--config-extra=${JSON.stringify(PHPACTOR_INDEX)}`];
  const out = await invoke<string>("run_capture", { cwd: host.root(), program: "php", args, input: null }).catch(() => "");
  try {
    const files: Member[] = JSON.parse(out.slice(out.indexOf("{"))).references;
    return files.flatMap((f) =>
      f.references
        .filter((r) => !(f.file === declaration.path && r.line_no - 1 === declaration.line))
        .map((r) => ({
          uri: monaco.Uri.file(f.file).toString(),
          range: { start: { line: r.line_no - 1, character: r.col_no }, end: { line: r.line_no - 1, character: r.col_no + method.length } },
        })),
    );
  } catch {
    return null;
  }
}

type Override = { path: string; fqn: string; line: number; open: number; close: number; text: string };

type Match = { path: string };
type Descendant = { path: string; text: string; type: TypeDeclaration; body: string };

/**
 * Every project type that extends or implements `fqn`, directly or further down, parents before their children.
 * A text search finds them rather than Phpactor's Go to Implementation, which answers from its index and misses
 * classes the index hasn't seen yet. The search looks for the short name alone, so an `extends` or `implements`
 * list broken over several lines is found, and the file's declarations decide.
 */
async function descendantsOf(fqn: string): Promise<Descendant[]> {
  const queue = [fqn];
  const seen = new Set(queue);
  const found: Descendant[] = [];
  for (let parent = queue.shift(); parent; parent = queue.shift()) {
    const query = { text: parent.split("\\").pop()!, regex: false, caseSensitive: true, wholeWord: true };
    const matches = await invoke<Match[]>("search_text", { root: host.root(), query, include: "*.php" }).catch(() => []);
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
    const m = body.match(new RegExp(`\\bfunction\\s+&?${method}\\s*\\(`));
    if (!m) continue;
    const open = type.offset + m.index! + m[0].length - 1;
    const close = matchBracket(text, open);
    if (close >= 0) overrides.push({ path, fqn: type.fqn, line: positionAt(text, open).line, open, close, text });
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
  const matches = await invoke<Match[]>("search_text", { root: host.root(), query, include: "*.php" }).catch(() => []);
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

async function plan(model: monaco.editor.ITextModel, symbol: L.DocumentSymbol, container: L.DocumentSymbol | undefined, open: number, close: number, oldText: string, newText: string) {
  const oldParams = parseParams(oldText);
  const newParams = parseParams(newText);
  const names = newParams.map((p) => p.name);
  if (names.some((n) => !n)) return host.status("Each parameter needs a $name.");
  if (new Set(names).size !== names.length) return host.status("Two parameters have the same name.");
  for (const p of newParams)
    if (!oldParams.some((o) => o.name === p.name) && p.defaultValue === undefined) return host.status(`The new parameter $${p.name} needs a default value, for existing calls.`);

  host.status(`Looking for calls to ${symbol.name}…`);
  // A subclass's constructor has its own parameters, and calls the parent's through parent::__construct().
  const overrides = symbol.kind === 6 && container && !isConstructor(symbol) ? await overridesOf(model, container, symbol.name) : [];
  const refs = [await callsOf(model, symbol, container)];
  for (const o of overrides) refs.push((await memberCalls(o.fqn, symbol.name, { path: o.path, line: o.line })) ?? []);
  const changes: Record<string, L.TextEdit[]> = {
    [model.uri.toString()]: [{ range: { start: positionAt(model.getValue(), open + 1), end: positionAt(model.getValue(), close) }, newText }],
  };
  for (const o of overrides)
    (changes[monaco.Uri.file(o.path).toString()] ??= []).push({ range: { start: positionAt(o.text, o.open + 1), end: positionAt(o.text, o.close) }, newText });
  const skipped: string[] = [];
  let calls = 0;
  const seen = new Set<string>();
  for (const ref of refs.flat()) {
    // A call through a subclass can turn up for both the method and its override.
    const id = `${ref.uri}:${ref.range.start.line}:${ref.range.start.character}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const path = monaco.Uri.parse(ref.uri).fsPath;
    const text = await textOf(path).catch(() => null);
    if (text === null) continue;
    const rel = path.startsWith(host.root() + "/") ? path.slice(host.root().length + 1) : path;
    const at = `${rel}:${ref.range.start.line + 1}`;
    const before = offsetAt(text, ref.range.start);
    // Declarations, such as an override's, have their own edit.
    if (/\bfunction\s+&?$/.test(text.slice(text.lastIndexOf("\n", before - 1) + 1, before))) continue;
    // The call's parentheses follow the name; a reference without them (a callable string) can't change.
    const after = offsetAt(text, ref.range.end);
    const paren = text.slice(after).match(/^\s*\(/);
    if (!paren) {
      skipped.push(`${at}: not a call`);
      continue;
    }
    const argsOpen = after + paren[0].length - 1;
    const argsClose = matchBracket(text, argsOpen);
    if (argsClose < 0) continue;
    const result = rewriteArgs(splitTopLevel(text.slice(argsOpen + 1, argsClose)), oldParams, newParams);
    if ("error" in result) {
      skipped.push(`${at}: ${result.error}`);
      continue;
    }
    (changes[ref.uri] ??= []).push({ range: { start: positionAt(text, argsOpen + 1), end: positionAt(text, argsClose) }, newText: result.args.join(", ") });
    calls++;
  }
  host.status("");
  const files = Object.keys(changes).length;
  const also = overrides.length ? `, ${overrides.length} ${overrides.length === 1 ? "override" : "overrides"},` : "";
  pick(`Change ${symbol.name}: the declaration${also} and ${calls} ${calls === 1 ? "call" : "calls"} in ${files} ${files === 1 ? "file" : "files"}`, () => [
    { label: "Apply", detail: skipped.length ? `${skipped.length} left unchanged` : "Undo each file with ⌘Z", run: () => applyWorkspaceEdit({ changes }).then(() => host.status(`Changed ${symbol.name} and ${calls} calls.`)) },
    ...skipped.map((s) => ({ label: `Left unchanged: ${s}`, run: () => {} })),
    { label: "Cancel", run: () => {} },
  ]);
}

export function initRefactor(h: Host) {
  host = h;
}
