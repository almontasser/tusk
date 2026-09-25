// Pull requests through the GitHub CLI (`gh`): list, details, checks, reviews, line comments, and diffs.
import { invoke } from "@tauri-apps/api/core";
import type { monaco } from "./editor";
import { diffCursor, git, showDiff } from "./git";
import { type Check, checkState, checksSummary } from "./gitparse";
import { pick } from "./palette";
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
  comments: { author: Author; body: string }[];
  reviews: { author: Author; state: string; body: string }[];
};

/** A comment on a line of the diff. `line` is null when the code it was on has changed since. */
type ReviewComment = { id: number; path: string; line: number | null; side: "LEFT" | "RIGHT"; body: string; user: string; in_reply_to_id: number | null };
/** A line comment and its replies. */
type Thread = ReviewComment & { comments: ReviewComment[] };

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
  div.innerHTML = DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form", "button", "iframe"], FORBID_ATTR: ["style"] });
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
  for (const a of div.querySelectorAll("a")) {
    a.onclick = (e) => {
      e.preventDefault();
      if (/^https?:/.test(a.href)) openUrl(a.href);
    };
  }
  return div;
}

// ---- List ----

export async function loadPullRequests() {
  if (!host.root()) return;
  const filter = ($("pr-filter") as HTMLSelectElement).value;
  const args = { open: [], mine: ["--author", "@me"], review: ["--search", "review-requested:@me"] }[filter] ?? [];
  $("pr-detail").hidden = true;
  $("pr-list-view").hidden = false;
  $("pr-list").replaceChildren(el("li", "muted", "Loading…"));
  try {
    const prs: PullRequest[] = JSON.parse(await gh("pr", "list", "--limit", "50", "--json", FIELDS, ...args));
    $("pr-list").replaceChildren(...(prs.length ? prs.map(prRow) : [el("li", "muted", "No pull requests.")]));
  } catch (e) {
    $("pr-list").replaceChildren(el("li", "muted", `Can't list pull requests: ${String(e).trim()}`));
  }
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
  detail.replaceChildren(el("p", "muted", "Loading…"));
  let pr: Details;
  let threads: Thread[];
  try {
    [pr, threads] = await Promise.all([
      gh("pr", "view", String(number), "--json", `${FIELDS},body,headRefOid,state,files,comments,reviews`).then(JSON.parse),
      lineComments(number),
    ]);
  } catch (e) {
    detail.replaceChildren(el("p", "muted", `Can't load #${number}: ${String(e).trim()}`));
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
    li.append(el("span", "name", f.path), el("span", "added", `+${f.additions}`), el("span", "deleted", `−${f.deletions}`));
    const count = threads.filter((t) => t.path === f.path).length;
    if (count) li.append(el("span", "codicon codicon-comment", ` ${count}`));
    li.onclick = () => showFileDiff(pr, f.path, threads);
    files.append(li);
  }

  const repo = repoUrl(pr);
  const conversation = el("div", "pr-conversation");
  const entry = (author: string, label: string, body: string) => {
    const item = el("div", "pr-comment");
    item.append(el("div", "pr-meta", `${author}${label ? ` · ${label}` : ""}`), markdown(body, repo));
    conversation.append(item);
  };
  if (pr.body) entry(pr.author.login, "description", pr.body);
  for (const r of pr.reviews) if (r.body || r.state !== "COMMENTED") entry(r.author.login, reviews[r.state] ?? r.state.toLowerCase(), r.body);
  for (const c of pr.comments) entry(c.author.login, "", c.body);
  // Line comments, each thread under a link to its place in the diff.
  for (const t of threads) {
    const where = el("button", "link pr-thread-link", `${t.path}${t.line ? `:${t.line}` : " (outdated)"}`);
    where.onclick = () => showFileDiff(pr, t.path, threads, t);
    conversation.append(where);
    for (const c of t.comments) entry(c.user, "", c.body);
  }

  const heading = (text: string) => el("h3", "", text);
  const review = el("div", "pr-review");
  const box = el("textarea");
  box.placeholder = "Leave a comment (Markdown)";
  box.setAttribute("aria-label", "Comment");
  const buttons = el("div", "pr-actions");
  const reply = (label: string, args: string[], needsText: boolean, done: string) => {
    const b = el("button", "", label);
    b.onclick = async () => {
      const body = box.value.trim();
      if (needsText && !body) return host.status(`Write a comment first: ${label} needs one.`);
      buttons.querySelectorAll("button").forEach((x) => (x.disabled = true));
      try {
        await gh(...args, String(number), ...(body ? ["--body", body] : []));
        host.status(done);
        showPullRequest(number);
      } catch (e) {
        host.status(`Can't ${label.toLowerCase()}: ${String(e).trim()}`);
        buttons.querySelectorAll("button").forEach((x) => (x.disabled = false));
      }
    };
    buttons.append(b);
  };
  reply("Comment", ["pr", "comment"], true, `Commented on #${number}`);
  if (pr.state === "OPEN") {
    reply("Approve", ["pr", "review", "--approve"], false, `Approved #${number}`);
    reply("Request Changes", ["pr", "review", "--request-changes"], true, `Requested changes on #${number}`);
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
    review,
  );
}

const repoUrl = (pr: PullRequest) => pr.url.replace(/\/pull\/\d+$/, "");

/** The pull request's line comments, grouped into threads. GitHub points every reply at the thread's first comment. */
async function lineComments(number: number): Promise<Thread[]> {
  const jq = ".[] | {id, path, line, side, body, user: .user.login, in_reply_to_id}";
  const out = await gh("api", "--paginate", `repos/{owner}/{repo}/pulls/${number}/comments`, "--jq", jq);
  const comments: ReviewComment[] = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const threads = new Map<number, Thread>();
  for (const c of comments) if (!c.in_reply_to_id) threads.set(c.id, { ...c, comments: [c] });
  for (const c of comments) if (c.in_reply_to_id) threads.get(c.in_reply_to_id)?.comments.push(c);
  return [...threads.values()];
}

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
              try {
                host.status(`Merging #${pr.number}…`);
                await gh("pr", "merge", String(pr.number), m.flag);
                host.status(`Merged #${pr.number}`);
              } catch (e) {
                host.status(`Can't merge #${pr.number}: ${String(e).trim()}`);
              }
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
async function showFileDiff(pr: Details, path: string, threads: Thread[], at?: Thread) {
  await loadMarkdown();
  const head = `refs/remotes/pr/${pr.number}`;
  const base = `refs/remotes/origin/${pr.baseRefName}`;
  let diff: monaco.editor.IStandaloneDiffEditor;
  try {
    host.status(`Fetching #${pr.number}…`);
    await git("fetch", "--no-tags", "origin", `+refs/pull/${pr.number}/head:${head}`, `+refs/heads/${pr.baseRefName}:${base}`);
    const mergeBase = (await git("merge-base", head, base)).trim();
    const show = (spec: string) => git("show", spec).catch(() => "");
    const action = { label: "Comment on Line", title: "Comment on the line with the cursor, or reply to its comments", run: () => comment(pr, path, threads) };
    diff = showDiff(path, await show(`${mergeBase}:${path}`), await show(`${head}:${path}`), `#${pr.number}: ${pr.baseRefName} ↔ ${pr.headRefName}`, undefined, action);
    host.status("");
  } catch (e) {
    return host.status(`Can't show the diff: ${String(e).trim()}`);
  }
  const repo = repoUrl(pr);
  diff.layout(); // The diff was hidden until now, so its editors have no width yet.
  for (const t of threads) {
    if (t.path !== path || !t.line) continue;
    const editor = t.side === "LEFT" ? diff.getOriginalEditor() : diff.getModifiedEditor();
    const thread = el("div", "pr-thread");
    for (const c of t.comments) thread.append(el("div", "pr-meta", c.user), markdown(c.body, repo));
    // A view zone needs its height up front, so the thread is measured at the editor's visible width
    // first. The zone itself spans the widest line, so the thread keeps its own width inside it.
    thread.style.width = `${editor.getLayoutInfo().contentWidth - 40}px`;
    document.body.append(thread);
    const heightInPx = thread.offsetHeight + 8;
    const node = el("div");
    node.append(thread);
    editor.changeViewZones((zones) => zones.addZone({ afterLineNumber: t.line!, heightInPx, domNode: node }));
  }
  if (at?.line) {
    const editor = at.side === "LEFT" ? diff.getOriginalEditor() : diff.getModifiedEditor();
    const reveal = () => (editor.revealLineInCenter(at.line!), editor.setPosition({ lineNumber: at.line!, column: 1 }));
    reveal();
    // Computing the diff adds the other side's padding, which moves the line, so reveal it again after.
    const done = diff.onDidUpdateDiff(() => (done.dispose(), reveal()));
  }
}

/** Comments on the line with the cursor in the diff, or replies to the thread already on it. */
function comment(pr: Details, path: string, threads: Thread[]) {
  const cursor = diffCursor();
  if (!cursor) return;
  const side = cursor.side === "original" ? "LEFT" : "RIGHT";
  const { line } = cursor;
  const thread = threads.find((t) => t.path === path && t.line === line && t.side === side);
  const what = thread ? `Reply to ${thread.user} on line ${line}` : `Comment on line ${line}${side === "LEFT" ? " (old side)" : ""}`;
  pick(
    `${what}, then press Enter`,
    (q) =>
      q.trim()
        ? [
            {
              label: `${thread ? "Reply" : "Comment"}: ${q.trim()}`,
              run: async () => {
                const api = `repos/{owner}/{repo}/pulls/${pr.number}/comments`;
                const args = thread
                  ? [`${api}/${thread.id}/replies`, "-f", `body=${q.trim()}`]
                  : [api, "-f", `body=${q.trim()}`, "-f", `commit_id=${pr.headRefOid}`, "-f", `path=${path}`, "-F", `line=${line}`, "-f", `side=${side}`];
                try {
                  host.status("Posting the comment…");
                  await gh("api", "--method", "POST", ...args);
                  host.status(`Commented on ${path}:${line}`);
                  showFileDiff(pr, path, await lineComments(pr.number), { ...(thread ?? ({} as Thread)), path, line, side });
                } catch (e) {
                  // GitHub accepts comments only on lines inside the diff's changes and the lines around them.
                  host.status(`Can't comment: ${String(e).trim()}`);
                }
              },
            },
          ]
        : [],
    0,
    { value: "" },
  );
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
