import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdits, cantPull, classBody, classNameRefs, dependencies, importEdits, interfaceCandidates, memberRefs, needsProtected, planExtractInterface, planPullUp, pullUpProblems, requalify, typeNameProblem, type Member } from "./classparse.ts";
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
  assert.deepEqual([...r.imports.values()], ["Illuminate\\Support\\Facades\\Log", "App\\Services\\Receipt"]);
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
    "warning: charge() uses CURRENCY, which stays in StripeGateway. [Pull CURRENCY up too]",
    "warning: charge() uses $retries, which stays in StripeGateway. [Pull $retries up too]",
    "warning: charge() uses attempt(), which stays in StripeGateway. [Pull attempt() up too]",
  ]);
  assert.deepEqual(check(pick("charge", "CURRENCY", "retries", "attempt")), ["warning: attempt() calls parent::attempt(), which in Gateway means its own parent's."]);
  assert.deepEqual(check(pick("charge"), pick("charge")), [
    "warning: Gateway becomes abstract, so new Gateway() stops working.",
    "warning: PaypalGateway extends Gateway but doesn't declare charge(), so it would have to.",
  ]);
  assert.deepEqual(check(pick("boot")), []);
  const clash = { ...target, members: [{ ...pick("charge")[0] }] };
  assert.equal(check(pick("charge"), [], clash)[0], "error: Gateway already declares charge().");
  assert.equal(cantPull(b.members.find((m) => m.name === "client")!, "class"), "Declared in the constructor. Declare it as a property first to move it.");
  assert.equal(cantPull(pick("fees")[0], "interface"), "Interfaces can't declare properties.");
  assert.equal(cantPull(pick("attempt")[0], "interface"), "Interfaces declare only public members.");
  assert.deepEqual(interfaceCandidates(b.members).map((m) => m.name), ["CURRENCY", "charge"]);
});
