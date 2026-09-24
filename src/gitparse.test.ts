/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { age, parseBlame, parseHunks, parseStatus } from "./gitparse.ts";

test("parses branch, tracking, and file statuses", () => {
  const out = ["## main...origin/main [ahead 2, behind 1]", "M  app/Post.php", " M routes/web.php", "R  new.php", "old.php", "?? notes.md", ""].join("\0");
  const s = parseStatus(out);
  assert.deepEqual([s.branch, s.upstream, s.ahead, s.behind], ["main", "origin/main", 2, 1]);
  assert.deepEqual(s.files, [
    { index: "M", worktree: " ", path: "app/Post.php" },
    { index: " ", worktree: "M", path: "routes/web.php" },
    { index: "R", worktree: " ", path: "new.php", from: "old.php" },
    { index: "?", worktree: "?", path: "notes.md" },
  ]);
});

test("parses branch headers without upstream or commits", () => {
  assert.deepEqual(parseStatus("## feature\0").branch, "feature");
  assert.deepEqual(parseStatus("## No commits yet on main\0").branch, "main");
  assert.deepEqual(parseStatus("## HEAD (no branch)\0").branch, "HEAD (detached)");
  assert.equal(parseStatus("## main...origin/main [gone]\0").ahead, 0);
});

test("turns zero-context hunks into line changes", () => {
  const diff = "diff --git a/x b/x\n@@ -3,0 +4,2 @@\n+a\n+b\n@@ -10 +12 @@\n-x\n+y\n@@ -20,3 +21,0 @@\n-p\n@@ -1 +0,0 @@\n-q\n";
  assert.deepEqual(parseHunks(diff), [
    { kind: "added", start: 4, end: 5 },
    { kind: "modified", start: 12, end: 12 },
    { kind: "deleted", start: 21, end: 21 },
    { kind: "deleted", start: 1, end: 1 },
  ]);
});

test("parses porcelain blame, reusing commit details for repeated commits", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const out = [
    `${a} 1 1 2`, "author Ada", "author-time 1700000000", "summary First", "filename x.php", "\t<?php",
    `${a} 2 2`, "\techo 1;",
    `${b} 3 3 1`, "author Bo", "author-time 1710000000", "summary Second", "filename x.php", "\techo 2;",
  ].join("\n");
  const lines = parseBlame(out);
  assert.deepEqual(lines.map((l) => [l.author, l.summary]), [["Ada", "First"], ["Ada", "First"], ["Bo", "Second"]]);
});

test("formats ages", () => {
  assert.equal(age(0, 30), "now");
  assert.equal(age(0, 3 * 86400 + 5), "3d");
  assert.equal(age(0, 400 * 86400), "1y");
});
