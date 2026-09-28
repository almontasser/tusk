/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatsOnSave, formatterFor } from "./formatdata.ts";

test("uses the project's formatter for a language's group, else Auto", () => {
  const choices = { php: { use: "pint" as const }, js: { use: "builtin" as const }, css: { use: "pint" as const } };
  assert.equal(formatterFor(choices, "php"), "pint");
  assert.equal(formatterFor(choices, "typescript"), "builtin");
  assert.equal(formatterFor(choices, "vue"), "builtin");
  // Pint doesn't format CSS, so a hand-edited choice like that falls back.
  assert.equal(formatterFor(choices, "css"), "auto");
  assert.equal(formatterFor(choices, "html"), "auto");
  assert.equal(formatterFor(undefined, "php"), "auto");
});

test("formats on save by the group's choice, else the global setting", () => {
  const choices = { php: { onSave: true }, yaml: { onSave: false } };
  assert.equal(formatsOnSave(choices, "php", false), true);
  assert.equal(formatsOnSave(choices, "yaml", true), false);
  assert.equal(formatsOnSave(choices, "json", true), true);
  assert.equal(formatsOnSave(undefined, "html", false), false);
});
