// Git history: the log of the repository or of one file, with a branch graph, filters that search through git
// (message or hash, branch, author, path), commit details, and commit actions.
import { h, icon, iconButton } from "./dom";
import { change, type DiffFile, git, showDiffs } from "./git";
import { ago, type ChangedFile, type Commit, graphRows, type GraphRow, LOG_FORMAT, parseLog, parseNameStatus } from "./gitparse";
import { listNav } from "./listnav";
import { confirm, pick } from "./palette";
import { interactiveRebase } from "./rebase";
import { splitter } from "./splitter";
import { errorText, showError, status } from "./status";
import { showPanelView } from "./terminal";
import { mod } from "./platform.ts";

type Host = { root(): string; status(text: string): void };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const PAGE = 300;
let host: Host;
let commits: Commit[] = [];
let selected: Commit | undefined;
/** Set when showing one file's history; paths follow the file through renames. */
let file: string | undefined;
/** Set when showing a range of commits, such as a comparison of two branches, with its title. */
let range: { revs: string[]; title: string } | undefined;
/** The load in progress; a newer one makes older results stale. */
let generation = 0;
let state: "loading" | "ready" | "error" = "ready";
let loadError = "";
/** A commit to select once it's loaded, as when a blame annotation opens the log. */
let reveal: string | undefined;
let nav: ReturnType<typeof listNav>;
let filesNav: ReturnType<typeof listNav>;

const info = (text: string) => status(text, "app", "info");

// ---- Opening ----

/** Shows the log of the current branch, or of the branch chosen in its header, in the bottom panel. */
export function showLog() {
  file = undefined;
  range = undefined;
  return open();
}

/** Shows the commits of a revision range, such as `main..feature`, under a title. */
export function showCommits(revs: string[], title: string) {
  file = undefined;
  range = { revs, title };
  return open();
}

/** Shows the commits that changed one file, following it through renames. */
export function showFileHistory(path: string) {
  if (!path.startsWith(host.root() + "/")) return;
  file = path.slice(host.root().length + 1);
  range = undefined;
  return open();
}

/** Opens the log at a commit, such as one a blame annotation names. A commit beyond the loaded pages is searched for. */
export async function showInLog(hash: string) {
  file = undefined;
  range = undefined;
  reveal = hash;
  const filter = $<HTMLInputElement>("history-filter");
  filter.value = "";
  await open();
  if (reveal && !commits.some((c) => c.hash.startsWith(hash))) {
    filter.value = hash.slice(0, 10);
    await reload();
  }
}

async function open() {
  if (!host.root()) return;
  $("history-title").textContent = range?.title ?? (file ? `History of ${file}` : "Git Log");
  // A file's history and a range have their own revisions and path.
  for (const id of ["history-branch", "history-path"]) $(id).hidden = !!file || !!range;
  $("history").hidden = false;
  showPanelView(file ? `History of ${file.split("/").pop()}` : "Git Log", $("history"));
  fillBranches();
  await reload();
  $("history-list").focus();
}

/** Lists the branches in the header's branch filter, keeping the choice. */
async function fillBranches() {
  const select = $<HTMLSelectElement>("history-branch");
  const chosen = select.value || "HEAD";
  const refs = (await git("for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads", "refs/remotes").catch(() => ""))
    .split("\n")
    .filter((r) => r && !r.endsWith("/HEAD"));
  select.replaceChildren(new Option("Current branch", "HEAD"), new Option("All branches", "--all"), ...refs.map((r) => new Option(r, r)));
  select.value = [...select.options].some((o) => o.value === chosen) ? chosen : "HEAD";
}

// ---- Loading, through git's own search ----

/** The filters in the header, as git log arguments; empty when none is set. */
function filterArgs() {
  const text = $<HTMLInputElement>("history-filter").value.trim();
  const author = $<HTMLInputElement>("history-author").value.trim();
  return [...(text ? [`--grep=${text}`, "--regexp-ignore-case", "--fixed-strings"] : []), ...(author ? [`--author=${author}`, "--regexp-ignore-case"] : [])];
}
const pathFilter = () => (file || range ? "" : $<HTMLInputElement>("history-path").value.trim());
const filtered = () => !!(filterArgs().length || pathFilter());

async function reload() {
  commits = [];
  selected = undefined;
  $("history-detail").replaceChildren(h("p", { class: "muted" }, "Select a commit."));
  await load();
}

async function load() {
  const run = ++generation;
  state = "loading";
  if (!commits.length) render();
  $<HTMLButtonElement>("history-more").disabled = true;
  const branch = $<HTMLSelectElement>("history-branch").value || "HEAD";
  const revs = range?.revs ?? (file ? [] : [branch]);
  // The graph needs children before parents, which the default order breaks when commits share a timestamp.
  const order = !filtered() && !file ? ["--date-order"] : [];
  const args = ["log", LOG_FORMAT, ...order, `-n${PAGE}`, `--skip=${commits.length}`, ...filterArgs(), ...revs];
  const text = $<HTMLInputElement>("history-filter").value.trim();
  try {
    // --follow tracks renames but accepts only a single file, so a folder's history goes without it.
    const path = file ?? pathFilter();
    const out = await (file ? git(...args, "--follow", "--", file).catch(() => git(...args, "--", file!)) : path ? git(...args, "--", path) : git(...args));
    let page = parseLog(out);
    // A hash in the search box finds that commit too, whatever its message.
    if (!commits.length && /^[0-9a-f]{4,40}$/i.test(text)) {
      const exact = parseLog(await git("log", LOG_FORMAT, "-1", `${text}^{commit}`, "--").catch(() => ""));
      page = [...exact, ...page.filter((c) => c.hash !== exact[0]?.hash)];
    }
    if (run !== generation) return;
    commits.push(...page);
    $("history-more").hidden = page.length < PAGE;
    state = "ready";
  } catch (e) {
    if (run !== generation) return;
    state = "error";
    loadError = errorText(e);
  }
  $<HTMLButtonElement>("history-more").disabled = false;
  render();
  const target = reveal && commits.find((c) => c.hash.startsWith(reveal!));
  if (target) {
    reveal = undefined;
    nav.select(target.hash);
  }
}

// ---- The list ----

const LANE = 12;
const ROW = 40;

/** One row's slice of the branch graph, as an SVG. */
function graphCell(row: GraphRow, merge: boolean) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const width = row.width * LANE + 4;
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(ROW));
  svg.setAttribute("class", "graph");
  svg.setAttribute("aria-hidden", "true");
  const x = (lane: number) => lane * LANE + LANE / 2 + 2;
  const y = { top: 0, mid: ROW / 2, bottom: ROW };
  for (const l of row.lines) {
    const path = document.createElementNS(ns, "path");
    const [x1, y1, x2, y2] = [x(l.from), y[l.y1], x(l.to), y[l.y2]];
    // Lines that change lanes bend smoothly between the two.
    path.setAttribute("d", x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`);
    path.setAttribute("class", `lane-${l.lane % 6}`);
    svg.append(path);
  }
  const dot = document.createElementNS(ns, "circle");
  dot.setAttribute("cx", String(x(row.col)));
  dot.setAttribute("cy", String(y.mid));
  dot.setAttribute("r", merge ? "3" : "4");
  dot.setAttribute("class", `lane-${row.col % 6}${merge ? " merge" : ""}`);
  svg.append(dot);
  return svg;
}

function render() {
  const list = $("history-list");
  if (state === "error") return list.replaceChildren(h("li", { class: "muted" }, `Can't read the history: ${loadError}`, " ", h("button", { class: "link", onclick: reload }, "Try again")));
  if (state === "loading" && !commits.length) return list.replaceChildren(h("li", { class: "muted" }, "Loading commits…"));
  if (!commits.length)
    return list.replaceChildren(
      filtered()
        ? h("li", { class: "muted" }, "No commits match these filters. ", h("button", { class: "link", onclick: clearFilters }, "Clear filters"))
        : h("li", { class: "muted" }, range ? "No commits in this range." : "No commits yet."),
    );
  // The graph needs every commit in order; filters leave gaps, so it shows only without them.
  const graph = !filtered() && !file ? graphRows(commits) : undefined;
  list.replaceChildren(
    ...commits.map((c, i) => {
      const subject = h("div", { class: "subject" });
      for (const ref of c.refs) subject.append(h("span", { class: ref.startsWith("tag: ") ? "ref tag" : "ref" }, ref.replace(/^tag: /, "")));
      subject.append(c.subject);
      const li = h("li", { role: "option", data: { key: c.hash, label: c.subject }, title: c.hash }, graph ? graphCell(graph[i], c.parents.length > 1) : "", h("div", { class: "text" }, subject, h("div", { class: "meta" }, `${c.short} · ${c.author} · ${ago(c.time)}`)));
      li.onclick = () => select(c);
      return li;
    }),
  );
}

function clearFilters() {
  for (const id of ["history-filter", "history-author", "history-path"]) $<HTMLInputElement>(id).value = "";
  reload();
}

// ---- Commit details ----

async function select(c: Commit) {
  if (selected === c) return;
  selected = c;
  nav.select(c.hash, { scroll: false });
  const detail = $("history-detail");
  detail.replaceChildren(h("p", { class: "muted" }, "Loading the commit…"));
  let message: string, files: ChangedFile[];
  try {
    [message, files] = await Promise.all([git("show", "-s", "--format=%B", c.hash), changedFiles(c)]);
  } catch (e) {
    if (selected === c) detail.replaceChildren(h("p", { class: "muted" }, `Can't read ${c.short}: ${errorText(e)}`));
    return;
  }
  if (selected !== c) return;

  const actions = h("div", { class: "history-actions" });
  const action = (label: string, run: () => unknown) => actions.append(h("button", { onclick: run }, label));
  action("Show Diff", () => showCommitDiff(c.hash));
  action("Copy Hash", () => copyHash(c.hash));
  action("Check Out", () => confirmThen("Check Out", `Check out ${c.short}? You'll be on a detached HEAD, not a branch.`, "checkout", c.hash));
  action("New Branch Here…", () => newBranch(c));
  action("Cherry-Pick", () => confirmThen("Cherry-Pick", `Apply ${c.short} "${c.subject}" to the current branch?`, "cherry-pick", c.hash));
  action("Revert", () => confirmThen("Revert", `Create a commit that undoes ${c.short} "${c.subject}"?`, "revert", "--no-edit", c.hash));
  action("Interactive Rebase from Here…", () => interactiveRebase(c.hash));

  const list = h("ul", { class: "history-files", role: "listbox", ariaLabel: "Changed files" });
  // In a file's history, list that file first.
  const ordered = file ? [...files].sort((a, b) => Number(isTracked(b)) - Number(isTracked(a))) : files;
  for (const [i, f] of ordered.entries()) {
    const li = h("li", { class: `status-${f.status}${isTracked(f) ? " tracked" : ""}`, role: "option", title: f.from ? `${f.from} → ${f.path}` : f.path, data: { key: f.path, label: f.path.split("/").pop()! } }, h("span", { class: "letter" }, f.status), h("span", { class: "name" }, f.path));
    li.onclick = () => showDiffs(diffFiles(c, ordered), `${c.short} ${c.subject}`, i);
    list.append(li);
  }
  filesNav = listNav(list);

  detail.replaceChildren(
    h("h2", {}, c.subject),
    h("div", { class: "meta" }, `${c.hash}\n${c.author} · ${new Date(c.time * 1000).toLocaleString()}${c.parents.length > 1 ? " · merge" : ""}`),
    h("pre", { class: "message" }, message.trim()),
    actions,
    h("h3", {}, `Changed files (${files.length})`),
    files.length ? list : h("p", { class: "muted" }, "No changed files."),
  );
}

/** A commit's changed files: against its first parent, so a merge shows what it brought in; the first commit against nothing. */
const changedFiles = (c: { hash: string; parents: string[] }) =>
  git("diff-tree", "-r", "-M", "--name-status", "-z", ...(c.parents[0] ? [c.parents[0], c.hash] : ["--root", c.hash])).then(parseNameStatus);

const diffFiles = (c: { hash: string; parents: string[] }, files: ChangedFile[]): DiffFile[] => {
  const show = (spec: string) => git("show", spec).catch(() => "");
  return files.map((f) => ({
    path: f.path,
    status: f.status,
    load: async () => [c.parents[0] && f.status !== "A" ? await show(`${c.parents[0]}:${f.from ?? f.path}`) : "", f.status === "D" ? "" : await show(`${c.hash}:${f.path}`)],
  }));
};

/** Shows a commit's diff, file by file, starting at `path` when given. */
export async function showCommitDiff(hash: string, path?: string) {
  try {
    const [c] = parseLog(await git("log", LOG_FORMAT, "-1", hash, "--"));
    const files = await changedFiles(c);
    if (!files.length) return info(`${c.short} changed no files.`);
    showDiffs(diffFiles(c, files), `${c.short} ${c.subject}`, Math.max(0, files.findIndex((f) => f.path === path)));
  } catch (e) {
    showError(`Can't show the diff of ${hash.slice(0, 7)}`, e);
  }
}

export const copyHash = (hash: string) => navigator.clipboard.writeText(hash).then(() => info(`Copied ${hash}`));

/**
 * A popup with a commit's details, as PhpStorm shows for a blame annotation: message, author, date, and changed
 * files, with actions to open it in the log, show its diff, or copy its hash.
 */
export async function showCommitPopup(hash: string, x: number, y: number, path?: string) {
  document.getElementById("commit-popup")?.remove();
  const popup = h("div", { id: "commit-popup", class: "commit-popup", role: "dialog", ariaLabel: `Commit ${hash.slice(0, 7)}`, tabIndex: -1 }, h("p", { class: "muted" }, "Loading the commit…"));
  popup.style.left = `${Math.min(x, innerWidth - 440)}px`;
  popup.style.top = `${y}px`;
  document.body.append(popup);
  const close = () => (popup.remove(), removeEventListener("mousedown", outside, true), removeEventListener("keydown", escape, true));
  const outside = (e: MouseEvent) => !popup.contains(e.target as Node) && close();
  const escape = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), close());
  addEventListener("mousedown", outside, true);
  addEventListener("keydown", escape, true);
  try {
    const [c] = parseLog(await git("log", LOG_FORMAT, "-1", hash, "--"));
    const [message, files] = await Promise.all([git("show", "-s", "--format=%B", hash), changedFiles(c)]);
    const shown = files.slice(0, 12);
    popup.replaceChildren(
      h("div", { class: "commit-popup-head" }, h("code", {}, c.short), h("span", { class: "muted" }, `${c.author} · ${new Date(c.time * 1000).toLocaleString()} (${ago(c.time)})`), iconButton("close", "Close (Esc)", close)),
      h("pre", { class: "message" }, message.trim()),
      h(
        "ul",
        { class: "history-files" },
        ...shown.map((f) => {
          const li = h("li", { class: `status-${f.status}${f.path === path ? " tracked" : ""}`, title: f.path }, h("span", { class: "letter" }, f.status), h("span", { class: "name" }, f.path));
          li.onclick = () => (close(), showCommitDiff(hash, f.path));
          return li;
        }),
        files.length > shown.length ? h("li", { class: "muted" }, `and ${files.length - shown.length} more`) : null,
      ),
      h(
        "div",
        { class: "history-actions" },
        h("button", { onclick: () => (close(), showInLog(c.hash)) }, icon("history"), " Show in Git Log"),
        h("button", { onclick: () => (close(), showCommitDiff(c.hash, path)) }, icon("diff"), " Show Diff"),
        h("button", { onclick: () => (close(), copyHash(c.hash)) }, icon("copy"), " Copy Hash"),
      ),
    );
    // Kept on screen: above the click when there's no room below.
    const box = popup.getBoundingClientRect();
    if (box.bottom > innerHeight - 8) popup.style.top = `${Math.max(8, y - box.height - 24)}px`;
    popup.querySelector<HTMLElement>(".history-actions button")?.focus();
  } catch (e) {
    popup.replaceChildren(h("p", { class: "muted" }, `Can't read ${hash.slice(0, 7)}: ${errorText(e)}`));
  }
}

/** In a file's history, whether a changed file is that file, allowing for renames. */
function isTracked(f: ChangedFile) {
  return !!file && (f.path === file || f.from === file || f.path.split("/").pop() === file.split("/").pop());
}

async function confirmThen(action: string, question: string, ...args: string[]) {
  if (!(await confirm(question, action))) return;
  if (await change(...args)) await reload();
}

function newBranch(c: Commit) {
  pick(`New branch at ${c.short}`, (q) => {
    const name = q.trim().replace(/\s+/g, "-");
    return name ? [{ label: `Create and check out "${name}" at ${c.short}`, run: () => change("checkout", "-b", name, c.hash).then((ok) => void (ok && reload())) }] : [];
  });
}

export function initHistory(hst: Host) {
  host = hst;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = () => (clearTimeout(timer), (timer = setTimeout(reload, 300)));
  for (const id of ["history-filter", "history-author", "history-path"]) {
    $(id).oninput = later;
    $(id).onkeydown = (e) => {
      if (e.key === "Enter") (clearTimeout(timer), reload());
      else if (e.key === "ArrowDown") (e.preventDefault(), $("history-list").focus());
    };
  }
  $("history-branch").onchange = reload;
  $("history-more").onclick = load;
  const list = $("history-list");
  nav = listNav(list, {
    onSelect: (row) => {
      const c = commits.find((x) => x.hash === row.dataset.key);
      if (c) select(c);
    },
    // Enter opens the commit's diff; the details follow the selection already.
    open: (row) => showCommitDiff(row.dataset.key!),
  });
  list.addEventListener("keydown", (e) => {
    const hash = nav.selected();
    if (e.target !== list || !hash) return;
    if (e.key === "c" && mod(e)) (copyHash(hash), e.preventDefault());
    else if (e.key === "ArrowRight" && !mod(e)) (filesNav && $("history-detail").querySelector<HTMLElement>(".history-files")?.focus(), e.preventDefault());
  });
  splitter($("history-split"), { target: document.querySelector<HTMLElement>(".history-commits")!, axis: "x", edge: "end", label: "Resize the commit list", min: 200, minRest: 200, save: "gitlog.commits" });
}
