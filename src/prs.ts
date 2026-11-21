// Pull requests through the GitHub CLI (`gh`): list, details, checks, reviews, line comments, and diffs.
// The work is split across the pr*.ts modules; this one wires them together and is what main.ts imports.
import { listNav } from "./listnav";
import { mod } from "./platform";
import { $, type Host, host, hub, openUrl, setHost } from "./prshared";
import { clearFilters, loadPullRequests, resetReviewBadge, showFilters, stateChanged, toggleEverywhere, updateReviewBadge } from "./prlist";
import { updateBranchPullRequest } from "./preditor";
import { renderPullRequest, showPullRequest, threadsChanged } from "./prpage";
import { createPullRequest } from "./prcreate";

export { createPullRequest, loadPullRequests, updateBranchPullRequest };

/** On a branch change, which includes opening another project: the status bar's pull request and the badge. */
export function branchChanged() {
  updateBranchPullRequest();
  resetReviewBadge();
  void updateReviewBadge();
}

// The page's functions, which lower modules call through `hub`.
Object.assign(hub, { showPullRequest, renderPullRequest, threadsChanged });

export function initPullRequests(h: Host) {
  setHost(h);
  $("pr-filter").onchange = stateChanged;
  let typing: ReturnType<typeof setTimeout> | undefined;
  $("pr-search").oninput = () => (clearTimeout(typing), (typing = setTimeout(loadPullRequests, 400)));
  $("pr-search").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") e.preventDefault(), $("pr-list").focus();
  });
  // Enter or a click opens a pull request.
  const nav = listNav($("pr-list"));
  // J and K move like ↓ and ↑. They're caught before the list's type-ahead, which would take them as letters.
  $("pr-list-view").addEventListener(
    "keydown",
    (e) => {
      if (e.target !== $("pr-list") || e.metaKey || e.ctrlKey || e.altKey || (e.key !== "j" && e.key !== "k")) return;
      e.preventDefault();
      e.stopPropagation();
      $("pr-list").dispatchEvent(new KeyboardEvent("keydown", { key: e.key === "j" ? "ArrowDown" : "ArrowUp" }));
    },
    true,
  );
  // ⌘⏎ opens the pull request in the next pane, splitting the editor when there's only one, as ⌘\ splits.
  $("pr-list").addEventListener("keydown", (e) => {
    const row = nav.selectedRow();
    if (e.key !== "Enter" || !mod(e) || e.shiftKey || e.altKey || !row) return;
    e.preventDefault();
    const number = Number(row.dataset.key);
    if (!Number.isInteger(number)) return void openUrl(row.dataset.key!); // Another repository's, from Everywhere.
    hub.showPullRequest(number, row.dataset.label);
    host.moveTabToNextPane?.();
  });
  // On a pull request's page, Refresh reloads that pull request.
  $("pr-refresh").onclick = loadPullRequests;
  $("pr-create").onclick = createPullRequest;
  $("pr-filters").onclick = showFilters;
  $("pr-filter-summary").onclick = showFilters;
  $("pr-filter-clear").onclick = clearFilters;
  $("pr-everywhere").onclick = toggleEverywhere;
  // A review request can come at any time; a slow check keeps the badge close while you work in the app.
  setInterval(() => document.hasFocus() && updateReviewBadge(), 5 * 60_000);
}
