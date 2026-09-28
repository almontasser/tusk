// The designer's canvas: a form, infolist, or table drawn from its code the way Filament shows it, close enough
// to judge the layout. Every component can be selected, dragged to another place, and given components by dropping
// them from the palette. The canvas only reads; the designer (filamentdesigner.ts) makes the changes.
import { h, icon } from "./dom";
import { type Catalog, classInfo, humanize, isA, labelFromName, look } from "./filamentcatalog";
import { type Comp, type Entry, type Path, resolve, type Root, rootSlot, samePath, type Slot, shortClass, slotKey, within } from "./filamentschema";
import { COLOR_SWATCH, heroicon } from "./filamentpickers";
import { findCall, nodeValue, type PNode, textValue } from "./phpcode";

/** Where components can go: a root's slot (owner null) or a component's. */
export type SlotRef = { owner: Path | null; slot: string };

/** What is being dragged: a new component from the palette, a model column, or a component on the canvas. */
export type Drag = { kind: "new"; cls: string } | { kind: "column"; name: string } | { kind: "move"; path: Path };

export type CanvasCtx = {
  cat: Catalog;
  root: Root;
  selection: Path | null;
  iconsDir: string | null;
  /** Which tab of each Tabs component and step of each Wizard shows, by the component's path. */
  active: Map<string, number>;
  select(path: Path | null): void;
  drop(drag: Drag, to: SlotRef, index: number): void;
  /** Opens the menu for a component, at a point. */
  menu(path: Path, x: number, y: number): void;
  /** Adds a component to a slot from a small menu, as the "+" buttons do. */
  add(to: SlotRef, anchor: HTMLElement): void;
  redraw(): void;
};

let dragging: Drag | null = null;
export const setDragging = (d: Drag | null) => (dragging = d);
export const currentDrag = () => dragging;

// ---- Reading a component's settings ----

export const call = (c: Comp, name: string) => findCall(c.node, name);
export const arg = (c: Comp, name: string, i = 0): PNode | undefined => call(c, name)?.args.items[i]?.value;

/** Whether a flag is on: the call is there, and its first argument isn't `false`. A closure counts as sometimes. */
export function flag(c: Comp, name: string): boolean {
  const found = call(c, name);
  if (!found) return false;
  const a = found.args.items[0]?.value;
  return !a || a.kind !== "bool" || a.value;
}
export const text = (c: Comp, name: string, i = 0) => textValue(arg(c, name, i))?.text;
export const number = (c: Comp, name: string) => {
  const v = nodeValue(arg(c, name));
  return typeof v === "number" ? v : undefined;
};
const short = (c: Comp) => shortClass(c.cls);
export const kindOf = (cat: Catalog, c: Comp) => classInfo(cat, c.cls)?.kind;

/** Filament's own labels for its actions. */
const ACTION_LABELS: Record<string, string> = {
  ViewAction: "View",
  EditAction: "Edit",
  DeleteAction: "Delete",
  ForceDeleteAction: "Force delete",
  RestoreAction: "Restore",
  ReplicateAction: "Replicate",
  CreateAction: "Create",
  ExportAction: "Export",
  ImportAction: "Import",
  AttachAction: "Attach",
  AssociateAction: "Associate",
  DetachAction: "Detach",
  DissociateAction: "Dissociate",
  DeleteBulkAction: "Delete selected",
  ForceDeleteBulkAction: "Force delete selected",
  RestoreBulkAction: "Restore selected",
  DetachBulkAction: "Detach selected",
  DissociateBulkAction: "Dissociate selected",
  ExportBulkAction: "Export selected",
  BulkActionGroup: "Bulk actions",
  ActionGroup: "More actions",
  TrashedFilter: "Trashed",
};

/** The label Filament shows: the `label()` call, or one made from the name. */
export function labelOf(c: Comp): string {
  const own = text(c, "label");
  if (own !== undefined) return own;
  if (ACTION_LABELS[short(c)] && !c.name) return ACTION_LABELS[short(c)];
  if (c.name) return labelFromName(c.name);
  return humanize(short(c).replace(/(Action|Column|Filter|Entry)$/, "")) || short(c);
}

/** How many columns a layout's grid has, from `columns()`: a number, or the widest breakpoint of a map. */
function columnsOf(c: Comp | null, fallback: number): number {
  const v = c ? nodeValue(arg(c, "columns")) : undefined;
  if (typeof v === "number") return Math.max(1, Math.min(v, 12));
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const map = v as Record<string, unknown>;
    const n = map.lg ?? map.xl ?? map.md ?? map.default ?? Object.values(map).at(-1);
    if (typeof n === "number") return Math.max(1, Math.min(n, 12));
  }
  return fallback;
}

/** The components that span the whole grid unless told otherwise, as Filament sets them up. */
const FULL = new Set(["Section", "Tabs", "Wizard", "Grid", "Fieldset", "Repeater", "Builder", "RichEditor", "MarkdownEditor", "KeyValue", "Callout", "EmptyState", "RepeatableEntry", "Flex"]);

function spanOf(c: Comp, columns: number): number {
  if (flag(c, "columnSpanFull")) return columns;
  const v = nodeValue(arg(c, "columnSpan"));
  if (v === "full") return columns;
  if (typeof v === "number") return Math.min(v, columns);
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const map = v as Record<string, unknown>;
    const n = map.lg ?? map.md ?? map.default;
    if (n === "full") return columns;
    if (typeof n === "number") return Math.min(n, columns);
  }
  return FULL.has(short(c)) ? columns : 1;
}

const pathKey = (p: Path) => p.map((s) => `${s.slot}:${s.index}`).join("/");

// ---- Drag and drop ----

/** Whether a slot takes a class: tabs take tabs, steps take steps, blocks take blocks, and other slots take neither. */
export function accepts(cat: Catalog, slot: Slot | { via: string }, owner: Comp | null, cls: string): boolean {
  const name = shortClass(cls);
  const ownerName = owner ? shortClass(owner.cls) : "";
  const wants = slot.via === "tabs" ? "Tab" : slot.via === "steps" || (ownerName === "Wizard" && slot.via === "make") ? "Step" : slot.via === "blocks" ? "Block" : "";
  if (wants) return name === wants;
  if (["Tab", "Step", "Block"].includes(name)) return false;
  const info = classInfo(cat, cls);
  if (!info) return true;
  // Tables' slots take their own kinds.
  const byVia: Record<string, string[]> = {
    columns: ["column", "columnLayout"],
    filters: ["filter"],
    recordActions: ["action", "actionGroup"],
    actions: ["action", "actionGroup"],
    toolbarActions: ["bulkAction", "actionGroup", "action"],
    bulkActions: ["bulkAction", "actionGroup"],
    groupedBulkActions: ["bulkAction"],
    headerActions: ["action", "actionGroup"],
  };
  if (!owner && byVia[slot.via]) return byVia[slot.via].includes(info.kind);
  if (owner && isA(classInfo(cat, owner.cls), "Filament\\Actions\\ActionGroup")) return ["action", "bulkAction", "actionGroup"].includes(info.kind);
  if (owner && classInfo(cat, owner.cls)?.kind === "columnLayout") return ["column", "columnLayout"].includes(info.kind);
  return !["column", "filter", "action", "bulkAction", "actionGroup", "columnLayout", "widget"].includes(info.kind) || slot.via === "footerActions" || slot.via === "headerActions" || slot.via === "actions";
}

/** Where a drop at (x, y) goes among a slot's items, and where to draw the line that shows it. */
function dropIndex(container: HTMLElement, x: number, y: number, horizontal: boolean): { index: number; line: DOMRect | null; vertical: boolean } {
  const items = [...container.children].filter((c) => (c as HTMLElement).dataset.index !== undefined) as HTMLElement[];
  for (const item of items) {
    const r = item.getBoundingClientRect();
    const before = horizontal ? x < r.left + r.width / 2 : y < r.top + r.height / 2 || (y < r.bottom && x < r.left + r.width / 2 && r.width < container.clientWidth * 0.9);
    if (before) return { index: Number(item.dataset.index), line: r, vertical: horizontal || (r.width < container.clientWidth * 0.9 && y >= r.top) };
  }
  const last = items.at(-1)?.getBoundingClientRect() ?? null;
  return { index: items.length ? Number(items.at(-1)!.dataset.index) + 1 : 0, line: last, vertical: false };
}

let line: HTMLElement | null = null;
function showLine(host: HTMLElement, r: DOMRect | null, vertical: boolean, after: boolean) {
  line ??= h("div", { class: "fd-drop-line" });
  if (!r) {
    line.remove();
    return;
  }
  const base = host.getBoundingClientRect();
  if (!line.isConnected) host.append(line);
  line.classList.toggle("vertical", vertical);
  if (vertical) Object.assign(line.style, { left: `${r.left - base.left + host.scrollLeft - 3}px`, top: `${r.top - base.top + host.scrollTop}px`, width: "", height: `${r.height}px` });
  else Object.assign(line.style, { left: `${r.left - base.left + host.scrollLeft}px`, top: `${(after ? r.bottom + 3 : r.top - 4) - base.top + host.scrollTop}px`, width: `${r.width}px`, height: "" });
}
export const hideLine = () => line?.remove();

/** Makes an element a drop target for a slot. `horizontal` for rows of columns and action chips. */
export function dropTarget(el: HTMLElement, ctx: CanvasCtx, ref: SlotRef, slot: Slot | { via: string }, owner: Comp | null, horizontal = false) {
  const host = () => el.closest<HTMLElement>(".fd-canvas") ?? el;
  const allowed = () => {
    const d = dragging;
    if (!d) return false;
    if (d.kind === "column") return !owner || !["Tabs", "Wizard", "Builder"].includes(short(owner));
    if (d.kind === "new") return accepts(ctx.cat, slot, owner, d.cls);
    const from = resolve(ctx.root, d.path);
    if (!from?.entry.comp) return false;
    // Not into itself or something inside it.
    if (ref.owner && within(ref.owner, d.path)) return false;
    return accepts(ctx.cat, slot, owner, from.entry.comp.cls);
  };
  el.addEventListener("dragover", (e) => {
    if (!allowed()) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.add("fd-drop-over");
    const { line: r, vertical, index } = dropIndex(el, e.clientX, e.clientY, horizontal);
    const count = [...el.children].filter((c) => (c as HTMLElement).dataset.index !== undefined).length;
    showLine(host(), r, vertical, index >= count && count > 0);
  });
  el.addEventListener("dragleave", (e) => {
    if (!el.contains(e.relatedTarget as Node)) el.classList.remove("fd-drop-over");
  });
  el.addEventListener("drop", (e) => {
    if (!allowed() || !dragging) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove("fd-drop-over");
    hideLine();
    const { index } = dropIndex(el, e.clientX, e.clientY, horizontal);
    const d = dragging;
    dragging = null;
    ctx.drop(d, ref, index);
  });
}

/** Makes a canvas item draggable, to move its component. */
function draggable(el: HTMLElement, path: Path) {
  el.draggable = true;
  el.addEventListener("dragstart", (e) => {
    e.stopPropagation();
    dragging = { kind: "move", path };
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", "");
    el.classList.add("fd-dragging");
  });
  el.addEventListener("dragend", () => {
    el.classList.remove("fd-dragging");
    dragging = null;
    hideLine();
    document.querySelectorAll(".fd-drop-over").forEach((x) => x.classList.remove("fd-drop-over"));
  });
}

// ---- Schemas: forms and infolists ----

/** The canvas for a form or infolist root. */
export function renderSchema(ctx: CanvasCtx, slotName: string): HTMLElement {
  const slot = ctx.root.slots.get(slotName);
  const columns = columnsOf(null, 2);
  const rootColumns = (() => {
    // `$schema->columns(3)` sets the root grid.
    const c = findCall(ctx.root.node, "columns");
    const v = c ? nodeValue(c.args.items[0]?.value) : undefined;
    return typeof v === "number" ? v : columns;
  })();
  const grid = renderSlot(ctx, slot ?? { via: slotName, arg: 0, array: null as never, entries: [] }, { owner: null, slot: slotName }, [], null, rootColumns);
  grid.classList.add("fd-root-grid");
  return grid;
}

/** A slot's grid of components, with a drop target and an empty state. */
function renderSlot(ctx: CanvasCtx, slot: Slot, ref: SlotRef, prefix: Path, owner: Comp | null, columns: number): HTMLElement {
  const grid = h("div", { class: "fd-grid", style: `--cols:${columns}` });
  for (const e of slot.entries) {
    const path = [...prefix, { slot: prefix.length ? slotKey(slot) : slot.via, index: e.index }];
    const item = renderEntry(ctx, e, path, columns);
    item.dataset.index = String(e.index);
    grid.append(item);
  }
  if (!slot.entries.length)
    grid.append(
      h(
        "button",
        { type: "button", class: "fd-empty-slot", onclick: (ev: MouseEvent) => (ev.stopPropagation(), ctx.add(ref, ev.currentTarget as HTMLElement)) },
        icon("add"),
        owner ? "Drop components here, or click to add" : "Drag fields here from the left, or click to add",
      ),
    );
  dropTarget(grid, ctx, ref, slot, owner);
  return grid;
}

/** One entry: a component drawn as Filament draws it, or a block of code the designer keeps as it is. */
function renderEntry(ctx: CanvasCtx, e: Entry, path: Path, columns: number): HTMLElement {
  if (!e.comp) {
    const el = h("div", { class: "fd-item fd-code-item", title: "Code the designer keeps as written. Open the code to change it.", style: `grid-column: span ${columns}` }, icon("code"), h("span", {}, "Code"));
    el.onclick = (ev) => (ev.stopPropagation(), ctx.select(path));
    if (samePath(ctx.selection, path)) el.classList.add("selected");
    draggable(el, path);
    return el;
  }
  const c = e.comp;
  const span = spanOf(c, columns);
  const info = classInfo(ctx.cat, c.cls);
  const kind = info?.kind ?? "field";
  const selected = samePath(ctx.selection, path);
  const hidden = flag(c, "hidden") || !!call(c, "visible") || !!call(c, "hiddenOn") || !!call(c, "visibleOn");
  const el = h("div", { class: `fd-item fd-kind-${kind}${selected ? " selected" : ""}${hidden ? " conditional" : ""}`, style: `grid-column: span ${span}` });
  el.onclick = (ev) => (ev.stopPropagation(), ctx.select(path));
  el.oncontextmenu = (ev) => (ev.preventDefault(), ev.stopPropagation(), ctx.select(path), ctx.menu(path, ev.clientX, ev.clientY));
  draggable(el, path);
  el.append(badges(c), renderComp(ctx, c, path, kind));
  return el;
}

/** Small marks in a component's corner: conditional, live, and the like. */
function badges(c: Comp): HTMLElement {
  const marks: [string, string][] = [];
  if (call(c, "visible") || call(c, "hidden") || call(c, "hiddenOn") || call(c, "visibleOn")) marks.push(["eye", "Shown only sometimes"]);
  if (flag(c, "live") || flag(c, "reactive")) marks.push(["zap", "Live: the form updates as this changes"]);
  if (flag(c, "disabled")) marks.push(["lock", "Disabled"]);
  if (call(c, "relationship")) marks.push(["link", "Saved through a relationship"]);
  return h("div", { class: "fd-marks" }, ...marks.map(([name, title]) => h("span", { class: `codicon codicon-${name}`, title })));
}

function fieldLabel(c: Comp, after: HTMLElement | null = null): HTMLElement {
  const hint = text(c, "hint");
  return h(
    "div",
    { class: "fd-label-row" },
    h("span", { class: "fd-label" }, labelOf(c), flag(c, "required") ? h("sup", { class: "fd-required" }, "*") : null),
    after,
    hint ? h("span", { class: "fd-hint" }, hint) : null,
  );
}

function helper(c: Comp): HTMLElement | null {
  const t = text(c, "helperText");
  return t ? h("p", { class: "fd-helper" }, t) : null;
}

/** A form input's box, with its prefix and suffix. */
function inputBox(ctx: CanvasCtx, c: Comp, inner: (HTMLElement | string)[], className = ""): HTMLElement {
  const prefix = text(c, "prefix");
  const suffix = text(c, "suffix");
  const pIcon = arg(c, "prefixIcon");
  const sIcon = arg(c, "suffixIcon");
  const iconName = (n: PNode | undefined) => (n?.kind === "classConst" ? n.name : textValue(n)?.text);
  return h(
    "div",
    { class: `fd-input ${className}${flag(c, "disabled") ? " disabled" : ""}` },
    prefix ? h("span", { class: "fd-affix" }, prefix) : null,
    pIcon ? heroicon(ctx.iconsDir, iconName(pIcon), "fd-heroicon fd-affix-icon") : null,
    h("div", { class: "fd-input-inner" }, ...inner),
    sIcon ? heroicon(ctx.iconsDir, iconName(sIcon), "fd-heroicon fd-affix-icon") : null,
    suffix ? h("span", { class: "fd-affix" }, suffix) : null,
  );
}

const placeholder = (c: Comp, fallback = "") => h("span", { class: "fd-placeholder" }, text(c, "placeholder") ?? fallback);

/** The options a choice field shows: its literal options, an enum's name, or a relationship's. */
function optionsOf(c: Comp): string[] {
  const v = nodeValue(arg(c, "options"));
  if (v && typeof v === "object" && !Array.isArray(v)) return Object.values(v as Record<string, unknown>).map(String).slice(0, 6);
  if (Array.isArray(v)) return v.map(String).slice(0, 6);
  const o = arg(c, "options");
  if (o?.kind === "classConst") return [`${shortClass(o.class)} cases`];
  if (call(c, "relationship")) return [`${text(c, "relationship") ?? "Related"} records`];
  if (flag(c, "boolean")) return ["Yes", "No"];
  return ["Option 1", "Option 2", "Option 3"];
}

function renderComp(ctx: CanvasCtx, c: Comp, path: Path, kind: string): HTMLElement {
  const name = short(c);
  const inner = (slotVia: string, columns: number, className = "") => {
    const slot = c.slots.find((s) => s.via === slotVia);
    if (!slot) return h("div", { class: `fd-missing-slot ${className}` }, h("button", { type: "button", class: "fd-empty-slot", onclick: (ev: MouseEvent) => (ev.stopPropagation(), ctx.add({ owner: path, slot: slotVia }, ev.currentTarget as HTMLElement)) }, icon("add"), "Add components"));
    const grid = renderSlot(ctx, slot, { owner: path, slot: slotKey(slot) }, path, c, columns);
    if (className) grid.classList.add(className);
    return grid;
  };
  const schemaSlot = () => (c.slots.find((s) => s.via === "schema") ? "schema" : c.slots.find((s) => s.via === "components") ? "components" : "schema");
  switch (name) {
    case "Section": {
      const heading = c.name ?? text(c, "heading");
      const desc = text(c, "description");
      const aside = flag(c, "aside");
      const collapsible = flag(c, "collapsible") || flag(c, "collapsed");
      const iconNode = arg(c, "icon");
      const head =
        heading || desc
          ? h(
              "header",
              { class: "fd-section-head" },
              iconNode ? heroicon(ctx.iconsDir, iconNode.kind === "classConst" ? iconNode.name : textValue(iconNode)?.text, "fd-heroicon fd-section-icon") : null,
              h("div", { class: "fd-section-titles" }, heading ? h("h3", {}, heading) : null, desc ? h("p", {}, desc) : null),
              collapsible ? h("span", { class: `codicon codicon-chevron-${flag(c, "collapsed") ? "down" : "up"} fd-collapse` }) : null,
            )
          : null;
      return h("section", { class: `fd-section${aside ? " aside" : ""}${flag(c, "compact") ? " compact" : ""}` }, head, h("div", { class: "fd-section-body" }, inner(schemaSlot(), columnsOf(c, 1))));
    }
    case "Fieldset":
      return h("fieldset", { class: "fd-fieldset" }, h("legend", {}, c.name ?? text(c, "label") ?? "Fieldset"), inner(schemaSlot(), columnsOf(c, 2)));
    case "Grid":
    case "Group":
    case "FusedGroup": {
      const n = name === "Grid" ? (() => {
        const v = nodeValue(c.make.args.items[0]?.value);
        return typeof v === "number" ? v : columnsOf(c, 2);
      })() : columnsOf(c, 1);
      return h("div", { class: "fd-layout-box" }, h("span", { class: "fd-layout-tag" }, name === "Grid" ? `Grid · ${n} columns` : name), inner(schemaSlot(), n));
    }
    case "Flex":
      return h("div", { class: "fd-layout-box" }, h("span", { class: "fd-layout-tag" }, "Flex"), c.slots[0] ? renderSlot(ctx, c.slots[0], { owner: path, slot: slotKey(c.slots[0]) }, path, c, Math.max(1, c.slots[0].entries.length)) : inner("schema", 2));
    case "Tabs":
    case "Wizard": {
      const slot = c.slots.find((s) => s.via === (name === "Tabs" ? "tabs" : "steps")) ?? c.slots.find((s) => s.via === "make");
      const key = pathKey(path);
      const active = Math.min(ctx.active.get(key) ?? 0, Math.max(0, (slot?.entries.length ?? 1) - 1));
      const heads = h("div", { class: name === "Tabs" ? "fd-tabs-bar" : "fd-steps-bar" });
      slot?.entries.forEach((e, i) => {
        const childPath = [...path, { slot: slotKey(slot), index: e.index }];
        const label = e.comp ? (e.comp.name ?? text(e.comp, "label") ?? `${name === "Tabs" ? "Tab" : "Step"} ${i + 1}`) : "Code";
        const head = h(
          "button",
          { type: "button", class: `${i === active ? "active" : ""}${samePath(ctx.selection, childPath) ? " selected" : ""}`, onclick: (ev: MouseEvent) => (ev.stopPropagation(), ctx.active.set(key, i), ctx.select(childPath)) },
          name === "Wizard" ? h("span", { class: "fd-step-number" }, String(i + 1)) : null,
          h("span", {}, label),
        );
        head.oncontextmenu = (ev) => (ev.preventDefault(), ev.stopPropagation(), ctx.select(childPath), ctx.menu(childPath, ev.clientX, ev.clientY));
        head.dataset.index = String(e.index);
        draggable(head, childPath);
        heads.append(head);
      });
      heads.append(h("button", { type: "button", class: "fd-add-tab", title: name === "Tabs" ? "Add a tab" : "Add a step", onclick: (ev: MouseEvent) => (ev.stopPropagation(), slot ? ctx.drop({ kind: "new", cls: name === "Tabs" ? "Filament\\Schemas\\Components\\Tabs\\Tab" : "Filament\\Schemas\\Components\\Wizard\\Step" }, { owner: path, slot: slotKey(slot) }, slot.entries.length) : ctx.add({ owner: path, slot: name === "Tabs" ? "tabs" : "steps" }, ev.currentTarget as HTMLElement)) }, icon("add")));
      if (slot) dropTarget(heads, ctx, { owner: path, slot: slotKey(slot) }, slot, c, true);
      const current = slot?.entries[active];
      const body = current?.comp
        ? (() => {
            const childPath = [...path, { slot: slotKey(slot!), index: current.index }];
            const tabSlot = current.comp.slots.find((s) => s.via === "schema" || s.via === "components");
            return tabSlot
              ? renderSlot(ctx, tabSlot, { owner: childPath, slot: slotKey(tabSlot) }, childPath, current.comp, columnsOf(current.comp, 1))
              : h("button", { type: "button", class: "fd-empty-slot", onclick: (ev: MouseEvent) => (ev.stopPropagation(), ctx.add({ owner: childPath, slot: "schema" }, ev.currentTarget as HTMLElement)) }, icon("add"), "Add components");
          })()
        : h("p", { class: "fd-muted" }, slot?.entries.length ? "This one is written as code." : "No tabs yet.");
      return h("div", { class: name === "Tabs" ? "fd-tabs" : "fd-wizard" }, heads, h("div", { class: "fd-tabs-body" }, body));
    }
    case "Tab":
    case "Step":
      return h("div", { class: "fd-layout-box" }, h("span", { class: "fd-layout-tag" }, `${name}: ${c.name ?? ""}`), inner(schemaSlot(), columnsOf(c, 1)));
    case "Repeater":
    case "RepeatableEntry":
      return h(
        "div",
        { class: "fd-field" },
        fieldLabel(c),
        h("div", { class: "fd-repeater" }, h("div", { class: "fd-repeater-item" }, h("div", { class: "fd-repeater-bar" }, icon("gripper"), h("span", { class: "fd-muted" }, "Item 1"), icon("chevron-up")), inner(schemaSlot(), columnsOf(c, 1)))),
        kind === "field" ? h("div", { class: "fd-repeater-add" }, text(c, "addActionLabel") ?? `Add to ${labelOf(c).toLowerCase()}`) : null,
        helper(c),
      );
    case "Builder":
      return h("div", { class: "fd-field" }, fieldLabel(c), h("div", { class: "fd-repeater" }, inner("blocks", 1)), h("div", { class: "fd-repeater-add" }, text(c, "addActionLabel") ?? `Add to ${labelOf(c).toLowerCase()}`), helper(c));
    case "Block":
      return h("div", { class: "fd-layout-box" }, h("span", { class: "fd-layout-tag" }, `Block: ${c.name ?? ""}`), inner(schemaSlot(), columnsOf(c, 1)));
    case "Text":
      return h("p", { class: "fd-text" }, c.name ?? "Text");
    case "Callout":
      return h("div", { class: "fd-callout" }, icon("info"), h("div", {}, h("strong", {}, c.name ?? "Callout"), text(c, "description") ? h("p", {}, text(c, "description")!) : null));
    case "Html":
    case "View":
    case "Livewire":
    case "EmbeddedTable":
    case "EmbeddedSchema":
    case "RenderHook":
      return h("div", { class: "fd-layout-box fd-opaque" }, icon(look(c.cls).icon), h("span", {}, `${name}${c.name ? `: ${c.name}` : ""}`));
    case "Actions":
      return h("div", { class: "fd-actions-row" }, ...(c.slots[0]?.entries ?? []).map((e) => actionButton(ctx, e.comp)));
    case "Hidden":
      return h("div", { class: "fd-hidden-field" }, icon("eye-closed"), h("span", {}, `Hidden: ${c.name ?? ""}`));
  }
  if (kind === "entry") return renderEntryComp(c);
  if (kind === "layout") return h("div", { class: "fd-layout-box" }, h("span", { class: "fd-layout-tag" }, name), c.slots[0] ? inner(c.slots[0].via, columnsOf(c, 1)) : null);
  return renderField(ctx, c);
}

function renderField(ctx: CanvasCtx, c: Comp): HTMLElement {
  const name = short(c);
  const label = fieldLabel(c);
  let control: HTMLElement;
  switch (name) {
    case "Toggle":
      return h("div", { class: "fd-field fd-inline" }, h("span", { class: `fd-toggle${flag(c, "default") ? " on" : ""}` }), h("div", {}, fieldLabel(c), helper(c)));
    case "Checkbox":
      return h("div", { class: "fd-field fd-inline" }, h("span", { class: "fd-checkbox" }), h("div", {}, fieldLabel(c), helper(c)));
    case "Textarea":
      control = inputBox(ctx, c, [placeholder(c)], "tall");
      control.style.minHeight = `${Math.min(12, number(c, "rows") ?? 3) * 18 + 10}px`;
      break;
    case "RichEditor":
    case "MarkdownEditor":
      control = h("div", { class: "fd-rich" }, h("div", { class: "fd-rich-bar" }, ...["bold", "italic", "link", "list-unordered", "quote", "code"].map((n) => icon(n))), h("div", { class: "fd-rich-body" }, placeholder(c)));
      break;
    case "Select":
      control = inputBox(ctx, c, flag(c, "multiple") ? [h("span", { class: "fd-chip" }, optionsOf(c)[0] ?? "Option"), placeholder(c, "")] : [placeholder(c, "Select an option")], "select");
      control.append(icon("chevron-down"));
      break;
    case "Radio":
    case "CheckboxList":
      control = h("div", { class: `fd-choices${flag(c, "inline") ? " inline" : ""}`, style: `--cols:${columnsOf(c, 1)}` }, ...optionsOf(c).map((o, i) => h("label", {}, h("span", { class: name === "Radio" ? `fd-radio${i === 0 ? " on" : ""}` : "fd-checkbox" }), o)));
      break;
    case "ToggleButtons":
      control = h("div", { class: "fd-toggle-buttons" }, ...optionsOf(c).map((o, i) => h("span", { class: i === 0 ? "on" : "" }, o)));
      break;
    case "DatePicker":
    case "DateTimePicker":
    case "TimePicker":
      control = inputBox(ctx, c, [placeholder(c, name === "TimePicker" ? "--:--" : name === "DatePicker" ? "mm/dd/yyyy" : "mm/dd/yyyy --:--")]);
      control.append(icon(name === "TimePicker" ? "watch" : "calendar"));
      break;
    case "FileUpload":
    case "SpatieMediaLibraryFileUpload":
      control = h("div", { class: `fd-dropzone${flag(c, "avatar") ? " avatar" : ""}` }, icon(flag(c, "image") || flag(c, "avatar") ? "file-media" : "cloud-upload"), h("span", {}, "Drag and drop your files or ", h("u", {}, "browse")));
      break;
    case "ColorPicker":
      control = inputBox(ctx, c, [h("span", { class: "fd-swatch" }), placeholder(c, "#")]);
      break;
    case "TagsInput":
      control = inputBox(ctx, c, [h("span", { class: "fd-chip" }, "tag"), placeholder(c, "New tag")]);
      break;
    case "KeyValue":
      control = h("div", { class: "fd-keyvalue" }, h("div", { class: "fd-kv-head" }, h("span", {}, text(c, "keyLabel") ?? "Key"), h("span", {}, text(c, "valueLabel") ?? "Value")), h("div", { class: "fd-kv-row" }, h("span", {}), h("span", {})), h("div", { class: "fd-kv-add" }, text(c, "addActionLabel") ?? "Add row"));
      break;
    case "Slider":
      control = h("div", { class: "fd-slider" }, h("span", {}));
      break;
    case "CodeEditor":
      control = h("div", { class: "fd-input tall fd-code-editor" }, h("span", { class: "fd-placeholder" }, "</>"));
      break;
    default: {
      const type = flag(c, "password") ? "••••••••" : flag(c, "email") ? "name@example.com" : flag(c, "numeric") || flag(c, "integer") ? "0" : flag(c, "url") ? "https://" : flag(c, "tel") ? "+1 555 0100" : "";
      control = inputBox(ctx, c, [placeholder(c, type)]);
      if (flag(c, "password") && flag(c, "revealable")) control.append(icon("eye"));
    }
  }
  return h("div", { class: "fd-field" }, label, control, helper(c));
}

function renderEntryComp(c: Comp): HTMLElement {
  const name = short(c);
  const value = (() => {
    if (name === "IconEntry") return h("span", { class: "codicon codicon-pass-filled fd-green" });
    if (name === "ImageEntry") return h("span", { class: "fd-avatar square" });
    if (name === "ColorEntry") return h("span", { class: "fd-swatch" });
    if (name === "KeyValueEntry") return h("div", { class: "fd-keyvalue" }, h("div", { class: "fd-kv-head" }, h("span", {}, "Key"), h("span", {}, "Value")), h("div", { class: "fd-kv-row" }, h("span", {}, "key"), h("span", {}, "value")));
    const sample = sampleValue(c);
    return flag(c, "badge") ? h("span", { class: "fd-badge", style: badgeColor(c) }, sample) : h("span", { class: "fd-entry-value" }, sample);
  })();
  return h("div", { class: "fd-field fd-entry" }, h("div", { class: "fd-label-row" }, h("span", { class: "fd-label" }, labelOf(c))), value, helper(c));
}

// ---- Tables ----

const SAMPLES: [RegExp, string[]][] = [
  [/email/, ["jane@example.com", "omar@example.com", "li@example.com"]],
  [/first_name|^name$|full_name|author|user|customer|owner/, ["Jane Cooper", "Omar Haddad", "Li Wei"]],
  [/title|subject|headline/, ["Getting started", "Release notes", "Quarterly report"]],
  [/slug/, ["getting-started", "release-notes", "quarterly-report"]],
  [/status|state/, ["Published", "Draft", "Archived"]],
  [/category|type|kind|group/, ["News", "Guides", "Updates"]],
  [/city|location|address/, ["Tripoli", "Berlin", "Austin"]],
  [/phone|mobile/, ["+1 555 0100", "+1 555 0142", "+1 555 0199"]],
  [/price|amount|total|cost/, ["$120.00", "$89.50", "$1,240.00"]],
  [/count|quantity|qty|stock|number/, ["12", "4", "37"]],
  [/_at$|date|time/, ["Sep 28, 2026", "Sep 21, 2026", "Aug 30, 2026"]],
  [/url|website|link/, ["example.com", "laravel.com", "filamentphp.com"]],
  [/code|sku|reference/, ["INV-0012", "INV-0013", "INV-0014"]],
];

/** A made-up value for row `row` of a column, from its name and formatting. */
export function sampleValue(c: Comp, row = 0): string {
  const name = (c.name ?? "").toLowerCase().split(".").pop()!;
  if (flag(c, "money")) return ["$120.00", "$89.50", "$1,240.00"][row % 3];
  if (flag(c, "since")) return ["2 hours ago", "3 days ago", "1 month ago"][row % 3];
  if (flag(c, "date") || flag(c, "dateTime")) return [`Sep ${28 - row * 7}, 2026${flag(c, "dateTime") ? " 14:3" + row : ""}`][0];
  if (flag(c, "numeric")) return ["1,204", "86", "3,510"][row % 3];
  for (const [re, values] of SAMPLES) if (re.test(name)) return values[row % 3];
  return ["Lorem ipsum", "Dolor sit amet", "Consectetur"][row % 3];
}

const badgeColor = (c: Comp) => {
  const color = text(c, "color");
  return color && COLOR_SWATCH[color] ? `--badge:${COLOR_SWATCH[color]}` : "";
};

function cell(ctx: CanvasCtx, c: Comp, row: number): HTMLElement {
  const name = short(c);
  switch (name) {
    case "IconColumn":
      return flag(c, "boolean") ? h("span", { class: `codicon codicon-${row === 1 ? "error" : "pass-filled"} ${row === 1 ? "fd-red" : "fd-green"}` }) : heroicon(ctx.iconsDir, textValue(arg(c, "icon"))?.text ?? "o-check-circle");
    case "ImageColumn":
    case "SpatieMediaLibraryImageColumn":
      return h("span", { class: `fd-avatar${flag(c, "circular") ? "" : " square"}` });
    case "ToggleColumn":
      return h("span", { class: `fd-toggle small${row !== 1 ? " on" : ""}` });
    case "CheckboxColumn":
      return h("span", { class: `fd-checkbox${row !== 1 ? " on" : ""}` });
    case "SelectColumn":
      return h("span", { class: "fd-input small select" }, h("span", {}, optionsOf(c)[row % Math.max(1, optionsOf(c).length)]), icon("chevron-down"));
    case "TextInputColumn":
      return h("span", { class: "fd-input small" }, sampleValue(c, row));
    case "ColorColumn":
      return h("span", { class: "fd-swatch", style: `background:${["#f59e0b", "#3b82f6", "#22c55e"][row % 3]}` });
  }
  const value = sampleValue(c, row);
  const desc = text(c, "description");
  const main = flag(c, "badge") ? h("span", { class: "fd-badge", style: badgeColor(c) }, value) : h("span", {}, value);
  return h("div", { class: "fd-cell-text" }, main, desc ? h("span", { class: "fd-cell-desc" }, desc) : null);
}

/** A button as Filament shows an action: its icon and label, colored. */
function actionButton(ctx: CanvasCtx, c: Comp | null, compact = false): HTMLElement {
  if (!c) return h("span", { class: "fd-action code" }, icon("code"));
  const name = short(c);
  const known: Record<string, [string, string, string]> = {
    ViewAction: ["View", "o-eye", "gray"],
    EditAction: ["Edit", "o-pencil-square", "primary"],
    DeleteAction: ["Delete", "o-trash", "danger"],
    ForceDeleteAction: ["Force delete", "o-trash", "danger"],
    RestoreAction: ["Restore", "o-arrow-uturn-left", "gray"],
    ReplicateAction: ["Replicate", "o-square-2-stack", "gray"],
    CreateAction: ["New", "", "primary"],
    ExportAction: ["Export", "o-arrow-down-tray", "gray"],
    ImportAction: ["Import", "o-arrow-up-tray", "gray"],
    AttachAction: ["Attach", "", "gray"],
    AssociateAction: ["Associate", "", "gray"],
    DetachAction: ["Detach", "o-x-mark", "danger"],
    DissociateAction: ["Dissociate", "o-x-mark", "danger"],
    DeleteBulkAction: ["Delete selected", "o-trash", "danger"],
    ForceDeleteBulkAction: ["Force delete selected", "o-trash", "danger"],
    RestoreBulkAction: ["Restore selected", "o-arrow-uturn-left", "gray"],
  };
  const [defLabel, defIcon, defColor] = known[name] ?? [c.name ? labelFromName(c.name) : humanize(name.replace(/Action$/, "")), "", "primary"];
  const label = text(c, "label") ?? defLabel;
  const iconNode = arg(c, "icon");
  const iconName = iconNode?.kind === "classConst" ? iconNode.name : (textValue(iconNode)?.text ?? defIcon);
  const color = text(c, "color") ?? defColor;
  if (name.endsWith("ActionGroup")) return h("span", { class: "fd-action group", title: "Action group" }, icon("kebab-vertical"));
  return h("span", { class: `fd-action${compact ? " link" : " button"}`, style: `--action:${COLOR_SWATCH[color] ?? COLOR_SWATCH.primary}` }, iconName ? heroicon(ctx.iconsDir, iconName) : null, label);
}

/** The table's canvas: the toolbar, the header with its columns, three sample rows, and lanes for filters and actions. */
export function renderTable(ctx: CanvasCtx, o: { pluralLabel: string; createPage: boolean }): HTMLElement {
  const root = ctx.root;
  const columns = root.slots.get("columns");
  const filters = root.slots.get("filters");
  const recordActions = rootSlot(root, ["recordActions", "actions"]);
  const toolbar = rootSlot(root, ["toolbarActions", "bulkActions", "groupedBulkActions"]);
  const header = root.slots.get("headerActions");
  const colComps = columns?.entries ?? [];
  const searchable = colComps.some((e) => e.comp && flag(e.comp, "searchable"));
  const toggleable = colComps.some((e) => e.comp && call(e.comp, "toggleable"));
  const bulk = !!toolbar?.entries.length;

  const colPath = (e: Entry) => [{ slot: "columns", index: e.index }];
  const head = h("div", { class: "fd-thead" });
  if (bulk) head.append(h("span", { class: "fd-th fd-select-col" }, h("span", { class: "fd-checkbox" })));
  for (const e of colComps) {
    const path = colPath(e);
    const c = e.comp;
    const th = h(
      "div",
      { class: `fd-th${samePath(ctx.selection, path) ? " selected" : ""}${c && (call(c, "hidden") || call(c, "visible")) ? " conditional" : ""}`, title: c ? `${short(c)}('${c.name ?? ""}')` : "Code" },
      h("span", { class: "fd-th-label" }, c ? labelOf(c) : "Code"),
      c && flag(c, "sortable") ? icon("arrow-swap") : null,
      c && call(c, "toggleable") ? h("span", { class: "codicon codicon-eye fd-faint", title: "Can be hidden" }) : null,
    );
    th.dataset.index = String(e.index);
    th.onclick = (ev) => (ev.stopPropagation(), ctx.select(path));
    th.oncontextmenu = (ev) => (ev.preventDefault(), ev.stopPropagation(), ctx.select(path), ctx.menu(path, ev.clientX, ev.clientY));
    draggable(th, path);
    head.append(th);
  }
  head.append(h("button", { type: "button", class: "fd-th fd-add-col", title: "Add a column", onclick: (ev: MouseEvent) => (ev.stopPropagation(), ctx.add({ owner: null, slot: "columns" }, ev.currentTarget as HTMLElement)) }, icon("add")));
  if (recordActions?.entries.length) head.append(h("span", { class: "fd-th fd-actions-col" }));
  dropTarget(head, ctx, { owner: null, slot: "columns" }, columns ?? { via: "columns" }, null, true);

  const rows = [0, 1, 2].map((row) => {
    const tr = h("div", { class: "fd-tr" });
    if (bulk) tr.append(h("span", { class: "fd-td fd-select-col" }, h("span", { class: "fd-checkbox" })));
    for (const e of colComps) {
      const path = colPath(e);
      const td = h("div", { class: `fd-td${samePath(ctx.selection, path) ? " selected" : ""}` }, e.comp ? cell(ctx, e.comp, row) : h("span", { class: "fd-faint" }, "…"));
      td.onclick = (ev) => (ev.stopPropagation(), ctx.select(path));
      tr.append(td);
    }
    tr.append(h("span", { class: "fd-td fd-add-col" }));
    if (recordActions?.entries.length) tr.append(h("span", { class: "fd-td fd-actions-col" }, ...recordActions.entries.map((e) => actionButton(ctx, e.comp, true))));
    return tr;
  });
  const grid = [bulk ? "36px" : "", ...colComps.map(() => "minmax(110px, 1fr)"), "36px", recordActions?.entries.length ? "auto" : ""].filter(Boolean).join(" ");
  const table = h(
    "div",
    { class: "fd-table", style: `--grid:${grid}` },
    h(
      "div",
      { class: "fd-table-toolbar" },
      bulk ? h("span", { class: "fd-bulk-hint" }, icon("checklist"), "Bulk actions") : null,
      h("span", { class: "fd-spacer" }),
      searchable ? h("span", { class: "fd-input small fd-search" }, icon("search"), h("span", { class: "fd-placeholder" }, "Search")) : null,
      filters?.entries.length ? h("span", { class: "fd-tool", title: "Filters" }, icon("filter"), h("sup", {}, String(filters.entries.length))) : null,
      toggleable ? h("span", { class: "fd-tool", title: "Toggle columns" }, icon("layout")) : null,
    ),
    head,
    ...rows,
    h("div", { class: "fd-table-foot" }, h("span", {}, "Showing 1 to 3 of 3 results"), h("span", { class: "fd-spacer" }), h("span", { class: "fd-input small" }, "10 per page"), icon("chevron-left"), icon("chevron-right")),
  );
  if (!colComps.length) head.prepend(h("div", { class: "fd-th fd-empty-cols" }, "Drag columns here from the left, or click +"));

  const lane = (title: string, iconName: string, slot: Slot | undefined, slotName: string, hint: string) => {
    const chips = h("div", { class: "fd-lane-items" });
    for (const e of slot?.entries ?? []) {
      const path = [{ slot: slot!.via, index: e.index }];
      const chip = h("div", { class: `fd-chip-item${samePath(ctx.selection, path) ? " selected" : ""}` }, e.comp ? actionOrFilterChip(ctx, e.comp) : h("span", {}, icon("code"), "Code"));
      chip.dataset.index = String(e.index);
      chip.onclick = (ev) => (ev.stopPropagation(), ctx.select(path));
      chip.oncontextmenu = (ev) => (ev.preventDefault(), ev.stopPropagation(), ctx.select(path), ctx.menu(path, ev.clientX, ev.clientY));
      draggable(chip, path);
      // An action group's actions show inside it, and take drops.
      const groupSlot = e.comp?.slots[0];
      if (groupSlot && e.comp) {
        const inner = h("div", { class: "fd-lane-items nested" });
        for (const g of groupSlot.entries) {
          const gp = [...path, { slot: slotKey(groupSlot), index: g.index }];
          const gchip = h("div", { class: `fd-chip-item${samePath(ctx.selection, gp) ? " selected" : ""}` }, g.comp ? actionOrFilterChip(ctx, g.comp) : h("span", {}, "Code"));
          gchip.dataset.index = String(g.index);
          gchip.onclick = (ev) => (ev.stopPropagation(), ctx.select(gp));
          gchip.oncontextmenu = (ev) => (ev.preventDefault(), ev.stopPropagation(), ctx.select(gp), ctx.menu(gp, ev.clientX, ev.clientY));
          draggable(gchip, gp);
          inner.append(gchip);
        }
        inner.append(h("button", { type: "button", class: "fd-lane-add", title: "Add to the group", onclick: (ev: MouseEvent) => (ev.stopPropagation(), ctx.add({ owner: path, slot: slotKey(groupSlot) }, ev.currentTarget as HTMLElement)) }, icon("add")));
        dropTarget(inner, ctx, { owner: path, slot: slotKey(groupSlot) }, groupSlot, e.comp, true);
        chip.append(inner);
      }
      chips.append(chip);
    }
    const ref: SlotRef = { owner: null, slot: slot?.via ?? slotName };
    chips.append(h("button", { type: "button", class: "fd-lane-add", title: `Add ${title.toLowerCase()}`, onclick: (ev: MouseEvent) => (ev.stopPropagation(), ctx.add(ref, ev.currentTarget as HTMLElement)) }, icon("add"), slot?.entries.length ? null : h("span", {}, "Add")));
    dropTarget(chips, ctx, ref, slot ?? { via: slotName }, null, true);
    return h("div", { class: "fd-lane" }, h("div", { class: "fd-lane-title", title: hint }, icon(iconName), title), chips);
  };

  return h(
    "div",
    { class: "fd-table-canvas" },
    h("div", { class: "fd-page-head" }, h("h2", {}, o.pluralLabel), h("span", { class: "fd-spacer" }), ...(header?.entries ?? []).map((e) => actionButton(ctx, e.comp)), o.createPage ? h("span", { class: "fd-action button", style: `--action:${COLOR_SWATCH.primary}` }, `New ${o.pluralLabel.replace(/s$/, "").toLowerCase()}`) : null),
    table,
    h(
      "div",
      { class: "fd-lanes" },
      lane("Filters", "filter", filters, "filters", "Filters narrow the records the table shows."),
      lane("Row actions", "play", recordActions, "recordActions", "Buttons on each row, such as Edit."),
      lane("Bulk actions", "checklist", toolbar, "toolbarActions", "Actions on the selected rows, usually in a group."),
      lane("Header actions", "window", header, "headerActions", "Buttons above the table."),
    ),
  );
}

function actionOrFilterChip(ctx: CanvasCtx, c: Comp): HTMLElement {
  const info = classInfo(ctx.cat, c.cls);
  const iconNode = arg(c, "icon");
  const iconName = iconNode?.kind === "classConst" ? iconNode.name : textValue(iconNode)?.text;
  return h(
    "span",
    { class: "fd-chip-body" },
    iconName ? heroicon(ctx.iconsDir, iconName) : icon(look(info ?? c.cls).icon),
    h("span", {}, labelOf(c)),
    labelOf(c).toLowerCase().startsWith((short(c).replace(/(BulkAction|Action|Filter)$/, "") || short(c)).toLowerCase()) ? null : h("span", { class: "fd-chip-type" }, short(c).replace(/(Action|Filter)$/, "") || short(c)),
  );
}
