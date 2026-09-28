// A panel's settings, in an editor tab of its own: its brand, colors, sign-in pages, layout, navigation groups,
// plugins, and tenancy, read from the panel provider's `panel()` and changed there (src/panelgen.ts), with a preview
// of the panel beside them. Each change is saved at once, as in the other designers.
import type * as L from "vscode-languageserver-protocol";
import { h, icon, iconButton } from "./dom";
import * as fapp from "./filamentapp";
import type { Catalog } from "./filamentcatalog";
import { type Doc, host } from "./filamentdesigner";
import { askName, commitInput, heroicon, pickHeroicon, toggleSwitch } from "./filamentpickers";
import { shortClass } from "./filamentschema";
import { applyWorkspaceEdit } from "./lsp";
import {
  addNavGroupEdits,
  addPluginEdits,
  changeNavGroupEdits,
  COLOR_ROLES,
  colorEdits,
  moveNavGroupEdits,
  panelChains,
  type PanelCode,
  readColors,
  readNavGroups,
  readPlugins,
  readSetting,
  readTenant,
  removeNavGroupEdits,
  SETTINGS,
  type Setting,
  settingEdits,
  tenantEdits,
  WIDTHS,
} from "./panelgen";
import { iconNameOf } from "./filamentinspector";
import { droppedImports, type Edit, Imports, mergeEdits, methodNamed, type PNode } from "./phpcode";
import { showError } from "./status";
import { showEditorView } from "./terminal";

export type PanelOptions = { palettes: Record<string, string>; plugins: { class: string; package: string; description: string | null }[]; appName: string | null; user: { class: string; file: string | null; hasTenants: boolean; filamentUser: boolean } | null };

const open = new Map<string, PanelSettings>();

/** Opens a panel's settings, by its provider's file. */
export function openPanelSettings(file: string, panelId: string) {
  let v = open.get(file);
  if (!v) open.set(file, (v = new PanelSettings(file, panelId)));
  v.show();
}

const HEROICON = "Filament\\Support\\Icons\\Heroicon";

class PanelSettings {
  el = h("div", { class: "md-designer ps-designer" });
  private doc: Doc | null = null;
  private options: PanelOptions | null = null;
  private cat: Catalog | null = null;
  private app: fapp.AppInfo | null = null;
  private models: string[] = [];
  private error = "";
  private pending: Promise<unknown> = Promise.resolve();
  private listening = false;
  private darkPreview = false;

  constructor(
    private file: string,
    private panelId: string,
  ) {}

  private get root() {
    return host.root();
  }

  show() {
    showEditorView(`${this.panelId} panel · Settings`, this.el, "settings-gear", () => open.delete(this.file));
    if (!this.doc) void this.load();
    this.render();
  }

  private async load() {
    try {
      const [options, cat, app, models] = await Promise.all([
        fapp.panelOptions(this.root).catch(() => null),
        fapp.catalog(this.root).catch(() => null),
        fapp.app(this.root).catch(() => null),
        fapp.models(this.root).catch(() => ({})),
      ]);
      Object.assign(this, { options, cat, app, models: Object.keys(models) });
      await this.read();
      this.error = "";
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.render();
  }

  private async read() {
    const model = await host.ensureModel(this.file);
    if (!this.listening) {
      this.listening = true;
      model.onDidChangeContent(() => void this.read().then(() => this.el.isConnected && this.render()));
    }
    const text = model.getValue();
    this.doc = { path: this.file, model, text, outline: await fapp.outlineOf(text, this.file) };
  }

  /** Applies edits to the provider, against the text they were computed from, with imports added. */
  private apply(build: (text: string, code: PanelCode) => Edit[], message: string) {
    const run = this.pending.then(async () => {
      const doc = this.doc;
      const code = this.code();
      if (!doc || !code) return;
      if (doc.model.getValue() !== doc.text) return;
      if (doc.outline.errors) return host.status("Fix the syntax errors in the provider first.");
      const imports = new Imports(doc.text, doc.outline);
      const fill = (c: string) => c.replace(/\{\{([\w\\]+)\}\}/g, (_, fqn: string) => imports.name(fqn));
      const edits = build(doc.text, code).map((e) => ({ ...e, text: fill(e.text) }));
      if (!edits.length) return;
      const added = [...edits, ...imports.edits()];
      const all = mergeEdits([...added, ...droppedImports(doc.text, doc.outline, added)]);
      const pos = (o: number) => {
        const p = doc.model.getPositionAt(o);
        return { line: p.lineNumber - 1, character: p.column - 1 };
      };
      await applyWorkspaceEdit({ changes: { [doc.model.uri.toString()]: all.map((e): L.TextEdit => ({ range: { start: pos(e.start), end: pos(e.end) }, newText: e.text })) } });
      host.status(message);
    });
    this.pending = run.catch((e) => showError("Can't change the panel", e));
    return run;
  }

  private code(): PanelCode | null {
    const cls = this.doc?.outline.classes.find((c) => c.name);
    const method = cls && methodNamed(cls, "panel");
    return method ? panelChains(method) : null;
  }

  private reveal(offset: number) {
    const p = this.doc!.model.getPositionAt(offset);
    host.openAt(this.file, p.lineNumber, p.column);
  }

  render() {
    const header = h(
      "header",
      { class: "fd-header" },
      h("span", { class: "fd-header-icon" }, icon("window")),
      h("div", { class: "fd-header-titles" }, h("h1", {}, `${this.panelId} panel`), h("div", { class: "fd-header-chips" }, h("button", { type: "button", class: "fd-chip-link", onclick: () => host.openAt(this.file, 1) }, icon("go-to-file"), this.file.split("/").pop()!))),
      h("span", { class: "fd-spacer" }),
      iconButton("refresh", "Read the panel again", () => (fapp.forget(["panel-options", "app"]), void this.load())),
    );
    if (this.error) return void this.el.replaceChildren(header, h("div", { class: "fd-error" }, icon("warning"), h("div", {}, h("strong", {}, "Can't read the panel"), h("p", {}, this.error))));
    const code = this.code();
    if (!this.doc) return void this.el.replaceChildren(header, h("div", { class: "fd-loading" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), "Reading the panel…"));
    if (!code?.main)
      return void this.el.replaceChildren(
        header,
        h("div", { class: "md-main" }, h("p", { class: "fd-note" }, "The designer reads the calls on $panel in the provider's panel() method, and there are none it can read. Open the code to change the panel."), h("button", { type: "button", onclick: () => host.openAt(this.file, 1) }, icon("go-to-file"), "Open the code")),
      );
    const text = this.doc.text;
    const groups = [...new Set(SETTINGS.map((s) => s.group))];
    const main = h(
      "div",
      { class: "md-main" },
      this.doc.outline.errors ? h("div", { class: "fd-helper-note fd-error-note" }, icon("warning"), h("span", {}, "The provider has syntax errors. Fix them to change it here.")) : null,
      ...groups.flatMap((g) => [this.section(g, text, code), ...(g === "Brand" ? [this.colors(text, code)] : [])]),
      this.navGroups(text, code),
      this.plugins(text, code),
      this.tenancy(text, code),
    );
    this.el.replaceChildren(header, h("div", { class: "md-body" }, main, this.preview(text, code)));
  }

  private section(group: string, text: string, code: PanelCode): HTMLElement {
    const icons: Record<string, string> = { Panel: "window", Brand: "symbol-color", "Sign-in": "account", Layout: "layout", Features: "extensions" };
    return h("section", { class: "fd-settings-section fd-settings" }, h("h3", {}, icon(icons[group] ?? "settings"), group), h("div", { class: "fd-rows" }, ...SETTINGS.filter((s) => s.group === group).map((s) => this.row(s, text, code))));
  }

  private row(s: Setting, text: string, code: PanelCode): HTMLElement {
    const v = readSetting(text, code, s);
    const set = (value: string | boolean) => void this.apply((t, c) => settingEdits(t, c, s, value), `${s.label}: ${value === true ? "on" : value === false ? "off" : value || "default"}`);
    let editor: HTMLElement;
    if (v.code !== undefined) editor = h("button", { type: "button", class: "fd-code-chip", title: "Written as code. Open it to change it.", onclick: () => this.reveal(text.indexOf(v.code!)) }, icon("code"), h("span", {}, v.code.length > 60 ? `${v.code.slice(0, 59)}…` : v.code));
    else if (s.kind === "flag") editor = toggleSwitch(v.value as boolean, set, s.label);
    else if (s.kind === "width") editor = h("select", { onchange: (e: Event) => set((e.target as HTMLSelectElement).value) }, ...WIDTHS.map(([w, l]) => h("option", { value: w, textContent: l, selected: w === v.value })));
    else editor = commitInput(String(v.value), (x) => set(x.trim()), { placeholder: s.call === "brandName" ? (this.options?.appName ?? "") : (s.placeholder ?? "") });
    const set_ = s.kind === "flag" ? v.value !== !!s.on : v.value !== "" || v.code !== undefined;
    return h("div", { class: `fd-row${set_ ? " set" : ""}`, title: s.hint ?? "" }, h("span", { class: "fd-row-label" }, s.label), h("div", { class: "fd-row-editor" }, editor), h("span", { class: "fd-row-spacer" }));
  }

  private colors(text: string, code: PanelCode): HTMLElement {
    const { roles, call, arr } = readColors(text, code);
    const palettes = Object.keys(this.options?.palettes ?? {});
    const rows = COLOR_ROLES.map(([role, label, def]) => {
      const at = roles.get(role);
      const c = at?.color;
      const set = (color: Parameters<typeof colorEdits>[3]) => void this.apply((t, pc) => colorEdits(t, pc, role, color), `${label} color: ${color ? (color.kind === "palette" ? color.name : color.hex) : "default"}`);
      let editor: HTMLElement;
      if (c?.kind === "code") editor = h("button", { type: "button", class: "fd-code-chip", title: "Written as code, such as custom shades. Open it to change it.", onclick: () => this.reveal(text.indexOf(c.code)) }, icon("code"), h("span", {}, c.code.replace(/\s+/g, " ").slice(0, 50)));
      else {
        const select = h(
          "select",
          {},
          h("option", { value: "", textContent: `Default (${def})`, selected: !c }),
          ...palettes.map((p) => h("option", { value: p, textContent: p, selected: c?.kind === "palette" && c.name === p })),
          h("option", { value: "#", textContent: "Custom…", selected: c?.kind === "hex" }),
        );
        const picker = h("input", { type: "color", value: c?.kind === "hex" && /^#[0-9a-f]{6}$/i.test(c.hex) ? c.hex : "#6366f1", title: "Pick a color" });
        picker.hidden = c?.kind !== "hex";
        select.onchange = () => (select.value === "#" ? ((picker.hidden = false), picker.click()) : set(select.value ? { kind: "palette", name: select.value } : null));
        picker.onchange = () => set({ kind: "hex", hex: picker.value });
        editor = h("div", { class: "ps-color" }, h("span", { class: "ps-swatch", style: `--swatch:${this.colorCss(role, text, code)}` }), select, picker);
      }
      return h("div", { class: `fd-row${at ? " set" : ""}` }, h("span", { class: "fd-row-label" }, label), h("div", { class: "fd-row-editor" }, editor), h("span", { class: "fd-row-spacer" }));
    });
    const other = call && !arr ? h("p", { class: "fd-note" }, "The colors come from code the designer can't read.") : null;
    return h("section", { class: "fd-settings-section fd-settings" }, h("h3", {}, icon("paintcan"), "Colors"), other, h("div", { class: "fd-rows" }, ...rows));
  }

  /** A role's color as CSS, for swatches and the preview. */
  private colorCss(role: string, text: string, code: PanelCode): string {
    const c = readColors(text, code).roles.get(role)?.color;
    const pal = this.options?.palettes ?? {};
    const def = COLOR_ROLES.find((r) => r[0] === role)?.[2] ?? "Gray";
    if (c?.kind === "hex") return c.hex;
    if (c?.kind === "palette") return pal[c.name] ?? "#888";
    if (c?.kind === "code") return /'#([0-9a-f]{6})'[^\n]*base/i.exec(c.code)?.[0].slice(1, 8) ?? /500\s*=>\s*'([^']+)'/.exec(c.code)?.[1] ?? pal[def] ?? "#888";
    return pal[def] ?? "#888";
  }

  private navGroups(text: string, code: PanelCode): HTMLElement {
    const { groups, code: other } = readNavGroups(text, code);
    const panel = this.app?.panels.find((p) => p.id === this.panelId);
    const used = [...new Set((panel?.resources ?? []).map((r) => r.navigationGroup).filter((g): g is string => !!g))];
    const labels = new Set(groups.map((g) => g.label));
    const dir = this.cat?.heroiconsDir ?? null;
    const iconName = (n: PNode | null) => iconNameOf(n ?? undefined);
    const list = groups.map((g, i) => {
      const hasIcons = (panel?.resources ?? []).some((r) => r.navigationGroup === g.label && r.navigationIcon);
      const iconBtn = h("button", { type: "button", class: "icon-button ps-group-icon", title: g.kind === "code" ? "" : hasIcons && !g.icon ? "The group's resources have icons, and Filament allows icons on the group or on its items, not both." : "Choose an icon" }, g.icon ? heroicon(dir, iconName(g.icon)) : icon("circle-large-outline"));
      // Filament throws when a group and its items both have icons.
      iconBtn.disabled = g.kind === "code" || (hasIcons && !g.icon);
      iconBtn.onclick = async () => {
        const chosen = await pickHeroicon(iconBtn, { dir, cases: this.cat?.heroicons ?? [], current: iconName(g.icon) });
        if (chosen === null) return;
        void this.apply((t, c) => changeNavGroupEdits(t, c, i, { icon: chosen ? `{{${HEROICON}}}::${chosen}` : null }), `Group ${g.label}: icon`);
      };
      const name =
        g.kind === "code" || g.label === null
          ? h("button", { type: "button", class: "fd-code-chip", onclick: () => this.reveal(g.node.span[0]) }, icon("code"), h("span", {}, text.slice(g.node.span[0], g.node.span[1]).replace(/\s+/g, " ").slice(0, 50)))
          : commitInput(g.label, (v) => v.trim() && void this.apply((t, c) => changeNavGroupEdits(t, c, i, { label: v.trim() }), `Renamed the group to ${v.trim()}`));
      const count = (panel?.resources ?? []).filter((r) => r.navigationGroup === g.label).length;
      return h(
        "div",
        { class: "ps-group" },
        iconBtn,
        name,
        g.translated ? h("span", { class: "fd-note", title: "Translated with __()" }, "__()") : null,
        hasIcons && g.icon ? h("span", { class: "ps-warn", title: "Filament shows an error when a group and its resources both have icons. Remove the group's icon, or the resources' icons." }, icon("warning"), "Its resources have icons too") : null,
        h("span", { class: "fd-note" }, count ? `${count} resource${count > 1 ? "s" : ""}` : used.length ? "unused" : ""),
        g.kind !== "code" ? h("label", { class: "ps-check", title: "The group starts collapsed" }, h("input", { type: "checkbox", checked: g.collapsed, onchange: (e: Event) => void this.apply((t, c) => changeNavGroupEdits(t, c, i, { collapsed: (e.target as HTMLInputElement).checked }), `Group ${g.label}: collapsed`) }), "Collapsed") : null,
        iconButton("arrow-up", "Move up", () => i > 0 && void this.apply((t, c) => moveNavGroupEdits(t, c, i, i - 1), "Moved the group up")),
        iconButton("arrow-down", "Move down", () => i < groups.length - 1 && void this.apply((t, c) => moveNavGroupEdits(t, c, i, i + 2), "Moved the group down")),
        iconButton("trash", "Remove from the list (its resources keep their group)", () => void this.apply((t, c) => removeNavGroupEdits(t, c, i), "Removed the group from the list")),
      );
    });
    const missing = used.filter((u) => !labels.has(u));
    const add = h("button", { type: "button", class: "md-add" }, icon("add"), "Add group");
    add.onclick = async () => {
      const label = await askName(add, { title: "Group name", suggestions: missing.map((value) => ({ value, detail: "used by resources" })) });
      if (label?.trim()) void this.apply((t, c) => addNavGroupEdits(t, c, label.trim(), groups.some((g) => g.translated)), `Added the group ${label.trim()}`);
    };
    return h(
      "section",
      { class: "fd-settings-section" },
      h("h3", {}, icon("list-tree"), "Navigation groups", h("span", { class: "fd-spacer" }), other ? null : add),
      h("p", { class: "fd-note" }, other ? "The groups come from code the designer can't read." : "The order of the groups in the navigation. Resources choose their group in their own settings; groups not listed come after these."),
      ...list,
      missing.length && !other ? h("p", { class: "fd-note" }, `Not in the list: ${missing.join(", ")}.`) : null,
    );
  }

  private plugins(text: string, code: PanelCode): HTMLElement {
    const { entries, other } = readPlugins(text, code);
    const usedClasses = new Set(entries.map((e) => e.class?.replace(/^\\/, "")));
    const available = (this.options?.plugins ?? []).filter((p) => !usedClasses.has(p.class));
    const rows = entries.map((e) =>
      h(
        "div",
        { class: "fd-card" },
        h("span", { class: "fd-card-icon" }, icon("extensions")),
        h("div", { class: "fd-card-body" }, h("strong", {}, e.class ? shortClass(e.class) : "Plugin"), h("div", { class: "fd-card-details" }, h("code", {}, e.code.replace(/\s+/g, " ").slice(0, 90)))),
        h("div", { class: "fd-card-actions" }, iconButton("trash", "Remove the plugin from the panel", () => void this.apply(() => e.remove(), `Removed ${e.class ? shortClass(e.class) : "the plugin"}`))),
      ),
    );
    const add = h("select", {}, h("option", { value: "", textContent: available.length ? "Add an installed plugin…" : "No other plugins installed" }), ...available.map((p) => h("option", { value: p.class, textContent: `${shortClass(p.class)} · ${p.package}`, title: p.description ?? "" })));
    add.disabled = !available.length || !!other;
    add.onchange = () => add.value && void this.apply((t, c) => addPluginEdits(t, c, add.value), `Added ${shortClass(add.value)}`);
    return h(
      "section",
      { class: "fd-settings-section" },
      h("h3", {}, icon("extensions"), "Plugins", h("span", { class: "fd-spacer" }), add),
      other ? h("p", { class: "fd-note" }, "Some plugins come from code: ", h("button", { type: "button", class: "fd-chip-link", onclick: () => this.reveal(text.indexOf(other)) }, other.replace(/\s+/g, " ").slice(0, 60))) : null,
      h("p", { class: "fd-note" }, "Plugins installed with Composer. Install one in the terminal with composer require, then add it here."),
      h("div", { class: "fd-cards" }, ...rows),
    );
  }

  private tenancy(text: string, code: PanelCode): HTMLElement {
    const t = readTenant(text, code);
    const user = this.options?.user;
    const select = h(
      "select",
      {},
      h("option", { value: "", textContent: "No tenancy", selected: !t.model }),
      ...this.models.map((m) => h("option", { value: m, textContent: shortClass(m), selected: !!t.model && shortClass(t.model) === shortClass(m) })),
    );
    select.onchange = () => void this.apply((tx, c) => tenantEdits(tx, c, select.value || null), select.value ? `Tenancy by ${shortClass(select.value)}` : "Removed tenancy");
    const needs =
      t.model && user && !user.hasTenants
        ? h(
            "div",
            { class: "fd-helper-note fd-error-note" },
            icon("warning"),
            h("span", {}, `${shortClass(user.class)} must implement Filament's HasTenants, with getTenants() and canAccessTenant(), and ${shortClass(t.model)} needs a relationship to its records. `),
            user.file ? h("button", { type: "button", class: "fd-chip-link", onclick: () => host.openAt(`${this.root}/${user.file}`, 1) }, `Open ${shortClass(user.class)}`) : null,
          )
        : null;
    return h(
      "section",
      { class: "fd-settings-section fd-settings" },
      h("h3", {}, icon("organization"), "Tenancy"),
      h("p", { class: "fd-note" }, "Each user works inside a team, company, or other record, and sees only its data."),
      t.code ? h("button", { type: "button", class: "fd-code-chip", onclick: () => this.reveal(text.indexOf(t.code!)) }, icon("code"), t.code) : h("div", { class: "fd-rows" }, h("div", { class: `fd-row${t.model ? " set" : ""}` }, h("span", { class: "fd-row-label" }, "Tenant model"), h("div", { class: "fd-row-editor" }, select), h("span", { class: "fd-row-spacer" }))),
      needs,
    );
  }

  /** A small drawing of the panel: brand, navigation with its groups, and the colors. */
  private preview(text: string, code: PanelCode): HTMLElement {
    const get = (call: string) => readSetting(text, code, SETTINGS.find((s) => s.call === call)!).value;
    const brand = (get("brandName") as string) || this.options?.appName || "Laravel";
    const logo = get("brandLogo") as string | undefined;
    const top = get("topNavigation") === true;
    const panel = this.app?.panels.find((p) => p.id === this.panelId);
    const { groups } = readNavGroups(text, code);
    const order = groups.map((g) => g.label ?? "");
    const byGroup = new Map<string, fapp.ResourceInfo[]>();
    for (const r of panel?.resources ?? []) {
      const g = r.navigationGroup ?? "";
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(r);
    }
    const rank = (g: string) => (g === "" ? -1 : order.includes(g) ? order.indexOf(g) : order.length);
    const sorted = [...byGroup.entries()].sort(([a], [b]) => rank(a) - rank(b));
    const dir = this.cat?.heroiconsDir ?? null;
    const item = (r: fapp.ResourceInfo) => h("div", { class: "ps-nav-item" }, heroicon(dir, r.navigationIcon), h("span", {}, r.navigationLabel ?? r.pluralLabel ?? shortClass(r.class)));
    const nav = sorted.map(([g, rs]) => h("div", { class: "ps-nav-group" }, g ? h("div", { class: "ps-nav-label" }, g) : null, ...rs.sort((a, b) => (a.navigationSort ?? 0) - (b.navigationSort ?? 0)).map(item)));
    const brandEl = h("div", { class: "ps-brand", title: logo ? `Logo: ${logo}` : "" }, logo ? icon("file-media") : null, h("strong", {}, brand));
    const css = (role: string) => this.colorCss(role, text, code);
    const screen = h(
      "div",
      { class: `ps-screen${top ? " top" : ""}${this.darkPreview ? " dark" : ""}`, style: `--ps-primary:${css("primary")};--ps-gray:${css("gray")};--ps-danger:${css("danger")};--ps-success:${css("success")};--ps-warning:${css("warning")};--ps-info:${css("info")}` },
      top ? h("div", { class: "ps-topbar" }, brandEl, ...sorted.flatMap(([g, rs]) => (g ? [h("span", { class: "ps-top-item" }, g, icon("chevron-down"))] : rs.map((r) => h("span", { class: "ps-top-item" }, r.pluralLabel ?? shortClass(r.class)))))) : h("aside", { class: "ps-sidebar" }, brandEl, h("div", { class: "ps-nav-item active" }, icon("home"), h("span", {}, "Dashboard")), ...nav),
      h(
        "main",
        { class: "ps-content" },
        h("div", { class: "ps-heading" }, h("strong", {}, "Records"), h("span", { class: "ps-button" }, "New record")),
        h("div", { class: "ps-card" }, ...["success", "warning", "danger", "info"].map((c) => h("span", { class: "ps-badge", style: `--c:var(--ps-${c})` }, c))),
        h("div", { class: "ps-card ps-lines" }, h("i"), h("i"), h("i")),
      ),
    );
    return h(
      "aside",
      { class: "ps-preview" },
      h("div", { class: "ps-preview-head" }, h("strong", {}, "Preview"), h("span", { class: "fd-spacer" }), h("label", { class: "ps-check" }, h("input", { type: "checkbox", checked: this.darkPreview, onchange: (e: Event) => ((this.darkPreview = (e.target as HTMLInputElement).checked), this.render()) }), "Dark")),
      screen,
      panel?.url ? h("button", { type: "button", onclick: () => host.openUrl(panel.url!) }, icon("link-external"), "Open the panel") : null,
    );
  }
}
