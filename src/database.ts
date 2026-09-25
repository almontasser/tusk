// Database tool: tables and columns in the sidebar, a query console, and a results grid in the panel.
// The connection comes from the project's .env, as Laravel reads it, optionally through an SSH tunnel.
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

/** The SSH destination the project's database is reached through, or "" to connect directly. */
const sshKey = () => `db:ssh:${host.root()}`;
function sshDestination() {
  try {
    return localStorage.getItem(sshKey()) ?? "";
  } catch {
    return "";
  }
}

async function loadConnection() {
  const env = await invoke<string>("read_file", { path: `${host.root()}/.env` }).catch(() => "");
  const c = connectionFromEnv(parseEnv(env), host.root(), await usesSail(host.root()));
  schema = null;
  const ssh = c.driver === "sqlite" ? "" : sshDestination();
  $("db-connection").textContent =
    c.driver === "sqlite"
      ? `SQLite · ${c.database.replace(host.root() + "/", "")}`
      : `${c.driver} · ${c.username}@${c.host}:${c.port}/${c.database}${ssh ? ` · via ${ssh}` : ""}${c.ssl_mode || c.ssl_ca ? ` · TLS ${c.ssl_mode}`.trimEnd() : ""}`;
  connection = null;
  // Through SSH, .env's host and port are as the SSH server sees them, such as 127.0.0.1:3306 on the server.
  connection = ssh ? { ...c, host: "127.0.0.1", port: await invoke<number>("db_tunnel", { destination: ssh, host: c.host, port: c.port }) } : c;
}

/** Sets the SSH server to reach the project's database through, or connects directly again. */
export function connectOverSsh() {
  if (!host.root()) return;
  pick(
    "Database over SSH: type a destination, such as forge@203.0.113.5, ssh://user@host:2222, or a host from ~/.ssh/config",
    (q) => [
      {
        label: q.trim() ? `Connect through ${q.trim()}` : "Connect directly, without SSH",
        detail: q.trim() ? "Uses your SSH keys or agent; .env's DB_HOST and DB_PORT are as the server sees them" : "",
        run: () => {
          try {
            if (q.trim()) localStorage.setItem(sshKey(), q.trim());
            else localStorage.removeItem(sshKey());
          } catch {}
          loadTables();
        },
      },
    ],
    0,
    { value: sshDestination() },
  );
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
  results.onkeydown = null; // ⌘⏎ submits the grid's own changes, set up again by makeEditable.
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
 * Double-click a cell to edit it, Enter keeps the change, and Escape cancels. Click a row's number to select
 * it (⌘-click for several) for Delete Rows, and Add Row adds one. Changes wait, marked in the grid, until
 * Submit (or ⌘⏎) applies them all in one transaction; Revert drops them.
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

  // Pending changes: new values by row and column, rows to delete, and rows to add.
  const edits = new Map<number, Map<number, string | null>>();
  const deletes = new Set<number>();
  const inserts: Record<string, string | null>[] = [];
  // Deletes first, so a row edited to take a deleted row's key doesn't collide with it. Updates are keyed on
  // each row's values before the change, so editing a key column still finds its row.
  const statements = () => [
    ...[...deletes].map((r) => deleteStatement(driver, table, keyOf(result.rows[r]))),
    ...[...edits].filter(([r]) => !deletes.has(r)).map(([r, cells]) => updateStatement(driver, table, Object.fromEntries([...cells].map(([c, v]) => [result.columns[c], v])), keyOf(result.rows[r]))),
    ...inserts.map((values) => insertStatement(driver, table, values)),
  ];

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
    tr.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Escape") tr.remove();
      if (e.key !== "Enter" || e.metaKey) return;
      const values = Object.fromEntries(inputs.filter((i) => i.input.value !== "").map((i) => [i.c, i.input.value === "NULL" ? null : i.input.value]));
      inserts.push(values);
      // The row stays, showing what will be added.
      tr.className = "added";
      tr.onkeydown = null;
      inputs.forEach((i) => cell(i.td, i.input.value === "" ? "default" : values[i.c] ?? null));
      changed();
    };
  });

  const selected = new Set<number>();
  const remove = button("Delete Rows", "trash", () => {
    for (const r of selected) deletes.add(r), rows[r].classList.add("deleted");
    selected.clear();
    rows.forEach((row) => row.classList.remove("selected"));
    remove.disabled = true;
    changed();
  });
  remove.disabled = true;
  const submit = button("Submit", "check", async () => {
    const list = statements();
    if (!list.length) return;
    submit.disabled = true;
    try {
      await invoke("db_batch", { connection, statements: list, oneRowEach: true });
      host.status(`Saved ${list.length} ${list.length === 1 ? "change" : "changes"} to ${table}`);
      run(sql, table);
    } catch (e) {
      host.status(`Can't save the changes to ${table}: ${String(e)}`);
      submit.disabled = false;
    }
  });
  const revert = button("Revert", "discard", () => run(sql, table));
  /** Updates the Submit and Revert buttons after a change, with the SQL they'd run as Submit's tooltip. */
  const changed = () => {
    const list = statements();
    submit.disabled = revert.disabled = !list.length;
    submit.lastChild!.textContent = list.length ? `Submit ${list.length} ${list.length === 1 ? "Change" : "Changes"}` : "Submit";
    submit.title = list.join(";\n");
  };
  changed();
  results.onkeydown = (e) => e.key === "Enter" && e.metaKey && !submit.disabled && (e.preventDefault(), submit.click());

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
    result.columns.forEach((_, c) => {
      const td = tr.children[c + 1] as HTMLElement;
      td.title = "Double-click to edit. Type NULL for a null value.";
      const current = () => (edits.get(r)?.has(c) ? edits.get(r)!.get(c)! : result.rows[r][c]);
      const show = () => (cell(td, current()), td.classList.toggle("changed", !!edits.get(r)?.has(c)));
      td.ondblclick = () => {
        if (deletes.has(r)) return;
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
            const value = input.value === "NULL" ? null : input.value;
            const row = edits.get(r) ?? edits.set(r, new Map()).get(r)!;
            // Back to the original value is no change at all.
            value === result.rows[r][c] ? row.delete(c) : row.set(c, value);
            if (!row.size) edits.delete(r);
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
