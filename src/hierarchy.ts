// Type hierarchy (⌃H): a type's parents, interfaces, and traits, or the types that extend, implement, or use it.
// Phpactor has no type hierarchy requests, so supertypes come from reading declarations and finding
// each parent with a workspace symbol search, subtypes from Phpactor's Go to Implementation, and a
// trait's users from a text search.
import { invoke } from "@tauri-apps/api/core";
import { monaco } from "./editor";
import { phpactorRequest, workspaceSymbols } from "./lsp";
import { parseTypeDeclarations, type TypeDeclaration } from "./phptypes";
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

/** The type declared at a line of a file: the last one starting at or before it, or the file's first. */
async function typeAt(path: string, line = 1): Promise<Type | null> {
  const source = monaco.editor.getModel(monaco.Uri.file(path))?.getValue() ?? (await invoke<string>("read_file", { path }).catch(() => ""));
  const types = parseTypeDeclarations(source).map((decl) => ({ decl, line: source.slice(0, decl.offset).split("\n").length }));
  const found = types.filter((t) => t.line <= line).at(-1) ?? types[0];
  return found ? { fqn: found.decl.fqn, kind: found.decl.kind, path, decl: found.decl, line: found.line } : null;
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
  return Promise.all([...t.decl.extends, ...t.decl.implements, ...t.decl.uses].map(locate));
}

type Match = { path: string; line: number };

async function subtypes(t: Type): Promise<Type[]> {
  if (!t.path || !t.decl) return [];
  if (t.kind === "trait") {
    const short = t.fqn.split("\\").pop()!;
    const query = { text: `^\\s*use\\s+[^;{]*\\b${short}\\b`, regex: true, caseSensitive: true, wholeWord: false };
    const matches = await invoke<Match[]>("search_text", { root: host.root(), query, include: "*.php" }).catch(() => []);
    const users = await Promise.all(matches.map((m) => typeAt(m.path, m.line)));
    return direct(t, users);
  }
  const model = await host.ensureModel(t.path);
  const position = model.getPositionAt(t.decl.offset);
  const locations =
    (await phpactorRequest<Location[] | Location | null>("textDocument/implementation", {
      textDocument: { uri: model.uri.toString() },
      position: { line: position.lineNumber - 1, character: position.column - 1 },
    }).catch(() => null)) ?? [];
  return direct(t, await Promise.all((Array.isArray(locations) ? locations : [locations]).map((l) => typeAt(pathOf(l.uri), l.range.start.line + 1))));
}

/** The types that name `t` as a parent, interface, or trait. Phpactor returns every descendant; deeper ones appear under their parents. */
function direct(t: Type, found: (Type | null)[]): Type[] {
  const types = new Map<string, Type>();
  for (const s of found) if (s?.decl && [...s.decl.extends, ...s.decl.implements, ...s.decl.uses].includes(t.fqn)) types.set(s.fqn, s);
  return [...types.values()].sort((a, b) => a.fqn.localeCompare(b.fqn));
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

/**
 * Shows the hierarchy of the type named under the cursor, found through Go to Definition, or else of the type
 * the cursor is in.
 */
export async function showTypeHierarchy(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos || model.getLanguageId() !== "php") return host.status("Type Hierarchy works in PHP files.");
  let t: Type | null = null;
  const word = model.getWordAtPosition(pos)?.word;
  if (word && /^[A-Z]/.test(word)) {
    const found = await phpactorRequest<Location[] | Location | null>("textDocument/definition", {
      textDocument: { uri: model.uri.toString() },
      position: { line: pos.lineNumber - 1, character: pos.column - 1 },
    }).catch(() => null);
    const at = Array.isArray(found) ? found[0] : found;
    if (at) t = await typeAt(pathOf(at.uri), at.range.start.line + 1);
    // A constant or a method named with a capital leads to its class, which isn't what's under the cursor.
    if (t && t.fqn.split("\\").pop() !== word) t = null;
    if (!t) t = await locate(word).then((l) => (l.path ? l : null));
  }
  t ??= await typeAt(model.uri.fsPath, pos.lineNumber);
  if (!t) return host.status("Put the cursor in or on a class, interface, trait, or enum.");
  current = t;
  render();
  showPanelView("Hierarchy", panel);
}

export function initHierarchy(h: Host) {
  host = h;
}
