// Pull requests through the GitHub CLI (`gh`): list, details, checks, reviews, and diffs.
import { invoke } from "@tauri-apps/api/core";
import { git, showDiff } from "./git";
import { type Check, checkState, checksSummary } from "./gitparse";
import { openTerminal } from "./terminal";

type Author = { login: string };
type PullRequest = {
  number: number;
  title: string;
  author: Author;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  reviewDecision: string;
  statusCheckRollup: Check[] | null;
  url: string;
};
type Details = PullRequest & {
  body: string;
  state: string;
  files: { path: string; additions: number; deletions: number }[];
  comments: { author: Author; body: string }[];
  reviews: { author: Author; state: string; body: string }[];
};

type Host = { root(): string; status(text: string): void; showView(name: "prs"): void };

const $ = (id: string) => document.getElementById(id)!;
const FIELDS = "number,title,author,headRefName,baseRefName,isDraft,reviewDecision,statusCheckRollup,url";
const icons = { passed: "✓", failed: "✗", pending: "●", skipped: "–", none: "" };
const reviews: Record<string, string> = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", REVIEW_REQUIRED: "Review required" };
let host: Host;

const gh = (...args: string[]) => invoke<string>("run_capture", { cwd: host.root(), program: "gh", args, input: null });
const openUrl = (url: string) => invoke("run_capture", { cwd: "/", program: "open", args: [url], input: null });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}

// ---- List ----

export async function loadPullRequests() {
  if (!host.root()) return;
  const filter = ($("pr-filter") as HTMLSelectElement).value;
  const args = { open: [], mine: ["--author", "@me"], review: ["--search", "review-requested:@me"] }[filter] ?? [];
  $("pr-detail").hidden = true;
  $("pr-list-view").hidden = false;
  $("pr-list").replaceChildren(el("li", "muted", "Loading…"));
  try {
    const prs: PullRequest[] = JSON.parse(await gh("pr", "list", "--limit", "50", "--json", FIELDS, ...args));
    $("pr-list").replaceChildren(...(prs.length ? prs.map(prRow) : [el("li", "muted", "No pull requests.")]));
  } catch (e) {
    $("pr-list").replaceChildren(el("li", "muted", `Can't list pull requests: ${String(e).trim()}`));
  }
}

function prRow(pr: PullRequest) {
  const li = el("li", "pr");
  const title = el("div", "pr-title", `#${pr.number} ${pr.title}`);
  if (pr.isDraft) title.prepend(el("span", "badge", "Draft"));
  const checks = checksSummary(pr.statusCheckRollup);
  const meta = el("div", "pr-meta");
  meta.append(
    el("span", `checks-${checks}`, icons[checks]),
    ` ${pr.author.login} · ${pr.headRefName} → ${pr.baseRefName}`,
    reviews[pr.reviewDecision] ? ` · ${reviews[pr.reviewDecision]}` : "",
  );
  li.append(title, meta);
  li.onclick = () => showPullRequest(pr.number);
  return li;
}

// ---- Details ----

export async function showPullRequest(number: number) {
  host.showView("prs");
  $("pr-list-view").hidden = true;
  const detail = $("pr-detail");
  detail.hidden = false;
  detail.replaceChildren(el("p", "muted", "Loading…"));
  let pr: Details;
  try {
    pr = JSON.parse(await gh("pr", "view", String(number), "--json", `${FIELDS},body,state,files,comments,reviews`));
  } catch (e) {
    detail.replaceChildren(el("p", "muted", `Can't load #${number}: ${String(e).trim()}`));
    return;
  }

  const back = el("button", "link", "← All pull requests");
  back.onclick = loadPullRequests;
  const actions = el("div", "pr-actions");
  const action = (label: string, run: () => unknown) => {
    const b = el("button", "", label);
    b.onclick = run;
    actions.append(b);
  };
  action("Check Out", () => openTerminal(host.root(), `Check out #${number}`, ["gh", "pr", "checkout", String(number)]));
  action("Open in Browser", () => openUrl(pr.url));
  action("Refresh", () => showPullRequest(number));

  const checks = el("ul", "pr-checks");
  for (const c of pr.statusCheckRollup ?? []) {
    const state = checkState(c);
    const li = el("li");
    li.append(el("span", `checks-${state}`, icons[state]), ` ${c.name ?? c.context}`);
    const url = c.detailsUrl ?? c.targetUrl;
    if (url) li.onclick = () => openUrl(url);
    checks.append(li);
  }

  const files = el("ul", "pr-files");
  for (const f of pr.files) {
    const li = el("li");
    li.append(el("span", "name", f.path), el("span", "added", `+${f.additions}`), el("span", "deleted", `−${f.deletions}`));
    li.onclick = () => showFileDiff(pr, f.path);
    files.append(li);
  }

  const conversation = el("div", "pr-conversation");
  const entry = (author: string, label: string, body: string) => {
    const item = el("div", "pr-comment");
    item.append(el("div", "pr-meta", `${author}${label ? ` · ${label}` : ""}`), el("div", "pr-body", body));
    conversation.append(item);
  };
  if (pr.body) entry(pr.author.login, "description", pr.body);
  for (const r of pr.reviews) if (r.body || r.state !== "COMMENTED") entry(r.author.login, reviews[r.state] ?? r.state.toLowerCase(), r.body);
  for (const c of pr.comments) entry(c.author.login, "", c.body);

  const heading = (text: string) => el("h3", "", text);
  const meta = el("div", "pr-meta", `${pr.state.toLowerCase()} · ${pr.author.login} · ${pr.headRefName} → ${pr.baseRefName}`);
  detail.replaceChildren(
    back,
    el("h2", "", `#${pr.number} ${pr.title}`),
    meta,
    actions,
    heading(`Checks (${pr.statusCheckRollup?.length ?? 0})`),
    checks,
    heading(`Files (${pr.files.length})`),
    files,
    heading("Conversation"),
    conversation,
  );
}

/** Fetches the pull request's head and base, then diffs a file from their merge base to the head. */
async function showFileDiff(pr: Details, path: string) {
  const head = `refs/remotes/pr/${pr.number}`;
  const base = `refs/remotes/origin/${pr.baseRefName}`;
  try {
    host.status(`Fetching #${pr.number}…`);
    await git("fetch", "--no-tags", "origin", `+refs/pull/${pr.number}/head:${head}`, `+refs/heads/${pr.baseRefName}:${base}`);
    const mergeBase = (await git("merge-base", head, base)).trim();
    const show = (spec: string) => git("show", spec).catch(() => "");
    showDiff(path, await show(`${mergeBase}:${path}`), await show(`${head}:${path}`), `#${pr.number}: ${pr.baseRefName} ↔ ${pr.headRefName}`);
    host.status("");
  } catch (e) {
    host.status(`Can't show the diff: ${String(e).trim()}`);
  }
}

// ---- Current branch ----

/** Shows the pull request for the current branch next to the branch name. */
export async function updateBranchPullRequest() {
  const button = $("branch-pr");
  button.hidden = true;
  if (!host.root()) return;
  try {
    const pr: PullRequest = JSON.parse(await gh("pr", "view", "--json", FIELDS));
    const checks = checksSummary(pr.statusCheckRollup);
    button.innerHTML = `<span class="codicon codicon-git-pull-request"></span><span class="label"></span>`;
    button.querySelector(".label")!.textContent = `#${pr.number} ${icons[checks]}`;
    button.title = `${pr.title} (checks ${checks})`;
    button.onclick = () => showPullRequest(pr.number);
    button.hidden = false;
  } catch {
    // No pull request for this branch, or no GitHub remote.
  }
}

export const createPullRequest = () => openTerminal(host.root(), "gh pr create", ["gh", "pr", "create"]);

export function initPullRequests(h: Host) {
  host = h;
  $("pr-filter").onchange = loadPullRequests;
  $("pr-refresh").onclick = loadPullRequests;
  $("pr-create").onclick = createPullRequest;
}
