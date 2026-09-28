// Find and replace in files: the Search view in the sidebar.
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "./palette";
import { monaco } from "./editor";
import { fileIcon } from "./icons";
import { didSave } from "./lsp";
import { commentMask, inComment } from "./comments";
import { readText, writeText } from "./projectfiles";
import { type ListNav, listNav } from "./listnav";
import { applyReplacements, type Replacement } from "./replacedata";
import { initReplacePreview, showReplacePreview } from "./replacepreview";
import { errorText, showError } from "./status";
import { limits } from "./limits";

type Host = {
  root(): string;
  openAt(path: string, range: monaco.IRange): unknown;
  markSaved(path: string): void;
  status(text: string): void;
  showView(name: "search"): void;
};
export type Match = { path: string; line: number; column: number; end: number; text: string };
export type Query = { text: string; regex: boolean; caseSensitive: boolean; wholeWord: boolean };

/** Files start expanded until this many rows are shown; the rest render their matches when expanded. */
const EXPANDED_ROWS = 2000;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let host: Host;
let matches: Match[] = [];
let generation = 0;

const options = { caseSensitive: false, wholeWord: false, regex: false };
const query = (): Query => ({ text: $<HTMLInputElement>("find-query").value, ...options });
const include = () => $<HTMLInputElement>("find-include").value;
const exclude = () => $<HTMLInputElement>("find-exclude").value;
const replacement = () => $<HTMLInputElement>("replace-with").value;

/** The search the backend is running, which a newer one cancels. */
let running = "";

async function search() {
  const current = ++generation;
  const q = query();
  if (running) invoke("search_cancel", { id: running }).catch(() => {});
  running = "";
  if (!host.root() || !q.text) {
    matches = [];
    return render("");
  }
  const id = (running = `find-${current}`);
  // A search over a large project can take a while; say so, but don't flash it for quick ones.
  const slow = setTimeout(() => current === generation && ($("find-summary").textContent = "Searching…"), 300);
  try {
    const found = await invoke<Match[]>("search_text", { root: host.root(), query: q, include: include(), exclude: exclude(), id, limit: limits.searchMatches });
    if (current !== generation) return; // A newer search already started.
    matches = found;
    render("");
  } catch (e) {
    if (current !== generation || errorText(e) === "Cancelled") return;
    matches = [];
    render(`${q.regex ? "Invalid search" : "Search failed"}: ${errorText(e)}`);
  } finally {
    clearTimeout(slow);
    if (running === id) running = "";
  }
}

// ---- Search history: the last 20 of each field, offered as the fields' suggestions ----

const HISTORY = { query: "find-query", include: "find-include", exclude: "find-exclude" } as const;
function readHistory(): Record<keyof typeof HISTORY, string[]> {
  try {
    return { query: [], include: [], exclude: [], ...JSON.parse(localStorage.getItem("findHistory") ?? "{}") };
  } catch {
    return { query: [], include: [], exclude: [] };
  }
}
function renderHistory() {
  const saved = readHistory();
  for (const [kind, id] of Object.entries(HISTORY) as [keyof typeof HISTORY, string][]) $(`${id}-history`).replaceChildren(...saved[kind].map((value) => Object.assign(document.createElement("option"), { value })));
}
/** Remembers the fields' values, newest first, once you've used them: Enter, opening a result, or replacing. */
function rememberSearch() {
  const saved = readHistory();
  for (const [kind, id] of Object.entries(HISTORY) as [keyof typeof HISTORY, string][]) {
    const value = $<HTMLInputElement>(id).value.trim();
    if (value) saved[kind] = [value, ...saved[kind].filter((v) => v !== value)].slice(0, 20);
  }
  try {
    localStorage.setItem("findHistory", JSON.stringify(saved));
  } catch {
    // History lasts until reload.
  }
  renderHistory();
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
  $("find-summary").classList.toggle("error", !!error);
  $("find-summary").textContent =
    error ||
    (matches.length
      ? `${matches.length}${matches.length >= limits.searchMatches ? "+" : ""} ${matches.length === 1 ? "match" : "matches"} in ${groups.size} ${groups.size === 1 ? "file" : "files"}`
      : query().text
        ? "No matches"
        : "");
  let shown = 0;
  $("find-results").replaceChildren(
    ...[...groups].map(([path, list]) => {
      const replace = document.createElement("button");
      replace.title = "Replace in this file";
      replace.textContent = "Replace";
      replace.onclick = (e) => (e.stopPropagation(), replaceAll(path));
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
  // A tree for listNav: the file, then its items a level below.
  Object.assign(header, { role: "treeitem", ariaLevel: "1" });
  Object.assign(header.dataset, { key: path, label: name });
  rows.role = "group";
  const item = (it: T, i: number) => {
    const li = row(it);
    Object.assign(li, { role: "treeitem", ariaLevel: "2" });
    li.dataset.key = `${path}\n${i}`;
    return li;
  };
  const setOpen = (open: boolean) => {
    rows.hidden = !open;
    header.ariaExpanded = String(open);
    chevron.classList.toggle("codicon-chevron-down", open);
    chevron.classList.toggle("codicon-chevron-right", !open);
    if (open && !rows.childElementCount) rows.append(...list.map(item));
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
  li.onclick = () => (rememberSearch(), host.openAt(m.path, new monaco.Range(m.line, m.column, m.line, m.end)));
  return li;
}

/** The Find view's list, for moving through matches. */
let results: ListNav;

/**
 * ⌘⌥↓ and ⌘⌥↑: selects the next or previous match in the results, opening its file's group if it's collapsed,
 * and shows it in the editor, as PhpStorm's Next Occurrence does.
 */
export function nextMatch(direction: 1 | -1) {
  if (!matches.length) return host.status("No search results. Find in Files (⇧⌘F) first.");
  const groups = [...byFile()];
  const flat = groups.flatMap(([path, list]) => list.map((_, i) => `${path}\n${i}`));
  const at = flat.indexOf(results.selected());
  // From a file's row, the next match is its first.
  const fileAt = at < 0 ? flat.findIndex((k) => k.startsWith(`${results.selected()}\n`)) : -1;
  const next = at >= 0 ? at + direction : fileAt >= 0 ? (direction > 0 ? fileAt : fileAt - 1) : direction > 0 ? 0 : flat.length - 1;
  if (next < 0 || next >= flat.length) return host.status(direction > 0 ? "That was the last match." : "That was the first match.");
  const key = flat[next];
  const path = key.slice(0, key.lastIndexOf("\n"));
  const header = $("find-results").querySelector<HTMLElement>(`[data-key="${CSS.escape(path)}"]`);
  if (header?.ariaExpanded === "false") header.click();
  results.select(key);
  results.selectedRow()?.click();
}

/** Opens or closes every file's matches. */
function expandAll(open: boolean) {
  const selected = results.selected();
  for (const header of $("find-results").querySelectorAll<HTMLElement>(".find-file")) if ((header.ariaExpanded === "true") !== open) header.click();
  // Clicking the files selected them; the selection stays where it was, or on its file when that closed.
  if (selected) results.select(open || !selected.includes("\n") ? selected : selected.slice(0, selected.lastIndexOf("\n")), { scroll: false });
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
    return showError("Replace failed", e);
  }
  await search();
}

/**
 * Replace All shows a preview of the listed matches, where you can leave out files and matches. When the results
 * stopped at the limit, the preview can't show them all, and offers to replace in every matching file instead.
 */
async function replaceAll(path?: string) {
  const q = query();
  if (!q.text) return;
  rememberSearch();
  if (running) await search(); // Replace what the fields say now, not an older search's results.
  const listed = path ? matches.filter((m) => m.path === path) : matches;
  if (!listed.length) return host.status("No matches to replace.");
  showReplacePreview({
    query: q,
    replacement: replacement(),
    matches: listed,
    truncated: !path && matches.length >= limits.searchMatches,
    replaceEverywhere: async () => {
      const paths = await invoke<string[]>("files_matching", { root: host.root(), query: q, include: include(), exclude: exclude() }).catch((e) => (showError("Couldn't list the matching files", e), null));
      if (paths) await replaceIn(paths);
    },
    apply: applyKept,
  });
}

/**
 * Applies the replacements the preview kept. Open files change through one undoable edit and are saved; others are
 * rewritten on disk. Lines that changed since the search are left alone and reported.
 */
async function applyKept(files: [string, Replacement[]][]) {
  let replaced = 0;
  let stale = 0;
  const failed: string[] = [];
  for (const [path, list] of files) {
    try {
      const model = monaco.editor.getModel(monaco.Uri.file(path));
      const result = applyReplacements(model ? model.getValue() : await readText(path), list);
      stale += result.stale;
      if (!result.applied) continue;
      if (model) {
        model.pushStackElement();
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: result.text }], () => null);
        model.pushStackElement();
      }
      await writeText(path, result.text);
      if (model) {
        host.markSaved(path);
        didSave(model);
      }
      replaced += result.applied;
    } catch (e) {
      console.error(`Replace failed in ${path}`, e);
      failed.push(`${path.slice(host.root().length + 1)} (${errorText(e)})`);
    }
  }
  const done = `Replaced ${replaced} ${replaced === 1 ? "match" : "matches"}`;
  const skipped = stale ? `, and left ${stale} out because their lines changed since the search` : "";
  if (failed.length) showError(`${done}${skipped}, but couldn't replace in ${failed.length} ${failed.length === 1 ? "file" : "files"}: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? ", …" : ""}`);
  else host.status(`${done}${skipped}.`);
  await search();
}

/**
 * Replaces every match in the given files. Open files change through an undoable edit,
 * including their unsaved text, and are then saved; other files are rewritten on disk.
 */
async function replaceIn(paths: string[]) {
  const q = query();
  if (!q.text || !paths.length) return;
  const listed = matches.filter((m) => paths.includes(m.path)).length;
  const count = matches.length >= limits.searchMatches && paths.length > 1 ? "all" : String(listed);
  const where = paths.length === 1 ? paths[0].slice(host.root().length + 1) : `${paths.length} files`;
  if (!(await confirm(`Replace ${count} matches in ${where} with "${replacement()}"?`, "Replace All"))) return;
  let replaced = 0;
  const failed: string[] = [];
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
      console.error(`Replace failed in ${path}`, e);
      failed.push(`${path.slice(host.root().length + 1)} (${errorText(e)})`);
    }
  }
  const done = `Replaced ${replaced} ${replaced === 1 ? "match" : "matches"}`;
  if (failed.length) showError(`${done}, but couldn't replace in ${failed.length} ${failed.length === 1 ? "file" : "files"}: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? ", …" : ""}`);
  else host.status(`${done}.`);
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
  initReplacePreview(h);
  $("todo-results").role = "tree";
  listNav($("todo-results"));
  $("find-results").role = "tree";
  results = listNav($("find-results"));
  // F4 shows the selected match in the editor and moves the focus there, as in PhpStorm.
  $("find-results").addEventListener("keydown", (e) => {
    if (e.key !== "F4" || e.target !== $("find-results")) return;
    e.preventDefault();
    results.selectedRow()?.click();
  });
  $("find-expand").onclick = () => expandAll(true);
  $("find-collapse").onclick = () => expandAll(false);
  renderHistory();
  // ↓ in the search box moves to the results.
  $("find-query").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" || !$("find-results").childElementCount) return;
    e.preventDefault();
    $("find-results").focus();
  });
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
  $("find-exclude").oninput = searchSoon;
  for (const id of ["find-include", "find-exclude"])
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") rememberSearch(), search();
    });
  // Braces, since a handler that returns false (the `&&` for any other key) cancels the keystroke.
  $("find-query").onkeydown = (e) => {
    if (e.key === "Enter") rememberSearch(), search();
  };
  $("replace-with").onkeydown = (e) => {
    if (e.key === "Enter") replaceAll();
  };
  $("replace-all").onclick = () => replaceAll();
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
  let matches: Match[];
  try {
    matches = await invoke<Match[]>("search_text", { root, query: TODO_QUERY, include: "", limit: limits.searchMatches });
  } catch (e) {
    if (current !== todoGeneration) return;
    $("todo-summary").textContent = `Can't list TODO comments: ${errorText(e)}`;
    $("todo-summary").classList.add("error");
    return $("todo-results").replaceChildren();
  }
  if (current !== todoGeneration) return; // A newer load already started.
  $("todo-summary").classList.remove("error");
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
    ? `${found.length}${matches.length >= limits.searchMatches ? "+" : ""} ${found.length === 1 ? "item" : "items"} in ${groups.size} ${groups.size === 1 ? "file" : "files"}`
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
