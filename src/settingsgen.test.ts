/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./designerfixture.ts";
import { applyEdits, mergeEdits } from "./phpcode.ts";
import { coerce, fieldsFor, groupFor, migrationLines, pageFieldEdits, parseType, propName, readSettings, registerEdit, settingsEdits, settingsFile, settingsMigration, type SettingsSpec } from "./settingsgen.ts";

const ENUMS = ["App\\Enums\\PostStatus"];
const VALUES = { site_name: "Demo", tax_rate: 0.2, open: true, default_status: "draft", launch_at: null, tags: ["a", "b"] };

test("names and types", () => {
  assert.equal(propName("Tax rate"), "tax_rate");
  assert.equal(propName("siteName"), "site_name");
  assert.equal(groupFor("GeneralSettings"), "general");
  const resolve = (n: string) => (n === "CarbonImmutable" ? "Carbon\\CarbonImmutable" : n === "PostStatus" ? "App\\Enums\\PostStatus" : n);
  assert.deepEqual(parseType("?float", resolve, ENUMS), { type: "float", nullable: true });
  assert.deepEqual(parseType("CarbonImmutable|null", resolve, ENUMS), { type: "date", cls: "Carbon\\CarbonImmutable", nullable: true });
  assert.deepEqual(parseType("PostStatus", resolve, ENUMS), { type: "enum", cls: "App\\Enums\\PostStatus", nullable: false });
  assert.equal(parseType("int|string", resolve, ENUMS), null);
  assert.equal(parseType("SomeData", resolve, ENUMS), null);
  assert.equal(coerce("0.25", "float", false), 0.25);
  assert.equal(coerce("x", "enum", false, ["draft", "published"]), "draft");
});

test("readSettings reads properties, the group, and stored values", () => {
  const { outline } = fixture("GeneralSettings");
  const read = readSettings(outline, ENUMS, VALUES)!;
  assert.equal(read.spec.group, "general");
  assert.deepEqual(
    read.spec.props.map((p) => [p.name, p.type, p.nullable, p.cls ?? null, p.value]),
    [
      ["site_name", "string", false, null, "Demo"],
      ["tax_rate", "float", false, null, 0.2],
      ["open", "bool", false, null, true],
      ["default_status", "enum", true, "App\\Enums\\PostStatus", "draft"],
      ["launch_at", "date", true, "Carbon\\CarbonImmutable", null],
      ["tags", "array", false, null, ["a", "b"]],
    ],
  );
  // Without the values, nothing is known about the database.
  const unknown = readSettings(outline, ENUMS, null)!;
  assert.equal(unknown.spec.props[0].value, undefined);
  assert.equal(unknown.spec.props[0].original!.stored, true);
});

test("settingsFile writes a new class", () => {
  const spec: SettingsSpec = { name: "ShopSettings", namespace: "App\\Settings", group: "shop", props: [{ name: "tax_rate", type: "float", nullable: false, value: 0.2 }, { name: "opens_at", type: "date", nullable: true, value: null }] };
  const code = settingsFile(spec);
  assert.match(code, /use Carbon\\CarbonImmutable;\nuse Spatie\\LaravelSettings\\Settings;/);
  assert.match(code, /class ShopSettings extends Settings\n\{\n    public float \$tax_rate;\n\n    public \?CarbonImmutable \$opens_at;\n\n    public static function group\(\): string\n    \{\n        return 'shop';/);
  assert.equal(
    settingsMigration(migrationLines(null, spec)),
    `<?php

use Spatie\\LaravelSettings\\Migrations\\SettingsMigration;

return new class extends SettingsMigration
{
    public function up(): void
    {
        $this->migrator->add('shop.tax_rate', 0.2);
        $this->migrator->add('shop.opens_at', null);
    }
};
`,
  );
});

test("settingsEdits and the migration for an existing class", () => {
  const { text, outline } = fixture("GeneralSettings");
  const read = readSettings(outline, ENUMS, VALUES)!;
  const designed = structuredClone(read.spec);
  designed.props = designed.props.filter((p) => p.name !== "open");
  designed.props[0].name = "app_name";
  designed.props[1].value = 0.25;
  designed.props[2].nullable = false;
  designed.props[2].value = "published";
  designed.props.push({ name: "currency", type: "string", nullable: false, value: "USD" });
  const after = applyEdits(text, mergeEdits(settingsEdits(text, outline, read, designed)));
  assert.match(after, /public string \$app_name;/);
  assert.doesNotMatch(after, /\$open;/);
  assert.match(after, /public PostStatus \$default_status;/);
  assert.match(after, /public array \$tags;\n\n    public string \$currency;\n\n    public static function group/);
  assert.deepEqual(migrationLines(read.spec, designed), [
    "$this->migrator->rename('general.site_name', 'general.app_name');",
    "$this->migrator->delete('general.open');",
    "$this->migrator->update('general.tax_rate', fn () => 0.25);",
    "$this->migrator->update('general.default_status', fn () => 'published');",
    "$this->migrator->add('general.currency', 'USD');",
  ]);
  // A new group renames every stored property, and the enum's import goes when nothing uses it.
  const regrouped = { ...structuredClone(read.spec), group: "site" };
  regrouped.props = regrouped.props.filter((p) => p.name !== "default_status");
  const moved = applyEdits(text, mergeEdits(settingsEdits(text, outline, read, regrouped)));
  assert.match(moved, /return 'site';/);
  assert.doesNotMatch(moved, /use App\\Enums\\PostStatus;/);
  assert.equal(migrationLines(read.spec, regrouped)[0], "$this->migrator->rename('general.site_name', 'site.site_name');");
  // A property the database lacks is added with its value.
  const partial = readSettings(outline, ENUMS, Object.fromEntries(Object.entries(VALUES).filter(([k]) => k !== "tags")))!;
  partial.spec.props.at(-1)!.value = [];
  assert.deepEqual(migrationLines(partial.spec, partial.spec), ["$this->migrator->add('general.tags', []);"]);
});

test("pageFieldEdits fills the generator's empty form, and adds after existing fields", () => {
  const props = [
    { name: "tax_rate", type: "float" as const, nullable: false, value: 0 },
    { name: "status", type: "enum" as const, cls: "App\\Enums\\PostStatus", nullable: true, value: null },
  ];
  const fields = fieldsFor("App\\Settings\\GeneralSettings", props, ENUMS);
  const empty = fixture("EmptySettingsPage");
  const filled = applyEdits(empty.text, mergeEdits(pageFieldEdits(empty.text, empty.outline, fields)!));
  assert.match(filled, /->components\(\[\n                TextInput::make\('tax_rate'\)\n                    ->numeric\(\)\n                    ->required\(\),\n                Select::make\('status'\)\n                    ->options\(PostStatus::class\),\n            \]\)/);
  assert.match(filled, /use App\\Enums\\PostStatus;/);
  assert.match(filled, /use Filament\\Forms\\Components\\Select;/);
  const page = fixture("ManageGeneral");
  const more = applyEdits(page.text, mergeEdits(pageFieldEdits(page.text, page.outline, fields.slice(0, 1))!));
  assert.match(more, /TextInput::make\('tags'\)\n                    ->required\(\),\n                TextInput::make\('tax_rate'\)/);
});

test("registerEdit lists a class in config/settings.php", () => {
  const config = "<?php\n\nreturn [\n\n    'settings' => [\n\n    ],\n];\n";
  assert.equal(applyEdits(config, [registerEdit(config, "App\\Shop\\ShopSettings")!]), "<?php\n\nreturn [\n\n    'settings' => [\n        \\App\\Shop\\ShopSettings::class,\n\n    ],\n];\n");
});
