// Tells comments from code and strings in PHP, JavaScript, CSS, HTML, and Blade. Free of editor imports so
// Node can test it. ponytail: no JavaScript regex literals or template-literal nesting; their text counts as code.

/**
 * `code` is PHP or JavaScript, `text` is HTML or Blade outside PHP tags (where quotes are just text), and
 * `heredoc` is a PHP heredoc or nowdoc, which ends at a line holding its identifier.
 */
type State = "code" | "text" | "heredoc" | "line" | "block" | "html" | "blade" | "'" | '"' | "`";

/** Where each comment kind ends. */
const CLOSERS: Partial<Record<State, string>> = { block: "*/", html: "-->", blade: "--}}" };
const isComment = (state: State) => state === "line" || state in CLOSERS;

/**
 * Walks `text`, calling `visit` with each character's offset and whether it's inside a comment
 * (including the comment's own markers). Returns the state at the end.
 */
function scan(text: string, visit?: (i: number, comment: boolean) => void, state: State = "code"): State {
  let heredocEnd: RegExp | null = null;
  // A comment that ended in text, such as <!-- --> before <?php, returns to text rather than to code.
  let outside: State = state === "text" ? "text" : "code";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const start = state;
    let width = 1;
    if (state === "code") {
      const rest = text.slice(i, i + 4);
      if (rest.startsWith("//")) state = "line";
      // `#` starts a PHP or YAML comment first on a line or before a space, so a CSS color or id (`#fff`) and
      // `#[Attribute]` don't.
      else if (c === "#" && (/\s/.test(text[i + 1] ?? "\n") || /(^|\n)[ \t]*$/.test(text.slice(Math.max(0, i - 200), i))) && text[i + 1] !== "[") state = "line";
      else if (rest.startsWith("/*")) (state = "block"), (width = 2);
      else if (rest === "<!--") (state = "html"), (width = 4);
      else if (rest === "{{--") (state = "blade"), (width = 4);
      else if (rest.startsWith("?>")) (state = outside = "text"), (width = 2);
      else if (rest.startsWith("<<<")) {
        const opener = text.slice(i, i + 200).match(/^<<<[ \t]*(["']?)([A-Za-z_]\w*)\1/);
        if (opener) (heredocEnd = new RegExp(`^[ \\t]*${opener[2]}(?!\\w)`)), (state = "heredoc"), (width = opener[0].length);
      } else if (c === "'" || c === '"' || c === "`") state = c;
    } else if (state === "text") {
      const rest = text.slice(i, i + 5);
      if (rest.startsWith("<!--")) (state = "html"), (width = 4);
      else if (rest.startsWith("{{--")) (state = "blade"), (width = 4);
      else if (rest.startsWith("<?")) (state = outside = "code"), (width = rest === "<?php" ? 5 : 2);
    } else if (state === "heredoc") {
      const closing = c === "\n" && text.slice(i + 1, i + 200).match(heredocEnd!);
      if (closing) (state = "code"), (width = 1 + closing[0].length);
    } else if (state === "line") {
      // A PHP line comment also ends at ?>, which closes the PHP tag.
      if (c === "\n") state = outside;
      else if (text.startsWith("?>", i)) (state = outside = "text"), (width = 2);
    } else if (state in CLOSERS) {
      const closer = CLOSERS[state]!;
      if (text.startsWith(closer, i)) (width = closer.length), (state = outside);
    } else if (c === "\\") width = 2; // An escaped character inside a string.
    else if (c === state) state = "code";
    // A comment's opening and closing markers belong to it too.
    const comment = isComment(start) || isComment(state);
    for (let j = i; j < Math.min(i + width, text.length); j++) visit?.(j, comment && text[j] !== "\n");
    i += width - 1;
  }
  return state;
}

/**
 * `source` with every comment replaced by spaces, keeping offsets and line breaks, so patterns only see code and
 * strings. A file that starts with `<?` (PHP), or `markup` (HTML, Blade), starts outside code, as text.
 */
export function commentMask(source: string, markup = false): string {
  const out = source.split("");
  scan(source, (i, comment) => comment && (out[i] = " "), markup || source.startsWith("<?") ? "text" : "code");
  return out.join("");
}

/**
 * Whether 1-based `column` of a line is inside a comment, judging by that line alone: after `//`, `#`,
 * or an unclosed `/*`, `<!--`, or `{{--`, or on a line of a block comment that starts with `*`.
 */
export function inComment(line: string, column: number): boolean {
  const before = line.slice(0, column - 1);
  if (/^\s*\*/.test(before)) return true;
  return isComment(scan(before));
}

/** The line's ` *   ` prefix, when it's a docblock line under another one, else null. */
export function docblockPrefix(line: string, previous: string): string | null {
  if (!/^\s*(\/\*\*|\*(?!\/))/.test(previous)) return null;
  return line.match(/^\s*\*(?!\/)\s*/)?.[0] ?? null;
}

/** Spaces that Tab inserts at `column` (0-based) on a line whose docblock text starts at `start`. */
export function tabSpaces(column: number, start: number, tabSize: number): number {
  return tabSize - ((column - start) % tabSize);
}
