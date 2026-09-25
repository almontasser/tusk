// HTTP client for .http files, which live in the project so the team shares them. Requests go through macOS's
// curl, so there's nothing to bundle and no browser CORS rules. This module sends requests, keeps variables,
// cookies, and history, and registers the `http` language; httpview.ts is the HTTP tab and the tool window.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { appCacheDir } from "@tauri-apps/api/path";
import { parseEnv } from "./dbconfig";
import { monaco } from "./editor";
import {
  curlArgs,
  type HttpRequest,
  INFO_MARKER,
  lookupIn,
  parseHeaderDump,
  parseHttp,
  prepare,
  type Prepared,
  type ResponseHead,
  type Script,
} from "./httpfile";
import type { Output, Test } from "./httpscript.worker";
import ScriptWorker from "./httpscript.worker?worker";
import { pick } from "./palette";

export type Host = {
  root(): string;
  status(text: string): void;
  openAt(path: string, line: number): Promise<unknown>;
  ensureModel(path: string): Promise<monaco.editor.ITextModel>;
  /** Saves a model edited from the HTTP tab. */
  persist(path: string): Promise<unknown>;
  profiler(): Promise<typeof import("./profiler")>;
  showDiff(path: string, original: string, modified: string, label: string): unknown;
};
export type Environments = Record<string, Record<string, string>>;

/** What curl reports about a transfer (its --write-out JSON), in seconds and bytes. */
export type CurlInfo = {
  time_namelookup: number;
  time_connect: number;
  time_appconnect: number;
  time_pretransfer: number;
  time_starttransfer: number;
  time_total: number;
  size_download: number;
  size_upload: number;
  remote_ip: string;
  remote_port: number;
  http_version: string;
  num_redirects: number;
  url_effective: string;
  errormsg: string | null;
  exitcode: number;
};

/** A request that was sent, and its response. History keeps these, without the body, which stays in `bodyPath`. */
export type Exchange = {
  id: string;
  time: number;
  /** The .http file, and the request's name and line in it when it was sent. */
  path: string;
  name: string;
  line: number;
  env?: string;
  request: Prepared;
  /** One per response, such as each redirect; the last is the final response. Empty when curl failed. */
  heads: ResponseHead[];
  info?: CurlInfo;
  bodyPath: string;
  contentType: string;
  tests: Test[];
  logs: string[];
  error?: string;
  /** Names used in the request that no environment, file, or script defines. */
  unresolved: string[];
  /** Pinned exchanges stay in the history past its limit. */
  pinned?: boolean;
};

export let host: Host;
export const setHost = (h: Host) => (host = h);
export const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
const projectKey = () => host.root().replace(/[^A-Za-z0-9]+/g, "_");
const storageKey = (kind: string) => `http${kind}:${host.root()}`;
function stored<T>(kind: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(storageKey(kind)) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
function store(kind: string, value: unknown) {
  try {
    localStorage.setItem(storageKey(kind), JSON.stringify(value));
  } catch {
    // Lasts until reload.
  }
}
const listeners = new Set<() => void>();
/** Runs `fn` when the environment, global variables, or history change. */
export const onHttpChange = (fn: () => void) => listeners.add(fn);
export const changed = () => listeners.forEach((fn) => fn());

// ---- Environments and variables ----

export const ENV_FILE = "http-client.env.json";
export const PRIVATE_ENV_FILE = "http-client.private.env.json";

/** The folder whose environment files apply to an .http file: its own folder when it has one, or else the project root. */
export async function environmentDir(path: string) {
  for (const dir of [parentOf(path), host.root()]) {
    const found = await invoke<boolean[]>("paths_exist", { paths: [`${dir}/${ENV_FILE}`, `${dir}/${PRIVATE_ENV_FILE}`] }).catch(() => [false, false]);
    if (found.some(Boolean)) return dir;
  }
  return host.root();
}

/** Environments for an .http file (or the project root's, for ""). Private values override shared ones. */
export async function environments(path = ""): Promise<Environments> {
  const dir = path ? await environmentDir(path) : host.root();
  const read = (name: string) =>
    invoke<string>("read_file", { path: `${dir}/${name}` })
      .then((t) => JSON.parse(t) as Environments)
      .catch(() => null);
  const [shared, secret] = await Promise.all([read(ENV_FILE), read(PRIVATE_ENV_FILE)]);
  const merged: Environments = {};
  for (const [env, vars] of [...Object.entries(shared ?? {}), ...Object.entries(secret ?? {})]) {
    // PhpStorm's $shared environment applies to every other one.
    if (env !== "$shared") merged[env] = { ...merged[env], ...Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v)])) };
  }
  const common = { ...shared?.$shared, ...secret?.$shared };
  for (const env of Object.keys(merged)) merged[env] = { ...common, ...merged[env] };
  return merged;
}

export function selectedEnvironment(envs: Environments): string | undefined {
  const saved = stored<string | null>("Env", null);
  return saved && saved in envs ? saved : Object.keys(envs)[0];
}

export function setEnvironment(name: string) {
  store("Env", name);
  host.status(`HTTP environment: ${name}`);
  changed();
}

export async function selectEnvironment(path = "") {
  const envs = await environments(path);
  if (!Object.keys(envs).length) return createEnvironmentFile();
  pick("HTTP client environment", () =>
    Object.keys(envs).map((name) => ({
      label: name,
      detail: name === selectedEnvironment(envs) ? "Selected" : Object.keys(envs[name]).join(", "),
      run: () => setEnvironment(name),
    })),
  );
}

/** Opens the project's environment file, creating it with a `local` environment for the app's URL from .env. */
export async function createEnvironmentFile(file = ENV_FILE) {
  const path = `${host.root()}/${file}`;
  if (!(await invoke<boolean>("path_exists", { path }))) {
    const url = (await dotenv()).APP_URL || "http://localhost:8000";
    const contents = file === ENV_FILE ? { local: { host: url } } : { local: { token: "" } };
    await invoke("create_file", { path, contents: JSON.stringify(contents, null, 2) + "\n" });
    if (file === PRIVATE_ENV_FILE) await ignorePrivateFile();
  }
  await host.openAt(path, 1);
}

/** Saves values to an environment in the private environment file that applies to `path`, creating it if needed. */
export async function saveToPrivateEnvironment(path: string, env: string, values: Record<string, string>) {
  const file = `${await environmentDir(path)}/${PRIVATE_ENV_FILE}`;
  const existing = await invoke<string>("read_file", { path: file })
    .then((t) => JSON.parse(t) as Environments)
    .catch(() => ({}) as Environments);
  existing[env] = { ...existing[env], ...values };
  await invoke("write_file", { path: file, contents: JSON.stringify(existing, null, 2) + "\n" });
  await ignorePrivateFile();
  if (!stored<string | null>("Env", null)) store("Env", env);
  changed();
}

/** Adds the private environment file to .gitignore, since it holds secrets. */
export async function ignorePrivateFile() {
  const path = `${host.root()}/.gitignore`;
  const text = await invoke<string>("read_file", { path }).catch(() => null);
  if (text === null || text.split("\n").some((l) => l.trim().replace(/^\//, "") === PRIVATE_ENV_FILE)) return;
  await invoke("write_file", { path, contents: `${text.replace(/\n*$/, "\n")}${PRIVATE_ENV_FILE}\n` });
  host.status(`Added ${PRIVATE_ENV_FILE} to .gitignore`);
}

export const dotenv = () =>
  invoke<string>("read_file", { path: `${host.root()}/.env` })
    .then(parseEnv)
    .catch(() => ({}) as Record<string, string>);

/** Variables scripts set with client.global.set, kept per project until you clear them. */
export const globals = () => stored<Record<string, string>>("Globals", {});
export function setGlobals(values: Record<string, string>) {
  store("Globals", values);
  changed();
}

/** Every variable a request in `path` can use, first match first, with where each comes from. */
export async function scopes(path: string, text: string) {
  const envs = await environments(path);
  const env = selectedEnvironment(envs);
  return {
    env,
    envs,
    dotenv: await dotenv(),
    list: [
      { label: "Global (set by a script)", vars: globals() },
      { label: "File", vars: parseHttp(text).vars },
      { label: env ? `Environment: ${env}` : "Environment", vars: env ? envs[env] : {} },
    ],
  };
}

// ---- Scripts ----

/** Runs a script in a worker, stopping it after 5 seconds. */
async function runScript(script: Script, dir: string, input: Omit<Parameters<typeof postScript>[0], "code">): Promise<Output> {
  const code = script.file ? await invoke<string>("read_file", { path: script.file.startsWith("/") ? script.file : `${dir}/${script.file.replace(/^\.\//, "")}` }).catch((e) => `throw new Error(${JSON.stringify(`Can't read ${script.file}: ${e}`)})`) : (script.code ?? "");
  return postScript({ ...input, code });
}

function postScript(input: { code: string; globals: Record<string, string>; variables: Record<string, string>; environment: Record<string, string>; request: { method: string; url: string; headers: [string, string][]; body: string }; response?: { status: number; headers: [string, string][]; body: string; contentType: string; time?: number } }): Promise<Output> {
  const worker = new ScriptWorker();
  return new Promise<Output>((resolve) => {
    const fail = (error: string) => resolve({ globals: input.globals, variables: input.variables, tests: [], logs: [], error });
    const timer = setTimeout(() => fail("The script ran for more than 5 seconds and was stopped."), 5000);
    worker.onmessage = (e: MessageEvent<Output>) => (clearTimeout(timer), resolve(e.data));
    worker.onerror = (e) => (clearTimeout(timer), fail(e.message));
    worker.postMessage(input);
  }).finally(() => worker.terminate());
}

// ---- Sending ----

/** A request with the variables it can use replaced, without running its scripts. */
export async function prepareRequest(path: string, request: HttpRequest) {
  const model = await host.ensureModel(path);
  const s = await scopes(path, model.getValue());
  return { env: s.env, prepared: await prepare(request, lookupIn(s.list.map((l) => l.vars), s.dotenv), parentOf(path), (p) => invoke<string>("read_file", { path: p })) };
}

/** Where the project's cookies for an environment are kept. */
export const cookieJar = async (env = "default") => `${await cacheDir("http-cookies")}/${env.replace(/[^\w-]+/g, "_")}.txt`;

export const cacheDir = async (kind: string) => `${await appCacheDir()}/${kind}/${projectKey()}`;
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const EXTENSIONS: [RegExp, string][] = [
  [/json/, "json"],
  [/html/, "html"],
  [/xml/, "xml"],
  [/javascript/, "js"],
  [/css/, "css"],
  [/^text\//, "txt"],
  [/image\/png/, "png"],
  [/image\/jpe?g/, "jpg"],
  [/image\/gif/, "gif"],
  [/image\/svg/, "svg"],
  [/image\/webp/, "webp"],
  [/pdf/, "pdf"],
];
const extension = (type: string) => EXTENSIONS.find(([re]) => re.test(type))?.[1] ?? "bin";

/** The request in `path` whose block contains `line`, parsed from the editor's text, which may be unsaved. */
export async function requestAt(path: string, line: number) {
  const model = await host.ensureModel(path);
  const { requests } = parseHttp(model.getValue());
  return { model, request: requests.find((r) => r.start <= line && line <= r.end) ?? requests.filter((r) => r.line <= line).at(-1) ?? requests[0] };
}

/** Runs a command in a PTY, passing its output to `onOutput` as it arrives. Nothing is missed: listening starts first. */
export async function spawnStreaming(cwd: string, command: string[], onOutput: (text: string) => void) {
  const channel = `http-${newId()}`;
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => (exit = resolve));
  const unlisten = await Promise.all([listen<string>(`pty:${channel}`, (e) => onOutput(e.payload)), listen(`pty-exit:${channel}`, () => exit())]);
  exited.then(() => unlisten.forEach((u) => u()));
  let id: number;
  try {
    id = await invoke<number>("pty_spawn", { cwd, command, rows: 24, cols: 500, channel });
  } catch (e) {
    unlisten.forEach((u) => u());
    throw e;
  }
  return { exited, kill: () => invoke("pty_kill", { id }).catch(() => {}) };
}

/** Lets the caller stop a request that's being sent. */
export type Cancel = { current?: () => void; cancelled?: boolean };

type Transfer = Pick<Exchange, "heads" | "info" | "bodyPath" | "contentType" | "error">;

/**
 * Sends a prepared request with curl, saving the response in `store` under `id`. curl runs in a PTY rather than
 * through run_capture, so it can be stopped; a text body goes through a file, since a PTY's input is a terminal.
 */
async function transmit(prepared: Prepared, dir: string, store: string, id: string, cookies: string | undefined, cancel: Cancel = {}): Promise<Transfer> {
  const t: Transfer = { heads: [], bodyPath: "", contentType: "" };
  for (const d of [store, cookies && parentOf(cookies)]) if (d) await invoke("create_dir", { path: d }).catch(() => {});
  const files = { headers: `${store}/${id}.headers`, body: `${store}/${id}.body`, cookies };
  let p = prepared;
  const requestBody = `${store}/${id}.request`;
  if (p.body !== undefined) {
    await invoke("write_file", { path: requestBody, contents: p.body });
    p = { ...p, body: undefined, bodyFile: requestBody };
  }
  const { args } = curlArgs(p, files);
  let out = "";
  try {
    const run = await spawnStreaming(dir, ["/usr/bin/curl", ...args], (text) => (out += text));
    cancel.current = () => ((cancel.cancelled = true), run.kill());
    await run.exited;
  } catch (e) {
    t.error = String(e).trim() || "curl failed";
  }
  cancel.current = undefined;
  out = out.replace(/\r\n/g, "\n");
  const at = out.lastIndexOf(INFO_MARKER);
  if (cancel.cancelled) t.error = "Cancelled";
  else if (!t.error && at < 0) t.error = out.trim() || "curl failed";
  else if (!t.error) {
    try {
      t.info = JSON.parse(out.slice(at + INFO_MARKER.length)) as CurlInfo;
      if (t.info.exitcode) t.error = t.info.errormsg || out.slice(0, at).trim() || `curl failed with exit code ${t.info.exitcode}`;
    } catch {
      t.error = out.trim() || "curl's output couldn't be read";
    }
  }
  t.heads = parseHeaderDump(await invoke<string>("read_file", { path: files.headers }).catch(() => ""));
  t.contentType = t.heads.at(-1)?.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  t.bodyPath = files.body;
  if (await invoke<boolean>("path_exists", { path: files.body })) {
    t.bodyPath = `${store}/${id}.${extension(t.contentType)}`;
    await invoke("rename_path", { from: files.body, to: t.bodyPath }).catch(() => (t.bodyPath = files.body));
  }
  for (const f of [files.headers, requestBody]) await invoke("remove_path", { path: f }).catch(() => {});
  return t;
}

/**
 * For the @laravel-session tag: gets Laravel's XSRF-TOKEN cookie when the jar doesn't have one for the host, and
 * sends it back as X-XSRF-TOKEN, with Origin and Referer, as a browser on the app's pages would. Laravel checks the
 * header on web routes, and Sanctum treats a request from a stateful origin as a browser session.
 */
async function laravelSession(p: Prepared, env: string | undefined, dir: string, cookies: string, cancel: Cancel): Promise<Prepared> {
  const origin = p.url.match(/^https?:\/\/[^/?#]+/)?.[0];
  if (!origin) return p;
  const host = new URL(origin).hostname;
  const token = async () => (await jarCookies(env)).find((c) => c.name === "XSRF-TOKEN" && (c.domain.replace(/^\./, "") === host || host.endsWith(c.domain)))?.value;
  if (!(await token())) {
    const scratch = await cacheDir("http-scratch");
    for (const csrfPath of [typeof p.laravelSession === "string" ? p.laravelSession : "/sanctum/csrf-cookie", "/"]) {
      const get: Prepared = { method: "GET", url: origin + csrfPath, headers: [["Accept", "text/html,application/json"]], followRedirects: true, timeout: p.timeout, insecure: p.insecure };
      const t = await transmit(get, dir, scratch, `csrf-${newId()}`, cookies, cancel);
      await invoke("remove_path", { path: t.bodyPath }).catch(() => {});
      if (cancel.cancelled || (await token())) break;
    }
  }
  const value = await token();
  const has = (name: string) => p.headers.some(([k]) => k.toLowerCase() === name.toLowerCase());
  const headers = [...p.headers];
  if (value && !has("X-XSRF-TOKEN")) headers.push(["X-XSRF-TOKEN", decodeURIComponent(value)]);
  if (!has("Origin")) headers.push(["Origin", origin]);
  if (!has("Referer")) headers.push(["Referer", `${origin}/`]);
  if (!has("Accept")) headers.push(["Accept", "application/json"]);
  return { ...p, headers };
}

export type SendOptions = {
  /** Values for names nothing else defines, such as ones typed when asked. */
  extraVars?: Record<string, string>;
  cancel?: Cancel;
  /** Changes the prepared request before it goes out, such as to add Xdebug's trigger. */
  adjust?: (p: Prepared) => Prepared | Promise<Prepared>;
};

/**
 * Sends a request from an .http file: runs its pre-request script, replaces variables, sends it with curl, runs
 * its response handler, and records it in the history unless it has the @no-log tag.
 */
export async function send(path: string, request: HttpRequest, options: SendOptions = {}): Promise<Exchange> {
  const dir = parentOf(path);
  const model = await host.ensureModel(path);
  const s = await scopes(path, model.getValue());
  const [global, file, env] = s.list.map((l) => l.vars);
  let variables: Record<string, string> = { ...options.extraVars };
  const exchange: Exchange = { id: newId(), time: Date.now(), path, name: request.name, line: request.line, env: s.env, request: undefined!, heads: [], bodyPath: "", contentType: "", tests: [], logs: [], unresolved: [] };
  const lookup = () => lookupIn([variables, globals(), file, env], s.dotenv);
  const scriptRequest = () => ({ method: request.method, url: request.url, headers: request.headers.filter((h) => h.enabled).map((h): [string, string] => [h.name, h.value]), body: request.body });

  if (request.preScript) {
    const out = await runScript(request.preScript, dir, { globals: global, variables, environment: env, request: scriptRequest() });
    variables = out.variables;
    setGlobals(out.globals);
    exchange.logs.push(...out.logs);
    if (out.error) exchange.logs.push(`Pre-request script: ${out.error}`);
  }
  exchange.request = await prepare(request, lookup(), dir, (p) => invoke<string>("read_file", { path: p }));
  const texts = [exchange.request.url, ...exchange.request.headers.map(([, v]) => v), exchange.request.body ?? ""];
  exchange.unresolved = [...new Set(texts.flatMap((t) => [...t.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((m) => m[1])))];

  const store = request.tags.noLog ? await cacheDir("http-scratch") : await cacheDir("http-history");
  const cookies = request.tags.noCookieJar ? undefined : await cookieJar(s.env);
  const cancel = options.cancel ?? {};
  if (exchange.request.laravelSession) {
    if (cookies) exchange.request = await laravelSession(exchange.request, s.env, dir, cookies, cancel);
    else exchange.logs.push("@laravel-session needs cookies, but the request has @no-cookie-jar.");
  }
  if (options.adjust) exchange.request = await options.adjust(exchange.request);
  Object.assign(exchange, await transmit(exchange.request, dir, store, exchange.id, cookies, cancel));
  const final = exchange.heads.at(-1);

  if (final && request.handler) {
    const body = isText(exchange.contentType) ? await invoke<string>("read_file", { path: exchange.bodyPath }).catch(() => "") : "";
    const out = await runScript(request.handler, dir, {
      globals: globals(),
      variables,
      environment: env,
      request: { ...scriptRequest(), url: exchange.request.url },
      response: { status: final.status, headers: final.headers, body, contentType: exchange.contentType, time: Math.round((exchange.info?.time_total ?? 0) * 1000) },
    });
    setGlobals(out.globals);
    exchange.tests = out.tests;
    exchange.logs.push(...out.logs);
    if (out.error) exchange.tests.push({ name: "Response handler", passed: false, message: out.error });
  }
  if (final && request.output) await saveOutput(exchange.bodyPath, request.output, dir);
  if (!request.tags.noLog && !cancel.cancelled) await remember(exchange);
  return exchange;
}

/** Sends an exchange's request again exactly as it went, without scripts, and records the new exchange. */
export async function resend(old: Exchange, cancel: Cancel = {}): Promise<Exchange> {
  const exchange: Exchange = { ...old, id: newId(), time: Date.now(), heads: [], tests: [], logs: [], error: undefined, info: undefined, pinned: false };
  const cookies = await cookieJar(old.env);
  Object.assign(exchange, await transmit(old.request, parentOf(old.path), await cacheDir("http-history"), exchange.id, cookies, cancel));
  await remember(exchange);
  return exchange;
}

/** Sends a prepared request without scripts or history, as monitoring does. The body is read, then deleted. */
export async function probe(p: Prepared, path: string, env: string | undefined, cancel: Cancel = {}) {
  const id = newId();
  const t = await transmit(p, parentOf(path), await cacheDir("http-scratch"), id, p.laravelSession ? await cookieJar(env) : undefined, cancel);
  await invoke("remove_path", { path: t.bodyPath }).catch(() => {});
  return t;
}

export const isText = (type: string) => !type || /^text\/|json|xml|javascript|html|x-www-form-urlencoded|graphql|yaml|csv/i.test(type);

/** `>> path` adds a number to the name when the file exists; `>>! path` replaces it. */
async function saveOutput(body: string, output: { path: string; force: boolean }, dir: string) {
  let target = output.path.startsWith("/") ? output.path : `${dir}/${output.path.replace(/^\.\//, "")}`;
  if (!output.force) {
    const dot = target.lastIndexOf(".") > target.lastIndexOf("/") ? target.lastIndexOf(".") : target.length;
    for (let n = 1; await invoke<boolean>("path_exists", { path: target }); n++) target = `${target.slice(0, dot).replace(/-\d+$/, "")}-${n}${target.slice(dot)}`;
  }
  await invoke("create_dir", { path: parentOf(target) }).catch(() => {});
  await invoke("run_capture", { cwd: "/", program: "/bin/cp", args: [body, target], input: null }).catch((e) => host.status(`Couldn't save the response to ${target}: ${e}`));
}

/** Forgets the project's cookies, for every environment. */
export async function clearCookies() {
  await invoke("remove_path", { path: await cacheDir("http-cookies") }).catch(() => {});
  host.status("Cleared the HTTP client's cookies");
}

/** Cookies curl kept for the environment, from its Netscape-format jar. */
export async function jarCookies(env = "default") {
  const text = await invoke<string>("read_file", { path: await cookieJar(env) }).catch(() => "");
  return text
    .split("\n")
    .map((l) => l.replace(/^#HttpOnly_/, ""))
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("\t"))
    .filter((f) => f.length >= 7)
    .map(([domain, , path, secure, expires, name, value]) => ({ domain, path, secure: secure === "TRUE", expires: Number(expires), name, value }));
}

// ---- History ----

const HISTORY_SIZE = 100;
let historyCache: Exchange[] | null = null;
let historyRoot = "";

export async function history(): Promise<Exchange[]> {
  if (historyCache && historyRoot === host.root()) return historyCache;
  historyRoot = host.root();
  historyCache = await invoke<string>("read_file", { path: `${await cacheDir("http-history")}/index.json` })
    .then((t) => JSON.parse(t) as Exchange[])
    .catch(() => []);
  return historyCache;
}

async function remember(exchange: Exchange) {
  const all = [exchange, ...(await history())];
  // Pinned exchanges don't count toward the limit.
  let unpinned = 0;
  const keep = all.filter((x) => x.pinned || ++unpinned <= HISTORY_SIZE);
  await saveHistory(keep);
  for (const old of all.filter((x) => !keep.includes(x))) await invoke("remove_path", { path: old.bodyPath }).catch(() => {});
}

async function saveHistory(list: Exchange[]) {
  historyCache = list;
  await invoke("write_file", { path: `${await cacheDir("http-history")}/index.json`, contents: JSON.stringify(list) });
  changed();
}

export async function setPinned(id: string, pinned: boolean) {
  await saveHistory((await history()).map((x) => (x.id === id ? { ...x, pinned } : x)));
}

export async function clearHistory() {
  await invoke("remove_path", { path: await cacheDir("http-history") }).catch(() => {});
  historyCache = [];
  changed();
}

// ---- The http language ----

monaco.languages.register({ id: "http", extensions: [".http", ".rest"], aliases: ["HTTP Request"] });
monaco.languages.setLanguageConfiguration("http", {
  comments: { lineComment: "#" },
  brackets: [["{", "}"], ["[", "]"], ["{{", "}}"]],
  autoClosingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: '"', close: '"', notIn: ["string"] }],
});
// A request line starts the headers; a blank line starts the body, which is JSON when it starts with { or [.
// Scripts between {% and %} are JavaScript.
const methods = /(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)(?=\s)/;
// Monarch only embeds a language whose grammar has loaded, and Monaco loads JavaScript's and JSON's on first use,
// so the http grammar loads them first.
monaco.languages.onLanguage("http", async () => {
  // JSON's tokenizer registers when a JSON model first appears.
  monaco.editor.createModel("", "json").dispose();
  const js = await import("monaco-editor/languages/definitions/javascript/javascript.js");
  monaco.languages.setMonarchTokensProvider("javascript", js.language);
  monaco.languages.setLanguageConfiguration("javascript", js.conf);
  monaco.languages.setMonarchTokensProvider("http", httpGrammar);
});
const httpGrammar: monaco.languages.IMonarchLanguage = {
  tokenizer: {
    root: [
      [/^###.*$/, "comment.doc"],
      [/^(\s*#\s*)(@[\w-]+)(.*)$/, ["comment", "annotation", "comment"]],
      [/^\s*(#|\/\/).*$/, "comment"],
      [/^(@[\w.-]+)(\s*=\s*)(.*)$/, ["variable.predefined", "delimiter", "string"]],
      [/^[<>]\s*\{%/, { token: "delimiter.script", next: "@script", nextEmbedded: "javascript" }],
      [methods, "keyword", "@requestLine"],
      [/^https?:\/\/\S+/, { token: "string.link", next: "@headers" }],
      { include: "@vars" },
    ],
    vars: [[/\{\{[^}]*\}\}/, "variable"]],
    // Monarch runs no rules at the end of a line, so the last token of the request line moves on to the headers.
    requestLine: [
      [/\{\{[^}]*\}\}\s*$/, { token: "variable", switchTo: "@headers" }],
      [/\{\{[^}]*\}\}/, "variable"],
      [/HTTP\/[\d.]+\s*$/, { token: "keyword", switchTo: "@headers" }],
      [/(?:[^\s{]+|\{)\s*$/, { token: "string.link", switchTo: "@headers" }],
      [/[^\s{]+|\{|\s+/, "string.link"],
    ],
    // The first line that isn't a header starts the body. A zero-width match enters JSON only with @rematch.
    headers: [
      [/^###.*$/, { token: "comment.doc", next: "@popall" }],
      [/^\s+[?&].*$/, "string.link"],
      [/^\s*#.*$/, "comment"],
      [/^([\w-]+)(\s*:)/, ["attribute.name", "delimiter"]],
      [/^(?=\s*[{[])/, { token: "@rematch", switchTo: "@json", nextEmbedded: "json" }],
      [/^(?=\S)/, { token: "", switchTo: "@body" }],
      { include: "@vars" },
      [/[^{]+|\{/, "attribute.value"],
    ],
    body: [
      [/^###.*$/, { token: "comment.doc", next: "@popall" }],
      [/^>>!?\s.*$/, "keyword"],
      [/^[<>]\s*\{%/, { token: "delimiter.script", next: "@script", nextEmbedded: "javascript" }],
      [/^<@?\s+.*$/, "string.link"],
      [/^(?=\s*[{[])/, { token: "@rematch", switchTo: "@json", nextEmbedded: "json" }],
      [/^--\S+.*$/, "delimiter"],
      { include: "@vars" },
      [/[^{]+|\{/, ""],
    ],
    json: [[/^(?=###|[<>]\s*\{%|>>)/, { token: "", switchTo: "@body", nextEmbedded: "@pop" }]],
    script: [[/%\}/, { token: "delimiter.script", next: "@pop", nextEmbedded: "@pop" }]],
  },
};

// ---- Editing .http files: completion, hovers, undefined variables, folding, and the outline ----

const TAGS = ["name", "no-redirect", "no-cookie-jar", "no-log", "insecure", "timeout", "connection-timeout"];
const DYNAMIC = ["$uuid", "$timestamp", "$isoTimestamp", "$randomInt", "$random.integer(0, 100)", "$random.float(0, 1)", "$random.alphabetic(10)", "$random.alphanumeric(10)", "$random.hexadecimal(10)", "$random.numeric(6)", "$random.email", "$random.bool", "$dotenv.APP_URL"];
const HEADERS: Record<string, string[]> = {
  Accept: ["application/json", "text/html", "*/*"],
  "Accept-Encoding": ["gzip, deflate, br", "identity"],
  "Accept-Language": ["en-US,en;q=0.9"],
  Authorization: ["Bearer {{token}}", "Basic {{user}} {{password}}"],
  "Cache-Control": ["no-cache", "no-store", "max-age=0"],
  "Content-Type": ["application/json", "application/x-www-form-urlencoded", "multipart/form-data; boundary=WebAppBoundary", "text/plain", "application/xml"],
  Cookie: [],
  "If-None-Match": [],
  Origin: ["{{host}}"],
  Referer: ["{{host}}/"],
  "User-Agent": ["PHP Editor"],
  "X-Requested-With": ["XMLHttpRequest"],
  "X-XSRF-TOKEN": ["{{xsrf}}"],
};

/** Names a file's scripts set, which exist only once the scripts run. */
export const scriptNames = (text: string) => new Set([...text.matchAll(/(?:client\.global|request\.variables)\.set\(\s*["'`]([\w.-]+)["'`]/g)].map((m) => m[1]));

async function variablesFor(model: monaco.editor.ITextModel) {
  const s = await scopes(model.uri.fsPath, model.getValue());
  const known = new Map<string, { value: string; source: string }>();
  for (const { label, vars } of [...s.list].reverse()) for (const [k, v] of Object.entries(vars)) known.set(k, { value: v, source: label });
  for (const name of scriptNames(model.getValue())) if (!known.has(name)) known.set(name, { value: "", source: "Set by a script in this file" });
  return { known, dotenv: s.dotenv, env: s.env };
}

monaco.languages.registerCompletionItemProvider("http", {
  triggerCharacters: ["{", "$", "@", ":", " "],
  provideCompletionItems: async (model, position) => {
    const line = model.getLineContent(position.lineNumber);
    const before = line.slice(0, position.column - 1);
    const word = model.getWordUntilPosition(position);
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
    const Kind = monaco.languages.CompletionItemKind;
    const open = before.lastIndexOf("{{");
    if (open >= 0 && before.lastIndexOf("}}") < open) {
      const typed = before.slice(open + 2);
      const r = new monaco.Range(position.lineNumber, open + 3, position.lineNumber, position.column);
      const close = line.slice(position.column - 1).startsWith("}}") ? "" : "}}";
      const { known } = await variablesFor(model);
      return {
        suggestions: [
          ...[...known].map(([name, v]) => ({ label: name, kind: Kind.Variable, detail: v.source, documentation: v.value, insertText: name + close, range: r })),
          ...DYNAMIC.map((name) => ({ label: name, kind: Kind.Function, detail: "Dynamic value", insertText: name + close, range: r, sortText: `~${name}` })),
        ].filter((s) => !typed || s.label.toLowerCase().includes(typed.trim().toLowerCase().replace(/^\$/, "")) || s.label.startsWith(typed.trim())),
      };
    }
    if (/^\s*#\s*@[\w-]*$/.test(before)) return { suggestions: TAGS.map((t) => ({ label: t, kind: Kind.Keyword, insertText: t, range })) };
    const { requests } = parseHttp(model.getValue());
    const r = requests.find((q) => q.start <= position.lineNumber && position.lineNumber <= q.end);
    const inHeaders = r && position.lineNumber > r.line && !model.getValueInRange(new monaco.Range(r.line + 1, 1, position.lineNumber, 1)).split("\n").some((l, i, all) => i < all.length - 1 && !l.trim());
    if ((!r || position.lineNumber <= r.line) && /^[A-Za-z]*$/.test(before))
      return { suggestions: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((m) => ({ label: m, kind: Kind.Keyword, insertText: `${m} {{host}}/$0`, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range })) };
    if (inHeaders) {
      const colon = before.indexOf(":");
      if (colon < 0) return { suggestions: Object.keys(HEADERS).map((name) => ({ label: name, kind: Kind.Property, insertText: `${name}: `, range, command: { id: "editor.action.triggerSuggest", title: "" } })) };
      const values = HEADERS[Object.keys(HEADERS).find((k) => k.toLowerCase() === before.slice(0, colon).trim().toLowerCase()) ?? ""] ?? [];
      const valueRange = new monaco.Range(position.lineNumber, colon + 2 + (before[colon + 1] === " " ? 1 : 0), position.lineNumber, line.length + 1);
      return { suggestions: values.map((v) => ({ label: v, kind: Kind.Value, insertText: v, range: valueRange })) };
    }
    return { suggestions: [] };
  },
});

monaco.languages.registerHoverProvider("http", {
  provideHover: async (model, position) => {
    const line = model.getLineContent(position.lineNumber);
    for (const m of line.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
      const [from, to] = [m.index! + 1, m.index! + m[0].length + 1];
      if (position.column < from || position.column > to) continue;
      const name = m[1];
      const range = new monaco.Range(position.lineNumber, from, position.lineNumber, to);
      if (name.startsWith("$")) {
        const { dotenv: env } = await variablesFor(model);
        const value = name.startsWith("$dotenv.") ? env[name.slice(8)] : undefined;
        return { range, contents: [{ value: name.startsWith("$dotenv.") ? `**${name}** from .env: \`${value ?? "not set"}\`` : `**${name}**: a new value each time the request is sent` }] };
      }
      const { known, env } = await variablesFor(model);
      const v = known.get(name);
      return {
        range,
        contents: [{ value: v ? `**${name}** = \`${v.value || "(empty)"}\`\n\n${v.source}` : `**${name}** isn't defined${env ? ` in the ${env} environment` : ""}. Define it in ${ENV_FILE}, as \`@${name} = value\` in this file, or with client.global.set in a script.` }],
      };
    }
    return null;
  },
});

/** Warns about {{names}} nothing defines. */
async function checkVariables(model: monaco.editor.ITextModel) {
  if (model.isDisposed() || model.getLanguageId() !== "http" || !host?.root()) return;
  const { known } = await variablesFor(model);
  const markers: monaco.editor.IMarkerData[] = [];
  model
    .getLinesContent()
    .forEach((line, i) => {
      if (/^\s*(#|\/\/)/.test(line)) return;
      for (const m of line.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g))
        if (!m[1].startsWith("$") && !known.has(m[1]))
          markers.push({ severity: monaco.MarkerSeverity.Warning, message: `${m[1]} isn't defined in the selected environment or this file`, startLineNumber: i + 1, endLineNumber: i + 1, startColumn: m.index! + 1, endColumn: m.index! + m[0].length + 1, source: "HTTP client" });
    });
  if (!model.isDisposed()) monaco.editor.setModelMarkers(model, "http-variables", markers);
}
const checkTimers = new WeakMap<monaco.editor.ITextModel, ReturnType<typeof setTimeout>>();
const checkSoon = (model: monaco.editor.ITextModel) => (clearTimeout(checkTimers.get(model)), checkTimers.set(model, setTimeout(() => checkVariables(model), 400)));
monaco.editor.onDidCreateModel((model) => {
  if (model.getLanguageId() !== "http") return;
  checkSoon(model);
  model.onDidChangeContent(() => checkSoon(model));
});
onHttpChange(() => monaco.editor.getModels().forEach((m) => m.getLanguageId() === "http" && checkSoon(m)));

monaco.languages.registerFoldingRangeProvider("http", {
  provideFoldingRanges: (model) => parseHttp(model.getValue()).requests.filter((r) => r.end > r.start).map((r) => ({ start: r.start, end: r.end, kind: monaco.languages.FoldingRangeKind.Region })),
});

monaco.languages.registerDocumentSymbolProvider("http", {
  provideDocumentSymbols: (model) =>
    parseHttp(model.getValue()).requests.map((r) => {
      const range = new monaco.Range(r.start, 1, r.end, model.getLineMaxColumn(r.end));
      return { name: r.title || r.name || `${r.method} ${r.url}`, detail: `${r.method} ${r.url}`, kind: monaco.languages.SymbolKind.Function, tags: [], range, selectionRange: new monaco.Range(r.line, 1, r.line, model.getLineMaxColumn(r.line)) };
    }),
});
