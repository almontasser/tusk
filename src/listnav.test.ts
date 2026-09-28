/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { typeAhead } from "./listnav.ts";

test("typeAhead finds the next label with the prefix, wrapping around, ignoring case", () => {
  const labels = ["alpha", "Beta", "bravo", "charlie"];
  assert.equal(typeAhead(labels, "b", 0), 1);
  assert.equal(typeAhead(labels, "b", 2), 2);
  assert.equal(typeAhead(labels, "b", 3), 1);
  assert.equal(typeAhead(labels, "br", 1), 2);
  assert.equal(typeAhead(labels, "z", 0), -1);
});
