/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { componentClassPath, deletionLines, laravelNames, methodLine, parseTypeDeclaration, parseTypeDeclarations, routeTarget, docblockHasParam, formatHoverMarkdown } from "./phptypes.ts";

test("resolves parents and interfaces through use statements", () => {
  const source = `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Contracts\\Support\\Arrayable as ArrayableContract;

/** A post, which class Foo extends Bar in a comment doesn't confuse. */
#[SomeAttribute]
final class Post extends Model implements ArrayableContract, \\JsonSerializable, Concerns\\HasSlug
{
}
`;
  const t = parseTypeDeclaration(source)!;
  assert.equal(t.fqn, "App\\Models\\Post");
  assert.equal(t.kind, "class");
  assert.deepEqual(t.extends, ["Illuminate\\Database\\Eloquent\\Model"]);
  assert.deepEqual(t.implements, ["Illuminate\\Contracts\\Support\\Arrayable", "JsonSerializable", "App\\Models\\Concerns\\HasSlug"]);
  assert.equal(source.slice(t.offset, t.offset + 4), "Post");
});

test("reads interfaces that extend several interfaces", () => {
  const t = parseTypeDeclaration("<?php\nnamespace A;\ninterface Repo extends \\Countable, Base {}\n")!;
  assert.equal(t.kind, "interface");
  assert.deepEqual(t.extends, ["Countable", "A\\Base"]);
  assert.deepEqual(t.implements, []);
});

test("reads every type in a file, with the traits each uses", () => {
  const source = `<?php
namespace App;

use Illuminate\\Database\\Eloquent\\Factories\\HasFactory;

class Post extends Model
{
    use HasFactory, Concerns\\HasSlug;
    use \\Illuminate\\Notifications\\Notifiable { notify as protected; }

    public function scope() { return function () use ($x) { return new class extends Base {}; }; }
}

trait Publishes {}
`;
  const types = parseTypeDeclarations(source);
  assert.deepEqual(types.map((t) => t.fqn), ["App\\Post", "App\\Publishes"]);
  assert.deepEqual(types[0].uses, ["Illuminate\\Database\\Eloquent\\Factories\\HasFactory", "App\\Concerns\\HasSlug", "Illuminate\\Notifications\\Notifiable"]);
  assert.deepEqual(types[1].uses, []);
  assert.equal(source.slice(types[1].offset, types[1].offset + 9), "Publishes");
});

test("returns null without a type", () => {
  assert.equal(parseTypeDeclaration("<?php\nfunction x() {}\n"), null);
});

test("removes a method with its docblock, attributes, and one blank line", () => {
  const lines = [
    "class A", // 1
    "{", // 2
    "    public function keep() {}", // 3
    "", // 4
    "    /**", // 5
    "     * Old.", // 6
    "     */", // 7
    "    #[Deprecated]", // 8
    "    public function old()", // 9
    "    {", // 10
    "    }", // 11
    "", // 12
    "    public function other() {}", // 13
    "}", // 14
  ];
  assert.deepEqual(deletionLines(lines, 9, 11), [5, 12]);
  // The last member: take the blank line above instead.
  assert.deepEqual(deletionLines(lines, 13, 13), [12, 13]);
  assert.deepEqual(deletionLines(lines, 3, 3), [3, 4]);
});

test("derives the names Laravel calls methods by", () => {
  assert.deepEqual(laravelNames("author"), ["author"]);
  assert.deepEqual(laravelNames("scopePublished"), ["scopePublished", "published"]);
  assert.deepEqual(laravelNames("getFullNameAttribute"), ["getFullNameAttribute", "full_name"]);
  assert.deepEqual(laravelNames("fullName"), ["fullName", "full_name"]);
});

test("maps component tags to their classes", () => {
  assert.equal(componentClassPath("x-alert"), "app/View/Components/Alert.php");
  assert.equal(componentClassPath("x-forms.input-text"), "app/View/Components/Forms/InputText.php");
  assert.equal(componentClassPath("x-filament::button"), null);
});

test("routeTarget reads controller actions from route:list", () => {
  assert.deepEqual(routeTarget("App\\Http\\Controllers\\PostController@index"), { fqn: "App\\Http\\Controllers\\PostController", method: "index" });
  assert.deepEqual(routeTarget("App\\Http\\Controllers\\ShowDashboard"), { fqn: "App\\Http\\Controllers\\ShowDashboard", method: "__invoke" });
  assert.equal(routeTarget("Closure"), null);
  assert.equal(methodLine("<?php\nclass A {\n  public function index(Request $r) {}\n}", "index"), 3);
  assert.equal(methodLine("<?php\nclass A {}", "index"), 0);
});

test("finds a parameter in the docblock before its function, whatever its type", () => {
  const source = "<?php\nclass A {\n    /**\n     * @param array{'message':string, 'code':string} $body\n     */\n    #[Pure]\n    public function send(array $body, array $other) {}\n}\n";
  const at = source.indexOf("$body, ");
  assert.equal(docblockHasParam(source, at, "body"), true);
  assert.equal(docblockHasParam(source, at, "other"), false);
  assert.equal(docblockHasParam("<?php\n/** @param int $x */\n$y = 1;\nfunction f($x) {}", 40, "x"), false);
});

test("lays out long signatures in hovers one parameter per line", () => {
  const md = "### A # b\n\n```php\n<?php // @deprecated Use c instead\n    ⚠ public function b(bool $deadCode, array<string, int> $map = [], ?string $name = null, int ...$rest): self(A)\n```";
  assert.equal(
    formatHoverMarkdown(md),
    "### A # b\n\n**Deprecated**: Use c instead\n\n```php\n<?php\npublic function b(\n    bool $deadCode,\n    array<string, int> $map = [],\n    ?string $name = null,\n    int ...$rest,\n): self(A)\n```",
  );
  assert.equal(formatHoverMarkdown("```php\n<?php function a(int $b): void\n```"), "```php\n<?php\nfunction a(int $b): void\n```");
});
