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

type Locked = { name: string; type?: string; bin?: string[]; require?: Record<string, string>; autoload?: { "psr-4"?: Record<string, unknown>; "psr-0"?: Record<string, unknown> } };
const lockedPackages = (lock: string): Locked[] => {
  const json = JSON.parse(lock);
  return [...(json.packages ?? []), ...(json["packages-dev"] ?? [])];
};

/** For each package in composer.lock, the other locked packages that require it. */
export function requiredBy(lock: string): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const p of lockedPackages(lock)) for (const dep of Object.keys(p.require ?? {})) by.set(dep, [...(by.get(dep) ?? []), p.name]);
  return by;
}

/**
 * The direct dependencies that code would name, each with a regex that finds any of its namespaces, such as
 * `\bSpatie\\{1,2}Permission\b`, which also matches the doubled backslashes in strings. Plugins, command-line
 * tools, and packages without a namespace are left out: no code names them, so their absence says nothing.
 */
export function namespaceChecks(lock: string, composerJson: string): { name: string; pattern: string }[] {
  const json = JSON.parse(composerJson);
  const direct = new Set([...Object.keys(json.require ?? {}), ...Object.keys(json["require-dev"] ?? {})]);
  return lockedPackages(lock)
    .filter((p) => direct.has(p.name) && !p.bin?.length && !["composer-plugin", "metapackage", "phpstan-extension"].includes(p.type ?? ""))
    .map((p) => {
      const namespaces = [...Object.keys(p.autoload?.["psr-4"] ?? {}), ...Object.keys(p.autoload?.["psr-0"] ?? {})]
        .map((ns) => ns.split("\\").filter(Boolean).join("\\\\{1,2}"))
        .filter(Boolean);
      return { name: p.name, pattern: namespaces.length ? `\\b(?:${[...new Set(namespaces)].join("|")})\\b` : "" };
    })
    .filter((c) => c.pattern);
}

export type Advisory = { title: string; cve?: string; severity?: string; link?: string; affectedVersions?: string };

/** Reads `composer audit --format=json`: security advisories by package. Composer writes an empty list as `[]`. */
export function advisories(out: string): Map<string, Advisory[]> {
  const found = JSON.parse(out).advisories ?? {};
  return new Map(Array.isArray(found) ? [] : Object.entries(found).map(([name, list]) => [name, Object.values(list as Record<string, Advisory>)]));
}
