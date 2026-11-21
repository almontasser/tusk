// Pull requests: the current branch's pull request in the status bar, and its line comments in the editor.
import { monaco } from "./editor";
import { age, checksSummary, lineChanges } from "./gitparse";
import { mapLine } from "./diffdata";
import { git } from "./git";
import { withProgress } from "./status";
import { $, DETAIL_FIELDS, type Details, FIELDS, gh, host, hub, icons, type PullRequest, type Thread } from "./prshared";
import { lineComments } from "./prthreads";
import { showFileDiff } from "./prdiff";
import { branchAnnotations } from "./prchecks";

// ---- Current branch ----

/** Counts branch changes, so a poll or a lookup for an earlier branch stops. */
let branchLookups = 0;
let checksPoll: ReturnType<typeof setInterval> | undefined;

/** Shows the pull request for the current branch next to the branch name. */
export async function updateBranchPullRequest() {
  const button = $("branch-pr");
  const lookup = ++branchLookups;
  clearInterval(checksPoll);
  button.hidden = true;
  if (!host.root()) return;
  try {
    const pr = await showBranchPullRequest(lookup);
    if (lookup !== branchLookups) return;
    void branchAnnotations(pr);
    branchThreads = { number: pr.number, head: pr.headRefOid, threads: await lineComments(pr.number) };
  } catch {
    // No pull request for this branch, or no GitHub remote.
    if (lookup !== branchLookups) return;
    branchThreads = undefined;
    void branchAnnotations();
  }
  for (const model of monaco.editor.getModels()) decorateComments(model);
}

/**
 * Looks up the branch's pull request and shows it on the status bar button. While its checks run, it looks again
 * every 30 seconds when the window has focus, so the icon changes when they finish.
 */
async function showBranchPullRequest(lookup: number) {
  const button = $("branch-pr");
  const pr: PullRequest & { state: string; headRefOid: string } = JSON.parse(await gh("pr", "view", "--json", `${FIELDS},state,headRefOid`));
  if (lookup !== branchLookups) return pr;
  const checks = checksSummary(pr.statusCheckRollup);
  button.innerHTML = `<span class="codicon codicon-git-pull-request"></span><span class="label"></span>`;
  button.querySelector(".label")!.textContent = `#${pr.number} ${icons[checks]}`;
  button.title = `${pr.title} (checks ${checks})`;
  button.onclick = () => hub.showPullRequest(pr.number, pr.title);
  button.hidden = false;
  clearInterval(checksPoll);
  if (checks === "pending" && pr.state === "OPEN")
    checksPoll = setInterval(() => document.hasFocus() && showBranchPullRequest(lookup).catch(() => lookup === branchLookups && clearInterval(checksPoll)), 30_000);
  return pr;
}

// ---- Comments in the editor ----

/**
 * The line threads of the checked-out branch's pull request, which its files show in the editor. `head` is the
 * pull request's head commit, whose lines the threads' line numbers count.
 */
export let branchThreads: { number: number; head: string; threads: Thread[] } | undefined;
/** Each model's thread decorations: decoration ID to thread ID, since a thread's line here can differ from GitHub's. */
const commentDecorations = new Map<monaco.editor.ITextModel, Map<string, number>>();
/** A file's lines at a commit, by "commit:path", or null when git doesn't have the commit here. */
const headLines = new Map<string, Promise<string[] | null>>();

function linesAt(commit: string, path: string) {
  const key = `${commit}:${path}`;
  // git's text keeps the file's line endings, and the editor's lines have none. A miss isn't kept: a pull or fetch
  // can bring the commit.
  if (!headLines.has(key)) headLines.set(key, git("show", key).then((t) => t.replace(/\r\n/g, "\n").split("\n"), () => (headLines.delete(key), null)));
  return headLines.get(key)!;
}

/**
 * Shows the pull request's threads on the checked-out branch's files, where you fix what they ask: a comment icon
 * in the gutter, the latest comment after an unresolved thread's line, and the whole thread on hover, with a link
 * that opens it in the pull request's diff.
 *
 * A thread's line counts the pull request's head. Your copy can differ from it, with commits you haven't pushed or
 * edits you haven't committed, so each line moves through the changes from the head to the editor's text, and a
 * thread whose line you deleted doesn't show. Without the head commit here, as before a pull, the lines are
 * GitHub's. Edits after this move the decorations along with their lines.
 */
export async function decorateComments(model: monaco.editor.ITextModel) {
  if (model.isDisposed() || model.uri.scheme !== "file") return;
  const root = host.root();
  const path = model.uri.fsPath.startsWith(`${root}/`) ? model.uri.fsPath.slice(root.length + 1) : "";
  const pr = branchThreads;
  const all = pr?.threads.filter((t) => t.path === path && t.side === "RIGHT" && t.line) ?? [];
  const head = pr && all.length ? await linesAt(pr.head, path) : null;
  // The branch's pull request changed, or the file closed, while git ran; that call draws instead.
  if (model.isDisposed() || branchThreads !== pr) return;
  const blocks = head ? lineChanges(head, model.getLinesContent()).map((c) => c.block!) : [];
  const placed = all
    .map((t) => ({ t, line: head ? mapLine(blocks, t.line!) : t.line! }))
    .filter((p): p is { t: Thread; line: number } => !!p.line && p.line <= model.getLineCount());
  const number = pr?.number;
  const ids = model.deltaDecorations(
    [...(commentDecorations.get(model)?.keys() ?? [])],
    placed.map(({ t, line }) => {
      const last = t.comments[t.comments.length - 1];
      const hover = t.comments.map((c) => `**${c.user}** · ${ago(c.created_at)}\n\n${c.body}`).join("\n\n---\n\n");
      const link = `[Open in #${number}](command:tusk.prs.openThread?${encodeURIComponent(JSON.stringify([number, t.id]))})`;
      const firstLine = last.body.replace(/```[\s\S]*?```/g, "(suggestion)").split("\n").find((l) => l.trim()) ?? "";
      return {
        range: new monaco.Range(line, 1, line, 1),
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
  commentDecorations.set(model, new Map(ids.map((id, i) => [id, placed[i].t.id])));
}

/** "3 hours ago", for a comment's date in a hover. */
function ago(at: string) {
  const time = Date.parse(at) / 1000;
  return Number.isNaN(time) ? "" : age(time) === "now" ? "just now" : `${age(time)} ago`;
}

// gh's --paginate follows $endCursor through every page.
const FILES = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { files(first: 100, after: $endCursor) { nodes { path additions deletions } pageInfo { hasNextPage endCursor } } } }
}`;
const COMMITS = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { commits(first: 100, after: $endCursor) { nodes { commit { oid messageHeadline committedDate authors(first: 10) { nodes { name user { login } } } } } pageInfo { hasNextPage endCursor } } } }
}`;

const fullLists = new Map<string, Promise<[Details["files"], Details["commits"]]>>();

/**
 * `gh pr view --json files,commits` returns only the first 100 of each, so a larger pull request gets the rest from
 * GitHub's GraphQL API, a page of 100 at a time. Use it wherever the pull request's details load. The lists only
 * change with the head and the base, so they're kept per head commit and base branch: the page redraws after
 * every Viewed tick, and a large pull request would page through it all again.
 */
export async function allFilesAndCommits(pr: Details): Promise<Details> {
  if (pr.files.length < 100 && pr.commits.length < 100) return pr;
  const key = `${pr.number}:${pr.headRefOid}:${pr.baseRefName}`;
  if (!fullLists.has(key)) {
    const pages = (query: string, jq: string) => gh("api", "graphql", "--paginate", "-F", "owner={owner}", "-F", "name={repo}", "-F", `number=${pr.number}`, "-f", `query=${query}`, "--jq", jq).then((out) => out.split("\n").filter(Boolean).map((l) => JSON.parse(l)));
    const lists = Promise.all([
      pr.files.length >= 100 ? pages(FILES, ".data.repository.pullRequest.files.nodes[] | tojson") : pr.files,
      pr.commits.length >= 100
        ? pages(COMMITS, ".data.repository.pullRequest.commits.nodes[].commit | {oid, messageHeadline, committedDate, authors: [.authors.nodes[] | {login: (.user.login // \"\"), name}]} | tojson")
        : pr.commits,
    ]);
    // A failure is tried again next time.
    fullLists.set(key, lists.catch((e) => (fullLists.delete(key), Promise.reject(e))));
  }
  const [files, commits] = await fullLists.get(key)!;
  return { ...pr, files, commits };
}

/** Opens a thread from the editor in its pull request's diff. */
async function openThread(number: number, id: number) {
  const t = branchThreads?.number === number ? branchThreads.threads.find((x) => x.id === id) : undefined;
  if (!t) return;
  const pr = await withProgress(`Opening #${number}…`, async () => allFilesAndCommits(JSON.parse(await gh("pr", "view", String(number), "--json", DETAIL_FIELDS))), { error: `Can't open #${number}` });
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
    const threads = model && commentDecorations.get(model);
    const id = line && threads ? model.getLineDecorations(line).map((d) => threads.get(d.id)).find((x) => x !== undefined) : undefined;
    if (id !== undefined && branchThreads) openThread(branchThreads.number, id);
  }),
);
