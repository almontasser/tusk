// Reads a Laravel project's database connection from .env, and finds the SQL statement to run.
// Free of editor imports so Node can test it.

export type Connection = { driver: string; host: string; port: number; database: string; username: string; password: string };

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

/** Laravel's defaults from config/database.php fill anything .env leaves out. */
export function connectionFromEnv(env: Record<string, string>, root: string): Connection {
  const driver = env.DB_CONNECTION || "sqlite";
  if (driver === "sqlite") {
    const file = env.DB_DATABASE || "database/database.sqlite";
    return { driver, host: "", port: 0, username: "", password: "", database: file.startsWith("/") ? file : `${root}/${file}` };
  }
  const port = Number(env.DB_PORT) || (driver === "pgsql" ? 5432 : 3306);
  return { driver, host: env.DB_HOST || "127.0.0.1", port, database: env.DB_DATABASE || "laravel", username: env.DB_USERNAME || "root", password: env.DB_PASSWORD || "" };
}

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
