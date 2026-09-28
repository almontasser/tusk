// What a custom action does when it runs, as the designer offers it: common behaviors written as the closure of
// `->action(...)`, and read back from it, so the inspector can show and change them. Anything else is code the
// designer keeps. No editor imports, so Node tests it.
import { phpString } from "./phpcode.ts";

/** What the action has to work with: the row's record, the selected records, or neither, as on a list page. */
export type Scope = "record" | "records" | "none";

export type Behavior =
  | { kind: "none" }
  /** Saves the form's data to the record, or to each selected record. */
  | { kind: "update"; notify?: string }
  /** Sets one column to a value, such as marking an order paid. */
  | { kind: "set"; column: string; value: string; notify?: string }
  | { kind: "delete"; notify?: string }
  /** Creates a record from the form's data. */
  | { kind: "create"; notify?: string }
  | { kind: "custom" };

export const BEHAVIORS: Record<Scope, [Behavior["kind"], string][]> = {
  record: [["none", "Nothing yet"], ["update", "Save the form to the record"], ["set", "Set a column"], ["delete", "Delete the record"]],
  records: [["none", "Nothing yet"], ["update", "Save the form to each record"], ["set", "Set a column on each"], ["delete", "Delete them"]],
  none: [["none", "Nothing yet"], ["create", "Create a record from the form"]],
};

const NOTIFICATION = "Filament\\Notifications\\Notification";
const COLLECTION = "Illuminate\\Support\\Collection";

/** A value typed in the inspector as PHP: numbers, true, false, and null as they are, anything else as a string. */
export function valueCode(v: string): string {
  const t = v.trim();
  if (/^(true|false|null)$/i.test(t)) return t.toLowerCase();
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  return phpString(v);
}

/**
 * The closure for `->action(...)`, with classes as `{{Fqn}}` for the designer to import. `model` is the record's
 * class, or null to type it as Eloquent's Model.
 */
export function behaviorCode(b: Behavior, scope: Scope, model: string | null): string | null {
  const M = `{{${model ?? "Illuminate\\Database\\Eloquent\\Model"}}}`;
  const each = scope === "records";
  const target = each ? "$records->each" : "$record";
  let params: string[];
  let body: string;
  switch (b.kind) {
    case "update":
      params = ["array $data", each ? `{{${COLLECTION}}} $records` : `${M} $record`];
      body = `${target}->update($data);`;
      break;
    case "set":
      params = [each ? `{{${COLLECTION}}} $records` : `${M} $record`];
      body = `${target}->update([${phpString(b.column)} => ${valueCode(b.value)}]);`;
      break;
    case "delete":
      params = [each ? `{{${COLLECTION}}} $records` : `${M} $record`];
      body = `${target}->delete();`;
      break;
    case "create":
      params = ["array $data"];
      body = `${M}::create($data);`;
      break;
    default:
      return null;
  }
  if (b.notify) body += `\n\n{{${NOTIFICATION}}}::make()\n    ->title(${phpString(b.notify)})\n    ->success()\n    ->send();`;
  return `function (${params.join(", ")}): void {\n    ${body.replace(/\n(?=[^\n])/g, "\n    ")}\n}`;
}

const STRING = String.raw`'(?:[^'\\]|\\.)*'|"(?:[^"\\$]|\\.)*"`;
const unquote = (s: string) => (s.startsWith("'") ? s.slice(1, -1).replace(/\\(['\\])/g, "$1") : s.slice(1, -1).replace(/\\(.)/g, "$1"));

/** Reads what `->action(...)`'s closure does, from its code. Code the presets don't write reads as custom. */
export function readBehavior(code: string | null | undefined): Behavior {
  if (!code) return { kind: "none" };
  const fn = /^(?:static\s+)?function\s*\(([^)]*)\)\s*(?::\s*[\w\\?]+\s*)?(?:use\s*\([^)]*\)\s*)?\{([\s\S]*)\}$/.exec(code.trim());
  const arrow = !fn && /^(?:static\s+)?fn\s*\(([^)]*)\)\s*(?::\s*[\w\\?|]+\s*)?=>\s*([\s\S]+)$/.exec(code.trim());
  const m = fn || arrow;
  if (!m) return { kind: "custom" };
  let body = m[2].trim();
  if (arrow) body += ";";
  // A success notification at the end.
  let notify: string | undefined;
  const n = new RegExp(String.raw`\s*\\?(?:[\w\\]*\\)?Notification::make\(\)\s*->title\((${STRING})\)\s*->success\(\)\s*->send\(\);\s*$`).exec(body);
  if (n) (notify = unquote(n[1])), (body = body.slice(0, n.index).trim());
  const target = String.raw`\$(?:record|records->each)`;
  let r: RegExpExecArray | null;
  if (new RegExp(`^${target}->update\\(\\$data\\);$`).test(body)) return { kind: "update", notify };
  if (new RegExp(`^${target}->delete\\(\\);$`).test(body)) return { kind: "delete", notify };
  if (/^\\?[\w\\]+::create\(\$data\);$/.test(body)) return { kind: "create", notify };
  if ((r = new RegExp(String.raw`^${target}->update\(\[\s*(${STRING})\s*=>\s*(${STRING}|-?\d+(?:\.\d+)?|true|false|null)\s*,?\s*\]\);$`, "i").exec(body)))
    return { kind: "set", column: unquote(r[1]), value: /^['"]/.test(r[2]) ? unquote(r[2]) : r[2], notify };
  return { kind: "custom" };
}
