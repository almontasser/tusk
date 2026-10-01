// A panel's navigation, drawn as Filament draws its sidebar: groups in order, with their pages, resources, and
// clusters. Dragging an item writes `$navigationSort` to each project file in the group's new order, and
// `$navigationGroup` or `$cluster` when it lands elsewhere; dragging a group rewrites the provider's
// `navigationGroups([...])`. The inspector changes one item's label, icon, group, parent item, cluster, and whether
// it shows. Settings a method decides, and items from packages, show as they are. The logic is src/navgen.ts's.
import { editFiles, type FileBuild } from "./codeapply";
import { h, icon, iconButton } from "./dom";
import * as fapp from "./filamentapp";
import { type Doc, host, openDesigner } from "./filamentdesigner";
import { askName, commitInput, heroicon, pickHeroicon, toggleSwitch } from "./filamentpickers";
import { shortClass } from "./filamentschema";
import {
  discoverClustersEdits,
  editable,
  groupEdits,
  groupKey,
  groupOrderEdits,
  type GroupTarget,
  type NavItem,
  type NavSetting,
  orderSorts,
  type PanelNav,
  readNav,
  type Readout,
  renameGroupEdits,
  setNav,
  setTranslated,
  type SideGroup,
  sidebar,
} from "./navgen";
import { changeNavGroupEdits, type PanelCode, panelChains, readNavGroups } from "./panelgen";
import { type Edit, methodNamed, type OClass, phpString } from "./phpcode";
import { showError } from "./status";
import { showEditorView } from "./terminal";

const HEROICON = "Filament\\Support\\Icons\\Heroicon";
const open = new Map<string, NavigationDesigner>();

/** Opens a panel's navigation. */
export function openNavigation(panelId: string) {
  let v = open.get(panelId);
  if (!v) open.set(panelId, (v = new NavigationDesigner(panelId)));
  v.show();
}

/** What's being dragged: an item, or a group by its key. Kept here, since `dataTransfer` can't be read on dragover. */
let dragging: { item: NavItem } | { group: string } | null = null;
const KIND_ICON: Record<NavItem["kind"], string> = { page: "file", dashboard: "dashboard", cluster: "folder-library", resource: "symbol-structure", link: "link" };

class NavigationDesigner {
  el = h("div", { class: "md-designer nv-designer" });
  private nav: PanelNav | null = null;
  private panel: fapp.PanelInfo | null = null;
  private iconsDir: string | null = null;
  private heroicons: string[] = [];
  private docs = new Map<string, Doc>();
  private selected: { item: string } | { group: string } | null = null;
  private error = "";

  constructor(private panelId: string) {}

  private get root() {
    return host.root();
  }

  show() {
    showEditorView(`${this.panelId} · Navigation`, this.el, "list-tree", () => open.delete(this.panelId));
    void this.load();
    this.render();
  }

  private abs = (file: string) => (file.startsWith("/") ? file : `${this.root}/${file}`);
  private inProject = (i: NavItem) => i.kind !== "link" && !!i.file && !i.file.startsWith("vendor/");
  private id = (i: NavItem) => i.class ?? `link:${i.label}`;

  private async load() {
    try {
      fapp.forget([`app:navigation:${this.panelId}`]);
      const [nav, app, cat] = await Promise.all([fapp.navigation(this.root, this.panelId), fapp.app(this.root), fapp.catalog(this.root).catch(() => null)]);
      this.panel = app.panels.find((p) => p.id === this.panelId) ?? null;
      this.iconsDir = cat?.heroiconsDir ?? null;
      this.heroicons = cat?.heroicons ?? [];
      // Each project file's code, to tell values the designer writes from code that decides them.
      const files = [...nav.items.filter(this.inProject).map((i) => i.file!), ...(this.panel?.provider?.file ? [this.panel.provider.file] : [])];
      const docs = await Promise.all(
        [...new Set(files)].map(async (f) => {
          const path = this.abs(f);
          const model = await host.ensureModel(path);
          const text = model.getValue();
          return [f, { path, model, text, outline: await fapp.outlineOf(text, path) }] as const;
        }),
      );
      this.docs = new Map(docs);
      this.nav = nav;
      this.error = "";
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.render();
  }

  /** Applies edits to several files, then reads the navigation again. */
  private async edit(files: { path: string; build: FileBuild }[], message: string) {
    if (!files.length) return;
    if (await editFiles(files, message)) {
      fapp.forget(["app"]);
      await this.load();
    }
  }

  /** An edit to an item's class, computed from its current code. */
  private build(item: NavItem, f: (text: string, cls: OClass) => Edit[]): { path: string; build: FileBuild } {
    return { path: this.abs(item.file!), build: (text, outline) => {
      const cls = outline.classes.find((c) => c.fqn === item.class);
      return cls ? f(text, cls) : null;
    } };
  }

  private providerBuild(f: (text: string, code: PanelCode) => Edit[]): { path: string; build: FileBuild } | null {
    const file = this.panel?.provider?.file;
    return file ? { path: this.abs(file), build: (text, outline) => {
      const cls = outline.classes.find((c) => c.name);
      const m = cls && methodNamed(cls, "panel");
      return m ? f(text, panelChains(m)) : null;
    } } : null;
  }

  private classOf(item: NavItem): { doc: Doc; cls: OClass } | null {
    const doc = item.file ? this.docs.get(item.file) : undefined;
    const cls = doc?.outline.classes.find((c) => c.fqn === item.class);
    return doc && cls ? { doc, cls } : null;
  }

  /** How an item writes a setting, or why the designer can't change it. */
  private read(item: NavItem, s: NavSetting): Readout {
    if (this.nav?.custom) return { kind: "code", at: null, why: "The provider builds the navigation itself." };
    if (item.kind === "link") return { kind: "code", at: null, why: "The provider adds it with navigationItems()." };
    if (!this.inProject(item)) return { kind: "code", at: null, why: "It comes from a package." };
    const c = this.classOf(item);
    if (!c) return { kind: "code", at: null, why: "Its class can't be read." };
    if (c.doc.outline.errors) return { kind: "code", at: null, why: "Its file has syntax errors." };
    const by = item.overrides[s];
    return readNav(c.cls, s, by && by !== item.file ? by : null);
  }

  private movable = (i: NavItem) => editable(this.read(i, "navigationSort")) && editable(this.read(i, "navigationGroup"));

  private providerCode(): { text: string; code: PanelCode } | null {
    const doc = this.panel?.provider?.file ? this.docs.get(this.panel.provider.file) : undefined;
    const cls = doc?.outline.classes.find((c) => c.name);
    const m = cls && methodNamed(cls, "panel");
    return doc && m ? { text: doc.text, code: panelChains(m) } : null;
  }

  /** Opens the code at a method or node the item reads, or the item's file. */
  private reveal(item: NavItem | null, r?: Readout) {
    const at = r?.kind === "code" ? r.at : null;
    if (item?.file && this.inProject(item)) {
      const doc = this.docs.get(item.file);
      const span = at ? ("span" in at ? at.span : null) : null;
      const p = doc && span ? doc.model.getPositionAt(span[0]) : null;
      return host.openAt(this.abs(item.file), p?.lineNumber ?? 1, p?.column);
    }
    if (item?.file) return host.openAt(this.abs(item.file), 1);
    if (this.panel?.provider?.file) host.openAt(this.abs(this.panel.provider.file), 1);
  }

  // ---- Moving ----

  /** How a group is written in the project: an enum case, `__()`, or a string. */
  private target(group: SideGroup["group"]): GroupTarget {
    if (!group) return null;
    if (group.enum) return { label: group.label, enum: group.enum, case: group.case, translated: false };
    const members = (this.nav?.items ?? []).filter((i) => groupKey(i.group) === group.label && this.inProject(i));
    const translated = members.some((i) => this.read(i, "navigationGroup").kind === "translated") || !!this.providerGroups()?.groups.some((g) => g.label === group.label && g.translated);
    return { label: group.label, enum: null, case: null, translated };
  }

  private providerGroups() {
    const p = this.providerCode();
    return p ? readNavGroups(p.text, p.code) : null;
  }

  /**
   * Moves an item to `index` among the top-level items of a group, in a cluster or the panel: its group and cluster
   * change when they differ, and the group's project items get sorts in their new order.
   */
  private async move(item: NavItem, to: { cluster: string | null; group: GroupTarget }, index: number) {
    const key = to.group ? (to.group.enum ? `${to.group.enum}::${to.group.case}` : to.group.label) : "";
    const side = sidebar(this.nav!.items, to.cluster ? null : this.nav!.groups, to.cluster).find((g) => g.key === key);
    const list: NavItem[] = (side?.items ?? []).filter((i) => this.id(i) !== this.id(item));
    list.splice(Math.min(index, list.length), 0, item);
    const sorts = orderSorts(list.map((i) => ({ sort: i.sort, fixed: !this.inProject(i) || !editable(this.read(i, "navigationSort")) })));
    const regroup = groupKey(item.group) !== key;
    const recluster = (item.cluster ?? null) !== to.cluster;
    if (recluster && !editable(this.read(item, "cluster"))) return host.status(`${this.label(item)}'s cluster is decided in code.`);
    const files = list.flatMap((i, n) => {
      const sort = sorts[n];
      const moved = this.id(i) === this.id(item);
      if (!this.inProject(i) || (!moved && sort === i.sort)) return [];
      return [this.build(i, (text, cls) => [
        ...(sort !== i.sort && sort !== null ? setNav(text, cls, "navigationSort", String(sort)) : []),
        ...(moved && regroup ? groupEdits(text, cls, to.group) : []),
        // A parent item belongs to the old group.
        ...(moved && regroup && i.parent ? setNav(text, cls, "navigationParentItem", null) : []),
        ...(moved && recluster ? setNav(text, cls, "cluster", to.cluster ? `{{${to.cluster}}}::class` : null) : []),
      ])];
    });
    await this.edit(files, `Moved ${this.label(item)}`);
  }

  /** Moves a group before or after another, listing the panel's groups in their new order. */
  private async moveGroup(key: string, before: string | null) {
    const named = sidebar(this.nav!.items, this.nav!.groups).filter((g) => g.group && !g.group.enum).map((g) => g.key);
    const order = named.filter((k) => k !== key);
    order.splice(before === null ? order.length : Math.max(0, order.indexOf(before)), 0, key);
    const b = this.providerBuild((text, code) => groupOrderEdits(text, code, order.map((label) => ({ label, translated: !!this.target({ label, enum: null, case: null })?.translated }))));
    if (b) await this.edit([b], `Moved the group ${key}`);
  }

  /** Renames a group in every file that names it, and in the provider's list. */
  private async renameGroup(from: string, to: string) {
    const members = this.nav!.items.filter((i) => i.group && !i.group.enum && i.group.label === from);
    const fixed = members.filter((i) => this.read(i, "navigationGroup").kind === "code");
    const files = members.filter((i) => !fixed.includes(i)).map((i) => this.build(i, (text, cls) => renameGroupEdits(text, cls, to)));
    const listed = this.providerGroups()?.groups.findIndex((g) => g.label === from) ?? -1;
    const p = listed >= 0 ? this.providerBuild((text, code) => changeNavGroupEdits(text, code, listed, { label: to })) : null;
    const translated = this.target({ label: from, enum: null, case: null })?.translated;
    await this.edit([...files, ...(p ? [p] : [])], `Renamed the group ${from} to ${to}`);
    if (translated) {
      const t = await fapp.translations(this.root).catch(() => null);
      if (t) await (await import("./translationfiles")).renameTranslation(t, from, to);
    }
    if (fixed.length) host.status(`Code decides the group of ${fixed.map((i) => this.label(i)).join(", ")}; change ${fixed.length > 1 ? "those" : "it"} by hand.`);
    this.selected = { group: to };
    this.render();
  }

  private async newCluster(anchor: HTMLElement) {
    const name = await askName(anchor, { title: "New cluster", placeholder: "Settings", action: "Create", validate: (v) => (/^[A-Z][A-Za-z0-9]*$/.test(v.trim()) ? null : "A class name, such as Settings.") });
    if (!name?.trim()) return;
    try {
      // A cluster needs the panel to discover clusters, which also finds the resources and pages in its folder.
      if (!this.panel?.clusterDirs.length) {
        const p = this.providerBuild((text, code) => discoverClustersEdits(text, code, this.panel?.pageDirs[0] ?? null, this.panel?.pageNamespaces[0] ?? null));
        if (p && !(await editFiles([p], "The panel discovers clusters"))) return;
      }
      host.status(`Creating the ${name.trim()} cluster…`);
      const out = await fapp.artisan(this.root, ["make:filament-cluster", name.trim(), `--panel=${this.panelId}`]);
      fapp.forget(["app"]);
      const [file] = await fapp.createdFiles(this.root, out);
      await this.load();
      const made = this.nav?.items.find((i) => i.kind === "cluster" && file && this.abs(i.file ?? "") === file);
      if (made) this.selected = { item: this.id(made) };
      this.render();
    } catch (e) {
      showError("Can't create the cluster", e);
    }
  }

  // ---- Drawing ----

  private label = (i: NavItem) => i.label ?? shortClass(i.class ?? "");

  render() {
    const newCluster = h("button", { type: "button", title: "A cluster groups resources and pages under one item, with their own navigation" }, icon("folder-library"), "New cluster");
    newCluster.onclick = () => void this.newCluster(newCluster);
    newCluster.disabled = !this.nav || this.nav.custom;
    const header = h(
      "header",
      { class: "fd-header" },
      h("span", { class: "fd-header-icon" }, icon("list-tree")),
      h("div", { class: "fd-header-titles" }, h("h1", {}, "Navigation"), h("div", { class: "fd-header-chips" }, h("span", { class: "fd-chip-static" }, icon("window"), this.panelId))),
      h("span", { class: "fd-spacer" }),
      newCluster,
      this.panel?.provider?.file ? iconButton("settings-gear", "Panel settings: group icons and collapsing", () => void import("./panelsettings").then((m) => m.openPanelSettings(this.abs(this.panel!.provider!.file!), this.panelId))) : null,
      iconButton("refresh", "Read the navigation again", () => (fapp.forget(["app"]), void this.load())),
    );
    if (this.error) return void this.el.replaceChildren(header, h("div", { class: "fd-error" }, icon("warning"), h("div", {}, h("strong", {}, "Can't read the navigation"), h("p", {}, this.error))));
    if (!this.nav) return void this.el.replaceChildren(header, h("div", { class: "fd-loading" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), "Reading the navigation…"));
    const notes = [
      this.nav.custom ? h("div", { class: "fd-helper-note fd-error-note" }, icon("warning"), h("span", {}, "The provider builds this panel's navigation itself with navigation(…), so the items' settings don't apply. It shows here as Filament would build it without that.")) : null,
      this.nav.topNavigation ? h("p", { class: "fd-note" }, "The panel shows its navigation at the top: groups become menus, in the same order.") : null,
    ];
    const groups = sidebar(this.nav.items, this.nav.groups);
    const side = h("div", { class: "nv-sidebar" }, ...groups.map((g) => this.groupEl(g, null)), this.newGroupZone());
    const main = h("div", { class: "md-main nv-main" }, ...notes, h("p", { class: "fd-note" }, "Drag items to reorder them or move them to another group or cluster, and drag groups to reorder them. Each change is saved to the files."), side);
    this.el.replaceChildren(header, h("div", { class: "md-body" }, main, this.inspector()));
  }

  private groupEl(g: SideGroup, cluster: string | null): HTMLElement {
    const sel = !!this.selected && "group" in this.selected && this.selected.group === g.key && !cluster;
    const draggable = !cluster && !!g.group && !g.group.enum && !this.nav!.custom && !this.providerGroups()?.code;
    const head = g.group
      ? h("div", { class: `nv-group-head${sel ? " selected" : ""}`, draggable, tabIndex: 0, title: g.group.enum ? `${shortClass(g.group.enum)}::${g.group.case}` : "" }, h("span", {}, g.group.label), g.group.enum ? h("span", { class: "fd-note" }, "enum") : null, h("span", { class: "fd-spacer" }), icon("chevron-up"))
      : null;
    const el = h("section", { class: "nv-group" }, head, ...g.items.map((i, n) => this.itemEl(i, g, n, cluster)));
    if (head) {
      head.onclick = () => ((this.selected = { group: g.key }), this.render());
      head.ondragstart = (e) => ((dragging = { group: g.key }), e.dataTransfer?.setData("text/plain", g.key));
    }
    // Dropped on a group: an item goes to its end, a group goes before it.
    this.dropTarget(el, (y) => {
      if (!dragging) return;
      if ("group" in dragging) {
        if (cluster || !g.group || g.group.enum || dragging.group === g.key) return;
        const r = el.getBoundingClientRect();
        void this.moveGroup(dragging.group, y < r.top + r.height / 2 ? g.key : this.nextGroup(g.key));
      } else void this.move(dragging.item, { cluster, group: this.target(g.group) }, g.items.length);
    });
    return el;
  }

  private nextGroup(key: string): string | null {
    const named = sidebar(this.nav!.items, this.nav!.groups).filter((g) => g.group && !g.group.enum).map((g) => g.key);
    return named[named.indexOf(key) + 1] ?? null;
  }

  /** A drop target that highlights while something is dragged over it. */
  private dropTarget(el: HTMLElement, drop: (y: number) => void) {
    el.ondragover = (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.add("nv-over");
    };
    el.ondragleave = () => el.classList.remove("nv-over");
    el.ondrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove("nv-over");
      drop(e.clientY);
      dragging = null;
    };
  }

  private itemEl(i: NavItem & { children?: NavItem[] }, g: SideGroup, n: number, cluster: string | null): HTMLElement {
    const sel = !!this.selected && "item" in this.selected && this.selected.item === this.id(i);
    const movable = this.movable(i);
    const row = h(
      "div",
      { class: `nv-item${sel ? " selected" : ""}${i.registers ? "" : " hidden"}${movable ? "" : " fixed"}`, draggable: movable, tabIndex: 0, title: `${i.class ?? i.label}${movable ? "" : "\nIts place is decided in code or by a package."}` },
      i.icon ? heroicon(this.iconsDir, i.icon) : icon(KIND_ICON[i.kind]),
      h("span", { class: "nv-label" }, this.label(i)),
      // A child shows under its parent; one at the top has no parent in its group.
      i.parent && n >= 0 ? h("span", { class: "ps-warn", title: "Filament hides an item whose parent isn't in its group." }, icon("warning"), `under ${i.parent}`) : null,
      h("span", { class: "fd-spacer" }),
      i.registers ? null : h("span", { title: "Hidden from the navigation" }, icon("eye-closed")),
      this.inProject(i) || i.kind === "link" ? null : h("span", { title: "From a package" }, icon("lock-small")),
      i.badge !== null ? h("span", { class: "nv-badge", title: "Badge (read only)" }, i.badge) : null,
    );
    row.onclick = (e) => (e.stopPropagation(), (this.selected = { item: this.id(i) }), this.render());
    row.ondblclick = () => this.openItem(i);
    row.onkeydown = (e) => {
      if (e.key === "Enter") this.openItem(i);
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && movable) {
        e.preventDefault();
        void this.move(i, { cluster, group: this.target(g.group) }, e.key === "ArrowUp" ? Math.max(0, n - 1) : n + 1);
      }
    };
    row.ondragstart = (e) => (e.stopPropagation(), (dragging = { item: i }), e.dataTransfer?.setData("text/plain", this.id(i)));
    row.oncontextmenu = (e) => (e.preventDefault(), this.menu(e, i, g, n, cluster));
    // Dropped on an item: before or after it, by which half.
    this.dropTarget(row, (y) => {
      if (!dragging || !("item" in dragging) || this.id(dragging.item) === this.id(i)) return;
      const r = row.getBoundingClientRect();
      // Onto a cluster: into it.
      if (i.kind === "cluster" && i.class && y > r.top + r.height * 0.25 && y < r.bottom - r.height * 0.25) return void this.move(dragging.item, { cluster: i.class, group: dragging.item.group ? this.target(dragging.item.group) : null }, 1e9);
      void this.move(dragging.item, { cluster, group: this.target(g.group) }, y < r.top + r.height / 2 ? n : n + 1);
    });
    const children = (i.children ?? []).map((c) => h("div", { class: "nv-child" }, this.itemEl(c, g, -1, cluster)));
    if (i.kind !== "cluster" || !i.class) return children.length ? h("div", {}, row, ...children) : row;
    // A cluster: its own navigation, with the resources and pages in it.
    const inner = sidebar(this.nav!.items, null, i.class);
    const box = h("div", { class: "nv-cluster" }, ...inner.map((ig) => this.groupEl(ig, i.class)), inner.length ? null : h("p", { class: "fd-note" }, "Drop resources and pages here."));
    this.dropTarget(box, () => dragging && "item" in dragging && void this.move(dragging.item, { cluster: i.class, group: null }, 1e9));
    return h("div", {}, row, ...children, box);
  }

  private openItem(i: NavItem) {
    if (!this.inProject(i)) return this.reveal(i);
    if (i.kind === "resource" || i.kind === "page") return void openDesigner(this.abs(i.file!));
    this.reveal(i);
  }

  private menu(e: MouseEvent, i: NavItem, g: SideGroup, n: number, cluster: string | null) {
    const movable = this.movable(i);
    const vis = this.read(i, "shouldRegisterNavigation");
    void import("./files").then(({ showMenu }) =>
      showMenu(e.clientX, e.clientY, [
        ...(this.inProject(i) && (i.kind === "resource" || i.kind === "page") ? [{ label: "Open in Designer", run: () => this.openItem(i) }] : []),
        { label: "Open Code", run: () => this.reveal(i) },
        "-",
        ...(movable
          ? [
              { label: "Move Up", keys: "⌥↑", run: () => n > 0 && void this.move(i, { cluster, group: this.target(g.group) }, n - 1) },
              { label: "Move Down", keys: "⌥↓", run: () => void this.move(i, { cluster, group: this.target(g.group) }, n + 1) },
            ]
          : []),
        ...(editable(vis) ? [{ label: i.registers ? "Hide from the Navigation" : "Show in the Navigation", run: () => void this.setVisible(i, !i.registers) }] : []),
      ]),
    );
  }

  /** Below the groups: drop an item here to put it in a new group. */
  private newGroupZone(): HTMLElement {
    const zone = h("div", { class: "nv-new-group" }, icon("add"), "Drop here for a new group");
    this.dropTarget(zone, () => {
      if (!dragging || !("item" in dragging)) return;
      const item = dragging.item;
      void askName(zone, { title: "New group", placeholder: "Shop", action: "Move" }).then((label) => {
        if (!label?.trim()) return;
        const translated = this.nav!.items.some((x) => this.inProject(x) && this.read(x, "navigationGroup").kind === "translated");
        void this.move(item, { cluster: item.cluster, group: { label: label.trim(), enum: null, case: null, translated } }, 0);
      });
    });
    return zone;
  }

  private async setVisible(i: NavItem, on: boolean) {
    await this.edit([this.build(i, (text, cls) => setNav(text, cls, "shouldRegisterNavigation", on ? null : "false"))], on ? `${this.label(i)} shows in the navigation` : `${this.label(i)} is hidden from the navigation`);
  }

  // ---- The inspector ----

  private inspector(): HTMLElement {
    const aside = h("aside", { class: "nv-inspector" });
    const sel = this.selected;
    if (sel && "group" in sel) return (aside.append(this.groupInspector(sel.group)), aside);
    const item = sel && "item" in sel ? this.nav!.items.find((i) => this.id(i) === sel.item) : undefined;
    if (!item) return (aside.append(h("p", { class: "fd-note" }, "Select an item or a group to change it.")), aside);
    const row = (label: string, s: NavSetting | null, editor: (r: Readout) => HTMLElement) => {
      const r = s ? this.read(item, s) : ({ kind: "default" } as Readout);
      const el = r.kind === "code" ? h("button", { type: "button", class: "fd-code-chip", title: r.why, onclick: () => this.reveal(item, r) }, icon("code"), h("span", {}, r.at && "name" in r.at && "returns" in r.at ? `Set in ${r.at.name}()` : "Set in code")) : editor(r);
      return h("div", { class: `fd-row${r.kind === "value" || r.kind === "translated" ? " set" : ""}`, title: r.kind === "code" ? r.why : "" }, h("span", { class: "fd-row-label" }, label), h("div", { class: "fd-row-editor" }, el), h("span", { class: "fd-row-spacer" }));
    };
    const set = (s: NavSetting, code: string | null, message: string) => void this.edit([this.build(item, (text, cls) => setNav(text, cls, s, code))], message);
    const groups = sidebar(this.nav!.items, item.cluster ? null : this.nav!.groups, item.cluster);
    const mine = groups.find((g) => g.key === groupKey(item.group));
    const rows = [
      row("Label", "navigationLabel", (r) =>
        r.kind === "translated"
          ? commitInput(r.text, (v) => v.trim() && void this.edit([this.build(item, (text, cls) => setTranslated(text, cls, "navigationLabel", v.trim()))], "Changed the label"))
          : commitInput(r.kind === "value" && r.node.kind === "string" ? r.node.value : "", (v) => set("navigationLabel", v.trim() ? phpString(v.trim()) : null, "Changed the label"), { placeholder: item.label ?? "" }),
      ),
      row("Icon", "navigationIcon", () => {
        const btn = h("button", { type: "button", class: "fd-icon-button" }, heroicon(this.iconsDir, item.icon), h("span", {}, item.icon ? item.icon.replace(/^(heroicon-)?o-/, "").replace(/^Outlined/, "") : "None"), icon("chevron-down"));
        btn.onclick = async () => {
          const picked = await pickHeroicon(btn, { dir: this.iconsDir, cases: this.heroicons, current: item.icon });
          if (picked !== null) set("navigationIcon", picked ? `{{${HEROICON}}}::${picked}` : null, "Changed the icon");
        };
        return btn;
      }),
      row("Group", "navigationGroup", () => {
        const all = sidebar(this.nav!.items.filter((i) => (i.cluster ?? null) === (item.cluster ?? null)), item.cluster ? null : this.nav!.groups, item.cluster).filter((g) => g.group);
        const select = h("select", {}, h("option", { value: "", textContent: "No group", selected: !item.group }), ...all.map((g) => h("option", { value: g.key, textContent: g.group!.label, selected: g.key === groupKey(item.group) })), h("option", { value: "+", textContent: "New group…" }));
        select.disabled = !editable(this.read(item, "navigationSort"));
        select.onchange = async () => {
          if (select.value === "+") {
            const label = await askName(select, { title: "New group", placeholder: "Shop", action: "Move" });
            if (!label?.trim()) return this.render();
            const translated = this.nav!.items.some((x) => this.inProject(x) && this.read(x, "navigationGroup").kind === "translated");
            return void this.move(item, { cluster: item.cluster, group: { label: label.trim(), enum: null, case: null, translated } }, 1e9);
          }
          const g = all.find((x) => x.key === select.value);
          void this.move(item, { cluster: item.cluster, group: g ? this.target(g.group) : null }, 1e9);
        };
        return select;
      }),
      row("Order", "navigationSort", () => h("span", { class: "fd-note" }, `${item.sort ?? "None"} · drag to reorder`)),
      row("Under item", "navigationParentItem", () => {
        const parents = (mine?.items ?? []).filter((p) => p.class !== item.class && !p.parent);
        const select = h("select", {}, h("option", { value: "", textContent: "None" }), ...parents.map((p) => h("option", { value: this.label(p), textContent: this.label(p), selected: this.label(p) === item.parent })));
        select.onchange = () => set("navigationParentItem", select.value ? phpString(select.value) : null, "Changed the parent item");
        return select;
      }),
      item.kind === "resource" || item.kind === "page"
        ? row("Cluster", "cluster", () => {
            const clusters = this.nav!.items.filter((c) => c.kind === "cluster");
            const select = h("select", {}, h("option", { value: "", textContent: "None" }), ...clusters.map((c) => h("option", { value: c.class!, textContent: this.label(c), selected: c.class === item.cluster })));
            select.disabled = !clusters.length || !this.movable(item);
            select.onchange = () => void this.move(item, { cluster: select.value || null, group: this.target(item.group) }, 1e9);
            return select;
          })
        : null,
      row("Show in the navigation", "shouldRegisterNavigation", () => toggleSwitch(item.registers, (on) => void this.setVisible(item, on))),
      h("div", { class: "fd-row" }, h("span", { class: "fd-row-label" }, "Badge"), h("div", { class: "fd-row-editor" }, h("span", { class: "fd-note" }, item.badge !== null ? `${item.badge} · from getNavigationBadge()` : "None")), h("span", { class: "fd-row-spacer" })),
    ];
    const kind = { page: "Page", dashboard: "Dashboard", cluster: "Cluster", resource: "Resource", link: "Link" }[item.kind];
    aside.append(
      h(
        "section",
        { class: "fd-settings-section fd-settings" },
        h("h3", {}, item.icon ? heroicon(this.iconsDir, item.icon) : icon(KIND_ICON[item.kind]), this.label(item), h("span", { class: "fd-spacer" }), h("span", { class: "fd-note" }, kind)),
        !this.inProject(item) ? h("p", { class: "fd-note" }, item.kind === "link" ? "The provider adds this item with navigationItems(). Change it there." : "It comes from a package, so its settings are read only.") : null,
        h("div", { class: "fd-rows" }, ...rows),
        h(
          "div",
          { class: "nv-actions" },
          this.inProject(item) && (item.kind === "resource" || item.kind === "page") ? h("button", { type: "button", onclick: () => this.openItem(item) }, icon("edit"), "Open in Designer") : null,
          h("button", { type: "button", onclick: () => this.reveal(item) }, icon("go-to-file"), item.class ? shortClass(item.class) : "Open the provider"),
        ),
      ),
    );
    return aside;
  }

  private groupInspector(key: string): HTMLElement {
    const g = sidebar(this.nav!.items, this.nav!.groups).find((x) => x.key === key);
    const group = g?.group;
    if (!group) return h("p", { class: "fd-note" }, "Select an item or a group to change it.");
    const listed = this.providerGroups();
    const count = this.nav!.items.filter((i) => groupKey(i.group) === key).length;
    const name = group.enum
      ? h("button", { type: "button", class: "fd-code-chip", title: "An enum case names this group; change its label in the enum.", onclick: () => void fapp.fileOfClass(this.root, group.enum!).then((f) => f && host.openAt(f, 1)) }, icon("symbol-enum"), `${shortClass(group.enum)}::${group.case}`)
      : commitInput(group.label, (v) => v.trim() && v.trim() !== group.label && void this.renameGroup(group.label, v.trim()));
    return h(
      "section",
      { class: "fd-settings-section fd-settings" },
      h("h3", {}, icon("list-tree"), group.label, h("span", { class: "fd-spacer" }), h("span", { class: "fd-note" }, "Group")),
      h("div", { class: "fd-rows" }, h("div", { class: "fd-row" }, h("span", { class: "fd-row-label" }, "Name"), h("div", { class: "fd-row-editor" }, name), h("span", { class: "fd-row-spacer" }))),
      h(
        "p",
        { class: "fd-note nv-group-note" },
        `${count} item${count === 1 ? "" : "s"}. `,
        group.enum
          ? "Groups from an enum come in the order of its cases."
          : listed?.code
            ? "The provider lists its groups in code the designer can't read, so they can't be reordered here."
            : "Renaming changes every file that names the group, and the panel's list. Drag the group to reorder the panel's groups.",
      ),
      this.panel?.provider?.file ? h("div", { class: "nv-actions" }, h("button", { type: "button", onclick: () => void import("./panelsettings").then((m) => m.openPanelSettings(this.abs(this.panel!.provider!.file!), this.panelId)) }, icon("settings-gear"), "Icon and collapsing in panel settings")) : null,
    );
  }
}
