import { isAbsolute } from "./platform.ts";
// Reads the reports PHPUnit and Pest write: JUnit XML (--log-junit), the event stream, and Clover coverage
// (--coverage-clover). Free of editor imports so Node can test it.

export type TestResult = {
  name: string;
  className: string;
  /** Absolute for PHPUnit, relative to the project for Pest. */
  file: string;
  /** The line to show: where the failure happened in the test file, or where the test starts (0 when unknown, as with Pest). */
  line: number;
  time: number;
  status: "passed" | "failed" | "skipped";
  message: string;
  /** What the test printed (`<system-out>`), when it printed anything. */
  output?: string;
  /** An assertion's expected and actual values, from the TeamCity log (see `withDetails`). */
  expected?: string;
  actual?: string;
  /** The failure's stack, one `path:line` per line, from the TeamCity log. */
  trace?: string;
};

const unescape = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (_, name, dec, hex) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" }[name as string]!,
  );

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [, key, value] of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) result[key] = unescape(value);
  return result;
}

// ponytail: regexes over the report's fixed shape instead of an XML parser, which Node lacks.
export function parseJUnit(xml: string): TestResult[] {
  const results: TestResult[] = [];
  for (const [, attrs, body = ""] of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const a = attributes(attrs);
    const output = body.match(/<system-out>([\s\S]*?)<\/system-out>/)?.[1];
    const problem = body.match(/<(failure|error)\b[^>]*>([\s\S]*?)<\/\1>/);
    const name = a.name ?? "";
    const className = a.class ?? a.classname ?? "";
    // Messages start with the test's name (PHPUnit: "Class::name" on its own line; Pest: the name, without a line break).
    let message = problem ? unescape(problem[2]).trim() : "";
    for (const prefix of [`${className}::${name}`, name]) if (message.startsWith(prefix)) message = message.slice(prefix.length).trim();
    // Pest reports the file relative to the project, followed by "::" and the test's name. For PHPUnit-style
    // classes it reports a label instead, so the file comes from the failure's location or the class name.
    const locations = [...message.matchAll(/(\S+\.php):(\d+)/g)];
    let file = (a.file ?? "").split("::")[0];
    if (!file.endsWith(".php")) file = locations.at(-1)?.[1] ?? classFile(className);
    // The failure's own line in the test file, the last one the trace mentions.
    const at = locations.filter(([, path]) => path === file || path.endsWith(`/${file}`) || file.endsWith(`/${path}`)).at(-1);
    results.push({
      name,
      className,
      file,
      line: Number(at ? at[2] : a.line) || 0,
      time: Number(a.time) || 0,
      status: problem ? "failed" : /<skipped\b/.test(body) ? "skipped" : "passed",
      message,
      ...(output?.trim() ? { output: unescape(output) } : {}),
    });
  }
  return results;
}

/** A stack frame in a failure: the file as the report names it (absolute, or relative to the project) and its line. */
export type Frame = { file: string; line: number };
/** A failure message read for display: its text, an expected/actual comparison when it has one, and its stack. */
export type Failure = { text: string; expected?: string; actual?: string; frames: Frame[] };

/** A stack frame line: PHPUnit's `/path/File.php:17`, Pest's `at tests/X.php:8`, or PHP's `#0 /path/File.php(12): call()`. */
const FRAME = /^\s*(?:at\s+|#\d+\s+)?(\S+?\.php)(?::(\d+)|\((\d+)\)(?::.*)?)\s*$/;

/**
 * Splits a failure message into its text, its comparison, and its stack frames. PHPUnit prints a comparison as a
 * unified diff after `--- Expected` and `+++ Actual`; context lines belong to both sides. `trace` (from the TeamCity
 * log) and `expected`/`actual` (also from it, and complete where the diff only has the lines around changes) win.
 */
export function parseFailure(message: string, extra: Pick<TestResult, "expected" | "actual" | "trace"> = {}): Failure {
  const lines = message.split("\n");
  const frames: Frame[] = [];
  const text: string[] = [];
  let expected: string[] | undefined;
  let actual: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "--- Expected" && lines[i + 1] === "+++ Actual") {
      expected = [];
      actual = [];
      for (i += 2; i < lines.length && lines[i] !== "" && !FRAME.test(lines[i]); i++) {
        const [mark, rest] = [lines[i][0], lines[i].slice(1)];
        if (lines[i].startsWith("@@")) continue;
        if (mark !== "+") expected.push(rest);
        if (mark !== "-") actual.push(rest);
      }
      i--;
      continue;
    }
    const frame = line.match(FRAME);
    if (frame) frames.push({ file: frame[1], line: Number(frame[2] ?? frame[3]) });
    else text.push(line);
  }
  const traced = extra.trace ? parseFailure(extra.trace).frames : [];
  const comparison = extra.expected !== undefined && extra.actual !== undefined ? { expected: extra.expected, actual: extra.actual } : expected ? { expected: expected.join("\n"), actual: actual.join("\n") } : {};
  return { text: text.join("\n").trim(), ...comparison, frames: traced.length ? traced : frames };
}

/**
 * A key that matches a test across reports: JUnit's name (a readable label or description under Pest), the event
 * stream's and TeamCity's method names (`test_fails`, `__pest_evaluable__group__→_it_works`), without case,
 * punctuation, or a `test` prefix.
 */
export const testKey = (className: string, name: string) =>
  `${className.replace(/^\\?P\\/, "")}::${name.replace(/^__pest_evaluable_/, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "").replace(/^test/, "")}`;

/** The report's results with the comparison and stack each failure has in the TeamCity log, which JUnit reports leave out under Pest. */
export function withDetails(results: TestResult[], live: LiveTest[]): TestResult[] {
  const byKey = new Map(live.map((t) => [testKey(t.className, t.name), t]));
  return results.map((r) => {
    const t = r.status === "failed" ? byKey.get(testKey(r.className, r.name)) : undefined;
    return t ? { ...r, ...(t.expected !== undefined ? { expected: t.expected, actual: t.actual } : {}), ...(t.trace ? { trace: t.trace } : {}) } : r;
  });
}

/** A file a report names, on this Mac: under `containerRoot` it maps to the project, and a relative one is inside the project. */
export const localPath = (file: string, root: string, containerRoot: string) =>
  file.startsWith(`${containerRoot}/`) ? root + file.slice(containerRoot.length) : isAbsolute(file) ? file : `${root}/${file}`;

// ponytail: assumes Laravel's autoload-dev mapping of Tests\ to tests/.
export const classFile = (className: string) => `${className.replace(/^(P\\)?Tests\\/, "tests/").replace(/\\/g, "/")}.php`;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** A test's name without its data set, and without the describe() blocks Pest puts in front. */
export const baseName = (name: string) => name.replace(/ with data set .*$/, "").replace(/^.* → /, "");

/**
 * A --filter that matches exactly the given tests. PHPUnit matches "Class::method". Pest matches "Class::description",
 * with describe() blocks in front, but reports a readable label for PHPUnit-style methods ("Fails" for test_fails),
 * so words may be joined by "_" or a space and a "test" prefix may come first. Pest's filter ignores case.
 * The filter must not start with "(", or PHP reads the parentheses as delimiters and matches case-sensitively.
 */
export function filterFor(tests: TestResult[], pest: boolean): string {
  if (!pest) return `::(${[...new Set(tests.map((t) => baseName(t.name)))].map(escapeRegex).join("|")})( with data set .*)?$`;
  const classes = new Map<string, Set<string>>();
  for (const t of tests) classes.set(t.className, (classes.get(t.className) ?? new Set()).add(t.name.replace(/ with data set .*$/, "")));
  const words = (n: string) => n.split(/\s+/).map(escapeRegex).join("[_ ]?");
  return [...classes].map(([c, names]) => `${escapeRegex(c)}::(?:test_?)?(?:${[...names].map(words).join("|")})( with data set .*)?$`).join("|");
}

/** Whether a name from a report is the test that findTests calls `name`, ignoring Pest's readable labels. */
export function sameTest(reported: string, name: string): boolean {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^test/, "");
  return key(baseName(reported)) === key(name);
}

/** A test in a running suite. A failed one has its `message`; `file` and `line` are known from TeamCity logs. */
export type LiveTest = {
  className: string;
  name: string;
  status: "running" | TestResult["status"];
  message?: string;
  file?: string;
  line?: number;
  /** From TeamCity logs: an assertion's values, and the failure's stack. */
  expected?: string;
  actual?: string;
  trace?: string;
};

/**
 * Reads PHPUnit's --log-events-text stream (PHPUnit 10 and later), written as tests run, for progress before the
 * JUnit report exists. A failure's message is the lines after its `Test Failed` event, up to the next test event.
 */
export function parseEvents(text: string): { total: number; tests: LiveTest[] } {
  const total = Number(text.match(/^Test Suite Started \(.*?, (\d+) tests?\)/m)?.[1] ?? 0);
  const tests = new Map<string, LiveTest>();
  const status: Record<string, LiveTest["status"]> = { Prepared: "running", Passed: "passed", Failed: "failed", Errored: "failed", Skipped: "skipped", "Marked Incomplete": "skipped" };
  for (const m of text.matchAll(/^Test (Prepared|Passed|Failed|Errored|Skipped|Marked Incomplete) \((.+?)\)$/gm)) {
    const [, event, id] = m;
    const at = id.lastIndexOf("::");
    const className = id.slice(0, at).replace(/^P\\/, "");
    // Pest's generated method names, such as __pest_evaluable__group__→_it_works, made readable.
    const name = id.slice(at + 2).replace(/^__pest_evaluable_/, "").replace(/__/g, " ").replace(/_/g, " ").trim();
    const existing = tests.get(id);
    // A test that failed stays failed, even though "Finished" events follow.
    if (existing && existing.status !== "running") continue;
    let message: string | undefined;
    if (event === "Failed" || event === "Errored") {
      const after = text.slice(m.index! + m[0].length + 1);
      const end = after.search(/^Test [A-Z][\w ]* \(.*\)$/m);
      message = (end < 0 ? after : after.slice(0, end)).trim();
    }
    tests.set(id, { className, name, status: status[event], message });
  }
  return { total, tests: [...tests.values()] };
}

/** Pest's generated method names, such as `__pest_evaluable__group__→_it_works`, made readable. */
const pestName = (name: string) => (name.startsWith("__pest_evaluable_") ? name.replace(/^__pest_evaluable_/, "").replace(/__/g, " ").replace(/_/g, " ").trim() : name);

const teamcityValue = (s: string) => s.replace(/\|(.)/g, (_, c) => ({ n: "\n", r: "\r", "'": "'", "|": "|", "[": "[", "]": "]" })[c as string] ?? c);

/**
 * Reads a TeamCity log (`--log-teamcity`), which PHPUnit 9 and Pest 1 write as tests run, since they have no event
 * stream. Each test's `locationHint` gives its file, and a failure's `details` the line it failed on.
 */
export function parseTeamcity(text: string): { total: number; tests: LiveTest[] } {
  const tests = new Map<string, LiveTest>();
  let total = 0;
  for (const [, kind, body] of text.matchAll(/^##teamcity\[(\w+) (.*)\]$/gm)) {
    const a: Record<string, string> = {};
    for (const [, key, value] of body.matchAll(/(\w+)='((?:[^'|]|\|.)*)'/g)) a[key] = teamcityValue(value);
    if (kind === "testCount") total += Number(a.count) || 0;
    if (!a.name || !["testStarted", "testFailed", "testIgnored", "testFinished"].includes(kind)) continue;
    const key = `${a.flowId}:${a.name}`;
    const test = tests.get(key);
    if (kind === "testStarted") {
      const [file, className = ""] = (a.locationHint ?? "").replace(/^php_qn:\/\//, "").split("::");
      // Pest's tests are eval()'d code, so their hint names Pest's own file.
      tests.set(key, { className: className.replace(/^\\/, "").replace(/^P\\/, ""), name: pestName(a.name), status: "running", file: /\.php$/.test(file) ? file : undefined });
    } else if (test && kind === "testFailed") {
      test.status = "failed";
      test.message = a.message;
      // The failing line is the last frame in the test's file, or in a tests/ file when the file isn't known.
      const frames = parseFailure(a.details ?? "").frames;
      const at = frames.filter((f) => (test.file ? f.file === test.file : /(^|\/)tests\//.test(f.file))).at(-1) ?? frames[0];
      test.file ??= at?.file;
      test.line = at?.line;
      if (a.type === "comparisonFailure" && "expected" in a) Object.assign(test, { expected: a.expected, actual: a.actual ?? "" });
      if (a.details?.trim()) test.trace = a.details.trim();
    } else if (test && kind === "testIgnored") test.status = "skipped";
    else if (test && kind === "testFinished" && test.status === "running") test.status = "passed";
  }
  return { total, tests: [...tests.values()] };
}

/** Line coverage by file: each executable line's hit count. */
export type Coverage = Map<string, Map<number, number>>;

/**
 * Reads a Clover report's statement lines. Method lines are skipped: a method's declaration line
 * counts as covered when any of its statements ran, which would hide an uncovered first statement.
 */
export function parseClover(xml: string): Coverage {
  const coverage: Coverage = new Map();
  for (const [, attrs, body] of xml.matchAll(/<file\b([^>]*)>([\s\S]*?)<\/file>/g)) {
    const lines = new Map<number, number>();
    for (const [line] of body.matchAll(/<line\b[^>]*>/g)) {
      const a = attributes(line);
      if (a.type === "stmt") lines.set(Number(a.num), Number(a.count));
    }
    if (lines.size) coverage.set(attributes(attrs).name, lines);
  }
  return coverage;
}

/** Runs of uncovered statement lines as [first, last], split wherever a covered statement lies between them. */
export function uncoveredRanges(lines: Map<number, number>): [number, number][] {
  const ranges: [number, number][] = [];
  let open = false;
  for (const [line, count] of [...lines].sort((a, b) => a[0] - b[0])) {
    if (count) open = false;
    else if (open) ranges[ranges.length - 1][1] = line;
    else (ranges.push([line, line]), (open = true));
  }
  return ranges;
}

/** A statement line of a coverage report: its hit count, its line in the report, and its text when first shown. */
export type Mark = { count: number; at: number; text?: string; stale?: boolean };

/**
 * A file's marks by the lines edits moved them to, given each mark's line now and the file's text. A mark
 * whose line's text changed since it was first shown is stale, and a mark past the end of the file is dropped.
 * A deleted line's mark lands on a neighbor's line, where a mark that isn't stale wins.
 */
export function moveMarks(placed: [number, Mark][], textAt: (line: number) => string | undefined): Map<number, Mark> {
  const moved = new Map<number, Mark>();
  for (const [line, mark] of placed) {
    const text = textAt(line);
    if (text === undefined) continue;
    mark.text ??= text;
    mark.stale = text !== mark.text;
    if (!moved.get(line) || moved.get(line)!.stale) moved.set(line, mark);
  }
  return moved;
}

/**
 * Reads the index of PHPUnit's XML coverage (`--coverage-xml`): the folder the report's paths are relative
 * to, and each source file's report, relative to the index, by the source file's path.
 */
export function coverageIndex(xml: string): { source: string; files: Map<string, string> } {
  const source = attributes(xml.match(/<project\b[^>]*>/)?.[0] ?? "").source ?? "";
  const files = new Map<string, string>();
  for (const [tag] of xml.matchAll(/<file\b[^>]*>/g)) {
    const href = attributes(tag).href;
    if (href) files.set(`${source}/${href.replace(/\.xml$/, "")}`, href);
  }
  return { source, files };
}

/** The tests that ran each line, from one file of PHPUnit's XML coverage, as reported test IDs. */
export function coveringTests(xml: string): Map<number, string[]> {
  const lines = new Map<number, string[]>();
  // Only the <coverage> section: <source> has <line> tags of its own, for the file's tokens.
  const section = xml.match(/<coverage>([\s\S]*?)<\/coverage>/)?.[1] ?? "";
  for (const [, attrs, body = ""] of section.matchAll(/<line\b([^>]*?)(?:\/>|>([\s\S]*?)<\/line>)/g))
    lines.set(Number(attributes(attrs).nr), [...body.matchAll(/<covered\b[^>]*>/g)].map(([tag]) => attributes(tag).by));
  return lines;
}

/**
 * A test ID from coverage, `Class::method`, as its class and a readable name. Pest's IDs have a `P\` prefix
 * and a method named `__pest_evaluable_` plus the description, with `_` for spaces and describe() blocks in front.
 */
export function testOf(id: string): { className: string; name: string } {
  // PHPUnit adds a data set as `#<name>`, which isn't part of the test's name.
  const [className, method = ""] = id.replace(/^P\\/, "").replace(/#.*$/, "").split("::");
  const pest = method.startsWith("__pest_evaluable_");
  const name = pest ? method.slice("__pest_evaluable_".length).replace(/_/g, " ").replace(/\s+/g, " ").trim() : method;
  return { className, name };
}
