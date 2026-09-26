// AI code completion: suggestions from a local model, shown as ghost text that Tab accepts.
// The bundled llama-server runs the model, and its /infill endpoint fills in the code between
// the text before and after the cursor. The model is downloaded the first time it's turned on.
import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { monaco } from "./editor";
import { confirm } from "./palette";
import { buildContext, chunk, leastLikely, INDEXED, MAX_FILES, SKIPPED, type Chunk, cleanSuggestion, type Extra, type Index, infillRequest, type ModelFacts, outlineFile, replacedAfter, similarCode, typedNames } from "./aicontext";
import { ensureTools, phpactorRequest } from "./lsp";
import { parseTypeDeclaration } from "./phptypes";
import { type Psr4, psr4From } from "./psr4";
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

/**
 * Downloads running, by file. A download can't be stopped, so switching models away and back must
 * wait for the one still running: a second curl appending to the same .part file damages it.
 * ponytail: kept in memory, so a page reload forgets a download that's still running.
 */
const downloads = new Map<string, Promise<void>>();

/** Downloads a model unless it's already there, resuming a partial download, and checks it. */
function download(m: Model, path: string) {
  if (!downloads.has(path)) downloads.set(path, fetchModel(m, path).finally(() => downloads.delete(path)));
  return downloads.get(path)!;
}

async function fetchModel(m: Model, path: string) {
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
    await ensureTools();
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
  const changed: string[] = [];
  for (const path of paths) {
    const rel = path.slice(p.root.length + 1);
    if (!path.startsWith(p.root + "/") || !INDEXED.test(rel) || SKIPPED.test(rel)) continue;
    changed.push(rel);
    types.delete(path);
    if (/^(app|database\/migrations)\/.*\.php$/.test(rel)) {
      clearTimeout(modelsTimer);
      modelsTimer = setTimeout(() => loadModels(p), 5000);
    }
  }
  // Read in batches, as indexing does, so a checkout that changes thousands of files doesn't read them all at once.
  (async () => {
    for (let i = 0; i < changed.length && project === p; i += 32)
      await Promise.all(changed.slice(i, i + 32).map(async (rel) => indexFile(p, rel, await readFile(`${p.root}/${rel}`))));
  })();
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

const relative = (p: Project, path: string) => (path.startsWith(p.root + "/") ? path.slice(p.root.length + 1) : path);

/** Outlines of open files by model, kept until the text changes, since every request outlines them again. */
const openOutlines = new WeakMap<monaco.editor.ITextModel, { version: number; rel: string; outline: string }>();

/** The project for aicontext.ts: open files are outlined from their unsaved text. */
const indexOf = (p: Project): Index => ({
  ...p,
  outline: (rel) => {
    const open = monaco.editor.getModel(monaco.Uri.file(`${p.root}/${rel}`));
    if (open) {
      const cached = openOutlines.get(open);
      if (cached?.version === open.getVersionId() && cached.rel === rel) return cached.outline;
      const outline = outlineFile(rel, open.getValue());
      openOutlines.set(open, { version: open.getVersionId(), rel, outline });
      return outline;
    }
    if (!p.outlines.has(rel)) p.outlines.set(rel, outlineFile(rel, p.files.get(rel)?.text ?? ""));
    return p.outlines.get(rel)!;
  },
});

let similarFor = { key: "", chunks: [] as Chunk[] };
/** Similar code is searched again when the cursor moves 10 lines or more, so typing doesn't change the prompt. */
const similarKey = (p: Project, model: monaco.editor.ITextModel, line: number) => `${relative(p, model.uri.path)}:${Math.floor(line / 10)}`;

/** Types Phpactor found for names before `->`, by file path, then name: a class, or null and when it was asked. */
const types = new Map<string, Map<string, { fqn: string | null; at: number }>>();
const typesIn = (path: string) => types.get(path) ?? types.set(path, new Map()).get(path)!;
const asking = new Set<string>();
/** Readies the prompt for the focused editor again, after context arrives late. */
let rewarm = () => {};

/**
 * The classes of the names before `->` near the cursor that Phpactor has found so far. Names it hasn't
 * been asked about yet are looked up in the background, so a request never waits for Phpactor; the
 * next one has them. A name with no type is asked again after a second: the lookup often runs before
 * Phpactor has the edit that declared the name, or the code around it is half typed. Types are kept
 * until the file changes on disk.
 */
function typesNear(p: Project, model: monaco.editor.ITextModel, offset: number): string[] {
  if (!model.uri.path.endsWith(".php") || model.uri.path.endsWith(".blade.php")) return [];
  const found: string[] = [];
  for (const { name, offset: at } of typedNames(model.getValue(), offset)) {
    const key = `${model.uri.path}|${name}`;
    const known = types.get(model.uri.path)?.get(name);
    if (known?.fqn) found.push(known.fqn);
    if ((known && (known.fqn || Date.now() - known.at < 1000)) || asking.has(key)) continue;
    asking.add(key);
    const pos = model.getPositionAt(at + 1);
    phpactorRequest<{ uri?: string; targetUri?: string } | { uri?: string; targetUri?: string }[]>("textDocument/typeDefinition", {
      textDocument: { uri: model.uri.toString() },
      position: { line: pos.lineNumber - 1, character: pos.column - 1 },
    })
      .catch(() => null)
      .then(async (result) => {
        const target = [result ?? []].flat()[0];
        const path = target && monaco.Uri.parse(target.targetUri ?? target.uri ?? "").path;
        const text = path?.startsWith(p.root + "/") ? (p.files.get(relative(p, path))?.text ?? null) : null;
        const fqn = (text && parseTypeDeclaration(text)?.fqn) || null;
        typesIn(model.uri.path).set(name, { fqn, at: Date.now() });
        asking.delete(key);
        if (fqn) rewarm();
      });
  }
  return found;
}

function context(model: monaco.editor.ITextModel, position: monaco.Position): Extra[] {
  const p = project;
  if (!p) return [];
  const index = indexOf(p);
  const rel = relative(p, model.uri.path);
  const source = model.getValue();
  const key = similarKey(p, model, position.lineNumber);
  if (similarFor.key !== key) similarFor = { key, chunks: similarCode(index, rel, source, position.lineNumber) };
  const worked = recent.map((r) => ({ ...r, path: relative(p, r.path) }));
  const offset = model.getOffsetAt(position);
  return buildContext(index, rel, source, offset, worked, similarFor.chunks, typesNear(p, model, offset));
}

let nextRequest = 0;

/**
 * Asks the server to fill in the code at `position`. With `predict` 0 it only processes the prompt, to
 * have it ready. Cancelling `token` closes the connection, which stops the server's work on it.
 */
async function infill(model: monaco.editor.ITextModel, position: monaco.Position, predict: number, token?: monaco.CancellationToken) {
  const body = infillRequest(model.getLinesContent(), position.lineNumber, position.column, context(model, position), predict);
  const id = ++nextRequest;
  const cancel = token?.onCancellationRequested(() => invoke("ai_cancel", { id }));
  try {
    const reply = JSON.parse(await invoke<string>("ai_request", { id, port, key, path: "/infill", body: JSON.stringify(body) }));
    const text = (reply.content as string) ?? "";
    const tokens = ((reply.completion_probabilities ?? []) as { token: string; logprob: number }[]).map((t) => ({ token: t.token, p: Math.exp(t.logprob) }));
    return { text, least: leastLikely(text, tokens) };
  } catch {
    return { text: "", least: [] };
  } finally {
    cancel?.dispose();
  }
}

const provider: monaco.languages.InlineCompletionsProvider = {
  debounceDelayMs: 250,
  async provideInlineCompletions(model, position, _context, token) {
    if (!port || model.uri.scheme !== "file") return;
    if (project?.root !== projectRoot() && projectRoot()) indexProject(projectRoot());
    const after = model.getLineContent(position.lineNumber).slice(position.column - 1);
    if (/^\w/.test(after)) return; // In the middle of a word.
    const below = model.getLinesContent().slice(position.lineNumber, position.lineNumber + 10);
    const reply = await infill(model, position, 128, token);
    const text = cleanSuggestion(reply.text, after, below, reply.least);
    if (!text || token.isCancellationRequested) return;
    const end = position.column + replacedAfter(text, after);
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
  ed.onDidFocusEditorText(() => {
    rewarm = () => warm(true, 300);
    warm(true, 500);
  });
  ed.onDidChangeCursorPosition(() => warm(false, 1000));
}

export function initAi(deps: { status: typeof status; root: () => string }) {
  status = deps.status;
  projectRoot = deps.root;
  monaco.languages.registerInlineCompletionsProvider("*", provider);
  // ⌘→ accepts the next word of a suggestion (Monaco's own). ⌘⇧→ accepts the next line, under the same
  // condition, so it still selects to the end of the line when no suggestion is in front of the cursor.
  monaco.editor.addKeybindingRule({
    keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.RightArrow,
    command: "editor.action.inlineSuggest.acceptNextLine",
    when: "editorTextFocus && !editorReadonly && inlineSuggestionVisible && cursorBeforeGhostText",
  });
  monaco.editor.getEditors().forEach(watchEditor);
  monaco.editor.onDidCreateEditor(watchEditor);
  document.getElementById("ai-status")!.onclick = async () => {
    if (await confirm("Turn off AI completion?", "Turn Off")) updateSetting("aiCompletion", false);
  };
  onSettings(() => void apply());
}
