// Which files and folders the project tree hides or shows as excluded, from the project's lists. Free of editor
// imports so Node can test it.
import { covers } from "./indexexclude.ts";

/** Hidden unless you show hidden files: IDE and cache files nobody opens. */
export const DEFAULT_HIDDEN = [".idea", ".phpunit.cache", ".phpunit.result.cache"];
/** Shown dimmed, as PhpStorm marks excluded folders: dependencies and generated files. Local history skips them too. */
export const DEFAULT_EXCLUDED = ["vendor", "node_modules", "storage", ".claude", "dist", "build"];

const nameGlob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

/**
 * Whether a path relative to the project is in a list, or inside a folder in it. A pattern without `/`, such as
 * `node_modules` or `*.log`, matches a file or folder of that name at any depth; one with `/`, such as
 * `public/build` or `storage/**` , matches from the project's folder, with `*` and `**` as in index exclusions.
 */
export function listed(list: string[], rel: string) {
  const parts = rel.split("/");
  return list.some((p) => {
    const pattern = p.trim().replace(/^\/+|\/+$/g, "");
    if (!pattern) return false;
    if (pattern.includes("/")) return covers([pattern], rel);
    const re = nameGlob(pattern);
    return parts.some((part) => re.test(part));
  });
}

/** One pattern per line, without blanks, duplicates, or surrounding slashes. */
export const parseList = (text: string) => [...new Set(text.split("\n").map((l) => l.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean))];
