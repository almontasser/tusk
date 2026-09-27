// Folders the PHP index and Mago skip, per project: vendor data that declares no symbols, such as AWS's API
// arrays and packages' translations. The list is the project's `tusk.json` `indexExclude` when it has one,
// so a team can share it; otherwise it's kept in the editor, and a project that never set it gets the defaults.
import { invoke } from "@tauri-apps/api/core";

/** Folder patterns relative to the project; `*` matches within a folder name, `**` any number of folders. */
export const DEFAULT_EXCLUDES = [
  "vendor/aws/aws-sdk-php/src/data",
  "vendor/nesbot/carbon/src/Carbon/Lang",
  "vendor/voku/portable-ascii/src/voku/helper/data",
  "vendor/**/resources/lang",
  "vendor/**/resources/views",
];


/** Mago's `excludes` for the list. Mago matches a glob against file paths, so a folder glob needs `/**`. */
export const magoExcludes = (list: string[]) => list.map((p) => (p.includes("*") ? `${p}/**` : p));

/** Whether a folder, relative to the project, is inside one the list excludes. */
export function covers(list: string[], rel: string) {
  return list.some((p) => {
    const re = p
      .split("/")
      .map((part) => (part === "**" ? "\0" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")))
      .join("/")
      .replace(/\0\//g, "(?:[^/]+/)*")
      .replace(/\/\0$/, "(?:/[^/]+)*");
    return new RegExp(`^${re}(?:/.*)?$`).test(rel);
  });
}

/** The `indexExclude` list in a `tusk.json` text, or undefined when there's none. */
export function sharedList(json: string): string[] | undefined {
  try {
    const list = JSON.parse(json)?.indexExclude;
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `tusk.json`'s text with `indexExclude` set, or removed when `list` is undefined, keeping its other keys. "" when
 * nothing's left. Throws when the file isn't a JSON object, rather than overwrite what someone wrote there.
 */
export function withSharedList(json: string, list: string[] | undefined): string {
  let settings: Record<string, unknown> = {};
  if (json.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {}
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("tusk.json isn't a JSON object");
    settings = parsed as Record<string, unknown>;
  }
  if (list) settings.indexExclude = list;
  else delete settings.indexExclude;
  return Object.keys(settings).length ? `${JSON.stringify(settings, null, 2)}\n` : "";
}

const storageKey = (root: string) => `indexExclude:${root}`;
const readTusk = (root: string) => invoke<string>("read_file", { path: `${root}/tusk.json` }).catch(() => "");

/** The project's list, whether it's shared in `tusk.json`, and whether anyone ever set it. */
export async function exclusionsFor(root: string): Promise<{ list: string[]; shared: boolean; set: boolean }> {
  const shared = sharedList(await readTusk(root));
  if (shared) return { list: shared, shared: true, set: true };
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(storageKey(root));
  } catch {}
  return { list: stored === null ? DEFAULT_EXCLUDES : sharedList(stored) ?? DEFAULT_EXCLUDES, shared: false, set: stored !== null };
}

/** Saves the list to `tusk.json` when `shared`, otherwise in the editor, and removes it from the other place. */
export async function saveExclusions(root: string, list: string[], shared: boolean) {
  const path = `${root}/tusk.json`;
  const before = await readTusk(root);
  const after = withSharedList(before, shared ? list : undefined);
  if (after !== before) await (after ? invoke("write_file", { path, contents: after }) : invoke("remove_path", { path }));
  try {
    if (shared) localStorage.removeItem(storageKey(root));
    else localStorage.setItem(storageKey(root), JSON.stringify({ indexExclude: list }));
  } catch {}
}
