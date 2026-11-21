// Pull requests: a file's diff with its threads, the comment form, pending comments, Viewed, and since your review.
import { monaco } from "./editor";
import { diffCursor, type DiffFile, git, gitOutput, gitStatus, showDiff, showDiffs } from "./git";
import { suggestion } from "./gitparse";
import { parseMergeTree, parseNumstat } from "./diffdata";
import { showError, status, withProgress } from "./status";
import { mod } from "./platform.ts";
import { type Details, el, gh, host, hub, loadMarkdown, markdown, me, myLogin, pages, repoUrl, type Thread } from "./prshared";
import { commentBlock, expanded, lineComments, mentions, restTarget } from "./prthreads";
import { addPending, deletePending, loadPending, pendingOf, pendingReview } from "./prreview";

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
            if (pages.has(pr.number)) hub.renderPullRequest(pr.number);
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

/**
 * Draws one file's diff with its threads, from the merge base to the head, or from `from`, the commit you last
 * reviewed. From there, the old side isn't the base's, so only threads on the new side show. `start` is the commit or
 * tree the old side comes from, when it isn't `from` itself (see `sinceReview`).
 */
async function showOneDiff(pr: Details, path: string, threads: Thread[], at?: { line: number | null; side: "LEFT" | "RIGHT" }, from?: string, start = from): Promise<boolean> {
  let diff: monaco.editor.IStandaloneDiffEditor;
  try {
    const slow = setTimeout(() => status(`Fetching #${pr.number}…`, "prs:progress"), 300);
    const [mergeBase] = await Promise.all([prepareDiff(pr).finally(() => (clearTimeout(slow), status("", "prs:progress"))), loadMarkdown(), me()]);
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
  shown = { pr, path, threads, diff, zones: [], model: diff.getModel()?.modified };
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
export let shown: { pr: Details; path: string; threads: Thread[]; diff: monaco.editor.IStandaloneDiffEditor; zones: [monaco.editor.ICodeEditor, string][]; model?: monaco.editor.ITextModel } | undefined;
/** The open comment form: a new comment on lines, or a reply to a thread. */
let form: { side: "LEFT" | "RIGHT"; line: number; start: number; reply?: Thread } | undefined;

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
export function drawZones() {
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
      thread.append(...commentBlock(pr.number, c.user, c.body, restTarget(`repos/{owner}/{repo}/pulls/comments/${c.id}`), repo, drawZones, reload, c.created_at));
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
  for (const c of pendingReview(pr.number)?.comments ?? []) {
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
  mentions(text, pr.number);
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
    await hub.threadsChanged(pr.number);
  };
  box.append(text, buttons);
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

/**
 * A + in the gutter of the line under the mouse, as on GitHub: click it to comment on that line, or on the selected
 * lines when the selection includes it. Only a pull request's diff has it; other diffs hide the glyph margin again.
 */
function addCommentGutter(diff: monaco.editor.IStandaloneDiffEditor) {
  const sides: [monaco.editor.ICodeEditor, "LEFT" | "RIGHT"][] = [[diff.getOriginalEditor(), "LEFT"], [diff.getModifiedEditor(), "RIGHT"]];
  for (const [editor] of sides) editor.updateOptions({ glyphMargin: true });
  if (guttered.has(diff)) return;
  guttered.add(diff);
  const ours = () => !!shown && shown.diff === diff && diff.getModel()?.modified === shown.model;
  diff.onDidChangeModel(() => {
    if (!ours()) for (const [editor] of sides) editor.updateOptions({ glyphMargin: false });
  });
  for (const [editor, side] of sides) {
    let hover: string[] = [];
    const show = (line?: number) => {
      const model = editor.getModel();
      if (!model) return;
      hover = model.deltaDecorations(hover, line && ours() ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: "codicon codicon-add pr-add-glyph", glyphMarginHoverMessage: { value: "Comment on this line (select lines first for a range)" } } }] : []);
    };
    editor.onMouseMove((e) => show(e.target.position?.lineNumber));
    editor.onMouseLeave(() => show());
    editor.onMouseDown((e) => {
      if (!ours() || !e.event.leftButton || !e.target.element?.classList.contains("pr-add-glyph")) return;
      const line = e.target.position!.lineNumber;
      const s = editor.getSelection();
      const end = s && s.endColumn === 1 && s.endLineNumber > s.startLineNumber ? s.endLineNumber - 1 : s?.endLineNumber;
      const range = s && end && s.startLineNumber <= line && line <= end && end > s.startLineNumber ? [s.startLineNumber, end] : [line, line];
      e.event.preventDefault();
      form = { side, line: range[1], start: range[0] };
      drawZones();
    });
  }
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
