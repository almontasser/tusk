// Reads a class's members and plans Pull Members Up and Extract Interface as text edits. Free of editor imports so
// Node can test it. ponytail: a scanner over comment-masked code, not a PHP parser; `public $a, $b;` and
// `const A = 1, B = 2;` read as their first name, and unqualified function and constant names aren't re-resolved.
import { commentMask } from "./comments.ts";
import { deletionLines, nameResolver } from "./phptypes.ts";
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
  /** A property declared in the constructor's parameters, which can't move on its own. */
  promoted: boolean;
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
    const paren = source.indexOf("(", ctor.declStart + ctor.signature.indexOf("__construct"));
    const list = source.slice(paren + 1, matchBracket(source, paren));
    for (const param of splitTopLevel(commentMask(`<?php ${list}`).slice(6))) {
      const m = param.match(/^(?:#\[[^\]]*\]\s*)*((?:(?:public|protected|private|readonly)(?:\(set\))?\s+)+)(?:[?\w\\|&()]+\s+)?&?\$(\w+)/);
      if (!m) continue;
      const visibility = (m[1].match(/public|protected|private/)?.[0] as Visibility | undefined) ?? "public";
      members.push({ kind: "property", name: m[2], start: -1, declStart: -1, end: -1, visibility, isStatic: false, isAbstract: false, signature: oneLine(param), bodyStart: -1, promoted: true });
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

/** Private members that move while members that stay use them: in the parent class they must be protected. */
export function needsProtected(source: string, moving: Member[], all: Member[]): Member[] {
  const staying = all.filter((m) => !moving.includes(m));
  return moving.filter((m) => m.visibility === "private" && staying.some((s) => dependencies(source, s, all).includes(m)));
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

/**
 * Rewrites the class names in `code`, which `fromCode` resolves, so they mean the same classes in `toCode`: a name
 * that resolves the same there stays short, a class the target can import is imported, and a name that would clash
 * is written in full. Returns the code and the imports it needs; `imports` holds names already chosen for other code
 * going into the same file.
 */
export function requalify(code: string, fromCode: string, toCode: string, imports: Map<string, string> = new Map()): { code: string; imports: Map<string, string> } {
  const from = nameResolver(commentMask(fromCode)).resolve;
  const to = nameResolver(commentMask(toCode));
  const taken = namesTaken(commentMask(toCode));
  let out = code;
  for (const ref of classNameRefs(code).reverse()) {
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
    out = out.slice(0, ref.start) + written + out.slice(ref.end);
  }
  return { code: out, imports };
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
  // With the whole block gone, one of the blank lines around it goes too.
  return mergeRemovals(out).map((e) => (source.slice(e.start - 2, e.start) === "\n\n" && source[e.end] === "\n" ? { ...e, end: e.end + 1 } : e));
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

export type PullUp = {
  source: string;
  body: ClassBody;
  moving: Member[];
  /** Methods to declare abstract in a target class, keeping their bodies in the source class. */
  abstract: Set<Member>;
  target: Target;
  targetBody: ClassBody;
};

/** The edits to the source class's file and the target's, for Pull Members Up. */
export function planPullUp(p: PullUp): { source: Edit[]; target: Edit[] } {
  const protect = new Set(needsProtected(p.source, p.moving, p.body.members));
  // Members whose declaration the target gets while the source keeps them: methods made abstract, and methods an
  // interface declares.
  const stays = (m: Member) => m.kind === "method" && (p.target.kind === "interface" || p.abstract.has(m));
  const removed = p.moving.filter((m) => !stays(m));
  const sourceEdits = mergeRemovals(removed.map((m) => removal(p.source, m)));
  // Imports the removed code used, which the source may no longer need.
  const { resolve } = nameResolver(commentMask(p.source));
  const used = new Set(removed.flatMap((m) => classNameRefs(memberText(p.source, m)).map((r) => resolve(r.name))));
  sourceEdits.push(...unusedImports(p.source, sourceEdits, used));

  const imports = new Map<string, string>();
  const indent = p.targetBody.indent;
  const code = (m: Member) => {
    const text = pulledCode(p.source, m, p.target, p.abstract.has(m), protect.has(m));
    const moved = requalify(text, p.source, p.target.source, imports).code;
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
    return "    " + reindent(requalify(text, p.source, skeleton, imports).code, lineIndent(p.source, m.start), "    ").trimStart();
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

/** How the dialogs name a member: `charge()`, `$retries`, or `CURRENCY`. */
export const memberLabel = (m: Member) => (m.kind === "method" ? `${m.name}()` : m.kind === "property" ? `$${m.name}` : m.name);

/** Why a member can't move to a target of this kind, or null. */
export function cantPull(m: Member, kind: "class" | "interface"): string | null {
  if (m.promoted) return "Declared in the constructor. Declare it as a property first to move it.";
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
  for (const [d, users] of left)
    problems.push({
      level: "warning",
      text: `${users.map(memberLabel).join(", ")} ${users.length === 1 ? "uses" : "use"} ${memberLabel(d)}, which stays in ${c.sourceName}.`,
      fix: cantPull(d, c.target.kind) ? undefined : { label: `Pull ${memberLabel(d)} up too`, members: [d] },
    });
  if (c.target.kind === "class") {
    for (const m of c.moving) {
      if (c.abstract.has(m)) continue;
      const calls = [...memberRefs(memberText(c.source, m)).parentCalls];
      if (calls.length) problems.push({ level: "warning", text: `${memberLabel(m)} calls parent::${calls[0]}(), which in ${c.target.name} means its own parent's.` });
    }
    const abstracts = c.moving.filter((m) => m.kind === "method" && (c.abstract.has(m) || m.isAbstract));
    if (abstracts.length && !c.target.isAbstract) problems.push({ level: "warning", text: `${c.target.name} becomes abstract, so new ${c.target.name}() stops working.` });
    for (const s of c.siblings ?? []) {
      const missing = abstracts.filter((m) => !s.methods.has(m.name.toLowerCase()));
      if (missing.length) problems.push({ level: "warning", text: `${s.name} extends ${c.target.name} but doesn't declare ${missing.map(memberLabel).join(", ")}, so it would have to.` });
    }
  }
  return problems;
}
