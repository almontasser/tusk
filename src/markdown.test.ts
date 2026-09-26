/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownBlocks, previewScrollTop, resolveLink } from "./markdown.ts";

test("markdownBlocks marks each block with its first line and keeps link definitions", () => {
  const html = markdownBlocks("# Title\n\nSee [docs].\n\n[docs]: https://example.com\n\n- a\n- b\n");
  assert.deepEqual([...html.matchAll(/data-line="(\d+)"/g)].map((m) => +m[1]), [0, 2, 6]);
  assert.match(html, /<a href="https:\/\/example.com">docs<\/a>/);
  assert.doesNotMatch(html, /\[docs\]:/);
});

test("resolveLink resolves relative paths from the file's folder", () => {
  assert.equal(resolveLink("/p/docs", "img/a.png"), "/p/docs/img/a.png");
  assert.equal(resolveLink("/p/docs", "../My%20Shots/a b.png"), "/p/My Shots/a b.png");
  assert.equal(resolveLink("/p/a#b", "c.md#section"), "/p/a#b/c.md");
  assert.equal(resolveLink("/p", "/abs/x.png"), "/abs/x.png");
  assert.equal(resolveLink("/p", "https://example.com/x.png"), null);
  assert.equal(resolveLink("/p", "mailto:a@b.c"), null);
  assert.equal(resolveLink("/p", "#top"), null);
});

test("previewScrollTop interpolates between the blocks around the line", () => {
  const blocks = [{ line: 2, top: 100 }, { line: 6, top: 300 }, { line: 10, top: 500 }];
  assert.equal(previewScrollTop(blocks, 0), 0);
  assert.equal(previewScrollTop(blocks, 2), 100);
  assert.equal(previewScrollTop(blocks, 4), 200);
  assert.equal(previewScrollTop(blocks, 8), 400);
  assert.equal(previewScrollTop(blocks, 12), 500);
});
