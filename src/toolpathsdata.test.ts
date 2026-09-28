/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInterpreters, versionLine } from "./toolpathsdata.ts";

test("lists each real PHP binary once, in the order found", () => {
  const out = [
    "/opt/homebrew/bin/php\t/opt/homebrew/Cellar/php/8.4.2/bin/php\t8.4.2",
    "/opt/homebrew/opt/php/bin/php\t/opt/homebrew/Cellar/php/8.4.2/bin/php\t8.4.2",
    "/opt/homebrew/opt/php@8.2/bin/php\t/opt/homebrew/Cellar/php@8.2/8.2.27/bin/php\t8.2.27",
    "/usr/bin/php\t/usr/bin/php\tWarning: broken",
    "",
  ].join("\n");
  assert.deepEqual(parseInterpreters(out), [
    { path: "/opt/homebrew/bin/php", version: "8.4.2" },
    { path: "/opt/homebrew/opt/php@8.2/bin/php", version: "8.2.27" },
  ]);
});

test("shortens version output to its first line", () => {
  assert.equal(versionLine("PHP 8.4.2 (cli) (built: Dec 17 2024 15:00:00) (NTS)\nCopyright (c) The PHP Group\n"), "PHP 8.4.2");
  assert.equal(versionLine("git version 2.39.5 (Apple Git-154)\n"), "git version 2.39.5 (Apple Git-154)");
  assert.equal(versionLine(""), "");
});
