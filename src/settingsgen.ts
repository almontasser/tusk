// The settings designer's code: a spatie/laravel-settings class (typed public properties and its group), read from
// the outline and changed with small edits, and the settings migration that stores, renames, deletes, and updates
// its values. Also the form fields a settings page gets for new properties. No editor imports, so Node tests it.
import { type Column, formField, type Gen, type ModelFacts, renderGen } from "./filamentgen.ts";
import { readRoot } from "./filamentschema.ts";
import { addMember, applyEdits, droppedImports, type Edit, Imports, insertItem, lineIndent, type OClass, type Outline, phpFile, phpString, phpValue, type PhpValue, removeProperty, replaceNode } from "./phpcode.ts";

export type SettingType = "string" | "int" | "float" | "bool" | "array" | "date" | "enum";
export const SETTING_TYPES: [SettingType, string][] = [
  ["string", "Text"],
  ["int", "Whole number"],
  ["float", "Decimal"],
  ["bool", "Yes or no"],
  ["array", "List"],
  ["date", "Date and time"],
  ["enum", "Enum"],
];
/** The class a new date property gets: immutable, so reading a setting can't change it. */
export const DATE_CLASS = "Carbon\\CarbonImmutable";
const DATE_CLASSES = /^(Carbon\\Carbon|Carbon\\CarbonImmutable|Illuminate\\Support\\Carbon|DateTime|DateTimeImmutable|DateTimeInterface)$/;

/** A stored value, as the settings table holds it: JSON. */
export type Stored = string | number | boolean | null | Stored[] | { [key: string]: Stored };

export type SettingProp = {
  name: string;
  type: SettingType;
  /** A date's or an enum's class. */
  cls?: string;
  nullable: boolean;
  /** The value Apply stores: a new property's first value, or an existing one's new value. Unknown when the app's values couldn't be read. */
  value: Stored | undefined;
  /** What the code and the database held when the designer read it, for renames and updates. */
  original?: { name: string; type: string; value: Stored | undefined; stored: boolean };
  /** A type the designer doesn't write, such as a union or a data object, kept as written. */
  code?: string;
};

export type SettingsSpec = { name: string; namespace: string; group: string; props: SettingProp[] };

/** A property name from what you type: `Tax rate` → `tax_rate`. */
export const propName = (s: string) =>
  s
    .trim()
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .replace(/^(\d)/, "_$1");

/** A group name from a class name: `GeneralSettings` → `general`. */
export const groupFor = (cls: string) => propName(cls.replace(/Settings$/, "") || cls);

/** A first value that fits a type, for a new property. */
export function defaultValue(type: SettingType, nullable: boolean, cases: Stored[] = []): Stored {
  if (nullable && (type === "date" || type === "enum")) return null;
  return ({ string: "", int: 0, float: 0, bool: false, array: [], date: null, enum: cases[0] ?? null } as Record<SettingType, Stored>)[type];
}

/** A value changed to fit another type, as far as it can be. */
export function coerce(value: Stored | undefined, type: SettingType, nullable: boolean, cases: Stored[] = []): Stored {
  if (value === undefined || (value === null && nullable)) return value ?? defaultValue(type, nullable, cases);
  if (type === "string") return typeof value === "object" ? JSON.stringify(value) : String(value);
  if (type === "int") return Math.trunc(Number(value)) || 0;
  if (type === "float") return Number(value) || 0;
  if (type === "bool") return !!value && value !== "0" && value !== "false";
  if (type === "array") return Array.isArray(value) || (typeof value === "object" && value) ? value : value === "" ? [] : [value];
  if (type === "enum") return cases.includes(value) ? value : defaultValue(type, nullable, cases);
  return typeof value === "string" ? value : defaultValue(type, nullable);
}

/** Reads a property's type: `?float`, `CarbonImmutable|null`, `App\Enums\Status`. Null for types the designer doesn't write. */
export function parseType(code: string | null, resolve: (name: string) => string, enums: string[]): { type: SettingType; cls?: string; nullable: boolean } | null {
  if (!code) return null;
  const parts = code.replace(/\s+/g, "").replace(/^\?/, "null|").split("|");
  const nullable = parts.includes("null");
  const rest = parts.filter((p) => p !== "null");
  if (rest.length !== 1) return null;
  const t = rest[0];
  const scalar = ({ string: "string", int: "int", float: "float", bool: "bool", array: "array" } as Record<string, SettingType>)[t.toLowerCase()];
  if (scalar) return { type: scalar, nullable };
  const cls = resolve(t);
  if (DATE_CLASSES.test(cls)) return { type: "date", cls, nullable };
  if (enums.includes(cls)) return { type: "enum", cls, nullable };
  return null;
}

/** A property's type as code, with classes named by `name`. */
export function typeCode(p: Pick<SettingProp, "type" | "cls" | "nullable">, name: (fqn: string) => string): string {
  const base = p.type === "date" ? name(p.cls ?? DATE_CLASS) : p.type === "enum" ? name(p.cls!) : p.type;
  return `${p.nullable ? "?" : ""}${base}`;
}

/** A class name as the file's imports spell it, resolved to its fully qualified name. */
export function resolver(outline: Outline): (name: string) => string {
  return (name: string) => {
    if (name.startsWith("\\")) return name.slice(1);
    const [first, ...rest] = name.split("\\");
    const use = outline.uses.find((u) => u.kind === "class" && u.alias.toLowerCase() === first.toLowerCase());
    if (use) return [use.name, ...rest].join("\\");
    return outline.namespace ? `${outline.namespace}\\${name}` : name;
  };
}

/** What the designer read from a settings class. */
export type ReadSettings = { spec: SettingsSpec; cls: OClass; groupReadable: boolean };

/**
 * Reads a settings class: its public, non-static properties and the string its `group()` returns. `values` are the
 * stored payloads by property name, or null when they couldn't be read.
 */
export function readSettings(outline: Outline, enums: string[], values: Record<string, Stored> | null): ReadSettings | null {
  const cls = outline.classes.find((c) => c.kind === "class" && /(^|\\)Settings$/.test(c.extends ?? "") && c.name);
  if (!cls) return null;
  const group = cls.methods.find((m) => m.name === "group")?.returns[0];
  const resolve = resolver(outline);
  const props: SettingProp[] = cls.properties
    .filter((p) => !p.static && p.visibility === "public")
    .map((p) => {
      const t = parseType(p.type, resolve, enums);
      const shared = cls.properties.filter((o) => o.span[0] === p.span[0]).length > 1;
      const value = values ? values[p.name] : undefined;
      const stored = !values || p.name in values;
      const original = { name: p.name, type: p.type ?? "", value: values ? (value ?? null) : undefined, stored };
      if (!t || shared) return { name: p.name, type: "string", nullable: false, value: original.value, original, code: p.type ?? "mixed" } as SettingProp;
      return { name: p.name, ...t, value: original.value, original };
    });
  const groupName = group?.kind === "string" ? group.value : groupFor(cls.name);
  return { cls, groupReadable: group?.kind === "string", spec: { name: cls.name, namespace: outline.namespace ?? "", group: groupName, props } };
}

/** A new settings class's file. */
export function settingsFile(spec: SettingsSpec): string {
  const props = spec.props.map((p) => `    public ${typeCode(p, (f) => `{{${f}}}`)} $${p.name};`).join("\n\n");
  return phpFile(
    spec.namespace,
    `class ${spec.name} extends {{Spatie\\LaravelSettings\\Settings}}
{
${props ? `${props}\n\n` : ""}    public static function group(): string
    {
        return ${phpString(spec.group)};
    }
}`,
  );
}

const declaration = /(public\s+(?:readonly\s+)?)([^$]*?)(\s*)\$(\w+)/;

/** The edits that turn a settings class into the designed one. Properties kept as code keep their type. */
export function settingsEdits(text: string, outline: Outline, before: ReadSettings, designed: SettingsSpec): Edit[] {
  const cls = before.cls;
  const edits: Edit[] = [];
  const imports = new Imports(text, outline);
  const name = (f: string) => imports.name(f);
  const own = (p: SettingProp) => cls.properties.find((o) => o.name === p.original?.name && !o.static);
  // Removed properties.
  for (const o of before.spec.props) if (!designed.props.some((p) => p.original?.name === o.name)) edits.push(removeProperty(text, own(o)!));
  // Changed properties: the type and name, in place, so attributes and comments stay.
  for (const p of designed.props) {
    const o = own(p);
    if (!o) continue;
    const was = before.spec.props.find((x) => x.name === o.name)!;
    const type = p.code ?? typeCode(p, name);
    if (p.name === o.name && (p.code || typeCode(was, (f) => f) === typeCode(p, (f) => f))) continue;
    const decl = text.slice(o.span[0], o.span[1]);
    const m = declaration.exec(decl);
    if (!m) continue;
    const at = o.span[0] + m.index + m[1].length;
    edits.push({ start: at, end: o.span[0] + m.index + m[0].length, text: `${type} $${p.name}` });
  }
  // New properties, after the last one.
  const added = designed.props.filter((p) => !p.original);
  if (added.length) {
    const last = cls.properties.filter((o) => !o.static).at(-1);
    const code = added.map((p) => `public ${typeCode(p, name)} $${p.name};`);
    if (last) {
      const indent = lineIndent(text, last.span[0]);
      const end = text.indexOf(";", last.span[1] - 1) + 1 || last.span[1];
      edits.push({ start: end, end, text: code.map((c) => `\n\n${indent}${c}`).join("") });
    } else {
      const indent = lineIndent(text, cls.bodyStart) + "    ";
      edits.push({ start: cls.bodyStart, end: cls.bodyStart, text: `\n${code.map((c) => `${indent}${c}`).join("\n\n")}\n` });
    }
  }
  // The group.
  const group = cls.methods.find((m) => m.name === "group");
  if (designed.group !== before.spec.group) {
    if (group?.returns[0] && before.groupReadable) edits.push(replaceNode(text, group.returns[0], phpString(designed.group)));
    else if (!group) edits.push(addMember(text, cls, `public static function group(): string\n{\n    return ${phpString(designed.group)};\n}`));
  }
  const all = [...edits, ...imports.edits()];
  return [...all, ...droppedImports(text, outline, all)];
}

/** The text a settings class will have after `settingsEdits`, for the preview. */
export const previewSettings = (text: string, edits: Edit[]) => applyEdits(text, edits);

/** A stored value as PHP for the migrator. */
export const valueCode = (v: Stored) => phpValue(v as PhpValue, "        ");

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The migrator's statements for the change: renames (a renamed property, or every property when the group
 * changes), deletes, updates of changed values, and adds of new properties, or of ones the database lacks.
 */
export function migrationLines(before: SettingsSpec | null, designed: SettingsSpec): string[] {
  const g = designed.group;
  const old = before?.group ?? g;
  const key = (group: string, name: string) => phpString(`${group}.${name}`);
  const lines: string[] = [];
  const kept = designed.props.filter((p) => p.original?.stored);
  for (const p of kept) if (p.original!.name !== p.name || old !== g) lines.push(`$this->migrator->rename(${key(old, p.original!.name)}, ${key(g, p.name)});`);
  for (const o of before?.props ?? []) if (o.original?.stored && !designed.props.some((p) => p.original?.name === o.name)) lines.push(`$this->migrator->delete(${key(old, o.name)});`);
  for (const p of kept) if (p.value !== undefined && p.original!.value !== undefined && !same(p.value, p.original!.value)) lines.push(`$this->migrator->update(${key(g, p.name)}, fn () => ${valueCode(p.value)});`);
  for (const p of designed.props) if (!p.original?.stored) lines.push(`$this->migrator->add(${key(g, p.name)}, ${valueCode(p.value ?? null)});`);
  return lines;
}

/** A settings migration's file, or null when nothing changes in the database. */
export function settingsMigration(lines: string[]): string | null {
  if (!lines.length) return null;
  return `<?php

use Spatie\\LaravelSettings\\Migrations\\SettingsMigration;

return new class extends SettingsMigration
{
    public function up(): void
    {
${lines.map((l) => `        ${l}`).join("\n")}
    }
};
`;
}

/** A settings migration's name: `create_general_settings`, or `update_general_settings`. */
export const migrationName = (group: string, isNew: boolean) => `${isNew ? "create" : "update"}_${propName(group) || "app"}_settings`;

/** How app code reads a setting. */
export function readCode(cls: string, prop: string): { app: string; inject: string } {
  const short = cls.slice(cls.lastIndexOf("\\") + 1);
  return { app: `app(\\${cls}::class)->${prop}`, inject: `public function __invoke(${short} $settings)\n{\n    $settings->${prop};\n}` };
}

/** Settings properties as the column descriptions filamentgen chooses fields from. */
export function settingsFacts(cls: string, props: SettingProp[], enums: string[]): ModelFacts {
  const types: Record<SettingType, string> = { string: "varchar", int: "integer", float: "decimal", bool: "boolean", array: "json", date: "timestamp", enum: "varchar" };
  const columns: Column[] = props.map((p) => ({ name: p.name, type: p.code ? "varchar" : types[p.type], nullable: p.nullable, default: p.type === "bool" ? null : undefined }));
  const casts = Object.fromEntries(props.filter((p) => p.type === "enum" && p.cls && !p.code).map((p) => [p.name, p.cls!]));
  return { class: cls, columns, casts, relations: [], enums };
}

/** The form field for each property, as a settings page writes it. */
export function fieldsFor(cls: string, props: SettingProp[], enums: string[]): Gen[] {
  const facts = settingsFacts(cls, props, enums);
  return facts.columns.map((c) => formField(c, facts));
}

/**
 * Edits that add fields to a settings page's `form()`: at the end of its components, or in place of the generator's
 * empty list. Null when the form isn't a list the designer can read.
 */
export function pageFieldEdits(text: string, outline: Outline, fields: Gen[]): Edit[] | null {
  const cls = outline.classes.find((c) => /(^|\\)SettingsPage$/.test(c.extends ?? "")) ?? outline.classes[0];
  const root = cls && readRoot(cls, "form");
  const slot = root && !root.custom && !root.delegate ? (root.slots.get("components") ?? root.slots.get("schema")) : undefined;
  if (!slot) return null;
  const imports = new Imports(text, outline);
  const items = fields.map((g) => renderGen(g, (f) => imports.name(f)));
  if (!items.length) return [];
  const edits = slot.array.items.length ? items.map((code) => insertItem(text, slot.array, slot.array.items.length, code)) : [insertItem(text, slot.array, 0, items.join(",\n"))];
  return [...edits, ...imports.edits()];
}

/** Adds a class to `config/settings.php`'s `settings` list, first, for a class outside the folders the package discovers. */
export function registerEdit(text: string, cls: string): Edit | null {
  const m = /(['"])settings\1\s*=>\s*\[/.exec(text);
  if (!m) return null;
  const at = m.index + m[0].length;
  return { start: at, end: at, text: `\n${lineIndent(text, m.index)}    \\${cls}::class,` };
}
