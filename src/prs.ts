// Pull requests through the GitHub CLI (`gh`): list, details, checks, reviews, line comments, and diffs.
import { invoke } from "@tauri-apps/api/core";
import type { monaco } from "./editor";
import { diffCursor, git, gitOutput, gitStatus, gitTask, showDiff, showDiffs, showOutput } from "./git";
import { actionsJob, age, type Check, checkState, checksSummary, cleanLog, sortChecks, suggestion } from "./gitparse";
import { showCommitDiff } from "./history";
import { confirm, pick } from "./palette";
import { listNav } from "./listnav";
import { errorText, showError, status, withProgress } from "./status";
import { openTerminal } from "./terminal";
import { mod } from "./platform.ts";

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
type Label = { name: string; color: string };
/** A row of the list, with more than the status bar's lookup needs. */
type ListedPullRequest = PullRequest & { state: string; labels: Label[]; updatedAt: string; additions: number; deletions: number };
type Details = ListedPullRequest & {
  id: string;
  body: string;
  headRefOid: string;
  files: { path: string; additions: number; deletions: number }[];
  createdAt: string;
  comments: { author: Author; body: string; url: string; createdAt: string }[];
  reviews: { id: string; author: Author; state: string; body: string; submittedAt: string }[];
  latestReviews: { author: Author; state: string }[];
  reviewRequests: { login?: string; name?: string; slug?: string }[];
  commits: { oid: string; messageHeadline: string; committedDate: string; authors: { login: string; name: string }[] }[];
  mergeable: string;
  mergeStateStatus: string;
  autoMergeRequest: { mergeMethod: string } | null;
};

/** A comment on a line of the diff. `line` is null when the code it was on has changed since. */
type ReviewComment = { id: number; path: string; line: number | null; start_line: number | null; side: "LEFT" | "RIGHT"; body: string; user: string; in_reply_to_id: number | null; created_at: string };
/** A line comment and its replies. `node` is the thread's GraphQL ID, for resolving it. */
type Thread = ReviewComment & { comments: ReviewComment[]; node?: string; resolved?: boolean };

type Host = {
  root(): string;
  status(text: string): void;
  showView(name: "prs"): void;
  openAt(path: string, line: number): unknown;
  /** Replaces lines of a file in its editor, if they still read `expected`. False when they don't. */
  replaceLines(path: string, start: number, end: number, expected: string, text: string): Promise<boolean>;
};

const $ = (id: string) => document.getElementById(id)!;
const FIELDS = "number,title,author,headRefName,baseRefName,isDraft,reviewDecision,statusCheckRollup,url";
const LIST_FIELDS = `${FIELDS},state,labels,updatedAt,additions,deletions`;
const DETAIL_FIELDS = `${LIST_FIELDS},id,body,headRefOid,files,comments,reviews,createdAt,latestReviews,reviewRequests,commits,mergeable,mergeStateStatus,autoMergeRequest`;
const icons = { passed: "✓", failed: "✗", pending: "●", skipped: "–", none: "" };
const reviews: Record<string, string> = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", REVIEW_REQUIRED: "Review required" };
let host: Host;

const gh = (...args: string[]) => invoke<string>("run_capture", { cwd: host.root(), program: "gh", args, input: null });
const openUrl = (url: string) => invoke("open_url", { url: url });

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

/** How many pull requests the list asks for; Load More asks for 50 more. */
let limit = 50;

export async function loadPullRequests() {
  if (!host.root()) return;
  const filter = ($("pr-filter") as HTMLSelectElement).value;
  const text = ($("pr-search") as HTMLInputElement).value.trim();
  // GitHub's search syntax, such as "label:bug" or "author:someone", works in the search box too.
  const search = [filter === "review" ? "review-requested:@me" : "", text].filter(Boolean).join(" ");
  const state = ["closed", "merged", "all"].includes(filter) ? ["--state", filter] : [];
  const args = [...(filter === "mine" ? ["--author", "@me"] : []), ...state, ...(search ? ["--search", search] : [])];
  $("pr-detail").hidden = true;
  $("pr-list-view").hidden = false;
  // Switching back to the view keeps the last list while it refreshes; a new project, filter, or search starts over.
  const key = `${host.root()}\0${filter}\0${text}`;
  if ($("pr-list").dataset.key !== key) ($("pr-list").dataset.key = key), (limit = 50), $("pr-list").replaceChildren(el("li", "muted", "Loading…"));
  try {
    const prs: ListedPullRequest[] = JSON.parse(await gh("pr", "list", "--limit", String(limit), "--json", LIST_FIELDS, ...args));
    if ($("pr-list").dataset.key !== key) return; // A newer search replaced this one.
    const more = el("li", "pr-more");
    const button = el("button", "", "Load More");
    button.onclick = () => ((limit += 50), (button.disabled = true), (button.textContent = "Loading…"), loadPullRequests());
    more.append(button);
    $("pr-list").replaceChildren(
      ...(prs.length ? prs.map(prRow) : [el("li", "muted", text ? "No pull requests match the search." : "No pull requests.")]),
      // gh has no offset, so Load More asks for a longer list; a full page means there may be more.
      ...(prs.length === limit ? [more] : []),
    );
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
    li.textContent = "Pull requests need the GitHub CLI (gh). Install it from cli.github.com, then log in to GitHub with it.";
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

function prRow(pr: ListedPullRequest) {
  const li = el("li", "pr");
  li.role = "option";
  li.dataset.key = String(pr.number);
  li.dataset.label = pr.title;
  const title = el("div", "pr-title", `#${pr.number} ${pr.title}`);
  if (pr.isDraft) title.prepend(el("span", "badge", "Draft"));
  if (pr.state !== "OPEN") title.prepend(el("span", `badge state-${pr.state.toLowerCase()}`, pr.state === "MERGED" ? "Merged" : "Closed"));
  const checks = checksSummary(pr.statusCheckRollup);
  const meta = el("div", "pr-meta");
  meta.append(
    el("span", `checks-${checks}`, icons[checks]),
    ` ${pr.author.login} · ${pr.headRefName} → ${pr.baseRefName}`,
    reviews[pr.reviewDecision] ? ` · ${reviews[pr.reviewDecision]} · ` : " · ",
    el("span", "added", `+${pr.additions}`),
    " ",
    el("span", "deleted", `−${pr.deletions}`),
    when(pr.updatedAt),
  );
  li.append(title, meta);
  if (pr.labels.length) li.append(labelRow(pr.labels));
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
  let viewed: Map<string, boolean>;
  try {
    [pr, threads, viewed] = await Promise.all([
      gh("pr", "view", String(number), "--json", DETAIL_FIELDS).then(JSON.parse),
      lineComments(number),
      viewedFiles(number).catch(() => new Map<string, boolean>()),
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
  const open = pr.state === "OPEN";
  const reload = () => showPullRequest(number);
  // Runs a `gh` command that changes the pull request, then shows it again.
  const run = async (progress: string, args: string[], done: string, error: string) => {
    if ((await withProgress(progress, () => gh(...args), { error })) === undefined) return;
    host.status(done);
    reload();
  };

  const back = el("button", "link", "← All pull requests");
  back.onclick = loadPullRequests;
  const actions = el("div", "pr-actions");
  const action = (label: string, run: () => unknown, className = "") => {
    const b = el("button", className, label);
    b.onclick = run;
    actions.append(b);
    return b;
  };
  // gh fetches and checks out with git, which asks for a password or passphrase in the dialog through gitTask.
  const checkOut = () => gitTask(`Checking out #${number}…`, ["pr", "checkout", String(number)], `Can't check out #${number}`, { gh: true }).then((o) => o !== undefined && status(`Checked out #${number}.`, "app", "info"));
  if (open) action("Merge…", () => merge(pr), "primary").disabled = pr.isDraft;
  action("Check Out", checkOut);
  action("Open in Browser", () => openUrl(pr.url));
  action("More…", () => more(pr, run));

  // What stands between the pull request and merging, with the button that deals with it.
  const banner = el("div", "pr-banner");
  const say = (kind: string, text: string, button?: [string, () => unknown]) => {
    const line = el("div", `pr-banner-line ${kind}`);
    line.append(el("span", "", text));
    if (button) {
      const b = el("button", "link", button[0]);
      b.onclick = button[1];
      line.append(b);
    }
    banner.append(line);
  };
  if (pr.state === "MERGED") say("merged", `Merged into ${pr.baseRefName}.`);
  else if (pr.state === "CLOSED") say("closed", "Closed without merging.", ["Reopen", () => run(`Reopening #${number}…`, ["pr", "reopen", String(number)], `Reopened #${number}`, `Can't reopen #${number}`)]);
  else {
    if (pr.isDraft) say("draft", "Draft: reviewers aren't asked yet, and it can't be merged.", ["Ready for Review", () => run(`Marking #${number} ready…`, ["pr", "ready", String(number)], `Marked #${number} ready for review`, `Can't mark #${number} ready`)]);
    if (pr.mergeable === "CONFLICTING") say("bad", `Conflicts with ${pr.baseRefName}. Check out the branch and merge ${pr.baseRefName} into it to resolve them.`, ["Check Out", checkOut]);
    else if (pr.mergeStateStatus === "BEHIND") say("warn", `Behind ${pr.baseRefName}.`, ["Update Branch", () => updateBranch(pr, run)]);
    if (pr.autoMergeRequest) say("good", `Auto-merge is on (${pr.autoMergeRequest.mergeMethod.toLowerCase()}): it merges once checks and reviews pass.`, ["Turn Off", () => run(`Turning off auto-merge…`, ["pr", "merge", String(number), "--disable-auto"], `Turned off auto-merge for #${number}`, "Can't turn off auto-merge")]);
    else if (pr.mergeStateStatus === "CLEAN") say("good", "Ready to merge.");
    else if (pr.mergeStateStatus === "UNSTABLE") say("warn", "Checks that aren't required are failing, but it can be merged.");
    else if (pr.mergeStateStatus === "BLOCKED") say("warn", pr.reviewDecision === "REVIEW_REQUIRED" ? "Merging is blocked: it needs an approving review." : pr.reviewDecision === "CHANGES_REQUESTED" ? "Merging is blocked: changes were requested." : "Merging is blocked by a required check or rule.");
  }

  const checks = el("ul", "pr-checks");
  checks.role = "listbox";
  checks.ariaLabel = "Checks";
  listNav(checks);
  const checksHeading = el("h3");
  drawChecks(pr, checks, checksHeading);
  watchChecks(pr, checks, checksHeading);

  const files = el("ul", "pr-files");
  files.role = "listbox";
  files.ariaLabel = "Files";
  listNav(files);
  const filesHeading = el("h3");
  const countViewed = () => (filesHeading.textContent = `Files (${pr.files.length})${viewed.size ? ` · ${pr.files.filter((f) => viewed.get(f.path)).length} viewed` : ""}`);
  countViewed();
  for (const f of pr.files) {
    const li = el("li");
    li.role = "option";
    li.dataset.key = f.path;
    li.dataset.label = f.path.split("/").pop()!;
    // GitHub's own Viewed checkbox, so what you've read is the same here and in the browser.
    if (viewed.has(f.path)) {
      const box = el("input");
      box.type = "checkbox";
      box.checked = !!viewed.get(f.path);
      box.title = "Viewed";
      box.onclick = (e) => e.stopPropagation();
      box.onchange = async () => {
        try {
          await setViewed(pr.id, f.path, box.checked);
          viewed.set(f.path, box.checked);
          li.classList.toggle("viewed", box.checked);
          countViewed();
        } catch (e) {
          box.checked = !box.checked;
          showError("Can't change the file's Viewed state", e);
        }
      };
      li.append(box);
      li.classList.toggle("viewed", box.checked);
    }
    li.append(el("span", "name", ltr(f.path)), el("span", "added", `+${f.additions}`), el("span", "deleted", `−${f.deletions}`));
    const fileThreads = threads.filter((t) => t.path === f.path);
    if (fileThreads.length) {
      const open = fileThreads.filter((t) => !t.resolved).length;
      const count = el("span", `codicon codicon-comment${open ? " unresolved" : ""}`, ` ${fileThreads.length}`);
      count.title = `${fileThreads.length} ${fileThreads.length === 1 ? "thread" : "threads"}, ${open} unresolved`;
      li.append(count);
    }
    li.onclick = () => showFileDiff(pr, f.path, threads);
    files.append(li);
  }

  const commits = el("ul", "pr-files pr-commits");
  commits.role = "listbox";
  commits.ariaLabel = "Commits";
  listNav(commits);
  for (const c of pr.commits) {
    const li = el("li");
    li.role = "option";
    li.dataset.key = c.oid;
    li.dataset.label = c.messageHeadline;
    li.append(el("span", "hash", c.oid.slice(0, 7)), el("span", "muted", c.messageHeadline), el("span", "pr-when", c.authors[0]?.login || c.authors[0]?.name || ""));
    li.title = `${c.messageHeadline}\n${new Date(c.committedDate).toLocaleString()}`;
    // The commits come with the pull request's head, which opening the page fetches.
    li.onclick = () => prepareDiff(pr).then(() => showCommitDiff(c.oid), (e) => showError(`Can't fetch #${number}`, e));
    commits.append(li);
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
  const editable = (user: string, body: string, target: Target, at: string, label = "") => {
    const item = el("div", "pr-comment");
    const draw = () => item.replaceChildren(...commentBlock(user, body, target, repo, draw, reload, at, label));
    draw();
    return item;
  };
  // Your pending review isn't part of the conversation yet; it's listed below.
  for (const r of pr.reviews)
    if (r.state !== "PENDING" && (r.body || r.state !== "COMMENTED"))
      timeline.push({ at: r.submittedAt, nodes: [r.body ? editable(r.author.login, r.body, reviewTarget(r.id), r.submittedAt, reviews[r.state] ?? r.state.toLowerCase()) : entry(r.author.login, reviews[r.state] ?? r.state.toLowerCase(), r.body, r.submittedAt)] });
  for (const c of pr.comments) {
    const id = c.url.match(/#issuecomment-(\d+)$/)?.[1];
    timeline.push({ at: c.createdAt, nodes: [id ? editable(c.author.login, c.body, restTarget(`repos/{owner}/{repo}/issues/comments/${id}`), c.createdAt) : entry(c.author.login, "", c.body, c.createdAt)] });
  }
  // Line comments, each thread under a link to its place in the diff.
  for (const t of threads) {
    const where = el("button", "link pr-thread-link", `${t.path}${t.line ? `:${t.start_line && t.start_line !== t.line ? `${t.start_line}–` : ""}${t.line}` : " (outdated)"}${t.resolved ? " · resolved" : ""}`);
    where.onclick = () => showFileDiff(pr, t.path, threads, t);
    timeline.push({ at: t.created_at, nodes: [where, ...t.comments.map((c) => editable(c.user, c.body, restTarget(`repos/{owner}/{repo}/pulls/comments/${c.id}`), c.created_at))] });
  }
  const time = (at: string) => Date.parse(at) || 0; // A missing date sorts first rather than breaking the order.
  timeline.sort((a, b) => time(a.at) - time(b.at));
  if (pr.body) conversation.append(entry(pr.author.login, "description", pr.body, pr.createdAt));
  conversation.append(...timeline.flatMap((t) => t.nodes));

  const heading = (text: string) => el("h3", "", text);
  const unresolved = threads.filter((t) => t.line && !t.resolved);
  const conversationHeading = heading(`Conversation${threads.length ? ` (${threads.length} line ${threads.length === 1 ? "thread" : "threads"}${unresolved.length ? `, ${unresolved.length} unresolved` : ""})` : ""}`);
  if (unresolved.length) {
    const next = el("button", "link pr-heading-link", "Go to Unresolved");
    next.title = "Open the first unresolved thread; each thread's Next Unresolved link goes on from there";
    next.onclick = () => nextUnresolved(pr, threads);
    conversationHeading.append(next);
  }
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
      deletePending(number, c).then(reload, (err) => showError(`Can't delete the pending comment`, err));
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
        reload();
      } catch (e) {
        showError(`Can't ${label.toLowerCase()}`, e);
        buttons.querySelectorAll("button").forEach((x) => (x.disabled = false));
      }
    };
    buttons.append(b);
  };
  reply(hasPending ? `Submit Review (${pendingComments.length})` : "Comment", "COMMENT", true, hasPending ? `Submitted your review on #${number}` : `Commented on #${number}`);
  if (open) {
    reply("Approve", "APPROVE", false, `Approved #${number}`);
    reply("Request Changes", "REQUEST_CHANGES", true, `Requested changes on #${number}`);
  }
  // ⌘⏎ does the first button's action, as in the diff's comment box.
  box.onkeydown = (e) => e.key === "Enter" && mod(e) && buttons.querySelector("button")!.click();
  review.append(box, buttons);
  const meta = el("div", "pr-meta");
  meta.append(`${pr.state.toLowerCase()} · ${pr.author.login} · ${pr.headRefName} → ${pr.baseRefName} · `, el("span", "added", `+${pr.additions}`), " ", el("span", "deleted", `−${pr.deletions}`), when(pr.createdAt));
  detail.replaceChildren(
    back,
    el("h2", "", `#${pr.number} ${pr.title}`),
    meta,
    ...(pr.labels.length ? [labelRow(pr.labels)] : []),
    reviewerRow(pr),
    actions,
    banner,
    checksHeading,
    checks,
    filesHeading,
    files,
    heading(`Commits (${pr.commits.length})`),
    commits,
    conversationHeading,
    conversation,
    ...(pendingComments.length ? [heading(`Pending review (${pendingComments.length} ${pendingComments.length === 1 ? "comment" : "comments"})`), pendingList] : []),
    review,
  );
  // Fetch the head and base now, so opening a file's diff doesn't wait for the network.
  prepareDiff(pr).catch(() => {});
}

/** Labels as colored chips, in GitHub's colors. */
function labelRow(labels: Label[]) {
  const row = el("div", "pr-labels");
  for (const l of labels) {
    const chip = el("span", "pr-label", l.name);
    chip.style.setProperty("--label", `#${l.color}`);
    row.append(chip);
  }
  return row;
}

/** Who reviewed and how, and who's still asked to. */
function reviewerRow(pr: Details) {
  const row = el("div", "pr-meta pr-reviewers");
  const marks: Record<string, [string, string]> = { APPROVED: ["✓", "checks-passed"], CHANGES_REQUESTED: ["✗", "checks-failed"], COMMENTED: ["💬", ""], DISMISSED: ["–", "checks-skipped"] };
  const people: HTMLElement[] = [];
  for (const r of pr.latestReviews) {
    const [mark, color] = marks[r.state] ?? ["", ""];
    const span = el("span", "", `${r.author.login} `);
    span.append(el("span", color, mark));
    span.title = reviews[r.state] ?? r.state.toLowerCase();
    people.push(span);
  }
  for (const r of pr.reviewRequests) {
    const span = el("span", "", `${r.login ?? r.name ?? r.slug} `);
    span.append(el("span", "checks-pending", "●"));
    span.title = "Review requested";
    people.push(span);
  }
  row.append(people.length ? "Reviewers: " : "No reviewers");
  people.forEach((p, i) => row.append(...(i ? [", "] : []), p));
  return row;
}

/** Pull requests whose passed and skipped checks you opened, which are folded while others failed or run. */
const unfolded = new Set<number>();

/** Draws the checks, failed first, with a log link on failed GitHub Actions jobs and Re-run Failed in the heading. */
function drawChecks(pr: Details, list: HTMLElement, heading: HTMLElement) {
  const sorted = sortChecks(pr.statusCheckRollup ?? []);
  const done = sorted.filter((c) => ["passed", "skipped"].includes(checkState(c)));
  const fold = done.length > 3 && done.length < sorted.length && !unfolded.has(pr.number);
  const all = fold ? sorted.filter((c) => !done.includes(c)) : sorted;
  const counts = { failed: 0, pending: 0, passed: 0, skipped: 0 };
  sorted.forEach((c) => counts[checkState(c)]++);
  const parts = [counts.failed && `${counts.failed} failed`, counts.pending && `${counts.pending} running`, counts.passed && `${counts.passed} passed`, counts.skipped && `${counts.skipped} skipped`].filter(Boolean);
  heading.replaceChildren(`Checks${parts.length ? ` · ${parts.join(" · ")}` : " (none)"}`);
  const failedRuns = [...new Set(all.filter((c) => checkState(c) === "failed").map((c) => actionsJob(c.detailsUrl)?.run).filter((r): r is string => !!r))];
  if (failedRuns.length) {
    const rerun = el("button", "link pr-heading-link", "Re-run Failed");
    rerun.title = "Run the failed GitHub Actions jobs again";
    rerun.onclick = async () => {
      rerun.disabled = true;
      for (const id of failedRuns) if ((await withProgress(`Re-running the failed jobs…`, () => gh("run", "rerun", id, "--failed"), { error: "Can't re-run the failed jobs" })) === undefined) return;
      host.status(`Re-running the failed jobs of #${pr.number}.`);
      showPullRequest(pr.number);
    };
    heading.append(rerun);
  }
  list.replaceChildren(
    ...all.map((c) => {
      const state = checkState(c);
      const li = el("li");
      li.role = "option";
      li.dataset.key = c.name ?? c.context ?? "";
      li.title = c.name ?? c.context ?? "";
      li.append(el("span", `checks-${state}`, icons[state]), el("span", "name-plain", ` ${c.name ?? c.context}`));
      const url = c.detailsUrl ?? c.targetUrl;
      if (url) li.onclick = () => openUrl(url);
      const job = actionsJob(c.detailsUrl);
      if (job && state === "failed") {
        const log = el("button", "link", "Log");
        log.title = "Show the failed steps' log; file paths in it open in the editor";
        log.onclick = (e) => (e.stopPropagation(), showLog(c.name ?? "", job.job));
        li.append(log);
      }
      return li;
    }),
  );
  if (fold) {
    const li = el("li");
    const show = el("button", "link", `Show ${done.length} passed and skipped`);
    show.onclick = () => (unfolded.add(pr.number), drawChecks(pr, list, heading));
    li.append(show);
    list.append(li);
  }
}

/** While checks run, reloads them every 15 seconds, redrawing only the checks, until the page shows something else. */
function watchChecks(pr: Details, list: HTMLElement, heading: HTMLElement) {
  if (checksSummary(pr.statusCheckRollup) !== "pending") return;
  const shownHere = () => list.isConnected && !$("pr-detail").hidden && $("pr-detail").dataset.number === String(pr.number);
  setTimeout(async function tick() {
    if (!shownHere()) return;
    try {
      const { statusCheckRollup } = JSON.parse(await gh("pr", "view", String(pr.number), "--json", "statusCheckRollup"));
      if (!shownHere()) return;
      pr.statusCheckRollup = statusCheckRollup;
      drawChecks(pr, list, heading);
      if (checksSummary(statusCheckRollup) !== "pending") return updateBranchPullRequest();
    } catch {
      // Tried again on the next tick.
    }
    setTimeout(tick, 15000);
  }, 15000);
}

/** Shows a failed job's log, with paths of project files in it as links that open them at their line. */
async function showLog(name: string, job: string) {
  const out = await withProgress(`Loading the log of ${name}…`, () => gh("run", "view", "--job", job, "--log-failed"), { error: `Can't load the log of ${name}` });
  if (out === undefined) return;
  const text = cleanLog(out) || "The log has no failed steps. A canceled job, or one that timed out, has none.";
  showOutput(`${name}: failed steps`, text);
  const pre = document.querySelector<HTMLElement>("#output-dialog .output-text");
  if (!pre) return;
  // Opens at the first error: PHPUnit's and Pest's summary, or a step's error annotation, or else the end.
  const scroll = () => {
    const at = text.search(/^.*(?:There (?:was|were) \d+ (?:failure|error)|FAILED|##\[error\]|Error: )/m);
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    let offset = 0;
    while (at >= 0 && walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (offset + node.length > at) {
        const range = document.createRange();
        range.setStart(node, at - offset);
        return (pre.scrollTop += range.getBoundingClientRect().top - pre.getBoundingClientRect().top - 8);
      }
      offset += node.length;
    }
    pre.scrollTop = pre.scrollHeight;
  };
  scroll();
  linkPaths(pre, text).then(scroll);
}

/**
 * Turns paths in a CI log into links to the project's files. CI checks out to another folder, such as
 * /home/runner/work/app/app, so each path is tried from each of its folders down until one is in the project.
 */
async function linkPaths(pre: HTMLElement, text: string) {
  const pattern = /((?:[\w.@-]*\/)+[\w.@-]+\.[A-Za-z]\w*)(?::(\d+))?/g;
  // ponytail: the first 100 distinct paths are looked up; a log with more links only those.
  const paths = [...new Set([...text.matchAll(pattern)].map((m) => m[1]))].slice(0, 100);
  const found = new Map<string, string>();
  await Promise.all(
    paths.map(async (path) => {
      const parts = path.split("/").filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const candidate = `${host.root()}/${parts.slice(i).join("/")}`;
        if (await invoke<boolean>("path_exists", { path: candidate }).catch(() => false)) return void found.set(path, candidate);
      }
    }),
  );
  if (!found.size || !pre.isConnected) return;
  const nodes: (string | HTMLElement)[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const file = found.get(m[1]);
    if (!file) continue;
    nodes.push(text.slice(last, m.index));
    const a = el("a", "log-link", m[0]);
    a.href = "#";
    a.onclick = (e) => (e.preventDefault(), (pre.closest("dialog") as HTMLDialogElement | null)?.close(), host.openAt(file, Number(m[2] ?? 1)));
    nodes.push(a);
    last = m.index + m[0].length;
  }
  nodes.push(text.slice(last));
  pre.replaceChildren(...nodes);
}

/** The pull request's actions that aren't buttons on its page. */
function more(pr: Details, run: (progress: string, args: string[], done: string, error: string) => unknown) {
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
function updateBranch(pr: Details, run: (progress: string, args: string[], done: string, error: string) => unknown) {
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
function requestReview(pr: Details, run: (progress: string, args: string[], done: string, error: string) => unknown) {
  const people = gh("api", "--paginate", "repos/{owner}/{repo}/assignees", "--jq", ".[].login").then((out) => out.split("\n").filter(Boolean));
  const asked = new Set([...pr.reviewRequests.map((r) => r.login), ...pr.latestReviews.map((r) => r.author.login)]);
  pick("Request a review from", async (q) => {
    const logins = (await people.catch((e) => (showError("Can't list the people who can review", e), [] as string[]))).filter((l) => l !== pr.author.login);
    return logins
      .filter((l) => l.toLowerCase().includes(q.toLowerCase()))
      .map((l) => ({ label: l, detail: asked.has(l) ? "asked again" : undefined, run: () => run(`Requesting a review from ${l}…`, ["pr", "edit", String(pr.number), "--add-reviewer", l], `Asked ${l} to review #${pr.number}`, `Can't request a review from ${l}`) }));
  });
}

/** Adds or removes a label, from the repository's labels. */
function editLabels(pr: Details, run: (progress: string, args: string[], done: string, error: string) => unknown) {
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

// ponytail: the first 100 files per page, all pages; GitHub has no Viewed state on very large pull requests.
const VIEWED = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { files(first: 100, after: $endCursor) { nodes { path viewerViewedState } pageInfo { hasNextPage endCursor } } } }
}`;

/** Which files you marked Viewed on GitHub, by path. */
async function viewedFiles(number: number) {
  const jq = ".data.repository.pullRequest.files.nodes[] | [.path, .viewerViewedState == \"VIEWED\"]";
  const out = await gh("api", "graphql", "--paginate", "-F", "owner={owner}", "-F", "name={repo}", "-F", `number=${number}`, "-f", `query=${VIEWED}`, "--jq", jq);
  return new Map<string, boolean>(out.split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

const setViewed = (id: string, path: string, viewed: boolean) => {
  const mutation = viewed ? "markFileAsViewed" : "unmarkFileAsViewed";
  return gh("api", "graphql", "-f", `query=mutation($id: ID!, $path: String!) { ${mutation}(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`, "-f", `id=${id}`, "-f", `path=${path}`);
};

/** Opens the next unresolved thread after `after`, in the order of the files, or the first one. */
function nextUnresolved(pr: Details, threads: Thread[], after?: Thread) {
  const order = (t: Thread) => [pr.files.findIndex((f) => f.path === t.path), t.line ?? 0];
  const open = threads.filter((t) => t.line && !t.resolved).sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1]);
  if (!open.length) return host.status("No unresolved threads.");
  const i = after ? open.findIndex((t) => t.id === after.id) : -1;
  const next = open[(i + 1) % open.length];
  if (after && next.id === after.id) return host.status("This is the only unresolved thread.");
  showFileDiff(pr, next.path, threads, next);
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

// gh's --paginate follows $endCursor through every page of threads.
const THREADS = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $endCursor) { nodes { id isResolved comments(first: 1) { nodes { databaseId } } } pageInfo { hasNextPage endCursor } } } }
}`;

/** Each thread's GraphQL ID and whether it's resolved, by the REST ID of its first comment. */
async function threadStates(number: number) {
  const jq = ".data.repository.pullRequest.reviewThreads.nodes[] | {id, resolved: .isResolved, first: .comments.nodes[0].databaseId}";
  const out = await gh("api", "graphql", "--paginate", "-F", "owner={owner}", "-F", "name={repo}", "-F", `number=${number}`, "-f", `query=${THREADS}`, "--jq", jq);
  const lines: { id: string; resolved: boolean; first: number }[] = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return new Map(lines.map((t) => [t.first, { id: t.id, resolved: t.resolved }]));
}

/** Your GitHub login, so your own comments get Edit and Delete. Empty when `gh` can't tell. */
let myLogin = "";
let loginLookup: Promise<unknown> | undefined;
const me = () => (loginLookup ??= gh("api", "user", "--jq", ".login").then((l) => (myLogin = l.trim()), () => (loginLookup = undefined)));

/** The comment being edited, and the one whose delete waits for a second click, by their targets' keys. */
let editing = "";
let deleting = "";

/** How to change a comment on GitHub: `key` names it, and a review's summary has no `remove`, since GitHub keeps it. */
type Target = { key: string; save(body: string): Promise<unknown>; remove?(): Promise<unknown> };
const restTarget = (api: string): Target => ({ key: api, save: (body) => gh("api", "--method", "PATCH", "-f", `body=${body}`, api), remove: () => gh("api", "--method", "DELETE", api) });
const reviewTarget = (id: string): Target => ({
  key: id,
  save: (body) => gh("api", "graphql", "-f", "query=mutation($id: ID!, $body: String!) { updatePullRequestReview(input: { pullRequestReviewId: $id, body: $body }) { clientMutationId } }", "-f", `id=${id}`, "-f", `body=${body}`),
});

/**
 * A comment's author and text, with Edit and Delete when it's yours. `target` changes it on GitHub.
 * `redraw` draws it again after you start or cancel an edit, and `reload` fetches everything after GitHub changed it.
 */
function commentBlock(user: string, body: string, target: Target, repo: string, redraw: () => void, reload: () => unknown, at?: string, label = ""): HTMLElement[] {
  const meta = el("div", "pr-meta", `${user}${label ? ` · ${label}` : ""}`);
  const api = target.key;
  if (at) meta.append(when(at));
  if (!myLogin || user !== myLogin) return [meta, markdown(body, repo)];
  const link = (label: string, run: () => unknown) => {
    const b = el("button", "link", label);
    b.onclick = run;
    meta.append(" · ", b);
  };
  const change = async (request: () => Promise<unknown>, what: string) => {
    try {
      await request();
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
    save.onclick = () => text.value.trim() && change(() => target.save(text.value.trim()), "edit");
    const cancel = el("button", "", "Cancel");
    cancel.onclick = () => ((editing = ""), redraw());
    text.onkeydown = (e) => {
      if (e.key === "Enter" && mod(e)) save.click();
      if (e.key === "Escape") cancel.click();
    };
    buttons.append(save, cancel);
    box.append(text, buttons);
    requestAnimationFrame(() => text.focus());
    return [meta, box];
  }
  if (deleting === api) {
    meta.append(" · Delete this comment on GitHub?");
    link("Delete", () => change(target.remove!, "delete"));
    link("Cancel", () => ((deleting = ""), redraw()));
  } else {
    link("Edit", () => ((editing = api), (deleting = ""), redraw()));
    if (target.remove) link("Delete", () => ((deleting = api), (editing = ""), redraw()));
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
  // Until checks and reviews pass, GitHub can merge on its own once they do.
  const auto = pr.mergeStateStatus !== "CLEAN" && pr.mergeStateStatus !== "UNSTABLE" && pr.mergeStateStatus !== "HAS_HOOKS";
  pick(`Merge #${pr.number} into ${pr.baseRefName}`, () =>
    methods.map((m) => ({
      label: m.label,
      // Confirmed in the palette rather than a native dialog, which a page reload could leave stuck on screen.
      run: () => {
        const go = (extra: string[], verb: string) => async () => {
          const merged = await withProgress(`${verb} #${pr.number}…`, () => gh("pr", "merge", String(pr.number), m.flag, ...extra), { error: `Can't merge #${pr.number}` });
          if (merged !== undefined) host.status(extra.includes("--auto") ? `Turned on auto-merge for #${pr.number}` : `Merged #${pr.number}`);
          showPullRequest(pr.number);
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
      if (!here) {
        const { code, output } = await gitOutput(["fetch", "--no-tags", "origin", `+refs/pull/${pr.number}/head:refs/remotes/pr/${pr.number}`, `+refs/heads/${pr.baseRefName}:${base}`]);
        if (code) throw new Error(output);
      }
      return (await git("merge-base", pr.headRefOid, base)).trim();
    })();
    // A failed fetch is tried again next time.
    mergeBases.set(key, ready.catch((e) => (mergeBases.delete(key), Promise.reject(e))));
  }
  return mergeBases.get(key)!;
}

/**
 * Opens a file's diff among all the pull request's files, so the diff's previous and next buttons (⌥⌘← and ⌥⌘→)
 * go through them with their comments.
 */
function showFileDiff(pr: Details, path: string, threads: Thread[], at?: { line: number | null; side: "LEFT" | "RIGHT" }) {
  const files = pr.files.map((f) => ({ path: f.path, load: async (): Promise<[string, string]> => ["", ""], show: () => showOneDiff(pr, f.path, threads, f.path === path ? at : undefined) }));
  return showDiffs(files, `#${pr.number}: ${pr.baseRefName} ↔ ${pr.headRefName}`, Math.max(0, files.findIndex((f) => f.path === path)));
}

async function showOneDiff(pr: Details, path: string, threads: Thread[], at?: { line: number | null; side: "LEFT" | "RIGHT" }): Promise<boolean> {
  let diff: monaco.editor.IStandaloneDiffEditor;
  try {
    const slow = setTimeout(() => status(`Fetching #${pr.number}…`, "prs:progress"), 300);
    const [mergeBase] = await Promise.all([prepareDiff(pr).finally(() => (clearTimeout(slow), status("", "prs:progress"))), loadMarkdown(), me()]);
    const show = (spec: string) => git("show", spec).catch(() => "");
    const [original, modified] = await Promise.all([show(`${mergeBase}:${path}`), show(`${pr.headRefOid}:${path}`)]);
    const action = { label: "Comment on Line", title: "Comment on the selected lines, or reply to the comments on the cursor's line", run: () => commentAtCursor() };
    diff = showDiff(path, original, modified, `#${pr.number}: ${pr.baseRefName} ↔ ${pr.headRefName}`, action);
  } catch (e) {
    showError(`Can't show the diff`, e);
    return false;
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
  return true;
}

/**
 * Puts a suggestion into your copy of the file, in its editor, where you can review, undo, or save it. Only on the
 * pull request's branch, and only while the lines still read as they did in the pull request.
 */
async function applySuggestion(pr: Details, t: Thread, text: string) {
  if (gitStatus()?.branch !== pr.headRefName) return showError(`Check out #${pr.number} (${pr.headRefName}) to apply its suggestions.`);
  const model = shown?.model;
  if (!model || !t.line) return;
  const start = t.start_line ?? t.line;
  const expected = model.getValueInRange({ startLineNumber: start, startColumn: 1, endLineNumber: t.line, endColumn: model.getLineMaxColumn(t.line) });
  if (await host.replaceLines(`${host.root()}/${t.path}`, start, t.line, expected, text)) host.status(`Applied the suggestion to ${t.path}:${start}. Review it and save.`);
  else showError(`The lines of ${t.path} changed since the suggestion was made. Apply it by hand.`);
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
        for (const c of t.comments) {
      thread.append(...commentBlock(c.user, c.body, restTarget(`repos/{owner}/{repo}/pulls/comments/${c.id}`), repo, drawZones, reload, c.created_at));
      const suggested = t.side === "RIGHT" ? suggestion(c.body) : null;
      if (suggested !== null) {
        const apply = el("div", "pr-thread-actions");
        action(apply, "Apply Suggestion Locally", () => applySuggestion(pr, t, suggested));
        thread.append(apply);
      }
    }
    if (form?.reply?.id === t.id) thread.append(commentForm());
    else {
      const actions = el("div", "pr-thread-actions");
      action(actions, "Reply", () => ((form = { side: t.side, line: t.line!, start: t.line!, reply: t }), drawZones()));
      if (t.node) action(actions, t.resolved ? "Unresolve" : "Resolve", () => setResolved(t, !t.resolved));
      if (t.resolved) action(actions, "Hide", () => (expanded.delete(t.id), drawZones()));
      if (threads.some((x) => x.id !== t.id && x.line && !x.resolved)) action(actions, "Next Unresolved", () => nextUnresolved(pr, threads, t));
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
  // On the new side, Suggest Change writes the lines into a suggestion block to edit, as on GitHub.
  if (!f.reply && f.side === "RIGHT" && shown?.model) {
    const model = shown.model;
    const suggest = el("button", "", "Suggest Change");
    suggest.title = "Insert the lines as a suggestion to edit";
    suggest.onclick = () => {
      const lines = model.getValueInRange({ startLineNumber: f.start, startColumn: 1, endLineNumber: f.line, endColumn: model.getLineMaxColumn(f.line) });
      text.setRangeText(`${text.value && !text.value.endsWith("\n") ? "\n" : ""}\`\`\`suggestion\n${lines}\n\`\`\`\n`, text.selectionStart, text.selectionEnd, "end");
      text.focus();
    };
    buttons.append(suggest);
  }
  const cancel = el("button", "", "Cancel");
  cancel.onclick = close;
  buttons.append(cancel);
  text.onkeydown = (e) => {
    if (e.key === "Enter" && mod(e)) buttons.querySelector("button")!.click();
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
  let typing: ReturnType<typeof setTimeout> | undefined;
  $("pr-search").oninput = () => (clearTimeout(typing), (typing = setTimeout(loadPullRequests, 400)));
  $("pr-search").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") e.preventDefault(), $("pr-list").focus();
  });
  // Enter or a click opens a pull request.
  listNav($("pr-list"));
  // On a pull request's page, Refresh reloads that pull request.
  $("pr-refresh").onclick = () => ($("pr-detail").hidden ? loadPullRequests() : showPullRequest(Number($("pr-detail").dataset.number)));
  $("pr-create").onclick = createPullRequest;
}
