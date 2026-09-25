// Measures AI completion on a real project. It hides code in the project's PHP files, asks the model to
// fill it in with each kind of context, and scores the first line of each suggestion. It builds
// prompts with the editor's own code (src/aicontext.ts), so a score change means a real change.
//
//   node scripts/ai-bench.ts <project> <model.gguf> [cases] [configs] [task]
//
// `task` is `line` (the default: complete one line) or `block`: complete the rest of a block, 2 to 8
// lines, from the start of a line. A block run asks once per case with full context, then scores
// ways of ending a multi-line suggestion on the same replies, so it compares them at no extra cost.
//
// `configs` is a comma-separated subset of: none, defs, full, wide, types (default: none, defs, full,
// types). `wide` is full context with twice the budget for definitions and similar code. `types` is
// full context plus the classes of the names before `->` near the cursor, from Phpactor's command
// line, as the editor gets them from Phpactor. For a project without vendor/, build Phpactor's index
// first: php src-tauri/resources/tools/phpactor.phar index:build --working-dir=<project>
// Recent code isn't measured: a benchmark has no history of where the user worked.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { BUDGET, buildContext, chunk, leastLikely, typedNames, cleanSuggestion, type Extra, INDEXED, type Index, infillRequest, MAX_FILES, type ModelFacts, outline, SKIPPED, similarCode } from "../src/aicontext.ts";
import { psr4From } from "../src/psr4.ts";

const [root, modelPath, count = "80", only = "none,defs,full,types", task = "line"] = process.argv.slice(2);
if (!root || !modelPath) throw new Error("Usage: node scripts/ai-bench.ts <project> <model.gguf> [cases] [configs]");
const tools = new URL("../src-tauri/resources/tools/", import.meta.url).pathname;

// ---- The project, indexed as the editor indexes it ----
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((f) => INDEXED.test(f) && !SKIPPED.test(f))
  .slice(0, MAX_FILES);
const texts = new Map(files.map((f) => [f, readFileSync(`${root}/${f}`, "utf8")] as const));
let models: Record<string, ModelFacts> = {};
if (existsSync(`${root}/vendor/autoload.php`)) {
  const out = JSON.parse(execFileSync("php", [new URL("../filament-lsp/introspect.php", import.meta.url).pathname, root, "models"], { encoding: "utf8" }));
  if (!out.error) models = out;
}
const index: Index = {
  psr4: psr4From(existsSync(`${root}/composer.json`) ? readFileSync(`${root}/composer.json`, "utf8") : "{}"),
  files: new Map([...texts].map(([f, text]) => [f, { text, chunks: chunk(f, text) }])),
  models,
  outline: (rel) => outline(texts.get(rel) ?? ""),
};

// ---- Cases: code inside method bodies of PHP classes under app/ ----
let seed = 1;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31);
type Case = { file: string; line: number; column: number; expected: string };
const candidates: Case[] = [];
for (const [file, text] of texts) {
  if (!file.startsWith("app/") || !file.endsWith(".php")) continue;
  text.split("\n").forEach((l, i) => {
    const code = l.trim();
    if (l.search(/\S/) < 8 || code.length < 10 || /^(\/\/|\*|\/\*|#|[{}()\[\];,]+$)/.test(code)) return;
    // Either the whole line from its indentation, or the rest of it after a boundary a developer would pause at.
    const indent = l.search(/\S/);
    const boundaries = [...l.matchAll(/->|::|\(|= |, |\[/g)].map((m) => m.index! + m[0].length).filter((b) => b > indent + 3 && b < l.trimEnd().length);
    const cut = boundaries.length && random() < 0.5 ? boundaries[Math.floor(random() * boundaries.length)] : indent;
    candidates.push({ file, line: i + 1, column: cut + 1, expected: l.slice(cut).trimEnd() });
  });
}
for (let i = candidates.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
}
const cases = candidates.slice(0, Number(count));

// ---- The server, started as ai_start in src-tauri/src/lsp.rs starts it ----
const port = 18000 + Math.floor(Math.random() * 1000);
// LLAMA_ARGS adds options to try, such as speculative decoding: LLAMA_ARGS="--spec-type ngram-simple".
const server = spawn(
  `${tools}llama/llama-server`,
  ["-m", modelPath, "--host", "127.0.0.1", "--port", String(port), "-ngl", "99", "-c", "8192", "-np", "1", "-b", "2048", "-ub", "1024", "--cache-reuse", "256", ...(process.env.LLAMA_ARGS?.split(" ").filter(Boolean) ?? [])],
  { stdio: "ignore" },
);
process.on("exit", () => server.kill());
for (let i = 0; ; i++) {
  if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)) break;
  if (i > 120) throw new Error("llama-server didn't start");
  await new Promise((r) => setTimeout(r, 500));
}

async function ask(body: object) {
  const start = performance.now();
  const reply = await fetch(`http://127.0.0.1:${port}/infill`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
  const probs = ((reply.completion_probabilities ?? []) as { token: string; logprob: number }[]).map((p) => ({ token: p.token, p: Math.exp(p.logprob) }));
  return { text: (reply.content as string) ?? "", ms: performance.now() - start, probs };
}

// ---- Blocks: the rest of a block from the start of a line, to compare where suggestions should end ----
if (task === "block") {
  type Block = { file: string; line: number; hidden: string[] };
  const blocks: Block[] = [];
  for (const [file, text] of texts) {
    if (!file.startsWith("app/") || !file.endsWith(".php")) continue;
    const lines = text.split("\n");
    lines.forEach((l, i) => {
      const indent = l.search(/\S/);
      if (indent < 8 || l.trim().length < 10 || /^(\/\/|\*|\/\*|#|[{}()\[\];,]+$)/.test(l.trim())) return;
      // The block goes on while lines are blank or indented at least as much.
      let end = i;
      while (end + 1 < lines.length && end - i < 7 && (!lines[end + 1].trim() || lines[end + 1].search(/\S/) >= indent)) end++;
      while (end > i && !lines[end].trim()) end--;
      if (end > i) blocks.push({ file, line: i + 1, hidden: lines.slice(i, end + 1) });
    });
  }
  for (let i = blocks.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
  }
  /** Ways of ending a suggestion: each takes the cleaned lines and each line's least likely token. */
  const policies: Record<string, (lines: string[], least: number[]) => string[]> = {
    "as is": (lines) => lines,
    "first line only": (lines) => lines.slice(0, 1),
    "up to 3 lines": (lines) => lines.slice(0, 3),
    "stop at a blank line": (lines) => {
      const blank = lines.findIndex((l) => !l.trim());
      return blank > 0 ? lines.slice(0, blank) : lines;
    },
    ...Object.fromEntries(
      [0.3, 0.5, 0.7].map((t) => [
        `stop before a line with a token under ${t}`,
        (lines: string[], least: number[]) => {
          const unsure = least.findIndex((p, i) => i > 0 && p < t);
          return unsure > 0 ? lines.slice(0, unsure) : lines;
        },
      ]),
    ),
    ...Object.fromEntries(
      [0.2, 0.35].map((h) => [
        `under 0.5, and nothing when the first line has a token under ${h}`,
        (lines: string[], least: number[]) => {
          if ((least[0] ?? 1) < h) return [];
          const unsure = least.findIndex((p, i) => i > 0 && p < 0.5);
          return unsure > 0 ? lines.slice(0, unsure) : lines;
        },
      ]),
    ),
  };
  const totals = Object.fromEntries(Object.keys(policies).map((k) => [k, { correct: 0, wrong: 0, unsafe: 0, whole: 0, shown: 0 }]));
  const picked = blocks.slice(0, Number(count));
  for (const [n, b] of picked.entries()) {
    const lines = texts.get(b.file)!.split("\n");
    const indent = b.hidden[0].match(/^\s*/)![0];
    lines.splice(b.line - 1, b.hidden.length, indent);
    const source = lines.join("\n");
    const offset = lines.slice(0, b.line - 1).reduce((sum, l) => sum + l.length + 1, 0) + indent.length;
    const extra = buildContext(index, b.file, source, offset, [], similarCode(index, b.file, source, b.line));
    const { text, probs } = await ask({ ...infillRequest(lines, b.line, indent.length + 1, extra, 128) });
    const least = leastLikely(text, probs);
    const cleaned = cleanSuggestion(text, "", lines.slice(b.line, b.line + 10)).split("\n");
    const expected = b.hidden.map((l, i) => (i === 0 ? l.slice(indent.length) : l).trimEnd());
    for (const [name, policy] of Object.entries(policies)) {
      const got = cleaned[0] ? policy(cleaned, least).map((l) => l.trimEnd()) : [];
      const t = totals[name];
      if (!got.length) continue;
      t.shown++;
      let correct = 0;
      while (correct < got.length && got[correct] === expected[correct]) correct++;
      t.correct += correct;
      t.wrong += got.length - correct;
      if (correct < got.length) t.unsafe++;
      if (got.join("\n") === expected.join("\n")) t.whole++;
    }
    process.stderr.write(`\r${n + 1}/${picked.length}`);
  }
  const pct = (x: number) => `${((100 * x) / picked.length).toFixed(1)}%`;
  console.log(`\n${root}: ${picked.length} blocks of 2 to 8 lines, ${modelPath.split("/").pop()}\n`);
  console.log("| Where a suggestion ends | Suggestions shown | Right lines per case | Wrong lines per case | Cases with a wrong line | Whole block right |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const [name, t] of Object.entries(totals)) {
    console.log(`| ${name} | ${pct(t.shown)} | ${(t.correct / picked.length).toFixed(2)} | ${(t.wrong / picked.length).toFixed(2)} | ${pct(t.unsafe)} | ${pct(t.whole)} |`);
  }
  server.kill();
  process.exit(0);
}

function editSimilarity(a: string, b: string) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return 1 - d[b.length] / Math.max(a.length, b.length, 1);
}

/** Classes in the type Phpactor reports for the name at `offset` in a file on disk; the editor asks the language server instead. */
const typeCache = new Map<string, string[]>();
function typeAt(file: string, offset: number) {
  const key = `${file}:${offset}`;
  if (!typeCache.has(key)) {
    const out = (() => {
      try {
        return execFileSync("php", [`${tools}phpactor.phar`, "offset:info", `${root}/${file}`, String(offset + 1), `--working-dir=${root}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        return "";
      }
    })();
    typeCache.set(key, out.match(/^type:(.*)$/m)?.[1].match(/[A-Z]\w*(?:\\\w+)+/g) ?? []);
  }
  return typeCache.get(key)!;
}

// ---- Run ----
const configs = only.split(",");
type Score = { exactShownAll: number; exact: number; similarity: number; empty: number; repeats: number; ms: number[]; typing: number[]; tokens: number[] };
/** Cases where the Phpactor types changed the context, and exact matches in them with and without the types. */
const typed = { cases: 0, full: 0, types: 0 };
const scores = Object.fromEntries(configs.map((c) => [c, { exactShownAll: 0, exact: 0, similarity: 0, empty: 0, repeats: 0, ms: [], typing: [], tokens: [] } as Score]));

for (const [n, c] of cases.entries()) {
  const lines = texts.get(c.file)!.split("\n");
  lines[c.line - 1] = lines[c.line - 1].slice(0, c.column - 1);
  const source = lines.join("\n");
  const offset = lines.slice(0, c.line - 1).reduce((sum, l) => sum + l.length + 1, 0) + c.column - 1;
  const like = similarCode(index, c.file, source, c.line);
  const extra: Record<string, Extra[]> = {
    none: [],
    defs: buildContext(index, c.file, source, offset, [], []),
    full: buildContext(index, c.file, source, offset, [], like),
  };
  if (configs.includes("types")) {
    // The names come before the cursor, so their offsets are the same in the file on disk.
    const found = typedNames(source, offset).flatMap((n) => typeAt(c.file, n.offset));
    extra.types = buildContext(index, c.file, source, offset, [], like, [...new Set(found)]);
  }
  const budget = { ...BUDGET };
  Object.assign(BUDGET, { definitions: budget.definitions * 2, similar: budget.similar * 2 });
  extra.wide = buildContext(index, c.file, source, offset, [], similarCode(index, c.file, source, c.line, 10));
  Object.assign(BUDGET, budget);
  const changed = configs.includes("full") && configs.includes("types") && JSON.stringify(extra.types) !== JSON.stringify(extra.full);
  if (changed) typed.cases++;
  for (const config of configs) {
    const body = infillRequest(lines, c.line, c.column, extra[config], 128);
    const { text, ms, probs } = await ask(body);
    // Typing a character with the prompt ready, as the editor's warm-up leaves it: process the prompt one
    // character short, then time the request for the whole prompt.
    if (body.prompt.trim()) {
      await ask({ ...body, prompt: body.prompt.slice(0, -1), n_predict: 0 });
      scores[config].typing.push((await ask(body)).ms);
    }
    const below = lines.slice(c.line, c.line + 10);
    const next = below.find((l) => l.trim())?.trim();
    const s = scores[config];
    if (text.split("\n").some((l, i) => i > 0 && l.trim() === next)) s.repeats++;
    const first = cleanSuggestion(text, "", below, leastLikely(text, probs)).split("\n")[0].trimEnd();
    if (cleanSuggestion(text, "", below).split("\n")[0].trimEnd() === c.expected) s.exactShownAll++;
    if (!first.trim()) s.empty++;
    if (first === c.expected) {
      s.exact++;
      if (changed && (config === "full" || config === "types")) typed[config]++;
    }
    s.similarity += editSimilarity(first, c.expected);
    s.ms.push(ms);
    s.tokens.push(extra[config].reduce((sum, e) => sum + e.text.length, 0) / 4);
  }
  process.stderr.write(`\r${n + 1}/${cases.length}`);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const pct = (x: number) => `${((100 * x) / cases.length).toFixed(1)}%`;
console.log(`\n${root}: ${cases.length} cases, ${index.files.size} files indexed, ${Object.keys(models).length} models, ${modelPath.split("/").pop()}\n`);
console.log("| Context | Exact first line | Edit similarity | Empty | Repeated code below | Median time, cold | Median time, typing | Context tokens (about) |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const [config, s] of Object.entries(scores)) {
  console.log(`| ${config} | ${pct(s.exact)} | ${pct(s.similarity)} | ${pct(s.empty)} | ${pct(s.repeats)} | ${median(s.ms).toFixed(0)} ms | ${median(s.typing).toFixed(0)} ms | ${median(s.tokens).toFixed(0)} |`);
}
for (const [config, s] of Object.entries(scores)) console.log(`\n${config}: exact first line ${pct(s.exactShownAll)} when every suggestion is shown, ${pct(s.exact)} when unsure ones are hidden (${pct(s.empty)} empty).`);
if (typed.cases) console.log(`\nThe types changed the context in ${typed.cases} cases. Exact first line there: ${typed.full} without them, ${typed.types} with them.`);
server.kill();
