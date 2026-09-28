/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { errorText } from "./status.ts";

test("errorText reads Errors, command strings, and objects, on one line without noise", () => {
  assert.equal(errorText(new Error("boom")), "boom");
  assert.equal(errorText("fatal: not a git repository\nhint: run git init\n"), "fatal: not a git repository");
  assert.equal(errorText("Error: gh: command failed"), "gh: command failed");
  assert.equal(errorText({ message: "from an object" }), "from an object");
  assert.equal(errorText(""), "unknown error");
  assert.equal(errorText("x".repeat(500)).length, 401);
});
