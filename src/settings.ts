// User settings: stored in settings.json in the app's config folder and applied live.
import { invoke } from "@tauri-apps/api/core";
import { appConfigDir } from "@tauri-apps/api/path";
import { monaco } from "./editor";
import { defineThemes } from "./themes";

defineThemes();

export type Settings = {
  theme: "dark" | "light" | "system";
  fontFamily: string;
  fontSize: number;
  wordWrap: boolean;
  minimap: boolean;
  inlayHints: boolean;
  autoSave: boolean;
  formatOnSave: boolean;
  spellCheck: boolean;
  /** Shortcut overrides by action name, such as { "Go to File": "Meta+P" }. "" removes the shortcut. */
  keymap: Record<string, string>;
};

const defaults: Settings = {
  theme: "dark",
  fontFamily: "JetBrains Mono, SF Mono, Menlo, monospace",
  fontSize: 13,
  wordWrap: false,
  minimap: false,
  inlayHints: true,
  autoSave: true,
  formatOnSave: false,
  spellCheck: true,
  keymap: {},
};

type Field = { key: keyof Settings; label: string; help?: string } & (
  | { type: "checkbox" }
  | { type: "number"; min: number; max: number }
  | { type: "text" }
  | { type: "select"; options: [string, string][] }
);

/** The settings form, in order. */
const fields: Field[] = [
  { key: "theme", label: "Theme", type: "select", options: [["dark", "Dark"], ["light", "Light"], ["system", "Match the system"]] },
  { key: "fontFamily", label: "Editor font", type: "text", help: "A CSS font list; the first installed font is used." },
  { key: "fontSize", label: "Font size", type: "number", min: 8, max: 32 },
  { key: "wordWrap", label: "Wrap long lines", type: "checkbox" },
  { key: "minimap", label: "Show the minimap", type: "checkbox" },
  { key: "inlayHints", label: "Show inlay hints (parameter names and types)", type: "checkbox" },
  { key: "autoSave", label: "Save files automatically", type: "checkbox", help: "When you switch tabs, close a tab, or switch to another app." },
  { key: "formatOnSave", label: "Format files when saving", type: "checkbox", help: "Uses the project's Prettier or Pint, or Mago." },
  { key: "spellCheck", label: "Check spelling", type: "checkbox", help: "In comments, strings, and names. Add a project's own words to _typos.toml." },
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

/** Whether the effective theme is dark, resolving "system". */
export const isDark = () => (settings.theme === "system" ? systemDark.matches : settings.theme === "dark");

function apply() {
  const dark = isDark();
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  monaco.editor.setTheme(dark ? "editor-dark" : "editor-light");
  for (const ed of editors) {
    ed.updateOptions({
      fontFamily: settings.fontFamily,
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
  try {
    const saved = JSON.parse(await invoke<string>("read_file", { path: await file() }));
    for (const key of Object.keys(defaults) as (keyof Settings)[]) {
      if (typeof saved[key] === typeof defaults[key] && saved[key] !== null) (settings as Record<string, unknown>)[key] = saved[key];
    }
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
    const row = document.createElement("label");
    row.className = `setting setting-${f.type}`;
    const name = document.createElement("span");
    name.textContent = f.label;
    let input: HTMLInputElement | HTMLSelectElement;
    if (f.type === "select") {
      input = document.createElement("select");
      for (const [value, text] of f.options) input.append(new Option(text, value, false, settings[f.key] === value));
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

  const keymap = document.createElement("button");
  keymap.type = "button";
  keymap.textContent = "Keymap…";
  keymap.onclick = () => (dialog.close(), keymapEditor());
  const done = document.createElement("button");
  done.textContent = "Done";
  form.append(keymap, done);
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
}
