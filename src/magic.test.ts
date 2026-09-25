/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { withoutMagic } from "./magic.ts";

const at = (text: string, needle: string, code: string) => {
  const before = text.slice(0, text.indexOf(needle));
  const lines = before.split("\n");
  return { range: { start: { line: lines.length - 1, character: lines.at(-1)!.length } }, source: "mago", code };
};

test("drops magic members and the mixed-type issues that follow from them", () => {
  const text = `<?php
function a() {
    $message = Message::create([]);
    $message->messages()->create([]);
    $other = $message->id;
    echo $other->name;
    $unrelated->call();
}
function b() {
    $message->save();
}`;
  const list = [
    at(text, "create([]);", "non-documented-method"),
    at(text, "$message = ", "mixed-assignment"),
    at(text, "->messages()", "mixed-method-access"),
    at(text, "$message->id", "mixed-property-access"),
    at(text, "$other->name", "mixed-property-access"),
    at(text, "$unrelated", "mixed-method-access"),
    at(text, "$message->save", "mixed-method-access"),
  ];
  const kept = withoutMagic(text, list, (d) => d.code === "non-documented-method");
  // Only the unrelated call, and the same name in another function, keep their issues.
  assert.deepEqual(kept, [list[5], list[6]]);
});
