import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { createEditor, monaco } from "./editor";

type Entry = { name: string; path: string; is_dir: boolean };
type Tab = { model: monaco.editor.ITextModel; saved: number };

const $ = (id: string) => document.getElementById(id)!;
const editor = createEditor($("editor"));
const tabs = new Map<string, Tab>();
const renderedDirs = new Map<string, HTMLUListElement>();
const openDirs = new Set<string>();
let root = "";
let active = "";

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const isDirty = (t: Tab) => t.model.getAlternativeVersionId() !== t.saved;

async function openFolder(dir: unknown = null) {
  dir ??= await open({ directory: true });
  if (typeof dir !== "string") return;
  for (const path of [...tabs.keys()]) await closeTab(path);
  if (tabs.size) return; // user kept unsaved changes
  root = dir;
  openDirs.clear();
  renderedDirs.clear();
  $("project").textContent = nameOf(dir);
  await renderDir($("tree") as HTMLUListElement, dir);
  await invoke("watch", { path: dir });
  try { localStorage.setItem("lastFolder", dir); } catch {}
}

async function renderDir(ul: HTMLUListElement, dir: string) {
  renderedDirs.set(dir, ul);
  const entries = await invoke<Entry[]>("read_dir", { path: dir });
  ul.replaceChildren(
    ...entries.map((e) => {
      const li = document.createElement("li");
      const row = document.createElement("div");
      row.className = `row ${e.is_dir ? "dir" : "file"}`;
      row.textContent = e.name;
      row.dataset.path = e.path;
      li.append(row);
      if (e.is_dir) {
        const children = document.createElement("ul");
        li.append(children);
        row.onclick = () => toggleDir(e.path, row, children);
        if (openDirs.has(e.path)) {
          row.classList.add("open");
          renderDir(children, e.path);
        }
      } else {
        row.onclick = () => openFile(e.path);
      }
      return li;
    }),
  );
  markActiveInTree();
}

function toggleDir(path: string, row: HTMLElement, children: HTMLUListElement) {
  if (openDirs.delete(path)) {
    row.classList.remove("open");
    children.replaceChildren();
    renderedDirs.delete(path);
  } else {
    openDirs.add(path);
    row.classList.add("open");
    renderDir(children, path);
  }
}

async function openFile(path: string) {
  if (!tabs.has(path)) {
    const text = await invoke<string>("read_file", { path });
    const model = monaco.editor.createModel(text, undefined, monaco.Uri.file(path));
    tabs.set(path, { model, saved: model.getAlternativeVersionId() });
    model.onDidChangeContent(renderTabs);
  }
  active = path;
  editor.setModel(tabs.get(path)!.model);
  editor.focus();
  renderTabs();
  markActiveInTree();
}

async function closeTab(path: string) {
  const tab = tabs.get(path);
  if (!tab) return;
  if (isDirty(tab) && !(await ask(`Discard unsaved changes to ${nameOf(path)}?`, { kind: "warning" }))) return;
  tab.model.dispose();
  tabs.delete(path);
  if (active === path) {
    active = [...tabs.keys()].pop() ?? "";
    editor.setModel(tabs.get(active)?.model ?? null);
  }
  renderTabs();
  markActiveInTree();
}

async function save() {
  const tab = tabs.get(active);
  if (!tab) return;
  await invoke("write_file", { path: active, contents: tab.model.getValue() });
  tab.saved = tab.model.getAlternativeVersionId();
  renderTabs();
}

function renderTabs() {
  $("tabs").replaceChildren(
    ...[...tabs].map(([path, tab]) => {
      const el = document.createElement("div");
      el.className = `tab${path === active ? " active" : ""}${isDirty(tab) ? " dirty" : ""}`;
      el.role = "tab";
      el.title = path;
      el.textContent = nameOf(path);
      el.onclick = () => openFile(path);
      el.onauxclick = (e) => e.button === 1 && closeTab(path);
      const close = document.createElement("span");
      close.className = "close";
      close.textContent = "×";
      close.onclick = (e) => (e.stopPropagation(), closeTab(path));
      el.append(close);
      return el;
    }),
  );
  $("status").textContent = active ? active.replace(root + "/", "") : "";
}

function markActiveInTree() {
  document.querySelectorAll("#tree .row.active").forEach((r) => r.classList.remove("active"));
  document.querySelector(`#tree .row[data-path="${CSS.escape(active)}"]`)?.classList.add("active");
}

// Batch watcher events: reload clean open files that changed on disk, re-render affected folders.
let pending = new Set<string>();
let timer: number | undefined;
listen<string[]>("fs-change", ({ payload }) => {
  payload.forEach((p) => pending.add(p));
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const paths = pending;
    pending = new Set();
    for (const path of paths) {
      const tab = tabs.get(path);
      if (tab && !isDirty(tab)) {
        const text = await invoke<string>("read_file", { path }).catch(() => null);
        if (text !== null && text !== tab.model.getValue()) {
          tab.model.setValue(text);
          tab.saved = tab.model.getAlternativeVersionId();
        }
      }
    }
    for (const dir of new Set([...paths].map(parentOf))) {
      const ul = renderedDirs.get(dir);
      if (ul) renderDir(ul, dir);
    }
    renderTabs();
  }, 150);
});

window.addEventListener(
  "keydown",
  (e) => {
    if (!e.metaKey) return;
    const actions: Record<string, () => unknown> = { s: save, o: () => openFolder(), w: () => closeTab(active) };
    const action = actions[e.key.toLowerCase()];
    if (action && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      action();
    }
  },
  true,
);

try {
  const last = localStorage.getItem("lastFolder");
  if (last) openFolder(last);
} catch {}
