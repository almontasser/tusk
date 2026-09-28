// Runs run configurations (tests, Artisan, scripts, and servers) in terminal tabs, keeps them in the project
// state, and holds the ways to start them: the title bar's run widget, the gutter's run buttons, and Run Anything.
import { invoke } from "@tauri-apps/api/core";
import { appCacheDir } from "@tauri-apps/api/path";
import { monaco } from "./editor";
import { h, icon } from "./dom";
import { confirm, type Item, pick, rank } from "./palette";
import { findTests, testAt, type TestCase } from "./phptests";
import { containerXdebugEnv, startDebugging, xdebugEnv } from "./debug";
import { filterFor, type TestResult } from "./junit";
import { type Container, runningContainer } from "./sail";
import { openTerminal, type TerminalRun } from "./terminal";
import { initTestResults, showLive, showResults, startTestRun } from "./testresults";
import { toolPath, TYPE_KINDS, workspaceSymbols } from "./lsp";
import { initCoverage, loadCoverage } from "./coverage";
import { formRequestParameter, methodBody, methodLine, routeTarget, validationRules } from "./phptypes";
import { pathsFor, psr4From } from "./psr4";
import { type MenuItem, showMenu } from "./files";
import { onSettings, settings } from "./settings";
import { onProjectValue, projectValue, setProjectValue } from "./projectstate";
import { errorText, showError } from "./status";
import { addTemporary, clean, commandFor, longRunning, type Mode, type Project, readConfigs, type RunConfig, summary, TYPES, uniqueName, validate } from "./runconfig";

let getRoot: () => string;
let openAt: (path: string, line: number) => Promise<unknown>;
let status: (text: string) => void;
let loadProfiler: () => Promise<typeof import("./profiler")>;
let showDiff: (path: string, original: string, modified: string, label: string) => unknown;

const exists = (path: string) => invoke<boolean>("path_exists", { path: `${getRoot()}/${path}` });
export const isTestFile = (path: string) => path.includes("/tests/") || path.endsWith("Test.php");
const projectInfo = async (): Promise<Project> => ({ artisan: await exists("artisan"), pest: await exists("vendor/bin/pest") });

// ---- Configurations in the project state ----

/** Shared configurations, in tusk.json; this Mac's own; the temporary ones runs create; and the one selected. */
const SHARED = "runConfigurations";
const LOCAL = "localRunConfigurations";
const TEMPORARY = "temporaryRunConfigurations";
const SELECTED = "selectedRunConfiguration";

export type Where = "shared" | "local" | "temporary";
export type Entry = { config: RunConfig; where: Where };

/** Every configuration of the open project: shared, then local, then temporary. */
export const configurations = (): Entry[] =>
  (
    [
      [SHARED, "shared"],
      [LOCAL, "local"],
      [TEMPORARY, "temporary"],
    ] as const
  ).flatMap(([key, where]) => readConfigs(projectValue(key)).map((config) => ({ config, where })));

const byName = (name: string | undefined) => configurations().find((e) => e.config.name === name);

/** The selected configuration: the one you chose last, or the first. */
export const selected = (): Entry | undefined => byName(projectValue<string>(SELECTED)) ?? configurations()[0];

async function select(name: string) {
  await setProjectValue(SELECTED, name, "local").catch((e) => showError("Can't save the selected run configuration", e));
  renderWidget();
}

/** Saves all configurations, each where its entry says, and selects `select` when given. */
export async function saveConfigurations(entries: Entry[], selectName?: string) {
  const list = (where: Where) => entries.filter((e) => e.where === where).map((e) => clean(e.config));
  try {
    for (const [key, where] of [
      [SHARED, "shared"],
      [LOCAL, "local"],
      [TEMPORARY, "temporary"],
    ] as const) {
      const value = list(where);
      // Unchanged lists aren't written, so tusk.json isn't touched when nothing shared changed.
      if (JSON.stringify(value) === JSON.stringify(readConfigs(projectValue(key)))) continue;
      await setProjectValue(key, value.length ? value : undefined, where === "shared" ? "shared" : "local");
    }
    if (selectName !== undefined) await setProjectValue(SELECTED, selectName, "local");
  } catch (e) {
    showError("Can't save the run configurations", e);
  }
  renderWidget();
}

/**
 * Runs a configuration made on the fly, such as from a gutter run button, as a temporary configuration: it's
 * selected, so ⌃R runs it again, and it stays among the five newest until you save it. A saved configuration
 * with the same settings runs instead of a copy.
 */
async function runTemporary(c: RunConfig, mode: Mode = "run") {
  const same = configurations().find((e) => e.where !== "temporary" && JSON.stringify(clean({ ...e.config, name: "" })) === JSON.stringify(clean({ ...c, name: "" })));
  if (same) return select(same.config.name).then(() => runConfig(same.config, mode));
  const saved = configurations().filter((e) => e.where !== "temporary").map((e) => e.config.name);
  const config = { ...c, name: uniqueName(c.name, saved) };
  const temporary = addTemporary(readConfigs(projectValue(TEMPORARY)), config);
  await setProjectValue(TEMPORARY, temporary.map(clean), "local").catch((e) => showError("Can't save the temporary run configuration", e));
  await select(config.name);
  return runConfig(config, mode);
}

/** Saves a temporary configuration, so it stays. */
export async function saveTemporary(name = selected()?.config.name) {
  const entries = configurations();
  const entry = entries.find((e) => e.config.name === name && e.where === "temporary");
  if (!entry) return status("The selected run configuration is already saved.");
  entry.where = "local";
  await saveConfigurations(entries, entry.config.name);
  status(`Saved the run configuration “${entry.config.name}”.`);
}

/** Reads the configurations again, when a project opens, or when tusk.json changes them. */
export const loadRunConfigurations = () => renderWidget();
onProjectValue(SHARED, () => renderWidget());

// ---- Running ----

type Run = { config: RunConfig; mode: Mode; title: string; terminal: TerminalRun };
/** The runs that are still going. */
const runs: Run[] = [];
/** The last run, for Rerun. */
let last: { config: RunConfig; mode: Mode } | undefined;
/** The test run the Tests tab shows. */
let testRun: Run | undefined;
let runCounter = 0;

export const isRunning = () => runs.length > 0;
const runsOf = (name: string) => runs.filter((r) => r.config.name === name);

/** A command for this Mac: `vendor/bin/…` becomes absolute, since the terminal looks a relative program up in PATH. */
const onMac = (command: string[]) => (command[0].startsWith("vendor/") ? [`${getRoot()}/${command[0]}`, ...command.slice(1)] : command);

/** A PHP command in the project's running container (Sail or a Compose service), or else on this Mac, with `env` set. */
async function php(command: string[], debug = false, env: string[] = [], docker = true): Promise<{ command: string[]; container: Container | null }> {
  const container = docker ? await runningContainer(getRoot()) : null;
  if (container) return { command: container.exec(command, [...env, ...(debug ? containerXdebugEnv() : [])]), container };
  const vars = [...env, ...(debug ? xdebugEnv() : [])];
  return { command: vars.length ? ["/usr/bin/env", ...vars, ...onMac(command)] : onMac(command), container };
}

const prefixes: Record<Mode, string> = { run: "", debug: "Debug: ", coverage: "Coverage: ", profile: "Profile: " };

/**
 * Runs a configuration: checks it, stops its earlier run unless it allows more than one, runs its before-launch
 * steps, and then runs it in a terminal tab. Resolves to the run's exit code, or null when it didn't run or end.
 */
export async function runConfig(c: RunConfig, mode: Mode = "run", chain: string[] = []): Promise<number | null> {
  const root = getRoot();
  if (!root) return null;
  const others = configurations().filter((e) => e.config.name !== c.name).map((e) => e.config);
  const errors = validate(c, [...others, c]);
  if (errors.length) return showError(`Can't run “${c.name}”: ${errors[0]}`, undefined, { label: "Edit Configuration…", run: () => editConfigurations(c.name) }), null;
  if (chain.includes(c.name)) return showError(`Before launch runs in a circle: ${[...chain, c.name].join(" → ")}.`), null;
  const info = TYPES[c.type];
  if (mode === "debug" && !info.php) return showError(`${info.label}s don't run PHP, so they can't run in the debugger. Use Run instead.`), null;
  if ((mode === "coverage" || mode === "profile") && c.type !== "test") return showError(`Only test configurations run with ${mode === "coverage" ? "coverage" : "the profiler"}.`), null;
  if (mode === "run" && c.type === "test" && c.coverage) mode = "coverage";

  const earlier = runsOf(c.name);
  if (earlier.length && !c.multiple) {
    if (!(await confirm(`“${c.name}” is still running. Stop it and run it again?`, "Stop and Rerun"))) return null;
    earlier.forEach((r) => r.terminal.stop());
    // It stops within 3 seconds: ⌃C, and then a kill.
    for (let i = 0; i < 40 && earlier.some((r) => !r.terminal.exited()); i++) await new Promise((r) => setTimeout(r, 100));
  }

  for (const step of c.before ?? []) {
    const before = "config" in step ? byName(step.config)?.config : ({ name: `Before “${c.name}”: ${step.command}`, type: "shell", command: step.command } satisfies RunConfig);
    if (!before) return showError(`Can't run “${c.name}”: its before-launch configuration “${"config" in step ? step.config : ""}” doesn't exist.`), null;
    const code = await runConfig(before, "run", [...chain, c.name]);
    if (code !== 0) {
      showError(`“${c.name}” didn't run: its before-launch step “${before.name}” ${code === null ? "didn't finish" : `failed with exit code ${code}`}.`);
      return null;
    }
  }
  if (!chain.length) last = { config: c, mode };
  try {
    return await launch(c, mode);
  } catch (e) {
    showError(`Can't run “${c.name}”`, e);
    return null;
  }
}

/** Starts a configuration in a terminal tab and resolves when it ends, with its exit code (null when it was killed or its tab closed). */
async function launch(c: RunConfig, mode: Mode): Promise<number | null> {
  const root = getRoot();
  const info = TYPES[c.type];
  const tests = c.type === "test";
  const coverage = mode === "coverage";
  const debug = mode === "debug";
  const docker = info.php && (c.docker ?? info.defaults.docker ?? false);
  const env = Object.entries(c.env ?? {}).map(([k, v]) => `${k}=${v}`);
  let argv = commandFor(c, await projectInfo());
  const container = docker ? await runningContainer(root) : null;
  // On this Mac, Composer is the bundled composer.phar; in a container, the container's own.
  if (c.type === "composer" && !container) argv = ["php", await toolPath("composer/composer.phar"), ...argv.slice(1)];
  // The profile would be written inside the container, where the editor can't find it.
  if (mode === "profile" && container) return showError(`Profiling runs tests on this Mac, not in a container. Stop the ${container.label} containers, or turn off Docker in “${c.name}”, to profile.`), null;
  const title = `${prefixes[mode]}${c.name}${container ? ` (${container.label})` : ""}`;
  if (debug) await startDebugging();

  let reports: Awaited<ReturnType<typeof testReports>> | undefined;
  const extraEnv: string[] = [];
  if (tests) {
    reports = await testReports(!!container, coverage);
    argv = [...argv, ...reports.args];
    // PHPUnit uses PCOV when it's loaded, and otherwise Xdebug, which needs coverage mode. In a container, its own settings apply.
    if (coverage && !container) extraEnv.push("XDEBUG_MODE=coverage");
  }
  const profiler = mode === "profile" ? await loadProfiler() : null;
  const profiles = profiler ? await profiler.profileDir() : "";
  if (profiler) extraEnv.push(...(await profiler.profileEnv(profiles, root)));
  const started = Math.floor(Date.now() / 1000);
  const command = info.php ? (await php(argv, debug, [...env, ...extraEnv], docker)).command : env.length ? ["/usr/bin/env", ...env, ...argv] : argv;
  const cwd = c.cwd ? `${root}/${c.cwd.replace(/^\/+|\/+$/g, "")}` : root;

  let timer: ReturnType<typeof setInterval> | undefined;
  let run: Run | undefined;
  let resolve: (code: number | null) => void = () => {};
  const done = new Promise<number | null>((r) => (resolve = r));
  const finish = () => {
    clearInterval(timer);
    if (run && runs.includes(run)) runs.splice(runs.indexOf(run), 1);
    renderWidget();
  };
  const terminal = await openTerminal(
    cwd,
    title,
    command,
    async (code) => {
      finish();
      if (reports) {
        const shown = await showResults(reports.junit, reports.details, code);
        if (!shown) await showLive(reports.live, false, reports.format);
        reports.cleanUp();
      }
      if (coverage && reports) showCoverage(reports.clover, reports.perTest);
      if (profiler) profiler.openNewestProfile(profiles, started, title);
      resolve(code);
    },
    () => (finish(), resolve(null)),
    longRunning(c),
  );
  if (!terminal) return clearInterval(timer), null; // openTerminal said why.
  run = { config: c, mode, title, terminal };
  runs.push(run);
  if (reports) {
    testRun = run;
    startTestRun(title);
    const r = reports;
    timer = setInterval(() => showLive(r.live, true, r.format), 500);
  }
  renderWidget();
  return done;
}

/**
 * Where a test run writes its reports, and the options that ask for them: the JUnit report, a live log (PHPUnit's
 * event stream from version 10, else a TeamCity log), a TeamCity log for failures' expected and actual values and
 * stacks, and coverage. In a container, the reports go to storage/logs, which the container can write and git ignores.
 */
async function testReports(inContainer: boolean, coverage: boolean) {
  const root = getRoot();
  const n = ++runCounter;
  const dir = inContainer ? `${root}/storage/logs` : await cacheDir();
  const local = (name: string) => `${dir}/${inContainer ? "editor-" : ""}${name}`;
  const arg = (name: string) => (inContainer ? `storage/logs/editor-${name}` : local(name));
  const [junit, events, teamcity] = [`junit-${n}.xml`, `events-${n}.txt`, `teamcity-${n}.txt`];
  const format = (await exists("vendor/phpunit/phpunit/src/Event")) ? ("events" as const) : ("teamcity" as const);
  // PHPUnit's XML coverage also records which tests ran each line.
  const [clover, perTest] = ["clover.xml", "coverage-xml"];
  const remove = (path: string) => invoke("remove_path", { path }).catch(() => {});
  // So a run that fails early doesn't show the last results.
  await Promise.all([junit, events, teamcity, ...(coverage ? [clover, perTest] : [])].map((f) => remove(local(f))));
  return {
    junit: local(junit),
    live: local(format === "events" ? events : teamcity),
    details: local(teamcity),
    format,
    clover: local(clover),
    perTest: local(perTest),
    args: [
      "--log-junit", arg(junit),
      ...(format === "events" ? ["--log-events-text", arg(events)] : []),
      "--log-teamcity", arg(teamcity),
      ...(coverage ? ["--coverage-clover", arg(clover), "--coverage-xml", arg(perTest)] : []),
    ],
    cleanUp: () => [junit, events, teamcity].forEach((f) => remove(local(f))),
  };
}

async function cacheDir() {
  const dir = await appCacheDir();
  await invoke("create_dir", { path: dir });
  return dir;
}

async function showCoverage(clover: string, perTest: string) {
  const result = await loadCoverage(clover, getRoot(), perTest);
  if (!result) return status("Coverage failed: no report. Install PCOV or Xdebug for PHP, or see the test output.");
  const percent = result.total ? Math.floor((result.covered / result.total) * 100) : 0;
  status(`Coverage: ${percent}% of lines (${result.covered} of ${result.total}) in ${result.files} files`);
}

/** Stops a run: the selected configuration's, or the only one, or the one you choose when several run. */
export function stopRun(x?: number, y?: number) {
  const mine = runsOf(selected()?.config.name ?? "");
  const targets = mine.length ? mine : runs;
  if (!targets.length) return status("Nothing is running.");
  if (targets.length === 1) return targets[0].terminal.stop();
  const at = x === undefined ? $widget().getBoundingClientRect() : { left: x, bottom: y! };
  showMenu(at.left, at.bottom, [...targets.map((r) => ({ label: r.title, run: () => r.terminal.stop() })), "-", { label: "Stop All", run: () => [...runs].forEach((r) => r.terminal.stop()) }]);
}

/** Stops the test run the Tests tab shows. */
const stopTests = () => (testRun && !testRun.terminal.exited() ? testRun.terminal.stop() : status("No tests are running."));

/** Runs the selected configuration, or asks for one when there's none. */
export function runSelected(mode: Mode = "run") {
  const entry = selected();
  if (!entry) return chooseAndRun(mode, "No run configurations yet. Choose what to run, or add a configuration");
  return runConfig(entry.config, mode);
}

/** Runs the last run again, or asks what to run when nothing ran yet. */
export const rerun = () => (last ? runConfig(last.config, last.mode) : chooseAndRun("run", "Nothing to rerun yet. Choose a configuration to run"));

async function rerunFailed(failed: TestResult[]) {
  const base: RunConfig = last?.config.type === "test" ? last.config : { name: "All Tests", type: "test", scope: "all" };
  const filter = filterFor(failed, await exists("vendor/bin/pest"));
  // A run of its own, not a configuration to keep: Rerun repeats it, as in PhpStorm.
  return runConfig({ ...base, name: `${base.name.replace(/ \(failed tests\)$/, "")} (failed tests)`, scope: "filter", path: undefined, filter }, last?.mode === "debug" ? "debug" : "run");
}

const modeLabels: Record<Mode, string> = { run: "Run", debug: "Debug", coverage: "Run with Coverage", profile: "Profile" };

/** Picks a configuration in the palette and runs it; the palette also offers to edit them. */
export function chooseAndRun(mode: Mode = "run", placeholder = `${modeLabels[mode]}: choose a configuration`) {
  if (!getRoot()) return;
  const items = (): Item[] =>
    configurations().map(({ config, where }) => ({
      label: config.name,
      detail: `${TYPES[config.type].label}${where === "shared" ? " · shared" : where === "temporary" ? " · temporary" : ""} · ${summary(config)}`,
      icon: `codicon-${TYPES[config.type].icon}`,
      run: () => select(config.name).then(() => runConfig(config, mode)),
    }));
  pick(placeholder, (q) => [...(q.trim() ? rank(q, items()) : items()), { label: "Edit Configurations…", detail: "Add, change, or remove run configurations", icon: "codicon-settings-gear", run: () => editConfigurations() }]);
}

/** Opens the Edit Configurations dialog, at `name` or the selected configuration. */
export async function editConfigurations(name = selected()?.config.name, add?: RunConfig["type"]) {
  if (!getRoot()) return;
  const { openConfigurationsDialog } = await import("./runconfigdialog");
  const mode = await openConfigurationsDialog({ entries: configurations(), selected: name, add, root: getRoot(), project: await projectInfo(), save: saveConfigurations });
  const entry = selected();
  if (mode && entry) runConfig(entry.config, mode);
}

// ---- The run widget in the title bar ----

const $widget = () => document.getElementById("run-widget")!;

/** The configuration menu under the widget: pick one, or edit, add, save, and remove them. */
function widgetMenu() {
  const entries = configurations();
  const current = selected();
  const item = ({ config }: Entry): MenuItem => ({ label: `${config.name === current?.config.name ? "✓ " : "   "}${config.name}${runsOf(config.name).length ? " (running)" : ""}`, run: () => select(config.name) });
  const saved = entries.filter((e) => e.where !== "temporary");
  const temporary = entries.filter((e) => e.where === "temporary");
  const r = $widget().querySelector(".run-config")!.getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, [
    ...saved.map(item),
    ...(temporary.length ? ["-" as const, ...temporary.map(item)] : []),
    "-",
    { label: "Edit Configurations…", run: () => editConfigurations() },
    { label: "Add Configuration", items: (Object.keys(TYPES) as RunConfig["type"][]).map((t) => ({ label: TYPES[t].label, run: () => editConfigurations(undefined, t) })) },
    ...(current?.where === "temporary" ? [{ label: `Save “${current.config.name}”`, run: () => saveTemporary() }] : []),
    ...(current ? [{ label: `Delete “${current.config.name}”…`, run: () => deleteConfiguration(current.config.name) }] : []),
  ]);
}

async function deleteConfiguration(name: string) {
  if (!(await confirm(`Delete the run configuration “${name}”?`, "Delete"))) return;
  const entries = configurations().filter((e) => e.config.name !== name);
  await saveConfigurations(entries, entries[0]?.config.name ?? "");
}

/** Draws the widget: the selected configuration, whether it runs, and its Run, Debug, Run with Coverage, and Stop buttons. */
function renderWidget() {
  const el = document.getElementById("run-widget");
  if (!el) return;
  const current = getRoot?.() ? selected() : undefined;
  const c = current?.config;
  const running = c ? runsOf(c.name).length : 0;
  const button = (name: string, title: string, onclick: () => unknown, disabled = false, cls = "") =>
    h("button", { class: `tb-icon ${cls}`, title, ariaLabel: title, disabled, onclick }, icon(name));
  el.hidden = !getRoot?.();
  el.replaceChildren(
    h(
      "button",
      { class: `tb-button run-config${running ? " running" : ""}${current?.where === "temporary" ? " temporary" : ""}`, title: c ? `${c.name}: ${summary(c)}${running ? " (running)" : ""}` : "Add a run configuration", ariaLabel: "Run configuration", ariaHasPopup: "menu", onclick: () => (c ? widgetMenu() : editConfigurations()) },
      icon(c ? TYPES[c.type].icon : "add"),
      running ? h("span", { class: "run-dot", ariaHidden: "true" }) : null,
      h("span", { class: "run-config-name" }, c?.name ?? "Add Configuration…"),
      icon("chevron-down"),
    ),
    button("play", c ? `Run “${c.name}” (⌃R)` : "Run… (⌃R)", () => runSelected(), false, "run-play"),
    button("debug-alt-small", c ? `Debug “${c.name}” (⌃D)` : "Debug… (⌃D)", () => runSelected("debug"), !!c && !TYPES[c.type].php, "run-debug"),
    button("run-coverage", c ? `Run “${c.name}” with Coverage` : "Run with Coverage…", () => runSelected("coverage"), !!c && c.type !== "test"),
    button("debug-stop", running ? `Stop “${c!.name}” (⌘F2)` : runs.length ? "Stop… (⌘F2)" : "Nothing is running", () => stopRun(), !runs.length, "run-stop"),
  );
}

// ---- Tests ----

/**
 * Runs one test, or the whole file when the test has no filter, as a temporary configuration: through
 * `php artisan test` or the test binary. In debug mode, it starts the debugger and runs the test with Xdebug enabled.
 */
export function runTest(path: string, test: TestCase, mode: Mode = "run") {
  const file = path.slice(getRoot().length + 1);
  const stem = file.split("/").pop()!.replace(/\.php$/, "");
  const config: RunConfig = test.filter
    ? { name: `${stem}::${test.name}`, type: "test", scope: "method", path: file, filter: test.name, docker: true }
    : { name: stem, type: "test", scope: "file", path: file, docker: true };
  return runTemporary(config, mode);
}

export const runAllTests = (coverage = false) => runTemporary({ name: "All Tests", type: "test", scope: "all", docker: true }, coverage ? "coverage" : "run");

/** Runs the test around the cursor, or all tests in the file. */
export function runTestAtCursor(editor: monaco.editor.ICodeEditor, mode: Mode = "run") {
  const model = editor.getModel();
  if (!model || !isTestFile(model.uri.fsPath)) return status("Open a test file, and put the cursor in a test, to run it.");
  const test = testAt(findTests(model.getValue()), editor.getPosition()?.lineNumber ?? 1);
  if (!test) return status("This file has no tests to run.");
  return runTest(model.uri.fsPath, test, mode);
}

// ---- Run Anything ----

type ArtisanList = { commands: { name: string; description: string; hidden?: boolean }[] };
let artisanCache: { root: string; items: { name: string; description: string }[] } | undefined;

/** The app's Artisan commands. When artisan fails, throws its first lines, such as a fatal error while the app boots. */
async function artisanCommands() {
  const root = getRoot();
  if (artisanCache?.root !== root) {
    const out = await invoke<string>("run_capture", { cwd: root, program: "php", args: ["artisan", "list", "--format=json"], input: null, anyStatus: true });
    let list: ArtisanList;
    try {
      list = JSON.parse(out);
    } catch {
      const lines = out.replace(/\x1b\[[\d;]*m/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
      throw new Error(lines.slice(0, 2).join(": ") || "php artisan list printed nothing");
    }
    artisanCache = { root, items: list.commands.filter((c) => !c.hidden) };
  }
  return artisanCache.items;
}

/**
 * Run Anything: type an Artisan command with its arguments, such as `make:model Post -m`, a run configuration's
 * name, or any shell command line. What you run becomes a temporary configuration.
 */
export async function runAnything() {
  let artisanError = "";
  const artisan = (await exists("artisan")) ? await artisanCommands().catch((e) => ((artisanError = errorText(e)), [])) : [];
  pick("Run anything: an Artisan command with arguments, a run configuration, or a shell command", (query) => {
    const line = query.trim().replace(/^(php\s+)?artisan\s+/, "");
    // Say why there are no Artisan commands, and offer to run artisan list to see the whole error.
    const problem: Item[] = artisanError
      ? [{ label: "Artisan commands aren't available", detail: `php artisan list failed: ${artisanError}`, icon: "codicon-warning", run: () => ((artisanCache = undefined), runTemporary({ name: "artisan list", type: "artisan", command: "list", docker: false })) }]
      : [];
    if (!line) return problem;
    const [word, ...args] = line.split(/\s+/);
    const suffix = args.length ? ` ${args.join(" ")}` : "";
    const items = artisan.map((c) => ({
      label: c.name,
      detail: c.description,
      run: () => runTemporary({ name: `artisan ${c.name}${suffix}`, type: "artisan", command: `${c.name}${suffix}`, docker: true }),
    }));
    const ranked = rank(word, items).map((i) => ({ ...i, label: `artisan ${i.label}${suffix}` }));
    const configs = rank(
      query.trim(),
      configurations().map(({ config }) => ({ label: config.name, detail: `Run configuration · ${TYPES[config.type].label}`, icon: `codicon-${TYPES[config.type].icon}`, run: () => select(config.name).then(() => runConfig(config)) })),
    ).slice(0, 5);
    const shell = query.trim();
    return [
      ...configs,
      ...ranked.slice(0, 50),
      { label: shell, detail: "Run in terminal", icon: "codicon-terminal", run: () => runTemporary({ name: shell.length > 40 ? `${shell.slice(0, 39)}…` : shell, type: "shell", command: shell }) },
      ...problem,
    ];
  });
}

/** Opens Laravel Tinker in a terminal tab, in the project's container when it's up. */
export const tinker = async () => openTerminal(getRoot(), "Tinker", (await php(["php", "artisan", "tinker"])).command, undefined, undefined, true);

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
  diff: typeof showDiff,
) {
  showDiff = diff;
  loadProfiler = profiler;
  getRoot = root;
  openAt = open;
  status = showStatus;
  initTestResults({
    root,
    openAt: open,
    rerun: () => (testRun ? runConfig(testRun.config, testRun.mode) : rerun()),
    rerunFailed,
    stop: stopTests,
    showDiff: (path, expected, actual, label) => showDiff(path, expected, actual, label),
  });
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
  renderWidget();
}
