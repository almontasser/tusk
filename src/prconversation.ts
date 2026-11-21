// Pull requests: the Conversation tab's parts. The timeline's events, reactions, quoting, hiding comments,
// dismissing reviews, saved replies, and folding long conversations. prpage.ts lays them out.
import { h } from "./dom";
import { choose, confirm, pick, rank } from "./palette";
import { openSettings, registerSettings, registerSettingsSection, updateSetting } from "./settings";
import { showError } from "./status";
import { el, gh, host, icon, labelChip, openUrl, pages, when } from "./prshared";
import {
  appendBlock,
  canDismiss,
  commitAuthor,
  type Entry,
  entries,
  type Event,
  folded,
  FOLD,
  HIDE_REASONS,
  quote,
  REACTABLE,
  REACTIONS,
  reasonText,
  SUBJECT,
  type Subject,
  TIMELINE_TYPES,
  type TimelineNode,
  toggleReaction,
} from "./prconversationdata";

/** The conversation as GraphQL has it: the timeline, the description's reactions, and your permission in the repository. */
export type Conversation = { pr: Subject; permission: string; entries: Entry[] };

// gh's --paginate follows $endCursor through every page; the repository's and pull request's fields repeat on each.
const TIMELINE = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    viewerPermission
    pullRequest(number: $number) {
      ${REACTABLE}
      timelineItems(first: 100, after: $endCursor, itemTypes: [${TIMELINE_TYPES.join(", ")}]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          type: __typename
          ... on IssueComment { ${SUBJECT} databaseId author { login } body createdAt url }
          ... on PullRequestReview { ${SUBJECT} author { login } body state submittedAt createdAt }
          ... on PullRequestCommit { commit { oid messageHeadline committedDate author { name user { login } } } }
          ... on HeadRefForcePushedEvent { actor { login } createdAt beforeCommit { oid } afterCommit { oid } }
          ... on LabeledEvent { actor { login } createdAt label { name color } }
          ... on UnlabeledEvent { actor { login } createdAt label { name color } }
          ... on ReviewRequestedEvent { actor { login } createdAt requestedReviewer { ... on User { login } ... on Team { name } ... on Bot { login } ... on Mannequin { login } } }
          ... on ReviewRequestRemovedEvent { actor { login } createdAt requestedReviewer { ... on User { login } ... on Team { name } ... on Bot { login } ... on Mannequin { login } } }
          ... on RenamedTitleEvent { actor { login } createdAt previousTitle currentTitle }
          ... on ReadyForReviewEvent { actor { login } createdAt }
          ... on ConvertToDraftEvent { actor { login } createdAt }
          ... on ClosedEvent { actor { login } createdAt }
          ... on ReopenedEvent { actor { login } createdAt }
          ... on MergedEvent { actor { login } createdAt mergeRefName commit { oid } }
          ... on HeadRefDeletedEvent { actor { login } createdAt headRefName }
          ... on CrossReferencedEvent { actor { login } createdAt isCrossRepository source { ... on Issue { number title url } ... on PullRequest { number title url } } }
          ... on ReviewDismissedEvent { actor { login } createdAt dismissalMessage review { author { login } } }
        }
      }
    }
  }
}`;

/** Loads pull request `number`'s whole timeline. Null when GraphQL can't give it, such as on an older GitHub Enterprise. */
export async function loadConversation(number: number): Promise<Conversation | null> {
  try {
    const out = await gh("api", "graphql", "--paginate", "-F", "owner={owner}", "-F", "name={repo}", "-F", `number=${number}`, "-f", `query=${TIMELINE}`, "--jq", ".data.repository");
    const pages: { viewerPermission: string; pullRequest: Subject & { timelineItems: { nodes: TimelineNode[] } } }[] = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    if (!pages.length) return null;
    const { timelineItems: _, ...pr } = pages[0].pullRequest;
    return { pr, permission: pages[0].viewerPermission ?? "", entries: entries(pages.flatMap((p) => p.pullRequest.timelineItems.nodes)) };
  } catch (e) {
    console.warn("[prs] Can't load the timeline", e);
    return null;
  }
}

/** Runs a GraphQL mutation with string variables. */
const mutate = (query: string, vars: Record<string, string>) => gh("api", "graphql", "-f", `query=${query}`, ...Object.entries(vars).flatMap(([k, v]) => ["-f", `${k}=${v}`]));

// ---- Events ----

/** A one-line event in the timeline, such as a label added or a force push. */
export function eventRow(e: Event, at: string, repo: string) {
  const row = el("div", `pr-small-event ${e.kind}`);
  row.append(icon(e.icon), el("strong", "", e.user), " ");
  for (const p of e.parts) {
    if (typeof p === "string") row.append(p);
    else if ("code" in p) row.append(el("code", "", p.code));
    else if ("label" in p) row.append(labelChip(p.label));
    else if ("del" in p) row.append(el("del", "", p.del));
    else if ("strong" in p) row.append(el("strong", "", p.strong));
    else row.append(link(p.link, p.url, repo));
  }
  if (at) row.append(when(at));
  return row;
}

/** A link that opens in the browser; only links on the pull request's own host. */
function link(text: string, url: string, repo: string) {
  const a = el("a", "", text);
  if (url.startsWith(new URL(repo).origin)) {
    a.href = url;
    a.onclick = (e) => (e.preventDefault(), openUrl(url));
  }
  return a;
}

/** A run of commits pushed one after another: who added how many, then a line per commit, which `open` shows. */
export function commitsRow(commits: Extract<Entry, { commits: unknown }>["commits"], at: string, open: (oid: string) => unknown) {
  const box = el("div", "pr-small-event pr-commits-event");
  const authors = [...new Set(commits.map(commitAuthor))];
  box.append(icon("git-commit"), el("strong", "", authors.join(", ")), ` added ${commits.length} ${commits.length === 1 ? "commit" : "commits"}`);
  if (at) box.append(when(at));
  const list = el("ul", "pr-event-commits");
  for (const c of commits) {
    const b = el("button", "link", c.messageHeadline);
    b.title = `Show the changes of ${c.oid.slice(0, 7)}`;
    b.onclick = () => open(c.oid);
    const li = el("li");
    li.append(b, " ", el("code", "hash", c.oid.slice(0, 7)));
    list.append(li);
  }
  box.append(list);
  return box;
}

// ---- Comment actions: reactions, quote, hide, dismiss ----

/** Hidden comments you opened with Show, by node ID, so a refresh keeps them open. */
const shownHidden = new Set<string>();

type Decor = {
  number: number;
  user: string;
  body: string;
  subject?: Subject;
  reload: () => unknown;
  /** A review to offer Dismiss on: its state, and your permission in the repository. */
  review?: { state: string; permission: string };
};

/**
 * Adds to a comment drawn by commentBlock (its meta line, then its body): Quote, Hide or Unhide when you can
 * moderate, Dismiss for a review, reactions under the body, and a fold over a hidden comment. While you edit it,
 * the comment stays as commentBlock drew it.
 */
export function decorate(parts: HTMLElement[], d: Decor): HTMLElement[] {
  const [meta] = parts;
  const body = parts[parts.length - 1];
  if (!body.classList.contains("markdown")) return parts;
  const action = (label: string, title: string, run: () => unknown) => {
    const b = el("button", "link", label);
    b.title = title;
    // Keeps your selection in the comment, which Quote uses, when you press the button.
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = run;
    meta.append(" · ", b);
  };
  action("Quote", "Quote this comment, or the text you selected in it, in the comment box", () => quoteInto(d.number, body, d.body));
  const s = d.subject;
  if (s?.viewerCanMinimize && !s.isMinimized) action("Hide", "Hide this comment for everyone", () => hide(d.user, s, d.reload));
  if (s?.viewerCanUnminimize && s.isMinimized) action("Unhide", "Show this comment to everyone again", () => unhide(d.user, s, d.reload));
  const dismissButton = s && d.review && dismissLink(d.user, s.id, d.review.state, d.review.permission, d.reload);
  if (dismissButton) meta.append(" · ", dismissButton);
  const bar = s && reactionBar(s);
  const rest = bar ? [body, bar] : [body];
  if (s?.isMinimized && !shownHidden.has(s.id)) {
    const fold = el("div", "pr-hidden-comment");
    const reason = reasonText(s.minimizedReason);
    const show = el("button", "link", "Show comment");
    fold.append(icon("eye-closed"), ` This comment was hidden${reason ? ` as ${reason}` : ""}. `, show);
    show.onclick = () => (shownHidden.add(s.id), fold.replaceWith(...rest));
    return [...parts.slice(0, -1), fold];
  }
  return [...parts.slice(0, -1), ...rest];
}

/** Dismiss for a review, when it approved or requested changes and you can write to the repository; else null. */
export function dismissLink(user: string, reviewId: string, state: string, permission: string, reload: () => unknown) {
  if (!canDismiss(state, permission)) return null;
  const b = el("button", "link", "Dismiss");
  b.title = "Dismiss this review, so it no longer counts toward merging";
  b.onclick = () => dismiss(user, reviewId, reload);
  return b;
}

/** Puts a comment, or the part of it you selected, as a quote at the end of the comment box. */
function quoteInto(number: number, body: HTMLElement, markdownText: string) {
  const text = pages.get(number)?.el.querySelector<HTMLTextAreaElement>(".pr-composer textarea");
  if (!text) return;
  const sel = getSelection();
  const selected = sel && !sel.isCollapsed && body.contains(sel.anchorNode) && body.contains(sel.focusNode) ? sel.toString() : "";
  text.value = appendBlock(text.value, quote(selected.trim() ? selected : markdownText));
  text.dispatchEvent(new Event("input")); // Saves the draft.
  text.focus();
  text.setSelectionRange(text.value.length, text.value.length);
  text.scrollIntoView({ block: "nearest" });
}

/** The reactions under a comment: a button per reaction given, yours highlighted, and one to add a reaction. */
function reactionBar(s: Subject): HTMLElement | null {
  if (!s.viewerCanReact && !s.reactionGroups?.some((g) => g.reactors.totalCount)) return null;
  const bar = el("div", "pr-reactions");
  bar.role = "group";
  bar.ariaLabel = "Reactions";
  let busy = false;
  const toggle = async (content: string) => {
    if (busy || !s.viewerCanReact) return;
    busy = true;
    const before = s.reactionGroups ?? [];
    const adding = !before.find((g) => g.content === content)?.viewerHasReacted;
    s.reactionGroups = toggleReaction(before, content);
    draw();
    try {
      const field = adding ? "addReaction" : "removeReaction";
      await mutate(`mutation($id: ID!, $content: ReactionContent!) { ${field}(input: { subjectId: $id, content: $content }) { clientMutationId } }`, { id: s.id, content });
    } catch (e) {
      s.reactionGroups = before;
      draw();
      showError(`Can't ${adding ? "add" : "remove"} the reaction`, e);
    } finally {
      busy = false;
    }
  };
  const draw = () => {
    const chips = REACTIONS.flatMap(([content, emoji, name]) => {
      const g = s.reactionGroups?.find((x) => x.content === content);
      if (!g?.reactors.totalCount) return [];
      const b = el("button", "pr-reaction", `${emoji} ${g.reactors.totalCount}`);
      b.setAttribute("aria-pressed", String(g.viewerHasReacted));
      b.title = `${name}: ${g.reactors.totalCount}${g.viewerHasReacted ? " (you reacted; click to remove)" : ""}`;
      b.ariaLabel = b.title;
      b.disabled = !s.viewerCanReact;
      b.onclick = () => toggle(content);
      return [b];
    });
    bar.replaceChildren(...chips);
    if (!s.viewerCanReact) return;
    const add = el("button", "pr-reaction pr-add-reaction codicon codicon-reactions");
    add.title = add.ariaLabel = "Add a reaction";
    add.onclick = () =>
      pick(
        "Add or remove a reaction",
        (q) =>
          rank(
            q,
            REACTIONS.map(([content, emoji, name]) => {
              const mine = s.reactionGroups?.find((g) => g.content === content)?.viewerHasReacted;
              return { label: `${emoji} ${name}`, detail: mine ? "Remove your reaction" : "", run: () => toggle(content) };
            }),
          ),
        0,
        { value: "", anchor: add, numbered: true },
      );
    bar.append(add);
  };
  draw();
  return bar;
}

/** Hides a comment for everyone, with a reason, after you confirm. */
async function hide(user: string, s: Subject, reload: () => unknown) {
  const name = await choose(`Hide ${user}'s comment as`, HIDE_REASONS.map(([, n]) => n));
  const classifier = HIDE_REASONS.find(([, n]) => n === name)?.[0];
  if (!classifier || !(await confirm(`Hide ${user}'s comment as ${name!.toLowerCase()}? It folds for everyone, who can still show it.`, "Hide Comment"))) return;
  try {
    await mutate("mutation($id: ID!, $classifier: ReportedContentClassifiers!) { minimizeComment(input: { subjectId: $id, classifier: $classifier }) { clientMutationId } }", { id: s.id, classifier });
    host.status(`Hid ${user}'s comment`);
    await reload();
  } catch (e) {
    showError("Can't hide the comment", e);
  }
}

async function unhide(user: string, s: Subject, reload: () => unknown) {
  if (!(await confirm(`Unhide ${user}'s comment? It shows for everyone again.`, "Unhide Comment"))) return;
  try {
    await mutate("mutation($id: ID!) { unminimizeComment(input: { subjectId: $id }) { clientMutationId } }", { id: s.id });
    host.status(`Unhid ${user}'s comment`);
    await reload();
  } catch (e) {
    showError("Can't unhide the comment", e);
  }
}

/** Asks for one line of text in the palette, such as a name. Null for Escape. */
function ask(title: string, value = "", action = "Press ⏎"): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    pick(title, (q) => (q.trim() ? [{ label: q.trim(), detail: action, run: () => ((done = true), resolve(q.trim())) }] : []), 0, { value, title, onCancel: () => !done && resolve(null) });
  });
}

/** Dismisses a review, with the message GitHub requires, after you confirm. */
async function dismiss(user: string, reviewId: string, reload: () => unknown) {
  const message = await ask(`Why dismiss ${user}'s review? GitHub shows your message in the timeline.`, "", "Dismiss with this message");
  if (!message || !(await confirm(`Dismiss ${user}'s review? It no longer counts toward merging.`, "Dismiss Review"))) return;
  try {
    await mutate("mutation($id: ID!, $message: String!) { dismissPullRequestReview(input: { pullRequestReviewId: $id, message: $message }) { clientMutationId } }", { id: reviewId, message });
    host.status(`Dismissed ${user}'s review`);
    await reload();
  } catch (e) {
    showError("Can't dismiss the review", e);
  }
}

// ---- Long conversations ----

/** How many more items of each pull request's folded middle you showed, so a refresh keeps them shown. */
const revealed = new Map<number, number>();

/**
 * Draws a conversation's items, as GitHub does for a long one: the first and last ones, and a button that shows
 * more of the middle. Items in the fold aren't drawn, so their Markdown isn't rendered until you show them.
 */
export function foldItems(number: number, items: (() => HTMLElement)[]): HTMLElement[] {
  let { head, tail } = folded(items.length, revealed.get(number) ?? 0);
  if (head >= tail) return items.map((draw) => draw());
  const more = el("button", "pr-fold");
  const label = () => {
    const hidden = tail - head;
    more.replaceChildren(icon("unfold"), ` ${hidden} hidden ${hidden === 1 ? "item" : "items"} · Show ${Math.min(FOLD.step, hidden)} more`);
  };
  label();
  more.onclick = () => {
    revealed.set(number, (revealed.get(number) ?? 0) + FOLD.step);
    const next = folded(items.length, revealed.get(number)!);
    const shown = items.slice(head, Math.min(next.head, tail)).map((draw) => draw());
    if (next.head >= next.tail) return more.replaceWith(...shown);
    more.before(...shown);
    head = next.head;
    label();
  };
  return [...items.slice(0, head).map((draw) => draw()), more, ...items.slice(tail).map((draw) => draw())];
}

// ---- Saved replies ----

/** Your saved replies, name to text, in settings.json, so every project has them. */
const saved = registerSettings("Pull requests", { prSavedReplies: {} as Record<string, string> }, []);
const replies = () => saved.prSavedReplies;
const saveReplies = (next: Record<string, string>) => updateSetting("prSavedReplies", next);

/** A button beside the comment box that inserts a saved reply where the cursor is, or saves the box's text as one. */
export function savedRepliesButton(text: HTMLTextAreaElement) {
  const b = el("button", "icon-button codicon codicon-bookmark");
  b.type = "button";
  b.title = b.ariaLabel = "Saved replies";
  b.onclick = () => {
    const insert = (body: string) => {
      text.focus();
      text.setRangeText(body, text.selectionStart, text.selectionEnd, "end");
      text.dispatchEvent(new Event("input"));
    };
    const items = Object.entries(replies()).map(([name, body]) => ({ label: name, detail: body.split("\n")[0], icon: "codicon-bookmark", run: () => insert(body) }));
    const draft = text.value.trim();
    const manage = [
      ...(draft ? [{ label: "Save the comment as a reply…", icon: "codicon-save", run: () => saveDraft(draft) }] : []),
      { label: "Manage saved replies…", icon: "codicon-settings-gear", run: () => openSettings("Saved replies") },
    ];
    pick(items.length ? "Insert a saved reply" : "No saved replies yet", (q) => [...rank(q, items), ...(q ? [] : manage)], 0, { value: "", anchor: b });
  };
  return b;
}

async function saveDraft(body: string) {
  const name = await ask("Name the saved reply", "", "Save");
  if (!name) return;
  if (name in replies() && !(await confirm(`Replace the saved reply "${name}"?`, "Replace"))) return;
  saveReplies({ ...replies(), [name]: body });
  host.status(`Saved the reply "${name}"`);
}

registerSettingsSection({
  group: "Saved replies",
  keywords: "pull request comment reply replies template canned",
  render() {
    const list = h("div", { class: "pr-saved-replies" });
    const row = (name: string, body: string) => {
      const title = h("input", { type: "text", value: name, ariaLabel: "Reply name", placeholder: "Name" });
      const text = h("textarea", { value: body, ariaLabel: `Text of ${name || "the new reply"}`, placeholder: "Text (Markdown)", rows: 3 });
      return { title, text };
    };
    const draw = () => {
      list.replaceChildren(
        ...Object.entries(replies()).map(([name, body]) => {
          const { title, text } = row(name, body);
          // A change saves at once; renaming keeps the reply's place in the list.
          const save = () => {
            const next = title.value.trim();
            if (!next) return void (title.value = name);
            if (next !== name && next in replies()) return showError(`Can't rename "${name}"`, `A saved reply named "${next}" exists.`), void (title.value = name);
            saveReplies(Object.fromEntries(Object.entries(replies()).map(([k, v]) => (k === name ? [next, text.value] : [k, v]))));
            draw();
          };
          title.onchange = text.onchange = save;
          const remove = h("button", { type: "button", class: "icon-button", title: `Delete ${name}`, ariaLabel: `Delete ${name}`, onclick: () => (saveReplies(Object.fromEntries(Object.entries(replies()).filter(([k]) => k !== name))), draw()) }, icon("trash"));
          return h("div", { class: "pr-saved-reply" }, h("div", { class: "setting-control" }, title, remove), text);
        }),
      );
      const { title, text } = row("", "");
      const add = () => {
        const name = title.value.trim();
        if (!name || !text.value.trim()) return (name ? text : title).focus();
        if (name in replies()) return showError(`Can't add "${name}"`, `A saved reply named "${name}" exists.`);
        saveReplies({ ...replies(), [name]: text.value });
        draw();
      };
      list.append(h("div", { class: "pr-saved-reply" }, h("p", { class: "setting-subhead" }, "New saved reply"), h("div", { class: "setting-control" }, title, h("button", { type: "button", onclick: add }, "Add")), text));
    };
    draw();
    return h("div", {}, h("p", { class: "muted" }, "Replies you reuse in pull request comments. Insert one with the bookmark button beside the comment box."), list);
  },
});
