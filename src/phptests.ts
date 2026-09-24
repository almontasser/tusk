// Finds PHPUnit and Pest tests in PHP source. Kept free of editor imports so Node can test it.

export type TestCase = {
  /** 1-based line of the test. */
  line: number;
  name: string;
  /** Value for `--filter`; undefined means the whole file. */
  filter?: string;
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Returns the tests in a file, with a whole-file entry first. PHPUnit tests are
 * `test*` methods or methods marked `#[Test]` or `@test`. Pest tests are
 * `it(...)` and `test(...)` calls, also inside `describe(...)`. A declaration may
 * span several lines; its line is where it starts.
 * ponytail: regexes over the source, so tests inside block comments are found too.
 */
export function findTests(source: string): TestCase[] {
  const lineOf = (offset: number) => source.slice(0, offset).split("\n").length;
  const tests: TestCase[] = [];
  let previous = 0; // Where the last method ended, so a #[Test] or @test between them marks this one.
  for (const m of source.matchAll(/^[ \t]*((?:(?:final|abstract|static|public|protected|private)\s+)*)function\s+(\w+)\s*\(/gm)) {
    const marked = /#\[(\\?PHPUnit\\Framework\\Attributes\\)?Test\]|@test\b/.test(source.slice(previous, m.index));
    previous = m.index! + m[0].length;
    if (/\bpublic\b/.test(m[1]) && (m[2].startsWith("test") || marked))
      tests.push({ line: lineOf(m.index!), name: m[2], filter: `::${m[2]}( with data set .*)?$` });
  }
  // Pest matches "Class::description", with any describe() blocks in front joined by " → ".
  for (const m of source.matchAll(/^[ \t]*(it|test)\(\s*(['"])(.*?)\2/gm)) {
    const name = `${m[1] === "it" ? "it " : ""}${m[3]}`;
    tests.push({ line: lineOf(m.index!), name, filter: `::(?:.* → )?${escapeRegex(name)}( with data set .*)?$` });
  }
  if (!tests.length) return [];
  tests.sort((a, b) => a.line - b.line);
  const classLine = source.split("\n").findIndex((l) => /^\s*(final\s+|abstract\s+)*class\s+\w+/.test(l)) + 1;
  return [{ line: classLine || 1, name: "all tests in file" }, ...tests];
}

/** The test that contains `line`: the closest test starting at or above it, or the whole file. */
export function testAt(tests: TestCase[], line: number): TestCase | undefined {
  const cases = tests.slice(1).filter((t) => t.line <= line);
  return cases.at(-1) ?? tests[0];
}
