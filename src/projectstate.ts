// Per-project state, in one of two places. Shared values live in the project's `tusk.json`, so a team can commit
// them; local values live in a file per project in the app's data folder, so they survive a reset of the web view,
// unlike localStorage. A value lives in one place at a time: reading takes tusk.json's first, and writing keeps a
// value where it is unless you pass another scope. Values are plain JSON, keyed by top-level names in tusk.json.
import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { toast } from "./dom";
import { type Item, pick } from "./palette";
import { changedKeys, localFileName, migrate, parseShared, type Values, writeShared } from "./projectstatedata";

export type Scope = "shared" | "local";

// ---- The open project's state ----

type LocalFile = { root: string; migrated?: number; values: Values };
const MIGRATION = 1;

let root = "";
let shared: Values = {};
/** Why tusk.json can't be read, or null when it can (or doesn't exist). */
let sharedError: string | null = null;
/** tusk.json's text as last read or written, to tell our own writes from others' in the file watcher. */
let sharedText = "";
let local: Values = {};
let localPath = "";
/** Writes, one after another, so two quick changes can't land out of order. */
let writing: Promise<unknown> = Promise.resolve();
const listeners = new Map<string, Set<() => void>>();
let host = { openFile: (_path: string) => {} };

const tuskPath = () => `${root}/tusk.json`;
const readText = (path: string) => invoke<string>("read_file", { path }).catch(() => "");

function readShared(text: string) {
  sharedText = text;
  const parsed = parseShared(text);
  sharedError = parsed.error ?? null;
  if (parsed.error !== undefined) {
    // Keep using what was read before, and never write over the file.
    toast(`Tusk can't read tusk.json: ${parsed.error}. Until you fix it, Tusk uses the settings it last read from it, and doesn't change the file.`, {
      action: { label: "Open tusk.json", run: () => host.openFile(tuskPath()) },
    });
    return;
  }
  shared = parsed.values;
}

function writeLocal() {
  const path = localPath;
  const contents = `${JSON.stringify({ root, migrated: MIGRATION, values: local } satisfies LocalFile, null, 2)}\n`;
  writing = writing
    .then(() => invoke("create_dir", { path: path.slice(0, path.lastIndexOf("/")) }))
    .then(() => invoke("write_file", { path, contents }))
    .catch((e) => toast(`Can't save the project's settings in ${path}: ${e}`));
  return writing;
}

function notify(keys: string[]) {
  for (const key of keys) listeners.get(key)?.forEach((f) => f());
}

/** Tells the module how to open tusk.json when it's invalid. */
export const initProjectState = (h: typeof host) => (host = h);

/**
 * Loads a project's state: tusk.json and the local file, moving older values out of localStorage the first time.
 * Call it when a folder opens, before anything reads the project's values.
 */
export async function openProjectState(dir: string) {
  root = dir;
  shared = {};
  local = {};
  localPath = `${await appDataDir()}/projects/${localFileName(dir)}`;
  const [text, localText] = await Promise.all([readText(tuskPath()), readText(localPath)]);
  readShared(text);
  let file: Partial<LocalFile> = {};
  try {
    file = localText ? JSON.parse(localText) : {};
  } catch {
    toast(`Tusk can't read the project's local settings in ${localPath}, so they start over.`);
  }
  local = file.values && typeof file.values === "object" ? file.values : {};
  if ((file.migrated ?? 0) < MIGRATION) {
    try {
      Object.assign(local, migrate((k) => localStorage.getItem(k), Object.keys(localStorage), dir, (k) => k in shared || k in local));
    } catch {
      // No localStorage: nothing to move.
    }
    await writeLocal();
  }
}

/** A value of the open project: tusk.json's, else the local one, else undefined. */
export function projectValue<T>(key: string): T | undefined {
  return (key in shared ? shared[key] : local[key]) as T | undefined;
}

/** Where a value is kept now, or undefined when it isn't set. */
export const projectScope = (key: string): Scope | undefined => (key in shared ? "shared" : key in local ? "local" : undefined);

/** Why tusk.json can't be read, or null. */
export const sharedStateError = () => sharedError;

/**
 * Sets a value of the open project, or removes it with undefined. It stays where it is kept now unless `scope` says
 * otherwise, and new values are local; the other place loses its copy. Throws, without writing, when the value
 * goes to (or has to leave) tusk.json and tusk.json isn't valid.
 */
export async function setProjectValue(key: string, value: unknown, scope: Scope = projectScope(key) ?? "local") {
  if (!root) return;
  const touchesShared = scope === "shared" || key in shared;
  if (touchesShared) {
    if (sharedError) throw new Error(`Can't change tusk.json: ${sharedError}. Fix it, then try again.`);
    const text = writeShared(sharedText, { [key]: scope === "shared" ? value : undefined });
    if (scope === "shared" && value !== undefined) shared[key] = value;
    else delete shared[key];
    if (text !== sharedText) {
      sharedText = text;
      const path = tuskPath();
      const write = writing.then(() => (text ? invoke("write_file", { path, contents: text }) : invoke("remove_path", { path })));
      writing = write.catch(() => {}); // The caller hears of a failure; later writes still run.
      await write;
    }
  }
  const hadLocal = key in local;
  if (scope === "local" && value !== undefined) local[key] = value;
  else delete local[key];
  if (hadLocal || key in local) await writeLocal();
}

/** Moves a value, as it is, to tusk.json or to this Mac. */
export async function setProjectScope(key: string, scope: Scope) {
  if (projectScope(key) !== scope) await setProjectValue(key, projectValue(key), scope);
}

/**
 * Runs `f` when tusk.json changes a value on disk, such as after `git pull`. Not after setProjectValue, and not when
 * another project opens: read the values again then.
 */
export function onProjectValue(key: string, f: () => void) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key)!.add(f);
  return () => listeners.get(key)!.delete(f);
}

/** Reads tusk.json again when the file watcher reports it changed, such as after `git pull`, and tells the listeners. */
export async function projectFilesChanged(paths: Iterable<string>) {
  if (!root || ![...paths].includes(tuskPath())) return;
  await writing; // Our own write lands first, so its event reads as no change.
  const text = await readText(tuskPath());
  if (text === sharedText) return;
  const before = { ...local, ...shared };
  readShared(text);
  notify(changedKeys(before, { ...local, ...shared }));
}

// ---- Choosing what to share ----

/** The values a team may want to share, by the name the palette shows. */
export const SHAREABLE: { label: string; keys: string[]; detail: string }[] = [
  { label: "Index exclusions", keys: ["indexExclude"], detail: "Folders the PHP index and Mago skip" },
  { label: "Server paths for debugging", keys: ["debugPathMappings"], detail: "Where the project is on the server or in Docker" },
  { label: "Pause on exceptions", keys: ["debugExceptions"], detail: "Whether to pause, the classes, and paths to skip" },
  { label: "Breakpoints", keys: ["breakpoints"], detail: "Line breakpoints and their options" },
  { label: "Docker service for commands", keys: ["dockerService"], detail: "Where tests, Artisan, and Tinker run" },
  { label: "PHP interpreter", keys: ["phpInterpreter"], detail: "The PHP this project runs instead of the one in Settings > Tools" },
  { label: "Database connections", keys: ["databaseConnections", "databaseSsh"], detail: "Names, URLs, and SSH tunnels; passwords stay in the Keychain" },
];

const isShared = (keys: string[]) => keys.some((k) => projectScope(k) === "shared");

/** Moves values to tusk.json, or back to this Mac when they're shared, and says what happened or why it couldn't. */
async function toggleShared(keys: string[], what: string) {
  const sharing = !isShared(keys);
  if (!keys.some((k) => projectScope(k))) return toast(`Set the ${what} first, then share it.`, { kind: "info" });
  try {
    for (const k of keys) await setProjectScope(k, sharing ? "shared" : "local");
    toast(sharing ? `Moved the ${what} to tusk.json. Commit the file to share it with your team.` : `Moved the ${what} out of tusk.json, to this Mac only.`, { kind: "info", timeout: 4000 });
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

/** A palette row that shares values in tusk.json, or keeps them on this Mac again, for the pickers that set them. */
export function shareItem(keys: string | string[], what: string): Item {
  const list = [keys].flat();
  const shared = isShared(list);
  return {
    label: shared ? `Stop sharing the ${what}` : `Share the ${what} in tusk.json`,
    detail: shared ? "Shared with the project now; keep it on this Mac only" : "On this Mac only now; share it with your team",
    icon: shared ? "codicon-device-desktop" : "codicon-organization",
    run: () => toggleShared(list, what),
  };
}

/** Lists the shareable values and where each is kept; choosing one moves it to tusk.json or back to this Mac. */
export function chooseSharedState() {
  if (!root) return;
  pick(sharedError ? `tusk.json can't be read: ${sharedError}` : "Share project settings with your team in tusk.json", () =>
    SHAREABLE.map((s) => {
      const shared = isShared(s.keys);
      const set = s.keys.some((k) => projectScope(k));
      return {
        label: `${shared ? "✓ " : ""}${s.label}`,
        detail: `${shared ? "Shared in tusk.json" : set ? "On this Mac only" : "Not set"} · ${s.detail}`,
        icon: shared ? "codicon-organization" : "codicon-device-desktop",
        run: () => toggleShared(s.keys, s.label.toLowerCase()).then(chooseSharedState),
      };
    }),
  );
}
