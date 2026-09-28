// Bookmarks: lines you mark with F3, or with a mnemonic (a digit or letter) with ⌥F3, and jump back to with ⌃1-9 or
// the Bookmarks tab (⌘F3), as in PhpStorm. They're kept in the project's local state, in the order the tab shows
// them. As with breakpoints, decorations track the lines of open files as you edit; the gutter shows the mnemonic.
import { invoke } from "@tauri-apps/api/core";
import { h, icon } from "./dom";
import { monaco } from "./editor";
import { listNav } from "./listnav";
import { confirm, pick } from "./palette";
import { projectValue, setProjectValue } from "./projectstate";
import { projectRelative } from "./projectstatedata";
import { showError } from "./status";
import { showPanelView } from "./terminal";
import { type Bookmark, MNEMONICS, moveBookmark, moveFile, parseBookmarks } from "./bookmarksdata";

let root = () => "";
let openAt: (path: string, line: number) => unknown = () => {};
/** Every bookmark, in the tab's order. Paths are absolute here and relative to the project when saved. */
let bookmarks: Bookmark[] = [];
const decorations = new Map<string, string[]>(); // path → decoration ids, in the order of that file's bookmarks
const modelFor = (path: string) => monaco.editor.getModel(monaco.Uri.file(path));
const inFile = (path: string) => bookmarks.filter((b) => b.path === path);
const relative = (path: string) => (path.startsWith(root() + "/") ? path.slice(root().length + 1) : path);

// The gutter shows a bookmark's mnemonic in place of the icon: one CSS class per character.
document.head.append(h("style", {}, MNEMONICS.map((m) => `.bookmark-m-${m}::before{content:"${m}"}`).join("")));

/** Reads every open file's bookmark lines from their decorations, before the list changes. */
const syncAll = () => new Set(bookmarks.map((b) => b.path)).forEach(syncLines);

/** Reads the lines of an open file's bookmarks from their decorations, which follow edits. */
function syncLines(path: string) {
  const model = modelFor(path);
  const ids = decorations.get(path);
  if (!model || !ids) return false;
  let moved = false;
  inFile(path).forEach((b, i) => {
    const line = ids[i] ? model.getDecorationRange(ids[i])?.startLineNumber : undefined;
    if (line && line !== b.line) (b.line = line), (moved = true);
  });
  return moved;
}

function render(path: string) {
  const model = modelFor(path);
  if (!model) return;
  const ids = model.deltaDecorations(
    decorations.get(path) ?? [],
    inFile(path).map((b) => ({
      range: new monaco.Range(b.line, 1, b.line, 1),
      options: {
        // The left lane, so a bookmark and a breakpoint on one line both show.
        glyphMarginClassName: b.mnemonic ? `bookmark bookmark-mnemonic bookmark-m-${b.mnemonic}` : "codicon codicon-bookmark bookmark",
        glyphMarginHoverMessage: { value: `Bookmark${b.mnemonic ? ` ${b.mnemonic}` : ""}${b.description ? `: ${b.description}` : ""}` },
        glyphMargin: { position: monaco.editor.GlyphMarginLane.Left },
        stickiness: 1,
      },
    })),
  );
  decorations.set(path, ids);
}

function persist() {
  const saved = bookmarks.map((b) => ({ ...b, path: projectRelative(root(), b.path) }));
  setProjectValue("bookmarks", saved.length ? saved : undefined).catch((e) => showError("Couldn't save the bookmarks", e));
  renderView();
}

/** Loads the project's bookmarks, moving those an older version kept in localStorage. Call when a folder opens. */
export function loadBookmarks() {
  const paths = new Set(bookmarks.map((b) => b.path));
  bookmarks = [];
  for (const path of paths) render(path);
  let saved = projectValue<unknown>("bookmarks");
  const legacy = `bookmarks:${root()}`;
  try {
    const old = localStorage.getItem(legacy);
    if (saved === undefined && old) {
      // { "/abs/path": [line, …] }
      saved = Object.entries<number[]>(JSON.parse(old)).flatMap(([path, lines]) => lines.map((line) => ({ path, line })));
      localStorage.removeItem(legacy);
      bookmarks = parseBookmarks(saved, root());
      persist();
    }
  } catch {
    // No older bookmarks.
  }
  bookmarks = parseBookmarks(saved, root());
  for (const path of new Set(bookmarks.map((b) => b.path))) render(path);
  lineCache.clear();
  renderView();
}

/** Adds a bookmark after its file's others, so each file's bookmarks stay together. */
function add(b: Bookmark) {
  const last = bookmarks.map((x) => x.path).lastIndexOf(b.path);
  bookmarks.splice(last < 0 ? bookmarks.length : last + 1, 0, b);
}

export const hasBookmark = (path: string, line: number) => (syncLines(path), inFile(path).some((b) => b.line === line));

/** Adds a bookmark to a line, or removes the one it has. */
export function toggleBookmark(path: string, line: number) {
  syncLines(path);
  const at = bookmarks.findIndex((b) => b.path === path && b.line === line);
  if (at >= 0) bookmarks.splice(at, 1);
  else add({ path, line });
  render(path);
  persist();
}

/**
 * ⌥F3: asks for a mnemonic, a digit or a letter, for the line's bookmark, adding one if the line has none. A
 * mnemonic another bookmark has moves here. Choosing the line's own mnemonic removes the bookmark.
 */
export function toggleMnemonic(path: string, line: number) {
  syncLines(path);
  syncAll();
  const here = bookmarks.find((b) => b.path === path && b.line === line);
  const owner = new Map(bookmarks.filter((b) => b.mnemonic).map((b) => [b.mnemonic!, b]));
  pick(`Bookmark mnemonic for line ${line}: type a digit or letter`, (q) => {
    const typed = q.trim().toUpperCase();
    const choices = typed ? MNEMONICS.filter((m) => m === typed) : MNEMONICS;
    return [
      ...choices.map((m) => {
        const other = owner.get(m);
        const mine = other === here && !!here;
        return {
          label: m,
          detail: mine ? "Remove this bookmark" : other ? `Move from ${relative(other.path)}:${other.line}` : undefined,
          icon: "codicon-bookmark",
          run: () => {
            if (mine) return toggleBookmark(path, line);
            if (other) other.mnemonic = undefined;
            const b = here ?? { path, line };
            if (!here) add(b);
            b.mnemonic = m;
            for (const p of new Set([path, other?.path ?? path])) render(p);
            persist();
          },
        };
      }),
      ...(here ? [{ label: "Without a mnemonic", icon: "codicon-bookmark", run: () => ((here.mnemonic = undefined), render(path), persist()) }] : []),
    ];
  });
}

/** ⌃<digit>: goes to the bookmark with that mnemonic. */
export function goToMnemonic(m: string) {
  const b = bookmarks.find((x) => x.mnemonic === m);
  if (!b) return showError(`No bookmark has the mnemonic ${m}. Add one with ⌥F3`);
  syncLines(b.path);
  openAt(b.path, b.line);
}

export function initBookmarks(host: { root(): string; openAt(path: string, line: number): unknown }) {
  root = host.root;
  openAt = host.openAt;
}

monaco.editor.onDidCreateModel((model) => {
  const path = model.uri.fsPath;
  if (model.uri.scheme !== "file") return;
  render(path);
  // Save lines that edits moved.
  model.onDidChangeContent(() => {
    if (inFile(path).length && syncLines(path)) persist();
    else if (inFile(path).length) renderViewSoon();
  });
  model.onWillDispose(() => (syncLines(path), decorations.delete(path)));
});

// ---- The Bookmarks tab ----

/** Lines of files that aren't open, read once each time the tab loads. */
const lineCache = new Map<string, string[] | null>();
function lineText(path: string, line: number): string {
  const model = modelFor(path);
  if (model) return line <= model.getLineCount() ? model.getLineContent(line).trim() : "";
  if (!lineCache.has(path)) {
    lineCache.set(path, null);
    invoke<string>("read_file", { path }).then(
      (text) => (lineCache.set(path, text.split("\n")), renderView()),
      () => (lineCache.set(path, []), renderView()),
    );
  }
  const lines = lineCache.get(path);
  if (lines === null) return "…";
  return lines?.[line - 1]?.trim() ?? "";
}

const key = (b: Bookmark) => `b:${b.path}:${b.line}`;
const fileKey = (path: string) => `f:${path}`;
const folded = new Set<string>();
const tree = h("ul", { class: "bm-tree", role: "tree", ariaLabel: "Bookmarks" });
const removeButton = h("button", { title: "Remove the selected bookmark (Delete)", ariaLabel: "Remove" }, icon("remove"));
const removeAllButton = h("button", { title: "Remove all bookmarks", ariaLabel: "Remove all bookmarks" }, icon("close-all"));
const editButton = h("button", { title: "Edit the description (F2)", ariaLabel: "Edit description" }, icon("edit"));
const view = h("div", { class: "bm-view" }, h("div", { class: "debug-toolbar", role: "toolbar", ariaLabel: "Bookmarks" }, editButton, removeButton, removeAllButton), tree);
let viewShown = false;

const selected = () => {
  const k = nav.selected();
  return { bookmark: bookmarks.find((b) => key(b) === k), file: k.startsWith("f:") ? k.slice(2) : undefined };
};
const nav = listNav(tree, {
  open: (row) => {
    const b = bookmarks.find((x) => key(x) === row.dataset.key);
    if (b) openAt(b.path, b.line);
    else row.click();
  },
  toggle: (row) => row.click(),
});
tree.addEventListener("keydown", (e) => {
  if (e.target !== tree) return;
  if (e.key === "Delete" || e.key === "Backspace") remove();
  else if (e.key === "F2") edit();
  else return;
  e.preventDefault();
  e.stopPropagation();
});
removeButton.onclick = () => remove();
removeAllButton.onclick = () => removeAll();
editButton.onclick = () => edit();

/** Opens the Bookmarks tab. */
export function showBookmarks() {
  viewShown = true;
  lineCache.clear();
  renderView();
  showPanelView("Bookmarks", view, () => (viewShown = false));
  tree.focus();
  if (!nav.selectedRow()) {
    const first = tree.querySelector<HTMLElement>("[data-key^='b:']");
    if (first) nav.select(first.dataset.key!);
  }
}

let dragged = "";
function renderView() {
  if (!viewShown) return;
  for (const path of new Set(bookmarks.map((b) => b.path))) syncLines(path);
  removeAllButton.disabled = !bookmarks.length;
  if (!bookmarks.length) return tree.replaceChildren(h("li", { class: "muted bm-empty" }, "No bookmarks. Press F3 on a line to add one, or ⌥F3 to add one with a digit or letter, which ⌃1-9 jumps to."));
  const rows: HTMLElement[] = [];
  for (const path of new Set(bookmarks.map((b) => b.path))) {
    const k = fileKey(path);
    const open = !folded.has(k);
    const file = h(
      "li",
      { role: "treeitem", class: "bm-file", title: relative(path), draggable: true, data: { key: k, label: path.split("/").pop()! } },
      h("span", { class: `codicon codicon-chevron-${open ? "down" : "right"} bm-twisty` }),
      icon("file"),
      h("span", { class: "bm-name" }, path.split("/").pop()!),
      h("span", { class: "muted bm-dir" }, relative(path).split("/").slice(0, -1).join("/")),
      h("span", { class: "muted" }, String(inFile(path).length)),
    );
    file.setAttribute("aria-level", "1");
    file.setAttribute("aria-expanded", String(open));
    file.onclick = () => (folded.has(k) ? folded.delete(k) : folded.add(k), renderView());
    drag(file, k);
    rows.push(file);
    if (!open) continue;
    for (const b of inFile(path)) {
      const row = h(
        "li",
        { role: "treeitem", class: "bm-row", draggable: true, title: `${relative(path)}:${b.line}${b.description ? `\n${b.description}` : ""}`, data: { key: key(b), label: b.description || lineText(path, b.line) } },
        b.mnemonic ? h("span", { class: "bm-mnemonic" }, b.mnemonic) : h("span", { class: "codicon codicon-bookmark bookmark" }),
        h("span", { class: "muted bm-line" }, String(b.line)),
        h("span", { class: "bm-code" }, lineText(path, b.line)),
        b.description ? h("span", { class: "muted bm-desc" }, b.description) : null,
      );
      row.setAttribute("aria-level", "2");
      row.ondblclick = () => openAt(b.path, b.line);
      drag(row, key(b));
      rows.push(row);
    }
  }
  tree.replaceChildren(...rows);
}
const renderViewSoon = (() => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => (clearTimeout(timer), (timer = setTimeout(renderView, 300)));
})();

/** Drag a bookmark onto another in its file, or a file onto another file, to reorder them. */
function drag(row: HTMLElement, k: string) {
  row.ondragstart = (e) => ((dragged = k), e.dataTransfer?.setData("text/plain", k), e.dataTransfer && (e.dataTransfer.effectAllowed = "move"));
  row.ondragend = () => ((dragged = ""), tree.querySelectorAll(".drop-before, .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after")));
  const accepts = () => !!dragged && dragged !== k && dragged[0] === k[0] && (k[0] === "f" || bookmarks.find((b) => key(b) === dragged)?.path === bookmarks.find((b) => key(b) === k)?.path);
  row.ondragover = (e) => {
    if (!accepts()) return;
    e.preventDefault();
    const after = e.offsetY > row.offsetHeight / 2;
    row.classList.toggle("drop-after", after);
    row.classList.toggle("drop-before", !after);
  };
  row.ondragleave = () => row.classList.remove("drop-before", "drop-after");
  row.ondrop = (e) => {
    e.preventDefault();
    if (!accepts()) return;
    syncAll();
    const after = e.offsetY > row.offsetHeight / 2;
    if (k[0] === "f") bookmarks = moveFile(bookmarks, dragged.slice(2), k.slice(2), after);
    else bookmarks = moveBookmark(bookmarks, bookmarks.findIndex((b) => key(b) === dragged), bookmarks.findIndex((b) => key(b) === k), after);
    dragged = "";
    for (const path of new Set(bookmarks.map((b) => b.path))) render(path);
    persist();
  };
}

/** Removes the selected bookmark, or the selected file's bookmarks. */
function remove() {
  const { bookmark, file } = selected();
  const gone = bookmark ? [bookmark] : file ? inFile(file) : [];
  if (!gone.length) return;
  syncAll();
  // The selection moves to the next row, as in PhpStorm.
  const rows = [...tree.querySelectorAll<HTMLElement>("[data-key]")];
  const i = rows.findIndex((r) => r.dataset.key === nav.selected());
  const next = rows.slice(i + 1).find((r) => !gone.some((b) => key(b) === r.dataset.key || fileKey(b.path) === r.dataset.key)) ?? rows[i - 1];
  bookmarks = bookmarks.filter((b) => !gone.includes(b));
  for (const path of new Set(gone.map((b) => b.path))) render(path);
  persist();
  if (next) nav.select(next.dataset.key!);
}

async function removeAll() {
  if (!bookmarks.length || !(await confirm(`Remove all ${bookmarks.length} bookmarks?`, "Remove All"))) return;
  const paths = new Set(bookmarks.map((b) => b.path));
  bookmarks = [];
  for (const path of paths) render(path);
  persist();
}

/** Edits the selected bookmark's description in its row. Enter keeps it, Escape cancels. */
function edit() {
  const { bookmark: b } = selected();
  const row = nav.selectedRow();
  if (!b || !row) return;
  const input = h("input", { class: "bm-desc-input", value: b.description ?? "", placeholder: "Description", ariaLabel: "Bookmark description", spellcheck: false });
  let done = false;
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    if (keep) {
      b.description = input.value.trim() || undefined;
      render(b.path);
      persist();
    } else renderView();
    tree.focus();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
  row.querySelector(".bm-desc")?.remove();
  row.append(input);
  input.focus();
  input.select();
}
