// The model designer: an editor tab for an Eloquent model and its table. For a new model it writes the model, the
// migration (with pivot tables for many-to-many relationships), and a factory that fakes each column. For an
// existing model it writes a migration with the changes to its table, and edits the model's fillable attributes,
// casts, and relationships in place. Changes are staged: the preview shows the code, and Apply writes it.
import { invoke } from "@tauri-apps/api/core";
import { h, icon, iconButton } from "./dom";
import { monaco } from "./editor";
import * as fapp from "./filamentapp";
import { host as designerHost } from "./filamentdesigner";
import { commitInput, segmented, toggleSwitch } from "./filamentpickers";
import { shortClass } from "./filamentschema";
import {
  alterMigration,
  alterName,
  castFor,
  COLUMN_TYPES,
  type ColumnSpec,
  columnFromDatabase,
  createMigration,
  diffColumns,
  factoryFile,
  foreignKeyFor,
  mergeList,
  migrationFileName,
  modelFile,
  type ModelSpec,
  type OnDelete,
  pivotMigration,
  pivotTable,
  relationMethod,
  type RelationSpec,
  type RelationType,
  snake,
  studly,
  tableFor,
  camel,
  plural,
} from "./modelgen";
import { addMember, droppedImports, Imports, type Edit, insertItem, mergeEdits, methodNamed, nodeValue, type OClass, phpString, phpValue, propertyNamed, replaceNode, setProperty } from "./phpcode";
import { confirm } from "./palette";
import { errorText, showError } from "./status";
import { closeView, showEditorView } from "./terminal";
import { sampleButton } from "./sampledata";
import { historyCard, historyChanges, historyModelEdits, type HistoryState, loadHistory } from "./historyview";

let ids = 0;
const newId = () => `c${++ids}`;

type State = {
  existing: fapp.ModelDetails | null;
  /** The model's file, for an existing model. */
  file: string | null;
  spec: ModelSpec;
  /** The columns as the table has them, for the diff. */
  before: ColumnSpec[];
  softDeletesBefore: boolean;
  factory: boolean;
  seeder: boolean;
  policy: boolean;
  resource: boolean;
  migrate: boolean;
  /** Relationships to add to the related model too, by the relation's id. */
  inverse: Set<string>;
};

const open = new Map<string, ModelDesigner>();

/** Opens the designer for an existing model's file. */
export async function openModelDesigner(file: string, section?: "history") {
  let d = open.get(file);
  if (!d) open.set(file, (d = new ModelDesigner(file)));
  d.section = section;
  d.show();
  if (section && d.state) d.reveal();
}

/** Opens the designer for a new model; `then` runs with its class once it's created, as the resource wizard does. */
export function openNewModel(o: { name?: string; then?: (cls: string) => void } = {}) {
  const d = new ModelDesigner(null, o.name, o.then);
  d.show();
}

const RELATION_TYPES: [RelationType, string][] = [
  ["belongsTo", "Belongs to"],
  ["hasMany", "Has many"],
  ["hasOne", "Has one"],
  ["belongsToMany", "Belongs to many"],
  ["morphMany", "Morph many"],
  ["morphTo", "Morph to"],
  ["morphToMany", "Morph to many"],
];

/** Columns people add often, as one click. */
const PRESETS: { label: string; column: Partial<ColumnSpec> & { name: string; type: string } }[] = [
  { label: "Name", column: { name: "name", type: "string" } },
  { label: "Title", column: { name: "title", type: "string" } },
  { label: "Slug", column: { name: "slug", type: "string", unique: true } },
  { label: "Email", column: { name: "email", type: "string", unique: true } },
  { label: "Description", column: { name: "description", type: "text", nullable: true } },
  { label: "Content", column: { name: "content", type: "longText", nullable: true } },
  { label: "Price", column: { name: "price", type: "decimal", precision: 10, scale: 2, default: "0" } },
  { label: "Quantity", column: { name: "quantity", type: "unsignedInteger", default: "0" } },
  { label: "Active flag", column: { name: "is_active", type: "boolean", default: "true" } },
  { label: "Published at", column: { name: "published_at", type: "timestamp", nullable: true } },
  { label: "Image", column: { name: "image", type: "string", nullable: true } },
  { label: "Sort order", column: { name: "sort", type: "unsignedInteger", default: "0" } },
];

class ModelDesigner {
  file: string | null;
  el = h("div", { class: "md-designer" });
  state: State | null = null;
  error = "";
  models: string[] = [];
  enums: fapp.EnumInfo[] = [];
  tables = new Map<string, string>();
  summaries: Record<string, fapp.ModelSummary> = {};
  preview: monaco.editor.IStandaloneCodeEditor | null = null;
  previewTab: "migration" | "model" | "factory" = "migration";
  busy = "";
  then?: (cls: string) => void;
  /** The model's activity log settings, staged like the rest; null for a new model. */
  history: HistoryState | null = null;
  /** A section to scroll to once the designer shows, such as History from the palette. */
  section?: "history";
  private initialName: string;

  constructor(file: string | null, name = "", then?: (cls: string) => void) {
    this.file = file;
    this.initialName = name;
    this.then = then;
  }

  get root() {
    return designerHost.root();
  }

  show() {
    const title = this.file ? `${this.file.split("/").pop()!.replace(/\.php$/, "")} · Model` : "New Model";
    showEditorView(title, this.el, "database", () => {
      this.preview?.dispose();
      this.preview = null;
      if (this.file) open.delete(this.file);
    });
    if (!this.state) void this.load();
  }

  async load() {
    this.el.replaceChildren(h("div", { class: "fd-loading" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), "Reading the model…"));
    try {
      const [models, enums, migrations] = await Promise.all([fapp.models(this.root).catch(() => ({}) as Record<string, fapp.ModelSummary>), fapp.enums(this.root).catch(() => []), fapp.migrations(this.root).catch(() => null)]);
      this.models = Object.keys(models).sort();
      this.summaries = models;
      for (const [cls, m] of Object.entries(models)) this.tables.set(cls, m.table);
      this.enums = enums;
      const database = !!migrations?.database;
      if (!this.file) {
        const name = this.initialName || "";
        this.state = {
          existing: null,
          file: null,
          spec: { name, namespace: "App\\Models", table: name ? tableFor(name) : "", key: projectKey(models), timestamps: true, softDeletes: false, columns: [], relations: [] },
          before: [],
          softDeletesBefore: false,
          factory: true,
          seeder: false,
          policy: false,
          resource: false,
          migrate: database,
          inverse: new Set(),
        };
      } else {
        const text = await invoke<string>("read_file", { path: this.file });
        const outline = await fapp.outlineOf(text, this.file);
        const cls = outline.classes.find((c) => c.name);
        if (!cls) throw new Error("There's no class in this file.");
        fapp.forget([`model:${cls.fqn}`]);
        const history = loadHistory(this.root, text, cls);
        const details = await fapp.model(this.root, cls.fqn);
        this.history = await history;
        const unique = new Set(details.indexes.filter((i) => i.unique && !i.primary && i.columns.length === 1).map((i) => i.columns[0]));
        const indexed = new Set(details.indexes.filter((i) => !i.unique && i.columns.length === 1).map((i) => i.columns[0]));
        const foreign = new Map(details.foreignKeys.filter((f) => f.columns.length === 1).map((f) => [f.columns[0], { table: f.foreignTable, onDelete: f.onDelete }]));
        const skip = new Set([details.keyName, "created_at", "updated_at", "deleted_at"]);
        const before = (details.columns ?? [])
          .filter((c) => !skip.has(c.name))
          .map((c) => columnFromDatabase(c, { id: newId(), unique: unique.has(c.name), index: indexed.has(c.name), foreign: foreign.get(c.name), cast: details.casts[c.name], fillable: details.fillable.includes(c.name), hidden: details.hidden.includes(c.name) }));
        // An enum cast makes the column an enum column.
        for (const c of before) {
          const cast = details.casts[c.name]?.replace(/^\\/, "");
          if (cast && enums.some((e) => e.class === cast)) c.enum = cast;
        }
        this.state = {
          existing: details,
          file: this.file,
          spec: {
            name: cls.name,
            namespace: outline.namespace ?? "App\\Models",
            table: details.table,
            key: details.keyType === "string" ? "uuid" : "id",
            timestamps: details.timestamps,
            softDeletes: details.softDeletes,
            columns: before.map((c) => ({ ...c, original: c })),
            relations: details.relations.map((r) => ({ id: newId(), type: (r.type.charAt(0).toLowerCase() + r.type.slice(1)) as RelationType, name: r.name, related: r.related ?? "", existing: true })),
          },
          before,
          softDeletesBefore: details.softDeletes,
          factory: false,
          seeder: false,
          policy: false,
          resource: false,
          migrate: database,
          inverse: new Set(),
        };
      }
      this.error = "";
    } catch (e) {
      this.error = errorText(e);
    }
    this.render();
  }

  // ---- Rendering ----

  render() {
    if (this.error) {
      this.el.replaceChildren(h("div", { class: "fd-error" }, icon("warning"), h("div", {}, h("strong", {}, "The model designer can't read this model"), h("p", {}, this.error), h("div", { class: "fd-error-actions" }, h("button", { type: "button", onclick: () => void this.load() }, icon("refresh"), "Try again")))));
      return;
    }
    const s = this.state!;
    const main = h("div", { class: "md-main" }, this.modelCard(), this.columnsCard(), this.relationsCard(), s.existing ? null : this.alsoCard(), s.existing && this.history ? this.historyCard() : null);
    const preview = this.previewPane();
    this.el.replaceChildren(this.header(), h("div", { class: "md-body" }, main, preview), this.footer());
    this.updatePreview();
    if (this.section) this.reveal();
  }

  /** Scrolls to the section the designer was opened for. */
  reveal() {
    // Once the tab shows; not in an animation frame, which waits while the window is hidden.
    setTimeout(() => this.el.querySelector(".rh-section")?.scrollIntoView({ block: "start" }));
    this.section = undefined;
  }

  private historyCard() {
    const ex = this.state!.existing!;
    return historyCard({
      state: this.history!,
      file: this.file!,
      columns: (ex.columns ?? []).map((c) => c.name).filter((c) => c !== ex.keyName),
      fillable: ex.fillable,
      hidden: ex.hidden,
      keyName: ex.keyName,
      changed: () => this.updatePreview(),
      render: () => this.render(),
      reload: () => (fapp.forget(["models", "model:", "app"]), void this.load()),
    });
  }

  private header() {
    const s = this.state!;
    const existing = s.existing;
    return h(
      "header",
      { class: "fd-header" },
      h("span", { class: "fd-header-icon" }, icon("database")),
      h(
        "div",
        { class: "fd-header-titles" },
        h("h1", {}, existing ? s.spec.name : s.spec.name ? `New model: ${s.spec.name}` : "New model"),
        h(
          "div",
          { class: "fd-header-chips" },
          h("span", { class: "fd-chip-static" }, icon("table"), s.spec.table || "table"),
          existing?.tableExists === false ? h("span", { class: "fd-chip-warn", title: "Run the migrations to create it." }, icon("warning"), "The table doesn't exist yet") : null,
          existing && existing.columns === null ? h("span", { class: "fd-chip-warn", title: "The database can't be reached, so columns come from the model." }, icon("warning"), "Database not reachable") : null,
          this.file ? h("button", { type: "button", class: "fd-chip-link", onclick: () => designerHost.openAt(this.file!, 1) }, icon("go-to-file"), "Open the code") : null,
          existing ? h("button", { type: "button", class: "fd-chip-link", title: "Who can see, create, edit, and delete these records", onclick: () => void import("./accessview").then((m) => m.openAccess(existing.class)) }, icon("shield"), "Access") : null,
          existing?.factory && existing.tableExists !== false ? sampleButton(existing.class) : null,
        ),
      ),
      h("span", { class: "fd-spacer" }),
    );
  }

  private modelCard() {
    const s = this.state!;
    const spec = s.spec;
    const rows: HTMLElement[] = [];
    if (!s.existing) {
      const name = commitInput(spec.name, (v) => {
        const autoTable = !spec.table || spec.table === tableFor(spec.name);
        spec.name = studly(v.trim().replace(/[^\w]/g, ""));
        if (autoTable) spec.table = spec.name ? tableFor(spec.name) : "";
        this.render();
      }, { placeholder: "Post", className: "fd-mono" });
      name.addEventListener("input", () => (spec.name = studly((name as HTMLInputElement).value.trim())));
      rows.push(this.row("Name", name, "A singular class name, such as Post or OrderItem."));
      rows.push(this.row("Table", commitInput(spec.table, (v) => ((spec.table = snake(v.trim())), this.render()), { placeholder: spec.name ? tableFor(spec.name) : "posts", className: "fd-mono" })));
      rows.push(this.row("Primary key", segmented<ModelSpec["key"]>([["id", "Auto-increment"], ["uuid", "UUID"], ["ulid", "ULID"]], spec.key, (v) => ((spec.key = v), this.render()))));
    }
    rows.push(this.row("Timestamps", toggleSwitch(spec.timestamps, (on) => ((spec.timestamps = on), this.updatePreview())), "created_at and updated_at, kept by Eloquent."));
    rows.push(this.row("Soft deletes", toggleSwitch(spec.softDeletes, (on) => ((spec.softDeletes = on), this.render())), "Deleting sets deleted_at instead of removing the row."));
    return h("section", { class: "fd-settings-section" }, h("h3", {}, icon("symbol-class"), "Model"), h("div", { class: "fd-rows md-rows" }, ...rows));
  }

  private row(label: string, editor: HTMLElement, help?: string) {
    return h("div", { class: "fd-row", title: help ?? "" }, h("span", { class: "fd-row-label" }, label), h("div", { class: "fd-row-editor" }, editor), h("span", { class: "fd-row-spacer" }));
  }

  private columnsCard() {
    const s = this.state!;
    const cols = s.spec.columns;
    const table = h("div", { class: "md-columns" });
    table.append(h("div", { class: "md-col-head" }, h("span", {}), h("span", {}, "Name"), h("span", {}, "Type"), h("span", { title: "Nullable" }, "Null"), h("span", {}, "Default"), h("span", {}, "Index"), h("span", { title: "Fillable: saved from forms with create() and update()" }, "Fill"), h("span", {}, "Cast"), h("span", {})));
    const keyRow = (label: string, type: string) => h("div", { class: "md-col-row fixed" }, h("span", {}), h("span", { class: "fd-mono" }, label), h("span", { class: "md-muted" }, type), h("span", {}), h("span", {}), h("span", { class: "md-muted" }, label === "id" ? "primary" : ""), h("span", {}), h("span", {}), h("span", {}));
    table.append(keyRow("id", s.spec.key === "id" ? "id" : s.spec.key));
    cols.forEach((c, i) => table.append(this.columnRow(c, i)));
    if (s.spec.timestamps) table.append(keyRow("created_at, updated_at", "timestamps"));
    if (s.spec.softDeletes) table.append(keyRow("deleted_at", "softDeletes"));
    const presets = h("div", { class: "md-presets" }, h("span", { class: "fd-note" }, "Quick add:"), ...PRESETS.filter((p) => !cols.some((c) => c.name === p.column.name)).map((p) => h("button", { type: "button", class: "fd-chip-link", onclick: () => this.addColumn(p.column) }, p.label)));
    return h(
      "section",
      { class: "fd-settings-section" },
      h("h3", {}, icon("table"), "Columns", h("span", { class: "fd-spacer" }), h("button", { type: "button", class: "md-add", onclick: () => this.addColumn({ name: "", type: "string" }) }, icon("add"), "Add column")),
      table,
      presets,
    );
  }

  addColumn(c: Partial<ColumnSpec> & { name: string; type: string }) {
    const s = this.state!;
    s.spec.columns.push({ id: newId(), nullable: false, fillable: true, ...c });
    this.render();
    const inputs = this.el.querySelectorAll<HTMLInputElement>(".md-col-row:not(.fixed) .md-col-name");
    const last = inputs[inputs.length - 1];
    if (last && !c.name) last.focus();
  }

  private columnRow(c: ColumnSpec, i: number) {
    const s = this.state!;
    const cols = s.spec.columns;
    const typeInfo = COLUMN_TYPES.find((t) => t.type === c.type);
    const changed = () => this.updatePreview();
    const name = h("input", { class: "md-col-name fd-mono", value: c.name, placeholder: "column_name", spellcheck: false });
    name.oninput = () => ((c.name = snake(name.value.trim()).replace(/[^\w]/g, "")), changed());
    name.onchange = () => ((name.value = c.name), this.render());
    name.onkeydown = (e) => {
      if (e.key === "Enter") (e.preventDefault(), this.addColumn({ name: "", type: "string" }));
    };
    const type = h("select", { class: "md-col-type" });
    for (const group of [...new Set(COLUMN_TYPES.map((t) => t.group))]) type.append(h("optgroup", { label: group }, ...COLUMN_TYPES.filter((t) => t.group === group).map((t) => h("option", { value: t.type, textContent: t.label, selected: t.type === c.type }))));
    type.onchange = () => {
      c.type = type.value;
      if (c.type.startsWith("foreign") && !c.references) c.references = this.guessTable(c.name);
      if (c.type.startsWith("foreign") && !c.onDelete) c.onDelete = "cascade";
      this.render();
    };
    const extra = h("div", { class: "md-col-extra" });
    if (typeInfo?.length) extra.append(commitInput(c.length ? String(c.length) : "", (v) => ((c.length = Number(v) || undefined), changed()), { placeholder: "255", className: "md-tiny", type: "number" }));
    if (typeInfo?.precision)
      extra.append(
        commitInput(String(c.precision ?? 10), (v) => ((c.precision = Number(v) || 10), changed()), { className: "md-tiny", type: "number" }),
        commitInput(String(c.scale ?? 2), (v) => ((c.scale = Number(v) || 0), changed()), { className: "md-tiny", type: "number" }),
      );
    if (c.type.startsWith("foreign")) {
      const tables = [...new Set([...this.tables.values(), c.references ?? ""].filter(Boolean))].sort();
      const ref = h("select", { class: "md-ref", title: "The table it points to" }, ...tables.map((t) => h("option", { value: t, textContent: `→ ${t}`, selected: t === c.references })));
      ref.onchange = () => ((c.references = ref.value), changed());
      const del = h("select", { class: "md-ref", title: "When the other row is deleted" }, ...([["cascade", "Delete too"], ["set null", "Set null"], ["restrict", "Prevent"], ["none", "Nothing"]] as [OnDelete, string][]).map(([v, l]) => h("option", { value: v, textContent: l, selected: v === (c.onDelete ?? "cascade") })));
      del.onchange = () => ((c.onDelete = del.value as OnDelete), changed());
      extra.append(ref, del);
    }
    const nullable = h("input", { type: "checkbox", checked: c.nullable });
    nullable.onchange = () => ((c.nullable = nullable.checked), changed());
    const def = commitInput(c.default ?? "", (v) => ((c.default = v.trim() ? normalizeDefault(v.trim(), c.type) : undefined), this.render()), { placeholder: "none", className: "md-default fd-mono" });
    const index = h("select", { class: "md-index" }, h("option", { value: "", textContent: "—" }), h("option", { value: "index", textContent: "Index", selected: !!c.index }), h("option", { value: "unique", textContent: "Unique", selected: !!c.unique }));
    index.onchange = () => ((c.index = index.value === "index"), (c.unique = index.value === "unique"), changed());
    const fillable = h("input", { type: "checkbox", checked: c.fillable });
    fillable.onchange = () => ((c.fillable = fillable.checked), changed());
    // The cast: automatic from the type, or an enum.
    const cast = h("select", { class: "md-cast", title: "How Eloquent reads and writes the value" }, h("option", { value: "", textContent: castFor({ ...c, enum: undefined, cast: undefined })?.replace(/'/g, "") ?? "—" }), ...this.enums.map((e) => h("option", { value: e.class, textContent: `${shortClass(e.class)} enum`, selected: e.class === c.enum })));
    cast.append(h("option", { value: "new", textContent: "New enum…" }));
    cast.onchange = () => {
      if (cast.value !== "new") return (c.enum = cast.value || undefined), changed();
      cast.value = c.enum ?? "";
      void import("./enumdesigner").then((m) =>
        m.openNewEnum({
          // Named for the model and column, as OrderStatus for an order's status.
          name: `${s.spec.name}${studly(c.name)}`,
          then: async (cls) => {
            this.enums = await fapp.enums(this.root).catch(() => this.enums);
            c.enum = cls;
            this.render();
          },
        }),
      );
    };
    const removed = () => {
      cols.splice(i, 1);
      this.render();
    };
    const row = h(
      "div",
      { class: `md-col-row${c.original ? "" : " new"}${c.original && c.original.name !== c.name ? " renamed" : ""}`, draggable: true, title: c.original ? (c.original.name !== c.name ? `Renamed from ${c.original.name}` : "") : "New column" },
      h("span", { class: "md-grip codicon codicon-gripper" }),
      h("div", { class: "md-col-namecell" }, name),
      h("div", { class: "md-col-typecell" }, type, extra),
      h("span", { class: "md-center" }, nullable),
      def,
      index,
      h("span", { class: "md-center" }, fillable),
      cast,
      iconButton("trash", c.original ? "Drop the column" : "Remove", removed),
    );
    row.ondragstart = (e) => (e.dataTransfer!.setData("text/plain", String(i)), row.classList.add("fd-dragging"));
    row.ondragend = () => row.classList.remove("fd-dragging");
    row.ondragover = (e) => e.preventDefault();
    row.ondrop = (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer!.getData("text/plain"));
      if (Number.isNaN(from) || from === i) return;
      const [moved] = cols.splice(from, 1);
      cols.splice(i, 0, moved);
      this.render();
    };
    return row;
  }

  /** The foreign key type for a model's key: foreignUuid for UUIDs, foreignUlid for ULIDs, foreignId otherwise. */
  private foreignType(model: string): string {
    const m = this.summaries[model];
    return m?.ulid ? "foreignUlid" : m?.keyType === "string" ? "foreignUuid" : "foreignId";
  }

  /** The table a foreign key column points to: `author_id` → `authors`, or a model's table named like it. */
  private guessTable(column: string) {
    const base = column.replace(/_id$/, "");
    const model = this.models.find((m) => snake(shortClass(m)) === base);
    return (model && this.tables.get(model)) || tableFor(studly(base));
  }

  private relationsCard() {
    const s = this.state!;
    const rels = s.spec.relations;
    const list = h("div", { class: "md-relations" });
    for (const r of rels) list.append(this.relationRow(r));
    if (!rels.length) list.append(h("p", { class: "fd-note" }, "No relationships yet. A belongs-to relationship adds its foreign key column."));
    return h("section", { class: "fd-settings-section" }, h("h3", {}, icon("references"), "Relationships", h("span", { class: "fd-spacer" }), h("button", { type: "button", class: "md-add", onclick: () => this.addRelation() }, icon("add"), "Add relationship")), list);
  }

  addRelation() {
    const s = this.state!;
    const related = this.models.find((m) => m !== `${s.spec.namespace}\\${s.spec.name}`) ?? "App\\Models\\User";
    const r: RelationSpec = { id: newId(), type: "belongsTo", name: camel(shortClass(related)), related };
    s.spec.relations.push(r);
    this.syncForeignKey(r);
    this.render();
  }

  /** A belongs-to relationship needs its foreign key column; adds it when the model doesn't have it. */
  private syncForeignKey(r: RelationSpec) {
    const s = this.state!;
    if (r.type !== "belongsTo") return;
    const key = r.foreignKey || foreignKeyFor(r.name);
    if (s.spec.columns.some((c) => c.name === key)) return;
    s.spec.columns.push({ id: newId(), name: key, type: this.foreignType(r.related), nullable: false, fillable: true, references: this.tables.get(r.related) ?? tableFor(shortClass(r.related)), onDelete: "cascade" });
  }

  private relationRow(r: RelationSpec) {
    const s = this.state!;
    if (r.existing)
      return h("div", { class: "md-rel-row existing" }, icon("references"), h("span", { class: "fd-mono" }, `${r.name}()`), h("span", { class: "md-muted" }, `${RELATION_TYPES.find(([t]) => t === r.type)?.[1] ?? r.type} ${shortClass(r.related)}`), h("span", { class: "fd-spacer" }), h("span", { class: "fd-note" }, "In the model"));
    const type = h("select", {}, ...RELATION_TYPES.map(([t, l]) => h("option", { value: t, textContent: l, selected: t === r.type })));
    type.onchange = () => {
      r.type = type.value as RelationType;
      const base = shortClass(r.related);
      r.name = /Many$/.test(r.type) ? camel(plural(base)) : camel(base);
      this.syncForeignKey(r);
      this.render();
    };
    const related = h("select", {}, ...[...new Set([...this.models, r.related])].map((m) => h("option", { value: m, textContent: shortClass(m), selected: m === r.related })));
    related.onchange = () => {
      const oldKey = r.foreignKey || foreignKeyFor(r.name);
      r.related = related.value;
      const base = shortClass(r.related);
      r.name = /Many$/.test(r.type) ? camel(plural(base)) : camel(base);
      // The foreign key this relationship added follows it.
      const col = s.spec.columns.find((c) => c.name === oldKey && !c.original);
      if (col && r.type === "belongsTo") (col.name = foreignKeyFor(r.name)), (col.references = this.tables.get(r.related) ?? tableFor(base)), (col.type = this.foreignType(r.related));
      else this.syncForeignKey(r);
      this.render();
    };
    const name = commitInput(r.name, (v) => ((r.name = camel(v.trim())), this.render()), { className: "fd-mono" });
    const inverse = h("input", { type: "checkbox", checked: s.inverse.has(r.id) });
    inverse.onchange = () => (inverse.checked ? s.inverse.add(r.id) : s.inverse.delete(r.id), this.updatePreview());
    const inverseLabel = r.type === "belongsTo" ? `Add ${camel(plural(s.spec.name || "record"))}() to ${shortClass(r.related)}` : r.type === "hasMany" || r.type === "hasOne" ? `Add ${camel(s.spec.name || "record")}() to ${shortClass(r.related)}` : r.type === "belongsToMany" ? `Add ${camel(plural(s.spec.name || "record"))}() to ${shortClass(r.related)}` : "";
    return h(
      "div",
      { class: "md-rel-row" },
      type,
      related,
      name,
      inverseLabel ? h("label", { class: "fd-check-label", title: "Also add the other side of the relationship to the related model" }, inverse, inverseLabel) : h("span"),
      r.type === "belongsToMany" ? h("span", { class: "fd-note" }, `Pivot table ${pivotTable(s.spec.name || "record", shortClass(r.related))}`) : null,
      iconButton("trash", "Remove", () => {
        s.spec.relations.splice(s.spec.relations.indexOf(r), 1);
        this.render();
      }),
    );
  }

  private alsoCard() {
    const s = this.state!;
    const box = (label: string, key: "factory" | "seeder" | "policy" | "resource", help: string) => {
      const b = h("input", { type: "checkbox", checked: s[key] });
      b.onchange = () => ((s[key] = b.checked), this.updatePreview());
      return h("label", { class: "fd-check-label md-also", title: help }, b, label);
    };
    return h(
      "section",
      { class: "fd-settings-section" },
      h("h3", {}, icon("files"), "Also create"),
      h("div", { class: "md-also-row" }, box("Factory", "factory", "Fakes records for tests and seeders."), box("Seeder", "seeder", "Fills the table with records."), box("Policy", "policy", "Decides who can view, create, update, and delete."), box("Filament resource", "resource", "Opens the resource wizard for the model next.")),
    );
  }

  private previewHost = h("div", { class: "md-preview-editor" });

  private previewPane() {
    const host = this.previewHost;
    const tabs: ["migration" | "model" | "factory", string][] = [
      ["migration", this.state!.existing ? "Migration" : "Migration"],
      ["model", "Model"],
      ...(this.state!.existing ? [] : ([["factory", "Factory"]] as ["factory", string][])),
    ];
    const bar = h("nav", { class: "fd-tabs-nav md-preview-tabs" }, ...tabs.map(([t, l]) => h("button", { type: "button", class: t === this.previewTab ? "active" : "", onclick: () => ((this.previewTab = t), this.render()) }, l)));
    requestAnimationFrame(() => this.mountPreview(host));
    return h("aside", { class: "md-preview" }, bar, host);
  }

  private mountPreview(host: HTMLElement) {
    if (!host.isConnected) return;
    this.preview ??= monaco.editor.create(host, { language: "php", readOnly: true, minimap: { enabled: false }, lineNumbers: "off", scrollBeyondLastLine: false, fontSize: 12, automaticLayout: true, renderLineHighlight: "none", folding: false, wordWrap: "off", padding: { top: 10 } });
    this.updatePreview();
  }

  /** The code Apply writes, for the preview. */
  private previewCode(): string {
    const s = this.state!;
    const spec = this.cleanSpec();
    if (this.previewTab === "model") {
      if (!s.existing) return modelFile(spec, { factory: s.factory });
      const lines = this.modelChanges().map((c) => `// ${c}`);
      return lines.length ? `<?php\n\n// Changes to ${s.spec.name}:\n${lines.join("\n")}\n` : "<?php\n\n// No changes to the model.\n";
    }
    if (this.previewTab === "factory") return factoryFile(spec);
    if (!s.existing) return createMigration(spec);
    const changes = diffColumns(spec.columns, s.before);
    const soft = s.spec.softDeletes !== s.softDeletesBefore ? (s.spec.softDeletes ? "add" : "drop") : undefined;
    return changes.length || soft ? alterMigration(spec.table, changes, { softDeletes: soft }) : "<?php\n\n// The table doesn't change.\n";
  }

  private updatePreview() {
    if (!this.state || !this.preview) return;
    const code = this.previewCode();
    if (this.preview.getValue() !== code) this.preview.setValue(code);
    const apply = this.el.querySelector<HTMLButtonElement>(".md-apply");
    const problems = this.problems();
    if (apply) {
      apply.disabled = !!problems.length || !!this.busy;
      apply.title = problems.join("\n");
    }
    const note = this.el.querySelector(".md-problems");
    if (note) note.textContent = problems[0] ?? "";
  }

  /** The spec without columns that have no name yet. */
  private cleanSpec(): ModelSpec {
    const spec = this.state!.spec;
    return { ...spec, columns: spec.columns.filter((c) => c.name) };
  }

  private problems(): string[] {
    const s = this.state!;
    const out: string[] = [];
    if (!s.existing && !/^[A-Z][A-Za-z\d]*$/.test(s.spec.name)) out.push("Give the model a class name, such as Post.");
    if (!s.existing && this.models.includes(`${s.spec.namespace}\\${s.spec.name}`)) out.push(`${s.spec.name} already exists.`);
    const names = s.spec.columns.map((c) => c.name).filter(Boolean);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) out.push(`Two columns are named ${dup}.`);
    if (names.some((n) => /^(id|created_at|updated_at|deleted_at)$/.test(n))) out.push("id and the timestamp columns are added for you.");
    if (!s.spec.table) out.push("The table needs a name.");
    return out;
  }

  /** What Apply changes in an existing model's class, in words. */
  private modelChanges(): string[] {
    const s = this.state!;
    const out: string[] = [];
    const ex = s.existing!;
    const fillable = s.spec.columns.filter((c) => c.fillable).map((c) => c.name);
    if (ex.guarded.length !== 0 || ex.fillable.length) {
      const added = fillable.filter((f) => !ex.fillable.includes(f));
      const removed = ex.fillable.filter((f) => !fillable.includes(f) && s.spec.columns.some((c) => c.original?.name === f || c.name === f));
      if (added.length) out.push(`Fillable: add ${added.join(", ")}`);
      if (removed.length) out.push(`Fillable: remove ${removed.join(", ")}`);
    }
    for (const c of s.spec.columns) {
      const cast = castFor(c);
      const old = ex.casts[c.original?.name ?? c.name];
      if (cast && !old) out.push(`Cast ${c.name} to ${cast.replace(/'/g, "")}`);
    }
    for (const r of s.spec.relations.filter((x) => !x.existing)) out.push(`Add ${r.name}(): ${r.type} ${shortClass(r.related)}`);
    if (s.spec.softDeletes && !s.softDeletesBefore) out.push("Use SoftDeletes");
    if (this.history) out.push(...historyChanges(this.history));
    return out;
  }

  private footer() {
    const s = this.state!;
    const migrate = h("input", { type: "checkbox", checked: s.migrate });
    migrate.onchange = () => (s.migrate = migrate.checked);
    const apply = h("button", { type: "button", class: "primary md-apply", onclick: () => void this.apply() }, icon(s.existing ? "check" : "add"), s.existing ? "Apply changes" : "Create model");
    return h(
      "footer",
      { class: "md-footer" },
      h("span", { class: "md-problems" }),
      h("span", { class: "fd-spacer" }),
      this.busy ? h("span", { class: "md-busy" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), this.busy) : null,
      h("label", { class: "fd-check-label", title: "Runs php artisan migrate after writing the migration" }, migrate, "Run the migration"),
      apply,
    );
  }

  // ---- Applying ----

  private setBusy(text: string) {
    this.busy = text;
    const b = this.el.querySelector(".md-footer");
    if (b) b.replaceWith(this.footer());
    this.updatePreview();
  }

  async apply() {
    const s = this.state!;
    if (this.problems().length) return;
    try {
      if (s.existing) await this.applyExisting();
      else await this.applyNew();
    } catch (e) {
      showError("Can't apply the model's changes", e);
    } finally {
      this.setBusy("");
    }
  }

  /** Writes a file the generator made or a new one, through the editor so local history keeps the change. */
  private async write(path: string, text: string) {
    await invoke("write_file", { path, contents: text }).catch(async () => {
      await invoke("create_file", { path, contents: text });
    });
  }

  private async applyNew() {
    const s = this.state!;
    const spec = this.cleanSpec();
    const root = this.root;
    this.setBusy("Creating the model…");
    const out = await fapp.artisan(root, ["make:model", spec.name, ...(s.factory ? ["--factory"] : []), ...(s.seeder ? ["--seed"] : []), ...(s.policy ? ["--policy"] : [])]);
    const files = await fapp.createdFiles(root, out);
    const modelPath = files.find((f) => f.endsWith(`/${spec.name}.php`)) ?? (await fapp.fileOfClass(root, `${spec.namespace}\\${spec.name}`));
    if (!modelPath) throw new Error(`make:model didn't say where it put ${spec.name}.`);
    const outline = await fapp.outlineOf(await invoke<string>("read_file", { path: modelPath }), modelPath);
    spec.namespace = outline.namespace ?? spec.namespace;
    await this.write(modelPath, modelFile(spec, { factory: s.factory }));
    const factory = files.find((f) => f.endsWith(`/${spec.name}Factory.php`));
    if (factory) await this.write(factory, factoryFile(spec));
    // The migration and any pivot tables, a second apart so they run in order.
    const now = Date.now();
    await this.write(`${root}/database/migrations/${migrationFileName(`create_${spec.table}_table`, new Date(now))}`, createMigration(spec));
    let n = 1;
    for (const r of spec.relations.filter((x) => x.type === "belongsToMany")) {
      const pivot = r.pivot || pivotTable(spec.name, shortClass(r.related));
      const other = this.tables.get(r.related) ?? tableFor(shortClass(r.related));
      await this.write(`${root}/database/migrations/${migrationFileName(`create_${pivot}_table`, new Date(now + 1000 * n++))}`, pivotMigration(pivot, { table: spec.table, key: `${snake(spec.name)}_id`, type: spec.key === "uuid" ? "foreignUuid" : spec.key === "ulid" ? "foreignUlid" : "foreignId" }, { table: other, key: `${snake(shortClass(r.related))}_id`, type: this.foreignType(r.related) }));
    }
    await this.addInverses(`${spec.namespace}\\${spec.name}`);
    if (s.migrate) await this.migrate();
    fapp.forget(["models", "model:", "migrations", "app"]);
    const cls = `${spec.namespace}\\${spec.name}`;
    designerHost.status(`Created ${spec.name}${s.migrate ? " and ran the migration" : ""}.`);
    closeView(this.el);
    designerHost.openAt(modelPath, 1);
    if (s.resource || this.then) {
      if (this.then) this.then(cls);
      else void import("./filamentwizard").then((m) => m.openResourceWizard({ model: cls, onCreated: () => {} }));
    }
  }

  /** Adds the other side of each relationship marked for it to the related model's class. */
  private async addInverses(cls: string) {
    const s = this.state!;
    const name = shortClass(cls);
    for (const r of s.spec.relations.filter((x) => s.inverse.has(x.id))) {
      const path = await fapp.fileOfClass(this.root, r.related);
      if (!path) continue;
      const model = await designerHost.ensureModel(path);
      const text = model.getValue();
      const outline = await fapp.outlineOf(text, path);
      const target = outline.classes.find((c) => c.fqn === r.related) ?? outline.classes[0];
      if (!target) continue;
      const inverse: RelationSpec = {
        id: "",
        type: r.type === "belongsTo" ? "hasMany" : r.type === "belongsToMany" ? "belongsToMany" : "belongsTo",
        name: r.type === "belongsTo" || r.type === "belongsToMany" ? camel(plural(name)) : camel(name),
        related: cls,
      };
      if (methodNamed(target, inverse.name)) continue;
      const imports = new Imports(text, outline);
      imports.name(cls);
      imports.name(`Illuminate\\Database\\Eloquent\\Relations\\${inverse.type.charAt(0).toUpperCase()}${inverse.type.slice(1)}`);
      await this.edit(model, [addMember(text, target, relationMethod(inverse)), ...imports.edits()]);
    }
  }

  /** Applies edits to a model and saves it. */
  private async edit(model: monaco.editor.ITextModel, edits: Edit[]) {
    const { applyWorkspaceEdit } = await import("./lsp");
    const pos = (o: number) => {
      const p = model.getPositionAt(o);
      return { line: p.lineNumber - 1, character: p.column - 1 };
    };
    await applyWorkspaceEdit({ changes: { [model.uri.toString()]: mergeEdits(edits).map((e) => ({ range: { start: pos(e.start), end: pos(e.end) }, newText: e.text })) } });
  }

  private async migrate() {
    this.setBusy("Running the migration…");
    try {
      await fapp.artisan(this.root, ["migrate", "--force"]);
    } catch (e) {
      showError("The migration failed. The files are written; fix the problem and run php artisan migrate", e);
    }
  }

  private async applyExisting() {
    const s = this.state!;
    const spec = this.cleanSpec();
    const root = this.root;
    const changes = diffColumns(spec.columns, s.before);
    const soft = s.spec.softDeletes !== s.softDeletesBefore ? (s.spec.softDeletes ? "add" : "drop") : undefined;
    const drops = changes.filter((c) => c.kind === "drop");
    if (drops.length && !(await confirm(`Drop ${drops.map((d) => (d as { column: ColumnSpec }).column.name).join(", ")} from ${spec.table}? Its data is lost when the migration runs.`, "Drop and continue"))) return;
    this.setBusy("Writing the changes…");
    if (changes.length || soft) {
      const name = soft && !changes.length ? `${soft === "add" ? "add_soft_deletes_to" : "remove_soft_deletes_from"}_${spec.table}_table` : alterName(spec.table, changes);
      await this.write(`${root}/database/migrations/${migrationFileName(name)}`, alterMigration(spec.table, changes, { softDeletes: soft }));
    }
    await this.editModelClass(spec);
    await this.addInverses(`${spec.namespace}\\${spec.name}`);
    if (s.migrate && (changes.length || soft)) await this.migrate();
    fapp.forget(["models", "model:", "migrations", "app"]);
    designerHost.status(`Applied the changes to ${spec.name}.`);
    await this.load();
  }

  /** Edits the model class: fillable, hidden, casts, soft deletes, and new relationships. */
  private async editModelClass(spec: ModelSpec) {
    const s = this.state!;
    const path = this.file!;
    const model = await designerHost.ensureModel(path);
    const text = model.getValue();
    const outline = await fapp.outlineOf(text, path);
    const cls = outline.classes.find((c) => c.name === spec.name) ?? outline.classes[0];
    if (!cls) return;
    const imports = new Imports(text, outline);
    const edits: Edit[] = [];
    const ex = s.existing!;
    // Fillable: in the property, in Laravel 13's #[Fillable] attribute, or a new property. A model with
    // `$guarded = []` takes everything already.
    const nextFillable = mergeList(ex.fillable, s.before, spec.columns, (c) => c.fillable);
    const unguarded = ex.guarded.length === 0 && !ex.fillable.length;
    if (!unguarded && JSON.stringify(nextFillable) !== JSON.stringify(ex.fillable)) edits.push(...this.listEdit(text, cls, "fillable", "Illuminate\\Database\\Eloquent\\Attributes\\Fillable", nextFillable, "protected $fillable", imports));
    const hidden = mergeList(ex.hidden, s.before, spec.columns, (c) => !!c.hidden);
    if (JSON.stringify(hidden) !== JSON.stringify(ex.hidden)) edits.push(...this.listEdit(text, cls, "hidden", "Illuminate\\Database\\Eloquent\\Attributes\\Hidden", hidden, "protected $hidden", imports));
    // Casts: new ones go into casts() or $casts; the ones already there stay.
    const newCasts = spec.columns.map((c) => [c.name, castFor(c)] as const).filter(([n, c]) => c && !ex.casts[n] && !ex.casts[s.before.find((b) => b.name === n)?.name ?? ""]) as [string, string][];
    if (newCasts.length) {
      for (const c of spec.columns.filter((x) => x.enum)) imports.name(c.enum!);
      const castsMethod = methodNamed(cls, "casts");
      const arr = castsMethod?.returns[0];
      const castsProp = propertyNamed(cls, "casts");
      const code = (v: string) => v;
      if (arr?.kind === "array") for (const [n, c] of newCasts) edits.push(insertItem(text, arr, arr.items.length, `${phpString(n)} => ${code(c)}`));
      else if (castsProp?.value?.kind === "array") for (const [n, c] of newCasts) edits.push(insertItem(text, castsProp.value, castsProp.value.items.length, `${phpString(n)} => ${code(c)}`));
      else edits.push(addMember(text, cls, `protected function casts(): array\n{\n    return [\n${newCasts.map(([n, c]) => `        ${phpString(n)} => ${c},`).join("\n")}\n    ];\n}`));
    }
    if (spec.softDeletes && !s.softDeletesBefore) {
      imports.name("Illuminate\\Database\\Eloquent\\SoftDeletes");
      const traitLine = /^([ \t]*)use\s+[\w\\, ]+;/m.exec(text.slice(cls.bodyStart));
      if (traitLine) {
        const at = cls.bodyStart + traitLine.index + traitLine[0].length - 1;
        edits.push({ start: at, end: at, text: ", SoftDeletes" });
      } else edits.push({ start: cls.bodyStart, end: cls.bodyStart, text: "\n    use SoftDeletes;\n" });
    }
    for (const r of spec.relations.filter((x) => !x.existing)) {
      imports.name(`Illuminate\\Database\\Eloquent\\Relations\\${r.type.charAt(0).toUpperCase()}${r.type.slice(1)}`);
      if (r.type !== "morphTo") imports.name(r.related);
      edits.push(addMember(text, cls, relationMethod(r)));
    }
    if (this.history) edits.push(...historyModelEdits(text, cls, this.history).map((e) => ({ ...e, text: e.text.replace(/\{\{([\w\\]+)\}\}/g, (_, fqn: string) => imports.name(fqn)) })));
    if (edits.length) {
      const all = [...edits, ...imports.edits()];
      await this.edit(model, [...all, ...droppedImports(text, outline, all)]);
    }
  }

  /** Edits for a list of attributes, such as fillable: the property's array, the attribute's, or a new property. */
  private listEdit(text: string, cls: OClass, prop: string, attribute: string, list: string[], declaration: string, imports: Imports): Edit[] {
    const property = propertyNamed(cls, prop);
    if (property?.value) return [replaceNode(text, property.value, phpValue(list))];
    const attr = cls.attributes.find((a) => a.name === attribute);
    const arg = attr?.args?.items[0]?.value;
    if (attr && arg) return [replaceNode(text, arg, phpValue(list))];
    void imports;
    void nodeValue;
    return list.length ? [setProperty(text, cls, prop, phpValue(list), declaration)] : [];
  }
}

/** The primary key most of the app's models use, so a new model follows the project. */
function projectKey(models: Record<string, fapp.ModelSummary>): ModelSpec["key"] {
  const all = Object.values(models);
  const ulid = all.filter((m) => m.ulid).length;
  const uuid = all.filter((m) => m.keyType === "string" && !m.ulid).length;
  if (ulid * 2 > all.length) return "ulid";
  return uuid * 2 > all.length ? "uuid" : "id";
}

/** A default typed into the column table, as PHP: numbers and booleans as they are, anything else quoted. */
function normalizeDefault(v: string, type: string): string {
  if (/^'.*'$/.test(v) || /^(true|false|null)$/i.test(v)) return v.toLowerCase() === v ? v : v.toLowerCase();
  if (/^-?\d+(\.\d+)?$/.test(v)) return type === "boolean" ? (v === "0" ? "false" : "true") : v;
  if (type === "boolean") return /^(yes|on)$/i.test(v) ? "true" : "false";
  return phpString(v);
}
