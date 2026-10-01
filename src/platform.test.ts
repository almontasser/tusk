/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsolute, keyText } from "./platform.ts";

test("Mac key symbols read as words off a Mac", () => {
  assert.equal(keyText("⌥⌘Z", true), "⌥⌘Z");
  assert.equal(keyText("Rollback… (⌥⌘Z)", false), "Rollback… (Ctrl+Alt+Z)");
  assert.equal(keyText("⌘⏎ runs the statement", false), "Ctrl+Enter runs the statement");
  assert.equal(keyText("⇧⌘F8", false), "Ctrl+Shift+F8");
  assert.equal(keyText("⌘⌫", false), "Ctrl+Backspace");
  assert.equal(keyText("Settings (⌘,)", false), "Settings (Ctrl+,)");
  assert.equal(keyText("⇧⇧", false), "Shift Shift");
  assert.equal(keyText("⌃⌃", false), "Ctrl Ctrl");
  assert.equal(keyText("⌃⇧B", false), "Win+Shift+B");
});

test("absolute paths on every system", () => {
  assert.ok(isAbsolute("/Users/me"));
  assert.ok(isAbsolute("c:/Users/me"));
  assert.ok(isAbsolute("C:\\Users"));
  assert.ok(!isAbsolute("app/Models"));
  assert.ok(!isAbsolute("c:file"));
});
