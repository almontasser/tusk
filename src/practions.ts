// Pull requests: merging, the More Actions menu, and editing the title, reviewers, assignees, and labels.
import { confirm, pick } from "./palette";
import { showError, withProgress } from "./status";
import { type Details, el, gh, host, hub, myLogin } from "./prshared";
import { git, gitOperation, gitStatus, gitTask } from "./git";
import { loadPullRequests } from "./prlist";
import { isConflict } from "./gitparse";
import { openMerge } from "./merge";
import { type MergeInfo, mergeActions, mergeMessage, revertMessage } from "./prmergedata";

/** The people who can be assigned in a repository, the current one unless you name another as `owner/repo`. */
export const assignable = (repo = "{owner}/{repo}") => gh("api", "--paginate", `repos/${repo}/assignees`, "--jq", ".[].login").then((out) => out.split("\n").filter(Boolean));
/** A repository's labels, the current one's unless you name another as `owner/repo`. */
export const repoLabels = (repo?: string) =>
  gh("label", "list", "--limit", "500", "--json", "name,description,color", ...(repo ? ["-R", repo] : [])).then((out) => JSON.parse(out) as { name: string; description: string; color: string }[]);

/** Adds or removes an assignee, from the people who can be assigned in the repository. */
export function editAssignees(pr: Details, run: (progress: string, args: string[], done: string, error: string) => unknown) {
  const people = assignable();
  const has = new Set(pr.assignees.map((a) => a.login));
  pick("Assign or unassign", async (q) => {
    const logins = await people.catch((e) => (showError("Can't list the people who can be assigned", e), [] as string[]));
    return logins
      .filter((l) => l.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => Number(has.has(b)) - Number(has.has(a)) || Number(b === myLogin) - Number(a === myLogin))
      .map((l) => ({
        label: `${has.has(l) ? "✓ " : ""}${l}${l === myLogin ? " (you)" : ""}`,
        detail: has.has(l) ? "unassign" : undefined,
        run: () => run(`Changing the assignees of #${pr.number}…`, ["pr", "edit", String(pr.number), has.has(l) ? "--remove-assignee" : "--add-assignee", l], `${has.has(l) ? "Unassigned" : "Assigned"} ${l}`, "Can't change the assignees"),
      }));
  });
}

/** The pull request's actions that aren't buttons on its page. */
export function more(pr: Details, run: (progress: string, args: string[], done: string, error: string) => unknown) {
  const n = String(pr.number);
  const items = [
    { label: "Edit Title…", run: () => editTitle(pr, run) },
    { label: "Request Review…", run: () => requestReview(pr, run) },
    { label: "Labels…", run: () => editLabels(pr, run) },
    ...(pr.state === "OPEN"
      ? [
          pr.isDraft
            ? { label: "Mark Ready for Review", run: () => run(`Marking #${n} ready…`, ["pr", "ready", n], `Marked #${n} ready for review`, `Can't mark #${n} ready`) }
            : { label: "Convert to Draft", run: () => run(`Converting #${n} to a draft…`, ["pr", "ready", n, "--undo"], `Converted #${n} to a draft`, `Can't convert #${n} to a draft`) },
          ...(pr.mergeStateStatus === "BEHIND" ? [{ label: `Update Branch from ${pr.baseRefName}…`, run: () => updateBranch(pr, run) }] : []),
          {
            label: "Close Pull Request…",
            run: async () => (await confirm(`Close #${n} "${pr.title}" without merging?`, "Close Pull Request")) && run(`Closing #${n}…`, ["pr", "close", n], `Closed #${n}`, `Can't close #${n}`),
          },
        ]
      : pr.state === "CLOSED"
        ? [{ label: "Reopen Pull Request", run: () => run(`Reopening #${n}…`, ["pr", "reopen", n], `Reopened #${n}`, `Can't reopen #${n}`) }]
        : []),
    { label: "Copy Link", run: () => navigator.clipboard.writeText(pr.url).then(() => host.status(`Copied ${pr.url}`)) },
    { label: "Copy Branch Name", run: () => navigator.clipboard.writeText(pr.headRefName).then(() => host.status(`Copied ${pr.headRefName}`)) },
  ];
  pick(`#${pr.number}`, () => items);
}

/** Brings the base branch's changes into the pull request on GitHub, by a merge or a rebase. */
export function updateBranch(pr: Details, run: (progress: string, args: string[], done: string, error: string) => unknown) {
  const n = String(pr.number);
  // GitHub updates the branch in the background, so the first redraw can still say it's behind; a second one, a few
  // seconds later, shows the new commit and its checks.
  const update = async (...args: Parameters<typeof run>) => {
    await run(...args);
    setTimeout(() => hub.renderPullRequest(pr.number), 5000);
  };
  pick(`Update #${n} from ${pr.baseRefName} on GitHub`, () => [
    { label: `Merge ${pr.baseRefName} into ${pr.headRefName}`, run: () => update(`Updating #${n}…`, ["pr", "update-branch", n], `Updated #${n} from ${pr.baseRefName}`, `Can't update #${n}`) },
    {
      label: `Rebase ${pr.headRefName} onto ${pr.baseRefName}`,
      detail: "Rewrites the branch's commits; a checked-out copy can't pull them with a fast-forward",
      run: () => update(`Rebasing #${n}…`, ["pr", "update-branch", n, "--rebase"], `Rebased #${n} onto ${pr.baseRefName}`, `Can't rebase #${n}`),
    },
    { label: "Cancel", run: () => {} },
  ]);
}

/** Asks for a new title, starting from the current one. */
function editTitle(pr: Details, run: (progress: string, args: string[], done: string, error: string) => unknown) {
  pick(
    "Title",
    (q) => {
      const title = q.trim();
      return title && title !== pr.title ? [{ label: `Rename to "${title}"`, run: () => run(`Renaming #${pr.number}…`, ["pr", "edit", String(pr.number), "--title", title], `Renamed #${pr.number}`, `Can't rename #${pr.number}`) }] : [];
    },
    0,
    { value: pr.title, title: `Edit the title of #${pr.number}` },
  );
}

/** Asks for someone to review, from the people who can be assigned in the repository. */
export function requestReview(pr: Details, run: (progress: string, args: string[], done: string, error: string) => unknown) {
  const people = assignable();
  const asked = new Set([...pr.reviewRequests.map((r) => r.login), ...pr.latestReviews.map((r) => r.author.login)]);
  pick("Request a review from", async (q) => {
    const logins = (await people.catch((e) => (showError("Can't list the people who can review", e), [] as string[]))).filter((l) => l !== pr.author.login);
    if (!logins.length) return [{ label: "No one else in the repository can review", run: () => {} }];
    return logins
      .filter((l) => l.toLowerCase().includes(q.toLowerCase()))
      .map((l) => ({ label: l, detail: asked.has(l) ? "asked again" : undefined, run: () => run(`Requesting a review from ${l}…`, ["pr", "edit", String(pr.number), "--add-reviewer", l], `Asked ${l} to review #${pr.number}`, `Can't request a review from ${l}`) }));
  });
}

/** Adds or removes a label, from the repository's labels. */
export function editLabels(pr: Details, run: (progress: string, args: string[], done: string, error: string) => unknown) {
  const labels = repoLabels();
  const has = new Set(pr.labels.map((l) => l.name));
  pick("Add or remove a label", async (q) => {
    const all = await labels.catch((e) => (showError("Can't list the labels", e), []));
    return all
      .filter((l) => l.name.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => Number(has.has(b.name)) - Number(has.has(a.name)))
      .map((l) => ({
        label: `${has.has(l.name) ? "✓ " : ""}${l.name}`,
        detail: has.has(l.name) ? "remove" : l.description || undefined,
        run: () => run(`Changing the labels of #${pr.number}…`, ["pr", "edit", String(pr.number), has.has(l.name) ? "--remove-label" : "--add-label", l.name], `${has.has(l.name) ? "Removed" : "Added"} ${l.name}`, "Can't change the labels"),
      }));
  });
}

// ---- Merging ----

const INFO_QUERY = `query($id: ID!) { node(id: $id) { ... on PullRequest {
  isMergeQueueEnabled isInMergeQueue mergeQueueEntry { position state } autoMergeRequest { mergeMethod }
  viewerCanMergeAsAdmin viewerCanEnableAutoMerge isCrossRepository headRef { id target { oid } } viewerCanDeleteHeadRef baseRepository { viewerPermission }
  squashTitle: viewerMergeHeadlineText(mergeType: SQUASH) squashBody: viewerMergeBodyText(mergeType: SQUASH)
  mergeTitle: viewerMergeHeadlineText(mergeType: MERGE) mergeBody: viewerMergeBodyText(mergeType: MERGE) } } }`;
const queryInfo = (id: string) =>
  gh("api", "graphql", "-f", `query=${INFO_QUERY}`, "-f", `id=${id}`, "--jq", ".data.node").then((out) => JSON.parse(out) as MergeInfo & { autoMergeRequest: { mergeMethod: string } | null });

/** The merge queue, admin, and branch facts of each loaded pull request, read once per load and shared by its status box and Merge…. */
const infos = new WeakMap<Details, Promise<MergeInfo | null>>();
export function mergeInfo(pr: Details): Promise<MergeInfo | null> {
  let info = infos.get(pr);
  // Without it, merging works as before: no queue, no admin bypass, no branch actions.
  if (!info) infos.set(pr, (info = queryInfo(pr.id).catch(() => null)));
  return info;
}

/** The merge methods the repository allows, read once per project. */
let mergeSettings: { root: string; allowed: Promise<Record<string, boolean>> } | undefined;
const lastMethodKey = () => `pr-merge-method:${host.root()}`;

/** Asks how to merge, confirms, and merges on GitHub, or adds to or removes from the merge queue. */
export async function merge(pr: Details) {
  const info = await mergeInfo(pr);
  const can = mergeActions(pr, info);
  const n = pr.number;
  if (can.dequeue) return dequeue(pr);
  if (!info?.isMergeQueueEnabled) return chooseMethod(pr, info, false);
  // The queue merges with the method set in the base branch's rules, so there's no method to choose.
  pick(`Add #${n} "${pr.title}" to the merge queue for ${pr.baseRefName}?`, () => [
    ...(can.enqueue ? [{ label: "Add to Merge Queue", detail: "GitHub merges it when its turn comes and its checks pass", run: () => enqueue(pr) }] : []),
    ...(can.admin ? [{ label: "Merge Without the Queue…", detail: "Uses your admin rights to skip the queue and the branch's requirements", run: () => chooseMethod(pr, info, true) }] : []),
    { label: "Cancel", run: () => {} },
  ]);
}

async function enqueue(pr: Details) {
  const n = pr.number;
  if ((await withProgress(`Adding #${n} to the merge queue…`, () => gh("pr", "merge", String(n)), { error: `Can't add #${n} to the merge queue` })) === undefined) return;
  // While required checks still run, gh turns on auto-merge instead, which queues it once they pass.
  const now = await queryInfo(pr.id).catch(() => null);
  host.status(now?.isInMergeQueue ? `Added #${n} to the merge queue` : now?.autoMergeRequest ? `Turned on auto-merge for #${n}. GitHub queues it once checks pass` : `Asked GitHub to queue #${n}`);
  hub.renderPullRequest(n);
}

/** Takes the pull request out of the merge queue, through GraphQL, since gh has no command for it. */
export async function dequeue(pr: Details) {
  const n = pr.number;
  if (!(await confirm(`Remove #${n} "${pr.title}" from the merge queue for ${pr.baseRefName}?`, "Remove from Merge Queue"))) return;
  const query = "mutation($id: ID!) { dequeuePullRequest(input: {id: $id}) { clientMutationId } }";
  if ((await withProgress(`Removing #${n} from the merge queue…`, () => gh("api", "graphql", "-f", `query=${query}`, "-f", `id=${pr.id}`), { error: `Can't remove #${n} from the merge queue` })) === undefined) return;
  host.status(`Removed #${n} from the merge queue`);
  hub.renderPullRequest(n);
}

/** Asks for the method, the commit message, and then which way to merge. `adminOnly` offers only the admin bypass. */
async function chooseMethod(pr: Details, info: MergeInfo | null, adminOnly: boolean) {
  if (mergeSettings?.root !== host.root())
    mergeSettings = {
      root: host.root(),
      allowed: gh("api", "repos/{owner}/{repo}", "--jq", "{merge: .allow_merge_commit, squash: .allow_squash_merge, rebase: .allow_rebase_merge}").then(JSON.parse, () => ({ merge: true, squash: true, rebase: true })),
    };
  const allowed = await mergeSettings.allowed;
  let last = "";
  try {
    last = localStorage.getItem(lastMethodKey()) ?? "";
  } catch {
    // Storage is off; the methods keep GitHub's order.
  }
  const can = mergeActions(pr, info);
  const n = String(pr.number);
  // The methods the repository allows (GitHub turns off the others), the one you used last first.
  const methods = (
    [
      { label: "Create a merge commit", flag: "--merge", key: "merge" },
      { label: "Squash and merge", flag: "--squash", key: "squash" },
      { label: "Rebase and merge", flag: "--rebase", key: "rebase" },
    ] as const
  )
    .filter((m) => allowed[m.key] !== false)
    .sort((a, b) => Number(b.key === last) - Number(a.key === last));
  pick(`Merge #${n} into ${pr.baseRefName}`, () =>
    methods.map((m) => ({
      label: m.label,
      detail: m.key === last ? "last used" : undefined,
      run: async () => {
        // A rebase keeps the branch's commits as they are, so it has no message to edit.
        const message = m.key === "rebase" ? undefined : await editMessage(`${m.label}: #${n} into ${pr.baseRefName}`, mergeMessage(m.key, pr, info));
        if (message === null) return;
        const text = message ? ["--subject", message.subject, "--body", message.body] : [];
        const go = (extra: string[], verb: string) => async () => {
          const merged = await withProgress(`${verb} #${n}…`, () => gh("pr", "merge", n, m.flag, ...text, ...extra), { error: `Can't merge #${n}` });
          if (merged === undefined) return;
          try {
            localStorage.setItem(lastMethodKey(), m.key);
          } catch {
            // Storage is off; nothing to remember.
          }
          host.status(extra.includes("--auto") ? `Turned on auto-merge for #${n}` : `Merged #${n}`);
          hub.renderPullRequest(pr.number);
        };
        const admin = { label: `${m.label} without waiting for requirements`, detail: "Uses your admin rights to skip required reviews, checks, and the merge queue", run: go(["--admin"], "Merging") };
        // Confirmed in the palette rather than a native dialog, which a page reload could leave stuck on screen.
        pick(`${m.label}: #${n} "${pr.title}" into ${pr.baseRefName} on GitHub?`, () => [
          ...(adminOnly
            ? [admin]
            : [
                ...(can.auto ? [{ label: "Merge When Ready (auto-merge)", detail: "GitHub merges once checks and reviews pass", run: go(["--auto"], "Turning on auto-merge for") }] : []),
                { label: `${m.label} on GitHub`, run: go([], "Merging") },
                // gh deletes the local branch too, switching to the base first when it's checked out here.
                { label: `${m.label} and delete ${pr.headRefName}`, detail: "Deletes the branch on GitHub and here", run: go(["--delete-branch"], "Merging") },
                ...(can.admin ? [admin] : []),
              ]),
          { label: "Cancel", run: () => {} },
        ]);
      },
    })),
  );
}

/**
 * Asks for the merge commit's subject and body, starting from `initial`. Null when you cancel. A dialog rather than
 * the palette, since the body has several lines; the palette still confirms after it.
 */
function editMessage(title: string, initial: { subject: string; body: string }): Promise<{ subject: string; body: string } | null> {
  return new Promise((resolve) => {
    const dialog = el("dialog", "refactor-dialog pr-merge-dialog");
    dialog.setAttribute("aria-label", title);
    const form = el("form");
    form.method = "dialog";
    const field = (text: string, input: HTMLInputElement | HTMLTextAreaElement) => {
      const label = el("label", "field", text);
      label.append(input);
      return label;
    };
    const subject = el("input");
    subject.value = initial.subject;
    subject.required = true;
    const body = el("textarea");
    body.value = initial.body;
    body.rows = 10;
    const cancel = el("button", "", "Cancel");
    cancel.type = "button";
    cancel.onclick = () => dialog.close();
    const ok = el("button", "primary", "Continue");
    ok.type = "submit";
    ok.title = "Continue to confirm the merge (⌘↩ or Ctrl+Enter)";
    const buttons = el("div", "buttons");
    buttons.append(cancel, ok);
    form.append(el("h2", "", title), field("Commit subject", subject), field("Commit message", body), buttons);
    let result: { subject: string; body: string } | null = null;
    form.onsubmit = (e) => {
      e.preventDefault();
      if (!subject.value.trim()) return subject.focus();
      result = { subject: subject.value.trim(), body: body.value };
      dialog.close();
    };
    // ⌘↩ (Ctrl+Enter) continues from the body too, as in the comment box.
    form.onkeydown = (e) => void (e.key === "Enter" && (e.metaKey || e.ctrlKey) && (e.preventDefault(), form.requestSubmit()));
    // Escape closes the dialog too, which cancels.
    dialog.addEventListener("close", () => (dialog.remove(), resolve(result)));
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    subject.focus();
  });
}

/**
 * Brings the base branch into the pull request's branch here, so you resolve its conflicts in the merge tool, then
 * commit and push yourself. It checks out the branch first, unless it's checked out already.
 */
export async function resolveConflicts(pr: Details, checkOut: () => Promise<boolean>) {
  const busy = gitOperation();
  if (busy) return showError(`A ${busy.kind} is in progress. Finish or abort it first`);
  const base = pr.baseRefName;
  if (!(await confirm(`Check out #${pr.number} and merge ${base} into ${pr.headRefName} here, to resolve the conflicts in the merge tool? Nothing is pushed.`, "Resolve Conflicts"))) return;
  // A branch of the same name is the pull request's only when it has the pull request's head; a fork's `main` isn't yours.
  const here = gitStatus()?.branch === pr.headRefName && (await git("merge-base", "--is-ancestor", pr.headRefOid, "HEAD").then(() => true, () => false));
  if (!here && !(await checkOut())) return;
  // The same remote-tracking ref the pull request's diff fetches.
  if ((await gitTask(`Fetching ${base}…`, ["fetch", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`], `Can't fetch ${base}`)) === undefined) return;
  // On conflicts gitTask says "<failure>: N files have conflicts…", and the merge tool opens on the first one.
  if ((await gitTask(`Merging ${base} into ${pr.headRefName}…`, ["merge", "--no-edit", `origin/${base}`], `Can't merge ${base} into ${pr.headRefName}`)) !== undefined)
    return host.status(`Merged ${base} into ${pr.headRefName} with no conflicts. Push to update #${pr.number}.`);
  const conflicted = gitStatus()?.files.filter(isConflict) ?? [];
  if (conflicted.length) openMerge(conflicted[0].path);
}

/** Opens a pull request on GitHub that reverts a merged one, then shows it. */
export async function revert(pr: Details) {
  const n = pr.number;
  const { title, body } = revertMessage(pr);
  if (!(await confirm(`Create a pull request on GitHub that reverts #${n} "${pr.title}" in ${pr.baseRefName}? Nothing changes until you merge it.`, "Create Revert Pull Request"))) return;
  const query = "mutation($id: ID!, $title: String!, $body: String!) { revertPullRequest(input: {pullRequestId: $id, title: $title, body: $body}) { revertPullRequest { number title } } }";
  const out = await withProgress(
    `Creating a pull request that reverts #${n}…`,
    () => gh("api", "graphql", "-f", `query=${query}`, "-f", `id=${pr.id}`, "-f", `title=${title}`, "-f", `body=${body}`, "--jq", ".data.revertPullRequest.revertPullRequest"),
    { error: `Can't revert #${n}` },
  );
  if (out === undefined) return;
  const created = JSON.parse(out) as { number: number; title: string };
  host.status(`Created #${created.number}, which reverts #${n}`);
  loadPullRequests();
  hub.showPullRequest(created.number, created.title);
}

/** The REST path of a branch's ref. The name's slashes stay, as GitHub expects `heads/feature/a`. */
const branchRef = (name: string) => `repos/{owner}/{repo}/git/refs/heads/${name.split("/").map(encodeURIComponent).join("/")}`;

/** Deletes the pull request's branch on GitHub, after it merged or closed. The branch here stays. */
export async function deleteBranch(pr: Details) {
  const name = pr.headRefName;
  if (!(await confirm(`Delete the branch ${name} on GitHub? Your local copy stays, and you can restore it from #${pr.number}.`, "Delete Branch"))) return;
  if ((await withProgress(`Deleting ${name}…`, () => gh("api", "--method", "DELETE", branchRef(name)), { error: `Can't delete ${name}` })) === undefined) return;
  host.status(`Deleted ${name} on GitHub`);
  hub.renderPullRequest(pr.number);
}

/** Recreates the pull request's deleted branch on GitHub, at the pull request's last commit. */
export async function restoreBranch(pr: Details) {
  const name = pr.headRefName;
  if (!(await confirm(`Restore the branch ${name} on GitHub, at ${pr.headRefOid.slice(0, 7)}, the last commit of #${pr.number}?`, "Restore Branch"))) return;
  const create = () => gh("api", "--method", "POST", "repos/{owner}/{repo}/git/refs", "-f", `ref=refs/heads/${name}`, "-f", `sha=${pr.headRefOid}`);
  if ((await withProgress(`Restoring ${name}…`, create, { error: `Can't restore ${name}` })) === undefined) return;
  host.status(`Restored ${name} on GitHub`);
  hub.renderPullRequest(pr.number);
}

/** Asks someone who already reviewed to review again, which notifies them. */
export async function reRequestReview(pr: Details, login: string, run: (progress: string, args: string[], done: string, error: string) => unknown) {
  if (!(await confirm(`Ask ${login} to review #${pr.number} again? GitHub notifies them.`, "Re-request Review"))) return;
  run(`Requesting a review from ${login}…`, ["pr", "edit", String(pr.number), "--add-reviewer", login], `Asked ${login} to review #${pr.number} again`, `Can't request a review from ${login}`);
}
