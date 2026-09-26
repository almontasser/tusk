// Bookmarks: lines you mark with F3 and jump back to with ⌘F3, saved per project. As with breakpoints,
// decorations track the lines of open files as you edit.
import { monaco } from "./editor";
import { pick, rank } from "./palette";

let root = () => "";
let openAt: (path: string, line: number) => unknown = () => {};
const bookmarks = new Map<string, Set<number>>();
const decorations = new Map<string, string[]>(); // path → decoration ids
const modelFor = (path: string) => monaco.editor.getModel(monaco.Uri.file(path));
const storageKey = () => `bookmarks:${root()}`;

function linesOf(path: string): Set<number> {
  const model = modelFor(path);
  const ids = decorations.get(path);
  if (!model || !ids) return bookmarks.get(path) ?? new Set();
  return new Set(ids.map((id) => model.getDecorationRange(id)?.startLineNumber ?? 0).filter(Boolean));
}

function render(path: string) {
  const model = modelFor(path);
  if (!model) return;
  const lines = [...(bookmarks.get(path) ?? [])];
  const ids = model.deltaDecorations(
    decorations.get(path) ?? [],
    lines.map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      // The left lane, so a bookmark and a breakpoint on one line both show.
      options: { glyphMarginClassName: "codicon codicon-bookmark bookmark", glyphMargin: { position: monaco.editor.GlyphMarginLane.Left }, stickiness: 1 },
    })),
  );
  decorations.set(path, ids);
}

function persist() {
  const data = Object.fromEntries([...bookmarks].filter(([, b]) => b.size).map(([p, b]) => [p, [...b]]));
  try {
    localStorage.setItem(storageKey(), JSON.stringify(data));
  } catch {
    // Bookmarks then last only for this session.
  }
}

/** Loads the project's saved bookmarks. Call when a folder opens. */
export function loadBookmarks() {
  for (const path of bookmarks.keys()) bookmarks.set(path, new Set()), render(path);
  bookmarks.clear();
  try {
    for (const [path, lines] of Object.entries<number[]>(JSON.parse(localStorage.getItem(storageKey()) ?? "{}"))) bookmarks.set(path, new Set(lines));
  } catch {
    // No saved bookmarks.
  }
  for (const path of bookmarks.keys()) render(path);
}

export const hasBookmark = (path: string, line: number) => linesOf(path).has(line);

export function toggleBookmark(path: string, line: number) {
  const lines = linesOf(path);
  if (!lines.delete(line)) lines.add(line);
  bookmarks.set(path, lines);
  render(path);
  persist();
}

/** Lists bookmarks with their line's text, when the file is open. */
export function showBookmarks() {
  const items = [...bookmarks.keys()].flatMap((path) =>
    [...linesOf(path)].sort((a, b) => a - b).map((line) => ({
      label: `${path.startsWith(root() + "/") ? path.slice(root().length + 1) : path}:${line}`,
      detail: (() => {
        const model = modelFor(path);
        return model && line <= model.getLineCount() ? model.getLineContent(line).trim() : undefined;
      })(),
      icon: "codicon-bookmark",
      run: () => openAt(path, line),
    })),
  );
  pick(items.length ? "Bookmarks" : "No bookmarks yet: press F3 on a line to add one", (q) => rank(q, items));
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
    const before = bookmarks.get(path);
    if (!before?.size) return;
    const after = linesOf(path);
    if (after.size === before.size && [...after].every((line) => before.has(line))) return;
    bookmarks.set(path, after);
    persist();
  });
  model.onWillDispose(() => decorations.delete(path));
});
