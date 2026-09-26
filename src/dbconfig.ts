// Reads a Laravel project's database connection from .env, and finds the SQL statement to run.
// Free of editor imports so Node can test it.

/** `ssl_mode` is libpq's sslmode, and `ssl_ca` a certificate authority file; the Rust side reads both. */
export type Connection = { driver: string; host: string; port: number; database: string; username: string; password: string; ssl_mode: string; ssl_ca: string };

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

const defaultPort = (driver: string) => (driver === "pgsql" ? 5432 : 3306);
const drivers: Record<string, string> = { mysql: "mysql", mariadb: "mariadb", pgsql: "pgsql", postgres: "pgsql", postgresql: "pgsql", sqlite: "sqlite" };

/**
 * A connection from a URL, as Laravel's DB_URL takes one: `mysql://user:password@host:3306/database?sslmode=require`,
 * `pgsql://…` (or `postgres://…`), or `sqlite:database/other.sqlite` (relative to the project) and `sqlite:///absolute/path`.
 * Null if it isn't one.
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
  const params = new URLSearchParams(Object.entries({ sslmode: c.ssl_mode, sslrootcert: inProject(c.ssl_ca) }).filter(([, v]) => v)).toString();
  return `${c.driver}://${c.username ? `${e(c.username)}@` : ""}${c.host.includes(":") ? `[${c.host}]` : c.host}:${c.port}/${e(c.database)}${params ? `?${params}` : ""}`;
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

/** A connection in a line, such as `mysql · root@127.0.0.1:3306/laravel`, without the password. */
export const describe = (c: Connection, root: string) =>
  c.driver === "sqlite"
    ? `SQLite · ${c.database.replace(root + "/", "")}`
    : `${c.driver} · ${c.username}@${c.host}:${c.port}/${c.database}${c.ssl_mode || c.ssl_ca ? ` · TLS ${c.ssl_mode}`.trimEnd() : ""}`;

/** The statement around an offset, as PhpStorm runs the statement under the caret. */
// ponytail: splits on every semicolon, including ones inside strings and comments.
export function statementAt(text: string, offset: number): string {
  // With the caret on the same line after a semicolon, run the statement that the semicolon ends.
  const semicolon = text.lastIndexOf(";", offset - 1);
  if (semicolon >= 0 && /^[ \t]*$/.test(text.slice(semicolon + 1, offset))) offset = semicolon;
  const start = text.lastIndexOf(";", offset - 1) + 1;
  const end = text.indexOf(";", offset);
  const statement = text.slice(start, end < 0 ? text.length : end).trim();
  // After the last statement, run the one before.
  if (!hasCode(statement)) return start > 0 ? statementAt(text, start - 1) : "";
  return statement;
}

/** False for text that is only whitespace and comments, which the database would reject. */
export const hasCode = (sql: string) => sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim() !== "";

export const quoteIdentifier = (driver: string, name: string) =>
  driver === "mysql" || driver === "mariadb" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
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

/** Each row is one column of the table's primary key. */
export function primaryKeyQuery(driver: string, table: string): string {
  if (driver === "sqlite") return `SELECT name FROM pragma_table_info(${quote(table)}) WHERE pk > 0 ORDER BY pk`;
  if (driver === "pgsql")
    return `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = ${quote(quoteIdentifier(driver, table))}::regclass AND i.indisprimary`;
  return `SELECT column_name FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = ${quote(table)} AND constraint_name = 'PRIMARY' ORDER BY ordinal_position`;
}

/** A string literal. MySQL also treats backslashes as escapes. Every database converts a string to the column's type. */
export function literal(driver: string, value: string | null): string {
  if (value === null) return "NULL";
  return quote(driver === "mysql" || driver === "mariadb" ? value.replace(/\\/g, "\\\\") : value);
}

/** The WHERE condition for the row whose primary key has the given values. */
function whereKey(driver: string, key: Record<string, string | null>): string {
  const id = (name: string) => quoteIdentifier(driver, name);
  return Object.entries(key).map(([k, v]) => (v === null ? `${id(k)} IS NULL` : `${id(k)} = ${literal(driver, v)}`)).join(" AND ");
}

/** Updates cells of the row whose primary key has the given values, as they were before the update. */
export function updateStatement(driver: string, table: string, values: Record<string, string | null>, key: Record<string, string | null>): string {
  const id = (name: string) => quoteIdentifier(driver, name);
  const set = Object.entries(values).map(([column, value]) => `${id(column)} = ${literal(driver, value)}`).join(", ");
  return `UPDATE ${id(table)} SET ${set} WHERE ${whereKey(driver, key)}`;
}

/** Deletes the row whose primary key has the given values. */
export const deleteStatement = (driver: string, table: string, key: Record<string, string | null>) =>
  `DELETE FROM ${quoteIdentifier(driver, table)} WHERE ${whereKey(driver, key)}`;

/** Inserts a row. Columns left out get their default values. */
export function insertStatement(driver: string, table: string, values: Record<string, string | null>): string {
  const id = (name: string) => quoteIdentifier(driver, name);
  const columns = Object.keys(values);
  if (!columns.length) return driver === "mysql" || driver === "mariadb" ? `INSERT INTO ${id(table)} () VALUES ()` : `INSERT INTO ${id(table)} DEFAULT VALUES`;
  return `INSERT INTO ${id(table)} (${columns.map(id).join(", ")}) VALUES (${columns.map((c) => literal(driver, values[c])).join(", ")})`;
}
