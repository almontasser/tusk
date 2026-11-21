// Pull requests: the list's query, as `gh` arguments, and its other pure logic. No DOM here, so tests can import it.
import { checkState, type CheckState } from "./gitparse.ts";

export type Sort = "created" | "updated" | "comments";
/** What the sidebar list shows. `state` is the state menu's value: open, mine, review, closed, merged, or all. */
export type PrQuery = { state: string; sort: Sort; draft: "" | "draft" | "ready"; label: string; author: string; assignee: string; base: string; text: string };
export const SORTS: Record<Sort, string> = { created: "Newest", updated: "Recently updated", comments: "Most commented" };
export const emptyQuery = (): PrQuery => ({ state: "open", sort: "created", draft: "", label: "", author: "", assignee: "", base: "", text: "" });

/** A stored query, with missing or wrong fields set to their defaults, since the project file can be edited by hand. */
export function cleanQuery(saved: unknown): PrQuery {
  const q = emptyQuery();
  if (!saved || typeof saved !== "object") return q;
  for (const k of Object.keys(q) as (keyof PrQuery)[]) {
    const v = (saved as Record<string, unknown>)[k];
    if (typeof v === "string") (q as Record<string, string>)[k] = v;
  }
  if (!(q.sort in SORTS)) q.sort = "created";
  if (!["", "draft", "ready"].includes(q.draft)) q.draft = "";
  return q;
}

/** Whether the closed, merged, or all list is shown, which leaves check status out (GitHub times out building it). */
export const closedList = (q: PrQuery) => ["closed", "merged", "all"].includes(q.state);

/** The `gh pr list` arguments for a query, after `--limit` and `--json`. */
export function listArgs(q: PrQuery): string[] {
  // `gh pr list` has no --sort; GitHub's search syntax sorts. Newest first is its order without one.
  const search = [q.state === "review" ? "review-requested:@me" : "", q.sort === "created" ? "" : `sort:${q.sort}-desc`, q.text.trim()].filter(Boolean).join(" ");
  const author = q.author || (q.state === "mine" ? "@me" : "");
  return [
    ...(closedList(q) ? ["--state", q.state] : []),
    ...(author ? ["--author", author] : []),
    ...(q.assignee ? ["--assignee", q.assignee] : []),
    ...(q.label ? ["--label", q.label] : []),
    ...(q.base ? ["--base", q.base] : []),
    ...(q.draft ? [`--draft=${q.draft === "draft"}`] : []),
    ...(search ? ["--search", search] : []),
  ];
}

/** The filters set besides the state and the search box, as "Label: bug · Author: someone", or "". */
export function filterSummary(q: PrQuery): string {
  return [
    q.sort !== "created" ? SORTS[q.sort] : "",
    q.draft === "draft" ? "Drafts" : q.draft === "ready" ? "Ready for review" : "",
    q.label && `Label: ${q.label}`,
    q.author && `Author: ${q.author}`,
    q.assignee && `Assignee: ${q.assignee}`,
    q.base && `Base: ${q.base}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

// ---- Everywhere: your pull requests across repositories ----

export const SEARCH_FIELDS = "number,title,repository,url,isDraft,author,updatedAt,labels";
export type FoundPullRequest = { number: number; title: string; repository: { nameWithOwner: string }; url: string; isDraft: boolean; author: { login: string }; updatedAt: string; labels: { name: string; color: string }[] };
/** The three searches of the Everywhere list, by section title, as `gh search prs` flags. */
export const EVERYWHERE: [string, string][] = [
  ["Waiting for your review", "--review-requested=@me"],
  ["Yours", "--author=@me"],
  ["Assigned to you", "--assignee=@me"],
];

/** The `gh search prs` arguments for one of the Everywhere searches, with the search box's text and the sort. */
export function searchArgs(flag: string, q: PrQuery, limit: number): string[] {
  // The words go after `--`, so one such as `-label:bug` isn't read as a flag, and one by one, since gh quotes an
  // argument with a space in it as a phrase.
  const words = q.text.trim().split(/\s+/).filter(Boolean);
  return ["search", "prs", flag, "--state=open", `--sort=${q.sort}`, "--limit", String(limit), "--json", SEARCH_FIELDS, ...(words.length ? ["--", ...words] : [])];
}

/** The Everywhere sections, each pull request in the first one it belongs to, and the empty sections left out. */
export function everywhereSections(results: FoundPullRequest[][]): [string, FoundPullRequest[]][] {
  const shown = new Set<string>();
  return EVERYWHERE.map(([title], i): [string, FoundPullRequest[]] => [
    title,
    (results[i] ?? []).filter((p) => !shown.has(p.url) && shown.add(p.url)),
  ]).filter(([, g]) => g.length);
}

// ---- Check status, loaded later for the closed lists ----

/** One GraphQL query for the check status of several pull requests, one alias each. */
export function checksQuery(numbers: number[]): string {
  const prs = numbers.map((n) => `p${n}: pullRequest(number: ${Math.trunc(n)}) { commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }`);
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${prs.join(" ")} } }`;
}

type RollupReply = { data?: { repository?: Record<string, { commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] } } | null> } };
/** The checks' state of each pull request in a `checksQuery` reply, by number; "none" when it has no checks. */
export function checkStates(reply: RollupReply): Map<number, CheckState | "none"> {
  const states = new Map<number, CheckState | "none">();
  for (const [alias, pr] of Object.entries(reply.data?.repository ?? {})) {
    if (!pr) continue;
    const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;
    // The rollup's state is a commit status state: SUCCESS, FAILURE, ERROR, PENDING, or EXPECTED.
    states.set(Number(alias.slice(1)), rollup ? checkState({ state: rollup.state }) : "none");
  }
  return states;
}
