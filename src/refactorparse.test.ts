/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { classProperties, matchBracket, parseParams, planInline, rewriteArgs, splitTopLevel } from "./refactorparse.ts";

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

test("plans inlining a variable", () => {
  const lines = ["function x() {", "    $total = $a + $b;", "    echo $total;", "    return $total * 2;", "}"];
  assert.deepEqual(planInline(lines, "total", 1, 5), { assignment: 2, assignmentEnd: 2, value: "($a + $b)", uses: [{ line: 3, column: 10 }, { line: 4, column: 12 }] });
  const call = ["$user = User::find(1);", "$user->name;"];
  assert.deepEqual(planInline(call, "user", 1, 2), { assignment: 1, assignmentEnd: 1, value: "User::find(1)", uses: [{ line: 2, column: 1 }] });
  assert.ok("error" in planInline(["$a = 1;", "$a++;"], "a", 1, 2));
  assert.ok("error" in planInline(["$a = 1;", "$a[] = 2;"], "a", 1, 2));
  assert.ok("error" in planInline(["$a = 1;", "$a = 2;"], "a", 1, 2));
  assert.ok("error" in planInline(["echo $a;", "$a = 1;"], "a", 1, 2));
  assert.ok("error" in planInline(["$a = 1;", "foreach ($xs as $a) {}"], "a", 1, 2));
  // An assignment over several lines, with a ";" inside a closure and a string.
  const chain = ["$posts = Post::query()", "    ->where('t', ';')", "    ->get(); // all", "return $posts;"];
  assert.deepEqual(planInline(chain, "posts", 1, 4), { assignment: 1, assignmentEnd: 3, value: "Post::query()\n    ->where('t', ';')\n    ->get()", uses: [{ line: 4, column: 8 }] });
  const closure = ["$f = function () {", "    return 1;", "};", "$f();"];
  assert.equal((planInline(closure, "f", 1, 4) as { assignmentEnd: number }).assignmentEnd, 3);
  assert.ok("error" in planInline(["$a = 1; $b = 2;", "echo $a;"], "a", 1, 2));
  assert.ok("error" in planInline(["$a = foo(", "echo $a;"], "a", 1, 2));
  // $ab isn't $a.
  assert.deepEqual(planInline(["$a = 1;", "$ab = $a;"], "a", 1, 2), { assignment: 1, assignmentEnd: 1, value: "1", uses: [{ line: 2, column: 7 }] });
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
