import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// A handler property that returns `false` cancels the event, so `input.onkeydown = (e) => e.key === "Enter" && go()`
// swallows every other key and the input can't be typed in. Such handlers need a block body or `void (…)`.
test("no key handler property can return false", () => {
  const dir = new URL(".", import.meta.url);
  const bad = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .flatMap((f) =>
      readFileSync(new URL(f, dir), "utf8")
        .split("\n")
        .map((line, i) => [f, i + 1, line] as const)
        .filter(([, , line]) => /\.on(keydown|keypress|keyup)\s*=\s*(\w+|\([^)]*\))\s*=>\s*(?=\S)(?!void\b|\{)[^;]*(&&|\|\||\?)/.test(line))
        .map(([f, n]) => `${f}:${n}`),
    );
  assert.deepEqual(bad, []);
});
