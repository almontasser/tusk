// Pull requests: your pending review on GitHub, and adding, deleting, and submitting its comments.
import { invoke } from "@tauri-apps/api/core";
import { type Details, gh, host, type ReviewComment } from "./prshared";

/**
 * Your pending review: GitHub's own, which only you can see until you submit it, so it's the same review in the
 * browser and here. `id` is its REST ID and `node` its GraphQL ID.
 */
type Pending = { number: number; id: number; node: string; comments: ReviewComment[] };
/** The pending review of the pull request on screen, or null when you have none there. */
export let pending: Pending | null = null;

/** Loads your pending review of a pull request. GitHub lists a pending review only to its author. */
/** The last load of a pull request's pending review, finished or not, so callers share it rather than ask again. */
let pendingLoad: { number: number; done: Promise<Pending | null> } | undefined;
export const pendingOf = (number: number) => (pendingLoad?.number === number ? pendingLoad.done : loadPending(number));

export function loadPending(number: number): Promise<Pending | null> {
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
export async function addPending(pr: Details, place: Place, body: string) {
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
export async function deletePending(number: number, comment: ReviewComment) {
  await gh("api", "--method", "DELETE", `repos/{owner}/{repo}/pulls/comments/${comment.id}`);
  const review = await loadPending(number);
  if (review && !review.comments.length) {
    await gh("api", "--method", "DELETE", `repos/{owner}/{repo}/pulls/${number}/reviews/${review.id}`);
    pending = null;
  }
}

/** Submits a review: the pending comments, with a summary and a verdict, in one request. */
export async function submitReview(pr: Details, event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string) {
  const review = pending?.number === pr.number ? pending : await loadPending(pr.number);
  // Your pending review is submitted with the verdict; without one, a review with only the summary is created.
  const [path, payload] = review ? [`reviews/${review.id}/events`, { event, body }] : ["reviews", { commit_id: pr.headRefOid, event, body }];
  await invoke<string>("run_capture", { cwd: host.root(), program: "gh", args: ["api", "--method", "POST", `repos/{owner}/{repo}/pulls/${pr.number}/${path}`, "--input", "-"], input: JSON.stringify(payload) });
  pending = null;
}
