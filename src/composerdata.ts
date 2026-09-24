// Combines `composer show` and `composer outdated` output with composer.json. Free of editor imports
// so Node can test it.

type Installed = { name: string; version: string; description?: string; latest?: string; "latest-status"?: string; abandoned?: boolean | string };
export type Package = {
  name: string;
  version: string;
  description: string;
  dev: boolean;
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
  const dev = new Set(Object.keys(JSON.parse(composerJson)["require-dev"] ?? {}));
  return installed
    .map((p) => ({
      name: p.name,
      version: p.version,
      description: p.description ?? "",
      dev: dev.has(p.name),
      latest: newer.get(p.name)?.latest,
      status: newer.get(p.name)?.["latest-status"],
      abandoned: !!p.abandoned,
    }))
    .sort((a, b) => Number(a.dev) - Number(b.dev) || a.name.localeCompare(b.name));
}
