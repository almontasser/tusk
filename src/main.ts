import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { createEditor, monaco } from "./editor";
import { didSave, startLsp } from "./lsp";

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
  startLsp(dir, { ensureModel, markSaved, renamed, status }).catch((e) => status(`Language server failed: ${e}`));
}

async function ensureModel(path: string) {
  const uri = monaco.Uri.file(path);
  const existing = monaco.editor.getModel(uri);
  if (existing) return existing;
  const text = await invoke<string>("read_file", { path });
  // Another caller may have created the model while the file was loading.
  return monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, undefined, uri);
}

function markSaved(path: string) {
  const tab = tabs.get(path);
  if (tab) tab.saved = tab.model.getAlternativeVersionId();
  renderTabs();
}

async function renamed(from: string, to: string) {
  const wasActive = active === from;
  if (tabs.has(from)) await closeTab(from);
  else monaco.editor.getModel(monaco.Uri.file(from))?.dispose();
  if (wasActive) await openFile(to);
}

const status = (text: string) => ($("lsp-status").textContent = text);

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
    const model = await ensureModel(path);
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
  markSaved(active);
  didSave(tab.model);
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
  $("path").textContent = active ? active.replace(root + "/", "") : "";
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
      const model = monaco.editor.getModel(monaco.Uri.file(path));
      const tab = tabs.get(path);
      if (model && !(tab && isDirty(tab))) {
        const text = await invoke<string>("read_file", { path }).catch(() => null);
        if (text !== null && text !== model.getValue()) {
          model.setValue(text);
          if (tab) tab.saved = model.getAlternativeVersionId();
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

// Mago formats PHP. Monaco turns the whole-file result into minimal edits, so the cursor stays put.
monaco.languages.registerDocumentFormattingEditProvider("php", {
  async provideDocumentFormattingEdits(model) {
    const text = await invoke<string>("format_php", { root, path: model.uri.fsPath, contents: model.getValue() }).catch((e) => {
      status(`Format failed: ${e}`);
      return null;
    });
    return text === null ? [] : [{ range: model.getFullModelRange(), text }];
  },
});
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL, () => editor.getAction("editor.action.formatDocument")?.run());

// Go to definition, references, and similar features open other files through this hook.
monaco.editor.registerEditorOpener({
  openCodeEditor(_, resource, selection) {
    openFile(resource.fsPath).then(() => {
      if (!selection) return;
      if (monaco.Range.isIRange(selection)) editor.setSelection(selection);
      else editor.setPosition(selection);
      editor.revealRangeInCenterIfOutsideViewport(editor.getSelection()!);
    });
    return true;
  },
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
