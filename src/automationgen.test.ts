import assert from "node:assert/strict";
import { test } from "node:test";
import { type Action, conditionCode, observedByEdits, readCondition, readObserver, readValue, type Rule, ruleEdits, type Value, valueCode } from "./automationgen.ts";
import { fixture } from "./designerfixture.ts";
import { applyEdits } from "./phpcode.ts";

const resolve = (name: string) => (name === "PostStatus" ? "App\\Enums\\PostStatus" : `App\\Notifications\\${name}`);
const plain = (code: string) => code.replace(/\{\{[\w\\]*?(\w+)\}\}/g, "$1");
const ctx = { variable: "post", modelType: "Post", userModel: "App\\Models\\User" };
const published: Value = { kind: "case", enum: "App\\Enums\\PostStatus", case: "Published" };

test("values and conditions round-trip through their code", () => {
  const values: Value[] = [{ kind: "string", value: "it's" }, { kind: "number", value: 2.5 }, { kind: "bool", value: false }, { kind: "null" }, published, { kind: "now" }, { kind: "user" }];
  for (const v of values) assert.deepEqual(readValue(plain(valueCode(v)), resolve), v);
  assert.equal(readValue("$post->other", resolve), null);
  const becomes = { kind: "becomes", field: "status", value: published } as const;
  const conds = [{ field: "views", op: ">=", value: { kind: "number", value: 10 } }] as const;
  assert.equal(plain(conditionCode(becomes, [...conds], "updated", "post")), "$post->wasChanged('status') && $post->status === PostStatus::Published && $post->views >= 10");
  assert.equal(plain(conditionCode(becomes, [], "updating", "post")), "$post->isDirty('status') && $post->status === PostStatus::Published");
  for (const m of ["updated", "updating"]) assert.deepEqual(readCondition(plain(conditionCode(becomes, [...conds], m, "post")), m, "post", resolve), { trigger: becomes, conds });
  assert.deepEqual(readCondition("$post->wasChanged('title')", "updated", "post", resolve), { trigger: { kind: "changed", field: "title" }, conds: [] });
  assert.equal(readCondition("$post->isDirty('title')", "updated", "post", resolve), null);
  assert.equal(readCondition("$a || $b", "created", "post", resolve), null);
});

test("readObserver pairs blocks into rules and keeps other code", () => {
  const f = fixture("PostObserver");
  const { rules, other } = readObserver(f.text, f.outline, f.outline.classes[0], "post");
  assert.deepEqual(
    rules.map((r) => [r.trigger.kind, r.conds.length, r.actions.map((a) => a.kind), r.blocks.map((b) => b.method)]),
    [
      ["created", 0, ["send"], ["created"]],
      ["becomes", 0, ["set", "send", "code"], ["updating", "updated"]],
      ["deleted", 2, ["send"], ["deleted"]],
    ],
  );
  assert.deepEqual(rules[0].actions[0], { kind: "send", send: { notification: "App\\Notifications\\PostPublished", recipient: { kind: "role", role: "admin" }, withRecord: true } });
  assert.deepEqual(rules[1].actions[0], { kind: "set", field: "published_at", value: { kind: "now" } });
  assert.deepEqual(rules[2].conds[0], { field: "published", op: "==", value: { kind: "bool", value: true } });
  assert.deepEqual(
    other.map((o) => [o.method, o.statement, f.text.slice(o.span[0], o.span[1]).split("\n")[0]]),
    [
      ["updated", true, "if ($post->views > 100 || $post->featured) {"],
      ["forceDeleted", false, "public function forceDeleted(Post $post): void"],
    ],
  );
});

test("ruleEdits rewrites, moves, adds, and removes blocks", () => {
  const f = fixture("PostObserver");
  const cls = f.outline.classes[0];
  const { rules } = readObserver(f.text, f.outline, cls, "post");
  const edit = (from: Rule | null, to: Rule | null) => plain(applyEdits(f.text, ruleEdits(f.text, cls, from, to, ctx)));

  // A condition added to the created rule turns its statement into an `if`.
  const draft = { field: "status", op: "===", value: published } as const;
  let out = edit(rules[0], { ...rules[0], conds: [draft] });
  assert.match(out, /public function created\(Post \$post\): void\n {4}\{\n {8}if \(\$post->status === PostStatus::Published\) \{\n {12}Notification::send\(User::role\('admin'\)->get\(\), new PostPublished\(\$post\)\);\n {8}\}\n {4}\}/);

  // Deleting the paired rule removes `updating` whole and only its block from `updated`, keeping the other code.
  out = edit(rules[1], null);
  assert.doesNotMatch(out, /function updating|published_at|logger/);
  assert.match(out, /public function updated\(Post \$post\): void\n {4}\{\n {8}\/\/ Kept as written\.\n {8}if \(\$post->views > 100/);

  // Setting a field on a created rule adds `creating`, above `created`.
  const set: Action = { kind: "set", field: "slug", value: { kind: "string", value: "draft" } };
  out = edit(rules[0], { ...rules[0], actions: [...rules[0].actions, set] });
  assert.match(out, /\{\n {4}public function creating\(Post \$post\): void\n {4}\{\n {8}\$post->slug = 'draft';\n {4}\}\n\n {4}public function created/);

  // A rule moved from deleted to updated leaves deleted, and lands at the end of updated.
  out = edit(rules[2], { ...rules[2], trigger: { kind: "updated" } });
  assert.doesNotMatch(out, /function deleted/);
  assert.match(out, /cache\(\)->forget\('popular'\);\n {8}\}\n\n {8}if \(\$post->published == true && \$post->views >= 10\) \{\n {12}Notification::route/);
});

test("observedByEdits adds the attribute or an item to it", () => {
  const f = fixture("Post");
  const out = plain(applyEdits(f.text, observedByEdits(f.text, f.outline.classes[0], "App\\Observers\\PostObserver")));
  assert.match(out, /\n#\[ObservedBy\(\[PostObserver::class\]\)\]\nclass Post extends Model/);
  const text = "<?php\n\n#[ObservedBy([A::class])]\nclass Post\n{\n}\n";
  const item = { kind: "classConst", span: [21, 29], class: "A", classSpan: [21, 22], name: "class" };
  const list = { kind: "array", span: [20, 30], open: 20, close: 29, legacy: false, items: [{ key: null, span: [21, 29], spread: false, value: item }] };
  const cls = { attributes: [{ name: "Illuminate\\Database\\Eloquent\\Attributes\\ObservedBy", args: { open: 19, close: 30, items: [{ name: null, span: [20, 30], spread: false, value: list }] }, span: [9, 31], list: [7, 32] }], span: [33, 45] };
  assert.equal(plain(applyEdits(text, observedByEdits(text, cls as never, "App\\Observers\\B"))), "<?php\n\n#[ObservedBy([A::class, B::class])]\nclass Post\n{\n}\n");
});
