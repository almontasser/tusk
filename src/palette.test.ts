/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzy, matchPositions, rank } from "./palette.ts";

const item = (label: string) => ({ label, run() {} });

test("fuzzy matches subsequences and rejects others", () => {
  assert.ok(fuzzy("pstctl", "app/Http/Controllers/PostController.php") >= 0);
  assert.equal(fuzzy("xyz", "PostController.php"), -1);
  assert.equal(fuzzy("tp", "pt"), -1); // Order matters.
});

test("word starts and consecutive letters rank first", () => {
  const ranked = rank("pc", [item("app/specs.php"), item("app/PostController.php")]).map((i) => i.label);
  assert.deepEqual(ranked, ["app/PostController.php", "app/specs.php"]);
  assert.equal(rank("post", [item("app/Models/Post.php"), item("app/Policies/PostPolicy.php")])[0].label, "app/Models/Post.php");
});

test("empty query keeps the original order", () => {
  assert.deepEqual(rank("", [item("b"), item("a")]).map((i) => i.label), ["b", "a"]);
});

test("highlights the query as one block when it appears whole", () => {
  assert.deepEqual(matchPositions("post", "app/Posts/Post.php"), [10, 11, 12, 13]);
  assert.deepEqual(matchPositions("pp", "app/Post.php"), [1, 2]);
  assert.deepEqual(matchPositions("apo", "app/Post.php"), [0, 1, 5]);
  assert.deepEqual(matchPositions("xyz", "app/Post.php"), []);
});
