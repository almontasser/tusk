/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Column, conditionClosure, filterFor, formField, infolistEntry, type ModelFacts, natureOf, readConditions, renderGen, tableColumn, titleAttribute } from "./filamentgen.ts";

const model: ModelFacts = {
  class: "App\\Models\\Post",
  columns: [],
  casts: { status: "App\\Enums\\Status", published: "boolean", meta: "array", password: "hashed" },
  relations: [{ name: "category", type: "BelongsTo", related: "App\\Models\\Category" }],
  enums: ["App\\Enums\\Status"],
  titles: { "App\\Models\\Category": "title" },
};
const col = (name: string, type: string, extra: Partial<Column> = {}): Column => ({ name, type, nullable: false, default: null, ...extra });
const short = (fqn: string) => fqn.split("\\").pop()!;
const code = (g: ReturnType<typeof formField> | null) => (g ? renderGen(g, short) : "");

test("natureOf reads a column's database type, cast, and name", () => {
  assert.equal(natureOf(col("category_id", "bigint"), model), "foreign");
  assert.equal(natureOf(col("status", "varchar"), model), "enum");
  assert.equal(natureOf(col("published", "tinyint"), model), "boolean");
  assert.equal(natureOf(col("is_active", "tinyint"), model), "boolean");
  assert.equal(natureOf(col("body", "longtext"), model), "richtext");
  assert.equal(natureOf(col("notes", "text"), model), "text");
  assert.equal(natureOf(col("price", "decimal"), model), "money");
  assert.equal(natureOf(col("published_at", "timestamp"), model), "datetime");
  assert.equal(natureOf(col("avatar_url", "varchar"), model), "image");
  assert.equal(natureOf(col("website_url", "varchar"), model), "url");
  assert.equal(natureOf(col("id", "bigint", { autoIncrement: true }), model), "id");
});

test("formField writes a fitting field", () => {
  assert.equal(code(formField(col("title", "varchar", { fullType: "varchar(120)" }), model)), "TextInput::make('title')\n    ->required()\n    ->maxLength(120)");
  assert.equal(code(formField(col("category_id", "bigint"), model)), "Select::make('category_id')\n    ->relationship('category', 'title')\n    ->searchable()\n    ->preload()\n    ->required()");
  assert.equal(code(formField(col("status", "varchar"), model)), "Select::make('status')\n    ->options(Status::class)\n    ->required()");
  assert.equal(code(formField(col("published", "tinyint", { default: "0" }), model)), "Toggle::make('published')\n    ->default(false)");
  assert.equal(code(formField(col("email", "varchar", { nullable: true }), model)), "TextInput::make('email')\n    ->email()\n    ->maxLength(255)\n    ->unique(ignoreRecord: true)");
  assert.match(code(formField(col("password", "varchar"), model)), /->password\(\)\n    ->revealable\(\)\n    ->required\(fn \(string \$operation\): bool => \$operation === 'create'\)/);
  assert.equal(code(formField(col("body", "longtext", { nullable: true }), model)), "RichEditor::make('body')\n    ->columnSpanFull()");
});

test("tableColumn, filterFor, and infolistEntry", () => {
  assert.equal(code(tableColumn(col("category_id", "bigint"), model)), "TextColumn::make('category.title')\n    ->label('Category')\n    ->sortable()\n    ->searchable()");
  assert.equal(code(tableColumn(col("published", "boolean"), model)), "IconColumn::make('published')\n    ->boolean()");
  assert.equal(code(tableColumn(col("created_at", "timestamp"), model)), "TextColumn::make('created_at')\n    ->dateTime()\n    ->sortable()\n    ->toggleable(isToggledHiddenByDefault: true)");
  assert.equal(code(filterFor(col("category_id", "bigint"), model)), "SelectFilter::make('category')\n    ->relationship('category', 'title')\n    ->searchable()\n    ->preload()");
  assert.equal(code(filterFor(col("published", "boolean"), model)), "TernaryFilter::make('published')");
  assert.equal(code(filterFor(col("deleted_at", "timestamp"), model)), "TrashedFilter::make()");
  assert.equal(filterFor(col("title", "varchar"), model), null);
  assert.equal(code(infolistEntry(col("status", "varchar"), model)), "TextEntry::make('status')\n    ->badge()");
});

test("titleAttribute prefers a name-like column", () => {
  assert.equal(titleAttribute(["id", "email", "name"]), "name");
  assert.equal(titleAttribute(["id", "code"]), "code");
  assert.equal(titleAttribute(["id"]), "id");
});

test("conditions round-trip through their closure", () => {
  const conditions = [
    { field: "type", op: "equals" as const, value: "company" },
    { field: "vat", op: "filled" as const },
    { field: "count", op: "notEquals" as const, value: "3" },
    { field: "role", op: "in" as const, value: "admin, owner" },
    { field: "active", op: "true" as const },
    { field: "archived", op: "false" as const },
  ];
  const code = conditionClosure(conditions, "all", "Get");
  assert.equal(code, "fn (Get $get): bool => $get('type') === 'company' && filled($get('vat')) && $get('count') !== 3 && in_array($get('role'), ['admin', 'owner'], true) && (bool) $get('active') && ! $get('archived')");
  assert.deepEqual(readConditions(code), { conditions, join: "all" });
  assert.deepEqual(readConditions(conditionClosure([conditions[0], conditions[1]], "any", "Get"))!.join, "any");
  assert.equal(readConditions("fn (Get $get): bool => $get('a') === $get('b')"), null);
  assert.equal(readConditions("fn () => true"), null);
});

test("titleAttribute falls back to the first text column", () => {
  assert.equal(titleAttribute(["id", "company_id", "sender", "status"], { id: "uuid", company_id: "uuid", sender: "varchar", status: "varchar" }), "sender");
  assert.equal(titleAttribute(["id", "count"], { id: "int8", count: "int4" }), "id");
});

test("a polymorphic pair is a morph column, left out of new forms and tables", async () => {
  const { inFormByDefault, inTableByDefault } = await import("./filamentgen.ts");
  const m = { ...model, relations: [...model.relations, { name: "commentable", type: "MorphTo", related: null }] };
  assert.equal(natureOf(col("commentable_type", "varchar"), m), "morph");
  assert.equal(natureOf(col("commentable_id", "integer"), m), "morph");
  assert.equal(inFormByDefault(col("commentable_id", "integer"), m), false);
  assert.equal(inTableByDefault(col("commentable_type", "varchar"), m), false);
  assert.equal(natureOf(col("category_id", "bigint"), m), "foreign");
});
