// Pull requests: the Conversation tab's data, with no DOM or Tauri, so the tests can run it (prconversationdata.test.ts).

/** A reaction's count and whether you gave it, as GraphQL's `reactionGroups` has it. */
export type ReactionGroup = { content: string; viewerHasReacted: boolean; reactors: { totalCount: number } };

/**
 * What you can do to a comment, a review, or the pull request's description on GitHub: react to it, and hide it
 * when you moderate the repository. `id` is its GraphQL node ID.
 */
export type Subject = {
  id: string;
  viewerCanReact?: boolean;
  viewerCanMinimize?: boolean;
  viewerCanUnminimize?: boolean;
  isMinimized?: boolean;
  minimizedReason?: string | null;
  reactionGroups?: ReactionGroup[];
};

type Actor = { login: string } | null;
type Commit = { oid: string; messageHeadline: string; committedDate: string; author: { name: string; user: { login: string } | null } | null };

/** An item of GraphQL's `timelineItems`, by its `type` (the `__typename`). Fields depend on the type. */
export type TimelineNode = Partial<Subject> & {
  type: string;
  actor?: Actor;
  author?: Actor;
  createdAt?: string;
  submittedAt?: string | null;
  databaseId?: number;
  body?: string;
  state?: string;
  url?: string;
  commit?: Commit;
  beforeCommit?: { oid: string } | null;
  afterCommit?: { oid: string } | null;
  label?: { name: string; color: string };
  requestedReviewer?: { login?: string; name?: string } | null;
  previousTitle?: string;
  currentTitle?: string;
  mergeRefName?: string;
  headRefName?: string;
  isCrossRepository?: boolean;
  source?: { number?: number; title?: string; url?: string } | null;
  dismissalMessage?: string | null;
  review?: { author: Actor } | null;
};

/** The timeline item types the Conversation tab shows. Line comment threads come from REST (prthreads.ts). */
export const TIMELINE_TYPES = [
  "ISSUE_COMMENT",
  "PULL_REQUEST_REVIEW",
  "PULL_REQUEST_COMMIT",
  "HEAD_REF_FORCE_PUSHED_EVENT",
  "LABELED_EVENT",
  "UNLABELED_EVENT",
  "REVIEW_REQUESTED_EVENT",
  "REVIEW_REQUEST_REMOVED_EVENT",
  "RENAMED_TITLE_EVENT",
  "READY_FOR_REVIEW_EVENT",
  "CONVERT_TO_DRAFT_EVENT",
  "CLOSED_EVENT",
  "REOPENED_EVENT",
  "MERGED_EVENT",
  "HEAD_REF_DELETED_EVENT",
  "CROSS_REFERENCED_EVENT",
  "REVIEW_DISMISSED_EVENT",
];

/** One entry of the conversation: a timeline node, or a run of commits pushed one after another. */
export type Entry = { at: string; node: TimelineNode } | { at: string; commits: Commit[] };

/**
 * The timeline in GitHub's order, with runs of commits as one entry, and the close that comes with a merge left
 * out. A commit has no date of its own in the timeline (its commit date can be months before the push), so it takes
 * the date of the item before it, which places line comment threads, sorted in by date, after it.
 */
export function entries(nodes: TimelineNode[]): Entry[] {
  const out: Entry[] = [];
  let at = "";
  const merges = new Set(nodes.filter((n) => n.type === "MergedEvent").map((n) => n.createdAt));
  nodes.forEach((n) => {
    if (n.type === "PullRequestCommit" && n.commit) {
      const last = out[out.length - 1];
      if (last && "commits" in last) last.commits.push(n.commit);
      else out.push({ at: at || n.commit.committedDate, commits: [n.commit] });
      return;
    }
    // GitHub records a merge as a merge and a close at the same time; it shows only the merge.
    if (n.type === "ClosedEvent" && merges.has(n.createdAt)) return;
    at = n.submittedAt || n.createdAt || at;
    out.push({ at, node: n });
  });
  return out;
}

/**
 * Sorts `extra` (such as line comment threads) into `list` by date, after items of the same date, keeping `list`'s
 * own order. Both must be sorted by date already.
 */
export function mergeByDate<T extends { at: string }>(list: T[], extra: T[]): T[] {
  const time = (at: string) => Date.parse(at) || 0;
  const out: T[] = [];
  let j = 0;
  for (const item of list) {
    while (j < extra.length && time(extra[j].at) < time(item.at)) out.push(extra[j++]);
    out.push(item);
  }
  return out.concat(extra.slice(j));
}

/** A piece of an event's line: text, or text shown as code, a label, a deleted title, or a link. */
export type Part = string | { code: string } | { label: { name: string; color: string } } | { del: string } | { strong: string } | { link: string; url: string };
/** A one-line event: who did it, what, its codicon, and a class for its color. */
export type Event = { user: string; parts: Part[]; icon: string; kind: string };

const short = (oid?: string) => ({ code: (oid ?? "").slice(0, 7) });
const who = (actor: Actor | undefined) => actor?.login ?? "ghost";

/** The one-line text of a timeline event, or null for items that aren't events, such as comments. */
export function eventLine(n: TimelineNode): Event | null {
  const user = who(n.actor);
  const reviewer = n.requestedReviewer?.login ?? n.requestedReviewer?.name ?? "someone";
  const e = (parts: Part[], icon: string, kind = ""): Event => ({ user, parts, icon, kind });
  switch (n.type) {
    case "HeadRefForcePushedEvent":
      return e(["force-pushed the branch from ", short(n.beforeCommit?.oid), " to ", short(n.afterCommit?.oid)], "repo-force-push");
    case "LabeledEvent":
      return e(["added the ", { label: n.label! }, " label"], "tag");
    case "UnlabeledEvent":
      return e(["removed the ", { label: n.label! }, " label"], "tag");
    case "ReviewRequestedEvent":
      return e(reviewer === user ? ["requested a review"] : ["requested a review from ", { strong: reviewer }], "eye");
    case "ReviewRequestRemovedEvent":
      return e(["removed the review request for ", { strong: reviewer }], "eye-closed");
    case "RenamedTitleEvent":
      return e(["changed the title ", { del: n.previousTitle ?? "" }, " ", { strong: n.currentTitle ?? "" }], "edit");
    case "ReadyForReviewEvent":
      return e(["marked this pull request as ready for review"], "eye", "open");
    case "ConvertToDraftEvent":
      return e(["marked this pull request as a draft"], "git-pull-request-draft", "draft");
    case "ClosedEvent":
      return e(["closed this pull request"], "git-pull-request-closed", "closed");
    case "ReopenedEvent":
      return e(["reopened this pull request"], "git-pull-request", "open");
    case "MergedEvent":
      return e(["merged commit ", short(n.commit?.oid), " into ", { code: n.mergeRefName ?? "" }], "git-merge", "merged");
    case "HeadRefDeletedEvent":
      return e(["deleted the ", { code: n.headRefName ?? "" }, " branch"], "trash");
    case "CrossReferencedEvent": {
      const url = n.source?.url ?? "";
      // From another repository, GitHub names it owner/repo#123.
      const name = n.isCrossRepository ? url.replace(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+).*$/, "$1#$2") : `#${n.source?.number ?? ""}`;
      return e(["mentioned this in ", { link: `${name} ${n.source?.title ?? ""}`.trim(), url }], "link");
    }
    case "ReviewDismissedEvent":
      return e([`dismissed ${who(n.review?.author)}'s review`, ...(n.dismissalMessage ? [`: ${n.dismissalMessage}`] : [])], "close");
  }
  return null;
}

/** The author of a run of commits, as GitHub names it: their login, or their git name. */
export const commitAuthor = (c: Commit) => c.author?.user?.login ?? c.author?.name ?? "someone";

/** Text as a Markdown quote, ready to reply under: each line behind "> ", then an empty line. */
export function quote(text: string) {
  const lines = text.trim().replace(/\r\n?/g, "\n").split("\n");
  return `${lines.map((l) => (l ? `> ${l}` : ">")).join("\n")}\n\n`;
}

/** Adds `insert` to a comment box's text: after what's there, on a line of its own. */
export function appendBlock(text: string, insert: string) {
  if (!text.trim()) return insert;
  return `${text.replace(/\s*$/, "")}\n\n${insert}`;
}

/**
 * An emoji as text, from its image URL in GitHub's emoji list (`gh api emojis`), whose file name holds the code
 * points, such as `unicode/1f44d.png`. The names drop the joiners and variation selectors that sequences need, so
 * only those that can be rebuilt are text: one code point, a keycap, or a flag. Null means use the image.
 */
export function emojiText(url: string): string | null {
  const hex = url.match(/\/unicode\/([0-9a-f]+(?:-[0-9a-f]+)*)\.png/)?.[1];
  if (!hex) return null;
  const points = hex.split("-").map((h) => parseInt(h, 16));
  // U+FE0F asks for the emoji form of symbols that also have a text form, such as ☺ and ©.
  if (points.length === 1) return String.fromCodePoint(points[0], 0xfe0f);
  if (points.length === 2 && points[1] === 0x20e3) return String.fromCodePoint(points[0], 0xfe0f, 0x20e3);
  const flag = (p: number) => p >= 0x1f1e6 && p <= 0x1f1ff;
  if (points.length === 2 && points.every(flag)) return String.fromCodePoint(...points);
  return null;
}

/** An emoji that has no text form, shown as GitHub's image. */
export type EmojiImage = { name: string; url: string };

/**
 * Text with `:name:` shortcodes replaced, as GitHub does: by the emoji as text where it can be, else by an image.
 * Names that aren't in `emojis` (name to image URL) stay as typed.
 */
export function emojify(text: string, emojis: Record<string, string>): (string | EmojiImage)[] {
  const out: (string | EmojiImage)[] = [];
  const add = (p: string | EmojiImage) => (typeof p === "string" && typeof out[out.length - 1] === "string" ? (out[out.length - 1] += p) : out.push(p));
  const pattern = /:([a-z0-9_+-]+):/g;
  let from = 0;
  for (let m; (m = pattern.exec(text)); ) {
    const url = Object.hasOwn(emojis, m[1]) ? emojis[m[1]] : undefined;
    // An unknown name's closing colon can open the next one, as in `:nope::tada:`.
    if (!url) {
      pattern.lastIndex = m.index + m[1].length + 1;
      continue;
    }
    add(text.slice(from, m.index));
    add(emojiText(url) ?? { name: m[1], url });
    from = pattern.lastIndex;
  }
  add(text.slice(from));
  return out.filter((p) => p !== "");
}

/** GitHub's reactions, in its order, with their emoji and names. */
export const REACTIONS: [content: string, emoji: string, name: string][] = [
  ["THUMBS_UP", "👍", "Thumbs up"],
  ["THUMBS_DOWN", "👎", "Thumbs down"],
  ["LAUGH", "😄", "Laugh"],
  ["HOORAY", "🎉", "Hooray"],
  ["CONFUSED", "😕", "Confused"],
  ["HEART", "❤️", "Heart"],
  ["ROCKET", "🚀", "Rocket"],
  ["EYES", "👀", "Eyes"],
];

/** The groups after you add or remove your `content` reaction. */
export function toggleReaction(groups: ReactionGroup[], content: string): ReactionGroup[] {
  const found = groups.some((g) => g.content === content);
  const all = found ? groups : [...groups, { content, viewerHasReacted: false, reactors: { totalCount: 0 } }];
  return all.map((g) => (g.content !== content ? g : { content, viewerHasReacted: !g.viewerHasReacted, reactors: { totalCount: Math.max(0, g.reactors.totalCount + (g.viewerHasReacted ? -1 : 1)) } }));
}

/** The reasons GitHub takes for hiding a comment, as `minimizeComment`'s classifier, with their names. */
export const HIDE_REASONS: [classifier: string, name: string][] = [
  ["SPAM", "Spam"],
  ["ABUSE", "Abuse"],
  ["OFF_TOPIC", "Off topic"],
  ["OUTDATED", "Outdated"],
  ["DUPLICATE", "Duplicate"],
  ["RESOLVED", "Resolved"],
  ["LOW_QUALITY", "Low quality"],
];

/** A hidden comment's reason as words, such as "off topic" for "off-topic" or "OFF_TOPIC". */
export const reasonText = (reason?: string | null) => (reason ?? "").toLowerCase().replace(/[-_]+/g, " ").trim();

/** Whether you can dismiss a review: it approved or requested changes, and you can write to the repository. */
export const canDismiss = (state: string, permission: string) => ["APPROVED", "CHANGES_REQUESTED"].includes(state) && ["ADMIN", "MAINTAIN", "WRITE"].includes(permission);

/** How many items a long conversation shows at its start and its end, and how many more each Show reveals. */
export const FOLD = { head: 10, tail: 20, step: 40 };

/**
 * Which items of a conversation of `total` to show, after `revealed` more from the top of the folded middle:
 * items before `head`, and from `tail` on. Equal means nothing is folded. A fold of a few items isn't worth it.
 */
export function folded(total: number, revealed: number) {
  const head = FOLD.head + revealed;
  const tail = total - FOLD.tail;
  return tail - head < 5 ? { head: total, tail: total } : { head, tail };
}

/** The GraphQL fields of a Subject you can react to, such as the pull request, which you can't hide. */
export const REACTABLE = "id viewerCanReact reactionGroups { content viewerHasReacted reactors { totalCount } }";
/** The GraphQL fields of a Subject, for a comment or a review. */
export const SUBJECT = `${REACTABLE} viewerCanMinimize viewerCanUnminimize isMinimized minimizedReason`;
