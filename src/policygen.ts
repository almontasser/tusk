// Policies for the Access tab: each ability of a model's policy (viewAny, update, …) as a rule the designer can
// show and change (everyone, nobody, or users with a permission or role, or who own the record), written as the
// method's one `return`. A method written otherwise is code the designer keeps. No editor imports, so Node tests it.
import { type OClass, type OMethod, phpString } from "./phpcode.ts";

export type Ability = { name: string; label: string; record: boolean; more?: boolean; hint: string };

/** The abilities Filament checks, in the order the tab lists them; `more` ones sit under "More abilities". */
export const ABILITIES: Ability[] = [
  { name: "viewAny", label: "See the list", record: false, hint: "Seeing the list of records, and the navigation item that leads to it." },
  { name: "view", label: "View a record", record: true, hint: "The View page and action." },
  { name: "create", label: "Create", record: false, hint: "The Create page and action." },
  { name: "update", label: "Edit", record: true, hint: "The Edit page and action." },
  { name: "delete", label: "Delete", record: true, hint: "The Delete action on a record." },
  { name: "deleteAny", label: "Delete in bulk", record: false, more: true, hint: "The bulk Delete action." },
  { name: "restore", label: "Restore", record: true, more: true, hint: "Restoring a soft-deleted record." },
  { name: "restoreAny", label: "Restore in bulk", record: false, more: true, hint: "The bulk Restore action." },
  { name: "forceDelete", label: "Delete forever", record: true, more: true, hint: "Deleting a soft-deleted record for good." },
  { name: "forceDeleteAny", label: "Delete forever in bulk", record: false, more: true, hint: "The bulk Force delete action." },
  { name: "replicate", label: "Replicate", record: true, more: true, hint: "The Replicate action." },
  { name: "reorder", label: "Reorder", record: false, more: true, hint: "Dragging rows to reorder the table." },
];

export type Cond = { kind: "permission"; name: string } | { kind: "role"; name: string } | { kind: "owner"; column: string };
export type Rule = { kind: "everyone" } | { kind: "nobody" } | { kind: "when"; join: "any" | "all"; conds: Cond[] } | { kind: "custom" };
/** The names of a method's parameters: the user's, and the record's for abilities on one record. */
export type Vars = { user: string; model: string };

const STR = String.raw`'(?:[^'\\]|\\.)*'|"(?:[^"\\$]|\\.)*"`;
const unquote = (s: string) => (s.startsWith("'") ? s.slice(1, -1).replace(/\\(['\\])/g, "$1") : s.slice(1, -1).replace(/\\(.)/g, "$1"));

/** Splits code at a top-level operator, outside parentheses, brackets, and strings. */
export function splitAt(code: string, op: string): string[] {
  const parts: string[] = [];
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
    else if (depth === 0 && code.startsWith(op, i)) {
      parts.push(code.slice(start, i).trim());
      start = i + op.length;
      i += op.length - 1;
    }
  }
  parts.push(code.slice(start).trim());
  return parts;
}

const condCode = (c: Cond, v: Vars) =>
  c.kind === "permission" ? `$${v.user}->can(${phpString(c.name)})` : c.kind === "role" ? `$${v.user}->hasRole(${phpString(c.name)})` : `$${v.user}->id === $${v.model}->${c.column}`;

/** A rule as the expression the method returns. */
export function ruleCode(r: Rule, v: Vars): string | null {
  if (r.kind === "everyone") return "true";
  if (r.kind === "nobody") return "false";
  if (r.kind === "custom" || !r.conds.length) return null;
  return r.conds.map((c) => condCode(c, v)).join(r.join === "any" ? " || " : " && ");
}

function readCond(code: string, v: Vars): Cond | null {
  const u = `\\$${v.user}`;
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`^${u}->(?:can|hasPermissionTo|checkPermissionTo)\\(\\s*(${STR})\\s*\\)$`).exec(code))) return { kind: "permission", name: unquote(m[1]) };
  if ((m = new RegExp(`^${u}->hasRole\\(\\s*(${STR})\\s*\\)$`).exec(code))) return { kind: "role", name: unquote(m[1]) };
  const id = `${u}->(?:id|getKey\\(\\))`;
  const col = `\\$${v.model}->(\\w+)`;
  if ((m = new RegExp(`^${id}\\s*===?\\s*${col}$`).exec(code)) || (m = new RegExp(`^${col}\\s*===?\\s*${id}$`).exec(code))) return { kind: "owner", column: m[1] };
  return null;
}

/** Reads the expression a method returns into a rule; anything the presets don't write reads as custom. */
export function readRule(expr: string, v: Vars): Rule {
  const code = expr.trim().replace(/^\((.*)\)$/s, "$1").trim();
  if (/^true$/i.test(code)) return { kind: "everyone" };
  if (/^false$/i.test(code)) return { kind: "nobody" };
  const any = splitAt(code, "||");
  const all = splitAt(code, "&&");
  if (any.length > 1 && all.length > 1) return { kind: "custom" };
  const parts = any.length > 1 ? any : all;
  const conds = parts.map((p) => readCond(p, v));
  if (conds.some((c) => !c)) return { kind: "custom" };
  return { kind: "when", join: any.length > 1 ? "any" : "all", conds: conds as Cond[] };
}

/** A method's parameter names, with the conventional ones for the parts it doesn't have. */
export function varsOf(method: OMethod | undefined, modelShort: string): Vars {
  return { user: method?.params[0]?.name ?? "user", model: method?.params[1]?.name ?? modelShort.charAt(0).toLowerCase() + modelShort.slice(1) };
}

export type ReadAbility = { ability: Ability; method: OMethod | null; rule: Rule | null; vars: Vars; expr?: { span: [number, number]; text: string } };

/** Each ability of a policy class, with its rule when the method is one `return` the designer reads. */
export function readPolicy(text: string, cls: OClass, modelShort: string): ReadAbility[] {
  return ABILITIES.map((ability) => {
    const method = cls.methods.find((m) => m.name === ability.name) ?? null;
    const vars = varsOf(method ?? cls.methods.find((m) => m.params.length === 2) ?? cls.methods.find((m) => m.params.length), modelShort);
    if (method && !method.params[1]) vars.model = varsOf(cls.methods.find((m) => m.params.length === 2), modelShort).model;
    if (!method) return { ability, method, rule: null, vars };
    const ret = method.returns[0];
    const body = method.body ? text.slice(method.body[0], method.body[1]).replace(/^\{|\}$/g, "") : "";
    // Only a body that is the one return statement: anything around it would be lost.
    if (!ret || method.returns.length !== 1 || body.replace(text.slice(ret.span[0], ret.span[1]), "").replace(/\s+/g, "") !== "return;") return { ability, method, rule: { kind: "custom" }, vars };
    const exprText = text.slice(ret.span[0], ret.span[1]);
    return { ability, method, rule: readRule(exprText, vars), vars, expr: { span: ret.span, text: exprText } };
  });
}

/** A new ability method, for a policy that doesn't have it. `userType` and `modelType` are as written in the file. */
export function abilityMethod(a: Ability, code: string, v: Vars, userType: string, modelType: string): string {
  const params = a.record ? `${userType} $${v.user}, ${modelType} $${v.model}` : `${userType} $${v.user}`;
  return `public function ${a.name}(${params}): bool\n{\n    return ${code};\n}`;
}

/** How Filament Shield names permissions: the keys it gives a resource, or its configured separator and case. */
export type ShieldNaming = { keys?: Record<string, string> | null; format?: { separator: string; case: string } | null };

const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_\-:]+/).filter(Boolean).map((w) => w.toLowerCase());
/** A value in one of Shield's cases, as its `format()` writes it. */
export function shieldCase(value: string, kase: string): string {
  const w = words(value);
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  switch (kase) {
    case "kebab":
      return w.join("-");
    case "pascal":
      return w.map(cap).join("");
    case "camel":
      return w.map((x, i) => (i ? cap(x) : x)).join("");
    case "upper_snake":
      return w.join("_").toUpperCase();
    default:
      return w.join("_");
  }
}

const CASES = ["lower_snake", "pascal", "camel", "kebab", "upper_snake"];

/** The case and separator that make a resource's keys from their abilities and the model's name. */
function namingOf(keys: Record<string, string> | null | undefined, modelShort: string): { separator: string; case: string } | null {
  for (const [ability, key] of Object.entries(keys ?? {}))
    for (const kase of CASES) {
      const a = shieldCase(ability, kase);
      const m = shieldCase(modelShort, kase);
      if (key.startsWith(a) && key.endsWith(m) && key.length >= a.length + m.length) return { separator: key.slice(a.length, key.length - m.length), case: kase };
    }
  return null;
}

/**
 * The permission name an ability suggests: the key Shield gives it, or Shield's naming (`update_post` by
 * default), which apps without Shield get too.
 */
export function permissionName(ability: string, modelShort: string, shield?: ShieldNaming): string {
  const key = shield?.keys?.[ability];
  if (key) return key;
  // An ability Shield gave no key: named like the keys it gave, which follow the app's own builder when it has one.
  const f = namingOf(shield?.keys, modelShort) ?? shield?.format ?? { separator: "_", case: "lower_snake" };
  return `${shieldCase(ability, f.case)}${f.separator}${shieldCase(modelShort, f.case)}`;
}

/** The permissions a policy's rules name. */
export const permissionsOf = (read: ReadAbility[]) => [...new Set(read.flatMap((r) => (r.rule?.kind === "when" ? r.rule.conds.filter((c) => c.kind === "permission").map((c) => (c as { name: string }).name) : [])))];
