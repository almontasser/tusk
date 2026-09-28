// The HTTP client's interface: the HTTP tool window (every request in the project's .http files, and the history),
// and the HTTP tab, which edits a request as a form and shows its response. The form writes back to the .http file,
// so the file stays the one copy of each request, and edits in the editor show in the form.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { monaco } from "./editor";
import { showMenu } from "./files";
import { attachSchema, schemaFor } from "./graphqleditor";
import {
  clearCookies,
  clearHistory,
  createEnvironmentFile,
  environments,
  type Exchange,
  globals,
  history,
  host,
  type Host,
  isText,
  jarCookies,
  onHttpChange,
  parentOf,
  PRIVATE_ENV_FILE,
  type Cancel,
  requestAt,
  resend,
  saveToPrivateEnvironment,
  scopes,
  scriptNames,
  selectedEnvironment,
  selectEnvironment,
  send,
  setEnvironment,
  setGlobals,
  setHost,
  setPinned,
  updateExchange,
} from "./httpclient";
import {
  formatRequest,
  fromCurl,
  type ExceptionReport,
  graphqlParts,
  hasSecrets,
  type Header,
  header,
  type HttpRequest,
  jsonQuery,
  laravelException,
  lookupIn,
  matchRoute,
  METHODS,
  newRequest,
  overBudget,
  parseHttp,
  parseSetCookie,
  prepare,
  redact,
  resolve,
  type Prepared,
  requestForRoute,
  type Route,
  STATUS_TEXT,
  toAxios,
  toCurl,
  toFetch,
  toGuzzle,
  toLaravel,
  websocketMessages,
} from "./httpfile";
import { detectAppAddress, generateFeatureTest, lastExchange, logCount, logsView, queriesView } from "./httplaravel";
import { addSaveAsVariable, checksSection } from "./httpchecks";
import { editEnvironments } from "./httpenv";
import { choose, confirm, type Item, pick, rank } from "./palette";
import { openSettings } from "./settings";
import { listRoutes, openRoute, routeRules } from "./runner";
import { showPanelView } from "./terminal";
import { h, icon, iconButton } from "./dom";
import { limits } from "./limits";
import { listNav } from "./listnav";
import { splitter } from "./splitter";
import { errorText, showError } from "./status";


export { selectEnvironment };
export { h, icon, iconButton };

const $ = (id: string) => document.getElementById(id)!;
const relative = (path: string) => path.replace(host.root() + "/", "");
const copy = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => host.status(`Copied ${what}`));
const ms = (s: number) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`);
export const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const statusClass = (status: number) => (!status ? "bad" : status >= 400 ? "bad" : status >= 300 ? "redirect" : "good");
function ago(time: number) {
  const s = (Date.now() - time) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  // With the time, so several sends of one request on a day stay apart.
  const when: Intl.DateTimeFormatOptions = s < 6 * 86400 ? { weekday: "short" } : { month: "short", day: "numeric" };
  return new Date(time).toLocaleString(undefined, { ...when, hour: "numeric", minute: "2-digit" });
}
/** `fn` after calls stop for `wait` ms. `flush` runs a pending call now. */
function debounce<A extends unknown[]>(fn: (...args: A) => void, wait: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | null = null;
  const run = () => {
    clearTimeout(timer);
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };
  return Object.assign((...args: A) => (clearTimeout(timer), (pending = args), (timer = setTimeout(run, wait))), { flush: run });
}
const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  fontSize: 12,
  fontFamily: "JetBrains Mono, JetBrainsMono Nerd Font Mono, SF Mono, Menlo, monospace",
  lineNumbers: "off",
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderLineHighlight: "none",
  folding: true,
  lineDecorationsWidth: 6,
  glyphMargin: false,
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
  fixedOverflowWidgets: true,
  overviewRulerLanes: 0,
  wordWrap: "on",
  tabSize: 2,
};

// ---- Request tabs ----
// The HTTP tab has a tab for each request you open. A decoration on the request's first line follows it as the file
// changes, so a tab keeps the same request when you edit the file above it. Form edits go to the tab's draft, not the
// file: a tab with a draft is unsaved, and saving it (⌘S) writes that request alone into the file. Drafts are kept
// with the session, so they come back when you reopen the project.

type RequestTab = {
  path: string;
  model: monaco.editor.ITextModel;
  decoration: string;
  /** The request as you've edited it, formatted, while it differs from the file's. */
  draft: string | null;
  /** A preview tab gives its place to the next request you open, until you edit it, send it, or keep it open. */
  preview: boolean;
  /** The response shown for it: the one it sent last, or its last in the history. */
  exchange: Exchange | null;
  /** While its request is being sent: how to cancel it, the summary that shows it, and a stream's messages so far. */
  sending: { cancel: Cancel; summary: Node[]; body?: Node } | null;
  /** A WebSocket connection's log, shown instead of a response. */
  live: { summary: Node[]; body: Node } | null;
};

const requestTabs: RequestTab[] = [];
let current: RequestTab | null = null;
const STICKY = { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges };
/** Moves the decoration that marks a tab's request to `line`. */
function mark(line: number, tab = current) {
  if (tab && !tab.model.isDisposed()) tab.decoration = tab.model.deltaDecorations(tab.decoration ? [tab.decoration] : [], [{ range: new monaco.Range(line, 1, line, 1), options: STICKY }])[0];
}
let ownEdit = false;
/** The exchange shown in the response area: the current tab's. */
let shown: Exchange | null = null;

/** Each model's requests, parsed once per version. */
const parsed = new WeakMap<monaco.editor.ITextModel, { version: number; requests: HttpRequest[] }>();
function requestsIn(model: monaco.editor.ITextModel) {
  const version = model.getVersionId();
  let entry = parsed.get(model);
  if (entry?.version !== version) parsed.set(model, (entry = { version, requests: parseHttp(model.getValue()).requests }));
  return entry.requests;
}

/** A tab's request as its file has it. */
function fileRequestOf(tab: RequestTab): HttpRequest | undefined {
  if (tab.model.isDisposed()) return undefined;
  const line = tab.model.getDecorationRange(tab.decoration)?.startLineNumber;
  if (!line) return undefined;
  return requestsIn(tab.model).find((q) => q.start <= line && line <= q.end);
}

/**
 * A tab's request: its draft, or else the file's. A copy, since callers change it. A draft's lines are the file
 * request's, so history and the tool window still find it.
 */
function requestOf(tab: RequestTab | null): HttpRequest | undefined {
  if (!tab) return undefined;
  const file = fileRequestOf(tab);
  const draft = tab.draft !== null ? parseHttp(tab.draft).requests[0] : undefined;
  if (!draft) return file && structuredClone(file);
  const shift = (file?.start ?? lineOf(tab) ?? 1) - draft.start;
  return { ...draft, line: draft.line + shift, start: draft.start + shift, end: draft.end + shift };
}

/** The request the tab edits: its draft, or the file's. */
export function currentRequest(): HttpRequest | undefined {
  return requestOf(current);
}

/** Changes the tab's request. The change goes to the tab's draft; the file changes when you save the tab. */
export function update(change: (r: HttpRequest) => void) {
  const r = currentRequest();
  if (!r || !current) return;
  change(r);
  const text = formatRequest(r);
  const file = fileRequestOf(current);
  // Back to what the file has: no draft.
  current.draft = file && formatRequest(file) === text ? null : text;
  keep(current);
  renderRequestTabs();
  renderTreeSoon();
  renderTabLabels();
  renderPreview();
  host.sessionChanged();
}

/**
 * Writes a request over its block in a model, as one undoable edit, replacing only the lines between the unchanged
 * ones at the block's start and end, so the cursor, folding, and undo stay put elsewhere.
 */
function writeRequest(model: monaco.editor.ITextModel, block: HttpRequest, r: HttpRequest) {
  // Keep the blank line that separates it from the next request.
  const after = formatRequest(r).replace(/\n$/, "").split("\n");
  if (block.end < model.getLineCount() || !model.getLineContent(block.end)) after.push("");
  const before = model.getLinesContent().slice(block.start - 1, block.end);
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  if (head === before.length && head === after.length) return;
  const from = block.start + head;
  const to = block.end - tail;
  const lines = after.slice(head, after.length - tail);
  // Replaced lines, inserted lines (none replaced: to < from), or removed lines (none inserted).
  const edit =
    to >= from
      ? lines.length
        ? { range: new monaco.Range(from, 1, to, model.getLineMaxColumn(to)), text: lines.join("\n") }
        : { range: to < model.getLineCount() ? new monaco.Range(from, 1, to + 1, 1) : new monaco.Range(from - 1, model.getLineMaxColumn(from - 1), to, model.getLineMaxColumn(to)), text: "" }
      : from > model.getLineCount()
        ? { range: monaco.Range.fromPositions(model.getFullModelRange().getEndPosition()), text: "\n" + lines.join("\n") }
        : { range: new monaco.Range(from, 1, from, 1), text: lines.join("\n") + "\n" };
  ownEdit = true;
  try {
    model.pushEditOperations([], [edit], () => null);
  } finally {
    ownEdit = false;
  }
}

/**
 * Saves a tab: writes its draft into the file and saves the file. When the file has unsaved changes in its editor
 * tab, the request goes into those, and the file stays unsaved there, so saving doesn't save your other edits. A
 * request that's gone from the file goes at its end. False when the file couldn't be saved.
 */
async function saveRequestTab(tab: RequestTab) {
  if (tab.draft === null) return true;
  const r = requestOf(tab);
  if (!r) return true;
  const model = tab.model;
  const editorDirty = host.isDirty(tab.path);
  const block = fileRequestOf(tab);
  if (block) {
    writeRequest(model, block, r);
    mark(block.start, tab);
  } else {
    const text = model.getValue();
    const sep = !text.trim() ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    const line = text.trim() ? model.getLineCount() + (sep === "\n\n" ? 2 : sep ? 1 : 0) : 1;
    ownEdit = true;
    try {
      model.pushEditOperations([], [{ range: monaco.Range.fromPositions(model.getFullModelRange().getEndPosition()), text: sep + formatRequest(r) }], () => null);
    } finally {
      ownEdit = false;
    }
    mark(line, tab);
  }
  tab.draft = null;
  const saved = editorDirty || (await host.save(tab.path));
  if (editorDirty) host.status(`Saved the request into ${relative(tab.path)}, which has other unsaved changes in the editor. Save it there to write them to disk.`);
  else if (!saved) host.status(`Couldn't save ${relative(tab.path)}.`);
  renderRequestTabs();
  renderTree();
  if (tab === current) renderRequest();
  host.sessionChanged();
  return saved;
}

/** Drops a tab's unsaved edits, back to the file's request. */
function revert(tab: RequestTab) {
  tab.draft = null;
  renderRequestTabs();
  renderTree();
  if (tab === current) renderRequest();
  host.sessionChanged();
}

/** ⌘S in the HTTP tab saves the request tab. False when the HTTP tab doesn't have focus. */
export function saveFocusedRequest() {
  if (!current || !panel.contains(document.activeElement)) return false;
  // Let a pending form edit land in the draft first.
  updateSoon.flush();
  saveRequestTab(current);
  return true;
}
const updateSoon = debounce(update, 250);

/** Shows an HTTP view in the panel, growing the panel to half the window the first time, since a form and a response need the room. */
let grown = false;
/** Whether the HTTP tab is in the panel (or docked in the editor), for the session. */
let panelOpen = false;
export function showHttpPanel(title: string, el: HTMLElement) {
  if (el === panel) {
    panelOpen = true;
    host.sessionChanged();
  }
  showPanelView(title, el, el === panel ? () => ((panelOpen = false), host.sessionChanged()) : undefined);
  const p = document.getElementById("panel");
  if (!grown && p && p.offsetHeight < innerHeight * 0.45) p.style.height = `${Math.round(innerHeight * 0.45)}px`;
  grown = true;
}

/** Keeps a model's tabs in step with edits in the editor, and drops them when the model goes. */
const watched = new Map<monaco.editor.ITextModel, monaco.IDisposable[]>();
function watch(model: monaco.editor.ITextModel) {
  if (watched.has(model)) return;
  watched.set(model, [
    model.onDidChangeContent(() => {
      renderRequestTabsSoon();
      if (!ownEdit && current?.model === model) refreshFromFile();
    }),
    model.onWillDispose(() => {
      unwatch(model);
      const gone = requestTabs.filter((t) => t.model === model);
      if (!gone.length) return;
      for (const t of gone) t.sending?.cancel.current?.(), requestTabs.splice(requestTabs.indexOf(t), 1);
      if (current && gone.includes(current)) activate(requestTabs.at(-1) ?? null);
      else renderRequestTabs();
      host.sessionChanged();
    }),
  ]);
}
function unwatch(model: monaco.editor.ITextModel) {
  watched.get(model)?.forEach((d) => d.dispose());
  watched.delete(model);
}

const lineOf = (tab: RequestTab) => tab.model.getDecorationRange(tab.decoration)?.startLineNumber ?? 0;

/**
 * Shows a request in the HTTP tab. `line` is any line of its block. A request that has a tab switches to it; otherwise
 * it gets a new tab, or with `preview`, takes the place of the preview tab.
 */
export async function openRequest(path: string, line: number, focusUrl = false, preview = false) {
  const model = await host.hold(path);
  const r = requestsIn(model).find((q) => q.start <= line && line <= q.end);
  if (!r) {
    if (!requestTabs.some((t) => t.path === path)) host.release(path);
    return;
  }
  let tab = requestTabs.find((t) => t.model === model && r.start <= lineOf(t) && lineOf(t) <= r.end);
  if (tab) {
    if (!preview) tab.preview = false;
  } else {
    const added: RequestTab = { path, model, decoration: "", draft: null, preview, exchange: null, sending: null, live: null };
    tab = added;
    mark(r.start, added);
    watch(model);
    const old = preview ? requestTabs.find((t) => t.preview && !t.sending && t.draft === null) : undefined;
    if (old) {
      requestTabs.splice(requestTabs.indexOf(old), 1, added);
      dropTab(old);
    } else requestTabs.splice(current ? requestTabs.indexOf(current) + 1 : requestTabs.length, 0, added);
  }
  activate(tab);
  showHttpPanel("HTTP", panel);
  if (focusUrl) urlInput.focus();
}

/** Takes a tab out of the list, letting go of its file when no other tab has it. */
function dropTab(tab: RequestTab) {
  const i = requestTabs.indexOf(tab);
  if (i >= 0) requestTabs.splice(i, 1);
  tab.sending?.cancel.current?.();
  if (socket && socket.tab === tab) socket.close();
  if (!tab.model.isDisposed()) tab.model.deltaDecorations([tab.decoration], []);
  if (!requestTabs.some((t) => t.model === tab.model)) unwatch(tab.model);
  if (!requestTabs.some((t) => t.path === tab.path)) host.release(tab.path);
}

/** Closes the tabs of the requests in lines `start` to `end` of a model, which are about to be deleted, without asking. */
export async function dropTabsIn(model: monaco.editor.ITextModel, start: number, end: number) {
  for (const t of requestTabs.filter((t) => t.model === model && start <= lineOf(t) && lineOf(t) <= end)) {
    const i = requestTabs.indexOf(t);
    dropTab(t);
    if (current === t) current = requestTabs[Math.min(i, requestTabs.length - 1)] ?? null;
  }
}

/** Shows the current tab again after changes to the list, such as `dropTabsIn`. */
export function refreshRequestTabs() {
  activate(current);
}

/** Makes a preview tab a lasting one. */
function keep(tab: RequestTab | null) {
  if (tab?.preview) (tab.preview = false), renderRequestTabs(), host.sessionChanged();
}

/** A tab's name for messages: its request's title, or method and path. */
function nameOf(tab: RequestTab) {
  const r = requestOf(tab);
  return r ? (r.title || r.name || `${r.method} ${tabLabel(r)}`) : "the request";
}

/**
 * Closes a request tab. When it has unsaved edits, it asks whether to save them first; Don't Save drops them. False
 * when you cancel, or the save fails.
 */
async function closeRequestTab(tab: RequestTab) {
  if (current === tab) updateSoon.flush();
  if (tab.draft !== null) {
    if (current !== tab) activate(tab);
    const choice = await choose(`Save changes to “${nameOf(tab)}”?`, ["Save", "Don't Save", "Cancel"]);
    if (choice === "Cancel" || choice === null) return false;
    if (choice === "Save" && !(await saveRequestTab(tab))) return false;
  }
  const i = requestTabs.indexOf(tab);
  dropTab(tab);
  if (current === tab) activate(requestTabs[Math.min(i, requestTabs.length - 1)] ?? null);
  else renderRequestTabs();
  host.sessionChanged();
  return true;
}

/** Closes tabs one by one, stopping if you cancel. False when you did. */
async function closeTabs(list: RequestTab[]) {
  for (const t of [...list]) if (requestTabs.includes(t) && !(await closeRequestTab(t))) return false;
  return true;
}

/** ⌘W in the HTTP tab closes the request tab. False when the HTTP tab doesn't have focus. */
export function closeFocusedRequest() {
  if (!current || !panel.contains(document.activeElement)) return false;
  closeRequestTab(current);
  return true;
}

/** Shows a tab: its request in the form, and its response. */
function activate(tab: RequestTab | null) {
  current = tab;
  renderRequestTabs();
  renderRequest();
  if (!tab) {
    shown = null;
    renderResponse();
    markActive();
    return;
  }
  renderTabResponse(tab);
  markActive();
  host.sessionChanged();
}

/** The tab's response area: a connection's log, a send in progress, its last response, or its last in the history. */
function renderTabResponse(tab: RequestTab) {
  if (tab.live) {
    resSummary.replaceChildren(...tab.live.summary);
    resTabs.replaceChildren();
    resBody.replaceChildren(tab.live.body);
    return;
  }
  shown = tab.exchange;
  if (tab.exchange) showExchange(tab.exchange);
  else renderResponse();
  if (tab.sending) resSummary.replaceChildren(...tab.sending.summary);
  if (tab.sending?.body) resTabs.replaceChildren(), resBody.replaceChildren(tab.sending.body);
  if (tab.exchange || tab.sending) return;
  const r = requestOf(tab);
  if (!r) return;
  const same = (x: Exchange) => x.path === tab.path && (r.name ? x.name === r.name : x.line === r.line);
  history().then((list) => {
    const last = list.find(same);
    if (!last || tab.exchange || tab.sending) return;
    tab.exchange = last;
    if (current === tab) showExchange(last);
  });
}

/** After an edit in the editor, shows the new text, unless you're typing in the form. */
const refreshFromFile = debounce(() => {
  // A tab with a draft shows the draft, whatever the file says.
  if (current?.draft !== null || (panel.contains(document.activeElement) && document.activeElement !== document.body && !requestStrip.contains(document.activeElement))) return refreshTree();
  renderRequest();
  refreshTree();
}, 200);

/** Saving changes the tabs' unsaved dots and the tool window's. */
export function requestFilesSaved() {
  renderRequestTabs();
  renderTree();
}

/** A held file moved on disk: its tabs follow it to the new model, which has the same text. */
export function requestFileMoved(from: string, to: string) {
  const model = monaco.editor.getModel(monaco.Uri.file(to));
  if (!model) return;
  for (const tab of requestTabs.filter((t) => t.path === from)) {
    const line = lineOf(tab);
    tab.path = to;
    tab.model = model;
    tab.decoration = "";
    mark(line || 1, tab);
  }
  watch(model);
  renderRequestTabs();
  host.sessionChanged();
}

// ---- The tab strip ----

const requestStrip = h("nav", { class: "tabs http-request-tabs", role: "tablist", ariaLabel: "Requests" });
/** A request's name in its tab: its title, its name, or its URL's path. */
function tabLabel(r: HttpRequest) {
  const title = r.title || r.name || r.url.replace(/^\{\{[^}]+\}\}/, "").replace(/^https?:\/\/[^/]+/, "") || "/";
  return title.startsWith(`${r.method} `) ? title.slice(r.method.length + 1) : title;
}

let dragged: RequestTab | null = null;

function renderRequestTabs() {
  // A draft the file now matches, such as after the same edit in the editor, is saved.
  for (const t of requestTabs) {
    const file = t.draft !== null && fileRequestOf(t);
    if (file && formatRequest(file) === t.draft) t.draft = null;
  }
  requestStrip.hidden = !requestTabs.length;
  const labels = requestTabs.map((t) => {
    const r = requestOf(t);
    return r ? tabLabel(r) : "";
  });
  requestStrip.replaceChildren(
    ...requestTabs.map((tab, i) => {
      const r = requestOf(tab);
      const dirty = tab.draft !== null;
      // The file tells apart tabs with the same name.
      const clash = labels.some((l, j) => j !== i && l === labels[i] && requestTabs[j].path !== tab.path);
      const close = h("span", { class: "close", role: "button", title: dirty ? "Close (unsaved changes: ⌘S saves them)" : "Close (⌘W)" });
      const el = h(
        "div",
        {
          class: `tab${tab === current ? " active" : ""}${dirty ? " dirty" : ""}${tab.preview ? " preview" : ""}${r ? "" : " missing"}`,
          role: "tab",
          tabIndex: 0,
          draggable: true,
          ariaSelected: String(tab === current),
          title: r ? `${r.method} ${r.url}\n${relative(tab.path)}${dirty ? " (unsaved)" : ""}${tab.preview ? "\nPreview: double-click to keep it open" : ""}` : `This request is no longer in ${relative(tab.path)}`,
        },
        tab.sending ? icon("loading codicon-modifier-spin") : methodBadge(r?.method ?? "?"),
        h("span", { class: "name" }, r ? labels[i] : "Missing request"),
        clash ? h("span", { class: "tab-dir" }, relative(tab.path).replace(/\.(http|rest)$/, "")) : null,
        close,
      );
      el.onclick = (e) => (e.target === close ? closeRequestTab(tab) : tab !== current && activate(tab));
      el.ondblclick = (e) => e.target !== close && keep(tab);
      el.onauxclick = (e) => e.button === 1 && (e.preventDefault(), closeRequestTab(tab));
      el.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") e.preventDefault(), activate(tab);
        else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const next = requestTabs[(i + (e.key === "ArrowRight" ? 1 : requestTabs.length - 1)) % requestTabs.length];
          activate(next);
          requestStrip.querySelectorAll<HTMLElement>(".tab")[requestTabs.indexOf(next)]?.focus();
        }
      };
      el.oncontextmenu = (e) => {
        e.preventDefault();
        const others = requestTabs.filter((t) => t !== tab);
        const right = requestTabs.slice(i + 1);
        const saved = requestTabs.filter((t) => t.draft === null);
        const unsaved = requestTabs.filter((t) => t.draft !== null);
        showMenu(e.clientX, e.clientY, [
          { label: "Close", run: () => closeRequestTab(tab) },
          ...(others.length ? [{ label: "Close Others", run: () => closeTabs(others) }] : []),
          ...(right.length ? [{ label: "Close to the Right", run: () => closeTabs(right) }] : []),
          ...(saved.length ? [{ label: "Close Saved", run: () => closeTabs(saved) }] : []),
          { label: "Close All", run: () => closeTabs(requestTabs) },
          "-",
          ...(tab.preview ? [{ label: "Keep Open", run: () => keep(tab) }] : []),
          ...(dirty ? [{ label: "Save", run: () => saveRequestTab(tab) }, { label: "Revert", run: () => revert(tab) }] : []),
          ...(unsaved.length > 1 ? [{ label: `Save All (${unsaved.length})`, run: async () => { for (const t of unsaved) await saveRequestTab(t); } }] : []),
          { label: "Open in Editor", run: () => host.openAt(tab.path, lineOf(tab) || 1) },
          { label: "Reveal in Tool Window", run: () => reveal(tab) },
        ]);
      };
      el.ondragstart = (e) => {
        dragged = tab;
        e.dataTransfer?.setData("text/plain", r ? `${r.method} ${r.url}` : "");
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      };
      el.ondragend = () => ((dragged = null), requestStrip.querySelectorAll(".drop-before, .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after")));
      el.ondragover = (e) => {
        if (!dragged || dragged === tab) return;
        e.preventDefault();
        const after = e.offsetX > el.offsetWidth / 2;
        el.classList.toggle("drop-after", after);
        el.classList.toggle("drop-before", !after);
      };
      el.ondragleave = () => el.classList.remove("drop-before", "drop-after");
      el.ondrop = (e) => {
        e.preventDefault();
        if (!dragged || dragged === tab) return;
        const after = e.offsetX > el.offsetWidth / 2;
        requestTabs.splice(requestTabs.indexOf(dragged), 1);
        requestTabs.splice(requestTabs.indexOf(tab) + (after ? 1 : 0), 0, dragged);
        dragged = null;
        renderRequestTabs();
        host.sessionChanged();
      };
      return el;
    }),
    h("button", { class: "icon-button http-new-tab", title: "New Request", ariaLabel: "New Request", onclick: () => newRequestInteractive() }, icon("add")),
  );
  requestStrip.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
const renderRequestTabsSoon = debounce(renderRequestTabs, 100);

/** Shows a tab's request in the tool window's tree. */
function reveal(tab: RequestTab) {
  collapsed.delete(tab.path);
  filter = "";
  ($("http-filter") as HTMLInputElement).value = "";
  host.showHttpTool();
  refreshTree().then(() => document.querySelector<HTMLElement>("#http-requests .http-request.active")?.scrollIntoView({ block: "nearest" }));
}

// ---- Session ----

export type HttpSession = { tabs: { path: string; line: number; key: string; preview?: boolean; draft?: string }[]; active: number; panel: boolean };
/** What identifies a request when its line has moved: its name, or its method and URL. */
const requestKey = (r: HttpRequest) => (r.name ? `@${r.name}` : `${r.method} ${r.url}`);

export function httpSession(): HttpSession | undefined {
  updateSoon.flush();
  const tabs = requestTabs.flatMap((t) => {
    // The file's request identifies it; a draft may have changed its name or URL.
    const r = fileRequestOf(t);
    if (!r && t.draft === null) return [];
    return [{ path: t.path, line: r?.line ?? lineOf(t), key: r ? requestKey(r) : "", ...(t.preview ? { preview: true } : {}), ...(t.draft !== null ? { draft: t.draft } : {}) }];
  });
  if (!tabs.length) return undefined;
  return { tabs, active: current ? Math.max(0, requestTabs.indexOf(current)) : 0, panel: panelOpen };
}

/** Reopens the request tabs of the last session. True when it showed the HTTP tab. */
export async function restoreHttpSession(session: HttpSession | undefined) {
  if (!session?.tabs.length) return false;
  const exists = await invoke<boolean[]>("paths_exist", { paths: session.tabs.map((t) => t.path) }).catch(() => session.tabs.map(() => false));
  const restored: (RequestTab | null)[] = [];
  for (const [i, saved] of session.tabs.entries()) {
    if (!exists[i]) {
      restored.push(null);
      continue;
    }
    const model = await host.hold(saved.path);
    const requests = requestsIn(model);
    // The same request, nearest its old line, or else whatever is at the line now.
    const same = requests.filter((r) => requestKey(r) === saved.key).sort((a, b) => Math.abs(a.line - saved.line) - Math.abs(b.line - saved.line))[0];
    const r = same ?? requests.find((q) => q.start <= saved.line && saved.line <= q.end);
    // A draft of a request that's gone from the file comes back too, to save at the file's end.
    if ((!r && saved.draft === undefined) || (r && requestTabs.some((t) => t.model === model && lineOf(t) === r.start))) {
      if (!requestTabs.some((t) => t.path === saved.path)) host.release(saved.path);
      restored.push(null);
      continue;
    }
    const draft = saved.draft !== undefined && (!r || formatRequest(r) !== saved.draft) ? saved.draft : null;
    const tab: RequestTab = { path: saved.path, model, decoration: "", draft, preview: !!saved.preview && draft === null, exchange: null, sending: null, live: null };
    mark(r?.start ?? Math.min(saved.line, model.getLineCount()), tab);
    watch(model);
    requestTabs.push(tab);
    restored.push(tab);
  }
  if (!requestTabs.length) return false;
  activate(restored[session.active] ?? requestTabs[0]);
  if (!session.panel) return false;
  showHttpPanel("HTTP", panel);
  return true;
}

// ---- The HTTP tab ----

const panel = h("div", { class: "http-client" });
const methodSelect = h("select", { class: "http-method", title: "Method" }, ...METHODS.map((m) => h("option", { value: m, textContent: m })));
const urlInput = h("input", { class: "http-url", placeholder: "{{host}}/api/posts", spellcheck: false, title: "URL. Use {{name}} for variables" });
const urlPreview = h("div", { class: "http-url-preview" });
const sendButton = h("button", { class: "primary http-send", title: "Send (⌘⏎)" }, icon("play"), "Send");
const envSelect = h("select", { class: "http-env", title: "Environment" });
const moreButton = iconButton("ellipsis", "More", () => {
  const r = sendButton.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, requestMenu());
});
const reqTabs = h("nav", { class: "http-tabs", role: "tablist" });
const reqBody = h("div", { class: "http-tab-body" });
const resSummary = h("div", { class: "http-res-summary" });
const resTabs = h("nav", { class: "http-tabs", role: "tablist" });
const resBody = h("div", { class: "http-tab-body" });
const reqPane = h("section", { class: "http-req" }, reqTabs, reqBody);
const resPane = h("section", { class: "http-res" }, resSummary, resTabs, resBody);
const divider = h("div", { class: "pane-splitter" });
const EMPTY_TEXT = "Choose a request in the HTTP tool window, or create one. Requests are saved in .http files in the project, so your team can use them too.";
const emptyText = h("p", {}, EMPTY_TEXT);
const empty = h(
  "div",
  { class: "http-empty" },
  emptyText,
  h("div", { class: "http-empty-actions" }, h("button", { class: "primary", onclick: () => newRequestInteractive() }, "New Request"), h("button", { onclick: () => showImport() }, "Import cURL…"), h("button", { onclick: () => requestsFromRoutes() }, "From Laravel Routes…")),
);
const main = h("div", { class: "http-main" }, h("div", { class: "http-bar" }, methodSelect, h("div", { class: "http-url-box" }, urlInput, urlPreview), sendButton, moreButton, envSelect), h("div", { class: "http-split" }, reqPane, divider, resPane));
panel.append(requestStrip, empty, main);

methodSelect.onchange = () => (update((r) => (r.method = methodSelect.value)), renderRequest());
urlInput.oninput = () => {
  updateSoon((r) => (r.url = urlInput.value.trim()));
  if (reqTab === "params") renderReqTab();
};
sendButton.onclick = () => sendCurrent();
envSelect.onchange = () => {
  if (envSelect.value === "\0edit") return (envSelect.value = envSelect.dataset.value ?? ""), editEnvironments(current?.path);
  if (envSelect.value === "\0json") return (envSelect.value = envSelect.dataset.value ?? ""), createEnvironmentFile();
  if (envSelect.value === "\0private") return (envSelect.value = envSelect.dataset.value ?? ""), createEnvironmentFile(PRIVATE_ENV_FILE);
  if (envSelect.value === "\0detect") return (envSelect.value = envSelect.dataset.value ?? ""), detectAppAddress(current?.path);
  setEnvironment(envSelect.value);
};
panel.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.metaKey) {
    e.preventDefault();
    e.stopPropagation();
    sendCurrent();
  }
});
splitter(divider, { target: reqPane, axis: "x", edge: "end", label: "Resize the request and the response", min: 240, minRest: 200, save: "httpRequest" });

async function renderEnvironments(select: HTMLSelectElement) {
  if (!host.root()) return;
  const envs = await environments(current?.path ?? "");
  const selected = selectedEnvironment(envs) ?? "";
  select.replaceChildren(
    ...(Object.keys(envs).length ? Object.keys(envs).map((name) => h("option", { value: name, textContent: name })) : [h("option", { value: "", textContent: "No environment" })]),
    h("option", { value: "\0edit", textContent: "Edit Environments…" }),
    h("option", { value: "\0json", textContent: "Open JSON" }),
    h("option", { value: "\0private", textContent: "Open Private JSON" }),
    h("option", { value: "\0detect", textContent: "Detect App Address…" }),
  );
  select.value = selected;
  select.dataset.value = selected;
}

/** The tab the form last showed. */
let formTab: RequestTab | null = null;

function renderRequest() {
  const r = currentRequest();
  empty.hidden = !!r;
  main.hidden = !r;
  emptyText.textContent = current && !r ? `This request is no longer in ${relative(current.path)}. Close its tab, or undo the change in the file.` : EMPTY_TEXT;
  if (!r) return;
  // Typing in the URL isn't interrupted, but another tab's URL always shows.
  if (document.activeElement !== urlInput || formTab !== current) urlInput.value = r.url;
  formTab = current;
  methodSelect.value = METHODS.includes(r.method) ? r.method : "GET";
  methodSelect.dataset.method = r.method;
  if (current?.sending) {
    sendButton.replaceChildren(icon("close"), "Cancel");
    sendButton.title = "Cancel the request (⌘⏎)";
  } else {
    const ws = r.method === "WEBSOCKET";
    const connected = ws && socket?.tab === current;
    sendButton.replaceChildren(icon(ws ? (connected ? "debug-disconnect" : "plug") : "play"), ws ? (connected ? "Disconnect" : "Connect") : "Send");
    sendButton.title = ws ? "" : "Send (⌘⏎)";
  }
  renderTabLabels();
  renderReqTab();
  renderPreview();
  renderEnvironments(envSelect);
}

/** Under the URL: the URL with variables replaced, and the names nothing defines. */
const renderPreview = debounce(async () => {
  const r = currentRequest();
  if (!r || !current) return;
  methodSelect.dataset.method = r.method;
  const s = await scopes(current.path, current.model.getValue());
  const lookup = lookupIn([...s.list.map((l) => l.vars)], s.dotenv);
  const p = await prepare({ ...r, body: "" }, lookup, parentOf(current.path), async () => "").catch(() => null);
  if (!p) return;
  const missing = [...new Set([...p.url.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((m) => m[1]))];
  urlPreview.replaceChildren(p.url === r.url ? "" : p.url, missing.length ? h("span", { class: "http-missing" }, ` Not defined: ${missing.join(", ")}`) : "");
  urlPreview.title = missing.length ? `Define ${missing.join(", ")} in ${s.env ? `the ${s.env} environment` : "an environment"}, as a file variable (@name = value), or with a script` : "";
}, 150);

// ---- Request tabs ----

type ReqTab = "params" | "headers" | "body" | "auth" | "scripts" | "settings";
let reqTab: ReqTab = "headers";

function renderTabLabels() {
  const r = currentRequest();
  if (!r) return;
  const query = r.url.includes("?") ? r.url.slice(r.url.indexOf("?") + 1).split("&").filter(Boolean).length : 0;
  const scripts = +!!r.preScript + +!!r.handler;
  const labels: [ReqTab, string][] = [
    ["params", `Params${query ? ` ${query}` : ""}`],
    ["headers", `Headers${r.headers.length ? ` ${r.headers.length}` : ""}`],
    ["body", `Body${r.body ? " •" : ""}`],
    ["auth", `Auth${header(r, "authorization") || r.tags.laravelSession ? " •" : ""}`],
    ["scripts", `Scripts${scripts ? ` ${scripts}` : ""}`],
    ["settings", "Settings"],
  ];
  reqTabs.replaceChildren(...labels.map(([id, label]) => h("button", { role: "tab", textContent: label, ariaSelected: String(id === reqTab), onclick: () => ((reqTab = id), renderTabLabels(), renderReqTab()) })));
}

export function renderReqTab() {
  const r = currentRequest();
  if (!r) return;
  disposeEditors();
  const content = { params: paramsTab, headers: headersTab, body: bodyTab, auth: authTab, scripts: scriptsTab, settings: settingsTab }[reqTab](r);
  reqBody.replaceChildren(content);
}

/** Editable name and value rows. `onChange` gets every row after an edit. */
function rowsEditor(rows: Header[], opts: { names?: string[]; placeholder: [string, string]; checkbox?: boolean; onChange(rows: Header[]): void; extra?: (row: Header, i: number) => Node | null }) {
  const table = h("div", { class: "http-rows" });
  const list = h("datalist", { id: `http-names-${Math.random().toString(36).slice(2)}` }, ...(opts.names ?? []).map((n) => h("option", { value: n })));
  const draw = () => {
    table.replaceChildren(
      list,
      ...rows.map((row, i) => {
        const check = h("input", { type: "checkbox", checked: row.enabled, title: row.enabled ? "Turn off" : "Turn on" });
        const name = h("input", { value: row.name, placeholder: opts.placeholder[0], spellcheck: false });
        const value = h("input", { value: row.value, placeholder: opts.placeholder[1], spellcheck: false });
        name.setAttribute("list", list.id);
        check.onchange = () => ((row.enabled = check.checked), opts.onChange(rows));
        name.oninput = () => ((row.name = name.value), opts.onChange(rows));
        value.oninput = () => ((row.value = value.value), opts.onChange(rows));
        const remove = iconButton("close", "Remove", () => (rows.splice(i, 1), opts.onChange(rows), draw()));
        return h("div", { class: `http-row${row.enabled ? "" : " off"}` }, opts.checkbox === false ? null : check, name, opts.extra?.(row, i) ?? value, remove);
      }),
      h("button", { class: "link http-add", onclick: () => (rows.push({ name: "", value: "", enabled: true }), draw(), table.querySelector<HTMLInputElement>(".http-row:last-of-type input:not([type=checkbox])")?.focus()) }, "+ Add"),
    );
  };
  draw();
  return table;
}

function splitUrl(url: string): [string, Header[]] {
  const q = url.indexOf("?");
  if (q < 0) return [url, []];
  const params = url
    .slice(q + 1)
    .split("&")
    .filter(Boolean)
    .map((pair) => ({ name: pair.split("=")[0], value: pair.includes("=") ? pair.slice(pair.indexOf("=") + 1) : "", enabled: true }));
  return [url.slice(0, q), params];
}
const joinUrl = (base: string, params: Header[]) => {
  const query = params.filter((p) => p.name).map((p) => (p.value ? `${p.name}=${p.value}` : p.name));
  return query.length ? `${base}?${query.join("&")}` : base;
};

function paramsTab(r: HttpRequest) {
  const [base, params] = splitUrl(r.url);
  return h(
    "div",
    { class: "http-pane" },
    h("p", { class: "http-hint" }, "Query parameters, as they appear in the URL. Values may use {{variables}}."),
    rowsEditor(params, {
      checkbox: false,
      placeholder: ["name", "value"],
      onChange: (rows) => {
        const url = joinUrl(base, rows);
        urlInput.value = url;
        updateSoon((q) => (q.url = url));
      },
    }),
  );
}

const HEADER_NAMES = ["Accept", "Accept-Encoding", "Accept-Language", "Authorization", "Cache-Control", "Content-Type", "Cookie", "If-None-Match", "Origin", "Referer", "User-Agent", "X-CSRF-TOKEN", "X-Requested-With", "X-XSRF-TOKEN"];

function headersTab(r: HttpRequest) {
  return h(
    "div",
    { class: "http-pane" },
    rowsEditor(r.headers, { names: HEADER_NAMES, placeholder: ["Header", "Value"], onChange: (rows) => updateSoon((q) => (q.headers = rows.filter((x) => x.name || x.value))) }),
    h(
      "div",
      { class: "http-presets" },
      "Add: ",
      ...(
        [
          ["Accept JSON", "Accept", "application/json"],
          ["Bearer token", "Authorization", "Bearer {{token}}"],
          ["AJAX", "X-Requested-With", "XMLHttpRequest"],
        ] as const
      ).map(([label, name, value]) => h("button", { class: "chip", textContent: label, onclick: () => (update((q) => q.headers.push({ name, value, enabled: true })), renderReqTab()) })),
    ),
  );
}

// Body, scripts: small Monaco editors, disposed when the tab changes.
let editors: monaco.editor.IStandaloneCodeEditor[] = [];
function disposeEditors() {
  for (const e of editors) {
    e.getModel()?.dispose();
    e.dispose();
  }
  editors = [];
}
function codeEditor(value: string, language: string, onChange: (v: string) => void, className = "http-code") {
  const el = h("div", { class: className });
  const editor = monaco.editor.create(el, { ...EDITOR_OPTIONS, model: monaco.editor.createModel(value, language) });
  editor.onDidChangeModelContent(() => onChange(editor.getValue()));
  editors.push(editor);
  return { el, editor };
}

type BodyType = "none" | "json" | "form" | "multipart" | "text" | "file";
const BOUNDARY = "WebAppBoundary";
function bodyType(r: HttpRequest): BodyType {
  const type = header(r, "content-type") ?? "";
  if (/^<@?\s+\S/.test(r.body.trim()) && !r.body.trim().includes("\n")) return "file";
  if (/multipart\/form-data/i.test(type)) return "multipart";
  if (/x-www-form-urlencoded/i.test(type)) return "form";
  if (/json/i.test(type) || /^[{[]/.test(r.body.trim())) return "json";
  return r.body.trim() ? "text" : "none";
}
function setContentType(r: HttpRequest, value: string | null) {
  const i = r.headers.findIndex((x) => x.name.toLowerCase() === "content-type");
  if (value === null) i >= 0 && r.headers.splice(i, 1);
  else if (i >= 0) r.headers[i] = { ...r.headers[i], value, enabled: true };
  else r.headers.push({ name: "Content-Type", value, enabled: true });
}

type Part = { name: string; value: string; file: boolean; filename?: string; type?: string };
function readParts(r: HttpRequest): Part[] {
  const boundary = (header(r, "content-type") ?? "").match(/boundary="?([^";]+)"?/)?.[1] ?? BOUNDARY;
  return r.body
    .split(new RegExp(`^--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?\\s*$`, "m"))
    .slice(1)
    .map((chunk): Part | null => {
      const text = chunk.replace(/^\n/, "");
      const blank = text.indexOf("\n\n");
      const head = blank >= 0 ? text.slice(0, blank) : text;
      const content = blank >= 0 ? text.slice(blank + 2).replace(/\n$/, "") : "";
      const name = head.match(/\bname="([^"]*)"/)?.[1];
      if (name === undefined) return null;
      const file = content.trim().match(/^<\s+(.+)$/)?.[1];
      return { name, value: file ?? content, file: !!file, filename: head.match(/filename="([^"]*)"/)?.[1], type: head.match(/Content-Type:\s*(.+)/i)?.[1].trim() };
    })
    .filter((p): p is Part => !!p);
}
const writeParts = (parts: Part[]) =>
  parts
    .filter((p) => p.name)
    .map((p) => {
      const filename = p.file ? `; filename="${p.filename || p.value.split("/").pop()}"` : "";
      return `--${BOUNDARY}\nContent-Disposition: form-data; name="${p.name}"${filename}${p.type ? `\nContent-Type: ${p.type}` : ""}\n\n${p.file ? `< ${p.value}` : p.value}`;
    })
    .join("\n") + (parts.some((p) => p.name) ? `\n--${BOUNDARY}--` : "");

/** Lets you choose a file, and returns its path relative to the .http file's folder. */
async function chooseFile(): Promise<string | null> {
  const path = await open({ multiple: false, directory: false, defaultPath: current ? parentOf(current.path) : undefined });
  if (typeof path !== "string" || !current) return null;
  const dir = parentOf(current.path);
  return path.startsWith(dir + "/") ? `./${path.slice(dir.length + 1)}` : path;
}

function graphqlTab(r: HttpRequest) {
  const parts = graphqlParts(r.body);
  const write = () => updateSoon((q) => (q.body = parts.query.trim() + (parts.variables.trim() ? `\n\n${parts.variables.trim()}` : "")));
  const query = codeEditor(parts.query, "graphql", (v) => ((parts.query = v), write()), "http-code http-script-code");
  const variables = codeEditor(parts.variables, "json", (v) => ((parts.variables = v), write()), "http-code http-script-code");
  const path = current?.path ?? "";
  const schema = (refresh = false) => schemaFor(path, currentRequest() ?? r, refresh);
  attachSchema(query.editor.getModel()!, schema);
  const refresh = h("button", { class: "link", textContent: "Refresh Schema", title: "Fetch the endpoint's schema again, for completion", onclick: () => schema(true) });
  return h(
    "div",
    { class: "http-pane http-scripts" },
    h("div", { class: "http-script" }, h("div", { class: "http-script-bar" }, h("span", { class: "http-script-title" }, "Query"), refresh), query.el),
    h("div", { class: "http-script" }, h("div", { class: "http-script-bar" }, h("span", { class: "http-script-title" }, "Variables (JSON)")), variables.el),
    h("p", { class: "http-hint" }, "Sent as a POST with the query and variables as JSON. Both may use {{variables}}. Completion uses the schema the endpoint reports, fetched once per URL."),
  );
}

function websocketTab(r: HttpRequest) {
  const { el } = codeEditor(r.body, "plaintext", (v) => updateSoon((q) => (q.body = v)));
  return h(
    "div",
    { class: "http-pane http-body-pane" },
    h("p", { class: "http-hint" }, "Messages to send once connected, each after a line of ===. A line of === wait-for-server waits for a message from the server first. Pusher and Reverb pings are answered. The request's headers go with the opening handshake."),
    el,
  );
}

function grpcTab(r: HttpRequest) {
  const { el } = codeEditor(r.body, "json", (v) => updateSoon((q) => (q.body = v)));
  return h(
    "div",
    { class: "http-pane http-body-pane" },
    h("p", { class: "http-hint" }, "The request message as JSON, or several one after another for a client streaming method. The URL is host:port/package.Service/Method, with grpcs:// for TLS. The schema comes from the server's reflection, or else the project's .proto files. Headers go as metadata."),
    el,
  );
}

function bodyTab(r: HttpRequest) {
  if (r.method === "GRAPHQL") return graphqlTab(r);
  if (r.method === "WEBSOCKET") return websocketTab(r);
  if (r.method === "GRPC") return grpcTab(r);
  const type = bodyType(r);
  const types: [BodyType, string][] = [
    ["none", "None"],
    ["json", "JSON"],
    ["form", "Form"],
    ["multipart", "Multipart"],
    ["text", "Text"],
    ["file", "File"],
  ];
  const choose = (next: BodyType) =>
    update((q) => {
      if (next === type) return;
      const contentType = { none: null, json: "application/json", form: "application/x-www-form-urlencoded", multipart: `multipart/form-data; boundary=${BOUNDARY}`, text: header(q, "content-type") && type !== "none" ? (header(q, "content-type") ?? null) : "text/plain", file: header(q, "content-type") ?? "application/octet-stream" }[next];
      setContentType(q, contentType);
      if (next === "none") q.body = "";
      else if (next === "json" && type !== "text") q.body = "{\n  \n}";
      else if (next === "form" || next === "multipart" || next === "file" || type === "file" || type === "multipart") q.body = next === "file" ? "< ./" : "";
    });
  const segmented = h("div", { class: "segmented" }, ...types.map(([id, label]) => h("button", { textContent: label, ariaPressed: String(id === type), onclick: () => (choose(id), renderReqTab(), renderTabLabels()) })));
  const pane = h("div", { class: "http-pane http-body-pane" }, h("div", { class: "http-body-bar" }, segmented));
  if (type === "none") pane.append(h("p", { class: "http-hint" }, "This request has no body."));
  else if (type === "json" || type === "text") {
    const { el, editor } = codeEditor(r.body, type === "json" ? "json" : "plaintext", (v) => updateSoon((q) => (q.body = v)));
    if (type === "json")
      pane.firstElementChild!.append(
        h("button", {
          class: "chip",
          textContent: "Format",
          title: "Indent the JSON (variables outside strings stay as they are)",
          onclick: () => {
            const vars: string[] = [];
            try {
              // {{id}} outside a string isn't JSON, so stand-ins take its place while formatting.
              const masked = editor.getValue().replace(/\{\{[^}]*\}\}/g, (v) => (vars.push(v), `"\u0000${vars.length - 1}"`));
              const pretty = JSON.stringify(JSON.parse(masked), null, 2).replace(/"\\u0000(\d+)"/g, (_, i) => vars[Number(i)]);
              editor.setValue(pretty);
            } catch (e) {
              host.status(`Can't format the body: ${e instanceof Error ? e.message : e}`);
            }
          },
        }),
      );
    pane.append(el);
  } else if (type === "form") {
    const rows = r.body
      .split("&")
      .filter(Boolean)
      .map((pair) => ({ name: pair.split("=")[0], value: pair.includes("=") ? pair.slice(pair.indexOf("=") + 1) : "", enabled: true }));
    pane.append(
      h("p", { class: "http-hint" }, "Fields are sent as written, so encode special characters, such as %20 for a space."),
      rowsEditor(rows, { checkbox: false, placeholder: ["field", "value"], onChange: (list) => updateSoon((q) => (q.body = list.filter((x) => x.name).map((x) => `${x.name}=${x.value}`).join("&"))) }),
    );
  } else if (type === "multipart") {
    const parts = readParts(r);
    const rows: Header[] = parts.map((p) => ({ name: p.name, value: p.value, enabled: true }));
    const write = () => updateSoon((q) => (q.body = writeParts(rows.map((row, i) => ({ ...(parts[i] ?? { file: false }), name: row.name, value: row.value })))));
    pane.append(
      rowsEditor(rows, {
        checkbox: false,
        placeholder: ["field", "value"],
        onChange: (list) => {
          while (parts.length < list.length) parts.push({ name: "", value: "", file: false });
          write();
        },
        extra: (row, i) => {
          parts[i] ??= { name: "", value: "", file: false };
          const kind = h("select", { class: "http-part-kind" }, h("option", { value: "text", textContent: "Text" }), h("option", { value: "file", textContent: "File" }));
          kind.value = parts[i].file ? "file" : "text";
          const value = h("input", { value: row.value, placeholder: parts[i].file ? "./path/to/file" : "value", spellcheck: false });
          value.oninput = () => ((row.value = value.value), write());
          kind.onchange = () => ((parts[i].file = kind.value === "file"), (value.placeholder = parts[i].file ? "./path/to/file" : "value"), (browse.hidden = !parts[i].file), write());
          const browse = iconButton("folder-opened", "Choose a file", async () => {
            const path = await chooseFile();
            if (path) (value.value = row.value = path), write();
          });
          browse.hidden = !parts[i].file;
          return h("span", { class: "http-part" }, kind, value, browse);
        },
      }),
    );
  } else {
    const m = r.body.trim().match(/^<(@)?\s+(.*)$/)!;
    const path = h("input", { value: m[2], placeholder: "./body.json", spellcheck: false });
    const substitute = h("input", { type: "checkbox", checked: !!m[1] });
    const write = () => updateSoon((q) => (q.body = `<${substitute.checked ? "@" : ""} ${path.value}`));
    path.oninput = write;
    substitute.onchange = write;
    pane.append(
      h("div", { class: "http-file-row" }, path, h("button", { textContent: "Choose…", onclick: async () => ((path.value = (await chooseFile()) ?? path.value), write()) })),
      h("label", { class: "http-check" }, substitute, "Replace {{variables}} in the file"),
      h("p", { class: "http-hint" }, "Paths are relative to the .http file's folder."),
    );
  }
  return pane;
}

function authTab(r: HttpRequest) {
  const value = header(r, "authorization") ?? "";
  const kind = r.tags.laravelSession ? "session" : !value ? "none" : /^Bearer\s/i.test(value) ? "bearer" : /^Basic\s+\S+\s+\S+$/i.test(value) ? "basic" : "other";
  const select = h(
    "select",
    {},
    h("option", { value: "none", textContent: "No auth" }),
    h("option", { value: "bearer", textContent: "Bearer token" }),
    h("option", { value: "basic", textContent: "Basic (user and password)" }),
    h("option", { value: "session", textContent: "Laravel session (cookies and CSRF)" }),
    kind === "other" ? h("option", { value: "other", textContent: "Custom Authorization header" }) : null,
  );
  select.value = kind;
  const set = (v: string | null) =>
    updateSoon((q) => {
      const i = q.headers.findIndex((x) => x.name.toLowerCase() === "authorization");
      if (v === null) i >= 0 && q.headers.splice(i, 1);
      else if (i >= 0) q.headers[i] = { name: q.headers[i].name, value: v, enabled: true };
      else q.headers.push({ name: "Authorization", value: v, enabled: true });
    });
  const fields = h("div", { class: "http-form" });
  const draw = (k: string) => {
    fields.replaceChildren();
    if (k === "bearer") {
      const token = h("input", { value: value.replace(/^Bearer\s+/i, "") || "{{token}}", spellcheck: false, placeholder: "{{token}}" });
      token.oninput = () => set(`Bearer ${token.value}`);
      fields.append(h("label", {}, "Token", token), h("p", { class: "http-hint" }, `Keep secrets out of the repository: set token in ${PRIVATE_ENV_FILE}, or save it from a login response with client.global.set("token", response.body.token).`));
    } else if (k === "basic") {
      const [, user = "", pass = ""] = value.match(/^Basic\s+(\S+)\s+(\S+)$/i) ?? [];
      const u = h("input", { value: user, spellcheck: false, placeholder: "{{user}}" });
      const p = h("input", { value: pass, spellcheck: false, placeholder: "{{password}}" });
      const write = () => set(`Basic ${u.value || "user"} ${p.value || "password"}`);
      u.oninput = p.oninput = write;
      fields.append(h("label", {}, "User", u), h("label", {}, "Password", p), h("p", { class: "http-hint" }, "Written as Authorization: Basic user password, which is encoded when sent, as in PhpStorm."));
    } else if (k === "session")
      fields.append(
        h(
          "p",
          { class: "http-hint" },
          "Signs in as a browser would: the first request gets Laravel's XSRF-TOKEN cookie from /sanctum/csrf-cookie (or /), and each request sends it back as X-XSRF-TOKEN, with Origin and Referer. Send your login request, such as POST /login with email and password, with this auth too, and later requests with it use the session. Works for web routes and Sanctum's SPA authentication.",
        ),
      );
    else if (k === "other") fields.append(h("p", { class: "http-hint" }, `Authorization: ${value}. Edit it in Headers.`));
  };
  select.onchange = () => {
    update((q) => (q.tags.laravelSession = select.value === "session" || undefined));
    if (select.value === "none" || select.value === "session") set(null);
    else if (select.value === "bearer") set("Bearer {{token}}");
    else if (select.value === "basic") set("Basic {{user}} {{password}}");
    setTimeout(renderReqTab, 300);
  };
  draw(kind);
  return h("div", { class: "http-pane" }, h("div", { class: "http-form" }, h("label", {}, "Type", select)), fields);
}

const SNIPPETS: Record<"pre" | "handler", [string, string][]> = {
  pre: [
    ["Set a variable", 'request.variables.set("id", "1");'],
    ["Timestamp", 'request.variables.set("now", new Date().toISOString());'],
  ],
  handler: [
    ["Status is 2xx", 'client.test("Status is 2xx", () => {\n  client.assert(response.status >= 200 && response.status < 300, `Status was ${response.status}`);\n});'],
    ["Save token", 'client.global.set("token", response.body.token);'],
    ["Save from JSON path", 'client.global.set("id", jsonPath(response.body, "$.data.id"));'],
    ["Check a header", 'client.test("Returns JSON", () => {\n  client.assert(response.contentType.mimeType === "application/json");\n});'],
    ["Log the body", "client.log(response.body);"],
  ],
};

function scriptsTab(r: HttpRequest) {
  let checks = checksSection(null);
  const section = (kind: "pre" | "handler") => {
    const script = kind === "pre" ? r.preScript : r.handler;
    const title = kind === "pre" ? "Before the request" : "After the response (tests)";
    const wrap = h("div", { class: "http-script" });
    const bar = h("div", { class: "http-script-bar" }, h("span", { class: "http-script-title" }, title));
    wrap.append(bar);
    if (script?.file) {
      const path = h("input", { value: script.file, spellcheck: false });
      path.oninput = () => updateSoon((q) => (kind === "pre" ? (q.preScript = { file: path.value }) : (q.handler = { file: path.value })));
      bar.append(h("button", { class: "chip", textContent: "Open", onclick: () => current && host.openAt(`${parentOf(current.path)}/${path.value.replace(/^\.\//, "")}`, 1) }));
      wrap.append(path);
      return wrap;
    }
    const { el, editor } = codeEditor(script?.code ?? "", "javascript", (v) => updateSoon((q) => (kind === "pre" ? (q.preScript = v.trim() ? { code: v } : undefined) : (q.handler = v.trim() ? { code: v } : undefined))), "http-code http-script-code");
    if (kind === "handler") checks = checksSection(editor);
    for (const [label, code] of SNIPPETS[kind])
      bar.append(
        h("button", {
          class: "chip",
          textContent: label,
          onclick: () => {
            const text = editor.getValue();
            editor.setValue(text ? `${text.trimEnd()}\n${code}` : code);
          },
        }),
      );
    wrap.append(el);
    return wrap;
  };
  const [pre, handler] = [section("pre"), section("handler")];
  return h(
    "div",
    { class: "http-pane http-scripts" },
    checks,
    pre,
    handler,
    h("p", { class: "http-hint" }, "JavaScript, as in PhpStorm: client.global.set(name, value) keeps a value for later requests as {{name}}; client.test(name, fn) and client.assert(condition, message) report tests; response.status, response.body (parsed JSON), response.headers.valueOf(name), response.time (ms); request.variables.set(name, value) before sending; jsonPath(value, \"$.a.b\")."),
  );
}

function settingsTab(r: HttpRequest) {
  const check = (label: string, value: boolean, set: (q: HttpRequest, v: boolean) => void, hint = "") => {
    const input = h("input", { type: "checkbox", checked: value });
    input.onchange = () => update((q) => set(q, input.checked));
    return h("label", { class: "http-check", title: hint }, input, label);
  };
  const text = (label: string, value: string, placeholder: string, set: (q: HttpRequest, v: string) => void) => {
    const input = h("input", { value, placeholder, spellcheck: false });
    input.oninput = () => updateSoon((q) => set(q, input.value.trim()));
    return h("label", {}, label, input);
  };
  const number = (v: string) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return h(
    "div",
    { class: "http-pane http-form" },
    text("Title", r.title, "Shown in the tool window", (q, v) => (q.title = v)),
    text("Name for scripts", r.tags.name ?? "", "Optional: # @name", (q, v) => (q.tags.name = v || undefined)),
    check("Follow redirects", !r.tags.noRedirect, (q, v) => (q.tags.noRedirect = !v || undefined)),
    check("Send and keep cookies", !r.tags.noCookieJar, (q, v) => (q.tags.noCookieJar = !v || undefined), "Cookies are kept per environment, as a browser would"),
    check("Verify the TLS certificate", !r.tags.insecure, (q, v) => (q.tags.insecure = !v || undefined), "Turn off for self-signed certificates on local sites"),
    check("Keep in history", !r.tags.noLog, (q, v) => (q.tags.noLog = !v || undefined)),
    text("Timeout (seconds)", r.tags.timeout?.toString() ?? "", "60", (q, v) => (q.tags.timeout = number(v))),
    text("Connection timeout (seconds)", r.tags.connectionTimeout?.toString() ?? "", "None", (q, v) => (q.tags.connectionTimeout = number(v))),
    text("Time budget (ms)", r.tags.budget?.toString() ?? "", "None: a slower response counts as failed", (q, v) => (q.tags.budget = number(v))),
    text("Proxy", r.tags.proxy ?? "", 'http://127.0.0.1:8888, or "$proxy" in the environment', (q, v) => (q.tags.proxy = v || undefined)),
    text("Client certificate", r.tags.clientCert ?? "", "./certs/client.pem", (q, v) => (q.tags.clientCert = v || undefined)),
    text("Client key", r.tags.clientKey ?? "", "./certs/client.key", (q, v) => (q.tags.clientKey = v || undefined)),
    (() => {
      const select = h("select", {}, ...[["", "Default: HTTP/2 over HTTPS, else HTTP/1.1"], ["2", "HTTP/2"], ["1.1", "HTTP/1.1"]].map(([value, label]) => h("option", { value, textContent: label, selected: (r.tags.http ?? "") === value })));
      select.onchange = () => update((q) => (q.tags.http = (select.value || undefined) as HttpRequest["tags"]["http"]));
      return h("label", {}, "HTTP version", select);
    })(),
    text("Save the response to", r.output?.path ?? "", "./responses/result.json", (q, v) => (q.output = v ? { path: v, force: q.output?.force ?? false } : undefined)),
    r.output ? check("Replace the file instead of adding a number", r.output.force, (q, v) => q.output && (q.output.force = v)) : null,
  );
}

// ---- Sending ----

type SendMode = "send" | "debug" | "profile";

/** Names the request uses that nothing defines, leaving out names the file's scripts set. */
async function missingNames(r: HttpRequest): Promise<string[]> {
  if (!current) return [];
  const text = current.model.getValue();
  const s = await scopes(current.path, text);
  const set = scriptNames(text);
  const lookup = lookupIn(s.list.map((l) => l.vars), s.dotenv);
  const p = await prepare(r, lookup, parentOf(current.path), (f) => invoke<string>("read_file", { path: f }).catch(() => "")).catch(() => null);
  if (!p) return [];
  const texts = [p.url, ...p.headers.map(([, v]) => v), p.body ?? ""];
  return [...new Set(texts.flatMap((t) => [...t.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((m) => m[1])))].filter((n) => !set.has(n));
}

/** Asks for values of names nothing defines, instead of sending the request with {{name}} in it. */
async function askForValues(names: string[], mode: SendMode) {
  const envs = await environments(current?.path ?? "");
  const env = selectedEnvironment(envs) ?? "local";
  const inputs = names.map((n) => h("input", { placeholder: n, spellcheck: false }));
  const remember = h("input", { type: "checkbox" });
  const go = (values?: Record<string, string>) => sendCurrent(mode, values ?? {});
  const sendWithValues = async () => {
    const values = Object.fromEntries(names.map((n, i) => [n, inputs[i].value]));
    if (remember.checked && current) await saveToPrivateEnvironment(current.path, env, values);
    go(values);
  };
  inputs.forEach((i) => (i.onkeydown = (e) => void (e.key === "Enter" && sendWithValues())));
  resTabs.replaceChildren();
  resSummary.replaceChildren(h("span", { class: "http-missing" }, `Not defined${Object.keys(envs).length ? ` in ${env}` : ""}: ${names.join(", ")}`));
  resBody.replaceChildren(
    h(
      "div",
      { class: "http-pane http-form http-ask" },
      ...names.map((n, i) => h("label", {}, n, inputs[i])),
      h("label", { class: "http-check" }, remember, `Save to ${env} in ${PRIVATE_ENV_FILE}`),
      h(
        "div",
        { class: "http-empty-actions" },
        h("button", { class: "primary", textContent: "Send", onclick: sendWithValues }),
        h("button", { textContent: "Send Anyway", title: "Send with {{name}} left in", onclick: () => go() }),
        h("button", { textContent: "Edit Environments…", onclick: () => editEnvironments(current?.path) }),
      ),
    ),
  );
  inputs[0]?.focus();
}

const addQuery = (url: string, param: string) => {
  const [base, hash = ""] = url.split("#");
  return `${base}${base.includes("?") ? "&" : "?"}${param}${hash ? `#${hash}` : ""}`;
};

/**
 * Sends the request in the tab, or cancels the one being sent. `debug` adds Xdebug's trigger and listens for its
 * connection; `profile` sends it to the profiling server and opens the profile. Undefined names are asked for first.
 */
async function sendCurrent(mode: SendMode = "send", extraVars?: Record<string, string>) {
  const tab = current;
  if (tab?.sending) return tab.sending.cancel.current?.();
  const r = currentRequest();
  if (!r || !tab) return;
  keep(tab);
  if (r.method === "WEBSOCKET") return connectWebSocket(r);
  if (!extraVars) {
    const missing = await missingNames(r);
    if (missing.length) return askForValues(missing, mode);
  }
  const path = tab.path;
  let adjust: ((p: Prepared) => Prepared) | undefined;
  let profiler: Awaited<ReturnType<Host["profiler"]>> | undefined;
  let since = 0;
  if (mode === "debug") {
    const debug = await import("./debug");
    if (!debug.isListening()) await debug.startDebugging();
    host.status("Sent with XDEBUG_SESSION. The server's PHP needs Xdebug in debug mode: Start Debug Server runs one.");
    adjust = (p) => ({ ...p, url: addQuery(p.url, `XDEBUG_SESSION=${encodeURIComponent(debug.debugIdeKey())}`), timeout: Math.max(p.timeout, 3600) });
  } else if (mode === "profile") {
    profiler = await host.profiler();
    const origin = await profiler.profilingOrigin();
    if (!origin) return;
    since = Math.floor(Date.now() / 1000);
    adjust = (p) => ({ ...p, url: p.url.replace(/^https?:\/\/[^/]+/, origin) });
  }
  const label = `${mode === "debug" ? "Debugging" : mode === "profile" ? "Profiling" : "Sending"} ${r.method} ${r.url}`;
  const x = await sendIn(tab, label, (cancel) => send(path, r, { cancel, extraVars, adjust }), () => sendCurrent(mode, extraVars));
  const final = x?.heads.at(-1);
  if (!x || !profiler || !final) return;
  try {
    const profile = await profiler.openProfileSince(since, `${r.method} ${x.request.url.replace(/^https?:\/\/[^/]+/, "")} (${final.status})`);
    // The Queries tab lists the SQL trace written with the profile.
    if (profile) {
      x.queries = await profiler.loadQueries(profile);
      await updateExchange(x);
      if (shown === x) renderResponse();
    }
  } catch (e) {
    showError("Couldn't open the request's profile", e);
  }
}

/**
 * Runs a send for a tab: shows it in progress (a spinner, a clock, and Cancel on the Send button), a gRPC server
 * stream's messages as they arrive, and then the response, or the error with Retry. The response goes to the tab
 * that sent it, even if you've switched to another. Resolves to the exchange, or undefined when it failed.
 */
async function sendIn(tab: RequestTab, label: string, task: (cancel: Cancel) => Promise<Exchange>, retry: () => unknown): Promise<Exchange | undefined> {
  const cancel: Cancel = {};
  const started = performance.now();
  const clock = h("span", { class: "http-stat muted" });
  const tick = () => (clock.textContent = ms((performance.now() - started) / 1000));
  tick();
  const timer = setInterval(tick, 100);
  const here = () => current === tab;
  // A server stream's messages, as they arrive; the call's response replaces them when it ends.
  let count = 0;
  const counter = h("span", { class: "http-stat muted" });
  const log = h("pre", { class: "http-log http-stream", ariaLive: "polite" });
  cancel.onMessage = (json) => {
    let text = json;
    try {
      text = JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      // Show it as it came.
    }
    count++;
    counter.textContent = `Streaming: ${count} ${count === 1 ? "message" : "messages"} so far`;
    log.append(`${count > 1 ? "\n" : ""}${text}\n`);
    if (!tab.sending) return;
    if (!tab.sending.body) {
      tab.sending.body = h("div", { class: "http-pane" }, log);
      tab.sending.summary.push(counter);
      if (here()) renderTabResponse(tab);
    }
    log.scrollTop = log.scrollHeight;
  };
  tab.live = null;
  tab.sending = { cancel, summary: [h("span", { class: "muted" }, label), icon("loading codicon-modifier-spin"), clock] };
  if (here()) renderRequest(), renderTabResponse(tab);
  renderRequestTabs();
  try {
    const x = await task(cancel);
    tab.exchange = x;
    tab.sending = null;
    if (here()) showExchange(x);
    return x;
  } catch (e) {
    tab.sending = null;
    if (here()) sendFailed(e, retry);
    else showError(`Couldn't send ${nameOf(tab)}`, e, { label: "Retry", run: retry });
    return undefined;
  } finally {
    clearInterval(timer);
    tab.sending = null;
    if (here()) renderRequest();
    renderRequestTabs();
  }
}

/** Shows why a send failed in the response area, with Retry. */
function sendFailed(e: unknown, retry: () => unknown) {
  console.error("Couldn't send the request", e);
  resSummary.replaceChildren(h("span", { class: "http-status bad" }, "Failed"));
  resTabs.replaceChildren();
  resBody.replaceChildren(errorPane(`Couldn't send the request: ${errorText(e)}`, retry));
}

/** An error in the response area, with a Retry button. */
function errorPane(text: string, retry: () => unknown) {
  return h("div", { class: "http-pane", role: "alert" }, h("p", { class: "http-error" }, text), h("div", { class: "http-empty-actions" }, h("button", { onclick: retry }, "Retry")));
}

// ---- WebSocket ----
// Through the backend (ws.rs), since the webview's WebSocket can't send headers such as Authorization.

let socket: { close(): void; tab: RequestTab } | null = null;

function connectWebSocket(r: HttpRequest) {
  if (socket) {
    socket.close();
    return;
  }
  const tab = current;
  if (!tab) return;
  const path = tab.path;
  (async () => {
    const s = await scopes(path, tab.model.getValue());
    const lookup = lookupIn(s.list.map((l) => l.vars), s.dotenv);
    const url = resolve(r.url, lookup);
    const messages = websocketMessages(resolve(r.body, lookup));
    const log = h("div", { class: "http-ws-log" });
    const state = h("span", { class: "http-status" }, "Connecting");
    const input = h("textarea", { class: "http-ws-input", placeholder: "Message (⌘⏎ sends)", spellcheck: false });
    const headers = r.headers.filter((x) => x.enabled).map((x) => [x.name, resolve(x.value, lookup)]);
    const channel = `ws-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    let open = false;
    let id = 0;
    const waiting: (() => void)[] = [];
    const entry = (dir: "in" | "out" | "info", text: string) => {
      let shown = text;
      try {
        shown = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Not JSON.
      }
      log.append(h("div", { class: `http-ws-entry ${dir}` }, h("span", { class: "http-ws-dir" }, dir === "in" ? "↓" : dir === "out" ? "↑" : "•"), h("span", { class: "muted" }, new Date().toLocaleTimeString()), h("pre", {}, shown)));
      log.scrollTop = log.scrollHeight;
    };
    const post = (text: string) => {
      if (!open) return entry("info", "Not connected.");
      invoke("ws_send", { id, text }).catch((e) => entry("info", String(e)));
      entry("out", text);
    };
    const unlisten = await Promise.all([
      listen<{ text?: string; binary?: string }>(`ws:${channel}`, (e) => {
        const text = e.payload.text ?? `[binary message, base64] ${e.payload.binary}`;
        entry("in", text);
        // Pusher and Laravel Reverb close a connection that doesn't answer their pings.
        if (/"event"\s*:\s*"pusher:ping"/.test(text)) post(JSON.stringify({ event: "pusher:pong", data: {} }));
        waiting.shift()?.();
      }),
      listen<string>(`ws-error:${channel}`, (e) => entry("info", `Connection error: ${e.payload}`)),
      listen<{ code: number; reason: string }>(`ws-close:${channel}`, (e) => closed(e.payload.code, e.payload.reason)),
    ]);
    const closed = (code: number, reason: string) => {
      unlisten.forEach((u) => u());
      open = false;
      entry("info", `Closed${code ? ` (${code}${reason ? `: ${reason}` : ""})` : ""}.`);
      state.textContent = "Closed";
      state.className = "http-status bad";
      if (socket === connection) socket = null;
      if (current === tab) sendButton.replaceChildren(icon("plug"), "Connect");
    };
    const connection = { close: () => invoke("ws_close", { id }), tab };
    socket = connection;
    input.onkeydown = (e) => {
      if (e.key === "Enter" && e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        if (input.value.trim()) post(input.value), (input.value = "");
      }
    };
    const view = h(
        "div",
        { class: "http-pane http-ws" },
        log,
        messages.length ? h("div", { class: "http-presets" }, "Send again: ", ...messages.map((m, i) => h("button", { class: "chip", textContent: `${i + 1}. ${m.text.replace(/\s+/g, " ").slice(0, 40)}`, title: m.text, onclick: () => post(m.text) }))) : null,
        h("div", { class: "http-ws-send" }, input, h("button", { textContent: "Send", onclick: () => input.value.trim() && (post(input.value), (input.value = "")) })),
      );
    tab.live = { summary: [state, h("span", { class: "http-stat muted" }, url)], body: view };
    if (current === tab) renderTabResponse(tab);
    try {
      id = await invoke<number>("ws_connect", { url, headers, insecure: !!r.tags.insecure, channel });
    } catch (e) {
      unlisten.forEach((u) => u());
      socket = null;
      state.textContent = "Failed";
      state.className = "http-status bad";
      entry("info", `Can't connect to ${url}: ${e}`);
      return;
    }
    open = true;
    state.textContent = "Open";
    state.className = "http-status good";
    if (current === tab) sendButton.replaceChildren(icon("debug-disconnect"), "Disconnect");
    for (const m of messages) {
      if (m.waitForServer) await new Promise<void>((done) => waiting.push(done));
      post(m.text);
    }
  })();
}

/** Shows an exchange, such as one the runner sent, with its request. Resolves to the tab that shows it, if any. */
export async function openExchange(x: Exchange) {
  const { request } = await requestAt(x.path, x.line).catch(() => ({ request: undefined }));
  if (request) await openRequest(x.path, request.line, false, true);
  else showHttpPanel("HTTP", panel);
  // A request that's gone from its file still shows its response, without a tab to keep it.
  if (request && current) current.exchange = x;
  showExchange(x);
  return request ? current : null;
}

/** Sends the request in `path` at `line`, as from the editor, showing it in the HTTP tab. */
export async function sendAt(path: string, line: number) {
  await openRequest(path, line);
  await sendCurrent();
}

// ---- Response ----

type ResTab = "body" | "headers" | "cookies" | "timing" | "tests" | "logs" | "queries" | "request";
let resTab: ResTab = "body";
let bodyMode: "pretty" | "raw" | "preview" = "pretty";
let responseEditor: monaco.editor.IStandaloneCodeEditor | null = null;
const MAX_SHOWN = () => limits.httpShownMB * 1024 * 1024;

function showExchange(x: Exchange) {
  shown = x;
  const final = x.heads.at(-1);
  const status = final?.status ?? 0;
  const pill = h("span", { class: `http-status ${statusClass(status)}` }, x.error && !final ? (x.error === "Cancelled" ? "Cancelled" : "Failed") : `${status} ${final?.statusText || STATUS_TEXT[status] || ""}`.trim());
  resSummary.replaceChildren(
    pill,
    x.info ? h("span", { class: "http-stat", title: "Total time" }, ms(x.info.time_total)) : "",
    overBudget(x.request, x.info?.time_total) ? h("span", { class: "http-stat http-over-budget", title: "Set with # @budget" }, `Over budget: ${ms(x.info!.time_total)} > ${x.request.budget} ms`) : "",
    x.info ? h("span", { class: "http-stat", title: "Body size" }, bytes(x.info.size_download)) : "",
    x.tests.length ? h("span", { class: `http-stat ${x.tests.every((t) => t.passed) ? "good" : "bad"}` }, `${x.tests.filter((t) => t.passed).length}/${x.tests.length} tests`) : "",
    x.env ? h("span", { class: "http-stat muted" }, x.env) : "",
    h("span", { class: "http-stat muted", title: new Date(x.time).toLocaleString() }, ago(x.time)),
    x.error ? h("div", { class: "http-error" }, x.error) : "",
    x.unresolved.length ? h("div", { class: "http-missing" }, `Sent without values for: ${x.unresolved.join(", ")}`) : "",
  );
  if (resTab === "tests" && !x.tests.length && !x.logs.length) resTab = "body";
  if (!x.tests.every((t) => t.passed)) resTab = "tests";
  renderResponse();
}

function renderResponse() {
  const x = shown;
  if (!x) {
    resTabs.replaceChildren();
    resBody.replaceChildren(h("p", { class: "http-hint" }, "Send the request to see the response. ⌘⏎ sends from anywhere in this tab."));
    return;
  }
  const final = x.heads.at(-1);
  const cookies = final?.headers.filter(([k]) => k.toLowerCase() === "set-cookie") ?? [];
  const labels: [ResTab, string][] = [
    ["body", "Body"],
    ["headers", `Headers${final ? ` ${final.headers.length}` : ""}`],
    ["cookies", `Cookies${cookies.length ? ` ${cookies.length}` : ""}`],
    ["timing", "Timing"],
    ["tests", `Tests${x.tests.length ? ` ${x.tests.filter((t) => t.passed).length}/${x.tests.length}` : ""}${x.logs.length ? " •" : ""}`],
    ["logs", `Logs${logCount(x) ? ` ${logCount(x)}` : ""}`],
    ["queries", `Queries${x.queries?.length ? ` ${x.queries.length}` : ""}`],
    ["request", "Request"],
  ];
  resTabs.replaceChildren(...labels.map(([id, label]) => h("button", { role: "tab", textContent: label, ariaSelected: String(id === resTab), onclick: () => ((resTab = id), renderResponse()) })));
  responseEditor?.getModel()?.dispose();
  responseEditor?.dispose();
  responseEditor = null;
  const content = { body: bodyView, headers: headersView, cookies: cookiesView, timing: timingView, tests: testsView, logs: logsView, queries: queriesView, request: requestView }[resTab](x);
  resBody.replaceChildren(content);
}

const languageFor = (type: string) => (/json/.test(type) ? "json" : /html/.test(type) ? "html" : /xml|svg/.test(type) ? "xml" : /javascript/.test(type) ? "javascript" : /css/.test(type) ? "css" : "plaintext");

function bodyView(x: Exchange) {
  const pane = h("div", { class: "http-pane http-body-view" });
  const type = x.contentType.toLowerCase();
  const image = /^image\//.test(type);
  const previewable = image || /html|pdf/.test(type);
  if (bodyMode === "preview" && !previewable) bodyMode = "pretty";
  const modes: [typeof bodyMode, string][] = [["pretty", "Pretty"], ["raw", "Raw"], ...(previewable ? ([["preview", "Preview"]] as [typeof bodyMode, string][]) : [])];
  const bar = h(
    "div",
    { class: "http-body-bar" },
    h("div", { class: "segmented" }, ...modes.map(([id, label]) => h("button", { textContent: label, ariaPressed: String(id === bodyMode), onclick: () => ((bodyMode = id), renderResponse()) }))),
    h("span", { class: "muted http-type" }, x.contentType || "No content type"),
    iconButton("copy", "Copy the body", () => invoke<string>("read_file", { path: x.bodyPath }).then((text) => copy(text, "the response body"), (e) => showError("Couldn't copy the body", e))),
    iconButton("save", "Save the body as…", async () => {
      const to = await save({ defaultPath: `${host.root()}/${x.bodyPath.split("/").pop()!.replace(/^[^.]+/, "response")}` });
      if (to) await invoke("run_capture", { cwd: "/", program: "/bin/cp", args: [x.bodyPath, to], input: null }).then(() => host.status(`Saved ${to}`), (e) => host.status(`Couldn't save the body: ${e}`));
    }),
    iconButton("go-to-file", "Open the body in an editor tab", () => host.openAt(x.bodyPath, 1)),
    iconButton("diff", "Compare with an earlier response to this request", () => compareWithEarlier(x)),
  );
  pane.append(bar);
  const size = x.info?.size_download ?? 0;
  if (!x.heads.length) return pane.append(h("p", { class: "http-hint" }, "No response. ", h("button", { class: "link", onclick: () => (current?.exchange === x ? sendCurrent() : resendExchange(x)) }, "Retry"))), pane;
  if (!size) return pane.append(h("p", { class: "http-hint" }, "The response has no body.")), pane;
  if (!x.bodyPath) {
    bar.hidden = true;
    return pane.append(h("p", { class: "http-hint" }, "The history doesn't keep response bodies. ", h("button", { class: "link", onclick: () => resendExchange(x) }, "Send Again"), " to see it, or change this in ", h("button", { class: "link", onclick: () => openSettings("Response bodies in the history") }, "Settings"), ".")), pane;
  }
  if (x.bodyHidden === "redacted" && x.savedBody === undefined)
    pane.append(h("p", { class: "http-hint http-secrets" }, "Secrets in this body, such as tokens and passwords, were hidden when the history saved it. ", h("button", { class: "link", onclick: () => openSettings("Response bodies in the history") }, "Settings")));
  // While the body loads, and why it couldn't, with Retry.
  const loading = h("p", { class: "http-hint" }, "Loading the body…");
  const read = <T>(load: Promise<T>, then: (value: T) => void) => {
    pane.append(loading);
    load.then(
      (value) => (loading.remove(), shown === x && pane.isConnected && then(value)),
      (e) => {
        loading.remove();
        if (shown === x && pane.isConnected) pane.append(errorPane(`Couldn't read the response body: ${errorText(e)}`, () => renderResponse()));
      },
    );
  };
  const status = x.heads.at(-1)?.status ?? 0;
  if (status >= 500 && isText(type) && size <= MAX_SHOWN())
    invoke<string>("read_file", { path: x.bodyPath }).then((text) => {
      const report = laravelException(text, status);
      if (report && pane.isConnected) bar.after(exceptionBanner(report, /json/.test(type)));
    }, () => {}); // The body's own read below shows the error.
  if (bodyMode === "preview") {
    if (image || /pdf/.test(type)) {
      read(invoke<string>("run_capture", { cwd: "/", program: "/usr/bin/base64", args: ["-i", x.bodyPath], input: null }), (b64) => {
        const src = `data:${type.split(";")[0]};base64,${b64.replace(/\s/g, "")}`;
        pane.append(image ? h("div", { class: "http-image" }, h("img", { src, alt: "Response image" })) : h("iframe", { class: "http-preview", src }));
      });
    } else
      read(invoke<string>("read_file", { path: x.bodyPath }), (html) => {
        // No scripts: the page renders as HTML only, with links resolving against the request's URL.
        const frame = h("iframe", { class: "http-preview" });
        frame.setAttribute("sandbox", "");
        frame.srcdoc = `<base href="${(x.info?.url_effective ?? x.request.url).replace(/"/g, "&quot;")}">${html}`;
        pane.append(frame);
      });
    return pane;
  }
  if (!isText(type)) return pane.append(h("p", { class: "http-hint" }, `A ${bytes(size)} ${type || "binary"} body. Save it, or open it in an editor tab.`)), pane;
  if (size > MAX_SHOWN()) return pane.append(h("p", { class: "http-hint" }, `The body is ${bytes(size)}, too large to show here. Open it in an editor tab.`)), pane;
  read(invoke<string>("read_file", { path: x.bodyPath }), (text) => {
    const el = h("div", { class: "http-code http-response-code" });
    pane.append(el);
    let value = text;
    let parsed: unknown;
    if (bodyMode === "pretty" && /json/.test(type)) {
      try {
        parsed = JSON.parse(text);
        value = JSON.stringify(parsed, null, 2);
      } catch {
        // Show it as it came.
      }
    }
    const editor = monaco.editor.create(el, { ...EDITOR_OPTIONS, readOnly: true, lineNumbers: "on", model: monaco.editor.createModel(value, bodyMode === "raw" ? "plaintext" : languageFor(type)), wordWrap: bodyMode === "raw" ? "on" : "off" });
    responseEditor = editor;
    if (parsed === undefined) return;
    addSaveAsVariable(editor, parsed, () => jsonFilter);
    // A JSON path narrows the body, such as $.data[*].id.
    const filter = h("input", { class: "http-json-filter", placeholder: "Filter: $.data[*].id", spellcheck: false, value: jsonFilter, title: "A JSON path: $, .key, [n], [*], .*, and ..key for any depth" });
    const apply = () => {
      jsonFilter = filter.value.trim();
      const found = jsonFilter && jsonFilter !== "$" ? jsonQuery(parsed, jsonFilter) : [parsed];
      editor.setValue(JSON.stringify(found.length === 1 && !/\*|\.\./.test(jsonFilter) ? found[0] : found, null, 2) ?? "");
      filter.classList.toggle("empty", !!jsonFilter && !found.length);
    };
    filter.oninput = debounce(apply, 200);
    bar.querySelector(".http-type")!.replaceWith(filter);
    if (jsonFilter) apply();
  });
  return pane;
}

let jsonFilter = "";

/** Where a file in a stack trace is on this Mac: Sail's container keeps the project at /var/www/html. */
export const localPath = (file: string) => (file.startsWith(host.root()) ? file : file.includes("/var/www/html/") ? `${host.root()}/${file.split("/var/www/html/")[1]}` : file);

function exceptionBanner(report: ExceptionReport, json: boolean) {
  const own = (f: { file: string }) => !/\/vendor\//.test(f.file);
  const frame = (f: { file: string; line: number }) => {
    const path = localPath(f.file);
    return h("button", { class: `link http-frame${own(f) ? "" : " vendor"}`, textContent: `${path.replace(host.root() + "/", "")}:${f.line}`, onclick: () => host.openAt(path, f.line) });
  };
  const appFrames = report.frames.filter(own).slice(0, 8);
  const vendor = report.frames.filter((f) => !own(f));
  const more = h("details", {}, h("summary", {}, `${vendor.length} frames in vendor`), ...vendor.slice(0, 30).map(frame));
  return h(
    "div",
    { class: "http-exception" },
    h("div", { class: "http-exception-title" }, icon("error"), h("strong", {}, report.className || "Server error"), report.message ? h("span", {}, report.message) : null),
    h("div", { class: "http-frames" }, ...appFrames.map(frame), vendor.length ? more : null),
    json ? null : h("p", { class: "http-hint" }, "Add Accept: application/json to get the exception as JSON, with its whole trace."),
  );
}

/** Opens a diff of this response's body and an earlier one to the same request. */
async function compareWithEarlier(x: Exchange) {
  const earlier = (await history()).filter((e) => e.id !== x.id && e.path === x.path && (x.name ? e.name === x.name : e.line === x.line) && e.time < x.time);
  if (!earlier.length) return host.status("There's no earlier response to this request in the history.");
  pick("Compare with which response?", () =>
    earlier.map((e) => ({
      label: `${e.heads.at(-1)?.status ?? "ERR"} · ${new Date(e.time).toLocaleString()}`,
      detail: `${e.request.method} ${e.request.url}`,
      run: () => compareExchanges(e, x),
    })),
  );
}

function table(rows: (string | Node)[][], head?: string[]) {
  return h(
    "table",
    { class: "http-table" },
    head ? h("thead", {}, h("tr", {}, ...head.map((c) => h("th", { textContent: c })))) : null,
    h("tbody", {}, ...rows.map((r) => h("tr", {}, ...r.map((c) => h("td", {}, c))))),
  );
}

function headersView(x: Exchange) {
  const pane = h("div", { class: "http-pane" });
  x.heads.slice(0, -1).forEach((r) => pane.append(h("p", { class: "http-redirect" }, `${r.status} ${r.statusText} → ${r.headers.find(([k]) => k.toLowerCase() === "location")?.[1] ?? ""}`)));
  const final = x.heads.at(-1);
  if (final) pane.append(table(final.headers.map(([k, v]) => [k, v])), h("button", { class: "link", textContent: "Copy all", onclick: () => copy(final.headers.map(([k, v]) => `${k}: ${v}`).join("\n"), "the headers") }));
  return pane;
}

function cookiesView(x: Exchange) {
  const pane = h("div", { class: "http-pane" });
  const set = (x.heads.at(-1)?.headers ?? []).filter(([k]) => k.toLowerCase() === "set-cookie").map(([, v]) => parseSetCookie(v));
  pane.append(h("h4", {}, "Set by this response"), set.length ? table(set.map((c) => [c.name, c.value, c.attributes]), ["Name", "Value", "Attributes"]) : h("p", { class: "http-hint" }, "None."));
  const jar = h("div", {});
  pane.append(h("h4", {}, `Kept for ${x.env ?? "this project"}`, " ", h("button", { class: "link", textContent: "Clear", onclick: async () => (await clearCookies(), renderResponse()) })), jar);
  jarCookies(x.env).then((list) =>
    jar.replaceChildren(list.length ? table(list.map((c) => [c.name, c.value, c.domain, c.path, c.expires ? new Date(c.expires * 1000).toLocaleString() : "Session"]), ["Name", "Value", "Domain", "Path", "Expires"]) : h("p", { class: "http-hint" }, "None. Requests with the @no-cookie-jar tag don't use them.")),
  );
  return pane;
}

function timingView(x: Exchange) {
  const i = x.info;
  if (!i) return h("p", { class: "http-hint" }, "No timing: curl didn't run.");
  const phases: [string, number, number][] = [
    ["DNS lookup", 0, i.time_namelookup],
    ["Connecting", i.time_namelookup, i.time_connect],
    ["TLS handshake", i.time_connect, i.time_appconnect || i.time_connect],
    ["Waiting (TTFB)", Math.max(i.time_pretransfer, i.time_appconnect, i.time_connect), i.time_starttransfer],
    ["Downloading", i.time_starttransfer, i.time_total],
  ];
  if (i.num_redirects) phases.unshift(["Redirects", 0, 0]);
  const total = i.time_total || 1;
  const rows = phases
    .filter(([, from, to]) => to > from)
    .map(([label, from, to]) =>
      h(
        "div",
        { class: "http-phase" },
        h("span", { class: "http-phase-label" }, label),
        h("span", { class: "http-phase-track" }, h("span", { class: "http-phase-bar", style: `left:${(from / total) * 100}%;width:${Math.max(0.5, ((to - from) / total) * 100)}%` })),
        h("span", { class: "http-phase-ms" }, ms(to - from)),
      ),
    );
  return h(
    "div",
    { class: "http-pane" },
    ...rows,
    h("div", { class: "http-phase total" }, h("span", { class: "http-phase-label" }, "Total"), h("span", { class: "http-phase-track" }), h("span", { class: "http-phase-ms" }, ms(i.time_total))),
    table([
      ["Address", `${i.remote_ip}${i.remote_port ? `:${i.remote_port}` : ""}`],
      ["HTTP version", i.http_version],
      ["Redirects", String(i.num_redirects)],
      ["Sent", bytes(i.size_upload)],
      ["Received", bytes(i.size_download)],
      ["Final URL", i.url_effective],
    ]),
  );
}

function testsView(x: Exchange) {
  const pane = h("div", { class: "http-pane" });
  if (!x.tests.length && !x.logs.length) pane.append(h("p", { class: "http-hint" }, "No tests. Add them in the request's Scripts tab, such as client.test(\"Status is 200\", () => client.assert(response.status === 200))."));
  for (const t of x.tests) pane.append(h("div", { class: `http-test ${t.passed ? "good" : "bad"}` }, icon(t.passed ? "pass" : "error"), h("span", {}, t.name), t.message ? h("span", { class: "muted" }, ` — ${t.message}`) : ""));
  if (x.logs.length) pane.append(h("h4", {}, "Log"), h("pre", { class: "http-log" }, x.logs.join("\n")));
  return pane;
}

/** Code that sends a request, by the name the Request tab and the menus show. */
const CODE: [string, (p: Prepared) => string][] = [
  ["cURL", toCurl],
  ["Laravel", toLaravel],
  ["fetch", toFetch],
  ["axios", toAxios],
  ["Guzzle", toGuzzle],
];
let codeShown = "";
/** Whether the Request tab and copying show secrets. They're hidden until you choose Show secrets. */
let showSecrets = false;
const visible = (p: Prepared) => (showSecrets ? p : redact(p));
/** Copies the request as code in one of CODE's languages, as the Request tab shows it. */
function copyAs(p: Prepared, name: string) {
  const make = CODE.find(([n]) => n === name)![1];
  copy(make(visible(p)), `the ${name} code${showSecrets || !hasSecrets(p) ? "" : ", with secrets hidden"}`);
}

function requestView(x: Exchange) {
  const pane = h("div", { class: "http-pane" });
  const select = h("select", { class: "http-code-lang", title: "Language" }, h("option", { value: "", textContent: "cURL and Laravel" }), ...CODE.slice(2).map(([name]) => h("option", { value: name, textContent: name, selected: codeShown === name })));
  const toggle = h("button", { class: "link", textContent: showSecrets ? "Hide secrets" : "Show secrets", onclick: () => ((showSecrets = !showSecrets), renderResponse()) });
  const render = () => {
    const shownCode = CODE.filter(([name], i) => (codeShown ? name === codeShown : i < 2));
    pane.replaceChildren(
      select,
      hasSecrets(x.request) ? h("p", { class: "http-hint http-secrets" }, "Secrets, such as tokens, passwords, and cookies, are hidden here and when you copy. ", toggle) : "",
      x.secrets ? h("p", { class: "http-hint http-secrets" }, "The history file doesn't keep secrets, so they can't be shown. Send Again prepares the request from its file.") : "",
      ...shownCode.flatMap(([name, make]) => {
        const code = make(visible(x.request));
        return [h("h4", {}, `${name} `, h("button", { class: "link", textContent: "Copy", onclick: () => copy(code, `the ${name} code`) })), h("pre", { class: "http-log" }, code)];
      }),
      h("h4", {}, "Feature test ", h("button", { class: "link", textContent: "Generate…", title: "Write a Pest or PHPUnit test that sends this request and checks this response", onclick: () => generateFeatureTest(x) })),
    );
  };
  select.onchange = () => ((codeShown = select.value), render());
  render();
  return pane;
}

// ---- Menus and commands ----

async function preparedCurrent(): Promise<Prepared | null> {
  const r = currentRequest();
  if (!r || !current) return null;
  const s = await scopes(current.path, current.model.getValue());
  return prepare(r, lookupIn(s.list.map((l) => l.vars), s.dotenv), parentOf(current.path), (p) => invoke<string>("read_file", { path: p }));
}

function requestMenu() {
  const withRequest = (fn: (path: string, r: HttpRequest) => unknown) => () => {
    const r = currentRequest();
    if (r && current) fn(current.path, r);
  };
  return [
    { label: "Send with Debugger", run: () => sendCurrent("debug") },
    { label: "Send with Profiler", run: () => sendCurrent("profile") },
    "-" as const,
    ...CODE.map(([name]) => ({ label: name === "Laravel" ? "Copy as Laravel HTTP" : `Copy as ${name}`, run: async () => { const p = await preparedCurrent(); if (p) copyAs(p, name); } })),
    "-" as const,
    { label: "Run All Requests in File", run: () => current && runFile(current.path) },
    { label: "Stress Test…", run: withRequest((path, r) => loadTest(path, r)) },
    { label: "Monitor…", run: withRequest((path, r) => monitor(path, r)) },
    "-" as const,
    { label: "Generate Feature Test…", run: withRequest(async (path, r) => generateFeatureTest(await lastExchange(path, r, shown))) },
    "-" as const,
    { label: "Go to Controller", run: withRequest((_, r) => goToController(r)) },
    { label: "Open in Editor", run: withRequest((path, r) => host.openAt(path, r.line)) },
    { label: "Duplicate", run: withRequest(duplicate) },
    { label: "Delete", run: withRequest(deleteRequest) },
  ];
}

// Set by httpload.ts, which main loads with the rest, to keep the stress test, runner, and monitor in their own module.
let loadTest: (path: string, r: HttpRequest) => unknown = () => {};
let runFile: (path: string) => unknown = () => {};
let monitor: (path: string, r: HttpRequest) => unknown = () => {};
export function setRunners(load: typeof loadTest, run: typeof runFile, watch: typeof monitor) {
  loadTest = load;
  runFile = run;
  monitor = watch;
}

/** The app's routes, read once per project; artisan takes a second or two. */
let routeCache: { root: string; routes: Promise<Route[]> } | null = null;
export function routesList(fresh = false): Promise<Route[]> {
  if (fresh) routeCache = null;
  if (routeCache?.root !== host.root()) {
    const loading = listRoutes(host.root());
    routeCache = { root: host.root(), routes: loading };
    loading.catch(() => (routeCache = null));
  }
  return routeCache.routes;
}

async function goToController(r: HttpRequest) {
  let list: Route[];
  try {
    list = await routesList();
  } catch (e) {
    return host.status(`Couldn't list the routes: ${e instanceof Error ? e.message : String(e).trim()}`);
  }
  const route = matchRoute(r.method, r.url, list);
  if (!route) return host.status(`No route matches ${r.method} ${r.url}.`);
  openRoute(route.action);
}

/**
 * Saves a file after a change from the tool window, such as adding or deleting a request, unless it had unsaved
 * changes before: then it stays unsaved, so the change doesn't save your other edits with it.
 */
async function edited(path: string, wasDirty: boolean) {
  if (!wasDirty) await host.save(path);
  renderRequestTabs();
}

/** Adds text at the end of a file and returns the line it starts on. */
async function append(path: string, text: string) {
  const model = await host.ensureModel(path);
  const dirty = host.isDirty(path);
  const existing = model.getValue();
  const full = model.getFullModelRange();
  let line = 1;
  if (!existing.trim()) model.pushEditOperations([], [{ range: full, text }], () => null);
  else {
    const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    line = full.endLineNumber + sep.length;
    model.pushEditOperations([], [{ range: monaco.Range.fromPositions(full.getEndPosition()), text: sep + text }], () => null);
  }
  await edited(path, dirty);
  return line;
}

export async function httpFiles(): Promise<string[]> {
  const files = await invoke<string[]>("list_files", { root: host.root() });
  return files.filter((f) => /\.(http|rest)$/.test(f)).map((f) => (f.startsWith("/") ? f : `${host.root()}/${f}`));
}

/** Asks which file a new request goes in, offering a new one in http/. */
function chooseCollection(then: (path: string) => unknown) {
  httpFiles().then((files) =>
    pick("Add to which .http file?", (q) => [
      ...files.map((f) => ({ label: relative(f), icon: "codicon-globe", run: () => then(f) })),
      {
        label: q.trim() ? `New file: http/${q.trim().replace(/\.(http|rest)$/, "")}.http` : "New file: type a name, such as posts",
        icon: "codicon-new-file",
        run: async () => {
          const name = q.trim().replace(/\.(http|rest)$/, "");
          if (!name) return;
          const path = `${host.root()}/http/${name}.http`;
          if (!(await invoke<boolean>("path_exists", { path }))) await invoke("create_file", { path, contents: "" });
          then(path);
        },
      },
    ]),
  );
}

export function newRequestInteractive(r: HttpRequest = newRequest({ title: "New request", url: "{{host}}/", headers: [{ name: "Accept", value: "application/json", enabled: true }] })) {
  chooseCollection(async (path) => {
    const line = await append(path, formatRequest(r));
    await openRequest(path, line, true);
    refreshTree();
  });
}

async function duplicate(path: string, r: HttpRequest) {
  const model = await host.ensureModel(path);
  const dirty = host.isDirty(path);
  const copyText = formatRequest({ ...r, title: `${r.title || r.name || "Request"} (copy)`, tags: { ...r.tags, name: undefined } });
  const at = r.end + 1;
  model.pushEditOperations([], [{ range: new monaco.Range(at, 1, at, 1), text: at > model.getLineCount() ? `\n${copyText}` : `${copyText}\n` }], () => null);
  await edited(path, dirty);
  await openRequest(path, at > model.getLineCount() ? model.getLineCount() - 1 : at);
  refreshTree();
}

async function deleteRequest(path: string, r: HttpRequest) {
  if (!(await confirm(`Delete ${r.title || `${r.method} ${r.url}`} from ${relative(path)}?`, "Delete"))) return;
  const model = await host.ensureModel(path);
  const dirty = host.isDirty(path);
  // Its tabs close, without asking: the deletion is the change, and it's saved or kept unsaved below.
  await dropTabsIn(model, r.start, r.end);
  const endLine = Math.min(r.end + 1, model.getLineCount());
  const range = r.end < model.getLineCount() ? new monaco.Range(r.start, 1, endLine, 1) : new monaco.Range(r.start, 1, r.end, model.getLineMaxColumn(r.end));
  model.pushEditOperations([], [{ range, text: "" }], () => null);
  // Unsaved edits that only the deleted request's tabs had are saved with the deletion, rather than left in a file
  // nothing shows.
  await edited(path, dirty && (requestTabs.some((t) => t.path === path) || host.hasTab(path)));
  activate(current);
  host.sessionChanged();
  refreshTree();
}

/** Renames a request in its file, and in its tab's draft, if it has one. */
async function renameRequest(path: string, r: HttpRequest) {
  pick(
    "New title",
    (q) => [
      {
        label: q.trim() ? `Rename to ${q.trim()}` : "Type a title",
        run: async () => {
          const title = q.trim();
          if (!title) return;
          const model = await host.ensureModel(path);
          const block = requestsIn(model).find((x) => x.start <= r.line && r.line <= x.end);
          if (!block) return;
          const dirty = host.isDirty(path);
          for (const t of requestTabs.filter((t) => t.model === model && block.start <= lineOf(t) && lineOf(t) <= block.end && t.draft !== null)) {
            const draft = parseHttp(t.draft!).requests[0];
            if (draft) t.draft = formatRequest({ ...draft, title });
          }
          writeRequest(model, block, { ...structuredClone(block), title });
          await edited(path, dirty);
          if (current) renderRequest();
          refreshTree();
          host.sessionChanged();
        },
      },
    ],
    0,
    { value: r.title },
  );
}

// ---- cURL import ----

// Set by httpteam.ts, which offers imports from other tools too.
let importer: () => unknown = () => showImport();
export const setImporter = (fn: () => unknown) => (importer = fn);

export function showImport() {
  const area = h("textarea", { class: "http-import-text", placeholder: "curl 'https://example.com/api' -H 'Accept: application/json'", spellcheck: false });
  const view = h(
    "div",
    { class: "http-import" },
    h("p", {}, "Paste a curl command, such as from your browser's developer tools (Copy as cURL)."),
    area,
    h(
      "div",
      { class: "http-empty-actions" },
      h("button", {
        class: "primary",
        textContent: "Import",
        onclick: () => {
          const r = fromCurl(area.value);
          if (!r.url) return host.status("Couldn't find a URL in the curl command.");
          r.title = `${r.method} ${r.url.replace(/^https?:\/\/[^/]+/, "").split("?")[0] || "/"}`;
          view.remove();
          main.hidden = !currentRequest();
          empty.hidden = !main.hidden;
          newRequestInteractive(r);
        },
      }),
      h("button", { textContent: "Cancel", onclick: () => (view.remove(), renderRequest()) }),
    ),
  );
  panel.querySelector(".http-import")?.remove();
  panel.prepend(view);
  empty.hidden = main.hidden = true;
  showHttpPanel("HTTP", panel);
  area.focus();
}

// ---- Laravel routes ----

/** Opens Sync with Routes for a file, or asks which. Loaded when first used; it imports this module. */
export const syncRequestsWithRoutes = (path?: string) => import("./httpsync").then((m) => m.syncWithRoutes(path));

/** The app's own routes, without those of debugging and admin packages. */
export const appRoutes = (routes: Route[]) => routes.filter((r) => !/^(_ignition|sanctum|livewire|_debugbar|telescope|horizon|storage)/.test(r.uri.replace(/^\//, "")));

async function requestsFromRoutes() {
  if (!host.root()) return;
  host.status("Reading routes from artisan route:list…");
  let routes: Route[];
  routeCache = null;
  try {
    routes = await routesList();
  } catch (e) {
    return host.status(`Couldn't list the routes: ${e instanceof Error ? e.message : String(e).trim()}`);
  }
  host.status("");
  routes = appRoutes(routes);
  // Bodies come from each route's validation rules, read from its FormRequest or validate() call.
  const withRules = async (r: Route) => requestForRoute(r, /POST|PUT|PATCH/.test(r.method) ? await routeRules(r.action).catch(() => ({})) : {});
  const addAll = async (list: Route[]) => {
    const text = (await Promise.all(list.map(withRules))).map(formatRequest).join("\n");
    chooseCollection(async (path) => {
      const line = await append(path, text);
      await openRequest(path, line);
      refreshTree();
      host.status(`Added ${list.length} requests to ${relative(path)}`);
    });
  };
  const api = routes.filter((r) => r.uri.startsWith("api/"));
  pick("Create a request for which route?", () => [
    { label: "Sync a File with the Routes…", detail: "Add new routes, update bodies, and find requests with no route", icon: "codicon-sync", run: () => syncRequestsWithRoutes() },
    ...(api.length ? [{ label: `All API routes (${api.length})`, icon: "codicon-list-flat", run: () => addAll(api) }] : []),
    { label: `All routes (${routes.length})`, icon: "codicon-list-flat", run: () => addAll(routes) },
    ...routes.map((r) => ({ label: `${r.method.replace("|HEAD", "")} /${r.uri.replace(/^\//, "")}`, detail: r.name ?? r.action, icon: "codicon-symbol-method", run: async () => newRequestInteractive(await withRules(r)) })),
  ]);
}

// ---- The tool window ----

type Collection = { path: string; requests: HttpRequest[] };
let collections: Collection[] = [];
const collapsed = new Set<string>();
let filter = "";

/** Why the .http files couldn't be listed, shown in the tree with Retry. */
let collectionsError = "";
async function loadCollections() {
  const files = await httpFiles().then(
    (list) => ((collectionsError = ""), list),
    (e) => ((collectionsError = errorText(e)), [] as string[]),
  );
  collections = await Promise.all(
    files.sort().map(async (path) => {
      const model = monaco.editor.getModel(monaco.Uri.file(path));
      const text = model ? model.getValue() : await invoke<string>("read_file", { path }).catch(() => "");
      return { path, requests: parseHttp(text).requests };
    }),
  );
}

/** A palette row for every request in the project, which opens it in the HTTP tab. */
export async function requestItems(): Promise<Item[]> {
  if (!host.root()) return [];
  await loadCollections();
  return collections.flatMap((c) =>
    c.requests.map((r) => ({ label: r.title || r.name || `${r.method} ${r.url}`, detail: `${r.method} ${r.url} · ${relative(c.path)}`, icon: "codicon-globe", run: () => openRequest(c.path, r.line) })),
  );
}

export function goToRequest() {
  const items = requestItems();
  pick("Go to request", async (q) => rank(q, await items));
}

export async function refreshTree() {
  if (!host.root() || $("view-http").hidden) return;
  await loadCollections();
  renderTree();
  renderHistory();
  renderEnvironments($("http-sidebar-env") as HTMLSelectElement);
}

function methodBadge(method: string) {
  const short: Record<string, string> = { DELETE: "DEL", OPTIONS: "OPT", GRAPHQL: "GQL", WEBSOCKET: "WS" };
  return h("span", { class: "http-badge", data: { method } }, short[method] ?? method);
}

function renderTree() {
  const list = $("http-requests");
  const q = filter.toLowerCase();
  const items: HTMLElement[] = [];
  for (const c of collections) {
    const requests = c.requests.filter((r) => !q || `${r.name} ${r.title} ${r.method} ${r.url}`.toLowerCase().includes(q));
    if (q && !requests.length) continue;
    const open = !collapsed.has(c.path) || !!q;
    const dirty = host.isDirty(c.path);
    const row = h(
      "div",
      { class: `row http-collection${dirty ? " dirty" : ""}`, title: `${relative(c.path)}${dirty ? " (unsaved changes)" : ""}`, role: "treeitem", ariaLevel: "1", ariaExpanded: String(open), data: { key: c.path } },
      h("span", { class: `chevron codicon codicon-chevron-${open ? "down" : "right"}` }),
      icon("globe"),
      h("span", { class: "name" }, relative(c.path).replace(/\.(http|rest)$/, "")),
      dirty ? h("span", { class: "http-unsaved", ariaLabel: "Unsaved changes" }) : null,
      h("span", { class: "type" }, String(c.requests.length)),
    );
    row.onclick = () => (collapsed.has(c.path) ? collapsed.delete(c.path) : collapsed.add(c.path), renderTree());
    row.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: "Run All Requests", run: () => runFile(c.path) },
        { label: "New Request Here", run: () => append(c.path, formatRequest(newRequest({ title: "New request", url: "{{host}}/" }))).then((line) => openRequest(c.path, line, true)).then(refreshTree) },
        { label: "Sync with Laravel Routes…", run: () => syncRequestsWithRoutes(c.path) },
        ...(dirty ? [{ label: "Save", run: () => host.save(c.path) }] : []),
        "-",
        { label: "Open in Editor", run: () => host.openAt(c.path, 1) },
      ]);
    };
    const children = h("ul", { role: "group" }, ...(open ? requests.map((r) => requestRow(c.path, r)) : []));
    items.push(h("li", { role: "none" }, row, children));
  }
  const message = collectionsError
    ? h("li", { class: "muted", role: "alert" }, `Couldn't list the .http files: ${collectionsError} `, h("button", { class: "link", onclick: () => refreshTree() }, "Retry"))
    : h("li", { class: "muted" }, q ? "No requests match." : "No .http files yet. Create a request with +, import one from cURL, or make them from your Laravel routes.");
  list.replaceChildren(...(items.length ? items : [message]));
  markActive();
}

const renderTreeSoon = debounce(() => renderTree(), 150);

function requestRow(path: string, r: HttpRequest) {
  const title = r.title || r.name || r.url.replace(/^\{\{[^}]+\}\}/, "");
  // Titles made from routes start with the method, which the badge already shows.
  const label = title.startsWith(`${r.method} `) ? title.slice(r.method.length + 1) : title;
  const run = iconButton("play", "Send", () => sendAt(path, r.line));
  run.classList.add("http-row-send");
  const unsaved = requestTabs.some((t) => t.path === path && t.draft !== null && r.start <= lineOf(t) && lineOf(t) <= r.end);
  const row = h(
    "div",
    { class: "row http-request", title: `${r.method} ${r.url}${unsaved ? "\nIts tab has unsaved changes" : ""}`, role: "treeitem", ariaLevel: "2", data: { path, line: String(r.line), key: `${path}:${r.name ? `@${r.name}` : r.line}`, label } },
    methodBadge(r.method),
    h("span", { class: "name" }, label),
    unsaved ? h("span", { class: "http-unsaved", ariaLabel: "Unsaved changes" }) : null,
    run,
  );
  // A click previews the request in a tab that the next click reuses; a double-click keeps the tab open.
  row.onclick = () => openRequest(path, r.line, false, true);
  row.ondblclick = () => openRequest(path, r.line);
  row.oncontextmenu = (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: "Send", keys: "⌘⏎", run: () => sendAt(path, r.line) },
      { label: "Open in Editor", run: () => host.openAt(path, r.line) },
      "-",
      { label: "Rename…", keys: "F2", run: () => renameRequest(path, r) },
      { label: "Duplicate", run: () => duplicate(path, r) },
      { label: "Delete", keys: "⌘⌫", run: () => deleteRequest(path, r) },
      "-",
      { label: "Stress Test…", run: () => loadTest(path, r) },
    ]);
  };
  return h("li", { role: "none" }, row);
}

function markActive() {
  const r = currentRequest();
  document.querySelectorAll<HTMLElement>("#http-requests .http-request").forEach((row) => row.classList.toggle("active", !!r && row.dataset.path === current?.path && Number(row.dataset.line) === r.line));
}

let historyFilter = "";

async function renderHistory() {
  const list = $("http-history");
  const entries = await history();
  $("http-history-count").textContent = entries.length ? String(entries.length) : "";
  const q = historyFilter.toLowerCase();
  // Pinned first, then newest first.
  const matching = entries
    .filter((x) => !q || `${x.request.method} ${x.request.url} ${x.name} ${x.heads.at(-1)?.status ?? ""}`.toLowerCase().includes(q))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.time - a.time);
  list.replaceChildren(
    ...(matching.length
      ? matching.map((x) => {
          const final = x.heads.at(-1);
          const row = h(
            "div",
            { class: "row http-request", title: `${x.request.method} ${x.request.url}\n${new Date(x.time).toLocaleString()}`, role: "option", data: { key: x.id, label: x.request.url.replace(/^https?:\/\/[^/]+/, "") } },
            h("span", { class: `http-code-badge ${statusClass(final?.status ?? 0)}` }, final ? String(final.status) : "ERR"),
            methodBadge(x.request.method),
            h("span", { class: "name" }, x.request.url.replace(/^https?:\/\/[^/]+/, "") || "/"),
            x.pinned ? icon("pinned") : null,
            h("span", { class: "type" }, ago(x.time)),
          );
          row.onclick = () => openExchange(x);
          row.oncontextmenu = (e) => {
            e.preventDefault();
            showMenu(e.clientX, e.clientY, [
              { label: "Send Again", run: () => resendExchange(x) },
              { label: x.pinned ? "Unpin" : "Pin", run: () => setPinned(x.id, !x.pinned) },
              ...(shown && shown.id !== x.id ? [{ label: "Compare with the Shown Response", run: () => compareExchanges(x, shown!) }] : []),
              "-" as const,
              { label: "Copy as cURL", run: () => copyAs(x.request, "cURL") },
              { label: "Copy as Laravel HTTP", run: () => copyAs(x.request, "Laravel") },
            ]);
          };
          return h("li", { role: "none" }, row);
        })
      : [h("li", { class: "muted" }, q ? "No requests match." : "Requests you send show here.")]),
  );
}

/** Sends a history entry's request again exactly as it went, without scripts. */
async function resendExchange(x: Exchange) {
  const tab = await openExchange(x);
  const label = `Sending ${x.request.method} ${x.request.url} again`;
  const retry = () => resendExchange(x);
  if (tab) return sendIn(tab, label, (cancel) => resend(x, cancel), retry);
  // Its request is gone from the file, so there's no tab to show it in progress or cancel it.
  host.status(`${label}…`);
  try {
    showExchange(await resend(x));
    host.status("");
  } catch (e) {
    showError("Couldn't send the request again", e, { label: "Retry", run: retry });
  }
}

async function compareExchanges(a: Exchange, b: Exchange) {
  const [older, newer] = a.time < b.time ? [a, b] : [b, a];
  const text = async (e: Exchange) => {
    if (!e.bodyPath) throw new Error("the history doesn't keep response bodies");
    const body = await invoke<string>("read_file", { path: e.bodyPath });
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  };
  let texts: [string, string];
  try {
    texts = [await text(older), await text(newer)];
  } catch (e) {
    return showError("Couldn't compare the responses", e);
  }
  host.showDiff(newer.bodyPath, ...texts, `${older.request.method} ${older.request.url} at ${new Date(older.time).toLocaleTimeString()} ↔ ${new Date(newer.time).toLocaleTimeString()}`);
}

// ---- Editor integration ----

export function initHttpClient(h_: Host) {
  setHost(h_);
  onHttpChange(() => {
    renderEnvironments(envSelect);
    if (!$("view-http").hidden) refreshTree();
    renderPreview();
  });
  monaco.editor.registerCommand("phpEditor.sendHttp", (_, path: string, line: number) => sendAt(path, line));
  monaco.editor.registerCommand("phpEditor.openHttp", (_, path: string, line: number) => openRequest(path, line));
  monaco.editor.registerCommand("phpEditor.runHttpFile", (_, path: string) => runFile(path));
  monaco.editor.registerCommand("phpEditor.httpEnv", (_, path: string) => selectEnvironment(path));
  const lensesChanged = new monaco.Emitter<monaco.languages.CodeLensProvider>();
  onHttpChange(() => lensesChanged.fire(lenses));
  const lenses: monaco.languages.CodeLensProvider = {
    onDidChange: lensesChanged.event,
    provideCodeLenses: async (model) => {
      const path = model.uri.fsPath;
      const requests = parseHttp(model.getValue()).requests;
      const envs = await environments(path);
      const env = selectedEnvironment(envs);
      const list: monaco.languages.CodeLens[] = requests.flatMap((r) => [
        { range: new monaco.Range(r.line, 1, r.line, 1), command: { id: "phpEditor.sendHttp", title: "▶ Send Request", arguments: [path, r.line] } },
        { range: new monaco.Range(r.line, 1, r.line, 1), command: { id: "phpEditor.openHttp", title: "Open in HTTP Client", arguments: [path, r.line] } },
      ]);
      if (requests.length) {
        const first = new monaco.Range(requests[0].line, 1, requests[0].line, 1);
        list.push({ range: first, command: { id: "phpEditor.httpEnv", title: `Environment: ${env ?? "none"}`, arguments: [path] } });
        if (requests.length > 1) list.push({ range: first, command: { id: "phpEditor.runHttpFile", title: "Run All", arguments: [path] } });
      }
      return { lenses: list, dispose() {} };
    },
  };
  monaco.languages.registerCodeLensProvider("http", lenses);
  monaco.editor.addEditorAction({
    id: "phpEditor.sendHttpAtCursor",
    label: "Send HTTP Request",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
    precondition: "editorLangId == http",
    run: (editor) => {
      const model = editor.getModel();
      if (model) sendAt(model.uri.fsPath, editor.getPosition()?.lineNumber ?? 1);
    },
  });
  // Keep the tool window in step with edits in the editor.
  const changed = debounce(() => refreshTree(), 500);
  monaco.editor.onDidCreateModel((model) => model.getLanguageId() === "http" && model.onDidChangeContent(changed));

  $("http-new").onclick = () => newRequestInteractive();
  $("http-import").onclick = () => importer();
  $("http-routes").onclick = () => requestsFromRoutes();
  $("http-refresh").onclick = () => refreshTree();
  $("http-clear-history").onclick = async () => (await confirm("Clear the HTTP client's history for this project?", "Clear")) && clearHistory();
  const sidebarEnv = $("http-sidebar-env") as HTMLSelectElement;
  sidebarEnv.onchange = () => {
    if (sidebarEnv.value === "\0edit") return (sidebarEnv.value = sidebarEnv.dataset.value ?? ""), editEnvironments(current?.path);
    if (sidebarEnv.value === "\0json") return (sidebarEnv.value = sidebarEnv.dataset.value ?? ""), createEnvironmentFile();
    if (sidebarEnv.value === "\0private") return (sidebarEnv.value = sidebarEnv.dataset.value ?? ""), createEnvironmentFile(PRIVATE_ENV_FILE);
    if (sidebarEnv.value === "\0detect") return (sidebarEnv.value = sidebarEnv.dataset.value ?? ""), detectAppAddress();
    setEnvironment(sidebarEnv.value);
  };
  ($("http-filter") as HTMLInputElement).oninput = (e) => ((filter = (e.target as HTMLInputElement).value), renderTree());
  ($("http-history-filter") as HTMLInputElement).oninput = (e) => ((historyFilter = (e.target as HTMLInputElement).value), renderHistory());
  // The keyboard: ↑↓ and the rest from listNav; Enter opens a request in a lasting tab; ↓ in a filter goes to its list.
  const tree = $("http-requests");
  const treeNav = listNav(tree, {
    open: (row) => (row.dataset.line ? openRequest(row.dataset.path!, Number(row.dataset.line)) : row.click()),
  });
  tree.addEventListener("keydown", (e) => {
    const row = treeNav.selectedRow();
    if (!row?.dataset.line || e.target !== tree) return;
    const c = collections.find((c) => c.path === row.dataset.path);
    const r = c?.requests.find((q) => q.line === Number(row.dataset.line));
    if (!c || !r) return;
    if (e.key === "Enter" && e.metaKey) sendAt(c.path, r.line);
    else if (e.key === "Backspace" && e.metaKey) deleteRequest(c.path, r);
    else if (e.key === "F2") renameRequest(c.path, r);
    else return;
    e.preventDefault();
  });
  const historyList = $("http-history");
  const historyNav = listNav(historyList);
  for (const [input, list, nav] of [["http-filter", tree, treeNav], ["http-history-filter", historyList, historyNav]] as const)
    $(input).addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown") return;
      e.preventDefault();
      list.focus();
      const first = list.querySelector<HTMLElement>("[data-key]");
      if (first && !nav.selectedRow()) nav.select(first.dataset.key!);
    });
  renderResponse();
}

/** Files changed on disk: refresh the tool window when any are .http files or environments. */
export function httpFilesChanged(paths: string[]) {
  if (paths.some((p) => /\.(http|rest)$|http-client(\.private)?\.env\.json$/.test(p))) refreshTree();
}

/** Clears the HTTP tab when another project opens. */
export function resetHttpClient() {
  for (const t of [...requestTabs]) dropTab(t);
  current = null;
  panelOpen = false;
  shown = null;
  collections = [];
  renderRequest();
  renderResponse();
}

/** The global variables scripts set, to show or clear from the palette. */
export function showGlobals() {
  pick("HTTP global variables (set by scripts)", () => [
    ...Object.entries(globals()).map(([k, v]) => ({ label: k, detail: v.length > 80 ? `${v.slice(0, 80)}…` : v, run: () => copy(v, k) })),
    { label: "Clear all", icon: "codicon-trash", run: () => setGlobals({}) },
  ]);
}
