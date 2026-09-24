// Code coverage in the gutter: after a test run with coverage, lines that ran get a green mark and lines
// that didn't get a red one. Marks follow their lines as you edit, and stay until the next run or Hide Coverage.
// The Coverage panel lists each file's uncovered lines, least covered file first.
import { invoke } from "@tauri-apps/api/core";
import { monaco } from "./editor";
import { type Coverage, parseClover, uncoveredRanges } from "./junit";
import { fileGroup } from "./search";
import { showPanelView } from "./terminal";

type Host = { openAt(path: string, line: number): unknown; rerun(): unknown };
let host: Host;
export const initCoverage = (h: Host) => (host = h);

/** Where Sail's containers mount the project, so report paths from a run in Sail map back to this Mac. */
const SAIL_ROOT = "/var/www/html";

let coverage: Coverage = new Map();
const decorations = new Map<monaco.editor.ITextModel, string[]>();

function decorate(model: monaco.editor.ITextModel) {
  const lines = [...(coverage.get(model.uri.fsPath) ?? [])].filter(([line]) => line <= model.getLineCount());
  const ids = model.deltaDecorations(
    decorations.get(model) ?? [],
    lines.map(([line, count]) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        linesDecorationsClassName: count ? "coverage-hit" : "coverage-miss",
        linesDecorationsTooltip: count ? `Covered: ran ${count} ${count === 1 ? "time" : "times"}` : "Not covered",
        stickiness: 1,
      },
    })),
  );
  decorations.set(model, ids);
}

const decorateAll = () => monaco.editor.getModels().filter((m) => m.uri.scheme === "file").forEach(decorate);

/**
 * Shows a Clover report's coverage in every editor. Returns the covered and total statement counts,
 * or null when there's no report, such as when PHP has neither PCOV nor Xdebug.
 */
export async function loadCoverage(report: string, root: string): Promise<{ covered: number; total: number; files: number } | null> {
  const parsed = parseClover(await invoke<string>("read_file", { path: report }).catch(() => ""));
  if (!parsed.size) return null;
  coverage = new Map([...parsed].map(([path, lines]) => [path.startsWith(SAIL_ROOT + "/") ? root + path.slice(SAIL_ROOT.length) : path, lines]));
  decorateAll();
  const counts = [...coverage.values()].flatMap((lines) => [...lines.values()]);
  const result = { covered: counts.filter(Boolean).length, total: counts.length, files: coverage.size };
  renderPanel(root, result);
  return result;
}

export function hideCoverage() {
  coverage = new Map();
  decorateAll();
  q(".tests-summary").textContent = "Coverage hidden. Run tests with coverage to show it again.";
  q(".coverage-list").replaceChildren();
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
  <ul class="coverage-list" aria-label="Uncovered lines"></ul>`;
const q = (sel: string) => panel.querySelector(sel) as HTMLElement;
q('[data-run="rerun"]').onclick = () => host.rerun();
q('[data-run="hide"]').onclick = hideCoverage;

const percent = (covered: number, total: number) => (total ? Math.floor((covered / total) * 100) : 100);

/** Lists files with uncovered lines, least covered first. Files start expanded until about 200 rows show. */
function renderPanel(root: string, result: { covered: number; total: number; files: number }) {
  const files = [...coverage]
    .map(([path, lines]) => ({ path, ranges: uncoveredRanges(lines), covered: [...lines.values()].filter(Boolean).length, total: lines.size }))
    .filter((f) => f.ranges.length && f.path.startsWith(root + "/"))
    .sort((a, b) => a.covered / a.total - b.covered / b.total || a.path.localeCompare(b.path));
  const full = result.files - files.length;
  q(".tests-summary").textContent = `${percent(result.covered, result.total)}% of lines covered (${result.covered} of ${result.total}) · ${files.length} ${files.length === 1 ? "file has" : "files have"} uncovered lines${full ? `, ${full} fully covered` : ""}`;
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
