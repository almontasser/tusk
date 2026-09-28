/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { accelerator } from "./menu.ts";

test("menu shortcuts only for actions that always handle their keys", () => {
  assert.equal(accelerator({ keys: "Meta+Shift+O" }), "Cmd+Shift+O");
  assert.equal(accelerator({ keys: "Alt+F12" }), "Alt+F12");
  assert.equal(accelerator({ keys: "Meta+D", editorOnly: true }), undefined);
  assert.equal(accelerator({ keys: "F8", when: () => true }), undefined);
  assert.equal(accelerator({ keys: "Shift Shift" }), undefined);
  assert.equal(accelerator({}), undefined);
});

test("Monaco's commands have one label and one action each, and every group is used", async () => {
  const { EDITOR_COMMANDS, commandsIn } = await import("./editorcommands.ts");
  assert.equal(new Set(EDITOR_COMMANDS.map((c) => c[0])).size, EDITOR_COMMANDS.length);
  assert.equal(new Set(EDITOR_COMMANDS.map((c) => c[1])).size, EDITOR_COMMANDS.length);
  for (const group of new Set(EDITOR_COMMANDS.map((c) => c[3]))) assert.ok(commandsIn(group).length);
});
