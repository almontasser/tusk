/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { localSchemaPath, resolveLink } from "./links.ts";

test("resolveLink resolves relative paths from the file's folder", () => {
  assert.equal(resolveLink("/p/docs", "img/a.png"), "/p/docs/img/a.png");
  assert.equal(resolveLink("/p/docs", "../My%20Shots/a b.png"), "/p/My Shots/a b.png");
  assert.equal(resolveLink("/p/a#b", "c.md#section"), "/p/a#b/c.md");
  assert.equal(resolveLink("/p", "/abs/x.png"), "/abs/x.png");
  assert.equal(resolveLink("/p", "https://example.com/x.png"), null);
  assert.equal(resolveLink("/p", "mailto:a@b.c"), null);
  assert.equal(resolveLink("/p", "#top"), null);
});

test("localSchemaPath finds a local $schema and skips URLs", () => {
  assert.equal(localSchemaPath('{\n  "$schema": "./schemas/app.json",\n  "a": 1\n}', "/p/config"), "/p/config/schemas/app.json");
  assert.equal(localSchemaPath('{ "$schema" : "../s\\u0041.json" }', "/p/config"), "/p/sA.json");
  assert.equal(localSchemaPath('{ "$schema": "https://getcomposer.org/schema.json" }', "/p"), null);
  assert.equal(localSchemaPath('{ "name": "x" }', "/p"), null);
});
