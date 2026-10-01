// Automations: rules such as "when a post's status becomes published, notify its author", written in the model's
// observer. A rule is a trigger, conditions on the record's fields, and actions, written as one `if` block (or bare
// statements, with no conditions) in the event method. Setting a field happens before the save, in `creating`,
// `updating`, or `restoring`, so it needs no second save; notifications go after it, in `created`, `updated`,
// `deleted`, or `restored`. So one rule can be two blocks with the same condition, which `readObserver` pairs again.
// Statements and code it doesn't understand stay as written. No editor imports, so Node tests it.
import { readSend, type Send, sendCode } from "./notifysend.ts";
import { addMember, type Edit, indentCode, indentUnit, insertItem, lineIndent, type OClass, type OMethod, type Outline, phpString, removeMethod, type Span } from "./phpcode.ts";
import { splitAt } from "./policygen.ts";

export type Value =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "case"; enum: string; case: string }
  /** `now()`, for dates. */
  | { kind: "now" }
  /** `auth()->id()`, the signed-in user's id. */
  | { kind: "user" };
export type Op = "===" | "!==" | "==" | "!=" | ">" | ">=" | "<" | "<=";
export type Cond = { field: string; op: Op; value: Value };
export type Trigger = { kind: "created" | "updated" | "deleted" | "restored" } | { kind: "changed"; field: string } | { kind: "becomes"; field: string; value: Value };
/** Where an action runs: before the save (setting fields), or after it (notifications). */
export type Slot = "before" | "after";
export type Action = { kind: "send"; send: Send } | { kind: "set"; field: string; value: Value } | { kind: "code"; code: string; slot: Slot; span: Span };
/** Where a rule is written: a block in one event method, an `if` or a run of bare statements. */
export type Block = { method: string; span: Span };
export type Rule = { trigger: Trigger; conds: Cond[]; actions: Action[]; blocks: Block[] };
/** Code in the observer the designer doesn't read as a rule: a statement in an event method, or another method. */
export type Other = { method: string; span: Span; statement: boolean };

export const TRIGGERS: [Trigger["kind"], string][] = [
  ["created", "is created"],
  ["updated", "is updated"],
  ["changed", "changes"],
  ["becomes", "becomes"],
  ["deleted", "is deleted"],
  ["restored", "is restored"],
];

/** The event methods a trigger's actions go in, before and after the save; deleting has no before. */
export function methodsOf(t: Trigger): { before: string | null; after: string } {
  switch (t.kind) {
    case "created":
      return { before: "creating", after: "created" };
    case "deleted":
      return { before: null, after: "deleted" };
    case "restored":
      return { before: "restoring", after: "restored" };
    default:
      return { before: "updating", after: "updated" };
  }
}
const EVENTS = ["creating", "created", "updating", "updated", "deleted", "restoring", "restored"];
const BEFORE = ["creating", "updating", "restoring"];

/** The slot an action runs in. */
export const slotOf = (a: Action): Slot => (a.kind === "code" ? a.slot : a.kind === "set" ? "before" : "after");

// ---- Values and conditions ----

export function valueCode(v: Value): string {
  switch (v.kind) {
    case "string":
      return phpString(v.value);
    case "number":
      return String(v.value);
    case "bool":
      return v.value ? "true" : "false";
    case "null":
      return "null";
    case "case":
      return `{{${v.enum.replace(/^\\/, "")}}}::${v.case}`;
    case "now":
      return "now()";
    case "user":
      return "auth()->id()";
  }
}

/** Reads a value `valueCode` writes; `resolve` names a class as the file spells it. Anything else is null. */
export function readValue(code: string, resolve: (name: string) => string): Value | null {
  const c = code.trim();
  let m: RegExpExecArray | null;
  if ((m = /^'((?:[^'\\]|\\.)*)'$/.exec(c))) return { kind: "string", value: m[1].replace(/\\(['\\])/g, "$1") };
  if ((m = /^"((?:[^"\\$]|\\.)*)"$/.exec(c))) return { kind: "string", value: m[1].replace(/\\(["\\])/g, "$1") };
  if (/^-?\d+(\.\d+)?$/.test(c)) return { kind: "number", value: Number(c) };
  if (/^(true|false)$/i.test(c)) return { kind: "bool", value: c.toLowerCase() === "true" };
  if (/^null$/i.test(c)) return { kind: "null" };
  if (/^\\?now\(\)$/.test(c)) return { kind: "now" };
  if (/^\\?auth\(\)->id\(\)$/.test(c)) return { kind: "user" };
  if ((m = /^(\\?[A-Za-z_][\w\\]*)::([A-Za-z_]\w*)$/.exec(c)) && m[2] !== "class") return { kind: "case", enum: m[1].startsWith("\\") ? m[1].slice(1) : resolve(m[1]), case: m[2] };
  return null;
}

/** The comparison a new condition on a value uses: strict, except for numbers, which a decimal column holds as text. */
export const opFor = (v: Value, negate = false): Op => (v.kind === "number" ? (negate ? "!=" : "==") : negate ? "!==" : "===");

const condCode = (c: Cond, v: string) => `$${v}->${c.field} ${c.op} ${valueCode(c.value)}`;

/** The condition of a rule's block in `method`, or "" when it has none. `v` is the record's variable, without `$`. */
export function conditionCode(t: Trigger, conds: Cond[], method: string, v: string): string {
  const parts: string[] = [];
  if (t.kind === "changed" || t.kind === "becomes") parts.push(`$${v}->${BEFORE.includes(method) ? "isDirty" : "wasChanged"}(${phpString(t.field)})`);
  if (t.kind === "becomes") parts.push(condCode({ field: t.field, op: opFor(t.value), value: t.value }, v));
  parts.push(...conds.map((c) => condCode(c, v)));
  return parts.join(" && ");
}

/** Reads a block's condition in `method` into its trigger and conditions, or null when it's other code. */
export function readCondition(code: string, method: string, v: string, resolve: (name: string) => string): { trigger: Trigger; conds: Cond[] } | null {
  const base: Trigger = { kind: method.startsWith("creat") ? "created" : method.startsWith("updat") ? "updated" : method.startsWith("restor") ? "restored" : "deleted" };
  if (!code.trim()) return { trigger: base, conds: [] };
  if (splitAt(code, "||").length > 1) return null;
  const parts = splitAt(code.trim(), "&&").map((p) => p.replace(/^\((.*)\)$/s, "$1").trim());
  const rec = `\\$${v}`;
  let trigger: Trigger = base;
  const changed = new RegExp(`^${rec}->(${BEFORE.includes(method) ? "isDirty" : "wasChanged"})\\(\\s*'(\\w+)'\\s*\\)$`).exec(parts[0]);
  if (changed && base.kind === "updated") {
    trigger = { kind: "changed", field: changed[2] };
    parts.shift();
  }
  const conds: Cond[] = [];
  for (const p of parts) {
    const m = new RegExp(`^${rec}->(\\w+)\\s*(===|!==|==|!=|>=|<=|>|<)\\s*(.+)$`, "s").exec(p);
    const value = m && readValue(m[3], resolve);
    if (!m || !value) return null;
    conds.push({ field: m[1], op: m[2] as Op, value });
  }
  // "Changes, and is then a value" reads as "becomes".
  if (trigger.kind === "changed" && conds[0]?.field === trigger.field && /^={2,3}$/.test(conds[0].op)) trigger = { kind: "becomes", field: trigger.field, value: conds.shift()!.value };
  return { trigger, conds };
}

/** A statement a rule's action writes. */
export function actionCode(a: Action, v: string, userModel: string): string {
  if (a.kind === "send") return sendCode(a.send, userModel, `$${v}`);
  if (a.kind === "set") return `$${v}->${a.field} = ${valueCode(a.value)};`;
  return a.code;
}

/** Reads a statement in `method` as an action; anything else keeps its code. */
export function readAction(code: string, method: string, v: string, resolve: (name: string) => string, span: Span): Action {
  const slot: Slot = BEFORE.includes(method) ? "before" : "after";
  const send = slot === "after" ? readSend(code, resolve, `$${v}`) : null;
  if (send) return { kind: "send", send };
  const m = new RegExp(`^\\$${v}->(\\w+)\\s*=\\s*(.+?);$`, "s").exec(code.trim());
  const value = m && slot === "before" ? readValue(m[2], resolve) : null;
  if (m && value) return { kind: "set", field: m[1], value };
  return { kind: "code", code, slot, span };
}

// ---- Reading an observer ----

/** Resolves a class name as the file spells it, through its imports and namespace. */
export function resolver(outline: Outline): (name: string) => string {
  return (name) => {
    if (name.startsWith("\\")) return name.slice(1);
    const [first, ...rest] = name.split("\\");
    const use = outline.uses.find((u) => u.kind === "class" && u.alias.toLowerCase() === first.toLowerCase());
    if (use) return [use.name, ...rest].join("\\");
    return outline.namespace ? `${outline.namespace}\\${name}` : name;
  };
}

/** The record's variable in an event method, without `$`. */
const varOf = (m: OMethod, fallback: string) => m.params[0]?.name ?? fallback;

/** Code taken from the text, with its lines after the first moved to indentation "". */
function codeAt(text: string, span: Span): string {
  const indent = lineIndent(text, span[0]);
  return text
    .slice(span[0], span[1])
    .split("\n")
    .map((l, i) => (i && l.startsWith(indent) ? l.slice(indent.length) : l))
    .join("\n");
}

/**
 * Reads an observer class: its rules, and the code that isn't one. `fallback` is the record's variable for a method
 * without a parameter. Blocks with the same trigger and conditions in the before and after methods are one rule.
 */
export function readObserver(text: string, outline: Outline, cls: OClass, fallback: string): { rules: Rule[]; other: Other[] } {
  const resolve = resolver(outline);
  const rules: Rule[] = [];
  const other: Other[] = [];
  const parts: (Rule & { slot: Slot })[] = [];
  for (const m of cls.methods) {
    if (!EVENTS.includes(m.name) || m.static || !m.bodyStatements) {
      other.push({ method: m.name, span: m.span, statement: false });
      continue;
    }
    const v = varOf(m, fallback);
    const slot: Slot = BEFORE.includes(m.name) ? "before" : "after";
    let bare: (Rule & { slot: Slot }) | null = null;
    for (const s of m.bodyStatements) {
      if (s.kind === "if") {
        bare = null;
        const read = readCondition(text.slice(s.condition![0], s.condition![1]), m.name, v, resolve);
        if (!read || !s.then?.length) {
          other.push({ method: m.name, span: s.span, statement: true });
          continue;
        }
        const actions = s.then.map((span) => readAction(codeAt(text, span), m.name, v, resolve, span));
        parts.push({ ...read, actions, blocks: [{ method: m.name, span: s.span }], slot });
        continue;
      }
      const action = s.kind === "expression" ? readAction(codeAt(text, s.span), m.name, v, resolve, s.span) : null;
      if (!action || action.kind === "code") {
        bare = null;
        other.push({ method: m.name, span: s.span, statement: true });
        continue;
      }
      if (bare) {
        bare.actions.push(action);
        bare.blocks[0].span = [bare.blocks[0].span[0], s.span[1]];
      } else {
        const read = readCondition("", m.name, v, resolve)!;
        parts.push((bare = { ...read, actions: [action], blocks: [{ method: m.name, span: [...s.span] }], slot }));
      }
    }
  }
  // Each after-block takes the first before-block with the same trigger and conditions.
  const key = (r: Rule) => JSON.stringify([r.trigger, r.conds.map((c) => ({ ...c, op: c.op.replace("===", "==").replace("!==", "!=") }))]);
  const strip = ({ slot: _, ...r }: Rule & { slot: Slot }): Rule => r;
  const befores = parts.filter((p) => p.slot === "before");
  for (const p of parts.filter((p) => p.slot === "after")) {
    const i = befores.findIndex((b) => key(b) === key(p));
    const b = i >= 0 ? befores.splice(i, 1)[0] : null;
    rules.push(b ? { trigger: p.trigger, conds: p.conds, actions: [...b.actions, ...p.actions], blocks: [...b.blocks, ...p.blocks] } : strip(p));
  }
  rules.push(...befores.map(strip));
  const order = TRIGGERS.map(([k]) => k);
  const at = (r: Rule) => (r.trigger.kind === "changed" || r.trigger.kind === "becomes" ? 1 : order.indexOf(r.trigger.kind));
  rules.sort((a, b) => at(a) - at(b) || a.blocks[0].span[0] - b.blocks[0].span[0]);
  return { rules, other };
}

// ---- Writing ----

/** What writing a rule needs: the record's variable (without `$`) and type as the file names them, and the user model. */
export type WriteContext = { variable: string; modelType: string; userModel: string };

/** A block's code, written at indentation "". */
function blockCode(cond: string, statements: string[], unit: string): string {
  if (!cond) return statements.join("\n");
  return `if (${cond}) {\n${statements.map((s) => unit + indentCode(s, unit)).join("\n")}\n}`;
}

/** Removes a block with its line, and a blank line next to it. */
function removeBlock(text: string, span: Span): Edit {
  let start = text.lastIndexOf("\n", span[0] - 1);
  let end = span[1];
  if (/\n[ \t]*$/.test(text.slice(0, start))) start = text.lastIndexOf("\n", start - 1);
  else if (/^\n[ \t]*\n/.test(text.slice(end))) end = text.indexOf("\n", end + 1);
  return { start, end, text: "" };
}

/**
 * The edits that change rule `from` (as read, or null for a new rule) into `to` (or null to delete it). Each block is
 * replaced where it is, removed, or added at the end of its method, which is added when missing and removed when
 * nothing is left in it.
 */
export function ruleEdits(text: string, cls: OClass, from: Rule | null, to: Rule | null, ctx: WriteContext): Edit[] {
  const unit = indentUnit(text);
  const want = new Map<string, string[]>();
  if (to) {
    const { before, after } = methodsOf(to.trigger);
    for (const a of to.actions) {
      const method = slotOf(a) === "before" && before ? before : after;
      const v = cls.methods.find((m) => m.name === method)?.params[0]?.name ?? ctx.variable;
      want.set(method, [...(want.get(method) ?? []), actionCode(a, v, ctx.userModel)]);
    }
  }
  const edits: Edit[] = [];
  const old = new Map((from?.blocks ?? []).map((b) => [b.method, b]));
  const added: string[] = [];
  for (const method of new Set([...old.keys(), ...want.keys()])) {
    const m = cls.methods.find((x) => x.name === method);
    const v = m?.params[0]?.name ?? ctx.variable;
    const statements = want.get(method);
    const code = statements && blockCode(conditionCode(to!.trigger, to!.conds, method, v), statements, unit);
    const block = old.get(method);
    if (block && code) edits.push({ start: block.span[0], end: block.span[1], text: indentCode(code, lineIndent(text, block.span[0])) });
    else if (block && m?.body) {
      const left = (m.bodyStatements ?? []).filter((s) => s.span[0] < block.span[0] || s.span[1] > block.span[1]);
      const comments = text.slice(m.body[0], m.body[1]).replace(text.slice(block.span[0], block.span[1]), "").trim();
      edits.push(!left.length && !comments ? removeMethod(text, m) : removeBlock(text, block.span));
    } else if (code && m?.body) {
      const inner = text.slice(m.body[0], m.body[1]);
      const first = m.bodyStatements?.[0];
      const indent = first ? lineIndent(text, first.span[0]) : lineIndent(text, m.span[0]) + unit;
      if (!inner.trim()) edits.push({ start: m.body[0], end: m.body[1], text: `\n${indent}${indentCode(code, indent)}\n${lineIndent(text, m.span[0])}` });
      else {
        const at = m.body[0] + inner.trimEnd().length;
        edits.push({ start: at, end: at, text: `\n\n${indent}${indentCode(code, indent)}` });
      }
    } else if (code) added.push(method);
  }
  // New methods in the order of the model's events.
  for (const method of EVENTS.filter((e) => added.includes(e))) {
    const code = blockCode(conditionCode(to!.trigger, to!.conds, method, ctx.variable), want.get(method)!, unit);
    const member = `public function ${method}(${ctx.modelType} $${ctx.variable}): void\n{\n${unit}${indentCode(code, unit)}\n}`;
    // A before method goes above its after method, when that's there.
    const next = BEFORE.includes(method) && cls.methods.find((m) => m.name === EVENTS[EVENTS.indexOf(method) + 1]);
    if (next) {
      const start = next.docStart ?? next.span[0];
      const indent = lineIndent(text, start);
      const at = start - indent.length;
      edits.push({ start: at, end: at, text: `${indent}${indentCode(member, indent)}\n\n` });
    } else edits.push(addMember(text, cls, member, unit));
  }
  return edits;
}

// ---- Registering ----

export const OBSERVED_BY = "Illuminate\\Database\\Eloquent\\Attributes\\ObservedBy";

/** A new observer class, empty, for the rules to go in. */
export const observerClass = (short: string) => `class ${short}\n{\n}`;

/** The edits that register an observer on the model: an item in its `#[ObservedBy([...])]`, or the attribute. */
export function observedByEdits(text: string, model: OClass, observer: string): Edit[] {
  const attr = model.attributes.find((a) => a.name.replace(/^\\/, "") === OBSERVED_BY);
  const item = `{{${observer}}}::class`;
  const list = attr?.args?.items[0]?.value;
  if (list?.kind === "array") return [insertItem(text, list, list.items.length, item)];
  if (attr) return [];
  const start = Math.min(model.span[0], ...model.attributes.map((a) => a.list[0]));
  const at = text.lastIndexOf("\n", start - 1) + 1;
  return [{ start: at, end: at, text: `#[{{${OBSERVED_BY}}}([${item}])]\n` }];
}
