// The notifications designer: a notification class's channels, the bell notification Filament shows in the panel,
// and the email, changed in the class's code as you go (src/notifygen.ts), with a preview of both filled with sample
// values. It also says what sending needs (the notifications table, the panel's bell, a mailer), and makes new
// notifications. Action buttons send them through src/notifysend.ts.
import { invoke } from "@tauri-apps/api/core";
import { editFiles } from "./codeapply";
import { h, icon, iconButton, redraw } from "./dom";
import * as fapp from "./filamentapp";
import { type Catalog, humanize } from "./filamentcatalog";
import { host } from "./filamentdesigner";
import { titleAttribute } from "./filamentgen";
import { iconNameOf } from "./filamentinspector";
import { COLOR_SWATCH, commitInput, heroicon, pickHeroicon, popover, toggleSwitch } from "./filamentpickers";
import { shortClass } from "./filamentschema";
import {
  addButtonEdits,
  addChannelMethod,
  addLineEdits,
  type BellRead,
  bellCallEdits,
  buttonCallEdits,
  type ButtonRead,
  CHANNELS,
  channelEdits,
  fillText,
  HEROICON,
  type MailRead,
  mailCallEdits,
  notificationFile,
  readBell,
  readChannels,
  readMail,
  recordOf,
  removeButtonEdits,
  removeLineEdits,
  sampleValue,
  type Slot,
  STATUSES,
  statusEdits,
  type Target,
  targetCode,
  type Text,
  textCode,
} from "./notifygen";
import { RECIPIENTS, type Recipient, sendCode } from "./notifysend";
import { pick, rank, type Item } from "./palette";
import { panelChains, SETTINGS, settingEdits } from "./panelgen";
import { methodNamed, type Edit, type OClass, type Outline, type PCall, type PNode, replaceNode } from "./phpcode";
import { errorText, showError } from "./status";
import { showEditorView } from "./terminal";

const open = new Map<string, NotificationDesigner>();
/** Mailers that don't deliver: `log` writes emails to the log, and `array` keeps them in memory. */
const NOT_DELIVERED = new Set(["log", "array"]);
/** The icon and color Filament gives each status. */
const STATUS_LOOK: Record<string, [string, string]> = { success: ["o-check-circle", "#22c55e"], danger: ["o-x-circle", "#ef4444"], warning: ["o-exclamation-circle", "#f59e0b"], info: ["o-information-circle", "#3b82f6"] };

/** Opens a notification class in the designer. */
export function openNotification(file: string) {
  let v = open.get(file);
  if (!v) open.set(file, (v = new NotificationDesigner(file)));
  v.show();
}

/** Opens a notification by its class name. */
export async function openNotificationClass(fqn: string) {
  const file = await fapp.fileOfClass(host.root(), fqn);
  if (file) openNotification(file);
  else host.status(`Can't find ${shortClass(fqn)}'s file.`);
}

/** Picks a notification to open, or makes a new one. */
export async function openNotificationPicker() {
  const root = host.root();
  const list = await fapp.notifications(root).catch((e) => (host.status(`Can't read the notifications: ${errorText(e)}`), null));
  if (!list) return;
  const items: Item[] = list
    .filter((n) => n.file && !n.file.startsWith("vendor/"))
    .map((n) => ({ label: shortClass(n.class), detail: [n.record ? `About ${shortClass(n.record)}` : "No record", ...(n.channels ?? [])].join(" · "), icon: "codicon-bell", run: () => openNotification(`${root}/${n.file}`) }));
  items.push({ label: "New Notification…", detail: "A bell notification and an email", icon: "codicon-add", run: () => newNotification({ x: innerWidth / 2 - 160, y: 120 }) });
  pick("Open a notification in the designer", (query) => (query.trim() ? rank(query, items) : items));
}

/**
 * Asks for a new notification's name, the model it's about, and its channels, writes it in app/Notifications with a
 * title and a button that opens the record, and opens it. `then` gets the new class and its record's model.
 */
export async function newNotification(anchor: HTMLElement | { x: number; y: number }, o: { model?: string | null; then?: (fqn: string, record: string | null) => void } = {}) {
  const root = host.root();
  const [models, app] = await Promise.all([fapp.models(root).catch(() => ({}) as Record<string, fapp.ModelSummary>), fapp.app(root).catch(() => null)]);
  const name = h("input", { placeholder: "OrderShipped", spellcheck: false });
  const model = h("select", {}, h("option", { value: "", textContent: "No record, such as a weekly report" }), ...Object.keys(models).map((m) => h("option", { value: m, textContent: shortClass(m), selected: m === o.model })));
  const bell = h("input", { type: "checkbox", checked: true });
  const mail = h("input", { type: "checkbox", checked: true });
  const problem = h("p", { class: "fd-ask-problem" });
  const create = async () => {
    const n = name.value.trim().replace(/\.php$/, "");
    if (!/^[A-Z][A-Za-z0-9]*$/.test(n)) return void (problem.textContent = "A class name, such as OrderShipped.");
    const channels = [...(bell.checked ? ["database"] : []), ...(mail.checked ? ["mail"] : [])];
    if (!channels.length) return void (problem.textContent = "Pick the bell, email, or both.");
    const path = `${root}/app/Notifications/${n}.php`;
    if (await invoke<boolean>("path_exists", { path })) return void (problem.textContent = `${n}.php already exists.`);
    const m = model.value || null;
    const summary = m ? models[m] : null;
    const title = summary ? `${humanize(n)}: {${titleAttribute(Object.keys(summary.columns), fapp.typesOf(summary))}}` : humanize(n);
    // A button that opens the record, on its resource's view page, or its edit page.
    const resource = m ? app?.panels.flatMap((p) => p.resources).find((r) => r.model === m) : undefined;
    const page = resource?.pages.find((p) => p.kind === "view") ?? resource?.pages.find((p) => p.kind === "edit");
    const target: Target | null = resource && page ? { kind: "page", resource: resource.class, page: page.kind } : null;
    try {
      await invoke("create_file", { path, contents: notificationFile({ namespace: "App\\Notifications", name: n, record: m, channels, title: { template: title, translated: false }, body: null, target, label: m ? `View ${humanize(shortClass(m)).toLowerCase()}` : "Open" }) });
      fapp.forget(["app"]);
      host.status(`Created ${n}.`);
      p.close();
      o.then?.(`App\\Notifications\\${n}`, m);
      openNotification(path);
    } catch (e) {
      showError("Can't create the notification", e);
    }
  };
  name.onkeydown = (e) => e.key === "Enter" && void create();
  const check = (box: HTMLInputElement, label: string) => h("label", { class: "fd-check-label" }, box, label);
  const p = popover(
    anchor,
    h(
      "div",
      { class: "fd-ask db-new" },
      h("label", { class: "fd-ask-title" }, "New notification"),
      h("label", { class: "fd-note" }, "Class name"),
      name,
      h("label", { class: "fd-note" }, "About"),
      model,
      h("label", { class: "fd-note" }, "Sent to"),
      h("div", { class: "wd-inline" }, check(bell, "The panel's bell"), check(mail, "Email")),
      problem,
      h("div", { class: "fd-ask-buttons" }, h("button", { type: "button", textContent: "Cancel", onclick: () => p.close() }), h("button", { type: "button", class: "primary", textContent: "Create", onclick: () => void create() })),
    ),
  );
  requestAnimationFrame(() => name.focus());
}

type Doc = { text: string; outline: Outline; cls: OClass };

class NotificationDesigner {
  el = h("div", { class: "md-designer nd-designer" });
  private doc: Doc | null = null;
  private listening = false;
  private info: fapp.NotificationInfo | null = null;
  private setup: fapp.NotificationSetup | null = null;
  private app: fapp.AppInfo | null = null;
  private models: Record<string, fapp.ModelSummary> = {};
  private cat: Catalog | null = null;
  /** Who the "Send it" code sends to; only the snippet uses it. */
  private recipient: Recipient = { kind: "users" };

  constructor(private file: string) {}

  private get root() {
    return host.root();
  }

  show() {
    showEditorView(`${this.file.split("/").pop()!.replace(/\.php$/, "")} · Notification`, this.el, "bell", () => open.delete(this.file));
    if (!this.doc) void this.load();
    this.render();
  }

  private async load() {
    await this.read();
    const root = this.root;
    const [list, setup, app, models, cat] = await Promise.all([
      fapp.notifications(root).catch(() => []),
      fapp.notificationSetup(root).catch(() => null),
      fapp.app(root).catch(() => null),
      fapp.models(root).catch(() => ({})),
      fapp.catalog(root).catch(() => null),
    ]);
    this.info = list.find((n) => n.class === this.doc?.cls.fqn) ?? null;
    this.setup = setup;
    this.app = app;
    this.models = models;
    this.cat = cat;
    this.render();
  }

  /** Reads what sending needs again, after fixing something. */
  private recheck() {
    fapp.forget(["app:notification-setup"]);
    void fapp.notificationSetup(this.root).then((s) => ((this.setup = s), this.render()), () => {});
  }

  private async read() {
    const model = await host.ensureModel(this.file);
    if (!this.listening) {
      this.listening = true;
      model.onDidChangeContent(() => void this.read().then(() => this.el.isConnected && this.render()));
    }
    const text = model.getValue();
    const outline = await fapp.outlineOf(text, this.file);
    const cls = outline.classes.find((c) => c.name);
    this.doc = cls ? { text, outline, cls } : null;
  }

  /** Applies edits computed from the class's current code. */
  private edit(build: (text: string, cls: OClass) => Edit[], message: string) {
    return editFiles([{ path: this.file, build: (text, outline) => {
      const cls = outline.classes.find((c) => c.name);
      return cls ? build(text, cls) : null;
    } }], message);
  }

  /** The record's property, such as `$this->record`, or null when the notification isn't about a record. */
  private rec(cls: OClass) {
    return recordOf(cls);
  }

  /** The record's model, from the app, or the constructor's type as the file imports it. */
  private get recordModel(): string | null {
    if (this.info) return this.info.record;
    const p = this.doc && methodNamed(this.doc.cls, "__construct")?.params[0];
    const type = p?.type?.replace(/^\?/, "");
    if (!type) return null;
    const use = this.doc!.outline.uses.find((u) => u.alias === type);
    return use?.name ?? type;
  }

  private reveal(offset: number) {
    const lines = this.doc!.text.slice(0, offset).split("\n");
    host.openAt(this.file, lines.length, lines[lines.length - 1].length + 1);
  }

  render() {
    const d = this.doc;
    const name = this.file.split("/").pop()!.replace(/\.php$/, "");
    const model = this.recordModel;
    const header = h(
      "header",
      { class: "fd-header" },
      h("span", { class: "fd-header-icon" }, icon("bell")),
      h(
        "div",
        { class: "fd-header-titles" },
        h("h1", {}, humanize(name)),
        h(
          "div",
          { class: "fd-header-chips" },
          h("span", { class: "fd-chip-static" }, "Notification"),
          model ? h("span", { class: "fd-chip-static", title: "The record it's about" }, icon("database"), shortClass(model)) : h("span", { class: "fd-chip-static" }, "No record"),
          h("button", { type: "button", class: "fd-chip-link", onclick: () => host.openAt(this.file, 1) }, icon("go-to-file"), `${name}.php`),
        ),
      ),
      h("span", { class: "fd-spacer" }),
      iconButton("refresh", "Check again", () => (fapp.forget(["app:notification"]), void this.load())),
    );
    if (!d) return void redraw(this.el, header, h("div", { class: "fd-loading" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), "Reading the notification…"));
    if (d.outline.errors) return void redraw(this.el, header, h("div", { class: "md-main" }, h("div", { class: "fd-helper-note fd-error-note" }, icon("warning"), h("span", {}, "The notification has syntax errors. Fix them to design it here."))));
    const rec = this.rec(d.cls);
    const ch = readChannels(d.cls);
    const channels = "channels" in ch ? ch.channels : null;
    const bell = readBell(d.text, d.cls, rec);
    const mail = readMail(d.text, d.cls, rec);
    const main = h("div", { class: "md-main" }, this.needs(d, channels), this.channelsSection(d, ch));
    if (!channels || channels.includes("database")) main.append(this.bellSection(d, bell, rec, !!channels));
    if (!channels || channels.includes("mail")) main.append(this.mailSection(d, mail, rec, !!channels));
    main.append(this.sendSection(d));
    const preview = h("aside", { class: "ps-preview" }, h("div", { class: "ps-preview-head" }, h("strong", {}, "Preview")));
    if (bell && !("code" in bell) && (!channels || channels.includes("database"))) preview.append(this.bellPreview(bell));
    if (mail && !("code" in mail) && (!channels || channels.includes("mail"))) preview.append(this.mailPreview(mail));
    preview.append(h("p", { class: "fd-note" }, model ? `Sample values stand in for the ${humanize(shortClass(model)).toLowerCase()}'s fields.` : "The notification isn't about a record."));
    redraw(this.el, header, h("div", { class: "md-body" }, main, preview));
  }

  // ---- What it needs ----

  private needs(d: Doc, channels: string[] | null): HTMLElement | null {
    const s = this.setup;
    if (!s) return null;
    const notes: HTMLElement[] = [];
    const bell = !channels || channels.includes("database");
    if (bell && s.table === false)
      notes.push(
        h(
          "div",
          { class: "fd-helper-note fd-error-note" },
          icon("warning"),
          h("span", {}, "The bell keeps notifications in the notifications table, which the database doesn't have. "),
          h("button", { type: "button", class: "fd-chip-link", onclick: () => host.openTerminal("Notifications table", ["/bin/sh", "-c", "php artisan make:notifications-table && php artisan migrate"], () => this.recheck()) }, "Create it"),
        ),
      );
    const panels = Object.entries(s.panels ?? {});
    if (bell && panels.length && !panels.some(([, on]) => on)) {
      const providers = (this.app?.panels ?? []).filter((p) => p.provider?.file);
      notes.push(
        h(
          "div",
          { class: "fd-helper-note fd-error-note" },
          icon("warning"),
          h("span", {}, "No panel shows the bell, so nobody sees these notifications. "),
          ...providers.map((p) => h("button", { type: "button", class: "fd-chip-link", onclick: () => void this.turnOnBell(p) }, `Turn it on in ${p.id}`)),
        ),
      );
    }
    if ((!channels || channels.includes("mail")) && (!s.mailer || NOT_DELIVERED.has(s.mailer)))
      notes.push(
        h(
          "div",
          { class: "fd-helper-note" },
          icon("info"),
          h("span", {}, s.mailer === "log" ? "Emails go to the log (storage/logs), not to people: the app's mailer is log. Choose a mailer that delivers them in the mail settings. " : `Emails aren't delivered: the app's mailer is ${s.mailer ?? "not set"}. Choose one in the mail settings. `),
          h("button", { type: "button", class: "fd-chip-link", onclick: () => this.openEnv() }, "Mail settings"),
        ),
      );
    if (d.cls.implements.some((i) => /(^|\\)ShouldQueue$/.test(i)) && s.queue && s.queue !== "sync") notes.push(h("p", { class: "fd-note" }, icon("info"), ` It's sent on the ${s.queue} queue, so a worker must be running: php artisan queue:work.`));
    return notes.length ? h("section", { class: "fd-settings-section" }, h("h3", {}, icon("checklist"), "What it needs"), ...notes) : null;
  }

  /** Adds `->databaseNotifications()` to a panel's provider, as Panel settings writes it. */
  private async turnOnBell(panel: fapp.PanelInfo) {
    const file = panel.provider!.file!;
    const path = file.startsWith("/") ? file : `${this.root}/${file}`;
    const setting = SETTINGS.find((x) => x.call === "databaseNotifications")!;
    const changed = await editFiles([{ path, build: (text, outline) => {
      const method = outline.classes.flatMap((c) => c.methods).find((m) => m.name === "panel");
      return method ? settingEdits(text, panelChains(method), setting, true) : null;
    } }], `The bell is on in ${panel.id}`);
    if (changed) this.recheck();
  }

  private openEnv() {
    void import("./envsettings").then((m) => m.openEnvSettings("mail"));
  }

  // ---- Channels ----

  private channelsSection(d: Doc, ch: ReturnType<typeof readChannels>): HTMLElement {
    const section = h("section", { class: "fd-settings-section fd-settings" }, h("h3", {}, icon("broadcast"), "Sent to"));
    if (!("channels" in ch)) {
      const via = methodNamed(d.cls, "via");
      section.append(h("p", { class: "fd-note" }, "via() decides the channels in code."), via ? this.codeChip(d, ch.code ?? null, via.span[0]) : h("p", { class: "fd-note" }, "The class has no via() method."));
      return section;
    }
    const title = humanize(d.cls.name);
    const rows = CHANNELS.map(([c, label]) => this.row(label, toggleSwitch(ch.channels.includes(c), (on) => void this.edit((text, cls) => {
      const now = readChannels(cls);
      return "arr" in now ? channelEdits(text, cls, now.arr, c, on, title) : [];
    }, `${label} ${on ? "on" : "off"}`))));
    const others = ch.channels.filter((c) => !CHANNELS.some(([k]) => k === c));
    if (others.length) rows.push(this.row("Also", h("span", { class: "fd-note" }, others.join(", "))));
    section.append(h("div", { class: "fd-rows" }, ...rows));
    return section;
  }

  // ---- Shared editors ----

  private row(label: string, editor: HTMLElement | null, hint = "") {
    return h("div", { class: "fd-row", title: hint }, h("span", { class: "fd-row-label" }, label), h("div", { class: "fd-row-editor" }, editor), h("span", { class: "fd-row-spacer" }));
  }

  private codeChip(d: Doc, node: PNode | PCall | null, at?: number) {
    const span = node ? node.span : [at ?? 0, at ?? 0];
    const code = node ? d.text.slice(span[0], span[1]).replace(/\s+/g, " ") : "Open the code";
    return h("button", { type: "button", class: "fd-code-chip", title: "Written as code. Open it to change it.", onclick: () => this.reveal(span[0]) }, icon("code"), h("span", {}, code.length > 70 ? `${code.slice(0, 70)}…` : code));
  }

  /** The record's fields a text can name, with relationships' title columns as `customer.name`. */
  private fields(): string[] {
    const m = this.recordModel;
    const info = m ? this.models[m] : null;
    if (!info) return [];
    const own = Object.keys(info.columns).filter((c) => !/^(password|remember_token)$|token|secret/.test(c));
    const related = info.relations.filter((r) => /belongsto/i.test(r.type) && r.related && this.models[r.related]).map((r) => `${r.name}.${titleAttribute(Object.keys(this.models[r.related!].columns), fapp.typesOf(this.models[r.related!]))}`);
    return [...own, ...related];
  }

  /**
   * A text with the record's fields: an input and a menu that inserts a field as `{column}`. `set` gets the new code,
   * or null when it's emptied and `optional`. Text written as code shows as a chip.
   */
  private textEditor(d: Doc, s: Slot, rec: string | null, set: (code: string | null) => void, o: { optional?: boolean; placeholder?: string } = {}): HTMLElement {
    if (s.node && !s.text) return this.codeChip(d, s.node);
    const translated = s.text?.translated ?? false;
    const commit = (v: string) => {
      if (!v.trim()) return o.optional ? set(null) : undefined;
      set(textCode({ template: v, translated }, rec));
    };
    const input = commitInput(s.text?.template ?? "", commit, { placeholder: o.placeholder ?? "" });
    const fields = rec ? this.fields() : [];
    if (!fields.length) return input;
    const add = h("select", { class: "nd-field-menu", title: "Insert one of the record's fields" }, h("option", { value: "", textContent: "+ Field" }), ...fields.map((f) => h("option", { value: f, textContent: f })));
    add.onchange = () => {
      const at = input.selectionStart ?? input.value.length;
      input.value = `${input.value.slice(0, at)}{${add.value}}${input.value.slice(input.selectionEnd ?? at)}`;
      add.value = "";
      commit(input.value);
    };
    return h("div", { class: "wd-inline nd-text" }, input, add);
  }

  /** Where a button goes: a page of a resource, or a URL. */
  private targetEditor(d: Doc, node: PNode | null, target: Target | null, rec: string | null, set: (code: string) => void): HTMLElement {
    if (node && !target) return this.codeChip(d, node);
    const model = this.recordModel;
    const resources = (this.app?.panels ?? []).flatMap((p) => p.resources);
    const options: [string, string][] = [];
    if (rec)
      for (const r of resources.filter((x) => x.model === model))
        for (const p of r.pages.filter((x) => x.kind === "view" || x.kind === "edit")) options.push([`page|${r.class}|${p.kind}`, `The record's ${p.kind} page (${shortClass(r.class)})`]);
    for (const r of resources) options.push([`page|${r.class}|index`, `${r.navigationLabel ?? r.pluralLabel ?? shortClass(r.class)} list`]);
    options.push(["url", "A web address…"]);
    const current = !target ? "" : target.kind === "url" ? "url" : `page|${target.resource}|${target.page}`;
    const select = h("select", {}, ...(target ? [] : [h("option", { value: "", textContent: "Nowhere yet", selected: true })]), ...options.map(([v, l]) => h("option", { value: v, textContent: l, selected: v === current })));
    if (current && !options.some(([v]) => v === current)) select.append(h("option", { value: current, textContent: target?.kind === "page" ? `${shortClass(target.resource)} ${target.page}` : current, selected: true }));
    const url = commitInput(target?.kind === "url" ? target.url : "", (v) => v.trim() && set(targetCode({ kind: "url", url: v.trim() }, rec)), { placeholder: "https://example.com/help" });
    url.hidden = current !== "url";
    select.onchange = () => {
      if (select.value === "url") return void ((url.hidden = false), url.focus());
      const [, resource, page] = select.value.split("|");
      set(targetCode({ kind: "page", resource, page }, rec));
    };
    return h("div", { class: "fd-stack" }, select, url);
  }

  private others(d: Doc, calls: PCall[]): HTMLElement | null {
    return calls.length ? this.row("Also", h("div", { class: "fd-stack" }, ...calls.map((c) => this.codeChip(d, c))), "Calls the designer doesn't write. They stay as they are.") : null;
  }

  // ---- The bell ----

  private bellSection(d: Doc, bell: ReturnType<typeof readBell>, rec: string | null, listed: boolean): HTMLElement {
    const section = h("section", { class: "fd-settings-section fd-settings" }, h("h3", {}, icon("bell"), "In the panel's bell"));
    if (!bell) {
      if (listed) section.append(h("p", { class: "fd-note" }, "The class has no toDatabase() method yet."), h("button", { type: "button", onclick: () => void this.edit((t, cls) => addChannelMethod(t, cls, "database", humanize(cls.name)), "Added the bell notification") }, icon("add"), "Add it"));
      else section.append(h("p", { class: "fd-note" }, "The class doesn't make a bell notification."));
      return section;
    }
    if ("code" in bell) return section.append(h("p", { class: "fd-note" }, "toDatabase() returns something other than a Filament notification, so the designer can't read it."), this.codeChip(d, null, bell.code.span[0])), section;
    const withBell = (build: (t: string, b: BellRead, rec: string | null) => Edit[], message: string) =>
      void this.edit((t, cls) => {
        const r = this.rec(cls);
        const b = readBell(t, cls, r);
        return b && !("code" in b) ? build(t, b, r) : [];
      }, message);
    const call = (name: string, message: string) => (code: string | null) => withBell((t, b) => bellCallEdits(t, b, name, code), message);
    const iconBtn = h("button", { type: "button", class: "icon-button", title: "Choose an icon" }, bell.icon ? heroicon(this.cat?.heroiconsDir ?? null, iconNameOf(bell.icon)) : icon("circle-large-outline"));
    iconBtn.onclick = async () => {
      const chosen = await pickHeroicon(iconBtn, { dir: this.cat?.heroiconsDir ?? null, cases: this.cat?.heroicons ?? [], current: iconNameOf(bell.icon ?? undefined) });
      if (chosen !== null) call("icon", "Icon changed")(chosen ? `{{${HEROICON}}}::${chosen}` : null);
    };
    const status = bell.status === null ? this.codeChip(d, [...bell.chain.calls].reverse().find((c) => c.name === "status") ?? null) : h("select", {}, ...STATUSES.map(([v, l]) => h("option", { value: v, textContent: l, selected: v === bell.status })));
    if (status instanceof HTMLSelectElement) status.onchange = () => withBell((t, b) => statusEdits(t, b, status.value), `Status: ${status.value || "none"}`);
    section.append(
      h(
        "div",
        { class: "fd-rows" },
        this.row("Title", this.textEditor(d, bell.title, rec, (c) => c && call("title", "Title changed")(c), { placeholder: "Order shipped" })),
        this.row("Body", this.textEditor(d, bell.body, rec, call("body", "Body changed"), { optional: true, placeholder: "More about it, optional" })),
        this.row("Icon", iconBtn, "Without one, the status's icon shows."),
        this.row("Status", status, "Colors the icon, and gives one when there's none."),
        this.others(d, bell.other),
      ),
      this.buttonsSection(d, bell, rec, withBell),
    );
    return section;
  }

  private buttonsSection(d: Doc, bell: BellRead, rec: string | null, withBell: (build: (t: string, b: BellRead, rec: string | null) => Edit[], message: string) => void): HTMLElement {
    const head = h("div", { class: "nd-sub" }, h("strong", {}, "Buttons"), h("span", { class: "fd-spacer" }));
    if (bell.actions && "code" in bell.actions) return h("div", {}, head, this.codeChip(d, bell.actions.code));
    const buttons = bell.actions?.buttons ?? [];
    const add = h("button", { type: "button", class: "md-add" }, icon("add"), "Add button");
    add.onclick = () => {
      const names = new Set(buttons.map((b) => b.name));
      let name = "view";
      for (let i = 2; names.has(name); i++) name = `view${i}`;
      const model = this.recordModel;
      const r = (this.app?.panels ?? []).flatMap((p) => p.resources).find((x) => x.model === model);
      const page = r?.pages.find((p) => p.kind === "view") ?? r?.pages.find((p) => p.kind === "edit");
      const target: Target | null = rec && r && page ? { kind: "page", resource: r.class, page: page.kind } : null;
      withBell((t, b, rc) => addButtonEdits(t, b, { name, label: { template: "View", translated: false }, target, markAsRead: true }, rc), "Added a button");
    };
    head.append(add);
    const withButton = (index: number, build: (t: string, b: ButtonRead, rec: string | null) => Edit[], message: string) =>
      withBell((t, b, rc) => {
        const btn = b.actions && "buttons" in b.actions ? b.actions.buttons[index] : undefined;
        return btn ? build(t, btn, rc) : [];
      }, message);
    const cards = buttons.map((b, i) => {
      const label = b.label.node ? b.label : { node: null, text: { template: humanize(b.name ?? "Open"), translated: false } };
      return h(
        "div",
        { class: "pd-col" },
        h("div", { class: "pd-col-head" }, h("code", {}, b.name ?? "?"), h("span", { class: "fd-spacer" }), iconButton("trash", "Remove the button", () => withBell((t, bl) => removeButtonEdits(t, bl, i), "Removed the button"))),
        h(
          "div",
          { class: "fd-rows" },
          this.row("Label", this.textEditor(d, label, rec, (c) => c && withButton(i, (t, btn) => buttonCallEdits(t, btn, "label", c), "Button label changed"))),
          this.row("Opens", this.targetEditor(d, b.url.node, b.url.target, rec, (c) => withButton(i, (t, btn) => buttonCallEdits(t, btn, "url", c), "Button link changed"))),
          this.row("Marks as read", toggleSwitch(b.markAsRead, (on) => withButton(i, (t, btn) => buttonCallEdits(t, btn, "markAsRead", on ? "" : null), `Marks as read ${on ? "on" : "off"}`)), "Clicking it marks the notification as read."),
          this.others(d, b.other),
        ),
      );
    });
    return h("div", {}, head, ...cards, buttons.length ? null : h("p", { class: "fd-note" }, "No buttons. Add one to open the record or a page."));
  }

  // ---- The email ----

  private mailSection(d: Doc, mail: ReturnType<typeof readMail>, rec: string | null, listed: boolean): HTMLElement {
    const section = h("section", { class: "fd-settings-section fd-settings" }, h("h3", {}, icon("mail"), "By email"));
    if (!mail) {
      if (listed) section.append(h("p", { class: "fd-note" }, "The class has no toMail() method yet."), h("button", { type: "button", onclick: () => void this.edit((t, cls) => addChannelMethod(t, cls, "mail", humanize(cls.name)), "Added the email") }, icon("add"), "Add it"));
      else section.append(h("p", { class: "fd-note" }, "The class doesn't send an email."));
      return section;
    }
    if ("code" in mail) return section.append(h("p", { class: "fd-note" }, "toMail() returns something other than a MailMessage chain, such as a Mailable, so the designer can't read it."), this.codeChip(d, null, mail.code.span[0])), section;
    const withMail = (build: (t: string, m: MailRead, rec: string | null) => Edit[], message: string) =>
      void this.edit((t, cls) => {
        const r = this.rec(cls);
        const m = readMail(t, cls, r);
        return m && !("code" in m) ? build(t, m, r) : [];
      }, message);
    const call = (name: string, message: string) => (code: string | null) => withMail((t, m) => mailCallEdits(t, m, name, code), message);
    const lines = (after: boolean) => {
      const own = mail.lines.filter((l) => l.after === after);
      const items = own.map((l) => {
        const i = mail.lines.indexOf(l);
        const editor = this.textEditor(d, { node: l.call.args.items[0].value, text: l.text }, rec, (c) => withMail((t, m) => {
          const line = m.lines[i];
          return line ? (c === null ? removeLineEdits(m, line) : [replaceNode(t, line.call.args.items[0].value, c)]) : [];
        }, c === null ? "Removed the line" : "Line changed"), { optional: true });
        return h("div", { class: "wd-inline nd-line" }, editor, iconButton("trash", "Remove the line", () => withMail((_t, m) => (m.lines[i] ? removeLineEdits(m, m.lines[i]) : []), "Removed the line")));
      });
      const add = h("button", { type: "button", class: "link", textContent: "+ Add a line" });
      add.onclick = () => withMail((t, m, r) => addLineEdits(t, m, textCode({ template: "New line", translated: false }, r), after), "Added a line");
      return h("div", { class: "fd-stack" }, ...items, add);
    };
    const action = mail.action;
    const button = action
      ? h(
          "div",
          { class: "fd-stack" },
          h("div", { class: "wd-inline" }, this.textEditor(d, action.label, rec, (c) => c && withMail((t, m) => (m.action?.label.node ? [replaceNode(t, m.action.label.node, c)] : []), "Button label changed")), iconButton("trash", "Remove the button", () => withMail((t, m) => mailCallEdits(t, m, "action", null), "Removed the button"))),
          this.targetEditor(d, action.url.node, action.url.target, rec, (c) => withMail((t, m) => (m.action?.url.node ? [replaceNode(t, m.action.url.node, c)] : []), "Button link changed")),
        )
      : h("button", { type: "button", class: "link", textContent: "+ Add a button", onclick: () => this.addMailButton(withMail) });
    section.append(
      h(
        "div",
        { class: "fd-rows" },
        this.row("Subject", this.textEditor(d, mail.subject, rec, call("subject", "Subject changed"), { optional: true, placeholder: humanize(d.cls.name) }), "Without one, the subject is the class name's words."),
        this.row("Greeting", this.textEditor(d, mail.greeting, rec, call("greeting", "Greeting changed"), { optional: true, placeholder: "Hello!" })),
        this.row(action ? "Before the button" : "Lines", lines(false)),
        this.row("Button", button),
        action ? this.row("After the button", lines(true)) : null,
        this.row("Salutation", this.textEditor(d, mail.salutation, rec, call("salutation", "Salutation changed"), { optional: true, placeholder: `Regards, ${this.setup?.app ?? "Laravel"}` })),
        this.others(d, mail.other),
      ),
    );
    return section;
  }

  private addMailButton(withMail: (build: (t: string, m: MailRead, rec: string | null) => Edit[], message: string) => void) {
    const model = this.recordModel;
    const r = (this.app?.panels ?? []).flatMap((p) => p.resources).find((x) => x.model === model) ?? (this.app?.panels ?? []).flatMap((p) => p.resources)[0];
    const page = r?.pages.find((p) => p.kind === "view") ?? r?.pages.find((p) => p.kind === "edit");
    withMail((t, m, rc) => {
      const target: Target = r && rc && page && r.model === model ? { kind: "page", resource: r.class, page: page.kind } : r ? { kind: "page", resource: r.class, page: "index" } : { kind: "url", url: "/" };
      return mailCallEdits(t, m, "action", `${textCode({ template: "View", translated: false }, rc)}, ${targetCode(target, rc)}`);
    }, "Added a button");
  }

  // ---- Sending ----

  private sendSection(d: Doc): HTMLElement {
    const model = this.recordModel;
    const kinds = RECIPIENTS.filter(([k]) => k !== "related" || model);
    const who = h("select", {}, ...kinds.map(([k, l]) => h("option", { value: k, textContent: l, selected: k === this.recipient.kind })));
    const userModel = this.setup?.user ?? "App\\Models\\User";
    const user = model ? this.models[model]?.relations.find((r) => /belongsto/i.test(r.type) && r.related === userModel) : undefined;
    who.onchange = () => {
      const k = who.value as Recipient["kind"];
      this.recipient = k === "role" ? { kind: k, role: "admin" } : k === "related" ? { kind: k, relation: user?.name ?? "user" } : k === "address" ? { kind: k, email: "someone@example.com" } : { kind: k };
      this.render();
    };
    const variable = model ? `$${shortClass(model).replace(/^./, (c) => c.toLowerCase())}` : "$record";
    const code = sendCode({ notification: d.cls.fqn, recipient: this.recipient, withRecord: !!model }, userModel, variable).replace(/\{\{[\w\\]*?(\w+)\}\}/g, "$1");
    const copy = iconButton("copy", "Copy the code", () => void navigator.clipboard.writeText(code).then(() => host.status("Copied.")));
    return h(
      "section",
      { class: "fd-settings-section" },
      h("h3", {}, icon("send"), "Sending it"),
      h("p", { class: "fd-note" }, "An action button sends it with What it does > Send a notification, in the Filament designer. To send it from your own code:"),
      h("div", { class: "wd-inline" }, h("span", { class: "fd-note" }, "To"), who),
      h("div", { class: "nd-code" }, h("pre", {}, code), copy),
    );
  }

  // ---- Previews ----

  /** A text with sample values for the record's fields; "…" for code. */
  private sample(s: Slot, fallback = ""): string {
    if (s.node && !s.text) return "…";
    const t: Text | null = s.text;
    if (!t) return fallback;
    const model = this.recordModel;
    const columns = model ? this.models[model]?.columns : undefined;
    return fillText(t.template, (f) => sampleValue(f, columns?.[f]?.type));
  }

  private bellPreview(bell: BellRead): HTMLElement {
    const look = bell.status ? STATUS_LOOK[bell.status] : undefined;
    const iconEl = bell.icon ? heroicon(this.cat?.heroiconsDir ?? null, iconNameOf(bell.icon)) : look ? heroicon(this.cat?.heroiconsDir ?? null, look[0]) : null;
    const color = look?.[1] ?? COLOR_SWATCH.gray;
    const buttons = bell.actions && "buttons" in bell.actions ? bell.actions.buttons : [];
    return h(
      "div",
      { class: "nd-bell" },
      h("div", { class: "nd-preview-label" }, icon("bell"), "Bell"),
      h(
        "div",
        { class: "nd-bell-card" },
        iconEl ? h("span", { class: "nd-bell-icon", style: `color:${color}` }, iconEl) : null,
        h(
          "div",
          { class: "nd-bell-text" },
          h("strong", {}, this.sample(bell.title, "Title")),
          h("span", { class: "nd-bell-time" }, "Just now"),
          bell.body.node ? h("p", {}, this.sample(bell.body)) : null,
          buttons.length ? h("div", { class: "nd-bell-buttons" }, ...buttons.map((b) => h("span", { class: "nd-bell-link" }, b.label.node ? this.sample(b.label) : humanize(b.name ?? "Open")))) : null,
        ),
      ),
    );
  }

  private mailPreview(mail: MailRead): HTMLElement {
    const app = this.setup?.app ?? "Laravel";
    const para = (s: string) => h("p", {}, s);
    const lines = (after: boolean) => mail.lines.filter((l) => l.after === after).map((l) => para(l.text ? fillText(l.text.template, (f) => sampleValue(f, this.recordModel ? this.models[this.recordModel]?.columns[f]?.type : undefined)) : "…"));
    return h(
      "div",
      { class: "nd-mail" },
      h("div", { class: "nd-preview-label" }, icon("mail"), "Email"),
      h("div", { class: "nd-mail-subject" }, h("span", { class: "fd-note" }, "Subject"), h("strong", {}, this.sample(mail.subject, humanize(this.doc?.cls.name ?? "")))),
      h(
        "div",
        { class: "nd-mail-page" },
        h("div", { class: "nd-mail-app" }, app),
        h(
          "div",
          { class: "nd-mail-body" },
          h("h4", {}, this.sample(mail.greeting, "Hello!")),
          ...lines(false),
          mail.action ? h("div", { class: "nd-mail-button" }, h("span", {}, this.sample(mail.action.label, "Open"))) : null,
          ...lines(true),
          mail.salutation.node ? para(this.sample(mail.salutation)) : h("p", {}, "Regards,", h("br"), app),
        ),
      ),
    );
  }
}

