// Three-pane merge: your version on the left, theirs on the right, and the file itself in the middle,
// where the inline Accept links resolve each conflict. The middle pane shares the file's model, so
// its edits are the real file.
import { invoke } from "@tauri-apps/api/core";
import { appCacheDir } from "@tauri-apps/api/path";
import { accept, acceptAll, type Choice, decorateConflicts } from "./conflicts";
import { h, icon } from "./dom";
import { createEditor, monaco } from "./editor";
import { showMenu } from "./files";
import { gitStatus, refreshListeners } from "./git";
import { alignmentGaps, type Conflict, isConflict, lineChanges, parseConflicts, resolveSimple } from "./gitparse";
import { confirm } from "./palette";
import { showError, status, withProgress } from "./status";
import { addEditor } from "./settings";
import { closeView, showEditorView } from "./terminal";

type Host = {
  root(): string;
  ensureModel(path: string): Promise<monaco.editor.ITextModel>;
  saveFile(path: string): Promise<unknown>;
  openFile(path: string): unknown;
  /** Stages the resolved file (git add, or git rm to delete it) and refreshes. Resolves to whether it worked. */
  resolved(rel: string, remove?: boolean): Promise<boolean>;
  status(text: string): void;
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let host: Host;
let panes: { ours: monaco.editor.IStandaloneCodeEditor; result: monaco.editor.IStandaloneCodeEditor; theirs: monaco.editor.IStandaloneCodeEditor } | null = null;
let current: {
  rel: string;
  path: string;
  sides: monaco.editor.ITextModel[];
  base: string;
  ours: string;
  theirs: string;
  /** The side that deleted the file, in a modify/delete conflict. */
  deleted?: "ours" | "theirs";
  listener: monaco.IDisposable;
} | null = null;

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

/** The conflicts left in the result pane. */
const conflictsLeft = () => (panes?.result.getModel() ? parseConflicts(panes.result.getModel()!.getLinesContent()) : []);

/** The conflict at the cursor, or the next one below it, or the last one. */
function conflictAtCursor() {
  const list = conflictsLeft();
  const line = panes?.result.getPosition()?.lineNumber ?? 1;
  return list.find((c) => line <= c.end) ?? list.at(-1);
}

let currentDecoration: monaco.editor.IEditorDecorationsCollection | undefined;

function updateCount() {
  if (!current || !panes) return;
  const list = conflictsLeft();
  const at = conflictAtCursor();
  const index = at ? list.findIndex((c) => c.start === at.start) + 1 : 0;
  $("merge-count").textContent = list.length ? `Conflict ${index} of ${list.length} left` : current.deleted ? "" : "All conflicts resolved";
  $<HTMLButtonElement>("merge-resolved").disabled = list.length > 0;
  for (const id of ["merge-prev", "merge-next", "merge-accept-left", "merge-accept-right", "merge-accept-both", "merge-simple"]) $<HTMLButtonElement>(id).disabled = !list.length;
  currentDecoration ??= panes.result.createDecorationsCollection();
  currentDecoration.set(at ? [{ range: new monaco.Range(at.start, 1, at.end, 1), options: { isWholeLine: true, className: "merge-current-conflict" } }] : []);
  renderFiles();
}

/** Moves the cursor to the next or previous conflict, wrapping around. */
function goToConflict(by: 1 | -1) {
  const list = conflictsLeft();
  if (!panes || !list.length) return host.status("No conflicts left in this file.");
  const line = panes.result.getPosition()?.lineNumber ?? 1;
  const next = by > 0 ? (list.find((c) => c.start > line) ?? list[0]) : ([...list].reverse().find((c) => c.end < line) ?? list.at(-1)!);
  panes.result.setPosition({ lineNumber: next.start + 1, column: 1 });
  panes.result.revealLineInCenter(next.start);
  panes.result.focus();
  updateCount();
}

function acceptCurrent(choice: Choice) {
  const c = conflictAtCursor();
  const model = panes?.result.getModel();
  if (!c || !model) return host.status("No conflicts left in this file.");
  accept(model, c.start, choice);
  // Move on to the next conflict, as PhpStorm does.
  if (conflictsLeft().length) goToConflict(1);
}

/**
 * Resolves each conflict whose two sides changed different lines of the base, and leaves the rest. A conflict's base
 * comes from its diff3 section, or else from `git merge-file --diff3` run on the three versions.
 */
async function applyNonConflicting() {
  const model = panes?.result.getModel();
  if (!model || !current) return;
  const lines = model.getLinesContent();
  const list = parseConflicts(lines);
  const sidesOf = (ls: string[], c: Conflict) => [ls.slice(c.start, (c.base ?? c.separator) - 1), ls.slice(c.separator, c.end - 1)];
  const key = (ours: string[], theirs: string[]) => `${ours.join("\n")}\0${theirs.join("\n")}`;
  const bases = new Map<string, string[]>();
  if (list.some((c) => !c.base)) {
    try {
      const dir = `${await appCacheDir()}/merge`;
      await invoke("create_dir", { path: dir });
      const [b, o, t] = [`${dir}/base`, `${dir}/ours`, `${dir}/theirs`];
      await Promise.all([invoke("write_file", { path: b, contents: current.base }), invoke("write_file", { path: o, contents: current.ours }), invoke("write_file", { path: t, contents: current.theirs })]);
      // merge-file exits with the number of conflicts, so any exit status is fine.
      const out = await invoke<string>("run_capture", { cwd: host.root(), program: "git", args: ["merge-file", "-p", "--diff3", o, b, t], input: null, anyStatus: true });
      const merged = out.split("\n");
      for (const c of parseConflicts(merged)) if (c.base) bases.set(key(...(sidesOf(merged, c) as [string[], string[]])), merged.slice(c.base, c.separator - 1));
    } catch (e) {
      return showError("Can't find the common base of the conflicts", e);
    }
  }
  const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
  for (const c of list) {
    const [ours, theirs] = sidesOf(lines, c);
    const base = c.base ? lines.slice(c.base, c.separator - 1) : bases.get(key(ours, theirs));
    const merged = base && resolveSimple(base, ours, theirs);
    if (!merged) continue;
    const range = c.end < model.getLineCount() ? new monaco.Range(c.start, 1, c.end + 1, 1) : new monaco.Range(c.start, 1, c.end, model.getLineMaxColumn(c.end));
    const eol = model.getEOL();
    edits.push({ range, text: merged.length ? merged.join(eol) + (c.end < model.getLineCount() ? eol : "") : "" });
  }
  if (edits.length) model.pushEditOperations([], edits, () => null);
  const left = list.length - edits.length;
  status(
    edits.length ? `Merged ${edits.length} of ${list.length} ${list.length === 1 ? "conflict" : "conflicts"}.${left ? ` ${left} changed the same lines on both sides and need you.` : ""}` : "Every conflict changed the same lines on both sides, so each needs you.",
    "app",
    "info",
  );
  if (left) goToConflict(1);
}

// ---- Conflicted files ----

/** Files resolved in the merge tool since the operation started, to show beside those still conflicted. */
const resolvedFiles = new Set<string>();

function conflictedFiles() {
  return gitStatus()?.files.filter(isConflict).map((f) => f.path) ?? [];
}

function renderFiles() {
  const list = $("merge-files");
  const open = conflictedFiles();
  const all = [...new Set([...open, ...resolvedFiles, ...(current ? [current.rel] : [])])].sort();
  list.hidden = all.length < 2;
  if (list.hidden) return;
  list.replaceChildren(
    ...all.map((rel) => {
      const done = !open.includes(rel);
      const li = h("li", { role: "option", class: `${done ? "done" : ""}${rel === current?.rel ? " current" : ""}`, title: `${rel}${done ? ": resolved" : ": has conflicts"}`, data: { key: rel, label: rel.split("/").pop()! } }, icon(done ? "check" : "warning"), h("span", { class: "name" }, rel.split("/").pop()!), h("span", { class: "muted" }, rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""));
      li.onclick = () => rel !== current?.rel && openMerge(rel);
      return li;
    }),
  );
}

// ---- Opening ----

/** Which index stages a conflicted file has: 1 base, 2 yours, 3 theirs. A missing 2 or 3 means that side deleted it. */
async function stagesOf(rel: string) {
  const out = await invoke<string>("run_capture", { cwd: host.root(), program: "git", args: ["--no-optional-locks", "ls-files", "-u", "--", rel], input: null });
  return new Set(out.split("\n").filter(Boolean).map((l) => l.split(/\s+/)[2]));
}

/** Opens the merge view for a conflicted file (relative to the project). */
export async function openMerge(rel: string) {
  clearMerge();
  if (!panes) createPanes();
  const path = `${host.root()}/${rel}`;
  $("merge-path").textContent = rel;
  $("merge-count").textContent = "";
  $("merge-loading").hidden = false;
  $("merge-deleted").hidden = true;
  showEditorView(`${rel.split("/").pop()} (merge)`, $("merge"), "git-merge", clearMerge);
  const loaded = await withProgress(`Loading the versions of ${rel}…`, () => Promise.all([show(`:1:${rel}`), show(`:2:${rel}`), show(`:3:${rel}`), host.ensureModel(path), stagesOf(rel)]), { error: `Can't open ${rel} in the merge tool` });
  $("merge-loading").hidden = true;
  if (!loaded) return closeMerge();
  const [base, ours, theirs, model, stages] = loaded;
  const language = model.getLanguageId();
  const sides = [monaco.editor.createModel(ours, language), monaco.editor.createModel(theirs, language)];
  panes!.ours.setModel(sides[0]);
  panes!.theirs.setModel(sides[1]);
  panes!.result.setModel(model);
  markChanges(panes!.ours, base, ours, "merge-ours");
  markChanges(panes!.theirs, base, theirs, "merge-theirs");
  const deleted = !stages.has("2") ? "ours" : !stages.has("3") ? "theirs" : undefined;
  current = { rel, path, sides, base, ours, theirs, deleted, listener: model.onDidChangeContent(updateCount) };
  $("merge-ours-title").textContent = deleted === "ours" ? "Yours: deleted in yours" : "Yours";
  $("merge-theirs-title").textContent = deleted === "theirs" ? "Theirs: deleted in theirs" : "Theirs";
  // One side deleted the file and the other changed it: there are no conflict blocks, just a choice.
  const banner = $("merge-deleted");
  banner.hidden = !deleted;
  if (deleted)
    banner.querySelector("span")!.textContent = `${deleted === "ours" ? "You" : "They"} deleted ${rel.split("/").pop()}, and ${deleted === "ours" ? "they" : "you"} changed it. Keep the file as the result shows it, or delete it.`;
  updateCount();
  align();
  panes!.result.focus();
  if (conflictsLeft().length) goToConflict(1);
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

/** Saves and stages the file, then opens the next conflicted file, or closes when there's none. */
async function markResolved(remove = false) {
  if (!current) return;
  const { rel, path } = current;
  try {
    if (!remove) await host.saveFile(path);
  } catch (e) {
    return showError(`Can't save ${rel}`, e);
  }
  if (!(await host.resolved(rel, remove))) return; // The failure is already on screen; the file stays open.
  resolvedFiles.add(rel);
  status(remove ? `Deleted ${rel} and marked it resolved.` : `Resolved ${rel}.`, "app", "info");
  const next = conflictedFiles().find((f) => f !== rel);
  if (next) return openMerge(next);
  resolvedFiles.clear();
  closeMerge();
}

export function initMerge(h: Host) {
  host = h;
  $("merge-close").onclick = closeMerge;
  $("merge-resolved").onclick = () => markResolved();
  $("merge-keep-file").onclick = () => markResolved();
  $("merge-delete-file").onclick = async () => current && (await confirm(`Delete ${current.rel}? Your edits to it in the merge are lost.`, "Delete File")) && markResolved(true);
  $("merge-prev").onclick = () => goToConflict(-1);
  $("merge-next").onclick = () => goToConflict(1);
  $("merge-accept-left").onclick = () => acceptCurrent("current");
  $("merge-accept-right").onclick = () => acceptCurrent("incoming");
  $("merge-accept-both").onclick = () => acceptCurrent("both");
  $("merge-simple").onclick = applyNonConflicting;
  $("merge-more").onclick = (e) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const model = panes?.result.getModel();
    showMenu(r.left, r.bottom + 2, [
      { label: "Accept All Yours", run: () => model && acceptAll(model, "current") },
      { label: "Accept All Theirs", run: () => model && acceptAll(model, "incoming") },
      "-",
      { label: "Open File in Editor", run: () => current && (closeMerge(), host.openFile(`${host.root()}/${current.rel}`)) },
    ]);
  };
  // F7 and ⇧F7 move between conflicts, and ⌥⇧← and ⌥⇧→ accept a side, anywhere in the merge view.
  $("merge").addEventListener(
    "keydown",
    (e) => {
      if (e.key === "F7" && !e.metaKey && !e.altKey) goToConflict(e.shiftKey ? -1 : 1);
      else if (e.altKey && e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) acceptCurrent(e.key === "ArrowLeft" ? "current" : "incoming");
      else return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  refreshListeners.push(() => !$("merge").hidden && renderFiles());
}
