// Inline Variable and Change Signature, two refactorings Phpactor doesn't provide. Both refuse, with a
// reason, when the code does something they can't rewrite safely.
import { invoke } from "@tauri-apps/api/core";
import type * as L from "vscode-languageserver-protocol";
import { monaco } from "./editor";
import { applyWorkspaceEdit, PHPACTOR_INDEX, phpactorRequest } from "./lsp";
import { pick } from "./palette";
import { matchBracket, parseParams, planInline, rewriteArgs, splitTopLevel } from "./refactorparse";
import { symbolAt } from "./safedelete";

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
  const a = plan.assignment;
  edits.push({ range: a < model.getLineCount() ? new monaco.Range(a, 1, a + 1, 1) : new monaco.Range(a, 1, a, model.getLineMaxColumn(a)), text: "" });
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

const textOf = async (path: string) => monaco.editor.getModel(monaco.Uri.file(path))?.getValue() ?? invoke<string>("read_file", { path });

/** Edits a method's or function's parameters and rewrites every call Phpactor finds. */
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
 * aren't covered by the command, so they use the language server.
 */
export async function callsOf(model: monaco.editor.ITextModel, symbol: L.DocumentSymbol, container?: L.DocumentSymbol): Promise<L.Location[]> {
  if (symbol.kind === 6 && container) {
    const namespace = model.getValue().match(/^\s*namespace\s+([\w\\]+)\s*;/m)?.[1];
    const fqn = namespace ? `${namespace}\\${container.name}` : container.name;
    const phar = await invoke<string>("tool_path", { name: "phpactor.phar" });
    const args = [phar, "references:member", fqn, symbol.name, "--format=json", `--config-extra=${JSON.stringify(PHPACTOR_INDEX)}`];
    const out = await invoke<string>("run_capture", { cwd: host.root(), program: "php", args, input: null }).catch(() => "");
    try {
      const files: Member[] = JSON.parse(out.slice(out.indexOf("{"))).references;
      return files.flatMap((f) =>
        f.references
          // Leave out the declaration itself.
          .filter((r) => !(f.file === model.uri.fsPath && r.line_no - 1 === symbol.selectionRange.start.line))
          .map((r) => ({
            uri: monaco.Uri.file(f.file).toString(),
            range: { start: { line: r.line_no - 1, character: r.col_no }, end: { line: r.line_no - 1, character: r.col_no + symbol.name.length } },
          })),
      );
    } catch {
      // Fall through to the language server.
    }
  }
  return (
    (await phpactorRequest<L.Location[] | null>("textDocument/references", {
      textDocument: { uri: model.uri.toString() },
      position: symbol.selectionRange.start,
      context: { includeDeclaration: false },
    })) ?? []
  );
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
  const refs = await callsOf(model, symbol, container);
  const changes: Record<string, L.TextEdit[]> = {
    [model.uri.toString()]: [{ range: { start: positionAt(model.getValue(), open + 1), end: positionAt(model.getValue(), close) }, newText }],
  };
  const skipped: string[] = [];
  let calls = 0;
  for (const ref of refs) {
    const path = monaco.Uri.parse(ref.uri).fsPath;
    const text = await textOf(path).catch(() => null);
    if (text === null) continue;
    const rel = path.startsWith(host.root() + "/") ? path.slice(host.root().length + 1) : path;
    const at = `${rel}:${ref.range.start.line + 1}`;
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
  pick(`Change ${symbol.name}: the declaration and ${calls} ${calls === 1 ? "call" : "calls"} in ${files} ${files === 1 ? "file" : "files"}`, () => [
    { label: "Apply", detail: skipped.length ? `${skipped.length} left unchanged` : "Undo each file with ⌘Z", run: () => applyWorkspaceEdit({ changes }).then(() => host.status(`Changed ${symbol.name} and ${calls} calls.`)) },
    ...skipped.map((s) => ({ label: `Left unchanged: ${s}`, run: () => {} })),
    { label: "Cancel", run: () => {} },
  ]);
}

export function initRefactor(h: Host) {
  host = h;
}
