/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { chunk, columnType, modelDoc, outline, pack, referencedClasses, similar, words } from "./aicontext.ts";

const post = `<?php

namespace App\\Models;

use App\\Enums\\Status;
use Illuminate\\Database\\Eloquent\\Model;

/** A blog post. */
class Post extends Model
{
    use HasFactory;

    protected $fillable = ['title', 'body'];

    public function author(): BelongsTo
    {
        // Don't load it { twice.
        return $this->belongsTo(User::class, fn () => '}');
    }

    abstract protected function slug(): string;

    public static function published(): Builder
    {
        return static::where('status', Status::Published);
    }
}
`;

test("outlines a class without its method bodies or imports", () => {
  assert.equal(
    outline(post),
    `namespace App\\Models;

/** A blog post. */
class Post extends Model
{
    use HasFactory;

    protected $fillable = ['title', 'body'];

    public function author(): BelongsTo
    { … }

    abstract protected function slug(): string;

    public static function published(): Builder
    { … }
}`,
  );
  assert.match(outline(post, 60), /\n {4}\/\/ …$/);
  assert.ok(outline(post, 60).length <= 60 + 10);
});

test("lists referenced classes nearest to the cursor first", () => {
  const offset = post.indexOf("Status::Published");
  assert.deepEqual(referencedClasses(post, offset).slice(0, 5), [
    "App\\Enums\\Status",
    "App\\Models\\Builder",
    "App\\Models\\User",
    "App\\Models\\BelongsTo",
    "App\\Models\\HasFactory",
  ]);
  // Strings, comments, and the namespace and use lines don't count.
  assert.ok(!referencedClasses(post, 0).some((c) => /Don|App\\Models\\(App|Illuminate)/.test(c)));
});

test("finds similar chunks without overlaps", () => {
  const a = chunk("a.php", Array.from({ length: 60 }, (_, i) => `$post->title = $request->title; // ${i}`).join("\n"));
  const b = chunk("b.php", "function render()\n{\n    return view('home');\n}\n");
  assert.equal(a.length, 3);
  assert.deepEqual([a[0].start, a[1].start, a[2].start], [0, 15, 30]);
  const found = similar([...a, ...b], words("$post->title = $request->input('title');"), 5);
  assert.deepEqual(found.map((c) => [c.path, c.start]), [["a.php", 0], ["a.php", 30]]);
  assert.deepEqual(similar(b, words("return view('home');"), 1).map((c) => c.path), ["b.php"]);
  assert.deepEqual(similar(b, words("return view('home');"), 1, (c) => c.path === "b.php"), []);
});

test("describes a model as an ide-helper docblock", () => {
  assert.equal(columnType("boolean", "integer"), "bool");
  assert.equal(columnType("App\\Enums\\Status", "varchar"), "\\App\\Enums\\Status");
  assert.equal(columnType("decimal:2", "numeric"), "string");
  assert.equal(columnType(undefined, "datetime"), "\\Illuminate\\Support\\Carbon");
  assert.equal(columnType(undefined, "bigint"), "int");
  assert.equal(columnType(undefined, "tinyint"), "bool");
  assert.equal(
    modelDoc({
      class: "App\\Models\\Post",
      table: "posts",
      columns: { id: { type: "integer", nullable: false }, body: { type: "text", nullable: true }, published: { type: "tinyint", nullable: false } },
      casts: { published: "boolean" },
      relations: [
        { name: "author", type: "BelongsTo", related: "App\\Models\\User" },
        { name: "comments", type: "HasMany", related: "App\\Models\\Comment" },
      ],
    }),
    `/**
 * Post, table posts
 *
 * @property int $id
 * @property string|null $body
 * @property bool $published
 * @property-read \\App\\Models\\User|null $author (BelongsTo)
 * @property-read \\Illuminate\\Database\\Eloquent\\Collection<int, \\App\\Models\\Comment> $comments (HasMany)
 */
class Post`,
  );
});

test("packs parts into a budget, skipping ones that don't fit", () => {
  assert.deepEqual(pack([{ text: "aaaa" }, { text: "bbbbbbb" }, { text: "cc" }], 7).map((p) => p.text), ["aaaa", "cc"]);
});
