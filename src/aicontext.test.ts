/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContext, chunk, cleanSuggestion, columnType, type Index, infillRequest, modelDoc, outline, pack, referencedClasses, similar, similarCode, words } from "./aicontext.ts";

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

test("removes the code a suggestion repeats from below the cursor", () => {
  const below = ["", "        return $post;", "    }"];
  assert.equal(cleanSuggestion("$post->save();\n\n        return $post;\n    }", "", below), "$post->save();");
  assert.equal(cleanSuggestion("$post->save();\n        $post->refresh();  \n", "", below), "$post->save();\n        $post->refresh();");
  // Nothing new: only whitespace, or only the rest of the line that's already there.
  assert.equal(cleanSuggestion("  \n", "", below), "");
  assert.equal(cleanSuggestion(");", ");", below), "");
  // The first line may equal the next one: completing a line never counts as repeating.
  assert.equal(cleanSuggestion("return $post;", "", below), "return $post;");
});

test("builds the request around the cursor", () => {
  const lines = ["<?php", "", "function a()", "{", "    return 1;", "}"];
  const body = infillRequest(lines, 5, 12, [], 64);
  assert.equal(body.input_prefix, "<?php\n\nfunction a()\n{\n");
  assert.equal(body.prompt, "    return ");
  assert.equal(body.input_suffix, "1;\n}");
  assert.equal(body.n_indent, 4);
  assert.equal(infillRequest(lines, 1, 1, [], 0).input_prefix, "");
});

test("gathers outlines, models, recent code, and similar code, without repeats", () => {
  const post = "<?php\n\nnamespace App\\Models;\n\nclass Post extends Model\n{\n    public function publish(): void\n    {\n        $this->published = true;\n    }\n}\n";
  const helper = "<?php\n\nfunction helper()\n{\n    $post->published = true;\n    $post->save();\n    return $post;\n}\n";
  const files = new Map([
    ["app/Models/Post.php", { text: post, chunks: chunk("app/Models/Post.php", post) }],
    ["app/helpers.php", { text: helper, chunks: chunk("app/helpers.php", helper) }],
  ]);
  const index: Index = {
    psr4: { "App\\": "app/" },
    files,
    models: { "App\\Models\\Post": { class: "App\\Models\\Post", columns: { published: { type: "tinyint", nullable: false } }, casts: {}, relations: [] } },
    outline: (rel) => outline(files.get(rel)!.text),
  };
  const source = "<?php\n\nnamespace App\\Http;\n\nuse App\\Models\\Post;\n\nclass C\n{\n    function f(Post $post)\n    {\n        $post->published = true;\n        $post->\n    }\n}\n";
  const like = similarCode(index, "app/Http/C.php", source, 12);
  assert.deepEqual(like.map((c) => c.path).sort(), ["app/Models/Post.php", "app/helpers.php"]);
  const extra = buildContext(index, "app/Http/C.php", source, source.indexOf("$post->\n"), [{ path: "app/Other.php", start: 0, text: "recent" }], like);
  assert.deepEqual(extra.map((e) => e.filename), ["_ide_helper_models.php", "app/Models/Post.php", "app/Other.php", "app/helpers.php"]);
  assert.match(extra[0].text, /@property bool \$published/);
  assert.match(extra[1].text, /public function publish\(\): void\n {4}\{ … \}/);
});
