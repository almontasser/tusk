// Bottom panel with tabs. Shells, Artisan commands, and tests run in terminal tabs; other
// views, such as the debugger, can add a tab with showPanelView.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import { h, icon, iconButton } from "./dom";
import { showMenu } from "./files";
import { containerRoot } from "./sail";
import { scrollbackText } from "./scrollback";
import { onSettings, registerSettings, settings as editorSettings } from "./settings";
import { showError } from "./status";
import { candidatePaths, fileLinks, wrappedLine } from "./termlinks";
import { onTheme } from "./themes";

/**
 * What reopens a terminal tab with the project: a shell (no `command`) in its last folder, or a command to run again,
 * with the tab's earlier output.
 */
export type Restore = { title: string; cwd: string; command?: string[]; scrollback?: string };
/** A panel tab: a terminal, or another view (without `term`). `restore` is set for tabs that come back with the project. */
type Session = { title: string; el: HTMLElement; exited: boolean; dispose(): void; term?: Terminal; fit?: FitAddon; search?: SearchAddon; restore?: Restore; icon?: string; editorOnly?: boolean; stop?(): void };
/** A panel tab, as the editor sees it after you drag the tab into an editor pane. */
export type PanelTab = Session;

const $ = (id: string) => document.getElementById(id)!;
const sessions: Session[] = [];
/** Tabs dragged into an editor pane. They keep running there; the editor shows and closes them. */
const docked: Session[] = [];
let editorHost: { root(): string; reveal(tab: PanelTab): void; open(tab: PanelTab): void; close(tab: PanelTab): void; openAt(path: string, line: number, column?: number): unknown } = {
  root: () => "/",
  reveal() {},
  open() {},
  close() {},
  openAt() {},
};
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

// The terminal's font follows the editor's unless you set its own.
const terminalSettings = registerSettings("Terminal", { terminalFontFamily: "", terminalFontSize: "" }, [
  { key: "terminalFontFamily", label: "Terminal font", type: "text", placeholder: "Same as editor", help: "A CSS font list. Leave it empty to use the editor font." },
  {
    key: "terminalFontSize",
    label: "Terminal font size",
    type: "select",
    options: () => [["", "Same as editor", ""], ...Array.from({ length: 17 }, (_, i): [string, string, string] => [String(i + 8), String(i + 8), ""])],
  },
]);
const font = () => ({
  fontFamily: terminalSettings.terminalFontFamily.trim() || editorSettings.fontFamily,
  // The editor's default is 13; the terminal was 12 before it followed the editor, a size that reads the same.
  fontSize: Number(terminalSettings.terminalFontSize) || editorSettings.fontSize,
});
onSettings(() => {
  const f = font();
  for (const s of [...sessions, ...docked]) {
    if (!s.term || (s.term.options.fontFamily === f.fontFamily && s.term.options.fontSize === f.fontSize)) continue;
    Object.assign(s.term.options, f);
    if (s.el.offsetParent) s.fit?.fit();
  }
});

// xterm.js loads with the first terminal, not with the app.
const loadXterm = () =>
  Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/addon-search"), import("@xterm/addon-web-links"), import("@xterm/xterm/css/xterm.css")]);

/** Where a file path in the output is, once looked up: the file, or null when there's no such file. */
const found = new Map<string, Promise<string | null>>();
async function existing(candidates: string[]) {
  for (const path of candidates) {
    if (!found.has(path)) found.set(path, invoke<boolean>("path_exists", { path }).then((yes) => (yes ? path : null), () => null));
    if (await found.get(path)) return path;
  }
  return null;
}

/**
 * Makes file references in the output, such as `app/Models/User.php:42` in a stack trace or a test failure, open in
 * the editor at their line when clicked. Only references to files that exist are links. `cwd` is where the shell is.
 */
function linkFiles(term: Terminal, cwd: () => string) {
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const { text, cell } = wrappedLine(term.buffer.active, y - 1);
      const refs = fileLinks(text);
      if (!refs.length) return callback(undefined);
      const root = editorHost.root();
      Promise.all(refs.map(async (r) => ({ r, path: await existing(candidatePaths(r.path, cwd(), root, containerRoot)) }))).then((all) =>
        callback(
          all
            .filter((a) => a.path)
            .map(({ r, path }) => ({
              range: { start: cell(r.start), end: cell(r.end - 1) },
              text: text.slice(r.start, r.end),
              activate: () => editorHost.openAt(path!, r.line, r.column),
            })),
        ),
      );
    },
  });
}

/** A command running in a terminal tab. `stop` interrupts it (⌃C), and kills it when it's still running 3 seconds later or on a second call. */
export type TerminalRun = { stop(): void; exited(): boolean; reveal(): void };

/**
 * Opens a terminal tab. Without `command`, it runs your login shell. `onExit` runs when the process
 * ends, with its exit code when known; `onClose` runs when its tab closes, even while the process still runs. Shells, and commands
 * opened with `restorable` (such as a dev server), reopen with the project while they still run. `scrollback` is
 * output from the last session to show first. Resolves to the running command, or undefined when it couldn't start.
 */
export async function openTerminal(
  cwd: string,
  title = "Terminal",
  command?: string[],
  onExit?: (code: number | null) => void,
  onClose?: () => void,
  restorable = false,
  scrollback?: string,
): Promise<TerminalRun | undefined> {
  showPanel(true);
  const [{ Terminal }, { FitAddon }, { SearchAddon }, { WebLinksAddon }] = await loadXterm();
  const el = document.createElement("div");
  el.className = "term";
  $("terminals").append(el);
  // The search addon's match highlights are a proposed API.
  const term = new Terminal({ theme: theme(), ...font(), cursorBlink: true, minimumContrastRatio: 4.5, allowProposedApi: true });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  // URLs open in the browser; file references open in the editor.
  term.loadAddon(new WebLinksAddon((_, url) => invoke("open_url", { url: url }).catch(() => {})));
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

  // Listened for before the process starts, since it can print at once: Windows' terminal first asks for the cursor
  // position and waits for xterm's answer. What arrives early is held until the answer can go back (onData below).
  const channel = `term-${crypto.randomUUID()}`;
  const held: (() => void)[] = [];
  let ready = false;
  const whenReady = (f: () => void) => (ready ? f() : held.push(f));
  let onProcessExit: (code: number | null) => void = () => {};
  const unlisteners = await Promise.all([
    listen<string>(`pty:${channel}`, (e) => whenReady(() => (term.write(e.payload), changed()))),
    listen<number | null>(`pty-exit:${channel}`, (e) => whenReady(() => onProcessExit(e.payload))),
  ]);
  let id: number;
  try {
    id = await invoke<number>("pty_spawn", { cwd, command: command ?? null, rows: term.rows, cols: term.cols, channel });
  } catch (e) {
    unlisteners.forEach((u) => u());
    term.dispose();
    el.remove();
    if (!sessions.length) showPanel(false);
    const what = command ? command.join(" ") : "the shell";
    showError(`Couldn't start ${what} in ${cwd}`, e, { label: "Retry", run: () => openTerminal(cwd, title, command, onExit, onClose, restorable, scrollback) });
    return;
  }
  const restore = !command || restorable ? { title, cwd, command } : undefined;
  const session: Session = { title, term, fit, search, el, exited: false, dispose: () => {}, restore };
  linkFiles(term, () => restore?.cwd ?? cwd);
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
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  onProcessExit = (payload) => {
    session.exited = true;
    clearTimeout(killTimer);
    const code = typeof payload === "number" ? payload : null;
    term.write(`\r\n\x1b[2m[Process exited${code === null ? "" : ` with code ${code}`}]\x1b[0m\r\n`);
    renderTabs();
    onExit?.(code);
  };
  const kill = () => invoke("pty_kill", { id });
  if (command)
    session.stop = () => {
      if (session.exited) return;
      if (killTimer) return clearTimeout(killTimer), kill();
      invoke("pty_write", { id, data: "\x03" }).catch(kill);
      killTimer = setTimeout(kill, 3000);
    };
  const input = term.onData((data) => (followCwd(data), invoke("pty_write", { id, data }).catch(() => {})));
  const resize = term.onResize(({ rows, cols }) => invoke("pty_resize", { id, rows, cols }).catch(() => {}));
  ready = true;
  held.splice(0).forEach((f) => f());
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
  return {
    stop: () => session.stop?.(),
    exited: () => session.exited,
    reveal: () => (docked.includes(session) ? editorHost.reveal(session) : sessions.includes(session) && (showPanel(true), activate(session))),
  };
}

/** Closes every terminal tab, stopping its process, as when another project opens. Other panel views stay. */
export function closeTerminals() {
  for (const s of sessions.filter((s) => s.term)) close(s);
}

function activate(session: Session | undefined, focus = true) {
  active = session;
  sessions.forEach((s) => (s.el.hidden = s !== session));
  renderTabs();
  session?.fit?.fit();
  if (focus) session?.term?.focus();
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
  Problems: "warning", "Git Log": "history", Debug: "debug-alt", Tests: "beaker", Coverage: "shield", Database: "database", Hierarchy: "type-hierarchy", "Call Hierarchy": "call-incoming", Profiler: "flame", "Refactoring Preview": "diff", "Sync with Routes": "sync",
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
      const running = !!s.stop && !s.exited;
      tab.className = `tab${s === active ? " active" : ""}${s.exited ? " exited" : ""}${running ? " running" : ""}`;
      tab.role = "tab";
      tab.ariaSelected = String(s === active);
      tab.tabIndex = s === active ? 0 : -1;
      const icon = document.createElement("span");
      icon.className = `codicon codicon-${tabIcon(s)}`;
      const label = h("span", { class: "tab-title" }, s.title);
      tab.append(icon, label);
      // A running command's tab has a running mark and a Stop button, as PhpStorm's Run tabs do.
      if (running) {
        tab.title = `${s.title}: running`;
        tab.append(h("button", { class: "tab-stop codicon codicon-debug-stop", title: "Stop", ariaLabel: `Stop ${s.title}`, onclick: (e: MouseEvent) => (e.stopPropagation(), s.stop!()) }));
      }
      tab.onclick = () => activate(s);
      // Double-click a terminal's title to rename it.
      if (s.term) tab.ondblclick = (e) => (e.stopPropagation(), rename(s, label));
      tab.onauxclick = (e) => e.button === 1 && close(s);
      tab.oncontextmenu = (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          ...(s.term ? [{ label: "Rename…", run: () => rename(s, label) }] : []),
          ...(s.stop && !s.exited ? [{ label: "Stop", run: () => s.stop!() }] : []),
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

// ← and → move between tabs, Home and End go to the first and last, as in any tab list.
bar.addEventListener("keydown", (e) => {
  const tab = (e.target as HTMLElement).closest(".tab");
  if (!tab || !active || (e.target as HTMLElement).tagName === "INPUT") return;
  const i = sessions.indexOf(active);
  const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: sessions.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  activate(sessions[(to + sessions.length) % sessions.length], false);
  bar.querySelector<HTMLElement>(".tab.active")?.focus();
});

/** Renames a terminal tab in place: Enter keeps the name, Escape or an empty name cancels. */
function rename(s: Session, label = bar.querySelector<HTMLElement>(".tab.active .tab-title")) {
  if (!label) return;
  const input = h("input", { class: "tab-rename", value: s.title, ariaLabel: "Tab name", spellcheck: false });
  let done = false;
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (keep && name) {
      s.title = name;
      if (s.restore) s.restore.title = name;
    }
    renderTabs();
    if (s === active) s.term?.focus();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
  input.onclick = (e) => e.stopPropagation();
  label.replaceWith(input);
  input.focus();
  input.select();
}

/** Renames the active terminal tab, from the action. */
export const renameTerminal = () => active?.term && rename(active);

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

/** Shows the panel with its current tab, and focuses it. False when the panel has no tabs. */
export function revealPanel() {
  const tab = active ?? sessions.at(-1);
  if (!tab) return false;
  showPanel(true);
  activate(tab);
  return true;
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

// ---- Find in the terminal ----

/** The terminal that has focus, or the active one, while the panel shows. */
const focusedSession = () => [...sessions, ...docked].find((s) => s.term && s.el.contains(document.activeElement)) ?? (panelVisible && active?.term ? active : undefined);
/** Whether a terminal has focus, for ⌘F to find in it instead of in the editor. */
export const terminalFocused = () => !!document.activeElement?.closest(".term");

/**
 * Opens the find bar over the terminal that has focus: matches highlight as you type, Enter and ⇧Enter go to the
 * next and previous match, and Escape closes it. Returns false when no terminal shows.
 */
export function findInTerminal() {
  const s = focusedSession();
  if (!s?.term || !s.search) return false;
  const existingBar = s.el.querySelector<HTMLElement>(".term-find");
  if (existingBar) {
    const input = existingBar.querySelector("input")!;
    input.focus();
    input.select();
    return true;
  }
  const { term, search } = s;
  const input = h("input", { type: "search", placeholder: "Find", ariaLabel: "Find in terminal", spellcheck: false });
  const count = h("span", { class: "term-find-count", role: "status" });
  const options = { caseSensitive: false, regex: false };
  const toggle = (label: string, title: string, key: keyof typeof options) => {
    const b = h("button", { class: "term-find-option", title, ariaPressed: "false" }, label);
    b.onclick = () => ((options[key] = !options[key]), (b.ariaPressed = String(options[key])), find(true), input.focus());
    return b;
  };
  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue("--accent").trim() || "#3574f0";
  const decorations = { matchBackground: `${accent}40`, activeMatchBackground: `${accent}aa`, matchOverviewRuler: accent, activeMatchColorOverviewRuler: accent };
  const find = (forward: boolean, incremental = false) => {
    if (!input.value) return search.clearDecorations(), (count.textContent = "");
    const opts = { ...options, incremental, decorations };
    const hit = forward ? search.findNext(input.value, opts) : search.findPrevious(input.value, opts);
    if (!hit) count.textContent = "No results";
  };
  const results = search.onDidChangeResults(({ resultIndex, resultCount }) => {
    count.textContent = !input.value ? "" : resultCount ? `${resultIndex + 1} of ${resultCount}` : "No results";
  });
  const close = () => {
    results.dispose();
    search.clearDecorations();
    bar.remove();
    term.focus();
  };
  const bar = h(
    "div",
    { class: "term-find", role: "search" },
    icon("search"),
    input,
    toggle("Aa", "Match case", "caseSensitive"),
    toggle(".*", "Regular expression", "regex"),
    count,
    iconButton("arrow-up", "Previous match (⇧⏎)", () => find(false)),
    iconButton("arrow-down", "Next match (⏎)", () => find(true)),
    iconButton("close", "Close (Escape)", close),
  );
  input.oninput = () => find(true, true);
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") e.preventDefault(), find(!e.shiftKey);
    if (e.key === "Escape") e.preventDefault(), close();
  };
  // The selection, when there's one on a line, is what you're looking for.
  const selected = term.getSelection();
  if (selected && !selected.includes("\n")) input.value = selected;
  s.el.append(bar);
  input.focus();
  input.select();
  if (input.value) find(true, true);
  return true;
}
