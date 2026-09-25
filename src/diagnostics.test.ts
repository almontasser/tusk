/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatType, magoConfigText, problemMarkdown, magoIssuesByFile, realProblems, severityOf, type Diagnostic, type Facts } from "./diagnostics.ts";

const facts: Facts = {
  isModelProperty: (c, p) => (c === "App\\Models\\License" ? ["expired_at"].includes(p) : undefined),
  isModelMethod: () => undefined,
  isFacade: () => false,
  isView: (name) => name === "widgets.total",
  phpVersion: "8.4",
};

/** A diagnostic at the first `needle` in `text`. */
const at = (text: string, needle: string, code: string, message: string, source = "mago"): Diagnostic => {
  const lines = text.slice(0, text.indexOf(needle)).split("\n");
  const start = { line: lines.length - 1, character: lines.at(-1)!.length };
  return { range: { start, end: start }, message, code, source, severity: 1 };
};
const kept = (path: string, text: string, list: Diagnostic[]) => realProblems(path, text, "php", list, facts).map((d) => d.code);

test("drops false problems and keeps real ones", () => {
  const text = `<?php
namespace App\\Models;
trait Subscribes { function a() { return $this->subscription(); } }
final class License {
    protected string $view = 'widgets.total';
    protected string $other = 'widgets.missing';
    function b() {
        $this->expired_at = null;
        $user = User::factory()->create();
        sendTo($user);
        $mock->moderate();
        ReflectionThing::setAccessible();
        $undefined->call();
        run(...$args);
    }
}`;
  const list = [
    at(text, "$this->subscription", "non-existent-method", "Method `subscription` does not exist on type `App\\Models\\Subscribes`."),
    at(text, "'widgets.total'", "invalid-property-default-value", "Default value for property `License::$view` is not assignable."),
    at(text, "'widgets.missing'", "invalid-property-default-value", "Default value for property `License::$other` is not assignable."),
    at(text, "$this->expired_at", "worse.assignment_to_missing_property", 'Property "expired_at" has not been defined', "phpactor"),
    at(text, "sendTo", "possibly-invalid-argument", "expected `App\\Models\\User`, but possibly received `App\\Models\\User|Illuminate\\Database\\Eloquent\\Collection<int, App\\Models\\User>`."),
    at(text, "$mock", "non-existent-method", "Method `moderate` does not exist on type `Mockery\\MockInterface`."),
    at(text, "ReflectionThing", "deprecated-method", "Call to deprecated method: `ReflectionMethod::setAccessible`."),
    at(text, "$undefined", "non-existent-method", "Method `call` does not exist on type `App\\Models\\Other`."),
    at(text, "run(", "too-few-arguments", "Too few arguments provided for function `run`."),
    at(text, "$undefined", "worse.missing_member", 'Method "call" does not exist on class "App\\Models\\Other"', "phpactor"),
  ];
  assert.deepEqual(kept("/p/app/Models/License.php", text, list), ["invalid-property-default-value", "non-existent-method"]);
});

test("drops Pest's magic and by-reference captures in tests", () => {
  const text = `<?php
it('works', function () {
    $payload = null;
    fake(function () use (&$payload) { $payload = ['id' => 1]; });
    expect($payload['id'])->toBe(1);
    // the chain
    expect($model)
        ->name->toBe('x');
    $other['id'];
});`;
  const list = [
    at(text, "$payload['id']", "null-array-access", "Cannot perform array access on `null`."),
    at(text, "expect($model)", "method-access-on-null", "Attempting to call a method on `null`."),
    at(text, "->name", "non-existent-property", "Property `$name` does not exist on class `Pest\\Mixins\\Expectation`."),
    at(text, "$other", "null-array-access", "Cannot perform array access on `null`."),
  ];
  assert.deepEqual(kept("/p/tests/Unit/ATest.php", text, list), ["null-array-access"]);
});

test("shows unproven types as warnings and mixed values as hints", () => {
  const d = (code: string, message = "") => ({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, message, code, source: "mago", severity: 1 });
  assert.equal(severityOf(d("possibly-null-argument")), 2);
  assert.equal(severityOf(d("less-specific-argument")), 2);
  assert.equal(severityOf(d("invalid-iterator", "It resolved to type `mixed`, which is not iterable.")), 4);
  assert.equal(severityOf(d("invalid-iterator", "It resolved to type `int`, which is not iterable.")), 1);
  assert.equal(severityOf(d("non-existent-class")), 1);
  assert.equal(severityOf(d("invalid-return-tag")), 2);
});

test("reads Mago's report with UTF-8 byte offsets", () => {
  const text = "<?php\n// é\n$x = 1;\n";
  const offset = new TextEncoder().encode(text.slice(0, text.indexOf("$x"))).length;
  const json = JSON.stringify({
    issues: [{ level: "Error", code: "c", message: "m", annotations: [{ kind: "Primary", span: { file_id: { name: "a.php" }, start: { offset }, end: { offset: offset + 2 } } }] }],
  });
  const [d] = magoIssuesByFile(json, "mago").get("a.php")!(text);
  assert.deepEqual(d.range, { start: { line: 2, character: 0 }, end: { line: 2, character: 2 } });
});

test("writes the project's Mago settings", () => {
  const bundled = '[source]\nincludes = ["vendor"]\nexcludes = [".*"]\n';
  const text = magoConfigText(bundled, '{"require": {"php": "^8.2|^8.3"}}', ["/stubs"], ["vendor/a.php"]);
  assert.equal(text, 'php-version = "8.2.0"\n[source]\nincludes = ["vendor", "/stubs"]\nexcludes = [".*", "vendor/a.php"]\n');
});

test("formats messages for hovers and the problem page", () => {
  assert.equal(
    problemMarkdown('Method "App\\Models\\Post::save" is <wrong>.\nUse `array<int>` or *this*.'),
    "**Method `App\\Models\\Post::save` is \\<wrong\\>.**\n\nUse `array<int>` or \\*this\\*.",
  );
  assert.equal(formatType("array{'a': array<int, string>, 'b': list{int}}"), "array{\n  'a': array<int, string>,\n  'b': list{\n    int\n  }\n}");
});
