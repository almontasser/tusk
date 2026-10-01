// Database queries for the database tool. The drivers are compiled in, so no client needs installing.
// Every value comes back as text (or null), which is all a results grid needs.
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Clone)]
pub struct Connection {
    driver: String, // sqlite, mysql, mariadb, or pgsql, as in Laravel's DB_CONNECTION, or redis
    host: String,
    port: u16,
    database: String,
    username: String,
    password: String,
    /// libpq's sslmode (disable, prefer, require, verify-ca, verify-full), from DB_SSLMODE. Empty for the driver's default.
    #[serde(default)]
    ssl_mode: String,
    /// A PEM file of the certificate authority to trust: MYSQL_ATTR_SSL_CA, or DB_SSLROOTCERT for PostgreSQL.
    #[serde(default)]
    ssl_ca: String,
    /// Refuses changes: SQLite opens the file read-only, and MySQL and PostgreSQL start a read-only session.
    #[serde(default)]
    read_only: bool,
    /// Rows per page, from the Database settings; 0 for every row, as for an export.
    #[serde(default = "default_page_size")]
    page_size: usize,
    /// Seconds to wait for the server to accept the connection.
    #[serde(default = "default_connect_timeout")]
    connect_timeout: u64,
    /// Seconds a Redis command may take before its connection gives up; 0 for no limit. SQL queries are
    /// canceled by the frontend instead, with db_cancel, which leaves the connection usable.
    #[serde(default = "default_read_timeout")]
    read_timeout: u64,
}

const fn default_page_size() -> usize {
    1000
}
const fn default_connect_timeout() -> u64 {
    10
}
const fn default_read_timeout() -> u64 {
    60
}

impl Default for Connection {
    fn default() -> Self {
        Connection {
            driver: String::new(),
            host: String::new(),
            port: 0,
            database: String::new(),
            username: String::new(),
            password: String::new(),
            ssl_mode: String::new(),
            ssl_ca: String::new(),
            read_only: false,
            page_size: default_page_size(),
            connect_timeout: default_connect_timeout(),
            read_timeout: default_read_timeout(),
        }
    }
}

#[derive(Serialize, Default)]
pub struct QueryResult {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    affected: u64,
    truncated: bool,
    /// Every row the statement returned, including those skipped and those past the page.
    total: u64,
    /// Columns holding binary values, which come back as `\x` and hex, as PostgreSQL shows bytea. The grid
    /// keeps them read-only, since writing that text back would store text.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    binary: Vec<usize>,
    /// Rows to skip before the page starts.
    #[serde(skip)]
    skip: u64,
    /// Rows per page (the connection's `page_size`); 0 for every row. `database.ts` asks for the next page with an offset.
    #[serde(skip)]
    limit: usize,
}

impl QueryResult {
    fn new(c: &Connection, skip: u64) -> Self {
        QueryResult { skip, limit: c.page_size, ..Default::default() }
    }

    fn push(&mut self, row: Vec<Option<String>>) {
        self.total += 1;
        if self.total <= self.skip {
            return;
        }
        if self.limit == 0 || self.rows.len() < self.limit {
            self.rows.push(row);
        } else {
            self.truncated = true;
        }
    }

    /// A binary value as text: `\x` and its hex, or its size when it's over 64 KB.
    fn bytes(&mut self, column: usize, bytes: &[u8]) -> String {
        if !self.binary.contains(&column) {
            self.binary.push(column);
        }
        if bytes.len() > 64 * 1024 {
            return format!("<binary, {} bytes>", bytes.len());
        }
        let mut text = String::with_capacity(2 + bytes.len() * 2);
        text.push_str("\\x");
        for b in bytes {
            text.push_str(&format!("{b:02x}"));
        }
        text
    }
}

/// How to stop a running query: SQLite's interrupt, MySQL's `KILL QUERY` from a second connection, or
/// PostgreSQL's cancel request. None while the query is still connecting.
enum Cancel {
    Sqlite(rusqlite::InterruptHandle),
    Mysql(Connection, u32),
    Pgsql(Connection, postgres::CancelToken),
}

/// Running queries by the id the frontend gives them, so db_cancel can stop one.
static RUNNING: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, Option<Cancel>>>> = std::sync::LazyLock::new(Default::default);

/// Registers a running query's cancel, once it has connected. Fails when it was canceled while connecting.
fn running(id: &Option<String>, cancel: impl FnOnce() -> Cancel) -> Result<(), String> {
    let Some(id) = id else { return Ok(()) };
    match RUNNING.lock().unwrap().get_mut(id) {
        Some(slot) => Ok(*slot = Some(cancel())),
        None => Err(CANCELED.into()),
    }
}

const CANCELED: &str = "Canceled.";

/// Stops a running query: SQLite interrupts it, MySQL and MariaDB run `KILL QUERY` on a second connection,
/// and PostgreSQL sends a cancel request, as `pg_cancel_backend` does. A query still connecting stops once it
/// connects. Returns whether the query was running.
#[tauri::command]
pub async fn db_cancel(id: String) -> Result<bool, String> {
    let Some(cancel) = RUNNING.lock().unwrap().remove(&id) else { return Ok(false) };
    tauri::async_runtime::spawn_blocking(move || match cancel {
        None => Ok(true),
        Some(Cancel::Sqlite(handle)) => {
            handle.interrupt();
            Ok(true)
        }
        Some(Cancel::Mysql(c, thread)) => {
            use mysql::prelude::Queryable;
            let mut conn = open_mysql(&Connection { read_only: false, ..c })?;
            conn.query_drop(format!("KILL QUERY {thread}")).map_err(mysql_error)?;
            Ok(true)
        }
        Some(Cancel::Pgsql(c, token)) => {
            let mode = if c.ssl_mode.is_empty() { "prefer" } else { c.ssl_mode.as_str() };
            token.cancel_query(postgres_native_tls::MakeTlsConnector::new(tls_connector(&c, mode)?)).map_err(pgsql_error)?;
            Ok(true)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs one statement and returns a page of its rows, from `offset`, or the number of rows it changed. With an
/// `id`, db_cancel can stop it.
// ponytail: connects for every query, and each page runs the statement again and reads every row, which the
// drivers do anyway (MySQL drains the rest, PostgreSQL's simple query buffers it); a server-side cursor on a
// kept connection if that gets slow on remote hosts.
#[tauri::command]
pub async fn db_query(connection: Connection, sql: String, offset: Option<u64>, id: Option<String>) -> Result<QueryResult, String> {
    let skip = offset.unwrap_or(0);
    if let Some(id) = &id {
        RUNNING.lock().unwrap().insert(id.clone(), None);
    }
    let result = tauri::async_runtime::spawn_blocking({
        let id = id.clone();
        move || match connection.driver.as_str() {
            "sqlite" => sqlite(&connection, &sql, skip, &id),
            "mysql" | "mariadb" => mysql(&connection, &sql, skip, &id),
            "pgsql" => pgsql(&connection, &sql, skip, &id),
            "redis" => redis(&connection, &sql, skip),
            other => Err(format!("The {other} driver isn't supported.")),
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    // Gone from RUNNING means db_cancel took it: the driver's error is the cancel's, and MySQL's SLEEP, which
    // returns early rather than failing, isn't a result either.
    if id.is_some_and(|id| RUNNING.lock().unwrap().remove(&id).is_none()) {
        return Err(CANCELED.into());
    }
    result
}

/// Runs statements in one transaction, and returns how many rows each changed. If one fails, none apply. With
/// `one_row_each`, as for edits in the results grid, a statement that changes no row or several fails too.
#[tauri::command]
pub async fn db_batch(connection: Connection, statements: Vec<String>, one_row_each: Option<bool>) -> Result<Vec<u64>, String> {
    if connection.read_only {
        return Err("Nothing was saved: the connection is read-only.".into());
    }
    let check = move |affected: Vec<u64>| match affected.iter().position(|&n| n != 1) {
        Some(i) if one_row_each == Some(true) => Err(format!("Nothing was saved: change {} of {} matched {} rows instead of one.", i + 1, affected.len(), affected[i])),
        _ => Ok(affected),
    };
    tauri::async_runtime::spawn_blocking(move || match connection.driver.as_str() {
        "sqlite" => {
            let err = |e: rusqlite::Error| e.to_string();
            let mut db = open_sqlite(&connection)?;
            let tx = db.transaction().map_err(err)?;
            let affected = check(statements.iter().map(|s| tx.execute(s, []).map(|n| n as u64).map_err(err)).collect::<Result<Vec<_>, _>>()?)?;
            tx.commit().map_err(err)?;
            Ok(affected)
        }
        "mysql" | "mariadb" => {
            use mysql::prelude::Queryable;
            let mut conn = open_mysql(&connection)?;
            let mut tx = conn.start_transaction(mysql::TxOpts::default()).map_err(mysql_error)?;
            let mut affected = Vec::new();
            for s in &statements {
                tx.query_drop(s).map_err(mysql_error)?;
                affected.push(tx.affected_rows());
            }
            let affected = check(affected)?;
            tx.commit().map_err(mysql_error)?;
            Ok(affected)
        }
        "pgsql" => {
            let mut client = open_pgsql(&connection)?;
            let mut tx = client.transaction().map_err(pgsql_error)?;
            let affected = check(statements.iter().map(|s| tx.execute(s.as_str(), &[]).map_err(pgsql_error)).collect::<Result<Vec<_>, _>>()?)?;
            tx.commit().map_err(pgsql_error)?;
            Ok(affected)
        }
        other => Err(format!("The {other} driver isn't supported.")),
    })
    .await
    .map_err(|e| e.to_string())?
}

fn open_sqlite(c: &Connection) -> Result<rusqlite::Connection, String> {
    use rusqlite::OpenFlags;
    let mode = if c.read_only { OpenFlags::SQLITE_OPEN_READ_ONLY } else { OpenFlags::SQLITE_OPEN_READ_WRITE };
    let db = rusqlite::Connection::open_with_flags(&c.database, mode).map_err(|e| e.to_string())?;
    // Wait for another process's write, such as the app's, instead of failing with "database is locked".
    db.busy_timeout(std::time::Duration::from_secs(c.connect_timeout.max(1))).map_err(|e| e.to_string())?;
    Ok(db)
}

fn mysql_error(e: mysql::Error) -> String {
    match e {
        mysql::Error::MySqlError(e) => e.message,
        e => e.to_string(),
    }
}

/// Connects to MySQL or MariaDB. With a CA file, or `ssl_mode` set to require or verify, the connection is
/// encrypted; `require` alone, as in libpq, doesn't check the server's certificate.
fn open_mysql(c: &Connection) -> Result<mysql::Conn, String> {
    // CLIENT_FOUND_ROWS: an UPDATE reports the rows it matched, not only those whose value changed, so a grid
    // edit that sets a cell to the value it has (10.50 as 10.5) still counts as one row.
    let mut opts = mysql::OptsBuilder::new()
        .additional_capabilities(mysql::consts::CapabilityFlags::CLIENT_FOUND_ROWS)
        .ip_or_hostname(Some(&c.host))
        .tcp_port(c.port)
        .db_name(Some(&c.database))
        .user(Some(&c.username))
        .pass(Some(&c.password))
        .tcp_connect_timeout(Some(std::time::Duration::from_secs(c.connect_timeout.max(1))));
    if c.read_only {
        opts = opts.init(vec!["SET SESSION TRANSACTION READ ONLY"]);
    }
    let mode = c.ssl_mode.as_str();
    if !c.ssl_ca.is_empty() || matches!(mode, "require" | "verify-ca" | "verify-full") {
        let mut ssl = mysql::SslOpts::default();
        if !c.ssl_ca.is_empty() {
            ssl = ssl.with_root_cert_path(Some(std::path::PathBuf::from(&c.ssl_ca)));
        }
        let unchecked = mode == "require" && c.ssl_ca.is_empty();
        ssl = ssl.with_danger_accept_invalid_certs(unchecked).with_danger_skip_domain_validation(unchecked || mode == "verify-ca");
        opts = opts.ssl_opts(ssl);
    }
    mysql::Conn::new(opts).map_err(mysql_error)
}

fn pgsql_error(e: postgres::Error) -> String {
    // The driver's own message is terse, such as "error connecting to server"; its source says why.
    let detail = || std::error::Error::source(&e).map_or_else(|| e.to_string(), |source| format!("{e}: {source}"));
    e.as_db_error().map_or_else(detail, |d| d.message().to_string())
}

/// Connects to PostgreSQL with libpq's sslmode, which Laravel defaults to `prefer`: try TLS, and fall back
/// to plain text. `prefer` and `require` don't check the certificate, `verify-ca` checks it but not the
/// host name, and `verify-full` checks both, against the system's authorities and `ssl_ca`.
fn open_pgsql(c: &Connection) -> Result<postgres::Client, String> {
    use postgres::config::SslMode;
    let mode = if c.ssl_mode.is_empty() { "prefer" } else { c.ssl_mode.as_str() };
    let connector = postgres_native_tls::MakeTlsConnector::new(tls_connector(c, mode)?);
    let mut config = postgres::Config::new();
    config
        .host(&c.host)
        .port(c.port)
        .dbname(&c.database)
        .user(&c.username)
        .password(&c.password)
        .connect_timeout(std::time::Duration::from_secs(c.connect_timeout.max(1)))
        .ssl_mode(match mode {
            "disable" => SslMode::Disable,
            "prefer" | "allow" => SslMode::Prefer,
            _ => SslMode::Require,
        });
    if c.read_only {
        config.options("-c default_transaction_read_only=on");
    }
    config.connect(connector).map_err(pgsql_error)
}

/// A TLS connector for libpq's sslmode: `allow`, `prefer`, and `require` accept any certificate, `verify-ca` checks
/// it but not the host name, and `verify-full` checks both, against the system's authorities and `ssl_ca`.
fn tls_connector(c: &Connection, mode: &str) -> Result<native_tls::TlsConnector, String> {
    let mut tls = native_tls::TlsConnector::builder();
    tls.danger_accept_invalid_certs(matches!(mode, "allow" | "prefer" | "require"))
        .danger_accept_invalid_hostnames(mode != "verify-full");
    if !c.ssl_ca.is_empty() {
        // A bundle, such as AWS RDS's, holds many certificates; from_pem takes only one.
        let pem = std::fs::read(&c.ssl_ca).map_err(|e| format!("Can't read {}: {e}", c.ssl_ca))?;
        for cert in native_tls::Certificate::stack_from_pem(&pem).map_err(|e| e.to_string())? {
            tls.add_root_certificate(cert);
        }
    }
    tls.build().map_err(|e| e.to_string())
}

fn sqlite(c: &Connection, sql: &str, skip: u64, id: &Option<String>) -> Result<QueryResult, String> {
    use rusqlite::types::ValueRef;
    let err = |e: rusqlite::Error| e.to_string();
    let db = open_sqlite(c)?;
    running(id, || Cancel::Sqlite(db.get_interrupt_handle()))?;
    let mut stmt = db.prepare(sql).map_err(err)?;
    let mut result = QueryResult::new(c, skip);
    result.columns = stmt.column_names().iter().map(|s| s.to_string()).collect();
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
                Ok(ValueRef::Blob(b)) => Some(result.bytes(i, b)),
            })
            .collect();
        result.push(cells);
    }
    Ok(result)
}

fn mysql(c: &Connection, sql: &str, skip: u64, id: &Option<String>) -> Result<QueryResult, String> {
    use mysql::prelude::Queryable;
    let err = mysql_error;
    let mut conn = open_mysql(c)?;
    running(id, || Cancel::Mysql(c.clone(), conn.connection_id()))?;
    // The text protocol returns every value as bytes, so each cell reads as a string.
    let mut rows = conn.query_iter(sql).map_err(err)?;
    let mut result = QueryResult::new(c, skip);
    result.affected = rows.affected_rows();
    result.columns = rows.columns().as_ref().iter().map(|c| c.name_str().into_owned()).collect();
    for row in rows.by_ref() {
        let cells = row
            .map_err(err)?
            .unwrap()
            .into_iter()
            .enumerate()
            .map(|(i, v)| match v {
                mysql::Value::NULL => None,
                mysql::Value::Bytes(b) => Some(String::from_utf8(b).unwrap_or_else(|e| result.bytes(i, e.as_bytes()))),
                other => Some(other.as_sql(true)),
            })
            .collect();
        result.push(cells);
    }
    Ok(result)
}

fn pgsql(c: &Connection, sql: &str, skip: u64, id: &Option<String>) -> Result<QueryResult, String> {
    use postgres::SimpleQueryMessage;
    let err = pgsql_error;
    let mut client = open_pgsql(c)?;
    running(id, || Cancel::Pgsql(c.clone(), client.cancel_token()))?;
    // The simple query protocol returns every value as text.
    let mut result = QueryResult::new(c, skip);
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

/// A Redis reply, as RESP2 sends it. A bulk string that isn't UTF-8, such as a compressed cache value, is bytes.
enum Reply {
    Nil,
    Text(String),
    Bytes(Vec<u8>),
    Int(i64),
    Array(Vec<Reply>),
    Error(String),
}

trait Stream: std::io::Read + std::io::Write + Send {}
impl<T: std::io::Read + std::io::Write + Send> Stream for T {}

/// A Redis connection that speaks RESP2, which every Redis and Valkey version does.
struct Redis(std::io::BufReader<Box<dyn Stream>>);

impl Redis {
    /// Connects, over TLS when `ssl_mode` is set (a `rediss://` URL), then signs in and selects `database`.
    fn open(c: &Connection) -> Result<Self, String> {
        use std::net::ToSocketAddrs;
        let unreachable = |e: &dyn std::fmt::Display| format!("Can't connect to Redis at {}:{}: {e}", c.host, c.port);
        let addresses: Vec<_> = (c.host.as_str(), c.port).to_socket_addrs().map_err(|e| unreachable(&e))?.collect();
        let mut last = None;
        let tcp = addresses
            .iter()
            .find_map(|a| std::net::TcpStream::connect_timeout(a, std::time::Duration::from_secs(c.connect_timeout.max(1))).map_err(|e| last = Some(e)).ok())
            .ok_or_else(|| unreachable(&last.map_or("no address".into(), |e| e.to_string())))?;
        // A blocking command, such as BLPOP, can't hold the query forever, unless the setting is 0.
        let timeout = (c.read_timeout > 0).then(|| std::time::Duration::from_secs(c.read_timeout));
        let _ = tcp.set_read_timeout(timeout);
        let _ = tcp.set_write_timeout(timeout);
        let _ = tcp.set_nodelay(true);
        let stream: Box<dyn Stream> = match c.ssl_mode.as_str() {
            "" | "disable" => Box::new(tcp),
            mode => Box::new(tls_connector(c, mode)?.connect(&c.host, tcp).map_err(|e| unreachable(&e))?),
        };
        let mut redis = Redis(std::io::BufReader::new(stream));
        if !c.password.is_empty() {
            let mut auth = vec!["AUTH".to_string()];
            auth.extend((!c.username.is_empty()).then(|| c.username.clone()));
            auth.push(c.password.clone());
            redis.call(&auth)?;
        }
        if !matches!(c.database.as_str(), "" | "0") {
            redis.call(&["SELECT".into(), c.database.clone()])?;
        }
        Ok(redis)
    }

    /// Writes commands without waiting for their replies, so several make one round trip.
    fn send(&mut self, commands: &[Vec<String>]) -> std::io::Result<()> {
        use std::io::Write;
        let mut bytes = Vec::new();
        for args in commands {
            bytes.extend(format!("*{}\r\n", args.len()).into_bytes());
            for arg in args {
                bytes.extend(format!("${}\r\n", arg.len()).into_bytes());
                bytes.extend(arg.as_bytes());
                bytes.extend(b"\r\n");
            }
        }
        self.0.get_mut().write_all(&bytes)
    }

    fn read(&mut self) -> std::io::Result<Reply> {
        use std::io::{BufRead, Error, ErrorKind, Read};
        let mut line = Vec::new();
        self.0.read_until(b'\n', &mut line)?;
        if line.len() < 3 {
            return Err(Error::new(ErrorKind::UnexpectedEof, "Redis closed the connection."));
        }
        let text = String::from_utf8_lossy(&line[1..line.len() - 2]).into_owned();
        let bad = || Error::new(ErrorKind::InvalidData, format!("Unexpected reply from Redis: {text}"));
        let number = text.parse::<i64>().map_err(|_| bad());
        Ok(match line[0] {
            b'+' => Reply::Text(text),
            b'-' => Reply::Error(text),
            b':' => Reply::Int(number?),
            b'$' | b'*' if number.as_ref().is_ok_and(|n| *n < 0) => Reply::Nil,
            b'$' => {
                let mut bytes = vec![0; number? as usize + 2];
                self.0.read_exact(&mut bytes)?;
                bytes.truncate(bytes.len() - 2);
                String::from_utf8(bytes).map_or_else(|e| Reply::Bytes(e.into_bytes()), Reply::Text)
            }
            b'*' => Reply::Array((0..number?).map(|_| self.read()).collect::<Result<_, _>>()?),
            _ => return Err(bad()),
        })
    }

    /// Sends one command and reads its reply. An error reply is an Err, as is a broken connection.
    fn call(&mut self, args: &[String]) -> Result<Reply, String> {
        self.send(&[args.to_vec()]).map_err(|e| e.to_string())?;
        match self.read().map_err(|e| e.to_string())? {
            Reply::Error(message) => Err(message),
            reply => Ok(reply),
        }
    }
}

/// Open connections by server, user, and database, so a click in the key list doesn't connect, negotiate TLS,
/// and sign in again. A connection is taken out while it's used, so concurrent calls never share one.
static REDIS_POOL: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, Vec<Redis>>>> = std::sync::LazyLock::new(Default::default);
/// Idle connections kept per server and database.
const REDIS_IDLE: usize = 4;

/// Runs `f` on a pooled connection, or a new one. A pooled connection the server has since closed, such as
/// after its idle timeout or the Mac's sleep, fails with an I/O error, and `f` runs again on a new one.
fn with_redis<T>(c: &Connection, mut f: impl FnMut(&mut Redis) -> std::io::Result<T>) -> Result<T, String> {
    let key = format!("{}|{}|{}|{}|{}|{}|{}|{}", c.host, c.port, c.username, c.password, c.database, c.ssl_mode, c.ssl_ca, c.read_timeout);
    let pooled = REDIS_POOL.lock().unwrap().get_mut(&key).and_then(Vec::pop);
    let give_back = |redis: Redis| {
        let mut pool = REDIS_POOL.lock().unwrap();
        let idle = pool.entry(key.clone()).or_default();
        if idle.len() < REDIS_IDLE {
            idle.push(redis);
        }
    };
    if let Some(mut redis) = pooled {
        if let Ok(value) = f(&mut redis) {
            give_back(redis);
            return Ok(value);
        }
    }
    let mut redis = Redis::open(c)?;
    let value = f(&mut redis).map_err(|e| e.to_string())?;
    give_back(redis);
    Ok(value)
}

/// A reply as JSON for the frontend: null, a string, a number, an array, `{"error": message}`, or, for bytes that
/// aren't text, `{"binary": length, "hex": the first 1,024 bytes}`.
fn reply_json(reply: &Reply) -> serde_json::Value {
    use serde_json::{json, Value};
    match reply {
        Reply::Nil => Value::Null,
        Reply::Text(s) => json!(s),
        Reply::Int(n) => json!(n),
        Reply::Error(e) => json!({ "error": e }),
        Reply::Bytes(b) => json!({ "binary": b.len(), "hex": b.iter().take(1024).map(|x| format!("{x:02x}")).collect::<String>() }),
        Reply::Array(items) => Value::Array(items.iter().map(reply_json).collect()),
    }
}

/// Runs Redis commands in one round trip and returns each reply, for the key browser. With `atomic`, they run in a
/// MULTI transaction: a command Redis refuses, such as one with a missing argument, discards them all.
#[tauri::command]
pub async fn redis_call(connection: Connection, commands: Vec<Vec<String>>, atomic: Option<bool>) -> Result<Vec<serde_json::Value>, String> {
    let atomic = atomic == Some(true);
    tauri::async_runtime::spawn_blocking(move || {
        let mut all = commands;
        if atomic {
            all.insert(0, vec!["MULTI".into()]);
            all.push(vec!["EXEC".into()]);
        }
        let mut replies = with_redis(&connection, |r| {
            r.send(&all)?;
            (0..all.len()).map(|_| r.read()).collect::<std::io::Result<Vec<_>>>()
        })?;
        if atomic {
            // MULTI's OK, a QUEUED per command, then EXEC's array of replies, or an error when a command was refused.
            return match replies.pop() {
                Some(Reply::Array(items)) => Ok(items.iter().map(reply_json).collect()),
                _ => Err(replies.iter().find_map(|r| if let Reply::Error(e) = r { Some(e.clone()) } else { None }).unwrap_or_else(|| "Redis discarded the transaction.".into())),
            };
        }
        Ok(replies.iter().map(reply_json).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A reply as a cell: a nested array reads as a JSON array, and bytes that aren't text by their length.
fn reply_text(reply: &Reply) -> Option<String> {
    match reply {
        Reply::Nil => None,
        Reply::Text(s) | Reply::Error(s) => Some(s.clone()),
        Reply::Bytes(b) => Some(format!("<binary, {} bytes>", b.len())),
        Reply::Int(n) => Some(n.to_string()),
        Reply::Array(items) => serde_json::to_string(&items.iter().map(reply_text).collect::<Vec<_>>()).ok(),
    }
}

/// Splits a command line into arguments as redis-cli does: whitespace separates them, double quotes take `\n`,
/// `\r`, `\t`, and `\` before any other character, and single quotes take text as it is, except `\'`.
fn split_command(line: &str) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    let mut chars = line.chars().peekable();
    loop {
        while chars.next_if(|c| c.is_whitespace()).is_some() {}
        let Some(&first) = chars.peek() else { return Ok(args) };
        let mut arg = String::new();
        if first == '"' || first == '\'' {
            chars.next();
            loop {
                match chars.next() {
                    None => return Err("The command has an unclosed quote.".into()),
                    Some(c) if c == first => break,
                    Some('\\') if first == '"' => match chars.next() {
                        Some('n') => arg.push('\n'),
                        Some('r') => arg.push('\r'),
                        Some('t') => arg.push('\t'),
                        Some(c) => arg.push(c),
                        None => return Err("The command has an unclosed quote.".into()),
                    },
                    Some('\\') if chars.peek() == Some(&'\'') => arg.push(chars.next().unwrap()),
                    Some(c) => arg.push(c),
                }
            }
        } else {
            while let Some(c) = chars.next_if(|c| !c.is_whitespace()) {
                arg.push(c);
            }
        }
        args.push(arg);
    }
}

/// Runs one Redis command. An array reply is a row per element, or per pair for replies that alternate names
/// and values, such as HGETALL's; an array of arrays, such as XRANGE's, is a row per inner array. SCAN follows
/// the cursor to the end, as `redis-cli --scan` does, and returns the keys sorted.
// ponytail: SCAN reads every matching key, and each page runs the command again; SCAN's cursor kept between
// pages if keyspaces of millions get slow.
fn redis(c: &Connection, command: &str, skip: u64) -> Result<QueryResult, String> {
    let args = split_command(command)?;
    let Some(name) = args.first().map(|a| a.to_uppercase()) else { return Err("Type a command.".into()) };
    let mut result = QueryResult { columns: vec!["value".into()], ..QueryResult::new(c, skip) };
    if name == "SCAN" {
        let mut keys = Vec::new();
        with_redis(c, |db| {
            keys.clear();
            let mut args = args.clone();
            loop {
                db.send(&[args.clone()])?;
                match db.read()? {
                    Reply::Array(mut reply) => match (reply.pop(), reply.pop()) {
                        (Some(Reply::Array(batch)), Some(Reply::Text(cursor))) => {
                            keys.extend(batch.iter().filter_map(reply_text));
                            if cursor == "0" {
                                return Ok(Ok(()));
                            }
                            args[1] = cursor;
                        }
                        _ => return Ok(Err("Unexpected reply to SCAN.".to_string())),
                    },
                    Reply::Error(e) => return Ok(Err(e)),
                    _ => return Ok(Err("Unexpected reply to SCAN.".to_string())),
                }
            }
        })??;
        keys.sort();
        result.columns = vec!["key".into()];
        keys.into_iter().for_each(|k| result.push(vec![Some(k)]));
        return Ok(result);
    }
    let has = |option: &str| args.iter().skip(1).any(|a| a.eq_ignore_ascii_case(option));
    let pairs = match name.as_str() {
        "HGETALL" => Some(["field", "value"]),
        "CONFIG" => Some(["parameter", "value"]),
        _ if has("WITHSCORES") => Some(["member", "score"]),
        _ if has("WITHVALUES") => Some(["field", "value"]),
        _ => None,
    };
    let reply = with_redis(c, |db| {
        db.send(&[args.clone()])?;
        db.read()
    })?;
    match reply {
        Reply::Error(e) => return Err(e),
        Reply::Array(items) if pairs.is_some() => {
            result.columns = pairs.unwrap().map(String::from).to_vec();
            items.chunks(2).for_each(|pair| result.push(pair.iter().map(reply_text).collect()));
        }
        Reply::Array(items) if !items.is_empty() && items.iter().all(|i| matches!(i, Reply::Array(_))) => {
            let rows: Vec<Vec<Option<String>>> = items.iter().map(|i| if let Reply::Array(a) = i { a.iter().map(reply_text).collect() } else { vec![] }).collect();
            let width = rows.iter().map(Vec::len).max().unwrap_or(0);
            result.columns = (1..=width).map(|i| i.to_string()).collect();
            for mut row in rows {
                row.resize(width, None);
                result.push(row);
            }
        }
        Reply::Array(items) => items.iter().for_each(|i| result.push(vec![reply_text(i)])),
        reply => result.push(vec![reply_text(&reply)]),
    }
    Ok(result)
}

/// Database passwords for connections saved in the editor live in the system's password store (the login Keychain
/// on macOS), by project and name.
const KEYCHAIN_SERVICE: &str = "Tusk database";

fn keychain(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn db_password(account: String) -> Option<String> {
    keychain(&account).ok()?.get_password().ok()
}

/// Saves a password, or deletes it when it's empty.
#[tauri::command(async)]
pub fn db_set_password(account: String, password: String) -> Result<(), String> {
    let entry = keychain(&account)?;
    if password.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(&password).map_err(|e| e.to_string())
}

/// SSH tunnels by destination and database address, with the local port each listens on.
#[derive(Default)]
pub struct Tunnels(std::sync::Mutex<std::collections::HashMap<String, (std::process::Child, u16)>>);

/// Forwards a free local port to `host:port` as seen from an SSH server, and returns the port. It runs the
/// system's `ssh`, so ~/.ssh/config, keys, and the agent apply; `destination` is anything `ssh` accepts, such
/// as `forge@203.0.113.5`, a host alias, or `ssh://user@host:2222`. A password prompt can't be answered here,
/// so it needs key or agent authentication. A running tunnel is reused, and every tunnel ends with the app.
#[tauri::command(async)]
pub fn db_tunnel(state: tauri::State<'_, Tunnels>, destination: String, host: String, port: u16, identity: Option<String>) -> Result<u16, String> {
    use std::process::Stdio;
    let identity = identity.filter(|i| !i.is_empty());
    let key = format!("{destination}|{host}|{port}|{}", identity.as_deref().unwrap_or(""));
    let mut tunnels = state.0.lock().unwrap();
    if let Some((child, local)) = tunnels.get_mut(&key) {
        if matches!(child.try_wait(), Ok(None)) {
            return Ok(*local);
        }
    }
    crate::login_path();
    let local = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map_err(|e| e.to_string())?.port();
    let mut child = crate::lsp::watched("ssh");
    let child = child
        // ServerAlive ends a tunnel whose connection died, such as after sleep, so the next query opens a new one.
        .args(["-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"])
        // A key file is the only key ssh offers, as with `ssh -i`; without one, the agent and ~/.ssh/config choose.
        .args(identity.iter().flat_map(|i| ["-i", i.as_str(), "-o", "IdentitiesOnly=yes"]))
        .arg("-L")
        .arg(format!("127.0.0.1:{local}:{host}:{port}"))
        .arg(&destination)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = crate::lsp::spawn_watched(child).map_err(|e| format!("Can't start ssh: {e}"))?;
    // Wait until the forward accepts connections, or ssh gives up.
    for _ in 0..150 {
        if let Ok(Some(_)) = child.try_wait() {
            let mut message = String::new();
            use std::io::Read;
            let _ = child.stderr.take().map(|mut e| e.read_to_string(&mut message));
            return Err(format!("SSH to {destination} failed: {}", message.trim()));
        }
        if std::net::TcpStream::connect(("127.0.0.1", local)).is_ok() {
            // Keep reading ssh's messages, such as a failed connection to the database, or its pipe fills and ssh stops.
            if let Some(mut stderr) = child.stderr.take() {
                std::thread::spawn(move || std::io::copy(&mut stderr, &mut std::io::sink()));
            }
            tunnels.insert(key, (child, local));
            return Ok(local);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let _ = child.kill();
    Err(format!("SSH to {destination} timed out."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_sqlite() {
        let path = std::env::temp_dir().join("php-editor-db-test.sqlite");
        let _ = std::fs::remove_file(&path);
        rusqlite::Connection::open(&path).unwrap();
        let c = Connection { driver: "sqlite".into(), host: String::new(), port: 0, database: path.to_string_lossy().into(), username: String::new(), password: String::new(), ssl_mode: String::new(), ssl_ca: String::new(), ..Default::default() };
        sqlite(&c, "CREATE TABLE t (id INTEGER, name TEXT)", 0, &None).unwrap();
        assert_eq!(sqlite(&c, "INSERT INTO t VALUES (1, 'a'), (2, NULL)", 0, &None).unwrap().affected, 2);
        let r = sqlite(&c, "SELECT * FROM t", 0, &None).unwrap();
        assert_eq!(r.columns, ["id", "name"]);
        assert_eq!(r.rows, [vec![Some("1".into()), Some("a".into())], vec![Some("2".into()), None]]);
        // A page from an offset still counts every row.
        let page = sqlite(&c, "SELECT id FROM t ORDER BY id", 1, &None).unwrap();
        assert_eq!((page.rows, page.total, page.truncated), (vec![vec![Some("2".into())]], 2, false));

        // A batch applies all its statements, or none when one fails.
        let batch = |statements: &[&str]| tauri::async_runtime::block_on(db_batch(Connection { database: c.database.clone(), driver: "sqlite".into(), host: String::new(), port: 0, username: String::new(), password: String::new(), ssl_mode: String::new(), ssl_ca: String::new(), ..Default::default() }, statements.iter().map(|s| s.to_string()).collect(), None));
        assert_eq!(batch(&["UPDATE t SET name = 'b' WHERE id = 1", "DELETE FROM t WHERE id = 2"]).unwrap(), [1, 1]);
        assert!(batch(&["INSERT INTO t VALUES (3, 'c')", "INSERT INTO missing VALUES (1)"]).is_err());
        assert_eq!(sqlite(&c, "SELECT count(*) FROM t", 0, &None).unwrap().rows, [vec![Some("1".into())]]);
        // A grid edit that matches no row undoes the others.
        let exact = tauri::async_runtime::block_on(db_batch(Connection { database: c.database.clone(), driver: "sqlite".into(), host: String::new(), port: 0, username: String::new(), password: String::new(), ssl_mode: String::new(), ssl_ca: String::new(), ..Default::default() }, vec!["DELETE FROM t WHERE id = 1".into(), "DELETE FROM t WHERE id = 99".into()], Some(true)));
        assert!(exact.unwrap_err().contains("change 2 of 2"));
        assert_eq!(sqlite(&c, "SELECT count(*) FROM t", 0, &None).unwrap().rows, [vec![Some("1".into())]]);
    }

    #[test]
    fn sqlite_limits_cancel_and_read_only() {
        let path = std::env::temp_dir().join("php-editor-db-cancel.sqlite");
        let _ = std::fs::remove_file(&path);
        rusqlite::Connection::open(&path).unwrap();
        let c = Connection { driver: "sqlite".into(), database: path.to_string_lossy().into(), page_size: 2, ..Default::default() };
        sqlite(&c, "CREATE TABLE t (id INTEGER, data BLOB)", 0, &None).unwrap();
        sqlite(&c, "INSERT INTO t VALUES (1, x'00ff'), (2, NULL), (3, NULL)", 0, &None).unwrap();
        // The page size comes from the connection, 0 for every row, and a blob reads as hex in a binary column.
        let r = sqlite(&c, "SELECT * FROM t ORDER BY id", 0, &None).unwrap();
        assert_eq!((r.rows.len(), r.truncated, r.total, r.binary.as_slice()), (2, true, 3, [1].as_slice()));
        assert_eq!(r.rows[0][1].as_deref(), Some("\\x00ff"));
        assert_eq!(sqlite(&Connection { page_size: 0, ..c.clone() }, "SELECT * FROM t", 0, &None).unwrap().rows.len(), 3);

        // Read-only refuses a write, in a query and in a batch.
        let read_only = Connection { read_only: true, ..c.clone() };
        assert!(sqlite(&read_only, "DELETE FROM t", 0, &None).err().unwrap().contains("readonly"));
        assert!(tauri::async_runtime::block_on(db_batch(read_only, vec!["DELETE FROM t".into()], None)).is_err());

        // A query that would run for minutes stops when it's canceled, with db_cancel's own error.
        let slow = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n";
        let id = "test-cancel".to_string();
        let started = std::time::Instant::now();
        let query = std::thread::spawn({
            let (c, id) = (c.clone(), id.clone());
            move || tauri::async_runtime::block_on(db_query(c, slow.into(), None, Some(id)))
        });
        while !matches!(RUNNING.lock().unwrap().get(&id), Some(Some(_))) {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(tauri::async_runtime::block_on(db_cancel(id.clone())).unwrap());
        assert_eq!(query.join().unwrap().err().as_deref(), Some(CANCELED));
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        // Canceling a query that has finished does nothing.
        assert!(!tauri::async_runtime::block_on(db_cancel(id)).unwrap());
    }

    /// Against throwaway servers: `docker run -e MYSQL_ROOT_PASSWORD=secret -e MYSQL_DATABASE=laravel -p 33066:3306 mysql:8`
    /// and `docker run -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=laravel -p 54329:5432 postgres:17`.
    #[test]
    #[ignore]
    fn queries_servers() {
        for (driver, port, user) in [("mysql", 33066, "root"), ("pgsql", 54329, "postgres")] {
            let c = Connection { driver: driver.into(), host: "127.0.0.1".into(), port, database: "laravel".into(), username: user.into(), password: "secret".into(), ssl_mode: String::new(), ssl_ca: String::new(), ..Default::default() };
            let run = |sql: &str| if driver == "mysql" { mysql(&c, sql, 0, &None) } else { pgsql(&c, sql, 0, &None) }.unwrap();
            run("DROP TABLE IF EXISTS t");
            run("CREATE TABLE t (id INTEGER, name TEXT, at TIMESTAMP NULL)");
            assert_eq!(run("INSERT INTO t VALUES (1, 'a', '2026-01-02 03:04:05'), (2, NULL, NULL)").affected, 2, "{driver}");
            let r = run("SELECT * FROM t ORDER BY id");
            assert_eq!(r.columns, ["id", "name", "at"], "{driver}");
            assert_eq!(r.rows, [vec![Some("1".into()), Some("a".into()), Some("2026-01-02 03:04:05".into())], vec![Some("2".into()), None, None]], "{driver}");

            let batch = |c: Connection, statements: &[&str]| tauri::async_runtime::block_on(db_batch(c, statements.iter().map(|s| s.to_string()).collect(), None));
            let again = || Connection { driver: driver.into(), host: "127.0.0.1".into(), port, database: "laravel".into(), username: user.into(), password: "secret".into(), ssl_mode: String::new(), ssl_ca: String::new(), ..Default::default() };
            assert_eq!(batch(again(), &["UPDATE t SET name = 'b' WHERE id = 1", "DELETE FROM t WHERE id = 2"]).unwrap(), [1, 1], "{driver}");
            assert!(batch(again(), &["DELETE FROM t", "INSERT INTO missing VALUES (1)"]).is_err(), "{driver}");
            assert_eq!(run("SELECT count(*) FROM t").rows, [vec![Some("1".into())]], "{driver}");
        }
        // MySQL 8 serves TLS with a certificate it made itself, which `require` accepts and `verify-full` refuses.
        let tls = |mode: &str| mysql(&Connection { driver: "mysql".into(), host: "127.0.0.1".into(), port: 33066, database: "laravel".into(), username: "root".into(), password: "secret".into(), ssl_mode: mode.into(), ssl_ca: String::new(), ..Default::default() }, "SHOW STATUS LIKE 'Ssl_cipher'", 0, &None);
        assert_ne!(tls("require").unwrap().rows[0][1], Some(String::new()));
        assert!(tls("verify-full").is_err());
    }

    /// Against the throwaway servers above, or others given as `TUSK_PGSQL=host:port:user:password` and
    /// `TUSK_MYSQL=…`. It changes nothing: it sleeps, and tries a write that read-only refuses.
    #[test]
    #[ignore]
    fn cancels_servers() {
        for (driver, variable, fallback, database, sleep) in [
            ("pgsql", "TUSK_PGSQL", "127.0.0.1:54329:postgres:secret", "postgres", "SELECT pg_sleep(30)"),
            ("mysql", "TUSK_MYSQL", "127.0.0.1:33066:root:secret", "laravel", "SELECT SLEEP(30)"),
        ] {
            let spec = std::env::var(variable).unwrap_or(fallback.into());
            let [host, port, user, password] = spec.splitn(4, ':').collect::<Vec<_>>()[..] else { panic!("{variable} is host:port:user:password") };
            let c = Connection { driver: driver.into(), host: host.into(), port: port.parse().unwrap(), database: database.into(), username: user.into(), password: password.into(), ..Default::default() };
            let read_only = Connection { read_only: true, ..c.clone() };
            let write = "CREATE TABLE tusk_read_only_test (id int)";
            let refused = if driver == "mysql" { mysql(&read_only, write, 0, &None) } else { pgsql(&read_only, write, 0, &None) };
            assert!(refused.err().unwrap().to_lowercase().contains("read"), "{driver}");
            let id = format!("test-cancel-{driver}");
            let started = std::time::Instant::now();
            let query = std::thread::spawn({
                let (c, id) = (c.clone(), id.clone());
                move || tauri::async_runtime::block_on(db_query(c, sleep.into(), None, Some(id)))
            });
            while !matches!(RUNNING.lock().unwrap().get(&id), Some(Some(_))) {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
            assert!(tauri::async_runtime::block_on(db_cancel(id)).unwrap(), "{driver}");
            assert_eq!(query.join().unwrap().err().as_deref(), Some(CANCELED), "{driver}");
            assert!(started.elapsed() < std::time::Duration::from_secs(5), "{driver}");
        }
    }

    #[test]
    fn splits_redis_commands() {
        assert_eq!(split_command(r#"  SET "a key" 'it\'s' "line\n\"two\"" "#).unwrap(), ["SET", "a key", "it's", "line\n\"two\""]);
        assert_eq!(split_command("GET laravel_cache:x").unwrap(), ["GET", "laravel_cache:x"]);
        assert!(split_command(r#"GET "open"#).is_err());
        assert!(split_command("  ").unwrap().is_empty());
    }

    /// Against a throwaway server: `docker run --rm -p 63799:6379 redis:7 --requirepass secret`.
    #[test]
    #[ignore]
    fn queries_redis() {
        let c = Connection { driver: "redis".into(), host: "127.0.0.1".into(), port: 63799, database: "2".into(), username: String::new(), password: "secret".into(), ssl_mode: String::new(), ssl_ca: String::new(), ..Default::default() };
        let run = |command: &str| redis(&c, command, 0).unwrap();
        run("FLUSHDB");
        assert_eq!(run(r#"SET "a key" "one two""#).rows, [vec![Some("OK".into())]]);
        assert_eq!(run(r#"GET "a key""#).rows, [vec![Some("one two".into())]]);
        assert_eq!(run("GET missing").rows, [vec![None]]);
        run("HSET h f1 v1 f2 v2");
        let hash = run("HGETALL h");
        assert_eq!((hash.columns.as_slice(), hash.rows.len()), (["field", "value"].map(String::from).as_slice(), 2));
        run("ZADD z 1 a 2 b");
        assert_eq!(run("ZRANGE z 0 -1 WITHSCORES").rows, [vec![Some("a".into()), Some("1".into())], vec![Some("b".into()), Some("2".into())]]);
        run("XADD s 1-1 f v");
        assert_eq!(run("XRANGE s - +").rows, [vec![Some("1-1".into()), Some(r#"["f","v"]"#.into())]]);
        // SCAN follows the cursor past the first batch, and a page skips into the sorted keys.
        for i in 0..250 {
            run(&format!("SET k{i:03} {i}"));
        }
        let keys = redis(&c, "SCAN 0 MATCH k* COUNT 10", 100).unwrap();
        assert_eq!((keys.total, keys.rows[0][0].as_deref()), (250, Some("k100")));
        assert!(redis(&c, "NOSUCHCOMMAND", 0).err().unwrap().contains("unknown command"));
        let wrong = Connection { password: "nope".into(), ..c.clone() };
        assert!(redis(&wrong, "PING", 0).is_err());

        // Pipelined calls return every reply, errors included; a transaction with a refused command applies nothing.
        let call = |commands: &[&[&str]], atomic: bool| {
            let commands = commands.iter().map(|c| c.iter().map(|s| s.to_string()).collect()).collect();
            tauri::async_runtime::block_on(redis_call(c.clone(), commands, Some(atomic)))
        };
        let replies = call(&[&["SET", "p", "1"], &["INCR", "p"], &["HGET", "p", "x"], &["GET", "none"]], false).unwrap();
        assert_eq!(replies[1], serde_json::json!(2));
        assert!(replies[2]["error"].as_str().unwrap().starts_with("WRONGTYPE"));
        assert_eq!(replies[3], serde_json::Value::Null);
        assert_eq!(call(&[&["SET", "p", "a"], &["SET", "q", "b"]], true).unwrap(), [serde_json::json!("OK"), serde_json::json!("OK")]);
        assert!(call(&[&["SET", "p", "changed"], &["SET", "q"]], true).unwrap_err().contains("wrong number of arguments"));
        assert_eq!(call(&[&["GET", "p"]], false).unwrap(), [serde_json::json!("a")]);
        // A value that isn't UTF-8 comes back as bytes, not mangled text.
        with_redis(&c, |r| {
            use std::io::Write;
            r.0.get_mut().write_all(b"*3\r\n$3\r\nSET\r\n$3\r\nbin\r\n$2\r\n\xff\xfe\r\n")?;
            r.read()
        })
        .unwrap();
        assert_eq!(call(&[&["GET", "bin"]], false).unwrap()[0], serde_json::json!({ "binary": 2, "hex": "fffe" }));
        // A pooled connection the server closed is replaced without an error.
        call(&[&["CLIENT", "KILL", "TYPE", "normal", "SKIPME", "no"]], false).ok();
        assert_eq!(call(&[&["PING"]], false).unwrap(), [serde_json::json!("PONG")]);
    }

    /// Writes to the login Keychain, so it runs only when asked.
    #[test]
    #[ignore]
    fn keychain_passwords() {
        let account = "tusk-test|staging".to_string();
        db_set_password(account.clone(), "p@ss".into()).unwrap();
        assert_eq!(db_password(account.clone()).as_deref(), Some("p@ss"));
        db_set_password(account.clone(), String::new()).unwrap();
        assert_eq!(db_password(account), None);
    }
}
