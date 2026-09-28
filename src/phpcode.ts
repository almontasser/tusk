// Reads and edits PHP through Tusk's server's outline (`tusk/phpOutline`): classes with their properties, methods,
// and return expressions as trees of nodes with UTF-16 ranges. The designers change code with small edits at those
// ranges, so comments, closures, and formatting they don't touch stay as written. No editor imports, so Node tests it.

export type Span = [number, number];

export type PArgs = { open: number; close: number; items: { name: string | null; value: PNode; span: Span; spread: boolean }[] };
export type PCall = { name: string; nullsafe: boolean; args: PArgs; span: Span; nameSpan: Span };
export type PItem = { key: PNode | null; value: PNode; span: Span; spread: boolean };
export type PNode = { span: Span } & (
  | { kind: "string"; value: string; quote: "single" | "double" | "heredoc" | "nowdoc"; interpolated: boolean }
  | { kind: "number"; value: number; raw: string }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "array"; items: PItem[]; open: number; close: number; legacy: boolean }
  | { kind: "static"; class: string; classSpan: Span; method: string; args: PArgs }
  | { kind: "classConst"; class: string; classSpan: Span; name: string }
  | { kind: "staticProp"; class: string; name: string }
  | { kind: "var"; name: string }
  | { kind: "prop"; object: PNode; name: string; nullsafe: boolean }
  | { kind: "func"; name: string; nameSpan: Span; args: PArgs }
  | { kind: "new"; class: string; args: PArgs | null }
  | { kind: "chain"; base: PNode; calls: PCall[] }
  | { kind: "closure"; arrow: boolean; static: boolean; params: string[]; body: Span }
  | { kind: "const"; name: string }
  | { kind: "concat"; parts: PNode[] }
  | { kind: "other" }
);
export type ArrayNode = Extract<PNode, { kind: "array" }>;
export type StaticNode = Extract<PNode, { kind: "static" }>;
export type ChainNode = Extract<PNode, { kind: "chain" }>;

/** An attribute: `span` covers `Name(args)`, and `list` the whole `#[...]` group it's in. */
export type OAttribute = { name: string; args: PArgs | null; span: Span; list: Span };
export type OProperty = { name: string; static: boolean; visibility: string; readonly: boolean; type: string | null; value: PNode | null; span: Span; attributes: OAttribute[] };
export type OMethod = {
  name: string;
  static: boolean;
  abstract: boolean;
  visibility: string;
  params: { name: string; type: string | null; default: PNode | null; span: Span }[];
  returnType: string | null;
  attributes: OAttribute[];
  span: Span;
  docStart: number | null;
  body: Span | null;
  returns: PNode[];
};
export type OClass = {
  kind: "class" | "enum" | "trait" | "interface";
  name: string;
  fqn: string;
  abstract: boolean;
  final: boolean;
  extends: string | null;
  implements: string[];
  traits: string[];
  attributes: OAttribute[];
  span: Span;
  bodyStart: number;
  bodyEnd: number;
  constants: { name: string; value: PNode | null; span: Span }[];
  cases: { name: string; value: PNode | null; span: Span }[];
  properties: OProperty[];
  methods: OMethod[];
};
export type Outline = {
  errors: boolean;
  namespace: string | null;
  uses: { alias: string; name: string; kind: "class" | "function" | "const"; span: Span }[];
  useInsert: number;
  classes: OClass[];
};

/** A change to a text: replace `start..end` with `text`. Offsets are UTF-16, as JavaScript strings count. */
export type Edit = { start: number; end: number; text: string };

/** Applies edits that don't overlap, given against the same original text. */
export function applyEdits(text: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Edits that start where another ends, or insert at one offset, go together, in order, as one edit. */
export function mergeEdits(edits: Edit[]): Edit[] {
  const sorted = [...edits].map((e, i) => ({ ...e, i })).sort((a, b) => a.start - b.start || a.i - b.i);
  const out: Edit[] = [];
  for (const e of sorted) {
    const prev = out.at(-1);
    if (prev && prev.start === prev.end && e.start === e.end && prev.start === e.start) prev.text += e.text;
    else if (prev && e.start < prev.end) throw new Error("Two changes overlap. Try one at a time.");
    else out.push({ start: e.start, end: e.end, text: e.text });
  }
  return out;
}

// ---- Values ----

/** Code to write as it is, such as a class constant or a closure. */
export class Raw {
  code: string;
  constructor(code: string) {
    this.code = code;
  }
}
export const raw = (code: string) => new Raw(code);
export type PhpValue = string | number | boolean | null | Raw | PhpValue[] | { [key: string]: PhpValue };

/** A single-quoted PHP string. */
export const phpString = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/**
 * A value as PHP code. Lists and maps of more than one entry, or with a nested array, go on several lines, each
 * indented one `unit` more than `indent`, the indentation of the line the value starts on.
 */
export function phpValue(value: PhpValue, indent = "", unit = "    "): string {
  if (value instanceof Raw) return value.code.replace(/\n/g, `\n${indent}`);
  if (value === null) return "null";
  if (typeof value === "string") return phpString(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
  if (typeof value === "boolean") return value ? "true" : "false";
  const list = Array.isArray(value);
  const entries: [string | null, PhpValue][] = list ? value.map((v) => [null, v]) : Object.entries(value);
  if (!entries.length) return "[]";
  const inner = indent + unit;
  const parts = entries.map(([k, v]) => (k === null ? "" : `${/^(0|[1-9]\d*)$/.test(k) ? k : phpString(k)} => `) + phpValue(v, inner, unit));
  const nested = entries.some(([, v]) => typeof v === "object" && v !== null && !(v instanceof Raw));
  const flat = `[${parts.join(", ")}]`;
  if (!nested && (entries.length === 1 || (list && flat.length <= 60)) && !flat.includes("\n")) return flat;
  return `[\n${parts.map((p) => `${inner}${p},`).join("\n")}\n${indent}]`;
}

/** What a node holds, when it's a plain value: strings, numbers, booleans, null, and arrays of them. */
export function nodeValue(node: PNode | null | undefined): PhpValue | undefined {
  if (!node) return undefined;
  switch (node.kind) {
    case "string":
      return node.interpolated ? undefined : node.value;
    case "number":
      return node.value;
    case "bool":
      return node.value;
    case "null":
      return null;
    case "array": {
      const list = node.items.every((i) => !i.key);
      const out: PhpValue[] | Record<string, PhpValue> = list ? [] : {};
      for (const item of node.items) {
        const v = nodeValue(item.value);
        if (v === undefined || item.spread) return undefined;
        if (list) (out as PhpValue[]).push(v);
        else {
          const k = nodeValue(item.key);
          if (typeof k !== "string" && typeof k !== "number") return undefined;
          (out as Record<string, PhpValue>)[String(k)] = v;
        }
      }
      return out;
    }
    default:
      return undefined;
  }
}

/** A string node's value, or the string inside `__('…')` or `trans('…')`, with whether it's translated. */
export function textValue(node: PNode | null | undefined): { text: string; translated: boolean } | undefined {
  if (!node) return undefined;
  if (node.kind === "string" && !node.interpolated) return { text: node.value, translated: false };
  if (node.kind === "func" && /^(__|trans|trans_choice)$/.test(node.name) && node.args.items[0]?.value.kind === "string") {
    const s = node.args.items[0].value;
    return s.kind === "string" && !s.interpolated ? { text: s.value, translated: true } : undefined;
  }
  return undefined;
}

/**
 * An array of options read for editing: each key with its label, where a label can be a plain string or a
 * translated one (`__('Draft')`). A list without keys uses each value as its key. Undefined when anything in the
 * array is other code, so an editor never writes back less than the code held.
 */
export function mapValue(node: PNode | null | undefined): { entries: [string, string][]; translated: boolean } | undefined {
  if (!node || node.kind !== "array") return undefined;
  const entries: [string, string][] = [];
  let translated = false;
  for (const item of node.items) {
    if (item.spread) return undefined;
    const label = textValue(item.value) ?? (item.value.kind === "number" ? { text: String(item.value.value), translated: false } : undefined);
    if (!label) return undefined;
    translated ||= label.translated;
    let key = label.text;
    if (item.key) {
      const k = nodeValue(item.key);
      if (typeof k !== "string" && typeof k !== "number") return undefined;
      key = String(k);
    }
    entries.push([key, label.text]);
  }
  return { entries, translated };
}

/** Options as PHP: keys to labels, with the labels in `__()` when `translated`. */
export function mapCode(entries: [string, string][], translated: boolean): string {
  if (!entries.length) return "[]";
  const label = (s: string) => (translated ? `__(${phpString(s)})` : phpString(s));
  const key = (k: string) => (/^(0|[1-9]\d*)$/.test(k) ? k : phpString(k));
  return `[\n${entries.map(([k, v]) => `    ${key(k)} => ${label(v)},`).join("\n")}\n]`;
}

// ---- Layout of the text ----

/** The whitespace at the start of the line that holds `offset`. */
export function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start))![0];
}

/** One level of indentation in the file: a tab, or the smallest indentation of a line (4 spaces when unsure). */
export function indentUnit(text: string): string {
  if (/^\t+\S/m.test(text) && !/^ {2,}\S/m.test(text)) return "\t";
  let smallest = 0;
  for (const m of text.matchAll(/^( +)\S/gm)) if (!smallest || m[1].length < smallest) smallest = m[1].length;
  return smallest === 2 ? "  " : "    ";
}

/** The offset just past spaces, tabs, and newlines from `offset`. */
const skipSpace = (text: string, offset: number) => {
  while (offset < text.length && /\s/.test(text[offset])) offset++;
  return offset;
};

/** Whether the text between two offsets breaks a line. */
const breaks = (text: string, from: number, to: number) => text.slice(from, to).includes("\n");

/** Re-indents code written at indentation "" so its lines after the first start at `indent`. */
export const indentCode = (code: string, indent: string) => code.replace(/\n/g, `\n${indent}`);

/** Code whose lines after the first are indented by `from`, re-indented to start at `to` instead. */
export const reindent = (code: string, from: string, to: string) =>
  code
    .split("\n")
    .map((line, i) => (i === 0 ? line : line.startsWith(from) ? to + line.slice(from.length) : line))
    .join("\n");

/** Code taken from the text at `span`, with its lines after the first re-indented from where it was to `indent`. */
export function moveCode(text: string, span: Span, indent: string): string {
  const code = text.slice(span[0], span[1]);
  const from = lineIndent(text, span[0]);
  return code
    .split("\n")
    .map((line, i) => (i === 0 ? line : line.startsWith(from) ? indent + line.slice(from.length) : line))
    .join("\n");
}

// ---- Arrays ----

/** Where the items of an array start and are indented, and whether it's written on one line. */
function arrayLayout(text: string, arr: ArrayNode, unit: string) {
  const openEnd = arr.legacy ? text.indexOf("(", arr.open) + 1 : arr.open + 1;
  const outer = lineIndent(text, arr.open);
  const first = arr.items[0];
  const multiline = first ? breaks(text, openEnd, first.span[0]) : false;
  const itemIndent = first && multiline ? lineIndent(text, first.span[0]) : outer + unit;
  // Some code sets items apart with blank lines; new items follow the habit of most of the array.
  let gaps = 0;
  for (let i = 1; i < arr.items.length; i++) if (/\n[ \t]*\n/.test(text.slice(arr.items[i - 1].span[1], arr.items[i].span[0]))) gaps++;
  const blank = arr.items.length > 1 && gaps * 2 >= arr.items.length - 1 ? "\n" : "";
  return { openEnd, outer, multiline, itemIndent, blank };
}

/** Whether a comma follows the item, skipping space: PHP allows one after the last item. */
function commaAfter(text: string, end: number): number | null {
  const at = skipSpace(text, end);
  return text[at] === "," ? at : null;
}

/**
 * Inserts `code`, written at indentation "", as item `index` of an array (at the end when `index` is past it).
 * An empty array opens onto lines of its own; one written on a single line stays on one.
 */
export function insertItem(text: string, arr: ArrayNode, index: number, code: string, unit = indentUnit(text)): Edit {
  const { openEnd, outer, multiline, itemIndent, blank } = arrayLayout(text, arr, unit);
  const items = arr.items;
  if (!items.length) {
    const close = arr.close;
    return { start: openEnd, end: close, text: `\n${itemIndent}${indentCode(code, itemIndent)},\n${outer}` };
  }
  if (!multiline) {
    const body = indentCode(code, outer);
    if (index < items.length) return { start: items[index].span[0], end: items[index].span[0], text: `${body}, ` };
    const last = items[items.length - 1];
    const comma = commaAfter(text, last.span[1]);
    return comma !== null ? { start: comma + 1, end: comma + 1, text: ` ${body},` } : { start: last.span[1], end: last.span[1], text: `, ${body}` };
  }
  const body = indentCode(code, itemIndent);
  if (index < items.length) {
    const at = items[index].span[0];
    return { start: at, end: at, text: `${body},\n${blank}${lineIndent(text, at)}` };
  }
  const last = items[items.length - 1];
  const comma = commaAfter(text, last.span[1]);
  // Keep the file's habit: a trailing comma after the last item stays, and none is added where there was none.
  return comma !== null ? { start: comma + 1, end: comma + 1, text: `\n${blank}${itemIndent}${body},` } : { start: last.span[1], end: last.span[1], text: `,\n${blank}${itemIndent}${body}` };
}

/** Removes item `index` from an array, with its comma and the line it was on. */
export function removeItem(text: string, arr: ArrayNode, index: number): Edit {
  const items = arr.items;
  const item = items[index];
  if (items.length === 1) {
    const { openEnd } = arrayLayout(text, arr, "    ");
    return { start: openEnd, end: arr.close, text: "" };
  }
  if (index > 0) return { start: items[index - 1].span[1], end: item.span[1], text: "" };
  // The first item: up to where the next one starts, keeping a comment written above the next item.
  const comma = commaAfter(text, item.span[1]);
  const end = comma !== null ? skipSpace(text, comma + 1) : items[1].span[0];
  return { start: item.span[0], end, text: "" };
}

/** Replaces item `index` of an array with `code`, written at indentation "". */
export function replaceItem(text: string, arr: ArrayNode, index: number, code: string): Edit {
  const item = arr.items[index];
  return { start: item.value.span[0], end: item.value.span[1], text: indentCode(code, lineIndent(text, item.span[0])) };
}

/** Moves item `from` of an array to position `to`, counted before the move. */
export function moveItem(text: string, arr: ArrayNode, from: number, to: number, unit = indentUnit(text)): Edit[] {
  if (to === from || to === from + 1) return [];
  const item = arr.items[from];
  const code = moveCode(text, item.span, "");
  return [removeItem(text, arr, from), insertItem(text, arr, to, code, unit)];
}

// ---- Call chains ----

/** The calls of a chain, or none for a single call such as `TextInput::make('title')`. */
export const callsOf = (node: PNode): PCall[] => (node.kind === "chain" ? node.calls : []);

/** The innermost expression of a chain, or the node itself. */
export const baseOf = (node: PNode): PNode => (node.kind === "chain" ? node.base : node);

/** The last call named `name` in a chain. */
export const findCall = (node: PNode, name: string): PCall | undefined => [...callsOf(node)].reverse().find((c) => c.name === name);

/** The arguments' code, as written. */
export const argsCode = (text: string, args: PArgs) => text.slice(args.open + 1, args.close);

/**
 * Sets a call in a chain: replaces its arguments when the chain has it, and otherwise adds it after the last call
 * (or after `after`, a call name, when that's in the chain). A chain written over several lines gets it on a line
 * of its own. `args` is code written at indentation "".
 */
export function setCall(text: string, node: PNode, name: string, args: string, unit = indentUnit(text), after?: string): Edit {
  const existing = findCall(node, name);
  if (existing) {
    const indent = lineIndent(text, existing.span[0]);
    return { start: existing.args.open + 1, end: existing.args.close, text: indentCode(args, indent) };
  }
  const calls = callsOf(node);
  const anchor = (after && findCall(node, after)) || calls[calls.length - 1];
  const end = anchor ? anchor.span[1] : node.span[1];
  // A chain written one call per line gets the call on a line of its own, and so does a component's first call.
  const multiline = calls.length ? breaks(text, baseOf(node).span[1], calls[0].span[0]) : true;
  const indent = calls.length ? lineIndent(text, calls[0].span[0]) : lineIndent(text, node.span[0]) + unit;
  const body = indentCode(args, multiline ? indent : lineIndent(text, node.span[0]));
  return { start: end, end, text: multiline ? `\n${indent}->${name}(${body})` : `->${name}(${body})` };
}

/** Removes a call from a chain, with the space and comments before it. */
export function removeCall(node: PNode, call: PCall): Edit {
  const calls = callsOf(node);
  const i = calls.indexOf(call);
  const start = i > 0 ? calls[i - 1].span[1] : baseOf(node).span[1];
  return { start, end: call.span[1], text: "" };
}

/** Replaces a node's code. `code` is written at indentation "". */
export const replaceNode = (text: string, node: PNode, code: string): Edit => ({ start: node.span[0], end: node.span[1], text: indentCode(code, lineIndent(text, node.span[0])) });

/** Replaces an argument list's contents. */
export const setArgs = (text: string, args: PArgs, code: string): Edit => ({ start: args.open + 1, end: args.close, text: indentCode(code, lineIndent(text, args.open)) });

// ---- Imports ----

const shortName = (fqn: string) => fqn.slice(fqn.lastIndexOf("\\") + 1);

/**
 * Names classes in a file's code, adding `use` statements as needed. Each `name()` returns how to write the class
 * there: its alias when imported, a relative name under an imported namespace, the short name after adding an
 * import, or the fully qualified name when the short name is taken. `edits()` returns the imports to add, sorted
 * into the file's other imports.
 */
export class Imports {
  /** Classes to import, by lowercase name: how they're spelled, and the short name the code uses. */
  private added = new Map<string, { fqn: string; alias: string }>();
  private text: string;
  private outline: Outline;
  constructor(text: string, outline: Outline) {
    this.text = text;
    this.outline = outline;
  }

  name(fqn: string): string {
    fqn = fqn.replace(/^\\/, "");
    const lower = fqn.toLowerCase();
    const uses = this.outline.uses.filter((u) => u.kind === "class");
    const imported = uses.find((u) => u.name.toLowerCase() === lower);
    if (imported) return imported.alias;
    const pending = this.added.get(lower);
    if (pending) return pending.alias;
    const ns = this.outline.namespace ?? "";
    const short = shortName(fqn);
    if (ns && lower === `${ns}\\${short}`.toLowerCase()) return short;
    const parent = uses.find((u) => lower.startsWith(`${u.name.toLowerCase()}\\`));
    if (parent) return `${parent.alias}${fqn.slice(parent.name.length)}`;
    const taken = [...uses.map((u) => u.alias), ...[...this.added.values()].map((a) => a.alias), ...this.outline.classes.map((c) => c.name)].map((a) => a.toLowerCase());
    if (taken.includes(short.toLowerCase())) return `\\${fqn}`;
    this.added.set(lower, { fqn, alias: short });
    return short;
  }

  /** The `use` lines for the classes named so far that weren't imported, each sorted into the file's imports. */
  edits(): Edit[] {
    const uses = this.outline.uses.filter((u) => u.kind === "class");
    const edits: Edit[] = [];
    const names = [...this.added.values()].map((a) => a.fqn).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      // Before the first import that sorts after it, which keeps an alphabetical block alphabetical.
      const next = uses.find((u) => u.name.localeCompare(name) > 0);
      const at = next ? this.text.lastIndexOf("\n", next.span[0] - 1) + 1 : this.outline.useInsert;
      const prior = edits.find((e) => e.start === at);
      if (prior) prior.text += `use ${name};\n`;
      else edits.push({ start: at, end: at, text: `use ${name};\n` });
    }
    // A file with no imports yet gets its first block set off by blank lines.
    if (!uses.length && edits.length) {
      const e = edits[0];
      if (this.text.slice(0, e.start).trimEnd().length && !/\n\s*\n$/.test(this.text.slice(0, e.start))) e.text = "\n" + e.text;
      if (!/^\s*\n/.test(this.text.slice(e.start))) e.text += "\n";
    }
    return edits;
  }
}

/**
 * Edits that remove the imports `edits` leave unused: those the code named before and doesn't after. Imports that
 * were already unused are the file's business and stay. Group imports (`use A\{B, C}`) stay too.
 */
export function droppedImports(text: string, outline: Outline, edits: Edit[]): Edit[] {
  const after = applyEdits(text, edits);
  const codeStart = (t: string) => {
    const m = /^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s/m.exec(t);
    return m ? m.index : t.length;
  };
  const used = (t: string, alias: string) => new RegExp(`(?<![\\w$\\\\])${alias.replace(/[$]/g, "\\$&")}(?![\\w])`).test(t.slice(codeStart(t)));
  const out: Edit[] = [];
  for (const u of outline.uses) {
    if (u.kind !== "class" || outline.uses.filter((o) => o.span[0] === u.span[0]).length > 1) continue;
    if (!used(text, u.alias) || used(after, u.alias)) continue;
    const start = text.lastIndexOf("\n", u.span[0] - 1) + 1;
    const nl = text.indexOf("\n", u.span[1]);
    const end = nl < 0 ? u.span[1] : nl + 1;
    if (edits.some((e) => e.start < end && start < e.end)) continue;
    out.push({ start, end, text: "" });
  }
  return out;
}

// ---- Classes ----

export const classNamed = (outline: Outline, fqn: string) => outline.classes.find((c) => c.fqn.toLowerCase() === fqn.replace(/^\\/, "").toLowerCase());
export const methodNamed = (cls: OClass, name: string) => cls.methods.find((m) => m.name.toLowerCase() === name.toLowerCase());
export const propertyNamed = (cls: OClass, name: string) => cls.properties.find((p) => p.name === name);

/**
 * Sets a static property's default value, or declares it after the class's last property (or at the top of the
 * class) with `declaration`, such as `protected static ?string $navigationGroup`.
 */
export function setProperty(text: string, cls: OClass, name: string, valueCode: string, declaration: string, unit = indentUnit(text)): Edit {
  const existing = propertyNamed(cls, name);
  if (existing?.value) return replaceNode(text, existing.value, valueCode);
  if (existing) {
    const semi = text.indexOf(";", existing.span[0]);
    const at = semi >= 0 && semi <= existing.span[1] ? semi : existing.span[1];
    return { start: at, end: at, text: ` = ${valueCode}` };
  }
  const last = cls.properties.filter((p) => p.static === declaration.includes("static ")).at(-1) ?? cls.properties.at(-1);
  const indent = last ? lineIndent(text, last.span[0]) : lineIndent(text, cls.bodyStart) + unit;
  const line = `${declaration} = ${indentCode(valueCode, indent)};`;
  if (last) {
    const end = text.indexOf(";", last.span[1] - 1) + 1 || last.span[1];
    return { start: end, end, text: `\n\n${indent}${line}` };
  }
  return { start: cls.bodyStart, end: cls.bodyStart, text: `\n${indent}${line}\n` };
}

/** Removes a property's declaration with its line. */
export function removeProperty(text: string, prop: OProperty): Edit {
  const start = text.lastIndexOf("\n", prop.span[0] - 1);
  let end = text.indexOf(";", prop.span[1] - 1) + 1 || prop.span[1];
  // A blank line left behind between two members goes too.
  if (/^\n[ \t]*\n/.test(text.slice(end))) end = text.indexOf("\n", end + 1);
  return { start, end, text: "" };
}

/** Inserts a member, written at indentation "", at the end of the class body. */
export function addMember(text: string, cls: OClass, code: string, unit = indentUnit(text)): Edit {
  const indent = lineIndent(text, cls.bodyStart) + unit;
  const before = text.slice(cls.bodyStart, cls.bodyEnd).trim() ? "\n" : "";
  let at = cls.bodyEnd;
  while (at > cls.bodyStart && /[ \t]/.test(text[at - 1])) at--;
  const lead = text[at - 1] === "\n" ? "" : "\n";
  return { start: at, end: at, text: `${lead}${before}${indent}${indentCode(code, indent)}\n` };
}

/** Removes a method with its docblock and the blank line before it. */
export function removeMethod(text: string, method: OMethod): Edit {
  const from = method.docStart ?? method.span[0];
  let start = text.lastIndexOf("\n", from - 1);
  if (/\n[ \t]*$/.test(text.slice(0, start))) start = text.lastIndexOf("\n", start - 1);
  return { start: Math.max(start, 0), end: method.span[1], text: "" };
}
