/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHttp } from "./httpfile.ts";
import { importCollection, junitReport, toOpenApi } from "./httpimport.ts";

test("imports a Postman collection", () => {
  const collection = {
    info: { name: "Blog", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    variable: [{ key: "baseUrl", value: "http://localhost:8000" }],
    auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}", type: "string" }] },
    item: [
      {
        name: "Posts",
        item: [
          { name: "Show", request: { method: "GET", url: { raw: "{{baseUrl}}/posts/:id?x={{$guid}}", variable: [{ key: "id", value: "1" }] }, header: [{ key: "Accept", value: "application/json" }, { key: "X-Old", value: "1", disabled: true }] }, event: [{ listen: "test", script: { exec: ["pm.test('ok', () => {});"] } }] },
          { name: "Create", request: { method: "POST", url: "{{baseUrl}}/posts", body: { mode: "raw", raw: '{"title": "Hi"}', options: { raw: { language: "json" } } } } },
          { name: "Log in", request: { method: "POST", url: "{{baseUrl}}/login", auth: { type: "basic", basic: [{ key: "username", value: "a" }, { key: "password", value: "b" }] }, body: { mode: "urlencoded", urlencoded: [{ key: "remember", value: "1" }] } } },
          { name: "Upload", request: { method: "POST", url: "{{baseUrl}}/files", auth: { type: "noauth" }, body: { mode: "formdata", formdata: [{ key: "name", value: "x", type: "text" }, { key: "file", src: "/tmp/a.png", type: "file" }] } } },
        ],
      },
    ],
  };
  const result = importCollection(JSON.stringify(collection));
  assert.equal(result.name, "Blog");
  assert.equal(result.count, 4);
  const { requests, vars } = parseHttp(result.text);
  assert.deepEqual(vars, { baseUrl: "http://localhost:8000", id: "1" });
  const [show, create, login, upload] = requests;
  assert.equal(show.title, "Posts / Show");
  assert.equal(show.url, "{{baseUrl}}/posts/{{id}}?x={{$uuid}}");
  assert.deepEqual(show.headers.map((h) => [h.name, h.value, h.enabled]), [["Accept", "application/json", true], ["X-Old", "1", false], ["Authorization", "Bearer {{token}}", true]]);
  assert.ok(show.comments.some((c) => c.includes("Postman test script")) && show.comments.some((c) => c.includes("pm.test")));
  assert.equal(create.body, '{"title": "Hi"}');
  assert.ok(create.headers.some((h) => h.name === "Content-Type" && h.value === "application/json"));
  assert.ok(login.headers.some((h) => h.value === "Basic a b"));
  assert.equal(login.body, "remember=1");
  assert.ok(!upload.headers.some((h) => h.name === "Authorization"));
  assert.match(upload.body, /name="file"; filename="a.png"\n\n< \/tmp\/a.png/);
});

test("imports an Insomnia export with its environments", () => {
  const doc = {
    _type: "export",
    __export_format: 4,
    resources: [
      { _id: "wrk", _type: "workspace", name: "Shop" },
      { _id: "env", _type: "environment", parentId: "wrk", name: "Base Environment", data: { base: "http://localhost", api: { version: "v1" } } },
      { _id: "env2", _type: "environment", parentId: "env", name: "staging", data: { base: "https://staging.test" } },
      { _id: "fld", _type: "request_group", parentId: "wrk", name: "Orders" },
      { _id: "req", _type: "request", parentId: "fld", name: "Create", method: "POST", url: "{{ _.base }}/{{ _.api.version }}/orders", headers: [{ name: "Content-Type", value: "application/json" }], body: { mimeType: "application/json", text: '{"sku": 1}' }, authentication: { type: "bearer", token: "{{ _.token }}" } },
      { _id: "gql", _type: "request", parentId: "wrk", name: "Query", method: "POST", url: "{{ _.base }}/graphql", body: { mimeType: "application/graphql", text: '{"query":"{ me { id } }","variables":{}}' } },
    ],
  };
  const result = importCollection(JSON.stringify(doc));
  assert.equal(result.name, "Shop");
  assert.deepEqual(result.env, { $shared: { base: "http://localhost", "api.version": "v1" }, staging: { base: "https://staging.test" } });
  const [create, query] = parseHttp(result.text).requests;
  assert.equal(create.title, "Orders / Create");
  assert.equal(create.url, "{{base}}/{{api.version}}/orders");
  assert.equal(create.body, '{"sku": 1}');
  assert.ok(create.headers.some((h) => h.value === "Bearer {{token}}"));
  assert.equal(query.method, "GRAPHQL");
  assert.equal(query.body, "{ me { id } }");
});

test("imports OpenAPI 3 and Swagger 2 documents", () => {
  const openapi = {
    openapi: "3.0.0",
    info: { title: "Pets", version: "2" },
    servers: [{ url: "https://{env}.pets.test/v1", variables: { env: { default: "api" } } }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      schemas: {
        Pet: { type: "object", properties: { id: { type: "integer", readOnly: true }, name: { type: "string", example: "Rex" }, tags: { type: "array", items: { type: "string" } }, parent: { $ref: "#/components/schemas/Pet" } } },
      },
      parameters: { Limit: { name: "limit", in: "query", schema: { type: "integer", default: 20 } } },
    },
    paths: {
      "/pets/{petId}": {
        parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
        get: { tags: ["pets"], summary: "Show a pet", operationId: "showPet", parameters: [{ $ref: "#/components/parameters/Limit" }] },
        put: { summary: "Update", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } } },
      },
    },
  };
  const result = importCollection(JSON.stringify(openapi));
  assert.deepEqual(result.env, { local: { host: "https://api.pets.test/v1" } });
  const [show, update] = parseHttp(result.text).requests;
  assert.equal(show.title, "[pets] Show a pet");
  assert.equal(show.tags.name, "showPet");
  assert.equal(show.url, "{{host}}/pets/{{petId}}?limit=20");
  assert.ok(show.headers.some((h) => h.value === "Bearer {{token}}"));
  // The cycle through parent stops, and readOnly id is left out.
  assert.deepEqual(JSON.parse(update.body), { name: "Rex", tags: [""], parent: null });

  const swagger = {
    swagger: "2.0",
    info: { title: "Old" },
    basePath: "/api",
    definitions: { User: { type: "object", properties: { email: { type: "string", format: "email" } } } },
    paths: {
      "/users": { post: { parameters: [{ in: "body", name: "body", schema: { $ref: "#/definitions/User" } }] } },
      "/login": { post: { consumes: ["application/x-www-form-urlencoded"], parameters: [{ in: "formData", name: "email", type: "string" }] } },
    },
  };
  const old = importCollection(JSON.stringify(swagger));
  assert.deepEqual(old.env, {});
  const [users, login] = parseHttp(old.text).requests;
  assert.equal(users.url, "{{host}}/api/users");
  assert.deepEqual(JSON.parse(users.body), { email: "{{$random.email}}" });
  assert.equal(login.body, "email=");
  assert.throws(() => importCollection("openapi: 3.0.0"), /isn't JSON/);
  assert.throws(() => importCollection("{}"), /isn't a Postman/);
});

test("exports requests to OpenAPI", () => {
  const { requests } = parseHttp(`### [posts] Show a post
# @name showPost
GET {{host}}/api/posts/{{id}}?include=author&page={{page}}
Authorization: Bearer {{token}}

### Create
POST {{host}}/api/posts
Content-Type: application/json

{"title": "Hi", "user_id": {{userId}}}

### Again
GET {{host}}/api/posts/{{id}}
`);
  const doc = toOpenApi(requests, "Blog", "http://localhost") as any;
  assert.deepEqual(doc.servers, [{ url: "http://localhost" }]);
  const show = doc.paths["/api/posts/{id}"].get;
  assert.equal(show.summary, "Show a post");
  assert.deepEqual(show.tags, ["posts"]);
  assert.equal(show.operationId, "showPost");
  assert.deepEqual(show.parameters, [
    { name: "id", in: "path", required: true, schema: { type: "string" } },
    { name: "include", in: "query", schema: { type: "string" }, example: "author" },
    { name: "page", in: "query", schema: { type: "string" } },
  ]);
  assert.deepEqual(show.security, [{ bearerAuth: [] }]);
  assert.deepEqual(doc.paths["/api/posts"].post.requestBody.content["application/json"].example, { title: "Hi", user_id: "{{userId}}" });
  assert.equal(doc.components.securitySchemes.bearerAuth.scheme, "bearer");
});

test("writes a JUnit report", () => {
  const report = junitReport([
    {
      name: "http/posts.http",
      cases: [
        { name: "GET List <posts>", seconds: 0.1, status: 200, tests: [{ name: "ok", passed: true }] },
        { name: "POST Create", seconds: 0.2, status: 201, tests: [{ name: "has id", passed: false, message: "no id" }] },
        { name: "GET Missing", seconds: 0, status: 0, error: "Could not resolve host", tests: [] },
      ],
    },
  ]);
  assert.match(report, /<testsuites name="HTTP requests" tests="3" failures="2" time="0.300">/);
  assert.match(report, /<testcase classname="http\/posts.http" name="GET List &lt;posts&gt;" time="0.100"\/>/);
  assert.match(report, /<failure message="Test failed: has id: no id">Test failed: has id: no id\nFailed: has id \(no id\)<\/failure>/);
  assert.match(report, /<failure message="Could not resolve host">/);
});
