/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { handlerLines, thrownIn, uncaughtClass } from "./debugexceptions.ts";

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
