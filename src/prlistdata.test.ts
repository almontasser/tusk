import { test } from "node:test";
import assert from "node:assert/strict";
import { checksQuery, checkStates, cleanQuery, emptyQuery, everywhereSections, filterSummary, type FoundPullRequest, listArgs, searchArgs } from "./prlistdata.ts";

test("the default query asks gh for nothing extra", () => {
  assert.deepEqual(listArgs(emptyQuery()), []);
});

test("filters and the sort become gh pr list flags and search qualifiers", () => {
  const q = { ...emptyQuery(), state: "review", sort: "updated" as const, draft: "ready" as const, label: "bug", assignee: "@me", base: "main", text: " fix " };
  assert.deepEqual(listArgs(q), ["--assignee", "@me", "--label", "bug", "--base", "main", "--draft=false", "--search", "review-requested:@me sort:updated-desc fix"]);
  assert.deepEqual(listArgs({ ...emptyQuery(), state: "merged", draft: "draft", sort: "comments" }), ["--state", "merged", "--draft=true", "--search", "sort:comments-desc"]);
});

test("an author filter wins over Created by me", () => {
  assert.deepEqual(listArgs({ ...emptyQuery(), state: "mine" }), ["--author", "@me"]);
  assert.deepEqual(listArgs({ ...emptyQuery(), state: "mine", author: "taylor" }), ["--author", "taylor"]);
});

test("a stored query falls back to defaults for bad fields", () => {
  assert.deepEqual(cleanQuery(null), emptyQuery());
  assert.deepEqual(cleanQuery({ sort: "stars", draft: "maybe", label: 3, base: "main" }), { ...emptyQuery(), base: "main" });
});

test("the summary names each filter", () => {
  assert.equal(filterSummary(emptyQuery()), "");
  assert.equal(filterSummary({ ...emptyQuery(), sort: "comments", draft: "draft", label: "bug", author: "x" }), "Most commented · Drafts · Label: bug · Author: x");
});

test("everywhere searches pass the text, state, and sort", () => {
  assert.deepEqual(searchArgs("--author=@me", { ...emptyQuery(), text: "fix", sort: "updated" }, 30).slice(0, 8), ["search", "prs", "fix", "--author=@me", "--state=open", "--sort=updated", "--limit", "30"]);
});

test("a pull request shows in the first everywhere section it belongs to", () => {
  const pr = (url: string) => ({ url }) as FoundPullRequest;
  const sections = everywhereSections([[pr("a")], [pr("a"), pr("b")], [pr("b")]]);
  assert.deepEqual(
    sections.map(([t, g]) => [t, g.map((p) => p.url)]),
    [
      ["Waiting for your review", ["a"]],
      ["Yours", ["b"]],
    ],
  );
});

test("check states come back by number from aliased pull requests", () => {
  assert.match(checksQuery([12, 34]), /p12: pullRequest\(number: 12\).*p34: pullRequest\(number: 34\)/);
  const node = (state: string | null) => ({ commits: { nodes: [{ commit: { statusCheckRollup: state ? { state } : null } }] } });
  const states = checkStates({ data: { repository: { p1: node("SUCCESS"), p2: node("FAILURE"), p3: node("PENDING"), p4: node(null), p5: null } } });
  assert.deepEqual([...states], [
    [1, "passed"],
    [2, "failed"],
    [3, "pending"],
    [4, "none"],
  ]);
});
