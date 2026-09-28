/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { readRoot, resolve, rootSlot, shortClass, walk, within } from "./filamentschema.ts";
import { fixture } from "./designerfixture.ts";

const post = fixture("PostResource");
const cls = post.outline.classes[0];

test("readRoot reads a form's components, their slots, and names", () => {
  const form = readRoot(cls, "form")!;
  const slot = form.slots.get("components")!;
  assert.equal(slot.entries.length, 2);
  const section = slot.entries[0].comp!;
  assert.equal(section.cls, "Filament\\Schemas\\Components\\Section");
  assert.equal(section.name, "Content");
  assert.deepEqual(section.slots.map((s) => s.via), ["schema"]);
  assert.deepEqual(section.slots[0].entries.map((e) => e.comp?.name), ["title", "slug", "category_id"]);
  assert.equal(slot.entries[1].comp!.name, "published");
});

test("readRoot reads a table's columns, filters, and actions, with nested action groups", () => {
  const table = readRoot(cls, "table")!;
  assert.deepEqual([...table.slots.keys()], ["columns", "filters", "recordActions", "toolbarActions"]);
  assert.equal(rootSlot(table, ["recordActions", "actions"])!.entries[0].comp!.cls, "Filament\\Actions\\EditAction");
  const group = table.slots.get("toolbarActions")!.entries[0].comp!;
  assert.equal(shortClass(group.cls), "BulkActionGroup");
  assert.equal(group.slots[0].via, "make");
  assert.equal(shortClass(group.slots[0].entries[0].comp!.cls), "DeleteBulkAction");
});

test("readRoot follows a Filament 4 resource's delegation to its schema class", () => {
  const tag = fixture("TagResource").outline.classes[0];
  assert.deepEqual(readRoot(tag, "form")!.delegate, { class: "App\\Filament\\Resources\\Tags\\Schemas\\TagForm", method: "configure" });
  assert.equal(readRoot(tag, "infolist"), null);
  const form = readRoot(fixture("TagForm").outline.classes[0], "form", "configure")!;
  assert.equal(form.slots.get("components")!.entries.length, 0);
  const table = readRoot(fixture("TagsTable").outline.classes[0], "table", "configure")!;
  assert.deepEqual([...table.slots.keys()], ["columns", "filters"]);
});

test("paths resolve, walk visits depth first, and within spots descendants", () => {
  const form = readRoot(cls, "form")!;
  const seen: string[] = [];
  walk(form, (c, p) => seen.push(`${c.name}@${p.map((s) => `${s.slot}:${s.index}`).join("/")}`));
  assert.deepEqual(seen, ["Content@components:0", "title@components:0/schema:0", "slug@components:0/schema:1", "category_id@components:0/schema:2", "published@components:1"]);
  assert.equal(resolve(form, [{ slot: "components", index: 0 }, { slot: "schema", index: 2 }])!.entry.comp!.name, "category_id");
  assert.equal(resolve(form, [{ slot: "components", index: 5 }]), null);
  assert.equal(within([{ slot: "components", index: 0 }, { slot: "schema", index: 1 }], [{ slot: "components", index: 0 }]), true);
  assert.equal(within([{ slot: "components", index: 1 }], [{ slot: "components", index: 0 }]), false);
});

test("childSlot finds a layout's children in make(), as Group::make([...]) takes them", async () => {
  const { childSlot } = await import("./filamentschema.ts");
  const form = readRoot(fixture("GroupForm").outline.classes[0], "form", "configure")!;
  const group = form.slots.get("components")!.entries[0].comp!;
  assert.equal(childSlot(group)?.via, "make");
  const section = childSlot(group)!.entries[0].comp!;
  assert.equal(childSlot(section)?.via, "schema");
  assert.equal(childSlot(section)!.entries[0].comp!.name, "sender");
});
