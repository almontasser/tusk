// A terminal's earlier output as text, saved with the session. Free of editor imports so Node can test it.

/** The part of an xterm.js buffer this reads. */
type Buffer = { length: number; getLine(i: number): { isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined };

/** Characters kept per terminal: about 1,000 lines of 50 characters. */
const MAX_CHARS = 50_000;

/**
 * The buffer's text, one line per line of output (lines the terminal wrapped are joined, so they wrap again at the new
 * width), without trailing blank lines, and cut to the last `max` characters at a line start (or
 * mid-line, when the last line alone is longer). Colors aren't kept.
 */
export function scrollbackText(buffer: Buffer, max = MAX_CHARS): string {
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(false);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  const text = lines.map((l) => l.trimEnd()).join("\n").trimEnd();
  if (text.length <= max) return text;
  const start = text.indexOf("\n", text.length - max - 1);
  return start < 0 ? text.slice(-max) : text.slice(start + 1);
}
