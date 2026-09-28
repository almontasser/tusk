/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { completions, handlerLines, inlineValues, portInUse, thrownIn, uncaughtClass, xdebugEnvFor } from "./debugexceptions.ts";

test("matches where an exception was thrown against project path patterns", () => {
  assert.equal(thrownIn("/app/vendor/laravel/framework/src/Builder.php", "/app", ["vendor/**"]), true);
  assert.equal(thrownIn("/app/app/Models/Post.php", "/app", ["vendor/**"]), false);
  assert.equal(thrownIn("/app/app/Legacy/Old.php", "/app", ["vendor/**", "app/Legacy/*"]), true);
  assert.equal(thrownIn("/usr/share/php/Pear.php", "/app", ["**/php/*"]), true);
});

test("reads the class of an uncaught exception from PHP's fatal error", () => {
  assert.equal(uncaughtClass("Fatal error: Uncaught App\\Exceptions\\PaymentFailed: no card in /app/a.php:4\nStack trace:"), "App\\Exceptions\\PaymentFailed");
  assert.equal(uncaughtClass("RuntimeException: caught"), undefined);
});

test("finds the first statement of Laravel's render methods", () => {
  const source = ["<?php", "class Handler", "{", "    public function render($request, Throwable $e)", "    {", "", "        $e = $this->mapException($e);", "    }", "    public function renderForConsole($output, Throwable $e)", "    {", "        if ($e) {}", "    }", "    protected function renderHttpException() {}", "}"].join("\n");
  assert.deepEqual(handlerLines(source), [7, 11]);
});

test("recognizes a port another program listens on", () => {
  assert.equal(portInUse("listen EADDRINUSE: address already in use :::9003"), true);
  assert.equal(portInUse("connection refused"), false);
});

test("builds Xdebug's environment with the port, IDE key, and container host", () => {
  assert.deepEqual(xdebugEnvFor(9003, "1"), ["XDEBUG_MODE=debug", "XDEBUG_SESSION=1", "XDEBUG_CONFIG=client_port=9003"]);
  assert.deepEqual(xdebugEnvFor(9100, " ", "host.docker.internal"), ["XDEBUG_MODE=debug", "XDEBUG_SESSION=1", "XDEBUG_CONFIG=client_port=9100 client_host=host.docker.internal"]);
});

test("completes the variable name before the cursor", () => {
  const names = ["$user", "$users", "$request", "$user"];
  assert.deepEqual(completions("count($us", 9, names), { start: 6, matches: ["$user", "$users"] });
  assert.deepEqual(completions("$user", 5, names), { start: 0, matches: ["$users"] });
  assert.equal(completions("$x + 1", 6, names), null);
  assert.equal(completions("$zz", 3, names), null);
});

test("finds the values to show inline, from the paused line up to its function", () => {
  const lines = ["<?php", "function save($post) {", "    $user = auth()->user();", "    $post->owner = $user;", "    return $post;", "}"];
  const values = new Map([["$post", "App\\Post"], ["$user", "App\\User"]]);
  assert.deepEqual(inlineValues(lines, 4, values), [
    { line: 2, text: "$post: App\\Post" },
    { line: 3, text: "$user: App\\User" },
    { line: 4, text: "$post: App\\Post, $user: App\\User" },
  ]);
  const script = ["<?php", "function f($user) {", "    return $user;", "}", "$user = 1;", "f($user);"];
  assert.deepEqual(inlineValues(script, 6, new Map([["$user", "1"]])), [{ line: 5, text: "$user: 1" }, { line: 6, text: "$user: 1" }]);
  assert.equal(inlineValues(["$a = '" + "x".repeat(80) + "';"], 1, new Map([["$a", "x".repeat(80)]]))[0].text.length, 54);
});
