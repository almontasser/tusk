/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { dependents, packages } from "./composerdata.ts";

test("merges installed, outdated, and dev packages", () => {
  const show = JSON.stringify({ installed: [{ name: "phpunit/phpunit", version: "11.5.0" }, { name: "laravel/framework", version: "v12.1.0", description: "The framework" }, { name: "old/pkg", version: "1.0", abandoned: "new/pkg" }] });
  const outdated = JSON.stringify({ installed: [{ name: "laravel/framework", version: "v12.1.0", latest: "v12.9.0", "latest-status": "semver-safe-update" }] });
  const json = JSON.stringify({ require: { "laravel/framework": "^12.0", "old/pkg": "^1.0" }, "require-dev": { "phpunit/phpunit": "^11" } });
  const list = packages(show, outdated, json);
  assert.deepEqual(list.map((p) => [p.name, p.dev]), [["laravel/framework", false], ["old/pkg", false], ["phpunit/phpunit", true]]);
  assert.deepEqual([list[0].latest, list[0].status], ["v12.9.0", "semver-safe-update"]);
  assert.equal(list[1].abandoned, true);
  assert.equal(packages(show, null, json)[0].latest, undefined);
});

test("marks packages composer.json doesn't require as indirect, after the direct ones", () => {
  const show = JSON.stringify({ installed: [{ name: "symfony/console", version: "v7.1.0" }, { name: "laravel/framework", version: "v12.1.0" }] });
  const list = packages(show, null, JSON.stringify({ require: { "laravel/framework": "^12.0" } }));
  assert.deepEqual(list.map((p) => [p.name, p.direct]), [["laravel/framework", true], ["symfony/console", false]]);
});

test("reads composer why", () => {
  const out = "laravel/framework v12.1.0 requires  symfony/console (^7.2.0)   \nlaravel/laravel   -       requires (for development) symfony/console (^7.0)\n";
  assert.deepEqual(dependents(out), [
    { name: "laravel/framework", version: "v12.1.0", relation: "requires", constraint: "^7.2.0" },
    { name: "laravel/laravel", version: "-", relation: "requires (for development)", constraint: "^7.0" },
  ]);
});
