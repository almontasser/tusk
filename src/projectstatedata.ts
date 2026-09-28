// The pure parts of the project state (projectstate.ts): reading and writing tusk.json's text, telling which
// values changed, and moving an older version's values out of localStorage.

export type Values = Record<string, unknown>;

// ---- tusk.json text: parsing and writing without losing what's there ----

/** tusk.json's values, or why they can't be read. An empty or missing file has no values. */
export function parseShared(text: string): { values: Values; error?: undefined } | { values?: undefined; error: string } {
  if (!text.trim()) return { values: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: `it isn't valid JSON (${e instanceof Error ? e.message : e})` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "it isn't a JSON object" };
  return { values: parsed as Values };
}

/**
 * tusk.json's text with `changes` applied: a value sets its key, undefined removes it. Other keys, their order, the
 * indentation, and the final newline stay as they were; a new key goes last. "" when no key is left, so the file can
 * go. Throws when the text isn't a JSON object, rather than overwrite what someone wrote there.
 */
export function writeShared(text: string, changes: Values): string {
  const parsed = parseShared(text);
  if (parsed.error !== undefined) throw new Error(`Can't change tusk.json: ${parsed.error}. Fix it, then try again.`);
  const values = { ...parsed.values };
  for (const [key, value] of Object.entries(changes)) value === undefined ? delete values[key] : (values[key] = value);
  if (!Object.keys(values).length) return "";
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? "  ";
  const newline = !text.trim() || text.endsWith("\n") ? "\n" : "";
  return JSON.stringify(values, null, indent) + newline;
}

/** The keys whose values differ between two sets of values. */
export const changedKeys = (a: Values, b: Values) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

// ---- Moving values out of localStorage ----

/** Reads an older version's localStorage values for one key: `get` reads one entry, `keys` lists them all. */
type Legacy = { key: string; read(get: (key: string) => string | null, keys: string[], root: string): unknown };

const list = (csv: string | null) => (csv ?? "").split(",").filter(Boolean);
const json = (raw: string | null) => (raw === null ? undefined : JSON.parse(raw));
/** A path inside the project, relative to it; others stay absolute. */
export const projectRelative = (root: string, path: string) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path);

/** Where older versions kept each value, in localStorage. */
export const LEGACY: Legacy[] = [
  { key: "indexExclude", read: (get, _, root) => json(get(`indexExclude:${root}`))?.indexExclude },
  {
    key: "breakpoints",
    read(get, _, root) {
      // By absolute path: line numbers, then [line, condition] pairs, then [line, options].
      const saved = json(get(`breakpoints:${root}`)) as Record<string, (number | [number, string | object])[]> | undefined;
      if (!saved) return undefined;
      return Object.fromEntries(
        Object.entries(saved).map(([path, marks]) => [
          projectRelative(root, path),
          marks.map((b) => (typeof b === "number" ? [b, {}] : [b[0], typeof b[1] === "string" ? (b[1] ? { condition: b[1] } : {}) : b[1]])),
        ]),
      );
    },
  },
  { key: "debugPathMappings", read: (get, _, root) => get(`debug:serverRoot:${root}`) ?? undefined },
  {
    key: "debugExceptions",
    read(get, _, root) {
      const [pause, classes, uncaught, skip] = [get("debug:exceptions"), get(`debug:exceptionClasses:${root}`), get(`debug:exceptionUncaught:${root}`), get(`debug:exceptionSkip:${root}`)];
      if (pause === null && classes === null && uncaught === null && skip === null) return undefined;
      return { pause: pause === "1", classes: list(classes), uncaughtOnly: uncaught === "1", skip: list(skip) };
    },
  },
  { key: "debugWatches", read: (get, _, root) => json(get(`watches:${root}`)) },
  { key: "dockerService", read: (get, _, root) => get(`docker:service:${root}`) ?? undefined },
  { key: "profilerUrl", read: (get, _, root) => get(`profilerUrl:${root}`) ?? undefined },
  { key: "databaseConnections", read: (get, _, root) => json(get(`db:connections:${root}`)) },
  { key: "databaseConnection", read: (get, _, root) => get(`db:connection:${root}`) || undefined },
  {
    key: "databaseSsh",
    read(get, keys, root) {
      // `db:ssh:<root>` for .env's connection, `db:ssh:<root>#<name>` for a saved one.
      const prefix = `db:ssh:${root}`;
      const entries = keys.filter((k) => k === prefix || k.startsWith(`${prefix}#`)).map((k) => [k.slice(prefix.length + 1), get(k)]);
      return entries.some(([, v]) => v) ? Object.fromEntries(entries.filter(([, v]) => v)) : undefined;
    },
  },
  { key: "httpLoadTest", read: (get) => json(get("httpLoad")) },
];

/**
 * The values to keep locally from an older version's localStorage, for keys that have no value yet. An entry that
 * can't be read is skipped, so the rest still move.
 */
export function migrate(get: (key: string) => string | null, keys: string[], root: string, has: (key: string) => boolean, legacy = LEGACY): Values {
  const found: Values = {};
  for (const l of legacy) {
    if (has(l.key)) continue;
    try {
      const value = l.read(get, keys, root);
      if (value !== undefined) found[l.key] = value;
    } catch (e) {
      console.warn(`Can't move ${l.key} out of localStorage:`, e);
    }
  }
  return found;
}

/** A file name for the project's local state: its folder's name and a hash of its path. */
export function localFileName(path: string) {
  let hash = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193);
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/[^\w.-]/g, "_") || "root";
  return `${name}-${(hash >>> 0).toString(16).padStart(8, "0")}.json`;
}
