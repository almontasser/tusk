// Bottom panel with terminal tabs. Shells, Artisan commands, and tests all run here.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { isDark, onSettings } from "./settings";

type Session = { id: number; title: string; term: Terminal; fit: FitAddon; el: HTMLElement; exited: boolean; dispose(): void };

const $ = (id: string) => document.getElementById(id)!;
const sessions: Session[] = [];
let active: Session | undefined;
let panelVisible = false;

const themes = {
  dark: { background: "#1e1f22", foreground: "#dfe1e5", cursor: "#dfe1e5", selectionBackground: "#3574f066" },
  light: { background: "#ffffff", foreground: "#1e1f22", cursor: "#1e1f22", selectionBackground: "#3574f040", black: "#1e1f22", white: "#6c707e", brightWhite: "#8c8f94", yellow: "#a8781f", brightYellow: "#c9951f" },
};
const theme = () => themes[isDark() ? "dark" : "light"];
onSettings(() => sessions.forEach((s) => (s.term.options.theme = theme())));

/** Opens a terminal tab. Without `command`, it runs your login shell. */
export async function openTerminal(cwd: string, title = "Terminal", command?: string[]) {
  showPanel(true);
  const el = document.createElement("div");
  el.className = "term";
  $("terminals").append(el);
  const term = new Terminal({ theme: theme(), fontFamily: "JetBrains Mono, SF Mono, Menlo, monospace", fontSize: 12, cursorBlink: true });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  fit.fit();

  const id = await invoke<number>("pty_spawn", { cwd, command: command ?? null, rows: term.rows, cols: term.cols });
  const session: Session = { id, title, term, fit, el, exited: false, dispose: () => {} };
  const unlisteners = await Promise.all([
    listen<string>(`pty:${id}`, (e) => term.write(e.payload)),
    listen(`pty-exit:${id}`, () => {
      session.exited = true;
      term.write("\r\n\x1b[2m[Process exited]\x1b[0m\r\n");
      renderTabs();
    }),
  ]);
  const input = term.onData((data) => invoke("pty_write", { id, data }).catch(() => {}));
  const resize = term.onResize(({ rows, cols }) => invoke("pty_resize", { id, rows, cols }).catch(() => {}));
  const observer = new ResizeObserver(() => el.offsetParent && fit.fit());
  observer.observe(el);
  session.dispose = () => {
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

function activate(session: Session | undefined) {
  active = session;
  sessions.forEach((s) => (s.el.hidden = s !== session));
  renderTabs();
  if (session) {
    session.fit.fit();
    session.term.focus();
  }
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
  if (visible) active?.fit.fit();
}

/** Shows the panel, focusing the terminal, or hides it when a terminal has focus. */
export function toggleTerminal(cwd: string) {
  if (!sessions.length) return openTerminal(cwd);
  const focused = active?.el.contains(document.activeElement);
  showPanel(!focused || !panelVisible);
  if (panelVisible) activate(active);
}

// Drag the top edge of the panel to resize it.
$("panel-resize").onmousedown = (down) => {
  const panel = $("panel");
  const start = panel.offsetHeight;
  const move = (e: MouseEvent) => (panel.style.height = `${Math.max(80, start + down.clientY - e.clientY)}px`);
  const up = () => (window.removeEventListener("mousemove", move), window.removeEventListener("mouseup", up));
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
};
