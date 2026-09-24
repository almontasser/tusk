// Context for AI completion: code from other files that helps the model complete the current one.
// Free of editor imports so Node can test it.
import { componentClassPath, nameResolver, parseTypeDeclaration, withoutComments } from "./phptypes.ts";
import { pathsFor, type Psr4 } from "./psr4.ts";
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

/** The project as AI completion knows it. */
export type Index = {
  psr4: Psr4;
  /** Source files by path relative to the root, with their chunks for similarity search. */
  files: Map<string, { text: string; chunks: Chunk[] }>;
  /** Eloquent models by class. */
  models: Record<string, ModelFacts>;
  /** A file's outline, from its unsaved text when it's open. */
  outline: (rel: string) => string;
};
/** Code the user worked on: the lines from `start` (0-based) of a file, by path relative to the root. */
export type Recent = { path: string; start: number; text: string };
export type Extra = { filename: string; text: string };

/** The files AI completion indexes: source files, outside dependencies, caches, and build output. */
export const INDEXED = /\.(php|js|jsx|ts|tsx|vue)$/;
export const SKIPPED = /^(vendor|node_modules|storage|public|bootstrap\/cache)\//;
// ponytail: the first 3,000 source files; a bigger project leaves the rest out of similarity search.
export const MAX_FILES = 3000;

/** Characters of each kind of context: about 4,000 tokens in all. */
export const BUDGET = { definitions: 7000, recent: 3000, similar: 3500 };

/**
 * The `n` chunks of the project most like the 20 lines before `line` (1-based) in the file `rel`,
 * whose current text is `source`. Its chunks near the cursor are in the prompt already, so they're left out.
 */
export function similarCode(index: Index, rel: string, source: string, line: number, n = 5): Chunk[] {
  const query = words(source.split("\n").slice(Math.max(0, line - 20), line).join("\n"));
  const inPrompt = (c: Chunk) => c.path === rel && c.start < line + 40 && c.start + c.lines > line - 150;
  const all = function* () {
    for (const [f, e] of index.files) if (f !== rel) yield* e.chunks;
    yield* chunk(rel, source);
  };
  return similar(all(), query, n, inPrompt);
}

/** The name Laravel knows a Blade view by: resources/views/posts/show.blade.php is posts.show. */
export function viewName(rel: string): string | null {
  return rel.match(/^resources\/views\/(.+)\.blade\.php$/)?.[1].replaceAll("/", ".") ?? null;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Code that renders a Blade view: the file, the match's offset in it, and the lines around the match. */
export type Caller = { path: string; offset: number; text: string };

/**
 * The places that render the Blade view `rel`, up to `max`: code that names the view in quotes, such as
 * `view('posts.show', compact('post'))` or `@include('posts.show')`, and `<x-…>` tags for a component.
 * Each comes with the 12 lines before the match and 8 after it, where the view's variables are passed.
 */
export function viewCallers(index: Index, rel: string, max = 3): Caller[] {
  const name = viewName(rel);
  if (!name) return [];
  const pattern = new RegExp(
    `(['"])${escapeRegex(name)}\\1` + (name.startsWith("components.") ? `|<x-${escapeRegex(name.slice("components.".length))}(?![\\w.-])` : ""),
  );
  const out: Caller[] = [];
  for (const [path, { text }] of index.files) {
    const m = path === rel ? null : pattern.exec(text);
    if (!m) continue;
    const line = text.slice(0, m.index).split("\n").length - 1;
    out.push({ path, offset: m.index, text: text.split("\n").slice(Math.max(0, line - 12), line + 9).join("\n") });
    if (out.length === max) break;
  }
  return out;
}

/**
 * Names just before `->` in the 30 lines before `offset`, nearest first: variables such as `$post`
 * and properties such as `author` in `$post->author->`. A language server can say what type each is.
 */
export function typedNames(source: string, offset: number, max = 6): { name: string; offset: number }[] {
  let start = offset;
  for (let i = 0; i < 30 && start > 0; i++) start = source.lastIndexOf("\n", start - 1);
  const nearest = new Map<string, number>();
  for (const m of source.slice(Math.max(0, start), offset).matchAll(/(\$?\w+)\??->/g)) if (m[1] !== "$this") nearest.set(m[1], Math.max(0, start) + m.index!);
  return [...nearest].sort((a, b) => b[1] - a[1]).slice(0, max).map(([name, at]) => ({ name, offset: at }));
}

/**
 * The extra files for a request, most stable first so the server can reuse its processed prompt:
 * outlines of the project classes used near the cursor (at `offset`), with the models' columns;
 * code from other files the user worked on lately; and code like the lines before the cursor.
 * `types` are classes a language server found for the names before `->` near the cursor. A Blade
 * view also gets the code that renders it, and the classes used there, since that's where its
 * variables come from.
 */
export function buildContext(index: Index, rel: string, source: string, offset: number, recent: Recent[], like: Chunk[], types: string[] = []): Extra[] {
  const callers = rel.endsWith(".blade.php") ? viewCallers(index, rel) : [];
  const sources = [
    ...(rel.endsWith(".php") ? [{ path: rel, text: source, offset }] : []),
    ...callers.map((c) => ({ path: c.path, text: index.files.get(c.path)!.text, offset: c.offset })),
  ];
  const fileOf = (fqn: string) => pathsFor(fqn, index.psr4).find((f) => f !== rel && index.files.has(f));
  const used = [...new Set([...types, ...sources.flatMap((s) => (s.path.endsWith(".blade.php") && s.path !== rel ? [] : referencedClasses(s.text, s.offset)))])]
    .flatMap((fqn) => {
      const file = fileOf(fqn);
      return file ? [{ fqn, file }] : [];
    })
    .slice(0, 8);
  // Classes that own the view: a component's class, and the classes that render it (Livewire components, mailables, controllers).
  const component = viewName(rel)?.startsWith("components.") ? componentClassPath(`x-${viewName(rel)!.slice("components.".length)}`) : null;
  const owners = [component, ...callers.map((c) => c.path)].filter((f): f is string => !!f && f.startsWith("app/") && !f.endsWith(".blade.php") && index.files.has(f));
  const outlined = [...new Set([...used.map((u) => u.file), ...owners])].sort();
  const own = rel.endsWith(".php") ? parseTypeDeclaration(source)?.fqn : undefined;
  const docs = [...new Set([...(own ? [own] : []), ...used.map((u) => u.fqn)])].filter((c) => index.models[c]).map((c) => modelDoc(index.models[c]));

  const definitions: Extra[] = [];
  if (docs.length) definitions.push({ filename: "_ide_helper_models.php", text: `<?php\n\n${docs.join("\n\n")}\n` });
  // In a fixed order, so moving the cursor changes the prompt only when the set of classes changes.
  definitions.push(...outlined.map((file) => ({ filename: file, text: `<?php\n\n${index.outline(file)}\n` })));
  // The code around each call, even when its class is outlined: the outline drops the method body that passes the variables.
  definitions.push(...callers.map((c) => ({ filename: c.path, text: c.text + "\n" })));
  const worked = recent.filter((r) => r.path !== rel).map((r) => ({ filename: r.path, text: r.text + "\n" }));
  // Files already outlined and code already sent as recent are left out, so the budget goes to other code.
  const sent = (c: Chunk) =>
    definitions.some((d) => d.filename === c.path) || recent.some((r) => r.path === c.path && r.start < c.start + c.lines && c.start < r.start + 30);
  const similarParts = like.filter((c) => !sent(c)).map((c) => ({ filename: c.path, text: c.text + "\n" }));
  return [...pack(definitions, BUDGET.definitions), ...pack(worked, BUDGET.recent), ...pack(similarParts, BUDGET.similar)];
}

/**
 * The body of an /infill request for the cursor at `line` and `column` (1-based): 150 lines before
 * it, and the rest of its line plus 40 lines after it. With `predict` 0 the server only processes
 * the prompt, to have it ready.
 */
export function infillRequest(lines: string[], line: number, column: number, extra: Extra[], predict: number) {
  const current = lines[line - 1];
  const before = lines.slice(Math.max(0, line - 151), line - 1);
  return {
    input_prefix: before.length ? before.join("\n") + "\n" : "",
    prompt: current.slice(0, column - 1),
    input_suffix: [current.slice(column - 1), ...lines.slice(line, line + 40)].join("\n"),
    input_extra: extra,
    // Stops at a line indented less than this one, so a suggestion stays inside its block.
    n_indent: current.match(/^\s*/)![0].length,
    n_predict: predict,
    // Greedy: the most likely token every time. It scored 4 points higher than sampling in
    // scripts/ai-bench.ts, and the same prompt always gives the same suggestion.
    samplers: ["top_k"],
    top_k: 1,
    cache_prompt: true,
    t_max_predict_ms: 1500,
    response_fields: ["content"],
  };
}

/**
 * A suggestion without the code that already follows it. Small models often go on to repeat the
 * lines below the cursor, so the suggestion ends before a line equal to the next non-blank line
 * there. Empty when nothing new is left.
 */
export function cleanSuggestion(text: string, after: string, below: string[]): string {
  let lines = text.replace(/\s+$/, "").split("\n");
  const next = below.find((l) => l.trim())?.trim();
  const repeat = lines.findIndex((l, i) => i > 0 && l.trim() === next);
  if (repeat > 0) lines = lines.slice(0, repeat);
  const out = lines.join("\n").replace(/\s+$/, "");
  return out.trim() && out.trim() !== after.trim() ? out : "";
}

/**
 * How much of the text after the cursor a suggestion replaces: all of it when the suggestion's last
 * line (where that text would end up) contains it, as when the editor already closed a bracket or
 * `{{ }}` that the suggestion closes too; otherwise none.
 */
export function replacedAfter(suggestion: string, after: string): number {
  const rest = after.trim();
  return rest && suggestion.split("\n").at(-1)!.includes(rest) ? after.trimEnd().length : 0;
}
