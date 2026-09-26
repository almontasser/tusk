// The Database tool's results grid, and its editing: cells, added rows, and deleted rows wait, marked in the
// grid, until Submit applies them together. SQL tables and Redis keys each turn the changes into their own commands.

export type Cell = string | null;
/** Pending changes: new values by row and column, rows to delete, and rows to add by column name. */
export type Changes = { edits: Map<number, Map<number, Cell>>; deletes: Set<number>; inserts: Record<string, Cell>[] };

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

/** Shows a value in a cell: NULL for null, and a long value cut, with all of it in the tooltip. */
export function cell(td: HTMLElement, value: Cell) {
  td.className = value === null ? "null" : "";
  td.textContent = value === null ? "NULL" : value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (value !== null && value.length > 200) td.title = value.slice(0, 2000);
  return td;
}

/** A table of rows under a sticky header, numbered from `first`. Returns the scroller, the body, and each row. */
export function grid(columns: string[], values: Cell[][], first = 1) {
  const table = el("table");
  const head = el("tr");
  head.append(el("th", "", "#"), ...columns.map((c) => el("th", "", c)));
  table.createTHead().append(head);
  const body = table.createTBody();
  const rows = values.map((cells, i) => {
    const tr = el("tr");
    tr.append(el("td", "index", String(first + i)), ...cells.map((v) => cell(el("td"), v)));
    body.append(tr);
    return tr;
  });
  const scroll = el("div", "db-grid");
  scroll.append(table);
  return { scroll, body, rows };
}

export type EditOptions = {
  /** The line above the grid, which gets the action buttons. */
  summary: HTMLElement;
  /** The element that gets ⌘⏎ for Submit. */
  results: HTMLElement;
  body: HTMLTableSectionElement;
  rows: HTMLElement[];
  columns: string[];
  values: Cell[][];
  /** Whether typing NULL sets a null, as in SQL. Otherwise NULL is text like any other. */
  nulls: boolean;
  /** What an empty input in an added row means, such as "default" for SQL; false for no Add Row. */
  empty: string | false;
  editable?: (row: number, column: number) => boolean;
  deletable?: boolean;
  /** The statements or commands the changes make, for the count and Submit's tooltip. Throws for input it can't take. */
  describe(changes: Changes): string[];
  submit(changes: Changes): Promise<unknown>;
  /** What the changes apply to, for the status message, such as the table's name. */
  target: string;
  status(text: string): void;
  /** Shows the grid again, after Submit or Revert. */
  again(): void;
};

/**
 * Double-click a cell to edit it, Enter keeps the change, and Escape cancels. Click a row's number to select
 * it (⌘-click for several) for Delete Rows, and Add Row adds one. Changes wait, marked in the grid, until
 * Submit (or ⌘⏎) applies them all at once; Revert drops them.
 */
export function makeEditable(o: EditOptions) {
  const { summary, rows, columns, values } = o;
  const changes: Changes = { edits: new Map(), deletes: new Set(), inserts: [] };
  const action = (label: string, name: string, onclick: () => unknown) => button(summary, label, name, onclick);
  const described = () => {
    try {
      return { list: o.describe(changes), error: "" };
    } catch (e) {
      return { list: [], error: e instanceof Error ? e.message : String(e) };
    }
  };

  if (o.empty !== false) {
    const empty = o.empty;
    action("Add Row", "add", () => {
      if (o.body.querySelector(".new-row")) return;
      const tr = el("tr", "new-row");
      const inputs = columns.map((c) => {
        const input = el("input");
        input.placeholder = empty;
        input.title = `${c}: leave empty for ${empty === "default" ? "the column's default" : "an empty value"}${o.nulls ? ", or type NULL" : ""}`;
        const td = el("td", "editing");
        td.append(input);
        return { c, input, td };
      });
      tr.append(el("td", "index", "new"), ...inputs.map((i) => i.td));
      o.body.prepend(tr);
      tr.closest(".db-grid")!.scrollTop = 0;
      inputs[0]?.input.focus();
      tr.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Escape") tr.remove();
        if (e.key !== "Enter" || e.metaKey) return;
        const added = Object.fromEntries(inputs.filter((i) => i.input.value !== "").map((i) => [i.c, o.nulls && i.input.value === "NULL" ? null : i.input.value]));
        changes.inserts.push(added);
        // The row stays, showing what will be added.
        tr.className = "added";
        tr.onkeydown = null;
        inputs.forEach((i) => cell(i.td, i.input.value === "" ? empty : added[i.c]));
        changed();
      };
    });
  }

  const selected = new Set<number>();
  const deletable = o.deletable !== false;
  const remove = deletable
    ? action("Delete Rows", "trash", () => {
        for (const r of selected) changes.deletes.add(r), rows[r].classList.add("deleted");
        selected.clear();
        rows.forEach((row) => row.classList.remove("selected"));
        remove!.disabled = true;
        changed();
      })
    : null;
  if (remove) remove.disabled = true;
  /** Changed rows, added rows, and deleted rows: what you changed, which may take more or fewer commands. */
  const pending = () => [...changes.edits.keys()].filter((r) => !changes.deletes.has(r)).length + changes.deletes.size + changes.inserts.length;
  const submit = action("Submit", "check", async () => {
    const { list } = described();
    if (!list.length) return;
    const n = pending();
    submit.disabled = true;
    try {
      await o.submit(changes);
      o.status(`Saved ${n} ${n === 1 ? "change" : "changes"} to ${o.target}`);
      o.again();
    } catch (e) {
      o.status(`Can't save the changes to ${o.target}: ${String(e)}`);
      submit.disabled = false;
    }
  });
  const revert = action("Revert", "discard", o.again);
  const problem = el("span", "db-error");
  summary.append(problem);
  /** Updates the Submit and Revert buttons after a change, with what they'd run as Submit's tooltip. */
  const changed = () => {
    const { list, error } = described();
    const n = pending();
    problem.textContent = error ? ` ${error}` : "";
    submit.disabled = !list.length || !!error;
    revert.disabled = !n && !changes.edits.size;
    submit.lastChild!.textContent = n ? `Submit ${n} ${n === 1 ? "Change" : "Changes"}` : "Submit";
    submit.title = list.join(";\n");
    summary.querySelectorAll<HTMLButtonElement>(".db-page").forEach((b) => (b.disabled = !revert.disabled));
  };
  changed();
  o.results.onkeydown = (e) => {
    if (e.key === "Enter" && e.metaKey && !submit.disabled) e.preventDefault(), submit.click();
  };

  if (deletable)
    rows.forEach((tr, r) => {
      const index = tr.children[0] as HTMLElement;
      index.title = "Click to select the row, ⌘-click to select several";
      index.onclick = (e) => {
        if (!e.metaKey) {
          if (!selected.has(r) || selected.size > 1) selected.clear();
          rows.forEach((row) => row.classList.remove("selected"));
        }
        selected.has(r) ? selected.delete(r) : selected.add(r);
        for (const i of selected) rows[i].classList.add("selected");
        remove!.disabled = !selected.size;
      };
    });
  rows.forEach((tr, r) =>
    columns.forEach((_, c) => {
      if (o.editable && !o.editable(r, c)) return;
      const td = tr.children[c + 1] as HTMLElement;
      td.title = o.nulls ? "Double-click to edit. Type NULL for a null value." : "Double-click to edit.";
      const current = () => (changes.edits.get(r)?.has(c) ? changes.edits.get(r)!.get(c)! : values[r][c]);
      const show = () => (cell(td, current()), td.classList.toggle("changed", !!changes.edits.get(r)?.has(c)));
      td.ondblclick = () => {
        if (changes.deletes.has(r)) return;
        const input = el("input");
        input.value = current() ?? "NULL";
        td.replaceChildren(input);
        td.classList.add("editing");
        input.focus();
        input.select();
        let done = false;
        const finish = (keep: boolean) => {
          if (done) return;
          done = true;
          td.classList.remove("editing");
          if (keep) {
            const value = o.nulls && input.value === "NULL" ? null : input.value;
            const row = changes.edits.get(r) ?? changes.edits.set(r, new Map()).get(r)!;
            // Back to the original value is no change at all.
            value === values[r][c] ? row.delete(c) : row.set(c, value);
            if (!row.size) changes.edits.delete(r);
            changed();
          }
          show();
        };
        input.onkeydown = (e) => {
          if (e.key === "Enter") finish(true);
          if (e.key === "Escape") finish(false);
          // ⌘⏎ goes on to the grid, which submits, with this edit kept first.
          if (!(e.key === "Enter" && e.metaKey)) e.stopPropagation();
        };
        input.onblur = () => finish(true);
      };
    }),
  );
}
