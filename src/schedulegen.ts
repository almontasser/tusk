// Scheduled tasks for the schedule designer: where a project keeps its schedule (routes/console.php, the
// withSchedule() closure in bootstrap/app.php, or the older Console Kernel's schedule()), each task's what, when,
// and options read from its chain of calls and changed one call at a time, the cron expression Laravel builds from
// the frequency calls with the next times it matches, and old records pruned through Laravel's Prunable. Code the
// designer doesn't write stays as code. No editor imports, so Node tests it.
import { type Send, readSend, sendCode } from "./notifysend.ts";
import { type Edit, indentCode, indentUnit, lineIndent, nodeValue, type OClass, type OMethod, type Outline, type PArgs, type PCall, type PNode, phpString, removeCall, replaceNode, setCall, type Span, type Statement } from "./phpcode.ts";
import { queryCode, readQuery, squash, type Where } from "./widgetgen.ts";

export const SCHEDULE = "Illuminate\\Support\\Facades\\Schedule";

// ---- Where the schedule is ----

/**
 * A place that holds tasks: routes/console.php's own statements on the Schedule facade, or the statements of
 * bootstrap/app.php's `withSchedule()` closure or a Console Kernel's `schedule()`, on their `$schedule` parameter.
 */
export type Place = { kind: "console" | "app" | "kernel"; statements: Statement[]; variable: string | null; body: Span | null };

/** The place in a file's outline, or null when the file holds none. */
export function findPlace(kind: Place["kind"], outline: Outline): Place | null {
  if (kind === "console") return { kind, statements: outline.statements ?? [], variable: null, body: null };
  if (kind === "app") {
    for (const r of outline.returns ?? []) {
      const call = r.kind === "chain" ? r.calls.find((c) => c.name === "withSchedule") : undefined;
      const fn = call?.args.items[0]?.value;
      if (fn?.kind === "closure" && !fn.arrow && fn.params[0]) return { kind, statements: fn.statements ?? [], variable: fn.params[0], body: fn.body };
    }
    return null;
  }
  const m = outline.classes.flatMap((c: OClass) => c.methods).find((x: OMethod) => x.name === "schedule" && x.params.length);
  return m?.body ? { kind, statements: m.statements ?? [], variable: m.params[0].name, body: m.body } : null;
}

// ---- Tasks ----

export type What =
  /** An Artisan command with its arguments, as one string: `reports:send --weekly`. */
  | { kind: "command"; line: string }
  /** A queued job class, with its constructor's arguments when it has any (kept as written). */
  | { kind: "job"; job: string; args: string | null }
  /** A closure that sends a notification, the one statement src/notifysend.ts writes, about no record. */
  | { kind: "notify"; send: Send }
  /** Anything else, such as a closure of the app's own or `exec()`. */
  | { kind: "code" };

export type Freq =
  | { kind: "minutes"; every: number }
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; day: number; time: string }
  | { kind: "monthly"; day: number; time: string }
  | { kind: "cron"; expr: string };

export type Options = { timezone: string | null; withoutOverlapping: boolean; onOneServer: boolean; runInBackground: boolean; environments: string[] };

export type Task = {
  /** The statement's expression. */
  node: PNode;
  /** The call that says what runs: `command`, `job`, `call`, or `exec`. */
  method: string;
  what: What;
  /** The cron expression the frequency calls build, or null when they're code the designer can't read. */
  cron: string | null;
  freq: Freq | null;
  options: Options;
  /** The task's `name()` or `description()`. */
  name: string | null;
  /** Calls the designer doesn't write, such as `when()` or `emailOutputTo()`; they stay as written. */
  other: PCall[];
};

const MINUTES: Record<number, string> = { 1: "everyMinute", 2: "everyTwoMinutes", 3: "everyThreeMinutes", 4: "everyFourMinutes", 5: "everyFiveMinutes", 10: "everyTenMinutes", 15: "everyFifteenMinutes", 30: "everyThirtyMinutes" };
const HOURS: Record<string, string> = { everyOddHour: "1-23/2", everyTwoHours: "*/2", everyThreeHours: "*/3", everyFourHours: "*/4", everySixHours: "*/6" };
const DAYS: Record<string, string> = { weekdays: "1-5", weekends: "6,0", sundays: "0", mondays: "1", tuesdays: "2", wednesdays: "3", thursdays: "4", fridays: "5", saturdays: "6" };
const DAY_CONSTS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
const FREQ = new Set([...Object.values(MINUTES), ...Object.keys(HOURS), ...Object.keys(DAYS), "cron", "hourly", "hourlyAt", "daily", "at", "dailyAt", "twiceDaily", "twiceDailyAt", "weekly", "weeklyOn", "monthly", "monthlyOn", "twiceMonthly", "lastDayOfMonth", "daysOfMonth", "quarterly", "quarterlyOn", "yearly", "yearlyOn", "days"]);
const OPTIONS = new Set(["timezone", "withoutOverlapping", "onOneServer", "runInBackground", "environments", "name", "description"]);

/** A frequency call's argument as Laravel takes it: a number, a string, or `Schedule::MONDAY`. */
function argValue(node: PNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.kind === "classConst" && /(^|\\)Schedule$/.test(node.class) && DAY_CONSTS.includes(node.name)) return String(DAY_CONSTS.indexOf(node.name));
  const v = nodeValue(node);
  if (Array.isArray(v) && v.every((x) => typeof x === "number" || typeof x === "string")) return v.join(",");
  return typeof v === "number" || typeof v === "string" ? String(v) : undefined;
}

/**
 * The cron expression of a chain's frequency calls, built in order as Laravel's ManagesFrequencies does, or null
 * when one can't be read, such as an argument from a variable or a seconds-based frequency.
 */
export function cronOf(calls: PCall[]): string | null {
  let f = ["*", "*", "*", "*", "*"];
  const set = (pos: number, v: string) => (f[pos - 1] = v);
  const at = (time: string) => {
    const [h, m] = time.split(":");
    set(1, m === undefined ? "0" : String(parseInt(m, 10) || 0));
    set(2, String(parseInt(h, 10) || 0));
  };
  for (const c of calls) {
    if (!FREQ.has(c.name)) continue;
    const a = c.args.items.map((i) => (i.spread ? undefined : argValue(i.value)));
    if (a.some((x) => x === undefined)) return null;
    const arg = (i: number, d: string) => (a[i] as string | undefined) ?? d;
    const n = c.name;
    const every = Object.entries(MINUTES).find(([, name]) => name === n);
    if (every) set(1, every[0] === "1" ? "*" : `*/${every[0]}`);
    else if (HOURS[n]) (set(1, arg(0, "0")), set(2, HOURS[n]));
    else if (DAYS[n]) set(5, DAYS[n]);
    else if (n === "cron") {
      const parts = arg(0, "").trim().split(/\s+/);
      if (parts.length !== 5) return null;
      f = parts;
    } else if (n === "hourly") set(1, "0");
    else if (n === "hourlyAt") (set(1, arg(0, "0")), set(2, "*"));
    else if (n === "daily") (set(1, "0"), set(2, "0"));
    else if (n === "at" || n === "dailyAt") at(arg(0, "0:0"));
    else if (n === "twiceDaily" || n === "twiceDailyAt") (set(1, arg(2, "0")), set(2, `${arg(0, "1")},${arg(1, "13")}`));
    else if (n === "weekly") (set(1, "0"), set(2, "0"), set(5, "0"));
    else if (n === "weeklyOn") (at(arg(1, "0:0")), set(5, a.slice(0, 1).join(",")));
    else if (n === "monthly") (set(1, "0"), set(2, "0"), set(3, "1"));
    else if (n === "monthlyOn") (at(arg(1, "0:0")), set(3, arg(0, "1")));
    else if (n === "twiceMonthly") (at(arg(2, "0:0")), set(3, `${arg(0, "1")},${arg(1, "16")}`));
    else if (n === "daysOfMonth") (at("0:0"), set(3, a.join(",")));
    else if (n === "quarterly") (set(1, "0"), set(2, "0"), set(3, "1"), set(4, "1-12/3"));
    else if (n === "quarterlyOn") (at(arg(1, "0:0")), set(3, arg(0, "1")), set(4, "1-12/3"));
    else if (n === "yearly") (set(1, "0"), set(2, "0"), set(3, "1"), set(4, "1"));
    else if (n === "yearlyOn") (at(arg(2, "0:0")), set(3, arg(1, "1")), set(4, arg(0, "1")));
    else if (n === "days") set(5, a.join(","));
    // lastDayOfMonth() depends on the month the app boots in.
    else return null;
  }
  return f.join(" ");
}

const hhmm = (h: string, m: string) => `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;

/** The designer's frequency for a cron expression; anything that isn't one of its shapes is a cron frequency. */
export function freqOf(cron: string): Freq {
  const [mi, h, dom, mo, dow] = cron.split(" ");
  const num = (s: string) => /^\d+$/.test(s);
  if (h === "*" && dom === "*" && mo === "*" && dow === "*") {
    if (mi === "*") return { kind: "minutes", every: 1 };
    const step = /^\*\/(\d+)$/.exec(mi);
    if (step && MINUTES[Number(step[1])]) return { kind: "minutes", every: Number(step[1]) };
    if (num(mi)) return { kind: "hourly", minute: Number(mi) };
  }
  if (num(mi) && num(h) && mo === "*") {
    const time = hhmm(h, mi);
    if (dom === "*" && dow === "*") return { kind: "daily", time };
    if (dom === "*" && /^[0-6]$/.test(dow)) return { kind: "weekly", day: Number(dow), time };
    if (num(dom) && dow === "*") return { kind: "monthly", day: Number(dom), time };
  }
  return { kind: "cron", expr: cron };
}

/** The call that writes a frequency, with its arguments' code. */
export function freqCall(f: Freq): [string, string] {
  switch (f.kind) {
    case "minutes":
      return [MINUTES[f.every] ?? "everyMinute", ""];
    case "hourly":
      return f.minute ? ["hourlyAt", String(f.minute)] : ["hourly", ""];
    case "daily":
      return f.time === "00:00" ? ["daily", ""] : ["dailyAt", phpString(f.time)];
    case "weekly":
      return ["weeklyOn", `${f.day}, ${phpString(f.time)}`];
    case "monthly":
      return ["monthlyOn", `${f.day}, ${phpString(f.time)}`];
    case "cron":
      return ["cron", phpString(f.expr)];
  }
}

/** The task's head: the call that says what runs, its arguments, and the calls after it. */
function head(node: PNode, place: Place): { method: string; args: PArgs; calls: PCall[] } | null {
  const base = node.kind === "chain" ? node.base : node;
  const calls = node.kind === "chain" ? node.calls : [];
  if (place.variable === null) return base.kind === "static" && base.class === SCHEDULE ? { method: base.method, args: base.args, calls } : null;
  return base.kind === "var" && base.name === place.variable && calls[0] ? { method: calls[0].name, args: calls[0].args, calls: calls.slice(1) } : null;
}

/**
 * The tasks of a place, in order, with the statements that aren't tasks left out. `resolve` names a class as the
 * file writes it, for reading a notification's statement.
 */
export function readTasks(text: string, place: Place, resolve: (name: string) => string): Task[] {
  const tasks: Task[] = [];
  for (const s of place.statements) {
    const hd = s.assigns === null ? head(s.value, place) : null;
    if (!hd || !["command", "job", "call", "exec"].includes(hd.method)) continue;
    const first = hd.args.items[0]?.value;
    let what: What = { kind: "code" };
    if (hd.method === "command" && hd.args.items.length === 1 && first?.kind === "string" && !first.interpolated) what = { kind: "command", line: first.value };
    else if (hd.method === "job" && first?.kind === "new") what = { kind: "job", job: first.class, args: first.args?.items.length ? text.slice(first.args.open + 1, first.args.close) : null };
    else if (hd.method === "job" && first?.kind === "classConst" && first.name === "class") what = { kind: "job", job: first.class, args: null };
    else if (hd.method === "call" && hd.args.items.length === 1 && first?.kind === "closure" && !first.arrow && !first.params.length) {
      const send = readSend(text.slice(first.body[0], first.body[1]), resolve);
      if (send && !send.withRecord) what = { kind: "notify", send };
    }
    const call = (name: string) => [...hd.calls].reverse().find((c) => c.name === name);
    const str = (c: PCall | undefined) => {
      const v = nodeValue(c?.args.items[0]?.value);
      return typeof v === "string" ? v : null;
    };
    const env = call("environments");
    const envValues = env ? env.args.items.flatMap((i) => [nodeValue(i.value)].flat()).filter((v): v is string => typeof v === "string") : [];
    const cron = cronOf(hd.calls);
    tasks.push({
      node: s.value,
      method: hd.method,
      what,
      cron,
      freq: cron ? freqOf(cron) : null,
      options: { timezone: str(call("timezone")), withoutOverlapping: !!call("withoutOverlapping"), onOneServer: !!call("onOneServer"), runInBackground: !!call("runInBackground"), environments: envValues },
      name: str(call("name")) ?? str(call("description")),
      other: hd.calls.filter((c) => !FREQ.has(c.name) && !OPTIONS.has(c.name)),
    });
  }
  return tasks;
}

/** The calls after a task's head. */
const callsAfterHead = (t: Task) => (t.node.kind === "chain" ? t.node.calls.slice(t.node.base.kind === "var" ? 1 : 0) : []);

/** Sets a call on a task, or adds it; a task with no calls after its head gets it on the same line. */
function putCall(text: string, t: Task, name: string, args: string): Edit {
  if (callsAfterHead(t).length) return setCall(text, t.node, name, args);
  return { start: t.node.span[1], end: t.node.span[1], text: `->${name}(${args})` };
}

/** Edits that make a task run at `f`: the first frequency call becomes the new one, and the others go. */
export function freqEdits(text: string, t: Task, f: Freq): Edit[] {
  const [name, args] = freqCall(f);
  const calls = callsAfterHead(t).filter((c) => FREQ.has(c.name));
  if (!calls.length) return [putCall(text, t, name, args)];
  return [{ start: calls[0].nameSpan[0], end: calls[0].span[1], text: `${name}(${args})` }, ...calls.slice(1).map((c) => removeCall(t.node, c))];
}

/** Sets an option's call (`args` is its arguments' code), or removes it when `args` is null. */
export function optionEdits(text: string, t: Task, name: string, args: string | null): Edit[] {
  const existing = callsAfterHead(t).filter((c) => c.name === name);
  if (args === null) return existing.map((c) => removeCall(t.node, c));
  if (existing.length && name !== "timezone" && name !== "environments" && name !== "name") return [];
  return [putCall(text, t, name, args)];
}

/** The environments' code: `['production', 'staging']`. */
export const environmentsCode = (envs: string[]) => `[${envs.map(phpString).join(", ")}]`;

/** The arguments of a task's head for what it runs. */
export function whatArgs(w: Exclude<What, { kind: "code" }>, userModel: string): string {
  if (w.kind === "command") return phpString(w.line);
  if (w.kind === "job") return `new {{${w.job.replace(/^\\/, "")}}}${w.args ? `(${w.args})` : ""}`;
  return `function () {\n    ${indentCode(sendCode(w.send, userModel), "    ")}\n}`;
}

export const methodOf = (w: Exclude<What, { kind: "code" }>) => (w.kind === "notify" ? "call" : w.kind);

/** Edits that change what a task runs, keeping a job's extra arguments, such as its queue. */
export function whatEdits(text: string, t: Task, w: Exclude<What, { kind: "code" }>, userModel: string): Edit[] {
  const node = t.node;
  const base = node.kind === "chain" ? node.base : node;
  const [nameStart, args] = base.kind === "static" ? [text.indexOf(t.method, base.classSpan[1]), base.args] : node.kind === "chain" ? [node.calls[0].nameSpan[0], node.calls[0].args] : [-1, null];
  if (!args) return [];
  // Another kind of task gets a new head call with only its own arguments.
  if (methodOf(w) !== t.method || !args.items[0]) return [{ start: nameStart, end: args.close, text: `${methodOf(w)}(${indentCode(whatArgs(w, userModel), lineIndent(text, node.span[0]))}` }];
  return [replaceNode(text, args.items[0].value, whatArgs(w, userModel))];
}

/** A new task's statement, without its `;`: on the Schedule facade, or on the place's variable. */
export function taskCode(w: Exclude<What, { kind: "code" }>, f: Freq, place: Place, userModel: string, name: string | null = null): string {
  const [freq, args] = freqCall(f);
  const target = place.variable === null ? `{{${SCHEDULE}}}::` : `$${place.variable}->`;
  return `${target}${methodOf(w)}(${whatArgs(w, userModel)})${name ? `->name(${phpString(name)})` : ""}->${freq}(${args})`;
}

/** Inserts a statement after the place's last statement, or at the end of routes/console.php. */
export function insertTask(text: string, place: Place, code: string): Edit {
  const last = place.statements.at(-1);
  if (last) {
    const semi = text.indexOf(";", last.value.span[1]);
    const at = semi < 0 ? last.value.span[1] : semi + 1;
    const indent = lineIndent(text, last.value.span[0]);
    return { start: at, end: at, text: `\n${place.body ? "" : "\n"}${indent}${indentCode(code, indent)};` };
  }
  if (place.body) {
    const indent = lineIndent(text, place.body[0]) + indentUnit(text);
    // An empty body, perhaps with a `//` placeholder: the task goes on its own line before the closing brace.
    let end = place.body[1];
    while (end > place.body[0] && /[ \t]/.test(text[end - 1])) end--;
    const lead = text[end - 1] === "\n" ? "" : "\n";
    return { start: end, end, text: `${lead}${indent}${indentCode(code, indent)};\n` };
  }
  const end = text.trimEnd().length;
  return { start: end, end: text.length, text: `\n\n${code};\n` };
}

/** Removes a task's statement with its line. */
export function removeTask(text: string, t: Task): Edit {
  const start = text.lastIndexOf("\n", t.node.span[0] - 1);
  const semi = text.indexOf(";", t.node.span[1]);
  let end = semi < 0 ? t.node.span[1] : semi + 1;
  // A blank line left between two statements goes too, when the one before was blank as well.
  if (/^\n[ \t]*\n/.test(text.slice(end)) && /\n[ \t]*$/.test(text.slice(0, start))) end = text.indexOf("\n", end + 1);
  return { start: Math.max(start, 0), end, text: "" };
}

// ---- Next runs ----

/** The values a cron field allows, or null when it isn't one the designer reads (such as `MON` or `L`). */
function field(spec: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const from = m[1] === "*" ? min : Number(m[2]);
    const to = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : from;
    const step = m[4] ? Number(m[4]) : 1;
    if (from < min || to > max || from > to || step < 1) return null;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

/**
 * The next `count` times a cron expression matches after `from`, a wall clock carried in a Date's UTC fields (see
 * `wallClock`). A day matches its day of the month or of the week when both are set, as cron does. Empty when the
 * expression can't be read.
 */
export function nextRuns(cron: string, from: Date, count = 3): Date[] {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return [];
  const [mi, h, dom, mo, dow] = [field(parts[0], 0, 59), field(parts[1], 0, 23), field(parts[2], 1, 31), field(parts[3], 1, 12), field(parts[4], 0, 7)];
  if (!mi || !h || !dom || !mo || !dow) return [];
  if (dow.has(7)) dow.add(0);
  const anyDom = parts[2] === "*";
  const anyDow = parts[4] === "*";
  const dayOk = (d: Date) => (anyDom || anyDow ? dom.has(d.getUTCDate()) && dow.has(d.getUTCDay()) : dom.has(d.getUTCDate()) || dow.has(d.getUTCDay()));
  const t = new Date(from.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  const out: Date[] = [];
  // Five years covers every expression that can match, such as February 29th.
  const limit = from.getTime() + 5 * 366 * 864e5;
  while (out.length < count && t.getTime() < limit) {
    if (!mo.has(t.getUTCMonth() + 1)) t.setUTCMonth(t.getUTCMonth() + 1, 1), t.setUTCHours(0, 0);
    else if (!dayOk(t)) t.setUTCDate(t.getUTCDate() + 1), t.setUTCHours(0, 0);
    else if (!h.has(t.getUTCHours())) t.setUTCHours(t.getUTCHours() + 1, 0);
    else if (!mi.has(t.getUTCMinutes())) t.setUTCMinutes(t.getUTCMinutes() + 1);
    else out.push(new Date(t.getTime())), t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  return out;
}

/** The wall clock in a time zone at `now`, carried in a Date's UTC fields. An unknown zone gives UTC's. */
export function wallClock(now: Date, timeZone: string): Date {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(now);
  } catch {
    return now;
  }
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return new Date(Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute")));
}

/** A frequency in words: "Every day at 08:00". */
export function describeFreq(f: Freq): string {
  const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  switch (f.kind) {
    case "minutes":
      return f.every === 1 ? "Every minute" : `Every ${f.every} minutes`;
    case "hourly":
      return f.minute ? `Every hour at ${f.minute} past` : "Every hour";
    case "daily":
      return `Every day at ${f.time}`;
    case "weekly":
      return `Every ${day[f.day]} at ${f.time}`;
    case "monthly":
      return `Monthly on day ${f.day} at ${f.time}`;
    case "cron":
      return `Cron: ${f.expr}`;
  }
}

// ---- Pruning old records ----

export const PRUNABLE = "Illuminate\\Database\\Eloquent\\Prunable";
export const MASS_PRUNABLE = "Illuminate\\Database\\Eloquent\\MassPrunable";
export const BUILDER = "Illuminate\\Database\\Eloquent\\Builder";

/** Which records `model:prune` deletes: those that match, older than `days` by a date column. */
export type Prune = { where: Where[]; column: string; days: number };

/** `prunable()`'s query. */
export function prunableCode(p: Prune): string {
  const q = queryCode({ model: "M", agg: "count", column: null, where: p.where, days: null }).replace(/^\{\{M\}\}::query\(\)/, "static::query()");
  return `${q}->where(${phpString(p.column)}, '<=', now()->subDays(${p.days}))`;
}

/** Reads a `prunable()` query the designer writes, also as `static::where(…)`. Anything else is null. */
export function readPrunable(code: string): Prune | null {
  const c = squash(code.trim()).replace(/^static::where\(/, "static::query()->where(");
  const q = readQuery(c);
  if (!q || q.m.model !== "static" || q.m.days) return null;
  const x = /^->where\('(\w+)', '<=', now\(\)->subDays\((\d+)\)\)$/.exec(q.rest);
  return x ? { where: q.m.where, column: x[1], days: Number(x[2]) } : null;
}

/** The `prunable()` method for a model. */
export const prunableMethod = (p: Prune) => `/**\n * The records \`php artisan model:prune\` deletes.\n */\npublic function prunable(): {{${BUILDER}}}\n{\n    return ${prunableCode(p)};\n}`;
