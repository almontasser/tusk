/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { batchOrder, clampToHunk, commentable, hunkAt, hunks, withSides } from "./prhunks.ts";

// GitHub's patch for one file: two hunks, the second adding a file's worth of lines, and a hunk without counts.
const patch = "@@ -18,13 +18,15 @@ use Foo;\n context\n+added\n@@ -444,6 +446,84 @@ class X\n-old\n+new\n@@ -0,0 +1 @@\n+only";

test("reads each side's lines from hunk headers", () => {
  assert.deepEqual(hunks(patch), [
    { LEFT: [18, 30], RIGHT: [18, 32] },
    { LEFT: [444, 449], RIGHT: [446, 529] },
    { LEFT: null, RIGHT: [1, 1] },
  ]);
  assert.deepEqual(hunks(""), []);
});

test("finds the hunk of a line, per side", () => {
  const list = hunks(patch);
  assert.equal(hunkAt(list, "RIGHT", 32), 0);
  assert.equal(hunkAt(list, "LEFT", 32), -1);
  assert.equal(hunkAt(list, "RIGHT", 446), 1);
  assert.equal(hunkAt(list, "LEFT", 100), -1);
});

test("takes a range only inside one hunk", () => {
  const list = hunks(patch);
  assert.ok(commentable(list, "RIGHT", 20, 30));
  assert.ok(!commentable(list, "RIGHT", 20, 446));
  assert.ok(!commentable(list, "LEFT", 31, 31));
});

test("keeps a drag inside its hunk", () => {
  const list = hunks(patch);
  assert.equal(clampToHunk(list, "RIGHT", 20, 300), 32);
  assert.equal(clampToHunk(list, "RIGHT", 450, 5), 446);
  assert.equal(clampToHunk(list, "RIGHT", 450, 460), 460);
  assert.equal(clampToHunk(list, "LEFT", 100, 120), 100);
});

test("orders suggestions bottom up per file and finds overlaps", () => {
  const s = (id: number, path: string, start: number, end: number) => ({ id, path, start, end, text: "" });
  const { ordered, overlap } = batchOrder([s(1, "b.php", 3, 4), s(2, "a.php", 1, 1), s(3, "b.php", 10, 12)]);
  assert.deepEqual(ordered.map((x) => x.id), [2, 3, 1]);
  assert.equal(overlap, undefined);
  assert.deepEqual(batchOrder([s(1, "a.php", 3, 5), s(2, "a.php", 5, 6)]).overlap?.map((x) => x.id), [1, 2]);
  assert.equal(batchOrder([s(1, "a.php", 3, 4), s(2, "b.php", 3, 4)]).overlap, undefined);
});

test("gives pending comments their thread's side", () => {
  const node = (id: number, reply: number | null, subject: "LINE" | "FILE" = "LINE") => ({ id, path: "a.php", line: 4, start_line: null, body: "", user: "me", in_reply_to_id: reply, created_at: "", subject });
  const out = withSides([node(1, null), node(2, 1), node(3, null), node(4, null, "FILE")], new Map([[1, "LEFT" as const]]));
  assert.deepEqual(out.map((c) => c.side), ["LEFT", "LEFT", "RIGHT", "RIGHT"]);
  assert.deepEqual([out[3].subject_type, out[3].line, out[0].subject_type], ["file", null, "line"]);
});
