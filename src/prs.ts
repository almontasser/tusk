// Pull requests through the GitHub CLI (`gh`): list, details, checks, reviews, line comments, and diffs.
// The work is split across the pr*.ts modules; this one wires them together and is what main.ts imports.
import { listNav } from "./listnav";
import { $, type Host, hub, setHost } from "./prshared";
import { loadPullRequests } from "./prlist";
import { updateBranchPullRequest } from "./preditor";
import { renderPullRequest, showPullRequest, threadsChanged } from "./prpage";
import { createPullRequest } from "./prcreate";

export { createPullRequest, loadPullRequests, updateBranchPullRequest };

// The page's functions, which lower modules call through `hub`.
Object.assign(hub, { showPullRequest, renderPullRequest, threadsChanged });

export function initPullRequests(h: Host) {
  setHost(h);
  $("pr-filter").onchange = loadPullRequests;
  let typing: ReturnType<typeof setTimeout> | undefined;
  $("pr-search").oninput = () => (clearTimeout(typing), (typing = setTimeout(loadPullRequests, 400)));
  $("pr-search").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") e.preventDefault(), $("pr-list").focus();
  });
  // Enter or a click opens a pull request.
  listNav($("pr-list"));
  // On a pull request's page, Refresh reloads that pull request.
  $("pr-refresh").onclick = loadPullRequests;
  $("pr-create").onclick = createPullRequest;
}
