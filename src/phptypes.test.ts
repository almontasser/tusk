/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { deletionLines, laravelNames, parseTypeDeclaration } from "./phptypes.ts";

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
