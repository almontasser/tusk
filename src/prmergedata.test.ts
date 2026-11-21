/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { type MergeInfo, type MergeState, mergeActions, mergeMessage, revertMessage } from "./prmergedata.ts";

const pr: MergeState = {
  number: 12,
  title: "Add caching",
  url: "https://github.com/acme/app/pull/12",
  state: "OPEN",
  isDraft: false,
  mergeStateStatus: "CLEAN",
  autoMergeRequest: null,
  headRefName: "add-caching",
  headRefOid: "abc123",
  commits: [{ messageHeadline: "Cache it" }, { messageHeadline: "Fix the key" }],
};
const info: MergeInfo = {
  isMergeQueueEnabled: false,
  isInMergeQueue: false,
  mergeQueueEntry: null,
  viewerCanMergeAsAdmin: false,
  viewerCanEnableAutoMerge: true,
  isCrossRepository: false,
  headRef: { id: "REF", target: { oid: "abc123" } },
  viewerCanDeleteHeadRef: true,
  baseRepository: { viewerPermission: "WRITE" },
  squashTitle: null,
  squashBody: null,
  mergeTitle: null,
  mergeBody: null,
};

test("admin bypass needs admin permission and a blocked merge, not just viewerCanMergeAsAdmin", () => {
  const flag = { ...info, viewerCanMergeAsAdmin: true };
  assert.equal(mergeActions({ ...pr, mergeStateStatus: "BLOCKED" }, { ...flag, baseRepository: { viewerPermission: "READ" } }).admin, false);
  assert.equal(mergeActions(pr, { ...flag, baseRepository: { viewerPermission: "ADMIN" } }).admin, false);
  assert.equal(mergeActions({ ...pr, mergeStateStatus: "BLOCKED" }, { ...flag, baseRepository: { viewerPermission: "ADMIN" } }).admin, true);
  assert.equal(mergeActions({ ...pr, mergeStateStatus: "BLOCKED", isDraft: true }, { ...flag, baseRepository: { viewerPermission: "ADMIN" } }).admin, false);
  // A merge queue is something to bypass even when nothing blocks the merge.
  assert.equal(mergeActions(pr, { ...flag, isMergeQueueEnabled: true, baseRepository: { viewerPermission: "ADMIN" } }).admin, true);
});

test("auto-merge waits for something, and only where GitHub allows it", () => {
  assert.equal(mergeActions(pr, info).auto, false);
  assert.equal(mergeActions({ ...pr, mergeStateStatus: "BLOCKED" }, info).auto, true);
  assert.equal(mergeActions({ ...pr, mergeStateStatus: "BLOCKED" }, { ...info, viewerCanEnableAutoMerge: false }).auto, false);
  assert.equal(mergeActions({ ...pr, mergeStateStatus: "BLOCKED", autoMergeRequest: { mergeMethod: "SQUASH" } }, info).auto, false);
  assert.equal(mergeActions({ ...pr, mergeStateStatus: "BLOCKED" }, { ...info, isMergeQueueEnabled: true }).auto, false);
  assert.equal(mergeActions({ ...pr, mergeStateStatus: "BLOCKED" }, null).auto, true);
});

test("a merge queue offers to add or remove, not both", () => {
  const queue = { ...info, isMergeQueueEnabled: true };
  assert.deepEqual([mergeActions(pr, queue).enqueue, mergeActions(pr, queue).dequeue], [true, false]);
  const queued = { ...queue, isInMergeQueue: true };
  assert.deepEqual([mergeActions(pr, queued).enqueue, mergeActions(pr, queued).dequeue], [false, true]);
});

test("branch actions after merging skip forks and match whether the branch exists", () => {
  const merged = { ...pr, state: "MERGED" };
  assert.deepEqual([mergeActions(merged, info).deleteBranch, mergeActions(merged, info).restoreBranch, mergeActions(merged, info).revert], [true, false, true]);
  // A branch with commits the pull request doesn't have is never offered for deletion.
  assert.equal(mergeActions(merged, { ...info, headRef: { id: "REF", target: { oid: "def456" } } }).deleteBranch, false);
  const gone = { ...info, headRef: null };
  assert.deepEqual([mergeActions(merged, gone).deleteBranch, mergeActions(merged, gone).restoreBranch], [false, true]);
  const fork = { ...info, isCrossRepository: true };
  assert.deepEqual([mergeActions(merged, fork).deleteBranch, mergeActions(merged, { ...fork, headRef: null }).restoreBranch], [false, false]);
  assert.equal(mergeActions(merged, { ...info, baseRepository: { viewerPermission: "READ" } }).revert, false);
  assert.equal(mergeActions({ ...pr, state: "CLOSED" }, info).revert, false);
  assert.equal(mergeActions(pr, info).deleteBranch, false);
});

test("merge messages use GitHub's text, or its defaults when it's missing", () => {
  assert.deepEqual(mergeMessage("squash", pr, { ...info, squashTitle: "Add caching (#12)", squashBody: "The body" }), { subject: "Add caching (#12)", body: "The body" });
  assert.deepEqual(mergeMessage("squash", pr, null), { subject: "Add caching (#12)", body: "* Cache it\n\n* Fix the key" });
  assert.deepEqual(mergeMessage("squash", { ...pr, commits: [{ messageHeadline: "Cache it" }] }, null).body, "");
  assert.deepEqual(mergeMessage("merge", pr, null), { subject: "Merge pull request #12 from acme/add-caching", body: "Add caching" });
});

test("a revert names the pull request it reverts", () => {
  assert.deepEqual(revertMessage(pr), { title: 'Revert "Add caching"', body: "Reverts acme/app#12" });
});
