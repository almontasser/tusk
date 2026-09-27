// Find and replace in files: the Search view in the sidebar.
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "./palette";
import { monaco } from "./editor";
import { fileIcon } from "./icons";
import { didSave } from "./lsp";
import { commentMask, inComment } from "./comments";
import { readText, writeText } from "./projectfiles";

type Host = {
  root(): string;
  openAt(path: string, range: monaco.IRange): unknown;
  markSaved(path: string): void;
  status(text: string): void;
  showView(name: "search"): void;
};
type Match = { path: string; line: number; column: number; end: number; text: string };
type Query = { text: string; regex: boolean; caseSensitive: boolean; wholeWord: boolean };

const MAX_MATCHES = 20_000;
/** Files start expanded until this many rows are shown; the rest render their matches when expanded. */
const EXPANDED_ROWS = 2000;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let host: Host;
let matches: Match[] = [];
let generation = 0;

const options = { caseSensitive: false, wholeWord: false, regex: false };
const query = (): Query => ({ text: $<HTMLInputElement>("find-query").value, ...options });
const include = () => $<HTMLInputElement>("find-include").value;
const replacement = () => $<HTMLInputElement>("replace-with").value;

async function search() {
  const current = ++generation;
  const q = query();
  if (!host.root() || !q.text) {
    matches = [];
    return render("");
  }
  // A search over a large project can take a while; say so, but don't flash it for quick ones.
  const slow = setTimeout(() => current === generation && ($("find-summary").textContent = "Searching…"), 300);
  try {
    const found = await invoke<Match[]>("search_text", { root: host.root(), query: q, include: include() });
    if (current !== generation) return; // A newer search already started.
    matches = found;
    render("");
  } catch (e) {
    if (current !== generation) return;
    matches = [];
    render(`Invalid search: ${String(e)}`);
  } finally {
    clearTimeout(slow);
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
const searchSoon = () => (clearTimeout(timer), (timer = setTimeout(search, 250)));

function byFile() {
  const groups = new Map<string, Match[]>();
  for (const m of matches) (groups.get(m.path) ?? groups.set(m.path, []).get(m.path)!).push(m);
  return groups;
}

/** The line around a match, trimmed, with the match wrapped in <mark>. Columns are UTF-16, like JS strings. */
function preview(m: Match) {
  const start = m.column - 1;
  const from = Math.max(0, Math.min(start - 40, m.text.search(/\S|$/)));
  const span = document.createElement("span");
  span.className = "preview";
  const mark = document.createElement("mark");
  mark.textContent = m.text.slice(start, m.end - 1);
  span.append((from > 0 && start - from >= 40 ? "…" : "") + m.text.slice(from, start), mark, m.text.slice(m.end - 1, m.end + 120));
  return span;
}

function render(error: string) {
  const groups = byFile();
  $("find-summary").textContent =
    error ||
    (matches.length
      ? `${matches.length}${matches.length >= MAX_MATCHES ? "+" : ""} ${matches.length === 1 ? "match" : "matches"} in ${groups.size} ${groups.size === 1 ? "file" : "files"}`
      : query().text
        ? "No matches"
        : "");
  let shown = 0;
  $("find-results").replaceChildren(
    ...[...groups].map(([path, list]) => {
      const replace = document.createElement("button");
      replace.title = "Replace in this file";
      replace.textContent = "Replace";
      replace.onclick = (e) => (e.stopPropagation(), replaceIn([path]));
      const open = shown + list.length <= EXPANDED_ROWS;
      if (open) shown += list.length;
      return fileGroup(path, list, matchRow, open, replace);
    }),
  );
}

/**
 * A file in a results list, with its items below. Click the file to collapse them; they render when first shown.
 * The badge shows `count`, or else the number of items.
 */
export function fileGroup<T>(path: string, list: T[], row: (item: T) => HTMLElement, open: boolean, action?: HTMLElement, count?: string) {
  const group = document.createElement("li");
  const header = document.createElement("div");
  header.className = "find-file";
  const rel = path.slice(host.root().length + 1);
  const name = rel.split("/").pop()!;
  const icon = fileIcon(name);
  header.innerHTML = `<span class="chevron codicon codicon-chevron-down"></span><span class="file-icon codicon codicon-${icon.codicon} ${icon.color}"></span><span class="name"></span><span class="dir"></span><span class="count"></span>`;
  header.querySelector(".name")!.textContent = name;
  header.querySelector(".dir")!.textContent = rel.slice(0, -name.length - 1);
  header.querySelector(".count")!.textContent = count ?? String(list.length);
  if (action) header.append(action);
  const rows = document.createElement("ul");
  const chevron = header.querySelector(".chevron")!;
  const setOpen = (open: boolean) => {
    rows.hidden = !open;
    chevron.classList.toggle("codicon-chevron-down", open);
    chevron.classList.toggle("codicon-chevron-right", !open);
    if (open && !rows.childElementCount) rows.append(...list.map(row));
  };
  setOpen(open);
  header.onclick = () => setOpen(!!rows.hidden);
  group.append(header, rows);
  return group;
}

function matchRow(m: Match) {
  const li = document.createElement("li");
  li.className = "find-match";
  const line = document.createElement("span");
  line.className = "line";
  line.textContent = String(m.line);
  const replace = document.createElement("button");
  replace.className = "codicon codicon-replace";
  replace.title = "Replace this match";
  replace.onclick = (e) => (e.stopPropagation(), replaceOne(m));
  li.append(line, preview(m), replace);
  li.onclick = () => host.openAt(m.path, new monaco.Range(m.line, m.column, m.line, m.end));
  return li;
}

/** Replaces one match: its text runs through the same replace as Replace All, so regex groups work. */
async function replaceOne(m: Match) {
  const q = query();
  const found = m.text.slice(m.column - 1, m.end - 1);
  try {
    const { text } = await invoke<{ text: string; count: number }>("replace_text", { text: found, query: q, replacement: replacement() });
    const model = monaco.editor.getModel(monaco.Uri.file(m.path));
    if (model) {
      // Only if the line still holds the match where the search found it.
      if (model.getValueInRange(new monaco.Range(m.line, m.column, m.line, m.end)) !== found) return host.status("The file changed; search again.");
      model.pushEditOperations([], [{ range: new monaco.Range(m.line, m.column, m.line, m.end), text }], () => null);
      await writeText(m.path, model.getValue());
      host.markSaved(m.path);
      didSave(model);
    } else {
      const lines = (await readText(m.path)).split("\n");
      const line = lines[m.line - 1];
      if (line === undefined || !line.startsWith(m.text.slice(0, m.end - 1))) return host.status("The file changed; search again.");
      // Columns are UTF-16 code units, the same units JavaScript strings index by.
      lines[m.line - 1] = line.slice(0, m.column - 1) + text + line.slice(m.end - 1);
      await writeText(m.path, lines.join("\n"));
    }
  } catch (e) {
    return host.status(`Replace failed: ${String(e)}`);
  }
  await search();
}

/** Replace All covers every matching file, including ones beyond the listed results. */
async function replaceAll() {
  const q = query();
  if (!q.text) return;
  const paths = await invoke<string[]>("files_matching", { root: host.root(), query: q, include: include() }).catch(() => [...byFile().keys()]);
  replaceIn(paths);
}

/**
 * Replaces every match in the given files. Open files change through an undoable edit,
 * including their unsaved text, and are then saved; other files are rewritten on disk.
 */
async function replaceIn(paths: string[]) {
  const q = query();
  if (!q.text || !paths.length) return;
  const listed = matches.filter((m) => paths.includes(m.path)).length;
  const count = matches.length >= MAX_MATCHES && paths.length > 1 ? "all" : String(listed);
  const where = paths.length === 1 ? paths[0].slice(host.root().length + 1) : `${paths.length} files`;
  if (!(await confirm(`Replace ${count} matches in ${where} with "${replacement()}"?`, "Replace All"))) return;
  let replaced = 0;
  for (const path of paths) {
    try {
      const model = monaco.editor.getModel(monaco.Uri.file(path));
      const text = model ? model.getValue() : await readText(path);
      const result = await invoke<{ text: string; count: number }>("replace_text", { text, query: q, replacement: replacement() });
      if (!result.count) continue;
      if (model) model.pushEditOperations([], [{ range: model.getFullModelRange(), text: result.text }], () => null);
      await writeText(path, result.text);
      if (model) {
        host.markSaved(path);
        didSave(model);
      }
      replaced += result.count;
    } catch (e) {
      host.status(`Replace failed in ${path}: ${String(e)}`);
    }
  }
  host.status(`Replaced ${replaced} matches.`);
  await search();
}

/** Opens the Search view, starting from the editor's selection if it's a single line. */
export function openSearch(editor: monaco.editor.ICodeEditor, focusReplace = false) {
  host.showView("search");
  const selection = editor.getSelection();
  const selected = selection && !selection.isEmpty() && editor.hasTextFocus() ? editor.getModel()?.getValueInRange(selection) : "";
  const input = $<HTMLInputElement>("find-query");
  if (selected && !selected.includes("\n")) {
    input.value = selected;
    search();
  }
  const target = focusReplace ? $<HTMLInputElement>("replace-with") : input;
  target.focus();
  target.select();
}

/** Opens the Search view limited to the files in `dir`. */
export function findInFolder(dir: string) {
  host.showView("search");
  const rel = dir.slice(host.root().length + 1);
  $<HTMLInputElement>("find-include").value = rel ? `${rel}/**` : "";
  const input = $<HTMLInputElement>("find-query");
  input.focus();
  input.select();
  if (input.value) search();
}

export function initSearch(h: Host) {
  host = h;
  for (const [id, key] of [["opt-case", "caseSensitive"], ["opt-word", "wholeWord"], ["opt-regex", "regex"]] as const) {
    const button = $(id);
    button.onclick = () => {
      options[key] = !options[key];
      button.ariaPressed = String(options[key]);
      search();
    };
  }
  $("find-query").oninput = searchSoon;
  $("find-include").oninput = searchSoon;
  // Braces, since a handler that returns false (the `&&` for any other key) cancels the keystroke.
  $("find-query").onkeydown = (e) => {
    if (e.key === "Enter") search();
  };
  $("replace-with").onkeydown = (e) => {
    if (e.key === "Enter") replaceAll();
  };
  $("replace-all").onclick = replaceAll;
}

/** True when every changed path is inside a `.git` folder, which searches skip, so results can't have changed. */
const onlyGit = (paths?: Iterable<string>) => !!paths && [...paths].every((p) => p.includes("/.git/"));

/** Reruns the search after files change, so results stay current. */
export const refreshSearch = (paths?: Iterable<string>) => !onlyGit(paths) && $<HTMLInputElement>("find-query").value && searchSoon();

// ---- The TODO view ----

const TODO_QUERY: Query = { text: String.raw`\b(TODO|FIXME|XXX)\b`, regex: true, caseSensitive: true, wholeWord: false };
let todoGeneration = 0;

/**
 * Lists TODO, FIXME, and XXX comments in project files, grouped by file, as PhpStorm's TODO window does. Ignored
 * files, such as vendor, are skipped. The search finds the words anywhere, and `inComment` keeps those in comments.
 */
export async function loadTodos() {
  const root = host.root();
  if (!root) return;
  const current = ++todoGeneration;
  const matches = await invoke<Match[]>("search_text", { root, query: TODO_QUERY, include: "" }).catch(() => [] as Match[]);
  if (current !== todoGeneration) return; // A newer load already started.
  // Only keywords in comments, not in strings or names such as TODO_LIMIT. Each file with matches is read and
  // scanned whole, so lines inside a multi-line comment count; a file that can't be read is judged line by line.
  const byFile = new Map<string, Match[]>();
  for (const m of matches) (byFile.get(m.path) ?? byFile.set(m.path, []).get(m.path)!).push(m);
  const kept = await Promise.all(
    [...byFile].map(async ([path, list]) => {
      const text = await readText(path).catch(() => null);
      if (text === null) return list.filter((m) => inComment(m.text, m.column));
      const lines = commentMask(text, /\.(html?|blade\.php)$/.test(path)).split("\n");
      // A blanked keyword was in a comment.
      return list.filter((m) => lines[m.line - 1]?.[m.column - 1] === " ");
    }),
  );
  if (current !== todoGeneration) return;
  const found = kept.flat();
  const groups = new Map<string, Match[]>();
  for (const m of found) (groups.get(m.path) ?? groups.set(m.path, []).get(m.path)!).push(m);
  $("todo-summary").textContent = found.length
    ? `${found.length}${matches.length >= MAX_MATCHES ? "+" : ""} ${found.length === 1 ? "item" : "items"} in ${groups.size} ${groups.size === 1 ? "file" : "files"}`
    : "No TODO, FIXME, or XXX comments in project files.";
  let shown = 0;
  $("todo-results").replaceChildren(
    ...[...groups].map(([path, list]) => {
      const open = shown + list.length <= EXPANDED_ROWS;
      if (open) shown += list.length;
      return fileGroup(path, list, todoRow, open);
    }),
  );
}

/** A TODO's row: its text from the keyword on, which is the part worth reading. */
function todoRow(m: Match) {
  const li = document.createElement("li");
  li.className = "find-match";
  const line = document.createElement("span");
  line.className = "line";
  line.textContent = String(m.line);
  const text = document.createElement("span");
  text.className = "preview";
  const mark = document.createElement("mark");
  mark.textContent = m.text.slice(m.column - 1, m.end - 1);
  text.append(mark, m.text.slice(m.end - 1, m.end + 200).replace(/\s*(\*\/|-->|--\}\})\s*$/, ""));
  li.append(line, text);
  li.onclick = () => host.openAt(m.path, new monaco.Range(m.line, m.column, m.line, m.end));
  return li;
}

let todoTimer: ReturnType<typeof setTimeout> | undefined;
/** Reloads the TODO view after files change, while it shows. */
export const refreshTodos = (paths?: Iterable<string>) => !onlyGit(paths) && !$("view-todo").hidden && (clearTimeout(todoTimer), (todoTimer = setTimeout(loadTodos, 250)));
