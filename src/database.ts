// Database tool: tables and columns in the sidebar, a query console, and results in the panel.
// The connection comes from the project's .env, as Laravel reads it, or one saved in the editor or in config/database.php,
// optionally through an SSH tunnel. A Redis connection lists keys instead of tables, and its console runs commands.
import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { openDataSources, type Source, type SourceEdit, type Ssh } from "./datasources";
import {
  columnsQuery,
  type Connection,
  connectionFromConfig,
  connectionFromEnv,
  connectionFromUrl,
  connectionUrl,
  defaultsQuery,
  deleteStatement,
  describe,
  foreignKeysQuery,
  hasCode,
  indexesQuery,
  insertStatement,
  insertTemplate,
  parseEnv,
  primaryKeyQuery,
  quoteIdentifier,
  readsOnly,
  redisFromEnv,
  repeatsEnv,
  schemaQuery,
  selectTemplate,
  splitStatements,
  type SqlValue,
  statementAt,
  tablesQuery,
  updateStatement,
  versionQuery,
  versionText,
} from "./dbconfig";
import { button, type Changes, confirmDiscard, dataGrid, el, icon, type Sort, type Value } from "./dbgrid";
import type { Cell } from "./dbgriddata";
import { h } from "./dom";
import { monaco } from "./editor";
import { showMenu } from "./files";
import { listNav, type ListNav } from "./listnav";
import { type Item, pick, rank } from "./palette";
import { projectScope, projectValue, setProjectScope, setProjectValue, shareItem } from "./projectstate";
import { confirmCommands, initRedis, loadKeys, runLines, showRedisSidebar } from "./redis";
import { splitCommand } from "./redisdata";
import { usesSail } from "./sail";
import { registerSettings } from "./settings";
import { errorText, showError, status } from "./status";
import { showPanelView } from "./terminal";
import { keyText, mod } from "./platform.ts";

type Result = { columns: string[]; rows: Cell[][]; affected: number; truncated: boolean; total: number; binary?: number[] };
type Host = { root(): string; openFile(path: string): Promise<unknown>; status(text: string): void };

const $ = (id: string) => document.getElementById(id)!;
let host: Host;
let connection: Connection | null = null;
/** Why the selected connection can't be reached, shown until it can. */
let connectionError = "";
/** Columns per table, loaded once per connection for completion and the tables' search. */
let schema: Promise<Map<string, { name: string; type: string }[]>> | null = null;
let nav: ListNav;

const settings = registerSettings(
  "Database",
  { databasePageSize: 1000, databaseConnectTimeout: 10, databaseQueryTimeout: 0, databaseRedisTimeout: 60 },
  [
    { key: "databasePageSize", label: "Rows per page", type: "number", min: 10, max: 100000, help: "Rows a query or table shows at a time. Next and Previous page through the rest." },
    { key: "databaseConnectTimeout", label: "Connection timeout (seconds)", type: "number", min: 1, max: 300, help: "How long to wait for a database or Redis server, or for SQLite's lock." },
    { key: "databaseQueryTimeout", label: "Query timeout (seconds)", type: "number", min: 0, max: 86400, help: "Cancels a query that runs longer. 0 lets queries run until you cancel them." },
    { key: "databaseRedisTimeout", label: "Redis command timeout (seconds)", type: "number", min: 0, max: 3600, help: "How long a Redis command, such as BLPOP, may wait for a reply. 0 waits forever." },
  ],
);
const pageSize = () => settings.databasePageSize || 1000;

/** The connection with the Database settings that db.rs reads: rows per page and timeouts. */
const limited = (c: Connection | null, rows = pageSize()) =>
  c && { ...c, page_size: rows, connect_timeout: settings.databaseConnectTimeout || 10, read_timeout: settings.databaseRedisTimeout };
const query = (sql: string, offset = 0) => invoke<Result>("db_query", { connection: limited(connection), sql, offset });

/** Saves a project value (projectstate.ts), or removes it when empty, and says so when that fails. */
const save = (key: string, value: unknown) =>
  setProjectValue(key, value === "" || (Array.isArray(value) && !value.length) || (value && typeof value === "object" && !Object.keys(value).length) ? undefined : value).catch((e) =>
    showError("Can't save the connection", e),
  );

// ---- Connections ----

/**
 * Connections saved per project (`databaseConnections`, which you can share in tusk.json), by name and URL without
 * the password, which is in the Keychain. The selected one (`databaseConnection`, on this Mac) is "" for .env's.
 */
type Saved = { name: string; url: string };
const account = (name: string) => `${host.root()}#${name}`;
const savedConnections = (): Saved[] => (projectValue<Saved[]>("databaseConnections") ?? []).filter((s) => s && typeof s.name === "string" && typeof s.url === "string");
const selectedName = () => projectValue<string>("databaseConnection") ?? "";
const select = (name: string) => save("databaseConnection", name);
const password = async (name: string) => (await invoke<string | null>("db_password", { account: account(name) })) ?? "";

/** The SSH tunnel each connection goes through, by name ("" for .env's), in `databaseSsh`: a destination, or one with a key file. */
type SshValue = string | { destination: string; identityFile?: string };
const sshValues = () => projectValue<Record<string, SshValue>>("databaseSsh") ?? {};
function sshOf(name = selectedName()): Ssh {
  const v = sshValues()[name];
  return typeof v === "string" ? { destination: v, identityFile: "" } : { destination: v?.destination ?? "", identityFile: v?.identityFile ?? "" };
}
function setSsh(name: string, ssh: Ssh) {
  const all = { ...sshValues() };
  if (ssh.destination) all[name] = ssh.identityFile ? { destination: ssh.destination, identityFile: ssh.identityFile } : ssh.destination;
  else delete all[name];
  return save("databaseSsh", all);
}
/** Connections that refuse changes, by name ("" for .env's), in `databaseReadOnly`. */
const readOnlyNames = () => projectValue<string[]>("databaseReadOnly") ?? [];
const setReadOnly = (name: string, on: boolean) => save("databaseReadOnly", [...readOnlyNames().filter((n) => n !== name), ...(on ? [name] : [])]);

const readEnv = async () => parseEnv(await invoke<string>("read_file", { path: `${host.root()}/.env` }).catch(() => ""));
/** .env's connection, or the URL that overrides it on this Mac (`databaseEnvOverride`), with its password from the Keychain. */
async function envConnection(original = false) {
  const override = projectValue<string>("databaseEnvOverride");
  const c = !original && override ? connectionFromUrl(override, host.root()) : null;
  if (c) return { ...c, password: c.password || (await password("")) };
  return connectionFromEnv(await readEnv(), host.root(), await usesSail(host.root()));
}
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

/** Opens the SSH tunnel a connection needs, and returns the connection as reached through it. */
async function reach(c: Connection, ssh: Ssh): Promise<Connection> {
  if (!ssh.destination || c.driver === "sqlite") return c;
  // Through SSH, the host and port are as the SSH server sees them, such as 127.0.0.1:3306 on the server.
  const port = await invoke<number>("db_tunnel", { destination: ssh.destination, host: c.host, port: c.port, identity: ssh.identityFile || null });
  return { ...c, host: "127.0.0.1", port };
}

async function loadConnection() {
  let name = selectedName();
  let c = name ? await namedConnection(name) : null;
  if (!c) (name = ""), select(""), (c = await envConnection());
  schema = null;
  showRedisSidebar(c.driver === "redis");
  const ssh = c.driver === "sqlite" ? "" : sshOf(name).destination;
  const readOnly = readOnlyNames().includes(name);
  $("db-connection-name").textContent = `${name || (projectValue("databaseEnvOverride") ? ".env (overridden)" : ".env")} · ${describe(c, host.root())}${ssh ? ` · via ${ssh}` : ""}${readOnly ? " · read-only" : ""}`;
  connection = null;
  connectionError = "";
  try {
    connection = { ...(await reach(c, sshOf(name))), read_only: readOnly };
  } catch (e) {
    connectionError = errorText(e);
    throw e;
  }
}

/** Connects when there's no connection yet; false, with the error and Retry shown in `where`, when it can't. */
async function ensureConnection(where: HTMLElement, retry: () => unknown): Promise<boolean> {
  if (connection) return true;
  try {
    await loadConnection();
    return true;
  } catch (e) {
    where.replaceChildren(errorBlock(`Can't connect: ${friendlyError(errorText(e))}`, retry));
    return false;
  }
}

/** Switches between .env's connection, saved ones, and config/database.php's, or opens Data Sources. */
export async function chooseConnection() {
  const root = host.root();
  if (!root) return;
  const current = selectedName();
  const choose = (name: string) => () => (select(name), loadTables());
  const mark = (name: string) => (name === current ? "codicon-check" : "codicon-database");
  const items: Item[] = (await sources()).map((s) => ({ label: s.name || ".env", detail: `${s.origin === "config" ? "config/database.php · " : s.origin === "redis" ? ".env · " : ""}${describe(s.connection, root)}`, icon: mark(s.name), run: choose(s.name) }));
  items.push({ label: "Data Sources…", detail: "Add, edit, test, or remove connections", icon: "codicon-settings-gear", run: () => dataSources() });
  if (savedConnections().length) items.push(shareItem(SHARED_KEYS, "saved connections, without passwords,"));
  pick("Switch the database connection", (q) => rank(q, items), 0, { value: "", anchor: $("db-connection") });
}

/** The keys that share saved connections in tusk.json, with their tunnels and read-only choices. */
const SHARED_KEYS = ["databaseConnections", "databaseSsh", "databaseReadOnly"];

/** Every connection the project has, for the switcher and Data Sources: .env's, saved ones, and the app's config's. */
async function sources(): Promise<Source[]> {
  const root = host.root();
  const saved = savedConnections();
  const readOnly = readOnlyNames();
  const entry = (name: string, origin: Source["origin"], connection: Connection): Source => ({ name, origin, connection, ssh: sshOf(name), readOnly: readOnly.includes(name) });
  const list: Source[] = [{ ...entry("", "env", await envConnection()), original: await envConnection(true), overridden: !!projectValue("databaseEnvOverride") }];
  for (const s of saved) {
    const c = connectionFromUrl(s.url, root);
    // Passwords stay in the Keychain until a connection needs one, so listing asks the Keychain nothing.
    if (c) list.push(entry(s.name, "saved", c));
  }
  for (const [n, c] of await configConnections()) if (!saved.some((s) => s.name === n)) list.push(entry(n, "config", c));
  for (const [n, c] of Object.entries(await envRedis())) if (!saved.some((s) => s.name === n)) list.push(entry(n, "redis", c));
  return list;
}

/** Opens Data Sources, on a connection's form: the selected one by default. */
export async function dataSources(focus = selectedName(), section?: "ssh") {
  const root = host.root();
  if (!root) return;
  const list = await sources();
  const result = await openDataSources({
    root,
    sources: list,
    selected: focus,
    section,
    test: async (c, ssh) => {
      const reached = await reach(c, ssh);
      const r = await invoke<Result>("db_query", { connection: limited(reached, 1), sql: versionQuery(c.driver), offset: 0 });
      return versionText(c.driver, r.rows[0]?.[0] ?? null);
    },
    friendlyError,
    password,
    shared: projectScope("databaseConnections") === "shared",
  });
  if (!result) return;
  try {
    await applySources(result.edits, result.removed);
    if (result.select !== undefined) await select(result.select);
    for (const key of SHARED_KEYS) if (projectValue(key) !== undefined) await setProjectScope(key, result.shared ? "shared" : "local");
  } catch (e) {
    return showError("Can't save the data sources", e);
  }
  loadTables();
}

async function applySources(edits: SourceEdit[], removed: string[]) {
  let saved = savedConnections();
  for (const name of removed) {
    await invoke("db_set_password", { account: account(name), password: "" }).catch(() => {});
    await setSsh(name, { destination: "", identityFile: "" });
    await setReadOnly(name, false);
    saved = saved.filter((s) => s.name !== name);
  }
  for (const e of edits) {
    if (e.origin === "env") {
      // An override keeps .env's values on this Mac; its password goes to the Keychain like a saved one's.
      await setProjectValue("databaseEnvOverride", e.connection ? connectionUrl(e.connection, host.root()) : undefined, "local");
      if (e.connection && e.password !== undefined) await invoke("db_set_password", { account: account(""), password: e.password });
    } else if (e.origin === "saved" && e.connection) {
      // A new password, or the Keychain's under the old name, for a renamed or copied connection.
      const secret = e.password ?? (e.keychain !== undefined && e.keychain !== e.name ? await password(e.keychain) : undefined);
      if (secret !== undefined) await invoke("db_set_password", { account: account(e.name), password: secret });
      if (e.previous !== undefined && e.previous !== e.name) {
        await invoke("db_set_password", { account: account(e.previous), password: "" });
        await setSsh(e.previous, { destination: "", identityFile: "" });
        await setReadOnly(e.previous, false);
      }
      // connectionUrl leaves the password out, so nothing secret reaches tusk.json when the connections are shared.
      const url = connectionUrl(e.connection, host.root());
      const at = saved.findIndex((s) => s.name === (e.previous ?? e.name));
      if (at >= 0) saved[at] = { name: e.name, url };
      else saved.push({ name: e.name, url });
    }
    await setSsh(e.name, e.ssh);
    await setReadOnly(e.name, e.readOnly);
  }
  await save("databaseConnections", saved);
  // The selection follows a rename, and goes back to .env's when its connection is removed.
  const renamed = edits.find((e) => e.previous !== undefined && e.previous === selectedName());
  if (renamed) await select(renamed.name);
  else if (removed.includes(selectedName())) await select("");
}

/** Sets the SSH tunnel for the selected connection, in Data Sources. */
export const connectOverSsh = () => dataSources(selectedName(), "ssh");

// ---- Tables ----

/** Hints for errors that mean the connection, rather than the statement, failed. */
const CONNECTION_ERROR = /connect|refused|timed out|authentication|password|access denied|unknown host|resolve|no route|unable to open|ssh|tls|certificate|keychain/i;

/** An error with Retry, and Edit Connection when it's the connection's. */
function errorBlock(message: string, retry: (() => unknown) | null) {
  const block = h("div", { class: "db-error-block" }, h("span", { class: "db-error" }, message));
  const actions = h("div", { class: "db-error-actions" }, retry && h("button", { class: "db-action", onclick: () => retry() }, icon("refresh"), "Retry"));
  if (CONNECTION_ERROR.test(message) || connectionError || /read-only/.test(message)) actions.append(h("button", { class: "db-action", onclick: () => dataSources() }, icon("edit"), "Edit Connection…"));
  block.append(actions);
  return block;
}

export async function loadTables() {
  if (!host.root()) return;
  const list = $("db-tables");
  // Switching back to the view keeps the last tables while they refresh; a new project or connection starts over.
  configConnections(); // In the background, so the switcher opens at once.
  const key = `${host.root()}#${selectedName()}`;
  if (list.dataset.root !== key) (list.dataset.root = key), list.replaceChildren(loadingRow("Connecting…"));
  try {
    await loadConnection();
    // Each kind of connection has its own filter: Redis's scans the server, the tables' filters the list.
    document.getElementById("redis-toolbar")?.toggleAttribute("hidden", !isRedis());
    $("db-filter-bar").hidden = isRedis();
    list.setAttribute("aria-label", isRedis() ? "Redis keys" : "Tables");
    if (isRedis()) return await loadKeys();
    const result = await query(tablesQuery(connection!.driver));
    const tables = result.rows.map((r) => r[0] ?? "");
    list.replaceChildren(...(tables.length ? tables.map(tableRow) : [h("li", { class: "muted db-note" }, "No tables. Run the migrations with php artisan migrate.")]));
    filterTables();
    if (result.truncated) list.append(h("li", { class: "muted db-note" }, `The first ${result.rows.length.toLocaleString()} of ${result.total.toLocaleString()} tables.`));
  } catch (e) {
    delete list.dataset.root;
    list.replaceChildren(h("li", { class: "db-note" }, errorBlock(`Can't connect: ${friendlyError(errorText(e))}`, loadTables)));
  }
}

const loadingRow = (text: string) => h("li", { class: "muted db-note" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), ` ${text}`);

/** Shows the tables whose names, or whose columns' names, contain the search's text. */
function filterTables() {
  const q = ($("db-filter") as HTMLInputElement).value.trim().toLowerCase();
  const columns = q && schemaLoaded;
  for (const li of $("db-tables").querySelectorAll<HTMLElement>(":scope > li[data-table]")) {
    const table = li.dataset.table!;
    const matches = columns ? (columns.get(table) ?? []).filter((c) => c.name.toLowerCase().includes(q)).map((c) => c.name) : [];
    li.hidden = !!q && !table.toLowerCase().includes(q) && !matches.length;
    li.querySelector(".match")!.textContent = q && matches.length && !table.toLowerCase().includes(q) ? matches.slice(0, 3).join(", ") : "";
  }
  if (q && !schemaLoaded && connection && !isRedis()) loadSchema().then((s) => ((schemaLoaded = s), filterTables()));
}
let schemaLoaded: Map<string, { name: string; type: string }[]> | null = null;

/** A tree row: a treeitem at `level`, with `data-key` for listNav. */
function treeRow(key: string, level: number, children: Node[], expandable: boolean) {
  const row = h("div", { class: "row", role: "treeitem", data: { key } }, ...children);
  row.setAttribute("aria-level", String(level));
  if (expandable) row.setAttribute("aria-expanded", "false");
  row.style.paddingLeft = `${4 + (level - 1) * 14}px`;
  return row;
}

function tableRow(table: string) {
  const li = h("li", { data: { table }, role: "none" });
  const chevron = h("span", { class: "chevron codicon codicon-chevron-right" });
  const row = treeRow(`t:${table}`, 1, [chevron, icon("table"), h("span", { class: "name" }, table), h("span", { class: "match" })], true);
  row.dataset.table = table;
  row.title = "Double-click or press Enter to open the table's data";
  const children = h("ul", { role: "group", hidden: true });
  let loaded = false;
  const expand = async (open = children.hidden) => {
    children.hidden = !open;
    row.setAttribute("aria-expanded", String(open));
    chevron.className = `chevron codicon codicon-chevron-${open ? "down" : "right"}`;
    if (!open || loaded) return;
    loaded = true;
    children.replaceChildren(loadingRow("Loading columns…"));
    const d = connection!.driver;
    try {
      const [columns, indexes, keys] = await Promise.all([query(columnsQuery(d, table)), query(indexesQuery(d, table)).catch(() => null), query(foreignKeysQuery(d, table)).catch(() => null)]);
      const items: HTMLElement[] = columns.rows.map(([name, type, nullable]) =>
        h("li", { role: "none" }, treeRow(`c:${table}.${name}`, 2, [h("span", { class: "chevron" }), icon("symbol-field"), h("span", { class: "name" }, name ?? ""), h("span", { class: "type" }, `${(type ?? "").toLowerCase()}${nullable === "YES" ? "?" : ""}`)], false)),
      );
      const folder = (id: string, label: string, name: string, rows: HTMLElement[]) => {
        const fchevron = h("span", { class: "chevron codicon codicon-chevron-right" });
        const frow = treeRow(`${id}:${table}`, 2, [fchevron, icon(name), h("span", { class: "name" }, label), h("span", { class: "type" }, String(rows.length))], true);
        const group = h("ul", { role: "group", hidden: true }, ...rows);
        frow.onclick = () => {
          group.hidden = !group.hidden;
          frow.setAttribute("aria-expanded", String(!group.hidden));
          fchevron.className = `chevron codicon codicon-chevron-${group.hidden ? "right" : "down"}`;
        };
        return h("li", { role: "none" }, frow, group);
      };
      if (indexes?.rows.length)
        items.push(
          folder(
            "i",
            "Indexes",
            "list-tree",
            indexes.rows.map(([name, unique, cols]) => h("li", { role: "none" }, treeRow(`i:${table}.${name}`, 3, [h("span", { class: "chevron" }), icon(unique === "1" ? "key" : "list-ordered"), h("span", { class: "name" }, name ?? ""), h("span", { class: "type" }, `${cols ?? ""}${unique === "1" ? " · unique" : ""}`)], false))),
          ),
        );
      if (keys?.rows.length)
        items.push(
          folder(
            "f",
            "Foreign keys",
            "references",
            keys.rows.map(([column, target, targetColumn]) => {
              const r = treeRow(`f:${table}.${column}>${target}`, 3, [h("span", { class: "chevron" }), icon("arrow-right"), h("span", { class: "name" }, column ?? ""), h("span", { class: "type" }, `${target}.${targetColumn}`)], false);
              r.dataset.table = target ?? "";
              r.title = `Double-click or press Enter to open ${target}`;
              r.ondblclick = () => target && openTable(target);
              return h("li", { role: "none" }, r);
            }),
          ),
        );
      children.replaceChildren(...(items.length ? items : [h("li", { class: "muted db-note" }, "No columns.")]));
    } catch (e) {
      loaded = false;
      children.replaceChildren(h("li", { class: "db-note" }, errorBlock(friendlyError(errorText(e)), () => expand(true))));
    }
  };
  row.onclick = () => expand();
  row.ondblclick = () => openTable(table);
  (row as RowWithToggle).toggleTo = (open) => expand(open);
  li.append(row, children);
  return li;
}
type RowWithToggle = HTMLElement & { toggleTo?: (open: boolean) => void };

/** The table of the selected tree row, for the table actions. */
export function selectedTable(): string | null {
  if (isRedis()) return null;
  return nav?.selectedRow()?.closest<HTMLElement>("li[data-table]")?.dataset.table ?? null;
}

function tableMenu(e: MouseEvent, table: string) {
  showMenu(e.clientX, e.clientY, [
    { label: "Open Table", keys: "⏎", run: () => openTable(table) },
    { label: "Copy Name", run: () => copyName(table) },
    "-",
    { label: "Generate SELECT", run: () => generate("select", table) },
    { label: "Generate INSERT", run: () => generate("insert", table) },
    "-",
    { label: "Refresh", run: () => loadTables() },
  ]);
}

export const copyName = (name: string) => navigator.clipboard.writeText(name).then(() => status(`Copied ${name}`, "app", "info"), (e) => showError("Can't copy", e));

/** Writes a SELECT or INSERT for a table, with its columns, at the end of the query console. */
export async function generate(kind: "select" | "insert", table = selectedTable()) {
  if (!table) return status("Select a table in the Database tool first.", "app", "info");
  try {
    const d = connection!.driver;
    const columns = (await query(columnsQuery(d, table))).rows.map((r) => r[0] ?? "");
    await appendToConsole(`${(kind === "select" ? selectTemplate : insertTemplate)(d, table, columns)};`);
  } catch (e) {
    showError(`Can't read ${table}'s columns`, e);
  }
}

// ---- Console ----

async function consolePath() {
  const dir = `${await appDataDir()}/consoles/${host.root().replace(/[^A-Za-z0-9]+/g, "_")}`;
  return { dir, path: `${dir}/console.${isRedis() ? "redis" : "sql"}` };
}

/**
 * Opens the project's query console, a .sql file kept in the app's data folder rather than in the project, or for a
 * Redis connection, a .redis file of commands.
 */
export async function openConsole() {
  if (!host.root()) return;
  if (!connection) await loadConnection().catch(() => {});
  const { dir, path } = await consolePath();
  if (!(await invoke<boolean>("path_exists", { path }))) {
    await invoke("create_dir", { path: dir });
    const hint = isRedis()
      ? keyText("# ⌘⏎ runs the command on the caret's line, or each line of the selection. Completion suggests commands and keys.")
      : keyText("-- ⌘⏎ runs the statement under the caret, or each statement in the selection. Execute All Statements runs the file.");
    await invoke("write_file", { path, contents: `${hint}\n\n` });
  }
  await host.openFile(path);
  return path;
}

/** Adds text at the end of the console, opens it, and selects the text. */
async function appendToConsole(text: string) {
  const path = await openConsole();
  const model = monaco.editor.getModels().find((m) => m.uri.path === path);
  const editor = monaco.editor.getEditors().find((e) => e.getModel() === model);
  if (!model || !editor) return;
  const end = model.getFullModelRange().getEndPosition();
  const lead = model.getValueInRange(new monaco.Range(end.lineNumber, 1, end.lineNumber, end.column)).trim() ? "\n\n" : end.lineNumber > 1 && !model.getLineContent(end.lineNumber - 1).trim() ? "" : "\n";
  editor.executeEdits("database", [{ range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text: `${lead}${text}\n` }]);
  const last = model.getFullModelRange().getEndPosition();
  const start = model.getPositionAt(model.getOffsetAt(last) - text.length - 1);
  editor.setSelection(new monaco.Selection(start.lineNumber, start.column, last.lineNumber - 1, model.getLineMaxColumn(last.lineNumber - 1)));
  editor.revealLineInCenter(start.lineNumber);
  editor.focus();
}

/**
 * Runs from a .sql editor: the selection, each of its statements in a tab of its own, or the statement under the
 * caret, or with `all`, every statement in the file. From a .redis one, the caret's line or the selection's lines.
 */
export function runFromEditor(editor: monaco.editor.ICodeEditor, all = false) {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) return;
  if (model.getLanguageId() === "redis") return runRedis(all ? model.getValue() : selection.isEmpty() ? model.getLineContent(selection.positionLineNumber) : model.getValueInRange(selection));
  const driver = connection?.driver ?? "";
  const statements = all
    ? splitStatements(model.getValue(), driver).map((s) => s.text)
    : selection.isEmpty()
      ? [statementAt(model.getValue(), model.getOffsetAt(selection.getPosition()), driver)]
      : splitStatements(model.getValueInRange(selection), driver).map((s) => s.text);
  const runnable = statements.filter(hasCode);
  if (runnable.length) execute(runnable);
  else status(all ? "The console has no statements to run." : "No statement at the caret.", "app", "info");
}

/**
 * Runs Redis console lines: one command shows its reply in the grid, and several run in one round trip with a row
 * each. Lines starting with # are the console's comments; Redis itself has none.
 */
async function runRedis(text: string) {
  if (!(await confirmDiscard())) return;
  if (!(await ensureConnection(resultsFor("Redis"), () => runRedis(text)))) return;
  if (!isRedis()) return status("Select a Redis connection in the Database tool to run Redis commands.", "app", "info");
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length > 1) return runLines(lines);
  if (!lines.length) return;
  const args = splitCommand(lines[0]);
  if (args && !(await confirmCommands([args]))) return;
  execute([lines[0]], { label: lines[0], confirmed: true });
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

// ---- Query history ----

/** Statements you ran, newest first, per project on this Mac (`databaseHistory`). */
type Past = { sql: string; at: string; connection: string; ms?: number; rows?: number; error?: string };
const HISTORY = 100;
const history = () => projectValue<Past[]>("databaseHistory") ?? [];
function remember(entry: Past) {
  const list = [entry, ...history().filter((p) => p.sql !== entry.sql)].slice(0, HISTORY);
  setProjectValue("databaseHistory", list, "local").catch(() => {});
}

/** Lists the statements you ran; choosing one adds it to the console. */
export function showHistory() {
  if (!host.root()) return;
  const list = history();
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  const items: Item[] = list.map((p) => ({
    label: p.sql.replace(/\s+/g, " ").slice(0, 200),
    detail: `${when(p.at)} · ${p.connection || ".env"} · ${p.error ? `failed: ${p.error.slice(0, 80)}` : p.rows !== undefined ? `${p.rows.toLocaleString()} ${p.rows === 1 ? "row" : "rows"} in ${p.ms} ms` : `${p.ms} ms`}`,
    icon: p.error ? "codicon-error" : "codicon-history",
    run: () => appendToConsole(p.sql.trim().endsWith(";") || isRedis() ? p.sql : `${p.sql};`),
  }));
  if (!items.length) items.push({ label: "No queries yet", detail: "Statements you run in the console show here", run: () => {} });
  else items.push({ label: "Clear Query History", icon: "codicon-clear-all", run: () => setProjectValue("databaseHistory", undefined).catch((e) => showError("Can't clear the history", e)) });
  pick("Query history: choose a statement to add it to the console", (q) => rank(q, items), 0, { value: "" });
}

// ---- Results ----

export const results = el("div", "db-results");
/** Cancels for the queries that are running, for Cancel Query. */
const running = new Set<() => void>();

/** Stops every running query. */
export function cancelQueries() {
  if (!running.size) return status("No query is running.", "app", "info");
  for (const cancel of running) cancel();
}

/** Clears the results and shows them in the panel, returning the area to fill. */
function resultsFor(title: string) {
  results.replaceChildren();
  showPanelView("Database", results);
  results.dataset.title = title;
  return results;
}

/** A table view's page: its filter, sort, and page, to run again with another. */
type TableView = { table: string; where: string; orderBy: string; page: number };

/**
 * Runs statements, each in a tab of its own when there are several, one after another until one fails or you
 * cancel. `label` names a single result, such as a Redis command.
 */
export async function execute(statements: string[], o: { label?: string; confirmed?: boolean } = {}) {
  if (!o.confirmed && !(await confirmDiscard())) return;
  const area = resultsFor("Query");
  if (!(await ensureConnection(area, () => execute(statements, { ...o, confirmed: true })))) return;
  if (connection!.read_only && !isRedis()) {
    const writes = statements.filter((s) => !readsOnly(s));
    if (writes.length) return area.replaceChildren(errorBlock(`The connection is read-only, so this doesn't run: ${writes[0].slice(0, 200)}. Turn off read-only in Data Sources to change data.`, null));
  }
  const tabs = h("div", { class: "db-result-tabs", role: "tablist", ariaLabel: "Statements", hidden: statements.length < 2 });
  const panes = statements.map(() => h("div", { class: "db-result-pane", role: "tabpanel", hidden: true }));
  const tabButtons = statements.map((sql, i) => {
    const b = h("button", { class: "db-result-tab", role: "tab", title: sql, onclick: () => show(i) }, h("span", { class: "db-tab-state codicon" }), `${i + 1}. ${sql.replace(/\s+/g, " ").slice(0, 40)}`);
    b.ariaSelected = "false";
    return b;
  });
  tabs.append(...tabButtons);
  const show = (i: number) => panes.forEach((p, j) => ((p.hidden = i !== j), (tabButtons[j].ariaSelected = String(i === j)), tabButtons[j].classList.toggle("active", i === j)));
  tabs.onkeydown = (e) => {
    const i = tabButtons.findIndex((b) => b.ariaSelected === "true");
    const to = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : -1;
    if (to >= 0 && to < tabButtons.length) e.preventDefault(), show(to), tabButtons[to].focus();
  };
  area.append(tabs, ...panes);
  show(0);
  for (const [i, sql] of statements.entries()) {
    show(i);
    const state = tabButtons[i].querySelector(".db-tab-state")!;
    state.className = "db-tab-state codicon codicon-loading codicon-modifier-spin";
    const outcome = await runQuery(panes[i], { sql, label: o.label ?? (statements.length > 1 ? `Statement ${i + 1}` : "Query"), page: 0 });
    state.className = `db-tab-state codicon codicon-${outcome === "ok" ? "check" : outcome === "canceled" ? "circle-slash" : "error"}`;
    if (outcome !== "ok") {
      for (const j of statements.keys()) if (j > i) (tabButtons[j].querySelector(".db-tab-state")!.className = "db-tab-state codicon codicon-circle-outline"), panes[j].replaceChildren(h("div", { class: "db-summary muted" }, `Not run: statement ${i + 1} ${outcome === "canceled" ? "was canceled" : "failed"}.`));
      break;
    }
  }
}

/** Shows a table's rows: a page at a time, with the filter and sort as SQL, and editable when it has a primary key. */
export async function openTable(table: string, view: Partial<TableView> = {}) {
  if (!(await confirmDiscard())) return;
  const area = resultsFor(table);
  if (!(await ensureConnection(area, () => openTable(table, view)))) return;
  const pane = h("div", { class: "db-result-pane" });
  area.append(pane);
  await runQuery(pane, { table: { table, where: "", orderBy: "", page: 0, ...view }, label: table, page: view.page ?? 0 });
}

type Spec = { sql?: string; table?: TableView; label: string; page: number };

/** Runs one query into `pane`: a spinner with the time so far and Cancel, then its rows, or its error. */
async function runQuery(pane: HTMLElement, spec: Spec): Promise<"ok" | "failed" | "canceled"> {
  const d = connection!.driver;
  const size = pageSize();
  const t = spec.table;
  const id = (n: string) => quoteIdentifier(d, n);
  const base = t ? `SELECT * FROM ${id(t.table)}${t.where.trim() ? ` WHERE ${t.where.trim()}` : ""}${t.orderBy.trim() ? ` ORDER BY ${t.orderBy.trim()}` : ""}` : spec.sql!;
  // A table's page is a LIMIT, so the database reads only that page; the extra row tells whether there's another.
  const sql = t ? `${base} LIMIT ${size + 1} OFFSET ${t.page * size}` : base;
  const summary = h("div", { class: "db-summary muted" });
  const filter = t ? filterBar(t) : null;
  pane.replaceChildren(...(filter ? [filter] : []), summary);

  const queryId = crypto.randomUUID();
  let canceled = "";
  const cancel = (why = "Canceled") => {
    if (canceled) return;
    canceled = why;
    invoke("db_cancel", { id: queryId }).catch((e) => showError("Can't cancel the query", e));
  };
  const started = performance.now();
  const elapsed = h("span");
  const tick = () => (elapsed.textContent = ` ${((performance.now() - started) / 1000).toFixed(1)} s`);
  tick();
  const stop = h("button", { class: "db-action", title: "Cancel the query", onclick: () => cancel() }, icon("debug-stop"), "Cancel");
  summary.replaceChildren(h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), " Running…", elapsed, stop);
  const ticker = setInterval(tick, 100);
  const limit = settings.databaseQueryTimeout;
  const timer = limit > 0 ? setTimeout(() => cancel(`Canceled after ${limit} s, the query timeout in Settings`), limit * 1000) : undefined;
  const cancelThis = () => cancel();
  running.add(cancelThis);
  let result: Result;
  try {
    result = await invoke<Result>("db_query", { connection: limited(connection, t ? size + 1 : size), sql, offset: t ? 0 : spec.page * size, id: queryId });
  } catch (e) {
    const ms = Math.round(performance.now() - started);
    const message = errorText(e);
    if (!t) remember({ sql: base, at: new Date().toISOString(), connection: selectedName(), ms, error: canceled ? "canceled" : message });
    if (canceled) {
      summary.replaceChildren(h("span", {}, `${canceled === "Canceled" ? `Canceled after ${(ms / 1000).toFixed(1)} s` : canceled}.`), h("button", { class: "db-action", onclick: () => runQuery(pane, spec) }, icon("refresh"), "Run Again"));
      return "canceled";
    }
    summary.replaceChildren(errorBlock(friendlyError(message), () => runQuery(pane, spec)));
    summary.classList.remove("muted");
    return "failed";
  } finally {
    clearInterval(ticker);
    clearTimeout(timer);
    running.delete(cancelThis);
  }
  const ms = Math.round(performance.now() - started);
  if (!t) remember({ sql: base, at: new Date().toISOString(), connection: selectedName(), ms, rows: result.columns.length ? result.total : result.affected });
  if (!result.columns.length) {
    summary.textContent = `${result.affected.toLocaleString()} ${result.affected === 1 ? "row" : "rows"} affected in ${ms} ms`;
    schema = schemaLoaded = null; // The statement may have changed the schema.
    return "ok";
  }
  const truncated = t ? result.rows.length > size : result.truncated;
  const rows = t ? result.rows.slice(0, size) : result.rows;
  const offset = spec.page * size;
  const n = rows.length;
  const paged = spec.page > 0 || truncated;
  const count = h("span", {}, paged ? `rows ${(offset + 1).toLocaleString()}–${(offset + n).toLocaleString()}` : `${n.toLocaleString()} ${n === 1 ? "row" : "rows"}`);
  summary.replaceChildren(h("span", { class: "db-label", title: base }, spec.label), " · ", count, ` in ${ms} ms`);
  const total = (all: number) => (count.textContent += ` of ${all.toLocaleString()}`);
  if (paged && !t) total(result.total);
  if (paged && t) query(`SELECT COUNT(*) FROM ${id(t.table)}${t.where.trim() ? ` WHERE ${t.where.trim()}` : ""}`).then((r) => count.isConnected && total(Number(r.rows[0][0])), () => {});
  const page = (to: number) => async () => {
    if (!(await confirmDiscard())) return;
    runQuery(pane, { ...spec, page: to, table: t && { ...t, page: to } });
  };
  // The grid disables these while it has pending changes.
  if (spec.page > 0) button(summary, "Previous", "chevron-left", page(spec.page - 1)).classList.add("db-page");
  if (truncated) button(summary, "Next", "chevron-right", page(spec.page + 1)).classList.add("db-page");

  const sort = t ? sortOf(t.orderBy, result.columns) : null;
  const edit = t && !connection!.read_only ? await tableEditing(t.table, result, rows, () => runQuery(pane, spec)) : null;
  if (t && connection!.read_only) summary.append(" · read-only connection");
  else if (t && !edit) summary.append(" · read-only, because the table has no primary key");
  const grid = dataGrid({
    columns: result.columns,
    rows,
    first: offset + 1,
    binary: result.binary,
    toolbar: summary,
    sort,
    onSort: t ? (s) => sortTable(pane, spec, s, result.columns) : undefined,
    edit: edit ?? undefined,
    table: t?.table ?? "results",
    driver: d,
    all: async () => {
      const r = await invoke<Result>("db_query", { connection: limited(connection, 0), sql: base, offset: 0 });
      return { columns: r.columns, rows: r.rows };
    },
  });
  pane.append(grid.element);
  return "ok";
}

/** The header sort a table's ORDER BY is, when it's one column. */
function sortOf(orderBy: string, columns: string[]): Sort | null {
  const m = orderBy.trim().match(/^["`]?([^"`\s]+)["`]?(?:\s+(asc|desc))?$/i);
  const column = m ? columns.indexOf(m[1]) : -1;
  return column >= 0 ? { column, desc: m![2]?.toLowerCase() === "desc" } : null;
}

async function sortTable(pane: HTMLElement, spec: Spec, s: Sort | null, columns: string[]) {
  if (!(await confirmDiscard())) return;
  const orderBy = s ? `${quoteIdentifier(connection!.driver, columns[s.column])}${s.desc ? " DESC" : ""}` : "";
  runQuery(pane, { ...spec, page: 0, table: { ...spec.table!, orderBy, page: 0 } });
}

/** The WHERE and ORDER BY fields above a table's rows; Enter runs the table again with them. */
function filterBar(t: TableView) {
  const where = h("input", { value: t.where, placeholder: "WHERE, such as id > 10 AND name LIKE 'a%'", spellcheck: false, ariaLabel: "WHERE" });
  const orderBy = h("input", { value: t.orderBy, placeholder: "ORDER BY, such as created_at DESC", spellcheck: false, ariaLabel: "ORDER BY" });
  const apply = () => openTable(t.table, { where: where.value, orderBy: orderBy.value, page: 0 });
  for (const input of [where, orderBy])
    input.onkeydown = (e) => {
      if (e.key === "Enter") e.preventDefault(), apply();
      if (e.key === "Escape" && input.value) e.preventDefault(), (input.value = ""), apply();
      e.stopPropagation();
    };
  return h("div", { class: "db-filter" }, h("label", {}, "WHERE", where), h("label", {}, "ORDER BY", orderBy));
}

/** Editing for a table's rows when they include its primary key, which finds each row again. */
async function tableEditing(table: string, result: Result, rows: Cell[][], again: () => unknown) {
  const driver = connection!.driver;
  const keys = (await query(primaryKeyQuery(driver, table)).catch(() => ({ rows: [] as Cell[][] }))).rows.map((r) => r[0]!);
  const keyIndexes = keys.map((k) => result.columns.indexOf(k));
  if (!keys.length || keyIndexes.includes(-1)) return null;
  // SQLite's UPDATE has no DEFAULT, so Set Default writes the column's default expression.
  const defaults = driver === "sqlite" ? new Map((await query(defaultsQuery(table)).catch(() => ({ rows: [] as Cell[][] }))).rows.map(([n, v]) => [n!, v ?? "NULL"])) : null;
  const value = (column: string, v: Value): SqlValue => (defaults && v && typeof v === "object" ? { sql: defaults.get(column) ?? "NULL" } : v);
  const keyOf = (cells: Cell[]) => Object.fromEntries(keys.map((k, i) => [k, cells[keyIndexes[i]]]));
  // Deletes first, so a row edited to take a deleted row's key doesn't collide with it. Updates are keyed on
  // each row's values before the change, so editing a key column still finds its row.
  const statements = ({ edits, deletes, inserts }: Changes) => [
    ...[...deletes].map((r) => deleteStatement(driver, table, keyOf(rows[r]))),
    ...[...edits].filter(([r]) => !deletes.has(r)).map(([r, cells]) => updateStatement(driver, table, Object.fromEntries([...cells].map(([c, v]) => [result.columns[c], value(result.columns[c], v)])), keyOf(rows[r]))),
    ...inserts.map((values) => insertStatement(driver, table, Object.fromEntries(Object.entries(values).map(([c, v]) => [c, value(c, v)])))),
  ];
  return {
    nulls: true,
    empty: "default" as const,
    defaults: true,
    describe: statements,
    submit: (changes: Changes) => invoke("db_batch", { connection: limited(connection), statements: statements(changes), oneRowEach: true }),
    target: table,
    again,
  };
}

/** An error with a hint for the common ones, such as a server that isn't running. */
export function friendlyError(message: string): string {
  if (/NOAUTH/.test(message)) return `${message} Redis needs a password: add it in Data Sources, or set REDIS_PASSWORD in .env.`;
  if (/WRONGPASS/.test(message)) return `${message} Check the password in Data Sources, or REDIS_PASSWORD and REDIS_USERNAME in .env.`;
  if (/^MOVED \d+ /.test(message)) return `${message}. The server is a Redis Cluster node, and the key is on another node. The editor talks to one node: connect to the node the error names (${message.split(" ")[2]}).`;
  if (/Connection refused/i.test(message)) return `${message}. Is the server running? For Sail, run sail up.`;
  if (/read-?only/i.test(message) && connection?.read_only) return `${message} The connection is read-only; turn that off in Data Sources to change data.`;
  return message;
}

export function initDatabase(h_: Host) {
  host = h_;
  const tree = $("db-tables");
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-label", "Tables");
  nav = listNav(tree, {
    rows: ".row[data-key]",
    // Enter opens a table's data, or a foreign key's table; other rows act as a click would.
    open: (row) => (row.dataset.table ? openTable(row.dataset.table) : row.click()),
    toggle: (row, expand) => ((row as RowWithToggle).toggleTo ? (row as RowWithToggle).toggleTo!(expand) : row.click()),
    label: (row) => row.querySelector(".name")?.textContent ?? "",
  });
  tree.addEventListener("contextmenu", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".row[data-key]");
    if (!row || isRedis()) return;
    e.preventDefault();
    nav.select(row.dataset.key!, { scroll: false });
    const key = row.dataset.key!;
    if (key.startsWith("t:")) tableMenu(e, row.dataset.table!);
    else showMenu(e.clientX, e.clientY, [{ label: "Copy Name", run: () => copyName(row.querySelector(".name")?.textContent ?? "") }]);
  });
  tree.addEventListener("keydown", (e) => {
    // ⌘C copies the selected table's or column's name.
    if (mod(e) && e.key.toLowerCase() === "c" && !isRedis() && nav.selectedRow()) e.preventDefault(), copyName(nav.selectedRow()!.querySelector(".name")?.textContent ?? "");
  });
  initRedis({ connection: () => limited(connection), results, status: (text) => host.status(text), friendlyError, nav, confirmDiscard });
  $("db-refresh").onclick = () => ((config = undefined), loadTables());
  $("db-connection").onclick = chooseConnection;
  monaco.languages.registerCompletionItemProvider("sql", { triggerCharacters: ["."], provideCompletionItems });
  $("db-console").onclick = openConsole;
  $("db-data-sources").onclick = () => dataSources();
  $("db-filter").oninput = filterTables;
  $("db-filter").onkeydown = (e) => {
    if (e.key === "Escape") ((e.target as HTMLInputElement).value = ""), filterTables();
    if (e.key === "ArrowDown") e.preventDefault(), tree.focus();
  };
  monaco.editor.addEditorAction({
    id: "phpEditor.runSql",
    label: "Execute Query",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
    precondition: "editorLangId == sql || editorLangId == redis",
    contextMenuGroupId: "navigation",
    run: (editor) => runFromEditor(editor),
  });
  monaco.editor.addEditorAction({
    id: "phpEditor.runAllSql",
    label: "Execute All Statements",
    precondition: "editorLangId == sql || editorLangId == redis",
    contextMenuGroupId: "navigation",
    run: (editor) => runFromEditor(editor, true),
  });
}
