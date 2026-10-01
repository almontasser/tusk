import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./designerfixture.ts";
import { addButtonEdits, addLineEdits, type BellRead, bellCallEdits, channelEdits, fillText, type MailRead, notificationFile, readBell, readChannels, readMail, readTarget, readText, recordOf, removeButtonEdits, statusEdits, type Target, targetCode, type Text, textCode } from "./notifygen.ts";
import { applyEdits, type OClass } from "./phpcode.ts";

const REC = "$this->record";
const plain = (code: string) => code.replace(/\{\{[\w\\]*?(\w+)\}\}/g, "$1");

test("texts round-trip through their code", () => {
  const texts: Text[] = [
    { template: "Order shipped", translated: false },
    { template: "It's {number}: \"done\" for $5 \\ {customer.name}", translated: false },
    { template: "Order :x {number} by {customer.name}", translated: true },
    { template: "Saved", translated: true },
  ];
  for (const t of texts) assert.deepEqual(readText(textCode(t, REC), REC), t, textCode(t, REC));
  assert.equal(textCode({ template: "Order {number} shipped", translated: false }, REC), '"Order {$this->record->number} shipped"');
  assert.equal(textCode({ template: "Hi {customer.name}", translated: true }, REC), "__('Hi :customer_name', ['customer_name' => $this->record->customer?->name])");
  // Without a record, braces are plain text.
  assert.equal(textCode({ template: "Week {n}", translated: false }, null), "'Week {n}'");
});

test("readText reads other layouts and rejects other code", () => {
  assert.deepEqual(readText("__(\n    'Order :number',\n    [\n        'number' => $this->record->number,\n    ],\n)", REC), { template: "Order {number}", translated: true });
  assert.equal(readText("'Order '.$this->record->number", REC), null);
  assert.equal(readText('"Hi $name"', REC), null);
  assert.equal(readText('"Hi {$this->other->name}"', REC), null);
  assert.equal(readText("__('Hi :name', ['name' => strtoupper($this->record->name)])", REC), null);
  assert.equal(fillText("Order {number} for {customer.name}", (f) => f.toUpperCase()), "Order NUMBER for CUSTOMER.NAME");
});

test("targets round-trip through their code", () => {
  const { text, outline } = fixture("OrderShipped");
  const R = "App\\Filament\\Resources\\Orders\\OrderResource";
  const targets: Target[] = [{ kind: "page", resource: R, page: "view" }, { kind: "page", resource: R, page: "index" }, { kind: "page", resource: R, page: "create" }, { kind: "url", url: "https://example.com/a?b='c'" }];
  for (const t of targets) assert.match(targetCode(t, REC), t.kind === "url" ? /^'/ : /getUrl/);
  const bell = readBell(text, outline.classes[0], REC) as BellRead;
  assert.ok(bell.actions && "arr" in bell.actions);
  assert.deepEqual(bell.actions.buttons[0].url.target, targets[0]);
  assert.equal(readTarget(undefined, text, REC), null);
});

test("reads a notification", () => {
  const { text, outline } = fixture("OrderShipped");
  const cls = outline.classes[0];
  assert.equal(recordOf(cls), REC);
  const ch = readChannels(cls);
  assert.ok("channels" in ch);
  assert.deepEqual(ch.channels, ["database", "mail"]);
  const bell = readBell(text, cls, REC) as BellRead;
  assert.deepEqual(bell.title.text, { template: "Order {number} shipped", translated: true });
  assert.deepEqual(bell.body.text, { template: "Hi {customer.name}, it's on its way.", translated: false });
  assert.equal(bell.status, "success");
  assert.deepEqual(bell.other.map((c) => c.name), ["iconColor"]);
  assert.ok(bell.actions && "arr" in bell.actions);
  const b = bell.actions.buttons[0];
  assert.deepEqual([b.name, b.label.text?.template, b.markAsRead], ["view", "View order", true]);
  const mail = readMail(text, cls, REC) as MailRead;
  assert.equal(mail.subject.text?.template, "Order {number} shipped");
  assert.equal(mail.greeting.text?.template, "Hello!");
  assert.equal(mail.salutation.node, null);
  assert.deepEqual(mail.lines.map((l) => [l.text?.template, l.after]), [["Your order is on its way.", false], ["Thank you for shopping with us.", true]]);
  assert.equal(mail.action?.label.text?.template, "View order");
  assert.deepEqual(mail.other.map((c) => c.name), ["cc"]);
});

test("edits a notification in place", () => {
  const { text, outline } = fixture("OrderShipped");
  const cls = outline.classes[0];
  const bell = readBell(text, cls, REC) as BellRead;
  const mail = readMail(text, cls, REC) as MailRead;
  // A new call goes after the calls that come before it, on its own line.
  let out = applyEdits(text, bellCallEdits(text, { ...bell, chain: { ...bell.chain, calls: bell.chain.calls.filter((c) => c.name !== "body") } }, "body", "'New'"));
  assert.match(out, /->title\(__\('Order :number shipped', \['number' => \$this->record->number\]\)\)\n {12}->body\('New'\)\n {12}->body\("Hi/);
  out = applyEdits(text, statusEdits(text, bell, "danger"));
  assert.match(out, /->icon\(Heroicon::OutlinedTruck\)\n {12}->danger\(\)\n {12}->iconColor/);
  assert.doesNotMatch(applyEdits(text, statusEdits(text, bell, "")), /success/);
  out = applyEdits(text, removeButtonEdits(text, bell, 0));
  assert.doesNotMatch(out, /actions/);
  out = plain(applyEdits(text, addButtonEdits(text, bell, { name: "list", label: { template: "All orders", translated: false }, target: { kind: "page", resource: "App\\X\\OrderResource", page: "index" }, markAsRead: false }, REC)));
  assert.match(out, /->markAsRead\(\),\n {16}Action::make\('list'\)\n {20}->label\('All orders'\)\n {20}->url\(OrderResource::getUrl\(\)\),\n {12}\]\)/);
  // Lines go at the end of their side of the button.
  out = applyEdits(text, addLineEdits(text, mail, "'Before'", false));
  assert.match(out, /on its way\.'\)\n {12}->line\('Before'\)\n {12}->action/);
  out = applyEdits(text, addLineEdits(text, mail, "'After'", true));
  assert.match(out, /with us\.'\)\n {12}->line\('After'\)\n {12}->cc/);
});

test("channels turn on with their method", () => {
  const text = notificationFile({ namespace: "App\\Notifications", name: "WeeklyReport", record: null, channels: ["mail"], title: { template: "Weekly report", translated: false }, body: null, target: null, label: "Open" });
  assert.match(text, /return \['mail'\];/);
  assert.doesNotMatch(text, /__construct|toDatabase/);
  assert.match(text, /->subject\('Weekly report'\);/);
  // A class without toDatabase() gets one when the bell turns on.
  const { text: t2, outline } = fixture("OrderShipped");
  const cls: OClass = { ...outline.classes[0], methods: outline.classes[0].methods.filter((m) => m.name !== "toDatabase") };
  const ch = readChannels(cls);
  assert.ok("arr" in ch);
  const off = applyEdits(t2, channelEdits(t2, cls, ch.arr, "database", false, "x"));
  assert.match(off, /return \['mail'\];/);
  // Turning the bell on, as if via() lacked it, adds toDatabase().
  const arr = { ...ch.arr, items: ch.arr.items.slice(1) };
  const on = plain(applyEdits(t2, channelEdits(t2, cls, arr, "database", true, "Order shipped")));
  assert.match(on, /'mail', 'database'\]/);
  assert.match(on, /public function toDatabase\(object \$notifiable\): array\n    \{\n        return Notification::make\(\)\n            ->title\('Order shipped'\)\n            ->getDatabaseMessage\(\);\n    \}\n\}\n$/);
});
