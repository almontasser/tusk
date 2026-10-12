// The HTTP client's pure logic, kept apart from httpclient.ts so tests can run it without Tauri or Monaco.

export type Environments = Record<string, Record<string, string>>;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** An environment's variables as strings. A nested object's values get dotted names, such as `client.host`. */
export function flattenEnv(vars: unknown, prefix = ""): Record<string, string> {
  if (!isObject(vars)) return {};
  return Object.fromEntries(Object.entries(vars).flatMap(([k, v]) => (isObject(v) ? Object.entries(flattenEnv(v, `${prefix}${k}.`)) : [[`${prefix}${k}`, String(v)]])));
}

/** The environments from a folder's shared and private files. Private values override shared ones, and PhpStorm's $shared environment applies to every other one. */
export function mergeEnvironments(shared: Record<string, unknown> | null, secret: Record<string, unknown> | null): Environments {
  const merged: Environments = {};
  for (const [env, vars] of [...Object.entries(shared ?? {}), ...Object.entries(secret ?? {})]) if (env !== "$shared") merged[env] = { ...merged[env], ...flattenEnv(vars) };
  const common = { ...flattenEnv(shared?.$shared), ...flattenEnv(secret?.$shared) };
  for (const env of Object.keys(merged)) merged[env] = { ...common, ...merged[env] };
  return merged;
}

/** Folders to look in for an .http file's environment files, nearest first: its folder, then each parent up to the project root. */
export function envDirs(dir: string, root: string): string[] {
  if (!root || (dir !== root && !dir.startsWith(`${root}/`))) return dir === root ? [root] : [dir, root];
  const dirs = [dir];
  while (dir !== root) dirs.push((dir = dir.slice(0, dir.lastIndexOf("/"))));
  return dirs;
}

/** The charset a Content-Type names, lowercased, such as "iso-8859-1", or undefined when it names none. */
export const responseCharset = (contentType: string) => contentType.match(/;\s*charset\s*=\s*"?([^";\s]+)/i)?.[1].toLowerCase();
