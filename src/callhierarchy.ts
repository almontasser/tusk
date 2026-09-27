// Call hierarchy (⌃⌥H): the methods and functions that call the one at the cursor, or that it calls. Tusk's server
// answers (`textDocument/prepareCallHierarchy`, `callHierarchy/incomingCalls` and `callHierarchy/outgoingCalls`).
import type * as L from "vscode-languageserver-protocol";
import { monaco } from "./editor";
import { tuskRequest } from "./lsp";
import { showPanelView } from "./terminal";

type Host = {
  root(): string;
  ensureModel(path: string): Promise<monaco.editor.ITextModel>;
  openAt(path: string, line: number): Promise<unknown>;
  status(text: string): void;
};
/** A method, function, or file in the tree. `line` is where a click goes: the call for a caller, else the declaration (1-based). */
type Row = { item: L.CallHierarchyItem; line: number };

let host: Host;
let mode: "callers" | "callees" = "callers";
let current: Row | null = null;

const pathOf = (uri: string) => monaco.Uri.parse(uri).fsPath;
const relative = (path: string) => (path.startsWith(host.root() + "/") ? path.slice(host.root().length + 1) : path);
const FILE = 1;

async function next(row: Row): Promise<Row[]> {
  if (mode === "callers") {
    const calls = (await tuskRequest<L.CallHierarchyIncomingCall[] | null>("callHierarchy/incomingCalls", { item: row.item }).catch(() => null)) ?? [];
    // One row per call, as a caller with several calls is still a place to go to for each.
    return calls.flatMap((c) => c.fromRanges.map((r) => ({ item: c.from, line: r.start.line + 1 })));
  }
  const calls = (await tuskRequest<L.CallHierarchyOutgoingCall[] | null>("callHierarchy/outgoingCalls", { item: row.item }).catch(() => null)) ?? [];
  return calls.map((c) => ({ item: c.to, line: c.to.selectionRange.start.line + 1 }));
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

function row(r: Row, depth: number, open: boolean): HTMLLIElement {
  const { item } = r;
  const li = document.createElement("li");
  const div = document.createElement("div");
  div.className = "hierarchy-row";
  div.style.paddingLeft = `${8 + depth * 16}px`;
  const file = item.kind === FILE;
  const icon = file ? "file" : item.name.includes("::") ? "symbol-method" : "symbol-function";
  div.innerHTML = `<span class="chevron codicon codicon-chevron-right"></span><span class="codicon codicon-${icon} kind-class"></span><span class="name"></span><span class="namespace"></span>`;
  div.querySelector(".name")!.textContent = item.name;
  const path = pathOf(item.uri);
  div.querySelector(".namespace")!.textContent = `${relative(path)}:${r.line}`;
  div.title = item.detail ?? item.name;
  const children = document.createElement("ul");
  li.append(div, children);
  let loaded = false;
  const chevron = div.querySelector(".chevron")!;
  // Code outside a function, such as a route file, has no callers of its own.
  if (file) chevron.classList.add("empty");
  const toggle = async () => {
    if (file) return;
    if (!children.hidden && loaded) {
      children.hidden = true;
      chevron.classList.replace("codicon-chevron-down", "codicon-chevron-right");
      return;
    }
    children.hidden = false;
    chevron.classList.replace("codicon-chevron-right", "codicon-chevron-down");
    if (loaded) return;
    loaded = true;
    const found = await next(r);
    if (!found.length) chevron.classList.add("empty");
    children.replaceChildren(...found.map((n) => row(n, depth + 1, false)));
  };
  chevron.addEventListener("click", (e) => (e.stopPropagation(), toggle()));
  div.onclick = () => host.openAt(path, r.line);
  div.ondblclick = toggle;
  if (open) toggle();
  return li;
}

function render() {
  panel.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  if (!current) return;
  panel.querySelector(".hierarchy-title")!.textContent = current.item.name;
  panel.querySelector(".hierarchy-tree")!.replaceChildren(row(current, 0, true));
}

/** Shows the call hierarchy of the method or function called under the cursor, or else of the one the cursor is in. */
export async function showCallHierarchy(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos || model.getLanguageId() !== "php") return host.status("Call Hierarchy works in PHP files.");
  const items = await tuskRequest<L.CallHierarchyItem[] | null>("textDocument/prepareCallHierarchy", {
    textDocument: { uri: model.uri.toString() },
    position: { line: pos.lineNumber - 1, character: pos.column - 1 },
  }).catch(() => null);
  if (!items?.length) return host.status("Put the cursor in or on a method or function.");
  current = { item: items[0], line: items[0].selectionRange.start.line + 1 };
  render();
  showPanelView("Call Hierarchy", panel);
}

export function initCallHierarchy(h: Host) {
  host = h;
}
