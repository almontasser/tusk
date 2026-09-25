// Combines `composer show` and `composer outdated` output with composer.json, and reads `composer why`.
// Free of editor imports so Node can test it.

type Installed = { name: string; version: string; description?: string; latest?: string; "latest-status"?: string; abandoned?: boolean | string };
export type Package = {
  name: string;
  version: string;
  description: string;
  dev: boolean;
  /** Required by composer.json itself, rather than by another package. */
  direct: boolean;
  /** The newest version, when it's newer than the installed one. */
  latest?: string;
  /** "semver-safe-update" fits the constraint in composer.json; "update-possible" needs a new constraint. */
  status?: string;
  abandoned: boolean;
};

export function packages(show: string, outdated: string | null, composerJson: string): Package[] {
  const installed: Installed[] = JSON.parse(show).installed ?? [];
  const newer = new Map<string, Installed>();
  for (const p of outdated ? (JSON.parse(outdated).installed as Installed[]) ?? [] : []) if (p.latest && p.latest !== p.version) newer.set(p.name, p);
  const json = JSON.parse(composerJson);
  const dev = new Set(Object.keys(json["require-dev"] ?? {}));
  const direct = new Set([...dev, ...Object.keys(json.require ?? {})]);
  return installed
    .map((p) => ({
      name: p.name,
      version: p.version,
      description: p.description ?? "",
      dev: dev.has(p.name),
      direct: direct.has(p.name),
      latest: newer.get(p.name)?.latest,
      status: newer.get(p.name)?.["latest-status"],
      abandoned: !!p.abandoned,
    }))
    .sort((a, b) => Number(!a.direct) - Number(!b.direct) || Number(a.dev) - Number(b.dev) || a.name.localeCompare(b.name));
}

/** A package that needs another: one row of `composer why`. `version` is "-" for the project itself. */
export type Dependent = { name: string; version: string; relation: string; constraint: string };

/** Reads `composer why` rows, such as `laravel/framework v12.1.0 requires symfony/console (^7.2)`. */
export function dependents(out: string): Dependent[] {
  return [...out.matchAll(/^(\S+)\s+(\S+)\s+(requires(?: \(for development\))?|replaces|provides|conflicts)\s+\S+\s+\((.*)\)\s*$/gm)].map((m) => ({
    name: m[1],
    version: m[2],
    relation: m[3],
    constraint: m[4],
  }));
}
