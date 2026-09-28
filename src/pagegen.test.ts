import assert from "node:assert/strict";
import { test } from "node:test";
import { pageFile } from "./pagegen.ts";

test("a form page edits one record and saves it", () => {
  const code = pageFile({ kind: "form", namespace: "App\\Filament\\Pages", name: "StoreSettings", title: "Store settings", icon: "OutlinedCog6Tooth", model: "App\\Models\\Store", record: "single", components: ["{{Filament\\Forms\\Components\\TextInput}}::make('name')"] });
  assert.match(code, /use App\\Models\\Store;\n/);
  assert.match(code, /@property-read Schema \$form\n \*\/\nclass StoreSettings extends Page\n/);
  assert.match(code, /return Store::query\(\)->firstOrNew\(\);/);
  assert.match(code, /->components\(\[\n {16}TextInput::make\('name'\),\n {12}\]\)\n {12}->model\(\$this->getRecord\(\)\)/);
  assert.match(code, /->livewireSubmitHandler\('save'\)/);
  const user = pageFile({ kind: "form", namespace: "App\\Filament\\Pages", name: "Profile", title: "Profile", icon: null, model: "App\\Models\\User", record: "user", components: [] });
  assert.match(user, /return Auth::user\(\);/);
  assert.doesNotMatch(user, /navigationIcon/);
});

test("a table page lists records", () => {
  const code = pageFile({ kind: "table", namespace: "App\\Filament\\Pages", name: "AllOrders", title: "All orders", icon: null, model: "App\\Models\\Order", record: "single", components: ["{{Filament\\Tables\\Columns\\TextColumn}}::make('number')"] });
  assert.match(code, /class AllOrders extends Page implements HasTable\n\{\n {4}use InteractsWithTable;/);
  assert.match(code, /EmbeddedTable::make\(\),/);
});
