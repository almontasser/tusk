// The app's translations, for the designers: the strings in lang/<locale>.json and lang/<locale>/*.php, what a
// `__('key')` shows in each language, and edits to those files. New translations go to the JSON files, which
// Laravel reads first for any key; a value that's in a PHP file is changed there. No editor imports, so Node tests
// the text helpers.

export type Translations = {
  /** The lang folder, absolute. */
  dir: string;
  locale: string;
  fallback: string;
  locales: string[];
  json: Record<string, Record<string, string>>;
  /** PHP files' strings by locale, with keys as `file.key.nested`. */
  php: Record<string, Record<string, string>>;
};

/** Languages written right to left, whose preview flips. */
const RTL = new Set(["ar", "he", "fa", "ur", "ps", "sd", "ug", "yi", "dv", "ckb", "ku"]);
export const isRtl = (locale: string | null | undefined) => !!locale && RTL.has(locale.split(/[-_]/)[0].toLowerCase());

/** The translation of a key in a locale, from its own files; undefined when it has none. */
export const ownTranslation = (t: Translations, locale: string, key: string): string | undefined => t.json[locale]?.[key] ?? t.php[locale]?.[key];

/** What `__('key')` shows in a locale: its translation, the fallback locale's, or the key itself. */
export function translate(t: Translations, locale: string, key: string): { text: string; missing: boolean } {
  const own = ownTranslation(t, locale, key);
  if (own !== undefined) return { text: own, missing: false };
  const fallback = locale !== t.fallback ? ownTranslation(t, t.fallback, key) : undefined;
  return { text: fallback ?? key, missing: true };
}

/** JSON as the file wrote it: its indentation, and `\u` escapes and escaped slashes when it used them, as PHP's json_encode does. */
function formatLike(text: string, data: Record<string, string>): string {
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "    ";
  let out = JSON.stringify(data, null, indent);
  if (/\\u[0-9a-fA-F]{4}/.test(text)) out = out.replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  if (text.includes("\\/")) out = out.replace(/\//g, "\\/");
  return `${out}\n`;
}

/** The JSON file's text with a key set, or removed when `value` is null, keeping the order and indentation. */
export function setJsonKey(text: string, key: string, value: string | null): string {
  const data: Record<string, string> = text.trim() ? JSON.parse(text) : {};
  if (value === null) delete data[key];
  else data[key] = value;
  return formatLike(text, data);
}

/** The JSON file's text with a key renamed, in place, when it's there. */
export function renameJsonKey(text: string, from: string, to: string): string | null {
  const data: Record<string, string> = text.trim() ? JSON.parse(text) : {};
  if (!(from in data) || to in data) return null;
  return formatLike(text, Object.fromEntries(Object.entries(data).map(([k, v]) => [k === from ? to : k, v])));
}

const phpQuote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/**
 * A PHP lang file's text with the value of `path` (the key after the file's name, such as `fields.status`)
 * changed, when the file has exactly one string entry for the path's last part. Null when it can't tell which.
 */
export function setPhpValue(text: string, path: string, value: string): string | null {
  const last = path.split(".").pop()!;
  const key = `(?:'${last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'|"${last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}")`;
  const re = new RegExp(`(${key}\\s*=>\\s*)('(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\$]|\\\\.)*")`, "g");
  const found = [...text.matchAll(re)];
  if (found.length !== 1) return null;
  const m = found[0];
  const start = m.index! + m[1].length;
  return text.slice(0, start) + phpQuote(value) + text.slice(start + m[2].length);
}

/** Where a translation of `key` in `locale` is written: the PHP file that has it, or the locale's JSON file. */
export function fileFor(t: Translations, locale: string, key: string): { kind: "php"; path: string; inFile: string } | { kind: "json"; path: string } {
  if (t.json[locale]?.[key] === undefined && t.php[locale]?.[key] !== undefined) {
    const [file, ...rest] = key.split(".");
    return { kind: "php", path: `${t.dir}/${locale}/${file}.php`, inFile: rest.join(".") };
  }
  return { kind: "json", path: `${t.dir}/${locale}.json` };
}
