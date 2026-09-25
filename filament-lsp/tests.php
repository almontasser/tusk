<?php

/*
 * Tests for the Filament language server against the test app.
 *
 *   ./scripts/make-fixture.sh
 *   php -d zend.assertions=1 filament-lsp/tests.php fixtures/demo
 */

declare(strict_types=1);

ini_set('assert.exception', '1');
require __DIR__ . '/server.php';

$root = realpath($argv[1] ?? '') ?: exit("Usage: php filament-lsp/tests.php <path to fixtures/demo>\n");
$resources = "$root/app/Filament/Resources";
$read = fn(string $file) => file_get_contents($file);

/** The LSP position just after the first occurrence of `$needle`. */
function after(string $source, string $needle): array
{
    $offset = strpos($source, $needle);
    assert($offset !== false, "missing $needle");
    $before = substr($source, 0, $offset + strlen($needle));
    $line = substr_count($before, "\n");
    return ['line' => $line, 'character' => utf16Length(substr($before, (int) strrpos("\n" . $before, "\n")))];
}

$labels = fn(array $items) => array_column($items, 'label');
$test = function (string $name, callable $check) {
    $check();
    echo "✓ $name\n";
};

$form = "$resources/Posts/Schemas/PostForm.php";
$table = "$resources/Posts/Tables/PostsTable.php";

$test('completes relationship names', function () use ($form, $read, $labels) {
    $source = str_replace("->relationship('author', 'name')", "->relationship('", $read($form));
    assert($labels(completion($form, $source, after($source, "->relationship('"))) === ['author']);
});

$test('completes columns of the related model', function () use ($form, $read, $labels) {
    $source = str_replace("->relationship('author', 'name')", "->relationship('author', 'na", $read($form));
    $items = completion($form, $source, after($source, "'author', 'na"));
    assert(in_array('name', $labels($items), true));
    // The edit replaces the typed "na".
    $edit = $items[0]['textEdit']['range'];
    assert($edit['end']['character'] - $edit['start']['character'] === 2);
});

$test('completes field names from columns and relationships', function () use ($form, $read, $labels) {
    $source = str_replace("TextInput::make('title')", "TextInput::make('", $read($form));
    $labels = $labels(completion($form, $source, after($source, "TextInput::make('")));
    assert(in_array('title', $labels, true) && in_array('author_id', $labels, true) && in_array('author', $labels, true));
});

$test('completes columns after a relationship and a dot', function () use ($table, $read, $labels) {
    $source = str_replace("TextColumn::make('author.name')", "TextColumn::make('author.", $read($table));
    $labels = $labels(completion($table, $source, after($source, "make('author.")));
    assert(in_array('name', $labels, true) && in_array('posts', $labels, true) && !in_array('title', $labels, true));
});

$test('uses the related model in relation managers', function () use ($resources, $read, $labels) {
    $file = "$resources/Authors/RelationManagers/PostsRelationManager.php";
    $source = preg_replace("/TextInput::make\\('title'\\)/", "TextInput::make('", $read($file), 1);
    assert(in_array('published', $labels(completion($file, $source, after($source, "TextInput::make('"))), true));
});

// A status field added after the title, with its chain ending where the cursor is.
$withStatus = fn(string $chain) => str_replace("TextInput::make('title')", "Select::make('status')$chain,\n                TextInput::make('title')", $read($form));

$test('suggests the enum the model casts a field to', function () use ($form, $withStatus, $labels) {
    $source = $withStatus('->options(');
    assert($labels(completion($form, $source, after($source, '->options('))) === ['\\App\\Enums\\PostStatus::class']);
});

$test("completes a field's default from its enum", function () use ($form, $withStatus, $labels) {
    $source = $withStatus("->default('");
    assert($labels(completion($form, $source, after($source, "->default('"))) === ['draft', 'published', 'archived']);
    $source = str_replace("use Filament\\Schemas\\Schema;", "use Filament\\Schemas\\Schema;\nuse App\\Enums\\PostStatus;", $withStatus('->options(PostStatus::class)->default(Pub'));
    $items = completion($form, $source, after($source, '->default(Pub'));
    assert($labels($items)[1] === 'PostStatus::Published');
    $edit = $items[0]['textEdit']['range'];
    assert($edit['end']['character'] - $edit['start']['character'] === 3);
});

$test('offers nothing for an enum it can\'t load', function () use ($form, $withStatus) {
    $source = $withStatus("->options(Missing::class)->default('");
    assert(completion($form, $source, after($source, "->default('")) === []);
});

$test("completes a field's default from a literal options array", function () use ($form, $read, $labels) {
    $source = str_replace("TextInput::make('title')", "TextInput::make('title')->options(['short' => 'Short', 'long' => 'Long'])->default('", $read($form));
    assert($labels(completion($form, $source, after($source, "->default('"))) === ['short', 'long']);
});

$test('completes state paths in $get and $set', function () use ($form, $read, $labels) {
    $source = str_replace("->required(),\n                TextInput", "->visible(fn (\$get) => \$get('),\n                TextInput", $read($form));
    $found = $labels(completion($form, $source, after($source, "\$get('")));
    assert(in_array('author_id', $found, true) && in_array('published', $found, true));
});

$test('goes to the relationship method', function () use ($table, $read, $root) {
    $source = $read($table);
    $location = definition($table, $source, after($source, "make('aut"));
    assert($location['uri'] === pathToUri("$root/app/Models/Post.php"));
    assert(str_contains(explode("\n", $read("$root/app/Models/Post.php"))[$location['range']['start']['line']], 'function author'));
});

$test('reports unknown relationships only', function () use ($form, $table, $read) {
    assert(diagnostics($form, $read($form)) === []);
    assert(diagnostics($table, $read($table)) === []);
    $source = str_replace("TextColumn::make('author.name')", "TextColumn::make('writer.name')", $read($table));
    $found = diagnostics($table, $source);
    assert(count($found) === 1 && str_contains($found[0]['message'], 'writer()'));
});

$test('links resources, pages, and models with code lenses', function () use ($resources, $form, $read, $root) {
    $titles = fn(string $file) => array_map(fn($l) => $l['command']['title'], codeLenses($file, $read($file)));
    assert($titles("$resources/Posts/PostResource.php") === ['Model: Post', 'ListPosts', 'CreatePost', 'EditPost']);
    assert(in_array('PostsRelationManager', $titles("$resources/Authors/AuthorResource.php"), true));
    assert($titles($form) === ['Resource: PostResource']);
    assert($titles("$root/app/Models/Post.php") === ['Filament: PostResource']);
    assert($titles("$root/app/Models/User.php") === []);
});

$test('counts positions in UTF-16 code units', function () {
    assert(utf16Length('aé😀') === 4);
    assert(byteOffset('é😀x', 3) === 6);
});
