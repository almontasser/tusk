import assert from "node:assert/strict";
import { applyEdits } from "./phpcode.ts";
import { test } from "node:test";
import { fixture } from "./designerfixture.ts";
import { entryBody, entryEdits, permissionName, permissionsOf, readEntry, readPolicy, readRule, type Rule, ruleCode, splitAt } from "./policygen.ts";

const v = { user: "user", model: "post" };

test("rules round-trip through their code", () => {
  const rules: Rule[] = [
    { kind: "everyone" },
    { kind: "nobody" },
    { kind: "when", join: "any", conds: [{ kind: "permission", name: "update posts" }, { kind: "owner", column: "author_id" }] },
    { kind: "when", join: "all", conds: [{ kind: "role", name: "editor" }, { kind: "permission", name: "publish_post" }] },
  ];
  for (const r of rules) assert.deepEqual(readRule(ruleCode(r, v)!, v), r);
  assert.equal(ruleCode({ kind: "when", join: "any", conds: [{ kind: "owner", column: "user_id" }] }, v), "$user->id === $post->user_id");
});

test("readRule leaves code it doesn't write custom", () => {
  assert.equal(readRule("$user->can('a') && $this->owns($user, $post)", v).kind, "custom");
  assert.equal(readRule("$user->can('a') || $user->can('b') && $user->can('c')", v).kind, "custom");
  assert.deepEqual(readRule("$post->user_id == $user->getKey()", v), { kind: "when", join: "all", conds: [{ kind: "owner", column: "user_id" }] });
  assert.deepEqual(splitAt("$u->can('a || b') || f(x || y)", "||"), ["$u->can('a || b')", "f(x || y)"]);
});

test("readPolicy reads Shield's policies, and keeps helpers and statements", () => {
  const f = fixture("ProjectPolicy");
  const read = readPolicy(f.text, f.outline.classes[0], "Project");
  const by = Object.fromEntries(read.map((r) => [r.ability.name, r]));
  assert.deepEqual(by.viewAny.rule, { kind: "when", join: "all", conds: [{ kind: "permission", name: "view_any_project" }] });
  assert.equal(by.viewAny.vars.user, "authUser");
  assert.equal(by.viewAny.vars.model, "project");
  assert.equal(by.update.rule?.kind, "custom");
  assert.equal(by.deleteAny.method, null);
  assert.deepEqual(permissionsOf(read), ["view_any_project", "create_project", "restore_any_project", "force_delete_any_project", "reorder_project"]);

  const p = fixture("PostPolicy");
  const post = Object.fromEntries(readPolicy(p.text, p.outline.classes[0], "Post").map((r) => [r.ability.name, r]));
  assert.equal(post.viewAny.rule?.kind, "nobody");
  assert.deepEqual(post.view.rule, { kind: "when", join: "any", conds: [{ kind: "permission", name: "view posts" }, { kind: "owner", column: "author_id" }] });
  assert.equal(post.update.rule?.kind, "custom");
});

test("permissionName follows Shield", () => {
  assert.equal(permissionName("viewAny", "Project"), "view_any_project");
  assert.equal(permissionName("forceDelete", "OrderItem"), "force_delete_order_item");
  assert.equal(permissionName("viewAny", "OrderItem", { format: { separator: ":", case: "pascal" } }), "ViewAny:OrderItem");
  assert.equal(permissionName("viewAny", "Project", { keys: { viewAny: "view_any_project" }, format: { separator: ":", case: "pascal" } }), "view_any_project");
  // An ability Shield has no key for follows the keys it has, over the config.
  assert.equal(permissionName("deleteAny", "Project", { keys: { viewAny: "view_any_project" }, format: { separator: ":", case: "pascal" } }), "delete_any_project");
});

test("page and widget rules round-trip through their method", () => {
  const cls = (body: string | null, traits: string[] = []) => {
    const text = `<?php class P { ${body === null ? "" : `public static function canAccess(): bool {${body}}`} }`;
    const start = text.indexOf("bool {") + 6;
    const methods = body === null ? [] : [{ name: "canAccess", body: [start, start + body.length] as [number, number] }];
    return { text, cls: { traits, methods } as never };
  };
  const rules: Rule[] = [
    { kind: "nobody" },
    { kind: "when", join: "all", conds: [{ kind: "permission", name: "page_Settings" }] },
    { kind: "when", join: "all", conds: [{ kind: "role", name: "admin" }, { kind: "permission", name: "x" }] },
  ];
  for (const r of rules) {
    const c = cls(entryBody(r));
    assert.deepEqual(readEntry(c.text, c.cls, "page"), r);
  }
  assert.equal(entryBody({ kind: "everyone" }), null);
  const none = cls(null);
  assert.deepEqual(readEntry(none.text, none.cls, "page"), { kind: "everyone" });
  const shield = cls(null, ["HasPageShield"]);
  assert.deepEqual(readEntry(shield.text, shield.cls, "page"), { kind: "shield" });
  const custom = cls("return auth()->user()?->isAdmin();");
  assert.deepEqual(readEntry(custom.text, custom.cls, "page"), { kind: "custom" });
});

/** A class's outline where only its body's bounds and methods matter: for text changed in a test. */
const fixtureOf = (text: string) => ({ ...fixture("SettingsPage").outline.classes[0], bodyStart: text.indexOf("{", text.indexOf("class ")) + 1, bodyEnd: text.lastIndexOf("}"), methods: [] });

test("page access is written in canAccess(), or as Shield's trait", () => {
  const f = fixture("SettingsPage");
  const cls = f.outline.classes[0];
  const fill = (c: string) => c.replace(/\{\{[\w\\]*?(\w+)\}\}/g, "$1");
  const when = applyEdits(f.text, entryEdits(f.text, cls, "page", { kind: "when", join: "any", conds: [{ kind: "permission", name: "page_Settings" }, { kind: "role", name: "admin" }] }, fill));
  assert.match(when, /public static function canAccess\(\): bool\n {4}\{\n {8}\$user = auth\(\)->user\(\);\n\n {8}return \$user !== null && \(\$user->can\('page_Settings'\) \|\| \$user->hasRole\('admin'\)\);\n {4}\}/);
  const shield = applyEdits(f.text, entryEdits(f.text, cls, "page", { kind: "shield" }, fill));
  assert.match(shield, /class SettingsPage extends Page\n\{\n {4}use HasPageShield;\n\n {4}protected static/);
  assert.doesNotMatch(shield, /canAccess/);
  const back = fixtureOf(shield);
  assert.match(applyEdits(shield, entryEdits(shield, back, "page", { kind: "nobody" }, fill)), /class SettingsPage extends Page\n\{\n {4}protected static/);
  assert.doesNotMatch(applyEdits(f.text, entryEdits(f.text, cls, "page", { kind: "everyone" }, fill)), /canAccess/);
});
