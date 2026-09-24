// Database tool: tables and columns in the sidebar, a query console, and a results grid in the panel.
// The connection comes from the project's .env, as Laravel reads it.
import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { columnsQuery, type Connection, connectionFromEnv, hasCode, parseEnv, quoteIdentifier, statementAt, tablesQuery } from "./dbconfig";
import { monaco } from "./editor";
import { showPanelView } from "./terminal";

type Result = { columns: string[]; rows: (string | null)[][]; affected: number; truncated: boolean };
type Host = { root(): string; openFile(path: string): Promise<unknown>; status(text: string): void };

const $ = (id: string) => document.getElementById(id)!;
let host: Host;
let connection: Connection | null = null;

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
  connection = connectionFromEnv(parseEnv(env), host.root());
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

// ---- Results ----

const results = el("div", "db-results");

async function run(sql: string, title = "Query") {
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
    return;
  }
  const count = `${result.rows.length}${result.truncated ? "+" : ""} ${result.rows.length === 1 ? "row" : "rows"}`;
  summary.textContent = `${title} · ${count} in ${ms} ms${result.truncated ? " (showing the first 1000)" : ""}`;
  const table = el("table");
  const head = el("tr");
  head.append(el("th", "", "#"), ...result.columns.map((c) => el("th", "", c)));
  table.createTHead().append(head);
  const body = table.createTBody();
  result.rows.forEach((cells, i) => {
    const tr = el("tr");
    tr.append(el("td", "index", String(i + 1)), ...cells.map((v) => (v === null ? el("td", "null", "NULL") : el("td", "", v.length > 200 ? `${v.slice(0, 200)}…` : v))));
    body.append(tr);
  });
  const scroll = el("div", "db-grid");
  scroll.append(table);
  results.append(scroll);
}

export function initDatabase(h: Host) {
  host = h;
  $("db-refresh").onclick = loadTables;
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
