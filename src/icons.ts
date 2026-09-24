// File and folder icons, as codicon names plus a color class. Free of editor imports so Node can test it.

export type Icon = { codicon: string; color: string };

const byName: Record<string, Icon> = {
  "composer.json": { codicon: "json", color: "icon-php" },
  "composer.lock": { codicon: "lock", color: "icon-lock" },
  "package.json": { codicon: "json", color: "icon-js" },
  "package-lock.json": { codicon: "lock", color: "icon-lock" },
  "pnpm-lock.yaml": { codicon: "lock", color: "icon-lock" },
  "yarn.lock": { codicon: "lock", color: "icon-lock" },
  artisan: { codicon: "terminal", color: "icon-php" },
  ".gitignore": { codicon: "source-control", color: "icon-config" },
  ".gitattributes": { codicon: "source-control", color: "icon-config" },
  ".editorconfig": { codicon: "settings", color: "icon-config" },
  Dockerfile: { codicon: "vm", color: "icon-ts" },
};

const byExtension: [RegExp, Icon][] = [
  [/\.blade\.php$/, { codicon: "file-code", color: "icon-blade" }],
  [/\.php$/, { codicon: "file-code", color: "icon-php" }],
  [/\.(ts|tsx|mts|cts)$/, { codicon: "file-code", color: "icon-ts" }],
  [/\.(js|jsx|mjs|cjs)$/, { codicon: "file-code", color: "icon-js" }],
  [/\.vue$/, { codicon: "file-code", color: "icon-vue" }],
  [/\.json$/, { codicon: "json", color: "icon-json" }],
  [/\.(css|scss|sass|less)$/, { codicon: "symbol-color", color: "icon-css" }],
  [/\.(md|markdown)$/, { codicon: "markdown", color: "icon-md" }],
  [/\.(ya?ml|toml|xml|xml\.dist|neon|ini)$/, { codicon: "settings", color: "icon-config" }],
  [/^\.env(\..*)?$/, { codicon: "key", color: "icon-config" }],
  [/\.(png|jpe?g|gif|svg|webp|ico|avif)$/, { codicon: "file-media", color: "icon-image" }],
  [/\.(sh|bash|zsh)$/, { codicon: "terminal", color: "icon-config" }],
  [/\.(lock)$/, { codicon: "lock", color: "icon-lock" }],
  [/\.(sql|sqlite)$/, { codicon: "database", color: "icon-config" }],
  [/\.(http|rest)$/, { codicon: "globe", color: "icon-ts" }],
];

/** Folders that hold dependencies or generated files, shown dimmed, as PhpStorm marks excluded folders. */
export const EXCLUDED_FOLDERS = new Set(["vendor", "node_modules", "storage", ".git", ".idea", ".claude", ".phpunit.cache", "dist", "build"]);

export function fileIcon(name: string): Icon {
  if (byName[name]) return byName[name];
  for (const [pattern, icon] of byExtension) if (pattern.test(name)) return icon;
  return { codicon: "file", color: "icon-config" };
}

export function folderIcon(name: string, open: boolean): Icon {
  const codicon = open ? "folder-opened" : "folder";
  if (EXCLUDED_FOLDERS.has(name)) return { codicon, color: "icon-folder-excluded" };
  if (name === "tests") return { codicon, color: "icon-folder-test" };
  if (name === "app" || name === "src") return { codicon, color: "icon-folder-special" };
  return { codicon, color: "icon-folder" };
}

/** A small colored square with a project's initials, like PhpStorm's project badges. */
export function initials(name: string): string {
  const words = name.split(/[-_\s.]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? words[0]?.[1] ?? "")).toUpperCase();
}
