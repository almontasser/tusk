// The HTTP client's interface: the HTTP tool window (every request in the project's .http files, and the history),
// and the HTTP tab, which edits a request as a form and shows its response. The form writes back to the .http file,
// so the file stays the one copy of each request, and edits in the editor show in the form.
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { monaco } from "./editor";
import { showMenu } from "./files";
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
  requestAt,
  scopes,
  selectedEnvironment,
  selectEnvironment,
  send,
  setEnvironment,
  setGlobals,
  setHost,
} from "./httpclient";
import {
  formatRequest,
  fromCurl,
  type Header,
  header,
  type HttpRequest,
  lookupIn,
  METHODS,
  newRequest,
  parseHttp,
  parseSetCookie,
  prepare,
  type Prepared,
  requestForRoute,
  type Route,
  STATUS_TEXT,
  toCurl,
  toLaravel,
} from "./httpfile";
import { confirm, pick } from "./palette";
import { listRoutes } from "./runner";
import { showPanelView } from "./terminal";


export { selectEnvironment };

const $ = (id: string) => document.getElementById(id)!;
type Child = Node | string | null | undefined | false;
type Props<K extends keyof HTMLElementTagNameMap> = Omit<Partial<HTMLElementTagNameMap[K]>, "style"> & { class?: string; style?: string; data?: Record<string, string> };
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {} as Props<K>, ...children: Child[]) {
  const e = document.createElement(tag);
  const { class: className, style, data, ...rest } = props;
  if (className) e.className = className;
  if (style) e.style.cssText = style;
  Object.assign(e, rest);
  for (const [k, v] of Object.entries(data ?? {})) e.dataset[k] = v;
  e.append(...(children.filter((c) => c !== null && c !== undefined && c !== false) as (Node | string)[]));
  return e;
}
export const icon = (name: string) => h("span", { class: `codicon codicon-${name}` });
export const iconButton = (name: string, title: string, onclick: () => unknown) => h("button", { class: "icon-button", title, onclick }, icon(name));
const relative = (path: string) => path.replace(host.root() + "/", "");
const copy = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => host.status(`Copied ${what}`));
const ms = (s: number) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`);
export const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const statusClass = (status: number) => (!status ? "bad" : status >= 400 ? "bad" : status >= 300 ? "redirect" : "good");
function ago(time: number) {
  const s = (Date.now() - time) / 1000;
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(time).toLocaleDateString();
}
function debounce<A extends unknown[]>(fn: (...args: A) => void, wait: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => (clearTimeout(timer), (timer = setTimeout(() => fn(...args), wait)));
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

// ---- The request the HTTP tab edits ----
// A decoration on the request's first line follows it as the file changes, so the tab keeps editing the same
// request when you edit the file above it.

let current: { path: string; model: monaco.editor.ITextModel; decoration: string; listener: monaco.IDisposable } | null = null;
const STICKY = { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges };
/** Moves the decoration that marks the request to `line`. */
function mark(line: number) {
  if (current) current.decoration = current.model.deltaDecorations(current.decoration ? [current.decoration] : [], [{ range: new monaco.Range(line, 1, line, 1), options: STICKY }])[0];
}
let ownEdit = false;
/** The last exchange shown in the response area. */
let shown: Exchange | null = null;
let sending = false;

/** The request the tab edits, parsed from the editor's current text. */
function currentRequest(): HttpRequest | undefined {
  if (!current || current.model.isDisposed()) return undefined;
  const line = current.model.getDecorationRange(current.decoration)?.startLineNumber;
  if (!line) return undefined;
  return parseHttp(current.model.getValue()).requests.find((r) => r.start <= line && line <= r.end);
}

const persistSoon = debounce((path: string) => host.persist(path), 600);

/** Changes the request and writes it back into its file, as one undoable edit. */
function update(change: (r: HttpRequest) => void) {
  const r = currentRequest();
  if (!r || !current) return;
  change(r);
  const model = current.model;
  const text = formatRequest(r).replace(/\n$/, "");
  const range = new monaco.Range(r.start, 1, r.end, model.getLineMaxColumn(r.end));
  // Keep the blank line that separates it from the next request.
  const next = r.end < model.getLineCount() ? "\n" : "";
  ownEdit = true;
  try {
    model.pushEditOperations([], [{ range, text: text + next }], () => null);
  } finally {
    ownEdit = false;
  }
  mark(r.start);
  persistSoon(current.path);
  renderTabLabels();
  renderPreview();
}
const updateSoon = debounce(update, 250);

/** Shows an HTTP view in the panel, growing the panel to half the window the first time, since a form and a response need the room. */
let grown = false;
export function showHttpPanel(title: string, el: HTMLElement) {
  showPanelView(title, el);
  const p = document.getElementById("panel");
  if (!grown && p && p.offsetHeight < innerHeight * 0.45) p.style.height = `${Math.round(innerHeight * 0.45)}px`;
  grown = true;
}

/** Shows a request in the HTTP tab. `line` is any line of its block. */
export async function openRequest(path: string, line: number, focusUrl = false) {
  const model = await host.ensureModel(path);
  const r = parseHttp(model.getValue()).requests.find((q) => q.start <= line && line <= q.end);
  if (!r) return;
  if (current?.model !== model) {
    if (current && !current.model.isDisposed()) current.model.deltaDecorations([current.decoration], []);
    current?.listener.dispose();
    const listener = model.onDidChangeContent(() => !ownEdit && refreshFromFile());
    current = { path, model, decoration: "", listener };
  }
  current.path = path;
  mark(r.start);
  renderRequest();
  showHttpPanel("HTTP", panel);
  // Show the request's last response, if the history has one.
  const same = (x: Exchange) => x.path === path && (r.name ? x.name === r.name : x.line === r.line);
  if (!shown || !same(shown))
    history().then((list) => {
      const last = list.find(same);
      if (last) showExchange(last);
      else (shown = null), renderResponse();
    });
  if (focusUrl) urlInput.focus();
  markActive();
}

/** After an edit in the editor, shows the new text, unless you're typing in the form. */
const refreshFromFile = debounce(() => {
  if (panel.contains(document.activeElement) && document.activeElement !== document.body) return;
  renderRequest();
  refreshTree();
}, 200);

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
const divider = h("div", { class: "http-divider" });
const empty = h(
  "div",
  { class: "http-empty" },
  h("p", {}, "Choose a request in the HTTP tool window, or create one. Requests are saved in .http files in the project, so your team can use them too."),
  h("div", { class: "http-empty-actions" }, h("button", { class: "primary", onclick: () => newRequestInteractive() }, "New Request"), h("button", { onclick: () => showImport() }, "Import cURL…"), h("button", { onclick: () => requestsFromRoutes() }, "From Laravel Routes…")),
);
const main = h("div", { class: "http-main" }, h("div", { class: "http-bar" }, methodSelect, h("div", { class: "http-url-box" }, urlInput, urlPreview), sendButton, moreButton, envSelect), h("div", { class: "http-split" }, reqPane, divider, resPane));
panel.append(empty, main);

methodSelect.onchange = () => update((r) => (r.method = methodSelect.value));
urlInput.oninput = () => {
  updateSoon((r) => (r.url = urlInput.value.trim()));
  if (reqTab === "params") renderReqTab();
};
sendButton.onclick = () => sendCurrent();
envSelect.onchange = () => {
  if (envSelect.value === "\0edit") return (envSelect.value = envSelect.dataset.value ?? ""), createEnvironmentFile();
  if (envSelect.value === "\0private") return (envSelect.value = envSelect.dataset.value ?? ""), createEnvironmentFile(PRIVATE_ENV_FILE);
  setEnvironment(envSelect.value);
};
panel.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.metaKey) {
    e.preventDefault();
    e.stopPropagation();
    sendCurrent();
  }
});
divider.onmousedown = (down) => {
  down.preventDefault();
  const start = reqPane.offsetWidth;
  const total = reqPane.parentElement!.offsetWidth;
  const move = (e: MouseEvent) => (reqPane.style.flexBasis = `${Math.min(total - 200, Math.max(240, start + e.clientX - down.clientX))}px`);
  const up = () => (removeEventListener("mousemove", move), removeEventListener("mouseup", up));
  addEventListener("mousemove", move);
  addEventListener("mouseup", up);
};

async function renderEnvironments(select: HTMLSelectElement) {
  if (!host.root()) return;
  const envs = await environments(current?.path ?? "");
  const selected = selectedEnvironment(envs) ?? "";
  select.replaceChildren(
    ...(Object.keys(envs).length ? Object.keys(envs).map((name) => h("option", { value: name, textContent: name })) : [h("option", { value: "", textContent: "No environment" })]),
    h("option", { value: "\0edit", textContent: "Edit Environments…" }),
    h("option", { value: "\0private", textContent: "Edit Private Environments…" }),
  );
  select.value = selected;
  select.dataset.value = selected;
}

function renderRequest() {
  const r = currentRequest();
  empty.hidden = !!r;
  main.hidden = !r;
  if (!r) return;
  if (document.activeElement !== urlInput) urlInput.value = r.url;
  methodSelect.value = METHODS.includes(r.method) ? r.method : "GET";
  methodSelect.dataset.method = r.method;
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
    ["auth", `Auth${header(r, "authorization") ? " •" : ""}`],
    ["scripts", `Scripts${scripts ? ` ${scripts}` : ""}`],
    ["settings", "Settings"],
  ];
  reqTabs.replaceChildren(...labels.map(([id, label]) => h("button", { role: "tab", textContent: label, ariaSelected: String(id === reqTab), onclick: () => ((reqTab = id), renderTabLabels(), renderReqTab()) })));
}

function renderReqTab() {
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

function bodyTab(r: HttpRequest) {
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
  const kind = !value ? "none" : /^Bearer\s/i.test(value) ? "bearer" : /^Basic\s+\S+\s+\S+$/i.test(value) ? "basic" : "other";
  const select = h("select", {}, h("option", { value: "none", textContent: "No auth" }), h("option", { value: "bearer", textContent: "Bearer token" }), h("option", { value: "basic", textContent: "Basic (user and password)" }), kind === "other" ? h("option", { value: "other", textContent: "Custom Authorization header" }) : null);
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
    } else if (k === "other") fields.append(h("p", { class: "http-hint" }, `Authorization: ${value}. Edit it in Headers.`));
  };
  select.onchange = () => {
    if (select.value === "none") set(null);
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
  return h(
    "div",
    { class: "http-pane http-scripts" },
    section("pre"),
    section("handler"),
    h("p", { class: "http-hint" }, "JavaScript, as in PhpStorm: client.global.set(name, value) keeps a value for later requests as {{name}}; client.test(name, fn) and client.assert(condition, message) report tests; response.status, response.body (parsed JSON), response.headers.valueOf(name); request.variables.set(name, value) before sending; jsonPath(value, \"$.a.b\")."),
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
    text("Save the response to", r.output?.path ?? "", "./responses/result.json", (q, v) => (q.output = v ? { path: v, force: q.output?.force ?? false } : undefined)),
    r.output ? check("Replace the file instead of adding a number", r.output.force, (q, v) => q.output && (q.output.force = v)) : null,
  );
}

// ---- Sending ----

async function sendCurrent() {
  const r = currentRequest();
  if (!r || !current || sending) return;
  sending = true;
  sendButton.disabled = true;
  sendButton.replaceChildren(icon("loading codicon-modifier-spin"), "Sending");
  resSummary.replaceChildren(h("span", { class: "muted" }, `${r.method} ${r.url} …`));
  try {
    showExchange(await send(current.path, r));
  } catch (e) {
    resSummary.replaceChildren(h("span", { class: "http-error" }, `Couldn't send the request: ${e}`));
  } finally {
    sending = false;
    sendButton.disabled = false;
    sendButton.replaceChildren(icon("play"), "Send");
  }
}

/** Shows an exchange, such as one the runner sent, with its request. */
export async function openExchange(x: Exchange) {
  const { request } = await requestAt(x.path, x.line).catch(() => ({ request: undefined }));
  if (request) await openRequest(x.path, request.line);
  else showHttpPanel("HTTP", panel);
  showExchange(x);
}

/** Sends the request in `path` at `line`, as from the editor, showing it in the HTTP tab. */
export async function sendAt(path: string, line: number) {
  await openRequest(path, line);
  await sendCurrent();
}

// ---- Response ----

type ResTab = "body" | "headers" | "cookies" | "timing" | "tests" | "request";
let resTab: ResTab = "body";
let bodyMode: "pretty" | "raw" | "preview" = "pretty";
let responseEditor: monaco.editor.IStandaloneCodeEditor | null = null;
const MAX_SHOWN = 5 * 1024 * 1024;

function showExchange(x: Exchange) {
  shown = x;
  const final = x.heads.at(-1);
  const status = final?.status ?? 0;
  const pill = h("span", { class: `http-status ${statusClass(status)}` }, x.error && !final ? "Failed" : `${status} ${final?.statusText || STATUS_TEXT[status] || ""}`.trim());
  resSummary.replaceChildren(
    pill,
    x.info ? h("span", { class: "http-stat", title: "Total time" }, ms(x.info.time_total)) : "",
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
    ["request", "Request"],
  ];
  resTabs.replaceChildren(...labels.map(([id, label]) => h("button", { role: "tab", textContent: label, ariaSelected: String(id === resTab), onclick: () => ((resTab = id), renderResponse()) })));
  responseEditor?.getModel()?.dispose();
  responseEditor?.dispose();
  responseEditor = null;
  const content = { body: bodyView, headers: headersView, cookies: cookiesView, timing: timingView, tests: testsView, request: requestView }[resTab](x);
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
    iconButton("copy", "Copy the body", async () => copy(await invoke<string>("read_file", { path: x.bodyPath }), "the response body")),
    iconButton("save", "Save the body as…", async () => {
      const to = await save({ defaultPath: `${host.root()}/${x.bodyPath.split("/").pop()!.replace(/^[^.]+/, "response")}` });
      if (to) await invoke("run_capture", { cwd: "/", program: "/bin/cp", args: [x.bodyPath, to], input: null }).then(() => host.status(`Saved ${to}`), (e) => host.status(`Couldn't save the body: ${e}`));
    }),
    iconButton("go-to-file", "Open the body in an editor tab", () => host.openAt(x.bodyPath, 1)),
  );
  pane.append(bar);
  const size = x.info?.size_download ?? 0;
  if (!x.heads.length) return pane.append(h("p", { class: "http-hint" }, "No response.")), pane;
  if (!size) return pane.append(h("p", { class: "http-hint" }, "The response has no body.")), pane;
  if (bodyMode === "preview") {
    if (image || /pdf/.test(type)) {
      invoke<string>("run_capture", { cwd: "/", program: "/usr/bin/base64", args: ["-i", x.bodyPath], input: null }).then((b64) => {
        const src = `data:${type.split(";")[0]};base64,${b64.replace(/\s/g, "")}`;
        pane.append(image ? h("div", { class: "http-image" }, h("img", { src, alt: "Response image" })) : h("iframe", { class: "http-preview", src }));
      });
    } else
      invoke<string>("read_file", { path: x.bodyPath }).then((html) => {
        // No scripts: the page renders as HTML only, with links resolving against the request's URL.
        const frame = h("iframe", { class: "http-preview" });
        frame.setAttribute("sandbox", "");
        frame.srcdoc = `<base href="${(x.info?.url_effective ?? x.request.url).replace(/"/g, "&quot;")}">${html}`;
        pane.append(frame);
      });
    return pane;
  }
  if (!isText(type)) return pane.append(h("p", { class: "http-hint" }, `A ${bytes(size)} ${type || "binary"} body. Save it, or open it in an editor tab.`)), pane;
  if (size > MAX_SHOWN) return pane.append(h("p", { class: "http-hint" }, `The body is ${bytes(size)}, too large to show here. Open it in an editor tab.`)), pane;
  const el = h("div", { class: "http-code http-response-code" });
  pane.append(el);
  invoke<string>("read_file", { path: x.bodyPath }).then((text) => {
    if (shown !== x || !el.isConnected) return;
    let value = text;
    if (bodyMode === "pretty" && /json/.test(type)) {
      try {
        value = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Show it as it came.
      }
    }
    responseEditor = monaco.editor.create(el, { ...EDITOR_OPTIONS, readOnly: true, lineNumbers: "on", model: monaco.editor.createModel(value, bodyMode === "raw" ? "plaintext" : languageFor(type)), wordWrap: bodyMode === "raw" ? "on" : "off" });
  });
  return pane;
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

function requestView(x: Exchange) {
  const curl = toCurl(x.request);
  const laravel = toLaravel(x.request);
  return h(
    "div",
    { class: "http-pane" },
    h("h4", {}, "cURL ", h("button", { class: "link", textContent: "Copy", onclick: () => copy(curl, "the curl command") })),
    h("pre", { class: "http-log" }, curl),
    h("h4", {}, "Laravel ", h("button", { class: "link", textContent: "Copy", onclick: () => copy(laravel, "the Laravel code") })),
    h("pre", { class: "http-log" }, laravel),
  );
}

// ---- Menus and commands ----

async function preparedCurrent(): Promise<Prepared | null> {
  const r = currentRequest();
  if (!r || !current) return null;
  const s = await scopes(current.path, current.model.getValue());
  return prepare(r, lookupIn(s.list.map((l) => l.vars), s.dotenv), parentOf(current.path), (p) => invoke<string>("read_file", { path: p }));
}

function requestMenu() {
  return [
    { label: "Copy as cURL", run: async () => { const p = await preparedCurrent(); if (p) copy(toCurl(p), "the curl command"); } },
    { label: "Copy as Laravel HTTP", run: async () => { const p = await preparedCurrent(); if (p) copy(toLaravel(p), "the Laravel code"); } },
    "-" as const,
    { label: "Stress Test…", run: () => { const r = currentRequest(); if (r && current) loadTest(current.path, r); } },
    { label: "Run All Requests in File", run: () => current && runFile(current.path) },
    "-" as const,
    { label: "Open in Editor", run: () => { const r = currentRequest(); if (r && current) host.openAt(current.path, r.line); } },
    { label: "Duplicate", run: () => { const r = currentRequest(); if (r && current) duplicate(current.path, r); } },
    { label: "Delete", run: () => { const r = currentRequest(); if (r && current) deleteRequest(current.path, r); } },
  ];
}

// Set by httpload.ts, which main loads with the rest, to keep the stress test and the runner in their own module.
let loadTest: (path: string, r: HttpRequest) => unknown = () => {};
let runFile: (path: string) => unknown = () => {};
export function setRunners(load: typeof loadTest, run: typeof runFile) {
  loadTest = load;
  runFile = run;
}

/** Adds text at the end of a file and returns the line it starts on. */
async function append(path: string, text: string) {
  const model = await host.ensureModel(path);
  const existing = model.getValue();
  const full = model.getFullModelRange();
  let line = 1;
  if (!existing.trim()) model.pushEditOperations([], [{ range: full, text }], () => null);
  else {
    const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    line = full.endLineNumber + sep.length;
    model.pushEditOperations([], [{ range: monaco.Range.fromPositions(full.getEndPosition()), text: sep + text }], () => null);
  }
  await host.persist(path);
  return line;
}

async function httpFiles(): Promise<string[]> {
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
  const copyText = formatRequest({ ...r, title: `${r.title || r.name || "Request"} (copy)`, tags: { ...r.tags, name: undefined } });
  const at = r.end + 1;
  model.pushEditOperations([], [{ range: new monaco.Range(at, 1, at, 1), text: at > model.getLineCount() ? `\n${copyText}` : `${copyText}\n` }], () => null);
  await host.persist(path);
  await openRequest(path, at > model.getLineCount() ? model.getLineCount() - 1 : at);
  refreshTree();
}

async function deleteRequest(path: string, r: HttpRequest) {
  if (!(await confirm(`Delete ${r.title || `${r.method} ${r.url}`} from ${relative(path)}?`, "Delete"))) return;
  const model = await host.ensureModel(path);
  const endLine = Math.min(r.end + 1, model.getLineCount());
  const range = r.end < model.getLineCount() ? new monaco.Range(r.start, 1, endLine, 1) : new monaco.Range(r.start, 1, r.end, model.getLineMaxColumn(r.end));
  model.pushEditOperations([], [{ range, text: "" }], () => null);
  await host.persist(path);
  if (current?.path === path) renderRequest();
  refreshTree();
}

async function renameRequest(path: string, r: HttpRequest) {
  pick(
    "New title",
    (q) => [{ label: q.trim() ? `Rename to ${q.trim()}` : "Type a title", run: async () => { if (!q.trim()) return; await openRequest(path, r.line); update((x) => (x.title = q.trim())); refreshTree(); } }],
    0,
    { value: r.title },
  );
}

// ---- cURL import ----

function showImport() {
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

async function requestsFromRoutes() {
  if (!host.root()) return;
  host.status("Reading routes from artisan route:list…");
  let routes: Route[];
  try {
    routes = await listRoutes(host.root());
  } catch (e) {
    return host.status(`Couldn't list the routes: ${e instanceof Error ? e.message : String(e).trim()}`);
  }
  host.status("");
  routes = routes.filter((r) => !/^(_ignition|sanctum|livewire|_debugbar|telescope|horizon|storage)/.test(r.uri.replace(/^\//, "")));
  const addAll = (list: Route[]) => {
    const text = list.map((r) => formatRequest(requestForRoute(r))).join("\n");
    chooseCollection(async (path) => {
      const line = await append(path, text);
      await openRequest(path, line);
      refreshTree();
      host.status(`Added ${list.length} requests to ${relative(path)}`);
    });
  };
  const api = routes.filter((r) => r.uri.startsWith("api/"));
  pick("Create a request for which route?", () => [
    ...(api.length ? [{ label: `All API routes (${api.length})`, icon: "codicon-list-flat", run: () => addAll(api) }] : []),
    { label: `All routes (${routes.length})`, icon: "codicon-list-flat", run: () => addAll(routes) },
    ...routes.map((r) => ({ label: `${r.method.replace("|HEAD", "")} /${r.uri.replace(/^\//, "")}`, detail: r.name ?? r.action, icon: "codicon-symbol-method", run: () => newRequestInteractive(requestForRoute(r)) })),
  ]);
}

// ---- The tool window ----

type Collection = { path: string; requests: HttpRequest[] };
let collections: Collection[] = [];
const collapsed = new Set<string>();
let filter = "";

async function loadCollections() {
  const files = await httpFiles().catch(() => []);
  collections = await Promise.all(
    files.sort().map(async (path) => {
      const model = monaco.editor.getModel(monaco.Uri.file(path));
      const text = model ? model.getValue() : await invoke<string>("read_file", { path }).catch(() => "");
      return { path, requests: parseHttp(text).requests };
    }),
  );
}

export async function refreshTree() {
  if (!host.root() || $("view-http").hidden) return;
  await loadCollections();
  renderTree();
  renderHistory();
  renderEnvironments($("http-sidebar-env") as HTMLSelectElement);
}

function methodBadge(method: string) {
  return h("span", { class: "http-badge", data: { method } }, method === "DELETE" ? "DEL" : method === "OPTIONS" ? "OPT" : method);
}

function renderTree() {
  const list = $("http-requests");
  const q = filter.toLowerCase();
  const items: HTMLElement[] = [];
  for (const c of collections) {
    const requests = c.requests.filter((r) => !q || `${r.name} ${r.title} ${r.method} ${r.url}`.toLowerCase().includes(q));
    if (q && !requests.length) continue;
    const open = !collapsed.has(c.path) || !!q;
    const row = h("div", { class: "row http-collection", title: relative(c.path) }, h("span", { class: `chevron codicon codicon-chevron-${open ? "down" : "right"}` }), icon("globe"), h("span", { class: "name" }, relative(c.path).replace(/\.(http|rest)$/, "")), h("span", { class: "type" }, String(c.requests.length)));
    row.onclick = () => (collapsed.has(c.path) ? collapsed.delete(c.path) : collapsed.add(c.path), renderTree());
    row.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: "New Request Here", run: () => append(c.path, formatRequest(newRequest({ title: "New request", url: "{{host}}/" }))).then((line) => openRequest(c.path, line, true)).then(refreshTree) },
        { label: "Run All Requests", run: () => runFile(c.path) },
        "-",
        { label: "Open in Editor", run: () => host.openAt(c.path, 1) },
      ]);
    };
    const children = h("ul", {}, ...(open ? requests.map((r) => requestRow(c.path, r)) : []));
    items.push(h("li", {}, row, children));
  }
  list.replaceChildren(...(items.length ? items : [h("li", { class: "muted" }, q ? "No requests match." : "No .http files yet. Create a request with +, import one from cURL, or make them from your Laravel routes.")]));
  markActive();
}

function requestRow(path: string, r: HttpRequest) {
  const label = r.title || r.name || r.url.replace(/^\{\{[^}]+\}\}/, "");
  const run = iconButton("play", "Send", () => sendAt(path, r.line));
  run.classList.add("http-row-send");
  const row = h("div", { class: "row http-request", title: `${r.method} ${r.url}`, data: { path, line: String(r.line) } }, methodBadge(r.method), h("span", { class: "name" }, label), run);
  row.onclick = () => openRequest(path, r.line);
  row.ondblclick = () => host.openAt(path, r.line);
  row.oncontextmenu = (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: "Send", run: () => sendAt(path, r.line) },
      { label: "Open in Editor", run: () => host.openAt(path, r.line) },
      "-",
      { label: "Rename…", run: () => renameRequest(path, r) },
      { label: "Duplicate", run: () => duplicate(path, r) },
      { label: "Delete", run: () => deleteRequest(path, r) },
      "-",
      { label: "Stress Test…", run: () => loadTest(path, r) },
    ]);
  };
  return h("li", {}, row);
}

function markActive() {
  const r = currentRequest();
  document.querySelectorAll<HTMLElement>("#http-requests .http-request").forEach((row) => row.classList.toggle("active", !!r && row.dataset.path === current?.path && Number(row.dataset.line) === r.line));
}

async function renderHistory() {
  const list = $("http-history");
  const entries = await history();
  $("http-history-count").textContent = entries.length ? String(entries.length) : "";
  list.replaceChildren(
    ...(entries.length
      ? entries.slice(0, 50).map((x) => {
          const final = x.heads.at(-1);
          const row = h(
            "div",
            { class: "row http-request", title: `${x.request.method} ${x.request.url}\n${new Date(x.time).toLocaleString()}` },
            h("span", { class: `http-code-badge ${statusClass(final?.status ?? 0)}` }, final ? String(final.status) : "ERR"),
            methodBadge(x.request.method),
            h("span", { class: "name" }, x.request.url.replace(/^https?:\/\/[^/]+/, "") || "/"),
            h("span", { class: "type" }, ago(x.time)),
          );
          row.onclick = () => openExchange(x);
          return h("li", {}, row);
        })
      : [h("li", { class: "muted" }, "Requests you send show here.")]),
  );
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
  $("http-import").onclick = () => showImport();
  $("http-routes").onclick = () => requestsFromRoutes();
  $("http-refresh").onclick = () => refreshTree();
  $("http-clear-history").onclick = async () => (await confirm("Clear the HTTP client's history for this project?", "Clear")) && clearHistory();
  const sidebarEnv = $("http-sidebar-env") as HTMLSelectElement;
  sidebarEnv.onchange = () => {
    if (sidebarEnv.value === "\0edit") return (sidebarEnv.value = sidebarEnv.dataset.value ?? ""), createEnvironmentFile();
    if (sidebarEnv.value === "\0private") return (sidebarEnv.value = sidebarEnv.dataset.value ?? ""), createEnvironmentFile(PRIVATE_ENV_FILE);
    setEnvironment(sidebarEnv.value);
  };
  ($("http-filter") as HTMLInputElement).oninput = (e) => ((filter = (e.target as HTMLInputElement).value), renderTree());
  renderResponse();
}

/** Files changed on disk: refresh the tool window when any are .http files or environments. */
export function httpFilesChanged(paths: string[]) {
  if (paths.some((p) => /\.(http|rest)$|http-client(\.private)?\.env\.json$/.test(p))) refreshTree();
}

/** Clears the HTTP tab when another project opens. */
export function resetHttpClient() {
  current?.listener.dispose();
  current = null;
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
