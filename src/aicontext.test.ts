/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { importedFiles, outlineScript, resolveImport, leastLikely, replacedAfter, buildContext, chunk, cleanSuggestion, columnType, type Index, infillRequest, modelDoc, outline, pack, referencedClasses, similar, similarCode, typedNames, viewCallers, viewName, words } from "./aicontext.ts";

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
  // Models' columns go only to Blade views (see the next tests).
  assert.deepEqual(extra.map((e) => e.filename), ["app/Models/Post.php", "app/Other.php", "app/helpers.php"]);
  assert.match(extra[0].text, /public function publish\(\): void\n {4}\{ … \}/);
});

const indexOf = (files: Record<string, string>, models: Index["models"] = {}): Index => {
  const map = new Map(Object.entries(files).map(([f, text]) => [f, { text, chunks: chunk(f, text) }]));
  return { psr4: { "App\\": "app/" }, files: map, models, outline: (rel) => outline(map.get(rel)!.text) };
};

test("finds the code that renders a Blade view", () => {
  assert.equal(viewName("resources/views/posts/show.blade.php"), "posts.show");
  assert.equal(viewName("app/Models/Post.php"), null);
  const index = indexOf({
    "app/Http/Controllers/PostController.php": "<?php\n\nnamespace App\\Http\\Controllers;\n\nuse App\\Models\\Post;\n\nclass PostController\n{\n    public function show(Post $post)\n    {\n        return view('posts.show', compact('post'));\n    }\n}\n",
    "resources/views/posts/index.blade.php": "@foreach ($posts as $post)\n    <x-post.card :post=\"$post\" />\n@endforeach\n",
    "routes/web.php": "<?php\n\nRoute::view('/about', 'posts.showcase');\n",
  });
  assert.deepEqual(viewCallers(index, "resources/views/posts/show.blade.php").map((c) => c.path), ["app/Http/Controllers/PostController.php"]);
  assert.match(viewCallers(index, "resources/views/posts/show.blade.php")[0].text, /compact\('post'\)/);
  // A component is found by its tag, not by a longer tag that starts the same.
  assert.deepEqual(viewCallers(index, "resources/views/components/post/card.blade.php").map((c) => c.path), ["resources/views/posts/index.blade.php"]);
  assert.deepEqual(viewCallers(index, "resources/views/components/post.blade.php"), []);
});

test("gives a Blade view the classes used where it's rendered", () => {
  const post = "<?php\n\nnamespace App\\Models;\n\nclass Post extends Model\n{\n}\n";
  const controller = "<?php\n\nnamespace App\\Http\\Controllers;\n\nuse App\\Models\\Post;\n\nclass PostController\n{\n    public function show(Post $post)\n    {\n        return view('posts.show', compact('post'));\n    }\n}\n";
  const index = indexOf(
    { "app/Models/Post.php": post, "app/Http/Controllers/PostController.php": controller },
    { "App\\Models\\Post": { class: "App\\Models\\Post", columns: { title: { type: "varchar", nullable: false } }, casts: {}, relations: [] } },
  );
  const view = "<h1>{{ $post-> }}</h1>\n";
  const extra = buildContext(index, "resources/views/posts/show.blade.php", view, view.indexOf("->") + 2, [], []);
  assert.deepEqual(extra.map((e) => e.filename), ["_ide_helper_models.php", "app/Http/Controllers/PostController.php", "app/Models/Post.php", "app/Http/Controllers/PostController.php"]);
  assert.match(extra[0].text, /@property string \$title/);
  assert.match(extra[3].text, /compact\('post'\)/);
});

test("lists the names before -> near the cursor, nearest first", () => {
  const source = "$user = $repo->find($id);\n$user->profile->update();\n$this->mailer->send($user?->email);\n$user->";
  assert.deepEqual(typedNames(source, source.length).map((n) => n.name), ["$user", "mailer", "profile", "$repo"]);
  assert.equal(source.slice(typedNames(source, source.length)[0].offset, typedNames(source, source.length)[0].offset + 5), "$user");
});

test("adds the classes a language server found to the definitions", () => {
  const index = indexOf({ "app/Services/Mailer.php": "<?php\n\nnamespace App\\Services;\n\nclass Mailer\n{\n    public function send(string $to): void\n    {\n    }\n}\n" });
  const source = "<?php\n\nclass C\n{\n    function f()\n    {\n        $this->mailer->\n    }\n}\n";
  assert.deepEqual(buildContext(index, "app/C.php", source, source.indexOf("->\n") + 2, [], []).map((e) => e.filename), []);
  assert.deepEqual(buildContext(index, "app/C.php", source, source.indexOf("->\n") + 2, [], [], ["App\\Services\\Mailer"]).map((e) => e.filename), ["app/Services/Mailer.php"]);
});

test("replaces the closing text the editor already added when the suggestion has it", () => {
  assert.equal(replacedAfter("$post->author->name }}</p>", " }}"), 3);
  assert.equal(replacedAfter("$post->title);", ");"), 2);
  assert.equal(replacedAfter("$post->title", ");"), 0);
  assert.equal(replacedAfter("$post->save();", ""), 0);
  // The text after the cursor ends up after the suggestion's last line, so that's the line that counts.
  assert.equal(replacedAfter("[\n    'a' => 1,\n]);", ");"), 2);
  assert.equal(replacedAfter("); // done\n$next = 1;", ");"), 0);
});

test("ends a suggestion where the model was unsure", () => {
  const text = "$post->save();\n        return $post;\n        $post->refresh();";
  const least = leastLikely(text, [
    { token: "$post", p: 0.9 },
    { token: "->save();\n", p: 0.8 },
    { token: "        return $post;\n", p: 0.6 },
    { token: "        $post", p: 0.4 },
    { token: "->refresh();", p: 0.9 },
  ]);
  assert.deepEqual(least, [0.8, 0.6, 0.4]);
  assert.equal(cleanSuggestion(text, "", [], least), "$post->save();\n        return $post;");
  // Unsure from the first line: nothing.
  assert.equal(cleanSuggestion(text, "", [], [0.3, 0.9, 0.9]), "");
  // Without probabilities, only repeats are removed.
  assert.equal(cleanSuggestion(text, "", []), text);
});

test("outlines scripts, keeping declarations and dropping function bodies", () => {
  const ts = `import { ref } from 'vue'
import type { Song } from '@/types'

export interface Playable {
  id: string
}

export const playback = {
  volume: 7,
  play (song: Song): Promise<void> {
    if (song) { return start() }
  },
  stop: () => { halt() },
}

export class Queue extends Base {
  songs: Song[] = []

  add (song: Song) {
    this.songs.push(song) // don't { break
  }
}
`;
  assert.equal(
    outlineScript("resources/js/playback.ts", ts),
    `export interface Playable {
  id: string
}

export const playback = {
  volume: 7,
  play (song: Song): Promise<void> { … },
  stop: () => { … },
}

export class Queue extends Base {
  songs: Song[] = []

  add (song: Song) { … }
}`,
  );
  const vue = "<template><div>{{ a }}</div></template>\n<script setup lang=\"ts\">\nconst props = defineProps<{ song: Song }>()\nconst play = () => { start() }\n</script>\n";
  assert.equal(outlineScript("A.vue", vue), "const props = defineProps<{ song: Song }>()\nconst play = () => { … }");
});

test("finds the project files a script imports, nearest use first", () => {
  const files = new Map(["resources/js/stores/queue.ts", "resources/js/utils/format.ts", "resources/js/components/Song.vue", "resources/js/services/index.ts"].map((f) => [f, { text: "", chunks: [] }]));
  const index: Index = { psr4: {}, files, models: {}, outline: () => "" };
  assert.equal(resolveImport(index, "resources/js/components", "../stores/queue"), "resources/js/stores/queue.ts");
  assert.equal(resolveImport(index, "resources/js/components", "@/components/Song.vue"), "resources/js/components/Song.vue");
  assert.equal(resolveImport(index, "resources/js", "@/services"), "resources/js/services/index.ts");
  assert.equal(resolveImport(index, "resources/js", "vue"), undefined);
  const source = "import { format } from '@/utils/format'\nimport { queue } from '../stores/queue'\nimport { ref } from 'vue'\n\nconst a = format(1)\nconst b = queue.add()\n";
  assert.deepEqual(importedFiles(index, "resources/js/components/X.ts", source, source.length), ["resources/js/stores/queue.ts", "resources/js/utils/format.ts"]);
});
