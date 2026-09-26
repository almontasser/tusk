// Reads and writes project files in the charset .editorconfig gives them. Every read or write of a project file's
// text goes through here, so a Latin-1 or UTF-16 file keeps its encoding whichever feature saves it.
import { invoke } from "@tauri-apps/api/core";
import { isCrOnly, type Properties, propertiesFor, toCr } from "./editorconfig";

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

/**
 * `.editorconfig` charsets that `read_file` and `write_file` understand, with their status bar names. They also
 * take encoding names, such as `windows-1252`.
 */
export const CHARSETS: Record<string, string> = { "utf-8": "UTF-8", "utf-8-bom": "UTF-8 BOM", latin1: "ISO-8859-1", "utf-16le": "UTF-16LE", "utf-16be": "UTF-16BE" };

/** Encodings you picked with Change Encoding, and ones detected in files that aren't UTF-8, by path. */
const chosen = new Map<string, string>();
const detected = new Map<string, string>();

/** The encoding a file is read in: the one you picked, or `.editorconfig`'s charset. */
const given = (path: string, props: Properties) => chosen.get(path) ?? (props.charset in CHARSETS ? props.charset : undefined);

/** The encoding a file is saved in: as it was read, or else UTF-8 (undefined). */
export const charsetOf = (path: string, props: Properties) => given(path, props) ?? detected.get(path);

/** The encoding's name for the status bar. */
export const charsetName = (path: string, props: Properties) => {
  const charset = charsetOf(path, props);
  return charset ? (CHARSETS[charset] ?? charset) : "UTF-8";
};

/** Reads and saves a file in `charset` from now on, or as before for undefined. */
export const setCharset = (path: string, charset: string | undefined) => (charset ? chosen.set(path, charset) : chosen.delete(path));

/** Files read with old Mac line endings, CR alone, which they keep when saved. */
const crFiles = new Set<string>();

/** Whether a file is saved with CR line endings: `end_of_line = cr`, or else its own. */
export const savesCr = (path: string, props: Properties) => props.end_of_line === "cr" || (!props.end_of_line && crFiles.has(path));

/**
 * A file's text. Without a given encoding, a file that isn't UTF-8 reads in the one it most likely has, which
 * `writeText` keeps. Monaco has no CR-only lines, so they read as LF, and `writeText` turns them back.
 */
export async function readText(path: string) {
  const read = await invoke<{ text: string; charset: string | null }>("read_text", { path, charset: given(path, await editorConfigFor(path)) });
  if (read.charset) detected.set(path, read.charset);
  else detected.delete(path);
  if (!isCrOnly(read.text)) return crFiles.delete(path), read.text;
  crFiles.add(path);
  return read.text.replace(/\r/g, "\n");
}

export async function writeText(path: string, contents: string) {
  const props = await editorConfigFor(path);
  return invoke<void>("write_file", { path, contents: savesCr(path, props) ? toCr(contents) : contents, charset: charsetOf(path, props) });
}
