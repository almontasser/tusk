/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { findTests, testAt } from "./phptests.ts";

const phpunit = `<?php
namespace Tests\\Feature;

final class PostTest extends TestCase
{
    public function test_index_lists_posts(): void {}

    #[Test]
    public function it_hides_drafts(): void {}

    /** @test */
    public function shows_author() {}

    public function helper(): void {}
}
`;

const pest = `<?php
it('creates a post (with title)', function () {});

test("deletes posts", function () {});
`;

test("finds PHPUnit test methods", () => {
  const tests = findTests(phpunit);
  assert.deepEqual(tests.map((t) => [t.line, t.name]), [
    [4, "all tests in file"],
    [6, "test_index_lists_posts"],
    [9, "it_hides_drafts"],
    [12, "shows_author"],
  ]);
  assert.equal(tests[0].filter, undefined);
  assert.ok(new RegExp(tests[1].filter!).test("Tests\\Feature\\PostTest::test_index_lists_posts with data set #0"));
  assert.ok(!new RegExp(tests[1].filter!).test("Tests\\Feature\\PostTest::test_index_lists_posts_twice"));
});

test("finds Pest tests and escapes their names", () => {
  const tests = findTests(pest);
  assert.deepEqual(tests.map((t) => t.name), ["all tests in file", "it creates a post (with title)", "deletes posts"]);
  // Pest matches "Class::description", with describe() blocks in front.
  const filter = new RegExp(tests[1].filter!);
  assert.ok(filter.test("P\\Tests\\PostTest::it creates a post (with title)"));
  assert.ok(filter.test('P\\Tests\\PostTest::`group` → it creates a post (with title) with data set "(1)"'));
  assert.ok(!filter.test("P\\Tests\\PostTest::it creates a post (with title) twice"));
  assert.equal(findTests("<?php\ndescribe('group', function () {\n    it('nests', fn () => 1);\n});")[1]?.name, "it nests");
});

test("finds declarations that span several lines", () => {
  const source = `<?php
class SplitTest extends TestCase
{
    #[Test]
    public
        function hides_drafts(): void {}

    protected function testHelper() {}
}

it(
    'wraps its name',
    function () {},
);
`;
  assert.deepEqual(findTests(source).map((t) => [t.line, t.name]), [
    [2, "all tests in file"],
    [5, "hides_drafts"],
    [11, "it wraps its name"],
  ]);
});

test("picks the test around the cursor", () => {
  const tests = findTests(phpunit);
  assert.equal(testAt(tests, 7)?.name, "test_index_lists_posts");
  assert.equal(testAt(tests, 13)?.name, "shows_author");
  assert.equal(testAt(tests, 2)?.name, "all tests in file");
  assert.deepEqual(findTests("<?php\nclass Foo {}"), []);
});
