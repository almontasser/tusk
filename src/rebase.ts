// Interactive rebase: choose what happens to each commit after a base (pick, reword, squash, fixup,
// drop) and their order, then run git's own rebase -i with that todo list. It runs in a terminal tab,
// so a conflict stops it there and the Commit view's banner offers Continue and Abort.
import { invoke } from "@tauri-apps/api/core";
import { appCacheDir } from "@tauri-apps/api/path";
import { git, refreshGit } from "./git";
import { type RebaseAction, type RebaseStep, rebaseTodo } from "./gitparse";
import { pick } from "./palette";
import { openTerminal } from "./terminal";

type Host = { root(): string; status(text: string): void };
let host: Host;

const ACTIONS: [RebaseAction, string][] = [
  ["pick", "Pick"],
  ["reword", "Reword"],
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

/** Opens the editor for the commits after `base`. */
export async function interactiveRebase(base: string) {
  let steps: RebaseStep[];
  try {
    steps = await commitsAfter(base);
  } catch (e) {
    return host.status(`Can't list commits: ${String(e).trim()}`);
  }
  if (!steps.length) return host.status("There are no commits after that one on this branch.");
  if (await git("log", "--merges", "--format=%h", `${base}..HEAD`).then((o) => o.trim()).catch(() => ""))
    return host.status("Those commits include a merge, which this editor can't rebase. Use git rebase -i --rebase-merges in a terminal.");

  document.getElementById("rebase")?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "rebase";
  dialog.innerHTML = `<form method="dialog"><h2>Interactive rebase</h2><p class="muted">Oldest first. Commits are replayed on ${base.slice(0, 7)} in this order.</p><ol class="rebase-steps"></ol><div class="buttons"><button type="button" data-cancel>Cancel</button><button type="button" class="primary" data-start>Start Rebase</button></div></form>`;
  const list = dialog.querySelector("ol")!;

  const render = () =>
    list.replaceChildren(
      ...steps.map((s, i) => {
        const li = document.createElement("li");
        li.className = `rebase-step action-${s.action}`;
        const select = document.createElement("select");
        for (const [value, label] of ACTIONS) select.append(new Option(label, value, false, s.action === value));
        // The first commit has nothing before it to squash into.
        for (const o of select.options) if (i === 0 && (o.value === "squash" || o.value === "fixup")) o.disabled = true;
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
    if (["squash", "fixup"].includes(steps[0].action)) return host.status("The first commit can't be squashed: there's nothing before it.");
    dialog.close();
    await start(base, steps);
  };
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
}

async function start(base: string, steps: RebaseStep[]) {
  const dir = `${await appCacheDir()}/rebase`;
  await invoke("create_dir", { path: dir });
  const file = (i: number) => `${dir}/message-${i}.txt`;
  for (const [i, s] of steps.entries()) if (s.action === "reword") await invoke("write_file", { path: file(i), contents: (s.message ?? s.subject).trim() + "\n" });
  const todo = `${dir}/todo.txt`;
  await invoke("write_file", { path: todo, contents: rebaseTodo(steps, file) });
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  // git runs the sequence editor with the todo file's path, so cp puts ours in its place.
  // GIT_EDITOR=true keeps squash's combined message without opening an editor.
  const line = `GIT_SEQUENCE_EDITOR=${q(`cp ${q(todo)}`)} GIT_EDITOR=true git rebase -i --autostash ${q(base)}`;
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
