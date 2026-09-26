/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { postfixStart, snippetText } from "./postfix.ts";

/** The expression before the last dot in `line`, or null. */
const expr = (line: string) => {
  const dot = line.lastIndexOf(".");
  const start = postfixStart(line, dot);
  return start < 0 ? null : line.slice(start, dot);
};

test("finds the expression before a postfix dot", () => {
  assert.equal(expr("    $user."), "$user");
  assert.equal(expr("echo $this->posts()->first()['id']."), "$this->posts()->first()['id']");
  assert.equal(expr("$a?->b."), "$a?->b");
  assert.equal(expr("return Post::query()->where('a', f($b))."), "Post::query()->where('a', f($b))");
  assert.equal(expr("\\App\\Models\\User::find(1)."), "\\App\\Models\\User::find(1)");
  assert.equal(expr("self::$cache."), "self::$cache");
  assert.equal(expr("foo()."), "foo()");
  assert.equal(expr("if (!$ok."), "$ok");
  assert.equal(expr("(new Foo)."), "(new Foo)");
});

test("no expression before a dot that isn't postfix", () => {
  assert.equal(expr("$a . "), null);
  assert.equal(expr("The end."), null);
  assert.equal(expr("$x = 1."), null);
  assert.equal(expr("$a->."), null);
  assert.equal(expr("foo)."), null);
});

test("escapes snippet syntax", () => {
  assert.equal(snippetText("$a['}\\']"), "\\$a['\\}\\\\']");
});
