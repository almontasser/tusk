// PHP Analysis settings: Mago's configuration for the open project (its mago.toml), and the PHP server's index
// options. The page and the quick fixes on Mago's problems write mago.toml through the app's `toml_edit`, which keeps
// the file's comments and the keys the page doesn't show; the server reads the file again after each change. A
// project without a mago.toml uses the editor's defaults (lsp.ts, projectMagoConfig) until the first change, which
// creates mago.toml from them.
import { invoke } from "@tauri-apps/api/core";
import { monaco } from "./editor";
import { h, toast } from "./dom";
import { choose } from "./palette";
import { configureTusk, magoConfigPath, newMagoConfigText, reindex, spellingRoot, tuskOptions, useProjectMagoConfig } from "./lsp";
import { listEditor, openPath, registerProjectSettings, registerSettingsSection } from "./settings";
import { errorText, showError, status } from "./status";

// ---- The PHP server's index options ----

const analysis = registerProjectSettings(
  "PHP Analysis",
  "phpAnalysis",
  { loadAllLibraries: false, stubs: "" },
  [
    {
      key: "loadAllLibraries",
      label: "Index every library file in full",
      type: "checkbox",
      help: "Off, the index reads the vendor code your project reaches in full and the rest by name only, which keeps memory low. On, everything in vendor is read in full, for complete types everywhere, at several times the memory.",
    },
    {
      key: "stubs",
      label: "Extra stub folders",
      type: "text",
      placeholder: "stubs, ../shared/stubs",
      help: "Folders or PHP files, separated by commas and relative to the project, that the index reads as library code, such as stubs for a PHP extension.",
    },
  ],
  () => configureTusk(),
);
tuskOptions.loadAllLibraries = () => analysis().loadAllLibraries;
tuskOptions.stubs = () =>
  analysis()
    .stubs.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => normalize(p.startsWith("/") ? p : `${spellingRoot()}/${p}`));

/** A path without `.` and `..` parts, since the index compares paths by their text. */
export function normalize(path: string) {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") out.length > 1 && out.pop();
    else if (part !== ".") out.push(part);
  }
  return out.join("/").replace(/(.)\/+$/, "$1").replace(/\/{2,}/g, "/");
}

// ---- Editing mago.toml ----

type Edit = { path: string[]; value: unknown; inline?: boolean };
const projectConfig = () => `${spellingRoot()}/mago.toml`;

/** Applies edits to the project's mago.toml, creating it from the editor's defaults first, and reloads Mago's settings. */
async function editMago(edits: Edit[], done: string) {
  const root = spellingRoot();
  if (!root) throw new Error("Open a project first");
  const path = projectConfig();
  const created = !(await invoke<boolean>("path_exists", { path }));
  await invoke("toml_edit", { path, edits, create: created ? await newMagoConfigText(root) : null });
  if (created) {
    useProjectMagoConfig();
    toast("Created mago.toml from Tusk's defaults. Commit it to share Mago's settings with your team.", { kind: "info", timeout: 8000, action: { label: "Open", run: () => openPath(path) } });
  } else reindex();
  status(done, "mago", "info");
}

/** Sets a rule's `enabled` or `level`, leaving the key out when it's the rule's default. */
const ruleEdit = (code: string, key: "enabled" | "level", value: unknown, fallback: unknown): Edit => ({ path: ["linter", "rules", code, key], value: value === fallback ? null : value, inline: true });

type Rule = { code: string; name: string; description: string; category: string; enabled: boolean; level: string; defaultEnabled: boolean; defaultLevel: string };
type Described = {
  phpVersion: string | null;
  composerPhpVersion: string | null;
  analyzer: { key: string; value: boolean | null; default: boolean }[];
  analyzerExcludes: string[];
  ignore: (string | { code: string; in: string[] })[];
  linterExcludes: string[];
  rules: Rule[];
};

/** The settings in use: the project's mago.toml, or the editor's copy of its defaults. */
async function describe(): Promise<Described & { own: boolean }> {
  const root = spellingRoot();
  const own = await invoke<boolean>("path_exists", { path: projectConfig() });
  const path = own ? projectConfig() : magoConfigPath;
  if (!path) throw new Error("Mago's settings aren't ready yet; the PHP server is starting");
  return { ...(await invoke<Described>("mago_settings", { root, path })), own };
}

// ---- Quick fixes on Mago's problems ----

const LEVELS = ["error", "warning", "help", "note"];

async function changeLevel(code: string) {
  const rule = (await describe()).rules.find((r) => r.code === code);
  if (!rule) throw new Error(`Mago has no rule ${code} for this project`);
  const choice = await choose(`Level for ${code} (now ${rule.level})`, LEVELS.map((l) => (l === rule.defaultLevel ? `${l} (default)` : l)));
  if (!choice) return;
  const level = choice.split(" ")[0];
  await editMago([ruleEdit(code, "level", level, rule.defaultLevel)], `Mago reports ${code} as ${level} now`);
}

async function disableRule(code: string) {
  const rule = (await describe()).rules.find((r) => r.code === code);
  await editMago([ruleEdit(code, "enabled", false, rule?.defaultEnabled ?? true)], `Turned off ${code} in mago.toml`);
}

async function ignoreCode(code: string) {
  const { ignore } = await describe();
  if (ignore.includes(code)) return;
  await editMago([{ path: ["analyzer", "ignore"], value: [...ignore, code] }], `Mago's analyzer ignores ${code} now`);
}

monaco.editor.registerCommand("tusk.mago", (_, action: "disable" | "level" | "ignore", code: string) =>
  (action === "disable" ? disableRule(code) : action === "level" ? changeLevel(code) : ignoreCode(code)).catch((e) => showError(`Can't change ${code} in mago.toml`, e)),
);

monaco.languages.registerCodeActionProvider("php", {
  provideCodeActions(_model, _range, context) {
    const actions: monaco.languages.CodeAction[] = [];
    for (const m of context.markers) {
      const code = typeof m.code === "string" ? m.code : m.code?.value;
      if (!code || /^(parse|unfulfilled-expect)$/.test(code) || actions.some((a) => a.command?.arguments?.[1] === code)) continue;
      const action = (title: string, args: string[]): monaco.languages.CodeAction => ({ title, kind: "quickfix", diagnostics: [m], command: { id: "tusk.mago", title, arguments: args } });
      if (m.source === "mago-lint") actions.push(action(`Disable ${code} in mago.toml`, ["disable", code]), action(`Change ${code}'s level…`, ["level", code]));
      if (m.source === "mago") actions.push(action(`Ignore ${code} in mago.toml`, ["ignore", code]));
    }
    return { actions, dispose() {} };
  },
}, { providedCodeActionKinds: ["quickfix"] });

// ---- The PHP Analysis part of Settings ----

const SWITCHES: Record<string, string> = {
  "find-unused-expressions": "Report expressions whose result isn't used",
  "find-unused-parameters": "Report parameters a function never uses",
  "check-missing-override": "Report methods that override a parent's without #[Override]",
  "check-missing-type-hints": "Report parameters, properties, and returns without a type",
  "check-throws": "Report exceptions a function throws without @throws",
  "allow-possibly-undefined-array-keys": "Allow reading array keys that may not be set",
  "strict-list-index-checks": "Require list indexes to be non-negative integers",
  "check-property-initialization": "Report typed properties the constructor doesn't set",
};
const PHP_VERSIONS = ["7.4", "8.0", "8.1", "8.2", "8.3", "8.4", "8.5"];

type Change = (edits: Edit[], done: string) => Promise<void>;

/**
 * Runs a change from the page. The controls already show it, so the page stays as it is, keeping its scroll and
 * filter; a failure draws the page again from the file, so it shows what's saved, and rejects.
 */
const pageAction = (redraw: () => void): Change => (edits, done) => editMago(edits, done).catch((e) => (redraw(), Promise.reject(e)));
/** For a control's change: a failure shows as an error. */
const report = (p: Promise<void>) => p.catch((e) => showError("Can't change mago.toml", e));

function rulesList(rules: Rule[], change: Change) {
  const search = h("input", { type: "search", placeholder: "Filter rules", ariaLabel: "Filter Mago's rules", spellcheck: false });
  const count = h("span", { class: "muted" });
  const list = h("ul", { class: "mago-rules", role: "list", ariaLabel: "Mago's linter rules" });
  const counts = (shown: Rule[]) => `${shown.length} of ${rules.length} rules · ${rules.filter((r) => r.enabled).length} on`;
  const draw = () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = rules.filter((r) => words.every((w) => `${r.code} ${r.name} ${r.category} ${r.description}`.toLowerCase().includes(w)));
    count.textContent = counts(shown);
    list.replaceChildren(
      ...shown.map((r) => {
        const id = `mago-rule-${r.code}`;
        const on = h("input", { type: "checkbox", id, checked: r.enabled });
        const level = h("select", { ariaLabel: `Level of ${r.code}`, disabled: !r.enabled }, ...LEVELS.map((l) => new Option(l === r.defaultLevel ? `${l} (default)` : l, l)));
        level.value = r.level;
        const row = h("li", {});
        const mark = () => {
          row.className = r.enabled !== r.defaultEnabled || r.level !== r.defaultLevel ? "changed" : "";
          level.disabled = !r.enabled;
          count.textContent = counts(shown);
        };
        on.onchange = () => report(change([ruleEdit(r.code, "enabled", on.checked, r.defaultEnabled)], `Turned ${on.checked ? "on" : "off"} ${r.code}`).then(() => ((r.enabled = on.checked), mark())));
        level.onchange = () => report(change([ruleEdit(r.code, "level", level.value, r.defaultLevel)], `Mago reports ${r.code} as ${level.value} now`).then(() => ((r.level = level.value), mark())));
        const first = r.description.split(/\n\s*\n/)[0].replace(/\s+/g, " ");
        mark();
        row.append(
          on,
          h("label", { htmlFor: id }, h("span", { class: "mago-rule-name" }, r.name), h("code", {}, r.code), h("small", { title: r.description }, `${r.category} · ${first}`)),
          level,
        );
        return row;
      }),
    );
  };
  search.oninput = draw;
  draw();
  return h("div", { class: "mago-rules-editor" }, h("div", { class: "setting-control" }, search, count), list);
}

registerSettingsSection({
  group: "PHP Analysis",
  keywords: "mago mago.toml php version analyzer linter rules lint excludes ignore",
  shown: () => !!spellingRoot(),
  async render() {
    const box = h("div", { class: "mago-page" });
    const redraw = () =>
      describe().then(
        (d) => box.replaceChildren(...page(d, pageAction(redraw))),
        (e) => box.replaceChildren(h("p", { class: "setting-error", role: "alert" }, `Can't read Mago's settings: ${errorText(e)}`), h("button", { type: "button", class: "setting-open", onclick: () => openPath(projectConfig()) }, "Open mago.toml")),
      );
    await redraw();
    return box;
  },
});

function page(d: Described & { own: boolean }, change: Change): HTMLElement[] {
  const open = h("button", { type: "button", class: "setting-open", onclick: () => (document.querySelector<HTMLDialogElement>("#settings")?.close(), openPath(projectConfig())) }, "Open mago.toml");
  const source = d.own
    ? h("p", { class: "muted" }, "Mago reads mago.toml in the project. Changes here edit it and keep its comments.")
    : h("p", { class: "muted" }, "The project has no mago.toml, so Mago uses Tusk's defaults for Laravel. Your first change here creates mago.toml from them.");

  const version = h("select", { id: "mago-php-version" }, new Option(`From composer.json${d.composerPhpVersion ? ` (${d.composerPhpVersion})` : ""}`, ""), ...PHP_VERSIONS.map((v) => new Option(`PHP ${v}`, v)));
  version.value = d.phpVersion?.split(".").slice(0, 2).join(".") ?? "";
  version.onchange = () => report(change([{ path: ["php-version"], value: version.value ? `${version.value}.0` : null }], `Mago checks for ${version.value ? `PHP ${version.value}` : "composer.json's PHP version"} now`));

  const switches = d.analyzer.map((a) => {
    const id = `mago-${a.key}`;
    const box = h("input", { type: "checkbox", id, checked: a.value ?? a.default });
    box.onchange = () => report(change([{ path: ["analyzer", a.key], value: box.checked === a.default ? null : box.checked }], `Changed ${a.key}`));
    return h("div", { class: "setting setting-checkbox" }, box, h("label", { htmlFor: id }, SWITCHES[a.key] ?? a.key), h("span", {}), h("small", {}, a.key));
  });

  const list = (label: string, start: string[], key: string[], placeholder: string) => {
    let items = start;
    const set = async (next: string[], done: string) => (await change([{ path: key, value: next }], done), (items = next));
    return listEditor({ label, items, placeholder, empty: "None.", add: (v) => set([...items, v], `Added ${v} to ${label}`), remove: (v) => set(items.filter((i) => i !== v), `Removed ${v} from ${label}`) });
  };
  let ignore = d.ignore;
  const setIgnore = async (next: typeof ignore, done: string) => (await change([{ path: ["analyzer", "ignore"], value: next }], done), (ignore = next)).filter((i): i is string => typeof i === "string");
  const codes = d.ignore.filter((i): i is string => typeof i === "string");
  const scoped = d.ignore.filter((i): i is { code: string; in: string[] } => typeof i !== "string");

  return [
    source,
    h("div", { class: "setting" }, h("label", { htmlFor: "mago-php-version" }, "PHP version"), h("span", { class: "setting-control" }, version), h("small", {}, "The version Mago checks your code against: deprecations, new syntax, and the linter's rules.")),
    h("p", { class: "setting-subhead" }, "Analyzer"),
    ...switches,
    h("p", { class: "setting-subhead" }, "Problem codes the analyzer ignores"),
    listEditor({
      label: "the ignored codes",
      items: codes,
      placeholder: "A problem code, such as mixed-assignment",
      empty: "None.",
      add: (v) => setIgnore([...ignore, v], `Mago's analyzer ignores ${v} now`),
      remove: (v) => setIgnore(ignore.filter((i) => i !== v), `Mago's analyzer reports ${v} again`),
    }),
    scoped.length ? h("small", { class: "muted" }, `Ignored in some paths only (edit them in mago.toml): ${scoped.map((s) => `${s.code} in ${s.in.join(", ")}`).join("; ")}`) : null,
    h("p", { class: "setting-subhead" }, "Paths the analyzer skips"),
    list("the analyzer's excludes", d.analyzerExcludes, ["analyzer", "excludes"], "A folder or glob, such as legacy/"),
    h("p", { class: "setting-subhead" }, "Paths the linter skips"),
    list("the linter's excludes", d.linterExcludes, ["linter", "excludes"], "A folder or glob, such as database/migrations"),
    h("p", { class: "setting-subhead" }, "Linter rules"),
    rulesList(d.rules, change),
    d.own && open,
  ].filter((e): e is HTMLElement => !!e);
}
