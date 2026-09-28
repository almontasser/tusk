// Local history's pure parts: version file names, labels, and which version a label or time points at. Free of
// editor imports so Node can test it.

/** A saved version of a file: when it was kept, why, and its file name in the file's history folder. */
export type Version = { time: number; action: string; name: string };
/** A named point in the project's history, from Put Label. */
export type Label = { time: number; name: string };

/**
 * A version's file name: `<ms>~<action>.txt`, with the action URI-encoded. Versions from before actions were kept
 * are `<ms>.txt`.
 */
export const versionName = (time: number, action: string) => `${time}~${encodeURIComponent(action)}.txt`;

/** Reads a version's file name, or null for other files. A name without an action is a save. */
export function parseVersion(name: string): Version | null {
  const m = name.match(/^(\d+)(?:~([^/]*))?\.txt$/);
  if (!m) return null;
  let action = "Saved";
  try {
    if (m[2]) action = decodeURIComponent(m[2]);
  } catch {
    action = m[2];
  }
  return { time: Number(m[1]), action, name };
}

/** The versions among `names`, newest first. */
export const parseVersions = (names: string[]) =>
  names
    .map(parseVersion)
    .filter((v): v is Version => !!v)
    .sort((a, b) => b.time - a.time);

/** The newest version kept at or before `time`, which is the file as it was then; undefined when none was. */
export const versionAt = <V extends Version>(versions: V[], time: number): V | undefined => versions.filter((v) => v.time <= time).sort((a, b) => b.time - a.time)[0];

/** Labels read from labels.json, newest first, dropping anything that isn't one. */
export function parseLabels(text: string): Label[] {
  try {
    const list = JSON.parse(text);
    if (!Array.isArray(list)) return [];
    return list.filter((l) => l && typeof l.time === "number" && typeof l.name === "string").sort((a, b) => b.time - a.time);
  } catch {
    return [];
  }
}

/** Adds a label, keeping the newest `keep`. */
export const addLabel = (labels: Label[], label: Label, keep = 100): Label[] => [label, ...labels].sort((a, b) => b.time - a.time).slice(0, keep);
