// A panel's dashboards: their widgets in a grid as the dashboard lays them out, to reorder, resize, hide, and add,
// and new widgets made from a model. A dashboard that lists its own widgets in getWidgets() changes that list; the
// panel's own dashboard orders widgets by their `$sort`, and hides one by turning its discovery off.
import { invoke } from "@tauri-apps/api/core";
import { editFiles, type FileBuild } from "./codeapply";
import { h, icon, iconButton } from "./dom";
import * as fapp from "./filamentapp";
import { humanize } from "./filamentcatalog";
import { host } from "./filamentdesigner";
import { inTableByDefault, renderGen, tableColumn } from "./filamentgen";
import { popover } from "./filamentpickers";
import { shortClass } from "./filamentschema";
import { panelChains, readPanelWidgets } from "./panelgen";
import { addMember, insertItem, methodNamed, moveItem, type OClass, propertyNamed, removeItem, removeProperty, replaceNode, setProperty } from "./phpcode";
import { showError } from "./status";
import { showEditorView } from "./terminal";
import { WIDGET_KINDS, type WidgetKind, widgetFile } from "./widgetgen";
import { isAbsolute } from "./platform.ts";

const open = new Map<string, DashboardDesigner>();

/** Opens a panel's dashboards. */
export function openDashboard(panelId: string) {
  let v = open.get(panelId);
  if (!v) open.set(panelId, (v = new DashboardDesigner(panelId)));
  v.show();
}

type Data = Awaited<ReturnType<typeof fapp.widgets>>;
const KIND_ICON: Record<fapp.WidgetInfo["kind"], string> = { stats: "dashboard", chart: "graph-line", table: "table", other: "symbol-misc" };

class DashboardDesigner {
  el = h("div", { class: "md-designer db-designer" });
  private data: Data | null = null;
  private panel: fapp.PanelInfo | null = null;
  private dashboard = 0;
  private error = "";

  constructor(private panelId: string) {}

  private get root() {
    return host.root();
  }

  show() {
    showEditorView(`${this.panelId} · Dashboard`, this.el, "dashboard", () => open.delete(this.panelId));
    void this.load();
    this.render();
  }

  private async load() {
    try {
      fapp.forget([`app:widgets:${this.panelId}`]);
      const [data, app] = await Promise.all([fapp.widgets(this.root, this.panelId), fapp.app(this.root)]);
      this.data = data;
      this.panel = app.panels.find((p) => p.id === this.panelId) ?? null;
      this.dashboard = Math.min(this.dashboard, Math.max(0, data.dashboards.length - 1));
      this.error = "";
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.render();
  }

  /** Applies edits, then reads the widgets again, since what changed lives in several files. */
  private async edit(files: { path: string; build: FileBuild }[], message: string) {
    if (await editFiles(files, message)) {
      fapp.forget(["app"]);
      await this.load();
    }
  }

  private abs = (file: string) => (isAbsolute(file) ? file : `${this.root}/${file}`);
  private inProject = (w: { file: string | null }) => !!w.file && !w.file.startsWith("vendor/");

  render() {
    const header = h(
      "header",
      { class: "fd-header" },
      h("span", { class: "fd-header-icon" }, icon("dashboard")),
      h("div", { class: "fd-header-titles" }, h("h1", {}, "Dashboard"), h("div", { class: "fd-header-chips" }, h("span", { class: "fd-chip-static" }, icon("window"), this.panelId))),
      h("span", { class: "fd-spacer" }),
      iconButton("refresh", "Read the widgets again", () => (fapp.forget(["app"]), void this.load())),
    );
    if (this.error) return void this.el.replaceChildren(header, h("div", { class: "fd-error" }, icon("warning"), h("div", {}, h("strong", {}, "Can't read the dashboard"), h("p", {}, this.error))));
    if (!this.data) return void this.el.replaceChildren(header, h("div", { class: "fd-loading" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), "Reading the widgets…"));
    const d = this.data.dashboards[this.dashboard];
    const own = d?.widgets ?? null;
    const widgets = own ?? this.data.widgets;
    const columns = typeof d?.columns === "number" ? d.columns : Number(Object.values(d?.columns ?? { md: 2 })[0]) || 2;
    const bar = h(
      "div",
      { class: "db-bar" },
      this.data.dashboards.length > 1
        ? h("select", { onchange: (e: Event) => ((this.dashboard = Number((e.target as HTMLSelectElement).value)), this.render()) }, ...this.data.dashboards.map((x, i) => h("option", { value: String(i), textContent: x.title ?? shortClass(x.class), selected: i === this.dashboard })))
        : h("strong", {}, d?.title ?? "Dashboard"),
      d?.file ? this.columnsSelect(d, columns) : null,
      h("span", { class: "fd-spacer" }),
      d?.file ? h("button", { type: "button", onclick: () => host.openAt(this.abs(d.file!), 1) }, icon("go-to-file"), shortClass(d.class)) : null,
      this.newButton(own !== null && !!d?.file),
    );
    const note = h("p", { class: "fd-note" }, own ? `${d.title ?? "This dashboard"} lists its own widgets, in this order.` : "The dashboard shows the panel's widgets, ordered by each widget's sort.");
    const grid = h("div", { class: "db-grid", style: `--cols:${columns}` }, ...widgets.map((w, i) => this.card(w, i, widgets, columns, own !== null)));
    const extra = own ? this.addExisting(widgets) : this.hiddenList();
    this.el.replaceChildren(header, h("div", { class: "db-main" }, bar, note, widgets.length ? grid : h("p", { class: "fd-note" }, "No widgets yet. Make one to show numbers, a chart, or the latest records."), extra));
  }

  private columnsSelect(d: Data["dashboards"][number], columns: number): HTMLElement {
    const sel = h("select", { title: "Columns" }, ...[1, 2, 3, 4, 6].map((n) => h("option", { value: String(n), textContent: `${n} column${n > 1 ? "s" : ""}`, selected: n === columns })));
    sel.onchange = () =>
      void this.edit([{ path: this.abs(d.file!), build: (text, outline) => {
        const cls = outline.classes.find((c) => c.name);
        if (!cls) return null;
        const m = methodNamed(cls, "getColumns");
        const r = m?.returns.length === 1 ? m.returns[0] : null;
        if (r) return [replaceNode(text, r, sel.value)];
        if (m) return null;
        return [addMember(text, cls, `public function getColumns(): int | array\n{\n    return ${sel.value};\n}`)];
      } }], `Dashboard columns: ${sel.value}`);
    return sel;
  }

  private span(w: fapp.WidgetInfo, columns: number): number {
    const s = w.columnSpan;
    if (s === "full") return columns;
    if (typeof s === "number") return Math.min(s, columns);
    if (s && typeof s === "object") return Math.min(Number(Object.values(s).at(-1)) || 1, columns);
    return 1;
  }

  private card(w: fapp.WidgetInfo, i: number, list: fapp.WidgetInfo[], columns: number, own: boolean): HTMLElement {
    const openIt = () => w.file && this.inProject(w) && void import("./widgetdesigner").then((m) => m.openWidget(this.abs(w.file!)));
    const spanSel = h("select", { title: "Width" }, ...[...Array.from({ length: columns }, (_, n) => [String(n + 1), n + 1 === columns ? `${n + 1} (full)` : String(n + 1)]), ["full", "Full"]].map(([v, l]) => h("option", { value: v, textContent: l, selected: v === String(w.columnSpan ?? 1) })));
    spanSel.disabled = !this.inProject(w);
    spanSel.onchange = () => void this.edit([{ path: this.abs(w.file!), build: (text, outline) => {
      const cls = outline.classes.find((c) => c.name);
      return cls ? [setProperty(text, cls, "columnSpan", spanSel.value === "full" ? "'full'" : spanSel.value, "protected int | string | array $columnSpan")] : null;
    } }], `${shortClass(w.class)}: width ${spanSel.value}`);
    return h(
      "div",
      { class: `db-card kind-${w.kind}`, style: `grid-column: span ${this.span(w, columns)}` },
      h(
        "div",
        { class: "db-card-head" },
        icon(KIND_ICON[w.kind]),
        h("button", { type: "button", class: "db-card-title", disabled: !this.inProject(w), title: this.inProject(w) ? "Design the widget" : "A widget from a package", onclick: openIt }, w.heading ?? humanize(shortClass(w.class).replace(/Widget$/, ""))),
        h("span", { class: "fd-spacer" }),
        iconButton("arrow-left", "Move earlier", () => i > 0 && void this.move(list, i, i - 1, own)),
        iconButton("arrow-right", "Move later", () => i < list.length - 1 && void this.move(list, i, i + 1, own)),
        iconButton("eye-closed", own ? "Remove from this dashboard" : "Hide from the dashboard", () => void this.hide(w, i, own)),
      ),
      h("div", { class: "db-card-body" }, this.sketch(w.kind)),
      h("div", { class: "db-card-foot" }, h("span", { class: "fd-note" }, shortClass(w.class)), h("span", { class: "fd-spacer" }), spanSel),
    );
  }

  /** A widget's shape, drawn small. */
  private sketch(kind: fapp.WidgetInfo["kind"]): HTMLElement {
    if (kind === "stats") return h("div", { class: "db-sketch-stats" }, h("i"), h("i"), h("i"));
    if (kind === "table") return h("div", { class: "db-sketch-table" }, h("i"), h("i"), h("i"), h("i"));
    if (kind === "chart") {
      const el = h("div", { class: "db-sketch-chart" });
      el.innerHTML = `<svg viewBox="0 0 100 30" preserveAspectRatio="none"><polyline points="0,24 15,18 30,20 45,11 60,14 75,6 100,9" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
      return el;
    }
    return h("div", { class: "db-sketch-other" }, icon("symbol-misc"));
  }

  private currentFile(): string | null {
    const f = this.data?.dashboards[this.dashboard]?.file;
    return f ? this.abs(f) : null;
  }

  /** The dashboard's `getWidgets()` array, from its class. */
  private ownArray(cls: OClass) {
    const m = methodNamed(cls, "getWidgets");
    const r = m?.returns.length === 1 ? m.returns[0] : null;
    return r?.kind === "array" ? r : null;
  }

  private async move(list: fapp.WidgetInfo[], from: number, to: number, own: boolean) {
    if (own) {
      const path = this.currentFile();
      if (!path) return;
      return this.edit([{ path, build: (text, outline) => {
        const cls = outline.classes.find((c) => c.name);
        const arr = cls && this.ownArray(cls);
        return arr ? moveItem(text, arr, from, to > from ? to + 1 : to) : null;
      } }], "Moved the widget");
    }
    // The panel's dashboard: the widgets in the project get sorts in their new order; packages' widgets keep theirs.
    const order = [...list];
    order.splice(to, 0, order.splice(from, 1)[0]);
    const floor = Math.max(0, ...order.filter((w) => !this.inProject(w)).map((w) => w.sort ?? 0));
    const files = order
      .map((w, i) => ({ w, sort: floor + i + 1 }))
      .filter(({ w }) => this.inProject(w))
      .map(({ w, sort }) => ({ path: this.abs(w.file!), build: ((text, outline) => {
        const cls = outline.classes.find((c) => c.name);
        return cls && propertyValue(cls, "sort") !== sort ? [setProperty(text, cls, "sort", String(sort), "protected static ?int $sort")] : null;
      }) as FileBuild }));
    return this.edit(files, "Moved the widget");
  }

  private async hide(w: fapp.WidgetInfo, i: number, own: boolean) {
    if (own) {
      const path = this.currentFile();
      if (path)
        await this.edit([{ path, build: (text, outline) => {
          const cls = outline.classes.find((c) => c.name);
          const arr = cls && this.ownArray(cls);
          return arr ? [removeItem(text, arr, i)] : null;
        } }], `Removed ${shortClass(w.class)} from the dashboard`);
      return;
    }
    // Registered in the panel provider: removed there. Discovered: its discovery turns off.
    const provider = this.panel?.provider?.file;
    if (provider) {
      const path = this.abs(provider);
      const model = await host.ensureModel(path);
      const outline = await fapp.outlineOf(model.getValue(), path);
      const method = outline.classes.find((c) => c.name) && methodNamed(outline.classes.find((c) => c.name)!, "panel");
      if (method && readPanelWidgets(model.getValue(), panelChains(method)).some((x) => x.class === w.class))
        return this.edit([{ path, build: (text, o) => {
          const m = methodNamed(o.classes.find((c) => c.name)!, "panel");
          return m ? (readPanelWidgets(text, panelChains(m)).find((x) => x.class === w.class)?.remove() ?? null) : null;
        } }], `Removed ${shortClass(w.class)} from the panel`);
    }
    if (!this.inProject(w)) return host.status(`${shortClass(w.class)} comes from a package, and the panel doesn't list it.`);
    return this.edit([{ path: this.abs(w.file!), build: (text, outline) => {
      const cls = outline.classes.find((c) => c.name);
      return cls ? [setProperty(text, cls, "isDiscovered", "false", "protected static bool $isDiscovered")] : null;
    } }], `Hid ${shortClass(w.class)} from the dashboard`);
  }

  private hiddenList(): HTMLElement | null {
    const hidden = this.data?.hidden ?? [];
    if (!hidden.length) return null;
    return h(
      "section",
      { class: "db-hidden" },
      h("strong", {}, "Hidden widgets"),
      ...hidden.map((w) =>
        h("button", { type: "button", class: "db-chip", title: "Show it on the dashboard again", onclick: () => void this.edit([{ path: this.abs(w.file!), build: (text, outline) => {
          const cls = outline.classes.find((c) => c.name);
          const p = cls && propertyNamed(cls, "isDiscovered");
          return p ? [removeProperty(text, p)] : null;
        } }], `${shortClass(w.class)} shows on the dashboard`) }, icon("eye"), w.heading ?? humanize(shortClass(w.class))),
      ),
    );
  }

  /** For a dashboard with its own list: the panel's other widgets, to add. */
  private addExisting(list: fapp.WidgetInfo[]): HTMLElement | null {
    const others = [...(this.data?.widgets ?? []), ...(this.data?.hidden ?? [])].filter((w, i, all) => !list.some((x) => x.class === w.class) && all.findIndex((x) => x.class === w.class) === i);
    const path = this.currentFile();
    if (!others.length || !path) return null;
    const sel = h("select", {}, h("option", { value: "", textContent: "Add a widget…" }), ...others.map((w) => h("option", { value: w.class, textContent: w.heading ?? humanize(shortClass(w.class)) })));
    sel.onchange = () => sel.value && void this.edit([{ path, build: (text, outline) => {
      const cls = outline.classes.find((c) => c.name);
      const arr = cls && this.ownArray(cls);
      return arr ? [insertItem(text, arr, arr.items.length, `{{${sel.value}}}::class`)] : null;
    } }], `Added ${shortClass(sel.value)}`);
    return h("section", { class: "db-hidden" }, sel);
  }

  private newButton(addToOwn: boolean): HTMLElement {
    const b = h("button", { type: "button", class: "primary" }, icon("add"), "New widget");
    b.onclick = () => void this.newWidget(b, addToOwn);
    return b;
  }
  /** Asks for a new widget, writes it in the panel's widgets folder, adds it to a dashboard that lists its own, and opens it. */
  private async newWidget(anchor: HTMLElement, addToOwn: boolean) {
    const dir = this.panel?.widgetDirs[0];
    const ns = this.panel?.widgetNamespaces[0];
    if (!dir || !ns) return host.status("The panel doesn't discover widgets in a folder. Add ->discoverWidgets() to its provider.");
    const made = await askNewWidget(anchor, { dir: this.abs(dir), namespace: ns });
    if (!made) return;
    const d = this.data?.dashboards[this.dashboard];
    if (addToOwn && d?.file)
      await editFiles([{ path: this.abs(d.file), build: (text, outline) => {
        const cls = outline.classes.find((c) => c.name);
        const arr = cls && this.ownArray(cls);
        return arr ? [insertItem(text, arr, arr.items.length, `{{${made.fqn}}}::class`)] : null;
      } }], `Added ${shortClass(made.fqn)} to the dashboard`);
    await this.load();
    void import("./widgetdesigner").then((w) => w.openWidget(made.path));
  }
}

/**
 * Asks for a new widget's kind, class name, and the model its records come from, and writes its file in `dir`.
 * Resolves to the new class and file, or null when canceled.
 */
export function askNewWidget(anchor: HTMLElement, o: { dir: string; namespace: string; model?: string | null }): Promise<{ fqn: string; path: string } | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { fqn: string; path: string } | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let kind: WidgetKind = "stats";
    const name = h("input", { placeholder: "OrdersOverview", spellcheck: false });
    const model = h("select", {}, h("option", { value: "", textContent: "No model" }));
    void fapp.models(host.root()).then((all) => {
      for (const m of Object.keys(all)) model.append(h("option", { value: m, textContent: shortClass(m), selected: m === o.model }));
    }, () => {});
    const problem = h("p", { class: "fd-ask-problem" });
    const kinds = h("div", { class: "db-kinds" });
    const drawKinds = () => kinds.replaceChildren(...WIDGET_KINDS.map(([k, label, hint]) => h("button", { type: "button", class: `db-kind${k === kind ? " selected" : ""}`, title: hint, onclick: () => ((kind = k), drawKinds()) }, icon(KIND_ICON[k]), label)));
    drawKinds();
    const create = async () => {
      const n = name.value.trim().replace(/\.php$/, "");
      if (!/^[A-Z][A-Za-z0-9]*$/.test(n)) return void (problem.textContent = "A class name, such as OrdersOverview.");
      const path = `${o.dir}/${n}.php`;
      if (await invoke<boolean>("path_exists", { path })) return void (problem.textContent = `${n}.php already exists.`);
      const m = model.value || null;
      try {
        let columns: string[] = [];
        if (kind === "table" && m) {
          const facts = await fapp.modelFacts(host.root(), m);
          columns = facts.columns.filter((c) => inTableByDefault(c, facts) && c.name !== "id").slice(0, 5).map((c) => renderGen(tableColumn(c, facts), (fqn) => `{{${fqn}}}`));
        }
        const label = m ? `${humanize(shortClass(m))}s` : humanize(n);
        await invoke("create_file", { path, contents: widgetFile({ kind, namespace: o.namespace, name: n, model: m, label, columns }) });
        fapp.forget(["app"]);
        host.status(`Created ${n}.`);
        finish({ fqn: `${o.namespace}\\${n}`, path });
        p.close();
      } catch (e) {
        showError("Can't create the widget", e);
      }
    };
    name.onkeydown = (e) => e.key === "Enter" && void create();
    const p = popover(
      anchor,
      h(
        "div",
        { class: "fd-ask db-new" },
        h("label", { class: "fd-ask-title" }, "New widget"),
        kinds,
        h("label", { class: "fd-note" }, "Class name"),
        name,
        h("label", { class: "fd-note" }, "Records from"),
        model,
        problem,
        h("div", { class: "fd-ask-buttons" }, h("button", { type: "button", textContent: "Cancel", onclick: () => p.close() }), h("button", { type: "button", class: "primary", textContent: "Create", onclick: () => void create() })),
      ),
      () => finish(null),
    );
    requestAnimationFrame(() => name.focus());
  });
}

const propertyValue = (cls: OClass, name: string) => {
  const v = propertyNamed(cls, name)?.value;
  return v?.kind === "number" ? v.value : null;
};
