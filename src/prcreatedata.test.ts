/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { autosaveKey, createArgs, defaultTemplate, existingFrom, headSpec, headTarget, isRemoteUrl, parseNumstat, remoteFor, repoFromUrl, templateChoices } from "./prcreatedata.ts";

test("templates list the single file first as Default, then the folder's by name", () => {
  const t = templateChoices([".github/PULL_REQUEST_TEMPLATE/feature.md", ".github/PULL_REQUEST_TEMPLATE/bug.md", ".github/pull_request_template.md"]);
  assert.deepEqual(t, [
    { path: ".github/pull_request_template.md", name: "Default" },
    { path: ".github/PULL_REQUEST_TEMPLATE/bug.md", name: "bug" },
    { path: ".github/PULL_REQUEST_TEMPLATE/feature.md", name: "feature" },
  ]);
  assert.equal(defaultTemplate(t), ".github/pull_request_template.md");
});

test("the default template is the only one, or none when a folder has several", () => {
  assert.equal(defaultTemplate(templateChoices(["docs/PULL_REQUEST_TEMPLATE.md"])), "docs/PULL_REQUEST_TEMPLATE.md");
  assert.equal(defaultTemplate(templateChoices(["pull_request_template/a.md"])), "pull_request_template/a.md");
  assert.equal(defaultTemplate(templateChoices(["pull_request_template/a.md", "pull_request_template/b.md"])), "");
  assert.equal(defaultTemplate([]), "");
});

test("remote URLs give owner/repo", () => {
  assert.equal(repoFromUrl("https://github.com/almontasser/tusk.git"), "almontasser/tusk");
  assert.equal(repoFromUrl("https://github.com/laravel/framework"), "laravel/framework");
  assert.equal(repoFromUrl("git@github.com:laravel/framework.git"), "laravel/framework");
  assert.equal(repoFromUrl("ssh://git@github.com/me/my.repo.git"), "me/my.repo");
  const remotes = "origin\thttps://github.com/me/framework.git (fetch)\nupstream\tgit@github.com:Laravel/framework.git (fetch)\n";
  assert.equal(remoteFor(remotes, "laravel/framework"), "upstream");
  assert.equal(remoteFor(remotes, "me/framework"), "origin");
  assert.equal(remoteFor(remotes, "other/framework"), undefined);
});

test("the head names the fork's owner only across repositories", () => {
  assert.equal(headSpec("fix", "laravel/framework", "Laravel/Framework"), "fix");
  assert.equal(headSpec("fix", "me/framework", "laravel/framework"), "me:fix");
});

test("gh pr create gets one flag per person, label, and milestone", () => {
  const args = createArgs({ repo: "laravel/framework", base: "13.x", head: "me:fix", title: "  Fix it ", body: "", draft: true, reviewers: ["ann", "laravel/core"], assignees: ["me"], labels: ["bug", "a, b"], milestone: "v13" });
  assert.deepEqual(args, [
    "pr", "create", "--repo", "laravel/framework", "--base", "13.x", "--head", "me:fix", "--title", "Fix it", "--body", "", "--draft",
    "--reviewer", "ann", "--reviewer", "laravel/core", "--assignee", "me", "--label", "bug", "--label", "a, b", "--milestone", "v13",
  ]);
  const plain = createArgs({ repo: "o/r", base: "main", head: "b", title: "T", body: "B", draft: false, reviewers: [], assignees: [], labels: [], milestone: "" });
  assert.deepEqual(plain, ["pr", "create", "--repo", "o/r", "--base", "main", "--head", "b", "--title", "T", "--body", "B"]);
});

test("an existing pull request must come from the head's owner", () => {
  const list = [{ number: 1, headRepositoryOwner: { login: "someone" } }, { number: 2, headRepositoryOwner: { login: "Me" } }];
  assert.equal(existingFrom(list, "me")?.number, 2);
  assert.equal(existingFrom(list, "other"), undefined);
});

test("autosave keys differ per project and branch", () => {
  assert.notEqual(autosaveKey("/a", "x"), autosaveKey("/b", "x"));
  assert.notEqual(autosaveKey("/a", "x"), autosaveKey("/a", "y"));
});

test("numstat reads plain files, renames, and binary files", () => {
  const out = "3\t1\tsrc/a.ts\0" + "1\t0\t\0old name.txt\0new name.txt\0" + "-\t-\timg.png\0";
  assert.deepEqual(parseNumstat(out), [
    { path: "src/a.ts", additions: 3, deletions: 1 },
    { from: "old name.txt", path: "new name.txt", additions: 1, deletions: 0 },
    { path: "img.png", additions: 0, deletions: 0 },
  ]);
  assert.deepEqual(parseNumstat(""), []);
});

test("the head's remote is the upstream's only when it has the branch's name", () => {
  assert.deepEqual(headTarget("fix"), { remote: "origin", branch: "fix" });
  assert.deepEqual(headTarget("fix", "fork/fix"), { remote: "fork", branch: "fix" });
  // A fork's pull request checked out with gh: the branch's remote is the fork's URL.
  assert.deepEqual(headTarget("fix", undefined, { remote: "git@github.com:someone/repo.git", merge: "refs/heads/fix" }), { remote: "git@github.com:someone/repo.git", branch: "fix" });
  assert.deepEqual(headTarget("fix", undefined, { remote: "origin", merge: "refs/heads/main" }), { remote: "origin", branch: "fix" });
  assert.equal(isRemoteUrl("git@github.com:someone/repo.git"), true);
  assert.equal(isRemoteUrl("https://github.com/someone/repo"), true);
  assert.equal(isRemoteUrl("origin"), false);
  assert.deepEqual(headTarget("fix", "upstream/main"), { remote: "origin", branch: "fix" });
  assert.deepEqual(headTarget("feature/x", "origin/feature/x"), { remote: "origin", branch: "feature/x" });
});
