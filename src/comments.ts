// Tells comments from code and strings in PHP, JavaScript, CSS, HTML, and Blade. Free of editor imports so
// Node can test it. ponytail: no heredocs, nowdocs, or regex literals; text in them counts as code.

type State = "code" | "line" | "block" | "html" | "blade" | "'" | '"' | "`";

/** Where each comment kind ends. */
const CLOSERS: Partial<Record<State, string>> = { block: "*/", html: "-->", blade: "--}}" };
const isComment = (state: State) => state === "line" || state in CLOSERS;

/**
 * Walks `text`, calling `visit` with each character's offset and whether it's inside a comment
 * (including the comment's own markers). Returns the state at the end.
 */
function scan(text: string, visit?: (i: number, comment: boolean) => void, state: State = "code"): State {
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
      else if (c === "'" || c === '"' || c === "`") state = c;
    } else if (state === "line") {
      if (c === "\n") state = "code";
    } else if (state in CLOSERS) {
      const closer = CLOSERS[state]!;
      if (text.startsWith(closer, i)) (width = closer.length), (state = "code");
    } else if (c === "\\") width = 2; // An escaped character inside a string.
    else if (c === state) state = "code";
    // A comment's opening and closing markers belong to it too.
    const comment = isComment(start) || isComment(state);
    for (let j = i; j < Math.min(i + width, text.length); j++) visit?.(j, comment && text[j] !== "\n");
    i += width - 1;
  }
  return state;
}

/** `source` with every comment replaced by spaces, keeping offsets and line breaks, so patterns only see code and strings. */
export function commentMask(source: string): string {
  const out = source.split("");
  scan(source, (i, comment) => comment && (out[i] = " "));
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
