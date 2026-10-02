/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { classProperties, declarationParts, formatArgs, formatParams, matchBracket, paramText, parseParams, rewriteArgs, splitTopLevel } from "./refactorparse.ts";

test("splits arguments at top-level commas", () => {
  assert.deepEqual(splitTopLevel(`$a, foo($b, [1, 2]), 'x, y', "q\\", r"`), ["$a", "foo($b, [1, 2])", "'x, y'", `"q\\", r"`]);
  assert.deepEqual(splitTopLevel(""), []);
  const text = "call(a(b), ')')";
  assert.equal(matchBracket(text, 4), text.length - 1);
});

test("rewrites call arguments for a new signature", () => {
  const old = parseParams("int $a, string $b = 'x', ?array $c = null");
  const reordered = parseParams("?array $c = null, int $a");
  assert.deepEqual(rewriteArgs(["1", "'y'", "[2]"], old, reordered), { args: ["[2]", "1"] });
  // $c left out before $a: its default fills the gap.
  assert.deepEqual(rewriteArgs(["1"], old, reordered), { args: ["null", "1"] });
  // Named arguments stay named and move to the end.
  assert.deepEqual(rewriteArgs(["b: 'z'", "a: 5"], old, parseParams("string $b = 'x', int $a")), { args: ["b: 'z'", "a: 5"] });
  const added = parseParams("int $a, bool $strict = false, string $b = 'x'");
  assert.deepEqual(rewriteArgs(["1", "'y'"], old, added), { args: ["1", "false", "'y'"] });
  assert.ok("error" in rewriteArgs(["...$all"], old, reordered));
  assert.ok("error" in rewriteArgs(["1"], old, parseParams("int $a, int $d")));
});

test("reads a class's properties", () => {
  const body = `
    use HasFactory;
    const LIMIT = 10;
    // public $commented;
    protected static int $count = 0;
    #[Inject]
    private ?User $user;
    public readonly string $title;
    protected $fillable = ['title'];

    public function __construct(private readonly Clock $clock, int $plain, public array &$tags = []) {
        $this->title = 'x';
    }

    public function name(): string { return $this->title; }
    public $after;
  `;
  const props = classProperties(body);
  assert.deepEqual(
    props.map((p) => [p.name, p.type, p.isStatic, p.readonly, p.hasDefault, p.promoted]),
    [
      ["count", "int", true, false, true, false],
      ["user", "?User", false, false, false, false],
      ["title", "string", false, true, false, false],
      ["fillable", "", false, false, true, false],
      ["after", "", false, false, false, false],
      ["clock", "Clock", false, true, false, true],
      ["tags", "array", false, false, false, true],
    ],
  );
  assert.equal(body[props[1].end], ";");
  assert.equal(body.slice(0, props[1].end).split("\n").length, 7);
});

test("renames parameters in calls and fills new ones with a value for calls", () => {
  const old = parseParams("int $a, string $b = 'x'");
  const renamed = parseParams("int $amount, string $b = 'x'").map((p, i) => ({ ...p, from: old[i].name }));
  assert.deepEqual(rewriteArgs(["a: 1"], old, renamed), { args: ["amount: 1"] });
  assert.deepEqual(rewriteArgs(["1", "'y'"], old, renamed), { args: ["1", "'y'"] });
  // A new required parameter gets the value for calls, even after the defaults.
  const added = [...renamed, { ...parseParams("bool $strict")[0], callValue: "true" }];
  assert.deepEqual(rewriteArgs(["1"], old, added), { args: ["1", "'x'", "true"] });
  assert.ok("error" in rewriteArgs(["1"], old, [...renamed, parseParams("bool $strict")[0]]));
  // After a named argument, the rest are named too, so none takes its place.
  const reordered = [{ ...parseParams("int $qty = 1")[0], from: "qty" }, { ...parseParams("float $percent")[0], from: "rate" }, { ...parseParams("bool $round")[0], callValue: "true" }];
  const before = parseParams("float $rate, int $qty = 1");
  assert.deepEqual(rewriteArgs(["rate: 0.2"], before, reordered), { args: ["percent: 0.2", "round: true"] });
  assert.deepEqual(rewriteArgs(["0.1", "3"], before, reordered), { args: ["3", "0.1", "true"] });
});

test("reads a declaration's parts and writes parameters back", () => {
  const text = "    public static function &make(\n        private readonly int $a,\n        #[Sensitive] string ...$rest,\n    ): ?static {}";
  const parts = declarationParts(text, text.indexOf("make") + 4)!;
  assert.equal(parts.modifiers, "public static");
  assert.equal(parts.name, "make");
  assert.ok(parts.byRef);
  assert.equal(parts.returnType, "?static");
  assert.equal(parts.indent, "        ");
  assert.deepEqual(parts.params.map((p) => [p.type, p.name, p.variadic]), [["private readonly int", "a", false], ["#[Sensitive] string", "rest", true]]);
  assert.equal(text.slice(parts.end), " {}");
  assert.equal(formatParams(parts.params, parts.indent, "    "), "\n        private readonly int $a,\n        #[Sensitive] string ...$rest,\n    ");
  assert.equal(paramText({ ...parseParams("array &$x = []")[0] }), "array &$x = []");
  const short = "function f($a) {}";
  assert.equal(declarationParts(short, 10)?.end, 14);
});

test("skips comments when matching brackets and splitting", () => {
  const body = "{ // don't\n  $a = f('}', /* ) */ 1); # it's\n}";
  assert.equal(matchBracket(body, 0), body.length - 1);
  assert.deepEqual(splitTopLevel("$a, // b's\n$c"), ["$a", "// b's\n$c"]);
  assert.deepEqual(rewriteArgs(["..."], parseParams("$a"), parseParams("$b = 1, $a")), { args: ["..."] });
});

test("writes arguments back without letting a line comment swallow the rest", () => {
  assert.equal(formatArgs(["$a", "$b"], "$b, $a", "    "), "$a, $b");
  assert.equal(formatArgs(["$b // why", "5"], "$a, $b // why\n", "    "), "\n        $b, // why\n        5,\n");
  assert.equal(formatArgs(["1", "2"], "\n  1,\n  2,\n", ""), "\n  1,\n  2,\n");
});
