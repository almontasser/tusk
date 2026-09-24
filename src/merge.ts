// Three-pane merge: your version on the left, theirs on the right, and the file itself in the middle,
// where the inline Accept links resolve each conflict. The middle pane shares the file's model, so
// its edits are the real file.
import { invoke } from "@tauri-apps/api/core";
import { acceptAll, decorateConflicts } from "./conflicts";
import { createEditor, monaco } from "./editor";
import { lineChanges, parseConflicts } from "./gitparse";
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
  // The sides follow the middle's scrolling. Lines only roughly align, as each side has its own changes.
  result.onDidScrollChange((e) => {
    panes!.ours.setScrollTop(e.scrollTop);
    panes!.theirs.setScrollTop(e.scrollTop);
  });
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
