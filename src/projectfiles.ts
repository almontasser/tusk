// Reads and writes project files in the charset .editorconfig gives them. Every read or write of a project file's
// text goes through here, so a Latin-1 or UTF-16 file keeps its encoding whichever feature saves it.
import { invoke } from "@tauri-apps/api/core";
import { type Properties, propertiesFor } from "./editorconfig";

let root = () => "";
export const initProjectFiles = (projectRoot: () => string) => (root = projectRoot);

const configs = new Map<string, Promise<string | null>>(); // folder → its .editorconfig, or null
/** Forgets the .editorconfig files read so far, after one changes. */
export const forgetEditorConfigs = () => configs.clear();

/** The .editorconfig properties for a project file, from the project root down to its folder. */
export async function editorConfigFor(path: string): Promise<Properties> {
  const top = root();
  if (!top || !path.startsWith(top + "/")) return {};
  const dirs = [top];
  for (const part of path.slice(top.length + 1, path.lastIndexOf("/")).split("/").filter(Boolean)) dirs.push(`${dirs.at(-1)}/${part}`);
  const found = [];
  for (const dir of dirs) {
    if (!configs.has(dir)) configs.set(dir, invoke<string>("read_file", { path: `${dir}/.editorconfig` }).catch(() => null));
    const text = await configs.get(dir)!;
    if (text !== null) found.push({ dir, text });
  }
  return propertiesFor(path, found);
}

/** `.editorconfig` charsets that `read_file` and `write_file` understand, with their status bar names. */
export const CHARSETS: Record<string, string> = { "utf-8": "UTF-8", "utf-8-bom": "UTF-8 BOM", latin1: "ISO-8859-1", "utf-16le": "UTF-16LE", "utf-16be": "UTF-16BE" };

export async function charsetOf(path: string) {
  const charset = (await editorConfigFor(path)).charset;
  return charset in CHARSETS ? charset : undefined;
}

export const readText = async (path: string) => invoke<string>("read_file", { path, charset: await charsetOf(path) });
export const writeText = async (path: string, contents: string) => invoke<void>("write_file", { path, contents, charset: await charsetOf(path) });
