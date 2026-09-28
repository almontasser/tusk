import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./designerfixture.ts";
import { permissionName, permissionsOf, readPolicy, readRule, type Rule, ruleCode, splitAt } from "./policygen.ts";

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
});
