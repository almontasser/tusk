// Git integration: commit view, diff view, and branches. Everything shells out to `git`.
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { monaco } from "./editor";
import { hasConflicts } from "./conflicts";
import { age, type BlameLine, type FileStatus, isConflict, lineChanges, parseBlame, parseStatus, type Status } from "./gitparse";
import { type Item, pick, rank } from "./palette";
import { openTerminal } from "./terminal";

type Host = {
  root(): string;
  openFile(path: string): unknown;
  status(text: string): void;
  showView(name: "commit"): void;
};

const $ = (id: string) => document.getElementById(id)!;
let host: Host;
let current: Status | undefined;
let lastBranch: string | undefined;

/** Functions to call when the checked-out branch (or the project) changes. */
export const branchListeners: (() => void)[] = [];

// `--no-optional-locks` stops read-only commands such as `status` from rewriting .git/index.
// Otherwise every refresh changes .git, the file watcher reports it, and the refresh repeats forever.
const run = (args: string[], input: string | null) =>
  invoke<string>("run_capture", { cwd: host.root(), program: "git", args: ["--no-optional-locks", ...args], input });
export const git = (...args: string[]) => run(args, null);
const gitWithInput = (input: string, ...args: string[]) => run(args, input);

/** Runs a git command that changes state, then refreshes. Errors go to the status bar. */
export async function change(...args: string[]) {
  try {
    await git(...args);
  } catch (e) {
    host.status(`git ${args[0]}: ${String(e).trim()}`);
  }
  await refreshGit();
}

// ---- Status ----

/** Reloads `git status` and redraws the commit view and branch widget. */
export async function refreshGit() {
  if (!host.root()) return;
  current = await git("status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all").then(parseStatus, () => undefined);
  operation = current ? await detectOperation() : null;
  headCache.clear(); // HEAD may have moved.
  const branch = current && `${host.root()}:${current.branch}`;
  if (branch !== lastBranch) {
    lastBranch = branch;
    branchListeners.forEach((f) => f());
  }
  renderBranch();
  renderCommitView();
  onRefresh();
}

function renderBranch() {
  const el = $("branch");
  el.hidden = !current;
  if (!current) return;
  const sync = [current.ahead && `↑${current.ahead}`, current.behind && `↓${current.behind}`].filter(Boolean).join(" ");
  el.textContent = `⎇ ${current.branch}${sync ? ` ${sync}` : ""}`;
  el.title = current.upstream ? `Tracking ${current.upstream}` : "No upstream branch";
}

const staged = (f: FileStatus) => !isConflict(f) && f.index !== " " && f.index !== "?";
const unstaged = (f: FileStatus) => !isConflict(f) && f.worktree !== " ";

// ---- Merges, rebases, cherry-picks, and reverts in progress ----

type Operation = { kind: "merge" | "rebase" | "cherry-pick" | "revert"; gitDir: string };
let operation: Operation | null = null;
let gitDir: { root: string; path: string } | undefined;

/** Reads git's state files to find an operation that stopped, usually for conflicts. */
async function detectOperation(): Promise<Operation | null> {
  if (gitDir?.root !== host.root()) {
    const path = (await git("rev-parse", "--absolute-git-dir").catch(() => "")).trim();
    gitDir = { root: host.root(), path };
  }
  const dir = gitDir.path;
  if (!dir) return null;
  const exists = (name: string) => invoke<boolean>("path_exists", { path: `${dir}/${name}` });
  for (const [name, kind] of [["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["MERGE_HEAD", "merge"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"]] as const) {
    if (await exists(name)) return { kind, gitDir: dir };
  }
  return null;
}

function renderOperation() {
  const banner = $("git-operation");
  banner.hidden = !operation;
  if (!operation) return;
  const { kind, gitDir: dir } = operation;
  const conflicts = current?.files.filter(isConflict).length ?? 0;
  const next = kind === "merge" ? "commit" : "continue";
  banner.querySelector("span")!.textContent =
    `${kind[0].toUpperCase() + kind.slice(1)} in progress. ` + (conflicts ? `Resolve ${conflicts} conflict${conflicts > 1 ? "s" : ""}, then ${next}.` : `No conflicts left: ${next} when ready.`);
  $("operation-abort").onclick = async () => {
    if (await ask(`Abort the ${kind} and return to the state before it? Conflict resolutions are lost.`, { kind: "warning" })) change(kind, "--abort");
  };
  const continueButton = $("operation-continue");
  continueButton.hidden = kind === "merge"; // A merge finishes with a normal commit.
  // GIT_EDITOR=true accepts git's prepared message instead of opening an editor.
  continueButton.onclick = () => openTerminal(host.root(), `${kind} --continue`, ["/bin/sh", "-c", `GIT_EDITOR=true git ${kind} --continue`]);
  // Offer git's prepared merge message, such as "Merge branch 'feature'".
  const message = $("commit-message") as HTMLTextAreaElement;
  if (kind === "merge" && !message.value) invoke<string>("read_file", { path: `${dir}/MERGE_MSG` }).then((m) => (message.value ||= m.replace(/^#.*$/gm, "").trim()), () => {});
}

function conflictRow(f: FileStatus) {
  const li = document.createElement("li");
  li.className = "status-C";
  const name = f.path.split("/").pop()!;
  li.innerHTML = `<span class="letter">!</span><span class="name"></span><span class="dir"></span><span class="buttons"></span>`;
  li.querySelector(".name")!.textContent = name;
  li.querySelector(".dir")!.textContent = f.path.slice(0, -name.length - 1);
  li.title = "Open the file to resolve each conflict, or accept one side";
  li.onclick = () => host.openFile(`${host.root()}/${f.path}`);
  const buttons = li.querySelector(".buttons")!;
  const button = (label: string, title: string, run: () => unknown) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.onclick = (e) => (e.stopPropagation(), run());
    buttons.append(b);
  };
  button("Yours", "Keep your version of the whole file", () => acceptSide(f, "ours"));
  button("Theirs", "Keep their version of the whole file", () => acceptSide(f, "theirs"));
  button("✓", "Mark as resolved (stage the file as it is)", () => change("add", "--", f.path));
  return li;
}

/** Resolves a whole file with one side. If that side deleted the file, resolving deletes it. */
async function acceptSide(f: FileStatus, side: "ours" | "theirs") {
  const deleted = side === "ours" ? f.index === "D" : f.worktree === "D";
  const what = deleted ? `delete ${f.path}, as ${side === "ours" ? "your" : "their"} side did` : `replace ${f.path} with ${side === "ours" ? "your" : "their"} version`;
  if (!(await ask(`Resolve the conflict and ${what}? Other changes to the file are lost.`, { kind: "warning" }))) return;
  if (deleted) return change("rm", "--quiet", "--", f.path);
  try {
    await git("checkout", `--${side}`, "--", f.path);
  } catch (e) {
    host.status(`git checkout: ${String(e).trim()}`);
  }
  await change("add", "--", f.path);
}

/** Stages a conflicted file once it's saved without conflict markers, as PhpStorm does. */
export async function afterSave(path: string, text: string) {
  const rel = path.slice(host.root().length + 1);
  const f = current?.files.find((x) => x.path === rel && isConflict(x));
  if (!f || hasConflicts(text)) return;
  await change("add", "--", rel);
  host.status(`Marked ${rel} as resolved.`);
}

function renderCommitView() {
  $("git-empty").hidden = !!current;
  $("git-changes").hidden = !current;
  if (!current) return;
  const conflicted = current.files.filter(isConflict);
  const stagedFiles = current.files.filter(staged);
  const changedFiles = current.files.filter(unstaged);
  $("conflicts-group").hidden = !conflicted.length;
  $("conflicts-count").textContent = String(conflicted.length);
  $("conflicts").replaceChildren(...conflicted.map(conflictRow));
  $("staged-count").textContent = String(stagedFiles.length);
  $("changes-count").textContent = String(changedFiles.length);
  $("staged").replaceChildren(...stagedFiles.map((f) => fileRow(f, true)));
  $("changes").replaceChildren(...changedFiles.map((f) => fileRow(f, false)));
  renderOperation();
}

function fileRow(f: FileStatus, inIndex: boolean) {
  const letter = inIndex ? f.index : f.worktree === "?" ? "U" : f.worktree;
  const li = document.createElement("li");
  li.className = `status-${letter}`;
  li.title = f.from ? `${f.from} → ${f.path}` : f.path;
  const name = f.path.split("/").pop()!;
  const dir = f.path.slice(0, -name.length - 1);
  li.innerHTML = `<span class="letter"></span><span class="name"></span><span class="dir"></span><span class="buttons"></span>`;
  li.querySelector(".letter")!.textContent = letter;
  li.querySelector(".name")!.textContent = name;
  li.querySelector(".dir")!.textContent = dir;
  li.onclick = () => showChange(f, inIndex);
  const buttons = li.querySelector(".buttons")!;
  const button = (label: string, title: string, run: () => unknown) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.onclick = (e) => (e.stopPropagation(), run());
    buttons.append(b);
  };
  button("↗", "Open file", () => host.openFile(`${host.root()}/${f.path}`));
  if (inIndex) button("−", "Unstage", () => change("restore", "--staged", "--", f.path));
  else {
    button("↺", "Discard changes", () => discard(f));
    button("+", "Stage", () => change("add", "--", f.path));
  }
  return li;
}

async function discard(f: FileStatus) {
  const untracked = f.worktree === "?";
  const ok = await ask(untracked ? `Move the new file ${f.path} to the Trash?` : `Discard your changes to ${f.path}?`, { kind: "warning" });
  if (!ok) return;
  if (untracked) await invoke("trash_path", { path: `${host.root()}/${f.path}` });
  else await change("restore", "--", f.path);
  await refreshGit();
}

async function commit(push: boolean) {
  const message = ($("commit-message") as HTMLTextAreaElement).value.trim();
  const amend = ($("amend") as HTMLInputElement).checked;
  if (!message && !amend) return host.status("Write a commit message first.");
  if (current?.files.some(isConflict)) return host.status("Resolve the merge conflicts first.");
  if (!current?.files.some(staged) && !amend && operation?.kind !== "merge") return host.status("Stage the changes to commit first.");
  const args = ["commit", ...(amend ? ["--amend"] : []), ...(message ? ["-m", message] : ["--no-edit"])];
  try {
    await git(...args);
    ($("commit-message") as HTMLTextAreaElement).value = "";
    ($("amend") as HTMLInputElement).checked = false;
    host.status(amend ? "Amended the last commit." : "Committed.");
    if (push) pushBranch();
  } catch (e) {
    host.status(`Commit failed: ${String(e).trim()}`);
  }
  await refreshGit();
}

// ---- Diff view ----

let diffEditor: monaco.editor.IStandaloneDiffEditor | undefined;

/** Shows a file's staged change (HEAD to index) or unstaged change (index to working tree). */
async function showChange(f: FileStatus, inIndex: boolean) {
  const show = (spec: string) => git("show", spec).catch(() => "");
  const original = inIndex ? await show(`HEAD:${f.from ?? f.path}`) : await show(`:${f.path}`);
  const modified = inIndex
    ? await show(`:${f.path}`)
    : await invoke<string>("read_file", { path: `${host.root()}/${f.path}` }).catch(() => "");
  showDiff(f.path, original, modified, inIndex ? "HEAD ↔ Staged" : f.worktree === "?" ? "New file" : "Staged ↔ Working tree");
}

let diffBack: (() => void) | undefined;

/** Shows a diff in place of the editor. `back` runs when the diff closes, instead of showing the editor. */
export function showDiff(path: string, original: string, modified: string, label: string, back?: () => void) {
  closeDiff(false);
  diffBack = back;
  // No theme option here: it would reset Monaco's global theme. The Theme setting sets it.
  diffEditor ??= monaco.editor.createDiffEditor($("diff-editor"), {
    automaticLayout: true,
    readOnly: true,
    originalEditable: false,
    fontSize: 13,
    fontFamily: "JetBrains Mono, SF Mono, Menlo, monospace",
    minimap: { enabled: false },
  });
  // A non-file scheme keeps these models away from the language servers.
  const uri = (side: string) => monaco.Uri.from({ scheme: "git", path: `/${side}/${path}`, query: String(Date.now()) });
  diffEditor.setModel({
    original: monaco.editor.createModel(original, undefined, uri("original")),
    modified: monaco.editor.createModel(modified, undefined, uri("modified")),
  });
  $("diff-path").textContent = path;
  $("diff-label").textContent = label;
  $("diff-open").onclick = () => (closeDiff(false), host.openFile(`${host.root()}/${path}`));
  document.querySelectorAll<HTMLElement>("#editor, #history").forEach((e) => (e.hidden = true));
  $("diff").hidden = false;
}

/** Closes the diff. By default it returns to where the diff came from, such as the history view. */
export function closeDiff(goBack = true) {
  const model = diffEditor?.getModel();
  diffEditor?.setModel(null);
  model?.original.dispose();
  model?.modified.dispose();
  $("diff").hidden = true;
  const back = diffBack;
  diffBack = undefined;
  if (goBack && back) back();
  else $("editor").hidden = false;
}

// ---- Branches ----

export const pushBranch = () =>
  openTerminal(host.root(), "git push", current?.upstream ? ["git", "push"] : ["git", "push", "-u", "origin", "HEAD"]);
export const updateProject = () => openTerminal(host.root(), "git pull", ["git", "pull"]);

/** Lists branches to check out, plus fetch, pull, push, and creating a branch from the typed name. */
export async function branches() {
  if (!current) return host.status("This folder isn't a git repository.");
  const out = await git("for-each-ref", "--format=%(refname)\t%(HEAD)", "refs/heads", "refs/remotes");
  const refs = out
    .split("\n")
    .filter((l) => l && !l.includes("/HEAD\t"))
    .map((l) => {
      const [ref, head] = l.split("\t");
      const remote = ref.startsWith("refs/remotes/");
      return { name: ref.replace(/^refs\/(heads|remotes)\//, ""), remote, current: head === "*" };
    });
  const names = new Set(refs.map((r) => r.name));
  const fixed: Item[] = [
    { label: "Update Project (git pull)", detail: "⌘T", run: updateProject },
    { label: "Push (git push)", detail: "⌘⇧K", run: pushBranch },
    { label: "Fetch (git fetch)", run: () => openTerminal(host.root(), "git fetch", ["git", "fetch", "--prune"]) },
    { label: "Stash Changes…", run: stashChanges },
    { label: "Stashes…", run: stashes },
  ];
  // Checking out a remote branch such as origin/feature creates a local tracking branch.
  const branchItems: Item[] = refs.map((r) => ({
    label: r.name,
    detail: r.current ? "current" : r.remote ? "remote" : "local",
    run: () => (r.remote ? change("checkout", "--track", r.name) : change("checkout", r.name)),
  }));
  pick(`Branches (on ${current.branch}). Type a name to create a branch.`, (q) => {
    const name = q.trim().replace(/\s+/g, "-");
    const create: Item[] = name && !names.has(name) ? [{ label: `New branch "${name}"`, detail: "from HEAD", run: () => change("checkout", "-b", name) }] : [];
    return [...create, ...rank(q, branchItems), ...rank(q, fixed)];
  });
}

// ---- Editor: change markers, inline blame, and blame annotations ----

const headCache = new Map<string, Promise<string | null>>();
let onRefresh = () => {};

/** The file's content at HEAD, or null for files git doesn't track. */
function headOf(rel: string) {
  if (!headCache.has(rel)) headCache.set(rel, git("show", `HEAD:${rel}`).catch(() => null));
  return headCache.get(rel)!;
}

const annotated = new Set<string>();
let toggleAnnotations = () => {};

/** Toggles blame annotations (commit, age, and author) in place of line numbers. */
export const annotate = () => toggleAnnotations();

/** Adds change markers, inline blame for the cursor line, and blame annotations to an editor. */
function trackEditor(editor: monaco.editor.IStandaloneCodeEditor) {
  const markers = editor.createDecorationsCollection();
  const inline = editor.createDecorationsCollection();
  let blame: { version: number; lines: Promise<BlameLine[]> } | undefined;
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
    const head = rel ? await headOf(rel) : null;
    if (!model || head === null || editor.getModel() !== model) return markers.clear();
    markers.set(
      lineChanges(head.split("\n"), model.getLinesContent()).map((c) => ({
        range: new monaco.Range(c.start, 1, c.end, 1),
        options: { isWholeLine: true, linesDecorationsClassName: `gutter-${c.kind}` },
      })),
    );
  }, 200);

  /** Blame for the editor's current text, including unsaved edits, cached per model version. */
  const blameLines = () => {
    const model = editor.getModel();
    const rel = model && relOf(model);
    if (!model || !rel) return Promise.resolve([]);
    const version = model.getAlternativeVersionId();
    if (blame?.version !== version) {
      blame = { version, lines: gitWithInput(model.getValue(), "blame", "--porcelain", "--contents", "-", "--", rel).then(parseBlame, () => []) };
    }
    return blame.lines;
  };
  const describe = (b: BlameLine) =>
    /^0+$/.test(b.hash) ? "You · Not committed yet" : `${b.author}, ${age(b.time)} ago · ${b.summary}`;

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
    const label = (n: number) => {
      const b = lines[n - 1];
      if (!b || /^0+$/.test(b.hash)) return "";
      return `${b.hash.slice(0, 7)} ${age(b.time).padStart(3)} ${b.author.split(" ")[0].slice(0, 10).padEnd(10)}`;
    };
    editor.updateOptions({ lineNumbers: label, lineNumbersMinChars: 24 });
  };
  toggleAnnotations = () => {
    const model = editor.getModel();
    const rel = model && relOf(model);
    if (!rel) return;
    annotated.has(rel) ? annotated.delete(rel) : annotated.add(rel);
    applyAnnotations();
  };

  const updateAnnotations = debounce(applyAnnotations, 300);
  editor.onDidChangeModel(() => (blame = undefined, updateMarkers(), updateInline(), applyAnnotations()));
  editor.onDidChangeModelContent(() => (updateMarkers(), updateInline(), updateAnnotations()));
  editor.onDidChangeCursorPosition(updateInline);
  onRefresh = () => (blame = undefined, updateMarkers(), updateInline(), updateAnnotations());
}

export function initGit(h: Host, editor: monaco.editor.IStandaloneCodeEditor) {
  trackEditor(editor);
  host = h;
  $("branch").onclick = () => branches();
  $("commit").onclick = () => commit(false);
  $("commit-push").onclick = () => commit(true);
  $("stage-all").onclick = () => change("add", "--all");
  $("unstage-all").onclick = () => change("reset", "--quiet");
  $("diff-close").onclick = () => closeDiff();
  $("commit-message").onkeydown = (e) => {
    if (e.key === "Enter" && e.metaKey) commit(false);
  };
}

/** Opens the commit view with the message box focused. */
export function focusCommit() {
  host.showView("commit");
  refreshGit();
  $("commit-message").focus();
}

// ---- Stash ----

/** Stashes uncommitted changes to tracked files, with an optional message. */
export function stashChanges() {
  if (!current) return host.status("This folder isn't a git repository.");
  pick("Stash changes: type a message, or press ⏎ for none", (q) => [
    {
      label: q.trim() ? `Stash with message "${q.trim()}"` : "Stash without a message",
      detail: "git stash push",
      run: () => change("stash", "push", ...(q.trim() ? ["-m", q.trim()] : [])),
    },
    {
      label: "Stash, including new files",
      detail: "git stash push --include-untracked",
      run: () => change("stash", "push", "--include-untracked", ...(q.trim() ? ["-m", q.trim()] : [])),
    },
  ]);
}

/** Lists stashes; choosing one offers to apply, pop, drop, or show its files. */
export async function stashes() {
  if (!current) return host.status("This folder isn't a git repository.");
  const out = await git("stash", "list", "--format=%gd%x1f%s%x1f%cr").catch(() => "");
  const list = out.split("\n").filter(Boolean).map((l) => l.split("\x1f"));
  if (!list.length) return host.status("There are no stashes.");
  pick("Stashes", (q) =>
    rank(q, list.map(([ref, subject, when]) => ({ label: subject, detail: `${ref} · ${when}`, run: () => stashActions(ref, subject) }))),
  );
}

function stashActions(ref: string, subject: string) {
  const items: Item[] = [
    { label: "Apply", detail: "Keep the stash", run: () => change("stash", "apply", ref) },
    { label: "Pop", detail: "Apply, then drop the stash", run: () => change("stash", "pop", ref) },
    { label: "Show Files", detail: "Diff each file", run: () => stashFiles(ref) },
    {
      label: "Drop",
      detail: "Delete the stash",
      run: async () => (await ask(`Delete the stash "${subject}"? This can't be undone.`, { kind: "warning" })) && change("stash", "drop", ref),
    },
  ];
  pick(`${ref}: ${subject}`, (q) => rank(q, items));
}

async function stashFiles(ref: string) {
  const out = await git("stash", "show", "--include-untracked", "--name-only", ref).catch(() => git("stash", "show", "--name-only", ref));
  const files = out.split("\n").filter(Boolean);
  const show = (spec: string) => git("show", spec).catch(() => "");
  pick(`Files in ${ref}`, (q) =>
    rank(q, files.map((path) => ({
      label: path,
      // Untracked files live in the stash's third parent.
      run: async () => showDiff(path, await show(`${ref}^1:${path}`), (await show(`${ref}:${path}`)) || (await show(`${ref}^3:${path}`)), `${ref} ↔ its base`),
    }))),
  );
}
