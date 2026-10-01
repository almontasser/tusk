// The environment settings, in an editor tab of their own: the app, mail, queue, storage, cache, and session values
// in `.env` that password reset, email codes, notifications, and imports and exports depend on. Each change is saved
// to `.env` at once through the editor's model, so open tabs and local history stay in step; src/envgen.ts edits
// the text. Beside each value, the value the booted app uses, from introspect.php, shows when they differ.
import { invoke } from "@tauri-apps/api/core";
import { h, icon, iconButton, toast } from "./dom";
import type { monaco } from "./editor";
import { blockKeys, encode, envValues, interpolate, isSecret, readEnv, setEnv, timezoneFromEnv, timezoneSource } from "./envgen";
import * as fapp from "./filamentapp";
import { host } from "./filamentdesigner";
import { askName, commitInput, toggleSwitch } from "./filamentpickers";
import { applyWorkspaceEdit } from "./lsp";
import { shellQuote } from "./runconfig";
import { runningContainer } from "./sail";
import { errorText, showError } from "./status";
import { showEditorView } from "./terminal";

type Field = { key: string; label: string; config?: string; kind?: "flag" | "select" | "secret"; options?: string[]; list?: string[]; placeholder?: string; hint?: string };
type Section = "app" | "mail" | "queue" | "storage" | "cache";

/** Laravel's session drivers; unlike mailers or disks, config/session.php doesn't list them. */
const SESSION_DRIVERS = ["file", "cookie", "database", "redis", "memcached", "dynamodb", "array"];
/** Config keys whose values the booted app reports, by the `.env` key that usually sets them. */
const CONFIG: Record<string, string> = {
  APP_NAME: "app.name", APP_ENV: "app.env", APP_DEBUG: "app.debug", APP_URL: "app.url", APP_LOCALE: "app.locale", APP_TIMEZONE: "app.timezone",
  MAIL_MAILER: "mail.default", MAIL_HOST: "mail.mailers.smtp.host", MAIL_PORT: "mail.mailers.smtp.port", MAIL_USERNAME: "mail.mailers.smtp.username", MAIL_FROM_ADDRESS: "mail.from.address", MAIL_FROM_NAME: "mail.from.name",
  QUEUE_CONNECTION: "queue.default", FILESYSTEM_DISK: "filesystems.default", CACHE_STORE: "cache.default", SESSION_DRIVER: "session.driver",
};

let view: EnvSettings | null = null;

/** Opens the environment settings, scrolled to a section: "app", "mail", "queue", "storage", or "cache". */
export function openEnvSettings(section?: string) {
  if (view?.root !== host.root()) view = new EnvSettings(host.root());
  view.show(section);
}

class EnvSettings {
  el = h("div", { class: "md-designer es-designer" });
  private model: monaco.editor.ITextModel | null = null;
  private missing = false;
  private info: fapp.EnvSettingsInfo | null = null;
  private files: Record<string, string> = {};
  private publicLink = true;
  private pending = false;
  private section?: string;
  /** Changes run one at a time, each on the text the previous one left. */
  private settled: Promise<unknown> = Promise.resolve();

  constructor(readonly root: string) {}

  private get path() {
    return `${this.root}/.env`;
  }

  show(section?: string) {
    this.section = section;
    showEditorView("Environment", this.el, "settings", () => (view = null));
    if (!this.model && !this.missing) void this.load();
    this.render();
  }

  private async load() {
    if (!(await invoke<boolean>("path_exists", { path: this.path }))) return (this.missing = true), this.render();
    this.missing = false;
    this.model = await host.ensureModel(this.path);
    this.model.onDidChangeContent(() => this.el.isConnected && this.render());
    await this.readProject();
  }

  /** Reads the config files and what the booted app uses; they only add notes, so the values show first. */
  private async readProject() {
    const read = (file: string) => invoke<string>("read_file", { path: `${this.root}/config/${file}` }).catch(() => "");
    const [app, mail, services, filesystems, link] = await Promise.all([read("app.php"), read("mail.php"), read("services.php"), read("filesystems.php"), invoke<boolean>("path_exists", { path: `${this.root}/public/storage` })]);
    this.files = { app, mail, services, filesystems };
    this.publicLink = link;
    this.render();
    this.pending = true;
    this.info = await fapp.envSettings(this.root, Object.values(CONFIG)).catch(() => null);
    this.pending = false;
    this.render();
  }

  /** Reads the app again after a change, such as to its tables or `.env`. */
  private refresh() {
    fapp.forget(["env-settings"]);
    void this.readProject();
  }

  // ---- Writing ----

  /** Replaces a model's text with `next`, as one edit over the part that changed, and saves it. */
  private write(model: monaco.editor.ITextModel, next: string) {
    const prev = model.getValue();
    let a = 0;
    while (a < prev.length && a < next.length && prev[a] === next[a]) a++;
    let b = 0;
    while (b < prev.length - a && b < next.length - a && prev[prev.length - 1 - b] === next[next.length - 1 - b]) b++;
    const s = model.getPositionAt(a);
    const e = model.getPositionAt(prev.length - b);
    const range = { start: { line: s.lineNumber - 1, character: s.column - 1 }, end: { line: e.lineNumber - 1, character: e.column - 1 } };
    return applyWorkspaceEdit({ changes: { [model.uri.toString()]: [{ range, newText: next.slice(a, next.length - b) }] } });
  }

  /** Sets a key in `.env`; `null` writes Laravel's `null`. Messages name the key, never its value. */
  private set(key: string, value: string | null) {
    this.settled = this.settled.then(async () => {
      const model = this.model;
      if (!model) return;
      const text = model.getValue();
      const old = readEnv(text).get(key);
      // An empty field over `null`, or for a key that isn't there, changes nothing.
      if (value === "" && (!old || old.value === null)) return;
      const encoded = value === null ? "null" : encode(value, { prefer: old?.quote, literal: isSecret(key) });
      const next = setEnv(text, key, encoded);
      if (next === text) return;
      await this.write(model, next);
      host.status(`Saved ${key} in .env.`);
      if (!old) void this.offerExample(key, encoded);
      if (this.info?.configCached) this.offerConfigClear();
      this.refresh();
    }).catch((e) => showError(`Can't save ${key}`, e));
  }

  /** Offers to add a new key to `.env.example`, with secrets left empty, so others setting up the project see it. */
  private async offerExample(key: string, encoded: string) {
    const path = `${this.root}/.env.example`;
    if (!(await invoke<boolean>("path_exists", { path }))) return;
    const model = await host.ensureModel(path);
    if (readEnv(model.getValue()).has(key)) return;
    toast(`Added ${key} to .env. Add it to .env.example too, so others setting up the project see it?`, {
      kind: "info",
      action: { label: "Add it", run: () => void this.write(model, setEnv(model.getValue(), key, isSecret(key) ? "" : encoded)).then(() => host.status(`Added ${key} to .env.example.`)) },
    });
  }

  private offerConfigClear() {
    toast("The config is cached, so the app still uses the old values.", { kind: "info", action: { label: "Clear the config cache", run: () => void this.artisan(["config:clear"], "Cleared the config cache.") } });
  }

  /** Runs a quick Artisan command, says `done`, and reads the app again. */
  private async artisan(args: string[], done: string) {
    try {
      await fapp.artisan(this.root, args);
      host.status(done);
    } catch (e) {
      showError(`php artisan ${args[0]} failed`, e);
    }
    this.publicLink = await invoke<boolean>("path_exists", { path: `${this.root}/public/storage` });
    this.refresh();
  }

  /** Runs Artisan commands one after another in a terminal tab, in the project's container when it's up. */
  private async terminal(title: string, commands: string[][], done?: () => void) {
    const container = await runningContainer(this.root);
    const line = commands.map((args) => (container ? container.exec(["php", "artisan", ...args]) : ["php", "artisan", ...args]).map(shellQuote).join(" ")).join(" && ");
    host.openTerminal(title, ["/bin/sh", "-c", line], done);
  }

  /** Makes the migration for a table a driver needs and runs it; just runs migrations when one is waiting already. */
  private async makeTable(make: string) {
    const pending = (await fapp.migrations(this.root).catch(() => null))?.files.some((f) => f.ran === false);
    await this.terminal("Set up the table", pending ? [["migrate"]] : [[make], ["migrate"]], () => (fapp.forget(["migrations"]), this.refresh()));
  }

  // ---- Drawing ----

  render() {
    const header = h(
      "header",
      { class: "fd-header" },
      h("span", { class: "fd-header-icon" }, icon("settings")),
      h("div", { class: "fd-header-titles" }, h("h1", {}, "Environment"), h("div", { class: "fd-header-chips" }, h("button", { type: "button", class: "fd-chip-link", onclick: () => host.openAt(this.path, 1) }, icon("go-to-file"), ".env"))),
      h("span", { class: "fd-spacer" }),
      this.pending ? h("span", { class: "fd-note" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), " Reading the app…") : null,
      iconButton("refresh", "Read the app again", () => this.refresh()),
    );
    if (this.missing) return void this.el.replaceChildren(header, h("div", { class: "md-main" }, this.noEnv()));
    if (!this.model) return void this.el.replaceChildren(header, h("div", { class: "fd-loading" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), "Reading .env…"));
    const env = envValues(this.model.getValue());
    const main = h(
      "div",
      { class: "md-main" },
      this.info?.configCached
        ? this.note("warning", "The config is cached (bootstrap/cache/config.php), so the app ignores .env until you clear it.", ["Clear the config cache", () => void this.artisan(["config:clear"], "Cleared the config cache.")])
        : null,
      this.app(env),
      this.mail(env),
      this.queue(env),
      this.storage(env),
      this.cache(env),
    );
    // Redrawing after each change keeps the place you were at.
    const scroll = this.el.querySelector(".md-main")?.scrollTop ?? 0;
    this.el.replaceChildren(header, main);
    main.scrollTop = scroll;
    // Once the config files are read, since their notes change the layout above the section.
    if (this.section && this.files.app !== undefined) main.querySelector(`[data-section="${this.section}"]`)?.scrollIntoView({ block: "start" }), (this.section = undefined);
  }

  private noEnv(): HTMLElement {
    const create = async () => {
      const example = await invoke<string>("read_file", { path: `${this.root}/.env.example` }).catch(() => null);
      if (example === null) return host.status("The project has no .env.example to copy.");
      await invoke("create_file", { path: this.path, contents: example });
      await this.load();
      if (!readEnv(example).get("APP_KEY")?.value) await this.artisan(["key:generate"], "Created .env with a new app key.");
    };
    return h("section", { class: "fd-settings-section" }, h("p", {}, "The project has no .env file. Laravel reads its settings from it."), h("button", { type: "button", class: "primary", onclick: () => void create() }, icon("new-file"), "Create it from .env.example"));
  }

  private sectionEl(id: Section, title: string, iconName: string, about: string, ...children: (HTMLElement | null)[]) {
    return h("section", { class: "fd-settings-section fd-settings", data: { section: id } }, h("h3", {}, icon(iconName), title), h("p", { class: "fd-note" }, about), ...children);
  }

  private note(kind: "warning" | "info", text: string, ...actions: ([string, () => unknown] | null)[]) {
    return h("div", { class: `fd-helper-note${kind === "warning" ? " fd-error-note" : ""}` }, icon(kind), h("span", {}, text, " "), ...actions.filter((a) => !!a).map(([label, run]) => h("button", { type: "button", class: "fd-chip-link", onclick: run }, label)));
  }

  private rows(env: Record<string, string | null>, fields: Field[]) {
    return h("div", { class: "fd-rows" }, ...fields.map((f) => this.row(env, f)));
  }

  private row(env: Record<string, string | null>, f: Field, editor?: HTMLElement): HTMLElement {
    const value = env[f.key] ?? "";
    const set = (v: string | null) => this.set(f.key, v);
    if (!editor) {
      if (f.kind === "flag") editor = toggleSwitch(value === "true" || value === "(true)", (on) => set(on ? "true" : "false"), f.label);
      else if (f.kind === "select") {
        const options = [...new Set([...(f.options ?? []), ...(value ? [value] : [])])];
        editor = h("select", { onchange: (e: Event) => set((e.target as HTMLSelectElement).value) }, ...(value ? [] : [h("option", { value: "", textContent: "Not set", selected: true })]), ...options.map((o) => h("option", { value: o, textContent: o, selected: o === value })));
      } else {
        const listId = f.list ? `es-list-${f.key}` : undefined;
        const input = commitInput(value, (v) => set(v.trim()), { placeholder: f.placeholder ?? "", type: f.kind === "secret" ? "password" : "text", list: listId }) as HTMLInputElement;
        input.autocomplete = "off";
        editor = h(
          "div",
          { class: "es-input" },
          input,
          f.kind === "secret" ? iconButton("eye", "Show or hide", () => (input.type = input.type === "password" ? "text" : "password")) : null,
          listId ? h("datalist", { id: listId }, ...f.list!.map((o) => h("option", { value: o }))) : null,
        );
      }
    }
    // What the booted app uses, when it differs from `.env`: the config is cached, or its file doesn't read the key.
    const used = f.config && this.info ? this.info.values[f.config] : undefined;
    const expected = env[f.key] == null ? null : interpolate(env[f.key]!, env);
    const differs = used !== undefined && expected !== null && !isSecret(f.key) && String(used ?? "") !== expected;
    return h(
      "div",
      { class: `fd-row${env[f.key] != null ? " set" : ""}`, title: f.hint ?? "" },
      h("span", { class: "fd-row-label" }, f.label, h("code", { class: "es-key" }, f.key)),
      h("div", { class: "fd-row-editor" }, editor),
      h("span", { class: "fd-row-spacer" }),
      differs
        ? h("p", { class: "fd-note es-differs", title: this.info?.configCached ? "The config is cached." : `config/${f.config!.split(".")[0]}.php doesn't read ${f.key}, or reads it differently.` }, icon("warning"), ` The app uses ${JSON.stringify(used)}.`)
        : null,
    );
  }

  private app(env: Record<string, string | null>): HTMLElement {
    const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    const tz = timezoneSource(this.files.app ?? "");
    const tzField: Field = { key: "APP_TIMEZONE", label: "Time zone", config: "app.timezone", list: ["UTC", ...zones], placeholder: "UTC", hint: "Dates are stored and shown in this time zone." };
    let tzRow: HTMLElement;
    let tzNote: HTMLElement | null = null;
    if (tz?.kind === "fixed") {
      // Laravel 11 and later write the zone into config/app.php, so APP_TIMEZONE does nothing until it reads it.
      tzRow = this.row(env, { ...tzField, config: undefined }, commitInput(tz.value, (v) => v.trim() && void this.editAppConfig((t) => { const s = timezoneSource(t); return s?.kind === "fixed" ? t.slice(0, s.start) + `'${v.trim().replace(/'/g, "")}'` + t.slice(s.end) : null; }), { list: "es-list-APP_TIMEZONE" }));
      tzRow.append(h("datalist", { id: "es-list-APP_TIMEZONE" }, ...tzField.list!.map((o) => h("option", { value: o }))));
      tzNote = this.note("info", `config/app.php sets the time zone to ${tz.value} itself, so APP_TIMEZONE in .env does nothing. Changing it here edits config/app.php.`, ["Read it from .env instead", () => void this.timezoneFromEnv(tz.value)]);
    } else if (tz?.kind === "code") {
      tzRow = this.row(env, tzField, h("button", { type: "button", class: "fd-code-chip", onclick: () => this.openConfig("app", "timezone") }, icon("code"), h("span", {}, "Set in config/app.php")));
    } else tzRow = this.row(env, tzField);
    return this.sectionEl(
      "app",
      "App",
      "server-environment",
      "The app's address goes into links in emails, such as password reset and email verification, and into file URLs on the public disk. Dates show in its time zone.",
      env.APP_KEY ? null : this.note("warning", "The app has no APP_KEY, so sessions and encryption fail.", ["Generate one", () => void this.artisan(["key:generate"], "Generated an app key.")]),
      env.APP_ENV === "production" && env.APP_DEBUG === "true" ? this.note("warning", "Debug mode is on in production: error pages show your code and settings to visitors.") : null,
      h(
        "div",
        { class: "fd-rows" },
        ...([
          { key: "APP_NAME", label: "Name", config: "app.name", hint: "Shown in emails, as the sender's name by default, and in the browser's title." },
          { key: "APP_ENV", label: "Environment", config: "app.env", list: ["local", "staging", "production", "testing"] },
          { key: "APP_DEBUG", label: "Debug mode", config: "app.debug", kind: "flag", hint: "Detailed error pages. Keep it off in production." },
          { key: "APP_URL", label: "URL", config: "app.url", placeholder: "http://localhost", hint: "The address people open the app at, with http:// or https://." },
          { key: "APP_LOCALE", label: "Language", config: "app.locale", placeholder: "en" },
        ] as Field[]).map((f) => this.row(env, f)),
        tzRow,
      ),
      tzNote,
    );
  }

  /** Makes config/app.php read the time zone from `.env`, keeping its zone there as the default and in `.env`. */
  private async timezoneFromEnv(zone: string) {
    await this.editAppConfig(timezoneFromEnv);
    if (!this.model || !readEnv(this.model.getValue()).get("APP_TIMEZONE")?.value) this.set("APP_TIMEZONE", zone);
  }

  private editAppConfig(change: (text: string) => string | null) {
    this.settled = this.settled.then(async () => {
      const model = await host.ensureModel(`${this.root}/config/app.php`);
      const next = change(model.getValue());
      if (next === null || next === model.getValue()) return;
      await this.write(model, next);
      this.files.app = next;
      host.status("Saved config/app.php.");
      this.refresh();
    }).catch((e) => showError("Can't change config/app.php", e));
    return this.settled;
  }

  private openConfig(file: string, key: string) {
    const text = this.files[file] ?? "";
    const at = text.search(new RegExp(`['"]${key}['"]\\s*=>`));
    host.openAt(`${this.root}/config/${file}.php`, at < 0 ? 1 : text.slice(0, at).split("\n").length);
  }

  private mail(env: Record<string, string | null>): HTMLElement {
    const mailers = this.info?.mailers ?? {};
    const mailer = env.MAIL_MAILER ?? "";
    const transport = mailers[mailer] ?? mailer;
    const fields: Field[] = [];
    if (transport === "smtp") {
      // Laravel 11 and later read MAIL_SCHEME (smtp or smtps); earlier versions MAIL_ENCRYPTION (tls or ssl).
      const scheme = /MAIL_ENCRYPTION/.test(this.files.mail ?? "") ? { key: "MAIL_ENCRYPTION", options: ["tls", "ssl"] } : { key: "MAIL_SCHEME", options: ["smtp", "smtps"] };
      fields.push(
        { key: "MAIL_HOST", label: "Host", config: "mail.mailers.smtp.host", placeholder: "smtp.example.com" },
        { key: "MAIL_PORT", label: "Port", config: "mail.mailers.smtp.port", list: ["25", "465", "587", "2525", "1025"], hint: "587 for STARTTLS, 465 for TLS (smtps), 1025 for Mailpit." },
        { key: "MAIL_USERNAME", label: "Username", config: "mail.mailers.smtp.username" },
        { key: "MAIL_PASSWORD", label: "Password", kind: "secret" },
        { key: scheme.key, label: scheme.key === "MAIL_SCHEME" ? "Scheme" : "Encryption", list: scheme.options, placeholder: "From the port", hint: scheme.key === "MAIL_SCHEME" ? "smtps for TLS from the start (port 465); otherwise empty, and STARTTLS is used when the server offers it." : "" },
      );
    } else if (transport && !["log", "array", "sendmail", "failover", "roundrobin"].includes(transport)) {
      // ses, postmark, resend, mailgun: the keys config/services.php reads for the service.
      for (const key of blockKeys(this.files.services ?? "", transport)) fields.push({ key, label: key.replace(/^[A-Z]+_/, "").replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()), kind: isSecret(key) ? "secret" : undefined });
    }
    fields.push(
      { key: "MAIL_FROM_ADDRESS", label: "From address", config: "mail.from.address", placeholder: "hello@example.com" },
      { key: "MAIL_FROM_NAME", label: "From name", config: "mail.from.name", placeholder: "${APP_NAME}", hint: "${APP_NAME} uses the app's name." },
    );
    const test = h("button", { type: "button", onclick: (e: Event) => void this.testMail(e.currentTarget as HTMLElement, env) }, icon("mail"), "Send a test email");
    return this.sectionEl(
      "mail",
      "Mail",
      "mail",
      "Password reset, email verification, two-factor codes by email, and email notifications go out through the mailer. The log mailer writes them to storage/logs/laravel.log instead of sending them.",
      this.rows(env, [{ key: "MAIL_MAILER", label: "Mailer", config: "mail.default", kind: "select", options: Object.keys(mailers) }]),
      transport === "log" ? this.note("info", "Emails aren't sent: they're written to the log, which is fine while you develop.") : null,
      fields.length ? this.rows(env, fields) : null,
      h("div", { class: "es-actions" }, test),
    );
  }

  /** Sends a plain email with the app's mailer, through Tinker, so it uses the app's real settings. */
  private async testMail(anchor: HTMLElement, env: Record<string, string | null>) {
    const to = await askName(anchor, { title: "Send a test email to", value: env.MAIL_FROM_ADDRESS ?? "", action: "Send", validate: (v) => (/^[^\s@'"\\]+@[^\s@'"\\]+$/.test(v.trim()) ? null : "An email address.") });
    if (!to) return;
    host.status(`Sending a test email to ${to.trim()}…`);
    const php = `\\Illuminate\\Support\\Facades\\Mail::raw('This is a test email from Tusk. Your app can send email.', fn ($m) => $m->to('${to.trim()}')->subject('Test email')); echo 'sent';`;
    try {
      await fapp.artisan(this.root, ["tinker", "--execute", php]);
      const mailer = String(this.info?.values["mail.default"] ?? env.MAIL_MAILER ?? "");
      if (mailer === "log") {
        const log = `${this.root}/storage/logs/laravel.log`;
        toast("The log mailer wrote the email to storage/logs/laravel.log.", { kind: "info", action: { label: "Open the log", run: () => void host.ensureModel(log).then((m) => host.openAt(log, m.getLineCount())) } });
      } else host.status(`Sent a test email to ${to.trim()}${mailer ? ` with the ${mailer} mailer` : ""}.`);
    } catch (e) {
      // Keep secrets out of the message, in case a transport repeats one.
      let message = errorText(e);
      for (const [k, v] of Object.entries(env)) if (v && v.length > 3 && isSecret(k)) message = message.split(v).join("•••");
      showError("The test email wasn't sent", message);
    }
  }

  private queue(env: Record<string, string | null>): HTMLElement {
    const queues = this.info?.queues ?? {};
    const name = env.QUEUE_CONNECTION ?? "";
    const driver = queues[name] ?? name;
    const [jobs, hasJobs] = this.info?.tables.jobs ?? ["jobs", null];
    const worker = (): [string, () => unknown] => ["Run a worker", () => void this.terminal("Queue worker", [["queue:work"]])];
    return this.sectionEl(
      "queue",
      "Queue",
      "server-process",
      "Imports, exports, and queued notifications and emails run on the queue, in the background. Filament's imports and exports need a queue other than sync, and a worker running it.",
      this.rows(env, [{ key: "QUEUE_CONNECTION", label: "Connection", config: "queue.default", kind: "select", options: Object.keys(queues) }]),
      driver === "sync"
        ? this.note("warning", "With sync, queued work runs during the request, so a large import or export can time out. Choose database (or redis) and run a worker.")
        : driver
          ? this.note("info", "Queued work waits until a worker runs it: php artisan queue:work, kept running on your server, such as with Supervisor.", worker())
          : null,
      driver === "database" && hasJobs === false ? this.note("warning", `The database queue needs the ${jobs} table, which doesn't exist.`, ["Create it", () => void this.makeTable("make:queue-table")]) : null,
    );
  }

  private storage(env: Record<string, string | null>): HTMLElement {
    const disks = this.info?.disks ?? {};
    const disk = env.FILESYSTEM_DISK ?? "";
    const keys = disks[disk] === "s3" ? blockKeys(this.files.filesystems ?? "", disk) : [];
    return this.sectionEl(
      "storage",
      "Storage",
      "file-media",
      "Uploads go to this disk unless a field chooses another, and so do exported files. The public disk serves files from public/storage, which is a link to storage/app/public.",
      this.rows(env, [{ key: "FILESYSTEM_DISK", label: "Default disk", config: "filesystems.default", kind: "select", options: Object.keys(disks) }]),
      keys.length ? this.rows(env, keys.map((key) => ({ key, label: key.replace(/^AWS_/, "").replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()), kind: isSecret(key) ? "secret" : undefined }))) : null,
      this.publicLink ? null : this.note("warning", "public/storage doesn't exist, so files on the public disk, such as uploaded images, don't show.", ["Link it", () => void this.artisan(["storage:link"], "Linked public/storage.")]),
    );
  }

  private cache(env: Record<string, string | null>): HTMLElement {
    const t = this.info?.tables;
    const store = env.CACHE_STORE ?? "";
    const driver = env.SESSION_DRIVER ?? "";
    return this.sectionEl(
      "cache",
      "Cache and sessions",
      "database",
      "Where the app caches values and keeps people signed in.",
      this.rows(env, [
        { key: "CACHE_STORE", label: "Cache store", config: "cache.default", kind: "select", options: Object.keys(this.info?.stores ?? {}) },
        { key: "SESSION_DRIVER", label: "Sessions", config: "session.driver", kind: "select", options: SESSION_DRIVERS },
        { key: "SESSION_LIFETIME", label: "Session minutes", placeholder: "120", hint: "Minutes of inactivity before people are signed out." },
      ]),
      (this.info?.stores[store] ?? store) === "database" && t?.cache[1] === false ? this.note("warning", `The database cache needs the ${t.cache[0]} table, which doesn't exist.`, ["Create it", () => void this.makeTable("make:cache-table")]) : null,
      driver === "database" && t?.sessions[1] === false ? this.note("warning", `Database sessions need the ${t.sessions[0]} table, which doesn't exist, so nobody can sign in.`, ["Create it", () => void this.makeTable("make:session-table")]) : null,
    );
  }
}
