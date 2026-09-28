// Runs tests, Artisan commands, and other commands in terminal tabs.
import { invoke } from "@tauri-apps/api/core";
import { appCacheDir } from "@tauri-apps/api/path";
import { monaco } from "./editor";
import { pick, rank } from "./palette";
import { findTests, testAt, type TestCase } from "./phptests";
import { containerXdebugEnv, startDebugging, xdebugEnv } from "./debug";
import { filterFor, type TestResult } from "./junit";
import { type Container, runningContainer } from "./sail";
import { openTerminal } from "./terminal";
import { initTestResults, showLive, showResults } from "./testresults";
import { TYPE_KINDS, workspaceSymbols } from "./lsp";
import { initCoverage, loadCoverage } from "./coverage";
import { formRequestParameter, methodBody, methodLine, routeTarget, validationRules } from "./phptypes";
import { pathsFor, psr4From } from "./psr4";
import { type MenuItem, showMenu } from "./files";
import { onSettings, settings } from "./settings";

let getRoot: () => string;
let openAt: (path: string, line: number) => Promise<unknown>;
let status: (text: string) => void;
let loadProfiler: () => Promise<typeof import("./profiler")>;
/** How a test run goes: plainly, in the debugger, with code coverage, or with Xdebug's profiler. */
type Mode = "run" | "debug" | "coverage" | "profile";
let last: { title: string; command: string[]; tests: boolean; mode: Mode } | undefined;

const exists = (path: string) => invoke<boolean>("path_exists", { path: `${getRoot()}/${path}` });
export const isTestFile = (path: string) => path.includes("/tests/") || path.endsWith("Test.php");

/**
 * Runs a command in a terminal tab. For a test run, the Tests tab shows the results when it ends. With
 * coverage, PHPUnit also writes a Clover report, and the editor shows it in the gutter. With the profiler,
 * the Profiler tab shows the run's profile.
 */
async function run(title: string, command: string[], tests = false, mode: Mode = "run") {
  last = { title, command, tests, mode };
  const coverage = mode === "coverage";
  // Servers and watchers from Run Anything, such as `npm run dev`, reopen with the project while they still run.
  // Other commands, such as a migration waiting at a prompt, don't run again on their own.
  if (!tests) return openTerminal(getRoot(), title, command, undefined, undefined, LONG_RUNNING.test(command.join(" ")));
  // In a container, the report has to be somewhere it can write: storage/logs, which git ignores.
  const inContainer = command[0] === `${getRoot()}/vendor/bin/sail` || (command[0] === "docker" && command[1] === "compose");
  const report = inContainer ? `${getRoot()}/storage/logs/editor-junit.xml` : await reportPath();
  await invoke("remove_path", { path: report }).catch(() => {}); // So a run that fails early doesn't show the last results.
  const reportArg = inContainer ? "storage/logs/editor-junit.xml" : report;
  // Results show as tests run: PHPUnit 10 and later (and Pest 2 and later) stream events to a file, and earlier
  // versions write a TeamCity log.
  const format = (await exists("vendor/phpunit/phpunit/src/Event")) ? "events" : "teamcity";
  const events = inContainer ? `${getRoot()}/storage/logs/editor-events.txt` : report.replace(/junit\.xml$/, "events.txt");
  const liveArgs = [format === "events" ? "--log-events-text" : "--log-teamcity", inContainer ? "storage/logs/editor-events.txt" : events];
  await invoke("remove_path", { path: events }).catch(() => {});
  const timer = setInterval(() => showLive(events, true, format), 500);
  const clover = inContainer ? `${getRoot()}/storage/logs/editor-clover.xml` : report.replace(/junit\.xml$/, "clover.xml");
  // PHPUnit's XML coverage also records which tests ran each line.
  const perTest = inContainer ? `${getRoot()}/storage/logs/editor-coverage-xml` : report.replace(/junit\.xml$/, "coverage-xml");
  if (coverage) await Promise.all([clover, perTest].map((path) => invoke("remove_path", { path }).catch(() => {})));
  // PHPUnit uses PCOV when it's loaded, and otherwise Xdebug, which needs coverage mode. In a container, its own settings apply.
  const profiler = mode === "profile" ? await loadProfiler() : null;
  const profiles = profiler ? await profiler.profileDir() : "";
  const started = Math.floor(Date.now() / 1000);
  const env = coverage && !inContainer ? ["/usr/bin/env", "XDEBUG_MODE=coverage"] : profiler ? ["/usr/bin/env", ...(await profiler.profileEnv(profiles, getRoot()))] : [];
  const coverageArgs = coverage ? ["--coverage-clover", inContainer ? "storage/logs/editor-clover.xml" : clover, "--coverage-xml", inContainer ? "storage/logs/editor-coverage-xml" : perTest] : [];
  return openTerminal(getRoot(), title, [...env, ...command, "--log-junit", reportArg, ...liveArgs, ...coverageArgs], async () => {
    clearInterval(timer);
    if (!(await showResults(report))) showLive(events, false, format);
    if (coverage) showCoverage(clover, perTest);
    if (profiler) profiler.openNewestProfile(profiles, started, title);
  }, () => clearInterval(timer));
}

async function showCoverage(clover: string, perTest: string) {
  const result = await loadCoverage(clover, getRoot(), perTest);
  if (!result) return status("Coverage failed: no report. Install PCOV or Xdebug for PHP, or see the test output.");
  const percent = result.total ? Math.floor((result.covered / result.total) * 100) : 0;
  status(`Coverage: ${percent}% of lines (${result.covered} of ${result.total}) in ${result.files} files`);
}

async function reportPath() {
  const dir = await appCacheDir();
  await invoke("create_dir", { path: dir });
  return `${dir}/junit.xml`;
}

/** A command for this Mac: `vendor/bin/…` becomes absolute, since the terminal looks a relative program up in PATH. */
const onMac = (command: string[]) => (command[0].startsWith("vendor/") ? [`${getRoot()}/${command[0]}`, ...command.slice(1)] : command);

/** A PHP command in the project's running container (Sail or a Compose service), or else on this Mac. */
async function php(command: string[], debug = false): Promise<{ command: string[]; container: Container | null }> {
  const container = await runningContainer(getRoot());
  if (container) return { command: container.exec(command, debug ? containerXdebugEnv() : []), container };
  return { command: debug ? ["/usr/bin/env", ...xdebugEnv(), ...onMac(command)] : onMac(command), container };
}

/**
 * `php artisan test`, which runs Pest when it's installed, or else the test binary, in the project's
 * container when it's up. With `debug`, Xdebug's trigger is set (in Sail, through `sail debug`).
 */
async function testRunner(debug = false) {
  const local = (await exists("artisan")) ? ["php", "artisan", "test"] : [(await exists("vendor/bin/pest")) ? "vendor/bin/pest" : "vendor/bin/phpunit"];
  const { command, container } = await php(local, debug);
  return { command, where: container ? ` (${container.label})` : "" };
}

/** Commands that keep running until stopped: dev servers, watchers, queue workers, and containers. */
const LONG_RUNNING =
  /\b(?:artisan\s+(?:serve|queue:work|queue:listen|horizon|reverb:start|schedule:work|pail|octane:start)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|watch|serve|start)|vite(?!\s+build)(?:\s|$)|sail\s+up|(?:docker[-\s]compose)\s+up)\b/;

/** Runs a shell command line, so quoting and pipes work as in a terminal. */
const runLine = (title: string, line: string) => run(title, ["/bin/sh", "-c", line]);

const titles: Record<Mode, string> = { run: "Test", debug: "Debug", coverage: "Test with coverage", profile: "Profile" };

/**
 * Runs one test, or the whole file when the test has no filter, through `php artisan test` or
 * the test binary. In debug mode, it starts the debugger and runs the test with Xdebug enabled.
 */
export async function runTest(path: string, test: TestCase, mode: Mode = "run") {
  const file = path.slice(getRoot().length + 1);
  const runner = await testRunner(mode === "debug");
  // The profile would be written inside the container, where the editor can't find it.
  if (mode === "profile" && runner.where) return status(`Profiling runs tests on this Mac, not in a container. Stop the${runner.where} containers to profile.`);
  const filter = test.filter ? ["--filter", test.filter] : [];
  const title = `${titles[mode]}: ${test.filter ? test.name : file.split("/").pop()}${runner.where}`;
  if (mode === "debug") await startDebugging();
  return run(title, [...runner.command, file, ...filter], true, mode);
}

export const runAllTests = async (coverage = false) => {
  const runner = await testRunner();
  return run(`${coverage ? "Tests with coverage" : "Tests"}${runner.where}`, runner.command, true, coverage ? "coverage" : "run");
};

async function rerunFailed(failed: TestResult[]) {
  const filter = filterFor(failed, await exists("vendor/bin/pest"));
  return run(`Tests: ${failed.length} failed`, [...(await testRunner()).command, "--filter", filter], true);
}

/** Runs the test around the cursor, or all tests in the file. */
export function runTestAtCursor(editor: monaco.editor.ICodeEditor, mode: Mode = "run") {
  const model = editor.getModel();
  if (!model || !isTestFile(model.uri.fsPath)) return;
  const test = testAt(findTests(model.getValue()), editor.getPosition()?.lineNumber ?? 1);
  if (test) runTest(model.uri.fsPath, test, mode);
}

export const rerun = () => last && run(last.title, last.command, last.tests, last.mode);

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
  // Artisan commands run in the project's container when it's up; other command lines run on this Mac.
  const artisanLine = (await php(["php", "artisan"])).command.map(shellQuote).join(" ");
  pick("Run anything: an Artisan command with arguments, or a shell command", (query) => {
    const line = query.trim().replace(/^(php\s+)?artisan\s+/, "");
    if (!line) return [];
    const [word, ...args] = line.split(/\s+/);
    const suffix = args.length ? ` ${args.join(" ")}` : "";
    const items = artisan.map((c) => ({
      label: c.name,
      detail: c.description,
      run: () => runLine(`artisan ${c.name}`, `${artisanLine} ${c.name}${suffix}`),
    }));
    const ranked = rank(word, items).map((i) => ({ ...i, label: `artisan ${i.label}${suffix}` }));
    return [...ranked.slice(0, 50), { label: query.trim(), detail: "Run in terminal", run: () => runLine(word, query.trim()) }];
  });
}

/** Opens Laravel Tinker in a terminal tab, in the project's container when it's up. */
export const tinker = async () => openTerminal(getRoot(), "Tinker", (await php(["php", "artisan", "tinker"])).command, undefined, undefined, true);

/** Quotes a word for `/bin/sh` when it needs it. */
const shellQuote = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

type Route = { method: string; uri: string; name: string | null; action: string };

/** Runs artisan with the arguments, in the app's Sail container when one runs. */
async function artisanCommand(root: string, args: string[], tty: boolean) {
  const container = await runningContainer(root);
  return container ? container.exec(["php", "artisan", ...args], [], tty) : ["php", "artisan", ...args];
}

/**
 * The app's routes, from `artisan route:list --json`. When artisan fails, throws its error message, which
 * Laravel prints to stdout, such as a fatal error while booting the app.
 */
export async function listRoutes(root = getRoot()): Promise<Route[]> {
  const [program, ...args] = await artisanCommand(root, ["route:list", "--json"], false);
  const out = await invoke<string>("run_capture", { cwd: root, program, args, input: null, anyStatus: true });
  try {
    return JSON.parse(out);
  } catch {
    const lines = out
      .replace(/\x1b\[[\d;]*m/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    throw new Error(lines.slice(0, 2).join(": ") || "artisan route:list printed nothing");
  }
}

/** Lists the app's routes from `artisan route:list`; choosing one opens its controller method. */
export async function showRoutes() {
  const root = getRoot();
  let routes: Route[];
  try {
    routes = await listRoutes(root);
  } catch {
    // Run it in a terminal, which shows why it failed, such as a syntax error in a routes file.
    return openTerminal(root, "Routes", await artisanCommand(root, ["route:list"], true));
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
/** The file that declares a class: from composer.json's PSR-4 folders, or else the PHP index. */
export async function classFile(fqn: string): Promise<string | undefined> {
  const root = getRoot();
  const psr4 = psr4From(await invoke<string>("read_file", { path: `${root}/composer.json` }).catch(() => "{}"));
  for (const rel of pathsFor(fqn, psr4)) if (await exists(rel)) return `${root}/${rel}`;
  const short = fqn.split("\\").pop()!;
  const namespace = fqn.slice(0, -short.length - 1);
  const symbols = (await workspaceSymbols(short)).filter((s) => s.name === short && TYPE_KINDS.includes(s.kind) && !s.path.includes(".phar/"));
  return (symbols.find((s) => s.container === namespace) ?? symbols[0])?.path;
}

/** The validation rules a route's controller method declares, through a FormRequest parameter or a validate() call. */
export async function routeRules(action: string): Promise<Record<string, string>> {
  const target = routeTarget(action);
  const path = target && (await classFile(target.fqn));
  if (!target || !path) return {};
  const read = (file: string) => invoke<string>("read_file", { path: file }).catch(() => "");
  const source = await read(path);
  const formRequest = formRequestParameter(source, target.method);
  const requestFile = formRequest && (await classFile(formRequest));
  const rules = requestFile ? validationRules(methodBody(await read(requestFile), "rules")) : {};
  if (Object.keys(rules).length) return rules;
  const body = methodBody(source, target.method);
  // Rules in the action, or in a helper it calls, such as `$this->validateRequest($request)`.
  for (const code of [body, ...[...body.matchAll(/\$this->(\w+)\s*\(/g)].map((m) => methodBody(source, m[1]))]) {
    const found = validationRules(code);
    if (Object.keys(found).length) return found;
  }
  return {};
}

/** Opens the controller method a route action names. */
export async function openRoute(action: string) {
  const target = routeTarget(action);
  if (!target) return status(`This route runs ${action === "Closure" ? "a closure in a routes file" : action}, not a class.`);
  const path = await classFile(target.fqn);
  if (!path) return status(`${target.fqn} isn't in the project's PSR-4 folders or the PHP index yet. If indexing is running, try again when it ends.`);
  const source = await invoke<string>("read_file", { path }).catch(() => "");
  openAt(path, methodLine(source, target.method) || 1);
}

/** The ways to run the test at a line, for the gutter's menus. Empty when no test starts there. */
export function testMenu(model: monaco.editor.ITextModel, line: number): MenuItem[] {
  const path = model.uri.fsPath;
  const test = isTestFile(path) ? findTests(model.getValue()).find((t) => t.line === line) : undefined;
  if (!test) return [];
  const what = test.filter ? `'${test.name}'` : "All Tests in File";
  return [
    { label: `Run ${what}`, run: () => runTest(path, test) },
    { label: `Debug ${what}`, run: () => runTest(path, test, "debug") },
    { label: `Run ${what} with Coverage`, run: () => runTest(path, test, "coverage") },
    { label: `Profile ${what}`, run: () => runTest(path, test, "profile") },
  ];
}

/** Run buttons in the gutter of test files, when the setting is on, by model. */
const runButtons = new Map<monaco.editor.ITextModel, string[]>();

function decorateTests(model: monaco.editor.ITextModel) {
  const tests = settings.testGutterIcons && isTestFile(model.uri.fsPath) ? findTests(model.getValue()) : [];
  const ids = model.deltaDecorations(
    runButtons.get(model) ?? [],
    tests.map((t) => ({
      range: new monaco.Range(t.line, 1, t.line, 1),
      options: {
        glyphMarginClassName: `codicon codicon-${t.filter ? "run" : "run-all"} test-run`,
        glyphMarginHoverMessage: { value: t.filter ? `Run ${t.name}` : "Run all tests in file" },
        glyphMargin: { position: monaco.editor.GlyphMarginLane.Right },
      },
    })),
  );
  runButtons.set(model, ids);
}

/** Opens the run menu when you click a test's run button in the gutter. */
export function attachTestRunner(editor: monaco.editor.ICodeEditor) {
  editor.onMouseDown((e) => {
    const model = editor.getModel();
    const line = e.target.position?.lineNumber;
    if (!e.event.leftButton || !model || !line || !e.target.element?.classList.contains("test-run")) return;
    e.event.preventDefault();
    showMenu(e.event.posx, e.event.posy, testMenu(model, line));
  });
}

/** Adds run buttons or links to tests in test files. */
export function initRunner(
  root: () => string,
  open: (path: string, line: number) => Promise<unknown>,
  showStatus: (text: string) => void,
  profiler: () => Promise<typeof import("./profiler")>,
) {
  loadProfiler = profiler;
  getRoot = root;
  openAt = open;
  status = showStatus;
  initTestResults({ root, openAt: open, rerun, rerunFailed });
  initCoverage({ openAt: open, rerun, status: showStatus });
  monaco.editor.registerCommand("tests.run", (_, path: string, test: TestCase, mode?: Mode) => runTest(path, test, mode));
  // The links above tests show when the gutter buttons don't.
  const lensesChanged = new monaco.Emitter<monaco.languages.CodeLensProvider>();
  monaco.editor.onDidCreateModel((model) => {
    if (!isTestFile(model.uri.fsPath)) return;
    decorateTests(model);
    let timer: ReturnType<typeof setTimeout>;
    model.onDidChangeContent(() => (clearTimeout(timer), (timer = setTimeout(() => !model.isDisposed() && decorateTests(model), 300))));
    model.onWillDispose(() => runButtons.delete(model));
  });
  const provider: monaco.languages.CodeLensProvider = {
    onDidChange: lensesChanged.event,
    provideCodeLenses(model) {
      const path = model.uri.fsPath;
      const lenses = settings.testGutterIcons || !isTestFile(path)
        ? []
        : findTests(model.getValue()).flatMap((test) => {
            const range = new monaco.Range(test.line, 1, test.line, 1);
            return [
              { range, command: { id: "tests.run", title: test.filter ? "▶ Run test" : "▶ Run all tests in file", arguments: [path, test] } },
              { range, command: { id: "tests.run", title: "Debug", arguments: [path, test, "debug"] } },
              { range, command: { id: "tests.run", title: "Profile", arguments: [path, test, "profile"] } },
            ];
          });
      return { lenses, dispose() {} };
    },
  };
  monaco.languages.registerCodeLensProvider("php", provider);
  onSettings(() => {
    lensesChanged.fire(provider);
    monaco.editor.getModels().forEach(decorateTests);
  });
}
