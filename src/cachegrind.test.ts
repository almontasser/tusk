/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseCachegrind } from "./cachegrind.ts";

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
