// Stashes: a tab of the Commit tool window, as PhpStorm's Stash tab. It lists each stash with its branch and age,
// its changed files under it, and diffs of a file or the whole stash, with apply, pop, drop, and unstash as a branch.
import { type DiffFile, git, gitOutput, gitStatus, refreshGit, refreshListeners, showDiffs } from "./git";
import { h, icon, iconButton } from "./dom";
import { showMenu, type MenuItem } from "./files";
import { ago, type ChangedFile, isConflict, parseNameStatus, parseStashList, type Stash } from "./gitparse";
import { fileIcon } from "./icons";
import { listNav } from "./listnav";
import { confirm, pick } from "./palette";
import { errorText, showError, status, withProgress } from "./status";

type Host = { showView(name: "commit"): void; openMerge(rel: string): unknown };
let host: Host;
const $ = (id: string) => document.getElementById(id)!;

let stashes: Stash[] = [];
let loadError = "";
let loading = false;
/** Expanded stashes, by commit hash, which stays the same when an older stash is dropped and the refs shift. */
const expanded = new Set<string>();
/** Each stash's files, by commit hash. A stash never changes, so they're read once. */
const files = new Map<string, ChangedFile[] | Promise<ChangedFile[]> | Error>();

const stashTabShown = () => !$("git-stashes").hidden && !$("view-commit").hidden;

/** Shows the Stashes tab of the Commit tool window. */
export function showStashes() {
  host.showView("commit");
  showTab("stashes");
  $("stash-list").focus();
}

function showTab(tab: "commit" | "stashes") {
  $("git-commit-pane").hidden = tab !== "commit";
  $("git-stashes").hidden = tab !== "stashes";
  $("commit-tab").setAttribute("aria-selected", String(tab === "commit"));
  $("stash-tab").setAttribute("aria-selected", String(tab === "stashes"));
  if (tab === "stashes") loadStashes();
}

async function loadStashes() {
  if (!gitStatus()) {
    stashes = [];
    loadError = "";
    return render();
  }
  loading = !stashes.length;
  if (loading) render();
  try {
    stashes = parseStashList(await git("stash", "list", "--format=%gd%x1f%H%x1f%ct%x1f%gs"));
    loadError = "";
  } catch (e) {
    loadError = errorText(e);
  }
  loading = false;
  render();
}

function stashFiles(s: Stash) {
  const known = files.get(s.hash);
  if (known) return known;
  // --include-untracked needs git 2.32; older versions list the tracked files only.
  const read = git("stash", "show", "--include-untracked", "--name-status", "-z", s.hash)
    .catch(() => git("stash", "show", "--name-status", "-z", s.hash))
    .then(parseNameStatus)
    .then(
      (list) => (files.set(s.hash, list), render(), list),
      (e) => (files.set(s.hash, new Error(errorText(e))), render(), []),
    );
  files.set(s.hash, read);
  return read;
}

/** A stashed file's diff: the commit the stash was made on against the stash. New files live in its third parent. */
const show = (spec: string) => git("show", spec).catch(() => "");
const diffFile = (s: Stash, f: ChangedFile): DiffFile => ({
  path: f.path,
  status: f.status,
  load: async () => [
    f.status === "A" ? "" : await show(`${s.hash}^1:${f.from ?? f.path}`),
    f.status === "D" ? "" : (await show(`${s.hash}:${f.path}`)) || (await show(`${s.hash}^3:${f.path}`)),
  ],
});

async function showStashDiff(s: Stash, path?: string) {
  const list = await stashFiles(s);
  if (list instanceof Error) return showError(`Can't list the files of ${s.ref}`, list);
  if (!list.length) return status("This stash has no changed files to show.");
  showDiffs(list.map((f) => diffFile(s, f)), `${s.ref}: ${s.message}`, Math.max(0, list.findIndex((f) => f.path === path)));
}

function render() {
  const list = $("stash-list");
  if (loading) return list.replaceChildren(h("li", { class: "muted" }, "Loading stashes…"));
  if (!gitStatus()) return list.replaceChildren(h("li", { class: "muted" }, "This folder isn't a git repository."));
  if (loadError) return list.replaceChildren(h("li", { class: "muted" }, `Can't list the stashes: ${loadError}`));
  if (!stashes.length)
    return list.replaceChildren(h("li", { class: "muted" }, "No stashes. Stash changes to set them aside, switch tasks, and bring them back later."));
  list.replaceChildren(
    ...stashes.flatMap((s) => {
      const open = expanded.has(s.hash);
      const row = h(
        "li",
        { class: "stash-row", role: "treeitem", title: `${s.ref} · ${new Date(s.time * 1000).toLocaleString()}`, data: { key: s.hash, label: s.message } },
        h("span", { class: `codicon codicon-chevron-${open ? "down" : "right"} twisty` }),
        icon("archive"),
        h("span", { class: "name" }, s.message),
        h("span", { class: "dir" }, `${s.branch ? `${s.branch} · ` : ""}${ago(s.time)}`),
        h(
          "span",
          { class: "buttons" },
          iconButton("check", "Apply (keep the stash)", () => apply(s, false)),
          iconButton("arrow-down", "Pop (apply, then drop the stash)", () => apply(s, true)),
          iconButton("trash", "Drop… (Delete)", () => drop(s)),
        ),
      );
      row.setAttribute("aria-level", "1");
      row.setAttribute("aria-expanded", String(open));
      row.onclick = (e) => !(e.target as Element).closest(".buttons") && toggle(s);
      row.oncontextmenu = (e) => (e.preventDefault(), nav.select(s.hash), showMenu(e.clientX, e.clientY, stashMenu(s)));
      if (!open) return [row];
      const known = stashFiles(s);
      if (known instanceof Promise) return [row, h("li", { class: "muted stash-file" }, "Loading files…")];
      if (known instanceof Error) return [row, h("li", { class: "muted stash-file" }, `Can't list the files: ${known.message}`)];
      return [row, ...known.map((f) => fileRow(s, f))];
    }),
  );
}

function fileRow(s: Stash, f: ChangedFile) {
  const name = f.path.split("/").pop()!;
  const fi = fileIcon(name);
  const row = h(
    "li",
    { class: `stash-file status-${f.status}`, role: "treeitem", title: f.from ? `${f.from} → ${f.path}` : f.path, data: { key: `${s.hash}:${f.path}`, label: name } },
    h("span", { class: "letter" }, f.status),
    h("span", { class: `file-icon codicon codicon-${fi.codicon} ${fi.color}` }),
    h("span", { class: "name" }, name),
    h("span", { class: "dir" }, f.path.slice(0, -name.length - 1)),
  );
  row.setAttribute("aria-level", "2");
  row.onclick = () => showStashDiff(s, f.path);
  row.oncontextmenu = (e) => (e.preventDefault(), showMenu(e.clientX, e.clientY, [{ label: "Show Diff", run: () => showStashDiff(s, f.path) }, "-", ...stashMenu(s)]));
  return row;
}

function toggle(s: Stash, open = !expanded.has(s.hash)) {
  // A list that failed to load is read again next time.
  if (files.get(s.hash) instanceof Error) files.delete(s.hash);
  if (open) expanded.add(s.hash);
  else expanded.delete(s.hash);
  render();
}

function stashMenu(s: Stash): MenuItem[] {
  return [
    { label: "Show Diff", run: () => showStashDiff(s) },
    "-",
    { label: "Apply", run: () => apply(s, false) },
    { label: "Pop", run: () => apply(s, true) },
    { label: "Unstash as New Branch…", run: () => unstashAsBranch(s) },
    "-",
    { label: "Copy Hash", run: () => navigator.clipboard.writeText(s.hash).then(() => status(`Copied ${s.hash}`)) },
    { label: "Drop…", keys: "⌫", run: () => drop(s) },
  ];
}

// ---- Actions ----

/** Applies a stash, or pops it. Conflicts leave the stash in place and offer the merge tool. */
async function apply(s: Stash, pop: boolean) {
  const result = await withProgress(`${pop ? "Popping" : "Applying"} ${s.message}…`, () => gitOutput(["stash", pop ? "pop" : "apply", s.ref]));
  await refreshGit();
  loadStashes();
  if (!result) return;
  if (!result.code) return status(`${pop ? "Popped" : "Applied"} "${s.message}".`, "app", "info");
  const conflicted = gitStatus()?.files.find(isConflict);
  if (/CONFLICT/.test(result.output) && conflicted)
    return showError(`The stash applied with conflicts${pop ? " and was kept" : ""}. Resolve them, then commit or stage the files`, undefined, { label: "Resolve", run: () => host.openMerge(conflicted.path) });
  showError(`Can't ${pop ? "pop" : "apply"} ${s.ref}`, result.output);
}

async function drop(s: Stash) {
  if (!(await confirm(`Drop the stash "${s.message}"? Its changes are deleted, and you can't undo it.`, "Drop Stash"))) return;
  try {
    await git("stash", "drop", s.ref);
    status(`Dropped "${s.message}".`, "app", "info");
  } catch (e) {
    showError(`Can't drop ${s.ref}`, e);
  }
  await loadStashes();
}

/** Creates a branch at the commit the stash was made on, checks it out, and pops the stash there. */
function unstashAsBranch(s: Stash) {
  pick(`New branch for "${s.message}"`, (q) => {
    const name = q.trim().replace(/\s+/g, "-");
    if (!name) return [];
    return [
      {
        label: `Unstash on a new branch "${name}"`,
        detail: "git stash branch",
        run: async () => {
          const result = await withProgress(`Unstashing on ${name}…`, () => gitOutput(["stash", "branch", name, s.ref]));
          await refreshGit();
          loadStashes();
          if (result && result.code) showError(`Can't unstash on ${name}`, result.output);
          else if (result) status(`Checked out ${name} with "${s.message}".`, "app", "info");
        },
      },
    ];
  });
}

/** Asks for a message and options, then stashes the uncommitted changes, as PhpStorm's Stash Changes dialog. */
export function stashChanges() {
  const st = gitStatus();
  if (!st) return status("This folder isn't a git repository.", "app", "error");
  if (!st.files.length) return status("There are no changes to stash.", "app", "info");
  document.getElementById("stash-dialog")?.remove();
  const message = h("input", { placeholder: "Optional", spellcheck: false });
  const keepIndex = h("input", { type: "checkbox" });
  const untracked = h("input", { type: "checkbox", checked: st.files.some((f) => f.worktree === "?") });
  const dialog = h("dialog", { id: "stash-dialog", class: "refactor-dialog" });
  const submit = async () => {
    dialog.close();
    const args = ["stash", "push", ...(keepIndex.checked ? ["--keep-index"] : []), ...(untracked.checked ? ["--include-untracked"] : []), ...(message.value.trim() ? ["-m", message.value.trim()] : [])];
    const result = await withProgress("Stashing changes…", () => gitOutput(args));
    await refreshGit();
    if (!result) return;
    if (result.code) return showError("Can't stash the changes", result.output);
    status(/No local changes/.test(result.output) ? "There are no changes to stash." : "Stashed the changes.", "app", "info");
    loadStashes();
  };
  const changed = st.files.length;
  dialog.append(
    h(
      "form",
      { method: "dialog", onsubmit: (e: Event) => (e.preventDefault(), submit()) },
      h("h2", {}, "Stash Changes"),
      h("p", { class: "muted" }, `${changed} changed ${changed === 1 ? "file" : "files"} on ${st.branch}.`),
      h("div", { class: "dialog-fields" }, h("label", { class: "field grow" }, "Message", message)),
      h(
        "div",
        { class: "dialog-options" },
        h("label", { title: "Staged changes stay staged in the working tree too" }, keepIndex, "Keep staged changes"),
        h("label", { title: "Stash new files that git doesn't track yet" }, untracked, "Include untracked files"),
      ),
      h(
        "div",
        { class: "buttons" },
        h("button", { type: "button", onclick: () => dialog.close() }, "Cancel"),
        h("button", { type: "submit", class: "primary" }, "Stash"),
      ),
    ),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  message.focus();
}

let nav: ReturnType<typeof listNav>;

export function initStash(h: Host) {
  host = h;
  $("commit-tab").onclick = () => showTab("commit");
  $("stash-tab").onclick = () => showTab("stashes");
  $("stash-new").onclick = stashChanges;
  $("stash-refresh").onclick = loadStashes;
  const list = $("stash-list");
  const stashOf = (row: HTMLElement) => stashes.find((s) => row.dataset.key?.startsWith(s.hash));
  nav = listNav(list, {
    open: (row) => {
      const s = stashOf(row);
      if (!s) return;
      const path = row.dataset.key!.slice(s.hash.length + 1);
      showStashDiff(s, path || undefined);
    },
    toggle: (row, open) => {
      const s = stashOf(row);
      if (s) toggle(s, open);
    },
  });
  list.addEventListener("keydown", (e) => {
    const row = nav.selectedRow();
    const s = row && stashOf(row);
    if (!s || e.target !== list) return;
    if (e.key === "Delete" || e.key === "Backspace") drop(s);
    else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      const r = row.getBoundingClientRect();
      showMenu(r.left + 24, r.bottom, stashMenu(s));
    } else return;
    e.preventDefault();
  });
  // A stash made or dropped in a terminal shows up after git's next refresh.
  refreshListeners.push(() => stashTabShown() && loadStashes());
}
