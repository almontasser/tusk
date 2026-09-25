// Color themes. The built-in Dark and Light themes match the interface's default colors, with syntax colors
// close to PhpStorm's. The rest come from other editors: VS Code themes (tm-themes), classic TextMate themes
// (monaco-themes), and themes you import, converted by colortheme.ts.
import { invoke } from "@tauri-apps/api/core";
import { appConfigDir } from "@tauri-apps/api/path";
import { themes as vscodeThemes } from "tm-themes";
import { type ColorTheme, type Converted, convert, parseJsonc, parsePlist, readTheme, rules } from "./colortheme";
import { monaco } from "./editor";

function defineBuiltIns() {
  monaco.editor.defineTheme("editor-dark", {
    base: "vs-dark",
    inherit: true,
    rules: rules({
      text: "#bcbec4", comment: "#7a7e85", docComment: "#5f826b", keyword: "#cf8e6d", string: "#6aab73", number: "#2aacb8",
      variable: "#bcbec4", type: "#bcbec4", tag: "#d5b778", attribute: "#bababa", field: "#c77dbb",
    }),
    colors: {
      "editor.background": "#1e1f22",
      "editor.foreground": "#bcbec4",
      "editor.lineHighlightBackground": "#26282e",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#214283",
      "editor.inactiveSelectionBackground": "#21428366",
      "editor.wordHighlightBackground": "#373b3980",
      "editor.findMatchBackground": "#32593d",
      "editor.findMatchHighlightBackground": "#2f4d3a80",
      "editorLineNumber.foreground": "#4b5059",
      "editorLineNumber.activeForeground": "#a1a3ab",
      "editorIndentGuide.background1": "#2c2e33",
      "editorIndentGuide.activeBackground1": "#43454a",
      "editorWhitespace.foreground": "#34363b",
      "editorGutter.background": "#1e1f22",
      "editorCursor.foreground": "#ced0d6",
      "editorBracketMatch.background": "#43454a",
      "editorBracketMatch.border": "#00000000",
      "editorInlayHint.background": "#2b2d30",
      "editorInlayHint.foreground": "#8c8f94",
      "editorCodeLens.foreground": "#6f737a",
      "editorWidget.background": "#2b2d30",
      "editorWidget.border": "#43454a",
      "editorSuggestWidget.background": "#2b2d30",
      "editorSuggestWidget.border": "#43454a",
      "editorSuggestWidget.selectedBackground": "#2e436e",
      "editorHoverWidget.background": "#2b2d30",
      "editorHoverWidget.border": "#43454a",
      "list.hoverBackground": "#393b40",
      "list.activeSelectionBackground": "#2e436e",
      "scrollbarSlider.background": "#4e515766",
      "scrollbarSlider.hoverBackground": "#5a5d6399",
      "scrollbarSlider.activeBackground": "#6f737a99",
      "editorOverviewRuler.border": "#00000000",
      "peekViewEditor.background": "#1e1f22",
      "peekViewResult.background": "#2b2d30",
      "peekViewTitle.background": "#2b2d30",
      "diffEditor.insertedTextBackground": "#54915933",
      "diffEditor.removedTextBackground": "#e06c7533",
    },
  });
  monaco.editor.defineTheme("editor-light", {
    base: "vs",
    inherit: true,
    rules: rules({
      text: "#080808", comment: "#8c8c8c", docComment: "#8c8c8c", keyword: "#0033b3", string: "#067d17", number: "#1750eb",
      variable: "#080808", type: "#000000", tag: "#0033b3", attribute: "#174ad4", field: "#871094",
    }),
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#080808",
      "editor.lineHighlightBackground": "#f5f8fe",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#a6d2ff",
      "editorLineNumber.foreground": "#aeb3c2",
      "editorLineNumber.activeForeground": "#767a8a",
      "editorIndentGuide.background1": "#ebecf0",
      "editorIndentGuide.activeBackground1": "#c9ccd6",
      "editorGutter.background": "#ffffff",
      "editorInlayHint.background": "#f2f3f5",
      "editorInlayHint.foreground": "#818594",
      "editorCodeLens.foreground": "#818594",
      "editorWidget.background": "#ffffff",
      "editorWidget.border": "#dfe1e5",
      "editorSuggestWidget.selectedBackground": "#d5e1ff",
      "list.activeSelectionBackground": "#d5e1ff",
      "list.activeSelectionForeground": "#000000",
      "scrollbarSlider.background": "#a0a3ad55",
      "scrollbarSlider.hoverBackground": "#a0a3ad88",
      "editorOverviewRuler.border": "#00000000",
    },
  });
}

export type ThemeInfo = { id: string; name: string; dark: boolean; source: string; load?: () => Promise<unknown> };

// Theme files load when you choose them, not with the app.
const vscodeFiles = import.meta.glob<unknown>("../node_modules/tm-themes/themes/*.json", { import: "default" });
const textmateFiles = import.meta.glob<unknown>(["../node_modules/monaco-themes/themes/*.json", "!**/themelist.json"], { import: "default" });
/** The light TextMate themes. Reading each file's `base` instead would bundle every theme with the app. */
const textmateLight = new Set(["Active4D", "Chrome DevTools", "Clouds", "Dawn", "Dreamweaver", "Eiffel", "GitHub", "IDLE", "iPlastic", "Katzenmilch", "Kuroir Theme", "LAZY", "MagicWB (Amiga)", "Slush and Poppies", "Textmate (Mac Classic)", "Tomorrow", "Xcode_default"]);
/** TextMate themes that tm-themes has in a newer VS Code version. */
const duplicates = new Set(["Dracula", "GitHub Dark", "GitHub Light", "Monokai", "Night Owl", "Nord", "Solarized-dark", "Solarized-light"]);

const builtIn: ThemeInfo[] = [
  { id: "dark", name: "Dark", dark: true, source: "Built-in" },
  { id: "light", name: "Light", dark: false, source: "Built-in" },
];
const bundled: ThemeInfo[] = [
  ...vscodeThemes.map((t) => ({
    id: t.name,
    name: t.displayName.replace(/ Theme\b/, ""),
    dark: t.type === "dark",
    source: "VS Code",
    load: vscodeFiles[`../node_modules/tm-themes/themes/${t.name}.json`],
  })),
  ...Object.keys(textmateFiles)
    .map((path) => path.slice(path.lastIndexOf("/") + 1, -5))
    .filter((file) => !duplicates.has(file))
    .map((file) => ({
      id: `textmate-${file.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      name: file.replace(/[-_]/g, " ").replace(/ Theme$/, ""),
      dark: !textmateLight.has(file),
      source: "TextMate",
      load: textmateFiles[`../node_modules/monaco-themes/themes/${file}.json`],
    })),
];
let imported: ThemeInfo[] = [];

/** Every theme: built-in, then bundled and imported ones by name. */
export const themeList = () => [...builtIn, ...[...bundled, ...imported].sort((a, b) => a.name.localeCompare(b.name))];
export const findTheme = (id: string) => themeList().find((t) => t.id === id);

const themesDir = async () => `${await appConfigDir()}/themes`;

/** Loads the themes you imported, which are saved in the themes folder of the app's config folder. */
export async function loadImportedThemes() {
  const dir = await themesDir();
  const entries = await invoke<{ name: string; path: string; is_dir: boolean }[]>("read_dir", { path: dir }).catch(() => []);
  const found: ThemeInfo[] = [];
  for (const e of entries.filter((e) => !e.is_dir && e.name.endsWith(".json"))) {
    try {
      const theme = readTheme(parseJsonc(await invoke<string>("read_file", { path: e.path })));
      found.push({ id: `user-${e.name.slice(0, -5)}`, name: theme.name, dark: theme.type === "dark", source: "Imported", load: async () => theme });
    } catch (err) {
      console.warn(`Skipped theme ${e.path}:`, err);
    }
  }
  imported = found;
}

/**
 * Reads a VS Code theme (.json), a TextMate theme (.tmTheme), or a Monaco theme, following VS Code's
 * `include` and a `tokenColors` file path relative to the file.
 */
async function readThemeFile(path: string, depth = 0): Promise<Record<string, unknown>> {
  const text = await invoke<string>("read_file", { path });
  const raw = (/\.(tmTheme|plist|xml)$/i.test(path) || text.trimStart().startsWith("<") ? parsePlist(text) : parseJsonc(text)) as Record<string, unknown>;
  const near = (rel: string) => path.slice(0, path.lastIndexOf("/") + 1) + rel.replace(/^\.\//, "");
  if (typeof raw.tokenColors === "string") raw.tokenColors = (await readThemeFile(near(raw.tokenColors), depth + 1)).settings ?? [];
  if (typeof raw.include === "string" && depth < 5) {
    const base = await readThemeFile(near(raw.include), depth + 1);
    raw.colors = { ...(base.colors as object), ...(raw.colors as object) };
    raw.tokenColors = [...((base.tokenColors ?? base.settings ?? []) as unknown[]), ...((raw.tokenColors ?? raw.settings ?? []) as unknown[])];
    raw.type ??= base.type;
  }
  return raw;
}

/** Imports a theme file into the themes folder and returns its id. */
export async function importThemeFile(path: string): Promise<string> {
  const file = path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  const theme: ColorTheme = readTheme(await readThemeFile(path), file);
  const slug = theme.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "theme";
  const dir = await themesDir();
  await invoke("create_dir", { path: dir });
  await invoke("write_file", { path: `${dir}/${slug}.json`, contents: JSON.stringify(theme, null, 2) + "\n" });
  converted.delete(`user-${slug}`);
  await loadImportedThemes();
  return `user-${slug}`;
}

/** Moves an imported theme to the Trash. */
export async function removeImportedTheme(id: string) {
  await invoke("trash_path", { path: `${await themesDir()}/${id.slice("user-".length)}.json` });
  converted.delete(id);
  await loadImportedThemes();
}

// ---- Applying ----

const converted = new Map<string, Converted>();
const listeners: ((t: { dark: boolean; terminal?: Record<string, string> }) => void)[] = [];
let current: { dark: boolean; terminal?: Record<string, string> } = { dark: true };
let generation = 0;

/** Calls `fn` now and whenever the theme changes, with the terminal colors of a non-built-in theme. */
export function onTheme(fn: (t: typeof current) => void) {
  listeners.push(fn);
  fn(current);
}

/** Switches the editor, the interface, and the terminal to a theme. An unknown id falls back to Dark. */
export async function applyTheme(id: string) {
  const info = findTheme(id) ?? builtIn[0];
  const mine = ++generation;
  let theme: Converted | undefined;
  if (info.load) {
    theme = converted.get(info.id);
    if (!theme) {
      try {
        theme = convert(readTheme(await info.load(), info.name));
      } catch (err) {
        console.warn(`Couldn't load theme ${info.name}:`, err);
        return;
      }
      converted.set(info.id, theme);
      monaco.editor.defineTheme(`theme-${info.id}`, theme.monaco);
    }
  }
  if (mine !== generation) return; // A newer choice already applied.
  const root = document.documentElement;
  const dark = theme?.dark ?? info.dark;
  root.dataset.theme = dark ? "dark" : "light";
  // The built-in themes use the defaults in styles.css.
  for (const name of [...root.style].filter((p) => p.startsWith("--"))) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(theme?.ui ?? {})) root.style.setProperty(`--${name}`, value);
  monaco.editor.setTheme(theme ? `theme-${info.id}` : dark ? "editor-dark" : "editor-light");
  current = { dark, terminal: theme?.terminal };
  listeners.forEach((fn) => fn(current));
}

defineBuiltIns();
