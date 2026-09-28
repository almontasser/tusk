import assert from "node:assert/strict";
import { test } from "node:test";
import { type Behavior, behaviorCode, readBehavior, type Scope, valueCode } from "./filamentactions.ts";

const fill = (code: string) => code.replace(/\{\{([\w\\]+)\}\}/g, (_, f: string) => f.slice(f.lastIndexOf("\\") + 1));

test("behaviors round-trip through their code", () => {
  const cases: [Behavior, Scope][] = [
    [{ kind: "update" }, "record"],
    [{ kind: "update", notify: "Saved" }, "records"],
    [{ kind: "set", column: "status", value: "paid" }, "record"],
    [{ kind: "set", column: "is_active", value: "false", notify: "Deactivated" }, "records"],
    [{ kind: "set", column: "priority", value: "3" }, "record"],
    [{ kind: "delete" }, "record"],
    [{ kind: "create", notify: "Created" }, "none"],
  ];
  for (const [b, scope] of cases) {
    const code = fill(behaviorCode(b, scope, "App\\Models\\Order")!);
    const back = readBehavior(code);
    assert.deepEqual({ notify: undefined, ...back }, { notify: undefined, ...b }, code);
  }
});

test("behaviorCode writes the closure", () => {
  assert.equal(fill(behaviorCode({ kind: "update", notify: "It's saved" }, "record", "App\\Models\\Order")!), "function (array $data, Order $record): void {\n    $record->update($data);\n\n    Notification::make()\n        ->title('It\\'s saved')\n        ->success()\n        ->send();\n}");
  assert.equal(behaviorCode({ kind: "none" }, "record", null), null);
});

test("readBehavior reads arrow functions and leaves other code custom", () => {
  assert.deepEqual(readBehavior("fn (Order $record) => $record->delete()"), { kind: "delete", notify: undefined });
  assert.deepEqual(readBehavior("fn (array $data) => Order::create($data)"), { kind: "create", notify: undefined });
  assert.equal(readBehavior("function (Order $record) { $record->ship(); }").kind, "custom");
  assert.equal(readBehavior("$this->doIt(...)").kind, "custom");
  assert.equal(readBehavior(null).kind, "none");
});

test("valueCode", () => {
  assert.equal(valueCode("paid"), "'paid'");
  assert.equal(valueCode("12"), "12");
  assert.equal(valueCode("True"), "true");
});
