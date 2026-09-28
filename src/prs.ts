// Pull requests through the GitHub CLI (`gh`): list, details, checks, reviews, line comments, and diffs.
import { invoke } from "@tauri-apps/api/core";
import type { monaco } from "./editor";
import { diffCursor, git, showDiff } from "./git";
import { age, type Check, checkState, checksSummary } from "./gitparse";
import { pick } from "./palette";
import { errorText, showError, status, withProgress } from "./status";
import { openTerminal } from "./terminal";

type Author = { login: string };
type PullRequest = {
  number: number;
  title: string;
  author: Author;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  reviewDecision: string;
  statusCheckRollup: Check[] | null;
  url: string;
};
type Details = PullRequest & {
  body: string;
  headRefOid: string;
  state: string;
  files: { path: string; additions: number; deletions: number }[];
  createdAt: string;
  comments: { author: Author; body: string; url: string; createdAt: string }[];
  reviews: { author: Author; state: string; body: string; submittedAt: string }[];
};

/** A comment on a line of the diff. `line` is null when the code it was on has changed since. */
type ReviewComment = { id: number; path: string; line: number | null; start_line: number | null; side: "LEFT" | "RIGHT"; body: string; user: string; in_reply_to_id: number | null; created_at: string };
/** A line comment and its replies. `node` is the thread's GraphQL ID, for resolving it. */
type Thread = ReviewComment & { comments: ReviewComment[]; node?: string; resolved?: boolean };

type Host = { root(): string; status(text: string): void; showView(name: "prs"): void };

const $ = (id: string) => document.getElementById(id)!;
const FIELDS = "number,title,author,headRefName,baseRefName,isDraft,reviewDecision,statusCheckRollup,url";
const icons = { passed: "✓", failed: "✗", pending: "●", skipped: "–", none: "" };
const reviews: Record<string, string> = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", REVIEW_REQUIRED: "Review required" };
let host: Host;

const gh = (...args: string[]) => invoke<string>("run_capture", { cwd: host.root(), program: "gh", args, input: null });
const openUrl = (url: string) => invoke("run_capture", { cwd: "/", program: "open", args: [url], input: null });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}

// The Markdown parser and sanitizer load with the first pull request you open, not with the app.
let markdownLibraries: { marked: typeof import("marked").marked; DOMPurify: typeof import("dompurify").default } | undefined;
async function loadMarkdown() {
  if (markdownLibraries) return;
  const [{ marked }, { default: DOMPurify }] = await Promise.all([import("marked"), import("dompurify")]);
  markdownLibraries = { marked, DOMPurify };
}

/**
 * Renders GitHub Markdown. Pull request text comes from other people, and this page can call the app's
 * commands, so the HTML is sanitized, and links open in the browser instead of the app. `#123` and `@name`
 * become links to the repository's issue or pull request and to the person's profile, as on GitHub.
 */
function markdown(text: string, repo: string): HTMLElement {
  const { marked, DOMPurify } = markdownLibraries!;
  const div = el("div", "pr-body markdown");
  const html = marked.parse(text, { async: false, gfm: true, breaks: true });
  // <map> and <area> make links out of images, which the handler below wouldn't see as <a>.
  div.innerHTML = DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form", "button", "iframe", "map", "area"], FORBID_ATTR: ["style"] });
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) if (!walker.currentNode.parentElement?.closest("a, code, pre")) texts.push(walker.currentNode as Text);
  for (const node of texts) {
    const parts = node.data.split(/(?<![\w/&#])(#\d+|@[A-Za-z0-9](?:-?[A-Za-z0-9])*)\b/);
    if (parts.length === 1) continue;
    node.replaceWith(
      ...parts.map((part, i) => {
        if (i % 2 === 0) return part;
        const a = el("a", "", part);
        a.href = part.startsWith("#") ? `${repo}/issues/${part.slice(1)}` : `https://github.com/${part.slice(1)}`;
        return a;
      }),
    );
  }
  // Every click on a link opens it in the browser, never in the app's window.
  div.onclick = (e) => {
    const link = (e.target as Element).closest<HTMLAnchorElement>("a[href]");
    if (!link) return;
    e.preventDefault();
    if (/^https?:/.test(link.href)) openUrl(link.href);
  };
  return div;
}

// ---- List ----

export async function loadPullRequests() {
  if (!host.root()) return;
  const filter = ($("pr-filter") as HTMLSelectElement).value;
  const args = { open: [], mine: ["--author", "@me"], review: ["--search", "review-requested:@me"] }[filter] ?? [];
  $("pr-detail").hidden = true;
  $("pr-list-view").hidden = false;
  // Switching back to the view keeps the last list while it refreshes; a new project or filter starts over.
  const key = `${host.root()}\0${filter}`;
  if ($("pr-list").dataset.key !== key) ($("pr-list").dataset.key = key), $("pr-list").replaceChildren(el("li", "muted", "Loading…"));
  try {
    const prs: PullRequest[] = JSON.parse(await gh("pr", "list", "--limit", "50", "--json", FIELDS, ...args));
    $("pr-list").replaceChildren(...(prs.length ? prs.map(prRow) : [el("li", "muted", "No pull requests.")]));
  } catch (e) {
    $("pr-list").replaceChildren(problemItem("Can't list pull requests", e));
  }
}

/**
 * A list item for a failed `gh` command: how to install the GitHub CLI or log in when that's the problem, with a
 * button that does it, or else the error and a Retry button.
 */
function problemItem(what: string, e: unknown, retry: () => unknown = loadPullRequests) {
  const text = errorText(e);
  const li = el("li", "muted pr-problem");
  const button = (label: string, run: () => unknown) => {
    const b = el("button", "", label);
    b.onclick = run;
    li.append(el("br"), b);
  };
  if (/os error 2|No such file/i.test(text)) {
    li.textContent = "Pull requests need the GitHub CLI (gh). Install it, such as with brew install gh, then log in to GitHub with it.";
    button("Get the GitHub CLI", () => openUrl("https://cli.github.com"));
  } else if (/gh auth login|not logged in|authenticat/i.test(text)) {
    li.textContent = "Log in to GitHub with the GitHub CLI to see pull requests.";
    button("Log In…", () => openTerminal(host.root(), "gh auth login", ["gh", "auth", "login"], () => retry()));
  } else if (/no git remotes|known GitHub host|not a git repository/i.test(text)) li.textContent = "This project has no GitHub remote.";
  else {
    li.textContent = `${what}: ${text}`;
    button("Retry", retry);
  }
  return li;
}

function prRow(pr: PullRequest) {
  const li = el("li", "pr");
  const title = el("div", "pr-title", `#${pr.number} ${pr.title}`);
  if (pr.isDraft) title.prepend(el("span", "badge", "Draft"));
  const checks = checksSummary(pr.statusCheckRollup);
  const meta = el("div", "pr-meta");
  meta.append(
    el("span", `checks-${checks}`, icons[checks]),
    ` ${pr.author.login} · ${pr.headRefName} → ${pr.baseRefName}`,
    reviews[pr.reviewDecision] ? ` · ${reviews[pr.reviewDecision]}` : "",
  );
  li.append(title, meta);
  li.onclick = () => showPullRequest(pr.number);
  return li;
}

// ---- Details ----

export async function showPullRequest(number: number) {
  const libraries = loadMarkdown();
  host.showView("prs");
  $("pr-list-view").hidden = true;
  const detail = $("pr-detail");
  detail.hidden = false;
  // Refreshing the same pull request, such as after you comment, keeps it on screen until the new version is ready.
  if (detail.dataset.number !== String(number)) detail.replaceChildren(el("p", "muted", "Loading…"));
  detail.dataset.number = String(number);
  let pr: Details;
  let threads: Thread[];
  try {
    [pr, threads] = await Promise.all([
      gh("pr", "view", String(number), "--json", `${FIELDS},body,headRefOid,state,files,comments,reviews,createdAt`).then(JSON.parse),
      lineComments(number),
      me(),
      loadPending(number).catch(() => null),
    ]);
  } catch (e) {
    const back = el("button", "link", "← All pull requests");
    back.onclick = loadPullRequests;
    const list = el("ul", "pr-checks");
    list.append(problemItem(`Can't load #${number}`, e, () => showPullRequest(number)));
    detail.replaceChildren(back, list);
    return;
  }
  await libraries;

  const back = el("button", "link", "← All pull requests");
  back.onclick = loadPullRequests;
  const actions = el("div", "pr-actions");
  const action = (label: string, run: () => unknown) => {
    const b = el("button", "", label);
    b.onclick = run;
    actions.append(b);
  };
  action("Check Out", () => openTerminal(host.root(), `Check out #${number}`, ["gh", "pr", "checkout", String(number)]));
  action("Open in Browser", () => openUrl(pr.url));
  action("Refresh", () => showPullRequest(number));
  if (pr.state === "OPEN") action("Merge…", () => merge(pr));

  const checks = el("ul", "pr-checks");
  for (const c of pr.statusCheckRollup ?? []) {
    const state = checkState(c);
    const li = el("li");
    li.append(el("span", `checks-${state}`, icons[state]), ` ${c.name ?? c.context}`);
    const url = c.detailsUrl ?? c.targetUrl;
    if (url) li.onclick = () => openUrl(url);
    checks.append(li);
  }

  const files = el("ul", "pr-files");
  for (const f of pr.files) {
    const li = el("li");
    li.append(el("span", "name", ltr(f.path)), el("span", "added", `+${f.additions}`), el("span", "deleted", `−${f.deletions}`));
    const count = threads.filter((t) => t.path === f.path).length;
    if (count) li.append(el("span", "codicon codicon-comment", ` ${count}`));
    li.onclick = () => showFileDiff(pr, f.path, threads);
    files.append(li);
  }

  const repo = repoUrl(pr);
  const conversation = el("div", "pr-conversation");
  // The conversation is one timeline, oldest first, as on GitHub: the description, reviews, comments, and line
  // comment threads (at their first comment's time), each with its date.
  const timeline: { at: string; nodes: HTMLElement[] }[] = [];
  const entry = (author: string, label: string, body: string, at: string) => {
    const item = el("div", "pr-comment");
    const meta = el("div", "pr-meta", `${author}${label ? ` · ${label}` : ""}`);
    meta.append(when(at));
    item.append(meta, markdown(body, repo));
    return item;
  };
  // A comment you can edit or delete when it's yours; it redraws in place while you do.
  const editable = (user: string, body: string, api: string, at: string) => {
    const item = el("div", "pr-comment");
    const draw = () => item.replaceChildren(...commentBlock(user, body, api, repo, draw, () => showPullRequest(number), at));
    draw();
    return item;
  };
  // Your pending review isn't part of the conversation yet; it's listed below.
  for (const r of pr.reviews)
    if (r.state !== "PENDING" && (r.body || r.state !== "COMMENTED")) timeline.push({ at: r.submittedAt, nodes: [entry(r.author.login, reviews[r.state] ?? r.state.toLowerCase(), r.body, r.submittedAt)] });
  for (const c of pr.comments) {
    const id = c.url.match(/#issuecomment-(\d+)$/)?.[1];
    timeline.push({ at: c.createdAt, nodes: [id ? editable(c.author.login, c.body, `repos/{owner}/{repo}/issues/comments/${id}`, c.createdAt) : entry(c.author.login, "", c.body, c.createdAt)] });
  }
  // Line comments, each thread under a link to its place in the diff.
  for (const t of threads) {
    const where = el("button", "link pr-thread-link", `${t.path}${t.line ? `:${t.start_line && t.start_line !== t.line ? `${t.start_line}–` : ""}${t.line}` : " (outdated)"}${t.resolved ? " · resolved" : ""}`);
    where.onclick = () => showFileDiff(pr, t.path, threads, t);
    timeline.push({ at: t.created_at, nodes: [where, ...t.comments.map((c) => editable(c.user, c.body, `repos/{owner}/{repo}/pulls/comments/${c.id}`, c.created_at))] });
  }
  const time = (at: string) => Date.parse(at) || 0; // A missing date sorts first rather than breaking the order.
  timeline.sort((a, b) => time(a.at) - time(b.at));
  if (pr.body) conversation.append(entry(pr.author.login, "description", pr.body, pr.createdAt));
  conversation.append(...timeline.flatMap((t) => t.nodes));

  const heading = (text: string) => el("h3", "", text);
  // Your line comments that wait for the review to be submitted. Click one to see it in the diff.
  const pendingComments = pending?.number === number ? pending.comments : [];
  const pendingList = el("ul", "pr-files");
  for (const c of pendingComments) {
    const li = el("li");
    li.append(el("span", "name", ltr(`${c.path}:${c.start_line ? `${c.start_line}–` : ""}${c.line}`)), el("span", "muted", ` ${c.body.split("\n")[0]}`));
    li.onclick = () => showFileDiff(pr, c.path, threads, c);
    const remove = el("button", "icon-button codicon codicon-close");
    remove.title = "Delete this pending comment";
    remove.onclick = (e) => {
      e.stopPropagation();
      deletePending(number, c).then(() => showPullRequest(number), (err) => showError(`Can't delete the pending comment`, err));
    };
    li.append(remove);
    pendingList.append(li);
  }
  const hasPending = pending?.number === number;
  const review = el("div", "pr-review");
  const box = el("textarea");
  box.placeholder = hasPending ? "Summarize your review (Markdown, optional)" : "Leave a comment (Markdown)";
  box.setAttribute("aria-label", "Comment");
  const buttons = el("div", "pr-actions");
  // With pending comments, each button submits them as one review. Without, Comment adds a comment
  // to the conversation, and Approve and Request Changes submit a review with only the summary.
  const reply = (label: string, event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", needsText: boolean, done: string) => {
    const b = el("button", "", label);
    b.onclick = async () => {
      const body = box.value.trim();
      if (needsText && !body && !pendingComments.length) return host.status(`Write a comment first: ${label} needs one.`);
      buttons.querySelectorAll("button").forEach((x) => (x.disabled = true));
      try {
        if (event === "COMMENT" && !hasPending) await gh("pr", "comment", String(number), "--body", body);
        else await submitReview(pr, event, body);
        host.status(done);
        showPullRequest(number);
      } catch (e) {
        showError(`Can't ${label.toLowerCase()}`, e);
        buttons.querySelectorAll("button").forEach((x) => (x.disabled = false));
      }
    };
    buttons.append(b);
  };
  reply(hasPending ? `Submit Review (${pendingComments.length})` : "Comment", "COMMENT", true, hasPending ? `Submitted your review on #${number}` : `Commented on #${number}`);
  if (pr.state === "OPEN") {
    reply("Approve", "APPROVE", false, `Approved #${number}`);
    reply("Request Changes", "REQUEST_CHANGES", true, `Requested changes on #${number}`);
  }
  review.append(box, buttons);
  const meta = el("div", "pr-meta", `${pr.state.toLowerCase()} · ${pr.author.login} · ${pr.headRefName} → ${pr.baseRefName}`);
  detail.replaceChildren(
    back,
    el("h2", "", `#${pr.number} ${pr.title}`),
    meta,
    actions,
    heading(`Checks (${pr.statusCheckRollup?.length ?? 0})`),
    checks,
    heading(`Files (${pr.files.length})`),
    files,
    heading(`Conversation${threads.length ? ` (${threads.length} line ${threads.length === 1 ? "thread" : "threads"})` : ""}`),
    conversation,
    ...(pendingComments.length ? [heading(`Pending review (${pendingComments.length} ${pendingComments.length === 1 ? "comment" : "comments"})`), pendingList] : []),
    review,
  );
  // Fetch the head and base now, so opening a file's diff doesn't wait for the network.
  prepareDiff(pr).catch(() => {});
}

/**
 * A path for a right-to-left box, which puts the ellipsis of a long path at its start. The left-to-right mark in
 * front keeps the path's own order, so `.env.example` doesn't show as `env.example.`.
 */
const ltr = (path: string) => `\u200E${path}`;

/** " · 3h ago", with the full date and time on hover. */
function when(at: string) {
  const time = Date.parse(at);
  const span = el("span", "pr-when", Number.isNaN(time) ? "" : ` · ${age(time / 1000) === "now" ? "just now" : `${age(time / 1000)} ago`}`);
  if (!Number.isNaN(time)) span.title = new Date(time).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
  return span;
}

const repoUrl = (pr: PullRequest) => pr.url.replace(/\/pull\/\d+$/, "");

/**
 * The pull request's line comments, grouped into threads. GitHub points every reply at the thread's first comment.
 * Whether a thread is resolved is only in GraphQL, keyed there by the first comment's ID.
 */
async function lineComments(number: number): Promise<Thread[]> {
  const jq = ".[] | {id, path, line, start_line, side, body, user: .user.login, in_reply_to_id, created_at}";
  const [out, states] = await Promise.all([
    gh("api", "--paginate", `repos/{owner}/{repo}/pulls/${number}/comments`, "--jq", jq),
    threadStates(number).catch(() => new Map<number, { id: string; resolved: boolean }>()),
  ]);
  const comments: ReviewComment[] = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const threads = new Map<number, Thread>();
  for (const c of comments) if (!c.in_reply_to_id) threads.set(c.id, { ...c, comments: [c], node: states.get(c.id)?.id, resolved: states.get(c.id)?.resolved });
  for (const c of comments) if (c.in_reply_to_id) threads.get(c.in_reply_to_id)?.comments.push(c);
  return [...threads.values()];
}

// ponytail: the first 100 threads; a pull request with more shows the rest as unresolved, without Resolve.
const THREADS = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id isResolved comments(first: 1) { nodes { databaseId } } } } } }
}`;

/** Each thread's GraphQL ID and whether it's resolved, by the REST ID of its first comment. */
async function threadStates(number: number) {
  const jq = ".data.repository.pullRequest.reviewThreads.nodes[] | {id, resolved: .isResolved, first: .comments.nodes[0].databaseId}";
  const out = await gh("api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-F", `number=${number}`, "-f", `query=${THREADS}`, "--jq", jq);
  const lines: { id: string; resolved: boolean; first: number }[] = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return new Map(lines.map((t) => [t.first, { id: t.id, resolved: t.resolved }]));
}

/** Your GitHub login, so your own comments get Edit and Delete. Empty when `gh` can't tell. */
let myLogin = "";
let loginLookup: Promise<unknown> | undefined;
const me = () => (loginLookup ??= gh("api", "user", "--jq", ".login").then((l) => (myLogin = l.trim()), () => (loginLookup = undefined)));

/** The comment being edited, and the one whose delete waits for a second click, by REST path. */
let editing = "";
let deleting = "";

/**
 * A comment's author and text, with Edit and Delete when it's yours. `api` is the comment's REST path.
 * `redraw` draws it again after you start or cancel an edit, and `reload` fetches everything after GitHub changed it.
 */
function commentBlock(user: string, body: string, api: string, repo: string, redraw: () => void, reload: () => unknown, at?: string): HTMLElement[] {
  const meta = el("div", "pr-meta", user);
  if (at) meta.append(when(at));
  if (!myLogin || user !== myLogin) return [meta, markdown(body, repo)];
  const link = (label: string, run: () => unknown) => {
    const b = el("button", "link", label);
    b.onclick = run;
    meta.append(" · ", b);
  };
  const change = async (args: string[], what: string) => {
    try {
      await gh("api", ...args, api);
      editing = deleting = "";
      await reload();
    } catch (e) {
      showError(`Can't ${what} the comment`, e);
    }
  };
  if (editing === api) {
    const box = el("div", "pr-comment-form");
    const text = el("textarea");
    text.rows = 4;
    text.value = body;
    const buttons = el("div", "pr-actions");
    const save = el("button", "primary", "Save");
    save.onclick = () => text.value.trim() && change(["--method", "PATCH", "-f", `body=${text.value.trim()}`], "edit");
    const cancel = el("button", "", "Cancel");
    cancel.onclick = () => ((editing = ""), redraw());
    text.onkeydown = (e) => {
      if (e.key === "Enter" && e.metaKey) save.click();
      if (e.key === "Escape") cancel.click();
    };
    buttons.append(save, cancel);
    box.append(text, buttons);
    requestAnimationFrame(() => text.focus());
    return [meta, box];
  }
  if (deleting === api) {
    meta.append(" · Delete this comment on GitHub?");
    link("Delete", () => change(["--method", "DELETE"], "delete"));
    link("Cancel", () => ((deleting = ""), redraw()));
  } else {
    link("Edit", () => ((editing = api), (deleting = ""), redraw()));
    link("Delete", () => ((deleting = api), (editing = ""), redraw()));
  }
  return [meta, markdown(body, repo)];
}

/** Resolves or reopens a thread on GitHub. */
async function setResolved(t: Thread, resolved: boolean) {
  const mutation = resolved ? "resolveReviewThread" : "unresolveReviewThread";
  try {
    await gh("api", "graphql", "-f", `query=mutation($id: ID!) { ${mutation}(input: { threadId: $id }) { thread { isResolved } } }`, "-f", `id=${t.node}`);
    shown!.threads = await lineComments(shown!.pr.number);
    drawZones();
  } catch (e) {
    showError(`Can't ${resolved ? "resolve" : "reopen"} the thread`, e);
  }
}

/** Resolved threads you opened with Show, by thread ID. */
const expanded = new Set<number>();

/** Asks how to merge, confirms, and merges on GitHub. */
function merge(pr: Details) {
  const methods = [
    { label: "Create a merge commit", flag: "--merge" },
    { label: "Squash and merge", flag: "--squash" },
    { label: "Rebase and merge", flag: "--rebase" },
  ];
  pick(`Merge #${pr.number} into ${pr.baseRefName}`, () =>
    methods.map((m) => ({
      label: m.label,
      // Confirmed in the palette rather than a native dialog, which a page reload could leave stuck on screen.
      run: () =>
        pick(`${m.label}: #${pr.number} "${pr.title}" into ${pr.baseRefName} on GitHub?`, () => [
          {
            label: `${m.label} on GitHub`,
            run: async () => {
              const merged = await withProgress(`Merging #${pr.number}…`, () => gh("pr", "merge", String(pr.number), m.flag), { error: `Can't merge #${pr.number}` });
              if (merged !== undefined) host.status(`Merged #${pr.number}`);
              showPullRequest(pr.number);
            },
          },
          { label: "Cancel", run: () => {} },
        ]),
    })),
  );
}

/**
 * Fetches the pull request's head and base, then diffs a file from their merge base to the head, with its
 * line comments under their lines. `at` scrolls to a thread.
 */
/** Each pull request's merge base, once its head and base are fetched, per head commit, so a push fetches again. */
const mergeBases = new Map<string, Promise<string>>();

/**
 * Fetches a pull request's head and base, then finds their merge base. The pull request page starts this when it
 * opens, so a file's diff usually opens without waiting for the network. With the head commit already here, from
 * an earlier fetch or a checkout, nothing is fetched.
 */
function prepareDiff(pr: Details): Promise<string> {
  const key = `${pr.number}:${pr.headRefOid}`;
  if (!mergeBases.has(key)) {
    const base = `refs/remotes/origin/${pr.baseRefName}`;
    const ready = (async () => {
      const here = await git("cat-file", "-e", `${pr.headRefOid}^{commit}`).then(() => git("rev-parse", "--verify", "-q", base)).then(() => true, () => false);
      if (!here) await git("fetch", "--no-tags", "origin", `+refs/pull/${pr.number}/head:refs/remotes/pr/${pr.number}`, `+refs/heads/${pr.baseRefName}:${base}`);
      return (await git("merge-base", pr.headRefOid, base)).trim();
    })();
    // A failed fetch is tried again next time.
    mergeBases.set(key, ready.catch((e) => (mergeBases.delete(key), Promise.reject(e))));
  }
  return mergeBases.get(key)!;
}

async function showFileDiff(pr: Details, path: string, threads: Thread[], at?: { line: number | null; side: "LEFT" | "RIGHT" }) {
  let diff: monaco.editor.IStandaloneDiffEditor;
  try {
    const slow = setTimeout(() => status(`Fetching #${pr.number}…`, "prs:progress"), 300);
    const [mergeBase] = await Promise.all([prepareDiff(pr).finally(() => (clearTimeout(slow), status("", "prs:progress"))), loadMarkdown(), me()]);
    const show = (spec: string) => git("show", spec).catch(() => "");
    const [original, modified] = await Promise.all([show(`${mergeBase}:${path}`), show(`${pr.headRefOid}:${path}`)]);
    const action = { label: "Comment on Line", title: "Comment on the selected lines, or reply to the comments on the cursor's line", run: () => commentAtCursor() };
    diff = showDiff(path, original, modified, `#${pr.number}: ${pr.baseRefName} ↔ ${pr.headRefName}`, action);
  } catch (e) {
    return showError(`Can't show the diff`, e);
  }
  diff.layout(); // The diff was hidden until now, so its editors have no width yet.
  shown = { pr, path, threads, diff, zones: [], model: diff.getModel()?.modified };
  form = undefined;
  drawZones();
  // Your pending review usually loaded with the pull request's page; if it's still on its way, its comments are
  // added when it arrives.
  pendingOf(pr.number).then(() => shown?.pr === pr && drawZones());
  if (at?.line) {
    const editor = at.side === "LEFT" ? diff.getOriginalEditor() : diff.getModifiedEditor();
    const reveal = () => (editor.revealLineInCenter(at.line!), editor.setPosition({ lineNumber: at.line!, column: 1 }));
    reveal();
    // Computing the diff adds the other side's padding, which moves the line, so reveal it again after.
    const done = diff.onDidUpdateDiff(() => (done.dispose(), reveal()));
  }
}

// ---- Line comments and pending reviews ----

/** The diff on screen, and the view zones (threads, pending comments, and the comment form) drawn in it. */
let shown: { pr: Details; path: string; threads: Thread[]; diff: monaco.editor.IStandaloneDiffEditor; zones: [monaco.editor.ICodeEditor, string][]; model?: monaco.editor.ITextModel } | undefined;
/** The open comment form: a new comment on lines, or a reply to a thread. */
let form: { side: "LEFT" | "RIGHT"; line: number; start: number; reply?: Thread } | undefined;

/**
 * Your pending review: GitHub's own, which only you can see until you submit it, so it's the same review in the
 * browser and here. `id` is its REST ID and `node` its GraphQL ID.
 */
type Pending = { number: number; id: number; node: string; comments: ReviewComment[] };
/** The pending review of the pull request on screen, or null when you have none there. */
let pending: Pending | null = null;

/** Loads your pending review of a pull request. GitHub lists a pending review only to its author. */
/** The last load of a pull request's pending review, finished or not, so callers share it rather than ask again. */
let pendingLoad: { number: number; done: Promise<Pending | null> } | undefined;
const pendingOf = (number: number) => (pendingLoad?.number === number ? pendingLoad.done : loadPending(number));

function loadPending(number: number): Promise<Pending | null> {
  const done = readPending(number);
  pendingLoad = { number, done: done.catch(() => null) };
  return done;
}

async function readPending(number: number): Promise<Pending | null> {
  const found = (await gh("api", `repos/{owner}/{repo}/pulls/${number}/reviews`, "--paginate", "--jq", '.[] | select(.state == "PENDING") | {id, node: .node_id}')).trim();
  if (!found) return (pending = null);
  const { id, node } = JSON.parse(found.split("\n")[0]);
  const jq = ".[] | {id, path, line: (.line // .original_line), start_line, side: (.side // \"RIGHT\"), body, user: .user.login, in_reply_to_id, created_at}";
  const out = await gh("api", "--paginate", `repos/{owner}/{repo}/pulls/${number}/reviews/${id}/comments`, "--jq", jq);
  return (pending = { number, id, node, comments: out.split("\n").filter(Boolean).map((l) => JSON.parse(l)) });
}

/** A pending comment's place: its lines and side, as GitHub's REST API names them. */
type Place = { path: string; line: number; side: "LEFT" | "RIGHT"; start_line?: number };

/**
 * Adds a comment to your pending review, starting one on the head commit when you have none. GitHub's REST API
 * can only add comments while creating a review, so later ones go through GraphQL's addPullRequestReviewThread.
 */
async function addPending(pr: Details, place: Place, body: string) {
  await pendingOf(pr.number);
  if (!pending) {
    const comment = { path: place.path, line: place.line, side: place.side, body, ...(place.start_line ? { start_line: place.start_line, start_side: place.side } : {}) };
    await invoke<string>("run_capture", {
      cwd: host.root(),
      program: "gh",
      args: ["api", "--method", "POST", `repos/{owner}/{repo}/pulls/${pr.number}/reviews`, "--input", "-"],
      // No event: the review stays pending.
      input: JSON.stringify({ commit_id: pr.headRefOid, comments: [comment] }),
    });
  } else {
    const range = place.start_line ? ["-F", `startLine=${place.start_line}`, "-f", `startSide=${place.side}`] : [];
    await gh(
      "api", "graphql",
      "-f", "query=mutation($review: ID!, $path: String!, $body: String!, $line: Int!, $side: DiffSide!, $startLine: Int, $startSide: DiffSide) { addPullRequestReviewThread(input: { pullRequestReviewId: $review, path: $path, body: $body, line: $line, side: $side, startLine: $startLine, startSide: $startSide }) { thread { id } } }",
      "-f", `review=${pending.node}`, "-f", `path=${place.path}`, "-f", `body=${body}`, "-F", `line=${place.line}`, "-f", `side=${place.side}`, ...range,
    );
  }
  await loadPending(pr.number);
}

/** Deletes a pending comment, and the pending review with its last comment, so nothing empty is left on GitHub. */
async function deletePending(number: number, comment: ReviewComment) {
  await gh("api", "--method", "DELETE", `repos/{owner}/{repo}/pulls/comments/${comment.id}`);
  const review = await loadPending(number);
  if (review && !review.comments.length) {
    await gh("api", "--method", "DELETE", `repos/{owner}/{repo}/pulls/${number}/reviews/${review.id}`);
    pending = null;
  }
}

const lines = (start: number | undefined | null, line: number) => (start && start !== line ? `lines ${start}–${line}` : `line ${line}`);

/** Adds a view zone under a line. A zone needs its height up front, so the content is measured first, at the editor's visible width. */
function addZone(editor: monaco.editor.ICodeEditor, line: number, content: HTMLElement) {
  content.style.width = `${editor.getLayoutInfo().contentWidth - 40}px`;
  document.body.append(content);
  const heightInPx = content.offsetHeight + 8;
  const node = el("div");
  node.append(content);
  // The zone's buttons and text box take their own clicks and keys, not the editor's.
  node.onkeydown = (e) => e.stopPropagation();
  editor.changeViewZones((zones) => shown!.zones.push([editor, zones.addZone({ afterLineNumber: line, heightInPx, domNode: node, suppressMouseDown: true })]));
}

/** Draws the file's threads, your pending comments, and the open comment form under their lines. */
function drawZones() {
  // The diff may show something else by now, such as a file's history, after a slow request.
  if (shown && shown.diff.getModel()?.modified !== shown.model) shown = undefined;
  if (!shown) return;
  const { pr, path, threads, diff } = shown;
  shown.zones.forEach(([editor, id]) => editor.changeViewZones((zones) => zones.removeZone(id)));
  shown.zones = [];
  const editorFor = (side: "LEFT" | "RIGHT") => (side === "LEFT" ? diff.getOriginalEditor() : diff.getModifiedEditor());
  const repo = repoUrl(pr);
  const reload = async () => ((shown!.threads = await lineComments(pr.number)), drawZones());
  for (const t of threads) {
    if (t.path !== path || !t.line) continue;
    const thread = el("div", `pr-thread${t.resolved ? " resolved" : ""}`);
    const action = (parent: HTMLElement, label: string, run: () => unknown) => {
      const b = el("button", "link", label);
      b.onclick = run;
      parent.append(parent.childNodes.length ? " · " : "", b);
    };
    // A resolved thread shows as one line until you open it.
    if (t.resolved && !expanded.has(t.id)) {
      const summary = el("div", "pr-meta", `Resolved · ${t.comments.length} ${t.comments.length === 1 ? "comment" : "comments"} from ${t.user}`);
      action(summary, "Show", () => (expanded.add(t.id), drawZones()));
      thread.append(summary);
      addZone(editorFor(t.side), t.line, thread);
      continue;
    }
    if (t.start_line && t.start_line !== t.line) thread.append(el("div", "pr-meta", `On ${lines(t.start_line, t.line)}`));
    for (const c of t.comments) thread.append(...commentBlock(c.user, c.body, `repos/{owner}/{repo}/pulls/comments/${c.id}`, repo, drawZones, reload, c.created_at));
    if (form?.reply?.id === t.id) thread.append(commentForm());
    else {
      const actions = el("div", "pr-thread-actions");
      action(actions, "Reply", () => ((form = { side: t.side, line: t.line!, start: t.line!, reply: t }), drawZones()));
      if (t.node) action(actions, t.resolved ? "Unresolve" : "Resolve", () => setResolved(t, !t.resolved));
      if (t.resolved) action(actions, "Hide", () => (expanded.delete(t.id), drawZones()));
      thread.append(actions);
    }
    addZone(editorFor(t.side), t.line, thread);
  }
  for (const c of pending?.number === pr.number ? pending.comments : []) {
    if (c.path !== path || !c.line) continue;
    const draft = el("div", "pr-thread pending");
    const remove = el("button", "link", "Delete");
    remove.onclick = () =>
      deletePending(pr.number, c).then(drawZones, (e) => showError(`Can't delete the pending comment`, e));
    const meta = el("div", "pr-meta", `Pending · ${lines(c.start_line, c.line)} · `);
    meta.append(remove);
    draft.append(meta, markdown(c.body, repo));
    addZone(editorFor(c.side), c.line, draft);
  }
  if (form && !form.reply) addZone(editorFor(form.side), form.line, commentForm());
}

/** The comment form's text box and buttons. ⌘⏎ does the first button's action, and Escape cancels. */
function commentForm() {
  const { pr, path } = shown!;
  const f = form!;
  const box = el("div", "pr-comment-form");
  const text = el("textarea");
  text.rows = 4;
  text.placeholder = f.reply ? `Reply to ${f.reply.user} (Markdown)` : `Comment on ${lines(f.start, f.line)}${f.side === "LEFT" ? " of the old version" : ""} (Markdown)`;
  const buttons = el("div", "pr-actions");
  const close = () => ((form = undefined), drawZones());
  const button = (label: string, run: (body: string) => unknown, primary = false) => {
    const b = el("button", primary ? "primary" : "", label);
    b.onclick = () => {
      const body = text.value.trim();
      if (body) run(body);
    };
    buttons.append(b);
  };
  // With a pending review, GitHub takes no comment outside it, so a reply joins the review, as on GitHub.
  const inReview = pending?.number === pr.number;
  if (f.reply && inReview && f.reply.node) {
    const thread = f.reply.node;
    button("Add Reply to Review", async (body) => {
      await gh("api", "graphql", "-f", "query=mutation($review: ID!, $thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewId: $review, pullRequestReviewThreadId: $thread, body: $body }) { comment { id } } }", "-f", `review=${pending!.node}`, "-f", `thread=${thread}`, "-f", `body=${body}`).then(
        async () => (host.status("Added the reply to your pending review."), (form = undefined), await loadPending(pr.number), drawZones()),
        (e) => showError(`Can't add the reply`, e),
      );
    }, true);
  } else if (f.reply) button("Reply", (body) => post([`repos/{owner}/{repo}/pulls/${pr.number}/comments/${f.reply!.id}/replies`, "-f", `body=${body}`]), true);
  else {
    button("Add to Review", async (body) => {
      buttons.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        await addPending(pr, { path, line: f.line, side: f.side, ...(f.start !== f.line ? { start_line: f.start } : {}) }, body);
        host.status(`Added to your pending review on #${pr.number}. Submit it from the pull request's page, or on GitHub.`);
        close();
      } catch (e) {
        // GitHub accepts comments only on lines inside the diff's changes and the lines around them.
        showError(`Can't add the comment to your review`, e);
        buttons.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    }, true);
    const range = f.start !== f.line ? ["-F", `start_line=${f.start}`, "-f", `start_side=${f.side}`] : [];
    if (!inReview) button("Comment Now", (body) =>
      post([`repos/{owner}/{repo}/pulls/${pr.number}/comments`, "-f", `body=${body}`, "-f", `commit_id=${pr.headRefOid}`, "-f", `path=${path}`, "-F", `line=${f.line}`, "-f", `side=${f.side}`, ...range]),
    );
  }
  const cancel = el("button", "", "Cancel");
  cancel.onclick = close;
  buttons.append(cancel);
  text.onkeydown = (e) => {
    if (e.key === "Enter" && e.metaKey) buttons.querySelector("button")!.click();
    if (e.key === "Escape") close();
  };
  // Posts a comment or a reply at once, then reloads the threads.
  const post = async (args: string[]) => {
    buttons.querySelectorAll("button").forEach((b) => (b.disabled = true));
    // GitHub accepts comments only on lines inside the diff's changes and the lines around them.
    const posted = await withProgress("Posting the comment…", () => gh("api", "--method", "POST", ...args), { error: "Can't comment" });
    if (posted === undefined) return buttons.querySelectorAll("button").forEach((b) => (b.disabled = false));
    host.status(`Commented on ${path}:${f.line}`);
    form = undefined;
    shown!.threads = await lineComments(pr.number).catch((e) => (showError("Can't reload the comments", e), shown!.threads));
    drawZones();
  };
  box.append(text, buttons);
  requestAnimationFrame(() => text.focus());
  return box;
}

/** Opens the comment form for the selected lines in the diff, or a reply to the thread on the cursor's line. */
function commentAtCursor() {
  const cursor = diffCursor();
  if (!cursor || !shown) return;
  const side = cursor.side === "original" ? "LEFT" : "RIGHT";
  const { line, startLine } = cursor;
  const reply = startLine === line ? shown.threads.find((t) => t.path === shown!.path && t.line === line && t.side === side) : undefined;
  form = { side, line, start: startLine, reply };
  drawZones();
}

/** Submits a review: the pending comments, with a summary and a verdict, in one request. */
async function submitReview(pr: Details, event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string) {
  const review = pending?.number === pr.number ? pending : await loadPending(pr.number);
  // Your pending review is submitted with the verdict; without one, a review with only the summary is created.
  const [path, payload] = review ? [`reviews/${review.id}/events`, { event, body }] : ["reviews", { commit_id: pr.headRefOid, event, body }];
  await invoke<string>("run_capture", { cwd: host.root(), program: "gh", args: ["api", "--method", "POST", `repos/{owner}/{repo}/pulls/${pr.number}/${path}`, "--input", "-"], input: JSON.stringify(payload) });
  pending = null;
}

// ---- Current branch ----

/** Shows the pull request for the current branch next to the branch name. */
export async function updateBranchPullRequest() {
  const button = $("branch-pr");
  button.hidden = true;
  if (!host.root()) return;
  try {
    const pr: PullRequest = JSON.parse(await gh("pr", "view", "--json", FIELDS));
    const checks = checksSummary(pr.statusCheckRollup);
    button.innerHTML = `<span class="codicon codicon-git-pull-request"></span><span class="label"></span>`;
    button.querySelector(".label")!.textContent = `#${pr.number} ${icons[checks]}`;
    button.title = `${pr.title} (checks ${checks})`;
    button.onclick = () => showPullRequest(pr.number);
    button.hidden = false;
  } catch {
    // No pull request for this branch, or no GitHub remote.
  }
}

export const createPullRequest = () => openTerminal(host.root(), "gh pr create", ["gh", "pr", "create"]);

export function initPullRequests(h: Host) {
  host = h;
  $("pr-filter").onchange = loadPullRequests;
  $("pr-refresh").onclick = loadPullRequests;
  $("pr-create").onclick = createPullRequest;
}
