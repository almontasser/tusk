// Reads Filament's forms, infolists, and tables from code for the resource designer: each component is a
// `Class::make(...)` call with its chain of calls, and holds other components in array arguments, its slots, such
// as a section's `schema([...])` or an action group's `make([...])`. Anything else in a slot is code the designer
// keeps as it is. No editor imports, so Node tests it.
import { type ArrayNode, baseOf, callsOf, findCall, type OClass, type OMethod, type PCall, type PNode, type StaticNode, textValue } from "./phpcode.ts";

export type Comp = {
  node: PNode;
  /** The component's class, fully qualified. */
  cls: string;
  make: StaticNode;
  calls: PCall[];
  /** The first argument of `make()` when it's a plain or translated string: a field's name, a section's heading. */
  name: string | null;
  slots: Slot[];
};

/** An array argument that holds components. `via` is the call's name, or `make`. */
export type Slot = { via: string; arg: number; array: ArrayNode; entries: Entry[] };
export type Entry = { index: number; node: PNode; comp: Comp | null };

/** Calls whose array argument holds components even while it's empty. */
export const CONTAINER_CALLS = new Set([
  "schema",
  "components",
  "childComponents",
  "tabs",
  "steps",
  "blocks",
  "columns",
  "filters",
  "actions",
  "headerActions",
  "footerActions",
  "recordActions",
  "toolbarActions",
  "bulkActions",
  "groupedBulkActions",
  "emptyStateActions",
  "createOptionForm",
  "editOptionForm",
  "form",
]);

/** The component a node makes, or null for other code. */
export function readComp(node: PNode): Comp | null {
  const base = baseOf(node);
  if (base.kind !== "static" || base.method !== "make" || /^(self|static|parent)$/i.test(base.class)) return null;
  const calls = callsOf(node);
  const slots: Slot[] = [];
  const add = (via: string, args: StaticNode["args"]) =>
    args.items.forEach((item, arg) => {
      const v = item.value;
      if (v.kind !== "array" || item.spread) return;
      const entries = v.items.map((it, index) => ({ index, node: it.value, comp: it.key || it.spread ? null : readComp(it.value) }));
      const holds = entries.some((e) => e.comp) || (!entries.length && (via === "make" ? false : CONTAINER_CALLS.has(via)));
      if (holds && entries.every((e) => !v.items[e.index].key)) slots.push({ via, arg, array: v, entries });
    });
  add("make", base.args);
  for (const c of calls) add(c.name, c.args);
  const first = base.args.items[0];
  return { node, cls: base.class, make: base, calls, name: first && !first.name ? (textValue(first.value)?.text ?? null) : null, slots };
}

/**
 * The slot that holds a layout's children: `schema([...])`, `components([...])`, or `make([...])`, as
 * `Group::make([...])` and `Grid::make([...])` take them.
 */
export const childSlot = (comp: Comp): Slot | undefined => ["schema", "components", "childComponents", "make"].map((via) => comp.slots.find((s) => s.via === via)).find(Boolean);

/** A component's last call named `name`. */
export const callOf = (comp: Comp, name: string) => findCall(comp.node, name);

// ---- Roots: the form, infolist, or table a method returns ----

/** A page's header actions are a root too: `getHeaderActions()` returns their list. */
export type RootKind = "form" | "infolist" | "table" | "actions";

/** The calls that hold a root's components, by what they hold, in the order the designer shows them. */
export const ROOT_SLOTS: Record<RootKind, string[][]> = {
  form: [["components", "schema"]],
  infolist: [["components", "schema"]],
  table: [["columns"], ["filters"], ["recordActions", "actions"], ["toolbarActions", "bulkActions", "groupedBulkActions"], ["headerActions"]],
  actions: [["actions"]],
};

export type Root = {
  kind: RootKind;
  cls: OClass;
  method: OMethod;
  /** The returned expression: a chain of calls on the method's parameter, such as `$schema->components([...])`. */
  node: PNode;
  /** The parameter's name, such as `schema`. */
  param: string;
  /** Each slot the root has, by the call's name. */
  slots: Map<string, Slot>;
  /** Set when the method hands its work to another class, as Filament 4 writes them: `PostForm::configure($schema)`. */
  delegate?: { class: string; method: string };
  /** Set when the designer can't read the method: it returns something other than a chain on its parameter. */
  custom?: string;
  /**
   * Set when the chain starts from a helper that gets the parameter, as in
   * `self::configureTable($table)->recordActions([...])`: the helper builds part of it, and the calls after it
   * are the designer's to edit.
   */
  helper?: { class: string; method: string };
};

/** The class's form, infolist, or table method, read, or null when the class has none. */
export function readRoot(cls: OClass, kind: RootKind, methodName: string = kind === "actions" ? "getHeaderActions" : kind): Root | null {
  const method = cls.methods.find((m) => m.name.toLowerCase() === methodName.toLowerCase());
  if (!method) return null;
  const param = method.params[0]?.name ?? (kind === "table" ? "table" : "schema");
  const node = method.returns.at(-1);
  const root: Root = { kind, cls, method, node: node ?? ({ kind: "other", span: method.body ?? method.span } as PNode), param, slots: new Map() };
  if (!node) return { ...root, custom: "It doesn't return a value." };
  if (kind === "actions") {
    if (node.kind !== "array") return { ...root, custom: "It returns something other than a list of actions." };
    root.slots.set("actions", { via: "actions", arg: 0, array: node, entries: node.items.map((it, index) => ({ index, node: it.value, comp: it.key || it.spread ? null : readComp(it.value) })) });
    return root;
  }
  if (node.kind === "static" && node.args.items.some((a) => a.value.kind === "var" && a.value.name === param))
    return { ...root, delegate: { class: node.class, method: node.method } };
  const base = baseOf(node);
  const fromHelper = node.kind === "chain" && base.kind === "static" && base.args.items.some((a) => a.value.kind === "var" && a.value.name === param);
  if (fromHelper && base.kind === "static") root.helper = { class: base.class, method: base.method };
  else if (base.kind !== "var" || base.name !== param) return { ...root, custom: `It returns something other than $${param} with its calls.` };
  for (const call of callsOf(node)) {
    if (!ROOT_SLOTS[kind].flat().includes(call.name)) continue;
    const arg = call.args.items[0];
    if (arg?.value.kind !== "array") continue;
    root.slots.set(call.name, { via: call.name, arg: 0, array: arg.value, entries: arg.value.items.map((it, index) => ({ index, node: it.value, comp: it.key ? null : readComp(it.value) })) });
  }
  return root;
}

/** The slot of a root for a group of call names, such as the record actions in `actions` or `recordActions`. */
export const rootSlot = (root: Root, names: string[]) => names.map((n) => root.slots.get(n)).find(Boolean);

// ---- Paths: where a component is, which survives reading the code again after an edit ----

/** Each step names a slot (by its call's name and argument) and an index in it. The first step's slot is the root's. */
export type Step = { slot: string; index: number };
export type Path = Step[];

const slotKey = (s: Slot) => (s.arg ? `${s.via}#${s.arg}` : s.via);
export const slotNamed = (comp: Comp, key: string) => comp.slots.find((s) => slotKey(s) === key);
export { slotKey };

/** What a path leads to: the entry, the slot holding it, and the component that owns the slot (none for a root's). */
export type Found = { entry: Entry; slot: Slot; owner: Comp | null };

export function resolve(root: Root, path: Path): Found | null {
  let slot = root.slots.get(path[0]?.slot ?? "");
  let owner: Comp | null = null;
  for (let i = 0; slot && i < path.length; i++) {
    const entry = slot.entries[path[i].index];
    if (!entry) return null;
    if (i === path.length - 1) return { entry, slot, owner };
    if (!entry.comp) return null;
    owner = entry.comp;
    slot = slotNamed(entry.comp, path[i + 1].slot);
  }
  return null;
}

/** Every component under a root with its path, depth first, as the outline and the "visible when" fields list them. */
export function walk(root: Root, visit: (comp: Comp, path: Path) => void) {
  const go = (slot: Slot, prefix: Path) =>
    slot.entries.forEach((e) => {
      const path = [...prefix, { slot: prefix.length ? slotKey(slot) : slot.via, index: e.index }];
      if (!e.comp) return;
      visit(e.comp, path);
      for (const s of e.comp.slots) go(s, path);
    });
  for (const slot of root.slots.values()) go(slot, []);
}

/** The path one level up, and the slot key and index of the last step. */
export const parentOf = (path: Path) => ({ parent: path.slice(0, -1), last: path[path.length - 1] });

export const samePath = (a: Path | null | undefined, b: Path | null | undefined) =>
  !!a && !!b && a.length === b.length && a.every((s, i) => s.slot === b[i].slot && s.index === b[i].index);

/** Whether `inner` is `outer` or inside it, so a component can't be dropped into itself. */
export const within = (inner: Path, outer: Path) => outer.length <= inner.length && outer.every((s, i) => s.slot === inner[i].slot && s.index === inner[i].index);

/** Short class name. */
export const shortClass = (fqn: string) => fqn.slice(fqn.lastIndexOf("\\") + 1);
