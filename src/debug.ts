// PHP debugging with Xdebug, through the bundled adapter from VS Code's PHP Debug extension.
// The adapter speaks the Debug Adapter Protocol (DAP) over the same bridge as the language servers.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { monaco } from "./editor";
import { pick } from "./palette";
import { showPanelView } from "./terminal";

type Host = { root(): string; openAt(path: string, line: number): Promise<unknown>; status(text: string): void };
type Frame = { id: number; name: string; line: number; source?: { path?: string; name?: string } };
type Variable = { name: string; value: string; type?: string; variablesReference: number };

const PORT = 9003;
let host: Host;

// ---- DAP transport ----

let seq = 1;
const pending = new Map<number, { resolve(v: any): void; reject(e: any): void }>();
let running = false;

const send = (msg: object) => invoke("lsp_send", { name: "xdebug", msg: JSON.stringify({ seq: seq++, ...msg }) });

function request<T = any>(command: string, args: object = {}): Promise<T> {
  const id = seq;
  const result = new Promise<T>((resolve, reject) => pending.set(id, { resolve, reject }));
  send({ type: "request", command, arguments: args });
  return result;
}

listen<string>("lsp:xdebug", ({ payload }) => {
  const msg = JSON.parse(payload);
  if (msg.type === "response") {
    const p = pending.get(msg.request_seq);
    pending.delete(msg.request_seq);
    msg.success ? p?.resolve(msg.body ?? {}) : p?.reject(new Error(msg.message ?? "request failed"));
  } else if (msg.type === "event") onEvent(msg.event, msg.body ?? {});
  else if (msg.type === "request") send({ type: "response", request_seq: msg.seq, command: msg.command, success: true }); // e.g. runInTerminal, not used here
});

// ---- Breakpoints ----
// Each breakpoint is a line and a condition ("" for none), kept per file. For files with an open
// model, decorations track the lines as you edit, so the model is the source of truth there.

type Breakpoints = Map<number, string>;
const breakpoints = new Map<string, Breakpoints>();
const decorations = new Map<string, Map<string, string>>(); // path → decoration id → condition
const modelFor = (path: string) => monaco.editor.getModel(monaco.Uri.file(path));
const storageKey = () => `breakpoints:${host.root()}`;

function breakpointsOf(path: string): Breakpoints {
  const model = modelFor(path);
  const ids = decorations.get(path);
  if (!model || !ids) return breakpoints.get(path) ?? new Map();
  const result: Breakpoints = new Map();
  for (const [id, condition] of ids) {
    const line = model.getDecorationRange(id)?.startLineNumber;
    if (line) result.set(line, condition);
  }
  return result;
}

function renderBreakpoints(path: string) {
  const model = modelFor(path);
  if (!model) return;
  const entries = [...(breakpoints.get(path) ?? [])];
  const ids = model.deltaDecorations(
    [...(decorations.get(path)?.keys() ?? [])],
    entries.map(([line, condition]) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: condition ? "breakpoint conditional" : "breakpoint",
        glyphMarginHoverMessage: { value: condition ? `Breakpoint when \`${condition}\` (right-click to edit)` : "Breakpoint (right-click to add a condition)" },
        stickiness: 1,
      },
    })),
  );
  decorations.set(path, new Map(ids.map((id, i) => [id, entries[i][1]])));
}

function persist() {
  const data = Object.fromEntries([...breakpoints].filter(([, b]) => b.size).map(([p, b]) => [p, [...b]]));
  try {
    localStorage.setItem(storageKey(), JSON.stringify(data));
  } catch {
    // Breakpoints then last only for this session.
  }
}

/** Loads the project's saved breakpoints. Call when a folder opens. */
export function loadBreakpoints() {
  breakpoints.clear();
  try {
    // Older versions saved a list of line numbers per file.
    for (const [path, list] of Object.entries<(number | [number, string])[]>(JSON.parse(localStorage.getItem(storageKey()) ?? "{}")))
      breakpoints.set(path, new Map(list.map((b) => (typeof b === "number" ? [b, ""] : b))));
  } catch {
    // No saved breakpoints.
  }
  for (const path of breakpoints.keys()) renderBreakpoints(path);
}

function update(path: string, change: (b: Breakpoints) => void) {
  const b = breakpointsOf(path);
  change(b);
  breakpoints.set(path, b);
  renderBreakpoints(path);
  persist();
  if (running) sendBreakpoints(path);
}

export function toggleBreakpoint(path: string, line: number) {
  update(path, (b) => (b.has(line) ? b.delete(line) : b.set(line, "")));
}

/** Asks for a PHP expression; the breakpoint then pauses only when it's true. Adds the breakpoint if there's none. */
export function editBreakpointCondition(path: string, line: number) {
  const current = breakpointsOf(path).get(line) ?? "";
  pick(
    `Condition for the breakpoint on line ${line}, such as $user->id === 5`,
    (q) => [
      {
        label: q.trim() ? `Pause when ${q.trim()}` : "Pause every time (no condition)",
        run: () => update(path, (b) => b.set(line, q.trim())),
      },
    ],
    0,
    { value: current },
  );
}

const sendBreakpoints = (path: string) =>
  request("setBreakpoints", {
    source: { path },
    breakpoints: [...breakpointsOf(path)].sort(([a], [b]) => a - b).map(([line, condition]) => (condition ? { line, condition } : { line })),
  }).catch(() => {});

/** Adds breakpoints to an editor's gutter: click toggles one, and right-click edits its condition. */
export function attachDebugger(editor: monaco.editor.IStandaloneCodeEditor) {
  editor.updateOptions({ glyphMargin: true });
  editor.onMouseDown((e) => {
    const model = editor.getModel();
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !model || model.uri.scheme !== "file") return;
    const line = e.target.position!.lineNumber;
    if (e.event.rightButton) editBreakpointCondition(model.uri.fsPath, line);
    else toggleBreakpoint(model.uri.fsPath, line);
  });
}

monaco.editor.onDidCreateModel((model) => {
  const path = model.uri.fsPath;
  if (model.uri.scheme !== "file") return;
  renderBreakpoints(path);
  renderCurrentLine();
  // Keep the saved lines in step with edits that move breakpoints.
  model.onDidChangeContent(() => decorations.has(path) && breakpoints.set(path, breakpointsOf(path)));
  model.onWillDispose(() => decorations.delete(path));
});

// ---- Exceptions and path mappings ----

const readSetting = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeSetting = (key: string, value: string | null) => {
  try {
    value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value);
  } catch {
    // Lasts for this session only.
  }
};

let pauseOnExceptions = readSetting("debug:exceptions") === "1";
// Xdebug matches subclasses, so these two cover every Throwable.
const exceptionFilters = () => (pauseOnExceptions ? ["Exception", "Error"] : []);

export function togglePauseOnExceptions() {
  pauseOnExceptions = !pauseOnExceptions;
  writeSetting("debug:exceptions", pauseOnExceptions ? "1" : null);
  if (running) request("setExceptionBreakpoints", { filters: exceptionFilters() }).catch(() => {});
  render();
}

/** Where the project lives on the server, for code that runs in Docker: set by you, or /var/www/html for Sail. */
async function serverRoot(): Promise<string | null> {
  const saved = readSetting(`debug:serverRoot:${host.root()}`);
  if (saved !== null) return saved || null;
  for (const file of ["docker-compose.yml", "compose.yaml", "docker-compose.yaml", "compose.yml"]) {
    const text = await invoke<string>("read_file", { path: `${host.root()}/${file}` }).catch(() => "");
    if (/laravel\/sail|sail-\d/.test(text)) return "/var/www/html";
  }
  return null;
}

export async function setServerRoot() {
  const current = (await serverRoot()) ?? "";
  pick(
    "The project's path on the server, such as /var/www/html (leave empty when PHP runs on this Mac)",
    (q) => [
      {
        label: q.trim() ? `Map ${q.trim()} to ${host.root()}` : "No mapping: PHP runs on this Mac",
        run: () => writeSetting(`debug:serverRoot:${host.root()}`, q.trim().replace(/\/$/, "")),
      },
    ],
    0,
    { value: current },
  );
}

// ---- Session ----

let stoppedThread: number | null = null;
let frames: Frame[] = [];
let current: { path: string; line: number } | null = null;
const currentLine = new Map<string, string[]>();

/** Starts listening for Xdebug connections on port 9003. */
export async function startDebugging() {
  if (running) return;
  showPanel();
  running = true;
  render();
  try {
    await invoke("lsp_start", { name: "xdebug", root: host.root() });
    await request("initialize", { adapterID: "php", clientID: "php-editor", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path", supportsVariableType: true });
    // The adapter answers "launch" once it listens; breakpoints go out on its "initialized" event.
    const remote = await serverRoot();
    const pathMappings = remote ? { [remote]: host.root() } : undefined;
    await request("launch", { port: PORT, stopOnEntry: false, pathMappings, xdebugSettings: { max_children: 128, max_depth: 1, max_data: 2048 } });
    log(`Listening for Xdebug on port ${PORT}. Start a request or test with Xdebug enabled.`);
    if (remote) log(`Mapping ${remote} on the server to ${host.root()}.`);
  } catch (e) {
    log(`Couldn't start the debugger: ${e}`);
    stopDebugging();
  }
}

export async function stopDebugging() {
  if (!running) return;
  await Promise.race([request("disconnect", {}).catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
  await invoke("lsp_stop", { name: "xdebug" }).catch(() => {});
  running = false;
  stoppedThread = null;
  frames = [];
  setCurrent(null);
  log("Stopped listening.");
  render();
}

async function onEvent(event: string, body: any) {
  if (event === "initialized") {
    for (const path of breakpoints.keys()) await sendBreakpoints(path);
    await request("setExceptionBreakpoints", { filters: exceptionFilters() }).catch(() => {});
    await request("configurationDone").catch(() => {});
  } else if (event === "stopped") {
    stoppedThread = body.threadId;
    const trace = await request<{ stackFrames: Frame[] }>("stackTrace", { threadId: body.threadId, startFrame: 0, levels: 50 });
    frames = trace.stackFrames;
    showPanel();
    log(`Paused (${body.reason ?? "breakpoint"})${body.text ? `: ${body.text}` : "."}`);
    await selectFrame(frames[0]);
  } else if (event === "continued" || (event === "thread" && body.reason === "exited" && body.threadId === stoppedThread)) {
    stoppedThread = null;
    frames = [];
    setCurrent(null);
    render();
  } else if (event === "output" && body.output?.trim()) {
    log(body.output.trimEnd());
  } else if (event === "terminated") {
    stopDebugging();
  }
}

// ---- Stepping ----

async function step(command: "continue" | "next" | "stepIn" | "stepOut") {
  if (stoppedThread === null) return;
  const threadId = stoppedThread;
  stoppedThread = null;
  // The adapter doesn't always send "continued", so clear the paused state here.
  frames = [];
  setCurrent(null);
  render();
  await request(command, { threadId }).catch((e) => log(String(e)));
}

export const resume = () => step("continue");
export const stepOver = () => step("next");
export const stepInto = () => step("stepIn");
export const stepOut = () => step("stepOut");
export const isPaused = () => stoppedThread !== null;

// ---- Current line ----

function setCurrent(location: { path: string; line: number } | null) {
  current = location;
  for (const [path, ids] of currentLine) modelFor(path)?.deltaDecorations(ids, []);
  currentLine.clear();
  renderCurrentLine();
}

function renderCurrentLine() {
  if (!current) return;
  const model = modelFor(current.path);
  if (!model) return;
  currentLine.set(
    current.path,
    model.deltaDecorations(currentLine.get(current.path) ?? [], [
      { range: new monaco.Range(current.line, 1, current.line, 1), options: { isWholeLine: true, className: "debug-current-line", glyphMarginClassName: "debug-current-arrow" } },
    ]),
  );
}

// ---- Panel ----

const panel = document.createElement("div");
panel.className = "debug";
panel.innerHTML = `
  <div class="debug-toolbar">
    <button data-run="listen" title="Start listening for Xdebug connections" aria-label="Listen"><span class="codicon codicon-debug-start"></span></button>
    <button data-run="stop" title="Stop listening (⌘F2)" aria-label="Stop"><span class="codicon codicon-debug-stop"></span></button>
    <span class="sep"></span>
    <button data-run="exceptions" title="Pause on exceptions" aria-label="Pause on exceptions"><span class="codicon codicon-zap"></span></button>
    <span class="sep"></span>
    <button data-run="resume" title="Resume (F9)" aria-label="Resume"><span class="codicon codicon-debug-continue"></span></button>
    <button data-run="over" title="Step Over (F8)" aria-label="Step Over"><span class="codicon codicon-debug-step-over"></span></button>
    <button data-run="into" title="Step Into (F7)" aria-label="Step Into"><span class="codicon codicon-debug-step-into"></span></button>
    <button data-run="out" title="Step Out (⇧F8)" aria-label="Step Out"><span class="codicon codicon-debug-step-out"></span></button>
    <span class="debug-state"></span>
  </div>
  <div class="debug-body">
    <ul class="debug-frames" aria-label="Call stack" data-empty="The call stack appears here when execution pauses."></ul>
    <ul class="debug-vars" aria-label="Variables" data-empty="Variables appear here when execution pauses."></ul>
  </div>
  <div class="debug-console">
    <pre></pre>
    <input placeholder="Evaluate an expression in the current frame, such as $request->all()" aria-label="Evaluate expression" spellcheck="false" />
  </div>`;
const q = <T extends HTMLElement>(sel: string) => panel.querySelector(sel) as T;

const runs: Record<string, () => unknown> = { exceptions: togglePauseOnExceptions, listen: startDebugging, resume, over: stepOver, into: stepInto, out: stepOut, stop: stopDebugging };
panel.querySelectorAll<HTMLButtonElement>("[data-run]").forEach((b) => (b.onclick = () => runs[b.dataset.run!]()));

function showPanel() {
  showPanelView("Debug", panel, () => stopDebugging());
}
export const showDebugPanel = showPanel;

function render() {
  q<HTMLElement>(".debug-state").textContent = !running ? "Not listening" : stoppedThread !== null ? "Paused" : "Listening";
  const exceptions = q<HTMLElement>('[data-run="exceptions"]');
  exceptions.setAttribute("aria-pressed", String(pauseOnExceptions));
  exceptions.classList.toggle("on", pauseOnExceptions);
  const enabled: Record<string, boolean> = { exceptions: true, listen: !running, resume: isPaused(), over: isPaused(), into: isPaused(), out: isPaused(), stop: running };
  panel.querySelectorAll<HTMLButtonElement>("[data-run]").forEach((b) => (b.disabled = !enabled[b.dataset.run!]));
  q<HTMLElement>(".debug-frames").replaceChildren(
    ...frames.map((f) => {
      const li = document.createElement("li");
      const file = f.source?.path ? f.source.path.slice(host.root().length + 1) || f.source.path : f.source?.name ?? "";
      li.innerHTML = `<span class="fn"></span><span class="loc"></span>`;
      li.querySelector(".fn")!.textContent = f.name;
      li.querySelector(".loc")!.textContent = `${file}:${f.line}`;
      li.classList.toggle("selected", f.source?.path === current?.path && f.line === current?.line);
      li.onclick = () => selectFrame(f);
      return li;
    }),
  );
  if (!frames.length) q<HTMLElement>(".debug-vars").replaceChildren();
}

let selectedFrame: Frame | undefined;

async function selectFrame(frame: Frame | undefined) {
  selectedFrame = frame;
  if (!frame) return render();
  if (frame.source?.path) {
    setCurrent({ path: frame.source.path, line: frame.line });
    await host.openAt(frame.source.path, frame.line);
    renderCurrentLine();
  }
  render();
  const { scopes } = await request<{ scopes: { name: string; variablesReference: number; expensive?: boolean }[] }>("scopes", { frameId: frame.id });
  q<HTMLElement>(".debug-vars").replaceChildren(
    ...scopes.map((s, i) => variableRow({ name: s.name, value: "", variablesReference: s.variablesReference }, i === 0)),
  );
}

/** A tree row for a variable; rows with children expand on click, loading them on demand. */
function variableRow(v: Variable, open = false): HTMLLIElement {
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = `var${v.variablesReference ? " expandable" : ""}`;
  row.innerHTML = `<span class="name"></span><span class="value"></span><span class="type"></span>`;
  row.querySelector(".name")!.textContent = v.name;
  row.querySelector(".value")!.textContent = v.value ? ` = ${v.value}` : "";
  row.querySelector(".type")!.textContent = v.type ? ` ${v.type}` : "";
  li.append(row);
  if (v.variablesReference) {
    const children = document.createElement("ul");
    li.append(children);
    const toggle = async () => {
      if (row.classList.toggle("open")) {
        const { variables } = await request<{ variables: Variable[] }>("variables", { variablesReference: v.variablesReference });
        children.replaceChildren(...variables.map((c) => variableRow(c)));
      } else children.replaceChildren();
    };
    row.onclick = toggle;
    if (open) toggle();
  }
  return li;
}

function log(text: string) {
  const pre = q<HTMLElement>(".debug-console pre");
  pre.textContent += text + "\n";
  pre.scrollTop = pre.scrollHeight;
  render();
}

q<HTMLInputElement>(".debug-console input").onkeydown = async (e) => {
  const input = e.currentTarget as HTMLInputElement;
  if (e.key !== "Enter" || !input.value.trim()) return;
  const expression = input.value;
  input.value = "";
  if (!selectedFrame || stoppedThread === null) return log("Evaluate works while execution is paused.");
  try {
    const r = await request<{ result: string; type?: string }>("evaluate", { expression, frameId: selectedFrame.id, context: "repl" });
    log(`> ${expression}\n${r.result}${r.type ? `  (${r.type})` : ""}`);
  } catch (err) {
    log(`> ${expression}\n${err}`);
  }
};

export function initDebugger(h: Host) {
  host = h;
  render();
}

/** Environment variables that make a PHP process connect to the debugger. */
export const XDEBUG_ENV = ["XDEBUG_MODE=debug", "XDEBUG_SESSION=1"];
