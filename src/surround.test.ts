/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { blockRange, remember } from "./surround.ts";

test("blockRange wraps whole lines from their indentation, leaving out a line the selection only reaches", () => {
  const lines = ["", "    $a = 1;", "    $b = 2;", "}"];
  const line = (n: number) => lines[n - 1];
  assert.deepEqual(blockRange({ startLineNumber: 2, startColumn: 9, endLineNumber: 2, endColumn: 9 }, line), { startLineNumber: 2, startColumn: 5, endLineNumber: 2, endColumn: 12 });
  assert.deepEqual(blockRange({ startLineNumber: 2, startColumn: 1, endLineNumber: 4, endColumn: 1 }, line), { startLineNumber: 2, startColumn: 5, endLineNumber: 3, endColumn: 12 });
});

test("remember puts the newest text first, without repeats or blanks, up to the limit", () => {
  let h: string[] = [];
  for (const t of ["a", "b", "a", "  ", "c"]) h = remember(h, t, 2);
  assert.deepEqual(h, ["c", "a"]);
});
