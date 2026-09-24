// Database tool: tables and columns in the sidebar, a query console, and a results grid in the panel.
// The connection comes from the project's .env, as Laravel reads it.
import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import {
  columnsQuery,
  type Connection,
  connectionFromEnv,
  deleteStatement,
  hasCode,
  insertStatement,
  parseEnv,
  primaryKeyQuery,
  quoteIdentifier,
  schemaQuery,
  statementAt,
  tablesQuery,
  updateStatement,
} from "./dbconfig";
import { monaco } from "./editor";
import { pick } from "./palette";
import { usesSail } from "./sail";
import { showPanelView } from "./terminal";

type Result = { columns: string[]; rows: (string | null)[][]; affected: number; truncated: boolean };
type Host = { root(): string; openFile(path: string): Promise<unknown>; status(text: string): void };

const $ = (id: string) => document.getElementById(id)!;
let host: Host;
let connection: Connection | null = null;
/** Columns per table, loaded once per connection for completion. */
let schema: Promise<Map<string, { name: string; type: string }[]>> | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}
const icon = (name: string) => el("span", `codicon codicon-${name}`);

const query = (sql: string) => invoke<Result>("db_query", { connection, sql });

async function loadConnection() {
  const env = await invoke<string>("read_file", { path: `${host.root()}/.env` }).catch(() => "");
  connection = connectionFromEnv(parseEnv(env), host.root(), await usesSail(host.root()));
  schema = null;
  const c = connection;
  $("db-connection").textContent =
    c.driver === "sqlite" ? `SQLite · ${c.database.replace(host.root() + "/", "")}` : `${c.driver} · ${c.username}@${c.host}:${c.port}/${c.database}`;
}

// ---- Tables ----

export async function loadTables() {
  if (!host.root()) return;
  const list = $("db-tables");
  list.replaceChildren(el("li", "muted", "Loading…"));
  try {
    await loadConnection();
    const tables = (await query(tablesQuery(connection!.driver))).rows.map((r) => r[0] ?? "");
    list.replaceChildren(...(tables.length ? tables.map(tableRow) : [el("li", "muted", "No tables. Run the migrations with php artisan migrate.")]));
  } catch (e) {
    list.replaceChildren(el("li", "muted", `Can't connect: ${String(e)}`));
  }
}

function tableRow(table: string) {
  const li = el("li");
  const row = el("div", "row");
  const chevron = el("span", "chevron codicon codicon-chevron-right");
  row.append(chevron, icon("table"), el("span", "name", table));
  row.title = "Double-click to show the data";
  const columns = el("ul");
  columns.hidden = true;
  row.onclick = async () => {
    columns.hidden = !columns.hidden;
    chevron.classList.toggle("codicon-chevron-down", !columns.hidden);
    if (columns.hidden || columns.childElementCount) return;
    try {
      for (const [name, type, nullable] of (await query(columnsQuery(connection!.driver, table))).rows) {
        const c = el("li", "row column");
        c.append(icon("symbol-field"), el("span", "name", name ?? ""), el("span", "type", `${(type ?? "").toLowerCase()}${nullable === "YES" ? "?" : ""}`));
        columns.append(c);
      }
    } catch (e) {
      columns.append(el("li", "muted", String(e)));
    }
  };
  row.ondblclick = () => run(`SELECT * FROM ${quoteIdentifier(connection!.driver, table)} LIMIT 500`, table);
  li.append(row, columns);
  return li;
}

// ---- Console ----

/** Opens the project's query console, a .sql file kept in the app's data folder rather than in the project. */
export async function openConsole() {
  if (!host.root()) return;
  const dir = `${await appDataDir()}/consoles/${host.root().replace(/[^A-Za-z0-9]+/g, "_")}`;
  const path = `${dir}/console.sql`;
  if (!(await invoke<boolean>("path_exists", { path }))) {
    await invoke("create_dir", { path: dir });
    await invoke("write_file", { path, contents: "-- ⌘⏎ runs the statement under the caret, or the selection.\n\n" });
  }
  await host.openFile(path);
}

/** Runs the selection, or the statement under the caret, from a .sql editor. */
export function runFromEditor(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) return;
  const sql = selection.isEmpty() ? statementAt(model.getValue(), model.getOffsetAt(selection.getPosition())) : model.getValueInRange(selection);
  if (hasCode(sql)) run(sql);
}

// ---- Completion ----

function loadSchema() {
  schema ??= (async () => {
    if (!connection) await loadConnection();
    const tables = new Map<string, { name: string; type: string }[]>();
    for (const [table, name, type] of (await query(schemaQuery(connection!.driver))).rows) {
      if (!tables.has(table!)) tables.set(table!, []);
      tables.get(table!)!.push({ name: name!, type: (type ?? "").toLowerCase() });
    }
    return tables;
  })().catch(() => ((schema = null), new Map()));
  return schema;
}

/** Tables, and their columns. After `name.`, only the columns of that table, or of the table that `name` aliases. */
async function provideCompletionItems(model: monaco.editor.ITextModel, position: monaco.Position): Promise<monaco.languages.CompletionList> {
  if (!host.root()) return { suggestions: [] };
  const tables = await loadSchema();
  const word = model.getWordUntilPosition(position);
  const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
  const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
  const Field = monaco.languages.CompletionItemKind.Field;
  const qualifier = before.match(/(\w+)\.$/)?.[1];
  if (qualifier) {
    let table = [...tables.keys()].find((t) => t.toLowerCase() === qualifier.toLowerCase());
    // ponytail: finds aliases anywhere in the file, not only in the current statement.
    for (const m of model.getValue().matchAll(new RegExp(`\\b(\\w+)\\s+(?:as\\s+)?${qualifier}\\b`, "gi"))) table ??= tables.has(m[1]) ? m[1] : undefined;
    const columns = table ? tables.get(table)! : [];
    return { suggestions: columns.map((c) => ({ label: c.name, kind: Field, detail: c.type, insertText: c.name, range })) };
  }
  const suggestions: monaco.languages.CompletionItem[] = [];
  for (const [table, columns] of tables) {
    suggestions.push({ label: table, kind: monaco.languages.CompletionItemKind.Struct, detail: "table", insertText: table, range });
    for (const c of columns) suggestions.push({ label: { label: c.name, description: table }, kind: Field, detail: `${table}.${c.name} ${c.type}`, insertText: c.name, range, sortText: `~${c.name}` });
  }
  return { suggestions };
}

// ---- Results ----

const results = el("div", "db-results");

/** Runs a query and shows its rows. With `table`, cells can be edited when the rows include the primary key. */
async function run(sql: string, table?: string) {
  if (!connection) await loadConnection();
  const summary = el("div", "db-summary muted", "Running…");
  results.replaceChildren(summary);
  showPanelView("Database", results);
  const started = performance.now();
  let result: Result;
  try {
    result = await query(sql);
  } catch (e) {
    summary.replaceChildren(el("span", "db-error", String(e)));
    return;
  }
  const ms = Math.round(performance.now() - started);
  if (!result.columns.length) {
    summary.textContent = `${result.affected} ${result.affected === 1 ? "row" : "rows"} affected in ${ms} ms`;
    schema = null; // The statement may have changed the schema.
    return;
  }
  const count = `${result.rows.length}${result.truncated ? "+" : ""} ${result.rows.length === 1 ? "row" : "rows"}`;
  summary.textContent = `${table ?? "Query"} · ${count} in ${ms} ms${result.truncated ? " (showing the first 1000)" : ""}`;
  const grid = el("table");
  const head = el("tr");
  head.append(el("th", "", "#"), ...result.columns.map((c) => el("th", "", c)));
  grid.createTHead().append(head);
  const body = grid.createTBody();
  const rows = result.rows.map((cells, i) => {
    const tr = el("tr");
    tr.append(el("td", "index", String(i + 1)), ...cells.map((v) => cell(el("td"), v)));
    body.append(tr);
    return tr;
  });
  const scroll = el("div", "db-grid");
  scroll.append(grid);
  results.append(scroll);
  if (table) makeEditable(sql, table, result, rows, summary, body);
}

function cell(td: HTMLElement, value: string | null) {
  td.className = value === null ? "null" : "";
  td.textContent = value === null ? "NULL" : value.length > 200 ? `${value.slice(0, 200)}…` : value;
  return td;
}

/**
 * Double-click a cell to edit it. Enter saves the change to the database at once, and Escape cancels.
 * Click a row's number to select it (⌘-click for several), to delete the selected rows.
 */
async function makeEditable(sql: string, table: string, result: Result, rows: HTMLElement[], summary: HTMLElement, body: HTMLTableSectionElement) {
  const driver = connection!.driver;
  const keys = (await query(primaryKeyQuery(driver, table)).catch(() => ({ rows: [] }))).rows.map((r) => r[0]!);
  const keyIndexes = keys.map((k) => result.columns.indexOf(k));
  if (!keys.length || keyIndexes.includes(-1)) {
    summary.append(" · read-only, because the table has no primary key");
    return;
  }
  const keyOf = (cells: (string | null)[]) => Object.fromEntries(keys.map((k, i) => [k, cells[keyIndexes[i]]]));
  const button = (label: string, name: string, onclick: () => unknown) => {
    const b = el("button", "db-action");
    b.append(icon(name), label);
    b.onclick = onclick;
    summary.append(b);
    return b;
  };

  button("Add Row", "add", () => {
    if (body.querySelector(".new-row")) return;
    const tr = el("tr", "new-row");
    const inputs = result.columns.map((c) => {
      const input = el("input");
      input.placeholder = "default";
      input.title = `${c}: leave empty for the column's default, or type NULL`;
      const td = el("td", "editing");
      td.append(input);
      return { c, input, td };
    });
    tr.append(el("td", "index", "new"), ...inputs.map((i) => i.td));
    body.prepend(tr);
    tr.parentElement!.parentElement!.parentElement!.scrollTop = 0;
    inputs[0]?.input.focus();
    tr.onkeydown = async (e) => {
      e.stopPropagation();
      if (e.key === "Escape") tr.remove();
      if (e.key !== "Enter") return;
      const values = Object.fromEntries(inputs.filter((i) => i.input.value !== "").map((i) => [i.c, i.input.value === "NULL" ? null : i.input.value]));
      try {
        await query(insertStatement(driver, table, values));
        host.status(`Added a row to ${table}`);
        run(sql, table);
      } catch (e) {
        host.status(`Can't add the row to ${table}: ${String(e)}`);
      }
    };
  });

  const selected = new Set<number>();
  const remove = button("Delete Rows", "trash", () => {
    const count = selected.size;
    const label = `Delete ${count} ${count === 1 ? "row" : "rows"} from ${table}`;
    // Confirmed in the palette rather than a native dialog, which a page reload could leave stuck on screen.
    pick(`${label}? This can't be undone.`, () => [
      {
        label,
        run: async () => {
          let deleted = 0;
          try {
            for (const r of selected) deleted += (await query(deleteStatement(driver, table, keyOf(result.rows[r])))).affected;
            host.status(`Deleted ${deleted} ${deleted === 1 ? "row" : "rows"} from ${table}`);
          } catch (e) {
            host.status(`Deleted ${deleted}, then stopped: ${String(e)}`);
          }
          run(sql, table);
        },
      },
      { label: "Cancel", run: () => {} },
    ]);
  });
  remove.disabled = true;
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
      remove.disabled = !selected.size;
    };
  });
  rows.forEach((tr, r) =>
    result.columns.forEach((column, c) => {
      const td = tr.children[c + 1] as HTMLElement;
      td.title = "Double-click to edit. Type NULL for a null value.";
      td.ondblclick = () => {
        const cells = result.rows[r];
        const input = el("input");
        input.value = cells[c] ?? "NULL";
        td.replaceChildren(input);
        td.classList.add("editing");
        input.focus();
        input.select();
        let done = false;
        const finish = async (save: boolean) => {
          if (done) return;
          done = true;
          const value = input.value === "NULL" ? null : input.value;
          if (save && value !== cells[c]) {
            try {
              const { affected } = await query(updateStatement(driver, table, column, value, keyOf(cells)));
              if (affected !== 1) throw new Error(`${affected} rows matched the row's key`);
              cells[c] = value;
              host.status(`Updated ${table}.${column}`);
            } catch (e) {
              host.status(`Can't update ${table}.${column}: ${String(e)}`);
            }
          }
          td.classList.remove("editing");
          cell(td, cells[c]);
        };
        input.onkeydown = (e) => {
          if (e.key === "Enter") finish(true);
          if (e.key === "Escape") finish(false);
          e.stopPropagation();
        };
        input.onblur = () => finish(false);
      };
    }),
  );
}

export function initDatabase(h: Host) {
  host = h;
  $("db-refresh").onclick = loadTables;
  monaco.languages.registerCompletionItemProvider("sql", { triggerCharacters: ["."], provideCompletionItems });
  $("db-console").onclick = openConsole;
  monaco.editor.addEditorAction({
    id: "phpEditor.runSql",
    label: "Execute Query",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
    precondition: "editorLangId == sql",
    contextMenuGroupId: "navigation",
    run: runFromEditor,
  });
}
