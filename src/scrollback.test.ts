/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { scrollbackText } from "./scrollback.ts";

const buffer = (lines: [string, boolean?][]) => ({
  length: lines.length,
  getLine: (i: number) => ({ isWrapped: !!lines[i][1], translateToString: () => lines[i][0] }),
});

test("joins wrapped lines and drops trailing blanks", () => {
  assert.equal(scrollbackText(buffer([["$ ls   "], ["abcd"], ["ef  ", true], [""], ["   "]])), "$ ls\nabcdef");
});

test("keeps the last characters, from a line start", () => {
  assert.equal(scrollbackText(buffer([["first"], ["second"], ["third"]]), 9), "third");
  assert.equal(scrollbackText(buffer([["first"], ["second"], ["third"]]), 12), "second\nthird");
  assert.equal(scrollbackText(buffer([["one very long line"]]), 5), " line");
});
