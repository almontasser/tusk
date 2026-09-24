/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { filterFor, parseClover, parseEvents, parseJUnit, sameTest, uncoveredRanges } from "./junit.ts";

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
