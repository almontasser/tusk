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
  comments: { author: Author; body: string; url: string }[];
  reviews: { author: Author; state: string; body: string }[];
};

/** A comment on a line of the diff. `line` is null when the code it was on has changed since. */
type ReviewComment = { id: number; path: string; line: number | null; start_line: number | null; side: "LEFT" | "RIGHT"; body: string; user: string; in_reply_to_id: number | null };
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
      me(),
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
  // A comment you can edit or delete when it's yours; it redraws in place while you do.
  const editable = (user: string, body: string, api: string) => {
    const item = el("div", "pr-comment");
    const draw = () => item.replaceChildren(...commentBlock(user, body, api, repo, draw, () => showPullRequest(number)));
    draw();
    conversation.append(item);
  };
  if (pr.body) entry(pr.author.login, "description", pr.body);
  for (const r of pr.reviews) if (r.body || r.state !== "COMMENTED") entry(r.author.login, reviews[r.state] ?? r.state.toLowerCase(), r.body);
  for (const c of pr.comments) {
    const id = c.url.match(/#issuecomment-(\d+)$/)?.[1];
    if (id) editable(c.author.login, c.body, `repos/{owner}/{repo}/issues/comments/${id}`);
    else entry(c.author.login, "", c.body);
  }
  // Line comments, each thread under a link to its place in the diff.
  for (const t of threads) {
    const where = el("button", "link pr-thread-link", `${t.path}${t.line ? `:${t.start_line && t.start_line !== t.line ? `${t.start_line}–` : ""}${t.line}` : " (outdated)"}${t.resolved ? " · resolved" : ""}`);
    where.onclick = () => showFileDiff(pr, t.path, threads, t);
    conversation.append(where);
    for (const c of t.comments) editable(c.user, c.body, `repos/{owner}/{repo}/pulls/comments/${c.id}`);
  }

  const heading = (text: string) => el("h3", "", text);
  // Your line comments that wait for the review to be submitted. Click one to see it in the diff.
  const pending = drafts(pr);
  const pendingList = el("ul", "pr-files");
  pending.forEach((d, i) => {
    const li = el("li");
    li.append(el("span", "name", `${d.path}:${d.start_line ? `${d.start_line}–` : ""}${d.line}`), el("span", "muted", ` ${d.body.split("\n")[0]}`));
    li.onclick = () => showFileDiff(pr, d.path, threads, d);
    const remove = el("button", "icon-button codicon codicon-close");
    remove.title = "Delete this pending comment";
    remove.onclick = (e) => (e.stopPropagation(), saveDrafts(pr, drafts(pr).filter((_, j) => j !== i)), showPullRequest(number));
    li.append(remove);
    pendingList.append(li);
  });
  const review = el("div", "pr-review");
  const box = el("textarea");
  box.placeholder = pending.length ? "Summarize your review (Markdown, optional)" : "Leave a comment (Markdown)";
  box.setAttribute("aria-label", "Comment");
  const buttons = el("div", "pr-actions");
  // With pending comments, each button submits them as one review. Without, Comment adds a comment
  // to the conversation, and Approve and Request Changes submit a review with only the summary.
  const reply = (label: string, event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", needsText: boolean, done: string) => {
    const b = el("button", "", label);
    b.onclick = async () => {
      const body = box.value.trim();
      if (needsText && !body && !pending.length) return host.status(`Write a comment first: ${label} needs one.`);
      buttons.querySelectorAll("button").forEach((x) => (x.disabled = true));
      try {
        if (event === "COMMENT" && !pending.length) await gh("pr", "comment", String(number), "--body", body);
        else await submitReview(pr, event, body);
        host.status(done);
        showPullRequest(number);
      } catch (e) {
        host.status(`Can't ${label.toLowerCase()}: ${String(e).trim()}`);
        buttons.querySelectorAll("button").forEach((x) => (x.disabled = false));
      }
    };
    buttons.append(b);
  };
  reply(pending.length ? `Submit Review (${pending.length})` : "Comment", "COMMENT", true, pending.length ? `Submitted your review on #${number}` : `Commented on #${number}`);
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
    ...(pending.length ? [heading(`Pending review (${pending.length} ${pending.length === 1 ? "comment" : "comments"})`), pendingList] : []),
    review,
  );
}

const repoUrl = (pr: PullRequest) => pr.url.replace(/\/pull\/\d+$/, "");

/**
 * The pull request's line comments, grouped into threads. GitHub points every reply at the thread's first comment.
 * Whether a thread is resolved is only in GraphQL, keyed there by the first comment's ID.
 */
async function lineComments(number: number): Promise<Thread[]> {
  const jq = ".[] | {id, path, line, start_line, side, body, user: .user.login, in_reply_to_id}";
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
function commentBlock(user: string, body: string, api: string, repo: string, redraw: () => void, reload: () => unknown): HTMLElement[] {
  const meta = el("div", "pr-meta", user);
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
      host.status(`Can't ${what} the comment: ${String(e).trim()}`);
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
    host.status(`Can't ${resolved ? "resolve" : "reopen"} the thread: ${String(e).trim()}`);
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
async function showFileDiff(pr: Details, path: string, threads: Thread[], at?: { line: number | null; side: "LEFT" | "RIGHT" }) {
  await loadMarkdown();
  const head = `refs/remotes/pr/${pr.number}`;
  const base = `refs/remotes/origin/${pr.baseRefName}`;
  let diff: monaco.editor.IStandaloneDiffEditor;
  try {
    host.status(`Fetching #${pr.number}…`);
    await git("fetch", "--no-tags", "origin", `+refs/pull/${pr.number}/head:${head}`, `+refs/heads/${pr.baseRefName}:${base}`);
    const mergeBase = (await git("merge-base", head, base)).trim();
    const show = (spec: string) => git("show", spec).catch(() => "");
    const action = { label: "Comment on Line", title: "Comment on the selected lines, or reply to the comments on the cursor's line", run: () => commentAtCursor() };
    diff = showDiff(path, await show(`${mergeBase}:${path}`), await show(`${head}:${path}`), `#${pr.number}: ${pr.baseRefName} ↔ ${pr.headRefName}`, undefined, action);
    host.status("");
  } catch (e) {
    return host.status(`Can't show the diff: ${String(e).trim()}`);
  }
  diff.layout(); // The diff was hidden until now, so its editors have no width yet.
  await me();
  shown = { pr, path, threads, diff, zones: [] };
  form = undefined;
  drawZones();
  if (at?.line) {
    const editor = at.side === "LEFT" ? diff.getOriginalEditor() : diff.getModifiedEditor();
    const reveal = () => (editor.revealLineInCenter(at.line!), editor.setPosition({ lineNumber: at.line!, column: 1 }));
    reveal();
    // Computing the diff adds the other side's padding, which moves the line, so reveal it again after.
    const done = diff.onDidUpdateDiff(() => (done.dispose(), reveal()));
  }
}

// ---- Line comments and pending reviews ----

/** A line comment saved for a review you haven't submitted yet. `commit` is the head it was written against. */
type Draft = { path: string; line: number; side: "LEFT" | "RIGHT"; start_line?: number; body: string; commit: string };

/** The diff on screen, and the view zones (threads, drafts, and the comment form) drawn in it. */
let shown: { pr: Details; path: string; threads: Thread[]; diff: monaco.editor.IStandaloneDiffEditor; zones: [monaco.editor.ICodeEditor, string][] } | undefined;
/** The open comment form: a new comment on lines, or a reply to a thread. */
let form: { side: "LEFT" | "RIGHT"; line: number; start: number; reply?: Thread } | undefined;

// Drafts are kept in localStorage, per pull request, so a reload or a restart doesn't lose them.
const draftKey = (pr: PullRequest) => `review:${repoUrl(pr)}#${pr.number}`;
function drafts(pr: PullRequest): Draft[] {
  try {
    return JSON.parse(localStorage.getItem(draftKey(pr)) ?? "[]");
  } catch {
    return [];
  }
}
function saveDrafts(pr: PullRequest, list: Draft[]) {
  try {
    if (list.length) localStorage.setItem(draftKey(pr), JSON.stringify(list));
    else localStorage.removeItem(draftKey(pr));
  } catch {
    host.status("Can't save the pending review: storage is full or unavailable.");
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
    for (const c of t.comments) thread.append(...commentBlock(c.user, c.body, `repos/{owner}/{repo}/pulls/comments/${c.id}`, repo, drawZones, reload));
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
  drafts(pr).forEach((d, i) => {
    if (d.path !== path) return;
    const draft = el("div", "pr-thread pending");
    const remove = el("button", "link", "Delete");
    remove.onclick = () => (saveDrafts(pr, drafts(pr).filter((_, j) => j !== i)), drawZones());
    const meta = el("div", "pr-meta", `Pending · ${lines(d.start_line, d.line)} · `);
    meta.append(remove);
    draft.append(meta, markdown(d.body, repo));
    addZone(editorFor(d.side), d.line, draft);
  });
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
  if (f.reply) button("Reply", (body) => post([`repos/{owner}/{repo}/pulls/${pr.number}/comments/${f.reply!.id}/replies`, "-f", `body=${body}`]), true);
  else {
    button("Add to Review", (body) => {
      const start = f.start !== f.line ? { start_line: f.start } : {};
      saveDrafts(pr, [...drafts(pr), { path, line: f.line, side: f.side, ...start, body, commit: pr.headRefOid }]);
      host.status(`Added to your pending review on #${pr.number}. Submit it from the pull request's page.`);
      close();
    }, true);
    const range = f.start !== f.line ? ["-F", `start_line=${f.start}`, "-f", `start_side=${f.side}`] : [];
    button("Comment Now", (body) =>
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
    try {
      host.status("Posting the comment…");
      await gh("api", "--method", "POST", ...args);
      host.status(`Commented on ${path}:${f.line}`);
      form = undefined;
      shown!.threads = await lineComments(pr.number);
      drawZones();
    } catch (e) {
      // GitHub accepts comments only on lines inside the diff's changes and the lines around them.
      host.status(`Can't comment: ${String(e).trim()}`);
      buttons.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
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
  const list = drafts(pr);
  const review = {
    // GitHub places each comment on the commit it was written against; later commits mark it outdated.
    commit_id: list[0]?.commit ?? pr.headRefOid,
    event,
    body,
    comments: list.map(({ path, line, side, start_line, body }) => ({ path, line, side, body, ...(start_line ? { start_line, start_side: side } : {}) })),
  };
  await invoke<string>("run_capture", {
    cwd: host.root(),
    program: "gh",
    args: ["api", "--method", "POST", `repos/{owner}/{repo}/pulls/${pr.number}/reviews`, "--input", "-"],
    input: JSON.stringify(review),
  });
  saveDrafts(pr, []);
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
