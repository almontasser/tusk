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
 * `test*` methods or methods marked `#[Test]` or `@test`. Pest tests are top-level
 * `it(...)` and `test(...)` calls.
 * ponytail: line-based regexes; a PHP parser would catch multi-line declarations.
 */
export function findTests(source: string): TestCase[] {
  const lines = source.split("\n");
  const tests: TestCase[] = [];
  let marked = false; // A #[Test] attribute or @test tag appeared since the last method.
  lines.forEach((text, i) => {
    const line = i + 1;
    if (/#\[(\\?PHPUnit\\Framework\\Attributes\\)?Test\]|@test\b/.test(text)) marked = true;
    const method = text.match(/^\s*public function (\w+)\s*\(/);
    if (method) {
      if (method[1].startsWith("test") || marked) tests.push({ line, name: method[1], filter: `::${method[1]}( with data set .*)?$` });
      marked = false;
    }
    const pest = text.match(/^(it|test)\(\s*(['"])(.*?)\2/);
    if (pest) tests.push({ line, name: `${pest[1] === "it" ? "it " : ""}${pest[3]}`, filter: escapeRegex(pest[3]) });
  });
  if (!tests.length) return [];
  const classLine = lines.findIndex((l) => /^\s*(final\s+|abstract\s+)*class\s+\w+/.test(l)) + 1;
  return [{ line: classLine || 1, name: "all tests in file" }, ...tests];
}

/** The test that contains `line`: the closest test starting at or above it, or the whole file. */
export function testAt(tests: TestCase[], line: number): TestCase | undefined {
  const cases = tests.slice(1).filter((t) => t.line <= line);
  return cases.at(-1) ?? tests[0];
}
