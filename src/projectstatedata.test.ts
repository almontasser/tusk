import assert from "node:assert/strict";
import { test } from "node:test";
import { changedKeys, localFileName, migrate, parseShared, writeShared } from "./projectstatedata.ts";

test("reads tusk.json, and says why it can't", () => {
  assert.deepEqual(parseShared(""), { values: {} });
  assert.deepEqual(parseShared('{"indexExclude": ["vendor/a"]}').values, { indexExclude: ["vendor/a"] });
  assert.match(parseShared("{ broken").error!, /isn't valid JSON/);
  assert.equal(parseShared("[1]").error, "it isn't a JSON object");
  assert.equal(parseShared("null").error, "it isn't a JSON object");
});

test("writes tusk.json, keeping unknown keys, their order, and the formatting", () => {
  const text = '{\n\t"$schema": "x",\n\t"custom": {"a": 1},\n\t"indexExclude": ["x"]\n}';
  // Tabs and no final newline, as the file had.
  assert.equal(writeShared(text, { indexExclude: ["y"], dockerService: "app" }), '{\n\t"$schema": "x",\n\t"custom": {\n\t\t"a": 1\n\t},\n\t"indexExclude": [\n\t\t"y"\n\t],\n\t"dockerService": "app"\n}');
  assert.equal(writeShared('{\n    "a": 1\n}\n', { b: 2 }), '{\n    "a": 1,\n    "b": 2\n}\n');
  assert.equal(writeShared("", { a: 1 }), '{\n  "a": 1\n}\n');
  assert.equal(writeShared('{"other": 1, "indexExclude": ["x"]}', { indexExclude: undefined }), '{\n  "other": 1\n}');
  // Nothing left: the file can go.
  assert.equal(writeShared('{"indexExclude": ["x"]}\n', { indexExclude: undefined }), "");
});

test("refuses to write over an invalid tusk.json", () => {
  assert.throws(() => writeShared("{ broken", { a: 1 }), /Fix it, then try again/);
  assert.throws(() => writeShared("[1]", { a: undefined }));
});

test("tells which values an external edit changed", () => {
  assert.deepEqual(changedKeys({ a: 1, b: [1], c: 3 }, { a: 1, b: [2], d: 4 }), ["b", "c", "d"]);
  assert.deepEqual(changedKeys({ a: { x: 1 } }, { a: { x: 1 } }), []);
});

test("moves older values out of localStorage once, skipping keys that are set", () => {
  const root = "/code/app";
  const storage: Record<string, string> = {
    [`indexExclude:${root}`]: '{"indexExclude":["vendor/a"]}',
    [`breakpoints:${root}`]: JSON.stringify({ [`${root}/app/A.php`]: [3, [5, "$x > 1"], [7, { logMessage: "hi" }]], "/elsewhere/B.php": [[1, ""]] }),
    [`debug:serverRoot:${root}`]: "/var/www/html",
    "debug:exceptions": "1",
    [`debug:exceptionClasses:${root}`]: "App\\E,RuntimeException",
    [`watches:${root}`]: '["$request->all()"]',
    [`docker:service:${root}`]: "",
    [`profilerUrl:${root}`]: "/posts",
    [`db:connections:${root}`]: '[{"name":"prod","url":"mysql://u@h:3306/db"}]',
    [`db:connection:${root}`]: "prod",
    [`db:ssh:${root}`]: "forge@1.2.3.4",
    [`db:ssh:${root}#prod`]: "deploy@host",
    [`db:ssh:${root}#gone`]: "",
    [`db:ssh:/other#prod`]: "not this project",
    httpLoad: '{"mode":"count","count":50,"seconds":10,"concurrency":5}',
  };
  const get = (k: string) => storage[k] ?? null;
  const values = migrate(get, Object.keys(storage), root, (k) => k === "profilerUrl");
  assert.deepEqual(values, {
    indexExclude: ["vendor/a"],
    breakpoints: { "app/A.php": [[3, {}], [5, { condition: "$x > 1" }], [7, { logMessage: "hi" }]], "/elsewhere/B.php": [[1, {}]] },
    debugPathMappings: "/var/www/html",
    debugExceptions: { pause: true, classes: ["App\\E", "RuntimeException"], uncaughtOnly: false, skip: [] },
    debugWatches: ["$request->all()"],
    // "" means this Mac, a choice worth keeping.
    dockerService: "",
    databaseConnections: [{ name: "prod", url: "mysql://u@h:3306/db" }],
    databaseConnection: "prod",
    databaseSsh: { "": "forge@1.2.3.4", prod: "deploy@host" },
    httpLoadTest: { mode: "count", count: 50, seconds: 10, concurrency: 5 },
  });
  // Nothing stored: nothing moves, and an unreadable entry doesn't stop the others.
  assert.deepEqual(migrate(() => null, [], root, () => false), {});
  assert.deepEqual(migrate((k) => (k === `breakpoints:${root}` ? "{ broken" : get(k)), Object.keys(storage), root, () => false).breakpoints, undefined);
  assert.ok("indexExclude" in migrate((k) => (k === `breakpoints:${root}` ? "{ broken" : get(k)), Object.keys(storage), root, () => false));
});

test("names the local file after the folder and a hash of its path", () => {
  assert.match(localFileName("/code/my app"), /^my_app-[0-9a-f]{8}\.json$/);
  assert.notEqual(localFileName("/a/app"), localFileName("/b/app"));
});
