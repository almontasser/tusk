/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { imageType, mapLine, parseMergeTree, parseNumstat } from "./diffdata.ts";
import { lineChanges } from "./gitparse.ts";

const map = (before: string, after: string, lines: number[]) => {
  const blocks = lineChanges(before.split("\n"), after.split("\n")).map((c) => c.block!);
  return lines.map((l) => mapLine(blocks, l));
};

test("imageType knows the image extensions, in any case", () => {
  assert.equal(imageType("a/logo.PNG"), "image/png");
  assert.equal(imageType("x.jpeg"), "image/jpeg");
  assert.equal(imageType("icon.svg"), "image/svg+xml");
  assert.equal(imageType("photo.webp"), "image/webp");
  assert.equal(imageType("app.php"), "");
  assert.equal(imageType("Makefile"), "");
});

test("mapLine leaves lines alone when nothing changed", () => {
  assert.deepEqual(map("a\nb\nc", "a\nb\nc", [1, 2, 3]), [1, 2, 3]);
});

test("mapLine moves lines after inserted lines down", () => {
  assert.deepEqual(map("a\nb\nc", "a\nx\ny\nb\nc", [1, 2, 3]), [1, 4, 5]);
  // Inserted at the top.
  assert.deepEqual(map("a\nb", "x\na\nb", [1, 2]), [2, 3]);
});

test("mapLine moves lines after deleted lines up, and drops the deleted ones", () => {
  assert.deepEqual(map("a\nb\nc\nd", "a\nd", [1, 2, 3, 4]), [1, null, null, 2]);
});

test("mapLine keeps a changed line's comment on its new version", () => {
  assert.deepEqual(map("a\nb\nc", "a\nB\nc", [1, 2, 3]), [1, 2, 3]);
  // Two lines became one: both map to it.
  assert.deepEqual(map("a\nb\nc\nd", "a\nX\nd", [2, 3, 4]), [2, 2, 3]);
});

test("mapLine follows several changes", () => {
  const before = "1\n2\n3\n4\n5\n6\n7\n8";
  const after = "0\n1\n2\n4\n5\nnew\n6\n7\n8";
  assert.deepEqual(map(before, after, [1, 3, 4, 6, 8]), [2, null, 4, 7, 9]);
});

test("parseMergeTree reads the tree and the conflicted files", () => {
  assert.deepEqual(parseMergeTree("bbf9917\nc.txt\nsrc/a b.php\n\nAuto-merging c.txt\nCONFLICT (content): Merge conflict in c.txt\n"), { tree: "bbf9917", conflicts: ["c.txt", "src/a b.php"] });
  assert.deepEqual(parseMergeTree("ba24cb4\n"), { tree: "ba24cb4", conflicts: [] });
});

test("parseNumstat reads paths with tabs and binary files", () => {
  assert.deepEqual(parseNumstat("1\t7\tc.txt\0-\t-\tlogo.png\0" + "2\t0\ta\tb.txt\0"), [
    { path: "c.txt", additions: 1, deletions: 7 },
    { path: "logo.png", additions: 0, deletions: 0 },
    { path: "a\tb.txt", additions: 2, deletions: 0 },
  ]);
});
