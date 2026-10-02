// Spelling: the settings, dictionaries, and quick fixes of the spell checker (typos-lsp, started in lsp.ts).
//
// typos checks words against a list of known misspellings, and a dictionary is the words it should accept anyway,
// kept as `word = "word"` under `[default.extend-words]`. The project's dictionary is its `_typos.toml` (or the
// typos.toml or .typos.toml it has), which a team commits. Your own is `spelling.toml` in the app's config folder,
// which typos-lsp reads for every project on top of the project's file (its `config` option).
import { invoke } from "@tauri-apps/api/core";
import { appConfigDir } from "@tauri-apps/api/path";
import { monaco } from "./editor";
import { h } from "./dom";
import { redrawSpelling, restartSpelling, spelling, SPELLING_LANGUAGES, spellingRoot, spellingServer } from "./lsp";
import { listEditor, onSettings, openPath, registerSettings, registerSettingsSection, settings as allSettings, updateSetting } from "./settings";
import { showError, status } from "./status";
import { thisComputer } from "./platform.ts";

const settings = registerSettings("Spelling", { spellingSeverity: "typo", spellingSkip: "" }, [
  {
    key: "spellingSeverity",
    label: "Show misspellings as",
    type: "select",
    options: [
      ["typo", "Typos (a green wavy underline)"],
      ["warning", "Warnings"],
      ["error", "Errors"],
    ],
    help: "Warnings and errors count in the Problems panel.",
    shown: () => allSettings.spellCheck,
  },
]);

/** The languages you turned spelling off for, from the comma-separated setting. */
const skipped = () => settings.spellingSkip.split(",").map((s) => s.trim()).filter(Boolean);

let applied = { severity: "", skip: "" };
onSettings(() => {
  spelling.severity = settings.spellingSeverity as typeof spelling.severity;
  spelling.languages = SPELLING_LANGUAGES.filter((l) => !skipped().includes(l));
  if (applied.severity && applied.severity !== settings.spellingSeverity) redrawSpelling();
  if (applied.severity && applied.skip !== settings.spellingSkip) restartSpelling().catch((e) => showError("Can't restart the spell checker", e));
  applied = { severity: settings.spellingSeverity, skip: settings.spellingSkip };
});

// ---- Dictionaries ----

const USER_HEADER = "# Words Tusk's spell checker accepts in every project. Settings > Spelling edits this list.\n";

/** Your dictionary's file, made the first time: typos-lsp can't start with a `config` file that isn't there. */
async function userDictionary() {
  const path = `${await appConfigDir()}/spelling.toml`;
  if (!(await invoke<boolean>("path_exists", { path }))) {
    await invoke("create_dir", { path: path.slice(0, path.lastIndexOf("/")) });
    // The table goes in now, so words land under the comment rather than after it.
    await invoke("write_file", { path, contents: `${USER_HEADER}\n[default.extend-words]\n` });
  }
  return path;
}
spelling.userDictionary = userDictionary;

/** The project's typos configuration: the one it has, else `_typos.toml`, which the first saved word creates. */
async function projectDictionary(root: string) {
  for (const name of ["typos.toml", "_typos.toml", ".typos.toml"]) if (await invoke<boolean>("path_exists", { path: `${root}/${name}` })) return `${root}/${name}`;
  return `${root}/_typos.toml`;
}

type Where = "project" | "user";
const fileOf = (where: Where) => (where === "user" ? userDictionary() : projectDictionary(spellingRoot()));

/** The words a dictionary accepts: `[default.extend-words]` entries that map a word to itself, sorted. */
export function dictionaryWords(config: unknown): string[] {
  const words = (config as { default?: { "extend-words"?: Record<string, unknown> } } | null)?.default?.["extend-words"] ?? {};
  return Object.entries(words)
    .filter(([k, v]) => typeof v === "string" && k.toLowerCase() === v.toLowerCase())
    .map(([k]) => k)
    .sort((a, b) => a.localeCompare(b));
}

const wordsIn = async (where: Where) => dictionaryWords(await invoke("toml_read", { path: await fileOf(where) }));

/**
 * Adds a word to a dictionary. While the spell checker runs, it writes the file itself and checks the open files
 * again at once; otherwise the file is edited here. typos ignores letter case, so the word is saved in lowercase.
 */
async function addWord(word: string, where: Where) {
  const typo = word.toLowerCase();
  const path = await fileOf(where);
  const server = spellingServer();
  if (server) await server.executeCommand("ignore-in-project", [{ typo, config_file_path: path }]);
  else await invoke("toml_edit", { path, edits: [{ path: ["default", "extend-words", typo], value: typo }] });
  // typos-lsp logs a write it couldn't make rather than failing the command, so check that the word is there.
  if (!(await wordsIn(where)).includes(typo)) throw new Error(`${path.split("/").pop()} didn't take the word; check that the file is valid TOML`);
  status(`Saved "${typo}" to the ${where === "user" ? "user" : "project"} dictionary`, "spelling", "info");
  return wordsIn(where);
}

/** Takes a word out of a dictionary, and restarts the spell checker, which reads its files only as it starts. */
async function removeWord(word: string, where: Where) {
  await invoke("toml_edit", { path: await fileOf(where), edits: [{ path: ["default", "extend-words", word], value: null }] });
  await restartSpelling();
  return wordsIn(where);
}

/** Stops checking a file's spelling, through `[files] extend-exclude` in the project's typos configuration. */
async function skipFile(path: string) {
  const root = spellingRoot();
  const config = await projectDictionary(root);
  const current = ((await invoke<{ files?: { "extend-exclude"?: unknown } } | null>("toml_read", { path: config }))?.files?.["extend-exclude"] ?? []) as string[];
  const rel = `/${path.slice(root.length + 1)}`;
  await invoke("toml_edit", { path: config, edits: [{ path: ["files", "extend-exclude"], value: [...new Set([...current, rel])] }] });
  await restartSpelling();
  status(`Spelling isn't checked in ${rel.slice(1)} any more (${config.split("/").pop()})`, "spelling", "info");
}

// ---- Quick fixes on a misspelling (⌥⏎, the light bulb, and the problem hover's Quick Fix) ----

monaco.editor.registerCommand("tusk.spelling", (_, action: "project" | "user" | "skip", arg: string) =>
  (action === "skip" ? skipFile(arg) : addWord(arg, action)).catch((e) => showError(action === "skip" ? "Can't stop checking the file" : `Can't save "${arg}"`, e)),
);

monaco.languages.registerCodeActionProvider("*", {
  provideCodeActions(model, _range, context) {
    const markers = context.markers.filter((m) => m.source === "typos");
    const actions: monaco.languages.CodeAction[] = [];
    const root = spellingRoot();
    for (const m of markers) {
      const word = model.getValueInRange(m).toLowerCase();
      if (!word || actions.some((a) => a.command?.arguments?.[1] === word)) continue;
      const action = (title: string, args: string[]): monaco.languages.CodeAction => ({ title, kind: "quickfix", diagnostics: [m], command: { id: "tusk.spelling", title, arguments: args } });
      if (root) actions.push(action(`Save '${word}' to project dictionary`, ["project", word]));
      actions.push(action(`Save '${word}' to user dictionary`, ["user", word]));
    }
    if (markers.length && root && model.uri.fsPath.startsWith(`${root}/`)) actions.push({ title: "Don't check spelling in this file", kind: "quickfix", diagnostics: markers, command: { id: "tusk.spelling", title: "", arguments: ["skip", model.uri.fsPath] } });
    return { actions, dispose() {} };
  },
}, { providedCodeActionKinds: ["quickfix"] });

// ---- The Spelling part of Settings ----

const LANGUAGE_NAMES: Record<string, string> = { php: "PHP", blade: "Blade", javascript: "JavaScript", typescript: "TypeScript", vue: "Vue", svelte: "Svelte", astro: "Astro", markdown: "Markdown", html: "HTML", css: "CSS", scss: "SCSS", json: "JSON", yaml: "YAML", plaintext: "Plain text" };

registerSettingsSection({
  group: "Spelling",
  keywords: "dictionary words typos file types languages _typos.toml user project",
  shown: () => allSettings.spellCheck,
  async render() {
    const root = spellingRoot();
    const languages = h(
      "div",
      { class: "setting-checks", role: "group", ariaLabel: "File types to check" },
      ...SPELLING_LANGUAGES.map((l) => {
        const box = h("input", { type: "checkbox", checked: !skipped().includes(l) });
        box.onchange = () => updateSetting("spellingSkip", SPELLING_LANGUAGES.filter((x) => (x === l ? !box.checked : skipped().includes(x))).join(","));
        return h("label", {}, box, ` ${LANGUAGE_NAMES[l] ?? l}`);
      }),
    );
    const [user, project] = await Promise.all([wordsIn("user"), root ? wordsIn("project") : Promise.resolve(null)]);
    const projectPath = root ? await projectDictionary(root) : "";
    const projectFile = projectPath.split("/").pop()!;
    const hasFile = !!root && (await invoke<boolean>("path_exists", { path: projectPath }));
    return h(
      "div",
      {},
      h("p", { class: "setting-subhead" }, "File types to check"),
      languages,
      project &&
        h(
          "div",
          {},
          h("p", { class: "setting-subhead" }, `Project dictionary (${projectFile}, shared when you commit it)`),
          listEditor({ label: "the project dictionary", items: project, placeholder: "Add a word", empty: "No words yet.", add: (w) => addWord(w, "project"), remove: (w) => removeWord(w, "project") }),
          hasFile && h("button", { type: "button", class: "setting-open", onclick: () => (document.querySelector<HTMLDialogElement>("#settings")?.close(), openPath(projectPath)) }, `Open ${projectFile}`),
        ),
      h("p", { class: "setting-subhead" }, `User dictionary (every project on ${thisComputer})`),
      listEditor({ label: "your dictionary", items: user, placeholder: "Add a word", empty: "No words yet.", add: (w) => addWord(w, "user"), remove: (w) => removeWord(w, "user") }),
    );
  },
});
