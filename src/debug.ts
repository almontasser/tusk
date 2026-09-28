// PHP debugging with Xdebug, through the bundled adapter from VS Code's PHP Debug extension.
// The adapter speaks the Debug Adapter Protocol (DAP) over the same bridge as the language servers.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { monaco } from "./editor";
import type { MenuItem } from "./files";
import { ensureTools } from "./lsp";
import { pick } from "./palette";
import { composeService, usesSail } from "./sail";
import { handlerLines, thrownIn, uncaughtClass } from "./debugexceptions";
import { splitter } from "./splitter";
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
// Each breakpoint is a line and its options, kept per file. For files with an open model,
// decorations track the lines as you edit, so the model is the source of truth there.

/** A breakpoint's options, as the Debug Adapter Protocol names them, and whether it's off. Empty means pause every time. */
export type BreakpointOptions = { condition?: string; hitCondition?: string; logMessage?: string; disabled?: boolean };
type Breakpoints = Map<number, BreakpointOptions>;
const breakpoints = new Map<string, Breakpoints>();
const decorations = new Map<string, Map<string, BreakpointOptions>>(); // path → decoration id → options
const modelFor = (path: string) => monaco.editor.getModel(monaco.Uri.file(path));
const storageKey = () => `breakpoints:${host.root()}`;

function breakpointsOf(path: string): Breakpoints {
  const model = modelFor(path);
  const ids = decorations.get(path);
  if (!model || !ids) return breakpoints.get(path) ?? new Map();
  const result: Breakpoints = new Map();
  for (const [id, options] of ids) {
    const line = model.getDecorationRange(id)?.startLineNumber;
    if (line) result.set(line, options);
  }
  return result;
}

function describe(o: BreakpointOptions): string {
  const parts = [o.logMessage ? `Logs \`${o.logMessage}\` without pausing` : "Pauses", o.condition && `when \`${o.condition}\``, o.hitCondition && `on hit ${o.hitCondition}`];
  return `${o.disabled ? "Disabled. " : ""}${parts.filter(Boolean).join(" ")}. Right-click to edit.`;
}

function renderBreakpoints(path: string) {
  const model = modelFor(path);
  if (!model) return;
  const entries = [...(breakpoints.get(path) ?? [])];
  const ids = model.deltaDecorations(
    [...(decorations.get(path)?.keys() ?? [])],
    entries.map(([line, o]) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: `${o.logMessage ? "breakpoint log" : o.condition || o.hitCondition ? "breakpoint conditional" : "breakpoint"}${o.disabled ? " disabled" : ""}`,
        glyphMarginHoverMessage: { value: describe(o) },
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
    // Older versions saved line numbers, then [line, condition] pairs.
    type Saved = number | [number, string | BreakpointOptions];
    for (const [path, list] of Object.entries<Saved[]>(JSON.parse(localStorage.getItem(storageKey()) ?? "{}")))
      breakpoints.set(
        path,
        new Map(list.map((b): [number, BreakpointOptions] => (typeof b === "number" ? [b, {}] : [b[0], typeof b[1] === "string" ? (b[1] ? { condition: b[1] } : {}) : b[1]]))),
      );
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
  update(path, (b) => (b.has(line) ? b.delete(line) : b.set(line, {})));
}

const prompts: { key: "condition" | "hitCondition" | "logMessage"; name: string; placeholder: string }[] = [
  { key: "condition", name: "Condition", placeholder: "A PHP expression; pause only when it's true, such as $user->id === 5" },
  { key: "hitCondition", name: "Hit count", placeholder: "Pause on a hit count: 5 (the fifth time), >= 5, or % 3 (every third time)" },
  { key: "logMessage", name: "Log message", placeholder: "Log instead of pausing; put expressions in braces, such as Saving {$post->id}" },
];

/** Asks for one of a breakpoint's options, adding the breakpoint if there's none. */
function editOption(path: string, line: number, p: (typeof prompts)[number]) {
  const current = breakpointsOf(path).get(line) ?? {};
  pick(
    p.placeholder,
    (q) => [
      {
        label: q.trim() ? `Set ${p.name.toLowerCase()} to ${q.trim()}` : `No ${p.name.toLowerCase()}`,
        run: () => update(path, (b) => b.set(line, { ...current, [p.key]: q.trim() || undefined })),
      },
    ],
    0,
    { value: current[p.key] ?? "" },
  );
}

/** Edits a breakpoint's condition, hit count, or log message, adding the breakpoint if there's none. */
export function editBreakpoint(path: string, line: number) {
  const current = breakpointsOf(path).get(line) ?? {};
  pick(`Breakpoint on line ${line}`, () => [
    ...prompts.map((p) => ({ label: `${p.name}: ${current[p.key] || "none"}`, run: () => editOption(path, line, p) })),
    ...(breakpointsOf(path).has(line) ? [{ label: "Remove breakpoint", run: () => update(path, (b) => b.delete(line)) }] : []),
  ]);
}

/** Removes every breakpoint in a file, or in all files. */
function removeAll(path?: string) {
  for (const p of path ? [path] : [...breakpoints.keys()]) update(p, (b) => b.clear());
}

/** A line to pause at once, for Run to Line: a breakpoint the adapter gets until execution next pauses. */
let runTo: { path: string; line: number } | null = null;

async function runToLine(path: string, line: number) {
  if (!isPaused()) return;
  runTo = { path, line };
  await sendBreakpoints(path);
  resume();
}

const sendBreakpoints = (path: string) => {
  const enabled = [...breakpointsOf(path)].filter(([, o]) => !o.disabled);
  if (runTo?.path === path && !enabled.some(([line]) => line === runTo!.line)) enabled.push([runTo.line, {}]);
  if (handler?.path === path && pauseOnExceptions && uncaughtOnly())
    for (const line of handler.lines) if (!enabled.some(([l]) => l === line)) enabled.push([line, { condition: exceptionClasses().map((c) => `$e instanceof \\${c}`).join(" || ") || undefined }]);
  return request("setBreakpoints", {
    source: { path },
    breakpoints: enabled
      .sort(([a], [b]) => a - b)
      .map(([line, { disabled, ...o }]) => Object.fromEntries(Object.entries({ line, ...o }).filter(([, v]) => v !== undefined && v !== ""))),
  }).catch(() => {});
};

/** The breakpoint items of the gutter's context menu for a line. */
export function breakpointMenu(path: string, line: number): MenuItem[] {
  const all = breakpointsOf(path);
  const b = all.get(line);
  const [condition, hitCount, logMessage] = prompts;
  const items: MenuItem[] = b
    ? [
        { label: "Remove Breakpoint", run: () => update(path, (bs) => bs.delete(line)) },
        { label: b.disabled ? "Enable Breakpoint" : "Disable Breakpoint", run: () => update(path, (bs) => bs.set(line, { ...b, disabled: !b.disabled || undefined })) },
        { label: "Edit Condition…", run: () => editOption(path, line, condition) },
        { label: "Edit Hit Count…", run: () => editOption(path, line, hitCount) },
        { label: "Edit Log Message…", run: () => editOption(path, line, logMessage) },
      ]
    : [
        { label: "Add Breakpoint", run: () => toggleBreakpoint(path, line) },
        { label: "Add Conditional Breakpoint…", run: () => editOption(path, line, condition) },
        { label: "Add Logpoint…", run: () => editOption(path, line, logMessage) },
      ];
  if (isPaused()) items.push("-", { label: "Run to Line", run: () => runToLine(path, line) });
  const elsewhere = [...breakpoints].some(([p, bs]) => p !== path && bs.size);
  if (all.size || elsewhere) items.push("-");
  if (all.size) items.push({ label: "Remove Breakpoints in File", run: () => removeAll(path) });
  if (all.size || elsewhere) items.push({ label: "Remove All Breakpoints", run: () => removeAll() });
  return items;
}

/** Adds breakpoints to an editor's gutter: click toggles one. The gutter's context menu edits them. */
export function attachDebugger(editor: monaco.editor.IStandaloneCodeEditor) {
  editor.updateOptions({ glyphMargin: true });
  editor.onMouseDown((e) => {
    const model = editor.getModel();
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.event.leftButton || !model || model.uri.scheme !== "file") return;
    // A test's run button opens its own menu.
    if (e.target.element?.classList.contains("test-run")) return;
    toggleBreakpoint(model.uri.fsPath, e.target.position!.lineNumber);
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
/** The classes to pause on, per project. Empty means every exception and error. */
const exceptionClasses = (): string[] => (readSetting(`debug:exceptionClasses:${host.root()}`) ?? "").split(",").filter(Boolean);
/** Whether to pause only on exceptions nobody catches, per project. Otherwise every throw pauses, caught or not. */
const uncaughtOnly = () => readSetting(`debug:exceptionUncaught:${host.root()}`) === "1";
/** Path patterns, relative to the project, where a thrown exception doesn't pause, such as vendor/**. Per project. */
const skippedPaths = (): string[] => (readSetting(`debug:exceptionSkip:${host.root()}`) ?? "").split(",").filter(Boolean);
// The adapter makes each filter an Xdebug exception breakpoint on that class name, and Xdebug also matches
// subclasses, so Exception and Error cover every Throwable. Xdebug pauses at the throw, before PHP looks for a
// catch, so it can't tell caught from uncaught there. For uncaught only, the filter is PHP's "Fatal error"
// instead, which an uncaught exception ends in; the adapter passes the name unquoted, so it carries its own quotes.
const exceptionFilters = () => (!pauseOnExceptions ? [] : uncaughtOnly() ? ['"Fatal error"'] : exceptionClasses().length ? exceptionClasses() : ["Exception", "Error"]);

/**
 * Laravel's exception handler, and the lines where it starts rendering an exception the app didn't catch. Laravel
 * catches every exception there, so none reaches PHP's fatal error; for uncaught only, those lines get a breakpoint.
 */
let handler: { path: string; lines: number[] } | null = null;

async function findHandler() {
  const path = `${host.root()}/vendor/laravel/framework/src/Illuminate/Foundation/Exceptions/Handler.php`;
  const text = await invoke<string>("read_file", { path }).catch(() => "");
  handler = text ? { path, lines: handlerLines(text) } : null;
}

const sendExceptionFilters = () => {
  if (!running) return;
  request("setExceptionBreakpoints", { filters: exceptionFilters() }).catch(() => {});
  if (handler) sendBreakpoints(handler.path);
};

export function togglePauseOnExceptions() {
  pauseOnExceptions = !pauseOnExceptions;
  writeSetting("debug:exceptions", pauseOnExceptions ? "1" : null);
  sendExceptionFilters();
  render();
}

/** Saves an exception option and turns pausing on exceptions on. */
function setExceptionOption(key: string, value: string | null) {
  writeSetting(`${key}:${host.root()}`, value);
  pauseOnExceptions = true;
  writeSetting("debug:exceptions", "1");
  sendExceptionFilters();
  render();
}

/** Lists the options for pausing on exceptions: the classes, caught or only uncaught, and where they're thrown. */
export function exceptionOptions() {
  const classes = exceptionClasses();
  const skipped = skippedPaths();
  pick("Pause on exceptions", () => [
    { label: `Classes: ${classes.length ? classes.join(", ") : "every exception and error"}`, run: setExceptionClasses },
    uncaughtOnly()
      ? { label: "When: only uncaught", detail: "Choose to pause wherever one is thrown, caught or not", run: () => setExceptionOption("debug:exceptionUncaught", null) }
      : { label: "When: wherever thrown, caught or not", detail: "Choose to pause only on exceptions nobody catches", run: () => setExceptionOption("debug:exceptionUncaught", "1") },
    { label: `Skip exceptions thrown in: ${skipped.length ? skipped.join(", ") : "nothing"}`, run: setSkippedPaths },
  ]);
}

/** Asks for the path patterns where a thrown exception doesn't pause. */
function setSkippedPaths() {
  pick(
    "Paths where thrown exceptions don't pause, relative to the project and separated by commas, such as vendor/** (leave empty to pause anywhere)",
    (q) => {
      const patterns = q.split(",").map((p) => p.trim()).filter(Boolean);
      return [
        {
          label: patterns.length ? `Skip exceptions thrown in ${patterns.join(", ")}` : "Pause on exceptions wherever they're thrown",
          run: () => setExceptionOption("debug:exceptionSkip", patterns.length ? patterns.join(",") : null),
        },
      ];
    },
    0,
    { value: skippedPaths().join(", ") },
  );
}

/** Asks which exception classes to pause on, and turns pausing on exceptions on. */
export function setExceptionClasses() {
  pick(
    "Exception classes to pause on, separated by commas, such as App\\Exceptions\\PaymentFailed (leave empty for every exception)",
    (q) => {
      const classes = q.split(",").map((c) => c.trim().replace(/^\\/, "")).filter(Boolean);
      return [
        {
          label: classes.length ? `Pause on ${classes.join(", ")} and their subclasses` : "Pause on every exception and error",
          run: () => setExceptionOption("debug:exceptionClasses", classes.length ? classes.join(",") : null),
        },
      ];
    },
    0,
    { value: exceptionClasses().join(", ") },
  );
}

/**
 * Server paths and the local folders they map to, for code that runs in Docker, as typed: comma-separated
 * entries, each `/server/path` (the project folder) or `/server/path=/local/path`. Set by you, or else
 * where Sail or the project's Compose service mounts the project.
 */
async function serverPaths(): Promise<string> {
  const saved = readSetting(`debug:serverRoot:${host.root()}`);
  if (saved !== null) return saved;
  if (await usesSail(host.root())) return "/var/www/html";
  return (await composeService(host.root()))?.workdir ?? "";
}

const trimSlash = (p: string) => p.trim().replace(/(.)\/$/, "$1");

/** The mappings, server path to local path. A local path without a leading / is inside the project. */
function parseMappings(text: string): Record<string, string> {
  const mappings: Record<string, string> = {};
  for (const entry of text.split(",").filter((e) => e.trim())) {
    const [server, local = ""] = entry.split("=");
    const to = trimSlash(local);
    mappings[trimSlash(server)] = !to ? host.root() : to.startsWith("/") ? to : `${host.root()}/${to}`;
  }
  return mappings;
}

export async function setServerRoot() {
  pick(
    "Server paths, such as /var/www/html, or /server/path=/local/path for other folders, separated by commas (empty when PHP runs on this Mac)",
    (q) => {
      const mappings = Object.entries(parseMappings(q));
      return [
        {
          label: mappings.length ? mappings.map(([from, to]) => `${from} → ${to}`).join(", ") : "No mapping: PHP runs on this Mac",
          run: () => writeSetting(`debug:serverRoot:${host.root()}`, q.trim()),
        },
      ];
    },
    0,
    { value: await serverPaths() },
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
    await ensureTools();
    await invoke("lsp_start", { name: "xdebug", root: host.root() });
    await request("initialize", { adapterID: "php", clientID: "tusk", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path", supportsVariableType: true });
    await findHandler();
    // The adapter answers "launch" once it listens; breakpoints go out on its "initialized" event.
    const mappings = parseMappings(await serverPaths());
    const pathMappings = Object.keys(mappings).length ? mappings : undefined;
    await request("launch", { port: PORT, stopOnEntry: false, pathMappings, xdebugSettings: { max_children: 128, max_depth: 1, max_data: 2048 } });
    log(`Listening for Xdebug on port ${PORT}. Start a request or test with Xdebug enabled.`);
    for (const [from, to] of Object.entries(mappings)) log(`Mapping ${from} on the server to ${to}.`);
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
  runTo = null;
  stoppedThread = null;
  frames = [];
  setCurrent(null);
  log("Stopped listening.");
  render();
}

async function onEvent(event: string, body: any) {
  if (event === "initialized") {
    for (const path of new Set([...breakpoints.keys(), ...(handler ? [handler.path] : [])])) await sendBreakpoints(path);
    await request("setExceptionBreakpoints", { filters: exceptionFilters() }).catch(() => {});
    await request("configurationDone").catch(() => {});
  } else if (event === "stopped") {
    stoppedThread = body.threadId;
    if (runTo) {
      const { path } = runTo;
      runTo = null;
      sendBreakpoints(path);
    }
    const trace = await request<{ stackFrames: Frame[] }>("stackTrace", { threadId: body.threadId, startFrame: 0, levels: 50 });
    frames = trace.stackFrames;
    const exception = await exceptionPause(body, frames[0]);
    if (exception?.skip) return resume();
    showPanel();
    log(`Paused (${exception?.reason ?? body.reason ?? "breakpoint"})${exception?.text ? `: ${exception.text}` : body.text ? `: ${body.text}` : "."}`);
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

/**
 * For a pause on an exception, whether the options skip it, and at Laravel's handler, what reached it. At a throw
 * or PHP's fatal error, the top frame is where the exception was thrown. At the handler, the exception is `$e`.
 */
async function exceptionPause(body: any, top: Frame | undefined): Promise<{ skip: boolean; reason?: string; text?: string } | null> {
  if (!pauseOnExceptions) return null;
  const skipped = (path?: string) => !!path && thrownIn(path, host.root(), skippedPaths());
  if (body.reason === "exception") {
    // PHP's fatal error names the class, but the stack is gone by then, so only the class itself matches, not subclasses.
    const classes = uncaughtOnly() ? exceptionClasses() : [];
    const cls = uncaughtClass(body.text ?? "")?.toLowerCase();
    const other = classes.length > 0 && !classes.some((c) => c.toLowerCase() === cls);
    return { skip: other || skipped(top?.source?.path) };
  }
  if (!uncaughtOnly() || !top?.source?.path || top.source.path !== handler?.path || !handler.lines.includes(top.line)) return null;
  const value = (expression: string) =>
    request<{ result: string }>("evaluate", { expression, frameId: top.id, context: "repl" }).then((r) => r.result.replace(/^"|"$/g, ""), () => "");
  let file = await value("$e->getFile()");
  for (const [from, to] of Object.entries(parseMappings(await serverPaths()))) if (file.startsWith(from + "/")) file = to + file.slice(from.length);
  const text = `${await value("get_class($e)")}: ${await value("$e->getMessage()")}, thrown at ${file.slice(host.root().length + 1) || file}:${await value("$e->getLine()")}`;
  return { skip: skipped(file), reason: "uncaught exception, in Laravel's handler", text };
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
export const isListening = () => running;

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
    <div class="pane-splitter" data-split="frames"></div>
    <div class="debug-side">
      <div class="debug-watches">
        <ul aria-label="Watches"></ul>
        <input placeholder="Add a watch, such as $request->all(), and press Enter" aria-label="Add a watch expression" spellcheck="false" />
      </div>
      <div class="pane-splitter" data-split="watches"></div>
      <ul class="debug-vars" aria-label="Variables" data-empty="Variables appear here when execution pauses."></ul>
    </div>
  </div>
  <div class="pane-splitter" data-split="console"></div>
  <div class="debug-console">
    <pre></pre>
    <input placeholder="Evaluate an expression in the current frame, such as $request->all()" aria-label="Evaluate expression" spellcheck="false" />
  </div>`;
const q = <T extends HTMLElement>(sel: string) => panel.querySelector(sel) as T;
splitter(q('[data-split="frames"]'), { target: q(".debug-frames"), axis: "x", edge: "end", label: "Resize the call stack", min: 120, minRest: 200, save: "debug.frames" });
splitter(q('[data-split="watches"]'), { target: q(".debug-watches"), axis: "y", edge: "end", label: "Resize the watches", min: 40, minRest: 40, save: "debug.watches" });
splitter(q('[data-split="console"]'), { target: q(".debug-console"), axis: "y", edge: "start", label: "Resize the debug console", min: 50, minRest: 80, save: "debug.console" });

const runs: Record<string, () => unknown> = { exceptions: togglePauseOnExceptions, listen: startDebugging, resume, over: stepOver, into: stepInto, out: stepOut, stop: stopDebugging };
panel.querySelectorAll<HTMLButtonElement>("[data-run]").forEach((b) => (b.onclick = () => runs[b.dataset.run!]()));
q<HTMLElement>('[data-run="exceptions"]').oncontextmenu = (e) => (e.preventDefault(), exceptionOptions());

function showPanel() {
  showPanelView("Debug", panel, () => stopDebugging());
}
export const showDebugPanel = showPanel;

function render() {
  q<HTMLElement>(".debug-state").textContent = !running ? "Not listening" : stoppedThread !== null ? "Paused" : "Listening";
  const exceptions = q<HTMLElement>('[data-run="exceptions"]');
  exceptions.setAttribute("aria-pressed", String(pauseOnExceptions));
  const classes = host?.root() ? exceptionClasses() : [];
  const skipped = host?.root() ? skippedPaths() : [];
  exceptions.title = `Pause on ${host?.root() && uncaughtOnly() ? "uncaught " : ""}${classes.length ? classes.join(", ") : "exceptions"}${skipped.length ? ` not thrown in ${skipped.join(", ")}` : ""}. Right-click for options`;
  exceptions.classList.toggle("on", pauseOnExceptions);
  const enabled: Record<string, boolean> = { exceptions: true, listen: !running, resume: isPaused(), over: isPaused(), into: isPaused(), out: isPaused(), stop: running };
  panel.querySelectorAll<HTMLButtonElement>("[data-run]").forEach((b) => (b.disabled = !enabled[b.dataset.run!]));
  q<HTMLElement>(".debug-frames").replaceChildren(
    ...frames.map((f) => {
      const li = document.createElement("li");
      const file = f.source?.path ? f.source.path.slice(host.root().length + 1) || f.source.path : f.source?.name ?? "";
      li.innerHTML = `<span class="fn"></span><span class="loc"></span>`;
      li.querySelector(".fn")!.textContent = f.name;
      // The left-to-right mark keeps a path such as .env in order in the right-to-left box that ellipsizes its start.
      li.querySelector(".loc")!.textContent = `\u200E${file}:${f.line}`;
      li.classList.toggle("selected", f.source?.path === current?.path && f.line === current?.line);
      li.onclick = () => selectFrame(f);
      return li;
    }),
  );
  if (!frames.length) {
    q<HTMLElement>(".debug-vars").replaceChildren();
    renderWatches();
  }
}

// ---- Watches ----
// Expressions evaluated in the selected frame each time execution pauses, saved per project.

const watchKey = () => `watches:${host.root()}`;
const loadWatches = (): string[] => JSON.parse(readSetting(watchKey()) ?? "[]");
const saveWatches = (list: string[]) => writeSetting(watchKey(), list.length ? JSON.stringify(list) : null);

async function renderWatches() {
  const list = q<HTMLElement>(".debug-watches ul");
  const rows = await Promise.all(
    loadWatches().map(async (expression, i) => {
      let v: Variable = { name: expression, value: "not available while running", variablesReference: 0 };
      if (selectedFrame && stoppedThread !== null) {
        try {
          const r = await request<{ result: string; type?: string; variablesReference: number }>("evaluate", { expression, frameId: selectedFrame.id, context: "watch" });
          v = { name: expression, value: r.result, type: r.type, variablesReference: r.variablesReference };
        } catch (e) {
          v = { name: expression, value: String(e instanceof Error ? e.message : e), variablesReference: 0 };
        }
      }
      const li = variableRow(v);
      const remove = document.createElement("button");
      remove.className = "watch-remove codicon codicon-close";
      remove.title = "Remove the watch";
      remove.onclick = (e) => {
        e.stopPropagation();
        saveWatches(loadWatches().filter((_, j) => j !== i));
        renderWatches();
      };
      li.querySelector(".var")!.append(remove);
      return li;
    }),
  );
  list.replaceChildren(...rows);
}

q<HTMLInputElement>(".debug-watches input").onkeydown = (e) => {
  const input = e.currentTarget as HTMLInputElement;
  if (e.key !== "Enter" || !input.value.trim()) return;
  saveWatches([...loadWatches(), input.value.trim()]);
  input.value = "";
  renderWatches();
};

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
    ...scopes.map((s, i) => variableRow({ name: s.name, value: "", variablesReference: s.variablesReference }, undefined, i === 0)),
  );
  renderWatches();
}

/**
 * A tree row for a variable; rows with children expand on click, loading them on demand. With `parent`, the
 * reference of the scope or value holding it, double-clicking the value edits it.
 */
function variableRow(v: Variable, parent?: number, open = false): HTMLLIElement {
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
        children.replaceChildren(...variables.map((c) => variableRow(c, v.variablesReference)));
      } else children.replaceChildren();
    };
    row.onclick = toggle;
    if (open) toggle();
  }
  if (parent !== undefined) {
    const value = row.querySelector<HTMLElement>(".value")!;
    value.title = "Double-click to change the value";
    value.ondblclick = (e) => {
      e.stopPropagation();
      const input = document.createElement("input");
      input.className = "var-edit";
      input.value = v.value;
      input.title = "A PHP expression, such as 'text' in quotes, 42, or null";
      value.replaceChildren(" = ", input);
      input.focus();
      input.select();
      let done = false;
      const finish = async (save: boolean) => {
        if (done) return;
        done = true;
        if (save && input.value !== v.value) {
          try {
            // The adapter evaluates the text as PHP, so strings need quotes.
            await request("setVariable", { variablesReference: parent, name: v.name, value: input.value });
            // The reply echoes the text typed, so the value as PHP now shows it comes from the parent again.
            const { variables } = await request<{ variables: Variable[] }>("variables", { variablesReference: parent });
            const updated = variables.find((c) => c.name === v.name);
            if (updated) li.replaceWith(variableRow(updated, parent));
            return;
          } catch (err) {
            log(`Can't set ${v.name}: ${err}`);
          }
        }
        value.textContent = v.value ? ` = ${v.value}` : "";
      };
      input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      };
      input.onblur = () => finish(false);
      input.onclick = (e) => e.stopPropagation();
    };
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
