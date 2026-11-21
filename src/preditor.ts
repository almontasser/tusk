// Pull requests: the current branch's pull request in the status bar, and its line comments in the editor.
import { monaco } from "./editor";
import { age, checksSummary } from "./gitparse";
import { withProgress } from "./status";
import { $, DETAIL_FIELDS, type Details, FIELDS, gh, host, hub, icons, type PullRequest, type Thread } from "./prshared";
import { lineComments } from "./prthreads";
import { showFileDiff } from "./prdiff";

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
    button.onclick = () => hub.showPullRequest(pr.number, pr.title);
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
export let branchThreads: { number: number; threads: Thread[] } | undefined;
const commentDecorations = new Map<monaco.editor.ITextModel, string[]>();

/**
 * Shows the pull request's threads on the checked-out branch's files, where you fix what they ask: a comment icon
 * in the gutter, the latest comment after an unresolved thread's line, and the whole thread on hover, with a link
 * that opens it in the pull request's diff. The lines are the pull request's; local edits after loading move them
 * along, but commits that aren't pushed yet can put them a few lines off.
 */
export function decorateComments(model: monaco.editor.ITextModel) {
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
