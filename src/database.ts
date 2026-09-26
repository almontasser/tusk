// Database tool: tables and columns in the sidebar, a query console, and a results grid in the panel.
// The connection comes from the project's .env, as Laravel reads it, or one saved in the editor or in config/database.php,
// optionally through an SSH tunnel. A Redis connection lists keys instead of tables, and its console runs commands.
import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import {
  columnsQuery,
  type Connection,
  connectionFromConfig,
  connectionFromEnv,
  connectionFromUrl,
  connectionUrl,
  describe,
  deleteStatement,
  hasCode,
  insertStatement,
  parseEnv,
  primaryKeyQuery,
  quoteIdentifier,
  redisFromEnv,
  repeatsEnv,
  schemaQuery,
  statementAt,
  tablesQuery,
  updateStatement,
} from "./dbconfig";
import { button, type Changes, el, grid, icon, makeEditable } from "./dbgrid";
import { monaco } from "./editor";
import { confirmCommands, initRedis, loadKeys, runLines, showRedisSidebar } from "./redis";
import { splitCommand } from "./redisdata";
import { type Item, pick, rank } from "./palette";
import { usesSail } from "./sail";
import { showPanelView } from "./terminal";

type Result = { columns: string[]; rows: (string | null)[][]; affected: number; truncated: boolean; total: number };
type Host = { root(): string; openFile(path: string): Promise<unknown>; status(text: string): void };

const $ = (id: string) => document.getElementById(id)!;
let host: Host;
let connection: Connection | null = null;
/** Columns per table, loaded once per connection for completion. */
let schema: Promise<Map<string, { name: string; type: string }[]>> | null = null;


const query = (sql: string, offset = 0) => invoke<Result>("db_query", { connection, sql, offset });
/** Rows per page, as db.rs's MAX_ROWS. */
const PAGE = 1000;

function getItem(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function setItem(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {}
}

/**
 * Connections saved in the editor, per project, by name and URL without the password, which is in the Keychain.
 * The selected one is "" for .env's.
 */
type Saved = { name: string; url: string };
const savedKey = () => `db:connections:${host.root()}`;
const selectedKey = () => `db:connection:${host.root()}`;
const account = (name: string) => `${host.root()}#${name}`;
const savedConnections = (): Saved[] => JSON.parse(getItem(savedKey()) || "[]");
const selectedName = () => getItem(selectedKey());
const password = async (name: string) => (await invoke<string | null>("db_password", { account: account(name) })) ?? "";

/** The SSH destination a connection is reached through, or "" to connect directly. */
const sshKey = (name = selectedName()) => `db:ssh:${host.root()}${name ? `#${name}` : ""}`;
const sshDestination = () => getItem(sshKey());

const readEnv = async () => parseEnv(await invoke<string>("read_file", { path: `${host.root()}/.env` }).catch(() => ""));
const envConnection = async () => connectionFromEnv(await readEnv(), host.root(), await usesSail(host.root()));
/** Laravel's `redis` and `redis cache` connections, from .env's REDIS_ variables. */
const envRedis = async () => redisFromEnv(await readEnv(), host.root(), await usesSail(host.root()));
const isRedis = () => connection?.driver === "redis";

/**
 * config/database.php's connections other than the default, which .env gives, and Laravel's stock entries, which
 * repeat it. Read once per project, by booting the app.
 */
let config: { root: string; connections: Promise<Map<string, Connection>> } | undefined;
function configConnections() {
  const root = host.root();
  if (config?.root === root) return config.connections;
  const php = `require 'vendor/autoload.php'; $app = require 'bootstrap/app.php'; $app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap(); echo json_encode(['default' => config('database.default'), 'connections' => config('database.connections')]);`;
  const connections = Promise.all([invoke<string>("run_capture", { cwd: root, program: "php", args: ["-r", php], input: null }), readEnv()])
    .then(([out, env]) => {
      const { default: name, connections } = JSON.parse(out.slice(out.indexOf("{")));
      const map = new Map<string, Connection>();
      for (const [n, c] of Object.entries<Record<string, unknown>>(connections ?? {})) {
        const connection = n === name ? null : connectionFromConfig(c, root);
        if (connection && !repeatsEnv(connection, env, root)) map.set(n, connection);
      }
      return map;
    })
    .catch(() => new Map<string, Connection>());
  config = { root, connections };
  return connections;
}

async function namedConnection(name: string): Promise<Connection | null> {
  const saved = savedConnections().find((s) => s.name === name);
  const c = saved ? connectionFromUrl(saved.url, host.root()) : ((await configConnections()).get(name) ?? (await envRedis())[name]);
  return c && saved ? { ...c, password: await password(name) } : (c ?? null);
}

async function loadConnection() {
  let name = selectedName();
  let c = name ? await namedConnection(name) : null;
  if (!c) (name = ""), setItem(selectedKey(), ""), (c = await envConnection());
  schema = null;
  showRedisSidebar(c.driver === "redis");
  const ssh = c.driver === "sqlite" ? "" : sshDestination();
  $("db-connection-name").textContent = `${name || ".env"} · ${describe(c, host.root())}${ssh ? ` · via ${ssh}` : ""}`;
  connection = null;
  // Through SSH, the host and port are as the SSH server sees them, such as 127.0.0.1:3306 on the server.
  connection = ssh ? { ...c, host: "127.0.0.1", port: await invoke<number>("db_tunnel", { destination: ssh, host: c.host, port: c.port }) } : c;
}

/** Switches between .env's connection, saved ones, and config/database.php's, and adds, edits, or removes saved ones. */
export async function chooseConnection() {
  const root = host.root();
  if (!root) return;
  const current = selectedName();
  const saved = savedConnections();
  const select = (name: string) => () => (setItem(selectedKey(), name), loadTables());
  const mark = (name: string) => (name === current ? "codicon-check" : "codicon-database");
  const items: Item[] = [
    { label: ".env", detail: describe(await envConnection(), root), icon: mark(""), run: select("") },
    ...saved.map((s) => ({ label: s.name, detail: s.url, icon: mark(s.name), run: select(s.name) })),
    ...[...(await configConnections())]
      .filter(([n]) => !saved.some((s) => s.name === n))
      .map(([n, c]) => ({ label: n, detail: `config/database.php · ${describe(c, root)}`, icon: mark(n), run: select(n) })),
    ...Object.entries(await envRedis())
      .filter(([n]) => !saved.some((s) => s.name === n))
      .map(([n, c]) => ({ label: n, detail: `.env · ${describe(c, root)}`, icon: mark(n), run: select(n) })),
    { label: "Add Connection…", icon: "codicon-add", run: () => editConnection() },
  ];
  const active = saved.find((s) => s.name === current);
  if (active)
    items.push(
      { label: `Edit ${active.name}…`, icon: "codicon-edit", run: () => editConnection(active) },
      { label: `Remove ${active.name}`, icon: "codicon-trash", run: () => removeConnection(active) },
    );
  pick("Switch the database connection", (q) => rank(q, items), 0, { value: "", anchor: $("db-connection") });
}

/** Asks for a connection's URL, then its name. Without a password in the URL, an edit keeps the saved one. */
function editConnection(existing?: Saved, value = existing?.url ?? "") {
  const root = host.root();
  pick(
    "Connection URL, such as mysql://user:password@host:3306/database, pgsql://…, sqlite:database/other.sqlite, or redis://:password@host:6379/0",
    (q) => {
      const c = connectionFromUrl(q, root);
      if (!c) return [{ label: q.trim() ? "Not a database URL" : "Type a URL", detail: "mysql://, mariadb://, pgsql://, sqlite:, redis://, or rediss://", run: () => editConnection(existing, q) }];
      return [{ label: "Next: name the connection", detail: `${describe(c, root)}${existing && !c.password ? " · keeps the saved password" : ""}`, run: () => nameConnection(c, existing) }];
    },
    0,
    { value },
  );
}

function nameConnection(c: Connection, existing?: Saved) {
  const suggested = existing?.name ?? (c.driver === "sqlite" ? c.database.split("/").pop()! : `${c.driver === "redis" ? "redis" : c.database}@${c.host}`);
  pick("Name the connection", (q) => [{ label: `Save as ${q.trim() || suggested}`, detail: describe(c, host.root()), run: () => saveConnection(q.trim() || suggested, c, existing) }], 0, {
    value: suggested,
    select: [0, suggested.length],
  });
}

async function saveConnection(name: string, c: Connection, existing?: Saved) {
  try {
    const secret = c.password || (existing ? await password(existing.name) : "");
    if (existing) await invoke("db_set_password", { account: account(existing.name), password: "" });
    await invoke("db_set_password", { account: account(name), password: secret });
  } catch (e) {
    host.status(`Can't save the password in the Keychain: ${String(e)}`);
    return;
  }
  if (existing && existing.name !== name) setItem(sshKey(name), getItem(sshKey(existing.name))), setItem(sshKey(existing.name), "");
  const others = savedConnections().filter((s) => s.name !== name && s.name !== existing?.name);
  setItem(savedKey(), JSON.stringify([...others, { name, url: connectionUrl(c, host.root()) }]));
  setItem(selectedKey(), name);
  loadTables();
}

async function removeConnection(s: Saved) {
  await invoke("db_set_password", { account: account(s.name), password: "" }).catch(() => {});
  setItem(sshKey(s.name), "");
  setItem(savedKey(), JSON.stringify(savedConnections().filter((x) => x.name !== s.name)));
  setItem(selectedKey(), "");
  loadTables();
}

/** Sets the SSH server to reach the selected connection's database through, or connects directly again. */
export function connectOverSsh() {
  if (!host.root()) return;
  pick(
    "Database over SSH: type a destination, such as forge@203.0.113.5, ssh://user@host:2222, or a host from ~/.ssh/config",
    (q) => [
      {
        label: q.trim() ? `Connect through ${q.trim()}` : "Connect directly, without SSH",
        detail: q.trim() ? "Uses your SSH keys or agent; the connection's host and port are as the server sees them" : "",
        run: () => (setItem(sshKey(), q.trim()), loadTables()),
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
  // Switching back to the view keeps the last tables while they refresh; a new project or connection starts over.
  configConnections(); // In the background, so the switcher opens at once.
  const key = `${host.root()}#${selectedName()}`;
  if (list.dataset.root !== key) (list.dataset.root = key), list.replaceChildren(el("li", "muted", "Loading…"));
  try {
    await loadConnection();
    if (isRedis()) return await loadKeys();
    const result = await query(tablesQuery(connection!.driver));
    const tables = result.rows.map((r) => r[0] ?? "");
    list.replaceChildren(...(tables.length ? tables.map(tableRow) : [el("li", "muted", "No tables. Run the migrations with php artisan migrate.")]));
    if (result.truncated) list.append(el("li", "muted", `The first ${PAGE.toLocaleString()} of ${result.total.toLocaleString()} tables.`));
  } catch (e) {
    list.replaceChildren(el("li", "muted", `Can't connect: ${friendlyError(String(e))}`));
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
  row.ondblclick = () => run(`SELECT * FROM ${quoteIdentifier(connection!.driver, table)}`, table);
  li.append(row, columns);
  return li;
}

// ---- Console ----

/**
 * Opens the project's query console, a .sql file kept in the app's data folder rather than in the project, or for a
 * Redis connection, a .redis file of commands.
 */
export async function openConsole() {
  if (!host.root()) return;
  if (!connection) await loadConnection().catch(() => {});
  const dir = `${await appDataDir()}/consoles/${host.root().replace(/[^A-Za-z0-9]+/g, "_")}`;
  const path = `${dir}/console.${isRedis() ? "redis" : "sql"}`;
  if (!(await invoke<boolean>("path_exists", { path }))) {
    await invoke("create_dir", { path: dir });
    const hint = isRedis() ? "# ⌘⏎ runs the command on the caret's line, or each line of the selection. Completion suggests commands and keys." : "-- ⌘⏎ runs the statement under the caret, or the selection.";
    await invoke("write_file", { path, contents: `${hint}\n\n` });
  }
  await host.openFile(path);
}

/** Runs the selection, or the statement under the caret, from a .sql editor, or the caret's line from a .redis one. */
export function runFromEditor(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) return;
  if (model.getLanguageId() === "redis") return runRedis(selection.isEmpty() ? model.getLineContent(selection.positionLineNumber) : model.getValueInRange(selection));
  const sql = selection.isEmpty() ? statementAt(model.getValue(), model.getOffsetAt(selection.getPosition())) : model.getValueInRange(selection);
  if (hasCode(sql)) run(sql);
}

/**
 * Runs Redis console lines: one command shows its reply in the grid, and several run in one round trip with a row
 * each. Lines starting with # are the console's comments; Redis itself has none.
 */
async function runRedis(text: string) {
  if (!connection) await loadConnection();
  if (!isRedis()) return host.status("Select a Redis connection in the Database tool to run Redis commands.");
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length > 1) return runLines(lines);
  if (!lines.length) return;
  const args = splitCommand(lines[0]);
  if (args && !(await confirmCommands([args]))) return;
  run(lines[0], undefined, 0, lines[0]);
}

// ---- Completion ----

function loadSchema() {
  schema ??= (async () => {
    if (!connection) await loadConnection();
    const tables = new Map<string, { name: string; type: string }[]>();
    if (isRedis()) return tables;
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

export const results = el("div", "db-results");

/**
 * Runs a query and shows a page of its rows. With `table`, cells can be edited when the rows include the primary key.
 * A table's page is a LIMIT in the SQL, so the database reads only that page, and its count is a COUNT(*). Another
 * statement's page is skipped to in db.rs, which counts every row the statement returns. `label` names the rows in
 * the summary, which is the table's name, or "Query".
 */
export async function run(sql: string, table?: string, page = 0, label = table ?? "Query") {
  if (!connection) await loadConnection();
  results.onkeydown = null; // ⌘⏎ submits the grid's own changes, set up again by makeEditable.
  const summary = el("div", "db-summary muted", "Running…");
  results.replaceChildren(summary);
  showPanelView("Database", results);
  const started = performance.now();
  let result: Result;
  try {
    result = table ? await query(`${sql} LIMIT ${PAGE + 1} OFFSET ${page * PAGE}`) : await query(sql, page * PAGE);
  } catch (e) {
    summary.replaceChildren(el("span", "db-error", friendlyError(String(e))));
    return;
  }
  const ms = Math.round(performance.now() - started);
  if (!result.columns.length) {
    summary.textContent = `${result.affected} ${result.affected === 1 ? "row" : "rows"} affected in ${ms} ms`;
    schema = null; // The statement may have changed the schema.
    return;
  }
  const offset = page * PAGE;
  const n = result.rows.length;
  const paged = page > 0 || result.truncated;
  const count = el("span", "", paged ? `rows ${(offset + 1).toLocaleString()}–${(offset + n).toLocaleString()}` : `${n} ${n === 1 ? "row" : "rows"}`);
  summary.replaceChildren(el("span", "db-label", label), " · ", count, ` in ${ms} ms`);
  summary.title = sql;
  const total = (t: number) => (count.textContent += ` of ${t.toLocaleString()}`);
  if (paged && !table) total(result.total);
  if (paged && table) query(`SELECT COUNT(*) FROM ${quoteIdentifier(connection!.driver, table)}`).then((r) => count.isConnected && total(Number(r.rows[0][0])), () => {});
  // Pages change only without pending changes: makeEditable disables these while there are some.
  if (page > 0) button(summary, "Previous", "chevron-left", () => run(sql, table, page - 1, label)).classList.add("db-page");
  if (result.truncated) button(summary, "Next", "chevron-right", () => run(sql, table, page + 1, label)).classList.add("db-page");
  const { scroll, body, rows } = grid(result.columns, result.rows, offset + 1);
  results.append(scroll);
  if (table) editTable(() => run(sql, table, page), table, result, rows, summary, body);
}

/** Makes a table's rows editable when they include its primary key, which finds each row again. */
async function editTable(again: () => void, table: string, result: Result, rows: HTMLElement[], summary: HTMLElement, body: HTMLTableSectionElement) {
  const driver = connection!.driver;
  const keys = (await query(primaryKeyQuery(driver, table)).catch(() => ({ rows: [] }))).rows.map((r) => r[0]!);
  const keyIndexes = keys.map((k) => result.columns.indexOf(k));
  if (!keys.length || keyIndexes.includes(-1)) {
    summary.append(" · read-only, because the table has no primary key");
    return;
  }
  const keyOf = (cells: (string | null)[]) => Object.fromEntries(keys.map((k, i) => [k, cells[keyIndexes[i]]]));
  // Deletes first, so a row edited to take a deleted row's key doesn't collide with it. Updates are keyed on
  // each row's values before the change, so editing a key column still finds its row.
  const statements = ({ edits, deletes, inserts }: Changes) => [
    ...[...deletes].map((r) => deleteStatement(driver, table, keyOf(result.rows[r]))),
    ...[...edits].filter(([r]) => !deletes.has(r)).map(([r, cells]) => updateStatement(driver, table, Object.fromEntries([...cells].map(([c, v]) => [result.columns[c], v])), keyOf(result.rows[r]))),
    ...inserts.map((values) => insertStatement(driver, table, values)),
  ];
  makeEditable({
    summary,
    results,
    body,
    rows,
    columns: result.columns,
    values: result.rows,
    nulls: true,
    empty: "default",
    describe: statements,
    submit: (changes) => invoke("db_batch", { connection, statements: statements(changes), oneRowEach: true }),
    target: table,
    status: host.status,
    again,
  });
}

/** An error with a hint for the common ones, such as a server that isn't running. */
export function friendlyError(message: string): string {
  if (/NOAUTH/.test(message)) return `${message} Redis needs a password: add it to the connection's URL, or set REDIS_PASSWORD in .env.`;
  if (/WRONGPASS/.test(message)) return `${message} Check the password in the connection's URL, or REDIS_PASSWORD and REDIS_USERNAME in .env.`;
  if (/Connection refused/i.test(message)) return `${message}. Is the server running? For Sail, run sail up.`;
  return message;
}

export function initDatabase(h: Host) {
  host = h;
  initRedis({ connection: () => connection, results, status: (text) => host.status(text), friendlyError });
  $("db-refresh").onclick = () => ((config = undefined), loadTables());
  $("db-connection").onclick = chooseConnection;
  monaco.languages.registerCompletionItemProvider("sql", { triggerCharacters: ["."], provideCompletionItems });
  $("db-console").onclick = openConsole;
  monaco.editor.addEditorAction({
    id: "phpEditor.runSql",
    label: "Execute Query",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
    precondition: "editorLangId == sql || editorLangId == redis",
    contextMenuGroupId: "navigation",
    run: runFromEditor,
  });
}
