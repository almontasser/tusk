// Git integration: commit view, diff view, and branches. Everything shells out to `git`.
import { invoke } from "@tauri-apps/api/core";
import { appCacheDir } from "@tauri-apps/api/path";
import { monaco } from "./editor";
import { hasConflicts } from "./conflicts";
import { h, icon, iconButton } from "./dom";
import { copyHash, showCommitDiff, showCommitPopup, showInLog } from "./history";
import { openMerge } from "./merge";
import type { MenuItem } from "./files";
import { age, ago, applyBlocks, applyLines, type BlameLine, type Block, type FileStatus, isConflict, type LineChange, lineChanges, mirror, parseBlame, parseStatus, parseWorktrees, remoteLineUrl, type Status } from "./gitparse";
import { confirm, type Item, pick, rank } from "./palette";
import { errorText, showError, withProgress } from "./status";
import { closeView, openTerminal, showEditorView } from "./terminal";

type Host = {
  root(): string;
  openFile(path: string): unknown;
  status(text: string): void;
  showView(name: "commit"): void;
  openFolder(path: string): unknown;
};

const $ = (id: string) => document.getElementById(id)!;
let host: Host;
let current: Status | undefined;
let lastBranch: string | undefined;

/** Functions to call when the checked-out branch (or the project) changes. */
export const branchListeners: (() => void)[] = [];
/** Functions to call after each refresh of git's status. */
export const refreshListeners: (() => void)[] = [];
/** The last `git status`, or undefined when the project isn't a repository. */
export const gitStatus = () => current;
let statusError = "";
/** Why the last `git status` failed, such as "not a git repository", or "" when it worked. */
export const gitStatusError = () => statusError;

// `--no-optional-locks` stops read-only commands such as `status` from rewriting .git/index.
// Otherwise every refresh changes .git, the file watcher reports it, and the refresh repeats forever.
const run = (args: string[], input: string | null) =>
  invoke<string>("run_capture", { cwd: host.root(), program: "git", args: ["--no-optional-locks", ...args], input });
export const git = (...args: string[]) => run(args, null);
const gitWithInput = (input: string, ...args: string[]) => run(args, input);

// Commands that write the index run one at a time. Two at once, such as the git add after saving a
// resolved file and the one from Mark Resolved, would fail on git's index.lock.
let queue: Promise<unknown> = Promise.resolve();

/** Runs a git command that changes state, then refreshes. Errors show as errors. Resolves to whether it worked. */
export function change(...args: string[]): Promise<boolean> {
  const next = queue.then(async () => {
    let ok = true;
    try {
      await git(...args);
    } catch (e) {
      ok = false;
      showError(`git ${args[0]} failed`, e);
    }
    await refreshGit();
    return ok;
  });
  queue = next;
  return next;
}

/**
 * Runs git with standard error in the output and returns the exit code instead of failing, for commands whose
 * messages matter either way, such as push, pull, and commit hooks. Credential prompts are off, since there's no
 * terminal to answer them. Aborting `signal` stops git.
 */
export async function gitOutput(args: string[], signal?: AbortSignal): Promise<{ code: number; output: string }> {
  const dir = `${await appCacheDir()}/git`;
  await invoke("create_dir", { path: dir });
  const pidFile = `${dir}/${Date.now()}-${Math.random().toString(36).slice(2)}.pid`;
  // ponytail: a pid file lets the webview stop git without a Rust command for killing processes.
  const script = `export GIT_TERMINAL_PROMPT=0; git --no-optional-locks "$@" 2>&1 & echo $! > "$0"; wait $!; code=$?; rm -f "$0"; printf '\\n\\036%s' $code`;
  const stop = () => void invoke("run_capture", { cwd: "/", program: "/bin/sh", args: ["-c", 'kill "$(cat "$0")" 2>/dev/null', pidFile], input: null }).catch(() => {});
  signal?.addEventListener("abort", stop);
  try {
    const out = await invoke<string>("run_capture", { cwd: host.root(), program: "/bin/sh", args: ["-c", script, pidFile, ...args], input: null });
    signal?.throwIfAborted();
    const at = out.lastIndexOf("\n\x1e");
    return { code: Number(out.slice(at + 2)), output: out.slice(0, at).trim() };
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

/**
 * Runs a git command that changes the repository, with progress in the status bar, then refreshes. A failure shows
 * git's message, with its full output a click away; one that left conflicts offers the merge tool instead.
 * Resolves to git's output when it worked, or undefined.
 */
export async function gitTask(label: string, args: string[], failure: string, options: { cancellable?: boolean } = {}): Promise<string | undefined> {
  const result = await withProgress(label, (signal) => gitOutput(args, signal), { ...options, error: failure });
  await refreshGit();
  if (!result) return;
  if (!result.code) return result.output;
  const conflicted = current?.files.filter(isConflict) ?? [];
  if (conflicted.length)
    showError(`${failure}: ${conflicted.length} ${conflicted.length === 1 ? "file has" : "files have"} conflicts. Resolve them, then continue`, undefined, { label: "Resolve", run: () => openMerge(conflicted[0].path) });
  else gitFailure(failure, result.output);
}

/** Shows a git failure. When git said more than one line, such as a hook's output, the toast offers all of it. */
export function gitFailure(message: string, output: string) {
  const lines = output.split("\n").filter((l) => l.trim() && !l.startsWith("hint:"));
  showError(message, output || "git exited with an error", lines.length > 1 ? { label: "Show Details", run: () => showOutput(message, output) } : undefined);
}

/** Shows a command's full output in a dialog, such as the messages of a failed commit hook. */
export function showOutput(title: string, text: string) {
  document.getElementById("output-dialog")?.remove();
  const dialog = h("dialog", { id: "output-dialog", class: "refactor-dialog" });
  dialog.append(
    h(
      "form",
      { method: "dialog" },
      h("h2", {}, title),
      h("pre", { class: "output-text", tabIndex: 0 }, text),
      h(
        "div",
        { class: "buttons" },
        h("button", { type: "button", onclick: () => navigator.clipboard.writeText(text).then(() => host.status("Copied the output.")) }, "Copy"),
        h("button", { type: "submit", class: "primary" }, "Close"),
      ),
    ),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

// ---- Status ----

let refreshing: Promise<void> | undefined;
let again: Promise<void> | undefined;

/**
 * Reloads `git status` and redraws the commit view and branch widget. One refresh runs at a time:
 * calls made while one runs share a single follow-up refresh, which starts after it ends, so the
 * status they see is never older than their call.
 */
export function refreshGit(): Promise<void> {
  if (!refreshing) return (refreshing = loadStatus().finally(() => (refreshing = undefined)));
  return (again ??= refreshing.then(() => ((again = undefined), refreshGit())));
}

/** HEAD's commit when the caches below were filled, with the project root. */
let cachedHead: string | undefined;

async function loadStatus() {
  if (!host.root()) return;
  const [status, head] = await Promise.all([
    git("status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all").then(
      (out) => ((statusError = ""), parseStatus(out)),
      (e) => ((statusError = errorText(e)), undefined),
    ),
    git("rev-parse", "HEAD").catch(() => ""),
  ]);
  current = status;
  operation = current ? await detectOperation() : null;
  // File contents at HEAD and blame only change when HEAD moves (a commit, checkout, reset, or rebase).
  const headKey = `${host.root()}:${head.trim()}`;
  if (headKey !== cachedHead) {
    cachedHead = headKey;
    headCache.clear();
    blames.clear();
  }
  const branch = current && `${host.root()}:${current.branch}`;
  if (branch !== lastBranch) {
    lastBranch = branch;
    branchListeners.forEach((f) => f());
  }
  renderBranch();
  renderOperation();
  refreshers.forEach((r) => r());
  refreshListeners.forEach((f) => f());
}

/** The branch name in the title bar and the status bar, with commits ahead (↑) and behind (↓) its upstream. */
function renderBranch() {
  for (const el of [$("branch"), $("status-branch")]) {
    el.hidden = !current;
    if (!current) continue;
    const sync = [current.ahead && `↑${current.ahead}`, current.behind && `↓${current.behind}`].filter(Boolean).join(" ");
    el.replaceChildren(icon("git-branch"), h("span", { class: "label" }, `${current.branch}${sync ? ` ${sync}` : ""}`), ...(el.id === "branch" ? [icon("chevron-down")] : []));
    el.title = `${current.upstream ? `${current.branch}, tracking ${current.upstream}` : `${current.branch}, with no upstream branch`}. Click for branches.`;
    el.setAttribute("aria-label", `Git branch ${current.branch}${sync ? `, ${current.ahead} ahead, ${current.behind} behind` : ""}`);
  }
}


// ---- Merges, rebases, cherry-picks, and reverts in progress ----

/**
 * `editing` is the commit a rebase stopped at for an `edit` step, to change before continuing. `split` is
 * set once HEAD has moved off that commit, as after Split Commit, so it's no longer the one to amend.
 */
type Operation = { kind: "merge" | "rebase" | "cherry-pick" | "revert"; gitDir: string; editing?: string; split?: boolean };
let operation: Operation | null = null;
/** The merge, rebase, cherry-pick, or revert in progress, if any. */
export const gitOperation = () => operation;
let gitDir: { root: string; path: string } | undefined;

/** Reads git's state files to find an operation that stopped, usually for conflicts. */
async function detectOperation(): Promise<Operation | null> {
  if (gitDir?.root !== host.root()) {
    const path = (await git("rev-parse", "--absolute-git-dir").catch(() => "")).trim();
    gitDir = { root: host.root(), path };
  }
  const dir = gitDir.path;
  if (!dir) return null;
  const kinds = [["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["MERGE_HEAD", "merge"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"]] as const;
  const found = await Promise.all(kinds.map(([name]) => invoke<boolean>("path_exists", { path: `${dir}/${name}` })));
  for (const [i, [name, kind]] of kinds.entries()) {
    if (!found[i]) continue;
    // git writes rebase-merge/amend when it stops at an edit step.
    const amend = name === "rebase-merge" ? await invoke<string>("read_file", { path: `${dir}/rebase-merge/amend` }).catch(() => "") : "";
    const hash = amend.trim();
    const editing = hash ? (await git("log", "-1", "--format=%h %s", hash).catch(() => hash.slice(0, 7))).trim() : undefined;
    const split = !!hash && (await git("rev-parse", "HEAD").catch(() => "")).trim() !== hash;
    return { kind, gitDir: dir, editing, split };
  }
  return null;
}

function renderOperation() {
  const banner = $("git-operation");
  banner.hidden = !operation;
  if (!operation) return;
  const { kind, gitDir: dir, editing, split } = operation;
  const conflicts = current?.files.filter(isConflict).length ?? 0;
  const next = kind === "merge" ? "commit" : "continue";
  const amending = editing && !conflicts && !split;
  banner.querySelector("span")!.textContent = editing && !conflicts
    ? split
      ? `Rebase stopped to split ${editing}. Stage and commit its changes in as many commits as you like, then continue.`
      : `Rebase stopped to edit ${editing}. Change and stage files, then continue: staged changes go into this commit. Or split it into several commits.`
    : `${kind[0].toUpperCase() + kind.slice(1)} in progress. ` + (conflicts ? `Resolve ${conflicts} conflict${conflicts > 1 ? "s" : ""}, then ${next}.` : `No conflicts left: ${next} when ready.`);
  $("operation-abort").onclick = async () => {
    if (await confirm(`Abort the ${kind} and return to the state before it? Conflict resolutions are lost.`, `Abort the ${kind}`)) change(kind, "--abort");
  };
  const splitButton = $("operation-split");
  splitButton.hidden = !amending;
  // Undoes the commit but keeps its changes unstaged, to commit in parts with partial staging.
  splitButton.onclick = async () => {
    const message = $("commit-message") as HTMLTextAreaElement;
    message.value ||= (await git("log", "-1", "--format=%B").catch(() => "")).trim();
    change("reset", "--quiet", "HEAD~");
  };
  const continueButton = $("operation-continue");
  continueButton.hidden = kind === "merge"; // A merge finishes with a normal commit.
  // GIT_EDITOR=true accepts git's prepared message instead of opening an editor. At an edit stop, git
  // refuses to continue with staged changes, so they're amended into the commit first, unless it was split.
  const amend = amending ? "git diff --cached --quiet || git commit --amend --no-edit --quiet; " : "";
  continueButton.onclick = () => openTerminal(host.root(), `${kind} --continue`, ["/bin/sh", "-c", `${amend}GIT_EDITOR=true git ${kind} --continue`]);
  // Offer git's prepared merge message, such as "Merge branch 'feature'".
  const message = $("commit-message") as HTMLTextAreaElement;
  if (kind === "merge" && !message.value) invoke<string>("read_file", { path: `${dir}/MERGE_MSG` }).then((m) => (message.value ||= m.replace(/^#.*$/gm, "").trim()), () => {});
}

/** Stages a conflicted file once it's saved without conflict markers, as PhpStorm does. */
export async function afterSave(path: string, text: string) {
  const rel = path.slice(host.root().length + 1);
  const f = current?.files.find((x) => x.path === rel && isConflict(x));
  if (!f || hasConflicts(text)) return;
  await change("add", "--", rel);
  host.status(`Marked ${rel} as resolved.`);
}

// ---- Diff view ----

let diffEditor: monaco.editor.IStandaloneDiffEditor | undefined;

/** The staged or unstaged change on screen, whose blocks can be staged or unstaged. */
let staging: { f: FileStatus; inIndex: boolean; original: string; modified: string } | undefined;
let lastSide: "original" | "modified" = "modified";

/** Shows a file's staged change (HEAD to index) or unstaged change (index to working tree). */
export async function showChange(f: FileStatus, inIndex: boolean) {
  const show = (spec: string) => git("show", spec).catch(() => "");
  const original = inIndex ? await show(`HEAD:${f.from ?? f.path}`) : await show(`:${f.path}`);
  const modified = inIndex
    ? await show(`:${f.path}`)
    : await invoke<string>("read_file", { path: `${host.root()}/${f.path}` }).catch(() => "");
  const action = {
    label: inIndex ? "Unstage Selected" : "Stage Selected",
    title: `${inIndex ? "Unstage" : "Stage"} the changes that the selection touches (select lines on either side)`,
    run: stageSelected,
  };
  showDiff(f.path, original, modified, inIndex ? "HEAD ↔ Staged" : f.worktree === "?" ? "New file" : "Staged ↔ Working tree", action);
  staging = { f, inIndex, original, modified };
}

/** The diff's change blocks that the selection touches, on the side you last clicked. */
function selectedBlocks(): Block[] {
  const side = lastSide === "original" ? diffEditor!.getOriginalEditor() : diffEditor!.getModifiedEditor();
  const ranges = side.getSelections() ?? [];
  return (diffEditor!.getLineChanges() ?? []).filter((c) => {
    const [start, end] =
      lastSide === "original"
        ? [c.originalStartLineNumber, c.originalEndLineNumber || c.originalStartLineNumber]
        : [c.modifiedStartLineNumber, c.modifiedEndLineNumber || c.modifiedStartLineNumber];
    return ranges.some((r) => r.startLineNumber <= end && r.endLineNumber >= start);
  });
}

/** Stages (or, in a staged diff, unstages) the selected blocks by writing a new index version of the file. */
export async function stageSelected() {
  if (!staging || !diffEditor) return;
  const blocks = selectedBlocks();
  if (!blocks.length) return host.status("Select lines in a change first.");
  const { f, inIndex, original, modified } = staging;
  // A text selection stages just its lines; a click in a block stages the whole block.
  const side = lastSide === "original" ? diffEditor.getOriginalEditor() : diffEditor.getModifiedEditor();
  const selections = (side.getSelections() ?? []).filter((r) => !r.isEmpty());
  // A selection that ends at column 1 doesn't include that last line.
  const selectedLine = (line: number) => selections.some((r) => line >= r.startLineNumber && (line < r.endLineNumber || (line === r.endLineNumber && r.endColumn > 1)));
  const onOriginal = (line: number) => lastSide === "original" && selectedLine(line);
  const onModified = (line: number) => lastSide === "modified" && selectedLine(line);
  // Staging takes lines from the working tree into the index; unstaging puts HEAD's lines back.
  const index = selections.length
    ? inIndex
      ? applyLines(modified, original, blocks.map(mirror), onModified, onOriginal)
      : applyLines(original, modified, blocks, onOriginal, onModified)
    : inIndex
      ? applyBlocks(modified, original, blocks.map(mirror))
      : applyBlocks(original, modified, blocks);
  if (!(await writeIndex(f.path, index))) return;
  const scroll = diffEditor.getModifiedEditor().getScrollTop();
  await refreshGit();
  await showChange(f, inIndex);
  diffEditor.getModifiedEditor().setScrollTop(scroll);
  host.status(`${inIndex ? "Unstaged" : "Staged"} ${blocks.length} ${blocks.length === 1 ? "change" : "changes"} in ${f.path}`);
}

/** Makes `text` the staged version of a file. Returns false, with the error in the status bar, if git refuses. */
async function writeIndex(path: string, text: string) {
  try {
    const hash = (await gitWithInput(text, "hash-object", "-w", "--stdin", `--path=${path}`)).trim();
    const mode = (await git("ls-files", "--stage", "--", path)).split(" ")[0] || "100644";
    await git("update-index", "--add", "--cacheinfo", `${mode},${hash},${path}`);
    return true;
  } catch (e) {
    host.status(`Can't update the index: ${String(e).trim()}`);
    return false;
  }
}

export type DiffAction = { label: string; title?: string; run(): unknown };

/** Shows a diff in an editor tab, replacing the diff it showed before. `action` adds a button to the header, such as Stage Selected. */
export function showDiff(path: string, original: string, modified: string, label: string, action?: DiffAction): monaco.editor.IStandaloneDiffEditor {
  clearDiff();
  const button = $("diff-action");
  button.hidden = !action;
  button.textContent = action?.label ?? "";
  button.title = action?.title ?? "";
  button.onclick = () => action?.run();
  // No theme option here: it would reset Monaco's global theme. The Theme setting sets it.
  if (!diffEditor) {
    diffEditor = monaco.editor.createDiffEditor($("diff-editor"), {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      fontSize: 13,
      fontFamily: "JetBrains Mono, JetBrainsMono Nerd Font Mono, JetBrainsMono Nerd Font, SF Mono, Menlo, monospace",
      minimap: { enabled: false },
    });
    diffEditor.getOriginalEditor().onDidFocusEditorText(() => (lastSide = "original"));
    diffEditor.getModifiedEditor().onDidFocusEditorText(() => (lastSide = "modified"));
  }
  // A non-file scheme keeps these models away from the language servers.
  const uri = (side: string) => monaco.Uri.from({ scheme: "git", path: `/${side}/${path}`, query: String(Date.now()) });
  diffEditor.setModel({
    original: monaco.editor.createModel(original, undefined, uri("original")),
    modified: monaco.editor.createModel(modified, undefined, uri("modified")),
  });
  $("diff-path").textContent = path.startsWith("/") ? path.split("/").pop()! : path;
  $("diff-label").textContent = label;
  // Paths are relative to the project, except files outside it, such as HTTP responses in the app's cache.
  $("diff-open").onclick = () => (closeDiff(), host.openFile(path.startsWith("/") ? path : `${host.root()}/${path}`));
  showEditorView(`${path.split("/").pop()} (diff)`, $("diff"), "diff", clearDiff);
  return diffEditor;
}

/** A file in a diff of several, such as a commit's or a stash's, loaded when you move to it. */
export type DiffFile = { path: string; status?: string; load(): Promise<[string, string]> };
let diffFiles: { files: DiffFile[]; index: number; label: string } | undefined;

/**
 * Shows the diff of one of several files, with a file list and previous and next buttons (⌥⌘← and ⌥⌘→) in the
 * header, as PhpStorm's diff viewer does. Loading shows progress, so a slow `git show` doesn't look like nothing.
 */
export async function showDiffs(files: DiffFile[], label: string, index = 0) {
  const f = files[index];
  if (!f) return host.status("There are no changed files to show.");
  const texts = await withProgress(`Loading the diff of ${f.path}…`, () => f.load(), { error: `Can't show the diff of ${f.path}` });
  if (!texts) return;
  showDiff(f.path, texts[0], texts[1], label);
  diffFiles = { files, index, label };
  const nav = $("diff-files");
  nav.hidden = files.length < 2;
  if (files.length < 2) return;
  const select = h("select", { ariaLabel: "Changed file", onchange: () => showDiffs(files, label, select.selectedIndex) });
  files.forEach((x, i) => select.append(new Option(`${x.status ? `${x.status} ` : ""}${x.path}`, String(i), false, i === index)));
  nav.replaceChildren(
    iconButton("arrow-left", "Previous file (⌥⌘←)", () => moveDiff(-1)),
    select,
    h("span", { class: "muted" }, `${index + 1} of ${files.length}`),
    iconButton("arrow-right", "Next file (⌥⌘→)", () => moveDiff(1)),
  );
}

/** Moves to the previous or next file of a diff of several files. */
export function moveDiff(by: 1 | -1) {
  if (!diffFiles) return;
  const { files, index, label } = diffFiles;
  const next = index + by;
  if (next < 0 || next >= files.length) return host.status(by > 0 ? "This is the last file." : "This is the first file.");
  showDiffs(files, label, next);
}

/** The side of the diff on screen that you last clicked, and the line the cursor is on there. */
export function diffCursor(): { side: "original" | "modified"; line: number; startLine: number } | null {
  if (!diffEditor?.getModel()) return null;
  const side = lastSide === "original" ? diffEditor.getOriginalEditor() : diffEditor.getModifiedEditor();
  const s = side.getSelection();
  if (!s) return { side: lastSide, line: 1, startLine: 1 };
  // A selection that ends at the start of a line doesn't include that line.
  const end = s.endColumn === 1 && s.endLineNumber > s.startLineNumber ? s.endLineNumber - 1 : s.endLineNumber;
  return { side: lastSide, line: end, startLine: s.startLineNumber };
}

/** Closes the diff's tab. */
export const closeDiff = () => closeView($("diff"));

function clearDiff() {
  staging = undefined;
  diffFiles = undefined;
  $("diff-files").hidden = true;
  $("diff-action").hidden = true;
  const model = diffEditor?.getModel();
  diffEditor?.setModel(null);
  model?.original.dispose();
  model?.modified.dispose();
}

// ---- Worktrees ----

/** Lists worktrees to open or remove, and creates one for the branch you type, beside the main worktree. */
export async function worktrees() {
  if (!current) return host.status("This folder isn't a git repository.");
  let list, refs: string[];
  try {
    list = parseWorktrees(await git("worktree", "list", "--porcelain"));
    refs = (await git("for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads", "refs/remotes")).split("\n");
  } catch (e) {
    return showError("Can't list the worktrees", e);
  }
  const taken = new Set(list.map((w) => w.branch));
  const items: Item[] = list.map((w) => ({
    label: w.branch || w.path,
    detail: `${w.path.replace(/^\/Users\/[^/]+/, "~")}${w.path === host.root() ? " · open" : w.main ? " · main" : ""}`,
    run: () => worktreeActions(w.path, w.branch, w.main),
  }));
  pick("Worktrees. Type a branch name to create a worktree for it.", (q) => {
    const name = q.trim().replace(/\s+/g, "-");
    const main = list[0]?.path ?? host.root();
    const path = `${main}-${name.replace(/\//g, "-")}`;
    // An existing branch, local or on a remote, is checked out; otherwise the branch is created from HEAD.
    const exists = refs.some((r) => r === name || r.endsWith(`/${name}`));
    const args = exists ? ["worktree", "add", path, name] : ["worktree", "add", "-b", name, path];
    const create: Item[] =
      name && !taken.has(name)
        ? [{ label: `New worktree for "${name}"`, detail: `${exists ? "existing branch" : "new branch from HEAD"} · ${path.replace(/^\/Users\/[^/]+/, "~")}`, run: () => addWorktree(args, path) }]
        : [];
    return [...create, ...rank(q, items)];
  });
}

async function addWorktree(args: string[], path: string) {
  try {
    await git(...args);
  } catch (e) {
    return host.status(`git worktree: ${String(e).trim()}`);
  }
  host.openFolder(path);
}

function worktreeActions(path: string, branch: string, main: boolean) {
  const items: Item[] = [{ label: "Open", detail: "In this window", run: () => host.openFolder(path) }];
  // Git refuses to remove the main worktree, and removing the open one would pull the folder out from under the editor.
  if (!main && path !== host.root())
    items.push({
      label: "Remove",
      detail: "Delete the folder; the branch stays",
      run: async () => (await confirm(`Remove the worktree at ${path}? Uncommitted changes in it are lost.`, "Remove Worktree")) && change("worktree", "remove", "--force", path),
    });
  pick(branch || path, (q) => rank(q, items));
}

// ---- Editor: change markers, inline blame, and blame annotations ----

/** Each file's lines at HEAD, or null for files git doesn't track. Cleared when HEAD moves. */
const headCache = new Map<string, Promise<string[] | null>>();
/** Per-editor refreshers, run after each git refresh. */
const refreshers = new Set<() => void>();

function headLines(rel: string) {
  if (!headCache.has(rel)) headCache.set(rel, git("show", `HEAD:${rel}`).then((t) => t.split("\n"), () => null));
  return headCache.get(rel)!;
}

/** Blame by model URI, for one version of its text, shared by every pane showing it. Cleared when HEAD moves. */
const blames = new Map<string, { version: number; lines: Promise<BlameLine[]> }>();

/**
 * Blame for a model's current text, including unsaved edits. One `git blame` runs per file at a
 * time: a request waits for the one before it, and if the text changed again meanwhile it skips
 * git and reuses the earlier result, since the newer request will blame the newer text.
 */
function blameOf(model: monaco.editor.ITextModel, rel: string): Promise<BlameLine[]> {
  const key = model.uri.toString();
  const version = model.getAlternativeVersionId();
  const previous = blames.get(key);
  if (previous?.version === version) return previous.lines;
  if (!previous) model.onWillDispose(() => blames.delete(key));
  const before = previous?.lines ?? Promise.resolve<BlameLine[]>([]);
  const lines = before.then((earlier) =>
    model.isDisposed() || (previous && model.getAlternativeVersionId() !== version)
      ? earlier
      : gitWithInput(model.getValue(), "blame", "--porcelain", "--contents", "-", "--", rel).then(parseBlame, () => []),
  );
  blames.set(key, { version, lines });
  return lines;
}

const annotated = new Set<string>();
/** The blame each annotated editor shows, by line. */
const annotations = new WeakMap<monaco.editor.ICodeEditor, BlameLine[]>();

/** The committed blame line an annotated editor shows at a line, if any. */
function blameAt(editor: monaco.editor.ICodeEditor, line: number) {
  if (!isAnnotated(editor)) return undefined;
  const b = annotations.get(editor)?.[line - 1];
  return b && !/^0+$/.test(b.hash) ? b : undefined;
}

/** The gutter's context menu items for a blame annotation: the commit's details, its diff, and its hash. */
export function blameMenu(editor: monaco.editor.ICodeEditor, line: number, x: number, y: number): MenuItem[] {
  const b = blameAt(editor, line);
  const model = editor.getModel();
  if (!b || !model) return [];
  const rel = model.uri.fsPath.slice(host.root().length + 1);
  return [
    { label: `Show Commit ${b.hash.slice(0, 7)}`, run: () => showCommitPopup(b.hash, x, y, rel) },
    { label: "Show Diff", run: () => showCommitDiff(b.hash, rel) },
    { label: "Show in Git Log", run: () => showInLog(b.hash) },
    { label: "Copy Hash", run: () => copyHash(b.hash) },
  ];
}
const togglers = new WeakMap<monaco.editor.ICodeEditor, () => void>();

/** Toggles blame annotations (commit, age, and author) in place of line numbers. */
export const annotate = (editor: monaco.editor.ICodeEditor) => togglers.get(editor)?.();
export const isAnnotated = (editor: monaco.editor.ICodeEditor) => {
  const uri = editor.getModel()?.uri;
  return !!uri && uri.scheme === "file" && annotated.has(uri.fsPath.slice(host.root().length + 1));
};

/** Adds change markers, inline blame for the cursor line, and blame annotations to an editor. */
export function trackEditor(editor: monaco.editor.IStandaloneCodeEditor) {
  const markers = editor.createDecorationsCollection();
  const inline = editor.createDecorationsCollection();
  const debounce = (fn: () => unknown, ms: number) => {
    let t: ReturnType<typeof setTimeout>;
    return () => (clearTimeout(t), (t = setTimeout(fn, ms)));
  };
  const relOf = (model: monaco.editor.ITextModel) => {
    const root = host.root();
    return current && model.uri.scheme === "file" && model.uri.fsPath.startsWith(root + "/") ? model.uri.fsPath.slice(root.length + 1) : undefined;
  };

  const updateMarkers = debounce(async () => {
    const model = editor.getModel();
    const rel = model && relOf(model);
    const head = rel ? await headLines(rel) : null;
    if (!model || !rel || head === null || editor.getModel() !== model) return markers.clear(), changeStates.delete(editor);
    const changes = lineChanges(head, model.getLinesContent());
    changeStates.set(editor, { rel, head, changes });
    markers.set(
      changes.map((c) => ({
        range: new monaco.Range(c.start, 1, c.end, 1),
        options: { isWholeLine: true, linesDecorationsClassName: `gutter-${c.kind}` },
      })),
    );
  }, 200);

  const blameLines = () => {
    const model = editor.getModel();
    const rel = model && relOf(model);
    return model && rel ? blameOf(model, rel) : Promise.resolve([]);
  };
  const describe = (b: BlameLine) =>
    /^0+$/.test(b.hash) ? "You · Not committed yet" : `${b.author}, ${ago(b.time)} · ${b.summary}`;

  const updateInline = debounce(async () => {
    const model = editor.getModel();
    const line = editor.getPosition()?.lineNumber;
    const lines = await blameLines();
    const b = line && lines[line - 1];
    if (!model || !line || !b || editor.getModel() !== model) return inline.clear();
    const col = model.getLineMaxColumn(line);
    inline.set([{ range: new monaco.Range(line, col, line, col), options: { after: { content: `    ${describe(b)}`, inlineClassName: "inline-blame" } } }]);
  }, 300);

  const applyAnnotations = async () => {
    const model = editor.getModel();
    const rel = model && relOf(model);
    if (!rel || !annotated.has(rel)) return editor.updateOptions({ lineNumbers: "on", lineNumbersMinChars: 5 });
    const lines = await blameLines();
    annotations.set(editor, lines);
    const label = (n: number) => {
      const b = lines[n - 1];
      if (!b || /^0+$/.test(b.hash)) return "";
      return `${b.hash.slice(0, 7)} ${age(b.time).padStart(3)} ${b.author.split(" ")[0].slice(0, 10).padEnd(10)}`;
    };
    editor.updateOptions({ lineNumbers: label, lineNumbersMinChars: 24 });
  };
  togglers.set(editor, () => {
    const model = editor.getModel();
    const rel = model && relOf(model);
    if (!rel) return;
    annotated.has(rel) ? annotated.delete(rel) : annotated.add(rel);
    applyAnnotations();
  });

  const updateAnnotations = debounce(applyAnnotations, 300);
  editor.onDidChangeModel(() => (closePeek(editor), updateMarkers(), updateInline(), applyAnnotations()));
  editor.onDidChangeModelContent(() => (closePeek(editor), updateMarkers(), updateInline(), updateAnnotations()));
  // Clicking a blame annotation shows its commit.
  editor.onMouseDown((e) => {
    const b = e.event.leftButton && e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS && blameAt(editor, e.target.position?.lineNumber ?? 0);
    const model = editor.getModel();
    if (!b || !model) return;
    e.event.preventDefault();
    showCommitPopup(b.hash, e.event.posx, e.event.posy + 12, relOf(model));
  });
  // Clicking a change marker shows what the lines were at HEAD.
  editor.onMouseDown((e) => {
    const line = e.target.position?.lineNumber;
    if (!e.event.leftButton || !line || !/\bgutter-(added|modified|deleted)\b/.test(e.target.element?.className ?? "")) return;
    const c = changeAt(editor, line);
    if (!c) return;
    e.event.preventDefault();
    peeks.get(editor)?.change === c ? closePeek(editor) : peekChange(editor, c);
  });
  editor.onKeyDown((e) => peeks.has(editor) && e.keyCode === monaco.KeyCode.Escape && (closePeek(editor), e.preventDefault()));
  editor.onDidChangeCursorPosition(updateInline);
  const refresh = () => (updateMarkers(), updateInline(), updateAnnotations());
  refreshers.add(refresh);
  editor.onDidDispose(() => refreshers.delete(refresh));
}

/** Copies a link to lines of a file at the current commit on the remote's website, such as GitHub. */
export async function copyRemoteUrl(path: string, start: number, end = start) {
  try {
    // The project can be a folder inside the repository, so the path starts with the folder's prefix.
    const [[prefix, commit], remote] = await Promise.all([git("rev-parse", "--show-prefix", "HEAD").then((o) => o.split("\n")), git("ls-remote", "--get-url")]);
    const url = remoteLineUrl(remote, commit, prefix + path.slice(host.root().length + 1), start, end);
    if (!url) return host.status("This repository has no remote on a website, such as GitHub.");
    await navigator.clipboard.writeText(url);
    const pushed = (await git("branch", "-r", "--contains", "HEAD").catch(() => "")).trim();
    host.status(pushed ? `Copied ${url}` : `Copied ${url}. Push the current commit so the link works.`);
  } catch (e) {
    host.status(`Couldn't copy the remote URL: ${e}`);
  }
}

// ---- Editor: the changes behind the markers ----

/** Each editor's changes against HEAD, as its markers show them. */
const changeStates = new WeakMap<monaco.editor.ICodeEditor, { rel: string; head: string[]; changes: LineChange[] }>();
/** The open inline diff of each editor. */
const peeks = new WeakMap<monaco.editor.ICodeEditor, { change: LineChange; close(): void }>();

const changeAt = (editor: monaco.editor.ICodeEditor, line: number) => changeStates.get(editor)?.changes.find((c) => line >= c.start && line <= c.end);
const closePeek = (editor: monaco.editor.ICodeEditor) => peeks.get(editor)?.close();

/** The HEAD lines a change replaced. */
const oldLines = (head: string[], b: Block) => (b.originalEndLineNumber ? head.slice(b.originalStartLineNumber - 1, b.originalEndLineNumber) : []);

/** Puts a change's HEAD lines back in the editor, as one undoable edit. */
function rollbackChange(editor: monaco.editor.ICodeEditor, c: LineChange) {
  const model = editor.getModel();
  const state = changeStates.get(editor);
  if (!model || !state || !c.block) return;
  const b = c.block;
  const eol = model.getEOL();
  const lines = oldLines(state.head, b);
  const end = (line: number) => model.getLineMaxColumn(line);
  let range: monaco.Range;
  let text = lines.join(eol);
  if (!b.modifiedEndLineNumber) {
    // Lines were deleted after modifiedStartLineNumber (0 means at the top).
    const after = b.modifiedStartLineNumber;
    range = after ? new monaco.Range(after, end(after), after, end(after)) : new monaco.Range(1, 1, 1, 1);
    text = after ? eol + text : text + eol;
  } else {
    const [s, e] = [b.modifiedStartLineNumber, b.modifiedEndLineNumber];
    if (lines.length) range = new monaco.Range(s, 1, e, end(e));
    // Added lines go with a line break: the one after them, or before them at the end of the file.
    else if (e < model.getLineCount()) range = new monaco.Range(s, 1, e + 1, 1);
    else range = s > 1 ? new monaco.Range(s - 1, end(s - 1), e, end(e)) : new monaco.Range(1, 1, e, end(e));
  }
  editor.pushUndoStop();
  editor.executeEdits("rollback", [{ range, text }]);
  editor.pushUndoStop();
}

/** Stages one change: the index gets the editor's lines for it, and keeps what it had elsewhere. */
async function stageChange(editor: monaco.editor.ICodeEditor, c: LineChange) {
  const model = editor.getModel();
  const state = changeStates.get(editor);
  if (!model || !state) return;
  const text = model.getValue(monaco.editor.EndOfLinePreference.LF);
  const staged = await git("show", `:./${state.rel}`).catch(() => null);
  if (staged === null) return host.status(`${state.rel} isn't in the index. Stage the whole file from the Commit view.`);
  // The blocks between the index and the editor that overlap the change, which is against HEAD.
  // A deletion sits between lines, at half a line after the line before it.
  const span = (b: Block) => (b.modifiedEndLineNumber ? [b.modifiedStartLineNumber, b.modifiedEndLineNumber] : [b.modifiedStartLineNumber + 0.5, b.modifiedStartLineNumber + 0.5]);
  const [from, to] = span(c.block!);
  const blocks = lineChanges(staged.split("\n"), text.split("\n"))
    .map((x) => x.block!)
    .filter((b) => span(b)[0] <= to && span(b)[1] >= from);
  if (!blocks.length) return host.status("This change is already staged.");
  if (!(await writeIndex(state.rel, applyBlocks(staged, text, blocks)))) return;
  await refreshGit();
  host.status(`Staged the change at line ${c.start} of ${state.rel}`);
}

/** Moves the cursor to the next or previous change, wrapping around, and shows it if a diff is open or `show` is set. */
export function goToChange(editor: monaco.editor.ICodeEditor, direction: 1 | -1, show = peeks.has(editor)) {
  const changes = changeStates.get(editor)?.changes ?? [];
  if (!changes.length) return host.status("No changes against HEAD in this file.");
  const line = peeks.get(editor)?.change.start ?? editor.getPosition()?.lineNumber ?? 1;
  const c = direction > 0 ? (changes.find((x) => x.start > line) ?? changes[0]) : ([...changes].reverse().find((x) => x.end < line) ?? changes.at(-1)!);
  editor.setPosition({ lineNumber: c.start, column: 1 });
  editor.revealLineInCenterIfOutsideViewport(c.start);
  if (show) peekChange(editor, c);
}

/** Shows a change's HEAD lines in a box below it, with buttons to roll it back, stage it, or move to another change. */
function peekChange(editor: monaco.editor.ICodeEditor, c: LineChange) {
  closePeek(editor);
  const state = changeStates.get(editor);
  const model = editor.getModel();
  if (!state || !model || !c.block) return;
  const lines = oldLines(state.head, c.block);
  const count = (n: number) => `${n} ${n === 1 ? "line" : "lines"}`;
  const size = c.end - c.start + 1;
  const title = c.kind === "added" ? `Added ${count(size)}` : c.kind === "deleted" ? `Deleted ${count(lines.length)}` : lines.length === size ? `Changed ${count(size)}` : `Changed ${count(lines.length)} to ${count(size)}`;
  const dom = document.createElement("div");
  dom.className = "change-peek";
  dom.innerHTML = `<div class="change-peek-bar"><span></span>${[
    ["previous", "arrow-up", "Previous change"],
    ["next", "arrow-down", "Next change"],
    ["stage", "add", "Stage this change"],
    ["rollback", "discard", "Roll back this change"],
    ["close", "close", "Close (Esc)"],
  ]
    .map(([run, icon, label]) => `<button data-run="${run}" title="${label}" aria-label="${label}"><span class="codicon codicon-${icon}"></span></button>`)
    .join("")}</div><pre></pre>`;
  dom.querySelector("span")!.textContent = lines.length ? `${title}. At HEAD:` : title;
  const pre = dom.querySelector("pre")!;
  const { fontFamily, fontSize, lineHeight } = editor.getOption(monaco.editor.EditorOption.fontInfo);
  pre.style.cssText = `font-family: ${fontFamily}; font-size: ${fontSize}px; line-height: ${lineHeight}px`;
  pre.hidden = !lines.length;
  // PHP lines without an opening tag would colorize as HTML, so colorize after one and drop its line.
  const php = model.getLanguageId() === "php";
  if (lines.length)
    monaco.editor.colorize((php ? "<?php\n" : "") + lines.join("\n"), model.getLanguageId(), {}).then((html) => (pre.innerHTML = php ? html.slice(html.indexOf("<br/>") + 5) : html));
  const runs: Record<string, () => unknown> = {
    previous: () => goToChange(editor, -1, true),
    next: () => goToChange(editor, 1, true),
    stage: () => stageChange(editor, c),
    rollback: () => rollbackChange(editor, c),
    close: () => closePeek(editor),
  };
  // Monaco would take the click as one in the text.
  dom.addEventListener("mousedown", (e) => e.stopPropagation());
  dom.onclick = (e) => {
    const run = (e.target as Element).closest<HTMLElement>("[data-run]")?.dataset.run;
    if (run) runs[run]();
  };
  let id = "";
  editor.changeViewZones((zones) => {
    id = zones.addZone({ afterLineNumber: c.block!.modifiedEndLineNumber || c.block!.modifiedStartLineNumber, heightInPx: 30 + (lines.length ? lines.length * lineHeight + 12 : 0), domNode: dom });
  });
  peeks.set(editor, { change: c, close: () => (editor.changeViewZones((zones) => zones.removeZone(id)), peeks.delete(editor)) });
}

/** The gutter's context menu items for the change at a line, if there's one. */
export function changeMenu(editor: monaco.editor.ICodeEditor, line: number): MenuItem[] {
  const c = changeAt(editor, line);
  if (!c) return [];
  return [
    { label: "Show Change", run: () => peekChange(editor, c) },
    { label: "Rollback Change", run: () => rollbackChange(editor, c) },
    { label: "Stage Change", run: () => stageChange(editor, c) },
  ];
}

export function initGit(h: Host) {
  host = h;
  $("diff-close").onclick = closeDiff;
  $("diff").addEventListener("keydown", (e) => {
    if (!e.altKey || !e.metaKey || !diffFiles || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    moveDiff(e.key === "ArrowLeft" ? -1 : 1);
  }, true);
}

/** Opens the commit view with the message box focused. */
export function focusCommit() {
  host.showView("commit");
  refreshGit();
  $("commit-message").focus();
}
