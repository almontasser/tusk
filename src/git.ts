// Git integration: commit view, diff view, and branches. Everything shells out to `git`.
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { monaco } from "./editor";
import { type FileStatus, parseStatus, type Status } from "./gitparse";
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

export const git = (...args: string[]) => invoke<string>("run_capture", { cwd: host.root(), program: "git", args });

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
  renderBranch();
  renderCommitView();
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
  const ok = await ask(untracked ? `Delete the new file ${f.path}?` : `Discard your changes to ${f.path}?`, { kind: "warning" });
  if (!ok) return;
  if (untracked) await invoke("remove_path", { path: `${host.root()}/${f.path}` });
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

export function initGit(h: Host) {
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
