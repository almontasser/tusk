import assert from "node:assert/strict";
import { test } from "node:test";
import { fileFor, isRtl, renameJsonKey, setJsonKey, setPhpValue, translate, type Translations } from "./translations.ts";

const t: Translations = {
  dir: "/app/lang",
  locale: "en",
  fallback: "en",
  locales: ["ar", "en"],
  json: { ar: { "Customer name": "اسم العميل" }, en: {} },
  php: { ar: { "orders.fields.status": "الحالة" }, en: { "orders.fields.status": "Status", "orders.title": "Orders" } },
};

test("translate falls back to the fallback locale, then the key", () => {
  assert.deepEqual(translate(t, "ar", "Customer name"), { text: "اسم العميل", missing: false });
  assert.deepEqual(translate(t, "ar", "orders.fields.status"), { text: "الحالة", missing: false });
  assert.deepEqual(translate(t, "ar", "orders.title"), { text: "Orders", missing: true });
  assert.deepEqual(translate(t, "ar", "Notes"), { text: "Notes", missing: true });
  assert.ok(isRtl("ar") && isRtl("fa_IR") && !isRtl("en"));
});

test("JSON files keep their order and indentation", () => {
  const text = '{\n  "b": "B",\n  "a": "A"\n}\n';
  assert.equal(setJsonKey(text, "c", "سي"), '{\n  "b": "B",\n  "a": "A",\n  "c": "سي"\n}\n');
  assert.equal(setJsonKey(text, "b", null), '{\n  "a": "A"\n}\n');
  assert.equal(setJsonKey("", "x", "y"), '{\n    "x": "y"\n}\n');
  assert.equal(renameJsonKey(text, "b", "z"), '{\n  "z": "B",\n  "a": "A"\n}\n');
  assert.equal(renameJsonKey(text, "q", "z"), null);
  // Files written by PHP's json_encode keep its escapes.
  assert.equal(setJsonKey('{\n    "a\\/b": "\\u0627"\n}\n', "c", "ب"), '{\n    "a\\/b": "\\u0627",\n    "c": "\\u0628"\n}\n');
});

test("PHP files change the one entry they have", () => {
  const php = "<?php\n\nreturn [\n    'title' => 'Orders',\n    'fields' => [\n        'status' => 'Status',\n    ],\n];\n";
  assert.equal(setPhpValue(php, "fields.status", "It's the status"), php.replace("'Status'", "'It\\'s the status'"));
  assert.equal(setPhpValue(php + "// 'status' => 'x',\n", "fields.status", "S"), null);
  assert.deepEqual(fileFor(t, "ar", "orders.fields.status"), { kind: "php", path: "/app/lang/ar/orders.php", inFile: "fields.status" });
  assert.deepEqual(fileFor(t, "ar", "Notes"), { kind: "json", path: "/app/lang/ar.json" });
});
