// Reads a PHP file's type declarations: their full names, and the full names of their parents, interfaces,
// and traits. Free of editor imports so Node can test it.

export type TypeDeclaration = {
  fqn: string;
  kind: "class" | "interface" | "trait" | "enum";
  /** Offset of the type's name in the source, for requests that need a position. */
  offset: number;
  extends: string[];
  implements: string[];
  /** Traits the type uses. */
  uses: string[];
};

// ponytail: regexes over the source; grouped use statements (use A\{B, C}) aren't resolved.
/** The source with comments blanked out, keeping offsets. */
export const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|#(?!\[)[^\n]*/g, (m) => " ".repeat(m.length));

/** The file's namespace, and a function that turns a class name used in it into a full name, through its use statements. */
export function nameResolver(code: string) {
  const namespace = code.match(/^\s*namespace\s+([\w\\]+)\s*;/m)?.[1] ?? "";
  const aliases = new Map<string, string>();
  // Imports start at the line's start; indented "use X;" lines in a class body are trait uses.
  for (const [, name, alias] of code.matchAll(/^use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm)) aliases.set(alias ?? name.split("\\").pop()!, name);
  const resolve = (name: string) => {
    if (name.startsWith("\\")) return name.slice(1);
    const [first, ...rest] = name.split("\\");
    if (aliases.has(first)) return [aliases.get(first)!, ...rest].join("\\");
    return namespace ? `${namespace}\\${name}` : name;
  };
  return { namespace, resolve };
}

export function parseTypeDeclarations(source: string): TypeDeclaration[] {
  const code = withoutComments(source);
  const { namespace, resolve } = nameResolver(code);
  const names = (text: string) => text.split(",").map((s) => s.trim()).filter(Boolean).map(resolve);
  // Anonymous classes (new class extends X) have no name of their own.
  const found = [...code.matchAll(/(?:^|[\s;}])((?:(?:abstract|final|readonly)\s+)*)(class|interface|trait|enum)\s+(\w+)([^{]*)\{/g)].filter(
    (m) => !["extends", "implements"].includes(m[3]),
  );
  return found.map((m, i) => {
    const header = m[4];
    const list = (keyword: string) => names(header.match(new RegExp(`\\b${keyword}\\s+([\\w\\\\\\s,]+?)(?=\\bimplements\\b|$)`))?.[1] ?? "");
    // The body runs until the next declaration; trait uses sit at its top level, as "use A, B;" or "use A { ... }".
    const body = code.slice(m.index! + m[0].length, found[i + 1]?.index ?? code.length);
    return {
      fqn: namespace ? `${namespace}\\${m[3]}` : m[3],
      kind: m[2] as TypeDeclaration["kind"],
      // The name ends where the header (extends and implements) starts, just before the "{".
      offset: m.index! + m[0].length - 1 - header.length - m[3].length,
      extends: list("extends"),
      implements: list("implements"),
      uses: [...body.matchAll(/^\s*use\s+([\w\\][\w\\\s,]*?)\s*[;{]/gm)].flatMap((u) => names(u[1])),
    };
  });
}

/** The first type a file declares. */
export const parseTypeDeclaration = (source: string): TypeDeclaration | null => parseTypeDeclarations(source)[0] ?? null;

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

/**
 * Where Laravel looks for a class-based Blade component: <x-forms.input-text> is
 * app/View/Components/Forms/InputText.php. Package components (x-package::name) have no such path.
 */
export function componentClassPath(tag: string): string | null {
  const name = tag.replace(/^x-/, "");
  if (!name || name.includes("::")) return null;
  const studly = (s: string) => s.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  return `app/View/Components/${name.split(".").map(studly).join("/")}.php`;
}

/**
 * The class and method an `artisan route:list --json` action names, such as `App\Http\Controllers\PostController@index`.
 * An invokable controller has no method, so it's `__invoke`. Closures and views have no class: null.
 */
export function routeTarget(action: string): { fqn: string; method: string } | null {
  const [fqn, method = "__invoke"] = action.split("@");
  return /^\\?[A-Za-z_]\w*(\\[A-Za-z_]\w*)+$/.test(fqn) ? { fqn: fqn.replace(/^\\/, ""), method } : null;
}

/** The 1-based line that declares `method` in PHP source, or 0 when there's none. */
export const methodLine = (source: string, method: string) =>
  source.split("\n").findIndex((l) => new RegExp(`\\bfunction\\s+&?${method}\\s*\\(`, "i").test(l)) + 1;
