/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { alterMigration, alterName, castFor, type ColumnSpec, columnCall, columnFromDatabase, createMigration, diffColumns, factoryFile, fakerFor, migrationFileName, modelFile, type ModelSpec, pivotTable, plural, relationMethod, singular, tableFor } from "./modelgen.ts";

const col = (name: string, type: string, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({ id: name, name, type, nullable: false, fillable: true, ...extra });
const post: ModelSpec = {
  name: "Post",
  namespace: "App\\Models",
  table: "posts",
  key: "id",
  timestamps: true,
  softDeletes: true,
  columns: [
    col("title", "string"),
    col("slug", "string", { unique: true }),
    col("body", "longText", { nullable: true }),
    col("status", "string", { enum: "App\\Enums\\PostStatus", default: "'draft'" }),
    col("price", "decimal", { precision: 8, scale: 2 }),
    col("published", "boolean", { default: "false" }),
    col("category_id", "foreignId", { onDelete: "cascade", fillable: true }),
  ],
  relations: [
    { id: "r1", type: "belongsTo", name: "category", related: "App\\Models\\Category" },
    { id: "r2", type: "belongsToMany", name: "tags", related: "App\\Models\\Tag" },
  ],
};

test("names follow Laravel's", () => {
  assert.equal(tableFor("BlogPost"), "blog_posts");
  assert.equal(tableFor("Category"), "categories");
  assert.equal(tableFor("Person"), "people");
  assert.equal(tableFor("Status"), "statuses");
  assert.equal(tableFor("Box"), "boxes");
  assert.equal(plural("leaf"), "leaves");
  assert.equal(singular("categories"), "category");
  assert.equal(singular("people"), "person");
  assert.equal(pivotTable("Tag", "Post"), "post_tag");
});

test("columnCall writes Blueprint calls", () => {
  assert.equal(columnCall(col("title", "string")), "string('title')");
  assert.equal(columnCall(col("code", "string", { length: 20, unique: true })), "string('code', 20)->unique()");
  assert.equal(columnCall(col("price", "decimal", { precision: 8, scale: 2, nullable: true })), "decimal('price', 8, 2)->nullable()");
  assert.equal(columnCall(col("status", "string", { default: "'draft'", index: true })), "string('status')->default('draft')->index()");
  assert.equal(columnCall(col("category_id", "foreignId", { onDelete: "cascade" })), "foreignId('category_id')->constrained()->cascadeOnDelete()");
  assert.equal(columnCall(col("owner_id", "foreignId", { nullable: true, references: "users", onDelete: "set null" })), "foreignId('owner_id')->nullable()->constrained('users')->nullOnDelete()");
});

test("casts and fakes", () => {
  assert.equal(castFor(col("published", "boolean")), "'boolean'");
  assert.equal(castFor(col("status", "string", { enum: "App\\Enums\\PostStatus" })), "PostStatus::class");
  assert.equal(castFor(col("price", "decimal", { scale: 2 })), "'decimal:2'");
  assert.equal(castFor(col("title", "string")), null);
  assert.equal(fakerFor(col("email", "string", { unique: true }), []), "fake()->unique()->safeEmail()");
  assert.equal(fakerFor(col("category_id", "foreignId"), post.relations), "Category::factory()");
  assert.equal(fakerFor(col("status", "string", { enum: "App\\Enums\\PostStatus" }), []), "fake()->randomElement(PostStatus::cases())");
});

test("createMigration writes the table with its key, columns, timestamps, and soft deletes", () => {
  const code = createMigration(post);
  assert.match(code, /Schema::create\('posts', function \(Blueprint \$table\) \{\n {12}\$table->id\(\);\n {12}\$table->string\('title'\);\n/);
  assert.match(code, /\$table->foreignId\('category_id'\)->constrained\(\)->cascadeOnDelete\(\);\n {12}\$table->timestamps\(\);\n {12}\$table->softDeletes\(\);\n {8}\}\);/);
  assert.match(code, /Schema::dropIfExists\('posts'\);/);
});

test("modelFile writes imports, traits, fillable, casts, and relationships", () => {
  const code = modelFile(post, { factory: true });
  assert.match(code, /^<\?php\n\nnamespace App\\Models;\n\nuse App\\Enums\\PostStatus;\nuse Illuminate\\Database\\Eloquent\\Factories\\HasFactory;/);
  assert.match(code, /use Illuminate\\Database\\Eloquent\\Relations\\BelongsTo;\nuse Illuminate\\Database\\Eloquent\\Relations\\BelongsToMany;\nuse Illuminate\\Database\\Eloquent\\SoftDeletes;/);
  assert.doesNotMatch(code, /use App\\Models\\Category;/);
  assert.match(code, /\/\*\* @use HasFactory<\\Database\\Factories\\PostFactory> \*\/\n {4}use HasFactory, SoftDeletes;/);
  assert.match(code, /protected \$fillable = \[\n {8}'title',\n {8}'slug',/);
  assert.match(code, /'status' => PostStatus::class,\n {12}'price' => 'decimal:2',\n {12}'published' => 'boolean',/);
  assert.match(code, /public function category\(\): BelongsTo\n {4}\{\n {8}return \$this->belongsTo\(Category::class\);\n {4}\}/);
  assert.match(code, /public function tags\(\): BelongsToMany/);
});

test("relationMethod names non-default keys", () => {
  assert.equal(relationMethod({ id: "", type: "hasMany", name: "comments", related: "App\\Models\\Comment" }), "public function comments(): HasMany\n{\n    return $this->hasMany(Comment::class);\n}");
  assert.match(relationMethod({ id: "", type: "belongsTo", name: "owner", related: "App\\Models\\User", foreignKey: "user_id" }), /belongsTo\(User::class, 'user_id'\)/);
});

test("factoryFile fakes each column", () => {
  const code = factoryFile(post);
  assert.match(code, /use App\\Models\\Category;\nuse App\\Models\\Post;/);
  assert.match(code, /'title' => fake\(\)->sentence\(\),/);
  assert.match(code, /'category_id' => Category::factory\(\),/);
  assert.match(code, /class PostFactory extends Factory/);
});

test("diffColumns and alterMigration change a table and undo it", () => {
  const before = [col("title", "string"), col("old", "string"), col("views", "integer")];
  const designed = [
    { ...col("headline", "string"), original: before[0] },
    { ...col("views", "bigInteger", { nullable: true }), original: before[2] },
    col("summary", "text", { nullable: true }),
  ];
  const changes = diffColumns(designed, before);
  assert.deepEqual(changes.map((c) => c.kind), ["rename", "change", "add", "drop"]);
  const code = alterMigration("posts", changes);
  assert.match(code, /up\(\): void\n {4}\{\n {8}Schema::table\('posts', function \(Blueprint \$table\) \{\n {12}\$table->renameColumn\('title', 'headline'\);\n {12}\$table->bigInteger\('views'\)->nullable\(\)->change\(\);\n {12}\$table->text\('summary'\)->nullable\(\);\n {12}\$table->dropColumn\('old'\);/);
  assert.match(code, /down\(\): void\n {4}\{\n {8}Schema::table\('posts', function \(Blueprint \$table\) \{\n {12}\$table->string\('old'\);\n {12}\$table->dropColumn\('summary'\);\n {12}\$table->integer\('views'\)->change\(\);\n {12}\$table->renameColumn\('headline', 'title'\);/);
  assert.equal(alterName("posts", [changes[2]]), "add_summary_to_posts_table");
  assert.equal(alterName("posts", changes), "update_posts_table");
  assert.equal(migrationFileName("create_posts_table", new Date(2026, 8, 28, 14, 3, 9)), "2026_09_28_140309_create_posts_table.php");
});

test("columnFromDatabase reads database types", () => {
  const read = (type: string, fullType: string, extra = {}) => columnFromDatabase({ name: "x", type, fullType, nullable: false, default: null }, { unique: false, index: false, fillable: true, hidden: false, id: "x", ...extra });
  assert.equal(read("varchar", "varchar(120)").length, 120);
  assert.equal(read("varchar", "varchar(120)").type, "string");
  assert.equal(read("tinyint", "tinyint(1)").type, "boolean");
  assert.equal(read("bigint", "bigint unsigned").type, "unsignedBigInteger");
  assert.deepEqual([read("decimal", "decimal(8,2)").precision, read("decimal", "decimal(8,2)").scale], [8, 2]);
  assert.equal(read("integer", "integer", { cast: "boolean" }).type, "boolean");
  assert.equal(read("integer", "integer", { foreign: { table: "users", onDelete: "cascade" } }).type, "foreignId");
  assert.equal(columnFromDatabase({ name: "s", type: "varchar", nullable: false, default: "draft" }, { unique: false, index: false, fillable: true, hidden: false, id: "s" }).default, "'draft'");
});

test("columnFromDatabase reads SQLite's boolean defaults", () => {
  const c = columnFromDatabase({ name: "published", type: "integer", nullable: false, default: "'0'" }, { unique: false, index: false, fillable: true, hidden: false, id: "p", cast: "boolean" });
  assert.equal(c.type, "boolean");
  assert.equal(c.default, "false");
});
