// The settings designer: an editor tab for a spatie/laravel-settings class, its typed properties and group, with the
// values the app stores for them. Changes are staged and written on Apply with one settings migration
// (src/settingsgen.ts), which also seeds new properties and updates changed values. Also installs the packages, and
// makes and fills the Filament settings page that edits the class.
import { invoke } from "@tauri-apps/api/core";
import type * as L from "vscode-languageserver-protocol";
import { h, icon, iconButton } from "./dom";
import { monaco } from "./editor";
import * as fapp from "./filamentapp";
import { majorVersion } from "./filamentcatalog";
import type { ModelFacts } from "./filamentgen";
import { host, openDesigner } from "./filamentdesigner";
import { askName, commitInput, toggleSwitch } from "./filamentpickers";
import { shortClass } from "./filamentschema";
import { applyWorkspaceEdit, toolPath } from "./lsp";
import { migrationFileName } from "./modelgen";
import { pick, rank, type Item } from "./palette";
import { applyEdits, type Edit, mergeEdits, type Outline } from "./phpcode";
import { shellQuote } from "./runconfig";
import {
  coerce,
  DATE_CLASS,
  defaultValue,
  fieldsFor,
  groupFor,
  migrationLines,
  migrationName,
  pageFieldEdits,
  propName,
  readCode,
  readSettings,
  type ReadSettings,
  registerEdit,
  SETTING_TYPES,
  settingsEdits,
  settingsFacts,
  settingsFile,
  settingsMigration,
  type SettingProp,
  type SettingsSpec,
  type SettingType,
  type Stored,
} from "./settingsgen";
import { errorText, showError } from "./status";
import { closeView, showEditorView } from "./terminal";
import { composerCommand } from "./toolpaths";

const open = new Map<string, SettingsDesigner>();

/** Opens the designer for a settings class's file. */
export function openSettingsDesigner(file: string) {
  let d = open.get(file);
  if (!d) open.set(file, (d = new SettingsDesigner(file)));
  d.show();
}

/** Opens the designer for a new settings class. */
export const openNewSettings = () => new SettingsDesigner(null).show();

/** Picks a settings class to open in the designer, or makes a new one. */
export async function openSettingsPicker() {
  const root = host.root();
  const info = await fapp.settings(root).catch((e) => (host.status(`Can't read the settings: ${errorText(e)}`), null));
  const items: Item[] = (info?.installed ? info.classes : []).map((c) => ({ label: shortClass(c.class), detail: `${c.group} · ${c.properties.length} properties`, icon: "codicon-settings", run: () => c.file && openSettingsDesigner(`${root}/${c.file}`) }));
  items.push({ label: "New Settings…", detail: "Design a settings class and its migration", icon: "codicon-add", run: openNewSettings });
  pick("Open settings in the designer", (query) => (query.trim() ? rank(query, items) : items));
}

/** Picks a settings class and a panel, and makes a settings page for it. */
export async function newSettingsPagePicker() {
  const root = host.root();
  const info = await fapp.settings(root).catch(() => null);
  if (!info?.installed || !info.plugin) return void installSettings();
  const items: Item[] = info.classes.map((c) => ({ label: shortClass(c.class), detail: c.pages.length ? `Has ${c.pages.map((p) => shortClass(p.class)).join(", ")}` : c.group, icon: "codicon-settings", run: () => void newSettingsPage(c.class) }));
  items.push({ label: "New Settings…", detail: "Design the settings first, then make their page", icon: "codicon-add", run: openNewSettings });
  pick("New settings page: pick the settings", (query) => (query.trim() ? rank(query, items) : items));
}

/**
 * Makes a settings page with the plugin's `make:filament-settings-page`, in a panel you pick, fills its form with a
 * field for each property, and opens it in the designer.
 */
export async function newSettingsPage(cls: string, anchor?: HTMLElement) {
  const root = host.root();
  const app = await fapp.app(root).catch(() => null);
  const panels = app?.panels ?? [];
  const panel = panels.length > 1 ? await new Promise<fapp.PanelInfo | null>((resolve) => pick("Settings page: pick a panel", (q) => { const items = panels.map((p) => ({ label: p.id, detail: `/${p.path}`, icon: "codicon-window", run: () => resolve(p) })); return q.trim() ? rank(q, items) : items; })) : panels[0];
  if (!panel) return host.status("Filament needs a panel for the page.");
  const base = shortClass(cls).replace(/Settings$/, "") || shortClass(cls);
  const name = await askName(anchor ?? { x: innerWidth / 2 - 160, y: 120 }, { title: "Settings page name", value: `Manage${base}`, validate: (v) => (/^[A-Z][A-Za-z0-9]*$/.test(v) ? null : "A class name, such as ManageGeneral."), action: "Create" });
  if (!name) return;
  try {
    const out = await fapp.artisan(root, ["make:filament-settings-page", name, cls, `--panel=${panel.id}`]);
    const path = (await fapp.createdFiles(root, out))[0] ?? (await fapp.fileOfClass(root, `${panel.pageNamespaces[0] ?? "App\\Filament\\Pages"}\\${name}`));
    if (!path) throw new Error(`make:filament-settings-page didn't say where it put ${name}.`);
    // The generator's own fields type a list as text, so the page gets Tusk's, from each property's type.
    const file = await fapp.fileOfClass(root, cls);
    if (file) {
      const text = await invoke<string>("read_file", { path: file });
      const read = readSettings(await fapp.outlineOf(text, file), await enumClasses(root), null);
      if (read) await addFields(path, cls, read.spec.props.filter((p) => !p.code));
    }
    fapp.forget(["app"]);
    host.status(`Created ${name}.`);
    void openDesigner(path, "form");
  } catch (e) {
    showError("Can't make the settings page", e);
  }
}

/** Adds a form field for each property to a settings page, and saves it. */
async function addFields(page: string, cls: string, props: SettingProp[]) {
  const model = await host.ensureModel(page);
  const text = model.getValue();
  const edits = pageFieldEdits(text, await fapp.outlineOf(text, page), fieldsFor(cls, props, await enumClasses(host.root())));
  if (!edits) return host.status(`${page.split("/").pop()}'s form isn't a list the designer can add to. Add the fields in the designer.`);
  await applyTo(model, edits);
}

/** Applies edits to an editor model and saves it, with local history. */
async function applyTo(model: monaco.editor.ITextModel, edits: Edit[]) {
  const pos = (o: number) => {
    const p = model.getPositionAt(o);
    return { line: p.lineNumber - 1, character: p.column - 1 };
  };
  await applyWorkspaceEdit({ changes: { [model.uri.toString()]: mergeEdits(edits).map((e): L.TextEdit => ({ range: { start: pos(e.start), end: pos(e.end) }, newText: e.text })) } });
}

/** A settings class's properties as the Filament designer's model facts, so a settings page's palette offers them as fields. */
export async function settingsFactsOf(cls: string): Promise<(ModelFacts & { details: fapp.ModelDetails }) | null> {
  const root = host.root();
  const file = await fapp.fileOfClass(root, cls);
  if (!file) return null;
  const text = (await host.ensureModel(file)).getValue();
  const enums = await enumClasses(root);
  const read = readSettings(await fapp.outlineOf(text, file), enums, null);
  return read ? { ...settingsFacts(cls, read.spec.props, enums), details: { file, tableExists: true } as fapp.ModelDetails } : null;
}

const enumClasses = async (root: string) => (await fapp.enums(root).catch(() => [])).map((e) => e.class);

/**
 * Installs spatie/laravel-settings in a terminal tab, with Filament's plugin for the project's Filament version when
 * the project has Filament, then publishes the package's migration and config and migrates.
 */
export async function installSettings(done?: () => void) {
  const root = host.root();
  const composer = composerCommand(await toolPath("composer/composer.phar")).map(shellQuote).join(" ");
  const has = (p: string) => invoke<boolean>("path_exists", { path: `${root}/vendor/${p}` }).catch(() => false);
  const packages: string[] = [];
  if (!(await has("spatie/laravel-settings"))) packages.push("spatie/laravel-settings");
  if ((await fapp.hasFilament(root)) && !(await has("filament/spatie-laravel-settings-plugin"))) {
    const major = majorVersion((await fapp.catalog(root).catch(() => null)) ?? { version: null });
    packages.push(shellQuote(`filament/spatie-laravel-settings-plugin${major ? `:^${major}.0` : ""}`));
  }
  const steps = [
    ...(packages.length ? [`${composer} require ${packages.join(" ")} --no-interaction`] : []),
    `php artisan vendor:publish --provider=${shellQuote("Spatie\\LaravelSettings\\LaravelSettingsServiceProvider")} --tag=migrations --tag=config --no-interaction`,
    "php artisan migrate",
  ];
  host.openTerminal("Install settings", ["/bin/sh", "-c", steps.join(" && ")], () => (fapp.forget(), done?.()));
}

/** A property as the designer edits it. */
type Row = SettingProp & { id: number };
let nextId = 1;

class SettingsDesigner {
  file: string | null;
  el = h("div", { class: "md-designer ed-designer sd-designer" });
  spec: SettingsSpec | null = null;
  rows: Row[] = [];
  read: ReadSettings | null = null;
  text = "";
  outline: Outline | null = null;
  info: fapp.SettingsInfo | null = null;
  cls: fapp.SettingsClassInfo | null = null;
  enums: fapp.EnumInfo[] = [];
  error = "";
  busy = "";
  migrate = true;
  addFields = true;
  previewTab: "class" | "migration" = "class";
  preview: monaco.editor.IStandaloneCodeEditor | null = null;
  previewHost = h("div", { class: "md-preview-editor" });

  constructor(file: string | null) {
    this.file = file;
  }

  get root() {
    return host.root();
  }

  show() {
    const title = this.file ? `${this.file.split("/").pop()!.replace(/\.php$/, "")} · Settings` : "New Settings";
    showEditorView(title, this.el, "settings", () => {
      this.preview?.dispose();
      this.preview = null;
      if (this.file) open.delete(this.file);
    });
    if (!this.spec) void this.load();
  }

  async load() {
    this.el.replaceChildren(h("div", { class: "fd-loading" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), "Reading the settings…"));
    try {
      const root = this.root;
      // The app's values need it to boot; without them, the designer still edits the code.
      const [info, enums] = await Promise.all([fapp.settings(root).catch(() => null), fapp.enums(root).catch(() => [])]);
      this.info = info;
      this.enums = enums;
      if (this.file) {
        this.text = await invoke<string>("read_file", { path: this.file });
        this.outline = await fapp.outlineOf(this.text, this.file);
        const rel = this.file.slice(root.length + 1);
        this.cls = (info?.installed && info.classes.find((c) => c.file === rel)) || null;
        this.read = readSettings(this.outline, enums.map((e) => e.class), this.cls?.values ?? null);
        if (!this.read) throw new Error("There's no settings class in this file: a class that extends Spatie\\LaravelSettings\\Settings.");
        this.spec = structuredClone(this.read.spec);
      } else this.spec = { name: "GeneralSettings", namespace: "App\\Settings", group: "general", props: [] };
      this.rows = this.spec.props.map((p) => ({ ...p, id: nextId++ }));
      this.error = "";
    } catch (e) {
      this.error = errorText(e);
    }
    this.render();
  }

  // ---- Rendering ----

  render() {
    if (this.error) {
      this.el.replaceChildren(h("div", { class: "fd-error" }, icon("warning"), h("div", {}, h("strong", {}, "The settings designer can't read this class"), h("p", {}, this.error), h("div", { class: "fd-error-actions" }, h("button", { type: "button", onclick: () => void this.load() }, icon("refresh"), "Try again")))));
      return;
    }
    if (this.info && !this.info.installed) {
      this.el.replaceChildren(h("div", { class: "fd-error" }, icon("package"), h("div", {}, h("strong", {}, "spatie/laravel-settings isn't installed"), h("p", {}, "Settings classes keep app-wide values, such as a tax rate, in the database. Tusk installs the package with Composer, with Filament's settings page plugin when the project has Filament, then publishes its migration and config and migrates."), h("div", { class: "fd-error-actions" }, h("button", { type: "button", class: "primary", onclick: () => void installSettings(() => void this.load()) }, icon("cloud-download"), "Install spatie/laravel-settings")))));
      return;
    }
    const s = this.spec!;
    const doc = this.outline;
    this.el.replaceChildren(
      h(
        "header",
        { class: "fd-header" },
        h("span", { class: "fd-header-icon" }, icon("settings")),
        h(
          "div",
          { class: "fd-header-titles" },
          h("h1", {}, this.file ? s.name : `New settings: ${s.name}`),
          h(
            "div",
            { class: "fd-header-chips" },
            h("span", { class: "fd-chip-static", title: "The group the values are stored under" }, `Group · ${s.group}`),
            this.file ? h("button", { type: "button", class: "fd-chip-link", onclick: () => host.openAt(this.file!, 1) }, icon("go-to-file"), "Open the code") : null,
            this.info?.installed && this.info.table === false ? h("button", { type: "button", class: "fd-chip-warn", title: "Run the migrations to create the settings table", onclick: () => void this.runMigrate() }, icon("warning"), "No settings table: migrate") : null,
            this.cls?.error ? h("span", { class: "fd-chip-warn", title: this.cls.error }, icon("warning"), "Can't read the stored values") : null,
            doc?.errors ? h("span", { class: "fd-chip-warn", title: "Fix the syntax errors to change the class." }, icon("warning"), "Syntax errors") : null,
          ),
        ),
      ),
      h(
        "div",
        { class: "md-body" },
        h("div", { class: "md-main" }, this.settingsCard(), this.propsCard(), this.codeCard(), this.pageCard()),
        h("aside", { class: "md-preview" }, h("nav", { class: "fd-tabs-nav md-preview-tabs" }, ...(["class", "migration"] as const).map((t) => h("button", { type: "button", class: this.previewTab === t ? "active" : "", onclick: () => ((this.previewTab = t), this.render()) }, t === "class" ? "Class" : "Migration"))), this.previewHost),
      ),
      this.footer(),
    );
    requestAnimationFrame(() => this.mountPreview());
  }

  private row(label: string, editor: HTMLElement, help?: string) {
    return h("div", { class: "fd-row", title: help ?? "" }, h("span", { class: "fd-row-label" }, label), h("div", { class: "fd-row-editor" }, editor), h("span", { class: "fd-row-spacer" }));
  }

  private settingsCard() {
    const s = this.spec!;
    const rows: HTMLElement[] = [];
    if (!this.file) {
      const name = commitInput(s.name, (v) => {
        const autoGroup = s.group === groupFor(s.name);
        s.name = v.trim().replace(/[^\w]/g, "");
        if (autoGroup) s.group = groupFor(s.name);
        this.render();
      }, { placeholder: "GeneralSettings", className: "fd-mono" });
      rows.push(this.row("Name", name, "A class name, such as GeneralSettings or ShopSettings."));
      rows.push(this.row("Namespace", commitInput(s.namespace, (v) => ((s.namespace = v.trim().replace(/^\\|\\$/g, "")), this.updatePreview()), { className: "fd-mono" }), "App\\Settings is where the package finds settings classes by default."));
    }
    const groupLocked = !!this.read && !this.read.groupReadable && !!this.read.cls.methods.find((m) => m.name === "group");
    rows.push(this.row("Group", groupLocked ? h("span", { class: "fd-faint ed-locked" }, "In code") : commitInput(s.group, (v) => ((s.group = propName(v) || s.group), this.render()), { className: "fd-mono" }), "Values are stored as group.property, such as general.tax_rate. Changing it renames them."));
    return h("section", { class: "fd-settings-section" }, h("h3", {}, icon("settings"), "Settings"), h("div", { class: "fd-rows md-rows" }, ...rows));
  }

  private casesOf(p: SettingProp): Stored[] {
    return this.enums.find((e) => e.class === p.cls)?.cases.map((c) => c.value ?? c.name) ?? [];
  }

  private propsCard() {
    const known = !this.file || !!this.cls?.values;
    const grid = "14px minmax(110px, 1fr) 130px minmax(110px, 0.9fr) 52px minmax(120px, 1.2fr) 24px 24px";
    const table = h("div", { class: "ed-cases", style: `--grid:${grid}` });
    table.append(h("div", { class: "ed-row ed-head" }, h("span", {}), h("span", {}, "Property"), h("span", {}, "Type"), h("span", {}, "Class"), h("span", { title: "Can be empty (null)" }, "Null"), h("span", { title: known ? "What the app stores now. Apply updates a changed value." : "The app's values couldn't be read." }, this.file ? "Stored value" : "First value"), h("span", {}), h("span", {})));
    this.rows.forEach((r, i) => table.append(this.propRow(r, i, known)));
    return h(
      "section",
      { class: "fd-settings-section" },
      h("h3", {}, icon("symbol-property"), "Properties", h("span", { class: "fd-spacer" }), h("button", { type: "button", class: "md-add", onclick: () => this.addProp() }, icon("add"), "Add property")),
      table,
      !this.rows.length ? h("p", { class: "fd-note ed-note" }, "Add a property for each value, such as tax_rate or site_name.") : null,
      this.rows.some((r) => r.original && !r.original.stored) ? h("p", { class: "fd-note ed-note" }, icon("info"), " Properties marked as not stored have no value in the database yet; Apply adds them with the value shown.") : null,
    );
  }

  addProp() {
    const n = this.rows.length + 1;
    this.rows.push({ id: nextId++, name: n === 1 ? "site_name" : `setting_${n}`, type: "string", nullable: false, value: "" });
    this.render();
    const inputs = this.el.querySelectorAll<HTMLInputElement>(".ed-name");
    inputs[inputs.length - 1]?.select();
  }

  private propRow(r: Row, i: number, known: boolean) {
    const name = h("input", { class: "ed-name fd-mono", value: r.name, spellcheck: false });
    name.oninput = () => ((r.name = propName(name.value)), this.updatePreview());
    name.onchange = () => this.render();
    name.onkeydown = (e) => e.key === "Enter" && (e.preventDefault(), this.addProp());
    const retype = (type: SettingType, cls?: string) => {
      r.type = type;
      r.cls = type === "date" ? (cls ?? DATE_CLASS) : type === "enum" ? (cls ?? this.enums[0]?.class) : undefined;
      if (r.value !== undefined) r.value = coerce(r.value, type, r.nullable, this.casesOf(r));
      this.render();
    };
    let typeCell: HTMLElement;
    let clsCell: HTMLElement;
    if (r.code) {
      typeCell = h("span", { class: "fd-faint ed-locked", title: "A type the designer doesn't write, kept as it is" }, "In code");
      clsCell = h("span", { class: "fd-mono fd-faint" }, r.code);
    } else {
      const type = h("select", {}, ...SETTING_TYPES.filter(([t]) => t !== "enum" || this.enums.length).map(([t, label]) => h("option", { value: t, textContent: label, selected: t === r.type })));
      type.onchange = () => retype(type.value as SettingType);
      typeCell = type;
      if (r.type === "enum") {
        const sel = h("select", {}, ...this.enums.map((e) => h("option", { value: e.class, textContent: shortClass(e.class), selected: e.class === r.cls })));
        sel.onchange = () => retype("enum", sel.value);
        clsCell = sel;
      } else clsCell = h("span", { class: "fd-mono fd-faint" }, r.type === "date" ? shortClass(r.cls ?? DATE_CLASS) : "");
    }
    const nullBox = h("input", { type: "checkbox", checked: r.nullable, disabled: !!r.code, title: "Can be empty (null)" });
    nullBox.onchange = () => {
      r.nullable = nullBox.checked;
      if (!r.nullable && r.value === null) r.value = defaultValue(r.type, false, this.casesOf(r));
      this.render();
    };
    const read = this.file ? readCode(`${this.spec!.namespace}\\${this.spec!.name}`, r.name).app : null;
    const row = h(
      "div",
      { class: `ed-row${r.original ? "" : " new"}${r.original && r.original.name !== r.name ? " renamed" : ""}`, draggable: true, title: r.original && r.original.name !== r.name ? `Renamed from ${r.original.name}` : "" },
      h("span", { class: "md-grip codicon codicon-gripper" }),
      name,
      typeCell,
      clsCell,
      nullBox,
      r.value === undefined || !known ? h("span", { class: "fd-faint ed-locked", title: "The app's values couldn't be read." }, "Unknown") : this.valueEditor(r),
      read ? iconButton("copy", `Copy ${read}`, () => void copy(read)) : h("span", {}),
      iconButton("trash", "Remove the property", () => (this.rows.splice(i, 1), this.render())),
    );
    if (r.original && !r.original.stored) row.title = "Not stored yet: Apply adds it with this value.";
    row.ondragstart = (e) => e.dataTransfer!.setData("text/plain", String(i));
    row.ondragover = (e) => e.preventDefault();
    row.ondrop = (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer!.getData("text/plain"));
      if (Number.isNaN(from) || from === i) return;
      const [moved] = this.rows.splice(from, 1);
      this.rows.splice(i, 0, moved);
      this.render();
    };
    return row;
  }

  /** The editor for a value, by its type. An empty field means null when the property can be null. */
  private valueEditor(r: Row): HTMLElement {
    const set = (v: Stored) => ((r.value = v), this.updatePreview());
    const orNull = (v: string, parse: (v: string) => Stored) => (v === "" && r.nullable ? null : parse(v));
    if (r.code) return h("span", { class: "fd-mono fd-faint", title: JSON.stringify(r.value) }, JSON.stringify(r.value));
    switch (r.type) {
      case "bool":
        return toggleSwitch(!!r.value, (on) => set(on));
      case "int":
      case "float":
        return commitInput(r.value === null ? "" : String(r.value), (v) => set(orNull(v, (x) => (r.type === "int" ? Math.trunc(Number(x)) : Number(x)) || 0)), { type: "number", placeholder: r.nullable ? "null" : "0" });
      case "enum": {
        const cases = this.casesOf(r);
        const sel = h("select", {}, ...(r.nullable ? [h("option", { value: "", textContent: "None" })] : []), ...cases.map((c) => h("option", { value: String(c), textContent: String(c), selected: c === r.value })));
        sel.onchange = () => set(sel.value === "" ? null : (cases.find((c) => String(c) === sel.value) ?? null));
        return sel;
      }
      case "date": {
        // Stored as an ISO 8601 date, such as 2026-10-01T09:00:00+00:00; the picker shows its local part.
        const input = h("input", { type: "datetime-local", value: typeof r.value === "string" ? r.value.slice(0, 16) : "" });
        input.onchange = () => set(input.value || null);
        return input;
      }
      case "array": {
        const input = commitInput(JSON.stringify(r.value ?? []), (v) => {
          try {
            set(orNull(v, (x) => JSON.parse(x) as Stored));
            input.classList.remove("invalid");
          } catch {
            input.classList.add("invalid");
            input.title = "A JSON list or object, such as [\"a\", \"b\"].";
          }
        }, { className: "fd-mono", placeholder: "[]" });
        return input;
      }
      default:
        return commitInput(r.value === null ? "" : String(r.value), (v) => set(orNull(v, (x) => x)), { placeholder: r.nullable ? "null" : "" });
    }
  }

  /** How app code reads a value. */
  private codeCard(): HTMLElement | null {
    const s = this.spec!;
    const first = this.rows[0];
    if (!this.file || !first) return null;
    const code = readCode(`${s.namespace}\\${s.name}`, first.name);
    const snippet = (label: string, text: string) => h("div", { class: "sd-snippet" }, h("div", { class: "sd-snippet-head" }, h("span", { class: "fd-note" }, label), iconButton("copy", "Copy", () => void copy(text))), h("pre", { class: "fd-code-preview" }, text));
    return h(
      "section",
      { class: "fd-settings-section" },
      h("h3", {}, icon("code"), "Read it in code"),
      snippet("Anywhere", code.app),
      snippet("Injected, in a controller, job, or command", code.inject),
      h("p", { class: "fd-note ed-note" }, "The copy button on each property copies its own line."),
    );
  }

  /** The Filament settings pages that edit this class, or a button to make one. */
  private pageCard(): HTMLElement | null {
    if (!this.file || !this.info?.installed) return null;
    const pages = this.cls?.pages ?? [];
    const body: HTMLElement[] = [];
    if (pages.length)
      for (const p of pages) body.push(h("div", { class: "fd-row" }, h("span", { class: "fd-row-label" }, shortClass(p.class)), h("div", { class: "fd-row-editor" }, h("button", { type: "button", class: "fd-chip-link", onclick: () => p.file && void openDesigner(`${this.root}/${p.file}`, "form") }, icon("edit"), "Design the form")), h("span", { class: "fd-row-spacer" })));
    else if (!this.info.plugin) body.push(h("p", { class: "fd-note ed-note" }, "Filament's settings page plugin isn't installed."), h("button", { type: "button", onclick: () => void installSettings(() => void this.load()) }, icon("cloud-download"), "Install the plugin"));
    else if (this.cls) body.push(h("p", { class: "fd-note ed-note" }, "A page in a panel where people change these values."), h("button", { type: "button", onclick: (e: MouseEvent) => void newSettingsPage(this.cls!.class, e.currentTarget as HTMLElement) }, icon("add"), "Make a settings page"));
    else body.push(h("p", { class: "fd-note ed-note" }, "Apply and migrate first, so the app knows the class."));
    return h("section", { class: "fd-settings-section" }, h("h3", {}, icon("window"), "Settings page"), ...body);
  }

  private footer() {
    const s = this.spec;
    const migrate = h("input", { type: "checkbox", checked: this.migrate });
    migrate.onchange = () => (this.migrate = migrate.checked);
    const page = this.cls?.pages[0];
    const fields = h("input", { type: "checkbox", checked: this.addFields });
    fields.onchange = () => (this.addFields = fields.checked);
    const apply = h("button", { type: "button", class: "primary md-apply", onclick: () => void this.apply() }, icon(this.file ? "check" : "add"), this.file ? "Apply changes" : "Create settings");
    return h(
      "footer",
      { class: "md-footer" },
      h("span", { class: "md-problems" }),
      h("span", { class: "fd-spacer" }),
      this.busy ? h("span", { class: "md-busy" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), this.busy) : null,
      page && s ? h("label", { title: `Adds a form field for each new property to ${shortClass(page.class)}` }, fields, `Add fields to ${shortClass(page.class)}`) : null,
      h("label", { class: "fd-check-label", title: "Runs php artisan migrate after writing the settings migration" }, migrate, "Run the migration"),
      apply,
    );
  }

  private mountPreview() {
    if (!this.previewHost.isConnected) return;
    this.preview ??= monaco.editor.create(this.previewHost, { language: "php", readOnly: true, minimap: { enabled: false }, lineNumbers: "off", scrollBeyondLastLine: false, fontSize: 12, automaticLayout: true, renderLineHighlight: "none", folding: false, padding: { top: 10 } });
    this.updatePreview();
  }

  private designed(): SettingsSpec {
    return { ...this.spec!, props: this.rows.map(({ id: _, ...p }) => p) };
  }

  private problems(): string[] {
    const s = this.spec!;
    const out: string[] = [];
    if (!/^[A-Z]\w*$/.test(s.name)) out.push("Give the settings a class name, such as GeneralSettings.");
    if (!s.group) out.push("Give the settings a group, such as general.");
    if (this.outline?.errors) out.push("The class has syntax errors. Fix them in the code first.");
    const names = this.rows.map((r) => r.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) out.push(`Two properties are named ${dup}.`);
    if (names.some((n) => !/^[a-z_]\w*$/i.test(n))) out.push("Every property needs a name, such as tax_rate.");
    if (this.rows.some((r) => r.type === "enum" && !r.cls)) out.push("Pick the enum of each enum property.");
    if (this.rows.some((r) => !r.nullable && r.value === null && (!r.original || !r.original.stored))) out.push("A property that can't be null needs a first value.");
    if (this.file && this.info?.installed && this.info.table === false) out.push("The settings table doesn't exist yet. Run the migrations first.");
    return out;
  }

  /** The class's code after Apply, its edits, and the settings migration. */
  private result(): { code: string; edits: Edit[] | null; migration: string | null } {
    const d = this.designed();
    const migration = settingsMigration(migrationLines(this.read?.spec ?? null, d));
    if (!this.file) return { code: settingsFile(d), edits: null, migration };
    const edits = mergeEdits(settingsEdits(this.text, this.outline!, this.read!, d));
    return { code: applyEdits(this.text, edits), edits, migration };
  }

  private updatePreview() {
    if (!this.spec || !this.preview) return;
    let code: string;
    try {
      const r = this.result();
      code = this.previewTab === "class" ? r.code : (r.migration ?? "<?php\n\n// Nothing changes in the database.\n");
    } catch (e) {
      code = `<?php\n\n// ${errorText(e)}\n`;
    }
    if (this.preview.getValue() !== code) this.preview.setValue(code);
    const problems = this.problems();
    const apply = this.el.querySelector<HTMLButtonElement>(".md-apply");
    if (apply) (apply.disabled = !!problems.length || !!this.busy), (apply.title = problems.join("\n"));
    const note = this.el.querySelector(".md-problems");
    if (note) note.textContent = problems[0] ?? "";
  }

  private setBusy(text: string) {
    this.busy = text;
    this.el.querySelector(".md-footer")?.replaceWith(this.footer());
    this.updatePreview();
  }

  private async runMigrate(reload = true) {
    this.setBusy("Running the migration…");
    try {
      await fapp.artisan(this.root, ["migrate", "--force"]);
    } catch (e) {
      showError("The migration failed. The files are written; fix the problem and run php artisan migrate", e);
    }
    fapp.forget(["app", "migrations"]);
    this.setBusy("");
    if (reload && this.file) await this.load();
  }

  async apply() {
    if (this.problems().length) return;
    const s = this.spec!;
    const root = this.root;
    const info = this.info?.installed ? this.info : null;
    try {
      this.setBusy("Writing the changes…");
      const { code, edits, migration } = this.result();
      const added = this.rows.filter((r) => !r.original && !r.code);
      let path = this.file;
      if (!path) {
        path = `${root}/${s.namespace.replace(/^App\\?/, "app/").replace(/\\/g, "/").replace(/\/$/, "")}/${s.name}.php`.replace("//", "/");
        if (await invoke<boolean>("path_exists", { path })) throw new Error(`${path.slice(root.length + 1)} already exists.`);
        await invoke("create_file", { path, contents: code });
        await this.register(path, `${s.namespace}\\${s.name}`);
      } else {
        const model = await host.ensureModel(path);
        if (model.getValue() !== this.text) throw new Error("The file changed since the designer read it. Reopen it to see the changes.");
        await applyTo(model, edits ?? []);
      }
      // A settings migration runs once, so each Apply writes a new one.
      if (migration) await invoke("create_file", { path: `${root}/${info?.migrationsPath ?? "database/settings"}/${migrationFileName(migrationName(s.group, !this.file))}`, contents: migration });
      if (this.file && this.addFields && added.length && this.cls?.pages[0]?.file) await addFields(`${root}/${this.cls.pages[0].file}`, `${s.namespace}\\${s.name}`, added);
      if (migration && this.migrate) await this.runMigrate(false);
      fapp.forget(["app", "migrations"]);
      host.status(this.file ? `Applied the changes to ${s.name}.` : `Created ${s.name}.`);
      this.setBusy("");
      if (!this.file) {
        closeView(this.el);
        openSettingsDesigner(path);
      } else await this.load();
    } catch (e) {
      this.setBusy("");
      showError("Can't write the settings", e);
    }
  }

  /**
   * Makes sure the package finds a new class: listed in config/settings.php when its folder isn't one the package
   * discovers, and not hidden by a cache of discovered classes made before it existed.
   */
  private async register(path: string, cls: string) {
    const root = this.root;
    const info = this.info?.installed ? this.info : null;
    const rel = path.slice(root.length + 1);
    if (info && !info.autoDiscover.some((d) => rel.startsWith(`${d}/`)) && !info.registered.includes(cls)) {
      const config = `${root}/config/settings.php`;
      if (!(await invoke<boolean>("path_exists", { path: config }))) return host.status(`Publish the package's config and list ${cls} in its settings.`);
      const model = await host.ensureModel(config);
      const edit = registerEdit(model.getValue(), cls);
      if (edit) await applyTo(model, [edit]);
    }
    if (await invoke<boolean>("path_exists", { path: `${root}/bootstrap/cache/settings.php` })) await fapp.artisan(root, ["settings:clear-discovered"]).catch(() => {});
  }
}

const copy = (text: string) => navigator.clipboard.writeText(text).then(() => host.status(`Copied ${text.split("\n")[0]}`), (e) => showError("Can't copy", e));
