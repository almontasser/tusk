import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { message, open } from "@tauri-apps/plugin-dialog";
import { createEditor, monaco } from "./editor";
import { checkComposerLock, didSave, filesChanged, reindex, startLsp, workspaceSymbols } from "./lsp";
import { type Item, pick, rank } from "./palette";
import { EXCLUDED_FOLDERS, fileIcon, folderIcon, initials } from "./icons";
import { decorateConflicts, initConflicts } from "./conflicts";
import { attachDebugger, editBreakpoint, initDebugger, isPaused, setExceptionClasses, setServerRoot, togglePauseOnExceptions, loadBreakpoints, resume, showDebugPanel, startDebugging, stepInto, stepOut, stepOver, stopDebugging, toggleBreakpoint, XDEBUG_ENV } from "./debug";
import { afterSave, annotate, trackEditor, branchListeners, branches, stashChanges, stashes, stageSelected, closeDiff, showDiff, change, focusCommit, initGit, pushBranch, refreshGit, updateProject } from "./git";
import { indentation, type Properties, propertiesFor } from "./editorconfig";
import { componentClassPath } from "./phptypes";
import { initComposer, loadPackages, requirePackage, updateAll } from "./composer";
import { chooseRebaseBase, initRebase } from "./rebase";
import { closeMerge, initMerge, openMerge } from "./merge";
import { initHttpClient, selectEnvironment } from "./httpclient";
import { initSafeDelete, safeDelete } from "./safedelete";
import { changeSignature, initRefactor, inlineVariable } from "./refactor";
import { initHierarchy, showTypeHierarchy } from "./hierarchy";
import { initLocalHistory, recordVersion, showLocalHistory } from "./localhistory";
import { initDatabase, loadTables, openConsole } from "./database";
import { createPullRequest, initPullRequests, loadPullRequests, updateBranchPullRequest } from "./prs";
import { copyPath, initFiles, newFile, newFolder, remove, rename, revealInFinder } from "./files";
import { hideHistory, initHistory, showFileHistory, showLog } from "./history";
import { detectFormatters, formatModel, initFormatting } from "./format";
import { addEditor, initSettings, onSettings, openSettings, removeEditor, setKeymapEditor, settings, updateSetting } from "./settings";
import { initSearch, openSearch, refreshSearch } from "./search";
import { initRunner, rerun, runAllTests, runAnything, runTestAtCursor } from "./runner";
import { openTerminal, panelShown, shellCount, toggleTerminal } from "./terminal";

type Entry = { name: string; path: string; is_dir: boolean };
type Tab = { model: monaco.editor.ITextModel; saved: number };

const $ = (id: string) => document.getElementById(id)!;
// ---- Editor panes ----
// Panes share one set of tabs. Each pane shows one of them; `editor` and `active` are the
// focused pane's editor and file, and other panes keep theirs in `Pane.active`.

type Pane = { editor: monaco.editor.IStandaloneCodeEditor; el: HTMLElement; active: string };
const panes: Pane[] = [];

function addPane(): Pane {
  const el = document.createElement("div");
  el.className = "pane";
  $("editor").append(el);
  const ed = createEditor(el);
  const pane: Pane = { editor: ed, el, active: "" };
  panes.push(pane);
  addEditor(ed);
  trackEditor(ed);
  decorateConflicts(ed);
  attachDebugger(ed);
  ed.onDidChangeCursorPosition(() => saveSoon());
  ed.onDidScrollChange(() => saveSoon());
  ed.onDidFocusEditorText(() => focusPane(pane));
  ed.onDidChangeCursorPosition(() => pane.editor === editor && updateStatusItems());
  ed.onDidChangeCursorSelection(() => pane.editor === editor && updateStatusItems());
  return pane;
}

let editor = addPane().editor;
const currentPane = () => panes.find((p) => p.editor === editor)!;

function focusPane(pane: Pane) {
  const current = currentPane();
  if (current === pane) return;
  current.active = active;
  active = pane.active;
  editor = pane.editor;
  panes.forEach((p) => p.el.classList.toggle("focused", p === pane && panes.length > 1));
  renderTabs();
  markActiveInTree();
}

const MAX_PANES = 4;

/** Opens a pane on the right with the current file. With four panes, it moves to the next pane instead. */
function splitRight() {
  if (panes.length >= MAX_PANES) return focusPane(panes[(panes.indexOf(currentPane()) + 1) % panes.length]), editor.focus();
  const path = active;
  const view = editor.saveViewState();
  const pane = addPane();
  pane.active = path;
  pane.editor.setModel(tabs.get(path)?.model ?? null);
  if (view) pane.editor.restoreViewState(view);
  focusPane(pane);
  editor.focus();
}

/** Closes the focused pane, keeping its tabs. */
function unsplit(pane = currentPane()) {
  if (panes.length < 2) return;
  if (pane.editor === editor) focusPane(panes.find((p) => p !== pane)!);
  panes.splice(panes.indexOf(pane), 1);
  removeEditor(pane.editor);
  pane.editor.dispose();
  pane.el.remove();
  panes.forEach((p) => p.el.classList.remove("focused"));
  renderTabs();
}

/** Points unfocused panes away from a file that closed or moved. A pane left empty closes. */
function updateOtherPanes(change: (path: string) => string | null) {
  for (const pane of panes.filter((p) => p !== currentPane())) {
    const next = change(pane.active);
    if (next === null) continue;
    pane.active = next;
    pane.editor.setModel(tabs.get(next)?.model ?? null);
    if (!next) unsplit(pane);
  }
}
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
  $("project-name").textContent = nameOf(dir);
  $("project-badge").textContent = initials(nameOf(dir));
  $("welcome").hidden = true;
  rememberProject(dir);
  await renderDir($("tree") as HTMLUListElement, dir);
  await invoke("watch", { path: dir });
  try { localStorage.setItem("lastFolder", dir); } catch {}
  refreshGit();
  detectFormatters();
  loadBreakpoints();
  if (session) await restoreSession(session);
  restartServers();
}

// ---- Session: open tabs, view states, expanded folders, and the sidebar view, per project ----

type Session = {
  tabs: string[];
  active: string;
  views: Record<string, monaco.editor.ICodeEditorViewState>;
  dirs: string[];
  view: string;
  /** Each pane's file, left to right, and the focused pane. */
  panes?: string[];
  focused?: number;
  /** How many shell terminals were open, and whether the panel showed. */
  shells?: number;
  panel?: boolean;
};
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
    panes: panes.map((p) => (p.editor === editor ? active : p.active)),
    focused: panes.indexOf(currentPane()),
    shells: shellCount(),
    panel: panelShown(),
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
  const [first, ...others] = session.panes ?? [session.active];
  if (tabs.has(first)) await openFile(first);
  // Split panes, left to right; the first pane already shows its file.
  for (const path of others) {
    if (!tabs.has(path) || panes.length >= MAX_PANES) continue;
    splitRight();
    showModel(path);
  }
  const focused = panes[session.focused ?? 0];
  if (focused) focusPane(focused), editor.focus();
  if (session.view && session.view !== "project") showView(session.view);
  // Shells come back fresh in the project folder; command tabs, such as a server, aren't re-run.
  for (let i = 0; i < (session.shells ?? 0); i++) await openTerminal(root);
  if ((session.shells ?? 0) > 0 && !session.panel) toggleTerminal(root);
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
  updateOtherPanes((p) => (p === from ? to : null));
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
  updateOtherPanes((p) => (p && inside(p) ? ([...tabs.keys()].pop() ?? "") : null));
  renderTabs();
  markActiveInTree();
}

/**
 * Status messages by source, so one language server finishing a task doesn't clear another's
 * progress. The status bar shows the most recent message that is still set.
 */
const statuses = new Map<string, string>();
const statusTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Shows a status message. Sources ending in ":progress" are background work and show a
 * spinner until cleared; other messages clear themselves after 8 seconds.
 */
function status(text: string, source = "app") {
  statuses.delete(source);
  if (text) statuses.set(source, text);
  clearTimeout(statusTimers.get(source));
  if (text && !source.endsWith(":progress")) statusTimers.set(source, setTimeout(() => status("", source), 8000));
  const [latestSource, latest] = [...statuses].at(-1) ?? ["", ""];
  $("lsp-status").textContent = latest;
  $("lsp-status").classList.toggle("busy", latestSource.endsWith(":progress"));
  // Failures also show as a toast, so they aren't missed in the status bar.
  if (/\b(failed|error|fatal|can't|couldn't|invalid)\b/i.test(text)) toast(text);
}

/** Shows an error message in the corner for a few seconds. */
function toast(text: string) {
  console.warn(`[toast] ${text}`); // So an error can be traced after the toast closes.
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span class="codicon codicon-error"></span><p></p><button class="codicon codicon-close" aria-label="Dismiss"></button>`;
  // Git's "hint:" lines repeat advice; the first lines carry the error.
  el.querySelector("p")!.textContent = text.split("\n").filter((l) => l.trim() && !l.startsWith("hint:")).join(" ");
  const close = () => el.remove();
  el.querySelector("button")!.onclick = close;
  $("toasts").append(el);
  setTimeout(close, 6000);
}

// ---- Status bar items for the focused editor ----

function updateStatusItems() {
  const model = editor.getModel();
  const pos = editor.getPosition();
  const selection = editor.getSelection();
  const selected = selection && model && !selection.isEmpty() ? model.getValueInRange(selection).length : 0;
  $("cursor-position").textContent = model && pos ? `${pos.lineNumber}:${pos.column}${selected ? ` (${selected} chars)` : ""}` : "";
  const options = model?.getOptions();
  $("indentation").textContent = options ? (options.insertSpaces ? `${options.tabSize} spaces` : `Tab size ${options.tabSize}`) : "";
  $("encoding").textContent = model ? `UTF-8 · ${model.getEOL() === "\n" ? "LF" : "CRLF"}` : "";
  const language = model && monaco.languages.getLanguages().find((l) => l.id === model.getLanguageId());
  $("language").textContent = language ? (language.aliases?.[0] ?? language.id) : "";
}

/** Error and warning counts across open files; clicking lists them. */
function updateProblems() {
  const markers = monaco.editor.getModelMarkers({}).filter((m) => tabs.has(m.resource.fsPath));
  $("error-count").textContent = String(markers.filter((m) => m.severity === monaco.MarkerSeverity.Error).length);
  $("warning-count").textContent = String(markers.filter((m) => m.severity === monaco.MarkerSeverity.Warning).length);
}
monaco.editor.onDidChangeMarkers(updateProblems);
$("problems").onclick = () => {
  const markers = monaco.editor
    .getModelMarkers({})
    .filter((m) => tabs.has(m.resource.fsPath) && m.severity >= monaco.MarkerSeverity.Warning)
    .sort((a, b) => b.severity - a.severity);
  pick("Problems in open files", (q) =>
    rank(q, markers.map((m) => ({
      label: m.message.split("\n")[0],
      detail: `${relative(m.resource.fsPath)}:${m.startLineNumber}`,
      icon: m.severity === monaco.MarkerSeverity.Error ? "codicon-error icon-error" : "codicon-warning icon-warning",
      run: () => openAt(m.resource.fsPath, new monaco.Range(m.startLineNumber, m.startColumn, m.endLineNumber, m.endColumn)),
    }))),
  );
};

// ---- Recent projects and the welcome screen ----

const recentProjects = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem("recentProjects") ?? "[]");
  } catch {
    return [];
  }
};

function rememberProject(dir: string) {
  try {
    localStorage.setItem("recentProjects", JSON.stringify([dir, ...recentProjects().filter((d) => d !== dir)].slice(0, 12)));
  } catch {}
}

function projectItem(dir: string): Item {
  return { label: nameOf(dir), detail: dir.replace(/^\/Users\/[^/]+/, "~"), icon: "codicon-folder icon-folder", run: () => openFolder(dir) };
}

/** The project name in the title bar: switch to a recent project or open a folder. */
function projectMenu() {
  const items = [{ label: "Open Folder…", icon: "codicon-folder-opened", run: () => openFolder() }, ...recentProjects().filter((d) => d !== root).map(projectItem)];
  pick("Open a recent project", (q) => rank(q, items));
}

function showWelcome() {
  const recent = recentProjects();
  $("recent-heading").hidden = !recent.length;
  $("recent-projects").replaceChildren(
    ...recent.map((dir) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="project-badge"></span><span class="text"><span class="name"></span><span class="dir"></span></span>`;
      li.querySelector(".project-badge")!.textContent = initials(nameOf(dir));
      li.querySelector(".name")!.textContent = nameOf(dir);
      li.querySelector(".dir")!.textContent = dir.replace(/^\/Users\/[^/]+/, "~");
      li.onclick = () => openFolder(dir);
      return li;
    }),
  );
  $("welcome").hidden = false;
}

/** Draws a tree row: chevron (folders), icon, and name, indented by depth. */
function paintRow(row: HTMLElement, name: string, isDir: boolean) {
  const open = row.classList.contains("open");
  const icon = isDir ? folderIcon(name, open) : fileIcon(name);
  const depth = relative(row.dataset.path!).split("/").length - 1;
  row.style.paddingLeft = `${6 + depth * 14}px`;
  row.innerHTML = `<span class="chevron codicon ${isDir ? (open ? "codicon-chevron-down" : "codicon-chevron-right") : ""}"></span><span class="file-icon codicon codicon-${icon.codicon} ${icon.color}"></span><span class="name"></span>`;
  row.querySelector(".name")!.textContent = name;
}

async function renderDir(ul: HTMLUListElement, dir: string) {
  renderedDirs.set(dir, ul);
  const entries = await invoke<Entry[]>("read_dir", { path: dir });
  ul.replaceChildren(
    ...entries.map((e) => {
      const li = document.createElement("li");
      const row = document.createElement("div");
      row.className = `row ${e.is_dir ? "dir" : "file"}${e.is_dir && EXCLUDED_FOLDERS.has(e.name) ? " excluded" : ""}`;
      row.dataset.path = e.path;
      row.role = "treeitem";
      if (e.is_dir && openDirs.has(e.path)) row.classList.add("open");
      paintRow(row, e.name, e.is_dir);
      row.tabIndex = -1;
      row.draggable = true;
      li.append(row);
      if (e.is_dir) {
        const children = document.createElement("ul");
        li.append(children);
        row.onclick = () => toggleDir(e.path, row, children);
        if (openDirs.has(e.path)) renderDir(children, e.path);
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
  paintRow(row, nameOf(path), true);
  saveSoon();
}

function collapseAll() {
  openDirs.clear();
  renderedDirs.clear();
  renderDir($("tree") as HTMLUListElement, root);
  saveSoon();
}

async function openFile(path: string) {
  if (!tabs.has(path)) {
    const model = await ensureModel(path);
    tabs.set(path, { model, saved: model.getAlternativeVersionId() });
    model.onDidChangeContent(renderTabs);
  }
  closeDiff(false);
  closeMerge();
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
  updateOtherPanes((p) => (p === path ? ([...tabs.keys()].pop() ?? "") : null));
  saveSoon();
  renderTabs();
  markActiveInTree();
}

/** Saves one tab's file if it has unsaved changes. */
// ---- Blade components ----

// Laravel LSP takes <x-alert> to the component's view; this adds its class, when it has one.
monaco.languages.registerDefinitionProvider("blade", {
  async provideDefinition(model, position) {
    const line = model.getLineContent(position.lineNumber);
    for (const m of line.matchAll(/<\/?(x-[\w\-.:]+)/g)) {
      const start = m.index! + m[0].length - m[1].length + 1;
      if (position.column < start || position.column > start + m[1].length) continue;
      const rel = componentClassPath(m[1]);
      if (!rel || !root) return null;
      const source = await invoke<string>("read_file", { path: `${root}/${rel}` }).catch(() => null);
      if (source === null) return null;
      const classLine = source.split("\n").findIndex((l) => /^\s*(final\s+)?class\s/.test(l)) + 1 || 1;
      return { uri: monaco.Uri.file(`${root}/${rel}`), range: new monaco.Range(classLine, 1, classLine, 1) };
    }
    return null;
  },
});

// ---- EditorConfig ----

const editorConfigs = new Map<string, Promise<string | null>>(); // folder → its .editorconfig, or null

/** The .editorconfig files that apply to a project file, from the project root down to its folder. */
async function editorConfigFor(path: string): Promise<Properties> {
  if (!root || !path.startsWith(root + "/")) return {};
  const dirs = [root];
  for (const part of relative(parentOf(path)).split("/").filter(Boolean)) dirs.push(`${dirs.at(-1)}/${part}`);
  const configs = [];
  for (const dir of dirs) {
    if (!editorConfigs.has(dir)) editorConfigs.set(dir, invoke<string>("read_file", { path: `${dir}/.editorconfig` }).catch(() => null));
    const text = await editorConfigs.get(dir)!;
    if (text !== null) configs.push({ dir, text });
  }
  return propertiesFor(path, configs);
}

/** Sets a model's indentation from .editorconfig. Without one, Monaco's detection from the file's content stays. */
async function applyEditorConfig(model: monaco.editor.ITextModel) {
  const options = Object.fromEntries(Object.entries(indentation(await editorConfigFor(model.uri.fsPath))).filter(([, v]) => v !== undefined));
  if (Object.keys(options).length && !model.isDisposed()) model.updateOptions(options);
  if (model === editor.getModel()) updateStatusItems();
}
monaco.editor.onDidCreateModel((model) => model.uri.scheme === "file" && applyEditorConfig(model));

/** Trims trailing whitespace and adds or removes the final newline, as .editorconfig asks, as one undoable edit. */
async function applySaveRules(model: monaco.editor.ITextModel) {
  const props = await editorConfigFor(model.uri.fsPath);
  const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
  const last = model.getLineCount();
  if (props.trim_trailing_whitespace === "true") {
    for (let line = 1; line <= last; line++) {
      const text = model.getLineContent(line);
      const trimmed = text.trimEnd().length;
      if (trimmed < text.length) edits.push({ range: new monaco.Range(line, trimmed + 1, line, text.length + 1), text: "" });
    }
  }
  const endsWithNewline = last > 1 && model.getLineContent(last) === "";
  if (props.insert_final_newline === "true" && !endsWithNewline && model.getValueLength())
    edits.push({ range: new monaco.Range(last, model.getLineMaxColumn(last), last, model.getLineMaxColumn(last)), text: model.getEOL() });
  if (props.insert_final_newline === "false" && endsWithNewline)
    edits.push({ range: new monaco.Range(last - 1, model.getLineMaxColumn(last - 1), last, 1), text: "" });
  if (edits.length) model.pushEditOperations(null, edits, () => null);
}

/** Writes a model that has no tab, such as the merge view's result for a file that isn't open. */
async function writeModel(path: string) {
  const model = monaco.editor.getModel(monaco.Uri.file(path));
  if (model) await invoke("write_file", { path, contents: model.getValue() });
}

async function saveFile(path: string) {
  const tab = tabs.get(path);
  if (!tab || !isDirty(tab)) return;
  if (settings.formatOnSave) {
    // The active editor formats through Monaco, which applies minimal edits and keeps the cursor in place.
    if (path === active) await editor.getAction("editor.action.formatDocument")?.run();
    else await formatModel(tab.model);
  }
  await applySaveRules(tab.model);
  const text = tab.model.getValue();
  try {
    await invoke("write_file", { path, contents: text });
  } catch (e) {
    return status(`Couldn't save ${relative(path)}: ${e}`);
  }
  markSaved(path);
  didSave(tab.model);
  afterSave(path, text);
  recordVersion(path, text);
}

/** Saves every tab with unsaved changes, as ⌘S does in PhpStorm. */
const saveAll = () => Promise.all([...tabs.keys()].map(saveFile));

// Auto-save, as in PhpStorm: when you switch tabs, and when the window loses focus.
window.addEventListener("blur", () => (saveSession(), settings.autoSave && saveAll()));

function renderTabs() {
  $("tabs").replaceChildren(
    ...[...tabs].map(([path, tab]) => {
      const el = document.createElement("div");
      const shown = panes.some((p) => p.editor !== editor && p.active === path);
      el.className = `tab${path === active ? " active" : ""}${shown ? " shown" : ""}${isDirty(tab) ? " dirty" : ""}`;
      el.role = "tab";
      el.title = relative(path);
      const icon = fileIcon(nameOf(path));
      el.innerHTML = `<span class="file-icon codicon codicon-${icon.codicon} ${icon.color}"></span><span class="name"></span>`;
      el.querySelector(".name")!.textContent = nameOf(path);
      el.onclick = () => openFile(path);
      el.onauxclick = (e) => e.button === 1 && closeTab(path);
      const close = document.createElement("span");
      close.className = "close";
      close.title = "Close (⌘W)";
      close.onclick = (e) => (e.stopPropagation(), closeTab(path));
      el.append(close);
      return el;
    }),
  );
  $("path").textContent = active ? relative(active) : "";
  $("empty-editor").hidden = tabs.size > 0 || !root;
  updateProblems();
  $("editor").style.display = tabs.size ? "" : "none";
  updateStatusItems();
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
  if (payload.some((p) => p.endsWith("/.editorconfig"))) {
    editorConfigs.clear();
    monaco.editor.getModels().filter((m) => m.uri.scheme === "file").forEach(applyEditorConfig);
  }
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
    if (paths.has(`${root}/composer.lock`)) checkComposerLock(root);
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

const fileItem = (path: string): Item => {
  const icon = fileIcon(nameOf(path));
  return { label: relative(path), icon: `codicon-${icon.codicon} ${icon.color}`, run: () => openFile(path) };
};

/** Go to File lists project files. Pressed again while open, it adds files that .gitignore excludes, such as vendor. */
async function goToFile() {
  if (!root) return;
  const open = document.querySelector<HTMLInputElement>("#palette input");
  const all = open?.placeholder === "Go to file";
  const query = all ? open.value : "";
  const files = (await invoke<string[]>("list_files", { root, all })).map((f) => fileItem(`${root}/${f}`));
  pick(all ? "Go to file, including ignored files such as vendor" : "Go to file", (q) => rank(q, files), 0, all ? { value: query } : undefined);
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
  { label: "Safe Delete…", keys: "Meta+Delete", run: () => safeDelete(editor), editorOnly: true },
  { label: "Inline Variable", keys: "Alt+Meta+N", run: () => inlineVariable(editor), editorOnly: true },
  { label: "Change Signature…", keys: "Meta+F6", run: () => changeSignature(editor), editorOnly: true },
  { label: "Type Hierarchy", keys: "Ctrl+H", run: () => showTypeHierarchy(editor), editorOnly: true },
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
  { label: "Keymap…", run: () => editKeymap() },
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
  { label: "Interactive Rebase…", run: () => root && chooseRebaseBase() },
  { label: "Resolve Conflicts in Merge Tool", run: () => active && openMerge(relative(active)) },
  { label: "Stage Selected Changes (in a diff)", run: stageSelected },
  { label: "Stashes…", run: stashes },
  { label: "Annotate with Git Blame", run: () => annotate(editor) },
  { label: "Split Right", keys: "Meta+Backslash", run: splitRight },
  { label: "Unsplit", run: () => unsplit() },
  { label: "Git Log", keys: "Meta+9", run: () => showLog() },
  { label: "Show File History", run: () => active && showFileHistory(active) },
  { label: "Show Local History", run: () => active && showLocalHistory(active) },
  { label: "Restart Language Servers", run: restartServers },
  { label: "Reindex Project", run: () => reindex() },
  { label: "Pull Requests", run: () => showView("prs") },
  { label: "Database", run: () => showView("database") },
  { label: "Composer", run: () => showView("composer") },
  { label: "Composer: Require Package…", run: () => requirePackage() },
  { label: "Composer: Update All", run: () => root && updateAll() },
  editorAction("Execute Query", "", "phpEditor.runSql"),
  { label: "Select HTTP Environment…", run: () => active && selectEnvironment(active) },
  { label: "Open Query Console", keys: "Meta+Shift+F10", run: () => root && openConsole() },
  { label: "Create Pull Request…", run: () => root && createPullRequest() },
  { label: "Show Project", keys: "Meta+1", run: () => showView("project") },
  { label: "Run Anything", keys: "Ctrl Ctrl", run: () => root && runAnything() },
  { label: "Run All Tests", run: () => root && runAllTests() },
  { label: "Run Test at Cursor", keys: "Ctrl+Shift+R", run: () => runTestAtCursor(editor) },
  { label: "Debug Test at Cursor", keys: "Ctrl+Shift+D", run: () => runTestAtCursor(editor, true) },
  { label: "Toggle Breakpoint", keys: "Meta+F8", run: () => active && toggleBreakpoint(active, editor.getPosition()?.lineNumber ?? 1), editorOnly: true },
  { label: "Edit Breakpoint…", keys: "Meta+Shift+F8", run: () => active && editBreakpoint(active, editor.getPosition()?.lineNumber ?? 1), editorOnly: true },
  { label: "Toggle Pause on Exceptions", run: togglePauseOnExceptions },
  { label: "Pause on Exception Classes…", run: () => root && setExceptionClasses() },
  { label: "Set Server Paths for Debugging…", run: () => root && setServerRoot() },
  { label: "Start Listening for PHP Debug Connections", run: () => root && startDebugging() },
  { label: "Stop Debugging", keys: "Meta+F2", run: stopDebugging },
  { label: "Resume Program", keys: "F9", run: () => isPaused() && resume() },
  { label: "Step Over", keys: "F8", run: () => isPaused() && stepOver() },
  { label: "Step Into", keys: "F7", run: () => isPaused() && stepInto() },
  { label: "Step Out", keys: "Shift+F8", run: () => isPaused() && stepOut() },
  { label: "Debug Panel", run: showDebugPanel },
  {
    label: "Start Debug Server (php artisan serve with Xdebug)",
    run: async () => {
      if (!root) return;
      await startDebugging();
      // Laravel's serve command passes XDEBUG_MODE and XDEBUG_SESSION to the PHP server it starts.
      openTerminal(root, "Debug server", ["/usr/bin/env", ...XDEBUG_ENV, "php", "artisan", "serve"]);
    },
  },
  { label: "Rerun", keys: "Ctrl+R", run: () => rerun() },
  { label: "Terminal", keys: "Alt+F12", run: () => toggleTerminal(root || "/") },
  { label: "New Terminal", run: () => openTerminal(root || "/") },
  { label: "Reformat Code", keys: "Alt+Meta+L", run: () => editor.getAction("editor.action.formatDocument")?.run() },
];

const symbolsFor = (keys?: string) =>
  keys?.replace("Shift Shift", "⇧⇧").replace("Ctrl Ctrl", "⌃⌃").replace(/Ctrl\+/g, "⌃").replace(/Alt\+/g, "⌥").replace(/Shift\+/g, "⇧").replace(/Meta\+/g, "⌘");
const actionItems = () => actions.map((a) => ({ label: a.label, detail: symbolsFor(a.keys), run: a.run }));

const findAction = () => pick("Find action", (q) => rank(q, actionItems()));

// ---- Keymap ----

// Shortcuts you change are saved as overrides of these defaults, by action name.
const defaultKeys = new Map(actions.map((a) => [a.label, a.keys]));
onSettings((s) =>
  actions.forEach((a) => {
    const custom = s.keymap[a.label];
    a.keys = custom === undefined ? defaultKeys.get(a.label) : custom || undefined;
  }),
);
setKeymapEditor(() => editKeymap());

// Turning spell checking on or off starts or stops its language server.
let spellCheck = settings.spellCheck;
onSettings((s) => {
  if (s.spellCheck !== spellCheck) (spellCheck = s.spellCheck), restartServers();
});

function editKeymap() {
  pick("Keymap: choose an action to change its shortcut", (q) =>
    rank(
      q,
      actions.map((a) => ({
        label: a.label,
        detail: `${symbolsFor(a.keys) || "No shortcut"}${a.label in settings.keymap ? " (changed)" : ""}`,
        run: () => recordShortcut(a),
      })),
    ),
  );
}

let recording = false;

/** Waits for a key combination and makes it the action's shortcut. */
function recordShortcut(action: Action) {
  recording = true;
  const overlay = document.createElement("div");
  overlay.id = "shortcut-recorder";
  overlay.innerHTML = `<div class="card"><h2></h2><p class="combo">Press a shortcut</p><p class="muted">Use ⌘, ⌃, or ⌥ with a key, or a function key. Backspace removes the shortcut, and Escape cancels.</p><div class="buttons"><button type="button" data-reset>Reset to Default</button><button type="button" data-cancel>Cancel</button></div></div>`;
  overlay.querySelector("h2")!.textContent = action.label;
  document.body.append(overlay);
  const save = (keys: string | undefined) => {
    const keymap = { ...settings.keymap };
    if (keys === undefined || keys === defaultKeys.get(action.label)) delete keymap[action.label];
    else keymap[action.label] = keys;
    // A shortcut belongs to one action, so take it from any other.
    const taken = keys && actions.find((a) => a !== action && a.keys && canonical(a.keys) === keys);
    if (taken) keymap[taken.label] = "";
    updateSetting("keymap", keymap);
    status(`${action.label}: ${symbolsFor(action.keys) || "no shortcut"}${taken ? `. Removed it from ${taken.label}.` : ""}`);
  };
  const finish = () => {
    recording = false;
    window.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (["Shift", "Meta", "Control", "Alt"].includes(e.key)) return;
    const plain = !(e.metaKey || e.ctrlKey || e.altKey);
    if (plain && e.key === "Escape") return finish();
    if (plain && e.key === "Backspace") return save(""), finish();
    if (plain && !/^F\d+$/.test(e.code)) {
      overlay.querySelector(".combo")!.textContent = "Add ⌘, ⌃, or ⌥";
      return;
    }
    save(comboOf(e));
    finish();
  };
  window.addEventListener("keydown", onKey, true);
  overlay.querySelector<HTMLElement>("[data-reset]")!.onclick = () => (save(undefined), finish());
  overlay.querySelector<HTMLElement>("[data-cancel]")!.onclick = finish;
}

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
    if (recording || !(e.metaKey || e.ctrlKey || e.altKey || /^F\d+$/.test(e.code))) return;
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
    if (e.repeat || recording) return;
    const now = performance.now();
    if ((e.key === "Shift" || e.key === "Control") && lastTap.key === e.key && now - lastTap.time < 350) {
      lastTap = { key: "", time: 0 };
      actions.find((a) => a.keys === (e.key === "Shift" ? "Shift Shift" : "Ctrl Ctrl"))?.run();
    } else lastTap = { key: e.key, time: now };
  },
  true,
);

initRunner(() => root, (path, line) => openAt(path, { lineNumber: line, column: 1 }));
initDebugger({ root: () => root, openAt: (path, line) => openAt(path, { lineNumber: line, column: 1 }), status });
initSettings();
initFormatting({ root: () => root, status });
initConflicts();
initHistory({ root: () => root, status });
initSearch({ root: () => root, openAt, markSaved, status, showView });

initFiles({ root: () => root, active: () => active, openFile, renamed, forget, status });

/** Switches the sidebar between the project tree and the commit view. */
function showView(name: string) {
  currentView = name;
  saveSoon();
  $("sidebar").classList.remove("collapsed");
  document.querySelectorAll<HTMLElement>("#activitybar [data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll<HTMLElement>("#sidebar > section").forEach((s) => (s.hidden = s.id !== `view-${name}`));
  if (name === "commit") refreshGit();
  if (name === "prs") loadPullRequests();
  if (name === "database") loadTables();
  if (name === "composer") loadPackages();
}
// Clicking the active tool window's icon hides the sidebar, as in PhpStorm.
document.querySelectorAll<HTMLElement>("#activitybar [data-view]").forEach(
  (b) =>
    (b.onclick = () => {
      const collapse = b.classList.contains("active") && !$("sidebar").classList.contains("collapsed");
      if (collapse) {
        $("sidebar").classList.add("collapsed");
        b.classList.remove("active");
      } else showView(b.dataset.view!);
    }),
);
const panelButtons: Record<string, () => unknown> = {
  log: () => showLog(),
  debug: showDebugPanel,
  terminal: () => toggleTerminal(root || "/"),
};
document.querySelectorAll<HTMLElement>("#activitybar [data-panel]").forEach((b) => (b.onclick = () => panelButtons[b.dataset.panel!]()));
$("tb-search").onclick = () => searchEverywhere();
$("tb-terminal").onclick = () => toggleTerminal(root || "/");
$("tb-settings").onclick = () => openSettings();
$("tb-debug-server").onclick = () => actions.find((a) => a.label.startsWith("Start Debug Server"))?.run();
$("project-menu").onclick = () => projectMenu();
$("welcome-open").onclick = () => openFolder();
$("tree-new-file").onclick = () => root && newFile(root);
$("tree-new-folder").onclick = () => root && newFolder(root);
$("tree-collapse").onclick = () => root && collapseAll();

// Drag the sidebar's right edge to resize it; the width is remembered.
try {
  const width = localStorage.getItem("sidebarWidth");
  if (width) $("sidebar").style.width = `${width}px`;
} catch {}
$("sidebar-resize").onmousedown = (down) => {
  const start = $("sidebar").offsetWidth;
  const move = (e: MouseEvent) => ($("sidebar").style.width = `${Math.max(180, start + e.clientX - down.clientX)}px`);
  const up = () => {
    removeEventListener("mousemove", move);
    removeEventListener("mouseup", up);
    try {
      localStorage.setItem("sidebarWidth", String($("sidebar").offsetWidth));
    } catch {}
  };
  addEventListener("mousemove", move);
  addEventListener("mouseup", up);
};
initGit({ root: () => root, openFile, status, showView });
initPullRequests({ root: () => root, status, showView });
initDatabase({ root: () => root, openFile, status });
initRebase({ root: () => root, status });
initMerge({ root: () => root, ensureModel, status, saveFile: (path) => (tabs.has(path) ? saveFile(path) : writeModel(path)), resolved: (rel) => change("add", "--", rel) });
initHttpClient({ root: () => root, status });
initComposer({ root: () => root, status });
initRefactor({ root: () => root, status });
initSafeDelete({ root: () => root, forget, status, openAt: (path, target) => openAt(path, target) });
initHierarchy({ root: () => root, ensureModel, status, openAt: (path, line) => openAt(path, { lineNumber: line, column: 1 }) });
initLocalHistory({
  root: () => root,
  status,
  showDiff: (path, original, modified, label, action) =>
    showDiff(path, original, modified, label, undefined, {
      label: action.label,
      run: async () => {
        await action.run();
        closeDiff(false);
        openFile(`${root}/${path}`);
      },
    }),
});
branchListeners.push(updateBranchPullRequest);

$("open-folder").onclick = () => openFolder();

let last: string | null = null;
try {
  last = localStorage.getItem("lastFolder");
} catch {}
if (last) openFolder(last).catch(showWelcome);
else showWelcome();
