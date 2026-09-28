/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { filterFor, parseClover, parseEvents, parseJUnit, sameTest, uncoveredRanges, coverageIndex, coveringTests, testOf, parseTeamcity, moveMarks, parseFailure, withDetails, testKey, localPath } from "./junit.ts";

const results = parseJUnit(readFileSync(new URL("./junit.fixture.xml", import.meta.url), "utf8"));

test("reads every test case with its status", () => {
  assert.equal(results.length, 8);
  const by = (name: string) => results.find((r) => r.name === name)!;
  assert.equal(by("test_passes").status, "passed");
  assert.equal(by("test_skipped").status, "skipped");
  assert.equal(by("test_errors").status, "failed");
  assert.equal(by('test_data with data set "two"').status, "failed");
  assert.equal(by("test_passes").className, "Tests\\Unit\\ScratchTest");
});

test("points failures at the failing line", () => {
  const fails = results.find((r) => r.name === "test_fails")!;
  assert.equal(fails.line, 17);
  assert.match(fails.message, /^Letters <differ> & "so" on/);
  assert.equal(results.find((r) => r.name === "test_passes")!.line, 10);
});

test("builds a filter for failed tests", () => {
  const failed = results.filter((r) => r.status === "failed");
  assert.equal(filterFor(failed, false), "::(test_fails|test_errors|test_data)( with data set .*)?$");
  assert.equal(filterFor([{ ...failed[0], name: "`g` → it adds (1 + 1)" }], true), "Tests\\\\Unit\\\\ScratchTest::(?:test_?)?(?:`g`[_ ]?→[_ ]?it[_ ]?adds[_ ]?\\(1[_ ]?\\+[_ ]?1\\))( with data set .*)?$");
});

test("reads Pest reports", () => {
  const pest = parseJUnit(readFileSync(new URL("./junit.pest.fixture.xml", import.meta.url), "utf8"));
  assert.deepEqual(
    pest.map((r) => [r.name, r.status, r.file, r.line]),
    [
      ["it adds (1 + 1)", "passed", "tests/MathTest.php", 0],
      ["fails", "failed", "tests/MathTest.php", 8],
      ['it checks numbers with data set "(1)"', "passed", "tests/MathTest.php", 0],
      ['it checks numbers with data set "(2)"', "failed", "tests/MathTest.php", 12],
      ["`group` → it nested fails", "failed", "tests/MathTest.php", 16],
      ["it skips", "skipped", "tests/MathTest.php", 0],
    ],
  );
  assert.equal(pest[1].message, "Failed asserting that two strings are identical.\nat tests/MathTest.php:8");
});

test("reads PHPUnit-style classes run by Pest", () => {
  const mixed = parseJUnit(readFileSync(new URL("./junit.mixed.fixture.xml", import.meta.url), "utf8"));
  const fails = mixed.find((r) => r.name === "Fails")!;
  assert.deepEqual([fails.file, fails.line, fails.status], ["tests/Unit/ScratchTest.php", 17, "failed"]);
  assert.match(fails.message, /^Letters <differ>/);
  assert.equal(mixed.find((r) => r.name === "Passes")!.file, "tests/Unit/ScratchTest.php");
  const failed = mixed.filter((r) => r.status === "failed");
  // Pest matches the filter, case-insensitively, against "Class::method" or "Class::description".
  const filter = new RegExp(filterFor(failed, true), "i");
  assert.ok(filter.test("P\\Tests\\Unit\\ScratchTest::test_fails"));
  assert.ok(filter.test('Tests\\Unit\\ScratchTest::test_data with data set "two"'));
  assert.ok(!filter.test("Tests\\Unit\\ScratchTest::test_fails_twice"));
  assert.ok(!filter.test("Tests\\Unit\\OtherTest::test_fails"));
});

test("matches reported names to declarations", () => {
  assert.ok(sameTest("That true is true", "test_that_true_is_true"));
  assert.ok(sameTest("`home page` → it loads", "it loads"));
  assert.ok(sameTest('it checks numbers with data set "(2)"', "it checks numbers"));
  assert.ok(!sameTest("Passes", "test_fails"));
});

test("reads the live event stream", () => {
  const events = `Test Suite Started (/app/phpunit.xml, 3 tests)
Test Prepared (Tests\\Unit\\ExampleTest::test_one)
Test Passed (Tests\\Unit\\ExampleTest::test_one)
Test Finished (Tests\\Unit\\ExampleTest::test_one)
Test Prepared (P\\Tests\\Feature\\PostTest::__pest_evaluable__home_page__→_it_loads)
Test Failed (P\\Tests\\Feature\\PostTest::__pest_evaluable__home_page__→_it_loads)
Failed asserting that false is true.
Test Prepared (Tests\\Unit\\ExampleTest::test_two)
`;
  const { total, tests } = parseEvents(events);
  assert.equal(total, 3);
  assert.deepEqual(tests.map((t) => [t.className, t.name, t.status]), [
    ["Tests\\Unit\\ExampleTest", "test one", "passed"],
    ["Tests\\Feature\\PostTest", "home page → it loads", "failed"],
    ["Tests\\Unit\\ExampleTest", "test two", "running"],
  ]);
});

test("reads statement coverage from a Clover report", () => {
  const coverage = parseClover(readFileSync(new URL("./clover.fixture.xml", import.meta.url), "utf8"));
  assert.deepEqual([...coverage.keys()], ["/var/www/html/app/Models/Post.php"]);
  assert.deepEqual([...coverage.get("/var/www/html/app/Models/Post.php")!], [[16, 1], [21, 0], [22, 3]]);
});

test("groups uncovered lines into ranges, split by covered ones", () => {
  const lines = new Map([[3, 0], [5, 0], [9, 0], [7, 2], [12, 1], [14, 0]]);
  assert.deepEqual(uncoveredRanges(lines), [[3, 5], [9, 9], [14, 14]]);
  assert.deepEqual(uncoveredRanges(new Map([[1, 1]])), []);
});

test("reads which tests covered each line from PHPUnit's XML coverage", () => {
  const index = `<phpunit><project source="/app/app"><directory name="/"><directory name="Models"><file name="Post.php" href="Models/Post.php.xml"/></directory></directory></project></phpunit>`;
  assert.deepEqual([...coverageIndex(index).files], [["/app/app/Models/Post.php", "Models/Post.php.xml"]]);
  const file = `<coverage><line nr="14"/><line nr="15"><covered by="Tests\\Feature\\ExampleTest::test_home"/><covered by="P\\Tests\\Feature\\PostTest::__pest_evaluable__home_page__&#x2192;_it_loads"/></line><line nr="20"/></coverage><source><line no="15"><token>x</token></line></source>`;
  const lines = coveringTests(file);
  assert.equal(lines.get(15)!.length, 2);
  assert.deepEqual(lines.get(14), []);
  assert.deepEqual(testOf(lines.get(15)![0]), { className: "Tests\\Feature\\ExampleTest", name: "test_home" });
  assert.deepEqual(testOf(lines.get(15)![1]), { className: "Tests\\Feature\\PostTest", name: "home page → it loads" });
  assert.deepEqual(testOf("Tests\\Unit\\MathTest::testAdd#with two"), { className: "Tests\\Unit\\MathTest", name: "testAdd" });
});

test("reads failure messages from PHPUnit's event stream", () => {
  const events = "Test Prepared (Tests\\Unit\\ATest::test_fails)\nTest Failed (Tests\\Unit\\ATest::test_fails)\nnumbers differ\nFailed asserting that 2 is identical to 1.\nTest Finished (Tests\\Unit\\ATest::test_fails)\n";
  const [t] = parseEvents(events).tests;
  assert.equal(t.status, "failed");
  assert.equal(t.message, "numbers differ\nFailed asserting that 2 is identical to 1.");
});

test("reads live results from a TeamCity log", () => {
  const log = [
    "##teamcity[testCount count='2' flowId='1']",
    "##teamcity[testStarted name='test_fails' locationHint='php_qn:///app/tests/Unit/ATest.php::\\Tests\\Unit\\ATest::test_fails' flowId='1']",
    "##teamcity[testFailed name='test_fails' message='it|'s |[bad|]|nFailed' details='/app/tests/Unit/ATest.php:11|n' flowId='1']",
    "##teamcity[testFinished name='test_fails' flowId='1']",
    "##teamcity[testStarted name='test_passes' locationHint='php_qn:///app/tests/Unit/ATest.php::\\Tests\\Unit\\ATest::test_passes' flowId='1']",
  ].join("\n");
  const { total, tests } = parseTeamcity(log);
  assert.equal(total, 2);
  assert.deepEqual(tests[0], { className: "Tests\\Unit\\ATest", name: "test_fails", status: "failed", file: "/app/tests/Unit/ATest.php", message: "it's [bad]\nFailed", line: 11, trace: "/app/tests/Unit/ATest.php:11" });
  assert.equal(tests[1].status, "running");
});

test("moves coverage marks with their lines and marks changed lines stale", () => {
  const text = ["<?php", "$a = 1;", "$b = 2;", "$c = 3;"];
  const marks = moveMarks([[2, { count: 1, at: 2 }], [3, { count: 0, at: 3 }], [4, { count: 1, at: 4 }], [9, { count: 0, at: 9 }]], (l) => text[l - 1]);
  assert.deepEqual([...marks.keys()], [2, 3, 4]);
  // Deleting line 2 puts its mark on the next line, whose own mark wins; line 4's text then changes.
  const edited = ["<?php", "$b = 2;", "$c = 30;"];
  const moved = moveMarks([[2, marks.get(2)!], [2, marks.get(3)!], [3, marks.get(4)!]], (l) => edited[l - 1]);
  assert.deepEqual([...moved].map(([l, m]) => [l, m.at, m.stale]), [[2, 3, false], [3, 4, true]]);
});

const fixture = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

test("reads PHPUnit's expected/actual diff and stack from a failure", () => {
  const [strings, arrays, numbers, error] = parseJUnit(fixture("./junit.phpunit-diff.fixture.xml"));
  assert.deepEqual(parseFailure(strings.message), {
    text: "Failed asserting that two strings are identical.",
    expected: "'hello\nworld'",
    actual: "'hello\nthere'",
    frames: [{ file: "/app/tests/Unit/DiffTest.php", line: 11 }],
  });
  const a = parseFailure(arrays.message);
  assert.equal(a.expected, "Array (\n    'a' => 1\n    'b' => 2\n)");
  assert.equal(a.actual, "Array (\n    'a' => 1\n    'b' => 3\n)");
  assert.deepEqual(parseFailure(numbers.message), { text: "Failed asserting that 2 is identical to 1.", frames: [{ file: "/app/tests/Unit/DiffTest.php", line: 21 }] });
  assert.equal(parseFailure(error.message).text, "RuntimeException: boom");
});

test("takes Pest's expected and actual values from the TeamCity log", () => {
  const live = parseTeamcity(fixture("./teamcity.pest-diff.fixture.txt")).tests;
  const pest = live.find((t) => t.name === "it compares strings")!;
  assert.deepEqual([pest.className, pest.file, pest.line, pest.expected, pest.actual], ["Tests\\Feature\\DiffPestTest", "/app/tests/Feature/DiffPestTest.php", 4, "'hello\nthere'", "'hello\nworld'"]);
  // Pest's JUnit report has no diff; the log fills it in, for Pest tests and for PHPUnit classes that Pest runs.
  const results = withDetails(parseJUnit(fixture("./junit.pest-diff.fixture.xml")), live);
  const by = (name: string) => parseFailure(results.find((r) => r.name === name)!.message, results.find((r) => r.name === name));
  assert.deepEqual(by("it compares with assert"), { text: "Failed asserting that two strings are identical.", expected: "'x'", actual: "'y'", frames: [{ file: "/app/tests/Feature/DiffPestTest.php", line: 12 }] });
  assert.equal(by("Arrays").actual, "Array (\n    'a' => 1\n    'b' => 3\n)");
  assert.deepEqual(by("Numbers").expected, undefined);
  assert.deepEqual(by("Error").frames, [{ file: "/app/tests/Unit/DiffTest.php", line: 26 }]);
});

test("reads every frame of a stack, in Pest's and PHP's formats", () => {
  const message = "BadMethodCallException: Call to undefined method App\\Models\\Post::nope()\nat vendor/laravel/framework/src/Illuminate/Support/Traits/ForwardsCalls.php:67\nat tests/Feature/DeepTest.php:3\n#1 /var/www/html/app/Models/Post.php(12): App\\Models\\Post->x()";
  assert.deepEqual(parseFailure(message), {
    text: "BadMethodCallException: Call to undefined method App\\Models\\Post::nope()",
    frames: [
      { file: "vendor/laravel/framework/src/Illuminate/Support/Traits/ForwardsCalls.php", line: 67 },
      { file: "tests/Feature/DeepTest.php", line: 3 },
      { file: "/var/www/html/app/Models/Post.php", line: 12 },
    ],
  });
});

test("matches a test across report formats", () => {
  assert.equal(testKey("Tests\\Unit\\A", "Strings"), testKey("Tests\\Unit\\A", "test_strings"));
  assert.equal(testKey("Tests\\A", "`home page` → it loads"), testKey("P\\Tests\\A", "__pest_evaluable__home_page__→_it_loads"));
  assert.notEqual(testKey("Tests\\A", 'it adds with data set "(1)"'), testKey("Tests\\A", 'it adds with data set "(2)"'));
});

test("reads a test's printed output", () => {
  const [r] = parseJUnit('<testcase name="t" class="A" file="/a.php" line="3" time="0.1"><system-out>hello &amp; bye\n</system-out></testcase>');
  assert.equal(r.output, "hello & bye\n");
});

test("maps report paths to the project", () => {
  assert.equal(localPath("/var/www/html/tests/A.php", "/p", "/var/www/html"), "/p/tests/A.php");
  assert.equal(localPath("tests/A.php", "/p", "/var/www/html"), "/p/tests/A.php");
  assert.equal(localPath("/p/tests/A.php", "/p", "/var/www/html"), "/p/tests/A.php");
});
