// AI code completion: suggestions from a local model, shown as ghost text that Tab accepts.
// The bundled llama-server runs the model, and its /infill endpoint fills in the code between
// the text before and after the cursor. The model is downloaded the first time it's turned on.
import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { monaco } from "./editor";
import { confirm } from "./palette";
import { chunk, type Chunk, type ModelFacts, modelDoc, outline, pack, referencedClasses, similar, words } from "./aicontext";
import { parseTypeDeclaration } from "./phptypes";
import { pathsFor, type Psr4, psr4From } from "./psr4";
import { onSettings, settings, updateSetting } from "./settings";

type Model = { label: string; repo: string; revision: string; file: string; size: number; sha256: string };

/** Models trained for fill-in-the-middle, by `aiModel` setting. Pinned to a revision and checked against its SHA-256. */
export const MODELS: Record<string, Model> = {
  "qwen2.5-coder-1.5b": {
    label: "Qwen2.5-Coder 1.5B",
    repo: "ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF",
    revision: "8be1b8a895a84beea772817caaa71eba6b6e0d07",
    file: "qwen2.5-coder-1.5b-q8_0.gguf",
    size: 1646573056,
    sha256: "29871c94d15727a6e243f79a37113d4ae625a6215b5e800bf41a23af2da32832",
  },
  "qwen2.5-coder-3b": {
    label: "Qwen2.5-Coder 3B",
    repo: "ggml-org/Qwen2.5-Coder-3B-Q8_0-GGUF",
    revision: "9c1de162ae417c9c3aacde97c729c4128de047d8",
    file: "qwen2.5-coder-3b-q8_0.gguf",
    size: 3285476160,
    sha256: "a522a906e299ed34db738b9626b2cd0da9e446c14674468a22fc2eae3dbd344d",
  },
  "qwen2.5-coder-7b": {
    label: "Qwen2.5-Coder 7B",
    repo: "ggml-org/Qwen2.5-Coder-7B-Q8_0-GGUF",
    revision: "bca77e0a8c88fc224882bcc404170c3ef17efacc",
    file: "qwen2.5-coder-7b-q8_0.gguf",
    size: 8098525600,
    sha256: "0ef48dc94a3c551a6736ac2601de38413dc9aa9318534b16e8baee08290a4aaf",
  },
};

let status: (text: string, source?: string) => void = () => {};
/** The model the server runs or is starting, "" when off. */
let wanted = "";
/** The running server's port, 0 until it's ready. */
let port = 0;
/** The server's API key, new for each start. */
let key = "";

const run = (program: string, args: string[], input?: string) => invoke<string>("run_capture", { cwd: "/", program, args, input });
const curl = (args: string[], input?: string) => run("/usr/bin/curl", args, input);
const modelPath = async (m: Model) => `${await appDataDir()}/models/${m.file}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Downloads a model unless it's already there, resuming a partial download, and checks it. */
async function download(m: Model, path: string) {
  if (await invoke<boolean>("path_exists", { path })) return;
  const part = `${path}.part`;
  await invoke("create_dir", { path: path.slice(0, path.lastIndexOf("/")) });
  let done = false;
  const progress = setInterval(async () => {
    const size = Number(await run("/usr/bin/stat", ["-f", "%z", part]).catch(() => "0"));
    if (!done) status(`Downloading ${m.label}: ${Math.floor((size / m.size) * 100)}%`, "ai:progress");
  }, 1000);
  try {
    // Retries resume too, since -C - continues from the partial file's size.
    await curl(["-fsSL", "--retry", "10", "--retry-all-errors", "-C", "-", "-o", part, `https://huggingface.co/${m.repo}/resolve/${m.revision}/${m.file}`]);
    status(`Checking ${m.label}…`, "ai:progress");
    const [sum] = (await run("/usr/bin/shasum", ["-a", "256", part])).split(" ");
    if (sum !== m.sha256) {
      await invoke("remove_path", { path: part });
      throw new Error("the download was damaged. Turn AI completion on again to retry.");
    }
    await invoke("rename_path", { from: part, to: path });
  } finally {
    done = true;
    clearInterval(progress);
  }
}

/** Starts, switches, or stops the server to match the settings. */
async function apply() {
  const id = settings.aiCompletion && MODELS[settings.aiModel] ? settings.aiModel : "";
  if (id === wanted) return;
  wanted = id;
  port = 0;
  render();
  await invoke("lsp_stop", { name: "llama" });
  if (!id) {
    project = null;
    recent = [];
    return;
  }
  if (projectRoot()) indexProject(projectRoot());
  const m = MODELS[id];
  try {
    const path = await modelPath(m);
    await download(m, path);
    if (wanted !== id) return;
    status(`Loading ${m.label}…`, "ai:progress");
    key = crypto.randomUUID();
    const p = await invoke<number>("ai_start", { model: path, key });
    for (let i = 0; i < 120 && wanted === id && !port; i++) {
      if (await curl(["-sf", `http://127.0.0.1:${p}/health`]).then(() => true, () => false)) port = p;
      else await sleep(500);
    }
    if (wanted === id && !port) throw new Error("the model server didn't start.");
  } catch (e) {
    // A download that failed keeps its partial file, so turning completion on again resumes it.
    status(`AI completion failed: ${e instanceof Error ? e.message : e}`);
    if (wanted === id) updateSetting("aiCompletion", false);
  } finally {
    status("", "ai:progress");
    render();
  }
}

/** The status bar item: shown while AI completion is on. */
function render() {
  const el = document.getElementById("ai-status")!;
  el.hidden = !wanted;
  el.classList.toggle("loading", !port);
  el.title = wanted ? `AI completion: ${MODELS[wanted].label}${port ? "" : " (starting)"}. Click to turn it off.` : "";
}

// ---- Context: code from the rest of the project, sent as extra files before the current one ----

type Project = {
  root: string;
  psr4: Psr4;
  /** Source files by path relative to the root, with their chunks for similarity search. */
  files: Map<string, { text: string; chunks: Chunk[] }>;
  outlines: Map<string, string>;
  /** Eloquent models by class, from introspect.php. */
  models: Record<string, ModelFacts>;
};
let project: Project | null = null;
let projectRoot = () => "";

const INDEXED = /\.(php|js|jsx|ts|tsx|vue)$/;
const SKIPPED = /^(vendor|node_modules|storage|public|bootstrap\/cache)\//;
// ponytail: the first 3,000 source files; a bigger project leaves the rest out of similarity search.
const MAX_FILES = 3000;
/** Characters of each kind of context: about 4,000 tokens in all. */
const BUDGET = { definitions: 7000, recent: 3000, similar: 3500 };

const readFile = (path: string) => invoke<string>("read_file", { path }).catch(() => "");

function indexFile(p: Project, rel: string, text: string) {
  p.outlines.delete(rel);
  if (!text || text.length > 200_000) p.files.delete(rel);
  else p.files.set(rel, { text, chunks: chunk(rel, text) });
}

/** Reads the project's source files, and its models from the database. */
async function indexProject(root: string) {
  const p: Project = { root, psr4: {}, files: new Map(), outlines: new Map(), models: {} };
  project = p;
  p.psr4 = psr4From(await readFile(`${root}/composer.json`));
  const paths = (await invoke<string[]>("list_files", { root })).filter((f) => INDEXED.test(f) && !SKIPPED.test(f)).slice(0, MAX_FILES);
  for (let i = 0; i < paths.length && project === p; i += 32) {
    await Promise.all(paths.slice(i, i + 32).map(async (rel) => indexFile(p, rel, await readFile(`${root}/${rel}`))));
  }
  await loadModels(p);
}

/** Every model's columns, casts, and relationships, from the booted Laravel app. */
async function loadModels(p: Project) {
  if (!(await invoke<boolean>("path_exists", { path: `${p.root}/vendor/autoload.php` }))) return;
  const script = await invoke<string>("tool_path", { name: "filament-lsp/introspect.php" });
  const out = await invoke<string>("run_capture", { cwd: p.root, program: "php", args: [script, p.root, "models"] }).catch(() => "{}");
  const models = JSON.parse(out);
  if (!models.error) p.models = models;
}

let modelsTimer: ReturnType<typeof setTimeout> | undefined;
/** Updates the index for files changed on disk, by this editor or another program. */
export function aiFilesChanged(paths: string[]) {
  const p = project;
  if (!p) return;
  for (const path of paths) {
    const rel = path.slice(p.root.length + 1);
    if (!path.startsWith(p.root + "/") || !INDEXED.test(rel) || SKIPPED.test(rel)) continue;
    readFile(path).then((text) => indexFile(p, rel, text));
    if (/^(app|database\/migrations)\/.*\.php$/.test(rel)) {
      clearTimeout(modelsTimer);
      modelsTimer = setTimeout(() => loadModels(p), 5000);
    }
  }
}

/** Code the user worked on lately, oldest first: the lines around the cursor when they left an editor. */
let recent: { path: string; start: number; text: string }[] = [];

function remember(ed: monaco.editor.ICodeEditor) {
  const model = ed.getModel();
  const pos = ed.getPosition();
  if (!port || !model || !pos || model.uri.scheme !== "file") return;
  const start = Math.max(0, pos.lineNumber - 16);
  const text = model.getLinesContent().slice(start, start + 30).join("\n");
  if (text.trim().length < 40) return;
  const path = model.uri.path;
  recent = [...recent.filter((r) => !(r.path === path && Math.abs(r.start - start) < 20)), { path, start, text }].slice(-6);
}

const outlineOf = (p: Project, rel: string) => {
  const open = monaco.editor.getModel(monaco.Uri.file(`${p.root}/${rel}`));
  if (open) return outline(open.getValue());
  if (!p.outlines.has(rel)) p.outlines.set(rel, outline(p.files.get(rel)?.text ?? ""));
  return p.outlines.get(rel)!;
};

const relative = (p: Project, path: string) => (path.startsWith(p.root + "/") ? path.slice(p.root.length + 1) : path);

let similarFor = { key: "", chunks: [] as Chunk[] };
/** Similar code is searched again when the cursor moves 10 lines or more, so typing doesn't change the prompt. */
const similarKey = (p: Project, model: monaco.editor.ITextModel, line: number) => `${relative(p, model.uri.path)}:${Math.floor(line / 10)}`;

type Extra = { filename: string; text: string };

/**
 * The extra files for a request, most stable first so the server can reuse its processed prompt:
 * outlines of the project classes used near the cursor, with the models' columns; code from other
 * files the user worked on lately; and the project code most like the lines before the cursor.
 */
function context(model: monaco.editor.ITextModel, position: monaco.Position): Extra[] {
  const p = project;
  if (!p) return [];
  const rel = relative(p, model.uri.path);
  const source = model.getValue();
  const line = position.lineNumber;

  const definitions: Extra[] = [];
  if (rel.endsWith(".php")) {
    const used = referencedClasses(source, model.getOffsetAt(position))
      .flatMap((fqn) => {
        const file = pathsFor(fqn, p.psr4).find((f) => f !== rel && p.files.has(f));
        return file ? [{ fqn, file }] : [];
      })
      .slice(0, 8)
      // In a fixed order, so moving the cursor changes the prompt only when the set of classes changes.
      .sort((a, b) => a.file.localeCompare(b.file));
    const own = parseTypeDeclaration(source)?.fqn;
    const docs = [...(own ? [own] : []), ...used.map((u) => u.fqn)].filter((c) => p.models[c]).map((c) => modelDoc(p.models[c]));
    if (docs.length) definitions.push({ filename: "_ide_helper_models.php", text: `<?php\n\n${docs.join("\n\n")}\n` });
    definitions.push(...used.map((u) => ({ filename: u.file, text: `<?php\n\n${outlineOf(p, u.file)}\n` })));
  }

  const worked = recent
    .filter((r) => r.path !== model.uri.path)
    .map((r) => ({ filename: relative(p, r.path), text: r.text + "\n" }));

  const key = similarKey(p, model, line);
  if (similarFor.key !== key) {
    const query = words(model.getLinesContent().slice(Math.max(0, line - 20), line).join("\n"));
    // Chunks near the cursor are in the prompt already.
    const inPrompt = (c: Chunk) => c.path === rel && c.start < line + 40 && c.start + c.lines > line - 150;
    const all = function* () {
      for (const [f, e] of p.files) if (f !== rel) yield* e.chunks;
      yield* chunk(rel, source);
    };
    similarFor = { key, chunks: similar(all(), query, 5, inPrompt) };
  }
  // Files already outlined and code already sent as recent are left out, so the budget goes to other code.
  const sent = (c: Chunk) =>
    definitions.some((d) => d.filename === c.path) || recent.some((r) => relative(p, r.path) === c.path && r.start < c.start + c.lines && c.start < r.start + 30);
  const like = similarFor.chunks.filter((c) => !sent(c)).map((c) => ({ filename: c.path, text: c.text + "\n" }));

  return [...pack(definitions, BUDGET.definitions), ...pack(worked, BUDGET.recent), ...pack(like, BUDGET.similar)];
}

/** Asks the server to fill in the code at `position`. With `predict` 0 it only processes the prompt, to have it ready. */
async function infill(model: monaco.editor.ITextModel, position: monaco.Position, predict: number) {
  const line = model.getLineContent(position.lineNumber);
  const first = Math.max(1, position.lineNumber - 150);
  const last = Math.min(model.getLineCount(), position.lineNumber + 40);
  const below = last > position.lineNumber ? "\n" + model.getValueInRange(new monaco.Range(position.lineNumber + 1, 1, last, model.getLineMaxColumn(last))) : "";
  const body = {
    input_prefix: model.getValueInRange(new monaco.Range(first, 1, position.lineNumber, 1)),
    prompt: line.slice(0, position.column - 1),
    input_suffix: line.slice(position.column - 1) + below,
    input_extra: context(model, position),
    // Stops at a line indented less than this one, so a suggestion stays inside its block.
    n_indent: line.match(/^\s*/)![0].length,
    n_predict: predict,
    top_k: 40,
    top_p: 0.99,
    samplers: ["top_k", "top_p", "infill"],
    cache_prompt: true,
    t_max_predict_ms: 1500,
    response_fields: ["content"],
  };
  const reply = await curl(["-sf", "-X", "POST", "-H", "Content-Type: application/json", "-H", `Authorization: Bearer ${key}`, "--data-binary", "@-", `http://127.0.0.1:${port}/infill`], JSON.stringify(body)).catch(() => "");
  try {
    return (JSON.parse(reply).content as string).trimEnd();
  } catch {
    return "";
  }
}

const provider: monaco.languages.InlineCompletionsProvider = {
  debounceDelayMs: 250,
  async provideInlineCompletions(model, position, _context, token) {
    if (!port || model.uri.scheme !== "file") return;
    if (project?.root !== projectRoot() && projectRoot()) indexProject(projectRoot());
    const after = model.getLineContent(position.lineNumber).slice(position.column - 1);
    if (/^\w/.test(after)) return; // In the middle of a word.
    const text = await infill(model, position, 128);
    if (!text.trim() || token.isCancellationRequested) return;
    // When the suggestion ends with the rest of the line (a closing bracket, say), replace it instead of repeating it.
    const rest = after.trimEnd();
    const replaceRest = rest && text.split("\n")[0].endsWith(rest);
    const end = replaceRest ? position.column + rest.length : position.column;
    return { items: [{ insertText: text, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, end) }] };
  },
  disposeInlineCompletions() {},
};

/**
 * Remembers where the user was when they leave an editor. When they enter one, or the cursor
 * settles 10 or more lines away, has the server process the new prompt before they type: that
 * takes up to 2 seconds for a full context, and a request after it about 0.2 seconds.
 */
function watchEditor(ed: monaco.editor.ICodeEditor) {
  ed.onDidBlurEditorText(() => remember(ed));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const warm = (always: boolean, delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const model = ed.getModel();
      const pos = ed.getPosition();
      if (!port || !project || !model || !pos || model.uri.scheme !== "file" || !ed.hasTextFocus()) return;
      if (always || similarKey(project, model, pos.lineNumber) !== similarFor.key) infill(model, pos, 0);
    }, delay);
  };
  ed.onDidFocusEditorText(() => warm(true, 500));
  ed.onDidChangeCursorPosition(() => warm(false, 1000));
}

export function initAi(deps: { status: typeof status; root: () => string }) {
  status = deps.status;
  projectRoot = deps.root;
  monaco.languages.registerInlineCompletionsProvider("*", provider);
  monaco.editor.getEditors().forEach(watchEditor);
  monaco.editor.onDidCreateEditor(watchEditor);
  document.getElementById("ai-status")!.onclick = async () => {
    if (await confirm("Turn off AI completion?", "Turn Off")) updateSetting("aiCompletion", false);
  };
  onSettings(() => void apply());
}
