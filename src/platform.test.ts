/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsolute, keyText, shortcutText } from "./platform.ts";

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
  assert.equal(keyText("Next match (⏎)", false), "Next match (Enter)");
  assert.equal(keyText("⌫ deletes, ⌘D duplicates", false), "Backspace deletes, Ctrl+D duplicates");
  assert.equal(keyText("Space or ⌘-click to compare", false), "Space or Ctrl+click to compare");
  assert.equal(keyText("Drag, or ⌥↑ ⌥↓ · P R E S F D", false), "Drag, or Alt+↑ Alt+↓ · P R E S F D");
  assert.equal(keyText("<button title=\"Stop (⌘F2)\">", false), '<button title="Stop (Ctrl+F2)">');
});

test("keymap shortcuts as each platform names them", () => {
  assert.equal(shortcutText("Shift+Meta+O", true), "⇧⌘O");
  assert.equal(shortcutText("Meta+Shift+O", false), "Ctrl+Shift+O");
  assert.equal(shortcutText("Ctrl+Alt+Shift+ArrowUp", false), "Win+Alt+Shift+↑");
  assert.equal(shortcutText("Meta+Backslash", false), "Ctrl+\\");
  assert.equal(shortcutText("Shift+Meta+Quote", false), "Ctrl+Shift+'");
  assert.equal(shortcutText("Shift Shift", false), "Shift Shift");
  assert.equal(shortcutText("Meta+K Meta+X", false), "Ctrl+K Ctrl+X");
  assert.equal(shortcutText(undefined, false), undefined);
});

test("absolute paths on every system", () => {
  assert.ok(isAbsolute("/Users/me"));
  assert.ok(isAbsolute("c:/Users/me"));
  assert.ok(isAbsolute("C:\\Users"));
  assert.ok(!isAbsolute("app/Models"));
  assert.ok(!isAbsolute("c:file"));
});
