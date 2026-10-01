// Reads and edits a Laravel `.env` file as text, the way phpdotenv reads it: comments, order, quoting, and blank
// lines stay as written, a value changes in place, and a new key goes after others of its group (`MAIL_*` after
// `MAIL_*`). Also the small reads of config files the environment settings need. No editor imports, so Node tests it.

/** A key's assignment: the value as Laravel's `env()` reads it, and where its raw text is. */
export type EnvEntry = {
  key: string;
  /** The value without quotes or escapes, `${VAR}` references as written; null for `null` or `(null)`. */
  value: string | null;
  raw: string;
  quote: "" | '"' | "'";
  /** The raw value's range, and the end of its last line (before the newline). */
  start: number;
  end: number;
  lineEnd: number;
};

const ENTRY = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.]*)[ \t]*=[ \t]*/;
const COMMENTED = /^[ \t]*#[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.]*)[ \t]*=/;

/** Each line's start offset, and the key it assigns or has commented out. */
function scan(text: string) {
  const entries: EnvEntry[] = [];
  const commented: { key: string; lineEnd: number }[] = [];
  let at = 0;
  while (at <= text.length) {
    const nl = text.indexOf("\n", at);
    const line = text.slice(at, nl < 0 ? text.length : nl);
    const m = ENTRY.exec(line);
    let next = nl < 0 ? text.length + 1 : nl + 1;
    if (m) {
      const start = at + m[0].length;
      const q = text[start];
      let end: number;
      if (q === '"' || q === "'") {
        // A quoted value can span lines; a backslash escapes only inside double quotes.
        end = start + 1;
        while (end < text.length && text[end] !== q) end += q === '"' && text[end] === "\\" ? 2 : 1;
        end = Math.min(end + 1, text.length);
      } else {
        end = start;
        while (end < text.length && !/[\s#]/.test(text[end])) end++;
      }
      const lineEndAt = text.indexOf("\n", end);
      const lineEnd = lineEndAt < 0 ? text.length : lineEndAt;
      next = lineEnd + 1;
      const raw = text.slice(start, end);
      entries.push({ key: m[1], raw, quote: q === '"' || q === "'" ? q : "", value: decode(raw), start, end, lineEnd });
    } else {
      const c = COMMENTED.exec(line);
      if (c) commented.push({ key: c[1], lineEnd: at + line.length });
    }
    at = next;
  }
  return { entries, commented };
}

/** The assignments by key; a key assigned twice has its last value, as phpdotenv loads it. */
export function readEnv(text: string): Map<string, EnvEntry> {
  return new Map(scan(text).entries.map((e) => [e.key, e]));
}

/** The values by key, as `env()` returns strings: null for `null`. */
export const envValues = (text: string): Record<string, string | null> => Object.fromEntries([...readEnv(text)].map(([k, e]) => [k, e.value]));

/** A raw value without its quotes and escapes, or null for Laravel's `null`. */
export function decode(raw: string): string | null {
  let v = raw;
  if (raw.startsWith("'")) v = raw.slice(1, raw.endsWith("'") && raw.length > 1 ? -1 : undefined);
  else if (raw.startsWith('"'))
    v = raw.slice(1, raw.endsWith('"') && raw.length > 1 ? -1 : undefined).replace(/\\(.)/gs, (_, c: string) => ({ n: "\n", r: "\r", t: "\t", f: "\f", v: "\v" })[c] ?? c);
  return /^\(?null\)?$/i.test(v) ? null : v;
}

/**
 * A value as `.env` text. Plain values stay bare; values with spaces, `#`, quotes, or backslashes are double-quoted
 * with escapes. `${VAR}` is a reference, so it stays live, unless `literal` (for secrets), which escapes `$`.
 * `prefer` keeps the old quoting where it can hold the value, as with `MAIL_FROM_ADDRESS="hello@example.com"`.
 */
export function encode(value: string, { prefer = "", literal = false }: { prefer?: EnvEntry["quote"]; literal?: boolean } = {}): string {
  const dollar = literal && value.includes("$");
  if (prefer === "'" && !value.includes("'") && !value.includes("\n")) return `'${value}'`;
  if (!prefer && !dollar && /^[^\s\\'"#]*$/.test(value)) return value;
  if (literal && dollar && !/['\n]/.test(value)) return `'${value}'`;
  const body = value.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\n").replace(/\$/g, literal ? "\\$" : "$");
  return `"${body}"`;
}

/** Replaces `${VAR}` references with other keys' values, for showing what a value comes to. */
export const interpolate = (value: string, env: Record<string, string | null>) => value.replace(/\$\{([A-Za-z0-9_.]+)\}/g, (_, k: string) => env[k] ?? "");

/**
 * Sets a key to an encoded value. An assigned key changes in place. A new one goes after the line that has it
 * commented out, or else after the last key of its group (the name up to its first `_`), or else at the end.
 */
export function setEnv(text: string, key: string, encoded: string): string {
  const { entries, commented } = scan(text);
  const own = entries.filter((e) => e.key === key).pop();
  if (own) return text.slice(0, own.start) + encoded + text.slice(own.end);
  const group = key.split("_")[0] + "_";
  const after = commented.filter((c) => c.key === key).pop()?.lineEnd ?? entries.filter((e) => e.key.startsWith(group)).pop()?.lineEnd ?? commented.filter((c) => c.key.startsWith(group)).pop()?.lineEnd;
  const line = `${key}=${encoded}`;
  if (after !== undefined) return `${text.slice(0, after)}\n${line}${text.slice(after)}`;
  const body = text.replace(/\n*$/, "");
  return body ? `${body}\n\n${line}\n` : `${line}\n`;
}

/** Whether a key holds a secret, which is masked, kept out of messages, and left empty in `.env.example`. */
export const isSecret = (key: string) => /PASSWORD|SECRET|TOKEN|_KEY$|KEY_ID$|^APP_KEY$/.test(key);

/**
 * How `config/app.php` sets the time zone: from `env('APP_TIMEZONE', …)`, as a fixed string (Laravel 11 and later
 * write `'timezone' => 'UTC'`), or some other way (code).
 */
export function timezoneSource(appPhp: string): { kind: "env" } | { kind: "fixed"; value: string; start: number; end: number } | { kind: "code" } | null {
  const m = /(['"])timezone\1\s*=>\s*([^,\n]+)/.exec(appPhp);
  if (!m) return null;
  if (/\benv\(\s*['"]APP_TIMEZONE['"]/.test(m[2])) return { kind: "env" };
  const fixed = /^(['"])([^'"]*)\1\s*$/.exec(m[2]);
  if (!fixed) return { kind: "code" };
  const start = m.index + m[0].length - m[2].length;
  return { kind: "fixed", value: fixed[2], start, end: start + m[2].trimEnd().length };
}

/** `config/app.php` with a fixed time zone changed to read `APP_TIMEZONE`, keeping the old zone as the default. */
export function timezoneFromEnv(appPhp: string): string | null {
  const t = timezoneSource(appPhp);
  if (t?.kind !== "fixed") return null;
  return `${appPhp.slice(0, t.start)}env('APP_TIMEZONE', '${t.value}')${appPhp.slice(t.end)}`;
}

/** The `env()` keys an entry of a config array reads, such as `RESEND_KEY` for `resend` in `config/services.php`, or `AWS_BUCKET` for `s3` in `config/filesystems.php`. */
export function blockKeys(php: string, name: string): string[] {
  const m = new RegExp(`(['"])${name}\\1\\s*=>\\s*\\[([^\\]]*)\\]`).exec(php);
  return m ? [...m[2].matchAll(/\benv\(\s*['"]([A-Z0-9_]+)['"]/g)].map((x) => x[1]) : [];
}
