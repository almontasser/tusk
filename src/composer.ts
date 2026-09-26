// Composer tool window: the project's packages (direct ones, or everything installed) with available updates,
// security advisories, direct dependencies no PHP file names, why each is installed, and actions to require,
// update, and remove packages. Commands use the bundled
// composer.phar and run in terminal tabs.
import { invoke } from "@tauri-apps/api/core";
import { type Advisory, advisories, dependents, namespaceChecks, packages, type Package, requiredBy } from "./composerdata";
import { confirm, pick } from "./palette";
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

/** Each load's number, so a slow load that a newer one replaced doesn't draw over it. */
let loads = 0;

export async function loadPackages() {
  if (!host.root()) return;
  const load = ++loads;
  composer ||= await invoke<string>("tool_path", { name: "composer.phar" });
  const list = $("composer-list");
  const json = await invoke<string>("read_file", { path: `${host.root()}/composer.json` }).catch(() => null);
  if (json === null) return list.replaceChildren(el("li", "muted", "This project has no composer.json."));
  // Everything installed includes the packages your dependencies need.
  const scope = ($("composer-filter") as HTMLSelectElement).value === "all" ? [] : ["--direct"];
  // Switching back to the view keeps the last list while it refreshes; a new project or filter starts over.
  const key = `${host.root()}\0${scope}`;
  if (list.dataset.key !== key) (list.dataset.key = key), list.replaceChildren(el("li", "muted", "Loading…"));
  let show: string;
  try {
    show = await capture("show", ...scope, "--format=json");
  } catch (e) {
    return list.replaceChildren(el("li", "muted", `Can't list packages: ${String(e).trim()}. Run composer install first.`));
  }
  if (load !== loads) return;
  const lock = await invoke<string>("read_file", { path: `${host.root()}/composer.lock` }).catch(() => null);
  const info: Info = { via: lock ? requiredBy(lock) : new Map(), advisories: new Map(), unused: new Set() };
  render(packages(show, null, json), info);
  // Updates and advisories come from Packagist, and the unused check reads the project, so they come second.
  $("composer-summary").textContent = "Checking for updates and advisories…";
  const [outdated, audit, unused] = await Promise.all([
    capture("outdated", ...scope, "--format=json").catch(() => null),
    // Audit exits with an error status when it finds advisories.
    invoke<string>("run_capture", { cwd: host.root(), program: "php", args: [composer, "audit", "--format=json", "--abandoned=ignore", "--no-interaction"], input: null, anyStatus: true }).catch(() => null),
    lock ? unreferenced(lock, json) : new Set<string>(),
  ]);
  if (load !== loads) return;
  const all = packages(show, outdated, json);
  let audited = false;
  try {
    info.advisories = advisories(audit ?? "");
    audited = true;
  } catch {}
  info.unused = unused;
  render(all, info);
  const updates = all.filter((p) => p.latest).length;
  const vulnerable = info.advisories.size;
  $("composer-summary").textContent = [
    !audited ? "Couldn't check for advisories." : vulnerable ? `${vulnerable} ${vulnerable === 1 ? "package has" : "packages have"} security advisories.` : "No security advisories.",
    outdated === null ? "Couldn't check for updates." : updates ? `${updates} ${updates === 1 ? "update" : "updates"} available.` : "Everything is up to date.",
    unused.size ? `${unused.size} not named in any PHP file.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** What the list shows beside each package: who requires it, its advisories, and whether any PHP file names it. */
type Info = { via: Map<string, string[]>; advisories: Map<string, Advisory[]>; unused: Set<string> };

/** Direct dependencies whose namespaces no PHP file in the project (outside vendor) mentions. */
async function unreferenced(lock: string, json: string) {
  const unused = new Set<string>();
  let checks: ReturnType<typeof namespaceChecks> = [];
  try {
    checks = namespaceChecks(lock, json);
  } catch {}
  // One search at a time, so the search doesn't compete with the rest of the editor for every core.
  for (const c of checks) {
    const query = { text: c.pattern, regex: true, caseSensitive: false, wholeWord: false };
    const files = await invoke<string[]>("files_matching", { root: host.root(), query, include: "*.php" }).catch(() => null);
    if (files?.length === 0) unused.add(c.name);
  }
  return unused;
}

function render(list: Package[], info: Info) {
  $("composer-list").replaceChildren(
    ...list.map((p) => {
      const li = el("li", "composer-package");
      const found = info.advisories.get(p.name) ?? [];
      const via = info.via.get(p.name) ?? [];
      li.title = [
        p.description,
        ...found.map((a) => `⚠ ${a.title}${a.cve ? ` (${a.cve})` : ""}${a.severity ? `, ${a.severity}` : ""}`),
        info.unused.has(p.name) ? "No PHP file in the project names this package's namespace. It may still be used through Laravel's package discovery, the command line, or configuration." : "",
        p.abandoned ? "Abandoned" : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const name = el("span", "name", p.name);
      if (p.dev) name.append(el("span", "badge", "dev"));
      if (!p.direct) name.append(el("span", "badge", "indirect"));
      if (found.length) name.append(el("span", "badge danger", found.length === 1 ? "advisory" : `${found.length} advisories`));
      if (info.unused.has(p.name)) name.append(el("span", "badge warn", "unused?"));
      if (p.abandoned) name.append(el("span", "badge warn", "abandoned"));
      const version = el("span", "version", p.version);
      if (p.latest) version.append(el("span", p.status === "semver-safe-update" ? "update safe" : "update major", ` → ${p.latest}`));
      li.append(name, version);
      // Why an indirect package is installed: the packages that require it.
      if (!p.direct && via.length) li.append(el("span", "via", `via ${via.slice(0, 3).join(", ")}${via.length > 3 ? ` and ${via.length - 3} more` : ""}`));
      li.onclick = () => packageActions(p, found);
      li.oncontextmenu = (e) => (e.preventDefault(), packageActions(p, found));
      return li;
    }),
  );
}

/**
 * Lists the packages that require `name`, from `composer why`. Choosing one shows why that one is installed,
 * up to composer.json, so you can follow the chain from a package to the requirement that brought it in.
 */
async function why(name: string) {
  const out = await capture("why", name).catch((e) => (host.status(`Can't tell why ${name} is installed: ${String(e).trim()}`), null));
  if (out === null) return;
  const project = JSON.parse(await invoke<string>("read_file", { path: `${host.root()}/composer.json` }).catch(() => "{}")).name;
  const list = dependents(out);
  if (!list.length) return host.status(`Nothing requires ${name}.`);
  pick(`Why is ${name} installed? Choose a package to see why it is.`, () =>
    list.map((d) => {
      // The project itself shows as its composer.json name, without a version.
      const root = d.version === "-" || d.name === project;
      return {
        label: root ? "composer.json" : d.name,
        detail: `${root ? "" : `${d.version} `}${d.relation} ${d.constraint}`,
        icon: root ? "codicon-json" : "codicon-package",
        run: () => (root ? host.status(`${name} is required by composer.json.`) : why(d.name)),
      };
    }),
  );
}

const open = (url: string) => invoke("run_capture", { cwd: "/", program: "open", args: [url], input: null });

function packageActions(p: Package, found: Advisory[]) {
  pick(p.name, () => [
    ...found.map((a) => ({
      label: `Advisory: ${a.title}`,
      detail: [a.cve, a.severity, a.affectedVersions].filter(Boolean).join(" · "),
      icon: "codicon-warning icon-warning",
      run: () => a.link && open(a.link),
    })),
    ...(p.latest && (p.direct || p.status === "semver-safe-update")
      ? [
          p.status === "semver-safe-update"
            ? { label: `Update to ${p.latest}`, run: () => run(`composer update ${p.name}`, ["update", p.name, "--with-dependencies"]) }
            : { label: `Upgrade to ${p.latest} (changes the constraint in composer.json)`, run: () => run(`composer require ${p.name}`, ["require", ...(p.dev ? ["--dev"] : []), `${p.name}:^${p.latest!.replace(/^v/, "")}`, "--with-all-dependencies"]) },
        ]
      : []),
    { label: "Update within its constraint", run: () => run(`composer update ${p.name}`, ["update", p.name, "--with-dependencies"]) },
    { label: "Why Is It Installed?", run: () => why(p.name) },
    // A package another one needs can't be removed on its own.
    ...(p.direct
      ? [
          {
            label: "Remove…",
            run: async () => {
              if (await confirm(`Remove ${p.name} from the project?`, `Remove ${p.name}`))
                run(`composer remove ${p.name}`, ["remove", ...(p.dev ? ["--dev"] : []), p.name]);
            },
          },
        ]
      : []),
    { label: "Open on Packagist", run: () => open(`https://packagist.org/packages/${p.name}`) },
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
  $("composer-filter").onchange = loadPackages;
  $("composer-require").onclick = requirePackage;
  $("composer-update").onclick = updateAll;
}
