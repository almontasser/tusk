// The Xdebug profiler: runs PHP with profiling, and shows a profile's functions in the Profiler tab, sortable by
// calls, own time, and total time. Profiles from the editor's runs go to the app cache; Xdebug's own output folder
// is listed too, for profiles you made yourself.
import { invoke } from "@tauri-apps/api/core";
import { appCacheDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { parseCachegrind, type Profile, type ProfiledFunction } from "./cachegrind";
import { pick, rank } from "./palette";
import { showPanelView } from "./terminal";

type Host = { root(): string; openAt(path: string, line: number): unknown; status(text: string): void };
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
}

/** Lists recent profiles from the editor's runs and Xdebug's output folder, and opens the one you choose. */
export async function chooseProfile() {
  const xdebugDir = await invoke<string>("run_capture", { cwd: "/", program: "php", args: ["-r", 'echo ini_get("xdebug.output_dir");'], input: null }).catch(() => "");
  const files = [...(await profilesIn(await profileDir())), ...(xdebugDir.trim() ? await profilesIn(xdebugDir.trim()) : [])].sort((a, b) => b.time - a.time);
  const kb = (size: number) => (size >= 1_000_000 ? `${(size / 1_000_000).toFixed(1)} MB` : `${Math.ceil(size / 1000)} KB`);
  const items = [
    ...files.map((f) => ({
      label: `${new Date(f.time * 1000).toLocaleString()} · ${kb(f.size)}`,
      detail: f.path.split("/").pop(),
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
  let text: string;
  try {
    text = path.endsWith(".gz")
      ? await invoke<string>("run_capture", { cwd: "/", program: "/usr/bin/gzip", args: ["-dc", path], input: null })
      : await invoke<string>("read_file", { path });
  } catch (e) {
    return host.status(`Couldn't read the profile: ${e}`);
  }
  profile = parseCachegrind(text);
  if (!profile.functions.length) return host.status(`Couldn't read the profile: ${path} isn't a Cachegrind file.`);
  const script = profile.command.startsWith(host.root() + "/") ? profile.command.slice(host.root().length + 1) : profile.command;
  q(".tests-summary").textContent = `${script} · ${ms(profile.total)} · ${profile.functions.length} functions`;
  q(".tests-summary").title = path;
  render();
  showPanelView("Profiler", panel);
}

// ---- The Profiler tab ----

const MAX_ROWS = 500;
let profile: Profile = { command: "", functions: [], total: 0 };
let sort: keyof ProfiledFunction = "self";

const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : n >= 10 ? `${Math.round(n)} ms` : `${n.toFixed(2)} ms`);
const share = (n: number) => (profile.total ? `${((n / profile.total) * 100).toFixed(1)}%` : "");

const panel = document.createElement("div");
panel.className = "tests profiler";
panel.innerHTML = `
  <div class="tests-toolbar">
    <input class="profiler-filter" placeholder="Filter functions" aria-label="Filter functions" spellcheck="false" />
    <span class="tests-summary"></span>
  </div>
  <div class="profiler-body">
    <table>
      <thead><tr>
        <th data-sort="name">Function</th>
        <th data-sort="calls" class="num">Calls</th>
        <th data-sort="self" class="num">Own time</th>
        <th data-sort="inclusive" class="num">Total time</th>
      </tr></thead>
      <tbody></tbody>
    </table>
  </div>`;
const q = (sel: string) => panel.querySelector(sel) as HTMLElement;
const filter = q(".profiler-filter") as HTMLInputElement;
filter.oninput = () => render();
panel.querySelectorAll<HTMLElement>("th").forEach((th) => (th.onclick = () => ((sort = th.dataset.sort as keyof ProfiledFunction), render())));

function cell(text: string, className = "") {
  const td = document.createElement("td");
  td.className = className;
  td.textContent = text;
  return td;
}

/** Shows the functions that match the filter, sorted by the chosen column: names A to Z, numbers largest first. */
function render() {
  const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = profile.functions
    .filter((f) => words.every((w) => f.name.toLowerCase().includes(w)))
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : (b[sort] as number) - (a[sort] as number)));
  panel.querySelectorAll<HTMLElement>("th").forEach((th) => th.classList.toggle("sorted", th.dataset.sort === sort));
  q("tbody").replaceChildren(
    ...rows.slice(0, MAX_ROWS).map((f) => {
      const tr = document.createElement("tr");
      const internal = f.file === "php:internal";
      const where = internal ? "PHP" : `${f.file.startsWith(host.root() + "/") ? f.file.slice(host.root().length + 1) : f.file}:${f.line}`;
      // Closures are named by their file, such as {closure:/Users/…/app/Foo.php:12-14}.
      const name = cell(f.name.replaceAll(host.root() + "/", ""), "name");
      name.append(Object.assign(document.createElement("span"), { className: "where", textContent: where }));
      // The bar shows own time as a share of the whole run, so the costly functions stand out.
      const own = cell(`${ms(f.self)} · ${share(f.self)}`, "num bar");
      own.style.setProperty("--share", share(f.self) || "0%");
      tr.append(name, cell(String(f.calls), "num"), own, cell(`${ms(f.inclusive)} · ${share(f.inclusive)}`, "num"));
      if (!internal) {
        tr.title = "Open the function";
        tr.onclick = () => host.openAt(f.file, f.line || 1);
      }
      return tr;
    }),
  );
  if (rows.length > MAX_ROWS) {
    const more = document.createElement("tr");
    more.append(cell(`${rows.length - MAX_ROWS} more functions. Filter to find them.`, "muted"));
    q("tbody").append(more);
  }
}
