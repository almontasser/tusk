// Pull requests: the New Pull Request form.
import { invoke } from "@tauri-apps/api/core";
import { git, gitStatus, gitTask } from "./git";
import { age } from "./gitparse";
import { showError, withProgress } from "./status";
import { closeView, showEditorView } from "./terminal";
import { mod } from "./platform.ts";
import { el, gh, host, icon } from "./prshared";
import { loadPullRequests, problemItem } from "./prlist";
import { updateBranchPullRequest } from "./preditor";
import { showPullRequest } from "./prpage";

// ---- Creating a pull request ----

let createPage: HTMLElement | undefined;

/**
 * Opens a form for a pull request from the current branch, in an editor tab: the base branch, a title from the
 * commits or branch name, a body from the repository's template or the commits' subjects, and the commits it
 * would add. Creating pushes the branch first when the remote doesn't have its commits.
 */
export async function createPullRequest() {
  const branch = gitStatus()?.branch;
  if (!branch || branch.startsWith("HEAD")) return showError("Switch to a branch first: a pull request needs one to merge from.");
  const page = (createPage ??= el("div", "pr-create"));
  page.replaceChildren(el("p", "muted pr-loading", "Loading…"));
  showEditorView("New Pull Request", page, "git-pull-request-create", () => {});
  page.hidden = false;
  let base: string;
  let branches: string[];
  try {
    const [existing, repo, remote] = await Promise.all([
      gh("pr", "view", branch, "--json", "number,title,state").then((o) => JSON.parse(o) as { number: number; title: string; state: string }, () => null),
      gh("repo", "view", "--json", "defaultBranchRef").then((o) => JSON.parse(o) as { defaultBranchRef: { name: string } }),
      git("for-each-ref", "--format=%(refname:lstrip=3)", "refs/remotes/origin"),
    ]);
    if (existing?.state === "OPEN") {
      const open = el("button", "primary", `Open #${existing.number}`);
      open.onclick = () => showPullRequest(existing.number, existing.title);
      const note = el("div", "pr-create-note");
      note.append(el("p", "", `${branch} already has an open pull request: #${existing.number} ${existing.title}.`), open);
      return page.replaceChildren(note);
    }
    base = repo.defaultBranchRef.name;
    branches = remote.split("\n").filter((b) => b && b !== "HEAD" && b !== branch);
    if (!branches.includes(base)) branches.unshift(base);
  } catch (e) {
    const list = el("ul", "pr-checks");
    list.append(problemItem("Can't start a pull request", e, createPullRequest));
    return page.replaceChildren(list);
  }

  const form = el("form", "pr-create-form");
  const heading = el("h1", "", "New pull request");
  const sub = el("div", "pr-sub");
  const baseSelect = el("select");
  baseSelect.ariaLabel = "Base branch";
  for (const b of branches) baseSelect.append(new Option(b, b, false, b === base));
  sub.append("Merge ", el("code", "pr-branch", branch), " into ", baseSelect);
  const title = el("input");
  title.placeholder = "Title";
  title.ariaLabel = "Title";
  title.required = true;
  const body = el("textarea");
  body.placeholder = "Description (Markdown)";
  body.ariaLabel = "Description";
  const draft = el("input");
  draft.type = "checkbox";
  const draftLabel = el("label", "pr-create-draft");
  draftLabel.append(draft, " Create as a draft");
  const create = el("button", "primary", "Create Pull Request");
  create.type = "submit";
  draft.onchange = () => (create.textContent = draft.checked ? "Create Draft" : "Create Pull Request");
  const buttons = el("div", "pr-actions");
  buttons.append(draftLabel, create);
  const commits = el("ul", "pr-rows");
  const commitsHeading = el("h3");
  // The repository's template, if it has one, is where a description starts, as on GitHub.
  const template = await Promise.any(
    [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md", "pull_request_template.md"].map((f) => invoke<string>("read_file", { path: `${host.root()}/${f}` })),
  ).catch(() => "");
  let touched = false;
  title.oninput = body.oninput = () => (touched = true);
  // What the branch adds to the base: its commits, which also suggest the title and description.
  const fill = async () => {
    const target = baseSelect.value;
    const log = await git("log", "--format=%h%x1f%s%x1f%an%x1f%at", `refs/remotes/origin/${target}..HEAD`, "--").catch(() => "");
    const list = log.split("\n").filter(Boolean).map((l) => l.split("\x1f"));
    commitsHeading.textContent = `${list.length} ${list.length === 1 ? "commit" : "commits"} into ${target}`;
    commits.replaceChildren(
      ...(list.length ? list : [["", "No commits between the branches yet."]]).map(([hash, subject, author, at]) => {
        const li = el("li");
        li.append(icon("git-commit", "muted"), el("span", "pr-row-main", subject), el("span", "muted", author ?? ""), el("span", "pr-when", at ? (age(Number(at)) === "now" ? "just now" : `${age(Number(at))} ago`) : ""), el("code", "hash", hash));
        return li;
      }),
    );
    if (touched) return;
    // One commit names the pull request; several fall back to the branch's name, as GitHub does.
    title.value = list.length === 1 ? list[0][1] : branch.replace(/^[\w-]+\//, "").replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
    body.value = template || (list.length > 1 ? list.map(([, subject]) => `- ${subject}`).reverse().join("\n") : "");
  };
  baseSelect.onchange = fill;
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!title.value.trim()) return title.focus();
    create.disabled = true;
    try {
      // gh can't push for you without asking, so the branch goes up first, through the dialog for passwords.
      const s = gitStatus();
      if (!s?.upstream || s.ahead > 0) {
        if ((await gitTask(`Pushing ${branch}…`, ["push", "-u", "origin", "HEAD"], `Can't push ${branch}`)) === undefined) return;
      }
      const url = await withProgress(
        "Creating the pull request…",
        () => gh("pr", "create", "--base", baseSelect.value, "--head", branch, "--title", title.value.trim(), "--body", body.value, ...(draft.checked ? ["--draft"] : [])),
        { error: "Can't create the pull request" },
      );
      if (url === undefined) return;
      const number = Number(url.trim().match(/\/pull\/(\d+)/)?.[1]);
      host.status(`Created #${number}`);
      closeView(page);
      updateBranchPullRequest();
      loadPullRequests();
      if (number) showPullRequest(number, title.value.trim());
    } finally {
      create.disabled = false;
    }
  };
  body.onkeydown = title.onkeydown = (e) => void (e.key === "Enter" && mod(e) && form.requestSubmit());
  form.append(heading, sub, title, body, buttons, commitsHeading, commits);
  page.replaceChildren(form);
  await fill();
  title.focus();
  title.select();
}
