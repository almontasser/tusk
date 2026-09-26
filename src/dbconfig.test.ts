/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionFromConfig, connectionFromEnv, connectionFromUrl, connectionUrl, deleteStatement, insertStatement, literal, parseEnv, quoteIdentifier, repeatsEnv, statementAt, updateStatement } from "./dbconfig.ts";

test("parses .env values", () => {
  const env = parseEnv(`# comment\nDB_CONNECTION=mysql\nDB_PASSWORD="se#cret"\nDB_HOST=db # the host\n# DB_PORT=1\nexport DB_USERNAME='sail'\n`);
  assert.deepEqual(env, { DB_CONNECTION: "mysql", DB_PASSWORD: "se#cret", DB_HOST: "db", DB_USERNAME: "sail" });
});

test("fills in Laravel's defaults", () => {
  assert.equal(connectionFromEnv({}, "/app").database, "/app/database/database.sqlite");
  assert.equal(connectionFromEnv({ DB_DATABASE: "/tmp/x.sqlite" }, "/app").database, "/tmp/x.sqlite");
  assert.deepEqual(connectionFromEnv({ DB_CONNECTION: "pgsql" }, "/app"), {
    driver: "pgsql", host: "127.0.0.1", port: 5432, database: "laravel", username: "root", password: "", ssl_mode: "", ssl_ca: "",
  });
});

test("reads TLS settings as Laravel's config does", () => {
  const pg = connectionFromEnv({ DB_CONNECTION: "pgsql", DB_SSLMODE: "verify-full", DB_SSLROOTCERT: "storage/ca.pem" }, "/app");
  assert.deepEqual([pg.ssl_mode, pg.ssl_ca], ["verify-full", "/app/storage/ca.pem"]);
  assert.equal(connectionFromEnv({ DB_CONNECTION: "mysql", MYSQL_ATTR_SSL_CA: "/etc/ssl/cert.pem" }, "/app").ssl_ca, "/etc/ssl/cert.pem");
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
  assert.equal(updateStatement("sqlite", "posts", { title: null }, { id: "7" }), `UPDATE "posts" SET "title" = NULL WHERE "id" = '7'`);
  assert.equal(updateStatement("mysql", "t", { v: "x", id: "2" }, { a: "1", b: null }), "UPDATE `t` SET `v` = 'x', `id` = '2' WHERE `a` = '1' AND `b` IS NULL");
});

test("builds row inserts and deletes", () => {
  assert.equal(deleteStatement("pgsql", "posts", { id: "7" }), `DELETE FROM "posts" WHERE "id" = '7'`);
  assert.equal(insertStatement("sqlite", "posts", { title: "Hi", body: null }), `INSERT INTO "posts" ("title", "body") VALUES ('Hi', NULL)`);
  assert.equal(insertStatement("mysql", "t", {}), "INSERT INTO `t` () VALUES ()");
  assert.equal(insertStatement("pgsql", "t", {}), `INSERT INTO "t" DEFAULT VALUES`);
});

test("reads connection URLs and writes them back without the password", () => {
  const pg = connectionFromUrl("postgres://me:p%40ss@db.example.com/app?sslmode=verify-full&sslrootcert=storage/ca.pem", "/app")!;
  assert.deepEqual(pg, { driver: "pgsql", host: "db.example.com", port: 5432, database: "app", username: "me", password: "p@ss", ssl_mode: "verify-full", ssl_ca: "/app/storage/ca.pem" });
  assert.equal(connectionUrl(pg, "/app"), "pgsql://me@db.example.com:5432/app?sslmode=verify-full&sslrootcert=storage%2Fca.pem");
  assert.deepEqual(connectionFromUrl(connectionUrl(pg, "/app"), "/app"), { ...pg, password: "" });
  const lite = connectionFromUrl("sqlite:database/other.sqlite", "/app")!;
  assert.equal(lite.database, "/app/database/other.sqlite");
  assert.equal(connectionUrl(lite, "/app"), "sqlite:database/other.sqlite");
  assert.equal(connectionFromUrl("sqlite:///tmp/x.sqlite", "/app")!.database, "/tmp/x.sqlite");
  assert.equal(connectionUrl(connectionFromUrl("sqlite:///tmp/x.sqlite", "/app")!, "/app"), "sqlite:///tmp/x.sqlite");
  assert.equal(connectionFromUrl("mysql://root@127.0.0.1:3307/laravel", "/app")!.port, 3307);
  assert.equal(connectionFromUrl("sqlsrv://sa@host/db", "/app"), null);
  assert.equal(connectionFromUrl("forge@203.0.113.5", "/app"), null);
});

test("reads config/database.php's connections", () => {
  assert.deepEqual(connectionFromConfig({ driver: "pgsql", host: "replica", port: "6432", database: "app", username: "u", password: "p", sslmode: "prefer" }, "/app"), {
    driver: "pgsql", host: "replica", port: 6432, database: "app", username: "u", password: "p", ssl_mode: "prefer", ssl_ca: "",
  });
  assert.equal(connectionFromConfig({ driver: "mysql", url: "mysql://a@b/c", host: "ignored" }, "/app")!.host, "b");
  assert.equal(connectionFromConfig({ driver: "sqlite", database: "/app/database/database.sqlite" }, "/app")!.database, "/app/database/database.sqlite");
  assert.equal(connectionFromConfig({ driver: "sqlsrv" }, "/app"), null);
  // Laravel's stock entries read the same DB_ variables as the default; a replica doesn't.
  const env = { DB_CONNECTION: "sqlite" };
  const stock = (c: Record<string, unknown>) => repeatsEnv(connectionFromConfig(c, "/app")!, env, "/app");
  assert.equal(stock({ driver: "mysql", host: "127.0.0.1", port: "3306", database: "laravel", username: "root" }), true);
  assert.equal(stock({ driver: "pgsql", host: "127.0.0.1", port: "5432", database: "laravel", username: "root" }), true);
  assert.equal(stock({ driver: "sqlite", database: "/app/database/database.sqlite" }), true);
  assert.equal(stock({ driver: "mysql", host: "replica", port: "3306", database: "laravel", username: "root" }), false);
});
