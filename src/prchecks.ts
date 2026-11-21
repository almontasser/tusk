// Pull requests: the Checks section, job logs and steps, run controls, check annotations in the editor and the diff,
// deployments, and artifacts.
import { invoke } from "@tauri-apps/api/core";
import { monaco } from "./editor";
import { gitStatus, showOutput } from "./git";
import { actionsJob, type Check, checkDuration, checkKey, checksSummary, checkState, cleanLog, deploymentState, type JobStep, jobSteps, pathTails, sortChecks } from "./gitparse";
import { confirm, choose } from "./palette";
import { open } from "./platform.ts";
import { showError, withProgress } from "./status";
import { checkIcon, type Details, el, gh, host, hub, icon, openUrl, type PullRequest } from "./prshared";
import { shown as shownDiff } from "./prdiff";

/** Workflows whose checks you opened, by pull request and workflow name; a workflow that all passed is folded. */
const unfolded = new Set<string>();

// ---- What the rollup doesn't have: required checks, annotations, deployments ----

type Annotation = { path: string; annotationLevel: "FAILURE" | "WARNING" | "NOTICE"; message: string; title: string | null; location: { start: { line: number; column: number | null }; end: { line: number; column: number | null } } };
type Extra = { isRequired: boolean; annotations: Annotation[]; more: number };
type Deployment = { environment: string; createdAt: string; latestStatus: { state: string; environmentUrl: string | null; logUrl: string | null } | null };
type CiDetails = { checks: Map<string, Extra>; deployments: Deployment[] };

// ponytail: the first 100 checks and each one's first 50 annotations; the rest show as a count. Paginating
// `contexts` (as prdiff.ts's VIEWED does) lifts the first cap, when a pull request runs more than 100 checks.
const CI = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { commits(last: 1) { nodes { commit {
    statusCheckRollup { contexts(first: 100) { nodes {
      ... on CheckRun { name detailsUrl isRequired(pullRequestNumber: $number) annotations(first: 50) { totalCount nodes { path annotationLevel message title location { start { line column } end { line column } } } } }
      ... on StatusContext { context isRequired(pullRequestNumber: $number) }
    } } }
    deployments(first: 20, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { environment createdAt latestStatus { state environmentUrl logUrl } } }
  } } } } }
}`;

type Node = { name?: string; detailsUrl?: string; context?: string; isRequired?: boolean; annotations?: { totalCount: number; nodes: Annotation[] } };

/**
 * The lookup for each pull request, by number, with what it was for: the check states, so a check that finishes
 * (and may have new annotations) looks again, while the 15-second poll's redraws reuse it.
 */
const lookups = new Map<number, { sig: string; data?: CiDetails; promise: Promise<CiDetails> }>();
const signature = (checks: Check[] | null) => JSON.stringify((checks ?? []).map((c) => [checkKey(c), checkState(c)]));

function details(number: number, checks: Check[] | null): { data?: CiDetails; promise: Promise<CiDetails> } {
  const sig = signature(checks);
  const known = lookups.get(number);
  if (known?.sig === sig) return known;
  const entry: { sig: string; data?: CiDetails; promise: Promise<CiDetails> } = {
    sig,
    promise: gh("api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-F", `number=${number}`, "-f", `query=${CI}`).then((out) => {
      const commit = JSON.parse(out).data.repository.pullRequest.commits.nodes[0]?.commit;
      const nodes: Node[] = commit?.statusCheckRollup?.contexts.nodes ?? [];
      const data: CiDetails = {
        checks: new Map(nodes.filter((n) => n.name || n.context).map((n) => [checkKey(n), { isRequired: !!n.isRequired, annotations: n.annotations?.nodes ?? [], more: (n.annotations?.totalCount ?? 0) - (n.annotations?.nodes.length ?? 0) }])),
        // The latest deployment to each environment; older ones are replaced.
        deployments: (commit?.deployments.nodes ?? []).filter((d: Deployment, i: number, all: Deployment[]) => all.findIndex((o) => o.environment === d.environment) === i),
      };
      entry.data = data;
      return data;
    }),
  };
  // A failed lookup leaves the checks as they are, without the extras, and tries again next time.
  entry.promise.catch(() => lookups.get(number) === entry && lookups.delete(number));
  lookups.set(number, entry);
  return entry;
}

/** Annotations about a workflow as a whole, such as "Process completed with exit code 1", are on `.github`. */
const onFile = (a: Annotation) => a.path !== ".github";

/** Project files found for CI paths, per project; a lookup that found nothing is cached as "". */
const resolved = new Map<string, Promise<string>>();
/** The project file a CI path points at, trying each of its tails (see pathTails), or "" when none is in the project. */
function resolvePath(path: string): Promise<string> {
  const root = host.root();
  const key = `${root}\n${path}`;
  if (!resolved.has(key))
    resolved.set(
      key,
      (async () => {
        for (const tail of pathTails(path)) if (await invoke<boolean>("path_exists", { path: `${root}/${tail}` }).catch(() => false)) return `${root}/${tail}`;
        return "";
      })(),
    );
  return resolved.get(key)!;
}

// ---- Annotations as markers ----

const OWNER = "ci";
const severities = { FAILURE: monaco.MarkerSeverity.Error, WARNING: monaco.MarkerSeverity.Warning, NOTICE: monaco.MarkerSeverity.Info };
type Placed = Annotation & { check: string };

function markers(model: monaco.editor.ITextModel, list: Placed[]): monaco.editor.IMarkerData[] {
  const lines = model.getLineCount();
  // Lines past the end are from a version of the file that differs from yours.
  return list
    .filter((a) => a.location.start.line >= 1 && a.location.start.line <= lines)
    .map((a) => {
      const { start, end } = a.location;
      const endLine = Math.min(Math.max(end.line, start.line), lines);
      // Most tools give lines without columns, so the marker covers the whole lines.
      return {
        severity: severities[a.annotationLevel] ?? monaco.MarkerSeverity.Info,
        message: a.title && !a.message.includes(a.title) ? `${a.title}\n${a.message}` : a.message,
        source: a.check,
        startLineNumber: start.line,
        startColumn: start.column ?? 1,
        endLineNumber: endLine,
        endColumn: end.column && start.column ? end.column + 1 : model.getLineMaxColumn(endLine),
      };
    });
}

const placed = (data: CiDetails, checks: Check[] | null) =>
  (checks ?? []).flatMap((c) => (data.checks.get(checkKey(c))?.annotations ?? []).filter(onFile).map((a): Placed => ({ ...a, check: c.name ?? c.context ?? "CI" })));

/** The checked-out branch's annotations, by project file; empty when the branch has no pull request. */
let branchFiles = new Map<string, Placed[]>();
const markFile = (model: monaco.editor.ITextModel) => model.uri.scheme === "file" && !model.isDisposed() && monaco.editor.setModelMarkers(model, OWNER, markers(model, branchFiles.get(model.uri.fsPath) ?? []));

/**
 * Shows the annotations of the checked-out branch's pull request, such as PHPStan's or Pint's from CI, as problems
 * in its files. Called with the branch's pull request whenever the branch changes, and with none to clear them.
 * The lines are the pull request's head; edits you haven't pushed can put them a few lines off.
 */
export async function branchAnnotations(pr?: PullRequest) {
  const root = host.root();
  let files = new Map<string, Placed[]>();
  if (pr) {
    const data = await details(pr.number, pr.statusCheckRollup).promise.catch(() => undefined);
    if (!data || host.root() !== root || gitStatus()?.branch !== pr.headRefName) return;
    for (const a of placed(data, pr.statusCheckRollup)) {
      const file = await resolvePath(a.path);
      if (file) files.set(file, [...(files.get(file) ?? []), a]);
    }
  }
  branchFiles = files;
  monaco.editor.getModels().forEach(markFile);
}

monaco.editor.onDidCreateModel((model) => {
  markFile(model);
  // The pull request's diff sets `shown` right after it makes the new side's model, so this looks after that.
  if (model.uri.scheme === "git" && model.uri.path.startsWith("/modified/")) queueMicrotask(() => markDiff(model));
});

/** Marks a pull request diff's new side with the annotations on its file. */
async function markDiff(model: monaco.editor.ITextModel) {
  const diff = shownDiff;
  if (diff?.model !== model) return;
  const data = await details(diff.pr.number, diff.pr.statusCheckRollup).promise.catch(() => undefined);
  if (!data || model.isDisposed()) return;
  const list = placed(data, diff.pr.statusCheckRollup).filter((a) => pathTails(a.path).includes(diff.path));
  monaco.editor.setModelMarkers(model, OWNER, markers(model, list));
}

// ---- The Checks section ----

/**
 * Draws the checks grouped by workflow, the groups with failures first, each check with how long it ran, whether
 * merging requires it, its annotations, and buttons for its log and to re-run it. The bar has the counts and the
 * run controls. A workflow whose checks all passed or were skipped folds into its heading until you open it.
 * Deployments of the head follow the checks.
 */
export function drawChecks(pr: Details, list: HTMLElement, bar: HTMLElement) {
  const lookup = details(pr.number, pr.statusCheckRollup);
  // The first draw has no extras yet; the lookup draws again when they arrive.
  if (!lookup.data) lookup.promise.then(() => list.isConnected && lookups.get(pr.number) === lookup && drawChecks(pr, list, bar), () => {});
  const extra = (c: Check) => lookup.data?.checks.get(checkKey(c));
  const sorted = sortChecks((pr.statusCheckRollup ?? []).map((c) => ({ ...c, isRequired: extra(c)?.isRequired })));
  const counts = { failed: 0, pending: 0, passed: 0, skipped: 0 };
  sorted.forEach((c) => counts[checkState(c)]++);
  const requiredFailed = sorted.filter((c) => c.isRequired && checkState(c) === "failed").length;
  bar.replaceChildren();
  for (const [state, label] of [["failed", "failed"], ["pending", "running"], ["passed", "passed"], ["skipped", "skipped"]] as const)
    if (counts[state]) {
      const part = el("span", "pr-check-count");
      part.append(checkIcon(state), ` ${counts[state]} ${label}${state === "failed" && lookup.data ? ` (${requiredFailed} required)` : ""}`);
      bar.append(part);
    }
  if (!sorted.length) bar.append(el("span", "muted", "No checks"));
  runControls(pr, sorted, bar);

  const row = (c: Check) => {
    const state = checkState(c);
    const li = el("li", "pr-check");
    li.role = "option";
    const name = c.name ?? c.context ?? "";
    li.dataset.key = checkKey(c);
    li.dataset.label = name;
    // A failing check that isn't required doesn't block merging, so it reads quieter than one that does.
    if (lookup.data && !c.isRequired && state === "failed") li.classList.add("optional");
    li.title = lookup.data ? `${name} (${c.isRequired ? "required for merging" : "not required for merging"})` : name;
    li.append(checkIcon(state), el("span", "pr-row-main", name));
    if (c.isRequired) li.append(el("span", "pr-check-required", "Required"));
    const took = checkDuration(c);
    if (took) li.append(el("span", "pr-when", state === "pending" ? `running ${took}` : took));
    const job = actionsJob(c.detailsUrl);
    if (job && state === "failed") li.append(button("output", "View Log: the failed steps, with file paths that open in the editor", () => showLog(name, job.job)));
    if (job && state === "pending") li.append(button("list-ordered", "View Steps: the job's steps as they run", () => showSteps(name, job.job)));
    if (job && state !== "pending") li.append(button("debug-rerun", "Re-run Job, and the jobs it needs", () => rerunJob(pr, name, job.job)));
    const url = c.detailsUrl ?? c.targetUrl;
    if (url) li.append(button("link-external", "Open in Browser", () => openUrl(url)));
    li.onclick = () => (job && state === "failed" ? showLog(name, job.job) : job && state === "pending" ? showSteps(name, job.job) : url && openUrl(url));
    const found = extra(c);
    return [li, ...(found ? annotationRows(c, found) : [])];
  };
  // Checks by workflow; commit statuses, such as a CI service's, have none.
  const groups = new Map<string, Check[]>();
  for (const c of sorted) {
    const key = c.workflowName || (c.context ? "Commit statuses" : "Other checks");
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const rows: HTMLElement[] = [];
  if (groups.size < 2) rows.push(...sorted.flatMap(row));
  // The order of `sorted` already puts the group with the first failure first.
  else
    for (const [name, checks] of groups) {
      const state = checksSummary(checks);
      const key = `${pr.number}:${name}`;
      const open = state === "failed" || state === "pending" || unfolded.has(key);
      const head = el("li", "pr-check-group");
      head.role = "option";
      head.dataset.key = name;
      const n = (s: string) => checks.filter((c) => checkState(c) === s).length;
      const parts = [n("failed") && `${n("failed")} failed`, n("pending") && `${n("pending")} running`, n("passed") && `${n("passed")} passed`, n("skipped") && `${n("skipped")} skipped`].filter(Boolean);
      head.append(icon(open ? "chevron-down" : "chevron-right", "muted"), checkIcon(state), el("span", "pr-row-main", name), el("span", "muted", parts.join(", ")));
      head.onclick = () => (unfolded.has(key) ? unfolded.delete(key) : unfolded.add(key), drawChecks(pr, list, bar));
      // A workflow with failures stays open; its heading folds nothing.
      if (state === "failed" || state === "pending") head.onclick = null;
      rows.push(head);
      if (open) rows.push(...checks.flatMap(row));
    }
  rows.push(...deploymentRows(lookup.data?.deployments ?? []));
  list.replaceChildren(...rows);
}

function button(name: string, title: string, run: () => unknown) {
  const b = el("button", `icon-button codicon codicon-${name}`);
  b.title = title;
  b.onclick = (e) => (e.stopPropagation(), run());
  return b;
}

/** A check's annotations, each a row that opens its file at its line; ones about the workflow as a whole don't link. */
function annotationRows(c: Check, found: Extra): HTMLElement[] {
  const levels = { FAILURE: ["error", "checks-failed"], WARNING: ["warning", "checks-pending"], NOTICE: ["info", "muted"] };
  const rows = found.annotations.map((a, i) => {
    const li = el("li", "pr-annotation");
    li.role = "option";
    li.dataset.key = `${checkKey(c)}#${i}`;
    const [name, color] = levels[a.annotationLevel] ?? levels.NOTICE;
    const where = onFile(a) ? `${a.path}:${a.location.start.line}` : "";
    const text = a.title && !a.message.includes(a.title) ? `${a.title}: ${a.message}` : a.message;
    li.append(icon(name, color), ...(where ? [el("span", "pr-annotation-path", where)] : []), el("span", "pr-row-main", text.split("\n")[0]));
    li.title = where ? `${where}\n${text}` : text;
    if (where)
      li.onclick = async () => {
        const file = await resolvePath(a.path);
        if (file) host.openAt(file, a.location.start.line);
        else host.status(`${a.path} isn't in the project.`);
      };
    return li;
  });
  if (found.more > 0) {
    const li = el("li", "pr-annotation muted", `${found.more} more ${found.more === 1 ? "annotation" : "annotations"} on GitHub`);
    li.role = "option";
    li.dataset.key = `${checkKey(c)}#more`;
    const url = c.detailsUrl;
    if (url) li.onclick = () => openUrl(url);
    rows.push(li);
  }
  return rows;
}

/** The head's deployments, one row for each environment's latest, which opens the deployed site. */
function deploymentRows(deployments: Deployment[]): HTMLElement[] {
  if (!deployments.length) return [];
  const head = el("li", "pr-check-group");
  head.role = "option";
  head.dataset.key = "deployments";
  head.append(icon("rocket", "muted"), el("span", "pr-row-main", "Deployments"));
  return [
    head,
    ...deployments.map((d) => {
      const li = el("li", "pr-check pr-deployment");
      li.role = "option";
      li.dataset.key = `deployment:${d.environment}`;
      const status = d.latestStatus;
      const state = (status?.state ?? "PENDING").toLowerCase().replace("_", " ");
      li.append(checkIcon(deploymentState(status?.state)), el("span", "pr-row-main", d.environment), el("span", "pr-when", state));
      const url = status?.environmentUrl || status?.logUrl;
      li.title = url ? `${d.environment}: ${url}` : d.environment;
      if (url) li.append(button("link-external", `Open ${url}`, () => openUrl(url)));
      li.onclick = () => url && openUrl(url);
      return li;
    }),
  ];
}

// ---- Run controls ----

/** The GitHub Actions runs among the checks, by run ID, with their workflow's name and whether a job still runs. */
function actionRuns(checks: Check[]) {
  const runs = new Map<string, { workflow: string; running: boolean; failed: boolean }>();
  for (const c of checks) {
    const run = actionsJob(c.detailsUrl)?.run;
    if (!run) continue;
    const r = runs.get(run) ?? { workflow: c.workflowName || `Run ${run}`, running: false, failed: false };
    r.running ||= checkState(c) === "pending";
    r.failed ||= checkState(c) === "failed";
    runs.set(run, r);
  }
  return runs;
}

/** Workflow runs waiting for a maintainer's approval, by pull request; they have no checks until they run. */
const awaiting = new Map<string, Promise<{ databaseId: number; workflowName: string }[]>>();

function runControls(pr: Details, checks: Check[], bar: HTMLElement) {
  const runs = actionRuns(checks);
  const failedRuns = [...runs].filter(([, r]) => r.failed).map(([id]) => id);
  if (failedRuns.length) {
    const rerun = el("button", "", "Re-run Failed");
    rerun.title = "Run the failed GitHub Actions jobs again";
    rerun.onclick = async () => {
      rerun.disabled = true;
      for (const id of failedRuns) if ((await withProgress(`Re-running the failed jobs…`, () => gh("run", "rerun", id, "--failed"), { error: "Can't re-run the failed jobs" })) === undefined) return;
      host.status(`Re-running the failed jobs of #${pr.number}.`);
      hub.renderPullRequest(pr.number);
    };
    bar.append(rerun);
  }
  const running = [...runs].filter(([, r]) => r.running);
  if (running.length) {
    const cancel = el("button", "", running.length > 1 ? "Cancel Run…" : "Cancel Run");
    cancel.title = "Cancel a running GitHub Actions workflow run";
    cancel.onclick = async () => {
      const name = running.length > 1 ? await choose("Cancel which run?", running.map(([, r]) => r.workflow)) : running[0][1].workflow;
      const run = running.find(([, r]) => r.workflow === name)?.[0];
      if (!run || !(await confirm(`Cancel the ${name} run of #${pr.number}?`, "Cancel Run"))) return;
      if ((await withProgress(`Canceling ${name}…`, () => gh("run", "cancel", run), { error: `Can't cancel ${name}` })) === undefined) return;
      host.status(`Canceled the ${name} run of #${pr.number}.`);
      hub.renderPullRequest(pr.number);
    };
    bar.append(cancel);
  }
  if (runs.size) {
    const artifacts = el("button", "", "Artifacts…");
    artifacts.title = "Download a file that a workflow run uploaded, such as a build or a test report";
    artifacts.onclick = () => downloadArtifact(pr, runs);
    bar.append(artifacts);
  }
  // A first-time contributor's workflow runs wait for approval; GitHub marks them action_required.
  const key = `${pr.number}:${pr.headRefOid}`;
  if (!awaiting.has(key)) awaiting.set(key, gh("run", "list", "--commit", pr.headRefOid, "--status", "action_required", "--json", "databaseId,workflowName").then(JSON.parse).catch(() => (awaiting.delete(key), [])));
  awaiting.get(key)!.then((waiting) => {
    if (!waiting.length || !bar.isConnected || bar.querySelector(".pr-approve")) return;
    const approve = el("button", "pr-approve", `Approve ${waiting.length} ${waiting.length === 1 ? "Run" : "Runs"}`);
    approve.title = `Approve and start the workflow runs waiting for a maintainer: ${waiting.map((w) => w.workflowName).join(", ")}`;
    approve.onclick = async () => {
      const names = waiting.map((w) => w.workflowName).join(", ");
      if (!(await confirm(`Run ${names} on #${pr.number}? Review the changes to workflows and scripts first; the runs can use the repository's secrets.`, "Approve and Run"))) return;
      for (const w of waiting)
        if ((await withProgress(`Approving ${w.workflowName}…`, () => gh("api", "--method", "POST", `repos/{owner}/{repo}/actions/runs/${w.databaseId}/approve`), { error: `Can't approve ${w.workflowName}` })) === undefined) return;
      awaiting.delete(key);
      host.status(`Approved ${names} on #${pr.number}.`);
      hub.renderPullRequest(pr.number);
    };
    bar.append(approve);
  });
}

/** Re-runs one job. Its ID is the number in its details URL, which matches the job's `databaseId` that gh wants. */
async function rerunJob(pr: Details, name: string, job: string) {
  if (!(await confirm(`Re-run ${name}, and the jobs it needs?`, "Re-run Job"))) return;
  if ((await withProgress(`Re-running ${name}…`, () => gh("run", "rerun", "--job", job), { error: `Can't re-run ${name}` })) === undefined) return;
  host.status(`Re-running ${name}.`);
  hub.renderPullRequest(pr.number);
}

type Artifact = { name: string; size_in_bytes: number; expired: boolean };

/** Lists the runs' artifacts, downloads the one you pick into a folder you choose, and reveals it. */
async function downloadArtifact(pr: Details, runs: ReturnType<typeof actionRuns>) {
  const found = await withProgress(
    "Listing the artifacts…",
    () => Promise.all([...runs].map(async ([id, r]) => (JSON.parse(await gh("api", `repos/{owner}/{repo}/actions/runs/${id}/artifacts?per_page=100`)).artifacts as Artifact[]).filter((a) => !a.expired).map((a) => ({ ...a, run: id, workflow: r.workflow })))),
    { error: "Can't list the artifacts" },
  );
  if (!found) return;
  const all = found.flat();
  if (!all.length) return host.status(`The workflow runs of #${pr.number} have no artifacts, or they expired.`);
  const size = (n: number) => (n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  const labels = all.map((a) => `${a.name} (${a.workflow}, ${size(a.size_in_bytes)})`);
  const label = await choose("Download which artifact?", labels);
  const artifact = all[labels.indexOf(label ?? "")];
  if (!artifact) return;
  const folder = await open({ directory: true, multiple: false, title: `Download ${artifact.name} into`, defaultPath: host.root() }).catch((e) => (showError("Can't open the folder chooser", e), null));
  if (!folder || Array.isArray(folder)) return;
  // gh extracts a single artifact straight into the folder, so it gets a folder of its own there.
  const dir = `${folder}/${artifact.name}`;
  if ((await withProgress(`Downloading ${artifact.name}…`, () => gh("run", "download", artifact.run, "-n", artifact.name, "-D", dir), { error: `Can't download ${artifact.name}` })) === undefined) return;
  host.status(`Downloaded ${artifact.name} to ${dir}.`);
  invoke("reveal_path", { path: dir });
}

// ---- Logs ----

/**
 * Shows a running job's steps and keeps them current until the job ends or you close the dialog. GitHub has no
 * log for a job until it ends, so the steps are what there is; a job that fails then shows its failed steps' log.
 */
async function showSteps(name: string, job: string) {
  const load = async () => JSON.parse(await gh("api", `repos/{owner}/{repo}/actions/jobs/${job}`)) as { status: string; conclusion: string | null; steps?: JobStep[] };
  let state = await withProgress(`Loading the steps of ${name}…`, load, { error: `Can't load the steps of ${name}` });
  if (!state) return;
  const text = (s: NonNullable<typeof state>) => `${jobSteps(s.steps ?? []) || "The job hasn't started yet."}${s.status === "completed" ? `\n\nThe job finished: ${s.conclusion ?? "done"}.` : ""}`;
  showOutput(`${name}: steps`, text(state));
  const pre = document.querySelector<HTMLElement>("#output-dialog .output-text");
  while (pre?.isConnected && state.status !== "completed") {
    await new Promise((r) => setTimeout(r, 5000));
    if (!pre.isConnected) return;
    state = (await load().catch(() => undefined)) ?? state;
    pre.textContent = text(state);
  }
  if (pre?.isConnected && state.conclusion === "failure") showLog(name, job);
}

/** Shows a failed job's log, with paths of project files in it as links that open them at their line. */
async function showLog(name: string, job: string) {
  const out = await withProgress(`Loading the log of ${name}…`, () => gh("run", "view", "--job", job, "--log-failed"), { error: `Can't load the log of ${name}` });
  if (out === undefined) return;
  const text = cleanLog(out) || "The log has no failed steps. A canceled job, or one that timed out, has none.";
  showOutput(`${name}: failed steps`, text);
  const pre = document.querySelector<HTMLElement>("#output-dialog .output-text");
  if (!pre) return;
  // Opens at the first error: PHPUnit's and Pest's summary, or a step's error annotation, or else the end.
  const scroll = () => {
    const at = text.search(/^.*(?:There (?:was|were) \d+ (?:failure|error)|FAILED|##\[error\]|Error: )/m);
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    let offset = 0;
    while (at >= 0 && walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (offset + node.length > at) {
        const range = document.createRange();
        range.setStart(node, at - offset);
        return (pre.scrollTop += range.getBoundingClientRect().top - pre.getBoundingClientRect().top - 8);
      }
      offset += node.length;
    }
    pre.scrollTop = pre.scrollHeight;
  };
  scroll();
  linkPaths(pre, text).then(scroll);
}

/** Turns paths in a CI log into links to the project's files, found as resolvePath finds them. */
async function linkPaths(pre: HTMLElement, text: string) {
  const pattern = /((?:[\w.@-]*\/)+[\w.@-]+\.[A-Za-z]\w*)(?::(\d+))?/g;
  // ponytail: the first 100 distinct paths are looked up; a log with more links only those.
  const paths = [...new Set([...text.matchAll(pattern)].map((m) => m[1]))].slice(0, 100);
  const found = new Map<string, string>();
  await Promise.all(
    paths.map(async (path) => {
      const file = await resolvePath(path);
      if (file) found.set(path, file);
    }),
  );
  if (!found.size || !pre.isConnected) return;
  const nodes: (string | HTMLElement)[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const file = found.get(m[1]);
    if (!file) continue;
    nodes.push(text.slice(last, m.index));
    const a = el("a", "log-link", m[0]);
    a.href = "#";
    a.onclick = (e) => (e.preventDefault(), (pre.closest("dialog") as HTMLDialogElement | null)?.close(), host.openAt(file, Number(m[2] ?? 1)));
    nodes.push(a);
    last = m.index + m[0].length;
  }
  nodes.push(text.slice(last));
  pre.replaceChildren(...nodes);
}
