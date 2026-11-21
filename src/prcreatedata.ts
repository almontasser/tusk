// The New Pull Request form's data, with no DOM or Tauri, so the tests can run it (prcreatedata.test.ts).

/**
 * Where GitHub looks for pull request templates, as `git ls-files` pathspecs: one file in `.github`, `docs`, or the
 * root, or several in a `PULL_REQUEST_TEMPLATE` folder in one of those. GitHub ignores the case of these names.
 */
export const TEMPLATE_PATHSPECS = ["", "docs/", ".github/"].flatMap((dir) => [`:(icase)${dir}pull_request_template.md`, `:(icase,glob)${dir}pull_request_template/*.md`]);

export type Template = { path: string; name: string };

/**
 * The templates from `git ls-files`, each named for the template picker: the single-file template first, as
 * "Default", then the folder's templates by file name.
 */
export function templateChoices(paths: string[]): Template[] {
  const single = (p: string) => !/(^|\/)pull_request_template\//i.test(p);
  return paths
    .filter((p) => /\.md$/i.test(p))
    .sort((a, b) => Number(single(b)) - Number(single(a)) || a.localeCompare(b))
    .map((path) => ({ path, name: single(path) ? "Default" : path.split("/").pop()!.replace(/\.md$/i, "") }));
}

/**
 * The template the description starts from: the single-file one, or the only template. With several in a folder
 * and no single file, GitHub starts empty until you pick one, so the form does too ("").
 */
export function defaultTemplate(templates: Template[]): string {
  return templates.length === 1 || templates[0]?.name === "Default" ? templates[0].path : "";
}

/** `owner/repo` from a GitHub remote URL (https or ssh, with or without `.git`), or "" for other hosts' forms. */
export function repoFromUrl(url: string): string {
  return url.trim().match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)?.[1] ?? "";
}

/** The local remote that points at `repo` (`owner/repo`), from `git remote -v`, or undefined. */
export function remoteFor(remotes: string, repo: string): string | undefined {
  for (const line of remotes.split("\n")) {
    const [name, url] = line.split(/\s+/);
    if (url && repoFromUrl(url).toLowerCase() === repo.toLowerCase()) return name;
  }
}

/**
 * The remote that holds the branch for the pull request: its upstream's, when the upstream is a branch of the same
 * name. A branch started from `origin/main` or `upstream/main` tracks a branch it doesn't push to, so it goes to
 * origin under its own name, as the push before creating does.
 */
export function headTarget(branch: string, upstream?: string): { remote: string; branch: string } {
  const slash = upstream?.indexOf("/") ?? -1;
  return upstream && slash > 0 && upstream.slice(slash + 1) === branch ? { remote: upstream.slice(0, slash), branch } : { remote: "origin", branch };
}

/**
 * The `--head` of a pull request: the branch alone in its own repository, or `owner:branch` from a fork, which
 * `gh pr create` needs to find the branch in another repository.
 */
export const headSpec = (branch: string, headRepo: string, baseRepo: string) => (headRepo.toLowerCase() === baseRepo.toLowerCase() ? branch : `${headRepo.split("/")[0]}:${branch}`);

export type NewPullRequest = {
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
  reviewers: string[];
  assignees: string[];
  labels: string[];
  milestone: string;
};

/** The arguments of `gh pr create` for the form. Each person and label gets its own flag, so commas in names stay whole. */
export function createArgs(pr: NewPullRequest): string[] {
  const each = (flag: string, values: string[]) => values.flatMap((v) => [flag, v]);
  return [
    "pr",
    "create",
    "--repo",
    pr.repo,
    "--base",
    pr.base,
    "--head",
    pr.head,
    "--title",
    pr.title.trim(),
    "--body",
    pr.body,
    ...(pr.draft ? ["--draft"] : []),
    ...each("--reviewer", pr.reviewers),
    ...each("--assignee", pr.assignees),
    ...each("--label", pr.labels),
    ...(pr.milestone ? ["--milestone", pr.milestone] : []),
  ];
}

/**
 * The open pull request from `owner`'s branch among `gh pr list --head <branch>`'s, which lists same-named
 * branches from every fork, since `--head` doesn't take `owner:branch`.
 */
export function existingFrom<T extends { headRepositoryOwner: { login: string } }>(list: T[], owner: string): T | undefined {
  return list.find((pr) => pr.headRepositoryOwner.login.toLowerCase() === owner.toLowerCase());
}

/** What the form keeps while you type, per project and branch. */
export type Saved = Partial<Omit<NewPullRequest, "head">> & { template?: string; titleEdited?: boolean; bodyEdited?: boolean };
export const autosaveKey = (root: string, branch: string) => `pr-create:${root}:${branch}`;

export type FileChange = { path: string; from?: string; additions: number; deletions: number };

/** Parses `git diff --numstat -z -M`: added and deleted line counts (`-` for binary files), then a path, or two for renames. */
export function parseNumstat(out: string): FileChange[] {
  const fields = out.split("\0");
  const files: FileChange[] = [];
  for (let i = 0; i < fields.length; i++) {
    const m = fields[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (!m) continue;
    const [additions, deletions] = [m[1], m[2]].map((n) => (n === "-" ? 0 : Number(n)));
    // A rename leaves the path empty and puts the old and new paths in the next two fields.
    if (m[3] === "") files.push({ from: fields[++i], path: fields[++i], additions, deletions });
    else files.push({ path: m[3], additions, deletions });
  }
  return files;
}
