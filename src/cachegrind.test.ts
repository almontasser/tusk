/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fromRaw, groupQueries, hotSpots, parseSqlTrace, phpList, withBindings } from "./cachegrind.ts";

// {main} calls greet twice, and greet calls upper each time. Parsing itself is tested in src-tauri/src/profile.rs.
const fields = { file: "/app/demo.php", line: 1, self: 0, inclusive: 0, memory: 0 };
const profile = fromRaw({
  command: "/app/demo.php",
  functions: [
    { ...fields, name: "{main}", calls: 1, callees: [[1, 2, 10]] },
    { ...fields, name: "greet", calls: 2, callees: [[2, 2, 4]] },
    { ...fields, name: "upper", calls: 2, callees: [] },
  ],
  total: 12,
  tree: [{ fn: 0, calls: 1, time: 12, children: [{ fn: 1, calls: 2, time: 10, children: [{ fn: 2, calls: 2, time: 4, children: [] }] }] }],
  sites: [["/app/demo.php", [[5, 10, 2]]]],
});

test("turns a parsed profile's indexes into references", () => {
  const [main, greet, upper] = profile.functions;
  assert.equal(greet.callees[0].fn, upper);
  assert.deepEqual(greet.callers.map((c) => [c.fn, c.calls, c.time]), [[main, 2, 10]]);
  assert.equal(profile.tree[0].children[0].fn, greet);
  assert.deepEqual(profile.sites.get("/app/demo.php")!.get(5), { time: 10, calls: 2 });
});

test("finds the functions with the most own time under a node", () => {
  const spots = hotSpots(profile.tree[0]);
  assert.deepEqual(spots.map((s) => [s.fn.name, s.self, s.calls]), [["greet", 6, 2], ["upper", 4, 2], ["{main}", 2, 1]]);
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
