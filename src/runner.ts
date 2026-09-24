// Runs tests, Artisan commands, and other commands in terminal tabs.
import { invoke } from "@tauri-apps/api/core";
import { monaco } from "./editor";
import { pick, rank } from "./palette";
import { findTests, testAt, type TestCase } from "./phptests";
import { startDebugging, XDEBUG_ENV } from "./debug";
import { openTerminal } from "./terminal";

let getRoot: () => string;
let last: { title: string; command: string[] } | undefined;

const exists = (path: string) => invoke<boolean>("path_exists", { path: `${getRoot()}/${path}` });
const isTestFile = (path: string) => path.includes("/tests/") || path.endsWith("Test.php");

function run(title: string, command: string[]) {
  last = { title, command };
  return openTerminal(getRoot(), title, command);
}

/** Runs a shell command line, so quoting and pipes work as in a terminal. */
const runLine = (title: string, line: string) => run(title, ["/bin/sh", "-c", line]);

/**
 * Runs one test, or the whole file when the test has no filter, through `php artisan test` or
 * the test binary. With `debug`, it starts the debugger and runs the test with Xdebug enabled.
 */
export async function runTest(path: string, test: TestCase, debug = false) {
  const file = path.slice(getRoot().length + 1);
  const runner = (await exists("artisan"))
    ? ["php", "artisan", "test"]
    : [(await exists("vendor/bin/pest")) ? "vendor/bin/pest" : "vendor/bin/phpunit"];
  const filter = test.filter ? ["--filter", test.filter] : [];
  const title = `${debug ? "Debug" : "Test"}: ${test.filter ? test.name : file.split("/").pop()}`;
  if (debug) await startDebugging();
  return run(title, [...(debug ? ["/usr/bin/env", ...XDEBUG_ENV] : []), ...runner, file, ...filter]);
}

/** Runs the test around the cursor, or all tests in the file. */
export function runTestAtCursor(editor: monaco.editor.ICodeEditor, debug = false) {
  const model = editor.getModel();
  if (!model || !isTestFile(model.uri.fsPath)) return;
  const test = testAt(findTests(model.getValue()), editor.getPosition()?.lineNumber ?? 1);
  if (test) runTest(model.uri.fsPath, test, debug);
}

export const rerun = () => last && openTerminal(getRoot(), last.title, last.command);

type ArtisanList = { commands: { name: string; description: string; hidden?: boolean }[] };
let artisanCache: { root: string; items: { name: string; description: string }[] } | undefined;

async function artisanCommands() {
  const root = getRoot();
  if (artisanCache?.root !== root) {
    const json = await invoke<string>("run_capture", { cwd: root, program: "php", args: ["artisan", "list", "--format=json"] });
    const list: ArtisanList = JSON.parse(json);
    artisanCache = { root, items: list.commands.filter((c) => !c.hidden) };
  }
  return artisanCache.items;
}

/**
 * Run Anything: type an Artisan command with its arguments, such as `make:model Post -m`,
 * or any shell command line.
 */
export async function runAnything() {
  const artisan = (await exists("artisan")) ? await artisanCommands().catch(() => []) : [];
  pick("Run anything: an Artisan command with arguments, or a shell command", (query) => {
    const line = query.trim().replace(/^(php\s+)?artisan\s+/, "");
    if (!line) return [];
    const [word, ...args] = line.split(/\s+/);
    const suffix = args.length ? ` ${args.join(" ")}` : "";
    const items = artisan.map((c) => ({
      label: c.name,
      detail: c.description,
      run: () => runLine(`artisan ${c.name}`, `php artisan ${c.name}${suffix}`),
    }));
    const ranked = rank(word, items).map((i) => ({ ...i, label: `artisan ${i.label}${suffix}` }));
    return [...ranked.slice(0, 50), { label: query.trim(), detail: "Run in terminal", run: () => runLine(word, query.trim()) }];
  });
}

/** Adds run links above tests in test files. */
export function initRunner(root: () => string) {
  getRoot = root;
  monaco.editor.registerCommand("tests.run", (_, path: string, test: TestCase, debug?: boolean) => runTest(path, test, debug));
  monaco.languages.registerCodeLensProvider("php", {
    provideCodeLenses(model) {
      const path = model.uri.fsPath;
      const lenses = !isTestFile(path)
        ? []
        : findTests(model.getValue()).flatMap((test) => {
            const range = new monaco.Range(test.line, 1, test.line, 1);
            return [
              { range, command: { id: "tests.run", title: test.filter ? "▶ Run test" : "▶ Run all tests in file", arguments: [path, test] } },
              { range, command: { id: "tests.run", title: "Debug", arguments: [path, test, true] } },
            ];
          });
      return { lenses, dispose() {} };
    },
  });
}
