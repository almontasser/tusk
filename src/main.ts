import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { createEditor, monaco } from "./editor";
import { iconButton, toast } from "./dom";
import { installErrorHandlers, showError, status } from "./status";
import { checkComposerLock, didSave, filesChanged, manageExclusions, reindex, startLsp, TYPE_KINDS, workspaceSymbols } from "./lsp";
import { choose, confirm, type Item, pick, rank } from "./palette";
import { fileIcon, folderIcon, initials } from "./icons";
import { decorateConflicts, initConflicts } from "./conflicts";
import { attachDebugger, breakpointMenu, choosePort, editBreakpoint, exceptionOptions, initDebugger, isListening, isPaused, setExceptionClasses, setServerRoot, showBreakpoints, togglePauseOnExceptions, loadBreakpoints, resume, showDebugPanel, startDebugging, stepInto, stepOut, stepOver, stopDebugging, toggleBreakpoint, xdebugEnv } from "./debug";
import { afterSave, annotate, blameMenu, changeMenu, copyRemoteUrl, goToChange, isAnnotated, trackEditor, branchListeners, worktrees, stageSelected, showDiff, change, focusCommit, initGit, refreshGit } from "./git";
import { indentation, type Properties } from "./editorconfig";
import { CHARSETS, charsetName, editorConfigFor, forgetEditorConfigs, initProjectFiles, readText, savesCr, setCharset, writeText } from "./projectfiles";
import { componentClassPath } from "./phptypes";
import { initComposer, loadPackages, requirePackage, updateAll } from "./composer";
import { initLaravelElements, newLaravelElement } from "./laravelelements";
import { initLaravelNew, newLaravelProject } from "./laravelnew";
import { filamentFilesChanged, initFilament, installFilament, loadFilament, newResource, openFileInDesigner, openModelPicker, openResourcePicker } from "./filamentview";
import { chooseRebaseBase, initRebase } from "./rebase";
import { initStash, showStashes, stashChanges } from "./stash";
import { branches, fetchAll, initBranches } from "./branches";
import { initSync, push, updateProject } from "./sync";
import { initCommitView, initRepository } from "./commitview";
import { initMerge, openMerge } from "./merge";
import { clearCookies } from "./httpclient";
import { detectAppAddress } from "./httplaravel";
import { editEnvironments } from "./httpenv";
import { closeFocusedRequest, goToRequest, httpFilesChanged, type HttpSession, httpSession, initHttpClient, newRequestInteractive, refreshTree, requestFileMoved, requestFilesSaved, requestItems, resetHttpClient, restoreHttpSession, saveFocusedRequest, selectEnvironment, showGlobals, syncRequestsWithRoutes } from "./httpview";
import { runAllRequests } from "./httpload";
import { exportOpenApi, importRequests } from "./httpteam";
import { initSafeDelete, safeDelete } from "./safedelete";
import { changeSignature, initRefactor, inline, introduceParameter, moveClass } from "./refactor";
import { extractInterface, initClassRefactor, pullMembersUp } from "./classrefactor";
import { initHierarchy, showTypeHierarchy } from "./hierarchy";
import { initCallHierarchy, showCallHierarchy } from "./callhierarchy";
import { generate, initGenerate } from "./generate";
import { initRefactorPreview } from "./refactorpreview";
import { extractConstant, extractMethod, extractVariable, initExtract, introduceField, pickAtCaret, refactorings } from "./extract";
import { followEditor, forgetPath, forgetProblems, initProblems, problemCounts, scanProject, runPhpStan, showInlineProblems, showProblems } from "./problems";
import { initLocalHistory, putLabel, recordExternalChanges, recordVersion, showDeletedFiles, showLocalHistory } from "./localhistory";
import { initLocalHistoryView } from "./localhistoryview";
import { cancelQueries, chooseConnection, connectOverSsh, copyName, dataSources, generate as generateSql, initDatabase, loadTables, openConsole, openTable, selectedTable, showHistory } from "./database";
import { createPullRequest, initPullRequests, loadPullRequests, updateBranchPullRequest } from "./prs";
import { copyPath, initFiles, newFile, newFolder, remove, rename, revealInFinder, select as selectInTree, showMenu, type MenuItem } from "./files";
import { initHistory, showFileHistory, showLog } from "./history";
import { detectFormatters, formatModel, formatOnSave, initFormatting, setFormattersDialog } from "./format";
import { openFormatters } from "./formattersdialog";
import { addEditor, importTheme, initSettings, onSettings, openSettings, pickTheme, removeEditor, removeTheme, setFileOpener, setKeymapEditor, settings, settingsFileSaved, updateSetting } from "./settings";
import { aiFilesChanged, initAi } from "./ai";
import { initSearch, loadTodos, nextMatch, openSearch, refreshSearch, refreshTodos } from "./search";
import { attachTestRunner, chooseAndRun, editConfigurations, initRunner, isRunning, isTestFile, loadRunConfigurations, rerun, runAllTests, runAnything, runSelected, runTestAtCursor, saveTemporary, showRoutes, stopRun, testMenu, tinker } from "./runner";
import { goToMnemonic, hasBookmark, initBookmarks, loadBookmarks, showBookmarks, toggleBookmark, toggleMnemonic } from "./bookmarks";
import { editSnippets, initSnippets } from "./snippets";
import { hasCoverage, hideCoverage, showTestsCoveringLine } from "./coverage";
import { showBreadcrumbs } from "./breadcrumbs";
import { withFolders } from "./diagnostics";
import { chooseService, composeService, composeServices, forgetComposeServices, setServiceChoice } from "./sail";
import { setMenu } from "./menu";
import { EDITOR_COMMANDS } from "./editorcommands";
import { attachSuperMethods, goToSuperMethod, initSuperMethods } from "./supermethod";
import { hasMarkdownPreview, showMarkdownPreview } from "./markdownpreview";
import { initJsonSchemas } from "./jsonschemas";
import { chooseSharedState, initProjectState, openProjectState, projectFilesChanged, projectValue, setProjectValue, shareItem } from "./projectstate";
import { initLayout, togglePanelFullWidth, togglePanelMaximized } from "./layout";
import { choosePhpInterpreter, configureTools, initToolPaths } from "./toolpaths";
import { editTreeHidden, initTreeHidden, toggleHiddenFiles, treeState } from "./treehidden";
import { limits } from "./limits";
import "./spelling";
import "./phpstan";
import "./magosettings";
import { splitter } from "./splitter";
import { closeDocked, closeFocusedPanelTab, closeTerminals, closeView, dockBack, draggingPanelTab, dropIndex, findInTerminal, focusTab, hidePanel, initDocking, renameTerminal, terminalFocused, onPanelChange, openTerminal, type PanelTab, tabIcon, undockDragged, panelShown, type Restore, runningTerminals, toggleTerminal } from "./terminal";

type Entry = { name: string; path: string; is_dir: boolean };
type Tab = { model: monaco.editor.ITextModel; saved: number };

const $ = (id: string) => document.getElementById(id)!;
installErrorHandlers();
// ---- Editor panes ----
// Each pane has its own tabs (`Pane.paths`); `tabs` holds every open file's model, shared by
// panes that show it. `editor` and `active` are the focused pane's editor and file. Panes nest in
// `.split.row` and `.split.col` groups inside #editor, which is itself a row.

type Pane = { editor: monaco.editor.IStandaloneCodeEditor; el: HTMLElement; bar: HTMLElement; paths: string[]; active: string };
const panes: Pane[] = [];
// Panel tabs dragged into a pane, such as a terminal, are tabs there too, under a `view:N` path that
// no file has. The pane shows the tab's element over its editor, which has no model meanwhile.
const views = new Map<string, PanelTab>();
let viewCount = 0;
const isView = (path: string) => path.startsWith("view:");
/** The focused pane's file, or "" while it shows a panel tab. */
const activeFile = () => (isView(active) ? "" : active);

function addPane(): Pane {
  const el = document.createElement("div");
  el.className = "pane";
  el.innerHTML = `<nav class="tabs" role="tablist"></nav><div class="pane-editor"></div><div class="pane-sash-x"></div><div class="pane-sash-y"></div>`;
  const ed = createEditor(el.querySelector<HTMLElement>(".pane-editor")!);
  // The code's context menu is the app's (codeMenu), with PhpStorm's actions and shortcuts rather than VS Code's.
  ed.updateOptions({ contextmenu: false });
  const pane: Pane = { editor: ed, el, bar: el.querySelector("nav")!, paths: [], active: "" };
  panes.push(pane);
  addEditor(ed);
  trackEditor(ed);
  decorateConflicts(ed);
  attachDebugger(ed);
  attachTestRunner(ed);
  attachSuperMethods(ed);
  ed.onContextMenu((e) => gutterMenu(ed, e) || codeMenu(ed, e));
  showInlineProblems(ed);
  ed.onDidChangeCursorPosition(() => saveSoon());
  ed.onDidScrollChange(() => saveSoon());
  ed.onDidFocusEditorText(() => focusPane(pane));
  el.addEventListener("pointerdown", () => focusPane(pane), true);
  // Moving the cursor changes the selection too, so this one event covers both.
  ed.onDidChangeCursorSelection(() => pane.editor === editor && updateStatusItems());
  ed.onDidChangeCursorPosition(() => pane.editor === editor && showBreadcrumbs($("path"), relative(active), editor));
  ed.onDidChangeCursorPosition((e) => pane.editor === editor && followEditor(active, e.position));
  return pane;
}

/** Menu rows for the actions with these labels that apply now, with their shortcuts from the keymap. */
const menuActions = (...labels: string[]) =>
  actions.filter((a) => labels.includes(a.label) && (!a.when || a.when())).map((a) => ({ label: a.label, keys: symbolsFor(a.keys), run: a.run }));

/** The context menu of the code: the actions for the caret, as PhpStorm's editor menu has them. */
function codeMenu(ed: monaco.editor.ICodeEditor, e: monaco.editor.IEditorMouseEvent) {
  const model = ed.getModel();
  if (!model || e.target.type === monaco.editor.MouseTargetType.SCROLLBAR) return;
  e.event.preventDefault();
  // As in Monaco's own menu, a click outside the selection moves the caret there, so actions apply to what was clicked.
  const at = e.target.position;
  if (at && !ed.getSelection()?.containsPosition(at)) ed.setPosition(at);
  const action = (label: string) => menuActions(label);
  const actionsFor = (labels: string[]) => labels.flatMap((l): MenuItem[] => (l === "-" ? ["-"] : action(l)));
  const submenu = (label: string, labels: string[]): MenuItem[] => {
    const items = actionsFor(labels);
    return items.some((i) => i !== "-") ? [{ label, items }] : [];
  };
  const monacoItem = (label: string, keys: string, id: string) => ({ label, keys, run: () => (ed.focus(), ed.trigger("contextmenu", id, null)) });
  const php = model.getLanguageId() === "php";
  const file = model.uri.scheme === "file";
  // ⌘⏎ runs the file's language's own Monaco action: a query in the console, a request in an .http file.
  showMenu(e.event.posx, e.event.posy, [
    ...menuActions("Execute Query", "Send HTTP Request"),
    ...action("Show Context Actions"),
    "-",
    monacoItem("Cut", "⌘X", "editor.action.clipboardCutAction"),
    monacoItem("Copy", "⌘C", "editor.action.clipboardCopyAction"),
    ...(file ? action("Copy Reference") : []),
    monacoItem("Paste", "⌘V", "editor.action.clipboardPasteAction"),
    "-",
    ...action("Find Usages"),
    ...submenu("Go To", ["Go to Declaration", "Go to Implementation", "Go to Type Declaration", ...(php ? ["Go to Super Method"] : []), "-", "Go to Line/Column…", "Go to Matching Bracket"]),
    ...submenu("Refactor", php
      ? ["Refactor This…", "-", "Rename", "Change Signature…", "-", "Extract Variable…", "Extract Constant…", "Extract Method…", "Introduce Field…", "Introduce Parameter…", "Inline…", "-", "Pull Members Up…", "Extract Interface…", "Move Class…", "Safe Delete…"]
      : ["Rename"]),
    ...(php ? action("Generate…") : []),
    "-",
    ...action("Comment with Line Comment"),
    ...action("Comment with Block Comment"),
    ...action("Reformat Code"),
    ...(php ? action("Optimize Imports") : []),
    ...submenu("Folding", ["Expand", "Collapse", "Expand Recursively", "Collapse Recursively", "-", "Expand All", "Collapse All", "Collapse Doc Comments", "-", "Fold Selection"]),
    "-",
    ...(file && isTestFile(model.uri.fsPath) ? [...action("Run Test at Cursor"), ...action("Debug Test at Cursor")] : []),
    ...(model.getLanguageId() === "markdown" ? action("Markdown Preview") : []),
    "-",
    ...(file ? submenu("Git", ["Annotate with Git Blame", "Show File History", "-", "Next Change", "Previous Change", "-", "Copy Remote URL"]) : []),
    ...(file ? [...action("Show Local History"), ...action("Compare with Clipboard")] : []),
    "-",
    ...action("Find Action"),
  ]);
}

/**
 * The context menu of the gutter left of the code: breakpoints, a bookmark, the line's change and tests, blame, and
 * the line's reference and link. False when the click wasn't in the gutter.
 */
function gutterMenu(ed: monaco.editor.ICodeEditor, e: monaco.editor.IEditorMouseEvent) {
  const T = monaco.editor.MouseTargetType;
  const model = ed.getModel();
  const line = e.target.position?.lineNumber;
  if (![T.GUTTER_GLYPH_MARGIN, T.GUTTER_LINE_NUMBERS, T.GUTTER_LINE_DECORATIONS].includes(e.target.type) || !line || model?.uri.scheme !== "file") return false;
  const path = model.uri.fsPath;
  const tests = testMenu(model, line);
  const changes = changeMenu(ed, line);
  showMenu(e.event.posx, e.event.posy, [
    ...tests,
    ...(tests.length ? ["-" as const] : []),
    ...breakpointMenu(path, line),
    "-",
    { label: hasBookmark(path, line) ? "Remove Bookmark" : "Add Bookmark", keys: "F3", run: () => toggleBookmark(path, line) },
    { label: "Bookmark with Mnemonic…", keys: "⌥F3", run: () => toggleMnemonic(path, line) },
    ...(hasCoverage(path) ? [{ label: "Show Tests Covering Line", run: () => (ed.setPosition({ lineNumber: line, column: 1 }), showTestsCoveringLine(ed)) }] : []),
    ...changes,
    ...(changes.length ? menuActions("Next Change", "Previous Change") : []),
    "-",
    ...blameMenu(ed, line, e.event.posx, e.event.posy),
    { label: isAnnotated(ed) ? "Close Git Blame Annotations" : "Annotate with Git Blame", run: () => annotate(ed) },
    { label: "Copy Reference", keys: symbolsFor(actions.find((a) => a.label === "Copy Reference")?.keys), run: () => copyReference(path, line) },
    { label: "Copy Remote URL", run: () => copyRemoteUrl(path, line) },
  ]);
  return true;
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
  if (isView(active)) return;
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

/** Opens the current Markdown file's preview in the next pane, splitting right when there's only one. */
function markdownPreview() {
  const md = activeFile();
  const model = tabs.get(md)?.model;
  if (model?.getLanguageId() !== "markdown") return status("Open a Markdown file to preview it.");
  const from = currentPane();
  const splitting = !hasMarkdownPreview(model) && panes.length < 2;
  if (splitting) split("row");
  else if (!hasMarkdownPreview(model)) focusPane(panes[(panes.indexOf(currentPane()) + 1) % panes.length]);
  showMarkdownPreview(model, { openFile: (path) => openFile(path) });
  // The split showed the file on both sides; the new pane keeps only the preview.
  if (splitting) leave(currentPane(), md), renderTabs();
  // Typing goes on in the file, beside its preview.
  if (currentPane() !== from) focusPane(from), editor.focus();
}

/** Puts a tab before another in a pane (or last, for null), taking it out of the pane it came from. */
function placeTab(path: string, from: Pane | null, to: Pane, before: string | null) {
  to.paths = to.paths.filter((p) => p !== path);
  const i = before ? to.paths.indexOf(before) : -1;
  to.paths.splice(i < 0 ? to.paths.length : i, 0, path);
  if (from !== to) {
    focusPane(to);
    openFile(path);
    if (from) leave(from, path);
  }
  saveSoon();
  renderTabs();
}

// Drag a tab within its bar to reorder it, onto another pane's tabs or editor to move it there,
// or onto the outer quarter of any pane's editor to split that pane with it.
let draggedTab: { path: string; from: Pane | null } | null = null;
type Edge = "left" | "right" | "top" | "bottom";
// A panel tab dragged in joins a pane like a tab from another pane; it gets its path on the drop.
const dragging = () => (draggedTab ??= draggingPanelTab() ? { path: "", from: null } : null);
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
  const target = dragging() && dropTarget(e);
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
  const target = dragging() && dropTarget(e);
  clearDropMarks();
  if (!target || !draggedTab) return;
  e.preventDefault();
  e.stopPropagation();
  const { from } = draggedTab;
  const path = draggedTab.path || addView(undockDragged()!);
  if (target.edge) {
    splitPane(target.pane, target.edge === "left" || target.edge === "right" ? "row" : "col", path, target.edge === "left" || target.edge === "top");
    if (from) leave(from, path);
    saveSoon();
    renderTabs();
  }
  // Dropped on itself, or on the middle of the pane it came from: nothing to do.
  else if (target.before !== path && (target.inBar || target.pane !== from)) placeTab(path, from, target.pane, target.before);
  draggedTab = null;
}, true);
addEventListener("dragend", () => ((draggedTab = null), clearDropMarks()));

/** Registers a panel tab moved into the editor, and returns its path. */
function addView(tab: PanelTab) {
  const path = `view:${++viewCount}`;
  views.set(path, tab);
  return path;
}

// With no files open, the editor is hidden, so a panel tab dropped on the empty area opens in the pane.
$("empty-editor").addEventListener("dragover", (e) => draggingPanelTab() && e.preventDefault());
$("empty-editor").addEventListener("drop", (e) => {
  if (!draggingPanelTab()) return;
  e.preventDefault();
  openFile(addView(undockDragged()!));
});

// Drag a panel tab from a pane back onto the panel's tab bar.
$("terminal-tabs").addEventListener("dragover", (e) => {
  if (!draggedTab?.path || !isView(draggedTab.path) || views.get(draggedTab.path)?.editorOnly) return;
  e.preventDefault();
  clearDropMarks();
  (e.target as HTMLElement).closest(".tab")?.classList.add("drop-before");
}, true);
$("terminal-tabs").addEventListener("drop", (e) => {
  if (!draggedTab?.path || !isView(draggedTab.path) || !draggedTab.from || views.get(draggedTab.path)?.editorOnly) return;
  e.preventDefault();
  e.stopPropagation();
  const { path, from } = draggedTab;
  draggedTab = null;
  const tab = views.get(path)!;
  views.delete(path);
  leave(from, path);
  dockBack(tab, dropIndex(e));
  saveSoon();
  renderTabs();
}, true);

const viewPath = (tab: PanelTab) => [...views].find(([, t]) => t === tab)?.[0];
initDocking({
  root: () => root || "/",
  openAt: (path, line, column = 1) => openAt(path, { lineNumber: line, column }),
  reveal(tab) {
    const path = viewPath(tab);
    const pane = path && panes.find((p) => p.paths.includes(path));
    if (pane) focusPane(pane), openFile(path);
  },
  // A view such as a diff opens as a tab in the focused pane, or shows where it already is.
  open(tab) {
    const path = viewPath(tab) ?? addView(tab);
    const pane = panes.find((p) => p.paths.includes(path));
    if (pane) focusPane(pane);
    openFile(path);
  },
  close(tab) {
    const path = viewPath(tab);
    const pane = path && panes.find((p) => p.paths.includes(path));
    if (pane) closeTab(path, pane);
  },
});

/** Shows a pane's panel tab over its editor, or hides them all when it shows a file. */
function showViews(pane: Pane, shown: string) {
  const host = pane.el.querySelector(".pane-editor")!;
  for (const [path, tab] of views) {
    if (path === shown) {
      if (tab.el.parentElement !== host) host.append(tab.el);
      tab.el.classList.add("docked");
      tab.el.hidden = false;
    } else if (host.contains(tab.el)) tab.el.hidden = true;
  }
}

// Each pane's left and top edges are splitters (src/splitter.ts) when another pane or group is there. A splitter
// resizes the pane or the group whose edge it is, `el`, against the one before it; nested panes on one edge share it.
function placeSashes() {
  for (const pane of panes)
    for (const row of [true, false]) {
      const handle = pane.el.querySelector<HTMLElement>(row ? ".pane-sash-x" : ".pane-sash-y")!;
      let el: HTMLElement | null = pane.el;
      while (el && !(el.previousElementSibling && el.parentElement!.classList.contains(row ? "row" : "col"))) el = el.parentElement!.closest<HTMLElement>(".split > *");
      handle.hidden = !el;
      if (!el) continue;
      const next = el;
      const prev = el.previousElementSibling as HTMLElement;
      const size = (e: HTMLElement) => e.getBoundingClientRect()[row ? "width" : "height"];
      splitter(handle, {
        target: prev,
        axis: row ? "x" : "y",
        edge: "end",
        label: row ? "Resize the panes left and right of it" : "Resize the panes above and below it",
        max: () => size(prev) + size(next) - 80,
        // Every sibling's flex-grow becomes its size in pixels, so the two being resized can trade pixels.
        // Measure them all before changing any, since each change reflows the rest.
        resize(px) {
          const siblings = [...next.parentElement!.children] as HTMLElement[];
          const sizes = siblings.map(size);
          siblings.forEach((child, i) => (child.style.flexGrow = String(sizes[i])));
          const total = sizes[siblings.indexOf(prev)] + sizes[siblings.indexOf(next)];
          prev.style.flexGrow = String(px);
          next.style.flexGrow = String(total - px);
        },
        onResize: () => saveSoon(),
      });
    }
}

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
/** Files the HTTP client's request tabs use, whose models stay when their editor tab closes. */
const held = new Set<string>();
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
  // Terminals go back to the panel; editor-only views, such as a diff, belong to the old project.
  for (const [path, tab] of [...views]) views.delete(path), retarget((p) => (p === path ? null : p)), tab.editorOnly ? closeDocked(tab) : dockBack(tab);
  // The old project's shells and servers belong to it; the new project's session reopens its own.
  closeTerminals();
  closeView($("history"));
  // Files loaded without a tab, such as those go to definition and find references read, belong to the old project.
  monaco.editor.getModels().filter((m) => m.uri.scheme === "file").forEach((m) => m.dispose());
  root = dir;
  forgetProblems();
  resetHttpClient();
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
  // The Filament tool window shows the project's panels, which a new project has its own of.
  $("filament-list").replaceChildren();
  if (currentView === "filament") void loadFilament();
  rememberProject(dir);
  await Promise.all([renderDir($("tree") as HTMLUListElement, dir), invoke("watch", { path: dir })]);
  try { localStorage.setItem("lastFolder", dir); } catch {}
  // Before anything reads the project's values, such as the breakpoints and the index exclusions.
  await openProjectState(dir);
  await configureTools(true);
  refreshGit();
  detectFormatters();
  loadBreakpoints();
  loadRunConfigurations();
  loadBookmarks();
  if (session) await restoreSession(session);
  restartServers();
  // Terminals reopen after the language servers have started: shells in their last folder, and
  // commands such as a dev server run again, each with its earlier output. Sessions from before terminals were saved
  // kept a count of shells.
  // The debugger listens again, and the profiling server starts again, if they ran when the project closed.
  if (session?.debugging) await startDebugging();
  if (session?.profiling) await loadProfiler().then((p) => p.startProfilingServer());
  const terminals: Restore[] = session?.terminals ?? Array.from({ length: session?.shells ?? 0 }, () => ({ title: "Terminal", cwd: root }));
  const found = terminals.length ? await invoke<boolean[]>("paths_exist", { paths: terminals.map((t) => t.cwd) }) : [];
  for (const [i, t] of terminals.entries()) await openTerminal(found[i] ? t.cwd : root, t.title, t.command, undefined, undefined, !!t.command, t.scrollback);
  const requests = await restoreHttpSession(session?.http);
  if ((terminals.length || session?.debugging || session?.profiling || requests) && !session?.panel) hidePanel();
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
  /** Whether the debugger listened, and whether the profiling server ran. */
  debugging?: boolean;
  profiling?: boolean;
  /** The HTTP client's request tabs, with their unsaved edits. */
  http?: HttpSession;
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
    debugging: isListening(),
    profiling: !!profiler?.profilingServerRunning(),
    http: httpSession(),
  };
  try {
    localStorage.setItem(sessionKey(), JSON.stringify(session));
  } catch {
    // Storage can be unavailable or full. When it's full, the terminals' output goes first; a lost session only costs
    // the open tabs.
    session.terminals = session.terminals?.map(({ scrollback: _, ...t }) => t);
    try { localStorage.setItem(sessionKey(), JSON.stringify(session)); } catch {}
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
const saveSoon = () => (clearTimeout(saveTimer), (saveTimer = setTimeout(saveSession, 500)));
window.addEventListener("beforeunload", saveSession);
// Quitting the app doesn't unload the page, and terminal output and panel tabs (such as the debugger's) change without
// editor events, so save within a second of them. Not debounced: a busy dev server would put the save off for good.
let panelSave: ReturnType<typeof setTimeout> | undefined;
onPanelChange(() => (panelSave ??= setTimeout(() => ((panelSave = undefined), saveSession()), 1000)));

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
  // The first launch downloads the tools, so this fails offline; the toast stays until you retry or dismiss it.
  startLsp(root, { ensureModel, markSaved, renamed, forget, status, openAt: (path, line) => openAt(path, { lineNumber: line, column: 1 }) }).catch((e) =>
    toast(`Couldn't start the language servers: ${e}`, { action: { label: "Retry", run: restartServers } }),
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
  requestFilesSaved();
}

/** Moves a file's tab after the file moved on disk, keeping its place and any unsaved edits. */
async function renamed(from: string, to: string) {
  const old = monaco.editor.getModel(monaco.Uri.file(from));
  const tab = tabs.get(from);
  if (!tab && held.has(from) && old) {
    // Only request tabs use it: they follow it to the new path.
    await ensureModel(to);
    held.delete(from), held.add(to);
    requestFileMoved(from, to);
    old.dispose();
    return forgetPath(from);
  }
  if (!tab) {
    old?.dispose();
    return forgetPath(from);
  }
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
  if (held.delete(from)) held.add(to), requestFileMoved(from, to);
  old?.dispose();
  forgetPath(from);
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
  [...held].filter(inside).forEach((p) => held.delete(p));
  monaco.editor.getModels().filter((m) => m.uri.scheme === "file" && inside(m.uri.fsPath)).forEach((m) => m.dispose());
  [...viewStates.keys()].filter(inside).forEach((p) => viewStates.delete(p));
  retarget((p) => (inside(p) ? null : p));
  forgetPath(path);
  renderTabs();
  markActiveInTree();
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
  $("encoding").textContent = model ? `${modelCharsets.get(model) ?? "UTF-8"} · ${crModels.has(model) ? "CR" : model.getEOL() === "\n" ? "LF" : "CRLF"}` : "";
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

/** Files with errors and the folders above them, which the tree and the tabs show in red. */
let errorPaths = new Set<string>();

/** Error and warning counts, across the project once the Problems panel has scanned it; clicking shows the panel. */
function updateProblems() {
  const { project, errors, warnings, errorFiles } = problemCounts();
  $("error-count").textContent = String(errors);
  $("warning-count").textContent = String(warnings);
  $("problems").title = project ? "Problems in the project (⌘6)" : "Problems in open files (⌘6)";
  document.querySelector<HTMLElement>('#activitybar [data-panel="problems"]')!.dataset.count = errors > 99 ? "99+" : errors ? String(errors) : "";
  errorPaths = withFolders(errorFiles, root);
  markErrors();
}

function markErrors() {
  for (const el of document.querySelectorAll<HTMLElement>("#tree .row[data-path], #editor .tab[data-path]"))
    if (el.classList.contains("has-error") !== errorPaths.has(el.dataset.path!)) el.classList.toggle("has-error");
}
$("problems").onclick = () => root && showProblems();
$("encoding").onclick = () => changeEncoding();

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
    localStorage.setItem("recentProjects", JSON.stringify([dir, ...recentProjects().filter((d) => d !== dir)].slice(0, limits.recentProjects)));
  } catch {}
}

function forgetProject(dir: string) {
  try {
    localStorage.setItem("recentProjects", JSON.stringify(recentProjects().filter((d) => d !== dir)));
  } catch {}
}

function projectItem(dir: string): Item {
  return { label: nameOf(dir), detail: dir.replace(/^\/Users\/[^/]+/, "~"), icon: "codicon-folder icon-folder", run: () => openFolder(dir) };
}

/** The project name in the title bar: switch to a recent project or open a folder. */
function projectMenu() {
  const items = [{ label: "Open Folder…", icon: "codicon-folder-opened", run: () => openFolder() }, ...recentProjects().filter((d) => d !== root).map(projectItem)];
  pick("Open a recent project", (q) => rank(q, items), 0, { value: "", anchor: $("project-menu") });
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
      li.tabIndex = 0;
      li.role = "button";
      li.onclick = () => openFolder(dir);
      li.onkeydown = (e) => void (e.key === "Enter" && openFolder(dir));
      li.oncontextmenu = (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: "Open", run: () => openFolder(dir) },
          { label: "Reveal in Finder", run: () => revealInFinder(dir) },
          "-",
          { label: "Remove from Recent Projects", run: () => (forgetProject(dir), showWelcome()) },
        ]);
      };
      return li;
    }),
  );
  $("welcome").hidden = false;
}

/** Draws a tree row: chevron (folders), icon, and name, indented by depth. */
function paintRow(row: HTMLElement, name: string, isDir: boolean) {
  const open = row.classList.contains("open");
  const icon = isDir ? folderIcon(name, open, row.classList.contains("excluded")) : fileIcon(name);
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
  const states = new Map(entries.map((e) => [e, treeState(relative(e.path))]));
  ul.replaceChildren(
    ...entries.filter((e) => states.get(e) !== "omit").map((e) => {
      const li = document.createElement("li");
      const row = document.createElement("div");
      row.className = `row ${e.is_dir ? "dir" : "file"}${states.get(e) ? ` ${states.get(e)}` : ""}`;
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
  markErrors();
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

/** Opens the folders above the current file in the project tree, and selects and scrolls to it. */
async function selectOpenedFile() {
  if (!activeFile() || !active.startsWith(`${root}/`)) return;
  showView("project");
  let dir = root;
  for (const part of relative(active).split("/").slice(0, -1)) {
    dir = `${dir}/${part}`;
    const row = document.querySelector<HTMLElement>(`#tree .row[data-path="${CSS.escape(dir)}"]`);
    if (!row) return;
    const open = openDirs.has(dir);
    openDirs.add(dir);
    row.classList.add("open");
    paintRow(row, part, true);
    // Awaited even when open, since an open folder's listing may still be loading.
    await renderDir(row.nextElementSibling as HTMLUListElement, dir, open);
  }
  saveSoon();
  const row = document.querySelector<HTMLElement>(`#tree .row[data-path="${CSS.escape(active)}"]`);
  if (!row) return;
  selectInTree(active);
  row.scrollIntoView({ block: "center" });
  row.focus({ preventScroll: true });
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
  if (!tabs.has(path) && !isView(path)) addTab(path, await ensureModel(path));
  if (!isView(path)) recent = [path, ...recent.filter((p) => p !== path)].slice(0, 30);
  showModel(path);
  renderTabs();
  if (isView(path)) focusTab(views.get(path)!);
  else editor.focus();
  markActiveInTree();
}

/** Closes a tab in one pane. The file stays open if another pane has it; otherwise it closes, saving first. */
async function closeTab(path: string, pane = currentPane()) {
  if (isView(path)) {
    const tab = views.get(path)!;
    views.delete(path);
    leave(pane, path);
    closeDocked(tab);
    saveSoon();
    return renderTabs();
  }
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
  // Request tabs still use the file: its model stays, with the text on disk.
  if (held.has(path)) {
    if (isDirty(tab)) {
      const text = await readText(path).catch(() => null);
      if (text !== null) tab.model.setValue(text);
    }
  } else tab.model.dispose();
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
/** Models whose file is saved with CR line endings, which Monaco doesn't have, so the editor shows them as LF. */
const crModels = new WeakSet<monaco.editor.ITextModel>();
/** `.editorconfig`'s end_of_line as Monaco's line ending. `cr` is left to `writeText`. */
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
  modelCharsets.set(model, charsetName(model.uri.fsPath, props));
  if (savesCr(model.uri.fsPath, props)) crModels.add(model);
  else crModels.delete(model);
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

/** `.editorconfig` charsets and encoding names for Change File Encoding. */
const ENCODINGS = ["utf-8", "utf-8-bom", "utf-16le", "utf-16be", "latin1", "windows-1252", "ISO-8859-15", "windows-1250", "windows-1251", "KOI8-R", "macintosh", "Shift_JIS", "EUC-JP", "EUC-KR", "GBK", "gb18030", "Big5"];

/** Reads the active file again in another encoding, or converts it to one and saves it. */
function changeEncoding() {
  const path = active;
  const tab = tabs.get(path);
  if (!tab) return;
  const name = (charset: string) => CHARSETS[charset] ?? charset;
  pick(`Encoding of ${relative(path)}`, (q) =>
    rank(
      q,
      ENCODINGS.map((charset) => ({
        label: name(charset),
        run: async () => {
          const how = await choose(`Reopen ${nameOf(path)} as ${name(charset)}, or convert its text to ${name(charset)}?`, ["Reopen", "Convert and Save", "Cancel"]);
          if (how === "Convert and Save") {
            setCharset(path, charset);
            tab.saved = -1;
            await saveFile(path);
          } else if (how === "Reopen") {
            if (isDirty(tab) && !(await confirm(`Reopen ${nameOf(path)}? Its unsaved changes are lost.`, "Reopen"))) return;
            setCharset(path, charset);
            const text = await readText(path).catch((e) => (setCharset(path, undefined), showError(`Couldn't reopen ${relative(path)}`, e), null));
            if (text === null) return;
            tab.model.setValue(text);
            tab.saved = tab.model.getAlternativeVersionId();
          } else return;
          showDirty(path);
          applyEditorConfig(tab.model);
        },
      })),
    ),
  );
}

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
  if (formatOnSave(tab.model.getLanguageId())) await formatModel(tab.model);
  await applySaveRules(tab.model);
  const text = tab.model.getValue();
  try {
    await writeText(path, text);
  } catch (e) {
    return showError(`Couldn't save ${relative(path)}`, e);
  }
  markSaved(path);
  didSave(tab.model);
  afterSave(path, text);
  recordVersion(path, text);
  settingsFileSaved(path);
}

/** Saves every tab with unsaved changes, as ⌘S does in PhpStorm. */
const saveAll = () => Promise.all([...tabs.keys()].map(saveFile));

/**
 * Saves unsaved edits (with auto-save on) or asks about them, as closing a tab does, before the app restarts or quits,
 * and saves the session. False when you cancel, or a file couldn't be saved.
 */
async function readyToLeave(verb: "restarting" | "quitting") {
  if ([...tabs.values()].some(isDirty)) {
    const choice = settings.autoSave ? "Save" : await choose(`Save your changes before ${verb}?`, ["Save", "Don't Save", "Cancel"]);
    if (choice === "Cancel" || choice === null) return false;
    if (choice === "Save" && (await saveAll(), [...tabs.values()].some(isDirty))) return false;
  }
  saveSession();
  return true;
}

/** ⌘Q and the window's close button: the window closes, and with it the app, only once edits are safe. */
const quit = async () => (await readyToLeave("quitting")) && getCurrentWindow().destroy();
getCurrentWindow().onCloseRequested(async (e) => {
  if (!(await readyToLeave("quitting"))) e.preventDefault();
});

// Update download progress, and Restart Now after an update installs.
listen<string>("update-progress", (e) => status(e.payload, "update:progress"));
listen<string>("tools-progress", (e) => status(e.payload, "tools:progress"));
listen<string>("tools-failed", (e) => toast(e.payload));
listen("update-restart", async () => (await readyToLeave("restarting")) && invoke("restart"));

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
    // Two files with one name get their folder beside it, so the tabs tell them apart.
    const names = new Map<string, number>();
    for (const p of pane.paths) if (!views.has(p)) names.set(nameOf(p), (names.get(nameOf(p)) ?? 0) + 1);
    pane.bar.replaceChildren(
      ...pane.paths.map((path) => {
        const tab = tabs.get(path);
        const view = views.get(path);
        const el = document.createElement("div");
        el.className = `tab${path === shown ? " active" : ""}${tab && isDirty(tab) ? " dirty" : ""}`;
        el.dataset.path = path;
        el.role = "tab";
        el.title = view ? view.title : relative(path);
        const icon = view ? { codicon: tabIcon(view), color: "" } : fileIcon(nameOf(path));
        el.innerHTML = `<span class="file-icon codicon codicon-${icon.codicon} ${icon.color}"></span><span class="name"></span>`;
        el.querySelector(".name")!.textContent = view ? view.title : nameOf(path);
        if (!view && names.get(nameOf(path))! > 1) el.querySelector(".name")!.after(Object.assign(document.createElement("span"), { className: "tab-dir", textContent: nameOf(relative(path).replace(/\/[^/]*$/, "") || ".") }));
        el.onclick = () => (focusPane(pane), openFile(path));
        el.onauxclick = (e) => e.button === 1 && closeTab(path, pane);
        el.oncontextmenu = (e) => {
          e.preventDefault();
          const closeAll = async (keep?: string) => {
            for (const p of pane.paths.filter((p) => p !== keep)) await closeTab(p, pane);
          };
          showMenu(e.clientX, e.clientY, [
            { label: "Close", run: () => closeTab(path, pane) },
            { label: "Close Others", run: () => closeAll(path) },
            { label: "Close All", run: () => closeAll() },
            { label: "Close Tabs to the Right", run: async () => { for (const p of pane.paths.slice(pane.paths.indexOf(path) + 1)) await closeTab(p, pane); } },
            ...(view?.editorOnly
              ? []
              : view
              ? ["-" as const, { label: "Move to Panel", run: () => (views.delete(path), leave(pane, path), dockBack(view), saveSoon(), renderTabs()) }]
              : [
                  "-" as const,
                  { label: "Split Right", run: () => (focusPane(pane), openFile(path).then(() => split("row"))) },
                  { label: "Split Down", run: () => (focusPane(pane), openFile(path).then(() => split("col"))) },
                  ...(tab?.model.getLanguageId() === "markdown" ? [{ label: "Open Preview", run: () => (focusPane(pane), openFile(path).then(markdownPreview)) }] : []),
                  "-" as const,
                  { label: "Copy Path", run: () => copyPath(path) },
                  { label: "Copy Relative Path", run: () => copyPath(path, true) },
                  { label: "Reveal in Finder", run: () => revealInFinder(path) },
                  { label: "Show Local History", run: () => showLocalHistory(path) },
                ]),
          ]);
        };
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
    // A Markdown file gets a preview button at the end of its pane's tabs, as PhpStorm's editor toolbar has.
    if (tabs.get(shown)?.model.getLanguageId() === "markdown")
      pane.bar.append(Object.assign(iconButton("open-preview", "Open Preview", () => (focusPane(pane), markdownPreview())), { className: "icon-button tab-bar-action" }));
    pane.bar.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    showViews(pane, shown);
  }
  placeSashes();
  showBreadcrumbs($("path"), activeFile() ? relative(active) : "", editor);
  followEditor(activeFile(), editor.getPosition());
  $("empty-editor").hidden = tabs.size + views.size > 0 || !root;
  updateProblems();
  $("editor").style.display = tabs.size + views.size ? "" : "none";
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
          await recordVersion(path, model.getValue(), "before external");
          model.setValue(text);
          if (tab) tab.saved = model.getAlternativeVersionId();
        }
      }
    }
    // Files without a model weren't open, so the loop above kept no version of them.
    recordExternalChanges([...paths].filter((p) => !monaco.editor.getModel(monaco.Uri.file(p))));
    if (paths.has(`${root}/composer.lock`)) checkComposerLock(root);
    projectFilesChanged(paths);
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
    httpFilesChanged([...paths]);
    filamentFilesChanged([...paths]);
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
    // A link's `#L12` fragment gives a selection without an end, which is a position.
    const s = selection as Partial<monaco.IRange> | undefined;
    openAt(resource.fsPath, s?.startLineNumber !== undefined && s.endLineNumber === undefined ? { lineNumber: s.startLineNumber, column: s.startColumn ?? 1 } : selection);
    return true;
  },
});

// ---- Navigation and search ----

const fileItem = (path: string): Item => {
  const icon = fileIcon(nameOf(path));
  return { label: relative(path), icon: `codicon-${icon.codicon} ${icon.color}`, run: () => openFile(path) };
};

/** Go to File lists project files. Pressed again while open, it adds files that .gitignore excludes, such as vendor. */
function goToFile() {
  if (!root) return;
  const open = document.querySelector<HTMLInputElement>("#palette input");
  const all = open?.placeholder === "Go to file";
  const query = all ? open.value : "";
  // The picker opens at once and fills in when the project walk returns.
  const files = invoke<string[]>("list_files", { root, all }).then((list) => list.map((f) => fileItem(`${root}/${f}`)));
  pick(all ? "Go to file, including ignored files such as vendor" : "Go to file", async (q) => rank(q, await files), 0, all ? { value: query } : undefined);
}

// Codicons for LSP symbol kinds, by kind number; other kinds show as a generic symbol.
const kindIcons: Record<number, string> = {
  5: "symbol-class", 6: "symbol-method", 7: "symbol-property", 8: "symbol-field", 9: "symbol-method", 10: "symbol-enum",
  11: "symbol-interface", 12: "symbol-function", 13: "symbol-variable", 14: "symbol-constant", 22: "symbol-enum-member", 23: "symbol-structure",
};

async function symbolItems(query: string, typesOnly: boolean): Promise<Item[]> {
  if (!query.trim()) return [];
  const symbols = (await workspaceSymbols(query)).filter(
    // Symbols in a PHP archive's stubs can't be opened.
    (s) => (!typesOnly || TYPE_KINDS.includes(s.kind)) && !s.path.includes(".phar/"),
  );
  const items = symbols.map((s) => ({
    // A method as `Class::method`, so a query can name the class too.
    label: s.kind === 6 && s.container ? `${s.container.split("\\").pop()}::${s.name}` : s.name,
    icon: `codicon-${kindIcons[s.kind] ?? "symbol-misc"} symbol-kind-${s.kind}`,
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
  const clipboard = await invoke<string>("run_capture", { cwd: root || "/", program: "pbpaste", args: [], input: null }).catch((e) => (showError("Can't read the clipboard", e), null));
  if (clipboard === null) return;
  showDiff(relative(active), clipboard, editor.getValue(), "Clipboard ↔ Current file");
}

function compareWithFile() {
  if (!active || !root) return;
  const current = active;
  const list = invoke<string[]>("list_files", { root });
  pick(`Compare ${nameOf(current)} with`, async (q) =>
    rank(q, (await list).filter((f) => `${root}/${f}` !== current).map((f) => ({
      ...fileItem(`${root}/${f}`),
      run: async () => showDiff(relative(current), await invoke<string>("read_file", { path: `${root}/${f}` }), tabs.get(current)?.model.getValue() ?? "", `${f} ↔ ${relative(current)}`),
    }))),
  );
}

const recentFiles = () => pick("Recent files", (q) => rank(q, recent.filter((p) => p !== active).map(fileItem)));

// ---- Actions and keyboard shortcuts ----

/** Keys use `Ctrl`, `Alt`, `Shift`, and `Meta` joined with `+`, then the key from `KeyboardEvent.code`. */
/** A shortcut whose `when` returns false passes the key on, so Monaco's own binding runs. */
type Action = { label: string; keys?: string; run(): unknown; editorOnly?: boolean; when?: () => boolean };

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
  { label: "Quit Tusk", keys: "Meta+Q", run: quit },
  // ⌘N generates code in a PHP editor, as in PhpStorm, and creates a file everywhere else.
  { label: "Generate…", keys: "Meta+N", run: () => generate(editor), editorOnly: true, when: () => editor.getModel()?.getLanguageId() === "php" },
  { label: "New File…", keys: "Meta+N", run: () => root && newFile() },
  { label: "New Folder…", run: () => root && newFolder() },
  { label: "Rename File…", run: () => rename() },
  { label: "Move File to Trash", run: () => remove() },
  { label: "Copy Path", keys: "Meta+Shift+C", run: () => copyPath() },
  { label: "Copy Reference", keys: "Alt+Shift+Meta+C", run: () => (activeFile() ? copyReference(active, editor.getPosition()?.lineNumber ?? 1) : status("Open a file to copy a reference to its line.")) },
  { label: "Reveal in Finder", run: () => revealInFinder() },
  { label: "Select Opened File in Project", keys: "Alt+F1", run: selectOpenedFile },
  editorAction("Go to Declaration", "Meta+B", "editor.action.revealDefinition"),
  editorAction("Go to Implementation", "Alt+Meta+B", "editor.action.goToImplementation"),
  editorAction("Go to Type Declaration", "Ctrl+Shift+B", "editor.action.goToTypeDefinition"),
  { label: "Go to Super Method", keys: "Meta+U", run: () => goToSuperMethod(editor), editorOnly: true },
  editorAction("Find Usages", "Alt+F7", "editor.action.goToReferences"),
  { label: "Safe Delete…", keys: "Meta+Delete", run: () => safeDelete(editor), editorOnly: true },
  { label: "Inline…", keys: "Alt+Meta+N", run: () => inline(editor), editorOnly: true },
  { label: "Change Signature…", keys: "Meta+F6", run: () => changeSignature(editor), editorOnly: true },
  { label: "Extract Variable…", keys: "Alt+Meta+V", run: () => extractVariable(editor), editorOnly: true },
  { label: "Extract Constant…", keys: "Alt+Meta+C", run: () => extractConstant(editor), editorOnly: true },
  { label: "Extract Method…", keys: "Alt+Meta+M", run: () => extractMethod(editor), editorOnly: true },
  { label: "Introduce Field…", keys: "Alt+Meta+F", run: () => introduceField(editor), editorOnly: true },
  { label: "Introduce Parameter…", keys: "Alt+Meta+P", run: () => introduceParameter(editor), editorOnly: true },
  { label: "Refactor This…", keys: "Ctrl+T", run: () => refactorThis(), editorOnly: true },
  { label: "Move Class…", keys: "F6", run: () => moveClass(editor), editorOnly: true, when: () => editor.getModel()?.getLanguageId() === "php" },
  { label: "Pull Members Up…", run: () => pullMembersUp(editor), editorOnly: true, when: () => editor.getModel()?.getLanguageId() === "php" },
  { label: "Extract Interface…", run: () => extractInterface(editor), editorOnly: true, when: () => editor.getModel()?.getLanguageId() === "php" },
  { label: "Type Hierarchy", keys: "Ctrl+H", run: () => showTypeHierarchy(editor), editorOnly: true },
  { label: "Call Hierarchy", keys: "Ctrl+Alt+H", run: () => showCallHierarchy(editor), editorOnly: true },
  editorAction("Rename", "Shift+F6", "editor.action.rename"),
  editorAction("Next Problem", "F2", "editor.action.marker.next"),
  editorAction("Previous Problem", "Shift+F2", "editor.action.marker.prev"),
  editorAction("Next Problem in Files", "", "editor.action.marker.nextInFiles"),
  editorAction("Previous Problem in Files", "", "editor.action.marker.prevInFiles"),
  editorAction("Show Context Actions", "Alt+Enter", "editor.action.quickFix"),
  editorAction("Fix All Safe Problems in File", "", "editor.action.fixAll"),
  editorAction("Parameter Info", "Meta+P", "editor.action.triggerParameterHints"),
  editorAction("Quick Documentation", "F1", "editor.action.showHover"),
  editorAction("Extend Selection", "Alt+ArrowUp", "editor.action.smartSelect.expand"),
  editorAction("Shrink Selection", "Alt+ArrowDown", "editor.action.smartSelect.shrink"),
  editorAction("Move Line Up", "Alt+Shift+ArrowUp", "editor.action.moveLinesUpAction"),
  editorAction("Move Line Down", "Alt+Shift+ArrowDown", "editor.action.moveLinesDownAction"),
  editorAction("Duplicate Line", "Meta+D", "editor.action.copyLinesDownAction"),
  editorAction("Delete Line", "Meta+Backspace", "editor.action.deleteLines"),
  editorAction("Optimize Imports", "Ctrl+Alt+O", "editor.action.organizeImports"),
  // Before the editor's ⌘⌥↓ (Add Caret Below), which it takes while the Find view shows, as in PhpStorm.
  { label: "Next Occurrence in Files", keys: "Meta+Alt+ArrowDown", run: () => nextMatch(1), when: () => !$("view-search").hidden },
  { label: "Previous Occurrence in Files", keys: "Meta+Alt+ArrowUp", run: () => nextMatch(-1), when: () => !$("view-search").hidden },
  ...EDITOR_COMMANDS.map(([label, id, keys]) => editorAction(label, keys, id)),
  { label: "Toggle Case", keys: "Meta+Shift+U", run: toggleCase, editorOnly: true },
  { label: "Save All", keys: "Meta+S", run: () => saveFocusedRequest() || saveAll() },
  { label: "Settings…", keys: "Meta+Comma", run: openSettings },
  { label: "Check for Updates…", run: () => invoke("check_update") },
  { label: "Keymap…", run: () => editKeymap() },
  {
    label: "Keyboard Shortcuts",
    run: () => pick("Keyboard shortcuts: every action with a shortcut", (q) => rank(q, actionItems().filter((a) => a.detail))),
  },
  { label: "Color Theme…", keys: "Ctrl+Backquote", run: pickTheme },
  { label: "Import Color Theme…", run: importTheme },
  { label: "Remove Imported Color Theme…", run: removeTheme },
  { label: "Close Tab", keys: "Meta+W", run: () => closeFocusedRequest() || closeFocusedPanelTab() || closeTab(active) },
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
  { label: "Push…", keys: "Meta+Shift+K", run: () => root && push() },
  { label: "Update Project", keys: "Meta+T", run: () => root && updateProject() },
  { label: "Branches…", run: () => root && branches() },
  { label: "Fetch", run: () => root && fetchAll() },
  { label: "Initialize Repository", run: () => initRepository() },
  { label: "Stash Changes…", run: stashChanges },
  { label: "Interactive Rebase…", run: () => root && chooseRebaseBase() },
  { label: "Resolve Conflicts in Merge Tool", run: () => active && openMerge(relative(active)) },
  { label: "Stage Selected Changes (in a diff)", run: stageSelected },
  { label: "Stashes…", run: () => root && showStashes() },
  { label: "Worktrees…", run: worktrees },
  { label: "Annotate with Git Blame", run: () => annotate(editor) },
  { label: "Next Change", keys: "Ctrl+Alt+Shift+ArrowDown", run: () => goToChange(editor, 1), editorOnly: true },
  { label: "Previous Change", keys: "Ctrl+Alt+Shift+ArrowUp", run: () => goToChange(editor, -1), editorOnly: true },
  {
    label: "Copy Remote URL",
    run: () => {
      const s = editor.getSelection();
      if (active && s) copyRemoteUrl(active, s.startLineNumber, s.endColumn === 1 && s.endLineNumber > s.startLineNumber ? s.endLineNumber - 1 : s.endLineNumber);
    },
    editorOnly: true,
  },
  { label: "Split Right", keys: "Meta+Backslash", run: () => split("row") },
  { label: "Split Down", keys: "Meta+Shift+Backslash", run: () => split("col") },
  { label: "Move Tab to Next Pane", run: moveTabToNextPane },
  { label: "Markdown Preview", run: markdownPreview },
  { label: "Unsplit", run: () => unsplit() },
  { label: "Change File Encoding…", run: () => changeEncoding() },
  { label: "Git Log", keys: "Meta+9", run: () => showLog() },
  { label: "Problems", keys: "Meta+6", run: () => root && showProblems() },
  { label: "Scan Project for Problems", run: () => root && (showProblems(), scanProject()) },
  { label: "Run PHPStan on Project", run: () => root && runPhpStan() },
  { label: "Show File History", run: () => active && showFileHistory(active) },
  { label: "Show Local History", run: () => active && showLocalHistory(active) },
  { label: "Show Project Local History", run: () => root && showLocalHistory(root, true) },
  { label: "Put Label…", run: () => putLabel() },
  { label: "Local History: Deleted Files…", run: showDeletedFiles },
  { label: "Restart Language Servers", run: restartServers },
  { label: "Reindex Project", run: () => reindex() },
  { label: "Index Exclusions…", run: () => root && manageExclusions(root) },
  { label: "Choose PHP Interpreter…", run: () => root && choosePhpInterpreter() },
  { label: "Hidden Files and Folders…", run: () => root && editTreeHidden() },
  { label: "Show Hidden Files", run: toggleHiddenFiles },
  { label: "PHP Analysis Settings…", run: () => openSettings("php analysis") },
  { label: "Share Project Settings in tusk.json…", run: chooseSharedState },
  { label: "Toggle AI Completion", run: () => updateSetting("aiCompletion", !settings.aiCompletion) },
  { label: "Toggle Inline Problems", run: () => updateSetting("inlineProblems", !settings.inlineProblems) },
  { label: "Pull Requests", run: () => showView("prs") },
  { label: "Database", run: () => showView("database") },
  { label: "Database: Switch Connection…", run: () => (showView("database"), chooseConnection()) },
  { label: "Database: Connect over SSH…", run: () => (showView("database"), connectOverSsh()) },
  { label: "Database: Data Sources…", run: () => root && dataSources() },
  { label: "Database: Query History…", run: () => root && showHistory() },
  { label: "Database: Cancel Query", run: cancelQueries },
  { label: "Database: Open Table", run: () => (selectedTable() ? openTable(selectedTable()!) : status("Select a table in the Database tool first.")) },
  { label: "Database: Copy Table Name", run: () => (selectedTable() ? copyName(selectedTable()!) : status("Select a table in the Database tool first.")) },
  { label: "Database: Generate SELECT", run: () => generateSql("select") },
  { label: "Database: Generate INSERT", run: () => generateSql("insert") },
  { label: "Composer", run: () => showView("composer") },
  { label: "Filament", run: () => showView("filament") },
  { label: "Filament: Open Resource in Designer…", run: () => root && openResourcePicker() },
  { label: "Filament: New Resource…", run: () => root && newResource() },
  { label: "Filament: Generate Resource Tests…", run: () => root && void import("./resourcetests").then((m) => m.resourceTestsPicker()) },
  { label: "Filament: Install Filament", run: () => root && installFilament() },
  { label: "Laravel: New Model…", run: () => root && void import("./modeldesigner").then((m) => m.openNewModel()) },
  { label: "Laravel: Check the App (Boot and Tests)", run: () => root && void import("./filamentview").then((m) => m.checkApp()) },
  { label: "Filament: New Page…", run: () => root && void import("./filamentview").then((m) => m.newPagePicker()) },
  { label: "Filament: Dashboard…", run: () => root && void import("./filamentview").then((m) => m.openDashboardPicker()) },
  { label: "Filament: Navigation…", run: () => root && void import("./filamentview").then((m) => m.openNavigationPicker()) },
  { label: "Filament: Panel Settings…", run: () => root && void import("./filamentview").then((m) => m.openPanelPicker()) },
  { label: "Laravel: Environment Settings…", run: () => root && void import("./envsettings").then((m) => m.openEnvSettings()) },
  { label: "Laravel: Add Sample Records…", run: () => root && void import("./sampledata").then((m) => m.sampleRecordsPicker()) },
  { label: "Laravel: Model Access…", run: () => root && void import("./filamentview").then((m) => m.openAccessPicker()) },
  { label: "Laravel: Automations…", run: () => root && void import("./automationsview").then((m) => m.openAutomationsPicker()) },
  { label: "Laravel: Record History…", run: () => root && void import("./historyview").then((m) => m.openHistoryPicker()) },
  { label: "Laravel: New Enum…", run: () => root && void import("./enumdesigner").then((m) => m.openNewEnum()) },
  { label: "Laravel: Scheduled Tasks…", run: () => root && void import("./scheduledesigner").then((m) => m.openSchedule()) },
  { label: "Laravel: New Notification…", run: () => root && void import("./notifydesigner").then((m) => m.newNotification({ x: innerWidth / 2 - 160, y: 120 })) },
  { label: "Laravel: Open Notification in Designer…", run: () => root && void import("./notifydesigner").then((m) => m.openNotificationPicker()) },
  { label: "Open in Enum Designer", run: () => active && void import("./enumdesigner").then((m) => m.openEnumDesigner(active)), when: () => /\/app\/.*Enums?\/\w+\.php$|Enum\.php$/.test(active) },
  { label: "Laravel: New Element…", run: () => root && newLaravelElement() },
  { label: "Laravel: New Project…", run: () => newLaravelProject() },
  { label: "Laravel: Open Model in Designer…", run: () => root && openModelPicker() },
  { label: "Laravel: Open Settings in Designer…", run: () => root && void import("./settingsdesigner").then((m) => m.openSettingsPicker()) },
  { label: "Filament: New Settings Page…", run: () => root && void import("./settingsdesigner").then((m) => m.newSettingsPagePicker()) },
  { label: "Open in Designer", run: () => active && openFileInDesigner(active), when: () => /(Resource|RelationManager|Form|Table|Infolist)\.php$/.test(active) },
  { label: "Composer: Require Package…", run: () => requirePackage() },
  { label: "Composer: Update All", run: () => root && updateAll() },
  { ...editorAction("Execute Query", "Meta+Enter", "phpEditor.runSql"), when: () => ["sql", "redis"].includes(editor.getModel()?.getLanguageId() ?? "") },
  { label: "Execute All Statements", run: () => (editor.focus(), editor.trigger("keyboard", "phpEditor.runAllSql", {})), editorOnly: true, when: () => ["sql", "redis"].includes(editor.getModel()?.getLanguageId() ?? "") },
  { ...editorAction("Send HTTP Request", "Meta+Enter", "phpEditor.sendHttpAtCursor"), when: () => editor.getModel()?.getLanguageId() === "http" },
  { label: "HTTP Client", run: () => showView("http") },
  { label: "HTTP Client: New Request…", run: () => root && newRequestInteractive() },
  { label: "HTTP Client: Sync with Laravel Routes…", run: () => root && syncRequestsWithRoutes() },
  { label: "HTTP Client: Global Variables…", run: () => root && showGlobals() },
  { label: "HTTP Client: Clear Cookies", run: () => root && clearCookies() },
  { label: "HTTP Client: Detect App Address", run: () => root && detectAppAddress(active ?? "") },
  { label: "HTTP Client: Edit Environments", run: () => root && editEnvironments(/\.(http|rest)$/.test(active ?? "") ? active : "") },
  { label: "Go to Request…", keys: "Alt+Shift+Meta+O", run: () => root && goToRequest() },
  { label: "HTTP Client: Import…", run: () => root && importRequests() },
  { label: "HTTP Client: Export to OpenAPI…", run: () => root && exportOpenApi() },
  { label: "HTTP Client: Run All Requests in Project", run: () => root && runAllRequests() },
  { label: "Select HTTP Environment…", run: () => root && selectEnvironment(active ?? "") },
  { label: "Open Query Console", keys: "Meta+Shift+F10", run: () => root && openConsole() },
  { label: "Create Pull Request…", run: () => root && createPullRequest() },
  { label: "Show Project", keys: "Meta+1", run: () => showView("project") },
  { label: "Run", keys: "Ctrl+R", run: () => root && runSelected() },
  { label: "Debug", keys: "Ctrl+D", run: () => root && runSelected("debug") },
  { label: "Run with Coverage", run: () => root && runSelected("coverage") },
  { label: "Run…", keys: "Ctrl+Alt+R", run: () => root && chooseAndRun() },
  { label: "Debug…", keys: "Ctrl+Alt+D", run: () => root && chooseAndRun("debug") },
  { label: "Edit Configurations…", run: () => root && editConfigurations() },
  { label: "Save Temporary Configuration", run: () => root && saveTemporary() },
  // ⌘F2 stops a run while one runs, and otherwise the debugger.
  { label: "Stop", keys: "Meta+F2", run: () => stopRun(), when: isRunning },
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
  { label: "Edit Breakpoint…", run: () => active && editBreakpoint(active, editor.getPosition()?.lineNumber ?? 1), editorOnly: true },
  { label: "View Breakpoints…", keys: "Meta+Shift+F8", run: () => (active ? showBreakpoints(active, editor.getPosition()?.lineNumber) : showBreakpoints()) },
  { label: "Toggle Pause on Exceptions", run: togglePauseOnExceptions },
  { label: "Pause on Exception Classes…", run: () => root && setExceptionClasses() },
  { label: "Pause on Exceptions Options…", run: () => root && exceptionOptions() },
  { label: "Choose Xdebug Port…", run: choosePort },
  { label: "Set Server Paths for Debugging…", run: () => root && setServerRoot() },
  { label: "Start Listening for PHP Debug Connections", run: () => root && startDebugging() },
  { label: "Stop Debugging", keys: "Meta+F2", run: stopDebugging },
  { label: "Resume Program", keys: "F9", run: () => isPaused() && resume(), when: isPaused },
  { label: "Step Over", keys: "F8", run: () => isPaused() && stepOver(), when: isPaused },
  { label: "Step Into", keys: "F7", run: () => isPaused() && stepInto(), when: isPaused },
  { label: "Step Out", keys: "Shift+F8", run: () => isPaused() && stepOut(), when: isPaused },
  { label: "Debug Panel", run: showDebugPanel },
  {
    label: "Start Debug Server (php artisan serve with Xdebug)",
    run: async () => {
      if (!root) return;
      await startDebugging();
      // Laravel's serve command passes XDEBUG_MODE and XDEBUG_SESSION to the PHP server it starts.
      openTerminal(root, "Debug server", ["/usr/bin/env", ...xdebugEnv(), "php", "artisan", "serve"], undefined, undefined, true);
    },
  },
  { label: "Rerun", run: () => root && rerun() },
  { label: "TODO", run: () => showView("todo") },
  { label: "Toggle Bookmark", keys: "F3", run: () => active && toggleBookmark(active, editor.getPosition()?.lineNumber ?? 1), editorOnly: true },
  { label: "Toggle Bookmark with Mnemonic…", keys: "Alt+F3", run: () => active && toggleMnemonic(active, editor.getPosition()?.lineNumber ?? 1), editorOnly: true },
  { label: "Show Bookmarks", keys: "Meta+F3", run: showBookmarks },
  ...[..."123456789"].map((n) => ({ label: `Go to Bookmark ${n}`, keys: `Ctrl+${n}`, run: () => goToMnemonic(n) })),
  { label: "Edit Snippets (Live Templates)", run: () => editSnippets(openFile) },
  { label: "Laravel Tinker", run: () => root && tinker() },
  { label: "Choose Docker Service for Commands…", run: () => root && chooseDockerService() },
  { label: "Routes", run: () => root && showRoutes() },
  { label: "Compare with Clipboard", run: compareWithClipboard },
  { label: "Compare with File…", run: compareWithFile },
  { label: "Terminal", keys: "Alt+F12", run: () => toggleTerminal(root || "/") },
  { label: "New Terminal", run: () => openTerminal(root || "/") },
  { label: "Toggle Full-Width Bottom Panel", run: togglePanelFullWidth },
  { label: "Maximize Bottom Panel", keys: "Shift+Meta+Quote", run: togglePanelMaximized },
  // ⇧⎋ hides the panel while you work in it, as PhpStorm's Hide Active Tool Window; elsewhere it's the editor's.
  { label: "Hide Bottom Panel", keys: "Shift+Escape", run: hidePanel, when: () => panelShown() && !!document.activeElement?.closest("#panel") },
  // ⌘F finds in the terminal while one has focus, and in the editor otherwise.
  { label: "Find in Terminal", keys: "Meta+F", run: () => findInTerminal() || toast("Open a terminal to find in it.", { kind: "info", timeout: 4000 }), when: terminalFocused },
  { label: "Rename Terminal Tab…", run: () => renameTerminal() },
  { label: "Reformat Code", keys: "Alt+Meta+L", run: () => editor.getAction("editor.action.formatDocument")?.run() },
  { label: "Formatters…", run: () => root && openFormatters() },
];

/** Copies `path:line`, relative to the project, as PhpStorm's Copy Reference does for a line. */
function copyReference(path: string, line: number) {
  const reference = `${relative(path)}:${line}`;
  navigator.clipboard.writeText(reference).then(() => status(`Copied ${reference}`), (e) => status(`Couldn't copy the reference: ${e}`));
}

/** ⌘⇧U: upper case, or lower case when the selection (or the word at the caret) is already upper case. */
function toggleCase() {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) return;
  const text = selection.isEmpty() ? (model.getWordAtPosition(selection.getPosition())?.word ?? "") : model.getValueInRange(selection);
  editor.focus();
  editor.trigger("keyboard", text === text.toUpperCase() ? "editor.action.transformToLowercase" : "editor.action.transformToUppercase", {});
}

/** Picks the Compose service that runs tests, Artisan, and Tinker, or this Mac. Sail projects use Sail. */
async function chooseDockerService() {
  forgetComposeServices(root);
  const services = await composeServices(root);
  if (!services.length) return status("No Docker Compose service mounts this project, so commands run on this Mac.");
  const current = (await composeService(root))?.name ?? "";
  pick("Run tests, Artisan, and Tinker in", () => [
    ...services.map((s) => ({ label: s.name, detail: `${s.workdir}${s.name === current ? " · current" : ""}`, icon: "codicon-vm", run: () => chooseService(root, s.name) })),
    { label: "This Mac", detail: current ? "" : "current", icon: "codicon-device-desktop", run: () => chooseService(root, "") },
    shareItem("dockerService", "Docker service choice"),
  ]);
}

// Keys shown as the Mac draws them.
const KEY_SYMBOLS: Record<string, string> = {
  Delete: "⌦", Backspace: "⌫", Enter: "⏎", Escape: "⎋", Tab: "⇥", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Space: "Space",
  Slash: "/", Backslash: "\\", Equal: "=", Minus: "-", BracketLeft: "[", BracketRight: "]", Comma: ",", Period: ".", Backquote: "`", Semicolon: ";", Quote: "'",
};
const symbolsFor = (keys?: string) =>
  keys
    ?.replace(/^(\w+) \1$/, "$1+$1+")
    .replace(/Ctrl\+/g, "⌃")
    .replace(/Alt\+/g, "⌥")
    .replace(/Shift\+/g, "⇧")
    .replace(/Meta\+/g, "⌘")
    .replace(/[A-Z][a-z]+[A-Za-z]*$/, (key) => KEY_SYMBOLS[key] ?? key);
const actionItems = () => actions.map((a) => ({ label: a.label, detail: symbolsFor(a.keys), run: a.run }));

const findAction = () => pick("Find action", (q) => rank(q, actionItems()));

/** ⌃T: the refactorings that apply at the caret or selection, as PhpStorm's Refactor This lists them. */
async function refactorThis() {
  const { names, more } = await refactorings(editor);
  const items = [...names.flatMap((n) => actionItems().filter((a) => a.label === n)), ...more];
  pickAtCaret(editor, "Refactor This", (q) => rank(q, items));
}

// ---- Keymap ----

// Shortcuts you change are saved as overrides of these defaults, by action name.
const defaultKeys = new Map(actions.map((a) => [a.label, a.keys]));
onSettings((s) =>
  actions.forEach((a) => {
    const custom = s.keymap[a.label];
    a.keys = custom === undefined ? defaultKeys.get(a.label) : custom || undefined;
  }),
);
// The menu bar shows the shortcuts, so rebuild it when they change.
let menuKeymap = "";
onSettings((s) => {
  if (JSON.stringify(s.keymap) !== menuKeymap) (menuKeymap = JSON.stringify(s.keymap)), setMenu(actions).catch((e) => console.error("Menu:", e));
});
setKeymapEditor(() => editKeymap());
setFileOpener((path) => openFile(path));

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
  overlay.innerHTML = `<div class="card"><h2></h2><p class="combo">Press a shortcut</p><p class="muted">Use ⌘, ⌃, or ⌥ with a key, a function key, or tap ⇧, ⌃, ⌥, or ⌘ twice. Backspace removes the shortcut, and Escape cancels.</p><div class="buttons"><button type="button" data-reset>Reset to Default</button><button type="button" data-cancel>Cancel</button></div></div>`;
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
    const tap = e.repeat ? undefined : doubleTap(e);
    if (tap) return save(tap), finish();
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

function searchEverywhere() {
  const files = root ? invoke<string[]>("list_files", { root }).then((list) => list.map((f) => fileItem(`${root}/${f}`))) : Promise.resolve([]);
  const requests = requestItems().catch(() => []);
  pick("Search everywhere: classes, files, requests, and actions", async (q) => {
    if (!q.trim()) return recent.map(fileItem);
    const [classes, items, http] = await Promise.all([symbolItems(q, true), files, requests]);
    return [...classes.slice(0, 10), ...rank(q, items).slice(0, 30), ...rank(q, http).slice(0, 5), ...rank(q, actionItems()).slice(0, 5)];
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
    if (recording || !(e.metaKey || e.ctrlKey || e.altKey || /^F\d+$/.test(e.code) || (e.shiftKey && e.code === "Escape"))) return;
    const combo = comboOf(e);
    // The first action for the keys that applies here, so an editor-only action can share its keys with another.
    const action = actions.find((a) => a.keys && canonical(a.keys) === combo && !(a.editorOnly && !editor.hasTextFocus()) && !(a.when && !a.when()));
    if (!action) return;
    // In Vim mode, ⌃ and a letter, such as ⌃D or ⌃R, belong to Vim while you type in the editor.
    if (settings.vim && /^Ctrl\+([A-Z]|BracketLeft)$/.test(combo) && editor.hasTextFocus()) return;
    // In a terminal, Ctrl and Alt keys belong to the shell (⌃R searches history), except the panel toggle.
    const inTerminal = document.activeElement?.closest("#terminals, .docked.term");
    if (inTerminal && /Ctrl|Alt/.test(combo) && action.label !== "Terminal") return;
    e.preventDefault();
    e.stopPropagation();
    action.run();
  },
  true,
);

// Double taps of a modifier, such as ⇧⇧: two presses within 350 ms with no other key between them.
const tapNames: Record<string, string> = { Shift: "Shift", Control: "Ctrl", Alt: "Alt", Meta: "Meta" };
let lastTap = { key: "", time: 0 };
/** The double tap, such as "Shift Shift", that this key press completes, if any. */
function doubleTap(e: KeyboardEvent) {
  const now = performance.now();
  const name = tapNames[e.key];
  if (name && lastTap.key === e.key && now - lastTap.time < 350) return (lastTap = { key: "", time: 0 }), `${name} ${name}`;
  lastTap = { key: e.key, time: now };
}
window.addEventListener(
  "keydown",
  (e) => {
    if (e.repeat || recording) return;
    const tap = doubleTap(e);
    if (tap) actions.find((a) => a.keys === tap)?.run();
  },
  true,
);

// The profiler and its views load the first time you use them.
let profiler: typeof import("./profiler") | undefined;
const loadProfiler = () =>
  import("./profiler").then((p) => (p.initProfiler({ root: () => root, status, openAt: (path, line) => openAt(path, { lineNumber: line, column: 1 }) }), (profiler = p)));
initRunner(() => root, (path, line) => openAt(path, { lineNumber: line, column: 1 }), status, loadProfiler, (path, a, b, label) => showDiff(path, a, b, label));
initDebugger({ root: () => root, openAt: (path, line) => openAt(path, { lineNumber: line, column: 1 }), status });
initAi({ status, root: () => root });
const settingsLoaded = initSettings();
initSnippets();
initBookmarks({ root: () => root, openAt: (path, line) => openAt(path, { lineNumber: line, column: 1 }) });
initFormatting({ root: () => root, status });
setFormattersDialog(openFormatters);
initToolPaths({ restartServers });
initJsonSchemas();
initConflicts();
initHistory({ root: () => root, status });
initSearch({ root: () => root, openAt, markSaved, status, showView });

initProjectFiles(() => root);
initProblems({
  root: () => root,
  openAt: (path, range) => openAt(path, range),
  status,
  unsaved: (path) => !!tabs.get(path) && isDirty(tabs.get(path)!),
  changed: updateProblems,
});
initFiles({ root: () => root, active: activeFile, openFile, renamed, forget, status });
initProjectState({ openFile: (path) => void openFile(path) });
setServiceChoice({
  get: () => projectValue<string>("dockerService"),
  set: (name) => void setProjectValue("dockerService", name).catch((e) => status(`Can't save the Docker service: ${e instanceof Error ? e.message : e}`)),
});

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
  if (name === "http") refreshTree();
  if (name === "filament") loadFilament();
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
  problems: () => root && showProblems(),
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
$("welcome-new").onclick = () => newLaravelProject();
$("tree-new-file").onclick = () => root && newFile(root);
$("tree-new-folder").onclick = () => root && newFolder(root);
$("tree-collapse").onclick = () => root && collapseAll();
$("tree-hidden").onclick = toggleHiddenFiles;
initTreeHidden(() => root && renderDir($("tree") as HTMLUListElement, root));
$("tree-locate").onclick = selectOpenedFile;
$("todo-refresh").onclick = () => loadTodos();

// The sidebar and panel sizes, where the panel sits, and maximizing it.
initLayout({ focusEditor: () => editor.focus(), status });
initGit({ root: () => root, openFile, status, showView, openFolder });
initPullRequests({ root: () => root, status, showView });
initDatabase({ root: () => root, openFile, status });
initRebase({ root: () => root, status });
initStash({ showView });
initBranches({ commit: focusCommit, push, update: updateProject });
initSync({ root: () => root });
initCommitView({ root: () => root, openFile, push, showHistory: showFileHistory });
initMerge({ root: () => root, ensureModel, status, openFile, saveFile: (path) => (tabs.has(path) ? saveFile(path) : writeModel(path)), resolved: (rel, remove) => (remove ? change("rm", "--quiet", "--", rel) : change("add", "--", rel)) });
initHttpClient({
  root: () => root,
  status,
  openAt: (path, line) => openAt(path, { lineNumber: line, column: 1 }),
  ensureModel,
  async hold(path) {
    held.add(path);
    return ensureModel(path);
  },
  release: (path) => void held.delete(path),
  isDirty: (path) => !!tabs.get(path) && isDirty(tabs.get(path)!),
  hasTab: (path) => tabs.has(path),
  async save(path) {
    if (tabs.has(path)) await saveFile(path);
    else await writeModel(path);
    return !(tabs.has(path) && isDirty(tabs.get(path)!));
  },
  sessionChanged: saveSoon,
  showHttpTool: () => showView("http"),
  profiler: loadProfiler,
  showDiff: (path, original, modified, label) => showDiff(path, original, modified, label),
});
initComposer({ root: () => root, status });
initLaravelElements({ root: () => root, openAt: (path, line) => openAt(path, { lineNumber: line, column: 1 }), status });
initLaravelNew({ openTerminal: (cwd, title, command, onExit) => void openTerminal(cwd, title, command, onExit), openFolder: (dir) => void openFolder(dir), status });
initFilament({
  root: () => root,
  ensureModel,
  openAt: (path, line, column) => openAt(path, { lineNumber: line, column: column ?? 1 }),
  status,
  openUrl: (url) => void invoke("run_capture", { cwd: "/", program: "open", args: [url], input: null }),
  showView,
  openTerminal: (title, command, done) => void openTerminal(root, title, command, done && (() => done())),
});
initRefactor({ root: () => root, status, ensureModel });
initClassRefactor({ root: () => root, status, openAt: (path, line) => openAt(path, { lineNumber: line, column: 1 }) });
initSafeDelete({ root: () => root, forget, status, openAt: (path, target) => openAt(path, target) });
initHierarchy({ root: () => root, ensureModel, status, openAt: (path, line) => openAt(path, { lineNumber: line, column: 1 }) });
initGenerate({ status });
initSuperMethods({ status, openAt });
initExtract({ status });
initRefactorPreview({ root: () => root, openAt: (path, line) => openAt(path, { lineNumber: line, column: 1 }) });
initCallHierarchy({ root: () => root, ensureModel, status, openAt: (path, line) => openAt(path, { lineNumber: line, column: 1 }) });
initLocalHistory({
  root: () => root,
  status,
  openText: (path) => monaco.editor.getModel(monaco.Uri.file(path))?.getValue(),
  // Through the open model, as its own undo step, so ⌘Z in the editor undoes a revert too.
  async setText(path, text) {
    const model = monaco.editor.getModel(monaco.Uri.file(path));
    if (model) {
      model.pushStackElement();
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
      model.pushStackElement();
    }
    await writeText(path, text);
    if (model) markSaved(path), didSave(model), afterSave(path, text);
  },
});
initLocalHistoryView({ root: () => root, openFile: (path) => openFile(path) });
branchListeners.push(updateBranchPullRequest);

$("open-folder").onclick = () => openFolder();

let last: string | null = null;
try {
  last = localStorage.getItem("lastFolder");
} catch {}
// Settings load first, so the project opens with the right theme and servers, and spell checking's
// language server isn't started and then restarted when the settings arrive.
settingsLoaded.then(() => (last ? openFolder(last).catch(showWelcome) : showWelcome()));
