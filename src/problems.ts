// The Problems panel: errors and warnings across the whole project, as PhpStorm's project errors. Open files show
// their language servers' live markers. The others come from a scan: Mago's analyzer and linter over the project,
// and Phpactor's diagnostics command for each PHP file, through the same filters as open files (diagnostics.ts).
import { invoke } from "@tauri-apps/api/core";
import { monaco } from "./editor";
import { facts, projectCache, readModels } from "./eloquent";
import { formatType, magoIssuesByFile, messageParts, realProblems, ruleLabel, severityOf, type Diagnostic } from "./diagnostics";
import { diagnosed, magoConfigPath, PHPACTOR_INDEX } from "./lsp";
import { showPanelView } from "./terminal";

type Host = {
  root(): string;
  openAt(path: string, range: monaco.IRange): void;
  status(text: string): void;
  /** Whether the file's tab has unsaved changes. */
  unsaved(path: string): boolean;
  /** Called when the counts may have changed, for the status bar. */
  changed(): void;
};

type Problem = { range: monaco.IRange; message: string; severity: monaco.MarkerSeverity; source?: string; code?: string };

let host: Host;
/** Problems in files that aren't open, by path, from the last scan or from a file's markers when it closed. */
const scanned = new Map<string, Problem[]>();
/** The project the scan is for, and a number that tells a newer scan from an older one. */
let scan = { root: "", run: 0, running: false, progress: "" };

const panel = document.createElement("div");
panel.className = "problems";
const toolbar = document.createElement("div");
toolbar.className = "problems-toolbar";
const rescan = document.createElement("button");
rescan.innerHTML = '<span class="codicon codicon-refresh"></span> Scan Project';
rescan.onclick = () => scanProject();
const summary = document.createElement("span");
summary.className = "problems-summary";

/** Which severities the panel lists, remembered across restarts. */
const shown = (() => {
  try {
    return new Set<monaco.MarkerSeverity>(JSON.parse(localStorage.getItem("problemsShown") ?? "null") ?? [monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning]);
  } catch {
    return new Set([monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning]);
  }
})();
/** A toggle that shows or hides one severity, labeled with its count. */
function severityToggle(severity: monaco.MarkerSeverity, icon: string, name: string) {
  const button = document.createElement("button");
  button.className = "problems-toggle";
  button.title = `Show ${name}`;
  button.onclick = () => {
    shown.has(severity) ? shown.delete(severity) : shown.add(severity);
    try {
      localStorage.setItem("problemsShown", JSON.stringify([...shown]));
    } catch {}
    render();
  };
  const update = (count: number) => {
    button.classList.toggle("on", shown.has(severity));
    button.setAttribute("aria-pressed", String(shown.has(severity)));
    button.innerHTML = `<span class="codicon ${icon}"></span> ${count} ${name}`;
  };
  return { button, update };
}
const errorToggle = severityToggle(monaco.MarkerSeverity.Error, "codicon-error icon-error", "Errors");
const warningToggle = severityToggle(monaco.MarkerSeverity.Warning, "codicon-warning icon-warning", "Warnings");
toolbar.append(rescan, errorToggle.button, warningToggle.button, summary);
const list = document.createElement("ul");
list.className = "problems-tree";
panel.append(toolbar, list);
const collapsed = new Set<string>();

const MARKER = { 1: monaco.MarkerSeverity.Error, 2: monaco.MarkerSeverity.Warning } as Record<number, monaco.MarkerSeverity>;
/** A severity's name in the icon and squiggle classes. */
const level = (s: monaco.MarkerSeverity) => (s === monaco.MarkerSeverity.Error ? "error" : s === monaco.MarkerSeverity.Warning ? "warning" : "info");
const isShown = (severity: monaco.MarkerSeverity) => severity >= monaco.MarkerSeverity.Warning;
const openModel = (path: string) => monaco.editor.getModel(monaco.Uri.file(path));

/**
 * Every file's problems: live markers for open files, and the scan for the rest. An open PHP file shows the scan
 * until Phpactor, which also runs Mago, has checked it.
 */
function allProblems(): Map<string, Problem[]> {
  const root = host.root();
  const live = (path: string) => !!openModel(path) && (!path.endsWith(".php") || diagnosed.has(path));
  const all = new Map([...scanned].filter(([path]) => !live(path)));
  for (const m of monaco.editor.getModelMarkers({})) {
    const path = m.resource.fsPath;
    if (m.resource.scheme !== "file" || !path.startsWith(`${root}/`) || !isShown(m.severity) || !live(path)) continue;
    const problem = { range: m, message: m.message, severity: m.severity, source: m.source, code: typeof m.code === "string" ? m.code : m.code?.value };
    all.set(path, [...(all.get(path) ?? []), problem]);
  }
  return all;
}

/** Error and warning counts for the status bar: the project's once it has been scanned, otherwise the open files'. */
export function problemCounts() {
  const problems = [...allProblems().values()].flat();
  return {
    project: scan.root === host.root(),
    errors: problems.filter((p) => p.severity === monaco.MarkerSeverity.Error).length,
    warnings: problems.filter((p) => p.severity === monaco.MarkerSeverity.Warning).length,
  };
}

function render() {
  host.changed();
  if (!panel.isConnected) return;
  const root = host.root();
  const files = [...allProblems()]
    .map(([path, problems]): [string, Problem[]] => [path, problems.filter((p) => shown.has(p.severity))])
    .filter(([, p]) => p.length)
    .sort(([a], [b]) => a.localeCompare(b));
  const { errors, warnings } = problemCounts();
  errorToggle.update(errors);
  warningToggle.update(warnings);
  summary.textContent = [scan.progress, `${files.length} files`].filter(Boolean).join(" · ");
  rescan.disabled = scan.running;
  list.replaceChildren(
    ...files.map(([path, problems]) => {
      const item = document.createElement("li");
      const row = document.createElement("div");
      row.className = "problems-row problems-file";
      const open = !collapsed.has(path);
      const name = path.slice(root.length + 1);
      row.innerHTML = `<span class="codicon codicon-chevron-${open ? "down" : "right"}"></span><span class="codicon codicon-file"></span>`;
      const label = document.createElement("span");
      label.textContent = name.split("/").pop()!;
      const dir = document.createElement("span");
      dir.className = "problems-muted";
      dir.textContent = name.split("/").slice(0, -1).join("/");
      const count = document.createElement("span");
      count.className = "problems-count";
      count.textContent = String(problems.length);
      row.append(label, dir, count);
      row.onclick = () => (collapsed.has(path) ? collapsed.delete(path) : collapsed.add(path), render());
      item.append(row);
      if (open) {
        const children = document.createElement("ul");
        const sorted = [...problems].sort((a, b) => b.severity - a.severity || a.range.startLineNumber - b.range.startLineNumber);
        children.append(
          ...sorted.map((p) => {
            const li = document.createElement("li");
            li.className = "problems-row problems-item";
            li.innerHTML = `<span class="codicon codicon-${level(p.severity)} icon-${level(p.severity)}"></span>`;
            const message = document.createElement("span");
            message.className = "problems-message";
            message.textContent = p.message.split("\n")[0];
            message.title = p.message;
            const where = document.createElement("span");
            where.className = "problems-muted";
            where.textContent = [ruleLabel(p.source, p.code), `Ln ${p.range.startLineNumber}, Col ${p.range.startColumn}`].filter(Boolean).join(" ");
            const page = document.createElement("button");
            page.className = "icon-button problems-page-button";
            page.title = "Show Details";
            page.innerHTML = '<span class="codicon codicon-open-preview"></span>';
            page.onclick = (e) => (e.stopPropagation(), showProblemPage({ ...p, path }));
            li.append(message, where, page);
            li.onclick = () => host.openAt(path, p.range);
            return li;
          }),
        );
        item.append(children);
      }
      return item;
    }),
  );
}

let pending: ReturnType<typeof setTimeout> | undefined;
const renderSoon = () => (clearTimeout(pending), (pending = setTimeout(render, 200)));
monaco.editor.onDidChangeMarkers(renderSoon);
// A closing file keeps its last markers, which are newer than the scan, unless they're for changes you didn't save.
monaco.editor.onDidCreateModel((model) =>
  model.onWillDispose(() => {
    const path = model.uri.fsPath;
    if (model.uri.scheme !== "file" || scan.root !== host.root() || !diagnosed.has(path) || host.unsaved(path)) return;
    const markers = monaco.editor.getModelMarkers({ resource: model.uri }).filter((m) => isShown(m.severity));
    scanned.set(path, markers.map((m) => ({ range: m, message: m.message, severity: m.severity, source: m.source, code: typeof m.code === "string" ? m.code : m.code?.value })));
    renderSoon();
  }),
);

/** Shows the Problems panel, scanning the project the first time. */
export function showProblems() {
  showPanelView("Problems", panel);
  if (scan.root !== host.root() && !scan.running) scanProject(true);
  else render();
}

/** Forgets the last project's scan, when another project opens. */
export function forgetProblems() {
  scanned.clear();
  scan = { root: "", run: scan.run + 1, running: false, progress: "" };
  render();
}

/** Drops the problems of a file, or of every file in a folder, that was deleted or moved. */
export function forgetPath(path: string) {
  const inside = (p: string) => p === path || p.startsWith(`${path}/`);
  [...scanned.keys()].filter(inside).forEach((p) => scanned.delete(p));
  [...diagnosed].filter(inside).forEach((p) => diagnosed.delete(p));
  renderSoon();
}

const hash = (text: string) => {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return h;
};

/**
 * Scans every PHP file: Mago first (seconds), then Phpactor, one process per file, several at a time (about 1.5
 * seconds each). Phpactor's results are kept in the app's cache by each file's text, but a file's results also
 * depend on the files it uses, so only the first scan after the project opens reads the cache (`useCache`).
 */
export async function scanProject(useCache = false) {
  const root = host.root();
  if (!root || scan.running) return;
  const run = ++scan.run;
  const current = () => run === scan.run;
  scan = { root, run, running: true, progress: "Checking with Mago…" };
  render();
  try {
    await readModels(root);
    const files = (await invoke<string[]>("list_files", { root })).filter(
      (f) => f.endsWith(".php") && !/(^|\/)(vendor|node_modules|storage|bootstrap\/cache|\.[^/]+)\//.test(f) && !f.startsWith("."),
    );
    const texts = new Map<string, string>();
    const text = async (rel: string) => texts.get(rel) ?? texts.set(rel, await invoke<string>("read_file", { path: `${root}/${rel}` }).catch(() => "")).get(rel)!;
    const results = new Map<string, Diagnostic[]>();
    const add = (rel: string, list: Diagnostic[]) => results.set(rel, [...(results.get(rel) ?? []), ...list]);

    // Mago: the analyzer and the linter over the whole project, in one run each.
    const mago = await invoke<string>("tool_path", { name: "mago" });
    const config = magoConfigPath ? ["--config", magoConfigPath] : [];
    const runMago = (command: string, source: "mago" | "mago-lint") =>
      invoke<string>("run_capture", { cwd: root, program: mago, args: [...config, command, "--reporting-format", "json", "--minimum-report-level", "warning"], input: null, anyStatus: true })
        .then((json) => magoIssuesByFile(json, source))
        .catch((e) => (host.status(`Mago ${command} failed: ${e}`), new Map<string, (text: string) => Diagnostic[]>()));
    const [analyzed, linted] = await Promise.all([runMago("analyze", "mago"), runMago("lint", "mago-lint")]);
    for (const reports of [analyzed, linted]) for (const [rel, convert] of reports) add(rel, convert(await text(rel)));
    if (!current()) return;
    const publish = (rels: Iterable<string>) => {
      for (const rel of rels) {
        const path = `${root}/${rel}`;
        const kept = realProblems(path, texts.get(rel) ?? "", "php", results.get(rel) ?? [], facts);
        scanned.set(
          path,
          kept.flatMap((d) => {
            const severity = MARKER[severityOf(d)];
            if (!severity) return [];
            const message = typeof d.message === "string" ? d.message : d.message.value;
            const { start, end } = d.range;
            const range = { startLineNumber: start.line + 1, startColumn: start.character + 1, endLineNumber: end.line + 1, endColumn: end.character + 1 };
            return [{ range, message, severity, source: d.source, code: d.code?.toString() }];
          }),
        );
      }
      renderSoon();
    };
    scanned.clear();
    publish(results.keys());

    // Phpactor: its own checks, such as deprecated classes and unused imports, file by file.
    const cachePath = `${await projectCache("problems", root)}/phpactor.json`;
    const cache: Record<string, { hash: number; list: Diagnostic[] }> = useCache
      ? await invoke<string>("read_file", { path: cachePath }).then(JSON.parse, () => ({}))
      : {};
    const phar = await invoke<string>("tool_path", { name: "phpactor.phar" });
    const extra = JSON.stringify({ ...PHPACTOR_INDEX, "language_server_mago.enabled": false, "language_server_phpstan.enabled": false });
    let done = 0;
    const next = [...files];
    const worker = async () => {
      for (let rel = next.shift(); rel && current(); rel = next.shift()) {
        const source = await text(rel);
        // A newer scan may have started while this one waited; its results must not mix with this one's.
        if (!current()) return;
        const key = hash(source);
        if (cache[rel]?.hash !== key) {
          const out = await invoke<string>("run_capture", {
            cwd: root,
            program: "php",
            args: [phar, "language-server:diagnostics", `--uri=${monaco.Uri.file(`${root}/${rel}`).toString()}`, `--config-extra=${extra}`, "-n"],
            input: source,
          }).catch(() => "[]");
          if (!current()) return;
          cache[rel] = { hash: key, list: (() => { try { return JSON.parse(out) as Diagnostic[]; } catch { return []; } })() };
        }
        if (cache[rel].list.length) add(rel, cache[rel].list), publish([rel]);
        scan.progress = `Checking with Phpactor: ${++done} of ${files.length} files`;
        if (done % 20 === 0) renderSoon();
      }
    };
    // Half the cores, so the editor stays responsive.
    await Promise.all(Array.from({ length: Math.max(2, Math.floor(navigator.hardwareConcurrency / 2)) }, worker));
    if (!current()) return;
    scan.progress = "";
    for (const rel of Object.keys(cache)) if (!texts.has(rel)) delete cache[rel];
    await invoke("create_dir", { path: cachePath.slice(0, cachePath.lastIndexOf("/")) });
    await invoke("write_file", { path: cachePath, contents: JSON.stringify(cache) });
  } catch (e) {
    if (!current()) return;
    host.status(`Couldn't scan the project: ${e}`);
    scan.progress = "";
  } finally {
    if (current()) scan.running = false;
    render();
  }
}

export function initProblems(h: Host) {
  host = h;
}

// ---- One problem on a page of its own, for messages too long to read in a hover ----

const page = document.createElement("div");
page.id = "problem-page";
page.hidden = true;
let excerpt: monaco.editor.IStandaloneCodeEditor | undefined;
let excerptDecorations: monaco.editor.IEditorDecorationsCollection | undefined;

/** A message line with its code in `code` elements, and long code, such as array shapes, laid out on its own lines. */
function messageLine(line: string, className: string) {
  const el = document.createElement("div");
  el.className = className;
  for (const part of messageParts(line)) {
    // After a block, the sentence's comma or period on its own reads as a stray mark.
    const afterBlock = el.lastChild instanceof HTMLPreElement;
    if (!part.code) el.append(afterBlock ? part.text.replace(/^[,.;:]\s*/, "") : part.text);
    else if (part.text.length > 60) {
      const pre = document.createElement("pre");
      pre.textContent = formatType(part.text);
      el.append(pre);
    } else {
      const code = document.createElement("code");
      code.textContent = part.text;
      el.append(code);
    }
  }
  return el;
}

/** Shows a problem on a page in the editor area: its whole message, the code around it, and a link to the code. */
export async function showProblemPage(p: Problem & { path: string }) {
  if (!page.isConnected) {
    document.querySelector("#workbench main")!.insertBefore(page, document.getElementById("panel"));
    addEventListener("keydown", (e) => e.key === "Escape" && !page.hidden && closeProblemPage(), true);
  }
  const root = host.root();
  const header = document.createElement("header");
  header.innerHTML = `<span class="codicon codicon-${level(p.severity)} icon-${level(p.severity)}"></span>`;
  const where = document.createElement("span");
  where.className = "problem-page-path";
  where.textContent = `${p.path.startsWith(`${root}/`) ? p.path.slice(root.length + 1) : p.path}:${p.range.startLineNumber}`;
  const rule = document.createElement("span");
  rule.className = "problem-page-rule";
  rule.textContent = ruleLabel(p.source, p.code);
  const go = document.createElement("button");
  go.textContent = "Go to Code";
  go.onclick = () => (closeProblemPage(), host.openAt(p.path, p.range));
  const close = document.createElement("button");
  close.className = "icon-button";
  close.title = "Close (Esc)";
  close.innerHTML = '<span class="codicon codicon-close"></span>';
  close.onclick = closeProblemPage;
  header.append(where, rule, go, close);

  const body = document.createElement("div");
  body.className = "problem-page-body";
  const [title, ...notes] = p.message.split("\n").map((l) => l.trim()).filter(Boolean);
  const code = document.createElement("div");
  code.className = "problem-page-code";
  body.append(messageLine(title ?? "", "problem-page-title"), code, ...notes.map((n) => messageLine(n, "problem-page-note")));
  page.replaceChildren(header, body);
  const views = [...document.querySelectorAll<HTMLElement>("#editor, #diff, #history, #merge")];
  if (page.hidden) covered = views.filter((e) => !e.hidden);
  views.forEach((e) => (e.hidden = true));
  page.hidden = false;

  // The code around the problem, read only, with the problem's range highlighted. A separate scheme keeps the
  // copy away from the language servers.
  const text = monaco.editor.getModel(monaco.Uri.file(p.path))?.getValue() ?? (await invoke<string>("read_file", { path: p.path }).catch(() => ""));
  const lines = text.split("\n");
  const first = Math.max(1, p.range.startLineNumber - 4);
  const last = Math.min(lines.length, p.range.endLineNumber + 4);
  excerpt?.getModel()?.dispose();
  excerpt?.dispose();
  const language = monaco.editor.getModel(monaco.Uri.file(p.path))?.getLanguageId();
  const model = monaco.editor.createModel(lines.slice(first - 1, last).join("\n"), language ?? (p.path.endsWith(".php") ? "php" : undefined), monaco.Uri.from({ scheme: "problem", path: p.path }));
  code.style.height = `${(last - first + 1) * 20 + 12}px`;
  excerpt = monaco.editor.create(code, {
    model,
    readOnly: true,
    domReadOnly: true,
    lineNumbers: (n) => String(n + first - 1),
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: "none",
    lineHeight: 20,
    padding: { top: 6, bottom: 6 },
    scrollbar: { vertical: "hidden", alwaysConsumeMouseWheel: false },
    folding: false,
    glyphMargin: false,
    contextmenu: false,
    automaticLayout: true,
  });
  const shift = first - 1;
  excerptDecorations = excerpt.createDecorationsCollection([
    {
      range: new monaco.Range(p.range.startLineNumber - shift, p.range.startColumn, p.range.endLineNumber - shift, p.range.endColumn),
      options: { inlineClassName: `problem-page-range-${level(p.severity)}` },
    },
    { range: new monaco.Range(p.range.startLineNumber - shift, 1, p.range.startLineNumber - shift, 1), options: { isWholeLine: true, className: "problem-page-line" } },
  ]);
}

export function closeProblemPage() {
  if (page.hidden) return;
  page.hidden = true;
  excerptDecorations?.clear();
  excerpt?.getModel()?.dispose();
  excerpt?.dispose();
  excerpt = undefined;
  covered.forEach((e) => (e.hidden = false));
}
/** The views the problem page hid, which closing it shows again. */
let covered: HTMLElement[] = [];

// The hover's Show Details link (lsp.ts).
monaco.editor.registerCommand("problems.openPage", (_, p: Problem & { path: string }) => showProblemPage(p));
