// Local history: a copy of each file every time you save it, before another program changes an open file,
// after another program changes a closed one, and before you delete it, kept outside the project in the app's
// data folder, so you can compare with or restore a version that was never committed, even of a deleted file.
import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { age } from "./gitparse";
import { localHistory } from "./limits";
import { skippedPath } from "./treehidden";
import { pick } from "./palette";
import { toPrune } from "./retention";
import { readText, writeText } from "./projectfiles";

type Host = { root(): string; showDiff(path: string, original: string, modified: string, label: string, action: { label: string; run(): unknown }): void; status(text: string): void };
type Entry = { name: string; path: string; is_dir: boolean };

let host: Host;
const maxSize = () => localHistory.localHistoryMaxKB * 1000;

const relative = (path: string) => path.slice(host.root().length + 1);
const projectDir = async () => `${await appDataDir()}/history/${host.root().replace(/[^A-Za-z0-9]+/g, "_")}`;
const fileDir = async (path: string) => `${await projectDir()}/${encodeURIComponent(relative(path))}`;
const versions = async (dir: string) =>
  (await invoke<Entry[]>("read_dir", { path: dir }).catch(() => []))
    .map((e) => e.name)
    .filter((n) => /^\d+\.txt$/.test(n))
    .sort()
    .reverse();

/** Saves a version of a project file, unless it's large or the same as the last version. `time` names the version. */
export async function recordVersion(path: string, text: string, time = Date.now()) {
  if (!host.root() || !path.startsWith(host.root() + "/") || text.length > maxSize()) return;
  try {
    const dir = await fileDir(path);
    const [last] = await versions(dir);
    if (last && (await invoke<string>("read_file", { path: `${dir}/${last}` }).catch(() => null)) === text) return;
    await invoke("create_dir", { path: dir });
    await invoke("write_file", { path: `${dir}/${time}.txt`, contents: text });
    for (const name of toPrune(await versions(dir), Date.now(), localHistory.localHistoryDays, localHistory.localHistoryVersions)) await invoke("remove_path", { path: `${dir}/${name}` });
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
      if (staged !== null && staged !== text) await recordVersion(path, staged, Date.now() - 1);
    }
    await recordVersion(path, text);
  }
}

/** Keeps a version of a file, or of each file in a folder, before it's deleted. */
export async function recordBeforeDelete(path: string, isDir: boolean) {
  // ponytail: a folder's first 500 files (ignored ones, such as vendor, left out), which covers typical deletes.
  const files = isDir ? (await invoke<string[]>("list_files", { root: path }).catch(() => [])).slice(0, 500).map((f) => `${path}/${f.replace(/^\//, "")}`) : [path];
  for (const file of files) {
    const text = await readText(file).catch(() => null);
    if (text !== null) await recordVersion(file, text);
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

/** Lists a file's saved versions; choosing one shows it next to the current file, with a button to restore it. */
export async function showLocalHistory(path: string) {
  if (!path.startsWith(host.root() + "/")) return host.status("Local history covers files in the project.");
  const dir = await fileDir(path);
  const names = await versions(dir);
  if (!names.length) return host.status(`No local history for ${relative(path)} yet. A version is kept each time you save, and when another program changes it.`);
  pick(`Local history of ${relative(path)}`, () =>
    names.map((name) => {
      const time = Number.parseInt(name);
      return {
        label: new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" }),
        detail: age(time / 1000),
        run: async () => {
          const version = await invoke<string>("read_file", { path: `${dir}/${name}` });
          // null when the file was deleted.
          const current = await readText(path).catch(() => null);
          host.showDiff(relative(path), version, current ?? "", `${new Date(time).toLocaleString()} ↔ ${current === null ? "Deleted" : "Current"}`, {
            label: "Restore This Version",
            run: async () => {
              if (current !== null) await recordVersion(path, current); // So the restore can be undone from the history too.
              // A deleted file's folder may be gone too.
              await invoke("create_dir", { path: path.slice(0, path.lastIndexOf("/")) });
              await writeText(path, version);
              host.status(`Restored ${relative(path)} from ${new Date(time).toLocaleString()}`);
            },
          });
        },
      };
    }),
  );
}

export function initLocalHistory(h: Host) {
  host = h;
}
