/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTypeDeclaration } from "./phptypes.ts";

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
