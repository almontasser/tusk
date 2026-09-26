// Reads a PHP file's type declarations: their full names, and the full names of their parents, interfaces,
// and traits. Free of editor imports so Node can test it.
import { commentMask } from "./comments.ts";
import { matchBracket } from "./refactorparse.ts";

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
  const code = commentMask(source);
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

/**
 * Whether the docblock of the function declared around `at` (such as a parameter's position) has `@param … $name`.
 * The docblock is the `/** … *\/` right before the declaration, with only modifiers and attributes between.
 */
export function docblockHasParam(source: string, at: number, name: string): boolean {
  return new RegExp(`@param\\b[^\\n]*\\$${name}\\b`).test(docblockAt(source, at));
}

/** Whether the docblock of the function declared around `at` has a `@return` tag. */
export const docblockHasReturn = (source: string, at: number) => /@return\b/.test(docblockAt(source, at));

/** The docblock of the function declared around `at`: the `/** … *\/` right before it, with only modifiers and attributes between. */
function docblockAt(source: string, at: number): string {
  const fn = source.lastIndexOf("function", at);
  const end = source.lastIndexOf("*/", fn);
  const start = source.lastIndexOf("/**", end);
  if (fn < 0 || end < 0 || start < 0 || !/^[\s\w#[\]()'",:=\\]*$/.test(source.slice(end + 2, fn))) return "";
  return source.slice(start, end);
}

/**
 * Phpactor's hover Markdown, easier to read: in each PHP code block, a `// @deprecated …` comment becomes a line
 * above the block, and a function signature longer than 80 characters gets one parameter per line.
 */
export function formatHoverMarkdown(markdown: string): string {
  return markdown.replace(/```php\n([\s\S]*?)```/g, (_, code: string) => {
    let note = "";
    const body = code
      .replace(/^<\?php\s*/, "")
      .replace(/^\/\/\s*@deprecated\b\s*(.*)\n/, (_: string, why: string) => ((note = `**Deprecated**${why ? `: ${why}` : ""}\n\n`), ""))
      .replace(/^\s*⚠\s*/, "")
      .split("\n")
      .map((line) => (line.length > 80 ? oneParameterPerLine(line) : line))
      .join("\n")
      .trimEnd();
    return `${note}\`\`\`php\n<?php\n${body}\n\`\`\``;
  });
}

/** A signature line with each parameter of its first parameter list on a line of its own. */
function oneParameterPerLine(line: string): string {
  const open = line.search(/\bfunction\s+&?\w+\s*\(/) >= 0 ? line.indexOf("(", line.search(/\bfunction\b/)) : -1;
  if (open < 0) return line;
  const params: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < line.length; i++) {
    const c = line[i];
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c) && line[i - 1] !== "=") depth--;
    if ((c === "," && depth === 1) || depth === 0) {
      params.push(line.slice(start, i).trim());
      start = i + 1;
      if (depth === 0) {
        const indent = line.match(/^\s*/)![0];
        return `${line.slice(0, open + 1)}\n${params.filter(Boolean).map((p) => `${indent}    ${p},`).join("\n")}\n${indent}${line.slice(i)}`;
      }
    }
  }
  return line;
}

/** The text between the bracket at `open` and its match, skipping brackets in strings and comments. */
function bracketed(source: string, open: number): string {
  const pairs: Record<string, string> = { "[": "]", "(": ")", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "'" || c === '"') {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === "\\") i++;
    } else if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
    }
    else if (c === "/" && source[i + 1] === "*") i = source.indexOf("*/", i) + 1 || source.length;
    else if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack.at(-1) && stack.pop() !== undefined && !stack.length) return source.slice(open + 1, i);
  }
  return source.slice(open + 1);
}

/** Splits array or argument text at its top-level commas. */
function topLevel(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') for (i++; i < text.length && text[i] !== c; i++) text[i] === "\\" && i++;
    else if ("[({".includes(c)) depth++;
    else if ("])}".includes(c)) depth--;
    else if (c === "," && !depth) items.push(text.slice(start, i)), (start = i + 1);
  }
  items.push(text.slice(start));
  return items.map((s) => s.trim()).filter(Boolean);
}

/** The body of `method` in PHP source, or "" when it isn't declared. */
export function methodBody(source: string, method: string): string {
  const m = new RegExp(`\\bfunction\\s+&?${method}\\s*\\(`, "i").exec(source);
  if (!m) return "";
  const brace = source.indexOf("{", m.index + m[0].length + bracketed(source, m.index + m[0].length - 1).length);
  return brace < 0 ? "" : bracketed(source, brace);
}

/**
 * Validation rules as field → rule text, from the first rules array in `code`: a FormRequest's `rules()` return, or
 * `validate([...])` and `Validator::make($data, [...])` in a controller. Rule objects read as their source text.
 */
export function validationRules(code: string): Record<string, string> {
  const m = /(?:return|validate\s*\(|Validator::make\s*\([^,]+,)\s*\[/.exec(code);
  if (!m) return {};
  const rules: Record<string, string> = {};
  const array = bracketed(code, m.index + m[0].length - 1).replace(/(['"])(?:\\.|(?!\1).)*\1|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (t) => (t.startsWith("/") ? "" : t));
  for (const item of topLevel(array)) {
    const entry = item.match(/^(['"])(.+?)\1\s*=>\s*([\s\S]*)$/);
    if (!entry) continue;
    const strings = [...entry[3].matchAll(/(['"])(.*?)\1/g)].map((s) => s[2]);
    // Rule objects, such as Rule::in(...), keep their source, so a type name in them still counts.
    const objects = entry[3].replace(/(['"]).*?\1/g, "").replace(/[\s[\],|]/g, "");
    rules[entry[2]] = [...strings, ...(objects ? [entry[3].trim()] : [])].join("|");
  }
  return rules;
}

/** The class a controller method's parameter is typed as, when its name ends in Request and isn't Laravel's own Request. */
export function formRequestParameter(source: string, method: string): string | null {
  const m = new RegExp(`\\bfunction\\s+&?${method}\\s*\\(`, "i").exec(source);
  if (!m) return null;
  const params = bracketed(source, m.index + m[0].length - 1);
  const type = [...params.matchAll(/([\\\w]+Request)\s+\$\w+/g)].map((t) => t[1]).find((t) => !/^\\?(Illuminate\\Http\\)?Request$/.test(t));
  return type ? nameResolver(source).resolve(type) : null;
}

const NOT_CALLS = new Set("if elseif while for foreach switch match catch function fn array list isset empty unset echo print return declare exit die include require include_once require_once new clone and or xor instanceof".split(" "));

/**
 * The offsets of the function and method names that PHP code calls, in order: `foo(`, `$a->foo(`, and `A::foo(`,
 * but not language constructs such as `if (`, declarations, `new A(`, or variable calls such as `$f(`. For the
 * callees in a call hierarchy. ponytail: regexes over the code with comments masked; names in strings count.
 */
export function callSites(source: string): number[] {
  const code = commentMask(`<?php ${source}`).slice(6);
  return [...code.matchAll(/(?<![$\w\\])([A-Za-z_\\][\w\\]*)\s*\(/g)]
    .filter((m) => !NOT_CALLS.has(m[1].toLowerCase()) && !/\b(function|new)\s+&?$/i.test(code.slice(0, m.index)))
    .map((m) => m.index! + m[1].lastIndexOf("\\") + 1);
}

/**
 * Where a file calls the constructor of one of `classes` (full names): `new A(`, `new self(` and `new static(`
 * inside those classes, and `new parent(` and `parent::__construct(` in classes whose parent is one of them.
 * Each is the [start, end) offsets of the name before the "(". ponytail: `new static` counts even when a
 * subclass with its own constructor runs it.
 */
export function constructorCalls(source: string, classes: Set<string>): [number, number][] {
  const code = commentMask(source);
  const { resolve } = nameResolver(code);
  const types = parseTypeDeclarations(source);
  const typeAt = (offset: number) => [...types].reverse().find((t) => t.offset < offset);
  const calls: [number, number][] = [];
  for (const m of code.matchAll(/\bnew\s+(\\?[\w\\]+)\s*\(|\bparent\s*::\s*(__construct)\s*\(/dgi)) {
    const [start, end] = (m.indices![1] ?? m.indices![2])!;
    const name = code.slice(start, end);
    const lower = name.toLowerCase();
    const type = typeAt(start);
    const target = lower === "self" || lower === "static" ? type?.fqn : lower === "parent" || lower === "__construct" ? type?.extends[0] : resolve(name);
    if (target && classes.has(target)) calls.push([start, end]);
  }
  return calls;
}

// Strings, heredocs, and comments, which name rewrites leave alone.
const LITERALS = /'(?:[^'\\]|\\[\s\S])*'|"(?:[^"\\]|\\[\s\S])*"|<<<[ \t]*(['"]?)([A-Za-z_]\w*)\1\r?\n[\s\S]*?\n[ \t]*\2\b|\/\/[^\n]*|#(?!\[)[^\n]*|\/\*[\s\S]*?\*\//g;

/** Applies `fn` to the code outside strings, heredocs, and comments, so a rewrite of names leaves `"\t"` and `'a, b'` alone. */
export function outsideStrings(text: string, fn: (code: string) => string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(LITERALS)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index! + m[0].length;
  }
  return out + fn(text.slice(last));
}

const BUILTIN_TYPES = new Set("int float string bool array callable iterable object mixed void null never false true self static parent".split(" "));
// A name in a type: after "(", ",", "|", "&", "?", or a return type's ":", and not a call or a constant's class.
const TYPE_NAME = /(?<=(?:[(,|&?]|(?<!:):)\s*)\\?[A-Za-z_][\w\\]*(?![\w\\(]|\s*::)/g;

/**
 * The abstract methods a file declares between offsets `from` and `to`: the name, and the declaration without
 * `abstract` and its `;`. Class names in its types are written in full (`\App\Models\User`), since the stub goes
 * into another file.
 */
export function abstractMethods(source: string, from = 0, to = source.length): { name: string; signature: string }[] {
  const code = commentMask(source);
  const { resolve } = nameResolver(code);
  const methods: { name: string; signature: string }[] = [];
  for (const m of code.matchAll(/((?:(?:public|protected|private|static|abstract)\s+)+)function\s+&?\s*(\w+)\s*\(/g)) {
    if (!/\babstract\b/.test(m[1]) || m.index! < from || m.index! >= to) continue;
    const close = matchBracket(code, m.index! + m[0].length - 1);
    const end = close < 0 ? -1 : code.indexOf(";", close);
    if (end < 0) continue;
    const declaration = source.slice(m.index!, end).replace(/\babstract\s+/, "");
    const signature = outsideStrings(declaration, (code) => code.replace(TYPE_NAME, (name) => (BUILTIN_TYPES.has(name.toLowerCase()) ? name : `\\${resolve(name)}`)));
    methods.push({ name: m[2], signature: signature.trimEnd() });
  }
  return methods;
}

/** Writes each full class name (`\App\Models\User`) in `text` by its short name where the file's `use` statements or namespace make that name mean the same class. */
export function shortenNames(text: string, code: string): string {
  const { resolve } = nameResolver(code);
  return outsideStrings(text, (code) =>
    code.replace(/\\([A-Za-z_][\w\\]*)/g, (full, fqn: string) => {
      const short = fqn.split("\\").pop()!;
      return resolve(short) === fqn ? short : full;
    }),
  );
}
