// Database tool: tables and columns in the sidebar, a query console, and a results grid in the panel.
// The connection comes from the project's .env, as Laravel reads it, or one saved in the editor or in config/database.php,
// optionally through an SSH tunnel.
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
  repeatsEnv,
  schemaQuery,
  statementAt,
  tablesQuery,
  updateStatement,
} from "./dbconfig";
import { monaco } from "./editor";
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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}
const icon = (name: string) => el("span", `codicon codicon-${name}`);

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
  const c = saved ? connectionFromUrl(saved.url, host.root()) : (await configConnections()).get(name);
  return c && saved ? { ...c, password: await password(name) } : (c ?? null);
}

async function loadConnection() {
  let name = selectedName();
  let c = name ? await namedConnection(name) : null;
  if (!c) (name = ""), setItem(selectedKey(), ""), (c = await envConnection());
  schema = null;
  const ssh = c.driver === "sqlite" ? "" : sshDestination();
  $("db-connection").textContent = `${name || ".env"} · ${describe(c, host.root())}${ssh ? ` · via ${ssh}` : ""}`;
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
    "Connection URL, such as mysql://user:password@host:3306/database, pgsql://…, or sqlite:database/other.sqlite",
    (q) => {
      const c = connectionFromUrl(q, root);
      if (!c) return [{ label: q.trim() ? "Not a database URL" : "Type a URL", detail: "mysql://, mariadb://, pgsql://, or sqlite:", run: () => editConnection(existing, q) }];
      return [{ label: "Next: name the connection", detail: `${describe(c, root)}${existing && !c.password ? " · keeps the saved password" : ""}`, run: () => nameConnection(c, existing) }];
    },
    0,
    { value },
  );
}

function nameConnection(c: Connection, existing?: Saved) {
  const suggested = existing?.name ?? (c.driver === "sqlite" ? c.database.split("/").pop()! : `${c.database}@${c.host}`);
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
  row.ondblclick = () => run(`SELECT * FROM ${quoteIdentifier(connection!.driver, table)}`, table);
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

function button(parent: HTMLElement, label: string, name: string, onclick: () => unknown) {
  const b = el("button", "db-action");
  b.append(icon(name), label);
  b.onclick = onclick;
  parent.append(b);
  return b;
}

/**
 * Runs a query and shows a page of its rows. With `table`, cells can be edited when the rows include the primary key.
 * A table's page is a LIMIT in the SQL, so the database reads only that page, and its count is a COUNT(*). Another
 * statement's page is skipped to in db.rs, which counts every row the statement returns.
 */
async function run(sql: string, table?: string, page = 0) {
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
    summary.replaceChildren(el("span", "db-error", String(e)));
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
  summary.replaceChildren(`${table ?? "Query"} · `, count, ` in ${ms} ms`);
  const total = (t: number) => (count.textContent += ` of ${t.toLocaleString()}`);
  if (paged && !table) total(result.total);
  if (paged && table) query(`SELECT COUNT(*) FROM ${quoteIdentifier(connection!.driver, table)}`).then((r) => count.isConnected && total(Number(r.rows[0][0])), () => {});
  // Pages change only without pending changes: makeEditable disables these while there are some.
  if (page > 0) button(summary, "Previous", "chevron-left", () => run(sql, table, page - 1)).classList.add("db-page");
  if (result.truncated) button(summary, "Next", "chevron-right", () => run(sql, table, page + 1)).classList.add("db-page");
  const grid = el("table");
  const head = el("tr");
  head.append(el("th", "", "#"), ...result.columns.map((c) => el("th", "", c)));
  grid.createTHead().append(head);
  const body = grid.createTBody();
  const rows = result.rows.map((cells, i) => {
    const tr = el("tr");
    tr.append(el("td", "index", String(offset + i + 1)), ...cells.map((v) => cell(el("td"), v)));
    body.append(tr);
    return tr;
  });
  const scroll = el("div", "db-grid");
  scroll.append(grid);
  results.append(scroll);
  if (table) makeEditable(() => run(sql, table, page), table, result, rows, summary, body);
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
async function makeEditable(again: () => void, table: string, result: Result, rows: HTMLElement[], summary: HTMLElement, body: HTMLTableSectionElement) {
  const driver = connection!.driver;
  const keys = (await query(primaryKeyQuery(driver, table)).catch(() => ({ rows: [] }))).rows.map((r) => r[0]!);
  const keyIndexes = keys.map((k) => result.columns.indexOf(k));
  if (!keys.length || keyIndexes.includes(-1)) {
    summary.append(" · read-only, because the table has no primary key");
    return;
  }
  const keyOf = (cells: (string | null)[]) => Object.fromEntries(keys.map((k, i) => [k, cells[keyIndexes[i]]]));
  const action = (label: string, name: string, onclick: () => unknown) => button(summary, label, name, onclick);

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

  action("Add Row", "add", () => {
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
  const remove = action("Delete Rows", "trash", () => {
    for (const r of selected) deletes.add(r), rows[r].classList.add("deleted");
    selected.clear();
    rows.forEach((row) => row.classList.remove("selected"));
    remove.disabled = true;
    changed();
  });
  remove.disabled = true;
  const submit = action("Submit", "check", async () => {
    const list = statements();
    if (!list.length) return;
    submit.disabled = true;
    try {
      await invoke("db_batch", { connection, statements: list, oneRowEach: true });
      host.status(`Saved ${list.length} ${list.length === 1 ? "change" : "changes"} to ${table}`);
      again();
    } catch (e) {
      host.status(`Can't save the changes to ${table}: ${String(e)}`);
      submit.disabled = false;
    }
  });
  const revert = action("Revert", "discard", again);
  /** Updates the Submit and Revert buttons after a change, with the SQL they'd run as Submit's tooltip. */
  const changed = () => {
    const list = statements();
    submit.disabled = revert.disabled = !list.length;
    submit.lastChild!.textContent = list.length ? `Submit ${list.length} ${list.length === 1 ? "Change" : "Changes"}` : "Submit";
    submit.title = list.join(";\n");
    summary.querySelectorAll<HTMLButtonElement>(".db-page").forEach((b) => (b.disabled = !!list.length));
  };
  changed();
  results.onkeydown = (e) => {
    if (e.key === "Enter" && e.metaKey && !submit.disabled) e.preventDefault(), submit.click();
  };

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
  $("db-refresh").onclick = () => ((config = undefined), loadTables());
  $("db-connection").onclick = chooseConnection;
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
