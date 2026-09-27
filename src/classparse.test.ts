import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdits, bindingEdits, cantPull, classBody, classNameRefs, declaredGlobals, dependencies, functionConstRefs, importEdits, interfaceCandidates, memberRefs, phpMinimum, needsProtected, planExtractInterface, planPullUp, pullUpProblems, requalify, typeHintsFor, typeNameProblem, type Member } from "./classparse.ts";
import { parseTypeDeclarations } from "./phptypes.ts";

const CHILD = `<?php

namespace App\\Services;

use App\\Models\\Invoice;
use App\\Support\\Money;
use Illuminate\\Support\\Facades\\Log;

class StripeGateway extends Gateway implements Refundable
{
    use Macroable;

    public const CURRENCY = 'usd';

    private int $retries = 3;

    /** @var array<string, Money> */
    protected array $fees = [];

    public function __construct(private readonly Client $client, public string $key = 'x')
    {
    }

    /**
     * Charges the invoice.
     */
    #[Deprecated]
    public function charge(Invoice $invoice, ?Money $amount = null): Receipt
    {
        Log::info('charging {x}', ['a' => self::CURRENCY]);
        for ($i = 0; $i < $this->retries; $i++) {
            $this->attempt($invoice);
        }
        return new Receipt($invoice, static fn (Money $m): Money => $m);
    }

    private function attempt(Invoice $invoice): void
    {
        parent::attempt($invoice);
    }

    abstract protected function name(): string;
}
`;

const body = () => classBody(CHILD, parseTypeDeclarations(CHILD)[0].offset)!;
const member = (name: string) => body().members.find((m) => m.name === name)!;

test("reads a class's members", () => {
  const b = body();
  assert.deepEqual(b.members.map((m) => `${m.kind} ${m.name}${m.promoted ? " (promoted)" : ""}`), [
    "trait Macroable", "constant CURRENCY", "property retries", "property fees", "method __construct", "method charge", "method attempt", "method name",
    "property client (promoted)", "property key (promoted)",
  ]);
  assert.equal(b.indent, "    ");
  const charge = member("charge");
  assert.equal(charge.signature, "public function charge(Invoice $invoice, ?Money $amount = null): Receipt");
  assert.ok(CHILD.slice(charge.start).startsWith("/**\n     * Charges"));
  assert.ok(CHILD.slice(charge.end - 1).startsWith("}\n\n    private function attempt"));
  assert.equal(member("retries").visibility, "private");
  assert.equal(member("name").isAbstract, true);
  assert.equal(member("name").bodyStart, -1);
  assert.equal(member("fees").signature, "protected array $fees = []");
});

test("finds what members use, and what must become protected", () => {
  const refs = memberRefs(CHILD.slice(member("charge").start, member("charge").end));
  assert.deepEqual([...refs.properties], ["retries"]);
  assert.deepEqual([...refs.methods], ["attempt"]);
  assert.deepEqual([...refs.constants], ["CURRENCY"]);
  assert.deepEqual([...memberRefs(CHILD.slice(member("attempt").start, member("attempt").end)).parentCalls], ["attempt"]);
  const all = body().members;
  assert.deepEqual(dependencies(CHILD, member("charge"), all).map((m) => m.name), ["CURRENCY", "retries", "attempt"]);
  // Moving attempt() alone: charge() stays and calls it, so it can't stay private in the parent.
  assert.deepEqual(needsProtected(CHILD, [all.find((m) => m.name === "attempt")!], all).map((m) => m.name), ["attempt"]);
  assert.deepEqual(needsProtected(CHILD, all.filter((m) => ["attempt", "charge"].includes(m.name)), all).map((m) => m.name), []);
});

test("finds class names in code, docblocks, and headers", () => {
  const code = CHILD.slice(member("charge").start, member("charge").end);
  const names = classNameRefs(code).map((r) => r.name);
  assert.deepEqual(names, ["Deprecated", "Invoice", "Money", "Receipt", "Log", "Receipt", "Money", "Money"]);
  // Constants in defaults and calls aren't types.
  assert.deepEqual(classNameRefs("public function f(array $a = [A_CONST, B], int $n = PHP_INT_MAX): void { max($a, SOME); }").map((r) => r.name), []);
  assert.deepEqual(classNameRefs("/** @param Collection<int, User>|null $u @throws \\RuntimeException */").map((r) => r.name), ["Collection", "User", "\\RuntimeException"]);
  assert.deepEqual(classNameRefs("try {} catch (A\\B | C $e) { throw new \\LogicException(D::class); }").map((r) => r.name), ["A\\B", "C", "\\LogicException", "D"]);
});

test("rewrites names for another file, importing what it can", () => {
  const to = "<?php\n\nnamespace App\\Billing;\n\nuse App\\Support\\Money;\nuse Other\\Invoice;\n\nclass Gateway\n{\n}\n";
  const r = requalify("function f(Invoice $i, Money $m, Receipt $r, Log $l) {}", CHILD, to);
  // Money is imported the same; Invoice means another class there; Receipt and Log get imported.
  assert.equal(r.code, "function f(\\App\\Models\\Invoice $i, Money $m, Receipt $r, Log $l) {}");
  assert.deepEqual([...r.imports.values()].sort(), ["App\\Services\\Receipt", "Illuminate\\Support\\Facades\\Log"]);
  assert.deepEqual(importEdits(to, [...r.imports.values()]).map((e) => e.text), ["use App\\Services\\Receipt;\n", "use Illuminate\\Support\\Facades\\Log;\n"]);
  const bare = "<?php\n\nnamespace App;\n\nclass A\n{\n}\n";
  assert.equal(applyEdits(bare, importEdits(bare, ["B\\C"])), "<?php\n\nnamespace App;\n\nuse B\\C;\n\nclass A\n{\n}\n");
});

const PARENT = `<?php

namespace App\\Services;

class Gateway
{
    public function boot(): void
    {
    }
}
`;

const pullUp = (names: string[], abstract: string[] = [], target = PARENT, kind: "class" | "interface" = "class") => {
  const b = body();
  const moving = b.members.filter((m) => names.includes(m.name));
  const t = parseTypeDeclarations(target)[0];
  const plan = planPullUp({
    source: CHILD,
    body: b,
    moving,
    abstract: new Set(moving.filter((m) => abstract.includes(m.name))),
    target: { source: target, fqn: t.fqn, kind, offset: t.offset },
    targetBody: classBody(target, t.offset)!,
  });
  return { source: applyEdits(CHILD, plan.source), target: applyEdits(target, plan.target) };
};

test("pulls members up into the parent class", () => {
  const r = pullUp(["retries", "attempt", "CURRENCY"]);
  assert.equal(
    r.target,
    `<?php

namespace App\\Services;

use App\\Models\\Invoice;

class Gateway
{
    public const CURRENCY = 'usd';

    protected int $retries = 3;

    public function boot(): void
    {
    }

    protected function attempt(Invoice $invoice): void
    {
        parent::attempt($invoice);
    }
}
`,
  );
  // attempt() and $retries become protected, since charge() stays and uses them.
  assert.ok(!r.source.includes("private int $retries") && !r.source.includes("function attempt") && !r.source.includes("CURRENCY = "));
  assert.ok(r.source.includes("    protected array $fees = [];\n\n    public function __construct"));
});

test("makes a method abstract in the parent, keeping it in the child", () => {
  const r = pullUp(["charge"], ["charge"]);
  assert.ok(r.target.includes("abstract class Gateway"));
  assert.ok(r.target.includes(`    /**
     * Charges the invoice.
     */
    abstract public function charge(Invoice $invoice, ?Money $amount = null): Receipt;
}`));
  assert.ok(r.target.includes("use App\\Models\\Invoice;\nuse App\\Support\\Money;\n"));
  assert.equal(r.source, CHILD);
});

test("declares methods in an interface, which keeps the class's code", () => {
  const iface = "<?php\n\nnamespace App\\Services;\n\ninterface Refundable {}\n";
  const r = pullUp(["charge"], [], iface, "interface");
  assert.equal(r.source, CHILD);
  assert.ok(r.target.startsWith("<?php\n\nnamespace App\\Services;\n\nuse App\\Models\\Invoice;\nuse App\\Support\\Money;\n\ninterface Refundable {\n    /**"));
  assert.ok(r.target.endsWith("public function charge(Invoice $invoice, ?Money $amount = null): Receipt;\n}\n"));
});

test("drops imports the source no longer uses", () => {
  // Log is used only by charge().
  const r = pullUp(["charge"]);
  assert.ok(r.source.startsWith("<?php\n\nnamespace App\\Services;\n\nuse App\\Models\\Invoice;\nuse App\\Support\\Money;\n\nclass"));
  // With every import unused, the block and one blank line go.
  const lone = "<?php\n\nnamespace A;\n\nuse B\\C;\n\nclass D extends E\n{\n    public function f(C $c) {}\n}\n";
  const lt = parseTypeDeclarations(lone)[0];
  const lb = classBody(lone, lt.offset)!;
  const e = "<?php\n\nnamespace A;\n\nclass E\n{\n}\n";
  const et = parseTypeDeclarations(e)[0];
  const plan = planPullUp({ source: lone, body: lb, moving: lb.members, abstract: new Set(), target: { source: e, fqn: "A\\E", kind: "class", offset: et.offset }, targetBody: classBody(e, et.offset)! });
  assert.equal(applyEdits(lone, plan.source), "<?php\n\nnamespace A;\n\nclass D extends E\n{\n}\n");
  assert.equal(applyEdits(e, plan.target), "<?php\n\nnamespace A;\n\nuse B\\C;\n\nclass E\n{\n    public function f(C $c) {}\n}\n");
});

test("extracts an interface", () => {
  const b = body();
  const t = parseTypeDeclarations(CHILD)[0];
  const plan = planExtractInterface({ source: CHILD, body: b, offset: t.offset, fqn: t.fqn, members: b.members.filter((m) => ["charge", "CURRENCY"].includes(m.name)), name: "PaymentGateway", namespace: "App\\Contracts", docs: true });
  assert.equal(
    plan.file,
    `<?php

namespace App\\Contracts;

use App\\Models\\Invoice;
use App\\Services\\Receipt;
use App\\Support\\Money;

interface PaymentGateway
{
    public const CURRENCY = 'usd';

    /**
     * Charges the invoice.
     */
    public function charge(Invoice $invoice, ?Money $amount = null): Receipt;
}
`,
  );
  const source = applyEdits(CHILD, plan.source);
  assert.ok(source.includes("class StripeGateway extends Gateway implements Refundable, PaymentGateway\n{"));
  assert.ok(source.includes("use App\\Contracts\\PaymentGateway;\nuse App\\Models\\Invoice;"));
  assert.ok(!source.includes("CURRENCY = "));
  // Without an implements list, one is added.
  const plain = "<?php\n\nnamespace App;\n\nfinal class A\n{\n    public function f(): int\n    {\n        return 1;\n    }\n}\n";
  const pt = parseTypeDeclarations(plain)[0];
  const pb = classBody(plain, pt.offset)!;
  const p2 = planExtractInterface({ source: plain, body: pb, offset: pt.offset, fqn: pt.fqn, members: pb.members, name: "HasF", namespace: "App", docs: false });
  assert.ok(applyEdits(plain, p2.source).includes("final class A implements HasF\n{"));
  assert.ok(p2.file.includes("interface HasF\n{\n    public function f(): int;\n}\n"));
});

test("checks names for a new type", () => {
  assert.equal(typeNameProblem("Billable"), null);
  assert.match(typeNameProblem("2Fast")!, /valid/);
  assert.match(typeNameProblem("List")!, /reserved/);
  assert.match(typeNameProblem("")!, /Type a name/);
});

test("removes one of several members on a line without its neighbors", () => {
  const src = "<?php\nclass A { public $a = 1; public $b = 2; }\n";
  const t = parseTypeDeclarations(src)[0];
  const b = classBody(src, t.offset)!;
  const target = "<?php\nclass P {}\n";
  const tt = parseTypeDeclarations(target)[0];
  const plan = planPullUp({ source: src, body: b, moving: [b.members[0] as Member], abstract: new Set(), target: { source: target, fqn: "P", kind: "class", offset: tt.offset }, targetBody: classBody(target, tt.offset)! });
  assert.equal(applyEdits(src, plan.source), "<?php\nclass A { public $b = 2; }\n");
  assert.equal(applyEdits(target, plan.target), "<?php\nclass P {\n    public $a = 1;\n}\n");
});

test("reports what a pull-up would break", () => {
  const b = body();
  const pick = (...names: string[]) => b.members.filter((m) => names.includes(m.name) && !m.promoted);
  const target = { name: "Gateway", kind: "class" as const, members: classBody(PARENT, parseTypeDeclarations(PARENT)[0].offset)!.members, isAbstract: false };
  const check = (moving: Member[], abstract: Member[] = [], t = target) =>
    pullUpProblems({ source: CHILD, sourceName: "StripeGateway", members: b.members, moving, abstract: new Set(abstract), target: t, siblings: [{ name: "PaypalGateway", methods: new Set(["boot"]) }] }).map((p) => `${p.level}: ${p.text}${p.fix ? ` [${p.fix.label}]` : ""}`);
  assert.deepEqual(check(pick("charge")), [
    "warning: charge() uses CURRENCY, which stays in StripeGateway, so Gateway's other subclasses won't have it. [Pull CURRENCY up too]",
    "error: charge() uses $retries, which stays in StripeGateway as private, where Gateway can't reach it. [Pull $retries up too]",
    "error: charge() uses attempt(), which stays in StripeGateway as private, where Gateway can't reach it. [Pull attempt() up too]",
  ]);
  assert.deepEqual(check(pick("charge", "CURRENCY", "retries", "attempt")), ["warning: attempt() calls parent::attempt(), which in Gateway means its own parent's."]);
  assert.deepEqual(check(pick("charge"), pick("charge")), [
    "warning: Gateway becomes abstract, so new Gateway() stops working.",
    "warning: PaypalGateway extends Gateway but doesn't declare charge(), so it would have to.",
  ]);
  assert.deepEqual(check(pick("boot")), []);
  const clash = { ...target, members: [{ ...pick("charge")[0] }] };
  assert.equal(check(pick("charge"), [], clash)[0], "error: Gateway already declares charge().");
  assert.equal(cantPull(b.members.find((m) => m.name === "client")!, "class"), null);
  assert.equal(cantPull(b.members.find((m) => m.name === "client")!, "interface"), "Interfaces can't declare properties.");
  assert.equal(cantPull(pick("fees")[0], "interface"), "Interfaces can't declare properties.");
  assert.equal(cantPull(pick("attempt")[0], "interface"), "Interfaces declare only public members.");
  assert.deepEqual(interfaceCandidates(b.members).map((m) => m.name), ["CURRENCY", "charge"]);
});

test("keeps functions and constants meaning the same in another namespace", () => {
  const from = "<?php\n\nnamespace App\\Services;\n\nuse function Illuminate\\Support\\enum_value;\nuse const App\\Config\\TIMEOUT;\n\nclass A {}\n";
  const to = "<?php\n\nnamespace App\\Billing;\n\nclass B {}\n";
  const globals = { functions: new Set(["app\\services\\helper", "app\\billing\\strlen"]), constants: new Set(["App\\Services\\LIMIT"]) };
  const code = "function f() { return helper(strlen('x'), LIMIT, TIMEOUT, PHP_EOL, enum_value($e), \\count([]), Sub\\run(), $this->helper(), self::LIMIT, new Foo(), E_ALL); }";
  // helper and LIMIT are the source namespace's, strlen means a namespaced one in the target, and imported names
  // lose their import. Global names, methods, class constants, and classes stay.
  const moved = requalify(code, from, to, new Map(), globals);
  assert.equal(
    moved.code,
    "function f() { return \\App\\Services\\helper(\\strlen('x'), \\App\\Services\\LIMIT, \\App\\Config\\TIMEOUT, PHP_EOL, \\Illuminate\\Support\\enum_value($e), \\count([]), \\App\\Services\\Sub\\run(), $this->helper(), self::LIMIT, new Foo(), E_ALL); }",
  );
  assert.deepEqual([...moved.imports.values()], ["App\\Services\\Foo"]);
  // In the same namespace nothing changes.
  const same = "<?php\n\nnamespace App\\Services;\n\nclass C {}\n";
  assert.equal(requalify("function f() { return helper(LIMIT); }", from, same, new Map(), globals).code, "function f() { return helper(LIMIT); }");
  // Named arguments, attributes, declarations, and true/false/null aren't constants or functions.
  assert.deepEqual(functionConstRefs("#[Route('/x', methods: GET)] public function f(): void { g(LIMIT: 1); const X = TRUE; }").map((r) => r.name), ["g"]);
  assert.deepEqual(declaredGlobals("<?php\nnamespace A;\nfunction helper() {}\nconst X = 1, Y = 2;\nclass C { const Z = 3; function m() {} }\n"), { functions: new Set(["a\\helper"]), constants: new Set(["A\\X", "A\\Y"]) });
});

test("pulls a promoted constructor property up as a property the constructor assigns", () => {
  const child = `<?php

namespace App\\Services;

use App\\Http\\Client;

class StripeGateway extends Gateway
{
    public function __construct(
        private readonly Client $client,
        #[SensitiveParameter] protected string $key = 'x',
    ) {
        parent::__construct();
    }

    public function charge(): void
    {
        $this->client->post($this->key);
    }
}
`;
  const t = parseTypeDeclarations(child)[0];
  const b = classBody(child, t.offset)!;
  const promoted = b.members.filter((m) => m.promoted);
  assert.deepEqual(promoted.map((m) => [m.name, m.param!.modifiers, m.param!.type, m.param!.readonly]), [["client", "private readonly", "Client", true], ["key", "protected", "string", false]]);
  const pt = parseTypeDeclarations(PARENT)[0];
  const plan = planPullUp({ source: child, body: b, moving: promoted, abstract: new Set(), target: { source: PARENT, fqn: pt.fqn, kind: "class", offset: pt.offset }, targetBody: classBody(PARENT, pt.offset)! });
  assert.equal(
    applyEdits(child, plan.source),
    child
      .replace("private readonly Client $client", "Client $client")
      .replace("#[SensitiveParameter] protected string $key", "#[SensitiveParameter] string $key")
      .replace("parent::__construct();", "parent::__construct();\n        $this->client = $client;\n        $this->key = $key;"),
  );
  // The private one becomes protected, since the child's constructor sets it.
  assert.ok(applyEdits(PARENT, plan.target).includes("use App\\Http\\Client;\n\nclass Gateway\n{\n    protected readonly Client $client;\n\n    protected string $key;\n\n    public function boot()"));
  // A constructor with an empty body gets the assignments inside it.
  const bare = "<?php\nclass C extends P\n{\n    public function __construct(private int $n) {}\n}\n";
  const bt = parseTypeDeclarations(bare)[0];
  const bb = classBody(bare, bt.offset)!;
  const p = "<?php\nclass P\n{\n}\n";
  const ptt = parseTypeDeclarations(p)[0];
  const plan2 = planPullUp({ source: bare, body: bb, moving: bb.members.filter((m) => m.promoted), abstract: new Set(), target: { source: p, fqn: "P", kind: "class", offset: ptt.offset }, targetBody: classBody(p, ptt.offset)! });
  assert.equal(applyEdits(bare, plan2.source), "<?php\nclass C extends P\n{\n    public function __construct(int $n) {\n        $this->n = $n;\n    }\n}\n");
  // Readonly needs PHP 8.4 to be set from the child.
  const check = (php: [number, number] | null) =>
    pullUpProblems({ source: child, sourceName: "StripeGateway", members: b.members, moving: promoted.slice(0, 1), abstract: new Set(), target: { name: "Gateway", kind: "class", members: [], isAbstract: false }, php }).map((x) => x.level);
  assert.deepEqual([check([8, 2]), check(null), check([8, 4])], [["error"], ["warning"], []]);
  assert.deepEqual(phpMinimum('{"require": {"php": "^8.2|^9.0"}}'), [8, 2]);
  // Moving the constructor itself takes its promoted properties; $client is used by charge(), which stays.
  const ctor = b.members.filter((m) => m.name === "__construct");
  const plan3 = planPullUp({ source: child, body: b, moving: ctor, abstract: new Set(), target: { source: PARENT, fqn: pt.fqn, kind: "class", offset: pt.offset }, targetBody: classBody(PARENT, pt.offset)! });
  assert.ok(applyEdits(PARENT, plan3.target).includes("protected readonly Client $client,\n        #[SensitiveParameter] protected string $key = 'x',"));
  assert.equal(phpMinimum("{}"), null);
});

test("uses an extracted interface in type hints where the class's other members aren't needed", () => {
  const use = { fqn: "App\\Contracts\\PaymentGateway", classFqn: "App\\Services\\StripeGateway", methods: new Set(["charge", "refund"]), constants: new Set(["CURRENCY"]) };
  const src = `<?php

namespace App\\Http\\Controllers;

use App\\Services\\StripeGateway;

class CheckoutController
{
    public function __construct(private StripeGateway $gateway, protected StripeGateway $other)
    {
        $this->gateway = $gateway;
    }

    /**
     * @param StripeGateway $gateway The gateway.
     */
    public function store(StripeGateway $gateway, ?StripeGateway $fallback = null): void
    {
        $gateway->charge($this->order);
        echo $gateway::CURRENCY;
        $fallback->boot();
    }

    public function refund(StripeGateway $gateway): StripeGateway
    {
        $this->gateway->refund();
        return $gateway;
    }

    private StripeGateway $cached;

    public function cache(): void
    {
        $this->cached->charge();
    }
}
`;
  const plan = typeHintsFor(src, use);
  const out = applyEdits(src, plan.edits);
  assert.ok(out.includes("use App\\Contracts\\PaymentGateway;\nuse App\\Services\\StripeGateway;"));
  assert.ok(out.includes("public function __construct(private PaymentGateway $gateway, protected StripeGateway $other)"));
  assert.ok(out.includes("@param PaymentGateway $gateway The gateway."));
  assert.ok(out.includes("public function store(PaymentGateway $gateway, ?StripeGateway $fallback = null): void"));
  assert.ok(out.includes("public function refund(StripeGateway $gateway): StripeGateway"));
  assert.ok(out.includes("private PaymentGateway $cached;"));
  const line = (offset: number) => src.slice(0, offset).split("\n").length;
  assert.deepEqual(plan.skipped.map((s) => `${line(s.offset)}: ${s.reason}`), [
    "9: $other is protected, so code outside the class may use more of it",
    "17: calls $fallback->boot(), which PaymentGateway doesn't declare",
    "24: passes $gateway on, or uses it in a way the interface may not allow",
  ]);
  // With every use replaced, the class's import goes.
  const only = "<?php\n\nnamespace App;\n\nuse App\\Services\\StripeGateway;\n\nfunction pay(StripeGateway $g) { $g->charge(); }\n";
  assert.equal(applyEdits(only, typeHintsFor(only, use).edits), "<?php\n\nnamespace App;\n\nuse App\\Contracts\\PaymentGateway;\n\nfunction pay(PaymentGateway $g) { $g->charge(); }\n");
  // An abstract declaration stays.
  assert.equal(typeHintsFor("<?php\nnamespace App\\Services;\ninterface X { public function f(StripeGateway $g); }\n", use).skipped[0].reason, "an abstract or interface method, whose implementations would have to change too");
});

test("binds the interface in a Laravel service provider", () => {
  const provider = `<?php

namespace App\\Providers;

use Illuminate\\Support\\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }
}
`;
  const out = applyEdits(provider, bindingEdits(provider, "App\\Contracts\\PaymentGateway", "App\\Services\\StripeGateway"));
  assert.ok(out.includes("use App\\Contracts\\PaymentGateway;\nuse App\\Services\\StripeGateway;\nuse Illuminate\\Support\\ServiceProvider;"));
  assert.ok(out.includes("    public function register(): void\n    {\n        $this->app->bind(PaymentGateway::class, StripeGateway::class);\n    }\n"));
  assert.deepEqual(bindingEdits(out, "App\\Contracts\\PaymentGateway", "App\\Services\\StripeGateway"), []);
  const busy = provider.replace("        //\n", "        $this->app->singleton(Foo::class);\n");
  assert.ok(applyEdits(busy, bindingEdits(busy, "App\\Contracts\\PaymentGateway", "App\\Services\\StripeGateway")).includes("    {\n        $this->app->bind(PaymentGateway::class, StripeGateway::class);\n        $this->app->singleton(Foo::class);"));
});
