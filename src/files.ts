// File operations in the project tree: create, rename, move, delete, and a context menu.
import { invoke } from "@tauri-apps/api/core";
import { showFileHistory } from "./history";
import { recordBeforeDelete, showLocalHistory } from "./localhistory";
import { updateReferences } from "./lsp";
import { confirm, pick } from "./palette";
import { newFileContent, psr4From } from "./psr4";

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

type MenuItem = { label: string; run(): unknown } | "-";

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

function select(path: string) {
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
    if (php.length) {
      host.status(`Updating references for ${php.length} PHP file${php.length > 1 ? "s" : ""}…`);
      await updateReferences(php);
    }
    select(to);
    host.status(`Moved ${relative(from)} to ${relative(to)}.`);
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

function showMenu(x: number, y: number, items: MenuItem[]) {
  $("menu")?.remove();
  const menu = document.createElement("ul");
  menu.id = "menu";
  menu.role = "menu";
  for (const item of items) {
    const li = document.createElement("li");
    if (item === "-") li.className = "separator";
    else {
      li.role = "menuitem";
      li.textContent = item.label;
      li.onclick = () => (close(), item.run());
    }
    menu.append(li);
  }
  document.body.append(menu);
  // Keep the menu on screen.
  menu.style.left = `${Math.min(x, innerWidth - menu.offsetWidth - 4)}px`;
  menu.style.top = `${Math.min(y, innerHeight - menu.offsetHeight - 4)}px`;
  const close = () => {
    menu.remove();
    removeEventListener("mousedown", outside, true);
    removeEventListener("keydown", escape, true);
  };
  const outside = (e: MouseEvent) => !menu.contains(e.target as Node) && close();
  const escape = (e: KeyboardEvent) => e.key === "Escape" && close();
  addEventListener("mousedown", outside, true);
  addEventListener("keydown", escape, true);
}

function menuFor(path: string): MenuItem[] {
  const dir = isDir(path) ? path : parentOf(path);
  const items: MenuItem[] = [
    { label: "New File…", run: () => newFile(dir) },
    { label: "New Folder…", run: () => newFolder(dir) },
  ];
  if (path !== host.root()) {
    items.push("-", { label: "Rename…", run: () => rename(path) }, { label: "Move to Trash", run: () => remove(path) });
  }
  items.push(
    "-",
    { label: "Show History", run: () => showFileHistory(path) },
    ...(isDir(path) ? [] : [{ label: "Show Local History", run: () => showLocalHistory(path) }]),
    { label: "Copy Path", run: () => copyPath(path) },
    { label: "Copy Relative Path", run: () => copyPath(path, true) },
    { label: "Reveal in Finder", run: () => revealInFinder(path) },
  );
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

  $("view-project").addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const path = pathAt(e) ?? host.root();
    if (!path) return;
    select(path);
    showMenu(e.clientX, e.clientY, menuFor(path));
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
