// The Commit view: conflicted, staged, and unstaged files as one tree with PhpStorm's keys and multi-select, bulk
// stage, unstage, and rollback, grouping by folder, and the commit box.
import { invoke } from "@tauri-apps/api/core";
import { h, icon, iconButton } from "./dom";
import { showMenu, type MenuItem } from "./files";
import { change, git, gitFailure, gitOperation, gitOutput, gitStatus, gitStatusError, refreshGit, refreshListeners, showChange } from "./git";
import { type FileStatus, isConflict } from "./gitparse";
import { fileIcon } from "./icons";
import { listNav } from "./listnav";
import { openMerge } from "./merge";
import { confirm } from "./palette";
import { onSettings, registerSettings, updateSetting } from "./settings";
import { showError, status, withProgress } from "./status";
import { mod } from "./platform.ts";

type Host = { root(): string; openFile(path: string): unknown; push(): unknown; showHistory(path: string): unknown };
let host: Host;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const info = (text: string) => status(text, "app", "info");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const settings = registerSettings("Git", { gitGroupByFolder: false }, [
  { key: "gitGroupByFolder", label: "Group changed files by folder", type: "checkbox", help: "In the Commit view. The folder button in its header toggles it too." },
]);

type Group = "x" | "s" | "c";
const GROUPS: [Group, string][] = [["x", "Merge Conflicts"], ["s", "Staged"], ["c", "Changes"]];
const staged = (f: FileStatus) => !isConflict(f) && f.index !== " " && f.index !== "?";
const unstaged = (f: FileStatus) => !isConflict(f) && f.worktree !== " ";
const filesOf = (g: Group) => gitStatus()?.files.filter(g === "x" ? isConflict : g === "s" ? staged : unstaged) ?? [];

/** Selected file rows, by key (`<group>:<path>`); the list's own cursor is the last one clicked or moved to. */
const picked = new Set<string>();
let anchor = "";
/** Collapsed groups and folders, by key. */
const collapsed = new Set<string>();
let nav: ReturnType<typeof listNav>;

const keyOf = (g: Group, path: string) => `${g}:${path}`;
function fileOfKey(key: string): { g: Group; f: FileStatus } | undefined {
  const g = key[0] as Group;
  if (!"xsc".includes(g) || key[1] !== ":") return;
  const f = filesOf(g).find((x) => x.path === key.slice(2));
  return f && { g, f };
}

// ---- Rendering ----

function render() {
  const st = gitStatus();
  const empty = $("git-empty");
  empty.hidden = !!st;
  $("git-changes").hidden = !st;
  $("git-group-folders").setAttribute("aria-pressed", String(settings.gitGroupByFolder));
  if (!st) return renderEmpty(empty);
  const rows: HTMLElement[] = [];
  for (const [g, label] of GROUPS) {
    const files = filesOf(g);
    if (g === "x" && !files.length) continue;
    const key = `g:${g}`;
    const open = !collapsed.has(key);
    const row = h(
      "li",
      { class: "git-group", role: "treeitem", data: { key, label } },
      h("span", { class: `codicon codicon-chevron-${open ? "down" : "right"} twisty` }),
      label,
      h("span", { class: "count" }, String(files.length)),
    );
    row.setAttribute("aria-level", "1");
    row.setAttribute("aria-expanded", String(open));
    if (g === "s" && files.length) row.append(iconButton("remove", "Unstage all", () => bulk("unstage", files.map((f) => keyOf(g, f.path)))));
    if (g === "c" && files.length) row.append(iconButton("add", "Stage all", () => change("add", "--all")));
    row.onclick = (e) => !(e.target as Element).closest("button") && toggle(key);
    rows.push(row);
    if (!open) continue;
    if (!files.length) rows.push(h("li", { class: "muted git-none" }, g === "c" ? "No changes." : "Nothing staged."));
    if (!settings.gitGroupByFolder) {
      rows.push(...files.map((f) => fileRow(g, f, 2)));
      continue;
    }
    // One row per folder, as PhpStorm's "group by directory" with compacted folders.
    const byDir = new Map<string, FileStatus[]>();
    for (const f of files) {
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
      byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
    }
    for (const [dir, list] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
      const dkey = `d:${g}:${dir}`;
      const dopen = !collapsed.has(dkey);
      const drow = h(
        "li",
        { class: "git-folder", role: "treeitem", data: { key: dkey, label: dir || "(project root)" } },
        h("span", { class: `codicon codicon-chevron-${dopen ? "down" : "right"} twisty` }),
        icon("folder"),
        h("span", { class: "name" }, dir || "(project root)"),
        h("span", { class: "dir" }, plural(list.length, "file")),
      );
      drow.setAttribute("aria-level", "2");
      drow.setAttribute("aria-expanded", String(dopen));
      drow.onclick = () => toggle(dkey);
      rows.push(drow);
      if (dopen) rows.push(...list.map((f) => fileRow(g, f, 3)));
    }
  }
  $("git-files").replaceChildren(...rows);
  // Drop picks of files that are gone, such as after a commit.
  for (const k of picked) if (!fileOfKey(k)) picked.delete(k);
  paint();
}

/** Why there's no Commit view: no repository (with Initialize Repository), no git, or another failure. */
function renderEmpty(el: HTMLElement) {
  const error = gitStatusError();
  const retry = h("button", { onclick: () => refreshGit() }, "Try Again");
  if (!host.root()) return el.replaceChildren("Open a folder to use git.");
  if (/not a git repository/i.test(error) || !error)
    return el.replaceChildren(h("p", {}, "This folder isn't a git repository."), h("button", { class: "primary", onclick: initRepository }, "Initialize Repository"));
  if (/No such file or directory|os error 2|not found/i.test(error) && !/fatal:/.test(error))
    return el.replaceChildren(h("p", {}, "Git isn't installed, or isn't on your PATH. Install it, for example with xcode-select --install, then try again."), retry);
  if (/dubious ownership/i.test(error))
    return el.replaceChildren(h("p", {}, "Git doesn't trust this folder because another user owns it. Mark it safe in a terminal with git config --global --add safe.directory <folder>, then try again."), retry);
  el.replaceChildren(h("p", {}, `Git can't read this folder's status: ${error}`), retry);
}

/** Creates a git repository in the project folder. */
export async function initRepository() {
  if (!host.root()) return showError("Open a folder first.");
  if (gitStatus()) return info("This folder is already a git repository.");
  const out = await withProgress("Initializing the repository…", () => git("init"), { error: "Can't initialize the repository" });
  if (out === undefined) return;
  await refreshGit();
  info("Initialized a git repository. Stage files and commit them to start its history.");
}

function fileRow(g: Group, f: FileStatus, level: number) {
  const letter = g === "x" ? "!" : g === "s" ? f.index : f.worktree === "?" ? "U" : f.worktree;
  const name = f.path.split("/").pop()!;
  const fi = fileIcon(name);
  const key = keyOf(g, f.path);
  const buttons = h("span", { class: "buttons" });
  const button = (label: string, title: string, run: () => unknown) => buttons.append(h("button", { title, ariaLabel: title, onclick: (e: Event) => (e.stopPropagation(), run()) }, label));
  if (g === "x") {
    button("Yours", "Keep your version of the whole file", () => acceptSide(f, "ours"));
    button("Theirs", "Keep their version of the whole file", () => acceptSide(f, "theirs"));
    button("✓", "Mark as resolved (stage the file as it is)", () => change("add", "--", f.path));
  } else {
    button("↗", "Open file (F4)", () => host.openFile(`${host.root()}/${f.path}`));
    if (g === "s") button("−", "Unstage (Space)", () => bulk("unstage", targets(key)));
    else {
      button("↺", "Rollback… (⌥⌘Z)", () => bulk("rollback", targets(key)));
      button("+", "Stage (Space)", () => bulk("stage", targets(key)));
    }
  }
  const row = h(
    "li",
    { class: `git-file status-${g === "x" ? "C" : letter}`, role: "treeitem", title: f.from ? `${f.from} → ${f.path}` : g === "x" ? `${f.path}: open the merge tool, or keep one side` : f.path, data: { key, label: name } },
    h("span", { class: "letter" }, letter),
    h("span", { class: `file-icon codicon codicon-${fi.codicon} ${fi.color}` }),
    h("span", { class: "name" }, name),
    settings.gitGroupByFolder ? null : h("span", { class: "dir" }, f.path.slice(0, -name.length - 1)),
    buttons,
  );
  row.setAttribute("aria-level", String(level));
  row.onclick = (e) => {
    if (e.metaKey || e.shiftKey || e.ctrlKey) return;
    if (g === "x") openMerge(f.path);
    else showChange(f, g === "s");
  };
  row.oncontextmenu = (e) => {
    e.preventDefault();
    if (!picked.has(key)) pickOnly(key);
    showMenu(e.clientX, e.clientY, menuFor(key));
  };
  return row;
}

function toggle(key: string, open = collapsed.has(key)) {
  if (open) collapsed.delete(key);
  else collapsed.add(key);
  render();
}

// ---- Selection ----

function paint() {
  for (const row of $("git-files").querySelectorAll<HTMLElement>(".git-file")) row.classList.toggle("picked", picked.has(row.dataset.key!));
}

/** File row keys in screen order, for ranges. */
const fileKeys = () => [...$("git-files").querySelectorAll<HTMLElement>(".git-file")].map((r) => r.dataset.key!);

function pickOnly(key: string) {
  picked.clear();
  picked.add(key);
  anchor = key;
  paint();
}

function pickRange(key: string) {
  const keys = fileKeys();
  const [a, b] = [keys.indexOf(anchor), keys.indexOf(key)];
  if (a < 0 || b < 0) return pickOnly(key);
  picked.clear();
  for (const k of keys.slice(Math.min(a, b), Math.max(a, b) + 1)) picked.add(k);
  paint();
}

/** The files an action on a row applies to: the selection when the row is in it, otherwise the row alone. */
const targets = (key: string) => (picked.has(key) && picked.size > 1 ? [...picked] : [key]);

// ---- Actions ----

type Bulk = "stage" | "unstage" | "rollback";

/** Stages, unstages, or rolls back files, by row key. Rollback asks first and moves new files to the Trash. */
async function bulk(action: Bulk, keys: string[]) {
  const items = keys.map(fileOfKey).filter((x): x is { g: Group; f: FileStatus } => !!x && x.g !== "x");
  if (!items.length) return info("Select changed files first.");
  const paths = [...new Set(items.map((x) => x.f.path))];
  if (action === "stage") return (await change("add", "--", ...paths)) && info(`Staged ${plural(paths.length, "file")}.`);
  if (action === "unstage") return (await change("restore", "--staged", "--", ...paths)) && info(`Unstaged ${plural(paths.length, "file")}.`);
  // Rollback: a staged row goes back to HEAD in the index and working tree; an unstaged one to the index.
  const untracked = items.filter((x) => x.f.worktree === "?" && x.f.index === "?").map((x) => x.f.path);
  const added = items.filter((x) => x.g === "s" && x.f.index === "A").map((x) => x.f.path);
  const toHead = items.filter((x) => x.g === "s" && x.f.index !== "A").map((x) => x.f.path);
  const toIndex = items.filter((x) => x.g === "c" && x.f.worktree !== "?").map((x) => x.f.path).filter((p) => !toHead.includes(p));
  const what = paths.length === 1 ? paths[0] : plural(paths.length, "file");
  const extra = [untracked.length && `${plural(untracked.length, "new file")} ${untracked.length === 1 ? "goes" : "go"} to the Trash`, added.length && `${plural(added.length, "added file")} ${added.length === 1 ? "is" : "are"} unstaged and kept`].filter(Boolean).join("; ");
  if (!(await confirm(`Roll back your changes to ${what}? You can't undo this${extra ? `; ${extra}` : ""}.`, "Rollback"))) return;
  let ok = true;
  if (toHead.length) ok = (await change("restore", "--staged", "--worktree", "--source=HEAD", "--", ...toHead)) && ok;
  if (added.length) ok = (await change("rm", "--cached", "--quiet", "--", ...added)) && ok;
  if (toIndex.length) ok = (await change("restore", "--", ...toIndex)) && ok;
  for (const path of untracked) {
    try {
      await invoke("trash_path", { path: `${host.root()}/${path}` });
    } catch (e) {
      ok = false;
      showError(`Can't move ${path} to the Trash`, e);
    }
  }
  await refreshGit();
  if (ok) info(`Rolled back ${what}.`);
}

/** Resolves a whole file with one side. If that side deleted the file, resolving deletes it. */
export async function acceptSide(f: FileStatus, side: "ours" | "theirs") {
  const deleted = side === "ours" ? f.index === "D" : f.worktree === "D";
  const whose = side === "ours" ? "your" : "their";
  const what = deleted ? `delete ${f.path}, as ${whose} side did` : `replace ${f.path} with ${whose} version`;
  if (!(await confirm(`Resolve the conflict and ${what}? Other changes to the file are lost.`, `Use ${whose[0].toUpperCase() + whose.slice(1)} Version`))) return;
  if (deleted) return change("rm", "--quiet", "--", f.path);
  try {
    await git("checkout", `--${side}`, "--", f.path);
  } catch (e) {
    return showError(`Can't take ${whose} version of ${f.path}`, e);
  }
  await change("add", "--", f.path);
}

function menuFor(key: string): MenuItem[] {
  const x = fileOfKey(key);
  if (!x) return [];
  const { g, f } = x;
  const keys = targets(key);
  const many = keys.length > 1 ? ` (${keys.length})` : "";
  if (g === "x")
    return [
      { label: "Resolve in Merge Tool", run: () => openMerge(f.path) },
      { label: "Accept Yours", run: () => acceptSide(f, "ours") },
      { label: "Accept Theirs", run: () => acceptSide(f, "theirs") },
      { label: "Mark Resolved", run: () => change("add", "--", f.path) },
      "-",
      { label: "Open File", keys: "F4", run: () => host.openFile(`${host.root()}/${f.path}`) },
    ];
  return [
    { label: "Show Diff", keys: "⏎", run: () => showChange(f, g === "s") },
    { label: "Open File", keys: "F4", run: () => host.openFile(`${host.root()}/${f.path}`) },
    "-",
    g === "s" ? { label: `Unstage${many}`, keys: "Space", run: () => bulk("unstage", keys) } : { label: `Stage${many}`, keys: "Space", run: () => bulk("stage", keys) },
    { label: `Rollback${many}…`, keys: "⌥⌘Z", run: () => bulk("rollback", keys) },
    "-",
    { label: "Show History", run: () => host.showHistory(`${host.root()}/${f.path}`) },
    { label: "Copy Path", run: () => navigator.clipboard.writeText(f.path).then(() => info(`Copied ${f.path}`)) },
  ];
}

// ---- Commit ----

let committing = false;

function setBusy(busy: boolean) {
  committing = busy;
  for (const id of ["commit", "commit-push"]) $<HTMLButtonElement>(id).disabled = busy;
  $("commit").textContent = busy ? "Committing…" : "Commit";
  $("git-changes").setAttribute("aria-busy", String(busy));
}

/** Commits the staged changes. Hooks run under a spinner; if one fails, its output is a click away. */
async function commit(push: boolean) {
  if (committing) return;
  const box = $<HTMLTextAreaElement>("commit-message");
  const message = box.value.trim();
  const amend = $<HTMLInputElement>("amend").checked;
  const st = gitStatus();
  if (!message && !amend) return (status("Write a commit message first.", "app", "error"), box.focus());
  if (st?.files.some(isConflict)) return status("Resolve the merge conflicts first.", "app", "error");
  setBusy(true);
  try {
    if (!st?.files.some(staged) && !amend && gitOperation()?.kind !== "merge") {
      const count = st?.files.length ?? 0;
      if (!count) return status("There are no changes to commit.", "app", "info");
      if (!(await confirm(`Nothing is staged. Stage all ${plural(count, "change")} and commit them?`, "Stage All and Commit"))) return;
      if (!(await change("add", "--all"))) return;
    }
    const args = ["commit", ...(amend ? ["--amend"] : []), ...(message ? ["-m", message] : ["--no-edit"])];
    const result = await withProgress(amend ? "Amending the last commit…" : "Committing…", (signal) => gitOutput(args, signal), { cancellable: true, error: "Commit failed" });
    if (!result) return;
    if (result.code) return gitFailure(/hook/i.test(result.output) ? "Commit failed: a git hook refused it" : "Commit failed", result.output);
    box.value = "";
    $<HTMLInputElement>("amend").checked = false;
    // git prints "[main 1a2b3c4] Subject" first.
    const [, branch, hash] = result.output.match(/^\[(.+?) (?:\(root-commit\) )?([0-9a-f]{7,})\]/m) ?? [];
    info(hash ? `${amend ? "Amended" : "Committed"} ${hash} to ${branch}.` : amend ? "Amended the last commit." : "Committed.");
    if (push) host.push();
  } catch (e) {
    showError("Commit failed", e);
  } finally {
    setBusy(false);
    await refreshGit();
  }
}

// ---- Setup ----

export function initCommitView(hst: Host) {
  host = hst;
  const list = $("git-files");
  let shift = false;
  let byKey = false;
  // Clicks select before listNav moves its cursor: ⌘ toggles a file, ⇧ extends from the last one.
  list.addEventListener("click", (e) => {
    const row = (e.target as Element).closest<HTMLElement>(".git-file");
    if (!row || (e.target as Element).closest("button")) return;
    const key = row.dataset.key!;
    if (e.metaKey || e.ctrlKey) {
      if (picked.has(key)) picked.delete(key);
      else picked.add(key);
      anchor = key;
      paint();
    } else if (e.shiftKey) pickRange(key);
    else pickOnly(key);
  });
  list.addEventListener(
    "keydown",
    (e) => {
      shift = e.shiftKey;
      byKey = true;
      queueMicrotask(() => (byKey = false));
    },
    true,
  );
  nav = listNav(list, {
    onSelect: (row) => {
      if (!byKey || !row.classList.contains("git-file")) return;
      if (shift) pickRange(row.dataset.key!);
      else pickOnly(row.dataset.key!);
    },
    open: (row) => row.click(),
    toggle: (row, open) => toggle(row.dataset.key!, open),
  });
  list.addEventListener("keydown", (e) => {
    if (e.target !== list) return;
    const cursor = nav.selected();
    const keys = picked.size ? [...picked] : fileOfKey(cursor) ? [cursor] : [];
    const first = keys.map(fileOfKey).find(Boolean);
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === " " && first) bulk(first.g === "s" ? "unstage" : "stage", keys);
    else if (e.key === "z" && mod && e.altKey) bulk("rollback", keys);
    else if (e.key === "a" && mod) (fileKeys().forEach((k) => picked.add(k)), paint());
    else if (e.key === "F4" && first) host.openFile(`${host.root()}/${first.f.path}`);
    else if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && fileOfKey(cursor)) {
      const r = nav.selectedRow()!.getBoundingClientRect();
      showMenu(r.left + 24, r.bottom, menuFor(cursor));
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  $("git-group-folders").onclick = () => updateSetting("gitGroupByFolder" as never, !settings.gitGroupByFolder as never);
  onSettings(() => render());
  $("commit").onclick = () => commit(false);
  $("commit-push").onclick = () => commit(true);
  $("commit-message").onkeydown = (e) => e.key === "Enter" && mod(e) && (e.preventDefault(), commit(false));
  refreshListeners.push(render, () => {
    const n = gitStatus()?.files.length ?? 0;
    document.querySelector<HTMLElement>('#activitybar [data-view="commit"]')!.dataset.count = n > 99 ? "99+" : n ? String(n) : "";
  });
}
