import assert from "node:assert/strict";
import { test } from "node:test";
import { covers, DEFAULT_EXCLUDES, magoExcludes } from "./indexexclude.ts";

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
