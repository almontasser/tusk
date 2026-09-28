// The designer's inspector: the settings of the selected component. First the ones people change most, with editors
// of their own (options, input type, formatting, conditions), then every configuring method the class has, grouped
// by the trait that declares it, with an editor chosen from the parameter types. Each change is a call to add,
// change, or remove, which the designer writes into the code.
import { h, icon, iconButton } from "./dom";
import { type CanvasCtx, arg, call, flag, labelOf } from "./filamentcanvas";
import { type Catalog, type CClass, classInfo, COLORS, type Editor, essentials, HIDDEN_METHODS, heroiconCase, heroiconFile, humanize, labelFromName, look, majorVersion, type MethodInfo, methodEditor, methodsOf, palette } from "./filamentcatalog";
import { type Condition, conditionClosure, getUtility, needsValue, type Operator, OPERATORS, readConditions, type Relation } from "./filamentgen";
import type { EnumInfo } from "./filamentapp";
import { colorChooser, commitInput, heroicon, pickHeroicon, segmented, toggleSwitch } from "./filamentpickers";
import { ownTranslation, translate, type Translations } from "./translations";
import { BEHAVIORS, type Behavior, behaviorCode, readBehavior, type Scope } from "./filamentactions";
import { type Comp, type Path, shortClass, walk } from "./filamentschema";
import { confirm } from "./palette";
import { mapCode, mapValue, nodeValue, type PNode, phpString, phpValue, textValue } from "./phpcode";

/** A call to set: its arguments as code (`{{Fqn}}` names a class), "" for none, or null to remove it. */
export type CallChange = { path?: Path; name: string; args: string | null };

export type InspectorCtx = {
  cat: Catalog;
  canvas: CanvasCtx;
  path: Path;
  comp: Comp;
  /** The code of the file the component is in. */
  text: string;
  enums: EnumInfo[];
  columns: string[];
  relations: Relation[];
  /** The columns of a related model, for a relationship's title attribute. */
  relatedColumns(model: string): Promise<string[]>;
  set(changes: CallChange[]): void;
  setMake(args: string): void;
  changeType(cls: string): void;
  reveal(node: PNode): void;
  remove(): void;
  duplicate(): void;
  wrap(cls: string): void;
  /** Opens the enum designer for a new enum, seeded with `values`, and makes it the field's options once it's made. */
  newEnum(options: [value: string, label: string][]): void;
  /** Opens the enum designer for an enum of the app's. */
  openEnum(cls: string): void;
  /** For a custom action: what it works with, and the record's model, for "What it does". */
  action?: { scope: Scope; model: string | null; casts: Record<string, string> };
  /** The app's translations, for text written with `__()`. */
  i18n?: { t: Translations; locale: string | null; write(locale: string, key: string, value: string): void; rename(from: string, to: string): Promise<void> };
};

const HEROICON = "Filament\\Support\\Icons\\Heroicon";

/** The code of a node, as written. */
const codeOf = (ctx: InspectorCtx, node: PNode) => ctx.text.slice(node.span[0], node.span[1]);

/** A group of settings with a heading, open or closed. */
function group(title: string, rows: (HTMLElement | null)[], open = true, iconName?: string): HTMLElement | null {
  const shown = rows.filter(Boolean) as HTMLElement[];
  if (!shown.length) return null;
  const details = h("details", { class: "fd-group", open }, h("summary", {}, iconName ? icon(iconName) : null, title), h("div", { class: "fd-rows" }, ...shown));
  return details;
}

/** A labeled row: its label, the editor, and a button that removes the call when it's set. */
function row(label: string, editor: HTMLElement, o: { set?: boolean; reset?: () => void; doc?: string; stacked?: boolean } = {}): HTMLElement {
  return h(
    "div",
    { class: `fd-row${o.set ? " set" : ""}${o.stacked ? " stacked" : ""}`, title: o.doc ?? "" },
    h("span", { class: "fd-row-label" }, label),
    h("div", { class: "fd-row-editor" }, editor),
    o.set && o.reset ? iconButton("discard", "Remove this setting", o.reset) : h("span", { class: "fd-row-spacer" }),
  );
}

/** A chip for a value only code can hold, which opens the code. */
const codeChip = (ctx: InspectorCtx, node: PNode) =>
  h("button", { type: "button", class: "fd-code-chip", title: codeOf(ctx, node).slice(0, 400), onclick: () => ctx.reveal(node) }, icon("code"), h("span", {}, codeOf(ctx, node).replace(/\s+/g, " ").slice(0, 48)));

/** A string argument's code, keeping `__()` when the old one was translated. */
function stringCode(value: string, old: PNode | undefined) {
  const translated = old && textValue(old)?.translated;
  return translated ? `__(${phpString(value)})` : phpString(value);
}

/** The code for an icon: Heroicon's enum case on Filament 4 and later, and the string name before. */
function iconCode(ctx: InspectorCtx, caseName: string) {
  if (!caseName) return null;
  return majorVersion(ctx.cat) >= 4 && ctx.cat.heroicons.length ? `{{${HEROICON}}}::${caseName}` : phpString(`heroicon-${heroiconFile(caseName)}`);
}

/** The icon a node names, as an enum case or string, for previews. */
export const iconNameOf = (node: PNode | undefined) => (node?.kind === "classConst" ? node.name : (textValue(node)?.text ?? null));

// ---- One method's editor ----

function methodRow(ctx: InspectorCtx, m: MethodInfo, label = humanize(m.name)): HTMLElement {
  const c = ctx.comp;
  const existing = call(c, m.name);
  const first = existing?.args.items[0]?.value;
  const editor = methodEditor(ctx.cat, m.name, m.method);
  const set = (args: string | null) => ctx.set([{ name: m.name, args }]);
  const reset = () => set(null);
  const doc = [m.method.doc, `${m.label}::${m.name}(${m.method.params.map((p) => `${p.types.join("|")} $${p.name}${p.default !== undefined ? ` = ${p.default}` : ""}`).join(", ")})`].filter(Boolean).join("\n");
  const named = existing?.args.items.some((a) => a.name);
  // A value the editor can't show, such as a closure, stays as code.
  // A value the editor can't show in full, such as a closure or an array with code in it, stays as code, so an
  // edit never writes back less than the code held.
  if (existing && first && (!readable(editor, first) || (named && editor.kind !== "switch"))) return row(label, codeChip(ctx, first), { set: true, reset, doc });
  if (existing && existing.args.items.length > 1 && editor.kind !== "switch" && editor.kind !== "presence") return row(label, codeChip(ctx, first ?? (c.node as PNode)), { set: true, reset, doc });
  const value = editorFor(ctx, editor, m.name, first, existing !== undefined, set);
  const i18n = editor.kind === "text" ? translationRows(ctx, first, set, m.name === "label" && flag(c, "translateLabel")) : null;
  return row(label, i18n ? h("div", { class: "fd-stack" }, value, i18n) : value, { set: !!existing, reset, doc, stacked: !!i18n || editor.kind === "map" || (editor.kind === "text" && !!editor.multiline) });
}

/**
 * Under a text written with `__()`, its translation in each of the app's languages; under plain text, a button
 * that makes it translatable. Nothing when the app has no lang files.
 */
function translationRows(ctx: InspectorCtx, node: PNode | undefined, set: (args: string | null) => void, byFlag = false): HTMLElement | null {
  const i18n = ctx.i18n;
  const v = textValue(node);
  if (!i18n || !v || !v.text) return null;
  // A label with `translateLabel()` is translated as written.
  if (!v.translated && !byFlag)
    return h("button", { type: "button", class: "fd-chip-link fd-translate", title: "Write it with __(), so each language can have its own text", onclick: () => set(`__(${phpString(v.text)})`) }, icon("globe"), "Translate");
  const { t } = i18n;
  return h(
    "div",
    { class: "fd-translations" },
    ...t.locales.map((locale) => {
      const own = ownTranslation(t, locale, v.text);
      const input = commitInput(own ?? "", (x) => x !== (own ?? "") && i18n.write(locale, v.text, x), { placeholder: own === undefined ? `${translate(t, locale, v.text).text} (not translated)` : "" }) as HTMLInputElement;
      if (/^(ar|he|fa|ur)/.test(locale)) input.dir = "rtl";
      return h("label", { class: `fd-translation${own === undefined ? " missing" : ""}${locale === i18n.locale ? " current" : ""}` }, h("span", { class: "fd-translation-locale" }, locale), input);
    }),
  );
}

/** Whether an editor can show a value in full. */
function readable(editor: Editor, node: PNode): boolean {
  switch (editor.kind) {
    case "presence":
    case "switch":
      return node.kind === "bool";
    case "number":
      return node.kind === "number";
    case "text":
      return !!textValue(node) || node.kind === "number";
    case "enum":
      return node.kind === "classConst" || node.kind === "string" || node.kind === "number";
    case "icon":
      return node.kind === "classConst" || !!textValue(node);
    case "color":
      return node.kind === "string";
    case "list": {
      const v = nodeValue(node);
      return Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number");
    }
    case "map":
      return !!mapValue(node);
    case "value": {
      const v = nodeValue(node);
      return v !== undefined && (v === null || typeof v !== "object");
    }
    case "code":
      return true;
  }
}

function editorFor(ctx: InspectorCtx, editor: Editor, name: string, value: PNode | undefined, present: boolean, set: (args: string | null) => void): HTMLElement {
  switch (editor.kind) {
    case "presence":
      return toggleSwitch(present, (on) => set(on ? "" : null), name);
    case "switch": {
      const on = present && !(value?.kind === "bool" && !value.value);
      return toggleSwitch(on, (v) => set(v ? "" : null), name);
    }
    case "number": {
      const v = nodeValue(value);
      return commitInput(typeof v === "number" ? String(v) : "", (s) => set(s.trim() === "" ? null : String(Number(s) || 0)), { type: "number", className: "fd-number" });
    }
    case "text": {
      const t = textValue(value);
      return commitInput(t?.text ?? "", async (s) => {
        // A translated text's translations follow it to its new key.
        if (t?.translated && s && ctx.i18n) await ctx.i18n.rename(t.text, s);
        set(s === "" ? null : stringCode(s, value));
      }, { multiline: editor.multiline, placeholder: "" });
    }
    case "enum": {
      const cases = ctx.cat.enums[editor.enum] ?? [];
      const current = value?.kind === "classConst" ? value.name : typeof nodeValue(value) === "string" ? cases.find((c) => c.value === nodeValue(value))?.name : "";
      const select = h("select", {}, h("option", { value: "", textContent: "Default" }), ...cases.map((c) => h("option", { value: c.name, textContent: humanize(c.name), selected: c.name === current })));
      select.onchange = () => set(select.value ? `{{${editor.enum}}}::${select.value}` : null);
      return select;
    }
    case "icon":
      return iconButtonEditor(ctx, iconNameOf(value), (caseName) => set(caseName ? iconCode(ctx, caseName) : null));
    case "color": {
      const v = textValue(value)?.text ?? null;
      return colorChooser(v && COLORS.includes(v) ? v : null, (color) => set(color ? phpString(color) : null));
    }
    case "list": {
      const v = nodeValue(value);
      const list = Array.isArray(v) ? v.map(String) : [];
      return commitInput(list.join(", "), (s) => {
        const items = s
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        set(items.length ? phpValue(items) : null);
      }, { placeholder: "Comma-separated" });
    }
    case "map": {
      const m = mapValue(value);
      return mapEditor(m?.entries ?? [], (entries) => set(entries.length ? mapCode(entries, m?.translated ?? false) : null));
    }
    case "value": {
      const v = nodeValue(value);
      const shown = v === undefined || v === null ? "" : typeof v === "object" ? "" : String(v);
      return commitInput(shown, (s) => set(s === "" ? null : /^-?\d+(\.\d+)?$/.test(s.trim()) || /^(true|false|null)$/.test(s.trim()) ? s.trim() : stringCode(s, value)), { placeholder: "A value, true, false, or a number" });
    }
    case "code":
      return present
        ? codeChip(ctx, value ?? ctx.comp.node)
        : h("button", { type: "button", class: "fd-code-add", title: "Adds the call with a closure to fill in, and opens it in the editor", onclick: () => set("fn ($state) => $state") }, icon("code"), "Add in code");
  }
}

/** A button that shows the chosen icon and opens the picker. */
function iconButtonEditor(ctx: InspectorCtx, current: string | null, set: (caseName: string | null) => void): HTMLElement {
  const label = current ? (heroiconCase(current) ?? current).replace(/^Outlined/, "").replace(/([a-z\d])([A-Z])/g, "$1 $2") : "None";
  const btn = h("button", { type: "button", class: "fd-icon-button" }, heroicon(ctx.cat.heroiconsDir, current), h("span", {}, label), icon("chevron-down"));
  btn.onclick = async () => {
    const picked = await pickHeroicon(btn, { dir: ctx.cat.heroiconsDir, cases: ctx.cat.heroicons, current });
    if (picked === null) return;
    set(picked || null);
  };
  return btn;
}

/** Rows of keys and labels, as options take them. */
function mapEditor(value: [string, string][], commit: (entries: [string, string][]) => void): HTMLElement {
  const rows: [string, string][] = value.map(([k, v]) => [k, v]);
  const wrap = h("div", { class: "fd-map" });
  // Entries keep their order: an object would move keys like "3" first.
  const save = () => commit(rows.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v || labelFromName(k.trim())]));
  const render = () => {
    wrap.replaceChildren(
      h("div", { class: "fd-map-head" }, h("span", {}, "Value saved"), h("span", {}, "Label shown")),
      ...rows.map((r, i) =>
        h(
          "div",
          { class: "fd-map-row" },
          commitInput(r[0], (v) => {
            const autoLabel = !r[1] || r[1] === labelFromName(r[0]);
            r[0] = v;
            if (autoLabel) r[1] = labelFromName(v);
            save();
          }, { placeholder: "draft" }),
          commitInput(r[1], (v) => ((r[1] = v), save()), { placeholder: "Draft" }),
          iconButton("close", "Remove", () => (rows.splice(i, 1), render(), save())),
        ),
      ),
      h("button", { type: "button", class: "fd-map-add", onclick: () => (rows.push(["", ""]), render(), (wrap.querySelector(".fd-map-row:last-of-type input") as HTMLInputElement)?.focus()) }, icon("add"), "Add option"),
    );
  };
  render();
  return wrap;
}

// ---- The designer's own editors ----

function nameEditor(ctx: InspectorCtx, info: CClass | undefined): HTMLElement | null {
  const c = ctx.comp;
  const first = c.make.args.items[0];
  const kind = info?.kind;
  const short = shortClass(c.cls);
  if (short === "Grid") {
    const v = nodeValue(first?.value);
    return row("Columns", commitInput(typeof v === "number" ? String(v) : "", (s) => ctx.setMake(s.trim() || ""), { type: "number", className: "fd-number" }), { set: !!first });
  }
  if (first && !["string", "func"].includes(first.value.kind)) return row(kind === "layout" ? "Heading" : "Name", codeChip(ctx, first.value), { set: true });
  const value = textValue(first?.value)?.text ?? "";
  if (kind === "field" || kind === "column" || kind === "entry" || kind === "filter") {
    const listId = `fd-columns-${kind}`;
    const options = kind === "column" || kind === "entry" ? [...ctx.columns, ...ctx.relations.map((r) => `${r.name}.name`)] : kind === "filter" ? [...ctx.columns, ...ctx.relations.map((r) => r.name)] : ctx.columns;
    const list = h("datalist", { id: listId }, ...options.map((o) => h("option", { value: o })));
    const input = commitInput(value, (v) => v.trim() && ctx.setMake(phpString(v.trim())), { list: listId, className: "fd-mono" });
    return row(kind === "column" || kind === "entry" ? "Column" : kind === "filter" ? "Name" : "Field (column)", h("div", { class: "fd-inline-editor" }, input, list), { doc: "The attribute it reads and saves, such as a column of the model. Columns and entries can reach relationships with a dot: author.name." });
  }
  const label = kind === "layout" ? (["Tab", "Step", "Fieldset"].includes(short) ? "Label" : "Heading") : "Name";
  const input = commitInput(value, async (v) => {
    const t = textValue(first?.value);
    if (t?.translated && v && ctx.i18n) await ctx.i18n.rename(t.text, v);
    ctx.setMake(v ? stringCode(v, first?.value) : "");
  }, {});
  const i18n = translationRows(ctx, first?.value, (args) => ctx.setMake(args ?? ""));
  return row(label, i18n ? h("div", { class: "fd-stack" }, input, i18n) : input, { set: !!first, stacked: !!i18n });
}

const INPUT_TYPES: [string, string][] = [
  ["", "Text"],
  ["email", "Email"],
  ["password", "Password"],
  ["tel", "Phone"],
  ["url", "URL"],
  ["numeric", "Number"],
  ["integer", "Integer"],
];

function inputTypeEditor(ctx: InspectorCtx): HTMLElement {
  const c = ctx.comp;
  const current = INPUT_TYPES.find(([m]) => m && flag(c, m))?.[0] ?? "";
  const select = h("select", {}, ...INPUT_TYPES.map(([m, label]) => h("option", { value: m, textContent: label, selected: m === current })));
  select.onchange = () =>
    ctx.set([
      ...INPUT_TYPES.filter(([m]) => m && m !== select.value && call(c, m)).map(([m]) => ({ name: m, args: null })),
      ...(select.value ? [{ name: select.value, args: "" }] : []),
      ...(select.value === "password" && !call(c, "revealable") ? [{ name: "revealable", args: "" }] : []),
      ...(current === "password" && call(c, "revealable") ? [{ name: "revealable", args: null }] : []),
    ]);
  return row("Input type", select);
}

function optionsEditor(ctx: InspectorCtx): HTMLElement {
  const c = ctx.comp;
  const options = arg(c, "options");
  const rel = call(c, "relationship");
  const list = mapValue(options);
  const source: "list" | "enum" | "relationship" | "code" = rel ? "relationship" : options?.kind === "classConst" ? "enum" : !options || list ? "list" : "code";
  const wrap = h("div", { class: "fd-options" });
  const clearOthers = (keep: string) => [...(keep !== "options" && options ? [{ name: "options", args: null }] : []), ...(keep !== "relationship" && rel ? [{ name: "relationship", args: null }] : [])];
  const tabs = segmented<"list" | "enum" | "relationship" | "code">(
    [
      ["list", "List"],
      ["enum", "Enum"],
      ["relationship", "Relationship"],
    ],
    source,
    async (v) => {
      // Options written as code are replaced only when you say so.
      if (source === "code" && !(await confirm("Replace the options written in code?", "Replace"))) return;
      if (v === "list") ctx.set([...clearOthers("options"), { name: "options", args: phpValue({ option: "Option" }) }]);
      if (v === "enum" && ctx.enums[0]) ctx.set([...clearOthers("options"), { name: "options", args: `{{${ctx.enums[0].class}}}::class` }]);
      if (v === "enum" && !ctx.enums[0]) ctx.newEnum(list?.entries ?? []);
      if (v === "relationship") {
        const r = ctx.relations.find((x) => /BelongsTo|BelongsToMany|MorphToMany/.test(x.type));
        ctx.set([...clearOthers("relationship"), { name: "relationship", args: `${phpString(r?.name ?? "relation")}, 'name'` }, ...(r && /Many/.test(r.type) && !call(c, "multiple") && shortClass(c.cls) === "Select" ? [{ name: "multiple", args: "" }] : [])]);
      }
    },
  );
  wrap.append(tabs);
  if (source === "code" && options) wrap.append(codeChip(ctx, options));
  if (source === "list") {
    if (list?.entries.length) wrap.append(h("button", { type: "button", class: "fd-chip-link fd-options-enumify", title: "Move these options into a PHP enum, which the model can cast to", onclick: () => ctx.newEnum(list.entries) }, icon("symbol-enum"), "Make an enum of these"));
    const translated = list?.translated ?? false;
    wrap.append(mapEditor(list?.entries ?? [], (entries) => ctx.set([{ name: "options", args: entries.length ? mapCode(entries, translated) : null }])));
  }
  if (source === "enum") {
    const current = options?.kind === "classConst" ? options.class : "";
    const select = h("select", {}, ...ctx.enums.map((e) => h("option", { value: e.class, textContent: shortClass(e.class), selected: e.class === current })));
    if (current && !ctx.enums.some((e) => e.class === current)) select.prepend(h("option", { value: current, textContent: shortClass(current), selected: true }));
    select.onchange = () => ctx.set([{ name: "options", args: `{{${select.value}}}::class` }]);
    const e = ctx.enums.find((x) => x.class === current);
    wrap.append(
      h(
        "div",
        { class: "fd-options-enum" },
        select,
        current ? iconButton("edit", "Edit the enum's cases, labels, and colors", () => ctx.openEnum(current)) : null,
        iconButton("add", "New enum…", () => ctx.newEnum([])),
      ),
    );
    if (e) wrap.append(h("p", { class: "fd-note" }, `${e.cases.length} cases${e.contracts.includes("HasLabel") ? ", with labels" : ""}: ${e.cases.slice(0, 5).map((x) => x.name).join(", ")}${e.cases.length > 5 ? "…" : ""}`));
  }
  if (source === "relationship" && rel) {
    const [nameNode, titleNode] = [rel.args.items[0]?.value, rel.args.items[1]?.value];
    if ((nameNode && !textValue(nameNode)) || (titleNode && !textValue(titleNode)) || rel.args.items.some((a) => a.name && !["modifyQueryUsing", "titleAttribute", "name"].includes(a.name))) {
      wrap.append(codeChip(ctx, rel.args.items[0]?.value ?? c.node));
      return row("Options", wrap, { stacked: true, set: true });
    }
    const relName = textValue(nameNode)?.text ?? "";
    const title = textValue(titleNode)?.text ?? "";
    const relSelect = h("select", {}, ...ctx.relations.map((r) => h("option", { value: r.name, textContent: `${r.name} · ${r.type}`, selected: r.name === relName })));
    if (relName && !ctx.relations.some((r) => r.name === relName)) relSelect.prepend(h("option", { value: relName, textContent: relName, selected: true }));
    const titleSelect = h("select", {}, h("option", { value: title, textContent: title || "(choose)" }));
    const related = ctx.relations.find((r) => r.name === relName)?.related;
    if (related)
      void ctx.relatedColumns(related).then((cols) => {
        titleSelect.replaceChildren(...cols.map((col) => h("option", { value: col, textContent: col, selected: col === title })));
        if (title && !cols.includes(title)) titleSelect.prepend(h("option", { value: title, textContent: title, selected: true }));
      });
    // A third argument, such as a closure that narrows the query, stays as written.
    const rest = rel.args.items.slice(2).map((a) => ctx.text.slice(a.span[0], a.span[1]));
    const write = () => ctx.set([{ name: "relationship", args: [phpString(relSelect.value), phpString(titleSelect.value || "name"), ...rest].join(", ") }]);
    relSelect.onchange = write;
    titleSelect.onchange = write;
    wrap.append(h("div", { class: "fd-pair" }, h("label", {}, "Relationship", relSelect), h("label", {}, "Shows", titleSelect)));
  }
  return row("Options", wrap, { stacked: true, set: !!(options || rel) });
}

function spanEditor(ctx: InspectorCtx): HTMLElement {
  const c = ctx.comp;
  const full = flag(c, "columnSpanFull") || nodeValue(arg(c, "columnSpan")) === "full";
  const n = nodeValue(arg(c, "columnSpan"));
  const current = full ? "full" : typeof n === "number" ? String(n) : call(c, "columnSpan") ? "code" : "";
  const choose = (v: string) =>
    ctx.set([
      { name: "columnSpan", args: v && v !== "full" ? v : null },
      { name: "columnSpanFull", args: v === "full" ? "" : null },
    ]);
  if (current === "code") return row("Width", codeChip(ctx, arg(c, "columnSpan")!), { set: true });
  return row("Width", segmented<string>([["", "Auto"], ["1", "1"], ["2", "2"], ["3", "3"], ["full", "Full"]], current, choose, { "": "As many columns as the layout gives it", full: "The whole row" }), { set: !!current });
}

const FORMATS: [string, string][] = [
  ["", "Plain"],
  ["date", "Date"],
  ["dateTime", "Date and time"],
  ["time", "Time"],
  ["since", "Time ago"],
  ["money", "Money"],
  ["numeric", "Number"],
];

function formatEditor(ctx: InspectorCtx): HTMLElement {
  const c = ctx.comp;
  const current = FORMATS.find(([m]) => m && call(c, m))?.[0] ?? "";
  const select = h("select", {}, ...FORMATS.map(([m, label]) => h("option", { value: m, textContent: label, selected: m === current })));
  select.onchange = () => ctx.set([...FORMATS.filter(([m]) => m && m !== select.value && call(c, m)).map(([m]) => ({ name: m, args: null })), ...(select.value ? [{ name: select.value, args: select.value === "money" ? "'usd'" : "" }] : [])]);
  const extra = current === "money" ? commitInput(textValue(arg(c, "money"))?.text ?? "usd", (v) => ctx.set([{ name: "money", args: phpString(v || "usd") }]), { className: "fd-short", placeholder: "usd" }) : null;
  return row("Format", h("div", { class: "fd-inline-editor" }, select, extra), { set: !!current });
}

/** Where a component shows: on which pages (create, edit, view) and under which conditions. */
function visibilityGroup(ctx: InspectorCtx, info: CClass | undefined): HTMLElement | null {
  const c = ctx.comp;
  const methods = info ? methodsOf(ctx.cat, info) : new Map();
  const rows: HTMLElement[] = [];
  if (methods.has("visibleOn") && info?.kind !== "column") {
    const on = arg(c, "visibleOn");
    const hiddenOn = arg(c, "hiddenOn");
    const ops = ["create", "edit", "view"];
    const read = (n: PNode | undefined) => {
      const v = nodeValue(n);
      return typeof v === "string" ? [v] : Array.isArray(v) ? v.map(String) : null;
    };
    const shown = read(on) ?? (read(hiddenOn) ? ops.filter((o) => !read(hiddenOn)!.includes(o)) : ops);
    if ((on && !read(on)) || (hiddenOn && !read(hiddenOn))) rows.push(row("Pages", codeChip(ctx, (on ?? hiddenOn)!), { set: true }));
    else
      rows.push(
        row(
          "Shows on",
          h(
            "div",
            { class: "fd-checks" },
            ...ops.map((op) => {
              const box = h("input", { type: "checkbox", checked: shown.includes(op) });
              box.onchange = () => {
                const next = ops.filter((o) => (o === op ? box.checked : shown.includes(o)));
                ctx.set([
                  { name: "hiddenOn", args: null },
                  { name: "visibleOn", args: next.length === ops.length ? null : next.length === 1 ? phpString(next[0]) : phpValue(next) },
                ]);
              };
              return h("label", {}, box, humanize(op));
            }),
          ),
          { set: !!(on || hiddenOn), reset: () => ctx.set([{ name: "visibleOn", args: null }, { name: "hiddenOn", args: null }]) },
        ),
      );
  }
  for (const [method, label] of [
    ["visible", "Visible when"],
    ["required", "Required when"],
    ["disabled", "Disabled when"],
  ] as const) {
    if (!methods.has(method)) continue;
    if (method !== "visible" && info?.kind !== "field") continue;
    rows.push(conditionEditor(ctx, method, label));
  }
  if (methods.has("hidden") && !call(c, "visible")) {
    const hidden = call(c, "hidden");
    const value = hidden?.args.items[0]?.value;
    if (!hidden || !value || value.kind === "bool") rows.push(row("Always hidden", toggleSwitch(flag(c, "hidden"), (on) => ctx.set([{ name: "hidden", args: on ? "" : null }])), { set: !!hidden, reset: () => ctx.set([{ name: "hidden", args: null }]) }));
    else rows.push(row("Hidden when", codeChip(ctx, value), { set: true, reset: () => ctx.set([{ name: "hidden", args: null }]) }));
  }
  return group("Visibility", rows, true, "eye");
}

/** Other fields of the form, by name, for conditions. */
function formFields(ctx: InspectorCtx): { name: string; label: string; path: Path; comp: Comp }[] {
  const out: { name: string; label: string; path: Path; comp: Comp }[] = [];
  walk(ctx.canvas.root, (comp, path) => {
    if (comp.name && classInfo(ctx.cat, comp.cls)?.kind === "field" && comp !== ctx.comp) out.push({ name: comp.name, label: labelOf(comp), path, comp });
  });
  return out;
}

/**
 * Builds `->visible(fn (Get $get): bool => …)` and the like from conditions on other fields. The fields a condition
 * reads become `live()`, since Filament only updates the form as they change when they are.
 */
function conditionEditor(ctx: InspectorCtx, method: "visible" | "required" | "disabled", label: string): HTMLElement {
  const c = ctx.comp;
  const existing = call(c, method);
  const node = existing?.args.items[0]?.value;
  // `required()` without arguments is always required: that's the switch in the first settings.
  if (existing && (!node || node.kind === "bool") && method !== "visible") return h("span");
  const parsed = node ? readConditions(codeOf(ctx, node)) : { conditions: [], join: "all" as const };
  if (existing && node && !parsed) return row(label, codeChip(ctx, node), { set: true, reset: () => ctx.set([{ name: method, args: null }]) });
  const fields = formFields(ctx);
  const state = parsed ?? { conditions: [] as Condition[], join: "all" as const };
  const wrap = h("div", { class: "fd-conditions" });
  const save = () => {
    const done = state.conditions.filter((x) => x.field && (!needsValue(x.op) || (x.value ?? "") !== ""));
    const get = `{{${getUtility(majorVersion(ctx.cat))}}}`;
    const live = done
      .map((x) => fields.find((f) => f.name === x.field))
      .filter((f): f is (typeof fields)[number] => !!f && !flag(f.comp, "live") && !flag(f.comp, "reactive"))
      .filter((f, i, all) => all.indexOf(f) === i)
      .map((f) => ({ path: f.path, name: "live", args: "" }));
    ctx.set([{ name: method, args: done.length ? conditionClosure(done, state.join, get) : null }, ...live]);
  };
  const render = () => {
    wrap.replaceChildren(
      ...state.conditions.map((cond, i) => {
        const field = h("select", { class: "fd-cond-field" }, h("option", { value: "", textContent: "Field…" }), ...fields.map((f) => h("option", { value: f.name, textContent: f.label, selected: f.name === cond.field })));
        if (cond.field && !fields.some((f) => f.name === cond.field)) field.append(h("option", { value: cond.field, textContent: cond.field, selected: true }));
        field.onchange = () => ((cond.field = field.value), save());
        const op = h("select", { class: "fd-cond-op" }, ...OPERATORS.map(([v, l]) => h("option", { value: v, textContent: l, selected: v === cond.op })));
        op.onchange = () => ((cond.op = op.value as Operator), render(), save());
        const target = fields.find((f) => f.name === cond.field)?.comp;
        const opts = target ? Object.fromEntries(mapValue(arg(target, "options"))?.entries ?? []) : undefined;
        let value: HTMLElement | null = null;
        if (needsValue(cond.op)) {
          if (opts && Object.keys(opts).length && cond.op !== "in") {
            const s = h("select", { class: "fd-cond-value" }, h("option", { value: "", textContent: "Value…" }), ...Object.entries(opts as Record<string, string>).map(([k, l]) => h("option", { value: k, textContent: String(l), selected: k === cond.value })));
            s.onchange = () => ((cond.value = s.value), save());
            value = s;
          } else value = commitInput(cond.value ?? "", (v) => ((cond.value = v), save()), { placeholder: cond.op === "in" ? "a, b" : "value", className: "fd-cond-value" });
        }
        return h("div", { class: "fd-cond" }, field, op, value, iconButton("close", "Remove the condition", () => (state.conditions.splice(i, 1), render(), save())));
      }),
      h(
        "div",
        { class: "fd-cond-foot" },
        h("button", { type: "button", class: "fd-map-add", onclick: () => (state.conditions.push({ field: fields[0]?.name ?? "", op: "equals", value: "" }), render()) }, icon("add"), "Add condition"),
        state.conditions.length > 1 ? segmented<"all" | "any">([["all", "All"], ["any", "Any"]], state.join, (v) => ((state.join = v), render(), save())) : null,
      ),
    );
  };
  render();
  return row(label, wrap, { stacked: true, set: !!existing, reset: () => ctx.set([{ name: method, args: null }]) });
}

// ---- The inspector ----

const GROUP_TITLES: Record<string, string> = {
  CanBeValidated: "Validation",
  CanBeLengthConstrained: "Validation",
  HasAffixes: "Prefix and suffix",
  CanSpanColumns: "Layout",
  HasColumns: "Layout",
  HasLabel: "Label",
  HasPlaceholder: "Label",
  HasHelperText: "Label",
  HasHint: "Label",
  HasExtraAttributes: "Attributes",
  CanBeHidden: "Visibility",
  CanBeDisabled: "Behavior",
  CanBeReadOnly: "Behavior",
  CanBeAutofocused: "Behavior",
  HasState: "State",
  CanBeSearchable: "Search",
  CanBeSortable: "Sorting",
  CanBeToggled: "Visibility",
  HasIcon: "Icon",
  HasColor: "Color",
  HasTooltip: "Tooltip",
};

/** The title of a group of settings, from the trait or class that declares them. */
const groupTitle = (label: string) => GROUP_TITLES[label] ?? humanize(label.replace(/^(Has|CanBe|Can|Is|Interacts\s?With)(?=[A-Z])/, "")).replace(/^$/, label);

export function renderInspector(ctx: InspectorCtx): HTMLElement {
  const c = ctx.comp;
  const info = classInfo(ctx.cat, c.cls);
  const methods = info ? methodsOf(ctx.cat, info) : new Map<string, MethodInfo>();
  const shown = new Set<string>();
  const essentialRows: (HTMLElement | null)[] = [];
  for (const name of info ? essentials(info) : ["@name"]) {
    if (name === "@name") essentialRows.push(nameEditor(ctx, info));
    else if (name === "@inputType") essentialRows.push(inputTypeEditor(ctx)), INPUT_TYPES.forEach(([m]) => shown.add(m)), shown.add("revealable");
    else if (name === "@options") essentialRows.push(optionsEditor(ctx)), shown.add("options"), shown.add("relationship");
    else if (name === "@span") essentialRows.push(spanEditor(ctx)), shown.add("columnSpan"), shown.add("columnSpanFull");
    else if (name === "@format") essentialRows.push(formatEditor(ctx)), FORMATS.forEach(([m]) => shown.add(m));
    else if (name === "@behavior") essentialRows.push(...behaviorEditor(ctx)), shown.add("action"), shown.add("fillForm");
    else if (methods.has(name) && !shown.has(name)) {
      shown.add(name);
      essentialRows.push(specialRow(ctx, methods.get(name)!) ?? methodRow(ctx, methods.get(name)!));
    }
  }
  ["visible", "hidden", "visibleOn", "hiddenOn"].forEach((m) => shown.add(m));

  // Every other setting, grouped by the trait or class that declares it; searching opens the groups that match.
  const search = h("input", { type: "search", class: "fd-search-settings", placeholder: `Search ${methods.size} settings`, spellcheck: false });
  const all = h("div", { class: "fd-all" });
  const renderAll = () => {
    const q = search.value.trim().toLowerCase();
    const groups = new Map<string, MethodInfo[]>();
    for (const m of methods.values()) {
      if (HIDDEN_METHODS.has(m.name) || m.method.deprecated || shown.has(m.name)) continue;
      if (q && !`${m.name} ${humanize(m.name)} ${m.method.doc ?? ""}`.toLowerCase().includes(q)) continue;
      const title = groupTitle(m.label);
      if (!groups.has(title)) groups.set(title, []);
      groups.get(title)!.push(m);
    }
    const set = (m: MethodInfo) => !!call(c, m.name);
    all.replaceChildren(
      ...[...groups.entries()]
        .sort(([a, am], [b, bm]) => Number(bm.some(set)) - Number(am.some(set)) || a.localeCompare(b))
        .map(([title, list]) => {
          const count = list.filter(set).length;
          const g = group(`${title}${count ? ` · ${count}` : ""}`, list.map((m) => specialRow(ctx, m) ?? methodRow(ctx, m)), !!q || count > 0)!;
          return g;
        }),
    );
    if (!groups.size) all.append(h("p", { class: "fd-note" }, q ? "No settings match." : "No other settings."));
  };
  search.oninput = renderAll;
  renderAll();

  const kind = info?.kind;
  const same = info ? palette(ctx.cat, [info.kind]).flatMap((g) => g.classes) : [];
  const typeSelect = h("select", { class: "fd-type-select", title: "Change the component's type. Settings the new type doesn't have are removed." }, ...same.map((x) => h("option", { value: x.class, textContent: shortClass(x.class), selected: x.class === c.cls })));
  if (!same.some((x) => x.class === c.cls)) typeSelect.prepend(h("option", { value: c.cls, textContent: shortClass(c.cls), selected: true }));
  typeSelect.onchange = () => ctx.changeType(typeSelect.value);
  const wrapMenu = kind === "field" || kind === "layout" || kind === "entry" ? h("select", { class: "fd-wrap-select", title: "Put it inside a layout" }, h("option", { value: "", textContent: "Wrap in…" }), ...["Section", "Grid", "Fieldset", "Group"].map((n) => h("option", { value: `Filament\\Schemas\\Components\\${n}`, textContent: n }))) : null;
  if (wrapMenu) wrapMenu.onchange = () => wrapMenu.value && ctx.wrap(wrapMenu.value);

  return h(
    "div",
    { class: "fd-inspector-body" },
    h(
      "header",
      { class: "fd-inspector-head" },
      h("span", { class: `codicon codicon-${look(info ?? c.cls).icon} fd-type-icon` }),
      h("div", { class: "fd-inspector-title" }, h("strong", {}, labelOf(c)), info?.doc ? h("span", { class: "fd-note" }, info.doc) : h("span", { class: "fd-note" }, `${shortClass(c.cls)}${info ? ` · ${info.package}` : " · not in Filament's catalog"}`)),
      h("div", { class: "fd-inspector-actions" }, iconButton("go-to-file", "Show in the code", () => ctx.reveal(c.node)), iconButton("copy", "Duplicate (⌘D)", () => ctx.duplicate()), iconButton("trash", "Delete (⌫)", () => ctx.remove())),
    ),
    h("div", { class: "fd-inspector-type" }, typeSelect, wrapMenu),
    group("Settings", essentialRows, true, "settings-gear"),
    visibilityGroup(ctx, info),
    h("div", { class: "fd-all-head" }, h("span", {}, "All settings"), search),
    all,
  );
}

/** The code `fillForm` gets with "Save the form to the record", so the form opens with the record's values. */
const FILL_FORM = (model: string) => `fn ({{${model}}} $record): array => $record->attributesToArray()`;

/**
 * "What it does" for a custom action: a behavior the designer writes as `->action(...)`'s closure, with a success
 * notification. A closure it didn't write shows as code.
 */
function behaviorEditor(ctx: InspectorCtx): HTMLElement[] {
  const c = ctx.comp;
  const a = ctx.action;
  if (!a || !["Action", "BulkAction"].includes(shortClass(c.cls))) return [];
  const node = arg(c, "action");
  const current = readBehavior(node ? codeOf(ctx, node) : null);
  const model = a.model ?? "Illuminate\\Database\\Eloquent\\Model";
  const fill = call(c, "fillForm");
  const ourFill = !!fill && /^fn\s*\([\w\\]+ \$record\): array => \$record->attributesToArray\(\)$/.test(codeOf(ctx, fill.args.items[0]?.value ?? c.node));
  const write = async (b: Behavior) => {
    if (current.kind === "custom" && node && !(await confirm("Replace what the action does, written as code?", "Replace"))) return;
    const code = behaviorCode(b, a.scope, a.model);
    const changes: { name: string; args: string | null }[] = [{ name: "action", args: code }];
    if (b.kind === "update" && a.scope === "record" && !fill) changes.push({ name: "fillForm", args: FILL_FORM(model) });
    if (b.kind !== "update" && ourFill) changes.push({ name: "fillForm", args: null });
    if (b.kind === "delete" && !call(c, "requiresConfirmation")) changes.push({ name: "requiresConfirmation", args: "" });
    ctx.set(changes);
  };
  if (current.kind === "custom" && node) {
    const choose = h("select", {}, h("option", { value: "", textContent: "Replace with…" }), ...BEHAVIORS[a.scope].filter(([k]) => k !== "none").map(([k, l]) => h("option", { value: k, textContent: l })));
    choose.onchange = () => choose.value && void write({ kind: choose.value } as Behavior);
    return [row("What it does", h("div", { class: "fd-stack" }, codeChip(ctx, node), choose), { stacked: true, set: true, reset: () => ctx.set([{ name: "action", args: null }]) })];
  }
  const select = h("select", {}, ...BEHAVIORS[a.scope].map(([k, l]) => h("option", { value: k, textContent: l, selected: k === current.kind })));
  select.onchange = () => {
    const kind = select.value as Behavior["kind"];
    const notify = "notify" in current ? current.notify : undefined;
    if (kind === "set") void write({ kind, column: ctx.columns.find((x) => /status|state|active|published/.test(x)) ?? ctx.columns[0] ?? "status", value: "", notify });
    else void write({ kind, notify } as Behavior);
  };
  const rows = [row("What it does", select, { set: !!node, reset: () => ctx.set([{ name: "action", args: null }, ...(ourFill ? [{ name: "fillForm", args: null }] : [])]), doc: "What happens when the action runs, after its form or confirmation." })];
  if (current.kind === "set") {
    const column = h("select", {}, ...ctx.columns.map((x) => h("option", { value: x, textContent: x, selected: x === current.column })));
    if (!ctx.columns.includes(current.column)) column.prepend(h("option", { value: current.column, textContent: current.column, selected: true }));
    column.onchange = () => void write({ ...current, column: column.value });
    // A column cast to an enum takes one of its cases' values.
    const e = ctx.enums.find((x) => x.class === a.casts[current.column]?.replace(/^\\/, ""));
    const values = e?.cases.filter((k) => k.value !== null).map((k) => [String(k.value), k.name]) ?? [];
    const value = values.length
      ? h("select", {}, ...(values.some(([v]) => v === current.value) ? [] : [h("option", { value: current.value, textContent: current.value || "(choose)", selected: true })]), ...values.map(([v, n]) => h("option", { value: v, textContent: n, selected: v === current.value })))
      : commitInput(current.value, (v) => void write({ ...current, value: v }), { placeholder: "paid, true, 3", className: "fd-mono" });
    if (values.length) (value as HTMLSelectElement).onchange = () => void write({ ...current, value: (value as HTMLSelectElement).value });
    rows.push(row("Column", column), row("Value", value, { doc: e ? `One of ${shortClass(e.class)}'s cases.` : "Numbers, true, false, and null are written as they are; anything else as text." }));
  }
  if (current.kind !== "none" && current.kind !== "custom")
    rows.push(row("Then notify", commitInput(current.notify ?? "", (v) => void write({ ...current, notify: v.trim() || undefined }), { placeholder: "Saved" }), { set: !!current.notify, doc: "A success notification's title, shown after it runs." }));
  return rows;
}

/** Rows for methods that take more than a value: they get an editor of their own. */
function specialRow(ctx: InspectorCtx, m: MethodInfo): HTMLElement | null {
  const c = ctx.comp;
  if (m.name === "toggleable" && classInfo(ctx.cat, c.cls)?.kind === "column") {
    const existing = call(c, "toggleable");
    if (existing && existing.args.items.some((a) => a.name !== "isToggledHiddenByDefault" || a.value.kind !== "bool")) return row("Can be hidden", codeChip(ctx, existing.args.items[0].value), { set: true, reset: () => ctx.set([{ name: "toggleable", args: null }]) });
    const hiddenDefault = !!existing?.args.items.some((a) => a.name === "isToggledHiddenByDefault" && a.value.kind === "bool" && a.value.value);
    const on = !!existing;
    const box = h("input", { type: "checkbox", checked: hiddenDefault, disabled: !on });
    box.onchange = () => ctx.set([{ name: "toggleable", args: box.checked ? "isToggledHiddenByDefault: true" : "" }]);
    return row("Can be hidden", h("div", { class: "fd-inline-editor" }, toggleSwitch(on, (v) => ctx.set([{ name: "toggleable", args: v ? "" : null }])), h("label", { class: "fd-check-label" }, box, "Hidden at first")), { set: on, reset: () => ctx.set([{ name: "toggleable", args: null }]) });
  }
  if (m.name === "unique" && classInfo(ctx.cat, c.cls)?.kind === "field") {
    const existing = call(c, "unique");
    const simple = !existing || existing.args.items.every((a) => a.name === "ignoreRecord" || a.name === "ignorable");
    if (!simple) return row("Unique", codeChip(ctx, existing!.args.items[0].value), { set: true, reset: () => ctx.set([{ name: "unique", args: null }]) });
    const ignore = !!existing?.args.items.some((a) => a.name === "ignoreRecord");
    const box = h("input", { type: "checkbox", checked: ignore || !existing, disabled: !existing });
    box.onchange = () => ctx.set([{ name: "unique", args: box.checked ? "ignoreRecord: true" : "" }]);
    return row("Unique", h("div", { class: "fd-inline-editor" }, toggleSwitch(!!existing, (v) => ctx.set([{ name: "unique", args: v ? "ignoreRecord: true" : null }])), h("label", { class: "fd-check-label", title: "Editing a record doesn't clash with its own value" }, box, "Except this record")), { set: !!existing, reset: () => ctx.set([{ name: "unique", args: null }]) });
  }
  if (m.name === "relationship" && shortClass(c.cls) !== "Select" && shortClass(c.cls) !== "SelectFilter" && shortClass(c.cls) !== "CheckboxList") {
    // A repeater or section saved through a relationship: just its name.
    const existing = call(c, "relationship");
    if (existing && (existing.args.items.length > 1 || (existing.args.items[0] && !textValue(existing.args.items[0].value)))) return row("Relationship", codeChip(ctx, existing.args.items[0].value), { set: true, reset: () => ctx.set([{ name: "relationship", args: null }]) });
    const name = textValue(existing?.args.items[0]?.value)?.text ?? "";
    const select = h("select", {}, h("option", { value: "", textContent: "None" }), ...ctx.relations.map((r) => h("option", { value: r.name, textContent: `${r.name} · ${r.type}`, selected: r.name === name })));
    select.onchange = () => ctx.set([{ name: "relationship", args: select.value ? phpString(select.value) : null }]);
    return row("Relationship", select, { set: !!existing, reset: () => ctx.set([{ name: "relationship", args: null }]) });
  }
  return null;
}

/** The inspector for code the designer doesn't read as a component. */
export function renderCodeInspector(o: { code: string; reveal(): void; remove(): void }): HTMLElement {
  return h(
    "div",
    { class: "fd-inspector-body" },
    h("header", { class: "fd-inspector-head" }, h("span", { class: "codicon codicon-code fd-type-icon" }), h("div", { class: "fd-inspector-title" }, h("strong", {}, "Code"), h("span", { class: "fd-note" }, "The designer keeps this as written."))),
    h("pre", { class: "fd-code-preview" }, o.code.length > 1200 ? `${o.code.slice(0, 1200)}…` : o.code),
    h("div", { class: "fd-inspector-type" }, h("button", { type: "button", onclick: o.reveal }, icon("go-to-file"), "Open in the editor"), h("button", { type: "button", class: "danger", onclick: o.remove }, icon("trash"), "Delete")),
  );
}
