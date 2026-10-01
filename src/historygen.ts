// Record history with spatie/laravel-activitylog: reads and writes a model's `LogsActivity` trait and its
// `getActivitylogOptions()` chain, and writes the read-only relation manager that shows a record's history in its
// resource. Version 5 of the package moved its classes and renamed some calls, so both are read, and new code
// follows the installed version. No editor imports, so Node tests it.
import { addMember, type Edit, findCall, type OClass, type OMethod, type PCall, type PNode, methodNamed, phpFile, phpString, phpValue, removeCall, removeMethod, setCall } from "./phpcode.ts";
import { removeTraitEdits, traitsEdits } from "./usergen.ts";

/** What differs between the package's major versions. */
export type Flavor = { version: 4 | 5; trait: string; options: string; skipEmpty: string; relation: string; changes: string };
export const FLAVORS: Record<4 | 5, Flavor> = {
  4: { version: 4, trait: "Spatie\\Activitylog\\Traits\\LogsActivity", options: "Spatie\\Activitylog\\LogOptions", skipEmpty: "dontSubmitEmptyLogs", relation: "activities", changes: "properties" },
  5: { version: 5, trait: "Spatie\\Activitylog\\Models\\Concerns\\LogsActivity", options: "Spatie\\Activitylog\\Support\\LogOptions", skipEmpty: "dontLogEmptyChanges", relation: "activitiesAsSubject", changes: "attribute_changes" },
};
const TRAITS = [FLAVORS[4].trait, FLAVORS[5].trait];
const SKIP_EMPTY = [FLAVORS[4].skipEmpty, FLAVORS[5].skipEmpty];
/** The relationships the trait gives a model, in either version. */
export const HISTORY_RELATIONS = [FLAVORS[4].relation, FLAVORS[5].relation];

/** Which attributes it records: a list, the fillable ones, all of them, or none (only the event). */
export type Fields = "only" | "fillable" | "all" | "none";
export type HistorySpec = {
  on: boolean;
  fields: Fields;
  /** The attributes `logOnly()` lists. */
  only: string[];
  /** The attributes `logExcept()` lists. */
  except: string[];
  /** `logOnlyDirty()`: only the attributes that changed. */
  dirty: boolean;
  /** `dontLogEmptyChanges()` (`dontSubmitEmptyLogs()` before version 5): no entry when nothing it records changed. */
  skipEmpty: boolean;
  logName: string;
  /** The description, with `{event}` for the event's name; empty for the package's default (the event). */
  description: string;
};
export type Setting = "fields" | "except" | "logName" | "description";

export type HistoryRead = {
  spec: HistorySpec;
  method: OMethod | null;
  /** The method is code the designer doesn't read, such as statements before the return. */
  custom: boolean;
  /** Settings whose arguments are code, which stay as written. */
  code: Setting[];
  /** Calls the designer doesn't know, which stay as written. */
  others: PCall[];
};

const OFF: HistorySpec = { on: false, fields: "none", only: [], except: [], dirty: false, skipEmpty: false, logName: "", description: "" };

const short = (fqn: string) => fqn.slice(fqn.lastIndexOf("\\") + 1);

/** A list of plain strings, or undefined for anything else. */
function strings(node: PNode | undefined): string[] | undefined {
  if (node?.kind !== "array" || node.items.some((i) => i.key || i.spread || i.value.kind !== "string" || i.value.interpolated)) return undefined;
  return node.items.map((i) => (i.value as { value: string }).value);
}

/** A description closure's text, with `{event}` for its parameter, when it returns a plain or simply interpolated string. */
export function readDescription(text: string, node: PNode | undefined): string | undefined {
  if (node?.kind !== "closure" || !node.arrow || node.params.length !== 1) return undefined;
  const body = text.slice(node.body[0], node.body[1]).trim();
  const p = node.params[0];
  const single = /^'((?:[^'\\]|\\.)*)'$/.exec(body);
  // A literal "{event}" would read back as the placeholder.
  if (single) return single[1].includes("{event}") ? undefined : single[1].replace(/\\(['\\])/g, "$1");
  const double = /^"((?:[^"\\$]|\\["\\$]|\{\$(\w+)\}|\$\w+)*)"$/.exec(body);
  if (!double) return undefined;
  let ok = true;
  const out = double[1].replace(/\{\$(\w+)\}|\$(\w+)|\\(["\\$])/g, (_, a: string, b: string, esc: string) => {
    if (esc) return esc;
    if ((a ?? b) !== p) ok = false;
    return "{event}";
  });
  return ok ? out : undefined;
}

/** The closure for a description, with `{event}` written as the event's name. */
export function descriptionCode(description: string): string {
  const body = description.replace(/[\\"$]/g, "\\$&").replace(/\{event\}/g, "{$eventName}");
  return `fn (string $eventName) => "${body}"`;
}

/** Reads a model's history settings: the trait, and the `LogOptions` chain its options method returns. */
export function readHistory(text: string, cls: OClass): HistoryRead {
  const on = cls.traits.some((t) => TRAITS.includes(t));
  const method = methodNamed(cls, "getActivitylogOptions") ?? null;
  const read: HistoryRead = { spec: { ...OFF, on }, method, custom: false, code: [], others: [] };
  if (!method) return read;
  const ret = method.returns.length === 1 ? method.returns[0] : null;
  const base = ret?.kind === "chain" ? ret.base : ret;
  const bodyText = method.body ? text.slice(method.body[0] + 1, method.body[1] - 1).trim() : "";
  if (!ret || base?.kind !== "static" || short(base.class) !== "LogOptions" || base.method !== "defaults" || !bodyText.startsWith("return ")) return { ...read, custom: true };
  const spec = read.spec;
  const fieldCalls = (ret.kind === "chain" ? ret.calls : []).filter((c) => /^(logOnly|logAll|logFillable)$/.test(c.name));
  if (fieldCalls.length > 1) read.code.push("fields");
  for (const call of ret.kind === "chain" ? ret.calls : []) {
    const arg = call.args.items[0]?.value;
    const n = call.args.items.length;
    switch (call.name) {
      case "logOnly": {
        const list = strings(arg);
        if (!list || n !== 1) read.code.push("fields");
        else if (list.length === 1 && list[0] === "*") spec.fields = "all";
        else ((spec.fields = "only"), (spec.only = list));
        break;
      }
      case "logAll":
        spec.fields = "all";
        break;
      case "logFillable":
        spec.fields = "fillable";
        break;
      case "logExcept": {
        const list = strings(arg);
        if (!list || n !== 1) read.code.push("except");
        else spec.except = list;
        break;
      }
      case "logOnlyDirty":
        spec.dirty = true;
        break;
      case "dontSubmitEmptyLogs":
      case "dontLogEmptyChanges":
        spec.skipEmpty = true;
        break;
      case "useLogName":
        if (arg?.kind === "string" && !arg.interpolated && n === 1) spec.logName = arg.value;
        else read.code.push("logName");
        break;
      case "setDescriptionForEvent": {
        const d = readDescription(text, arg);
        if (d === undefined) read.code.push("description");
        else spec.description = d;
        break;
      }
      default:
        read.others.push(call);
    }
  }
  return read;
}

/** The chain of calls for a spec, as `->call(...)` lines. */
function chainCalls(spec: HistorySpec, flavor: Flavor): string[] {
  const calls: string[] = [];
  if (spec.fields === "only") calls.push(`logOnly(${phpValue(spec.only)})`);
  if (spec.fields === "fillable") calls.push("logFillable()");
  if (spec.fields === "all") calls.push("logAll()");
  if (spec.except.length) calls.push(`logExcept(${phpValue(spec.except)})`);
  if (spec.dirty) calls.push("logOnlyDirty()");
  if (spec.skipEmpty) calls.push(`${flavor.skipEmpty}()`);
  if (spec.logName) calls.push(`useLogName(${phpString(spec.logName)})`);
  if (spec.description) calls.push(`setDescriptionForEvent(${descriptionCode(spec.description)})`);
  return calls;
}

/** `getActivitylogOptions()` for a spec, with classes as `{{Fqn}}`. */
export function optionsMethod(spec: HistorySpec, flavor: Flavor): string {
  const options = `{{${flavor.options}}}`;
  const chain = chainCalls(spec, flavor).map((c) => `\n        ->${c.replace(/\n/g, "\n        ")}`).join("");
  return `public function getActivitylogOptions(): ${options}\n{\n    return ${options}::defaults()${chain};\n}`;
}

/** Removes a trait from the class: its own `use` line, or its name in a list such as `use HasFactory, LogsActivity;`. */
function removeTrait(text: string, cls: OClass, fqn: string): Edit[] {
  const own = removeTraitEdits(text, cls, fqn);
  if (own.length) return own;
  const body = text.slice(cls.bodyStart, cls.bodyEnd);
  const name = short(fqn);
  const m = new RegExp(`(,\\s*\\\\?(?:[\\w\\\\]*\\\\)?${name}\\b)|(\\\\?(?:[\\w\\\\]*\\\\)?${name}\\s*,\\s*)`).exec(body);
  return m ? [{ start: cls.bodyStart + m.index, end: cls.bodyStart + m.index + m[0].length, text: "" }] : [];
}

/**
 * The edits that turn what `read` found into `next`: the trait and a new options method, one call at a time in a
 * chain the designer reads (so calls it doesn't know stay), or the trait and method removed. Classes are `{{Fqn}}`.
 */
export function historyEdits(text: string, cls: OClass, read: HistoryRead, next: HistorySpec, flavor: Flavor): Edit[] {
  const was = read.spec;
  if (!next.on) {
    if (!was.on) return [];
    const trait = cls.traits.find((t) => TRAITS.includes(t))!;
    return [...removeTrait(text, cls, trait), ...(read.method ? [removeMethod(text, read.method)] : [])];
  }
  const edits: Edit[] = was.on ? [] : traitsEdits(text, cls, [flavor.trait]);
  if (!read.method) return [...edits, addMember(text, cls, optionsMethod(next, flavor))];
  if (read.custom) return edits;
  const chain = read.method.returns[0];
  const readable = (s: Setting) => !read.code.includes(s);
  const toggle = (names: string[], want: string, on: boolean) => {
    const has = names.map((n) => findCall(chain, n)).filter((c): c is PCall => !!c);
    if (on && !has.length) edits.push(setCall(text, chain, want, ""));
    if (!on) for (const c of has) edits.push(removeCall(chain, c));
  };
  if (readable("fields") && (next.fields !== was.fields || JSON.stringify(next.only) !== JSON.stringify(was.only))) {
    const calls = ["logOnly", "logAll", "logFillable"].map((n) => findCall(chain, n)).filter((c): c is PCall => !!c);
    const code = next.fields === "only" ? `logOnly(${phpValue(next.only)})` : next.fields === "fillable" ? "logFillable()" : next.fields === "all" ? "logAll()" : null;
    if (calls.length && code) edits.push({ start: calls[0].nameSpan[0], end: calls[0].args.close + 1, text: code });
    else if (calls.length) edits.push(removeCall(chain, calls[0]));
    else if (code) edits.push(setCall(text, chain, code.slice(0, code.indexOf("(")), code.slice(code.indexOf("(") + 1, -1)));
  }
  if (readable("except") && JSON.stringify(next.except) !== JSON.stringify(was.except)) {
    const call = findCall(chain, "logExcept");
    if (!next.except.length) call && edits.push(removeCall(chain, call));
    else edits.push(setCall(text, chain, "logExcept", phpValue(next.except)));
  }
  if (next.dirty !== was.dirty) toggle(["logOnlyDirty"], "logOnlyDirty", next.dirty);
  if (next.skipEmpty !== was.skipEmpty) toggle(SKIP_EMPTY, flavor.skipEmpty, next.skipEmpty);
  if (readable("logName") && next.logName !== was.logName) {
    const call = findCall(chain, "useLogName");
    if (!next.logName) call && edits.push(removeCall(chain, call));
    else edits.push(setCall(text, chain, "useLogName", phpString(next.logName)));
  }
  if (readable("description") && next.description !== was.description) {
    const call = findCall(chain, "setDescriptionForEvent");
    if (!next.description) call && edits.push(removeCall(chain, call));
    else edits.push(setCall(text, chain, "setDescriptionForEvent", descriptionCode(next.description)));
  }
  return edits;
}

/** The settings for a model turning history on: its columns, without its key, timestamps, and hidden ones. */
export function defaultSpec(columns: string[], hidden: string[], key = "id"): HistorySpec {
  const skip = new Set([key, "created_at", "updated_at", "deleted_at", "remember_token", ...hidden]);
  return { ...OFF, on: true, fields: "only", only: columns.filter((c) => !skip.has(c) && !/password|secret|token/i.test(c)), dirty: true, skipEmpty: true };
}

/** What a change to the history settings does, in words, for the model designer's preview. */
export function describeChange(was: HistorySpec, next: HistorySpec): string[] {
  if (JSON.stringify(was) === JSON.stringify(next)) return [];
  if (!next.on) return ["Stop recording history: remove LogsActivity and getActivitylogOptions()"];
  const what = next.fields === "only" ? next.only.join(", ") || "no attributes" : next.fields === "fillable" ? "the fillable attributes" : next.fields === "all" ? "all attributes" : "events only";
  const except = next.except.length && next.fields !== "only" ? `, except ${next.except.join(", ")}` : "";
  return [`${was.on ? "Record" : "Record history with LogsActivity:"} ${what}${except}${next.dirty ? ", changed values only" : ""}`];
}

/**
 * The relation manager that shows a record's history under its edit or view page: when, who, what happened, and
 * each changed attribute's old and new value. It's read-only, with no actions.
 */
export function historyManagerFile(namespace: string, flavor: Flavor): string {
  return phpFile(
    namespace,
    `class ActivitiesRelationManager extends {{Filament\\Resources\\RelationManagers\\RelationManager}}
{
    protected static string $relationship = '${flavor.relation}';

    protected static ?string $title = 'History';

    public function isReadOnly(): bool
    {
        return true;
    }

    public function table({{Filament\\Tables\\Table}} $table): {{Filament\\Tables\\Table}}
    {
        return $table
            ->recordTitleAttribute('description')
            ->columns([
                {{Filament\\Tables\\Columns\\TextColumn}}::make('created_at')
                    ->label('When')
                    ->since()
                    ->dateTimeTooltip(),
                {{Filament\\Tables\\Columns\\TextColumn}}::make('causer.name')
                    ->label('Who')
                    ->placeholder('System'),
                {{Filament\\Tables\\Columns\\TextColumn}}::make('event')
                    ->label('What')
                    ->badge()
                    ->color(fn (?string $state): string => match ($state) {
                        'created' => 'success',
                        'deleted' => 'danger',
                        default => 'gray',
                    }),
                {{Filament\\Tables\\Columns\\TextColumn}}::make('changes')
                    ->label('Changes')
                    ->state(fn ({{Spatie\\Activitylog\\Models\\Activity}} $record): array => static::changes($record))
                    ->listWithLineBreaks(),
            ])
            ->defaultSort('id', 'desc');
    }

    /** Each attribute the entry recorded, as "title: Old → New", or its value alone when it was created or deleted. */
    protected static function changes({{Spatie\\Activitylog\\Models\\Activity}} $record): array
    {
        $new = $record->${flavor.changes}?->get('attributes') ?? [];
        $old = $record->${flavor.changes}?->get('old') ?? [];
        $show = fn (mixed $value): string => match (true) {
            $value === null => '—',
            is_bool($value) => $value ? 'Yes' : 'No',
            is_scalar($value) => (string) $value,
            default => (string) json_encode($value),
        };

        return collect(array_keys($new + $old))
            ->map(fn (int | string $key): string => match (true) {
                ! array_key_exists($key, $old) => "{$key}: {$show($new[$key])}",
                ! array_key_exists($key, $new) => "{$key}: {$show($old[$key])}",
                default => "{$key}: {$show($old[$key])} → {$show($new[$key])}",
            })
            ->all();
    }
}`,
  );
}

/** The terminal command that installs the package, publishes its migration and config, and migrates. */
export function installCommand(composer: string, steps: { require: boolean; publish: boolean }): string {
  const provider = "'Spatie\\Activitylog\\ActivitylogServiceProvider'";
  const parts = [
    ...(steps.require ? [`${composer} require spatie/laravel-activitylog --no-interaction`] : []),
    ...(steps.publish ? [`php artisan vendor:publish --provider=${provider} --tag=activitylog-migrations`, `php artisan vendor:publish --provider=${provider} --tag=activitylog-config`] : []),
    "php artisan migrate",
  ];
  return parts.join(" && ");
}
