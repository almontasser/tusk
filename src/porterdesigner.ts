// The import and export designer: an importer's or exporter's columns (a CSV column each), and how an importer finds
// the record a row fills, changed in its code as you go (src/portergen.ts), with the CSV they read or write beside
// them. It also says what imports and exports still need in the app: Filament's tables, and a queue worker.
import { editFiles } from "./codeapply";
import { h, icon, iconButton } from "./dom";
import * as fapp from "./filamentapp";
import { humanize } from "./filamentcatalog";
import { host } from "./filamentdesigner";
import { commitInput, toggleSwitch } from "./filamentpickers";
import { shortClass } from "./filamentschema";
import { insertItem, moveItem, type OClass, type Outline, phpString, removeItem } from "./phpcode";
import { castEdits, columnCallEdit, columnCode, columnsArray, importRules, type PorterColumn, type PorterKind, readColumns, readResolution, type Resolution, resolutionEdits, rulesCode } from "./portergen";
import { showEditorView } from "./terminal";

const open = new Map<string, PorterDesigner>();

export function openPorter(file: string) {
  let v = open.get(file);
  if (!v) open.set(file, (v = new PorterDesigner(file)));
  v.show();
}

type Doc = { text: string; outline: Outline; cls: OClass };

class PorterDesigner {
  el = h("div", { class: "md-designer pd-designer" });
  private doc: Doc | null = null;
  private columns: fapp.ModelDetails["columns"] = null;
  private setup: Awaited<ReturnType<typeof fapp.porters>> | null = null;
  private listening = false;

  constructor(private file: string) {}

  private get root() {
    return host.root();
  }

  show() {
    showEditorView(`${this.file.split("/").pop()!.replace(/\.php$/, "")} · ${/Exporter\.php$/.test(this.file) ? "Export" : "Import"}`, this.el, "table", () => open.delete(this.file));
    if (!this.doc) void this.load();
    this.render();
  }

  private async load() {
    await this.read();
    const model = this.model;
    const [details, setup] = await Promise.all([model ? fapp.model(this.root, model).catch(() => null) : null, fapp.porters(this.root).catch(() => null)]);
    this.columns = details?.columns ?? null;
    this.setup = setup;
    this.render();
  }

  private async read() {
    const m = await host.ensureModel(this.file);
    if (!this.listening) {
      this.listening = true;
      m.onDidChangeContent(() => void this.read().then(() => this.el.isConnected && this.render()));
    }
    const text = m.getValue();
    const outline = await fapp.outlineOf(text, this.file);
    const cls = outline.classes.find((c) => c.name);
    this.doc = cls ? { text, outline, cls } : null;
  }

  private get kind(): PorterKind {
    return /Exporter$/.test(this.doc?.cls.extends ?? "") || /Exporter$/.test(this.doc?.cls.name ?? "") ? "exporter" : "importer";
  }

  /** The model, from `protected static ?string $model = Product::class`. */
  private get model(): string | null {
    const v = this.doc?.cls.properties.find((p) => p.name === "model")?.value;
    return v?.kind === "classConst" ? v.class : null;
  }

  private edit(build: (text: string, cls: OClass) => ReturnType<typeof columnCallEdit>, message: string) {
    return editFiles([{ path: this.file, build: (text, outline) => {
      const cls = outline.classes.find((c) => c.name);
      return cls ? build(text, cls) : null;
    } }], message);
  }

  /** Edits one column, read again from the current code. */
  private editColumn(index: number, build: (text: string, c: PorterColumn) => ReturnType<typeof columnCallEdit>, message: string) {
    return this.edit((text, cls) => {
      const arr = columnsArray(cls);
      const c = arr && readColumns(arr)[index];
      return c ? build(text, c) : [];
    }, message);
  }

  render() {
    const d = this.doc;
    const name = this.file.split("/").pop()!.replace(/\.php$/, "");
    const header = h(
      "header",
      { class: "fd-header" },
      h("span", { class: "fd-header-icon" }, icon(this.kind === "exporter" ? "cloud-download" : "cloud-upload")),
      h(
        "div",
        { class: "fd-header-titles" },
        h("h1", {}, humanize(name)),
        h("div", { class: "fd-header-chips" }, h("span", { class: "fd-chip-static" }, this.kind === "exporter" ? "Exporter" : "Importer"), this.model ? h("span", { class: "fd-chip-static" }, icon("database"), shortClass(this.model)) : null, h("button", { type: "button", class: "fd-chip-link", onclick: () => host.openAt(this.file, 1) }, icon("go-to-file"), `${name}.php`)),
      ),
      h("span", { class: "fd-spacer" }),
      iconButton("refresh", "Check again", () => (fapp.forget(["app:porters"]), void this.load())),
    );
    if (!d) return void this.el.replaceChildren(header, h("div", { class: "fd-loading" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), "Reading…"));
    if (d.outline.errors) return void this.el.replaceChildren(header, h("div", { class: "md-main" }, h("div", { class: "fd-helper-note fd-error-note" }, icon("warning"), h("span", {}, "The file has syntax errors. Fix them to design it here."))));
    const arr = columnsArray(d.cls);
    const columns = arr ? readColumns(arr) : [];
    const main = h("div", { class: "md-main" }, this.setupNote(), this.kind === "importer" ? this.records(d, columns) : null, arr ? this.columnsSection(d, columns) : h("p", { class: "fd-note" }, "getColumns() is written as code the designer can't read."));
    this.el.replaceChildren(header, h("div", { class: "md-body" }, main, this.preview(columns)));
  }

  /** What the app still needs for imports and exports to run. */
  private setupNote(): HTMLElement | null {
    const s = this.setup;
    if (!s) return null;
    const missing = Object.entries(s.tables).filter(([, has]) => has === false).map(([t]) => t);
    const notes: HTMLElement[] = [];
    if (missing.length) {
      const commands = [
        ...(missing.some((t) => ["imports", "exports", "failed_import_rows"].includes(t)) ? ["php artisan vendor:publish --tag=filament-actions-migrations"] : []),
        ...(missing.includes("job_batches") ? ["php artisan make:queue-batches-table"] : []),
        ...(missing.includes("notifications") ? ["php artisan make:notifications-table"] : []),
        "php artisan migrate",
      ];
      notes.push(
        h(
          "div",
          { class: "fd-helper-note fd-error-note" },
          icon("warning"),
          h("span", {}, `Imports and exports need tables the database doesn't have: ${missing.join(", ")}. `),
          h("button", { type: "button", class: "fd-chip-link", onclick: () => host.openTerminal("Set up imports and exports", ["/bin/sh", "-c", commands.join(" && ")], () => (fapp.forget(["app:porters"]), void this.load())) }, "Set them up"),
        ),
      );
    }
    if (s.queue && s.queue !== "sync") notes.push(h("p", { class: "fd-note" }, icon("info"), ` They run on the ${s.queue} queue, so a worker must be running: php artisan queue:work. `, h("button", { type: "button", class: "fd-chip-link", onclick: () => void import("./envsettings").then((m) => m.openEnvSettings("queue")) }, "Queue settings")));
    notes.push(h("p", { class: "fd-note" }, icon("info"), " People hear when one finishes through the panel's notifications bell (Panel settings > Notifications bell)."));
    return h("section", { class: "fd-settings-section" }, h("h3", {}, icon("checklist"), "What it needs"), ...notes);
  }

  private records(d: Doc, columns: PorterColumn[]): HTMLElement {
    const r = readResolution(d.text, d.cls);
    const model = this.model;
    const names = [...new Set([...columns.map((c) => c.name).filter((n): n is string => !!n), ...(this.columns ?? []).map((c) => c.name)])];
    const set = (next: Exclude<Resolution, { mode: "code" }>) => model && void this.edit((text, cls) => resolutionEdits(text, cls, model, next), "Changed how rows find their record");
    if (r.mode === "code")
      return h("section", { class: "fd-settings-section" }, h("h3", {}, icon("database"), "Records"), h("p", { class: "fd-note" }, "resolveRecord() is written as code: it decides which record each row fills."));
    const mode = h("select", {}, h("option", { value: "create", textContent: "Each row makes a new record", selected: r.mode === "create" }), h("option", { value: "upsert", textContent: "Update the record with the same…, or make one", selected: r.mode === "upsert" }), h("option", { value: "update", textContent: "Only update the record with the same…", selected: r.mode === "update" }));
    const column = h("select", {}, ...names.map((n) => h("option", { value: n, textContent: n, selected: r.mode !== "create" && r.column === n })));
    column.hidden = r.mode === "create";
    mode.onchange = () => set(mode.value === "create" ? { mode: "create" } : { mode: mode.value as "upsert", column: r.mode === "create" ? (names.find((n) => /slug|email|code|sku|number/.test(n)) ?? names[0] ?? "id") : r.column });
    column.onchange = () => r.mode !== "create" && set({ mode: r.mode, column: column.value });
    return h("section", { class: "fd-settings-section" }, h("h3", {}, icon("database"), "Records"), h("div", { class: "wd-inline" }, mode, column), r.mode === "update" ? h("p", { class: "fd-note" }, "A row with no matching record fails, and is listed in the failed rows people can download.") : null);
  }

  private columnsSection(d: Doc, columns: PorterColumn[]): HTMLElement {
    const present = new Set(columns.map((c) => c.name));
    const available = (this.columns ?? []).filter((c) => !present.has(c.name) && (this.kind === "exporter" || !/^(id|created_at|updated_at|deleted_at|remember_token)$/.test(c.name)));
    const add = h("select", {}, h("option", { value: "", textContent: available.length ? "Add a column…" : "Every column is in" }), ...available.map((c) => h("option", { value: c.name, textContent: `${c.name} · ${c.type}` })));
    add.disabled = !available.length;
    add.onchange = () => {
      const c = available.find((x) => x.name === add.value);
      if (!c) return;
      const code = columnCode(this.kind, c.name, this.kind === "importer" ? importRules(c) : {});
      void this.edit((text, cls) => {
        const arr = columnsArray(cls);
        return arr ? [insertItem(text, arr, arr.items.length, code)] : [];
      }, `Added ${c.name}`);
    };
    const rows = columns.map((c, i) => {
      const tools = h(
        "div",
        { class: "fd-card-actions" },
        iconButton("arrow-up", "Move up", () => i > 0 && void this.edit((text, cls) => moveItem(text, columnsArray(cls)!, i, i - 1), "Moved the column")),
        iconButton("arrow-down", "Move down", () => i < columns.length - 1 && void this.edit((text, cls) => moveItem(text, columnsArray(cls)!, i, i + 2), "Moved the column")),
        iconButton("trash", "Remove the column", () => void this.edit((text, cls) => [removeItem(text, columnsArray(cls)!, i)], "Removed the column")),
      );
      if (!c.name) return h("div", { class: "pd-col" }, h("div", { class: "pd-col-head" }, h("code", {}, d.text.slice(c.node.span[0], c.node.span[1]).replace(/\s+/g, " ").slice(0, 60)), h("span", { class: "fd-spacer" }), tools));
      const label = commitInput(c.label ?? "", (v) => void this.editColumn(i, (t, col) => columnCallEdit(t, col, "label", v.trim() ? phpString(v.trim()) : null), `${c.name}: label`), { placeholder: humanize(c.name) });
      const fields: HTMLElement[] = [h("label", { class: "pd-field" }, h("span", { class: "fd-note" }, "Heading"), label)];
      if (this.kind === "importer") {
        const cast = h("select", {}, ...[["text", "Text"], ["numeric", "Number"], ["integer", "Whole number"], ["boolean", "Yes or no"], ["array", "List, split by commas"]].map(([v, l]) => h("option", { value: v, textContent: l, selected: c.cast === v })));
        cast.onchange = () => void this.editColumn(i, (t, col) => castEdits(t, col, cast.value as PorterColumn["cast"]), `${c.name}: read as ${cast.value}`);
        const rules = c.rules === null ? h("span", { class: "fd-note" }, "Rules written as code") : commitInput(c.rules.join(", "), (v) => void this.editColumn(i, (t, col) => columnCallEdit(t, col, "rules", v.trim() ? rulesCode(v.split(",").map((x) => x.trim()).filter(Boolean)) : null), `${c.name}: rules`), { placeholder: "Such as: required, max:255" });
        const example = commitInput(c.example ?? "", (v) => void this.editColumn(i, (t, col) => columnCallEdit(t, col, "example", v.trim() ? phpString(v.trim()) : null), `${c.name}: example`), { placeholder: "A value for the example CSV" });
        fields.push(
          h("label", { class: "pd-field" }, h("span", { class: "fd-note" }, "Read as"), cast),
          h("label", { class: "pd-field wide" }, h("span", { class: "fd-note" }, "Rules"), rules),
          h("label", { class: "pd-field wide" }, h("span", { class: "fd-note" }, "Example"), example),
        );
      }
      const flag =
        this.kind === "importer"
          ? h("label", { class: "pd-flag", title: "The CSV must have this column: people match it to one of the file's columns before importing." }, toggleSwitch(c.required, (on) => void this.editColumn(i, (t, col) => columnCallEdit(t, col, "requiredMapping", on ? "" : null), `${c.name}: ${on ? "required" : "optional"}`)), "Must be in the file")
          : h("label", { class: "pd-flag", title: "Whether the column is checked when someone chooses what to export." }, toggleSwitch(c.enabled, (on) => void this.editColumn(i, (t, col) => columnCallEdit(t, col, "enabledByDefault", on ? null : "false"), `${c.name}: ${on ? "checked" : "unchecked"} by default`)), "Checked by default");
      return h(
        "div",
        { class: "pd-col" },
        h("div", { class: "pd-col-head" }, h("code", {}, c.name), c.relationship ? h("span", { class: "fd-note" }, "relationship") : null, h("span", { class: "fd-spacer" }), flag, tools),
        h("div", { class: "pd-fields" }, ...fields),
      );
    });
    return h("section", { class: "fd-settings-section" }, h("h3", {}, icon("list-flat"), "Columns", h("span", { class: "fd-spacer" }), add), ...rows);
  }

  /** The CSV: its header row, and for an importer, the example row people can download. */
  private preview(columns: PorterColumn[]): HTMLElement {
    const named = columns.filter((c) => c.name);
    const cell = (s: string) => h("td", {}, s);
    return h(
      "aside",
      { class: "ps-preview" },
      h("div", { class: "ps-preview-head" }, h("strong", {}, this.kind === "importer" ? "Example CSV" : "Exported CSV")),
      h(
        "div",
        { class: "pd-csv" },
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, ...named.map((c) => h("th", {}, c.label ?? (this.kind === "importer" ? c.name! : humanize(c.name!)))))),
          h("tbody", {}, h("tr", {}, ...named.map((c) => cell(this.kind === "importer" ? (c.example ?? "") : "…")))),
        ),
      ),
      h("p", { class: "fd-note" }, this.kind === "importer" ? "People download this example from the import dialog, and match their file's columns to these." : "Unchecked columns are left out unless someone checks them."),
    );
  }
}
