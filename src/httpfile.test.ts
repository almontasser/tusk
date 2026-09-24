/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCurlOutput, parseHttpFile, substitute, TIME_MARKER } from "./httpfile.ts";

const file = `### List posts
GET {{host}}/api/posts
    ?page=2
    &per_page=10
Accept: application/json

### Create a post
# A comment
POST {{host}}/api/posts HTTP/1.1
Content-Type: application/json
Authorization: Bearer {{token}}

{
  "title": "Hello"
}

###
https://example.com/health
`;

test("parses requests, headers, and bodies", () => {
  const [list, create, health] = parseHttpFile(file);
  assert.deepEqual([list.name, list.line, list.method, list.url], ["List posts", 2, "GET", "{{host}}/api/posts?page=2&per_page=10"]);
  assert.deepEqual(list.headers, [["Accept", "application/json"]]);
  assert.equal(list.body, "");
  assert.deepEqual([create.method, create.line], ["POST", 9]);
  assert.deepEqual(create.headers[1], ["Authorization", "Bearer {{token}}"]);
  assert.equal(create.body, '{\n  "title": "Hello"\n}');
  assert.deepEqual([health.method, health.url, health.name], ["GET", "https://example.com/health", ""]);
});

test("substitutes environment variables", () => {
  assert.equal(substitute("{{host}}/a?t={{ token }}&x={{missing}}", { host: "http://localhost", token: "abc" }), "http://localhost/a?t=abc&x={{missing}}");
});

test("parses curl output, skipping interim responses", () => {
  const out = `HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nContent-Type: application/json\r\nX-Id: 7\r\n\r\n{"id":7}${TIME_MARKER}0.042`;
  const r = parseCurlOutput(out);
  assert.deepEqual([r.status, r.statusText, r.body, r.seconds], [201, "Created", '{"id":7}', 0.042]);
  assert.deepEqual(r.headers, [["Content-Type", "application/json"], ["X-Id", "7"]]);
});
