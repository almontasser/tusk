import assert from "node:assert/strict";
import { test } from "node:test";
import { decode, encode, envValues, interpolate, readEnv, blockKeys, setEnv, timezoneFromEnv, timezoneSource } from "./envgen.ts";

const ENV = `APP_NAME=Laravel
APP_DEBUG=true # on locally

# DB_HOST=127.0.0.1
DB_CONNECTION=sqlite

export MAIL_MAILER=log
MAIL_PASSWORD=null
MAIL_FROM_ADDRESS="hello@example.com"
MAIL_FROM_NAME="\${APP_NAME}"
KEY='single $quoted'
CERT="line one
line \\"two\\""
AFTER=1
`;

test("readEnv reads values as phpdotenv does", () => {
  const env = envValues(ENV);
  assert.equal(env.APP_DEBUG, "true");
  assert.equal(env.MAIL_MAILER, "log");
  assert.equal(env.MAIL_PASSWORD, null);
  assert.equal(env.MAIL_FROM_ADDRESS, "hello@example.com");
  assert.equal(env.MAIL_FROM_NAME, "${APP_NAME}");
  assert.equal(env.KEY, "single $quoted");
  assert.equal(env.CERT, 'line one\nline "two"');
  assert.equal(env.AFTER, "1");
  assert.equal(env.DB_HOST, undefined);
  assert.equal(readEnv("A=1\nA=2\n").get("A")!.value, "2");
  assert.equal(decode('"a\\$b"'), "a$b");
  assert.equal(interpolate(env.MAIL_FROM_NAME!, env), "Laravel");
});

test("encode quotes values that need it", () => {
  assert.equal(encode("smtp"), "smtp");
  assert.equal(encode("My App"), '"My App"');
  assert.equal(encode("a#b"), '"a#b"');
  assert.equal(encode('say "hi"'), '"say \\"hi\\""');
  assert.equal(encode("${APP_NAME}"), "${APP_NAME}");
  assert.equal(encode("${APP_NAME}", { prefer: '"' }), '"${APP_NAME}"');
  assert.equal(encode("x@y.z", { prefer: '"' }), '"x@y.z"');
  assert.equal(encode("x", { prefer: "'" }), "'x'");
  // Secrets are literal: `${` mustn't be read as a reference.
  assert.equal(encode("pa${ss}", { literal: true }), "'pa${ss}'");
  assert.equal(encode("it's $x", { literal: true }), '"it\'s \\$x"');
  for (const v of ["My App", 'q"uote', "back\\slash", "a#b", "multi\nline", "it's $x"]) assert.equal(decode(encode(v, { literal: true })), v);
  assert.equal(encode(""), "");
});

test("setEnv changes a value in place, keeping comments, export, and quoting", () => {
  const next = setEnv(ENV, "APP_DEBUG", "false");
  assert.ok(next.includes("APP_DEBUG=false # on locally\n"));
  assert.ok(setEnv(ENV, "MAIL_MAILER", "smtp").includes("export MAIL_MAILER=smtp\n"));
  assert.ok(setEnv(ENV, "CERT", "x").includes("CERT=x\nAFTER=1"));
  assert.equal(setEnv(ENV, "AFTER", "1"), ENV);
});

test("setEnv adds a missing key next to its group", () => {
  assert.ok(setEnv(ENV, "MAIL_HOST", "smtp.example.com").includes('MAIL_FROM_NAME="${APP_NAME}"\nMAIL_HOST=smtp.example.com\nKEY='));
  assert.ok(setEnv(ENV, "DB_HOST", "db").includes("# DB_HOST=127.0.0.1\nDB_HOST=db\nDB_CONNECTION"));
  assert.ok(setEnv(ENV, "DB_PORT", "3306").includes("DB_CONNECTION=sqlite\nDB_PORT=3306\n"));
  assert.ok(setEnv(ENV, "QUEUE_CONNECTION", "database").endsWith('two\\""\nAFTER=1\n\nQUEUE_CONNECTION=database\n'));
  assert.equal(setEnv("A=1", "B", "2"), "A=1\n\nB=2\n");
  assert.equal(setEnv("", "B", "2"), "B=2\n");
});

test("the time zone in config/app.php", () => {
  const fixed = "    'timezone' => 'UTC',\n";
  assert.deepEqual(timezoneSource("'timezone' => env('APP_TIMEZONE', 'UTC'),"), { kind: "env" });
  assert.equal(timezoneSource(fixed)?.kind, "fixed");
  assert.equal(timezoneSource("'timezone' => Tz::get(),")?.kind, "code");
  assert.equal(timezoneFromEnv(fixed), "    'timezone' => env('APP_TIMEZONE', 'UTC'),\n");
});

test("blockKeys reads a service's env keys", () => {
  const services = "'postmark' => [\n  'token' => env('POSTMARK_TOKEN'),\n],\n'ses' => [\n  'key' => env('AWS_ACCESS_KEY_ID'),\n  'region' => env('AWS_DEFAULT_REGION', 'us-east-1'),\n],";
  assert.deepEqual(blockKeys(services, "postmark"), ["POSTMARK_TOKEN"]);
  assert.deepEqual(blockKeys(services, "ses"), ["AWS_ACCESS_KEY_ID", "AWS_DEFAULT_REGION"]);
  assert.deepEqual(blockKeys(services, "resend"), []);
});
