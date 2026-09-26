// Bottom panel with tabs. Shells, Artisan commands, and tests run in terminal tabs; other
// views, such as the debugger, can add a tab with showPanelView.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { showMenu } from "./files";
import { scrollbackText } from "./scrollback";
import { onTheme } from "./themes";

/**
 * What reopens a terminal tab with the project: a shell (no `command`) in its last folder, or a command to run again,
 * with the tab's earlier output.
 */
export type Restore = { title: string; cwd: string; command?: string[]; scrollback?: string };
/** A panel tab: a terminal, or another view (without `term`). `restore` is set for tabs that come back with the project. */
type Session = { title: string; el: HTMLElement; exited: boolean; dispose(): void; term?: Terminal; fit?: FitAddon; restore?: Restore; icon?: string; editorOnly?: boolean };
/** A panel tab, as the editor sees it after you drag the tab into an editor pane. */
export type PanelTab = Session;

const $ = (id: string) => document.getElementById(id)!;
const sessions: Session[] = [];
/** Tabs dragged into an editor pane. They keep running there; the editor shows and closes them. */
const docked: Session[] = [];
let editorHost: { root(): string; reveal(tab: PanelTab): void; open(tab: PanelTab): void; close(tab: PanelTab): void } = { root: () => "/", reveal() {}, open() {}, close() {} };
let active: Session | undefined;
let panelVisible = false;
// Whether you last clicked or focused inside the panel, so ⌘W closes a panel tab instead of an editor tab.
let panelFocused = false;
const track = (e: Event) => (panelFocused = $("panel").contains(e.target as Node));
addEventListener("pointerdown", track, true);
addEventListener("focusin", track, true);

// The built-in themes' terminal colors; other themes bring their own.
const builtIn = {
  dark: { background: "#1e1f22", foreground: "#dfe1e5", cursor: "#dfe1e5", selectionBackground: "#3574f066" },
  light: { background: "#ffffff", foreground: "#1e1f22", cursor: "#1e1f22", selectionBackground: "#3574f040", black: "#1e1f22", white: "#6c707e", brightWhite: "#8c8f94", yellow: "#a8781f", brightYellow: "#c9951f" },
};
let theme = () => builtIn.dark as Record<string, string>;
onTheme((t) => {
  theme = () => t.terminal ?? builtIn[t.dark ? "dark" : "light"];
  [...sessions, ...docked].forEach((s) => s.term && (s.term.options.theme = theme()));
});

/** The shells and restorable commands that are still running, in tab order, with their output, for the session. */
export const runningTerminals = (): Restore[] =>
  [...sessions, ...docked].filter((s) => s.restore && !s.exited).map((s) => ({ ...s.restore!, scrollback: scrollbackText(s.term!.buffer.normal) }));
export const panelShown = () => panelVisible;
export const hidePanel = () => showPanel(false);
let changed = () => {};
/** Runs `f` when a terminal prints or the panel's tabs change, so the session can save them. */
export const onPanelChange = (f: () => void) => (changed = f);

// xterm.js loads with the first terminal, not with the app.
const loadXterm = () => Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/xterm/css/xterm.css")]);

/**
 * Opens a terminal tab. Without `command`, it runs your login shell. `onExit` runs when the process
 * ends; `onClose` runs when its tab closes, even while the process still runs. Shells, and commands
 * opened with `restorable` (such as a dev server), reopen with the project while they still run. `scrollback` is
 * output from the last session to show first.
 */
export async function openTerminal(cwd: string, title = "Terminal", command?: string[], onExit?: () => void, onClose?: () => void, restorable = false, scrollback?: string) {
  showPanel(true);
  const [{ Terminal }, { FitAddon }] = await loadXterm();
  const el = document.createElement("div");
  el.className = "term";
  $("terminals").append(el);
  const term = new Terminal({ theme: theme(), fontFamily: "JetBrains Mono, JetBrainsMono Nerd Font Mono, JetBrainsMono Nerd Font, SF Mono, Menlo, monospace", fontSize: 12, cursorBlink: true });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  fit.fit();
  if (scrollback) term.write(`${scrollback.replaceAll("\n", "\r\n")}\r\n\x1b[2m[Restored from the last session]\x1b[0m\r\n`);
  el.oncontextmenu = (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: "Copy", run: () => navigator.clipboard.writeText(term.getSelection()) },
      { label: "Paste", run: async () => term.paste(await navigator.clipboard.readText()) },
      { label: "Select All", run: () => term.selectAll() },
      { label: "Clear", run: () => term.clear() },
    ]);
  };

  const id = await invoke<number>("pty_spawn", { cwd, command: command ?? null, rows: term.rows, cols: term.cols });
  const restore = !command || restorable ? { title, cwd, command } : undefined;
  const session: Session = { title, term, fit, el, exited: false, dispose: () => {}, restore };
  // A shell's folder changes with `cd`, so after you press Enter, read where it is now.
  let cwdTimer: ReturnType<typeof setTimeout> | undefined;
  const followCwd = (data: string) => {
    if (command || !data.includes("\r")) return;
    clearTimeout(cwdTimer);
    cwdTimer = setTimeout(async () => {
      const now = await invoke<string | null>("pty_cwd", { id }).catch(() => null);
      if (now) restore!.cwd = now;
    }, 500);
  };
  const unlisteners = await Promise.all([
    listen<string>(`pty:${id}`, (e) => (term.write(e.payload), changed())),
    listen(`pty-exit:${id}`, () => {
      session.exited = true;
      term.write("\r\n\x1b[2m[Process exited]\x1b[0m\r\n");
      renderTabs();
      onExit?.();
    }),
  ]);
  const input = term.onData((data) => (followCwd(data), invoke("pty_write", { id, data }).catch(() => {})));
  const resize = term.onResize(({ rows, cols }) => invoke("pty_resize", { id, rows, cols }).catch(() => {}));
  const observer = new ResizeObserver(() => el.offsetParent && fit.fit());
  observer.observe(el);
  session.dispose = () => {
    onClose?.();
    clearTimeout(cwdTimer);
    unlisteners.forEach((u) => u());
    input.dispose();
    resize.dispose();
    observer.disconnect();
    invoke("pty_kill", { id });
    term.dispose();
    el.remove();
  };
  // A finished command's tab with the same title, such as an earlier git pull, gives its place to this one.
  const finished = command && sessions.find((s) => s.term && s.exited && s.title === title);
  if (finished) finished.dispose(), sessions.splice(sessions.indexOf(finished), 1, session);
  else sessions.push(session);
  activate(session);
}

/** Closes every terminal tab, stopping its process, as when another project opens. Other panel views stay. */
export function closeTerminals() {
  for (const s of sessions.filter((s) => s.term)) close(s);
}

function activate(session: Session | undefined) {
  active = session;
  sessions.forEach((s) => (s.el.hidden = s !== session));
  renderTabs();
  session?.fit?.fit();
  session?.term?.focus();
}

/** Closes the active panel tab when you last used the panel, and says whether it did. */
export function closeFocusedPanelTab() {
  if (!panelFocused || !panelVisible || !active) return false;
  close(active);
  return true;
}

function close(session: Session) {
  session.dispose();
  sessions.splice(sessions.indexOf(session), 1);
  if (active === session) activate(sessions.at(-1));
  if (!sessions.length) showPanel(false);
}

// Icons for the panel's views by title; terminal tabs all get the terminal icon.
export const tabIcon = (s: Session) => s.icon ?? (s.term ? "terminal" : (viewIcons[s.title] ?? "globe"));
const viewIcons: Record<string, string> = {
  Problems: "warning", "Git Log": "history", Debug: "debug-alt", Tests: "beaker", Coverage: "shield", Database: "database", Hierarchy: "type-hierarchy", Profiler: "flame",
};

// Drag a tab onto another to put it before that one, or onto the bar's empty end to put it last.
let dragged: Session | undefined;
const bar = $("terminal-tabs");
const clearMarks = () => bar.querySelectorAll(".drop-before").forEach((t) => t.classList.remove("drop-before"));
bar.ondragover = (e) => {
  if (!dragged) return;
  e.preventDefault();
  clearMarks();
  (e.target as HTMLElement).closest(".tab")?.classList.add("drop-before");
};
bar.ondragleave = clearMarks;
bar.ondrop = (e) => {
  if (!dragged) return;
  e.preventDefault();
  const target = sessions[dropIndex(e)];
  sessions.splice(sessions.indexOf(dragged), 1);
  sessions.splice(target ? sessions.indexOf(target) : sessions.length, 0, dragged);
  renderTabs();
};
addEventListener("dragend", () => ((dragged = undefined), clearMarks()));

// Moving tabs between the panel and the editor. The editor drops a dragged panel tab into a pane,
// and drops an editor pane's panel tab back onto this bar.
export const initDocking = (host: typeof editorHost) => (editorHost = host);
export const draggingPanelTab = () => !!dragged;

/** Takes the tab being dragged out of the panel, still running, for an editor pane to show. */
export function undockDragged() {
  const s = dragged;
  if (!s) return undefined;
  dragged = undefined;
  sessions.splice(sessions.indexOf(s), 1);
  docked.push(s);
  if (active === s) activate(sessions.at(-1));
  if (!sessions.length) showPanel(false);
  else renderTabs();
  return s;
}

/** Puts a tab from an editor pane back in the panel, before the tab at `index`, or last. */
export function dockBack(s: Session, index = sessions.length) {
  docked.splice(docked.indexOf(s), 1);
  $("terminals").append(s.el);
  sessions.splice(index, 0, s);
  showPanel(true);
  activate(s);
}

/** Closes a tab that an editor pane shows. */
export function closeDocked(s: Session) {
  docked.splice(docked.indexOf(s), 1);
  s.dispose();
}

/** The panel tab index a drop at this point on the bar goes before. */
export const dropIndex = (e: DragEvent) => {
  const i = [...bar.children].indexOf((e.target as HTMLElement).closest(".tab")!);
  return i < 0 ? sessions.length : i;
};

export function focusTab(s: Session) {
  s.el.hidden = false;
  s.fit?.fit();
  s.term?.focus();
}

function renderTabs() {
  changed();
  // The activity bar's panel buttons light up while their view is the one showing.
  const showing = panelVisible && active ? (active.term ? "Terminal" : active.title) : "";
  for (const [panel, title] of [["problems", "Problems"], ["log", "Git Log"], ["debug", "Debug"], ["terminal", "Terminal"]])
    document.querySelector(`#activitybar [data-panel="${panel}"]`)?.classList.toggle("on", showing === title);
  $("terminal-tabs").replaceChildren(
    ...sessions.map((s) => {
      const tab = document.createElement("div");
      tab.className = `tab${s === active ? " active" : ""}${s.exited ? " exited" : ""}`;
      tab.role = "tab";
      const icon = document.createElement("span");
      icon.className = `codicon codicon-${tabIcon(s)}`;
      tab.append(icon, s.title);
      tab.onclick = () => activate(s);
      tab.onauxclick = (e) => e.button === 1 && close(s);
      tab.oncontextmenu = (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: "Close", run: () => close(s) },
          { label: "Close Others", run: () => sessions.filter((o) => o !== s).forEach(close) },
          { label: "Close All", run: () => [...sessions].forEach(close) },
        ]);
      };
      tab.draggable = true;
      tab.ondragstart = (e) => ((dragged = s), e.dataTransfer?.setData("application/x-panel-tab", s.title));
      const x = document.createElement("span");
      x.className = "close";
      x.textContent = "×";
      x.onclick = (e) => (e.stopPropagation(), close(s));
      tab.append(x);
      return tab;
    }),
    newTerminal,
  );
}

const newTerminal = document.createElement("button");
newTerminal.className = "icon-button new-terminal";
newTerminal.title = "New Terminal";
newTerminal.innerHTML = '<span class="codicon codicon-add"></span>';
newTerminal.onclick = () => openTerminal(editorHost.root());

function showPanel(visible: boolean) {
  panelVisible = visible;
  $("panel").hidden = !visible;
  if (visible) active?.fit?.fit();
  renderTabs();
}

/** A shell that still runs, as opposed to a command's tab (such as git pull) or an exited shell. */
const isShell = (s: Session | undefined) => !!s?.term && !s.exited && !!s.restore && !s.restore.command;

/**
 * Shows the last shell you used, or a new one, and focuses it. Hides the panel instead when a shell
 * is showing and has focus.
 */
export function toggleTerminal(cwd: string) {
  if (panelVisible && isShell(active) && active!.el.contains(document.activeElement)) return showPanel(false);
  const term = isShell(active) ? active : [...sessions].reverse().find(isShell);
  if (!term) return openTerminal(cwd);
  showPanel(true);
  activate(term);
}

/** Keeps a closed view's element in the document, hidden, so lookups by ID still find it the next time it opens. */
const park = (el: HTMLElement) => ((el.hidden = true), el.classList.remove("docked"), document.body.append(el));

/** Shows a view as an editor tab, adding the tab the first time. `onClose` runs when its tab closes. */
export function showEditorView(title: string, el: HTMLElement, icon: string, onClose: () => void) {
  let s = docked.find((d) => d.el === el);
  if (!s) {
    s = { title, el, icon, editorOnly: true, exited: false, dispose: () => (park(el), onClose()) };
    docked.push(s);
  }
  s.title = title;
  editorHost.open(s);
}

/** Closes the tab that shows `el`, in the panel or in an editor pane. */
export function closeView(el: HTMLElement) {
  const inPanel = sessions.find((s) => s.el === el);
  if (inPanel) return close(inPanel);
  const inEditor = docked.find((s) => s.el === el);
  if (inEditor) editorHost.close(inEditor);
}

/** Shows a view as a panel tab, adding the tab the first time. `onClose` runs when its tab closes. */
export function showPanelView(title: string, el: HTMLElement, onClose: () => void = () => {}) {
  const moved = docked.find((s) => s.el === el);
  if (moved) return (moved.title = title), editorHost.reveal(moved);
  showPanel(true);
  let session = sessions.find((s) => s.el === el);
  if (!session) {
    el.classList.add("panel-view");
    $("terminals").append(el);
    session = { title, el, exited: false, dispose: () => (park(el), onClose()) };
    sessions.push(session);
  }
  session.title = title;
  activate(session);
}

// Drag the top edge of the panel to resize it.
$("panel-resize").onmousedown = (down) => {
  down.preventDefault(); // Otherwise the drag selects the text it passes over.
  const panel = $("panel");
  const start = panel.offsetHeight;
  const move = (e: MouseEvent) => (panel.style.height = `${Math.max(80, start + down.clientY - e.clientY)}px`);
  const up = () => (window.removeEventListener("mousemove", move), window.removeEventListener("mouseup", up));
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
};
