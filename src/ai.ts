// AI code completion: suggestions from a local model, shown as ghost text that Tab accepts.
// The bundled llama-server runs the model, and its /infill endpoint fills in the code between
// the text before and after the cursor. The model is downloaded the first time it's turned on.
import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { monaco } from "./editor";
import { confirm } from "./palette";
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
  if (!id) return;
  const m = MODELS[id];
  try {
    const path = await modelPath(m);
    await download(m, path);
    if (wanted !== id) return;
    status(`Loading ${m.label}…`, "ai:progress");
    const p = await invoke<number>("ai_start", { model: path });
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

// ponytail: the first 2,000 characters of up to 5 other open files (their imports and class
// headers). Sending the code around recent edits, as llama.vim does, would give better context.
const openFiles = (current: monaco.editor.ITextModel) =>
  monaco.editor
    .getModels()
    .filter((m) => m !== current && m.uri.scheme === "file")
    .slice(0, 5)
    .map((m) => ({ filename: m.uri.path.split("/").pop(), text: m.getValue().slice(0, 2000) }));

const provider: monaco.languages.InlineCompletionsProvider = {
  debounceDelayMs: 250,
  async provideInlineCompletions(model, position, _context, token) {
    if (!port || model.uri.scheme !== "file") return;
    const line = model.getLineContent(position.lineNumber);
    const before = line.slice(0, position.column - 1);
    const after = line.slice(position.column - 1);
    if (/^\w/.test(after)) return; // In the middle of a word.
    const first = Math.max(1, position.lineNumber - 200);
    const last = Math.min(model.getLineCount(), position.lineNumber + 60);
    const below = last > position.lineNumber ? "\n" + model.getValueInRange(new monaco.Range(position.lineNumber + 1, 1, last, model.getLineMaxColumn(last))) : "";
    const body = {
      input_prefix: model.getValueInRange(new monaco.Range(first, 1, position.lineNumber, 1)),
      prompt: before,
      input_suffix: after + below,
      input_extra: openFiles(model),
      // Stops at a line indented less than this one, so a suggestion stays inside its block.
      n_indent: line.match(/^\s*/)![0].length,
      n_predict: 128,
      top_k: 40,
      top_p: 0.99,
      samplers: ["top_k", "top_p", "infill"],
      cache_prompt: true,
      t_max_prompt_ms: 1000,
      t_max_predict_ms: 1500,
      response_fields: ["content"],
    };
    const reply = await curl(["-sf", "-X", "POST", "-H", "Content-Type: application/json", "--data-binary", "@-", `http://127.0.0.1:${port}/infill`], JSON.stringify(body)).catch(() => "");
    const text = reply && (JSON.parse(reply).content as string).trimEnd();
    if (!text?.trim() || token.isCancellationRequested) return;
    // When the suggestion ends with the rest of the line (a closing bracket, say), replace it instead of repeating it.
    const rest = after.trimEnd();
    const replaceRest = rest && text.split("\n")[0].endsWith(rest);
    const end = replaceRest ? position.column + rest.length : position.column;
    return { items: [{ insertText: text, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, end) }] };
  },
  disposeInlineCompletions() {},
};

export function initAi(deps: { status: typeof status }) {
  status = deps.status;
  monaco.languages.registerInlineCompletionsProvider("*", provider);
  document.getElementById("ai-status")!.onclick = async () => {
    if (await confirm("Turn off AI completion?", "Turn Off")) updateSetting("aiCompletion", false);
  };
  onSettings(() => void apply());
}
