// Call hierarchy (⌃⌥H): the methods and functions that call the one at the cursor, or that it calls. Callers come from the same reference search as Change Signature, each placed in
// the declaration around it, and callees from Go to Definition on each call in the body.
import type * as L from "vscode-languageserver-protocol";
import { monaco } from "./editor";
import { tuskRequest } from "./lsp";
import { callSites } from "./phptypes";
import { callsOf } from "./refactor";
import { showPanelView } from "./terminal";

type Host = {
  root(): string;
  ensureModel(path: string): Promise<monaco.editor.ITextModel>;
  openAt(path: string, line: number): Promise<unknown>;
  status(text: string): void;
};
/** A method or function. `line` is where a click goes: the call for a caller, else the declaration (1-based). */
type Fn = { name: string; path: string; line: number; symbol: L.DocumentSymbol; container?: L.DocumentSymbol };

let host: Host;
let mode: "callers" | "callees" = "callers";
let current: Fn | null = null;

const pathOf = (uri: string) => monaco.Uri.parse(uri).fsPath;
const relative = (path: string) => (path.startsWith(host.root() + "/") ? path.slice(host.root().length + 1) : path);
const FUNCTION_KINDS = [6, 9, 12]; // method, constructor, function

/** The innermost method or function around a 0-based position, with its class. */
function functionAt(symbols: L.DocumentSymbol[], line: number, character: number, container?: L.DocumentSymbol): { symbol: L.DocumentSymbol; container?: L.DocumentSymbol } | null {
  for (const s of symbols) {
    const { start, end } = s.range;
    if (line < start.line || line > end.line || (line === start.line && character < start.character) || (line === end.line && character > end.character)) continue;
    const inner = functionAt(s.children ?? [], line, character, s);
    if (inner) return inner;
    if (FUNCTION_KINDS.includes(s.kind)) return { symbol: s, container };
  }
  return null;
}

/** The method or function declared around a 0-based position of a file, or null for code outside one. */
async function fnAt(path: string, line: number, character: number): Promise<Fn | null> {
  const model = await host.ensureModel(path);
  const symbols = (await tuskRequest<L.DocumentSymbol[] | null>("textDocument/documentSymbol", { textDocument: { uri: model.uri.toString() } }).catch(() => null)) ?? [];
  const found = functionAt(symbols, line, character);
  if (!found) return null;
  const { symbol, container } = found;
  return { name: container ? `${container.name}::${symbol.name}` : symbol.name, path, line: symbol.selectionRange.start.line + 1, symbol, container };
}

async function callers(fn: Fn): Promise<Fn[]> {
  const refs = await callsOf(await host.ensureModel(fn.path), fn.symbol, fn.container).catch(() => []);
  const found: Fn[] = [];
  for (const r of refs) {
    const path = pathOf(r.uri);
    const caller = await fnAt(path, r.range.start.line, r.range.start.character);
    // Code outside a function, such as a route file, is listed by its file.
    found.push({ ...(caller ?? { name: relative(path), symbol: null! }), path, line: r.range.start.line + 1 });
  }
  return found;
}

async function callees(fn: Fn): Promise<Fn[]> {
  const model = await host.ensureModel(fn.path);
  const start = model.getOffsetAt({ lineNumber: fn.symbol.range.start.line + 1, column: fn.symbol.range.start.character + 1 });
  const body = model.getValue().slice(start, model.getOffsetAt({ lineNumber: fn.symbol.range.end.line + 1, column: fn.symbol.range.end.character + 1 }));
  const found = new Map<string, Fn>();
  // ponytail: one definition request per call, in turn; a very long method takes a few seconds.
  for (const offset of callSites(body).slice(0, 200)) {
    const pos = model.getPositionAt(start + offset);
    const def = await tuskRequest<L.Location[] | L.Location | null>("textDocument/definition", {
      textDocument: { uri: model.uri.toString() },
      position: { line: pos.lineNumber - 1, character: pos.column - 1 },
    }).catch(() => null);
    const at = Array.isArray(def) ? def[0] : def;
    // PHP's own functions have no file to open.
    if (!at || !at.uri.startsWith("file:") || at.uri.includes(".phar")) continue;
    const callee = await fnAt(pathOf(at.uri), at.range.start.line, at.range.start.character);
    if (callee && !found.has(`${callee.path}:${callee.line}`)) found.set(`${callee.path}:${callee.line}`, callee);
  }
  return [...found.values()];
}

// ---- Panel ----

const panel = document.createElement("div");
panel.className = "hierarchy";
panel.innerHTML = `
  <div class="hierarchy-toolbar">
    <button data-mode="callers" title="Methods and functions that call it">Callers</button>
    <button data-mode="callees" title="Methods and functions it calls">Callees</button>
    <span class="hierarchy-title"></span>
  </div>
  <ul class="hierarchy-tree" aria-label="Call hierarchy"></ul>`;
panel.querySelectorAll<HTMLElement>("[data-mode]").forEach(
  (b) => (b.onclick = () => ((mode = b.dataset.mode as typeof mode), render())),
);

function row(fn: Fn, depth: number, open: boolean): HTMLLIElement {
  const li = document.createElement("li");
  const div = document.createElement("div");
  div.className = "hierarchy-row";
  div.style.paddingLeft = `${8 + depth * 16}px`;
  const icon = !fn.symbol ? "file" : fn.container ? "symbol-method" : "symbol-function";
  div.innerHTML = `<span class="chevron codicon codicon-chevron-right"></span><span class="codicon codicon-${icon} kind-class"></span><span class="name"></span><span class="namespace"></span>`;
  div.querySelector(".name")!.textContent = fn.name;
  div.querySelector(".namespace")!.textContent = `${relative(fn.path)}:${fn.line}`;
  const children = document.createElement("ul");
  li.append(div, children);
  let loaded = false;
  const chevron = div.querySelector(".chevron")!;
  if (!fn.symbol) chevron.classList.add("empty");
  const toggle = async () => {
    if (!fn.symbol) return;
    if (!children.hidden && loaded) {
      children.hidden = true;
      chevron.classList.replace("codicon-chevron-down", "codicon-chevron-right");
      return;
    }
    children.hidden = false;
    chevron.classList.replace("codicon-chevron-right", "codicon-chevron-down");
    if (loaded) return;
    loaded = true;
    const next = await (mode === "callers" ? callers(fn) : callees(fn));
    if (!next.length) chevron.classList.add("empty");
    children.replaceChildren(...next.map((n) => row(n, depth + 1, false)));
  };
  chevron.addEventListener("click", (e) => (e.stopPropagation(), toggle()));
  div.onclick = () => host.openAt(fn.path, fn.line);
  div.ondblclick = toggle;
  if (open) toggle();
  return li;
}

function render() {
  panel.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  if (!current) return;
  panel.querySelector(".hierarchy-title")!.textContent = current.name;
  panel.querySelector(".hierarchy-tree")!.replaceChildren(row(current, 0, true));
}

/** Shows the call hierarchy of the method or function called under the cursor, or else of the one the cursor is in. */
export async function showCallHierarchy(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos || model.getLanguageId() !== "php") return host.status("Call Hierarchy works in PHP files.");
  let fn: Fn | null = null;
  const word = model.getWordAtPosition(pos)?.word;
  if (word) {
    const def = await tuskRequest<L.Location[] | L.Location | null>("textDocument/definition", {
      textDocument: { uri: model.uri.toString() },
      position: { line: pos.lineNumber - 1, character: pos.column - 1 },
    }).catch(() => null);
    const at = Array.isArray(def) ? def[0] : def;
    if (at?.uri.startsWith("file:") && !at.uri.includes(".phar")) fn = await fnAt(pathOf(at.uri), at.range.start.line, at.range.start.character);
    // A variable or class under the cursor leads elsewhere; only the called function itself counts.
    if (fn?.symbol.name !== word) fn = null;
  }
  fn ??= await fnAt(model.uri.fsPath, pos.lineNumber - 1, pos.column - 1);
  if (!fn) return host.status("Put the cursor in or on a method or function.");
  current = fn;
  render();
  showPanelView("Call Hierarchy", panel);
}

export function initCallHierarchy(h: Host) {
  host = h;
}
