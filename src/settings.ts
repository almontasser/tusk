// User settings: stored in settings.json in the app's config folder and applied live.
import { invoke } from "@tauri-apps/api/core";
import { appConfigDir } from "@tauri-apps/api/path";
import { isMac, keyText, open } from "./platform.ts";
import { monaco } from "./editor";
import { h, icon, toast } from "./dom";
import { choose, confirm, pick, rank } from "./palette";
import { parseSettingsFile, type Ranges, readSaved, settingsToWrite, type Value } from "./settingsdata";
import { onProjectValue, projectOpen, projectScope, projectValue, setProjectScope, setProjectValue } from "./projectstate";
import { errorText, showError } from "./status";
import { applyTheme, importThemeFile, loadImportedThemes, removeImportedTheme, themeList } from "./themes";
import { setVim } from "./vim";

export type Settings = {
  /** A theme id from themes.ts, or "system" for darkTheme or lightTheme to match macOS. */
  theme: string;
  darkTheme: string;
  lightTheme: string;
  fontFamily: string;
  fontSize: number;
  wordWrap: boolean;
  minimap: boolean;
  inlayHints: boolean;
  /** The worst problem on the cursor line, after the line's end. */
  inlineProblems: boolean;
  autoSave: boolean;
  formatOnSave: boolean;
  spellCheck: boolean;
  /** Run buttons for tests in the gutter; off shows Run, Debug, and Profile links above each test instead. */
  testGutterIcons: boolean;
  vim: boolean;
  aiCompletion: boolean;
  /** A key of MODELS in ai.ts. */
  aiModel: string;
  /** Shortcut overrides by action name, such as { "Go to File": "Meta+P" }. "" removes the shortcut. */
  keymap: Record<string, string>;
};

const defaults: Settings = {
  theme: "dark",
  darkTheme: "dark",
  lightTheme: "light",
  // JetBrains Mono, as its own release or the Nerd Font build names it.
  fontFamily: "JetBrains Mono, JetBrainsMono Nerd Font Mono, JetBrainsMono Nerd Font, SF Mono, Menlo, Cascadia Mono, Consolas, DejaVu Sans Mono, monospace",
  fontSize: 13,
  wordWrap: false,
  minimap: false,
  inlayHints: true,
  inlineProblems: false,
  autoSave: true,
  formatOnSave: false,
  spellCheck: true,
  testGutterIcons: true,
  vim: false,
  aiCompletion: false,
  aiModel: "qwen2.5-coder-3b",
  keymap: {},
};

/**
 * A setting in the dialog, under the heading `group`. `shown` hides a setting that doesn't apply, such as the dark
 * mode theme while the theme doesn't follow the system. `key` is a key of Settings, or of a group another module
 * adds with registerSettings.
 */
export type Field = { key: string; label: string; help?: string; group: string; shown?: () => boolean; /** The project state key that holds it; see registerProjectSettings. */ project?: string } & (
  | { type: "checkbox" }
  | { type: "number"; min: number; max: number }
  | { type: "text"; placeholder?: string }
  /**
   * A program or file: a text box with Browse and Test. `describe` says what the value finds, such as "Detected:
   * /opt/homebrew/bin/php (PHP 8.4.2)", or throws why it doesn't work; it runs when the dialog opens, on Test, and
   * after a change. `suggest` lists values to offer under the box, with a note for each.
   */
  | { type: "path"; placeholder?: string; describe?: (value: string) => Promise<string>; suggest?: () => Promise<[value: string, note: string][]> }
  | { type: "select"; options: [string, string][] | (() => [value: string, text: string, group: string][]) }
);

/** The order of the settings dialog's groups: editing first, then tools, then per-project analysis, then housekeeping. */
const GROUP_ORDER = ["Appearance", "Editor", "Terminal", "Tools", "Git", "Debugger", "Database", "HTTP Client", "Spelling", "PHPStan", "PHP Analysis", "AI", "Project Tree", "Local History", "Limits"];

/** The settings dialog's fields, in order; groups show in GROUP_ORDER, then in the order their first field appears. */
const fields: Field[] = [
  { group: "Appearance", key: "theme", label: "Theme", type: "select", options: () => [["system", "Match the system", ""], ...themeOptions()] },
  { group: "Appearance", key: "darkTheme", label: "Theme in dark mode", type: "select", options: () => themeOptions(true), shown: () => settings.theme === "system" },
  { group: "Appearance", key: "lightTheme", label: "Theme in light mode", type: "select", options: () => themeOptions(false), shown: () => settings.theme === "system" },
  { group: "Appearance", key: "fontFamily", label: "Editor font", type: "text", help: "A CSS font list; the first installed font is used." },
  { group: "Appearance", key: "fontSize", label: "Font size", type: "number", min: 8, max: 32 },
  { group: "Editor", key: "wordWrap", label: "Wrap long lines", type: "checkbox" },
  { group: "Editor", key: "minimap", label: "Show the minimap", type: "checkbox" },
  { group: "Editor", key: "inlayHints", label: "Show inlay hints (parameter names and types)", type: "checkbox" },
  { group: "Editor", key: "inlineProblems", label: "Show the cursor line's problem at the end of the line", type: "checkbox" },
  { group: "Editor", key: "autoSave", label: "Save files automatically", type: "checkbox", help: "When you switch tabs, close a tab, or switch to another app." },
  { group: "Editor", key: "formatOnSave", label: "Format files when saving", type: "checkbox", help: "Code > Formatters… chooses the formatter for each language in the project, and can turn this on or off per language." },
  { group: "Editor", key: "testGutterIcons", label: "Show run buttons for tests in the gutter", type: "checkbox", help: "Otherwise, Run, Debug, and Profile links show above each test." },
  { group: "Editor", key: "vim", label: "Vim emulation", type: "checkbox", help: `The status bar shows the mode. ${isMac ? "⌃ keys go" : "Ctrl keys that aren't Tusk shortcuts go"} to Vim while you type in the editor.` },
  { group: "AI", key: "aiCompletion", label: "AI code completion", type: "checkbox", help: "Suggests code as you type with a model that runs on this Mac. Tab accepts a suggestion. The first time, the model is downloaded." },
  {
    group: "AI",
    key: "aiModel",
    label: "AI completion model",
    type: "select",
    shown: () => settings.aiCompletion,
    options: [
      ["qwen2.5-coder-1.5b", "Qwen2.5-Coder 1.5B: fastest (1.6 GB)"],
      ["qwen2.5-coder-3b", "Qwen2.5-Coder 3B: best balance (3.3 GB)"],
      ["qwen2.5-coder-7b", "Qwen2.5-Coder 7B: best (8.1 GB, needs 16 GB of memory)"],
    ],
  },
  { group: "Spelling", key: "spellCheck", label: "Check spelling", type: "checkbox", help: "In comments, strings, and names. ⌥⏎ on a misspelling saves it to a dictionary." },
];

/** Defaults of the settings other modules add with registerSettings. */
const registered: Record<string, Value> = {};
const allDefaults = (): Record<string, Value> => ({ ...defaults, ...registered });
const ranges = (): Ranges => Object.fromEntries(fields.flatMap((f) => (f.type === "number" ? [[f.key, { min: f.min, max: f.max }]] : [])));

export const settings: Settings = { ...defaults };
const listeners: ((s: Settings) => void)[] = [];
let editors: monaco.editor.ICodeEditor[] = [];

/** Calls `fn` now and after every settings change. */
export function onSettings(fn: (s: Settings) => void) {
  listeners.push(fn);
  fn(settings);
}

const file = async () => `${await appConfigDir()}/settings.json`;
const systemDark = matchMedia("(prefers-color-scheme: dark)");

/** Themes for a select, grouped by dark and light, optionally only dark or only light ones. */
const themeOptions = (dark?: boolean): [string, string, string][] =>
  themeList()
    .filter((t) => dark === undefined || t.dark === dark)
    .map((t) => [t.id, t.source === "Built-in" ? `${t.name} (built-in)` : t.name, t.source === "Imported" ? "Imported" : t.dark ? "Dark" : "Light"]);

/** The theme in use, resolving "system". */
const themeId = () => (settings.theme === "system" ? (systemDark.matches ? settings.darkTheme : settings.lightTheme) : settings.theme);

/** The first font of a CSS font list that's installed: text in it measures differently from both fallbacks. */
function installedFont(list: string): string | undefined {
  const span = document.createElement("span");
  span.style.cssText = "position: absolute; visibility: hidden; white-space: pre; font-size: 40px";
  span.textContent = "iiiWWW->::";
  document.body.append(span);
  const width = (family: string) => ((span.style.fontFamily = family), span.getBoundingClientRect().width);
  const [serif, sans] = [width("serif"), width("sans-serif")];
  const found = list
    .split(",")
    .map((f) => f.trim().replace(/^["']|["']$/g, ""))
    .find((f) => /^(monospace|ui-monospace|serif|sans-serif)$/.test(f) || (width(`"${f}", serif`) !== serif && width(`"${f}", sans-serif`) !== sans));
  span.remove();
  return found;
}

/**
 * Ligatures only with a font that has them. The fallbacks, such as Menlo, don't, and WebKit then draws `::`
 * narrower than Monaco's grid, which leaves a gap after it (`$model::findToken ($token)`).
 */
const ligatures = (list: string) => !/^(menlo|monaco|courier|courier new|monospace|ui-monospace|sf mono)$/i.test(installedFont(list) ?? "monospace");

function apply() {
  applyTheme(themeId());
  const fontLigatures = ligatures(settings.fontFamily);
  for (const ed of editors) {
    ed.updateOptions({
      fontFamily: settings.fontFamily,
      fontLigatures,
      fontSize: settings.fontSize,
      wordWrap: settings.wordWrap ? "on" : "off",
      minimap: { enabled: settings.minimap },
      inlayHints: { enabled: settings.inlayHints ? "on" : "off" },
    });
    setVim(ed, settings.vim);
  }
  listeners.forEach((fn) => fn(settings));
}
systemDark.addEventListener("change", () => settings.theme === "system" && apply());

/** The file as last read or written, so keys this version doesn't know survive a save. */
let raw: Record<string, unknown> = {};
/** Saved values that can't be used, and why. The file keeps them until you change the setting. */
let invalid = new Map<string, string>();
/** Why settings.json can't be saved, such as a JSON error in it. Changes still apply; the file stays as it is until you fix it. */
let blocked = "";

const openFileAction = { label: "Open settings.json", run: () => openSettingsFile() };

async function persist() {
  if (blocked) return toast(`${blocked}. Your changes apply, but aren't saved until you fix the file.`, { action: openFileAction });
  const out = settingsToWrite(raw, settings, invalid);
  try {
    const path = await file();
    await invoke("create_dir", { path: path.slice(0, path.lastIndexOf("/")) });
    await invoke("write_file", { path, contents: JSON.stringify(out, null, 2) + "\n" });
    raw = out;
  } catch (e) {
    showError("Couldn't save your settings", e, { label: "Retry", run: persist });
  }
}

/** Changes one setting, applies it, and saves. A key another module added with registerSettings takes its own value's type. */
export function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]): void;
export function updateSetting(key: string, value: Value): void;
export function updateSetting(key: string, value: unknown) {
  set(key, value);
}

function set(key: string, value: unknown) {
  (settings as Record<string, unknown>)[key] = value;
  invalid.delete(key);
  apply();
  persist();
}

/** A field for registerSettings: a Field without its group, which registerSettings sets. */
export type FieldInput = Field extends infer F ? (F extends Field ? Omit<F, "group"> : never) : never;

/**
 * Adds a group of settings from another module, such as the terminal's: their defaults and their fields in the
 * dialog, under `group`. Call it when the module loads. Returns the settings object, typed with the group's keys,
 * which always holds the current values; onSettings tells you when they change.
 *
 *   const terminal = registerSettings("Terminal", { terminalFontSize: 0 }, [
 *     { key: "terminalFontSize", label: "Font size", type: "number", min: 0, max: 32, help: "0 uses the editor's." },
 *   ]);
 */
export function registerSettings<T extends Record<string, Value>>(group: string, values: T, list: (FieldInput & { key: keyof T & string })[]): T {
  Object.assign(registered, values);
  fields.push(...list.map((f) => ({ ...f, group }) as Field));
  // Settings may have loaded already; take the saved values for the new keys.
  const read = readSaved(raw, values, ranges());
  Object.assign(settings, read.values);
  for (const [k, why] of read.invalid) invalid.set(k, why);
  return settings as unknown as T;
}

/** The groups of project settings, by their project state key. */
const projectGroups = new Map<string, { defaults: Record<string, Value>; onChange?: () => void }>();

/** A project group's values: the saved ones that have their default's type, else the defaults. */
function projectSettingsOf(key: string): Record<string, Value> {
  const { defaults } = projectGroups.get(key)!;
  const saved = projectValue<Record<string, unknown>>(key);
  const values = { ...defaults };
  if (saved && typeof saved === "object") for (const k of Object.keys(defaults)) if (typeof saved[k] === typeof defaults[k]) values[k] = saved[k] as Value;
  return values;
}

/**
 * Adds a group of settings for the open project, kept as one object under `key` in the project's state
 * (projectstate.ts): on this Mac, or in tusk.json when the group's **Share in tusk.json** box is on. Values equal to
 * their defaults aren't saved. The group shows only while a project is open. `onChange` runs after each change in
 * the dialog and when tusk.json changes the value on disk. Returns a function that reads the current values.
 */
export function registerProjectSettings<T extends Record<string, Value>>(group: string, key: string, values: T, list: (FieldInput & { key: keyof T & string })[], onChange?: () => void): () => T {
  projectGroups.set(key, { defaults: values, onChange });
  fields.push(...list.map((f) => ({ ...f, group, project: key }) as Field));
  if (onChange) onProjectValue(key, onChange);
  return () => projectSettingsOf(key) as T;
}

async function setProjectSetting(project: string, key: string, value: unknown) {
  const { defaults, onChange } = projectGroups.get(project)!;
  const next: Record<string, unknown> = { ...projectSettingsOf(project), [key]: value };
  for (const k of Object.keys(next)) if (next[k] === defaults[k]) delete next[k];
  try {
    await setProjectValue(project, Object.keys(next).length ? next : undefined);
    onChange?.();
  } catch (e) {
    showError("Can't save the project setting", e);
  }
}

/**
 * A part of the settings dialog that a module draws itself, under the heading `group`, for what fields can't hold,
 * such as a list of words or rules. `render` runs each time the dialog opens; while it loads, the dialog says so, and
 * if it fails, it shows the error in place. The search box matches `keywords`.
 */
export type SettingsSection = { group: string; keywords: string; shown?: () => boolean; render(): HTMLElement | Promise<HTMLElement> };
const customSections: SettingsSection[] = [];
export const registerSettingsSection = (s: SettingsSection) => void customSections.push(s);

/**
 * An editable list of strings, such as dictionary words or folders to skip, for a settings section: a box to add
 * an entry (Enter or Add), and the entries, each with a remove button. `add` and `remove` save the change and
 * return the new list; a failure shows as an error and keeps the list as it was.
 */
export function listEditor(o: { label: string; items: string[]; placeholder: string; empty: string; add(v: string): Promise<string[]>; remove(v: string): Promise<string[]> }) {
  let items = o.items;
  const input = h("input", { type: "text", placeholder: o.placeholder, ariaLabel: `Add to ${o.label}`, spellcheck: false });
  const list = h("ul", { class: "setting-list", role: "list", ariaLabel: o.label });
  const run = async (change: () => Promise<string[]>, what: string) => {
    try {
      items = await change();
      draw();
    } catch (e) {
      showError(`Can't ${what}`, e);
    }
  };
  const draw = () =>
    list.replaceChildren(
      ...(items.length
        ? items.map((v) => h("li", {}, h("span", {}, v), h("button", { type: "button", class: "icon-button", title: `Remove ${v}`, ariaLabel: `Remove ${v}`, onclick: () => run(() => o.remove(v), `remove ${v}`) }, icon("close"))))
        : [h("li", { class: "muted" }, o.empty)]),
    );
  const add = () => {
    const v = input.value.trim();
    if (!v) return input.focus();
    if (items.includes(v)) return (input.value = ""), void toast(`${o.label} already has ${v}.`, { kind: "info", timeout: 3000 });
    run(() => o.add(v), `add ${v}`).then(() => ((input.value = ""), input.focus()));
  };
  input.onkeydown = (e) => e.key === "Enter" && (e.preventDefault(), add());
  draw();
  return h("div", { class: "setting-list-editor" }, h("div", { class: "setting-control" }, input, h("button", { type: "button", onclick: add }, "Add")), list);
}

let keymapEditor = () => {};
/** Sets what the Keymap button in the dialog opens. */
export const setKeymapEditor = (open: () => void) => (keymapEditor = open);
let openFile: (path: string) => unknown = () => {};
/** Sets how the dialog opens settings.json in the editor. */
export const setFileOpener = (open: (path: string) => unknown) => (openFile = open);
/** Opens a file in the editor, such as a tool's configuration from its settings section. */
export const openPath = (path: string) => openFile(path);

/** Opens settings.json in the editor, writing it first when there's none yet. */
export async function openSettingsFile() {
  const path = await file();
  if (!(await invoke<boolean>("path_exists", { path }).catch(() => false))) await persist();
  openFile(path);
}

/** Applies the settings to an editor now and after every change. */
export function addEditor(ed: monaco.editor.ICodeEditor) {
  editors.push(ed);
  apply();
}

/** Stops applying settings to a disposed editor. */
export function removeEditor(ed: monaco.editor.ICodeEditor) {
  editors = editors.filter((e) => e !== ed);
  setVim(ed, false);
}

/**
 * Reads settings.json. A file that isn't valid JSON is left as it is: the defaults apply, nothing is written until
 * you fix it, and a toast offers to open it. A value of the wrong type, or a number out of range, uses its default
 * and stays in the file until you change that setting.
 */
async function load() {
  const path = await file();
  let text: string;
  try {
    text = await invoke<string>("read_file", { path });
  } catch (e) {
    // No settings file yet: use the defaults.
    if (!(await invoke<boolean>("path_exists", { path }).catch(() => true))) return;
    blocked = `Can't read settings.json: ${errorText(e)}`;
    return toast(`${blocked}. Tusk uses the default settings and won't change the file.`, { action: openFileAction });
  }
  const parsed = parseSettingsFile(text);
  if ("error" in parsed) {
    blocked = parsed.error;
    return toast(`${blocked}. Tusk uses the default settings and won't change the file until you fix it.`, { action: openFileAction });
  }
  blocked = "";
  raw = parsed.raw;
  const read = readSaved(raw, allDefaults(), ranges());
  Object.assign(settings, read.values);
  invalid = read.invalid;
  // The file keeps every value, so the default font list from before the Nerd Font names came along stays in it.
  if (settings.fontFamily === "JetBrains Mono, SF Mono, Menlo, monospace") settings.fontFamily = defaults.fontFamily;
  if (invalid.size)
    toast(`Some values in settings.json can't be used, so their defaults apply: ${[...invalid].map(([k, why]) => `${k} ${why}`).join("; ")}.`, { action: openFileAction });
}

/** Loads settings from disk and applies them. */
export async function initSettings() {
  await loadImportedThemes();
  await load();
  apply();
}

/** Reads settings.json again after you save it in the editor, and applies it. */
export async function settingsFileSaved(path: string) {
  if (path !== (await file())) return;
  const wasBlocked = blocked;
  await load();
  apply();
  // The toasts about the old file's problems no longer apply.
  if (!blocked) document.querySelectorAll("#toasts .toast").forEach((t) => t.textContent?.includes("settings.json") && t.remove());
  if (!blocked) toast(wasBlocked ? "Fixed settings.json. Changes save again." : "Applied settings.json.", { kind: "info", timeout: 4000 });
}

const valueText = (v: unknown) => (typeof v === "boolean" ? (v ? "on" : "off") : String(v));

/**
 * Opens the settings dialog. Changes apply and save immediately. The search box filters settings in every group by
 * label, description, group, and key; each changed setting has a reset button.
 */
export function openSettings(query = "") {
  document.getElementById("settings")?.remove();
  const dialog = h("dialog", { id: "settings", ariaLabel: "Settings" });
  const search = h("input", { type: "search", className: "settings-search", placeholder: "Search settings", ariaLabel: "Search settings", spellcheck: false, value: query });
  const body = h("div", { class: "settings-body" });
  const empty = h("p", { class: "muted settings-empty", hidden: true }, "No settings match.");
  const banner = blocked
    ? h("div", { class: "settings-banner", role: "alert" }, icon("warning"), h("span", {}, `${blocked}. Changes here apply, but aren't saved until you fix the file.`), h("button", { type: "button", onclick: () => (dialog.close(), openSettingsFile()) }, "Open settings.json"))
    : null;

  type Row = { shown: () => boolean; row: HTMLElement; section: HTMLElement; text: string; sync(): void };
  const rows: Row[] = [];
  const sections = new Map<string, HTMLElement>();
  /** The group's section, made the first time; a project group's heading says so and has its share box. */
  const sectionOf = (group: string, project?: string) => {
    if (sections.has(group)) return sections.get(group)!;
    const heading = h("h3", {}, group);
    const section = body.appendChild(h("section", { class: "settings-group" }, heading));
    if (project) {
      const share = h("input", { type: "checkbox", id: `share-${project}`, checked: projectScope(project) === "shared" });
      share.onchange = () => setProjectScope(project, share.checked ? "shared" : "local").catch((e) => ((share.checked = !share.checked), showError("Can't move the setting", e)));
      heading.append(
        h("span", { class: "settings-project-tag", title: "These settings apply to the open project" }, "This project"),
        h("label", { class: "settings-share", title: "Keep these settings in tusk.json, so your team gets them when you commit it" }, share, " Share in tusk.json"),
      );
    }
    sections.set(group, section);
    return section;
  };
  const current = (f: Field) => (f.project ? projectSettingsOf(f.project)[f.key] : (settings as Record<string, unknown>)[f.key]);
  const change = (f: Field, value: unknown) => (f.project ? setProjectSetting(f.project, f.key, value).then(refresh) : (set(f.key, value), refresh()));
  fields.forEach((f, n) => {
    const section = sectionOf(f.group, f.project);
    const id = `setting-${n}`;
    const error = h("small", { class: "setting-error", role: "alert" });
    let input: HTMLInputElement | HTMLSelectElement;
    if (f.type === "select") {
      input = h("select", { id });
      const groups = new Map<string, HTMLElement>();
      for (const [value, text, group] of typeof f.options === "function" ? f.options() : f.options) {
        let parent: HTMLElement = input;
        if (group) parent = groups.get(group) ?? groups.set(group, input.appendChild(h("optgroup", { label: group }))).get(group)!;
        parent.append(new Option(text, value));
      }
    } else input = h("input", { id, type: f.type === "path" ? "text" : f.type, ...(f.type === "number" ? { min: String(f.min), max: String(f.max) } : {}), ...(f.type === "text" || f.type === "path" ? { placeholder: f.placeholder ?? "", spellcheck: false } : {}) });
    const fallback = f.project ? projectGroups.get(f.project)!.defaults[f.key] : allDefaults()[f.key];
    const reset = h("button", { type: "button", class: "icon-button setting-reset", title: `Reset to the default (${valueText(fallback) || "empty"})`, ariaLabel: `Reset ${f.label} to the default` }, icon("discard"));
    reset.onclick = () => (change(f, fallback), input.focus(), void check());
    const label = h("label", { htmlFor: id }, f.label);
    const row = h("div", { class: `setting setting-${f.type}` });
    const note = h("small", { class: "setting-note", ariaLive: "polite" });
    /** Runs a path field's check and shows what it found or why it fails. */
    const check = async () => {
      if (f.type !== "path" || !f.describe) return;
      const value = input.value.trim();
      note.textContent = "Checking…";
      note.classList.remove("setting-error");
      try {
        const text = await f.describe(value);
        if (input.value.trim() === value) note.textContent = text;
      } catch (e) {
        if (input.value.trim() !== value) return;
        note.textContent = errorText(e);
        note.classList.add("setting-error");
      }
    };
    const extra: HTMLElement[] = [];
    if (f.type === "path") {
      const browse = h("button", { type: "button", ariaLabel: `Browse for ${f.label}` }, "Browse…");
      browse.onclick = async () => {
        const path = await open({ title: f.label, defaultPath: input.value.trim() || undefined }).catch((e) => (showError("Can't open the file chooser", e), null));
        if (typeof path === "string") (input.value = path), input.onchange?.(new Event("change"));
      };
      extra.push(browse, h("button", { type: "button", ariaLabel: `Test ${f.label}`, onclick: check }, "Test"));
      if (f.suggest) {
        const list = h("datalist", { id: `${id}-list` });
        input.setAttribute("list", list.id);
        extra.push(list);
        f.suggest().then((found) => list.replaceChildren(...found.map(([value, text]) => new Option(text, value))), (e) => console.warn("No suggestions for", f.key, e));
      }
      void check();
    }
    if (f.type === "checkbox") row.append(input, label, reset);
    else row.append(label, h("span", { class: "setting-control" }, input, ...extra, reset));
    if (f.help) row.append(h("small", {}, keyText(f.help)));
    row.append(note, error);
    const invalidNote = () => (!f.project && invalid.has(f.key) ? `The value in settings.json ${invalid.get(f.key)}, so the default is used.` : "");
    const sync = () => {
      const v = current(f);
      if (input instanceof HTMLInputElement && f.type === "checkbox") input.checked = v as boolean;
      else if (document.activeElement !== input || f.type === "select") input.value = String(v);
      reset.style.visibility = v === fallback ? "hidden" : "";
      if (!input.ariaInvalid) error.textContent = invalidNote();
    };
    input.onchange = () => {
      const el = input as HTMLInputElement;
      if (f.type === "number") {
        const n = Number(el.value);
        if (!el.value.trim() || !Number.isFinite(n) || n < f.min || n > f.max) {
          el.ariaInvalid = "true";
          error.textContent = `Enter a number from ${f.min} to ${f.max}.`;
          return;
        }
        el.ariaInvalid = null;
        return change(f, n);
      }
      change(f, f.type === "checkbox" ? el.checked : f.type === "path" ? el.value.trim() : el.value);
      void check();
    };
    section.append(row);
    const shown = () => (!f.project || projectOpen()) && (f.shown?.() ?? true);
    rows.push({ shown, row, section, text: [f.group, f.label, f.help, f.key].join(" ").toLowerCase(), sync });
  });
  for (const s of customSections) {
    const section = sectionOf(s.group);
    const row = h("div", { class: "setting setting-custom", ariaBusy: "true" }, h("p", { class: "muted" }, "Loading…"));
    Promise.resolve()
      .then(() => s.render())
      .then(
        (el) => row.replaceChildren(el),
        (e) => row.replaceChildren(h("p", { class: "setting-error", role: "alert" }, `Can't show these settings: ${errorText(e)}`)),
      )
      .finally(() => (row.ariaBusy = "false"));
    section.append(row);
    rows.push({ shown: () => s.shown?.() ?? true, row, section, text: [s.group, s.keywords].join(" ").toLowerCase(), sync() {} });
  }
  // Groups register as their modules load; show them in GROUP_ORDER, and any other group after those.
  const rank = (group: string) => (GROUP_ORDER.indexOf(group) + GROUP_ORDER.length + 1) % (GROUP_ORDER.length + 1);
  body.append(...[...sections].sort(([a], [b]) => rank(a) - rank(b)).map(([, section]) => section));

  /** Shows the settings that apply and match the search, and each one's value and reset button. */
  const refresh = () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    for (const r of rows) {
      r.row.hidden = !r.shown() || !words.every((w) => r.text.includes(w));
      r.sync();
    }
    for (const section of sections.values()) section.hidden = rows.every((r) => r.section !== section || r.row.hidden);
    empty.hidden = rows.some((r) => !r.row.hidden);
  };
  search.oninput = refresh;
  refresh();

  const button = (text: string, run: () => unknown) => h("button", { type: "button", onclick: () => (dialog.close(), run()) }, text);
  const resetAll = h("button", { type: "button" }, "Reset All…");
  resetAll.onclick = async () => {
    const changed = fields.filter((f) => !f.project && current(f) !== allDefaults()[f.key]);
    if (!changed.length) return toast("Every setting already has its default value.", { kind: "info", timeout: 4000 });
    dialog.close();
    if (!(await confirm(`Reset ${changed.length} ${changed.length === 1 ? "setting" : "settings"} to the defaults? Your keymap and project settings stay as they are.`, "Reset All"))) return openSettings(search.value);
    for (const f of changed) {
      (settings as Record<string, unknown>)[f.key] = allDefaults()[f.key];
      invalid.delete(f.key);
    }
    apply();
    await persist();
    openSettings(search.value);
  };
  const done = h("button", { class: "primary", type: "submit" }, "Done");
  const actions = h(
    "div",
    { class: "settings-actions" },
    button("Browse Themes…", pickTheme),
    button("Import Theme…", importTheme),
    button("Keymap…", keymapEditor),
    button("Open settings.json", openSettingsFile),
    resetAll,
    done,
  );
  const form = h("form", { method: "dialog" }, h("header", { class: "settings-header" }, h("h2", {}, "Settings"), search), banner, body, empty, actions);
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  // Escape clears the search first, then closes.
  dialog.addEventListener("cancel", (e) => {
    if (search.value && document.activeElement === search) e.preventDefault(), (search.value = ""), refresh();
  });
  dialog.showModal();
  search.focus();
}

/** Opens a picker of color themes that previews each one as you move through the list. Escape restores the theme. */
export function pickTheme() {
  const before = themeId();
  const themes = themeList();
  const items = themes.map((t) => ({
    label: t.name,
    detail: `${t.dark ? "Dark" : "Light"} · ${t.source}${t.id === before ? " · Current" : ""}`,
    icon: t.dark ? "codicon-color-mode" : "codicon-lightbulb",
    preview: () => applyTheme(t.id),
    run: () => updateSetting("theme", t.id),
  }));
  const start = themes.findIndex((t) => t.id === before);
  // The current theme comes first, so the picker opens on it.
  if (start > 0) items.unshift(...items.splice(start, 1));
  pick("Color theme (↑↓ to preview)", (q) => rank(q, items), 0, { value: "", onCancel: () => applyTheme(themeId()) });
}

/** Imports a VS Code (.json) or TextMate (.tmTheme) theme file and switches to it. */
export async function importTheme() {
  const path = await open({ title: "Import Color Theme", filters: [{ name: "Color themes", extensions: ["json", "jsonc", "tmTheme", "xml"] }] });
  if (typeof path !== "string") return;
  try {
    updateSetting("theme", await importThemeFile(path));
  } catch (err) {
    await choose(`Couldn't import the theme: ${err instanceof Error ? err.message : err}`, ["OK"]);
  }
}

/** Picks an imported theme to move to the Trash. */
export function removeTheme() {
  const imported = themeList().filter((t) => t.source === "Imported");
  pick(imported.length ? "Remove an imported color theme" : "No imported themes", (q) =>
    rank(
      q,
      imported.map((t) => ({
        label: t.name,
        run: async () => {
          await removeImportedTheme(t.id);
          for (const key of ["theme", "darkTheme", "lightTheme"] as const) if (settings[key] === t.id) settings[key] = key === "lightTheme" ? "light" : "dark";
          apply();
          persist();
        },
      })),
    ),
  );
}
