/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Prepared } from "./httpfile.ts";
import { addTest, appAddresses, featureTest, featureTestFile, fileReferences, jsonStructure, parseLaravelLog, phpPorts, requestPath, testFileName } from "./laraveltools.ts";

const request = (fields: Partial<Prepared> = {}): Prepared => ({ method: "GET", url: "http://localhost:8000/api/notes", headers: [], followRedirects: true, timeout: 60, insecure: false, ...fields });

test("builds a Pest test with a JSON body, a token, and the response's shape", () => {
  const code = featureTest({
    request: request({ method: "POST", url: "{{host}}/api/notes?draft=1", headers: [["Accept", "application/json"], ["Content-Type", "application/json"], ["Authorization", "Bearer abc"], ["X-Tenant", "7"]], body: '{"title":"Hi"}' }),
    status: 201,
    contentType: "application/json",
    body: JSON.stringify({ data: { id: 1, tags: [{ name: "a" }] }, meta: null }),
    name: "Create a note",
    pest: true,
  });
  assert.equal(
    code,
    `test('Create a note', function () {
    $this->withToken('abc')
        ->withHeaders([
            'X-Tenant' => '7',
        ])
        ->postJson('/api/notes?draft=1', [
            'title' => 'Hi',
        ])
        ->assertStatus(201)
        ->assertJsonStructure([
            'data' => [
                'id',
                'tags' => [
                    '*' => [
                        'name',
                    ],
                ],
            ],
            'meta',
        ]);
});
`,
  );
});

test("builds a PHPUnit method for a plain request, numbering a name the file already uses", () => {
  const code = featureTest({ request: request({ url: "https://app.test/" }), status: 200, contentType: "text/html", body: "<p>", name: "Home page", pest: false, existing: "function test_home_page(): void" });
  assert.equal(code, `    public function test_home_page_2(): void\n    {\n        $this->get('/')\n            ->assertStatus(200);\n    }\n`);
});

test("numbers a Pest test name the file already uses", () => {
  const code = featureTest({ request: request(), status: 200, contentType: "", body: "", name: "list", pest: true, existing: "test('list', function () {" });
  assert.match(code, /^test\('list \(2\)'/);
});

test("adds a test to a PHPUnit class or a Pest file", () => {
  const cls = featureTestFile("NotesTest", "    public function test_a(): void\n    {\n    }\n", false);
  assert.match(cls, /class NotesTest extends TestCase\n\{\n    public function test_a/);
  const added = addTest(cls, "    public function test_b(): void\n    {\n    }\n", false);
  assert.ok(added.text.endsWith("    }\n\n    public function test_b(): void\n    {\n    }\n}\n"));
  assert.equal(added.text.split("\n")[added.line - 1], "    public function test_b(): void");
  const pest = addTest("<?php\n\ntest('a', fn () => 1);\n", "test('b', function () {\n});\n", true);
  assert.equal(pest.text.split("\n")[pest.line - 1], "test('b', function () {");
});

test("describes a JSON response's shape", () => {
  assert.equal(jsonStructure([{ id: 1 }]), "[\n    '*' => [\n        'id',\n    ],\n]");
  assert.equal(jsonStructure("text"), null);
  assert.equal(jsonStructure([1, 2]), null);
  // Three levels at most.
  assert.equal(jsonStructure({ a: { b: { c: { d: 1 } } } }), "[\n    'a' => [\n        'b' => [\n            'c',\n        ],\n    ],\n]");
});

test("names paths and test files", () => {
  assert.equal(requestPath("{{host}}/api/notes#x"), "/api/notes");
  assert.equal(requestPath("http://localhost:8000"), "/");
  assert.equal(testFileName("/api/v1/user-notes/5"), "UserNotesTest.php");
  assert.equal(testFileName("/"), "HttpTest.php");
});

test("reads Laravel log entries with their stack traces", () => {
  const text = `the end of an earlier entry
[2026-09-26 10:00:00] local.INFO: Sent the invoice [] []
[2026-09-26 10:00:01] local.ERROR: Division by zero {"exception":"[object] (DivisionByZeroError(code: 0): Division by zero at /var/www/html/app/Http/Controllers/NoteController.php:20)
[stacktrace]
#0 /var/www/html/vendor/laravel/framework/src/Illuminate/Routing/Controller.php(54): App\\\\Http\\\\Controllers\\\\NoteController->index()
"}
`;
  const entries = parseLaravelLog(text);
  assert.equal(entries.length, 2);
  assert.deepEqual({ ...entries[0] }, { time: "2026-09-26 10:00:00", env: "local", level: "info", message: "Sent the invoice", detail: "" });
  assert.equal(entries[1].level, "error");
  assert.equal(entries[1].message, "Division by zero");
  assert.match(entries[1].detail, /^\{"exception".*\n\[stacktrace\]\n#0 /);
  const refs = fileReferences(entries[1].detail);
  assert.deepEqual(
    refs.map((r) => [r.file, r.line]),
    [
      ["/var/www/html/app/Http/Controllers/NoteController.php", 20],
      ["/var/www/html/vendor/laravel/framework/src/Illuminate/Routing/Controller.php", 54],
    ],
  );
});

test("ranks the app's possible addresses", () => {
  const facts = { root: "/Users/me/Herd/Blog", env: { APP_URL: "http://blog.test/", APP_PORT: "8080" }, compose: "image: sail-8.3/app", valet: { tld: "test", paths: ["/Users/me/Herd"], links: [["api", "/Users/me/Herd/Blog"]] as [string, string][], secured: ["blog.test"], app: "Herd" }, phpPorts: [8001] };
  assert.deepEqual(
    appAddresses(facts).map((a) => a.url),
    ["http://localhost:8080", "http://api.test", "https://blog.test", "http://127.0.0.1:8001", "http://blog.test", "http://localhost:8000"],
  );
  assert.deepEqual(appAddresses({ root: "/p", env: {}, compose: null, valet: null, phpPorts: [] }), [{ url: "http://localhost:8000", source: "artisan serve's default" }]);
});

test("finds the ports PHP listens on in lsof's output", () => {
  assert.deepEqual(phpPorts("p1\ncphp\nf5\nn127.0.0.1:8000\np2\ncnode\nf3\nn*:5173\np3\ncphp-fpm\nf4\nn127.0.0.1:9000\n"), [8000, 9000]);
});
