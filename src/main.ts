import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { createEditor, monaco } from "./editor";
import { checkComposerLock, didSave, filesChanged, reindex, startLsp, workspaceSymbols } from "./lsp";
import { choose, type Item, pick, rank } from "./palette";
import { EXCLUDED_FOLDERS, fileIcon, folderIcon, initials } from "./icons";
import { decorateConflicts, initConflicts } from "./conflicts";
import { attachDebugger, editBreakpoint, initDebugger, isPaused, setExceptionClasses, setServerRoot, togglePauseOnExceptions, loadBreakpoints, resume, showDebugPanel, startDebugging, stepInto, stepOut, stepOver, stopDebugging, toggleBreakpoint, XDEBUG_ENV } from "./debug";
import { afterSave, annotate, trackEditor, branchListeners, branches, stashChanges, stashes, worktrees, stageSelected, closeDiff, showDiff, change, focusCommit, initGit, pushBranch, refreshGit, updateProject } from "./git";
import { indentation, type Properties } from "./editorconfig";
import { CHARSETS, editorConfigFor, forgetEditorConfigs, initProjectFiles, readText, writeText } from "./projectfiles";
import { componentClassPath } from "./phptypes";
import { initComposer, loadPackages, requirePackage, updateAll } from "./composer";
import { chooseRebaseBase, initRebase } from "./rebase";
import { closeMerge, initMerge, openMerge } from "./merge";
import { initHttpClient, selectEnvironment } from "./httpclient";
import { initSafeDelete, safeDelete } from "./safedelete";
import { changeSignature, initRefactor, inlineVariable } from "./refactor";
import { initHierarchy, showTypeHierarchy } from "./hierarchy";
import { initLocalHistory, recordExternalChanges, recordVersion, showDeletedFiles, showLocalHistory } from "./localhistory";
import { connectOverSsh, initDatabase, loadTables, openConsole } from "./database";
import { createPullRequest, initPullRequests, loadPullRequests, updateBranchPullRequest } from "./prs";
import { copyPath, initFiles, newFile, newFolder, remove, rename, revealInFinder } from "./files";
import { hideHistory, initHistory, showFileHistory, showLog } from "./history";
import { detectFormatters, formatModel, initFormatting } from "./format";
import { addEditor, importTheme, initSettings, onSettings, openSettings, pickTheme, removeEditor, removeTheme, setKeymapEditor, settings, updateSetting } from "./settings";
import { aiFilesChanged, initAi } from "./ai";
import { initSearch, loadTodos, openSearch, refreshSearch, refreshTodos } from "./search";
import { initRunner, rerun, runAllTests, runAnything, runTestAtCursor, showRoutes, tinker } from "./runner";
import { initBookmarks, loadBookmarks, showBookmarks, toggleBookmark } from "./bookmarks";
import { editSnippets, initSnippets } from "./snippets";
import { hideCoverage, showTestsCoveringLine } from "./coverage";
import { showBreadcrumbs } from "./breadcrumbs";
import { chooseService, composeService, composeServices, forgetComposeServices } from "./sail";
import { closeTerminals, openTerminal, panelShown, type Restore, runningTerminals, toggleTerminal } from "./terminal";

type Entry = { name: string; path: string; is_dir: boolean };
type Tab = { model: monaco.editor.ITextModel; saved: number };

const $ = (id: string) => document.getElementById(id)!;
// ---- Editor panes ----
// Each pane has its own tabs (`Pane.paths`); `tabs` holds every open file's model, shared by
// panes that show it. `editor` and `active` are the focused pane's editor and file. Panes nest in
// `.split.row` and `.split.col` groups inside #editor, which is itself a row.

type Pane = { editor: monaco.editor.IStandaloneCodeEditor; el: HTMLElement; bar: HTMLElement; paths: string[]; active: string };
const panes: Pane[] = [];

function addPane(): Pane {
  const el = document.createElement("div");
  el.className = "pane";
  el.innerHTML = `<nav class="tabs" role="tablist"></nav><div class="pane-editor"></div>`;
  const ed = createEditor(el.querySelector<HTMLElement>(".pane-editor")!);
  const pane: Pane = { editor: ed, el, bar: el.querySelector("nav")!, paths: [], active: "" };
  panes.push(pane);
  addEditor(ed);
  trackEditor(ed);
  decorateConflicts(ed);
  attachDebugger(ed);
  ed.onDidChangeCursorPosition(() => saveSoon());
  ed.onDidScrollChange(() => saveSoon());
  ed.onDidFocusEditorText(() => focusPane(pane));
  // Moving the cursor changes the selection too, so this one event covers both.
  ed.onDidChangeCursorSelection(() => pane.editor === editor && updateStatusItems());
  ed.onDidChangeCursorPosition(() => pane.editor === editor && showBreadcrumbs($("path"), relative(active), editor));
  return pane;
}

const firstPane = addPane();
$("editor").append(firstPane.el);
firstPane.el.classList.add("focused");
let editor = firstPane.editor;
const currentPane = () => panes.find((p) => p.editor === editor)!;
/** Panes in screen order: left to right, top to bottom within a group. */
const paneOrder = () => [...document.querySelectorAll("#editor .pane")].map((el) => panes.find((p) => p.el === el)!);

function focusPane(pane: Pane) {
  const current = currentPane();
  if (current === pane) return;
  current.active = active;
  active = pane.active;
  editor = pane.editor;
  panes.forEach((p) => p.el.classList.toggle("focused", p === pane));
  renderTabs();
  markActiveInTree();
}

const MAX_PANES = 4;

/** Opens the current file in a new pane to the right (`row`) or below (`col`). With four panes, it moves to the next pane instead. */
function split(dir: "row" | "col") {
  if (panes.length >= MAX_PANES) return focusPane(panes[(panes.indexOf(currentPane()) + 1) % panes.length]), editor.focus();
  splitPane(currentPane(), dir, active, false);
  editor.focus();
}

/** Adds a pane showing `path` beside another: after it (right or below), or before it (left or above). */
function splitPane(current: Pane, dir: "row" | "col", path: string, before: boolean) {
  const shown = current === currentPane() ? active : current.active;
  const view = path === shown ? current.editor.saveViewState() : viewStates.get(path);
  const pane = addPane();
  const parent = current.el.parentElement!;
  if (parent.classList.contains(dir)) {
    current.el[before ? "before" : "after"](pane.el);
    // After a resize, sizes are flex-grow values in pixels; the new pane takes half of the current one's.
    const grow = parseFloat(current.el.style.flexGrow);
    if (grow) current.el.style.flexGrow = pane.el.style.flexGrow = String(grow / 2);
  } else {
    const group = document.createElement("div");
    group.className = `split ${dir}`;
    group.style.flexGrow = current.el.style.flexGrow;
    current.el.style.flexGrow = "";
    current.el.replaceWith(group);
    group.append(...(before ? [pane.el, current.el] : [current.el, pane.el]));
  }
  pane.paths = path ? [path] : [];
  pane.active = path;
  pane.editor.setModel(tabs.get(path)?.model ?? null);
  if (view) pane.editor.restoreViewState(view);
  focusPane(pane);
}

/** Closes a pane, moving its tabs to the pane beside it. */
function unsplit(pane = currentPane()) {
  if (panes.length < 2) return;
  const sibling = pane.el.previousElementSibling ?? pane.el.nextElementSibling;
  const nearest = sibling?.matches(".pane") ? sibling : sibling?.querySelector(".pane");
  const target = panes.find((p) => p !== pane && p.el === nearest) ?? panes.find((p) => p !== pane)!;
  target.paths.push(...pane.paths.filter((p) => !target.paths.includes(p)));
  if (pane.editor === editor) focusPane(target);
  panes.splice(panes.indexOf(pane), 1);
  removeEditor(pane.editor);
  pane.editor.dispose();
  const group = pane.el.parentElement!;
  pane.el.remove();
  // A group left with one child is replaced by that child.
  if (group !== $("editor") && group.children.length === 1) {
    const only = group.firstElementChild as HTMLElement;
    only.style.flexGrow = group.style.flexGrow;
    group.replaceWith(only);
  }
  renderTabs();
}

/** Shows a file in a pane, or nothing for "". */
function showIn(pane: Pane, path: string) {
  if (pane === currentPane()) return (active = ""), showModel(path);
  pane.active = path;
  pane.editor.setModel(tabs.get(path)?.model ?? null);
  const view = viewStates.get(path);
  if (view && path) pane.editor.restoreViewState(view);
}

/**
 * Applies a rename (a new path) or a close (null) to every pane's tabs. A pane whose file closed
 * shows its last tab; a pane left without tabs closes, unless it's the only one.
 */
function retarget(change: (path: string) => string | null) {
  for (const pane of [...panes]) {
    const shown = pane === currentPane() ? active : pane.active;
    pane.paths = [...new Set(pane.paths.map(change).filter((p): p is string => p !== null))];
    const next = shown ? change(shown) : shown;
    if (next !== shown) showIn(pane, next ?? pane.paths.at(-1) ?? "");
    if (!pane.paths.length) unsplit(pane);
  }
}

/** Removes a tab from one pane, without closing the file. A pane left without tabs closes. */
function leave(pane: Pane, path: string) {
  pane.paths = pane.paths.filter((p) => p !== path);
  if ((pane === currentPane() ? active : pane.active) === path) showIn(pane, pane.paths.at(-1) ?? "");
  if (!pane.paths.length) unsplit(pane);
}

/** Moves the current tab to the next pane, splitting right when there's only one. */
function moveTabToNextPane() {
  if (!active) return;
  const from = currentPane();
  if (panes.length < 2) split("row");
  placeTab(active, from, panes[(panes.indexOf(from) + 1) % panes.length], null);
}

/** Puts a tab before another in a pane (or last, for null), taking it out of the pane it came from. */
function placeTab(path: string, from: Pane, to: Pane, before: string | null) {
  to.paths = to.paths.filter((p) => p !== path);
  const i = before ? to.paths.indexOf(before) : -1;
  to.paths.splice(i < 0 ? to.paths.length : i, 0, path);
  if (from !== to) {
    focusPane(to);
    openFile(path);
    leave(from, path);
  }
  saveSoon();
  renderTabs();
}

// Drag a tab within its bar to reorder it, onto another pane's tabs or editor to move it there,
// or onto the outer quarter of any pane's editor to split that pane with it.
let draggedTab: { path: string; from: Pane } | null = null;
type Edge = "left" | "right" | "top" | "bottom";
const dropTarget = (e: DragEvent) => {
  const pane = panes.find((p) => p.el.contains(e.target as Node));
  if (!pane) return undefined;
  const tab = (e.target as HTMLElement).closest<HTMLElement>(".tab");
  const inBar = pane.bar.contains(e.target as Node);
  let edge: Edge | null = null;
  // Splitting its own pane only makes sense when the pane keeps other tabs.
  const alone = pane === draggedTab?.from && pane.paths.length === 1;
  if (!inBar && !alone && panes.length < MAX_PANES) {
    const r = pane.el.querySelector(".pane-editor")!.getBoundingClientRect();
    const distances: [Edge, number][] = [["left", (e.clientX - r.left) / r.width], ["right", (r.right - e.clientX) / r.width], ["top", (e.clientY - r.top) / r.height], ["bottom", (r.bottom - e.clientY) / r.height]];
    const [nearest, distance] = distances.sort((a, b) => a[1] - b[1])[0];
    if (distance < 0.25) edge = nearest;
  }
  return { pane, before: tab ? pane.paths[[...pane.bar.children].indexOf(tab)] : null, tab, inBar, edge };
};
const DROP_MARKS = ["drop-before", "drop-target", "drop-left", "drop-right", "drop-top", "drop-bottom"];
const clearDropMarks = () => document.querySelectorAll("#editor .pane, #editor .tab").forEach((el) => el.classList.remove(...DROP_MARKS));
// Capture phase, so Monaco doesn't treat a tab dropped on the editor as text to insert.
$("editor").addEventListener("dragover", (e) => {
  const target = draggedTab && dropTarget(e);
  if (!target) return;
  e.preventDefault();
  e.stopPropagation();
  clearDropMarks();
  if (target.tab) target.tab.classList.add("drop-before");
  else if (target.edge) target.pane.el.classList.add(`drop-${target.edge}`);
  else if (!target.inBar) target.pane.el.classList.add("drop-target");
}, true);
$("editor").addEventListener("dragleave", clearDropMarks);
$("editor").addEventListener("drop", (e) => {
  const target = draggedTab && dropTarget(e);
  clearDropMarks();
  if (!target || !draggedTab) return;
  e.preventDefault();
  e.stopPropagation();
  const { path, from } = draggedTab;
  if (target.edge) {
    splitPane(target.pane, target.edge === "left" || target.edge === "right" ? "row" : "col", path, target.edge === "left" || target.edge === "top");
    leave(from, path);
    saveSoon();
    renderTabs();
  }
  // Dropped on itself, or on the middle of the pane it came from: nothing to do.
  else if (target.before !== path && (target.inBar || target.pane !== from)) placeTab(path, from, target.pane, target.before);
  draggedTab = null;
}, true);
$("editor").addEventListener("dragend", () => ((draggedTab = null), clearDropMarks()));

// Drag the border between two panes to resize them. The border has no element of its own: a press
// within 4 pixels of a pane's or group's leading edge, next to a sibling, starts the resize.
function sashAt(e: MouseEvent) {
  for (let el = (e.target as HTMLElement).closest<HTMLElement>(".split > *"); el; el = el.parentElement!.closest<HTMLElement>(".split > *")) {
    const row = el.parentElement!.classList.contains("row");
    const r = el.getBoundingClientRect();
    if (el.previousElementSibling && (row ? e.clientX - r.left : e.clientY - r.top) <= 4) return { el, row };
    const next = el.nextElementSibling as HTMLElement | null;
    if (next && (row ? r.right - e.clientX : r.bottom - e.clientY) <= 4) return { el: next, row };
  }
  return null;
}
$("editor").addEventListener("pointermove", (e) => {
  if (e.buttons) return;
  const sash = sashAt(e);
  $("editor").classList.toggle("sash-row", !!sash?.row);
  $("editor").classList.toggle("sash-col", !!sash && !sash.row);
});
$("editor").addEventListener("pointerdown", (e) => {
  const sash = sashAt(e);
  if (!sash) return;
  e.preventDefault();
  e.stopPropagation();
  const { el, row } = sash;
  const prev = el.previousElementSibling as HTMLElement;
  // Every sibling's flex-grow becomes its size in pixels, so the two being resized can trade pixels.
  // Measure them all before changing any, since each change reflows the rest.
  const siblings = [...el.parentElement!.children] as HTMLElement[];
  const sizes = siblings.map((child) => child.getBoundingClientRect()[row ? "width" : "height"]);
  siblings.forEach((child, i) => (child.style.flexGrow = String(sizes[i])));
  const start = prev.getBoundingClientRect()[row ? "left" : "top"];
  const total = parseFloat(prev.style.flexGrow) + parseFloat(el.style.flexGrow);
  const move = (m: PointerEvent) => {
    const size = Math.min(Math.max((row ? m.clientX : m.clientY) - start, 80), total - 80);
    prev.style.flexGrow = String(size);
    el.style.flexGrow = String(total - size);
  };
  const up = () => (removeEventListener("pointermove", move), removeEventListener("pointerup", up), saveSoon());
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
}, true);

/** `grow` is the pane's or group's flex-grow after a resize. */
type Layout = ({ paths: string[]; active: string } | { dir: "row" | "col"; children: Layout[] }) & { grow?: string };

/** The panes' arrangement and tabs, for the session. */
function layoutOf(el: Element): Layout {
  const pane = panes.find((p) => p.el === el);
  const grow = (el as HTMLElement).style.flexGrow || undefined;
  if (pane) return { paths: pane.paths, active: pane === currentPane() ? active : pane.active, grow };
  return { dir: el.classList.contains("col") ? "col" : "row", children: [...el.children].map(layoutOf), grow };
}

/** Rebuilds saved panes inside a group; `take` gives each leaf its pane. Files that no longer open are skipped. */
function buildLayout(layout: Layout, into: HTMLElement, take: () => Pane) {
  if ("paths" in layout) {
    const pane = take();
    pane.el.style.flexGrow = layout.grow ?? "";
    into.append(pane.el);
    pane.paths = layout.paths.filter((p) => tabs.has(p));
    showIn(pane, pane.paths.includes(layout.active) ? layout.active : (pane.paths.at(-1) ?? ""));
    return;
  }
  const group = into === $("editor") && layout.dir === "row" ? into : document.createElement("div");
  if (group !== into) (group.className = `split ${layout.dir}`), (group.style.flexGrow = layout.grow ?? ""), into.append(group);
  layout.children.forEach((child) => buildLayout(child, group, take));
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
  for (const path of [...tabs.keys()]) await closeFile(path);
  if (tabs.size) return; // user kept unsaved changes
  // The old project's shells and servers belong to it; the new project's session reopens its own.
  closeTerminals();
  // Files loaded without a tab, such as those go to definition and find references read, belong to the old project.
  monaco.editor.getModels().filter((m) => m.uri.scheme === "file").forEach((m) => m.dispose());
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
  await Promise.all([renderDir($("tree") as HTMLUListElement, dir), invoke("watch", { path: dir })]);
  try { localStorage.setItem("lastFolder", dir); } catch {}
  refreshGit();
  detectFormatters();
  loadBreakpoints();
  loadBookmarks();
  if (session) await restoreSession(session);
  restartServers();
  // Terminals reopen after the language servers have started: shells in their last folder, and
  // commands such as a dev server run again. Sessions from before terminals were saved kept a count of shells.
  const terminals: Restore[] = session?.terminals ?? Array.from({ length: session?.shells ?? 0 }, () => ({ title: "Terminal", cwd: root }));
  const found = terminals.length ? await invoke<boolean[]>("paths_exist", { paths: terminals.map((t) => t.cwd) }) : [];
  for (const [i, t] of terminals.entries()) await openTerminal(found[i] ? t.cwd : root, t.title, t.command, undefined, undefined, !!t.command);
  if (terminals.length && !session?.panel) toggleTerminal(root);
}

// ---- Session: open tabs, view states, expanded folders, and the sidebar view, per project ----

type Session = {
  tabs: string[];
  active: string;
  views: Record<string, monaco.editor.ICodeEditorViewState>;
  dirs: string[];
  view: string;
  /** The panes and their tabs, and the focused pane's position among them. */
  layout?: Layout;
  focused?: number;
  /** The running shells and restorable commands, and whether the panel showed. `shells` is the older count of shells. */
  terminals?: Restore[];
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
    layout: layoutOf($("editor")),
    focused: paneOrder().indexOf(currentPane()),
    terminals: runningTerminals(),
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
  // Read every tab's file at once. Files deleted since the last session are skipped.
  const models = await Promise.all(session.tabs.map((path) => ensureModel(path).catch(() => (viewStates.delete(path), null))));
  session.tabs.forEach((path, i) => models[i] && addTab(path, models[i]));
  const opened = session.tabs.filter((path) => tabs.has(path));
  recent = [...opened].reverse().slice(0, 30);
  if (session.layout) {
    // The one pane left after the previous project closed takes the first leaf; later leaves get new panes.
    const [spare] = panes;
    spare.el.remove();
    buildLayout(session.layout, $("editor"), () => (spare.el.isConnected ? addPane() : spare));
    // A file whose pane was lost goes to the first pane.
    const orphans = [...tabs.keys()].filter((p) => !panes.some((pane) => pane.paths.includes(p)));
    spare.paths.push(...orphans);
  } else {
    currentPane().paths = opened;
    const shown = tabs.has(session.active) ? session.active : opened.at(-1);
    if (shown) await openFile(shown);
  }
  const focused = paneOrder()[session.focused ?? 0];
  if (focused) focusPane(focused), editor.focus();
  renderTabs();
  markActiveInTree();
  if (session.view && session.view !== "project") showView(session.view);
}

/** Shows a tab's model in the editor, saving the view state of the tab it replaces. */
function showModel(path: string) {
  if (settings.autoSave && active && active !== path && tabs.has(active)) saveFile(active);
  if (active && tabs.has(active) && editor.getModel()) viewStates.set(active, editor.saveViewState()!);
  active = path;
  const pane = currentPane();
  if (path && !pane.paths.includes(path)) pane.paths.push(path);
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
  const text = await readText(path);
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
  model.onDidChangeContent(() => showDirty(to));
  const view = active === from ? editor.saveViewState() : viewStates.get(from);
  viewStates.delete(from);
  if (view) viewStates.set(to, view);
  retarget((p) => (p === from ? to : p));
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
  retarget((p) => (inside(p) ? null : p));
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
  const selected = selection && model && !selection.isEmpty() ? model.getValueLengthInRange(selection) : 0;
  $("cursor-position").textContent = model && pos ? `${pos.lineNumber}:${pos.column}${selected ? ` (${selected} chars)` : ""}` : "";
  const options = model?.getOptions();
  $("indentation").textContent = options ? (options.insertSpaces ? `${options.tabSize} spaces` : `Tab size ${options.tabSize}`) : "";
  $("encoding").textContent = model ? `${modelCharsets.get(model) ?? "UTF-8"} · ${model.getEOL() === "\n" ? "LF" : "CRLF"}` : "";
  $("language").textContent = model ? languageName(model.getLanguageId()) : "";
}

const languageNames = new Map<string, string>();
function languageName(id: string) {
  if (!languageNames.has(id)) {
    const language = monaco.languages.getLanguages().find((l) => l.id === id);
    languageNames.set(id, language?.aliases?.[0] ?? id);
  }
  return languageNames.get(id)!;
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

/** Each rendered folder's entries, so a file-system event that didn't add, remove, or rename one redraws nothing. */
const listings = new WeakMap<HTMLUListElement, string>();

/** Lists a folder in the tree. With `onlyIfChanged`, the folder is left alone when its entries are the same. */
async function renderDir(ul: HTMLUListElement, dir: string, onlyIfChanged = false) {
  renderedDirs.set(dir, ul);
  const entries = await invoke<Entry[]>("read_dir", { path: dir });
  const listing = entries.map((e) => `${e.is_dir ? "d" : "f"}${e.name}`).join("\0");
  if (onlyIfChanged && listings.get(ul) === listing) return;
  listings.set(ul, listing);
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

/** Registers an open file's model, without showing it. */
function addTab(path: string, model: monaco.editor.ITextModel) {
  if (tabs.has(path)) return;
  tabs.set(path, { model, saved: model.getAlternativeVersionId() });
  model.onDidChangeContent(() => showDirty(path));
}

async function openFile(path: string) {
  if (!tabs.has(path)) addTab(path, await ensureModel(path));
  closeDiff(false);
  closeMerge();
  hideHistory();
  recent = [path, ...recent.filter((p) => p !== path)].slice(0, 30);
  showModel(path);
  editor.focus();
  renderTabs();
  markActiveInTree();
}

/** Closes a tab in one pane. The file stays open if another pane has it; otherwise it closes, saving first. */
async function closeTab(path: string, pane = currentPane()) {
  if (!panes.some((p) => p !== pane && p.paths.includes(path))) return closeFile(path);
  leave(pane, path);
  saveSoon();
  renderTabs();
  markActiveInTree();
}

/** Closes a file in every pane. With unsaved changes, it saves or asks first. */
async function closeFile(path: string) {
  const tab = tabs.get(path);
  if (!tab) return;
  // With auto-save, closing saves, as in PhpStorm; otherwise it asks. If a save fails, the tab stays open.
  if (isDirty(tab)) {
    const choice = settings.autoSave
      ? "Save"
      : await choose(`Save changes to ${nameOf(path)}?`, ["Save", "Don't Save", "Cancel"]);
    if (choice === "Cancel" || choice === null) return;
    if (choice === "Save") {
      await saveFile(path);
      if (isDirty(tab)) return;
    }
  }
  tab.model.dispose();
  tabs.delete(path);
  viewStates.delete(path);
  retarget((p) => (p === path ? null : p));
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

/** Each file model's charset, for the status bar. */
const modelCharsets = new WeakMap<monaco.editor.ITextModel, string>();
/** `.editorconfig`'s end_of_line as Monaco's line ending. Monaco has no CR-only lines, so `cr` is left alone. */
const eolOf = (props: Properties) => ({ lf: monaco.editor.EndOfLineSequence.LF, crlf: monaco.editor.EndOfLineSequence.CRLF })[props.end_of_line];

/**
 * Sets a model's indentation from .editorconfig. Without one, Monaco's detection from the file's content stays.
 * A file with no line breaks yet, such as a new one, takes end_of_line; other files convert when saved.
 */
async function applyEditorConfig(model: monaco.editor.ITextModel) {
  const props = await editorConfigFor(model.uri.fsPath);
  if (model.isDisposed()) return;
  const options = Object.fromEntries(Object.entries(indentation(props)).filter(([, v]) => v !== undefined));
  if (Object.keys(options).length) model.updateOptions(options);
  modelCharsets.set(model, CHARSETS[props.charset] ?? "UTF-8");
  const eol = eolOf(props);
  if (eol !== undefined && model.getLineCount() === 1 && model.getEndOfLineSequence() !== eol) {
    // Changing the line ending counts as an edit, but the file's text is the same.
    const tab = tabs.get(model.uri.fsPath);
    const clean = tab && !isDirty(tab);
    model.setEOL(eol);
    if (clean) (tab.saved = model.getAlternativeVersionId()), showDirty(model.uri.fsPath);
  }
  if (model === editor.getModel()) updateStatusItems();
}
monaco.editor.onDidCreateModel((model) => model.uri.scheme === "file" && applyEditorConfig(model));

/**
 * Converts line endings, trims trailing whitespace, and adds or removes the final newline, as
 * .editorconfig asks. Each is an undoable edit.
 */
async function applySaveRules(model: monaco.editor.ITextModel) {
  const props = await editorConfigFor(model.uri.fsPath);
  const eol = eolOf(props);
  if (eol !== undefined && model.getEndOfLineSequence() !== eol) model.pushEOL(eol);
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
  if (model) await writeText(path, model.getValue());
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
    await writeText(path, text);
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

/**
 * Updates a file's unsaved-changes dot after an edit. Only the dot can change, and only when the
 * text moves away from or back to what was saved, so most keystrokes touch nothing.
 */
function showDirty(path: string) {
  const tab = tabs.get(path);
  if (!tab) return;
  const dirty = isDirty(tab);
  for (const el of document.querySelectorAll<HTMLElement>(`#editor .tab[data-path="${CSS.escape(path)}"]`))
    if (el.classList.contains("dirty") !== dirty) el.classList.toggle("dirty", dirty);
}

function renderTabs() {
  for (const pane of panes) {
    const shown = pane === currentPane() ? active : pane.active;
    pane.bar.replaceChildren(
      ...pane.paths.map((path) => {
        const tab = tabs.get(path)!;
        const el = document.createElement("div");
        el.className = `tab${path === shown ? " active" : ""}${isDirty(tab) ? " dirty" : ""}`;
        el.dataset.path = path;
        el.role = "tab";
        el.title = relative(path);
        const icon = fileIcon(nameOf(path));
        el.innerHTML = `<span class="file-icon codicon codicon-${icon.codicon} ${icon.color}"></span><span class="name"></span>`;
        el.querySelector(".name")!.textContent = nameOf(path);
        el.onclick = () => (focusPane(pane), openFile(path));
        el.onauxclick = (e) => e.button === 1 && closeTab(path, pane);
        el.draggable = true;
        el.ondragstart = (e) => ((draggedTab = { path, from: pane }), e.dataTransfer?.setData("application/x-editor-tab", path));
        const close = document.createElement("span");
        close.className = "close";
        close.title = "Close (⌘W)";
        close.onclick = (e) => (e.stopPropagation(), closeTab(path, pane));
        el.append(close);
        return el;
      }),
    );
    pane.bar.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  showBreadcrumbs($("path"), active ? relative(active) : "", editor);
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
    forgetEditorConfigs();
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
        const text = await readText(path).catch(() => null);
        if (text !== null && text !== model.getValue()) {
          // Another program changed it, such as a git checkout: keep what the editor had first.
          await recordVersion(path, model.getValue());
          model.setValue(text);
          if (tab) tab.saved = model.getAlternativeVersionId();
        }
      }
    }
    // Files without a model weren't open, so the loop above kept no version of them.
    recordExternalChanges([...paths].filter((p) => !monaco.editor.getModel(monaco.Uri.file(p))));
    if (paths.has(`${root}/composer.lock`)) checkComposerLock(root);
    aiFilesChanged([...paths]);
    const php = [...paths].filter((p) => p.endsWith(".php"));
    const exists = php.length ? await invoke<boolean[]>("paths_exist", { paths: php }) : [];
    filesChanged(php.map((path, i) => ({ path, exists: exists[i] })));
    for (const dir of new Set([...paths].map(parentOf))) {
      const ul = renderedDirs.get(dir);
      if (ul) renderDir(ul, dir, true);
    }
    renderTabs();
    refreshGit();
    refreshSearch(paths);
    refreshTodos(paths);
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

/** Shows the current file against the clipboard, or against another file, in the diff view. */
async function compareWithClipboard() {
  if (!active) return;
  const clipboard = await invoke<string>("run_capture", { cwd: root || "/", program: "pbpaste", args: [], input: null }).catch(() => "");
  showDiff(relative(active), clipboard, editor.getValue(), "Clipboard ↔ Current file");
}

async function compareWithFile() {
  if (!active || !root) return;
  const current = active;
  const files = await invoke<string[]>("list_files", { root });
  pick(`Compare ${nameOf(current)} with`, (q) =>
    rank(q, files.filter((f) => `${root}/${f}` !== current).map((f) => ({
      ...fileItem(`${root}/${f}`),
      run: async () => showDiff(relative(current), await invoke<string>("read_file", { path: `${root}/${f}` }), tabs.get(current)?.model.getValue() ?? "", `${f} ↔ ${relative(current)}`),
    }))),
  );
}

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
  { label: "Color Theme…", keys: "Ctrl+Backquote", run: pickTheme },
  { label: "Import Color Theme…", run: importTheme },
  { label: "Remove Imported Color Theme…", run: removeTheme },
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
  { label: "Worktrees…", run: worktrees },
  { label: "Annotate with Git Blame", run: () => annotate(editor) },
  { label: "Split Right", keys: "Meta+Backslash", run: () => split("row") },
  { label: "Split Down", keys: "Meta+Shift+Backslash", run: () => split("col") },
  { label: "Move Tab to Next Pane", run: moveTabToNextPane },
  { label: "Unsplit", run: () => unsplit() },
  { label: "Git Log", keys: "Meta+9", run: () => showLog() },
  { label: "Show File History", run: () => active && showFileHistory(active) },
  { label: "Show Local History", run: () => active && showLocalHistory(active) },
  { label: "Local History: Deleted Files…", run: showDeletedFiles },
  { label: "Restart Language Servers", run: restartServers },
  { label: "Reindex Project", run: () => reindex() },
  { label: "Toggle AI Completion", run: () => updateSetting("aiCompletion", !settings.aiCompletion) },
  { label: "Pull Requests", run: () => showView("prs") },
  { label: "Database", run: () => showView("database") },
  { label: "Database: Connect over SSH…", run: () => (showView("database"), connectOverSsh()) },
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
  { label: "Run All Tests with Coverage", run: () => root && runAllTests(true) },
  { label: "Run Test at Cursor with Coverage", run: () => runTestAtCursor(editor, "coverage") },
  { label: "Profile Test at Cursor", run: () => runTestAtCursor(editor, "profile") },
  { label: "Open Xdebug Profile…", run: () => loadProfiler().then((p) => p.chooseProfile()) },
  { label: "Profile URL…", run: () => root && loadProfiler().then((p) => p.profileUrl()) },
  { label: "Start Profiling Server (PHP's server with the Xdebug profiler)", run: () => root && loadProfiler().then((p) => p.startProfilingServer()) },
  { label: "Hide Coverage", run: hideCoverage },
  { label: "Show Tests Covering Line", run: () => showTestsCoveringLine(editor), editorOnly: true },
  { label: "Run Test at Cursor", keys: "Ctrl+Shift+R", run: () => runTestAtCursor(editor) },
  { label: "Debug Test at Cursor", keys: "Ctrl+Shift+D", run: () => runTestAtCursor(editor, "debug") },
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
  { label: "TODO", run: () => showView("todo") },
  { label: "Toggle Bookmark", keys: "F3", run: () => active && toggleBookmark(active, editor.getPosition()?.lineNumber ?? 1), editorOnly: true },
  { label: "Show Bookmarks", keys: "Meta+F3", run: showBookmarks },
  { label: "Edit Snippets (Live Templates)", run: () => editSnippets(openFile) },
  { label: "Laravel Tinker", run: () => root && tinker() },
  { label: "Choose Docker Service for Commands…", run: () => root && chooseDockerService() },
  { label: "Routes", run: () => root && showRoutes() },
  { label: "Compare with Clipboard", run: compareWithClipboard },
  { label: "Compare with File…", run: compareWithFile },
  { label: "Terminal", keys: "Alt+F12", run: () => toggleTerminal(root || "/") },
  { label: "New Terminal", run: () => openTerminal(root || "/") },
  { label: "Reformat Code", keys: "Alt+Meta+L", run: () => editor.getAction("editor.action.formatDocument")?.run() },
];

/** Picks the Compose service that runs tests, Artisan, and Tinker, or this Mac. Sail projects use Sail. */
async function chooseDockerService() {
  forgetComposeServices(root);
  const services = await composeServices(root);
  if (!services.length) return status("No Docker Compose service mounts this project, so commands run on this Mac.");
  const current = (await composeService(root))?.name ?? "";
  pick("Run tests, Artisan, and Tinker in", () => [
    ...services.map((s) => ({ label: s.name, detail: `${s.workdir}${s.name === current ? " · current" : ""}`, icon: "codicon-vm", run: () => chooseService(root, s.name) })),
    { label: "This Mac", detail: current ? "" : "current", icon: "codicon-device-desktop", run: () => chooseService(root, "") },
  ]);
}

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

// The profiler and its views load the first time you use them.
const loadProfiler = () =>
  import("./profiler").then((p) => (p.initProfiler({ root: () => root, status, openAt: (path, line) => openAt(path, { lineNumber: line, column: 1 }) }), p));
initRunner(() => root, (path, line) => openAt(path, { lineNumber: line, column: 1 }), status, loadProfiler);
initDebugger({ root: () => root, openAt: (path, line) => openAt(path, { lineNumber: line, column: 1 }), status });
initAi({ status, root: () => root });
const settingsLoaded = initSettings();
initSnippets();
initBookmarks({ root: () => root, openAt: (path, line) => openAt(path, { lineNumber: line, column: 1 }) });
initFormatting({ root: () => root, status });
initConflicts();
initHistory({ root: () => root, status });
initSearch({ root: () => root, openAt, markSaved, status, showView });

initProjectFiles(() => root);
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
  if (name === "todo") loadTodos();
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
$("todo-refresh").onclick = () => loadTodos();

// Drag the sidebar's right edge to resize it; the width is remembered.
try {
  const width = localStorage.getItem("sidebarWidth");
  if (width) $("sidebar").style.width = `${width}px`;
} catch {}
$("sidebar-resize").onmousedown = (down) => {
  down.preventDefault(); // Otherwise the drag selects the text it passes over.
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
initGit({ root: () => root, openFile, status, showView, openFolder });
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
// Settings load first, so the project opens with the right theme and servers, and spell checking's
// language server isn't started and then restarted when the settings arrive.
settingsLoaded.then(() => (last ? openFolder(last).catch(showWelcome) : showWelcome()));
