// The schedule designer: the app's scheduled tasks (what runs, when, and how) in an editor tab, read from where the
// project keeps its schedule and changed in that code as you go (src/schedulegen.ts), with the next times each
// runs. It also explains that the scheduler must run, with buttons for development and the line for a server's
// cron, and edits the prunable() query of the models `model:prune` cleans up.
import { invoke } from "@tauri-apps/api/core";
import { h, icon, iconButton } from "./dom";
import { editFiles } from "./codeapply";
import * as fapp from "./filamentapp";
import { host } from "./filamentdesigner";
import { commitInput, toggleSwitch } from "./filamentpickers";
import { shortClass } from "./filamentschema";
import { COMMON, type Command } from "./laravelnewdata";
import { RECIPIENTS, type Recipient, type Send } from "./notifysend";
import { pick, rank, type Item } from "./palette";
import { addMember, type Edit, methodNamed, type Outline, phpString, removeMethod, replaceNode } from "./phpcode";
import { shellQuote } from "./runconfig";
import { runningContainer } from "./sail";
import {
  describeFreq,
  environmentsCode,
  findPlace,
  type Freq,
  freqEdits,
  insertTask,
  nextRuns,
  optionEdits,
  type Place,
  PRUNABLE,
  type Prune,
  prunableCode,
  prunableMethod,
  readPrunable,
  readTasks,
  removeTask,
  type Task,
  taskCode,
  wallClock,
  type What,
  whatEdits,
} from "./schedulegen";
import { errorText, showError } from "./status";
import { showEditorView } from "./terminal";
import { removeTraitEdits, traitsEdits } from "./usergen";
import { whereRow } from "./widgetdesigner";

/** Where a project can keep its schedule, in the order new tasks prefer when none has tasks yet. */
const FILES: [Place["kind"], string][] = [
  ["kernel", "app/Console/Kernel.php"],
  ["console", "routes/console.php"],
  ["app", "bootstrap/app.php"],
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Source = { kind: Place["kind"]; path: string; text: string; outline: Outline; place: Place | null; tasks: Task[] };
type Prunable = { class: string; path: string | null; trait: string; prune: Prune | null; method: boolean };

let view: ScheduleDesigner | null = null;

/** Opens the schedule designer for the open project. */
export function openSchedule() {
  if (view?.root !== host.root()) view = new ScheduleDesigner(host.root());
  view.show();
}

/** A class name as a file writes it, resolved through its imports. */
const resolver = (outline: Outline) => (name: string) => {
  if (name.startsWith("\\")) return name.slice(1);
  const [first, ...rest] = name.split("\\");
  const use = outline.uses.find((u) => u.kind === "class" && u.alias.toLowerCase() === first.toLowerCase());
  if (use) return [use.name, ...rest].join("\\");
  return outline.namespace ? `${outline.namespace}\\${name}` : name;
};

class ScheduleDesigner {
  el = h("div", { class: "md-designer sd-designer" });
  private sources: Source[] = [];
  private loaded = false;
  private info: fapp.ScheduleInfo | null = null;
  private commands: Command[] = [];
  private notifications: fapp.NotificationInfo[] = [];
  private models: Record<string, fapp.ModelSummary> = {};
  private prunables: Prunable[] = [];
  private problem = "";
  private listening = new Set<string>();

  constructor(readonly root: string) {}

  show() {
    showEditorView("Scheduled Tasks", this.el, "watch", () => (view = null));
    if (!this.loaded) void this.load();
    this.render();
  }

  private async load() {
    const [info, commands, notifications, models] = await Promise.all([
      fapp.scheduleInfo(this.root).catch((e) => ((this.problem = errorText(e)), null)),
      import("./laravelelements").then((m) => m.artisanCommands(this.root)).catch(() => []),
      fapp.notifications(this.root).catch(() => []),
      fapp.models(this.root).catch(() => ({})),
    ]);
    this.info = info;
    this.commands = commands;
    this.notifications = notifications;
    this.models = models;
    await this.read();
    await this.readPrunables();
    this.loaded = true;
    this.render();
  }

  /** Reads the files that can hold the schedule, and reads them again when they change. */
  private async read() {
    const sources: Source[] = [];
    for (const [kind, rel] of FILES) {
      const path = `${this.root}/${rel}`;
      if (!(await invoke<boolean>("path_exists", { path }).catch(() => false))) continue;
      const model = await host.ensureModel(path);
      if (!this.listening.has(path)) {
        this.listening.add(path);
        model.onDidChangeContent(() => void this.read().then(() => this.el.isConnected && this.render()));
      }
      const text = model.getValue();
      const outline = await fapp.outlineOf(text, path);
      const place = findPlace(kind, outline);
      sources.push({ kind, path, text, outline, place, tasks: place ? readTasks(text, place, resolver(outline)) : [] });
    }
    this.sources = sources;
  }

  /** The prunable models, with the query of each one's prunable() when the designer can read it. */
  private async readPrunables() {
    const out: Prunable[] = [];
    for (const p of this.info?.prunable ?? []) {
      const path = p.file ? `${this.root}/${p.file}` : null;
      let prune: Prune | null = null;
      let method = false;
      if (path) {
        const text = (await host.ensureModel(path)).getValue();
        const cls = (await fapp.outlineOf(text, path)).classes.find((c) => c.fqn === p.class);
        const m = cls && methodNamed(cls, "prunable");
        method = !!m;
        if (m?.returns.length === 1) prune = readPrunable(text.slice(m.returns[0].span[0], m.returns[0].span[1]));
      }
      out.push({ class: p.class, path, trait: p.trait, prune, method });
    }
    this.prunables = out;
  }

  /** Where new tasks go: beside the existing ones, or in the first file that can hold them. */
  private get target(): Source | undefined {
    return this.sources.find((s) => s.tasks.length) ?? this.sources.find((s) => s.place);
  }

  private get userModel() {
    return this.info?.user ?? "App\\Models\\User";
  }

  /** Applies edits to task `index` of a source, computed from its current code. */
  private editTask(src: Source, index: number, build: (text: string, t: Task, place: Place) => Edit[], message: string) {
    return editFiles([{ path: src.path, build: (text, outline) => {
      const place = findPlace(src.kind, outline);
      const t = place && readTasks(text, place, resolver(outline))[index];
      return t && place ? build(text, t, place) : null;
    } }], message);
  }

  private addTask(w: Exclude<What, { kind: "code" }>, f: Freq, name: string | null, message: string) {
    const src = this.target;
    if (!src) return host.status("The project has no routes/console.php to add tasks to.");
    return editFiles([{ path: src.path, build: (text, outline) => {
      const place = findPlace(src.kind, outline);
      return place ? [insertTask(text, place, taskCode(w, f, place, this.userModel, name))] : null;
    } }], message);
  }

  /** Runs `args` with Artisan in a terminal tab, in the project's container when it's up. */
  private async artisan(title: string, args: string) {
    const c = await runningContainer(this.root);
    const php = (c ? c.exec(["php", "artisan"], [], true) : ["php", "artisan"]).map(shellQuote).join(" ");
    host.openTerminal(title, ["/bin/sh", "-c", `${php} ${args}`]);
  }

  render() {
    const files = this.sources.filter((s) => s.place);
    const header = h(
      "header",
      { class: "fd-header" },
      h("span", { class: "fd-header-icon" }, icon("watch")),
      h("div", { class: "fd-header-titles" }, h("h1", {}, "Scheduled tasks"), h("div", { class: "fd-header-chips" }, ...files.map((s) => h("button", { type: "button", class: "fd-chip-link", onclick: () => host.openAt(s.path, 1) }, icon("go-to-file"), s.path.slice(this.root.length + 1))))),
      h("span", { class: "fd-spacer" }),
    );
    if (!this.loaded) return void this.el.replaceChildren(header, h("div", { class: "fd-loading" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), "Reading the schedule…"));
    const broken = this.sources.filter((s) => s.place && s.outline.errors);
    const main = h(
      "div",
      { class: "md-main" },
      ...broken.map((s) => h("div", { class: "fd-helper-note fd-error-note" }, icon("warning"), h("span", {}, `${s.path.slice(this.root.length + 1)} has syntax errors. Fix them to change its tasks here.`))),
      this.problem ? h("div", { class: "fd-helper-note fd-error-note" }, icon("warning"), h("span", {}, `Can't read the app: ${this.problem}`)) : null,
      this.tasksSection(),
      this.pruneSection(),
    );
    this.el.replaceChildren(header, h("div", { class: "md-body" }, main, h("aside", { class: "ps-preview" }, this.schedulerNote())));
  }

  // ---- The scheduler ----

  private schedulerNote(): HTMLElement {
    const cron = `* * * * * cd ${this.root} && php artisan schedule:run >> /dev/null 2>&1`;
    const copy = h("button", { type: "button" }, icon("copy"), "Copy");
    copy.onclick = () => void navigator.clipboard.writeText(cron).then(() => host.status("Copied the cron line."));
    return h(
      "div",
      { class: "sd-scheduler" },
      h("div", { class: "ps-preview-head" }, h("strong", {}, "The scheduler must run")),
      h("p", { class: "fd-note" }, "Laravel runs these tasks only while its scheduler runs. Nothing runs them by default."),
      h("strong", { class: "sd-subhead" }, "While you develop"),
      h("p", { class: "fd-note" }, "schedule:work checks the schedule every minute, until you stop it."),
      h("div", { class: "wd-inline" }, h("button", { type: "button", class: "primary", onclick: () => void this.artisan("Scheduler", "schedule:work") }, icon("play"), "Run the scheduler"), h("button", { type: "button", onclick: () => void this.artisan("Schedule", "schedule:list") }, icon("list-unordered"), "List the tasks")),
      h("strong", { class: "sd-subhead" }, "On a server"),
      h("p", { class: "fd-note" }, "Add one cron entry that runs schedule:run every minute, with the app's path on the server. Run crontab -e as the user that runs the app."),
      h("code", { class: "sd-cron" }, cron),
      copy,
    );
  }

  // ---- Tasks ----

  private tasksSection(): HTMLElement {
    const rows = this.sources.flatMap((src) => src.tasks.map((t, i) => this.taskCard(src, t, i)));
    const add = h("button", { type: "button", class: "md-add" }, icon("add"), "Add task");
    add.onclick = () => this.addMenu();
    return h(
      "section",
      { class: "fd-settings-section" },
      h("h3", {}, icon("watch"), "Tasks", h("span", { class: "fd-spacer" }), this.target && !this.target.outline.errors ? add : null),
      ...rows,
      rows.length ? null : h("p", { class: "fd-note" }, this.target ? "No tasks yet. Add one, such as a nightly cleanup or a weekly report." : "The project has no routes/console.php, so there's nowhere to add tasks."),
    );
  }

  private addMenu() {
    const daily: Freq = { kind: "daily", time: "00:00" };
    const items: Item[] = [
      { label: "Artisan command", detail: "Run a command, such as a backup or a report", icon: "codicon-terminal", run: () => this.pickCommand((line) => void this.addTask({ kind: "command", line }, daily, null, `Scheduled ${line}`)) },
      { label: "Queued job", detail: "Dispatch one of the app's jobs", icon: "codicon-server-process", run: () => this.pickJob((job) => void this.addTask({ kind: "job", job, args: null }, daily, null, `Scheduled ${shortClass(job)}`)) },
      {
        label: "Send a notification",
        detail: "Such as a weekly report email",
        icon: "codicon-mail",
        run: () =>
          this.pickNotification((notification) => {
            const send: Send = { notification, recipient: { kind: "users" }, withRecord: false };
            void this.addTask({ kind: "notify", send }, { kind: "weekly", day: 1, time: "08:00" }, `Send ${shortClass(notification)}`, `Scheduled ${shortClass(notification)}`);
          }),
      },
      { label: "Delete old records", detail: "Schedule model:prune, which cleans up the prunable models below", icon: "codicon-trash", run: () => void this.schedulePrune() },
    ];
    pick("Add a scheduled task", (q) => (q.trim() ? rank(q, items) : items));
  }

  private pickCommand(done: (line: string) => void) {
    const items: Item[] = this.commands.filter((c) => !/^(make|schedule|_complete|completion|list|help):?/.test(c.name)).map((c) => ({ label: c.name, detail: c.description, icon: "codicon-terminal", run: () => done(c.name) }));
    if (!items.length) return host.status("Can't list Artisan's commands.");
    pick("Pick a command", (q) => (q.trim() ? rank(q, items) : items));
  }

  private pickJob(done: (cls: string) => void) {
    const jobs = this.info?.jobs ?? [];
    if (!jobs.length) return host.status("The app has no queued jobs. Make one with Laravel: New Element… (make:job).");
    const items: Item[] = jobs.map((j) => ({ label: shortClass(j.class), detail: j.needsArgs ? `${j.class} · its constructor needs arguments; add them in the code` : j.class, icon: "codicon-server-process", run: () => done(j.class) }));
    pick("Pick a job", (q) => (q.trim() ? rank(q, items) : items));
  }

  /** Notifications that take no record: a scheduled task has none to give them. */
  private pickNotification(done: (cls: string) => void) {
    const items: Item[] = this.notifications.filter((n) => !n.record).map((n) => ({ label: shortClass(n.class), detail: `${n.class}${n.channels ? ` · ${n.channels.join(", ")}` : ""}`, icon: "codicon-mail", run: () => done(n.class) }));
    if (!items.length) return host.status("The app has no notifications that take no record. Make one with Laravel: New Element… (make:notification).");
    pick("Pick a notification", (q) => (q.trim() ? rank(q, items) : items));
  }

  private schedulePrune() {
    if (this.pruneTask()) return host.status("model:prune is scheduled already.");
    return this.addTask({ kind: "command", line: "model:prune" }, { kind: "daily", time: "00:00" }, null, "Scheduled model:prune daily");
  }

  private pruneTask = () => this.sources.flatMap((s) => s.tasks).find((t) => t.what.kind === "command" && /^model:prune\b/.test(t.what.line));

  private reveal(src: Source, offset: number) {
    const lines = src.text.slice(0, offset).split("\n");
    host.openAt(src.path, lines.length, lines[lines.length - 1].length + 1);
  }

  private codeChip(src: Source, span: [number, number], title = "Written as code. Open it to change it.") {
    return h("button", { type: "button", class: "fd-code-chip", title, onclick: () => this.reveal(src, span[0]) }, icon("code"), h("span", {}, src.text.slice(span[0], span[1]).replace(/\s+/g, " ").slice(0, 80)));
  }

  private title(t: Task): string {
    const w = t.what;
    if (w.kind === "command") return w.line;
    if (w.kind === "job") return shortClass(w.job);
    if (w.kind === "notify") return t.name ?? `Send ${shortClass(w.send.notification)}`;
    return t.name ?? `${t.method}()`;
  }

  private runNow(t: Task) {
    if (t.what.kind === "command") return void this.artisan(t.what.line, t.what.line);
    const name = t.name ?? (t.what.kind === "job" ? t.what.job : null);
    // Without a name, schedule:test asks which task to run.
    void this.artisan(`Run ${this.title(t)}`, name ? `schedule:test --name=${shellQuote(name)}` : "schedule:test");
  }

  private taskCard(src: Source, t: Task, i: number): HTMLElement {
    const edit = (build: (text: string, t: Task) => Edit[], message: string) => void this.editTask(src, i, build, message);
    const row = (label: string, editor: HTMLElement | null, hint = "") => (editor ? h("div", { class: "fd-row", title: hint }, h("span", { class: "fd-row-label" }, label), h("div", { class: "fd-row-editor" }, editor), h("span", { class: "fd-row-spacer" })) : null);
    const kindIcon = { command: "terminal", job: "server-process", notify: "mail", code: "code" }[t.what.kind];
    const tools = h(
      "div",
      { class: "fd-card-actions" },
      iconButton("play", "Run now", () => this.runNow(t)),
      iconButton("go-to-file", "Open the code", () => this.reveal(src, t.node.span[0])),
      iconButton("trash", "Remove the task", () => edit((text, task) => [removeTask(text, task)], `Removed ${this.title(t)}`)),
    );
    const o = t.options;
    const flag = (name: "withoutOverlapping" | "onOneServer" | "runInBackground", label: string, hint: string) =>
      h("label", { class: "sd-flag", title: hint }, toggleSwitch(o[name], (on) => edit((text, task) => optionEdits(text, task, name, on ? "" : null), `${label}: ${on ? "on" : "off"}`), label), h("span", {}, label));
    const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    const zone = commitInput(o.timezone ?? "", (z) => edit((text, task) => optionEdits(text, task, "timezone", z.trim() ? phpString(z.trim()) : null), `Time zone: ${z.trim() || "the app's"}`), { placeholder: this.info?.timezone ?? "UTC", list: "sd-zones" });
    const envs = commitInput(o.environments.join(", "), (x) => {
      const list = x.split(",").map((e) => e.trim()).filter(Boolean);
      edit((text, task) => optionEdits(text, task, "environments", list.length ? environmentsCode(list) : null), list.length ? `Runs in ${list.join(", ")}` : "Runs in every environment");
    }, { placeholder: "Every environment" });
    return h(
      "div",
      { class: "wd-stat sd-task" },
      h("div", { class: "wd-stat-head" }, icon(kindIcon), h("strong", { class: "sd-task-title" }, this.title(t)), h("span", { class: "fd-spacer" }), tools),
      h(
        "div",
        { class: "fd-rows" },
        row("Runs", this.whatEditor(src, t, edit)),
        row("When", t.freq ? this.freqEditor(t.freq, (f) => edit((text, task) => freqEdits(text, task, f), `${this.title(t)}: ${describeFreq(f)}`)) : h("span", { class: "fd-note" }, "Written as code the designer can't read.")),
        row("Next runs", this.nextRunsNote(t)),
        row("Time zone", h("div", { class: "wd-inline" }, zone, h("datalist", { id: "sd-zones" }, ...zones.map((z) => h("option", { value: z }))))),
        row("Environments", envs, "Run only in these environments, as APP_ENV names them"),
        row(
          "Options",
          h(
            "div",
            { class: "sd-flags" },
            flag("withoutOverlapping", "Skip while still running", "Don't start the task while its last run is still going"),
            flag("onOneServer", "On one server", "With several servers, run the task on one of them; needs a shared cache, such as Redis or the database"),
            flag("runInBackground", "In the background", "Start the next tasks without waiting for this one; commands only"),
          ),
        ),
        t.other.length ? row("Also", h("div", { class: "wd-inline" }, ...t.other.map((c) => this.codeChip(src, c.span)))) : null,
      ),
    );
  }

  private whatEditor(src: Source, t: Task, edit: (build: (text: string, t: Task) => Edit[], message: string) => void): HTMLElement {
    const w = t.what;
    const set = (next: Exclude<What, { kind: "code" }>, message: string) => edit((text, task) => whatEdits(text, task, next, this.userModel), message);
    if (w.kind === "command") {
      const [name, ...rest] = w.line.split(" ");
      const cmd = this.commands.find((c) => c.name === name);
      const choose = h("button", { type: "button", class: "fd-chip-link", title: cmd?.description ?? "" }, icon("terminal"), name);
      choose.onclick = () => this.pickCommand((n) => set({ kind: "command", line: [n, ...rest].join(" ") }, `Runs ${n}`));
      const args = commitInput(rest.join(" "), (x) => set({ kind: "command", line: [name, x.trim()].filter(Boolean).join(" ") }, "Arguments changed"), { placeholder: "Arguments and options", className: "fd-mono" });
      const sig = cmd ? [...Object.values(cmd.definition.arguments).map((a) => (a.is_required ? `<${a.name}>` : `[${a.name}]`)), ...Object.values(cmd.definition.options).filter((x) => !COMMON.has(x.name)).map((x) => `[${x.name}${x.accept_value ? "=" : ""}]`)].join(" ") : "";
      return h("div", { class: "sd-what" }, h("div", { class: "wd-inline" }, choose, args), sig ? h("span", { class: "fd-note fd-mono" }, sig) : null);
    }
    if (w.kind === "job") {
      const choose = h("button", { type: "button", class: "fd-chip-link", title: w.job }, icon("server-process"), shortClass(w.job));
      choose.onclick = () => this.pickJob((job) => set({ kind: "job", job, args: w.args }, `Runs ${shortClass(job)}`));
      return h("div", { class: "wd-inline" }, choose, w.args !== null ? h("span", { class: "fd-note" }, `with (${w.args})`) : null, h("button", { type: "button", class: "link", onclick: () => this.openClass(w.job) }, "Open the job"));
    }
    if (w.kind === "notify") return this.sendEditor(w.send, (send) => set({ kind: "notify", send }, "Notification changed"));
    // The head call: `Schedule::exec(…)`, or `->exec(…)` on `$schedule`.
    const n = t.node;
    return this.codeChip(src, n.kind !== "chain" ? n.span : n.base.kind === "static" ? n.base.span : n.calls[0].span);
  }

  /** Which notification goes to whom. A scheduled task has no record and no signed-in user, so those recipients aren't offered. */
  private sendEditor(s: Send, set: (s: Send) => void): HTMLElement {
    const choose = h("button", { type: "button", class: "fd-chip-link", title: s.notification }, icon("mail"), shortClass(s.notification));
    choose.onclick = () => this.pickNotification((notification) => set({ ...s, notification }));
    const kinds = RECIPIENTS.filter(([k]) => k === "users" || k === "role" || k === "address" || k === s.recipient.kind);
    const to = h("select", {}, ...kinds.map(([k, l]) => h("option", { value: k, textContent: l, selected: k === s.recipient.kind })));
    to.onchange = () => set({ ...s, recipient: (to.value === "role" ? { kind: "role", role: "admin" } : to.value === "address" ? { kind: "address", email: "" } : { kind: to.value }) as Recipient });
    const r = s.recipient;
    const extra = r.kind === "role" ? commitInput(r.role, (x) => set({ ...s, recipient: { kind: "role", role: x.trim() } }), { placeholder: "Role" }) : r.kind === "address" ? commitInput(r.email, (x) => set({ ...s, recipient: { kind: "address", email: x.trim() } }), { placeholder: "team@example.com", type: "email" }) : null;
    return h("div", { class: "wd-inline" }, choose, h("span", { class: "fd-note" }, "to"), to, extra);
  }

  private async openClass(cls: string) {
    const file = await fapp.fileOfClass(this.root, cls);
    if (file) host.openAt(file, 1);
  }

  private freqEditor(f: Freq, set: (f: Freq) => void): HTMLElement {
    const kinds: [Freq["kind"], string][] = [["minutes", "Every few minutes"], ["hourly", "Hourly"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"], ["cron", "Cron expression"]];
    const kind = h("select", {}, ...kinds.map(([k, l]) => h("option", { value: k, textContent: l, selected: k === f.kind })));
    const time = "time" in f ? f.time : "00:00";
    kind.onchange = () => {
      const k = kind.value as Freq["kind"];
      set(k === "minutes" ? { kind: k, every: 5 } : k === "hourly" ? { kind: k, minute: 0 } : k === "daily" ? { kind: k, time } : k === "weekly" ? { kind: k, day: 1, time } : k === "monthly" ? { kind: k, day: 1, time } : { kind: k, expr: "0 0 * * *" });
    };
    const timeInput = (value: string, done: (v: string) => void) => {
      const input = h("input", { type: "time", value });
      input.onchange = () => input.value && done(input.value);
      return input;
    };
    const num = (value: number, min: number, max: number, done: (v: number) => void) => {
      const input = h("input", { type: "number", min: String(min), max: String(max), value: String(value), class: "wd-count" });
      input.onchange = () => done(Math.max(min, Math.min(max, Math.round(Number(input.value)) || min)));
      return input;
    };
    const note = (t: string) => h("span", { class: "fd-note" }, t);
    let extra: (HTMLElement | null)[] = [];
    if (f.kind === "minutes") {
      const every = h("select", {}, ...[1, 2, 3, 4, 5, 10, 15, 30].map((n) => h("option", { value: String(n), textContent: n === 1 ? "minute" : `${n} minutes`, selected: n === f.every })));
      every.onchange = () => set({ kind: "minutes", every: Number(every.value) });
      extra = [note("every"), every];
    } else if (f.kind === "hourly") extra = [note("at minute"), num(f.minute, 0, 59, (minute) => set({ ...f, minute }))];
    else if (f.kind === "daily") extra = [note("at"), timeInput(f.time, (t) => set({ ...f, time: t }))];
    else if (f.kind === "weekly") {
      const day = h("select", {}, ...DAYS.map((d, n) => h("option", { value: String(n), textContent: d, selected: n === f.day })));
      day.onchange = () => set({ ...f, day: Number(day.value) });
      extra = [note("on"), day, note("at"), timeInput(f.time, (t) => set({ ...f, time: t }))];
    } else if (f.kind === "monthly") extra = [note("on day"), num(f.day, 1, 31, (d) => set({ ...f, day: d })), note("at"), timeInput(f.time, (t) => set({ ...f, time: t }))];
    else extra = [commitInput(f.expr, (x) => x.trim().split(/\s+/).length === 5 ? set({ kind: "cron", expr: x.trim().replace(/\s+/g, " ") }) : host.status("A cron expression has five fields: minute, hour, day of the month, month, and day of the week."), { placeholder: "minute hour day month weekday", className: "fd-mono" })];
    return h("div", { class: "wd-inline" }, kind, ...extra);
  }

  private nextRunsNote(t: Task): HTMLElement {
    if (!t.cron) return h("span", { class: "fd-note" }, "Unknown: the frequency is written as code.");
    const zone = t.options.timezone ?? this.info?.timezone ?? "UTC";
    const runs = nextRuns(t.cron, wallClock(new Date(), zone), 3);
    const fmt = new Intl.DateTimeFormat(undefined, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    // Calls such as when() or between() can skip runs the cron expression allows.
    const conditional = t.other.some((c) => /^(when|skip|between|unlessBetween)$/.test(c.name));
    return h("span", { class: "fd-note sd-runs", title: `Cron: ${t.cron}` }, runs.length ? `${runs.map((d) => fmt.format(d)).join(" · ")} (${zone})${conditional ? ", when its conditions allow" : ""}` : `Cron: ${t.cron}`);
  }

  // ---- Old records ----

  private pruneSection(): HTMLElement {
    const task = this.pruneTask();
    const add = h("button", { type: "button", class: "md-add" }, icon("add"), "Add a model");
    add.onclick = () => {
      const have = new Set(this.prunables.map((p) => p.class));
      const items: Item[] = Object.keys(this.models).filter((c) => !have.has(c)).map((c) => ({ label: shortClass(c), detail: c, icon: "codicon-database", run: () => void this.makePrunable(c) }));
      if (!items.length) return host.status("Every model is prunable already, or the app's models can't be read.");
      pick("Delete old records of a model", (q) => (q.trim() ? rank(q, items) : items));
    };
    return h(
      "section",
      { class: "fd-settings-section" },
      h("h3", {}, icon("trash"), "Old records", h("span", { class: "fd-spacer" }), add),
      h("p", { class: "fd-note" }, "Laravel's model:prune deletes each prunable model's records that match its prunable() query. A model with soft deletes loses them for good."),
      task ? null : h("div", { class: "fd-helper-note" }, icon("info"), h("span", {}, "model:prune isn't scheduled, so nothing deletes these records yet. "), h("button", { type: "button", class: "link", onclick: () => void this.schedulePrune() }, "Schedule it daily")),
      ...this.prunables.map((p) => this.pruneCard(p)),
      this.prunables.length ? null : h("p", { class: "fd-note" }, "No prunable models yet. Add one to delete records, such as cancelled orders, after some days."),
    );
  }

  private pruneCard(p: Prunable): HTMLElement {
    const columns = Object.keys(this.models[p.class]?.columns ?? {});
    const dates = columns.filter((c) => /_at$|date/.test(c));
    const head = h(
      "div",
      { class: "wd-stat-head" },
      icon("database"),
      h("strong", {}, shortClass(p.class)),
      p.trait === "MassPrunable" ? h("span", { class: "fd-chip-static", title: "Deletes with one query, without loading the records or firing their events" }, "Mass prunable") : null,
      h("span", { class: "fd-spacer" }),
      h("div", { class: "fd-card-actions" }, p.path ? iconButton("go-to-file", "Open the model", () => host.openAt(p.path!, 1)) : null, p.path && p.trait === "Prunable" ? iconButton("trash", "Stop deleting old records", () => void this.stopPruning(p)) : null),
    );
    if (!p.prune) return h("div", { class: "wd-stat sd-task" }, head, h("p", { class: "fd-note" }, p.method ? "Its prunable() query is written as code. Open the model to change it." : "It has no prunable() method yet, so model:prune skips it."));
    const pr = p.prune;
    const set = (next: Prune) => void this.setPrune(p, next);
    const column = h("select", {}, ...[...new Set([pr.column, ...dates])].map((c) => h("option", { value: c, textContent: c, selected: c === pr.column })));
    column.onchange = () => set({ ...pr, column: column.value });
    const days = h("input", { type: "number", min: "1", value: String(pr.days), class: "wd-count" });
    days.onchange = () => set({ ...pr, days: Math.max(1, Math.round(Number(days.value)) || pr.days) });
    const wheres = pr.where.map((w, j) => whereRow(w, columns, (next) => set({ ...pr, where: next ? pr.where.map((x, k) => (k === j ? next : x)) : pr.where.filter((_, k) => k !== j) })));
    const addWhere = h("button", { type: "button", class: "link", textContent: "+ Only records where…" });
    addWhere.onclick = () => set({ ...pr, where: [...pr.where, { column: columns.find((c) => /status|state|type/.test(c)) ?? columns[0] ?? "id", op: "=", value: "" }] });
    return h("div", { class: "wd-stat sd-task" }, head, h("div", { class: "wd-metric" }, h("div", { class: "wd-inline" }, h("span", { class: "fd-note" }, "Delete records older than"), days, h("span", { class: "fd-note" }, "days, by"), column), ...wheres, columns.length ? addWhere : null));
  }

  /** Edits a model's class, then reads the prunable models again. */
  private async editModel(cls: string, build: (text: string, c: NonNullable<Outline["classes"][number]>) => Edit[], message: string) {
    const path = await fapp.fileOfClass(this.root, cls);
    if (!path) return host.status(`Can't find ${shortClass(cls)}'s file.`);
    const changed = await editFiles([{ path, build: (text, outline) => {
      const c = outline.classes.find((x) => x.fqn === cls);
      return c ? build(text, c) : null;
    } }], message);
    if (!changed) return;
    fapp.forget(["app:schedule"]);
    try {
      this.info = await fapp.scheduleInfo(this.root);
      await this.readPrunables();
    } catch (e) {
      showError("Can't read the app", e);
    }
    this.render();
  }

  private setPrune(p: Prunable, next: Prune) {
    return this.editModel(p.class, (text, c) => {
      const r = methodNamed(c, "prunable")?.returns;
      return r?.length === 1 ? [replaceNode(text, r[0], prunableCode(next))] : [];
    }, `${shortClass(p.class)}: deletes records older than ${next.days} days`);
  }

  private makePrunable(cls: string) {
    const date = Object.keys(this.models[cls]?.columns ?? {}).includes("created_at") ? "created_at" : (Object.keys(this.models[cls]?.columns ?? {}).find((c) => /_at$/.test(c)) ?? "created_at");
    const prune: Prune = { where: [], column: date, days: 90 };
    return this.editModel(cls, (text, c) => {
      const m = methodNamed(c, "prunable");
      return [...traitsEdits(text, c, [PRUNABLE]), m?.returns.length === 1 ? replaceNode(text, m.returns[0], prunableCode(prune)) : addMember(text, c, prunableMethod(prune))];
    }, `${shortClass(cls)}: deletes records older than 90 days`);
  }

  private stopPruning(p: Prunable) {
    return this.editModel(p.class, (text, c) => {
      const m = methodNamed(c, "prunable");
      return [...removeTraitEdits(text, c, PRUNABLE), ...(m ? [removeMethod(text, m)] : [])];
    }, `${shortClass(p.class)} keeps its old records`);
  }
}
