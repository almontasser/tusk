/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { toPrune } from "./retention.ts";

test("prunes old and excess versions", () => {
  const day = 86_400_000;
  const now = 100 * day;
  const names = [now - 1000, now - 2 * day, now - 20 * day].map((t) => `${t}.txt`);
  assert.deepEqual(toPrune(names, now), [`${now - 20 * day}.txt`]);
  assert.deepEqual(toPrune(names, now, 14, 1), [`${now - 2 * day}.txt`, `${now - 20 * day}.txt`]);
});
