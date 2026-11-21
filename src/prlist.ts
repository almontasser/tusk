// Pull requests: the list in the sidebar, its review queue sections, and the new-activity marks.
import { checksSummary } from "./gitparse";
import { errorText } from "./status";
import { openTerminal } from "./terminal";
import { $, checkIcon, el, gh, host, hub, icon, labelChip, LIST_FIELDS, type ListedPullRequest, me, myLogin, openUrl, reviews, when } from "./prshared";

// ---- List ----

/** How many pull requests the list asks for; Load More asks for 50 more. */
let limit = 50;

export async function loadPullRequests() {
  if (!host.root()) return;
  const filter = ($("pr-filter") as HTMLSelectElement).value;
  const text = ($("pr-search") as HTMLInputElement).value.trim();
  // GitHub's search syntax, such as "label:bug" or "author:someone", works in the search box too.
  const search = [filter === "review" ? "review-requested:@me" : "", text].filter(Boolean).join(" ");
  const state = ["closed", "merged", "all"].includes(filter) ? ["--state", filter] : [];
  const args = [...(filter === "mine" ? ["--author", "@me"] : []), ...state, ...(search ? ["--search", search] : [])];
  // Switching back to the view keeps the last list while it refreshes; a new project, filter, or search starts over.
  const key = `${host.root()}\0${filter}\0${text}`;
  if ($("pr-list").dataset.key !== key) ($("pr-list").dataset.key = key), (limit = 50), $("pr-list").replaceChildren(el("li", "muted", "Loading…"));
  try {
    // GitHub times out building the check status of 50 closed pull requests, and it matters little once closed.
    const fields = state.length ? LIST_FIELDS.replace(",statusCheckRollup", "").replace(",reviewRequests", "") : LIST_FIELDS;
    const [prs]: [ListedPullRequest[], unknown] = await Promise.all([gh("pr", "list", "--limit", String(limit), "--json", fields, ...args).then(JSON.parse), me()]);
    if ($("pr-list").dataset.key !== key) return; // A newer search replaced this one.
    const seenAt = seen();
    const more = el("li", "pr-more");
    const button = el("button", "", "Load More");
    button.onclick = () => ((limit += 50), (button.disabled = true), (button.textContent = "Loading…"), loadPullRequests());
    more.append(button);
    $("pr-list").replaceChildren(
      ...(prs.length ? sections(filter === "open" && !text ? prs : [], prs).flatMap(([title, group]) => [...(title ? [sectionHead(title, group.length)] : []), ...group.map((pr) => prRow(pr, seenAt))]) : [el("li", "muted", text ? "No pull requests match the search." : "No pull requests.")]),
      // gh has no offset, so Load More asks for a longer list; a full page means there may be more.
      ...(prs.length === limit ? [more] : []),
    );
  } catch (e) {
    $("pr-list").replaceChildren(problemItem("Can't list pull requests", e));
  }
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

function prRow(pr: ListedPullRequest, seenAt: Record<string, string> = {}) {
  const li = el("li", "pr");
  li.role = "option";
  li.dataset.key = String(pr.number);
  li.dataset.label = pr.title;
  li.classList.toggle("open", hub.openNumber === pr.number);
  const kind = pr.state === "MERGED" ? ["git-merge", "merged"] : pr.state === "CLOSED" ? ["git-pull-request-closed", "closed"] : pr.isDraft ? ["git-pull-request-draft", "draft"] : ["git-pull-request", "open"];
  const state = icon(kind[0], `pr-row-state ${kind[1]}`);
  state.title = kind[1][0].toUpperCase() + kind[1].slice(1);
  const title = el("div", "pr-title", pr.title);
  const meta = el("div", "pr-meta");
  const checks = checksSummary(pr.statusCheckRollup);
  meta.append(`#${pr.number} · ${pr.author.login}`, when(pr.updatedAt));
  if (checks !== "none") meta.append(" ", checkIcon(checks));
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
  return li;
}

/** Marks the open pull request in the sidebar list. */
export const markOpenRow = () => $("pr-list").querySelectorAll<HTMLElement>("li.pr").forEach((li) => li.classList.toggle("open", li.dataset.key === String(hub.openNumber)));
