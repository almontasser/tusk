// Composer tool window: the project's direct packages with available updates, and actions to require,
// update, and remove packages. Commands use the bundled composer.phar and run in terminal tabs.
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { packages, type Package } from "./composerdata";
import { pick } from "./palette";
import { openTerminal } from "./terminal";

type Host = { root(): string; status(text: string): void };

let host: Host;
const $ = (id: string) => document.getElementById(id)!;
let composer = "";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}

const capture = (...args: string[]) => invoke<string>("run_capture", { cwd: host.root(), program: "php", args: [composer, ...args, "--no-interaction"], input: null });

/** Runs a Composer command in a terminal tab, then reloads the list. */
async function run(title: string, args: string[]) {
  composer ||= await invoke<string>("tool_path", { name: "composer.phar" });
  openTerminal(host.root(), title, ["php", composer, ...args], () => loadPackages());
}

export async function loadPackages() {
  if (!host.root()) return;
  composer ||= await invoke<string>("tool_path", { name: "composer.phar" });
  const list = $("composer-list");
  const json = await invoke<string>("read_file", { path: `${host.root()}/composer.json` }).catch(() => null);
  if (json === null) return list.replaceChildren(el("li", "muted", "This project has no composer.json."));
  list.replaceChildren(el("li", "muted", "Loading…"));
  let show: string;
  try {
    show = await capture("show", "--direct", "--format=json");
  } catch (e) {
    return list.replaceChildren(el("li", "muted", `Can't list packages: ${String(e).trim()}. Run composer install first.`));
  }
  render(packages(show, null, json));
  // Checking for updates asks Packagist, so it comes second.
  $("composer-summary").textContent = "Checking for updates…";
  const outdated = await capture("outdated", "--direct", "--format=json").catch(() => null);
  const all = packages(show, outdated, json);
  render(all);
  const updates = all.filter((p) => p.latest).length;
  $("composer-summary").textContent = outdated === null ? "Couldn't check for updates." : updates ? `${updates} ${updates === 1 ? "update" : "updates"} available` : "Everything is up to date.";
}

function render(list: Package[]) {
  $("composer-list").replaceChildren(
    ...list.map((p) => {
      const li = el("li", "composer-package");
      li.title = `${p.description}${p.abandoned ? "\n\nAbandoned" : ""}`;
      const name = el("span", "name", p.name);
      if (p.dev) name.append(el("span", "badge", "dev"));
      if (p.abandoned) name.append(el("span", "badge warn", "abandoned"));
      const version = el("span", "version", p.version);
      if (p.latest) version.append(el("span", p.status === "semver-safe-update" ? "update safe" : "update major", ` → ${p.latest}`));
      li.append(name, version);
      li.onclick = () => packageActions(p);
      return li;
    }),
  );
}

function packageActions(p: Package) {
  pick(p.name, () => [
    ...(p.latest
      ? [
          p.status === "semver-safe-update"
            ? { label: `Update to ${p.latest}`, run: () => run(`composer update ${p.name}`, ["update", p.name, "--with-dependencies"]) }
            : { label: `Upgrade to ${p.latest} (changes the constraint in composer.json)`, run: () => run(`composer require ${p.name}`, ["require", ...(p.dev ? ["--dev"] : []), `${p.name}:^${p.latest!.replace(/^v/, "")}`, "--with-all-dependencies"]) },
        ]
      : []),
    { label: "Update within its constraint", run: () => run(`composer update ${p.name}`, ["update", p.name, "--with-dependencies"]) },
    {
      label: "Remove…",
      run: async () => {
        if (await ask(`Remove ${p.name} from the project?`, { title: "Remove package", kind: "warning" }))
          run(`composer remove ${p.name}`, ["remove", ...(p.dev ? ["--dev"] : []), p.name]);
      },
    },
    { label: "Open on Packagist", run: () => invoke("run_capture", { cwd: "/", program: "open", args: [`https://packagist.org/packages/${p.name}`], input: null }) },
  ]);
}

type SearchResult = { name: string; description: string; downloads: number };

/** Searches Packagist and requires the chosen package, as a dependency or a dev dependency. */
export function requirePackage() {
  if (!host.root()) return;
  pick(
    "Require a package: search Packagist",
    async (q) => {
      if (q.trim().length < 2) return [];
      const url = `https://packagist.org/search.json?per_page=20&q=${encodeURIComponent(q.trim())}`;
      const out = await invoke<string>("run_capture", { cwd: "/", program: "/usr/bin/curl", args: ["-fsSL", "--max-time", "10", url], input: null }).catch(() => "{}");
      const results: SearchResult[] = JSON.parse(out).results ?? [];
      return results.map((r) => ({
        label: r.name,
        detail: `${r.downloads.toLocaleString()} downloads · ${r.description}`,
        run: () =>
          pick(`Require ${r.name}`, () => [
            { label: "As a dependency", run: () => run(`composer require ${r.name}`, ["require", r.name]) },
            { label: "As a dev dependency (--dev)", run: () => run(`composer require --dev ${r.name}`, ["require", "--dev", r.name]) },
          ]),
      }));
    },
    300,
  );
}

export const updateAll = () => run("composer update", ["update"]);

export function initComposer(h: Host) {
  host = h;
  $("composer-refresh").onclick = loadPackages;
  $("composer-require").onclick = requirePackage;
  $("composer-update").onclick = updateAll;
}
