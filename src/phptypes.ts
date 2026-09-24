// Reads a PHP file's class declaration: its full name, and the full names of its parents and
// interfaces. Free of editor imports so Node can test it.

export type TypeDeclaration = {
  fqn: string;
  kind: "class" | "interface" | "trait" | "enum";
  /** Offset of the type's name in the source, for requests that need a position. */
  offset: number;
  extends: string[];
  implements: string[];
};

// ponytail: regexes over the source; grouped use statements (use A\{B, C}) aren't resolved.
export function parseTypeDeclaration(source: string): TypeDeclaration | null {
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|#(?!\[)[^\n]*/g, (m) => " ".repeat(m.length));
  const namespace = code.match(/^\s*namespace\s+([\w\\]+)\s*;/m)?.[1] ?? "";
  const aliases = new Map<string, string>();
  for (const [, name, alias] of code.matchAll(/^\s*use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm)) aliases.set(alias ?? name.split("\\").pop()!, name);
  const resolve = (name: string) => {
    if (name.startsWith("\\")) return name.slice(1);
    const [first, ...rest] = name.split("\\");
    if (aliases.has(first)) return [aliases.get(first)!, ...rest].join("\\");
    return namespace ? `${namespace}\\${name}` : name;
  };
  const m = code.match(/(?:^|[\s;}])((?:(?:abstract|final|readonly)\s+)*)(class|interface|trait|enum)\s+(\w+)([^{]*)\{/);
  if (!m) return null;
  const header = m[4];
  const list = (keyword: string) =>
    (header.match(new RegExp(`\\b${keyword}\\s+([\\w\\\\\\s,]+?)(?=\\bimplements\\b|$)`))?.[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(resolve);
  return {
    fqn: namespace ? `${namespace}\\${m[3]}` : m[3],
    kind: m[2] as TypeDeclaration["kind"],
    // The name ends where the header (extends and implements) starts, just before the "{".
    offset: m.index! + m[0].length - 1 - header.length - m[3].length,
    extends: list("extends"),
    implements: list("implements"),
  };
}

/**
 * The 1-based lines to remove when deleting a declaration that spans `start`..`end`: its docblock and
 * attributes above it, and one blank line, so the code around it keeps its spacing.
 */
export function deletionLines(lines: string[], start: number, end: number): [number, number] {
  let first = start;
  // Attributes (#[...]) and a docblock directly above. lines[first - 2] is the line above `first`.
  for (;;) {
    const above = lines[first - 2]?.trim() ?? "";
    if (above.startsWith("#[")) {
      first--;
      continue;
    }
    if (!above.endsWith("*/")) break;
    let opening = first - 2;
    while (opening >= 0 && !lines[opening].trim().startsWith("/**")) opening--;
    if (opening < 0) break;
    first = opening + 1;
  }
  let last = end;
  if (lines[last]?.trim() === "") last++;
  else if (lines[first - 2]?.trim() === "") first--;
  return [first, last];
}

const snake = (s: string) => s.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();

/**
 * The names code may use for a method: its own, and the ones Laravel derives from it. A scope
 * scopePublished is called as published(), and an accessor getFullNameAttribute or fullName(): Attribute
 * is read as full_name.
 */
export function laravelNames(method: string): string[] {
  const names = new Set([method]);
  const scope = method.match(/^scope([A-Z]\w*)$/)?.[1];
  if (scope) names.add(scope[0].toLowerCase() + scope.slice(1));
  const accessor = method.match(/^[gs]et([A-Z]\w*)Attribute$/)?.[1];
  if (accessor) names.add(snake(accessor));
  if (/[a-z][A-Z]/.test(method) && !scope && !accessor) names.add(snake(method));
  return [...names];
}
