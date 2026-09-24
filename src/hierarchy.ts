// Type hierarchy (⌃H): a class's parents and interfaces, or the classes that extend or implement it.
// Phpactor has no type hierarchy requests, so supertypes come from reading declarations and finding
// each parent with a workspace symbol search, and subtypes from Phpactor's Go to Implementation.
import { invoke } from "@tauri-apps/api/core";
import { monaco } from "./editor";
import { phpactorRequest, workspaceSymbols } from "./lsp";
import { parseTypeDeclaration, type TypeDeclaration } from "./phptypes";
import { showPanelView } from "./terminal";

type Host = {
  root(): string;
  ensureModel(path: string): Promise<monaco.editor.ITextModel>;
  openAt(path: string, line: number): Promise<unknown>;
  status(text: string): void;
};
/** A type in the tree. `path` is missing for types the index doesn't know, such as PHP's own. */
type Type = { fqn: string; kind: TypeDeclaration["kind"] | "unknown"; path?: string; line: number; decl?: TypeDeclaration };
type Location = { uri: string; range: { start: { line: number } } };

let host: Host;
let mode: "subtypes" | "supertypes" = "subtypes";
let current: Type | null = null;

const icons = { class: "symbol-class", interface: "symbol-interface", trait: "symbol-method", enum: "symbol-enum", unknown: "symbol-class" };
const pathOf = (uri: string) => monaco.Uri.parse(uri).fsPath;

async function typeAt(path: string, line?: number): Promise<Type | null> {
  const source = await invoke<string>("read_file", { path }).catch(() => "");
  const decl = parseTypeDeclaration(source);
  if (!decl) return null;
  return { fqn: decl.fqn, kind: decl.kind, path, decl, line: line ?? source.slice(0, decl.offset).split("\n").length };
}

/** Finds a type's file through Phpactor's workspace symbols. */
async function locate(fqn: string): Promise<Type> {
  const short = fqn.split("\\").pop()!;
  const namespace = fqn.slice(0, -short.length - 1);
  const match = (await workspaceSymbols(short)).find((s) => s.name === short && (s.container ?? "") === namespace) ??
    (await workspaceSymbols(short)).find((s) => s.name === fqn);
  if (!match) return { fqn, kind: "unknown", line: 1 };
  return (await typeAt(match.path, (match.range?.startLineNumber ?? 0) || undefined)) ?? { fqn, kind: "unknown", path: match.path, line: 1 };
}

async function supertypes(t: Type): Promise<Type[]> {
  if (!t.decl) return [];
  return Promise.all([...t.decl.extends, ...t.decl.implements].map(locate));
}

async function subtypes(t: Type): Promise<Type[]> {
  if (!t.path || !t.decl) return [];
  const model = await host.ensureModel(t.path);
  const position = model.getPositionAt(t.decl.offset);
  const locations =
    (await phpactorRequest<Location[] | Location | null>("textDocument/implementation", {
      textDocument: { uri: model.uri.toString() },
      position: { line: position.lineNumber - 1, character: position.column - 1 },
    }).catch(() => null)) ?? [];
  const found = await Promise.all((Array.isArray(locations) ? locations : [locations]).map((l) => typeAt(pathOf(l.uri), l.range.start.line + 1)));
  // Phpactor returns every descendant; keep the direct ones, so deeper ones appear under their parents.
  const direct = new Map<string, Type>();
  for (const s of found) if (s?.decl && [...s.decl.extends, ...s.decl.implements].includes(t.fqn)) direct.set(s.fqn, s);
  return [...direct.values()].sort((a, b) => a.fqn.localeCompare(b.fqn));
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

function row(t: Type, depth: number, open: boolean): HTMLLIElement {
  const li = document.createElement("li");
  const div = document.createElement("div");
  div.className = "hierarchy-row";
  div.style.paddingLeft = `${8 + depth * 16}px`;
  const short = t.fqn.split("\\").pop()!;
  div.innerHTML = `<span class="chevron codicon codicon-chevron-right"></span><span class="codicon codicon-${icons[t.kind]} kind-${t.kind}"></span><span class="name"></span><span class="namespace"></span>`;
  div.querySelector(".name")!.textContent = short;
  div.querySelector(".namespace")!.textContent = t.fqn.slice(0, -short.length - 1);
  div.title = t.path ? t.fqn : `${t.fqn} (not in the index)`;
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
    const next = await (mode === "subtypes" ? subtypes(t) : supertypes(t));
    if (!next.length) chevron.classList.add("empty");
    children.replaceChildren(...next.map((n) => row(n, depth + 1, false)));
  };
  chevron.addEventListener("click", (e) => (e.stopPropagation(), toggle()));
  div.onclick = () => t.path && host.openAt(t.path, t.line);
  div.ondblclick = toggle;
  if (open) toggle();
  return li;
}

function render() {
  panel.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  const tree = panel.querySelector(".hierarchy-tree")!;
  if (!current) return tree.replaceChildren();
  panel.querySelector(".hierarchy-title")!.textContent = current.fqn;
  tree.replaceChildren(row(current, 0, true));
}

/** Shows the hierarchy of the type declared in a file. */
export async function showTypeHierarchy(path: string) {
  const t = await typeAt(path);
  if (!t) return host.status("This file doesn't declare a class, interface, trait, or enum.");
  current = t;
  render();
  showPanelView("Hierarchy", panel);
}

export function initHierarchy(h: Host) {
  host = h;
}
