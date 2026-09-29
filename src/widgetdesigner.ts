// The widget designer: a stats overview's cards or a chart's data, heading, and size, in an editor tab, changed in
// the widget's code as you go (src/widgetgen.ts), with a preview beside them. A table widget opens in the resource
// designer's table tab instead.
import { h, icon, iconButton } from "./dom";
import { editFiles, type FileBuild } from "./codeapply";
import { removeTraitEdits, traitsEdits } from "./usergen";
import { renderEntryAccess } from "./filamentaccess";
import * as fapp from "./filamentapp";
import { type Catalog, humanize } from "./filamentcatalog";
import { host } from "./filamentdesigner";
import { iconNameOf } from "./filamentinspector";
import { COLOR_SWATCH, colorChooser, commitInput, heroicon, pickHeroicon, toggleSwitch } from "./filamentpickers";
import { shortClass } from "./filamentschema";
import { addMember, type ArrayNode, type Edit, insertItem, methodNamed, removeMethod, moveItem, type OClass, type Outline, phpString, propertyNamed, removeItem, removeProperty, replaceNode, setProperty } from "./phpcode";
import { showEditorView } from "./terminal";
import {
  AGGS,
  type Agg,
  CHART_TYPES,
  chartDataCode,
  type Format,
  type Metric,
  metricCode,
  type Op,
  partColorEdits,
  readChartData,
  readStats,
  readValue,
  type Series,
  seriesEdits,
  statArgEdit,
  statCallEdit,
  statCode,
  type StatRead,
  trendCode,
  valueCode,
  TABLE,
  type Where,
} from "./widgetgen";

const PAGE_TABLE = "Filament\\Widgets\\Concerns\\InteractsWithPageTable";
const EXPOSES_TABLE = "Filament\\Pages\\Concerns\\ExposesTableToWidgets";

const open = new Map<string, WidgetDesigner>();
/** The colors the designer gives a pie's parts (PART_COLORS in src/widgetgen.ts). */
const PARTS = ["#f59e0b", "#3b82f6", "#10b981", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];
const HEROICON = "Filament\\Support\\Icons\\Heroicon";

/** Opens a widget file: stats and charts here, table widgets in the resource designer's table tab. */
export async function openWidget(file: string) {
  const model = await host.ensureModel(file);
  if (/extends\s+\w*TableWidget\b/.test(model.getValue())) return (await import("./filamentdesigner")).openDesigner(file, "table");
  let v = open.get(file);
  if (!v) open.set(file, (v = new WidgetDesigner(file)));
  v.show();
}

type Doc = { text: string; outline: Outline; cls: OClass };

class WidgetDesigner {
  el = h("div", { class: "md-designer wd-designer" });
  private doc: Doc | null = null;
  private models: Record<string, fapp.ModelSummary> = {};
  private cat: Catalog | null = null;
  private listening = false;
  /** The resource list page whose table the widget can follow, when it's a resource's widget. */
  private listPage: { class: string; file: string; model: string } | null = null;
  /** What the widget shows now, read after each change; an error says why it can't. */
  private live: (Awaited<ReturnType<typeof fapp.widgetData>> & { error?: undefined }) | { error: string } | null = null;
  private liveTimer = 0;
  private access: { info: (fapp.PolicyInfo & { shieldKey: string | null }) | null; error: string } = { info: null, error: "" };

  constructor(private file: string) {}

  private get root() {
    return host.root();
  }

  show() {
    showEditorView(`${this.file.split("/").pop()!.replace(/\.php$/, "")} · Widget`, this.el, "graph", () => open.delete(this.file));
    if (!this.doc) void this.load();
    this.render();
  }

  private async load() {
    const [models, cat, app] = await Promise.all([fapp.models(this.root).catch(() => ({})), fapp.catalog(this.root).catch(() => null), fapp.app(this.root).catch(() => null)]);
    this.models = models;
    this.cat = cat;
    await this.read();
    // A resource's widget, in its Widgets folder, can count what the resource's list page shows.
    const ns = this.doc?.cls.fqn.replace(/\\Widgets\\[^\\]+$/, "");
    const resource = !ns ? undefined : app?.panels.flatMap((p) => p.resources).find((r) => r.class.startsWith(`${ns}\\`) && r.class.slice(ns.length + 1).indexOf("\\") < 0);
    const list = resource?.pages.find((p) => p.kind === "list" || p.kind === "manage");
    this.listPage = resource && list?.file ? { class: list.class, file: `${this.root}/${list.file}`, model: resource.model } : null;
    this.render();
  }

  private async read() {
    const model = await host.ensureModel(this.file);
    if (!this.listening) {
      this.listening = true;
      model.onDidChangeContent(() => void this.read().then(() => this.el.isConnected && this.render()));
    }
    const text = model.getValue();
    const outline = await fapp.outlineOf(text, this.file);
    const cls = outline.classes.find((c) => c.name);
    this.doc = cls ? { text, outline, cls } : null;
    // The file is saved just after it changes, and the widget runs from the saved file.
    clearTimeout(this.liveTimer);
    if (cls && !outline.errors)
      this.liveTimer = window.setTimeout(() => {
        fapp.widgetData(this.root, cls.fqn).then(
          (live) => (this.live = live),
          (e) => (this.live = { error: e instanceof Error ? e.message : String(e) }),
        ).then(() => this.el.isConnected && this.render());
      }, 700);
  }

  /** Applies edits computed from the widget's current code. */
  private edit(build: (text: string, cls: OClass, outline: Outline) => Edit[], message: string) {
    return editFiles([{ path: this.file, build: (text, outline) => {
      const cls = outline.classes.find((c) => c.name);
      return cls ? build(text, cls, outline) : null;
    } }], message);
  }

  private get kind(): "stats" | "chart" | "other" {
    const ext = this.doc?.cls.extends ?? "";
    return /StatsOverviewWidget$/.test(ext) || methodNamed(this.doc!.cls, "getStats") ? "stats" : /ChartWidget$/.test(ext) || methodNamed(this.doc!.cls, "getData") ? "chart" : "other";
  }

  /** A class name as written in the widget, resolved through its imports. */
  private resolve(name: string): string {
    if (name === TABLE) return name;
    if (name.startsWith("\\")) return name.slice(1);
    const [first, ...rest] = name.split("\\");
    const use = this.doc?.outline.uses.find((u) => u.kind === "class" && u.alias.toLowerCase() === first.toLowerCase());
    if (use) return [use.name, ...rest].join("\\");
    return this.doc?.outline.namespace ? `${this.doc.outline.namespace}\\${name}` : name;
  }

  /** A metric with its model resolved, for writing back. */
  private full = (m: Metric): Metric => ({ ...m, model: this.resolve(m.model) });


  render() {
    const d = this.doc;
    const name = this.file.split("/").pop()!.replace(/\.php$/, "");
    const header = h(
      "header",
      { class: "fd-header" },
      h("span", { class: "fd-header-icon" }, icon("graph")),
      h("div", { class: "fd-header-titles" }, h("h1", {}, humanize(name)), h("div", { class: "fd-header-chips" }, h("span", { class: "fd-chip-static" }, d ? { stats: "Stats overview", chart: "Chart", other: "Widget" }[this.kind] : "Widget"), h("button", { type: "button", class: "fd-chip-link", onclick: () => host.openAt(this.file, 1) }, icon("go-to-file"), `${name}.php`))),
      h("span", { class: "fd-spacer" }),
    );
    if (!d) return void this.el.replaceChildren(header, h("div", { class: "fd-loading" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), "Reading the widget…"));
    if (d.outline.errors) return void this.el.replaceChildren(header, h("div", { class: "md-main" }, h("div", { class: "fd-helper-note fd-error-note" }, icon("warning"), h("span", {}, "The widget has syntax errors. Fix them to design it here."))));
    const main = h("div", { class: "md-main" }, this.settings(d));
    let preview: HTMLElement;
    if (this.kind === "stats") {
      const arr = this.statsArray(d);
      main.append(arr ? this.statsSection(d, arr) : this.codeNote(d, "getStats"));
      preview = this.statsPreview(d, arr);
    } else if (this.kind === "chart") {
      main.append(this.chartSection(d));
      preview = this.chartPreview(d);
    } else {
      main.append(h("p", { class: "fd-note" }, "A custom widget draws its own view. Open the code to change it."));
      preview = h("div");
    }
    main.append(this.accessSection(d));
    this.el.replaceChildren(header, h("div", { class: "md-body" }, main, h("aside", { class: "ps-preview" }, h("div", { class: "ps-preview-head" }, h("strong", {}, "Preview")), preview, this.liveNote())));
  }

  private liveNote(): HTMLElement {
    const l = this.live;
    if (!l) return h("p", { class: "fd-note" }, "Reading the numbers…");
    // Query exceptions carry the connection and the whole SQL; the first line says what went wrong.
    if (l.error !== undefined) return h("p", { class: "fd-note wd-live-error", title: l.error }, icon("warning"), `Showing examples: the widget fails when it runs: ${l.error.split("\n")[0].replace(/ \(Connection: .*$/s, "")}`);
    if (l.chart && !l.chart.datasets?.[0]?.data?.length) return h("p", { class: "fd-note" }, "There are no records yet, so the preview shows examples.");
    return h("p", { class: "fd-note" }, l.as ? `Real numbers, as ${l.as} sees them.` : "Real numbers from the database.");
  }

  /** Who can see the widget, as the resource designer's Access tab shows it. */
  private accessSection(d: Doc): HTMLElement {
    const load = async (fresh = false) => {
      if (fresh) fapp.forget([`policy:entry:${d.cls.fqn}`]);
      try {
        this.access = { info: await fapp.entryAccess(this.root, d.cls.fqn), error: "" };
      } catch (e) {
        this.access = { info: null, error: e instanceof Error ? e.message : String(e) };
      }
      this.render();
    };
    return h(
      "section",
      { class: "fd-settings-section wd-access" },
      renderEntryAccess({
        root: this.root,
        kind: "widget",
        fqn: d.cls.fqn,
        text: d.text,
        cls: d.cls,
        host,
        ...this.access,
        load: () => load(!!(this.access.info || this.access.error)),
        reveal: (offset) => this.reveal(offset),
        edit: (build, message) => editFiles([{ path: this.file, build: (text, outline, fill) => {
          const cls = outline.classes.find((c) => c.name);
          return cls ? build(text, cls, fill) : null;
        } }], message),
      }),
    );
  }

  private codeNote(d: Doc, method: string) {
    const m = methodNamed(d.cls, method);
    return h("section", { class: "fd-settings-section" }, h("p", { class: "fd-note" }, `${method}() does more than return its list, so the designer can't read it.`), m ? h("button", { type: "button", onclick: () => this.reveal(m.span[0]) }, icon("go-to-file"), "Open the code") : null);
  }

  private reveal(offset: number) {
    const lines = this.doc!.text.slice(0, offset).split("\n");
    host.openAt(this.file, lines.length, lines[lines.length - 1].length + 1);
  }

  // ---- Settings shared by all widgets ----

  private prop(d: Doc, name: string) {
    const p = propertyNamed(d.cls, name);
    return p ? { p, value: p.value?.kind === "string" ? p.value.value : p.value?.kind === "number" ? String(p.value.value) : p.value?.kind === "null" ? "" : p.value ? d.text.slice(p.value.span[0], p.value.span[1]) : "" } : null;
  }

  /** Sets a property's value, declared with `declaration` when the class doesn't have it; empty removes it. */
  private setProp(name: string, declaration: string, code: string | null, message: string) {
    return this.edit((text, cls) => {
      const p = propertyNamed(cls, name);
      if (code === null) return p ? [removeProperty(text, p)] : [];
      return [setProperty(text, cls, name, code, declaration)];
    }, message);
  }

  private settings(d: Doc): HTMLElement {
    const row = (label: string, editor: HTMLElement, set = false, hint = "") => h("div", { class: `fd-row${set ? " set" : ""}`, title: hint }, h("span", { class: "fd-row-label" }, label), h("div", { class: "fd-row-editor" }, editor), h("span", { class: "fd-row-spacer" }));
    const text = (name: string, label: string, hint = "") => {
      const v = this.prop(d, name);
      return row(label, commitInput(v?.value ?? "", (x) => void this.setProp(name, `protected ?string $${name}`, x.trim() ? phpString(x.trim()) : null, `${label}: ${x.trim() || "none"}`)), !!v?.value, hint);
    };
    const span = this.prop(d, "columnSpan");
    const spanSelect = h("select", {}, ...[["", "Default (one column)"], ["1", "One column"], ["2", "Two columns"], ["full", "Full width"]].map(([v, l]) => h("option", { value: v, textContent: l, selected: (span?.value ?? "") === v })));
    if (span && !["1", "2", "full", ""].includes(span.value)) spanSelect.append(h("option", { value: span.value, textContent: span.value, selected: true }));
    spanSelect.onchange = () => void this.setProp("columnSpan", "protected int | string | array $columnSpan", spanSelect.value ? (spanSelect.value === "full" ? "'full'" : spanSelect.value) : null, "Column span changed");
    const poll = this.prop(d, "pollingInterval");
    const pollSelect = h("select", {}, ...[["", this.kind === "stats" ? "Default (every 5s)" : "Default"], ["null", "Never"], ["10s", "Every 10 seconds"], ["30s", "Every 30 seconds"], ["60s", "Every minute"]].map(([v, l]) => h("option", { value: v, textContent: l, selected: (poll ? (poll.p.value?.kind === "null" ? "null" : poll.value) : "") === v })));
    pollSelect.onchange = () => void this.setProp("pollingInterval", "protected ?string $pollingInterval", pollSelect.value ? (pollSelect.value === "null" ? "null" : phpString(pollSelect.value)) : null, "Refresh changed");
    const rows = [text("heading", "Heading"), text("description", "Description"), row("Width", spanSelect, !!span), row("Refresh", pollSelect, !!poll, "How often the widget reads its numbers again")];
    if (this.listPage && this.kind !== "other") {
      const follows = this.follows(d);
      rows.push(row("Follows the table", toggleSwitch(follows, (on) => void this.follow(on)), follows, `Counts the records ${shortClass(this.listPage.class)} shows, with its filters and search.`));
    }
    if (this.kind === "chart") {
      const type = methodNamed(d.cls, "getType")?.returns[0];
      const current = type?.kind === "string" ? type.value : null;
      const typeSelect = h("select", {}, ...CHART_TYPES.map(([v, l]) => h("option", { value: v, textContent: l, selected: v === current })), ...(current && CHART_TYPES.some(([v]) => v === current) ? [] : [h("option", { value: "", textContent: current ?? "Code", selected: true, disabled: true })]));
      typeSelect.onchange = () => void this.edit((t, cls) => {
        const r = methodNamed(cls, "getType")?.returns[0];
        const data = methodNamed(cls, "getData")?.returns[0];
        return r ? [replaceNode(t, r, phpString(typeSelect.value)), ...(data?.kind === "array" ? partColorEdits(t, readChartData(data, t), typeSelect.value) : [])] : [];
      }, `Chart type: ${typeSelect.value}`);
      const color = this.prop(d, "color");
      rows.unshift(row("Type", typeSelect, true));
      rows.push(row("Color", colorChooser(color?.value || null, (c) => void this.setProp("color", "protected string $color", c ? phpString(c) : null, `Chart color: ${c ?? "default"}`)), !!color));
      const height = this.prop(d, "maxHeight");
      rows.push(row("Max height", commitInput(height?.value ?? "", (x) => void this.setProp("maxHeight", "protected ?string $maxHeight", x.trim() ? phpString(x.trim()) : null, "Max height changed"), { placeholder: "300px" }), !!height));
    }
    return h("section", { class: "fd-settings-section fd-settings" }, h("h3", {}, icon("settings"), "Widget"), h("div", { class: "fd-rows" }, ...rows));
  }

  private follows = (d: Doc) => d.cls.traits.some((t) => /(^|\\)InteractsWithPageTable$/.test(t));

  /**
   * Makes the widget count the list page's records, with its filters and search, or the model's again: the trait
   * and getTablePage() on the widget, ExposesTableToWidgets on the page, and each value the designer reads.
   */
  private async follow(on: boolean) {
    const page = this.listPage;
    if (!page) return;
    const model = (m: Metric): Metric => ({ ...m, model: on ? TABLE : page.model });
    const files: { path: string; build: FileBuild }[] = [
      {
        path: this.file,
        build: (text, outline) => {
          const cls = outline.classes.find((c) => c.name);
          if (!cls) return null;
          const edits: Edit[] = [];
          const getter = methodNamed(cls, "getTablePage");
          if (on) {
            edits.push(...traitsEdits(text, cls, [PAGE_TABLE]));
            if (!getter) edits.push(addMember(text, cls, `protected function getTablePage(): string\n{\n    return {{${page.class}}}::class;\n}`));
          } else {
            edits.push(...removeTraitEdits(text, cls, PAGE_TABLE));
            if (getter) edits.push(removeMethod(text, getter));
          }
          const stats = methodNamed(cls, "getStats")?.returns[0];
          if (stats?.kind === "array")
            for (const st of readStats(stats, text)) {
              const v = readValue(st.value ? text.slice(st.value.span[0], st.value.span[1]) : "");
              if (!v) continue;
              const m = model({ ...v.metric, model: v.metric.model === TABLE ? TABLE : this.resolve(v.metric.model) });
              edits.push(...statArgEdit(text, st, 1, valueCode(m, v.format)));
              if (st.trend === "designed") edits.push(...statCallEdit(text, st, "chart", trendCode(m)));
            }
          const data = methodNamed(cls, "getData")?.returns[0];
          if (data?.kind === "array") {
            const c = readChartData(data, text);
            if (c.series && c.datasets <= 1) edits.push(...seriesEdits(text, c, c.label?.text ?? "Records", { ...c.series, metric: model({ ...c.series.metric, model: this.resolve(c.series.metric.model) }) }));
          }
          return edits;
        },
      },
    ];
    if (on)
      files.push({ path: page.file, build: (text, outline) => {
        const cls = outline.classes.find((c) => c.name);
        return cls ? traitsEdits(text, cls, [EXPOSES_TABLE]) : null;
      } });
    await editFiles(files, on ? `Follows ${shortClass(page.class)}'s table` : "Counts the model's records");
  }

  // ---- Stats ----

  private statsArray(d: Doc): ArrayNode | null {
    const m = methodNamed(d.cls, "getStats");
    const r = m?.returns.length === 1 ? m.returns[0] : null;
    return r?.kind === "array" ? r : null;
  }

  private statsSection(d: Doc, arr: ArrayNode): HTMLElement {
    const stats = readStats(arr, d.text);
    const add = h("button", { type: "button", class: "md-add" }, icon("add"), "Add stat");
    const firstModel = Object.keys(this.models)[0] ?? null;
    add.onclick = () => {
      const m: Metric | null = firstModel ? { model: firstModel, agg: "count", column: null, where: [], days: null } : null;
      void this.edit((text, cls) => {
        const a = this.statsArray({ text, cls, outline: d.outline });
        return a ? [insertItem(text, a, a.items.length, statCode(m ? `${humanize(shortClass(m.model))}s` : "New stat", m ? metricCode(m) : "0"))] : [];
      }, "Added a stat");
    };
    const withStats = (build: (text: string, s: StatRead, a: ArrayNode) => Edit[], index: number, message: string) =>
      void this.edit((text, cls, outline) => {
        const a = this.statsArray({ text, cls, outline });
        const s = a && readStats(a, text)[index];
        return a && s ? build(text, s, a) : [];
      }, message);
    return h(
      "section",
      { class: "fd-settings-section" },
      h("h3", {}, icon("dashboard"), "Stats", h("span", { class: "fd-spacer" }), add),
      ...stats.map((s, i) => this.statCard(d, s, i, stats.length, withStats)),
      stats.length ? null : h("p", { class: "fd-note" }, "No stats yet. Add one to count or sum a model's records."),
    );
  }

  private statCard(d: Doc, s: StatRead, i: number, count: number, withStats: (build: (text: string, s: StatRead, a: ArrayNode) => Edit[], index: number, message: string) => void): HTMLElement {
    const tools = h(
      "div",
      { class: "fd-card-actions" },
      iconButton("arrow-up", "Move up", () => i > 0 && withStats((t, _s, a) => moveItem(t, a, i, i - 1), i, "Moved the stat")),
      iconButton("arrow-down", "Move down", () => i < count - 1 && withStats((t, _s, a) => moveItem(t, a, i, i + 2), i, "Moved the stat")),
      iconButton("trash", "Remove the stat", () => withStats((t, _s, a) => [removeItem(t, a, i)], i, "Removed the stat")),
    );
    if (!s.label) return h("div", { class: "wd-stat" }, h("div", { class: "wd-stat-head" }, h("button", { type: "button", class: "fd-code-chip", onclick: () => this.reveal(s.node.span[0]) }, icon("code"), h("span", {}, d.text.slice(s.node.span[0], s.node.span[1]).replace(/\s+/g, " ").slice(0, 70))), h("span", { class: "fd-spacer" }), tools));
    const row = (label: string, editor: HTMLElement | null) => (editor ? h("div", { class: "fd-row" }, h("span", { class: "fd-row-label" }, label), h("div", { class: "fd-row-editor" }, editor), h("span", { class: "fd-row-spacer" })) : null);
    const valueText = s.value ? d.text.slice(s.value.span[0], s.value.span[1]) : "";
    const value = readValue(valueText);
    const label = s.label;
    const setValue = (m: Metric, f: Format) =>
      withStats((t, st) => {
        const edits = statArgEdit(t, st, 1, valueCode(this.full(m), f));
        // A designed trend follows the value's records.
        if (st.trend === "designed") edits.push(...statCallEdit(t, st, "chart", trendCode(this.full(m))));
        return edits;
      }, i, `${label.text}: value changed`);
    let valueEditor: HTMLElement;
    if (value) {
      const format = h("select", {}, ...[["plain", "As it is"], ["number", "1,234"], ["abbreviate", "1.2K"], ["currency", "Money"]].map(([v, l]) => h("option", { value: v, textContent: l, selected: value.format.kind === v })));
      const currency = commitInput(value.format.kind === "currency" ? value.format.currency : "USD", (c) => setValue(value.metric, { kind: "currency", currency: c.trim().toUpperCase() || "USD" }), { className: "wd-currency" });
      currency.hidden = value.format.kind !== "currency";
      format.onchange = () => setValue(value.metric, format.value === "currency" ? { kind: "currency", currency: "USD" } : ({ kind: format.value } as Format));
      valueEditor = h("div", { class: "wd-value" }, this.metricEditor(value.metric, (m) => setValue(m, value.format), true), h("div", { class: "wd-format" }, h("span", { class: "fd-note" }, "Shown as"), format, currency));
    } else
      valueEditor = h(
        "div",
        { class: "wd-value" },
        h("button", { type: "button", class: "fd-code-chip", title: "Written as code. Open it to change it.", onclick: () => this.reveal(s.value?.span[0] ?? s.node.span[0]) }, icon("code"), h("span", {}, valueText.replace(/\s+/g, " ").slice(0, 60))),
        Object.keys(this.models).length ? h("button", { type: "button", class: "link", onclick: () => setValue({ model: Object.keys(this.models)[0], agg: "count", column: null, where: [], days: null }, { kind: "plain" }) }, "Replace with a count…") : null,
      );
    const iconBtn = h("button", { type: "button", class: "icon-button", title: "Choose an icon" }, s.descriptionIcon ? heroicon(this.cat?.heroiconsDir ?? null, iconNameOf(s.descriptionIcon)) : icon("circle-large-outline"));
    iconBtn.onclick = async () => {
      const chosen = await pickHeroicon(iconBtn, { dir: this.cat?.heroiconsDir ?? null, cases: this.cat?.heroicons ?? [], current: iconNameOf(s.descriptionIcon ?? undefined) });
      if (chosen !== null) withStats((t, st) => statCallEdit(t, st, "descriptionIcon", chosen ? `{{${HEROICON}}}::${chosen}` : null), i, `${label.text}: icon`);
    };
    const tr = (x: string) => (label.translated ? `__(${phpString(x)})` : phpString(x));
    return h(
      "div",
      { class: "wd-stat" },
      h("div", { class: "wd-stat-head" }, commitInput(label.text, (x) => x.trim() && withStats((t, st) => statArgEdit(t, st, 0, tr(x.trim())), i, `Renamed the stat to ${x.trim()}`), { className: "wd-stat-label" }), h("span", { class: "fd-spacer" }), tools),
      h(
        "div",
        { class: "fd-rows" },
        row("Value", valueEditor),
        row("Description", h("div", { class: "wd-inline" }, commitInput(s.description?.text ?? "", (x) => withStats((t, st) => statCallEdit(t, st, "description", x.trim() ? tr(x.trim()) : null), i, `${label.text}: description`), { placeholder: "Such as: 12% more than last month" }), iconBtn)),
        row("Color", colorChooser(s.color, (c) => withStats((t, st) => statCallEdit(t, st, "color", c ? phpString(c) : null), i, `${label.text}: color`))),
        row(
          "Trend",
          s.trend === "code"
            ? h("span", { class: "fd-note" }, "A chart written as code")
            : value
              ? h("div", { class: "wd-inline" }, toggleSwitch(s.trend === "designed", (on) => withStats((t, st) => statCallEdit(t, st, "chart", on ? trendCode(this.full(value.metric)) : null), i, `${label.text}: trend ${on ? "on" : "off"}`), "Trend"), h("span", { class: "fd-note" }, "The last 7 days, day by day"))
              : null,
        ),
      ),
    );
  }

  // ---- Metrics ----

  /** Edits a metric: which records (a model and filters), and what number: a count, or a column's sum or average. */
  private metricEditor(m: Metric, set: (m: Metric) => void, withDays: boolean): HTMLElement {
    const fqn = this.resolve(m.model);
    const info = this.models[fqn === TABLE ? (this.listPage?.model ?? "") : fqn];
    const columns = info ? Object.keys(info.columns) : [];
    const numeric = info ? columns.filter((c) => /int|dec|float|double|numeric|real|money/i.test(info.columns[c]?.type ?? "")) : [];
    const models = Object.keys(this.models);
    const modelSelect = h(
      "select",
      {},
      ...(this.listPage ? [h("option", { value: TABLE, textContent: "the table's records", selected: fqn === TABLE })] : []),
      ...models.map((c) => h("option", { value: c, textContent: shortClass(c), selected: c === fqn })),
      ...(models.includes(fqn) || fqn === TABLE ? [] : [h("option", { value: fqn, textContent: shortClass(fqn), selected: true })]),
    );
    modelSelect.onchange = () => set({ ...m, model: modelSelect.value, where: [], column: null, agg: "count" });
    const agg = h("select", {}, ...AGGS.map(([v, l]) => h("option", { value: v, textContent: l, selected: v === m.agg, disabled: v !== "count" && !numeric.length && m.column === null })));
    const column = h("select", {}, ...[...new Set([...(m.column ? [m.column] : []), ...numeric])].map((c) => h("option", { value: c, textContent: c, selected: c === m.column })));
    column.hidden = m.agg === "count";
    agg.onchange = () => set({ ...m, agg: agg.value as Agg, column: agg.value === "count" ? null : (m.column ?? numeric[0] ?? null) });
    column.onchange = () => set({ ...m, column: column.value });
    const days = h("select", {}, ...[["", "All time"], ["1", "Today"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["365", "Last year"]].map(([v, l]) => h("option", { value: v, textContent: l, selected: String(m.days ?? "") === v })));
    days.onchange = () => set({ ...m, days: days.value ? Number(days.value) : null });
    const wheres = m.where.map((w, j) => this.whereRow(w, columns, (next) => set({ ...m, where: next ? m.where.map((x, k) => (k === j ? next : x)) : m.where.filter((_, k) => k !== j) })));
    const addWhere = h("button", { type: "button", class: "link", textContent: "+ Only records where…" });
    addWhere.onclick = () => set({ ...m, where: [...m.where, { column: columns.find((c) => /status|state|type|active/.test(c)) ?? columns.find((c) => !/^(id|uuid|created_at|updated_at|deleted_at)$/.test(c)) ?? columns[0] ?? "id", op: "=", value: "" }] });
    return h("div", { class: "wd-metric" }, h("div", { class: "wd-inline" }, agg, column, h("span", { class: "fd-note" }, "of"), modelSelect, withDays ? days : null), ...wheres, columns.length ? addWhere : null);
  }

  private whereRow(w: Where, columns: string[], set: (w: Where | null) => void): HTMLElement {
    const col = h("select", {}, ...[...new Set([w.column, ...columns])].map((c) => h("option", { value: c, textContent: c, selected: c === w.column })));
    const ops: [Op | "null" | "notnull", string][] = [["=", "is"], ["!=", "is not"], [">", ">"], ["<", "<"], [">=", "≥"], ["<=", "≤"], ["null", "is empty"], ["notnull", "is not empty"]];
    const current = w.value === null ? (w.op === "!=" ? "notnull" : "null") : w.op;
    const op = h("select", {}, ...ops.map(([v, l]) => h("option", { value: v, textContent: l, selected: v === current })));
    const parse = (x: string) => (/^-?\d+(\.\d+)?$/.test(x.trim()) ? Number(x.trim()) : x.trim() === "true" || x.trim() === "false" ? x.trim() === "true" : x);
    const value = commitInput(w.value === null ? "" : String(w.value), (x) => set({ ...w, value: parse(x) }), { placeholder: "value" });
    value.hidden = w.value === null;
    col.onchange = () => set({ ...w, column: col.value });
    op.onchange = () => set(op.value === "null" || op.value === "notnull" ? { ...w, op: op.value === "null" ? "=" : "!=", value: null } : { ...w, op: op.value as Op, value: w.value ?? "" });
    return h("div", { class: "wd-inline wd-where" }, h("span", { class: "fd-note" }, "where"), col, op, value, iconButton("close", "Remove the condition", () => set(null)));
  }

  // ---- Charts ----

  private chartSection(d: Doc): HTMLElement {
    const m = methodNamed(d.cls, "getData");
    const arr = m?.returns.length === 1 && m.returns[0].kind === "array" ? m.returns[0] : null;
    if (!arr) return this.codeNote(d, "getData");
    const c = readChartData(arr, d.text);
    const models = Object.keys(this.models);
    const label = c.label?.text ?? this.prop(d, "heading")?.value ?? "Records";
    const write = (s: Series, l = label) =>
      void this.edit((text, cls) => {
        const r = methodNamed(cls, "getData")?.returns[0];
        if (r?.kind !== "array") return [];
        const cd = readChartData(r, text);
        const full = { ...s, metric: this.full(s.metric) };
        const edits = cd.datasets <= 1 ? seriesEdits(text, cd, l, full) : [];
        if (cd.label && l !== cd.label.text) edits.push(replaceNode(text, cd.label.node, phpString(l)));
        return edits;
      }, "Chart data changed");
    if (!c.series) {
      const start = models[0] ? () => void this.edit((text, cls) => {
        const r = methodNamed(cls, "getData")?.returns[0];
        return r?.kind === "array" ? [replaceNode(text, r, chartDataCode(label, { kind: "time", unit: "month", count: 12, metric: { model: models[0], agg: "count", column: null, where: [], days: null } }))] : [];
      }, "Chart data set up") : null;
      return h(
        "section",
        { class: "fd-settings-section" },
        h("h3", {}, icon("graph-line"), "Data"),
        h("p", { class: "fd-note" }, c.data ? "The chart's data is written as code." : "The chart has no data yet."),
        c.data ? h("button", { type: "button", class: "fd-code-chip", onclick: () => this.reveal(c.data!.span[0]) }, icon("code"), h("span", {}, d.text.slice(c.data.span[0], c.data.span[1]).replace(/\s+/g, " ").slice(0, 70))) : null,
        start ? h("button", { type: "button", class: "primary", onclick: start }, icon("add"), c.data ? "Replace with records over time" : "Chart records over time") : null,
      );
    }
    const s = c.series;
    const kind = h("select", {}, h("option", { value: "time", textContent: "Over time", selected: s.kind === "time" }), h("option", { value: "group", textContent: "By a column's values", selected: s.kind === "group" }));
    const info = this.models[this.resolve(s.metric.model)];
    const columns = info ? Object.keys(info.columns) : [];
    kind.onchange = () => write(kind.value === "time" ? { kind: "time", unit: "month", count: 12, metric: s.metric } : { kind: "group", column: columns.find((x) => /status|state|type/.test(x)) ?? columns[0] ?? "id", metric: s.metric });
    let by: HTMLElement;
    if (s.kind === "time") {
      const count = h("input", { type: "number", min: "2", max: "60", value: String(s.count), class: "wd-count" });
      count.onchange = () => write({ ...s, count: Math.max(2, Math.min(60, Number(count.value) || s.count)) });
      const unit = h("select", {}, ...[["day", "days"], ["week", "weeks"], ["month", "months"]].map(([v, l]) => h("option", { value: v, textContent: l, selected: v === s.unit })));
      unit.onchange = () => write({ ...s, unit: unit.value as "day" });
      by = h("div", { class: "wd-inline" }, h("span", { class: "fd-note" }, "The last"), count, unit, h("span", { class: "fd-note" }, "by when records were created"));
    } else {
      const col = h("select", {}, ...[...new Set([s.column, ...columns])].map((x) => h("option", { value: x, textContent: x, selected: x === s.column })));
      col.onchange = () => write({ ...s, column: col.value });
      by = h("div", { class: "wd-inline" }, h("span", { class: "fd-note" }, "One part for each"), col);
    }
    const row = (l: string, editor: HTMLElement) => h("div", { class: "fd-row" }, h("span", { class: "fd-row-label" }, l), h("div", { class: "fd-row-editor" }, editor), h("span", { class: "fd-row-spacer" }));
    return h(
      "section",
      { class: "fd-settings-section fd-settings" },
      h("h3", {}, icon("graph-line"), "Data"),
      h(
        "div",
        { class: "fd-rows" },
        row("Series label", commitInput(label, (x) => x.trim() && write(s, x.trim()))),
        row("Value", this.metricEditor(s.metric, (metric) => write({ ...s, metric: { ...metric, days: null } }), false)),
        row("Split", kind),
        row(s.kind === "time" ? "Period" : "Column", by),
      ),
      c.datasets > 1 ? h("p", { class: "fd-note" }, "The chart has more datasets, written as code. Only the first is shown here.") : null,
    );
  }

  // ---- Previews ----

  private statsPreview(d: Doc, arr: ArrayNode | null): HTMLElement {
    const stats = arr ? readStats(arr, d.text) : [];
    const sample = [128, 42, 1234, 9, 560];
    return h(
      "div",
      { class: "wd-stats" },
      ...stats.map((s, i) => {
        const v = readValue(s.value ? d.text.slice(s.value.span[0], s.value.span[1]) : "");
        const n = sample[i % sample.length];
        const real = this.live && this.live.error === undefined ? this.live.stats?.[i] : undefined;
        const shown = real?.value != null ? real.value : !v ? "…" : v.format.kind === "currency" ? new Intl.NumberFormat("en", { style: "currency", currency: v.format.currency }).format(n * 12.5) : v.format.kind === "abbreviate" ? `${(n / 100).toFixed(1)}K` : n.toLocaleString("en");
        const color = s.color ? (COLOR_SWATCH[s.color] ?? "#888") : null;
        return h(
          "div",
          { class: "wd-stat-card" },
          h("span", { class: "wd-stat-card-label" }, s.label?.text ?? "Stat"),
          h("strong", {}, shown),
          s.description || s.descriptionIcon ? h("span", { class: "wd-stat-card-desc", style: color ? `color:${color}` : "" }, s.description?.text ?? "", s.descriptionIcon ? heroicon(this.cat?.heroiconsDir ?? null, iconNameOf(s.descriptionIcon)) : null) : null,
          s.trend ? sparkline(color ?? "#888", i, real?.chart ?? undefined) : null,
        );
      }),
    );
  }

  private chartPreview(d: Doc): HTMLElement {
    const type = methodNamed(d.cls, "getType")?.returns[0];
    const t = type?.kind === "string" ? type.value : "line";
    const color = COLOR_SWATCH[this.prop(d, "color")?.value || "primary"] ?? "#f59e0b";
    const heading = this.prop(d, "heading")?.value;
    const real = this.live && this.live.error === undefined ? this.live.chart?.datasets?.[0]?.data?.map(Number).filter((x) => Number.isFinite(x)) : undefined;
    const values = real?.length ? real : [4, 7, 5, 9, 6, 11, 8, 12, 10, 14, 11, 15];
    const w = 300;
    const hgt = 150;
    const max = Math.max(...values, 1);
    let chart: string;
    if (t === "pie" || t === "doughnut" || t === "polarArea") {
      const total = values.reduce((a, b) => a + b, 0);
      const parts = real?.length && total ? values.map((v) => (v / total) * 100) : [40, 25, 20, 15];
      let a = 0;
      const arcs = parts.map((p, i) => {
        const start = a;
        a += (p / 100) * Math.PI * 2;
        const [x1, y1, x2, y2] = [75 + 60 * Math.sin(start), 75 - 60 * Math.cos(start), 75 + 60 * Math.sin(a), 75 - 60 * Math.cos(a)];
        return `<path d="M75 75 L${x1} ${y1} A60 60 0 ${p > 50 ? 1 : 0} 1 ${x2} ${y2} Z" fill="${PARTS[i % PARTS.length]}"/>`;
      });
      chart = `<svg viewBox="0 0 150 150" width="150" height="150">${arcs.join("")}${t === "doughnut" ? `<circle cx="75" cy="75" r="30" fill="var(--bg2)"/>` : ""}</svg>`;
    } else if (t === "bar") chart = `<svg viewBox="0 0 ${w} ${hgt}" width="100%">${values.map((v, i) => `<rect x="${(i * w) / values.length + 2}" y="${hgt - (v / max) * (hgt - 10)}" width="${w / values.length - 4}" height="${(v / max) * (hgt - 10)}" rx="2" fill="${color}"/>`).join("")}</svg>`;
    else {
      const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${hgt - (v / max) * (hgt - 10)}`).join(" ");
      chart = `<svg viewBox="0 0 ${w} ${hgt}" width="100%"><polygon points="0,${hgt} ${pts} ${w},${hgt}" fill="${color}" fill-opacity="0.12"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/></svg>`;
    }
    const box = h("div", { class: "wd-chart" }, heading ? h("strong", {}, heading) : null, h("div", { class: "wd-chart-svg" }));
    box.querySelector(".wd-chart-svg")!.innerHTML = chart;
    return box;
  }
}

/** A small sample trend line for a stat card. */
function sparkline(color: string, seed: number, real?: number[]): HTMLElement {
  const values = real?.length ? real.map(Number) : [3, 5, 4, 7, 6, 8, 7].map((v, i) => v + ((seed * 3 + i) % 4));
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * 100},${30 - (v / max) * 26}`).join(" ");
  const el = h("div", { class: "wd-spark" });
  el.innerHTML = `<svg viewBox="0 0 100 30" preserveAspectRatio="none"><polygon points="0,30 ${pts} 100,30" fill="${color}" fill-opacity="0.15"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
  return el;
}
