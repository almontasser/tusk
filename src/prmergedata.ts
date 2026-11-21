// Pull requests: what merging offers for a state, and the default merge and revert messages, with no DOM or Tauri,
// so the tests can run it (prmergedata.test.ts).

/** What GitHub's GraphQL API says about merging a pull request, beyond what `gh pr view --json` gives. */
export type MergeInfo = {
  isMergeQueueEnabled: boolean;
  isInMergeQueue: boolean;
  mergeQueueEntry: { position: number; state: string } | null;
  viewerCanMergeAsAdmin: boolean;
  viewerCanEnableAutoMerge: boolean;
  isCrossRepository: boolean;
  headRef: { id: string; target: { oid: string } | null } | null;
  viewerCanDeleteHeadRef: boolean;
  baseRepository: { viewerPermission: string | null };
  /** GitHub's own default subject and body for each method, from the repository's settings. */
  squashTitle: string | null;
  squashBody: string | null;
  mergeTitle: string | null;
  mergeBody: string | null;
};

/** The fields of a pull request the decisions below read. */
export type MergeState = {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  mergeStateStatus: string;
  autoMergeRequest: { mergeMethod: string } | null;
  headRefName: string;
  headRefOid: string;
  commits: { messageHeadline: string }[];
};

export type MergeActions = {
  /** Add to the merge queue instead of choosing a method. */
  enqueue: boolean;
  /** Remove from the merge queue. */
  dequeue: boolean;
  /** Merge with `--admin`, bypassing the branch's rules. */
  admin: boolean;
  /** Turn on auto-merge. */
  auto: boolean;
  revert: boolean;
  deleteBranch: boolean;
  restoreBranch: boolean;
};

const canWrite = (info: MergeInfo) => ["WRITE", "MAINTAIN", "ADMIN"].includes(info.baseRepository.viewerPermission ?? "");
/** The states where GitHub merges right away, so auto-merge has nothing to wait for. */
export const readyToMerge = (status: string) => status === "CLEAN" || status === "UNSTABLE" || status === "HAS_HOOKS";

/**
 * Which merge actions to offer. Without `info` (the query failed), only auto-merge is offered, as before the query
 * existed. GitHub reports `viewerCanMergeAsAdmin` true for people who can only read, so the admin bypass also needs
 * admin permission, and something to bypass: a blocked merge or a merge queue. Branch actions skip pull requests from
 * forks, whose branch isn't in this repository, and Delete skips a branch that moved on since the pull request, so it
 * never deletes commits the pull request doesn't have.
 */
export function mergeActions(pr: MergeState, info: MergeInfo | null): MergeActions {
  const open = pr.state === "OPEN" && !pr.isDraft;
  const none = { enqueue: false, dequeue: false, admin: false, revert: false, deleteBranch: false, restoreBranch: false };
  if (!info) return { ...none, auto: open && !pr.autoMergeRequest && !readyToMerge(pr.mergeStateStatus) };
  const sameRepo = pr.state !== "OPEN" && !info.isCrossRepository;
  return {
    enqueue: open && info.isMergeQueueEnabled && !info.isInMergeQueue,
    dequeue: pr.state === "OPEN" && info.isInMergeQueue,
    admin: open && (pr.mergeStateStatus === "BLOCKED" || info.isMergeQueueEnabled) && info.viewerCanMergeAsAdmin && info.baseRepository.viewerPermission === "ADMIN",
    // A merge queue turns on auto-merge itself when checks are still running.
    auto: open && !info.isMergeQueueEnabled && !pr.autoMergeRequest && info.viewerCanEnableAutoMerge && !readyToMerge(pr.mergeStateStatus),
    revert: pr.state === "MERGED" && canWrite(info),
    deleteBranch: sameRepo && info.headRef?.target?.oid === pr.headRefOid && canWrite(info),
    // Not `viewerCanDeleteHeadRef`: GitHub reports it false once the branch is gone, which is exactly when Restore
    // applies (seen live on almontasser/tusk#4). Write access is what creating the ref needs.
    restoreBranch: sameRepo && !info.headRef && canWrite(info),
  };
}

/**
 * The subject and body a merge commit or squash starts with: GitHub's own text, which follows the repository's
 * settings, or, when that isn't there, GitHub's defaults.
 */
export function mergeMessage(method: "merge" | "squash", pr: MergeState, info: MergeInfo | null): { subject: string; body: string } {
  const subject = method === "squash" ? info?.squashTitle : info?.mergeTitle;
  const body = method === "squash" ? info?.squashBody : info?.mergeBody;
  if (subject) return { subject, body: body ?? "" };
  if (method === "merge") {
    // ponytail: the base repository's owner stands in for the head's; right for every pull request that isn't from a fork.
    const owner = pr.url.match(/^https?:\/\/[^/]+\/([^/]+)\//)?.[1] ?? "";
    return { subject: `Merge pull request #${pr.number} from ${owner}/${pr.headRefName}`, body: pr.title };
  }
  return { subject: `${pr.title} (#${pr.number})`, body: pr.commits.length > 1 ? pr.commits.map((c) => `* ${c.messageHeadline}`).join("\n\n") : "" };
}

/** The title and body of a revert pull request, as GitHub's Revert button writes them. */
export function revertMessage(pr: Pick<MergeState, "number" | "title" | "url">) {
  const repo = pr.url.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\//)?.[1] ?? "";
  return { title: `Revert "${pr.title}"`, body: `Reverts ${repo}#${pr.number}` };
}

/** A merge queue entry's state, in words. */
export const queueStates: Record<string, string> = {
  QUEUED: "Waiting its turn",
  AWAITING_CHECKS: "Waiting for checks",
  MERGEABLE: "About to merge",
  UNMERGEABLE: "Can't merge, so GitHub removes it from the queue",
  LOCKED: "Locked by the queue",
};
