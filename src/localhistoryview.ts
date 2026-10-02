// The Local History tab, as PhpStorm's Local History window: a file's or a folder's versions on the left, each with
// its time and what kept it (a save, another program's change, a git command, a refactoring, a delete, a revert),
// and the project's labels among them; on the right, a diff of the selected version with the file now, or of two
// versions (select one, then Space or ⌘-click another). Revert sets the file, or with a label every file under the
// folder, back, after asking, and the toast offers Undo.
import { invoke } from "@tauri-apps/api/core";
import { h, icon, toast } from "./dom";
import { monaco } from "./editor";
import { age } from "./gitparse";
import { listNav } from "./listnav";
import { currentText, type FileVersion, fileVersions, folderVersions, type Label, labels, putLabel, readVersion, revertFiles, undoRevert } from "./localhistory";
import { versionAt } from "./localhistorydata";
import { confirm } from "./palette";
import { splitter } from "./splitter";
import { errorText, showError, withProgress } from "./status";
import { showPanelView } from "./terminal";
import { keyText, mod } from "./platform.ts";

type Host = { root(): string; openFile(path: string): unknown };
let host: Host;
export const initLocalHistoryView = (h: Host) => (host = h);

const relative = (path: string) => (path === host.root() ? "the project" : path.slice(host.root().length + 1));
const when = (time: number) => new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const versionKey = (v: FileVersion) => `v:${v.path}:${v.name}`;
const labelKey = (l: Label) => `l:${l.time}`;

// ---- The view, made once ----

const list = h("ul", { class: "lh-list", role: "listbox", ariaLabel: "Versions" });
const filterInput = h("input", { class: "lh-filter", placeholder: "Filter by file", ariaLabel: "Filter by file", spellcheck: false });
const titleEl = h("span", { class: "lh-title" });
const revertButton = h("button", { title: "Revert to the selected version or label", ariaLabel: "Revert" }, icon("discard"), " Revert");
const labelButton = h("button", { title: "Put a label: a named point in the whole project's history", ariaLabel: "Put Label" }, icon("tag"), " Put Label…");
const openButton = h("button", { title: "Open the file in the editor", ariaLabel: "Open in editor" }, icon("go-to-file"));
const refreshButton = h("button", { title: "Refresh", ariaLabel: "Refresh" }, icon("refresh"));
const diffLabel = h("div", { class: "lh-diff-label", ariaLive: "polite" });
const diffBox = h("div", { class: "lh-diff-editor" });
const message = h("div", { class: "lh-message" });
const right = h("div", { class: "lh-right" }, diffLabel, message, diffBox);
const handle = h("div", { class: "pane-splitter" });
const view = h(
  "div",
  { class: "lh-view" },
  h("div", { class: "debug-toolbar lh-toolbar", role: "toolbar", ariaLabel: "Local history" }, titleEl, filterInput, revertButton, labelButton, openButton, refreshButton),
  h("div", { class: "lh-body" }, list, handle, right),
);
splitter(handle, { target: list, axis: "x", edge: "end", label: "Resize the version list", min: 200, minRest: 240, save: "localHistory" });

/** What the tab shows: a file's or a folder's history. */
let target = { path: "", folder: false };
let versions: FileVersion[] = [];
let projectLabels: Label[] = [];
/** The second version, for a diff of two: Space or ⌘-click marks it. */
let marked = "";
let loadId = 0;

const nav = listNav(list, {
  open: () => openFile(),
  onSelect: () => showSelected(),
  label: (row) => row.dataset.label ?? "",
});
list.addEventListener("keydown", (e) => {
  if (e.target !== list) return;
  if (e.key === " ") mark(nav.selected());
  else if (e.key === "Backspace" && mod(e)) revert();
  else return;
  e.preventDefault();
  e.stopPropagation();
});
list.addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
  if (row && (mod(e) || e.shiftKey)) mark(row.dataset.key!);
});
filterInput.oninput = () => render();
filterInput.onkeydown = (e) => {
  if (e.key !== "ArrowDown") return;
  e.preventDefault();
  list.focus();
  const first = list.querySelector<HTMLElement>("[data-key]");
  if (first && !nav.selectedRow()) nav.select(first.dataset.key!);
};
revertButton.onclick = () => revert();
labelButton.onclick = () => putLabel(() => load());
openButton.onclick = () => openFile();
refreshButton.onclick = () => load();

let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
function setDiff(path: string, original: string, modified: string) {
  diffEditor ??= monaco.editor.createDiffEditor(diffBox, {
    automaticLayout: true,
    readOnly: true,
    originalEditable: false,
    fontSize: 12,
    fontFamily: "JetBrains Mono, JetBrainsMono Nerd Font Mono, JetBrainsMono Nerd Font, SF Mono, Menlo, Cascadia Mono, Consolas, DejaVu Sans Mono, monospace",
    minimap: { enabled: false },
  });
  const old = diffEditor.getModel();
  // A non-file scheme keeps these models away from the language servers; the path's extension picks the language.
  const uri = (side: string) => monaco.Uri.from({ scheme: "localhistory", path: `/${side}/${relative(path)}`, query: String(Date.now()) });
  diffEditor.setModel({ original: monaco.editor.createModel(original, undefined, uri("before")), modified: monaco.editor.createModel(modified, undefined, uri("after")) });
  old?.original.dispose();
  old?.modified.dispose();
  diffBox.hidden = false;
  message.hidden = true;
}
function showMessage(...content: (Node | string)[]) {
  diffBox.hidden = true;
  message.hidden = false;
  message.replaceChildren(...content);
}

/** Opens the tab for a file's or a folder's history. */
export async function openLocalHistory(path: string, folder = false) {
  if (!host.root()) return;
  if (path !== host.root() && !path.startsWith(host.root() + "/")) return showError("Local history covers files in the project");
  target = { path, folder };
  marked = "";
  deleted = new Set();
  filterInput.value = "";
  filterInput.hidden = !folder;
  titleEl.textContent = folder ? `Folder: ${relative(path)}` : relative(path);
  showPanelView(`Local History: ${path === host.root() ? "Project" : path.split("/").pop()}`, view);
  await load();
  list.focus();
}

/** Reads the versions and labels again, keeping the selection. */
async function load() {
  const id = ++loadId;
  list.replaceChildren(h("li", { class: "muted lh-note" }, "Loading the history…"));
  showMessage("");
  diffLabel.textContent = "";
  const read = async (signal: AbortSignal, report?: (text: string) => void) => {
    const count = h("span", {});
    if (target.folder) list.firstElementChild?.append(" ", count);
    const found = target.folder
      ? await folderVersions(target.path, signal, (done, total) => {
          count.textContent = `${done} of ${total} files`;
          report?.(`Reading the local history: ${done} of ${total} files…`);
        })
      : await fileVersions(target.path);
    return [found, await labels()] as const;
  };
  let result: readonly [FileVersion[], Label[]] | undefined;
  let failure: unknown;
  if (target.folder) result = await withProgress(`Reading the local history of ${relative(target.path)}…`, read, { cancellable: true });
  else result = await read(new AbortController().signal).catch((e) => ((failure = e), undefined));
  if (id !== loadId) return;
  if (!result) {
    list.replaceChildren(h("li", { class: "muted lh-note", role: "alert" }, failure ? `Couldn't read the local history: ${errorText(failure)} ` : "Didn't read the local history. ", h("button", { class: "link", onclick: () => load() }, "Retry")));
    return;
  }
  [versions, projectLabels] = result;
  render();
  if (!nav.selectedRow()) {
    const first = list.querySelector<HTMLElement>("[data-key^='v:']");
    if (first) nav.select(first.dataset.key!);
  } else showSelected();
}

/** Which versions' files no longer exist, for the folder view. */
let deleted = new Set<string>();

function render() {
  const q = filterInput.value.trim().toLowerCase();
  const shown = versions.filter((v) => !q || relative(v.path).toLowerCase().includes(q));
  if (!shown.length) {
    list.replaceChildren(
      h(
        "li",
        { class: "muted lh-note" },
        q ? "No versions of files that match." : `No local history for ${relative(target.path)} yet. A version is kept each time you save, before a revert or a delete, and when another program changes a file.`,
      ),
    );
    showMessage("");
    return;
  }
  // Labels go among the versions by time, from the newest version's time back to the oldest's.
  const oldest = shown.at(-1)!.time;
  const rows: HTMLElement[] = [];
  let l = 0;
  const inRange = projectLabels.filter((x) => x.time >= oldest);
  for (const v of shown) {
    while (l < inRange.length && inRange[l].time >= v.time) rows.push(labelRow(inRange[l++]));
    rows.push(versionRow(v));
  }
  list.replaceChildren(...rows);
  if (target.folder) checkDeleted(shown);
}

function versionRow(v: FileVersion) {
  const key = versionKey(v);
  return h(
    "li",
    { role: "option", class: `lh-row${key === marked ? " marked" : ""}`, title: `${when(v.time)}: ${v.action}${key === marked ? "\nMarked for comparison" : ""}`, data: { key, label: target.folder ? relative(v.path) : v.action } },
    h("span", { class: "lh-time" }, when(v.time)),
    h("span", { class: "lh-age muted" }, age(v.time / 1000)),
    h("span", { class: "lh-action" }, v.action),
    target.folder ? h("span", { class: "lh-path muted" }, relative(v.path)) : null,
    target.folder && deleted.has(v.path) ? h("span", { class: "lh-deleted" }, "Deleted") : null,
    key === marked ? icon("compare-changes") : null,
  );
}

function labelRow(l: Label) {
  return h("li", { role: "option", class: "lh-row lh-label", title: `Label, put ${when(l.time)}`, data: { key: labelKey(l), label: l.name } }, icon("tag"), h("span", { class: "lh-action" }, l.name), h("span", { class: "lh-age muted" }, when(l.time)));
}

/** Marks which files are gone, once per load, for the Deleted badge. */
async function checkDeleted(shown: FileVersion[]) {
  const paths = [...new Set(shown.map((v) => v.path))].filter((p) => !deleted.has(p));
  const gone = new Set<string>();
  for (const p of paths) if (!(await invoke<boolean>("path_exists", { path: p }).catch(() => true))) gone.add(p);
  if (!gone.size) return;
  deleted = new Set([...deleted, ...gone]);
  render();
}

const selectedVersion = () => versions.find((v) => versionKey(v) === nav.selected());
const selectedLabel = () => projectLabels.find((l) => labelKey(l) === nav.selected());

function mark(key: string) {
  if (!key.startsWith("v:")) return;
  marked = marked === key ? "" : key;
  render();
  showSelected();
}

/** The diff for the selection: a version with the file now, two marked versions, or what a label covers. */
async function showSelected() {
  const id = loadId;
  const v = selectedVersion();
  const label = selectedLabel();
  const other = versions.find((x) => versionKey(x) === marked);
  try {
    if (v && other && other !== v && other.path === v.path) {
      const [older, newer] = other.time < v.time ? [other, v] : [v, other];
      const [a, b] = await Promise.all([readVersion(older), readVersion(newer)]);
      if (id !== loadId) return;
      diffLabel.textContent = `${relative(v.path)}: ${when(older.time)} (${older.action}) ↔ ${when(newer.time)} (${newer.action})`;
      return setDiff(v.path, a, b);
    }
    if (v) {
      const [text, now] = await Promise.all([readVersion(v), currentText(v.path)]);
      if (id !== loadId || selectedVersion() !== v) return;
      diffLabel.textContent = `${relative(v.path)}: ${when(v.time)} (${v.action}) ↔ ${now === null ? "Deleted" : "Now"}`;
      return setDiff(v.path, text, now ?? "");
    }
    if (label && !target.folder) {
      const at = versionAt(versions, label.time);
      if (!at) return showMessage(`The file has no version from before the label “${label.name}”.`);
      const [text, now] = await Promise.all([readVersion(at), currentText(at.path)]);
      diffLabel.textContent = `${relative(target.path)} at the label “${label.name}” ↔ Now`;
      return setDiff(at.path, text, now ?? "");
    }
    if (label) {
      const files = filesAt(label.time);
      diffLabel.textContent = `Label “${label.name}”, ${when(label.time)}`;
      return showMessage(`${files.length} ${files.length === 1 ? "file" : "files"} under ${relative(target.path)} have a version from before this label. Revert sets them back to how they were then.`);
    }
    diffLabel.textContent = "";
    showMessage(keyText("Select a version to compare it with the file now. Mark a second one with Space or ⌘-click to compare the two."));
  } catch (e) {
    if (id !== loadId) return;
    diffLabel.textContent = "";
    showMessage(h("p", { class: "lh-error", role: "alert" }, `Couldn't read the version: ${errorText(e)} `), h("button", { onclick: () => showSelected() }, "Retry"));
  }
}

/** Each file's version at a time: the newest kept at or before it. */
function filesAt(time: number): FileVersion[] {
  const byPath = new Map<string, FileVersion[]>();
  for (const v of versions) byPath.set(v.path, [...(byPath.get(v.path) ?? []), v]);
  return [...byPath.values()].flatMap((list) => versionAt(list, time) ?? []) as FileVersion[];
}

function openFile() {
  const v = selectedVersion();
  const path = v?.path ?? (target.folder ? "" : target.path);
  if (path && !deleted.has(path)) host.openFile(path);
}

/** Reverts to the selected version, or to a label: after asking, with Undo in the toast. */
async function revert() {
  const v = selectedVersion();
  const label = selectedLabel();
  const chosen = v ? [v] : label ? (target.folder ? filesAt(label.time) : [versionAt(versions, label.time)].filter((x) => !!x)) : [];
  if (!chosen.length) return showError(label ? "No file has a version from before this label" : "Select a version to revert to");
  const what = chosen.length === 1 ? relative(chosen[0].path) : `${chosen.length} files under ${relative(target.path)}`;
  const to = v ? `${when(v.time)} (${v.action})` : `the label “${label!.name}”`;
  if (!(await confirm(`Revert ${what} to ${to}? The current text is kept in the local history, and Undo in the message puts it back.`, "Revert"))) return;
  const done = await withProgress(`Reverting ${what}…`, async () => revertFiles(await Promise.all(chosen.map(async (x) => [x.path, await readVersion(x)] as [string, string]))));
  if (!done) return;
  if (!done.length) return toast(`${what} already matches ${to}.`, { kind: "info" });
  toast(`Reverted ${what} to ${to}.`, {
    kind: "info",
    timeout: 12000,
    action: { label: "Undo", run: () => withProgress("Undoing the revert…", () => undoRevert(done)).then(() => load()) },
  });
  deleted = new Set();
  await load();
}
