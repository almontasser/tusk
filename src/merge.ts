// Three-pane merge: your version on the left, theirs on the right, and the file itself in the middle,
// where the inline Accept links resolve each conflict. The middle pane shares the file's model, so
// its edits are the real file.
import { invoke } from "@tauri-apps/api/core";
import { accept, acceptAll, type Choice, decorateConflicts } from "./conflicts";
import { createEditor, monaco } from "./editor";
import { alignmentGaps, lineChanges, parseConflicts } from "./gitparse";
import { addEditor } from "./settings";
import { closeView, showEditorView } from "./terminal";

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
  // The merge view draws its own Accept buttons, as view zones whose height the alignment counts.
  result.updateOptions({ codeLens: false, stickyScroll: { enabled: false } });
  result.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.CONTENT_VIEW_ZONE) return;
    const row = buttonRows.get(e.target.detail.viewZoneId);
    const { posx, posy } = e.event;
    const button = [...(row?.querySelectorAll("button") ?? [])].find((b) => {
      const r = b.getBoundingClientRect();
      return posx >= r.left && posx <= r.right && posy >= r.top && posy <= r.bottom;
    });
    button?.click();
  });
  decorateConflicts(result);
  panes = { ours: side($("merge-ours-pane")), result, theirs: side($("merge-theirs-pane")) };
  const { ours, theirs } = panes;
  for (const ed of [ours, result, theirs]) ed.onDidScrollChange((e) => e.scrollTopChanged && syncFrom(ed));
  result.onDidChangeModelContent(() => {
    clearTimeout(alignTimer);
    alignTimer = setTimeout(align, 150);
  });
}

// ---- Alignment ----
// Blank striped space is added where a pane has fewer lines than the others (view zones), so lines
// the three versions share sit side by side and the panes are the same height. Scrolling then copies
// one position to all. The result's conflict buttons are zones too, so their height is counted.

const zoneIds = new Map<monaco.editor.ICodeEditor, string[]>();
/** Button rows by zone id. Monaco's text layer covers view zones, so clicks are found by position. */
const buttonRows = new Map<string, HTMLElement>();
let alignTimer: ReturnType<typeof setTimeout> | undefined;
let syncing = false;

function setZones(ed: monaco.editor.IStandaloneCodeEditor, zones: monaco.editor.IViewZone[]) {
  ed.changeViewZones((acc) => {
    for (const id of zoneIds.get(ed) ?? []) acc.removeZone(id);
    zoneIds.set(ed, zones.map((z) => acc.addZone(z)));
  });
}

const spacer = (afterLineNumber: number, heightInLines: number): monaco.editor.IViewZone => {
  const domNode = document.createElement("div");
  domNode.className = "merge-spacer";
  return { afterLineNumber, heightInLines, domNode };
};

/** A line of Accept buttons above a conflict in the result pane. */
function conflictButtons(model: monaco.editor.ITextModel, start: number): monaco.editor.IViewZone {
  const domNode = document.createElement("div");
  domNode.className = "merge-conflict-actions";
  for (const [label, choice] of [["Accept Yours", "current"], ["Accept Theirs", "incoming"], ["Accept Both", "both"]] as [string, Choice][]) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => accept(model, start, choice);
    domNode.append(b);
  }
  return { afterLineNumber: start - 1, heightInLines: 1, domNode };
}

function align() {
  if (!panes?.result.getModel() || !panes.ours.getModel() || !panes.theirs.getModel()) return;
  const model = panes.result.getModel()!;
  const conflicts = parseConflicts(model.getLinesContent()).map((c) => c.start);
  const gaps = alignmentGaps(panes.ours.getModel()!.getLinesContent(), model.getLinesContent(), panes.theirs.getModel()!.getLinesContent(), conflicts);
  setZones(panes.ours, gaps.ours.map(([after, n]) => spacer(after, n)));
  setZones(panes.theirs, gaps.theirs.map(([after, n]) => spacer(after, n)));
  const rows = conflicts.map((start) => conflictButtons(model, start));
  setZones(panes.result, [...rows, ...gaps.result.map(([after, n]) => spacer(after, n))]);
  buttonRows.clear();
  zoneIds.get(panes.result)!.slice(0, rows.length).forEach((id, i) => buttonRows.set(id, rows[i].domNode));
  syncFrom(panes.result);
}

function syncFrom(source: monaco.editor.IStandaloneCodeEditor) {
  if (syncing || !panes) return;
  syncing = true;
  try {
    // Immediate: a smooth scroll would fire its events after `syncing` is reset and scroll the others back.
    for (const ed of [panes.ours, panes.result, panes.theirs]) if (ed !== source) ed.setScrollTop(source.getScrollTop(), monaco.editor.ScrollType.Immediate);
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
  clearMerge();
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
  $("merge-path").textContent = rel;
  updateCount();
  showEditorView(`${rel.split("/").pop()} (merge)`, $("merge"), "git-merge", clearMerge);
  align();
  panes!.result.focus();
}

const closeMerge = () => closeView($("merge"));

function clearMerge() {
  if (!current) return;
  current.listener.dispose();
  panes?.ours.setModel(null);
  panes?.theirs.setModel(null);
  panes?.result.setModel(null);
  current.sides.forEach((m) => m.dispose());
  current = null;
  for (const ed of [panes?.ours, panes?.result, panes?.theirs]) if (ed) setZones(ed, []);
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
