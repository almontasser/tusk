// Filament's components for the designers, as the project has them: `introspect.php filament-catalog` lists every
// component, column, filter, and action class in Filament's packages, in plugins, and in the project, with the
// fluent methods that configure each. The designers build their palettes and property editors from it, so a plugin's
// components and a new Filament version's methods need no changes here. What this module adds is taste: palette
// groups and icons, the settings to show first, and editors for values a type can't describe, such as icons and
// colors. No editor imports, so Node tests it.
import { shortClass } from "./filamentschema.ts";

export type Kind = "field" | "layout" | "entry" | "column" | "columnLayout" | "filter" | "action" | "bulkAction" | "actionGroup" | "widget";
export type CParam = { name: string; types: string[]; default?: string; optional?: boolean; variadic?: boolean };
export type CMethod = { params: CParam[]; doc?: string; deprecated?: boolean };
export type CClass = { class: string; kind: Kind; package: string; parents: string[]; interfaces: string[]; make: CParam[]; sources: string[]; doc?: string; deprecated?: boolean };
export type Catalog = {
  version: string | null;
  classes: CClass[];
  sources: Record<string, { label: string; methods: Record<string, CMethod> }>;
  enums: Record<string, { name: string; value: string | number | null }[]>;
  resourceProperties: Record<string, { type: string | null; default: string | null }>;
  relationManagerProperties: Record<string, { type: string | null; default: string | null }>;
  heroicons: string[];
  heroiconsDir: string | null;
};

/** Filament's major version, from the catalog's `v4.1.0`, or 0 when it isn't known. */
export const majorVersion = (cat: Pick<Catalog, "version">) => Number(/(\d+)/.exec(cat.version ?? "")?.[1] ?? 0);

export const classInfo = (cat: Catalog, fqn: string) => cat.classes.find((c) => c.class.toLowerCase() === fqn.replace(/^\\/, "").toLowerCase());

/** Whether a class is `base` or extends it. */
export const isA = (cls: CClass | undefined, base: string) => !!cls && (cls.class === base || cls.parents.includes(base));

export type MethodInfo = { name: string; method: CMethod; source: string; label: string };

/** A class's configuring methods, each from the class or trait PHP takes it from, by name. */
export function methodsOf(cat: Catalog, cls: CClass): Map<string, MethodInfo> {
  const out = new Map<string, MethodInfo>();
  for (const source of cls.sources) {
    const s = cat.sources[source];
    if (!s) continue;
    for (const [name, method] of Object.entries(s.methods)) if (!out.has(name)) out.set(name, { name, method, source, label: s.label });
  }
  return out;
}

// ---- Editors ----

export type Editor =
  /** A call with no arguments, on or off, such as `columnSpanFull()`. */
  | { kind: "presence" }
  /** A boolean condition: on is the call without arguments, off is no call. */
  | { kind: "switch" }
  | { kind: "text"; multiline?: boolean }
  | { kind: "number"; integer: boolean }
  | { kind: "enum"; enum: string }
  | { kind: "icon" }
  | { kind: "color" }
  /** A list of strings, such as accepted file types. */
  | { kind: "list" }
  /** A map of values to labels, such as a select's options. */
  | { kind: "map" }
  /** Any plain value: a number, true or false, or text. */
  | { kind: "value" }
  /** Something only code can say, such as a closure. */
  | { kind: "code" };

const CLOSURE = new Set(["Closure", "callable", "null", "mixed"]);

/** The editor for one parameter, from its name and types. */
export function paramEditor(cat: Pick<Catalog, "enums">, method: string, p: CParam): Editor {
  const types = p.types.filter((t) => !CLOSURE.has(t));
  const has = (t: string) => types.includes(t);
  if (/icon$/i.test(p.name) || (/icon/i.test(method) && (has("BackedEnum") || has("string")) && /icon/i.test(p.name))) return { kind: "icon" };
  if (/color$/i.test(p.name) && (has("string") || has("array"))) return { kind: "color" };
  const enumType = types.find((t) => cat.enums[t]);
  if (enumType && types.every((t) => t === enumType || t === "string" || t === "BackedEnum" || t === "UnitEnum")) return { kind: "enum", enum: enumType };
  if (types.length && types.every((t) => t === "bool")) return { kind: "switch" };
  // Grid columns take a number, or an array of them by breakpoint, which code can hold.
  if (/^(columns|columnSpan|rows|maxItems|minItems|limit)$/.test(method) && has("int")) return { kind: "number", integer: true };
  if ((has("int") || has("float")) && !has("string") && !has("array")) return { kind: "number", integer: !has("float") };
  // Options take an array, or an enum's class name as a string.
  if ((has("array") || has("Arrayable")) && /options|descriptions|labels/i.test(method)) return { kind: "map" };
  if (has("string") || has("Htmlable") || has("Stringable")) return { kind: "text", multiline: /description|helperText|content|body|html|markdown/i.test(method) };
  if ((has("int") || has("float")) && has("string")) return { kind: "text" };
  if (has("array") || has("Arrayable")) return /options|descriptions|labels/i.test(method) ? { kind: "map" } : { kind: "list" };
  if (!types.length && p.types.includes("mixed")) return { kind: "value" };
  return { kind: "code" };
}

/** The editor for a method: a switch or a presence toggle for flags, otherwise its first parameter's editor. */
export function methodEditor(cat: Pick<Catalog, "enums">, name: string, m: CMethod): Editor {
  const params = m.params;
  if (!params.length) return { kind: "presence" };
  const [first, ...rest] = params;
  const flag = first.types.includes("bool") && (first.default === "true" || first.optional) && (first.name === "condition" || !first.types.some((t) => /^(string|int|float|array)$/.test(t)));
  if (flag && rest.every((r) => r.optional)) return { kind: "switch" };
  return paramEditor(cat, name, first);
}

/** "maxLength" → "Max length". */
export const humanize = (name: string) => {
  const words = name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_.]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A field's label as Filament makes it from its name: `category_id` → "Category", `author.name` → "Author name". */
export const labelFromName = (name: string) => humanize(name.replace(/_id$/, "").replace(/\./g, " "));

// ---- The palette ----

export type PaletteGroup = { label: string; classes: CClass[] };
type Look = { icon: string; group: string; order?: number; hint?: string };

/** Codicons and palette groups for Filament's own classes, by short name. Classes not listed go under Other. */
const LOOKS: Record<string, Look> = {
  // Fields
  TextInput: { icon: "symbol-string", group: "Text", order: 1, hint: "One line of text, a number, an email, a password" },
  Textarea: { icon: "note", group: "Text", order: 2, hint: "Several lines of plain text" },
  RichEditor: { icon: "book", group: "Text", order: 3, hint: "Formatted text with a toolbar" },
  MarkdownEditor: { icon: "markdown", group: "Text", order: 4, hint: "Markdown with a preview" },
  CodeEditor: { icon: "code", group: "Text", order: 5 },
  Select: { icon: "list-selection", group: "Choice", order: 1, hint: "A dropdown: options, an enum, or a relationship" },
  Radio: { icon: "circle-large-outline", group: "Choice", order: 2 },
  CheckboxList: { icon: "checklist", group: "Choice", order: 3 },
  ToggleButtons: { icon: "symbol-enum", group: "Choice", order: 4 },
  Toggle: { icon: "symbol-boolean", group: "Choice", order: 5, hint: "An on/off switch" },
  Checkbox: { icon: "pass", group: "Choice", order: 6 },
  Slider: { icon: "settings", group: "Choice", order: 7 },
  DatePicker: { icon: "calendar", group: "Date and time", order: 1 },
  DateTimePicker: { icon: "calendar", group: "Date and time", order: 2 },
  TimePicker: { icon: "watch", group: "Date and time", order: 3 },
  FileUpload: { icon: "cloud-upload", group: "Files", order: 1, hint: "Files or images, stored on a disk" },
  SpatieMediaLibraryFileUpload: { icon: "file-media", group: "Files", order: 2 },
  Repeater: { icon: "symbol-array", group: "Structured", order: 1, hint: "A list of items, each with its own fields" },
  Builder: { icon: "symbol-structure", group: "Structured", order: 2, hint: "Content made of blocks" },
  KeyValue: { icon: "symbol-key", group: "Structured", order: 3 },
  TagsInput: { icon: "tag", group: "Structured", order: 4 },
  TableSelect: { icon: "table", group: "Structured", order: 5 },
  ModalTableSelect: { icon: "table", group: "Structured", order: 6 },
  ColorPicker: { icon: "symbol-color", group: "Other", order: 1 },
  Hidden: { icon: "eye-closed", group: "Other", order: 2, hint: "A value the form sends without showing it" },
  OneTimeCodeInput: { icon: "key", group: "Other", order: 3 },
  ViewField: { icon: "file-code", group: "Other", order: 8 },
  LivewireField: { icon: "zap", group: "Other", order: 9 },
  // Layout
  Section: { icon: "layout-panel", group: "Layout", order: 1, hint: "A card with a heading around fields" },
  Grid: { icon: "layout", group: "Layout", order: 2, hint: "Columns without a border" },
  Tabs: { icon: "multiple-windows", group: "Layout", order: 3 },
  Tab: { icon: "window", group: "Layout", order: 4 },
  Fieldset: { icon: "symbol-namespace", group: "Layout", order: 5 },
  Wizard: { icon: "milestone", group: "Layout", order: 6, hint: "Steps, one after another" },
  Step: { icon: "debug-step-over", group: "Layout", order: 7 },
  Group: { icon: "layers", group: "Layout", order: 8 },
  Flex: { icon: "split-horizontal", group: "Layout", order: 9 },
  FusedGroup: { icon: "layers", group: "Layout", order: 10 },
  Text: { icon: "symbol-text", group: "Content", order: 1 },
  Callout: { icon: "info", group: "Content", order: 2 },
  Icon: { icon: "star-empty", group: "Content", order: 3 },
  Image: { icon: "file-media", group: "Content", order: 4 },
  Html: { icon: "code", group: "Content", order: 5 },
  UnorderedList: { icon: "list-unordered", group: "Content", order: 6 },
  EmptyState: { icon: "circle-slash", group: "Content", order: 7 },
  Actions: { icon: "play", group: "Content", order: 8 },
  View: { icon: "file-code", group: "Content", order: 9 },
  Livewire: { icon: "zap", group: "Content", order: 10 },
  EmbeddedTable: { icon: "table", group: "Content", order: 11 },
  EmbeddedSchema: { icon: "symbol-structure", group: "Content", order: 12 },
  // Columns
  TextColumn: { icon: "symbol-string", group: "Columns", order: 1, hint: "Text, numbers, dates, money, or badges" },
  IconColumn: { icon: "star-empty", group: "Columns", order: 2, hint: "An icon, or a check for a boolean" },
  ImageColumn: { icon: "file-media", group: "Columns", order: 3 },
  ColorColumn: { icon: "symbol-color", group: "Columns", order: 4 },
  ToggleColumn: { icon: "symbol-boolean", group: "Editable columns", order: 1 },
  CheckboxColumn: { icon: "pass", group: "Editable columns", order: 2 },
  SelectColumn: { icon: "list-selection", group: "Editable columns", order: 3 },
  TextInputColumn: { icon: "symbol-string", group: "Editable columns", order: 4 },
  SpatieMediaLibraryImageColumn: { icon: "file-media", group: "Columns", order: 5 },
  ViewColumn: { icon: "file-code", group: "Columns", order: 9 },
  // Entries
  TextEntry: { icon: "symbol-string", group: "Entries", order: 1 },
  IconEntry: { icon: "star-empty", group: "Entries", order: 2 },
  ImageEntry: { icon: "file-media", group: "Entries", order: 3 },
  ColorEntry: { icon: "symbol-color", group: "Entries", order: 4 },
  KeyValueEntry: { icon: "symbol-key", group: "Entries", order: 5 },
  RepeatableEntry: { icon: "symbol-array", group: "Entries", order: 6 },
  CodeEntry: { icon: "code", group: "Entries", order: 7 },
  SpatieMediaLibraryImageEntry: { icon: "file-media", group: "Entries", order: 8 },
  ViewEntry: { icon: "file-code", group: "Entries", order: 9 },
  // Filters
  SelectFilter: { icon: "list-selection", group: "Filters", order: 1, hint: "Pick from options or a relationship" },
  TernaryFilter: { icon: "symbol-boolean", group: "Filters", order: 2, hint: "Yes, no, or either" },
  TrashedFilter: { icon: "trash", group: "Filters", order: 3, hint: "With or without soft-deleted records" },
  Filter: { icon: "filter", group: "Filters", order: 4, hint: "A checkbox or a small form with your own query" },
  QueryBuilder: { icon: "filter-filled", group: "Filters", order: 5 },
  // Actions
  ViewAction: { icon: "eye", group: "Record", order: 1 },
  EditAction: { icon: "edit", group: "Record", order: 2 },
  DeleteAction: { icon: "trash", group: "Record", order: 3 },
  ReplicateAction: { icon: "copy", group: "Record", order: 4 },
  ForceDeleteAction: { icon: "trash", group: "Record", order: 5 },
  RestoreAction: { icon: "discard", group: "Record", order: 6 },
  CreateAction: { icon: "add", group: "Page", order: 1 },
  ExportAction: { icon: "export", group: "Page", order: 2 },
  ImportAction: { icon: "desktop-download", group: "Page", order: 3 },
  AttachAction: { icon: "link", group: "Relationship", order: 1 },
  DetachAction: { icon: "debug-disconnect", group: "Relationship", order: 2 },
  AssociateAction: { icon: "link", group: "Relationship", order: 3 },
  DissociateAction: { icon: "debug-disconnect", group: "Relationship", order: 4 },
  Action: { icon: "play", group: "Custom", order: 1, hint: "A button that runs your own code or opens a URL" },
  ActionGroup: { icon: "kebab-vertical", group: "Groups", order: 1, hint: "Actions in a dropdown" },
  BulkActionGroup: { icon: "kebab-vertical", group: "Groups", order: 2 },
  DeleteBulkAction: { icon: "trash", group: "Bulk", order: 1 },
  ForceDeleteBulkAction: { icon: "trash", group: "Bulk", order: 2 },
  RestoreBulkAction: { icon: "discard", group: "Bulk", order: 3 },
  ExportBulkAction: { icon: "export", group: "Bulk", order: 4 },
  DetachBulkAction: { icon: "debug-disconnect", group: "Bulk", order: 5 },
  DissociateBulkAction: { icon: "debug-disconnect", group: "Bulk", order: 6 },
  BulkAction: { icon: "play", group: "Custom", order: 2 },
};

/** Base classes and old names the palette leaves out: they're abstract in spirit, or replaced by others. */
const UNLISTED = new Set([
  "Field",
  "Column",
  "Entry",
  "BaseFilter",
  "BaseFileUpload",
  "MultiSelect",
  "BadgeColumn",
  "BooleanColumn",
  "TagsColumn",
  "ButtonAction",
  "IconButtonAction",
  "SelectAction",
  "FilterAction",
  "CopyAction",
  "HidePasswordAction",
  "ShowPasswordAction",
  "MultiSelectFilter",
  "Form",
  "RenderHook",
  "Placeholder",
  "Stat",
  "MorphToSelect",
]);

export function look(cls: CClass | string): Look {
  const name = typeof cls === "string" ? shortClass(cls) : shortClass(cls.class);
  const known = LOOKS[name];
  if (known && (typeof cls === "string" || cls.package.startsWith("filament/"))) return known;
  if (typeof cls !== "string" && cls.package === "app") return { icon: "folder", group: "Project" };
  if (typeof cls !== "string" && !cls.package.startsWith("filament/")) return { icon: "extensions", group: "Plugins" };
  const kind = typeof cls === "string" ? "" : cls.kind;
  const fallback: Record<string, string> = { field: "symbol-field", layout: "layout", entry: "symbol-string", column: "symbol-string", filter: "filter", action: "play", bulkAction: "play", actionGroup: "kebab-vertical" };
  return { icon: fallback[kind] ?? "symbol-class", group: "Other", order: 99 };
}

/** Which kinds a palette offers where. */
export const PALETTE_KINDS: Record<string, Kind[]> = {
  form: ["field", "layout"],
  infolist: ["entry", "layout"],
  columns: ["column", "columnLayout"],
  filters: ["filter"],
  recordActions: ["action", "actionGroup"],
  toolbarActions: ["bulkAction", "actionGroup", "action"],
  headerActions: ["action", "actionGroup"],
  actions: ["action", "actionGroup"],
};

const GROUP_ORDER = ["Text", "Choice", "Date and time", "Files", "Structured", "Columns", "Editable columns", "Entries", "Layout", "Content", "Filters", "Record", "Bulk", "Groups", "Page", "Relationship", "Custom", "Other", "Project", "Plugins"];

/** The palette for a place: groups of classes of its kinds, the common ones first, without deprecated classes. */
export function palette(cat: Catalog, kinds: Kind[], query = ""): PaletteGroup[] {
  const q = query.trim().toLowerCase();
  const groups = new Map<string, CClass[]>();
  for (const c of cat.classes) {
    const short = shortClass(c.class);
    if (!kinds.includes(c.kind) || c.deprecated || (UNLISTED.has(short) && c.package.startsWith("filament/"))) continue;
    // Table layouts share names with schema layouts; they're listed under their own group.
    const l = c.kind === "columnLayout" ? { icon: "layout", group: "Column layout", order: 9 } : look(c);
    if (q && !`${short} ${humanize(short)} ${l.hint ?? ""} ${c.doc ?? ""}`.toLowerCase().includes(q)) continue;
    if (!groups.has(l.group)) groups.set(l.group, []);
    groups.get(l.group)!.push(c);
  }
  const rank = (g: string) => (GROUP_ORDER.includes(g) ? GROUP_ORDER.indexOf(g) : GROUP_ORDER.length);
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([label, classes]) => ({ label, classes: classes.sort((a, b) => (look(a).order ?? 50) - (look(b).order ?? 50) || shortClass(a.class).localeCompare(shortClass(b.class))) }));
}

// ---- The inspector's first settings ----

/**
 * The settings the inspector shows first, by kind and by class. Names starting with `@` are the designer's own
 * editors, which set several calls at once: `@name` (make's first argument), `@inputType`, `@options`,
 * `@span`, `@format`, and `@visibility`.
 */
const ESSENTIALS: Record<string, string[]> = {
  field: ["@name", "label", "placeholder", "helperText", "hint", "default", "required", "disabled", "live", "@span"],
  entry: ["@name", "label", "placeholder", "helperText", "@format", "badge", "color", "icon", "copyable", "@span"],
  layout: ["@name", "description", "icon", "columns", "@span"],
  column: ["@name", "label", "searchable", "sortable", "toggleable", "@format", "badge", "color", "icon", "description", "limit", "wrap", "alignment", "tooltip"],
  columnLayout: ["@name", "columns", "from", "space"],
  filter: ["@name", "label", "@options", "multiple", "searchable", "preload", "default", "toggle"],
  action: ["@behavior", "label", "icon", "color", "tooltip", "requiresConfirmation", "modalHeading", "modalDescription", "modalSubmitActionLabel", "modalWidth", "slideOver", "url", "openUrlInNewTab", "button", "link", "iconButton", "outlined", "size"],
  bulkAction: ["@behavior", "label", "icon", "color", "requiresConfirmation", "modalHeading", "modalDescription", "modalSubmitActionLabel", "deselectRecordsAfterCompletion"],
  actionGroup: ["label", "icon", "color", "tooltip", "button", "link", "iconButton", "dropdownPlacement"],
  widget: [],
};
const BY_CLASS: Record<string, string[]> = {
  TextInput: ["@inputType", "maxLength", "minLength", "prefix", "suffix", "prefixIcon", "suffixIcon", "unique", "autocomplete", "mask", "revealable", "copyable"],
  Textarea: ["rows", "autosize", "maxLength"],
  RichEditor: ["toolbarButtons", "fileAttachmentsDirectory", "maxLength"],
  MarkdownEditor: ["toolbarButtons", "fileAttachmentsDirectory", "maxLength"],
  Select: ["@options", "multiple", "searchable", "preload", "native", "createOptionForm"],
  Radio: ["@options", "inline", "boolean"],
  CheckboxList: ["@options", "columns", "searchable", "bulkToggleable", "gridDirection"],
  ToggleButtons: ["@options", "inline", "grouped", "multiple", "boolean"],
  Toggle: ["inline", "onColor", "offColor", "onIcon", "offIcon", "accepted"],
  Checkbox: ["inline", "accepted"],
  DatePicker: ["native", "format", "displayFormat", "minDate", "maxDate", "closeOnDateSelection", "timezone"],
  DateTimePicker: ["native", "seconds", "format", "displayFormat", "minDate", "maxDate", "timezone"],
  TimePicker: ["native", "seconds", "format", "displayFormat"],
  FileUpload: ["image", "avatar", "multiple", "directory", "disk", "visibility", "acceptedFileTypes", "maxSize", "maxFiles", "imageEditor", "reorderable", "openable", "downloadable", "preserveFilenames"],
  SpatieMediaLibraryFileUpload: ["collection", "image", "multiple", "reorderable", "maxSize", "maxFiles"],
  Repeater: ["relationship", "columns", "reorderable", "collapsible", "cloneable", "minItems", "maxItems", "defaultItems", "addActionLabel", "simple", "table", "grid"],
  Builder: ["blockNumbers", "collapsible", "cloneable", "reorderable", "minItems", "maxItems", "addActionLabel"],
  KeyValue: ["keyLabel", "valueLabel", "keyPlaceholder", "valuePlaceholder", "addActionLabel", "reorderable"],
  TagsInput: ["suggestions", "separator", "splitKeys", "reorderable"],
  ColorPicker: ["rgb", "rgba", "hsl"],
  Hidden: ["default"],
  Section: ["heading", "collapsible", "collapsed", "aside", "compact", "contained", "secondary"],
  Fieldset: ["label"],
  Tabs: ["contained", "vertical", "persistTabInQueryString", "activeTab"],
  Tab: ["badge", "badgeColor"],
  Wizard: ["skippable", "startOnStep", "persistStepInQueryString"],
  Step: ["description", "completedIcon"],
  Grid: ["columns"],
  Text: ["color", "size", "weight", "badge"],
  TextColumn: ["copyable", "weight", "size", "listWithLineBreaks", "bulleted", "html", "markdown"],
  IconColumn: ["boolean", "trueIcon", "falseIcon", "trueColor", "falseColor", "size"],
  ImageColumn: ["circular", "square", "imageHeight", "imageWidth", "stacked", "limit", "disk", "visibility", "defaultImageUrl"],
  ToggleColumn: ["onColor", "offColor", "onIcon", "offIcon", "disabled"],
  SelectColumn: ["@options", "selectablePlaceholder", "disabled"],
  TextInputColumn: ["type", "rules", "disabled"],
  CheckboxColumn: ["disabled"],
  SelectFilter: ["relationship", "attribute"],
  TernaryFilter: ["placeholder", "trueLabel", "falseLabel", "nullable", "attribute"],
  TrashedFilter: [],
  Filter: ["form", "query"],
  ActionGroup: [],
};

/** The inspector's first settings for a class, in order: its kind's, then its own and its parents'. */
export function essentials(cls: CClass): string[] {
  const own = [shortClass(cls.class), ...cls.parents.map(shortClass)].flatMap((n) => BY_CLASS[n] ?? []);
  // Import and export actions do what their importer or exporter says, so that's what they're set up with.
  const porter = [shortClass(cls.class), ...cls.parents.map(shortClass)].some((n) => /^(ImportAction|ExportAction|ExportBulkAction)$/.test(n));
  const list = [...(ESSENTIALS[cls.kind] ?? []).map((n) => (n === "@behavior" && porter ? "@porter" : n)), ...own];
  // Text columns and entries format with the designer's editor, which covers these calls.
  return [...new Set(list)];
}

/** Methods the inspector never lists: they take the app's own objects, or exist for Filament's internals. */
export const HIDDEN_METHODS = new Set([
  "container",
  "model",
  "record",
  "livewire",
  "parentRepeaterItemIndex",
  "getStateUsing",
  "table",
  "configure",
  "key",
  "statePath",
  "view",
  "viewData",
  "extraAttributes",
  "extraInputAttributes",
  "extraAlpineAttributes",
  "extraFieldWrapperAttributes",
  "extraEntryWrapperAttributes",
  "extraCellAttributes",
  "extraHeaderAttributes",
  "extraImgAttributes",
  "evaluateUsing",
  "component",
  "components",
  "schema",
  "childComponents",
  "tabs",
  "steps",
  "blocks",
  "actions",
  "name",
  "defaultView",
  "setUp",
  "getRecordUsing",
]);

// ---- Colors and icons ----

/** Filament's color names, as `color()` takes them. */
export const COLORS = ["primary", "gray", "success", "warning", "danger", "info"];

/** A Heroicon's file name from its enum case: `OutlinedRectangleStack` → `o-rectangle-stack`. */
export function heroiconFile(caseName: string): string {
  const outlined = caseName.startsWith("Outlined");
  const mini = caseName.startsWith("Mini");
  const micro = caseName.startsWith("Micro");
  const base = caseName.replace(/^(Outlined|Mini|Micro)/, "");
  const kebab = base.replace(/([a-z\d])([A-Z])/g, "$1-$2").replace(/([A-Z])([A-Z][a-z])/g, "$1-$2").toLowerCase();
  return `${outlined ? "o" : mini ? "m" : micro ? "c" : "s"}-${kebab}`;
}

/** A Heroicon's enum case from its string name: `heroicon-o-rectangle-stack` → `OutlinedRectangleStack`. */
export function heroiconCase(name: string): string | null {
  const m = /^(?:heroicon-)?([osmc])-(.+)$/.exec(name);
  if (!m) return null;
  const prefix = { o: "Outlined", s: "", m: "Mini", c: "Micro" }[m[1] as "o" | "s" | "m" | "c"];
  return prefix + m[2].replace(/(^|-)([a-z\d])/g, (_, __, ch: string) => ch.toUpperCase());
}
