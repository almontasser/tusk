/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { accelerator, passedOn } from "./menu.ts";

test("menu shortcuts for single key combinations", () => {
  assert.equal(accelerator({ keys: "Meta+Shift+O" }), "Cmd+Shift+O");
  assert.equal(accelerator({ keys: "Alt+F12" }), "Alt+F12");
  assert.equal(accelerator({ keys: "Meta+D" }), "Cmd+D");
  assert.equal(accelerator({ keys: "Shift Shift" }), undefined);
  assert.equal(accelerator({ keys: "Meta+K Meta+X" }), undefined);
  assert.equal(accelerator({}), undefined);
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
