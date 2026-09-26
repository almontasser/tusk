// User settings: stored in settings.json in the app's config folder and applied live.
import { invoke } from "@tauri-apps/api/core";
import { appConfigDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { monaco } from "./editor";
import { choose, pick, rank } from "./palette";
import { applyTheme, importThemeFile, loadImportedThemes, removeImportedTheme, themeList } from "./themes";

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
  fontFamily: "JetBrains Mono, JetBrainsMono Nerd Font Mono, JetBrainsMono Nerd Font, SF Mono, Menlo, monospace",
  fontSize: 13,
  wordWrap: false,
  minimap: false,
  inlayHints: true,
  inlineProblems: false,
  autoSave: true,
  formatOnSave: false,
  spellCheck: true,
  aiCompletion: false,
  aiModel: "qwen2.5-coder-3b",
  keymap: {},
};

/** `section` starts a new group of settings under that heading. */
type Field = { key: keyof Settings; label: string; help?: string; section?: string } & (
  | { type: "checkbox" }
  | { type: "number"; min: number; max: number }
  | { type: "text" }
  | { type: "select"; options: [string, string][] | (() => [value: string, text: string, group: string][]) }
);

/** The settings form, in order. */
const fields: Field[] = [
  { section: "Appearance", key: "theme", label: "Theme", type: "select", options: () => [["system", "Match the system", ""], ...themeOptions()] },
  { key: "darkTheme", label: "Dark theme for Match the system", type: "select", options: () => themeOptions(true) },
  { key: "lightTheme", label: "Light theme for Match the system", type: "select", options: () => themeOptions(false) },
  { key: "fontFamily", label: "Editor font", type: "text", help: "A CSS font list; the first installed font is used." },
  { key: "fontSize", label: "Font size", type: "number", min: 8, max: 32 },
  { section: "Editor", key: "wordWrap", label: "Wrap long lines", type: "checkbox" },
  { key: "minimap", label: "Show the minimap", type: "checkbox" },
  { key: "inlayHints", label: "Show inlay hints (parameter names and types)", type: "checkbox" },
  { key: "inlineProblems", label: "Show the cursor line's problem at the end of the line", type: "checkbox" },
  { key: "autoSave", label: "Save files automatically", type: "checkbox", help: "When you switch tabs, close a tab, or switch to another app." },
  { key: "formatOnSave", label: "Format files when saving", type: "checkbox", help: "Uses the project's Prettier or Pint, or Mago." },
  { section: "AI", key: "aiCompletion", label: "AI code completion", type: "checkbox", help: "Suggests code as you type with a model that runs on this Mac. Tab accepts a suggestion. The first time, the model is downloaded." },
  {
    key: "aiModel",
    label: "AI completion model",
    type: "select",
    options: [
      ["qwen2.5-coder-1.5b", "Qwen2.5-Coder 1.5B: fastest (1.6 GB)"],
      ["qwen2.5-coder-3b", "Qwen2.5-Coder 3B: best balance (3.3 GB)"],
      ["qwen2.5-coder-7b", "Qwen2.5-Coder 7B: best (8.1 GB, needs 16 GB of memory)"],
    ],
  },
  { section: "Spelling", key: "spellCheck", label: "Check spelling", type: "checkbox", help: "In comments, strings, and names. Add a project's own words to _typos.toml." },
];

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
  }
  listeners.forEach((fn) => fn(settings));
}
systemDark.addEventListener("change", () => settings.theme === "system" && apply());

async function persist() {
  const path = await file();
  await invoke("create_dir", { path: path.slice(0, path.lastIndexOf("/")) });
  await invoke("write_file", { path, contents: JSON.stringify(settings, null, 2) + "\n" });
}

/** Changes one setting, applies it, and saves. */
export function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  settings[key] = value;
  apply();
  persist();
}

let keymapEditor = () => {};
/** Sets what the Keymap button in the dialog opens. */
export const setKeymapEditor = (open: () => void) => (keymapEditor = open);

/** Applies the settings to an editor now and after every change. */
export function addEditor(ed: monaco.editor.ICodeEditor) {
  editors.push(ed);
  apply();
}

/** Stops applying settings to a disposed editor. */
export const removeEditor = (ed: monaco.editor.ICodeEditor) => (editors = editors.filter((e) => e !== ed));

/** Loads settings from disk and applies them. Unknown or invalid values fall back to defaults. */
export async function initSettings() {
  await loadImportedThemes();
  try {
    const saved = JSON.parse(await invoke<string>("read_file", { path: await file() }));
    for (const key of Object.keys(defaults) as (keyof Settings)[]) {
      if (typeof saved[key] === typeof defaults[key] && saved[key] !== null) (settings as Record<string, unknown>)[key] = saved[key];
    }
    // The file keeps every value, so the default font list from before the Nerd Font names came along stays in it.
    if (settings.fontFamily === "JetBrains Mono, SF Mono, Menlo, monospace") settings.fontFamily = defaults.fontFamily;
  } catch {
    // No settings file yet: use the defaults.
  }
  apply();
}

/** Opens the settings dialog. Changes apply and save immediately. */
export function openSettings() {
  document.getElementById("settings")?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "settings";
  const form = document.createElement("form");
  form.method = "dialog";
  const heading = document.createElement("h2");
  heading.textContent = "Settings";
  form.append(heading);

  for (const f of fields) {
    if (f.section) form.append(Object.assign(document.createElement("h3"), { textContent: f.section }));
    const row = document.createElement("label");
    row.className = `setting setting-${f.type}`;
    const name = document.createElement("span");
    name.textContent = f.label;
    let input: HTMLInputElement | HTMLSelectElement;
    if (f.type === "select") {
      input = document.createElement("select");
      const groups = new Map<string, HTMLElement>();
      for (const [value, text, group] of typeof f.options === "function" ? f.options() : f.options) {
        let parent: HTMLElement = input;
        if (group) {
          if (!groups.has(group)) groups.set(group, input.appendChild(Object.assign(document.createElement("optgroup"), { label: group })));
          parent = groups.get(group)!;
        }
        parent.append(new Option(text, value, false, settings[f.key] === value));
      }
    } else {
      input = document.createElement("input");
      input.type = f.type;
      if (f.type === "checkbox") input.checked = settings[f.key] as boolean;
      else input.value = String(settings[f.key]);
      if (f.type === "number") Object.assign(input, { min: f.min, max: f.max });
    }
    input.onchange = () => {
      const el = input as HTMLInputElement;
      const value = f.type === "checkbox" ? el.checked : f.type === "number" ? Math.min(f.max, Math.max(f.min, Number(el.value) || (defaults[f.key] as number))) : el.value;
      (settings as Record<string, unknown>)[f.key] = value;
      apply();
      persist();
    };
    if (f.type === "checkbox") row.append(input, name);
    else row.append(name, input);
    if (f.help) {
      const help = document.createElement("small");
      help.textContent = f.help;
      row.append(help);
    }
    form.append(row);
  }

  const button = (text: string, run: () => void) =>
    Object.assign(document.createElement("button"), { type: "button", textContent: text, onclick: () => (dialog.close(), run()) });
  const themes = button("Browse Themes…", pickTheme);
  const importButton = button("Import Theme…", importTheme);
  const keymap = document.createElement("button");
  keymap.type = "button";
  keymap.textContent = "Keymap…";
  keymap.onclick = () => (dialog.close(), keymapEditor());
  const done = document.createElement("button");
  done.className = "primary";
  done.textContent = "Done";
  const actions = document.createElement("div");
  actions.className = "settings-actions";
  actions.append(themes, importButton, keymap, done);
  form.append(actions);
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
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
