// Formatting with the project's own tools: Prettier, then Laravel Pint for PHP, then the bundled Mago. Projects
// without Prettier get the bundled one, with the Svelte and Astro plugins, for everything but PHP and Blade.
// Blade that the project's Prettier can't format goes to the bundled blade-formatter.
import { invoke } from "@tauri-apps/api/core";
import { monaco } from "./editor";

type Host = { root(): string; status(text: string): void };
/** `plugins` are passed to Prettier with `--plugin`: the bundled Prettier's, which the project doesn't configure. */
type Tools = { prettier?: string; bundled: boolean; plugins: string[]; pint: boolean; blade?: string };

let host: Host;
let tools: Tools = { bundled: false, plugins: [], pint: false };

const run = (program: string, args: string[], input: string) =>
  invoke<string>("run_capture", { cwd: host.root(), program, args, input });

/** Languages Prettier can format with its built-in parsers or common plugins. */
const PRETTIER_LANGUAGES = ["php", "blade", "javascript", "typescript", "css", "scss", "less", "json", "html", "markdown", "yaml", "vue", "svelte", "astro"];

/** Monaco's own formatters, which would compete with Prettier for the same languages; on only when Node, and so Prettier, is missing. */
function builtInFormatters(enabled: boolean) {
  const all = [monaco.css.cssDefaults, monaco.css.scssDefaults, monaco.css.lessDefaults, monaco.html.htmlDefaults, monaco.json.jsonDefaults, monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults];
  for (const defaults of all) {
    defaults.setModeConfiguration({ ...defaults.modeConfiguration, documentFormattingEdits: enabled, documentRangeFormattingEdits: enabled });
  }
}

/** Finds the project's formatters. Call it when a folder opens. */
export async function detectFormatters() {
  const exists = (path: string) => invoke<boolean>("path_exists", { path: `${host.root()}/${path}` });
  // Prettier 3 and Prettier 2 keep their command-line entry in different files.
  const candidates = ["node_modules/prettier/bin/prettier.cjs", "node_modules/prettier/bin-prettier.js"];
  const [prettier3, prettier2, pint] = await Promise.all([...candidates, "vendor/bin/pint"].map(exists));
  // The later candidate won when both existed.
  const found = prettier2 ? candidates[1] : prettier3 ? candidates[0] : undefined;
  const modules = `${await invoke<string>("tool_path", { name: "node" })}/node_modules`;
  const blade = `${modules}/blade-formatter/bin/blade-formatter.cjs`;
  // Prettier and blade-formatter run on Node. Without it, Monaco's own formatters handle what they can.
  const node = await run("node", ["--version"], "").then(() => true, () => false);
  builtInFormatters(!node);
  if (!node) tools = { bundled: false, plugins: [], pint };
  else if (found) tools = { prettier: `${host.root()}/${found}`, bundled: false, plugins: [], pint, blade };
  else tools = { prettier: `${modules}/prettier/bin/prettier.cjs`, bundled: true, plugins: [`${modules}/prettier-plugin-svelte/plugin.js`, `${modules}/prettier-plugin-astro/dist/index.js`], pint, blade };
}

/**
 * Formats a file's text. Prettier handles every file its configuration can parse, which
 * includes PHP when the project uses @prettier/plugin-php. PHP files Prettier can't parse go
 * to Pint when the project has it, and to Mago otherwise.
 */
async function format(path: string, text: string, language: string): Promise<string | null> {
  const rel = path.slice(host.root().length + 1);
  // The bundled Prettier has no PHP plugin, so PHP and Blade skip it instead of starting Node for nothing.
  if (tools.prettier && !(tools.bundled && (language === "php" || language === "blade"))) {
    const plugins = language === "svelte" || language === "astro" ? tools.plugins.map((p) => `--plugin=${p}`) : [];
    try {
      return await run("node", [tools.prettier, ...plugins, "--stdin-filepath", rel], text);
    } catch (e) {
      if (!/No parser could be inferred/i.test(String(e))) throw e;
    }
  }
  // It reads the project's .bladeformatterrc, and indents with 4 spaces without one, as Laravel's views do.
  if (language === "blade" && tools.blade) return run("node", [tools.blade, "--stdin"], text);
  if (language !== "php") return null;
  if (tools.pint) return run("php", ["vendor/bin/pint", "-", `--stdin-filename=${rel}`], text);
  const mago = await invoke<string>("tool_path", { name: "mago" });
  return run(mago, ["format", "--stdin-input", "--stdin-filepath", rel], text);
}

export function initFormatting(h: Host) {
  host = h;
  // Monaco turns the whole-file result into minimal edits, so the cursor stays put.
  monaco.languages.registerDocumentFormattingEditProvider(PRETTIER_LANGUAGES, {
    async provideDocumentFormattingEdits(model) {
      if (!host.root() || model.uri.scheme !== "file") return [];
      try {
        const text = await format(model.uri.fsPath, model.getValue(), model.getLanguageId());
        return text === null ? [] : [{ range: model.getFullModelRange(), text }];
      } catch (e) {
        host.status(`Format failed: ${String(e).trim().split("\n")[0]}`);
        return [];
      }
    },
  });
}

/** Formats a model in place with an undoable edit. Used by format on save, so errors only go to the status bar. */
export async function formatModel(model: monaco.editor.ITextModel) {
  if (!host.root() || model.uri.scheme !== "file") return;
  try {
    const text = await format(model.uri.fsPath, model.getValue(), model.getLanguageId());
    if (text !== null && text !== model.getValue()) {
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
    }
  } catch (e) {
    host.status(`Format failed: ${String(e).trim().split("\n")[0]}`);
  }
}
