// Reads a class's members and plans Pull Members Up and Extract Interface as text edits. Free of editor imports so
// Node can test it. ponytail: a scanner over comment-masked code, not a PHP parser; `public $a, $b;` and
// `const A = 1, B = 2;` read as their first name, and unqualified function and constant names aren't re-resolved.
import { commentMask } from "./comments.ts";
import { deletionLines, nameResolver, parseTypeDeclarations } from "./phptypes.ts";
import { matchBracket, splitTopLevel } from "./refactorparse.ts";

export type Edit = { start: number; end: number; text: string };
export type Visibility = "public" | "protected" | "private";
export type MemberKind = "constant" | "property" | "method" | "case" | "trait";

export type Member = {
  kind: MemberKind;
  name: string;
  /** Start of the member's docblock or attributes, or else of its declaration. */
  start: number;
  /** Start of the declaration's modifiers. */
  declStart: number;
  /** Just past its `;` or closing `}`. */
  end: number;
  visibility: Visibility;
  isStatic: boolean;
  isAbstract: boolean;
  /** The declaration on one line, without a method's body: `public function find(int $id): ?User`. */
  signature: string;
  /** Offset of a method's body `{`, or -1. */
  bodyStart: number;
  /** A property declared in the constructor's parameters. */
  promoted: boolean;
  /** A promoted property's parameter: its offsets, its modifiers, and its type. */
  param?: { start: number; end: number; modifiers: string; type: string; readonly: boolean };
};

export type ClassBody = { open: number; close: number; members: Member[]; indent: string };

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ").replace(/\(\s+/g, "(").replace(/,\s*\)/g, ")").replace(/\s+\)/g, ")").trim();

/** The index of the first `char` at `from` or after, outside strings, comments, and brackets; -1 if a bracket closes first. */
function topLevel(source: string, code: string, from: number, chars: string, to = source.length): number {
  for (let i = from; i < to; i++) {
    const c = code[i];
    if (chars.includes(c)) return i;
    if (c === "'" || c === '"') i = matchQuote(source, i);
    else if (c === "(" || c === "[" || c === "{") {
      const close = matchBracket(source, i);
      if (close < 0) return -1;
      i = close;
    } else if (c === ")" || c === "]" || c === "}") return -1;
  }
  return -1;
}

function matchQuote(source: string, i: number): number {
  const q = source[i];
  for (i++; i < source.length && source[i] !== q; i++) if (source[i] === "\\") i++;
  return i;
}

/** Where the docblock directly above `at` starts, over whitespace only, or `at` when there's none. */
function docStart(source: string, at: number): number {
  const before = source.slice(0, at).replace(/\s+$/, "");
  if (!before.endsWith("*/")) return at;
  const open = before.lastIndexOf("/**");
  return open < 0 ? at : open;
}

/** The members of the type whose name is at `typeOffset`, in order, then its promoted constructor properties. */
export function classBody(source: string, typeOffset: number): ClassBody | null {
  const code = commentMask(source);
  const open = code.indexOf("{", typeOffset);
  const close = open < 0 ? -1 : matchBracket(source, open);
  if (close < 0) return null;
  const members: Member[] = [];
  let i = open + 1;
  const skipSpace = () => {
    while (i < close && /\s/.test(code[i])) i++;
  };
  for (skipSpace(); i < close; skipSpace()) {
    let attributes = -1;
    while (code.startsWith("#[", i)) {
      if (attributes < 0) attributes = i;
      const end = matchBracket(source, i + 1);
      if (end < 0) return null;
      i = end + 1;
      skipSpace();
    }
    const declStart = i;
    const mods = code.slice(i, close).match(/^((?:(?:public|protected|private|static|abstract|final|readonly|var)(?:\(set\))?\s+)*)/)![1];
    const words = mods.split(/\s+/).filter(Boolean);
    const visibility = (words.find((w) => /^(public|protected|private)$/.test(w)) as Visibility | undefined) ?? "public";
    const rest = i + mods.length;
    const start = docStart(source, attributes >= 0 ? attributes : declStart);
    const base = { start, declStart, visibility, isStatic: words.includes("static"), isAbstract: words.includes("abstract"), promoted: false, bodyStart: -1 };
    const fn = code.slice(rest, close).match(/^function\s+&?\s*(\w+)\s*\(/);
    if (fn) {
      const paren = rest + fn[0].length - 1;
      const parenClose = matchBracket(source, paren);
      const brace = parenClose < 0 ? -1 : topLevel(source, code, parenClose + 1, "{;", close);
      if (brace < 0) return null;
      const end = code[brace] === "{" ? matchBracket(source, brace) + 1 : brace + 1;
      members.push({ ...base, kind: "method", name: fn[1], end, signature: oneLine(source.slice(declStart, brace)), bodyStart: code[brace] === "{" ? brace : -1 });
      i = end;
      continue;
    }
    const other = code.slice(rest, close).match(/^(const|use|case)\b/);
    // A property: an optional type, then its name.
    const prop = other ? null : code.slice(rest, close).match(/^(?:[?\w\\|&()]+\s+)?&?\$(\w+)/);
    const semi = topLevel(source, code, rest, other?.[1] === "use" ? ";{" : prop ? ";{" : ";", close);
    if (semi < 0) return null;
    const end = code[semi] === "{" ? matchBracket(source, semi) + 1 : semi + 1;
    const text = oneLine(source.slice(declStart, code[semi] === "{" && other?.[1] !== "use" ? end : semi));
    if (other?.[1] === "const") {
      const name = code.slice(rest, semi).match(/^const\s+(?:[?\w\\|]+\s+)?(\w+)\s*=/)?.[1];
      if (name) members.push({ ...base, kind: "constant", name, end, signature: text });
    } else if (other?.[1] === "case") {
      members.push({ ...base, kind: "case", name: code.slice(rest, semi).match(/^case\s+(\w+)/)?.[1] ?? "", end, signature: text });
    } else if (other?.[1] === "use") {
      members.push({ ...base, kind: "trait", name: oneLine(code.slice(rest + 3, semi)), end, signature: text });
    } else if (prop) {
      members.push({ ...base, kind: "property", name: prop[1], end, signature: text });
    }
    i = end;
  }
  // Promoted constructor properties.
  const ctor = members.find((m) => m.kind === "method" && m.name.toLowerCase() === "__construct");
  if (ctor) {
    const paren = code.indexOf("(", code.indexOf("__construct", ctor.declStart));
    const closeParen = matchBracket(source, paren);
    for (let from = paren + 1; from < closeParen; ) {
      const comma = topLevel(source, code, from, ",", closeParen);
      const to = comma < 0 ? closeParen : comma;
      const raw = code.slice(from, to);
      const start = from + raw.match(/^\s*/)![0].length;
      const end = from + raw.trimEnd().length;
      from = to + 1;
      const text = code.slice(start, end);
      const m = text.match(/^((?:#\[[\s\S]*?\]\s*)*)((?:(?:public|protected|private|readonly)(?:\(set\))?\s+)+)([?\w\\|&()]+\s+)?&?\$(\w+)/);
      if (!m) continue;
      const visibility = (m[2].match(/public|protected|private/)?.[0] as Visibility | undefined) ?? "public";
      const param = { start: start + m[1].length, end, modifiers: m[2].trim(), type: (m[3] ?? "").trim(), readonly: /\breadonly\b/.test(m[2]) };
      members.push({ kind: "property", name: m[4], start: -1, declStart: -1, end: -1, visibility, isStatic: false, isAbstract: false, signature: oneLine(source.slice(start, end)), bodyStart: -1, promoted: true, param });
    }
  }
  const firstLine = source.slice(open + 1, close).match(/\n([ \t]+)\S/);
  return { open, close, members, indent: firstLine?.[1] ?? "    " };
}

/** A member's source, with its docblock and attributes. */
export const memberText = (source: string, m: Member) => source.slice(m.start, m.end);

// ---- Dependencies ----

export type Refs = { methods: Set<string>; properties: Set<string>; constants: Set<string>; parentCalls: Set<string> };

/** The class's own members that code uses through `$this->`, `self::`, and `static::`, and the `parent::` members it calls. */
export function memberRefs(code: string): Refs {
  const masked = commentMask(`<?php ${code}`).slice(6);
  const refs: Refs = { methods: new Set(), properties: new Set(), constants: new Set(), parentCalls: new Set() };
  for (const m of masked.matchAll(/\$this\s*\??->\s*(\w+)(\s*\()?/g)) (m[2] ? refs.methods : refs.properties).add(m[1]);
  for (const m of masked.matchAll(/\b(self|static|parent)\s*::\s*(\$)?(\w+)(\s*\()?/g)) {
    if (m[1] === "parent") refs.parentCalls.add(m[3]);
    else if (m[2]) refs.properties.add(m[3]);
    else if (m[4]) refs.methods.add(m[3]);
    else if (m[3] !== "class") refs.constants.add(m[3]);
  }
  return refs;
}

const refersTo = (refs: Refs, m: Member) =>
  m.kind === "method" ? refs.methods.has(m.name) : m.kind === "property" ? refs.properties.has(m.name) : m.kind === "constant" ? refs.constants.has(m.name) : false;

/** The members of `all` that `member`'s code uses. */
export function dependencies(source: string, member: Member, all: Member[]): Member[] {
  if (member.promoted) return [];
  const refs = memberRefs(memberText(source, member));
  return all.filter((m) => m !== member && refersTo(refs, m));
}

/**
 * Private members that move while members that stay use them: in the parent class they must be protected. A promoted
 * property always is, since the constructor that stays sets it.
 */
export function needsProtected(source: string, moving: Member[], all: Member[]): Member[] {
  const staying = all.filter((m) => !moving.includes(m));
  return moving.filter((m) => m.visibility === "private" && (m.promoted || staying.some((s) => dependencies(source, s, all).includes(m))));
}

// ---- Class names ----

const BUILTIN = new Set(
  "int float string bool array callable iterable object mixed void null never false true self static parent class list resource numeric scalar positive-int negative-int non-empty-string non-empty-array array-key class-string key-of value-of".split(" "),
);
const NAME = String.raw`\\?[A-Za-z_][\w\\]*`;
/** A name in a type: after "(", ",", "|", "&", "?", or a return type's ":", and not a call or a constant's class. */
const TYPE_NAME = new RegExp(String.raw`(?<=(?:[(,|&?]|(?<!:):)\s*)${NAME}(?![\w\\(]|\s*::)`, "g");

/** Blanks strings and comments, keeping offsets, so patterns only see code. */
function codeOnly(code: string): string {
  const masked = commentMask(`<?php ${code}`).slice(6);
  return masked.replace(/'(?:[^'\\]|\\[\s\S])*'|"(?:[^"\\]|\\[\s\S])*"/g, (s) => s.replace(/[^\n]/g, " "));
}

/**
 * Class names a member's code uses, as offsets into it: `new X`, `X::`, `instanceof X`, `catch (X`, attributes,
 * `extends` and `implements` of anonymous classes, the types in function and closure headers and properties, and
 * the types in docblock tags.
 */
export function classNameRefs(code: string): { start: number; end: number; name: string }[] {
  const plain = codeOnly(code);
  const found = new Map<number, { start: number; end: number; name: string }>();
  const add = (start: number, name: string) => {
    if (!BUILTIN.has(name.toLowerCase()) && !found.has(start)) found.set(start, { start, end: start + name.length, name });
  };
  for (const m of plain.matchAll(new RegExp(String.raw`\bnew\s+(${NAME})`, "g"))) add(m.index! + m[0].length - m[1].length, m[1]);
  for (const m of plain.matchAll(new RegExp(String.raw`(?<![\w\\$>:])(${NAME})\s*::`, "g"))) add(m.index!, m[1]);
  for (const m of plain.matchAll(new RegExp(String.raw`\binstanceof\s+(${NAME})`, "g"))) add(m.index! + m[0].length - m[1].length, m[1]);
  for (const m of plain.matchAll(new RegExp(String.raw`#\[\s*(${NAME})`, "g"))) add(m.index! + m[0].length - m[1].length, m[1]);
  for (const m of plain.matchAll(/\bcatch\s*\(([^)$]*)/g)) {
    const listStart = m.index! + m[0].length - m[1].length;
    for (const n of m[1].matchAll(new RegExp(NAME, "g"))) add(listStart + n.index!, n[0]);
  }
  for (const m of plain.matchAll(/\b(?:extends|implements)\s+([\w\\\s,]+?)\s*(?=[{(]|$)/g)) {
    const listStart = m.index! + m[0].indexOf(m[1]);
    for (const n of m[1].matchAll(new RegExp(NAME, "g"))) add(listStart + n.index!, n[0]);
  }
  // Function and closure headers: the parameter list and the return type.
  for (const m of plain.matchAll(/\b(?:function|fn)\b\s*&?\s*\w*\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBracket(plain, open);
    if (close < 0) continue;
    const ret = plain.slice(close + 1).match(/^(\s*use\s*\([^)]*\))?(\s*:\s*[?\w\\|&()\s]+?)(?=\s*(?:[{;]|=>|$))/);
    const header = withoutDefaults(plain.slice(open, close + 1)) + (ret?.[2] ? " ".repeat(ret[1]?.length ?? 0) + ret[2] : "");
    for (const n of header.matchAll(TYPE_NAME)) add(open + n.index!, n[0]);
  }
  // A property's type, after its modifiers.
  const prop = plain.match(/^\s*(?:#\[[^\]]*\]\s*)*((?:(?:public|protected|private|static|readonly|var)(?:\(set\))?\s+)+)([?\w\\|&()]+)\s+&?\$/);
  if (prop) {
    const typeStart = prop.index! + prop[0].indexOf(prop[2], prop[1].length);
    for (const n of `(${prop[2]}`.matchAll(TYPE_NAME)) add(typeStart + n.index! - 1, n[0]);
  }
  // Docblock tags: `@param Type $x`, `@return A|B`, `@var array<int, User>`, `@throws X`.
  for (const doc of code.matchAll(/\/\*\*[\s\S]*?\*\//g))
    for (const tag of doc[0].matchAll(/@(?:param|return|var|throws|property(?:-read|-write)?|mixin)\s+((?:[^\s$<{]|<[^>]*>|\{[^}]*\})+)/g)) {
      const typeStart = doc.index! + tag.index! + tag[0].length - tag[1].length;
      for (const n of tag[1].matchAll(/\\?[A-Za-z_][\w\\-]*/g)) if (!/-/.test(n[0])) add(typeStart + n.index!, n[0]);
    }
  return [...found.values()].sort((a, b) => a.start - b.start);
}

/** A parameter list with its default values blanked, so a constant in `= [A, B]` doesn't read as a type. */
function withoutDefaults(list: string): string {
  let out = "";
  let depth = 0;
  let blank = false;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (depth === 1 && c === ",") blank = false;
    if (depth === 0 && c === ")") blank = false;
    if (depth === 1 && c === "=" && list[i + 1] !== ">") blank = true;
    out += blank && c !== "\n" ? " " : c;
  }
  return out;
}

/** The short names a file already gives meaning to: its imports, and the types it declares. */
function namesTaken(code: string): Map<string, string> {
  const { namespace } = nameResolver(code);
  const taken = new Map<string, string>();
  for (const [, name, alias] of code.matchAll(/^use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm)) taken.set((alias ?? name.split("\\").pop()!).toLowerCase(), name);
  for (const [, name] of code.matchAll(/(?:^|[\s;}])(?:class|interface|trait|enum)\s+(\w+)/g)) taken.set(name.toLowerCase(), namespace ? `${namespace}\\${name}` : name);
  return taken;
}

/** Namespaced functions and constants the project declares, by full name; functions lowercased, as PHP matches them. */
export type Globals = { functions: Set<string>; constants: Set<string> };
const NO_GLOBALS: Globals = { functions: new Set(), constants: new Set() };

/** The full names of the functions and constants a file declares outside any class. */
export function declaredGlobals(source: string): Globals {
  const code = commentMask(source);
  const { namespace } = nameResolver(code);
  const full = (name: string) => (namespace ? `${namespace}\\${name}` : name);
  const functions = new Set([...code.matchAll(/^function\s+&?\s*(\w+)\s*\(/gm)].map((m) => full(m[1]).toLowerCase()));
  const constants = new Set([...code.matchAll(/^const\s+([^;]+);/gm)].flatMap((m) => splitTopLevel(m[1]).map((c) => full(c.split("=")[0].trim()))));
  return { functions, constants };
}

const NOT_FUNCTIONS = new Set(
  "if elseif else while for foreach switch match array list isset empty unset eval exit die return echo print include include_once require require_once catch declare fn function static self parent use new clone yield and or xor not print".split(" "),
);

/**
 * Functions a member's code calls, and constants it reads, by name: `helper(`, `Sub\helper(`, `\strlen(`, and
 * upper-case names such as `LIMIT` or `\PHP_EOL`. Not methods, class constants, or class names.
 */
export function functionConstRefs(code: string): { start: number; end: number; name: string; kind: "function" | "constant" }[] {
  const plain = codeOnly(code);
  const classes = new Set(classNameRefs(code).map((r) => r.start));
  // Attributes name classes, whose arguments look like calls.
  const attributes: [number, number][] = [...plain.matchAll(/#\[/g)].map((m) => [m.index!, matchBracket(plain, m.index! + 1)]);
  const inAttribute = (at: number) => attributes.some(([a, b]) => at > a && at < b);
  const refs: { start: number; end: number; name: string; kind: "function" | "constant" }[] = [];
  for (const m of plain.matchAll(/(?<![\w\\$]|->|::)\\?[A-Za-z_][\w\\]*(?=\s*\()/g)) {
    const name = m[0];
    if (classes.has(m.index!) || inAttribute(m.index!) || NOT_FUNCTIONS.has(name.toLowerCase())) continue;
    if (/\b(?:new|function|fn|instanceof)\s+&?\s*$/.test(plain.slice(Math.max(0, m.index! - 20), m.index!))) continue;
    refs.push({ start: m.index!, end: m.index! + name.length, name, kind: "function" });
  }
  for (const m of plain.matchAll(/(?<![\w\\$]|->|::)\\?[A-Z][A-Z0-9_]*[A-Z0-9](?![\w\\]|\s*(?:\(|::))/g)) {
    const name = m[0];
    const before = plain.slice(Math.max(0, m.index! - 30), m.index!);
    if (classes.has(m.index!) || inAttribute(m.index!) || /^\\?(TRUE|FALSE|NULL)$/i.test(name)) continue;
    // A declaration's own name, and a named argument (`f(LIMIT: 1)`).
    if (/\b(?:const|case|function|class|interface|trait|enum|goto)\s+(?:\w+\s+)?$/.test(before)) continue;
    if (/[(,]\s*$/.test(before) && /^\s*:(?!:)/.test(plain.slice(m.index! + name.length))) continue;
    refs.push({ start: m.index!, end: m.index! + name.length, name, kind: "constant" });
  }
  return refs.sort((a, b) => a.start - b.start);
}

/** A file's `use function` and `use const` imports, by the name they give. */
function functionImports(code: string) {
  const imports = { function: new Map<string, string>(), constant: new Map<string, string>() };
  for (const [, kind, name, alias] of code.matchAll(/^use\s+(function|const)\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm)) {
    const short = alias ?? name.split("\\").pop()!;
    if (kind === "function") imports.function.set(short.toLowerCase(), name);
    else imports.constant.set(short, name);
  }
  return imports;
}

/**
 * What a function or constant name means in a file, as PHP resolves it: fully qualified as written, qualified through
 * the file's imports or namespace, or unqualified through `use function` and `use const`, then the file's namespace
 * when the project declares it there, and otherwise the global one.
 */
function globalMeaning(name: string, kind: "function" | "constant", code: string, globals: Globals): string {
  if (name.startsWith("\\")) return name.slice(1);
  const { namespace, resolve } = nameResolver(code);
  if (name.includes("\\")) return resolve(name);
  const imported = kind === "function" ? functionImports(code).function.get(name.toLowerCase()) : functionImports(code).constant.get(name);
  if (imported) return imported;
  const local = namespace ? `${namespace}\\${name}` : name;
  const known = kind === "function" ? globals.functions.has(local.toLowerCase()) : globals.constants.has(local);
  return namespace && known ? local : name;
}

/**
 * Rewrites the names in `code`, which `fromCode` resolves, so they mean the same in `toCode`. A class name that
 * resolves the same there stays short, a class the target can import is imported, and a name that would clash is
 * written in full. A function or constant whose name would mean another one there, such as a helper in the source's
 * namespace, is written in full. Returns the code and the class imports it needs; `imports` holds names already
 * chosen for other code going into the same file.
 */
export function requalify(code: string, fromCode: string, toCode: string, imports: Map<string, string> = new Map(), globals: Globals = NO_GLOBALS): { code: string; imports: Map<string, string> } {
  const fromMasked = commentMask(fromCode);
  const toMasked = commentMask(toCode);
  const from = nameResolver(fromMasked).resolve;
  const to = nameResolver(toMasked);
  const taken = namesTaken(toMasked);
  const edits: Edit[] = [];
  for (const ref of classNameRefs(code)) {
    const fqn = from(ref.name);
    const short = fqn.split("\\").pop()!;
    const key = short.toLowerCase();
    let written: string;
    if (to.resolve(short) === fqn && (taken.get(key) ?? fqn) === fqn) written = short;
    else if (imports.get(key) === fqn) written = short;
    else if (!taken.has(key) && !imports.has(key) && fqn.includes("\\")) {
      imports.set(key, fqn);
      written = short;
    } else if (!fqn.includes("\\") && !to.namespace) written = short;
    else written = `\\${fqn}`;
    edits.push({ start: ref.start, end: ref.end, text: written });
  }
  for (const ref of functionConstRefs(code)) {
    const meant = globalMeaning(ref.name, ref.kind, fromMasked, globals);
    const there = globalMeaning(ref.name, ref.kind, toMasked, globals);
    const same = ref.kind === "function" ? meant.toLowerCase() === there.toLowerCase() : meant === there;
    if (!same) edits.push({ start: ref.start, end: ref.end, text: `\\${meant}` });
  }
  return { code: applyEdits(code, edits), imports };
}

/**
 * Edits that add `use` imports to a file: each goes before the first existing import that sorts after it, or after
 * the last one, or, with none yet, after the namespace (or `<?php` and `declare`) with a blank line.
 */
export function importEdits(source: string, fqns: string[]): Edit[] {
  if (!fqns.length) return [];
  const code = commentMask(source);
  const firstType = code.search(/(?:^|[\s;}])(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+\w+/);
  const existing = [...code.matchAll(/^use\s+([\w\\]+)(?:\s+as\s+\w+)?\s*;[^\n]*\n?/gm)].filter((m) => firstType < 0 || m.index! < firstType);
  const sorted = [...new Set(fqns)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  if (existing.length) {
    const edits = new Map<number, string>();
    const last = existing[existing.length - 1];
    for (const fqn of sorted) {
      const next = existing.find((m) => m[1].toLowerCase().localeCompare(fqn.toLowerCase()) > 0);
      const at = next ? next.index! : last.index! + last[0].length;
      const line = `use ${fqn};\n`;
      edits.set(at, (edits.get(at) ?? "") + (next || last[0].endsWith("\n") ? line : `\n${line.trimEnd()}`));
    }
    return [...edits].map(([at, text]) => ({ start: at, end: at, text }));
  }
  const anchor = code.match(/^namespace\s+[\w\\]+\s*;[^\n]*\n/m) ?? code.match(/^declare\s*\([^)]*\)\s*;[^\n]*\n/m) ?? code.match(/^<\?php[^\n]*\n/);
  const at = anchor ? anchor.index! + anchor[0].length : 0;
  return [{ start: at, end: at, text: `\n${sorted.map((f) => `use ${f};`).join("\n")}\n` }];
}

/**
 * Imports that code no longer uses once `edits` apply, among the `candidates` names, as edits removing their lines.
 * A name still in a comment or string counts as used, which keeps an import rather than breaking a docblock.
 */
function unusedImports(source: string, edits: Edit[], candidates: Set<string>): Edit[] {
  const imports = /^use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;[^\n]*\n/gm;
  const rest = applyEdits(source, edits).replace(imports, "");
  const out: Edit[] = [];
  for (const m of source.matchAll(imports)) {
    const short = m[2] ?? m[1].split("\\").pop()!;
    if (candidates.has(m[1]) && !new RegExp(`(?<![\\w$\\\\])${short}\\b`).test(rest)) out.push({ start: m.index!, end: m.index! + m[0].length, text: "" });
  }
  // With the whole block gone, and no new import taking its place, one of the blank lines around it goes too.
  const replaced = (e: Edit) => edits.some((x) => x.start >= e.start && x.start <= e.end && /^\s*use\s/.test(x.text));
  return mergeRemovals(out).map((e) => (source.slice(e.start - 2, e.start) === "\n\n" && source[e.end] === "\n" && !replaced(e) ? { ...e, end: e.end + 1 } : e));
}

/** Applies edits that don't overlap, from the last back. */
export function applyEdits(text: string, edits: Edit[]): string {
  return [...edits].sort((a, b) => b.start - a.start || b.end - a.end).reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);
}

/**
 * The lines of a member, with its docblock and one blank line around it, as an edit that removes them. A member
 * that shares a line with other code loses only its own text.
 */
function removal(source: string, m: Member): Edit {
  const lineStart = source.lastIndexOf("\n", m.start - 1) + 1;
  const lineEnd = source.indexOf("\n", m.end);
  if (source.slice(lineStart, m.start).trim() || source.slice(m.end, lineEnd < 0 ? source.length : lineEnd).trim()) {
    const after = source.slice(m.end).match(/^[ \t]*/)![0].length;
    return { start: m.start, end: m.end + after, text: "" };
  }
  const lines = source.split("\n");
  const lineOf = (offset: number) => source.slice(0, offset).split("\n").length;
  const [first, last] = deletionLines(lines, lineOf(m.declStart), lineOf(m.end - 1));
  const start = lines.slice(0, first - 1).reduce((n, l) => n + l.length + 1, 0);
  const end = Math.min(source.length, lines.slice(0, last).reduce((n, l) => n + l.length + 1, 0));
  return { start, end, text: "" };
}

/** Merges removals that touch or overlap, which adjacent members' blank lines can. */
function mergeRemovals(edits: Edit[]): Edit[] {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const out: Edit[] = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    if (last && e.start <= last.end) last.end = Math.max(last.end, e.end);
    else out.push({ ...e });
  }
  return out;
}

/** Code at a new indentation: the first line's indentation is the member's own, so every line shifts by the same. */
function reindent(code: string, from: string, to: string): string {
  if (from === to) return code;
  return code
    .split("\n")
    .map((line, i) => (i === 0 ? line : line.startsWith(from) ? to + line.slice(from.length) : line))
    .join("\n");
}

const lineIndent = (source: string, offset: number) => source.slice(source.lastIndexOf("\n", offset - 1) + 1, offset).match(/^[ \t]*/)![0];

/** Text without its attributes (`#[...]`), which belong to an implementation, such as a route or `#[Override]`. */
function withoutAttributes(text: string): string {
  let out = text;
  for (let i = out.indexOf("#["); i >= 0; i = out.indexOf("#[", i)) {
    const end = matchBracket(out, i + 1);
    if (end < 0) break;
    out = out.slice(0, i) + out.slice(end + 1).replace(/^[ \t]*\n?[ \t]*/, "");
  }
  return out;
}

/** A method's declaration without its body, as an interface or abstract class declares it. */
function declarationOnly(source: string, m: Member, modifiers: (words: string[]) => string[]): string {
  const doc = withoutAttributes(source.slice(m.start, m.declStart));
  const header = source.slice(m.declStart, m.bodyStart >= 0 ? m.bodyStart : m.end).replace(/\s*;?\s*$/, "");
  const mods = header.match(/^((?:(?:public|protected|private|static|abstract|final)\s+)*)/)![1];
  const words = modifiers(mods.split(/\s+/).filter(Boolean));
  return `${doc}${words.length ? `${words.join(" ")} ` : ""}${header.slice(mods.length)};`;
}

export type Target = { source: string; fqn: string; kind: "class" | "interface"; offset: number };

/**
 * The code a member becomes in the target: a method pulled into an interface, or made abstract, is its declaration
 * only; anything else moves whole. A private member the class still uses becomes protected.
 */
export function pulledCode(source: string, m: Member, target: Target, abstract: boolean, protect: boolean): string {
  const visibility = (words: string[]) => {
    const v = words.find((w) => /^(public|protected|private)$/.test(w));
    const wanted = target.kind === "interface" ? "public" : protect || (abstract && v === "private") ? "protected" : v;
    return [wanted ?? (target.kind === "interface" ? "public" : undefined), ...words.filter((w) => !/^(public|protected|private)$/.test(w))].filter((w): w is string => !!w);
  };
  if (m.kind === "method" && (target.kind === "interface" || abstract))
    return declarationOnly(source, m, (words) => {
      const rest = visibility(words).filter((w) => w !== "abstract" && w !== "final");
      // PSR-12: abstract comes before the visibility.
      return target.kind === "interface" ? rest : ["abstract", ...rest];
    });
  const text = memberText(source, m);
  if (!protect) return text;
  const declAt = m.declStart - m.start;
  return text.slice(0, declAt) + text.slice(declAt).replace(/^((?:(?:static|final|readonly)\s+)*)private\b/, "$1protected");
}

/** Where members of each kind go in a class body: constants and properties after their kind's last, methods at the end. */
function insertionPoints(source: string, body: ClassBody) {
  const last = (kinds: MemberKind[]) => [...body.members].reverse().find((m) => kinds.includes(m.kind) && !m.promoted);
  const lineEnd = (offset: number) => {
    const nl = source.indexOf("\n", offset);
    return nl < 0 || nl > body.close ? offset + 1 : nl;
  };
  const top = lineEnd(body.open);
  const fields = last(["property", "constant", "trait", "case"]);
  const any = last(["property", "constant", "trait", "case", "method"]);
  return {
    constants: last(["constant", "trait", "case"]) ? lineEnd(last(["constant", "trait", "case"])!.end - 1) : top,
    properties: fields ? lineEnd(fields.end - 1) : top,
    methods: any ? lineEnd(any.end - 1) : top,
    top,
    empty: !any,
  };
}

/**
 * Edits that turn promoted constructor properties into plain parameters the constructor assigns, as they're pulled up:
 * `private readonly Client $client` becomes `Client $client` and `$this->client = $client;`, after a leading
 * `parent::__construct(…)`.
 */
function demote(source: string, body: ClassBody, promoted: Member[]): Edit[] {
  const ctor = body.members.find((m) => m.kind === "method" && m.name.toLowerCase() === "__construct");
  if (!promoted.length || !ctor || ctor.bodyStart < 0) return [];
  const edits: Edit[] = promoted.map((m) => {
    const modifiers = source.slice(m.param!.start).match(/^(?:(?:public|protected|private|readonly)(?:\(set\))?\s+)+/)![0];
    return { start: m.param!.start, end: m.param!.start + modifiers.length, text: "" };
  });
  const close = ctor.end - 1;
  const inner = source.slice(ctor.bodyStart + 1, close);
  const ctorIndent = lineIndent(source, ctor.declStart);
  const statementIndent = inner.match(/\n([ \t]+)\S/)?.[1] ?? ctorIndent + (ctorIndent.includes("\t") ? "\t" : "    ");
  const statements = promoted.map((m) => `${statementIndent}$this->${m.name} = $${m.name};`).join("\n");
  // After the parent's constructor, which may set up what the parent needs first.
  const parentCall = commentMask(`<?php ${inner}`).slice(6).match(/^\s*parent\s*::\s*__construct\s*\(/);
  if (parentCall) {
    const callEnd = matchBracket(source, ctor.bodyStart + 1 + parentCall[0].length - 1);
    const semi = source.indexOf(";", callEnd);
    if (callEnd > 0 && semi > 0) return [...edits, { start: semi + 1, end: semi + 1, text: `\n${statements}` }];
  }
  const text = inner.includes("\n") ? `\n${statements}` : `\n${statements}\n${ctorIndent}`;
  return [...edits, { start: ctor.bodyStart + 1, end: inner.includes("\n") ? ctor.bodyStart + 1 : close, text }];
}

export type PullUp = {
  source: string;
  body: ClassBody;
  moving: Member[];
  /** Methods to declare abstract in a target class, keeping their bodies in the source class. */
  abstract: Set<Member>;
  target: Target;
  targetBody: ClassBody;
  /** The project's namespaced functions and constants, so moved calls keep meaning the same ones. */
  globals?: Globals;
};

/** The edits to the source class's file and the target's, for Pull Members Up. */
export function planPullUp(p: PullUp): { source: Edit[]; target: Edit[] } {
  const protect = new Set(needsProtected(p.source, p.moving, p.body.members));
  // Members whose declaration the target gets while the source keeps them: methods made abstract, and methods an
  // interface declares.
  const stays = (m: Member) => m.kind === "method" && (p.target.kind === "interface" || p.abstract.has(m));
  const removed = p.moving.filter((m) => !stays(m) && !m.promoted);
  const sourceEdits = mergeRemovals(removed.map((m) => removal(p.source, m)));
  sourceEdits.push(...demote(p.source, p.body, p.moving.filter((m) => m.promoted)));
  // Imports the removed code used, which the source may no longer need.
  const { resolve } = nameResolver(commentMask(p.source));
  const used = new Set(removed.flatMap((m) => classNameRefs(memberText(p.source, m)).map((r) => resolve(r.name))));
  sourceEdits.push(...unusedImports(p.source, sourceEdits, used));

  const imports = new Map<string, string>();
  const indent = p.targetBody.indent;
  const code = (m: Member) => {
    if (m.param) {
      const mods = protect.has(m) ? m.param.modifiers.replace(/\bprivate\b(?!\()/, "protected") : m.param.modifiers;
      return indent + requalify(`${mods} ${m.param.type ? `${m.param.type} ` : ""}$${m.name};`, p.source, p.target.source, imports, p.globals).code;
    }
    let text = pulledCode(p.source, m, p.target, p.abstract.has(m), protect.has(m));
    // A moving constructor takes its promoted properties along; a private one the class still uses becomes protected.
    if (m.kind === "method" && /^__construct$/i.test(m.name) && text === memberText(p.source, m)) {
      const staying = p.body.members.filter((x) => !p.moving.includes(x) && !x.promoted);
      const shared = p.body.members.filter((x) => x.param && x.visibility === "private" && staying.some((s) => dependencies(p.source, s, p.body.members).includes(x)));
      for (const x of [...shared].reverse()) {
        const at = x.param!.start - m.start;
        text = text.slice(0, at) + text.slice(at).replace(/^((?:readonly\s+)?)private\b(?!\()/, "$1protected");
      }
    }
    const moved = requalify(text, p.source, p.target.source, imports, p.globals).code;
    return indent + reindent(moved, lineIndent(p.source, m.start), indent).trimStart();
  };
  const at = insertionPoints(p.target.source, p.targetBody);
  const blocks = new Map<number, string[]>();
  const put = (offset: number, text: string) => blocks.set(offset, [...(blocks.get(offset) ?? []), text]);
  // Constants, then properties, then methods, each in the source's order.
  const order: Record<MemberKind, number> = { constant: 0, case: 0, trait: 0, property: 1, method: 2 };
  for (const m of [...p.moving].sort((a, b) => order[a.kind] - order[b.kind])) put(m.kind === "constant" ? at.constants : m.kind === "property" ? at.properties : at.methods, code(m));
  // A body that was `{}` on one line gets its closing brace on a line of its own.
  const oneLineBody = !p.target.source.slice(p.targetBody.open, p.targetBody.close).includes("\n");
  const targetEdits: Edit[] = [...blocks].map(([offset, texts]) => {
    const joined = texts.join("\n\n");
    if (at.empty) return { start: offset, end: offset, text: `\n${joined}${oneLineBody ? `\n${lineIndent(p.target.source, p.target.offset)}` : ""}` };
    // At the top of a body that has members, the blank line goes after.
    if (offset === at.top) return { start: offset, end: offset, text: `\n${joined}\n` };
    return { start: offset, end: offset, text: `\n\n${joined}` };
  });
  const becomesAbstract = p.abstract.size > 0 || p.moving.some((m) => m.kind === "method" && m.isAbstract);
  if (p.target.kind === "class" && becomesAbstract) {
    const header = p.target.source.slice(0, p.target.offset).match(/((?:(?:abstract|final|readonly)\s+)*)class\s+$/);
    if (header && !/\babstract\b/.test(header[1])) {
      const at = p.target.offset - header[0].length;
      targetEdits.push({ start: at, end: at + header[1].length, text: `abstract ${header[1].replace(/\bfinal\s+/, "")}` });
    }
  }
  targetEdits.push(...importEdits(p.target.source, [...imports.values()]));
  return { source: sourceEdits, target: targetEdits };
}

// ---- Extract interface ----

export type ExtractInterface = {
  source: string;
  body: ClassBody;
  /** The class's offset, for its `implements` list. */
  offset: number;
  fqn: string;
  members: Member[];
  name: string;
  namespace: string;
  docs: boolean;
  globals?: Globals;
};

/** The new interface file, and the class's edits: `implements` the interface, and its constants moved out. */
export function planExtractInterface(p: ExtractInterface): { file: string; source: Edit[] } {
  const fqn = p.namespace ? `${p.namespace}\\${p.name}` : p.name;
  const strict = /^declare\s*\(\s*strict_types\s*=\s*1\s*\)\s*;/m.test(p.source);
  const skeleton = `<?php\n\n${strict ? "declare(strict_types=1);\n\n" : ""}${p.namespace ? `namespace ${p.namespace};\n\n` : ""}interface ${p.name}\n{\n}\n`;
  const imports = new Map<string, string>();
  const target: Target = { source: skeleton, fqn, kind: "interface", offset: 0 };
  const stub = (m: Member) => {
    let text = withoutAttributes(pulledCode(p.source, m, target, false, false));
    if (!p.docs) text = text.replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, "");
    return "    " + reindent(requalify(text, p.source, skeleton, imports, p.globals).code, lineIndent(p.source, m.start), "    ").trimStart();
  };
  const constants = p.members.filter((m) => m.kind === "constant").map(stub);
  const methods = p.members.filter((m) => m.kind === "method").map(stub);
  const bodyText = [constants.join("\n\n"), methods.join("\n\n")].filter(Boolean).join("\n\n");
  const withBody = skeleton.replace(/\{\n\}\n$/, `{\n${bodyText}\n}\n`);
  const file = applyEdits(withBody, importEdits(withBody, [...imports.values()]));

  // The class implements the interface, by its short name when it can.
  const source: Edit[] = mergeRemovals(p.members.filter((m) => m.kind === "constant").map((m) => removal(p.source, m)));
  const { resolve } = nameResolver(commentMask(p.source));
  const taken = namesTaken(commentMask(p.source));
  const sameNamespace = resolve(p.name) === fqn;
  const importable = !taken.has(p.name.toLowerCase());
  const written = sameNamespace && (taken.get(p.name.toLowerCase()) ?? fqn) === fqn ? p.name : importable ? p.name : `\\${fqn}`;
  if (!sameNamespace && importable) source.push(...importEdits(p.source, [fqn]));
  const code = commentMask(p.source);
  const open = code.indexOf("{", p.offset);
  const header = code.slice(p.offset, open);
  const list = header.match(/\bimplements\s+([\w\\\s,]+?)\s*$/);
  const at = p.offset + header.replace(/\s+$/, "").length;
  source.push({ start: at, end: at, text: list ? `, ${written}` : ` implements ${written}` });
  return { file, source };
}

/** Why a PHP name can't be used for a new type, or null. */
export function typeNameProblem(name: string): string | null {
  if (!name) return "Type a name for the interface.";
  if (!/^[A-Za-z_]\w*$/.test(name)) return `${name} isn't a valid PHP name.`;
  const reserved = "abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum eval exit extends final finally fn for foreach function global goto if implements include instanceof insteadof interface isset list match namespace new or print private protected public readonly require return static switch throw trait try unset use var while xor yield bool int float string true false null void iterable object mixed never self parent";
  if (reserved.split(" ").includes(name.toLowerCase())) return `${name} is reserved in PHP.`;
  return null;
}

// ---- Checks ----

/** The lowest PHP version a composer.json `require.php` constraint allows, such as [8, 2] for `^8.2|^9.0`. */
export function phpMinimum(composerJson: string): [number, number] | null {
  try {
    const constraint: string = JSON.parse(composerJson).require?.php ?? "";
    const versions = [...constraint.matchAll(/(\d+)\.(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
    return versions.length ? versions.sort((a, b) => a[0] - b[0] || a[1] - b[1])[0] : null;
  } catch {
    return null;
  }
}

/** How the dialogs name a member: `charge()`, `$retries`, or `CURRENCY`. */
export const memberLabel = (m: Member) => (m.kind === "method" ? `${m.name}()` : m.kind === "property" ? `$${m.name}` : m.name);

/** Why a member can't move to a target of this kind, or null. */
export function cantPull(m: Member, kind: "class" | "interface"): string | null {
  if (kind === "class") return null;
  if (m.kind === "property") return "Interfaces can't declare properties.";
  if (m.visibility !== "public") return "Interfaces declare only public members.";
  if (m.kind === "method" && m.name.toLowerCase() === "__construct") return "A constructor doesn't belong in an interface.";
  return null;
}

/** Members an interface extracted from the class can declare: public methods other than the constructor, and public constants. */
export const interfaceCandidates = (members: Member[]) =>
  members.filter((m) => !m.promoted && m.visibility === "public" && ((m.kind === "method" && !/^__construct$/i.test(m.name)) || m.kind === "constant"));

export type Problem = { level: "error" | "warning"; text: string; fix?: { label: string; members: Member[] } };

export type PullUpCheck = {
  source: string;
  sourceName: string;
  members: Member[];
  moving: Member[];
  abstract: Set<Member>;
  target: { name: string; kind: "class" | "interface"; members: Member[]; isAbstract: boolean };
  /** The target's other direct subclasses and the methods each declares, once known. */
  siblings?: { name: string; methods: Set<string> }[];
  /** The lowest PHP version composer.json allows, as [major, minor], or null when it doesn't say. */
  php?: [number, number] | null;
};

/** What would break, or change meaning, if the members moved: errors block the refactoring, warnings don't. */
export function pullUpProblems(c: PullUpCheck): Problem[] {
  const problems: Problem[] = [];
  const same = (a: Member, b: Member) => a.kind === b.kind && (a.kind === "method" ? a.name.toLowerCase() === b.name.toLowerCase() : a.name === b.name);
  for (const m of c.moving) {
    const clash = c.target.members.find((t) => same(t, m));
    if (clash) problems.push({ level: "error", text: `${c.target.name} already declares ${memberLabel(m)}.` });
  }
  // What the moving code uses that stays behind, once per member used.
  const left = new Map<Member, Member[]>();
  for (const m of c.moving) {
    if (m.kind === "method" && (c.target.kind === "interface" || c.abstract.has(m))) continue;
    for (const d of dependencies(c.source, m, c.members))
      if (!c.moving.includes(d) && !c.target.members.some((t) => same(t, d))) left.set(d, [...(left.get(d) ?? []), m]);
  }
  // A private member left behind is out of the parent's reach, which fails every time; another only exists in this
  // subclass, which fails for the parent's others.
  for (const [d, users] of left)
    problems.push({
      level: d.visibility === "private" ? "error" : "warning",
      text: `${users.map(memberLabel).join(", ")} ${users.length === 1 ? "uses" : "use"} ${memberLabel(d)}, which stays in ${c.sourceName}${
        d.visibility === "private" ? ` as private, where ${c.target.name} can't reach it` : `, so ${c.target.name}'s other subclasses won't have it`
      }.`,
      fix: cantPull(d, c.target.kind) ? undefined : { label: `Pull ${memberLabel(d)} up too`, members: [d] },
    });
  if (c.target.kind === "class") {
    for (const m of c.moving) {
      if (c.abstract.has(m)) continue;
      const calls = [...memberRefs(memberText(c.source, m)).parentCalls];
      if (calls.length) problems.push({ level: "warning", text: `${memberLabel(m)} calls parent::${calls[0]}(), which in ${c.target.name} means its own parent's.` });
    }
    // Before PHP 8.4, only the class that declares a readonly property may set it.
    const readonly = c.moving.filter((m) => m.param?.readonly);
    const old = !c.php || c.php[0] < 8 || (c.php[0] === 8 && c.php[1] < 4);
    if (readonly.length && old)
      problems.push({
        level: c.php ? "error" : "warning",
        text: `${readonly.map(memberLabel).join(", ")} ${readonly.length === 1 ? "is" : "are"} readonly, and before PHP 8.4 only ${c.target.name} could set ${readonly.length === 1 ? "it" : "them"}, not ${c.sourceName}'s constructor.${c.php ? ` composer.json allows PHP ${c.php.join(".")}.` : ""}`,
      });
    const abstracts = c.moving.filter((m) => m.kind === "method" && (c.abstract.has(m) || m.isAbstract));
    if (abstracts.length && !c.target.isAbstract) problems.push({ level: "warning", text: `${c.target.name} becomes abstract, so new ${c.target.name}() stops working.` });
    for (const s of c.siblings ?? []) {
      const missing = abstracts.filter((m) => !s.methods.has(m.name.toLowerCase()));
      if (missing.length) problems.push({ level: "warning", text: `${s.name} extends ${c.target.name} but doesn't declare ${missing.map(memberLabel).join(", ")}, so it would have to.` });
    }
  }
  return problems;
}

// ---- Using an extracted interface ----

/** A whole file with comments and strings blanked, keeping offsets. */
function fileCode(source: string): string {
  return commentMask(source).replace(/'(?:[^'\\]|\\[\s\S])*'|"(?:[^"\\]|\\[\s\S])*"/g, (s) => s.replace(/[^\n]/g, " "));
}

/** How a file writes a class: by short name when it resolves there, with a new import when the name is free, or in full. */
function writtenName(masked: string, fqn: string): { name: string; imports: string[] } {
  const { resolve } = nameResolver(masked);
  const taken = namesTaken(masked);
  const short = fqn.split("\\").pop()!;
  if (resolve(short) === fqn && (taken.get(short.toLowerCase()) ?? fqn) === fqn) return { name: short, imports: [] };
  if (!taken.has(short.toLowerCase())) return { name: short, imports: [fqn] };
  return { name: `\\${fqn}`, imports: [] };
}

/** The top-level parts of a parameter list between `open` and `close`, with their offsets. */
function paramParts(plain: string, open: number, close: number): { start: number; text: string }[] {
  const parts: { start: number; text: string }[] = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open + 1; i <= close; i++) {
    const c = plain[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && i < close) depth--;
    if ((c === "," && depth === 0) || i === close) {
      if (plain.slice(from, i).trim()) parts.push({ start: from, text: plain.slice(from, i) });
      from = i + 1;
    }
  }
  return parts;
}

export type InterfaceUse = { fqn: string; classFqn: string; methods: Set<string>; constants: Set<string> };
export type HintPlan = { edits: Edit[]; used: number[]; skipped: { offset: number; reason: string }[] };

/**
 * Where a file can type the interface instead of the class, as PhpStorm's "use interface where possible" does: a
 * parameter used only to call the interface's methods and read its constants, and a private property (declared or
 * promoted) used only that way and assigned. Anything else stays, with the reason: passing the value on, a method the
 * interface lacks, a property others can see, or an abstract declaration, whose implementations would all have to
 * change. Return types stay, since callers may use more of the class. Docblock `@param` and `@var` types follow.
 */
export function typeHintsFor(source: string, use: InterfaceUse): HintPlan {
  const plain = fileCode(source);
  const { resolve } = nameResolver(plain);
  const ifaceShort = use.fqn.split("\\").pop()!;
  const plan: HintPlan = { edits: [], used: [], skipped: [] };
  const names = writtenName(plain, use.fqn);
  const typeRefs = (text: string, at: number) =>
    [...text.matchAll(/\\?[A-Za-z_][\w\\]*/g)].filter((n) => resolve(n[0]) === use.classFqn).map((n) => ({ start: at + n.index!, end: at + n.index! + n[0].length }));

  /** Why a variable's uses in a body need more than the interface, or null. */
  const varProblem = (from: number, to: number, variable: string): string | null => {
    for (const m of plain.slice(from, to).matchAll(new RegExp(`\\$${variable}\\b`, "g"))) {
      const after = plain.slice(from + m.index! + m[0].length);
      const call = after.match(/^\s*\??->\s*(\w+)(\s*\()?/);
      if (call?.[2] && use.methods.has(call[1].toLowerCase())) continue;
      if (call?.[2]) return `calls $${variable}->${call[1]}(), which ${ifaceShort} doesn't declare`;
      if (call) return `reads $${variable}->${call[1]}`;
      const constant = after.match(/^\s*::\s*(\w+)/);
      if (constant && (constant[1] === "class" || use.constants.has(constant[1]))) continue;
      if (/^\s*instanceof\b/.test(after)) continue;
      // A promoted parameter's value going into its own property, which is checked on its own.
      if (new RegExp(`\\$this\\s*->\\s*${variable}\\s*=\\s*$`).test(plain.slice(from, from + m.index!)) && /^\s*;/.test(after)) continue;
      return `passes $${variable} on, or uses it in a way the interface may not allow`;
    }
    return null;
  };
  /** Why a property's uses in its class need more than the interface, or null. */
  const propertyProblem = (from: number, to: number, property: string): string | null => {
    for (const m of plain.slice(from, to).matchAll(new RegExp(`\\$this\\s*\\??->\\s*${property}\\b(?!\\s*\\()`, "g"))) {
      const after = plain.slice(from + m.index! + m[0].length);
      const call = after.match(/^\s*\??->\s*(\w+)(\s*\()?/);
      if (call?.[2] && use.methods.has(call[1].toLowerCase())) continue;
      if (/^\s*=(?![=>])/.test(after)) continue;
      if (call?.[2]) return `calls $this->${property}->${call[1]}(), which ${ifaceShort} doesn't declare`;
      return `uses $this->${property} in a way the interface may not allow`;
    }
    return null;
  };
  const replace = (refs: { start: number; end: number }[], docFrom: number, docTag: RegExp) => {
    for (const r of refs) plan.edits.push({ start: r.start, end: r.end, text: names.name });
    plan.used.push(refs[0].start);
    // The same type in the docblock tag for it.
    const doc = docStart(source, docFrom);
    if (doc === docFrom) return;
    for (const tag of source.slice(doc, docFrom).matchAll(docTag)) {
      const at = doc + tag.index! + tag[0].indexOf(tag[1]);
      for (const r of typeRefs(tag[1], at)) plan.edits.push({ start: r.start, end: r.end, text: names.name });
    }
  };

  const types = parseTypeDeclarations(source).map((t) => ({ t, body: classBody(source, t.offset) }));
  const classOf = (offset: number) => types.find(({ body }) => body && offset > body.open && offset < body.close);

  // Parameters of functions, methods, and closures, and promoted properties.
  for (const m of plain.matchAll(/\b(function|fn)\b\s*&?\s*(\w*)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBracket(plain, open);
    if (close < 0) continue;
    const brace = m[1] === "function" ? topLevel(source, plain, close + 1, "{;") : -1;
    const bodyEnd = brace >= 0 && plain[brace] === "{" ? matchBracket(source, brace) : -1;
    let keyword = m.index!;
    const mods = plain.slice(0, keyword).match(/(?:(?:public|protected|private|static|abstract|final)\s+)*$/)!;
    keyword -= mods[0].length;
    for (const part of paramParts(plain, open, close)) {
      const p = part.text.match(/^(\s*(?:#\[[\s\S]*?\]\s*)*)((?:(?:public|protected|private|readonly)(?:\(set\))?\s+)*)([?\w\\|&()\s]*?)\s*&?\s*(?:\.\.\.)?\s*\$(\w+)/);
      if (!p || !p[3].trim()) continue;
      const refs = typeRefs(p[3], part.start + p[1].length + p[2].length);
      if (!refs.length) continue;
      const at = refs[0].start;
      const skip = (reason: string) => plan.skipped.push({ offset: at, reason });
      if (m[1] === "fn") {
        skip("a parameter of an arrow function");
        continue;
      }
      if (bodyEnd < 0) {
        skip("an abstract or interface method, whose implementations would have to change too");
        continue;
      }
      const promoted = p[2].trim();
      let why = varProblem(brace, bodyEnd, p[4]);
      if (promoted) {
        const owner = classOf(m.index!);
        if (!/\bprivate\b/.test(promoted)) why ??= `$${p[4]} is ${promoted.match(/public|protected/)?.[0] ?? "public"}, so code outside the class may use more of it`;
        else if (owner?.body) why ??= propertyProblem(owner.body.open, owner.body.close, p[4]);
      }
      if (why) skip(why);
      else replace(refs, keyword, new RegExp(`@param\\s+((?:[^\\s$<]|<[^>]*>)+)\\s+\\$${p[4]}\\b`, "g"));
    }
  }
  // Declared properties.
  for (const { body } of types) {
    for (const member of body?.members ?? []) {
      if (member.kind !== "property" || member.promoted) continue;
      const decl = plain.slice(member.declStart, member.end).match(/^((?:(?:public|protected|private|static|readonly|var)(?:\(set\))?\s+)+)([?\w\\|&()]+)\s+&?\$(\w+)/);
      if (!decl) continue;
      const refs = typeRefs(decl[2], member.declStart + decl[1].length);
      if (!refs.length) continue;
      const why = /\bstatic\b/.test(decl[1])
        ? "a static property"
        : member.visibility !== "private"
          ? `$${member.name} is ${member.visibility}, so code outside the class may use more of it`
          : propertyProblem(body!.open, body!.close, member.name);
      if (why) plan.skipped.push({ offset: refs[0].start, reason: why });
      else replace(refs, member.declStart, /@var\s+((?:[^\s$<]|<[^>]*>)+)/g);
    }
  }
  if (!plan.used.length) return { ...plan, edits: [] };
  plan.edits.push(...importEdits(source, names.imports));
  plan.edits.push(...unusedImports(source, plan.edits, new Set([use.classFqn])));
  return plan;
}

/**
 * Edits that bind the interface to the class in a Laravel service provider's `register()`, so the container can
 * resolve type hints that now name the interface. Empty when the provider already names the interface.
 */
export function bindingEdits(provider: string, ifaceFqn: string, classFqn: string): Edit[] {
  const masked = commentMask(provider);
  const iface = writtenName(masked, ifaceFqn);
  const cls = writtenName(masked, classFqn);
  if (new RegExp(`\\b${iface.name.replace(/\\/g, "\\\\")}::class\\b`).test(masked)) return [];
  const line = `$this->app->bind(${iface.name}::class, ${cls.name}::class);`;
  const imports = importEdits(provider, [...iface.imports, ...cls.imports]);
  const register = masked.match(/\bfunction\s+register\s*\([^)]*\)[^{;]*\{/);
  if (register) {
    const open = register.index! + register[0].length - 1;
    const close = matchBracket(provider, open);
    const methodIndent = lineIndent(provider, register.index!);
    const indent = `${methodIndent}${methodIndent.includes("\t") ? "\t" : "    "}`;
    const inner = provider.slice(open + 1, close);
    // Laravel's stock register() holds only a `//` placeholder, which the binding replaces.
    if (/^\s*(\/\/[^\n]*)?\s*$/.test(inner)) return [...imports, { start: open + 1, end: close, text: `\n${indent}${line}\n${methodIndent}` }];
    return [...imports, { start: open + 1, end: open + 1, text: `\n${indent}${line}` }];
  }
  const type = parseTypeDeclarations(provider)[0];
  const body = type && classBody(provider, type.offset);
  if (!body) return [];
  const indent = body.indent;
  const method = `\n${indent}public function register(): void\n${indent}{\n${indent}    ${line}\n${indent}}\n`;
  return [...imports, { start: body.open + 1, end: body.open + 1, text: body.members.length ? method : method.trimEnd() }];
}
