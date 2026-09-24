// Formatting with the project's own tools: Prettier, then Laravel Pint for PHP, then the bundled Mago.
import { invoke } from "@tauri-apps/api/core";
import { monaco } from "./editor";

type Host = { root(): string; status(text: string): void };
type Tools = { prettier?: string; pint: boolean };

let host: Host;
let tools: Tools = { pint: false };

const run = (program: string, args: string[], input: string) =>
  invoke<string>("run_capture", { cwd: host.root(), program, args, input });

/** Languages Prettier can format with its built-in parsers or common plugins. */
const PRETTIER_LANGUAGES = ["php", "blade", "javascript", "typescript", "css", "scss", "less", "json", "html", "markdown", "yaml", "vue"];

/** Monaco's own formatters, which would compete with Prettier for the same languages. */
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
  let prettier: string | undefined;
  for (const c of candidates) if (await exists(c)) prettier = `${host.root()}/${c}`;
  tools = { prettier, pint: await exists("vendor/bin/pint") };
  builtInFormatters(!prettier);
}

/**
 * Formats a file's text. Prettier handles every file its configuration can parse, which
 * includes PHP when the project uses @prettier/plugin-php. PHP files Prettier can't parse go
 * to Pint when the project has it, and to Mago otherwise.
 */
async function format(path: string, text: string, language: string): Promise<string | null> {
  const rel = path.slice(host.root().length + 1);
  if (tools.prettier) {
    try {
      return await run("node", [tools.prettier, "--stdin-filepath", rel], text);
    } catch (e) {
      if (!/No parser could be inferred/i.test(String(e))) throw e;
    }
  }
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
