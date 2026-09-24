// Code coverage in the gutter: after a test run with coverage, lines that ran get a green mark and lines
// that didn't get a red one. Marks follow their lines as you edit, and stay until the next run or Hide Coverage.
import { invoke } from "@tauri-apps/api/core";
import { monaco } from "./editor";
import { type Coverage, parseClover } from "./junit";

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
  return { covered: counts.filter(Boolean).length, total: counts.length, files: coverage.size };
}

export function hideCoverage() {
  coverage = new Map();
  decorateAll();
}

monaco.editor.onDidCreateModel((model) => {
  if (model.uri.scheme !== "file") return;
  if (coverage.size) decorate(model);
  model.onWillDispose(() => decorations.delete(model));
});
