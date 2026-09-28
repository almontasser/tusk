// Importers and exporters for the import and export designer: the columns in `getColumns()` (a CSV column each, to
// read into a record's attribute or write from one) and how an importer finds the record a row fills. Calls the
// designer doesn't write stay as they are. No editor imports, so Node tests it.
import { type ArrayNode, type Edit, findCall, type OClass, type PNode, phpString, removeCall, replaceNode, setCall, textValue } from "./phpcode.ts";
import { squash } from "./widgetgen.ts";

export type PorterKind = "importer" | "exporter";
export const IMPORT_COLUMN = "Filament\\Actions\\Imports\\ImportColumn";
export const EXPORT_COLUMN = "Filament\\Actions\\Exports\\ExportColumn";

export type PorterColumn = {
  index: number;
  node: PNode;
  /** The attribute, or null for a column written as other code. */
  name: string | null;
  label: string | null;
  /** Importers: whether the CSV must have the column, its rules, an example value, and how the value is read. */
  required: boolean;
  rules: string[] | null;
  example: string | null;
  cast: "text" | "numeric" | "integer" | "boolean" | "array";
  relationship: boolean;
  /** Exporters: whether the column starts checked when someone exports. */
  enabled: boolean;
};

/** The array `getColumns()` returns. */
export function columnsArray(cls: OClass): ArrayNode | null {
  const m = cls.methods.find((x) => x.name === "getColumns");
  const r = m?.returns.length === 1 ? m.returns[0] : null;
  return r?.kind === "array" ? r : null;
}

export function readColumns(arr: ArrayNode): PorterColumn[] {
  return arr.items.map((item, index) => {
    const n = item.value;
    const base = n.kind === "chain" ? n.base : n;
    const ok = base.kind === "static" && /(Import|Export)Column$/.test(base.class) && base.method === "make";
    const call = (name: string) => (n.kind === "chain" ? findCall(n, name) : undefined);
    const rulesNode = call("rules")?.args.items[0]?.value;
    const rules = rulesNode?.kind === "array" && rulesNode.items.every((i) => i.value.kind === "string") ? rulesNode.items.map((i) => (i.value as { value: string }).value) : rulesNode ? null : [];
    const castCall = (["numeric", "integer", "boolean", "array"] as const).find((c) => call(c));
    const enabled = call("enabledByDefault");
    return {
      index,
      node: n,
      name: ok ? (textValue(base.args.items[0]?.value)?.text ?? null) : null,
      label: textValue(call("label")?.args.items[0]?.value)?.text ?? null,
      required: !!call("requiredMapping"),
      rules,
      example: textValue(call("example")?.args.items[0]?.value)?.text ?? null,
      cast: castCall ?? "text",
      relationship: !!call("relationship"),
      enabled: !enabled || enabled.args.items[0]?.value.kind !== "bool" || (enabled.args.items[0].value as { value: boolean }).value,
    };
  });
}

/** Sets or removes a call on a column. */
export function columnCallEdit(text: string, c: PorterColumn, name: string, args: string | null): Edit[] {
  const existing = c.node.kind === "chain" ? findCall(c.node, name) : undefined;
  if (args === null) return existing ? [removeCall(c.node, existing)] : [];
  if (existing && text.slice(existing.args.open + 1, existing.args.close) === args) return [];
  return [setCall(text, c.node, name, args)];
}

/** Changes how an import reads a column's value: as text, a number, a boolean, or a list. */
export function castEdits(text: string, c: PorterColumn, cast: PorterColumn["cast"]): Edit[] {
  const edits: Edit[] = [];
  for (const other of ["numeric", "integer", "boolean", "array"]) if (other !== cast) edits.push(...columnCallEdit(text, c, other, null));
  if (cast !== "text" && c.cast !== cast) edits.push(...columnCallEdit(text, c, cast, cast === "array" ? "','" : ""));
  return edits;
}

export const rulesCode = (rules: string[]) => `[${rules.map(phpString).join(", ")}]`;

/** A new column for an attribute: an importer's with rules from the column, an exporter's plain. */
export function columnCode(kind: PorterKind, name: string, o: { rules?: string[]; required?: boolean; cast?: PorterColumn["cast"] } = {}): string {
  if (kind === "exporter") return `{{${EXPORT_COLUMN}}}::make(${phpString(name)})`;
  const calls = [...(o.required ? ["->requiredMapping()"] : []), ...(o.cast && o.cast !== "text" ? [`->${o.cast}()`] : []), ...(o.rules?.length ? [`->rules(${rulesCode(o.rules)})`] : [])];
  return `{{${IMPORT_COLUMN}}}::make(${phpString(name)})${calls.map((c) => `\n    ${c}`).join("")}`;
}

/** The rules and cast an importer column gets from a database column. */
export function importRules(c: { type: string; nullable: boolean; default?: string | null }): { rules: string[]; required: boolean; cast: PorterColumn["cast"] } {
  const required = !c.nullable && (c.default === null || c.default === undefined);
  const rules = required ? ["required"] : [];
  const t = c.type.toLowerCase();
  let cast: PorterColumn["cast"] = "text";
  if (/bool|tinyint\(1\)/.test(t)) (cast = "boolean"), rules.push("boolean");
  else if (/int/.test(t)) (cast = "integer"), rules.push("integer");
  else if (/dec|float|double|numeric|real/.test(t)) (cast = "numeric"), rules.push("numeric");
  else if (/date|time/.test(t)) rules.push(/time/.test(t) && !/^date$/.test(t) ? "datetime" : "date");
  else if (/char|text|string/.test(t) && !/text/.test(t)) rules.push("max:255");
  return { rules, required, cast };
}

// ---- How an importer finds its record ----

export type Resolution = { mode: "create" } | { mode: "upsert" | "update"; column: string } | { mode: "code" };

/** Reads `resolveRecord()`: a new record, one found or made by a column, or one found by a column. */
export function readResolution(text: string, cls: OClass): Resolution {
  const m = cls.methods.find((x) => x.name === "resolveRecord");
  const r = m?.returns.length === 1 ? m.returns[0] : null;
  if (!r) return { mode: "code" };
  const code = squash(text.slice(r.span[0], r.span[1]));
  let x: RegExpExecArray | null;
  if (/^new \\?[\w\\]+\(\)$/.test(code)) return { mode: "create" };
  if ((x = /^\\?[\w\\]+::firstOrNew\(\['(\w+)' => \$this->data\['\1'\]\]\)$/.exec(code))) return { mode: "upsert", column: x[1] };
  if ((x = /^\\?[\w\\]+::query\(\)->where\('(\w+)', \$this->data\['\1'\]\)->first\(\)$/.exec(code))) return { mode: "update", column: x[1] };
  return { mode: "code" };
}

/** The expression `resolveRecord()` returns for a resolution. */
export function resolutionCode(model: string, r: Exclude<Resolution, { mode: "code" }>): string {
  const m = `{{${model}}}`;
  if (r.mode === "create") return `new ${m}()`;
  if (r.mode === "upsert") return `${m}::firstOrNew([\n    ${phpString(r.column)} => $this->data[${phpString(r.column)}],\n])`;
  return `${m}::query()->where(${phpString(r.column)}, $this->data[${phpString(r.column)}])->first()`;
}

export function resolutionEdits(text: string, cls: OClass, model: string, r: Exclude<Resolution, { mode: "code" }>): Edit[] {
  const m = cls.methods.find((x) => x.name === "resolveRecord");
  const ret = m?.returns.length === 1 ? m.returns[0] : null;
  return ret ? [replaceNode(text, ret, resolutionCode(model, r))] : [];
}
