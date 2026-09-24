// Git integration: commit view, diff view, and branches. Everything shells out to `git`.
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { monaco } from "./editor";
import { age, type BlameLine, type FileStatus, lineChanges, parseBlame, parseStatus, type Status } from "./gitparse";
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
async function change(...args: string[]) {
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

const staged = (f: FileStatus) => f.index !== " " && f.index !== "?";
const unstaged = (f: FileStatus) => f.worktree !== " ";

function renderCommitView() {
  $("git-empty").hidden = !!current;
  $("git-changes").hidden = !current;
  if (!current) return;
  const stagedFiles = current.files.filter(staged);
  const changedFiles = current.files.filter(unstaged);
  $("staged-count").textContent = String(stagedFiles.length);
  $("changes-count").textContent = String(changedFiles.length);
  $("staged").replaceChildren(...stagedFiles.map((f) => fileRow(f, true)));
  $("changes").replaceChildren(...changedFiles.map((f) => fileRow(f, false)));
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
  if (!current?.files.some(staged) && !amend) return host.status("Stage the changes to commit first.");
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

export function showDiff(path: string, original: string, modified: string, label: string) {
  closeDiff();
  diffEditor ??= monaco.editor.createDiffEditor($("diff-editor"), {
    theme: "vs-dark",
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
  $("diff-open").onclick = () => (closeDiff(), host.openFile(`${host.root()}/${path}`));
  $("editor").hidden = true;
  $("diff").hidden = false;
}

export function closeDiff() {
  const model = diffEditor?.getModel();
  diffEditor?.setModel(null);
  model?.original.dispose();
  model?.modified.dispose();
  $("diff").hidden = true;
  $("editor").hidden = false;
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
  $("diff-close").onclick = closeDiff;
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
