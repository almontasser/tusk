/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchBracket, signatureProblem, signatureText, signatureWarning, splitTopLevel, type Signature } from "./refactorparse.ts";

test("splits arguments at top-level commas", () => {
  assert.deepEqual(splitTopLevel(`$a, foo($b, [1, 2]), 'x, y', "q\\", r"`), ["$a", "foo($b, [1, 2])", "'x, y'", `"q\\", r"`]);
  assert.deepEqual(splitTopLevel(""), []);
  const text = "call(a(b), ')')";
  assert.equal(matchBracket(text, 4), text.length - 1);
});

test("skips comments when matching brackets and splitting", () => {
  const body = "{ // don't\n  $a = f('}', /* ) */ 1); # it's\n}";
  assert.equal(matchBracket(body, 0), body.length - 1);
  assert.deepEqual(splitTopLevel("$a, // b's\n$c"), ["$a", "// b's\n$c"]);
});

test("checks a signature in the dialog", () => {
  const param = (name: string, more: object = {}) => ({ text: "", type: "int", name, byRef: false, variadic: false, from: name, ...more });
  const before: Signature = { modifiers: "public", name: "f", returnType: "", params: [param("a"), param("b")] };
  assert.equal(signatureProblem({ ...before, name: "2f" }, before, "method"), "The name must be a valid PHP name.");
  assert.equal(signatureProblem({ ...before, params: [param("a"), param("a")] }, before, "method"), "Two parameters are named $a.");
  assert.equal(signatureProblem({ ...before, params: [param("a", { from: undefined })] }, before, "method"), "The new parameter $a needs a default value or a value for existing calls.");
  assert.equal(signatureProblem(before, before, "method"), null);
  assert.equal(signatureWarning({ ...before, params: [param("a", { defaultValue: "1" }), param("b")] }), "$a is optional but comes before the required $b, so PHP treats it as required.");
  assert.equal(signatureText({ ...before, params: [param("a", { defaultValue: "1" })] }), "public function f(int $a = 1)");
});
