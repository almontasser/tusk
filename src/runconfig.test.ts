/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { addTemporary, clean, commandFor, longRunning, methodFilter, newConfig, readConfigs, shellWords, uniqueName, validate, type RunConfig } from "./runconfig.ts";

const laravel = { artisan: true, pest: true };

test("splits arguments as a shell does", () => {
  assert.deepEqual(shellWords(`--group "slow tests" --name='a b' plain\\ word ""`), ["--group", "slow tests", "--name=a b", "plain word", ""]);
  assert.deepEqual(shellWords("  "), []);
  assert.deepEqual(shellWords(`"say \\"hi\\""`), ['say "hi"']);
});

test("builds test commands for each scope and runner", () => {
  const t = (c: Partial<RunConfig>, project = laravel) => commandFor({ name: "t", type: "test", ...c }, project);
  assert.deepEqual(t({}), ["php", "artisan", "test"]);
  assert.deepEqual(t({}, { artisan: false, pest: true }), ["vendor/bin/pest"]);
  assert.deepEqual(t({}, { artisan: false, pest: false }), ["vendor/bin/phpunit"]);
  assert.deepEqual(t({ runner: "phpunit", scope: "directory", path: "tests/Unit", configFile: "phpunit.ci.xml", args: "--stop-on-failure" }), [
    "vendor/bin/phpunit", "--configuration", "phpunit.ci.xml", "tests/Unit", "--stop-on-failure",
  ]);
  assert.deepEqual(t({ scope: "class", filter: "Tests\\Unit\\ATest" }), ["php", "artisan", "test", "--filter", "Tests\\\\Unit\\\\ATest"]);
  assert.deepEqual(t({ scope: "method", path: "tests/Feature/PostTest.php", filter: "it loads" }), ["php", "artisan", "test", "tests/Feature/PostTest.php", "--filter", methodFilter("it loads")]);
  // The path only counts for the scopes that use it.
  assert.deepEqual(t({ scope: "all", path: "tests/Unit" }), ["php", "artisan", "test"]);
});

test("a method filter matches the test, its data sets, and describe() blocks, not a longer name", () => {
  const filter = new RegExp(methodFilter("test_a"));
  assert.ok(filter.test("Tests\\ATest::test_a"));
  assert.ok(filter.test('Tests\\ATest::test_a with data set "one"'));
  assert.ok(!filter.test("Tests\\ATest::test_a_twice"));
  assert.ok(new RegExp(methodFilter("it loads (fast)")).test("Tests\\ATest::`home` → it loads (fast)"));
});

test("builds commands for the other types", () => {
  const c = (x: Partial<RunConfig> & Pick<RunConfig, "type">) => commandFor({ name: "x", ...x }, laravel);
  assert.deepEqual(c({ type: "artisan", command: "migrate:fresh --seed", args: "--force" }), ["php", "artisan", "migrate:fresh", "--seed", "--force"]);
  assert.deepEqual(c({ type: "php", path: "bin/import.php", args: "a 'b c'" }), ["php", "bin/import.php", "a", "b c"]);
  assert.deepEqual(c({ type: "composer", command: "test" }), ["composer", "run-script", "test"]);
  assert.deepEqual(c({ type: "npm", command: "build", args: "--watch" }), ["npm", "run", "build", "--", "--watch"]);
  assert.deepEqual(c({ type: "shell", command: "echo a | wc -l" }), ["/bin/sh", "-c", "echo a | wc -l"]);
  assert.deepEqual(c({ type: "server", port: 8080 }), ["php", "artisan", "serve", "--host", "127.0.0.1", "--port", "8080"]);
  assert.deepEqual(c({ type: "server", server: "php", host: "0.0.0.0", port: 9000 }), ["php", "-S", "0.0.0.0:9000", "-t", "public"]);
});

test("knows which configurations run until stopped", () => {
  assert.ok(longRunning({ name: "s", type: "server" }));
  assert.ok(longRunning({ name: "q", type: "artisan", command: "queue:work" }));
  assert.ok(longRunning({ name: "d", type: "npm", command: "dev" }));
  assert.ok(!longRunning({ name: "b", type: "npm", command: "build" }));
});

test("validates configurations", () => {
  const a: RunConfig = { name: "A", type: "test", scope: "file" };
  assert.deepEqual(validate(a, [a]), ["Enter the test file."]);
  const dup = { ...a, path: "tests/A.php" };
  assert.match(validate(dup, [dup, { ...dup }])[0], /Names must be unique/);
  assert.deepEqual(validate({ name: "S", type: "server", host: "", port: 70000 }, []), ["Enter a port from 1 to 65535.", "Enter the host."]);
  assert.match(validate({ name: "E", type: "shell", command: "x", env: { "1X": "a" } }, [])[0], /isn't a valid environment variable name/);
  const x: RunConfig = { name: "X", type: "shell", command: "x", before: [{ config: "Y" }] };
  const y: RunConfig = { name: "Y", type: "shell", command: "y", before: [{ config: "X" }] };
  assert.deepEqual(validate(x, [x, y]), ["Before launch runs in a circle: X → Y → X."]);
  assert.deepEqual(validate({ ...x, before: [{ config: "Z" }] }, [x]), ["Before launch runs “Z”, which doesn't exist."]);
});

test("keeps the five newest temporary configurations", () => {
  let list: RunConfig[] = [];
  for (const n of [1, 2, 3, 4, 5, 6]) list = addTemporary(list, { name: `T${n}`, type: "shell", command: "x" });
  assert.deepEqual(list.map((c) => c.name), ["T6", "T5", "T4", "T3", "T2"]);
  list = addTemporary(list, { name: "T3", type: "shell", command: "y" });
  assert.deepEqual(list.map((c) => c.name), ["T3", "T6", "T5", "T4", "T2"]);
});

test("names, cleans, and reads configurations", () => {
  assert.equal(uniqueName("A", ["A", "A (2)"]), "A (3)");
  assert.equal(newConfig("server", []).port, 8000);
  assert.deepEqual(clean({ name: "A", type: "test", args: "", env: {}, before: [], multiple: false, docker: false }), { name: "A", type: "test", docker: false });
  assert.deepEqual(clean({ name: "N", type: "npm", docker: false }), { name: "N", type: "npm" });
  assert.deepEqual(clean({ name: "T", type: "test", docker: true }), { name: "T", type: "test" });
  assert.deepEqual(clean({ name: "S", type: "server", docker: true }), { name: "S", type: "server", docker: true });
  assert.deepEqual(readConfigs([{ name: "A", type: "shell" }, { name: "B", type: "nope" }, null, "x"]), [{ name: "A", type: "shell" }]);
  assert.deepEqual(readConfigs({}), []);
});
