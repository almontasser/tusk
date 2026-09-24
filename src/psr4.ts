// Namespaces from composer.json PSR-4 mappings, for new PHP files. Free of editor imports so Node can test it.

/** `autoload.psr-4` and `autoload-dev.psr-4` merged: namespace prefix to one or more folders. */
export type Psr4 = Record<string, string | string[]>;

export function psr4From(composerJson: string): Psr4 {
  try {
    const c = JSON.parse(composerJson);
    return { ...c.autoload?.["psr-4"], ...c["autoload-dev"]?.["psr-4"] };
  } catch {
    return {};
  }
}

/**
 * The namespace for a file at `rel` (relative to the project root), from the PSR-4 mapping
 * whose folder is the longest match. Undefined when no mapping covers the file.
 */
export function namespaceFor(rel: string, psr4: Psr4): string | undefined {
  const dir = rel.split("/").slice(0, -1).join("/");
  let best: { prefix: string; folder: string } | undefined;
  for (const [prefix, folders] of Object.entries(psr4)) {
    for (const folder of [folders].flat().map((f) => f.replace(/^\.\//, "").replace(/\/$/, ""))) {
      const inside = folder === "" || dir === folder || dir.startsWith(folder + "/");
      if (inside && (!best || folder.length > best.folder.length)) best = { prefix, folder };
    }
  }
  if (!best) return undefined;
  const rest = best.folder === "" ? dir : dir.slice(best.folder.length + 1);
  return [best.prefix.replace(/\\$/, ""), ...rest.split("/").filter(Boolean)].filter(Boolean).join("\\");
}

/** Starting content for a new file: a class (or interface, trait, or enum by name) for PHP files under PSR-4. */
export function newFileContent(rel: string, psr4: Psr4): string {
  const name = rel.split("/").pop()!;
  if (!name.endsWith(".php") || name.endsWith(".blade.php")) return "";
  const type = name.slice(0, -4);
  const ns = namespaceFor(rel, psr4);
  if (ns === undefined || !/^[A-Za-z_]\w*$/.test(type)) return "<?php\n\n";
  const kind = type.endsWith("Interface") ? "interface" : type.endsWith("Trait") ? "trait" : type.endsWith("Enum") ? "enum" : "class";
  return `<?php\n\n${ns ? `namespace ${ns};\n\n` : ""}${kind} ${type}\n{\n}\n`;
}

/** Files that could declare the class `fqn` under the PSR-4 mappings, relative to the project root. */
export function pathsFor(fqn: string, psr4: Psr4): string[] {
  return Object.entries(psr4)
    .filter(([prefix]) => fqn.startsWith(prefix))
    .flatMap(([prefix, folders]) =>
      [folders].flat().map((f) => [f.replace(/^\.\//, "").replace(/\/$/, ""), fqn.slice(prefix.length).replaceAll("\\", "/") + ".php"].filter(Boolean).join("/")),
    );
}
