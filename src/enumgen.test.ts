/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { caseLabel, caseName, caseValue, enumFile, type DesignedCase, type EnumSpec, matchCode, readMatch, splitTopLevel } from "./enumgen.ts";

const spec: EnumSpec = {
  name: "OrderStatus",
  namespace: "App\\Enums",
  backing: "string",
  translated: false,
  contracts: ["label", "color", "icon"],
  cases: [
    { name: "New", value: "new", label: "New", color: "info", icon: "Sparkles" },
    { name: "Shipped", value: "shipped", label: "Shipped", color: "success", icon: "Truck" },
    { name: "Cancelled", value: "cancelled", label: "Cancelled", color: "danger" },
  ],
};

test("names, values, and labels for cases", () => {
  assert.equal(caseName("in progress"), "InProgress");
  assert.equal(caseName("on-hold"), "OnHold");
  assert.equal(caseName("2fa"), "_2fa");
  assert.equal(caseValue("InProgress"), "in_progress");
  assert.equal(caseLabel("InProgress"), "In progress");
});

test("enumFile writes the enum with its contracts, imports, and match methods", () => {
  const code = enumFile(spec, { heroicon: true });
  assert.match(code, /^<\?php\n\nnamespace App\\Enums;\n\nuse BackedEnum;\nuse Filament\\Support\\Contracts\\HasColor;/);
  assert.match(code, /use Filament\\Support\\Icons\\Heroicon;\nuse Illuminate\\Contracts\\Support\\Htmlable;/);
  assert.match(code, /enum OrderStatus: string implements HasLabel, HasColor, HasIcon\n\{\n {4}case New = 'new';\n\n {4}case Shipped = 'shipped';/);
  assert.match(code, /public function getIcon\(\): string \| BackedEnum \| Htmlable \| null\n {4}\{\n {8}return match \(\$this\) \{\n {12}self::New => Heroicon::Sparkles,\n {12}self::Shipped => Heroicon::Truck,\n {12}default => null,\n {8}\};/);
  const pure = enumFile({ ...spec, backing: null, contracts: [] }, { heroicon: true });
  assert.match(pure, /enum OrderStatus\n\{\n {4}case New;\n\n {4}case Shipped;/);
  assert.doesNotMatch(pure, /^use /m);
});

test("readMatch reads plain arms, shared arms, and translated labels, and refuses code", () => {
  assert.deepEqual(readMatch("match ($this) {\n self::New => 'info',\n self::Shipped, self::Delivered => 'success',\n self::Cancelled => 'danger',\n}", "color"), { values: { New: "info", Shipped: "success", Delivered: "success", Cancelled: "danger" }, translated: false });
  assert.deepEqual(readMatch("match ($this) { self::A => __('First, really'), self::B => __('Second') }", "label"), { values: { A: "First, really", B: "Second" }, translated: true });
  assert.equal(readMatch("match ($this) { self::New => FilamentIcon::resolve(X::Y) ?? Heroicon::Sparkles }", "icon"), null);
  assert.deepEqual(readMatch(matchCode(spec, "icon", true), "icon")!.values, { New: "Sparkles", Shipped: "Truck" });
  assert.equal(readMatch("match (true) { default => 'x' }", "label"), null);
  assert.deepEqual(splitTopLevel("a, f(b, c), 'd, e'"), ["a", "f(b, c)", "'d, e'"]);
});

test("readEnum and enumEdits change an enum in place", async () => {
  const { readEnum, enumEdits } = await import("./enumgen.ts");
  const { applyEdits } = await import("./phpcode.ts");
  const { fixture } = await import("./designerfixture.ts");
  const f = fixture("OrderStatusEnum");
  const read = readEnum(f.text, f.outline)!;
  assert.equal(read.spec.backing, "string");
  assert.deepEqual(read.spec.cases.map((c) => [c.name, c.value, c.label, c.color]), [["New", "new", "New", "info"], ["Processing", "processing", "Processing", "warning"], ["Shipped", "shipped", "Shipped", "success"], ["Delivered", "delivered", "Delivered", "success"], ["Cancelled", "cancelled", "Cancelled", "danger"]]);
  assert.deepEqual(read.readable, { label: true, color: true, icon: false, description: true });
  const cases: DesignedCase[] = read.spec.cases.map((c) => ({ ...c, original: c.name }));
  cases[4] = { ...cases[4], name: "Canceled", label: "Canceled" };
  cases.push({ name: "Refunded", value: "refunded", label: "Refunded", color: "gray" });
  const out = applyEdits(f.text, enumEdits(f.text, f.outline, read, { cases, contracts: ["label", "color", "icon"], translated: false }, { heroicon: true }));
  assert.match(out, /case Canceled = 'cancelled';\n\n {4}case Refunded = 'refunded';\n\n {4}public function getLabel/);
  assert.match(out, /self::Canceled => 'Canceled',\n {12}self::Refunded => 'Refunded',/);
  assert.match(out, /self::Refunded => 'gray',/);
  assert.match(out, /self::Shipped, self::Delivered => 'success',/);
  // A case without a color gets `default => null`, and the return type allows it.
  cases[5] = { ...cases[5], color: undefined };
  const out2 = applyEdits(f.text, enumEdits(f.text, f.outline, read, { cases, contracts: ["label", "color", "icon"], translated: false }, { heroicon: true }));
  assert.match(out2, /getColor\(\): string \| array \| null\n/);
  assert.match(out2, /default => null,/);
  // The icon method can't be read, so it stays, with the renamed case's reference updated.
  assert.match(out, /self::Canceled => FilamentIcon::resolve\(DemoIconAlias::ENUMS_ORDER_STATUS_CANCELLED\) \?\? Heroicon::XCircle,/);
  const noColor = applyEdits(f.text, enumEdits(f.text, f.outline, read, { cases: read.spec.cases, contracts: ["label", "icon"], translated: false }, { heroicon: true }));
  assert.doesNotMatch(noColor, /getColor/);
  assert.match(noColor, /enum OrderStatus: string implements HasIcon, HasLabel\n/);
  const withDescription = applyEdits(f.text, enumEdits(f.text, f.outline, read, { cases: read.spec.cases.map((c) => ({ ...c, description: `${c.name} orders` })), contracts: ["label", "color", "icon", "description"], translated: false }, { heroicon: true }));
  assert.match(withDescription, /implements HasColor, HasIcon, HasLabel, HasDescription/);
  assert.match(withDescription, /use Filament\\Support\\Contracts\\HasDescription;/);
  assert.match(withDescription, /public function getDescription\(\): string \| Htmlable \| null\n {4}\{\n {8}return match \(\$this\) \{\n {12}self::New => 'New orders',/);
});
