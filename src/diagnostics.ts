// Tells the language servers' real problems from the false ones Laravel's magic and Pest set off, and reads
// Mago's report of a whole project. Free of editor imports so Node can test it, and so the open files and the
// project's problems go through the same filters.
import { withoutMagic } from "./magic.ts";

type Position = { line: number; character: number };
export type Diagnostic = {
  range: { start: Position; end: Position };
  message: string | { value: string };
  severity?: number;
  code?: string | number;
  source?: string;
};

/** What the project's code resolves at runtime, read by introspect.php (eloquent.ts). */
export type Facts = {
  isModelProperty(className: string, property: string): boolean | undefined;
  isModelMethod(className: string, method: string): boolean | undefined;
  isFacade(name: string, fileText: string): boolean;
  isView(name: string): boolean | undefined;
  /** The lowest PHP version the project supports, such as `8.4`, if composer.json says. */
  phpVersion?: string;
};

const messageOf = (d: Diagnostic) => (typeof d.message === "string" ? d.message : d.message.value);

/** Library code you don't edit. PhpStorm doesn't report problems there either. */
export const isLibrary = (path: string) => /\/(vendor|node_modules)\//.test(path);

/**
 * Pest's test closures run as methods of the project's test case and traits, which the PHP server reads from
 * tests/Pest.php and the file's `uses()`, so `$this->get()` checks. The server also types the properties tests set on
 * `$this` and doesn't report setting them. PHPStan doesn't know the binding, and Pest's PHPStan extension doesn't
 * teach it, so its problems that come from that are dropped: `$this` as PHPUnit's `TestCase` or Pest's
 * `TestCall`, depending on the Pest version, and the `mixed` values that come from it.
 */
const isPestFile = (path: string, text: string) => /\/tests\//.test(path) && /^\s*(it|test|describe|arch)\(/m.test(text);

function pestFalsePositive(text: string, lines: string[], lineStarts: number[], d: Diagnostic): boolean {
  const message = messageOf(d);
  // Pest's own classes answer through magic: `->not`, higher-order expectations (`->name->toBe()`), and hooks.
  if (/^mago/.test(d.source ?? "") && /`Pest\\/.test(message)) return true;
  // expect() returns an `Expectation<TValue|null>`, so Mago takes every call along its chain as one on null.
  if (/^(possible-)?method-access-on-null$|^null-property-access$|^invalid-property-access$/.test(String(d.code))) {
    const at = (lineStarts[d.range.start.line] ?? text.length) + d.range.start.character;
    const start = Math.max(text.lastIndexOf(";", at - 1), text.lastIndexOf("{", at - 1), text.lastIndexOf("}", at - 1)) + 1;
    if (/^(\s|\/\/.*)*expect\(/.test(text.slice(start))) return true;
  }
  const line = lines[d.range.start.line];
  if (line === undefined || !line.includes("$this")) return false;
  if (/^mago/.test(d.source ?? "")) return false;
  if (message === "Undefined variable: $this") return true;
  if (/^(Call to an undefined method|Access to an undefined property) (PHPUnit\\Framework\\TestCase|Pest\\PendingCalls\\\w+)[|:]/.test(message)) return true;
  // What `$this` gives PHPStan is `mixed`, as is all that follows; Mago checks those types with the binding.
  return /\bmixed\b/.test(message);
}

/**
 * Mago analyzer rules that Laravel's magic sets off on correct code: a property or method Eloquent, a request, or
 * a facade resolves at runtime (`$post->author`, `$request->email`) has no declaration, and every call on the value
 * it returns is then on `mixed`. PhpStorm flags the first only faintly and the rest not at all, so these show as
 * hints: dots under the code, explained on hover, and not counted as problems.
 */
const magicNoise = (d: Diagnostic) => /^mago/.test(d.source ?? "") && (/^non-documented-(property|method)$/.test(String(d.code ?? "")) || onMixed(d));

/**
 * Mago's issues about using a value of unknown type: the `mixed-*` rules, and a `foreach`, call, spread, cast, or
 * destructuring of a `mixed` value (or `nonnull`: mixed without null, as after `?? []`).
 */
const onMixed = (d: Diagnostic) =>
  /^mago/.test(d.source ?? "") &&
  (String(d.code ?? "").startsWith("mixed-") || (/^invalid-(iterator|callable|array-element|destructuring-source|type-cast)$/.test(String(d.code)) && /`(mixed|nonnull)`/.test(messageOf(d))));

/** A request's input reads as properties (`$request->email`), so any name is valid on a request. */
const isRequest = (className: string) => /^\\?(Illuminate\\Http\\Request|App\\Http\\Requests\\.+)$/.test(className);

/**
 * A model factory's create() and make() return `Model|Collection<int, Model>` in Laravel's docblocks, since
 * count() makes a collection, and Mago can't tell which; Larastan can. A type like that in a message is the
 * factory's, as the code uses a single model.
 */
// ponytail: also hides passing a counted factory's collection where a model is expected; Larastan tracks count().
const factoryUnion = /([\w\\]+)\|Illuminate\\Database\\Eloquent\\Collection<int, \1>|Illuminate\\Database\\Eloquent\\Collection<int, ([\w\\]+)>\|\2(?![\w\\])/;

/** Model factory calls, such as `User::factory()->create()`. */
const factoryCalls = (text: string) => [...text.matchAll(/::factory\(/g)].map((m) => m.index!);

/**
 * Drops Mago's "ambiguous property access" and "ambiguous method call" where Laravel really answers them: a
 * model's column, relationship, or accessor, a local scope or query builder method it forwards (`create`,
 * `where`), or a request's input; and the factory types above. `withoutMagic` then drops the issues that follow
 * from them: `mixed-*` ones, and a single model taken for a collection. Anything Laravel doesn't have keeps its hint.
 */
function withoutEloquentMagic<D extends Diagnostic>(text: string, list: D[], facts: Facts): D[] {
  // A facade's methods return `mixed` in its docblock, such as DB::transaction(), so its calls are magic too.
  const facadeCalls = [...text.matchAll(/\b([A-Z]\w*)::\w+\s*\(/g)].filter((m) => facts.isFacade(m[1], text)).map((m) => m.index!);
  const isMago = (d: D) => /^mago/.test(d.source ?? "");
  // A factory's model taken for a collection, or its collection for a model, as `$users->push()` on Model::push(),
  // and an array key of unknown type.
  const follows = (d: D) =>
    onMixed(d) ||
    (isMago(d) && (d.code === "invalid-array-element-key" || d.code === "non-iterable-object-iteration" || /`Illuminate\\(Database\\Eloquent|Support)\\(Collection|Model)(::\w+)?`/.test(messageOf(d))));
  return withoutMagic(text, list, [...facadeCalls, ...factoryCalls(text)], (d) => {
    if (!isMago(d)) return false;
    const message = messageOf(d);
    if (factoryUnion.test(message)) return true;
    const property = d.code === "non-documented-property" && message.match(/\$(\w+) on class `([^`]+)`/);
    const method = d.code === "non-documented-method" && message.match(/call to `(\w+)` on class `([^`]+)`/);
    return !!((property && (isRequest(property[2]) || facts.isModelProperty(property[2], property[1]))) || (method && facts.isModelMethod(method[2], method[1])));
  }, follows);
}

/**
 * Reports that are wrong on correct code, each for a reason the editor can check:
 * - The server's unused import that Mago's linter reports too (`no-redundant-use`), or that a docblock uses.
 * - An unused import that the code uses with other letter case (`use HasDescription, hasIcon;`): PHP's class
 *   names ignore case, and both checkers don't.
 * - A member used in a trait: the classes that use the trait have it. PhpStorm doesn't check these either.
 * - A member of a Mockery mock, which answers any call.
 * - A view name given to a `view-string` property, such as a widget's `$view`, when the view exists: Mago doesn't
 *   know Larastan's view-string type.
 * - A docblock type a method inherits from its parent's docblock, such as Filament's `getFilters()`.
 * - `'password' => 'hashed'` in a model's casts, which names a cast rather than a password.
 * - A call PHP deprecates only in a version newer than the project's: Mago reports it for every version.
 * - Too few arguments in a call that spreads an array (`...$args`), whose length Mago can't know.
 * - `$this` in routes/console.php, where Artisan binds each command's closure to the command.
 * - A variable a closure captures by reference (`use (&$payload)`) taken for null, or for the empty array it
 *   starts as: Mago doesn't see the closure assign it.
 */
type FileFacts = {
  path: string;
  lines: string[];
  traits: Set<string>;
  byReference: RegExp | null;
  /** The text of the file's docblocks. */
  docblocks: string;
  /** `code line` of each diagnostic, and `source code line:character message`, to find two servers reporting the same thing. */
  sameLine: Set<string>;
};

function falsePositive({ path, lines, traits, byReference, docblocks, sameLine }: FileFacts, facts: Facts, d: Diagnostic): boolean {
  const message = messageOf(d);
  // PHP's class names ignore case, so `use ..., hasIcon;` uses an imported `HasIcon`; both checkers compare with case.
  const usedWithOtherCase = (name: string) =>
    lines.some((l) => !/^\s*use\s+[\w\\]+(\s+as\s+\w+)?\s*;/.test(l) && new RegExp(`(?<![\\w$\\\\])${name}(?!\\w)`, "i").test(l) && !new RegExp(`(?<![\\w$\\\\])${name}(?!\\w)`).test(l));
  const line = lines[d.range.start.line] ?? "";
  const byReferenceCode = /null|no-value|impossible|redundant|reference-constraint-violation|mismatched-array-index|undefined-(int|string)-array-index/;
  if (byReference && (byReferenceCode.test(String(d.code)) || /`null`/.test(message)) && byReference.test(line)) return true;
  switch (d.code) {
    case "unused_import": {
      const name = message.match(/^Unused import: `([^`]+)`/)?.[1]?.split("\\").pop();
      return !!name && (new RegExp(`\\b${name}\\b`).test(docblocks) || usedWithOtherCase(name) || sameLine.has(`no-redundant-use ${d.range.start.line}`));
    }
    case "no-redundant-use": {
      const name = message.match(/^Unused import: `([^`]+)`/)?.[1]?.split("\\").pop();
      return !!name && usedWithOtherCase(name);
    }
    case "parse": {
      // `mago analyze` and `mago lint` both report each parse error.
      const { line, character } = d.range.start;
      return d.source === "mago" && sameLine.has(`mago-lint parse ${line}:${character} ${message}`);
    }
    case "non-existent-method":
    case "non-existent-property": {
      const type = message.match(/on (?:type|class|interface|trait) `([^`]+)`/)?.[1] ?? "";
      return traits.has(type.split("\\").pop()!) || /^Mockery\\(Legacy)?MockInterface$/.test(type);
    }
    case "invalid-property-default-value": {
      const view = line.match(/=\s*['"]([\w.:-]+)['"]/)?.[1];
      return !!view && facts.isView(view) === true;
    }
    case "invalid-argument": {
      // Filament's docblocks name view-string without importing it: `unknown-ref(Filament\...\view-string)`.
      const view = /view-string\)`/.test(message) && message.match(/found `string\('([\w.:-]+)'\)`/)?.[1];
      return !!view && facts.isView(view) === true;
    }
    case "too-few-arguments":
      return /\.\.\.\$\w+/.test(line);
    case "undefined-variable":
      return /\/routes\/console\.php$/.test(path) && message.includes("`$this`");
    case "docblock-type-mismatch":
      return /^Docblock (return )?type `/.test(message) && !ownDocblock(lines, d.range.start.line);
    case "no-literal-password":
      return /=>\s*['"](hashed|encrypted)['"]/.test(line);
    case "deprecated-method": {
      const since = deprecatedSince[message.match(/`([^`]+)`/)?.[1] ?? ""];
      return !!since && !!facts.phpVersion && compareVersions(facts.phpVersion, since) < 0;
    }
  }
  return false;
}

/** PHP's own methods deprecated in a later version, which Mago reports whatever the project's version. */
// ponytail: only the ones seen in projects so far; phpstorm-stubs' #[Deprecated(since:)] has them all.
const deprecatedSince: Record<string, string> = { "ReflectionMethod::setAccessible": "8.5", "ReflectionProperty::setAccessible": "8.5" };

const compareVersions = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** Whether the declaration on 0-based `line` has a docblock of its own: `*\/` above it, past any attributes. */
function ownDocblock(lines: string[], line: number): boolean {
  let i = line - 1;
  while (i >= 0 && /^\s*(#\[.*)?$/.test(lines[i]) && lines[i].trim() !== "") i--;
  return i >= 0 && /\*\/\s*$/.test(lines[i]);
}

/** The diagnostics worth showing for a file: none in libraries, and none of the false ones above. */
export function realProblems<D extends Diagnostic>(path: string, text: string, languageId: string, list: D[], facts: Facts): D[] {
  if (isLibrary(path)) return [];
  if (!list.length) return list;
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const lines = text.split("\n");
  if (isPestFile(path, text)) list = list.filter((d) => !pestFalsePositive(text, lines, lineStarts, d));
  if (!list.length || languageId !== "php") return list;
  const traits = new Set([...text.matchAll(/^\s*trait\s+(\w+)/gm)].map((m) => m[1]));
  const captured = [...text.matchAll(/\buse\s*\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/&\s*\$(\w+)/g)].map((v) => v[1]));
  const file: FileFacts = {
    path,
    lines,
    traits,
    byReference: captured.length ? new RegExp(`\\$(${[...new Set(captured)].join("|")})\\b`) : null,
    docblocks: (text.match(/\/\*\*[\s\S]*?\*\//g) ?? []).join("\n"),
    sameLine: new Set(list.flatMap((d) => [`${d.code} ${d.range.start.line}`, `${d.source} ${d.code} ${d.range.start.line}:${d.range.start.character} ${messageOf(d)}`])),
  };
  return withoutEloquentMagic(text, list, facts)
    .filter((d) => !falsePositive(file, facts, d))
    .map((d) => (isDeprecation(d) ? onDeprecatedName(text, lineStarts, d) : isUnused(d) ? onUseStatement(lines, d) : d));
}

/**
 * Mago's issues about types it can't prove rather than mistakes: a value that may be null or false, one of a
 * wider type than expected (`less-specific`), a generic class without its type arguments, or a class named by a
 * variable; and a docblock Mago can't read, such as `array<mixed>&array{id: string}`, which PHPStan reads. The code
 * may well be right, and PhpStorm doesn't treat them as errors either.
 */
const unproven = /^(possibl[ey]-|less-specific-|property-type-coercion$|missing-template-parameter$|unknown-class-instantiation$|invalid-docblock$|invalid-\w+-tag$)/;

/**
 * A closure whose parameter type is narrower than the callable asks for, such as `EloquentCollection $chunk` for
 * chunkById()'s `Collection`: Laravel's docblocks describe the base class, and Mago loses generic types on the way.
 */
const narrowerClosure = (d: Diagnostic) => d.code === "invalid-argument" && /expected `\(?callable\(/.test(messageOf(d)) && /found `\(closure\(/.test(messageOf(d));

/** Calling a value that may be null, as Mago reports the null part of a nullable closure: like possibly-null. */
const nullCall = (d: Diagnostic) => d.code === "invalid-callable" && /of type `null`/.test(messageOf(d));

/** The LSP severity to show a diagnostic with: Laravel's magic as a hint (see magicNoise), and unproven types as warnings. */
export function severityOf(d: Diagnostic): number {
  // Faded rather than underlined, and not counted, as in VS Code.
  if (magicNoise(d) || isUnused(d)) return 4;
  if (d.source === "mago" && (unproven.test(String(d.code ?? "")) || narrowerClosure(d) || nullCall(d))) return Math.max(d.severity ?? 1, 2);
  return d.severity ?? 1;
}

type Range = { start: Position; end: Position };
type TextEdit = { range: Range; text: string };

/**
 * The edit that tells Mago to expect `category:code` on the 0-based `line`, so it's no longer reported: the code
 * added to a `// @mago-expect` comment for the category just above the line, or a new comment above it. A comment
 * can't mix `lint` and `analysis` codes, so each has its own. None for a line with `<?php`, where a comment above
 * would be output.
 */
export function magoExpect(lines: string[], line: number, category: "lint" | "analysis", code: string): TextEdit | undefined {
  const target = lines[line] ?? "";
  if (target.includes("<?")) return undefined;
  for (let i = line - 1; i >= 0 && /^\s*\/\/\s*@mago-(expect|ignore)\s/.test(lines[i]); i--) {
    const list = lines[i].match(new RegExp(`@mago-(expect|ignore)\\s+${category}:[\\w-]+(,[\\w-]+)*`));
    if (list) {
      const at = { line: i, character: list.index! + list[0].length };
      return { range: { start: at, end: at }, text: `,${code}` };
    }
  }
  const at = { line, character: 0 };
  return { range: { start: at, end: at }, text: `${target.match(/^\s*/)![0]}// @mago-expect ${category}:${code}\n` };
}

/** The lowest PHP version composer.json allows, such as `8.4` for `^8.4`: its platform setting, or else its requirement. */
export function phpVersionOf(composerJson: string): string | undefined {
  let composer: { require?: Record<string, string>; config?: { platform?: Record<string, string> } } = {};
  try {
    composer = JSON.parse(composerJson);
  } catch {}
  return (composer.config?.platform?.php ?? composer.require?.php ?? "").match(/\d+\.\d+(\.\d+)?/)?.[0];
}

/**
 * The editor's mago.toml for a project: `bundled` with the lowest PHP version composer.json allows (as PhpStorm
 * takes its language level), and `includes` and `excludes` added to their lists, which the file keeps on one line.
 * `paths` becomes the project's top-level folders and PHP files (`top`), less hidden ones, `vendor` (an include),
 * `node_modules`, and `storage`: Mago walks every file under a path before it applies `excludes`, so `.` made each
 * check walk worktrees in `.claude` and all of `node_modules`.
 */
export function magoConfigText(bundled: string, composerJson: string, includes: string[], excludes: string[], top: { name: string; is_dir: boolean }[] = []): string {
  const version = phpVersionOf(composerJson);
  const add = (text: string, key: string, items: string[]) =>
    items.length ? text.replace(new RegExp(`^${key} = \\[(.*)\\]$`, "m"), (_, list: string) => `${key} = [${[list, ...items.map((i) => JSON.stringify(i))].filter(Boolean).join(", ")}]`) : text;
  const paths = top.filter((e) => !e.name.startsWith(".") && !["vendor", "node_modules", "storage"].includes(e.name) && (e.is_dir || e.name.endsWith(".php"))).map((e) => e.name);
  const own = paths.length ? bundled.replace(/^paths = \[.*\]$/m, `paths = [${paths.map((p) => JSON.stringify(p)).join(", ")}]`) : bundled;
  const text = add(add(own, "includes", includes), "excludes", excludes);
  return version ? `php-version = "${version.split(".").length === 2 ? `${version}.0` : version}"\n${text}` : text;
}

/**
 * A message line split into text and code: code in backticks, and quoted class names such as
 * `"App\Models\Post"`.
 */
export function messageParts(line: string): { text: string; code: boolean }[] {
  return line
    .replace(/"([\w\\$]+(?:::\w+)?)"/g, "`$1`")
    .split(/`([^`]*)`/)
    .map((text, i) => ({ text, code: i % 2 === 1 }))
    .filter((p) => p.text);
}

/**
 * A message split around Mago's unified diff of two types, from `--- original` and `+++ modified` to the first line
 * that isn't part of it, so the diff can show as a diff, with its indentation, and not as lines of prose.
 */
export function splitDiff(message: string): { before: string; diff?: string; after: string } {
  const diff = message.match(/^--- .*\n\+\+\+ .*\n(?:[-+ @].*(?:\n|$))*/m);
  if (!diff) return { before: message, after: "" };
  return { before: message.slice(0, diff.index), diff: diff[0].trimEnd(), after: message.slice(diff.index! + diff[0].length) };
}

/** A message's text lines, trimmed, without blank ones. */
export const messageLines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

/**
 * A problem's message as Markdown for its hover: the first line in bold, and the checker's notes and advice as
 * paragraphs after it, with a diff as a diff. Code stays code, cut short past 60 characters so it fits on a line
 * (the problem page shows it whole), and the rest is escaped, so backslashes and generics such as `array<int>` show
 * as written.
 */
export function problemMarkdown(message: string): string {
  const format = (line: string) =>
    messageParts(line)
      .map((p) => (p.code ? `\`${p.text.length > 60 ? `${p.text.slice(0, 60)}…` : p.text}\`` : p.text.replace(/[\\`*_{}[\]<>()#+!|~-]/g, "\\$&")))
      .join("");
  const { before, diff, after } = splitDiff(message);
  const [first, ...rest] = messageLines(before);
  return [`**${format(first ?? "")}**`, ...rest.map(format), ...(diff ? ["```diff\n" + diff + "\n```"] : []), ...messageLines(after).map(format)].join("\n\n");
}

/** Which checker and rule reported a problem, as VS Code shows it: `mago-lint(no-redundant-use)`, or whichever is known. */
export const ruleLabel = (source?: string, code?: string) => (source && code ? `${source}(${code})` : source || code || "");

/**
 * The message to show after the end of a line with problems: the worst one's first line, cut to 120 characters, and
 * how many others the line has. Severities are Monaco's, where a higher number is worse.
 */
export function inlineProblem(problems: { severity: number; message: string }[]): { text: string; severity: number } | undefined {
  const [worst, ...others] = [...problems].sort((a, b) => b.severity - a.severity);
  if (!worst) return undefined;
  const first = worst.message.trim().split("\n")[0];
  const text = first.length > 120 ? `${first.slice(0, 119)}…` : first;
  return { text: others.length ? `${text}  +${others.length}` : text, severity: worst.severity };
}

/** Whether a problem matches the Problems panel's filter: every word in its message, rule, or relative path, ignoring case. */
export const matchesFilter = (filter: string, p: { message: string; source?: string; code?: string; path: string }) => {
  const text = `${p.message} ${ruleLabel(p.source, p.code)} ${p.path}`.toLowerCase();
  return filter.toLowerCase().split(/\s+/).every((word) => text.includes(word));
};

/** A long type, such as an array shape, laid out with one key per line: `array{'a': int, 'b': string}`. */
export function formatType(type: string): string {
  let out = "";
  const open: string[] = [];
  const pad = () => `\n${"  ".repeat(open.filter((o) => o === "{").length)}`;
  for (let i = 0; i < type.length; i++) {
    const c = type[i];
    if ("{<(".includes(c)) {
      open.push(c);
      out += c === "{" ? `{${pad()}` : c;
    } else if ("}>)".includes(c)) {
      const was = open.pop();
      out += was === "{" ? `${pad()}}` : c;
    } else if (c === "," && open.at(-1) === "{") {
      out += `,${pad()}`;
      if (type[i + 1] === " ") i++;
    } else out += c;
  }
  return out;
}

/** A report of a deprecated method, class, function, or constant, which the editor strikes through. */
export const isDeprecation = (d: Diagnostic) => (/^mago/.test(d.source ?? "") && /^deprecated-/.test(String(d.code))) ;

/**
 * `d` narrowed to the deprecated name, as its strikethrough covers: Mago reports the whole call
 * (`$method->setAccessible(true)`). The name is the message's last `::name` or backticked name.
 */
function onDeprecatedName<D extends Diagnostic>(text: string, lineStarts: number[], d: D): D {
  const name = messageOf(d).match(/`(?:[^`]*::)?\\?([\w\\]*?)(\w+)`/)?.[2];
  const offset = (p: Position) => (lineStarts[p.line] ?? text.length) + p.character;
  const [start, end] = [offset(d.range.start), offset(d.range.end)];
  const at = name ? text.slice(start, end).lastIndexOf(name) : -1;
  if (at < 0 || end - start === name!.length) return d;
  const position = (o: number): Position => {
    let line = d.range.start.line;
    while (lineStarts[line + 1] !== undefined && lineStarts[line + 1] <= o) line++;
    return { line, character: o - lineStarts[line] };
  };
  return { ...d, range: { start: position(start + at), end: position(start + at + name!.length) } };
}

/** A report of an unused import, which the editor fades as a hint, as VS Code does. */
export const isUnused = (d: Diagnostic) => d.code === "unused_import" || d.code === "no-redundant-use";

/** `d` widened to its whole `use …;` line, which the fade covers, when the import is on a line of its own. */
function onUseStatement<D extends Diagnostic>(lines: string[], d: D): D {
  const line = lines[d.range.start.line] ?? "";
  const use = line.match(/^(\s*)use\s[^;]*;/);
  if (!use || d.range.end.line !== d.range.start.line) return d;
  return { ...d, range: { start: { line: d.range.start.line, character: use[1].length }, end: { line: d.range.start.line, character: use[0].length } } };
}

/** The files with errors and every folder above them up to `root`, which the tree marks. */
export function withFolders(files: Iterable<string>, root: string): Set<string> {
  const paths = new Set<string>();
  for (let path of files)
    while (path.startsWith(`${root}/`) && !paths.has(path)) paths.add(path), (path = path.slice(0, path.lastIndexOf("/")));
  return paths;
}
