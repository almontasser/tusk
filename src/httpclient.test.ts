/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { envDirs, flattenEnv, mergeEnvironments, responseCharset } from "./httpclientdata.ts";

test("flattenEnv gives nested values dotted names", () => {
  assert.deepEqual(flattenEnv({ client: { host: "x", api: { version: 2 } }, port: 8000, on: true, ids: [1, 2], none: null }), {
    "client.host": "x",
    "client.api.version": "2",
    port: "8000",
    on: "true",
    ids: "1,2",
    none: "null",
  });
  assert.deepEqual(flattenEnv("not an object"), {});
  assert.deepEqual(flattenEnv(undefined), {});
});

test("mergeEnvironments lets private values and environments override $shared", () => {
  const shared = { $shared: { client: { host: "shared" }, version: "1" }, dev: { client: { host: "x" } }, prod: {} };
  const secret = { $shared: { token: "s" }, dev: { client: { token: "t" } } };
  assert.deepEqual(mergeEnvironments(shared, secret), {
    dev: { "client.host": "x", version: "1", token: "s", "client.token": "t" },
    prod: { "client.host": "shared", version: "1", token: "s" },
  });
  assert.deepEqual(mergeEnvironments(null, null), {});
});

test("envDirs looks from the file's folder up to the project root", () => {
  assert.deepEqual(envDirs("/p/http/admin", "/p"), ["/p/http/admin", "/p/http", "/p"]);
  assert.deepEqual(envDirs("/p", "/p"), ["/p"]);
  // A folder whose name starts like the root's isn't inside it.
  assert.deepEqual(envDirs("/p2/http", "/p"), ["/p2/http", "/p"]);
});

test("responseCharset reads the Content-Type's charset", () => {
  assert.equal(responseCharset("text/plain; charset=iso-8859-1"), "iso-8859-1");
  assert.equal(responseCharset('text/html;Charset="Shift_JIS"'), "shift_jis");
  assert.equal(responseCharset("application/json; charset=UTF-8; foo=bar"), "utf-8");
  assert.equal(responseCharset("application/json"), undefined);
  assert.equal(responseCharset(""), undefined);
});
