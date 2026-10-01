import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./designerfixture.ts";
import { applyEdits, type Edit } from "./phpcode.ts";
import { cronOf, findPlace, freqEdits, freqOf, insertTask, nextRuns, optionEdits, prunableCode, readPrunable, readTasks, removeTask, taskCode, wallClock, whatEdits } from "./schedulegen.ts";

const resolve = (name: string) => (name === "User" ? "App\\Models\\User" : name === "WeeklyReport" ? "App\\Notifications\\WeeklyReport" : name);
const fill = (text: string, edits: Edit[]) => applyEdits(text, edits).replace(/\{\{[\w\\]*?(\w+)\}\}/g, "$1");
const load = (name: string, kind: "console" | "app" | "kernel") => {
  const f = fixture(name);
  const place = findPlace(kind, f.outline)!;
  return { text: f.text, place, tasks: readTasks(f.text, place, resolve) };
};

test("tasks read from routes/console.php", () => {
  const { tasks } = load("ScheduleConsole", "console");
  assert.equal(tasks.length, 5);
  const [report, beat, notify, prune, exec] = tasks;
  assert.deepEqual(report.what, { kind: "command", line: "reports:send --weekly" });
  assert.equal(report.cron, "0 8 * * 1");
  assert.deepEqual(report.freq, { kind: "weekly", day: 1, time: "08:00" });
  assert.equal(report.options.timezone, "Europe/Berlin");
  assert.equal(report.options.withoutOverlapping, true);
  assert.deepEqual(beat.what, { kind: "job", job: "App\\Jobs\\Heartbeat", args: null });
  assert.deepEqual(beat.freq, { kind: "minutes", every: 5 });
  assert.equal(beat.options.onOneServer, true);
  assert.deepEqual(notify.what, { kind: "notify", send: { notification: "App\\Notifications\\WeeklyReport", recipient: { kind: "users" }, withRecord: false } });
  assert.equal(notify.name, "Send WeeklyReport");
  assert.equal(notify.cron, "0 17 * * 1-5");
  assert.equal(notify.freq?.kind, "cron");
  // No frequency runs every minute, as Laravel does.
  assert.equal(prune.cron, "* * * * *");
  assert.equal(exec.what.kind, "code");
  assert.deepEqual(exec.other.map((c) => c.name), ["when"]);
});

test("tasks read from a Kernel and an empty withSchedule()", () => {
  const k = load("ScheduleKernel", "kernel");
  assert.equal(k.place.variable, "schedule");
  assert.deepEqual(k.tasks[0].what, { kind: "command", line: "backup:run" });
  assert.deepEqual(k.tasks[0].freq, { kind: "daily", time: "02:30" });
  assert.deepEqual(k.tasks[0].options.environments, ["production"]);
  const a = load("ScheduleApp", "app");
  assert.equal(a.tasks.length, 0);
  const code = taskCode({ kind: "job", job: "App\\Jobs\\Ping", args: null }, { kind: "hourly", minute: 0 }, a.place, "App\\Models\\User");
  assert.equal(code, "$schedule->job(new {{App\\Jobs\\Ping}})->hourly()");
  assert.match(fill(a.text, [insertTask(a.text, a.place, code)]), /\/\/\n {8}\$schedule->job\(new Ping\)->hourly\(\);\n {4}\}\)/);
});

test("frequency and option edits", () => {
  const { text, tasks } = load("ScheduleConsole", "console");
  const [report, beat, notify, prune] = tasks;
  assert.match(fill(text, freqEdits(text, report, { kind: "daily", time: "00:00" })), /Schedule::command\('reports:send --weekly'\)->daily\(\)->timezone/);
  // Two frequency calls become one.
  assert.match(fill(text, freqEdits(text, notify, { kind: "monthly", day: 3, time: "09:30" })), /->name\('Send WeeklyReport'\)->monthlyOn\(3, '09:30'\);/);
  assert.match(fill(text, freqEdits(text, prune, { kind: "cron", expr: "0 */2 * * *" })), /Schedule::command\('model:prune'\)->cron\('0 \*\/2 \* \* \*'\);/);
  assert.match(fill(text, optionEdits(text, beat, "onOneServer", null)), /->everyFiveMinutes\(\);/);
  assert.match(fill(text, optionEdits(text, beat, "runInBackground", "")), /->onOneServer\(\)\n {4}->runInBackground\(\);/);
  assert.match(fill(text, optionEdits(text, report, "timezone", "'UTC'")), /->timezone\('UTC'\)/);
});

test("what a task runs changes in place", () => {
  const { text, tasks } = load("ScheduleConsole", "console");
  const [report, beat] = tasks;
  assert.match(fill(text, whatEdits(text, report, { kind: "command", line: "backup:clean" }, "App\\Models\\User")), /Schedule::command\('backup:clean'\)->weeklyOn/);
  // The job's queue stays.
  assert.match(fill(text, whatEdits(text, beat, { kind: "job", job: "App\\Jobs\\Ping", args: null }, "App\\Models\\User")), /Schedule::job\(new Ping, 'heartbeats'\)/);
  const notify = { kind: "notify" as const, send: { notification: "App\\Notifications\\Digest", recipient: { kind: "role" as const, role: "admin" }, withRecord: false } };
  const out = fill(text, whatEdits(text, report, notify, "App\\Models\\User"));
  assert.match(out, /Schedule::call\(function \(\) \{\n {4}Notification::send\(User::role\('admin'\)->get\(\), new Digest\(\)\);\n\}\)->weeklyOn/);
});

test("removing and adding tasks", () => {
  const { text, place, tasks } = load("ScheduleConsole", "console");
  const out = applyEdits(text, [removeTask(text, tasks[3])]);
  assert.ok(!out.includes("model:prune"));
  assert.match(out, /->at\('17:00'\);\n\nSchedule::exec/);
  const added = fill(text, [insertTask(text, place, taskCode({ kind: "command", line: "model:prune" }, { kind: "daily", time: "00:00" }, place, "User"))]);
  assert.match(added, /->when\(fn \(\) => true\);\n\nSchedule::command\('model:prune'\)->daily\(\);\n$/);
});

test("cron from Laravel's frequency calls", () => {
  const { tasks } = load("ScheduleConsole", "console");
  assert.equal(cronOf([]), "* * * * *");
  assert.equal(tasks[4].cron, "0 0 * * *");
  assert.deepEqual(freqOf("30 * * * *"), { kind: "hourly", minute: 30 });
  assert.deepEqual(freqOf("0 0 1 * *"), { kind: "monthly", day: 1, time: "00:00" });
  assert.deepEqual(freqOf("*/15 * * * *"), { kind: "minutes", every: 15 });
  assert.deepEqual(freqOf("0 0 1 1-12/3 *"), { kind: "cron", expr: "0 0 1 1-12/3 *" });
});

test("next runs", () => {
  const from = new Date(Date.UTC(2026, 9, 1, 10, 7)); // Thursday, October 1st 2026, 10:07
  const iso = (ds: Date[]) => ds.map((d) => d.toISOString().slice(0, 16));
  assert.deepEqual(iso(nextRuns("0 8 * * 1", from)), ["2026-10-05T08:00", "2026-10-12T08:00", "2026-10-19T08:00"]);
  assert.deepEqual(iso(nextRuns("*/5 * * * *", from, 2)), ["2026-10-01T10:10", "2026-10-01T10:15"]);
  assert.deepEqual(iso(nextRuns("0 17 * * 1-5", from, 3)), ["2026-10-01T17:00", "2026-10-02T17:00", "2026-10-05T17:00"]);
  assert.deepEqual(iso(nextRuns("0 0 29 2 *", from, 1)), ["2028-02-29T00:00"]);
  // Both days set: either matches.
  assert.deepEqual(iso(nextRuns("0 0 15 * 0", from, 2)), ["2026-10-04T00:00", "2026-10-11T00:00"]);
  assert.deepEqual(nextRuns("0 0 L * *", from), []);
  assert.equal(wallClock(new Date(Date.UTC(2026, 0, 1, 12, 0)), "Asia/Tokyo").getUTCHours(), 21);
  assert.equal(wallClock(new Date(Date.UTC(2026, 0, 1, 12, 0)), "Nowhere/Else").getUTCHours(), 12);
});

test("prunable queries", () => {
  const f = fixture("PrunableOrder");
  const m = f.outline.classes[0].methods.find((x) => x.name === "prunable")!;
  const r = m.returns[0];
  const p = readPrunable(f.text.slice(r.span[0], r.span[1]));
  assert.deepEqual(p, { where: [{ column: "status", op: "=", value: "cancelled" }], column: "created_at", days: 90 });
  assert.equal(prunableCode(p!), "static::query()->where('status', 'cancelled')->where('created_at', '<=', now()->subDays(90))");
  assert.deepEqual(readPrunable(prunableCode({ where: [], column: "archived_at", days: 30 })), { where: [], column: "archived_at", days: 30 });
  assert.equal(readPrunable("static::where('created_at', '<=', now()->subMonth())"), null);
});
