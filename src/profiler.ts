// The Xdebug profiler: runs PHP with profiling, and shows a profile's functions in the Profiler tab, sortable by
// calls, own time, and total time. Profiles from the editor's runs go to the app cache; Xdebug's own output folder
// is listed too, for profiles you made yourself.
import { invoke } from "@tauri-apps/api/core";
import { appCacheDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { type Call, type CallNode, groupQueries, hotSpots, parseSqlTrace, type Profile, type ProfiledFunction, type Query, type QueryGroup, withBindings } from "./cachegrind";
import ParseWorker from "./cachegrind.worker?worker";
import { pick, rank } from "./palette";
import { monaco } from "./editor";
import { openTerminal, showPanelView } from "./terminal";

type Host = { root(): string; openAt(path: string, line: number): unknown; status(text: string, source?: string): void };
let host: Host;
export const initProfiler = (h: Host) => (host = h);

/** The folder the editor's profiling runs write to. */
export async function profileDir() {
  const dir = `${await appCacheDir()}/profiles`;
  await invoke("create_dir", { path: dir });
  return dir;
}

/**
 * Environment that profiles a PHP run, including processes it starts, such as `artisan test` running PHPUnit.
 * The trigger covers setups with `xdebug.start_with_request=trigger`. Names carry the start time and process ID.
 */
export async function profileEnv(dir: string, root: string): Promise<string[]> {
  const env = ["XDEBUG_TRIGGER=1", `XDEBUG_CONFIG=output_dir=${dir} profiler_output_name=cachegrind.out.%t.%p.%R`];
  // In a Laravel app, also trace the database connection, to list the queries with their SQL. The trace's name is
  // set in the .ini file: XDEBUG_CONFIG doesn't take trace_output_name.
  const connection = `${root}/vendor/laravel/framework/src/Illuminate/Database/Connection.php`;
  if (!(await invoke<boolean>("path_exists", { path: connection }))) return ["XDEBUG_MODE=profile", ...env];
  return ["XDEBUG_MODE=profile,trace", ...env, `PHP_INI_SCAN_DIR=${await scanDir()}:${await traceSettings()}`, `PHP_EDITOR_SQL_TRACE=${connection}`];
}

/**
 * PHP settings for tracing queries, in a folder PHP_INI_SCAN_DIR adds, so processes a run starts (PHPUnit under
 * artisan test) get them too: a file run before the app that limits tracing to the database connection, and the
 * trace format. It takes the place of any auto_prepend_file your own settings have.
 */
async function traceSettings() {
  const dir = `${await appCacheDir()}/profiler-php`;
  await invoke("create_dir", { path: `${dir}/ini` });
  await invoke("write_file", {
    path: `${dir}/prepend.php`,
    contents: `<?php
// Written by the editor for profiled runs: limits Xdebug's tracing to Laravel's database connection,
// so the trace holds the queries and little else.
if (($file = getenv('PHP_EDITOR_SQL_TRACE')) && function_exists('xdebug_set_filter')) {
    xdebug_set_filter(XDEBUG_FILTER_TRACING, XDEBUG_PATH_INCLUDE, [$file]);
}
`,
  });
  await invoke("write_file", {
    path: `${dir}/ini/zz-tusk.ini`,
    contents: `; Written by the editor for profiled runs.\nauto_prepend_file="${dir}/prepend.php"\nxdebug.trace_format=1\nxdebug.trace_output_name=trace.%t.%p.%R\nxdebug.var_display_max_data=4096\nxdebug.var_display_max_children=128\nxdebug.var_display_max_depth=3\n`,
  });
  return `${dir}/ini`;
}

let scanned: Promise<string> | undefined;
/** PHP's own folders of extra .ini files, which setting PHP_INI_SCAN_DIR would otherwise replace. */
const scanDir = () =>
  (scanned ??= invoke<string>("run_capture", { cwd: "/", program: "php", args: ["--ini"], input: null })
    .then((out) => out.match(/^Scan for additional \.ini files in: (.*)$/m)?.[1].trim() ?? "")
    .then((dir) => (dir === "(none)" ? "" : dir))
    .catch(() => ""));

/** The query trace written with a profile: the same name, starting with "trace." and ending in ".xt". */
const traceFor = (profile: string) => profile.replace(/\/cachegrind\.out\.([^/]*?)(\.gz)?$/, "/trace.$1.xt$2");

/**
 * A web request's path from its profile's name, which Xdebug's %R fills with the request URI, turning `/`, `.`,
 * `?`, and `&` into `_`. Putting slashes back is right for plain paths such as /admin/login, and close otherwise.
 */
const requestPath = (path: string) => path.match(/cachegrind\.out\.\d+\.\d+\.(_[^/]*?)(\.gz)?$/)?.[1].replaceAll("_", "/");

const KEEP_PROFILES = 50;

/**
 * Serves the app with PHP's built-in server and Laravel's server.php, as `artisan serve` does, on the first free port
 * from 8000. Not through `artisan serve`: it passes only some variables to the server, and XDEBUG_TRIGGER isn't one.
 */
export async function startProfilingServer(): Promise<number | undefined> {
  const root = host.root();
  const script = "vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php";
  if (!(await invoke<boolean>("path_exists", { path: `${root}/${script}` }))) {
    host.status("The profiling server needs a Laravel project with its vendor folder installed.");
    return undefined;
  }
  let port = 8000;
  while (port < 8100 && (await listening(port))) port++;
  const dir = await profileDir();
  host.status(`Profiling server on http://127.0.0.1:${port}. Each request writes a profile; open it with Open Xdebug Profile….`);
  // server.php finds the public folder from the working directory, as artisan serve runs it.
  openTerminal(`${root}/public`, "Profiling server", ["/usr/bin/env", ...(await profileEnv(dir, root)), "php", "-S", `127.0.0.1:${port}`, `${root}/${script}`]);
  server = { root, port };
  return port;
}

/** The profiling server this session started, so Profile URL can reuse it. */
let server: { root: string; port: number } | undefined;

/** Whether something listens on a local port. lsof exits with an error when nothing does. */
const listening = (port: number) =>
  invoke("run_capture", { cwd: "/", program: "/usr/sbin/lsof", args: ["-iTCP:" + port, "-sTCP:LISTEN"], input: null }).then(
    () => true,
    () => false,
  );

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Asks for a path, requests it through the profiling server (starting it if needed), and opens that request's profile. */
export function profileUrl() {
  const last = readSetting(`profilerUrl:${host.root()}`) ?? "/";
  pick(
    "Profile a URL: type the path to request, such as /posts?page=2",
    (query) => {
      const path = "/" + query.trim().replace(/^https?:\/\/[^/]+/, "").replace(/^\/+/, "");
      return [{ label: `GET ${path}`, detail: "Request it through the profiling server and open its profile", icon: "codicon-pulse", run: () => requestAndProfile(path) }];
    },
    0,
    { value: last, select: [0, last.length] },
  );
}

/** The profiling server's address, such as http://127.0.0.1:8000, starting it if needed; undefined when it can't start. */
export async function profilingOrigin(): Promise<string | undefined> {
  const root = host.root();
  const port = server?.root === root && (await listening(server.port)) ? server.port : await startProfilingServer();
  if (!port) return undefined;
  // Wait for the server to accept connections.
  for (let i = 0; i < 25 && !(await listening(port)); i++) await sleep(200);
  return `http://127.0.0.1:${port}`;
}

/**
 * Opens the profile a request wrote after `since` (Unix seconds). Xdebug finishes the profile when PHP shuts the
 * request down, just after the response, so this waits until the newest profile stops growing.
 */
export async function openProfileSince(since: number, label: string) {
  const dir = await profileDir();
  let size = -1;
  for (let i = 0; i < 25; i++) {
    const newest = await newestProfile(dir, since);
    if (newest && newest.size === size) break;
    size = newest?.size ?? -1;
    await sleep(200);
  }
  return openNewestProfile(dir, since, label);
}

async function requestAndProfile(path: string) {
  const root = host.root();
  try {
    localStorage.setItem(`profilerUrl:${root}`, path);
  } catch {}
  const origin = await profilingOrigin();
  if (!origin) return;
  const since = Math.floor(Date.now() / 1000);
  host.status(`Requesting ${path}…`, "profiler:progress");
  const result = await invoke<string>("run_capture", {
    cwd: "/",
    program: "/usr/bin/curl",
    args: ["-s", "-o", "/dev/null", "-w", "%{http_code} %{time_total}", `${origin}${path}`],
    input: null,
  }).catch(() => "");
  host.status("", "profiler:progress");
  const [code, seconds] = result.split(" ");
  if (!code || code === "000") return host.status(`Couldn't request ${path}: the profiling server didn't answer. See its terminal tab.`);
  await openProfileSince(since, `GET ${path} (${code})`);
  host.status(`GET ${path}: ${code} in ${Math.round(Number(seconds) * 1000)} ms (with the profiler, which slows PHP down).`);
}

/** Profile files in a folder with their modification time (Unix seconds) and size. */
async function profilesIn(dir: string): Promise<{ path: string; time: number; size: number }[]> {
  const out = await invoke<string>("run_capture", { cwd: dir, program: "/bin/sh", args: ["-c", 'stat -f "%m %z %N" cachegrind.out.* 2>/dev/null; true'], input: null }).catch(() => "");
  return out
    .split("\n")
    .map((l) => l.match(/^(\d+) (\d+) (.+)$/))
    .filter((m) => m !== null)
    .map((m) => ({ path: `${dir.replace(/\/$/, "")}/${m[3]}`, time: Number(m[1]), size: Number(m[2]) }));
}

/**
 * Opens the largest profile written since `since` (Unix seconds), which is the one that did the work:
 * `artisan test` also writes a small profile for itself.
 */
/** The largest profile written since `since` (Unix seconds). */
const newestProfile = async (dir: string, since: number) =>
  (await profilesIn(dir)).filter((f) => Number(f.path.match(/cachegrind\.out\.(\d+)/)?.[1]) >= since).sort((a, b) => b.size - a.size)[0];

export async function openNewestProfile(dir: string, since: number, label?: string) {
  const largest = await newestProfile(dir, since);
  if (!largest) return void host.status("Profiling failed: Xdebug wrote no profile. Check that Xdebug is installed (php -m).");
  await openProfile(largest.path, label);
  // Keep the newest profiles only; a Laravel request's profile can be several megabytes.
  const old = (await profilesIn(dir)).sort((a, b) => b.time - a.time).slice(KEEP_PROFILES);
  for (const f of old) for (const path of [f.path, traceFor(f.path)]) await invoke("remove_path", { path }).catch(() => {});
  return largest.path;
}

/** What the editor's profiles came from, such as a request or a test, by path. */
function labels(): Record<string, string> {
  try {
    return JSON.parse(readSetting("profilerLabels") ?? "{}");
  } catch {
    return {};
  }
}

function saveLabel(path: string, label: string) {
  const all = labels();
  all[path] = label;
  // Only the newest profiles are kept, so only their labels are.
  const kept = Object.fromEntries(Object.entries(all).slice(-KEEP_PROFILES * 2));
  try {
    localStorage.setItem("profilerLabels", JSON.stringify(kept));
  } catch {}
}

/**
 * Lists recent profiles from the editor's runs and Xdebug's output folder, newest first, and passes the one you
 * choose to `chosen`: opening it, or comparing with it.
 */
export async function chooseProfile(title = "Open an Xdebug profile", chosen: (path: string) => unknown = (path) => openProfile(path)) {
  const xdebugDir = await invoke<string>("run_capture", { cwd: "/", program: "php", args: ["-r", 'echo ini_get("xdebug.output_dir");'], input: null }).catch(() => "");
  const editorDir = await profileDir();
  const files = [...(await profilesIn(editorDir)), ...(xdebugDir.trim() ? await profilesIn(xdebugDir.trim()) : [])].sort((a, b) => b.time - a.time);
  const kb = (size: number) => (size >= 1_000_000 ? `${(size / 1_000_000).toFixed(1)} MB` : `${Math.ceil(size / 1000)} KB`);
  const names = labels();
  const items = [
    ...files.map((f) => {
      const when = `${new Date(f.time * 1000).toLocaleString()} · ${kb(f.size)}`;
      const from = f.path.startsWith(editorDir) ? "" : " · Xdebug folder";
      return {
        label: names[f.path] ?? (requestPath(f.path) ? `Request ${requestPath(f.path)}` : when),
        detail: names[f.path] || requestPath(f.path) ? `${when}${from}` : `${f.path.split("/").pop()}${from}`,
        icon: f.path === currentPath ? "codicon-eye" : "codicon-pulse",
        run: () => chosen(f.path),
      };
    }),
    {
      label: "Choose File…",
      icon: "codicon-folder-opened",
      run: async () => {
        const path = await open({ directory: false });
        if (typeof path === "string") chosen(path);
      },
    },
  ];
  pick(files.length ? title : "No profiles yet: run Profile Test at Cursor or Profile URL, or choose a file", (q) => rank(q, items));
}

/**
 * Reads a profile, decompressing it when Xdebug gzipped it (the default), and shows the Profiler tab. `label` names
 * what was profiled, such as a request; without it, the tab shows the script Xdebug recorded.
 */
export async function openProfile(path: string, label?: string) {
  const parsed = await load(path);
  if (!parsed) return;
  if (label) saveLabel(path, label);
  profile = parsed;
  currentPath = path;
  queries = await loadQueries(path);
  queryGroups = groupQueries(queries);
  if (view === "queries" && !queries.length) view = "functions";
  functionsByFile = new Map();
  for (const f of profile.functions) functionsByFile.set(f.file, [...(functionsByFile.get(f.file) ?? []), f]);
  selected = undefined;
  expanded = hotPath();
  const request = requestPath(path);
  q(".tests-summary").textContent = `${label ?? labels()[path] ?? (request ? `Request ${request}` : relative(profile.command))} · ${ms(profile.total)} · ${profile.functions.length} functions`;
  flamePath = [];
  q(".tests-summary").title = path;
  render();
  showInsights();
  showDetail();
  decorateAll();
  showPanelView("Profiler", panel);
}

/** Reads and parses a profile, decompressing it when Xdebug gzipped it (the default). Null, with a message, when it can't. */
async function load(path: string): Promise<Profile | null> {
  host.status(`Reading ${path.split("/").pop()}…`, "profiler:progress");
  const done = (message = "") => (host.status("", "profiler:progress"), message && host.status(message), null);
  let text: string;
  try {
    text = path.endsWith(".gz")
      ? await invoke<string>("run_capture", { cwd: "/", program: "/usr/bin/gzip", args: ["-dc", path], input: null })
      : await invoke<string>("read_file", { path });
  } catch (e) {
    return done(`Couldn't read the profile: ${e}`);
  }
  const parsed = await parse(text).catch(() => null);
  if (!parsed) return done(`Couldn't read the profile: ${path} failed to parse.`);
  if (!parsed.functions.length) return done(`Couldn't read the profile: ${path} isn't a Cachegrind file.`);
  done();
  return parsed;
}

let currentPath = "";

// ---- Database queries ----
// From the trace of Laravel's database connection written next to the profile, when there is one.

let queries: Query[] = [];
let queryGroups: QueryGroup[] = [];

/** The queries in the SQL trace written next to a profile; none when there's no trace. */
export async function loadQueries(profilePath: string): Promise<Query[]> {
  const path = traceFor(profilePath);
  if (path === profilePath || !(await invoke<boolean>("path_exists", { path }))) return [];
  const text = await (path.endsWith(".gz")
    ? invoke<string>("run_capture", { cwd: "/", program: "/usr/bin/gzip", args: ["-dc", path], input: null })
    : invoke<string>("read_file", { path })
  ).catch(() => "");
  return parseSqlTrace(text);
}


// ---- Comparing with another profile ----

/** The profile to compare with, by function name, and what it came from. */
let baseline: { functions: Map<string, ProfiledFunction>; label: string; total: number } | undefined;

/** Chooses a profile to compare the open one with: the table then shows how much each function's time changed. */
export function compareWith() {
  chooseProfile("Compare with: choose the profile from before your change", async (path) => {
    const parsed = await load(path);
    if (!parsed) return;
    const request = requestPath(path);
    baseline = { functions: new Map(parsed.functions.map((f) => [f.name, f])), label: labels()[path] ?? (request ? `Request ${request}` : path.split("/").pop()!), total: parsed.total };
    view = "functions";
    sort = "dinclusive"; // The biggest slowdowns first.
    panel.querySelectorAll<HTMLElement>("[data-view]").forEach((v) => (v.ariaPressed = String(v.dataset.view === view)));
    render();
    showInsights();
  });
}

const stopComparing = () => {
  baseline = undefined;
  if (sort === "dself" || sort === "dinclusive") sort = "self";
  render();
  showInsights();
};

/** A function's change in own or total time since the baseline; a function the baseline didn't run counts in full. */
const delta = (f: ProfiledFunction, key: "self" | "inclusive") => f[key] - (baseline?.functions.get(f.name)?.[key] ?? 0);

/** A change in time: slower is red and faster green, ignoring changes under a hundredth of a millisecond. */
function deltaCell(n: number) {
  const td = cell(Math.abs(n) < 0.01 ? "—" : `${n > 0 ? "+" : "−"}${ms(Math.abs(n))}`, `num ${n >= 0.01 ? "slower" : n <= -0.01 ? "faster" : ""}`);
  return td;
}

// ---- Where the time went ----

/** Laravel-aware totals for the kinds of work that usually dominate a request, from PHP's and Composer's functions. */
const INSIGHTS: { label: string; match: (name: string) => boolean; counts?: (name: string) => boolean; unit?: string }[] = [
  {
    label: "Database",
    match: (n) => n.startsWith("php::PDO"),
    counts: (n) => /^php::(PDOStatement->execute|PDO->exec|PDO->query)$/.test(n),
    unit: "queries",
  },
  { label: "Autoloading", match: (n) => n === "Composer\\Autoload\\ClassLoader->loadClass", counts: () => true, unit: "classes" },
  { label: "Views", match: (n) => n === "Illuminate\\View\\View->render", counts: () => true, unit: "views" },
  { label: "HTTP calls", match: (n) => /^php::curl_(multi_)?exec$/.test(n), counts: (n) => n === "php::curl_exec", unit: "requests" },
  { label: "Redis", match: (n) => n.startsWith("php::Redis->"), counts: () => true, unit: "commands" },
];

/** The row above the table: time in the database, autoloading, views, and outgoing calls, and the comparison. */
function showInsights() {
  const row = q(".profiler-insights");
  row.replaceChildren();
  for (const insight of INSIGHTS) {
    const fns = profile.functions.filter((f) => insight.match(f.name));
    // PHP's own functions don't nest in each other, and loadClass and render count nested calls once, so totals add up.
    const time = fns.reduce((t, f) => t + f.inclusive, 0);
    if (!fns.length || time < profile.total / 1000) continue;
    const count = fns.filter((f) => insight.counts?.(f.name)).reduce((n, f) => n + f.calls, 0);
    const chip = Object.assign(document.createElement("button"), {
      className: "chip",
      title: `Select ${fns.length === 1 ? "the function" : "the busiest function"}, to see what called it`,
    });
    chip.append(Object.assign(document.createElement("b"), { textContent: insight.label }), ` ${count ? `${count} ${insight.unit} · ` : ""}${ms(time)} · ${share(time)}`);
    const busiest = [...fns].sort((a, b) => b.inclusive - a.inclusive)[0];
    chip.onclick = () => {
      // With the queries traced, the Database total opens them; otherwise it selects the busiest function.
      if (insight.label === "Database" && queries.length) return panel.querySelector<HTMLElement>('[data-view="queries"]')!.click();
      if (view !== "functions") panel.querySelector<HTMLElement>('[data-view="functions"]')!.click();
      select(busiest);
    };
    row.append(chip);
  }
  if (baseline) {
    const change = profile.total - baseline.total;
    const note = Object.assign(document.createElement("span"), { className: `compare ${change >= 0 ? "slower" : "faster"}` });
    note.textContent = `Compared with ${baseline.label}: ${change >= 0 ? "+" : "−"}${ms(Math.abs(change))} (${ms(baseline.total)} → ${ms(profile.total)})`;
    const stop = Object.assign(document.createElement("button"), { className: "chip", textContent: "Stop comparing" });
    stop.onclick = stopComparing;
    row.append(note, stop);
  }
  row.hidden = !row.childElementCount;
}

/** Parses in a worker; a profile of a large request can be hundreds of megabytes. */
function parse(text: string) {
  const worker = new ParseWorker();
  return new Promise<Profile>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<Profile>) => resolve(e.data);
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage(text);
  }).finally(() => worker.terminate());
}

// ---- The Profiler tab ----

const MAX_ROWS = 500;
let profile: Profile = { command: "", functions: [], total: 0, sites: new Map(), tree: [] };
let view: "functions" | "tree" | "flame" | "queries" = "functions";
let sort: "name" | "calls" | "self" | "inclusive" | "memory" | "dself" | "dinclusive" = "self";
let selected: ProfiledFunction | undefined;
/** The rows the table shows, in order, so the arrow keys can move through them. */
let shown: Row[] = [];
/** A table row: a function, or in the call tree, a function under its caller, with the calls on that path. */
type Row = { fn: ProfiledFunction; key: string; depth: number; calls: number; time: number; recursive?: boolean; match?: boolean; node?: CallNode };
/** Call tree nodes that are open, by their path of function names from the root. */
let expanded = new Set<string>();

const readSetting = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const saveSetting = (key: string, value: boolean) => {
  try {
    localStorage.setItem(key, String(value));
  } catch {}
};
let projectOnly = readSetting("profilerProjectOnly") === "true";
let editorTimes = readSetting("profilerEditorTimes") !== "false";

const relative = (path: string) => (path.startsWith(host.root() + "/") ? path.slice(host.root().length + 1) : path);
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : n >= 10 ? `${Math.round(n)} ms` : n >= 0.01 ? `${n.toFixed(2)} ms` : `${Math.round(n * 1000)} µs`);
const bytes = (n: number) => {
  const size = Math.abs(n);
  const text = size >= 1_048_576 ? `${(size / 1_048_576).toFixed(1)} MB` : size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`;
  return n < 0 ? `−${text}` : text;
};
const share = (n: number) => (profile.total ? `${((n / profile.total) * 100).toFixed(1)}%` : "");
const isInternal = (f: ProfiledFunction) => f.file === "php:internal";
const isProject = (f: ProfiledFunction) => !isInternal(f) && f.file.startsWith(host.root() + "/") && !f.file.startsWith(host.root() + "/vendor/");
const where = (f: ProfiledFunction) => (isInternal(f) ? "PHP" : `${relative(f.file)}:${f.line}`);
// Closures are named by their file, such as {closure:/Users/…/app/Foo.php:12-14}.
const displayName = (f: ProfiledFunction) => f.name.replaceAll(host.root() + "/", "");
const openSource = (f: ProfiledFunction) => !isInternal(f) && f.file && host.openAt(f.file, f.line || 1);

const panel = document.createElement("div");
panel.className = "tests profiler";
panel.innerHTML = `
  <div class="tests-toolbar">
    <button data-action="open" title="Open another profile"><span class="codicon codicon-folder-opened"></span></button>
    <button data-action="compare" title="Compare with another profile, such as one from before your change"><span class="codicon codicon-diff"></span></button>
    <button data-action="reveal" title="Reveal the profile file in Finder"><span class="codicon codicon-file-symlink-file"></span></button>
    <div class="segmented" role="group" aria-label="View">
      <button data-view="functions" aria-pressed="true">Functions</button>
      <button data-view="tree" aria-pressed="false">Call tree</button>
      <button data-view="flame" aria-pressed="false">Flame graph</button>
      <button data-view="queries" aria-pressed="false" hidden>Queries</button>
    </div>
    <input class="profiler-filter" placeholder="Filter functions" aria-label="Filter functions" spellcheck="false" />
    <label class="profiler-check" data-option="project" title="Hide vendor packages and PHP's own functions"><input type="checkbox" /> Project code only</label>
    <label class="profiler-check" data-option="editor" title="Show how long the calls on each line took, at the end of the line in open files"><input type="checkbox" /> Times in editor</label>
    <span class="tests-summary"></span>
  </div>
  <div class="profiler-insights" hidden></div>
  <div class="profiler-body">
    <div class="profiler-table" tabindex="0" aria-label="Functions">
      <table>
        <thead></thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="profiler-flame" tabindex="0" aria-label="Flame graph" hidden></div>
    <div class="profiler-resize" title="Drag to resize"></div>
    <div class="profiler-detail"></div>
  </div>`;
const q = (sel: string) => panel.querySelector(sel) as HTMLElement;
const filter = q(".profiler-filter") as HTMLInputElement;
const project = q('[data-option="project"] input') as HTMLInputElement;
const times = q('[data-option="editor"] input') as HTMLInputElement;
const tableEl = q(".profiler-table");
project.checked = projectOnly;
times.checked = editorTimes;
filter.oninput = () => {
  if (view === "tree") openBackTrace();
  render();
};
project.onchange = () => {
  projectOnly = project.checked;
  saveSetting("profilerProjectOnly", projectOnly);
  render();
};
times.onchange = () => {
  editorTimes = times.checked;
  saveSetting("profilerEditorTimes", editorTimes);
  decorateAll();
};
q('[data-action="open"]').onclick = () => chooseProfile();

// Drag the side pane's left edge to resize it; the width is remembered.
const detailPane = q(".profiler-detail");
const savedWidth = Number(readSetting("profilerDetailWidth"));
if (savedWidth) detailPane.style.width = `${savedWidth}px`;
q(".profiler-resize").onmousedown = (down) => {
  down.preventDefault(); // Otherwise the drag selects the text it passes over.
  const start = detailPane.offsetWidth;
  const move = (e: MouseEvent) => (detailPane.style.width = `${Math.max(200, Math.min(panel.offsetWidth - 300, start + down.clientX - e.clientX))}px`);
  const up = () => {
    removeEventListener("mousemove", move);
    removeEventListener("mouseup", up);
    try {
      localStorage.setItem("profilerDetailWidth", String(detailPane.offsetWidth));
    } catch {}
  };
  addEventListener("mousemove", move);
  addEventListener("mouseup", up);
};
q('[data-action="compare"]').onclick = () => compareWith();
q('[data-action="reveal"]').onclick = () => currentPath && invoke("run_capture", { cwd: "/", program: "/usr/bin/open", args: ["-R", currentPath], input: null }).catch(() => {});
panel.querySelectorAll<HTMLButtonElement>("[data-view]").forEach(
  (b) =>
    (b.onclick = () => {
      view = b.dataset.view as typeof view;
      if (view === "tree") openBackTrace();
      panel.querySelectorAll<HTMLElement>("[data-view]").forEach((v) => (v.ariaPressed = String(v === b)));
      render();
      showDetail();
      (view === "flame" ? flameEl : tableEl).focus();
    }),
);

// ↑ and ↓ move the selection, ⏎ opens the selected function, and in the call tree, → and ← open and close a node.
tableEl.onkeydown = (e) => {
  const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 15, PageUp: -15 };
  const at = shown.findIndex((r) => r.key === selectedKey);
  const row = shown[at];
  if (e.key in moves && shown.length) selectRow(shown[Math.max(0, Math.min(shown.length - 1, at + moves[e.key]))]);
  else if (e.key === "Enter" && selected) openSource(selected);
  else if (view === "tree" && row && e.key === "ArrowRight" && hasChildren(row)) {
    if (expanded.has(row.key)) selectRow(shown[at + 1]);
    else (expanded.add(row.key), render());
  } else if (view === "tree" && row && e.key === "ArrowLeft") {
    if (expanded.delete(row.key)) render();
    else selectRow(shown.slice(0, at).reverse().find((r) => r.depth < row.depth) ?? row);
  } else return;
  e.preventDefault();
};

function cell(text: string, className = "") {
  const td = document.createElement("td");
  td.className = className;
  td.textContent = text;
  return td;
}

/** The time columns: milliseconds, and the share of the whole run. */
const timeCell = (n: number, className = "") => cell(`${ms(n)} · ${share(n)}`, `num ${className}`);

const columns = {
  compare: [
    ["dself", "Δ Own", "How much the function's own time changed since the profile you compare with. Red is slower."],
    ["dinclusive", "Δ Total", "How much the function's total time changed since the profile you compare with. Red is slower."],
  ],
  functions: [
    ["name", "Function", ""],
    ["calls", "Calls", "How many times it ran"],
    ["self", "Own time", "Time in the function's own code, not in what it called"],
    ["inclusive", "Total time", "Time from the start to the end of its calls, including what it called"],
    ["memory", "Memory", "How much memory in use grew over its calls, including what it called. Memory freed before a call returned doesn't count."],
  ],
  tree: [
    ["name", "Call tree", "Each function under the functions that called it, with its time on that path. Type in the filter to see a function's callers instead."],
    ["calls", "Calls", "How many times it ran on this path"],
    ["inclusive", "Time", "Time in those calls, including what they called"],
  ],
} as const;

/** Shows the function table, or the call tree, with the chosen sort and filter. */
function render() {
  tableEl.hidden = view === "flame";
  flameEl.hidden = view !== "flame";
  project.disabled = view !== "functions";
  panel.querySelectorAll<HTMLElement>("[data-view]").forEach((v) => (v.ariaPressed = String(v.dataset.view === view)));
  const queriesButton = panel.querySelector<HTMLElement>('[data-view="queries"]')!;
  queriesButton.hidden = !queries.length;
  queriesButton.textContent = `Queries (${queries.length})`;
  if (view === "flame") {
    filter.placeholder = "Highlight functions";
    return renderFlame();
  }
  if (view === "queries") return renderQueries();
  const backTrace = view === "tree" && filterWords().length > 0;
  // While comparing, the change columns take Memory's place, so function names keep their room.
  const list = view === "tree" ? columns.tree : baseline ? [...columns.functions.filter(([key]) => key !== "memory"), ...columns.compare] : columns.functions;
  const heads = list.map(([key, name, tip]) => {
    const label = backTrace && key === "name" ? "Called by" : name;
    const th = Object.assign(document.createElement("th"), { textContent: label, title: tip, className: key === "name" ? "" : "num" });
    th.dataset.sort = key;
    if (view === "functions") th.onclick = () => ((sort = key), render());
    th.classList.toggle("sorted", view === "functions" && key === sort);
    return th;
  });
  const tr = document.createElement("tr");
  tr.append(...heads);
  q("thead").replaceChildren(tr);
  panel.classList.toggle("tree-view", view === "tree");
  filter.placeholder = view === "tree" ? "Find in the call tree" : "Filter functions";
  let note = "";
  if (view === "functions") {
    const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    const matching = profile.functions
      .filter((f) => (!projectOnly || isProject(f)) && words.every((w) => f.name.toLowerCase().includes(w)))
      .sort((a, b) =>
        sort === "name" ? a.name.localeCompare(b.name) : sort === "dself" ? delta(b, "self") - delta(a, "self") : sort === "dinclusive" ? delta(b, "inclusive") - delta(a, "inclusive") : b[sort] - a[sort],
      );
    shown = matching.slice(0, MAX_ROWS).map((f) => ({ fn: f, key: f.name, depth: 0, calls: f.calls, time: f.inclusive }));
    note = matching.length > MAX_ROWS ? `${matching.length - MAX_ROWS} more functions. Filter to find them.` : !matching.length ? "No functions match." : "";
  } else {
    shown = treeRows();
    note =
      shown.length >= MAX_TREE_ROWS
        ? "The tree shows its first rows. Close some nodes, or find a function, to see the rest."
        : !shown.length
          ? "No functions match."
          : "";
  }
  q("tbody").replaceChildren(...shown.map(view === "functions" ? functionRow : treeRow));
  if (note) {
    const row = document.createElement("tr");
    row.append(Object.assign(cell(note, "muted"), { colSpan: list.length }));
    q("tbody").append(row);
  }
}

function functionRow(r: Row) {
  const f = r.fn;
  const tr = document.createElement("tr");
  tr.classList.toggle("selected", r.key === selectedKey);
  const name = cell(displayName(f), "name");
  name.title = `${f.name}\n${where(f)}`;
  name.append(Object.assign(document.createElement("span"), { className: "where", textContent: where(f) }));
  // A line under own time shows its share of the run, so the costly functions stand out.
  const own = timeCell(f.self, "bar");
  own.style.setProperty("--share", share(f.self) || "0%");
  tr.append(name, cell(String(f.calls), "num"), own, timeCell(f.inclusive));
  tr.append(...(baseline ? [deltaCell(delta(f, "self")), deltaCell(delta(f, "inclusive"))] : [cell(bytes(f.memory), "num")]));
  tr.onclick = () => (selectRow(r), tableEl.focus());
  tr.ondblclick = () => openSource(f);
  rowOf.set(r.key, tr);
  return tr;
}

// ---- The call tree ----
// The exact tree from the profile: a node is a function under one caller path, so its time is what it took there.
// Finding a function shows back traces instead, built from caller totals: a function's callers from anywhere.

const MAX_TREE_ROWS = 2000;

/**
 * The rows of open nodes, depth first, children by time. With text in the filter, the matching functions are the
 * roots instead, and each opens to the functions that called it: a back trace, as PhpStorm calls it. A back trace
 * doesn't open a function already on its path again.
 */
function treeRows(): Row[] {
  const rows: Row[] = [];
  const up = filterWords().length > 0;
  const walk = (row: Row, path: Set<ProfiledFunction>) => {
    if (rows.length >= MAX_TREE_ROWS) return;
    rows.push(row);
    if (row.recursive || !expanded.has(row.key)) return;
    if (!up) {
      for (const n of [...row.node!.children].sort((a, b) => b.time - a.time)) walk(nodeRow(n, row.key, row.depth + 1), path);
      return;
    }
    const next = new Set(path).add(row.fn);
    for (const c of [...row.fn.callers].sort((a, b) => b.time - a.time))
      walk({ fn: c.fn, key: `${row.key}\n${c.fn.name}`, depth: row.depth + 1, calls: c.calls, time: c.time, recursive: next.has(c.fn) }, next);
  };
  if (up) for (const f of treeRoots()) walk({ fn: f, key: `↑${f.name}`, depth: 0, calls: f.calls, time: f.inclusive, match: true }, new Set());
  else for (const n of [...profile.tree].sort((a, b) => b.time - a.time)) walk(nodeRow(n, "", 0), new Set());
  return rows;
}

const nodeRow = (n: CallNode, parentKey: string, depth: number): Row => ({
  fn: n.fn,
  key: parentKey ? `${parentKey}\n${n.fn.name}` : n.fn.name,
  depth,
  calls: n.calls,
  time: n.time,
  node: n,
});

const hasChildren = (r: Row) => (r.node ? r.node.children.length > 0 : !r.recursive && r.fn.callers.length > 0);

const filterWords = () => filter.value.toLowerCase().split(/\s+/).filter(Boolean);

/** The functions matching the filter, by total time: the roots of back traces. */
function treeRoots() {
  const words = filterWords();
  return profile.functions
    .filter((f) => words.every((w) => f.name.toLowerCase().includes(w)))
    .sort((a, b) => b.inclusive - a.inclusive)
    .slice(0, MAX_ROWS);
}

/** Opens the busiest chain of callers above the first match, so its back trace shows at once. */
function openBackTrace() {
  if (!filterWords().length) return;
  const first = treeRoots()[0];
  if (!first) return;
  let key = `↑${first.name}`;
  const seen = new Set<ProfiledFunction>();
  for (let fn: ProfiledFunction | undefined = first; fn && !seen.has(fn) && seen.size < 40; ) {
    seen.add(fn);
    expanded.add(key);
    fn = [...fn.callers].sort((a, b) => b.time - a.time)[0]?.fn;
    if (fn) key = `${key}\n${fn.name}`;
  }
}

/** Opens the busiest path from the root, as long as each step takes at least a tenth of the run. */
function hotPath() {
  const open = new Set<string>();
  let node: CallNode | undefined = [...profile.tree].sort((a, b) => b.time - a.time)[0];
  let key = node?.fn.name ?? "";
  while (node && open.size < 60) {
    open.add(key);
    node = [...node.children].sort((a, b) => b.time - a.time)[0];
    if (!node || node.time < profile.total / 10) break;
    key = `${key}\n${node.fn.name}`;
  }
  return open;
}

function treeRow(r: Row) {
  const tr = document.createElement("tr");
  tr.classList.toggle("selected", r.key === selectedKey);
  tr.classList.toggle("match", !!r.match);
  const name = cell("", "name");
  name.style.paddingLeft = `${6 + r.depth * 14}px`;
  const canOpen = hasChildren(r);
  const chevron = Object.assign(document.createElement("span"), {
    className: `chevron codicon ${canOpen ? (expanded.has(r.key) ? "codicon-chevron-down" : "codicon-chevron-right") : ""}`,
  });
  chevron.onclick = (e) => {
    e.stopPropagation();
    if (!canOpen) return;
    if (!expanded.delete(r.key)) expanded.add(r.key);
    render();
  };
  name.append(chevron, displayName(r.fn));
  if (r.recursive) name.append(Object.assign(document.createElement("span"), { className: "where", textContent: "↻ calls back into a caller" }));
  name.title = `${r.fn.name}\n${where(r.fn)}`;
  // In a back trace, a caller's time would be the time of its own call to the next row up, not the time it spent
  // reaching the function you found, so only the found functions show times.
  const time = filterWords().length && r.depth > 0 ? cell("", "num") : timeCell(r.time, "bar");
  time.style.setProperty("--share", share(r.time) || "0%");
  tr.append(name, cell(String(r.calls), "num"), time);
  tr.onclick = () => (selectRow(r), tableEl.focus());
  tr.ondblclick = () => openSource(r.fn);
  rowOf.set(r.key, tr);
  return tr;
}

// ---- The flame graph ----
// The call tree as bars: each function's bar sits under its caller's and is as wide as its time there. The busiest
// callees come first. Click a bar to zoom into it, and click a bar above to zoom back out.

const FLAME_ROW = 18;
const flameEl = q(".profiler-flame");
/** The zoomed bar's ancestors, from the root, then the bar itself. Empty shows the whole run. */
let flamePath: CallNode[] = [];

function renderFlame() {
  const width = flameEl.clientWidth || 800;
  const words = filterWords();
  const bars: HTMLElement[] = [];
  let deepest = 0;
  const bar = (n: CallNode, left: number, w: number, depth: number, path: CallNode[], ancestor = false) => {
    deepest = Math.max(deepest, depth);
    const f = n.fn;
    const kind = isInternal(f) ? "php" : isProject(f) ? "project" : "vendor";
    const matches = words.length > 0 && words.every((word) => f.name.toLowerCase().includes(word));
    const el = document.createElement("div");
    el.className = `flame-bar ${kind}${ancestor ? " ancestor" : ""}${matches ? " match" : words.length ? " dim" : ""}${f === selected ? " selected" : ""}`;
    el.style.cssText = `left:${left}px;top:${depth * FLAME_ROW}px;width:${w}px`;
    if (w > 36) el.textContent = displayName(f);
    el.title = `${displayName(f)}\n${ms(n.time)} · ${share(n.time)} · ${n.calls} ${n.calls === 1 ? "call" : "calls"}\n${where(f)}\nClick to zoom in, double-click to open`;
    el.onclick = () => {
      flamePath = ancestor || flamePath.at(-1) === n ? path.slice(0, -1) : path;
      selected = f;
      renderFlame();
      showDetail();
    };
    el.ondblclick = () => openSource(f);
    bars.push(el);
  };
  // Ancestors of the zoomed bar span the width, so the path stays visible and each one zooms back out.
  flamePath.slice(0, -1).forEach((n, depth) => bar(n, 0, width, depth, flamePath.slice(0, depth + 1), true));
  const focus = flamePath.at(-1);
  const top = focus ? [focus] : [...profile.tree].sort((a, b) => b.time - a.time);
  const scale = width / Math.max(1e-9, top.reduce((t, n) => t + n.time, 0));
  const place = (n: CallNode, left: number, depth: number, path: CallNode[]) => {
    const w = n.time * scale;
    if (w < 1) return; // Narrower than a pixel: too small to see or click.
    bar(n, left, w, depth, path);
    let x = left;
    for (const c of [...n.children].sort((a, b) => b.time - a.time)) {
      place(c, x, depth + 1, [...path, c]);
      x += c.time * scale;
    }
  };
  let x = 0;
  const base = Math.max(0, flamePath.length - 1);
  for (const n of top) {
    place(n, x, base, focus ? flamePath : [n]);
    x += n.time * scale;
  }
  const canvas = document.createElement("div");
  canvas.className = "flame-canvas";
  canvas.style.height = `${(deepest + 1) * FLAME_ROW}px`;
  canvas.append(...bars);
  flameEl.replaceChildren(canvas);
}

// Escape zooms out one level.
flameEl.onkeydown = (e) => {
  if (e.key !== "Escape" || !flamePath.length) return;
  flamePath = flamePath.slice(0, -1);
  renderFlame();
  showDetail();
  e.preventDefault();
};
new ResizeObserver(() => view === "flame" && !flameEl.hidden && renderFlame()).observe(flameEl);

// ---- The Queries view ----

let selectedQuery: QueryGroup | undefined;

/** Lists queries grouped by SQL, slowest first; a group opens to each time it ran, with its bindings. */
function renderQueries() {
  filter.placeholder = "Filter queries";
  const words = filterWords();
  const groups = queryGroups.filter((g) => words.every((w) => g.sql.toLowerCase().includes(w)));
  const head = document.createElement("tr");
  for (const [label, tip, num] of [
    ["Query", "Queries with the same SQL, slowest first. Open one to see each time it ran.", false],
    ["Runs", "How many times it ran", true],
    ["Time", "Time in the database, all runs together", true],
  ] as const)
    head.append(Object.assign(document.createElement("th"), { textContent: label, title: tip, className: num ? "num" : "" }));
  q("thead").replaceChildren(head);
  panel.classList.add("tree-view");
  const rows: HTMLElement[] = [];
  for (const g of groups) {
    const key = `q:${g.sql}`;
    const open = expanded.has(key);
    const tr = document.createElement("tr");
    tr.classList.toggle("selected", g === selectedQuery);
    const name = cell("", "name sql");
    const chevron = Object.assign(document.createElement("span"), { className: `chevron codicon codicon-chevron-${open ? "down" : "right"}` });
    chevron.onclick = (e) => (e.stopPropagation(), expanded.delete(key) || expanded.add(key), render());
    name.append(chevron);
    if (g.kind) name.append(Object.assign(document.createElement("span"), { className: `query-flag ${g.kind}`, textContent: g.kind === "duplicate" ? "duplicate" : "repeated" }));
    name.append(g.sql);
    name.title = g.sql;
    const time = timeCell(g.time, "bar");
    time.style.setProperty("--share", share(g.time) || "0%");
    tr.append(name, cell(`${g.runs.length}×`, "num"), time);
    tr.onclick = () => selectQuery(g);
    rows.push(tr);
    if (!open) continue;
    for (const run of g.runs) {
      const sub = document.createElement("tr");
      const bindings = cell(run.bindings.length ? run.bindings.join(", ") : "No bindings", "name bindings");
      bindings.style.paddingLeft = "34px";
      bindings.title = withBindings(run);
      sub.append(bindings, cell("", "num"), timeCell(run.time));
      sub.onclick = () => selectQuery(g);
      rows.push(sub);
    }
  }
  if (!groups.length) rows.push(Object.assign(document.createElement("tr"), { innerHTML: `<td class="muted" colspan="3">No queries match.</td>` }));
  // The Database total counts every statement PDO ran; this list only has those Laravel's connection ran.
  const note = document.createElement("tr");
  note.append(Object.assign(cell("Queries run through Laravel's database connection. Statements a driver runs itself, such as SQLite's PRAGMA when connecting, aren't listed.", "muted"), { colSpan: 3 }));
  rows.push(note);
  shown = [];
  q("tbody").replaceChildren(...rows);
}

function selectQuery(g: QueryGroup) {
  selectedQuery = g;
  render();
  showQueryDetail();
}

/** The side pane for a query: its SQL, why it's flagged, a copy with bindings, and each run. */
function showQueryDetail() {
  const g = selectedQuery;
  const detail = q(".profiler-detail");
  if (!g) {
    detail.innerHTML = `<p class="muted">Select a query to see its SQL and each time it ran.</p>`;
    return;
  }
  const heading = document.createElement("div");
  heading.className = "profiler-detail-heading";
  heading.append(
    Object.assign(document.createElement("pre"), { className: "query-sql", textContent: g.sql }),
    Object.assign(document.createElement("div"), { className: "muted", textContent: `${g.runs.length} ${g.runs.length === 1 ? "run" : "runs"} · ${ms(g.time)} (${share(g.time)} of the run)` }),
  );
  if (g.kind)
    heading.append(
      Object.assign(document.createElement("p"), {
        className: `query-note ${g.kind}`,
        textContent:
          g.kind === "duplicate"
            ? "The same query with the same bindings ran more than once. Its result could be kept and reused."
            : "The same query ran with different bindings, often once per item in a loop (an N+1 query). Eager loading, such as with('relation'), can fetch them in one query.",
      }),
    );
  const copy = Object.assign(document.createElement("button"), { className: "chip", textContent: "Copy with bindings", title: "Copy the first run's SQL with its bindings in place, for a database console" });
  copy.onclick = () => navigator.clipboard.writeText(withBindings(g.runs[0])).then(() => host.status("Copied the query."));
  const where = Object.assign(document.createElement("button"), { className: "chip", textContent: "Show callers", title: "Select PDOStatement->execute in the function table, to see which code ran queries" });
  where.onclick = () => {
    const execute = profile.functions.find((f) => f.name === "php::PDOStatement->execute");
    if (!execute) return;
    panel.querySelector<HTMLElement>('[data-view="functions"]')!.click();
    select(execute);
  };
  const actions = Object.assign(document.createElement("div"), { className: "query-actions" });
  actions.append(copy, where);
  heading.append(actions);
  const runs = document.createElement("section");
  runs.append(Object.assign(document.createElement("h3"), { textContent: `Runs (${g.runs.length})` }));
  const table = document.createElement("table");
  for (const run of g.runs.slice(0, 200)) {
    const tr = document.createElement("tr");
    const b = cell(run.bindings.join(", ") || "No bindings", "name");
    b.title = withBindings(run);
    tr.append(b, cell(ms(run.time), "num"));
    table.append(tr);
  }
  runs.append(table);
  detail.replaceChildren(heading, runs);
}

// ---- Selection and the side pane ----

let selectedKey = "";
const rowOf = new Map<string, HTMLTableRowElement>();

/** Selects a row: highlights it and lists its function's callers and callees beside the table. */
function selectRow(r: Row) {
  rowOf.get(selectedKey)?.classList.remove("selected");
  selectedKey = r.key;
  selected = r.fn;
  const row = rowOf.get(r.key);
  if (row?.isConnected) row.classList.add("selected"), row.scrollIntoView({ block: "nearest" });
  showDetail();
}

/** Selects a function from the side pane: its row in the function table, when the table shows it. */
function select(f: ProfiledFunction) {
  if (view === "functions") return selectRow(shown.find((r) => r.fn === f) ?? { fn: f, key: f.name, depth: 0, calls: f.calls, time: f.inclusive });
  rowOf.get(selectedKey)?.classList.remove("selected");
  selected = f;
  selectedKey = "";
  showDetail();
}
/** The side pane: the selected function, what called it, and what it called, each by time. */
function showDetail() {
  if (view === "queries") return showQueryDetail();
  const detail = q(".profiler-detail");
  const spots = zoomedHotSpots();
  if (!selected) {
    detail.innerHTML = `<p class="muted">Select a function to see its callers and the functions it calls. Double-click it, or press ⏎, to open it.</p>`;
    if (spots) detail.prepend(spots);
    return;
  }
  const f = selected;
  const heading = document.createElement("div");
  heading.className = "profiler-detail-heading";
  const title = Object.assign(document.createElement("div"), { className: "name", textContent: displayName(f), title: f.name });
  const link = Object.assign(document.createElement(isInternal(f) ? "span" : "a"), { className: "where", textContent: isInternal(f) ? "PHP's own function" : where(f) });
  if (!isInternal(f)) (link as HTMLAnchorElement).href = "#", (link.onclick = (e) => (e.preventDefault(), openSource(f)));
  const stats = Object.assign(document.createElement("div"), {
    className: "muted",
    textContent: `${f.calls} ${f.calls === 1 ? "call" : "calls"} · own ${ms(f.self)} · total ${ms(f.inclusive)} (${share(f.inclusive)}) · memory ${bytes(f.memory)}`,
  });
  heading.append(title, link, stats);
  detail.replaceChildren(...(spots ? [spots] : []), heading, calls("Called by", f.callers), calls("Calls", f.callees));
}

/** In a zoomed flame graph: the functions with the most own time inside the zoomed bar, which is where it's slow. */
function zoomedHotSpots() {
  const zoomed = view === "flame" ? flamePath.at(-1) : undefined;
  if (!zoomed) return null;
  const section = document.createElement("section");
  section.className = "hot-spots";
  section.append(
    Object.assign(document.createElement("h3"), { textContent: `Inside ${displayName(zoomed.fn).split(/\\|->|::/).pop()}: own time` }),
    Object.assign(document.createElement("p"), { className: "muted", textContent: `Where its ${ms(zoomed.time)} goes, by the code that ran it.` }),
  );
  const table = document.createElement("table");
  for (const spot of hotSpots(zoomed).slice(0, 12)) {
    if (spot.self < zoomed.time / 1000) break;
    const tr = document.createElement("tr");
    const name = cell(displayName(spot.fn), "name");
    name.title = `${spot.fn.name}\n${where(spot.fn)}`;
    const part = `${((spot.self / zoomed.time) * 100).toFixed(1)}%`;
    const time = cell(`${ms(spot.self)} · ${part}`, "num bar");
    time.style.setProperty("--share", part);
    tr.append(name, cell(`${spot.calls}×`, "num"), time);
    tr.onclick = () => {
      selected = spot.fn;
      renderFlame();
      showDetail();
    };
    tr.ondblclick = () => openSource(spot.fn);
    table.append(tr);
  }
  section.append(table);
  return section;
}

function calls(label: string, list: Call[]) {
  const section = document.createElement("section");
  section.append(Object.assign(document.createElement("h3"), { textContent: `${label} (${list.length})` }));
  if (!list.length) {
    section.append(Object.assign(document.createElement("p"), { className: "muted", textContent: label === "Calls" ? "No other functions." : "Nothing: it's where the run starts." }));
    return section;
  }
  const table = document.createElement("table");
  for (const c of [...list].sort((a, b) => b.time - a.time).slice(0, 100)) {
    const tr = document.createElement("tr");
    const name = cell(displayName(c.fn), "name");
    name.title = c.fn.name;
    tr.append(name, cell(`${c.calls}×`, "num"), timeCell(c.time));
    tr.onclick = () => select(c.fn);
    tr.ondblclick = () => openSource(c.fn);
    table.append(tr);
  }
  section.append(table);
  return section;
}

// ---- Times in the editor ----
// From the open profile: at the end of each line that made calls, the time those calls took, and at each function's
// declaration, its total time. Anything under a thousandth of the run is left out, so the marks point at what matters.

const lineDecorations = new Map<monaco.editor.ITextModel, string[]>();

/** Functions by the file that defines them, for the times at their declarations. */
let functionsByFile = new Map<string, ProfiledFunction[]>();

function decorate(model: monaco.editor.ITextModel) {
  const path = model.uri.fsPath;
  const min = profile.total / 1000;
  const lineCount = model.getLineCount();
  const heat = (time: number) => (time / profile.total >= 0.1 ? " hot" : time / profile.total >= 0.01 ? " warm" : "");
  const at = (line: number, content: string, className: string, hover: string): monaco.editor.IModelDeltaDecoration => {
    const column = model.getLineMaxColumn(line);
    return {
      range: new monaco.Range(line, column, line, column),
      options: {
        after: { content, inlineClassName: className },
        hoverMessage: { value: hover },
        // The range is empty (the end of the line), and Monaco hides empty decorations without this.
        showIfCollapsed: true,
        stickiness: 1,
      },
    };
  };
  const marks = !editorTimes
    ? []
    : [
        // Where a function is declared: its total time and how often it ran.
        ...(functionsByFile.get(path) ?? [])
          .filter((f) => f.inclusive >= min && f.line > 0 && f.line <= lineCount)
          .map((f) =>
            at(
              f.line,
              `  ⏱ ${ms(f.inclusive)} · ${share(f.inclusive)} · ${f.calls} ${f.calls === 1 ? "call" : "calls"}`,
              `profile-time declaration${heat(f.inclusive)}`,
              `\`${displayName(f)}\` ran ${f.calls} ${f.calls === 1 ? "time" : "times"}: ${ms(f.inclusive)} in total (${share(f.inclusive)} of the run), ${ms(f.self)} in its own code, ${bytes(f.memory)} of memory.`,
            ),
          ),
        // Where calls are made: how long they took.
        ...[...(profile.sites.get(path) ?? [])]
          .filter(([line, site]) => site.time >= min && line <= lineCount)
          .map(([line, site]) =>
            at(line, `  ${ms(site.time)} · ${share(site.time)}`, `profile-time${heat(site.time)}`, `Calls from this line: ${site.calls}, taking ${ms(site.time)} (${share(site.time)} of the profiled run).`),
          ),
      ];
  lineDecorations.set(model, model.deltaDecorations(lineDecorations.get(model) ?? [], marks));
}

const decorateAll = () => monaco.editor.getModels().filter((m) => m.uri.scheme === "file").forEach(decorate);

monaco.editor.onDidCreateModel((model) => {
  if (model.uri.scheme !== "file") return;
  if (profile.sites.size) decorate(model);
  model.onWillDispose(() => lineDecorations.delete(model));
});
