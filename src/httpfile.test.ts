/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  curlArgs,
  formatRequest,
  header,
  bodyFromRules,
  fromCurl,
  graphqlParts,
  hasSecrets,
  redact,
  redactHeader,
  jsonQuery,
  laravelException,
  matchRoute,
  websocketMessages,
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
  routeSync,
  syncBody,
  syncEdits,
  applyLineEdits,
  resolve,
  shellWords,
  substitute,
  summarize,
  toCurl,
  toAxios,
  toFetch,
  toGuzzle,
  toLaravel,
  overBudget,
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
  const web = requestForRoute({ method: "POST", uri: "posts", name: null, action: "", middleware: ["web", "auth"] }, { title: "required" });
  assert.deepEqual([web.tags.laravelSession, web.body], [true, '{\n  "title": ""\n}']);
  const api = requestForRoute({ method: "GET|HEAD", uri: "api/me", name: null, action: "", middleware: ["api", "Illuminate\\Auth\\Middleware\\Authenticate:sanctum"] });
  assert.equal(header(api, "authorization"), "Bearer {{token}}");
});

test("formatting keeps comments and a URL written over several lines", () => {
  const text = `### Search
GET {{host}}/api/posts
    ?page=1
    &sort=title
# Filters
Accept: application/json
# the key goes here
X-Key: 1

# Payload
{"a": 1}
# after the body
`;
  const [r] = parseHttpFile(text);
  assert.equal(formatRequest(r), text);
  r.headers.push({ name: "X-New", value: "2", enabled: true });
  r.url = "{{host}}/api/posts?page=2&sort=title";
  const again = formatRequest(r);
  assert.match(again, /GET \{\{host\}\}\/api\/posts\n {4}\?page=2\n {4}&sort=title\n# Filters\nAccept/);
  assert.match(again, /X-Key: 1\nX-New: 2\n\n# Payload\n\{"a": 1\}\n# after the body\n$/);
});

test("reads the laravel-session tag, GraphQL, and WebSocket requests", async () => {
  const [session, gql, ws] = parseHttpFile(`# @laravel-session
POST /login

###
GRAPHQL http://x/graphql

query Posts($n: Int) { posts(first: $n) { id } }

{"n": {{count}}}

###
WEBSOCKET ws://x/app
===
{"event": "subscribe"}
=== wait-for-server
{"event": "next"}
`);
  assert.equal(session.tags.laravelSession, true);
  assert.match(formatRequest(session), /# @laravel-session\nPOST/);
  assert.deepEqual(graphqlParts(gql.body), { query: "query Posts($n: Int) { posts(first: $n) { id } }", variables: '{"n": {{count}}}' });
  const p = await prepare(gql, lookupIn([{ count: "3" }]), "/", async () => "");
  assert.deepEqual([p.method, JSON.parse(p.body!)], ["POST", { query: "query Posts($n: Int) { posts(first: $n) { id } }", variables: { n: 3 } }]);
  assert.deepEqual(websocketMessages(ws.body), [
    { text: '{"event": "subscribe"}', waitForServer: false },
    { text: '{"event": "next"}', waitForServer: true },
  ]);
  assert.equal(graphqlParts("{ posts { id } }").variables, "");
});

test("queries JSON with paths", () => {
  const data = { data: [{ id: 1, tags: ["a"] }, { id: 2, tags: [] }], meta: { total: 2, page: { id: 9 } } };
  assert.deepEqual(jsonQuery(data, "$.data[*].id"), [1, 2]);
  assert.deepEqual(jsonQuery(data, "$.data[-1].id"), [2]);
  assert.deepEqual(jsonQuery(data, "$['meta'].total"), [2]);
  assert.deepEqual(jsonQuery(data, "$..id"), [1, 2, 9]);
  assert.deepEqual(jsonQuery(data, "$.meta.*"), [2, { id: 9 }]);
  assert.deepEqual(jsonQuery(data, "$.missing"), []);
});

test("builds bodies from validation rules and matches routes", () => {
  assert.deepEqual(bodyFromRules({ title: "required|string", count: "integer", "tags": "array", "tags.*": "string", "author.email": "email", "items.*.qty": "numeric", password: "required|confirmed", ok: "boolean" }), {
    title: "",
    count: 0,
    tags: [""],
    author: { email: "{{$random.email}}" },
    items: [{ qty: 0 }],
    password: "password",
    password_confirmation: "password",
    ok: false,
  });
  const routes = [
    { method: "GET|HEAD", uri: "api/posts", name: null, action: "A@index" },
    { method: "PUT|PATCH", uri: "api/posts/{post}", name: null, action: "A@update" },
    { method: "GET|HEAD", uri: "api/users/{user?}", name: null, action: "U@show" },
  ];
  assert.equal(matchRoute("GET", "{{host}}/api/posts?page=2", routes)?.action, "A@index");
  assert.equal(matchRoute("PATCH", "http://app.test/api/posts/{{id}}", routes)?.action, "A@update");
  assert.equal(matchRoute("GET", "/api/users", routes)?.action, "U@show");
  assert.equal(matchRoute("POST", "/api/posts", routes), undefined);
});

test("reads Laravel exceptions from JSON and HTML error pages", () => {
  const json = JSON.stringify({ message: "Boom", exception: "RuntimeException", file: "/app/Http/C.php", line: 12, trace: [{ file: "/vendor/x.php", line: 3 }, { function: "closure" }] });
  assert.deepEqual(laravelException(json, 500), { className: "RuntimeException", message: "Boom", frames: [{ file: "/app/Http/C.php", line: 12 }, { file: "/vendor/x.php", line: 3 }] });
  assert.equal(laravelException(json, 422), null);
  const html = `<html><title>Division by zero</title><script>window.data = {"report":{"exception_class":"DivisionByZeroError","message":"Division by zero","stacktrace":[{"file":"\\/var\\/www\\/html\\/app\\/Math.php","line_number":7}]}}</script>`;
  assert.deepEqual(laravelException(html, 500), { className: "DivisionByZeroError", message: "Division by zero", frames: [{ file: "/var/www/html/app/Math.php", line: 7 }] });
  assert.equal(laravelException("<html>Server Error</html>", 500), null);
});

test("reads, writes, and sends connection settings", async () => {
  const text = `### Secure\n# @proxy http://127.0.0.1:8888\n# @client-cert ./certs/client.pem\n# @client-key /keys/client.key\n# @http2\n# @budget 300\nGET https://x.test/a\n`;
  const [r] = parseHttpFile(text);
  assert.deepEqual(r.tags, { proxy: "http://127.0.0.1:8888", clientCert: "./certs/client.pem", clientKey: "/keys/client.key", http: "2", budget: 300 });
  assert.equal(formatRequest(r), text);
  assert.equal(parseHttpFile("# @http1\nGET /").at(0)!.tags.http, "1.1");
  assert.equal(parseHttpFile("# @budget 0.5s\nGET /").at(0)!.tags.budget, 500);
  const p = await prepare(r, lookupIn([]), "/p", async () => "");
  assert.deepEqual([p.clientCert, p.clientKey, p.budget], ["/p/certs/client.pem", "/keys/client.key", 300]);
  const { args } = curlArgs(p, { headers: "/h", body: "/b" });
  for (const [flag, value] of [["-x", "http://127.0.0.1:8888"], ["--cert", "/p/certs/client.pem"], ["--key", "/keys/client.key"]]) assert.equal(args[args.indexOf(flag) + 1], value);
  assert.ok(args.includes("--http2") && loadArgs(p, 2, 1).includes("--http2"));
  assert.match(toCurl(p), /-x http:\/\/127\.0\.0\.1:8888 \\\n {2}--cert \/p\/certs\/client\.pem \\\n {2}--key \/keys\/client\.key \\\n {2}--http2$/);
  assert.equal(overBudget(p, 0.412), true);
  assert.equal(overBudget(p, 0.2), false);
  // An environment's "$proxy" applies when the request has no @proxy, and HTTP/1.1 on the request line changes nothing.
  const [plain] = parseHttpFile("GET https://x.test/ HTTP/1.1");
  const q = await prepare(plain, lookupIn([{ $proxy: "socks5://localhost:1080" }]), "/p", async () => "");
  assert.deepEqual([q.proxy, q.http], ["socks5://localhost:1080", undefined]);
});

test("exports fetch, axios, and Guzzle code", async () => {
  const [, create] = parseHttpFile(file);
  const p = await prepare(create, lookupIn([{ api: "http://x/api", token: "t", title: "Hi" }]), "/p", async () => "");
  assert.equal(
    toFetch(p),
    `const response = await fetch("http://x/api/posts", {\n  method: "POST",\n  headers: {\n    "Content-Type": "application/json",\n    "Authorization": "Bearer t"\n  },\n  body: JSON.stringify({\n    "title": "Hi"\n  }),\n  redirect: "manual",\n  signal: AbortSignal.timeout(5000),\n});\nconst data = await response.text();`,
  );
  assert.match(toAxios(p), /method: "post",\n {2}url: "http:\/\/x\/api\/posts",[\s\S]*data: \{\n {4}"title": "Hi"\n {2}\},\n {2}maxRedirects: 0,\n {2}timeout: 5000,/);
  assert.equal(
    toGuzzle(p),
    `$client = new \\GuzzleHttp\\Client();\n$response = $client->request('POST', 'http://x/api/posts', [\n    'headers' => [\n        'Authorization' => 'Bearer t',\n    ],\n    'json' => [\n        'title' => 'Hi',\n    ],\n    'allow_redirects' => false,\n    'timeout' => 5,\n]);`,
  );
  const form = { method: "POST", url: "http://x/f", headers: [["Content-Type", "application/x-www-form-urlencoded"]] as [string, string][], body: "a=1&b=two", followRedirects: true, timeout: 60, insecure: false };
  assert.match(toFetch(form), /body: new URLSearchParams\(\{\n {4}"a": "1",\n {4}"b": "two"\n {2}\}\),/);
  assert.match(toGuzzle(form), /'form_params' => \[\n {8}'a' => '1',/);
  const multipart = { ...form, headers: [], body: undefined, form: [{ name: "name", value: "Ann" }, { name: "photo", file: "/tmp/a.png" }] };
  assert.match(toFetch(multipart), /^import \{ openAsBlob \} from "node:fs";\n\nconst form = new FormData\(\);\nform\.append\("name", "Ann"\);\nform\.append\("photo", await openAsBlob\("\/tmp\/a\.png"\), "a\.png"\);/);
  assert.match(toAxios(multipart), /data: form,/);
  assert.match(toGuzzle(multipart), /\['name' => 'photo', 'contents' => fopen\('\/tmp\/a\.png', 'r'\), 'filename' => 'a\.png'\],/);
});

test("hides secrets in headers, the query, and bodies", () => {
  const base = { method: "POST", followRedirects: true, timeout: 60, insecure: false };
  const p = redact({
    ...base,
    url: "https://app.test/api?page=2&api_key=abcdefghijklmnop&author=me#top",
    headers: [["Authorization", "Bearer 1|abcdefghijklmnopWXYZ"], ["Cookie", "laravel_session=abc; XSRF-TOKEN=def"], ["X-XSRF-TOKEN", "short"], ["Accept", "application/json"], ["X-Api-Key", "{{key}}"]],
    body: '{\n  "email": "a@b.c",\n  "password": "hunter22",\n  "card": {"number": 1},\n  "client_secret": {"v": "x"}\n}',
  });
  assert.equal(p.url, "https://app.test/api?page=2&api_key=••••mnop&author=me#top");
  assert.deepEqual(p.headers, [["Authorization", "Bearer ••••WXYZ"], ["Cookie", "laravel_session=••••; XSRF-TOKEN=••••"], ["X-XSRF-TOKEN", "••••"], ["Accept", "application/json"], ["X-Api-Key", "{{key}}"]]);
  assert.deepEqual(JSON.parse(p.body!), { email: "a@b.c", password: "••••", card: { number: 1 }, client_secret: { v: "••••" } });
  // Hiding twice changes nothing more.
  assert.deepEqual(redact(p), p);
  assert.equal(redact({ ...base, url: "/", headers: [["Content-Type", "application/x-www-form-urlencoded"]], body: "user=a&password=b" }).body, "user=a&password=••••");
  assert.equal(redact({ ...base, url: "/", headers: [], form: [{ name: "token", value: "x" }, { name: "file", file: "/a" }] }).form![0].value, "••••");
  assert.equal(redactHeader("Set-Cookie", "laravel_session=abc; path=/; httponly"), "laravel_session=••••; path=/; httponly");
  assert.equal(redactHeader("Authorization", "Basic dXNlcjpwYXNz"), "Basic ••••");
  assert.equal(hasSecrets({ ...base, url: "/posts?page=1", headers: [["Accept", "*/*"]], body: '{"title": "x"}' }), false);
});

test("reads a GRPC request", async () => {
  const [r] = parseHttpFile("### Say\nGRPC {{grpc}}/test.Echo/Say\nx-token: {{token}}\n\n{\"name\": \"{{name}}\"}\n");
  assert.equal(r.method, "GRPC");
  const p = await prepare(r, lookupIn([{ grpc: "localhost:50051", token: "t", name: "Ada" }]), "/p", async () => "");
  assert.deepEqual([p.method, p.url, p.headers, p.body], ["GRPC", "localhost:50051/test.Echo/Say", [["x-token", "t"]], "{\"name\": \"Ada\"}"]);
});

test("syncBody adds and removes fields and keeps your values", () => {
  const body = '{\n    "sender": "Lamah",\n    "phone": "0910000000"\n}';
  const synced = syncBody(body, { sender: "required|string", receiver: "required", length: "integer" });
  assert.deepEqual(synced?.added, ["receiver", "length"]);
  assert.deepEqual(synced?.removed, ["phone"]);
  // The body's own four-space indentation stays.
  assert.equal(synced?.body, '{\n    "sender": "Lamah",\n    "receiver": "",\n    "length": 0\n}');
  assert.equal(syncBody('{"a": 1}', { a: "integer" }), null);
  // Unreadable rules, a body with a bare variable, and a list are left alone.
  assert.equal(syncBody('{"a": 1}', {}), null);
  assert.equal(syncBody('{"a": {{id}}}', { b: "string" }), null);
  assert.equal(syncBody("[1]", { b: "string" }), null);
  assert.equal(syncBody("", { b: "string" })?.body, '{\n  "b": ""\n}');
});

test("routeSync adds routes, updates bodies, and finds requests with no route", () => {
  const text = [
    "### Send OTP",
    "POST {{host}}/api/otp/initiate",
    "Content-Type: application/json",
    "",
    '{"lang": "ar", "old": 1}',
    "",
    "### Gone",
    "GET {{host}}/api/old",
    "",
    "### Elsewhere",
    "GET https://api.github.com/users",
    "",
  ].join("\n");
  const routes = [
    { method: "POST", uri: "api/otp/initiate", name: null, action: "OTP@send" },
    { method: "POST", uri: "api/otp/verify", name: "otp.verify", action: "OTP@verify" },
  ];
  const rules = new Map<string, Record<string, string>>([["OTP@send", { lang: "required", receiver: "required" }], ["OTP@verify", { code: "required" }]]);
  const changes = routeSync(text, routes, rules);
  assert.deepEqual(
    changes.map((c) => [c.kind, c.request.url]),
    [
      ["update", "{{host}}/api/otp/initiate"],
      ["remove", "{{host}}/api/old"],
      ["add", "{{host}}/api/otp/verify"],
    ],
  );
  const after = applyLineEdits(text, syncEdits(text, changes));
  assert.equal(
    after,
    [
      "### Send OTP",
      "POST {{host}}/api/otp/initiate",
      "Content-Type: application/json",
      "",
      "{",
      '  "lang": "ar",',
      '  "receiver": ""',
      "}",
      "",
      "### Elsewhere",
      "GET https://api.github.com/users",
      "",
      "### otp.verify",
      "POST {{host}}/api/otp/verify",
      "Accept: application/json",
      "Content-Type: application/json",
      "",
      "{",
      '  "code": ""',
      "}",
      "",
    ].join("\n"),
  );
  // Nothing to do once in step.
  assert.deepEqual(routeSync(applyLineEdits(text, syncEdits(text, changes.filter((c) => c.kind !== "remove"))), routes, rules).filter((c) => c.kind !== "remove"), []);
  // An empty file gets every route.
  assert.equal(applyLineEdits("", syncEdits("", routeSync("", routes.slice(1), rules))), "### otp.verify\nPOST {{host}}/api/otp/verify\nAccept: application/json\nContent-Type: application/json\n\n{\n  \"code\": \"\"\n}\n");
});
