import assert from "node:assert/strict";
import { test } from "node:test";
import { covers, DEFAULT_EXCLUDES, magoExcludes, sharedList, withSharedList } from "./indexexclude.ts";

test("turns folders into Mago patterns", () => {
  // Mago matches globs against files: a plain folder works as is, a glob needs /**.
  assert.deepEqual(magoExcludes(["vendor/aws/aws-sdk-php/src/data", "vendor/**/resources/lang"]), ["vendor/aws/aws-sdk-php/src/data", "vendor/**/resources/lang/**"]);
});

test("tells which folders the list covers", () => {
  assert.ok(covers(DEFAULT_EXCLUDES, "vendor/aws/aws-sdk-php/src/data"));
  assert.ok(covers(DEFAULT_EXCLUDES, "vendor/aws/aws-sdk-php/src/data/s3"));
  assert.ok(covers(DEFAULT_EXCLUDES, "vendor/filament/filament/resources/lang"));
  assert.ok(covers(DEFAULT_EXCLUDES, "vendor/filament/filament/resources/views/components"));
  assert.ok(!covers(DEFAULT_EXCLUDES, "vendor/aws/aws-sdk-php/src"));
  assert.ok(!covers(DEFAULT_EXCLUDES, "vendor/aws/aws-sdk-php/src/database"));
  assert.ok(!covers(DEFAULT_EXCLUDES, "resources/lang"));
  assert.ok(covers(["vendor/*/data"], "vendor/mpdf/data"));
  assert.ok(!covers(["vendor/*/data"], "vendor/mpdf/mpdf/data"));
  assert.ok(covers(["**/fixtures"], "vendor/a/fixtures"));
});

test("reads and writes the shared list, keeping tusk.json's other keys", () => {
  assert.deepEqual(sharedList('{"indexExclude": ["vendor/a", 3]}'), ["vendor/a"]);
  assert.equal(sharedList('{"other": 1}'), undefined);
  assert.equal(sharedList("not json"), undefined);
  assert.equal(withSharedList("", ["vendor/a"]), '{\n  "indexExclude": [\n    "vendor/a"\n  ]\n}\n');
  assert.equal(withSharedList('{"other": 1, "indexExclude": ["x"]}', undefined), '{\n  "other": 1\n}\n');
  assert.equal(withSharedList('{"indexExclude": ["x"]}', undefined), "");
  assert.throws(() => withSharedList("{ broken", undefined));
  assert.throws(() => withSharedList("[1]", ["vendor/a"]));
});
