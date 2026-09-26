// Text-level PHP helpers for Inline Variable and Change Signature. Free of editor imports so Node
// can test it. ponytail: a scanner for brackets and strings, not a PHP parser; heredocs aren't handled.
import { commentMask } from "./comments.ts";

/** The index of the bracket that closes the one at `open`, skipping strings and nested brackets. -1 if none. */
export function matchBracket(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
    } else if (pairs[c]) stack.push(pairs[c]);
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
    if (c === "'" || c === '"') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
    } else if ("([{".includes(c)) {
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

export type Param = { text: string; name: string; defaultValue?: string; variadic: boolean };

export function parseParams(list: string): Param[] {
  return splitTopLevel(list).map((text) => {
    const m = text.match(/(\.\.\.)?\s*&?\s*\$(\w+)\s*(?:=\s*([\s\S]+))?$/);
    return { text, name: m?.[2] ?? "", defaultValue: m?.[3]?.trim(), variadic: !!m?.[1] };
  });
}

/**
 * The arguments for a call after a signature change, or an error to report. `oldParams` and `newParams`
 * are matched by name. Positional arguments move to their parameter's new position, named arguments stay
 * named, and a parameter left out before a later argument gets its default value.
 */
export function rewriteArgs(args: string[], oldParams: Param[], newParams: Param[]): { args: string[] } | { error: string } {
  if (args.some((a) => a.startsWith("..."))) return { error: "spreads its arguments (...)" };
  const byName = new Map<string, string>();
  const named: string[] = [];
  let positional = 0;
  for (const a of args) {
    const m = a.match(/^(\w+)\s*:(?!:)\s*([\s\S]*)$/);
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
  for (const p of newParams) {
    const value = byName.get(p.name);
    if (value === undefined) {
      if (p.defaultValue === undefined) return { error: `has no value for the new parameter $${p.name}, which has no default` };
      pending.push(p.defaultValue);
      continue;
    }
    if (named.includes(p.name)) namedOut.push(`${p.name}: ${value}`);
    else {
      out.push(...pending, value);
      pending = [];
    }
  }
  // Named arguments must follow positional ones.
  return { args: [...out, ...namedOut] };
}

export type InlinePlan = { error: string } | { assignment: number; assignmentEnd: number; value: string; uses: { line: number; column: number }[] };

/** The index of the first ";" in `text` outside brackets and strings, or -1. */
function statementEnd(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
    } else if ("([{".includes(c)) {
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
