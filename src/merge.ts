// Three-pane merge: your version on the left, theirs on the right, and the file itself in the middle,
// where the inline Accept links resolve each conflict. The middle pane shares the file's model, so
// its edits are the real file.
import { invoke } from "@tauri-apps/api/core";
import { acceptAll, decorateConflicts } from "./conflicts";
import { createEditor, monaco } from "./editor";
import { lineChanges, lineMap, parseConflicts } from "./gitparse";
import { addEditor } from "./settings";

type Host = {
  root(): string;
  ensureModel(path: string): Promise<monaco.editor.ITextModel>;
  saveFile(path: string): Promise<unknown>;
  /** Stages the resolved file (git add) and refreshes the commit view. */
  resolved(rel: string): Promise<unknown>;
  status(text: string): void;
};

const $ = (id: string) => document.getElementById(id)!;
let host: Host;
let panes: { ours: monaco.editor.IStandaloneCodeEditor; result: monaco.editor.IStandaloneCodeEditor; theirs: monaco.editor.IStandaloneCodeEditor } | null = null;
let current: { rel: string; path: string; sides: monaco.editor.ITextModel[]; listener: monaco.IDisposable } | null = null;

const show = (spec: string) =>
  invoke<string>("run_capture", { cwd: host.root(), program: "git", args: ["--no-optional-locks", "show", spec], input: null }).catch(() => "");

function createPanes() {
  const side = (el: HTMLElement) => {
    const ed = createEditor(el);
    ed.updateOptions({ readOnly: true, stickyScroll: { enabled: false } });
    addEditor(ed);
    return ed;
  };
  const result = createEditor($("merge-result"));
  addEditor(result);
  decorateConflicts(result);
  panes = { ours: side($("merge-ours-pane")), result, theirs: side($("merge-theirs-pane")) };
  const { ours, theirs } = panes;
  for (const ed of [ours, result, theirs]) ed.onDidScrollChange((e) => e.scrollTopChanged && syncFrom(ed));
  result.onDidChangeModelContent(() => {
    clearTimeout(remapTimer);
    remapTimer = setTimeout(remap, 200);
  });
}

// ---- Aligned scrolling ----
// Scrolling any pane scrolls the others to the matching line, found by lineMap between each side
// and the result, so unchanged code stays level even where one side added or removed lines.

type Maps = Record<"ours" | "theirs", { to: (line: number) => number; from: (line: number) => number }>;
let maps: Maps | null = null;
let remapTimer: ReturnType<typeof setTimeout> | undefined;
let syncing = false;

function remap() {
  if (!panes?.result.getModel() || !panes.ours.getModel() || !panes.theirs.getModel()) return (maps = null);
  const lines = (ed: monaco.editor.IStandaloneCodeEditor) => ed.getModel()!.getLinesContent();
  const result = lines(panes.result);
  const side = (ed: monaco.editor.IStandaloneCodeEditor) => ({ to: lineMap(result, lines(ed)), from: lineMap(lines(ed), result) });
  maps = { ours: side(panes.ours), theirs: side(panes.theirs) };
}

/** Puts `line` at the same height in `ed` as `source` shows its first visible line, keeping the offset within it. */
function scrollTo(ed: monaco.editor.IStandaloneCodeEditor, line: number, offset: number) {
  // Immediate: a smooth scroll would fire its events after `syncing` is reset and scroll the others back.
  ed.setScrollTop(ed.getTopForLineNumber(line) + offset, monaco.editor.ScrollType.Immediate);
}

function syncFrom(source: monaco.editor.IStandaloneCodeEditor) {
  if (syncing || !panes || !maps) return;
  const first = source.getVisibleRanges()[0]?.startLineNumber;
  if (!first) return;
  const offset = source.getScrollTop() - source.getTopForLineNumber(first);
  syncing = true;
  try {
    // Every pane is mapped through the result, the one text that both sides share lines with.
    const resultLine = source === panes.result ? first : source === panes.ours ? maps.ours.from(first) : maps.theirs.from(first);
    if (source !== panes.result) scrollTo(panes.result, resultLine, offset);
    if (source !== panes.ours) scrollTo(panes.ours, maps.ours.to(resultLine), offset);
    if (source !== panes.theirs) scrollTo(panes.theirs, maps.theirs.to(resultLine), offset);
  } finally {
    syncing = false;
  }
}

/** Highlights the lines a side changed from the common base. */
function markChanges(editor: monaco.editor.IStandaloneCodeEditor, base: string, text: string, className: string) {
  const changes = lineChanges(base.split("\n"), text.split("\n")).filter((c) => c.kind !== "deleted");
  editor.createDecorationsCollection(
    changes.map((c) => ({ range: new monaco.Range(c.start, 1, c.end, 1), options: { isWholeLine: true, className, linesDecorationsClassName: `${className}-gutter` } })),
  );
}

function updateCount() {
  if (!current || !panes) return;
  const count = parseConflicts(panes.result.getModel()!.getLinesContent()).length;
  $("merge-count").textContent = count ? `${count} ${count === 1 ? "conflict" : "conflicts"} left` : "All conflicts resolved";
  ($("merge-resolved") as HTMLButtonElement).disabled = count > 0;
}

/** Opens the merge view for a conflicted file (relative to the project). */
export async function openMerge(rel: string) {
  closeMerge();
  if (!panes) createPanes();
  const path = `${host.root()}/${rel}`;
  const [base, ours, theirs, model] = await Promise.all([show(`:1:${rel}`), show(`:2:${rel}`), show(`:3:${rel}`), host.ensureModel(path)]);
  const language = model.getLanguageId();
  const sides = [monaco.editor.createModel(ours, language), monaco.editor.createModel(theirs, language)];
  panes!.ours.setModel(sides[0]);
  panes!.theirs.setModel(sides[1]);
  panes!.result.setModel(model);
  markChanges(panes!.ours, base, ours, "merge-ours");
  markChanges(panes!.theirs, base, theirs, "merge-theirs");
  current = { rel, path, sides, listener: model.onDidChangeContent(updateCount) };
  remap();
  $("merge-path").textContent = rel;
  updateCount();
  document.querySelectorAll<HTMLElement>("#editor, #history, #diff").forEach((e) => (e.hidden = true));
  $("merge").hidden = false;
  panes!.result.focus();
}

export function closeMerge() {
  if (!current) return;
  current.listener.dispose();
  panes?.ours.setModel(null);
  panes?.theirs.setModel(null);
  panes?.result.setModel(null);
  current.sides.forEach((m) => m.dispose());
  current = null;
  maps = null;
  $("merge").hidden = true;
  $("editor").hidden = false;
}

async function markResolved() {
  if (!current) return;
  const { rel, path } = current;
  await host.saveFile(path);
  await host.resolved(rel);
  host.status(`Resolved ${rel}`);
  closeMerge();
}

export function initMerge(h: Host) {
  host = h;
  $("merge-close").onclick = closeMerge;
  $("merge-resolved").onclick = markResolved;
  $("merge-accept-ours").onclick = () => panes?.result.getModel() && acceptAll(panes.result.getModel()!, "current");
  $("merge-accept-theirs").onclick = () => panes?.result.getModel() && acceptAll(panes.result.getModel()!, "incoming");
}
