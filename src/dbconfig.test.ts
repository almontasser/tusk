/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { destinationOf, parseDestination, connectionFromConfig, connectionFromEnv, connectionFromUrl, connectionUrl, deleteStatement, insertStatement, insertTemplate, literal, parseEnv, quoteIdentifier, readsOnly, redisFromEnv, repeatsEnv, selectTemplate, splitStatements, statementAt, updateStatement, versionText } from "./dbconfig.ts";

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

test("splits a script into statements outside strings, comments, and dollar quotes", () => {
  const texts = (sql: string, driver = "") => splitStatements(sql, driver).map((s) => s.text);
  assert.deepEqual(texts("select ';' ; select \"a;b\"; -- c;\n/* d; */ select 3;;"), ["select ';'", 'select "a;b"', "-- c;\n/* d; */ select 3"]);
  assert.deepEqual(texts("create function f() returns int as $$ select 1; $$ language sql; select 2"), ["create function f() returns int as $$ select 1; $$ language sql", "select 2"]);
  assert.deepEqual(texts("select $tag$ a; $tag$; select 'it''s;'"), ["select $tag$ a; $tag$", "select 'it''s;'"]);
  // MySQL takes a backslash before a quote; PostgreSQL's standard strings don't.
  assert.deepEqual(texts("select 'a\\'; b'; select 2", "mysql"), ["select 'a\\'; b'", "select 2"]);
  assert.deepEqual(texts("select 'C:\\'; select 2", "pgsql"), ["select 'C:\\'", "select 2"]);
  assert.deepEqual(texts("  -- only a comment\n ; "), []);
  const [a, b] = splitStatements("select 1;\n  select 2");
  assert.deepEqual([a.start, a.end, b.start, b.end], [0, 8, 12, 20]);
  assert.equal(statementAt("select ';'; select 2", 3), "select ';'");
});

test("tells statements that only read", () => {
  for (const sql of ["SELECT 1", "  select * from t", "(select 1) union (select 2)", "with a as (select 1) select * from a", "show tables", "EXPLAIN select 1", "pragma table_info(t)", "-- note\nselect 1"]) assert.ok(readsOnly(sql), sql);
  for (const sql of ["update t set a = 1", "delete from t", "with a as (select 1) delete from t", "pragma foreign_keys = on", "drop table t", "set x = 1", "insert into t values (1)"]) assert.ok(!readsOnly(sql), sql);
});

test("reads the server's version", () => {
  assert.equal(versionText("mysql", "MySQL 8.4.0"), "MySQL 8.4.0");
  assert.equal(versionText("redis", "# Server\r\nredis_version:7.2.4\r\nredis_mode:standalone"), "Redis 7.2.4");
});

test("generates SELECT and INSERT for a table", () => {
  assert.equal(selectTemplate("mysql", "users", ["id", "name"]), "SELECT `id`, `name`\nFROM `users`");
  assert.equal(insertTemplate("pgsql", "users", ["id", "name"]), 'INSERT INTO "users" ("id", "name")\nVALUES (?, ?)');
});

test("quotes identifiers per driver", () => {
  assert.equal(quoteIdentifier("mysql", "a`b"), "`a``b`");
  assert.equal(quoteIdentifier("sqlite", 'a"b'), '"a""b"');
});

test("writes raw SQL values, such as DEFAULT, as they are", () => {
  assert.equal(updateStatement("pgsql", "t", { a: { sql: "DEFAULT" }, b: null }, { id: "1" }), `UPDATE "t" SET "a" = DEFAULT, "b" = NULL WHERE "id" = '1'`);
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

test("reads Redis connections from URLs and .env", () => {
  const plain = connectionFromUrl("redis://:s%40cret@cache.example.com:6380/2", "/app")!;
  assert.deepEqual(plain, { driver: "redis", host: "cache.example.com", port: 6380, database: "2", username: "", password: "s@cret", ssl_mode: "", ssl_ca: "" });
  assert.equal(connectionUrl(plain, "/app"), "redis://cache.example.com:6380/2");
  const tls = connectionFromUrl("rediss://default:p@cache.example.com", "/app")!;
  assert.deepEqual([tls.port, tls.database, tls.username, tls.ssl_mode], [6379, "0", "default", "verify-full"]);
  assert.equal(connectionUrl(tls, "/app"), "rediss://default@cache.example.com:6379/0");
  assert.deepEqual(connectionFromUrl(connectionUrl(tls, "/app"), "/app"), { ...tls, password: "" });
  assert.equal(connectionFromUrl("rediss://h?sslmode=require", "/app")!.ssl_mode, "require");
  assert.equal(connectionUrl(connectionFromUrl("rediss://h?sslmode=require", "/app")!, "/app"), "rediss://h:6379/0?sslmode=require");

  // Laravel's stock .env: REDIS_PASSWORD=null is no password, and the cache uses database 1.
  const stock = redisFromEnv(parseEnv("REDIS_HOST=127.0.0.1\nREDIS_PASSWORD=null\nREDIS_PORT=6379"), "/app");
  assert.deepEqual(stock.redis, { driver: "redis", host: "127.0.0.1", port: 6379, database: "0", username: "", password: "", ssl_mode: "", ssl_ca: "" });
  assert.equal(stock["redis cache"].database, "1");
  // Sail's container name only resolves inside Docker, so connect to the forwarded port.
  const sail = redisFromEnv({ REDIS_HOST: "redis", FORWARD_REDIS_PORT: "6380", REDIS_DB: "3" }, "/app", true);
  assert.deepEqual([sail.redis.host, sail.redis.port, sail.redis.database], ["127.0.0.1", 6380, "3"]);
  const url = redisFromEnv({ REDIS_URL: "rediss://u:p@h:1234", REDIS_CACHE_DB: "5" }, "/app");
  assert.deepEqual([url.redis.host, url.redis.port, url.redis.password, url.redis.ssl_mode, url["redis cache"].database], ["h", 1234, "p", "verify-full", "5"]);
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

test("reads and writes SSH destinations", () => {
  assert.deepEqual(parseDestination("ssh://forge@203.0.113.5:2222"), { user: "forge", host: "203.0.113.5", port: "2222" });
  assert.deepEqual(parseDestination("deploy@example.com"), { user: "deploy", host: "example.com", port: "" });
  assert.deepEqual(parseDestination("staging"), { user: "", host: "staging", port: "" });
  assert.equal(destinationOf("forge", "203.0.113.5", "22"), "forge@203.0.113.5");
  assert.equal(destinationOf("forge", "203.0.113.5", "2222"), "ssh://forge@203.0.113.5:2222");
  assert.equal(destinationOf("", "", "22"), "");
});
