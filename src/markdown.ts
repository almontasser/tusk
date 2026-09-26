// The Markdown preview's rendering and scroll math, apart from the page so tests can run them.
import { marked } from "marked";

/**
 * Markdown as HTML, not yet sanitized, with each top-level block in a `<div data-line>` holding its first line
 * (from 0), so the preview can scroll to where the editor is.
 */
export function markdownBlocks(text: string): string {
  const tokens = marked.lexer(text, { gfm: true });
  let line = 0;
  return tokens
    .map((t) => {
      const start = line;
      line += t.raw.split("\n").length - 1;
      if (t.type === "space" || t.type === "def") return "";
      // Link definitions such as `[x]: https://…` apply across blocks, so each block gets the whole document's.
      return `<div data-line="${start}">${marked.parser(Object.assign([t], { links: tokens.links }), { gfm: true })}</div>`;
    })
    .join("");
}

/**
 * The preview's scroll position for an editor whose top visible line is `line` (from 0): between the tops of the
 * blocks around that line, in proportion. `blocks` are in order and end with one for the end of the document.
 */
export function previewScrollTop(blocks: { line: number; top: number }[], line: number): number {
  let i = blocks.length - 1;
  while (i > 0 && blocks[i].line > line) i--;
  const a = blocks[i], b = blocks[i + 1];
  if (!a || a.line > line) return 0;
  if (!b || b.line === a.line) return a.top;
  return a.top + ((b.top - a.top) * (line - a.line)) / (b.line - a.line);
}
