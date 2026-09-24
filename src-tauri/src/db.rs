// Database queries for the database tool. The drivers are compiled in, so no client needs installing.
// Every value comes back as text (or null), which is all a results grid needs.
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct Connection {
    driver: String, // sqlite, mysql, mariadb, or pgsql, as in Laravel's DB_CONNECTION
    host: String,
    port: u16,
    database: String,
    username: String,
    password: String,
}

#[derive(Serialize, Default)]
pub struct QueryResult {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    affected: u64,
    truncated: bool,
}

const MAX_ROWS: usize = 1000;

impl QueryResult {
    fn push(&mut self, row: Vec<Option<String>>) {
        if self.rows.len() < MAX_ROWS {
            self.rows.push(row);
        } else {
            self.truncated = true;
        }
    }
}

/// Runs one statement and returns its rows, or the number of rows it changed.
// ponytail: connects for every query; keep a connection per project if that gets slow on remote hosts.
#[tauri::command]
pub async fn db_query(connection: Connection, sql: String) -> Result<QueryResult, String> {
    tauri::async_runtime::spawn_blocking(move || match connection.driver.as_str() {
        "sqlite" => sqlite(&connection, &sql),
        "mysql" | "mariadb" => mysql(&connection, &sql),
        "pgsql" => pgsql(&connection, &sql),
        other => Err(format!("The {other} driver isn't supported.")),
    })
    .await
    .map_err(|e| e.to_string())?
}

fn sqlite(c: &Connection, sql: &str) -> Result<QueryResult, String> {
    use rusqlite::types::ValueRef;
    let err = |e: rusqlite::Error| e.to_string();
    let db = rusqlite::Connection::open_with_flags(&c.database, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(err)?;
    let mut stmt = db.prepare(sql).map_err(err)?;
    let mut result = QueryResult { columns: stmt.column_names().iter().map(|s| s.to_string()).collect(), ..Default::default() };
    if result.columns.is_empty() {
        result.affected = stmt.execute([]).map_err(err)? as u64;
        return Ok(result);
    }
    let count = result.columns.len();
    let mut rows = stmt.query([]).map_err(err)?;
    while let Some(row) = rows.next().map_err(err)? {
        let cells = (0..count)
            .map(|i| match row.get_ref(i) {
                Ok(ValueRef::Null) | Err(_) => None,
                Ok(ValueRef::Integer(n)) => Some(n.to_string()),
                Ok(ValueRef::Real(n)) => Some(n.to_string()),
                Ok(ValueRef::Text(t)) => Some(String::from_utf8_lossy(t).into()),
                Ok(ValueRef::Blob(b)) => Some(format!("<{} bytes>", b.len())),
            })
            .collect();
        result.push(cells);
    }
    Ok(result)
}

fn mysql(c: &Connection, sql: &str) -> Result<QueryResult, String> {
    use mysql::prelude::Queryable;
    let err = |e: mysql::Error| match e {
        mysql::Error::MySqlError(e) => e.message,
        e => e.to_string(),
    };
    let opts = mysql::OptsBuilder::new()
        .ip_or_hostname(Some(&c.host))
        .tcp_port(c.port)
        .db_name(Some(&c.database))
        .user(Some(&c.username))
        .pass(Some(&c.password));
    let mut conn = mysql::Conn::new(opts).map_err(err)?;
    // The text protocol returns every value as bytes, so each cell reads as a string.
    let mut rows = conn.query_iter(sql).map_err(err)?;
    let mut result = QueryResult { affected: rows.affected_rows(), ..Default::default() };
    result.columns = rows.columns().as_ref().iter().map(|c| c.name_str().into_owned()).collect();
    for row in rows.by_ref() {
        let cells = row
            .map_err(err)?
            .unwrap()
            .into_iter()
            .map(|v| match v {
                mysql::Value::NULL => None,
                mysql::Value::Bytes(b) => Some(String::from_utf8_lossy(&b).into()),
                other => Some(other.as_sql(true)),
            })
            .collect();
        result.push(cells);
    }
    Ok(result)
}

fn pgsql(c: &Connection, sql: &str) -> Result<QueryResult, String> {
    use postgres::SimpleQueryMessage;
    let err = |e: postgres::Error| e.as_db_error().map_or_else(|| e.to_string(), |d| d.message().to_string());
    // ponytail: no TLS; add postgres-native-tls when someone connects to a server that requires it.
    let mut client = postgres::Config::new()
        .host(&c.host)
        .port(c.port)
        .dbname(&c.database)
        .user(&c.username)
        .password(&c.password)
        .connect(postgres::NoTls)
        .map_err(err)?;
    // The simple query protocol returns every value as text.
    let mut result = QueryResult::default();
    for message in client.simple_query(sql).map_err(err)? {
        match message {
            SimpleQueryMessage::RowDescription(columns) => result.columns = columns.iter().map(|c| c.name().into()).collect(),
            SimpleQueryMessage::Row(row) => result.push((0..row.len()).map(|i| row.get(i).map(String::from)).collect()),
            SimpleQueryMessage::CommandComplete(n) => result.affected = n,
            _ => {}
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_sqlite() {
        let path = std::env::temp_dir().join("php-editor-db-test.sqlite");
        let _ = std::fs::remove_file(&path);
        rusqlite::Connection::open(&path).unwrap();
        let c = Connection { driver: "sqlite".into(), host: String::new(), port: 0, database: path.to_string_lossy().into(), username: String::new(), password: String::new() };
        sqlite(&c, "CREATE TABLE t (id INTEGER, name TEXT)").unwrap();
        assert_eq!(sqlite(&c, "INSERT INTO t VALUES (1, 'a'), (2, NULL)").unwrap().affected, 2);
        let r = sqlite(&c, "SELECT * FROM t").unwrap();
        assert_eq!(r.columns, ["id", "name"]);
        assert_eq!(r.rows, [vec![Some("1".into()), Some("a".into())], vec![Some("2".into()), None]]);
    }

    /// Against throwaway servers: `docker run -e MYSQL_ROOT_PASSWORD=secret -e MYSQL_DATABASE=laravel -p 33066:3306 mysql:8`
    /// and `docker run -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=laravel -p 54329:5432 postgres:17`.
    #[test]
    #[ignore]
    fn queries_servers() {
        for (driver, port, user) in [("mysql", 33066, "root"), ("pgsql", 54329, "postgres")] {
            let c = Connection { driver: driver.into(), host: "127.0.0.1".into(), port, database: "laravel".into(), username: user.into(), password: "secret".into() };
            let run = |sql: &str| if driver == "mysql" { mysql(&c, sql) } else { pgsql(&c, sql) }.unwrap();
            run("DROP TABLE IF EXISTS t");
            run("CREATE TABLE t (id INTEGER, name TEXT, at TIMESTAMP NULL)");
            assert_eq!(run("INSERT INTO t VALUES (1, 'a', '2026-01-02 03:04:05'), (2, NULL, NULL)").affected, 2, "{driver}");
            let r = run("SELECT * FROM t ORDER BY id");
            assert_eq!(r.columns, ["id", "name", "at"], "{driver}");
            assert_eq!(r.rows, [vec![Some("1".into()), Some("a".into()), Some("2026-01-02 03:04:05".into())], vec![Some("2".into()), None, None]], "{driver}");
        }
    }
}
