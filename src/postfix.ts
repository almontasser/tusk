// PhpStorm's postfix completion for PHP: `$user.if` becomes `if ($user) {}`. Free of editor imports so Node can
// test it; src/snippets.ts offers the templates in the editor.

/** Template keys and their snippet bodies, where `EXPR` stands for the expression before the dot. */
export const POSTFIX_TEMPLATES: Record<string, { body: string; description: string }> = {
  if: { body: "if (EXPR) {\n\t$0\n}", description: "if (expr) {}" },
  not: { body: "!EXPR", description: "!expr" },
  notnull: { body: "if (EXPR !== null) {\n\t$0\n}", description: "if (expr !== null) {}" },
  null: { body: "if (EXPR === null) {\n\t$0\n}", description: "if (expr === null) {}" },
  isset: { body: "if (isset(EXPR)) {\n\t$0\n}", description: "if (isset(expr)) {}" },
  foreach: { body: "foreach (EXPR as ${1:\\$item}) {\n\t$0\n}", description: "foreach (expr as $item) {}" },
  return: { body: "return EXPR;", description: "return expr;" },
  var: { body: "\\$${1:var} = EXPR;", description: "$var = expr;" },
  throw: { body: "throw EXPR;", description: "throw expr;" },
  dd: { body: "dd(EXPR);", description: "dd(expr);" },
  dump: { body: "dump(EXPR);", description: "dump(expr);" },
  par: { body: "(EXPR)", description: "(expr)" },
};

/**
 * The 0-based column where the PHP expression ending just before `dot` starts, or -1 when there's none. An
 * expression is a variable, a name, or a call, with any `->`, `?->`, and `::` chain, array access, and
 * parenthesized groups: `$this->posts()->first()['id']` or `Post::query()`. A bare word, such as `foo.`, isn't
 * one, since in text it's more likely a sentence or a number. ponytail: brackets are matched without skipping
 * strings, so a `)` inside a string argument cuts the expression short.
 */
export function postfixStart(line: string, dot: number): number {
  let i = dot;
  let bare = true;
  for (;;) {
    while (line[i - 1] === ")" || line[i - 1] === "]") {
      const close = line[i - 1];
      const open = close === ")" ? "(" : "[";
      let depth = 0;
      for (i--; i >= 0; i--) {
        if (line[i] === close) depth++;
        else if (line[i] === open && --depth === 0) break;
      }
      if (i < 0) return -1;
      bare = false;
    }
    const name = line.slice(0, i).match(/\$?[A-Za-z_\\][\w\\]*$/)?.[0] ?? "";
    if (name.startsWith("$")) bare = false;
    i -= name.length;
    const link = line.slice(0, i).match(/(\?->|->|::)$/)?.[0];
    if (!link || i === dot) break;
    i -= link.length;
    bare = false;
  }
  return i === dot || bare ? -1 : i;
}

/** Escapes text for a snippet body, where `$`, `}`, and `\` are special. */
export const snippetText = (text: string) => text.replace(/[$}\\]/g, "\\$&");
