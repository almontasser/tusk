// The model designer's code: migrations from columns, a model class with its fillable attributes, casts, and
// relationships, and a factory whose definition fakes each column. For an existing model, `diffColumns` turns the
// table as it is and as designed into a migration that changes it. No editor imports, so Node tests it.
import { phpString, phpValue } from "./phpcode.ts";

/** Blueprint's column types the designer offers, with what each needs. */
export const COLUMN_TYPES: { type: string; label: string; group: string; length?: boolean; precision?: boolean }[] = [
  { type: "string", label: "String", group: "Text", length: true },
  { type: "text", label: "Text", group: "Text" },
  { type: "mediumText", label: "Medium text", group: "Text" },
  { type: "longText", label: "Long text", group: "Text" },
  { type: "char", label: "Char", group: "Text", length: true },
  { type: "integer", label: "Integer", group: "Numbers" },
  { type: "bigInteger", label: "Big integer", group: "Numbers" },
  { type: "unsignedInteger", label: "Unsigned integer", group: "Numbers" },
  { type: "unsignedBigInteger", label: "Unsigned big integer", group: "Numbers" },
  { type: "smallInteger", label: "Small integer", group: "Numbers" },
  { type: "tinyInteger", label: "Tiny integer", group: "Numbers" },
  { type: "decimal", label: "Decimal", group: "Numbers", precision: true },
  { type: "float", label: "Float", group: "Numbers" },
  { type: "double", label: "Double", group: "Numbers" },
  { type: "boolean", label: "Boolean", group: "Other" },
  { type: "date", label: "Date", group: "Date and time" },
  { type: "dateTime", label: "Date and time", group: "Date and time" },
  { type: "timestamp", label: "Timestamp", group: "Date and time" },
  { type: "time", label: "Time", group: "Date and time" },
  { type: "year", label: "Year", group: "Date and time" },
  { type: "json", label: "JSON", group: "Other" },
  { type: "uuid", label: "UUID", group: "Other" },
  { type: "ulid", label: "ULID", group: "Other" },
  { type: "foreignId", label: "Foreign key (belongs to)", group: "Relationships" },
  { type: "foreignUuid", label: "Foreign UUID", group: "Relationships" },
  { type: "foreignUlid", label: "Foreign ULID", group: "Relationships" },
  { type: "ipAddress", label: "IP address", group: "Other" },
  { type: "binary", label: "Binary", group: "Other" },
];

export type OnDelete = "cascade" | "set null" | "restrict" | "none";

export type ColumnSpec = {
  /** A stable key for the designer's rows, which survives renames. */
  id: string;
  name: string;
  type: string;
  length?: number;
  precision?: number;
  scale?: number;
  nullable: boolean;
  /** The default as PHP code, such as `0`, `'draft'`, or `true`; empty for none. */
  default?: string;
  unique?: boolean;
  index?: boolean;
  /** For foreign keys: the table it points to, and what deleting that row does. */
  references?: string;
  onDelete?: OnDelete;
  /** An enum the column is cast to, fully qualified. */
  enum?: string;
  /** A cast, when the type's own isn't wanted. Empty means the designer chooses. */
  cast?: string;
  fillable: boolean;
  hidden?: boolean;
  comment?: string;
  /** The column's name in the database, for a column that exists: renames and changes compare with it. */
  original?: ColumnSpec;
};

export type RelationType = "belongsTo" | "hasOne" | "hasMany" | "belongsToMany" | "morphMany" | "morphTo" | "morphToMany";
export type RelationSpec = { id: string; type: RelationType; name: string; related: string; foreignKey?: string; pivot?: string; existing?: boolean };

export type ModelSpec = {
  name: string;
  namespace: string;
  table: string;
  key: "id" | "uuid" | "ulid";
  timestamps: boolean;
  softDeletes: boolean;
  columns: ColumnSpec[];
  relations: RelationSpec[];
};

const RELATION_CLASS: Record<RelationType, string> = {
  belongsTo: "BelongsTo",
  hasOne: "HasOne",
  hasMany: "HasMany",
  belongsToMany: "BelongsToMany",
  morphMany: "MorphMany",
  morphTo: "MorphTo",
  morphToMany: "MorphToMany",
};

// ---- Names ----

const IRREGULAR: Record<string, string> = { person: "people", child: "children", man: "men", woman: "women", mouse: "mice", goose: "geese", ox: "oxen", tooth: "teeth", foot: "feet", datum: "data", status: "statuses", index: "indices" };
const UNCOUNTABLE = new Set(["equipment", "information", "rice", "money", "species", "series", "fish", "sheep", "news", "data", "feedback", "staff", "audio", "media"]);

/** English plural, close to Laravel's pluralizer for the names tables have. */
export function plural(word: string): string {
  const lower = word.toLowerCase();
  if (UNCOUNTABLE.has(lower)) return word;
  if (IRREGULAR[lower]) return word.slice(0, 1) + IRREGULAR[lower].slice(1);
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + "es";
  if (/(?<!f)fe?$/i.test(word) && !/(roof|chef|belief|chief|proof|safe)$/i.test(word)) return word.replace(/fe?$/i, "ves");
  return word + "s";
}

/** English singular, the other way. */
export function singular(word: string): string {
  const lower = word.toLowerCase();
  for (const [s, p] of Object.entries(IRREGULAR)) if (lower === p) return word.slice(0, 1) + s.slice(1);
  if (UNCOUNTABLE.has(lower)) return word;
  if (/ies$/i.test(word)) return word.slice(0, -3) + "y";
  if (/(ss|x|z|ch|sh)es$/i.test(word)) return word.slice(0, -2);
  if (/ves$/i.test(word)) return word.slice(0, -3) + "f";
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1);
  return word;
}

export const snake = (s: string) => s.replace(/([a-z\d])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();
export const studly = (s: string) => s.replace(/(^|[_\s-])([a-z\d])/g, (_, __, c: string) => c.toUpperCase());
export const camel = (s: string) => studly(s).replace(/^[A-Z]/, (c) => c.toLowerCase());

/** The table Laravel gives a model: `BlogPost` → `blog_posts`. */
export const tableFor = (model: string) => {
  const parts = snake(model).split("_");
  parts.push(plural(parts.pop()!));
  return parts.join("_");
};

/** The foreign key column for a relationship to a model: `category` → `category_id`. */
export const foreignKeyFor = (relation: string) => `${snake(relation)}_id`;

/** The pivot table for two models, as Laravel names it: the singular names in alphabetical order. */
export const pivotTable = (a: string, b: string) => [snake(a), snake(b)].sort().join("_");

const short = (fqn: string) => fqn.slice(fqn.lastIndexOf("\\") + 1);

// ---- Columns ----

/** The Blueprint call for a column, without `$table->` or the semicolon. */
export function columnCall(c: ColumnSpec): string {
  const name = phpString(c.name);
  let call: string;
  if (c.type === "foreignId" || c.type === "foreignUuid" || c.type === "foreignUlid") {
    call = `${c.type}(${name})`;
    if (c.nullable) call += "->nullable()";
    call += c.references ? `->constrained(${phpString(c.references)})` : "->constrained()";
    if (c.onDelete === "cascade") call += "->cascadeOnDelete()";
    else if (c.onDelete === "set null") call += "->nullOnDelete()";
    else if (c.onDelete === "restrict") call += "->restrictOnDelete()";
    return call;
  }
  const args = [name];
  if ((c.type === "string" || c.type === "char") && c.length && c.length !== 255) args.push(String(c.length));
  if (c.type === "decimal") args.push(String(c.precision ?? 10), String(c.scale ?? 2));
  call = `${c.type}(${args.join(", ")})`;
  if (c.nullable) call += "->nullable()";
  if (c.default !== undefined && c.default !== "") call += `->default(${c.default})`;
  if (c.unique) call += "->unique()";
  else if (c.index) call += "->index()";
  if (c.comment) call += `->comment(${phpString(c.comment)})`;
  return call;
}

/** The cast a column gets, from its enum, its type, or its name, or null for none. */
export function castFor(c: ColumnSpec): string | null {
  if (c.cast) return c.cast;
  if (c.enum) return `${short(c.enum)}::class`;
  if (c.name === "password") return "'hashed'";
  switch (c.type) {
    case "boolean":
      return "'boolean'";
    case "date":
      return "'date'";
    case "dateTime":
    case "timestamp":
      return "'datetime'";
    case "json":
      return "'array'";
    case "decimal":
      return `'decimal:${c.scale ?? 2}'`;
  }
  return null;
}

/** A Faker call that fits a column, for a factory's definition. */
export function fakerFor(c: ColumnSpec, relations: RelationSpec[]): string {
  const n = c.name.toLowerCase();
  if (c.type.startsWith("foreign")) {
    const rel = relations.find((r) => r.type === "belongsTo" && (r.foreignKey ?? foreignKeyFor(r.name)) === c.name);
    return rel ? `${short(rel.related)}::factory()` : "null";
  }
  if (c.enum) return `fake()->randomElement(${short(c.enum)}::cases())`;
  if (n === "email" || n.endsWith("_email")) return c.unique ? "fake()->unique()->safeEmail()" : "fake()->safeEmail()";
  if (n === "name" || n === "full_name") return "fake()->name()";
  if (n === "first_name") return "fake()->firstName()";
  if (n === "last_name") return "fake()->lastName()";
  if (n === "username") return "fake()->unique()->userName()";
  if (n === "password") return "'password'";
  if (/phone|mobile/.test(n)) return "fake()->phoneNumber()";
  if (/^(title|subject|headline)$/.test(n)) return "fake()->sentence()";
  if (n === "slug") return "fake()->unique()->slug()";
  if (/url|website|link/.test(n)) return "fake()->url()";
  if (/address/.test(n)) return "fake()->address()";
  if (n === "city") return "fake()->city()";
  if (n === "country") return "fake()->country()";
  if (/color|colour/.test(n)) return "fake()->hexColor()";
  if (/image|avatar|photo|logo/.test(n)) return "fake()->imageUrl()";
  if (/price|amount|total|cost/.test(n)) return "fake()->randomFloat(2, 1, 1000)";
  switch (c.type) {
    case "boolean":
      return "fake()->boolean()";
    case "text":
    case "mediumText":
    case "longText":
      return "fake()->paragraphs(3, true)";
    case "integer":
    case "bigInteger":
    case "unsignedInteger":
    case "unsignedBigInteger":
    case "smallInteger":
    case "tinyInteger":
      return "fake()->numberBetween(1, 100)";
    case "decimal":
    case "float":
    case "double":
      return "fake()->randomFloat(2, 0, 1000)";
    case "date":
      return "fake()->date()";
    case "dateTime":
    case "timestamp":
      return "fake()->dateTime()";
    case "time":
      return "fake()->time()";
    case "year":
      return "fake()->year()";
    case "json":
      return "[]";
    case "uuid":
      return "fake()->uuid()";
    case "ulid":
      return "(string) \\Illuminate\\Support\\Str::ulid()";
    case "ipAddress":
      return "fake()->ipv4()";
  }
  return c.unique ? "fake()->unique()->word()" : "fake()->words(3, true)";
}

// ---- Files ----

const indent = (lines: string[], by: string) => lines.map((l) => (l ? by + l : l)).join("\n");

/** A migration that creates the model's table, and the pivot tables of its many-to-many relationships. */
export function createMigration(m: ModelSpec): string {
  const lines = [m.key === "uuid" ? "$table->uuid('id')->primary();" : m.key === "ulid" ? "$table->ulid('id')->primary();" : "$table->id();", ...m.columns.map((c) => `$table->${columnCall(c)};`)];
  if (m.timestamps) lines.push("$table->timestamps();");
  if (m.softDeletes) lines.push("$table->softDeletes();");
  return `<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::create(${phpString(m.table)}, function (Blueprint $table) {
${indent(lines, "            ")}
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists(${phpString(m.table)});
    }
};
`;
}

/** A migration for a many-to-many relationship's pivot table. */
export function pivotMigration(table: string, a: { table: string; key: string; type?: string }, b: { table: string; key: string; type?: string }): string {
  return `<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::create(${phpString(table)}, function (Blueprint $table) {
            $table->${a.type ?? "foreignId"}(${phpString(a.key)})->constrained(${phpString(a.table)})->cascadeOnDelete();
            $table->${b.type ?? "foreignId"}(${phpString(b.key)})->constrained(${phpString(b.table)})->cascadeOnDelete();
            $table->primary([${phpString(a.key)}, ${phpString(b.key)}]);
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists(${phpString(table)});
    }
};
`;
}

/** A relationship method, such as `public function category(): BelongsTo`. */
export function relationMethod(r: RelationSpec): string {
  const cls = RELATION_CLASS[r.type];
  const related = `${short(r.related)}::class`;
  let body: string;
  switch (r.type) {
    case "morphTo":
      body = "$this->morphTo()";
      break;
    case "morphMany":
    case "morphToMany":
      body = `$this->${r.type}(${related}, ${phpString(r.foreignKey || `${camel(r.name)}able`)})`;
      break;
    case "belongsTo":
      body = `$this->belongsTo(${related}${r.foreignKey && r.foreignKey !== foreignKeyFor(r.name) ? `, ${phpString(r.foreignKey)}` : ""})`;
      break;
    case "belongsToMany":
      body = `$this->belongsToMany(${related}${r.pivot ? `, ${phpString(r.pivot)}` : ""})`;
      break;
    default:
      body = `$this->${r.type}(${related}${r.foreignKey ? `, ${phpString(r.foreignKey)}` : ""})`;
  }
  return `public function ${r.name}(): ${cls}\n{\n    return ${body};\n}`;
}

/** The classes a model file imports: Eloquent's, the relationship types it uses, and the enums it casts to. */
function modelImports(m: ModelSpec, factory: boolean): string[] {
  const uses = new Set<string>(["Illuminate\\Database\\Eloquent\\Model"]);
  if (factory) uses.add("Illuminate\\Database\\Eloquent\\Factories\\HasFactory");
  if (m.softDeletes) uses.add("Illuminate\\Database\\Eloquent\\SoftDeletes");
  if (m.key === "uuid") uses.add("Illuminate\\Database\\Eloquent\\Concerns\\HasUuids");
  if (m.key === "ulid") uses.add("Illuminate\\Database\\Eloquent\\Concerns\\HasUlids");
  for (const r of m.relations) {
    uses.add(`Illuminate\\Database\\Eloquent\\Relations\\${RELATION_CLASS[r.type]}`);
    if (r.related.replace(/\\[^\\]+$/, "") !== m.namespace && r.type !== "morphTo") uses.add(r.related);
  }
  for (const c of m.columns) if (c.enum && !c.cast) uses.add(c.enum);
  return [...uses].sort((a, b) => a.localeCompare(b));
}

/** A new model's class. */
export function modelFile(m: ModelSpec, o: { factory: boolean }): string {
  const traits = [o.factory ? "HasFactory" : "", m.key === "uuid" ? "HasUuids" : m.key === "ulid" ? "HasUlids" : "", m.softDeletes ? "SoftDeletes" : ""].filter(Boolean);
  const members: string[] = [];
  if (traits.length) members.push(`${o.factory ? `/** @use HasFactory<\\Database\\Factories\\${m.name}Factory> */\n` : ""}use ${traits.join(", ")};`);
  if (m.table !== tableFor(m.name)) members.push(`protected $table = ${phpString(m.table)};`);
  if (!m.timestamps) members.push("public $timestamps = false;");
  const fillable = m.columns.filter((c) => c.fillable).map((c) => c.name);
  if (fillable.length) members.push(`protected $fillable = ${phpValue(fillable)};`.replace(/^protected \$fillable = \[(.*)\];$/s, (all, inner: string) => (inner.includes("\n") ? all : `protected $fillable = [\n    ${inner.split(", ").join(",\n    ")},\n];`)));
  const hidden = m.columns.filter((c) => c.hidden).map((c) => c.name);
  if (hidden.length) members.push(`protected $hidden = ${phpValue(hidden)};`);
  const casts = m.columns.map((c) => [c.name, castFor(c)] as const).filter((x): x is [string, string] => !!x[1]);
  if (casts.length) members.push(`/**\n * Get the attributes that should be cast.\n *\n * @return array<string, string>\n */\nprotected function casts(): array\n{\n    return [\n${casts.map(([k, v]) => `        ${phpString(k)} => ${v},`).join("\n")}\n    ];\n}`);
  for (const r of m.relations) members.push(relationMethod(r));
  return `<?php

namespace ${m.namespace};

${modelImports(m, o.factory)
  .map((u) => `use ${u};`)
  .join("\n")}

class ${m.name} extends Model
{
${members.map((mem) => indent(mem.split("\n"), "    ")).join("\n\n")}
}
`;
}

/** A factory for a new model, faking each column. */
export function factoryFile(m: ModelSpec): string {
  const modelFqn = `${m.namespace}\\${m.name}`;
  const related = [...new Set(m.relations.filter((r) => r.type === "belongsTo").map((r) => r.related))].filter((r) => r !== modelFqn);
  const uses = [modelFqn, ...related, ...m.columns.filter((c) => c.enum).map((c) => c.enum!), "Illuminate\\Database\\Eloquent\\Factories\\Factory"];
  const lines = m.columns.filter((c) => !(c.nullable && c.type.startsWith("foreign"))).map((c) => `${phpString(c.name)} => ${fakerFor(c, m.relations)},`);
  return `<?php

namespace Database\\Factories;

${[...new Set(uses)]
  .sort((a, b) => a.localeCompare(b))
  .map((u) => `use ${u};`)
  .join("\n")}

/**
 * @extends Factory<${m.name}>
 */
class ${m.name}Factory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
${lines.map((l) => `            ${l}`).join("\n")}
        ];
    }
}
`;
}

// ---- Changing a table ----

export type ColumnChange = { kind: "add"; column: ColumnSpec } | { kind: "drop"; column: ColumnSpec } | { kind: "rename"; from: string; to: string } | { kind: "change"; column: ColumnSpec; before: ColumnSpec };

/** What turns the table's columns (each designed column's `original`) into the designed ones. */
export function diffColumns(designed: ColumnSpec[], existing: ColumnSpec[]): ColumnChange[] {
  const changes: ColumnChange[] = [];
  const kept = new Set<string>();
  for (const c of designed) {
    if (!c.original) {
      changes.push({ kind: "add", column: c });
      continue;
    }
    kept.add(c.original.name);
    if (c.original.name !== c.name) changes.push({ kind: "rename", from: c.original.name, to: c.name });
    const o = c.original;
    const changed = o.type !== c.type || o.nullable !== c.nullable || (o.default ?? "") !== (c.default ?? "") || (o.length ?? 0) !== (c.length ?? 0) || (o.precision ?? 0) !== (c.precision ?? 0) || (o.scale ?? 0) !== (c.scale ?? 0);
    if (changed) changes.push({ kind: "change", column: c, before: o });
  }
  for (const e of existing) if (!kept.has(e.name)) changes.push({ kind: "drop", column: e });
  return changes;
}

/** A name for the migration that makes changes, such as `add_status_to_posts_table`. */
export function alterName(table: string, changes: ColumnChange[]): string {
  const adds = changes.filter((c) => c.kind === "add");
  const drops = changes.filter((c) => c.kind === "drop");
  if (adds.length === changes.length && adds.length <= 2) return `add_${adds.map((c) => (c as { column: ColumnSpec }).column.name).join("_and_")}_to_${table}_table`;
  if (drops.length === changes.length && drops.length <= 2) return `remove_${drops.map((c) => (c as { column: ColumnSpec }).column.name).join("_and_")}_from_${table}_table`;
  return `update_${table}_table`;
}

/** A migration that applies changes to a table, and undoes them in reverse order. */
export function alterMigration(table: string, changes: ColumnChange[], o: { softDeletes?: "add" | "drop" } = {}): string {
  const up: string[] = [];
  const down: string[] = [];
  for (const ch of changes) {
    switch (ch.kind) {
      case "add":
        up.push(`$table->${columnCall(ch.column)};`);
        down.unshift(ch.column.type.startsWith("foreign") ? `$table->dropConstrainedForeignId(${phpString(ch.column.name)});` : `$table->dropColumn(${phpString(ch.column.name)});`);
        break;
      case "drop":
        up.push(ch.column.type.startsWith("foreign") ? `$table->dropConstrainedForeignId(${phpString(ch.column.name)});` : `$table->dropColumn(${phpString(ch.column.name)});`);
        down.unshift(`$table->${columnCall(ch.column)};`);
        break;
      case "rename":
        up.push(`$table->renameColumn(${phpString(ch.from)}, ${phpString(ch.to)});`);
        down.unshift(`$table->renameColumn(${phpString(ch.to)}, ${phpString(ch.from)});`);
        break;
      case "change":
        up.push(`$table->${columnCall(ch.column)}->change();`);
        down.unshift(`$table->${columnCall({ ...ch.before, name: ch.column.name })}->change();`);
        break;
    }
  }
  if (o.softDeletes === "add") up.push("$table->softDeletes();"), down.unshift("$table->dropSoftDeletes();");
  if (o.softDeletes === "drop") up.push("$table->dropSoftDeletes();"), down.unshift("$table->softDeletes();");
  return `<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::table(${phpString(table)}, function (Blueprint $table) {
${indent(up, "            ")}
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table(${phpString(table)}, function (Blueprint $table) {
${indent(down, "            ")}
        });
    }
};
`;
}

/** The migration file's name for now: `2026_09_28_143000_create_posts_table.php`. */
export function migrationFileName(name: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}_${p(now.getMonth() + 1)}_${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}_${name}.php`;
}

/**
 * A model's list of attributes, such as `$fillable`, after the designer's changes, in the model's own order: renamed
 * columns keep their place, unticked and dropped ones go, new ones go at the end, and entries that aren't
 * columns of the table stay.
 */
export function mergeList(list: string[], before: ColumnSpec[], designed: ColumnSpec[], wanted: (c: ColumnSpec) => boolean): string[] {
  const out: string[] = [];
  for (const name of list) {
    const was = before.find((b) => b.name === name);
    if (!was) {
      out.push(name);
      continue;
    }
    const now = designed.find((c) => c.original === was || c.original?.name === name);
    if (now && wanted(now)) out.push(now.name);
  }
  for (const c of designed) if (wanted(c) && !out.includes(c.name)) out.push(c.name);
  return out;
}

// ---- Reading a table ----

/** A designer column from a database column, as `introspect.php model` reports it. */
export function columnFromDatabase(col: { name: string; type: string; fullType?: string; nullable: boolean; default?: string | null; autoIncrement?: boolean }, o: { unique: boolean; index: boolean; foreign?: { table: string; onDelete: string | null }; cast?: string; fillable: boolean; hidden: boolean; id: string }): ColumnSpec {
  let c = col;
  const t = c.type.toLowerCase();
  const full = (c.fullType ?? "").toLowerCase();
  const length = Number(/\((\d+)\)/.exec(full)?.[1] ?? 0) || undefined;
  const [precision, scale] = (/\((\d+),\s*(\d+)\)/.exec(full) ?? []).slice(1).map(Number);
  let type = "string";
  // A foreign key's type follows the key it points to: UUIDs and ULIDs have their own.
  if (o.foreign) type = t === "uuid" ? "foreignUuid" : (t === "char" || t === "bpchar") && /\(26\)/.test(full) ? "foreignUlid" : "foreignId";
  else if (/^(varchar|string|nvarchar)$/.test(t)) type = "string";
  else if (t === "char" || t === "bpchar") type = "char";
  else if (t === "text" || t === "tinytext") type = "text";
  else if (t === "mediumtext") type = "mediumText";
  else if (t === "longtext") type = "longText";
  else if (t === "bigint" || t === "int8") type = /unsigned/.test(full) ? "unsignedBigInteger" : "bigInteger";
  else if (t === "int" || t === "integer" || t === "int4") type = /unsigned/.test(full) ? "unsignedInteger" : "integer";
  else if (t === "smallint" || t === "int2") type = "smallInteger";
  else if (t === "tinyint") type = /\(1\)/.test(full) ? "boolean" : "tinyInteger";
  else if (t === "bool" || t === "boolean") type = "boolean";
  else if (/^(decimal|numeric)$/.test(t)) type = "decimal";
  else if (t === "float" || t === "real" || t === "float4") type = "float";
  else if (t === "double" || t === "float8") type = "double";
  else if (t === "date") type = "date";
  else if (t === "datetime") type = "dateTime";
  else if (/^timestamp/.test(t)) type = "timestamp";
  else if (/^time/.test(t)) type = "time";
  else if (t === "year") type = "year";
  else if (/^jsonb?$/.test(t)) type = "json";
  else if (t === "uuid") type = "uuid";
  else if (/blob|binary|bytea/.test(t)) type = "binary";
  // SQLite reports a boolean column as integer; its cast says what it holds.
  if (o.cast === "boolean" || o.cast === "bool") type = "boolean";
  // Postgres writes defaults with a cast, such as 'draft'::character varying or '0'::bigint.
  if (c.default !== null && c.default !== undefined) c = { ...c, default: c.default.replace(/::[\w\s"]+(\[\])?$/, "") };
  // A computed default, such as now() or nextval('…'), isn't a value the designer can write back.
  if (c.default && /^[\w.]+\(.*\)$|^(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|LOCALTIMESTAMP)$/i.test(c.default)) c = { ...c, default: null };
  const raw = c.default?.replace(/^'(.*)'$/, "$1");
  // Booleans come back as 0 and 1, sometimes quoted.
  if (type === "boolean" && raw !== undefined && /^(0|1|true|false)$/i.test(raw)) c = { ...c, default: /^(1|true)$/i.test(raw) ? "true" : "false" };
  // A number quoted in the database is a number to a numeric column.
  if (type !== "boolean" && raw !== undefined && /^-?\d+(\.\d+)?$/.test(raw) && /int|decimal|numeric|float|double|real|serial/.test(t)) c = { ...c, default: raw };
  const def = c.default === null || c.default === undefined ? undefined : /^'.*'$/.test(c.default) || /^-?\d+(\.\d+)?$/.test(c.default) ? c.default : /^(true|false|null)$/i.test(c.default) ? c.default.toLowerCase() : phpString(c.default);
  return {
    id: o.id,
    name: c.name,
    type,
    // 255 is Blueprint's default length, so it isn't written.
    length: (type === "string" || type === "char") && length !== 255 ? length : undefined,
    precision: type === "decimal" ? precision : undefined,
    scale: type === "decimal" ? scale : undefined,
    nullable: c.nullable,
    default: def,
    unique: o.unique,
    index: o.index && !o.unique,
    references: o.foreign?.table,
    onDelete: o.foreign ? ((o.foreign.onDelete?.toLowerCase() === "cascade" ? "cascade" : o.foreign.onDelete?.toLowerCase() === "set null" ? "set null" : o.foreign.onDelete?.toLowerCase() === "restrict" ? "restrict" : "none") as OnDelete) : undefined,
    fillable: o.fillable,
    hidden: o.hidden,
  };
}
