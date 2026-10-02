// The Database tool's results grid, shared by SQL results, tables, and Redis keys. It draws only the rows in view,
// so a page of many thousands scrolls smoothly, and keeps its own cell selection for the keyboard and copying.
// Editing waits: changed cells, added rows, and deleted rows are marked in the grid until Submit applies them
// together. SQL tables and Redis keys each turn the changes into their own commands.
import { invoke } from "@tauri-apps/api/core";
import { keyText, mod, save } from "./platform.ts";
import { bytesOf, type Cell, FORMATS, type Format, formatRows, hexDump, sortOrder, tsv, viewerMode } from "./dbgriddata";
import { h } from "./dom";
import { type MenuItem, showMenu } from "./files";
import { confirm } from "./palette";
import { splitter } from "./splitter";
import { showError, status, withProgress } from "./status";

export type { Cell };
/** A cell's new value: text, null, or SQL as it is, such as DEFAULT. */
export type Value = Cell | { sql: string };
/** Pending changes: new values by row and column, rows to delete, and rows to add by column name. */
export type Changes<V = Value> = { edits: Map<number, Map<number, V>>; deletes: Set<number>; inserts: Record<string, V>[] };
export type Sort = { column: number; desc: boolean };

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}
export const icon = (name: string) => el("span", `codicon codicon-${name}`);

export function button(parent: HTMLElement, label: string, name: string, onclick: () => unknown) {
  const b = el("button", "db-action");
  b.append(icon(name), label);
  b.onclick = onclick;
  parent.append(b);
  return b;
}

export type EditOptions = {
  /** Whether NULL is a value, as in SQL: typing NULL sets it, and Set NULL is offered. */
  nulls: boolean;
  /** What an unset cell in an added row means, such as "default" for SQL; false for no Add Row. */
  empty: string | false;
  /** Whether Set Default is offered, which writes DEFAULT. */
  defaults?: boolean;
  editable?: (row: number, column: number) => boolean;
  deletable?: boolean;
  /** The statements or commands the changes make, for Submit's tooltip. Throws for input it can't take. */
  describe(changes: Changes): string[];
  submit(changes: Changes): Promise<unknown>;
  /** What the changes apply to, for messages, such as the table's name. */
  target: string;
  /** Shows the grid again, after Submit. */
  again(): void;
};

export type GridOptions = {
  columns: string[];
  rows: Cell[][];
  /** The number the first row shows. 1 by default. */
  first?: number;
  /** Columns of binary values, as `\x` hex, which are read-only and open as hex in the value viewer. */
  binary?: number[];
  /** The line above the grid, which gets its buttons. */
  toolbar: HTMLElement;
  /** The sort the rows came in, and how to ask for another, such as ORDER BY for a table; without it, the grid sorts. */
  sort?: Sort | null;
  onSort?(sort: Sort | null): void;
  edit?: EditOptions;
  /** The table and driver for SQL INSERT copies and exports. */
  table?: string;
  driver?: string;
  /** Every row, for Export; without it, Export writes the rows shown. */
  all?(): Promise<{ columns: string[]; rows: Cell[][] } | undefined>;
};

export type Grid = { element: HTMLElement; pending(): number; focus(): void };

/** The row height in pixels, as `.db-row` sets it. */
const ROW = 22;
/** Rows drawn above and below the visible ones, so scrolling doesn't show blanks. */
const OVERSCAN = 30;

/** The grid with pending changes, for confirmDiscard. */
let live: { grid: Grid; target: string } | null = null;

/** Asks before something replaces a grid that has pending changes, such as running another query. */
export async function confirmDiscard(): Promise<boolean> {
  const n = live?.grid.element.isConnected ? live.grid.pending() : 0;
  if (!n) return true;
  const ok = await confirm(`Discard ${n} pending ${n === 1 ? "change" : "changes"} to ${live!.target}?`, "Discard");
  if (ok) live = null;
  return ok;
}

const textOf = (v: Value | undefined): Cell => (v === undefined || v === null ? null : typeof v === "object" ? v.sql : v);

export function dataGrid(o: GridOptions): Grid {
  const { columns, rows: values } = o;
  const e = o.edit;
  const first = o.first ?? 1;
  const binary = new Set(o.binary ?? []);
  const m = columns.length;
  const edits = new Map<number, Map<number, Value>>();
  const deletes = new Set<number>();
  /** Added rows, newest first; undefined is a cell left for its default. */
  const inserts: (Value | undefined)[][] = [];
  let sort: Sort | null = o.sort ?? null;
  let order = values.map((_, i) => i);
  /** The rows in view order: added rows as -1, -2, …, then the rows' indexes. */
  let view: number[] = [];
  const refreshView = () => (view = [...inserts.map((_, i) => -(i + 1)), ...order]);
  refreshView();

  const value = (id: number, c: number): Value | undefined => (id < 0 ? inserts[-id - 1][c] : edits.get(id)?.has(c) ? edits.get(id)!.get(c)! : values[id][c]);
  const canEdit = (id: number, c: number) => !!e && !binary.has(c) && (id < 0 || (!deletes.has(id) && (!e.editable || e.editable(id, c))));
  const changes = (): Changes => ({
    edits,
    deletes,
    inserts: inserts.map((r) => Object.fromEntries(r.flatMap((v, c) => (v === undefined ? [] : [[columns[c], v]])))),
  });
  /** Changed rows, added rows, and deleted rows: what you changed, which may take more or fewer commands. */
  const pending = () => [...edits.keys()].filter((r) => !deletes.has(r)).length + deletes.size + inserts.length;

  // ---- Elements ----

  const scroll = h("div", { class: "db-grid", tabIndex: 0, role: "grid", ariaLabel: e ? `${e.target}, editable` : "Results", ariaMultiSelectable: "true" });
  scroll.ariaColCount = String(m + 1);
  const head = h("div", { class: "db-row db-head", role: "row" });
  const body = h("div", { class: "db-body", role: "rowgroup" });
  scroll.append(head, body);
  const area = h("textarea", { class: "db-viewer-text", spellcheck: false, ariaLabel: "Value" });
  const modes = h("select", { ariaLabel: "Show as" }, ...["Text", "JSON", "Hex"].map((t) => h("option", { value: t.toLowerCase() }, t)));
  const viewerTitle = h("span", { class: "db-viewer-title" });
  const viewerNote = h("div", { class: "db-viewer-note muted" });
  const viewer = h(
    "aside",
    { class: "db-viewer", hidden: true, ariaLabel: "Value viewer" },
    h("div", { class: "db-viewer-head" }, viewerTitle, modes, h("button", { class: "icon-button", title: keyText("Close (⇧⏎)"), onclick: () => toggleViewer(false) }, icon("close"))),
    area,
    viewerNote,
  );
  const handle = h("div", { class: "pane-splitter", hidden: true });
  splitter(handle, { target: viewer, axis: "x", edge: "start", label: "Resize the value viewer", min: 180, minRest: 200, save: "dbValueViewer" });
  const element = h("div", { class: "db-grid-wrap" }, scroll, handle, viewer);

  // Column widths: text widths in ch, since the grid's font is monospaced, until you drag one to pixels.
  const indexWidth = `${Math.max(4, String(first + values.length).length + 2)}ch`;
  const contentWidth = (c: number, rows: number) => Math.max(columns[c].length + 3, ...values.slice(0, rows).map((r) => Math.min(200, (r[c] ?? "NULL").length)));
  const widths = columns.map((_, c) => `${Math.max(6, Math.min(40, contentWidth(c, 200))) + 3}ch`);
  const applyWidths = () => scroll.style.setProperty("--cols", `${indexWidth} ${widths.join(" ")}`);
  applyWidths();

  const corner = h("div", { class: "db-index", role: "columnheader", title: keyText("Select all (⌘A)"), onclick: () => selectAll() }, "#");
  head.append(corner);
  const headers = columns.map((name, c) => {
    const grip = h("span", { class: "db-col-resize", title: "Drag to resize, double-click to fit" });
    const th = h("div", { class: "db-th", role: "columnheader", title: `${name}\nClick to sort` }, h("span", { class: "db-col-name" }, name), h("span", { class: "codicon db-sort" }));
    th.append(grip);
    th.onclick = (ev) => ev.target !== grip && cycleSort(c);
    grip.onpointerdown = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const [x, w] = [ev.clientX, th.offsetWidth];
      const move = (p: PointerEvent) => ((widths[c] = `${Math.max(40, w + p.clientX - x)}px`), applyWidths());
      const up = () => (removeEventListener("pointermove", move), removeEventListener("pointerup", up));
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
    };
    grip.ondblclick = (ev) => (ev.stopPropagation(), (widths[c] = `${Math.min(120, contentWidth(c, 5000)) + 3}ch`), applyWidths());
    head.append(th);
    return th;
  });
  const paintHeaders = () =>
    headers.forEach((th, c) => {
      const on = sort?.column === c;
      th.setAttribute("aria-sort", on ? (sort!.desc ? "descending" : "ascending") : "none");
      th.querySelector(".db-sort")!.className = `codicon db-sort${on ? ` codicon-arrow-${sort!.desc ? "down" : "up"}` : ""}`;
    });
  paintHeaders();

  /** Ascending, descending, then unsorted, by the database for a table, or here for other results. */
  function cycleSort(c: number) {
    const next = sort?.column !== c ? { column: c, desc: false } : !sort.desc ? { column: c, desc: true } : null;
    if (o.onSort) return o.onSort(next);
    sort = next;
    order = next ? sortOrder(values, c, next.desc) : values.map((_, i) => i);
    refreshView();
    paintHeaders();
    render(true);
  }

  // ---- Rows, drawn as they scroll into view ----

  let drawn = { from: -1, to: -1 };
  const display = (id: number, c: number, v: Value | undefined, td: HTMLElement) => {
    let cls = "";
    if (v === undefined) (td.textContent = e && e.empty !== false ? e.empty : ""), (cls = "placeholder");
    else if (v === null) (td.textContent = "NULL"), (cls = "null");
    else if (typeof v === "object") (td.textContent = v.sql), (cls = "raw");
    else td.textContent = v.length > 500 ? `${v.slice(0, 500)}…` : v;
    if (id >= 0 && edits.get(id)?.has(c)) cls += " changed";
    td.className = cls;
  };
  function render(force = false) {
    const n = view.length;
    body.style.height = `${Math.max(n, 1) * ROW}px`;
    scroll.ariaRowCount = String(n + 1);
    const height = scroll.clientHeight || 600;
    const from = Math.max(0, Math.floor(scroll.scrollTop / ROW) - OVERSCAN);
    const to = Math.min(n, Math.ceil((scroll.scrollTop + height) / ROW) + OVERSCAN);
    if (!force && from === drawn.from && to === drawn.to) return;
    drawn = { from, to };
    const rows: HTMLElement[] = [];
    for (let r = from; r < to; r++) {
      const id = view[r];
      const tr = h("div", { class: `db-row${id < 0 ? " added" : deletes.has(id) ? " deleted" : ""}`, role: "row", style: `top: ${r * ROW}px` });
      tr.ariaRowIndex = String(r + 2);
      tr.append(h("div", { class: "db-index", role: "rowheader", data: { r: String(r) } }, id < 0 ? "new" : String(first + id)));
      for (let c = 0; c < m; c++) {
        const td = h("div", { role: "gridcell", data: { r: String(r), c: String(c) } });
        display(id, c, value(id, c), td);
        tr.append(td);
      }
      rows.push(tr);
    }
    if (!n) rows.push(h("div", { class: "db-empty muted" }, "No rows."));
    body.replaceChildren(...rows);
    paint();
  }
  let frame = 0;
  scroll.addEventListener("scroll", () => {
    if (editing) return editing.blur();
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => render());
  });
  new ResizeObserver(() => render()).observe(scroll);

  // ---- Selection: a rectangle from the anchor to the active cell ----

  let anchor = { r: 0, c: 0 };
  let active = { r: 0, c: 0 };
  const rect = () => ({ r0: Math.min(anchor.r, active.r), r1: Math.max(anchor.r, active.r), c0: Math.min(anchor.c, active.c), c1: Math.max(anchor.c, active.c) });
  const cellAt = (r: number, c: number) => body.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`);
  function paint() {
    const { r0, r1, c0, c1 } = rect();
    let activeId = "";
    for (const td of body.querySelectorAll<HTMLElement>("[data-c]")) {
      const [r, c] = [Number(td.dataset.r), Number(td.dataset.c)];
      const on = r >= r0 && r <= r1 && c >= c0 && c <= c1;
      td.classList.toggle("sel", on);
      td.ariaSelected = String(on);
      const isActive = r === active.r && c === active.c;
      td.classList.toggle("active", isActive);
      if (isActive) activeId = td.id ||= `db-cell-${Math.random().toString(36).slice(2)}`;
    }
    for (const index of body.querySelectorAll<HTMLElement>(".db-index")) {
      const r = Number(index.dataset.r);
      index.classList.toggle("sel", c0 === 0 && c1 === m - 1 && r >= r0 && r <= r1);
    }
    activeId ? scroll.setAttribute("aria-activedescendant", activeId) : scroll.removeAttribute("aria-activedescendant");
    if (!viewer.hidden) showValue();
  }
  const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));
  function moveTo(r: number, c: number, extend = false) {
    if (!view.length) return;
    active = { r: clamp(r, view.length - 1), c: clamp(c, m - 1) };
    if (!extend) anchor = { ...active };
    reveal();
    paint();
  }
  function reveal() {
    const headHeight = head.offsetHeight;
    const top = active.r * ROW;
    if (top < scroll.scrollTop) scroll.scrollTop = top;
    else if (top + ROW + headHeight > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = top + ROW + headHeight - scroll.clientHeight;
    render();
    const td = cellAt(active.r, active.c);
    if (!td) return;
    const left = td.offsetLeft - (td.parentElement!.firstElementChild as HTMLElement).offsetWidth;
    if (left < scroll.scrollLeft) scroll.scrollLeft = left;
    else if (td.offsetLeft + td.offsetWidth > scroll.scrollLeft + scroll.clientWidth) scroll.scrollLeft = td.offsetLeft + td.offsetWidth - scroll.clientWidth;
  }
  const selectAll = () => ((anchor = { r: 0, c: 0 }), (active = { r: view.length - 1, c: m - 1 }), paint(), scroll.focus());

  let dragging = false;
  body.addEventListener("mousedown", (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>("[data-r]");
    if (!target || ev.button !== 0 || (ev.target as HTMLElement).tagName === "INPUT") return;
    ev.preventDefault();
    scroll.focus();
    const r = Number(target.dataset.r);
    if (target.dataset.c === undefined) {
      // A row's number selects the row; with ⇧, the rows up to it.
      if (!ev.shiftKey) anchor = { r, c: 0 };
      active = { r, c: m - 1 };
      anchor.c = 0;
      return paint();
    }
    moveTo(r, Number(target.dataset.c), ev.shiftKey);
    dragging = true;
    addEventListener("mouseup", () => (dragging = false), { once: true });
  });
  body.addEventListener("mouseover", (ev) => {
    const td = (ev.target as HTMLElement).closest<HTMLElement>("[data-c]");
    if (dragging && td && ev.buttons === 1) moveTo(Number(td.dataset.r), Number(td.dataset.c), true);
  });
  body.addEventListener("dblclick", (ev) => {
    const td = (ev.target as HTMLElement).closest<HTMLElement>("[data-c]");
    if (td) moveTo(Number(td.dataset.r), Number(td.dataset.c)), edit();
  });
  body.addEventListener("contextmenu", (ev) => {
    const td = (ev.target as HTMLElement).closest<HTMLElement>("[data-r]");
    if (!td) return;
    ev.preventDefault();
    const [r, c] = [Number(td.dataset.r), Number(td.dataset.c ?? 0)];
    const { r0, r1, c0, c1 } = rect();
    if (r < r0 || r > r1 || c < c0 || c > c1) moveTo(r, c);
    showMenu(ev.clientX, ev.clientY, menu());
  });

  /** The selected cells, with their column names, as they show now. */
  const selected = () => {
    const { r0, r1, c0, c1 } = rect();
    const cs = Array.from({ length: c1 - c0 + 1 }, (_, i) => c0 + i);
    return { columns: cs.map((c) => columns[c]), rows: view.slice(r0, r1 + 1).map((id) => cs.map((c) => textOf(value(id, c)))) };
  };
  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(
      () => status(`Copied ${what}`, "app", "info"),
      (err) => showError("Can't copy", err),
    );
  const copyCells = () => {
    const s = selected();
    copy(tsv(s.rows), `${s.rows.length * s.columns.length === 1 ? "the value" : `${s.rows.length} × ${s.columns.length} cells`}`);
  };
  const copyAs = (format: Format) => {
    const s = selected();
    copy(formatRows(format, s.columns, s.rows, o.table, o.driver), `${s.rows.length} ${s.rows.length === 1 ? "row" : "rows"} as ${FORMATS.find((f) => f.format === format)!.label}`);
  };
  // The Edit menu's Copy sends a copy event rather than the key.
  scroll.addEventListener("copy", (ev) => {
    if (document.activeElement !== scroll) return;
    ev.preventDefault();
    ev.clipboardData?.setData("text/plain", tsv(selected().rows));
  });

  async function exportRows() {
    const path = await save({ defaultPath: `${o.table ?? "results"}.csv`, filters: FORMATS.map((f) => ({ name: f.label, extensions: [f.extension] })) }).catch((err) => void showError("Can't choose a file", err));
    if (!path) return;
    const format = FORMATS.find((f) => path.toLowerCase().endsWith(`.${f.extension}`))?.format ?? "csv";
    const data = o.all ? await withProgress("Reading every row to export…", () => o.all!(), { cancellable: true, error: "Can't read the rows to export" }) : { columns, rows: order.map((i) => values[i]) };
    if (!data) return;
    try {
      await invoke("write_file", { path, contents: formatRows(format, data.columns, data.rows, o.table, o.driver) });
      status(`Exported ${data.rows.length.toLocaleString()} ${data.rows.length === 1 ? "row" : "rows"} to ${path}`, "app", "info");
    } catch (err) {
      showError(`Can't write ${path}`, err);
    }
  }

  // ---- Editing ----

  let editing: HTMLInputElement | null = null;
  function set(id: number, c: number, v: Value | undefined) {
    if (id < 0) inserts[-id - 1][c] = v;
    else {
      const row = edits.get(id) ?? new Map<number, Value>();
      // Back to the original value is no change at all.
      v === values[id][c] || v === undefined ? row.delete(c) : row.set(c, v);
      row.size ? edits.set(id, row) : edits.delete(id);
    }
    changed();
  }
  /** Why the active cell can't be edited, or "" when it can. */
  const readOnlyReason = (id: number, c: number) =>
    !e ? "These results are read-only." : binary.has(c) ? "Binary values are read-only here." : id >= 0 && deletes.has(id) ? "The row is marked for deletion." : canEdit(id, c) ? "" : "This cell is read-only.";
  function edit(initial?: string) {
    const { r, c } = active;
    const id = view[r];
    if (id === undefined) return;
    const why = readOnlyReason(id, c);
    if (why) return status(why, "app", "info");
    reveal();
    const td = cellAt(r, c);
    if (!td) return;
    const old = value(id, c);
    const text = old === null ? (e!.nulls ? "NULL" : "") : (textOf(old) ?? "");
    const input = h("input", { class: "db-cell-input", value: initial ?? text, spellcheck: false, ariaLabel: `${columns[c]}${e!.nulls ? ". Type NULL for a null value." : ""}` });
    td.replaceChildren(input);
    td.classList.add("editing");
    editing = input;
    input.focus();
    if (initial === undefined) input.select();
    let done = false;
    const finish = (keep: boolean, then?: () => void) => {
      if (done) return;
      done = true;
      editing = null;
      if (keep && input.value !== text) set(id, c, id < 0 && input.value === "" ? undefined : e!.nulls && input.value === "NULL" ? null : input.value);
      render(true);
      scroll.focus();
      then?.();
    };
    input.onkeydown = (k) => {
      k.stopPropagation();
      if (k.key === "Enter" && mod(k)) return k.preventDefault(), finish(true, submit);
      if (k.key === "Enter") return k.preventDefault(), finish(true);
      if (k.key === "Escape") return k.preventDefault(), finish(false);
      if (k.key === "Tab") return k.preventDefault(), finish(true, () => step(k.shiftKey ? -1 : 1));
      if (k.key === "ArrowDown" || k.key === "ArrowUp") return k.preventDefault(), finish(true, () => moveTo(active.r + (k.key === "ArrowDown" ? 1 : -1), active.c));
    };
    input.onblur = () => finish(true);
  }
  /** Tab and ⇧Tab: the next or previous cell, on to the next or previous row. */
  const step = (by: number) => {
    const i = active.r * m + active.c + by;
    if (i >= 0 && i < view.length * m) moveTo(Math.floor(i / m), i % m);
  };
  const setAll = (v: Value, what: string) => {
    const { r0, r1, c0, c1 } = rect();
    let n = 0;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (canEdit(view[r], c)) set(view[r], c, view[r] < 0 && typeof v === "object" ? undefined : v), n++;
    if (!n) return status(`Nothing to set to ${what}: the selected cells are read-only.`, "app", "info");
    render(true);
  };
  function addRow() {
    inserts.unshift(new Array(m).fill(undefined));
    refreshView();
    render(true);
    scroll.scrollTop = 0;
    moveTo(0, 0);
    changed();
    edit();
  }
  function deleteRows() {
    const { r0, r1 } = rect();
    const ids = view.slice(r0, r1 + 1);
    if (e?.deletable === false) return;
    for (const id of ids) if (id >= 0) deletes.add(id);
    // An added row goes away at once.
    for (const i of ids.filter((id) => id < 0).map((id) => -id - 1).sort((a, b) => b - a)) inserts.splice(i, 1);
    refreshView();
    moveTo(Math.min(r0, view.length - 1), active.c);
    render(true);
    changed();
  }
  function revert() {
    edits.clear();
    deletes.clear();
    inserts.length = 0;
    refreshView();
    moveTo(0, active.c);
    render(true);
    changed();
  }

  const grid: Grid = { element, pending, focus: () => scroll.focus() };
  const action = (label: string, name: string, onclick: () => unknown, title = "") => {
    const b = button(o.toolbar, label, name, onclick);
    b.title = keyText(title);
    return b;
  };
  const problem = el("span", "db-error");
  let submitButton: HTMLButtonElement | undefined;
  let revertButton: HTMLButtonElement | undefined;
  const described = () => {
    try {
      return { list: e!.describe(changes()), error: "" };
    } catch (err) {
      return { list: [], error: err instanceof Error ? err.message : String(err) };
    }
  };
  async function submit() {
    if (!e || !submitButton || submitButton.disabled) return;
    const { list } = described();
    if (!list.length) return;
    const n = pending();
    submitButton.disabled = true;
    try {
      await e.submit(changes());
      live = null;
      status(`Saved ${n} ${n === 1 ? "change" : "changes"} to ${e.target}`, "app", "info");
      e.again();
    } catch (err) {
      showError(`Can't save the changes to ${e.target}`, err);
      submitButton.disabled = false;
    }
  }
  /** Updates the buttons after a change, with what Submit would run as its tooltip. */
  function changed() {
    if (!e) return;
    const { list, error } = described();
    const n = pending();
    problem.textContent = error ? ` ${error}` : "";
    submitButton!.disabled = !list.length || !!error;
    revertButton!.disabled = !n && !edits.size;
    submitButton!.lastChild!.textContent = n ? `Submit ${n} ${n === 1 ? "Change" : "Changes"}` : "Submit";
    submitButton!.title = list.length ? `${list.join(";\n")}\n\n${keyText("⌘⏎")}` : keyText("Submit (⌘⏎)");
    // Pages change only without pending changes.
    o.toolbar.querySelectorAll<HTMLButtonElement>(".db-page").forEach((b) => (b.disabled = n > 0));
    live = n ? { grid, target: e.target } : live?.grid === grid ? null : live;
  }
  if (e) {
    if (e.empty !== false) action("Add Row", "add", addRow);
    if (e.deletable !== false) action("Delete Rows", "trash", deleteRows, "Delete the selected rows (⌘⌫)");
    submitButton = action("Submit", "check", submit);
    revertButton = action("Revert", "discard", revert, "Drop the pending changes");
    o.toolbar.append(problem);
    changed();
  }
  action("Value", "open-preview", () => toggleViewer(), "Show the selected cell's value (⇧⏎)");
  action("Export…", "export", exportRows, "Save every row to a file: CSV, TSV, JSON, SQL INSERT, or Markdown");

  function menu(): MenuItem[] {
    const items: MenuItem[] = [
      { label: "Copy", keys: "⌘C", run: copyCells },
      { label: "Copy As", items: FORMATS.map((f) => ({ label: f.label, run: () => copyAs(f.format) })) },
      { label: "Export…", run: exportRows },
      "-",
      { label: "Value Viewer", keys: "⇧⏎", run: () => toggleViewer(true) },
    ];
    if (!e) return items;
    items.push("-", { label: "Edit", keys: "⏎", run: () => edit() });
    if (e.nulls) items.push({ label: "Set NULL", keys: "⌥⌘N", run: () => setAll(null, "NULL") });
    if (e.defaults) items.push({ label: "Set Default", keys: "⌥⌘D", run: () => setAll({ sql: "DEFAULT" }, "the default") });
    items.push("-");
    if (e.empty !== false) items.push({ label: "Add Row", run: addRow });
    if (e.deletable !== false) items.push({ label: "Delete Rows", keys: "⌘⌫", run: deleteRows });
    if (pending()) items.push({ label: "Submit", keys: "⌘⏎", run: submit }, { label: "Revert", run: revert });
    return items;
  }

  // ---- Keyboard ----

  scroll.addEventListener("keydown", (k) => {
    if (k.target !== scroll) return;
    const { r, c } = active;
    const page = Math.max(1, Math.floor(scroll.clientHeight / ROW) - 2);
    const last = view.length - 1;
    const meta = mod(k);
    const extend = k.shiftKey;
    switch (k.key) {
      case "ArrowDown":
        moveTo(meta ? last : r + 1, c, extend);
        break;
      case "ArrowUp":
        moveTo(meta ? 0 : r - 1, c, extend);
        break;
      case "ArrowRight":
        moveTo(r, meta ? m - 1 : c + 1, extend);
        break;
      case "ArrowLeft":
        moveTo(r, meta ? 0 : c - 1, extend);
        break;
      case "Home":
        moveTo(meta ? 0 : r, 0, extend);
        break;
      case "End":
        moveTo(meta ? last : r, m - 1, extend);
        break;
      case "PageDown":
        moveTo(r + page, c, extend);
        break;
      case "PageUp":
        moveTo(r - page, c, extend);
        break;
      case "Tab":
        step(extend ? -1 : 1);
        break;
      case "Enter":
        if (meta) submit();
        else if (extend) toggleViewer();
        else edit();
        break;
      case "F2":
        edit();
        break;
      case "Escape":
        if (!viewer.hidden) toggleViewer(false);
        else if (anchor.r !== active.r || anchor.c !== active.c) moveTo(r, c);
        else return;
        break;
      case "Backspace":
      case "Delete":
        if (!meta) return;
        deleteRows();
        break;
      default:
        if (meta && !k.altKey && k.key.toLowerCase() === "a") selectAll();
        else if (meta && !k.altKey && k.key.toLowerCase() === "c") copyCells();
        else if (meta && k.altKey && k.code === "KeyN" && e?.nulls) setAll(null, "NULL");
        else if (meta && k.altKey && k.code === "KeyD" && e?.defaults) setAll({ sql: "DEFAULT" }, "the default");
        // Typing starts editing the cell with what you typed, as in a spreadsheet.
        else if (k.key.length === 1 && !meta && !k.ctrlKey && !k.altKey && e) edit(k.key);
        else return;
    }
    k.preventDefault();
    k.stopPropagation();
  });

  // ---- Value viewer ----

  let viewerCell = "";
  function toggleViewer(on = viewer.hidden) {
    viewer.hidden = handle.hidden = !on;
    viewerCell = "";
    if (on) showValue();
    else scroll.focus();
  }
  /** Shows the active cell in the viewer: text, JSON indented, or hex, editable where the cell is. */
  function showValue(mode?: string) {
    const { r, c } = active;
    const id = view[r];
    if (id === undefined) {
      viewerTitle.textContent = "No cell selected";
      area.value = "";
      area.readOnly = true;
      return;
    }
    const key = `${id}:${c}`;
    // Typing in the viewer changes the cell and redraws the grid; the viewer keeps its text and caret.
    if (!mode && key === viewerCell && document.activeElement === area) return;
    const v = textOf(value(id, c));
    if (key !== viewerCell || !mode) modes.value = mode ?? viewerMode(v, binary.has(c));
    viewerCell = key;
    viewerTitle.textContent = `${columns[c]} · ${id < 0 ? "new row" : `row ${first + id}`}`;
    const why = readOnlyReason(id, c);
    area.readOnly = modes.value === "hex" || !!why;
    area.placeholder = v === null ? "NULL" : "";
    if (modes.value === "json") {
      try {
        area.value = JSON.stringify(JSON.parse(v ?? ""), null, 2);
      } catch {
        area.value = v ?? "";
        modes.value = "text";
      }
    } else area.value = modes.value === "hex" ? hexDump(bytesOf(v ?? "")) : (v ?? "");
    const size = v === null ? "NULL" : binary.has(c) && /^\\x/.test(v) ? `${((v.length - 2) / 2).toLocaleString()} bytes` : `${v.length.toLocaleString()} characters`;
    viewerNote.textContent = `${size}${why ? ` · ${why}` : modes.value === "hex" ? " · read-only as hex" : ""}`;
  }
  modes.onchange = () => showValue(modes.value);
  area.oninput = () => {
    const id = view[active.r];
    if (id === undefined || area.readOnly) return;
    set(id, active.c, area.value);
    const td = cellAt(active.r, active.c);
    if (td) display(id, active.c, value(id, active.c), td), paint();
  };
  area.onkeydown = (k) => {
    if (k.key === "Escape") k.preventDefault(), toggleViewer(false);
    if (k.key === "Enter" && mod(k)) k.preventDefault(), submit();
    k.stopPropagation();
  };

  requestAnimationFrame(() => render(true));
  render(true);
  return grid;
}
