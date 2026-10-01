import assert from "node:assert/strict";
import { test } from "node:test";
import { readSend, type Send, sendCode } from "./notifysend.ts";

const plain = (code: string) => code.replace(/\{\{[\w\\]*?(\w+)\}\}/g, "$1");
const resolve = (name: string) => `App\\Notifications\\${name}`;

test("sends round-trip through their code", () => {
  const sends: Send[] = [
    { notification: "App\\Notifications\\OrderShipped", recipient: { kind: "users" }, withRecord: true },
    { notification: "App\\Notifications\\OrderShipped", recipient: { kind: "role", role: "admin's" }, withRecord: true },
    { notification: "App\\Notifications\\OrderShipped", recipient: { kind: "related", relation: "customer" }, withRecord: true },
    { notification: "App\\Notifications\\WeeklyReport", recipient: { kind: "current" }, withRecord: false },
    { notification: "App\\Notifications\\OrderShipped", recipient: { kind: "address", email: "ops@example.com" }, withRecord: true },
  ];
  for (const s of sends) assert.deepEqual(readSend(plain(sendCode(s, "App\\Models\\User")), resolve), s);
  const order: Send = { notification: "App\\Notifications\\OrderShipped", recipient: { kind: "related", relation: "customer" }, withRecord: true };
  assert.equal(plain(sendCode(order, "App\\Models\\User", "$order")), "$order->customer?->notify(new OrderShipped($order));");
  assert.deepEqual(readSend("$order->customer?->notify(new OrderShipped($order));", resolve, "$order"), order);
});

test("reads other layouts and rejects other code", () => {
  assert.deepEqual(readSend("Notification::send(\n    User::role('admin')\n        ->get(),\n    new OrderShipped($record),\n);", resolve), {
    notification: "App\\Notifications\\OrderShipped",
    recipient: { kind: "role", role: "admin" },
    withRecord: true,
  });
  assert.deepEqual(readSend("Auth::user()->notify(new \\App\\Notifications\\Hi());", resolve)?.recipient, { kind: "current" });
  assert.equal(readSend("Notification::send(User::where('a', 1)->get(), new X($record));", resolve), null);
  assert.equal(readSend("$record->customer?->notify(new X($other));", resolve), null);
});
