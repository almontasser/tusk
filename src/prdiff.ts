// Pull requests: a file's diff with its threads, the comment form, pending comments, Viewed, and since your review.
import { monaco } from "./editor";
import { diffCursor, type DiffFile, git, gitFailure, gitOutput, gitStatus, refreshGit, showDiff, showDiffs } from "./git";
import { suggestion } from "./gitparse";
import { parseMergeTree, parseNumstat } from "./diffdata";
import { showError, status, withProgress } from "./status";
import { mod } from "./platform.ts";
import { confirm } from "./palette";
import { type Details, el, gh, host, hub, loadMarkdown, markdown, me, myLogin, pages, repoUrl, type Thread } from "./prshared";
import { commentBlock, expanded, lineComments, restTarget, writer } from "./prthreads";
import { addPending, deletePending, loadPending, pendingOf, pendingReview } from "./prreview";
import { batchOrder, clampToHunk, commentable, type Hunk, hunks, type Side, type Suggested } from "./prhunks";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// gh's --paginate follows $endCursor through every page of files.
const VIEWED = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { files(first: 100, after: $endCursor) { nodes { path viewerViewedState } pageInfo { hasNextPage endCursor } } } }
}`;

/** Which files you marked Viewed on GitHub, by path. */
export async function viewedFiles(number: number) {
  const jq = ".data.repository.pullRequest.files.nodes[] | [.path, .viewerViewedState == \"VIEWED\"]";
  const out = await gh("api", "graphql", "--paginate", "-F", "owner={owner}", "-F", "name={repo}", "-F", `number=${number}`, "-f", `query=${VIEWED}`, "--jq", jq);
  return new Map<string, boolean>(out.split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

export const setViewed = (id: string, path: string, viewed: boolean) => {
  const mutation = viewed ? "markFileAsViewed" : "unmarkFileAsViewed";
  return gh("api", "graphql", "-f", `query=mutation($id: ID!, $path: String!) { ${mutation}(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`, "-f", `id=${id}`, "-f", `path=${path}`);
};

/** Opens the next unresolved thread after `after`, in the order of the files, or the first one. */
export function nextUnresolved(pr: Details, threads: Thread[], after?: Thread) {
  const order = (t: Thread) => [pr.files.findIndex((f) => f.path === t.path), t.line ?? 0];
  const open = threads.filter((t) => t.line && !t.resolved).sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1]);
  if (!open.length) return host.status("No unresolved threads.");
  const i = after ? open.findIndex((t) => t.id === after.id) : -1;
  const next = open[(i + 1) % open.length];
  if (after && next.id === after.id) return host.status("This is the only unresolved thread.");
  showFileDiff(pr, next.path, threads, next);
}

/** Resolves or reopens a thread on GitHub. */
export async function setResolved(number: number, t: Thread, resolved: boolean) {
  const mutation = resolved ? "resolveReviewThread" : "unresolveReviewThread";
  try {
    await gh("api", "graphql", "-f", `query=mutation($id: ID!) { ${mutation}(input: { threadId: $id }) { thread { isResolved } } }`, "-f", `id=${t.node}`);
    await hub.threadsChanged(number);
  } catch (e) {
    showError(`Can't ${resolved ? "resolve" : "reopen"} the thread`, e);
  }
}

/**
 * Replies to a thread. With a pending review, GitHub takes no comment outside it, so the reply joins the review, as
 * on GitHub; otherwise it posts at once.
 */
export async function replyTo(number: number, t: Thread, body: string) {
  const review = await pendingOf(number);
  if (review && t.node) {
    await gh("api", "graphql", "-f", "query=mutation($review: ID!, $thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewId: $review, pullRequestReviewThreadId: $thread, body: $body }) { comment { id } } }", "-f", `review=${review.node}`, "-f", `thread=${t.node}`, "-f", `body=${body}`);
    await loadPending(number);
    host.status("Added the reply to your pending review.");
  } else {
    await gh("api", "--method", "POST", `repos/{owner}/{repo}/pulls/${number}/comments/${t.id}/replies`, "-f", `body=${body}`);
    host.status(`Replied to ${t.user}.`);
  }
  await hub.threadsChanged(number);
}

/** Each pull request's merge base, once its head and base are fetched, per head commit, so a push fetches again. */
const mergeBases = new Map<string, Promise<string>>();

/**
 * Fetches a pull request's head and base, then finds their merge base. The pull request page starts this when it
 * opens, so a file's diff usually opens without waiting for the network. With the head commit already here, from
 * an earlier fetch or a checkout, nothing is fetched.
 */
export function prepareDiff(pr: Details): Promise<string> {
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
export function showFileDiff(pr: Details, path: string, threads: Thread[], at?: { line: number | null; side: "LEFT" | "RIGHT" }, since?: Since) {
  const label = since ? `#${pr.number}: since your review (${since.oid.slice(0, 7)})` : `#${pr.number}: ${pr.baseRefName} ↔ ${pr.headRefName}`;
  const viewed = pages.get(pr.number)?.viewed;
  const files: DiffFile[] = (since?.files ?? pr.files).map((f, i) => ({
    path: f.path,
    status: viewed?.get(f.path) ? "✓" : "",
    load: async (): Promise<[string, string]> => ["", ""],
    show: () => showOneDiff(pr, f.path, threads, f.path === path ? at : undefined, since?.oid, (f as { from?: string }).from),
    // Comment on File, and GitHub's Viewed checkbox for the file.
    extra: () => {
      // An icon, since the diff's header is crowded; the title and label say what it does.
      const comment = el("button", "icon-button codicon codicon-comment-discussion");
      comment.title = "Comment on File: the whole file rather than its lines";
      comment.setAttribute("aria-label", "Comment on File");
      // The form opens above the first line, so the diff scrolls up to it.
      comment.onclick = () => ((form = { side: "RIGHT", line: 0, start: 0, file: true }), drawZones(), shown?.diff.getModifiedEditor().setScrollTop(0));
      const extras = el("span", "pr-diff-extras");
      extras.append(comment);
      if (viewed?.has(f.path)) extras.append(viewedBox(f, i));
      return extras;
    },
  }));
  // Checking Viewed moves on to the next file you haven't viewed.
  function viewedBox(f: { path: string }, i: number) {
    const box = el("input");
    box.type = "checkbox";
    box.checked = !!viewed!.get(f.path);
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
      viewed!.set(f.path, box.checked);
      files[i].status = box.checked ? "✓" : "";
      if (pages.has(pr.number)) hub.renderPullRequest(pr.number);
      if (!box.checked) return;
      const next = [...files.keys()].map((k) => (i + 1 + k) % files.length).find((k) => !viewed!.get(files[k].path));
      if (next === undefined) host.status(`You've viewed all ${files.length} files of #${pr.number}.`);
      else showDiffs(files, label, next);
    };
    return toggle;
  }
  return showDiffs(files, label, Math.max(0, files.findIndex((f) => f.path === path)));
}

/**
 * Draws one file's diff with its threads, from the merge base to the head, or from `from`, the commit you last
 * reviewed. From there, the old side isn't the base's, so only threads on the new side show. `start` is the commit or
 * tree the old side comes from, when it isn't `from` itself (see `sinceReview`).
 */
async function showOneDiff(pr: Details, path: string, threads: Thread[], at?: { line: number | null; side: "LEFT" | "RIGHT" }, from?: string, start = from): Promise<boolean> {
  let diff: monaco.editor.IStandaloneDiffEditor;
  let mergeBase: string;
  try {
    const slow = setTimeout(() => status(`Fetching #${pr.number}…`, "prs:progress"), 300);
    [mergeBase] = await Promise.all([prepareDiff(pr).finally(() => (clearTimeout(slow), status("", "prs:progress"))), loadMarkdown(), me()]);
    const show = (spec: string) => git("show", spec).catch(() => "");
    const images: [string, string] = [`${start ?? mergeBase}:${path}`, `${pr.headRefOid}:${path}`];
    const [original, modified] = await Promise.all(images.map(show));
    const action = { label: "Comment on Line", title: "Comment on the selected lines, or reply to the comments on the cursor's line", run: () => commentAtCursor() };
    diff = showDiff(path, original, modified, from ? `#${pr.number}: since your review (${from.slice(0, 7)})` : `#${pr.number}: ${pr.baseRefName} ↔ ${pr.headRefName}`, action, images);
    if (from) threads = threads.filter((t) => t.side === "RIGHT");
  } catch (e) {
    showError(`Can't show the diff`, e);
    return false;
  }
  diff.layout(); // The diff was hidden until now, so its editors have no width yet.
  const model = diff.getModel()?.modified;
  shown = { pr, path, threads, diff, zones: [], model, from, hunks: null };
  // Which lines take comments comes from GitHub, so the diff doesn't wait for it; until then every line has its +.
  hunksOf(pr, path, mergeBase).then((h) => {
    const now = shown;
    if (now && now.model === model) now.hunks = h;
  });
  if (picked.number !== pr.number || picked.root !== host.root()) picked = { number: pr.number, root: host.root(), items: new Map() };
  addCommentGutter(diff);
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

/** GitHub's patch of each file the pull request changes, per pull request and head commit. */
const patches = new Map<string, Promise<Map<string, string | null>>>();

/**
 * The hunks GitHub takes comments in, from its own patch of the file: its diff can join hunks that git's keeps apart.
 * GitHub leaves the patch out of large and binary files, so git's diff with the same 3 lines of context stands in.
 * Null when neither can be read, and then every line keeps its +, as GitHub has the last word.
 */
async function hunksOf(pr: Details, path: string, mergeBase: string): Promise<Hunk[] | null> {
  const key = `${host.root()}\0${pr.number}:${pr.headRefOid}`;
  if (!patches.has(key)) {
    const load = gh("api", "--paginate", `repos/{owner}/{repo}/pulls/${pr.number}/files`, "--jq", ".[] | [.filename, .patch]").then((out) => new Map<string, string | null>(out.split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    patches.set(key, load.catch((e) => (patches.delete(key), Promise.reject(e))));
  }
  try {
    const patch = (await patches.get(key)!).get(path);
    return hunks(patch ?? (await git("diff", "-U3", "--no-renames", mergeBase, pr.headRefOid, "--", path)));
  } catch {
    return null;
  }
}

const OUTSIDE = "GitHub takes comments only on the diff's changed lines and the 3 lines around them.";

/** Why GitHub won't take a comment on lines `start` to `end` of a side, or undefined when it will. */
function whyNot(side: Side, start: number, end: number): string | undefined {
  if (!shown) return;
  // Since your review, the old side is the commit you reviewed, whose line numbers GitHub doesn't know.
  if (shown.from && side === "LEFT") return "Since your review, the old side isn't the pull request's base. Comment on the new side.";
  if (!shown.hunks || commentable(shown.hunks, side, start, end)) return;
  return start === end ? OUTSIDE : `${OUTSIDE} A range has to stay inside one group of them.`;
}

/** Suggestions you selected to apply together, by comment ID, in pull request `number` of project `root`. */
let picked = { number: 0, root: "", items: new Map<number, Suggested>() };

/**
 * Puts suggestions into your copy of their files, in their editors, where you can review, undo, or save them, then
 * offers to commit them. Only on the pull request's branch, and only while the lines still read as they did in the
 * pull request. Each file's suggestions go in from the bottom up, so one doesn't move the lines of the next.
 */
async function applySuggestions(pr: Details, items: Suggested[]) {
  if (gitStatus()?.branch !== pr.headRefName) return showError(`Check out #${pr.number} (${pr.headRefName}) to apply its suggestions.`);
  const { ordered, overlap } = batchOrder(items);
  if (overlap) return showError(`The suggestions on ${overlap[0].path}:${overlap[0].start} and ${overlap[1].path}:${overlap[1].start} change the same lines. Apply one of them.`);
  const heads = new Map<string, Promise<string>>();
  const head = (path: string) => heads.get(path) ?? heads.set(path, git("show", `${pr.headRefOid}:${path}`).catch(() => "")).get(path)!;
  const applied = new Set<string>();
  const failed: string[] = [];
  for (const s of ordered) {
    const text = await head(s.path);
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(eol);
    const expected = lines.slice(s.start - 1, s.end).join(eol);
    if (s.end <= lines.length && (await host.replaceLines(`${host.root()}/${s.path}`, s.start, s.end, expected, s.text))) {
      applied.add(s.path);
      picked.items.delete(s.id);
    } else failed.push(`${s.path}:${s.start}`);
  }
  drawZones();
  if (failed.length) showError(`The lines of ${failed.join(", ")} changed since the suggestion was made. Apply ${failed.length === 1 ? "it" : "them"} by hand.`);
  if (!applied.size) return;
  const count = plural(ordered.length - failed.length, "suggestion");
  const files = [...applied];
  host.status(`Applied ${count} to ${plural(files.length, "file")}. Review the changes.`);
  if (!(await confirm(`Save ${plural(files.length, "file")} and commit all their changes as "Apply suggestions from code review"? Nothing is pushed.`, "Save and Commit"))) return;
  for (const path of files)
    if (!(await host.save(`${host.root()}/${path}`))) return showError(`${path} wasn't saved, so nothing was committed.`);
  // Only these files: anything else you staged stays out of the commit.
  const args = ["--literal-pathspecs", "commit", "-m", "Apply suggestions from code review", "--", ...files];
  const result = await withProgress("Committing the suggestions…", (signal) => gitOutput(args, signal), { cancellable: true, error: "Commit failed" });
  await refreshGit();
  if (!result) return;
  if (result.code) return gitFailure(/hook/i.test(result.output) ? "Commit failed: a git hook refused it" : "Commit failed", result.output);
  host.status(`Committed ${count}. Push when you're ready.`);
}

// ---- Line comments and pending reviews ----

/**
 * The diff on screen, and the view zones (threads, pending comments, and the comment form) drawn in it. `from` is
 * the commit you last reviewed, when the diff shows only what changed since, and `hunks` the lines GitHub takes
 * comments on, null when unknown.
 */
export let shown:
  | { pr: Details; path: string; threads: Thread[]; diff: monaco.editor.IStandaloneDiffEditor; zones: [monaco.editor.ICodeEditor, string, ResizeObserver][]; model?: monaco.editor.ITextModel; from?: string; hunks: Hunk[] | null }
  | undefined;
/**
 * The open comment form: a new comment on lines or on the whole file, or a reply to a thread. `text` keeps what you
 * typed when the zones redraw, such as when a reply or your pending review arrives.
 */
let form: { side: Side; line: number; start: number; reply?: Thread; file?: boolean; text?: string } | undefined;

const lines = (start: number | undefined | null, line: number) => (start && start !== line ? `lines ${start}–${line}` : `line ${line}`);
const isFile = (c: { subject_type?: string }) => c.subject_type === "file";

/**
 * Adds a view zone under a line, or above the first with line 0. A zone needs its height up front, so the content is
 * measured first, at the editor's visible width, and again whenever its height changes, such as on Preview.
 */
function addZone(editor: monaco.editor.ICodeEditor, line: number, content: HTMLElement) {
  content.style.width = `${editor.getLayoutInfo().contentWidth - 40}px`;
  document.body.append(content);
  const zone = { afterLineNumber: line, heightInPx: content.offsetHeight + 8, domNode: el("div"), suppressMouseDown: true };
  zone.domNode.append(content);
  // The zone's buttons and text box take their own clicks and keys, not the editor's.
  zone.domNode.onkeydown = (e) => e.stopPropagation();
  let id = "";
  editor.changeViewZones((zones) => (id = zones.addZone(zone)));
  const resized = new ResizeObserver(() => {
    // A zone scrolled out of view has no height; it keeps the last one.
    const height = content.offsetHeight + 8;
    if (content.offsetHeight && height !== zone.heightInPx) (zone.heightInPx = height), editor.changeViewZones((zones) => zones.layoutZone(id));
  });
  resized.observe(content);
  shown!.zones.push([editor, id, resized]);
}

/** Draws the file's threads, your pending comments, and the open comment form under their lines. */
export function drawZones() {
  // The diff may show something else by now, such as a file's history, after a slow request.
  if (shown && shown.diff.getModel()?.modified !== shown.model) shown = undefined;
  if (!shown) return;
  const { pr, path, threads, diff } = shown;
  shown.zones.forEach(([editor, id, resized]) => (resized.disconnect(), editor.changeViewZones((zones) => zones.removeZone(id))));
  shown.zones = [];
  const editorFor = (side: Side) => (side === "LEFT" ? diff.getOriginalEditor() : diff.getModifiedEditor());
  // Comments on the whole file go above its first line.
  const place = (c: { side: Side; line: number | null; subject_type?: string }): [monaco.editor.ICodeEditor, number] => (isFile(c) ? [diff.getModifiedEditor(), 0] : [editorFor(c.side), c.line!]);
  const repo = repoUrl(pr);
  const reload = async () => ((shown!.threads = await lineComments(pr.number)), drawZones());
  for (const t of threads) {
    if (t.path !== path || (!t.line && !isFile(t))) continue;
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
      addZone(...place(t), thread);
      continue;
    }
    if (isFile(t)) thread.append(el("div", "pr-meta", "On the file"));
    else if (t.start_line && t.start_line !== t.line) thread.append(el("div", "pr-meta", `On ${lines(t.start_line, t.line!)}`));
    for (const c of t.comments) {
      thread.append(...commentBlock(pr.number, c.user, c.body, restTarget(`repos/{owner}/{repo}/pulls/comments/${c.id}`), repo, drawZones, reload, c.created_at));
      const suggested = t.side === "RIGHT" && !isFile(t) ? suggestion(c.body) : null;
      if (suggested !== null) thread.append(suggestionActions(pr, { id: c.id, path: t.path, start: t.start_line ?? t.line!, end: t.line!, text: suggested }));
    }
    if (form?.reply?.id === t.id) thread.append(commentForm());
    else {
      const actions = el("div", "pr-thread-actions");
      action(actions, "Reply", () => ((form = { side: t.side, line: t.line ?? 0, start: t.line ?? 0, reply: t }), drawZones()));
      if (t.node) action(actions, t.resolved ? "Unresolve" : "Resolve", () => setResolved(pr.number, t, !t.resolved));
      if (t.resolved) action(actions, "Hide", () => (expanded.delete(t.id), drawZones()));
      if (threads.some((x) => x.id !== t.id && x.line && !x.resolved)) action(actions, "Next Unresolved", () => nextUnresolved(pr, threads, t));
      thread.append(actions);
    }
    addZone(...place(t), thread);
  }
  for (const c of pendingReview(pr.number)?.comments ?? []) {
    if (c.path !== path || (!c.line && !isFile(c))) continue;
    const draft = el("div", "pr-thread pending");
    const remove = el("button", "link", "Delete");
    remove.onclick = () =>
      deletePending(pr.number, c).then(drawZones, (e) => showError(`Can't delete the pending comment`, e));
    const meta = el("div", "pr-meta", `Pending · ${isFile(c) ? "on the file" : lines(c.start_line, c.line!)} · `);
    meta.append(remove);
    draft.append(meta, markdown(c.body, repo));
    addZone(...place(c), draft);
  }
  if (form?.file) addZone(diff.getModifiedEditor(), 0, commentForm());
  else if (form && !form.reply) addZone(editorFor(form.side), form.line, commentForm());
}

/**
 * Apply Suggestion Locally, and a Select box to apply several suggestions at once, with the button that applies
 * the ones you selected, in this file or others of the pull request.
 */
function suggestionActions(pr: Details, item: Suggested) {
  const row = el("div", "pr-thread-actions");
  const apply = el("button", "link", "Apply Suggestion Locally");
  apply.onclick = () => applySuggestions(pr, [item]);
  const box = el("input");
  box.type = "checkbox";
  box.checked = picked.items.has(item.id);
  box.dataset.suggestion = String(item.id);
  // The redraw updates every count; focus comes back to this box for the keyboard.
  box.onchange = () => {
    if (box.checked) picked.items.set(item.id, item);
    else picked.items.delete(item.id);
    drawZones();
    document.querySelector<HTMLInputElement>(`input[data-suggestion="${item.id}"]`)?.focus();
  };
  const select = el("label", "pr-suggestion-pick");
  select.title = "Select the suggestion to apply it together with others";
  select.append(box, " Select");
  row.append(apply, " · ", select);
  if (picked.items.size) {
    const all = el("button", "link", `Apply ${plural(picked.items.size, "Selected Suggestion")}`);
    all.title = "Apply every suggestion you selected in this pull request, then offer to commit them";
    all.onclick = () => applySuggestions(pr, [...picked.items.values()]);
    row.append(" · ", all);
  }
  return row;
}

/** The comment form's text box and buttons. ⌘⏎ does the first button's action, and Escape cancels. */
function commentForm() {
  const { pr, path } = shown!;
  const f = form!;
  const box = el("div", "pr-comment-form");
  const text = el("textarea");
  text.rows = 4;
  text.value = f.text ?? "";
  // The box grows with its text, up to a point, and its zone grows with it.
  const grow = () => {
    text.style.height = "";
    if (text.scrollHeight > text.clientHeight) text.style.height = `${Math.min(text.scrollHeight + 2, 400)}px`;
  };
  text.addEventListener("input", () => ((f.text = text.value), grow()));
  requestAnimationFrame(grow);
  text.placeholder = f.reply ? `Reply to ${f.reply.user} (Markdown)` : f.file ? `Comment on ${path} (Markdown)` : `Comment on ${lines(f.start, f.line)}${f.side === "LEFT" ? " of the old version" : ""} (Markdown)`;
  text.setAttribute("aria-label", f.reply ? "Reply" : "Comment");
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
  const inReview = !!pendingReview(pr.number);
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
        await addPending(pr, { path, line: f.line, side: f.side, ...(f.file ? { file: true } : f.start !== f.line ? { start_line: f.start } : {}) }, body);
        host.status(`Added to your pending review on #${pr.number}. Submit it from the pull request's page, or on GitHub.`);
        close();
      } catch (e) {
        showError(`Can't add the comment to your review`, e);
        buttons.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    }, true);
    const range = f.start !== f.line ? ["-F", `start_line=${f.start}`, "-f", `start_side=${f.side}`] : [];
    const where = f.file ? ["-f", "subject_type=file"] : ["-F", `line=${f.line}`, "-f", `side=${f.side}`, ...range];
    if (!inReview) button("Comment Now", (body) =>
      post([`repos/{owner}/{repo}/pulls/${pr.number}/comments`, "-f", `body=${body}`, "-f", `commit_id=${pr.headRefOid}`, "-f", `path=${path}`, ...where]),
    );
  }
  // On the new side, Suggest Change writes the lines into a suggestion block to edit, as on GitHub.
  if (!f.reply && !f.file && f.side === "RIGHT" && shown?.model) {
    const model = shown.model;
    const suggest = el("button", "", "Suggest Change");
    suggest.title = "Insert the lines as a suggestion to edit";
    suggest.onclick = () => {
      const lines = model.getValueInRange({ startLineNumber: f.start, startColumn: 1, endLineNumber: f.line, endColumn: model.getLineMaxColumn(f.line) });
      text.setRangeText(`${text.value && !text.value.endsWith("\n") ? "\n" : ""}\`\`\`suggestion\n${lines}\n\`\`\`\n`, text.selectionStart, text.selectionEnd, "end");
      text.dispatchEvent(new Event("input"));
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
    const posted = await withProgress("Posting the comment…", () => gh("api", "--method", "POST", ...args), { error: "Can't comment" });
    if (posted === undefined) return buttons.querySelectorAll("button").forEach((b) => (b.disabled = false));
    host.status(f.file ? `Commented on ${path}` : `Commented on ${path}:${f.line}`);
    form = undefined;
    await hub.threadsChanged(pr.number);
  };
  box.append(writer(text, repoUrl(pr), pr.number), buttons);
  requestAnimationFrame(() => text.focus());
  return box;
}

/**
 * The files that changed since the commit you last reviewed, with their line counts. Each file's `from` is the
 * commit or tree its diff starts from (see `sinceReview`).
 */
export type Since = { oid: string; files: { path: string; additions: number; deletions: number; from: string }[] };
const sinceCache = new Map<string, Promise<Since>>();

/** The commit of your latest submitted review, when the pull request's head has moved on since. */
export function lastReviewed(pr: Details): string | undefined {
  const mine = pr.reviews.filter((r) => r.author.login === myLogin && r.state !== "PENDING" && r.commit?.oid).sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt))[0];
  return mine && mine.commit!.oid !== pr.headRefOid ? mine.commit!.oid : undefined;
}

/**
 * What the pull request itself changed between the commit you last reviewed and the head, as GitHub's "changes
 * since your last review". A force push can leave that commit out of the pull request's history, so it's fetched by
 * ID when it isn't here.
 *
 * When the author merged the base branch in (or rebased onto it) after your review, a plain diff from that commit
 * also holds everyone else's work on the base. So the diff starts from your reviewed commit as if it had been made
 * on today's base: `git merge-tree` replays the base's changes since the old fork point onto it, in a tree that
 * isn't checked out or referenced. From that tree to the head, only the pull request's own changes remain. A file
 * where the base's changes conflict with the reviewed version starts from the reviewed commit instead.
 */
export function sinceReview(pr: Details, oid: string): Promise<Since> {
  const key = `${oid}..${pr.headRefOid}`;
  if (!sinceCache.has(key)) {
    const load = (async () => {
      const baseNow = await prepareDiff(pr);
      const here = await git("cat-file", "-e", `${oid}^{commit}`).then(() => true, () => false);
      if (!here) {
        const { code, output } = await gitOutput(["fetch", "--no-tags", "origin", oid]);
        if (code) throw new Error(output);
      }
      const numstat = async (from: string, paths: string[] = []) => parseNumstat(await git("diff", "--numstat", "-z", "--no-renames", from, pr.headRefOid, ...(paths.length ? ["--", ...paths] : [])));
      const baseThen = (await git("merge-base", oid, `refs/remotes/origin/${pr.baseRefName}`)).trim();
      if (baseThen === baseNow) return { oid, files: (await numstat(oid)).map((f) => ({ ...f, from: oid })) };
      // merge-tree exits with 1 when files conflict, which `git` treats as a failure, so it runs through gitOutput.
      // An older git without --merge-base, or another failure, leaves the base's changes in the diffs, but lists
      // only the files the pull request changes.
      const merged = await gitOutput(["merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", `--merge-base=${baseThen}`, oid, baseNow]);
      const { tree, conflicts } = parseMergeTree(merged.output);
      if (merged.code > 1 || !/^[0-9a-f]{40,64}$/.test(tree)) {
        const own = new Set(pr.files.map((f) => f.path));
        return { oid, files: (await numstat(oid)).filter((f) => own.has(f.path)).map((f) => ({ ...f, from: oid })) };
      }
      const conflicted = new Set(conflicts);
      const clean = (await numstat(tree)).filter((f) => !conflicted.has(f.path)).map((f) => ({ ...f, from: tree }));
      const rest = conflicts.length ? (await numstat(oid, conflicts)).map((f) => ({ ...f, from: oid })) : [];
      return { oid, files: [...clean, ...rest].sort((a, b) => (a.path < b.path ? -1 : 1)) };
    })();
    sinceCache.set(key, load.catch((e) => (sinceCache.delete(key), Promise.reject(e))));
  }
  return sinceCache.get(key)!;
}

/** Diff editors that have the comment gutter's listeners; the diff editor is made once and reused. */
const guttered = new WeakSet<monaco.editor.IStandaloneDiffEditor>();

/** A drag in the gutter from the + of line `anchor` to `line`, which selects lines for one comment. */
let drag: { editor: monaco.editor.ICodeEditor; side: Side; anchor: number; line: number; paint(line?: number): void } | undefined;

/** Opens the comment form for lines `start` to `end`, or says why GitHub won't take a comment there. */
function openForm(side: Side, start: number, end: number) {
  const why = whyNot(side, start, end);
  if (why) return host.status(why);
  form = { side, line: end, start };
  drawZones();
}

/**
 * A + in the gutter of the line under the mouse, as on GitHub: click it to comment on that line, or on the selected
 * lines when the selection includes it, or drag from it to comment on several lines. Lines GitHub takes no comment
 * on have no +, and their gutter says why on hover. Only a pull request's diff has it; other diffs hide the glyph
 * margin again.
 */
function addCommentGutter(diff: monaco.editor.IStandaloneDiffEditor) {
  const sides: [monaco.editor.ICodeEditor, Side][] = [[diff.getOriginalEditor(), "LEFT"], [diff.getModifiedEditor(), "RIGHT"]];
  for (const [editor] of sides) editor.updateOptions({ glyphMargin: true });
  if (guttered.has(diff)) return;
  guttered.add(diff);
  const ours = () => !!shown && shown.diff === diff && diff.getModel()?.modified === shown.model;
  diff.onDidChangeModel(() => {
    if (!ours()) for (const [editor] of sides) editor.updateOptions({ glyphMargin: false });
  });
  // The drag ends wherever you let go of the mouse, inside the editor or not.
  window.addEventListener("mouseup", () => {
    if (!drag) return;
    const { editor, side, anchor, line, paint } = drag;
    drag = undefined;
    paint();
    if (anchor !== line) return openForm(side, Math.min(anchor, line), Math.max(anchor, line));
    // A click on the + of a selected line comments on the selection.
    const s = editor.getSelection();
    const end = s && s.endColumn === 1 && s.endLineNumber > s.startLineNumber ? s.endLineNumber - 1 : s?.endLineNumber;
    if (s && end && s.startLineNumber <= line && line <= end && end > s.startLineNumber) openForm(side, s.startLineNumber, end);
    else openForm(side, line, line);
  });
  for (const [editor, side] of sides) {
    let marks: string[] = [];
    const paint = (line?: number) => {
      const model = editor.getModel();
      if (!model) return;
      const add = { glyphMarginClassName: "codicon codicon-add pr-add-glyph", glyphMarginHoverMessage: { value: "Comment on this line. Drag to comment on several lines." } };
      const at = (n: number) => new monaco.Range(n, 1, n, 1);
      let decorations: monaco.editor.IModelDeltaDecoration[] = [];
      if (drag?.editor === editor) {
        const [start, end] = [Math.min(drag.anchor, drag.line), Math.max(drag.anchor, drag.line)];
        decorations = [{ range: new monaco.Range(start, 1, end, 1), options: { isWholeLine: true, className: "pr-drag-range" } }, { range: at(drag.line), options: add }];
      } else if (line && ours()) {
        const why = whyNot(side, line, line);
        decorations = [{ range: at(line), options: why ? { glyphMarginClassName: "pr-no-add-glyph", glyphMarginHoverMessage: { value: why } } : add }];
      }
      marks = model.deltaDecorations(marks, decorations);
    };
    editor.onMouseMove((e) => {
      const line = e.target.position?.lineNumber;
      // A range can't span two groups of changes, so the drag stops at the edge of its own.
      if (drag?.editor === editor && line) drag.line = shown?.hunks ? clampToHunk(shown.hunks, side, drag.anchor, line) : line;
      paint(line);
    });
    editor.onMouseLeave(() => drag?.editor !== editor && paint());
    editor.onMouseDown((e) => {
      if (!ours() || !e.event.leftButton || !e.target.element?.classList.contains("pr-add-glyph")) return;
      e.event.preventDefault();
      const line = e.target.position!.lineNumber;
      drag = { editor, side, anchor: line, line, paint };
      paint(line);
    });
  }
}

/** Opens the comment form for the selected lines in the diff, or a reply to the thread on the cursor's line. */
function commentAtCursor() {
  const cursor = diffCursor();
  if (!cursor || !shown) return;
  const side = cursor.side === "original" ? "LEFT" : "RIGHT";
  const { line, startLine } = cursor;
  const reply = startLine === line ? shown.threads.find((t) => t.path === shown!.path && t.line === line && t.side === side && !isFile(t)) : undefined;
  if (!reply) return openForm(side, startLine, line);
  form = { side, line, start: startLine, reply };
  drawZones();
}
