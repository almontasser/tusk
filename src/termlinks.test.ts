/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { candidatePaths, fileLinks } from "./termlinks.ts";

const paths = (text: string) => fileLinks(text).map((l) => [l.path, l.line, l.column]);

test("fileLinks reads the forms PHP tools print", () => {
  assert.deepEqual(paths("  at app/Models/User.php:42"), [["app/Models/User.php", 42, undefined]]);
  assert.deepEqual(paths(" ┌─ app/Http/Kernel.php:12:5"), [["app/Http/Kernel.php", 12, 5]]);
  assert.deepEqual(paths("#0 /var/www/html/vendor/laravel/framework/src/Foo.php(123): bar()"), [["/var/www/html/vendor/laravel/framework/src/Foo.php", 123, undefined]]);
  assert.deepEqual(paths("PHP Fatal error: oops in /app/index.php on line 7"), [["/app/index.php", 7, undefined]]);
  assert.deepEqual(paths("tests/Feature/ExampleTest.php:17 and ./routes/web.php:3"), [["tests/Feature/ExampleTest.php", 17, undefined], ["./routes/web.php", 3, undefined]]);
});

test("fileLinks leaves URLs and host names alone", () => {
  assert.deepEqual(paths("Server running on http://127.0.0.1:8000/index.php:12"), []);
  assert.deepEqual(paths("Connecting to example.com:443"), []);
  assert.deepEqual(paths("version 1.2:3"), []);
});

test("fileLinks reports the columns of the whole reference", () => {
  const [l] = fileLinks("at app/User.php:4");
  assert.deepEqual([l.start, l.end], [3, 17]);
});

test("candidatePaths maps the container root and resolves relative paths", () => {
  assert.deepEqual(candidatePaths("/var/www/html/app/User.php", "/p", "/p", "/var/www/html"), ["/p/app/User.php"]);
  assert.deepEqual(candidatePaths("../app/User.php", "/p/tests", "/p", "/var/www/html"), ["/p/app/User.php", "/app/User.php"]);
  assert.deepEqual(candidatePaths("./app/User.php", "/p", "/p", "/var/www/html"), ["/p/app/User.php"]);
});
