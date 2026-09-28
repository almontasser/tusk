// Replace in Files' pure part: applying the matches you kept in the preview to a file's text. Free of editor imports
// so Node can test it.

/** One replacement: on `line` (1-based), columns `column` to `end` (1-based, UTF-16, end exclusive) become `text`. */
export type Replacement = { line: number; column: number; end: number; text: string; /** The line as the search saw it, trimmed at the end. */ lineText: string };

/**
 * Applies replacements to a file's text. A line that no longer reads as the search saw it is left alone, and its
 * replacements count as stale, so a file that changed since the search isn't corrupted.
 */
export function applyReplacements(text: string, replacements: Replacement[]): { text: string; applied: number; stale: number } {
  const lines = text.split("\n");
  const byLine = new Map<number, Replacement[]>();
  for (const r of replacements) byLine.set(r.line, [...(byLine.get(r.line) ?? []), r]);
  let applied = 0;
  let stale = 0;
  for (const [line, list] of byLine) {
    const current = lines[line - 1];
    if (current === undefined || current.trimEnd() !== list[0].lineText) {
      stale += list.length;
      continue;
    }
    // From the end of the line, so earlier columns stay valid.
    let next = current;
    for (const r of [...list].sort((a, b) => b.column - a.column)) next = next.slice(0, r.column - 1) + r.text + next.slice(r.end - 1);
    lines[line - 1] = next;
    applied += list.length;
  }
  return { text: lines.join("\n"), applied, stale };
}
