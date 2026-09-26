/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { literalType, constantDeclaration, constantRefs, inlinedValue, functionScope, constantAt, constantName, constantPoint, declarationPoint, expressionIn, expressionsAt, occurrences, variableName } from "./extractparse.ts";

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

test("reads a selection as an expression", () => {
  const code = "<?php\n$x = $a + $b * $c;";
  assert.equal(expressionIn(code, code.indexOf("$b"), code.indexOf(";"))?.text, "$b * $c");
  assert.equal(expressionIn(code, code.indexOf("$a"), code.indexOf(" * ")), null);
});

test("finds occurrences that are whole expressions", () => {
  const code = "<?php\n$a = $x->total() + 1;\n$b = $x->total() * 2;\n$c = $x->total()->cents;\n$d = $x->total;";
  const expr = expressionsAt(code, code.indexOf("total"))[0];
  assert.equal(expr.text, "$x->total()");
  assert.deepEqual(occurrences(code, expr).map((e) => code.slice(0, e.start).split("\n").length), [2, 3, 4]);
  const sum = "<?php\nf($a + $b);\ng($a + $b * $c);\nh( $a+$b );";
  const first = expressionIn(sum, sum.indexOf("$a"), sum.indexOf(")"))!;
  assert.deepEqual(occurrences(sum, first).map((e) => e.text), ["$a + $b", "$a+$b"]);
});

test("declares before the statement, in the block that holds every use", () => {
  const code = ["<?php", "function f($items) {", "    $sum = 0;", "    foreach ($items as $item) {", "        $sum += $item->price();", "    }", "    if ($ok) {", "        g();", "    } else {", "        h($item->price());", "    }", "}"].join("\n");
  const expr = expressionsAt(code, code.indexOf("price"))[0];
  const inner = declarationPoint(code, [expr]);
  assert.ok(!("error" in inner) && code.slice(inner.offset).startsWith("$sum += ") && inner.indent === "        ");
  const both = declarationPoint(code, occurrences(code, expr));
  assert.ok(!("error" in both) && code.slice(both.offset).startsWith("foreach") && both.indent === "    ");
  // Uses only in the else block go inside it, not before the if.
  const last = occurrences(code, expr)[1];
  const inElse = declarationPoint(code, [last]);
  assert.ok(!("error" in inElse) && code.slice(inElse.offset).startsWith("h($item"));
  // A statement that's only the expression becomes the assignment.
  const call = "<?php\nfoo();";
  const alone = declarationPoint(call, [expressionsAt(call, call.indexOf("foo"))[0]]);
  assert.ok(!("error" in alone) && alone.replace?.text === "foo()");
});

test("reads constants and where they go", () => {
  const code = "<?php\nclass A\n{\n    use T;\n\n    public function f() { return 'pending review' . 1; }\n}";
  assert.equal(constantAt(code, code.indexOf("pending"), code.indexOf("pending"))?.text, "'pending review'");
  assert.equal(constantAt(code, code.indexOf("$"), code.indexOf("$")), null);
  const point = constantPoint(code, code.indexOf("{"));
  assert.deepEqual([code.slice(point.offset).split("\n")[0], point.gap, point.gapBefore], ["", true, true]);
  const withConst = "<?php\nclass A {\n    const X = 1;\n    private const Y = [1, 2];\n    function f() { $a = 1; }\n}";
  const p2 = constantPoint(withConst, withConst.indexOf("{"));
  assert.deepEqual([withConst.slice(p2.offset).split("\n")[0], p2.gap], ["    function f() { $a = 1; }", false]);
});

test("suggests names", () => {
  assert.equal(variableName("$user->getEmail()"), "email");
  assert.equal(variableName("$item['unit_price']"), "unitPrice");
  assert.equal(variableName("new \\App\\Invoice($a)"), "invoice");
  assert.equal(variableName("count($items)", new Set(["count"])), "count2");
  assert.equal(variableName("$a * $b"), "value");
  assert.equal(variableName("$item['price'] * $item['qty']"), "value");
  assert.equal(variableName("!$user->isAdmin()"), "admin");
  assert.equal(variableName("$user->posts()->where('a', 1)->count()"), "count");
  assert.equal(variableName("$this->user()->name"), "name");
  assert.equal(constantName("'pending review'"), "PENDING_REVIEW");
  assert.equal(constantName("1.14", new Set(["VALUE"])), "VALUE_2");
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
  assert.deepEqual(constantRefs(owner, "LIMIT").map((r) => [owner.slice(r.start, r.end), r.owner]), [["self::LIMIT", "App\\Order"], ["static::LIMIT", "App\\Order"]]);
  const user = "<?php\nuse App\\Order as O;\n$a = O::LIMIT; $b = 'O::LIMIT'; $c = $o::LIMIT;";
  assert.deepEqual(constantRefs(user, "LIMIT").map((r) => r.owner), ["App\\Order"]);
  assert.equal(inlinedValue("self::BASE * 2", owner, "App\\Order", false), "(\\App\\Order::BASE * 2)");
  assert.equal(inlinedValue("self::BASE * 2", owner, "App\\Order", true), "(self::BASE * 2)");
  assert.equal(inlinedValue("Status::Open", owner, "App\\Order", false), "\\App\\Enums\\Status::Open");
  assert.equal(inlinedValue("-1", owner, "App\\Order", false), "-1");
  assert.equal(inlinedValue("['a' => 1]", owner, "App\\Order", false), "['a' => 1]");
});

test("tells a literal's type", () => {
  assert.deepEqual(["42", "1.5", "'a'", '"b$c"', "true", "[1]", "new Money(5)", "$a + 1"].map(literalType), ["int", "float", "string", "", "bool", "array", "Money", ""]);
});
