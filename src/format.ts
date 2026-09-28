// Formatting with the project's own tools. Each language uses the formatter the project chose in the Formatters
// dialog (formatdata.ts, kept as the project's `formatters` value), or Auto: Prettier, then Laravel Pint for PHP,
// then Mago's formatter in Tusk's PHP server. Projects without Prettier get the bundled one, with the Svelte and
// Astro plugins, for everything but PHP and Blade. Blade that the project's Prettier can't format goes to the
// bundled blade-formatter. "Built-in" hands a language to Monaco's own formatter.
import { invoke } from "@tauri-apps/api/core";
import { tempDir } from "@tauri-apps/api/path";
import { monaco } from "./editor";
import type * as L from "vscode-languageserver-protocol";
import { FORMATTER_NAMES, type FormatterChoices, formatterFor, formatsOnSave, type FormatterId, INSTALL_HINTS } from "./formatdata";
import { toolPath, tuskRequest } from "./lsp";
import { onProjectValue, projectValue } from "./projectstate";
import { settings } from "./settings";
import { showError, status } from "./status";

type Host = { root(): string; status(text: string): void };
/** `plugins` are passed to Prettier with `--plugin`: the bundled Prettier's, which the project doesn't configure. */
type Tools = { prettier?: string; bundled: boolean; plugins: string[]; pint: boolean; phpCsFixer: boolean; blade?: string; node: boolean };

let host: Host;
let tools: Tools = { bundled: false, plugins: [], pint: false, phpCsFixer: false, node: false };

/** A formatter the project chose isn't installed; the message says how to install it. */
class Missing extends Error {}

const run = (program: string, args: string[], input: string) =>
  invoke<string>("run_capture", { cwd: host.root(), program, args, input });
const exists = (rel: string) => invoke<boolean>("path_exists", { path: `${host.root()}/${rel}` });

/** Languages Prettier can format with its built-in parsers or common plugins. */
const PRETTIER_LANGUAGES = ["php", "blade", "javascript", "typescript", "css", "scss", "less", "json", "html", "markdown", "yaml", "vue", "svelte", "astro"];

const choices = () => projectValue<FormatterChoices>("formatters");

/** The formatters found in the project, for the Formatters dialog. */
export const formatterTools = () => tools;

/** Whether saving a file of this language formats it: the project's choice, else the global setting. */
export const formatOnSave = (language: string) => formatsOnSave(choices(), language, settings.formatOnSave);

/**
 * Monaco's own formatters, which would compete with Prettier for the same languages: on for a language whose
 * formatter is Built-in, or that uses Auto while Node, and so Prettier, is missing.
 */
function builtInFormatters() {
  const all: [string, unknown][] = [
    ["css", monaco.css.cssDefaults],
    ["scss", monaco.css.scssDefaults],
    ["less", monaco.css.lessDefaults],
    ["html", monaco.html.htmlDefaults],
    ["json", monaco.json.jsonDefaults],
    ["typescript", monaco.typescript.typescriptDefaults],
    ["javascript", monaco.typescript.javascriptDefaults],
  ];
  for (const [language, defaults] of all) {
    const choice = formatterFor(choices(), language);
    const enabled = choice === "builtin" || (choice === "auto" && !tools.node);
    // Each defaults object has its own mode configuration type; the two keys are common to all of them.
    const d = defaults as { modeConfiguration: object; setModeConfiguration(c: object): void };
    d.setModeConfiguration({ ...d.modeConfiguration, documentFormattingEdits: enabled, documentRangeFormattingEdits: enabled });
  }
}

/** Finds the project's formatters. Call it when a folder opens. */
export async function detectFormatters() {
  // Prettier 3 and Prettier 2 keep their command-line entry in different files.
  const candidates = ["node_modules/prettier/bin/prettier.cjs", "node_modules/prettier/bin-prettier.js"];
  const [prettier3, prettier2, pint, phpCsFixer] = await Promise.all([...candidates, "vendor/bin/pint", "vendor/bin/php-cs-fixer"].map(exists));
  // The later candidate won when both existed.
  const found = prettier2 ? candidates[1] : prettier3 ? candidates[0] : undefined;
  const modules = `${await toolPath("node")}/node_modules`;
  const blade = `${modules}/blade-formatter/bin/blade-formatter.cjs`;
  // Prettier and blade-formatter run on Node. Without it, Monaco's own formatters handle what they can.
  const node = await run("node", ["--version"], "").then(() => true, () => false);
  if (!node) tools = { bundled: false, plugins: [], pint, phpCsFixer, node };
  else if (found) tools = { prettier: `${host.root()}/${found}`, bundled: false, plugins: [], pint, phpCsFixer, blade, node };
  else tools = { prettier: `${modules}/prettier/bin/prettier.cjs`, bundled: true, plugins: [`${modules}/prettier-plugin-svelte/plugin.js`, `${modules}/prettier-plugin-astro/dist/index.js`], pint, phpCsFixer, blade, node };
  register();
}

type Result = { text: string; by: string } | null;

async function prettier(rel: string, text: string, language: string) {
  const plugins = language === "svelte" || language === "astro" ? tools.plugins.map((p) => `--plugin=${p}`) : [];
  return run("node", [tools.prettier!, ...plugins, "--stdin-filepath", rel], text);
}

async function mago(path: string, text: string) {
  const edits = await tuskRequest<L.TextEdit[] | null>("textDocument/formatting", {
    textDocument: { uri: monaco.Uri.file(path).toString() },
    options: { tabSize: 4, insertSpaces: true },
  });
  // One edit of the whole file, none when it's already formatted, and null when mago.toml excludes it.
  return edits?.[0]?.newText ?? text;
}

/** PHP CS Fixer formats files, not standard input, so it gets a copy in the temporary folder, with the project's config. */
async function phpCsFixer(text: string) {
  const file = `${(await tempDir()).replace(/\/$/, "")}/tusk-format-${crypto.randomUUID()}.php`;
  await invoke("write_file", { path: file, contents: text });
  try {
    await run("php", ["vendor/bin/php-cs-fixer", "fix", "--using-cache=no", "--quiet", "--no-interaction", file], "");
    return await invoke<string>("read_file", { path: file });
  } finally {
    invoke("remove_path", { path: file }).catch(() => {});
  }
}

/** Formats with Auto: Prettier where its configuration can parse the file, then blade-formatter, Pint, or Mago. */
async function auto(path: string, rel: string, text: string, language: string): Promise<Result> {
  // The bundled Prettier has no PHP plugin, so PHP and Blade skip it instead of starting Node for nothing.
  if (tools.prettier && !(tools.bundled && (language === "php" || language === "blade"))) {
    try {
      return { text: await prettier(rel, text, language), by: "Prettier" };
    } catch (e) {
      if (!/No parser could be inferred/i.test(String(e))) throw e;
    }
  }
  // It reads the project's .bladeformatterrc, and indents with 4 spaces without one, as Laravel's views do.
  if (language === "blade" && tools.blade) return { text: await run("node", [tools.blade, "--stdin"], text), by: "blade-formatter" };
  if (language !== "php") return null;
  if (tools.pint) return { text: await run("php", ["vendor/bin/pint", "-", `--stdin-filename=${rel}`], text), by: "Laravel Pint" };
  return { text: await mago(path, text), by: "Mago" };
}

const missing = (id: FormatterId, why = "isn't installed in this project") => new Missing(`${FORMATTER_NAMES[id]} ${why}. ${INSTALL_HINTS[id] ?? ""}`.trim());

/** Formats a file's text with the language's formatter. Null leaves it as it is: None, Built-in, or no formatter. */
async function format(path: string, text: string, language: string): Promise<Result> {
  const rel = path.slice(host.root().length + 1);
  const choice = formatterFor(choices(), language);
  switch (choice) {
    case "none":
    case "builtin":
      return null;
    case "auto":
      return auto(path, rel, text, language);
    case "prettier":
      if (!tools.prettier) throw new Missing("Prettier needs Node.js, which wasn't found. Set its path in Settings > Tools.");
      if (tools.bundled && (language === "php" || language === "blade"))
        throw new Missing(`The bundled Prettier doesn't format ${language === "php" ? "PHP" : "Blade"}. Install Prettier and its plugin in the project with: npm install --save-dev prettier ${language === "php" ? "@prettier/plugin-php" : "@shufo/prettier-plugin-blade"}`);
      return { text: await prettier(rel, text, language), by: tools.bundled ? "Prettier (bundled)" : "Prettier" };
    case "pint":
      if (!(await exists("vendor/bin/pint"))) throw missing("pint");
      return { text: await run("php", ["vendor/bin/pint", "-", `--stdin-filename=${rel}`], text), by: "Laravel Pint" };
    case "php-cs-fixer":
      if (!(await exists("vendor/bin/php-cs-fixer"))) throw missing("php-cs-fixer");
      return { text: await phpCsFixer(text), by: "PHP CS Fixer" };
    case "mago":
      return { text: await mago(path, text), by: "Mago" };
    case "blade-formatter":
      if (!tools.blade) throw new Missing("blade-formatter needs Node.js, which wasn't found. Set its path in Settings > Tools.");
      return { text: await run("node", [tools.blade, "--stdin"], text), by: "blade-formatter" };
  }
}

let openDialog = () => {};
/** Sets what an error's Formatters… button opens. */
export const setFormattersDialog = (open: () => void) => (openDialog = open);

/** Formats and reports: which formatter ran in the status bar, a missing formatter as an error with how to install it. */
async function formatReported(model: monaco.editor.ITextModel): Promise<string | null> {
  try {
    const result = await format(model.uri.fsPath, model.getValue(), model.getLanguageId());
    if (result) status(`Formatted with ${result.by}`, "format");
    return result?.text ?? null;
  } catch (e) {
    if (e instanceof Missing) showError(e.message, undefined, { label: "Formatters…", run: openDialog });
    else host.status(`Format failed: ${String(e).trim().split("\n")[0]}`);
    return null;
  }
}

let provider: monaco.IDisposable | undefined;
/** Registers the formatter for every language that doesn't use Monaco's own, which then has the language alone. */
function register() {
  builtInFormatters();
  provider?.dispose();
  const languages = PRETTIER_LANGUAGES.filter((l) => formatterFor(choices(), l) !== "builtin");
  // Monaco turns the whole-file result into minimal edits, so the cursor stays put.
  provider = monaco.languages.registerDocumentFormattingEditProvider(languages, {
    async provideDocumentFormattingEdits(model) {
      if (!host.root() || model.uri.scheme !== "file") return [];
      if (formatterFor(choices(), model.getLanguageId()) === "none") return status("Formatting is off for this language (Code > Formatters…)", "format"), [];
      const text = await formatReported(model);
      return text === null ? [] : [{ range: model.getFullModelRange(), text }];
    },
  });
}

/** Applies a changed choice of formatters. */
export const formattersChanged = () => register();

export function initFormatting(h: Host) {
  host = h;
  register();
  onProjectValue("formatters", register);
}

/**
 * Formats a model in place with an undoable edit, for format on save in a tab that isn't active. Monaco's built-in
 * formatters need an editor, so such a file isn't formatted.
 */
export async function formatModel(model: monaco.editor.ITextModel) {
  if (!host.root() || model.uri.scheme !== "file") return;
  const text = await formatReported(model);
  if (text !== null && text !== model.getValue()) model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
}
