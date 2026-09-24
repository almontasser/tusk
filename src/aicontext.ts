// Context for AI completion: code from other files that helps the model complete the current one.
// Free of editor imports so Node can test it.
import { nameResolver, withoutComments } from "./phptypes.ts";
import { matchBracket } from "./refactorparse.ts";

/**
 * A PHP file reduced to what callers need: declarations, properties, constants, docblocks, and
 * method signatures, with each method body replaced by `{ … }`. Imports are dropped. Cut at
 * `max` characters, at a line break.
 * ponytail: brackets inside heredocs aren't skipped; a heredoc with an odd brace ends the outline early.
 */
export function outline(source: string, max = 2500): string {
  // Brackets are matched in the source with comments blanked out (same offsets), so an apostrophe in a comment is harmless.
  const code = withoutComments(source);
  const fn = /\bfunction\s+&?\w+\s*\(/g;
  let out = "";
  let from = 0;
  for (let m; (m = fn.exec(code)); ) {
    const close = matchBracket(code, m.index + m[0].length - 1);
    if (close < 0) break;
    const brace = code.slice(close + 1).search(/[{;]/);
    if (brace < 0) break;
    const open = close + 1 + brace;
    if (code[open] === ";") continue; // Abstract or interface method: no body.
    const end = matchBracket(code, open);
    if (end < 0) break;
    out += source.slice(from, open) + "{ … }";
    from = fn.lastIndex = end + 1;
  }
  out += source.slice(from);
  out = out
    .replace(/^<\?php\s*/, "")
    .replace(/^use\s+[^;]+;[ \t]*\n?/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out.length > max ? out.slice(0, out.lastIndexOf("\n", max)) + "\n    // …" : out;
}

/**
 * Full names of the classes a PHP file refers to, nearest to `offset` first: names used in the
 * code, resolved through the file's imports and namespace. Names that aren't classes (constants,
 * say) come through too; callers keep only names that have a file.
 */
export function referencedClasses(source: string, offset: number): string[] {
  const code = withoutComments(source)
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, (m) => " ".repeat(m.length))
    // The namespace and imports hold full names already; the uses elsewhere count. Trait uses are indented and stay.
    .replace(/^(namespace|use)\s[^;]*;/gm, (m) => " ".repeat(m.length));
  const { resolve } = nameResolver(withoutComments(source));
  const distance = new Map<string, number>();
  for (const m of code.matchAll(/(?<![\w\\$>:])\\?[A-Z]\w*(?:\\\w+)*(?![\w\\])/g)) {
    const fqn = resolve(m[0]);
    const d = Math.abs(m.index! - offset);
    if (d < (distance.get(fqn) ?? Infinity)) distance.set(fqn, d);
  }
  return [...distance].sort((a, b) => a[1] - b[1]).map(([fqn]) => fqn);
}

/** Words of three or more characters, for comparing code. */
export const words = (text: string) => new Set(text.match(/[A-Za-z_$][\w$]{2,}/g) ?? []);

/** Shared words over all words. */
export function jaccard(a: Set<string>, b: Set<string>) {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared || 1);
}

export type Chunk = { path: string; /** 0-based first line. */ start: number; lines: number; text: string; words: Set<string> };

/** Overlapping windows of `size` lines, every `stride` lines. Windows with fewer than 3 non-blank lines are left out. */
export function chunk(path: string, text: string, size = 30, stride = 15): Chunk[] {
  const lines = text.split("\n");
  const out: Chunk[] = [];
  for (let start = 0; start < lines.length; start += stride) {
    const part = lines.slice(start, start + size);
    if (part.filter((l) => l.trim()).length >= 3) {
      const text = part.join("\n");
      out.push({ path, start, lines: part.length, text, words: words(text) });
    }
    if (start + size >= lines.length) break;
  }
  return out;
}

/** The `n` chunks most like `query`, best first, no two of them overlapping. `skip` leaves chunks out. */
export function similar(chunks: Iterable<Chunk>, query: Set<string>, n: number, skip: (c: Chunk) => boolean = () => false, min = 0.1): Chunk[] {
  const scored: [Chunk, number][] = [];
  for (const c of chunks) {
    if (skip(c)) continue;
    const score = jaccard(query, c.words);
    if (score >= min) scored.push([c, score]);
  }
  const picked: Chunk[] = [];
  for (const [c] of scored.sort((a, b) => b[1] - a[1])) {
    if (picked.some((p) => p.path === c.path && p.start < c.start + c.lines && c.start < p.start + p.lines)) continue;
    picked.push(c);
    if (picked.length === n) break;
  }
  return picked;
}

export type ModelFacts = {
  class: string;
  table?: string;
  /** Column name to its database type and whether it can be null. */
  columns: Record<string, { type: string; nullable: boolean } | null>;
  casts: Record<string, string>;
  relations: { name: string; type: string; related: string | null }[];
};

const MANY = /Many|MorphToMany/;

/** The PHP type of a column: from its cast if it has one, or else from its database type. */
export function columnType(cast: string | undefined, dbType: string | undefined): string {
  const t = (cast ?? "").toLowerCase();
  if (/^(bool|boolean)$/.test(t)) return "bool";
  if (/^(int|integer|timestamp)$/.test(t)) return "int";
  if (/^(float|double|real)$/.test(t)) return "float";
  if (/^(decimal|string|hashed|encrypted)\b/.test(t)) return "string";
  if (/^(array|json)$/.test(t)) return "array";
  if (/^(collection)$/.test(t)) return "\\Illuminate\\Support\\Collection";
  if (/date|time/.test(t)) return "\\Illuminate\\Support\\Carbon";
  if (cast && /\\/.test(cast)) return `\\${cast.replace(/^\\/, "").split(":")[0]}`; // An enum or cast class.
  const d = (dbType ?? "").toLowerCase();
  if (/bool|tinyint/.test(d)) return "bool"; // Laravel's boolean() is a tinyint in MySQL and SQLite.
  if (/int/.test(d)) return "int";
  if (/float|double|real/.test(d)) return "float";
  if (/date|time/.test(d)) return "\\Illuminate\\Support\\Carbon";
  if (/json/.test(d)) return "array";
  if (d) return "string";
  return "mixed";
}

/** A model's columns and relationships as a docblock, the way ide-helper writes them. */
export function modelDoc(m: ModelFacts): string {
  const short = m.class.split("\\").pop();
  const lines = Object.entries(m.columns).map(([name, col]) => {
    const type = columnType(m.casts[name], col?.type);
    return ` * @property ${type}${col?.nullable ? "|null" : ""} $${name}`;
  });
  for (const r of m.relations) {
    const related = r.related ? `\\${r.related}` : "\\Illuminate\\Database\\Eloquent\\Model";
    const type = MANY.test(r.type) ? `\\Illuminate\\Database\\Eloquent\\Collection<int, ${related}>` : `${related}|null`;
    lines.push(` * @property-read ${type} $${r.name} (${r.type})`);
  }
  return `/**\n * ${short}${m.table ? `, table ${m.table}` : ""}\n *\n${lines.join("\n")}\n */\nclass ${short}`;
}

/** The parts that fit in `budget` characters, in order. */
export function pack<T extends { text: string }>(parts: T[], budget: number): T[] {
  const out: T[] = [];
  for (const p of parts) {
    if (p.text.length > budget) continue;
    budget -= p.text.length;
    out.push(p);
  }
  return out;
}
