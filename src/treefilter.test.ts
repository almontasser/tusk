/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { listed, parseList } from "./treefilter.ts";

test("matches names at any depth and paths from the project's folder", () => {
  const list = ["node_modules", "*.log", "public/build", "storage/**/cache"];
  assert.equal(listed(list, "node_modules"), true);
  assert.equal(listed(list, "packages/ui/node_modules/react/index.js"), true);
  assert.equal(listed(list, "storage/logs/laravel.log"), true);
  assert.equal(listed(list, "public/build"), true);
  assert.equal(listed(list, "public/build/app.js"), true);
  assert.equal(listed(list, "resources/public/build"), false);
  assert.equal(listed(list, "storage/framework/cache"), true);
  assert.equal(listed(list, "app/Models/User.php"), false);
  assert.equal(listed(["vendor"], "vendors"), false);
  assert.equal(listed([""], "app"), false);
});

test("reads one pattern per line", () => {
  assert.deepEqual(parseList(" vendor\n\n/public/build/\nvendor\n"), ["vendor", "public/build"]);
});
