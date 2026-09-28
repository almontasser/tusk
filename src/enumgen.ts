// The enum designer's code: a new enum with its cases and Filament's label, color, icon, and description contracts,
// and, for an enum that exists, its cases and the `match ($this)` arms of those methods read back. Edits to an
// existing enum rewrite only what the designer can read in full; other methods and code stay. No editor imports,
// so Node tests it.
import { addMember, applyEdits, type Edit, Imports, indentCode, lineIndent, type OClass, type Outline, phpString, removeMethod, replaceNode } from "./phpcode.ts";

export type Backing = "string" | "int" | null;
/** The Filament contracts the designer writes, by method. */
export const CONTRACTS = [
  { method: "getLabel", contract: "HasLabel", attr: "label", returns: "string" },
  { method: "getColor", contract: "HasColor", attr: "color", returns: "string | array | null" },
  { method: "getIcon", contract: "HasIcon", attr: "icon", returns: "string | BackedEnum | Htmlable | null" },
  { method: "getDescription", contract: "HasDescription", attr: "description", returns: "string | Htmlable | null" },
] as const;
export type Attr = (typeof CONTRACTS)[number]["attr"];

export type EnumCase = { name: string; value: string; label?: string; color?: string; icon?: string; description?: string };
export type EnumSpec = {
  name: string;
  namespace: string;
  backing: Backing;
  cases: EnumCase[];
  /** Which contracts the enum implements. */
  contracts: Attr[];
  /** Whether labels and descriptions are written with `__()`. */
  translated: boolean;
};

/** A case name from a value or label: `in progress` → `InProgress`. */
export const caseName = (s: string) =>
  s
    .replace(/[^\w\s-]/g, "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("")
    .replace(/^(\d)/, "_$1") || "Case";

/** A value from a case name: `InProgress` → `in_progress`. */
export const caseValue = (name: string) => name.replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase();

/** A label from a case name: `InProgress` → `In progress`. */
export const caseLabel = (name: string) => {
  const words = name.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const valueCode = (c: EnumCase, backing: Backing) => (backing === "int" ? String(Number(c.value) || 0) : phpString(c.value));

/** An attribute's value as PHP: text in `__()` when translated, an icon as Heroicon's case. */
export function attrCode(attr: Attr, value: string, o: { translated: boolean; heroicon: boolean }): string {
  if (attr === "icon") {
    if (/^[A-Z]\w*$/.test(value) && o.heroicon) return `Heroicon::${value}`;
    return phpString(value);
  }
  if (attr === "color") return phpString(value);
  return o.translated ? `__(${phpString(value)})` : phpString(value);
}

/** A `match ($this)` for one attribute, with each case that has a value, and `null` for the rest when allowed. */
export function matchCode(spec: Pick<EnumSpec, "cases" | "translated">, attr: Attr, heroicon: boolean): string {
  // Cases with the same value share an arm, as `self::Shipped, self::Delivered => 'success'`.
  const byValue = new Map<string, string[]>();
  for (const c of spec.cases.filter((c) => c[attr])) byValue.set(c[attr]!, [...(byValue.get(c[attr]!) ?? []), `self::${c.name}`]);
  const arms = [...byValue].map(([value, names]) => `    ${names.join(", ")} => ${attrCode(attr, value, { translated: spec.translated, heroicon })},`);
  const rest = spec.cases.filter((c) => !c[attr]);
  if (rest.length) arms.push(`    ${attr === "label" ? rest.map((c) => `self::${c.name}`).join(", ") : "default"} => ${attr === "label" ? "$this->name" : "null"},`);
  return `match ($this) {\n${arms.join("\n")}\n}`;
}

/** A method that returns an attribute, such as getLabel(). */
export function methodCode(spec: Pick<EnumSpec, "cases" | "translated">, attr: Attr, heroicon: boolean): string {
  const c = CONTRACTS.find((x) => x.attr === attr)!;
  const returns = spec.cases.some((x) => !x[attr]) && attr === "label" ? "string" : c.returns;
  return `public function ${c.method}(): ${returns}\n{\n    return ${matchCode(spec, attr, heroicon).replace(/\n/g, "\n    ")};\n}`;
}

/** The imports a method's return type and values need. */
function importsFor(spec: EnumSpec, heroicon: boolean): string[] {
  const uses = new Set<string>();
  for (const attr of spec.contracts) {
    uses.add(`Filament\\Support\\Contracts\\${CONTRACTS.find((c) => c.attr === attr)!.contract}`);
    if (attr === "icon") uses.add("BackedEnum"), uses.add("Illuminate\\Contracts\\Support\\Htmlable");
    if (attr === "description") uses.add("Illuminate\\Contracts\\Support\\Htmlable");
  }
  if (heroicon && spec.contracts.includes("icon") && spec.cases.some((c) => c.icon && /^[A-Z]\w*$/.test(c.icon))) uses.add("Filament\\Support\\Icons\\Heroicon");
  return [...uses].sort((a, b) => a.localeCompare(b));
}

/** A new enum's file. */
export function enumFile(spec: EnumSpec, o: { heroicon: boolean }): string {
  const contracts = CONTRACTS.filter((c) => spec.contracts.includes(c.attr)).map((c) => c.contract);
  const head = `enum ${spec.name}${spec.backing ? `: ${spec.backing}` : ""}${contracts.length ? ` implements ${contracts.join(", ")}` : ""}`;
  const cases = spec.cases.map((c) => `    case ${c.name}${spec.backing ? ` = ${valueCode(c, spec.backing)}` : ""};`).join("\n\n");
  const methods = CONTRACTS.filter((c) => spec.contracts.includes(c.attr)).map((c) => "    " + methodCode(spec, c.attr, o.heroicon).replace(/\n/g, "\n    "));
  const uses = importsFor(spec, o.heroicon);
  return `<?php

namespace ${spec.namespace};
${uses.length ? `\n${uses.map((u) => `use ${u};`).join("\n")}\n` : ""}
${head}
{
${[cases, ...methods].filter(Boolean).join("\n\n")}
}
`;
}

// ---- Reading ----

/** Splits code at commas outside strings, parentheses, and brackets. */
export function splitTopLevel(code: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) (out.push(code.slice(start, i)), (start = i + 1));
  }
  out.push(code.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** A value the designer can edit: a string, a translated string, a number, or a Heroicon case. */
function readValue(code: string, attr: Attr): { value: string; translated: boolean } | null {
  const str = /^'((?:[^'\\]|\\.)*)'$/.exec(code) ?? /^"((?:[^"\\$]|\\.)*)"$/.exec(code);
  if (str) return { value: str[1].replace(/\\(['"\\])/g, "$1"), translated: false };
  const tr = /^__\(\s*'((?:[^'\\]|\\.)*)'\s*\)$/.exec(code);
  if (tr && attr !== "icon" && attr !== "color") return { value: tr[1].replace(/\\(['\\])/g, "$1"), translated: true };
  const icon = /^Heroicon::(\w+)$/.exec(code);
  if (icon && attr === "icon") return { value: icon[1], translated: false };
  return null;
}

/**
 * The value each case gets from a `match ($this) { … }`, or null when the match has anything the designer can't
 * write back: a `default` arm, conditions other than `self::Case`, or values that are code.
 */
export function readMatch(code: string, attr: Attr): { values: Record<string, string>; translated: boolean } | null {
  const m = /^match\s*\(\s*\$this\s*\)\s*\{([\s\S]*)\}\s*$/.exec(code.trim());
  if (!m) return null;
  const values: Record<string, string> = {};
  let translated = false;
  let pending: string[] = [];
  for (const part of splitTopLevel(m[1])) {
    const arrow = part.indexOf("=>");
    if (arrow < 0) {
      if (!/^(self|static)::\w+$/.test(part)) return null;
      pending.push(part);
      continue;
    }
    const conds = [...pending, part.slice(0, arrow).trim()];
    pending = [];
    const valueCode = part.slice(arrow + 2).trim();
    // The designer writes `$this->name` for labels it has none of, and `null` for other attributes.
    if (valueCode === "$this->name" || valueCode === "null") continue;
    const v = readValue(valueCode, attr);
    if (!v) return null;
    translated ||= v.translated;
    for (const cond of conds.flatMap((c) => c.split(",").map((x) => x.trim()))) {
      if (cond === "default") continue;
      const name = /^(self|static)::(\w+)$/.exec(cond)?.[2];
      if (!name) return null;
      values[name] = v.value;
    }
  }
  return { values, translated };
}

// ---- Changing an enum that exists ----


/** A case as the designer edits it: `original` is its name in the file, for renames. */
export type DesignedCase = EnumCase & { original?: string };

/** What the designer read from an enum's file: its cases, and each contract's values when its match can be read. */
export type ReadEnum = { spec: EnumSpec; readable: Record<Attr, boolean>; present: Record<Attr, boolean>; cls: OClass };

/** Reads an enum's file into the designer's spec. */
export function readEnum(text: string, outline: Outline): ReadEnum | null {
  const cls = outline.classes.find((c) => c.kind === "enum");
  if (!cls) return null;
  const head = text.slice(cls.span[0], cls.bodyStart);
  const backing = (/:\s*(string|int)\b/.exec(head)?.[1] ?? null) as Backing;
  const cases: EnumCase[] = cls.cases.map((c) => ({ name: c.name, value: c.value ? (c.value.kind === "string" ? c.value.value : text.slice(c.value.span[0], c.value.span[1])) : "" }));
  const readable = {} as Record<Attr, boolean>;
  const present = {} as Record<Attr, boolean>;
  let translated = false;
  for (const c of CONTRACTS) {
    const method = cls.methods.find((m) => m.name === c.method);
    present[c.attr] = !!method;
    const ret = method?.returns[0];
    const read = ret ? readMatch(text.slice(ret.span[0], ret.span[1]), c.attr) : null;
    readable[c.attr] = !method || !!read;
    if (read) {
      translated ||= read.translated;
      for (const k of cases) if (read.values[k.name] !== undefined) k[c.attr] = read.values[k.name];
    }
  }
  return { cls, readable, present, spec: { name: cls.name, namespace: outline.namespace ?? "", backing, cases, contracts: CONTRACTS.filter((c) => present[c.attr]).map((c) => c.attr), translated } };
}

/**
 * The edits that turn an enum's file into the designed one. Cases are written again as one block; a renamed case's
 * `self::` references follow it. Methods the designer can read are rewritten; ones it can't are left, unless their
 * contract was turned off.
 */
export function enumEdits(text: string, outline: Outline, before: ReadEnum, designed: { cases: DesignedCase[]; contracts: Attr[]; translated: boolean }, o: { heroicon: boolean }): Edit[] {
  const cls = before.cls;
  const edits: Edit[] = [];
  const imports = new Imports(text, outline);
  const spec = { cases: designed.cases, translated: designed.translated };
  const methodSpans: [number, number][] = [];

  // Methods: rewrite, add, or remove.
  for (const c of CONTRACTS) {
    const method = cls.methods.find((m) => m.name === c.method);
    const want = designed.contracts.includes(c.attr);
    if (method && !want) {
      edits.push(removeMethod(text, method));
      methodSpans.push([method.docStart ?? method.span[0], method.span[1]]);
    } else if (method && want && before.readable[c.attr] && method.returns[0]) {
      const ret = method.returns[0];
      const code = matchCode(spec, c.attr, o.heroicon);
      edits.push(replaceNode(text, ret, code));
      methodSpans.push(ret.span);
      // A `default => null` arm needs a return type that allows null.
      const type = method.body && /\)\s*:\s*([^{]+?)\s*\{?$/.exec(text.slice(method.span[0], method.body[0]));
      if (type && /=> null,/.test(code) && !/null|mixed|\?/.test(type[1])) {
        const at = method.span[0] + type.index + type[0].indexOf(type[1], type[0].indexOf(":"));
        edits.push({ start: at, end: at + type[1].length, text: c.returns });
      }
    } else if (!method && want) {
      edits.push(addMember(text, cls, methodCode(spec, c.attr, o.heroicon)));
      imports.name(`Filament\\Support\\Contracts\\${c.contract}`);
      if (c.attr === "icon") imports.name("BackedEnum"), imports.name("Illuminate\\Contracts\\Support\\Htmlable");
      if (c.attr === "description") imports.name("Illuminate\\Contracts\\Support\\Htmlable");
    }
    if (want && c.attr === "icon" && o.heroicon && designed.cases.some((k) => k.icon && /^[A-Z]\w*$/.test(k.icon))) imports.name("Filament\\Support\\Icons\\Heroicon");
  }

  // The `implements` list: the enum's own interfaces, with Filament's contracts added or removed.
  const headEnd = text.lastIndexOf("{", cls.bodyStart);
  const head = text.slice(cls.span[0], headEnd);
  const impl = /\s+implements\s+([\w\\,\s]+?)\s*$/.exec(head);
  const current = impl ? impl[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
  const shortOf = (s: string) => s.slice(s.lastIndexOf("\\") + 1);
  const keep = current.filter((i) => !CONTRACTS.some((c) => c.contract === shortOf(i) && !designed.contracts.includes(c.attr)));
  for (const c of CONTRACTS) if (designed.contracts.includes(c.attr) && !keep.some((i) => shortOf(i) === c.contract)) keep.push(imports.name(`Filament\\Support\\Contracts\\${c.contract}`));
  if (keep.join(",") !== current.join(",")) {
    const listStart = impl ? cls.span[0] + impl.index : cls.span[0] + head.replace(/\s+$/, "").length;
    const listEnd = cls.span[0] + head.replace(/\s+$/, "").length;
    edits.push({ start: listStart, end: listEnd, text: keep.length ? ` implements ${keep.join(", ")}` : "" });
  }

  // Cases, as one block, in the designed order.
  const cases = cls.cases;
  const changed = JSON.stringify(designed.cases.map((c) => [c.original, c.name, c.value])) !== JSON.stringify(cases.map((c) => [c.name, c.name, before.spec.cases.find((k) => k.name === c.name)?.value]));
  if (changed) {
    const indent = cases[0] ? lineIndent(text, cases[0].span[0]) : lineIndent(text, cls.bodyStart) + "    ";
    const spaced = cases.length > 1 ? /\n[ \t]*\n/.test(text.slice(cases[0].span[1], cases[1].span[0])) : true;
    const backing = before.spec.backing;
    const block = designed.cases.map((c) => `case ${c.name}${backing ? ` = ${backing === "int" ? String(Number(c.value) || 0) : `'${c.value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`}` : ""};`).join(spaced ? "\n\n" : "\n");
    if (cases.length) {
      const start = text.lastIndexOf("\n", cases[0].span[0] - 1) + 1;
      const last = cases[cases.length - 1];
      const end = text.indexOf(";", last.span[1] - 1) + 1 || last.span[1];
      edits.push({ start, end, text: indent + indentCode(block, indent) });
    } else if (designed.cases.length) edits.push({ start: cls.bodyStart, end: cls.bodyStart, text: `\n${indent}${indentCode(block, indent)}\n` });
    // A renamed case's references elsewhere in the file follow it, outside what's rewritten anyway.
    for (const c of designed.cases) {
      if (!c.original || c.original === c.name) continue;
      const re = new RegExp(`\\b(self|static|${cls.name})::${c.original}\\b`, "g");
      for (const m of text.matchAll(re)) {
        const at = m.index!;
        if (methodSpans.some(([s, e]) => at >= s && at < e)) continue;
        if (cases.some((k) => at >= k.span[0] && at < k.span[1])) continue;
        edits.push({ start: at, end: at + m[0].length, text: `${m[1]}::${c.name}` });
      }
    }
  }
  return [...edits, ...imports.edits()];
}

/** The text an enum's file will have after `enumEdits`, for the designer's preview. */
export const previewEnum = (text: string, edits: Edit[]) => applyEdits(text, edits);
