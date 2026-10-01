// Sending a notification: who gets it, written as the one statement that sends it. Automations, scheduled tasks, and
// action buttons share it, so a sent notification reads the same wherever it's written. Classes are `{{Fqn}}`
// placeholders the caller fills with `Imports` (src/codeapply.ts does). A notification takes the record it's about
// as its constructor's one argument, or none. No editor imports, so Node tests it.
import { phpString } from "./phpcode.ts";
import { squash } from "./widgetgen.ts";

export type Recipient =
  /** Every user. */
  | { kind: "users" }
  /** The users with a spatie/laravel-permission role. */
  | { kind: "role"; role: string }
  /** A user the record points at through a relationship, such as an order's `customer`. */
  | { kind: "related"; relation: string }
  /** The signed-in user. */
  | { kind: "current" }
  /** An email address that isn't a user's, sent by mail only. */
  | { kind: "address"; email: string };

/** A notification class sent to recipients, about the record in `$record` (or the variable the caller names) or none. */
export type Send = { notification: string; recipient: Recipient; withRecord: boolean };

/** The recipient kinds, with their labels, for pickers. */
export const RECIPIENTS: [Recipient["kind"], string][] = [
  ["users", "Every user"],
  ["role", "Users with a role"],
  ["related", "The record's user"],
  ["current", "The signed-in user"],
  ["address", "An email address"],
];

/** The statement that sends `s`. `record` is the variable that holds the record, such as `$order` in an observer. */
export function sendCode(s: Send, userModel: string, record = "$record"): string {
  const made = `new {{${s.notification.replace(/^\\/, "")}}}(${s.withRecord ? record : ""})`;
  const user = `{{${userModel.replace(/^\\/, "")}}}`;
  const facade = "{{Illuminate\\Support\\Facades\\Notification}}";
  const r = s.recipient;
  switch (r.kind) {
    case "users":
      return `${facade}::send(${user}::all(), ${made});`;
    case "role":
      return `${facade}::send(${user}::role(${phpString(r.role)})->get(), ${made});`;
    case "related":
      return `${record}->${r.relation}?->notify(${made});`;
    case "current":
      return `auth()->user()?->notify(${made});`;
    case "address":
      return `${facade}::route('mail', ${phpString(r.email)})->notify(${made});`;
  }
}

const STR = String.raw`'((?:[^'\\]|\\.)*)'`;
const unquote = (s: string) => s.replace(/\\(['\\])/g, "$1");

/**
 * Reads a statement `sendCode` writes, with any layout. `resolve` turns a class name as the file spells it into its
 * full name (through the file's imports); `record` is the record's variable. Anything else is null.
 */
export function readSend(code: string, resolve: (name: string) => string, record = "$record"): Send | null {
  const c = squash(code.trim()).replace(/;$/, "");
  const NEW = String.raw`new (\\?[A-Za-z_][\w\\]*)\((\$\w+)?\)`;
  const rec = record.replace(/\$/g, "\\$");
  const forms: [RegExp, (x: RegExpExecArray) => Recipient][] = [
    [new RegExp(String.raw`^\\?[\w\\]*Notification::send\(\\?[\w\\]+::all\(\), ${NEW}\)$`), () => ({ kind: "users" })],
    [new RegExp(String.raw`^\\?[\w\\]*Notification::send\(\\?[\w\\]+::role\(${STR}\)->get\(\), ${NEW}\)$`), (x) => ({ kind: "role", role: unquote(x[1]) })],
    [new RegExp(String.raw`^${rec}->(\w+)\??->notify\(${NEW}\)$`), (x) => ({ kind: "related", relation: x[1] })],
    [new RegExp(String.raw`^(?:auth\(\)->user\(\)|\\?(?:[\w\\]*\\)?Auth::user\(\))\??->notify\(${NEW}\)$`), () => ({ kind: "current" })],
    [new RegExp(String.raw`^\\?[\w\\]*Notification::route\('mail', ${STR}\)->notify\(${NEW}\)$`), (x) => ({ kind: "address", email: unquote(x[1]) })],
  ];
  for (const [re, recipient] of forms) {
    const x = re.exec(c);
    if (!x) continue;
    const arg = x[x.length - 1];
    if (arg && arg !== record) return null;
    const cls = x[x.length - 2];
    return { notification: cls.startsWith("\\") ? cls.slice(1) : resolve(cls), recipient: recipient(x), withRecord: !!arg };
  }
  return null;
}
