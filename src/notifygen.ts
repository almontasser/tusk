// Notifications for the notifications designer: a notification class's channels (`via()`), the bell notification
// Filament saves in the database (`toDatabase()`), and the email (`toMail()`), read from their code and changed with
// small edits at the ranges read, and a new notification's file. Texts take the record's fields as `{column}` or
// `{relation.column}` placeholders, written as `{$this->record->column}` in a string, or as `__()` replacements when
// the text is translated. No editor imports, so Node tests it.
import { type ArrayNode, type ChainNode, type Edit, type OClass, type OMethod, type PCall, type PNode, addMember, findCall, indentCode, insertItem, lineIndent, methodNamed, phpFile, phpString, removeCall, removeItem, setCall } from "./phpcode.ts";

export const FILAMENT_NOTIFICATION = "Filament\\Notifications\\Notification";
export const MAIL_MESSAGE = "Illuminate\\Notifications\\Messages\\MailMessage";
export const ACTION = "Filament\\Actions\\Action";
export const HEROICON = "Filament\\Support\\Icons\\Heroicon";

// ---- Texts ----

/** A text with placeholders such as `{number}`, and whether it's written with `__()`. */
export type Text = { template: string; translated: boolean };

const FIELD = /\{([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\}/g;

/** The record's fields a template names, in order, once each. */
export const fieldsOf = (template: string) => [...new Set([...template.matchAll(FIELD)].map((m) => m[1]))];

/** A template with each placeholder replaced by `value(field)`, for previews. */
export const fillText = (template: string, value: (field: string) => string) => template.replace(FIELD, (_, f: string) => value(f));

/** `$this->record->customer?->name` for `customer.name`. */
const access = (rec: string, field: string) => `${rec}->${field.split(".").join("?->")}`;

/** A text as PHP. `rec` is the record's property, such as `$this->record`, or null when there's none to name. */
export function textCode(t: Text, rec: string | null): string {
  const fields = rec ? fieldsOf(t.template) : [];
  if (t.translated) {
    const key = (f: string) => f.replace(/\./g, "_");
    const text = rec ? t.template.replace(FIELD, (_, f: string) => `:${key(f)}`) : t.template;
    return fields.length ? `__(${phpString(text)}, [${fields.map((f) => `${phpString(key(f))} => ${access(rec!, f)}`).join(", ")}])` : `__(${phpString(text)})`;
  }
  if (!fields.length) return phpString(t.template);
  const parts = t.template.split(FIELD);
  // split() with a group alternates text and field names.
  return `"${parts.map((p, i) => (i % 2 ? `{${access(rec!, p)}}` : p.replace(/[\\"$]/g, "\\$&"))).join("")}"`;
}

const unquote = (s: string) => s.replace(/\\(['\\])/g, "$1");

/** The field `$this->record->customer?->name` names (`customer.name`), or null for other code. */
function fieldOf(code: string, rec: string | null): string | null {
  if (!rec || !code.startsWith(`${rec}->`)) return null;
  const rest = code.slice(rec.length + 2);
  return /^\w+(?:\??->\w+)*$/.test(rest) ? rest.split(/\??->/).join(".") : null;
}

/** Reads a text `textCode` writes, with any layout, or null for other code, such as a concatenation. */
export function readText(code: string, rec: string | null): Text | null {
  const c = code.trim();
  let m = /^'((?:[^'\\]|\\.)*)'$/s.exec(c);
  if (m) return { template: unquote(m[1]), translated: false };
  m = /^"((?:[^"\\]|\\.)*)"$/s.exec(c);
  if (m) {
    const body = m[1];
    let out = "";
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === "\\") {
        const next = body[++i];
        if (!/[\\"$]/.test(next ?? "")) return null;
        out += next;
      } else if (ch === "{" && body[i + 1] === "$") {
        const end = body.indexOf("}", i);
        const field = end > 0 ? fieldOf(body.slice(i + 1, end), rec) : null;
        if (!field) return null;
        out += `{${field}}`;
        i = end;
      } else if (ch === "$") return null;
      else out += ch;
    }
    return { template: out, translated: false };
  }
  m = /^__\(\s*'((?:[^'\\]|\\.)*)'\s*(?:,\s*\[([\s\S]*)\]\s*)?,?\s*\)$/.exec(c);
  if (m) {
    let template = unquote(m[1]);
    let rest = m[2] ?? "";
    const keys: [string, string][] = [];
    while (rest.trim()) {
      const e = /^\s*'(\w+)'\s*=>\s*(\$[\w>?-]+)\s*(?:,|$)/.exec(rest);
      const field = e && fieldOf(e[2].replace(/\s+/g, ""), rec);
      if (!e || !field) return null;
      keys.push([e[1], field]);
      rest = rest.slice(e[0].length);
    }
    // Laravel replaces longer keys first, so `:name_full` isn't read as `:name`.
    for (const [k, f] of keys.sort((a, b) => b[0].length - a[0].length)) template = template.split(`:${k}`).join(`{${f}}`);
    return { template, translated: true };
  }
  return null;
}

// ---- The record ----

/** The property that holds the record the constructor takes (`public Order $record`): `$this->record`. */
export function recordOf(cls: OClass): string | null {
  const p = methodNamed(cls, "__construct")?.params[0];
  return p ? `$this->${p.name.replace(/^\$/, "")}` : null;
}

// ---- Channels ----

export const CHANNELS: [string, string][] = [
  ["database", "The panel's bell"],
  ["mail", "Email"],
];

/** `via()`'s channels when it returns a list of names, or null with the code that decides them. */
export function readChannels(cls: OClass): { arr: ArrayNode; channels: string[] } | { code: PNode | null } {
  const m = methodNamed(cls, "via");
  const r = m?.returns.length === 1 ? m.returns[0] : null;
  if (r?.kind === "array" && r.items.every((i) => !i.key && i.value.kind === "string" && !i.value.interpolated)) return { arr: r, channels: r.items.map((i) => (i.value as { value: string }).value) };
  return { code: r ?? null };
}

/** Adds the method a channel needs (`toDatabase()` or `toMail()`) when the class lacks it, with `title`. */
export function addChannelMethod(text: string, cls: OClass, channel: string, title: string): Edit[] {
  const rec = recordOf(cls);
  const t = { template: title, translated: false };
  if (channel === "database" && !methodNamed(cls, "toDatabase") && !methodNamed(cls, "toArray")) return [addMember(text, cls, databaseMethod(bellCode({ title: t, body: null, buttons: [] }, rec)))];
  if (channel === "mail" && !methodNamed(cls, "toMail")) return [addMember(text, cls, mailMethod(mailCode({ subject: t, lines: [], button: null }, rec)))];
  return [];
}

/** Turns a channel on or off. Turning one on adds its method when the class lacks it; turning it off keeps it. */
export function channelEdits(text: string, cls: OClass, arr: ArrayNode, channel: string, on: boolean, title: string): Edit[] {
  const index = arr.items.findIndex((i) => i.value.kind === "string" && i.value.value === channel);
  if (!on) return index >= 0 ? [removeItem(text, arr, index)] : [];
  if (index >= 0) return [];
  return [insertItem(text, arr, arr.items.length, phpString(channel)), ...addChannelMethod(text, cls, channel, title)];
}

// ---- Links ----

/** Where a button goes: a page of a resource (with the record for view and edit), or a URL. */
export type Target = { kind: "page"; resource: string; page: string } | { kind: "url"; url: string };

const RECORD_PAGES = new Set(["view", "edit"]);

export function targetCode(t: Target, rec: string | null): string {
  if (t.kind === "url") return phpString(t.url);
  const R = `{{${t.resource}}}`;
  if (RECORD_PAGES.has(t.page) && rec) return `${R}::getUrl(${phpString(t.page)}, ['record' => ${rec}])`;
  return t.page === "index" ? `${R}::getUrl()` : `${R}::getUrl(${phpString(t.page)})`;
}

/** Reads a target `targetCode` writes, or null for other code. The resource is as the outline resolved it. */
export function readTarget(node: PNode | undefined, text: string, rec: string | null): Target | null {
  if (!node) return null;
  if (node.kind === "string" && !node.interpolated) return { kind: "url", url: node.value };
  if (node.kind !== "static" || node.method !== "getUrl") return null;
  const [page, params, ...more] = node.args.items;
  if (more.length || page?.name || params?.name) return null;
  if (!page) return { kind: "page", resource: node.class, page: "index" };
  if (page.value.kind !== "string" || page.value.interpolated) return null;
  const name = page.value.value;
  if (!params) return RECORD_PAGES.has(name) ? null : { kind: "page", resource: node.class, page: name };
  const p = params.value;
  const only = p.kind === "array" && p.items.length === 1 ? p.items[0] : null;
  const ok = only?.key?.kind === "string" && only.key.value === "record" && rec && text.slice(only.value.span[0], only.value.span[1]).replace(/\s+/g, "") === rec;
  return ok ? { kind: "page", resource: node.class, page: name } : null;
}

// ---- Chains ----

/** A text argument: its node (null when the call isn't there) and its text (null when it's other code). */
export type Slot = { node: PNode | null; text: Text | null };

const slot = (text: string, node: PNode | undefined, rec: string | null): Slot => ({ node: node ?? null, text: node ? readText(text.slice(node.span[0], node.span[1]), rec) : null });

/**
 * Adds a call at position `index` of a chain: after the call before it, or after the chain's start. A chain written
 * one call per line gets it on a line of its own.
 */
export function insertCall(text: string, chain: ChainNode, index: number, name: string, args: string): Edit {
  const calls = chain.calls;
  const at = index > 0 ? calls[index - 1].span[1] : chain.base.span[1];
  const multiline = calls.length > 0 && text.slice(chain.base.span[1], calls[0].span[0]).includes("\n");
  const indent = multiline ? lineIndent(text, calls[0].span[0]) : lineIndent(text, chain.span[0]);
  return { start: at, end: at, text: multiline ? `\n${indent}->${name}(${indentCode(args, indent)})` : `->${name}(${indentCode(args, indent)})` };
}

/** The order Filament's docs write a notification's calls in, which new calls follow. */
const BELL_ORDER = ["title", "body", "icon", "status", "success", "info", "warning", "danger", "actions"];

/**
 * Sets a call's arguments, or adds it after the calls that come before it in `BELL_ORDER`, and always before the
 * chain's last call, `getDatabaseMessage()`.
 */
function setBefore(text: string, chain: ChainNode, name: string, args: string): Edit {
  if (findCall(chain, name)) return setCall(text, chain, name, args);
  const earlier = new Set(BELL_ORDER.slice(0, Math.max(BELL_ORDER.indexOf(name), 0)));
  let last = -1;
  chain.calls.slice(0, -1).forEach((c, i) => earlier.has(c.name) && (last = i));
  return insertCall(text, chain, last >= 0 ? last + 1 : name === "title" ? 0 : chain.calls.length - 1, name, args);
}

// ---- The bell ----

export const STATUSES: [string, string][] = [
  ["", "None"],
  ["success", "Success"],
  ["info", "Info"],
  ["warning", "Warning"],
  ["danger", "Danger"],
];
const STATUS_CALLS = ["status", "success", "info", "warning", "danger"];

export type ButtonRead = { index: number; node: PNode; name: string | null; label: Slot; url: { node: PNode | null; target: Target | null }; markAsRead: boolean; other: PCall[] };

export type BellRead = {
  method: OMethod;
  chain: ChainNode;
  title: Slot;
  body: Slot;
  icon: PNode | null;
  /** `success`, `danger`, and so on, "" for none, or null when it's code. */
  status: string | null;
  /** The buttons' array, or the code `actions()` takes when it isn't one. */
  actions: { arr: ArrayNode; buttons: ButtonRead[] } | { code: PNode } | null;
  /** Calls the designer doesn't write, kept as they are. */
  other: PCall[];
};

const KNOWN_BELL = new Set(["title", "body", "icon", "actions", "getDatabaseMessage", ...STATUS_CALLS]);
const KNOWN_BUTTON = new Set(["label", "url", "markAsRead"]);

/** Reads a button in `actions([...])`: `Action::make('view')->label(…)->url(…)->markAsRead()`. */
function readButton(text: string, node: PNode, index: number, rec: string | null): ButtonRead | null {
  const base = node.kind === "chain" ? node.base : node;
  if (base.kind !== "static" || base.method !== "make" || !/(^|\\)Action$/.test(base.class)) return null;
  const calls = node.kind === "chain" ? node.calls : [];
  const name = base.args.items[0]?.value;
  const url = findCall(node, "url")?.args.items[0]?.value;
  const mark = findCall(node, "markAsRead");
  return {
    index,
    node,
    name: name?.kind === "string" && !name.interpolated ? name.value : null,
    label: slot(text, findCall(node, "label")?.args.items[0]?.value, rec),
    url: { node: url ?? null, target: readTarget(url, text, rec) },
    markAsRead: !!mark && !(mark.args.items[0]?.value.kind === "bool" && !mark.args.items[0].value.value),
    other: calls.filter((c) => !KNOWN_BUTTON.has(c.name)),
  };
}

/**
 * The bell notification in `toDatabase()` (or `toArray()`): `Notification::make()->…->getDatabaseMessage()`. Null
 * when the class has neither method; `{ code }` when the method returns something else.
 */
export function readBell(text: string, cls: OClass, rec: string | null): BellRead | { code: OMethod } | null {
  const method = methodNamed(cls, "toDatabase") ?? methodNamed(cls, "toArray");
  if (!method) return null;
  const r = method.returns.length === 1 ? method.returns[0] : null;
  const ok = r?.kind === "chain" && r.base.kind === "static" && r.base.class === FILAMENT_NOTIFICATION && r.base.method === "make" && r.calls.at(-1)?.name === "getDatabaseMessage";
  if (!ok) return { code: method };
  const chain = r as ChainNode;
  const arg = (name: string) => findCall(chain, name)?.args.items[0]?.value;
  const st = [...chain.calls].reverse().find((c) => STATUS_CALLS.includes(c.name));
  const stArg = st?.args.items[0]?.value;
  const status = !st ? "" : st.name !== "status" ? st.name : stArg?.kind === "string" && !stArg.interpolated ? stArg.value : null;
  const actions = arg("actions");
  let read: BellRead["actions"] = null;
  if (actions?.kind === "array") {
    const buttons = actions.items.map((i, n) => (i.spread || i.key ? null : readButton(text, i.value, n, rec)));
    read = buttons.every(Boolean) ? { arr: actions, buttons: buttons as ButtonRead[] } : { code: actions };
  } else if (actions) read = { code: actions };
  return { method, chain, title: slot(text, arg("title"), rec), body: slot(text, arg("body"), rec), icon: arg("icon") ?? null, status, actions: read, other: chain.calls.filter((c) => !KNOWN_BELL.has(c.name)) };
}

/** Sets a call of the bell notification, or removes it with null. */
export function bellCallEdits(text: string, bell: BellRead, name: string, args: string | null): Edit[] {
  const existing = findCall(bell.chain, name);
  if (args === null) return existing ? [removeCall(bell.chain, existing)] : [];
  return [setBefore(text, bell.chain, name, args)];
}

/** Sets the status (`->success()` and the like), replacing the call that set it, or removes it with "". */
export function statusEdits(text: string, bell: BellRead, status: string): Edit[] {
  const calls = bell.chain.calls.filter((c) => STATUS_CALLS.includes(c.name));
  const edits = calls.map((c) => removeCall(bell.chain, c));
  if (status) {
    if (calls.length) {
      // In place of the last one, so the chain keeps its order.
      const last = calls.at(-1)!;
      edits.pop();
      edits.push({ start: last.nameSpan[0], end: last.args.close + 1, text: `${status}()` });
    } else edits.push(setBefore(text, bell.chain, status, ""));
  }
  return edits;
}

export type Button = { name: string; label: Text; target: Target | null; markAsRead: boolean };

export function buttonCode(b: Button, rec: string | null): string {
  let code = `{{${ACTION}}}::make(${phpString(b.name)})\n    ->label(${textCode(b.label, rec)})`;
  if (b.target) code += `\n    ->url(${targetCode(b.target, rec)})`;
  if (b.markAsRead) code += "\n    ->markAsRead()";
  return code;
}

/** Adds a button, with `actions([...])` when the notification has none. */
export function addButtonEdits(text: string, bell: BellRead, b: Button, rec: string | null): Edit[] {
  const code = buttonCode(b, rec);
  if (bell.actions && "arr" in bell.actions) return [insertItem(text, bell.actions.arr, bell.actions.arr.items.length, code)];
  if (bell.actions) return [];
  return [setBefore(text, bell.chain, "actions", `[\n    ${indentCode(code, "    ")},\n]`)];
}

/** Removes a button, and `actions()` with the last one. */
export function removeButtonEdits(text: string, bell: BellRead, index: number): Edit[] {
  if (!bell.actions || !("arr" in bell.actions)) return [];
  if (bell.actions.arr.items.length === 1) return bellCallEdits(text, bell, "actions", null);
  return [removeItem(text, bell.actions.arr, index)];
}

/** Sets a call on a button, or removes it with null. */
export function buttonCallEdits(text: string, b: ButtonRead, name: string, args: string | null): Edit[] {
  const existing = findCall(b.node, name);
  if (args === null) return existing ? [removeCall(b.node, existing)] : [];
  return [setCall(text, b.node, name, args)];
}

/** A bell notification's chain, as a new `toDatabase()` returns it. */
export function bellCode(o: { title: Text; body: Text | null; buttons: Button[] }, rec: string | null): string {
  let code = `{{${FILAMENT_NOTIFICATION}}}::make()\n    ->title(${textCode(o.title, rec)})`;
  if (o.body) code += `\n    ->body(${textCode(o.body, rec)})`;
  if (o.buttons.length) code += `\n    ->actions([\n${o.buttons.map((b) => `        ${indentCode(buttonCode(b, rec), "        ")},`).join("\n")}\n    ])`;
  return `${code}\n    ->getDatabaseMessage()`;
}

const databaseMethod = (chain: string) => `public function toDatabase(object $notifiable): array\n{\n    return ${indentCode(chain, "    ")};\n}`;

// ---- The email ----

export type MailLine = { call: PCall; index: number; text: Text | null; after: boolean };

export type MailRead = {
  method: OMethod;
  chain: ChainNode;
  subject: Slot;
  greeting: Slot;
  salutation: Slot;
  /** `->line()` calls, before or after the button. */
  lines: MailLine[];
  action: { call: PCall; label: Slot; url: { node: PNode | null; target: Target | null } } | null;
  other: PCall[];
};

const KNOWN_MAIL = new Set(["subject", "greeting", "salutation", "line", "action"]);

/** The email in `toMail()`: `(new MailMessage)->subject(…)->line(…)->action(…)`, or `{ code }` for other code. */
export function readMail(text: string, cls: OClass, rec: string | null): MailRead | { code: OMethod } | null {
  const method = methodNamed(cls, "toMail");
  if (!method) return null;
  const r = method.returns.length === 1 ? method.returns[0] : null;
  if (r?.kind !== "chain" || r.base.kind !== "new" || r.base.class !== MAIL_MESSAGE) return { code: method };
  const chain = r;
  const arg = (name: string) => findCall(chain, name)?.args.items[0]?.value;
  const actionCall = findCall(chain, "action");
  const actionAt = actionCall ? chain.calls.indexOf(actionCall) : Infinity;
  const lines = chain.calls.flatMap((call, index) => (call.name === "line" && call.args.items.length === 1 ? [{ call, index, text: slot(text, call.args.items[0].value, rec).text, after: index > actionAt }] : []));
  const url = actionCall?.args.items[1]?.value;
  return {
    method,
    chain,
    subject: slot(text, arg("subject"), rec),
    greeting: slot(text, arg("greeting"), rec),
    salutation: slot(text, arg("salutation"), rec),
    lines,
    action: actionCall ? { call: actionCall, label: slot(text, actionCall.args.items[0]?.value, rec), url: { node: url ?? null, target: readTarget(url, text, rec) } } : null,
    other: chain.calls.filter((c) => !KNOWN_MAIL.has(c.name) || (c.name === "line" && c.args.items.length !== 1)),
  };
}

/** Sets the subject, greeting, salutation, or button (`action`), or removes it with null. */
export function mailCallEdits(text: string, mail: MailRead, name: string, args: string | null): Edit[] {
  const existing = findCall(mail.chain, name);
  if (args === null) return existing ? [removeCall(mail.chain, existing)] : [];
  return [setCall(text, mail.chain, name, args)];
}

/** Adds a line at the end of those before the button, or of those after it. */
export function addLineEdits(text: string, mail: MailRead, code: string, after: boolean): Edit[] {
  const side = mail.lines.filter((l) => l.after === after);
  const actionAt = mail.action ? mail.chain.calls.indexOf(mail.action.call) : mail.chain.calls.length;
  const index = side.length ? side.at(-1)!.index + 1 : after ? mail.chain.calls.length : actionAt;
  return [insertCall(text, mail.chain, index, "line", code)];
}

export const removeLineEdits = (mail: MailRead, line: MailLine): Edit[] => [removeCall(mail.chain, line.call)];

/** An email's chain, as a new `toMail()` returns it. */
export function mailCode(o: { subject: Text; lines: Text[]; button: { label: Text; target: Target } | null }, rec: string | null): string {
  let code = `(new {{${MAIL_MESSAGE}}})\n    ->subject(${textCode(o.subject, rec)})`;
  for (const l of o.lines) code += `\n    ->line(${textCode(l, rec)})`;
  if (o.button) code += `\n    ->action(${textCode(o.button.label, rec)}, ${targetCode(o.button.target, rec)})`;
  return code;
}

const mailMethod = (chain: string) => `public function toMail(object $notifiable): {{${MAIL_MESSAGE}}}\n{\n    return ${indentCode(chain, "    ")};\n}`;

// ---- New notifications ----

/**
 * A new notification's file: the record in its constructor (or none), the channels, a bell notification and an email
 * with `title` and `body`, and a button that opens `target`.
 */
export function notificationFile(o: { namespace: string; name: string; record: string | null; channels: string[]; title: Text; body: Text | null; target: Target | null; label: string }): string {
  const rec = o.record ? "$this->record" : null;
  const members: string[] = ["use {{Illuminate\\Bus\\Queueable}};"];
  if (o.record) members.push(`public function __construct(public {{${o.record}}} $record) {}`);
  members.push(`public function via(object $notifiable): array\n{\n    return [${o.channels.map(phpString).join(", ")}];\n}`);
  const label = { template: o.label, translated: false };
  if (o.channels.includes("database")) members.push(databaseMethod(bellCode({ title: o.title, body: o.body, buttons: o.target ? [{ name: "view", label, target: o.target, markAsRead: true }] : [] }, rec)));
  if (o.channels.includes("mail")) members.push(mailMethod(mailCode({ subject: o.title, lines: o.body ? [o.body] : [], button: o.target ? { label, target: o.target } : null }, rec)));
  const body = members.map((m) => `    ${indentCode(m, "    ")}`).join("\n\n");
  return phpFile(o.namespace, `class ${o.name} extends {{Illuminate\\Notifications\\Notification}}\n{\n${body}\n}`);
}

// ---- Previews ----

/** A made-up value for a column, from its name and type, for previews. */
export function sampleValue(column: string, type = ""): string {
  const c = column.toLowerCase().split(".").pop()!;
  const samples: [RegExp, string][] = [
    [/^id$|_id$/, "1042"],
    [/^(name|full_name|display_name)$/, "Jane Cooper"],
    [/email/, "jane@example.com"],
    [/title|subject|headline/, "Spring launch"],
    [/number|reference|code|sku/, "INV-1042"],
    [/status|state/, "shipped"],
    [/price|amount|total|cost/, "120.00"],
    [/_at$|date/, "Oct 1, 2026"],
    [/phone|mobile/, "+1 555 0100"],
    [/url|link|website/, "https://example.com"],
    [/slug/, "spring-launch"],
  ];
  for (const [re, v] of samples) if (re.test(c)) return v;
  if (/bool|tinyint\(1\)/i.test(type)) return "Yes";
  if (/int|dec|float|double|numeric/i.test(type)) return "42";
  return c.replace(/_/g, " ");
}
