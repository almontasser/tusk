/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { candidatePaths, fileLinks, wrappedLine } from "./termlinks.ts";

const paths = (text: string) => fileLinks(text).map((l) => [l.path, l.line, l.column]);

test("fileLinks reads the forms PHP tools print", () => {
  assert.deepEqual(paths("  at app/Models/User.php:42"), [["app/Models/User.php", 42, undefined]]);
  assert.deepEqual(paths(" ┌─ app/Http/Kernel.php:12:5"), [["app/Http/Kernel.php", 12, 5]]);
  assert.deepEqual(paths("#0 /var/www/html/vendor/laravel/framework/src/Foo.php(123): bar()"), [["/var/www/html/vendor/laravel/framework/src/Foo.php", 123, undefined]]);
  assert.deepEqual(paths("PHP Fatal error: oops in /app/index.php on line 7"), [["/app/index.php", 7, undefined]]);
  assert.deepEqual(paths("tests/Feature/ExampleTest.php:17 and ./routes/web.php:3"), [["tests/Feature/ExampleTest.php", 17, undefined], ["./routes/web.php", 3, undefined]]);
});

test("fileLinks reads Windows paths", () => {
  assert.deepEqual(paths("C:\\Users\\me\\app\\tests\\UserTest.php:17"), [["C:\\Users\\me\\app\\tests\\UserTest.php", 17, undefined]]);
  assert.deepEqual(paths("at c:/p/app/User.php(3)"), [["c:/p/app/User.php", 3, undefined]]);
  assert.deepEqual(paths("  at app\\Models\\User.php:42"), [["app\\Models\\User.php", 42, undefined]]);
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
  assert.deepEqual(candidatePaths("C:\\p\\app\\User.php", "c:/p", "c:/p", "/var/www/html"), ["c:/p/app/User.php"]);
  assert.deepEqual(candidatePaths("..\\app\\User.php", "c:/p/tests", "c:/p", "/var/www/html"), ["c:/p/app/User.php", "c:/app/User.php"]);
});

test("wrappedLine joins the rows a line wrapped onto, and maps offsets back to cells", () => {
  const rows: [string, boolean][] = [["$ ls    ", false], ["  at app/Mo", false], ["dels/User.", true], ["php:42    ", true], ["next      ", false]];
  const buffer = { getLine: (i: number) => rows[i] && { isWrapped: rows[i][1], translateToString: (trim?: boolean) => (trim ? rows[i][0].trimEnd() : rows[i][0]) } };
  for (const y of [1, 2, 3]) {
    const { text, cell } = wrappedLine(buffer, y);
    assert.equal(text, "  at app/Models/User.php:42");
    const [link] = fileLinks(text);
    assert.deepEqual([cell(link.start), cell(link.end - 1)], [{ x: 6, y: 2 }, { x: 6, y: 4 }]);
  }
  assert.equal(wrappedLine(buffer, 4).text, "next");
});
