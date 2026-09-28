// Type hierarchy (⌃H): a type's parents, interfaces, and traits, or the types that extend, implement, or use it.
// Tusk's server answers from its index (`textDocument/prepareTypeHierarchy`, `typeHierarchy/supertypes` and
// `typeHierarchy/subtypes`).
import { showError } from "./status";
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

let host: Host;
let mode: "subtypes" | "supertypes" = "subtypes";
let current: L.TypeHierarchyItem | null = null;

// Symbol kinds: interface 11, struct 23 (traits), enum 10.
const icons: Record<number, [string, string]> = { 11: ["symbol-interface", "interface"], 23: ["symbol-method", "trait"], 10: ["symbol-enum", "enum"] };
const iconOf = (kind: number) => icons[kind] ?? ["symbol-class", "class"];
/** PHP's own types have a `tusk:` address, and no file to open. */
const fileOf = (item: L.TypeHierarchyItem) => (item.uri.startsWith("file:") ? monaco.Uri.parse(item.uri).fsPath : null);

async function next(item: L.TypeHierarchyItem): Promise<L.TypeHierarchyItem[]> {
  const method = mode === "subtypes" ? "typeHierarchy/subtypes" : "typeHierarchy/supertypes";
  return (await tuskRequest<L.TypeHierarchyItem[] | null>(method, { item }).catch(() => null)) ?? [];
}

// ---- Panel ----

const panel = document.createElement("div");
panel.className = "hierarchy";
panel.innerHTML = `
  <div class="hierarchy-toolbar">
    <button data-mode="subtypes" title="Classes that extend or implement it">Subtypes</button>
    <button data-mode="supertypes" title="Its parent classes and interfaces">Supertypes</button>
    <span class="hierarchy-title"></span>
  </div>
  <ul class="hierarchy-tree" aria-label="Type hierarchy"></ul>`;
panel.querySelectorAll<HTMLElement>("[data-mode]").forEach(
  (b) => (b.onclick = () => ((mode = b.dataset.mode as typeof mode), render())),
);

const fqnOf = (item: L.TypeHierarchyItem) => (item.detail ? `${item.detail}\\${item.name}` : item.name);

function row(item: L.TypeHierarchyItem, depth: number, open: boolean): HTMLLIElement {
  const li = document.createElement("li");
  const div = document.createElement("div");
  div.className = "hierarchy-row";
  div.style.paddingLeft = `${8 + depth * 16}px`;
  const [icon, kind] = iconOf(item.kind);
  div.innerHTML = `<span class="chevron codicon codicon-chevron-right"></span><span class="codicon codicon-${icon} kind-${kind}"></span><span class="name"></span><span class="namespace"></span>`;
  div.querySelector(".name")!.textContent = item.name;
  div.querySelector(".namespace")!.textContent = item.detail ?? "";
  const path = fileOf(item);
  div.title = path ? fqnOf(item) : `${fqnOf(item)} (built into PHP)`;
  const children = document.createElement("ul");
  li.append(div, children);
  let loaded = false;
  const chevron = div.querySelector(".chevron")!;
  const toggle = async () => {
    if (!children.hidden && loaded) {
      children.hidden = true;
      chevron.classList.replace("codicon-chevron-down", "codicon-chevron-right");
      return;
    }
    children.hidden = false;
    chevron.classList.replace("codicon-chevron-right", "codicon-chevron-down");
    if (loaded) return;
    loaded = true;
    const found = await next(item);
    if (!found.length) chevron.classList.add("empty");
    children.replaceChildren(...found.map((n) => row(n, depth + 1, false)));
  };
  chevron.addEventListener("click", (e) => (e.stopPropagation(), toggle()));
  div.onclick = () => path && host.openAt(path, item.selectionRange.start.line + 1);
  div.ondblclick = toggle;
  if (open) toggle();
  return li;
}

function render() {
  panel.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  const tree = panel.querySelector(".hierarchy-tree")!;
  if (!current) return tree.replaceChildren();
  panel.querySelector(".hierarchy-title")!.textContent = fqnOf(current);
  tree.replaceChildren(row(current, 0, true));
}

/** Shows the hierarchy of the type named under the cursor, or else of the type the cursor is in. */
export async function showTypeHierarchy(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos || model.getLanguageId() !== "php") return host.status("Type Hierarchy works in PHP files.");
  const items = await tuskRequest<L.TypeHierarchyItem[] | null>("textDocument/prepareTypeHierarchy", {
    textDocument: { uri: model.uri.toString() },
    position: { line: pos.lineNumber - 1, character: pos.column - 1 },
  }).catch((e) => (showError("Can't show the type hierarchy", e), undefined));
  if (items === undefined) return;
  if (!items?.length) return host.status("Put the cursor in or on a class, interface, trait, or enum.");
  current = items[0];
  render();
  showPanelView("Hierarchy", panel);
}

export function initHierarchy(h: Host) {
  host = h;
}
