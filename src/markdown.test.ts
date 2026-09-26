/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownBlocks, previewScrollTop } from "./markdown.ts";

test("markdownBlocks marks each block with its first line and keeps link definitions", () => {
  const html = markdownBlocks("# Title\n\nSee [docs].\n\n[docs]: https://example.com\n\n- a\n- b\n");
  assert.deepEqual([...html.matchAll(/data-line="(\d+)"/g)].map((m) => +m[1]), [0, 2, 6]);
  assert.match(html, /<a href="https:\/\/example.com">docs<\/a>/);
  assert.doesNotMatch(html, /\[docs\]:/);
});

test("previewScrollTop interpolates between the blocks around the line", () => {
  const blocks = [{ line: 2, top: 100 }, { line: 6, top: 300 }, { line: 10, top: 500 }];
  assert.equal(previewScrollTop(blocks, 0), 0);
  assert.equal(previewScrollTop(blocks, 2), 100);
  assert.equal(previewScrollTop(blocks, 4), 200);
  assert.equal(previewScrollTop(blocks, 8), 400);
  assert.equal(previewScrollTop(blocks, 12), 500);
});
