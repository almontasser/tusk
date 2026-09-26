// Paths that files name relative to their own folder: Markdown links and images, and a JSON file's `$schema`.

/** The file a link in a file in `dir` points to, or null for a URL or an anchor in the page. */
export function resolveLink(dir: string, href: string): string | null {
  if (!href || href.startsWith("#")) return null;
  const url = new URL(href, `file://${dir.split("/").map(encodeURIComponent).join("/")}/`);
  return url.protocol === "file:" ? decodeURIComponent(url.pathname) : null;
}

/** The local file a JSON document in `dir` names as its `$schema`, or null when it names a URL or nothing. */
export function localSchemaPath(text: string, dir: string): string | null {
  const m = /"\$schema"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
  if (!m) return null;
  try {
    return resolveLink(dir, JSON.parse(m[1]));
  } catch {
    return null;
  }
}
