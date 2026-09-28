import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./designerfixture.ts";
import { applyEdits } from "./phpcode.ts";
import { castEdits, columnCallEdit, columnCode, columnsArray, importRules, readColumns, readResolution, resolutionEdits, rulesCode } from "./portergen.ts";

const plain = (code: string) => code.replace(/\{\{[\w\\]*?(\w+)\}\}/g, "$1");

test("importer columns read and change", () => {
  const f = fixture("CategoryImporter");
  const cls = f.outline.classes[0];
  const cols = readColumns(columnsArray(cls)!);
  assert.deepEqual(cols.map((c) => [c.name, c.required, c.cast, c.relationship]), [
    ["name", true, "text", false],
    ["slug", true, "text", false],
    ["parent", false, "text", true],
    ["description", false, "text", false],
    ["position", true, "numeric", false],
    ["is_visible", true, "boolean", false],
    ["seo_title", false, "text", false],
    ["seo_description", false, "text", false],
  ]);
  assert.deepEqual(cols[0].rules, ["required", "max:255"]);
  assert.equal(cols[5].label, "Visibility");
  const next = applyEdits(f.text, [...columnCallEdit(f.text, cols[0], "rules", rulesCode(["required", "max:100"])), ...castEdits(f.text, cols[4], "integer")]);
  assert.match(next, /ImportColumn::make\('name'\)\n {16}->requiredMapping\(\)\n {16}->rules\(\['required', 'max:100'\]\)/);
  assert.match(next, /ImportColumn::make\('position'\)\n {16}->requiredMapping\(\)\n {16}->rules\(\['required', 'integer'\]\)\n {16}->example\('1'\)\n {16}->integer\(\),/);
  assert.equal(plain(columnCode("importer", "code", { required: true, cast: "integer", rules: ["required", "integer"] })), "ImportColumn::make('code')\n    ->requiredMapping()\n    ->integer()\n    ->rules(['required', 'integer'])");
  assert.deepEqual(importRules({ type: "varchar", nullable: false }), { rules: ["required", "max:255"], required: true, cast: "text" });
});

test("an importer finds its record by a column, or makes a new one", () => {
  const f = fixture("CategoryImporter");
  const cls = f.outline.classes[0];
  assert.deepEqual(readResolution(f.text, cls), { mode: "upsert", column: "slug" });
  const created = plain(applyEdits(f.text, resolutionEdits(f.text, cls, "App\\Models\\Shop\\ProductCategory", { mode: "create" })));
  assert.match(created, /return new ProductCategory\(\);/);
  const updated = plain(applyEdits(f.text, resolutionEdits(f.text, cls, "App\\Models\\Shop\\ProductCategory", { mode: "update", column: "name" })));
  assert.match(updated, /return ProductCategory::query\(\)->where\('name', \$this->data\['name'\]\)->first\(\);/);
});

test("exporter columns start checked unless they say otherwise", () => {
  const f = fixture("BrandExporter");
  const cols = readColumns(columnsArray(f.outline.classes[0])!);
  assert.deepEqual(cols.map((c) => [c.name, c.label, c.enabled]), [["id", "ID", true], ["name", null, true], ["slug", null, true], ["website", null, true], ["created_at", null, true], ["updated_at", "Last modified at", true]]);
  assert.match(applyEdits(f.text, columnCallEdit(f.text, cols[4], "enabledByDefault", "false")), /ExportColumn::make\('created_at'\)\n {16}->enabledByDefault\(false\),/);
});
