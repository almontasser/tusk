// The Tests tab: a tree of the last run's results, read from the JUnit report the run wrote.
import { invoke } from "@tauri-apps/api/core";
import { findTests } from "./phptests";
import { type LiveTest, parseEvents, parseJUnit, sameTest, type TestResult } from "./junit";
import { showPanelView } from "./terminal";

type Host = { root(): string; openAt(path: string, line: number): Promise<unknown>; rerun(): unknown; rerunFailed(failed: TestResult[]): unknown };

let host: Host;
const icons = { passed: "pass", failed: "error", skipped: "circle-slash" };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}
const icon = (status: LiveTest["status"]) =>
  el("span", status === "running" ? "codicon codicon-loading codicon-modifier-spin test-running" : `codicon codicon-${icons[status]} test-${status}`);
const seconds = (s: number) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`);

const panel = el("div", "tests");
panel.innerHTML = `
  <div class="tests-toolbar">
    <button data-run="rerun" title="Rerun (⌃R)"><span class="codicon codicon-debug-rerun"></span></button>
    <button data-run="failed" title="Rerun failed tests"><span class="codicon codicon-run-errors"></span></button>
    <span class="tests-summary"></span>
  </div>
  <div class="tests-body">
    <ul class="tests-tree" aria-label="Test results"></ul>
    <pre class="tests-detail"></pre>
  </div>`;
const q = (sel: string) => panel.querySelector(sel) as HTMLElement;
let failed: TestResult[] = [];
q('[data-run="rerun"]').onclick = () => host.rerun();
q('[data-run="failed"]').onclick = () => failed.length && host.rerunFailed(failed);

// Reports from Sail name files by their path in the container.
const absolute = (file: string) => (file.startsWith("/") ? file.replace(/^\/var\/www\/html(?=\/)/, host.root()) : `${host.root()}/${file}`);

/** Opens a test at its failure, or at its declaration, which Pest's report leaves out. */
async function open(r: TestResult) {
  const path = absolute(r.file);
  let line = r.line;
  if (!line) {
    const source = await invoke<string>("read_file", { path }).catch(() => "");
    line = findTests(source).find((t) => sameTest(r.name, t.name))?.line ?? 1;
  }
  host.openAt(path, line);
}

/** Reads the report and shows the Tests tab. Returns false when the run wrote no report. */
export async function showResults(report: string): Promise<boolean> {
  const xml = await invoke<string>("read_file", { path: report }).catch(() => "");
  const results = parseJUnit(xml);
  if (!results.length) return false;
  failed = results.filter((r) => r.status === "failed");
  const count = (s: TestResult["status"]) => results.filter((r) => r.status === s).length;
  const parts = [`${count("passed")} passed`, failed.length && `${failed.length} failed`, count("skipped") && `${count("skipped")} skipped`].filter(Boolean);
  const summary = q(".tests-summary");
  summary.textContent = `${parts.join(", ")} · ${seconds(results.reduce((t, r) => t + r.time, 0))}`;
  summary.className = `tests-summary ${failed.length ? "test-failed" : "test-passed"}`;
  (q('[data-run="failed"]') as HTMLButtonElement).disabled = !failed.length;

  const detail = q(".tests-detail");
  detail.textContent = failed.length ? "Select a test to see its failure." : "All tests passed.";
  const classes = new Map<string, TestResult[]>();
  for (const r of results) classes.set(r.className, [...(classes.get(r.className) ?? []), r]);
  const tree = q(".tests-tree");
  tree.replaceChildren(
    ...[...classes].map(([className, cases]) => {
      const status = cases.some((c) => c.status === "failed") ? "failed" : cases.every((c) => c.status === "skipped") ? "skipped" : "passed";
      const li = el("li");
      const row = el("div", "test-row");
      row.append(icon(status), el("span", "name", className.replace(/^(P\\)?Tests\\/, "")), el("span", "time", seconds(cases.reduce((t, c) => t + c.time, 0))));
      row.title = className;
      const children = el("ul");
      children.hidden = status !== "failed"; // Classes that passed start collapsed.
      row.onclick = () => (children.hidden = !children.hidden);
      row.ondblclick = () => open({ ...cases[0], line: 1 });
      for (const c of cases) {
        const item = el("li", "test-row test-case");
        item.append(icon(c.status), el("span", "name", c.name), el("span", "time", seconds(c.time)));
        item.onclick = () => {
          tree.querySelectorAll(".selected").forEach((s) => s.classList.remove("selected"));
          item.classList.add("selected");
          detail.textContent = c.message || (c.status === "skipped" ? "Skipped." : `Passed in ${seconds(c.time)}.`);
          open(c);
        };
        children.append(item);
      }
      li.append(row, children);
      return li;
    }),
  );
  showPanelView("Tests", panel);
  return true;
}

/**
 * Shows progress while tests run, from PHPUnit's event stream. Rows can't be opened yet, because the stream
 * has no file paths; the JUnit report replaces this view when the run ends.
 */
export async function showLive(events: string, running: boolean) {
  const text = await invoke<string>("read_file", { path: events }).catch(() => "");
  const { total, tests } = parseEvents(text);
  const done = tests.filter((t) => t.status !== "running");
  const failures = tests.filter((t) => t.status === "failed").length;
  const summary = q(".tests-summary");
  summary.textContent = `${running ? "Running" : "Stopped"}: ${done.length}${total ? ` of ${total}` : ""}${failures ? ` · ${failures} failed` : ""}`;
  summary.className = `tests-summary ${failures ? "test-failed" : ""}`;
  q(".tests-detail").textContent = running ? "Results open when the run ends." : "The run ended without a report. Its terminal tab has the output.";
  const classes = new Map<string, LiveTest[]>();
  for (const t of tests) classes.set(t.className, [...(classes.get(t.className) ?? []), t]);
  q(".tests-tree").replaceChildren(
    ...[...classes].map(([className, cases]) => {
      const li = el("li");
      const status = cases.some((c) => c.status === "failed") ? "failed" : cases.some((c) => c.status === "running") ? "running" : "passed";
      const row = el("div", "test-row");
      row.append(icon(status), el("span", "name", className.replace(/^Tests\\/, "")));
      const children = el("ul");
      for (const c of cases) {
        const item = el("li", "test-row test-case");
        item.append(icon(c.status), el("span", "name", c.name));
        children.append(item);
      }
      li.append(row, children);
      return li;
    }),
  );
  showPanelView("Tests", panel);
}

export function initTestResults(h: Host) {
  host = h;
}
