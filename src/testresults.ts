// The Tests tab, as PhpStorm's test runner window: a tree of the run's tests, live while they run, then read from
// the JUnit report the run wrote; a header with counts, time, and progress; and each test's failure, comparison,
// stack, and output.
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { h, iconButton } from "./dom";
import { findTests } from "./phptests";
import { classFile, type LiveTest, localPath, parseEvents, parseFailure, parseJUnit, parseTeamcity, sameTest, testKey, type TestResult, withDetails } from "./junit";
import { listNav } from "./listnav";
import { pathsFor, psr4From, type Psr4 } from "./psr4";
import { containerRoot } from "./sail";
import { splitter } from "./splitter";
import { showError, status } from "./status";
import { showPanelView } from "./terminal";

type Host = {
  root(): string;
  openAt(path: string, line: number): Promise<unknown>;
  rerun(): unknown;
  rerunFailed(failed: TestResult[]): unknown;
  stop(): unknown;
  showDiff(path: string, expected: string, actual: string, label: string): unknown;
};

let host: Host;

type Status = LiveTest["status"];
/** A test in the tree, from the live log while the run goes, and from the JUnit report after. */
type Row = Omit<TestResult, "status" | "time" | "file" | "line" | "message"> & { status: Status; time?: number; file?: string; line?: number; message?: string; key: string };

/** The run the tab shows. */
const run = { title: "", running: false, total: 0, started: 0, code: null as number | null, stopped: false, xml: "" };
let rows: Row[] = [];
let results: TestResult[] = [];

// The view options, per user, as PhpStorm keeps them.
const OPTIONS = "tests.view";
const options = { passed: true, ignored: true, byDuration: false, autoScroll: true };
try {
  Object.assign(options, JSON.parse(localStorage.getItem(OPTIONS) ?? "{}"));
} catch {}
let filter = "";
/** Classes you expanded or collapsed, by name: true when expanded. Others follow their status. */
const expanded = new Map<string, boolean>();

const statusIcons: Record<Status, string> = { passed: "pass", failed: "error", skipped: "circle-slash", running: "loading" };
const statusIcon = (s: Status) => h("span", { class: `codicon codicon-${statusIcons[s]} test-${s}${s === "running" ? " codicon-modifier-spin" : ""}`, ariaHidden: "true" });
const seconds = (s: number) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- The view ----

const toggle = (name: string, title: string, key: keyof typeof options) => {
  const b = iconButton(name, title, () => {
    options[key] = !options[key];
    b.ariaPressed = String(options[key]);
    try {
      localStorage.setItem(OPTIONS, JSON.stringify(options));
    } catch {}
    render();
  });
  b.ariaPressed = String(options[key]);
  b.classList.add("toggle");
  return b;
};
const rerunButton = iconButton("debug-rerun", "Rerun", () => host.rerun());
const failedButton = iconButton("run-errors", "Rerun Failed Tests", () => {
  const failed = results.filter((r) => r.status === "failed");
  if (failed.length) host.rerunFailed(failed);
});
const stopButton = iconButton("debug-stop", "Stop (⌘F2)", () => host.stop());
const exportButton = iconButton("export", "Export Test Results…", () => exportResults());
const filterInput = h("input", { type: "search", class: "tests-filter", placeholder: "Filter tests", ariaLabel: "Filter tests", spellcheck: false });
filterInput.oninput = () => ((filter = filterInput.value.trim().toLowerCase()), render());
filterInput.onkeydown = (e) => {
  if (e.key === "ArrowDown") e.preventDefault(), tree.focus();
  if (e.key === "Escape" && filterInput.value) e.stopPropagation(), (filterInput.value = ""), (filter = ""), render();
};
const summary = h("span", { class: "tests-summary", role: "status" });
const bar = h("div", { class: "tests-progress-bar" });
const progress = h("div", { class: "tests-progress", role: "progressbar", ariaLabel: "Test progress" }, bar);
const tree = h("div", { class: "tests-tree", role: "tree", ariaLabel: "Test results" });
const detail = h("div", { class: "tests-detail", tabIndex: 0, ariaLabel: "Test output" });
const handle = h("div", { class: "pane-splitter" });
const panel = h(
  "div",
  { class: "tests" },
  h(
    "div",
    { class: "tests-toolbar" },
    rerunButton,
    failedButton,
    stopButton,
    h("span", { class: "toolbar-separator" }),
    toggle("pass", "Show Passed", "passed"),
    toggle("circle-slash", "Show Ignored", "ignored"),
    toggle("watch", "Sort by Duration", "byDuration"),
    toggle("list-selection", "Track Running Test", "autoScroll"),
    h("span", { class: "toolbar-separator" }),
    iconButton("expand-all", "Expand All", () => (rows.forEach((r) => expanded.set(r.className, true)), render())),
    iconButton("collapse-all", "Collapse All", () => (rows.forEach((r) => expanded.set(r.className, false)), render())),
    exportButton,
    filterInput,
  ),
  h("div", { class: "tests-header" }, summary, progress),
  h("div", { class: "tests-body" }, tree, handle, detail),
);
splitter(handle, { target: tree, axis: "x", edge: "end", label: "Resize the test tree", min: 180, minRest: 200, save: "tests.tree" });

const nav = listNav(tree, {
  open: (row) => openRow(row),
  toggle: (row, expand) => (expanded.set(row.dataset.class!, expand), render()),
  onSelect: (row) => showDetail(row.dataset.key!),
});
tree.addEventListener("dblclick", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
  if (row) openRow(row);
});

/** Classes in run order, each with its tests, after the filter and the view options. */
function groups() {
  const classes = new Map<string, Row[]>();
  for (const r of rows) {
    const shown = (r.status !== "passed" || options.passed) && (r.status !== "skipped" || options.ignored);
    if (!shown || (filter && !`${r.className}::${r.name}`.toLowerCase().includes(filter))) continue;
    (classes.get(r.className) ?? classes.set(r.className, []).get(r.className)!).push(r);
  }
  const time = (list: Row[]) => list.reduce((t, r) => t + (r.time ?? 0), 0);
  const list = [...classes].map(([className, tests]) => ({ className, tests: options.byDuration ? [...tests].sort((a, b) => (b.time ?? 0) - (a.time ?? 0)) : tests, time: time(tests) }));
  return options.byDuration ? list.sort((a, b) => b.time - a.time) : list;
}

const classStatus = (tests: Row[]): Status =>
  tests.some((t) => t.status === "failed") ? "failed" : tests.some((t) => t.status === "running") ? "running" : tests.every((t) => t.status === "skipped") ? "skipped" : "passed";

function render() {
  const counts = { passed: 0, failed: 0, skipped: 0, running: 0 };
  for (const r of rows) counts[r.status]++;
  const done = counts.passed + counts.failed + counts.skipped;
  const total = Math.max(run.total, rows.length);
  const time = results.length ? results.reduce((t, r) => t + r.time, 0) : (Date.now() - run.started) / 1000;
  const failed = counts.failed ? ` · ${counts.failed} failed` : "";
  summary.textContent = run.running
    ? `Running: ${done}${total ? ` of ${total}` : ""}${failed}`
    : !rows.length
      ? run.stopped || run.code
        ? "The run ended without results. Its terminal tab has the output."
        : "No tests ran."
      : `${run.stopped ? `Stopped after ${done} of ${plural(total, "test")}` : plural(done, "test")}: ${[counts.passed && `${counts.passed} passed`, counts.failed && `${counts.failed} failed`, counts.skipped && `${counts.skipped} skipped`].filter(Boolean).join(", ")} · ${seconds(time)}`;
  summary.className = `tests-summary${counts.failed ? " test-failed" : !run.running && rows.length && !run.stopped ? " test-passed" : ""}`;
  const share = total ? done / total : run.running ? 0 : 1;
  bar.style.width = `${Math.round(share * 100)}%`;
  progress.classList.toggle("failed", counts.failed > 0);
  progress.hidden = !run.running && !rows.length;
  progress.ariaValueNow = String(Math.round(share * 100));
  rerunButton.disabled = run.running || !run.title;
  failedButton.disabled = run.running || !results.some((r) => r.status === "failed");
  stopButton.disabled = !run.running;
  exportButton.disabled = !run.xml;

  const list = groups();
  tree.replaceChildren(
    ...(list.length
      ? list.flatMap(({ className, tests, time }) => {
          const status = classStatus(tests);
          const open = expanded.get(className) ?? (status === "failed" || status === "running" || list.length === 1 || !!filter);
          const head = h(
            "div",
            { class: "test-row test-class", role: "treeitem", title: className, data: { key: `class:${className}`, class: className } },
            h("span", { class: `codicon codicon-chevron-${open ? "down" : "right"} twisty`, ariaHidden: "true" }),
            statusIcon(status),
            h("span", { class: "name" }, className.replace(/^(P\\)?Tests\\/, "")),
            time ? h("span", { class: "time" }, seconds(time)) : null,
          );
          head.setAttribute("aria-level", "1");
          head.setAttribute("aria-expanded", String(open));
          head.onclick = (e) => (e.target as HTMLElement).classList.contains("twisty") && (expanded.set(className, !open), render());
          const children = open
            ? tests.map((t) => {
                const row = h(
                  "div",
                  { class: "test-row test-case", role: "treeitem", title: t.name, data: { key: t.key, class: className } },
                  statusIcon(t.status),
                  h("span", { class: "name" }, t.name),
                  t.time !== undefined ? h("span", { class: "time" }, seconds(t.time)) : null,
                );
                row.setAttribute("aria-level", "2");
                return row;
              })
            : [];
          return [head, ...children];
        })
      : [h("div", { class: "tests-empty" }, rows.length ? "No tests match the filter and view options." : run.running ? "Starting…" : "")]),
  );
  // Track the running test, as PhpStorm does, without moving the selection.
  if (run.running && options.autoScroll) tree.querySelector(".test-running")?.closest(".test-row")?.scrollIntoView({ block: "nearest" });
  const selected = nav.selected();
  if (selected && !selected.startsWith("class:")) showDetail(selected, false);
}

// ---- The detail pane ----

/** A file a report names, on this Mac: a container's path maps to the project, and a relative one is inside it. */
const onMac = (file: string) => localPath(file, host.root(), containerRoot);

function showDetail(key: string, reset = true) {
  if (key.startsWith("class:")) {
    const tests = rows.filter((r) => r.className === key.slice(6));
    const failed = tests.filter((t) => t.status === "failed").length;
    detail.replaceChildren(h("p", { class: "test-heading" }, statusIcon(classStatus(tests)), key.slice(6)), h("p", { class: "muted" }, `${plural(tests.length, "test")}${failed ? `, ${failed} failed` : ""}. Press Enter or double-click to open the class.`));
    return;
  }
  const t = rows.find((r) => r.key === key);
  if (!t) return;
  if (!reset && detail.dataset.key === key && detail.dataset.status === t.status) return; // Keep the scroll while more results arrive.
  detail.dataset.key = key;
  detail.dataset.status = t.status;
  const failure = t.message ? parseFailure(t.message, t) : undefined;
  const state = { running: "Running…", passed: `Passed${t.time !== undefined ? ` in ${seconds(t.time)}` : ""}.`, skipped: "Skipped.", failed: `Failed${t.time !== undefined ? ` in ${seconds(t.time)}` : ""}.` }[t.status];
  detail.replaceChildren(
    ...[
    h("p", { class: "test-heading" }, statusIcon(t.status), t.name, h("span", { class: "muted" }, ` ${state}`)),
    failure?.text ? h("pre", { class: "test-message" }, failure.text) : null,
    failure?.expected !== undefined
      ? h(
          "p",
          {},
          h("button", { class: "link", onclick: () => host.showDiff(t.file ? onMac(t.file) : "Comparison", failure.expected!, failure.actual ?? "", `Expected ↔ Actual: ${t.name}`) }, "<Click to see difference>"),
        )
      : null,
    failure?.frames.length
      ? h(
          "ul",
          { class: "test-frames", ariaLabel: "Stack" },
          ...failure.frames.map((f) => {
            const vendor = /(^|\/)vendor\//.test(f.file);
            const label = onMac(f.file).replace(`${host.root()}/`, "");
            return h("li", {}, h("button", { class: `link${vendor ? " vendor" : ""}`, title: `Open ${label} at line ${f.line}`, onclick: () => openFile(f.file, f.line) }, `${label}:${f.line}`));
          }),
        )
      : null,
    t.output ? h("pre", { class: "test-output" }, t.output) : null,
    t.status === "failed" && !failure ? h("p", { class: "muted" }, "No message. The terminal tab has the run's output.") : null,
    ].filter((n) => !!n),
  );
}

/** Opens a file a report names at a line; a path from another container, such as /app, is tried by its folders under the project. */
async function openFile(file: string, line: number) {
  const path = onMac(file);
  const tries = [path, ...[...path.matchAll(/\/(?=(?:app|tests|src|vendor|database|routes|config|resources)\/)/g)].map((m) => `${host.root()}${path.slice(m.index)}`)];
  for (const p of tries) if (await invoke<boolean>("path_exists", { path: p }).catch(() => false)) return host.openAt(p, line);
  showError(`Can't find ${file} in the project.`);
}

// ---- Opening tests ----

/** composer.json's PSR-4 folders for the project, read once per project, to find a test class's file. */
let autoload: { root: string; psr4: Promise<Psr4> } | undefined;

/**
 * The file a test class is in: through composer.json's PSR-4 folders (`autoload-dev`), the first that exists,
 * or else Laravel's layout, where `Tests\Unit\ATest` is in `tests/Unit/ATest.php`.
 */
async function fileOfClass(className: string): Promise<string> {
  const root = host.root();
  if (autoload?.root !== root) autoload = { root, psr4: invoke<string>("read_file", { path: `${root}/composer.json` }).then(psr4From, () => ({})) };
  for (const rel of pathsFor(className, await autoload.psr4)) if (await invoke<boolean>("path_exists", { path: `${root}/${rel}` })) return rel;
  return classFile(className);
}

/** Opens a test by its class and name, at its declaration. */
export const openTest = async (className: string, name: string) => open({ name, className, file: await fileOfClass(className), line: 0 });

/** Opens a test at its failure, or at its declaration, which Pest's report and PHPUnit's event stream leave out. */
async function open(r: { name: string; className: string; file?: string; line?: number }) {
  const path = onMac(r.file ?? (await fileOfClass(r.className)));
  let line = r.line;
  if (!line) {
    const source = await invoke<string>("read_file", { path }).catch(() => "");
    line = findTests(source).find((t) => sameTest(r.name, t.name))?.line ?? 1;
  }
  host.openAt(path, line);
}

function openRow(row: HTMLElement) {
  if (row.dataset.key!.startsWith("class:")) {
    const className = row.dataset.class!;
    const file = rows.find((r) => r.className === className && r.file)?.file;
    return (file ? Promise.resolve(file) : fileOfClass(className)).then((f) => host.openAt(onMac(f), 1));
  }
  const t = rows.find((r) => r.key === row.dataset.key);
  if (t) open(t);
}

// ---- Runs ----

/** Clears the tab for a new run and shows it. */
export function startTestRun(title: string) {
  Object.assign(run, { title, running: true, total: 0, started: Date.now(), code: null, stopped: false, xml: "" });
  rows = [];
  results = [];
  liveLength = -1;
  expanded.clear();
  nav.select("");
  detail.replaceChildren(h("p", { class: "muted" }, "Select a test to see its output."));
  delete detail.dataset.key;
  render();
  showPanelView("Tests", panel);
}

/** The live log's length at the last update, so a tick with nothing new skips redrawing. */
let liveLength = -1;

/**
 * Shows progress while tests run, from PHPUnit's event stream or a TeamCity log, with each failure's message as
 * soon as it fails. The JUnit report replaces this view when the run ends; without one, `running` false shows the
 * live tree as it stopped.
 */
export async function showLive(events: string, running: boolean, format: "events" | "teamcity" = "events") {
  const text = await invoke<string>("read_file", { path: events }).catch(() => "");
  if (running && text.length === liveLength) return;
  liveLength = text.length;
  const { total, tests } = format === "teamcity" ? parseTeamcity(text) : parseEvents(text);
  run.total = total;
  if (!running) Object.assign(run, { running: false, stopped: true });
  rows = tests.map((t) => ({ ...t, status: !running && t.status === "running" ? "skipped" : t.status, key: testKey(t.className, t.name) }));
  render();
  showPanelView("Tests", panel);
}

/**
 * Reads the JUnit report, and failures' comparisons and stacks from the TeamCity log (`details`), and shows them.
 * Returns false when the run wrote no report.
 */
export async function showResults(report: string, details: string, code: number | null): Promise<boolean> {
  const [xml, log] = await Promise.all([report, details].map((path) => invoke<string>("read_file", { path }).catch(() => "")));
  const parsed = parseJUnit(xml);
  Object.assign(run, { running: false, code });
  if (!parsed.length) return false;
  results = withDetails(parsed, parseTeamcity(log).tests);
  run.xml = xml;
  rows = results.map((r) => ({ ...r, key: testKey(r.className, r.name) }));
  run.total = rows.length;
  render();
  showPanelView("Tests", panel);
  // Select the first failure, as PhpStorm does, unless you selected a test.
  const first = rows.find((r) => r.status === "failed");
  if (first && !nav.selected()) nav.select(first.key);
  return true;
}

/** Saves the run's JUnit report where you choose. */
async function exportResults() {
  const path = await save({ title: "Export Test Results", defaultPath: `${host.root()}/test-results.xml`, filters: [{ name: "JUnit XML", extensions: ["xml"] }] }).catch(() => null);
  if (!path) return;
  try {
    await invoke("write_file", { path, contents: run.xml });
    status(`Exported the test results to ${path}.`);
  } catch (e) {
    showError("Can't export the test results", e);
  }
}

export function initTestResults(h: Host) {
  host = h;
}
