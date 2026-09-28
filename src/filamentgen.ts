// Code the designers write: the component that suits a database column in a form, a table, a filter, or an
// infolist, and the closures behind "visible when" conditions. No editor imports, so Node tests it.
import { labelFromName } from "./filamentcatalog.ts";
import { phpString } from "./phpcode.ts";

/** A model's column, as `introspect.php model` or the model designer describes it. */
export type Column = { name: string; type: string; fullType?: string; nullable: boolean; default?: string | null; autoIncrement?: boolean };
export type Relation = { name: string; type: string; related: string | null; foreignKey?: string };
export type ModelFacts = {
  class: string;
  columns: Column[];
  casts: Record<string, string>;
  relations: Relation[];
  /** Enums under app/, for casts to an enum. */
  enums: string[];
  softDeletes?: boolean;
  /** The title attribute of each related model, by class, for relationship selects. */
  titles?: Record<string, string>;
};

/**
 * A component to write: its class, `make()`'s arguments, and its calls. Arguments are PHP code, where
 * `{{App\Enums\Status}}` stands for a class, written as the file imports it.
 */
export type Gen = { cls: string; make: string; calls: [string, string][] };

const F = "Filament\\Forms\\Components\\";
const T = "Filament\\Tables\\Columns\\";
const I = "Filament\\Infolists\\Components\\";
const FL = "Filament\\Tables\\Filters\\";

/** Writes a component, one call per line after the first, with classes named by `name`. */
export function renderGen(g: Gen, name: (fqn: string) => string): string {
  const fill = (code: string) => code.replace(/\{\{([\w\\]+)\}\}/g, (_, fqn: string) => name(fqn));
  return [`${name(g.cls)}::make(${fill(g.make)})`, ...g.calls.map(([m, a]) => `    ->${m}(${fill(a)})`)].join("\n");
}

/** Columns a form or table leaves out unless you ask for them. */
const SYSTEM = /^(id|created_at|updated_at|deleted_at|remember_token|email_verified_at|two_factor_\w+)$/;
export const isSystemColumn = (c: Column) => SYSTEM.test(c.name) || !!c.autoIncrement;

const TEXT_TYPES = /^(text|mediumtext|longtext|tinytext)$/;
const INT_TYPES = /^(int|integer|bigint|smallint|mediumint|tinyint|int\d|serial|bigserial)$/;
const DECIMAL_TYPES = /^(decimal|numeric|float|double|real|money)/;
const BOOL_TYPES = /^(bool|boolean)$/;
const DATE_TYPES = /^date$/;
const DATETIME_TYPES = /^(datetime|timestamp|timestamptz|datetimetz)/;
const TIME_TYPES = /^(time|timetz)$/;
const JSON_TYPES = /^(json|jsonb)$/;

/** What a column holds, from its database type, its cast, and its name. */
export type Nature = "id" | "foreign" | "enum" | "boolean" | "date" | "datetime" | "time" | "integer" | "decimal" | "money" | "json" | "tags" | "text" | "richtext" | "email" | "phone" | "url" | "password" | "color" | "image" | "file" | "string" | "uuid";

export function natureOf(c: Column, m: Pick<ModelFacts, "casts" | "relations" | "enums">): Nature {
  const type = c.type.toLowerCase();
  const cast = m.casts[c.name] ?? "";
  const name = c.name.toLowerCase();
  if (c.autoIncrement || name === "id") return "id";
  if (relationFor(c, m)) return "foreign";
  if (m.enums.includes(cast.replace(/^\\/, "").split(":")[0])) return "enum";
  if (BOOL_TYPES.test(type) || /^(bool|boolean)$/.test(cast) || (type === "tinyint" && /\(1\)/.test(c.fullType ?? "")) || /^(is|has|can)_/.test(name)) return "boolean";
  if (/^(datetime|immutable_datetime|timestamp)/.test(cast) || DATETIME_TYPES.test(type)) return "datetime";
  if (/^(date|immutable_date)/.test(cast) || DATE_TYPES.test(type)) return "date";
  if (TIME_TYPES.test(type)) return "time";
  if (cast === "hashed" || name === "password") return "password";
  if (/^(array|json|collection|object|as_array_object|as_collection)/i.test(cast) || JSON_TYPES.test(type)) return /tags|keywords|labels/.test(name) ? "tags" : "json";
  if (TEXT_TYPES.test(type)) return /content|body|description|bio|about|article|post/.test(name) && /long|medium/.test(type) ? "richtext" : "text";
  if (DECIMAL_TYPES.test(type) || /^(decimal|float|double)/.test(cast)) return /price|amount|cost|total|salary|balance|fee|budget/.test(name) ? "money" : "decimal";
  if (INT_TYPES.test(type) || /^(int|integer)$/.test(cast)) return "integer";
  if (/^(uuid|ulid|char)$/.test(type) && /uuid|ulid/.test(name)) return "uuid";
  if (/email/.test(name)) return "email";
  if (/phone|mobile|tel$|telephone/.test(name)) return "phone";
  if (/avatar|image|photo|picture|logo|thumbnail|cover|banner/.test(name)) return "image";
  if (/url|website|link|homepage/.test(name)) return "url";
  if (/(^|_)colou?r$/.test(name)) return "color";
  if (/(^|_)(file|attachment|document|path)$/.test(name)) return "file";
  return "string";
}

/** The belongs-to relationship a foreign key column is for: `category_id` for `category()`. */
export function relationFor(c: Column, m: Pick<ModelFacts, "relations">): Relation | undefined {
  if (!c.name.endsWith("_id")) return undefined;
  const base = c.name.slice(0, -3);
  const camel = base.replace(/_([a-z\d])/g, (_, ch: string) => ch.toUpperCase());
  return m.relations.find((r) => /BelongsTo$/.test(r.type) && (r.foreignKey === c.name || r.name === camel || r.name === base));
}

/** The attribute that names a model's records: the first of name, title, and the like it has, or `id`. */
export function titleAttribute(columns: string[]): string {
  return ["name", "title", "label", "full_name", "display_name", "username", "email", "code", "slug", "number", "reference"].find((c) => columns.includes(c)) ?? "id";
}

const maxLengthOf = (c: Column) => Number(/\((\d+)\)/.exec(c.fullType ?? "")?.[1] ?? 0) || (/^(varchar|string)$/i.test(c.type) ? 255 : 0);
const required = (c: Column) => !c.nullable && (c.default === null || c.default === undefined) && !c.autoIncrement;
const cls = (fqn: string) => `{{${fqn}}}`;

/** The form field for a column. */
export function formField(c: Column, m: ModelFacts): Gen {
  const nature = natureOf(c, m);
  const calls: [string, string][] = [];
  const req = required(c);
  let g: Gen;
  const input = (extra: [string, string][] = []) => ({ cls: `${F}TextInput`, make: phpString(c.name), calls: [...extra] });
  switch (nature) {
    case "foreign": {
      const rel = relationFor(c, m)!;
      const title = (rel.related && m.titles?.[rel.related]) || "name";
      g = { cls: `${F}Select`, make: phpString(c.name), calls: [["relationship", `${phpString(rel.name)}, ${phpString(title)}`], ["searchable", ""], ["preload", ""]] };
      break;
    }
    case "enum":
      g = { cls: `${F}Select`, make: phpString(c.name), calls: [["options", `${cls(m.casts[c.name].replace(/^\\/, "").split(":")[0])}::class`]] };
      break;
    case "boolean":
      g = { cls: `${F}Toggle`, make: phpString(c.name), calls: [] };
      if (c.default !== null && c.default !== undefined && /^(1|true|0|false)$/i.test(String(c.default).replace(/'/g, ""))) calls.push(["default", /^(1|true)$/i.test(String(c.default).replace(/'/g, "")) ? "true" : "false"]);
      return { ...g, calls: [...g.calls, ...calls] };
    case "date":
      g = { cls: `${F}DatePicker`, make: phpString(c.name), calls: [] };
      break;
    case "datetime":
      g = { cls: `${F}DateTimePicker`, make: phpString(c.name), calls: [] };
      break;
    case "time":
      g = { cls: `${F}TimePicker`, make: phpString(c.name), calls: [] };
      break;
    case "password":
      // Blank on edit keeps the old password; the model's `hashed` cast or a mutator hashes a new one.
      return input([
        ["password", ""],
        ["revealable", ""],
        ["required", "fn (string $operation): bool => $operation === 'create'"],
        ["dehydrated", "fn (?string $state): bool => filled($state)"],
      ]);
    case "json":
      g = { cls: `${F}KeyValue`, make: phpString(c.name), calls: [["columnSpanFull", ""]] };
      break;
    case "tags":
      g = { cls: `${F}TagsInput`, make: phpString(c.name), calls: [] };
      break;
    case "richtext":
      g = { cls: `${F}RichEditor`, make: phpString(c.name), calls: [["columnSpanFull", ""]] };
      break;
    case "text":
      g = { cls: `${F}Textarea`, make: phpString(c.name), calls: [["rows", "4"], ["columnSpanFull", ""]] };
      break;
    case "money":
      g = input([["numeric", ""], ["prefix", "'$'"]]);
      break;
    case "decimal":
    case "integer":
      g = input([["numeric", ""]]);
      if (nature === "integer") g.calls = [["integer", ""]];
      break;
    case "email":
      g = input([["email", ""]]);
      break;
    case "phone":
      g = input([["tel", ""]]);
      break;
    case "url":
      g = input([["url", ""]]);
      break;
    case "color":
      g = { cls: `${F}ColorPicker`, make: phpString(c.name), calls: [] };
      break;
    case "image":
      g = { cls: `${F}FileUpload`, make: phpString(c.name), calls: [["image", ""], ...(/avatar/.test(c.name) ? ([["avatar", ""]] as [string, string][]) : [])] };
      break;
    case "file":
      g = { cls: `${F}FileUpload`, make: phpString(c.name), calls: [] };
      break;
    default:
      g = input();
  }
  if (req) calls.push(["required", ""]);
  if (["string", "email", "phone", "url"].includes(nature)) {
    const max = maxLengthOf(c);
    if (max) calls.push(["maxLength", String(max)]);
    if (nature === "string" && c.name === "slug") calls.push(["unique", "ignoreRecord: true"]);
  }
  if (nature === "email" && /^email$/.test(c.name)) calls.push(["unique", "ignoreRecord: true"]);
  const all = [...g.calls, ...calls];
  return { ...g, calls: all.filter((call, i) => all.findIndex((o) => o[0] === call[0]) === i) };
}

/** The table column for a column. */
export function tableColumn(c: Column, m: ModelFacts): Gen {
  const nature = natureOf(c, m);
  const text = (name = c.name, calls: [string, string][] = []): Gen => ({ cls: `${T}TextColumn`, make: phpString(name), calls });
  const hiddenByDefault: [string, string] = ["toggleable", "isToggledHiddenByDefault: true"];
  if (/^(created_at|updated_at|deleted_at)$/.test(c.name)) return text(c.name, [["dateTime", ""], ["sortable", ""], hiddenByDefault]);
  switch (nature) {
    case "foreign": {
      const rel = relationFor(c, m)!;
      const title = (rel.related && m.titles?.[rel.related]) || "name";
      return text(`${rel.name}.${title}`, [["label", phpString(labelFromName(rel.name))], ["sortable", ""], ["searchable", ""]]);
    }
    case "enum":
      return text(c.name, [["badge", ""], ["sortable", ""]]);
    case "boolean":
      return { cls: `${T}IconColumn`, make: phpString(c.name), calls: [["boolean", ""]] };
    case "date":
      return text(c.name, [["date", ""], ["sortable", ""]]);
    case "datetime":
      return text(c.name, [["dateTime", ""], ["sortable", ""]]);
    case "time":
      return text(c.name, [["time", ""], ["sortable", ""]]);
    case "money":
      return text(c.name, [["money", ""], ["sortable", ""]]);
    case "integer":
    case "decimal":
      return text(c.name, [["numeric", ""], ["sortable", ""]]);
    case "image":
      return { cls: `${T}ImageColumn`, make: phpString(c.name), calls: /avatar|photo|logo/.test(c.name) ? [["circular", ""]] : [] };
    case "color":
      return { cls: `${T}ColorColumn`, make: phpString(c.name), calls: [] };
    case "email":
      return text(c.name, [["searchable", ""], ["copyable", ""]]);
    case "text":
    case "richtext":
      return text(c.name, [["limit", "50"], hiddenByDefault]);
    case "json":
    case "tags":
      return text(c.name, [["badge", ""], hiddenByDefault]);
    default:
      return text(c.name, [["searchable", ""]]);
  }
}

/** Whether a column goes in a new resource's table by default: not passwords, secrets, long text, or JSON. */
export const inTableByDefault = (c: Column, m: ModelFacts) => !["password", "json", "text", "richtext", "id", "uuid", "file"].includes(natureOf(c, m)) && !/token|secret/.test(c.name);
/** Whether a column goes in a new resource's form by default. */
export const inFormByDefault = (c: Column) => !isSystemColumn(c);

/** The filter a column suggests, if any. */
export function filterFor(c: Column, m: ModelFacts): Gen | null {
  const nature = natureOf(c, m);
  if (c.name === "deleted_at") return { cls: `${FL}TrashedFilter`, make: "", calls: [] };
  if (nature === "foreign") {
    const rel = relationFor(c, m)!;
    const title = (rel.related && m.titles?.[rel.related]) || "name";
    return { cls: `${FL}SelectFilter`, make: phpString(rel.name), calls: [["relationship", `${phpString(rel.name)}, ${phpString(title)}`], ["searchable", ""], ["preload", ""]] };
  }
  if (nature === "enum") return { cls: `${FL}SelectFilter`, make: phpString(c.name), calls: [["options", `${cls(m.casts[c.name].replace(/^\\/, "").split(":")[0])}::class`]] };
  if (nature === "boolean") return { cls: `${FL}TernaryFilter`, make: phpString(c.name), calls: [] };
  return null;
}

/** The infolist entry for a column. */
export function infolistEntry(c: Column, m: ModelFacts): Gen {
  const nature = natureOf(c, m);
  const text = (name = c.name, calls: [string, string][] = []): Gen => ({ cls: `${I}TextEntry`, make: phpString(name), calls });
  switch (nature) {
    case "foreign": {
      const rel = relationFor(c, m)!;
      const title = (rel.related && m.titles?.[rel.related]) || "name";
      return text(`${rel.name}.${title}`, [["label", phpString(labelFromName(rel.name))]]);
    }
    case "enum":
      return text(c.name, [["badge", ""]]);
    case "boolean":
      return { cls: `${I}IconEntry`, make: phpString(c.name), calls: [["boolean", ""]] };
    case "date":
      return text(c.name, [["date", ""]]);
    case "datetime":
      return text(c.name, [["dateTime", ""]]);
    case "money":
      return text(c.name, [["money", ""]]);
    case "integer":
    case "decimal":
      return text(c.name, [["numeric", ""]]);
    case "image":
      return { cls: `${I}ImageEntry`, make: phpString(c.name), calls: [] };
    case "color":
      return { cls: `${I}ColorEntry`, make: phpString(c.name), calls: [] };
    case "richtext":
      return text(c.name, [["html", ""], ["columnSpanFull", ""]]);
    case "text":
      return text(c.name, [["columnSpanFull", ""]]);
    case "json":
    case "tags":
      return text(c.name, [["badge", ""]]);
    default:
      return text(c.name);
  }
}

// ---- Conditions: "visible when", "required when", and the like ----

export type Operator = "equals" | "notEquals" | "filled" | "blank" | "true" | "false" | "in";
export type Condition = { field: string; op: Operator; value?: string };
export const OPERATORS: [Operator, string][] = [
  ["equals", "is"],
  ["notEquals", "is not"],
  ["in", "is one of"],
  ["filled", "is filled"],
  ["blank", "is empty"],
  ["true", "is on"],
  ["false", "is off"],
];
export const needsValue = (op: Operator) => op === "equals" || op === "notEquals" || op === "in";

/** A PHP literal for a value typed in the builder: a number stays a number, anything else is a string. */
const literal = (v: string) => (/^-?\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : phpString(v));

/** The expression for one condition, on `$get`. */
function conditionCode(c: Condition): string {
  const get = `$get(${phpString(c.field)})`;
  switch (c.op) {
    case "equals":
      return `${get} === ${literal(c.value ?? "")}`;
    case "notEquals":
      return `${get} !== ${literal(c.value ?? "")}`;
    case "in":
      return `in_array(${get}, [${(c.value ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
        .map(literal)
        .join(", ")}], true)`;
    case "filled":
      return `filled(${get})`;
    case "blank":
      return `blank(${get})`;
    case "true":
      return `(bool) ${get}`;
    case "false":
      return `! ${get}`;
  }
}

/**
 * The closure for conditions, joined with `&&` (all) or `||` (any). `get` is how the file names Filament's Get
 * utility. Values from a select are strings, so `===` compares with the option's key as a string.
 */
export function conditionClosure(conditions: Condition[], join: "all" | "any", get: string): string {
  const parts = conditions.map(conditionCode);
  return `fn (${get} $get): bool => ${parts.join(join === "all" ? " && " : " || ")}`;
}

/** Reads a closure `conditionClosure` wrote, or null for other code. */
export function readConditions(code: string): { conditions: Condition[]; join: "all" | "any" } | null {
  const m = /^(?:static\s+)?fn\s*\(\s*[\w\\]+\s+\$get\s*\)\s*(?::\s*bool\s*)?=>\s*([\s\S]+)$/.exec(code.trim());
  if (!m) return null;
  const body = m[1].trim();
  const join = body.includes("||") ? "any" : "all";
  if (body.includes("||") && body.includes("&&")) return null;
  const conditions: Condition[] = [];
  const str = `'((?:[^'\\\\]|\\\\.)*)'`;
  const val = `(${str}|-?\\d+(?:\\.\\d+)?)`;
  const unquote = (s: string) => (s.startsWith("'") ? s.slice(1, -1).replace(/\\(['\\])/g, "$1") : s);
  for (const part of body.split(join === "any" ? "||" : "&&").map((p) => p.trim())) {
    const get = `\\$get\\(${str}\\)`;
    let r: RegExpExecArray | null;
    if ((r = new RegExp(`^${get}\\s*(===|!==|==|!=)\\s*${val}$`).exec(part))) conditions.push({ field: unquote(`'${r[1]}'`), op: r[2].startsWith("!") ? "notEquals" : "equals", value: unquote(r[3]) });
    else if ((r = new RegExp(`^in_array\\(${get},\\s*\\[(.*)\\](?:,\\s*true)?\\)$`).exec(part)))
      conditions.push({
        field: unquote(`'${r[1]}'`),
        op: "in",
        value: [...r[2].matchAll(new RegExp(val, "g"))].map((x) => unquote(x[1])).join(", "),
      });
    else if ((r = new RegExp(`^(filled|blank)\\(${get}\\)$`).exec(part))) conditions.push({ field: unquote(`'${r[2]}'`), op: r[1] as Operator });
    else if ((r = new RegExp(`^\\(bool\\)\\s*${get}$`).exec(part))) conditions.push({ field: unquote(`'${r[1]}'`), op: "true" });
    else if ((r = new RegExp(`^!\\s*${get}$`).exec(part))) conditions.push({ field: unquote(`'${r[1]}'`), op: "false" });
    else return null;
  }
  return { conditions, join };
}

/** Filament's Get utility for closures, by major version. */
export const getUtility = (major: number) => (major >= 4 ? "Filament\\Schemas\\Components\\Utilities\\Get" : "Filament\\Forms\\Get");
