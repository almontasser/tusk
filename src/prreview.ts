// Pull requests: your pending review on GitHub, and adding, deleting, and submitting its comments.
import { invoke } from "@tauri-apps/api/core";
import { latestLoads } from "./prdata";
import { type Details, gh, host, type ReviewComment } from "./prshared";
import { withSides } from "./prhunks";

/**
 * Your pending review: GitHub's own, which only you can see until you submit it, so it's the same review in the
 * browser and here. `id` is its REST ID and `node` its GraphQL ID.
 */
type Pending = { number: number; id: number; node: string; comments: ReviewComment[] };
/**
 * Your pending review of each pull request, by project and number. Several pull request tabs load theirs at once,
 * and only a pull request's latest load stores its value, so one pull request's review never stands in for
 * another's, and a slow load never undoes a newer one.
 */
const pendings = latestLoads<Pending | null>(null);
const key = (number: number) => `${host.root()}\0${number}`;
/** Your pending review of a pull request as last loaded, or null when you have none there. */
export const pendingReview = (number: number) => pendings.get(key(number));
/** The latest load of a pull request's pending review, finished or not, so callers share it rather than ask again. */
export const pendingOf = (number: number) => pendings.latest(key(number), () => readPending(number));
/** Loads your pending review of a pull request. GitHub lists a pending review only to its author. */
export const loadPending = (number: number) => pendings.load(key(number), () => readPending(number));

// gh's --paginate follows $endCursor through every page of the review's comments, and of the threads.
const PENDING = `query($id: ID!, $endCursor: String) { node(id: $id) { ... on PullRequestReview {
  comments(first: 100, after: $endCursor) { nodes { databaseId path line startLine originalLine subjectType body author { login } createdAt replyTo { databaseId } } pageInfo { hasNextPage endCursor } }
} } }`;
const SIDES = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $endCursor) { nodes { diffSide comments(first: 1) { nodes { databaseId } } } pageInfo { hasNextPage endCursor } } } }
}`;

async function readPending(number: number): Promise<Pending | null> {
  const found = (await gh("api", `repos/{owner}/{repo}/pulls/${number}/reviews`, "--paginate", "--jq", '.[] | select(.state == "PENDING") | {id, node: .node_id}')).trim();
  if (!found) return null;
  const { id, node } = JSON.parse(found.split("\n")[0]);
  // REST lists a pending comment with only its diff position, no line, so its lines come from GraphQL, and its
  // side from its thread. Each is its own query, since --paginate follows only one list's pages.
  const jq = ".data.node.comments.nodes[] | {id: .databaseId, path, line: (.line // .originalLine), start_line: .startLine, subject: .subjectType, body, user: .author.login, in_reply_to_id: .replyTo.databaseId, created_at: .createdAt}";
  const sides = ".data.repository.pullRequest.reviewThreads.nodes[] | [.comments.nodes[0].databaseId, .diffSide]";
  const [out, threads] = await Promise.all([
    gh("api", "graphql", "--paginate", "-f", `query=${PENDING}`, "-f", `id=${node}`, "--jq", jq),
    gh("api", "graphql", "--paginate", "-F", "owner={owner}", "-F", "name={repo}", "-F", `number=${number}`, "-f", `query=${SIDES}`, "--jq", sides),
  ]);
  const rows = (text: string) => text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { number, id, node, comments: withSides(rows(out), new Map(rows(threads))) };
}

/** A pending comment's place: its lines and side, as GitHub's REST API names them, or the whole file. */
type Place = { path: string; line: number; side: "LEFT" | "RIGHT"; start_line?: number; file?: boolean };

/**
 * Adds a comment to your pending review, starting one on the head commit when you have none. GitHub's REST API
 * can only add comments while creating a review, so later ones go through GraphQL's addPullRequestReviewThread.
 */
export async function addPending(pr: Details, place: Place, body: string) {
  // This pull request's own review: the value its load returns, never what another pull request's load stored.
  const review = await pendingOf(pr.number);
  if (place.file) {
    // REST's review comments take no comment on a whole file, so the review starts through GraphQL: without an
    // event, addPullRequestReview leaves it pending.
    const reviewId = review?.node ?? (await gh(
      "api", "graphql",
      "-f", "query=mutation($pr: ID!, $commit: GitObjectID!) { addPullRequestReview(input: { pullRequestId: $pr, commitOID: $commit }) { pullRequestReview { id } } }",
      "-f", `pr=${pr.id}`, "-f", `commit=${pr.headRefOid}`, "--jq", ".data.addPullRequestReview.pullRequestReview.id",
    )).trim();
    try {
      await gh(
        "api", "graphql",
        "-f", "query=mutation($review: ID!, $path: String!, $body: String!) { addPullRequestReviewThread(input: { pullRequestReviewId: $review, path: $path, body: $body, subjectType: FILE }) { thread { id } } }",
        "-f", `review=${reviewId}`, "-f", `path=${place.path}`, "-f", `body=${body}`,
      );
    } catch (e) {
      // An empty review started just now would hide Comment Now from then on, so it goes too.
      if (!review) await gh("api", "graphql", "-f", "query=mutation($id: ID!) { deletePullRequestReview(input: { pullRequestReviewId: $id }) { clientMutationId } }", "-f", `id=${reviewId}`).catch(() => {});
      throw e;
    }
  } else if (!review) {
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
      "-f", `review=${review.node}`, "-f", `path=${place.path}`, "-f", `body=${body}`, "-F", `line=${place.line}`, "-f", `side=${place.side}`, ...range,
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
    pendings.set(key(number), null);
  }
}

/** Submits a review: the pending comments, with a summary and a verdict, in one request. */
export async function submitReview(pr: Details, event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string) {
  const review = pendingReview(pr.number) ?? (await loadPending(pr.number));
  // Your pending review is submitted with the verdict; without one, a review with only the summary is created.
  const [path, payload] = review ? [`reviews/${review.id}/events`, { event, body }] : ["reviews", { commit_id: pr.headRefOid, event, body }];
  await invoke<string>("run_capture", { cwd: host.root(), program: "gh", args: ["api", "--method", "POST", `repos/{owner}/{repo}/pulls/${pr.number}/${path}`, "--input", "-"], input: JSON.stringify(payload) });
  pendings.set(key(pr.number), null);
}
