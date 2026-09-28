// Safe Delete (⌘⌦): deletes the class, method, or function under the cursor only after checking
// that nothing uses it. Usages come from Tusk's server; for classes, a text search also finds the full
// class name in strings, as Laravel's config files use them.
import { withProgress } from "./status";
import { invoke } from "@tauri-apps/api/core";
import type * as L from "vscode-languageserver-protocol";
import { monaco } from "./editor";
import { tuskRequest } from "./lsp";
import { callsOf } from "./refactor";
import { pick } from "./palette";
import { deletionLines, laravelNames } from "./phptypes";

type Host = {
  root(): string;
  openAt(path: string, target: monaco.IRange): Promise<unknown>;
  forget(path: string): void;
  status(text: string): void;
};
type Match = { path: string; line: number; column: number; end: number; text: string };
type Usage = { path: string; line: number; column: number; text: string };

let host: Host;
const CLASS_KINDS = [5, 10, 11, 23]; // class, enum, interface, struct (traits)
const KINDS: Record<number, string> = { 5: "class", 10: "enum", 11: "interface", 23: "trait", 6: "method", 12: "function" };

const contains = (r: L.Range, line: number, character: number) =>
  (line > r.start.line || (line === r.start.line && character >= r.start.character)) && (line < r.end.line || (line === r.end.line && character <= r.end.character));

/** The innermost class, method, or function declaration around the position. */
export function symbolAt(symbols: L.DocumentSymbol[], line: number, character: number, container?: L.DocumentSymbol): { symbol: L.DocumentSymbol; container?: L.DocumentSymbol } | null {
  for (const s of symbols) {
    if (!contains(s.range, line, character)) continue;
    const inner = symbolAt(s.children ?? [], line, character, s);
    if (inner) return inner;
    if (KINDS[s.kind]) return { symbol: s, container };
  }
  return null;
}

async function usagesOf(model: monaco.editor.ITextModel, symbol: L.DocumentSymbol, fqn: string | null, container?: L.DocumentSymbol): Promise<Usage[]> {
  const uri = model.uri.toString();
  // A failed search throws rather than reading as "no usages", so nothing is deleted on incomplete results.
  const refs = await callsOf(model, symbol, container);
  const usages: Usage[] = refs
    // Recursive calls inside the declaration itself don't keep it alive.
    .filter((r) => !(r.uri === uri && contains(symbol.range, r.range.start.line, r.range.start.character)))
    .map((r) => ({ path: monaco.Uri.parse(r.uri).fsPath, line: r.range.start.line + 1, column: r.range.start.character + 1, text: "" }));
  // Laravel reaches much of its code by name: classes in config strings, relationships as
  // relationship('author') or $post->author, scopes as ->published(), accessors as ->full_name.
  const names = fqn ? [fqn.replace(/\\/g, "\\\\{1,2}")] : laravelNames(symbol.name).map(escapeRegex);
  for (const pattern of names) {
    const matches = await invoke<Match[]>("search_text", { root: host.root(), query: { text: pattern, regex: true, caseSensitive: true, wholeWord: true }, include: "*.php" });
    for (const m of matches) {
      const inDeclaration = m.path === model.uri.fsPath && (fqn || (m.line - 1 >= symbol.range.start.line && m.line - 1 <= symbol.range.end.line));
      if (inDeclaration || usages.some((u) => u.path === m.path && u.line === m.line)) continue;
      usages.push({ path: m.path, line: m.line, column: m.column, text: m.text.trim() });
    }
  }
  return usages;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let running = false;

export async function safeDelete(editor: monaco.editor.ICodeEditor) {
  // One at a time: a second check would ask about ranges the first deletion is about to change.
  if (running) return host.status("Safe Delete is already running.");
  running = true;
  try {
    await check(editor);
  } finally {
    running = false;
  }
}

async function check(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!model || !position || model.getLanguageId() !== "php") return host.status("Safe Delete works on PHP classes, methods, and functions.");
  const symbols = (await tuskRequest<L.DocumentSymbol[] | null>("textDocument/documentSymbol", { textDocument: { uri: model.uri.toString() } })) ?? [];
  const found = symbolAt(symbols, position.lineNumber - 1, position.column - 1);
  if (!found) return host.status("Put the cursor in a class, method, or function to delete it.");
  const { symbol } = found;
  const kind = KINDS[symbol.kind];
  const isClass = CLASS_KINDS.includes(symbol.kind);
  const namespace = model.getValue().match(/^\s*namespace\s+([\w\\]+)\s*;/m)?.[1];
  const fqn = isClass ? (namespace ? `${namespace}\\${symbol.name}` : symbol.name) : null;
  const label = `${kind} ${found.container && !isClass ? `${found.container.name}::` : ""}${symbol.name}`;
  const version = model.getVersionId();

  const usages = await withProgress(`Looking for usages of ${label}…`, () => usagesOf(model, symbol, fqn, found.container), {
    error: `Couldn't look for usages of ${label}, so it wasn't deleted`,
  });
  if (!usages) return;
  if (usages.length) {
    const rel = (p: string) => (p.startsWith(host.root() + "/") ? p.slice(host.root().length + 1) : p);
    return pick(`${usages.length} ${usages.length === 1 ? "usage" : "usages"} of ${label}. Choose one to open it`, () => [
      ...usages.map((u) => ({
        label: `${rel(u.path)}:${u.line}`,
        detail: u.text,
        run: () => host.openAt(u.path, new monaco.Range(u.line, u.column, u.line, u.column)),
      })),
      { label: `Delete ${label} anyway`, detail: "The usages will break", run: () => remove(model, version, symbol, isClass, label) },
    ]);
  }
  // Confirmed in the palette rather than a native dialog, which a page reload could leave stuck on screen.
  pick(`Nothing uses ${label}. Delete it?`, () => [
    { label: `Delete ${label}`, detail: isClass ? "Moves its file to the Trash" : "Undo with ⌘Z", run: () => remove(model, version, symbol, isClass, label) },
    { label: "Cancel", run: () => {} },
  ]);
}

async function remove(model: monaco.editor.ITextModel, version: number, symbol: L.DocumentSymbol, isClass: boolean, label: string) {
  // The symbol's lines came from the file as it was when checked; after any edit they may point elsewhere.
  if (model.isDisposed() || model.getVersionId() !== version) return host.status(`Didn't delete ${label}: the file changed since the check. Run Safe Delete again.`);
  // A class that's the only thing in its file takes the file with it.
  const types = parseTypeCount(model.getValue());
  if (isClass && types === 1) {
    const path = model.uri.fsPath;
    host.forget(path);
    await invoke("trash_path", { path });
    return host.status(`Deleted ${label}: moved ${path.slice(host.root().length + 1)} to the Trash.`);
  }
  const [first, last] = deletionLines(model.getLinesContent(), symbol.range.start.line + 1, symbol.range.end.line + 1);
  const range = last < model.getLineCount() ? new monaco.Range(first, 1, last + 1, 1) : new monaco.Range(first, 1, last, model.getLineMaxColumn(last));
  model.pushEditOperations(null, [{ range, text: "" }], () => null);
  host.status(`Deleted ${label}. Undo with ⌘Z; the file isn't saved yet.`);
}

const parseTypeCount = (source: string) => [...source.matchAll(/^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+\w+/gm)].length;

export function initSafeDelete(h: Host) {
  host = h;
}
