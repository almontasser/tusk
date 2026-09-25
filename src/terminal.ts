// Bottom panel with tabs. Shells, Artisan commands, and tests run in terminal tabs; other
// views, such as the debugger, can add a tab with showPanelView.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { onTheme } from "./themes";

/** What reopens a terminal tab with the project: a shell (no `command`) in its last folder, or a command to run again. */
export type Restore = { title: string; cwd: string; command?: string[] };
/** A panel tab: a terminal, or another view (without `term`). `restore` is set for tabs that come back with the project. */
type Session = { title: string; el: HTMLElement; exited: boolean; dispose(): void; term?: Terminal; fit?: FitAddon; restore?: Restore };

const $ = (id: string) => document.getElementById(id)!;
const sessions: Session[] = [];
let active: Session | undefined;
let panelVisible = false;

// The built-in themes' terminal colors; other themes bring their own.
const builtIn = {
  dark: { background: "#1e1f22", foreground: "#dfe1e5", cursor: "#dfe1e5", selectionBackground: "#3574f066" },
  light: { background: "#ffffff", foreground: "#1e1f22", cursor: "#1e1f22", selectionBackground: "#3574f040", black: "#1e1f22", white: "#6c707e", brightWhite: "#8c8f94", yellow: "#a8781f", brightYellow: "#c9951f" },
};
let theme = () => builtIn.dark as Record<string, string>;
onTheme((t) => {
  theme = () => t.terminal ?? builtIn[t.dark ? "dark" : "light"];
  sessions.forEach((s) => s.term && (s.term.options.theme = theme()));
});

/** The shells and restorable commands that are still running, in tab order, for the session. */
export const runningTerminals = () => sessions.filter((s) => s.restore && !s.exited).map((s) => s.restore!);
export const panelShown = () => panelVisible;

// xterm.js loads with the first terminal, not with the app.
const loadXterm = () => Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/xterm/css/xterm.css")]);

/**
 * Opens a terminal tab. Without `command`, it runs your login shell. `onExit` runs when the process
 * ends; `onClose` runs when its tab closes, even while the process still runs. Shells, and commands
 * opened with `restorable` (such as a dev server), reopen with the project while they still run.
 */
export async function openTerminal(cwd: string, title = "Terminal", command?: string[], onExit?: () => void, onClose?: () => void, restorable = false) {
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
    listen<string>(`pty:${id}`, (e) => term.write(e.payload)),
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
  sessions.push(session);
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

function close(session: Session) {
  session.dispose();
  sessions.splice(sessions.indexOf(session), 1);
  if (active === session) activate(sessions.at(-1));
  if (!sessions.length) showPanel(false);
}

function renderTabs() {
  $("terminal-tabs").replaceChildren(
    ...sessions.map((s) => {
      const tab = document.createElement("div");
      tab.className = `tab${s === active ? " active" : ""}${s.exited ? " exited" : ""}`;
      tab.role = "tab";
      tab.textContent = s.title;
      tab.onclick = () => activate(s);
      const x = document.createElement("span");
      x.className = "close";
      x.textContent = "×";
      x.onclick = (e) => (e.stopPropagation(), close(s));
      tab.append(x);
      return tab;
    }),
  );
}

function showPanel(visible: boolean) {
  panelVisible = visible;
  $("panel").hidden = !visible;
  if (visible) active?.fit?.fit();
}

/** Shows the panel, focusing the terminal, or hides it when a terminal has focus. */
export function toggleTerminal(cwd: string) {
  if (!sessions.length) return openTerminal(cwd);
  const focused = active?.el.contains(document.activeElement);
  showPanel(!focused || !panelVisible);
  if (panelVisible) activate(active);
}

/** Shows a view as a panel tab, adding the tab the first time. `onClose` runs when its tab closes. */
export function showPanelView(title: string, el: HTMLElement, onClose: () => void = () => {}) {
  showPanel(true);
  let session = sessions.find((s) => s.el === el);
  if (!session) {
    el.classList.add("panel-view");
    $("terminals").append(el);
    session = { title, el, exited: false, dispose: () => (el.remove(), onClose()) };
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
