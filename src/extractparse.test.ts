/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { reindentCode, inlineCall, methodToInline, constantDeclaration, constantRefs, inlinedValue, functionScope, declarationPoint, expressionsAt } from "./extractparse.ts";

const texts = (source: string, at: string, delta = 1) => expressionsAt(source, source.indexOf(at) + delta).map((e) => e.text);

test("lists the expressions around the caret, innermost first, by precedence", () => {
  const code = "<?php\n$sum += $item['price'] * $item['qty'] * 1.14;";
  assert.deepEqual(texts(code, "$item['price']"), ["$item['price']", "$item['price'] * $item['qty']", "$item['price'] * $item['qty'] * 1.14"]);
  assert.deepEqual(texts(code, "1.14"), ["1.14", "$item['price'] * $item['qty'] * 1.14"]);
  // The assignment target isn't a value.
  assert.deepEqual(texts(code, "$sum"), []);
  const sum = "<?php\n$x = $a + $b * $c;";
  assert.deepEqual(texts(sum, "$b"), ["$b * $c", "$a + $b * $c"]);
  assert.deepEqual(texts(sum, "$a"), ["$a + $b * $c"]);
});

test("offers method chains, calls, and the calls that take an expression", () => {
  const code = "<?php\nreturn strtoupper($this->user()->name . '!');";
  assert.deepEqual(texts(code, "user"), ["$this->user()", "$this->user()->name", "$this->user()->name . '!'", "strtoupper($this->user()->name . '!')"]);
  assert.deepEqual(texts("<?php\n$a = new Money(5, 'EUR');", "Money"), ["new Money(5, 'EUR')"]);
  assert.deepEqual(texts("<?php\n$a = Status::ACTIVE;", "ACTIVE"), ["Status::ACTIVE"]);
  assert.deepEqual(texts("<?php\n$a = !$user->isAdmin();", "isAdmin"), ["$user->isAdmin()", "!$user->isAdmin()"]);
  // A condition's expression, but not past the if.
  assert.deepEqual(texts("<?php\nif (count($items) > 0) {}", "count"), ["count($items)", "count($items) > 0"]);
  // Nothing from an arrow function's body, which uses its parameter, but the call around it counts.
  assert.deepEqual(texts("<?php\n$b = array_map(fn($x) => $x * 2, $xs);", "* 2", -3), ["array_map(fn($x) => $x * 2, $xs)"]);
});

test("declares before the statement, in the block that holds every use", () => {
  const code = ["<?php", "function f($items) {", "    $sum = 0;", "    foreach ($items as $item) {", "        $sum += $item->price();", "    }", "    if ($ok) {", "        g();", "    } else {", "        h($item->price());", "    }", "}"].join("\n");
  const expr = expressionsAt(code, code.indexOf("price"))[0];
  const inner = declarationPoint(code, [expr]);
  assert.ok(!("error" in inner) && code.slice(inner.offset).startsWith("$sum += ") && inner.indent === "        ");
  const last = expressionsAt(code, code.lastIndexOf("price"))[0];
  const both = declarationPoint(code, [expr, last]);
  assert.ok(!("error" in both) && code.slice(both.offset).startsWith("foreach") && both.indent === "    ");
  // Uses only in the else block go inside it, not before the if.
  const inElse = declarationPoint(code, [last]);
  assert.ok(!("error" in inElse) && code.slice(inElse.offset).startsWith("h($item"));
  // A statement that's only the expression becomes the assignment.
  const call = "<?php\nfoo();";
  const alone = declarationPoint(call, [expressionsAt(call, call.indexOf("foo"))[0]]);
  assert.ok(!("error" in alone) && alone.replace?.text === "foo()");
});

test("finds the function or closure around an offset", () => {
  const code = "<?php\nclass A {\n  public function f(int $a): ?int {\n    $g = function () use ($a) { return $a + 1; };\n    if ($a) { return $a; }\n  }\n}\n$top = 1;";
  const body = (at: string) => code.slice(...functionScope(code, code.indexOf(at))).trim();
  assert.ok(body("if ($a)").startsWith("$g = function"));
  assert.equal(body("return $a + 1"), "return $a + 1;");
  assert.equal(body("$top"), code.trim());
});

test("reads a constant's declaration and references, and writes its value elsewhere", () => {
  const owner = "<?php\nnamespace App;\nuse App\\Enums\\Status;\nclass Order {\n    /** Doc. */\n    public const LIMIT = self::BASE * 2;\n    const BASE = 10, OTHER = 1;\n    const DEFAULT = Status::Open;\n    public function f() { return self::LIMIT + static::LIMIT; }\n}";
  const decl = constantDeclaration(owner, "LIMIT", owner.indexOf("{"));
  assert.ok(decl && !("error" in decl));
  assert.equal(decl.value, "self::BASE * 2");
  assert.ok(owner.slice(decl.start, decl.end).startsWith("public const LIMIT"));
  assert.deepEqual(constantDeclaration(owner, "BASE", owner.indexOf("{")), { error: "BASE is declared with other constants in one statement" });
  assert.deepEqual(constantDeclaration(owner, "OTHER", owner.indexOf("{")), { error: "OTHER is declared with other constants in one statement" });
  assert.deepEqual(constantRefs(owner, "LIMIT").map((r) => [owner.slice(r.start, r.end), r.owner]), [["self::LIMIT", "App\\Order"], ["static::LIMIT", "App\\Order"]]);
  const user = "<?php\nuse App\\Order as O;\n$a = O::LIMIT; $b = 'O::LIMIT'; $c = $o::LIMIT;";
  assert.deepEqual(constantRefs(user, "LIMIT").map((r) => r.owner), ["App\\Order"]);
  assert.equal(inlinedValue("self::BASE * 2", owner, "App\\Order", false), "(\\App\\Order::BASE * 2)");
  assert.equal(inlinedValue("self::BASE * 2", owner, "App\\Order", true), "(self::BASE * 2)");
  assert.equal(inlinedValue("Status::Open", owner, "App\\Order", false), "\\App\\Enums\\Status::Open");
  assert.equal(inlinedValue("-1", owner, "App\\Order", false), "(-1)");
  assert.equal(inlinedValue("1", owner, "App\\Order", false), "1");
  assert.equal(inlinedValue("'Helper::format'", owner, "App\\Order", false), "'Helper::format'");
  assert.equal(inlinedValue("['a' => 1]", owner, "App\\Order", false), "['a' => 1]");
});

test("handles precedence of prefixes, for headers, class bodies, parameters, and closures", () => {
  assert.deepEqual(texts("<?php\n$y = -$x ** 2;", "$x"), ["-$x ** 2"]);
  assert.deepEqual(texts("<?php\n$y = !$a instanceof Foo;", "$a"), ["!$a instanceof Foo"]);
  const loop = "<?php\nfunction f($a) {\n    for ($i = 0; $i < count($a); $i++) {}\n}";
  const point = declarationPoint(loop, [expressionsAt(loop, loop.indexOf("count"))[0]]);
  assert.ok(!("error" in point) && loop.slice(point.offset).startsWith("for ("));
  const cls = "<?php\nclass A {\n    private int $ttl = 5 * 60;\n}";
  assert.ok("error" in declarationPoint(cls, [expressionsAt(cls, cls.indexOf("5"))[0]]));
  const param = "<?php\nfunction f($a = 5 * 60) {}";
  assert.ok("error" in declarationPoint(param, [expressionsAt(param, param.indexOf("5"))[0]]));
  const arg = "<?php\nfunction f($xs) {\n    return array_map(function ($x) { return $x; }, g(1));\n}";
  const inArg = declarationPoint(arg, [expressionsAt(arg, arg.indexOf("g(1)"))[0]]);
  assert.ok(!("error" in inArg) && arg.slice(inArg.offset).startsWith("return array_map"));
});

test("reads a method to inline and substitutes a call", () => {
  const cls = [
    "<?php",
    "class A {",
    "    public function total(int $qty, float $price = 1.5): float",
    "    {",
    "        $sum = $qty * $price;",
    "        // don't round",
    "        return $sum + $this->fee;",
    "    }",
    "    public function twice($x) { return $x + $x; }",
    "    public function log(string $m) { echo $m; }",
    "    public function many($a) { if ($a) { return 1; } return 2; }",
    "    public function bump($a) { $a++; return $a; }",
    "    public function gen() { yield 1; }",
    "    public function hi($name) { return \"hi $name\"; }",
    "    public function cb($a) { return array_map(function ($x) { return $x; }, $a); }",
    "}",
  ].join("\n");
  const at = (name: string) => cls.indexOf(`function ${name}`) + 9 + name.length;
  const total = methodToInline(cls, at("total"));
  assert.ok(!("error" in total));
  assert.equal(total.result, "$sum + $this->fee");
  assert.deepEqual(total.locals, ["sum"]);
  assert.ok(total.usesThis);
  // A caller that already has $sum gets $sum2; $order stands in for $this.
  const call = inlineCall(total, ["$n", "price: 2"], "$order", new Set(["sum", "n", "order"]));
  assert.ok(!("error" in call));
  assert.match(call.body, /\$sum2 = \$n \* 2;/);
  assert.equal(call.result, "$sum2 + $order->fee");
  // A complex argument read twice is evaluated once into a variable.
  const twice = methodToInline(cls, at("twice"));
  assert.ok(!("error" in twice));
  assert.deepEqual(inlineCall(twice, ["f()"], null, new Set()), { statements: ["$x = f();"], body: " ", result: "$x + $x" });
  assert.deepEqual(inlineCall(twice, ["$a->b"], null, new Set()), { statements: [], body: " ", result: "$a->b + $a->b" });
  assert.deepEqual(inlineCall(twice, ["$a->b()"], null, new Set()), { statements: ["$x = $a->b();"], body: " ", result: "$x + $x" });
  const log = methodToInline(cls, at("log"));
  assert.ok(!("error" in log));
  const echoed = inlineCall(log, ["strtoupper($s)"], null, new Set());
  assert.ok(!("error" in echoed) && echoed.body.trim() === "echo strtoupper($s);");
  assert.ok(!("error" in log) && log.result === null);
  // Refusals.
  for (const name of ["many", "gen", "hi"]) assert.ok("error" in methodToInline(cls, at(name)), name);
  // A method that changes its parameter works on a copy.
  const bump = methodToInline(cls, at("bump"));
  assert.ok(!("error" in bump));
  assert.deepEqual(inlineCall(bump, ["$v"], null, new Set(["v"])), { statements: ["$a = $v;"], body: " $a++; ", result: "$a" });
  // A closure's own return doesn't count as the method's.
  const cb = methodToInline(cls, at("cb"));
  assert.ok(!("error" in cb) && cb.result?.startsWith("array_map"));
  assert.ok("error" in inlineCall(twice, [], null, new Set()));
});

test("inlines without changing what runs, or where", () => {
  const src = (body: string, params = "$a") => `<?php\nfunction m(${params}) { ${body} }`;
  const read = (body: string, params?: string) => {
    const m = methodToInline(src(body, params), 16);
    assert.ok(!("error" in m), JSON.stringify(m));
    return m;
  };
  const call = (m: ReturnType<typeof read>, args: string[], receiver: string | null = null) => {
    const r = inlineCall(m, args, receiver, new Set(["v", "o"]));
    assert.ok(!("error" in r), JSON.stringify(r));
    return r;
  };
  // Written by a by-reference built-in, unset, destructuring, foreach, or catch: a copy.
  for (const body of ["sort($a); return $a;", "unset($a); return 1;", "[$a, $b] = [1, 2]; return $a;", "foreach ([1] as $a) {} return 1;", "try {} catch (E $a) {} return 1;"])
    assert.equal(call(read(body), ["$v"]).statements[0], "$a = $v;", body);
  // Arguments with side effects keep their order.
  const minus = read("return $b - $a;", "$a, $b");
  assert.deepEqual(call(minus, ["f()", "h()"]), { statements: ["$a = f();", "$b = h();"], body: " ", result: "$b - $a" });
  const logs = read("logit(); return $a;");
  assert.deepEqual(call(logs, ["f()"]).statements, ["$a = f();"]);
  // A lone read with nothing before it stays in place.
  assert.deepEqual(call(read("return strtoupper($a);"), ["f()"]), { statements: [], body: " ", result: "strtoupper(f())" });
  // isset() takes a variable, and a closure's own $a isn't the parameter.
  assert.equal(call(read("return isset($a);"), ["5"]).statements[0], "$a = 5;");
  const closure = call(read("return array_map(function ($a) { return $a * 2; }, $a);"), ["[1, 2]"]);
  assert.equal(closure.result, "array_map(function ($a) { return $a * 2; }, [1, 2])");
  // Signs, clone, and include count.
  assert.equal(call(read("return -$a;"), ["-1"]).result, "-(-1)");
  assert.deepEqual(call(read("return [$a, $a];"), ["clone $o"]).statements, ["$a = clone $o;"]);
  assert.deepEqual(call(read("return 1;"), ["include 'x.php'"]).statements, ["include 'x.php';"]);
  assert.ok("error" in methodToInline(src("$n = 'a'; return $$n;"), 16));
  assert.ok("error" in inlineCall(read("return function () { return $this; };"), [], "$o", new Set()));
});

test("re-indents code but not the lines of a multi-line string", () => {
  assert.deepEqual(reindentCode("\n        $a = 'x\ny';\n        f();\n", "  "), ["  $a = 'x", "y';", "  f();"]);
});
