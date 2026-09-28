/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { moveBookmark, moveFile, parseBookmarks } from "./bookmarksdata.ts";

test("parseBookmarks makes paths absolute and drops bad and repeated entries", () => {
  const list = parseBookmarks(
    [
      { path: "app/A.php", line: 3, mnemonic: "1", description: " login " },
      { path: "/abs/B.php", line: 1, mnemonic: "1" },
      { path: "app/A.php", line: 3 },
      { path: "app/C.php", line: 0 },
      "nope",
      { path: "app/D.php", line: 2, mnemonic: "é" },
    ],
    "/p",
  );
  assert.deepEqual(list, [
    { path: "/p/app/A.php", line: 3, mnemonic: "1", description: "login" },
    { path: "/abs/B.php", line: 1 },
    { path: "/p/app/D.php", line: 2 },
  ]);
  assert.deepEqual(parseBookmarks(undefined, "/p"), []);
});

test("bookmarks and files reorder", () => {
  const a1 = { path: "a", line: 1 };
  const a2 = { path: "a", line: 2 };
  const b1 = { path: "b", line: 1 };
  const c1 = { path: "c", line: 1 };
  assert.deepEqual(moveBookmark([a1, a2, b1], 1, 0, false), [a2, a1, b1]);
  assert.deepEqual(moveBookmark([a1, a2, b1], 0, 1, true), [a2, a1, b1]);
  assert.deepEqual(moveFile([a1, a2, b1, c1], "a", "c", true), [b1, c1, a1, a2]);
  assert.deepEqual(moveFile([a1, a2, b1, c1], "c", "a", false), [c1, a1, a2, b1]);
});

test("parseBookmarks groups each file's bookmarks", () => {
  const list = parseBookmarks([{ path: "a", line: 1 }, { path: "b", line: 1 }, { path: "a", line: 2 }], "/p");
  assert.deepEqual(list.map((b) => `${b.path}:${b.line}`), ["/p/a:1", "/p/a:2", "/p/b:1"]);
});
