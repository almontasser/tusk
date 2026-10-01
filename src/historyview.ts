// Record history in the designers: the model designer's History section, which stages the model's activity log
// settings until Apply, the resource designer's "Show history on the record's page" setting, and the palette's
// model picker. `src/historygen.ts` reads and writes the code.
import { invoke } from "@tauri-apps/api/core";
import { h, icon } from "./dom";
import * as fapp from "./filamentapp";
import { host } from "./filamentdesigner";
import type { Designer } from "./filamentdesigner";
import { commitInput, segmented, toggleSwitch } from "./filamentpickers";
import { shortClass } from "./filamentschema";
import { defaultSpec, describeChange, type Fields, FLAVORS, type Flavor, HISTORY_RELATIONS, historyEdits, historyManagerFile, type HistoryRead, type HistorySpec, installCommand, readHistory } from "./historygen";
import { type Edit, insertItem, addMember, methodNamed, type OClass, removeItem } from "./phpcode";
import { pick, rank, type Item } from "./palette";
import { errorText, showError } from "./status";
import { composerCommand } from "./toolpaths";
import { toolPath } from "./lsp";
import { shellQuote } from "./runconfig";
import { isAbsolute } from "./platform.ts";

/** What introspect.php's `activity` mode reports: the package's version, its table, and the latest entries. */
export type ActivityInfo = {
  version: 4 | 5 | null;
  published: boolean;
  table: boolean | null;
  entries: { subject: string | number | null; event: string | null; description: string; causer: string | null; at: string | null; attributes: Record<string, unknown> | null; old: Record<string, unknown> | null }[];
  error?: string;
};

/** The model's history as read, the staged settings, and what the package reports. */
export type HistoryState = { text: string; read: HistoryRead; spec: HistorySpec; info: ActivityInfo | null; error: string };

/** Reads a model's history settings from its class, and the package's state. */
export async function loadHistory(root: string, text: string, cls: OClass): Promise<HistoryState> {
  const read = readHistory(text, cls);
  let info: ActivityInfo | null = null;
  let error = "";
  try {
    info = await fapp.activityLog(root, cls.fqn);
  } catch (e) {
    error = errorText(e);
  }
  return { text, read, spec: structuredClone(read.spec), info, error };
}

/** The installed version's classes; version 5 when the package can't say, as new installs get it. */
const flavorOf = (s: HistoryState): Flavor => FLAVORS[s.info?.version ?? 5];

/** The edits Apply makes to the model's class, with classes as `{{Fqn}}`. */
export const historyModelEdits = (text: string, cls: OClass, s: HistoryState): Edit[] => (JSON.stringify(s.spec) === JSON.stringify(s.read.spec) ? [] : historyEdits(text, cls, s.read, s.spec, flavorOf(s)));

/** What Apply changes in the model's history, in words. */
export const historyChanges = (s: HistoryState) => describeChange(s.read.spec, s.spec);

/** Installs the package, publishes its migration and config, and migrates, in a terminal tab. */
async function install(s: HistoryState, done: () => void) {
  const composer = composerCommand(await toolPath("composer/composer.phar")).map(shellQuote).join(" ");
  const line = installCommand(composer, { require: !s.info?.version, publish: !s.info?.published });
  host.openTerminal(s.info?.version ? "Activity log migration" : "Install spatie/laravel-activitylog", ["/bin/sh", "-c", line], () => (fapp.forget(), done()));
}

export type HistoryCardHost = {
  state: HistoryState;
  file: string;
  /** The table's columns, without the primary key. */
  columns: string[];
  fillable: string[];
  hidden: string[];
  keyName: string;
  /** A staged setting changed: the preview catches up. */
  changed(): void;
  render(): void;
  reload(): void;
};

/** The model designer's History section. */
export function historyCard(m: HistoryCardHost): HTMLElement {
  const s = m.state;
  const spec = s.spec;
  const rows: (HTMLElement | null)[] = [];
  const row = (label: string, editor: HTMLElement, help = "") => h("div", { class: "fd-row", title: help }, h("span", { class: "fd-row-label" }, label), h("div", { class: "fd-row-editor" }, editor), h("span", { class: "fd-row-spacer" }));
  const lineOf = (offset: number) => s.text.slice(0, offset).split("\n").length;
  const codeChip = (label: string, offset: number) => h("button", { type: "button", class: "fd-code-chip", onclick: () => host.openAt(m.file, lineOf(offset)) }, icon("code"), h("span", {}, label));
  const set = (f: () => void, redraw = false) => (f(), redraw ? m.render() : m.changed());
  const head = h("h3", {}, icon("history"), "History");
  const section = (...children: (HTMLElement | null)[]) => h("section", { class: "fd-settings-section rh-section" }, head, ...children);

  if (s.error) return section(h("p", { class: "fd-note" }, `Can't read the activity log: ${s.error}`));
  if (!s.info?.version)
    return section(
      h("p", { class: "fd-note" }, "Record history keeps who created, changed, or deleted each record, and what changed. It uses spatie/laravel-activitylog, which isn't installed."),
      h("div", { class: "fd-button-row" }, h("button", { type: "button", class: "primary", onclick: () => void install(s, m.reload) }, icon("cloud-download"), "Install spatie/laravel-activitylog")),
    );
  if (s.info.table === false) rows.push(h("div", { class: "rh-warn" }, icon("warning"), h("span", {}, "The activity_log table doesn't exist yet."), h("button", { type: "button", class: "fd-chip-link", onclick: () => void install(s, m.reload) }, icon("play"), s.info.published ? "Run the migration" : "Publish and run the migration")));

  rows.push(
    row(
      "Record history",
      toggleSwitch(spec.on, (on) =>
        set(() => {
          // Turning it on again keeps the settings the code had; a model without them gets the defaults.
          if (on) Object.assign(spec, s.read.spec.on || s.read.method ? { ...s.read.spec, on: true } : defaultSpec(m.columns, m.hidden, m.keyName));
          else spec.on = false;
        }, true),
      ),
      "Adds the LogsActivity trait and its options to the model.",
    ),
  );
  const method = s.read.method;
  if (spec.on && s.read.custom && method) rows.push(row("Settings", codeChip("Set in getActivitylogOptions()", method.span[0]), "The method is written as code the designer doesn't read."));
  else if (spec.on) {
    const code = (k: "fields" | "except" | "logName" | "description") => s.read.code.includes(k);
    const callAt = (name: string) => s.read.method?.returns[0]?.kind === "chain" ? s.read.method.returns[0].calls.find((c) => c.name === name)?.span[0] ?? method!.span[0] : method?.span[0] ?? 0;
    rows.push(
      row(
        "Records",
        code("fields")
          ? codeChip("Set in code", callAt("logOnly"))
          : segmented<Fields>([["only", "Chosen attributes"], ["fillable", "Fillable"], ["all", "All"], ["none", "Events only"]], spec.fields, (v) =>
              set(() => {
                spec.fields = v;
                if (v === "only" && !spec.only.length) spec.only = defaultSpec(m.columns, m.hidden, m.keyName).only;
                // Hidden attributes, such as passwords, stay out of a log that records everything.
                if (v !== "only" && v !== "none" && !spec.except.length) spec.except = m.hidden.filter((c) => v === "all" || m.fillable.includes(c));
              }, true),
            ),
        "The attributes each entry records, with their old and new values.",
      ),
    );
    // One list of checkboxes: the attributes it records. Outside a chosen list, unchecking one excepts it.
    if (spec.fields !== "none" && !(spec.fields === "only" ? code("fields") : code("except"))) {
      const list = spec.fields === "fillable" ? m.columns.filter((c) => m.fillable.includes(c)) : m.columns;
      const checks = list.map((c) => {
        const box = h("input", { type: "checkbox", checked: spec.fields === "only" ? spec.only.includes(c) : !spec.except.includes(c) });
        box.onchange = () =>
          set(() => {
            const key = spec.fields === "only" ? "only" : "except";
            const want = spec.fields === "only" ? box.checked : !box.checked;
            spec[key] = want ? [...spec[key].filter((x) => x !== c), c].sort((a, b) => list.indexOf(a) - list.indexOf(b)) : spec[key].filter((x) => x !== c);
          });
        return h("label", { title: m.hidden.includes(c) ? "Hidden from arrays and JSON, such as a password" : "" }, box, c, m.hidden.includes(c) ? h("span", { class: "fd-note" }, " · hidden") : null);
      });
      rows.push(h("div", { class: "fd-row stacked" }, h("span", { class: "fd-row-label" }, "Attributes"), h("div", { class: "fd-row-editor fd-checks wrap" }, ...(checks.length ? checks : [h("span", { class: "fd-note" }, "The model has no such attributes.")])), h("span", { class: "fd-row-spacer" })));
    } else if (spec.fields !== "none" && code("except")) rows.push(row("Except", codeChip("Set in code", callAt("logExcept"))));
    rows.push(row("Only changed values", toggleSwitch(spec.dirty, (on) => set(() => (spec.dirty = on))), "An update records the attributes that changed, not all of them."));
    rows.push(row("Skip empty entries", toggleSwitch(spec.skipEmpty, (on) => set(() => (spec.skipEmpty = on))), "No entry when a save changes none of the recorded attributes."));
    rows.push(row("Log name", code("logName") ? codeChip("Set in code", callAt("useLogName")) : commitInput(spec.logName, (v) => set(() => (spec.logName = v.trim())), { placeholder: "default", className: "fd-mono" }), "Entries are grouped by log name, such as posts."));
    rows.push(row("Description", code("description") ? codeChip("Set in code", callAt("setDescriptionForEvent")) : commitInput(spec.description, (v) => set(() => (spec.description = v.trim())), { placeholder: "{event}" }), "What each entry says. {event} is created, updated, or deleted."));
    if (s.read.others.length) rows.push(row("Also in the code", h("div", { class: "fd-checks wrap" }, ...s.read.others.map((c) => codeChip(`${c.name}()`, c.span[0])))));
  }
  return section(h("div", { class: "fd-rows md-rows" }, ...rows), s.read.spec.on ? entriesList(s, m.reload) : null);
}

/** The latest entries for the model's records, to see that logging works. */
function entriesList(s: HistoryState, reload: () => void): HTMLElement | null {
  if (!s.info?.table) return null;
  const show = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const changes = (e: ActivityInfo["entries"][number]) => {
    const keys = [...new Set([...Object.keys(e.attributes ?? {}), ...Object.keys(e.old ?? {})])];
    return keys.map((k) => (e.old && e.attributes && k in e.old && k in e.attributes ? `${k}: ${show(e.old[k])} → ${show(e.attributes[k])}` : `${k}: ${show((e.attributes ?? e.old ?? {})[k])}`)).join(" · ");
  };
  const items = s.info.entries.map((e) =>
    h("li", { class: "rh-entry", title: e.at ?? "" }, h("span", { class: `rh-event ${e.event ?? ""}` }, e.event ?? e.description), h("span", { class: "fd-mono" }, `#${e.subject ?? "?"}`), h("span", { class: "md-muted" }, `${e.causer ?? "System"} · ${e.at ? new Date(e.at).toLocaleString() : ""}`), h("span", { class: "rh-changes" }, e.description !== e.event ? `${e.description}${changes(e) ? " · " : ""}` : "", changes(e))),
  );
  return h(
    "div",
    { class: "rh-entries" },
    h("div", { class: "rh-entries-head" }, h("span", { class: "fd-note" }, "Latest entries"), h("button", { type: "button", class: "fd-chip-link", onclick: reload }, icon("refresh"), "Refresh")),
    items.length ? h("ul", {}, ...items) : h("p", { class: "fd-note" }, "No entries yet. Create or change a record to see one here."),
  );
}

// ---- The resource designer ----

/** The resource designer's setting: a read-only History relation manager under the record's edit or view page. */
export function historySettings(d: Designer): HTMLElement | null {
  const cls = d.cls!;
  const doc = d.docs.get(d.file)!;
  const relation = d.facts?.relations.find((r) => HISTORY_RELATIONS.includes(r.name));
  const method = methodNamed(cls, "getRelations");
  const arr = method?.returns[0]?.kind === "array" ? method.returns[0] : null;
  const index = arr ? arr.items.findIndex((i) => {
    const fqn = i.value.kind === "classConst" ? i.value.class : "";
    const info = d.info?.relations.find((r) => r.class === fqn);
    return info ? HISTORY_RELATIONS.includes(info.relationship ?? "") : shortClass(fqn) === "ActivitiesRelationManager";
  }) : -1;
  const on = index >= 0;
  const model = d.facts?.class ?? d.info?.model;
  const modelFile = d.facts?.details.file ?? d.info?.modelFile ?? null;
  const toggle = toggleSwitch(on, (want) => void (want ? showHistory(d, FLAVORS[relation?.name === FLAVORS[4].relation ? 4 : 5]) : arr && d.apply(doc, () => [removeItem(doc.text, arr, index)], "Removed the history from the record's page. Its relation manager's file stays.")));
  (toggle.querySelector("input") as HTMLInputElement).disabled = !on && (!relation || (!!method && !arr));
  const note = !relation
    ? h("p", { class: "fd-note" }, `${shortClass(model ?? "The model")} doesn't record its history yet. `, modelFile ? h("button", { type: "button", class: "fd-chip-link", onclick: () => void import("./modeldesigner").then((m) => m.openModelDesigner(isAbsolute(modelFile) ? modelFile : `${d.root}/${modelFile}`, "history")) }, icon("history"), "Record history…") : null)
    : h("p", { class: "fd-note" }, "A History list under the edit and view pages: when, who, what happened, and the changed values.");
  return h("section", { class: "fd-settings-section" }, h("h3", {}, icon("history"), "History"), note, h("div", { class: "fd-rows" }, h("div", { class: `fd-row${on ? " set" : ""}` }, h("span", { class: "fd-row-label" }, "Show history on the record's page"), h("div", { class: "fd-row-editor" }, toggle), h("span", { class: "fd-row-spacer" }))));
}

/** Writes the History relation manager next to the resource, unless it's there, and adds it to `getRelations()`. */
async function showHistory(d: Designer, flavor: Flavor) {
  const doc = d.docs.get(d.file)!;
  const cls = d.cls!;
  // Filament 4 keeps a resource in a folder of its own; an older resource sits in Resources/ beside a folder named for it.
  const dir = d.file.replace(/\/[^/]+$/, "");
  const own = /\/Resources$/.test(dir) ? `/${cls.name}` : "";
  const ns = `${doc.outline.namespace ?? "App\\Filament\\Resources"}${own.replace("/", "\\")}\\RelationManagers`;
  const path = `${dir}${own}/RelationManagers/ActivitiesRelationManager.php`;
  try {
    if (!(await invoke<boolean>("path_exists", { path }))) await invoke("create_file", { path, contents: historyManagerFile(ns, flavor) });
  } catch (e) {
    return showError("Can't write the history's relation manager", e);
  }
  const fqn = `${ns}\\ActivitiesRelationManager`;
  const method = methodNamed(cls, "getRelations");
  const arr = method?.returns[0]?.kind === "array" ? method.returns[0] : null;
  await d.apply(doc, (imports) => {
    const name = `${imports.name(fqn)}::class`;
    if (arr) return [insertItem(doc.text, arr, arr.items.length, name)];
    return method ? null : [addMember(doc.text, cls, `public static function getRelations(): array\n{\n    return [\n        ${name},\n    ];\n}`)];
  }, "Added the history to the record's page");
  fapp.forget(["app"]);
  await d.load();
}

// ---- The palette ----

/** Picks a model and opens its History in the model designer. */
export async function openHistoryPicker() {
  const root = host.root();
  const models = await fapp.models(root).catch((e) => (host.status(`Can't read the models: ${errorText(e)}`), null));
  if (!models) return;
  const items: Item[] = Object.values(models).map((m) => ({
    label: shortClass(m.class),
    detail: m.relations.some((r) => HISTORY_RELATIONS.includes(r.name)) ? "Records its history" : m.class,
    icon: "codicon-history",
    run: async () => {
      const file = await fapp.fileOfClass(root, m.class);
      if (file) void import("./modeldesigner").then((x) => x.openModelDesigner(file, "history"));
    },
  }));
  pick("Record history: pick a model", (query) => (query.trim() ? rank(query, items) : items));
}
