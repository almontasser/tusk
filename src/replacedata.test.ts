/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyReplacements } from "./replacedata.ts";

test("applies kept replacements and skips lines that changed", () => {
  const text = "foo foo\nbar\nfoo\r\n";
  const r = (line: number, column: number, lineText: string) => ({ line, column, end: column + 3, text: "baz", lineText });
  assert.deepEqual(applyReplacements(text, [r(1, 1, "foo foo"), r(1, 5, "foo foo"), r(3, 1, "foo")]), { text: "baz baz\nbar\nbaz\r\n", applied: 3, stale: 0 });
  // Only the second match on line 1 was kept.
  assert.equal(applyReplacements(text, [r(1, 5, "foo foo")]).text, "foo baz\nbar\nfoo\r\n");
  assert.deepEqual(applyReplacements(text, [r(2, 1, "baz"), r(9, 1, "x")]), { text, applied: 0, stale: 2 });
});
