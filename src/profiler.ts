// The Xdebug profiler: runs PHP with profiling, and shows a profile's functions in the Profiler tab, sortable by
// calls, own time, and total time. Profiles from the editor's runs go to the app cache; Xdebug's own output folder
// is listed too, for profiles you made yourself.
import { invoke } from "@tauri-apps/api/core";
import { appCacheDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { type Call, parseCachegrind, type Profile, type ProfiledFunction } from "./cachegrind";
import { pick, rank } from "./palette";
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
export async function startProfilingServer() {
  const root = host.root();
  const server = "vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php";
  if (!(await invoke<boolean>("path_exists", { path: `${root}/${server}` }))) return host.status("The profiling server needs a Laravel project with its vendor folder installed.");
  let port = 8000;
  // lsof exits with an error when nothing listens on the port.
  while (port < 8100 && (await invoke("run_capture", { cwd: "/", program: "/usr/sbin/lsof", args: ["-iTCP:" + port, "-sTCP:LISTEN"], input: null }).then(() => true, () => false))) port++;
  const dir = await profileDir();
  host.status(`Profiling server on http://127.0.0.1:${port}. Each request writes a profile; open it with Open Xdebug Profile….`);
  // server.php finds the public folder from the working directory, as artisan serve runs it.
  openTerminal(`${root}/public`, "Profiling server", ["/usr/bin/env", ...profileEnv(dir), "php", "-S", `127.0.0.1:${port}`, `${root}/${server}`]);
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
export async function openNewestProfile(dir: string, since: number) {
  const largest = (await profilesIn(dir)).filter((f) => Number(f.path.match(/cachegrind\.out\.(\d+)/)?.[1]) >= since).sort((a, b) => b.size - a.size)[0];
  if (!largest) return host.status("Profiling failed: Xdebug wrote no profile. Check that Xdebug is installed (php -m).");
  await openProfile(largest.path);
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

/** Reads a profile, decompressing it when Xdebug gzipped it (the default), and shows the Profiler tab. */
export async function openProfile(path: string) {
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
  // Let the status bar paint before parsing, which takes a moment for a large profile.
  await new Promise((r) => setTimeout(r, 0));
  const parsed = parseCachegrind(text);
  host.status("", "profiler:progress");
  if (!parsed.functions.length) return host.status(`Couldn't read the profile: ${path} isn't a Cachegrind file.`);
  profile = parsed;
  selected = undefined;
  q(".tests-summary").textContent = `${relative(profile.command)} · ${ms(profile.total)} · ${profile.functions.length} functions`;
  q(".tests-summary").title = path;
  render();
  showDetail();
  showPanelView("Profiler", panel);
}

// ---- The Profiler tab ----

const MAX_ROWS = 500;
let profile: Profile = { command: "", functions: [], total: 0 };
let sort: "name" | "calls" | "self" | "inclusive" = "self";
let selected: ProfiledFunction | undefined;
/** The functions the table shows, in order, so the arrow keys can move through them. */
let shown: ProfiledFunction[] = [];

const readSetting = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
let projectOnly = readSetting("profilerProjectOnly") === "true";

const relative = (path: string) => (path.startsWith(host.root() + "/") ? path.slice(host.root().length + 1) : path);
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : n >= 10 ? `${Math.round(n)} ms` : n >= 0.01 ? `${n.toFixed(2)} ms` : `${Math.round(n * 1000)} µs`);
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
    <input class="profiler-filter" placeholder="Filter functions" aria-label="Filter functions" spellcheck="false" />
    <label class="profiler-project" title="Hide vendor packages and PHP's own functions"><input type="checkbox" /> Project code only</label>
    <span class="tests-summary"></span>
  </div>
  <div class="profiler-body">
    <div class="profiler-table" tabindex="0" aria-label="Functions">
      <table>
        <thead><tr>
          <th data-sort="name">Function</th>
          <th data-sort="calls" class="num">Calls</th>
          <th data-sort="self" class="num">Own time</th>
          <th data-sort="inclusive" class="num">Total time</th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="profiler-detail"></div>
  </div>`;
const q = (sel: string) => panel.querySelector(sel) as HTMLElement;
const filter = q(".profiler-filter") as HTMLInputElement;
const project = q(".profiler-project input") as HTMLInputElement;
const tableEl = q(".profiler-table");
project.checked = projectOnly;
filter.oninput = () => render();
project.onchange = () => {
  projectOnly = project.checked;
  try {
    localStorage.setItem("profilerProjectOnly", String(projectOnly));
  } catch {}
  render();
};
q('[data-action="open"]').onclick = () => chooseProfile();
panel.querySelectorAll<HTMLElement>("th").forEach((th) => (th.onclick = () => ((sort = th.dataset.sort as typeof sort), render())));

// ↑ and ↓ move the selection, and ⏎ opens the selected function.
tableEl.onkeydown = (e) => {
  const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 15, PageUp: -15 };
  if (e.key in moves && shown.length) {
    const at = selected ? shown.indexOf(selected) : -1;
    select(shown[Math.max(0, Math.min(shown.length - 1, at + moves[e.key]))]);
  } else if (e.key === "Enter" && selected) openSource(selected);
  else return;
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

/** Shows the functions that match the filter, sorted by the chosen column: names A to Z, numbers largest first. */
function render() {
  const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
  shown = profile.functions
    .filter((f) => (!projectOnly || isProject(f)) && words.every((w) => f.name.toLowerCase().includes(w)))
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : b[sort] - a[sort]));
  const total = shown.length;
  shown = shown.slice(0, MAX_ROWS);
  panel.querySelectorAll<HTMLElement>("th").forEach((th) => th.classList.toggle("sorted", th.dataset.sort === sort));
  q("tbody").replaceChildren(
    ...shown.map((f) => {
      const tr = document.createElement("tr");
      tr.classList.toggle("selected", f === selected);
      const name = cell(displayName(f), "name");
      name.title = `${f.name}\n${where(f)}`;
      name.append(Object.assign(document.createElement("span"), { className: "where", textContent: where(f) }));
      // A line under own time shows its share of the run, so the costly functions stand out.
      const own = timeCell(f.self, "bar");
      own.style.setProperty("--share", share(f.self) || "0%");
      tr.append(name, cell(String(f.calls), "num"), own, timeCell(f.inclusive));
      tr.onclick = () => (select(f), tableEl.focus());
      tr.ondblclick = () => openSource(f);
      rowOf.set(f, tr);
      return tr;
    }),
  );
  const note = total > MAX_ROWS ? `${total - MAX_ROWS} more functions. Filter to find them.` : !total ? "No functions match." : "";
  if (note) {
    const tr = document.createElement("tr");
    tr.append(Object.assign(cell(note, "muted"), { colSpan: 4 }));
    q("tbody").append(tr);
  }
}
const rowOf = new WeakMap<ProfiledFunction, HTMLTableRowElement>();

/** Selects a function: highlights its row and lists its callers and callees beside the table. */
function select(f: ProfiledFunction) {
  if (selected) rowOf.get(selected)?.classList.remove("selected");
  selected = f;
  const row = rowOf.get(f);
  if (row?.isConnected) row.classList.add("selected"), row.scrollIntoView({ block: "nearest" });
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
    textContent: `${f.calls} ${f.calls === 1 ? "call" : "calls"} · own ${ms(f.self)} · total ${ms(f.inclusive)} (${share(f.inclusive)})`,
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
