// Interactive rebase: choose what happens to each commit after a base (pick, reword, edit, squash, fixup,
// drop) and their order, then run git's own rebase -i with that todo list. It runs in a terminal tab,
// so a conflict or an edit stops it there and the Commit view's banner offers Continue and Abort.
import { invoke } from "@tauri-apps/api/core";
import { appCacheDir } from "@tauri-apps/api/path";
import { git, refreshGit } from "./git";
import { parseRebaseTodo, type RebaseAction, type RebaseStep, rebaseTodo } from "./gitparse";
import { pick } from "./palette";
import { openTerminal } from "./terminal";

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
      steps = parseRebaseTodo(await mergesTodo(base)).map((s) => (s.line ? s : { ...s, message: commits.find((c) => c.hash.startsWith(s.hash))?.message }));
    }
  } catch (e) {
    return host.status(`Can't list commits: ${String(e).trim()}`);
  }
  if (!steps.some((s) => !s.line)) return host.status("There are no commits after that one on this branch.");
  // A squash or fixup joins the commit before it, so it can't follow the start, a reset, or a label.
  const canSquash = (i: number) => i > 0 && (!steps[i - 1].line || steps[i - 1].line!.startsWith("merge"));

  document.getElementById("rebase")?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "rebase";
  dialog.innerHTML = `<form method="dialog"><h2>Interactive rebase</h2><p class="muted">Oldest first. Commits are replayed on ${base.slice(0, 7)} in this order.${merges ? " Merges are rebuilt too: Label names a point, Reset goes back to one, and Merge merges it again." : ""}</p><ol class="rebase-steps"></ol><div class="buttons"><button type="button" data-cancel>Cancel</button><button type="button" class="primary" data-start>Start Rebase</button></div></form>`;
  const list = dialog.querySelector("ol")!;

  const render = () =>
    list.replaceChildren(
      ...steps.map((s, i) => {
        const li = document.createElement("li");
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
        const select = document.createElement("select");
        for (const [value, label] of ACTIONS) select.append(new Option(label, value, false, s.action === value));
        for (const o of select.options) if (!canSquash(i) && (o.value === "squash" || o.value === "fixup")) o.disabled = true;
        select.onchange = () => ((s.action = select.value as RebaseAction), render());
        const hash = document.createElement("code");
        hash.textContent = s.hash.slice(0, 7);
        const text = document.createElement(s.action === "reword" ? "textarea" : "span");
        text.className = "subject";
        if (text instanceof HTMLTextAreaElement) {
          text.value = s.message ?? s.subject;
          text.rows = Math.min(6, text.value.split("\n").length + 1);
          text.oninput = () => (s.message = text.value);
        } else text.textContent = s.subject;
        const move = (by: number, label: string, icon: string) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = `icon-button codicon codicon-${icon}`;
          b.title = label;
          b.disabled = i + by < 0 || i + by >= steps.length;
          b.onclick = () => {
            [steps[i], steps[i + by]] = [steps[i + by], steps[i]];
            render();
          };
          return b;
        };
        li.append(select, hash, text, move(-1, "Move up", "arrow-up"), move(1, "Move down", "arrow-down"));
        return li;
      }),
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
  await invoke("create_dir", { path: dir });
  const file = (i: number) => `${dir}/message-${i}.txt`;
  for (const [i, s] of steps.entries()) if (s.action === "reword") await invoke("write_file", { path: file(i), contents: (s.message ?? s.subject).trim() + "\n" });
  const todo = `${dir}/todo.txt`;
  await invoke("write_file", { path: todo, contents: rebaseTodo(steps, file) });
  // git runs the sequence editor with the todo file's path, so cp puts ours in its place.
  // GIT_EDITOR=true keeps squash's combined message without opening an editor.
  const line = `GIT_SEQUENCE_EDITOR=${q(`cp ${q(todo)}`)} GIT_EDITOR=true git rebase -i --autostash${merges ? " --rebase-merges" : ""} ${q(base)}`;
  openTerminal(host.root(), "Interactive rebase", ["/bin/sh", "-c", line], () => refreshGit());
}

/** Asks for the base commit from the branch's recent history, then opens the editor. */
export async function chooseRebaseBase() {
  const out = await git("log", "-50", "--format=%H%x1f%h%x1f%s%x1f%cr").catch(() => "");
  const commits = out.split("\n").filter(Boolean).map((l) => l.split("\x1f"));
  pick("Rebase the commits after…", () =>
    commits.slice(1).map(([hash, short, subject, when]) => ({ label: `${short} ${subject}`, detail: when, run: () => interactiveRebase(hash) })),
  );
}

export function initRebase(h: Host) {
  host = h;
}
