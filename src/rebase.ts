// Interactive rebase: choose what happens to each commit after a base (pick, reword, edit, squash, fixup,
// drop) and their order, then run git's own rebase -i with that todo list. It runs in a terminal tab,
// so a conflict or an edit stops it there and the Commit view's banner offers Continue and Abort.
import { invoke } from "@tauri-apps/api/core";
import { appCacheDir } from "@tauri-apps/api/path";
import { git, refreshGit } from "./git";
import { parseRebaseTodo, type RebaseAction, type RebaseStep, rebaseTodo } from "./gitparse";
import { listNav } from "./listnav";
import { pick, rank } from "./palette";
import { showError, status, withProgress } from "./status";
import { openTerminal } from "./terminal";
import { keyText } from "./platform.ts";

type Host = { root(): string; status(text: string): void };
let host: Host;

const ACTIONS: [RebaseAction, string][] = [
  ["pick", "Pick"],
  ["reword", "Reword"],
  ["edit", "Edit (stop to change it)"],
  ["squash", "Squash into previous"],
  ["fixup", "Fixup (discard message)"],
  ["drop", "Drop"],
];

/** Commits after `base` on the current branch, oldest first, with their full messages. */
async function commitsAfter(base: string): Promise<RebaseStep[]> {
  const out = await git("log", "--reverse", "--format=%H%x1f%s%x1f%B%x1e", `${base}..HEAD`);
  return out
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, subject, message] = r.split("\x1f");
      return { hash, subject, action: "pick" as RebaseAction, message: message.trim() };
    });
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * git's own `rebase -i --rebase-merges` todo list for the commits after `base`. git makes it in a
 * throwaway worktree, where the sequence editor copies the list out and empties it, so that rebase
 * ends with "nothing to do" and this worktree's files, index, and HEAD are never touched.
 */
async function mergesTodo(base: string): Promise<string> {
  const dir = `${await appCacheDir()}/rebase`;
  await invoke("create_dir", { path: dir });
  const out = `${dir}/merges-todo.txt`;
  const tree = `${dir}/preview-${Date.now()}`;
  await invoke("write_file", { path: out, contents: "" });
  // ponytail: checks out the whole tree once, which takes seconds only in very large repositories.
  await git("-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", tree, "HEAD");
  try {
    const editor = `f() { cp "$1" ${q(out)} && : > "$1"; }; f`;
    await git("-C", tree, "-c", "core.hooksPath=/dev/null", "-c", `sequence.editor=${editor}`, "rebase", "-i", "--rebase-merges", base).catch(() => "");
  } finally {
    await git("worktree", "remove", "--force", tree).catch(() => "");
  }
  return invoke<string>("read_file", { path: out });
}

/** Opens the editor for the commits after `base`. */
export async function interactiveRebase(base: string) {
  let steps: RebaseStep[];
  let merges = false;
  try {
    steps = await commitsAfter(base);
    merges = !!(await git("log", "--merges", "--format=%h", `${base}..HEAD`)).trim();
    if (merges) {
      // git's list rebuilds the merges; the commits from the log give each pick its full message.
      const commits = steps;
      const todo = await withProgress("Preparing the rebase list (checking out a temporary worktree)…", () => mergesTodo(base), { error: "Can't prepare the rebase list" });
      if (todo === undefined) return;
      steps = parseRebaseTodo(todo).map((s) => (s.line ? s : { ...s, message: commits.find((c) => c.hash.startsWith(s.hash))?.message }));
    }
  } catch (e) {
    return showError("Can't list the commits to rebase", e);
  }
  if (!steps.some((s) => !s.line)) return status("There are no commits after that one on this branch.", "app", "info");
  // A squash or fixup joins the commit before it, so it can't follow the start, a reset, or a label.
  const canSquash = (i: number) => i > 0 && (!steps[i - 1].line || steps[i - 1].line!.startsWith("merge"));

  document.getElementById("rebase")?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "rebase";
  dialog.innerHTML = keyText(`<form method="dialog"><h2>Interactive rebase</h2><p class="muted">Oldest first. Commits are replayed on ${base.slice(0, 7)} in this order.${merges ? " Merges are rebuilt too: Label names a point, Reset goes back to one, and Merge merges it again." : ""}</p><ol class="rebase-steps" tabindex="0" aria-label="Rebase steps"></ol><div class="buttons"><span class="dialog-hint">Drag to reorder, or ⌥↑ ⌥↓ · P R E S F D set the action</span><button type="button" data-cancel>Cancel</button><button type="button" class="primary" data-start>Start Rebase</button></div></form>`);
  const list = dialog.querySelector("ol")!;

  /** A key per step that follows it when it moves. */
  const ids = new WeakMap<RebaseStep, string>();
  steps.forEach((st, i) => ids.set(st, String(i)));
  const keyOf = (st: RebaseStep) => ids.get(st)!;
  const movable = (i: number) => i >= 0 && i < steps.length && !steps[i].line;

  /** Moves a step to another index, if both are commits (a merge's label, reset, and merge lines stay put). */
  const move = (from: number, to: number) => {
    if (!movable(from) || !movable(to) || from === to) return;
    const [st] = steps.splice(from, 1);
    steps.splice(to, 0, st);
    render();
    nav.select(keyOf(st));
  };
  const setAction = (st: RebaseStep, action: RebaseAction) => {
    const i = steps.indexOf(st);
    if (st.line) return;
    if ((action === "squash" || action === "fixup") && !canSquash(i)) return status("A squash or fixup needs a commit right before it to join.", "app", "error");
    st.action = action;
    render();
  };

  let dragged: RebaseStep | undefined;
  const render = () =>
    list.replaceChildren(
      ...steps.map((s, i) => {
        const li = document.createElement("li");
        li.dataset.key = keyOf(s);
        li.dataset.label = s.subject;
        li.setAttribute("role", "option");
        if (s.line) {
          // A command that rebuilds a merge, shown as it is and kept in place.
          li.className = "rebase-step command";
          const [command] = s.line.split(" ");
          const [target, comment] = s.subject.split(" # ");
          const name = document.createElement("span");
          name.className = "command-name";
          name.textContent = command[0].toUpperCase() + command.slice(1);
          const hash = document.createElement("code");
          hash.textContent = s.hash.slice(0, 7);
          const text = document.createElement("span");
          text.className = "subject";
          text.textContent = comment ? `${target} · ${comment}` : target;
          li.append(name, hash, text);
          return li;
        }
        li.className = `rebase-step action-${s.action}`;
        li.draggable = true;
        li.ondragstart = (e) => ((dragged = s), e.dataTransfer?.setData("text/plain", s.hash), li.classList.add("dragging"));
        li.ondragend = () => ((dragged = undefined), render());
        li.ondragover = (e) => {
          if (!dragged || dragged === s) return;
          e.preventDefault();
          const r = li.getBoundingClientRect();
          li.classList.toggle("drop-before", e.clientY < r.top + r.height / 2);
          li.classList.toggle("drop-after", e.clientY >= r.top + r.height / 2);
        };
        li.ondragleave = () => li.classList.remove("drop-before", "drop-after");
        li.ondrop = (e) => {
          e.preventDefault();
          if (!dragged) return;
          const from = steps.indexOf(dragged);
          let to = steps.indexOf(s) + (li.classList.contains("drop-after") ? 1 : 0);
          if (from < to) to--;
          move(from, to);
        };
        const select = document.createElement("select");
        select.setAttribute("aria-label", `Action for ${s.subject}`);
        for (const [value, label] of ACTIONS) select.append(new Option(label, value, false, s.action === value));
        for (const o of select.options) if (!canSquash(i) && (o.value === "squash" || o.value === "fixup")) o.disabled = true;
        select.onchange = () => setAction(s, select.value as RebaseAction);
        const grip = document.createElement("span");
        grip.className = "codicon codicon-gripper grip";
        grip.title = "Drag to reorder";
        const hash = document.createElement("code");
        hash.textContent = s.hash.slice(0, 7);
        const text = document.createElement(s.action === "reword" ? "textarea" : "span");
        text.className = "subject";
        if (text instanceof HTMLTextAreaElement) {
          text.value = s.message ?? s.subject;
          text.rows = Math.min(6, text.value.split("\n").length + 1);
          text.oninput = () => (s.message = text.value);
        } else text.textContent = s.subject;
        const arrow = (by: number, label: string, icon: string) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = `icon-button codicon codicon-${icon}`;
          b.title = keyText(label);
          b.setAttribute("aria-label", b.title);
          b.disabled = !movable(i + by);
          b.onclick = () => move(i, i + by);
          return b;
        };
        li.append(grip, select, hash, text, arrow(-1, "Move up (⌥↑)", "arrow-up"), arrow(1, "Move down (⌥↓)", "arrow-down"));
        return li;
      }),
    );
  const nav = listNav(list, { open: () => {} });
  // ⌥↑ and ⌥↓ move the selected step; a letter sets its action, as in git's todo list. These run before listNav's
  // type-ahead.
  const letters: Record<string, RebaseAction> = { p: "pick", r: "reword", e: "edit", s: "squash", f: "fixup", d: "drop" };
  list.addEventListener(
    "keydown",
    (e) => {
      if (e.target !== list) return;
      const st = steps.find((x) => keyOf(x) === nav.selected());
      if (!st) return;
      const i = steps.indexOf(st);
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) move(i, i + (e.key === "ArrowUp" ? -1 : 1));
      else if (!e.metaKey && !e.ctrlKey && !e.altKey && letters[e.key.toLowerCase()]) setAction(st, letters[e.key.toLowerCase()]);
      else return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  render();
  dialog.querySelector<HTMLElement>("[data-cancel]")!.onclick = () => dialog.close();
  dialog.querySelector<HTMLElement>("[data-start]")!.onclick = async () => {
    if (steps.some((s, i) => !s.line && ["squash", "fixup"].includes(s.action) && !canSquash(i)))
      return host.status("A squash or fixup needs a commit right before it to join.");
    dialog.close();
    await start(base, steps, merges);
  };
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
}

async function start(base: string, steps: RebaseStep[], merges: boolean) {
  const dir = `${await appCacheDir()}/rebase`;
  const file = (i: number) => `${dir}/message-${i}.txt`;
  const todo = `${dir}/todo.txt`;
  try {
    await invoke("create_dir", { path: dir });
    for (const [i, s] of steps.entries()) if (s.action === "reword") await invoke("write_file", { path: file(i), contents: (s.message ?? s.subject).trim() + "\n" });
    await invoke("write_file", { path: todo, contents: rebaseTodo(steps, file) });
  } catch (e) {
    return showError("Can't start the rebase: the todo list couldn't be written", e);
  }
  // git runs the sequence editor with the todo file's path, so cp puts ours in its place.
  // GIT_EDITOR=true keeps squash's combined message without opening an editor.
  const line = `GIT_SEQUENCE_EDITOR=${q(`cp ${q(todo)}`)} GIT_EDITOR=true git rebase -i --autostash${merges ? " --rebase-merges" : ""} ${q(base)}`;
  openTerminal(host.root(), "Interactive rebase", ["/bin/sh", "-c", line], () => refreshGit()).catch((e) => showError("Can't start the rebase", e));
}

/** Asks for the base commit from the branch's recent history, then opens the editor. */
export function chooseRebaseBase() {
  // A failure shows as a row in the picker, rather than an empty list.
  const commits = git("log", "-50", "--format=%H%x1f%h%x1f%s%x1f%cr").then((out) => out.split("\n").filter(Boolean).map((l) => l.split("\x1f")));
  pick("Rebase the commits after…", async (q) => {
    const list = (await commits).slice(1);
    if (!list.length) return [{ label: "There are no earlier commits to rebase onto.", icon: "codicon-info", run: () => {} }];
    return rank(q, list.map(([hash, short, subject, when]) => ({ label: `${short} ${subject}`, detail: when, run: () => interactiveRebase(hash) })));
  });
}

export function initRebase(h: Host) {
  host = h;
}
