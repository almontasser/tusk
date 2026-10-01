// The pure parts of Settings > Tools, free of editor imports so Node can test them.

export type Interpreter = { path: string; version: string };

/**
 * Where PHP interpreters usually are: on a Mac, Homebrew (both prefixes, each version), Herd, Herd Lite, MAMP, and
 * macOS's own; on Linux, the system's; the shims and installs of asdf, phpenv, and mise; and on Windows, Herd,
 * C:\php, Chocolatey, Laragon, XAMPP, and Scoop. A shell script (Git for Windows' sh on Windows, whose `cygpath`
 * writes each path the Windows way) prints `path<TAB>real path<TAB>version` for each that runs.
 */
export const FIND_INTERPRETERS = `for f in /opt/homebrew/bin/php /opt/homebrew/opt/php*/bin/php /usr/local/bin/php /usr/local/opt/php*/bin/php \
"$HOME/Library/Application Support/Herd/bin/"php* "$HOME/.config/herd-lite/bin/php" /Applications/MAMP/bin/php/php*/bin/php /usr/bin/php \
"$HOME/.asdf/shims/php" "$HOME/.phpenv/shims/php" "$HOME"/.phpenv/versions/*/bin/php "$HOME/.local/share/mise/shims/php" "$HOME"/.local/share/mise/installs/php/*/bin/php \
"$HOME"/.config/herd/bin/php*/php.exe /c/php*/php.exe /c/tools/php*/php.exe /c/laragon/bin/php/*/php.exe /c/xampp/php/php.exe "$HOME"/scoop/apps/php*/current/php.exe; do
  case "\${f##*/}" in php|php[0-9]*|php.exe) ;; *) continue ;; esac
  [ -x "$f" ] && [ ! -d "$f" ] || continue
  v=$("$f" -r 'echo PHP_VERSION;' 2>/dev/null) || continue
  printf '%s\\t%s\\t%s\\n' "$(cygpath -m "$f" 2>/dev/null || echo "$f")" "$(realpath "$f" 2>/dev/null || echo "$f")" "$v"
done; true`;

/** The script's output as interpreters, each real binary once, in the script's order. */
export function parseInterpreters(out: string): Interpreter[] {
  const seen = new Set<string>();
  const list: Interpreter[] = [];
  for (const line of out.split("\n")) {
    const [path, real, version] = line.split("\t");
    if (!path || !version || !/^\d+\.\d+/.test(version.trim()) || seen.has(real)) continue;
    seen.add(real);
    list.push({ path, version: version.trim() });
  }
  return list;
}

/** A program's `--version` output, shortened to its first line, without PHP's build details. */
export const versionLine = (out: string) =>
  (out.trim().split("\n")[0] ?? "")
    .replace(/\s*\(built:.*$/, "")
    .replace(/\s*\(cli\)$/, "")
    .trim();
