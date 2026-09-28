// File operations in the project tree: create, rename, move, delete, and a context menu.
import { invoke } from "@tauri-apps/api/core";
import { showFileHistory } from "./history";
import { recordBeforeDelete, showLocalHistory } from "./localhistory";
import { excludeFolder, exclusionOf, updateReferences } from "./lsp";
import { confirm, pick } from "./palette";
import { newFileContent, psr4From } from "./psr4";
import { findInFolder } from "./search";
import { openTerminal } from "./terminal";

type Host = {
  root(): string;
  /** The file in the active editor tab, if any. */
  active(): string;
  openFile(path: string): unknown;
  /** Moves an open tab after its file moved on disk. */
  renamed(from: string, to: string): unknown;
  /** Closes tabs and models for a path, or for everything inside a folder, without asking. */
  forget(path: string): void;
  status(text: string): void;
};

/** A menu row, with its shortcut as symbols (such as ⌥⏎) in `keys`, a submenu, or a separator. */
export type MenuItem = { label: string; keys?: string; run(): unknown } | { label: string; items: MenuItem[] } | "-";

const $ = (id: string) => document.getElementById(id)!;
let host: Host;
let selected = "";

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const relative = (path: string) => (path === host.root() ? "" : path.slice(host.root().length + 1));
const isInside = (path: string, dir: string) => path === dir || path.startsWith(dir + "/");
const rowOf = (path: string) => document.querySelector<HTMLElement>(`#tree .row[data-path="${CSS.escape(path)}"]`);
const isDir = (path: string) => path === host.root() || !!rowOf(path)?.classList.contains("dir");

async function attempt(action: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (e) {
    host.status(`${action} failed: ${String(e)}`);
  }
}

/** The folder that new files go into: the selected folder, the selected file's folder, or the root. */
function targetDir() {
  const base = selected || host.active() || host.root();
  return isDir(base) ? base : parentOf(base);
}

export function select(path: string) {
  selected = path;
  document.querySelectorAll("#tree .row.selected").forEach((r) => r.classList.remove("selected"));
  rowOf(path)?.classList.add("selected");
}

// ---- Operations ----

export function newFile(dir = targetDir()) {
  const where = relative(dir) || "the project root";
  pick(`New file in ${where}. Use / to create folders too.`, (q) => {
    const name = q.trim().replace(/^\/+/, "");
    return name ? [{ label: `Create ${relative(`${dir}/${name}`)}`, run: () => createFile(`${dir}/${name}`) }] : [];
  });
}

async function createFile(path: string) {
  await attempt("Create file", async () => {
    const composer = await invoke<string>("read_file", { path: `${host.root()}/composer.json` }).catch(() => "");
    await invoke("create_file", { path, contents: newFileContent(relative(path), psr4From(composer)) });
    await host.openFile(path);
  });
}

export function newFolder(dir = targetDir()) {
  pick(`New folder in ${relative(dir) || "the project root"}`, (q) => {
    const name = q.trim().replace(/^\/+/, "");
    return name ? [{ label: `Create folder ${relative(`${dir}/${name}`)}`, run: () => attempt("Create folder", () => invoke("create_dir", { path: `${dir}/${name}` })) }] : [];
  });
}

export function rename(path = selected || host.active()) {
  if (!path || path === host.root()) return;
  const name = nameOf(path);
  const dot = isDir(path) ? -1 : name.indexOf(".");
  pick(
    `Rename ${relative(path)}. Use / to move it.`,
    (q) => {
      const next = q.trim();
      return next && next !== name ? [{ label: `Rename to ${relative(`${parentOf(path)}/${next}`)}`, run: () => move(path, `${parentOf(path)}/${next}`) }] : [];
    },
    0,
    { value: name, select: [0, dot > 0 ? dot : name.length] },
  );
}

/**
 * Moves a file or folder. For PHP files, the language servers then update the moved
 * classes' names and namespaces and every reference to them, as PhpStorm does.
 */
export async function move(from: string, to: string) {
  if (isInside(to, from)) return host.status("A folder can't move into itself.");
  await attempt("Move", async () => {
    const files = isDir(from) ? (await invoke<string[]>("list_files", { root: from })).map((f) => `${from}/${f}`) : [from];
    const php = files.filter((f) => f.endsWith(".php")).map((f) => ({ from: f, to: to + f.slice(from.length) }));
    await invoke("rename_path", { from, to });
    for (const f of files) await host.renamed(f, to + f.slice(from.length));
    let failure: string | null = null;
    if (php.length) {
      host.status(`Updating references for ${php.length} PHP file${php.length > 1 ? "s" : ""}…`);
      failure = await updateReferences(php);
    }
    select(to);
    host.status(failure ? `Moved ${relative(from)} to ${relative(to)}, but references weren't updated. ${failure}` : `Moved ${relative(from)} to ${relative(to)}.`);
  });
}

export async function remove(path = selected || host.active()) {
  if (!path || path === host.root()) return;
  const what = isDir(path) ? "folder" : "file";
  if (!(await confirm(`Move the ${what} ${relative(path)} to the Trash? Unsaved changes in it are lost.`, "Move to Trash"))) return;
  await attempt("Delete", async () => {
    await recordBeforeDelete(path, isDir(path));
    host.forget(path);
    await invoke("trash_path", { path });
    selected = "";
    host.status(`Moved ${relative(path)} to the Trash.`);
  });
}

export const copyPath = (path = selected || host.active(), rel = false) =>
  path && navigator.clipboard.writeText(rel ? relative(path) : path).then(() => host.status(`Copied ${rel ? relative(path) : path}`));
export const revealInFinder = (path = selected || host.active()) =>
  path && invoke("run_capture", { cwd: "/", program: "open", args: ["-R", path], input: null });

// ---- Context menu ----

let closeMenu: (() => void) | null = null;

/** Shows a context menu at a point. Submenus open to the side on hover, click, or → and close with ← or Escape. */
export function showMenu(x: number, y: number, items: MenuItem[]) {
  closeMenu?.();
  type Level = { el: HTMLUListElement; rows: HTMLElement[]; index: number };
  const levels: Level[] = [];
  const submenus = new Map<HTMLElement, () => void>();
  const focus = (level: Level, i: number) => ((level.index = i), level.rows.forEach((r, j) => r.classList.toggle("focused", j === i)));
  const closeFrom = (depth: number) => levels.splice(depth).forEach((l) => l.el.remove());
  const open = (list: MenuItem[], x: number, y: number, depth: number, beside?: DOMRect) => {
    closeFrom(depth);
    const el = document.createElement("ul");
    el.className = "context-menu";
    if (!depth) el.id = "menu";
    el.role = "menu";
    const level: Level = { el, rows: [], index: -1 };
    // Groups can come out empty, so separators appear only between items.
    const shown = list.filter((item, i) => item !== "-" || (i > 0 && list[i - 1] !== "-" && list.slice(i + 1).some((next) => next !== "-")));
    for (const item of shown) {
      const li = document.createElement("li");
      el.append(li);
      if (item === "-") {
        li.className = "separator";
        continue;
      }
      li.role = "menuitem";
      li.append(Object.assign(document.createElement("span"), { textContent: item.label }));
      const i = level.rows.push(li) - 1;
      if ("items" in item) {
        li.setAttribute("aria-haspopup", "menu");
        li.append(Object.assign(document.createElement("span"), { className: "codicon codicon-chevron-right submenu-arrow" }));
        const sub = () => {
          if (levels[depth + 1]?.el.dataset.parent === item.label) return;
          const r = li.getBoundingClientRect();
          open(item.items, r.right, r.top - 5, depth + 1, r);
          levels[depth + 1].el.dataset.parent = item.label;
        };
        submenus.set(li, sub);
        li.onmouseenter = () => (focus(level, i), sub());
        li.onclick = sub;
      } else {
        if (item.keys) li.append(Object.assign(document.createElement("kbd"), { textContent: item.keys }));
        li.onmouseenter = () => (focus(level, i), closeFrom(depth + 1));
        li.onclick = () => (close(), item.run());
      }
    }
    el.onmouseleave = () => levels.length === depth + 1 && focus(level, -1);
    // In a modal dialog, the menu goes in the dialog, since the page under it is inert.
    (document.querySelector("dialog[open]") ?? document.body).append(el);
    levels.push(level);
    // Keep the menu on screen: a submenu that doesn't fit on the right opens on the left.
    const left = beside && x + el.offsetWidth > innerWidth - 4 ? beside.left - el.offsetWidth : Math.min(x, innerWidth - el.offsetWidth - 4);
    el.style.left = `${Math.max(4, left)}px`;
    el.style.top = `${Math.max(4, Math.min(y, innerHeight - el.offsetHeight - 4))}px`;
  };
  const close = () => {
    closeFrom(0);
    closeMenu = null;
    removeEventListener("mousedown", outside, true);
    removeEventListener("keydown", keys, true);
  };
  const outside = (e: MouseEvent) => !levels.some((l) => l.el.contains(e.target as Node)) && close();
  // The arrow keys move through the items and Enter picks one, before the editor or tree sees the keys.
  const keys = (e: KeyboardEvent) => {
    const level = levels.at(-1)!;
    const row = level.rows[level.index];
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (step) focus(level, (level.index + step + level.rows.length) % level.rows.length);
    else if ((e.key === "ArrowRight" || e.key === "Enter") && row && submenus.has(row)) submenus.get(row)!(), focus(levels.at(-1)!, 0);
    else if ((e.key === "ArrowLeft" || e.key === "Escape") && levels.length > 1) closeFrom(levels.length - 1);
    else if (e.key === "Escape") close();
    else if (e.key === "Enter" && row) row.click();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  open(items, x, y, 0);
  closeMenu = close;
  addEventListener("mousedown", outside, true);
  addEventListener("keydown", keys, true);
}

async function menuFor(path: string): Promise<MenuItem[]> {
  const dir = isDir(path) ? path : parentOf(path);
  const root = host.root();
  const rel = path.slice(root.length + 1);
  // Folders the index skips. One inside a skipped folder, or matched by a glob, is changed in Index Exclusions.
  const exclusion = isDir(path) && path !== root ? await exclusionOf(root, rel) : "covered";
  const items: MenuItem[] = [
    { label: "New File…", run: () => newFile(dir) },
    { label: "New Folder…", run: () => newFolder(dir) },
  ];
  if (path !== host.root()) {
    items.push("-", { label: "Rename…", run: () => rename(path) }, { label: "Move to Trash", run: () => remove(path) });
  }
  items.push(
    "-",
    { label: "Find in Folder…", run: () => findInFolder(dir) },
    { label: "Open in Terminal", run: () => openTerminal(dir, nameOf(dir)) },
    "-",
    { label: "Show History", run: () => showFileHistory(path) },
    { label: "Show Local History", run: () => showLocalHistory(path, isDir(path)) },
    { label: "Copy Path", run: () => copyPath(path) },
    { label: "Copy Relative Path", run: () => copyPath(path, true) },
    { label: "Reveal in Finder", run: () => revealInFinder(path) },
  );
  if (exclusion !== "covered") items.push("-", { label: exclusion === "entry" ? "Include in Index" : "Exclude from Index", run: () => excludeFolder(root, rel, exclusion === "no") });
  return items;
}

// ---- Tree events ----

export function initFiles(h: Host) {
  host = h;
  const tree = $("tree");
  const pathAt = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>(".row")?.dataset.path;

  tree.addEventListener("click", (e) => {
    const path = pathAt(e);
    if (path) select(path);
  });

  $("view-project").addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    const path = pathAt(e) ?? host.root();
    if (!path) return;
    select(path);
    showMenu(e.clientX, e.clientY, await menuFor(path));
  });

  tree.addEventListener("keydown", (e) => {
    if (!selected) return;
    const rows = [...document.querySelectorAll<HTMLElement>("#tree .row")];
    const i = rows.findIndex((r) => r.dataset.path === selected);
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step && rows[i + step]) {
      select(rows[i + step].dataset.path!);
      rows[i + step].focus();
    } else if (e.key === "Enter") rows[i]?.click();
    else if ((e.key === "Backspace" && e.metaKey) || e.key === "Delete") remove(selected);
    else if (e.key === "F2" || (e.key === "F6" && e.shiftKey)) rename(selected);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  // Drag a row onto a folder, or onto a file in the folder, to move it there.
  let dragged = "";
  tree.addEventListener("dragstart", (e) => {
    dragged = pathAt(e) ?? "";
    e.dataTransfer?.setData("text/plain", dragged);
  });
  const dropDir = (e: DragEvent) => {
    const path = pathAt(e);
    return path && (isDir(path) ? path : parentOf(path));
  };
  tree.addEventListener("dragover", (e) => {
    const dir = dropDir(e);
    if (!dragged || !dir || isInside(dir, dragged) || dir === parentOf(dragged)) return;
    e.preventDefault();
    document.querySelectorAll("#tree .drop-target").forEach((r) => r.classList.remove("drop-target"));
    rowOf(dir)?.classList.add("drop-target");
  });
  tree.addEventListener("dragleave", () => document.querySelectorAll("#tree .drop-target").forEach((r) => r.classList.remove("drop-target")));
  tree.addEventListener("drop", (e) => {
    e.preventDefault();
    document.querySelectorAll("#tree .drop-target").forEach((r) => r.classList.remove("drop-target"));
    const dir = dropDir(e);
    if (dragged && dir) move(dragged, `${dir}/${nameOf(dragged)}`);
    dragged = "";
  });
}
