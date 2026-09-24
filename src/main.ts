import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { message, open } from "@tauri-apps/plugin-dialog";
import { createEditor, monaco } from "./editor";
import { didSave, filesChanged, startLsp, workspaceSymbols } from "./lsp";
import { type Item, pick, rank } from "./palette";
import { initConflicts } from "./conflicts";
import { afterSave, annotate, branchListeners, branches, stashChanges, stashes, closeDiff, focusCommit, initGit, pushBranch, refreshGit, updateProject } from "./git";
import { createPullRequest, initPullRequests, loadPullRequests, updateBranchPullRequest } from "./prs";
import { copyPath, initFiles, newFile, newFolder, remove, rename, revealInFinder } from "./files";
import { hideHistory, initHistory, showFileHistory, showLog } from "./history";
import { detectFormatters, formatModel, initFormatting } from "./format";
import { initSettings, openSettings, settings } from "./settings";
import { initSearch, openSearch, refreshSearch } from "./search";
import { initRunner, rerun, runAnything, runTestAtCursor } from "./runner";
import { openTerminal, toggleTerminal } from "./terminal";

type Entry = { name: string; path: string; is_dir: boolean };
type Tab = { model: monaco.editor.ITextModel; saved: number };

const $ = (id: string) => document.getElementById(id)!;
const editor = createEditor($("editor"));
const tabs = new Map<string, Tab>();
const renderedDirs = new Map<string, HTMLUListElement>();
const openDirs = new Set<string>();
let root = "";
let active = "";
let recent: string[] = [];
let currentView = "project";
/** Cursor, selection, scroll, and folds of each tab, which Monaco drops when it switches models. */
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState>();

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
const relative = (path: string) => (path.startsWith(root + "/") ? path.slice(root.length + 1) : path);
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const isDirty = (t: Tab) => t.model.getAlternativeVersionId() !== t.saved;

async function openFolder(dir: unknown = null) {
  dir ??= await open({ directory: true });
  if (typeof dir !== "string") return;
  saveSession();
  for (const path of [...tabs.keys()]) await closeTab(path);
  if (tabs.size) return; // user kept unsaved changes
  root = dir;
  recent = [];
  const session = loadSession();
  openDirs.clear();
  session?.dirs.forEach((d) => openDirs.add(d));
  renderedDirs.clear();
  viewStates.clear();
  Object.entries(session?.views ?? {}).forEach(([p, v]) => viewStates.set(p, v));
  $("project").textContent = nameOf(dir);
  $("open-folder").hidden = true;
  await renderDir($("tree") as HTMLUListElement, dir);
  await invoke("watch", { path: dir });
  try { localStorage.setItem("lastFolder", dir); } catch {}
  refreshGit();
  detectFormatters();
  if (session) await restoreSession(session);
  restartServers();
}

// ---- Session: open tabs, view states, expanded folders, and the sidebar view, per project ----

type Session = { tabs: string[]; active: string; views: Record<string, monaco.editor.ICodeEditorViewState>; dirs: string[]; view: string };
const sessionKey = () => `session:${root}`;

function loadSession(): Session | null {
  try {
    return JSON.parse(localStorage.getItem(sessionKey()) ?? "null");
  } catch {
    return null;
  }
}

function saveSession() {
  if (!root) return;
  if (active && tabs.has(active)) viewStates.set(active, editor.saveViewState()!);
  const paths = [...tabs.keys()];
  const session: Session = {
    tabs: paths,
    active,
    views: Object.fromEntries(paths.filter((p) => viewStates.has(p)).map((p) => [p, viewStates.get(p)!])),
    dirs: [...openDirs],
    view: currentView,
  };
  try {
    localStorage.setItem(sessionKey(), JSON.stringify(session));
  } catch {
    // Storage can be unavailable or full; a lost session only costs the open tabs.
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
const saveSoon = () => (clearTimeout(saveTimer), (saveTimer = setTimeout(saveSession, 500)));
window.addEventListener("beforeunload", saveSession);

async function restoreSession(session: Session) {
  // Files deleted since the last session are skipped.
  for (const path of session.tabs) await openFile(path).catch(() => viewStates.delete(path));
  if (tabs.has(session.active)) await openFile(session.active);
  if (session.view && session.view !== "project") showView(session.view);
}

/** Shows a tab's model in the editor, saving the view state of the tab it replaces. */
function showModel(path: string) {
  if (settings.autoSave && active && active !== path && tabs.has(active)) saveFile(active);
  if (active && tabs.has(active) && editor.getModel()) viewStates.set(active, editor.saveViewState()!);
  active = path;
  editor.setModel(tabs.get(path)?.model ?? null);
  const view = viewStates.get(path);
  if (view && tabs.has(path)) editor.restoreViewState(view);
  saveSoon();
}

/** Starts (or restarts) the language servers for the open folder. */
function restartServers() {
  if (!root) return;
  startLsp(root, { ensureModel, markSaved, renamed, status, openAt: (path, line) => openAt(path, { lineNumber: line, column: 1 }) }).catch((e) =>
    status(`Language server failed: ${e}`),
  );
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

/** Moves a file's tab after the file moved on disk, keeping its place and any unsaved edits. */
async function renamed(from: string, to: string) {
  const old = monaco.editor.getModel(monaco.Uri.file(from));
  const tab = tabs.get(from);
  if (!tab) return old?.dispose();
  const unsaved = isDirty(tab) ? tab.model.getValue() : null;
  const model = await ensureModel(to);
  if (unsaved !== null) model.setValue(unsaved);
  // Rebuild the map so the tab keeps its position.
  const entries = [...tabs].map(([p, t]): [string, Tab] =>
    p === from ? [to, { model, saved: unsaved === null ? model.getAlternativeVersionId() : -1 }] : [p, t],
  );
  tabs.clear();
  entries.forEach(([p, t]) => tabs.set(p, t));
  model.onDidChangeContent(renderTabs);
  const view = active === from ? editor.saveViewState() : viewStates.get(from);
  viewStates.delete(from);
  if (view) viewStates.set(to, view);
  if (active === from) {
    active = "";
    showModel(to);
  }
  old?.dispose();
  renderTabs();
  markActiveInTree();
}

/** Closes tabs and drops models for a deleted file, or for everything inside a deleted folder. */
function forget(path: string) {
  const inside = (p: string) => p === path || p.startsWith(path + "/");
  for (const [p, tab] of [...tabs]) {
    if (!inside(p)) continue;
    tabs.delete(p);
    tab.model.dispose();
  }
  monaco.editor.getModels().filter((m) => m.uri.scheme === "file" && inside(m.uri.fsPath)).forEach((m) => m.dispose());
  [...viewStates.keys()].filter(inside).forEach((p) => viewStates.delete(p));
  if (inside(active)) {
    active = "";
    showModel([...tabs.keys()].pop() ?? "");
  }
  renderTabs();
  markActiveInTree();
}

/**
 * Status messages by source, so one language server finishing a task doesn't clear another's
 * progress. The status bar shows the most recent message that is still set.
 */
const statuses = new Map<string, string>();
function status(text: string, source = "app") {
  statuses.delete(source);
  if (text) statuses.set(source, text);
  $("lsp-status").textContent = [...statuses.values()].at(-1) ?? "";
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
      row.tabIndex = -1;
      row.draggable = true;
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
  saveSoon();
}

async function openFile(path: string) {
  if (!tabs.has(path)) {
    const model = await ensureModel(path);
    tabs.set(path, { model, saved: model.getAlternativeVersionId() });
    model.onDidChangeContent(renderTabs);
  }
  closeDiff(false);
  hideHistory();
  recent = [path, ...recent.filter((p) => p !== path)].slice(0, 30);
  showModel(path);
  editor.focus();
  renderTabs();
  markActiveInTree();
}

async function closeTab(path: string) {
  const tab = tabs.get(path);
  if (!tab) return;
  // With auto-save, closing saves, as in PhpStorm; otherwise it asks. If a save fails, the tab stays open.
  if (isDirty(tab)) {
    const choice = settings.autoSave
      ? "Save"
      : await message(`Save changes to ${nameOf(path)}?`, { kind: "warning", buttons: { yes: "Save", no: "Don't Save", cancel: "Cancel" } });
    if (choice === "Cancel") return;
    if (choice === "Save" || choice === "Yes") {
      await saveFile(path);
      if (isDirty(tab)) return;
    }
  }
  tab.model.dispose();
  tabs.delete(path);
  viewStates.delete(path);
  if (active === path) {
    active = "";
    showModel([...tabs.keys()].pop() ?? "");
  }
  saveSoon();
  renderTabs();
  markActiveInTree();
}

/** Saves one tab's file if it has unsaved changes. */
async function saveFile(path: string) {
  const tab = tabs.get(path);
  if (!tab || !isDirty(tab)) return;
  if (settings.formatOnSave) {
    // The active editor formats through Monaco, which applies minimal edits and keeps the cursor in place.
    if (path === active) await editor.getAction("editor.action.formatDocument")?.run();
    else await formatModel(tab.model);
  }
  const text = tab.model.getValue();
  try {
    await invoke("write_file", { path, contents: text });
  } catch (e) {
    return status(`Couldn't save ${relative(path)}: ${e}`);
  }
  markSaved(path);
  didSave(tab.model);
  afterSave(path, text);
}

/** Saves every tab with unsaved changes, as ⌘S does in PhpStorm. */
const saveAll = () => Promise.all([...tabs.keys()].map(saveFile));

// Auto-save, as in PhpStorm: when you switch tabs, and when the window loses focus.
window.addEventListener("blur", () => settings.autoSave && saveAll());

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
  $("path").textContent = active ? relative(active) : "";
}

function markActiveInTree() {
  document.querySelectorAll("#tree .row.active").forEach((r) => r.classList.remove("active"));
  document.querySelector(`#tree .row[data-path="${CSS.escape(active)}"]`)?.classList.add("active");
}

// Batch watcher events: reload clean open files that changed on disk, re-render affected folders.
let pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
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
    const php = [...paths].filter((p) => p.endsWith(".php"));
    filesChanged(await Promise.all(php.map(async (path) => ({ path, exists: await invoke<boolean>("path_exists", { path }) }))));
    for (const dir of new Set([...paths].map(parentOf))) {
      const ul = renderedDirs.get(dir);
      if (ul) renderDir(ul, dir);
    }
    renderTabs();
    refreshGit();
    refreshSearch();
  }, 150);
});

/** Opens a file and moves the cursor to a position or selects a range. */
async function openAt(path: string, target?: monaco.IRange | monaco.IPosition) {
  await openFile(path);
  if (!target) return;
  if (monaco.Range.isIRange(target)) editor.setSelection(target);
  else editor.setPosition(target);
  editor.revealRangeInCenterIfOutsideViewport(editor.getSelection()!);
}

// Go to definition, references, and similar features open other files through this hook.
monaco.editor.registerEditorOpener({
  openCodeEditor(_, resource, selection) {
    openAt(resource.fsPath, selection);
    return true;
  },
});

// ---- Navigation and search ----

const fileItem = (path: string): Item => ({ label: relative(path), run: () => openFile(path) });

async function goToFile() {
  if (!root) return;
  const files = (await invoke<string[]>("list_files", { root })).map((f) => fileItem(`${root}/${f}`));
  pick("Go to file", (q) => rank(q, files));
}

// LSP symbol kinds that name types: Class, Enum, Interface, Struct.
const typeKinds = [5, 10, 11, 23];

async function symbolItems(query: string, typesOnly: boolean): Promise<Item[]> {
  if (!query.trim()) return [];
  const symbols = (await workspaceSymbols(query)).filter(
    // Phpactor also indexes the PHP stubs inside its own .phar, which can't be opened.
    (s) => (!typesOnly || typeKinds.includes(s.kind)) && !s.path.includes(".phar/"),
  );
  const items = symbols.map((s) => ({
    label: s.name,
    detail: s.container || relative(s.path),
    run: () => openAt(s.path, s.range && { lineNumber: s.range.startLineNumber, column: s.range.startColumn }),
  }));
  return rank(query, items);
}

const goToClass = () => pick("Go to class", (q) => symbolItems(q, true), 150);
const goToSymbol = () => pick("Go to symbol", (q) => symbolItems(q, false), 150);

const recentFiles = () => pick("Recent files", (q) => rank(q, recent.filter((p) => p !== active).map(fileItem)));

// ---- Actions and keyboard shortcuts ----

/** Keys use `Ctrl`, `Alt`, `Shift`, and `Meta` joined with `+`, then the key from `KeyboardEvent.code`. */
type Action = { label: string; keys?: string; run(): unknown; editorOnly?: boolean };

/** An action that runs a Monaco command. Its shortcut works only while the editor has focus. */
const editorAction = (label: string, keys: string, id: string): Action => ({
  label,
  keys,
  run: () => (editor.focus(), editor.trigger("keyboard", id, {})),
  editorOnly: true,
});

// Shortcuts follow PhpStorm's macOS keymap.
const actions: Action[] = [
  { label: "Open Folder…", run: () => openFolder() },
  { label: "New File…", keys: "Meta+N", run: () => root && newFile() },
  { label: "New Folder…", run: () => root && newFolder() },
  { label: "Rename File…", run: () => rename() },
  { label: "Move File to Trash", run: () => remove() },
  { label: "Copy Path", keys: "Meta+Shift+C", run: () => copyPath() },
  { label: "Reveal in Finder", run: () => revealInFinder() },
  editorAction("Go to Declaration", "Meta+B", "editor.action.revealDefinition"),
  editorAction("Go to Implementation", "Alt+Meta+B", "editor.action.goToImplementation"),
  editorAction("Go to Type Declaration", "Ctrl+Shift+B", "editor.action.goToTypeDefinition"),
  editorAction("Find Usages", "Alt+F7", "editor.action.goToReferences"),
  editorAction("Rename", "Shift+F6", "editor.action.rename"),
  editorAction("Show Context Actions", "Alt+Enter", "editor.action.quickFix"),
  editorAction("Parameter Info", "Meta+P", "editor.action.triggerParameterHints"),
  editorAction("Quick Documentation", "F1", "editor.action.showHover"),
  editorAction("Extend Selection", "Alt+ArrowUp", "editor.action.smartSelect.expand"),
  editorAction("Shrink Selection", "Alt+ArrowDown", "editor.action.smartSelect.shrink"),
  editorAction("Move Line Up", "Alt+Shift+ArrowUp", "editor.action.moveLinesUpAction"),
  editorAction("Move Line Down", "Alt+Shift+ArrowDown", "editor.action.moveLinesDownAction"),
  editorAction("Duplicate Line", "Meta+D", "editor.action.copyLinesDownAction"),
  editorAction("Delete Line", "Meta+Backspace", "editor.action.deleteLines"),
  editorAction("Optimize Imports", "Ctrl+Alt+O", "editor.action.organizeImports"),
  { label: "Save All", keys: "Meta+S", run: saveAll },
  { label: "Settings…", keys: "Meta+Comma", run: openSettings },
  { label: "Close Tab", keys: "Meta+W", run: () => closeTab(active) },
  { label: "Search Everywhere", keys: "Shift Shift", run: () => searchEverywhere() },
  { label: "Find Action", keys: "Meta+Shift+A", run: () => findAction() },
  { label: "Go to File", keys: "Meta+Shift+O", run: goToFile },
  { label: "Go to Class", keys: "Meta+O", run: goToClass },
  { label: "Go to Symbol", keys: "Alt+Meta+O", run: goToSymbol },
  { label: "Find in Files", keys: "Meta+Shift+F", run: () => openSearch(editor) },
  { label: "Replace in Files", keys: "Meta+Shift+R", run: () => openSearch(editor, true) },
  { label: "Recent Files", keys: "Meta+E", run: recentFiles },
  { label: "File Structure", keys: "Meta+F12", run: () => editor.trigger("action", "editor.action.quickOutline", {}) },
  { label: "Commit…", keys: "Meta+K", run: focusCommit },
  { label: "Push…", keys: "Meta+Shift+K", run: () => root && pushBranch() },
  { label: "Update Project", keys: "Meta+T", run: () => root && updateProject() },
  { label: "Branches…", run: branches },
  { label: "Stash Changes…", run: stashChanges },
  { label: "Stashes…", run: stashes },
  { label: "Annotate with Git Blame", run: annotate },
  { label: "Git Log", keys: "Meta+9", run: () => showLog() },
  { label: "Show File History", run: () => active && showFileHistory(active) },
  { label: "Restart Language Servers", run: restartServers },
  { label: "Pull Requests", run: () => showView("prs") },
  { label: "Create Pull Request…", run: () => root && createPullRequest() },
  { label: "Show Project", keys: "Meta+1", run: () => showView("project") },
  { label: "Run Anything", keys: "Ctrl Ctrl", run: () => root && runAnything() },
  { label: "Run Test at Cursor", keys: "Ctrl+Shift+R", run: () => runTestAtCursor(editor) },
  { label: "Rerun", keys: "Ctrl+R", run: () => rerun() },
  { label: "Terminal", keys: "Alt+F12", run: () => toggleTerminal(root || "/") },
  { label: "New Terminal", run: () => openTerminal(root || "/") },
  { label: "Reformat Code", keys: "Alt+Meta+L", run: () => editor.getAction("editor.action.formatDocument")?.run() },
];

const symbolsFor = (keys?: string) =>
  keys?.replace("Shift Shift", "⇧⇧").replace("Ctrl Ctrl", "⌃⌃").replace(/Ctrl\+/g, "⌃").replace(/Alt\+/g, "⌥").replace(/Shift\+/g, "⇧").replace(/Meta\+/g, "⌘");
const actionItems = () => actions.map((a) => ({ label: a.label, detail: symbolsFor(a.keys), run: a.run }));

const findAction = () => pick("Find action", (q) => rank(q, actionItems()));

async function searchEverywhere() {
  const files = root ? (await invoke<string[]>("list_files", { root })).map((f) => fileItem(`${root}/${f}`)) : [];
  pick("Search everywhere: classes, files, and actions", async (q) => {
    if (!q.trim()) return recent.map(fileItem);
    const classes = await symbolItems(q, true);
    return [...classes.slice(0, 10), ...rank(q, files).slice(0, 30), ...rank(q, actionItems()).slice(0, 5)];
  }, 150);
}

const modifiers = ["Ctrl", "Alt", "Shift", "Meta"];

/** Puts modifiers in a fixed order, so `Meta+Shift+O` and `Shift+Meta+O` compare equal. */
function canonical(keys: string) {
  const parts = keys.split("+");
  const key = parts.pop();
  return [...modifiers.filter((m) => parts.includes(m)), key].join("+");
}

function comboOf(e: KeyboardEvent) {
  const held = [e.ctrlKey, e.altKey, e.shiftKey, e.metaKey];
  return [...modifiers.filter((_, i) => held[i]), e.code.replace(/^(Key|Digit)/, "")].join("+");
}

// Capture phase, so these shortcuts win over Monaco's own bindings (such as ⇧⌘O).
window.addEventListener(
  "keydown",
  (e) => {
    if (!(e.metaKey || e.ctrlKey || e.altKey || /^F\d+$/.test(e.code))) return;
    const combo = comboOf(e);
    const action = actions.find((a) => a.keys && canonical(a.keys) === combo);
    if (!action || (action.editorOnly && !editor.hasTextFocus())) return;
    // In a terminal, Ctrl and Alt keys belong to the shell (⌃R searches history), except the panel toggle.
    const inTerminal = document.activeElement?.closest("#terminals");
    if (inTerminal && /Ctrl|Alt/.test(combo) && action.label !== "Terminal") return;
    e.preventDefault();
    e.stopPropagation();
    action.run();
  },
  true,
);

// Double Shift and double Ctrl: two presses within 350 ms with no other key between them.
let lastTap = { key: "", time: 0 };
window.addEventListener(
  "keydown",
  (e) => {
    if (e.repeat) return;
    const now = performance.now();
    if ((e.key === "Shift" || e.key === "Control") && lastTap.key === e.key && now - lastTap.time < 350) {
      lastTap = { key: "", time: 0 };
      actions.find((a) => a.keys === (e.key === "Shift" ? "Shift Shift" : "Ctrl Ctrl"))?.run();
    } else lastTap = { key: e.key, time: now };
  },
  true,
);

initRunner(() => root);
initSettings([editor]);
initFormatting({ root: () => root, status });
initConflicts(editor);
initHistory({ root: () => root, status });
initSearch({ root: () => root, openAt, markSaved, status, showView });
editor.onDidChangeCursorPosition(saveSoon);
editor.onDidScrollChange(saveSoon);
initFiles({ root: () => root, active: () => active, openFile, renamed, forget, status });

/** Switches the sidebar between the project tree and the commit view. */
function showView(name: string) {
  currentView = name;
  saveSoon();
  document.querySelectorAll<HTMLElement>("#side-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll<HTMLElement>("#sidebar > section").forEach((s) => (s.hidden = s.id !== `view-${name}`));
  if (name === "commit") refreshGit();
  if (name === "prs") loadPullRequests();
}
document.querySelectorAll<HTMLElement>("#side-tabs button").forEach((b) => (b.onclick = () => showView(b.dataset.view!)));
initGit({ root: () => root, openFile, status, showView }, editor);
initPullRequests({ root: () => root, status, showView });
branchListeners.push(updateBranchPullRequest);

$("open-folder").onclick = () => openFolder();

try {
  const last = localStorage.getItem("lastFolder");
  if (last) openFolder(last);
} catch {}
