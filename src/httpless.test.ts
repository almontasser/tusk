/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Check, CHECKS_END, CHECKS_START, envFiles, envTable, jsonPathAt, jsonQuery, looksSecret, nameForPath, readChecks, writeChecks } from "./httpfile.ts";

const json = JSON.stringify({ data: [{ id: 7, token: "abc", "odd key": true }], meta: { next: null } }, null, 2);
const at = (text: string) => json.indexOf(text);

test("jsonPathAt finds the value, key, or container under the offset", () => {
  assert.equal(jsonPathAt(json, at('"abc"') + 2), "$.data[0].token");
  assert.equal(jsonPathAt(json, at('"abc"') + 5), "$.data[0].token");
  assert.equal(jsonPathAt(json, at('"token"') + 1), "$.data[0].token");
  assert.equal(jsonPathAt(json, at("7")), "$.data[0].id");
  assert.equal(jsonPathAt(json, at("true") + 2), "$.data[0]['odd key']");
  assert.equal(jsonPathAt(json, at("null") + 4), "$.meta.next");
  assert.equal(jsonPathAt(json, at("[")), "$.data");
  assert.equal(jsonPathAt(json, 0), "$");
  assert.equal(jsonPathAt('[1, [2, 3]]', 8), "$[1][1]");
  assert.equal(jsonPathAt('{"a\\"b": 1}', 9), '$[\'a"b\']');
  assert.equal(jsonPathAt("{oops}", 2), null);
});

test("jsonPathAt paths select the value with jsonQuery", () => {
  const value = JSON.parse(json);
  for (const text of ['"abc"', "7", "true", "null"]) assert.equal(jsonQuery(value, jsonPathAt(json, at(text) + 1)!)[0], JSON.parse(text));
});

test("nameForPath suggests the last key", () => {
  assert.equal(nameForPath("$.data[0].token"), "token");
  assert.equal(nameForPath("$.data[0]"), "data");
  assert.equal(nameForPath("$['odd key']"), "odd_key");
  assert.equal(nameForPath("$[0]"), "value");
});

const checks: Check[] = [
  { kind: "status", target: "", expected: "200" },
  { kind: "exists", target: "$.data['a\\\\b']", expected: "" },
  { kind: "equals", target: "$.data['name']", expected: 'say "hi"' },
  { kind: "header", target: "Content-Type", expected: "json" },
  { kind: "time", target: "", expected: "500" },
  { kind: "body", target: "", expected: "done" },
];

test("writeChecks and readChecks round-trip, keeping the code around the markers", () => {
  const code = 'client.global.set("id", response.body.id);';
  const written = writeChecks(code, checks);
  assert.ok(written.startsWith(`${code}\n${CHECKS_START}\n`));
  assert.ok(written.endsWith(CHECKS_END));
  assert.deepEqual(readChecks(written), { checks, editable: true });
  const around = `${written}\nclient.log("after");`;
  const changed = writeChecks(around, checks.slice(0, 1));
  assert.equal(changed, `${code}\n${CHECKS_START}\nclient.test("Status is 200", () => client.assert(String(response.status) === "200", "Status was " + response.status));\n${CHECKS_END}\nclient.log("after");`);
  assert.equal(writeChecks(changed, []), `${code}\nclient.log("after");`);
  assert.equal(writeChecks("", checks.slice(4, 5)), `${CHECKS_START}\nclient.test("Responds in under 500 ms", () => client.assert(response.time < 500, "Took " + response.time + " ms"));\n${CHECKS_END}`);
});

test("readChecks marks code it didn't write as not editable", () => {
  assert.deepEqual(readChecks("client.log(1);"), { checks: [], editable: true });
  const edited = writeChecks("", checks.slice(0, 1)).replace(CHECKS_END, `client.log(1);\n${CHECKS_END}`);
  assert.deepEqual(readChecks(edited), { checks: checks.slice(0, 1), editable: false });
});

test("the generated checks run as tests", () => {
  const code = writeChecks("", checks);
  const tests: { name: string; passed: boolean }[] = [];
  const client = { test: (name: string, fn: () => void) => { try { fn(); tests.push({ name, passed: true }); } catch { tests.push({ name, passed: false }); } }, assert: (c: unknown, m: string) => { if (!c) throw new Error(m); } };
  const response = { status: 200, time: 120, body: { data: { id: 1, name: 'say "hi"', "a\\\\b": 0 }, note: "done" }, headers: { valueOf: (n: string) => (n === "Content-Type" ? "application/json" : null) } };
  const jsonPath = (v: unknown, p: string) => jsonQuery(v, p)[0];
  new Function("client", "response", "jsonPath", code)(client, response, jsonPath);
  assert.deepEqual(tests.map((t) => t.passed), [true, true, true, true, true, true]);
});

test("envTable merges both files and envFiles splits them back", () => {
  const shared = { $shared: { host: "http://localhost" }, local: { user: "me", port: 8000 }, prod: { host: "https://example.com" } };
  const secret = { local: { token: "t1" }, prod: { token: "t2" } };
  const t = envTable(shared, secret);
  assert.deepEqual(t.envs, ["$shared", "local", "prod"]);
  assert.deepEqual(t.rows.find((r) => r.name === "token"), { name: "token", private: true, values: { local: "t1", prod: "t2" } });
  assert.equal(t.rows.find((r) => r.name === "port")!.values.local, "8000");
  const files = envFiles(t);
  assert.deepEqual(files.secret, secret);
  assert.deepEqual(files.shared, { $shared: { host: "http://localhost" }, local: { user: "me", port: "8000" }, prod: { host: "https://example.com" } });
});

test("envFiles keeps empty environments and variables without values", () => {
  const files = envFiles({ envs: ["$shared", "local", "staging"], rows: [{ name: "apiKey", private: true, values: {} }, { name: "host", private: false, values: { local: "x" } }] });
  assert.deepEqual(files.shared, { local: { host: "x" }, staging: {} });
  assert.deepEqual(files.secret, { local: { apiKey: "" }, staging: { apiKey: "" } });
  assert.ok(looksSecret("apiKey") && looksSecret("PASSWORD") && !looksSecret("host"));
});
