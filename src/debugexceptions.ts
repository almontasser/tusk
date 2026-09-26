// Pure helpers for pausing on exceptions, kept apart from debug.ts so tests can load them without Monaco.
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
