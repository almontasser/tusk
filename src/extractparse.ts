// Text-level PHP expressions for Extract Variable and Extract Constant: the expressions around the caret,
// their other occurrences, where the new statement goes, and names to suggest. Free of editor imports so Node
// can test it. ponytail: a tokenizer and a precedence parser over one statement, not a PHP parser; heredocs
// aren't tokenized, and ternaries (? :) and closures are boundaries rather than expressions.
import { commentMask } from "./comments.ts";

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
        if (o.start < o.from) found.push([o.start, o.end - 1]);
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

/** The selection as an expression, trimmed, or null when it isn't one. */
export function expressionIn(source: string, start: number, end: number): Expr | null {
  const toks = tokenize(source);
  const a = toks.findIndex((t) => t.start >= start);
  let b = -1;
  for (let i = toks.length - 1; i >= 0; i--) if (toks[i].end <= end) (b = i), (i = -1);
  if (a < 0 || b < a) return null;
  if (candidates(toks, a).some(([x, y]) => x === a && y === b)) return toExpr(source, toks, [a, b]);
  return null;
}

/**
 * Occurrences of `expr` between offsets `from` and `to`, in order, including `expr` itself: the same tokens,
 * whatever the spacing, where they form a whole expression, so `$a + $b` doesn't match inside `$a + $b * $c`.
 */
export function occurrences(source: string, expr: Expr, from = 0, to = source.length): Expr[] {
  const toks = tokenize(source);
  const first = toks.findIndex((t) => t.start === expr.start);
  const last = toks.findIndex((t) => t.end === expr.end);
  if (first < 0 || last < first) return [expr];
  const seq = toks.slice(first, last + 1).map((t) => t.text);
  const found: Expr[] = [];
  for (let i = 0; i + seq.length <= toks.length; i++) {
    if (toks[i].start < from || toks[i + seq.length - 1].end > to || seq.some((text, j) => toks[i + j].text !== text)) continue;
    const range: [number, number] = [i, i + seq.length - 1];
    if (i === first || candidates(toks, i).some(([a, b]) => a === range[0] && b === range[1])) found.push(toExpr(source, toks, range));
  }
  return found.length ? found : [expr];
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
  let j = first - 1;
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
  }
  const start = toks[j + 1];
  const lineStart = source.lastIndexOf("\n", start.start - 1) + 1;
  const indent = source.slice(lineStart, start.start).match(/^[ \t]*/)![0];
  // The statement is just the expression: `foo();` becomes `$name = foo();`.
  const only = start.start === uses[0].start && toks[first + tokenCount(toks, first, uses[0].end)]?.text === ";";
  return { offset: start.start, indent, ...(only && uses.length === 1 ? { replace: uses[0] } : {}) };
}

const tokenCount = (toks: Tok[], from: number, end: number) => {
  let n = 0;
  while (toks[from + n] && toks[from + n].end <= end) n++;
  return n;
};

/** The literal or constant expression for Extract Constant: the selection, or the string or number at the caret. */
export function constantAt(source: string, start: number, end: number): Expr | null {
  const toks = tokenize(source);
  if (start === end) {
    const k = tokenAt(toks, start);
    return k >= 0 && (toks[k].type === "str" || toks[k].type === "num") && !/[$]/.test(toks[k].text.startsWith('"') ? toks[k].text : "") ? toExpr(source, toks, [k, k]) : null;
  }
  const expr = expressionIn(source, start, end);
  if (!expr) return null;
  // Only literals, operators, and other constants: no variables, calls, or interpolated strings.
  const inside = toks.filter((t) => t.start >= expr.start && t.end <= expr.end);
  const constant = inside.every((t, i) =>
    t.type === "num" || (t.type === "str" && !(t.text.startsWith('"') && t.text.includes("$"))) || (t.type === "op" && t.text !== "->" && t.text !== "?->") ||
    (t.type === "open" && t.text !== "{") || (t.type === "close" && t.text !== "}") || (t.type === "name" && inside[i + 1]?.text !== "("),
  );
  return constant ? expr : null;
}

/**
 * Where a class constant goes in a class body that opens at `open` (the offset of its `{`): after the class's
 * last constant, or else after its trait `use` lines, or else at the top. `gap` asks for a blank line between the
 * new constant and the code after it.
 */
export function constantPoint(source: string, open: number): { offset: number; gap: boolean; gapBefore: boolean } {
  const toks = tokenize(source);
  const first = toks.findIndex((t) => t.start === open);
  const close = first >= 0 && toks[first].match > 0 ? toks[first].match : toks.length;
  let lastConst = -1;
  let lastUse = -1;
  // The body's top-level statements; nested braces are method bodies, skipped whole.
  for (let i = first + 1; i < close; i++) {
    const t = toks[i];
    if (t.type === "open" && t.text === "{" && t.match > 0) i = t.match;
    else if (t.type === "name" && /^(const|use)$/i.test(t.text)) {
      let end = i;
      while (end < close && toks[end].text !== ";" && toks[end].text !== "{") end++;
      if (toks[end]?.text !== ";") continue;
      if (/^const$/i.test(t.text)) lastConst = toks[end].end;
      else if (lastConst < 0) lastUse = toks[end].end;
      i = end;
    }
  }
  const after = lastConst >= 0 ? lastConst : lastUse >= 0 ? lastUse : open;
  const offset = source.indexOf("\n", after) + 1 || source.length;
  return { offset, gap: lastConst < 0, gapBefore: lastConst < 0 && lastUse >= 0 };
}

const camel = (words: string[]) => words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w[0].toLowerCase() + w.slice(1))).join("");
const words = (text: string) => text.replace(/([a-z\d])([A-Z])/g, "$1 $2").split(/[^A-Za-z\d]+/).filter(Boolean);

/**
 * A variable name for an expression, without `$`, as PhpStorm suggests: `$user->getEmail()` gives `email`,
 * `$item['unit_price']` gives `unitPrice`, `new Invoice()` gives `invoice`, and `count($a)` gives `count`.
 * A name in `taken` gets a number.
 */
export function variableName(expr: string, taken: Set<string> = new Set()): string {
  const flat = expr.replace(/\s+/g, "");
  // An operator outside strings and brackets makes a computed value, not the last operand's.
  let outer = flat.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
  while (/\([^()]*\)|\[[^[\]]*\]/.test(outer)) outer = outer.replace(/\([^()]*\)|\[[^[\]]*\]/g, "");
  const computed = /[-+*/%.<>=!&|^?:~]/.test(outer.replace(/\??->|::/g, "").replace(/^[!@-]/, "").replace(/\d\.\d/g, "0"));
  let m: RegExpMatchArray | null;
  let base = "value";
  if (computed) base = "value";
  else if ((m = flat.match(/^new\\?(?:[\w\\]*\\)?(\w+)/i))) base = m[1];
  else if ((m = flat.match(/\[['"]([A-Za-z_][\w -]*)['"]\]$/))) base = m[1];
  else if ((m = flat.match(/(?:->|::|^)\$?(\w+)(?:\([^()]*(?:\([^()]*\)[^()]*)*\))?$/))) base = m[1].replace(/^(get|is|has)(?=[A-Z])/, "");
  else if (/^['"]/.test(flat)) base = "string";
  const parts = words(base);
  let name = parts.length && !/^\d/.test(parts[0]) ? camel(parts) : "value";
  if (/^(this|value|true|false|null)$/i.test(name) && base !== "value") name = "value";
  let unique = name;
  for (let n = 2; taken.has(unique); n++) unique = `${name}${n}`;
  return unique;
}

/** A constant name for a literal: `'pending review'` gives `PENDING_REVIEW`; anything else gives `VALUE`. */
export function constantName(expr: string, taken: Set<string> = new Set()): string {
  const string = expr.match(/^(['"])(.*)\1$/s)?.[2] ?? "";
  const parts = words(string).slice(0, 5);
  let name = parts.length && !/^\d/.test(parts[0]) ? parts.join("_").toUpperCase() : "VALUE";
  let unique = name;
  for (let n = 2; taken.has(unique); n++) unique = `${name}_${n}`;
  return unique;
}
