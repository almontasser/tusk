/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyReplacements } from "./replacedata.ts";

test("applies kept replacements and skips lines that changed", () => {
  const text = "foo foo\nbar\nfoo\r\n";
  const r = (line: number, column: number, lineText: string) => ({ line, column, end: column + 3, text: "baz", lineText, lineOffset: 0 });
  assert.deepEqual(applyReplacements(text, [r(1, 1, "foo foo"), r(1, 5, "foo foo"), r(3, 1, "foo")]), { text: "baz baz\nbar\nbaz\r\n", applied: 3, stale: 0 });
  // Only the second match on line 1 was kept.
  assert.equal(applyReplacements(text, [r(1, 5, "foo foo")]).text, "foo baz\nbar\nfoo\r\n");
  assert.deepEqual(applyReplacements(text, [r(2, 1, "baz"), r(9, 1, "x")]), { text, applied: 0, stale: 2 });
});

test("checks a long line only around each match, as the search cut it", () => {
  // The search keeps 200 characters before a match and 300 after: `lineText` starts at column 800 (0-based).
  const line = `${"a".repeat(1000)}foo${"b".repeat(1000)}`;
  const r = { line: 2, column: 1001, end: 1004, text: "baz", lineText: line.slice(800, 1303), lineOffset: 800 };
  const text = `first\n${line}\n`;
  assert.deepEqual(applyReplacements(text, [r]), { text: `first\n${"a".repeat(1000)}baz${"b".repeat(1000)}\n`, applied: 1, stale: 0 });
  // A change past the part the search saw doesn't matter; one inside it does.
  const after = `first\n${line.slice(0, 1900)}X${line.slice(1901)}\n`;
  assert.equal(applyReplacements(after, [r]).applied, 1);
  const inside = `first\n${line.slice(0, 1100)}X${line.slice(1101)}\n`;
  assert.deepEqual(applyReplacements(inside, [r]), { text: inside, applied: 0, stale: 1 });
});
