// Pull requests through the GitHub CLI (`gh`): list, details, checks, reviews, line comments, and diffs.
import { invoke } from "@tauri-apps/api/core";
import { monaco } from "./editor";
import { type DiffFile, diffCursor, git, gitOutput, gitStatus, gitTask, showDiff, showDiffs, showOutput } from "./git";
import { actionsJob, age, type Check, checkDuration, checkState, checksSummary, cleanLog, sortChecks, suggestion } from "./gitparse";
import { showCommitDiff } from "./history";
import { confirm, pick } from "./palette";
import { listNav } from "./listnav";
import { errorText, showError, status, withProgress } from "./status";
import { closeView, openTerminal, showEditorView } from "./terminal";
import { isMac, mod } from "./platform.ts";

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
type ReviewComment = { id: number; path: string; line: number | null; start_line: number | null; side: "LEFT" | "RIGHT"; body: string; user: string; in_reply_to_id: number | null; created_at: string; diff_hunk?: string };
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
  // Switching back to the view keeps the last list while it refreshes; a new project, filter, or search starts over.
  const key = `${host.root()}\0${filter}\0${text}`;
  if ($("pr-list").dataset.key !== key) ($("pr-list").dataset.key = key), (limit = 50), $("pr-list").replaceChildren(el("li", "muted", "Loading…"));
  try {
    // GitHub times out building the check status of 50 closed pull requests, and it matters little once closed.
    const fields = state.length ? LIST_FIELDS.replace(",statusCheckRollup", "") : LIST_FIELDS;
    const prs: ListedPullRequest[] = JSON.parse(await gh("pr", "list", "--limit", String(limit), "--json", fields, ...args));
    if ($("pr-list").dataset.key !== key) return; // A newer search replaced this one.
    const seenAt = seen();
    const more = el("li", "pr-more");
    const button = el("button", "", "Load More");
    button.onclick = () => ((limit += 50), (button.disabled = true), (button.textContent = "Loading…"), loadPullRequests());
    more.append(button);
    $("pr-list").replaceChildren(
      ...(prs.length ? prs.map((pr) => prRow(pr, seenAt)) : [el("li", "muted", text ? "No pull requests match the search." : "No pull requests.")]),
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

const icon = (name: string, className = "") => el("span", `codicon codicon-${name}${className ? ` ${className}` : ""}`);
const checkIcons: Record<string, string> = { passed: "pass-filled", failed: "error", pending: "loading codicon-modifier-spin", skipped: "circle-slash", none: "circle-outline" };
/** A check state's icon, colored by state. */
const checkIcon = (state: string) => icon(checkIcons[state], `checks-${state}`);

/** The pull request's state as GitHub shows it: Open, Draft, Merged, or Closed, with its icon and color. */
function statePill(pr: { state: string; isDraft: boolean }) {
  const [label, name, kind] =
    pr.state === "MERGED" ? ["Merged", "git-merge", "merged"] : pr.state === "CLOSED" ? ["Closed", "git-pull-request-closed", "closed"] : pr.isDraft ? ["Draft", "git-pull-request-draft", "draft"] : ["Open", "git-pull-request", "open"];
  const pill = el("span", `pr-state ${kind}`);
  pill.append(icon(name), label);
  return pill;
}

/** A person's GitHub avatar, from the pull request's own host, or their initial when it doesn't load. */
function avatar(login: string, repo: string, size = 20) {
  const box = el("span", "pr-avatar", login.slice(0, 1).toUpperCase());
  box.style.setProperty("--size", `${size}px`);
  const img = el("img");
  img.alt = "";
  img.onload = () => box.classList.add("loaded");
  img.onerror = () => img.remove();
  img.src = `${new URL(repo).origin}/${encodeURIComponent(login.replace(/\[bot\]$/, ""))}.png?size=${size * 2}`;
  box.append(img);
  return box;
}

/**
 * When you last saw each pull request you opened, by its `updatedAt` then, per project. Kept in this computer's
 * storage; losing it only loses the marks.
 */
const seenKey = () => `pr-seen:${host.root()}`;
function seen(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(seenKey()) ?? "{}");
  } catch {
    return {};
  }
}
function markSeen(number: number, updatedAt: string) {
  try {
    localStorage.setItem(seenKey(), JSON.stringify({ ...seen(), [number]: updatedAt }));
  } catch {
    // Storage is off; the list just doesn't mark new activity.
  }
  $("pr-list").querySelector(`li.pr[data-key="${number}"]`)?.classList.remove("unseen");
}

function prRow(pr: ListedPullRequest, seenAt: Record<string, string> = {}) {
  const li = el("li", "pr");
  li.role = "option";
  li.dataset.key = String(pr.number);
  li.dataset.label = pr.title;
  li.classList.toggle("open", openNumber === pr.number);
  const kind = pr.state === "MERGED" ? ["git-merge", "merged"] : pr.state === "CLOSED" ? ["git-pull-request-closed", "closed"] : pr.isDraft ? ["git-pull-request-draft", "draft"] : ["git-pull-request", "open"];
  const state = icon(kind[0], `pr-row-state ${kind[1]}`);
  state.title = kind[1][0].toUpperCase() + kind[1].slice(1);
  const title = el("div", "pr-title", pr.title);
  const meta = el("div", "pr-meta");
  const checks = checksSummary(pr.statusCheckRollup);
  meta.append(`#${pr.number} · ${pr.author.login}`, when(pr.updatedAt));
  if (checks !== "none") meta.append(" ", checkIcon(checks));
  if (reviews[pr.reviewDecision]) meta.append(` · ${reviews[pr.reviewDecision]}`);
  for (const l of pr.labels) meta.append(" ", labelChip(l));
  const text = el("div", "pr-row-text");
  text.append(title, meta);
  li.append(state, text);
  li.title = `#${pr.number} ${pr.title}\n${pr.headRefName} → ${pr.baseRefName} · +${pr.additions} −${pr.deletions}`;
  // A pull request you opened before, which changed since, as GitHub marks unread notifications.
  const before = seenAt[pr.number];
  if (before && Date.parse(pr.updatedAt) > Date.parse(before)) {
    li.classList.add("unseen");
    li.title += "\nNew activity since you last opened it";
  }
  li.onclick = () => showPullRequest(pr.number, pr.title);
  return li;
}

// ---- Details ----

type Section = "conversation" | "commits" | "checks" | "files";
/** The pull request open in the editor tab, and the section it shows. A refresh keeps the section and scroll. */
let openNumber: number | undefined;
let section: Section = "conversation";
/** What you typed in the comment box, by pull request, so a refresh after an action keeps it. */
const drafts = new Map<number, string>();

/** Opens a pull request in its editor tab. */
export function showPullRequest(number: number, title = "") {
  const page = $("pr-detail");
  if (openNumber !== number) section = "conversation";
  openNumber = number;
  showEditorView(title ? `#${number} ${title}` : `#${number}`, page, "git-pull-request", () => {
    openNumber = undefined;
    markOpenRow();
  });
  page.hidden = false;
  markOpenRow();
  return renderPullRequest(number);
}

/** Marks the open pull request in the sidebar list. */
const markOpenRow = () => $("pr-list").querySelectorAll<HTMLElement>("li.pr").forEach((li) => li.classList.toggle("open", li.dataset.key === String(openNumber)));

/** Loads a pull request and draws its tab, keeping the tab's section, scroll, and comment draft. */
async function renderPullRequest(number: number) {
  const libraries = loadMarkdown();
  const page = $("pr-detail");
  // Refreshing the same pull request, such as after you comment, keeps it on screen until the new version is ready.
  if (page.dataset.number !== String(number)) page.replaceChildren(el("p", "muted pr-loading", "Loading…"));
  page.dataset.number = String(number);
  let pr: Details;
  let threads: Thread[];
  let viewed: Map<string, boolean>;
  let headCommit: string;
  try {
    [pr, threads, viewed, headCommit] = await Promise.all([
      gh("pr", "view", String(number), "--json", DETAIL_FIELDS).then(JSON.parse),
      lineComments(number),
      viewedFiles(number).catch(() => new Map<string, boolean>()),
      git("rev-parse", "HEAD").then((h) => h.trim(), () => ""),
      me(),
      loadPending(number).catch(() => null),
    ]);
  } catch (e) {
    const list = el("ul", "pr-checks");
    list.append(problemItem(`Can't load #${number}`, e, () => renderPullRequest(number)));
    page.replaceChildren(list);
    return;
  }
  await libraries;
  if (page.dataset.number !== String(number)) return; // Another pull request opened meanwhile.
  viewedOf = { number, files: viewed };
  markSeen(number, pr.updatedAt);
  const open = pr.state === "OPEN";
  const reload = () => renderPullRequest(number);
  // Runs a `gh` command that changes the pull request, then shows it again.
  const run = async (progress: string, args: string[], done: string, error: string) => {
    if ((await withProgress(progress, () => gh(...args), { error })) === undefined) return;
    host.status(done);
    reload();
  };
  // gh fetches and checks out with git, which asks for a password or passphrase in the dialog through gitTask.
  const checkOut = () => gitTask(`Checking out #${number}…`, ["pr", "checkout", String(number)], `Can't check out #${number}`, { gh: true }).then((o) => o !== undefined && status(`Checked out #${number}.`, "app", "info"));
  const repo = repoUrl(pr);

  // ---- Header: title, state, branches, and actions ----
  const head = el("header", "pr-head");
  const titleBox = el("div", "pr-head-main");
  const h1 = el("h1");
  h1.append(el("span", "", pr.title), el("span", "pr-number", ` #${pr.number}`));
  const sub = el("div", "pr-sub");
  const branch = (name: string) => {
    const b = el("code", "pr-branch", name);
    b.title = `Copy ${name}`;
    b.onclick = () => navigator.clipboard.writeText(name).then(() => host.status(`Copied ${name}`));
    return b;
  };
  sub.append(
    statePill(pr),
    avatar(pr.author.login, repo),
    el("strong", "", pr.author.login),
    ` ${pr.state === "MERGED" ? "merged" : "wants to merge"} ${pr.commits.length} ${pr.commits.length === 1 ? "commit" : "commits"} into `,
    branch(pr.baseRefName),
    " from ",
    branch(pr.headRefName),
  );
  titleBox.append(h1, sub);
  const actions = el("div", "pr-head-actions");
  const button = (label: string, run: () => unknown, className = "", title = "") => {
    const b = el("button", className, label);
    if (title) b.title = title;
    b.onclick = run;
    actions.append(b);
    return b;
  };
  const iconButton = (name: string, title: string, run: () => unknown) => {
    const b = el("button", `icon-button codicon codicon-${name}`);
    b.title = title;
    b.setAttribute("aria-label", title);
    b.onclick = run;
    actions.append(b);
  };
  iconButton("refresh", "Refresh", reload);
  iconButton("link-external", "Open in Browser", () => openUrl(pr.url));
  iconButton("ellipsis", "More Actions", () => more(pr, run));
  // On the pull request's branch, the button says so, or offers to pull when the pull request's head differs.
  if (gitStatus()?.branch !== pr.headRefName) button("Check Out", checkOut);
  else if (headCommit && headCommit !== pr.headRefOid && open)
    button("Pull", () => gitTask(`Pulling ${pr.headRefName}…`, ["pull", "--ff-only"], `Can't pull ${pr.headRefName}`).then((o) => void (o !== undefined && reload())), "", "The pull request's branch on GitHub has commits that yours doesn't, or yours has commits it doesn't. Pull brings in GitHub's, if yours can fast-forward.");
  else {
    const here = button("Checked Out", () => {}, "pr-checked-out", "This is the current branch");
    here.prepend(icon("check"), " ");
  }
  if (open) {
    const m = button("Merge…", () => merge(pr), "primary", pr.isDraft ? "A draft can't be merged. Mark it ready for review first." : "");
    m.disabled = pr.isDraft;
  }
  head.append(titleBox, actions);

  // ---- Section tabs ----
  const failed = (pr.statusCheckRollup ?? []).filter((c) => checkState(c) === "failed").length;
  const tabs = el("div", "segmented pr-tabs");
  tabs.role = "tablist";
  const body = el("div", "pr-section");
  const sections: Record<Section, () => HTMLElement[]> = {
    conversation: () => conversationSection(),
    commits: () => [commitList()],
    checks: () => checksSection(),
    files: () => fileSection(),
  };
  const show = (s: Section) => {
    section = s;
    tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.section === s)));
    body.replaceChildren(...sections[s]());
  };
  const tab = (s: Section, label: string, count: number | string, name: string, alert = false) => {
    const b = el("button");
    b.role = "tab";
    b.title = `${label} (${tabs.childElementCount + 1})`;
    b.dataset.section = s;
    b.append(icon(name), ` ${label} `, el("span", `pr-count${alert ? " alert" : ""}`, String(count)));
    b.onclick = () => show(s);
    tabs.append(b);
  };
  tab("conversation", "Conversation", pr.comments.length + threads.length + pr.reviews.filter((r) => r.body).length, "comment-discussion");
  tab("commits", "Commits", pr.commits.length, "git-commit");
  tab("checks", "Checks", failed || (pr.statusCheckRollup?.length ?? 0), failed ? "error" : "pass", failed > 0);
  tab("files", "Files", pr.files.length, "files");

  // ---- Conversation ----
  function conversationSection(): HTMLElement[] {
    const timeline: { at: string; node: HTMLElement }[] = [];
    // One entry of the timeline: an avatar beside a card with the author, what they did, and when.
    const item = (user: string, content: HTMLElement[], className = "") => {
      const row = el("div", `pr-event ${className}`);
      const card = el("div", "pr-comment");
      card.append(...content);
      row.append(avatar(user, repo, 28), card);
      return row;
    };
    const entry = (author: string, label: string, body: string, at: string, className = "") => {
      const meta = el("div", "pr-meta");
      meta.append(el("strong", "", author), label ? ` ${label}` : "", when(at));
      return item(author, [meta, markdown(body, repo)], className);
    };
    // A comment you can edit or delete when it's yours; it redraws in place while you do.
    const editable = (user: string, body: string, target: Target, at: string, label = "") => {
      const card = el("div", "pr-comment");
      const draw = () => card.replaceChildren(...commentBlock(user, body, target, repo, draw, reload, at, label));
      draw();
      const row = el("div", "pr-event");
      row.append(avatar(user, repo, 28), card);
      return row;
    };
    const verdicts: Record<string, string> = { APPROVED: "approved these changes", CHANGES_REQUESTED: "requested changes", COMMENTED: "reviewed", DISMISSED: "reviewed (dismissed)" };
    for (const r of pr.reviews)
      if (r.state !== "PENDING" && (r.body || r.state !== "COMMENTED")) {
        const kind = r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "changes" : "";
        timeline.push({ at: r.submittedAt, node: r.body ? editable(r.author.login, r.body, reviewTarget(r.id), r.submittedAt, verdicts[r.state] ?? "") : smallEvent(r.author.login, verdicts[r.state] ?? r.state.toLowerCase(), r.submittedAt, kind) });
      }
    for (const c of pr.comments) {
      const id = c.url.match(/#issuecomment-(\d+)$/)?.[1];
      timeline.push({ at: c.createdAt, node: id ? editable(c.author.login, c.body, restTarget(`repos/{owner}/{repo}/issues/comments/${id}`), c.createdAt) : entry(c.author.login, "", c.body, c.createdAt) });
    }
    // Line comment threads, each under a link to its place in the diff.
    for (const t of threads) {
      const box = el("div", `pr-thread-card${t.resolved ? " resolved" : ""}`);
      const where = el("button", "pr-thread-link");
      where.append(icon("file-code"), ` ${t.path}`, el("span", "muted", t.line ? `:${t.start_line && t.start_line !== t.line ? `${t.start_line}–` : ""}${t.line}` : " (outdated)"));
      if (t.resolved) where.append(el("span", "pr-resolved", "Resolved"));
      where.onclick = () => showFileDiff(pr, t.path, threads, t);
      box.append(where);
      if (t.diff_hunk) box.append(hunk(t.diff_hunk));
      const comments = t.comments.map((c) => {
        const card = el("div", "pr-thread-comment");
        const draw = () => card.replaceChildren(...commentBlock(c.user, c.body, restTarget(`repos/{owner}/{repo}/pulls/comments/${c.id}`), repo, draw, reload, c.created_at));
        draw();
        return card;
      });
      // Reply and Resolve, as under a thread in the diff. Reply opens a box in the card.
      const footer = el("div", "pr-thread-footer");
      const link = (label: string, run: () => unknown) => {
        const b = el("button", "link", label);
        b.onclick = run;
        footer.append(b);
      };
      if (t.line || t.node) {
        link(pending?.number === number && t.node ? "Reply (joins your review)" : "Reply", () => {
          const form = el("div", "pr-thread-reply");
          const text = el("textarea");
          text.placeholder = `Reply to ${t.user} (Markdown)`;
          const send = el("button", "primary", "Reply");
          const cancel = el("button", "", "Cancel");
          const buttons = el("div", "pr-actions");
          buttons.append(cancel, send);
          cancel.onclick = () => form.replaceWith(footer);
          send.onclick = async () => {
            if (!text.value.trim()) return text.focus();
            send.disabled = true;
            await replyTo(number, t, text.value.trim()).catch((e) => (showError("Can't reply", e), (send.disabled = false)));
          };
          text.onkeydown = (e) => {
            if (e.key === "Enter" && mod(e)) send.click();
            if (e.key === "Escape") cancel.click();
          };
          form.append(text, buttons);
          footer.replaceWith(form);
          text.focus();
        });
        if (t.node) link(t.resolved ? "Unresolve" : "Resolve", () => setResolved(number, t, !t.resolved));
      }
      // A resolved thread is folded, as on GitHub, until you open it.
      if (t.resolved && !expanded.has(t.id)) {
        const open = el("button", "link pr-thread-more", `Show ${comments.length} resolved ${comments.length === 1 ? "comment" : "comments"}`);
        open.onclick = () => (expanded.add(t.id), open.replaceWith(...comments, footer));
        box.append(open);
      } else box.append(...comments, footer);
      const row = el("div", "pr-event");
      row.append(avatar(t.user, repo, 28), box);
      timeline.push({ at: t.created_at, node: row });
    }
    const time = (at: string) => Date.parse(at) || 0; // A missing date sorts first rather than breaking the order.
    timeline.sort((a, b) => time(a.at) - time(b.at));
    const nodes: HTMLElement[] = [];
    // Your own description has Edit, as a comment does.
    const describe: Target = { key: `body:${number}`, save: (body) => gh("pr", "edit", String(number), "--body", body) };
    const description = pr.author.login === myLogin && pr.body ? editable(pr.author.login, pr.body, describe, pr.createdAt, "opened this pull request") : entry(pr.author.login, "opened this pull request", pr.body || "_No description._", pr.createdAt);
    description.classList.add("description");
    nodes.push(description);
    nodes.push(...timeline.map((t) => t.node));
    if (pr.state === "MERGED") nodes.push(smallEvent("", `Merged into ${pr.baseRefName}`, "", "merged"));
    else if (pr.state === "CLOSED") nodes.push(smallEvent("", "Closed without merging", "", "closed"));
    const list = el("div", "pr-timeline");
    list.append(...nodes);
    return [list, composer()];
  }

  /** A one-line event in the timeline, such as an approval without a comment. */
  function smallEvent(user: string, text: string, at: string, kind: string) {
    const row = el("div", `pr-small-event ${kind}`);
    row.append(icon(kind === "approved" ? "pass-filled" : kind === "changes" ? "request-changes" : kind === "merged" ? "git-merge" : kind === "closed" ? "git-pull-request-closed" : "eye"));
    if (user) row.append(el("strong", "", user), " ");
    row.append(text);
    if (at) row.append(when(at));
    return row;
  }

  /** The comment box, with your pending review's comments above it, kept at the bottom of the conversation. */
  function composer() {
    const hasPending = pending?.number === number;
    const pendingComments = hasPending ? pending!.comments : [];
    const box = el("div", "pr-composer");
    if (pendingComments.length) {
      const list = el("ul", "pr-pending");
      const head = el("li", "pr-pending-head", `Your pending review · ${pendingComments.length} ${pendingComments.length === 1 ? "comment" : "comments"}`);
      list.append(head);
      for (const c of pendingComments) {
        const li = el("li");
        li.append(icon("file-code"), el("span", "name", ltr(`${c.path}:${c.start_line ? `${c.start_line}–` : ""}${c.line}`)), el("span", "muted", c.body.split("\n")[0]));
        li.onclick = () => showFileDiff(pr, c.path, threads, c);
        const remove = el("button", "icon-button codicon codicon-trash");
        remove.title = "Delete this pending comment";
        remove.onclick = (e) => {
          e.stopPropagation();
          deletePending(number, c).then(reload, (err) => showError(`Can't delete the pending comment`, err));
        };
        li.append(remove);
        list.append(li);
      }
      box.append(list);
    }
    const text = el("textarea");
    text.placeholder = hasPending ? "Summarize your review (Markdown, optional)" : "Leave a comment (Markdown)";
    text.setAttribute("aria-label", "Comment");
    text.value = drafts.get(number) ?? "";
    text.oninput = () => drafts.set(number, text.value);
    const buttons = el("div", "pr-actions");
    // With pending comments, each button submits them as one review. Without, Comment adds a comment
    // to the conversation, and Approve and Request Changes submit a review with only the summary.
    const reply = (label: string, event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", needsText: boolean, done: string, primary = false) => {
      const b = el("button", primary ? "primary" : "", label);
      b.onclick = async () => {
        const body = text.value.trim();
        if (needsText && !body && !pendingComments.length) return host.status(`Write a comment first: ${label} needs one.`);
        buttons.querySelectorAll("button").forEach((x) => (x.disabled = true));
        try {
          if (event === "COMMENT" && !hasPending) await gh("pr", "comment", String(number), "--body", body);
          else await submitReview(pr, event, body);
          drafts.delete(number);
          host.status(done);
          reload();
          // The diff on screen showed the comments as pending; they're submitted threads now.
          if (shown?.pr.number === number) (shown.threads = await lineComments(number).catch(() => shown!.threads)), drawZones();
        } catch (e) {
          showError(`Can't ${label.toLowerCase()}`, e);
          buttons.querySelectorAll("button").forEach((x) => (x.disabled = false));
        }
      };
      buttons.append(b);
    };
    // GitHub takes no verdict on your own pull request, only comments.
    if (open && pr.author.login !== myLogin) {
      reply("Request Changes", "REQUEST_CHANGES", true, `Requested changes on #${number}`);
      reply("Approve", "APPROVE", false, `Approved #${number}`);
    }
    reply(hasPending ? `Submit Review (${pendingComments.length})` : "Comment", "COMMENT", true, hasPending ? `Submitted your review on #${number}` : `Commented on #${number}`, true);
    // ⌘⏎ does the main action, as in the diff's comment box.
    text.onkeydown = (e) => e.key === "Enter" && mod(e) && buttons.querySelector<HTMLButtonElement>("button.primary")!.click();
    const hint = el("span", "muted pr-hint", `${isMac ? "⌘" : "Ctrl+"}⏎ to ${hasPending ? "submit" : "comment"}`);
    buttons.prepend(hint);
    box.append(text, buttons);
    return box;
  }

  // ---- Commits ----
  function commitList() {
    const list = el("ul", "pr-rows");
    list.role = "listbox";
    list.ariaLabel = "Commits";
    listNav(list);
    for (const c of pr.commits) {
      const li = el("li");
      li.role = "option";
      li.dataset.key = c.oid;
      li.dataset.label = c.messageHeadline;
      const who = c.authors[0]?.login || c.authors[0]?.name || "";
      const age = when(c.committedDate);
      age.textContent = age.textContent!.replace(/^ · /, "");
      li.append(icon("git-commit", "muted"), el("span", "pr-row-main", c.messageHeadline), el("span", "muted", who), age, el("code", "hash", c.oid.slice(0, 7)));
      li.title = `${c.messageHeadline}\n${new Date(c.committedDate).toLocaleString()}`;
      // The commits come with the pull request's head, which opening the page fetches.
      li.onclick = () => prepareDiff(pr).then(() => showCommitDiff(c.oid), (e) => showError(`Can't fetch #${number}`, e));
      list.append(li);
    }
    return list;
  }

  // ---- Checks ----
  function checksSection() {
    const toolbar = el("div", "pr-section-bar");
    const list = el("ul", "pr-rows pr-checks");
    list.role = "listbox";
    list.ariaLabel = "Checks";
    listNav(list);
    drawChecks(pr, list, toolbar);
    return [toolbar, list];
  }

  // ---- Files ----
  function fileSection() {
    const bar = el("div", "pr-section-bar");
    const progress = el("progress");
    const count = el("span", "muted");
    const countViewed = () => {
      const n = pr.files.filter((f) => viewed.get(f.path)).length;
      progress.max = pr.files.length;
      progress.value = n;
      count.textContent = `${n} of ${pr.files.length} viewed`;
    };
    countViewed();
    const totals = el("span", "pr-totals");
    totals.append(el("span", "added", `+${pr.additions}`), " ", el("span", "deleted", `−${pr.deletions}`));
    bar.append(totals, ...(viewed.size ? [progress, count] : []));
    const unresolved = threads.filter((t) => t.line && !t.resolved);
    if (unresolved.length) {
      const next = el("button", "link", `Go to Unresolved (${unresolved.length})`);
      next.title = "Open the first unresolved thread; each thread's Next Unresolved link goes on from there";
      next.onclick = () => nextUnresolved(pr, threads);
      bar.append(next);
    }
    const files = el("ul", "pr-rows pr-files");
    files.role = "listbox";
    files.ariaLabel = "Files";
    listNav(files);
    const rows = pr.files.map((f) => {
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
      const slash = f.path.lastIndexOf("/");
      const name = el("span", "pr-row-main pr-path");
      name.append(el("span", "dir", ltr(f.path.slice(0, slash + 1))), el("span", "file", f.path.slice(slash + 1)));
      li.append(name);
      const fileThreads = threads.filter((t) => t.path === f.path);
      if (fileThreads.length) {
        const open = fileThreads.filter((t) => !t.resolved).length;
        const comments = el("span", `pr-file-comments${open ? " unresolved" : ""}`);
        comments.append(icon("comment"), ` ${fileThreads.length}`);
        comments.title = `${fileThreads.length} ${fileThreads.length === 1 ? "thread" : "threads"}, ${open} unresolved`;
        li.append(comments);
      }
      li.append(el("span", "added", `+${f.additions}`), el("span", "deleted", `−${f.deletions}`), diffBar(f.additions, f.deletions));
      li.onclick = () => showFileDiff(pr, f.path, threads);
      return { path: f.path, li };
    });
    // Many files group under their folders, as in GitHub's file tree, and a box filters them by path.
    const grouped = pr.files.length > 5;
    files.classList.toggle("grouped", grouped);
    const draw = (query: string) => {
      const q = query.trim().toLowerCase();
      const shown = rows.filter((r) => r.path.toLowerCase().includes(q));
      if (!grouped) return files.replaceChildren(...shown.map((r) => r.li));
      const dirs = new Map<string, HTMLElement[]>();
      for (const r of shown) {
        const dir = r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : "";
        dirs.set(dir, [...(dirs.get(dir) ?? []), r.li]);
      }
      files.replaceChildren(
        ...[...dirs].sort(([a], [b]) => a.localeCompare(b)).flatMap(([dir, lis]) => {
          const head = el("li", "pr-dir");
          head.append(icon("folder", "muted"), el("span", "pr-row-main", ltr(dir || "(root)")), el("span", "muted", String(lis.length)));
          return [head, ...lis];
        }),
      );
      if (!shown.length) files.replaceChildren(el("li", "muted", "No files match."));
    };
    draw("");
    if (pr.files.length > 8) {
      const filter = el("input");
      filter.type = "search";
      filter.placeholder = "Filter files";
      filter.ariaLabel = "Filter files";
      filter.className = "pr-file-filter";
      filter.oninput = () => draw(filter.value);
      filter.onkeydown = (e) => e.key === "ArrowDown" && (e.preventDefault(), files.focus());
      bar.prepend(filter);
    }
    return [bar, files];
  }

  // ---- Side column: status, reviewers, labels ----
  const side = el("aside", "pr-side");
  side.append(statusCard(pr, run, checkOut, (s) => show(s)));
  const sideBlock = (title: string, content: HTMLElement, edit?: () => unknown) => {
    const block = el("section", "pr-side-block");
    const heading = el("h3", "", title);
    if (edit) {
      const b = el("button", "icon-button codicon codicon-gear");
      b.title = `Edit ${title.toLowerCase()}`;
      b.onclick = edit;
      heading.append(b);
    }
    block.append(heading, content);
    side.append(block);
  };
  sideBlock("Reviewers", reviewerList(pr, repo), open ? () => requestReview(pr, run) : undefined);
  sideBlock("Labels", pr.labels.length ? labelRow(pr.labels) : el("div", "muted", "None yet"), () => editLabels(pr, run));

  // ---- Put it together, keeping the scroll position of a refresh ----
  const scroll = page.dataset.shown === String(number) ? page.scrollTop : 0;
  const main = el("div", "pr-main");
  main.append(tabs, body);
  const grid = el("div", "pr-grid");
  grid.append(main, side);
  page.replaceChildren(head, grid);
  page.dataset.shown = String(number);
  // Keys while the tab has focus and you aren't typing: 1–4 switch sections, R refreshes, C goes to the comment
  // box, and O opens the pull request in the browser.
  page.tabIndex = -1;
  page.onkeydown = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
    const order: Section[] = ["conversation", "commits", "checks", "files"];
    const key = e.key.toLowerCase();
    if (/^[1-4]$/.test(key)) show(order[Number(key) - 1]);
    else if (key === "r") reload();
    else if (key === "o") openUrl(pr.url);
    else if (key === "c") {
      if (section !== "conversation") show("conversation");
      page.querySelector<HTMLTextAreaElement>(".pr-composer textarea")?.focus();
    } else return;
    e.preventDefault();
  };
  show(section);
  page.scrollTop = scroll;
  watchPullRequest(pr);
  // Fetch the head and base now, so opening a file's diff doesn't wait for the network.
  prepareDiff(pr).catch(() => {});
}

/** The last lines of the diff a thread is on, as GitHub shows above a review comment. */
function hunk(text: string) {
  const pre = el("pre", "pr-hunk");
  // ponytail: the last 4 lines, the ones the comment is on; the diff has the rest.
  const lines = text.split("\n").filter((l) => !l.startsWith("@@")).slice(-4);
  pre.append(...lines.map((l) => el("div", l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "", l || " ")));
  return pre;
}

/** A small bar of added and removed lines, as in GitHub's file list. */
function diffBar(added: number, removed: number) {
  const bar = el("span", "pr-diffbar");
  const total = added + removed || 1;
  for (let i = 0; i < 5; i++) bar.append(el("span", i < Math.round((added / total) * 5) ? "a" : i < Math.round(((added + removed) / total) * 5) ? "d" : ""));
  return bar;
}

/**
 * What stands between the pull request and merging, as GitHub's merge box shows it: checks, reviews, and
 * mergeability, each with the button that deals with it.
 */
function statusCard(pr: Details, run: (progress: string, args: string[], done: string, error: string) => unknown, checkOut: () => unknown, show: (s: Section) => void) {
  const card = el("section", "pr-status");
  const n = String(pr.number);
  const line = (kind: "good" | "warn" | "bad" | "info", iconName: string, text: string, detail = "", button?: [string, () => unknown]) => {
    const row = el("div", `pr-status-line ${kind}`);
    const words = el("div", "pr-status-text");
    words.append(el("strong", "", text));
    if (detail) words.append(el("div", "muted", detail));
    row.append(icon(iconName), words);
    if (button) {
      const b = el("button", "", button[0]);
      b.onclick = button[1];
      // A short line keeps its button beside it; one with a detail puts it under the text.
      (detail ? words : row).append(b);
    }
    card.append(row);
  };
  if (pr.state === "MERGED") return line("info", "git-merge", `Merged into ${pr.baseRefName}`), card;
  if (pr.state === "CLOSED") return line("bad", "git-pull-request-closed", "Closed without merging", "", ["Reopen", () => run(`Reopening #${n}…`, ["pr", "reopen", n], `Reopened #${n}`, `Can't reopen #${n}`)]), card;
  const checks = pr.statusCheckRollup ?? [];
  const count = (s: string) => checks.filter((c) => checkState(c) === s).length;
  const summary = checksSummary(checks);
  const view: [string, () => unknown] = ["Details", () => show("checks")];
  if (summary === "failed") line("bad", "error", `${count("failed")} failing ${count("failed") === 1 ? "check" : "checks"}`, `${count("passed")} passed${count("pending") ? `, ${count("pending")} running` : ""}`, view);
  else if (summary === "pending") line("warn", "loading codicon-modifier-spin", `${count("pending")} ${count("pending") === 1 ? "check" : "checks"} running`, `${count("passed")} passed`, view);
  else if (summary === "passed" || summary === "skipped") line("good", "pass-filled", "All checks have passed", `${checks.length} ${checks.length === 1 ? "check" : "checks"}`, view);
  if (pr.reviewDecision === "APPROVED") line("good", "pass-filled", "Approved");
  else if (pr.reviewDecision === "CHANGES_REQUESTED") line("bad", "request-changes", "Changes requested");
  else if (pr.reviewDecision === "REVIEW_REQUIRED") line("warn", "eye", "Review required", "An approving review is needed to merge.");
  if (pr.isDraft) line("info", "git-pull-request-draft", "Draft", "Reviewers aren't asked yet, and it can't be merged.", ["Ready for Review", () => run(`Marking #${n} ready…`, ["pr", "ready", n], `Marked #${n} ready for review`, `Can't mark #${n} ready`)]);
  else if (pr.mergeable === "CONFLICTING") line("bad", "warning", `Conflicts with ${pr.baseRefName}`, `Check out the branch and merge ${pr.baseRefName} into it to resolve them.`, ["Check Out", checkOut]);
  else if (pr.mergeStateStatus === "BEHIND") line("warn", "arrow-down", `Behind ${pr.baseRefName}`, "The base branch has commits this branch doesn't.", ["Update Branch", () => updateBranch(pr, run)]);
  else if (pr.autoMergeRequest) line("good", "clock", "Auto-merge is on", `It merges (${pr.autoMergeRequest.mergeMethod.toLowerCase()}) once checks and reviews pass.`, ["Turn Off", () => run(`Turning off auto-merge…`, ["pr", "merge", n, "--disable-auto"], `Turned off auto-merge for #${n}`, "Can't turn off auto-merge")]);
  else if (pr.mergeStateStatus === "CLEAN" || pr.mergeStateStatus === "UNSTABLE" || pr.mergeStateStatus === "HAS_HOOKS") line("good", "check", "Ready to merge", pr.mergeStateStatus !== "UNSTABLE" ? "" : summary === "pending" ? "Checks that aren't required are still running." : "Checks that aren't required are failing.");
  else if (pr.mergeStateStatus === "BLOCKED") line("warn", "lock", "Merging is blocked", "A required review, check, or rule isn't met yet.");
  else line("info", "loading codicon-modifier-spin", "Checking whether it can merge…", "Refresh in a moment.");
  return card;
}

/** Labels as colored chips, in GitHub's colors. */
function labelRow(labels: Label[]) {
  const row = el("div", "pr-labels");
  row.append(...labels.map(labelChip));
  return row;
}

function labelChip(l: Label) {
  const chip = el("span", "pr-label", l.name);
  chip.style.setProperty("--label", `#${l.color}`);
  return chip;
}

/** Who reviewed and how, and who's still asked to. */
function reviewerList(pr: Details, repo: string) {
  const list = el("ul", "pr-reviewer-list");
  const marks: Record<string, [string, string, string]> = {
    APPROVED: ["pass-filled", "checks-passed", "Approved"],
    CHANGES_REQUESTED: ["request-changes", "checks-failed", "Changes requested"],
    COMMENTED: ["comment", "muted", "Commented"],
    DISMISSED: ["circle-slash", "muted", "Dismissed"],
  };
  const person = (login: string, mark: [string, string, string]) => {
    const li = el("li");
    const state = icon(mark[0], mark[1]);
    state.title = mark[2];
    li.append(avatar(login, repo), el("span", "pr-row-main", login), state);
    list.append(li);
  };
  for (const r of pr.latestReviews) person(r.author.login, marks[r.state] ?? ["circle-outline", "muted", r.state]);
  for (const r of pr.reviewRequests) person(r.login ?? r.name ?? r.slug ?? "", ["circle-filled", "checks-pending", "Review requested"]);
  if (!list.childElementCount) return el("div", "muted", "No reviews yet");
  return list;
}

/** Workflows whose checks you opened, by pull request and workflow name; a workflow that all passed is folded. */
const unfolded = new Set<string>();

/**
 * Draws the checks grouped by workflow, the groups with failures first, each check with how long it ran, a log
 * button on failed GitHub Actions jobs, and Re-run Failed in the bar. A workflow whose checks all passed or were
 * skipped folds into its heading until you open it.
 */
function drawChecks(pr: Details, list: HTMLElement, bar: HTMLElement) {
  const sorted = sortChecks(pr.statusCheckRollup ?? []);
  const counts = { failed: 0, pending: 0, passed: 0, skipped: 0 };
  sorted.forEach((c) => counts[checkState(c)]++);
  bar.replaceChildren();
  for (const [state, label] of [["failed", "failed"], ["pending", "running"], ["passed", "passed"], ["skipped", "skipped"]] as const)
    if (counts[state]) {
      const part = el("span", "pr-check-count");
      part.append(checkIcon(state), ` ${counts[state]} ${label}`);
      bar.append(part);
    }
  if (!sorted.length) bar.append(el("span", "muted", "No checks"));
  const failedRuns = [...new Set(sorted.filter((c) => checkState(c) === "failed").map((c) => actionsJob(c.detailsUrl)?.run).filter((r): r is string => !!r))];
  if (failedRuns.length) {
    const rerun = el("button", "", "Re-run Failed");
    rerun.title = "Run the failed GitHub Actions jobs again";
    rerun.onclick = async () => {
      rerun.disabled = true;
      for (const id of failedRuns) if ((await withProgress(`Re-running the failed jobs…`, () => gh("run", "rerun", id, "--failed"), { error: "Can't re-run the failed jobs" })) === undefined) return;
      host.status(`Re-running the failed jobs of #${pr.number}.`);
      renderPullRequest(pr.number);
    };
    bar.append(rerun);
  }
  const row = (c: Check) => {
    const state = checkState(c);
    const li = el("li", "pr-check");
    li.role = "option";
    const name = c.name ?? c.context ?? "";
    li.dataset.key = name;
    li.title = name;
    li.append(checkIcon(state), el("span", "pr-row-main", name));
    const took = checkDuration(c);
    if (took) li.append(el("span", "pr-when", state === "pending" ? `running ${took}` : took));
    const job = actionsJob(c.detailsUrl);
    if (job && state === "failed") {
      const log = el("button", "icon-button codicon codicon-output");
      log.title = "View Log: the failed steps, with file paths that open in the editor";
      log.onclick = (e) => (e.stopPropagation(), showLog(name, job.job));
      li.append(log);
    }
    const url = c.detailsUrl ?? c.targetUrl;
    if (url) {
      const out = el("button", "icon-button codicon codicon-link-external");
      out.title = "Open in Browser";
      out.onclick = (e) => (e.stopPropagation(), openUrl(url));
      li.append(out);
      li.onclick = () => (job && state === "failed" ? showLog(name, job.job) : openUrl(url));
    }
    return li;
  };
  // Checks by workflow; commit statuses, such as a CI service's, have none.
  const groups = new Map<string, Check[]>();
  for (const c of sorted) {
    const key = c.workflowName || (c.context ? "Commit statuses" : "Other checks");
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  if (groups.size < 2) return list.replaceChildren(...sorted.map(row));
  const rows: HTMLElement[] = [];
  // The order of `sorted` already puts the group with the first failure first.
  for (const [name, checks] of groups) {
    const state = checksSummary(checks);
    const key = `${pr.number}:${name}`;
    const open = state === "failed" || state === "pending" || unfolded.has(key);
    const head = el("li", "pr-check-group");
    head.role = "option";
    head.dataset.key = name;
    const n = (s: string) => checks.filter((c) => checkState(c) === s).length;
    const parts = [n("failed") && `${n("failed")} failed`, n("pending") && `${n("pending")} running`, n("passed") && `${n("passed")} passed`, n("skipped") && `${n("skipped")} skipped`].filter(Boolean);
    head.append(icon(open ? "chevron-down" : "chevron-right", "muted"), checkIcon(state), el("span", "pr-row-main", name), el("span", "muted", parts.join(", ")));
    head.onclick = () => (unfolded.has(key) ? unfolded.delete(key) : unfolded.add(key), drawChecks(pr, list, bar));
    // A workflow with failures stays open; its heading folds nothing.
    if (state === "failed" || state === "pending") head.onclick = null;
    rows.push(head);
    if (open) rows.push(...checks.map(row));
  }
  list.replaceChildren(...rows);
}

/**
 * While checks run, GitHub is still working out whether it can merge, or the pull request is under two minutes old
 * (before GitHub has queued its checks), looks at them every 15 seconds and redraws the tab when they or the merge state change, so the
 * checks, the status box, and the tab counts stay current. A hidden tab, or one where you're typing or editing a
 * comment, waits for the next tick. It stops once the tab shows another pull request or a newer version of this one.
 */
function watchPullRequest(pr: Details) {
  const settling = checksSummary(pr.statusCheckRollup) === "pending" || pr.mergeStateStatus === "UNKNOWN" || Date.now() - Date.parse(pr.createdAt) < 120_000;
  if (!settling || pr.state !== "OPEN") return;
  const page = $("pr-detail");
  const drawn = page.firstElementChild;
  const current = () => openNumber === pr.number && page.dataset.number === String(pr.number) && page.firstElementChild === drawn;
  const key = (p: Pick<Details, "statusCheckRollup" | "mergeStateStatus">) => JSON.stringify([p.mergeStateStatus, (p.statusCheckRollup ?? []).map(checkState)]);
  const before = key(pr);
  setTimeout(async function tick() {
    if (!current()) return;
    const busy = page.hidden || !!page.closest("[hidden]") || editing !== "" || page.contains(document.activeElement) && document.activeElement instanceof HTMLTextAreaElement;
    if (!busy) {
      try {
        const now = JSON.parse(await gh("pr", "view", String(pr.number), "--json", "statusCheckRollup,mergeStateStatus"));
        if (!current()) return;
        if (key(now) !== before) {
          if (checksSummary(now.statusCheckRollup) !== "pending") updateBranchPullRequest();
          return renderPullRequest(pr.number);
        }
        // Nothing changed, and nothing is left to wait for.
        if (checksSummary(now.statusCheckRollup) !== "pending" && now.mergeStateStatus !== "UNKNOWN" && Date.now() - Date.parse(pr.createdAt) >= 120_000) return;
      } catch {
        // Tried again on the next tick.
      }
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
    if (!logins.length) return [{ label: "No one else in the repository can review", run: () => {} }];
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

// gh's --paginate follows $endCursor through every page of files.
const VIEWED = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { files(first: 100, after: $endCursor) { nodes { path viewerViewedState } pageInfo { hasNextPage endCursor } } } }
}`;

/** The Viewed states of the pull request open in its tab, shared with its diff's Viewed checkbox. */
let viewedOf: { number: number; files: Map<string, boolean> } | undefined;

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
  const jq = ".[] | {id, path, line, start_line, side, body, user: .user.login, in_reply_to_id, created_at, diff_hunk}";
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
async function setResolved(number: number, t: Thread, resolved: boolean) {
  const mutation = resolved ? "resolveReviewThread" : "unresolveReviewThread";
  try {
    await gh("api", "graphql", "-f", `query=mutation($id: ID!) { ${mutation}(input: { threadId: $id }) { thread { isResolved } } }`, "-f", `id=${t.node}`);
    await threadsChanged(number);
  } catch (e) {
    showError(`Can't ${resolved ? "resolve" : "reopen"} the thread`, e);
  }
}

/** Redraws the threads wherever the pull request shows them: its diff and its tab. */
async function threadsChanged(number: number) {
  if (shown?.pr.number === number) (shown.threads = await lineComments(number).catch(() => shown!.threads)), drawZones();
  if (branchThreads?.number === number) {
    branchThreads.threads = await lineComments(number).catch(() => branchThreads!.threads);
    for (const model of monaco.editor.getModels()) decorateComments(model);
  }
  if (openNumber === number) renderPullRequest(number);
}

/**
 * Replies to a thread. With a pending review, GitHub takes no comment outside it, so the reply joins the review, as
 * on GitHub; otherwise it posts at once.
 */
async function replyTo(number: number, t: Thread, body: string) {
  if (pending?.number === number && t.node) {
    await gh("api", "graphql", "-f", "query=mutation($review: ID!, $thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewId: $review, pullRequestReviewThreadId: $thread, body: $body }) { comment { id } } }", "-f", `review=${pending.node}`, "-f", `thread=${t.node}`, "-f", `body=${body}`);
    await loadPending(number);
    host.status("Added the reply to your pending review.");
  } else {
    await gh("api", "--method", "POST", `repos/{owner}/{repo}/pulls/${number}/comments/${t.id}/replies`, "-f", `body=${body}`);
    host.status(`Replied to ${t.user}.`);
  }
  await threadsChanged(number);
}

/** Resolved threads you opened with Show, by thread ID. */
const expanded = new Set<number>();

/** Asks how to merge, confirms, and merges on GitHub. */
/** The merge methods the repository allows, read once per project. */
let mergeSettings: { root: string; allowed: Promise<Record<string, boolean>> } | undefined;
const lastMethodKey = () => `pr-merge-method:${host.root()}`;

async function merge(pr: Details) {
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
          renderPullRequest(pr.number);
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
  const label = `#${pr.number}: ${pr.baseRefName} ↔ ${pr.headRefName}`;
  const viewed = viewedOf?.number === pr.number ? viewedOf.files : undefined;
  const files: DiffFile[] = pr.files.map((f, i) => ({
    path: f.path,
    status: viewed?.get(f.path) ? "✓" : "",
    load: async (): Promise<[string, string]> => ["", ""],
    show: () => showOneDiff(pr, f.path, threads, f.path === path ? at : undefined),
    // GitHub's Viewed checkbox for the file; checking it moves on to the next file you haven't viewed.
    extra: viewed?.has(f.path)
      ? () => {
          const box = el("input");
          box.type = "checkbox";
          box.checked = !!viewed.get(f.path);
          const toggle = el("label", "diff-viewed");
          toggle.title = "Mark the file as viewed on GitHub, and go to the next file you haven't viewed";
          toggle.append(box, " Viewed");
          box.onchange = async () => {
            try {
              await setViewed(pr.id, f.path, box.checked);
            } catch (e) {
              box.checked = !box.checked;
              return showError("Can't change the file's Viewed state", e);
            }
            viewed.set(f.path, box.checked);
            files[i].status = box.checked ? "✓" : "";
            if (openNumber === pr.number) renderPullRequest(pr.number);
            if (!box.checked) return;
            const next = [...files.keys()].map((k) => (i + 1 + k) % files.length).find((k) => !viewed.get(files[k].path));
            if (next === undefined) host.status(`You've viewed all ${files.length} files of #${pr.number}.`);
            else showDiffs(files, label, next);
          };
          return toggle;
        }
      : undefined,
  }));
  return showDiffs(files, label, Math.max(0, files.findIndex((f) => f.path === path)));
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

// ponytail: the first 100 pending comments and threads; a review with more shows the rest without their side.
const PENDING = `query($id: ID!) { node(id: $id) { ... on PullRequestReview {
  comments(first: 100) { nodes { databaseId path line startLine originalLine body author { login } createdAt replyTo { databaseId } } }
  pullRequest { reviewThreads(first: 100) { nodes { diffSide comments(first: 100) { nodes { databaseId } } } } }
} } }`;

async function readPending(number: number): Promise<Pending | null> {
  const found = (await gh("api", `repos/{owner}/{repo}/pulls/${number}/reviews`, "--paginate", "--jq", '.[] | select(.state == "PENDING") | {id, node: .node_id}')).trim();
  if (!found) return (pending = null);
  const { id, node } = JSON.parse(found.split("\n")[0]);
  // REST lists a pending comment with only its diff position, no line, so its lines come from GraphQL, and its
  // side from its thread.
  const jq = `.data.node as $r | ($r.pullRequest.reviewThreads.nodes | map(.diffSide as $s | .comments.nodes[] | {key: (.databaseId | tostring), value: $s}) | from_entries) as $sides
    | $r.comments.nodes[] | {id: .databaseId, path, line: (.line // .originalLine), start_line: .startLine, side: ($sides[.databaseId | tostring] // "RIGHT"), body, user: .author.login, in_reply_to_id: .replyTo.databaseId, created_at: .createdAt}`;
  const out = await gh("api", "graphql", "-f", `query=${PENDING}`, "-f", `id=${node}`, "--jq", jq);
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
      if (t.node) action(actions, t.resolved ? "Unresolve" : "Resolve", () => setResolved(pr.number, t, !t.resolved));
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
  if (f.reply) {
    const thread = f.reply;
    button(inReview && thread.node ? "Add Reply to Review" : "Reply", (body) => {
      form = undefined;
      return replyTo(pr.number, thread, body).catch((e) => showError(`Can't reply`, e));
    }, true);
  }
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
    await threadsChanged(pr.number);
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
    button.onclick = () => showPullRequest(pr.number, pr.title);
    button.hidden = false;
    branchThreads = { number: pr.number, threads: await lineComments(pr.number) };
  } catch {
    // No pull request for this branch, or no GitHub remote.
    branchThreads = undefined;
  }
  for (const model of monaco.editor.getModels()) decorateComments(model);
}

// ---- Comments in the editor ----

/** The line threads of the checked-out branch's pull request, which its files show in the editor. */
let branchThreads: { number: number; threads: Thread[] } | undefined;
const commentDecorations = new Map<monaco.editor.ITextModel, string[]>();

/**
 * Shows the pull request's threads on the checked-out branch's files, where you fix what they ask: a comment icon
 * in the gutter, the latest comment after an unresolved thread's line, and the whole thread on hover, with a link
 * that opens it in the pull request's diff. The lines are the pull request's; local edits after loading move them
 * along, but commits that aren't pushed yet can put them a few lines off.
 */
function decorateComments(model: monaco.editor.ITextModel) {
  if (model.isDisposed() || model.uri.scheme !== "file") return;
  const root = host.root();
  const path = model.uri.fsPath.startsWith(`${root}/`) ? model.uri.fsPath.slice(root.length + 1) : "";
  const threads = branchThreads?.threads.filter((t) => t.path === path && t.side === "RIGHT" && t.line && t.line <= model.getLineCount()) ?? [];
  const number = branchThreads?.number;
  const ids = model.deltaDecorations(
    commentDecorations.get(model) ?? [],
    threads.map((t) => {
      const last = t.comments[t.comments.length - 1];
      const hover = t.comments.map((c) => `**${c.user}** · ${ago(c.created_at)}\n\n${c.body}`).join("\n\n---\n\n");
      const link = `[Open in #${number}](command:tusk.prs.openThread?${encodeURIComponent(JSON.stringify([number, t.id]))})`;
      const firstLine = last.body.replace(/```[\s\S]*?```/g, "(suggestion)").split("\n").find((l) => l.trim()) ?? "";
      return {
        range: new monaco.Range(t.line!, 1, t.line!, 1),
        options: {
          glyphMarginClassName: `codicon codicon-comment${t.resolved ? "" : "-unresolved"} pr-glyph${t.resolved ? " resolved" : ""}`,
          glyphMargin: { position: monaco.editor.GlyphMarginLane.Right },
          glyphMarginHoverMessage: { value: `${t.resolved ? "_Resolved_\n\n" : ""}${hover}\n\n${link}`, isTrusted: true, supportHtml: false },
          // The latest word on an open thread, after its line, as an editor shows review comments inline.
          ...(t.resolved ? {} : { isWholeLine: true, className: "pr-comment-line", after: { content: `   ${last.user}: ${firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine}`, inlineClassName: "pr-inline-comment" } }),
          stickiness: 1,
        },
      };
    }),
  );
  commentDecorations.set(model, ids);
}

/** "3 hours ago", for a comment's date in a hover. */
function ago(at: string) {
  const time = Date.parse(at) / 1000;
  return Number.isNaN(time) ? "" : age(time) === "now" ? "just now" : `${age(time)} ago`;
}

/** Opens a thread from the editor in its pull request's diff. */
async function openThread(number: number, id: number) {
  const t = branchThreads?.number === number ? branchThreads.threads.find((x) => x.id === id) : undefined;
  if (!t) return;
  const pr = await withProgress(`Opening #${number}…`, async () => JSON.parse(await gh("pr", "view", String(number), "--json", DETAIL_FIELDS)) as Details, { error: `Can't open #${number}` });
  if (pr) showFileDiff(pr, t.path, branchThreads!.threads, t);
}

monaco.editor.onDidCreateModel((model) => {
  decorateComments(model);
  model.onWillDispose(() => commentDecorations.delete(model));
});
monaco.editor.registerCommand("tusk.prs.openThread", (_, number: number, id: number) => openThread(number, id));
// A click on a thread's icon opens it, rather than adding a breakpoint there.
monaco.editor.onDidCreateEditor((editor) =>
  editor.onMouseDown((e) => {
    if (!e.event.leftButton || !e.target.element?.classList.contains("pr-glyph")) return;
    const line = e.target.position?.lineNumber;
    const model = editor.getModel();
    const id = line && model ? model.getLineDecorations(line).find((d) => commentDecorations.get(model)?.includes(d.id)) : undefined;
    const t = id && branchThreads?.threads.find((x) => x.line === line && model!.uri.fsPath.endsWith(`/${x.path}`));
    if (t && branchThreads) openThread(branchThreads.number, t.id);
  }),
);

// ---- Creating a pull request ----

let createPage: HTMLElement | undefined;

/**
 * Opens a form for a pull request from the current branch, in an editor tab: the base branch, a title from the
 * commits or branch name, a body from the repository's template or the commits' subjects, and the commits it
 * would add. Creating pushes the branch first when the remote doesn't have its commits.
 */
export async function createPullRequest() {
  const branch = gitStatus()?.branch;
  if (!branch || branch.startsWith("HEAD")) return showError("Switch to a branch first: a pull request needs one to merge from.");
  const page = (createPage ??= el("div", "pr-create"));
  page.replaceChildren(el("p", "muted pr-loading", "Loading…"));
  showEditorView("New Pull Request", page, "git-pull-request-create", () => {});
  page.hidden = false;
  let base: string;
  let branches: string[];
  try {
    const [existing, repo, remote] = await Promise.all([
      gh("pr", "view", branch, "--json", "number,title,state").then((o) => JSON.parse(o) as { number: number; title: string; state: string }, () => null),
      gh("repo", "view", "--json", "defaultBranchRef").then((o) => JSON.parse(o) as { defaultBranchRef: { name: string } }),
      git("for-each-ref", "--format=%(refname:lstrip=3)", "refs/remotes/origin"),
    ]);
    if (existing?.state === "OPEN") {
      const open = el("button", "primary", `Open #${existing.number}`);
      open.onclick = () => showPullRequest(existing.number, existing.title);
      const note = el("div", "pr-create-note");
      note.append(el("p", "", `${branch} already has an open pull request: #${existing.number} ${existing.title}.`), open);
      return page.replaceChildren(note);
    }
    base = repo.defaultBranchRef.name;
    branches = remote.split("\n").filter((b) => b && b !== "HEAD" && b !== branch);
    if (!branches.includes(base)) branches.unshift(base);
  } catch (e) {
    const list = el("ul", "pr-checks");
    list.append(problemItem("Can't start a pull request", e, createPullRequest));
    return page.replaceChildren(list);
  }

  const form = el("form", "pr-create-form");
  const heading = el("h1", "", "New pull request");
  const sub = el("div", "pr-sub");
  const baseSelect = el("select");
  baseSelect.ariaLabel = "Base branch";
  for (const b of branches) baseSelect.append(new Option(b, b, false, b === base));
  sub.append("Merge ", el("code", "pr-branch", branch), " into ", baseSelect);
  const title = el("input");
  title.placeholder = "Title";
  title.ariaLabel = "Title";
  title.required = true;
  const body = el("textarea");
  body.placeholder = "Description (Markdown)";
  body.ariaLabel = "Description";
  const draft = el("input");
  draft.type = "checkbox";
  const draftLabel = el("label", "pr-create-draft");
  draftLabel.append(draft, " Create as a draft");
  const create = el("button", "primary", "Create Pull Request");
  create.type = "submit";
  draft.onchange = () => (create.textContent = draft.checked ? "Create Draft" : "Create Pull Request");
  const buttons = el("div", "pr-actions");
  buttons.append(draftLabel, create);
  const commits = el("ul", "pr-rows");
  const commitsHeading = el("h3");
  // The repository's template, if it has one, is where a description starts, as on GitHub.
  const template = await Promise.any(
    [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md", "pull_request_template.md"].map((f) => invoke<string>("read_file", { path: `${host.root()}/${f}` })),
  ).catch(() => "");
  let touched = false;
  title.oninput = body.oninput = () => (touched = true);
  // What the branch adds to the base: its commits, which also suggest the title and description.
  const fill = async () => {
    const target = baseSelect.value;
    const log = await git("log", "--format=%h%x1f%s%x1f%an%x1f%at", `refs/remotes/origin/${target}..HEAD`, "--").catch(() => "");
    const list = log.split("\n").filter(Boolean).map((l) => l.split("\x1f"));
    commitsHeading.textContent = `${list.length} ${list.length === 1 ? "commit" : "commits"} into ${target}`;
    commits.replaceChildren(
      ...(list.length ? list : [["", "No commits between the branches yet."]]).map(([hash, subject, author, at]) => {
        const li = el("li");
        li.append(icon("git-commit", "muted"), el("span", "pr-row-main", subject), el("span", "muted", author ?? ""), el("span", "pr-when", at ? (age(Number(at)) === "now" ? "just now" : `${age(Number(at))} ago`) : ""), el("code", "hash", hash));
        return li;
      }),
    );
    if (touched) return;
    // One commit names the pull request; several fall back to the branch's name, as GitHub does.
    title.value = list.length === 1 ? list[0][1] : branch.replace(/^[\w-]+\//, "").replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
    body.value = template || (list.length > 1 ? list.map(([, subject]) => `- ${subject}`).reverse().join("\n") : "");
  };
  baseSelect.onchange = fill;
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!title.value.trim()) return title.focus();
    create.disabled = true;
    try {
      // gh can't push for you without asking, so the branch goes up first, through the dialog for passwords.
      const s = gitStatus();
      if (!s?.upstream || s.ahead > 0) {
        if ((await gitTask(`Pushing ${branch}…`, ["push", "-u", "origin", "HEAD"], `Can't push ${branch}`)) === undefined) return;
      }
      const url = await withProgress(
        "Creating the pull request…",
        () => gh("pr", "create", "--base", baseSelect.value, "--head", branch, "--title", title.value.trim(), "--body", body.value, ...(draft.checked ? ["--draft"] : [])),
        { error: "Can't create the pull request" },
      );
      if (url === undefined) return;
      const number = Number(url.trim().match(/\/pull\/(\d+)/)?.[1]);
      host.status(`Created #${number}`);
      closeView(page);
      updateBranchPullRequest();
      loadPullRequests();
      if (number) showPullRequest(number, title.value.trim());
    } finally {
      create.disabled = false;
    }
  };
  body.onkeydown = title.onkeydown = (e) => e.key === "Enter" && mod(e) && form.requestSubmit();
  form.append(heading, sub, title, body, buttons, commitsHeading, commits);
  page.replaceChildren(form);
  await fill();
  title.focus();
  title.select();
}

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
  $("pr-refresh").onclick = loadPullRequests;
  $("pr-create").onclick = createPullRequest;
}
