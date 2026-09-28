// Folders the PHP index and Mago skip, per project: vendor data that declares no symbols, such as AWS's API
// arrays and packages' translations. The list is the project's `indexExclude` value (projectstate.ts): in
// `tusk.json` when shared, so a team can commit it, or else on this Mac (read in lsp.ts). A project that never set it gets the defaults.

/** Folder patterns relative to the project; `*` matches within a folder name, `**` any number of folders. */
export const DEFAULT_EXCLUDES = [
  "vendor/aws/aws-sdk-php/src/data",
  "vendor/nesbot/carbon/src/Carbon/Lang",
  "vendor/voku/portable-ascii/src/voku/helper/data",
  "vendor/**/resources/lang",
  "vendor/**/resources/views",
];


/** Mago's `excludes` for the list. Mago matches a glob against file paths, so a folder glob needs `/**`. */
export const magoExcludes = (list: string[]) => list.map((p) => (p.includes("*") ? `${p}/**` : p));

/** Whether a folder, relative to the project, is inside one the list excludes. */
export function covers(list: string[], rel: string) {
  return list.some((p) => {
    const re = p
      .split("/")
      .map((part) => (part === "**" ? "\0" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")))
      .join("/")
      .replace(/\0\//g, "(?:[^/]+/)*")
      .replace(/\/\0$/, "(?:/[^/]+)*");
    return new RegExp(`^${re}(?:/.*)?$`).test(rel);
  });
}
