/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { groupQueries, hotSpots, parseCachegrind, parseSqlTrace, phpList, withBindings } from "./cachegrind.ts";

const profile = parseCachegrind(readFileSync(new URL("./cachegrind.fixture.txt", import.meta.url), "utf8"));
const fn = (name: string) => profile.functions.find((f) => f.name === name)!;
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

test("reads each function's calls, self time, and total time", () => {
  assert.equal(profile.command, "/app/demo.php");
  assert.equal(fn("Greeter->greet").calls, 3);
  assert.equal(fn("Greeter->greet").file, "/app/demo.php");
  assert.equal(fn("Greeter->greet").line, 4);
  assert.equal(fn("php::strtoupper").file, "php:internal");
  close(fn("Greeter->greet").self, (658 + 158 + 53) / 100_000);
  close(fn("Greeter->greet").inclusive, (658 + 42 + 146 + 158 + 8 + 4 + 53 + 4 + 1) / 100_000);
  close(profile.total, (2817 + 846 + 171 + 58 + 754) / 100_000);
});

test("counts recursion once", () => {
  assert.equal(fn("fib").calls, 15);
  // Only the outer fib(5) call counts: its own time plus the calls under it, which {main} saw as 754 units
  // (Xdebug times a call and its parts separately, so they differ slightly).
  assert.ok(Math.abs(fn("fib").inclusive - 754 / 100_000) < 754 / 100_000 / 100);
});

test("counts recursion through another function once", () => {
  // {main} calls a, a calls b, and b calls a again. Each block is written when its call returns.
  const text = ["events: Time_(10ns)", "fl=(1) /x.php", "fn=(1) a", "1 10", "", "fl=(1)", "fn=(2) b", "1 20", "cfl=(1)", "cfn=(1)", "calls=1 0 0", "1 10", "",
    "fl=(1)", "fn=(1)", "1 30", "cfl=(1)", "cfn=(2)", "calls=1 0 0", "1 30", "", "fl=(1)", "fn=(3) {main}", "1 5", "cfl=(1)", "cfn=(1)", "calls=1 0 0", "1 60", ""].join("\n");
  const p = parseCachegrind(text);
  const get = (name: string) => p.functions.find((f) => f.name === name)!;
  close(get("a").inclusive, 60 / 100_000); // The outer call only, not 60 + 10.
  close(get("b").inclusive, 30 / 100_000);
  close(get("a").self, 40 / 100_000);
  close(p.total, 65 / 100_000);
});

test("lists each function's callers and callees", () => {
  const greet = fn("Greeter->greet");
  assert.deepEqual(greet.callees.map((c) => [c.fn.name, c.calls]).sort(), [["php::str_repeat", 3], ["php::strtoupper", 3]]);
  close(greet.callees.find((c) => c.fn.name === "php::strtoupper")!.time, (42 + 8 + 4) / 100_000);
  assert.deepEqual(greet.callers.map((c) => [c.fn.name, c.calls]), [["{main}", 3]]);
  assert.deepEqual(fn("fib").callers.map((c) => c.fn.name).sort(), ["fib", "{main}"]);
});

test("reads memory, and the time of calls made from each line", () => {
  // Each Greeter->greet call grew memory by 48 bytes itself, and its two calls by 32 and 40.
  assert.equal(fn("Greeter->greet").memory, 3 * (48 + 32 + 40));
  const line5 = profile.sites.get("/app/demo.php")!.get(5)!;
  assert.equal(line5.calls, 6); // strtoupper and str_repeat, three times each
  close(line5.time, (42 + 146 + 8 + 4 + 4 + 1) / 100_000);
  assert.equal(profile.sites.get("/app/demo.php")!.get(9)!.calls, 3); // $g->greet() in the loop
});

test("keeps the call tree, merging calls along the same path", () => {
  const [main] = profile.tree;
  assert.equal(main.fn.name, "{main}");
  assert.equal(profile.tree.length, 1);
  const greet = main.children.find((n) => n.fn.name === "Greeter->greet")!;
  assert.equal(greet.calls, 3);
  close(greet.time, (658 + 42 + 146 + 158 + 8 + 4 + 53 + 4 + 1) / 100_000);
  assert.deepEqual(greet.children.map((n) => [n.fn.name, n.calls]).sort(), [["php::str_repeat", 3], ["php::strtoupper", 3]]);
  // fib(5) under {main}, then fib under fib, as deep as the recursion went.
  let depth = 0;
  for (let node = main.children.find((n) => n.fn.name === "fib"); node; node = node.children.find((n) => n.fn.name === "fib")) depth++;
  assert.equal(depth, 5);
});

test("finds the functions with the most own time under a node", () => {
  const greet = profile.tree[0].children.find((n) => n.fn.name === "Greeter->greet")!;
  const spots = hotSpots(greet);
  assert.deepEqual(spots.map((s) => [s.fn.name, s.calls]), [["Greeter->greet", 3], ["php::str_repeat", 3], ["php::strtoupper", 3]]);
  close(spots[0].self, (658 + 158 + 53) / 100_000);
  close(spots[1].self, (146 + 4 + 1) / 100_000);
});

test("reads Laravel's queries from an Xdebug trace", () => {
  const queries = parseSqlTrace(readFileSync(new URL("./sqltrace.fixture.txt", import.meta.url), "utf8"));
  assert.deepEqual(queries.map((q) => q.sql), [
    'select * from "sessions" where "id" = ? limit 1',
    'select * from "sessions" where "id" = ? limit 1',
    'insert into "sessions" ("payload", "last_activity", "user_id", "ip_address", "user_agent", "id") values (?, ?, ?, ?, ?, ?)',
  ]);
  assert.deepEqual(queries[0].bindings, ["'qZtLjFTCAc69tLWRy3bAlFrZitNLyzFVC6Xp8TCa'"]);
  assert.equal(queries[2].bindings.length, 6);
  assert.equal(queries[2].bindings[2], "NULL");
  assert.ok(queries.every((q) => q.time > 0 && q.time < 50), "each query has its time from the exit record");
  assert.equal(withBindings(queries[0]), 'select * from "sessions" where "id" = \'qZtLjFTCAc69tLWRy3bAlFrZitNLyzFVC6Xp8TCa\' limit 1');
});

test("splits PHP lists without breaking quoted commas", () => {
  assert.deepEqual(phpList("[0 => 'a, b', 1 => 5, 2 => 'it\\'s']"), ["'a, b'", "5", "'it\\'s'"]);
  assert.deepEqual(phpList("[]"), []);
});

test("groups queries by SQL and flags duplicates and repeats", () => {
  const q = (sql: string, binding: string, time = 1) => ({ sql, bindings: [binding], time, start: 0 });
  const groups = groupQueries([
    q("select * from authors where id = ?", "1"),
    q("select * from authors where id = ?", "2"),
    q("select * from authors where id = ?", "3"),
    q("select * from sessions where id = ?", "'x'", 0.5),
    q("select * from sessions where id = ?", "'x'", 0.5),
    q("select * from posts", "", 5),
  ]);
  assert.deepEqual(groups.map((g) => [g.sql, g.runs.length, g.kind]), [
    ["select * from posts", 1, ""],
    ["select * from authors where id = ?", 3, "repeated"],
    ["select * from sessions where id = ?", 2, "duplicate"],
  ]);
});
