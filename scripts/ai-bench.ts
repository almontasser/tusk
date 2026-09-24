// Measures AI completion on a real project. It hides code in the project's PHP files, asks the model to
// fill it in with each kind of context, and scores the first line of each suggestion. It builds
// prompts with the editor's own code (src/aicontext.ts), so a score change means a real change.
//
//   node scripts/ai-bench.ts <project> <model.gguf> [cases] [configs]
//
// `configs` is a comma-separated subset of: none, defs, full, wide (default: all). `wide` is full
// context with twice the budget for definitions and similar code.
// Recent code isn't measured: a benchmark has no history of where the user worked.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { BUDGET, buildContext, chunk, cleanSuggestion, type Extra, INDEXED, type Index, infillRequest, MAX_FILES, type ModelFacts, outline, SKIPPED, similarCode } from "../src/aicontext.ts";
import { psr4From } from "../src/psr4.ts";

const [root, modelPath, count = "80", only = "none,defs,full,wide"] = process.argv.slice(2);
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
const server = spawn(`${tools}llama/llama-server`, ["-m", modelPath, "--host", "127.0.0.1", "--port", String(port), "-ngl", "99", "-c", "8192", "-np", "1", "-b", "2048", "-ub", "1024", "--cache-reuse", "256"], { stdio: "ignore" });
process.on("exit", () => server.kill());
for (let i = 0; ; i++) {
  if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)) break;
  if (i > 120) throw new Error("llama-server didn't start");
  await new Promise((r) => setTimeout(r, 500));
}

async function ask(body: object) {
  const start = performance.now();
  const reply = await fetch(`http://127.0.0.1:${port}/infill`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
  return { text: (reply.content as string) ?? "", ms: performance.now() - start };
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

// ---- Run ----
const configs = only.split(",");
type Score = { exact: number; similarity: number; empty: number; repeats: number; ms: number[]; tokens: number[] };
const scores = Object.fromEntries(configs.map((c) => [c, { exact: 0, similarity: 0, empty: 0, repeats: 0, ms: [], tokens: [] } as Score]));

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
  const budget = { ...BUDGET };
  Object.assign(BUDGET, { definitions: budget.definitions * 2, similar: budget.similar * 2 });
  extra.wide = buildContext(index, c.file, source, offset, [], similarCode(index, c.file, source, c.line, 10));
  Object.assign(BUDGET, budget);
  for (const config of configs) {
    const body = infillRequest(lines, c.line, c.column, extra[config], 128);
    const { text, ms } = await ask(body);
    const below = lines.slice(c.line, c.line + 10);
    const next = below.find((l) => l.trim())?.trim();
    const s = scores[config];
    if (text.split("\n").some((l, i) => i > 0 && l.trim() === next)) s.repeats++;
    const first = cleanSuggestion(text, "", below).split("\n")[0].trimEnd();
    if (!first.trim()) s.empty++;
    if (first === c.expected) s.exact++;
    s.similarity += editSimilarity(first, c.expected);
    s.ms.push(ms);
    s.tokens.push(extra[config].reduce((sum, e) => sum + e.text.length, 0) / 4);
  }
  process.stderr.write(`\r${n + 1}/${cases.length}`);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const pct = (x: number) => `${((100 * x) / cases.length).toFixed(1)}%`;
console.log(`\n${root}: ${cases.length} cases, ${index.files.size} files indexed, ${Object.keys(models).length} models, ${modelPath.split("/").pop()}\n`);
console.log("| Context | Exact first line | Edit similarity | Empty | Repeated code below | Median time | Context tokens (about) |");
console.log("| --- | --- | --- | --- | --- | --- | --- |");
for (const [config, s] of Object.entries(scores)) {
  console.log(`| ${config} | ${pct(s.exact)} | ${pct(s.similarity)} | ${pct(s.empty)} | ${pct(s.repeats)} | ${median(s.ms).toFixed(0)} ms | ${median(s.tokens).toFixed(0)} |`);
}
server.kill();
