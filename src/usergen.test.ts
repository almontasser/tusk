import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./designerfixture.ts";
import { applyEdits } from "./phpcode.ts";
import { addColumnsMigration, implementsEdits, migrationName, traitsEdits, userTenantEdits } from "./usergen.ts";

const plain = (code: string) => code.replace(/\{\{[\w\\]*?(\w+)\}\}/g, "$1");

test("contracts and traits are added once, beside the ones the class has", () => {
  const f = fixture("DemoUser");
  const cls = f.outline.classes[0];
  const next = plain(applyEdits(f.text, [...implementsEdits(f.text, cls, ["Filament\\Models\\Contracts\\HasTenants", "Filament\\Auth\\MultiFactor\\Email\\Contracts\\HasEmailAuthentication"]), ...traitsEdits(f.text, cls, ["Filament\\Auth\\MultiFactor\\Email\\Concerns\\InteractsWithEmailAuthentication"])]));
  assert.match(next, /class User extends Authenticatable implements FilamentUser, HasTenants, MustVerifyEmail, HasEmailAuthentication\n\{/);
  assert.match(next, /use Notifiable;\n {4}use InteractsWithEmailAuthentication;\n/);
  const bare = "<?php\nclass A extends B\n{\n    public $x;\n}\n";
  const cls2 = { span: [6, bare.length - 1], bodyStart: bare.indexOf("{") + 1, bodyEnd: bare.lastIndexOf("}"), implements: [], traits: [], methods: [] } as never;
  assert.equal(plain(applyEdits(bare, [...implementsEdits(bare, cls2, ["X\\C"]), ...traitsEdits(bare, cls2, ["X\\T"])])), "<?php\nclass A extends B implements C\n{\n    use T;\n\n    public $x;\n}\n");
});

test("tenancy methods go through the user's relationship", () => {
  const f = fixture("DemoUser");
  const cls = { ...f.outline.classes[0], methods: [] };
  const many = plain(applyEdits(f.text, userTenantEdits(f.text, cls, { name: "teams", type: "BelongsToMany" })!));
  assert.match(many, /public function canAccessTenant\(Model \$tenant\): bool\n {4}\{\n {8}return \$this->teams\(\)->whereKey\(\$tenant\)->exists\(\);/);
  const one = plain(applyEdits(f.text, userTenantEdits(f.text, cls, { name: "company", type: "BelongsTo" })!));
  assert.match(one, /return collect\(\[\$this->company\]\)->filter\(\);/);
  assert.equal(userTenantEdits(f.text, cls, { name: "x", type: "Other" }), null);
});

test("the migration adds and drops the columns", () => {
  const m = addColumnsMigration("users", ["has_email_authentication"]);
  assert.match(m, /Schema::table\('users', function \(Blueprint \$table\) \{\n {12}\$table->boolean\('has_email_authentication'\)->default\(false\);/);
  assert.match(m, /dropColumn\(\['has_email_authentication'\]\)/);
  assert.equal(migrationName("add_x", new Date(2026, 8, 29, 7, 5, 3)), "2026_09_29_070503_add_x.php");
});
