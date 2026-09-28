// The branches popup, as PhpStorm's: a search, repository actions, then local and remote branches with their
// ahead and behind counts. Choosing a branch opens its actions: check out, branch from it, compare, merge, rebase,
// rename, delete, push, and upstream tracking.
import { toast } from "./dom";
import { type DiffFile, git, gitStatus, gitTask, refreshGit, showDiffs, worktrees } from "./git";
import { ago, parseNameStatus, parseRefs, REF_FORMAT, type Ref } from "./gitparse";
import { showCommits } from "./history";
import { confirm, type Item, pick, rank } from "./palette";
import { showStashes, stashChanges } from "./stash";
import { errorText, showError, status } from "./status";

type Host = { commit(): unknown; push(): unknown; update(): unknown };
let host: Host;
const $ = (id: string) => document.getElementById(id)!;
const info = (text: string) => status(text, "app", "info");

/** Reads the branches, local then remote, each newest first. */
async function readRefs(): Promise<Ref[]> {
  const refs = parseRefs(await git("for-each-ref", "--sort=-committerdate", REF_FORMAT, "refs/heads", "refs/remotes"));
  return refs.sort((a, b) => Number(a.remote) - Number(b.remote) || Number(b.current) - Number(a.current));
}

const sync = (r: Ref) => [r.ahead && `↑${r.ahead}`, r.behind && `↓${r.behind}`].filter(Boolean).join(" ");

/** The branch popup below the title bar's branch name (or the status bar's, with `anchor`). */
export async function branches(anchor = $("branch")) {
  const st = gitStatus();
  if (!st) return showError("This folder isn't a git repository. Run Initialize Repository to create one.");
  let refs: Ref[];
  try {
    refs = await readRefs();
  } catch (e) {
    return showError("Can't list the branches", e);
  }
  const current = st.branch;
  const names = new Set(refs.map((r) => r.name));
  const top: Item[] = [
    { label: "Update Project…", detail: "⌘T", icon: "codicon-arrow-down", run: host.update },
    { label: "Commit…", detail: "⌘K", icon: "codicon-git-commit", run: host.commit },
    { label: "Push…", detail: "⌘⇧K", icon: "codicon-arrow-up", run: host.push },
    { label: "Fetch", icon: "codicon-sync", run: fetchAll },
    { label: "New Branch…", detail: `from ${current}`, icon: "codicon-add", run: () => newBranch("HEAD", current) },
    { label: "Checkout Tag or Revision…", icon: "codicon-tag", run: checkoutRevision },
    { label: "Stash Changes…", icon: "codicon-archive", run: stashChanges },
    { label: "Stashes", icon: "codicon-list-unordered", run: showStashes },
    { label: "Worktrees…", icon: "codicon-folder-library", run: worktrees },
  ];
  const branchItems: Item[] = refs.map((r) => ({
    label: r.name,
    detail: [r.remote ? "remote" : "local", r.current && "current", sync(r), r.gone ? "upstream gone" : !r.remote && r.upstream, ago(r.time)].filter(Boolean).join(" · "),
    icon: r.current ? "codicon-check" : r.remote ? "codicon-cloud" : "codicon-git-branch",
    run: () => branchActions(r, current, refs, anchor),
  }));
  pick(
    `Branches (on ${current}): search, or type a name for a new branch`,
    (q) => {
      if (!q.trim()) return [...top, ...branchItems];
      const name = q.trim().replace(/\s+/g, "-");
      const create: Item[] = names.has(name) ? [] : [{ label: `New branch "${name}"`, detail: `from ${current}`, icon: "codicon-add", run: () => checkoutNew(name, "HEAD") }];
      return [...rank(q, branchItems), ...create, ...rank(q, top)];
    },
    0,
    { value: "", anchor },
  );
}

/** A branch's actions, in a popup titled with its name, as PhpStorm's branch submenu. */
function branchActions(r: Ref, current: string, refs: Ref[], anchor: HTMLElement) {
  const b = r.name;
  const q = (s: string) => `'${s}'`;
  const items: (Item | false)[] = [
    !r.current && { label: "Checkout", run: () => checkout(r, refs) },
    { label: `New Branch from ${q(b)}…`, run: () => newBranch(b, b) },
    !r.current && !r.remote && { label: `Checkout and Rebase onto ${q(current)}`, run: () => gitTask(`Rebasing ${b} onto ${current}…`, ["rebase", current, b], `Can't rebase ${b}`).then((o) => o !== undefined && info(`Rebased ${b} onto ${current}.`)) },
    !r.current && { label: `Compare with ${q(current)}`, detail: "Commits on each side", run: () => compare(b, current) },
    !r.current && { label: `Show Diff with ${q(current)}`, detail: "Files that differ", run: () => diffWith(b, current) },
    !r.current && { label: `Rebase ${q(current)} onto ${q(b)}`, run: () => gitTask(`Rebasing ${current} onto ${b}…`, ["rebase", b], `Can't rebase ${current}`).then((o) => o !== undefined && info(`Rebased ${current} onto ${b}.`)) },
    !r.current && { label: `Merge ${q(b)} into ${q(current)}`, run: () => gitTask(`Merging ${b}…`, ["merge", "--no-edit", b], `Can't merge ${b}`).then((o) => o !== undefined && info(/Already up to date/.test(o) ? `${current} already has ${b}.` : `Merged ${b} into ${current}.`)) },
    !r.remote && { label: "Push…", detail: r.upstream ? `to ${r.upstream}` : "and set the upstream branch", run: () => (r.current ? host.push() : pushBranch(r)) },
    r.current && { label: "Update", detail: "Pull", run: host.update },
    !r.remote && { label: "Rename…", run: () => rename(b) },
    !r.remote && { label: r.upstream ? `Track Another Branch… (tracks ${r.upstream})` : "Set Upstream Branch…", run: () => track(b, refs) },
    !r.remote && !!r.upstream && { label: "Stop Tracking", detail: `Untrack ${r.upstream}`, run: () => gitTask("Removing the upstream branch…", ["branch", "--unset-upstream", b], `Can't untrack ${r.upstream}`).then((o) => o !== undefined && info(`${b} no longer tracks ${r.upstream}.`)) },
    !r.current && { label: "Delete…", detail: r.remote ? "On the remote" : undefined, run: () => (r.remote ? deleteRemote(b) : deleteLocal(b)) },
  ];
  const list = items.filter((i): i is Item => !!i);
  pick(b, (text) => rank(text, list), 0, { value: "", title: `${r.remote ? "Remote branch" : "Branch"} ${b}`, numbered: true, anchor });
}

// ---- Actions ----

/**
 * Checks out a branch. A remote branch gets a local tracking branch, or the local branch of the same name if it
 * has one. When local changes are in the way, the error offers to stash them, check out, and restore them.
 */
async function checkout(r: Ref, refs: Ref[]) {
  let args = ["checkout", r.name];
  if (r.remote) {
    const local = r.name.slice(r.name.indexOf("/") + 1);
    args = refs.some((x) => !x.remote && x.name === local) ? ["checkout", local] : ["checkout", "--track", r.name];
  }
  const target = args.at(-1)!;
  const out = await gitTask(`Checking out ${target}…`, args, `Can't check out ${target}`);
  if (out !== undefined) return info(`Checked out ${target}.`);
  // git refuses when uncommitted changes would be overwritten.
  const blocked = await git("checkout", "--dry-run", ...args.slice(1)).then(() => false, (e) => /would be overwritten|commit your changes or stash/i.test(errorText(e)));
  if (blocked)
    showError(`Your changes would be overwritten by checking out ${target}`, undefined, {
      label: "Smart Checkout",
      run: () => smartCheckout(args, target),
    });
}

/** Stashes the changes, checks out, and brings the changes back, as PhpStorm's Smart Checkout. */
async function smartCheckout(args: string[], target: string) {
  if ((await gitTask("Stashing your changes…", ["stash", "push", "--include-untracked", "-m", `Smart checkout of ${target}`], "Can't stash your changes")) === undefined) return;
  const ok = (await gitTask(`Checking out ${target}…`, args, `Can't check out ${target}`)) !== undefined;
  const restored = (await gitTask("Restoring your changes…", ["stash", "pop"], "Your changes are kept in the stash")) !== undefined;
  if (ok && restored) info(`Checked out ${target} with your changes.`);
}

function nameFrom(q: string) {
  return q.trim().replace(/\s+/g, "-");
}

/** Asks for a name, then creates a branch at `start` and checks it out. */
function newBranch(start: string, from: string) {
  pick(`New branch from ${from}`, (q) => {
    const name = nameFrom(q);
    return name ? [{ label: `Create and check out "${name}"`, detail: `from ${from}`, icon: "codicon-add", run: () => checkoutNew(name, start) }] : [];
  });
}

const checkoutNew = (name: string, start: string) =>
  gitTask(`Creating ${name}…`, ["checkout", "-b", name, start], `Can't create ${name}`).then((o) => o !== undefined && info(`Created and checked out ${name}.`));

function checkoutRevision() {
  pick("Check out a tag, commit, or branch (detached HEAD)", (q) => {
    const rev = q.trim();
    return rev ? [{ label: `Check out ${rev}`, detail: "detached HEAD", run: () => gitTask(`Checking out ${rev}…`, ["checkout", "--detach", rev], `Can't check out ${rev}`).then((o) => o !== undefined && info(`Checked out ${rev}.`)) }] : [];
  });
}

/** Shows the commits on either side: the branch's that the current branch lacks, and the other way round. */
function compare(b: string, current: string) {
  pick(`Compare ${b} with ${current}`, (q) =>
    rank(q, [
      { label: `Commits in ${b} that aren't in ${current}`, run: () => showCommits([`${current}..${b}`], `In ${b}, not in ${current}`) },
      { label: `Commits in ${current} that aren't in ${b}`, run: () => showCommits([`${b}..${current}`], `In ${current}, not in ${b}`) },
    ]), 0, { value: "", title: `Compare ${b} with ${current}`, numbered: true });
}

/** The files that differ between the current branch and another, each as a diff. */
async function diffWith(b: string, current: string) {
  let files;
  try {
    files = parseNameStatus(await git("diff", "--name-status", "-M", "-z", current, b));
  } catch (e) {
    return showError(`Can't compare with ${b}`, e);
  }
  if (!files.length) return info(`${current} and ${b} have the same files.`);
  const show = (spec: string) => git("show", spec).catch(() => "");
  const list: DiffFile[] = files.map((f) => ({
    path: f.path,
    status: f.status,
    load: async () => [f.status === "A" ? "" : await show(`${current}:${f.from ?? f.path}`), f.status === "D" ? "" : await show(`${b}:${f.path}`)],
  }));
  showDiffs(list, `${current} ↔ ${b}`);
}

function rename(b: string) {
  pick(`Rename ${b}`, (q) => {
    const name = nameFrom(q);
    return name && name !== b ? [{ label: `Rename "${b}" to "${name}"`, run: () => gitTask(`Renaming ${b}…`, ["branch", "-m", b, name], `Can't rename ${b}`).then((o) => o !== undefined && info(`Renamed ${b} to ${name}.`)) }] : [];
  }, 0, { value: b, select: [0, b.length] });
}

/** Deletes a local branch. One with unmerged commits asks before a force delete; either way, Restore undoes it. */
async function deleteLocal(b: string) {
  const hash = (await git("rev-parse", b).catch(() => "")).trim();
  const restore = hash ? { label: "Restore", run: () => gitTask(`Restoring ${b}…`, ["branch", b, hash], `Can't restore ${b}`).then((o) => o !== undefined && info(`Restored ${b}.`)) } : undefined;
  try {
    await git("branch", "-d", b);
  } catch (e) {
    if (!/not fully merged/.test(errorText(e))) return showError(`Can't delete ${b}`, e);
    if (!(await confirm(`${b} has commits that aren't merged into the current branch or its upstream. Delete it anyway? Those commits are then only in the reflog.`, "Force Delete"))) return;
    try {
      await git("branch", "-D", b);
    } catch (e) {
      return showError(`Can't delete ${b}`, e);
    }
  }
  await refreshGit();
  status(`Deleted ${b}${hash ? ` (was ${hash.slice(0, 7)})` : ""}.`, "app", "info");
  if (restore) toast(`Deleted ${b}.`, { kind: "info", action: restore, timeout: 10000 });
}

async function deleteRemote(name: string) {
  const [remote, ...rest] = name.split("/");
  const branch = rest.join("/");
  if (!(await confirm(`Delete ${branch} from ${remote}? Everyone who fetches loses it.`, "Delete on Remote"))) return;
  const out = await gitTask(`Deleting ${name}…`, ["push", remote, "--delete", branch], `Can't delete ${name}`, { cancellable: true });
  if (out !== undefined) info(`Deleted ${branch} from ${remote}.`);
}

/** Pushes a branch that isn't checked out, setting its upstream branch on the first push. */
async function pushBranch(r: Ref) {
  const [remote, ...rest] = r.upstream?.split("/") ?? [await defaultRemote()];
  if (!remote) return showError("This repository has no remote to push to.");
  const target = rest.join("/") || r.name;
  const args = ["push", "--porcelain", ...(r.upstream ? [] : ["-u"]), remote, `${r.name}:${target}`];
  const out = await gitTask(`Pushing ${r.name}…`, args, `Can't push ${r.name}`, { cancellable: true });
  if (out !== undefined) info(/\[up to date\]/.test(out) ? `${remote}/${target} is up to date.` : `Pushed ${r.name} to ${remote}/${target}.`);
}

/** The remote to use when a branch has none: origin, or the only one. */
export async function defaultRemote() {
  const remotes = (await git("remote").catch(() => "")).split("\n").filter(Boolean);
  return remotes.includes("origin") ? "origin" : remotes[0];
}

/** Sets a local branch's upstream to a remote branch you choose. */
async function track(b: string, refs: Ref[]) {
  const remotes = refs.filter((r) => r.remote);
  if (!remotes.length) return showError("There are no remote branches to track. Fetch first, or push the branch.");
  pick(`Upstream branch for ${b}`, (q) =>
    rank(q, remotes.map((r) => ({ label: r.name, icon: "codicon-cloud", run: () => gitTask(`Tracking ${r.name}…`, ["branch", `--set-upstream-to=${r.name}`, b], `Can't track ${r.name}`).then((o) => o !== undefined && info(`${b} now tracks ${r.name}.`)) }))),
  );
}

/** Fetches every remote and prunes deleted branches, then says what changed. */
export async function fetchAll() {
  if (!gitStatus()) return showError("This folder isn't a git repository.");
  const out = await gitTask("Fetching…", ["fetch", "--all", "--prune"], "Fetch failed", { cancellable: true });
  if (out === undefined) return;
  const updated = out.split("\n").filter((l) => l.includes(" -> ") && !l.includes("[deleted]")).length;
  const pruned = out.split("\n").filter((l) => l.includes("[deleted]")).length;
  info(updated || pruned ? `Fetched: ${[updated && `${updated} ${updated === 1 ? "branch" : "branches"} updated`, pruned && `${pruned} pruned`].filter(Boolean).join(", ")}.` : "Fetched. Everything is up to date.");
}

export function initBranches(h: Host) {
  host = h;
  $("branch").onclick = () => branches($("branch"));
  $("status-branch").onclick = () => branches($("status-branch"));
  $("git-fetch").onclick = fetchAll;
}
