/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSettingsFile, readSaved, settingsToWrite } from "./settingsdata.ts";

test("parseSettingsFile rejects text that isn't a JSON object", () => {
  assert.ok("error" in parseSettingsFile("{ fontSize: 14"));
  assert.ok("error" in parseSettingsFile("[1]"));
  assert.ok("error" in parseSettingsFile("null"));
  assert.deepEqual(parseSettingsFile('{"a":1}'), { raw: { a: 1 } });
});

test("readSaved keeps valid values and sets aside wrong types and out-of-range numbers", () => {
  const defaults = { fontSize: 13, vim: false, theme: "dark", keymap: {} };
  const { values, invalid } = readSaved({ fontSize: 99, vim: "yes", theme: "light", keymap: { A: "Meta+A" } }, defaults, { fontSize: { min: 8, max: 32 } });
  assert.deepEqual(values, { fontSize: 13, vim: false, theme: "light", keymap: { A: "Meta+A" } });
  assert.equal(invalid.get("fontSize"), "must be from 8 to 32");
  assert.equal(invalid.get("vim"), "must be true or false");
});

test("settingsToWrite keeps unknown keys and invalid saved values", () => {
  const out = settingsToWrite({ future: 1, fontSize: "14" }, { fontSize: 13, vim: true }, new Set(["fontSize"]));
  assert.deepEqual(out, { future: 1, fontSize: "14", vim: true });
});
