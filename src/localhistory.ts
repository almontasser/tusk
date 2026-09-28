// Local history: a copy of each file every time you save it, before another program changes an open file,
// after another program changes a closed one, and before you delete it, kept outside the project in the app's
// data folder, so you can compare with or restore a version that was never committed, even of a deleted file.
import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { localHistory } from "./limits";
import { skippedPath } from "./treehidden";
import { addLabel, type Label, parseLabels, parseVersions, type Version, versionName } from "./localhistorydata";
import { pick } from "./palette";
import { toPrune } from "./retention";
import { readText } from "./projectfiles";

type Host = {
  root(): string;
  status(text: string): void;
  /** An open file's text in the editor, which may be unsaved. */
  openText(path: string): string | undefined;
  /** Writes a file's text, through its editor tab when it has one, so ⌘Z there undoes it. */
  setText(path: string, text: string): Promise<void>;
};
type Entry = { name: string; path: string; is_dir: boolean };
export type { Label, Version };

let host: Host;
const maxSize = () => localHistory.localHistoryMaxKB * 1000;

const relative = (path: string) => path.slice(host.root().length + 1);
const projectDir = async () => `${await appDataDir()}/history/${host.root().replace(/[^A-Za-z0-9]+/g, "_")}`;
const fileDir = async (path: string) => `${await projectDir()}/${encodeURIComponent(relative(path))}`;
/** A file's versions, newest first, from its history folder. */
const versions = async (dir: string) => parseVersions((await invoke<Entry[]>("read_dir", { path: dir }).catch(() => [])).map((e) => e.name));

// What's changing files right now, such as "git checkout" or "Refactoring", to name the versions that other
// programs' changes add, which otherwise read "External change".
let activity: { label: string; until: number } | null = null;
/** Names the versions changes in the next few seconds add, for a git command or a refactoring the editor runs. */
export function historyActivity(label: string) {
  activity = { label, until: Date.now() + 10_000 };
}
const external = (before = false) => {
  const cause = activity && Date.now() < activity.until ? activity.label : "external change";
  return before ? `Before ${cause}` : cause[0].toUpperCase() + cause.slice(1);
};

/**
 * Saves a version of a project file, unless it's large or the same as the last version. `action` says why, such as
 * "Saved" or "Before revert"; "external" and "before external" name the activity, or "External change". `time`
 * names the version.
 */
export async function recordVersion(path: string, text: string, action = "Saved", time = Date.now()) {
  if (!host.root() || !path.startsWith(host.root() + "/") || text.length > maxSize()) return;
  if (action === "external" || action === "before external") action = external(action !== "external");
  try {
    const dir = await fileDir(path);
    const [last] = await versions(dir);
    if (last && (await invoke<string>("read_file", { path: `${dir}/${last.name}` }).catch(() => null)) === text) return;
    await invoke("create_dir", { path: dir });
    await invoke("write_file", { path: `${dir}/${versionName(time, action)}`, contents: text });
    for (const name of toPrune((await versions(dir)).map((v) => v.name), Date.now(), localHistory.localHistoryDays, localHistory.localHistoryVersions)) await invoke("remove_path", { path: `${dir}/${name}` });
  } catch {
    // History is a convenience; a failure here must never block saving.
  }
}

/**
 * Files that git ignores, such as build output, from one `git check-ignore`. Outside a repository, none. Null when
 * git can't answer, such as for a path inside a submodule, which fails the whole call.
 */
async function ignored(paths: string[]): Promise<Set<string> | null> {
  try {
    const out = await invoke<string>("run_capture", { cwd: host.root(), program: "git", args: ["check-ignore", "--stdin"], input: paths.join("\n") });
    return new Set(out.split("\n"));
  } catch (e) {
    // Exit status 1, with nothing on stderr, means that none of them are ignored.
    const message = String(e).trim();
    return !message || /not a git repository/i.test(message) ? new Set() : null;
  }
}

/**
 * Keeps versions of project files that another program changed while they weren't open, such as a
 * code generator or `git checkout`. The text before the change is gone by then, so each change's new
 * text is kept: the next change then has its earlier text in the history. A file changed for the first
 * time also gets the version git has staged, when it differs, as its earlier text.
 */
export async function recordExternalChanges(paths: string[]) {
  const root = host.root();
  // .env files hold secrets, so they're never copied, even in a project without git to ignore them.
  const candidates = paths.filter((p) => p.startsWith(root + "/") && !/(^|\/)\.env[^/]*$/.test(p) && !skippedPath(relative(p)));
  if (!candidates.length) return;
  const skip = await ignored(candidates);
  if (!skip) return; // Rather than copy files git might ignore.
  // ponytail: 200 files per batch, so a branch switch that rewrites thousands doesn't copy them all; git has those anyway.
  for (const path of candidates.filter((p) => !skip.has(p)).slice(0, 200)) {
    const text = await readText(path).catch(() => null); // Deleted, a folder, or not text.
    if (text === null || text.length > maxSize()) continue;
    if (!(await versions(await fileDir(path))).length) {
      const staged = await invoke<string>("run_capture", { cwd: root, program: "git", args: ["show", `:./${relative(path)}`], input: null }).catch(() => null);
      if (staged !== null && staged !== text) await recordVersion(path, staged, "Staged in git", Date.now() - 1);
    }
    await recordVersion(path, text, "external");
  }
}

/** Keeps a version of a file, or of each file in a folder, before it's deleted. */
export async function recordBeforeDelete(path: string, isDir: boolean) {
  // ponytail: a folder's first 500 files (ignored ones, such as vendor, left out), which covers typical deletes.
  const files = isDir ? (await invoke<string[]>("list_files", { root: path }).catch(() => [])).slice(0, 500).map((f) => `${path}/${f.replace(/^\//, "")}`) : [path];
  for (const file of files) {
    const text = await readText(file).catch(() => null);
    if (text !== null) await recordVersion(file, text, "Before delete");
  }
}

/** Lists files that have local history but no longer exist; choosing one shows its versions. */
export async function showDeletedFiles() {
  if (!host.root()) return;
  const entries = await invoke<Entry[]>("read_dir", { path: await projectDir() }).catch(() => []);
  const deleted: string[] = [];
  for (const e of entries) {
    const path = `${host.root()}/${decodeURIComponent(e.name)}`;
    if (e.is_dir && !(await invoke<boolean>("path_exists", { path }))) deleted.push(path);
  }
  if (!deleted.length) return host.status("No deleted files have local history.");
  pick("Deleted files with local history. Choose one to see its versions", () =>
    deleted.sort().map((path) => ({ label: relative(path), run: () => showLocalHistory(path) })),
  );
}

/** Opens the Local History tab for a file or a folder. Loaded when first used. */
export const showLocalHistory = (path: string, folder = false) => import("./localhistoryview").then((m) => m.openLocalHistory(path, folder));

// ---- For the Local History tab ----

/** A version of a file in the project, which may have been deleted since. */
export type FileVersion = Version & { path: string };

/** A file's versions, newest first. */
export async function fileVersions(path: string): Promise<FileVersion[]> {
  return (await versions(await fileDir(path))).map((v) => ({ ...v, path }));
}

/** Every version of the files under `folder`, deleted ones too, newest first. Reports how many files it read of how many. */
export async function folderVersions(folder: string, signal: AbortSignal, progress: (done: number, total: number) => void): Promise<FileVersion[]> {
  const prefix = folder === host.root() ? "" : `${relative(folder)}/`;
  const dirs = (await invoke<Entry[]>("read_dir", { path: await projectDir() }).catch(() => [])).filter((e) => e.is_dir && decodeURIComponent(e.name).startsWith(prefix));
  const all: FileVersion[] = [];
  for (const [i, e] of dirs.entries()) {
    signal.throwIfAborted();
    progress(i, dirs.length);
    const path = `${host.root()}/${decodeURIComponent(e.name)}`;
    all.push(...(await versions(e.path)).map((v) => ({ ...v, path })));
  }
  return all.sort((a, b) => b.time - a.time);
}

/** A version's text. */
export const readVersion = async (v: FileVersion) => invoke<string>("read_file", { path: `${await fileDir(v.path)}/${v.name}` });

/** A file's text now, or null when it doesn't exist. */
export const currentText = async (path: string): Promise<string | null> => host.openText(path) ?? readText(path).catch(async (e) => ((await invoke<boolean>("path_exists", { path }).catch(() => true)) ? Promise.reject(e) : null));

/**
 * Sets files to earlier texts, keeping each one's current text as a version first ("Before revert"), and returns
 * what undoes it: the texts they had, with null for files that didn't exist.
 */
export async function revertFiles(changes: [path: string, text: string][]): Promise<[string, string | null][]> {
  const undo: [string, string | null][] = [];
  historyActivity("revert"); // The file watcher then names the new text's version Revert.
  for (const [path, text] of changes) {
    const now = await currentText(path);
    if (now === text) continue;
    if (now !== null) await recordVersion(path, now, "Before revert");
    // A deleted file's folder may be gone too.
    await invoke("create_dir", { path: path.slice(0, path.lastIndexOf("/")) });
    await host.setText(path, text);
    undo.push([path, now]);
  }
  return undo;
}

/** Undoes revertFiles: files that didn't exist go to the Trash, the rest get their text back. */
export async function undoRevert(undo: [string, string | null][]) {
  historyActivity("undo revert");
  for (const [path, text] of undo) {
    if (text === null) await invoke("trash_path", { path }).catch(() => invoke("remove_path", { path }));
    else await host.setText(path, text);
  }
}

const labelsFile = async () => `${await projectDir()}/labels.json`;
/** The project's labels, newest first. */
export const labels = async (): Promise<Label[]> => parseLabels(await invoke<string>("read_file", { path: await labelsFile() }).catch(() => "[]"));

/** Asks for a name and adds a label for the whole project now, as PhpStorm's Put Label does. */
export function putLabel(then?: () => unknown) {
  if (!host.root()) return host.status("Open a project first.");
  pick("Label name, such as “Before the upgrade”", (q) => [
    {
      label: q.trim() ? `Put Label “${q.trim()}”` : "Type a name for the label",
      icon: "codicon-tag",
      run: async () => {
        const name = q.trim();
        if (!name) return;
        try {
          await invoke("create_dir", { path: await projectDir() });
          await invoke("write_file", { path: await labelsFile(), contents: JSON.stringify(addLabel(await labels(), { time: Date.now(), name })) });
          host.status(`Put the label “${name}” in the local history`);
          then?.();
        } catch (e) {
          host.status(`Couldn't put the label: ${e}`);
        }
      },
    },
  ]);
}

export function initLocalHistory(h: Host) {
  host = h;
}
