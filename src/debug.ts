// PHP debugging with Xdebug, through the bundled adapter from VS Code's PHP Debug extension.
// The adapter speaks the Debug Adapter Protocol (DAP) over the same bridge as the language servers.
import { invoke } from "@tauri-apps/api/core";
import { appCacheDir } from "@tauri-apps/api/path";
import { listen } from "@tauri-apps/api/event";
import { breakpointsView } from "./breakpointsview";
import { h } from "./dom";
import { monaco } from "./editor";
import { type MenuItem, showMenu } from "./files";
import { listNav } from "./listnav";
import { ensureTools } from "./lsp";
import { confirm, pick } from "./palette";
import { composeService, usesSail } from "./sail";
import { completions, handlerLines, inlineValues, portInUse, thrownIn, uncaughtClass, xdebugEnvFor } from "./debugexceptions";
import { onSettings, openSettings, registerSettings, updateSetting } from "./settings";
import { splitter } from "./splitter";
import { errorText, showError, status } from "./status";
import { onProjectValue, projectScope, projectValue, type Scope, setProjectValue, shareItem } from "./projectstate";
import { projectRelative } from "./projectstatedata";
import { showPanelView } from "./terminal";
import { isAbsolute, mod } from "./platform.ts";

type Host = { root(): string; openAt(path: string, line: number): Promise<unknown>; status(text: string): void };
type Frame = { id: number; name: string; line: number; source?: { path?: string; name?: string } };
type Variable = { name: string; value: string; type?: string; variablesReference: number; evaluateName?: string };

const debugSettings = registerSettings(
  "Debugger",
  { debugPort: 9003, debugMaxChildren: 128, debugMaxData: 2048, debugBreakAtFirstLine: false, debugInlineValues: true, debugIdeKey: "1", debugContainerHost: "host.docker.internal" },
  [
    { key: "debugPort", label: "Xdebug port", type: "number", min: 1024, max: 65535, help: "The port the debugger listens on; Xdebug's default is 9003. Runs the editor starts connect to it. For PHP you start yourself, set xdebug.client_port to match." },
    { key: "debugMaxChildren", label: "Items to load per array or object", type: "number", min: 1, max: 10000, help: "Larger arrays show this many items." },
    { key: "debugMaxData", label: "Longest string to load, in bytes", type: "number", min: 64, max: 10000000, help: "Longer strings are cut off in variables and watches." },
    { key: "debugBreakAtFirstLine", label: "Pause at the first line of each script", type: "checkbox", help: "Every request, test, or command that connects pauses before its first line." },
    { key: "debugInlineValues", label: "Show variable values in the editor while paused", type: "checkbox" },
    { key: "debugIdeKey", label: "IDE key", type: "text", placeholder: "1", help: "The XDEBUG_SESSION value the editor's runs and HTTP requests send. Match xdebug.trigger_value if your php.ini sets one." },
    { key: "debugContainerHost", label: "Host that PHP in Docker connects to", type: "text", placeholder: "host.docker.internal", help: "Xdebug's client_host for tests and commands that run in a container." },
  ],
);

/** Environment variables that make a PHP process connect to the debugger; with `clientHost`, from a container. */
export const xdebugEnv = (clientHost?: string) => xdebugEnvFor(debugSettings.debugPort, debugSettings.debugIdeKey, clientHost);
/** The Xdebug environment for PHP in a container, which reaches this Mac through the container host setting. */
export const containerXdebugEnv = () => xdebugEnv(debugSettings.debugContainerHost.trim() || "host.docker.internal");

let herd: Promise<string> | undefined;
/**
 * Herd's PHP loads Xdebug only under `herd debug` and `herd coverage`, so the editor's debug, coverage, and profiled
 * runs load Herd's copy from a folder PHP_INI_SCAN_DIR adds. "" when PHP has Xdebug already, or Herd has no copy for
 * its version.
 */
export const herdXdebug = () =>
  (herd ??= (async () => {
    const out = await invoke<string>("run_capture", { cwd: "/", program: "php", args: ["-r", 'echo extension_loaded("xdebug") ? "" : PHP_MAJOR_VERSION . PHP_MINOR_VERSION . " " . php_uname("m");'], input: null }).catch(() => "");
    const [version, arch] = out.trim().split("\n").pop()!.split(" ");
    if (!/^\d+$/.test(version ?? "")) return "";
    // ponytail: only Herd's default install location; look in ~/Applications too if someone installs it there.
    const lib = "/Applications/Herd.app/Contents/Resources/xdebug";
    const found = (await invoke<string>("run_capture", { cwd: "/", program: "/bin/sh", args: ["-c", `ls "${lib}"/xdebug-${version}-*.so 2>/dev/null; true`], input: null }).catch(() => "")).split("\n").filter(Boolean);
    const so = found.find((f) => f.includes(arch)) ?? found[0];
    if (!so) return "";
    const dir = `${await appCacheDir()}/herd-xdebug`;
    await invoke("create_dir", { path: dir });
    await invoke("write_file", { path: `${dir}/xdebug.ini`, contents: `; Written by the editor for debug, coverage, and profiled runs: Herd's Xdebug.\nzend_extension="${so}"\n` });
    return dir;
  })());

let scanned: Promise<string> | undefined;
/** PHP's own folders of extra .ini files, which setting PHP_INI_SCAN_DIR would otherwise replace. */
const scanDir = () =>
  (scanned ??= invoke<string>("run_capture", { cwd: "/", program: "php", args: ["--ini"], input: null })
    .then((out) => out.match(/^Scan for additional \.ini files in: (.*)$/m)?.[1].trim() ?? "")
    .then((dir) => (dir === "(none)" ? "" : dir))
    .catch(() => ""));

/** PHP_INI_SCAN_DIR adding the folders in `dirs` ("" is none) to PHP's own, or nothing when there are none. */
export async function iniDirsEnv(dirs: string[]): Promise<string[]> {
  dirs = dirs.filter(Boolean);
  return dirs.length ? [`PHP_INI_SCAN_DIR=${[await scanDir(), ...dirs].join(":")}`] : [];
}

/** The trigger value for a request's XDEBUG_SESSION. */
export const debugIdeKey = () => debugSettings.debugIdeKey.trim() || "1";

let host: Host;

// ---- DAP transport ----

let seq = 1;
const pending = new Map<number, { resolve(v: any): void; reject(e: any): void }>();
let running = false;
/** While the listener starts, so the panel can say so. */
let starting = false;
/** Xdebug connections the adapter has open, as threads: a request, test, or command being debugged. */
const threads = new Set<number>();

const send = (msg: object) => invoke("lsp_send", { name: "xdebug", msg: JSON.stringify({ seq: seq++, ...msg }) });

function request<T = any>(command: string, args: object = {}): Promise<T> {
  const id = seq;
  const result = new Promise<T>((resolve, reject) => pending.set(id, { resolve, reject }));
  // The adapter may be gone, such as after it crashed: fail the request rather than wait forever.
  send({ type: "request", command, arguments: args }).catch((e) => {
    pending.get(id)?.reject(e);
    pending.delete(id);
  });
  return result;
}

/** Whether this listener's adapter runs, so a stopped adapter's last events, such as during a restart, are dropped. */
let adapterUp = false;
/** Starts and stops of the listener, so a request that fails because the listener stopped doesn't report it. */
let generation = 0;
/** Logs a failed request, unless the listener stopped or restarted since it was sent. */
function failed(what: string) {
  const at = generation;
  return (e: unknown) => void (at === generation && running && log(`${what}: ${errorText(e)}`));
}

listen<string>("lsp:xdebug", ({ payload }) => {
  const msg = JSON.parse(payload);
  if (msg.type === "response") {
    const p = pending.get(msg.request_seq);
    pending.delete(msg.request_seq);
    msg.success ? p?.resolve(msg.body ?? {}) : p?.reject(new Error(msg.message || msg.body?.error?.format || `${msg.command} failed`));
  } else if (msg.type === "event" && adapterUp) onEvent(msg.event, msg.body ?? {});
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

/** Breakpoints as the project state keeps them (`breakpoints`): by path relative to the project, [line, options] pairs. */
type SavedBreakpoints = Record<string, [number, BreakpointOptions][]>;
const saveError = (what: string) => (e: unknown) => showError(`Can't save ${what}`, e);

function persist() {
  const root = host.root();
  const data: SavedBreakpoints = Object.fromEntries([...breakpoints].filter(([, b]) => b.size).map(([p, b]) => [projectRelative(root, p), [...b]]));
  setProjectValue("breakpoints", Object.keys(data).length ? data : undefined).catch(saveError("breakpoints"));
}

/** Loads the project's saved breakpoints. Call when a folder opens. */
export function loadBreakpoints() {
  const before = [...breakpoints.keys()];
  breakpoints.clear();
  const root = host.root();
  for (const [path, list] of Object.entries(projectValue<SavedBreakpoints>("breakpoints") ?? {}))
    if (Array.isArray(list)) breakpoints.set(isAbsolute(path) ? path : `${root}/${path}`, new Map(list.filter((b) => Array.isArray(b) && typeof b[0] === "number").map(([line, o]) => [line, o ?? {}])));
  for (const path of new Set([...before, ...breakpoints.keys()])) {
    renderBreakpoints(path);
    if (running) sendBreakpoints(path);
  }
  view.refresh();
}
// Shared breakpoints that change in tusk.json, such as after git pull, show at once.
onProjectValue("breakpoints", loadBreakpoints);

function update(path: string, change: (b: Breakpoints) => void) {
  const b = breakpointsOf(path);
  change(b);
  breakpoints.set(path, b);
  renderBreakpoints(path);
  persist();
  if (running) sendBreakpoints(path);
  view.refresh();
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

/** Removes every breakpoint in a file, or, after you confirm, in all files. */
async function removeAll(path?: string) {
  const count = [...breakpoints.keys()].reduce((n, p) => n + breakpointsOf(p).size, 0);
  if (!path && count > 1 && !(await confirm(`Remove all ${count} breakpoints?`, "Remove All"))) return;
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
  if (handler?.path === path && pauseOnExceptions() && uncaughtOnly())
    for (const line of handler.lines) if (!enabled.some(([l]) => l === line)) enabled.push([line, { condition: exceptionClasses().map((c) => `$e instanceof \\${c}`).join(" || ") || undefined }]);
  return request("setBreakpoints", {
    source: { path },
    breakpoints: enabled
      .sort(([a], [b]) => a - b)
      .map(([line, { disabled, ...o }]) => Object.fromEntries(Object.entries({ line, ...o }).filter(([, v]) => v !== undefined && v !== ""))),
  }).catch(failed(`Can't set the breakpoints in ${projectRelative(host.root(), path)}`));
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
  items.push("-", { label: "View Breakpoints…", keys: "⇧⌘F8", run: () => showBreakpoints(path, line) });
  if (all.size) items.push({ label: "Remove Breakpoints in File", run: () => removeAll(path) });
  if (all.size || elsewhere) items.push({ label: "Remove All Breakpoints…", run: () => removeAll() });
  return items;
}

/** Adds breakpoints to an editor's gutter: click toggles one. The gutter's context menu edits them. */
export function attachDebugger(editor: monaco.editor.IStandaloneCodeEditor) {
  editor.updateOptions({ glyphMargin: true });
  editor.onMouseDown((e) => {
    const model = editor.getModel();
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.event.leftButton || !model || model.uri.scheme !== "file") return;
    // A test's run button and the super method icons open their own menus.
    if (e.target.element?.matches(".test-run, .super-method")) return;
    toggleBreakpoint(model.uri.fsPath, e.target.position!.lineNumber);
  });
}

monaco.editor.onDidCreateModel((model) => {
  const path = model.uri.fsPath;
  if (model.uri.scheme !== "file") return;
  renderBreakpoints(path);
  renderCurrentLine();
  // Keep the saved lines in step with edits that move breakpoints.
  model.onDidChangeContent(() => {
    if (!decorations.has(path)) return;
    breakpoints.set(path, breakpointsOf(path));
    if (breakpoints.get(path)?.size) view.refresh();
  });
  model.onWillDispose(() => decorations.delete(path));
});

// ---- Exceptions and path mappings ----

/** How to pause on exceptions, per project (`debugExceptions` in the project state). */
export type ExceptionOptions = { pause?: boolean; classes?: string[]; uncaughtOnly?: boolean; skip?: string[] };
const exceptionOptionsNow = () => (host?.root() ? projectValue<ExceptionOptions>("debugExceptions") : undefined) ?? {};
const pauseOnExceptions = () => !!exceptionOptionsNow().pause;
/** The classes to pause on. Empty means every exception and error. */
const exceptionClasses = (): string[] => exceptionOptionsNow().classes ?? [];
/** Whether to pause only on exceptions nobody catches, per project. Otherwise every throw pauses, caught or not. */
const uncaughtOnly = () => !!exceptionOptionsNow().uncaughtOnly;
/** Path patterns, relative to the project, where a thrown exception doesn't pause, such as vendor/**. Per project. */
const skippedPaths = (): string[] => exceptionOptionsNow().skip ?? [];
// The adapter makes each filter an Xdebug exception breakpoint on that class name, and Xdebug also matches
// subclasses, so Exception and Error cover every Throwable. Xdebug pauses at the throw, before PHP looks for a
// catch, so it can't tell caught from uncaught there. For uncaught only, the filter is PHP's "Fatal error"
// instead, which an uncaught exception ends in; the adapter passes the name unquoted, so it carries its own quotes.
const exceptionFilters = () => (!pauseOnExceptions() ? [] : uncaughtOnly() ? ['"Fatal error"'] : exceptionClasses().length ? exceptionClasses() : ["Exception", "Error"]);

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
  request("setExceptionBreakpoints", { filters: exceptionFilters() }).catch(failed("Can't set the exception breakpoints"));
  if (handler) sendBreakpoints(handler.path);
};

export function togglePauseOnExceptions() {
  setExceptionOption({ pause: !pauseOnExceptions() });
}

/** Saves exception options: any option turns pausing on exceptions on, unless it says otherwise. */
function setExceptionOption(change: ExceptionOptions) {
  setProjectValue("debugExceptions", { ...exceptionOptionsNow(), pause: true, ...change }).catch(saveError("the exception options"));
  sendExceptionFilters();
  render();
  view.refresh();
}
onProjectValue("debugExceptions", () => (sendExceptionFilters(), render(), view.refresh()));

/** Shows the options for pausing on exceptions: the Breakpoints tab, at its exception breakpoints. */
export function exceptionOptions() {
  view.show({ exceptions: true });
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
          run: () => setExceptionOption({ skip: patterns }),
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
          run: () => setExceptionOption({ classes }),
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
  const saved = projectValue<string>("debugPathMappings");
  if (typeof saved === "string") return saved;
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
    mappings[trimSlash(server)] = !to ? host.root() : isAbsolute(to) ? to : `${host.root()}/${to}`;
  }
  return mappings;
}

export async function setServerRoot() {
  pick(
    "Server paths, such as /var/www/html, or /server/path=/local/path for other folders, separated by commas (empty when PHP runs on this Mac)",
    (q) => {
      const mappings = Object.entries(parseMappings(q));
      const shared = projectScope("debugPathMappings") === "shared";
      const save = (scope?: Scope) => setProjectValue("debugPathMappings", q.trim(), scope).catch(saveError("the server paths"));
      return [
        {
          label: mappings.length ? mappings.map(([from, to]) => `${from} → ${to}`).join(", ") : "No mapping: PHP runs on this Mac",
          detail: shared ? "Saves in tusk.json, shared with the project" : "Saves on this Mac",
          run: () => save(),
        },
        shared
          ? { label: "Save on this Mac only", detail: "Moves the paths out of tusk.json", run: () => save("local") }
          : { label: "Save and share in tusk.json", detail: "Your team gets the same paths when you commit the file", run: () => save("shared") },
      ];
    },
    0,
    { value: await serverPaths() },
  );
}

// ---- Breakpoints view ----

const view = breakpointsView({
  root: () => host?.root() ?? "",
  list: () =>
    [...breakpoints.keys()]
      .map((path): [string, [number, BreakpointOptions][]] => [path, [...breakpointsOf(path)].sort(([a], [b]) => a - b)])
      .filter(([, list]) => list.length)
      .sort(([a], [b]) => a.localeCompare(b)),
  set: (path, line, options) => update(path, (b) => (options ? b.set(line, options) : b.delete(line))),
  setAll: (path, change) => update(path, (b) => b.forEach((o, line) => b.set(line, change(o)))),
  removeAll,
  openAt: (path, line) => host.openAt(path, line),
  exceptions: exceptionOptionsNow,
  setExceptions: setExceptionOption,
  share: () => shareItem("debugExceptions", "exception options"),
  setClasses: setExceptionClasses,
  setSkipped: setSkippedPaths,
});

/** Shows the Breakpoints tab, with the breakpoint on `line` of `path` selected when there's one. */
export function showBreakpoints(path?: string, line?: number) {
  view.show(path && line && breakpointsOf(path).has(line) ? { path, line } : {});
}

// ---- Session ----

let stoppedThread: number | null = null;
let frames: Frame[] = [];
let current: { path: string; line: number } | null = null;
const currentLine = new Map<string, string[]>();
/** Why the stack couldn't load, shown in its place with Retry. */
let stackError = "";
/** The settings the listener started with, to restart it when they change. */
let launched = "";
const launchKey = () => JSON.stringify([debugSettings.debugPort, debugSettings.debugMaxChildren, debugSettings.debugMaxData, debugSettings.debugBreakAtFirstLine]);

/** Starts listening for Xdebug connections on the port in the Debugger settings. */
export async function startDebugging() {
  if (running) return;
  showPanel();
  running = true;
  starting = true;
  render();
  const port = debugSettings.debugPort;
  const key = launchKey();
  try {
    await ensureTools();
    await invoke("lsp_start", { name: "xdebug", root: host.root() });
    adapterUp = true;
    await request("initialize", { adapterID: "php", clientID: "tusk", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path", supportsVariableType: true });
    await findHandler();
    // The adapter answers "launch" once it listens; breakpoints go out on its "initialized" event.
    const mappings = parseMappings(await serverPaths());
    const pathMappings = Object.keys(mappings).length ? mappings : undefined;
    await request("launch", {
      port,
      stopOnEntry: debugSettings.debugBreakAtFirstLine,
      pathMappings,
      xdebugSettings: { max_children: debugSettings.debugMaxChildren, max_depth: 1, max_data: debugSettings.debugMaxData },
    });
    starting = false;
    launched = key;
    // Settings that changed while the listener started apply now.
    if (key !== launchKey()) queueMicrotask(() => onLaunchSettings());
    log(`Listening for Xdebug on port ${port}.`);
    for (const [from, to] of Object.entries(mappings)) log(`Mapping ${from} on the server to ${to}.`);
  } catch (e) {
    starting = false;
    await stopDebugging(true);
    if (portInUse(errorText(e))) return portBusy(port);
    log(`Can't start the debugger: ${errorText(e)}`);
    showError("Can't start the debugger", e, { label: "Retry", run: startDebugging });
  }
  render();
}

/** Explains that another program has the port, naming it when lsof can, and offers another port. */
async function portBusy(port: number) {
  const owner = await invoke<string>("run_capture", { cwd: "/", program: "lsof", args: ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fcp"], input: null, anyStatus: true }).catch(() => "");
  const name = /^c(.+)$/m.exec(owner)?.[1];
  const pid = /^p(\d+)$/m.exec(owner)?.[1];
  const who = name ? `${name}${pid ? ` (process ${pid})` : ""}` : "another program";
  const text = `Port ${port} is in use by ${who}, so the debugger can't listen for Xdebug. Quit the program that listens there, such as another editor's debugger, or choose another port.`;
  log(text);
  showError(text, undefined, { label: "Choose Another Port", run: choosePort });
}

/** Asks for the port to listen on, saves it in the Debugger settings, and starts listening. */
export function choosePort() {
  pick(
    "The port to listen for Xdebug on, from 1024 to 65535 (Xdebug's default is 9003)",
    (q) => {
      const port = Number(q.trim());
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return [{ label: "Type a port from 1024 to 65535", run: () => {} }];
      return [
        {
          label: `Listen on port ${port}`,
          detail: "Saves it in the Debugger settings. Runs the editor starts use it; for PHP you start yourself, set xdebug.client_port to match.",
          run: async () => {
            (updateSetting as (key: string, value: unknown) => void)("debugPort", port);
            if (running) await stopDebugging();
            startDebugging();
          },
        },
      ];
    },
    0,
    { value: String(debugSettings.debugPort + 1) },
  );
}

/** Stops listening. `quiet` skips the log line, for a start that failed. */
export async function stopDebugging(quiet = false) {
  if (!running) return;
  generation++;
  adapterUp = false;
  await Promise.race([request("disconnect", {}).catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
  await invoke("lsp_stop", { name: "xdebug" }).catch(() => {});
  for (const p of pending.values()) p.reject(new Error("The debugger stopped"));
  pending.clear();
  running = false;
  launched = "";
  runTo = null;
  stoppedThread = null;
  threads.clear();
  frames = [];
  stackError = "";
  setCurrent(null);
  if (quiet !== true) log("Stopped listening.");
  render();
}

// Settings the listener started with apply by listening again, unless something is being debugged.
function onLaunchSettings() {
  if (!running || !launched || launched === launchKey()) return;
  if (threads.size) return log("The new debugger settings apply when you stop and start listening again.");
  log("Listening again with the new debugger settings.");
  launched = ""; // One restart at a time; startDebugging checks the settings again when it's done.
  stopDebugging(true).then(startDebugging);
}
onSettings(onLaunchSettings);

async function onEvent(event: string, body: any) {
  if (event === "initialized") {
    // A restart while these go out, such as for a new port, ends this listener's setup.
    const at = generation;
    for (const path of new Set([...breakpoints.keys(), ...(handler ? [handler.path] : [])])) if (at === generation) await sendBreakpoints(path);
    if (at !== generation) return;
    await request("setExceptionBreakpoints", { filters: exceptionFilters() }).catch(failed("Can't set the exception breakpoints"));
    await request("configurationDone").catch(() => {});
  } else if (event === "stopped") {
    stoppedThread = body.threadId;
    threads.add(body.threadId);
    if (runTo) {
      const { path } = runTo;
      runTo = null;
      sendBreakpoints(path);
    }
    if (!(await loadStack())) return;
    const exception = await exceptionPause(body, frames[0]);
    if (exception?.skip) return resume();
    showPanel();
    log(`Paused (${exception?.reason ?? body.reason ?? "breakpoint"})${exception?.text ? `: ${exception.text}` : body.text ? `: ${body.text}` : "."}`);
    await selectFrame(frames[0]);
  } else if (event === "continued") {
    // The adapter continues a paused thread on its own only when its connection closes.
    if (body.threadId === stoppedThread) log("PHP disconnected while paused.");
    clearPause();
  } else if (event === "thread") {
    if (body.reason === "started") threads.add(body.threadId);
    else if (body.reason === "exited") {
      threads.delete(body.threadId);
      if (body.threadId === stoppedThread) clearPause();
    }
    render();
  } else if (event === "output" && body.output?.trim()) {
    // A listener that can't start also prints Node's error object; the start's own message explains it.
    if (!(starting && portInUse(body.output))) log(body.output.trimEnd());
  } else if (event === "terminated") {
    stopDebugging();
  }
}

function clearPause() {
  stoppedThread = null;
  frames = [];
  stackError = "";
  setCurrent(null);
  render();
}

/** Reads the paused thread's call stack. On failure, the stack shows why, with Retry. Returns whether it loaded. */
async function loadStack(): Promise<boolean> {
  if (stoppedThread === null) return false;
  try {
    const trace = await request<{ stackFrames: Frame[] }>("stackTrace", { threadId: stoppedThread, startFrame: 0, levels: 50 });
    frames = trace.stackFrames;
    stackError = "";
    return true;
  } catch (e) {
    frames = [];
    stackError = `Can't read the call stack: ${errorText(e)}`;
    log(stackError);
    showPanel();
    render();
    return false;
  }
}

/**
 * For a pause on an exception, whether the options skip it, and at Laravel's handler, what reached it. At a throw
 * or PHP's fatal error, the top frame is where the exception was thrown. At the handler, the exception is `$e`.
 */
async function exceptionPause(body: any, top: Frame | undefined): Promise<{ skip: boolean; reason?: string; text?: string } | null> {
  if (!pauseOnExceptions()) return null;
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

const stepNames = { continue: "resume", next: "step over", stepIn: "step into", stepOut: "step out" };

async function step(command: "continue" | "next" | "stepIn" | "stepOut") {
  if (stoppedThread === null) return;
  const threadId = stoppedThread;
  const before = { frames, selected: selectedFrame };
  stoppedThread = null;
  // The adapter doesn't always send "continued", so clear the paused state here.
  frames = [];
  setCurrent(null);
  render();
  try {
    await request(command, { threadId });
  } catch (e) {
    // Still paused unless the connection went away, which its "thread exited" event says.
    if (threads.has(threadId) && stoppedThread === null) {
      stoppedThread = threadId;
      frames = before.frames;
      await selectFrame(before.selected ?? frames[0]);
    }
    log(`Can't ${stepNames[command]}: ${errorText(e)}`);
    showError(`Can't ${stepNames[command]}`, e);
  }
}

export const resume = () => step("continue");
export const stepOver = () => step("next");
export const stepInto = () => step("stepIn");
export const stepOut = () => step("stepOut");
export const isPaused = () => stoppedThread !== null;
export const isListening = () => running;

// ---- Current line and inline values ----

let inline: { path: string; ids: string[] } | null = null;

function setCurrent(location: { path: string; line: number } | null) {
  current = location;
  for (const [path, ids] of currentLine) modelFor(path)?.deltaDecorations(ids, []);
  currentLine.clear();
  showInlineValues(null);
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

/** Shows the frame's local values at the end of the lines above the paused line that use them, or clears them. */
function showInlineValues(locals: Variable[] | null) {
  if (inline) modelFor(inline.path)?.deltaDecorations(inline.ids, []);
  inline = null;
  if (!locals || !current || !debugSettings.debugInlineValues) return;
  const model = modelFor(current.path);
  if (!model) return;
  const values = new Map(locals.map((v) => [v.name, v.value]));
  const rows = inlineValues(model.getLinesContent(), current.line, values);
  inline = {
    path: current.path,
    ids: model.deltaDecorations(
      [],
      rows.map((r) => {
        const end = model.getLineMaxColumn(r.line);
        return { range: new monaco.Range(r.line, end, r.line, end), options: { after: { content: `   ${r.text}`, inlineClassName: "debug-inline-value" } } };
      }),
    ),
  };
}

// ---- Panel ----

const panel = document.createElement("div");
panel.className = "debug";
panel.innerHTML = `
  <div class="debug-toolbar" role="toolbar" aria-label="Debugger">
    <button data-run="listen" title="Start listening for Xdebug connections" aria-label="Listen"><span class="codicon codicon-debug-start"></span></button>
    <button data-run="stop" title="Stop listening (⌘F2)" aria-label="Stop"><span class="codicon codicon-debug-stop"></span></button>
    <span class="sep"></span>
    <button data-run="resume" title="Resume (F9)" aria-label="Resume"><span class="codicon codicon-debug-continue"></span></button>
    <button data-run="over" title="Step Over (F8)" aria-label="Step Over"><span class="codicon codicon-debug-step-over"></span></button>
    <button data-run="into" title="Step Into (F7)" aria-label="Step Into"><span class="codicon codicon-debug-step-into"></span></button>
    <button data-run="out" title="Step Out (⇧F8)" aria-label="Step Out"><span class="codicon codicon-debug-step-out"></span></button>
    <span class="sep"></span>
    <button data-run="breakpoints" title="View Breakpoints (⇧⌘F8)" aria-label="View Breakpoints"><span class="codicon codicon-debug-breakpoint"></span></button>
    <button data-run="exceptions" title="Pause on exceptions" aria-label="Pause on exceptions"><span class="codicon codicon-zap"></span></button>
    <button data-run="exceptionOptions" class="debug-more" title="Exception breakpoint options" aria-label="Exception breakpoint options"><span class="codicon codicon-chevron-down"></span></button>
    <button data-run="settings" title="Debugger settings: port, limits, and more" aria-label="Debugger settings"><span class="codicon codicon-settings-gear"></span></button>
    <span class="debug-state" role="status"></span>
  </div>
  <div class="debug-body">
    <ul class="debug-frames" role="listbox" aria-label="Call stack"></ul>
    <div class="pane-splitter" data-split="frames"></div>
    <div class="debug-side">
      <div class="debug-watches">
        <ul role="tree" aria-label="Watches"></ul>
        <input placeholder="Add a watch, such as $request->all(), and press Enter" aria-label="Add a watch expression" spellcheck="false" />
      </div>
      <div class="pane-splitter" data-split="watches"></div>
      <ul class="debug-vars" role="tree" aria-label="Variables" data-empty="Variables appear here when execution pauses."></ul>
    </div>
  </div>
  <div class="pane-splitter" data-split="console"></div>
  <div class="debug-console">
    <pre></pre>
    <div class="debug-eval">
      <ul class="debug-complete" role="listbox" aria-label="Variable names" hidden></ul>
      <input placeholder="Evaluate an expression in the current frame, such as $request->all(); ↑ for history, Tab completes $names" aria-label="Evaluate expression" spellcheck="false" autocomplete="off" role="combobox" aria-expanded="false" />
    </div>
  </div>`;
const q = <T extends HTMLElement>(sel: string) => panel.querySelector(sel) as T;
splitter(q('[data-split="frames"]'), { target: q(".debug-frames"), axis: "x", edge: "end", label: "Resize the call stack", min: 120, minRest: 200, save: "debug.frames" });
splitter(q('[data-split="watches"]'), { target: q(".debug-watches"), axis: "y", edge: "end", label: "Resize the watches", min: 40, minRest: 40, save: "debug.watches" });
splitter(q('[data-split="console"]'), { target: q(".debug-console"), axis: "y", edge: "start", label: "Resize the debug console", min: 50, minRest: 80, save: "debug.console" });

const runs: Record<string, () => unknown> = {
  exceptions: togglePauseOnExceptions,
  exceptionOptions,
  breakpoints: () => showBreakpoints(),
  settings: () => openSettings("Debugger"),
  listen: startDebugging,
  resume,
  over: stepOver,
  into: stepInto,
  out: stepOut,
  stop: stopDebugging,
};
panel.querySelectorAll<HTMLButtonElement>("[data-run]").forEach((b) => (b.onclick = () => runs[b.dataset.run!]()));
q<HTMLElement>('[data-run="exceptions"]').oncontextmenu = (e) => (e.preventDefault(), exceptionOptions());

function showPanel() {
  showPanelView("Debug", panel, () => stopDebugging());
}
export const showDebugPanel = showPanel;

const framesList = q<HTMLElement>(".debug-frames");
const frameNav = listNav(framesList, {
  onSelect: (row) => {
    const f = frames[Number(row.dataset.key)];
    if (f && f !== selectedFrame) selectFrame(f);
  },
});

/** What the call stack shows while there's none: the state, how to get a pause, and a way to act. */
function emptyStack(): HTMLElement {
  const port = debugSettings.debugPort;
  const row = (text: string, ...buttons: [string, () => unknown][]) =>
    h("li", { class: "debug-empty" }, h("p", {}, text), ...buttons.map(([label, run]) => h("button", { class: "debug-link", onclick: run }, label)));
  if (stackError) return row(stackError, ["Retry", () => loadStack().then((ok) => void (ok && selectFrame(frames[0])))]);
  if (!running) return row("Not listening for Xdebug.", ["Start Listening", startDebugging]);
  if (starting) return row(`Starting to listen on port ${port}…`);
  if (threads.size) return row("Running. The call stack shows when execution pauses at a breakpoint.");
  return row(
    `Listening on port ${port} and waiting for PHP to connect. Start it with Xdebug's trigger: turn on the Xdebug browser extension, add XDEBUG_TRIGGER=1 to a URL or a command's environment, click Debug above a test, or run Start Debug Server.`,
    ["Stop", stopDebugging],
  );
}

function stateText() {
  if (!running) return "Not listening";
  if (starting) return "Starting…";
  if (stoppedThread !== null) return current ? `Paused at ${projectRelative(host.root(), current.path)}:${current.line}` : "Paused";
  return threads.size ? "Running" : `Listening on port ${debugSettings.debugPort}`;
}

function render() {
  const state = q<HTMLElement>(".debug-state");
  state.textContent = stateText();
  state.dataset.state = !running ? "off" : stoppedThread !== null ? "paused" : threads.size ? "running" : "listening";
  const exceptions = q<HTMLElement>('[data-run="exceptions"]');
  exceptions.setAttribute("aria-pressed", String(pauseOnExceptions()));
  const classes = exceptionClasses();
  const skipped = skippedPaths();
  exceptions.title = `Pause on ${uncaughtOnly() ? "uncaught " : ""}${classes.length ? classes.join(", ") : "exceptions"}${skipped.length ? ` not thrown in ${skipped.join(", ")}` : ""}: ${pauseOnExceptions() ? "on" : "off"}`;
  exceptions.classList.toggle("on", pauseOnExceptions());
  const enabled: Record<string, boolean> = { listen: !running, resume: isPaused(), over: isPaused(), into: isPaused(), out: isPaused(), stop: running };
  panel.querySelectorAll<HTMLButtonElement>("[data-run]").forEach((b) => (b.disabled = enabled[b.dataset.run!] === false));
  framesList.replaceChildren(
    ...(frames.length
      ? frames.map((f, i) => {
          const file = f.source?.path ? projectRelative(host.root(), f.source.path) : f.source?.name ?? "";
          // The left-to-right mark keeps a path such as .env in order in the right-to-left box that ellipsizes its start.
          return h("li", { role: "option", data: { key: String(i) }, title: `${f.name} at ${file}:${f.line}` }, h("span", { class: "fn" }, f.name), h("span", { class: "loc" }, `‎${file}:${f.line}`));
        })
      : [emptyStack()]),
  );
  if (!frames.length) {
    q<HTMLElement>(".debug-vars").replaceChildren();
    renderWatches();
  }
}

// ---- Variables and watches ----

/** Each variable row's variable, the reference of the scope or value holding it, and its list item. */
const rowData = new WeakMap<HTMLElement, { v: Variable; parent?: number; li: HTMLLIElement; watch?: number }>();
/** The names in the selected frame's scopes, for completion in the console. */
let scopeNames = new Set<string>();

const loadWatches = (): string[] => projectValue<string[]>("debugWatches") ?? [];
const saveWatches = (list: string[]) => void setProjectValue("debugWatches", list.length ? list : undefined).catch(saveError("the watches"));

export function addWatch(expression: string) {
  if (!expression.trim()) return;
  saveWatches([...loadWatches(), expression.trim()]);
  renderWatches();
}

function removeWatch(i: number) {
  saveWatches(loadWatches().filter((_, j) => j !== i));
  renderWatches();
}

async function renderWatches() {
  const list = q<HTMLElement>(".debug-watches ul");
  const rows = await Promise.all(
    loadWatches().map(async (expression, i) => {
      let v: Variable = { name: expression, value: "not available while running", variablesReference: 0 };
      if (selectedFrame && stoppedThread !== null) {
        try {
          const r = await request<{ result: string; type?: string; variablesReference: number }>("evaluate", { expression, frameId: selectedFrame.id, context: "watch" });
          v = { name: expression, value: r.result, type: r.type, variablesReference: r.variablesReference, evaluateName: expression };
        } catch (e) {
          v = { name: expression, value: errorText(e), variablesReference: 0 };
        }
      }
      const li = variableRow(v, { key: `w${i}`, watch: i });
      const remove = h("button", { class: "watch-remove codicon codicon-close", title: "Remove the watch (Delete)", ariaLabel: `Remove the watch ${expression}` });
      remove.onclick = (e) => (e.stopPropagation(), removeWatch(i));
      li.querySelector(".var")!.append(remove);
      return li;
    }),
  );
  list.replaceChildren(...rows);
}

q<HTMLInputElement>(".debug-watches input").onkeydown = (e) => {
  const input = e.currentTarget as HTMLInputElement;
  if (e.key !== "Enter" || !input.value.trim()) return;
  addWatch(input.value);
  input.value = "";
};

let selectedFrame: Frame | undefined;

async function selectFrame(frame: Frame | undefined) {
  selectedFrame = frame;
  if (!frame) return render();
  frameNav.select(String(frames.indexOf(frame)), { scroll: true });
  if (frame.source?.path) {
    setCurrent({ path: frame.source.path, line: frame.line });
    await host.openAt(frame.source.path, frame.line).catch((e) => log(`Can't open ${frame.source?.path}: ${errorText(e)}`));
    renderCurrentLine();
  }
  render();
  await loadScopes(frame);
  renderWatches();
}

/** Loads the frame's scopes and their variables, opening the first; on failure, shows why with Retry. */
async function loadScopes(frame: Frame) {
  const vars = q<HTMLElement>(".debug-vars");
  scopeNames = new Set();
  try {
    const { scopes } = await request<{ scopes: { name: string; variablesReference: number; expensive?: boolean }[] }>("scopes", { frameId: frame.id });
    // Each scope's names, for completion; the first scope's values also show inline. A scope that fails loads when opened.
    const loaded = await Promise.all(scopes.map((s) => (s.expensive ? null : request<{ variables: Variable[] }>("variables", { variablesReference: s.variablesReference }).then((r) => r.variables, () => null))));
    if (frame !== selectedFrame) return;
    for (const list of loaded) for (const v of list ?? []) scopeNames.add(v.name);
    showInlineValues(loaded[0] ?? null);
    vars.replaceChildren(...scopes.map((s, i) => variableRow({ name: s.name, value: "", variablesReference: s.variablesReference }, { key: s.name, open: i === 0, children: loaded[i] ?? undefined })));
  } catch (e) {
    if (frame !== selectedFrame) return;
    vars.replaceChildren(h("li", { class: "debug-empty" }, h("p", {}, `Can't read the variables: ${errorText(e)}`), h("button", { class: "debug-link", onclick: () => loadScopes(frame) }, "Retry")));
  }
}

/**
 * A tree row for a variable; rows with children expand on click, loading them on demand. With `parent`, the
 * reference of the scope or value holding it, the value can be changed (Set Value, F2, or double-click).
 */
function variableRow(v: Variable, o: { key: string; parent?: number; open?: boolean; level?: number; children?: Variable[]; watch?: number }): HTMLLIElement {
  const level = o.level ?? 1;
  const li = h("li", { role: "none" });
  const row = h(
    "div",
    { class: `var${v.variablesReference ? " expandable" : ""}`, role: "treeitem", data: { key: o.key, label: v.name } },
    h("span", { class: "name" }, v.name),
    h("span", { class: "value" }, v.value ? ` = ${v.value}` : ""),
    h("span", { class: "type" }, v.type ? ` ${v.type}` : ""),
  );
  row.setAttribute("aria-level", String(level));
  row.style.paddingLeft = `${4 + (level - 1) * 14}px`;
  rowData.set(row, { v, parent: o.parent, li, watch: o.watch });
  li.append(row);
  if (v.variablesReference) {
    const children = h("ul", { role: "group" });
    li.append(children);
    row.setAttribute("aria-expanded", "false");
    let preloaded = o.children;
    const toggle = async () => {
      const open = row.getAttribute("aria-expanded") !== "true";
      row.setAttribute("aria-expanded", String(open));
      row.classList.toggle("open", open);
      if (!open) return children.replaceChildren();
      try {
        const variables = preloaded ?? (await request<{ variables: Variable[] }>("variables", { variablesReference: v.variablesReference })).variables;
        preloaded = undefined;
        if (row.getAttribute("aria-expanded") !== "true") return;
        children.replaceChildren(...variables.map((c) => variableRow(c, { key: `${o.key}/${c.name}`, parent: v.variablesReference, level: level + 1 })));
        if (!variables.length) children.replaceChildren(h("li", { class: "var-note", style: `padding-left: ${18 + level * 14}px` }, "empty"));
      } catch (e) {
        children.replaceChildren(h("li", { class: "var-note error", style: `padding-left: ${18 + level * 14}px` }, `Can't load: ${errorText(e)}. Collapse and expand to retry.`));
      }
    };
    row.onclick = toggle;
    if (o.open) toggle();
  }
  if (o.parent !== undefined) {
    const value = row.querySelector<HTMLElement>(".value")!;
    value.title = "Double-click or press F2 to change the value";
    value.ondblclick = (e) => (e.stopPropagation(), editValue(row));
  }
  return li;
}

/** Edits a variable's value in place; the adapter sets it with Xdebug's property_set. */
function editValue(row: HTMLElement) {
  const data = rowData.get(row);
  if (!data || data.parent === undefined || stoppedThread === null) return;
  const { v, parent, li } = data;
  const value = row.querySelector<HTMLElement>(".value")!;
  const input = h("input", { className: "var-edit", value: v.value, title: "A PHP expression, such as 'text' in quotes, 42, or null", ariaLabel: `New value of ${v.name}` });
  value.replaceChildren(" = ", input);
  input.focus();
  input.select();
  let done = false;
  const tree = row.closest<HTMLElement>("[role=tree]");
  const finish = async (save: boolean) => {
    if (done) return;
    done = true;
    if (save && input.value !== v.value) {
      try {
        // The adapter evaluates the text as PHP, so strings need quotes.
        await request("setVariable", { variablesReference: parent, name: v.name, value: input.value });
        // The reply echoes the text typed, and the adapter keeps the parent's children as first read, so the value
        // as PHP now sees it comes from evaluating the variable's expression.
        const updated = v.evaluateName
          ? await request<{ result: string; type?: string; variablesReference: number }>("evaluate", { expression: v.evaluateName, frameId: selectedFrame?.id, context: "watch" }).then((r) => ({ ...v, value: r.result, type: r.type ?? v.type, variablesReference: r.variablesReference }))
          : (await request<{ variables: Variable[] }>("variables", { variablesReference: parent })).variables.find((c) => c.name === v.name);
        if (updated) {
          li.replaceWith(variableRow(updated, { key: row.dataset.key!, parent, level: Number(row.getAttribute("aria-level")) }));
          tree?.focus();
          renderWatches();
          return;
        }
      } catch (err) {
        showError(`Can't set ${v.name}`, err);
      }
    }
    value.textContent = v.value ? ` = ${v.value}` : "";
    tree?.focus();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(false);
  input.onclick = (e) => e.stopPropagation();
}

/** A string value without the quotes the adapter shows around it. */
const plain = (v: Variable) => (v.type === "string" ? v.value.replace(/^"([\s\S]*)"$/, "$1") : v.value);

/** Copies a variable's value; an array or object as print_r shows it, evaluated in the selected frame. */
async function copyValue(v: Variable) {
  let text = plain(v);
  if (v.variablesReference && v.evaluateName && selectedFrame && stoppedThread !== null) {
    try {
      const r = await request<{ result: string; type?: string }>("evaluate", { expression: `print_r(${v.evaluateName}, true)`, frameId: selectedFrame.id, context: "repl" });
      text = plain({ ...v, value: r.result, type: r.type });
    } catch {
      // The short value is better than nothing.
    }
  }
  await navigator.clipboard.writeText(text);
  status(`Copied the value of ${v.name}`, "debug", "info");
}

function variableMenu(row: HTMLElement): MenuItem[] {
  const data = rowData.get(row);
  if (!data) return [];
  const { v, parent, watch } = data;
  const items: MenuItem[] = [
    { label: "Copy Value", keys: "⌘C", run: () => copyValue(v) },
    { label: "Copy Name", run: () => navigator.clipboard.writeText(v.evaluateName ?? v.name).then(() => status(`Copied ${v.evaluateName ?? v.name}`, "debug", "info")) },
  ];
  if (watch === undefined) items.push({ label: "Add to Watches", run: () => addWatch(v.evaluateName ?? v.name) });
  if (parent !== undefined && stoppedThread !== null) items.push({ label: "Set Value…", keys: "F2", run: () => editValue(row) });
  if (watch !== undefined) items.push("-", { label: "Remove Watch", keys: "⌫", run: () => removeWatch(watch) });
  return items;
}

for (const tree of [q<HTMLElement>(".debug-vars"), q<HTMLElement>(".debug-watches ul")]) {
  const nav = listNav(tree, { open: (row) => (row.getAttribute("aria-expanded") !== null ? row.click() : editValue(row)) });
  tree.addEventListener("contextmenu", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".var");
    if (!row) return;
    e.preventDefault();
    nav.select(row.dataset.key!, { scroll: false });
    showMenu(e.clientX, e.clientY, variableMenu(row));
  });
  tree.addEventListener("keydown", (e) => {
    const row = nav.selectedRow();
    const data = row && rowData.get(row);
    if (e.target !== tree || !row || !data) return;
    if (e.key === "F2") editValue(row);
    else if (mod(e) && e.key === "c") copyValue(data.v);
    else if ((e.key === "Backspace" || e.key === "Delete") && data.watch !== undefined) removeWatch(data.watch);
    else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      const r = row.getBoundingClientRect();
      showMenu(r.left + 20, r.bottom, variableMenu(row));
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
}

// ---- Console ----

function log(text: string) {
  const pre = q<HTMLElement>(".debug-console pre");
  pre.textContent += text + "\n";
  pre.scrollTop = pre.scrollHeight;
  render();
}

const evalInput = q<HTMLInputElement>(".debug-console input");
const completeList = q<HTMLElement>(".debug-complete");
/** Expressions evaluated, oldest first, and where ↑ and ↓ are in them; `draft` keeps the line being typed. */
const history: string[] = [];
let historyAt = 0;
let draft = "";
let completing: { start: number; matches: string[]; index: number } | null = null;

function showCompletions() {
  const found = completions(evalInput.value, evalInput.selectionStart ?? evalInput.value.length, scopeNames);
  completing = found && { ...found, index: 0 };
  completeList.hidden = !completing;
  evalInput.setAttribute("aria-expanded", String(!!completing));
  if (!completing) return evalInput.removeAttribute("aria-activedescendant");
  const { matches, index } = completing;
  completeList.replaceChildren(
    ...matches.slice(0, 50).map((name, i) =>
      h("li", { role: "option", id: `debug-complete-${i}`, className: i === index ? "selected" : "", ariaSelected: String(i === index), onmousedown: (e: MouseEvent) => (e.preventDefault(), accept(i)) }, name),
    ),
  );
  evalInput.setAttribute("aria-activedescendant", `debug-complete-${index}`);
}

function moveCompletion(by: number) {
  if (!completing) return;
  const n = Math.min(completing.matches.length, 50);
  completing.index = (completing.index + by + n) % n;
  completeList.querySelectorAll("li").forEach((li, i) => {
    li.classList.toggle("selected", i === completing!.index);
    li.setAttribute("aria-selected", String(i === completing!.index));
    if (i === completing!.index) li.scrollIntoView({ block: "nearest" });
  });
  evalInput.setAttribute("aria-activedescendant", `debug-complete-${completing.index}`);
}

function accept(i = completing?.index ?? 0) {
  if (!completing) return;
  const cursor = evalInput.selectionStart ?? evalInput.value.length;
  const name = completing.matches[i];
  evalInput.value = evalInput.value.slice(0, completing.start) + name + evalInput.value.slice(cursor);
  evalInput.selectionStart = evalInput.selectionEnd = completing.start + name.length;
  hideCompletions();
}

function hideCompletions() {
  completing = null;
  completeList.hidden = true;
  evalInput.setAttribute("aria-expanded", "false");
  evalInput.removeAttribute("aria-activedescendant");
}

evalInput.oninput = () => (/\$\w*$/.test(evalInput.value.slice(0, evalInput.selectionStart ?? 0)) && scopeNames.size ? showCompletions() : hideCompletions());
evalInput.onblur = hideCompletions;

evalInput.onkeydown = async (e) => {
  if (completing) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") return e.preventDefault(), moveCompletion(e.key === "ArrowDown" ? 1 : -1);
    if (e.key === "Tab" || e.key === "Enter") return e.preventDefault(), accept();
    if (e.key === "Escape") return e.preventDefault(), e.stopPropagation(), hideCompletions();
  }
  if (e.key === "Tab" && !e.shiftKey) {
    // Tab with nothing showing completes when there's one name, or shows the choices.
    const found = completions(evalInput.value, evalInput.selectionStart ?? 0, scopeNames);
    if (!found) return;
    e.preventDefault();
    showCompletions();
    if (found.matches.length === 1) accept();
    return;
  }
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    if (!history.length) return;
    e.preventDefault();
    if (historyAt === history.length) draft = evalInput.value;
    historyAt = Math.max(0, Math.min(history.length, historyAt + (e.key === "ArrowUp" ? -1 : 1)));
    evalInput.value = historyAt === history.length ? draft : history[historyAt];
    return;
  }
  if (e.key !== "Enter" || !evalInput.value.trim()) return;
  const expression = evalInput.value;
  if (history.at(-1) !== expression) history.push(expression);
  historyAt = history.length;
  draft = "";
  evalInput.value = "";
  if (!selectedFrame || stoppedThread === null) return log("Evaluate works while execution is paused.");
  try {
    const r = await request<{ result: string; type?: string }>("evaluate", { expression, frameId: selectedFrame.id, context: "repl" });
    log(`> ${expression}\n${r.result}${r.type ? `  (${r.type})` : ""}`);
  } catch (err) {
    log(`> ${expression}\n${errorText(err)}`);
  }
};

export function initDebugger(h: Host) {
  host = h;
  render();
}
