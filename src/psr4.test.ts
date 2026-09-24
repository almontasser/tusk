/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { namespaceFor, newFileContent, psr4From } from "./psr4.ts";

const psr4 = psr4From(
  JSON.stringify({
    autoload: { "psr-4": { "App\\": "app/", "Database\\Factories\\": "database/factories/", "Modules\\": ["modules/", "extra/modules/"] } },
    "autoload-dev": { "psr-4": { "Tests\\": "tests/" } },
  }),
);

test("maps folders to namespaces with the longest matching folder", () => {
  assert.equal(namespaceFor("app/Foo.php", psr4), "App");
  assert.equal(namespaceFor("app/Models/Post.php", psr4), "App\\Models");
  assert.equal(namespaceFor("database/factories/PostFactory.php", psr4), "Database\\Factories");
  assert.equal(namespaceFor("tests/Feature/PostTest.php", psr4), "Tests\\Feature");
  assert.equal(namespaceFor("extra/modules/Billing/Invoice.php", psr4), "Modules\\Billing");
  assert.equal(namespaceFor("application/Foo.php", psr4), undefined); // "app" is not a prefix of "application"
  assert.equal(namespaceFor("routes/web.php", psr4), undefined);
});

test("creates class skeletons for PHP files", () => {
  assert.equal(newFileContent("app/Models/Post.php", psr4), "<?php\n\nnamespace App\\Models;\n\nclass Post\n{\n}\n");
  assert.match(newFileContent("app/Contracts/PaymentInterface.php", psr4), /^interface PaymentInterface$/m);
  assert.equal(newFileContent("routes/api.php", psr4), "<?php\n\n");
  assert.equal(newFileContent("resources/views/post.blade.php", psr4), "");
  assert.equal(newFileContent("notes.md", psr4), "");
  assert.deepEqual(psr4From("not json"), {});
});
