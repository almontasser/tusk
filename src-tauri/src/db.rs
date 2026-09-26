// Database queries for the database tool. The drivers are compiled in, so no client needs installing.
// Every value comes back as text (or null), which is all a results grid needs.
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
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
}

#[derive(Serialize, Default)]
pub struct QueryResult {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    affected: u64,
    truncated: bool,
    /// Every row the statement returned, including those skipped and those past the page.
    total: u64,
    /// Rows to skip before the page starts.
    #[serde(skip)]
    skip: u64,
}

/// Rows per page. `database.ts` asks for the next page with an offset.
const MAX_ROWS: usize = 1000;

impl QueryResult {
    fn push(&mut self, row: Vec<Option<String>>) {
        self.total += 1;
        if self.total <= self.skip {
            return;
        }
        if self.rows.len() < MAX_ROWS {
            self.rows.push(row);
        } else {
            self.truncated = true;
        }
    }
}

/// Runs one statement and returns a page of its rows, from `offset`, or the number of rows it changed.
// ponytail: connects for every query, and each page runs the statement again and reads every row, which the
// drivers do anyway (MySQL drains the rest, PostgreSQL's simple query buffers it); a server-side cursor on a
// kept connection if that gets slow on remote hosts.
#[tauri::command]
pub async fn db_query(connection: Connection, sql: String, offset: Option<u64>) -> Result<QueryResult, String> {
    let skip = offset.unwrap_or(0);
    tauri::async_runtime::spawn_blocking(move || match connection.driver.as_str() {
        "sqlite" => sqlite(&connection, &sql, skip),
        "mysql" | "mariadb" => mysql(&connection, &sql, skip),
        "pgsql" => pgsql(&connection, &sql, skip),
        "redis" => redis(&connection, &sql, skip),
        other => Err(format!("The {other} driver isn't supported.")),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs statements in one transaction, and returns how many rows each changed. If one fails, none apply. With
/// `one_row_each`, as for edits in the results grid, a statement that changes no row or several fails too.
#[tauri::command]
pub async fn db_batch(connection: Connection, statements: Vec<String>, one_row_each: Option<bool>) -> Result<Vec<u64>, String> {
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
    rusqlite::Connection::open_with_flags(&c.database, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|e| e.to_string())
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
        .pass(Some(&c.password));
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
    e.as_db_error().map_or_else(|| e.to_string(), |d| d.message().to_string())
}

/// Connects to PostgreSQL with libpq's sslmode, which Laravel defaults to `prefer`: try TLS, and fall back
/// to plain text. `prefer` and `require` don't check the certificate, `verify-ca` checks it but not the
/// host name, and `verify-full` checks both, against the system's authorities and `ssl_ca`.
fn open_pgsql(c: &Connection) -> Result<postgres::Client, String> {
    use postgres::config::SslMode;
    let mode = if c.ssl_mode.is_empty() { "prefer" } else { c.ssl_mode.as_str() };
    let connector = postgres_native_tls::MakeTlsConnector::new(tls_connector(c, mode)?);
    postgres::Config::new()
        .host(&c.host)
        .port(c.port)
        .dbname(&c.database)
        .user(&c.username)
        .password(&c.password)
        .ssl_mode(match mode {
            "disable" => SslMode::Disable,
            "prefer" | "allow" => SslMode::Prefer,
            _ => SslMode::Require,
        })
        .connect(connector)
        .map_err(pgsql_error)
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

fn sqlite(c: &Connection, sql: &str, skip: u64) -> Result<QueryResult, String> {
    use rusqlite::types::ValueRef;
    let err = |e: rusqlite::Error| e.to_string();
    let db = open_sqlite(c)?;
    let mut stmt = db.prepare(sql).map_err(err)?;
    let mut result = QueryResult { columns: stmt.column_names().iter().map(|s| s.to_string()).collect(), skip, ..Default::default() };
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

fn mysql(c: &Connection, sql: &str, skip: u64) -> Result<QueryResult, String> {
    use mysql::prelude::Queryable;
    let err = mysql_error;
    let mut conn = open_mysql(c)?;
    // The text protocol returns every value as bytes, so each cell reads as a string.
    let mut rows = conn.query_iter(sql).map_err(err)?;
    let mut result = QueryResult { affected: rows.affected_rows(), skip, ..Default::default() };
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

fn pgsql(c: &Connection, sql: &str, skip: u64) -> Result<QueryResult, String> {
    use postgres::SimpleQueryMessage;
    let err = pgsql_error;
    let mut client = open_pgsql(c)?;
    // The simple query protocol returns every value as text.
    let mut result = QueryResult { skip, ..Default::default() };
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

/// A Redis reply, as RESP2 sends it.
enum Reply {
    Nil,
    Text(String),
    Int(i64),
    Array(Vec<Reply>),
    Error(String),
}

trait Stream: std::io::Read + std::io::Write + Send {}
impl<T: std::io::Read + std::io::Write + Send> Stream for T {}

/// A Redis connection that speaks RESP2, which every Redis and Valkey version does. Values are read as text.
struct Redis(std::io::BufReader<Box<dyn Stream>>);

impl Redis {
    /// Connects, over TLS when `ssl_mode` is set (a `rediss://` URL), then signs in and selects `database`.
    fn open(c: &Connection) -> Result<Self, String> {
        let tcp = std::net::TcpStream::connect((c.host.as_str(), c.port)).map_err(|e| format!("Can't connect to {}:{}: {e}", c.host, c.port))?;
        // A blocking command, such as BLPOP, can't hold the query forever.
        let _ = tcp.set_read_timeout(Some(std::time::Duration::from_secs(60)));
        let stream: Box<dyn Stream> = match c.ssl_mode.as_str() {
            "" | "disable" => Box::new(tcp),
            mode => Box::new(tls_connector(c, mode)?.connect(&c.host, tcp).map_err(|e| e.to_string())?),
        };
        let mut redis = Redis(std::io::BufReader::new(stream));
        if !c.password.is_empty() {
            let auth = if c.username.is_empty() { vec!["AUTH".into(), c.password.clone()] } else { vec!["AUTH".into(), c.username.clone(), c.password.clone()] };
            redis.call(&auth)?;
        }
        if !matches!(c.database.as_str(), "" | "0") {
            redis.call(&["SELECT".into(), c.database.clone()])?;
        }
        Ok(redis)
    }

    /// Sends a command and reads its reply. An error reply is an Err.
    fn call(&mut self, args: &[String]) -> Result<Reply, String> {
        use std::io::Write;
        let mut command = format!("*{}\r\n", args.len()).into_bytes();
        for arg in args {
            command.extend(format!("${}\r\n{arg}\r\n", arg.len()).into_bytes());
        }
        self.0.get_mut().write_all(&command).map_err(|e| e.to_string())?;
        match self.read()? {
            Reply::Error(message) => Err(message),
            reply => Ok(reply),
        }
    }

    fn read(&mut self) -> Result<Reply, String> {
        use std::io::{BufRead, Read};
        let mut line = Vec::new();
        self.0.read_until(b'\n', &mut line).map_err(|e| e.to_string())?;
        if line.len() < 3 {
            return Err("Redis closed the connection.".into());
        }
        let text = String::from_utf8_lossy(&line[1..line.len() - 2]).into_owned();
        let number = text.parse::<i64>().map_err(|_| format!("Unexpected reply from Redis: {text}"));
        Ok(match line[0] {
            b'+' => Reply::Text(text),
            b'-' => Reply::Error(text),
            b':' => Reply::Int(number?),
            b'$' | b'*' if number.clone()? < 0 => Reply::Nil,
            b'$' => {
                let mut bytes = vec![0; number? as usize + 2];
                self.0.read_exact(&mut bytes).map_err(|e| e.to_string())?;
                Reply::Text(String::from_utf8_lossy(&bytes[..bytes.len() - 2]).into_owned())
            }
            b'*' => Reply::Array((0..number?).map(|_| self.read()).collect::<Result<_, _>>()?),
            _ => return Err(format!("Unexpected reply from Redis: {text}")),
        })
    }
}

/// A reply as a cell: a nested array reads as a JSON array.
fn reply_text(reply: &Reply) -> Option<String> {
    match reply {
        Reply::Nil => None,
        Reply::Text(s) | Reply::Error(s) => Some(s.clone()),
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
    let mut args = split_command(command)?;
    let Some(name) = args.first().map(|a| a.to_uppercase()) else { return Err("Type a command.".into()) };
    let mut db = Redis::open(c)?;
    let mut result = QueryResult { skip, columns: vec!["value".into()], ..Default::default() };
    if name == "SCAN" {
        let mut keys = Vec::new();
        loop {
            let Reply::Array(mut reply) = db.call(&args)? else { return Err("Unexpected reply to SCAN.".into()) };
            if let (Some(Reply::Array(batch)), Some(Reply::Text(cursor))) = (reply.pop(), reply.pop()) {
                keys.extend(batch.iter().filter_map(reply_text));
                if cursor == "0" {
                    break;
                }
                args[1] = cursor;
            } else {
                return Err("Unexpected reply to SCAN.".into());
            }
        }
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
    match db.call(&args)? {
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

/// Database passwords for connections saved in the editor live in the login Keychain, by project and name.
const KEYCHAIN_SERVICE: &str = "Tusk database";

#[tauri::command(async)]
pub fn db_password(account: String) -> Option<String> {
    security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, &account).ok().map(|p| String::from_utf8_lossy(&p).into())
}

/// Saves a password, or deletes it when it's empty.
#[tauri::command(async)]
pub fn db_set_password(account: String, password: String) -> Result<(), String> {
    use security_framework::passwords::{delete_generic_password, set_generic_password};
    if password.is_empty() {
        let _ = delete_generic_password(KEYCHAIN_SERVICE, &account);
        return Ok(());
    }
    set_generic_password(KEYCHAIN_SERVICE, &account, password.as_bytes()).map_err(|e| e.to_string())
}

/// SSH tunnels by destination and database address, with the local port each listens on.
#[derive(Default)]
pub struct Tunnels(std::sync::Mutex<std::collections::HashMap<String, (std::process::Child, u16)>>);

/// Forwards a free local port to `host:port` as seen from an SSH server, and returns the port. It runs the
/// system's `ssh`, so ~/.ssh/config, keys, and the agent apply; `destination` is anything `ssh` accepts, such
/// as `forge@203.0.113.5`, a host alias, or `ssh://user@host:2222`. A password prompt can't be answered here,
/// so it needs key or agent authentication. A running tunnel is reused, and every tunnel ends with the app.
#[tauri::command(async)]
pub fn db_tunnel(state: tauri::State<'_, Tunnels>, destination: String, host: String, port: u16) -> Result<u16, String> {
    use std::process::{Command, Stdio};
    let key = format!("{destination}|{host}|{port}");
    let mut tunnels = state.0.lock().unwrap();
    if let Some((child, local)) = tunnels.get_mut(&key) {
        if matches!(child.try_wait(), Ok(None)) {
            return Ok(*local);
        }
    }
    crate::login_path();
    let local = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map_err(|e| e.to_string())?.port();
    let mut child = Command::new("/bin/sh")
        // ServerAlive ends a tunnel whose connection died, such as after sleep, so the next query opens a new one.
        .args(["-c", crate::lsp::WATCHDOG, "sh", "ssh", "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"])
        .arg("-L")
        .arg(format!("127.0.0.1:{local}:{host}:{port}"))
        .arg(&destination)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Can't start ssh: {e}"))?;
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
        let c = Connection { driver: "sqlite".into(), host: String::new(), port: 0, database: path.to_string_lossy().into(), username: String::new(), password: String::new(), ssl_mode: String::new(), ssl_ca: String::new() };
        sqlite(&c, "CREATE TABLE t (id INTEGER, name TEXT)", 0).unwrap();
        assert_eq!(sqlite(&c, "INSERT INTO t VALUES (1, 'a'), (2, NULL)", 0).unwrap().affected, 2);
        let r = sqlite(&c, "SELECT * FROM t", 0).unwrap();
        assert_eq!(r.columns, ["id", "name"]);
        assert_eq!(r.rows, [vec![Some("1".into()), Some("a".into())], vec![Some("2".into()), None]]);
        // A page from an offset still counts every row.
        let page = sqlite(&c, "SELECT id FROM t ORDER BY id", 1).unwrap();
        assert_eq!((page.rows, page.total, page.truncated), (vec![vec![Some("2".into())]], 2, false));

        // A batch applies all its statements, or none when one fails.
        let batch = |statements: &[&str]| tauri::async_runtime::block_on(db_batch(Connection { database: c.database.clone(), driver: "sqlite".into(), host: String::new(), port: 0, username: String::new(), password: String::new(), ssl_mode: String::new(), ssl_ca: String::new() }, statements.iter().map(|s| s.to_string()).collect(), None));
        assert_eq!(batch(&["UPDATE t SET name = 'b' WHERE id = 1", "DELETE FROM t WHERE id = 2"]).unwrap(), [1, 1]);
        assert!(batch(&["INSERT INTO t VALUES (3, 'c')", "INSERT INTO missing VALUES (1)"]).is_err());
        assert_eq!(sqlite(&c, "SELECT count(*) FROM t", 0).unwrap().rows, [vec![Some("1".into())]]);
        // A grid edit that matches no row undoes the others.
        let exact = tauri::async_runtime::block_on(db_batch(Connection { database: c.database.clone(), driver: "sqlite".into(), host: String::new(), port: 0, username: String::new(), password: String::new(), ssl_mode: String::new(), ssl_ca: String::new() }, vec!["DELETE FROM t WHERE id = 1".into(), "DELETE FROM t WHERE id = 99".into()], Some(true)));
        assert!(exact.unwrap_err().contains("change 2 of 2"));
        assert_eq!(sqlite(&c, "SELECT count(*) FROM t", 0).unwrap().rows, [vec![Some("1".into())]]);
    }

    /// Against throwaway servers: `docker run -e MYSQL_ROOT_PASSWORD=secret -e MYSQL_DATABASE=laravel -p 33066:3306 mysql:8`
    /// and `docker run -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=laravel -p 54329:5432 postgres:17`.
    #[test]
    #[ignore]
    fn queries_servers() {
        for (driver, port, user) in [("mysql", 33066, "root"), ("pgsql", 54329, "postgres")] {
            let c = Connection { driver: driver.into(), host: "127.0.0.1".into(), port, database: "laravel".into(), username: user.into(), password: "secret".into(), ssl_mode: String::new(), ssl_ca: String::new() };
            let run = |sql: &str| if driver == "mysql" { mysql(&c, sql, 0) } else { pgsql(&c, sql, 0) }.unwrap();
            run("DROP TABLE IF EXISTS t");
            run("CREATE TABLE t (id INTEGER, name TEXT, at TIMESTAMP NULL)");
            assert_eq!(run("INSERT INTO t VALUES (1, 'a', '2026-01-02 03:04:05'), (2, NULL, NULL)").affected, 2, "{driver}");
            let r = run("SELECT * FROM t ORDER BY id");
            assert_eq!(r.columns, ["id", "name", "at"], "{driver}");
            assert_eq!(r.rows, [vec![Some("1".into()), Some("a".into()), Some("2026-01-02 03:04:05".into())], vec![Some("2".into()), None, None]], "{driver}");

            let batch = |c: Connection, statements: &[&str]| tauri::async_runtime::block_on(db_batch(c, statements.iter().map(|s| s.to_string()).collect(), None));
            let again = || Connection { driver: driver.into(), host: "127.0.0.1".into(), port, database: "laravel".into(), username: user.into(), password: "secret".into(), ssl_mode: String::new(), ssl_ca: String::new() };
            assert_eq!(batch(again(), &["UPDATE t SET name = 'b' WHERE id = 1", "DELETE FROM t WHERE id = 2"]).unwrap(), [1, 1], "{driver}");
            assert!(batch(again(), &["DELETE FROM t", "INSERT INTO missing VALUES (1)"]).is_err(), "{driver}");
            assert_eq!(run("SELECT count(*) FROM t").rows, [vec![Some("1".into())]], "{driver}");
        }
        // MySQL 8 serves TLS with a certificate it made itself, which `require` accepts and `verify-full` refuses.
        let tls = |mode: &str| mysql(&Connection { driver: "mysql".into(), host: "127.0.0.1".into(), port: 33066, database: "laravel".into(), username: "root".into(), password: "secret".into(), ssl_mode: mode.into(), ssl_ca: String::new() }, "SHOW STATUS LIKE 'Ssl_cipher'", 0);
        assert_ne!(tls("require").unwrap().rows[0][1], Some(String::new()));
        assert!(tls("verify-full").is_err());
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
        let c = Connection { driver: "redis".into(), host: "127.0.0.1".into(), port: 63799, database: "2".into(), username: String::new(), password: "secret".into(), ssl_mode: String::new(), ssl_ca: String::new() };
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
        let wrong = Connection { password: "nope".into(), ..c };
        assert!(redis(&wrong, "PING", 0).is_err());
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
