/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionFromEnv, deleteStatement, insertStatement, literal, parseEnv, quoteIdentifier, statementAt, updateStatement } from "./dbconfig.ts";

test("parses .env values", () => {
  const env = parseEnv(`# comment\nDB_CONNECTION=mysql\nDB_PASSWORD="se#cret"\nDB_HOST=db # the host\n# DB_PORT=1\nexport DB_USERNAME='sail'\n`);
  assert.deepEqual(env, { DB_CONNECTION: "mysql", DB_PASSWORD: "se#cret", DB_HOST: "db", DB_USERNAME: "sail" });
});

test("fills in Laravel's defaults", () => {
  assert.equal(connectionFromEnv({}, "/app").database, "/app/database/database.sqlite");
  assert.equal(connectionFromEnv({ DB_DATABASE: "/tmp/x.sqlite" }, "/app").database, "/tmp/x.sqlite");
  assert.deepEqual(connectionFromEnv({ DB_CONNECTION: "pgsql" }, "/app"), {
    driver: "pgsql", host: "127.0.0.1", port: 5432, database: "laravel", username: "root", password: "",
  });
});

test("connects to Sail's forwarded port", () => {
  const env = { DB_CONNECTION: "mysql", DB_HOST: "mysql", DB_PORT: "3306", FORWARD_DB_PORT: "3307", DB_USERNAME: "sail" };
  assert.deepEqual([connectionFromEnv(env, "/app", true).host, connectionFromEnv(env, "/app", true).port], ["127.0.0.1", 3307]);
  assert.equal(connectionFromEnv(env, "/app").host, "mysql");
});

test("finds the statement under the caret", () => {
  const sql = "select 1;\n\nselect 2;\nselect 3";
  assert.equal(statementAt(sql, 3), "select 1");
  assert.equal(statementAt(sql, 9), "select 1");
  assert.equal(statementAt(sql, 14), "select 2");
  assert.equal(statementAt(sql, sql.length), "select 3");
  assert.equal(statementAt("select 1;\n-- note\n", 18), "select 1");
});

test("quotes identifiers per driver", () => {
  assert.equal(quoteIdentifier("mysql", "a`b"), "`a``b`");
  assert.equal(quoteIdentifier("sqlite", 'a"b'), '"a""b"');
});

test("builds cell updates", () => {
  assert.equal(literal("mysql", "a\\b'c"), "'a\\\\b''c'");
  assert.equal(literal("pgsql", "a\\b"), "'a\\b'");
  assert.equal(updateStatement("sqlite", "posts", "title", null, { id: "7" }), `UPDATE "posts" SET "title" = NULL WHERE "id" = '7'`);
  assert.equal(updateStatement("mysql", "t", "v", "x", { a: "1", b: null }), "UPDATE `t` SET `v` = 'x' WHERE `a` = '1' AND `b` IS NULL");
});

test("builds row inserts and deletes", () => {
  assert.equal(deleteStatement("pgsql", "posts", { id: "7" }), `DELETE FROM "posts" WHERE "id" = '7'`);
  assert.equal(insertStatement("sqlite", "posts", { title: "Hi", body: null }), `INSERT INTO "posts" ("title", "body") VALUES ('Hi', NULL)`);
  assert.equal(insertStatement("mysql", "t", {}), "INSERT INTO `t` () VALUES ()");
  assert.equal(insertStatement("pgsql", "t", {}), `INSERT INTO "t" DEFAULT VALUES`);
});
