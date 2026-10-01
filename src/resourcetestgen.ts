// Generated tests for a Filament resource: Pest or PHPUnit tests that list, create, edit, and view its records,
// check each required and unique field, and check that users the policy refuses are kept out, written from what the
// designer reads (the form's fields, the table's columns, the pages, and the policy's rules). Values come from the
// model's factory, and from the field's type for fields the factory doesn't fill. No editor imports, so Node tests it.
import { type Comp, type Root, resolve, shortClass, walk } from "./filamentschema.ts";
import { indentCode, mapValue, type OClass, phpFile, phpString, phpValue } from "./phpcode.ts";
import { columnFromDatabase, factoryFile, foreignKeyFor, type ModelSpec, type RelationType } from "./modelgen.ts";
import type { Rule } from "./policygen.ts";

export type FieldKind = "text" | "email" | "url" | "number" | "textarea" | "rich" | "bool" | "date" | "datetime" | "options" | "relation" | "enum" | "other";
export type TestField = {
  name: string;
  kind: FieldKind;
  required: boolean;
  unique: boolean;
  /** For a relationship select: the related model. */
  related?: string;
  /** For a select of an enum's cases: the enum. */
  enum?: string;
  /** For a select of fixed options: the first option's key. */
  option?: string | number;
};

export type PageKind = "list" | "create" | "edit" | "view" | "manage";
export type TestAbility = "viewAny" | "view" | "create" | "update";

export type TestSpec = {
  style: "pest" | "phpunit";
  /** For PHPUnit: the class's namespace and name. */
  namespace: string;
  className: string;
  model: string;
  /** The model's label and plural label, as the resource names them: "post", "posts". */
  label: string;
  plural: string;
  keyName: string;
  user: string;
  panel: string | null;
  pages: Partial<Record<PageKind, string>>;
  fields: TestField[];
  /** The attributes the model's factory fills, or null when its definition can't be read (taken as all). */
  factoryKeys: string[] | null;
  /** Table columns shown by default. */
  columns: string[];
  /** For a simple resource: whether its table has an edit action. */
  manageEdit: boolean;
  /** The policy's rules for the abilities the pages check, or null without a policy. */
  policy: { rules: Partial<Record<TestAbility, Rule | null>>; spatie: boolean } | null;
  /** Whether the file has to use RefreshDatabase itself, because tests/Pest.php doesn't for it. */
  refreshDatabase: boolean;
};

/** A test, or the file's setup, with the text that shows a file already has it. */
export type TestBlock = { key: string; marker: string; code: string };

// ---- Reading the form ----

const FIELDS: Record<string, FieldKind> = {
  TextInput: "text",
  Textarea: "textarea",
  MarkdownEditor: "textarea",
  RichEditor: "rich",
  Toggle: "bool",
  Checkbox: "bool",
  DatePicker: "date",
  DateTimePicker: "datetime",
  Select: "options",
  Radio: "options",
  ToggleButtons: "options",
};
/** Calls that make a field's presence or saving depend on something, so a test can't count on it. */
const CONDITIONAL = /^(visible|hidden|visibleOn|hiddenOn|visibleJs|hiddenJs|disabled|disabledOn|dehydrated|dehydratedWhenHidden|statePath|saveRelationshipsUsing)$/;
const hasCall = (c: Comp, name: string) => c.calls.some((k) => k.name === name);
/** A flag call such as `required()` or `required(true)`; a closure or condition isn't counted. */
const flag = (c: Comp, name: string) => c.calls.some((k) => k.name === name && (!k.args.items.length || (k.args.items[0].value.kind === "bool" && k.args.items[0].value.value)));
const isField = (c: Comp) => /^Filament\\Forms\\Components\\/.test(c.cls) && !/\\(Hidden|Placeholder|ViewField)$/.test(c.cls);

/**
 * The fields a test can fill, from a form's root: named fields that are always there and save to the record.
 * Fields in a repeater, a layout with its own relationship or state path, or a conditional layout are left out.
 */
export function readFields(root: Root, model: { relations: { name: string; related: string | null }[] }): TestField[] {
  const out: TestField[] = [];
  walk(root, (comp, path) => {
    if (!comp.name || !isField(comp)) return;
    for (let i = 1; i < path.length; i++) {
      const owner = resolve(root, path.slice(0, i))?.entry.comp;
      if (owner && (isField(owner) || hasCall(owner, "relationship") || owner.calls.some((k) => CONDITIONAL.test(k.name)))) return;
    }
    if (comp.calls.some((k) => CONDITIONAL.test(k.name))) return;
    const short = shortClass(comp.cls);
    let kind: FieldKind = FIELDS[short] ?? "other";
    const field: TestField = { name: comp.name, kind, required: flag(comp, "required"), unique: hasCall(comp, "unique") };
    if (short === "TextInput") kind = hasCall(comp, "password") ? "other" : hasCall(comp, "email") ? "email" : hasCall(comp, "url") ? "url" : hasCall(comp, "numeric") || hasCall(comp, "integer") ? "number" : "text";
    if (kind === "options") {
      const rel = comp.calls.find((k) => k.name === "relationship");
      const options = comp.calls.find((k) => k.name === "options" || k.name === "enum")?.args.items[0]?.value;
      if (hasCall(comp, "multiple")) kind = "other";
      else if (rel) {
        const name = rel.args.items.find((a) => a.name === "name" || !a.name)?.value;
        const related = name?.kind === "string" ? model.relations.find((r) => r.name === name.value)?.related : null;
        if (related) (kind = "relation"), (field.related = related);
        else kind = "other";
      } else if (options?.kind === "classConst" && options.name === "class") (kind = "enum"), (field.enum = options.class);
      else {
        const first = mapValue(options)?.entries[0]?.[0];
        if (first === undefined) kind = "other";
        else field.option = /^(0|-?[1-9]\d*)$/.test(first) ? Number(first) : first;
      }
    }
    out.push({ ...field, kind });
  });
  return out;
}

/** The names of a table's columns that show by default. */
export function readColumns(root: Root): string[] {
  const slot = root.slots.get("columns");
  return (slot?.entries ?? [])
    .map((e) => e.comp)
    .filter((c): c is Comp => !!c?.name && !c.calls.some((k) => CONDITIONAL.test(k.name) || (k.name === "toggleable" && k.args.items.some((a) => a.name === "isToggledHiddenByDefault" && a.value.kind === "bool" && a.value.value))))
    .map((c) => c.name!);
}

/** Whether a table has an edit action for its records. */
export const hasEditAction = (root: Root) => [...root.slots.values()].some((s) => s.entries.some((e) => e.comp && /EditAction$/.test(e.comp.cls)));

/** The attributes a factory's `definition()` fills, or null when it isn't one array. */
export function factoryKeys(cls: OClass): string[] | null {
  const ret = cls.methods.find((m) => m.name === "definition")?.returns[0];
  if (ret?.kind !== "array") return null;
  const keys = ret.items.map((i) => (i.key?.kind === "string" ? i.key.value : null));
  return keys.every((k) => k !== null) ? (keys as string[]) : null;
}

// ---- Writing the tests ----

const vowel = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");
/** Kinds whose saved value matches what the test filled, so the database and the form can be checked for them. */
const COMPARABLE = new Set<FieldKind>(["text", "email", "url", "number", "textarea", "bool", "options", "relation", "enum"]);

/** A value for a field the factory doesn't fill, from its type; null when Tusk can't make one. */
function fallback(f: TestField): string | null {
  switch (f.kind) {
    case "text":
      return f.unique ? "fake()->unique()->words(3, true)" : "fake()->words(3, true)";
    case "email":
      return "fake()->unique()->safeEmail()";
    case "url":
      return "fake()->url()";
    case "number":
      return "fake()->numberBetween(1, 100)";
    case "textarea":
    case "rich":
      return "fake()->paragraph()";
    case "bool":
      return "true";
    case "date":
      return "now()->toDateString()";
    case "datetime":
      return "now()->toDateTimeString()";
    case "options":
      return phpValue(f.option ?? null);
    case "relation":
      return `{{${f.related}}}::factory()->create()->getKey()`;
    case "enum":
      return `{{${f.enum}}}::cases()[0]->value`;
    default:
      return null;
  }
}

/** The models whose factories the tests use: the resource's, the user's, and related models' for fields the factory doesn't fill. */
export function factoriesNeeded(s: Pick<TestSpec, "model" | "user" | "fields" | "factoryKeys">): string[] {
  const filled = (f: TestField) => !s.factoryKeys || s.factoryKeys.includes(f.name);
  return [...new Set([s.model, s.user, ...s.fields.filter((f) => f.kind === "relation" && !filled(f)).map((f) => f.related!)])];
}

const list = (names: string[]) => `[${names.map(phpString).join(", ")}]`;

/** The tests for a resource, setup first. Classes are written `{{Fqn}}`. */
export function testBlocks(s: TestSpec): TestBlock[] {
  const M = `{{${s.model}}}`;
  const live = (page: string) => `{{Livewire\\Livewire}}::test({{${page}}}::class)`;
  const rules = s.policy?.rules ?? {};
  const filled = (f: TestField) => !s.factoryKeys || s.factoryKeys.includes(f.name);
  const usable = s.fields.filter((f) => f.kind !== "other" && (filled(f) || fallback(f) !== null));
  const fromFactory = usable.filter(filled).map((f) => f.name);
  const extra = usable.filter((f) => !filled(f));
  const comparable = usable.filter((f) => COMPARABLE.has(f.kind)).map((f) => f.name);
  const unfillable = s.fields.filter((f) => f.required && !usable.includes(f));

  // The data a create or edit fills: the factory's values for the form's fields, and type-made ones for the rest.
  const factoryData = `{{Illuminate\\Support\\Arr}}::only(${M}::factory()->make()->getAttributes(), ${list(fromFactory)})`;
  const data =
    !extra.length
      ? `$data = ${fromFactory.length ? factoryData : "[]"};`
      : `$data = [\n${fromFactory.length ? `    ...${factoryData},\n` : ""}${extra.map((f) => `    ${phpString(f.name)} => ${fallback(f)},`).join("\n")}\n];`;
  const missing = unfillable.length ? `// Fill ${unfillable.map((f) => f.name).join(", ")} too: Tusk can't make a value for ${unfillable.length > 1 ? "these fields" : "this field"}.\n` : "";
  const saved = (key: string | null) => {
    const entries = comparable.filter((n) => fromFactory.includes(n) || extra.some((f) => f.name === n));
    if (!entries.length && !key) return "";
    const only = entries.length === usable.length ? "$data" : `{{Illuminate\\Support\\Arr}}::only($data, ${list(entries)})`;
    return `\n\n$this->assertDatabaseHas(${M}::class, ${key ? `[${phpString(s.keyName)} => $record->getKey(), ...${only}]` : only});`;
  };

  // Who the tests act as: a user with what the policy's readable rules ask for.
  const setup: string[] = [`$this->user = {{${s.user}}}::factory()->create();`];
  const granted = new Set<string>();
  let owner: string | null = null;
  const blocked = new Set<TestAbility>();
  for (const [ability, rule] of Object.entries(rules) as [TestAbility, Rule | null][]) {
    if (!rule) continue;
    if (rule.kind === "nobody") blocked.add(ability);
    if (rule.kind === "custom") setup.push(`// The policy's ${ability}() is code Tusk can't read: give the user what it checks.`);
    if (rule.kind !== "when") continue;
    const conds = rule.join === "all" ? rule.conds : [rule.conds.find((c) => c.kind !== "owner") ?? rule.conds[0]];
    for (const c of conds) {
      if (c.kind === "owner") owner = c.column;
      const line =
        c.kind === "owner"
          ? null
          : !s.policy?.spatie
            ? `// The policy's ${ability}() asks for the ${phpString(c.name)} ${c.kind}: give it to the user.`
            : c.kind === "permission"
              ? `$this->user->givePermissionTo({{Spatie\\Permission\\Models\\Permission}}::findOrCreate(${phpString(c.name)}));`
              : `$this->user->assignRole({{Spatie\\Permission\\Models\\Role}}::findOrCreate(${phpString(c.name)}));`;
      if (line && !granted.has(line)) granted.add(line), setup.push(line);
    }
  }
  setup.push("", "$this->actingAs($this->user);");
  if (s.panel) setup.push(`{{Filament\\Facades\\Filament}}::setCurrentPanel(${phpString(s.panel)});`);
  const record = `$record = ${M}::factory()->create(${owner ? `[${phpString(owner)} => $this->user->getKey()]` : ""});`;

  const blocks: TestBlock[] = [];
  const test = (name: string, body: string) => blocks.push({ key: name, marker: s.style === "pest" ? `'${name}'` : `function ${method(name)}(`, code: s.style === "pest" ? `it(${phpString(name)}, function () {\n${indentCode(`    ${body}`, "    ")}\n});` : `public function ${method(name)}(): void\n{\n${indentCode(`    ${body}`, "    ")}\n}` });
  if (s.style === "pest") {
    if (s.refreshDatabase) blocks.push({ key: "refresh", marker: "RefreshDatabase", code: "uses({{Illuminate\\Foundation\\Testing\\RefreshDatabase}}::class);" });
    blocks.push({ key: "setup", marker: "beforeEach(", code: `beforeEach(function () {\n${setup.map((l) => (l ? `    ${l}` : "")).join("\n")}\n});` });
  } else {
    blocks.push({ key: "setup", marker: "function setUp(", code: `protected {{${s.user}}} $user;\n\nprotected function setUp(): void\n{\n    parent::setUp();\n\n${setup.map((l) => (l ? `    ${l}` : "")).join("\n")}\n}` });
  }

  const listPage = s.pages.list ?? s.pages.manage;
  const L = s.label;
  if (listPage && !blocked.has("viewAny"))
    test(`lists ${s.plural}`, `$records = ${M}::factory()->count(3)->create();\n\n${live(listPage)}\n    ->assertOk()${s.columns.map((c) => `\n    ->assertCanRenderTableColumn(${phpString(c)})`).join("")}\n    ->assertCanSeeTableRecords($records);`);

  const required = s.fields.filter((f) => f.required);
  if (s.pages.create && !blocked.has("create")) {
    test(`creates ${vowel(L)} ${L}`, `${data}\n${missing}\n${live(s.pages.create)}\n    ->fillForm($data)\n    ->call('create')\n    ->assertHasNoFormErrors();${saved(null)}`);
    for (const f of required) test(`requires the ${f.name} field`, `${live(s.pages.create)}\n    ->fillForm([${phpString(f.name)} => null])\n    ->call('create')\n    ->assertHasFormErrors([${phpString(f.name)} => 'required']);`);
    for (const f of s.fields.filter((f) => f.unique && filled(f)))
      test(`keeps the ${f.name} field unique`, `$record = ${M}::factory()->create();\n\n${live(s.pages.create)}\n    ->fillForm([${phpString(f.name)} => $record->${f.name}])\n    ->call('create')\n    ->assertHasFormErrors([${phpString(f.name)} => 'unique']);`);
  } else if (s.pages.manage && !blocked.has("create")) {
    test(`creates ${vowel(L)} ${L}`, `${data}\n${missing}\n${live(s.pages.manage)}\n    ->callAction('create', $data)\n    ->assertHasNoActionErrors();${saved(null)}`);
    for (const f of required) test(`requires the ${f.name} field`, `${live(s.pages.manage)}\n    ->callAction('create', [${phpString(f.name)} => null])\n    ->assertHasActionErrors([${phpString(f.name)} => 'required']);`);
    for (const f of s.fields.filter((f) => f.unique && filled(f)))
      test(`keeps the ${f.name} field unique`, `$record = ${M}::factory()->create();\n\n${live(s.pages.manage)}\n    ->callAction('create', [${phpString(f.name)} => $record->${f.name}])\n    ->assertHasActionErrors([${phpString(f.name)} => 'unique']);`);
  }

  const state = comparable.filter((n) => fromFactory.includes(n));
  if (s.pages.edit && !blocked.has("update"))
    test(
      `edits ${vowel(L)} ${L}`,
      `${record}\n${data}\n${missing}\n{{Livewire\\Livewire}}::test({{${s.pages.edit}}}::class, ['record' => $record->getRouteKey()])${state.length ? `\n    ->assertSchemaStateSet({{Illuminate\\Support\\Arr}}::only($record->attributesToArray(), ${list(state)}))` : ""}\n    ->fillForm($data)\n    ->call('save')\n    ->assertHasNoFormErrors();${saved("record")}`,
    );
  else if (s.pages.manage && s.manageEdit && !blocked.has("update"))
    test(`edits ${vowel(L)} ${L}`, `${record}\n${data}\n${missing}\n${live(s.pages.manage)}\n    ->callAction({{Filament\\Actions\\Testing\\TestAction}}::make('edit')->table($record), $data)\n    ->assertHasNoActionErrors();${saved("record")}`);

  if (s.pages.view && !blocked.has("view")) test(`shows ${vowel(L)} ${L}`, `${record}\n\n{{Livewire\\Livewire}}::test({{${s.pages.view}}}::class, ['record' => $record->getRouteKey()])\n    ->assertOk();`);

  // Users the policy refuses: a user without the permissions, roles, or records the rules ask for.
  const refuses = (a: TestAbility) => rules[a]?.kind === "nobody" || rules[a]?.kind === "when";
  const stranger = `$this->actingAs({{${s.user}}}::factory()->create());\n\n`;
  const other = `$record = ${M}::factory()->create();\n`;
  if (listPage && refuses("viewAny")) test(`keeps the list from users the policy refuses`, `${stranger}${live(listPage)}\n    ->assertForbidden();`);
  if (s.pages.create && refuses("create")) test(`keeps creating from users the policy refuses`, `${stranger}${live(s.pages.create)}\n    ->assertForbidden();`);
  if (s.pages.edit && refuses("update")) test(`keeps editing from users the policy refuses`, `${other}${stranger}{{Livewire\\Livewire}}::test({{${s.pages.edit}}}::class, ['record' => $record->getRouteKey()])\n    ->assertForbidden();`);
  if (s.pages.view && refuses("view")) test(`keeps viewing from users the policy refuses`, `${other}${stranger}{{Livewire\\Livewire}}::test({{${s.pages.view}}}::class, ['record' => $record->getRouteKey()])\n    ->assertForbidden();`);
  return blocks;
}

/** A test's PHPUnit method name: "creates a post" is `test_creates_a_post`. */
const method = (name: string) => `test_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;

/** A whole test file. */
export function testFile(s: TestSpec): string {
  const blocks = testBlocks(s).map((b) => b.code);
  if (s.style === "pest") return phpFile("", blocks.join("\n\n"));
  const body = indentCode(`    ${blocks.join("\n\n")}`, "    ").replace(/\n +\n/g, "\n\n");
  return phpFile(s.namespace, `class ${s.className} extends {{Tests\\TestCase}}\n{\n    use {{Illuminate\\Foundation\\Testing\\RefreshDatabase}};\n\n${body}\n}`);
}

/** The tests an existing file lacks, by the text each one's name or setup leaves in it. */
export const missingBlocks = (s: TestSpec, text: string) => testBlocks(s).filter((b) => !text.includes(b.marker));

// ---- Factories ----

/**
 * The factory class Laravel looks for: `Database\Factories\` and the model's name under `App\Models\`, as
 * `Factory::resolveFactoryName()` does for an app in the `App` namespace.
 */
export const factoryClass = (model: string) => `Database\\Factories\\${model.startsWith("App\\Models\\") ? model.slice(11) : model}Factory`;

/** What `introspect.php model` says about a model, as far as a factory needs it. */
export type ModelFactsForFactory = {
  class: string;
  table: string;
  keyName: string;
  keyType: string;
  timestamps: boolean;
  softDeletes: boolean;
  columns: { name: string; type: string; fullType?: string; nullable: boolean; default?: string | null; autoIncrement?: boolean }[] | null;
  indexes: { columns: string[]; unique: boolean; primary: boolean }[];
  foreignKeys: { columns: string[]; foreignTable: string; onDelete: string | null }[];
  casts: Record<string, string>;
  relations: { name: string; type: string; related: string | null; foreignKey?: string }[];
};

/** A factory for an existing model, faking each column of its table as the model designer's factories do. */
export function factoryFor(m: ModelFactsForFactory, enums: string[]): string {
  const unique = new Set(m.indexes.filter((i) => i.unique && !i.primary && i.columns.length === 1).map((i) => i.columns[0]));
  const foreign = new Map(m.foreignKeys.filter((f) => f.columns.length === 1).map((f) => [f.columns[0], { table: f.foreignTable, onDelete: f.onDelete }]));
  const skip = new Set([m.keyName, "created_at", "updated_at", "deleted_at"]);
  const columns = (m.columns ?? [])
    .filter((c) => !skip.has(c.name))
    .map((c, i) => {
      const spec = columnFromDatabase(c, { id: String(i), unique: unique.has(c.name), index: false, foreign: foreign.get(c.name), cast: m.casts[c.name], fillable: true, hidden: false });
      const cast = m.casts[c.name]?.replace(/^\\/, "");
      return cast && enums.includes(cast) ? { ...spec, enum: cast } : spec;
    });
  const namespace = m.class.slice(0, m.class.lastIndexOf("\\"));
  const spec: ModelSpec = {
    name: shortClass(m.class),
    namespace,
    table: m.table,
    key: m.keyType === "string" ? "uuid" : "id",
    timestamps: m.timestamps,
    softDeletes: m.softDeletes,
    columns,
    relations: m.relations.filter((r) => r.related).map((r, i) => ({ id: String(i), type: (r.type.charAt(0).toLowerCase() + r.type.slice(1)) as RelationType, name: r.name, related: r.related!, foreignKey: r.foreignKey })),
  };
  const fqn = factoryClass(m.class);
  return factoryFile(spec).replace("namespace Database\\Factories;", `namespace ${fqn.slice(0, fqn.lastIndexOf("\\"))};`);
}

/** The models a new factory for `m` makes records of: the targets of its required foreign keys. */
export const factoryParents = (m: ModelFactsForFactory) =>
  m.relations.filter((r) => /^belongsTo$/i.test(r.type) && r.related && r.related !== m.class && m.columns?.some((c) => c.name === (r.foreignKey ?? foreignKeyFor(r.name)) && !c.nullable)).map((r) => r.related!);
