// The navigation designer's logic: a panel's sidebar in the order Filament builds it, from introspect.php's
// `navigation` mode, and the edits that move items between groups, into order, and into clusters. Each item's
// settings are its class's static properties; a method that decides one makes it code, which stays as written.
// No editor imports, so Node tests it.
import { addMember, type Edit, indentUnit, lineIndent, methodNamed, type OClass, type OMethod, phpString, type PNode, propertyNamed, reindent, removeMethod, removeProperty, replaceNode, setCall, setProperty, textValue } from "./phpcode.ts";
import { type PanelCode, readNavGroups } from "./panelgen.ts";

/** A navigation group as an item names it: a label, or an enum case with its label and its place among the cases. */
export type NavGroupRef = { label: string; enum: string | null; case: string | null; index?: number | null };
export type NavItem = {
  kind: "page" | "dashboard" | "cluster" | "resource" | "link";
  class: string | null;
  file: string | null;
  label: string | null;
  icon: string | null;
  group: NavGroupRef | null;
  sort: number | null;
  parent: string | null;
  badge: string | null;
  cluster: string | null;
  registers: boolean;
  hasItem: boolean;
  /** Settings a method outside Filament decides, with the file that declares it. */
  overrides: Partial<Record<NavSetting, string | null>>;
};
export type PanelNav = {
  items: NavItem[];
  groups: { key: string | number; label: string | null; icon: string | null; collapsed: boolean }[];
  /** The provider builds the navigation itself, with navigation(fn ...) or turns it off. */
  custom: boolean;
  topNavigation: boolean;
};

export type SideItem = NavItem & { children: NavItem[] };
export type SideGroup = { key: string; group: NavGroupRef | null; items: SideItem[] };

/** A group's identity: its enum case, or its label. Ungrouped items have "". */
export const groupKey = (g: NavGroupRef | null) => (g ? (g.enum ? `${g.enum}::${g.case}` : g.label) : "");

/**
 * The sidebar as Filament builds it: items sorted by their sort (none counts as -1, ties keep the order Filament
 * registers them in), grouped, ungrouped first, then groups in the panel's `navigationGroups()` order, an enum's
 * groups in the order of its cases, and other groups after those. Items nest under their parent item. `registered`
 * is null for a cluster's own navigation, whose groups come in the order their first item does. Hidden items are
 * kept, for showing again.
 */
export function sidebar(items: NavItem[], registered: PanelNav["groups"] | null, cluster: string | null = null): SideGroup[] {
  const shown = items.filter((i) => i.hasItem && (i.cluster ?? null) === cluster).sort((a, b) => (a.sort ?? -1) - (b.sort ?? -1));
  const groups = new Map<string, SideGroup>();
  for (const item of shown) {
    const key = groupKey(item.group);
    if (!groups.has(key)) groups.set(key, { key, group: item.group, items: [] });
    groups.get(key)!.items.push({ ...item, children: [] });
  }
  for (const g of groups.values()) {
    const top = g.items.filter((i) => !i.parent);
    for (const child of g.items.filter((i) => i.parent)) {
      const parent = top.find((p) => p.class === child.parent || p.label === child.parent);
      // Filament drops an item whose parent isn't there; it stays at the top here, so it can be fixed.
      if (parent) parent.children.push(child);
      else top.push(child);
    }
    g.items = top;
  }
  const rank = (g: SideGroup) => {
    if (!g.group) return -1;
    if (!registered) return 0;
    if (g.group.enum && typeof g.group.index === "number") return g.group.index;
    const name = g.group.enum ? g.group.case : g.group.label;
    const i = registered.findIndex((r) => r.key === name || r.label === name);
    return i < 0 ? registered.length : i;
  };
  return [...groups.values()].sort((a, b) => rank(a) - rank(b));
}

// ---- Reading an item's settings ----

export type NavSetting = "navigationLabel" | "navigationIcon" | "navigationGroup" | "navigationSort" | "navigationParentItem" | "shouldRegisterNavigation" | "cluster";

const GETTER: Record<NavSetting, string> = {
  navigationLabel: "getNavigationLabel",
  navigationIcon: "getNavigationIcon",
  navigationGroup: "getNavigationGroup",
  navigationSort: "getNavigationSort",
  navigationParentItem: "getNavigationParentItem",
  shouldRegisterNavigation: "shouldRegisterNavigation",
  cluster: "getCluster",
};

/** Filament 4's declarations, for a property the class doesn't have yet. */
const DECLARATION: Record<NavSetting, string> = {
  navigationLabel: "protected static ?string $navigationLabel",
  navigationIcon: "protected static string|{{BackedEnum}}|null $navigationIcon",
  navigationGroup: "protected static string|{{UnitEnum}}|null $navigationGroup",
  navigationSort: "protected static ?int $navigationSort",
  navigationParentItem: "protected static ?string $navigationParentItem",
  shouldRegisterNavigation: "protected static bool $shouldRegisterNavigation",
  cluster: "protected static ?string $cluster",
};

/** Names a getter returning `__('…')` can translate, and that getter's signature. */
const TRANSLATED: Partial<Record<NavSetting, string>> = {
  navigationLabel: "public static function getNavigationLabel(): string",
  navigationGroup: "public static function getNavigationGroup(): ?string",
};

export type Readout =
  | { kind: "default" }
  | { kind: "value"; node: PNode }
  | { kind: "translated"; method: OMethod; text: string }
  | { kind: "code"; at: PNode | OMethod | null; why: string };

/** Whether a property's value is one the designer reads and writes for the setting. */
function readable(s: NavSetting, n: PNode): boolean {
  if (n.kind === "null") return true;
  switch (s) {
    case "navigationIcon":
      return n.kind === "classConst" || !!textValue(n);
    case "navigationGroup":
      return n.kind === "classConst" || (n.kind === "string" && !n.interpolated);
    case "navigationSort":
      return n.kind === "number";
    case "shouldRegisterNavigation":
      return n.kind === "bool";
    case "cluster":
      return n.kind === "classConst" && n.name === "class";
    default:
      return n.kind === "string" && !n.interpolated;
  }
}

/**
 * A setting as the class writes it: Filament's default, a value the designer reads, a translated getter, or code,
 * such as a method that decides it. `inherited` names the file of a parent class whose method decides it.
 */
export function readNav(cls: OClass, s: NavSetting, inherited?: string | null): Readout {
  const getter = methodNamed(cls, GETTER[s]);
  if (getter) {
    const t = TRANSLATED[s] && getter.returns.length === 1 ? textValue(getter.returns[0]) : undefined;
    if (t?.translated) return { kind: "translated", method: getter, text: t.text };
    return { kind: "code", at: getter, why: `${getter.name}() decides this, so a property would be ignored.` };
  }
  if (inherited) return { kind: "code", at: null, why: `A method in ${inherited} decides this.` };
  const prop = propertyNamed(cls, s);
  if (!prop?.value) return { kind: "default" };
  return readable(s, prop.value) ? { kind: "value", node: prop.value } : { kind: "code", at: prop.value, why: "It's written as code the designer doesn't change." };
}

/** Whether the designer can change a setting: not when code decides it. */
export const editable = (r: Readout) => r.kind !== "code";

// ---- Writing an item's settings ----

/**
 * Edits to one class from several settings, inserts first: a new property goes where a removed getter starts, and
 * mergeEdits keeps inserts at an offset before an edit that starts there.
 */
export const combine = (...lists: Edit[][]): Edit[] => lists.flat().sort((a, b) => Number(a.start !== a.end) - Number(b.start !== b.end));

/** Sets a setting's property to `code`, or back to Filament's default when null, replacing a translated getter. */
export function setNav(text: string, cls: OClass, s: NavSetting, code: string | null): Edit[] {
  const edits: Edit[] = [];
  const getter = methodNamed(cls, GETTER[s]);
  if (getter) edits.push(removeMethod(text, getter));
  const prop = propertyNamed(cls, s);
  if (code === null) return prop ? [...edits, removeProperty(text, prop)] : edits;
  return combine(edits, [setProperty(text, cls, s, code, DECLARATION[s])]);
}

/** Writes a label or group as a getter returning `__('text')`, since a property can't call __(). */
export function setTranslated(text: string, cls: OClass, s: NavSetting, value: string): Edit[] {
  const getter = methodNamed(cls, GETTER[s]);
  const ret = getter?.returns.length === 1 ? getter.returns[0] : null;
  if (ret && textValue(ret)?.translated) return [replaceNode(text, ret, `__(${phpString(value)})`)];
  const prop = propertyNamed(cls, s);
  return combine(prop ? [removeProperty(text, prop)] : [], [addMember(text, cls, `${TRANSLATED[s]}\n{\n    return __(${phpString(value)});\n}`)]);
}

/** A group to move an item into, written as the project writes it: a string, `__()`, or an enum case. */
export type GroupTarget = { label: string; enum: string | null; case: string | null; translated: boolean } | null;

/** The edits that put an item in a group, or in no group. */
export function groupEdits(text: string, cls: OClass, t: GroupTarget): Edit[] {
  if (!t) return setNav(text, cls, "navigationGroup", null);
  if (t.enum && t.case) return setNav(text, cls, "navigationGroup", `{{${t.enum}}}::${t.case}`);
  if (t.translated) return setTranslated(text, cls, "navigationGroup", t.label);
  return setNav(text, cls, "navigationGroup", phpString(t.label));
}

/** Renames an item's group where the class writes it as text, keeping `__()`. */
export function renameGroupEdits(text: string, cls: OClass, to: string): Edit[] {
  const r = readNav(cls, "navigationGroup");
  if (r.kind === "translated") return [replaceNode(text, r.method.returns[0], `__(${phpString(to)})`)];
  if (r.kind === "value" && r.node.kind === "string") return [replaceNode(text, r.node, phpString(to))];
  return [];
}

/**
 * New sorts for a group's items in their new order. Items whose sort is fixed (decided by code, or in a package)
 * keep theirs; the others count up from 1, and from past a fixed item before them.
 */
export function orderSorts(order: { sort: number | null; fixed: boolean }[]): (number | null)[] {
  let last = 0;
  return order.map((o) => {
    if (o.fixed) {
      last = Math.max(last, o.sort ?? -1);
      return o.sort;
    }
    return ++last;
  });
}

// ---- The provider ----

/**
 * Lists the panel's navigation groups in `order`, rewriting `navigationGroups([...])`: each listed group keeps its
 * code (a label or a NavigationGroup with its icon) and the comments above it, groups it doesn't name keep their
 * places after these, and new ones are written as labels.
 */
export function groupOrderEdits(text: string, code: PanelCode, order: { label: string; translated: boolean }[]): Edit[] {
  const { arr, code: other, groups } = readNavGroups(text, code);
  if (other) return [];
  const label = (o: { label: string; translated: boolean }) => (o.translated ? `__(${phpString(o.label)})` : phpString(o.label));
  if (!arr) return code.main ? [setCall(text, code.main, "navigationGroups", `[\n${order.map((o) => `    ${label(o)},`).join("\n")}\n]`)] : [];
  if (arr.legacy) return [];
  // Each item with the comments before it, back to the previous item's comma.
  const segments = arr.items.map((item, i) => {
    let start = i === 0 ? arr.open + 1 : arr.items[i - 1].span[1];
    if (i > 0) {
      const comma = text.indexOf(",", start);
      if (comma >= 0 && comma < item.span[0]) start = comma + 1;
    }
    while (/\s/.test(text[start])) start++;
    return reindent(text.slice(start, item.span[1]), lineIndent(text, start), "");
  });
  const used = new Set<number>();
  const list = order.map((o) => {
    const i = groups.findIndex((g, j) => !used.has(j) && g.label === o.label);
    if (i < 0) return label(o);
    used.add(i);
    return segments[i];
  });
  list.push(...segments.filter((_, i) => !used.has(i)));
  const unit = indentUnit(text);
  const multiline = arr.items.length === 0 || text.slice(arr.open, arr.items[0].span[0]).includes("\n") || list.some((s) => s.includes("\n"));
  const outer = lineIndent(text, arr.open);
  const indent = arr.items.length && multiline && text.slice(arr.open, arr.items[0].span[0]).includes("\n") ? lineIndent(text, arr.items[0].span[0]) : outer + unit;
  const body = multiline ? `\n${list.map((s) => `${indent}${s.replace(/\n/g, `\n${indent}`)},`).join("\n")}\n${outer}` : list.join(", ");
  return [{ start: arr.open + 1, end: arr.close, text: body }];
}

/** The provider's `discoverClusters()` call, next to its pages' folder, for a panel that doesn't discover clusters. */
export function discoverClustersEdits(text: string, code: PanelCode, pageDir: string | null, pageNamespace: string | null): Edit[] {
  if (!code.main) return [];
  const dir = (pageDir ?? "app/Filament/Pages").replace(/[^/]+$/, "Clusters");
  const ns = (pageNamespace ?? "App\\Filament\\Pages").replace(/[^\\]+$/, "Clusters");
  const path = dir.startsWith("app/") ? `app_path('${dir.slice(4)}')` : `base_path('${dir}')`;
  return [setCall(text, code.main, "discoverClusters", `in: ${path}, for: '${ns}'`, undefined, "discoverPages")];
}
