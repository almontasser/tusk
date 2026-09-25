// Code coverage in the gutter: after a test run with coverage, lines that ran get a green mark and lines
// that didn't get a red one, and a covered line's mark names the tests that ran it. Marks follow their lines as
// you edit, and stay until the next run or Hide Coverage. The Coverage panel shows each folder's coverage and
// lists each file's uncovered lines, least covered file first.
import { invoke } from "@tauri-apps/api/core";
import { monaco } from "./editor";
import { type Coverage, coverageIndex, coveringTests, parseClover, testOf, uncoveredRanges } from "./junit";
import { pick } from "./palette";
import { openTest } from "./testresults";
import { fileGroup } from "./search";
import { containerRoot } from "./sail";
import { showPanelView } from "./terminal";

type Host = { openAt(path: string, line: number): unknown; rerun(): unknown; status(text: string): void };
let host: Host;
export const initCoverage = (h: Host) => (host = h);


let coverage: Coverage = new Map();
const decorations = new Map<monaco.editor.ITextModel, string[]>();

/** Where each file's per-test report is in PHPUnit's XML coverage, and the tests by line of those read so far. */
let perTest: { dir: string; files: Map<string, string> } | null = null;
const testsByFile = new Map<string, Promise<Map<number, string[]>>>();

/** The tests that ran each line of a file, or an empty map without a per-test report. */
function testsIn(path: string): Promise<Map<number, string[]>> {
  const href = perTest?.files.get(path);
  if (!href) return Promise.resolve(new Map());
  if (!testsByFile.has(path))
    testsByFile.set(path, invoke<string>("read_file", { path: `${perTest!.dir}/${href}` }).then(coveringTests, () => new Map()));
  return testsByFile.get(path)!;
}

const label = (id: string) => {
  const { className, name } = testOf(id);
  return `${className.split("\\").pop()} › ${name}`;
};

/** Marks each covered and uncovered line. Once the file's per-test report is read, a covered line's mark names its tests. */
function decorate(model: monaco.editor.ITextModel, tests = new Map<number, string[]>()) {
  const lines = [...(coverage.get(model.uri.fsPath) ?? [])].filter(([line]) => line <= model.getLineCount());
  const tooltip = (line: number, count: number) => {
    if (!count) return "Not covered";
    const ran = tests.get(line) ?? [];
    const by = ran.length ? `, by ${ran.length === 1 ? "1 test" : `${ran.length} tests`}:\n${ran.slice(0, 8).map(label).join("\n")}${ran.length > 8 ? `\n…and ${ran.length - 8} more` : ""}` : "";
    return `Covered: ran ${count} ${count === 1 ? "time" : "times"}${by}`;
  };
  const ids = model.deltaDecorations(
    decorations.get(model) ?? [],
    lines.map(([line, count]) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        linesDecorationsClassName: count ? "coverage-hit" : "coverage-miss",
        linesDecorationsTooltip: tooltip(line, count),
        stickiness: 1,
      },
    })),
  );
  decorations.set(model, ids);
  if (!tests.size && perTest?.files.has(model.uri.fsPath))
    testsIn(model.uri.fsPath).then((found) => found.size && !model.isDisposed() && coverage.has(model.uri.fsPath) && decorate(model, found));
}

/** Lists the tests that ran the line with the cursor; choosing one opens it. */
export async function showTestsCoveringLine(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  const line = editor.getPosition()?.lineNumber;
  if (!model || !line) return;
  if (!coverage.has(model.uri.fsPath)) return host.status("No coverage for this file. Run tests with coverage first.");
  if (!perTest) return host.status("This coverage run has no per-test report. Run tests with coverage again.");
  // A line inside a statement that spans lines counts from the statement's first line, the one with a mark.
  const lines = coverage.get(model.uri.fsPath)!;
  let at = line;
  while (at > 0 && !lines.has(at)) at--;
  const ran = (await testsIn(model.uri.fsPath)).get(at) ?? [];
  if (!ran.length) return host.status(lines.get(at) ? `No test is recorded as covering line ${at}.` : `Line ${at} isn't covered by any test.`);
  pick(`Tests that ran line ${at}`, () =>
    ran.map((id) => {
      const { className, name } = testOf(id);
      return { label: name, detail: className, icon: "codicon-beaker", run: () => openTest(className, name) };
    }),
  );
}

const decorateAll = () => monaco.editor.getModels().filter((m) => m.uri.scheme === "file").forEach((m) => decorate(m));

/**
 * Shows a Clover report's coverage in every editor. Returns the covered and total statement counts,
 * or null when there's no report, such as when PHP has neither PCOV nor Xdebug.
 */
export async function loadCoverage(report: string, root: string, perTestDir?: string): Promise<{ covered: number; total: number; files: number } | null> {
  const parsed = parseClover(await invoke<string>("read_file", { path: report }).catch(() => ""));
  if (!parsed.size) return null;
  const local = (path: string) => (path.startsWith(containerRoot + "/") ? root + path.slice(containerRoot.length) : path);
  coverage = new Map([...parsed].map(([path, lines]) => [local(path), lines]));
  const index = perTestDir ? await invoke<string>("read_file", { path: `${perTestDir}/index.xml` }).catch(() => "") : "";
  perTest = index ? { dir: perTestDir!, files: new Map([...coverageIndex(index).files].map(([path, href]) => [local(path), href])) } : null;
  testsByFile.clear();
  decorateAll();
  const counts = [...coverage.values()].flatMap((lines) => [...lines.values()]);
  const result = { covered: counts.filter(Boolean).length, total: counts.length, files: coverage.size };
  renderPanel(root, result);
  return result;
}

export function hideCoverage() {
  coverage = new Map();
  perTest = null;
  testsByFile.clear();
  decorateAll();
  q(".tests-summary").textContent = "Coverage hidden. Run tests with coverage to show it again.";
  q(".coverage-list").replaceChildren();
  q(".coverage-folders").replaceChildren();
}

// ---- The Coverage panel ----

const panel = document.createElement("div");
panel.className = "tests coverage";
panel.innerHTML = `
  <div class="tests-toolbar">
    <button data-run="rerun" title="Rerun with coverage (⌃R)"><span class="codicon codicon-debug-rerun"></span></button>
    <button data-run="hide" title="Hide coverage"><span class="codicon codicon-eye-closed"></span></button>
    <span class="tests-summary"></span>
  </div>
  <ul class="coverage-folders" aria-label="Coverage by folder"></ul>
  <ul class="coverage-list" aria-label="Uncovered lines"></ul>`;
const q = (sel: string) => panel.querySelector(sel) as HTMLElement;
q('[data-run="rerun"]').onclick = () => host.rerun();
q('[data-run="hide"]').onclick = hideCoverage;

const percent = (covered: number, total: number) => (total ? Math.floor((covered / total) * 100) : 100);

/** The folder the file list shows, relative to the project, or "" for every file. */
let folder = "";

/**
 * Shows each folder's coverage, nested, then the files with uncovered lines, least covered first. Clicking a
 * folder limits the files to it. Files start expanded until about 200 rows show.
 */
function renderPanel(root: string, result: { covered: number; total: number; files: number }) {
  const all = [...coverage]
    .filter(([path]) => path.startsWith(root + "/"))
    .map(([path, lines]) => ({ path, rel: path.slice(root.length + 1), ranges: uncoveredRanges(lines), covered: [...lines.values()].filter(Boolean).length, total: lines.size }));
  // Every folder that holds a covered file, with the lines of all the files under it.
  const folders = new Map<string, { covered: number; total: number }>();
  for (const f of all)
    for (let i = f.rel.indexOf("/"); i > 0; i = f.rel.indexOf("/", i + 1)) {
      const totals = folders.get(f.rel.slice(0, i)) ?? folders.set(f.rel.slice(0, i), { covered: 0, total: 0 }).get(f.rel.slice(0, i))!;
      totals.covered += f.covered;
      totals.total += f.total;
    }
  if (!folders.has(folder)) folder = "";
  q(".coverage-folders").replaceChildren(
    ...[...folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, totals]) => {
      const li = document.createElement("li");
      li.className = `coverage-folder${name === folder ? " active" : ""}`;
      li.style.paddingLeft = `${8 + (name.split("/").length - 1) * 14}px`;
      li.title = folder === name ? "Show the files of every folder" : `Show only the files in ${name}`;
      li.innerHTML = `<span class="codicon codicon-folder"></span><span class="name"></span><span class="percent"></span>`;
      li.querySelector(".name")!.textContent = name.slice(name.lastIndexOf("/") + 1);
      li.querySelector(".percent")!.textContent = `${percent(totals.covered, totals.total)}% · ${totals.covered}/${totals.total}`;
      li.onclick = () => ((folder = folder === name ? "" : name), renderPanel(root, result));
      return li;
    }),
  );
  const files = all
    .filter((f) => f.ranges.length && (!folder || f.rel.startsWith(folder + "/")))
    .sort((a, b) => a.covered / a.total - b.covered / b.total || a.path.localeCompare(b.path));
  const full = all.filter((f) => !f.ranges.length && (!folder || f.rel.startsWith(folder + "/"))).length;
  q(".tests-summary").textContent = `${percent(result.covered, result.total)}% of lines covered (${result.covered} of ${result.total}) · ${folder ? `in ${folder}, ` : ""}${files.length} ${files.length === 1 ? "file has" : "files have"} uncovered lines${full ? `, ${full} fully covered` : ""}`;
  let shown = 0;
  q(".coverage-list").replaceChildren(
    ...files.map((f) => {
      const open = shown + f.ranges.length <= 200;
      if (open) shown += f.ranges.length;
      // Read when the file's rows first show, so collapsed files cost nothing.
      let source: Promise<string[]> | undefined;
      const text = () => (source ??= invoke<string>("read_file", { path: f.path }).then((t) => t.split("\n"), () => []));
      const row = ([first, last]: [number, number]) => {
        const li = document.createElement("li");
        li.className = "find-match";
        const line = document.createElement("span");
        line.className = "line";
        line.textContent = first === last ? String(first) : `${first}–${last}`;
        const preview = document.createElement("span");
        preview.className = "preview";
        text().then((lines) => (preview.textContent = lines[first - 1]?.trim() ?? ""));
        li.append(line, preview);
        li.onclick = () => host.openAt(f.path, first);
        return li;
      };
      return fileGroup(f.path, f.ranges, row, open, undefined, `${percent(f.covered, f.total)}%`);
    }),
  );
  showPanelView("Coverage", panel);
}

monaco.editor.onDidCreateModel((model) => {
  if (model.uri.scheme !== "file") return;
  if (coverage.size) decorate(model);
  model.onWillDispose(() => decorations.delete(model));
});
