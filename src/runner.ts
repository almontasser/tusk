// Runs tests, Artisan commands, and other commands in terminal tabs.
import { invoke } from "@tauri-apps/api/core";
import { appCacheDir } from "@tauri-apps/api/path";
import { monaco } from "./editor";
import { pick, rank } from "./palette";
import { findTests, testAt, type TestCase } from "./phptests";
import { startDebugging, XDEBUG_ENV } from "./debug";
import { filterFor, type TestResult } from "./junit";
import { sailRunning } from "./sail";
import { openTerminal } from "./terminal";
import { initTestResults, showLive, showResults } from "./testresults";
import { workspaceSymbols } from "./lsp";
import { methodLine, routeTarget } from "./phptypes";
import { pathsFor, psr4From } from "./psr4";

let getRoot: () => string;
let openAt: (path: string, line: number) => Promise<unknown>;
let status: (text: string) => void;
let last: { title: string; command: string[]; tests: boolean } | undefined;

const exists = (path: string) => invoke<boolean>("path_exists", { path: `${getRoot()}/${path}` });
const isTestFile = (path: string) => path.includes("/tests/") || path.endsWith("Test.php");

/** Runs a command in a terminal tab. For a test run, the Tests tab shows the results when it ends. */
async function run(title: string, command: string[], tests = false) {
  last = { title, command, tests };
  if (!tests) return openTerminal(getRoot(), title, command);
  // In Sail, the report has to be somewhere the container can write: storage/logs, which git ignores.
  const inSail = command[0] === sail();
  const report = inSail ? `${getRoot()}/storage/logs/editor-junit.xml` : await reportPath();
  await invoke("remove_path", { path: report }).catch(() => {}); // So a run that fails early doesn't show the last results.
  const reportArg = inSail ? "storage/logs/editor-junit.xml" : report;
  // PHPUnit 10 and later (and Pest 2 and later) stream events to a file as tests run.
  const live = await exists("vendor/phpunit/phpunit/src/Event");
  const events = inSail ? `${getRoot()}/storage/logs/editor-events.txt` : report.replace(/junit\.xml$/, "events.txt");
  const liveArgs = live ? ["--log-events-text", inSail ? "storage/logs/editor-events.txt" : events] : [];
  if (live) await invoke("remove_path", { path: events }).catch(() => {});
  const timer = live ? setInterval(() => showLive(events, true), 500) : undefined;
  return openTerminal(getRoot(), title, [...command, "--log-junit", reportArg, ...liveArgs], async () => {
    clearInterval(timer);
    if (!(await showResults(report)) && live) showLive(events, false);
  });
}

async function reportPath() {
  const dir = await appCacheDir();
  await invoke("create_dir", { path: dir });
  return `${dir}/junit.xml`;
}

// Absolute paths: the terminal looks a relative program up in PATH, not in the project.
const sail = () => `${getRoot()}/vendor/bin/sail`;
const bin = (name: string) => `${getRoot()}/vendor/bin/${name}`;

/**
 * `php artisan test`, which runs Pest when it's installed, or else the test binary. When Sail's containers
 * are running, tests run in them; with `debug`, through `sail debug`, which sets Xdebug's trigger.
 */
async function testRunner(debug = false) {
  if (await sailRunning(getRoot())) return debug ? [sail(), "debug", "test"] : [sail(), "test"];
  const local = (await exists("artisan")) ? ["php", "artisan", "test"] : [(await exists("vendor/bin/pest")) ? bin("pest") : bin("phpunit")];
  return debug ? ["/usr/bin/env", ...XDEBUG_ENV, ...local] : local;
}

/** Runs a shell command line, so quoting and pipes work as in a terminal. */
const runLine = (title: string, line: string) => run(title, ["/bin/sh", "-c", line]);

/**
 * Runs one test, or the whole file when the test has no filter, through `php artisan test` or
 * the test binary. With `debug`, it starts the debugger and runs the test with Xdebug enabled.
 */
export async function runTest(path: string, test: TestCase, debug = false) {
  const file = path.slice(getRoot().length + 1);
  const runner = await testRunner(debug);
  const filter = test.filter ? ["--filter", test.filter] : [];
  const title = `${debug ? "Debug" : "Test"}: ${test.filter ? test.name : file.split("/").pop()}${runner[0] === sail() ? " (Sail)" : ""}`;
  if (debug) await startDebugging();
  return run(title, [...runner, file, ...filter], true);
}

export const runAllTests = async () => {
  const runner = await testRunner();
  return run(runner[0] === sail() ? "Tests (Sail)" : "Tests", runner, true);
};

async function rerunFailed(failed: TestResult[]) {
  const filter = filterFor(failed, await exists("vendor/bin/pest"));
  return run(`Tests: ${failed.length} failed`, [...(await testRunner()), "--filter", filter], true);
}

/** Runs the test around the cursor, or all tests in the file. */
export function runTestAtCursor(editor: monaco.editor.ICodeEditor, debug = false) {
  const model = editor.getModel();
  if (!model || !isTestFile(model.uri.fsPath)) return;
  const test = testAt(findTests(model.getValue()), editor.getPosition()?.lineNumber ?? 1);
  if (test) runTest(model.uri.fsPath, test, debug);
}

export const rerun = () => last && run(last.title, last.command, last.tests);

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
  // Artisan commands run in Sail's container when it's up; other command lines run on this Mac.
  const php = (await sailRunning(getRoot())) ? "vendor/bin/sail artisan" : "php artisan"; // A shell line, so relative works
  pick("Run anything: an Artisan command with arguments, or a shell command", (query) => {
    const line = query.trim().replace(/^(php\s+)?artisan\s+/, "");
    if (!line) return [];
    const [word, ...args] = line.split(/\s+/);
    const suffix = args.length ? ` ${args.join(" ")}` : "";
    const items = artisan.map((c) => ({
      label: c.name,
      detail: c.description,
      run: () => runLine(`artisan ${c.name}`, `${php} ${c.name}${suffix}`),
    }));
    const ranked = rank(word, items).map((i) => ({ ...i, label: `artisan ${i.label}${suffix}` }));
    return [...ranked.slice(0, 50), { label: query.trim(), detail: "Run in terminal", run: () => runLine(word, query.trim()) }];
  });
}

/** Opens Laravel Tinker in a terminal tab, in Sail's container when it's up. */
export const tinker = async () =>
  openTerminal(getRoot(), "Tinker", (await sailRunning(getRoot())) ? [sail(), "artisan", "tinker"] : ["php", "artisan", "tinker"]);

type Route = { method: string; uri: string; name: string | null; action: string };

/** Lists the app's routes from `artisan route:list`; choosing one opens its controller method. */
export async function showRoutes() {
  const root = getRoot();
  const artisan = (await sailRunning(root)) ? [sail(), "artisan"] : ["php", "artisan"];
  let routes: Route[];
  try {
    routes = JSON.parse(await invoke<string>("run_capture", { cwd: root, program: artisan[0], args: [...artisan.slice(1), "route:list", "--json"], input: null }));
  } catch {
    // Run it in a terminal, which shows why it failed, such as a syntax error in a routes file.
    return openTerminal(root, "Routes", [...artisan, "route:list"]);
  }
  const items = routes.map((r) => ({
    label: `${r.method.replace("|HEAD", "")} /${r.uri.replace(/^\//, "")}`,
    detail: [r.name, r.action.replace(/^App\\Http\\Controllers\\/, "")].filter(Boolean).join(" · "),
    icon: "codicon-link",
    run: () => openRoute(r.action),
  }));
  pick("Routes: search by method, path, name, or controller", (q) => {
    if (!q.trim()) return items;
    // Match the name and controller too, not only the path.
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((i) => words.every((w) => `${i.label} ${i.detail}`.toLowerCase().includes(w)));
  });
}

/** Opens the class and method a route runs: from composer.json's PSR-4 folders, or else from the PHP index (for vendor). */
async function openRoute(action: string) {
  const target = routeTarget(action);
  if (!target) return status(`This route runs ${action === "Closure" ? "a closure in a routes file" : action}, not a class.`);
  const root = getRoot();
  const psr4 = psr4From(await invoke<string>("read_file", { path: `${root}/composer.json` }).catch(() => "{}"));
  let path: string | undefined;
  for (const rel of pathsFor(target.fqn, psr4)) if (await exists(rel)) path ??= `${root}/${rel}`;
  if (!path) {
    const short = target.fqn.split("\\").pop()!;
    const namespace = target.fqn.slice(0, -short.length - 1);
    const symbols = (await workspaceSymbols(short)).filter((s) => s.name === short && !s.path.includes(".phar/"));
    path = (symbols.find((s) => s.container === namespace) ?? symbols[0])?.path;
  }
  if (!path) return status(`${target.fqn} isn't in the project's PSR-4 folders or the PHP index yet. If indexing is running, try again when it ends.`);
  const source = await invoke<string>("read_file", { path }).catch(() => "");
  openAt(path, methodLine(source, target.method) || 1);
}

/** Adds run links above tests in test files. */
export function initRunner(root: () => string, open: (path: string, line: number) => Promise<unknown>, showStatus: (text: string) => void) {
  getRoot = root;
  openAt = open;
  status = showStatus;
  initTestResults({ root, openAt: open, rerun, rerunFailed });
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
