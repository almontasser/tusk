// Git history: the log of the repository or of one file, commit details, and commit actions.
import { change, git, showDiff } from "./git";
import { age, type ChangedFile, type Commit, LOG_FORMAT, parseLog, parseNameStatus } from "./gitparse";
import { confirm, pick } from "./palette";
import { interactiveRebase } from "./rebase";

type Host = { root(): string; status(text: string): void };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const PAGE = 300;
let host: Host;
let commits: Commit[] = [];
let selected: Commit | undefined;
/** Set when showing one file's history; paths follow the file through renames. */
let file: string | undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}

// ---- Opening and closing ----

/** Shows the log of the current branch, or of every branch, in place of the editor. */
export function showLog() {
  file = undefined;
  return open();
}

/** Shows the commits that changed one file, following it through renames. */
export function showFileHistory(path: string) {
  if (!path.startsWith(host.root() + "/")) return;
  file = path.slice(host.root().length + 1);
  return open();
}

async function open() {
  if (!host.root()) return;
  $("history-title").textContent = file ? `History of ${file}` : "Git Log";
  $("history-all").parentElement!.hidden = !!file;
  $("editor").hidden = true;
  $("diff").hidden = true;
  $("history").hidden = false;
  commits = [];
  selected = undefined;
  $("history-detail").replaceChildren(el("p", "muted", "Select a commit."));
  await load();
}

export function hideHistory() {
  if ($("history").hidden) return;
  $("history").hidden = true;
  $("editor").hidden = false;
}

const reopen = () => {
  $("editor").hidden = true;
  $("history").hidden = false;
};

// ---- Log ----

async function load() {
  const all = !file && ($<HTMLInputElement>("history-all")).checked;
  const args = ["log", LOG_FORMAT, `-n${PAGE}`, `--skip=${commits.length}`, ...(all ? ["--all"] : [])];
  try {
    // --follow tracks renames but accepts only a single file, so a folder's history goes without it.
    const out = await (file ? git(...args, "--follow", "--", file).catch(() => git(...args, "--", file!)) : git(...args));
    const page = parseLog(out);
    commits.push(...page);
    $("history-more").hidden = page.length < PAGE;
  } catch (e) {
    host.status(`Can't read the history: ${String(e).trim()}`);
  }
  render();
}

function render() {
  const filter = $<HTMLInputElement>("history-filter").value.toLowerCase();
  const shown = filter
    ? commits.filter((c) => [c.subject, c.author, c.hash, ...c.refs].some((s) => s.toLowerCase().includes(filter)))
    : commits;
  $("history-list").replaceChildren(
    ...shown.map((c) => {
      const li = el("li", c === selected ? "selected" : "");
      const subject = el("div", "subject");
      for (const ref of c.refs) subject.append(el("span", ref.startsWith("tag: ") ? "ref tag" : "ref", ref.replace(/^tag: /, "")));
      subject.append(c.subject);
      li.append(subject, el("div", "meta", `${c.short} · ${c.author} · ${age(c.time)} ago`));
      li.onclick = () => select(c);
      return li;
    }),
  );
}

// ---- Commit details ----

async function select(c: Commit) {
  selected = c;
  render();
  const detail = $("history-detail");
  detail.replaceChildren(el("p", "muted", "Loading…"));
  const [message, files] = await Promise.all([
    git("show", "-s", "--format=%B", c.hash).catch(() => c.subject),
    // A merge commit is compared with its first parent; the first commit with nothing.
    git("diff-tree", "-r", "-M", "--name-status", "-z", ...(c.parents[0] ? [c.parents[0], c.hash] : ["--root", c.hash])).then(parseNameStatus, () => []),
  ]);
  if (selected !== c) return;

  const actions = el("div", "history-actions");
  const action = (label: string, run: () => unknown) => {
    const b = el("button", "", label);
    b.onclick = run;
    actions.append(b);
  };
  action("Copy Hash", () => navigator.clipboard.writeText(c.hash).then(() => host.status(`Copied ${c.hash}`)));
  action("Check Out", () => confirmThen("Check Out", `Check out ${c.short}? You'll be on a detached HEAD, not a branch.`, "checkout", c.hash));
  action("New Branch Here…", () => newBranch(c));
  action("Cherry-Pick", () => confirmThen("Cherry-Pick", `Apply ${c.short} "${c.subject}" to the current branch?`, "cherry-pick", c.hash));
  action("Revert", () => confirmThen("Revert", `Create a commit that undoes ${c.short} "${c.subject}"?`, "revert", "--no-edit", c.hash));
  action("Interactive Rebase from Here…", () => interactiveRebase(c.hash));

  const list = el("ul", "history-files");
  // In a file's history, list that file first.
  const ordered = file ? [...files].sort((a, b) => Number(isTracked(b)) - Number(isTracked(a))) : files;
  for (const f of ordered) {
    const li = el("li", `status-${f.status}${isTracked(f) ? " tracked" : ""}`);
    li.append(el("span", "letter", f.status), el("span", "name", f.path));
    if (f.from) li.title = `${f.from} → ${f.path}`;
    li.onclick = () => diff(c, f);
    list.append(li);
  }

  detail.replaceChildren(
    el("h2", "", c.subject),
    el("div", "meta", `${c.hash}\n${c.author} · ${new Date(c.time * 1000).toLocaleString()}${c.parents.length > 1 ? " · merge" : ""}`),
    el("pre", "message", message.trim()),
    actions,
    el("h3", "", `Changed files (${files.length})`),
    list,
  );
}

/** In a file's history, whether a changed file is that file, allowing for renames. */
function isTracked(f: ChangedFile) {
  return !!file && (f.path === file || f.from === file || f.path.split("/").pop() === file.split("/").pop());
}

async function diff(c: Commit, f: ChangedFile) {
  const show = (spec: string) => git("show", spec).catch(() => "");
  const before = c.parents[0] && f.status !== "A" ? await show(`${c.parents[0]}:${f.from ?? f.path}`) : "";
  const after = f.status === "D" ? "" : await show(`${c.hash}:${f.path}`);
  showDiff(f.path, before, after, `${c.short} ${c.subject}`, reopen);
}

async function confirmThen(action: string, question: string, ...args: string[]) {
  if (!(await confirm(question, action))) return;
  await change(...args);
  commits = [];
  await load();
}

function newBranch(c: Commit) {
  pick(`New branch at ${c.short}`, (q) => {
    const name = q.trim().replace(/\s+/g, "-");
    return name ? [{ label: `Create and check out "${name}" at ${c.short}`, run: () => change("checkout", "-b", name, c.hash).then(() => showLog()) }] : [];
  });
}

export function initHistory(h: Host) {
  host = h;
  $("history-close").onclick = hideHistory;
  $("history-filter").oninput = render;
  $("history-all").onchange = () => ((commits = []), load());
  $("history-more").onclick = load;
}
