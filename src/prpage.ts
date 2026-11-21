// Pull requests: the pull request's editor tab (header, sections, status box, side column) and its live refresh.
import { monaco } from "./editor";
import { git, gitStatus, gitTask } from "./git";
import { type Check, checksSummary, checkState } from "./gitparse";
import { showCommitDiff } from "./history";
import { listNav } from "./listnav";
import { errorText, showError, status, withProgress } from "./status";
import { showEditorView } from "./terminal";
import { toast } from "./dom";
import { isMac, mod } from "./platform.ts";
import { $, avatar, DETAIL_FIELDS, type Details, el, gh, host, icon, labelRow, loadMarkdown, ltr, markdown, me, myLogin, openUrl, type Page, pages, repoUrl, type Section, statePill, type Thread, when } from "./prshared";
import { commentBlock, expanded, lineComments, restTarget, reviewTarget, type Target, writer } from "./prthreads";
import { deletePending, loadPending, pendingReview, submitReview } from "./prreview";
import { loadPullRequests, markOpenRows, markSeen, problemItem } from "./prlist";
import { drawChecks } from "./prchecks";
import { drawZones, lastReviewed, nextUnresolved, prepareDiff, replyTo, setResolved, setViewed, showFileDiff, shown, type Since, sinceReview, viewedFiles } from "./prdiff";
import { editAssignees, editLabels, merge, more, requestReview, updateBranch } from "./practions";
import { branchThreads, decorateComments, updateBranchPullRequest } from "./preditor";

// ---- Details ----

/**
 * What you typed in the comment box, by pull request, kept in this computer's storage per project, so a refresh,
 * closing the tab, or restarting the app keeps it until you send it.
 */
const drafts = {
  key: () => `pr-drafts:${host.root()}`,
  all(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem(this.key()) ?? "{}");
    } catch {
      return {};
    }
  },
  get(number: number): string | undefined {
    return this.all()[number];
  },
  set(number: number, text: string) {
    const all = this.all();
    if (text.trim()) all[number] = text;
    else delete all[number];
    try {
      localStorage.setItem(this.key(), JSON.stringify(all));
    } catch {
      // Storage is off; the draft lasts until the tab redraws.
    }
  },
  delete(number: number) {
    this.set(number, "");
  },
};
/** Pull requests whose Files tab shows only the changes since your last review. */
const sinceMode = new Set<number>();

/**
 * Opens a pull request in its own editor tab, beside the tabs of other pull requests, or brings its tab to the
 * front when it's open already. Either way it loads the pull request again.
 */
export function showPullRequest(number: number, title = "") {
  let entry = pages.get(number);
  if (!entry) {
    entry = { el: el("div", "pr-page"), section: "conversation", participants: [] };
    entry.el.replaceChildren(el("p", "muted pr-loading", "Loading…"));
    pages.set(number, entry);
  }
  const tab = entry;
  showEditorView(title ? `#${number} ${title}` : `#${number}`, tab.el, "git-pull-request", () => {
    // Closing the tab parks its element in the document; this pull request's tab is gone for good.
    tab.el.remove();
    if (pages.get(number) === tab) pages.delete(number);
    markOpenRows();
  });
  tab.el.hidden = false;
  markOpenRows();
  return renderPullRequest(number);
}

/**
 * Loads a pull request and draws its tab, keeping the tab's section, scroll, and comment draft. Does nothing when
 * the pull request has no tab, and stops when its tab closes while it loads.
 */
export async function renderPullRequest(number: number) {
  const entry = pages.get(number);
  if (!entry) return;
  const libraries = loadMarkdown();
  // Refreshing, such as after you comment, keeps the pull request on screen until the new version is ready.
  const page = entry.el;
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
    if (pages.get(number) !== entry) return;
    const list = el("ul", "pr-checks");
    list.append(problemItem(`Can't load #${number}`, e, () => renderPullRequest(number)));
    page.replaceChildren(list);
    return;
  }
  await libraries;
  if (pages.get(number) !== entry) return; // The tab closed meanwhile.
  entry.viewed = viewed;
  markSeen(number, pr.updatedAt);
  entry.participants = [...new Set([pr.author.login, ...pr.latestReviews.map((r) => r.author.login), ...pr.comments.map((c) => c.author.login), ...threads.flatMap((t) => t.comments.map((c) => c.user)), ...pr.assignees.map((a) => a.login)])];
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
    files: () => fileTab(),
  };
  const show = (s: Section) => {
    entry.section = s;
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
      const draw = () => card.replaceChildren(...commentBlock(number, user, body, target, repo, draw, reload, at, label));
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
        const draw = () => card.replaceChildren(...commentBlock(number, c.user, c.body, restTarget(`repos/{owner}/{repo}/pulls/comments/${c.id}`), repo, draw, reload, c.created_at));
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
        link(pendingReview(number) && t.node ? "Reply (joins your review)" : "Reply", () => {
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
          form.append(writer(text, repo, number), buttons);
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
    const review = pendingReview(number);
    const hasPending = !!review;
    const pendingComments = review?.comments ?? [];
    const box = el("div", "pr-composer");
    if (pendingComments.length) {
      const list = el("ul", "pr-pending");
      const head = el("li", "pr-pending-head", `Your pending review · ${pendingComments.length} ${pendingComments.length === 1 ? "comment" : "comments"}`);
      list.append(head);
      for (const c of pendingComments) {
        const li = el("li");
        li.append(icon("file-code"), el("span", "name", ltr(c.line === null ? c.path : `${c.path}:${c.start_line ? `${c.start_line}–` : ""}${c.line}`)), el("span", "muted", c.body.split("\n")[0]));
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
    // Typing is saved as you pause, so a long comment doesn't write storage on every key.
    let saving: ReturnType<typeof setTimeout> | undefined;
    text.oninput = () => (clearTimeout(saving), (saving = setTimeout(() => drafts.set(number, text.value), 300)));
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
          clearTimeout(saving);
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
    text.onkeydown = (e) => void (e.key === "Enter" && mod(e) && buttons.querySelector<HTMLButtonElement>("button.primary")!.click());
    const hint = el("span", "muted pr-hint", `${isMac ? "⌘" : "Ctrl+"}⏎ to ${hasPending ? "submit" : "comment"}`);
    buttons.prepend(hint);
    box.append(writer(text, repo, number), buttons);
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
  /**
   * The Files tab. After you've reviewed and the author pushed again, it can show only what changed since your
   * review, as GitHub's "changes since your last review" does.
   */
  function fileTab(): HTMLElement[] {
    const oid = lastReviewed(pr);
    if (!oid) return fileSection();
    const since = sinceMode.has(number);
    const toggle = el("div", "segmented pr-scope");
    const option = (label: string, on: boolean, title: string) => {
      const b = el("button", "", label);
      b.title = title;
      b.setAttribute("aria-pressed", String(on === since));
      b.onclick = () => (on ? sinceMode.add(number) : sinceMode.delete(number), show("files"));
      toggle.append(b);
    };
    option("All changes", false, `Every file the pull request changes, from ${pr.baseRefName}`);
    option(`Since your review (${oid.slice(0, 7)})`, true, "Only what changed after the commit you last reviewed");
    if (!since) return [toggle, ...fileSection()];
    const holder = el("div");
    holder.append(el("p", "muted", "Comparing with your last review…"));
    sinceReview(pr, oid).then(
      (changes) => holder.isConnected && holder.replaceChildren(...(changes.files.length ? fileSection(changes) : [el("p", "muted", "Nothing changed since your review.")])),
      (e) => holder.isConnected && holder.replaceChildren(el("p", "muted", `Can't compare with your last review: ${errorText(e)}`)),
    );
    return [toggle, holder];
  }

  function fileSection(since?: Since) {
    const list = since?.files ?? pr.files;
    const bar = el("div", "pr-section-bar");
    const progress = el("progress");
    const count = el("span", "muted");
    const countViewed = () => {
      const n = list.filter((f) => viewed.get(f.path)).length;
      progress.max = list.length;
      progress.value = n;
      count.textContent = `${n} of ${list.length} viewed`;
    };
    countViewed();
    const totals = el("span", "pr-totals");
    const sum = (k: "additions" | "deletions") => list.reduce((n, f) => n + f[k], 0);
    totals.append(el("span", "added", `+${sum("additions")}`), " ", el("span", "deleted", `−${sum("deletions")}`));
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
    const rows = list.map((f) => {
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
      li.onclick = () => showFileDiff(pr, f.path, threads, undefined, since);
      return { path: f.path, li };
    });
    // Many files group under their folders, as in GitHub's file tree, and a box filters them by path.
    const grouped = list.length > 5;
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
    if (list.length > 8) {
      const filter = el("input");
      filter.type = "search";
      filter.placeholder = "Filter files";
      filter.ariaLabel = "Filter files";
      filter.className = "pr-file-filter";
      filter.oninput = () => draw(filter.value);
      filter.onkeydown = (e) => void (e.key === "ArrowDown" && (e.preventDefault(), files.focus()));
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
  sideBlock("Assignees", peopleList(pr.assignees.map((a) => a.login), repo, "No one"), () => editAssignees(pr, run));
  sideBlock("Labels", pr.labels.length ? labelRow(pr.labels) : el("div", "muted", "None yet"), () => editLabels(pr, run));
  // Issues the pull request closes when it merges, from "Fixes #12" in its description or a link on GitHub.
  if (pr.closingIssuesReferences.length) {
    const list = el("ul", "pr-reviewer-list");
    for (const i of pr.closingIssuesReferences) {
      const li = el("li");
      const other = `${i.repository.owner.login}/${i.repository.name}` !== repo.replace(/^https?:\/\/[^/]+\//, "");
      const link = el("button", "link", `${other ? `${i.repository.owner.login}/${i.repository.name}` : ""}#${i.number}`);
      link.title = `Open ${i.url}`;
      link.onclick = () => openUrl(i.url);
      li.append(icon("issues", "checks-passed"), link);
      list.append(li);
    }
    sideBlock("Closes", list);
  }
  if (pr.milestone) {
    const m = el("div");
    m.append(icon("milestone", "muted"), ` ${pr.milestone.title}`);
    sideBlock("Milestone", m);
  }

  // ---- Put it together, keeping the scroll position of a refresh ----
  const scroll = page.scrollTop;
  const main = el("div", "pr-main");
  main.append(tabs, body);
  const grid = el("div", "pr-grid");
  grid.append(main, side);
  page.replaceChildren(head, grid);
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
      if (entry.section !== "conversation") show("conversation");
      page.querySelector<HTMLTextAreaElement>(".pr-composer textarea")?.focus();
    } else return;
    e.preventDefault();
  };
  show(entry.section);
  page.scrollTop = scroll;
  watchPullRequest(pr, entry);
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

/** People with their avatars, or `none` when there are none. */
function peopleList(logins: string[], repo: string, none: string) {
  if (!logins.length) return el("div", "muted", none);
  const list = el("ul", "pr-reviewer-list");
  for (const login of logins) {
    const li = el("li");
    li.append(avatar(login, repo), el("span", "pr-row-main", login));
    list.append(li);
  }
  return list;
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

/**
 * While checks run, GitHub is still working out whether it can merge, or the pull request is under two minutes old
 * (before GitHub has queued its checks), looks at them every 15 seconds and redraws the tab when they or the merge state change, so the
 * checks, the status box, and the tab counts stay current. A tab where you're typing or editing a comment waits for
 * the next tick. It stops once the tab closes or shows a newer version of the pull request.
 */
function watchPullRequest(pr: Details, entry: Page) {
  const settling = checksSummary(pr.statusCheckRollup) === "pending" || pr.mergeStateStatus === "UNKNOWN" || Date.now() - Date.parse(pr.createdAt) < 120_000;
  if (!settling || pr.state !== "OPEN") return;
  const page = entry.el;
  const drawn = page.firstElementChild;
  const current = () => pages.get(pr.number) === entry && page.firstElementChild === drawn;
  const key = (p: Pick<Details, "statusCheckRollup" | "mergeStateStatus">) => JSON.stringify([p.mergeStateStatus, (p.statusCheckRollup ?? []).map(checkState)]);
  const before = key(pr);
  setTimeout(async function tick() {
    if (!current()) return;
    // A hidden tab keeps watching, so it can tell you when checks finish while you work elsewhere; only a comment
    // you're editing or writing in this tab holds its redraw, not one in another pull request's tab.
    const busy = !!page.querySelector(".pr-comment-form") || (page.contains(document.activeElement) && document.activeElement instanceof HTMLTextAreaElement);
    if (!busy) {
      try {
        const now = JSON.parse(await gh("pr", "view", String(pr.number), "--json", "statusCheckRollup,mergeStateStatus"));
        if (!current()) return;
        if (key(now) !== before) {
          const result = checksSummary(now.statusCheckRollup);
          if (checksSummary(pr.statusCheckRollup) === "pending" && result !== "pending") {
            updateBranchPullRequest();
            // The list's row still shows the checks running.
            if ($("pr-list").querySelector(`li.pr[data-key="${pr.number}"]`)) loadPullRequests();
            const failed = (now.statusCheckRollup as Check[]).filter((c) => checkState(c) === "failed").length;
            const visible = !page.hidden && !page.closest("[hidden]");
            const message = failed ? `${failed} ${failed === 1 ? "check" : "checks"} failed on #${pr.number}.` : `Checks passed on #${pr.number}.`;
            // Said in the status bar, and in a toast that opens the pull request when its tab isn't in front.
            status(message, "app", "info");
            if (!visible) toast(message, { kind: failed ? "error" : "info", action: { label: `Open #${pr.number}`, run: () => showPullRequest(pr.number, pr.title) }, timeout: 15000 });
          }
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

/** Redraws the threads wherever the pull request shows them: its diff and its tab. */
export async function threadsChanged(number: number) {
  if (shown?.pr.number === number) (shown.threads = await lineComments(number).catch(() => shown!.threads)), drawZones();
  if (branchThreads?.number === number) {
    branchThreads.threads = await lineComments(number).catch(() => branchThreads!.threads);
    for (const model of monaco.editor.getModels()) decorateComments(model);
  }
  if (pages.has(number)) renderPullRequest(number);
}
