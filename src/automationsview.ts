// A model's Automations view: rules such as "when a post's status becomes published, notify its author", read from
// and written to the model's observer (src/automationgen.ts). Each change is saved at once, as in the Access view.
// A new observer is created on the first rule and registered on the model with `#[ObservedBy]`.
import { invoke } from "@tauri-apps/api/core";
import { type Action, type Cond, methodsOf, observedByEdits, observerClass, opFor, type Op, readObserver, type Rule, ruleEdits, slotOf, TRIGGERS, type Trigger, type Value } from "./automationgen";
import { editFiles } from "./codeapply";
import { h, icon, iconButton } from "./dom";
import * as fapp from "./filamentapp";
import { humanize } from "./filamentcatalog";
import { host } from "./filamentdesigner";
import { shortClass } from "./filamentschema";
import { RECIPIENTS, type Recipient, type Send } from "./notifysend";
import { classNamed, type Outline, phpFile } from "./phpcode";
import { pathsFor, psr4From } from "./psr4";
import { errorText, showError } from "./status";
import { showEditorView } from "./terminal";
import { isAbsolute } from "./platform.ts";

const open = new Map<string, AutomationsView>();

/** Opens the Automations view for a model class. */
export function openAutomations(model: string) {
  let v = open.get(model);
  if (!v) open.set(model, (v = new AutomationsView(model)));
  v.show();
}

type Facts = { info: fapp.ObserversInfo; details: fapp.ModelDetails; notifications: fapp.NotificationInfo[]; enums: fapp.EnumInfo[] };
type Doc = { path: string; fqn: string; text: string; outline: Outline };

const OPS: [string, string][] = [
  ["is", "is"],
  ["not", "is not"],
  [">", "is more than"],
  [">=", "is at least"],
  ["<", "is less than"],
  ["<=", "is at most"],
];

class AutomationsView {
  el = h("div", { class: "fd-designer" });
  private facts: Facts | null = null;
  private doc: Doc | null = null;
  private error = "";
  private drafts: Rule[] = [];
  private listening = new Set<string>();

  constructor(private model: string) {}

  private get root() {
    return host.root();
  }
  private get short() {
    return shortClass(this.model);
  }
  /** The record's variable in new methods: the observer's own, or `$post` for Post. */
  private get variable() {
    const cls = this.doc && classNamed(this.doc.outline, this.doc.fqn);
    return cls?.methods.find((m) => m.params[0])?.params[0].name ?? this.short.charAt(0).toLowerCase() + this.short.slice(1);
  }

  /** "a" or "an", before the model's name. */
  private get a() {
    return /^[aeiou]/i.test(this.short) ? "an" : "a";
  }

  show() {
    showEditorView(`${this.short} · Automations`, this.el, "zap", () => open.delete(this.model));
    if (!this.facts) void this.load();
    this.render();
  }

  private async load() {
    try {
      const [info, details, notifications, enums] = await Promise.all([fapp.observers(this.root, this.model), fapp.model(this.root, this.model), fapp.notifications(this.root).catch(() => []), fapp.enums(this.root).catch(() => [])]);
      this.facts = { info, details, notifications, enums };
      // The observer named for the model when the app registers it, or else the first one it registers.
      const own = `App\\Observers\\${this.short}Observer`;
      const primary = info.observers.find((o) => o.class === own) ?? info.observers[0];
      const path = primary?.file ? `${this.root}/${primary.file}` : await this.observerPath(own);
      this.doc = (await invoke<boolean>("path_exists", { path })) ? await this.read(path, primary?.class ?? own) : null;
      this.error = "";
    } catch (e) {
      this.error = errorText(e);
    }
    this.render();
  }

  /** Where an observer class goes, through composer.json's PSR-4 folders. */
  private async observerPath(fqn: string) {
    const json = await invoke<string>("read_file", { path: `${this.root}/composer.json` }).catch(() => "{}");
    return `${this.root}/${pathsFor(fqn, psr4From(json))[0] ?? `app/Observers/${shortClass(fqn)}.php`}`;
  }

  /** The observer's file with its outline, read again whenever it changes in the editor. */
  private async read(path: string, fqn: string): Promise<Doc> {
    const model = await host.ensureModel(path);
    if (!this.listening.has(path)) {
      this.listening.add(path);
      model.onDidChangeContent(() => void this.refresh());
    }
    const text = model.getValue();
    return { path, fqn, text, outline: await fapp.outlineOf(text, path) };
  }

  private async refresh() {
    if (!this.el.isConnected || !this.doc) return;
    this.doc = await this.read(this.doc.path, this.doc.fqn);
    this.render();
  }

  /** Writes rule `from` (or a new one) as `to` (or deletes it), creating and registering the observer when needed. */
  private async write(index: number | null, from: Rule | null, to: Rule | null, message: string) {
    const f = this.facts!;
    try {
      let doc = this.doc;
      const files: Parameters<typeof editFiles>[0] = [];
      if (!doc) {
        const fqn = `App\\Observers\\${this.short}Observer`;
        const path = await this.observerPath(fqn);
        await invoke("create_file", { path, contents: phpFile(fqn.slice(0, fqn.lastIndexOf("\\")), observerClass(shortClass(fqn))) });
        doc = this.doc = await this.read(path, fqn);
        if (f.info.attribute && f.details.file) {
          const modelPath = isAbsolute(f.details.file) ? f.details.file : `${this.root}/${f.details.file}`;
          files.push({ path: modelPath, build: (text, outline) => observedByEdits(text, classNamed(outline, this.model)!, fqn) });
        } else host.status(`Register ${shortClass(fqn)} in a service provider's boot(): ${this.short}::observe(${shortClass(fqn)}::class);`);
      }
      if (doc.outline.errors) return host.status("Fix the syntax errors in the observer first.");
      const fqn = doc.fqn;
      const variable = this.variable;
      files.unshift({
        path: doc.path,
        build: (text, outline, fill) => {
          const cls = classNamed(outline, fqn);
          if (!cls) throw new Error("There's no observer class in the file.");
          // The rule as it is now, which must still be the one the view showed.
          const now = index === null ? null : readObserver(text, outline, cls, variable).rules[index];
          if (index !== null && JSON.stringify(now?.blocks) !== JSON.stringify(from?.blocks)) throw new Error("The observer changed. Try again.");
          return ruleEdits(text, cls, now, to, { variable, modelType: fill(`{{${this.model}}}`), userModel: f.info.user ?? "App\\Models\\User" });
        },
      });
      if (await editFiles(files, message)) {
        if (files.length > 1) fapp.forget([`app:observers:${this.model}`]), await this.load();
      }
    } catch (e) {
      showError("Can't change the automations", e);
    }
  }

  render() {
    const header = h(
      "header",
      { class: "fd-header" },
      h("span", { class: "fd-header-icon" }, icon("zap")),
      h(
        "div",
        { class: "fd-header-titles" },
        h("h1", {}, `${humanize(this.short)}: automations`),
        h(
          "div",
          { class: "fd-header-chips" },
          h("span", { class: "fd-chip-static", title: this.model }, "Model · ", this.short),
          this.doc ? h("button", { type: "button", class: "fd-chip-link", onclick: () => host.openAt(this.doc!.path, 1) }, icon("go-to-file"), shortClass(this.doc.fqn)) : null,
        ),
      ),
      h("span", { class: "fd-spacer" }),
      iconButton("refresh", "Read the observer again", () => (fapp.forget([`app:observers:${this.model}`, `model:${this.model}`, "app:notifications"]), void this.load())),
    );
    this.el.replaceChildren(header, h("div", { class: "fd-access-view" }, this.body()));
  }

  private body(): HTMLElement {
    if (this.error) return h("div", { class: "fd-error" }, icon("warning"), h("div", {}, h("strong", {}, "The designer can't read the model's observers"), h("p", {}, this.error), h("div", { class: "fd-error-actions" }, h("button", { type: "button", onclick: () => void this.load() }, icon("refresh"), "Try again"))));
    if (!this.facts) return h("div", { class: "fd-loading" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), "Reading the observers…");
    const { info } = this.facts;
    const doc = this.doc;
    const cls = doc && classNamed(doc.outline, doc.fqn);
    const read = doc && cls ? readObserver(doc.text, doc.outline, cls, this.variable) : { rules: [], other: [] };
    const plural = `${humanize(this.short).toLowerCase()}s`;
    const notes: HTMLElement[] = [];
    const note = (kind: string, ...children: (Node | string)[]) => notes.push(h("p", { class: "fd-note" }, icon(kind), " ", ...children));
    const link = (label: string, path: string, line = 1) => h("button", { type: "button", class: "fd-chip-link", onclick: () => host.openAt(isAbsolute(path) ? path : `${this.root}/${path}`, line) }, label);
    if (doc?.outline.errors) note("warning", "The observer has syntax errors. Fix them to change it here.");
    const registered = info.observers.find((o) => o.class === doc?.fqn);
    if (doc && !registered) note("warning", `${shortClass(doc.fqn)} isn't registered, so its rules don't run. `, info.attribute ? `Add #[ObservedBy([${shortClass(doc.fqn)}::class])] to ${this.short}, ` : "", `or call ${this.short}::observe(${shortClass(doc.fqn)}::class) in a service provider.`);
    else if (registered && !registered.attribute) note("info", `${shortClass(registered.class)} is registered with observe() in the app's code, which stays as it is.`);
    for (const o of info.observers.filter((o) => o.class !== doc?.fqn)) note("info", `${shortClass(o.class)} also observes ${plural}. `, o.file ? link("Open it", o.file) : "");
    for (const c of info.closures) note("info", `The app also listens for ${plural} being ${c.event} in its own code. `, c.file ? link(`${c.file.split("/").pop()}:${c.line}`, c.file, c.line) : "");
    const rules = [...read.rules.map((r, i) => this.ruleCard(r, i)), ...this.drafts.map((r) => this.ruleCard(r, null))];
    const add = h("button", { type: "button", class: "fd-lane-add" }, icon("add"), "New rule");
    add.onclick = () => (this.drafts.push({ trigger: { kind: "created" }, conds: [], actions: [], blocks: [] }), this.render());
    return h(
      "div",
      { class: "fd-page-tab" },
      h("div", { class: "fd-page-tab-head" }, h("div", {}, h("h2", {}, "Automations"), h("p", { class: "fd-note" }, `What happens when ${plural} are created, changed, or deleted: notify people, or set a field. The rules live in ${doc ? shortClass(doc.fqn) : `${this.short}Observer, created with the first rule`}.`))),
      ...notes,
      ...(rules.length ? rules : [h("div", { class: "fd-access-empty" }, icon("zap"), h("div", {}, h("strong", {}, `No automations for ${plural} yet`), h("p", { class: "fd-note" }, `For example: when ${this.a} ${humanize(this.short).toLowerCase()} is created, notify the admins.`)))]),
      add,
      read.other.length && doc
        ? h(
            "section",
            { class: "au-other" },
            h("h3", {}, icon("code"), "Other code in the observer"),
            h("p", { class: "fd-note" }, "The designer keeps this code as it is. Open it to change it."),
            ...read.other.map((o) => h("button", { type: "button", class: "fd-code-chip", onclick: () => this.reveal(o.span[0]) }, icon("code"), h("span", {}, `${o.method}(): ${doc.text.slice(o.span[0], o.span[1]).split("\n")[0].trim()}`))),
          )
        : null,
    );
  }

  private reveal(offset: number) {
    const before = this.doc!.text.slice(0, offset);
    host.openAt(this.doc!.path, before.split("\n").length, offset - before.lastIndexOf("\n"));
  }

  // ---- A rule ----

  private ruleCard(rule: Rule, index: number | null): HTMLElement {
    const f = this.facts!;
    const set = (next: Rule, message: string) => {
      if (index === null) {
        const i = this.drafts.indexOf(rule);
        // A draft is written once it does something.
        if (!next.actions.length) return (this.drafts[i] = next), this.render();
        this.drafts.splice(i, 1);
        return void this.write(null, null, next, message);
      }
      void this.write(index, rule, next, message);
    };
    const columns = (f.details.columns ?? []).map((c) => c.name).filter((c) => c !== f.details.keyName);
    const t = rule.trigger;
    const kinds = TRIGGERS.filter(([k]) => k !== "restored" || f.details.softDeletes || t.kind === "restored");
    const trigger = h("select", {}, ...kinds.map(([k, l]) => h("option", { value: k, textContent: l, selected: k === t.kind })));
    trigger.onchange = () => {
      const k = trigger.value as Trigger["kind"];
      const field = "field" in t ? t.field : (columns.find((c) => f.details.casts[c] && this.enumOf(c)) ?? columns[0]);
      const next: Trigger = k === "changed" ? { kind: k, field } : k === "becomes" ? { kind: k, field, value: this.defaultValue(field) } : { kind: k };
      if (k === "deleted" && rule.actions.some((a) => a.kind === "set")) return host.status("Remove the Set actions first: a deleted record isn't saved again.");
      set({ ...rule, trigger: next }, `Rule: when a ${this.short} ${trigger.selectedOptions[0].textContent}`);
    };
    const field = t.kind === "changed" || t.kind === "becomes";
    const when: (HTMLElement | string)[] = [h("span", { class: "au-word" }, `When ${this.a}`), h("strong", {}, `${humanize(this.short).toLowerCase()}${field ? "'s" : ""}`)];
    if (t.kind === "changed" || t.kind === "becomes") {
      when.push(this.fieldSelect(t.field, columns, (field) => set({ ...rule, trigger: t.kind === "becomes" ? { kind: "becomes", field, value: this.defaultValue(field) } : { kind: "changed", field } }, `Rule: when ${field} changes`)));
    }
    when.push(trigger);
    if (t.kind === "becomes") when.push(this.valueEditor(t.field, t.value, false, (value) => set({ ...rule, trigger: { ...t, value } }, `Rule: when ${t.field} becomes ${this.describe(value)}`)));
    const conds = rule.conds.map((c, i) => {
      const change = (next: Cond | null) => set({ ...rule, conds: next ? rule.conds.map((x, j) => (j === i ? next : x)) : rule.conds.filter((_, j) => j !== i) }, next ? `Condition: ${next.field}` : "Removed the condition");
      const op = h("select", {}, ...OPS.map(([k, l]) => h("option", { value: k, textContent: l, selected: k === (/^={2,3}$/.test(c.op) ? "is" : /^!==?$/.test(c.op) ? "not" : c.op) })));
      op.onchange = () => change({ ...c, op: op.value === "is" ? opFor(c.value) : op.value === "not" ? opFor(c.value, true) : (op.value as Op) });
      return h(
        "div",
        { class: "au-line" },
        h("span", { class: "au-word" }, i ? "and" : "if"),
        this.fieldSelect(c.field, columns, (field) => change({ field, op: "===", value: this.defaultValue(field) })),
        op,
        this.valueEditor(c.field, c.value, false, (value) => change({ ...c, value, op: /^!/.test(c.op) ? opFor(value, true) : /^=/.test(c.op) ? opFor(value) : c.op })),
        iconButton("close", "Remove the condition", () => change(null)),
      );
    });
    const addCond = h("button", { type: "button", class: "fd-chip-link" }, icon("add"), "Condition");
    addCond.onclick = () => {
      const field = columns[0];
      const value = this.defaultValue(field);
      set({ ...rule, conds: [...rule.conds, { field, op: opFor(value), value }] }, "Added a condition");
    };
    const actions = rule.actions.map((a, i) => this.actionRow(rule, a, i, columns, set));
    const addSend = h("button", { type: "button", class: "fd-chip-link" }, icon("mail"), "Send a notification");
    addSend.onclick = () => {
      const n = this.notifications()[0];
      if (!n) return void this.newNotification(addSend, (cls, withRecord) => set({ ...rule, actions: [...rule.actions, { kind: "send", send: { notification: cls, recipient: { kind: "users" }, withRecord } }] }, "Added a notification"));
      set({ ...rule, actions: [...rule.actions, { kind: "send", send: { notification: n.class, recipient: this.defaultRecipient(), withRecord: n.record === this.model } }] }, `Send ${shortClass(n.class)}`);
    };
    const addSet = t.kind === "deleted" ? null : h("button", { type: "button", class: "fd-chip-link" }, icon("edit"), "Set a field");
    if (addSet) addSet.onclick = () => set({ ...rule, actions: [...rule.actions, { kind: "set", field: columns[0], value: this.defaultValue(columns[0]) }] }, `Set ${columns[0]}`);
    const remove = iconButton("trash", "Delete the rule", () => {
      if (index === null) return (this.drafts.splice(this.drafts.indexOf(rule), 1), this.render());
      if (rule.actions.some((a) => a.kind === "code") && !confirm("The rule has code the designer can't read. Delete it too?")) return;
      void this.write(index, rule, null, "Deleted the rule");
    });
    const { before, after } = methodsOf(t);
    const where = [...new Set(rule.actions.map((a) => (slotOf(a) === "before" && before ? before : after)))].map((m) => `${m}()`).join(" and ");
    return h(
      "section",
      { class: `au-rule${index === null ? " draft" : ""}` },
      h("div", { class: "au-line au-when" }, ...when, h("span", { class: "fd-spacer" }), remove),
      ...conds,
      h("div", { class: "au-then" }, h("span", { class: "au-word" }, "then"), h("div", { class: "au-actions" }, ...actions, h("div", { class: "au-adds" }, addSend, addSet, addCond))),
      h("p", { class: "fd-note" }, index === null ? "Add an action to save the rule." : `In ${where}.${rule.actions.some((a) => a.kind === "set") ? " Fields are set before the save, so they're saved with it." : ""}`),
    );
  }

  private actionRow(rule: Rule, a: Action, i: number, columns: string[], set: (r: Rule, message: string) => void): HTMLElement {
    const change = (next: Action | null, message: string) => set({ ...rule, actions: next ? rule.actions.map((x, j) => (j === i ? next : x)) : rule.actions.filter((_, j) => j !== i) }, message);
    const remove = iconButton("close", "Remove the action", () => {
      if (a.kind === "code" && !confirm("Delete this code?")) return;
      change(null, "Removed the action");
    });
    if (a.kind === "code") return h("div", { class: "au-line" }, h("button", { type: "button", class: "fd-code-chip", title: "Written as code. Open it to change it.", onclick: () => this.reveal(a.span[0]) }, icon("code"), h("span", {}, a.code.split("\n")[0])), h("span", { class: "fd-spacer" }), remove);
    if (a.kind === "set") {
      return h(
        "div",
        { class: "au-line" },
        h("span", { class: "au-word" }, "set"),
        this.fieldSelect(a.field, columns, (field) => change({ kind: "set", field, value: this.defaultValue(field) }, `Set ${field}`)),
        h("span", { class: "au-word" }, "to"),
        this.valueEditor(a.field, a.value, true, (value) => change({ ...a, value }, `Set ${a.field} to ${this.describe(value)}`)),
        h("span", { class: "fd-spacer" }),
        remove,
      );
    }
    return this.sendRow(a.send, (send, message) => change({ kind: "send", send }, message), remove);
  }

  // ---- Notifications ----

  /** The notifications that take this model, or nothing. */
  private notifications() {
    return this.facts!.notifications.filter((n) => !n.record || n.record === this.model);
  }

  private defaultRecipient(): Recipient {
    const related = this.userRelations()[0];
    return related ? { kind: "related", relation: related } : this.facts!.info.roles?.length ? { kind: "role", role: this.facts!.info.roles[0] } : { kind: "users" };
  }

  /** The model's relationships to a single user, such as an order's customer. */
  private userRelations() {
    const user = this.facts!.info.user;
    return this.facts!.details.relations.filter((r) => r.related === user && /^(BelongsTo|HasOne|MorphOne)$/.test(r.type)).map((r) => r.name);
  }

  private sendRow(s: Send, change: (s: Send, message: string) => void, remove: HTMLElement): HTMLElement {
    const f = this.facts!;
    const list = this.notifications();
    const known = list.some((n) => n.class === s.notification);
    const pick = h("select", {}, ...(known ? [] : [h("option", { value: s.notification, textContent: shortClass(s.notification), selected: true })]), ...list.map((n) => h("option", { value: n.class, textContent: shortClass(n.class), selected: n.class === s.notification })), h("option", { value: "+", textContent: "New notification…" }));
    pick.onchange = () => {
      if (pick.value === "+") return void this.newNotification(pick, (cls, withRecord) => change({ ...s, notification: cls, withRecord }, `Send ${shortClass(cls)}`));
      const n = list.find((x) => x.class === pick.value)!;
      change({ ...s, notification: n.class, withRecord: n.record === this.model }, `Send ${shortClass(n.class)}`);
    };
    const r = s.recipient;
    const relations = this.userRelations();
    const kinds = RECIPIENTS.filter(([k]) => k === r.kind || (k === "role" ? f.info.roles !== null : k === "related" ? relations.length > 0 : true));
    const who = h("select", {}, ...kinds.map(([k, l]) => h("option", { value: k, textContent: k === "related" ? `The ${humanize(this.short).toLowerCase()}'s user` : l, selected: k === r.kind })));
    who.onchange = () => {
      const k = who.value as Recipient["kind"];
      const next: Recipient = k === "role" ? { kind: k, role: f.info.roles?.[0] ?? "admin" } : k === "related" ? { kind: k, relation: relations[0] ?? "user" } : k === "address" ? { kind: k, email: "" } : { kind: k };
      if (k === "address") return change({ ...s, recipient: next }, "Send to an email address");
      change({ ...s, recipient: next }, `Send to ${who.selectedOptions[0].textContent?.toLowerCase()}`);
    };
    let detail: HTMLElement | null = null;
    if (r.kind === "role") {
      const id = `au-roles-${Math.random().toString(36).slice(2)}`;
      const input = h("input", { class: "fd-mono", value: r.role, placeholder: "admin", spellcheck: false }) as HTMLInputElement;
      input.setAttribute("list", id);
      input.onchange = () => input.value.trim() && change({ ...s, recipient: { kind: "role", role: input.value.trim() } }, `Send to ${input.value.trim()}`);
      detail = h("span", { class: "fd-access-value" }, input, h("datalist", { id }, ...(f.info.roles ?? []).map((x) => h("option", { value: x }))));
    } else if (r.kind === "related") {
      const sel = h("select", { class: "fd-mono" }, ...[...new Set([r.relation, ...relations])].map((x) => h("option", { value: x, textContent: x, selected: x === r.relation })));
      sel.onchange = () => change({ ...s, recipient: { kind: "related", relation: sel.value } }, `Send to the ${sel.value}`);
      detail = sel;
    } else if (r.kind === "address") {
      const input = h("input", { type: "email", value: r.email, placeholder: "ops@example.com", spellcheck: false }) as HTMLInputElement;
      input.onchange = () => input.value.trim() && change({ ...s, recipient: { kind: "address", email: input.value.trim() } }, `Send to ${input.value.trim()}`);
      detail = input;
    }
    const n = f.notifications.find((x) => x.class === s.notification);
    const notes: HTMLElement[] = [];
    if (f.info.queued.includes(s.notification) && f.info.queue !== "sync") notes.push(h("p", { class: "fd-note" }, icon("info"), ` ${shortClass(s.notification)} is queued, so it's sent only while a queue worker runs: php artisan queue:work.`));
    if (r.kind === "address" && n?.channels && !n.channels.includes("mail")) notes.push(h("p", { class: "fd-note" }, icon("warning"), ` An address gets mail only, and ${shortClass(s.notification)} doesn't send mail.`));
    if (r.kind === "address" && !r.email) notes.push(h("p", { class: "fd-note" }, icon("warning"), " Type the address."));
    return h(
      "div",
      { class: "au-send" },
      h("div", { class: "au-line" }, h("span", { class: "au-word" }, "send"), pick, h("span", { class: "au-word" }, "to"), who, detail, h("span", { class: "fd-spacer" }), n?.file ? iconButton("go-to-file", "Open the notification", () => host.openAt(`${this.root}/${n.file}`, 1)) : null, remove),
      ...notes,
    );
  }

  /** Makes a notification in the Notifications designer, then hands its class, and whether it takes this model, to `then`. */
  private async newNotification(anchor: HTMLElement, then: (cls: string, withRecord: boolean) => void) {
    const m = await import("./notifydesigner");
    await m.newNotification(anchor, {
      model: this.model,
      then: (cls, record) => void fapp.notifications(this.root).then((list) => {
        this.facts!.notifications = list;
        then(cls, record === this.model);
      }),
    });
  }

  // ---- Fields and values ----

  private fieldSelect(field: string, columns: string[], change: (field: string) => void): HTMLSelectElement {
    const sel = h("select", { class: "fd-mono" }, ...[...new Set([field, ...columns])].map((c) => h("option", { value: c, textContent: c, selected: c === field })));
    sel.onchange = () => change(sel.value);
    return sel;
  }

  private column(field: string) {
    return this.facts!.details.columns?.find((c) => c.name === field);
  }

  private enumOf(field: string) {
    const cast = this.facts!.details.casts[field];
    return cast ? this.facts!.enums.find((e) => e.class === cast.replace(/^\\/, "").replace(/:.*$/, "")) : undefined;
  }

  private kindOf(field: string): "enum" | "bool" | "date" | "number" | "text" {
    const cast = this.facts!.details.casts[field] ?? "";
    const type = this.column(field)?.type ?? "";
    if (this.enumOf(field)) return "enum";
    if (/^bool/.test(cast) || /^(bool|boolean|tinyint)$/.test(type)) return "bool";
    if (/date|time/.test(cast) || /date|time/.test(type)) return "date";
    if (/^(int|integer|float|double|decimal|real)/.test(cast) || /int|decimal|numeric|float|double|real/.test(type)) return "number";
    return "text";
  }

  private defaultValue(field: string): Value {
    const e = this.enumOf(field);
    if (e?.cases[0]) return { kind: "case", enum: e.class, case: e.cases[0].name };
    const kind = this.kindOf(field);
    return kind === "bool" ? { kind: "bool", value: true } : kind === "date" ? { kind: "now" } : kind === "number" ? { kind: "number", value: 0 } : { kind: "string", value: "" };
  }

  private describe(v: Value): string {
    return v.kind === "case" ? v.case : v.kind === "now" ? "now" : v.kind === "user" ? "the signed-in user" : v.kind === "null" ? "empty" : String(v.value);
  }

  /** A value for a field: an enum's cases, yes or no, now, the signed-in user, empty, or a typed value. */
  private valueEditor(field: string, v: Value, setting: boolean, change: (v: Value) => void): HTMLElement {
    const kind = this.kindOf(field);
    const nullable = this.column(field)?.nullable ?? true;
    const options: [string, string, Value][] = [];
    const e = this.enumOf(field);
    if (e) for (const c of e.cases) options.push([`case:${c.name}`, c.name, { kind: "case", enum: e.class, case: c.name }]);
    if (kind === "bool") options.push(["true", "yes (true)", { kind: "bool", value: true }], ["false", "no (false)", { kind: "bool", value: false }]);
    if (kind === "date" && setting) options.push(["now", "now", { kind: "now" }]);
    if (setting && /_(id|by)$/.test(field)) options.push(["user", "the signed-in user", { kind: "user" }]);
    if (nullable) options.push(["null", "empty (null)", { kind: "null" }]);
    const typed = kind !== "enum" && kind !== "bool";
    const keyOf = (x: Value) => (x.kind === "case" ? `case:${x.case}` : x.kind === "bool" ? String(x.value) : x.kind === "string" || x.kind === "number" ? "typed" : x.kind);
    const current = keyOf(v);
    const choices: [string, string][] = [...(typed ? [["typed", "a value"] as [string, string]] : []), ...options.map(([k, l]) => [k, l] as [string, string])];
    if (!choices.some(([k]) => k === current)) choices.unshift([current, this.describe(v)]);
    const input = h("input", { class: "fd-mono", type: kind === "number" ? "number" : "text", value: v.kind === "string" || v.kind === "number" ? String(v.value) : "", spellcheck: false, placeholder: kind === "date" ? "2026-01-31" : "" }) as HTMLInputElement;
    input.onchange = () => change(kind === "number" && input.value.trim() !== "" ? { kind: "number", value: Number(input.value) } : { kind: "string", value: input.value });
    input.onkeydown = (ev) => ev.key === "Enter" && input.blur();
    if (choices.length === 1 && current === "typed") return input;
    const sel = h("select", {}, ...choices.map(([k, l]) => h("option", { value: k, textContent: l, selected: k === current })));
    sel.onchange = () => (sel.value === "typed" ? change(kind === "number" ? { kind: "number", value: 0 } : { kind: "string", value: "" }) : change(options.find(([k]) => k === sel.value)![2]));
    return h("span", { class: "au-value" }, sel, current === "typed" ? input : null);
  }
}

/** Picks a model and opens its Automations view. */
export async function openAutomationsPicker() {
  const models = await fapp.models(host.root()).catch((e) => (host.status(`Can't read the models: ${errorText(e)}`), null));
  if (!models) return;
  const { pick, rank } = await import("./palette");
  const items = Object.values(models).map((m) => ({ label: shortClass(m.class), detail: m.class, icon: "codicon-zap", run: () => openAutomations(m.class) }));
  pick("Automations: pick a model", (query) => (query.trim() ? rank(query, items) : items));
}
