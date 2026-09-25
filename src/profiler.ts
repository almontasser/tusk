// The Xdebug profiler: runs PHP with profiling, and shows a profile's functions in the Profiler tab, sortable by
// calls, own time, and total time. Profiles from the editor's runs go to the app cache; Xdebug's own output folder
// is listed too, for profiles you made yourself.
import { invoke } from "@tauri-apps/api/core";
import { appCacheDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import type { Call, Profile, ProfiledFunction } from "./cachegrind";
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
export const profileEnv = (dir: string) => ["XDEBUG_MODE=profile", "XDEBUG_TRIGGER=1", `XDEBUG_CONFIG=output_dir=${dir} profiler_output_name=cachegrind.out.%t.%p`];

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
  openTerminal(`${root}/public`, "Profiling server", ["/usr/bin/env", ...profileEnv(dir), "php", "-S", `127.0.0.1:${port}`, `${root}/${script}`]);
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

async function requestAndProfile(path: string) {
  const root = host.root();
  try {
    localStorage.setItem(`profilerUrl:${root}`, path);
  } catch {}
  let port = server?.root === root && (await listening(server.port)) ? server.port : await startProfilingServer();
  if (!port) return;
  // Wait for the server to accept connections.
  for (let i = 0; i < 25 && !(await listening(port)); i++) await sleep(200);
  const dir = await profileDir();
  const since = Math.floor(Date.now() / 1000);
  host.status(`Requesting ${path}…`, "profiler:progress");
  const result = await invoke<string>("run_capture", {
    cwd: "/",
    program: "/usr/bin/curl",
    args: ["-s", "-o", "/dev/null", "-w", "%{http_code} %{time_total}", `http://127.0.0.1:${port}${path}`],
    input: null,
  }).catch(() => "");
  host.status("", "profiler:progress");
  const [code, seconds] = result.split(" ");
  if (!code || code === "000") return host.status(`Couldn't request ${path}: the profiling server didn't answer. See its terminal tab.`);
  // Xdebug finishes the profile when PHP shuts the request down, just after the response: wait until it stops growing.
  let size = -1;
  for (let i = 0; i < 25; i++) {
    const newest = await newestProfile(dir, since);
    if (newest && newest.size === size) break;
    size = newest?.size ?? -1;
    await sleep(200);
  }
  await openNewestProfile(dir, since, `GET ${path} (${code})`);
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
  if (!largest) return host.status("Profiling failed: Xdebug wrote no profile. Check that Xdebug is installed (php -m).");
  await openProfile(largest.path, label);
  // Keep the newest profiles only; a Laravel request's profile can be several megabytes.
  const old = (await profilesIn(dir)).sort((a, b) => b.time - a.time).slice(KEEP_PROFILES);
  for (const f of old) await invoke("remove_path", { path: f.path }).catch(() => {});
}

/** Lists recent profiles from the editor's runs and Xdebug's output folder, and opens the one you choose. */
export async function chooseProfile() {
  const xdebugDir = await invoke<string>("run_capture", { cwd: "/", program: "php", args: ["-r", 'echo ini_get("xdebug.output_dir");'], input: null }).catch(() => "");
  const editorDir = await profileDir();
  const files = [...(await profilesIn(editorDir)), ...(xdebugDir.trim() ? await profilesIn(xdebugDir.trim()) : [])].sort((a, b) => b.time - a.time);
  const kb = (size: number) => (size >= 1_000_000 ? `${(size / 1_000_000).toFixed(1)} MB` : `${Math.ceil(size / 1000)} KB`);
  const items = [
    ...files.map((f) => ({
      label: `${new Date(f.time * 1000).toLocaleString()} · ${kb(f.size)}`,
      detail: `${f.path.startsWith(editorDir) ? "Editor run" : "Xdebug folder"} · ${f.path.split("/").pop()}`,
      icon: "codicon-pulse",
      run: () => openProfile(f.path),
    })),
    {
      label: "Choose File…",
      icon: "codicon-folder-opened",
      run: async () => {
        const path = await open({ directory: false });
        if (typeof path === "string") openProfile(path);
      },
    },
  ];
  pick(files.length ? "Open an Xdebug profile" : "No profiles yet: run Profile Test at Cursor, or choose a file", (q) => rank(q, items));
}

/**
 * Reads a profile, decompressing it when Xdebug gzipped it (the default), and shows the Profiler tab. `label` names
 * what was profiled, such as a request; without it, the tab shows the script Xdebug recorded.
 */
export async function openProfile(path: string, label?: string) {
  host.status(`Reading ${path.split("/").pop()}…`, "profiler:progress");
  let text: string;
  try {
    text = path.endsWith(".gz")
      ? await invoke<string>("run_capture", { cwd: "/", program: "/usr/bin/gzip", args: ["-dc", path], input: null })
      : await invoke<string>("read_file", { path });
  } catch (e) {
    host.status("", "profiler:progress");
    return host.status(`Couldn't read the profile: ${e}`);
  }
  const parsed = await parse(text).catch(() => null);
  host.status("", "profiler:progress");
  if (!parsed) return host.status(`Couldn't read the profile: ${path} failed to parse.`);
  if (!parsed.functions.length) return host.status(`Couldn't read the profile: ${path} isn't a Cachegrind file.`);
  profile = parsed;
  functionsByFile = new Map();
  for (const f of profile.functions) functionsByFile.set(f.file, [...(functionsByFile.get(f.file) ?? []), f]);
  selected = undefined;
  expanded = hotPath();
  q(".tests-summary").textContent = `${label ?? relative(profile.command)} · ${ms(profile.total)} · ${profile.functions.length} functions`;
  q(".tests-summary").title = path;
  render();
  showDetail();
  decorateAll();
  showPanelView("Profiler", panel);
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
let profile: Profile = { command: "", functions: [], total: 0, sites: new Map() };
let view: "functions" | "tree" = "functions";
let sort: "name" | "calls" | "self" | "inclusive" | "memory" = "self";
let selected: ProfiledFunction | undefined;
/** The rows the table shows, in order, so the arrow keys can move through them. */
let shown: Row[] = [];
/** A table row: a function, or in the call tree, a function under its caller, with the calls on that path. */
type Row = { fn: ProfiledFunction; key: string; depth: number; calls: number; time: number; recursive?: boolean; match?: boolean };
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
    <div class="segmented" role="group" aria-label="View">
      <button data-view="functions" aria-pressed="true">Functions</button>
      <button data-view="tree" aria-pressed="false">Call tree</button>
    </div>
    <input class="profiler-filter" placeholder="Filter functions" aria-label="Filter functions" spellcheck="false" />
    <label class="profiler-check" data-option="project" title="Hide vendor packages and PHP's own functions"><input type="checkbox" /> Project code only</label>
    <label class="profiler-check" data-option="editor" title="Show how long the calls on each line took, at the end of the line in open files"><input type="checkbox" /> Times in editor</label>
    <span class="tests-summary"></span>
  </div>
  <div class="profiler-body">
    <div class="profiler-table" tabindex="0" aria-label="Functions">
      <table>
        <thead></thead>
        <tbody></tbody>
      </table>
    </div>
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
panel.querySelectorAll<HTMLButtonElement>("[data-view]").forEach(
  (b) =>
    (b.onclick = () => {
      view = b.dataset.view as typeof view;
      if (view === "tree") openBackTrace();
      panel.querySelectorAll<HTMLElement>("[data-view]").forEach((v) => (v.ariaPressed = String(v === b)));
      render();
      tableEl.focus();
    }),
);

// ↑ and ↓ move the selection, ⏎ opens the selected function, and in the call tree, → and ← open and close a node.
tableEl.onkeydown = (e) => {
  const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 15, PageUp: -15 };
  const at = shown.findIndex((r) => r.key === selectedKey);
  const row = shown[at];
  if (e.key in moves && shown.length) selectRow(shown[Math.max(0, Math.min(shown.length - 1, at + moves[e.key]))]);
  else if (e.key === "Enter" && selected) openSource(selected);
  else if (view === "tree" && row && e.key === "ArrowRight" && !row.recursive && (filterWords().length ? row.fn.callers : row.fn.callees).length) {
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
  functions: [
    ["name", "Function", ""],
    ["calls", "Calls", "How many times it ran"],
    ["self", "Own time", "Time in the function's own code, not in what it called"],
    ["inclusive", "Total time", "Time from the start to the end of its calls, including what it called"],
    ["memory", "Memory", "How much memory in use grew over its calls, including what it called. Memory freed before a call returned doesn't count."],
  ],
  tree: [
    ["name", "Call tree", "Each function under the function that called it. Type in the filter to see a function's callers instead."],
    ["calls", "Calls", "How many times the caller called it"],
    ["inclusive", "Time", "Time in those calls, including what they called"],
  ],
} as const;

/** Shows the function table, or the call tree, with the chosen sort and filter. */
function render() {
  const backTrace = view === "tree" && filterWords().length > 0;
  const heads = columns[view].map(([key, name, tip]) => {
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
  project.disabled = view === "tree";
  filter.placeholder = view === "tree" ? "Find in the call tree" : "Filter functions";
  let note = "";
  if (view === "functions") {
    const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    const matching = profile.functions
      .filter((f) => (!projectOnly || isProject(f)) && words.every((w) => f.name.toLowerCase().includes(w)))
      .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : b[sort] - a[sort]));
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
    row.append(Object.assign(cell(note, "muted"), { colSpan: columns[view].length }));
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
  tr.append(name, cell(String(f.calls), "num"), own, timeCell(f.inclusive), cell(bytes(f.memory), "num"));
  tr.onclick = () => (selectRow(r), tableEl.focus());
  tr.ondblclick = () => openSource(f);
  rowOf.set(r.key, tr);
  return tr;
}

// ---- The call tree ----
// Built from caller-to-callee totals, not from each call: a node's children are everything its function called,
// from any caller. That keeps it small for millions of calls; the times under a node are its function's, overall.

const MAX_TREE_ROWS = 2000;

/**
 * The rows of open nodes, depth first, children by time. A function already on the path isn't opened again.
 * With text in the filter, the matching functions are the roots instead, and each opens to the functions that
 * called it: a back trace, as PhpStorm calls it.
 */
function treeRows(): Row[] {
  const rows: Row[] = [];
  const words = filterWords();
  const up = words.length > 0;
  const walk = (row: Row, path: Set<ProfiledFunction>) => {
    if (rows.length >= MAX_TREE_ROWS) return;
    rows.push(row);
    if (row.recursive || !expanded.has(row.key)) return;
    const next = new Set(path).add(row.fn);
    for (const c of [...(up ? row.fn.callers : row.fn.callees)].sort((a, b) => b.time - a.time))
      walk({ fn: c.fn, key: `${row.key}\n${c.fn.name}`, depth: row.depth + 1, calls: c.calls, time: c.time, recursive: next.has(c.fn) }, next);
  };
  for (const f of treeRoots()) walk({ fn: f, key: `${up ? "↑" : ""}${f.name}`, depth: 0, calls: f.calls, time: f.inclusive, match: up }, new Set());
  return rows;
}

const filterWords = () => filter.value.toLowerCase().split(/\s+/).filter(Boolean);

/** The call tree's roots: where the run starts, or with text in the filter, the matching functions by total time. */
function treeRoots() {
  const words = filterWords();
  const roots = words.length ? profile.functions.filter((f) => words.every((w) => f.name.toLowerCase().includes(w))) : profile.functions.filter((f) => !f.callers.length);
  return roots.sort((a, b) => b.inclusive - a.inclusive).slice(0, MAX_ROWS);
}

/** Opens the busiest chain of callers above the first match, so its back trace shows at once. */
function openBackTrace() {
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
  let fn = profile.functions.find((f) => f.name === "{main}") ?? profile.functions.find((f) => !f.callers.length);
  let key = fn?.name ?? "";
  const seen = new Set<ProfiledFunction>();
  while (fn && !seen.has(fn) && open.size < 40) {
    seen.add(fn);
    open.add(key);
    const next = [...fn.callees].sort((a, b) => b.time - a.time)[0];
    if (!next || next.time < profile.total / 10) break;
    fn = next.fn;
    key = `${key}\n${fn.name}`;
  }
  return open;
}

function treeRow(r: Row) {
  const tr = document.createElement("tr");
  tr.classList.toggle("selected", r.key === selectedKey);
  tr.classList.toggle("match", !!r.match);
  const name = cell("", "name");
  name.style.paddingLeft = `${6 + r.depth * 14}px`;
  const canOpen = !r.recursive && (filterWords().length ? r.fn.callers : r.fn.callees).length > 0;
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
  const detail = q(".profiler-detail");
  if (!selected) {
    detail.innerHTML = `<p class="muted">Select a function to see its callers and the functions it calls. Double-click it, or press ⏎, to open it.</p>`;
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
  detail.replaceChildren(heading, calls("Called by", f.callers), calls("Calls", f.callees));
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
