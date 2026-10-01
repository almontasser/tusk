// Push and Update Project, as PhpStorm has them: a Push dialog with the commits to push, the target branch, and a
// force-with-lease option, and an update that merges or rebases. Both run in the background with progress and
// Cancel, and say what happened, or what to do next when git refuses.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { defaultRemote } from "./branches";
import { h } from "./dom";
import { git, gitFailure, gitOutput, gitStatus, refreshGit } from "./git";
import { askpassKind, isConflict } from "./gitparse";
import { openMerge } from "./merge";
import { registerSettings } from "./settings";
import { errorText, showError, status, withProgress } from "./status";
import { openTerminal } from "./terminal";
import { mod } from "./platform.ts";

type Host = { root(): string };
let host: Host;
const info = (text: string) => status(text, "app", "info");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const settings = registerSettings("Git", { gitUpdateMethod: "merge" }, [
  {
    key: "gitUpdateMethod",
    label: "Update Project",
    type: "select",
    options: [
      ["merge", "Merge the incoming changes"],
      ["rebase", "Rebase your commits onto them"],
      ["config", "Use git's pull.rebase setting"],
    ],
    help: "How Update Project (⌘T) brings in the upstream branch's commits. Local changes are stashed and restored either way.",
  },
]);

/** Whether git's output says the remote refused because it has commits you don't. */
export const rejected = (out: string) => /\[rejected\]|\(fetch first\)|non-fast-forward|\(stale info\)|Updates were rejected/.test(out);
/** Whether git's output says it couldn't log in, which a terminal could answer. */
export const authFailed = (out: string) => /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|Host key verification failed/i.test(out);

/**
 * Asks a git or ssh prompt, such as a password for an HTTPS remote or a key's passphrase, in a dialog. The answer
 * goes straight back to git through askpass.rs and is never kept.
 */
function askpass({ id, prompt, confirm }: { id: number; prompt: string; confirm: boolean }) {
  const kind = askpassKind(prompt, confirm);
  const answer = (value: string | null) => void invoke("askpass_answer", { id, answer: value });
  let sent = false;
  const finish = (value: string | null) => (sent || answer(value), (sent = true), dialog.close());
  const field = h("input", { type: kind === "secret" ? "password" : "text", autocomplete: "off", spellcheck: false });
  const yesNo = kind === "yesno" || kind === "confirm";
  const dialog = h("dialog", { class: "refactor-dialog askpass-dialog" });
  dialog.append(
    h(
      "form",
      { method: "dialog", onsubmit: (e: Event) => (e.preventDefault(), finish(yesNo ? (kind === "yesno" ? "yes" : "") : field.value)) },
      h("h2", {}, yesNo ? "Confirm" : kind === "text" ? "Git Login" : "Password Required"),
      h("p", { class: "askpass-prompt" }, prompt.trim()),
      yesNo ? null : h("div", { class: "dialog-fields" }, h("label", { class: "field grow" }, kind === "text" ? "Username" : /passphrase/i.test(prompt) ? "Passphrase" : "Password", field)),
      h(
        "div",
        { class: "buttons" },
        h("button", { type: "button", onclick: () => finish(kind === "yesno" ? "no" : null) }, yesNo ? "No" : "Cancel"),
        h("button", { type: "submit", class: "primary" }, yesNo ? "Yes" : "OK"),
      ),
    ),
  );
  // Escape and closing the dialog count as Cancel.
  dialog.addEventListener("close", () => (finish(null), dialog.remove()));
  document.body.append(dialog);
  dialog.showModal();
  if (!yesNo) field.focus();
}

/** Offers a terminal for a command that couldn't log in, such as after a canceled or wrong password. */
function inTerminal(message: string, args: string[]) {
  showError(`${message}: git couldn't log in`, undefined, { label: "Run in Terminal", run: () => openTerminal(host.root(), `git ${args[0]}`, ["git", ...args], () => refreshGit()) });
}

// ---- Update Project ----

/** Pulls the upstream branch with the chosen method, stashing local changes around it. Resolves to whether it worked. */
export async function updateProject(): Promise<boolean> {
  const st = gitStatus();
  if (!st) return (showError("This folder isn't a git repository."), false);
  if (!st.upstream) {
    showError(`${st.branch} has no upstream branch to update from. Push it to create one, or set one in the branches popup`);
    return false;
  }
  const before = (await git("rev-parse", "HEAD").catch(() => "")).trim();
  const method = settings.gitUpdateMethod === "rebase" ? ["--rebase"] : settings.gitUpdateMethod === "merge" ? ["--no-rebase"] : [];
  const args = ["pull", ...method, "--autostash"];
  const result = await withProgress(`Updating ${st.branch} from ${st.upstream}…`, (signal) => gitOutput(args, signal), { cancellable: true, error: "Update failed" });
  await refreshGit();
  if (!result) return false;
  if (result.code) {
    const conflicted = gitStatus()?.files.filter(isConflict) ?? [];
    if (conflicted.length)
      showError(`Update stopped: ${plural(conflicted.length, "file has", "files have")} conflicts. Resolve them, then ${settings.gitUpdateMethod === "rebase" ? "continue the rebase" : "commit"}`, undefined, { label: "Resolve", run: () => openMerge(conflicted[0].path) });
    else if (authFailed(result.output)) inTerminal("Can't update", args);
    else gitFailure("Update failed", result.output);
    return false;
  }
  const after = (await git("rev-parse", "HEAD").catch(() => "")).trim();
  if (!before || before === after) return info("Everything is up to date."), true;
  const [count, stat] = await Promise.all([git("rev-list", "--count", `${before}..${after}`).catch(() => "0"), git("diff", "--shortstat", before, after).catch(() => "")]);
  const files = Number(stat.match(/(\d+) files? changed/)?.[1] ?? 0);
  info(`Updated ${st.branch}: ${plural(Number(count), "new commit")}${files ? `, ${plural(files, "file")} changed` : ""}.`);
  return true;
}

// ---- Push ----

type PushTarget = { remote: string; branch: string; force: boolean; setUpstream: boolean };

/** The commits that a push would send: those not on the upstream branch, or not on any remote without one. */
async function outgoing(upstream: string | undefined) {
  const range = upstream ? [`${upstream}..HEAD`] : ["HEAD", "--not", "--remotes"];
  const out = await git("log", "--format=%h%x1f%s%x1f%an", "-n", "500", ...range);
  return out.split("\n").filter(Boolean).map((l) => l.split("\x1f"));
}

/** Opens the Push dialog: the commits to push, the remote and branch to push to, and force with lease. */
export async function push() {
  const st = gitStatus();
  if (!st) return showError("This folder isn't a git repository.");
  if (st.branch.startsWith("HEAD")) return showError("You're not on a branch (detached HEAD). Create a branch to push, from the branches popup");
  const remotes = (await git("remote").catch(() => "")).split("\n").filter(Boolean);
  if (!remotes.length) return showError("This repository has no remote to push to. Add one with git remote add, in the terminal");
  const [upRemote, ...upBranch] = st.upstream?.split("/") ?? [];
  const remote = h("select", { ariaLabel: "Remote" });
  const initialRemote = upRemote && remotes.includes(upRemote) ? upRemote : ((await defaultRemote()) ?? remotes[0]);
  for (const r of remotes) remote.append(new Option(r, r, false, r === initialRemote));
  const branch = h("input", { value: upBranch.join("/") || st.branch, spellcheck: false, ariaLabel: "Remote branch" });
  const force = h("input", { type: "checkbox" });
  const list = h("div", { class: "members-list push-commits", tabIndex: 0 });
  list.dataset.empty = "Loading commits…";
  const button = h("button", { type: "submit", class: "primary" }, "Push");
  const note = h("span", { class: "dialog-hint" }, st.upstream ? `${st.branch} tracks ${st.upstream}.` : `${st.branch} has no upstream branch; this push sets it.`);
  const dialog = h("dialog", { id: "push-dialog", class: "refactor-dialog" });
  document.getElementById("push-dialog")?.remove();
  const title = h("h2", {}, "Push");

  outgoing(st.upstream).then(
    (commits) => {
      list.dataset.empty = st.upstream ? `Nothing to push: ${st.upstream} has every commit.` : "No commits that aren't on a remote yet.";
      list.replaceChildren(
        ...commits.map(([short, subject, author]) => h("div", { class: "member-row push-commit" }, h("code", { class: "muted" }, short), h("span", { class: "member-signature" }, subject), h("span", { class: "member-reason" }, author))),
      );
      title.textContent = commits.length ? `Push ${plural(commits.length, "commit")}` : "Push";
    },
    (e) => (list.dataset.empty = `Can't list the commits: ${errorText(e)}`),
  );
  dialog.append(
    h(
      "form",
      {
        method: "dialog",
        onsubmit: (e: Event) => {
          e.preventDefault();
          const target = { remote: remote.value, branch: branch.value.trim() || st.branch, force: force.checked, setUpstream: !st.upstream };
          dialog.close();
          pushTo(target);
        },
      },
      title,
      h("div", { class: "dialog-fields" }, h("label", { class: "field" }, "From", h("input", { value: st.branch, disabled: true })), h("label", { class: "field" }, "To remote", remote), h("label", { class: "field grow" }, "Branch", branch)),
      list,
      h("div", { class: "dialog-options" }, h("label", { title: "Overwrite the remote branch, unless someone pushed to it since you last fetched" }, force, "Force push (with lease)")),
      h("div", { class: "buttons" }, note, h("button", { type: "button", onclick: () => dialog.close() }, "Cancel"), button),
    ),
  );
  dialog.addEventListener("keydown", (e) => e.key === "Enter" && mod(e) && (e.preventDefault(), button.click()));
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  button.focus();
}

/** Pushes HEAD to a remote branch and says how many commits went, or why the remote refused. */
async function pushTo(t: PushTarget): Promise<void> {
  const st = gitStatus();
  const upstream = `${t.remote}/${t.branch}`;
  const count = (await outgoing(st?.upstream === upstream ? upstream : undefined).catch(() => [])).length;
  const args = ["push", "--porcelain", ...(t.setUpstream ? ["-u"] : []), ...(t.force ? ["--force-with-lease"] : []), t.remote, `HEAD:refs/heads/${t.branch}`];
  const result = await withProgress(`Pushing to ${upstream}…`, (signal) => gitOutput(args, signal), { cancellable: true, error: "Push failed" });
  await refreshGit();
  if (!result) return;
  if (result.code) {
    if (rejected(result.output) && !t.force)
      return showError(`Push rejected: ${upstream} has commits you don't have`, undefined, { label: "Update and Push", run: async () => void ((await updateProject()) && (await pushTo({ ...t, setUpstream: false }))) });
    if (rejected(result.output)) return gitFailure(`Push rejected: ${upstream} changed since you last fetched. Fetch, check what changed, and push again`, result.output);
    if (authFailed(result.output)) return inTerminal("Can't push", args.filter((a) => a !== "--porcelain"));
    return gitFailure("Push failed", result.output);
  }
  if (/\[up to date\]/.test(result.output)) return info(`Everything is up to date on ${upstream}.`);
  info(`${t.force ? "Force-pushed" : "Pushed"} ${count ? plural(count, "commit") : "the branch"} to ${upstream}.`);
}

export function initSync(h: Host) {
  host = h;
  listen<{ id: number; prompt: string; confirm: boolean }>("askpass", (e) => askpass(e.payload));
  document.getElementById("git-pull")!.onclick = () => updateProject();
  document.getElementById("git-push")!.onclick = () => push();
}
