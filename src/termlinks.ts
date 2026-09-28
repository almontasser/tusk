// File references in terminal output, such as `app/Models/User.php:42`, which open in the editor when clicked.

/** A file reference in a line of output: where it is in the line (`start` inclusive, `end` exclusive), and what it names. */
export type FileLink = { start: number; end: number; path: string; line: number; column?: number };

// A path with a file extension, then a line in one of the forms tools print it:
//   app/Foo.php:12  app/Foo.php:12:5  /var/www/html/app/Foo.php(12)  Foo.php on line 12  Foo.php line 12
const PATTERN = /((?:~|\.{1,2})?\/?(?:[\w.@-]+\/)*[\w.@-]*\w\.[A-Za-z][\w]*)(?::(\d+)(?::(\d+))?|\((\d+)\)| on line (\d+)|, line (\d+))/g;

/** The file references in one line of terminal output. URLs are left to the web-links addon. */
export function fileLinks(text: string): FileLink[] {
  const links: FileLink[] = [];
  for (const m of text.matchAll(PATTERN)) {
    const start = m.index;
    // Part of a URL, such as http://localhost:8000/index.php:12, or a host and port, such as example.com:443.
    if (/[a-z][\w+.-]*:\/\/\S*$/i.test(text.slice(0, start)) || (/^[\w-]+(\.[\w-]+)+$/.test(m[1]) && !m[1].includes("/") && /^(com|org|net|io|dev|test|local|localhost)$/i.test(m[1].split(".").pop()!))) continue;
    const line = Number(m[2] ?? m[4] ?? m[5] ?? m[6]);
    if (!line) continue;
    links.push({ start, end: start + m[0].length, path: m[1], line, column: m[3] ? Number(m[3]) : undefined });
  }
  return links;
}

/**
 * The local paths a reference may mean, most likely first. A path in the Sail or Docker container, under
 * `containerRoot`, maps to the project; a relative path is tried from the terminal's folder, then the project's.
 */
export function candidatePaths(path: string, cwd: string, root: string, containerRoot: string): string[] {
  if (path.startsWith(`${containerRoot}/`)) return [normalize(root + path.slice(containerRoot.length))];
  if (path.startsWith("/")) return [normalize(path)];
  return [...new Set([normalize(`${cwd}/${path}`), normalize(`${root}/${path}`)])];
}

/** An absolute path without `.` and `..` segments. */
function normalize(path: string) {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
}
