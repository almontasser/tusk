import { isAbsolute } from "./platform.ts";
// Bookmarks' pure parts: reading saved ones and reordering them. Free of editor imports so Node can test it.

/** A bookmarked line. `mnemonic` is a digit or letter, `description` what you wrote about it. */
export type Bookmark = { path: string; line: number; mnemonic?: string; description?: string };

/** The characters a bookmark's mnemonic can be, in PhpStorm's order. */
export const MNEMONICS = [..."1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/**
 * Bookmarks from the project's state, with paths made absolute: anything that isn't a bookmark is dropped, and so
 * is a second bookmark on a line or a mnemonic used twice. Each file's bookmarks come together.
 */
export function parseBookmarks(saved: unknown, root: string): Bookmark[] {
  if (!Array.isArray(saved)) return [];
  const seen = new Set<string>();
  const used = new Set<string>();
  const out: Bookmark[] = [];
  for (const b of saved) {
    if (!b || typeof b.path !== "string" || !Number.isInteger(b.line) || b.line < 1) continue;
    const path = isAbsolute(b.path) ? b.path : `${root}/${b.path}`;
    if (seen.has(`${path}:${b.line}`)) continue;
    seen.add(`${path}:${b.line}`);
    const mnemonic = typeof b.mnemonic === "string" && MNEMONICS.includes(b.mnemonic) && !used.has(b.mnemonic) ? b.mnemonic : undefined;
    if (mnemonic) used.add(mnemonic);
    const description = typeof b.description === "string" && b.description.trim() ? b.description.trim() : undefined;
    out.push({ path, line: b.line, ...(mnemonic ? { mnemonic } : {}), ...(description ? { description } : {}) });
  }
  // Each file's bookmarks together, in the order the files first appear.
  return [...new Set(out.map((b) => b.path))].flatMap((path) => out.filter((b) => b.path === path));
}

/** Moves the bookmark at `from` before or after the one at `to`. */
export function moveBookmark(list: Bookmark[], from: number, to: number, after: boolean): Bookmark[] {
  if (from < 0 || to < 0 || from === to) return list;
  const out = [...list];
  const [moved] = out.splice(from, 1);
  const target = out.indexOf(list[to]);
  out.splice(target + (after ? 1 : 0), 0, moved);
  return out;
}

/** Moves a file's bookmarks, as a group, before or after another file's. */
export function moveFile(list: Bookmark[], from: string, to: string, after: boolean): Bookmark[] {
  if (from === to) return list;
  const moving = list.filter((b) => b.path === from);
  const rest = list.filter((b) => b.path !== from);
  const first = rest.findIndex((b) => b.path === to);
  const at = after ? first + rest.filter((b) => b.path === to).length : first;
  if (first < 0) return list;
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}
