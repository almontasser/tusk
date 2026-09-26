/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { outsideStrings, abstractMethods, callSites, componentClassPath, constructorCalls, shortenNames, deletionLines, laravelNames, methodLine, parseTypeDeclaration, parseTypeDeclarations, routeTarget, docblockHasParam, formatHoverMarkdown, formRequestParameter, methodBody, validationRules } from "./phptypes.ts";

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

test("validationRules reads FormRequest rules and validate() calls", () => {
  const request = `<?php
namespace App\\Http\\Requests;
class StorePostRequest extends FormRequest {
    public function rules(): array
    {
        return [
            'title' => 'required|string|max:255', // a comment, with ] and ,
            'published' => ['boolean'],
            'tags.*' => ['string', Rule::in(['a', 'b'])],
            "author.email" => 'required|email',
        ];
    }
}`;
  const rules = validationRules(methodBody(request, "rules"));
  assert.deepEqual(Object.keys(rules), ["title", "published", "tags.*", "author.email"]);
  assert.equal(rules.title, "required|string|max:255");
  assert.equal(rules.published, "boolean");
  assert.match(rules["tags.*"], /^string\|a\|b\|\['string', Rule::in/);
  const controller = `<?php
namespace App\\Http\\Controllers;
use App\\Http\\Requests\\StorePostRequest;
use Illuminate\\Http\\Request;
class PostController {
    public function store(StorePostRequest $request) { return 1; }
    public function update(Request $request, Post $post) {
        $data = $request->validate(['title' => 'required']);
    }
}`;
  assert.equal(formRequestParameter(controller, "store"), "App\\Http\\Requests\\StorePostRequest");
  assert.equal(formRequestParameter(controller, "update"), null);
  assert.deepEqual(validationRules(methodBody(controller, "update")), { title: "required" });
});

test("finds the calls in a function body", () => {
  const body = `{
    // skip(me)
    if ($a && isset($b)) { return new Post(foo($x)); }
    $this->save();
    $f(1);
    Post::query()->where('a', fn ($q) => \\strlen($q));
  }`;
  const names = callSites(body).map((i) => body.slice(i).match(/^\w+/)![0]);
  assert.deepEqual(names, ["foo", "save", "query", "where", "strlen"]);
});

test("finds constructor calls of classes", () => {
  const source = [
    "<?php",
    "namespace App;",
    "use Other\\Money as Cash;",
    "class Price extends Cash {",
    "    public function __construct() { parent::__construct(1); }",
    "    public static function make() { return new static(2); }",
    "}",
    "// new Cash(0);",
    "$a = new Cash(3); $b = new \\Other\\Money(4); $c = new Money(5); $d = new Price(6);",
  ].join("\n");
  const found = (classes: string[]) => constructorCalls(source, new Set(classes)).map(([s, e]) => source.slice(s, e));
  assert.deepEqual(found(["Other\\Money"]), ["__construct", "Cash", "\\Other\\Money"]);
  assert.deepEqual(found(["App\\Price"]), ["static", "Price"]);
});

test("reads abstract methods with full class names, and shortens them for another file", () => {
  const trait = [
    "<?php",
    "namespace App\\Concerns;",
    "use App\\Models\\User;",
    "trait HasOwner {",
    "    // abstract public function old(): void;",
    "    abstract protected function owner(?User $user = null, int|Team ...$teams): static;",
    "    public static abstract function &make(array $a = [], string $s = Foo::BAR): \\Closure;",
    "    public function concrete(): void {}",
    "}",
  ].join("\n");
  const methods = abstractMethods(trait);
  assert.deepEqual(methods, [
    { name: "owner", signature: "protected function owner(?\\App\\Models\\User $user = null, int|\\App\\Concerns\\Team ...$teams): static" },
    { name: "make", signature: "public static function &make(array $a = [], string $s = Foo::BAR): \\Closure" },
  ]);
  const cls = "<?php\nnamespace App\\Concerns;\nuse App\\Models\\User;\nclass Post {}";
  assert.equal(shortenNames(methods[0].signature, cls), "protected function owner(?User $user = null, int|Team ...$teams): static");
  assert.equal(shortenNames("\\Closure", cls), "\\Closure");
  assert.equal(shortenNames("\\Closure", "<?php\nclass A {}"), "Closure");
});

test("reads abstract methods within a range", () => {
  const source = "<?php\nabstract class A { abstract function a(); }\ntrait B { abstract function b(); }";
  assert.deepEqual(abstractMethods(source, source.indexOf("B")).map((m) => m.name), ["b"]);
});

test("leaves strings alone when rewriting names", () => {
  assert.equal(shortenNames('"\\t" . \\Closure::class', "<?php\nclass A {}"), '"\\t" . Closure::class');
  const trait = "<?php\nnamespace App;\ntrait T { abstract function f(string $s = 'a, b'): Foo; }";
  assert.equal(abstractMethods(trait)[0].signature, "function f(string $s = 'a, b'): \\App\\Foo");
  assert.equal(outsideStrings("'x' y", (c) => c.toUpperCase()), "'x' Y");
});

test("leaves heredocs and comments alone when rewriting names", () => {
  assert.equal(outsideStrings("<<<EOT\nit's A\nEOT . A // A's\n", (c) => c.replace(/A/g, "B")), "<<<EOT\nit's A\nEOT . B // A's\n");
});
