import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./designerfixture.ts";
import { defaultSpec, descriptionCode, FLAVORS, historyEdits, historyManagerFile, installCommand, readDescription, readHistory } from "./historygen.ts";
import { applyEdits, droppedImports, type Edit, mergeEdits } from "./phpcode.ts";

const run = (text: string, edits: Edit[]) => applyEdits(text, mergeEdits(edits)).replace(/\{\{[\w\\]*?(\w+)\}\}/g, "$1");

test("readHistory reads the trait and the options chain, and keeps calls it doesn't know", () => {
  const f = fixture("LoggedPost");
  const read = readHistory(f.text, f.outline.classes[0]);
  assert.equal(read.custom, false);
  assert.deepEqual(read.spec, { on: true, fields: "only", only: ["title", "body"], except: [], dirty: true, skipEmpty: false, logName: "posts", description: "Post {event}" });
  assert.deepEqual(read.others.map((c) => c.name), ["dontLogIfAttributesChangedOnly"]);
  assert.deepEqual(read.code, []);
});

test("readHistory leaves a method with statements before its return as code", () => {
  const f = fixture("CustomLog");
  const read = readHistory(f.text, f.outline.classes[0]);
  assert.equal(read.spec.on, true);
  assert.equal(read.custom, true);
});

test("historyEdits changes one call at a time and keeps the others", () => {
  const f = fixture("LoggedPost");
  const cls = f.outline.classes[0];
  const read = readHistory(f.text, cls);
  const out = run(f.text, historyEdits(f.text, cls, read, { ...read.spec, fields: "fillable", except: ["slug"], skipEmpty: true, logName: "", description: "Post was {event}" }, FLAVORS[4]));
  assert.match(out, /->logFillable\(\)\n {12}->logOnlyDirty\(\)\n {12}->setDescriptionForEvent\(fn \(string \$eventName\) => "Post was \{\$eventName\}"\)\n {12}->dontLogIfAttributesChangedOnly\(\['updated_at'\]\)\n {12}->logExcept\(\['slug'\]\)\n {12}->dontSubmitEmptyLogs\(\);/);
  assert.doesNotMatch(out, /useLogName/);
});

test("historyEdits turns history on with the installed version's classes, and off again", () => {
  const f = fixture("Post");
  const cls = f.outline.classes[0];
  const read = readHistory(f.text, cls);
  assert.equal(read.spec.on, false);
  const spec = defaultSpec(["id", "title", "slug", "password", "created_at"], []);
  assert.deepEqual(spec.only, ["title", "slug"]);
  const out = run(f.text, historyEdits(f.text, cls, read, spec, FLAVORS[5]));
  assert.match(out, /use HasFactory;\n {4}use LogsActivity;/);
  assert.match(out, /public function getActivitylogOptions\(\): LogOptions\n {4}\{\n {8}return LogOptions::defaults\(\)\n {12}->logOnly\(\['title', 'slug'\]\)\n {12}->logOnlyDirty\(\)\n {12}->dontLogEmptyChanges\(\);\n {4}\}/);

  const logged = fixture("LoggedPost");
  const offEdits = historyEdits(logged.text, logged.outline.classes[0], readHistory(logged.text, logged.outline.classes[0]), { ...spec, on: false }, FLAVORS[4]);
  // The caller drops the imports the change leaves unused, as the designers do.
  const off = run(logged.text, [...offEdits, ...droppedImports(logged.text, logged.outline, offEdits)]);
  assert.match(off, /use HasFactory;\n/);
  assert.doesNotMatch(off, /LogsActivity;|getActivitylogOptions/);
});

test("descriptions read back as written", () => {
  assert.equal(descriptionCode('Say "{event}" for $5'), 'fn (string $eventName) => "Say \\"{$eventName}\\" for \\$5"');
  const text = `x(${descriptionCode('Say "{event}" for $5')})`;
  const body: [number, number] = [text.indexOf('"'), text.length - 1];
  assert.equal(readDescription(text, { kind: "closure", arrow: true, static: false, params: ["eventName"], body, span: [2, text.length - 1] }), 'Say "{event}" for $5');
  const other = 'fn ($e) => "By {$this->name}"';
  assert.equal(readDescription(other, { kind: "closure", arrow: true, static: false, params: ["e"], body: [other.indexOf('"'), other.length], span: [0, other.length] }), undefined);
});

test("the relation manager and the install command follow the version", () => {
  const v5 = historyManagerFile("App\\Filament\\Resources\\Posts\\RelationManagers", FLAVORS[5]);
  assert.match(v5, /protected static string \$relationship = 'activitiesAsSubject';/);
  assert.match(v5, /\$record->attribute_changes\?->get\('attributes'\)/);
  assert.match(v5, /^use Spatie\\Activitylog\\Models\\Activity;$/m);
  assert.match(historyManagerFile("App\\X", FLAVORS[4]), /'activities';[\s\S]*\$record->properties\?->get/);
  assert.equal(installCommand("composer", { require: false, publish: false }), "php artisan migrate");
  assert.match(installCommand("composer", { require: true, publish: true }), /^composer require spatie\/laravel-activitylog --no-interaction && php artisan vendor:publish --provider='Spatie\\Activitylog\\ActivitylogServiceProvider' --tag=activitylog-migrations && .* && php artisan migrate$/);
});
