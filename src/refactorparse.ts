// Text-level PHP helpers for Inline Variable and Change Signature. Free of editor imports so Node
// can test it. ponytail: a scanner for brackets and strings, not a PHP parser; heredocs aren't handled.
import { commentMask } from "./comments.ts";

/**
 * Where a string or comment that starts at `i` ends (its last character), or -1 when none starts there, so a
 * quote in `// don't` doesn't open a string. `#[` is an attribute, not a comment.
 */
function skipQuoted(text: string, i: number): number {
  const c = text[i];
  if (c === "'" || c === '"') {
    for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
    return i;
  }
  if ((c === "/" && text[i + 1] === "/") || (c === "#" && text[i + 1] !== "[")) {
    const end = text.indexOf("\n", i);
    return end < 0 ? text.length : end - 1;
  }
  if (c === "/" && text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end < 0 ? text.length : end + 1;
  }
  return -1;
}

/** The index of the bracket that closes the one at `open`, skipping strings, comments, and nested brackets. -1 if none. */
export function matchBracket(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    const skip = skipQuoted(text, i);
    if (skip >= 0) i = skip;
    else if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** Splits at commas that aren't inside brackets or strings, trimming each part. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const skip = skipQuoted(text, i);
    if (skip >= 0) i = skip;
    else if ("([{".includes(c)) {
      const end = matchBracket(text, i);
      if (end < 0) break;
      i = end;
    } else if (c === ",") {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p, i, all) => p || i < all.length - 1);
}

/** An argument's code and the line comment that ends it, if any: `$b // why` gives `$b` and `// why`. */
function trailingComment(arg: string): [string, string] {
  for (let i = 0; i < arg.length; i++) {
    const skip = skipQuoted(arg, i);
    if (skip < 0) continue;
    const line = (arg[i] === "/" && arg[i + 1] === "/") || (arg[i] === "#" && arg[i + 1] !== "[");
    if (line && skip >= arg.length - 1) return [arg.slice(0, i).trimEnd(), arg.slice(i)];
    i = skip;
  }
  return [arg, ""];
}

/**
 * A call's new arguments, written as the old ones were: one per line with trailing commas when they were, and
 * always when one ends in a line comment, which would otherwise swallow what follows it. `lineIndent` is the
 * indentation of the call's line, for a list that wasn't one per line before.
 */
export function formatArgs(args: string[], original: string, lineIndent: string, unit = "    "): string {
  const indent = original.match(/\n([ \t]*)\S/)?.[1];
  const parts = args.map(trailingComment);
  if (indent === undefined && !parts.some(([, c]) => c)) return args.join(", ");
  const close = original.match(/\n([ \t]*)$/)?.[1] ?? lineIndent;
  return `\n${parts.map(([code, c]) => `${indent ?? lineIndent + unit}${code},${c ? ` ${c}` : ""}`).join("\n")}\n${close}`;
}

/**
 * A parameter. `type` is everything before the name: attributes, a promoted property's modifiers, and the type.
 * In a new signature, `from` is the old parameter's name, and `callValue` the value to pass in existing calls
 * for a new parameter (its default value when unset).
 */
export type Param = { text: string; name: string; type: string; byRef: boolean; defaultValue?: string; variadic: boolean; from?: string; callValue?: string };

export function parseParams(list: string): Param[] {
  return splitTopLevel(list).map((text) => {
    const m = text.match(/^([\s\S]*?)\s*(&)?\s*(\.\.\.)?\s*\$(\w+)\s*(?:=\s*([\s\S]+))?$/);
    return { text, type: m?.[1].trim() ?? "", byRef: !!m?.[2], name: m?.[4] ?? "", defaultValue: m?.[5]?.trim(), variadic: !!m?.[3] };
  });
}

/** A parameter's declaration, as `private readonly int &...$name = 1`. */
export const paramText = (p: Param) => `${p.type ? `${p.type} ` : ""}${p.byRef ? "&" : ""}${p.variadic ? "..." : ""}$${p.name}${p.defaultValue !== undefined && p.defaultValue !== "" ? ` = ${p.defaultValue}` : ""}`;

/**
 * The parts of a function's declaration whose name ends at `nameEnd`: offsets of its modifiers' start, its
 * parameter list's brackets, and the end of its return type (or of the list, without one). `indent` is the
 * parameters' indentation when they're one per line, or null.
 */
export function declarationParts(text: string, nameEnd: number) {
  const before = text.slice(0, nameEnd).match(/((?:(?:public|protected|private|static|abstract|final)\s+)*)function\s+(&?)\s*(\w+)$/);
  const open = text.indexOf("(", nameEnd);
  const close = open >= 0 ? matchBracket(text, open) : -1;
  if (!before || close < 0) return null;
  const start = nameEnd - before[0].length;
  const ret = text.slice(close + 1).match(/^\s*:\s*([^{;]*?)\s*(?=[{;]|$)/);
  const list = text.slice(open + 1, close);
  const lineStart = text.lastIndexOf("\n", start) + 1;
  return {
    start,
    open,
    close,
    end: ret ? close + 1 + ret[0].trimEnd().length : close + 1,
    modifiers: before[1].trim(),
    byRef: before[2] === "&",
    name: before[3],
    returnType: ret?.[1] ?? "",
    params: parseParams(list.replace(/,\s*$/, "")),
    headerIndent: text.slice(lineStart, start).match(/^[ \t]*/)![0],
    indent: list.includes("\n") ? (list.match(/\n([ \t]*)\S/)?.[1] ?? null) : null,
  };
}

/** A parameter list, one per line with a trailing comma when `indent` is set, as Laravel's style writes long ones. */
export function formatParams(params: Param[], indent: string | null, closeIndent: string): string {
  const texts = params.map(paramText);
  if (indent === null || !texts.length) return texts.join(", ");
  return `\n${texts.map((t) => `${indent}${t},`).join("\n")}\n${closeIndent}`;
}

/**
 * The arguments for a call after a signature change, or an error to report. `oldParams` and `newParams`
 * are matched by name. Positional arguments move to their parameter's new position, named arguments stay
 * named, and a parameter left out before a later argument gets its default value.
 */
export function rewriteArgs(args: string[], oldParams: Param[], newParams: Param[]): { args: string[] } | { error: string } {
  // A first-class callable, foo(...), passes no arguments to rewrite.
  if (args.length === 1 && args[0] === "...") return { args };
  if (args.some((a) => a.startsWith("..."))) return { error: "spreads its arguments (...)" };
  const byName = new Map<string, string>();
  const named: string[] = [];
  let positional = 0;
  for (const a of args) {
    const m = a.match(/^(\w+)\s*:(?!:)\s*([\s\S]*)$/);
    // Named arguments are matched to the old parameters by name.
    if (m) {
      byName.set(m[1], m[2]);
      named.push(m[1]);
    } else {
      const param = oldParams[positional++];
      if (!param) return { error: "passes more arguments than the function declares" };
      if (param.variadic) return { error: "passes variadic arguments" };
      byName.set(param.name, a);
    }
  }
  const out: string[] = [];
  let pending: string[] = [];
  const namedOut: string[] = [];
  // Once an argument has to be named, every one after it must be too: a positional one would take its place.
  let naming = false;
  for (const p of newParams) {
    const old = p.from ?? p.name;
    let value = byName.get(old);
    if (value === undefined) {
      const fill = p.callValue || p.defaultValue;
      if (fill === undefined || fill === "") return { error: `has no value for the new parameter $${p.name}, which has no default` };
      // A default is written only when a later positional argument needs its place; a value for calls always is.
      if (!p.callValue || p.variadic) {
        if (!naming) pending.push(fill);
        continue;
      }
      value = fill;
    } else if (named.includes(old)) naming = true;
    if (naming) {
      if (p.variadic) return { error: `would pass the variadic $${p.name} after named arguments` };
      namedOut.push(`${p.name}: ${value}`);
    } else {
      out.push(...pending, value);
      pending = [];
    }
  }
  // Named arguments must follow positional ones.
  return { args: [...out, ...namedOut] };
}

// ---- Change Signature ----

export type Signature = { modifiers: string; name: string; returnType: string; params: Param[] };
const IDENTIFIER = /^[A-Za-z_\x80-\uffff][\w\x80-\uffff]*$/;

/** The declaration a signature writes, for the preview line. */
export const signatureText = (s: Signature) =>
  `${s.modifiers ? `${s.modifiers} ` : ""}function ${s.name}(${s.params.map(paramText).join(", ")})${s.returnType ? `: ${s.returnType}` : ""}`;

/** What's wrong with a signature, or null. `before` is the old one, for parameters that must keep their name. */
export function signatureProblem(s: Signature, before: Signature, kind: "method" | "function" | "constructor"): string | null {
  if (!IDENTIFIER.test(s.name)) return "The name must be a valid PHP name.";
  const names = s.params.map((p) => p.name);
  const bad = s.params.find((p) => !IDENTIFIER.test(p.name));
  if (bad) return bad.name ? `$${bad.name} isn't a valid parameter name.` : "Each parameter needs a name.";
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) return `Two parameters are named $${twice}.`;
  const variadic = s.params.findIndex((p) => p.variadic);
  if (variadic >= 0 && variadic < s.params.length - 1) return `The variadic parameter $${s.params[variadic].name} must come last.`;
  for (const p of s.params) {
    if (!p.from && !p.defaultValue && !p.callValue && !p.variadic) return `The new parameter $${p.name} needs a default value or a value for existing calls.`;
    const old = before.params.find((o) => o.name === p.from);
    // A promoted property's name is also a property name; Rename (⇧F6) changes both.
    if (kind === "constructor" && old && p.name !== old.name && /\b(public|protected|private|readonly)\b/.test(old.type)) return `$${old.name} is a promoted property. Rename it with Rename (⇧F6).`;
  }
  return null;
}

/** A signature PHP accepts but deprecates: an optional parameter before a required one acts as required. */
export function signatureWarning(s: Signature): string | null {
  const isRequired = (p: Param) => !p.defaultValue && !p.variadic;
  const optional = s.params.findIndex((p, i) => !isRequired(p) && s.params.slice(i + 1).some(isRequired));
  if (optional < 0) return null;
  const required = s.params.slice(optional + 1).find(isRequired)!;
  return `$${s.params[optional].name} is optional but comes before the required $${required.name}, so PHP treats it as required.`;
}

export type InlinePlan = { error: string } | { assignment: number; assignmentEnd: number; value: string; uses: { line: number; column: number }[] };

/** The index of the first ";" in `text` outside brackets and strings, or -1. */
function statementEnd(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const skip = skipQuoted(text, i);
    if (skip >= 0) i = skip;
    else if ("([{".includes(c)) {
      const end = matchBracket(text, i);
      if (end < 0) return -1;
      i = end;
    } else if (c === ";") return i;
  }
  return -1;
}

/**
 * Plans inlining `$name` within lines [from, to] (1-based): exactly one plain assignment starting its line,
 * possibly continuing over the lines after it, no other writes, and uses only after it. Columns are
 * 1-based offsets of the `$`. `assignment` to `assignmentEnd` are the lines the assignment takes.
 */
export function planInline(lines: string[], name: string, from: number, to: number): InlinePlan {
  const word = new RegExp(`\\$${name}(?![\\w])`, "g");
  let assignment = 0;
  let assignmentEnd = 0;
  let value = "";
  const uses: { line: number; column: number }[] = [];
  for (let n = from; n <= to; n++) {
    const text = lines[n - 1] ?? "";
    for (const m of text.matchAll(word)) {
      const after = text.slice(m.index! + m[0].length);
      const before = text.slice(0, m.index);
      const plain = /^\s*=(?!=|>)/.test(after);
      if (plain && !assignment && /^\s*$/.test(before)) {
        // The statement runs to the first ";" outside brackets and strings, on this line or a later one.
        const full = lines.slice(n - 1, to).join("\n");
        const valueStart = m.index! + m[0].length + after.match(/^\s*=\s*/)![0].length;
        const semicolon = statementEnd(full.slice(valueStart));
        if (semicolon < 0) return { error: `the assignment on line ${n} doesn't end` };
        const end = valueStart + semicolon;
        const lineEnd = full.indexOf("\n", end);
        if (!/^\s*(\/\/.*)?$/.test(full.slice(end + 1, lineEnd < 0 ? undefined : lineEnd))) return { error: `there's more code after the assignment to $${name}` };
        const lastLine = n + (full.slice(0, end).match(/\n/g)?.length ?? 0);
        value = full.slice(valueStart, end).trim();
        assignment = n;
        assignmentEnd = lastLine;
        n = lastLine; // Skip the assignment's own lines.
        break;
      }
      if (plain || /^\s*(\[[^\]]*\]|->\w+)*\s*([-+*/.%&|^]|\?\?|<<|>>|\*\*)?=(?!=|>)/.test(after) || /^\s*(\+\+|--)/.test(after) || /(\+\+|--|&)\s*$/.test(before) || /\bas\s+(\$\w+\s*=>\s*)?$/.test(before) || /\b(global|static|unset)\b/.test(before))
        return { error: `$${name} is changed on line ${n}` };
      if (!assignment) return { error: `$${name} is used on line ${n}, before it's assigned` };
      // A closure's use list takes a variable, not a value.
      if (/\buse\s*\([^)]*$/.test(before)) return { error: `a closure on line ${n} captures $${name}` };
      uses.push({ line: n, column: m.index! + 1 });
    }
  }
  if (!assignment) return { error: `there's no assignment to $${name}` };
  if (!uses.length) return { error: `$${name} isn't used after its assignment` };
  // Parentheses keep the meaning where the value is an expression, such as $a + $b.
  // A method chain broken over lines counts as one simple value.
  const flat = value.replace(/\s*\n\s*/g, "");
  const simple = /^(\$?[\w\\]+|'[^']*'|"[^"]*"|\d+(\.\d+)?)((->|\?->|::)\$?\w+)*(\([^()]*\))?((->|\?->|::)\w+(\([^()]*\))?)*$/.test(flat) || /^\[.*\]$/s.test(flat);
  return { assignment, assignmentEnd, value: simple ? value : `(${value})`, uses };
}

export type Property = { name: string; type: string; isStatic: boolean; readonly: boolean; hasDefault: boolean; promoted: boolean; end: number };

// Modifiers, then an optional type: groups 1 and 2.
const MODIFIERS = String.raw`((?:(?:public|protected|private|var|static|readonly)(?:\(set\))?\s+)+)(?:([?\w\\|&()]+)\s+)?`;

/**
 * The properties a class body (the text between its braces) declares, in order, then its promoted constructor
 * parameters. `end` is the offset of a declaration's `;`, or -1 for a promoted one. ponytail: `public $a, $b;`
 * yields only `$a`.
 */
export function classProperties(body: string): Property[] {
  const code = commentMask(`<?php ${body}`).slice(6);
  // Only the top level: each method body becomes spaces ending in `;`, so the next declaration still follows one.
  let top = "";
  for (let i = 0; i < code.length; i++) {
    const end = code[i] === "{" ? matchBracket(code, i) : -1;
    if (end < 0) top += code[i];
    else (top += " ".repeat(end - i) + ";"), (i = end);
  }
  const props: Property[] = [];
  for (const m of top.matchAll(new RegExp(String.raw`(?:^|[;\]])\s*${MODIFIERS}\$(\w+)\s*(=)?`, "g"))) {
    const mods = m[1].split(/\s+/);
    const end = top.indexOf(";", m.index + m[0].length);
    props.push({ name: m[3], type: m[2] ?? "", isStatic: mods.includes("static"), readonly: mods.includes("readonly"), hasDefault: !!m[4], promoted: false, end });
  }
  const ctor = top.match(/\bfunction\s+__construct\s*\(/i);
  const close = ctor ? matchBracket(code, ctor.index! + ctor[0].length - 1) : -1;
  if (close >= 0)
    for (const param of splitTopLevel(code.slice(ctor!.index! + ctor![0].length, close))) {
      const m = param.match(new RegExp(String.raw`^${MODIFIERS}&?\s*\$(\w+)`));
      if (m) props.push({ name: m[3], type: m[2] ?? "", isStatic: false, readonly: m[1].includes("readonly"), hasDefault: false, promoted: true, end: -1 });
    }
  return props;
}
