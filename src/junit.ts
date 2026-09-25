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
    });
  }
  return results;
}

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

export type LiveTest = { className: string; name: string; status: "running" | TestResult["status"] };

/** Reads PHPUnit's --log-events-text stream, written as tests run, for progress before the JUnit report exists. */
export function parseEvents(text: string): { total: number; tests: LiveTest[] } {
  const total = Number(text.match(/^Test Suite Started \(.*?, (\d+) tests?\)/m)?.[1] ?? 0);
  const tests = new Map<string, LiveTest>();
  const status: Record<string, LiveTest["status"]> = { Prepared: "running", Passed: "passed", Failed: "failed", Errored: "failed", Skipped: "skipped", "Marked Incomplete": "skipped" };
  for (const [, event, id] of text.matchAll(/^Test (Prepared|Passed|Failed|Errored|Skipped|Marked Incomplete) \((.+?)\)$/gm)) {
    const at = id.lastIndexOf("::");
    const className = id.slice(0, at).replace(/^P\\/, "");
    // Pest's generated method names, such as __pest_evaluable__group__→_it_works, made readable.
    const name = id.slice(at + 2).replace(/^__pest_evaluable_/, "").replace(/__/g, " ").replace(/_/g, " ").trim();
    const existing = tests.get(id);
    // A test that failed stays failed, even though "Finished" events follow.
    if (!existing || existing.status === "running") tests.set(id, { className, name, status: status[event] });
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
