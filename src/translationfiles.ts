// Writes the app's translations through the editor's models, so open lang files and local history stay in step.
// The text edits themselves are src/translations.ts's.
import { invoke } from "@tauri-apps/api/core";
import type { monaco } from "./editor";
import { host } from "./filamentdesigner";
import { applyWorkspaceEdit } from "./lsp";
import { fileFor, renameJsonKey, setJsonKey, setPhpValue, type Translations } from "./translations";

/** Replaces a model's whole text, saving it. */
function replaceAll(model: monaco.editor.ITextModel, text: string) {
  const end = model.getPositionAt(model.getValue().length);
  return applyWorkspaceEdit({ changes: { [model.uri.toString()]: [{ range: { start: { line: 0, character: 0 }, end: { line: end.lineNumber - 1, character: end.column - 1 } }, newText: text }] } });
}

/** Writes a translation, or removes it when `value` is empty, and updates `t` to match. */
export async function writeTranslation(t: Translations, locale: string, key: string, value: string) {
  const where = fileFor(t, locale, key);
  if (where.kind === "php" && value) {
    const model = await host.ensureModel(where.path).catch(() => null);
    const next = model && setPhpValue(model.getValue(), where.inFile, value);
    if (model && next !== null) {
      await replaceAll(model, next);
      (t.php[locale] ??= {})[key] = value;
      return;
    }
  }
  // Not in a PHP file it can edit: the locale's JSON file, which Laravel reads first.
  const path = `${t.dir}/${locale}.json`;
  let model = await host.ensureModel(path).catch(() => null);
  if (!model) {
    if (!value) return;
    await invoke("create_file", { path, contents: "{}\n" });
    model = await host.ensureModel(path);
  }
  await replaceAll(model, setJsonKey(model.getValue(), key, value || null));
  const json = (t.json[locale] ??= {});
  if (value) json[key] = value;
  else delete json[key];
  if (!t.locales.includes(locale)) t.locales.push(locale);
}

/** Renames a key in the locales' JSON files, so a text and its translations change together. */
export async function renameTranslation(t: Translations, from: string, to: string) {
  if (from === to) return;
  for (const locale of Object.keys(t.json)) {
    if (!(from in t.json[locale])) continue;
    const model = await host.ensureModel(`${t.dir}/${locale}.json`).catch(() => null);
    const next = model && renameJsonKey(model.getValue(), from, to);
    if (!model || !next) continue;
    await replaceAll(model, next);
    t.json[locale] = Object.fromEntries(Object.entries(t.json[locale]).map(([k, v]) => [k === from ? to : k, v]));
  }
}
