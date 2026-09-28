// The resource designer's other tabs: relation managers, pages, and the resource's own settings (navigation,
// labels, search), plus the inspector's view of the form or table itself when nothing is selected. Settings are the
// resource class's static properties and small methods, read from its code and written back to it.
import { h, icon, iconButton } from "./dom";
import * as fapp from "./filamentapp";
import { humanize, majorVersion } from "./filamentcatalog";
import { gridColumns } from "./filamentcanvas";
import type { Designer, Doc } from "./filamentdesigner";
import { titleAttribute } from "./filamentgen";
import { askName, commitInput, heroicon, pickHeroicon, popover, segmented, toggleSwitch } from "./filamentpickers";
import { type Root, type RootKind, shortClass, walk } from "./filamentschema";
import { addMember, type Edit, findCall, insertItem, methodNamed, nodeValue, type OClass, phpString, phpValue, propertyNamed, removeItem, removeMethod, removeProperty, setProperty, textValue } from "./phpcode";
import { confirm } from "./palette";
import { showError } from "./status";

const HEROICON = "Filament\\Support\\Icons\\Heroicon";

/** Runs an Artisan generator with progress in the footer, then reads the app again. Returns the files it made. */
async function generate(d: Designer, args: string[], what: string): Promise<string[] | null> {
  d.message = `${what}…`;
  d.render();
  try {
    const out = await fapp.artisan(d.root, args);
    fapp.forget(["app", "models", "model:"]);
    return await fapp.createdFiles(d.root, out);
  } catch (e) {
    showError(`Can't ${what.toLowerCase()}`, e);
    d.message = "";
    d.render();
    return null;
  }
}

/** A card in a list, with an icon, a title, details, and actions. */
function card(iconEl: HTMLElement, title: string, details: (string | HTMLElement | null)[], actions: HTMLElement[], onclick?: () => void) {
  const el = h("div", { class: `fd-card${onclick ? " clickable" : ""}` }, h("span", { class: "fd-card-icon" }, iconEl), h("div", { class: "fd-card-body" }, h("strong", {}, title), h("div", { class: "fd-card-details" }, ...details.filter(Boolean).map((x) => (typeof x === "string" ? h("span", {}, x) : x!)))), h("div", { class: "fd-card-actions" }, ...actions));
  if (onclick) el.onclick = (e) => !(e.target as HTMLElement).closest("button") && onclick();
  return el;
}

const abs = (d: Designer, file: string | null) => (file ? (file.startsWith("/") ? file : `${d.root}/${file}`) : null);

// ---- Relations ----

/** The classes `getRelations()` returns, in the code's order, with the array to edit. */
function relationsInCode(cls: OClass) {
  const method = methodNamed(cls, "getRelations");
  const arr = method?.returns[0];
  return { method, array: arr?.kind === "array" ? arr : null, classes: arr?.kind === "array" ? arr.items.map((i) => (i.value.kind === "classConst" && i.value.name === "class" ? i.value.class : null)) : [] };
}

export function renderRelationsTab(d: Designer): HTMLElement {
  const doc = d.docs.get(d.file)!;
  const cls = d.cls!;
  const inCode = relationsInCode(cls);
  const infos = d.info?.relations ?? [];
  const list = h("div", { class: "fd-cards" });
  inCode.classes.forEach((fqn, i) => {
    const info = infos.find((r) => r.class === fqn);
    const file = abs(d, info?.file ?? null);
    const title = info?.relationship ? humanize(info.relationship) : fqn ? shortClass(fqn).replace(/RelationManager$/, "") : "Code";
    const related = d.facts?.relations.find((r) => r.name === info?.relationship);
    list.append(
      card(
        icon("references"),
        title,
        [fqn ? shortClass(fqn) : "Written as code", related ? `${related.type} → ${shortClass(related.related ?? "")}` : null, info?.title ? `Shows ${info.title}` : null, info?.group ? `In group ${info.group}` : null],
        [
          iconButton("arrow-up", "Move up", () => void moveRelation(d, doc, i, -1)),
          iconButton("arrow-down", "Move down", () => void moveRelation(d, doc, i, 1)),
          ...(file ? [iconButton("go-to-file", "Open the code", () => d.host.openAt(file, 1))] : []),
          iconButton("trash", "Remove from the resource", () => void removeRelation(d, doc, i, file)),
        ],
        file ? () => void import("./filamentdesigner").then((m) => m.openDesigner(file)) : undefined,
      ),
    );
  });
  if (!inCode.classes.length) list.append(h("p", { class: "fd-note fd-center" }, "No relation managers yet. They list a record's related records under its edit or view page, such as a post's comments."));
  const manyRelations = (d.facts?.relations ?? []).filter((r) => /HasMany|BelongsToMany|MorphMany|MorphToMany|HasManyThrough/.test(r.type));
  const unused = manyRelations.filter((r) => !infos.some((i) => i.relationship === r.name));
  const add = h("button", { type: "button", class: "primary", disabled: !manyRelations.length && !!d.facts }, icon("add"), "Add relation manager");
  add.onclick = () => addRelationManager(d, add);
  return h(
    "div",
    { class: "fd-page-tab" },
    h("div", { class: "fd-page-tab-head" }, h("div", {}, h("h2", {}, "Relation managers"), h("p", { class: "fd-note" }, "Tables of related records on the record's pages. Click one to design its form and table.")), add),
    list,
    unused.length ? h("div", { class: "fd-suggest" }, icon("lightbulb"), `The model has ${unused.length === 1 ? "a relationship" : "relationships"} without a manager: `, ...unused.map((r) => h("button", { type: "button", class: "fd-chip-link", onclick: (e: MouseEvent) => addRelationManager(d, e.currentTarget as HTMLElement, r.name) }, r.name))) : null,
  );
}

async function moveRelation(d: Designer, doc: Doc, i: number, by: number) {
  const { array } = relationsInCode(d.cls!);
  if (!array || i + by < 0 || i + by >= array.items.length) return;
  const { moveItem } = await import("./phpcode");
  await d.apply(doc, () => moveItem(doc.text, array, i, by > 0 ? i + 2 : i - 1), "Moved");
}

async function removeRelation(d: Designer, doc: Doc, i: number, file: string | null) {
  const { array } = relationsInCode(d.cls!);
  if (!array) return;
  const choice = file ? await (await import("./palette")).choose("Remove the relation manager from the resource?", ["Remove it", "Remove it and move its file to the Trash", "Cancel"]) : "Remove it";
  if (!choice || choice === "Cancel") return;
  await d.apply(doc, () => [removeItem(doc.text, array, i)], "Removed the relation manager");
  if (choice.includes("Trash") && file) await (await import("@tauri-apps/api/core")).invoke("trash_path", { path: file }).catch((e) => showError("Can't move the file to the Trash", e));
  fapp.forget(["app"]);
  await d.load();
}

/** Adds `class` to `getRelations()`, adding the method when the resource has none. */
async function registerRelation(d: Designer, fqn: string) {
  await d.refresh();
  const doc = d.docs.get(d.file)!;
  const cls = d.cls!;
  const { method, array } = relationsInCode(cls);
  await d.apply(
    doc,
    (imports) => {
      const name = `${imports.name(fqn)}::class`;
      if (array) return [insertItem(doc.text, array, array.items.length, name)];
      if (method) throw new Error("getRelations() doesn't return an array the designer can add to.");
      return [addMember(doc.text, cls, `public static function getRelations(): array\n{\n    return [\n        ${name},\n    ];\n}`)];
    },
    `Added ${shortClass(fqn)}`,
  );
}

function addRelationManager(d: Designer, anchor: HTMLElement, preset?: string) {
  const relations = (d.facts?.relations ?? []).filter((r) => /HasMany|BelongsToMany|MorphMany|MorphToMany|HasManyThrough/.test(r.type));
  const relSelect = h("select", {}, ...relations.map((r) => h("option", { value: r.name, textContent: `${r.name} · ${r.type} → ${shortClass(r.related ?? "")}`, selected: r.name === preset })));
  const titleSelect = h("select", {});
  const attach = h("input", { type: "checkbox" });
  const attachLabel = h("span", {});
  const softDeletes = h("input", { type: "checkbox" });
  const view = h("input", { type: "checkbox" });
  const generateBox = h("input", { type: "checkbox", checked: true });
  const update = async () => {
    const r = relations.find((x) => x.name === relSelect.value);
    const many = r && /BelongsToMany|MorphToMany/.test(r.type);
    attachLabel.textContent = many ? "Attach and detach existing records" : "Associate and dissociate existing records";
    const all = await fapp.models(d.root).catch(() => ({}) as Record<string, fapp.ModelSummary>);
    const cols = r?.related ? Object.keys(all[r.related]?.columns ?? {}) : [];
    const title = titleAttribute(cols, r?.related && all[r.related] ? fapp.typesOf(all[r.related]) : {});
    titleSelect.replaceChildren(...(cols.length ? cols : ["name"]).map((c) => h("option", { value: c, textContent: c, selected: c === title })));
    // Many-to-many relationships usually attach records that exist; has-many usually creates them.
    attach.checked = !!many;
    softDeletes.checked = !!r?.related && !!all[r.related] && "deleted_at" in (all[r.related].columns ?? {});
  };
  relSelect.onchange = () => void update();
  void update();
  const create = h("button", { type: "button", class: "primary" }, "Create");
  const p = popover(
    anchor,
    h(
      "div",
      { class: "fd-form-pop" },
      h("h3", {}, "New relation manager"),
      relations.length ? h("label", { class: "fd-field-label" }, "Relationship", relSelect) : h("p", { class: "fd-note" }, "The model has no has-many or many-to-many relationships. Add one in the model first."),
      h("label", { class: "fd-field-label" }, "Records are labeled by", titleSelect),
      h("label", { class: "fd-check-label" }, attach, attachLabel),
      h("label", { class: "fd-check-label" }, softDeletes, "The related model uses soft deletes"),
      h("label", { class: "fd-check-label" }, view, "A View action"),
      h("label", { class: "fd-check-label" }, generateBox, "Fill the form and table from the related table's columns"),
      h("div", { class: "fd-ask-buttons" }, h("button", { type: "button", textContent: "Cancel", onclick: () => p.close() }), create),
    ),
  );
  create.onclick = async () => {
    const r = relations.find((x) => x.name === relSelect.value);
    if (!r) return;
    p.close();
    const many = /BelongsToMany|MorphToMany/.test(r.type);
    const args = [
      "make:filament-relation-manager",
      d.info?.class ?? d.cls!.fqn,
      r.name,
      titleSelect.value,
      ...(d.panel ? [`--panel=${d.panel.id}`] : []),
      ...(d.info?.cluster ? [`--cluster=${d.info.cluster}`] : []),
      ...(attach.checked ? [many ? "--attach" : "--associate"] : []),
      ...(softDeletes.checked ? ["--soft-deletes"] : []),
      ...(view.checked ? ["--view"] : []),
      ...(generateBox.checked ? ["--generate"] : []),
    ];
    const files = await generate(d, args, `Creating the ${r.name} relation manager`);
    if (!files) return;
    const manager = files.find((f) => /RelationManager\.php$/.test(f));
    if (!manager) return showError("Filament didn't say where it put the relation manager.");
    const outline = await fapp.outlineOf(await (await d.host.ensureModel(manager)).getValue(), manager);
    const fqn = outline.classes[0]?.fqn;
    if (fqn) await registerRelation(d, fqn);
    // The app was read again while the files changed, before the resource registered the manager.
    fapp.forget(["app", "models", "model:"]);
    await d.load();
    d.message = `Created ${shortClass(fqn ?? "the relation manager")}`;
    d.render();
  };
}

// ---- Pages ----

export function renderPagesTab(d: Designer): HTMLElement {
  const cls = d.cls!;
  const method = methodNamed(cls, "getPages");
  const arr = method?.returns[0];
  const infos = d.info?.pages ?? [];
  const doc = d.docs.get(d.file)!;
  const kinds: Record<string, [string, string]> = { list: ["list-flat", "Lists records"], create: ["add", "Creates a record"], edit: ["edit", "Edits a record"], view: ["eye", "Shows a record"], manage: ["table", "Lists, creates, and edits records in modals"], related: ["references", "Manages related records"], custom: ["file", "A page of its own"] };
  const list = h("div", { class: "fd-cards" });
  if (arr?.kind === "array")
    for (const item of arr.items) {
      const key = textValue(item.key)?.text ?? "";
      const value = item.value;
      const pageClass = value.kind === "static" ? value.class : value.kind === "chain" && value.base.kind === "static" ? value.base.class : null;
      const route = value.kind === "static" ? textValue(value.args.items[0]?.value)?.text : undefined;
      const info = infos.find((p) => p.class === pageClass);
      const [iconName, what] = kinds[info?.kind ?? "custom"];
      const file = abs(d, info?.file ?? null);
      list.append(
        card(
          icon(iconName),
          humanize(key || "page"),
          [pageClass ? shortClass(pageClass) : "Code", route !== undefined ? h("code", {}, `${d.panel ? `/${d.panel.path}` : ""}/${d.info?.slug ?? ""}${route === "/" ? "" : route}`) : null, what],
          [...(file ? [iconButton("go-to-file", "Open the code", () => d.host.openAt(file, 1))] : []), ...(key !== "index" ? [iconButton("trash", "Remove the page from the resource", () => void (async () => (await confirm(`Remove the ${key} page from the resource? Its file stays.`, "Remove")) && d.apply(doc, () => [removeItem(doc.text, arr, arr.items.indexOf(item))], "Removed the page"))())] : [])],
        ),
      );
    }
  else list.append(h("p", { class: "fd-note" }, "getPages() is written as code the designer doesn't read."));
  const has = (kind: string) => infos.some((p) => p.kind === kind);
  const addButtons = [
    !has("view") && !has("manage") ? h("button", { type: "button", onclick: () => void addPage(d, "view") }, icon("eye"), "Add a View page") : null,
    !has("create") && !has("manage") ? h("button", { type: "button", onclick: () => void addPage(d, "create") }, icon("add"), "Add a Create page") : null,
    !has("edit") && !has("manage") ? h("button", { type: "button", onclick: () => void addPage(d, "edit") }, icon("edit"), "Add an Edit page") : null,
    h("button", { type: "button", onclick: (e: MouseEvent) => void addPage(d, "custom", e.currentTarget as HTMLElement) }, icon("file-add"), "Add a custom page"),
  ];
  return h(
    "div",
    { class: "fd-page-tab" },
    h("div", { class: "fd-page-tab-head" }, h("div", {}, h("h2", {}, "Pages"), h("p", { class: "fd-note" }, "The resource's pages and their addresses in the panel.")), h("div", { class: "fd-button-row" }, ...addButtons)),
    list,
  );
}

async function addPage(d: Designer, type: "view" | "create" | "edit" | "custom", anchor?: HTMLElement) {
  const model = shortClass(d.info?.model ?? d.facts?.class ?? "Record");
  let name = { view: `View${model}`, create: `Create${model}`, edit: `Edit${model}`, custom: "" }[type];
  if (type === "custom") {
    const asked = anchor && (await askName(anchor, { title: "Page class name", placeholder: `${model}Statistics`, validate: (v) => (/^[A-Z]\w*$/.test(v) ? null : "Use a class name, such as PostStatistics."), action: "Create" }));
    if (!asked) return;
    name = asked;
  }
  const files = await generate(d, ["make:filament-page", name, `--resource=${d.info?.class ?? d.cls!.fqn}`, `--type=${type}`, ...(d.panel ? [`--panel=${d.panel.id}`] : [])], `Creating the ${name} page`);
  if (!files) return;
  const page = files.find((f) => f.endsWith(`/${name}.php`)) ?? files[0];
  if (!page) return;
  const outline = await fapp.outlineOf(await (await d.host.ensureModel(page)).getValue(), page);
  const fqn = outline.classes[0]?.fqn;
  await d.refresh();
  const doc = d.docs.get(d.file)!;
  const method = methodNamed(d.cls!, "getPages");
  const arr = method?.returns[0];
  if (fqn && arr?.kind === "array") {
    const key = type === "custom" ? name.replace(/^[A-Z]/, (c) => c.toLowerCase()) : type;
    const route = { view: "/{record}", create: "/create", edit: "/{record}/edit", custom: `/${name.replace(/([a-z\d])([A-Z])/g, "$1-$2").toLowerCase()}` }[type];
    // Filament matches routes in order, so `/create` goes before `/{record}`.
    const index = type === "create" ? Math.min(1, arr.items.length) : arr.items.length;
    await d.apply(doc, (imports) => [insertItem(doc.text, arr, index, `${phpString(key)} => ${imports.name(fqn)}::route(${phpString(route)})`)], `Added the ${humanize(type)} page`);
  }
  fapp.forget(["app"]);
  await d.load();
}

// ---- Settings ----

type Setting = { name: string; label: string; help?: string; kind: "text" | "number" | "icon" | "switch" | "group" | "column" | "cluster"; placeholder?: string };

/** The methods that override a setting's property; when the class has one, the property does nothing. */
const GETTERS: Record<string, string[]> = {
  navigationLabel: ["getNavigationLabel"],
  navigationIcon: ["getNavigationIcon"],
  activeNavigationIcon: ["getActiveNavigationIcon"],
  navigationGroup: ["getNavigationGroup"],
  navigationSort: ["getNavigationSort"],
  navigationParentItem: ["getNavigationParentItem"],
  shouldRegisterNavigation: ["shouldRegisterNavigation"],
  modelLabel: ["getModelLabel", "getLabel"],
  pluralModelLabel: ["getPluralModelLabel", "getPluralLabel"],
  recordTitleAttribute: ["getRecordTitleAttribute"],
  slug: ["getSlug"],
  cluster: ["getCluster"],
};

const NAVIGATION: Setting[] = [
  { name: "navigationLabel", label: "Label", kind: "text" },
  { name: "navigationIcon", label: "Icon", kind: "icon" },
  { name: "activeNavigationIcon", label: "Icon when active", kind: "icon" },
  { name: "navigationGroup", label: "Group", kind: "group", help: "Resources in the same group sit together in the sidebar." },
  { name: "navigationSort", label: "Order", kind: "number", help: "Lower numbers come first." },
  { name: "navigationParentItem", label: "Under item", kind: "text", help: "Nests it under another item of its group, by that item's label." },
  { name: "shouldRegisterNavigation", label: "Show in the sidebar", kind: "switch" },
];
const LABELS: Setting[] = [
  { name: "modelLabel", label: "Record name", kind: "text", help: "As in \"New post\"." },
  { name: "pluralModelLabel", label: "Plural", kind: "text" },
  { name: "recordTitleAttribute", label: "Records are titled by", kind: "column", help: "The attribute that names a record in breadcrumbs and global search." },
  { name: "slug", label: "URL", kind: "text", help: "The resource's address in the panel." },
  { name: "cluster", label: "Cluster", kind: "cluster" },
];

/** The declaration for a new static property: the type Filament gives it, with classes imported. */
function declaration(d: Designer, name: string, imports: { name(f: string): string }): string {
  const type = d.cat?.resourceProperties[name]?.type ?? "?string";
  const written = type
    .split("|")
    .map((t) => t.replace(/^\?/, ""))
    .map((t) => (/^[A-Z]/.test(t) && !/^(null)$/.test(t) ? imports.name(t) : t));
  const nullable = type.startsWith("?") ? "?" : "";
  return `protected static ${nullable}${written.join("|")} $${name}`;
}

export function renderSettingsTab(d: Designer): HTMLElement {
  const doc = d.docs.get(d.file)!;
  const cls = d.cls!;
  const info = d.info;
  const columns = (d.facts?.columns ?? []).map((c) => c.name);
  const groups = [...new Set((d.app?.panels ?? []).flatMap((p) => p.resources).map((r) => r.navigationGroup).filter((g): g is string => !!g))];
  const setProp = (name: string, code: string | null, message: string) =>
    d.apply(
      doc,
      (imports, fill) => {
        const prop = propertyNamed(cls, name);
        if (code === null) return prop ? [removeProperty(doc.text, prop)] : [];
        return [setProperty(doc.text, cls, name, fill(code), declaration(d, name, imports))];
      },
      message,
    );
  const current = (name: string) => propertyNamed(cls, name)?.value ?? null;
  const fallback: Record<string, string | null | undefined> = {
    navigationLabel: info?.navigationLabel,
    modelLabel: info?.label,
    pluralModelLabel: info?.pluralLabel,
    slug: info?.slug,
    navigationGroup: info?.navigationGroup,
  };
  const row = (s: Setting) => {
    const getter = (GETTERS[s.name] ?? []).map((g) => methodNamed(cls, g)).find(Boolean);
    if (getter)
      return h(
        "div",
        { class: "fd-row set", title: `${getter.name}() decides this, so a property would be ignored.` },
        h("span", { class: "fd-row-label" }, s.label),
        h("div", { class: "fd-row-editor" }, h("button", { type: "button", class: "fd-code-chip", onclick: () => d.reveal(getter, doc) }, icon("code"), h("span", {}, `Set in ${getter.name}()`))),
        h("span", { class: "fd-row-spacer" }),
      );
    const node = current(s.name);
    const set = !!propertyNamed(cls, s.name);
    const reset = () => void setProp(s.name, null, `Reset ${s.label.toLowerCase()}`);
    let editor: HTMLElement;
    switch (s.kind) {
      case "icon": {
        const name = node?.kind === "classConst" ? node.name : (textValue(node)?.text ?? (s.name === "navigationIcon" ? info?.navigationIcon : null));
        const btn = h("button", { type: "button", class: "fd-icon-button" }, heroicon(d.cat?.heroiconsDir ?? null, name), h("span", {}, name ? name.replace(/^(heroicon-)?o-/, "").replace(/^Outlined/, "") : "None"), icon("chevron-down"));
        btn.onclick = async () => {
          const picked = await pickHeroicon(btn, { dir: d.cat?.heroiconsDir ?? null, cases: d.cat?.heroicons ?? [], current: name });
          if (picked === null) return;
          const code = !picked ? "null" : majorVersion(d.cat ?? { version: null }) >= 4 && d.cat?.heroicons.length ? `{{${HEROICON}}}::${picked}` : phpString(`heroicon-${(await import("./filamentcatalog")).heroiconFile(picked)}`);
          void setProp(s.name, code, `Changed the ${s.label.toLowerCase()}`);
        };
        editor = btn;
        break;
      }
      case "number": {
        const v = nodeValue(node);
        editor = commitInput(typeof v === "number" ? String(v) : "", (x) => void setProp(s.name, x.trim() === "" ? null : String(Number(x) || 0), `Changed the ${s.label.toLowerCase()}`), { type: "number", className: "fd-number" });
        break;
      }
      case "switch": {
        const v = nodeValue(node);
        editor = toggleSwitch(v !== false, (on) => void setProp(s.name, on ? null : "false", on ? "Shown in the sidebar" : "Hidden from the sidebar"));
        break;
      }
      case "column": {
        const v = textValue(node)?.text ?? "";
        const select = h("select", {}, h("option", { value: "", textContent: "None" }), ...columns.map((c) => h("option", { value: c, textContent: c, selected: c === v })));
        select.onchange = () => void setProp(s.name, select.value ? phpString(select.value) : null, `Records titled by ${select.value || "nothing"}`);
        editor = select;
        break;
      }
      case "cluster": {
        const clusters = d.panel?.clusters ?? [];
        const v = node?.kind === "classConst" ? node.class : "";
        const select = h("select", {}, h("option", { value: "", textContent: "None" }), ...clusters.map((c) => h("option", { value: c.class, textContent: c.label ?? shortClass(c.class), selected: c.class === v })));
        select.disabled = !clusters.length;
        select.onchange = () => void setProp(s.name, select.value ? `{{${select.value}}}::class` : null, "Changed the cluster");
        editor = select;
        break;
      }
      case "group": {
        const listId = "fd-nav-groups";
        editor = h("div", { class: "fd-inline-editor" }, commitInput(textValue(node)?.text ?? "", (x) => void setProp(s.name, x ? phpString(x) : null, "Changed the group"), { list: listId, placeholder: fallback[s.name] ?? "None" }), h("datalist", { id: listId }, ...groups.map((g) => h("option", { value: g }))));
        break;
      }
      default:
        editor = commitInput(textValue(node)?.text ?? "", (x) => void setProp(s.name, x ? phpString(x) : null, `Changed the ${s.label.toLowerCase()}`), { placeholder: fallback[s.name] ?? "" });
    }
    const readable = !node || (s.kind === "icon" ? node.kind === "classConst" || !!textValue(node) : s.kind === "number" ? node.kind === "number" : s.kind === "switch" ? node.kind === "bool" : s.kind === "cluster" ? node.kind === "classConst" || node.kind === "null" : !!textValue(node) || node.kind === "null");
    if (!readable) editor = h("button", { type: "button", class: "fd-code-chip", onclick: () => d.reveal(node, doc) }, icon("code"), "Set in code");
    return h("div", { class: `fd-row${set ? " set" : ""}`, title: s.help ?? "" }, h("span", { class: "fd-row-label" }, s.label), h("div", { class: "fd-row-editor" }, editor), set ? iconButton("discard", "Use Filament's default", reset) : h("span", { class: "fd-row-spacer" }));
  };

  // A count badge on the navigation item, and the attributes global search looks in.
  const badge = methodNamed(cls, "getNavigationBadge");
  // Only the badge the designer writes can be switched off here; one of your own is code.
  const ownBadge = !!badge && !/^\(string\)\s*static::getModel\(\)::count\(\)$/.test(badge.returns[0] ? doc.text.slice(badge.returns[0].span[0], badge.returns[0].span[1]).trim() : "");
  const badgeRow = ownBadge
    ? h("div", { class: "fd-row set" }, h("span", { class: "fd-row-label" }, "Badge"), h("div", { class: "fd-row-editor" }, h("button", { type: "button", class: "fd-code-chip", onclick: () => d.reveal(badge!, doc) }, icon("code"), h("span", {}, "Set in getNavigationBadge()"))), h("span", { class: "fd-row-spacer" }))
    : h(
    "div",
    { class: `fd-row${badge ? " set" : ""}` },
    h("span", { class: "fd-row-label" }, "Record count badge"),
    h(
      "div",
      { class: "fd-row-editor" },
      toggleSwitch(!!badge, (on) =>
        void d.apply(doc, () => (on ? [addMember(doc.text, cls, "public static function getNavigationBadge(): ?string\n{\n    return (string) static::getModel()::count();\n}")] : badge ? [removeMethod(doc.text, badge)] : []), on ? "Added a count badge" : "Removed the badge"),
      ),
    ),
    h("span", { class: "fd-row-spacer" }),
  );
  const searchMethod = methodNamed(cls, "getGloballySearchableAttributes");
  const searchValue = nodeValue(searchMethod?.returns[0]);
  const searchable = Array.isArray(searchValue) ? searchValue.map(String) : [];
  const searchRow = h(
    "div",
    { class: `fd-row stacked${searchMethod ? " set" : ""}` },
    h("span", { class: "fd-row-label" }, "Global search looks in"),
    h(
      "div",
      { class: "fd-row-editor fd-checks wrap" },
      ...(searchMethod && !Array.isArray(searchValue)
        ? [h("button", { type: "button", class: "fd-code-chip", onclick: () => d.reveal(searchMethod.returns[0] ?? searchMethod, doc) }, icon("code"), "Set in code")]
        : columns
            .filter((c) => !/^(id|password|remember_token)$/.test(c) && !/_at$/.test(c))
            .map((c) => {
              const box = h("input", { type: "checkbox", checked: searchable.includes(c) });
              box.onchange = () => {
                const next = columns.filter((x) => (x === c ? box.checked : searchable.includes(x)));
                void d.apply(
                  doc,
                  () => {
                    const edits: Edit[] = [];
                    if (searchMethod) edits.push(removeMethod(doc.text, searchMethod));
                    if (next.length) edits.push(addMember(doc.text, cls, `public static function getGloballySearchableAttributes(): array\n{\n    return ${phpValue(next)};\n}`));
                    return edits;
                  },
                  "Changed global search",
                );
              };
              return h("label", {}, box, c);
            })),
    ),
    searchMethod ? iconButton("discard", "Turn global search off", () => void d.apply(doc, () => [removeMethod(doc.text, searchMethod)], "Turned global search off")) : h("span", { class: "fd-row-spacer" }),
  );

  const section = (title: string, iconName: string, rows: HTMLElement[], note?: string) => h("section", { class: "fd-settings-section" }, h("h3", {}, icon(iconName), title), note ? h("p", { class: "fd-note" }, note) : null, h("div", { class: "fd-rows" }, ...rows));
  const model = d.facts?.class ?? info?.model;
  return h(
    "div",
    { class: "fd-page-tab fd-settings" },
    h("div", { class: "fd-page-tab-head" }, h("div", {}, h("h2", {}, "Resource settings"), h("p", { class: "fd-note" }, "How the resource appears in the panel. Empty fields use Filament's defaults, shown in gray."))),
    section("Navigation", "list-tree", [...NAVIGATION.map(row), badgeRow]),
    section("Names and address", "symbol-key", LABELS.filter((s) => s.kind !== "cluster" || d.panel?.clusters.length).map(row)),
    section("Global search", "search", [searchRow], "Global search finds records from the panel's search bar. It needs \"Records are titled by\" set."),
    model ? section("Model", "database", [h("div", { class: "fd-row" }, h("span", { class: "fd-row-label" }, "Model"), h("div", { class: "fd-row-editor" }, h("button", { type: "button", class: "fd-chip-link", onclick: () => d.host.openAt(abs(d, d.facts?.details.file ?? info?.modelFile ?? null) ?? d.file, 1) }, icon("database"), model)), h("span", { class: "fd-row-spacer" }))]) : null,
  );
}

// ---- The form's or table's own settings, when nothing is selected ----

const SORT_DIRECTIONS: ["asc" | "desc", string][] = [
  ["asc", "Ascending"],
  ["desc", "Descending"],
];

export function renderRootSettings(d: Designer, ref: { kind: RootKind; doc: Doc; root: Root }): HTMLElement {
  const root = ref.root;
  const rootCall = (name: string) => findCall(root.node, name);
  const set = (name: string, args: string | null, message = "Changed") => void d.setRootCalls([{ name, args }], message);
  const rows: HTMLElement[] = [];
  const line = (label: string, editor: HTMLElement, isSet: boolean, reset?: () => void, help?: string) =>
    h("div", { class: `fd-row${isSet ? " set" : ""}`, title: help ?? "" }, h("span", { class: "fd-row-label" }, label), h("div", { class: "fd-row-editor" }, editor), isSet && reset ? iconButton("discard", "Remove this setting", reset) : h("span", { class: "fd-row-spacer" }));
  let count = 0;
  walk(root, () => count++);
  // A setting written as code, such as a closure, shows as code, so an edit never replaces it with less.
  const asCode = (name: string, label: string, help?: string) => {
    const c = rootCall(name);
    const node = c?.args.items[0]?.value;
    return node ? line(label, h("button", { type: "button", class: "fd-code-chip", onclick: () => d.reveal(node, ref.doc) }, icon("code"), h("span", {}, ref.doc.text.slice(node.span[0], node.span[1]).replace(/\s+/g, " ").slice(0, 40))), true, () => set(name, null), help) : null;
  };
  const unreadable = (name: string, ok: (n: import("./phpcode").PNode) => boolean) => {
    const c = rootCall(name);
    return !!c && (c.args.items.length > (name === "defaultSort" ? 2 : 1) || c.args.items.some((a) => !ok(a.value)));
  };
  if (ref.kind !== "table") {
    const v = nodeValue(rootCall("columns")?.args.items[0]?.value);
    const n = gridColumns(v, 2);
    if (rootCall("columns") && v === undefined) rows.push(asCode("columns", "Columns")!);
    const byBreakpoint = !!v && typeof v === "object" && !Array.isArray(v);
    const note = byBreakpoint ? `Set by screen size: ${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k} ${x}`).join(", ")}. Choosing a number replaces that.` : "How many columns the form's fields sit in.";
    if (!(rootCall("columns") && v === undefined)) rows.push(line("Columns", segmented<string>([["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]], String(n), (x) => set("columns", x, `${x} columns`)), !!rootCall("columns"), () => set("columns", null), note));
    if (byBreakpoint) rows.push(h("p", { class: "fd-note fd-row-note" }, note));
  } else {
    const columns: string[] = [];
    walk(root, (c) => c.name && classFor(c.cls) === "column" && columns.push(c.name));
    if (unreadable("defaultSort", (n) => !!textValue(n))) rows.push(asCode("defaultSort", "Default sort")!);
    const sort = unreadable("defaultSort", (n) => !!textValue(n)) ? undefined : rootCall("defaultSort");
    const sortColumn = textValue(sort?.args.items[0]?.value)?.text ?? "";
    const sortDir = (textValue(sort?.args.items[1]?.value)?.text ?? "asc") as "asc" | "desc";
    const colSelect = h("select", {}, h("option", { value: "", textContent: "None" }), ...[...new Set([...columns, ...(d.facts?.columns ?? []).map((c) => c.name)])].map((c) => h("option", { value: c, textContent: c, selected: c === sortColumn })));
    const writeSort = (col: string, dir: string) => set("defaultSort", col ? `${phpString(col)}${dir === "desc" ? ", 'desc'" : ""}` : null, "Changed the default sort");
    colSelect.onchange = () => writeSort(colSelect.value, sortDir);
    if (!unreadable("defaultSort", (n) => !!textValue(n))) rows.push(line("Default sort", h("div", { class: "fd-stack-editor" }, colSelect, sortColumn ? segmented(SORT_DIRECTIONS, sortDir, (dir) => writeSort(sortColumn, dir)) : null), !!sort, () => set("defaultSort", null)));
    const flagRow = (name: string, label: string, help?: string) => {
      if (unreadable(name, (n) => n.kind === "bool")) return asCode(name, label, help)!;
      const c = rootCall(name);
      const on = !!c && !(c.args.items[0]?.value.kind === "bool" && !(c.args.items[0].value as { value: boolean }).value);
      return line(label, toggleSwitch(on, (v) => set(name, v ? "" : null)), !!c, () => set(name, null), help);
    };
    const textRow = (name: string, label: string, placeholder = "", help?: string) => {
      if (unreadable(name, (n) => !!textValue(n))) return asCode(name, label, help)!;
      const c = rootCall(name);
      return line(label, commitInput(textValue(c?.args.items[0]?.value)?.text ?? "", (v) => set(name, v ? phpString(v) : null), { placeholder }), !!c, () => set(name, null), help);
    };
    rows.push(
      flagRow("striped", "Striped rows"),
      textRow("poll", "Refresh every", "10s", "Reloads the table on a timer, such as 10s."),
      unreadable("reorderable", (n) => !!textValue(n)) ? asCode("reorderable", "Drag to reorder by")! : (() => {
        const c = rootCall("reorderable");
        const v = textValue(c?.args.items[0]?.value)?.text ?? "";
        const select = h("select", {}, h("option", { value: "", textContent: "Off" }), ...(d.facts?.columns ?? []).filter((x) => /int/.test(x.type) || /sort|order|position/.test(x.name)).map((x) => h("option", { value: x.name, textContent: x.name, selected: x.name === v })));
        select.onchange = () => set("reorderable", select.value ? phpString(select.value) : null, "Changed reordering");
        return line("Drag to reorder by", select, !!c, () => set("reorderable", null), "Lets people reorder records by dragging, saving the order in a column.");
      })(),
      unreadable("defaultPaginationPageOption", (n) => n.kind === "number") ? asCode("defaultPaginationPageOption", "Records per page")! : (() => {
        const c = rootCall("defaultPaginationPageOption");
        const v = nodeValue(c?.args.items[0]?.value);
        return line("Records per page", commitInput(typeof v === "number" ? String(v) : "", (x) => set("defaultPaginationPageOption", x ? String(Number(x) || 10) : null), { type: "number", placeholder: "10", className: "fd-number" }), !!c, () => set("defaultPaginationPageOption", null));
      })(),
      textRow("searchPlaceholder", "Search placeholder", "Search"),
      flagRow("deferLoading", "Load after the page", "Shows the page first and loads the records after, for slow queries."),
      flagRow("persistFiltersInSession", "Remember filters"),
      flagRow("persistSortInSession", "Remember sorting"),
      flagRow("persistSearchInSession", "Remember the search"),
      textRow("emptyStateHeading", "Empty heading", "No records"),
      textRow("emptyStateDescription", "Empty description"),
    );
  }
  return h(
    "div",
    { class: "fd-inspector-body" },
    h("header", { class: "fd-inspector-head" }, h("span", { class: `codicon codicon-${ref.kind === "table" ? "table" : "note"} fd-type-icon` }), h("div", { class: "fd-inspector-title" }, h("strong", {}, humanize(ref.kind)), h("span", { class: "fd-note" }, `${count} ${count === 1 ? "component" : "components"}`))),
    h("details", { class: "fd-group", open: true }, h("summary", {}, icon("settings-gear"), `${humanize(ref.kind)} settings`), h("div", { class: "fd-rows" }, ...rows)),
    h(
      "div",
      { class: "fd-tips" },
      h("h4", {}, "Tips"),
      h("p", {}, "Drag components from the left onto the canvas, or click one to add it after the selection."),
      h("p", {}, "Drag a model column to get the component that suits it, already configured."),
      h("p", {}, h("kbd", {}, "⌫"), " deletes, ", h("kbd", {}, "⌘D"), " duplicates, ", h("kbd", {}, "⌥↑"), h("kbd", {}, "⌥↓"), " move, and ", h("kbd", {}, "⌘Z"), " undoes."),
    ),
  );

  function classFor(cls: string) {
    return d.cat?.classes.find((c) => c.class === cls)?.kind;
  }
}

