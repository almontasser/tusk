// Pull requests: the list in the sidebar, its query and saved searches, the Everywhere scope, the review badge,
// its review queue sections, and the new-activity marks. The query's pure logic is in prlistdata.ts.
import { checksSummary } from "./gitparse";
import { errorText } from "./status";
import { openTerminal } from "./terminal";
import { type Item, pick, rank } from "./palette";
import { projectValue, setProjectValue } from "./projectstate";
import { checksQuery, checkStates, cleanQuery, closedList, emptyQuery, EVERYWHERE, everywhereSections, filterSummary, type FoundPullRequest, listArgs, type PrQuery, searchArgs, type Sort, SORTS } from "./prlistdata";
import { $, checkIcon, el, gh, host, hub, icon, labelChip, LIST_FIELDS, type ListedPullRequest, me, myLogin, openUrl, pages, reviews, when } from "./prshared";

// ---- List ----

/** How many pull requests the list asks for; Load More asks for 50 more. */
let limit = 50;

export async function loadPullRequests() {
  if (!host.root()) return;
  restore();
  query.state = ($("pr-filter") as HTMLSelectElement).value;
  query.text = ($("pr-search") as HTMLInputElement).value;
  const text = query.text.trim();
  // Switching back to the view keeps the last list while it refreshes; a new project, filter, or search starts over.
  const key = JSON.stringify([host.root(), everywhere, { ...query, text }]);
  if ($("pr-list").dataset.key !== key) ($("pr-list").dataset.key = key), (limit = 50), lazyChecks.clear(), wanted.clear(), $("pr-list").replaceChildren(el("li", "muted", "Loading…"));
  void updateReviewBadge(true);
  const more = el("li", "pr-more");
  const button = el("button", "", "Load More");
  button.onclick = () => ((limit += 50), (button.disabled = true), (button.textContent = "Loading…"), loadPullRequests());
  more.append(button);
  try {
    if (everywhere) return await loadEverywhere(key, more);
    // GitHub times out building the check status of 50 closed pull requests; the rows on screen load it later.
    const closed = closedList(query);
    const fields = closed ? LIST_FIELDS.replace(",statusCheckRollup", "").replace(",reviewRequests", "") : LIST_FIELDS;
    const [prs]: [ListedPullRequest[], unknown] = await Promise.all([gh("pr", "list", "--limit", String(limit), "--json", fields, ...listArgs(query)).then(JSON.parse), me()]);
    if ($("pr-list").dataset.key !== key) return; // A newer search replaced this one.
    const seenAt = seen();
    // GitHub's search syntax, such as "label:bug" or "author:someone", works in the search box too.
    const filtered = !!(text || filterSummary(query));
    checkObserver?.disconnect();
    $("pr-list").replaceChildren(
      ...(prs.length ? sections(query.state === "open" && !filtered ? prs : [], prs).flatMap(([title, group]) => [...(title ? [sectionHead(title, group.length)] : []), ...group.map((pr) => prRow(pr, seenAt, closed))]) : [el("li", "muted", filtered ? "No pull requests match the search and filters." : "No pull requests.")]),
      // gh has no offset, so Load More asks for a longer list; a full page means there may be more.
      ...(prs.length === limit ? [more] : []),
    );
  } catch (e) {
    if ($("pr-list").dataset.key === key) $("pr-list").replaceChildren(problemItem("Can't list pull requests", e));
  }
}

// ---- Query: the state menu, the search box, sorting, filters, and saved searches ----

/** The list's query and scope, read from the project the first time the list loads for it, and kept per project. */
let query = emptyQuery();
let everywhere = false;
let restoredFor: string | undefined;
const LIST_KEY = "pullRequestList";
const SAVED_KEY = "pullRequestSearches";
type Saved = { name: string; query: PrQuery };

function restore() {
  if (restoredFor === host.root()) return;
  restoredFor = host.root();
  const saved = projectValue<{ query?: unknown; everywhere?: unknown }>(LIST_KEY);
  // The search box's text isn't remembered on its own; a saved search keeps it.
  query = { ...cleanQuery(saved?.query), text: "" };
  everywhere = saved?.everywhere === true;
  showQuery();
}

/** Shows the query in the view's controls. */
function showQuery() {
  const state = $("pr-filter") as HTMLSelectElement;
  state.value = query.state;
  if (state.value !== query.state) (query.state = "open"), (state.value = "open");
  // Everywhere lists open pull requests across repositories; the state menu and the filters are this repository's.
  state.disabled = everywhere;
  ($("pr-search") as HTMLInputElement).value = query.text;
  const scope = $("pr-everywhere");
  scope.setAttribute("aria-pressed", String(everywhere));
  scope.classList.toggle("active", everywhere);
  const summary = everywhere ? "" : filterSummary(query);
  $("pr-filter-bar").hidden = !summary;
  $("pr-filter-summary").textContent = summary;
  $("pr-filters").classList.toggle("active", !!summary);
}

/** Changes the query: remembers it for the project, shows it, and lists again. */
function setQuery(change: Partial<PrQuery>, scope = everywhere) {
  restore();
  query = { ...query, ...change };
  everywhere = scope;
  setProjectValue(LIST_KEY, { query: { ...query, text: "" }, everywhere }).catch((e) => host.status(`Can't save the pull request filters: ${errorText(e)}`));
  showQuery();
  return loadPullRequests();
}

export const stateChanged = () => setQuery({ state: ($("pr-filter") as HTMLSelectElement).value });
export const toggleEverywhere = () => setQuery({}, !everywhere);
export const clearFilters = () => setQuery({ ...emptyQuery(), state: query.state, text: query.text });

const savedSearches = () => (projectValue<Saved[]>(SAVED_KEY) ?? []).filter((s) => s && typeof s.name === "string");
const saveSearches = (list: Saved[]) => setProjectValue(SAVED_KEY, list.length ? list : undefined).catch((e) => host.status(`Can't save the searches: ${errorText(e)}`));
const check = (on: boolean) => (on ? "codicon-check" : "codicon-blank");

/** The filter popup: sort, draft state, label, people, base branch, and saved searches. */
export function showFilters() {
  restore();
  const anchor = $("pr-filters");
  const ask = (title: string, value: string, set: (v: string) => unknown, hint: string) =>
    pick(title, (q) => [...(q.trim() ? [{ label: q.trim(), detail: "Press ⏎", run: () => set(q.trim()) }] : [{ label: value ? `Any (clear ${value})` : hint, run: () => set("") }])], 0, { value, anchor, title });
  const items: Item[] = [
    ...(Object.keys(SORTS) as Sort[]).map((s) => ({ label: `Sort: ${SORTS[s]}`, icon: check(query.sort === s), run: () => setQuery({ sort: s }) })),
    ...([["", "Drafts and ready"], ["draft", "Drafts only"], ["ready", "Ready for review only"]] as const).map(([d, label]) => ({ label, icon: check(query.draft === d), run: () => setQuery({ draft: d }) })),
    { label: "Label…", detail: query.label, icon: "codicon-tag", run: chooseLabel },
    { label: "Author…", detail: query.author, icon: "codicon-person", run: () => ask("Author: a GitHub login, or @me", query.author, (v) => setQuery({ author: v }), "Type a login") },
    { label: "Assignee…", detail: query.assignee, icon: "codicon-person", run: () => ask("Assignee: a GitHub login, or @me", query.assignee, (v) => setQuery({ assignee: v }), "Type a login") },
    { label: "Base branch…", detail: query.base, icon: "codicon-git-branch", run: () => ask("Base branch", query.base, (v) => setQuery({ base: v }), "Type a branch name") },
    ...(filterSummary(query) ? [{ label: "Clear Filters", icon: "codicon-clear-all", run: clearFilters }] : []),
    ...savedSearches().map((s) => ({ label: `Saved: ${s.name}`, detail: [s.query.text, filterSummary(s.query)].filter(Boolean).join(" · "), icon: "codicon-bookmark", run: () => setQuery(cleanQuery(s.query), false) })),
    { label: "Save This Search…", icon: "codicon-save", run: saveSearch },
    ...(savedSearches().length ? [{ label: "Delete a Saved Search…", icon: "codicon-trash", run: deleteSearch }] : []),
  ];
  pick("Sort and filter pull requests", (q) => (q.trim() ? rank(q, items) : items), 0, { value: "", anchor });
}

async function chooseLabel() {
  const anchor = $("pr-filters");
  let labels: { name: string; color: string }[] = [];
  pick("Label", async (q) => {
    labels = labels.length ? labels : JSON.parse(await gh("label", "list", "--limit", "200", "--json", "name,color"));
    const items: Item[] = [...(query.label ? [{ label: "Any label", icon: "codicon-close", run: () => setQuery({ label: "" }) }] : []), ...labels.map((l) => ({ label: l.name, icon: check(query.label === l.name), run: () => setQuery({ label: l.name }) }))];
    return q.trim() ? rank(q, items) : items;
  }, 0, { value: "", anchor, title: "Label" });
}

function saveSearch() {
  const current = { ...query, text: query.text.trim() };
  pick("Name this search", (q) => (q.trim() ? [{ label: q.trim(), detail: "Press ⏎ to save", run: () => saveSearches([...savedSearches().filter((s) => s.name !== q.trim()), { name: q.trim(), query: current }]) }] : []), 0, {
    value: "",
    anchor: $("pr-filters"),
    title: "Save this search",
  });
}

function deleteSearch() {
  const list = savedSearches();
  pick("Delete a saved search", (q) => rank(q, list.map((s) => ({ label: s.name, icon: "codicon-trash", run: () => saveSearches(savedSearches().filter((x) => x.name !== s.name)) }))), 0, { value: "", anchor: $("pr-filters"), title: "Delete a saved search" });
}

// ---- Everywhere: your open pull requests in every repository ----

/** The project's repository as owner/name, so its pull requests open in Tusk; "" when it has none. */
let repoOf: { root: string; name: Promise<string> } | undefined;
function thisRepo() {
  if (repoOf?.root !== host.root()) repoOf = { root: host.root(), name: gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner").then((n) => n.trim(), () => "") };
  return repoOf.name;
}

async function loadEverywhere(key: string, more: HTMLElement) {
  const [results, repo] = await Promise.all([Promise.all(EVERYWHERE.map(([, flag]) => gh(...searchArgs(flag, query, limit)).then((out) => JSON.parse(out) as FoundPullRequest[]))), thisRepo()]);
  if ($("pr-list").dataset.key !== key) return;
  const groups = everywhereSections(results);
  $("pr-list").replaceChildren(
    ...(groups.length ? groups.flatMap(([title, group]) => [sectionHead(title, group.length), ...group.map((pr) => foundRow(pr, repo))]) : [el("li", "muted", query.text.trim() ? "None of your open pull requests match the search." : "You have no open pull requests to review, of your own, or assigned to you.")]),
    ...(results.some((r) => r.length === limit) ? [more] : []),
  );
}

/** A row of the Everywhere list. This repository's pull requests open in a tab; others open in the browser. */
function foundRow(pr: FoundPullRequest, repo: string) {
  const here = pr.repository.nameWithOwner === repo;
  const li = el("li", "pr");
  li.role = "option";
  // A number names this repository's pull requests, as in the other lists; a URL names the rest.
  li.dataset.key = here ? String(pr.number) : pr.url;
  li.dataset.label = pr.title;
  li.classList.toggle("open", here && pages.has(pr.number));
  const state = icon(pr.isDraft ? "git-pull-request-draft" : "git-pull-request", `pr-row-state ${pr.isDraft ? "draft" : "open"}`);
  state.title = pr.isDraft ? "Draft" : "Open";
  const meta = el("div", "pr-meta");
  meta.append(`${here ? "" : pr.repository.nameWithOwner}#${pr.number} · ${pr.author.login}`, when(pr.updatedAt));
  for (const l of pr.labels) meta.append(" ", labelChip(l));
  const text = el("div", "pr-row-text");
  text.append(el("div", "pr-title", pr.title), meta);
  li.append(state, text);
  li.title = `${pr.repository.nameWithOwner}#${pr.number} ${pr.title}${here ? "" : "\nOpens in your browser"}`;
  li.onclick = () => (here ? hub.showPullRequest(pr.number, pr.title) : openUrl(pr.url));
  return li;
}

// ---- The badge on the activity bar's Pull Requests icon ----

let badgeAt = 0;
/** Counts the open pull requests waiting for your review in this repository, at most every 30 seconds when `soon`. */
export async function updateReviewBadge(soon = false) {
  const root = host.root();
  const button = document.querySelector<HTMLElement>('#activitybar [data-view="prs"]')!;
  const show = (count: number) => {
    if (host.root() !== root) return;
    button.dataset.count = count > 99 ? "99+" : count ? String(count) : "";
    button.title = count ? `Pull Requests (${count} waiting for your review)` : "Pull Requests";
    button.setAttribute("aria-label", button.title);
  };
  if (!root) return show(0);
  if (soon && Date.now() - badgeAt < 30_000) return;
  badgeAt = Date.now();
  try {
    show((JSON.parse(await gh("pr", "list", "--search", "review-requested:@me", "--limit", "100", "--json", "number")) as unknown[]).length);
  } catch {
    show(0); // No GitHub remote, or gh isn't set up; the list says why.
  }
}
/** Forgets when the badge last loaded, so a project switch counts again at once. */
export const resetReviewBadge = () => (badgeAt = 0);

// ---- Check status for the closed lists, loaded for the rows on screen ----

/** Each pull request's checks, once loaded, for the list on screen; a new list starts over. */
const lazyChecks = new Map<number, string>();
let checkObserver: IntersectionObserver | undefined;
const wanted = new Set<number>();
let checkTimer: ReturnType<typeof setTimeout> | undefined;

/** Fills in a row's check icon now when it's known, or once the row scrolls into view. */
function watchChecks(li: HTMLElement, number: number) {
  const known = lazyChecks.get(number);
  if (known) return fillChecks(li, known);
  checkObserver ??= new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) checkObserver!.unobserve(e.target), wanted.add(Number((e.target as HTMLElement).dataset.key));
    // Rows that come into view together, or while scrolling, go out as one query.
    clearTimeout(checkTimer);
    if (wanted.size) checkTimer = setTimeout(loadChecks, 200);
  });
  checkObserver.observe(li);
}

async function loadChecks() {
  const numbers = [...wanted].slice(0, 50);
  if (!numbers.length) return;
  numbers.forEach((n) => wanted.delete(n));
  if (wanted.size) checkTimer = setTimeout(loadChecks, 0);
  const key = $("pr-list").dataset.key;
  try {
    const reply = JSON.parse(await gh("api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${checksQuery(numbers)}`));
    if ($("pr-list").dataset.key !== key) return;
    for (const [n, state] of checkStates(reply)) {
      lazyChecks.set(n, state);
      const li = $("pr-list").querySelector<HTMLElement>(`li.pr[data-key="${n}"]`);
      if (li) fillChecks(li, state);
    }
  } catch {
    // The rows stay without a check icon, as before this loaded lazily.
  }
}

function fillChecks(li: HTMLElement, state: string) {
  const slot = li.querySelector(".pr-checks");
  if (slot && state !== "none") slot.replaceChildren(" ", checkIcon(state));
}

/**
 * The open list split as a review queue: pull requests waiting for your review, then yours, then everyone else's,
 * each newest first. Without a split (a filter, a search, or one group only), one untitled group.
 */
function sections(split: ListedPullRequest[], all: ListedPullRequest[]): [string, ListedPullRequest[]][] {
  if (!split.length || !myLogin) return [["", all]];
  const asked = split.filter((p) => p.reviewRequests?.some((r) => r.login === myLogin));
  const mine = split.filter((p) => p.author.login === myLogin && !asked.includes(p));
  const rest = split.filter((p) => !asked.includes(p) && !mine.includes(p));
  const groups: [string, ListedPullRequest[]][] = [
    ["Waiting for your review", asked],
    ["Yours", mine],
    ["Everyone else", rest],
  ];
  return groups.filter(([, g]) => g.length).length > 1 ? groups.filter(([, g]) => g.length) : [["", all]];
}

function sectionHead(title: string, count: number) {
  const li = el("li", "pr-list-section");
  li.role = "presentation";
  li.append(title, el("span", "pr-count", String(count)));
  return li;
}

/**
 * A list item for a failed `gh` command: how to install the GitHub CLI or log in when that's the problem, with a
 * button that does it, or else the error and a Retry button.
 */
export function problemItem(what: string, e: unknown, retry: () => unknown = loadPullRequests) {
  const text = errorText(e);
  const li = el("li", "muted pr-problem");
  const button = (label: string, run: () => unknown) => {
    const b = el("button", "", label);
    b.onclick = run;
    li.append(el("br"), b);
  };
  if (/os error 2|No such file/i.test(text)) {
    li.textContent = "Pull requests need the GitHub CLI (gh). Install it from cli.github.com, then log in to GitHub with it.";
    button("Get the GitHub CLI", () => openUrl("https://cli.github.com"));
  } else if (/gh auth login|not logged in|authenticat/i.test(text)) {
    li.textContent = "Log in to GitHub with the GitHub CLI to see pull requests.";
    button("Log In…", () => openTerminal(host.root(), "gh auth login", ["gh", "auth", "login"], () => retry()));
  } else if (/no git remotes|known GitHub host|not a git repository/i.test(text)) li.textContent = "This project has no GitHub remote.";
  else {
    li.textContent = `${what}: ${text}`;
    button("Retry", retry);
  }
  return li;
}

/**
 * When you last saw each pull request you opened, by its `updatedAt` then, per project. Kept in this computer's
 * storage; losing it only loses the marks.
 */
const seenKey = () => `pr-seen:${host.root()}`;
function seen(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(seenKey()) ?? "{}");
  } catch {
    return {};
  }
}
export function markSeen(number: number, updatedAt: string) {
  try {
    localStorage.setItem(seenKey(), JSON.stringify({ ...seen(), [number]: updatedAt }));
  } catch {
    // Storage is off; the list just doesn't mark new activity.
  }
  $("pr-list").querySelector(`li.pr[data-key="${number}"]`)?.classList.remove("unseen");
}

function prRow(pr: ListedPullRequest, seenAt: Record<string, string> = {}, lazy = false) {
  const li = el("li", "pr");
  li.role = "option";
  li.dataset.key = String(pr.number);
  li.dataset.label = pr.title;
  li.classList.toggle("open", pages.has(pr.number));
  const kind = pr.state === "MERGED" ? ["git-merge", "merged"] : pr.state === "CLOSED" ? ["git-pull-request-closed", "closed"] : pr.isDraft ? ["git-pull-request-draft", "draft"] : ["git-pull-request", "open"];
  const state = icon(kind[0], `pr-row-state ${kind[1]}`);
  state.title = kind[1][0].toUpperCase() + kind[1].slice(1);
  const title = el("div", "pr-title", pr.title);
  const meta = el("div", "pr-meta");
  const checks = checksSummary(pr.statusCheckRollup);
  meta.append(`#${pr.number} · ${pr.author.login}`, when(pr.updatedAt));
  if (checks !== "none") meta.append(" ", checkIcon(checks));
  if (lazy) meta.append(el("span", "pr-checks"));
  if (reviews[pr.reviewDecision]) meta.append(` · ${reviews[pr.reviewDecision]}`);
  for (const l of pr.labels) meta.append(" ", labelChip(l));
  const text = el("div", "pr-row-text");
  text.append(title, meta);
  li.append(state, text);
  li.title = `#${pr.number} ${pr.title}\n${pr.headRefName} → ${pr.baseRefName} · +${pr.additions} −${pr.deletions}`;
  // A pull request you opened before, which changed since, as GitHub marks unread notifications.
  const before = seenAt[pr.number];
  if (before && Date.parse(pr.updatedAt) > Date.parse(before)) {
    li.classList.add("unseen");
    li.title += "\nNew activity since you last opened it";
  }
  li.onclick = () => hub.showPullRequest(pr.number, pr.title);
  if (lazy) watchChecks(li, pr.number);
  return li;
}

/** Marks every pull request that has a tab open in the sidebar list, not only the tab in front. */
export const markOpenRows = () => $("pr-list").querySelectorAll<HTMLElement>("li.pr").forEach((li) => li.classList.toggle("open", pages.has(Number(li.dataset.key))));
