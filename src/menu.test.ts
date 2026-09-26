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
