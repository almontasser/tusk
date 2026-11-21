// Pull requests: the New Pull Request form.
import { invoke } from "@tauri-apps/api/core";
import { type DiffFile, git, gitStatus, gitTask, showDiffs } from "./git";
import { age, parseNameStatus } from "./gitparse";
import { pick } from "./palette";
import { showError, withProgress } from "./status";
import { closeView, showEditorView } from "./terminal";
import { keyText, mod } from "./platform.ts";
import { el, gh, host, icon, labelChip, loadMarkdown, me, myLogin, openUrl } from "./prshared";
import { assignable, repoLabels } from "./practions";
import { writer } from "./prthreads";
import { loadPullRequests, problemItem } from "./prlist";
import { updateBranchPullRequest } from "./preditor";
import { showPullRequest } from "./prpage";
import { autosaveKey, createArgs, defaultTemplate, existingFrom, headSpec, headTarget, isRemoteUrl, parseNumstat, remoteFor, type Saved, TEMPLATE_PATHSPECS, templateChoices } from "./prcreatedata.ts";

// ---- Creating a pull request ----

let createPage: HTMLElement | undefined;

type Repo = { nameWithOwner: string; url: string; defaultBranchRef: { name: string } | null; owner: { login: string }; isInOrganization: boolean; parent: { name: string; owner: { login: string } } | null };
const viewRepo = (repo?: string) => gh("repo", "view", ...(repo ? [repo] : []), "--json", "nameWithOwner,url,defaultBranchRef,owner,isInOrganization,parent").then((o) => JSON.parse(o) as Repo);

/** Reads and writes the form's autosave, which storage being off turns into a no-op. */
const storage = {
  get(key: string): Saved | undefined {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "null") ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(key: string, value: Saved | undefined) {
    try {
      if (value) localStorage.setItem(key, JSON.stringify(value));
      else localStorage.removeItem(key);
    } catch {
      // Storage is off; the form lasts until its tab closes.
    }
  },
};

/**
 * Opens a form for a pull request from the current branch, in an editor tab: the base repository and branch, a
 * title from the commits or branch name, a body from the repository's template or the commits' subjects, the
 * reviewers, assignees, labels, and milestone, and the commits and files it would add. Creating pushes the branch
 * first when the remote doesn't have its commits. The form keeps what you type per branch until you create it.
 */
export async function createPullRequest() {
  const status = gitStatus();
  const branch = status?.branch;
  if (!branch || branch.startsWith("HEAD")) return showError("Switch to a branch first: a pull request needs one to merge from.");
  const page = (createPage ??= el("div", "pr-create"));
  page.replaceChildren(el("p", "muted pr-loading", "Loading…"));
  showEditorView("New Pull Request", page, "git-pull-request-create", () => {});
  page.hidden = false;
  const config = (key: string) => git("config", "--get", `branch.${branch}.${key}`).then((v) => v.trim(), () => "");
  const [configRemote, configMerge] = await Promise.all([config("remote"), config("merge")]);
  const { remote: headRemote, branch: headBranch } = headTarget(branch, status.upstream, { remote: configRemote, merge: configMerge });
  const key = autosaveKey(host.root(), branch);
  let remotes: string;
  let headRepo: Repo;
  let repos: string[];
  let currentRepo: string;
  const known = new Map<string, Repo>();
  try {
    let current: Repo;
    [remotes, current, headRepo] = await Promise.all([git("remote", "-v"), viewRepo(), (isRemoteUrl(headRemote) ? Promise.resolve(headRemote) : git("remote", "get-url", headRemote)).then((url) => viewRepo(url.trim()))]);
    currentRepo = current.nameWithOwner;
    for (const r of [current, headRepo]) known.set(r.nameWithOwner, r);
    // A fork's pull request goes to its parent by default, as on GitHub; you can still pick the fork itself.
    const parent = headRepo.parent && `${headRepo.parent.owner.login}/${headRepo.parent.name}`;
    repos = [...new Set([parent, current.nameWithOwner, headRepo.nameWithOwner].filter((r): r is string => !!r))];
  } catch (e) {
    const list = el("ul", "pr-checks");
    list.append(problemItem("Can't start a pull request", e, createPullRequest));
    return page.replaceChildren(list);
  }
  // The repository's templates, committed ones as GitHub uses, and the Preview tab's Markdown and the reviewer list's login.
  const [templates] = await Promise.all([
    git("ls-files", "-z", "--", ...TEMPLATE_PATHSPECS).then((o) => templateChoices(o.split("\0").filter(Boolean)), () => []),
    loadMarkdown().catch(() => {}),
    me(),
  ]);
  const templateTexts = new Map(await Promise.all(templates.map(async (t) => [t.path, await invoke<string>("read_file", { path: `${host.root()}/${t.path}` }).catch(() => "")] as const)));
  const saved = storage.get(key);

  const form = el("form", "pr-create-form");
  form.noValidate = true;
  const heading = el("h1", "", "New pull request");
  const sub = el("div", "pr-sub");
  const repoSelect = el("select");
  repoSelect.ariaLabel = "Base repository";
  for (const r of repos) repoSelect.append(new Option(r, r, false, r === (saved?.repo && repos.includes(saved.repo) ? saved.repo : repos[0])));
  const baseSelect = el("select");
  baseSelect.ariaLabel = "Base branch";
  sub.append("Merge ", el("code", "pr-branch", repos.length > 1 ? `${headRepo.owner.login}:${headBranch}` : branch), " into ");
  if (repos.length > 1) sub.append(repoSelect, " ");
  sub.append(baseSelect);
  const note = el("div", "pr-create-existing");
  note.hidden = true;
  const orgWarning = el("p", "pr-create-warning", `GitHub CLI can't yet open a pull request from a fork owned by an organization (${headRepo.owner.login}). Create it on GitHub instead.`);
  orgWarning.hidden = true;

  const title = el("input");
  title.placeholder = "Title";
  title.ariaLabel = "Title";
  const titleWarning = el("p", "pr-create-warning", "Add a title: GitHub needs one to create the pull request.");
  titleWarning.id = "pr-create-title-warning";
  titleWarning.hidden = true;
  title.setAttribute("aria-describedby", titleWarning.id);
  const warnTitle = (show: boolean) => {
    titleWarning.hidden = !show;
    title.ariaInvalid = String(show);
  };
  title.addEventListener("blur", () => warnTitle(!title.value.trim()));

  const templateSelect = el("select");
  templateSelect.ariaLabel = "Template";
  templateSelect.append(new Option("None", ""), ...templates.map((t) => new Option(t.name, t.path)));
  templateSelect.value = saved?.template ?? defaultTemplate(templates);
  const templateRow = el("label", "pr-create-template");
  templateRow.append("Template ", templateSelect);
  templateRow.hidden = templates.length < 2;

  const body = el("textarea");
  body.placeholder = "Description (Markdown)";
  body.ariaLabel = "Description";

  // People, labels, and a milestone, as chips. Their choices come from the base repository.
  const chosen = { reviewers: saved?.reviewers ?? [], assignees: saved?.assignees ?? [], labels: saved?.labels ?? [], milestone: saved?.milestone ? [saved.milestone] : [] };
  let data: { repo: string; people: Promise<string[]>; labels: Promise<{ name: string; description: string; color: string }[]>; milestones: Promise<string[]> } | undefined;
  const repoData = () => {
    const repo = repoSelect.value;
    if (data?.repo !== repo)
      data = {
        repo,
        people: assignable(repo).catch((e) => (showError("Can't list the people in the repository", e), [])),
        labels: repoLabels(repo).catch((e) => (showError("Can't list the labels", e), [])),
        milestones: gh("api", "--paginate", `repos/${repo}/milestones`, "--jq", ".[].title").then((o) => o.split("\n").filter(Boolean), (e) => (showError("Can't list the milestones", e), [])),
      };
    return data;
  };
  const labelColors = new Map<string, string>();
  type Choice = { label: string; value: string; detail?: string };
  const field = (name: string, noun: string, list: string[], choices: (q: string) => Promise<Choice[]>, chip: (v: string) => HTMLElement, single = false) => {
    const row = el("div", "pr-create-field");
    const chips = el("div", "pr-create-chips");
    const add = el("button", "pr-create-add");
    add.type = "button";
    const article = /^[aeiou]/.test(noun) ? "an" : "a";
    add.title = add.ariaLabel = single ? `Choose ${article} ${noun}` : `Add ${article} ${noun}`;
    add.append(icon("add"));
    const draw = () => {
      chips.replaceChildren(
        ...list.map((v) => {
          const box = el("span", "pr-create-chip");
          const remove = el("button", "pr-create-remove");
          remove.type = "button";
          remove.title = remove.ariaLabel = `Remove ${v}`;
          remove.append(icon("close"));
          remove.onclick = () => (list.splice(list.indexOf(v), 1), draw(), save(), add.focus());
          box.append(chip(v), remove);
          return box;
        }),
      );
      if (!list.length) chips.append(el("span", "muted", "None"));
    };
    add.onclick = () =>
      pick(add.title, async (q) =>
        (await choices(q))
          .filter((c) => !list.includes(c.value))
          .map((c) => ({ label: c.label, detail: c.detail, run: () => (single ? list.splice(0, list.length, c.value) : list.push(c.value), draw(), save()) })),
      );
    draw();
    row.append(el("span", "pr-create-field-name", name), chips, add);
    return row;
  };
  const match = (q: string) => (s: string) => s.toLowerCase().includes(q.trim().toLowerCase());
  const person = (v: string) => el("span", "", v);
  const fields = el("div", "pr-create-fields");
  fields.append(
    field("Reviewers", "reviewer", chosen.reviewers, async (q) => {
      // GitHub doesn't let you review your own pull request. Teams aren't listed, but you can type `org/team`.
      const people = (await repoData().people).filter((l) => l !== myLogin && match(q)(l)).map((l) => ({ label: l, value: l }));
      return /^[\w.-]+\/[\w.-]+$/.test(q.trim()) ? [{ label: q.trim(), value: q.trim(), detail: "team" }, ...people] : people;
    }, person),
    field("Assignees", "assignee", chosen.assignees, async (q) =>
      (await repoData().people)
        .filter(match(q))
        .sort((a, b) => Number(b === myLogin) - Number(a === myLogin))
        .map((l) => ({ label: l === myLogin ? `${l} (you)` : l, value: l })), person),
    field("Labels", "label", chosen.labels, async (q) => {
      const labels = await repoData().labels;
      for (const l of labels) labelColors.set(l.name, l.color);
      return labels.filter((l) => match(q)(l.name)).map((l) => ({ label: l.name, value: l.name, detail: l.description || undefined }));
    }, (v) => labelChip({ name: v, color: labelColors.get(v) ?? "8b949e" })),
    field("Milestone", "milestone", chosen.milestone, async (q) => (await repoData().milestones).filter(match(q)).map((m) => ({ label: m, value: m })), person, true),
  );

  const draft = el("input");
  draft.type = "checkbox";
  const draftLabel = el("label", "pr-create-draft");
  draftLabel.append(draft, " Create as a draft");
  const create = el("button", "primary", "Create Pull Request");
  create.type = "submit";
  create.title = `Create the pull request (${keyText("⌘⏎")})`;
  const label = () => (create.textContent = draft.checked ? "Create Draft" : "Create Pull Request");
  const buttons = el("div", "pr-actions");
  buttons.append(draftLabel, create);
  const commits = el("ul", "pr-rows");
  const commitsHeading = el("h3");
  const files = el("ul", "pr-rows pr-create-files");
  const filesHeading = el("h3");

  // What you change stays yours: the commits and template only fill a title or description you haven't edited.
  let titleEdited = saved?.titleEdited ?? false;
  let bodyEdited = saved?.bodyEdited ?? false;
  if (saved) {
    title.value = saved.title ?? "";
    body.value = saved.body ?? "";
    draft.checked = !!saved.draft;
    label();
  }
  let saving: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(saving);
    saving = setTimeout(
      () =>
        storage.set(key, {
          repo: repoSelect.value,
          base: baseSelect.value,
          title: title.value,
          body: body.value,
          draft: draft.checked,
          template: templateSelect.value,
          reviewers: chosen.reviewers,
          assignees: chosen.assignees,
          labels: chosen.labels,
          milestone: chosen.milestone[0] ?? "",
          titleEdited,
          bodyEdited,
        }),
      300,
    );
  };
  title.oninput = () => ((titleEdited = !!title.value.trim()), title.value.trim() && warnTitle(false), save());
  body.oninput = () => ((bodyEdited = !!body.value.trim()), save());
  draft.onchange = () => (label(), save());
  let subjects: string[] = [];
  const startBody = () => templateTexts.get(templateSelect.value) || (subjects.length > 1 ? subjects.map((s) => `- ${s}`).reverse().join("\n") : "");
  templateSelect.onchange = () => {
    if (!bodyEdited) body.value = startBody();
    save();
  };

  // The base repository's branches come from its local remote. Without one, the commits and files can't be listed.
  let remote: string | undefined;
  const loadRepo = async () => {
    const repo = repoSelect.value;
    remote = repo === headRepo.nameWithOwner ? headRemote : remoteFor(remotes, repo);
    orgWarning.hidden = repo === headRepo.nameWithOwner || !headRepo.isInOrganization;
    const info = known.get(repo) ?? (await viewRepo(repo).catch(() => undefined));
    if (info) known.set(repo, info);
    // ponytail: without a local remote, only GitHub's first 100 branches are listed; add --paginate if that's short.
    const branches = remote
      ? (await git("for-each-ref", "--format=%(refname:lstrip=3)", `refs/remotes/${remote}`).catch(() => "")).split("\n")
      : (await gh("api", `repos/${repo}/branches?per_page=100`, "--jq", ".[].name").catch(() => "")).split("\n");
    const names = branches.filter((b) => b && b !== "HEAD" && !(repo === headRepo.nameWithOwner && b === headBranch));
    const fallback = info?.defaultBranchRef?.name;
    if (fallback && !names.includes(fallback)) names.unshift(fallback);
    const want = saved?.repo === repo && saved.base && names.includes(saved.base) ? saved.base : fallback;
    baseSelect.replaceChildren(...names.map((b) => new Option(b, b, false, b === want)));
    // gh pr list --head takes no owner, so it lists every fork's same-named branch; only the head's owner counts.
    const open = await gh("pr", "list", "--repo", repo, "--head", headBranch, "--state", "open", "--limit", "100", "--json", "number,title,url,headRepositoryOwner")
      .then((o) => existingFrom(JSON.parse(o) as { number: number; title: string; url: string; headRepositoryOwner: { login: string } }[], headRepo.owner.login), () => undefined);
    note.hidden = !open;
    create.disabled = !!open;
    if (open) {
      const button = el("button", "primary", `Open #${open.number}`);
      button.type = "button";
      button.onclick = () => (repo === currentRepo ? showPullRequest(open.number, open.title) : openUrl(open.url));
      note.replaceChildren(el("p", "", `${branch} already has an open pull request in ${repo}: #${open.number} ${open.title}.`), button);
    }
    await fill();
  };

  // What the branch adds to the base, from where they meet: its commits, which also suggest the title and
  // description, and its files, each opening its diff.
  const fill = async () => {
    const target = baseSelect.value;
    const ref = remote && `refs/remotes/${remote}/${target}`;
    let list: string[][] = [];
    let changed: { path: string; from?: string; status: string; additions: number; deletions: number }[] = [];
    let mergeBase = "";
    if (ref) {
      const range = `${ref}...HEAD`;
      const [log, numstat, names, mb] = await Promise.all([
        git("log", "--format=%h%x1f%s%x1f%an%x1f%at", `${ref}..HEAD`, "--").catch(() => ""),
        git("diff", "--numstat", "-z", "-M", range, "--").catch(() => ""),
        git("diff", "--name-status", "-z", "-M", range, "--").catch(() => ""),
        git("merge-base", ref, "HEAD").catch(() => ""),
      ]);
      if (target !== baseSelect.value) return; // You picked another base while this one loaded.
      list = log.split("\n").filter(Boolean).map((l) => l.split("\x1f"));
      const counts = new Map(parseNumstat(numstat).map((f) => [f.path, f]));
      changed = parseNameStatus(names).map((f) => ({ ...f, additions: counts.get(f.path)?.additions ?? 0, deletions: counts.get(f.path)?.deletions ?? 0 }));
      mergeBase = mb.trim();
    }
    subjects = list.map(([, subject]) => subject);
    commitsHeading.textContent = ref ? `${list.length} ${list.length === 1 ? "commit" : "commits"} into ${target}` : "Commits";
    const empty = ref ? "No commits between the branches yet." : `Add a remote for ${repoSelect.value} and fetch it to see the commits and files this pull request adds.`;
    commits.replaceChildren(
      ...(list.length ? list : [["", empty]]).map(([hash, subject, author, at]) => {
        const li = el("li");
        li.append(icon("git-commit", "muted"), el("span", "pr-row-main", subject), el("span", "muted", author ?? ""), el("span", "pr-when", at ? (age(Number(at)) === "now" ? "just now" : `${age(Number(at))} ago`) : ""), el("code", "hash", hash));
        return li;
      }),
    );
    filesHeading.textContent = `${changed.length} ${changed.length === 1 ? "file" : "files"} changed`;
    filesHeading.hidden = !ref;
    const show = (spec: string) => git("show", spec).catch(() => "");
    const diffs: DiffFile[] = changed.map((f) => ({
      path: f.path,
      status: f.status,
      load: async () => [f.status === "A" ? "" : await show(`${mergeBase}:${f.from ?? f.path}`), f.status === "D" ? "" : await show(`HEAD:${f.path}`)],
    }));
    files.replaceChildren(
      ...changed.map((f, i) => {
        const li = el("li", `status-${f.status}`);
        const open = el("button", "pr-create-file");
        open.type = "button";
        open.title = `Show the diff of ${f.path}`;
        open.append(el("span", "letter", f.status), el("span", "pr-row-main", f.from ? `${f.from} → ${f.path}` : f.path), el("span", "added", `+${f.additions}`), el("span", "deleted", `−${f.deletions}`));
        open.onclick = () => showDiffs(diffs, `${target}...${branch}`, i);
        li.append(open);
        return li;
      }),
    );
    if (!titleEdited) title.value = list.length === 1 ? list[0][1] : branch.replace(/^[\w-]+\//, "").replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
    if (!bodyEdited) body.value = startBody();
  };
  repoSelect.onchange = () => (save(), loadRepo());
  baseSelect.onchange = () => (save(), fill());

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!title.value.trim()) return warnTitle(true), title.focus();
    if (create.disabled) return;
    create.disabled = true;
    const repo = repoSelect.value;
    try {
      // gh can't push for you without asking, so the branch goes up first, through the dialog for passwords.
      const s = gitStatus();
      // A URL remote has no remote-tracking branch to compare with, so ask the remote where the branch is.
      const pushed = isRemoteUrl(headRemote)
        ? (await git("ls-remote", headRemote, `refs/heads/${headBranch}`).catch(() => "")).split("\t")[0] === (await git("rev-parse", "HEAD")).trim()
        : s?.upstream === `${headRemote}/${headBranch}` && s.ahead === 0;
      if (!pushed) {
        if ((await gitTask(`Pushing ${branch}…`, ["push", "-u", headRemote, "HEAD"], `Can't push ${branch}`)) === undefined) return;
      }
      const args = createArgs({
        repo,
        base: baseSelect.value,
        head: headSpec(headBranch, headRepo.nameWithOwner, repo),
        title: title.value,
        body: body.value,
        draft: draft.checked,
        reviewers: chosen.reviewers,
        assignees: chosen.assignees,
        labels: chosen.labels,
        milestone: chosen.milestone[0] ?? "",
      });
      const url = await withProgress("Creating the pull request…", () => gh(...args), { error: "Can't create the pull request" });
      if (url === undefined) return;
      clearTimeout(saving);
      storage.set(key, undefined);
      const number = Number(url.trim().match(/\/pull\/(\d+)/)?.[1]);
      host.status(`Created #${number} in ${repo}`);
      closeView(page);
      updateBranchPullRequest();
      loadPullRequests();
      // The pull request tab shows the current repository's pull requests; one in another opens on GitHub.
      if (number && repo === currentRepo) showPullRequest(number, title.value.trim());
      else if (number) openUrl(url.trim());
    } finally {
      create.disabled = !note.hidden;
    }
  };
  form.onkeydown = (e) => void (e.key === "Enter" && mod(e) && (e.preventDefault(), form.requestSubmit()));
  form.append(heading, sub, note, orgWarning, title, titleWarning, templateRow, writer(body, `${new URL(headRepo.url).origin}/${repos[0]}`, 0), fields, buttons, commitsHeading, commits, filesHeading, files);
  page.replaceChildren(form);
  await loadRepo();
  title.focus();
  title.select();
}
