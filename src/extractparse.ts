// Text-level PHP for Inline Variable, Inline Constant, and Inline Method: the call around a method name, where a
// statement before it goes, and the method's body to substitute. Free of editor imports so Node can test it.
// Extract Variable, Extract Constant, Introduce Field, and Introduce Parameter read code in Tusk's server instead.
// ponytail: a tokenizer and a precedence parser over one statement, not a PHP parser; heredocs aren't tokenized,
// and ternaries (? :) and closures are boundaries rather than expressions. Move Inline to the server to drop it.
import { commentMask } from "./comments.ts";
import { nameResolver, outsideStrings, parseTypeDeclarations } from "./phptypes.ts";
import { declarationParts, type Param } from "./refactorparse.ts";

type Tok = { type: "str" | "var" | "num" | "name" | "open" | "close" | "op"; text: string; start: number; end: number; match: number };
/** An expression in the source, as offsets. `text` is the source between them. */
export type Expr = { start: number; end: number; text: string };

const TOKEN =
  /\s+|('(?:[^'\\]|\\[\s\S])*'?|"(?:[^"\\]|\\[\s\S])*"?)|(\$+[A-Za-z_\x80-\uffff][\w\x80-\uffff]*)|(0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|\.\d+)|(\\?[A-Za-z_\x80-\uffff][\w\x80-\uffff]*(?:\\[A-Za-z_\x80-\uffff][\w\x80-\uffff]*)*)|([([{])|([)\]}])|(\*\*=|\.\.\.|<=>|===|!==|\?\?=|<<=|>>=|\?->|\*\*|==|!=|<>|<=|>=|&&|\|\||\?\?|<<|>>|->|::|=>|\+\+|--|[-+*/.%&|^]=|[\s\S])/y;
const TYPES = [, "str", "var", "num", "name", "open", "close", "op"] as const;

function tokenize(source: string): Tok[] {
  // PHP's open and close tags separate statements, as `;` does; the padding keeps offsets.
  const code = commentMask(source).replace(/<\?php\b|<\?=|\?>/g, (tag) => ";".padEnd(tag.length));
  const toks: Tok[] = [];
  const stack: number[] = [];
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(code); m; m = TOKEN.exec(code)) {
    const group = m.findIndex((g, i) => i > 0 && g !== undefined);
    if (group < 0) continue; // Whitespace, including masked comments.
    const tok: Tok = { type: TYPES[group]!, text: m[0], start: m.index, end: m.index + m[0].length, match: -1 };
    if (tok.type === "open") stack.push(toks.length);
    else if (tok.type === "close" && stack.length) {
      const open = stack.pop()!;
      toks[open].match = toks.length;
      tok.match = open;
    }
    toks.push(tok);
  }
  return toks;
}

// Binary operators by precedence, PHP 8's order. `**` and `??` group from the right.
const PRECEDENCE: Record<string, number> = {
  "??": 1, "||": 2, "&&": 3, "|": 4, "^": 5, "&": 6,
  "==": 7, "!=": 7, "===": 7, "!==": 7, "<>": 7, "<=>": 7, "<": 8, "<=": 8, ">": 8, ">=": 8,
  ".": 9, "<<": 10, ">>": 10, "+": 11, "-": 11, "*": 12, "/": 12, "%": 12, instanceof: 13, "**": 14,
};
const RIGHT = new Set(["**", "??"]);
const ASSIGNMENT = new Set(["=", "+=", "-=", "*=", "/=", ".=", "%=", "&=", "|=", "^=", "**=", "??=", "<<=", ">>="]);
const KEYWORDS = new Set(
  "return echo print yield throw include include_once require require_once as case default else elseif if while for foreach switch match do try catch finally function fn use global static const public private protected var abstract final readonly class interface trait enum namespace goto break continue and or xor".split(" "),
);
const CASTS = new Set("int integer float double string bool boolean array object".split(" "));
const PREFIX = new Set(["!", "-", "+", "~", "@"]);

const isKeyword = (toks: Tok[], i: number) => toks[i].type === "name" && KEYWORDS.has(toks[i].text.toLowerCase()) && toks[i + 1]?.text !== "::";
/** Tokens that end an expression: statement and argument separators, assignments, ternaries, and keywords. */
const isBoundary = (toks: Tok[], i: number) => {
  const t = toks[i];
  return [";", ",", "=>", "?", ":", "{", "}"].includes(t.text) || ASSIGNMENT.has(t.text) || isKeyword(toks, i);
};

/** An operand's tokens: `start` includes prefixes such as `!`, and shorter values start at `from`. */
type Operand = { start: number; end: number; from: number; ends: number[] };

/**
 * Splits tokens [s, e) into operands and the binary operators between them, or null when they aren't one
 * expression. Each operand lists the token indexes where a shorter value ends: `$a->b()` has `$a->b()` and,
 * for `$a->b()->c`, `$a->b()->c`.
 */
function operands(toks: Tok[], s: number, e: number): { list: Operand[]; ops: string[] } | null {
  const list: Operand[] = [];
  const ops: string[] = [];
  let i = s;
  while (i < e) {
    const start = i;
    let isNew = false;
    for (;;) {
      const t = toks[i];
      if (t?.type === "op" && PREFIX.has(t.text)) i++;
      else if (t?.text === "(" && t.match === i + 2 && CASTS.has(toks[i + 1].text.toLowerCase())) i += 3;
      else if (t?.type === "name" && /^(new|clone)$/i.test(t.text)) (isNew ||= /^new$/i.test(t.text)), i++;
      else break;
    }
    const primary = i;
    const t = toks[i];
    if (!t || i >= e) return null;
    if (t.type === "open") {
      if (t.match < 0 || t.match >= e || t.text === "{") return null;
      i = t.match + 1;
    } else if (["var", "num", "str", "name"].includes(t.type) && !isKeyword(toks, i)) i++;
    else return null;
    const ends: number[] = [];
    // A class name alone, before `::` or its constructor's arguments, isn't a value.
    const value = (next: Tok | undefined) => next?.text !== "(" && !(toks[i - 1].type === "name" && i - 1 === primary && next?.text === "::");
    if (!isNew && value(toks[i])) ends.push(i);
    let calledNew = !isNew;
    while (i < e) {
      const p = toks[i];
      if ((p.text === "->" || p.text === "?->" || p.text === "::") && i + 1 < e && ["name", "var"].includes(toks[i + 1].type)) i += 2;
      else if ((p.text === "(" || p.text === "[") && p.match > 0 && p.match < e) (i = p.match + 1), p.text === "(" && (calledNew = true);
      else break;
      if (calledNew && value(toks[i])) ends.push(i);
    }
    if (isNew && !ends.includes(i)) ends.push(i);
    // `new Money(5)` is a value only with `new`.
    list.push({ start, end: i, from: isNew ? start : primary, ends });
    if (i < e && (toks[i].text === "++" || toks[i].text === "--")) i++;
    if (i >= e) break;
    const op = toks[i].text.toLowerCase();
    if (!(op in PRECEDENCE)) return null;
    ops.push(op);
    i++;
    if (i >= e) return null;
  }
  return list.length ? { list, ops } : null;
}

/** The binary subexpressions around operand `k`, innermost first, as [first operand, last operand]. */
function ancestors(ops: string[], lo: number, hi: number, k: number, found: [number, number][] = []): [number, number][] {
  if (lo === hi) return found;
  // Split at the loosest operator: the rightmost one for left-grouping operators, the leftmost for `**` and `??`.
  let split = lo;
  for (let j = lo; j < hi; j++) {
    const [a, b] = [PRECEDENCE[ops[j]], PRECEDENCE[ops[split]]];
    if (a < b || (a === b && !RIGHT.has(ops[j]))) split = j;
  }
  if (k <= split) ancestors(ops, lo, split, k, found);
  else ancestors(ops, split + 1, hi, k, found);
  found.push([lo, hi]);
  return found;
}

/** The innermost bracket around token `k` that's still open there, or -1. */
function enclosing(toks: Tok[], k: number): number {
  for (let j = k - 1; j >= 0; j--) {
    const t = toks[j];
    if (t.type === "close" && t.match >= 0) j = t.match;
    else if (t.type === "open" && (t.match < 0 || t.match > k)) return j;
  }
  return -1;
}

/** The token at an offset, or the one ending there when the caret sits just after it. */
function tokenAt(toks: Tok[], offset: number): number {
  const i = toks.findIndex((t) => t.end > offset);
  if (i >= 0 && toks[i].start <= offset && toks[i].type !== "op" && toks[i].type !== "close") return i;
  if (i > 0 && toks[i - 1].end === offset && toks[i - 1].type !== "op") return i - 1;
  return i >= 0 && toks[i].start <= offset ? i : -1;
}

/** Token ranges, inclusive, of the expressions containing token `k`, innermost first. */
function candidates(toks: Tok[], k: number): [number, number][] {
  const found: [number, number][] = [];
  let open = enclosing(toks, k);
  while (k >= 0) {
    const close = open >= 0 ? toks[open].match : toks.length;
    let s = k;
    while (s - 1 > open && !isBoundary(toks, s - 1)) s = toks[s - 1].type === "close" && toks[s - 1].match > open ? toks[s - 1].match : s - 1;
    let e = toks[k].type === "open" && toks[k].match > 0 ? toks[k].match : k;
    while (e + 1 < (close < 0 ? toks.length : close) && !isBoundary(toks, e + 1)) e = toks[e + 1].type === "open" && toks[e + 1].match > 0 ? toks[e + 1].match : e + 1;
    // Assignment targets and foreach variables can't become a value.
    const target = ASSIGNMENT.has(toks[e + 1]?.text) || toks[e + 1]?.text === "++" || toks[e + 1]?.text === "--" || /^as$/i.test(toks[s - 1]?.text ?? "") || toks[s - 1]?.text === "&";
    // An arrow function's body uses its parameters, which don't exist outside it.
    const before = toks[s - 1];
    const arrowBody = before?.text === "=>" && toks[s - 2]?.type === "close" && /^fn$/i.test(toks[toks[s - 2].match - 1]?.text ?? "");
    const parsed = operands(toks, s, e + 1);
    if (parsed && !target && !arrowBody) {
      const { list, ops } = parsed;
      const at = list.findIndex((o) => o.start <= k && k < o.end);
      if (at >= 0) {
        const o = list[at];
        for (const end of o.ends) if (end > k && (end - 1 > o.from || toks[o.from].type !== "var")) found.push([o.from, end - 1]);
        // `-$x ** 2` is `-($x ** 2)`, and `!$a instanceof B` is `!($a instanceof B)`: there the prefix isn't the operand's.
        if (o.start < o.from && ops[at] !== "**" && ops[at] !== "instanceof") found.push([o.start, o.end - 1]);
        for (const [lo, hi] of ancestors(ops, 0, list.length - 1, at)) found.push([list[lo].start, list[hi].end - 1]);
      }
    }
    // Then the expression that owns the brackets around this one, such as the call that takes it as an argument.
    if (open < 0 || toks[open].text === "{") break;
    const owner = toks[open - 1];
    if (owner && isKeyword(toks, open - 1)) break;
    k = open;
    open = enclosing(toks, open);
  }
  // Longer expressions can repeat a shorter one's range when an operand is the whole segment.
  return found.filter(([a, b], i) => found.findIndex(([c, d]) => c === a && d === b) === i && !(toks[a].text === "$this" && a === b));
}

const toExpr = (source: string, toks: Tok[], [a, b]: [number, number]): Expr => ({ start: toks[a].start, end: toks[b].end, text: source.slice(toks[a].start, toks[b].end) });

/** The expressions around an offset, innermost first, such as `$a`, `$a * $b`, and `foo($a * $b)`. */
export function expressionsAt(source: string, offset: number): Expr[] {
  const toks = tokenize(source);
  const k = tokenAt(toks, offset);
  return k < 0 ? [] : candidates(toks, k).map((r) => toExpr(source, toks, r));
}

/**
 * Where to declare a variable for `uses` (in order): the start of the statement holding the first one, in the
 * innermost block that holds them all. `replace` is set when that statement is the expression alone, as in
 * `foo();`, which then becomes the assignment. An error explains a place it can't go.
 */
export function declarationPoint(source: string, uses: Expr[]): { offset: number; indent: string; replace?: Expr } | { error: string } {
  const toks = tokenize(source);
  const first = toks.findIndex((t) => t.start === uses[0].start);
  const lastEnd = uses.at(-1)!.end;
  if (first < 0) return { error: "the expression isn't code" };
  // The statement holds every bracket around the use but its block, so a `for (;;)` header's `;`, or a closure's
  // `}` in another argument, doesn't end it.
  let j = first - 1;
  for (let open = enclosing(toks, first); open >= 0 && toks[open].text !== "{"; open = enclosing(toks, open)) j = open - 1;
  for (; j >= 0; j--) {
    const t = toks[j];
    if (t.text === ";") break;
    if (t.type === "close") {
      if (t.text !== "}") j = t.match >= 0 ? t.match : j;
      // A block ends its statement, unless else, catch, and the like continue it.
      else if (/^(else|elseif|catch|finally|while)$/i.test(toks[j + 1]?.text ?? "") && t.match >= 0) j = t.match;
      else break;
    } else if (t.text === "{") {
      // The innermost block that holds every use takes the declaration. A match's arms aren't statements, and a
      // block that ends before the last use belongs to a statement that holds them all.
      const owner = toks[j - 1];
      const isMatch = owner?.type === "close" && /^match$/i.test(toks[owner.match - 1]?.text ?? "");
      if (t.match < 0 || (!isMatch && toks[t.match].start >= lastEnd)) break;
    } else if (/^fn$/i.test(t.text) && t.type === "name") return { error: "it's inside an arrow function" };
    else if (/^function$/i.test(t.text) && t.type === "name") return { error: "it's in a function's parameters, which take constant values" };
  }
  // A class body holds declarations, not statements.
  if (j >= 0 && toks[j].text === "{" && isTypeBody(toks, j)) return { error: "it isn't inside a method; use Extract Constant or Introduce Field" };
  const start = toks[j + 1];
  const lineStart = source.lastIndexOf("\n", start.start - 1) + 1;
  const indent = source.slice(lineStart, start.start).match(/^[ \t]*/)![0];
  // The statement is just the expression: `foo();` becomes `$name = foo();`.
  const only = start.start === uses[0].start && toks[first + tokenCount(toks, first, uses[0].end)]?.text === ";";
  return { offset: start.start, indent, ...(only && uses.length === 1 ? { replace: uses[0] } : {}) };
}

/** Whether the `{` at token `open` starts a class, interface, trait, or enum body. */
function isTypeBody(toks: Tok[], open: number): boolean {
  let k = open - 1;
  while (k >= 0 && ((toks[k].type === "name" && !/^(class|interface|trait|enum)$/i.test(toks[k].text)) || toks[k].text === "," || toks[k].text === ":" || toks[k].text === ")"))
    k = toks[k].text === ")" && toks[k].match >= 0 ? toks[k].match - 1 : k - 1;
  return /^(class|interface|trait|enum)$/i.test(toks[k]?.text ?? "");
}

const tokenCount = (toks: Tok[], from: number, end: number) => {
  let n = 0;
  while (toks[from + n] && toks[from + n].end <= end) n++;
  return n;
};

/**
 * The body of the innermost function, method, or closure around an offset, as offsets inside its braces, or the
 * whole file for code outside one. A closure is a scope of its own: its variables aren't the enclosing function's.
 */
export function functionScope(source: string, offset: number): [number, number] {
  const toks = tokenize(source);
  let k = toks.findIndex((t) => t.end > offset);
  if (k < 0) k = toks.length;
  const open = scopeOpen(toks, k);
  return open < 0 ? [0, source.length] : [toks[open].end, toks[toks[open].match].start];
}

/** The `{` token that opens the innermost function, method, or closure body around token `k`, or -1. */
function scopeOpen(toks: Tok[], k: number): number {
  for (let open = enclosing(toks, k); open >= 0; open = enclosing(toks, open)) {
    if (toks[open].text !== "{" || toks[open].match < 0) continue;
    // Back from the brace: a return type, then `)`, maybe a closure's `use (...)`, then `function name(`.
    let j = open - 1;
    while (j >= 0 && (toks[j].type === "name" || ["?", "|", ":"].includes(toks[j].text) || (toks[j].text === "&" && toks[j - 1]?.text !== ")"))) j--;
    if (toks[j]?.text !== ")" || toks[j].match < 0) continue;
    j = toks[j].match - 1;
    if (/^use$/i.test(toks[j]?.text ?? "") && toks[j - 1]?.text === ")") j = toks[j - 1].match - 1;
    if (toks[j]?.type === "name" && !/^function$/i.test(toks[j].text)) j--;
    if (toks[j]?.text === "&") j--;
    if (/^function$/i.test(toks[j]?.text ?? "")) return open;
  }
  return -1;
}

// ---- Inline Constant ----

/**
 * The declaration of class constant `name` in the type whose body opens at offset `open`: the statement's offsets
 * and the value's text, or an error when the statement declares several constants.
 */
export function constantDeclaration(source: string, name: string, open: number): { start: number; end: number; value: string } | { error: string } | null {
  const toks = tokenize(source);
  const first = toks.findIndex((t) => t.start === open);
  const close = first >= 0 && toks[first].match > 0 ? toks[first].match : toks.length;
  let statement = first + 1;
  for (let i = first + 1; i < close; i++) {
    const t = toks[i];
    if (t.text === "{" && t.match > 0) (i = t.match), (statement = i + 1);
    else if (t.text === ";") statement = i + 1;
    else if (/^const$/i.test(t.text)) {
      let j = i + 1;
      while (j < close && toks[j].text !== "=" && toks[j].text !== ";") j++;
      if (toks[j - 1]?.text !== name || toks[j]?.text !== "=") {
        // A later constant of the same statement, as in `const A = 1, B = 2;`.
        let k = j;
        while (k < close && toks[k].text !== ";") {
          if (toks[k].text === name && toks[k - 1]?.text === "," && toks[k + 1]?.text === "=") return { error: `${name} is declared with other constants in one statement` };
          k = toks[k].type === "open" && toks[k].match > 0 ? toks[k].match + 1 : k + 1;
        }
        continue;
      }
      let end = j + 1;
      while (end < close && toks[end].text !== ";" && toks[end].text !== ",") end = toks[end].type === "open" && toks[end].match > 0 ? toks[end].match + 1 : end + 1;
      if (toks[end]?.text === ",") return { error: `${name} is declared with other constants in one statement` };
      return { start: toks[statement].start, end: toks[end].end, value: source.slice(toks[j].end, toks[end].start).trim() };
    }
  }
  return null;
}

/**
 * References to class constant `name` in a file: each `X::NAME`'s offsets, and the full name of the class it
 * names, with `self` and `static` read as the type around it and `parent` as that type's parent.
 */
export function constantRefs(source: string, name: string): { start: number; end: number; owner: string }[] {
  const toks = tokenize(source);
  const { resolve } = nameResolver(commentMask(source));
  const types = parseTypeDeclarations(source);
  const found: { start: number; end: number; owner: string }[] = [];
  for (let i = 2; i < toks.length; i++) {
    if (toks[i].text !== name || toks[i - 1].text !== "::" || toks[i - 2].type !== "name" || toks[i + 1]?.text === "(") continue;
    const cls = toks[i - 2];
    if (toks[i - 3]?.text === "->" || toks[i - 3]?.text === "::") continue;
    const around = [...types].reverse().find((t) => t.offset < cls.start);
    const lower = cls.text.toLowerCase();
    const owner = lower === "self" || lower === "static" ? around?.fqn : lower === "parent" ? around?.extends[0] : resolve(cls.text);
    if (owner) found.push({ start: cls.start, end: toks[i].end, owner });
  }
  return found;
}

/**
 * A constant's value for use in another file: class names written in full, so the owner's imports don't matter,
 * and `self::` and `static::` naming the owner unless the use is inside it. Parentheses keep an expression whole.
 */
export function inlinedValue(value: string, ownerSource: string, owner: string, insideOwner: boolean): string {
  const { resolve } = nameResolver(commentMask(ownerSource));
  let out = outsideStrings(value, (code) =>
    code.replace(/(?<![\\\w$>:])([A-Za-z_][\w\\]*)(?=\s*::)/g, (n) => {
      const lower = n.toLowerCase();
      if (lower === "self" || lower === "static") return insideOwner ? n : `\\${owner}`;
      if (lower === "parent") return n;
      return `\\${resolve(n)}`;
    }),
  );
  // Parentheses when an operator outside brackets and strings would bind to the code around it.
  let outer = out.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
  while (/\([^()]*\)|\[[^[\]]*\]/.test(outer)) outer = outer.replace(/\([^()]*\)|\[[^[\]]*\]/g, "");
  // A sign counts too: `10 - -1` must not become `10--1`.
  if (/[-+*/%.<>=!&|^?~]/.test(outer.replace(/::/g, "").replace(/\d\.\d/g, "0"))) out = `(${out})`;
  return out;
}

// ---- Inline Method ----

/** A method ready to inline: its parameters, the statements before its result, and the result, null when void. */
export type Inlinable = { params: Param[]; statements: string; result: string | null; usesThis: boolean; thisInClosure: boolean; locals: string[] };

const SUPERGLOBALS = new Set(["$this", "$GLOBALS", "$_GET", "$_POST", "$_SERVER", "$_COOKIE", "$_FILES", "$_ENV", "$_REQUEST", "$_SESSION"]);
// Built-in functions that take an argument by reference, so a parameter passed to one is written.
const BY_REFERENCE = new Set(
  "sort rsort usort uasort uksort ksort krsort asort arsort natsort natcasesort shuffle array_multisort array_push array_pop array_shift array_unshift array_splice array_walk array_walk_recursive end reset next prev current key each settype preg_match preg_match_all str_replace str_ireplace preg_replace preg_replace_callback parse_str similar_text list extract mb_parse_str openssl_sign sscanf".split(" "),
);

/** Whether an expression can be read more than once, or not at all, without a difference: no calls, `new`, writes, or the like. */
const isPure = (expr: string) =>
  !/[(`]|\b(new|clone|include|include_once|require|require_once|print|yield|exit|die|eval)\b|\+\+|--|(?<![=!<>])=(?![=>])/i.test(outsideStrings(expr, (c) => c));
const CALL_ARGS = String.raw`\((?:[^()]|\([^()]*\))*\)`;
// A sign isn't atomic: `-1` next to `-` would read as `--`.
const ATOMIC = new RegExp(String.raw`^(\[(?:[^\[\]]|\[[^\[\]]*\])*\]|\d[\d_.]*|'(?:[^'\\]|\\.)*'|"(?:[^"\\$]|\\.)*"|true|false|null|(\$\w+|[\\\w]+)(${CALL_ARGS})?(\s*(->|\?->|::)\s*\$?\w+(${CALL_ARGS})?)*)$`, "is");
const isAtomic = (expr: string) => ATOMIC.test(expr.trim());

/** Each nested closure's or arrow function's tokens (start and end, inclusive) and its own parameter names. */
function closures(toks: Tok[]): { start: number; end: number; params: Set<string>; uses: Set<string>; arrow: boolean }[] {
  const found: { start: number; end: number; params: Set<string>; uses: Set<string>; arrow: boolean }[] = [];
  for (let i = 0; i < toks.length; i++) {
    const arrow = /^fn$/i.test(toks[i].text);
    if (!arrow && !/^function$/i.test(toks[i].text)) continue;
    let open = i + 1;
    if (toks[open]?.text === "&") open++;
    if (toks[open]?.text !== "(" || toks[open].match < 0) continue;
    const params = new Set(toks.slice(open + 1, toks[open].match).filter((t) => t.type === "var").map((t) => t.text));
    let j = toks[open].match + 1;
    const uses = new Set<string>();
    if (/^use$/i.test(toks[j]?.text ?? "") && toks[j + 1]?.text === "(") {
      for (const t of toks.slice(j + 2, toks[j + 1].match)) if (t.type === "var") uses.add(t.text);
      j = toks[j + 1].match + 1;
    }
    if (arrow) {
      while (j < toks.length && toks[j].text !== "=>") j++;
      // The arrow function's body runs to the end of its expression.
      let end = j + 1;
      while (end < toks.length && ![",", ";", "]", ")", "}"].includes(toks[end].text)) end = toks[end].type === "open" && toks[end].match > 0 ? toks[end].match + 1 : end + 1;
      found.push({ start: i, end: end - 1, params, uses, arrow });
    } else {
      while (j < toks.length && toks[j].text !== "{") j++;
      if (toks[j]?.match > 0) found.push({ start: i, end: toks[j].match, params, uses, arrow });
    }
  }
  return found;
}

/**
 * How the code uses variable `name`: the tokens that are it (not a closure's own variable of that name), whether
 * any writes it (assignment, `++`, `unset`, a `foreach` or `catch` variable, destructuring, `&`, or a built-in
 * that takes it by reference), and whether any needs a variable there (`isset`, a closure's `use`, a closure or
 * arrow function reading it later).
 */
function varUses(toks: Tok[], name: string, scopes: ReturnType<typeof closures>) {
  const tokens: number[] = [];
  let writes = false;
  let needsVariable = false;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].text !== name) continue;
    // Inside a closure, the name is the closure's own unless the closure captures it.
    const inner = scopes.filter((c) => c.start < i && i <= c.end);
    if (inner.some((c) => c.params.has(name) || (!c.arrow && !c.uses.has(name) && !(toks[i - 1]?.text === "(" && /^use$/i.test(toks[i - 2]?.text ?? ""))))) continue;
    tokens.push(i);
    if (inner.length) needsVariable = true;
    let after = i + 1;
    while (toks[after]?.text === "[" && toks[after].match > 0) after = toks[after].match + 1;
    const next = toks[after]?.text ?? "";
    const prev = toks[i - 1]?.text ?? "";
    const open = enclosing(toks, i);
    const owner = open >= 0 ? (toks[open - 1]?.text.toLowerCase() ?? "") : "";
    const destructured = open >= 0 && (toks[open].text === "[" || owner === "list") && toks[toks[open].match + 1]?.text === "=";
    if (ASSIGNMENT.has(next) || next === "++" || next === "--" || prev === "++" || prev === "--" || prev === "&" || /^as$/i.test(prev) || (prev === "=>" && owner === "foreach") || ["unset", "catch"].includes(owner) || BY_REFERENCE.has(owner) || destructured)
      writes = true;
    if (owner === "isset" || owner === "use" || (open >= 0 && /^use$/i.test(toks[open - 1]?.text ?? ""))) needsVariable = true;
  }
  return { tokens, writes, needsVariable };
}

/**
 * Reads the method whose name ends at `nameEnd` for Inline Method: its parameters, and its body as statements
 * followed by at most one `return` at the end. An error says why it can't be inlined.
 */
export function methodToInline(source: string, nameEnd: number): Inlinable | { error: string } {
  const parts = declarationParts(source, nameEnd);
  if (!parts) return { error: "its declaration couldn't be read" };
  if (parts.params.some((p) => p.variadic)) return { error: "it takes variadic arguments" };
  if (parts.params.some((p) => p.byRef)) return { error: "it takes arguments by reference" };
  const brace = source.slice(parts.end).match(/^\s*\{/);
  if (!brace) return { error: "it has no body" };
  const open = parts.end + brace[0].length - 1;
  const toks = tokenize(source);
  const openTok = toks.findIndex((t) => t.start === open);
  const closeTok = toks[openTok]?.match ?? -1;
  if (closeTok < 0) return { error: "its body couldn't be read" };
  const body = source.slice(open + 1, toks[closeTok].start);
  if (/<<</.test(commentMask(body))) return { error: "it has a heredoc" };
  if (/\$\$|\$\{/.test(commentMask(body))) return { error: "it uses variable variables" };
  const inner = toks.slice(openTok + 1, closeTok);
  // Tokens of the method itself, not of closures in it.
  const own = (i: number) => scopeOpen(toks, openTok + 1 + i) === openTok;
  const returns = inner.map((t, i) => (/^return$/i.test(t.text) && own(i) ? i : -1)).filter((i) => i >= 0);
  if (inner.some((t, i) => /^(yield)$/i.test(t.text) && own(i))) return { error: "it's a generator" };
  if (inner.some((t, i) => /^(static|global)$/i.test(t.text) && inner[i + 1]?.type === "var" && own(i))) return { error: "it has static or global variables" };
  if (inner.some((t) => /^(func_get_args|func_num_args|get_defined_vars|compact|extract)$/i.test(t.text))) return { error: "it reads its variables by name" };
  let statements = body;
  let result: string | null = null;
  if (returns.length) {
    const last = returns.at(-1)!;
    let semi = last + 1;
    while (semi < inner.length && inner[semi].text !== ";") semi = inner[semi].type === "open" && inner[semi].match > 0 ? inner[semi].match - openTok : semi + 1;
    if (returns.length > 1 || semi < inner.length - 1) return { error: "it returns from more than one place" };
    statements = source.slice(open + 1, inner[last].start);
    const value = source.slice(inner[last].end, inner[semi]?.start ?? inner[last].end).trim();
    result = value || null;
  }
  const params = parts.params;
  // Variables inside strings would need renaming inside the strings.
  const names = [...params.map((p) => `$${p.name}`), "$this"];
  if (inner.some((t) => t.type === "str" && t.text.startsWith('"') && names.some((n) => new RegExp(`\\${n}\\b`).test(t.text)))) return { error: "it uses a parameter or $this inside a string" };
  // $this in a closure is bound to the object; renamed to a variable, the closure couldn't see it.
  const scopes = closures(inner);
  const thisInClosure = inner.some((t, i) => t.text === "$this" && scopes.some((c) => !c.arrow && c.start < i && i <= c.end));
  const locals = [...new Set(inner.filter((t) => t.type === "var" && !SUPERGLOBALS.has(t.text) && !names.includes(t.text)).map((t) => t.text.slice(1)))];
  return { params, statements, result, usesThis: inner.some((t) => t.text === "$this"), thisInClosure, locals };
}

/**
 * The code that replaces a call of `m`, given the call's arguments and receiver (`$order` in `$order->total()`,
 * null for `$this` or a function). An argument replaces its parameter only where that can't change what runs:
 * a variable the body only reads, a pure value where an expression may stand, or the one argument with side
 * effects, read once in a lone `return` with nothing running before it. Any other runs first into a variable,
 * in argument order, which also lets the body change it. Locals that clash with `taken`, the caller's
 * variable names, get a number. `statements` and `body` run before the call's statement; `result` replaces the call.
 */
export function inlineCall(m: Inlinable, args: string[], receiver: string | null, taken: Set<string>): { statements: string[]; body: string; result: string | null } | { error: string } {
  if (args.some((a) => a.startsWith("..."))) return { error: "it spreads its arguments" };
  if (m.thisInClosure && receiver && receiver !== "$this") return { error: "the method uses $this inside a closure, which can't see another object" };
  const values = new Map<string, string>();
  let positional = 0;
  for (const a of args) {
    const named = a.match(/^(\w+)\s*:(?!:)\s*([\s\S]*)$/);
    const p = named ? m.params.find((q) => q.name === named[1]) : m.params[positional++];
    if (!p) return { error: named ? `it names no parameter $${named[1]}` : "it passes more arguments than the method takes" };
    values.set(p.name, named ? named[2] : a);
  }
  const used = new Set(taken);
  const unique = (name: string) => {
    let n = name;
    for (let i = 2; used.has(n); i++) n = `${name}${i}`;
    used.add(n);
    return n;
  };
  const text = `${m.statements}\u0000${m.result ?? ""}`;
  const toks = tokenize(text);
  const scopes = closures(toks);
  const before: string[] = [];
  const replace = new Map<number, string>();
  // The method's locals first, so a temporary can't take a local's name.
  for (const local of m.locals) {
    const target = used.has(local) ? `$${unique(local)}` : (used.add(local), null);
    if (target) for (const i of varUses(toks, `$${local}`, []).tokens) replace.set(i, target);
  }
  const argValues = m.params.map((p) => values.get(p.name) ?? p.defaultValue);
  const missing = m.params.find((_, i) => argValues[i] === undefined);
  if (missing) return { error: `it doesn't pass $${missing.name}, which has no default` };
  const impure = argValues.filter((v) => !isPure(v!)).length;
  if (m.usesThis && receiver && receiver !== "$this" && !/^\$\w+$/.test(receiver)) {
    const temp = `$${unique("object")}`;
    before.push(`${temp} = ${receiver};`);
    receiver = temp;
  }
  for (const [n, p] of m.params.entries()) {
    const value = argValues[n]!;
    const use = varUses(toks, `$${p.name}`, scopes);
    const pure = isPure(value);
    const variable = /^\$\w+$/.test(value) && value !== "$this";
    // The lone argument with side effects may stay in place if nothing runs before its one read.
    // It runs where it's read, so that read must come first, run once, and not inside a block, loop, or closure.
    const nothingBefore = () => {
      const first = use.tokens[0];
      for (let o = enclosing(toks, first); o >= 0; o = enclosing(toks, o)) if (toks[o].text === "{" || /^(while|for|do)$/i.test(toks[o - 1]?.text ?? "")) return false;
      if (scopes.some((c) => c.start < first && first <= c.end)) return false;
      return isPure(text.slice(0, toks[first].start).replace("\u0000", "").replace(/[\w\s]+\($/, "").replace(/^\s*(echo|print|return)\b/, ""));
    };
    let into: string | null = null;
    if (!use.tokens.length) {
      if (!pure) before.push(`${value};`);
      continue;
    } else if (variable && !use.writes) into = value;
    else if (pure && !use.writes && !use.needsVariable) into = isAtomic(value) ? value : `(${value})`;
    else if (!pure && impure === 1 && use.tokens.length === 1 && !use.writes && !use.needsVariable && nothingBefore()) into = isAtomic(value) ? value : `(${value})`;
    if (into === null) {
      into = `$${unique(p.name)}`;
      before.push(`${into} = ${value};`);
    }
    for (const i of use.tokens) replace.set(i, into);
  }
  if (m.usesThis && receiver && receiver !== "$this") for (const [i, t] of toks.entries()) if (t.text === "$this") replace.set(i, receiver);
  let out = text;
  for (const [i, value] of [...replace.entries()].sort((a, b) => b[0] - a[0])) out = out.slice(0, toks[i].start) + value + out.slice(toks[i].end);
  const [statements, result] = out.split("\u0000");
  return { statements: before, body: statements, result: m.result === null ? null : result };
}

/** Code moved to a new indentation: its common indentation removed and `indent` added, leaving lines inside strings alone. */
export function reindentCode(code: string, indent: string): string[] {
  const trimmed = code.replace(/^\s*\n/, "").replace(/\s+$/, "");
  if (!trimmed.trim()) return [];
  const toks = tokenize(trimmed);
  const lines = trimmed.split("\n");
  // A line that starts inside a multi-line string keeps its text.
  let offset = 0;
  const inString = lines.map((l) => {
    const at = offset;
    offset += l.length + 1;
    return toks.some((t) => t.type === "str" && t.start < at && at < t.end);
  });
  const common = Math.min(...lines.filter((l, i) => l.trim() && !inString[i]).map((l) => l.match(/^[ \t]*/)![0].length));
  return lines.map((l, i) => (inString[i] ? l : l.trim() ? indent + l.slice(common) : ""));
}
