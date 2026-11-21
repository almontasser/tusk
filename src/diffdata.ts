// Diff viewing: the pure parts of image diffs, line mapping, and "since your review", kept apart for tests.
import type { Block } from "./gitparse.ts";

const imageTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp" };

/** The image's MIME type, from its extension, or "" when the file isn't an image the diff shows as one. */
export const imageType = (path: string) => imageTypes[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "";

/**
 * Where line `line` of the old text is in the new one, given `lineChanges(old, new)`'s blocks. Lines after a
 * change move by its size. A line inside a changed block maps into the block's new lines, so a comment stays on
 * the line you just fixed; a line that was only deleted maps to null.
 */
export function mapLine(blocks: Block[], line: number): number | null {
  let shift = 0;
  for (const b of blocks) {
    const removed = b.originalEndLineNumber ? b.originalEndLineNumber - b.originalStartLineNumber + 1 : 0;
    const added = b.modifiedEndLineNumber ? b.modifiedEndLineNumber - b.modifiedStartLineNumber + 1 : 0;
    if (removed && line >= b.originalStartLineNumber && line <= b.originalEndLineNumber)
      return added ? b.modifiedStartLineNumber + Math.min(line - b.originalStartLineNumber, added - 1) : null;
    // A block with no old lines is an insertion after its originalStartLineNumber.
    const last = removed ? b.originalEndLineNumber : b.originalStartLineNumber;
    if (last >= line) break;
    shift += added - removed;
  }
  return line + shift;
}

/** `git merge-tree --write-tree --name-only`: the tree it wrote, and the files that conflicted. */
export function parseMergeTree(out: string): { tree: string; conflicts: string[] } {
  const [tree, ...rest] = out.split("\n");
  const end = rest.indexOf("");
  return { tree: tree.trim(), conflicts: end < 0 ? rest : rest.slice(0, end) };
}

/** `git diff --numstat -z --no-renames`: each file's path and its added and deleted lines (0 for binary files). */
export function parseNumstat(out: string): { path: string; additions: number; deletions: number }[] {
  return out
    .split("\0")
    .filter(Boolean)
    .map((l) => {
      const [a, d, ...path] = l.split("\t");
      return { path: path.join("\t"), additions: Number(a) || 0, deletions: Number(d) || 0 };
    });
}
