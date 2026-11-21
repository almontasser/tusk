/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendBlock, canDismiss, emojify, emojiText, entries, eventLine, folded, FOLD, mergeByDate, quote, reasonText, toggleReaction, type TimelineNode } from "./prconversationdata.ts";

const commit = (oid: string, committedDate = "2024-01-01T00:00:00Z") => ({ type: "PullRequestCommit", commit: { oid, messageHeadline: oid, committedDate, author: { name: "Ann", user: { login: "ann" } } } });

test("runs of commits become one entry dated after the item before them", () => {
  const nodes: TimelineNode[] = [
    { type: "ReadyForReviewEvent", createdAt: "2024-11-25T00:00:00Z", actor: { login: "ann" } },
    commit("a", "2025-04-02T00:00:00Z"),
    commit("b", "2025-04-02T00:00:00Z"),
    { type: "IssueComment", createdAt: "2024-12-01T00:00:00Z" },
    commit("c"),
  ];
  const out = entries(nodes);
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((e) => e.at), ["2024-11-25T00:00:00Z", "2024-11-25T00:00:00Z", "2024-12-01T00:00:00Z", "2024-12-01T00:00:00Z"]);
  assert.deepEqual("commits" in out[1] && out[1].commits.map((c) => c.oid), ["a", "b"]);
});

test("commits before any dated item take their commit date", () => {
  assert.equal(entries([commit("a", "2024-03-03T00:00:00Z")])[0].at, "2024-03-03T00:00:00Z");
});

test("the close that comes with a merge is left out, a plain close isn't", () => {
  const merged = entries([
    { type: "MergedEvent", createdAt: "2024-01-01T00:00:00Z" },
    { type: "ClosedEvent", createdAt: "2024-01-01T00:00:00Z" },
  ]);
  assert.deepEqual(merged.map((e) => "node" in e && e.node.type), ["MergedEvent"]);
  assert.equal(entries([{ type: "ClosedEvent", createdAt: "2024-01-01T00:00:00Z" }]).length, 1);
});

test("threads sort in by date after items of the same date, keeping the timeline's order", () => {
  const list = [
    { at: "2024-01-01T00:00:00Z", id: "a" },
    { at: "2024-01-03T00:00:00Z", id: "b" },
    { at: "2024-01-02T00:00:00Z", id: "c" }, // Out of order, as API order can be; it stays after b.
  ];
  const extra = [
    { at: "2024-01-01T00:00:00Z", id: "t1" },
    { at: "2024-01-02T12:00:00Z", id: "t2" },
    { at: "2024-02-01T00:00:00Z", id: "t3" },
  ];
  assert.deepEqual(mergeByDate(list, extra).map((x) => x.id), ["a", "t1", "t2", "b", "c", "t3"]);
});

test("events read as GitHub writes them", () => {
  const text = (n: TimelineNode) => {
    const e = eventLine(n)!;
    return `${e.user} ${e.parts.map((p) => (typeof p === "string" ? p : Object.values(p)[0] as string | object)).map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join("")}`;
  };
  assert.equal(text({ type: "HeadRefForcePushedEvent", actor: { login: "ann" }, beforeCommit: { oid: "1234567890" }, afterCommit: { oid: "abcdefabcd" } }), "ann force-pushed the branch from 1234567 to abcdefa");
  assert.equal(text({ type: "ReviewRequestedEvent", actor: { login: "ann" }, requestedReviewer: { name: "core" } }), "ann requested a review from core");
  assert.equal(text({ type: "ReviewRequestedEvent", actor: { login: "ann" }, requestedReviewer: { login: "ann" } }), "ann requested a review");
  assert.equal(text({ type: "RenamedTitleEvent", actor: null, previousTitle: "Old", currentTitle: "New" }), "ghost changed the title Old New");
  assert.equal(text({ type: "MergedEvent", actor: { login: "bo" }, commit: { oid: "fedcba9876", messageHeadline: "", committedDate: "", author: null }, mergeRefName: "main" }), "bo merged commit fedcba9 into main");
  assert.equal(text({ type: "CrossReferencedEvent", actor: { login: "cy" }, isCrossRepository: true, source: { number: 5, title: "Bug", url: "https://github.com/o/r/issues/5" } }), "cy mentioned this in o/r#5 Bug");
  assert.equal(text({ type: "CrossReferencedEvent", actor: { login: "cy" }, isCrossRepository: false, source: { number: 5, title: "Bug", url: "https://github.com/o/r/pull/5" } }), "cy mentioned this in #5 Bug");
  assert.equal(eventLine({ type: "IssueComment" }), null);
});

test("quote puts each line behind > and ends with an empty line", () => {
  assert.equal(quote("one\r\n\ntwo\n"), "> one\n>\n> two\n\n");
  assert.equal(appendBlock("", "> q\n\n"), "> q\n\n");
  assert.equal(appendBlock("hello  \n", "> q\n\n"), "hello\n\n> q\n\n");
});

test("emoji images become text only where the code points can be rebuilt", () => {
  const u = (hex: string) => `https://github.githubassets.com/images/icons/emoji/unicode/${hex}.png?v8`;
  assert.equal(emojiText(u("1f44d")), "👍️");
  assert.equal(emojiText(u("263a")), "☺️");
  assert.equal(emojiText(u("0023-20e3")), "#️⃣");
  assert.equal(emojiText(u("1f1fa-1f1f8")), "🇺🇸");
  // These need joiners the file name drops, so they stay images.
  assert.equal(emojiText(u("1f468-1f4bb")), null);
  assert.equal(emojiText(u("1f3f3-1f308")), null);
  assert.equal(emojiText("https://github.githubassets.com/images/icons/emoji/octocat.png?v8"), null);
});

test("emojify replaces known shortcodes and leaves the rest", () => {
  const emojis = { "+1": "https://x/unicode/1f44d.png", octocat: "https://x/octocat.png", tada: "https://x/unicode/1f389.png" };
  assert.deepEqual(emojify("nice :+1: and :tada:!", emojis), ["nice 👍️ and 🎉️!"]);
  assert.deepEqual(emojify(":octocat: hi", emojis), [{ name: "octocat", url: "https://x/octocat.png" }, " hi"]);
  assert.deepEqual(emojify("at 10:30:45 and :nope: and a:tada:b", emojis), ["at 10:30:45 and :nope: and a:tada:b"]);
});

test("reactions toggle your own and keep counts", () => {
  const groups = [{ content: "HEART", viewerHasReacted: true, reactors: { totalCount: 2 } }];
  assert.deepEqual(toggleReaction(groups, "HEART"), [{ content: "HEART", viewerHasReacted: false, reactors: { totalCount: 1 } }]);
  assert.deepEqual(toggleReaction(groups, "EYES")[1], { content: "EYES", viewerHasReacted: true, reactors: { totalCount: 1 } });
});

test("moderation helpers", () => {
  assert.equal(reasonText("OFF_TOPIC"), "off topic");
  assert.equal(reasonText("off-topic"), "off topic");
  assert.equal(canDismiss("APPROVED", "WRITE"), true);
  assert.equal(canDismiss("COMMENTED", "ADMIN"), false);
  assert.equal(canDismiss("CHANGES_REQUESTED", "TRIAGE"), false);
});

test("long conversations fold their middle", () => {
  assert.deepEqual(folded(30, 0), { head: 30, tail: 30 });
  assert.deepEqual(folded(100, 0), { head: FOLD.head, tail: 100 - FOLD.tail });
  assert.deepEqual(folded(100, FOLD.step), { head: FOLD.head + FOLD.step, tail: 100 - FOLD.tail });
  assert.deepEqual(folded(100, 1000), { head: 100, tail: 100 });
});
