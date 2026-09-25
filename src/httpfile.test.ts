/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  curlArgs,
  formatRequest,
  fromCurl,
  histogram,
  loadArgs,
  lookupIn,
  multipartParts,
  parseHeaderDump,
  parseHttp,
  parseHttpFile,
  parseSample,
  parseSetCookie,
  prepare,
  requestForRoute,
  resolve,
  shellWords,
  substitute,
  summarize,
  toCurl,
  toLaravel,
  unresolved,
} from "./httpfile.ts";

const file = `@version = v1
@api = {{host}}/api/{{version}}

### List posts
GET {{host}}/api/posts
    ?page=2
    &per_page=10
Accept: application/json
# X-Debug: 1

### Create a post
# A comment
# @name create
# @no-redirect
# @timeout 5
< {%
    request.variables.set("title", "Hello");
%}
POST {{api}}/posts HTTP/1.1
Content-Type: application/json
Authorization: Bearer {{token}}

{
  "title": "{{title}}"
}

> {%
    client.global.set("id", response.body.id);
%}
>>! ./out.json

###
https://example.com/health
`;

test("parses requests, headers, bodies, tags, scripts, and variables", () => {
  const { requests, vars } = parseHttp(file);
  const [list, create, health] = requests;
  assert.deepEqual(vars, { version: "v1", api: "{{host}}/api/{{version}}" });
  assert.deepEqual([list.name, list.line, list.method, list.url, list.start, list.end], ["List posts", 5, "GET", "{{host}}/api/posts?page=2&per_page=10", 4, 10]);
  assert.deepEqual(list.headers, [
    { name: "Accept", value: "application/json", enabled: true },
    { name: "X-Debug", value: "1", enabled: false },
  ]);
  assert.equal(list.body, "");
  assert.deepEqual([create.name, create.title, create.method, create.httpVersion], ["create", "Create a post", "POST", "HTTP/1.1"]);
  assert.deepEqual(create.tags, { name: "create", noRedirect: true, timeout: 5 });
  assert.deepEqual(create.comments, ["# A comment"]);
  assert.equal(create.preScript?.code, 'request.variables.set("title", "Hello");');
  assert.equal(create.handler?.code, 'client.global.set("id", response.body.id);');
  assert.deepEqual(create.output, { path: "./out.json", force: true });
  assert.equal(create.body, '{\n  "title": "{{title}}"\n}');
  assert.deepEqual([health.method, health.url, health.name], ["GET", "https://example.com/health", ""]);
});

test("formats a request back to text that parses the same", () => {
  const [, create] = parseHttpFile(file);
  const again = parseHttpFile(formatRequest(create))[0];
  for (const key of ["name", "title", "method", "url", "headers", "body", "tags", "preScript", "handler", "output", "comments"] as const) assert.deepEqual(again[key], create[key], key);
});

test("resolves variables that name other variables, and dynamic values", () => {
  const { vars } = parseHttp(file);
  const lookup = lookupIn([vars, { host: "http://localhost" }], { APP_URL: "http://app.test" });
  assert.equal(resolve("{{api}}/posts", lookup), "http://localhost/api/v1/posts");
  assert.equal(resolve("{{$dotenv.APP_URL}}", lookup), "http://app.test");
  assert.match(resolve("{{$uuid}}", lookup), /^[0-9a-f-]{36}$/);
  assert.match(resolve("{{$random.integer(5, 6)}}", lookup), /^5$/);
  assert.match(resolve("{{$random.alphabetic(4)}}", lookup), /^[a-zA-Z]{4}$/);
  assert.deepEqual(unresolved("{{api}} {{token}} {{token}}", lookup), ["token"]);
  assert.equal(substitute("{{host}}/a?t={{ token }}&x={{missing}}", { host: "http://localhost", token: "abc" }), "http://localhost/a?t=abc&x={{missing}}");
});

test("prepares a request for curl", async () => {
  const [, create] = parseHttpFile(file);
  const p = await prepare(create, lookupIn([{ api: "http://x/api", token: "t", title: "Hi" }]), "/p", async () => "");
  assert.equal(p.body, '{\n  "title": "Hi"\n}');
  assert.equal(p.followRedirects, false);
  const { args, input } = curlArgs(p, { headers: "/h", body: "/b", cookies: "/c" });
  assert.equal(input, p.body);
  assert.deepEqual(args.slice(0, 4), ["-sS", "--max-time", "5", "-D"]);
  assert.ok(args.includes("-X") && args.includes("POST") && !args.includes("-L"));
  assert.deepEqual(args.slice(-2), ["--", "http://x/api/posts"]);
  assert.ok(args.includes("Authorization: Bearer t"));
  const basic = parseHttpFile("GET /\nAuthorization: Basic {{user}} pass")[0];
  assert.deepEqual((await prepare(basic, lookupIn([{ user: "me" }]), "/", async () => "")).headers, [["Authorization", `Basic ${btoa("me:pass")}`]]);
});

test("sends file bodies and multipart uploads", async () => {
  const text = `POST /upload
Content-Type: multipart/form-data; boundary=B

--B
Content-Disposition: form-data; name="title"

Hello
--B
Content-Disposition: form-data; name="photo"; filename="a.png"
Content-Type: image/png

< ./a.png
--B--

###
POST /raw
Content-Type: application/json

<@ ./body.json
`;
  const [upload, raw] = parseHttpFile(text);
  const p = await prepare(upload, lookupIn([]), "/p", async () => "");
  assert.deepEqual(p.form, [
    { name: "title", value: "Hello" },
    { name: "photo", file: "/p/a.png", filename: "a.png", type: "image/png" },
  ]);
  assert.ok(!p.headers.some(([k]) => k === "Content-Type"));
  const { args, input } = curlArgs(p, { headers: "/h", body: "/b" });
  assert.equal(input, null);
  assert.ok(args.includes('photo=@"/p/a.png";filename="a.png";type=image/png'));
  assert.ok(args.includes("title=Hello"));
  const r = await prepare(raw, lookupIn([{ id: "7" }]), "/p", async (path) => (path === "/p/body.json" ? '{"id": {{id}}}' : ""));
  assert.equal(r.body, '{"id": 7}');
  assert.deepEqual(multipartParts("--X\nContent-Disposition: form-data; name=\"a\"\n\n1\n--X--", "X", "/"), [{ name: "a", value: "1" }]);
});

test("reads curl's header dump, skipping interim responses", () => {
  const dump = "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 302 Found\r\nLocation: /b\r\n\r\nHTTP/2 201 \r\ncontent-type: application/json\r\nset-cookie: sid=abc; Path=/; HttpOnly\r\n\r\n";
  const heads = parseHeaderDump(dump);
  assert.deepEqual(heads.map((h) => [h.status, h.statusText, h.httpVersion]), [[302, "Found", "1.1"], [201, "", "2"]]);
  assert.deepEqual(heads[1].headers[0], ["content-type", "application/json"]);
  assert.deepEqual(parseSetCookie(heads[1].headers[1][1]), { name: "sid", value: "abc", attributes: "Path=/; HttpOnly" });
});

test("imports a browser's Copy as cURL", () => {
  const cmd = `curl 'https://api.test/posts?x=1' \\
  -H 'accept: application/json' \\
  -H $'x-note: it\\'s' \\
  -u me:secret \\
  --data-raw '{"title":"Hi"}' \\
  --compressed`;
  assert.deepEqual(shellWords(`a "b \\"c\\"" 'd e' $'f\\ng'`), ["a", 'b "c"', "d e", "f\ng"]);
  const r = fromCurl(cmd);
  assert.deepEqual([r.method, r.url], ["POST", "https://api.test/posts?x=1"]);
  assert.deepEqual(r.headers.map((h) => [h.name, h.value]), [
    ["accept", "application/json"],
    ["x-note", "it's"],
    ["Authorization", `Basic ${btoa("me:secret")}`],
    ["Content-Type", "application/json"],
  ]);
  assert.equal(r.body, '{\n  "title": "Hi"\n}');
  const f = fromCurl(`curl -F name=Ann -F photo=@/tmp/a.png https://x.test/up`);
  assert.equal(f.method, "POST");
  assert.match(f.body, /name="photo"; filename="a.png"\n\n< \/tmp\/a.png/);
  assert.equal(fromCurl("curl -G -d q=1 https://x.test/s").url, "https://x.test/s?q=1");
});

test("exports curl commands and Laravel HTTP calls", async () => {
  const [, create] = parseHttpFile(file);
  const p = await prepare(create, lookupIn([{ api: "http://x/api", token: "t", title: "Hi" }]), "/p", async () => "");
  const curl = toCurl(p);
  assert.match(curl, /^curl \\\n {2}-X POST \\\n {2}http:\/\/x\/api\/posts/);
  assert.match(curl, /--data-raw '\{\n {2}"title": "Hi"\n\}'/);
  assert.deepEqual(fromCurl(curl).headers.map((h) => h.name), ["Content-Type", "Authorization"]);
  assert.equal(
    toLaravel(p),
    `$response = Http::withToken('t')\n    ->withoutRedirecting()\n    ->timeout(5)\n    ->post('http://x/api/posts', [\n        'title' => 'Hi',\n    ]);`,
  );
});

test("summarizes load test samples", () => {
  const samples = ["200 0.010 0.005 0 10", "200 0.020 0.010 0 10", "500 0.030 0.020 0 5", "000 0.040 0.000 7 0"].map((l) => parseSample(l)!);
  const s = summarize(samples, 2);
  assert.deepEqual([s.count, s.failed, s.rps, s.min, s.max, s.p50, s.p99, s.bytes], [4, 2, 2, 0.01, 0.04, 0.02, 0.04, 25]);
  assert.deepEqual(s.codes, [["200", 2], ["500", 1], ["Error", 1]]);
  assert.deepEqual(histogram([0.1, 0.2, 0.4], 2).map((b) => b.count), [1, 2]);
  assert.equal(parseSample("garbage"), null);
  const args = loadArgs({ method: "GET", url: "http://x/a?f[a]=1#top", headers: [["Accept", "application/json"]], followRedirects: true, timeout: 60, insecure: false }, 50, 5, "/jar");
  assert.equal(args.at(-1), "http://x/a?f\\[a\\]=1#[1-50]");
  assert.deepEqual(args.slice(args.indexOf("--parallel-max"), args.indexOf("--parallel-max") + 2), ["--parallel-max", "5"]);
  assert.ok(args.includes("-L") && args.includes("/jar"));
  assert.equal(args[args.indexOf("-w") + 1], "%{http_code} %{time_total} %{time_starttransfer} %{exitcode} %{size_download}\\n");
});

test("builds requests for Laravel routes", () => {
  const r = requestForRoute({ method: "PUT|PATCH", uri: "api/posts/{post}/{slug?}", name: "posts.update", action: "" });
  assert.deepEqual([r.method, r.url, r.title, r.body], ["PUT", "{{host}}/api/posts/{{post}}/{{slug}}", "posts.update", "{}"]);
});
