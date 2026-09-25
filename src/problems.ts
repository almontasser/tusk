// The Problems panel: errors and warnings across the whole project, as PhpStorm's project errors. Open files show
// their language servers' live markers. The others come from a scan: Mago's analyzer and linter over the project,
// and Phpactor's diagnostics command for each PHP file, through the same filters as open files (diagnostics.ts).
import { invoke } from "@tauri-apps/api/core";
import { monaco } from "./editor";
import { facts, projectCache, readModels } from "./eloquent";
import { formatType, inlineProblem, magoIssuesByFile, matchesFilter, messageParts, realProblems, ruleLabel, severityOf, type Diagnostic } from "./diagnostics";
import { showMenu } from "./files";
import { fileIcon } from "./icons";
import { diagnosed, magoConfigPath, PHPACTOR_INDEX } from "./lsp";
import { settings, onSettings } from "./settings";
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
const filter = document.createElement("input");
filter.type = "search";
filter.className = "problems-filter";
filter.placeholder = "Filter";
filter.title = "Show problems whose message, rule, or path contains every word";
filter.oninput = () => render();
/** Whether the panel lists only the problems of the file in the editor, remembered across restarts. */
let currentOnly = (() => {
  try {
    return localStorage.getItem("problemsCurrentFile") === "true";
  } catch {
    return false;
  }
})();
const currentFile = document.createElement("button");
currentFile.className = "problems-toggle";
currentFile.innerHTML = '<span class="codicon codicon-file"></span> Current File';
currentFile.title = "Show only the file in the editor";
currentFile.onclick = () => {
  currentOnly = !currentOnly;
  try {
    localStorage.setItem("problemsCurrentFile", String(currentOnly));
  } catch {}
  render();
};
toolbar.append(rescan, errorToggle.button, warningToggle.button, currentFile, filter, summary);
const list = document.createElement("ul");
list.className = "problems-tree";
list.role = "tree";
list.tabIndex = 0;
panel.append(toolbar, list);
const collapsed = new Set<string>();
/** The file in the editor and its cursor, which the Current File toggle and the selection follow. */
let caret: { path: string; position: monaco.IPosition | null } = { path: "", position: null };
/** The selected row's key: a file's path, or a problem's path, position, and message. */
let selected = "";
/** The rows on screen, in order, for the arrow keys. */
let rows: { key: string; path: string; problem?: Problem; row: HTMLElement }[] = [];
const keyOf = (path: string, p: Problem) => `${path}:${p.range.startLineNumber}:${p.range.startColumn}:${p.message}`;

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

/**
 * Error and warning counts for the status bar, the project's once it has been scanned, otherwise the open files',
 * and the files with errors, which the tabs and the tree mark.
 */
export function problemCounts() {
  const all = allProblems();
  const problems = [...all.values()].flat();
  return {
    project: scan.root === host.root(),
    errors: problems.filter((p) => p.severity === monaco.MarkerSeverity.Error).length,
    warnings: problems.filter((p) => p.severity === monaco.MarkerSeverity.Warning).length,
    errorFiles: [...all].filter(([, p]) => p.some((p) => p.severity === monaco.MarkerSeverity.Error)).map(([path]) => path),
  };
}

/** Marks a row as selected, and scrolls to it unless the panel is only redrawing. */
function select(key: string, scroll = true) {
  selected = key;
  for (const r of rows) {
    r.row.classList.toggle("selected", r.key === key);
    r.row.ariaSelected = String(r.key === key);
    if (r.key === key && scroll) r.row.scrollIntoView({ block: "nearest" });
  }
}

/** A problem as one line of text: `path:line:column severity rule message`. */
const problemText = (path: string, p: Problem) =>
  [`${path.slice(host.root().length + 1)}:${p.range.startLineNumber}:${p.range.startColumn}`, level(p.severity), ruleLabel(p.source, p.code), p.message].filter(Boolean).join(" ");
const copy = (text: string) => navigator.clipboard.writeText(text).then(() => host.status("Copied the problem"));

list.addEventListener("keydown", (e) => {
  const i = rows.findIndex((r) => r.key === selected);
  const r = rows[i];
  const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
  if (step) rows.length && select(rows[Math.min(rows.length - 1, Math.max(0, i + step))].key);
  else if (!r) return;
  else if (e.key === "Enter") r.row.click();
  // Left collapses a file, or goes from a problem to its file; Right expands a file.
  else if (e.key === "ArrowLeft" && r.problem) select(r.path);
  else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    if (collapsed.has(r.path) !== (e.key === "ArrowLeft")) r.row.click();
  } else if (e.key === "c" && e.metaKey && r.problem) copy(problemText(r.path, r.problem));
  else return;
  e.preventDefault();
  e.stopPropagation();
});

/**
 * Follows the editor: redraws the panel for the Current File toggle when the file changes, and selects the problem
 * under the cursor.
 */
export function followEditor(path: string, position: monaco.IPosition | null) {
  const moved = path !== caret.path;
  caret = { path, position };
  if (moved && currentOnly) return renderSoon();
  const at = (r: (typeof rows)[number]) => !!position && r.path === path && !!r.problem && monaco.Range.containsPosition(r.problem.range, position);
  // Keep the selected problem when the cursor is in it too, such as after opening the second of two overlapping ones.
  if (rows.some((r) => r.key === selected && at(r))) return;
  const here = rows.find(at);
  if (here) select(here.key);
}

function render() {
  host.changed();
  if (!panel.isConnected) return;
  const root = host.root();
  const words = filter.value.trim();
  const errorsIn = (problems: Problem[]) => problems.filter((p) => p.severity === monaco.MarkerSeverity.Error).length;
  // Files with errors first, as VS Code lists them.
  const files = [...allProblems()]
    .filter(([path]) => !currentOnly || path === caret.path)
    .map(([path, problems]): [string, Problem[]] => [
      path,
      problems.filter((p) => shown.has(p.severity) && matchesFilter(words, { ...p, path: path.slice(root.length + 1) })),
    ])
    .filter(([, p]) => p.length)
    .sort(([a, pa], [b, pb]) => Number(!errorsIn(pa)) - Number(!errorsIn(pb)) || a.localeCompare(b));
  const { errors, warnings } = problemCounts();
  errorToggle.update(errors);
  warningToggle.update(warnings);
  currentFile.classList.toggle("on", currentOnly);
  currentFile.setAttribute("aria-pressed", String(currentOnly));
  summary.textContent = [scan.progress, `${files.length} files`].filter(Boolean).join(" · ");
  rescan.disabled = scan.running;
  rows = [];
  list.replaceChildren(
    ...files.map(([path, problems]) => {
      const item = document.createElement("li");
      const row = document.createElement("div");
      row.className = "problems-row problems-file";
      row.role = "treeitem";
      const open = !collapsed.has(path);
      row.ariaExpanded = String(open);
      rows.push({ key: path, path, row });
      const name = path.slice(root.length + 1);
      const icon = fileIcon(name.split("/").pop()!);
      row.innerHTML = `<span class="codicon codicon-chevron-${open ? "down" : "right"}"></span><span class="codicon codicon-${icon.codicon} ${icon.color}"></span>`;
      const label = document.createElement("span");
      label.textContent = name.split("/").pop()!;
      const dir = document.createElement("span");
      dir.className = "problems-muted";
      dir.textContent = name.split("/").slice(0, -1).join("/");
      const count = document.createElement("span");
      count.className = "problems-count";
      const fileErrors = errorsIn(problems);
      count.innerHTML = [
        fileErrors && `<span class="codicon codicon-error icon-error"></span> ${fileErrors}`,
        problems.length - fileErrors && `<span class="codicon codicon-warning icon-warning"></span> ${problems.length - fileErrors}`,
      ].filter(Boolean).join(" ");
      row.append(label, dir, count);
      row.onclick = () => (select(path), collapsed.has(path) ? collapsed.delete(path) : collapsed.add(path), render());
      item.append(row);
      if (open) {
        const children = document.createElement("ul");
        const sorted = [...problems].sort((a, b) => b.severity - a.severity || a.range.startLineNumber - b.range.startLineNumber);
        children.append(
          ...sorted.map((p) => {
            const li = document.createElement("li");
            li.className = "problems-row problems-item";
            li.role = "treeitem";
            const key = keyOf(path, p);
            rows.push({ key, path, problem: p, row: li });
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
            li.onclick = () => (select(key), host.openAt(path, p.range));
            li.oncontextmenu = (e) => {
              e.preventDefault();
              select(key);
              showMenu(e.clientX, e.clientY, [
                { label: "Copy", run: () => copy(problemText(path, p)) },
                { label: "Copy Message", run: () => copy(p.message) },
                "-",
                { label: "Show Details", run: () => showProblemPage({ ...p, path }) },
              ]);
            };
            return li;
          }),
        );
        item.append(children);
      }
      return item;
    }),
  );
  select(selected, false);
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

/**
 * With the Inline Problems setting on, shows the worst problem on the cursor line after the line's end, as Error Lens
 * does for the cursor line only. Typing hides it until you pause.
 */
export function showInlineProblems(ed: monaco.editor.ICodeEditor) {
  const inline = ed.createDecorationsCollection();
  const update = () => {
    const model = ed.getModel();
    const line = ed.getPosition()?.lineNumber;
    const markers = model && line && settings.inlineProblems ? monaco.editor.getModelMarkers({ resource: model.uri }) : [];
    const shown = inlineProblem(markers.filter((m) => isShown(m.severity) && m.startLineNumber === line));
    if (!model || !line || !shown) return inline.clear();
    const col = model.getLineMaxColumn(line);
    inline.set([{ range: new monaco.Range(line, col, line, col), options: { after: { content: `    ${shown.text}`, inlineClassName: `inline-problem inline-problem-${level(shown.severity)}` } } }]);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = () => (clearTimeout(timer), (timer = setTimeout(update, 250)));
  const markers = monaco.editor.onDidChangeMarkers(soon);
  ed.onDidChangeModelContent(() => (inline.clear(), soon()));
  ed.onDidChangeCursorPosition(soon);
  ed.onDidChangeModel(soon);
  ed.onDidDispose(() => (markers.dispose(), clearTimeout(timer)));
  onSettings(soon);
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

/** Mago's linter rules' descriptions by code, read once for each project and config with `mago lint --list-rules --json`. */
let rules: { key: string; descriptions: Promise<Map<string, string>> } | undefined;
function ruleDescription(code: string) {
  const key = `${host.root()}\0${magoConfigPath ?? ""}`;
  if (rules?.key !== key) {
    const args = [...(magoConfigPath ? ["--config", magoConfigPath] : []), "lint", "--list-rules", "--json"];
    const descriptions = invoke<string>("tool_path", { name: "mago" })
      .then((mago) => invoke<string>("run_capture", { cwd: host.root(), program: mago, args, input: null, anyStatus: true }))
      .then((json) => new Map((JSON.parse(json) as { code: string; description: string }[]).map((r) => [r.code, r.description])))
      .catch(() => new Map<string, string>());
    rules = { key, descriptions };
  }
  return rules.descriptions.then((d) => d.get(code));
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
  // Mago's explanation of a linter rule. Its paragraphs are wrapped, so join each one's lines.
  if (p.source === "mago-lint" && p.code)
    ruleDescription(p.code).then((about) => {
      if (!about || !body.isConnected) return;
      const heading = Object.assign(document.createElement("h3"), { className: "problem-page-about", textContent: "About this rule" });
      body.append(heading, ...about.split(/\n\s*\n/).map((para) => messageLine(para.replace(/\s*\n\s*/g, " ").trim(), "problem-page-note")));
    });
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
