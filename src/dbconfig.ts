// Reads a Laravel project's database connection from .env, and finds the SQL statement to run.
// Free of editor imports so Node can test it.

/**
 * `ssl_mode` is libpq's sslmode, and `ssl_ca` a certificate authority file; the Rust side reads both. `read_only` makes
 * db.rs open SQLite read-only and start a read-only session on MySQL and PostgreSQL.
 */
export type Connection = { driver: string; host: string; port: number; database: string; username: string; password: string; ssl_mode: string; ssl_ca: string; read_only?: boolean };

export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    const quoted = value.match(/^(["'])(.*)\1$/);
    value = quoted ? quoted[2] : value.replace(/\s+#.*$/, "");
    env[m[1]] = value;
  }
  return env;
}

/**
 * Laravel's defaults from config/database.php fill anything .env leaves out. In a Sail project, DB_HOST
 * names the database's container, which only resolves inside Docker, so connect to the port Sail
 * forwards to this Mac instead. TLS follows the variables Laravel's config reads: DB_SSLMODE for
 * PostgreSQL (also honored for MySQL), and MYSQL_ATTR_SSL_CA or DB_SSLROOTCERT for the authority.
 */
export function connectionFromEnv(env: Record<string, string>, root: string, sail = false): Connection {
  const driver = env.DB_CONNECTION || "sqlite";
  const inProject = (file: string) => (file.startsWith("/") ? file : `${root}/${file}`);
  const tls = { ssl_mode: env.DB_SSLMODE ?? "", ssl_ca: (env.MYSQL_ATTR_SSL_CA || env.DB_SSLROOTCERT) ? inProject(env.MYSQL_ATTR_SSL_CA || env.DB_SSLROOTCERT) : "" };
  if (driver === "sqlite") return { driver, host: "", port: 0, username: "", password: "", database: inProject(env.DB_DATABASE || "database/database.sqlite"), ssl_mode: "", ssl_ca: "" };
  const port = Number(env.DB_PORT) || defaultPort(driver);
  const host = env.DB_HOST || "127.0.0.1";
  const credentials = { database: env.DB_DATABASE || "laravel", username: env.DB_USERNAME || "root", password: env.DB_PASSWORD || "", ...tls };
  if (sail && !/^(127\.0\.0\.1|localhost|::1)$/.test(host)) return { driver, host: "127.0.0.1", port: Number(env.FORWARD_DB_PORT) || port, ...credentials };
  return { driver, host, port, ...credentials };
}

const defaultPort = (driver: string) => ({ pgsql: 5432, redis: 6379 })[driver] ?? 3306;
const drivers: Record<string, string> = { mysql: "mysql", mariadb: "mariadb", pgsql: "pgsql", postgres: "pgsql", postgresql: "pgsql", sqlite: "sqlite", redis: "redis", rediss: "redis", tls: "redis" };

/**
 * Laravel's two Redis connections from .env, as config/database.php builds them: `redis` (database REDIS_DB) and
 * `redis cache` (REDIS_CACHE_DB), which the cache store uses. Laravel's env() reads `null` as no value, as in the
 * stock REDIS_PASSWORD=null. In a Sail project, connect to the port Sail forwards, as for the database.
 */
export function redisFromEnv(env: Record<string, string>, root: string, sail = false): Record<string, Connection> {
  const value = (key: string) => (env[key] === "null" ? "" : (env[key] ?? ""));
  const url = value("REDIS_URL") ? connectionFromUrl(value("REDIS_URL"), root) : null;
  let host = url?.host || value("REDIS_HOST") || "127.0.0.1";
  let port = url?.port || Number(value("REDIS_PORT")) || 6379;
  if (sail && !/^(127\.0\.0\.1|localhost|::1)$/.test(host)) (port = Number(value("FORWARD_REDIS_PORT")) || port), (host = "127.0.0.1");
  const base = { driver: "redis", host, port, username: url?.username || value("REDIS_USERNAME"), password: url?.password || value("REDIS_PASSWORD"), ssl_mode: url?.ssl_mode ?? "", ssl_ca: url?.ssl_ca ?? "" };
  const database = (key: string, fallback: string) => (url && new URL(value("REDIS_URL")).pathname.length > 1 ? url.database : value(key) || fallback);
  return { redis: { ...base, database: database("REDIS_DB", "0") }, "redis cache": { ...base, database: database("REDIS_CACHE_DB", "1") } };
}

/**
 * A connection from a URL, as Laravel's DB_URL takes one: `mysql://user:password@host:3306/database?sslmode=require`,
 * `pgsql://…` (or `postgres://…`), or `sqlite:database/other.sqlite` (relative to the project) and `sqlite:///absolute/path`.
 * Or a Redis one, as REDIS_URL takes: `redis://:password@host:6379/0`, or `rediss://…` for TLS, which checks the
 * certificate unless `sslmode` says otherwise. Null if it isn't one.
 */
export function connectionFromUrl(text: string, root: string): Connection | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const driver = drivers[url.protocol.slice(0, -1)];
  const d = decodeURIComponent;
  if (!driver) return null;
  const inProject = (file: string) => (file && !file.startsWith("/") ? `${root}/${file}` : file);
  if (driver === "sqlite") return url.pathname ? { driver, host: "", port: 0, username: "", password: "", database: inProject(d(url.pathname)), ssl_mode: "", ssl_ca: "" } : null;
  if (!url.hostname) return null;
  const param = (name: string) => url.searchParams.get(name) ?? "";
  const scheme = url.protocol.slice(0, -1);
  if (driver === "redis") {
    const tls = scheme === "redis" ? param("sslmode") : param("sslmode") || "verify-full";
    return { driver, host: url.hostname.replace(/^\[(.*)\]$/, "$1"), port: Number(url.port) || 6379, database: d(url.pathname.slice(1)) || param("database") || "0", username: d(url.username), password: d(url.password), ssl_mode: tls, ssl_ca: inProject(param("sslrootcert") || param("sslca")) };
  }
  return {
    driver,
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: Number(url.port) || defaultPort(driver),
    database: d(url.pathname.slice(1)),
    username: d(url.username),
    password: d(url.password),
    ssl_mode: param("sslmode"),
    ssl_ca: inProject(param("sslrootcert") || param("sslca")),
  };
}

/** The URL connectionFromUrl reads, without the password, with a file in the project relative to it. */
export function connectionUrl(c: Connection, root: string): string {
  const inProject = (file: string) => (file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file);
  if (c.driver === "sqlite") return `sqlite:${c.database.startsWith(`${root}/`) ? inProject(c.database) : `//${c.database}`}`;
  const e = encodeURIComponent;
  // rediss:// means TLS that checks the certificate, so only a looser mode is spelled out.
  const tls = c.driver === "redis" && c.ssl_mode && c.ssl_mode !== "disable";
  const params = new URLSearchParams(Object.entries({ sslmode: tls && c.ssl_mode === "verify-full" ? "" : c.ssl_mode, sslrootcert: inProject(c.ssl_ca) }).filter(([, v]) => v)).toString();
  return `${tls ? "rediss" : c.driver}://${c.username ? `${e(c.username)}@` : ""}${c.host.includes(":") ? `[${c.host}]` : c.host}:${c.port}/${e(c.database)}${params ? `?${params}` : ""}`;
}

/**
 * A connection from config/database.php's `connections`, as the booted app reports it. Null for a driver the
 * editor doesn't support, such as sqlsrv.
 */
export function connectionFromConfig(config: Record<string, unknown>, root: string): Connection | null {
  const s = (key: string) => (config[key] == null ? "" : String(config[key]));
  if (s("url")) return connectionFromUrl(s("url"), root);
  const driver = s("driver");
  if (driver === "sqlite") return { driver, host: "", port: 0, username: "", password: "", database: s("database"), ssl_mode: "", ssl_ca: "" };
  if (!["mysql", "mariadb", "pgsql"].includes(driver)) return null;
  const port = Number(s("port")) || defaultPort(driver);
  return { driver, host: s("host") || "127.0.0.1", port, database: s("database"), username: s("username"), password: s("password"), ssl_mode: s("sslmode"), ssl_ca: s("sslrootcert") };
}

/**
 * Whether a config/database.php connection only repeats .env's DB_ variables under its own driver, as Laravel's
 * stock sqlite, mysql, mariadb, and pgsql entries do, so it's no database of its own.
 */
export function repeatsEnv(c: Connection, env: Record<string, string>, root: string): boolean {
  const e = connectionFromEnv({ ...env, DB_CONNECTION: c.driver }, root);
  return c.host === e.host && c.port === e.port && c.database === e.database && c.username === e.username;
}

/** The parts of an SSH destination: user@host, ssh://user@host:port, or a host alias from ~/.ssh/config. */
export function parseDestination(destination: string) {
  const m = destination.trim().match(/^(?:ssh:\/\/)?(?:([^@/]+)@)?(\[[^\]]+\]|[^:/]+)(?::(\d+))?\/?$/);
  return m ? { user: m[1] ?? "", host: m[2], port: m[3] ?? "" } : { user: "", host: destination.trim(), port: "" };
}

/** The destination for `ssh`: user@host, or ssh://user@host:port for a port other than 22. */
export function destinationOf(user: string, host: string, port: string) {
  if (!host.trim()) return "";
  const at = user.trim() ? `${user.trim()}@` : "";
  return port.trim() && port.trim() !== "22" ? `ssh://${at}${host.trim()}:${port.trim()}` : `${at}${host.trim()}`;
}

/** A connection in a line, such as `mysql · root@127.0.0.1:3306/laravel`, without the password. */
export const describe = (c: Connection, root: string) =>
  c.driver === "sqlite"
    ? `SQLite · ${c.database.replace(root + "/", "")}`
    : c.driver === "redis"
    ? `Redis · ${c.username ? `${c.username}@` : ""}${c.host}:${c.port} · db ${c.database || 0}${c.ssl_mode && c.ssl_mode !== "disable" ? " · TLS" : ""}`
    : `${c.driver} · ${c.username ? `${c.username}@` : ""}${c.host}:${c.port}/${c.database}${c.ssl_mode || c.ssl_ca ? ` · TLS ${c.ssl_mode}`.trimEnd() : ""}`;

/** A statement in a script: its text without the semicolon, and where it starts and ends. */
export type Statement = { text: string; start: number; end: number };

/**
 * Splits a script into statements at semicolons outside strings, quoted names, comments, and PostgreSQL's
 * dollar quotes ($$ … $$). MySQL takes backslash escapes in strings; the others don't. Each statement is
 * trimmed, and only whitespace and comments make none.
 */
// ponytail: a trigger's BEGIN … END body splits at its inner semicolons; select the whole trigger to run it.
export function splitStatements(text: string, driver = ""): Statement[] {
  const out: Statement[] = [];
  const backslash = driver === "mysql" || driver === "mariadb";
  let start = 0;
  let i = 0;
  const end = (at: number) => {
    const raw = text.slice(start, at);
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (hasCode(t)) out.push({ text: t, start: start + lead, end: start + lead + t.length });
    start = at + 1;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "-" && text[i + 1] === "-") i = text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i);
    else if (c === "/" && text[i + 1] === "*") i = text.indexOf("*/", i + 2) < 0 ? text.length : text.indexOf("*/", i + 2) + 2;
    else if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < text.length && text[i] !== c) i += backslash && text[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "$" && /^\$[A-Za-z_]*\$/.test(text.slice(i, i + 64)) && !/\w/.test(text[i - 1] ?? "")) {
      const tag = text.slice(i).match(/^\$[A-Za-z_]*\$/)![0];
      const close = text.indexOf(tag, i + tag.length);
      i = close < 0 ? text.length : close + tag.length;
    } else if (c === ";") end(i++);
    else i++;
  }
  end(text.length);
  return out;
}

/** The statement around an offset, as PhpStorm runs the statement under the caret. */
export function statementAt(text: string, offset: number, driver = ""): string {
  const all = splitStatements(text, driver);
  // The statement the caret is in or at the end of; between statements, the one before (on the line of its
  // semicolon, or after the last one), or else the next.
  const at = all.find((s) => offset >= s.start && offset <= s.end + 1) ?? all.filter((s) => s.end < offset).at(-1) ?? all[0];
  return at?.text ?? "";
}

/** False for text that is only whitespace and comments, which the database would reject. */
export const hasCode = (sql: string) => sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim() !== "";

export const quoteIdentifier = (driver: string, name: string) =>
  driver === "mysql" || driver === "mariadb" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Whether a statement only reads, for a read-only connection: SELECT, WITH, SHOW, EXPLAIN, DESCRIBE, VALUES, and
 * TABLE, or a PRAGMA that reads (no `=`). db.rs enforces read-only in the database too; this stops the rest first.
 */
export function readsOnly(sql: string): boolean {
  const code = sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
  const word = code.match(/^\(*\s*(\w+)/)?.[1]?.toLowerCase() ?? "";
  if (word === "pragma") return !code.includes("=");
  // A WITH can end in a change, as in WITH x AS (…) DELETE FROM …; its CTEs' own words are in parentheses.
  if (word === "with") return !/\)\s*(insert|update|delete|merge)\b/i.test(code);
  return ["select", "show", "explain", "describe", "desc", "values", "table"].includes(word);
}

/** A query whose one cell is the server's name and version, for Test Connection. */
export function versionQuery(driver: string): string {
  if (driver === "sqlite") return "SELECT 'SQLite ' || sqlite_version()";
  if (driver === "pgsql") return "SELECT 'PostgreSQL ' || current_setting('server_version')";
  if (driver === "redis") return "INFO server";
  return "SELECT CONCAT(IF(VERSION() LIKE '%MariaDB%', 'MariaDB ', 'MySQL '), VERSION())";
}

/** The version line from versionQuery's cell: Redis's INFO reply is read for its redis_version. */
export function versionText(driver: string, cell: string | null): string {
  if (driver !== "redis") return cell ?? "";
  const version = cell?.match(/^redis_version:(.*)$/m)?.[1]?.trim();
  const valkey = cell?.match(/^valkey_version:(.*)$/m)?.[1]?.trim();
  return valkey ? `Valkey ${valkey}` : version ? `Redis ${version}` : "Redis";
}
const schema = (driver: string) => (driver === "pgsql" ? "current_schema()" : "DATABASE()");

export function tablesQuery(driver: string): string {
  if (driver === "sqlite") return "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name";
  return `SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema(driver)} ORDER BY table_name`;
}

/** Each row is the column's name, type, and whether it's nullable. */
export function columnsQuery(driver: string, table: string): string {
  if (driver === "sqlite") return `SELECT name, type, CASE WHEN "notnull" THEN 'NO' ELSE 'YES' END FROM pragma_table_info(${quote(table)})`;
  return `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = ${schema(driver)} AND table_name = ${quote(table)} ORDER BY ordinal_position`;
}

/** Each row is a table, one of its columns, and the column's type, for SQL completion. */
export function schemaQuery(driver: string): string {
  if (driver === "sqlite")
    return "SELECT m.name, p.name, p.type FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid";
  return `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = ${schema(driver)} ORDER BY table_name, ordinal_position`;
}

/** Each row is an index's name, whether it's unique ("1" or "0"), and its columns, comma-separated. */
export function indexesQuery(driver: string, table: string): string {
  if (driver === "sqlite")
    return `SELECT il.name, il."unique", group_concat(ii.name, ', ') FROM pragma_index_list(${quote(table)}) il JOIN pragma_index_info(il.name) ii GROUP BY il.name ORDER BY il.name`;
  if (driver === "pgsql")
    return `SELECT c.relname, CASE WHEN i.indisunique THEN '1' ELSE '0' END, string_agg(a.attname, ', ' ORDER BY k.n) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, n) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum WHERE i.indrelid = ${quote(quoteIdentifier(driver, table))}::regclass GROUP BY c.relname, i.indisunique ORDER BY c.relname`;
  return `SELECT index_name, IF(MAX(non_unique) = 0, '1', '0'), GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ', ') FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ${quote(table)} GROUP BY index_name ORDER BY index_name`;
}

/** Each row is a foreign key's column, the table it references, and that table's column. */
export function foreignKeysQuery(driver: string, table: string): string {
  if (driver === "sqlite") return `SELECT "from", "table", "to" FROM pragma_foreign_key_list(${quote(table)}) ORDER BY id, seq`;
  if (driver === "pgsql")
    return `SELECT a.attname, cf.relname, af.attname FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(col, ref) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.col JOIN pg_class cf ON cf.oid = c.confrelid JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = k.ref WHERE c.contype = 'f' AND c.conrelid = ${quote(quoteIdentifier(driver, table))}::regclass ORDER BY c.conname`;
  return `SELECT column_name, referenced_table_name, referenced_column_name FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = ${quote(table)} AND referenced_table_name IS NOT NULL ORDER BY constraint_name, ordinal_position`;
}

/** Each row is a column's default value as SQL, or null for none: SQLite's UPDATE has no DEFAULT keyword. */
export const defaultsQuery = (table: string) => `SELECT name, dflt_value FROM pragma_table_info(${quote(table)})`;

/** A SELECT of a table's columns, for Generate SELECT. */
export function selectTemplate(driver: string, table: string, columns: string[]): string {
  const id = (n: string) => quoteIdentifier(driver, n);
  return `SELECT ${columns.length ? columns.map(id).join(", ") : "*"}\nFROM ${id(table)}`;
}

/** An INSERT with a placeholder per column, for Generate INSERT. */
export function insertTemplate(driver: string, table: string, columns: string[]): string {
  const id = (n: string) => quoteIdentifier(driver, n);
  return `INSERT INTO ${id(table)} (${columns.map(id).join(", ")})\nVALUES (${columns.map(() => "?").join(", ")})`;
}

/** Each row is one column of the table's primary key. */
export function primaryKeyQuery(driver: string, table: string): string {
  if (driver === "sqlite") return `SELECT name FROM pragma_table_info(${quote(table)}) WHERE pk > 0 ORDER BY pk`;
  if (driver === "pgsql")
    return `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = ${quote(quoteIdentifier(driver, table))}::regclass AND i.indisprimary`;
  return `SELECT column_name FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = ${quote(table)} AND constraint_name = 'PRIMARY' ORDER BY ordinal_position`;
}

/** A value for a statement: text, null, or SQL as it is, such as DEFAULT. */
export type SqlValue = string | null | { sql: string };

/** A string literal. MySQL also treats backslashes as escapes. Every database converts a string to the column's type. */
export function literal(driver: string, value: SqlValue): string {
  if (value === null) return "NULL";
  if (typeof value === "object") return value.sql;
  return quote(driver === "mysql" || driver === "mariadb" ? value.replace(/\\/g, "\\\\") : value);
}

/** The WHERE condition for the row whose primary key has the given values. */
function whereKey(driver: string, key: Record<string, string | null>): string {
  const id = (name: string) => quoteIdentifier(driver, name);
  return Object.entries(key).map(([k, v]) => (v === null ? `${id(k)} IS NULL` : `${id(k)} = ${literal(driver, v)}`)).join(" AND ");
}

/** Updates cells of the row whose primary key has the given values, as they were before the update. */
export function updateStatement(driver: string, table: string, values: Record<string, SqlValue>, key: Record<string, string | null>): string {
  const id = (name: string) => quoteIdentifier(driver, name);
  const set = Object.entries(values).map(([column, value]) => `${id(column)} = ${literal(driver, value)}`).join(", ");
  return `UPDATE ${id(table)} SET ${set} WHERE ${whereKey(driver, key)}`;
}

/** Deletes the row whose primary key has the given values. */
export const deleteStatement = (driver: string, table: string, key: Record<string, string | null>) =>
  `DELETE FROM ${quoteIdentifier(driver, table)} WHERE ${whereKey(driver, key)}`;

/** Inserts a row. Columns left out get their default values. */
export function insertStatement(driver: string, table: string, values: Record<string, SqlValue>): string {
  const id = (name: string) => quoteIdentifier(driver, name);
  const columns = Object.keys(values);
  if (!columns.length) return driver === "mysql" || driver === "mariadb" ? `INSERT INTO ${id(table)} () VALUES ()` : `INSERT INTO ${id(table)} DEFAULT VALUES`;
  return `INSERT INTO ${id(table)} (${columns.map(id).join(", ")}) VALUES (${columns.map((c) => literal(driver, values[c])).join(", ")})`;
}
