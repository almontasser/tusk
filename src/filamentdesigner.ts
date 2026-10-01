// The resource designer: an editor tab that shows a Filament resource's form, table, and infolist as Filament draws
// them, with a palette of the project's components and an inspector for the selected one, plus its relation
// managers, pages, and settings. The code is the only state: each change is a small edit to the resource's files
// (saved, with local history, and undone with ⌘Z like a refactoring), after which the designer reads them again. Edits
// made in the code editor show here as you type.
import type * as L from "vscode-languageserver-protocol";
import { h, icon, iconButton } from "./dom";
import type { monaco } from "./editor";
import * as fapp from "./filamentapp";
import { type CanvasCtx, currentDrag, type Drag, hideLine, labelOf, renderActionModal, renderPageActions, renderSchema, renderTable, setDragging, setTranslator, type SlotRef } from "./filamentcanvas";
import { isRtl, translate, type Translations } from "./translations";
import { renameTranslation, writeTranslation } from "./translationfiles";
import type { Scope } from "./filamentactions";
import { type Catalog, classInfo, humanize, look, majorVersion, methodsOf, PALETTE_KINDS, palette } from "./filamentcatalog";
import { type Column, filterFor, formField, type Gen, infolistEntry, isSystemColumn, type ModelFacts, renderGen, tableColumn } from "./filamentgen";
import { type CallChange, type InspectorCtx, renderCodeInspector, renderInspector } from "./filamentinspector";
import { renderAccessTab, renderEntryAccess } from "./filamentaccess";
import { renderPagesTab, renderRelationsTab, renderRootSettings, renderSettingsTab } from "./filamentpages";
import { askName, closePopover, heroicon, popover } from "./filamentpickers";
import { childSlot, type Comp, type Path, parentOf, readRoot, resolve, type Root, type RootKind, rootSlot, ROOT_SLOTS, samePath, type Slot, shortClass, slotKey, slotNamed, walk } from "./filamentschema";
import { applyWorkspaceEdit, saveModel } from "./lsp";
import { renderPageWidgets } from "./pagewidgets";
import { addMember, type PNode, classNamed, droppedImports, type Edit, findCall, mergeEdits, Imports, indentCode, insertItem, lineIndent, methodNamed, moveCode, propertyNamed, moveItem, type OClass, type Outline, phpString, reindent, removeCall, removeItem, replaceItem, setArgs, setCall } from "./phpcode";
import { showError } from "./status";
import { confirm } from "./palette";
import { showEditorView } from "./terminal";

export type DesignerHost = {
  root(): string;
  ensureModel(path: string): Promise<monaco.editor.ITextModel>;
  openAt(path: string, line: number, column?: number): void;
  status(text: string): void;
  openUrl(url: string): void;
  /** Runs a command in a terminal tab, calling `done` when it ends. */
  openTerminal(title: string, command: string[], done?: () => void): void;
};

export let host: DesignerHost;
export const initDesigner = (h_: DesignerHost) => (host = h_);

/** A file the designer reads and edits, with the outline of its current text. */
export type Doc = { path: string; model: monaco.editor.ITextModel; text: string; outline: Outline };
/** A form, table, or infolist, in the file that builds it: the resource's, or the class it hands the work to. */
type RootRef = { kind: RootKind; doc: Doc; root: Root } | { kind: RootKind; missing: true } | { kind: RootKind; doc: Doc; error: string; root?: Root };
export type Tab = "form" | "table" | "infolist" | "actions" | "relations" | "pages" | "access" | "settings";

const open = new Map<string, Designer>();

/** Calls whose text people see, which "Make translatable" writes with `__()`. */
const TEXT_CALLS = new Set(["label", "placeholder", "helperText", "hint", "heading", "description", "tooltip", "modalHeading", "modalDescription", "modalSubmitActionLabel", "modalCancelActionLabel", "emptyStateHeading", "emptyStateDescription", "addActionLabel", "successNotificationTitle", "trueLabel", "falseLabel", "loadingMessage", "noSearchResultsMessage", "searchPrompt", "pluralLabel", "modelLabel", "pluralModelLabel", "badgeTooltip"]);

/** Opens the designer for a resource or relation manager file, or brings its tab forward. */
export async function openDesigner(file: string, tab?: Tab) {
  let d = open.get(file);
  if (!d) {
    d = new Designer(file);
    open.set(file, d);
  }
  d.show(tab);
}

/** Tells open designers that the app's code changed on disk, so what introspect.php read may be stale. */
export function projectChanged() {
  for (const d of open.values()) {
    d.stale = true;
    // A designer opened while the app couldn't be read catches up as soon as it can, without a loading screen.
    if (d.el.isConnected && ((!d.info && !d.manager) || !d.facts)) void d.load(true);
  }
}

const TAB_ICONS: Record<Tab, string> = { form: "note", table: "table", infolist: "list-flat", actions: "play", access: "shield", relations: "references", pages: "files", settings: "settings-gear" };

export class Designer {
  file: string;
  el = h("div", { class: "fd-designer", tabIndex: -1 });
  tab: Tab = "form";
  docs = new Map<string, Doc>();
  roots = new Map<RootKind, RootRef>();
  cls: OClass | null = null;
  cat: Catalog | null = null;
  info: fapp.ResourceInfo | null = null;
  app: fapp.AppInfo | null = null;
  facts: (ModelFacts & { details: fapp.ModelDetails }) | null = null;
  enums: fapp.EnumInfo[] = [];
  /** The app's notifications and its user model, for actions that send one. */
  private notices: { list: fapp.NotificationInfo[]; user: string | null } = { list: [], user: null };
  selection: Path | null = null;
  active = new Map<string, number>();
  paletteQuery = "";
  message = "";
  stale = false;
  /** The model's policy and its file, for the Access tab, read when the tab first shows. */
  access: { info: fapp.PolicyInfo; doc: Doc | null } | null = null;
  accessError = "";
  private accessLoading: Promise<void> | null = null;
  /** The app's translations, and the language the canvas previews, or null for the code's own text. */
  translations: Translations | null = null;
  locale: string | null = null;
  /** The page whose header actions the Page actions tab shows, by its file. */
  actionsPage: string | null = null;
  /** Whether it's a relation manager, which has a form and table like a resource but no pages or settings. */
  manager = false;
  /** Whether it's a table widget: a table of its own, designed like a relation manager's, and nothing else. */
  widget = false;
  /** Whether it's a custom page, not a resource's: its form or table, header actions, and navigation settings. */
  page = false;
  /** Who can open the page or see the widget, read when its Access tab first shows. */
  private entry: { info: (fapp.PolicyInfo & { shieldKey: string | null }) | null; error: string } = { info: null, error: "" };
  private undo: string[] = [];
  private redo: string[] = [];
  private applying = false;
  private listeners: monaco.IDisposable[] = [];
  private reloadTimer = 0;
  private loadError = "";
  private scroll = new Map<string, number>();

  constructor(file: string) {
    this.file = file;
    this.el.addEventListener("keydown", (e) => this.keys(e));
  }

  get root() {
    return host.root();
  }

  /** The panel the resource is in. */
  get panel(): fapp.PanelInfo | null {
    return this.app?.panels.find((p) => p.resources.some((r) => r.class === this.info?.class) || (this.page && p.pages.some((x) => x.class === this.cls?.fqn))) ?? null;
  }

  get host() {
    return host;
  }

  show(tab?: Tab) {
    if (tab) this.tab = tab;
    const name = this.file.split("/").pop()!.replace(/\.php$/, "");
    showEditorView(`${name} · Designer`, this.el, "symbol-structure", () => this.dispose());
    if (!this.cls || this.stale) void this.load();
    else this.render();
  }

  dispose() {
    this.listeners.forEach((l) => l.dispose());
    this.listeners = [];
    open.delete(this.file);
  }

  // ---- Loading ----

  async load(quiet = false) {
    this.stale = false;
    if (!quiet) this.el.replaceChildren(h("div", { class: "fd-loading" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), "Reading the resource and Filament's components…"));
    try {
      const root = this.root;
      // The models are needed for relationships' titles later; reading them now overlaps the waits.
      void fapp.models(root).catch(() => {});
      void Promise.all([fapp.notifications(root), fapp.notificationSetup(root)]).then(([list, setup]) => (this.notices = { list, user: setup.user }), () => {});
      // Translations only change what the preview shows, so the designer doesn't wait for them.
      void fapp.translations(root).then((t) => {
        this.translations = t;
        const saved = localStorage.getItem(`fd-locale:${root}`);
        this.locale = saved && t.locales.includes(saved) ? saved : null;
        if (this.el.isConnected && (this.locale || t.locales.length)) this.render();
      }, () => {});
      const [cat, app, enums] = await Promise.all([fapp.catalog(root), fapp.app(root).catch(() => null), fapp.enums(root).catch(() => [])]);
      this.cat = cat;
      this.enums = enums;
      if (majorVersion(cat) && majorVersion(cat) < 4) throw new Error(`The designer works with Filament 4 and later; this project has Filament ${cat.version}.`);
      await this.readDocs();
      const rel = this.file.slice(root.length + 1);
      this.app = app;
      this.info = app?.panels.flatMap((p) => p.resources).find((r) => r.file === rel || r.class === this.cls?.fqn) ?? null;
      const model = this.info?.model ?? (this.manager ? await this.relatedModel(app) : null) ?? this.modelOfCode();
      this.facts = model ? await fapp.modelFacts(root, model).catch(() => null) : null;
      // A settings page's fields are its settings class's properties.
      const settings = this.page && this.cls ? propertyNamed(this.cls, "settings")?.value : null;
      if (!this.facts && settings?.kind === "classConst") this.facts = await import("./settingsdesigner").then((m) => m.settingsFactsOf(settings.class)).catch(() => null);
      await this.readPageActions();
      // A page without a form opens on its table, or its actions.
      if (this.page && this.tab === "form" && "missing" in (this.roots.get("form") ?? { missing: true })) this.tab = "missing" in (this.roots.get("table") ?? { missing: true }) ? "actions" : "table";
      this.loadError = "";
    } catch (e) {
      this.loadError = e instanceof Error ? e.message : String(e);
    }
    this.render();
  }

  /** A relation manager's model: the related model of its relationship, on the model of the resource that has it. */
  private async relatedModel(app: fapp.AppInfo | null): Promise<string | null> {
    for (const r of app?.panels.flatMap((p) => p.resources) ?? []) {
      const manager = r.relations.find((m) => m.class === this.cls?.fqn);
      if (!manager?.relationship) continue;
      const parent = await fapp.model(this.root, r.model).catch(() => null);
      return parent?.relations.find((x) => x.name === manager.relationship)?.related ?? null;
    }
    return null;
  }

  /** The model a relation manager works with, or the resource's `$model` when introspect.php couldn't say. */
  private modelOfCode(): string | null {
    const prop = this.cls?.properties.find((p) => p.name === "model");
    if (prop?.value?.kind === "classConst") return prop.value.class;
    // A table's model is the one its query starts from, `->query(fn () => Order::query())`, and a page's form
    // edits the record its getRecord() returns.
    const doc = this.docs.get(this.file);
    const table = this.cls && doc ? methodNamed(this.cls, "table") : null;
    const record = this.cls ? methodNamed(this.cls, "getRecord")?.returnType?.replace(/^\?/, "") : undefined;
    const name = (table && /(\\?[A-Z][\w\\]*)::query\(/.exec(doc!.text.slice(table.span[0], table.span[1]))?.[1]) || (record && /^\\?[A-Z][\w\\]*$/.test(record) ? record : undefined);
    if (!name || !doc) return null;
    if (name.startsWith("\\")) return name.slice(1);
    const [first, ...rest] = name.split("\\");
    const use = doc.outline.uses.find((u) => u.kind === "class" && u.alias === first);
    return use ? [use.name, ...rest].join("\\") : `${doc.outline.namespace ? `${doc.outline.namespace}\\` : ""}${name}`;
  }

  async doc(path: string): Promise<Doc> {
    const known = this.docs.get(path);
    if (known && known.model.getValue() === known.text) return known;
    const model = known?.model ?? (await host.ensureModel(path));
    const text = model.getValue();
    const outline = await fapp.outlineOf(text, path);
    const doc = { path, model, text, outline };
    if (!known)
      this.listeners.push(
        model.onDidChangeContent(() => {
          if (this.applying) return;
          clearTimeout(this.reloadTimer);
          this.reloadTimer = window.setTimeout(() => void this.refresh(), 250);
        }),
      );
    this.docs.set(path, doc);
    return doc;
  }

  /** Reads the resource file and the files its form, table, and infolist hand their work to. */
  private async readDocs() {
    const main = await this.doc(this.file);
    const cls = main.outline.classes.find((c) => c.name) ?? null;
    if (!cls) throw new Error("There's no class in this file.");
    this.cls = cls;
    this.widget = /TableWidget$/.test(cls.extends ?? "");
    this.manager = this.widget || /RelationManager$/.test(cls.extends ?? "") || /RelationManagers?\\/.test(cls.fqn);
    this.page = !this.manager && !propertyNamed(cls, "resource") && /(^|\\)(Page|SettingsPage)$/.test(cls.extends ?? "");
    if (this.widget) this.tab = "table";
    this.roots.clear();
    for (const kind of ["form", "table", "infolist"] as RootKind[]) {
      const root = readRoot(cls, kind);
      if (!root) {
        this.roots.set(kind, { kind, missing: true });
        continue;
      }
      if (root.delegate) {
        const path = await fapp.fileOfClass(this.root, root.delegate.class);
        if (!path) {
          this.roots.set(kind, { kind, doc: main, error: `It's built by ${root.delegate.class}, whose file isn't in the project.` });
          continue;
        }
        const doc = await this.doc(path);
        const other = classNamed(doc.outline, root.delegate.class) ?? doc.outline.classes[0];
        const inner = other && readRoot(other, kind, root.delegate.method);
        if (!inner) this.roots.set(kind, { kind, doc, error: `${root.delegate.class} has no ${root.delegate.method}() method.` });
        else if (inner.custom) this.roots.set(kind, { kind, doc, error: inner.custom, root: inner });
        else this.roots.set(kind, { kind, doc, root: inner });
        continue;
      }
      if (root.custom) this.roots.set(kind, { kind, doc: main, error: root.custom, root });
      else this.roots.set(kind, { kind, doc: main, root });
    }
    await this.readPageActions();
    if (this.access?.doc) this.access.doc = await this.doc(this.access.doc.path);
  }

  /** Reads the model's policy for the Access tab, and redraws. */
  loadAccess(): Promise<void> {
    this.accessLoading ??= (async () => {
      const model = this.facts?.class ?? this.info?.model;
      try {
        if (!model) throw new Error("The resource's model isn't known.");
        const info = await fapp.policy(this.root, model, this.info?.class);
        this.access = { info, doc: info.file ? await this.doc(info.file.startsWith("/") ? info.file : `${this.root}/${info.file}`) : null };
        this.accessError = "";
      } catch (e) {
        this.accessError = e instanceof Error ? e.message : String(e);
      }
      this.accessLoading = null;
      if (this.tab === "access") this.render();
    })();
    return this.accessLoading;
  }

  /** The resource's pages that have files, for the Page actions tab. */
  get pageFiles(): { name: string; kind: fapp.PageInfo["kind"]; file: string }[] {
    return (this.info?.pages ?? []).filter((p) => p.file).map((p) => ({ name: p.file!.split("/").pop()!.replace(/\.php$/, ""), kind: p.kind, file: `${this.root}/${p.file}` }));
  }

  /** Reads the header actions of the page the Page actions tab shows: the list page's, unless another was picked. */
  private async readPageActions() {
    const pages = this.pageFiles;
    if (!this.page && (this.manager || !pages.length)) return void this.roots.set("actions", { kind: "actions", missing: true });
    // A custom page's header actions are its own.
    const file = this.page ? this.file : (pages.find((p) => p.file === this.actionsPage)?.file ?? (pages.find((p) => p.kind === "list" || p.kind === "manage") ?? pages[0]).file);
    this.actionsPage = file;
    const doc = await this.doc(file);
    const cls = doc.outline.classes.find((c) => c.name);
    // `getActions()` is the older name, which Filament still reads.
    const root = cls && (readRoot(cls, "actions") ?? readRoot(cls, "actions", "getActions"));
    if (!root) this.roots.set("actions", { kind: "actions", missing: true });
    else if (root.custom) this.roots.set("actions", { kind: "actions", doc, error: root.custom, root });
    else this.roots.set("actions", { kind: "actions", doc, root });
  }

  /** Reads the files again after an edit, here or in the code editor, and redraws. */
  async refresh() {
    try {
      await this.readDocs();
    } catch (e) {
      this.loadError = e instanceof Error ? e.message : String(e);
    }
    const ref = this.currentRoot();
    if (this.selection && (!ref || !("root" in ref) || !ref.root || !resolve(ref.root, this.selection))) this.selection = null;
    this.render();
  }

  // ---- Editing ----

  /**
   * Applies edits to one file: `build` returns them against the file's current text, with classes named through
   * `imports`, which adds the `use` lines. Saves the file and reads it again.
   */
  async apply(doc: Doc, build: (imports: Imports, fill: (code: string) => string) => Edit[] | null, message: string, select?: Path | null) {
    const run = this.pending.then(() => this.applyNow(doc, build, message, select));
    this.pending = run.catch(() => {});
    return run;
  }

  /** The last change in flight; each change waits for it, so none computes its edits from code about to change. */
  private pending: Promise<unknown> = Promise.resolve();
  settled() {
    return this.pending;
  }

  private async applyNow(doc: Doc, build: (imports: Imports, fill: (code: string) => string) => Edit[] | null, message: string, select?: Path | null) {
    // Edits are computed against the text they were read from. If the code changed since, in the editor or by
    // another change, applying them would land in the wrong places, so the change is dropped and the view
    // catches up instead.
    if (doc.model.getValue() !== doc.text) {
      await this.refresh();
      this.message = "The code changed as you edited. Try again.";
      this.render();
      return;
    }
    const fresh = doc;
    // Code with syntax errors can be read wrong, and an edit from a wrong reading lands in the wrong place.
    if (fresh.outline.errors) {
      this.message = "Fix the syntax errors in the code first.";
      this.render();
      return;
    }
    const imports = new Imports(fresh.text, fresh.outline);
    const fill = (code: string) => code.replace(/\{\{([\w\\]+)\}\}/g, (_, fqn: string) => imports.name(fqn));
    let edits: Edit[] | null;
    try {
      edits = build(imports, fill);
    } catch (e) {
      return showError("Can't change the code", e);
    }
    if (!edits?.length) return;
    const added = [...edits, ...imports.edits()];
    const all = mergeEdits([...added, ...droppedImports(fresh.text, fresh.outline, added)]);
    const model = fresh.model;
    const pos = (offset: number) => {
      const p = model.getPositionAt(offset);
      return { line: p.lineNumber - 1, character: p.column - 1 };
    };
    this.applying = true;
    try {
      await applyWorkspaceEdit({ changes: { [model.uri.toString()]: all.map((e): L.TextEdit => ({ range: { start: pos(e.start), end: pos(e.end) }, newText: e.text })) } });
    } catch (e) {
      showError("Can't save the change", e);
    } finally {
      this.applying = false;
    }
    this.undo.push(fresh.path);
    this.redo = [];
    this.message = message;
    if (select !== undefined) this.selection = select;
    await this.refresh();
  }

  undoLast() {
    const path = this.undo.pop();
    if (!path) return host.status("Nothing to undo in the designer.");
    const doc = this.docs.get(path);
    if (!doc) return;
    this.applying = true;
    doc.model.undo();
    this.applying = false;
    this.redo.push(path);
    this.message = "Undone";
    void saveModel(doc.model).then(() => this.refresh(), (e) => showError("Can't save the file", e));
  }

  redoLast() {
    const path = this.redo.pop();
    if (!path) return;
    const doc = this.docs.get(path);
    if (!doc) return;
    this.applying = true;
    doc.model.redo();
    this.applying = false;
    this.undo.push(path);
    this.message = "Redone";
    void saveModel(doc.model).then(() => this.refresh(), (e) => showError("Can't save the file", e));
  }

  currentRoot(): RootRef | undefined {
    const kind = this.tab === "form" || this.tab === "table" || this.tab === "infolist" || this.tab === "actions" ? this.tab : null;
    return kind ? this.roots.get(kind) : undefined;
  }

  live(): { kind: RootKind; doc: Doc; root: Root } | null {
    const ref = this.currentRoot();
    return ref && "root" in ref && ref.root && !("error" in ref) ? (ref as { kind: RootKind; doc: Doc; root: Root }) : null;
  }

  /** The slot a reference names, with the node its call goes on when the slot doesn't exist yet. */
  private target(root: Root, to: SlotRef): { slot: Slot | undefined; owner: Comp | null; node: Root["node"] } | null {
    if (!to.owner) {
      const group = ROOT_SLOTS[root.kind].find((g) => g.includes(to.slot)) ?? [to.slot];
      return { slot: rootSlot(root, group), owner: null, node: root.node };
    }
    const found = resolve(root, to.owner);
    const comp = found?.entry.comp;
    if (!comp) return null;
    return { slot: slotNamed(comp, to.slot) ?? comp.slots.find((s) => s.via === to.slot), owner: comp, node: comp.node };
  }

  /** Edits that put `code` at `index` of a slot, adding the slot's call when it isn't there yet. */
  private insertEdits(text: string, root: Root, to: SlotRef, index: number, code: string): Edit[] {
    const t = this.target(root, to);
    if (!t) throw new Error("That place isn't in the code any more.");
    if (t.slot) return [insertItem(text, t.slot.array, index, code)];
    return [setCall(text, t.node, to.slot.replace(/#\d+$/, ""), `[\n    ${indentCode(code, "    ")},\n]`)];
  }

  /** The path of item `index` in a slot. */
  private pathIn(to: SlotRef, index: number): Path {
    return [...(to.owner ?? []), { slot: to.slot, index }];
  }

  async insert(to: SlotRef, index: number, gen: Gen | string, message: string) {
    await this.settled();
    const live = this.live();
    if (!live) return;
    await this.apply(live.doc, (imports, fill) => this.insertEdits(live.doc.text, live.root, to, index, typeof gen === "string" ? fill(gen) : renderGen(gen, (f) => imports.name(f))), message, this.pathIn(to, index));
  }

  async move(from: Path, to: SlotRef, index: number) {
    await this.settled();
    const live = this.live();
    if (!live) return;
    const found = resolve(live.root, from);
    if (!found) return;
    const { parent, last } = parentOf(from);
    const sameSlot = samePath(parent, to.owner ?? []) && last.slot === to.slot;
    const text = live.doc.text;
    if (sameSlot) {
      const target = index > last.index ? index - 1 : index;
      if (target === last.index) return;
      await this.apply(live.doc, () => moveItem(text, found.slot.array, last.index, index), "Moved", [...parent, { slot: last.slot, index: target }]);
      return;
    }
    const code = moveCode(text, found.slot.array.items[last.index].span, "");
    // Removing the item first shifts later items of its slot, and the target may be one of them.
    const adjust = (p: Path) => p.map((s, i) => (i === from.length - 1 && samePath(p.slice(0, i), from.slice(0, i)) && s.slot === last.slot && s.index > last.index ? { ...s, index: s.index - 1 } : s));
    const owner = to.owner ? adjust(to.owner) : null;
    await this.apply(live.doc, () => [removeItem(text, found.slot.array, last.index), ...this.insertEdits(text, live.root, to, index, code)], "Moved", this.pathIn({ owner, slot: to.slot }, index));
  }

  async remove(path: Path) {
    await this.settled();
    const live = this.live();
    const found = live && resolve(live.root, path);
    if (!live || !found) return;
    const { parent, last } = parentOf(path);
    const count = found.slot.entries.length;
    const next = count > 1 ? [...parent, { slot: last.slot, index: Math.min(last.index, count - 2) }] : parent.length ? parent : null;
    const label = found.entry.comp ? labelOf(found.entry.comp) : "code";
    await this.apply(live.doc, () => [removeItem(live.doc.text, found.slot.array, last.index)], `Deleted ${label}`, next);
  }

  async duplicate(path: Path) {
    await this.settled();
    const live = this.live();
    const found = live && resolve(live.root, path);
    if (!live || !found) return;
    const { last } = parentOf(path);
    const text = live.doc.text;
    const item = found.slot.array.items[last.index];
    let raw = text.slice(item.span[0], item.span[1]);
    // A field with the same name would fight over its value, so the copy gets a name of its own.
    const comp = found.entry.comp;
    const first = comp?.make.args.items[0];
    if (comp?.name && first?.value.kind === "string" && classInfo(this.cat!, comp.cls)?.kind !== "layout") {
      const taken = new Set<string>();
      walk(live.root, (c) => c.name && taken.add(c.name));
      let name = `${comp.name}_copy`;
      for (let n = 2; taken.has(name); n++) name = `${comp.name}_copy_${n}`;
      raw = raw.slice(0, first.value.span[0] - item.span[0]) + phpString(name) + raw.slice(first.value.span[1] - item.span[0]);
    }
    const code = reindent(raw, lineIndent(text, item.span[0]), "");
    await this.apply(live.doc, () => [insertItem(text, found.slot.array, last.index + 1, code)], "Duplicated", [...parentOf(path).parent, { slot: last.slot, index: last.index + 1 }]);
  }

  async wrap(path: Path, layout: string) {
    await this.settled();
    const live = this.live();
    const found = live && resolve(live.root, path);
    if (!live || !found) return;
    const { last } = parentOf(path);
    const text = live.doc.text;
    const code = moveCode(text, found.slot.array.items[last.index].value.span, "");
    const make = shortClass(layout) === "Grid" ? "2" : shortClass(layout) === "Fieldset" ? "'Details'" : "";
    await this.apply(live.doc, (imports) => [replaceItem(text, found.slot.array, last.index, `${imports.name(layout)}::make(${make})\n    ->schema([\n        ${indentCode(code, "        ")},\n    ])`)], `Wrapped in ${shortClass(layout)}`, [...path, { slot: "schema", index: 0 }]);
  }

  /** Sets, changes, or removes calls on components (the selected one when a change names no path). */
  async setCalls(changes: CallChange[], message = "Changed") {
    await this.settled();
    const live = this.live();
    if (!live || !this.selection) return;
    const text = live.doc.text;
    await this.apply(
      live.doc,
      (_imports, fill) =>
        changes.flatMap((ch) => {
          const comp = resolve(live.root, ch.path ?? this.selection!)?.entry.comp;
          if (!comp) return [];
          const existing = findCall(comp.node, ch.name);
          if (ch.args === null) return existing ? [removeCall(comp.node, existing)] : [];
          return [setCall(text, comp.node, ch.name, fill(ch.args))];
        }),
      message,
    );
  }

  /** Sets calls on the root itself, such as a table's default sort. */
  async setRootCalls(changes: { name: string; args: string | null }[], message = "Changed") {
    await this.settled();
    const live = this.live();
    if (!live) return;
    const text = live.doc.text;
    await this.apply(live.doc, (_imports, fill) =>
      changes.flatMap((ch) => {
        const existing = findCall(live.root.node, ch.name);
        if (ch.args === null) return existing ? [removeCall(live.root.node, existing)] : [];
        return [setCall(text, live.root.node, ch.name, fill(ch.args))];
      }),
    message);
  }

  async setMake(path: Path, args: string) {
    await this.settled();
    const live = this.live();
    const comp = live && resolve(live.root, path)?.entry.comp;
    if (!live || !comp) return;
    await this.apply(live.doc, (_i, fill) => [setArgs(live.doc.text, comp.make.args, fill(args))], "Renamed");
  }

  async changeType(path: Path, cls: string) {
    await this.settled();
    const live = this.live();
    const comp = live && resolve(live.root, path)?.entry.comp;
    if (!live || !comp || !this.cat) return;
    const next = classInfo(this.cat, cls);
    const methods = next ? methodsOf(this.cat, next) : null;
    const dropped = methods ? [...new Set(comp.calls.filter((c) => !methods.has(c.name)).map((c) => `${c.name}()`))] : [];
    if (dropped.length && !(await confirm(`${shortClass(cls)} doesn't have ${dropped.join(", ")}. Change the type and remove ${dropped.length === 1 ? "it" : "them"}?`, "Change and remove"))) return this.render();
    await this.apply(live.doc, (imports) => [
      { start: comp.make.classSpan[0], end: comp.make.classSpan[1], text: imports.name(cls) },
      // Settings the new type doesn't have would fail at runtime.
      ...(methods ? comp.calls.filter((c) => !methods.has(c.name)).map((c) => removeCall(comp.node, c)) : []),
    ], `Changed to ${shortClass(cls)}`);
  }

  /** Opens the code at a node, in the file that holds it. */
  reveal(node: { span: [number, number] }, doc = this.live()?.doc) {
    if (!doc) return;
    const p = doc.model.getPositionAt(node.span[0]);
    host.openAt(doc.path, p.lineNumber, p.column);
  }

  // ---- New components ----

  /** The code for a component new from the palette, with the children a container needs to be useful. */
  private newComponent(cls: string, name: string | null): string {
    const short = shortClass(cls);
    const c = `{{${cls}}}`;
    const arg = name !== null ? phpString(name) : "";
    const T = "Filament\\Schemas\\Components\\Tabs\\Tab";
    const S = "Filament\\Schemas\\Components\\Wizard\\Step";
    switch (short) {
      case "Section":
        return `${c}::make(${arg || "'Details'"})\n    ->schema([])`;
      case "Fieldset":
        return `${c}::make(${arg || "'Details'"})\n    ->schema([])`;
      case "Grid":
        return `${c}::make(2)\n    ->schema([])`;
      case "Group":
      case "FusedGroup":
        return `${c}::make()\n    ->schema([])`;
      case "Flex":
        return `${c}::make([])`;
      case "Tabs":
        return `${c}::make(${arg || "'Tabs'"})\n    ->tabs([\n        {{${T}}}::make('First')\n            ->schema([]),\n    ])`;
      case "Tab":
        return `${c}::make(${arg || "'Tab'"})\n    ->schema([])`;
      case "Wizard":
        return `${c}::make([\n    {{${S}}}::make('First')\n        ->schema([]),\n])`;
      case "Step":
        return `${c}::make(${arg || "'Step'"})\n    ->schema([])`;
      case "Repeater":
        return `${c}::make(${arg})\n    ->schema([])`;
      case "Builder":
        return `${c}::make(${arg})\n    ->blocks([])`;
      case "Text":
        return `${c}::make(${arg || "'Text'"})`;
      case "Callout":
        return `${c}::make(${arg || "'Note'"})`;
      case "ActionGroup":
      case "BulkActionGroup":
      case "Actions":
        return `${c}::make([])`;
      case "Split":
      case "Stack":
        return `${c}::make([])`;
      case "Html":
        return `${c}::make('<p></p>')`;
    }
    return `${c}::make(${arg})`;
  }

  /** Whether a new component of a class needs a name: fields, columns, entries, filters, and custom actions do. */
  private needsName(cls: string): boolean {
    const info = this.cat && classInfo(this.cat, cls);
    const first = info?.make[0];
    if (!info || !first || first.name !== "name") return false;
    if (["field", "column", "entry"].includes(info.kind)) return true;
    if (info.kind === "filter") return shortClass(cls) !== "TrashedFilter";
    return !first.optional || ["Action", "BulkAction"].includes(shortClass(cls));
  }

  /** Names a new component: the model's columns not yet used come first. */
  private async nameFor(cls: string, anchor: HTMLElement | { x: number; y: number }): Promise<string | null> {
    const info = this.cat && classInfo(this.cat, cls);
    const live = this.live();
    const kind = info?.kind;
    const used = new Set<string>();
    // Filters are named apart from columns, so a column the table shows can still be filtered on.
    if (live) walk(live.root, (c) => c.name && (kind !== "filter" || classInfo(this.cat!, c.cls)?.kind === "filter") && used.add(c.name));
    const facts = this.facts;
    const columns = (facts?.columns ?? []).filter((c) => kind !== "filter" || (facts && filterFor(c, facts)?.cls === cls));
    const suggestions =
      kind === "action" || kind === "bulkAction"
        ? []
        : [
            ...columns.filter((c) => !used.has(c.name) && (kind !== "field" || !isSystemColumn(c))).map((c) => ({ value: c.name, detail: c.type })),
            ...(kind === "column" || kind === "entry" ? (this.facts?.relations ?? []).map((r) => ({ value: `${r.name}.${this.facts?.titles?.[r.related ?? ""] ?? "name"}`, detail: r.type })) : []),
            ...(kind === "filter" && shortClass(cls) === "SelectFilter" ? (this.facts?.relations ?? []).filter((r) => /BelongsTo/.test(r.type) && !used.has(r.name)).map((r) => ({ value: r.name, detail: r.type })) : []),
          ];
    return askName(anchor, {
      title: `${shortClass(cls)}: ${kind === "action" || kind === "bulkAction" ? "action name" : kind === "filter" ? "filter name" : "column"}`,
      placeholder: kind === "action" || kind === "bulkAction" ? "publish" : "title",
      suggestions,
      validate: (v) => (/^[A-Za-z_][\w.]*$/.test(v) ? (used.has(v) && kind === "field" ? "The form already has a field with that name." : null) : "Use letters, digits, underscores, and dots."),
    });
  }

  /** Adds a new component of a class at a place, asking for its name when it needs one. */
  async addNew(cls: string, to: SlotRef, index: number, anchor: HTMLElement | { x: number; y: number }) {
    const name = this.needsName(cls) ? await this.nameFor(cls, anchor) : null;
    if (this.needsName(cls) && name === null) return;
    // A model column gets the component that suits it, with its settings, rather than a bare one. A filter can be
    // named for a relationship, which stands for its foreign key column.
    const facts = this.facts;
    const kind = this.cat && classInfo(this.cat, cls)?.kind;
    const rel = kind === "filter" && name ? facts?.relations.find((r) => r.name === name && /BelongsTo/.test(r.type)) : undefined;
    const column = name && facts?.columns.find((c) => c.name === name || (rel && c.name === (rel.foreignKey ?? `${name.replace(/([A-Z])/g, "_$1").toLowerCase()}_id`)));
    const gen = column && facts ? (kind === "filter" ? filterFor(column, facts) : this.genFor(column, to)) : null;
    if (gen && gen.cls === cls) return this.insert(to, index, gen, `Added ${shortClass(cls)} ${name}`);
    await this.insert(to, index, this.newComponent(cls, name), `Added ${shortClass(cls)}${name ? ` ${name}` : ""}`);
  }

  /** The component for a model column in the current tab. */
  private genFor(column: Column, to?: SlotRef): Gen | null {
    if (!this.facts) return null;
    if (this.inActionForm(to?.owner ?? null)) return formField(column, this.facts);
    return this.tab === "table" ? tableColumn(column, this.facts) : this.tab === "infolist" ? infolistEntry(column, this.facts) : formField(column, this.facts);
  }

  async addColumn(name: string, to: SlotRef, index: number) {
    const column = this.facts?.columns.find((c) => c.name === name);
    const gen = column && this.genFor(column, to);
    if (gen) await this.insert(to, index, gen, `Added ${name}`);
  }

  /** Adds every model column the form, table, or infolist doesn't show yet. */
  async addMissing() {
    await this.settled();
    const live = this.live();
    if (!live || !this.facts) return;
    const used = new Set<string>();
    walk(live.root, (c) => c.name && used.add(c.name.split(".")[0]));
    const relUsed = (col: Column) => this.facts!.relations.some((r) => used.has(r.name) && col.name === `${r.name.replace(/([A-Z])/g, "_$1").toLowerCase()}_id`);
    const columns = this.facts.columns.filter((c) => !used.has(c.name) && !relUsed(c) && !/password|token|secret/.test(c.name) && (this.tab === "table" ? c.name !== "id" : !isSystemColumn(c)));
    if (!columns.length) return host.status("Every column is already there.");
    const slotName = live.kind === "table" ? "columns" : (live.root.slots.has("schema") ? "schema" : "components");
    const slot = live.kind === "table" ? live.root.slots.get("columns") : rootSlot(live.root, ["components", "schema"]);
    const start = slot?.entries.length ?? 0;
    const text = live.doc.text;
    await this.apply(
      live.doc,
      (imports) => {
        const codes = columns.map((c) => renderGen(this.genFor(c)!, (f) => imports.name(f)));
        if (slot) return [insertItem(text, slot.array, start, codes.join(",\n"))];
        return [setCall(text, live.root.node, slotName, `[\n    ${codes.map((c) => indentCode(c, "    ")).join(",\n    ")},\n]`)];
      },
      `Added ${columns.length} ${columns.length === 1 ? "column" : "columns"}`,
      null,
    );
  }

  // ---- Rendering ----

  render() {
    const t = this.translations;
    const locale = this.locale;
    setTranslator(t && locale ? (key) => translate(t, locale, key).text : null);
    const keepScroll = this.el.querySelector<HTMLElement>(".fd-canvas");
    if (keepScroll) this.scroll.set(this.tab, keepScroll.scrollTop);
    const main = this.loadError ? this.errorView(this.loadError) : this.renderTab();
    this.el.replaceChildren(this.header(), this.tabs(), main, this.footer());
    const canvas = this.el.querySelector<HTMLElement>(".fd-canvas");
    if (canvas) canvas.scrollTop = this.scroll.get(this.tab) ?? 0;
    // The selection stays in view as the keys move it.
    this.el.querySelector(".fd-item.selected, .fd-th.selected, .fd-chip-item.selected")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private errorView(message: string) {
    return h("div", { class: "fd-error" }, icon("warning"), h("div", {}, h("strong", {}, "The designer can't show this resource"), h("p", {}, message), h("div", { class: "fd-error-actions" }, h("button", { type: "button", onclick: () => void this.load() }, icon("refresh"), "Try again"), h("button", { type: "button", onclick: () => host.openAt(this.file, 1) }, icon("go-to-file"), "Open the code"))));
  }

  private header() {
    const info = this.info;
    const pageInfo = this.page ? this.panel?.pages.find((p) => p.class === this.cls?.fqn) : undefined;
    const title = this.page ? (pageInfo?.label ?? humanize(this.cls?.name ?? "Page")) : this.manager ? humanize(this.cls?.name.replace(/RelationManager$/, "") ?? "") : (info?.navigationLabel ?? (info?.pluralLabel ? info.pluralLabel.replace(/^./, (c) => c.toUpperCase()) : humanize(this.cls?.name.replace(/Resource$/, "") ?? "Resource")));
    const panel = this.panel;
    const model = this.facts?.class ?? info?.model;
    const doc = this.docs.get(this.file);
    return h(
      "header",
      { class: "fd-header" },
      h("span", { class: "fd-header-icon" }, (info?.navigationIcon ?? pageInfo?.navigationIcon) ? heroicon(this.cat?.heroiconsDir ?? null, info?.navigationIcon ?? pageInfo?.navigationIcon) : icon(this.page ? "file" : this.widget ? "graph" : this.manager ? "references" : "symbol-structure")),
      h(
        "div",
        { class: "fd-header-titles" },
        h("h1", {}, title || "Resource"),
        h(
          "div",
          { class: "fd-header-chips" },
          h("span", { class: "fd-chip-static", title: this.file }, this.page ? "Page" : this.widget ? "Table widget" : this.manager ? "Relation manager" : "Resource", " · ", this.cls?.name ?? ""),
          model ? h("button", { type: "button", class: "fd-chip-link", title: "Open the model", onclick: () => this.openModel() }, icon("database"), shortClass(model)) : null,
          panel ? h("span", { class: "fd-chip-static", title: "Panel" }, icon("window"), panel.id) : null,
          this.facts?.details.tableExists === false ? h("span", { class: "fd-chip-warn", title: "The database has no table for the model yet. Run the migrations." }, icon("warning"), "No table") : null,
          doc?.outline.errors ? h("span", { class: "fd-chip-warn", title: "The code has syntax errors. The designer shows what it could read." }, icon("warning"), "Syntax errors") : null,
        ),
      ),
      h("span", { class: "fd-spacer" }),
      this.localePicker(),
      iconButton("discard", "Undo (⌘Z)", () => this.undoLast()),
      iconButton("redo", "Redo (⇧⌘Z)", () => this.redoLast()),
      iconButton("code", "Open the code", () => {
        const ref = this.currentRoot();
        if (ref && "doc" in ref) this.reveal(ref.root?.node ?? { span: [0, 0] }, ref.doc);
        else host.openAt(this.file, 1);
      }),
      panel?.url && info?.slug ? iconButton("link-external", "Open in the browser", () => host.openUrl(`${panel.url}/${info.slug}`)) : null,
      info && !this.manager && !this.page ? iconButton("beaker", "Generate tests", () => void import("./resourcetests").then((m) => m.generateResourceTests(this.file))) : null,
      iconButton("refresh", "Read the app again", () => (fapp.forget(), void this.load())),
    );
  }

  /** The language the canvas shows `__()` text in, when the app has translations. */
  private localePicker() {
    const t = this.translations;
    if (!t) return null;
    const select = h("select", { class: "fd-locale", title: "Preview the text in a language. Text written with __() shows its translation." }, h("option", { value: "", textContent: "As written" }), ...t.locales.map((l) => h("option", { value: l, textContent: l, selected: l === this.locale })), h("option", { value: "+", textContent: "Add a language…" }));
    select.onchange = async () => {
      if (select.value === "+") {
        select.value = this.locale ?? "";
        const code = await askName(select, { title: "New language", placeholder: "ar, fr, pt_BR", suggestions: [], validate: (v) => (/^[a-z]{2,3}([-_][A-Za-z]{2,4})?$/.test(v) ? (t.json[v] ? "The app has that language." : null) : "Use a language code, such as fr or pt_BR.") });
        if (!code) return;
        const { invoke } = await import("@tauri-apps/api/core");
        const path = `${t.dir}/${code}.json`;
        if (!(await invoke<boolean>("path_exists", { path }))) await invoke("create_file", { path, contents: "{}\n" });
        t.json[code] ??= {};
        if (!t.locales.includes(code)) t.locales.push(code), t.locales.sort();
        select.value = code;
      }
      this.locale = select.value || null;
      try {
        localStorage.setItem(`fd-locale:${this.root}`, select.value);
      } catch {}
      this.render();
    };
    return h("label", { class: "fd-locale-picker" }, icon("globe"), select);
  }

  /** Writes a translation to the app's lang files, or removes it when `value` is empty. */
  async writeTranslation(locale: string, key: string, value: string) {
    if (!this.translations) return;
    try {
      await writeTranslation(this.translations, locale, key, value);
      this.message = `Translated to ${locale}`;
      this.render();
    } catch (e) {
      showError("Can't write the translation", e);
    }
  }

  /** Renames a key in the locales' JSON files, so a label's text and its translations change together. */
  renameTranslation(from: string, to: string) {
    return this.translations ? renameTranslation(this.translations, from, to) : Promise.resolve();
  }

  private openModel() {
    const file = this.facts?.details.file ?? this.info?.modelFile;
    if (!file) return;
    if (this.page && this.cls && propertyNamed(this.cls, "settings")) return void import("./settingsdesigner").then((m) => m.openSettingsDesigner(file.startsWith("/") ? file : `${this.root}/${file}`));
    void import("./modeldesigner").then((m) => m.openModelDesigner(file.startsWith("/") ? file : `${this.root}/${file}`));
  }

  private tabs() {
    const has = (k: RootKind) => { const r = this.roots.get(k); return !!r && !("missing" in r); };
    const tabs: Tab[] = this.page ? [...(["form", "table"] as const).filter(has), "actions", "access", "settings"] : this.widget ? ["table", "access"] : this.manager ? ["form", "table", "infolist"] : ["form", "table", "infolist", "actions", "relations", "pages", "access", "settings"];
    const count = (t: Tab) => {
      if (t === "relations") return this.info?.relations.length;
      if (t === "pages") return this.info?.pages.length;
      const ref = this.roots.get(t as RootKind);
      if (!ref || !("root" in ref) || !ref.root) return undefined;
      let n = 0;
      walk(ref.root, () => n++);
      return n;
    };
    return h(
      "nav",
      { class: "fd-tabs-nav", role: "tablist" },
      ...tabs.map((t) => {
        const n = count(t);
        const ref = t === "form" || t === "table" || t === "infolist" || t === "actions" ? this.roots.get(t) : undefined;
        const missing = !!ref && "missing" in ref;
        return h(
          "button",
          { type: "button", role: "tab", class: `${t === this.tab ? "active" : ""}${missing ? " missing" : ""}`, ariaSelected: String(t === this.tab), onclick: () => this.switchTab(t) },
          icon(TAB_ICONS[t]),
          t === "actions" ? "Page actions" : humanize(t),
          n ? h("span", { class: "fd-count" }, String(n)) : null,
        );
      }),
    );
  }

  switchTab(t: Tab) {
    if (t === this.tab) return;
    this.tab = t;
    this.selection = null;
    closePopover();
    this.render();
  }

  private footer() {
    const ref = this.currentRoot();
    const where = (ref && "doc" in ref ? ref.doc.path : this.tab === "actions" && this.actionsPage ? this.actionsPage : this.tab === "access" && this.access?.doc ? this.access.doc.path : this.file).slice(this.root.length + 1);
    // A class outside the resource's folder can be shared, such as one table for two panels' resources.
    const folder = this.file.slice(0, this.file.lastIndexOf("/"));
    const shared = ref && "doc" in ref && !ref.doc.path.startsWith(`${folder}/`);
    return h("footer", { class: "fd-footer" }, h("span", { class: "fd-footer-file", title: "The file this tab edits" }, icon("file-code"), where), shared ? h("span", { class: "fd-chip-warn", title: "This class is outside the resource's folder, so other resources may use it too. Changes here change them as well." }, icon("warning"), "Possibly shared") : null, h("span", { class: "fd-spacer" }), this.message ? h("span", { class: "fd-footer-message" }, icon("check"), this.message, " · saved") : null);
  }

  private renderTab(): HTMLElement {
    if (this.tab === "relations") return renderRelationsTab(this);
    if (this.tab === "pages") return renderPagesTab(this);
    if (this.tab === "settings") return renderSettingsTab(this);
    if (this.tab === "access") return this.page || this.widget ? this.entryAccess() : renderAccessTab(this);
    const ref = this.roots.get(this.tab as RootKind);
    if (!ref || "missing" in ref) return this.missingRoot(this.tab as RootKind);
    if ("error" in ref) return h("div", { class: "fd-error" }, icon("code"), h("div", {}, h("strong", {}, `The ${this.tab} is built by code the designer doesn't read`), h("p", {}, ref.error), h("div", { class: "fd-error-actions" }, h("button", { type: "button", onclick: () => this.reveal(ref.root?.node ?? { span: [0, 0] }, ref.doc) }, icon("go-to-file"), "Open the code"))));
    return this.workspace(ref);
  }

  /** A tab for a form, table, or infolist the resource doesn't have yet, with a button that adds it. */
  private missingRoot(kind: RootKind) {
    if (kind === "actions") {
      const page = this.actionsTarget();
      if (!page) return h("div", { class: "fd-error fd-empty-root" }, icon(TAB_ICONS.actions), h("div", {}, h("strong", {}, "The resource has no pages in its folder"), h("p", {}, "Header actions belong to a page, such as the list or edit page. Add pages on the Pages tab.")));
      return h(
        "div",
        { class: "fd-actions-empty" },
        this.pageSwitcher(),
        h("div", { class: "fd-error fd-empty-root" }, icon(TAB_ICONS.actions), h("div", {}, h("strong", {}, `${humanize(page.name)} has no header actions`), h("p", {}, "Header actions are buttons at the top of the page, beside its title, such as New or Delete."), h("div", { class: "fd-error-actions" }, h("button", { type: "button", class: "primary", onclick: () => void this.addRoot("actions") }, icon("add"), "Add header actions")))),
      );
    }
    const what = { form: "a form", table: "a table", infolist: "an infolist" }[kind];
    const why = { form: "The form creates and edits records.", table: "The table lists records on the resource's index page.", infolist: "An infolist shows a record on its View page, read-only." }[kind];
    return h("div", { class: "fd-error fd-empty-root" }, icon(TAB_ICONS[kind]), h("div", {}, h("strong", {}, `This ${this.manager ? "relation manager" : "resource"} has no ${kind}`), h("p", {}, why), h("div", { class: "fd-error-actions" }, h("button", { type: "button", class: "primary", onclick: () => void this.addRoot(kind) }, icon("add"), `Add ${what}`))));
  }

  /** Adds a form, table, or infolist method, filled from the model's columns. */
  async addRoot(kind: RootKind) {
    await this.settled();
    if (kind === "actions") return this.addHeaderActions();
    const doc = this.docs.get(this.file);
    if (!doc || !this.cls) return;
    const cls = this.cls;
    const isStatic = !this.manager;
    const param = kind === "table" ? "table" : "schema";
    const type = kind === "table" ? "Filament\\Tables\\Table" : "Filament\\Schemas\\Schema";
    const slot = kind === "table" ? "columns" : "components";
    const columns = (this.facts?.columns ?? []).filter((c) => (kind === "table" ? c.name !== "id" : !isSystemColumn(c)));
    await this.apply(
      doc,
      (imports) => {
        const T = imports.name(type);
        const items = this.facts ? columns.map((c) => renderGen(kind === "table" ? tableColumn(c, this.facts!) : kind === "infolist" ? infolistEntry(c, this.facts!) : formField(c, this.facts!), (f) => imports.name(f))) : [];
        const body = items.length ? `[\n            ${items.map((i) => indentCode(i, "            ")).join(",\n            ")},\n        ]` : "[\n            //\n        ]";
        const method = `public${isStatic ? " static" : ""} function ${kind}(${T} $${param}): ${T}\n{\n    return $${param}\n        ->${slot}(${body});\n}`;
        // After the other schema methods, or at the end of the class.
        const after = ["infolist", "table", "form"].map((n) => cls.methods.find((m) => m.name === n)).find(Boolean);
        if (after) return [{ start: after.span[1], end: after.span[1], text: `\n\n    ${indentCode(method, "    ")}` }];
        return [{ start: cls.bodyEnd, end: cls.bodyEnd, text: `\n    ${indentCode(method, "    ")}\n` }];
      },
      `Added the ${kind}`,
      null,
    );
  }

  /** Adds `getHeaderActions()` to the page the Page actions tab shows, with the actions that page usually has. */
  /**
   * Picks an importer or exporter for an import or export action: the model's first, then the app's others, or a new
   * one Filament generates from the model's columns, which then opens in its designer.
   */
  private async pickPorter(kind: "importer" | "exporter", anchor: HTMLElement, set: (fqn: string) => void) {
    const all = await fapp.porters(this.root).catch(() => null);
    const list = (kind === "importer" ? all?.importers : all?.exporters) ?? [];
    const model = this.facts?.class ?? null;
    const mine = list.filter((p) => p.model === model);
    const others = list.filter((p) => p.model !== model);
    const choose = (fqn: string) => (p.close(), set(fqn));
    const create = async () => {
      if (!model) return;
      p.close();
      // Filament's generator takes the model under App\Models, with folders, or its namespace apart.
      const rel = model.startsWith("App\\Models\\") ? model.slice(11).replace(/\\/g, "/") : shortClass(model);
      const args = [`make:filament-${kind}`, rel, "--generate", ...(model.startsWith("App\\Models\\") ? [] : [`--model-namespace=${model.slice(0, model.lastIndexOf("\\"))}`])];
      try {
        host.status(`Making the ${kind}…`);
        const out = await fapp.artisan(this.root, args);
        const fqn = /\[([\w\\]+(?:Importer|Exporter))\]/.exec(out.replace(/\x1b\[[\d;]*m/g, ""))?.[1];
        fapp.forget(["app:porters"]);
        if (!fqn) return host.status(`Made the ${kind}, but couldn't tell its class: ${out.trim().slice(0, 120)}`);
        set(fqn);
        const file = await fapp.fileOfClass(this.root, fqn);
        if (file) void import("./porterdesigner").then((m) => m.openPorter(file));
      } catch (e) {
        showError(`Can't make the ${kind}`, e);
      }
    };
    const row = (x: fapp.PorterInfo) => h("button", { type: "button", class: "fd-menu-item", onclick: () => choose(x.class) }, icon("table"), h("span", {}, shortClass(x.class)), h("span", { class: "fd-note" }, x.model ? shortClass(x.model) : ""));
    const p = popover(
      anchor,
      h(
        "div",
        { class: "fd-menu fd-porter-menu" },
        ...mine.map(row),
        model ? h("button", { type: "button", class: "fd-menu-item", onclick: () => void create() }, icon("add"), h("span", {}, `New ${kind} for ${shortClass(model)}`), h("span", { class: "fd-note" }, "from its columns")) : null,
        others.length ? h("div", { class: "fd-menu-sep" }, "Other models") : null,
        ...others.map(row),
      ),
    );
  }

  /** The app's translations, for editors of text written with `__()`. */
  i18n(): InspectorCtx["i18n"] {
    return this.translations ? { t: this.translations, locale: this.locale, write: (locale, key, value) => void this.writeTranslation(locale, key, value), rename: (from, to) => this.renameTranslation(from, to) } : undefined;
  }

  /** A page's or widget's Access tab. */
  private entryAccess() {
    const doc = this.docs.get(this.file);
    if (!doc || !this.cls) return h("div");
    const load = async () => {
      try {
        this.entry = { info: await fapp.entryAccess(this.root, this.cls!.fqn), error: "" };
      } catch (e) {
        this.entry = { info: null, error: e instanceof Error ? e.message : String(e) };
      }
      if (this.tab === "access") this.render();
    };
    return renderEntryAccess({
      root: this.root,
      kind: this.page ? "page" : "widget",
      fqn: this.cls.fqn,
      text: doc.text,
      cls: this.cls,
      host,
      ...this.entry,
      load: () => (this.entry.info || this.entry.error ? (fapp.forget([`policy:entry:${this.cls!.fqn}`]), load()) : load()),
      reveal: (offset) => this.reveal({ span: [offset, offset] }, doc),
      edit: (build, message) => this.apply(doc, (_imports, fill) => build(doc.text, this.cls!, fill), message),
    });
  }

  /** The page whose header actions the tab shows: a resource's page, or a custom page itself. */
  private actionsTarget() {
    if (this.page && this.cls) return { name: this.cls.name, kind: "custom" as const, file: this.file };
    return this.pageFiles.find((p) => p.file === this.actionsPage);
  }

  private async addHeaderActions() {
    const page = this.actionsTarget();
    const doc = page && this.docs.get(page.file);
    const cls = doc?.outline.classes.find((c) => c.name);
    if (!page || !doc || !cls) return;
    const A = (name: string) => `{{Filament\\Actions\\${name}}}::make()`;
    const has = (k: string) => this.pageFiles.some((p) => p.kind === k);
    const seed = page.kind === "list" ? (has("create") || !has("manage") ? [A("CreateAction")] : []) : page.kind === "manage" ? [A("CreateAction")] : page.kind === "edit" ? [...(has("view") ? [A("ViewAction")] : []), A("DeleteAction")] : page.kind === "view" ? [A("EditAction")] : [];
    await this.apply(
      doc,
      (_imports, fill) => {
        const method = `protected function getHeaderActions(): array\n{\n    return [${seed.length ? `\n${seed.map((a) => `        ${fill(a)},\n`).join("")}    ` : ""}];\n}`;
        return [addMember(doc.text, cls, method)];
      },
      "Added header actions",
      null,
    );
  }

  /** Buttons that pick the page whose header actions the tab shows. */
  private pageSwitcher() {
    const names: Record<string, string> = { list: "List", create: "Create", edit: "Edit", view: "View", manage: "Manage" };
    return h(
      "div",
      { class: "fd-page-switch", role: "tablist" },
      ...this.pageFiles.map((p) =>
        h("button", { type: "button", class: p.file === this.actionsPage ? "active" : "", title: p.file.slice(this.root.length + 1), onclick: async (e: MouseEvent) => {
          e.stopPropagation();
          if (p.file === this.actionsPage) return;
          this.actionsPage = p.file;
          this.selection = null;
          await this.readPageActions();
          this.render();
        } }, names[p.kind] ?? humanize(p.name)),
      ),
    );
  }

  /** The title a page shows, as Filament writes it: the plural label on the list, "Edit post" on the edit page. */
  private pageTitle(): string {
    if (this.page) return this.panel?.pages.find((p) => p.class === this.cls?.fqn)?.label ?? humanize(this.cls?.name ?? "Page");
    const page = this.pageFiles.find((p) => p.file === this.actionsPage);
    const label = this.info?.label ?? humanize(shortClass(this.info?.model ?? "Record")).toLowerCase();
    const plural = this.info?.navigationLabel ?? this.info?.pluralLabel ?? `${label}s`;
    const cap = (x: string) => x.replace(/^./, (c) => c.toUpperCase());
    switch (page?.kind) {
      case "create":
        return `Create ${label}`;
      case "edit":
        return `Edit ${label}`;
      case "view":
        return `View ${label}`;
      case "list":
      case "manage":
        return cap(plural);
    }
    return humanize(page?.name ?? "Page");
  }

  /** The action whose modal shows: the selected action, or the action whose form holds the selection. */
  modalAction(root: Root): { path: Path; comp: Comp } | null {
    for (let i = this.selection?.length ?? 0; i > 0; i--) {
      const path = this.selection!.slice(0, i);
      const comp = resolve(root, path)?.entry.comp;
      const kind = comp && this.cat && classInfo(this.cat, comp.cls)?.kind;
      // Import and export actions draw their own modal, from the importer or exporter.
      if (comp && (kind === "action" || kind === "bulkAction")) return /(Import|Export|ExportBulk)Action$/.test(comp.cls) ? null : { path, comp };
    }
    return null;
  }

  /** Whether a place is in an action's form, where fields go whatever the tab. */
  private inActionForm(owner: Path | null): boolean {
    const live = this.live();
    if (!owner || !live || !this.cat) return false;
    for (let i = owner.length; i > 0; i--) {
      const comp = resolve(live.root, owner.slice(0, i))?.entry.comp;
      const kind = comp && classInfo(this.cat, comp.cls)?.kind;
      if (kind === "action" || kind === "bulkAction") return true;
    }
    return false;
  }

  /** What a custom action works with: the row's record, the selected records, or neither. */
  private scopeOf(path: Path, kind: string): Scope | null {
    if (kind === "bulkAction") return "records";
    const slot = path[0]?.slot;
    if (this.tab === "table") return slot === "recordActions" || slot === "actions" ? "record" : slot === "headerActions" || slot === "toolbarActions" ? "none" : null;
    if (this.tab === "actions") {
      const page = this.pageFiles.find((p) => p.file === this.actionsPage);
      return page?.kind === "edit" || page?.kind === "view" ? "record" : "none";
    }
    return this.tab === "infolist" ? "record" : null;
  }

  /** The palette, the canvas, and the inspector. */
  private workspace(ref: { kind: RootKind; doc: Doc; root: Root }) {
    const ctx = this.canvasCtx(ref);
    const canvas = h("div", { class: `fd-canvas fd-canvas-${ref.kind}` });
    canvas.onclick = () => this.select(null);
    if (isRtl(this.locale)) canvas.dir = "rtl";
    canvas.append(ref.kind === "actions" ? h("div", {}, this.pageSwitcher(), this.page ? null : renderPageWidgets(this), renderPageActions(ctx, this.pageTitle())) : ref.kind === "table" ? renderTable(ctx, { label: this.info?.label ?? undefined, pluralLabel: this.info?.navigationLabel ?? (this.info?.pluralLabel ? this.info.pluralLabel.replace(/^./, (c) => c.toUpperCase()) : undefined) ?? humanize(this.cls?.name.replace(/(Resource|RelationManager)$/, "") ?? "Records"), createPage: !!this.info?.pages.some((p) => p.kind === "create" || p.kind === "manage") }) : h("div", { class: "fd-form-page" }, renderSchema(ctx, ref.root.slots.has("schema") ? "schema" : "components")));
    const modal = this.modalAction(ref.root);
    if (modal) canvas.append(renderActionModal(ctx, modal.path, modal.comp));
    canvas.addEventListener("dragleave", (e) => !canvas.contains(e.relatedTarget as Node) && hideLine());
    if (ref.doc.outline.errors)
      canvas.prepend(
        h(
          "div",
          { class: "fd-helper-note fd-error-note" },
          icon("warning"),
          h("span", {}, "This file has syntax errors, so the designer may read it wrong. It won't change the file until the errors are fixed."),
          h("button", { type: "button", class: "fd-chip-link", onclick: (e: MouseEvent) => (e.stopPropagation(), host.openAt(ref.doc.path, 1)) }, "Open the code"),
        ),
      );
    const helper = ref.root.helper;
    if (helper) {
      const where = helper.class === "self" || helper.class === "static" ? "" : `${shortClass(helper.class)}::`;
      const method = (helper.class === "self" || helper.class === "static" ? this.cls : null)?.methods.find((m) => m.name === helper.method);
      canvas.prepend(
        h(
          "div",
          { class: "fd-helper-note" },
          icon("info"),
          h("span", {}, `Part of this ${ref.kind} comes from ${where}${helper.method}(), which the designer doesn't show. What it shows here, you can change.`),
          method ? h("button", { type: "button", class: "fd-chip-link", onclick: (e: MouseEvent) => (e.stopPropagation(), this.reveal(method, ref.doc)) }, "Open it") : null,
        ),
      );
    }
    return h("div", { class: "fd-work" }, this.palette(ref, ctx), canvas, h("aside", { class: "fd-inspector" }, this.inspector(ref, ctx)));
  }

  private canvasCtx(ref: { kind: RootKind; doc: Doc; root: Root }): CanvasCtx {
    return {
      cat: this.cat!,
      root: ref.root,
      selection: this.selection,
      iconsDir: this.cat?.heroiconsDir ?? null,
      active: this.active,
      select: (path) => this.select(path),
      drop: (drag, to, index) => void this.drop(drag, to, index),
      menu: (path, x, y) => this.menu(path, x, y),
      add: (to, anchor) => this.addMenu(to, anchor),
      redraw: () => this.render(),
    };
  }

  select(path: Path | null) {
    if (samePath(path, this.selection)) return;
    this.selection = path;
    this.render();
    this.el.focus({ preventScroll: true });
  }

  private async drop(drag: Drag, to: SlotRef, index: number) {
    const point = lastPointer;
    if (drag.kind === "move") return this.move(drag.path, to, index);
    if (drag.kind === "column") return this.addColumn(drag.name, to, index);
    await this.addNew(drag.cls, to, index, point);
  }

  /** The "+" menu of a slot: the classes it takes, the common ones first, then the model's columns. */
  private addMenu(to: SlotRef, anchor: HTMLElement) {
    const live = this.live();
    if (!live || !this.cat) return;
    const t = this.target(live.root, to);
    const slotName = to.slot.replace(/#\d+$/, "");
    const inForm = this.inActionForm(to.owner);
    const kinds = inForm ? PALETTE_KINDS.form : to.owner ? (t?.owner && /ActionGroup$/.test(t.owner.cls) ? PALETTE_KINDS.recordActions : live.kind === "table" ? PALETTE_KINDS.columns : PALETTE_KINDS[live.kind === "infolist" ? "infolist" : "form"]) : (PALETTE_KINDS[slotName === "actions" ? "recordActions" : slotName === "bulkActions" || slotName === "groupedBulkActions" ? "toolbarActions" : slotName] ?? PALETTE_KINDS[live.kind === "infolist" ? "infolist" : "form"]);
    const special = slotName === "tabs" ? "Tab" : slotName === "steps" ? "Step" : slotName === "blocks" ? "Block" : "";
    const search = h("input", { type: "search", class: "fd-add-search", placeholder: "Search components", spellcheck: false });
    const list = h("div", { class: "fd-add-list" });
    const index = t?.slot?.entries.length ?? 0;
    const render = () => {
      const groups = special ? [{ label: special, classes: this.cat!.classes.filter((c) => shortClass(c.class) === special) }] : palette(this.cat!, kinds, search.value);
      const columns = inForm || !to.owner || live.kind !== "table" ? (this.facts?.columns ?? []).filter((c) => !isSystemColumn(c) || (live.kind === "table" && !inForm)) : [];
      const q = search.value.trim().toLowerCase();
      list.replaceChildren(
        ...(columns.length && !special && (slotName === "components" || slotName === "schema" || slotName === "columns")
          ? [h("div", { class: "fd-add-group" }, "Model columns"), ...columns.filter((c) => !q || c.name.includes(q)).slice(0, 12).map((c) => h("button", { type: "button", class: "fd-add-item", onclick: () => (p.close(), void this.addColumn(c.name, to, index)) }, icon("database"), h("span", {}, c.name), h("span", { class: "fd-add-detail" }, c.type)))]
          : []),
        ...groups.flatMap((g) => [
          h("div", { class: "fd-add-group" }, g.label),
          ...g.classes.map((c) => h("button", { type: "button", class: "fd-add-item", title: look(c).hint ?? c.class, onclick: () => (p.close(), void this.addNew(c.class, to, index, anchor)) }, icon(look(c).icon), h("span", {}, shortClass(c.class)), look(c).hint ? h("span", { class: "fd-add-detail" }, look(c).hint!) : null)),
        ]),
      );
    };
    search.oninput = render;
    const p = popover(anchor, h("div", { class: "fd-add" }, search, list));
    render();
    requestAnimationFrame(() => search.focus());
  }

  private menu(path: Path, x: number, y: number) {
    void import("./files").then(({ showMenu }) =>
      showMenu(x, y, [
        { label: "Duplicate", keys: "⌘D", run: () => void this.duplicate(path) },
        { label: "Wrap in", items: ["Section", "Grid", "Fieldset", "Group"].map((n) => ({ label: n, run: () => void this.wrap(path, `Filament\\Schemas\\Components\\${n}`) })) },
        { label: "Move Up", keys: "⌥↑", run: () => void this.nudge(path, -1) },
        { label: "Move Down", keys: "⌥↓", run: () => void this.nudge(path, 1) },
        "-",
        { label: "Show in Code", run: () => this.revealPath(path) },
        "-",
        { label: "Delete", keys: "⌫", run: () => void this.remove(path) },
      ]),
    );
  }

  private revealPath(path: Path) {
    const live = this.live();
    const found = live && resolve(live.root, path);
    if (found) this.reveal(found.entry.node);
  }

  private async nudge(path: Path, by: number) {
    const live = this.live();
    const found = live && resolve(live.root, path);
    if (!live || !found) return;
    const { parent, last } = parentOf(path);
    const to = last.index + by;
    if (to < 0 || to >= found.slot.entries.length) return;
    await this.move(path, { owner: parent.length ? parent : null, slot: last.slot }, by > 0 ? to + 1 : to);
  }

  private palette(ref: { kind: RootKind; doc: Doc; root: Root }, _ctx: CanvasCtx) {
    // With an action's modal open, the palette offers fields for its form.
    const modal = this.modalAction(ref.root);
    const modalSlot = modal?.comp.slots.find((s) => s.via === "schema" || s.via === "form");
    const kinds = modal ? PALETTE_KINDS.form : ref.kind === "table" ? PALETTE_KINDS.columns : PALETTE_KINDS[ref.kind];
    const search = h("input", { type: "search", class: "fd-palette-search", placeholder: "Search components", value: this.paletteQuery, spellcheck: false });
    const body = h("div", { class: "fd-palette-body" });
    const used = new Set<string>();
    walk(ref.root, (c) => c.name && used.add(c.name.split(".")[0]));
    // A relationship shown by its title, such as author.name, uses its foreign key column.
    for (const r of this.facts?.relations ?? []) if (used.has(r.name) && /BelongsTo$/.test(r.type)) used.add(r.foreignKey ?? `${r.name.replace(/([A-Z])/g, "_$1").toLowerCase()}_id`);
    const slotName = ref.kind === "table" ? "columns" : ref.kind === "actions" ? "actions" : ref.root.slots.has("schema") ? "schema" : "components";
    const end = (): { to: SlotRef; index: number } =>
      modal
        ? { to: { owner: modal.path, slot: modalSlot ? slotKey(modalSlot) : "schema" }, index: modalSlot?.entries.length ?? 0 }
        : { to: { owner: null, slot: slotName }, index: (ref.kind === "table" ? ref.root.slots.get("columns") : ref.kind === "actions" ? ref.root.slots.get("actions") : rootSlot(ref.root, ["components", "schema"]))?.entries.length ?? 0 };
    /** Where a click adds: after the selected component, or inside it when it's a container, or at the end. */
    const place = (cls: string): { to: SlotRef; index: number } => {
      if (!this.selection || (modal && samePath(this.selection, modal.path))) return end();
      const found = resolve(ref.root, this.selection);
      if (!found) return end();
      const comp = found.entry.comp;
      const inner = comp && childSlot(comp);
      if (inner && classInfo(this.cat!, cls)?.kind !== "layout" && (ref.kind !== "table" || modal)) return { to: { owner: this.selection, slot: inner.via }, index: inner.entries.length };
      const { parent, last } = parentOf(this.selection);
      return { to: { owner: parent.length ? parent : null, slot: last.slot }, index: last.index + 1 };
    };
    const render = () => {
      const q = search.value.trim().toLowerCase();
      this.paletteQuery = search.value;
      const groups = palette(this.cat!, kinds, q);
      const columns = (ref.kind === "actions" && !modal ? [] : (this.facts?.columns ?? [])).filter((c) => (ref.kind === "table" && !modal ? c.name !== "id" : !isSystemColumn(c)) && (!q || c.name.toLowerCase().includes(q)));
      // The same columns Add N adds: secrets never go in a form or table on their own.
      const missing = columns.filter((c) => !used.has(c.name) && !/password|token|secret/.test(c.name));
      const colItem = (c: Column) => {
        const el = h("div", { class: `fd-palette-item fd-column-item${used.has(c.name) ? " used" : ""}`, draggable: true, title: `${c.name}: ${c.fullType ?? c.type}${c.nullable ? ", nullable" : ""}${used.has(c.name) ? " (already used)" : ""}` }, icon(used.has(c.name) ? "pass" : "database"), h("span", {}, c.name), h("span", { class: "fd-palette-detail" }, c.type));
        el.ondragstart = (e) => (setDragging({ kind: "column", name: c.name }), e.dataTransfer!.setData("text/plain", c.name));
        el.ondragend = () => (setDragging(null), hideLine());
        el.onclick = () => {
          const at = end();
          void this.addColumn(c.name, at.to, at.index);
        };
        return el;
      };
      body.replaceChildren(
        ...(this.facts && (ref.kind !== "actions" || modal)
          ? [
              h(
                "details",
                { class: "fd-palette-group", open: true },
                h("summary", {}, icon("database"), h("span", { class: "fd-palette-title", title: `${shortClass(this.facts.class)} columns` }, `${shortClass(this.facts.class)} columns`), missing.length && !modal ? h("button", { type: "button", class: "fd-palette-all", title: "Add every column that isn't there yet", onclick: (e: MouseEvent) => (e.preventDefault(), void this.addMissing()) }, `Add ${missing.length}`) : null),
                ...columns.map(colItem),
                !columns.length ? h("p", { class: "fd-note" }, this.facts.details.tableExists === false ? "The table doesn't exist yet. Run the migrations." : "No columns.") : null,
              ),
            ]
          : ref.kind === "actions" && !modal
            ? []
            : [h("p", { class: "fd-note fd-palette-note" }, "The model's columns show here when the app can be read.")]),
        ...groups.map((g) =>
          h(
            "details",
            { class: "fd-palette-group", open: true },
            h("summary", {}, g.label),
            ...g.classes.map((c) => {
              const l = look(c);
              const el = h("div", { class: "fd-palette-item", draggable: true, title: `${l.hint ?? ""}\n${c.class}`.trim() }, icon(ref.kind === "table" && c.kind === "columnLayout" ? "layout" : l.icon), h("span", {}, shortClass(c.class)));
              el.ondragstart = (e) => (setDragging({ kind: "new", cls: c.class }), e.dataTransfer!.setData("text/plain", c.class), (e.dataTransfer!.effectAllowed = "copy"));
              el.ondragend = () => (setDragging(null), hideLine());
              el.onclick = () => {
                const at = place(c.class);
                void this.addNew(c.class, at.to, at.index, el);
              };
              return el;
            }),
          ),
        ),
      );
    };
    search.oninput = render;
    render();
    return h("aside", { class: "fd-palette" }, search, body);
  }

  private inspector(ref: { kind: RootKind; doc: Doc; root: Root }, canvas: CanvasCtx): HTMLElement {
    if (!this.selection) return this.rootSettings(ref);
    const found = resolve(ref.root, this.selection);
    if (!found) return this.rootSettings(ref);
    const path = this.selection;
    if (!found.entry.comp)
      return renderCodeInspector({ code: ref.doc.text.slice(found.entry.node.span[0], found.entry.node.span[1]), reveal: () => this.reveal(found.entry.node, ref.doc), remove: () => void this.remove(path) });
    return renderInspector({
      cat: this.cat!,
      canvas,
      path,
      comp: found.entry.comp,
      text: ref.doc.text,
      enums: this.enums,
      columns: (this.facts?.columns ?? []).map((c) => c.name),
      relations: this.facts?.relations ?? [],
      relatedColumns: async (model) => {
        const all = await fapp.models(this.root).catch(() => ({}) as Record<string, fapp.ModelSummary>);
        return Object.keys(all[model]?.columns ?? {});
      },
      set: (changes) => void this.setCalls(changes),
      setMake: (args) => void this.setMake(path, args),
      changeType: (cls) => void this.changeType(path, cls),
      reveal: (node) => this.reveal(node, ref.doc),
      remove: () => void this.remove(path),
      duplicate: () => void this.duplicate(path),
      wrap: (cls) => void this.wrap(path, cls),
      newEnum: (options) =>
        void import("./enumdesigner").then((m) =>
          m.openNewEnum({
            options,
            then: async (cls) => {
              this.enums = await fapp.enums(this.root).catch(() => this.enums);
              await this.setCalls([{ path, name: "options", args: `{{${cls}}}::class` }], "Used the enum");
            },
          }),
        ),
      porter: (kind, anchor, set) => void this.pickPorter(kind, anchor, set),
      openPorter: (fqn) => void fapp.fileOfClass(this.root, fqn).then((f) => { if (f) void import("./porterdesigner").then((m) => m.openPorter(f)); }),
      action: (() => {
        const kind = classInfo(this.cat!, found.entry.comp!.cls)?.kind ?? "";
        const scope = kind === "action" || kind === "bulkAction" ? this.scopeOf(path, kind) : null;
        return scope ? { scope, model: this.facts?.class ?? null, casts: this.facts?.casts ?? {}, notifications: this.notices.list, userModel: this.notices.user } : undefined;
      })(),
      i18n: this.i18n(),
      openEnum: async (cls) => {
        const known = this.enums.find((e) => e.class === cls)?.file;
        const file = known ? `${this.root}/${known}` : await fapp.fileOfClass(this.root, cls);
        if (file) (await import("./enumdesigner")).openEnumDesigner(file);
      },
    });
  }

  /** The inspector with nothing selected: the form's or table's own settings, and an overview. */
  private rootSettings(ref: { kind: RootKind; doc: Doc; root: Root }): HTMLElement {
    const settings = this.rootSettingsOf(ref);
    const plain = this.translations ? this.plainTexts(ref) : [];
    if (plain.length) {
      const note =
        h(
          "div",
          { class: "fd-translate-all" },
          icon("globe"),
          h("span", { class: "fd-note" }, `${plain.length} ${plain.length === 1 ? "text isn't" : "texts aren't"} translatable yet.`),
          h("button", { type: "button", class: "fd-chip-link", title: "Write labels, headings, placeholders, and the like with __(), so each language can have its own", onclick: () => void this.translateAll() }, "Make translatable"),
        );
      const first = settings.querySelector("details.fd-group");
      if (first) first.after(note);
      else settings.append(note);
    }
    return settings;
  }

  /** The texts people see that are written as plain strings: labels, headings, placeholders, and the like. */
  private plainTexts(ref: { root: Root }) {
    const found: PNode[] = [];
    walk(ref.root, (c) => {
      const kind = this.cat && classInfo(this.cat, c.cls)?.kind;
      const first = c.make.args.items[0]?.value;
      if (kind === "layout" && first?.kind === "string" && !first.interpolated && first.value) found.push(first);
      for (const call of c.calls) {
        const v = call.args.items[0]?.value;
        // `translateLabel()` already translates the label.
        if (call.name === "label" && c.calls.some((x) => x.name === "translateLabel")) continue;
        if (TEXT_CALLS.has(call.name) && v?.kind === "string" && !v.interpolated && v.value) found.push(v);
      }
    });
    return found;
  }

  async translateAll() {
    await this.settled();
    const live = this.live();
    if (!live) return;
    const text = live.doc.text;
    const nodes = this.plainTexts(live);
    await this.apply(live.doc, () => nodes.map((n) => ({ start: n.span[0], end: n.span[1], text: `__(${text.slice(n.span[0], n.span[1])})` })), `Made ${nodes.length} ${nodes.length === 1 ? "text" : "texts"} translatable`);
  }

  private rootSettingsOf(ref: { kind: RootKind; doc: Doc; root: Root }): HTMLElement {
    if (ref.kind === "actions") {
      const n = ref.root.slots.get("actions")?.entries.length ?? 0;
      return h(
        "div",
        { class: "fd-inspector-body" },
        h("header", { class: "fd-inspector-head" }, h("span", { class: "codicon codicon-play fd-type-icon" }), h("div", { class: "fd-inspector-title" }, h("strong", {}, "Header actions"), h("span", { class: "fd-note" }, `${n} ${n === 1 ? "action" : "actions"} on ${this.pageTitle()}`))),
        h("p", { class: "fd-note fd-row-note" }, "Select an action to change it. A custom action can ask for input with a form, which shows below the page, and do something with it: pick what it does in its settings."),
      );
    }
    return renderRootSettings(this, ref);
  }

  // ---- Keys ----

  private keys(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable]")) return;
    const mod = e.metaKey || e.ctrlKey;
    const path = this.selection;
    if (mod && e.key.toLowerCase() === "z") return e.preventDefault(), e.stopPropagation(), e.shiftKey ? this.redoLast() : this.undoLast();
    if (!path) return;
    if (e.key === "Backspace" || e.key === "Delete") return e.preventDefault(), void this.remove(path);
    if (mod && e.key.toLowerCase() === "d") return e.preventDefault(), e.stopPropagation(), void this.duplicate(path);
    if (e.key === "Escape") return e.preventDefault(), this.select(parentOf(path).parent.length ? parentOf(path).parent : null);
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) return e.preventDefault(), void this.nudge(path, e.key === "ArrowUp" ? -1 : 1);
    if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const live = this.live();
      const found = live && resolve(live.root, path);
      if (!found) return;
      const { parent, last } = parentOf(path);
      const step = e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 1;
      const index = last.index + step;
      if (index >= 0 && index < found.slot.entries.length) this.select([...parent, { slot: last.slot, index }]);
      else if (step < 0 && parent.length) this.select(parent);
      else if (step > 0 && found.entry.comp?.slots[0]?.entries.length) this.select([...path, { slot: found.entry.comp.slots[0].via, index: 0 }]);
    }
  }
}

/** Where the pointer last was during a drag, to anchor the name prompt at the drop. */
let lastPointer = { x: 200, y: 200 };
addEventListener("dragover", (e) => (lastPointer = { x: e.clientX, y: e.clientY }), true);
addEventListener("dragend", () => currentDrag() && setDragging(null), true);


