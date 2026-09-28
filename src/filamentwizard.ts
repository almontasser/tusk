// The New Resource wizard: a model (one the app has, or a new one from the model designer), where the resource
// goes in the panel, the form's fields, the table's columns, filters, and actions, and a review of the code.
// Filament's own generator (`make:filament-resource`) makes the files, so they follow the project's Filament version
// and stubs; the wizard then fills the form, table, and settings with edits, as the designer makes them.
import type * as L from "vscode-languageserver-protocol";
import { h, icon } from "./dom";
import * as fapp from "./filamentapp";
import { type Catalog, classInfo, humanize, labelFromName, majorVersion, methodsOf } from "./filamentcatalog";
import { host as designerHost, openDesigner } from "./filamentdesigner";
import { type Column, filterFor, formField, type Gen, inFormByDefault, infolistEntry, inTableByDefault, type ModelFacts, natureOf, renderGen, tableColumn, titleAttribute } from "./filamentgen";
import { commitInput, heroicon, pickHeroicon, segmented, toggleSwitch } from "./filamentpickers";
import { readRoot, type RootKind, shortClass } from "./filamentschema";
import { applyWorkspaceEdit } from "./lsp";
import { droppedImports, type Edit, Imports, indentCode, mergeEdits, methodNamed, type Outline, phpString, replaceNode, setCall, setProperty } from "./phpcode";
import { errorText, showError } from "./status";

type Step = "model" | "placement" | "form" | "table" | "review";
const STEPS: [Step, string, string][] = [
  ["model", "Model", "database"],
  ["placement", "Placement", "window"],
  ["form", "Form", "note"],
  ["table", "Table", "table"],
  ["review", "Review", "checklist"],
];

/** Field types the form step offers for a column, as classes. */
const FIELD_TYPES: [string, string][] = [
  ["Filament\\Forms\\Components\\TextInput", "Text input"],
  ["Filament\\Forms\\Components\\Textarea", "Textarea"],
  ["Filament\\Forms\\Components\\RichEditor", "Rich editor"],
  ["Filament\\Forms\\Components\\MarkdownEditor", "Markdown editor"],
  ["Filament\\Forms\\Components\\Select", "Select"],
  ["Filament\\Forms\\Components\\Radio", "Radio"],
  ["Filament\\Forms\\Components\\ToggleButtons", "Toggle buttons"],
  ["Filament\\Forms\\Components\\Toggle", "Toggle"],
  ["Filament\\Forms\\Components\\Checkbox", "Checkbox"],
  ["Filament\\Forms\\Components\\DatePicker", "Date picker"],
  ["Filament\\Forms\\Components\\DateTimePicker", "Date and time picker"],
  ["Filament\\Forms\\Components\\TimePicker", "Time picker"],
  ["Filament\\Forms\\Components\\FileUpload", "File upload"],
  ["Filament\\Forms\\Components\\ColorPicker", "Color picker"],
  ["Filament\\Forms\\Components\\TagsInput", "Tags"],
  ["Filament\\Forms\\Components\\KeyValue", "Key-value"],
  ["Filament\\Forms\\Components\\Hidden", "Hidden"],
];

type FieldRow = { column: Column; include: boolean; cls: string; required: boolean; full: boolean };
type ColumnRow = { column: Column; include: boolean; searchable: boolean; sortable: boolean; toggleable: boolean; hidden: boolean };

type Options = { panel?: string; model?: string; onCreated(): void };

export async function openResourceWizard(o: Options) {
  const root = designerHost.root();
  const w = new Wizard(root, o);
  await w.open();
}

class Wizard {
  root: string;
  o: Options;
  dialog = h("dialog", { class: "rw-dialog", ariaLabel: "New Filament resource" });
  step: Step = "model";
  cat: Catalog | null = null;
  app: fapp.AppInfo | null = null;
  models: Record<string, fapp.ModelSummary> = {};
  model = "";
  facts: (ModelFacts & { details: fapp.ModelDetails }) | null = null;
  factsError = "";
  query = "";
  panel = "";
  cluster = "";
  group = "";
  icon = "OutlinedRectangleStack";
  label = "";
  plural = "";
  title = "";
  simple = false;
  view = false;
  softDeletes = false;
  separate = true;
  fields: FieldRow[] = [];
  section = false;
  sectionHeading = "Details";
  formColumns = 2;
  columns: ColumnRow[] = [];
  filters = new Map<string, boolean>();
  actions = { view: true, edit: true, delete: false, bulkDelete: true, bulkRestore: true };
  sort = "";
  sortDir: "asc" | "desc" = "desc";
  busy = "";

  constructor(root: string, o: Options) {
    this.root = root;
    this.o = o;
    this.dialog.addEventListener("close", () => this.dialog.remove());
    this.dialog.addEventListener("cancel", (e) => this.busy && e.preventDefault());
  }

  async open() {
    document.querySelector(".rw-dialog")?.remove();
    document.body.append(this.dialog);
    this.dialog.showModal();
    this.dialog.replaceChildren(h("div", { class: "fd-loading rw-loading" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), "Reading the app…"));
    try {
      const [cat, app, models] = await Promise.all([fapp.catalog(this.root), fapp.app(this.root), fapp.models(this.root)]);
      this.cat = cat;
      this.app = app;
      this.models = models;
      if (majorVersion(cat) && majorVersion(cat) < 4) throw new Error(`The wizard works with Filament 4 and later; this project has ${cat.version}.`);
      if (!app.panels.length) throw new Error("The app has no Filament panel. Install Filament with a panel first.");
      this.panel = this.o.panel ?? app.panels.find((p) => p.default)?.id ?? app.panels[0].id;
      if (this.o.model) await this.chooseModel(this.o.model);
    } catch (e) {
      this.dialog.replaceChildren(h("div", { class: "fd-error" }, icon("warning"), h("div", {}, h("strong", {}, "Can't start the wizard"), h("p", {}, errorText(e)), h("div", { class: "fd-error-actions" }, h("button", { type: "button", onclick: () => this.dialog.close() }, "Close")))));
      return;
    }
    this.render();
  }

  get panelInfo() {
    return this.app?.panels.find((p) => p.id === this.panel) ?? null;
  }

  /** Reads a model's columns and relationships, and makes the form's and table's first proposal from them. */
  async chooseModel(cls: string) {
    this.model = cls;
    this.facts = null;
    this.factsError = "";
    this.render();
    try {
      this.facts = await fapp.modelFacts(this.root, cls);
    } catch (e) {
      this.factsError = errorText(e);
      return this.render();
    }
    const f = this.facts;
    const name = shortClass(cls);
    this.label = "";
    this.plural = "";
    this.title = titleAttribute(f.columns.map((c) => c.name), Object.fromEntries(f.columns.map((c) => [c.name, c.type])));
    this.softDeletes = !!f.softDeletes;
    this.fields = f.columns.filter((c) => !["id", "created_at", "updated_at", "deleted_at"].includes(c.name)).map((c) => {
      const gen = formField(c, f);
      return { column: c, include: inFormByDefault(c, f), cls: gen.cls, required: gen.calls.some(([m]) => m === "required"), full: gen.calls.some(([m]) => m === "columnSpanFull") };
    });
    this.columns = f.columns.filter((c) => c.name !== "id").map((c) => {
      const gen = tableColumn(c, f);
      const has = (m: string) => gen.calls.some(([x]) => x === m);
      return { column: c, include: inTableByDefault(c, f) && !["deleted_at"].includes(c.name), searchable: has("searchable"), sortable: has("sortable"), toggleable: has("toggleable"), hidden: gen.calls.some(([m, a]) => m === "toggleable" && a.includes("true")) };
    });
    this.filters = new Map(f.columns.filter((c) => filterFor(c, f)).map((c) => [c.name, true]));
    this.sort = f.columns.some((c) => c.name === "created_at") ? "created_at" : "";
    this.render();
    void name;
  }

  // ---- Rendering ----

  render() {
    const index = STEPS.findIndex(([s]) => s === this.step);
    const nav = h(
      "nav",
      { class: "rw-steps" },
      h("div", { class: "rw-title" }, icon("symbol-structure"), h("div", {}, h("strong", {}, "New resource"), h("span", { class: "fd-note" }, this.model ? shortClass(this.model) : "Pick a model"))),
      ...STEPS.map(([s, label, iconName], i) =>
        h(
          "button",
          { type: "button", class: `rw-step${s === this.step ? " active" : ""}${i < index ? " done" : ""}`, disabled: i > 0 && !this.facts, onclick: () => ((this.step = s), this.render()) },
          h("span", { class: "rw-step-number" }, i < index ? icon("check") : String(i + 1)),
          icon(iconName),
          label,
        ),
      ),
    );
    const body = h("div", { class: "rw-body" }, this.stepView());
    const back = h("button", { type: "button", disabled: index === 0 || !!this.busy, onclick: () => ((this.step = STEPS[index - 1][0]), this.render()) }, icon("arrow-left"), "Back");
    const next =
      this.step === "review"
        ? h("button", { type: "button", class: "primary", disabled: !!this.busy || !this.facts, onclick: () => void this.create() }, icon("add"), "Create resource")
        : h("button", { type: "button", class: "primary", disabled: !this.facts, onclick: () => ((this.step = STEPS[index + 1][0]), this.render()) }, "Next", icon("arrow-right"));
    const foot = h("footer", { class: "rw-foot" }, h("button", { type: "button", disabled: !!this.busy, onclick: () => this.dialog.close() }, "Cancel"), h("span", { class: "fd-spacer" }), this.busy ? h("span", { class: "md-busy" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), this.busy) : null, back, next);
    this.dialog.replaceChildren(h("div", { class: "rw-shell" }, nav, h("div", { class: "rw-main" }, body, foot)));
  }

  private stepView(): HTMLElement {
    switch (this.step) {
      case "model":
        return this.modelStep();
      case "placement":
        return this.placementStep();
      case "form":
        return this.formStep();
      case "table":
        return this.tableStep();
      case "review":
        return this.reviewStep();
    }
  }

  private heading(title: string, text: string) {
    return h("div", { class: "rw-heading" }, h("h2", {}, title), h("p", { class: "fd-note" }, text));
  }

  private modelStep() {
    const withResource = new Set((this.app?.panels ?? []).flatMap((p) => p.resources.map((r) => r.model)));
    const search = h("input", { type: "search", class: "rw-search", placeholder: "Search models", value: this.query, spellcheck: false });
    const list = h("div", { class: "rw-models", role: "listbox" });
    const render = () => {
      const q = search.value.trim().toLowerCase();
      this.query = search.value;
      const models = Object.values(this.models)
        .filter((m) => !q || m.class.toLowerCase().includes(q) || m.table.includes(q))
        .sort((a, b) => Number(withResource.has(a.class)) - Number(withResource.has(b.class)) || a.class.localeCompare(b.class));
      list.replaceChildren(
        ...models.map((m) =>
          h(
            "button",
            { type: "button", class: `rw-model${m.class === this.model ? " selected" : ""}`, role: "option", onclick: () => void this.chooseModel(m.class), ondblclick: () => this.facts && ((this.step = "placement"), this.render()) },
            icon("database"),
            h("div", { class: "rw-model-text" }, h("strong", {}, shortClass(m.class)), h("span", { class: "fd-note" }, `${m.table} · ${Object.keys(m.columns).length} columns${m.relations.length ? ` · ${m.relations.length} relationships` : ""}`)),
            withResource.has(m.class) ? h("span", { class: "rw-badge", title: "It already has a resource. A second one is fine, such as for another panel." }, "Has a resource") : null,
          ),
        ),
      );
      if (!models.length) list.append(h("p", { class: "fd-note fd-center" }, q ? "No model matches." : "The app has no models under app/."));
    };
    search.oninput = render;
    render();
    const status = this.model && !this.facts ? h("p", { class: "fd-note" }, this.factsError ? `Can't read ${shortClass(this.model)}: ${this.factsError}` : `Reading ${shortClass(this.model)}…`) : this.facts?.details.tableExists === false ? h("p", { class: "rw-warn" }, icon("warning"), "The model's table doesn't exist yet, so its columns come from the model. Run the migrations for a better proposal.") : null;
    const newModel = h("button", { type: "button", class: "rw-new-model" }, icon("add"), h("div", {}, h("strong", {}, "Design a new model…"), h("span", { class: "fd-note" }, "Its columns, relationships, and migration, then come back here")));
    newModel.onclick = () => {
      this.dialog.close();
      void import("./modeldesigner").then((m) => m.openNewModel({ then: (cls) => void openResourceWizard({ ...this.o, model: cls }) }));
    };
    requestAnimationFrame(() => search.focus());
    return h("div", { class: "rw-step-view" }, this.heading("Which model is it for?", "A resource lists, creates, and edits the records of one model."), newModel, search, list, status);
  }

  private field(label: string, editor: HTMLElement, help?: string) {
    return h("label", { class: "rw-field" }, h("span", { class: "rw-field-label" }, label), editor, help ? h("span", { class: "fd-note" }, help) : null);
  }

  private placementStep() {
    const app = this.app!;
    const name = shortClass(this.model);
    const panel = h("select", {}, ...app.panels.map((p) => h("option", { value: p.id, textContent: `${p.id} (/${p.path})`, selected: p.id === this.panel })));
    panel.onchange = () => ((this.panel = panel.value), (this.cluster = ""), this.render());
    const clusters = this.panelInfo?.clusters ?? [];
    const cluster = h("select", { disabled: !clusters.length }, h("option", { value: "", textContent: clusters.length ? "None" : "The panel has no clusters" }), ...clusters.map((c) => h("option", { value: c.class, textContent: c.label ?? shortClass(c.class), selected: c.class === this.cluster })));
    cluster.onchange = () => (this.cluster = cluster.value);
    const groups = [...new Set((this.panelInfo?.resources ?? []).map((r) => r.navigationGroup).filter((g): g is string => !!g))];
    const group = h("div", { class: "fd-inline-editor" }, commitInput(this.group, (v) => (this.group = v), { list: "rw-groups", placeholder: "None" }), h("datalist", { id: "rw-groups" }, ...groups.map((g) => h("option", { value: g }))));
    const iconBtn = h("button", { type: "button", class: "fd-icon-button" }, heroicon(this.cat?.heroiconsDir ?? null, this.icon), h("span", {}, this.icon.replace(/^Outlined/, "").replace(/([a-z\d])([A-Z])/g, "$1 $2")), icon("chevron-down"));
    iconBtn.onclick = async () => {
      const picked = await pickHeroicon(iconBtn, { dir: this.cat?.heroiconsDir ?? null, cases: this.cat?.heroicons ?? [], current: this.icon });
      if (picked) (this.icon = picked), this.render();
    };
    const columns = this.facts?.columns.map((c) => c.name) ?? [];
    const title = h("select", {}, h("option", { value: "", textContent: "None" }), ...columns.map((c) => h("option", { value: c, textContent: c, selected: c === this.title })));
    title.onchange = () => (this.title = title.value);
    const pages = segmented<"pages" | "simple">([["pages", "Separate pages"], ["simple", "One page with modals"]], this.simple ? "simple" : "pages", (v) => ((this.simple = v === "simple"), this.render()));
    return h(
      "div",
      { class: "rw-step-view" },
      this.heading("Where does it go?", "Its place in the panel's navigation, and the names Filament shows for it."),
      h(
        "div",
        { class: "rw-grid" },
        this.field("Panel", panel),
        this.field("Cluster", cluster),
        this.field("Navigation group", group, "Resources in the same group sit together in the sidebar."),
        this.field("Icon", iconBtn),
        this.field("Record name", commitInput(this.label, (v) => (this.label = v), { placeholder: labelFromName(name).toLowerCase() }), "Leave it empty to use the model's name."),
        this.field("Plural", commitInput(this.plural, (v) => (this.plural = v), { placeholder: labelFromName(name).toLowerCase() + "s" })),
        this.field("Records are titled by", title, "Names a record in breadcrumbs and global search."),
      ),
      h("h3", { class: "rw-subheading" }, "Pages"),
      h(
        "div",
        { class: "rw-grid" },
        this.field("Layout", pages, this.simple ? "Creating and editing happen in modals on the list page. Good for small records." : "List, create, and edit pages of their own."),
        this.field("View page", toggleSwitch(this.view, (on) => ((this.view = on), (this.actions.view = on), this.render())), "A read-only page for a record, with an infolist."),
        this.field("Soft deletes", toggleSwitch(this.softDeletes, (on) => ((this.softDeletes = on), this.render())), this.facts?.softDeletes ? "The model uses soft deletes." : "Restore and force-delete actions, and a trashed filter."),
        this.field("Schema and table classes", toggleSwitch(this.separate, (on) => (this.separate = on)), "Keep the form and table in classes of their own, as Filament 4 does by default."),
      ),
    );
  }

  private formStep() {
    const rows = h("div", { class: "rw-table" });
    rows.append(h("div", { class: "rw-row rw-row-head rw-form-row" }, h("span", {}), h("span", {}, "Column"), h("span", {}, "Field"), h("span", {}, "Required"), h("span", {}, "Full width")));
    this.fields.forEach((f, i) => {
      const include = h("input", { type: "checkbox", checked: f.include });
      include.onchange = () => ((f.include = include.checked), this.render());
      const type = h("select", { disabled: !f.include }, ...FIELD_TYPES.map(([c, l]) => h("option", { value: c, textContent: l, selected: c === f.cls })));
      if (!FIELD_TYPES.some(([c]) => c === f.cls)) type.prepend(h("option", { value: f.cls, textContent: shortClass(f.cls), selected: true }));
      type.onchange = () => (f.cls = type.value);
      const required = h("input", { type: "checkbox", checked: f.required, disabled: !f.include });
      required.onchange = () => (f.required = required.checked);
      const full = h("input", { type: "checkbox", checked: f.full, disabled: !f.include });
      full.onchange = () => (f.full = full.checked);
      const row = h("div", { class: `rw-row rw-form-row${f.include ? "" : " off"}`, draggable: true }, h("span", { class: "md-grip codicon codicon-gripper" }), h("label", { class: "rw-col-name" }, include, h("span", { class: "fd-mono" }, f.column.name), h("span", { class: "fd-note" }, natureLabel(f.column, this.facts!))), type, h("span", { class: "md-center" }, required), h("span", { class: "md-center" }, full));
      dragRow(row, i, this.fields, () => this.render());
      rows.append(row);
    });
    const section = toggleSwitch(this.section, (on) => ((this.section = on), this.render()));
    return h(
      "div",
      { class: "rw-step-view" },
      this.heading("What does the form ask for?", "Each column of the model can be a field. The proposal comes from each column's type, cast, and name. You can change everything later in the designer."),
      h(
        "div",
        { class: "rw-grid rw-grid-3" },
        this.field("Columns", segmented<string>([["1", "1"], ["2", "2"], ["3", "3"]], String(this.formColumns), (v) => ((this.formColumns = Number(v)), this.render()))),
        this.field("In a section", section),
        this.section ? this.field("Section heading", commitInput(this.sectionHeading, (v) => (this.sectionHeading = v))) : h("span"),
      ),
      rows,
    );
  }

  private tableStep() {
    const f = this.facts!;
    const rows = h("div", { class: "rw-table" });
    rows.append(h("div", { class: "rw-row rw-row-head rw-table-row" }, h("span", {}), h("span", {}, "Column"), h("span", {}, "Searchable"), h("span", {}, "Sortable"), h("span", {}, "Can be hidden"), h("span", {}, "Hidden at first")));
    this.columns.forEach((c, i) => {
      const box = (key: "include" | "searchable" | "sortable" | "toggleable" | "hidden", disabled = false) => {
        const b = h("input", { type: "checkbox", checked: c[key], disabled });
        b.onchange = () => ((c[key] = b.checked), key === "include" || key === "toggleable" ? this.render() : undefined);
        return b;
      };
      const row = h("div", { class: `rw-row rw-table-row${c.include ? "" : " off"}`, draggable: true }, h("span", { class: "md-grip codicon codicon-gripper" }), h("label", { class: "rw-col-name" }, box("include"), h("span", { class: "fd-mono" }, tableColumn(c.column, f).make.replace(/'/g, "")), h("span", { class: "fd-note" }, natureLabel(c.column, f))), h("span", { class: "md-center" }, box("searchable", !c.include)), h("span", { class: "md-center" }, box("sortable", !c.include)), h("span", { class: "md-center" }, box("toggleable", !c.include)), h("span", { class: "md-center" }, box("hidden", !c.include || !c.toggleable)));
      dragRow(row, i, this.columns, () => this.render());
      rows.append(row);
    });
    const filterBoxes = f.columns
      .filter((c) => filterFor(c, f))
      .map((c) => {
        const gen = filterFor(c, f)!;
        const b = h("input", { type: "checkbox", checked: this.filters.get(c.name) ?? false });
        b.onchange = () => this.filters.set(c.name, b.checked);
        return h("label", { class: "fd-check-label rw-check" }, b, `${shortClass(gen.cls).replace(/Filter$/, "")}: ${gen.make.replace(/'/g, "") || c.name}`);
      });
    if (this.softDeletes && !f.columns.some((c) => c.name === "deleted_at")) filterBoxes.push(h("label", { class: "fd-check-label rw-check" }, h("input", { type: "checkbox", checked: true, disabled: true }), "Trashed"));
    const action = (key: keyof typeof this.actions, label: string, disabled = false) => {
      const b = h("input", { type: "checkbox", checked: this.actions[key] && !disabled, disabled });
      b.onchange = () => (this.actions[key] = b.checked);
      return h("label", { class: "fd-check-label rw-check" }, b, label);
    };
    const sortSelect = h("select", {}, h("option", { value: "", textContent: "None" }), ...this.columns.filter((c) => c.include).map((c) => h("option", { value: c.column.name, textContent: c.column.name, selected: c.column.name === this.sort })));
    sortSelect.onchange = () => ((this.sort = sortSelect.value), this.render());
    return h(
      "div",
      { class: "rw-step-view" },
      this.heading("What does the table show?", "The list page's columns, the filters above them, and the actions on each row."),
      rows,
      h("div", { class: "rw-grid" }, this.field("Filters", h("div", { class: "rw-checks" }, ...(filterBoxes.length ? filterBoxes : [h("span", { class: "fd-note" }, "No column suggests a filter. You can add filters in the designer.")])))),
      h(
        "div",
        { class: "rw-grid" },
        this.field("Row actions", h("div", { class: "rw-checks" }, action("view", "View", !this.view && !this.simple), action("edit", "Edit"), action("delete", "Delete"))),
        this.field("Bulk actions", h("div", { class: "rw-checks" }, action("bulkDelete", "Delete selected"), action("bulkRestore", "Restore and force delete selected", !this.softDeletes))),
        this.field("Default sort", h("div", { class: "fd-inline-editor" }, sortSelect, this.sort ? segmented<"asc" | "desc">([["desc", "Newest first"], ["asc", "Oldest first"]], this.sortDir, (v) => ((this.sortDir = v), this.render())) : null)),
      ),
    );
  }

  private reviewStep() {
    const code = this.codePreview();
    const panel = this.panelInfo;
    const name = shortClass(this.model);
    const plural = this.plural || `${labelFromName(name)}s`;
    const items: [string, string][] = [
      ["Resource", `${name}Resource in ${panel?.id ?? "the panel"}${this.cluster ? `, cluster ${shortClass(this.cluster)}` : ""}`],
      ["Address", `${panel?.path ? `/${panel.path}` : ""}/${plural.toLowerCase().replace(/\s+/g, "-")}`],
      ["Navigation", `${this.group ? `${this.group} › ` : ""}${plural}`],
      ["Pages", this.simple ? "One page with modals" : `List, create, edit${this.view ? ", view" : ""}`],
      ["Form", `${count(this.fields.filter((f) => f.include).length, "field")}${this.section ? " in a section" : ""}, ${count(this.formColumns, "column")}`],
      ["Table", `${count(this.columns.filter((c) => c.include).length, "column")}, ${count([...this.filters.values()].filter(Boolean).length + (this.softDeletes ? 1 : 0), "filter")}`],
    ];
    return h(
      "div",
      { class: "rw-step-view" },
      this.heading("Ready to create", "Filament's generator makes the files, then the wizard fills in the form and table. The designer opens next."),
      h("dl", { class: "rw-summary" }, ...items.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
      h("div", { class: "rw-code" }, h("div", { class: "rw-code-title" }, "Form"), h("pre", {}, code.form), h("div", { class: "rw-code-title" }, "Table columns"), h("pre", {}, code.table)),
    );
  }

  // ---- The code ----

  /** The form's components, with `name` naming classes. */
  private formItems(name: (f: string) => string): string[] {
    const f = this.facts!;
    const items = this.fields
      .filter((x) => x.include)
      .map((x) => {
        let gen = formField(x.column, f);
        if (gen.cls !== x.cls) {
          // A different field type keeps the settings it also has.
          const info = this.cat && classInfo(this.cat, x.cls);
          const methods = info ? methodsOf(this.cat!, info) : null;
          gen = { cls: x.cls, make: gen.make, calls: gen.calls.filter(([m]) => !methods || methods.has(m)) };
        }
        // A setting the proposal already has, such as a password's required-on-create closure, stays as it is.
        const has = (m: string) => gen.calls.some(([c]) => c === m);
        if (x.required !== has("required")) gen = withCall(gen, "required", x.required ? "" : null);
        if (x.full !== has("columnSpanFull")) gen = withCall(gen, "columnSpanFull", x.full ? "" : null);
        return renderGen(gen, name);
      });
    if (!this.section) return items;
    const S = name("Filament\\Schemas\\Components\\Section");
    return [`${S}::make(${phpString(this.sectionHeading || "Details")})\n    ->columns(${this.formColumns})\n    ->schema([\n        ${items.map((i) => indentCode(i, "        ")).join(",\n        ")},\n    ])${this.formColumns > 1 ? "\n    ->columnSpanFull()" : ""}`];
  }

  private tableItems(name: (f: string) => string): string[] {
    const f = this.facts!;
    return this.columns
      .filter((c) => c.include)
      .map((c) => {
        let gen = tableColumn(c.column, f);
        gen = withCall(gen, "searchable", c.searchable ? "" : null);
        gen = withCall(gen, "sortable", c.sortable ? "" : null);
        gen = withCall(gen, "toggleable", c.toggleable ? (c.hidden ? "isToggledHiddenByDefault: true" : "") : null);
        return renderGen(gen, name);
      });
  }

  private filterItems(name: (f: string) => string): string[] {
    const f = this.facts!;
    const out = f.columns.filter((c) => this.filters.get(c.name) && filterFor(c, f)).map((c) => renderGen(filterFor(c, f)!, name));
    if (this.softDeletes && !out.some((x) => x.startsWith(name("Filament\\Tables\\Filters\\TrashedFilter")))) out.push(`${name("Filament\\Tables\\Filters\\TrashedFilter")}::make()`);
    return out;
  }

  private recordActions(name: (f: string) => string): string[] {
    const A = "Filament\\Actions\\";
    const out: string[] = [];
    if (this.actions.view && (this.view || this.simple)) out.push(`${name(`${A}ViewAction`)}::make()`);
    if (this.actions.edit) out.push(`${name(`${A}EditAction`)}::make()`);
    if (this.actions.delete) out.push(`${name(`${A}DeleteAction`)}::make()`);
    if (this.softDeletes) out.push(`${name(`${A}ForceDeleteAction`)}::make()`, `${name(`${A}RestoreAction`)}::make()`);
    return out;
  }

  private bulkActions(name: (f: string) => string): string[] {
    const A = "Filament\\Actions\\";
    const inner: string[] = [];
    if (this.actions.bulkDelete) inner.push(`${name(`${A}DeleteBulkAction`)}::make()`);
    if (this.softDeletes && this.actions.bulkRestore) inner.push(`${name(`${A}ForceDeleteBulkAction`)}::make()`, `${name(`${A}RestoreBulkAction`)}::make()`);
    return inner.length ? [`${name(`${A}BulkActionGroup`)}::make([\n    ${inner.join(",\n    ")},\n])`] : [];
  }

  private codePreview() {
    const n = shortClass;
    return { form: `[\n    ${this.formItems(n).map((i) => indentCode(i, "    ")).join(",\n    ")},\n]`, table: `[\n    ${this.tableItems(n).map((i) => indentCode(i, "    ")).join(",\n    ")},\n]` };
  }

  // ---- Creating ----

  private setBusy(text: string) {
    this.busy = text;
    this.render();
  }

  async create() {
    const f = this.facts!;
    const model = this.model;
    const ns = model.slice(0, model.lastIndexOf("\\"));
    try {
      this.setBusy("Running make:filament-resource…");
      const args = [
        "make:filament-resource",
        shortClass(model),
        `--model-namespace=${ns}`,
        `--panel=${this.panel}`,
        ...(this.cluster ? [`--cluster=${this.cluster}`] : []),
        ...(this.simple ? ["--simple"] : []),
        ...(this.view && !this.simple ? ["--view"] : []),
        ...(this.softDeletes ? ["--soft-deletes"] : []),
        ...(this.title ? [`--record-title-attribute=${this.title}`] : []),
        ...(!this.separate ? ["--embed-schemas", "--embed-table"] : []),
      ];
      const out = await fapp.artisan(this.root, args);
      const files = await fapp.createdFiles(this.root, out);
      const resource = files.find((p) => /Resource\.php$/.test(p)) ?? (await this.findResource(out));
      if (!resource) throw new Error(`Filament didn't say where it put the resource:\n${out}`);
      this.setBusy("Filling in the form and table…");
      await this.fill(resource, f);
      fapp.forget(["app"]);
      this.dialog.close();
      this.o.onCreated();
      designerHost.status(`Created ${shortClass(model)}Resource.`);
      await openDesigner(resource, "form");
    } catch (e) {
      showError("Can't create the resource", e);
      this.setBusy("");
    }
  }

  /** The resource's file when the generator's output names only its class. */
  private async findResource(out: string) {
    const m = /\[([^\]]*Resource)\]/.exec(out.replace(/\x1b\[[\d;]*m/g, ""));
    return m ? fapp.fileOfClass(this.root, m[1]) : null;
  }

  /** Edits a file: `build` gets its text, outline, and imports. Saved with local history. */
  private async editFile(path: string, build: (text: string, outline: Outline, imports: Imports) => Edit[]) {
    const model = await designerHost.ensureModel(path);
    const text = model.getValue();
    const outline = await fapp.outlineOf(text, path);
    const imports = new Imports(text, outline);
    const made = [...build(text, outline, imports), ...imports.edits()];
    const edits = mergeEdits([...made, ...droppedImports(text, outline, made)]);
    if (!edits.length) return;
    const pos = (o: number) => {
      const p = model.getPositionAt(o);
      return { line: p.lineNumber - 1, character: p.column - 1 };
    };
    await applyWorkspaceEdit({ changes: { [model.uri.toString()]: edits.map((e): L.TextEdit => ({ range: { start: pos(e.start), end: pos(e.end) }, newText: e.text })) } });
  }

  /** Where a root's code is: the resource's method, or the class it hands the work to. */
  private async rootFile(resource: string, kind: RootKind): Promise<{ path: string; method: string; cls: string } | null> {
    const text = (await designerHost.ensureModel(resource)).getValue();
    const outline = await fapp.outlineOf(text, resource);
    const cls = outline.classes.find((c) => c.name);
    if (!cls) return null;
    const root = readRoot(cls, kind);
    if (!root) return null;
    if (root.delegate) {
      const path = await fapp.fileOfClass(this.root, root.delegate.class);
      return path ? { path, method: root.delegate.method, cls: root.delegate.class } : null;
    }
    return { path: resource, method: kind, cls: cls.fqn };
  }

  /** Replaces the generator's empty form, table, and infolist with the chosen components, and sets the settings. */
  private async fill(resource: string, f: ModelFacts) {
    const arrayOf = (items: string[]) => (items.length ? `[\n    ${items.map((i) => indentCode(i, "    ")).join(",\n    ")},\n]` : "[\n    //\n]");
    const form = await this.rootFile(resource, "form");
    if (form)
      await this.editFile(form.path, (text, outline, imports) => {
        const cls = outline.classes.find((c) => c.fqn === form.cls) ?? outline.classes[0];
        const root = cls && readRoot(cls, "form", form.method);
        const slot = root && (root.slots.get("components") ?? root.slots.get("schema"));
        if (!root || !slot) return [];
        const name = (x: string) => imports.name(x);
        const edits = [replaceNode(text, slot.array, arrayOf(this.formItems(name)))];
        if (this.formColumns !== 2 && !this.section) edits.push(setCall(text, root.node, "columns", String(this.formColumns)));
        return edits;
      });
    const table = await this.rootFile(resource, "table");
    if (table)
      await this.editFile(table.path, (text, outline, imports) => {
        const cls = outline.classes.find((c) => c.fqn === table.cls) ?? outline.classes[0];
        const root = cls && readRoot(cls, "table", table.method);
        if (!root) return [];
        const name = (x: string) => imports.name(x);
        const edits: Edit[] = [];
        const set = (names: string[], items: string[], call: string) => {
          const slot = names.map((n) => root.slots.get(n)).find(Boolean);
          if (slot) edits.push(replaceNode(text, slot.array, arrayOf(items)));
          else if (items.length) edits.push(setCall(text, root.node, call, arrayOf(items)));
        };
        set(["columns"], this.tableItems(name), "columns");
        set(["filters"], this.filterItems(name), "filters");
        set(["recordActions", "actions"], this.recordActions(name), "recordActions");
        set(["toolbarActions", "bulkActions"], this.bulkActions(name), "toolbarActions");
        if (this.sort) edits.push(setCall(text, root.node, "defaultSort", `${phpString(this.sort)}${this.sortDir === "desc" ? ", 'desc'" : ""}`, undefined, "columns"));
        return edits;
      });
    if (this.view && !this.simple) {
      const infolist = await this.rootFile(resource, "infolist");
      if (infolist)
        await this.editFile(infolist.path, (text, outline, imports) => {
          const cls = outline.classes.find((c) => c.fqn === infolist.cls) ?? outline.classes[0];
          const root = cls && readRoot(cls, "infolist", infolist.method);
          const slot = root && (root.slots.get("components") ?? root.slots.get("schema"));
          if (!slot) return [];
          const items = f.columns.filter((c) => c.name !== "id" && !/password|token/.test(c.name)).map((c) => renderGen(infolistEntry(c, f), (x) => imports.name(x)));
          return [replaceNode(text, slot.array, arrayOf(items))];
        });
    }
    // The resource's own settings.
    await this.editFile(resource, (text, outline, imports) => {
      const cls = outline.classes.find((c) => /Resource$/.test(c.name));
      if (!cls) return [];
      const edits: Edit[] = [];
      const decl = (prop: string) => {
        const type = this.cat?.resourceProperties[prop]?.type ?? "?string";
        return `protected static ${type.split("|").map((t) => (/^\??[A-Z]/.test(t) ? t.replace(/^(\??)(.+)$/, (_, q: string, c: string) => q + imports.name(c)) : t)).join("|")} $${prop}`;
      };
      if (this.icon && this.icon !== "OutlinedRectangleStack") edits.push(setProperty(text, cls, "navigationIcon", majorVersion(this.cat!) >= 4 && this.cat!.heroicons.length ? `${imports.name("Filament\\Support\\Icons\\Heroicon")}::${this.icon}` : phpString(this.icon), decl("navigationIcon")));
      if (this.group) edits.push(setProperty(text, cls, "navigationGroup", phpString(this.group), decl("navigationGroup")));
      if (this.label) edits.push(setProperty(text, cls, "modelLabel", phpString(this.label), decl("modelLabel")));
      if (this.plural) edits.push(setProperty(text, cls, "pluralModelLabel", phpString(this.plural), decl("pluralModelLabel")));
      void methodNamed;
      // Properties inserted at one place go in the order they're listed.
      return edits;
    });
  }
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Adds or removes a call in a component to write. */
function withCall(g: Gen, name: string, args: string | null): Gen {
  const calls = g.calls.filter(([m]) => m !== name);
  if (args !== null) calls.push([name, args]);
  return { ...g, calls };
}

/** What a column holds, in a word, for the wizard's lists. */
function natureLabel(c: Column, f: ModelFacts): string {
  const n = natureOf(c, f);
  return n === "foreign" ? "relationship" : n === "string" ? c.type : humanize(n).toLowerCase();
}

/** Lets rows of a list be reordered by dragging. */
function dragRow<T>(row: HTMLElement, i: number, list: T[], redraw: () => void) {
  row.ondragstart = (e) => (e.dataTransfer!.setData("text/plain", String(i)), row.classList.add("fd-dragging"));
  row.ondragend = () => row.classList.remove("fd-dragging");
  row.ondragover = (e) => e.preventDefault();
  row.ondrop = (e) => {
    e.preventDefault();
    const from = Number(e.dataTransfer!.getData("text/plain"));
    if (Number.isNaN(from) || from === i) return;
    const [moved] = list.splice(from, 1);
    list.splice(i, 0, moved);
    redraw();
  };
}
