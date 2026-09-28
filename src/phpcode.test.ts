/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addMember,
  type ArrayNode,
  applyEdits,
  Imports,
  insertItem,
  moveItem,
  nodeValue,
  phpValue,
  raw,
  removeCall,
  removeItem,
  removeMethod,
  setCall,
  setProperty,
  textValue,
} from "./phpcode.ts";
import { fixture } from "./designerfixture.ts";


const post = fixture("PostResource");
const cls = post.outline.classes[0];
const returnOf = (name: string) => cls.methods.find((m) => m.name === name)!.returns[0];
const formRoot = returnOf("form");
const components = () => {
  if (formRoot.kind !== "chain") throw new Error("form isn't a chain");
  const arr = formRoot.calls.find((c) => c.name === "components")!.args.items[0].value;
  return arr as ArrayNode;
};
const sectionSchema = () => {
  const section = components().items[0].value;
  if (section.kind !== "chain") throw new Error("section isn't a chain");
  return section.calls.find((c) => c.name === "schema")!.args.items[0].value as ArrayNode;
};

test("phpValue writes short lists on one line and maps on several", () => {
  assert.equal(phpValue(["a", "b"]), "['a', 'b']");
  assert.equal(phpValue({ draft: "Draft", published: "Published" }), "[\n    'draft' => 'Draft',\n    'published' => 'Published',\n]");
  assert.equal(phpValue({ 0: "a" }), "[0 => 'a']");
  assert.equal(phpValue("it's"), "'it\\'s'");
  assert.equal(phpValue([raw("Status::class")]), "[Status::class]");
  assert.equal(phpValue({ a: { b: 1 } }, "    "), "[\n        'a' => ['b' => 1],\n    ]");
});

test("nodeValue and textValue read plain values and translated strings", () => {
  const slug = sectionSchema().items[1].value;
  assert.equal(slug.kind, "chain");
  const label = slug.kind === "chain" ? slug.calls.find((c) => c.name === "label")!.args.items[0].value : null;
  assert.deepEqual(textValue(label), { text: "Slug", translated: true });
  const max = sectionSchema().items[0].value;
  const arg = max.kind === "chain" ? max.calls.find((c) => c.name === "maxLength")!.args.items[0].value : null;
  assert.equal(nodeValue(arg), 255);
});

test("insertItem adds a component at the end of a multi-line array, keeping the trailing comma", () => {
  const out = applyEdits(post.text, [insertItem(post.text, sectionSchema(), 3, "Toggle::make('featured')\n    ->default(false)")]);
  assert.match(out, /->searchable\(\),\n {24}Toggle::make\('featured'\)\n {28}->default\(false\),\n {20}\]\)/);
});

test("insertItem adds before an item and into an empty array", () => {
  const out = applyEdits(post.text, [insertItem(post.text, sectionSchema(), 0, "TextInput::make('subtitle')")]);
  assert.match(out, /->schema\(\[\n {24}TextInput::make\('subtitle'\),\n {24}TextInput::make\('title'\)/);
  const tag = fixture("TagForm");
  const arr = (() => {
    const r = tag.outline.classes[0].methods[0].returns[0];
    return (r.kind === "chain" ? r.calls[0].args.items[0].value : null) as ArrayNode;
  })();
  const filled = applyEdits(tag.text, [insertItem(tag.text, arr, 0, "TextInput::make('name')")]);
  assert.match(filled, /->components\(\[\n {16}TextInput::make\('name'\),\n {12}\]\);/);
});

test("insertItem keeps a one-line array on one line", () => {
  const bare = fixture("Bare");
  const arr = bare.outline.classes[0].methods[0].returns[0] as ArrayNode;
  assert.equal(applyEdits(bare.text, [insertItem(bare.text, arr, 2, "'c'")]).includes("['a', 'b', 'c']"), true);
  assert.equal(applyEdits(bare.text, [insertItem(bare.text, arr, 0, "'z'")]).includes("['z', 'a', 'b']"), true);
  assert.equal(applyEdits(bare.text, [removeItem(bare.text, arr, 0)]).includes("return ['b'];"), true);
  assert.equal(applyEdits(bare.text, [removeItem(bare.text, arr, 1)]).includes("return ['a'];"), true);
});

test("removeItem takes the item's lines and keeps the comment above the next one", () => {
  const first = applyEdits(post.text, [removeItem(post.text, sectionSchema(), 0)]);
  assert.match(first, /->schema\(\[\n {24}\/\/ The slug follows/);
  const middle = applyEdits(post.text, [removeItem(post.text, sectionSchema(), 1)]);
  assert.match(middle, /->maxLength\(255\),\n {24}Select::make/);
  const last = applyEdits(post.text, [removeItem(post.text, sectionSchema(), 2)]);
  assert.match(last, /\$state \?\? ''\)\),\n {20}\]\)/);
});

test("moveItem moves a component with its calls", () => {
  const out = applyEdits(post.text, moveItem(post.text, sectionSchema(), 2, 0));
  assert.match(out, /->schema\(\[\n {24}Select::make\('category_id'\)\n {28}->relationship\('category', 'name'\)\n {28}->searchable\(\),\n {24}TextInput::make\('title'\)/);
  assert.doesNotMatch(out, /searchable\(\),\n {20}\]\)/);
});

test("setCall replaces arguments, appends on its own line, or stays on one line", () => {
  const title = sectionSchema().items[0].value;
  assert.match(applyEdits(post.text, [setCall(post.text, title, "maxLength", "100")]), /->maxLength\(100\)/);
  assert.match(applyEdits(post.text, [setCall(post.text, title, "placeholder", "'Title'")]), /->maxLength\(255\)\n {28}->placeholder\('Title'\),/);
  const published = components().items[1].value;
  assert.match(applyEdits(post.text, [setCall(post.text, published, "default", "true")]), /Toggle::make\('published'\)\n {20}->default\(true\),/);
  const tableRoot = returnOf("table");
  if (tableRoot.kind !== "chain") throw new Error("table isn't a chain");
  const titleColumn = (tableRoot.calls[0].args.items[0].value as ArrayNode).items[0].value;
  assert.match(applyEdits(post.text, [setCall(post.text, titleColumn, "toggleable", "")]), /TextColumn::make\('title'\)->searchable\(\)->sortable\(\)->toggleable\(\),/);
});

test("removeCall takes the call with the space before it", () => {
  const title = sectionSchema().items[0].value;
  if (title.kind !== "chain") throw new Error();
  const out = applyEdits(post.text, [removeCall(title, title.calls[0])]);
  assert.match(out, /TextInput::make\('title'\)\n {28}->maxLength\(255\),/);
});

test("Imports reuses imports, names classes under an imported namespace, and sorts new imports in", () => {
  const imports = new Imports(post.text, post.outline);
  assert.equal(imports.name("Filament\\Forms\\Components\\TextInput"), "TextInput");
  assert.equal(imports.name("App\\Filament\\Resources\\PostResource\\Pages\\ViewPost"), "Pages\\ViewPost");
  assert.equal(imports.name("Filament\\Forms\\Components\\DatePicker"), "DatePicker");
  assert.equal(imports.name("Filament\\Forms\\Components\\DatePicker"), "DatePicker");
  assert.equal(imports.name("Other\\Toggle"), "\\Other\\Toggle");
  const out = applyEdits(post.text, imports.edits());
  assert.match(out, /use Filament\\Actions\\EditAction;\nuse Filament\\Forms\\Components\\DatePicker;\nuse Filament\\Forms\\Components\\Select;/);
});

test("Imports starts a block in a file without imports", () => {
  const bare = fixture("Bare");
  const imports = new Imports(bare.text, bare.outline);
  imports.name("App\\Models\\Post");
  assert.match(applyEdits(bare.text, imports.edits()), /namespace App\\Support;\n\nuse App\\Models\\Post;\n\nclass Bare/);
});

test("setProperty changes a value or declares the property after the last one", () => {
  const changed = applyEdits(post.text, [setProperty(post.text, cls, "navigationIcon", "Heroicon::OutlinedNewspaper", "protected static string|BackedEnum|null $navigationIcon")]);
  assert.match(changed, /\$navigationIcon = Heroicon::OutlinedNewspaper;/);
  const added = applyEdits(post.text, [setProperty(post.text, cls, "navigationGroup", "'Blog'", "protected static string|\\UnitEnum|null $navigationGroup")]);
  assert.match(added, /Heroicon::OutlinedDocumentText;\n\n {4}protected static string\|\\UnitEnum\|null \$navigationGroup = 'Blog';\n\n {4}public static function form/);
});

test("addMember and removeMethod", () => {
  const added = applyEdits(post.text, [addMember(post.text, cls, "public static function getNavigationBadge(): ?string\n{\n    return (string) static::getModel()::count();\n}")]);
  assert.match(added, /\n {4}}\n\n {4}public static function getNavigationBadge\(\): \?string\n {4}\{\n {8}return \(string\) static::getModel\(\)::count\(\);\n {4}}\n}\n$/);
  const removed = applyEdits(post.text, [removeMethod(post.text, cls.methods.find((m) => m.name === "getRelations")!)]);
  assert.doesNotMatch(removed, /getRelations/);
  assert.match(removed, /\n {4}}\n\n {4}public static function getPages/);
});

test("mergeEdits joins inserts at one offset in order and refuses overlaps", async () => {
  const { mergeEdits } = await import("./phpcode.ts");
  assert.deepEqual(mergeEdits([{ start: 5, end: 5, text: "a" }, { start: 1, end: 2, text: "x" }, { start: 5, end: 5, text: "b" }]), [{ start: 1, end: 2, text: "x" }, { start: 5, end: 5, text: "ab" }]);
  assert.throws(() => mergeEdits([{ start: 1, end: 4, text: "" }, { start: 2, end: 3, text: "" }]));
});

test("mapValue reads options with translated labels, and refuses other code", async () => {
  const { mapValue, mapCode } = await import("./phpcode.ts");
  const text = "<?php return ['SenderId' => __('SenderId'), 'short' => 'Short', 3 => 'Three'];";
  const arr = { kind: "array", span: [0, 0], open: 0, close: 0, legacy: false, items: [
    { key: { kind: "string", value: "SenderId", quote: "single", interpolated: false, span: [0, 0] }, value: { kind: "func", name: "__", nameSpan: [0, 0], span: [0, 0], args: { open: 0, close: 0, items: [{ name: null, spread: false, span: [0, 0], value: { kind: "string", value: "SenderId", quote: "single", interpolated: false, span: [0, 0] } }] } }, span: [0, 0], spread: false },
    { key: { kind: "string", value: "short", quote: "single", interpolated: false, span: [0, 0] }, value: { kind: "string", value: "Short", quote: "single", interpolated: false, span: [0, 0] }, span: [0, 0], spread: false },
    { key: { kind: "number", value: 3, raw: "3", span: [0, 0] }, value: { kind: "string", value: "Three", quote: "single", interpolated: false, span: [0, 0] }, span: [0, 0], spread: false },
  ] } as const;
  void text;
  assert.deepEqual(mapValue(arr as never), { entries: [["SenderId", "SenderId"], ["short", "Short"], ["3", "Three"]], translated: true });
  const withCode = { ...arr, items: [...arr.items, { key: null, value: { kind: "other", span: [0, 0] }, span: [0, 0], spread: false }] };
  assert.equal(mapValue(withCode as never), undefined);
  assert.equal(mapCode([["draft", "Draft"], ["2", "Two"]], true), "[\n    'draft' => __('Draft'),\n    2 => __('Two'),\n]");
});

test("droppedImports removes imports an edit leaves unused, and only those", async () => {
  const { droppedImports } = await import("./phpcode.ts");
  const text = post.text;
  const cls = post.outline.classes[0];
  const form = cls.methods.find((m) => m.name === "form")!.returns[0];
  if (form.kind !== "chain") throw new Error();
  const arr = form.calls.find((c) => c.name === "components")!.args.items[0].value as ArrayNode;
  // Removing the only Toggle leaves its import unused.
  const edits = [removeItem(text, arr, 1)];
  const dropped = droppedImports(text, post.outline, edits);
  const out = applyEdits(text, [...edits, ...dropped]);
  assert.doesNotMatch(out, /use Filament\\Forms\\Components\\Toggle;/);
  assert.match(out, /use Filament\\Forms\\Components\\TextInput;/);
  assert.deepEqual(droppedImports(text, post.outline, []), []);
});
