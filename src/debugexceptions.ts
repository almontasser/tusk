// Pure helpers for the debugger, kept apart from debug.ts so tests can load them without Monaco.
import { globToRegex } from "./editorconfig.ts";

/** Whether a file matches one of the patterns, such as vendor/**, matched against its path in the project. */
export function thrownIn(path: string, root: string, patterns: string[]): boolean {
  const rel = path.startsWith(root + "/") ? path.slice(root.length + 1) : path.replace(/^\//, "");
  return patterns.some((p) => globToRegex(p).test(rel));
}

/** The class named by PHP's fatal error for an exception nobody caught, such as `Fatal error: Uncaught App\Foo: message`. */
export const uncaughtClass = (text: string) => /^Fatal error: Uncaught ([\w\\]+)/.exec(text)?.[1];

/**
 * The first statement line of each method of Laravel's exception handler that renders an exception the app
 * didn't catch: `render` for HTTP, and `renderForConsole` for Artisan.
 */
export function handlerLines(source: string): number[] {
  const lines = source.split("\n");
  const found: number[] = [];
  lines.forEach((line, i) => {
    if (!/public function (render|renderForConsole)\(/.test(line)) return;
    let j = i;
    while (j < lines.length && !lines[j].includes("{")) j++;
    for (j++; j < lines.length && !lines[j].trim(); j++);
    if (j < lines.length) found.push(j + 1);
  });
  return found;
}

/** Whether an error from starting the listener means another program already listens on the port. */
export const portInUse = (text: string) => /EADDRINUSE|address already in use/i.test(text);

/**
 * The environment that makes PHP connect to the debugger: debug mode, the trigger with the IDE key, and the port
 * (and for PHP in a container, the host that reaches this Mac) in XDEBUG_CONFIG, which overrides php.ini.
 */
export function xdebugEnvFor(port: number, ideKey: string, clientHost?: string): string[] {
  const config = [`client_port=${port}`, clientHost && `client_host=${clientHost}`].filter(Boolean).join(" ");
  return ["XDEBUG_MODE=debug", `XDEBUG_SESSION=${ideKey.trim() || "1"}`, `XDEBUG_CONFIG=${config}`];
}

/** The `$name` typed just before the cursor, where it starts, and the names that complete it, sorted. Null when none do. */
export function completions(text: string, cursor: number, names: Iterable<string>): { start: number; matches: string[] } | null {
  const typed = /\$\w*$/.exec(text.slice(0, cursor));
  if (!typed) return null;
  const matches = [...new Set(names)].filter((n) => n.startsWith(typed[0]) && n !== typed[0]).sort();
  return matches.length ? { start: typed.index, matches } : null;
}

/**
 * Values to show at the end of lines while paused, as PhpStorm does: for the paused line and the lines above it in
 * the same function (up to its `function` line, or in code outside functions, up to the end of the last block
 * above, at most 50 lines), the variables each line mentions, in order.
 * `values` maps a name such as `$user` to its value; long values are cut to 50 characters.
 */
export function inlineValues(lines: string[], line: number, values: Map<string, string>): { line: number; text: string }[] {
  const result: { line: number; text: string }[] = [];
  for (let n = line; n >= 1 && n > line - 50; n--) {
    const text = lines[n - 1] ?? "";
    if (n < line && /^\}/.test(text)) break;
    const names = [...new Set(text.match(/\$\w+/g) ?? [])].filter((name) => values.has(name));
    if (names.length) result.unshift({ line: n, text: names.map((name) => `${name}: ${cut(values.get(name)!)}`).join(", ") });
    if (/\bfunction\b|\bfn\s*\(/.test(text)) break;
  }
  return result;
}

const cut = (value: string) => (value.length > 50 ? `${value.slice(0, 49)}…` : value);
