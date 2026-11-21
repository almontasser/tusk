// Pull requests: the Checks section, failed job logs, and links to project files in them.
import { invoke } from "@tauri-apps/api/core";
import { showOutput } from "./git";
import { actionsJob, type Check, checkDuration, checksSummary, checkState, cleanLog, sortChecks } from "./gitparse";
import { withProgress } from "./status";
import { checkIcon, type Details, el, gh, host, hub, icon, openUrl } from "./prshared";

/** Workflows whose checks you opened, by pull request and workflow name; a workflow that all passed is folded. */
const unfolded = new Set<string>();

/**
 * Draws the checks grouped by workflow, the groups with failures first, each check with how long it ran, a log
 * button on failed GitHub Actions jobs, and Re-run Failed in the bar. A workflow whose checks all passed or were
 * skipped folds into its heading until you open it.
 */
export function drawChecks(pr: Details, list: HTMLElement, bar: HTMLElement) {
  const sorted = sortChecks(pr.statusCheckRollup ?? []);
  const counts = { failed: 0, pending: 0, passed: 0, skipped: 0 };
  sorted.forEach((c) => counts[checkState(c)]++);
  bar.replaceChildren();
  for (const [state, label] of [["failed", "failed"], ["pending", "running"], ["passed", "passed"], ["skipped", "skipped"]] as const)
    if (counts[state]) {
      const part = el("span", "pr-check-count");
      part.append(checkIcon(state), ` ${counts[state]} ${label}`);
      bar.append(part);
    }
  if (!sorted.length) bar.append(el("span", "muted", "No checks"));
  const failedRuns = [...new Set(sorted.filter((c) => checkState(c) === "failed").map((c) => actionsJob(c.detailsUrl)?.run).filter((r): r is string => !!r))];
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
  const row = (c: Check) => {
    const state = checkState(c);
    const li = el("li", "pr-check");
    li.role = "option";
    const name = c.name ?? c.context ?? "";
    li.dataset.key = name;
    li.title = name;
    li.append(checkIcon(state), el("span", "pr-row-main", name));
    const took = checkDuration(c);
    if (took) li.append(el("span", "pr-when", state === "pending" ? `running ${took}` : took));
    const job = actionsJob(c.detailsUrl);
    if (job && state === "failed") {
      const log = el("button", "icon-button codicon codicon-output");
      log.title = "View Log: the failed steps, with file paths that open in the editor";
      log.onclick = (e) => (e.stopPropagation(), showLog(name, job.job));
      li.append(log);
    }
    const url = c.detailsUrl ?? c.targetUrl;
    if (url) {
      const out = el("button", "icon-button codicon codicon-link-external");
      out.title = "Open in Browser";
      out.onclick = (e) => (e.stopPropagation(), openUrl(url));
      li.append(out);
      li.onclick = () => (job && state === "failed" ? showLog(name, job.job) : openUrl(url));
    }
    return li;
  };
  // Checks by workflow; commit statuses, such as a CI service's, have none.
  const groups = new Map<string, Check[]>();
  for (const c of sorted) {
    const key = c.workflowName || (c.context ? "Commit statuses" : "Other checks");
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  if (groups.size < 2) return list.replaceChildren(...sorted.map(row));
  const rows: HTMLElement[] = [];
  // The order of `sorted` already puts the group with the first failure first.
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
    if (open) rows.push(...checks.map(row));
  }
  list.replaceChildren(...rows);
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

/**
 * Turns paths in a CI log into links to the project's files. CI checks out to another folder, such as
 * /home/runner/work/app/app, so each path is tried from each of its folders down until one is in the project.
 */
async function linkPaths(pre: HTMLElement, text: string) {
  const pattern = /((?:[\w.@-]*\/)+[\w.@-]+\.[A-Za-z]\w*)(?::(\d+))?/g;
  // ponytail: the first 100 distinct paths are looked up; a log with more links only those.
  const paths = [...new Set([...text.matchAll(pattern)].map((m) => m[1]))].slice(0, 100);
  const found = new Map<string, string>();
  await Promise.all(
    paths.map(async (path) => {
      const parts = path.split("/").filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const candidate = `${host.root()}/${parts.slice(i).join("/")}`;
        if (await invoke<boolean>("path_exists", { path: candidate }).catch(() => false)) return void found.set(path, candidate);
      }
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
