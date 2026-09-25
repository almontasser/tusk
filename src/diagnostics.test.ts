/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatType, inlineProblem, matchesFilter, magoConfigText, magoExpect, magoFixes, problemMarkdown, magoIssuesByFile, safeEdits, realProblems, ruleLabel, severityOf, withFolders, type Diagnostic, type Facts } from "./diagnostics.ts";

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

test("shows each parse error once, with the message on its location", () => {
  const text = "<?php\nfunction a( {\n";
  const annotations = [{ message: "Expected one of `Variable`, found `LeftBrace`", kind: "Primary", span: { file_id: { name: "a.php" }, start: { offset: 18 }, end: { offset: 19 } } }];
  const json = JSON.stringify({ issues: [{ level: "Error", code: "parse", message: "Parse error encountered during parsing", annotations }] });
  const list = [...magoIssuesByFile(json, "mago").get("a.php")!(text), ...magoIssuesByFile(json, "mago-lint").get("a.php")!(text)];
  assert.equal(list[0].message, "Expected one of `Variable`, found `LeftBrace`");
  assert.deepEqual(realProblems("/p/a.php", text, "php", list, facts).map((d) => d.source), ["mago-lint"]);
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
  assert.equal(ruleLabel("mago-lint", "no-redundant-use"), "mago-lint(no-redundant-use)");
  assert.equal(ruleLabel("typos", undefined), "typos");
  assert.equal(formatType("array{'a': array<int, string>, 'b': list{int}}"), "array{\n  'a': array<int, string>,\n  'b': list{\n    int\n  }\n}");
});

test("drops Phpactor's missing @return when the docblock has one it can't read", () => {
  const text = `<?php
class A {
    /**
     * @return Generator<int, array{id: string, ...}>
     */
    private function entries(): Generator {}

    private function other(): array {}
}`;
  const list = [
    at(text, "entries", "worse.docblock_missing_return_type", "Method entries is missing docblock return type: Generator<mixed>", "phpactor"),
    at(text, "other", "worse.docblock_missing_return_type", "Method other is missing docblock return type: array", "phpactor"),
  ];
  assert.deepEqual(kept("/p/app/A.php", text, list).length, 1);
});

test("narrows a deprecation to the deprecated name", () => {
  const text = "<?php\n$method->setAccessible(true);\n";
  const d = { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 29 } }, message: "Call to deprecated method: `ReflectionMethod::setAccessible`.", code: "deprecated-method", source: "mago" };
  const [kept] = realProblems("/p/app/A.php", text, "php", [d], { ...facts, phpVersion: "8.5" });
  assert.deepEqual(kept.range, { start: { line: 1, character: 9 }, end: { line: 1, character: 22 } });
});

test("counts an import used with other letter case as used", () => {
  const text = `<?php
use Filament\\Support\\Concerns\\HasIcon;
use Filament\\Support\\Concerns\\HasColor;
class A { use hasIcon; }`;
  const list = [
    at(text, "use Filament\\Support\\Concerns\\HasIcon", "no-redundant-use", "Unused import: `HasIcon`.", "mago-lint"),
    at(text, "use Filament\\Support\\Concerns\\HasColor", "no-redundant-use", "Unused import: `HasColor`.", "mago-lint"),
  ];
  assert.deepEqual(realProblems("/p/app/A.php", text, "php", list, facts).map((d) => d.message), ["Unused import: `HasColor`."]);
});

test("reads Mago's fixes and suppresses its issues", () => {
  const text = "<?php\n// é\n$x = array(1);\n";
  const at = (s: string) => new TextEncoder().encode(text.slice(0, text.indexOf(s))).length;
  const span = (start: number, end: number) => ({ file_id: { name: "a.php" }, start: { offset: start }, end: { offset: end } });
  const edit = (start: number, end: number, newText: string, safety = "safe") => ({ range: { start, end }, new_text: [...new TextEncoder().encode(newText)], safety });
  const issue = (code: string, help: string, edits: object[]) => ({ level: "Note", code, message: "m", help, annotations: [{ kind: "Primary", span: span(at("array"), at(";")) }], edits: [[{}, edits]] });
  const json = JSON.stringify({
    issues: [
      issue("array-style", "Use `[]`.", [edit(at("array"), at("(1") + 1, "["), edit(at(");"), at(";"), "]")]),
      issue("other", "Rewrite it.", [edit(at("array"), at(";"), "[1]")]),
      issue("risky", "Guess.", [edit(0, 0, "x", "potentiallyunsafe")]),
    ],
  });
  const fixes = magoFixes(json, text);
  assert.deepEqual(fixes.map((f) => [f.title, f.safety]), [["Use `[]`", "safe"], ["Rewrite it", "safe"], ["Guess", "potentiallyunsafe"]]);
  assert.deepEqual(fixes[0].edits[0], { range: { start: { line: 2, character: 5 }, end: { line: 2, character: 11 } }, text: "[" });
  // The second fix overlaps the first, and the third isn't safe.
  assert.deepEqual(safeEdits(fixes).map((e) => e.text), ["[", "]"]);

  const lines = ["<?php", "function f() {", "    // @mago-expect lint:a", "    // @mago-expect analysis:b", "    $x = 1;", "}"];
  assert.equal(magoExpect(lines, 4, "lint", "c")?.text, ",c");
  assert.deepEqual(magoExpect(lines, 4, "lint", "c")?.range.start, { line: 2, character: 26 });
  assert.equal(magoExpect(lines, 1, "analysis", "d")?.text, "// @mago-expect analysis:d\n");
  assert.equal(magoExpect(["    $y = 2;"], 0, "lint", "e")?.text, "    // @mago-expect lint:e\n");
  assert.equal(magoExpect(lines, 0, "lint", "strict-types"), undefined);
});

test("withFolders marks each file and the folders above it", () => {
  assert.deepEqual([...withFolders(["/p/a/b.php", "/p/a/c.php", "/p/d.php", "/elsewhere/e.php"], "/p")], ["/p/a/b.php", "/p/a", "/p/a/c.php", "/p/d.php"]);
});

test("the Problems panel's filter matches every word in the message, rule, or path", () => {
  const p = { message: "Undefined variable $user", source: "mago", code: "undefined-variable", path: "app/Http/UserController.php" };
  assert.ok(matchesFilter("", p));
  assert.ok(matchesFilter("USER controller", p));
  assert.ok(matchesFilter("mago(undefined", p));
  assert.ok(!matchesFilter("user missing", p));
});

test("inlineProblem shows the worst problem's first line and counts the others", () => {
  assert.equal(inlineProblem([]), undefined);
  assert.deepEqual(inlineProblem([{ severity: 4, message: "Unused" }, { severity: 8, message: "Undefined method.\nHelp: add it." }]), { text: "Undefined method.  +1", severity: 8 });
  assert.equal(inlineProblem([{ severity: 4, message: "x".repeat(200) }])!.text, `${"x".repeat(119)}…`);
});
