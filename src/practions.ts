// Pull requests: merging, the More Actions menu, and editing the title, reviewers, assignees, and labels.
import { confirm, pick } from "./palette";
import { showError, withProgress } from "./status";
import { type Details, gh, host, hub, myLogin } from "./prshared";

/** Adds or removes an assignee, from the people who can be assigned in the repository. */
export function editAssignees(pr: Details, run: (progress: string, args: string[], done: string, error: string) => unknown) {
  const people = gh("api", "--paginate", "repos/{owner}/{repo}/assignees", "--jq", ".[].login").then((out) => out.split("\n").filter(Boolean));
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
  pick(`Update #${n} from ${pr.baseRefName}`, () => [
    { label: `Merge ${pr.baseRefName} into ${pr.headRefName}`, run: () => run(`Updating #${n}…`, ["pr", "update-branch", n], `Updated #${n} from ${pr.baseRefName}`, `Can't update #${n}`) },
    { label: `Rebase ${pr.headRefName} onto ${pr.baseRefName}`, detail: "Rewrites the branch's commits", run: () => run(`Rebasing #${n}…`, ["pr", "update-branch", n, "--rebase"], `Rebased #${n} onto ${pr.baseRefName}`, `Can't rebase #${n}`) },
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
  const people = gh("api", "--paginate", "repos/{owner}/{repo}/assignees", "--jq", ".[].login").then((out) => out.split("\n").filter(Boolean));
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
  const labels = gh("label", "list", "--limit", "500", "--json", "name,description").then((out) => JSON.parse(out) as { name: string; description: string }[]);
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

/** Asks how to merge, confirms, and merges on GitHub. */
/** The merge methods the repository allows, read once per project. */
let mergeSettings: { root: string; allowed: Promise<Record<string, boolean>> } | undefined;
const lastMethodKey = () => `pr-merge-method:${host.root()}`;

export async function merge(pr: Details) {
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
  // The methods the repository allows (GitHub turns off the others), the one you used last first.
  const methods = [
    { label: "Create a merge commit", flag: "--merge", key: "merge" },
    { label: "Squash and merge", flag: "--squash", key: "squash" },
    { label: "Rebase and merge", flag: "--rebase", key: "rebase" },
  ]
    .filter((m) => allowed[m.key] !== false)
    .sort((a, b) => Number(b.key === last) - Number(a.key === last));
  // Until checks and reviews pass, GitHub can merge on its own once they do.
  const auto = pr.mergeStateStatus !== "CLEAN" && pr.mergeStateStatus !== "UNSTABLE" && pr.mergeStateStatus !== "HAS_HOOKS";
  pick(`Merge #${pr.number} into ${pr.baseRefName}`, () =>
    methods.map((m) => ({
      label: m.label,
      detail: m.key === last ? "last used" : undefined,
      // Confirmed in the palette rather than a native dialog, which a page reload could leave stuck on screen.
      run: () => {
        const go = (extra: string[], verb: string) => async () => {
          const merged = await withProgress(`${verb} #${pr.number}…`, () => gh("pr", "merge", String(pr.number), m.flag, ...extra), { error: `Can't merge #${pr.number}` });
          try {
            if (merged !== undefined) localStorage.setItem(lastMethodKey(), m.key);
          } catch {
            // Storage is off; nothing to remember.
          }
          if (merged !== undefined) host.status(extra.includes("--auto") ? `Turned on auto-merge for #${pr.number}` : `Merged #${pr.number}`);
          hub.renderPullRequest(pr.number);
        };
        pick(`${m.label}: #${pr.number} "${pr.title}" into ${pr.baseRefName} on GitHub?`, () => [
          ...(auto ? [{ label: "Merge When Ready (auto-merge)", detail: "GitHub merges once checks and reviews pass", run: go(["--auto"], "Turning on auto-merge for") }] : []),
          { label: `${m.label} on GitHub`, run: go([], "Merging") },
          // gh deletes the local branch too, switching to the base first when it's checked out here.
          { label: `${m.label} and delete ${pr.headRefName}`, detail: "Deletes the branch on GitHub and here", run: go(["--delete-branch"], "Merging") },
          { label: "Cancel", run: () => {} },
        ]);
      },
    })),
  );
}
