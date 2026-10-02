/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { accelerator, passedOn } from "./menu.ts";

test("menu shortcuts for single key combinations", () => {
  assert.equal(accelerator({ keys: "Meta+Shift+O" }, true), "Cmd+Shift+O");
  assert.equal(accelerator({ keys: "Alt+F12" }, true), "Alt+F12");
  assert.equal(accelerator({ keys: "Meta+D" }, true), "Cmd+D");
  assert.equal(accelerator({ keys: "Shift Shift" }, true), undefined);
  assert.equal(accelerator({ keys: "Meta+K Meta+X" }, true), undefined);
  assert.equal(accelerator({}, true), undefined);
  // Off a Mac, ⌘ is Ctrl and ⌃ the Windows key.
  assert.equal(accelerator({ keys: "Meta+D" }, false), "Ctrl+D");
  assert.equal(accelerator({ keys: "Ctrl+Shift+R" }, false), "Super+Shift+R");
  assert.equal(accelerator({ keys: "Ctrl+Alt+Shift+ArrowUp" }, false), "Super+Alt+Shift+ArrowUp");
  assert.equal(accelerator({ keys: "Alt+Shift+Meta+O" }, false), "Alt+Shift+Ctrl+O");
  assert.equal(accelerator({ keys: "Shift Shift" }, false), undefined);
});

test("the menu skips a key the page passed on, for actions that only sometimes apply", () => {
  assert.equal(passedOn({ editorOnly: true }, 1100, 1000), true);
  assert.equal(passedOn({ when: () => false }, 1100, 1000), true);
  assert.equal(passedOn({}, 1100, 1000), false);
  assert.equal(passedOn({ editorOnly: true }, 2000, 1000), false);
});

test("Monaco's commands have one label and one action each, and every group is used", async () => {
  const { EDITOR_COMMANDS, commandsIn } = await import("./editorcommands.ts");
  assert.equal(new Set(EDITOR_COMMANDS.map((c) => c[0])).size, EDITOR_COMMANDS.length);
  assert.equal(new Set(EDITOR_COMMANDS.map((c) => c[1])).size, EDITOR_COMMANDS.length);
  for (const group of new Set(EDITOR_COMMANDS.map((c) => c[3]))) assert.ok(commandsIn(group).length);
});
