// Local history: a copy of each file every time you save it, before another program changes an open file,
// and before you delete it, kept outside the project in the app's data folder, so you can compare with or
// restore a version that was never committed, even of a deleted file.
import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { age } from "./gitparse";
import { pick } from "./palette";
import { toPrune } from "./retention";

type Host = { root(): string; showDiff(path: string, original: string, modified: string, label: string, action: { label: string; run(): unknown }): void; status(text: string): void };
type Entry = { name: string; path: string; is_dir: boolean };

let host: Host;
const MAX_SIZE = 1_000_000;

const relative = (path: string) => path.slice(host.root().length + 1);
const projectDir = async () => `${await appDataDir()}/history/${host.root().replace(/[^A-Za-z0-9]+/g, "_")}`;
const fileDir = async (path: string) => `${await projectDir()}/${encodeURIComponent(relative(path))}`;
const versions = async (dir: string) =>
  (await invoke<Entry[]>("read_dir", { path: dir }).catch(() => []))
    .map((e) => e.name)
    .filter((n) => /^\d+\.txt$/.test(n))
    .sort()
    .reverse();

/** Saves a version of a project file, unless it's large or the same as the last version. */
export async function recordVersion(path: string, text: string) {
  if (!host.root() || !path.startsWith(host.root() + "/") || text.length > MAX_SIZE) return;
  try {
    const dir = await fileDir(path);
    const [last] = await versions(dir);
    if (last && (await invoke<string>("read_file", { path: `${dir}/${last}` }).catch(() => null)) === text) return;
    await invoke("create_dir", { path: dir });
    await invoke("write_file", { path: `${dir}/${Date.now()}.txt`, contents: text });
    for (const name of toPrune(await versions(dir), Date.now())) await invoke("remove_path", { path: `${dir}/${name}` });
  } catch {
    // History is a convenience; a failure here must never block saving.
  }
}

/** Keeps a version of a file, or of each file in a folder, before it's deleted. */
export async function recordBeforeDelete(path: string, isDir: boolean) {
  // ponytail: a folder's first 500 files (ignored ones, such as vendor, left out), which covers typical deletes.
  const files = isDir ? (await invoke<string[]>("list_files", { root: path }).catch(() => [])).slice(0, 500).map((f) => `${path}/${f.replace(/^\//, "")}`) : [path];
  for (const file of files) {
    const text = await invoke<string>("read_file", { path: file }).catch(() => null);
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
  if (!names.length) return host.status(`No local history for ${relative(path)} yet. A version is kept each time you save.`);
  pick(`Local history of ${relative(path)}`, () =>
    names.map((name) => {
      const time = Number.parseInt(name);
      return {
        label: new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" }),
        detail: age(time / 1000),
        run: async () => {
          const version = await invoke<string>("read_file", { path: `${dir}/${name}` });
          // null when the file was deleted.
          const current = await invoke<string>("read_file", { path }).catch(() => null);
          host.showDiff(relative(path), version, current ?? "", `${new Date(time).toLocaleString()} ↔ ${current === null ? "Deleted" : "Current"}`, {
            label: "Restore This Version",
            run: async () => {
              if (current !== null) await recordVersion(path, current); // So the restore can be undone from the history too.
              // A deleted file's folder may be gone too.
              await invoke("create_dir", { path: path.slice(0, path.lastIndexOf("/")) });
              await invoke("write_file", { path, contents: version });
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
