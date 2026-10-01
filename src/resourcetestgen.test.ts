import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./designerfixture.ts";
import { readRoot } from "./filamentschema.ts";
import { factoriesNeeded, factoryClass, factoryFor, factoryKeys, factoryParents, missingBlocks, readFields, type TestSpec, testFile } from "./resourcetestgen.ts";

const form = () => {
  const f = fixture("ArticleForm");
  return readRoot(f.outline.classes[0], "form", "configure")!;
};
const relations = [{ name: "category", related: "App\\Models\\Category" }, { name: "tags", related: "App\\Models\\Tag" }];

test("reads the fields a test can fill", () => {
  const fields = readFields(form(), { relations });
  assert.deepEqual(
    fields.map((f) => [f.name, f.kind, f.required, f.unique]),
    [
      ["title", "text", true, false],
      ["slug", "text", true, true],
      ["contact", "email", false, false],
      ["price", "number", true, false],
      ["body", "rich", false, false],
      ["category_id", "relation", true, false],
      ["status", "enum", true, false],
      ["kind", "options", false, false],
      ["tags", "other", false, false],
      ["featured", "bool", true, false],
      ["published_on", "date", false, false],
      ["cover", "other", true, false],
      ["links", "other", false, false],
    ],
  );
  assert.equal(fields.find((f) => f.name === "category_id")?.related, "App\\Models\\Category");
  assert.equal(fields.find((f) => f.name === "status")?.enum, "App\\Enums\\ArticleStatus");
  assert.equal(fields.find((f) => f.name === "kind")?.option, "news");
});

test("reads a factory's attributes", () => {
  const f = fixture("ArticleFactory");
  assert.deepEqual(factoryKeys(f.outline.classes[0]), ["title", "slug", "category_id", "featured"]);
});

const spec = (o: Partial<TestSpec> = {}): TestSpec => ({
  style: "pest",
  namespace: "Tests\\Feature\\Filament",
  className: "ArticleResourceTest",
  model: "App\\Models\\Article",
  label: "article",
  plural: "articles",
  keyName: "id",
  user: "App\\Models\\User",
  panel: "admin",
  pages: { list: "App\\Filament\\Resources\\Articles\\Pages\\ListArticles", create: "App\\Filament\\Resources\\Articles\\Pages\\CreateArticle", edit: "App\\Filament\\Resources\\Articles\\Pages\\EditArticle" },
  fields: readFields(form(), { relations }),
  factoryKeys: ["title", "slug", "category_id", "featured"],
  columns: ["title", "category.name"],
  manageEdit: false,
  policy: null,
  refreshDatabase: true,
  ...o,
});

test("writes Pest tests for list, create, edit, and each required and unique field", () => {
  const code = testFile(spec());
  assert.match(code, /^<\?php\n\nuse App\\Enums\\ArticleStatus;\nuse App\\Filament\\Resources\\Articles\\Pages\\CreateArticle;\n/);
  assert.doesNotMatch(code, /namespace/);
  assert.match(code, /uses\(RefreshDatabase::class\);/);
  assert.match(code, /Filament::setCurrentPanel\('admin'\);/);
  assert.match(code, /it\('lists articles'[\s\S]*->assertCanRenderTableColumn\('category\.name'\)\n {8}->assertCanSeeTableRecords\(\$records\);/);
  // The factory's values for its fields, and type-made ones for the others.
  assert.match(code, /\.\.\.Arr::only\(Article::factory\(\)->make\(\)->getAttributes\(\), \['title', 'slug', 'category_id', 'featured'\]\),\n {8}'contact' => fake\(\)->unique\(\)->safeEmail\(\),\n {8}'price' => fake\(\)->numberBetween\(1, 100\),\n {8}'body' => fake\(\)->paragraph\(\),\n {8}'status' => ArticleStatus::cases\(\)\[0\]->value,\n {8}'kind' => 'news',\n {8}'published_on' => now\(\)->toDateString\(\),\n {4}\];/);
  assert.match(code, /\/\/ Fill cover too: Tusk can't make a value for this field\./);
  for (const f of ["title", "slug", "price", "category_id", "status", "featured", "cover"]) assert.match(code, new RegExp(`it\\('requires the ${f} field'`));
  assert.match(code, /it\('keeps the slug field unique'[\s\S]*->fillForm\(\['slug' => \$record->slug\]\)/);
  // Rich text and dates change as they save, so they aren't compared.
  assert.match(code, /assertDatabaseHas\(Article::class, Arr::only\(\$data, \['title', 'slug', 'contact', 'price', 'category_id', 'status', 'kind', 'featured'\]\)\)/);
  assert.match(code, /EditArticle::class, \['record' => \$record->getRouteKey\(\)\]\)\n {8}->assertSchemaStateSet\(Arr::only\(\$record->attributesToArray\(\), \['title', 'slug', 'category_id', 'featured'\]\)\)/);
  assert.match(code, /assertDatabaseHas\(Article::class, \['id' => \$record->getKey\(\), \.\.\.Arr::only/);
  assert.doesNotMatch(code, /keeps the list from/);
});

test("grants what the policy asks for, and checks that others are refused", () => {
  const code = testFile(
    spec({
      policy: {
        spatie: true,
        rules: {
          viewAny: { kind: "when", join: "any", conds: [{ kind: "permission", name: "view_any_article" }, { kind: "role", name: "admin" }] },
          create: { kind: "when", join: "all", conds: [{ kind: "permission", name: "create_article" }, { kind: "role", name: "editor" }] },
          update: { kind: "when", join: "any", conds: [{ kind: "owner", column: "user_id" }] },
          view: { kind: "custom" },
        },
      },
    }),
  );
  assert.match(code, /\$this->user->givePermissionTo\(Permission::findOrCreate\('view_any_article'\)\);\n {4}\$this->user->givePermissionTo\(Permission::findOrCreate\('create_article'\)\);\n {4}\$this->user->assignRole\(Role::findOrCreate\('editor'\)\);/);
  assert.doesNotMatch(code, /'admin'\)\)/);
  assert.match(code, /\/\/ The policy's view\(\) is code Tusk can't read/);
  assert.match(code, /\$record = Article::factory\(\)->create\(\['user_id' => \$this->user->getKey\(\)\]\);/);
  assert.match(code, /it\('keeps the list from users the policy refuses'[\s\S]*->assertForbidden\(\);/);
  assert.match(code, /it\('keeps editing from users the policy refuses'/);
  assert.match(code, /use Spatie\\Permission\\Models\\Permission;/);
});

test("a rule that refuses everyone skips that page's tests", () => {
  const code = testFile(spec({ policy: { spatie: false, rules: { create: { kind: "nobody" } } } }));
  assert.doesNotMatch(code, /creates an article|requires the/);
  assert.match(code, /keeps creating from users the policy refuses/);
});

test("writes PHPUnit tests, and simple resources' modals", () => {
  const code = testFile(spec({ style: "phpunit", pages: { manage: "App\\Filament\\Resources\\Articles\\Pages\\ManageArticles" }, manageEdit: true }));
  assert.match(code, /^<\?php\n\nnamespace Tests\\Feature\\Filament;\n/);
  assert.match(code, /class ArticleResourceTest extends TestCase\n\{\n {4}use RefreshDatabase;\n\n {4}protected User \$user;\n\n {4}protected function setUp\(\): void\n {4}\{\n {8}parent::setUp\(\);/);
  assert.match(code, /public function test_creates_an_article\(\): void[\s\S]*->callAction\('create', \$data\)\n {12}->assertHasNoActionErrors\(\);/);
  assert.match(code, /->callAction\(TestAction::make\('edit'\)->table\(\$record\), \$data\)/);
  assert.match(code, /->callAction\('create', \['title' => null\]\)\n {12}->assertHasActionErrors\(\['title' => 'required'\]\);/);
  assert.doesNotMatch(code, /\n[ ]+\n/);
});

test("finds the tests a file lacks, and the factories the tests use", () => {
  const s = spec({ fields: spec().fields.filter((f) => f.name !== "price") });
  const before = testFile(s);
  const now = spec();
  assert.deepEqual(missingBlocks(now, before).map((b) => b.key), ["requires the price field"]);
  assert.deepEqual(factoriesNeeded(spec({ factoryKeys: ["title"] })), ["App\\Models\\Article", "App\\Models\\User", "App\\Models\\Category"]);
});

test("writes a factory for an existing model, and names the models it makes records of", () => {
  const post = {
    class: "App\\Models\\Blog\\Post",
    table: "posts",
    keyName: "id",
    keyType: "int",
    timestamps: true,
    softDeletes: false,
    columns: [
      { name: "id", type: "integer", nullable: false, autoIncrement: true },
      { name: "author_id", type: "integer", nullable: false },
      { name: "editor_id", type: "integer", nullable: true },
      { name: "title", type: "varchar", nullable: false },
      { name: "status", type: "varchar", nullable: false },
      { name: "created_at", type: "datetime", nullable: true },
    ],
    indexes: [],
    foreignKeys: [{ columns: ["author_id"], foreignTable: "authors", onDelete: null }, { columns: ["editor_id"], foreignTable: "users", onDelete: null }],
    casts: { status: "App\\Enums\\Status" },
    relations: [{ name: "author", type: "BelongsTo", related: "App\\Models\\Author" }, { name: "editor", type: "BelongsTo", related: "App\\Models\\User" }],
  };
  const code = factoryFor(post, ["App\\Enums\\Status"]);
  assert.equal(factoryClass(post.class), "Database\\Factories\\Blog\\PostFactory");
  assert.match(code, /namespace Database\\Factories\\Blog;/);
  assert.match(code, /'author_id' => Author::factory\(\),\n {12}'title' => fake\(\)->sentence\(\),\n {12}'status' => fake\(\)->randomElement\(Status::cases\(\)\),/);
  assert.doesNotMatch(code, /editor_id|created_at/);
  assert.deepEqual(factoryParents(post), ["App\\Models\\Author"]);
});
