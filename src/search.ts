// Find and replace in files: the Search view in the sidebar.
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { monaco } from "./editor";
import { fileIcon } from "./icons";
import { didSave } from "./lsp";

type Host = {
  root(): string;
  openAt(path: string, range: monaco.IRange): unknown;
  markSaved(path: string): void;
  status(text: string): void;
  showView(name: "search"): void;
};
type Match = { path: string; line: number; column: number; end: number; text: string };
type Query = { text: string; regex: boolean; caseSensitive: boolean; wholeWord: boolean };

const MAX_MATCHES = 2000;
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
  try {
    const found = await invoke<Match[]>("search_text", { root: host.root(), query: q, include: include() });
    if (current !== generation) return; // A newer search already started.
    matches = found;
    render("");
  } catch (e) {
    if (current !== generation) return;
    matches = [];
    render(`Invalid search: ${String(e)}`);
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
const searchSoon = () => (clearTimeout(timer), (timer = setTimeout(search, 250)));

function byFile() {
  const groups = new Map<string, Match[]>();
  for (const m of matches) groups.set(m.path, [...(groups.get(m.path) ?? []), m]);
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
  const root = host.root();
  $("find-summary").textContent =
    error ||
    (matches.length
      ? `${matches.length}${matches.length >= MAX_MATCHES ? "+" : ""} ${matches.length === 1 ? "match" : "matches"} in ${groups.size} ${groups.size === 1 ? "file" : "files"}`
      : query().text
        ? "No matches"
        : "");
  $("find-results").replaceChildren(
    ...[...groups].map(([path, list]) => {
      const group = document.createElement("li");
      const header = document.createElement("div");
      header.className = "find-file";
      const rel = path.slice(root.length + 1);
      const name = rel.split("/").pop()!;
      const icon = fileIcon(name);
      header.innerHTML = `<span class="file-icon codicon codicon-${icon.codicon} ${icon.color}"></span><span class="name"></span><span class="dir"></span><span class="count"></span><button title="Replace in this file">Replace</button>`;
      header.querySelector(".name")!.textContent = name;
      header.querySelector(".dir")!.textContent = rel.slice(0, -name.length - 1);
      header.querySelector(".count")!.textContent = String(list.length);
      header.querySelector("button")!.onclick = () => replaceIn([path]);
      const rows = document.createElement("ul");
      rows.append(
        ...list.map((m) => {
          const li = document.createElement("li");
          li.className = "find-match";
          const line = document.createElement("span");
          line.className = "line";
          line.textContent = String(m.line);
          li.append(line, preview(m));
          li.onclick = () => host.openAt(m.path, new monaco.Range(m.line, m.column, m.line, m.end));
          return li;
        }),
      );
      group.append(header, rows);
      return group;
    }),
  );
}

/**
 * Replaces every match in the given files. Open files change through an undoable edit,
 * including their unsaved text, and are then saved; other files are rewritten on disk.
 */
async function replaceIn(paths: string[]) {
  const q = query();
  const count = matches.filter((m) => paths.includes(m.path)).length;
  if (!q.text || !count) return;
  const more = matches.length >= MAX_MATCHES && paths.length > 1 ? " Only the first 2000 matches are listed; files beyond them aren't changed." : "";
  const where = paths.length === 1 ? paths[0].slice(host.root().length + 1) : `${paths.length} files`;
  if (!(await ask(`Replace ${count} matches in ${where} with "${replacement()}"?${more}`, { kind: "warning" }))) return;
  let replaced = 0;
  for (const path of paths) {
    try {
      const model = monaco.editor.getModel(monaco.Uri.file(path));
      const text = model ? model.getValue() : await invoke<string>("read_file", { path });
      const result = await invoke<{ text: string; count: number }>("replace_text", { text, query: q, replacement: replacement() });
      if (!result.count) continue;
      if (model) model.pushEditOperations([], [{ range: model.getFullModelRange(), text: result.text }], () => null);
      await invoke("write_file", { path, contents: result.text });
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
  $("find-query").onkeydown = (e) => e.key === "Enter" && search();
  $("replace-with").onkeydown = (e) => e.key === "Enter" && replaceIn([...byFile().keys()]);
  $("replace-all").onclick = () => replaceIn([...byFile().keys()]);
}

/** Reruns the search after files change, so results stay current. */
export const refreshSearch = () => $<HTMLInputElement>("find-query").value && searchSoon();
