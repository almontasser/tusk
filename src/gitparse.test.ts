/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { askpassKind, age, alignmentGaps, graphRows, applyBlocks, applyLines, checksSummary, mirror, parseRebaseTodo, rebaseTodo, isConflict, lineChanges as changesOf, parseBlame, parseConflicts, parseHunks, parseLog, parseNameStatus, parseRefs, parseStashList, resolveSimple, parseStatus, parseWorktrees, remoteLineUrl } from "./gitparse.ts";

test("parses branch, tracking, and file statuses", () => {
  const out = ["## main...origin/main [ahead 2, behind 1]", "M  app/Post.php", " M routes/web.php", "R  new.php", "old.php", "?? notes.md", ""].join("\0");
  const s = parseStatus(out);
  assert.deepEqual([s.branch, s.upstream, s.ahead, s.behind], ["main", "origin/main", 2, 1]);
  assert.deepEqual(s.files, [
    { index: "M", worktree: " ", path: "app/Post.php" },
    { index: " ", worktree: "M", path: "routes/web.php" },
    { index: "R", worktree: " ", path: "new.php", from: "old.php" },
    { index: "?", worktree: "?", path: "notes.md" },
  ]);
});

test("parses branch headers without upstream or commits", () => {
  assert.deepEqual(parseStatus("## feature\0").branch, "feature");
  assert.deepEqual(parseStatus("## No commits yet on main\0").branch, "main");
  assert.deepEqual(parseStatus("## HEAD (no branch)\0").branch, "HEAD (detached)");
  assert.equal(parseStatus("## main...origin/main [gone]\0").ahead, 0);
});

test("turns zero-context hunks into line changes", () => {
  const diff = "diff --git a/x b/x\n@@ -3,0 +4,2 @@\n+a\n+b\n@@ -10 +12 @@\n-x\n+y\n@@ -20,3 +21,0 @@\n-p\n@@ -1 +0,0 @@\n-q\n";
  assert.deepEqual(parseHunks(diff), [
    { kind: "added", start: 4, end: 5 },
    { kind: "modified", start: 12, end: 12 },
    { kind: "deleted", start: 21, end: 21 },
    { kind: "deleted", start: 1, end: 1 },
  ]);
});

test("parses porcelain blame, reusing commit details for repeated commits", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const out = [
    `${a} 1 1 2`, "author Ada", "author-time 1700000000", "summary First", "filename x.php", "\t<?php",
    `${a} 2 2`, "\techo 1;",
    `${b} 3 3 1`, "author Bo", "author-time 1710000000", "summary Second", "filename x.php", "\techo 2;",
  ].join("\n");
  const lines = parseBlame(out);
  assert.deepEqual(lines.map((l) => [l.author, l.summary]), [["Ada", "First"], ["Ada", "First"], ["Bo", "Second"]]);
});

test("formats ages", () => {
  assert.equal(age(0, 30), "now");
  assert.equal(age(0, 3 * 86400 + 5), "3d");
  assert.equal(age(0, 400 * 86400), "1y");
});

test("finds added, modified, and deleted lines between two versions", () => {
  const base = ["a", "b", "c", "d", "e"];
  const lineChanges = (before: string[], after: string[]) => changesOf(before, after).map(({ block, ...c }) => c);
  assert.deepEqual(lineChanges(base, base), []);
  assert.deepEqual(lineChanges(base, ["a", "b", "x", "y", "c", "d", "e"]), [{ kind: "added", start: 3, end: 4 }]);
  assert.deepEqual(lineChanges(base, ["a", "B", "c", "d", "e"]), [{ kind: "modified", start: 2, end: 2 }]);
  assert.deepEqual(lineChanges(base, ["a", "d", "e"]), [{ kind: "deleted", start: 1, end: 1 }]);
  assert.deepEqual(lineChanges(base, ["b", "c", "d", "e"]), [{ kind: "deleted", start: 1, end: 1 }]);
  assert.deepEqual(lineChanges(base, ["a", "B", "c", "d", "e", "f"]), [
    { kind: "modified", start: 2, end: 2 },
    { kind: "added", start: 6, end: 6 },
  ]);
  assert.deepEqual(lineChanges([], ["x"]), [{ kind: "added", start: 1, end: 1 }]);
});

test("each change's block rolls it back or applies it alone", () => {
  const base = ["a", "b", "c", "d", "e"];
  for (const after of [["a", "b", "x", "y", "c", "d", "e"], ["a", "B", "c", "d", "e"], ["a", "d", "e"], ["b", "c", "d", "e"], ["a", "b", "c"], ["x", "a", "B", "c", "e", "f"], ["z"]]) {
    const changes = changesOf(base, after);
    assert.equal(applyBlocks(base.join("\n"), after.join("\n"), changes.map((c) => c.block!)), after.join("\n"), `${after}`);
    for (const c of changes) {
      const rolledBack = applyBlocks(after.join("\n"), base.join("\n"), [mirror(c.block!)]);
      // Rolling back one change leaves the others, so only that change is gone.
      assert.equal(changesOf(base, rolledBack.split("\n")).length, changes.length - 1, `${after} ${c.kind} ${c.start}`);
    }
  }
});

test("summarizes pull request checks", () => {
  const ok = { status: "COMPLETED", conclusion: "SUCCESS" };
  const running = { status: "IN_PROGRESS", conclusion: "" };
  const failed = { status: "COMPLETED", conclusion: "FAILURE" };
  const statusOk = { state: "SUCCESS" };
  const statusPending = { state: "PENDING" };
  assert.equal(checksSummary([]), "none");
  assert.equal(checksSummary(null), "none");
  assert.equal(checksSummary([ok, statusOk]), "passed");
  assert.equal(checksSummary([ok, running]), "pending");
  assert.equal(checksSummary([ok, statusPending]), "pending");
  assert.equal(checksSummary([running, failed]), "failed");
  assert.equal(checksSummary([{ status: "COMPLETED", conclusion: "SKIPPED" }, ok]), "passed");
});

test("parses log records, changed files, and conflicts", () => {
  const out =
    "aaa\x1fa1\x1fAda\x1f1700000000\x1fHEAD -> main, origin/main, tag: v1\x1fp1 p2\x1fMerge branch 'x'\x1e\n" +
    "bbb\x1fb1\x1fBo\x1f1690000000\x1f\x1f\x1fFirst: with | pipes\x1e\n";
  const commits = parseLog(out);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0].refs, ["HEAD -> main", "origin/main", "tag: v1"]);
  assert.deepEqual(commits[0].parents, ["p1", "p2"]);
  assert.deepEqual([commits[1].refs, commits[1].parents, commits[1].subject], [[], [], "First: with | pipes"]);

  assert.deepEqual(parseNameStatus("M\0app/A.php\0R087\0old.php\0new.php\0A\0b.php\0"), [
    { status: "M", path: "app/A.php" },
    { status: "R", from: "old.php", path: "new.php" },
    { status: "A", path: "b.php" },
  ]);

  const lines = ["a", "<<<<<<< HEAD", "ours", "||||||| base", "orig", "=======", "theirs", ">>>>>>> feature", "b", "<<<<<<< HEAD", "x", "=======", ">>>>>>> other"];
  assert.deepEqual(parseConflicts(lines), [
    { start: 2, currentLabel: "HEAD", base: 4, separator: 6, end: 8, incomingLabel: "feature" },
    { start: 10, currentLabel: "HEAD", separator: 12, end: 13, incomingLabel: "other" },
  ]);
  assert.deepEqual(parseConflicts(["<<<<<<< HEAD", "unfinished"]), []);

  const status = (index: string, worktree: string) => ({ index, worktree, path: "x" });
  assert.deepEqual(["UU", "AA", "DD", "AU", "UD", "M ", " M", "A "].map((s) => isConflict(status(s[0], s[1]))), [true, true, true, true, true, false, false, false]);
});

test("applies chosen diff blocks", () => {
  const original = "a\nb\nc\nd\n";
  const modified = "a\nB\nc\nnew\nd\n";
  // As Monaco reports them: line 2 changed, and a line inserted after line 3.
  const changed = { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 };
  const inserted = { originalStartLineNumber: 3, originalEndLineNumber: 0, modifiedStartLineNumber: 4, modifiedEndLineNumber: 4 };
  assert.equal(applyBlocks(original, modified, [inserted]), "a\nb\nc\nnew\nd\n");
  assert.equal(applyBlocks(original, modified, [changed]), "a\nB\nc\nd\n");
  assert.equal(applyBlocks(original, modified, [changed, inserted]), modified);
  // Undoing a block works from the other side.
  assert.equal(applyBlocks(modified, original, [mirror(inserted)]), "a\nB\nc\nd\n");
  const deleted = { originalStartLineNumber: 2, originalEndLineNumber: 3, modifiedStartLineNumber: 1, modifiedEndLineNumber: 0 };
  assert.equal(applyBlocks(original, "a\nd\n", [deleted]), "a\nd\n");
  assert.equal(applyBlocks("a\nd\n", original, [mirror(deleted)]), original);
});


test("writes a rebase todo list", () => {
  const todo = rebaseTodo(
    [
      { hash: "a1", subject: "First", action: "pick" },
      { hash: "b2", subject: "Typo", action: "fixup" },
      { hash: "c3", subject: "Old words", action: "reword", message: "New words" },
      { hash: "d4", subject: "Oops", action: "drop" },
      { hash: "e5", subject: "Fix me", action: "edit" },
    ],
    (i) => `/tmp/it's msg-${i}.txt`,
  );
  assert.equal(todo, "pick a1 First\nfixup b2 Typo\npick c3 Old words\nexec git commit --amend --quiet --file='/tmp/it'\\''s msg-2.txt'\ndrop d4 Oops\nedit e5 Fix me\n");
});

test("reads a --rebase-merges todo list and writes it back with the chosen actions", () => {
  const steps = parseRebaseTodo(
    "label onto\n\n# Branch feat\nreset onto\npick e0751ea # a1\nlabel feat\n\nreset onto\npick 62b744e a2\nmerge -C 10d27e8 feat # Merge branch 'feat'\n\n# Rebase 0bc..00d onto 0bc\n",
  );
  assert.deepEqual(steps[2], { hash: "e0751ea", subject: "a1", action: "pick" });
  assert.deepEqual(steps[6], { hash: "10d27e8", subject: "feat # Merge branch 'feat'", action: "pick", line: "merge -C 10d27e8 feat # Merge branch 'feat'" });
  steps[2].action = "edit";
  steps[5].action = "drop";
  assert.equal(rebaseTodo(steps, () => ""), "label onto\nreset onto\nedit e0751ea a1\nlabel feat\nreset onto\ndrop 62b744e a2\nmerge -C 10d27e8 feat # Merge branch 'feat'\n");
});

test("applies only the selected lines of a block", () => {
  const index = "a\nb\nc\nz\n";
  const work = "a\nB\nC\nnew\nz\n";
  // One block: b, c changed to B, C, and "new" added.
  const block = { originalStartLineNumber: 2, originalEndLineNumber: 3, modifiedStartLineNumber: 2, modifiedEndLineNumber: 4 };
  const on = (...lines: number[]) => (l: number) => lines.includes(l);
  const none = () => false;
  assert.equal(applyLines(index, work, [block], none, on(2)), "a\nB\nc\nz\n"); // only b -> B
  assert.equal(applyLines(index, work, [block], none, on(4)), "a\nb\nc\nnew\nz\n"); // only the added line
  assert.equal(applyLines(index, work, [block], none, on(2, 3, 4)), work);
  // A deletion counts only when selected on the left.
  const deleted = { originalStartLineNumber: 2, originalEndLineNumber: 3, modifiedStartLineNumber: 1, modifiedEndLineNumber: 0 };
  assert.equal(applyLines(index, "a\nz\n", [deleted], on(3), none), "a\nb\nz\n");
  // A changed line pairs with its new version, not with a line added before it.
  const added = { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 3 };
  const before = "a\n    return view('welcome');\nz\n";
  const after = "a\n    $x = 1;\n    return view('home');\nz\n";
  assert.equal(applyLines(before, after, [added], none, on(3)), "a\n    return view('home');\nz\n");
  assert.equal(applyLines(before, after, [added], none, on(2)), "a\n    $x = 1;\n    return view('welcome');\nz\n");
  // Unstaging mirrors: from the index back toward HEAD.
  assert.equal(applyLines(work, index, [mirror(block)], on(2), none), "a\nb\nC\nnew\nz\n");
});

test("pads three versions so shared lines line up", () => {
  const ours = ["start", "mine 1", "mine 2", "end"];
  const result = ["start", "<<<", "mine 1", "mine 2", "===", "theirs", ">>>", "end"];
  const theirs = ["start", "theirs", "end", "extra"];
  const gaps = alignmentGaps(ours, result, theirs);
  // Between "start" and "end", the result has 6 lines, ours 2, and theirs 1.
  assert.deepEqual(gaps.ours, [[3, 4], [4, 1]]);
  assert.deepEqual(gaps.theirs, [[2, 5]]);
  // After "end", theirs has one more line than the others.
  assert.deepEqual(gaps.result, [[8, 1]]);
  // Lines only one side kept, while ours is behind the result, still line up.
  const long = alignmentGaps(["a", "x", "b"], ["pre1", "pre2", "a", "b"], ["pre1", "pre2", "a", "x", "b"]);
  assert.deepEqual(long.result, [[3, 1]]);
  // A line of buttons above the conflict makes that segment one line taller in the result.
  assert.deepEqual(alignmentGaps(ours, result, theirs, [2]).ours, [[3, 5], [4, 1]]);
});

test("parses worktrees, skipping bare repositories", () => {
  const out = "worktree /code/app\nHEAD abc\nbranch refs/heads/main\n\nworktree /code/app-fix\nHEAD def\nbranch refs/heads/fix/login\n\nworktree /code/app-old\nHEAD 123\ndetached\nprunable gitdir file points to non-existent location\n\nworktree /code/bare.git\nbare\n";
  assert.deepEqual(parseWorktrees(out), [
    { path: "/code/app", branch: "main", main: true },
    { path: "/code/app-fix", branch: "fix/login", main: false },
    { path: "/code/app-old", branch: "detached", main: false },
  ]);
});

test("links lines on a remote's web host", () => {
  const url = (remote: string, end?: number) => remoteLineUrl(remote, "abc123", "app/My File.php", 3, end);
  assert.equal(url("git@github.com:acme/shop.git"), "https://github.com/acme/shop/blob/abc123/app/My%20File.php#L3");
  assert.equal(url("https://token@github.com/acme/shop.git", 5), "https://github.com/acme/shop/blob/abc123/app/My%20File.php#L3-L5");
  assert.equal(url("ssh://git@gitlab.example.com:2222/group/sub/shop"), "https://gitlab.example.com/group/sub/shop/blob/abc123/app/My%20File.php#L3");
  assert.equal(url("git@bitbucket.org:acme/shop.git", 5), "https://bitbucket.org/acme/shop/src/abc123/app/My%20File.php#lines-3:5");
  assert.equal(url("/Users/me/shop.git"), "");
});

test("parses stashes with and without a message", () => {
  const out = ["stash@{0}\x1fa1\x1f100\x1fOn main: half-done login", "stash@{1}\x1fb2\x1f90\x1fWIP on feature/x: 1a2b3c4 Add Post model", ""].join("\n");
  assert.deepEqual(parseStashList(out), [
    { ref: "stash@{0}", hash: "a1", time: 100, branch: "main", message: "half-done login" },
    { ref: "stash@{1}", hash: "b2", time: 90, branch: "feature/x", message: "WIP: Add Post model" },
  ]);
});

test("parses local and remote branches with tracking", () => {
  const out = [
    "refs/heads/main\t*\torigin/main\tahead 2, behind 1\t200",
    "refs/heads/origin/x\t \t\t\t150",
    "refs/heads/old\t \torigin/old\tgone\t100",
    "refs/remotes/origin/HEAD\t \t\t\t200",
    "refs/remotes/origin/main\t \t\t\t190",
    "",
  ].join("\n");
  const refs = parseRefs(out);
  assert.deepEqual(refs.map((r) => [r.name, r.remote, r.current]), [["main", false, true], ["origin/x", false, false], ["old", false, false], ["origin/main", true, false]]);
  assert.deepEqual([refs[0].upstream, refs[0].ahead, refs[0].behind, refs[2].gone, refs[1].upstream], ["origin/main", 2, 1, true, undefined]);
});

test("lays out a commit graph with a branch and a merge", () => {
  // m merges f into c; f and c both come from a.
  const rows = graphRows([
    { hash: "m", parents: ["c", "f"] },
    { hash: "f", parents: ["a"] },
    { hash: "c", parents: ["a"] },
    { hash: "a", parents: [] },
  ]);
  assert.deepEqual(rows.map((r) => r.col), [0, 1, 0, 0]);
  // The merge opens lane 1 for f.
  assert.deepEqual(rows[0].lines.filter((l) => l.y1 === "mid").map((l) => l.to), [0, 1]);
  // c's row passes lane 1 (waiting for a) straight through.
  assert.ok(rows[2].lines.some((l) => l.from === 1 && l.to === 1 && l.y1 === "top" && l.y2 === "bottom"));
  // a ends both lanes: two lines come in, none go out.
  assert.deepEqual(rows[3].lines.map((l) => [l.from, l.to, l.y1]), [[0, 0, "top"], [1, 0, "top"]]);
  assert.equal(rows[3].width, 2);
});

test("merges conflicts whose sides changed different lines", () => {
  const base = ["a", "b", "c", "d"];
  assert.deepEqual(resolveSimple(base, ["A", "b", "c", "d"], ["a", "b", "c", "D"]), ["A", "b", "c", "D"]);
  // Neighboring lines merge.
  assert.deepEqual(resolveSimple(base, ["a", "B", "c", "d"], ["a", "b", "C", "d"]), ["a", "B", "C", "d"]);
  // One side unchanged, or both the same, takes the other.
  assert.deepEqual(resolveSimple(base, base, ["x"]), ["x"]);
  assert.deepEqual(resolveSimple(base, ["x"], ["x"]), ["x"]);
  // The same line changed two ways, or two insertions at one place, stay conflicts.
  assert.equal(resolveSimple(base, ["a", "B1", "c", "d"], ["a", "B2", "c", "d"]), null);
  assert.equal(resolveSimple(base, ["a", "x", "b", "c", "d"], ["a", "y", "b", "c", "d"]), null);
});

test("asks git's and ssh's prompts by kind", () => {
  assert.equal(askpassKind("Username for 'https://github.com': ", false), "text");
  assert.equal(askpassKind("Password for 'https://me@github.com': ", false), "secret");
  assert.equal(askpassKind("Enter passphrase for key '/Users/me/.ssh/id_ed25519': ", false), "secret");
  assert.equal(askpassKind("Are you sure you want to continue connecting (yes/no/[fingerprint])? ", false), "yesno");
  assert.equal(askpassKind("Allow use of key?", true), "confirm");
});
