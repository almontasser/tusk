//! Deployment: files to and from a server over SFTP, FTP, or FTPS, as PhpStorm's Deployment does.
//!
//! The frontend (src/deploy.ts) keeps the servers and their mappings, and queues one transfer per file; this module
//! connects, lists, transfers, and compares. Connections are pooled per server and reused while they live, so a
//! queue of small files doesn't log in for each one. SFTP goes through russh, a pure-Rust SSH client, and checks the
//! server's key against ~/.ssh/known_hosts as `ssh` does; FTPS checks certificates with the system's trust store.
//! Passwords and key passphrases stay in the system's password store, read here, never sent to the web view.
//!
//! Uploads go to a temporary name beside the file and are renamed over it once complete, so a site never serves
//! half a file; the replaced file's permissions carry over. Downloads do the same on disk.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use globset::{Glob, GlobSet, GlobSetBuilder};
use russh::keys::{PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::{Deserialize, Serialize};
use suppaftp::tokio::{AsyncRustlsConnector, AsyncRustlsFtpStream};
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const KEYCHAIN_SERVICE: &str = "Tusk deployment";
const CHUNK: usize = 256 * 1024;
/// Files of the same size whose times differ are compared byte by byte up to this size; larger ones count as changed.
const COMPARE_LIMIT: u64 = 4 * 1024 * 1024;

/// A server as the frontend describes it. `secret` is a password typed into the settings and not saved yet;
/// otherwise the password or key passphrase comes from the password store under `account`.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    protocol: String,
    host: String,
    port: u16,
    #[serde(default)]
    user: String,
    #[serde(default)]
    auth: String,
    #[serde(default)]
    key_file: String,
    #[serde(default = "yes")]
    passive: bool,
    #[serde(default)]
    insecure_tls: bool,
    #[serde(default)]
    account: String,
    #[serde(default)]
    secret: Option<String>,
}

fn yes() -> bool {
    true
}

impl Server {
    /// What identifies a connection in the pool: everything that changes how it logs in.
    fn key(&self) -> String {
        format!("{}|{}|{}|{}|{}|{}|{}|{}|{}", self.protocol, self.host, self.port, self.user, self.auth, self.key_file, self.passive, self.insecure_tls, self.account)
    }
    fn secret(&self) -> String {
        self.secret.clone().unwrap_or_else(|| (!self.account.is_empty()).then(|| keychain(&self.account).ok()?.get_password().ok()).flatten().unwrap_or_default())
    }
    fn is_sftp(&self) -> bool {
        self.protocol == "sftp"
    }
}

/// A file or folder on the server. `mtime` is in seconds since 1970, `mode` the Unix permissions when known.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Entry {
    name: String,
    dir: bool,
    link: bool,
    size: u64,
    mtime: i64,
    mode: Option<u32>,
    /// The owner and group, on SFTP, so a replaced file keeps them.
    #[serde(skip)]
    owner: Option<(u32, u32)>,
}

/// A file found under a mapping's folder, on either side, by its path relative to that folder.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FileInfo {
    path: String,
    size: u64,
    mtime: i64,
}

// ---- Errors ----

/// An error as the settings and toasts show it: what failed, in words, rather than the library's variant name.
fn friendly(e: impl std::fmt::Display) -> String {
    let text = e.to_string();
    let lower = text.to_lowercase();
    if lower.contains("connection refused") {
        "The server refused the connection. Check the host and port, and that the server is running.".into()
    } else if lower.contains("failed to lookup") || lower.contains("nodename nor servname") || lower.contains("name or service not known") || lower.contains("no such host") {
        "Can't find that host. Check its name.".into()
    } else if lower.contains("timed out") || lower.contains("elapsed") {
        "The server didn't answer in time. Check the host, the port, and your network.".into()
    } else if lower.contains("530") || lower.contains("login incorrect") {
        "The server refused the user name or password.".into()
    } else if lower.contains("certificate") || lower.contains("invalid peer") {
        format!("The server's TLS certificate isn't trusted: {text}. For a self-signed certificate, turn off certificate checks in the server's settings.")
    } else {
        text
    }
}

/// An SFTP status as words, with the path it was about.
fn sftp_err(path: &str) -> impl Fn(russh_sftp::client::error::Error) -> String + '_ {
    move |e| {
        let text = e.to_string();
        if text.contains("No such file") {
            format!("{path} doesn't exist on the server")
        } else if text.contains("Permission denied") {
            format!("The server doesn't allow that for {path}: permission denied")
        } else if text.contains("Failure") {
            // SFTP's generic failure, such as creating a folder that exists or a full disk.
            format!("The server refused the change to {path}")
        } else {
            format!("{path}: {text}")
        }
    }
}

/// Whether an error says a path isn't there: SFTP's "no such file", or FTP's 550, or 501 from servers that
/// answer a missing folder with it.
fn missing(e: &str) -> bool {
    e.contains("doesn't exist") || e.contains("550") || e.contains("[501]")
}

fn ftp_err(path: &str) -> impl Fn(suppaftp::FtpError) -> String + '_ {
    move |e| {
        let text = e.to_string();
        if text.contains("550") {
            format!("{path}: the server refused it (550: no such file, or permission denied)")
        } else {
            format!("{path}: {}", friendly(text))
        }
    }
}

// ---- Host keys ----

/// The SSH client's side of the handshake: it checks the server's key against ~/.ssh/known_hosts, and records why
/// it refused one, for `connect` to report. `host` and `port` are what known_hosts keeps the key under: the
/// server's, or its HostKeyAlias with no port, as ssh does; `shown` names the server for the trust dialog.
struct Client {
    host: String,
    port: u16,
    shown: String,
    alias: Option<String>,
    refusal: Arc<std::sync::Mutex<Option<String>>>,
}

/// Why a key was refused, as JSON the frontend reads to ask whether to trust it: `host-key:{…}`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostKeyProblem {
    kind: &'static str,
    host: String,
    port: u16,
    shown: String,
    alias: Option<String>,
    algorithm: String,
    fingerprint: String,
    key: String,
    line: Option<usize>,
}

impl russh::client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = match server_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => PublicKey::new(cert.public_key().clone(), ""),
        };
        let problem = |kind, line| {
            let p = HostKeyProblem {
                kind,
                host: self.host.clone(),
                port: self.port,
                shown: self.shown.clone(),
                alias: self.alias.clone(),
                algorithm: key.algorithm().to_string(),
                fingerprint: key.fingerprint(Default::default()).to_string(),
                key: key.to_openssh().unwrap_or_default(),
                line,
            };
            format!("host-key:{}", serde_json::to_string(&p).unwrap_or_default())
        };
        let refusal = match russh::keys::check_known_hosts_path(&self.host, self.port, &key, known_hosts()) {
            Ok(true) => return Ok(true),
            Ok(false) => problem("unknown", None),
            Err(russh::keys::Error::KeyChanged { line }) => problem("changed", Some(line)),
            Err(e) => format!("Can't read ~/.ssh/known_hosts: {e}"),
        };
        *self.refusal.lock().unwrap() = Some(refusal);
        Ok(false)
    }
}

/// Trusts a server's key: adds it to ~/.ssh/known_hosts, first removing the entry it replaces (`line`, numbered as
/// russh numbers known_hosts: comment lines don't count) when the key changed.
#[tauri::command(async)]
pub fn deploy_trust_host(host: String, port: u16, key: String, line: Option<usize>) -> Result<(), String> {
    let key = PublicKey::from_openssh(&key).map_err(|e| e.to_string())?;
    let path = known_hosts();
    if let Some(line) = line {
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        std::fs::write(&path, without_entry(&text, line)).map_err(|e| e.to_string())?;
    }
    let dir = path.parent().ok_or("No folder")?;
    if !dir.exists() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    russh::keys::known_hosts::learn_known_hosts_path(&host, port, &key, &path).map_err(|e| format!("Can't write {}: {e}", path.display()))
}

/// ~/.ssh/known_hosts, which `ssh` reads too; tests point TUSK_KNOWN_HOSTS elsewhere.
fn known_hosts() -> PathBuf {
    std::env::var_os("TUSK_KNOWN_HOSTS").map(PathBuf::from).unwrap_or_else(|| std::env::home_dir().unwrap_or_default().join(".ssh").join("known_hosts"))
}

/// known_hosts' text without entry `line`, counting lines as russh does: comment lines aren't counted.
fn without_entry(text: &str, line: usize) -> String {
    let mut n = 1;
    let mut out = String::with_capacity(text.len());
    for l in text.split_inclusive('\n') {
        if l.starts_with('#') {
            out.push_str(l);
            continue;
        }
        if n != line {
            out.push_str(l);
        }
        n += 1;
    }
    out
}

// ---- Connections ----

enum Conn {
    /// `_jumps` keeps the ProxyJump hosts' connections open, which the session's runs through, and `_proxy` the
    /// ProxyCommand that carries it, which stops when the connection is dropped.
    Sftp { ssh: russh::client::Handle<Client>, sftp: SftpSession, _jumps: Vec<russh::client::Handle<Client>>, _proxy: Option<tokio::process::Child> },
    Ftp { ftp: AsyncRustlsFtpStream, mlsd: Option<bool> },
}

struct Idle {
    conn: Conn,
    since: Instant,
}

static POOL: LazyLock<Mutex<HashMap<String, Vec<Idle>>>> = LazyLock::new(Default::default);

/// A connection for `server`: an idle one that's still alive, or a new one.
async fn take(server: &Server) -> Result<Conn, String> {
    loop {
        let idle = POOL.lock().await.get_mut(&server.key()).and_then(Vec::pop);
        let Some(mut idle) = idle else { break };
        let alive = match &mut idle.conn {
            Conn::Sftp { ssh, .. } => !ssh.is_closed(),
            // FTP servers drop idle logins after a few minutes; a NOOP finds out without a data connection.
            Conn::Ftp { ftp, .. } => idle.since.elapsed() < Duration::from_secs(15) || ftp.noop().await.is_ok(),
        };
        if alive {
            return Ok(idle.conn);
        }
    }
    tokio::time::timeout(CONNECT_TIMEOUT, connect(server)).await.map_err(|_| format!("{}:{} didn't answer within {} seconds. Check the host, the port, and your network.", server.host, server.port, CONNECT_TIMEOUT.as_secs()))?
}

/// Puts a connection back for the next transfer. One that failed is dropped instead, since its state is unknown.
async fn give_back(server: &Server, conn: Conn) {
    POOL.lock().await.entry(server.key()).or_default().push(Idle { conn, since: Instant::now() });
}

/// Runs `f` on a pooled connection, returning the connection only when `f` succeeded.
macro_rules! with_conn {
    ($server:expr, |$conn:ident| $body:expr) => {{
        let server: &Server = $server;
        let mut conn = take(server).await?;
        let result = {
            let $conn = &mut conn;
            $body
        };
        if result.is_ok() {
            give_back(server, conn).await;
        }
        result
    }};
}

async fn connect(server: &Server) -> Result<Conn, String> {
    if server.host.trim().is_empty() {
        return Err("Type the server's host.".into());
    }
    if server.is_sftp() {
        connect_sftp(server).await
    } else {
        connect_ftp(server).await
    }
}

async fn connect_sftp(server: &Server) -> Result<Conn, String> {
    use crate::sshconfig::{expand, parse_jump, resolve, Tokens};
    // A host that's an alias in ~/.ssh/config connects as ssh would: to its HostName, port, and user, with its
    // keys, through its jump hosts or its ProxyCommand. Settings typed here win over the file's.
    let cfg = resolve(&server.host);
    let host = cfg.host_name.clone().unwrap_or_else(|| server.host.clone());
    let port = if server.port == 22 { cfg.port.unwrap_or(22) } else { server.port };
    let user = if server.user.is_empty() { cfg.user.clone().unwrap_or_else(whoami) } else { server.user.clone() };
    let mut jumps: Vec<russh::client::Handle<Client>> = Vec::new();
    let mut proxy = None;
    for spec in &cfg.proxy_jump {
        let (jump_user, alias, jump_port) = parse_jump(spec);
        let jump = resolve(&alias);
        let jump_host = jump.host_name.clone().unwrap_or_else(|| alias.clone());
        let jump_user = jump_user.or_else(|| jump.user.clone()).unwrap_or_else(whoami);
        let jump_port = jump_port.or(jump.port).unwrap_or(22);
        // Later hops go through the one before; the first can have a ProxyCommand of its own.
        let via = match (jumps.last(), &jump.proxy_command) {
            (Some(previous), _) => Via::Jump(previous),
            (None, Some(command)) => Via::Command(expand(command, &Tokens { host_name: &jump_host, original: &alias, user: &jump_user, port: jump_port })),
            (None, None) => Via::Direct,
        };
        let (mut handle, child) = handshake(&jump_host, jump_port, jump.host_key_alias.as_deref(), via).await.map_err(|e| if e.starts_with("host-key:") { e } else { format!("Can't reach the jump host {alias}: {e}") })?;
        proxy = child.or(proxy);
        hop_login(&mut handle, &server.host, &alias, &jump_host, jump_port, &jump_user, &jump).await?;
        jumps.push(handle);
    }
    let via = match (jumps.last(), &cfg.proxy_command) {
        (Some(jump), _) => Via::Jump(jump),
        (None, Some(command)) => Via::Command(expand(command, &Tokens { host_name: &host, original: &server.host, user: &user, port })),
        (None, None) => Via::Direct,
    };
    let (mut ssh, child) = handshake(&host, port, cfg.host_key_alias.as_deref(), via).await?;
    proxy = child.or(proxy);
    let ok = match server.auth.as_str() {
        "password" => password_auth(&mut ssh, &user, &server.secret()).await?,
        // As ssh does, the config's key files follow the agent's keys.
        "agent" => agent_auth(&mut ssh, &user).await? || (!cfg.identity_files.is_empty() && files_auth(&mut ssh, &user, &key_files(&cfg, ""), "").await?),
        _ => files_auth(&mut ssh, &user, &key_files(&cfg, &server.key_file), &server.secret()).await?,
    };
    if !ok {
        return Err(match server.auth.as_str() {
            "password" => format!("The server refused the password for {user}."),
            "agent" => format!("The server refused every key your SSH agent offered for {user}."),
            _ => format!("The server refused the key for {user}."),
        });
    }
    let channel = ssh.channel_open_session().await.map_err(friendly)?;
    channel.request_subsystem(true, "sftp").await.map_err(friendly)?;
    let sftp = SftpSession::new(channel.into_stream()).await.map_err(|e| format!("The server has no SFTP: {e}"))?;
    sftp.set_timeout(60);
    Ok(Conn::Sftp { ssh, sftp, _jumps: jumps, _proxy: proxy })
}

/// How an SSH connection reaches its server: over the network, through a jump host, or through a ProxyCommand's
/// input and output.
enum Via<'a> {
    Direct,
    Jump(&'a russh::client::Handle<Client>),
    Command(String),
}

/// Opens an SSH connection to `host` and checks the server's key, under `alias` in known_hosts when there's a
/// HostKeyAlias. A ProxyCommand's process comes back with it, to keep while the connection lives.
async fn handshake(host: &str, port: u16, alias: Option<&str>, via: Via<'_>) -> Result<(russh::client::Handle<Client>, Option<tokio::process::Child>), String> {
    let config = Arc::new(russh::client::Config { keepalive_interval: Some(Duration::from_secs(30)), ..Default::default() });
    let refusal = Arc::new(std::sync::Mutex::new(None));
    let shown = if port == 22 { host.to_string() } else { format!("{host}:{port}") };
    let (key_host, key_port) = alias.map_or((host, port), |a| (a, 22));
    let client = Client { host: key_host.to_string(), port: key_port, shown, alias: alias.map(String::from), refusal: refusal.clone() };
    let refused = |e: russh::Error| refusal.lock().unwrap().take().unwrap_or_else(|| friendly(e));
    match via {
        Via::Direct => russh::client::connect(config, (host, port), client).await.map(|h| (h, None)).map_err(refused),
        Via::Jump(jump) => {
            let channel = jump.channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0).await.map_err(|e| format!("The jump host couldn't reach {host}:{port}: {}", friendly(e)))?;
            russh::client::connect_stream(config, channel.into_stream(), client).await.map(|h| (h, None)).map_err(refused)
        }
        Via::Command(command) => {
            let (mut child, stream, stderr) = spawn_proxy(&command)?;
            match russh::client::connect_stream(config, stream, client).await {
                Ok(handle) => Ok((handle, Some(child))),
                Err(e) => {
                    // The command's own words say more than the SSH error, such as nc's "Connection refused".
                    let _ = tokio::time::timeout(Duration::from_millis(300), child.wait()).await;
                    let said = stderr.lock().unwrap().trim().to_string();
                    let error = refused(e);
                    Err(if error.starts_with("host-key:") { error } else if said.is_empty() { format!("The ProxyCommand ({command}) didn't connect to {host}: {error}") } else { format!("The ProxyCommand ({command}) failed: {said}") })
                }
            }
        }
    }
}

/// Starts a ProxyCommand as ssh does, with the shell, and gives its output and input as one stream. What it prints
/// to its error output is kept, up to a few lines, to say why it failed.
fn spawn_proxy(command: &str) -> Result<(tokio::process::Child, impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static, Arc<std::sync::Mutex<String>>), String> {
    use std::process::Stdio;
    let mut shell = crate::toolpaths::command("/bin/sh");
    shell.args(["-c", &format!("exec {command}")]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut shell = tokio::process::Command::from(shell);
    shell.kill_on_drop(true);
    let mut child = shell.spawn().map_err(|e| format!("Can't start the ProxyCommand {command}: {e}"))?;
    let (Some(stdout), Some(stdin), Some(mut stderr)) = (child.stdout.take(), child.stdin.take(), child.stderr.take()) else { return Err("The ProxyCommand has no input or output".into()) };
    let said = Arc::new(std::sync::Mutex::new(String::new()));
    let keep = said.clone();
    tokio::spawn(async move {
        let mut buf = [0; 1024];
        while let Ok(n) = stderr.read(&mut buf).await {
            if n == 0 {
                break;
            }
            let mut said = keep.lock().unwrap();
            if said.len() < 2000 {
                said.push_str(&String::from_utf8_lossy(&buf[..n]));
            }
        }
    });
    Ok((child, tokio::io::join(stdout, stdin), said))
}

/// Logs in with a key, with RSA's best hash the server supports.
async fn try_key(ssh: &mut russh::client::Handle<Client>, user: &str, key: russh::keys::PrivateKey) -> Result<bool, String> {
    let hash = if key.algorithm().is_rsa() { ssh.best_supported_rsa_hash().await.map_err(friendly)?.flatten() } else { None };
    Ok(ssh.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await.map_err(friendly)?.success())
}

/// Logs in with a password: SSH's `password` method, or keyboard-interactive, which servers that check passwords
/// with PAM often offer instead, answering each of its prompts with the password.
async fn password_auth(ssh: &mut russh::client::Handle<Client>, user: &str, password: &str) -> Result<bool, String> {
    use russh::client::{AuthResult, KeyboardInteractiveAuthResponse as Reply};
    let methods = match ssh.authenticate_password(user, password).await.map_err(friendly)? {
        AuthResult::Success => return Ok(true),
        AuthResult::Failure { remaining_methods, .. } => remaining_methods,
    };
    if !methods.contains(&russh::MethodKind::KeyboardInteractive) {
        return Ok(false);
    }
    let mut reply = ssh.authenticate_keyboard_interactive_start(user, None::<String>).await.map_err(friendly)?;
    // A server asks a round or two of questions; more than a few means it wants more than a password.
    for _ in 0..4 {
        reply = match reply {
            Reply::Success => return Ok(true),
            Reply::Failure { .. } => return Ok(false),
            Reply::InfoRequest { prompts, .. } => ssh.authenticate_keyboard_interactive_respond(prompts.iter().map(|_| password.to_string()).collect()).await.map_err(friendly)?,
        };
    }
    Ok(false)
}

/// What a jump host needs that Tusk doesn't have, as JSON the frontend reads to ask for it: `ssh-login:{…}`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginNeeded {
    /// The server the connection is for.
    target: String,
    /// The jump host's name in ProxyJump, and where it connects.
    hop: String,
    host: String,
    port: u16,
    user: String,
    /// Where the secret is saved in the password store.
    account: String,
    /// "password", or "passphrase" for the key file `key`.
    kind: &'static str,
    key: Option<String>,
    /// Whether the saved secret was refused.
    wrong: bool,
}

/// Logs in to a jump host as ssh would: with the agent's keys, then its key files. A key with a passphrase, or a
/// host that asks for a password, takes the secret saved for this user and host; without one, or when it's
/// refused, the error asks the frontend for it (`ssh-login:{…}`), which saves it and connects again.
async fn hop_login(ssh: &mut russh::client::Handle<Client>, target: &str, hop: &str, host: &str, port: u16, user: &str, cfg: &crate::sshconfig::HostConfig) -> Result<(), String> {
    use russh::client::AuthResult;
    use russh::MethodKind;
    let account = format!("ssh:{user}@{host}:{port}");
    let saved = stored_secret(&account);
    let methods = match ssh.authenticate_none(user).await.map_err(friendly)? {
        AuthResult::Success => return Ok(()),
        AuthResult::Failure { remaining_methods, .. } => remaining_methods,
    };
    let mut locked = Vec::new();
    if methods.contains(&MethodKind::PublicKey) {
        if agent_auth(ssh, user).await.unwrap_or(false) {
            return Ok(());
        }
        for (file, _) in key_files(cfg, "") {
            match load_key(&file, "") {
                Ok(key) => {
                    if try_key(ssh, user, key).await? {
                        return Ok(());
                    }
                }
                Err(e) if e.contains("has a passphrase") => locked.push(file),
                Err(_) => {}
            }
        }
        if let Some(secret) = &saved {
            for file in &locked {
                if let Ok(key) = load_key(file, secret) {
                    if try_key(ssh, user, key).await? {
                        return Ok(());
                    }
                }
            }
        }
    }
    let takes_password = methods.contains(&MethodKind::Password) || methods.contains(&MethodKind::KeyboardInteractive);
    if takes_password {
        if let Some(secret) = &saved {
            if password_auth(ssh, user, secret).await? {
                return Ok(());
            }
        }
    }
    let kind = if !locked.is_empty() {
        "passphrase"
    } else if takes_password {
        "password"
    } else {
        return Err(format!("The jump host {hop} refused every key for {user}. Add a key for it to your SSH agent or to ~/.ssh/config."));
    };
    let needed = LoginNeeded { target: target.into(), hop: hop.into(), host: host.into(), port, user: user.into(), account, kind, key: locked.first().map(crate::slash), wrong: saved.is_some() };
    Err(format!("ssh-login:{}", serde_json::to_string(&needed).unwrap_or_default()))
}

pub(crate) fn whoami() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default()
}

/// The key files to try, as ssh tries them: the one chosen in the settings; else the config's IdentityFile ones,
/// then ~/.ssh's usual keys unless IdentitiesOnly says not to. `true` marks a file that must be readable.
fn key_files(cfg: &crate::sshconfig::HostConfig, chosen: &str) -> Vec<(PathBuf, bool)> {
    let home = std::env::home_dir().unwrap_or_default();
    if !chosen.is_empty() {
        return vec![(PathBuf::from(chosen.replacen('~', &home.to_string_lossy(), 1)), true)];
    }
    let mut files: Vec<(PathBuf, bool)> = cfg.identity_files.iter().map(|f| (PathBuf::from(f), false)).collect();
    if !cfg.identities_only {
        files.extend(["id_ed25519", "id_ecdsa", "id_rsa"].iter().map(|n| (home.join(".ssh").join(n), false)));
    }
    let mut seen = std::collections::HashSet::new();
    files.retain(|(p, must)| (*must || p.exists()) && seen.insert(p.clone()));
    files
}

/// Logs in with key files: OpenSSH keys, or PuTTY's .ppk (versions 2 and 3). A key that needs a passphrase
/// that wasn't given is skipped, and named if nothing else gets in.
async fn files_auth(ssh: &mut russh::client::Handle<Client>, user: &str, files: &[(PathBuf, bool)], passphrase: &str) -> Result<bool, String> {
    if files.is_empty() {
        return Err("There's no key in ~/.ssh or in ~/.ssh/config for this host. Choose a key file, or log in with your SSH agent.".into());
    }
    let mut locked = None;
    for (file, must) in files {
        let key = match load_key(file, passphrase) {
            Ok(key) => key,
            Err(e) if e.contains("has a passphrase") => {
                locked.get_or_insert(e);
                continue;
            }
            Err(e) if !must => {
                eprintln!("deploy: skipping {}: {e}", file.display());
                continue;
            }
            Err(e) => return Err(e),
        };
        if try_key(ssh, user, key).await? {
            return Ok(true);
        }
    }
    match locked {
        Some(e) => Err(e),
        None => Ok(false),
    }
}

/// A private key from a file, with errors in words.
fn load_key(file: &Path, passphrase: &str) -> Result<russh::keys::PrivateKey, String> {
    let ppk = std::fs::read(file).is_ok_and(|b| b.starts_with(b"PuTTY-User-Key-File-"));
    match russh::keys::load_secret_key(file, (!passphrase.is_empty()).then_some(passphrase)) {
        Ok(key) => Ok(key),
        Err(russh::keys::Error::KeyIsEncrypted) => Err(format!("{} has a passphrase. Type it in the server's settings.", file.display())),
        Err(e) if passphrase.is_empty() && e.to_string().to_lowercase().contains("encrypted") => Err(format!("{} has a passphrase. Type it in the server's settings.", file.display())),
        Err(e) if ppk => Err(format!("Can't read the PuTTY key {}: {e}. A wrong passphrase reads as a corrupt key; otherwise, convert it with PuTTYgen's Conversions > Export OpenSSH key.", file.display())),
        Err(e) => Err(format!("Can't read {}: {e}. A wrong passphrase reads as a corrupt key.", file.display())),
    }
}

/// Logs in with each key the SSH agent holds: SSH_AUTH_SOCK's, or on Windows, OpenSSH's agent or Pageant.
async fn agent_auth(ssh: &mut russh::client::Handle<Client>, user: &str) -> Result<bool, String> {
    #[cfg(unix)]
    {
        let agent = russh::keys::agent::client::AgentClient::connect_env().await.map_err(|e| format!("Can't reach your SSH agent: {e}. Start it, or log in with a key file."))?;
        agent_keys(ssh, user, agent).await
    }
    #[cfg(windows)]
    {
        use russh::keys::agent::client::AgentClient;
        if let Ok(agent) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            if agent_keys(ssh, user, agent).await? {
                return Ok(true);
            }
        }
        let agent = AgentClient::connect_pageant().await.map_err(|e| format!("Can't reach an SSH agent (OpenSSH's or Pageant): {e}"))?;
        agent_keys(ssh, user, agent).await
    }
}

async fn agent_keys<S>(ssh: &mut russh::client::Handle<Client>, user: &str, mut agent: russh::keys::agent::client::AgentClient<S>) -> Result<bool, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let identities = agent.request_identities().await.map_err(|e| format!("Your SSH agent didn't list its keys: {e}"))?;
    if identities.is_empty() {
        return Err("Your SSH agent has no keys. Add one with ssh-add, or log in with a key file.".into());
    }
    for identity in identities {
        let russh::keys::agent::AgentIdentity::PublicKey { key, .. } = identity else { continue };
        let hash = if key.algorithm().is_rsa() { ssh.best_supported_rsa_hash().await.map_err(friendly)?.flatten() } else { None };
        if let Ok(result) = ssh.authenticate_publickey_with(user, key, hash, &mut agent).await {
            if result.success() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

async fn connect_ftp(server: &Server) -> Result<Conn, String> {
    let address = (server.host.as_str(), server.port);
    let tls = || -> Result<AsyncRustlsConnector, String> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let builder = rustls::ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions().map_err(|e| e.to_string())?;
        let config = if server.insecure_tls {
            builder.dangerous().with_custom_certificate_verifier(Arc::new(AnyCertificate)).with_no_client_auth()
        } else {
            use rustls_platform_verifier::BuilderVerifierExt;
            builder.with_platform_verifier().map_err(|e| e.to_string())?.with_no_client_auth()
        };
        Ok(AsyncRustlsConnector::from(tokio_rustls::TlsConnector::from(Arc::new(config))))
    };
    let mut ftp = match server.protocol.as_str() {
        "ftps-implicit" => {
            let mut ftp = AsyncRustlsFtpStream::connect_secure_implicit(address, tls()?, &server.host).await.map_err(friendly)?;
            // suppaftp wraps data connections in TLS but, unlike after AUTH TLS, doesn't tell the server to: without
            // PROT P, servers send listings and files in plain text, or refuse them.
            for command in ["PBSZ 0", "PROT P"] {
                ftp.custom_command(command, &[suppaftp::Status::CommandOk]).await.map_err(|e| format!("The server didn't accept {command} for encrypted transfers: {}", friendly(e)))?;
            }
            ftp
        }
        "ftps" => {
            let plain = AsyncRustlsFtpStream::connect(address).await.map_err(friendly)?;
            plain.into_secure(tls()?, &server.host).await.map_err(|e| format!("The server didn't start TLS: {}. If it has no FTPS, choose FTP.", friendly(e)))?
        }
        _ => AsyncRustlsFtpStream::connect(address).await.map_err(friendly)?,
    };
    if !server.passive {
        ftp = ftp.active_mode(Duration::from_secs(30));
    } else {
        // Servers behind NAT often announce a private address for passive mode; connect to the host's instead.
        ftp.set_passive_nat_workaround(true);
    }
    let user = if server.user.is_empty() { "anonymous".to_string() } else { server.user.clone() };
    ftp.login(user.as_str(), server.secret().as_str()).await.map_err(|e| {
        let text = e.to_string();
        if text.contains("530") { format!("The server refused the user name or password for {user}.") } else { friendly(text) }
    })?;
    ftp.transfer_type(suppaftp::types::FileType::Binary).await.map_err(friendly)?;
    Ok(Conn::Ftp { ftp, mlsd: None })
}

/// Accepts any certificate, for servers with a self-signed one, when the server's settings say so.
#[derive(Debug)]
struct AnyCertificate;

impl rustls::client::danger::ServerCertVerifier for AnyCertificate {
    fn verify_server_cert(&self, _: &rustls::pki_types::CertificateDer<'_>, _: &[rustls::pki_types::CertificateDer<'_>], _: &rustls::pki_types::ServerName<'_>, _: &[u8], _: rustls::pki_types::UnixTime) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, message: &[u8], cert: &rustls::pki_types::CertificateDer<'_>, dss: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &rustls::pki_types::CertificateDer<'_>, dss: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider().signature_verification_algorithms.supported_schemes()
    }
}

// ---- Remote paths ----

fn parent(path: &str) -> &str {
    match path.trim_end_matches('/').rfind('/') {
        Some(0) => "/",
        Some(i) => &path[..i],
        None => ".",
    }
}

fn name_of(path: &str) -> &str {
    let path = path.trim_end_matches('/');
    &path[path.rfind('/').map_or(0, |i| i + 1)..]
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() || dir == "." {
        name.to_string()
    } else if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

fn secs(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

// ---- Operations on one connection ----

impl Conn {
    async fn list(&mut self, dir: &str) -> Result<Vec<Entry>, String> {
        match self {
            Conn::Sftp { sftp, .. } => {
                let entries = sftp.read_dir(dir).await.map_err(sftp_err(dir))?;
                Ok(entries
                    .map(|e| {
                        let m = e.metadata();
                        Entry { name: e.file_name(), dir: m.is_dir(), link: m.is_symlink(), size: m.size.unwrap_or(0), mtime: m.mtime.unwrap_or(0) as i64, mode: m.permissions.map(|p| p & 0o7777), owner: m.uid.zip(m.gid) }
                    })
                    .filter(|e| e.name != "." && e.name != "..")
                    .collect())
            }
            Conn::Ftp { ftp, mlsd } => {
                // MLSD gives exact times and sizes; servers without it, such as vsftpd, get LIST.
                if *mlsd != Some(false) {
                    match ftp.mlsd(Some(dir)).await {
                        Ok(lines) => {
                            *mlsd = Some(true);
                            return Ok(lines.iter().filter_map(|l| suppaftp::list::ListParser::parse_mlsd(l).ok()).map(ftp_entry).filter(|e| e.name != "." && e.name != "..").collect());
                        }
                        Err(e) if mlsd.is_none() && ["[500]", "[502]", "[504]"].iter().any(|c| e.to_string().contains(c)) => *mlsd = Some(false),
                        Err(e) => return Err(ftp_err(dir)(e)),
                    }
                }
                let lines = ftp.list(Some(dir)).await.map_err(ftp_err(dir))?;
                Ok(lines.iter().filter_map(|l| suppaftp::list::File::try_from(l.as_str()).ok()).map(ftp_entry).filter(|e| e.name != "." && e.name != "..").collect())
            }
        }
    }

    /// A file or folder's details, or None when it doesn't exist.
    async fn stat(&mut self, path: &str) -> Result<Option<Entry>, String> {
        match self {
            Conn::Sftp { sftp, .. } => match sftp.metadata(path).await {
                Ok(m) => Ok(Some(Entry { name: name_of(path).into(), dir: m.is_dir(), link: m.is_symlink(), size: m.size.unwrap_or(0), mtime: m.mtime.unwrap_or(0) as i64, mode: m.permissions.map(|p| p & 0o7777), owner: m.uid.zip(m.gid) })),
                Err(e) if e.to_string().contains("No such file") => Ok(None),
                Err(e) => Err(sftp_err(path)(e)),
            },
            Conn::Ftp { .. } => {
                let name = name_of(path).to_string();
                match self.list(parent(path)).await {
                    Ok(entries) => Ok(entries.into_iter().find(|e| e.name == name)),
                    Err(e) if missing(&e) => Ok(None),
                    Err(e) => Err(e),
                }
            }
        }
    }

    /// Creates a folder and the folders above it that are missing.
    async fn mkdir_all(&mut self, dir: &str) -> Result<(), String> {
        if dir.is_empty() || dir == "/" || dir == "." {
            return Ok(());
        }
        if let Some(e) = self.stat(dir).await? {
            return if e.dir || e.link { Ok(()) } else { Err(format!("{dir} is a file on the server, not a folder")) };
        }
        Box::pin(self.mkdir_all(parent(dir))).await?;
        let created = match self {
            Conn::Sftp { sftp, .. } => sftp.create_dir(dir).await.map_err(sftp_err(dir)),
            Conn::Ftp { ftp, .. } => ftp.mkdir(dir).await.map_err(ftp_err(dir)),
        };
        // Transfers into one new folder run side by side, so another may have just created it.
        match created {
            Err(_) if self.stat(dir).await?.is_some_and(|e| e.dir || e.link) => Ok(()),
            other => other,
        }
    }

    async fn rename(&mut self, from: &str, to: &str) -> Result<(), String> {
        match self {
            Conn::Sftp { sftp, .. } => sftp.rename(from, to).await.map_err(sftp_err(from)),
            Conn::Ftp { ftp, .. } => ftp.rename(from, to).await.map_err(ftp_err(from)),
        }
    }

    async fn remove_file(&mut self, path: &str) -> Result<(), String> {
        match self {
            Conn::Sftp { sftp, .. } => sftp.remove_file(path).await.map_err(sftp_err(path)),
            Conn::Ftp { ftp, .. } => ftp.rm(path).await.map_err(ftp_err(path)),
        }
    }

    /// Removes a file, or a folder with everything in it.
    async fn remove(&mut self, path: &str, dir: bool) -> Result<(), String> {
        if !dir {
            return self.remove_file(path).await;
        }
        for e in self.list(path).await? {
            Box::pin(self.remove(&join(path, &e.name), e.dir && !e.link)).await?;
        }
        match self {
            Conn::Sftp { sftp, .. } => sftp.remove_dir(path).await.map_err(sftp_err(path)),
            Conn::Ftp { ftp, .. } => ftp.rmdir(path).await.map_err(ftp_err(path)),
        }
    }

    /// Sets a file's modification time and permissions, and on SFTP its owner and group, where the server allows
    /// it. Failures don't matter: a later comparison reads the contents when the times differ, and a server that
    /// doesn't let you give a file away keeps you as its owner.
    async fn set_attrs(&mut self, path: &str, mtime: i64, mode: Option<u32>, owner: Option<(u32, u32)>) {
        match self {
            Conn::Sftp { sftp, .. } => {
                let attrs = FileAttributes { atime: Some(mtime as u32), mtime: Some(mtime as u32), permissions: mode, ..FileAttributes::empty() };
                if sftp.set_metadata(path, attrs).await.is_err() && mode.is_some() {
                    let _ = sftp.set_metadata(path, FileAttributes { permissions: mode, ..FileAttributes::empty() }).await;
                }
                let Some((uid, gid)) = owner else { return };
                let Ok(now) = sftp.metadata(path).await else { return };
                if now.uid == Some(uid) && now.gid == Some(gid) {
                    return;
                }
                // Only root can change the owner; anyone can change the group to one of their own.
                if sftp.set_metadata(path, FileAttributes { uid: Some(uid), gid: Some(gid), ..FileAttributes::empty() }).await.is_err() && now.gid != Some(gid) {
                    if let Some(me) = now.uid {
                        let _ = sftp.set_metadata(path, FileAttributes { uid: Some(me), gid: Some(gid), ..FileAttributes::empty() }).await;
                    }
                }
            }
            Conn::Ftp { ftp, .. } => {
                if let Some(time) = chrono_utc(mtime) {
                    let _ = ftp.custom_command(format!("MFMT {time} {path}"), &[suppaftp::Status::File]).await;
                }
                if let Some(mode) = mode {
                    let _ = ftp.site(format!("CHMOD {:o} {path}", mode & 0o7777)).await;
                }
            }
        }
    }

    /// Uploads `local` to `remote` through a temporary name, so the old file stays whole until the new one is.
    async fn upload(&mut self, local: &Path, remote: &str, progress: &(dyn Fn(u64, u64) + Sync), cancel: &AtomicBool) -> Result<(), String> {
        let meta = tokio::fs::metadata(local).await.map_err(|e| format!("Can't read {}: {e}", local.display()))?;
        let total = meta.len();
        let mtime = meta.modified().map(secs).unwrap_or_else(|_| now());
        self.mkdir_all(parent(remote)).await?;
        let existing = self.stat(remote).await?;
        if existing.as_ref().is_some_and(|e| e.dir) {
            return Err(format!("{remote} is a folder on the server"));
        }
        let temp = join(parent(remote), &format!(".{}.tusk-upload", name_of(remote)));
        // A folder that only allows changing existing files can't take a temporary file: write in place.
        let target = match self.write(local, &temp, total, progress, cancel).await {
            Ok(()) => temp.clone(),
            Err(e) if e.contains("permission denied") || e.contains("550") => {
                self.write(local, remote, total, progress, cancel).await?;
                remote.to_string()
            }
            Err(e) => {
                let _ = self.remove_file(&temp).await;
                return Err(e);
            }
        };
        let mode = existing.as_ref().and_then(|e| e.mode);
        self.set_attrs(&target, mtime, mode, existing.as_ref().and_then(|e| e.owner)).await;
        if target == remote {
            return Ok(());
        }
        if existing.is_none() {
            return self.rename(&temp, remote).await;
        }
        // SFTP's rename won't replace a file, and some FTP servers' won't either: move the old one aside first,
        // and back if the new one can't take its place.
        if self.rename(&temp, remote).await.is_ok() {
            return Ok(());
        }
        let old = join(parent(remote), &format!(".{}.tusk-old", name_of(remote)));
        let _ = self.remove_file(&old).await;
        if let Err(e) = self.rename(remote, &old).await {
            let _ = self.remove_file(&temp).await;
            return Err(e);
        }
        if let Err(e) = self.rename(&temp, remote).await {
            let _ = self.rename(&old, remote).await;
            let _ = self.remove_file(&temp).await;
            return Err(e);
        }
        let _ = self.remove_file(&old).await;
        Ok(())
    }

    async fn write(&mut self, local: &Path, remote: &str, total: u64, progress: &(dyn Fn(u64, u64) + Sync), cancel: &AtomicBool) -> Result<(), String> {
        let mut file = tokio::fs::File::open(local).await.map_err(|e| format!("Can't read {}: {e}", local.display()))?;
        let mut buf = vec![0; CHUNK];
        let mut done = 0;
        progress(0, total);
        match self {
            Conn::Sftp { sftp, .. } => {
                let mut out = sftp.open_with_flags(remote, OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE).await.map_err(sftp_err(remote))?;
                loop {
                    if cancel.load(Ordering::Relaxed) {
                        let _ = out.shutdown().await;
                        return Err("Canceled".into());
                    }
                    let n = file.read(&mut buf).await.map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    out.write_all(&buf[..n]).await.map_err(|e| format!("{remote}: {e}"))?;
                    done += n as u64;
                    progress(done, total);
                }
                out.shutdown().await.map_err(|e| format!("{remote}: {e}"))
            }
            Conn::Ftp { ftp, .. } => {
                let mut out = ftp.put_with_stream(remote).await.map_err(ftp_err(remote))?;
                loop {
                    if cancel.load(Ordering::Relaxed) {
                        // The data connection is mid-transfer; the caller drops this connection.
                        return Err("Canceled".into());
                    }
                    let n = file.read(&mut buf).await.map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    out.write_all(&buf[..n]).await.map_err(|e| format!("{remote}: {e}"))?;
                    done += n as u64;
                    progress(done, total);
                }
                out.finish().await.map_err(ftp_err(remote))
            }
        }
    }

    /// Downloads `remote` into `local`, through a temporary file beside it, and gives it the server's time.
    async fn download(&mut self, remote: &str, local: &Path, progress: &(dyn Fn(u64, u64) + Sync), cancel: &AtomicBool) -> Result<(), String> {
        let entry = self.stat(remote).await?.ok_or_else(|| format!("{remote} doesn't exist on the server"))?;
        if entry.dir {
            return Err(format!("{remote} is a folder"));
        }
        let dir = local.parent().ok_or("No folder")?;
        tokio::fs::create_dir_all(dir).await.map_err(|e| format!("Can't create {}: {e}", dir.display()))?;
        let temp = dir.join(format!(".{}.tusk-download", local.file_name().unwrap_or_default().to_string_lossy()));
        let result = self.read_into(remote, &temp, entry.size, progress, cancel).await;
        if let Err(e) = result {
            let _ = tokio::fs::remove_file(&temp).await;
            return Err(e);
        }
        if let Ok(f) = std::fs::File::options().write(true).open(&temp) {
            let _ = f.set_modified(UNIX_EPOCH + Duration::from_secs(entry.mtime.max(0) as u64));
        }
        // Keep the local file's permissions, such as an executable script's.
        if let Ok(old) = std::fs::metadata(local) {
            let _ = std::fs::set_permissions(&temp, old.permissions());
        }
        tokio::fs::rename(&temp, local).await.map_err(|e| format!("Can't replace {}: {e}", local.display()))
    }

    async fn read_into(&mut self, remote: &str, local: &Path, total: u64, progress: &(dyn Fn(u64, u64) + Sync), cancel: &AtomicBool) -> Result<(), String> {
        let mut out = tokio::fs::File::create(local).await.map_err(|e| format!("Can't write {}: {e}", local.display()))?;
        let mut buf = vec![0; CHUNK];
        let mut done = 0;
        progress(0, total);
        match self {
            Conn::Sftp { sftp, .. } => {
                let mut input = sftp.open(remote).await.map_err(sftp_err(remote))?;
                loop {
                    if cancel.load(Ordering::Relaxed) {
                        return Err("Canceled".into());
                    }
                    let n = input.read(&mut buf).await.map_err(|e| format!("{remote}: {e}"))?;
                    if n == 0 {
                        break;
                    }
                    out.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
                    done += n as u64;
                    progress(done, total);
                }
            }
            Conn::Ftp { ftp, .. } => {
                let mut input = ftp.retr_as_stream(remote).await.map_err(ftp_err(remote))?;
                loop {
                    if cancel.load(Ordering::Relaxed) {
                        return Err("Canceled".into());
                    }
                    let n = input.read(&mut buf).await.map_err(|e| format!("{remote}: {e}"))?;
                    if n == 0 {
                        break;
                    }
                    out.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
                    done += n as u64;
                    progress(done, total);
                }
                input.finish().await.map_err(ftp_err(remote))?;
            }
        }
        out.flush().await.map_err(|e| e.to_string())
    }

    /// A file's contents, up to `limit` bytes.
    async fn read(&mut self, remote: &str, limit: u64) -> Result<Vec<u8>, String> {
        let mut data = Vec::new();
        match self {
            Conn::Sftp { sftp, .. } => {
                let input = sftp.open(remote).await.map_err(sftp_err(remote))?;
                input.take(limit + 1).read_to_end(&mut data).await.map_err(|e| format!("{remote}: {e}"))?;
            }
            Conn::Ftp { ftp, .. } => {
                let mut input = ftp.retr_as_stream(remote).await.map_err(ftp_err(remote))?;
                (&mut input).take(limit + 1).read_to_end(&mut data).await.map_err(|e| format!("{remote}: {e}"))?;
                if data.len() as u64 > limit {
                    return Err(format!("{remote} is larger than {} MB", limit / 1024 / 1024));
                }
                input.finish().await.map_err(ftp_err(remote))?;
            }
        }
        if data.len() as u64 > limit {
            return Err(format!("{remote} is larger than {} MB", limit / 1024 / 1024));
        }
        Ok(data)
    }

    /// Every file under `dir`, by path relative to it, leaving out what `excludes` matches. Exclusions are relative
    /// to a mapping's folder, which is `prefix` above `dir`. Symbolic links to folders aren't followed.
    async fn walk(&mut self, dir: &str, excludes: &Excludes, prefix: &str, cancel: &AtomicBool) -> Result<Vec<FileInfo>, String> {
        let mut files = Vec::new();
        let mut pending = vec![String::new()];
        while let Some(rel) = pending.pop() {
            if cancel.load(Ordering::Relaxed) {
                return Err("Canceled".into());
            }
            let entries = match self.list(&join(dir, &rel)).await {
                Ok(entries) => entries,
                Err(e) if rel.is_empty() && missing(&e) => return Ok(files),
                Err(e) => return Err(e),
            };
            for e in entries {
                let path = if rel.is_empty() { e.name.clone() } else { format!("{rel}/{}", e.name) };
                if excludes.matches(&if prefix.is_empty() { path.clone() } else { format!("{prefix}/{path}") }) || e.name.ends_with(".tusk-upload") || e.name.ends_with(".tusk-old") {
                    continue;
                }
                if e.dir && !e.link {
                    pending.push(path);
                } else if !e.dir {
                    files.push(FileInfo { path, size: e.size, mtime: e.mtime });
                }
            }
        }
        Ok(files)
    }
}

/// MFMT's time: YYYYMMDDHHMMSS in UTC.
fn chrono_utc(t: i64) -> Option<String> {
    if t <= 0 {
        return None;
    }
    let days = t.div_euclid(86_400);
    let rem = t.rem_euclid(86_400);
    // Howard Hinnant's days-to-civil algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    Some(format!("{y:04}{m:02}{d:02}{:02}{:02}{:02}", rem / 3600, rem % 3600 / 60, rem % 60))
}

fn ftp_entry(f: suppaftp::list::File) -> Entry {
    use suppaftp::list::PosixPexQuery::{Group, Others, Owner};
    let bits = |who| u32::from(f.can_read(who)) << 2 | u32::from(f.can_write(who)) << 1 | u32::from(f.can_execute(who));
    let mode = bits(Owner) << 6 | bits(Group) << 3 | bits(Others);
    Entry { name: f.name().to_string(), dir: f.is_directory(), link: f.is_symlink(), size: f.size() as u64, mtime: secs(f.modified()), mode: (mode != 0).then_some(mode), owner: None }
}

// ---- Exclusions ----

/// Paths a mapping leaves out, as globs relative to its folder. A pattern without `/`, such as `node_modules` or
/// `*.log`, matches a name at any depth, as in .gitignore; one with `/`, such as `storage/logs`, matches from the
/// mapping's folder. Either leaves out everything inside a folder it matches.
pub struct Excludes(GlobSet);

impl Excludes {
    pub fn new(patterns: &[String]) -> Excludes {
        let mut set = GlobSetBuilder::new();
        for p in patterns.iter().map(|p| p.trim().trim_matches('/')).filter(|p| !p.is_empty()) {
            let base = if p.contains('/') { p.to_string() } else { format!("**/{p}") };
            for g in [base.clone(), format!("{base}/**")] {
                if let Ok(glob) = Glob::new(&g) {
                    set.add(glob);
                }
            }
        }
        Excludes(set.build().unwrap_or_else(|_| GlobSet::empty()))
    }
    pub fn matches(&self, rel: &str) -> bool {
        !rel.is_empty() && self.0.is_match(rel)
    }
}

/// Files under `root` from `paths` (files, or folders taken whole), relative to `root`, without excluded ones.
fn local_files(root: &Path, paths: &[String], excludes: &Excludes) -> Vec<FileInfo> {
    let mut files = Vec::new();
    let mut pending: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    while let Some(path) = pending.pop() {
        let Ok(rel) = path.strip_prefix(root) else { continue };
        let rel = crate::slash(rel);
        if excludes.matches(&rel) {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if meta.is_dir() {
            if let Ok(dir) = std::fs::read_dir(&path) {
                pending.extend(dir.flatten().map(|e| e.path()));
            }
        } else if let Some(meta) = std::fs::metadata(&path).ok().filter(|m| m.is_file()) {
            files.push(FileInfo { path: rel, size: meta.len(), mtime: meta.modified().map(secs).unwrap_or(0) });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
}

// ---- Comparing ----

/// How a file differs between the project and the server.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Difference {
    path: String,
    /// "local": only in the project; "remote": only on the server; "changed": in both, with other contents.
    kind: &'static str,
    /// Which copy changed last, by time: "local", "remote", or "" when the times can't tell.
    newer: &'static str,
    local: Option<FileInfo>,
    remote: Option<FileInfo>,
}

/// Times closer than this count as the same: FAT keeps two-second times, and FTP servers round.
const SAME_TIME: i64 = 2;

/// The files that differ, and the ones whose sizes match but times don't (`unsure`), whose contents decide.
fn diff(local: &[FileInfo], remote: &[FileInfo]) -> (Vec<Difference>, Vec<Difference>) {
    let remote_by: HashMap<&str, &FileInfo> = remote.iter().map(|f| (f.path.as_str(), f)).collect();
    let local_by: HashMap<&str, &FileInfo> = local.iter().map(|f| (f.path.as_str(), f)).collect();
    let newer = |l: &FileInfo, r: &FileInfo| if l.mtime > r.mtime + SAME_TIME { "local" } else if r.mtime > l.mtime + SAME_TIME { "remote" } else { "" };
    let mut sure = Vec::new();
    let mut unsure = Vec::new();
    for l in local {
        match remote_by.get(l.path.as_str()) {
            None => sure.push(Difference { path: l.path.clone(), kind: "local", newer: "local", local: Some(l.clone()), remote: None }),
            Some(r) => {
                let d = Difference { path: l.path.clone(), kind: "changed", newer: newer(l, r), local: Some(l.clone()), remote: Some((*r).clone()) };
                if l.size != r.size {
                    sure.push(d);
                } else if d.newer != "" {
                    unsure.push(d);
                }
            }
        }
    }
    for r in remote {
        if !local_by.contains_key(r.path.as_str()) {
            sure.push(Difference { path: r.path.clone(), kind: "remote", newer: "remote", local: None, remote: Some(r.clone()) });
        }
    }
    sure.sort_by(|a, b| a.path.cmp(&b.path));
    (sure, unsure)
}

// ---- Cancellation ----

static CANCELS: LazyLock<std::sync::Mutex<HashMap<u32, Arc<AtomicBool>>>> = LazyLock::new(Default::default);

/// A flag that `deploy_cancel(id)` raises, removed again when the guard drops.
struct CancelGuard(u32, Arc<AtomicBool>);

impl CancelGuard {
    fn new(id: u32) -> CancelGuard {
        let flag = Arc::new(AtomicBool::new(false));
        CANCELS.lock().unwrap().insert(id, flag.clone());
        CancelGuard(id, flag)
    }
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        CANCELS.lock().unwrap().remove(&self.0);
    }
}

#[tauri::command]
pub fn deploy_cancel(id: u32) {
    if let Some(flag) = CANCELS.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Progress of a transfer, at most about ten times a second: bytes done and the total.
fn reporter(channel: Channel<(u64, u64)>) -> impl Fn(u64, u64) + Sync {
    let last = std::sync::Mutex::new(Instant::now() - Duration::from_secs(1));
    move |done, total| {
        let mut last = last.lock().unwrap();
        if done == total || last.elapsed() >= Duration::from_millis(100) {
            *last = Instant::now();
            let _ = channel.send((done, total));
        }
    }
}

// ---- Commands ----

/// Connects and logs in, and reports what the server is and whether `root` exists there.
#[tauri::command]
pub async fn deploy_test(server: Server, root: String) -> Result<String, String> {
    // A test always connects anew, so changed settings and a fixed network count.
    POOL.lock().await.remove(&server.key());
    let started = Instant::now();
    let mut conn = tokio::time::timeout(CONNECT_TIMEOUT, connect(&server)).await.map_err(|_| format!("{}:{} didn't answer within {} seconds. Check the host, the port, and your network.", server.host, server.port, CONNECT_TIMEOUT.as_secs()))??;
    let what = match &conn {
        Conn::Sftp { .. } => "SFTP".to_string(),
        Conn::Ftp { ftp, .. } => ftp.get_welcome_msg().map(|m| m.lines().next().unwrap_or("").trim().trim_start_matches("220").trim_start_matches('-').trim().to_string()).filter(|m| !m.is_empty()).unwrap_or_else(|| "FTP".into()),
    };
    let ms = started.elapsed().as_millis();
    if !root.is_empty() {
        match conn.stat(&root).await? {
            Some(e) if e.dir || e.link => {}
            Some(_) => return Err(format!("Connected, but the root path {root} is a file, not a folder.")),
            None => return Err(format!("Connected, but the root path {root} doesn't exist on the server.")),
        }
    }
    give_back(&server, conn).await;
    Ok(format!("{what} · {ms} ms"))
}

/// The server's starting folder, for browsing a server without a root path.
#[tauri::command]
pub async fn deploy_home(server: Server) -> Result<String, String> {
    with_conn!(&server, |conn| match conn {
        Conn::Sftp { sftp, .. } => sftp.canonicalize(".").await.map_err(|e| e.to_string()),
        Conn::Ftp { ftp, .. } => ftp.pwd().await.map_err(friendly),
    })
}

#[tauri::command]
pub async fn deploy_list(server: Server, path: String) -> Result<Vec<Entry>, String> {
    let mut entries = with_conn!(&server, |conn| conn.list(&path).await)?;
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

#[tauri::command]
pub async fn deploy_mkdir(server: Server, path: String) -> Result<(), String> {
    with_conn!(&server, |conn| conn.mkdir_all(&path).await)
}

#[tauri::command]
pub async fn deploy_rename(server: Server, from: String, to: String) -> Result<(), String> {
    with_conn!(&server, |conn| async {
        if conn.stat(&to).await?.is_some() {
            return Err(format!("{} already exists", name_of(&to)));
        }
        conn.rename(&from, &to).await
    }
    .await)
}

#[tauri::command]
pub async fn deploy_remove(server: Server, path: String, dir: bool) -> Result<(), String> {
    with_conn!(&server, |conn| conn.remove(&path, dir).await)
}

/// A file or folder's details on the server, or None when it isn't there.
#[tauri::command]
pub async fn deploy_stat(server: Server, path: String) -> Result<Option<Entry>, String> {
    with_conn!(&server, |conn| conn.stat(&path).await)
}

/// Deletes files and folders (with what's in them) from the server, leaving out ones already gone, then the
/// folders in `prune` that are left empty, deepest first. Returns how many were there to delete; stops at the
/// first that can't be.
#[tauri::command]
pub async fn deploy_delete(server: Server, paths: Vec<String>, prune: Option<Vec<String>>) -> Result<usize, String> {
    with_conn!(&server, |conn| async {
        let mut deleted = 0;
        for path in &paths {
            if let Some(e) = conn.stat(path).await? {
                conn.remove(path, e.dir && !e.link).await?;
                deleted += 1;
            }
        }
        let mut prune = prune.unwrap_or_default();
        prune.sort_by_key(|d| std::cmp::Reverse(d.len()));
        for dir in prune {
            // A folder with anything else in it, such as files the server made, stays.
            if conn.list(&dir).await.is_ok_and(|entries| entries.is_empty()) {
                let _ = conn.remove(&dir, true).await;
            }
        }
        Ok(deleted)
    }
    .await)
}

// ---- What Tusk put on each server ----

/// The project files Tusk last uploaded to or downloaded from a server, or found the same on both sides, by path
/// in the project, with their size and time then. A file listed here that's gone from the project was deleted
/// since, such as while Tusk was closed. Kept per project and server in the app's data folder.
type Snapshot = std::collections::BTreeMap<String, (u64, i64)>;

static SNAPSHOTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn snapshot_file(app: &tauri::AppHandle, root: &str, server: &str) -> Result<PathBuf, String> {
    use sha2::Digest;
    use tauri::Manager;
    let hash = sha2::Sha256::digest(format!("{root}\n{server}"));
    let name: String = hash[..12].iter().map(|b| format!("{b:02x}")).collect();
    Ok(app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("deployment").join(format!("{name}.json")))
}

fn read_snapshot(file: &Path) -> Snapshot {
    std::fs::read(file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn write_snapshot(file: &Path, files: &Snapshot) -> Result<(), String> {
    let dir = file.parent().ok_or("No folder")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let temp = file.with_extension("tmp");
    std::fs::write(&temp, serde_json::to_vec(files).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, file).map_err(|e| e.to_string())
}

/// Whether `path` is `dir` or inside it; every path is inside "".
fn inside(path: &str, dir: &str) -> bool {
    dir.is_empty() || path == dir || path.strip_prefix(dir).is_some_and(|rest| rest.starts_with('/'))
}

/// Forgets what's under `under` and each of `remove` (files or folders), then records `add` as they are on disk now.
fn update_snapshot(files: &mut Snapshot, root: &Path, under: Option<&str>, add: &[String], remove: &[String]) {
    if let Some(dir) = under {
        files.retain(|p, _| !inside(p, dir));
    }
    for r in remove.iter().filter(|r| !r.is_empty()) {
        files.retain(|p, _| !inside(p, r));
    }
    for rel in add {
        if let Some(meta) = std::fs::metadata(root.join(rel)).ok().filter(|m| m.is_file()) {
            files.insert(rel.clone(), (meta.len(), meta.modified().map(secs).unwrap_or(0)));
        }
    }
}

/// The recorded files that are gone from the project.
fn missing_files(files: &Snapshot, root: &Path) -> Vec<FileInfo> {
    files.iter().filter(|(rel, _)| std::fs::symlink_metadata(root.join(rel)).is_err()).map(|(rel, &(size, mtime))| FileInfo { path: rel.clone(), size, mtime }).collect()
}

/// Records what changed on the server: paths are relative to the project `root`.
#[tauri::command(async)]
pub fn deploy_snapshot_update(app: tauri::AppHandle, root: String, server: String, under: Option<String>, add: Vec<String>, remove: Vec<String>) -> Result<(), String> {
    let _lock = SNAPSHOTS.lock().unwrap();
    let file = snapshot_file(&app, &root, &server)?;
    let mut files = read_snapshot(&file);
    update_snapshot(&mut files, Path::new(&root), under.as_deref(), &add, &remove);
    write_snapshot(&file, &files)
}

/// The files Tusk put on `server` that are gone from the project.
#[tauri::command(async)]
pub fn deploy_snapshot_missing(app: tauri::AppHandle, root: String, server: String) -> Result<Vec<FileInfo>, String> {
    let _lock = SNAPSHOTS.lock().unwrap();
    Ok(missing_files(&read_snapshot(&snapshot_file(&app, &root, &server)?), Path::new(&root)))
}

/// Moves a server's record to its new name, or deletes it with the server when `to` is None.
#[tauri::command(async)]
pub fn deploy_snapshot_move(app: tauri::AppHandle, root: String, from: String, to: Option<String>) -> Result<(), String> {
    let _lock = SNAPSHOTS.lock().unwrap();
    let old = snapshot_file(&app, &root, &from)?;
    if !old.exists() {
        return Ok(());
    }
    match to {
        Some(to) => std::fs::rename(&old, snapshot_file(&app, &root, &to)?).map_err(|e| e.to_string()),
        None => std::fs::remove_file(&old).map_err(|e| e.to_string()),
    }
}

/// Uploads one file. `id` lets `deploy_cancel` stop it; progress goes to `progress` as (done, total) bytes.
#[tauri::command]
pub async fn deploy_upload(server: Server, local: String, remote: String, id: u32, progress: Channel<(u64, u64)>) -> Result<(), String> {
    let cancel = CancelGuard::new(id);
    let report = reporter(progress);
    with_conn!(&server, |conn| conn.upload(Path::new(&local), &remote, &report, &cancel.1).await)
}

#[tauri::command]
pub async fn deploy_download(server: Server, remote: String, local: String, id: u32, progress: Channel<(u64, u64)>) -> Result<(), String> {
    let cancel = CancelGuard::new(id);
    let report = reporter(progress);
    with_conn!(&server, |conn| conn.download(&remote, Path::new(&local), &report, &cancel.1).await)
}

/// A file's contents as text, for Compare with Deployed; None when the file isn't on the server.
#[tauri::command]
pub async fn deploy_read(server: Server, path: String) -> Result<Option<String>, String> {
    with_conn!(&server, |conn| async {
        match conn.stat(&path).await? {
            None => Ok(None),
            Some(e) if e.dir => Err(format!("{path} is a folder on the server")),
            Some(_) => {
                let data = conn.read(&path, 16 * 1024 * 1024).await?;
                String::from_utf8(data).map(Some).map_err(|_| format!("{} isn't text", name_of(&path)))
            }
        }
    }
    .await)
}

/// Which of `paths` (relative to a mapping's folder) its exclusions leave out.
#[tauri::command]
pub fn deploy_excluded(excludes: Vec<String>, paths: Vec<String>) -> Vec<bool> {
    let excludes = Excludes::new(&excludes);
    paths.iter().map(|p| excludes.matches(p)).collect()
}

/// The local files to upload for `paths` under a mapping's folder, relative to it.
#[tauri::command(async)]
pub fn deploy_local_files(root: String, paths: Vec<String>, excludes: Vec<String>) -> Vec<FileInfo> {
    local_files(Path::new(&root), &paths, &Excludes::new(&excludes))
}

/// The server's files under `dir`, relative to it, for downloading a folder. `prefix` is `dir`'s path below the
/// mapping's folder, which exclusions are relative to.
#[tauri::command]
pub async fn deploy_remote_files(server: Server, dir: String, excludes: Vec<String>, prefix: String, id: u32) -> Result<Vec<FileInfo>, String> {
    let cancel = CancelGuard::new(id);
    let excludes = Excludes::new(&excludes);
    with_conn!(&server, |conn| conn.walk(&dir, &excludes, &prefix, &cancel.1).await)
}

/// How the files under `local` (a file or folder in a mapping whose folder is `root`) differ from the server's
/// under `remote`, the same place there. Files of one size whose times differ are compared byte by byte, so a
/// file uploaded by another tool, with the upload's time, doesn't show as changed. `progress` gets
/// (files compared, files to compare).
#[tauri::command]
pub async fn deploy_compare(server: Server, root: String, local: String, remote: String, excludes: Vec<String>, id: u32, progress: Channel<(u64, u64)>) -> Result<Vec<Difference>, String> {
    let cancel = CancelGuard::new(id);
    let excludes = Arc::new(Excludes::new(&excludes));
    let base = PathBuf::from(&local);
    let is_dir = base.is_dir();
    // Exclusions are relative to the mapping's folder, and paths compared relative to what's compared: the
    // folder, or for a file, its name.
    let prefix = crate::slash(Path::new(&local).strip_prefix(&root).unwrap_or(Path::new("")));
    let local_files = {
        let (excludes, root, local) = (excludes.clone(), PathBuf::from(&root), local.clone());
        crate::blocking(move || Ok(local_files(&root, &[local], &excludes))).await?
    };
    let relative = |path: &str| if is_dir { path.strip_prefix(&prefix).unwrap_or(path).trim_start_matches('/').to_string() } else { name_of(path).to_string() };
    let local_files: Vec<FileInfo> = local_files.into_iter().map(|f| FileInfo { path: relative(&f.path), ..f }).collect();
    let report = reporter(progress);
    with_conn!(&server, |conn| async {
        let remote_files = if is_dir {
            conn.walk(&remote, &excludes, &prefix, &cancel.1).await?
        } else {
            conn.stat(&remote).await?.filter(|e| !e.dir).map(|e| vec![FileInfo { path: name_of(&remote).to_string(), size: e.size, mtime: e.mtime }]).unwrap_or_default()
        };
        let (mut sure, unsure) = diff(&local_files, &remote_files);
        let total = unsure.len() as u64;
        for (i, d) in unsure.into_iter().enumerate() {
            report(i as u64, total);
            if cancel.1.load(Ordering::Relaxed) {
                return Err("Canceled".to_string());
            }
            let size = d.local.as_ref().map_or(0, |f| f.size);
            if size > COMPARE_LIMIT {
                sure.push(d);
                continue;
            }
            let remote_path = if is_dir { join(&remote, &d.path) } else { remote.clone() };
            let local_path = if is_dir { base.join(&d.path) } else { base.clone() };
            let theirs = conn.read(&remote_path, COMPARE_LIMIT).await?;
            let ours = tokio::fs::read(&local_path).await.map_err(|e| e.to_string())?;
            if theirs != ours {
                sure.push(d);
            }
        }
        report(total, total);
        sure.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(sure)
    }
    .await)
}

/// Saves a server's password or key passphrase, or deletes it when it's empty.
#[tauri::command(async)]
pub fn deploy_set_secret(account: String, secret: String) -> Result<(), String> {
    let entry = keychain(&account)?;
    if secret.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(&secret).map_err(|e| e.to_string())
}

/// Moves a server's password to its new name.
#[tauri::command(async)]
pub fn deploy_move_secret(from: String, to: String) -> Result<(), String> {
    let old = keychain(&from)?;
    if let Ok(secret) = old.get_password() {
        keychain(&to)?.set_password(&secret).map_err(|e| e.to_string())?;
        let _ = old.delete_credential();
    }
    Ok(())
}

#[tauri::command(async)]
pub fn deploy_has_secret(account: String) -> bool {
    keychain(&account).ok().and_then(|e| e.get_password().ok()).is_some_and(|s| !s.is_empty())
}

/// Closes the pooled connections, such as after a server's settings change.
#[tauri::command]
pub async fn deploy_disconnect() {
    POOL.lock().await.clear();
}

fn keychain(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|e| e.to_string())
}

/// A saved password or passphrase, or None when there's none. Tests keep theirs out of the password store.
fn stored_secret(account: &str) -> Option<String> {
    #[cfg(test)]
    return tests::SECRETS.lock().unwrap().get(account).cloned();
    #[cfg(not(test))]
    keychain(account).ok().and_then(|e| e.get_password().ok()).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(path: &str, size: u64, mtime: i64) -> FileInfo {
        FileInfo { path: path.into(), size, mtime }
    }

    #[test]
    fn excludes_match_names_anywhere_and_paths_from_the_root() {
        let x = Excludes::new(&[".git".into(), "node_modules".into(), "storage/logs".into(), "*.log".into(), "/vendor/".into()]);
        assert!(x.matches(".git"));
        assert!(x.matches(".git/HEAD"));
        assert!(x.matches("resources/js/node_modules/a.js"));
        assert!(x.matches("storage/logs"));
        assert!(x.matches("storage/logs/laravel.log"));
        assert!(!x.matches("app/storage/logs/x.txt"));
        assert!(x.matches("app/debug.log"));
        assert!(x.matches("vendor/autoload.php"));
        assert!(!x.matches("app/vendor.php"));
        assert!(!x.matches("app/Models/User.php"));
        assert!(!x.matches(""));
        assert!(!Excludes::new(&[]).matches("a"));
    }

    #[test]
    fn local_files_walk_folders_and_skip_exclusions() {
        let dir = std::env::temp_dir().join(format!("tusk-deploy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for p in ["app/A.php", "app/B.php", "node_modules/x/i.js", ".env", "public/index.php"] {
            let path = dir.join(p);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "x").unwrap();
        }
        let root = crate::slash(&dir);
        let files = local_files(&dir, &[root.clone()], &Excludes::new(&["node_modules".into(), ".env".into()]));
        assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["app/A.php", "app/B.php", "public/index.php"]);
        let one = local_files(&dir, &[format!("{root}/app/B.php"), format!("{root}/.env")], &Excludes::new(&[".env".into()]));
        assert_eq!(one.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["app/B.php"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn diff_sorts_files_by_how_they_differ() {
        let local = [f("same.php", 10, 1000), f("new.php", 5, 1000), f("bigger.php", 20, 2000), f("touched.php", 7, 5000), f("rounded.php", 7, 1001)];
        let remote = [f("same.php", 10, 1000), f("gone.php", 3, 900), f("bigger.php", 10, 3000), f("touched.php", 7, 1000), f("rounded.php", 7, 1000)];
        let (sure, unsure) = diff(&local, &remote);
        let kinds: Vec<_> = sure.iter().map(|d| (d.path.as_str(), d.kind, d.newer)).collect();
        assert_eq!(kinds, [("bigger.php", "changed", "remote"), ("gone.php", "remote", "remote"), ("new.php", "local", "local")]);
        // Same size, times apart: the contents decide.
        assert_eq!(unsure.iter().map(|d| (d.path.as_str(), d.newer)).collect::<Vec<_>>(), [("touched.php", "local")]);
    }

    #[test]
    fn snapshots_record_and_find_deleted_files() {
        let dir = std::env::temp_dir().join(format!("tusk-snapshot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for p in ["app/A.php", "app/B.php", "app/Http/C.php", "public/index.php", "apple.txt"] {
            std::fs::create_dir_all(dir.join(p).parent().unwrap()).unwrap();
            std::fs::write(dir.join(p), "x").unwrap();
        }
        let mut files = Snapshot::new();
        let all: Vec<String> = ["app/A.php", "app/B.php", "app/Http/C.php", "public/index.php", "apple.txt", "not-there.php"].map(String::from).into();
        update_snapshot(&mut files, &dir, None, &all, &[]);
        // Only files on disk are recorded, with their size.
        assert_eq!(files.len(), 5);
        assert_eq!(files["app/A.php"].0, 1);
        std::fs::remove_file(dir.join("app/B.php")).unwrap();
        std::fs::remove_dir_all(dir.join("app/Http")).unwrap();
        let gone: Vec<_> = missing_files(&files, &dir).into_iter().map(|f| f.path).collect();
        assert_eq!(gone, ["app/B.php", "app/Http/C.php"]);
        // Removing a folder forgets what's in it, not files whose names start the same.
        update_snapshot(&mut files, &dir, None, &[], &["app".into()]);
        assert_eq!(files.keys().collect::<Vec<_>>(), ["apple.txt", "public/index.php"]);
        // A comparison replaces what's under its folder.
        update_snapshot(&mut files, &dir, Some("public"), &["app/A.php".into()], &[]);
        assert_eq!(files.keys().collect::<Vec<_>>(), ["app/A.php", "apple.txt"]);
        update_snapshot(&mut files, &dir, Some(""), &[], &[]);
        assert!(files.is_empty());
        let file = dir.join("state/x.json");
        update_snapshot(&mut files, &dir, None, &["apple.txt".into()], &[]);
        write_snapshot(&file, &files).unwrap();
        assert_eq!(read_snapshot(&file), files);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn known_hosts_entries_are_numbered_without_comments() {
        let text = "# comment\nhost1 ssh-ed25519 AAAA\nhost2 ssh-ed25519 BBBB\n# another\nhost3 ssh-ed25519 CCCC\n";
        assert_eq!(without_entry(text, 2), "# comment\nhost1 ssh-ed25519 AAAA\n# another\nhost3 ssh-ed25519 CCCC\n");
        assert_eq!(without_entry(text, 3), "# comment\nhost1 ssh-ed25519 AAAA\nhost2 ssh-ed25519 BBBB\n# another\n");
    }

    #[test]
    fn remote_paths() {
        assert_eq!(parent("/var/www/a.php"), "/var/www");
        assert_eq!(parent("/a.php"), "/");
        assert_eq!(parent("a.php"), ".");
        assert_eq!(name_of("/var/www/"), "www");
        assert_eq!(join("/", "a"), "/a");
        assert_eq!(join("/var", "a"), "/var/a");
        assert_eq!(join("", "a"), "a");
    }

    #[test]
    fn putty_keys_load_with_their_passphrase() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let plain = dir.join("deploy.fixture.plain.ppk");
        let (v2, v3) = (dir.join("deploy.fixture.v2.ppk"), dir.join("deploy.fixture.v3.ppk"));
        assert!(load_key(&plain, "").unwrap().algorithm().is_ed25519());
        assert!(load_key(&v2, "123").unwrap().algorithm().is_rsa());
        assert!(load_key(&v3, "123").unwrap().algorithm().is_ed25519());
        for file in [&v2, &v3] {
            assert!(load_key(file, "").unwrap_err().contains("has a passphrase"), "{}", load_key(file, "").unwrap_err());
            assert!(load_key(file, "wrong").unwrap_err().contains("PuTTYgen"));
        }
    }

    #[test]
    fn key_files_follow_ssh_config() {
        let home = std::env::home_dir().unwrap();
        let cfg = crate::sshconfig::HostConfig { identity_files: vec!["/nonexistent/key".into()], identities_only: true, ..Default::default() };
        assert!(key_files(&cfg, "").is_empty());
        assert_eq!(key_files(&cfg, "~/k.ppk"), [(home.join("k.ppk"), true)]);
    }

    #[test]
    fn mfmt_times_are_utc() {
        assert_eq!(chrono_utc(0), None);
        assert_eq!(chrono_utc(1_700_000_000).unwrap(), "20231114221320");
        assert_eq!(chrono_utc(951_782_400).unwrap(), "20000229000000");
    }

    /// Runs against the servers scripts/deploy-test-servers.sh starts, in TUSK_DEPLOY_TEST's folder.
    async fn round_trip(server: Server, root: &str) {
        let www = PathBuf::from(std::env::var("TUSK_DEPLOY_TEST").unwrap()).join("www");
        let local = std::env::temp_dir().join(format!("tusk-it-{}-{}", server.protocol, std::process::id()));
        std::fs::create_dir_all(&local).unwrap();
        let dir = join(root, &format!("tusk-it-{}", server.protocol));
        let cancel = AtomicBool::new(false);
        let none = |_, _| {};
        let mut conn = connect(&server).await.unwrap();
        let _ = conn.remove(&dir, true).await;

        // A new file, in folders that don't exist yet.
        std::fs::write(local.join("a.txt"), "one").unwrap();
        let remote = join(&dir, "sub/deeper/a.txt");
        conn.upload(&local.join("a.txt"), &remote, &none, &cancel).await.unwrap();
        let on_server = www.join(format!("tusk-it-{}/sub/deeper/a.txt", server.protocol));
        assert_eq!(std::fs::read_to_string(&on_server).unwrap(), "one");

        // Replacing it keeps its permissions and leaves no temporary files.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&on_server, std::fs::Permissions::from_mode(0o640)).unwrap();
            std::fs::write(local.join("a.txt"), "two, longer").unwrap();
            conn.upload(&local.join("a.txt"), &remote, &none, &cancel).await.unwrap();
            assert_eq!(std::fs::read_to_string(&on_server).unwrap(), "two, longer");
            if server.is_sftp() {
                assert_eq!(std::fs::metadata(&on_server).unwrap().permissions().mode() & 0o777, 0o640);
            }
        }
        let names: Vec<_> = conn.list(&join(&dir, "sub/deeper")).await.unwrap().into_iter().map(|e| (e.name, e.size)).collect();
        assert_eq!(names, [("a.txt".to_string(), 11)]);

        // The server's time is the local file's, so a comparison sees them as the same.
        let local_time = secs(std::fs::metadata(local.join("a.txt")).unwrap().modified().unwrap());
        let walked = conn.walk(&dir, &Excludes::new(&[]), "", &cancel).await.unwrap();
        assert_eq!(walked.iter().map(|f| (f.path.as_str(), f.size)).collect::<Vec<_>>(), [("sub/deeper/a.txt", 11)]);
        assert!((walked[0].mtime - local_time).abs() <= SAME_TIME, "{} vs {local_time}", walked[0].mtime);
        assert_eq!(conn.walk(&dir, &Excludes::new(&["deeper".into()]), "", &cancel).await.unwrap(), []);

        // Downloading writes through a temporary file and takes the server's time.
        conn.download(&remote, &local.join("down/a.txt"), &none, &cancel).await.unwrap();
        assert_eq!(std::fs::read_to_string(local.join("down/a.txt")).unwrap(), "two, longer");
        assert_eq!(conn.read(&remote, 100).await.unwrap(), b"two, longer");
        assert!(conn.read(&remote, 5).await.is_err());

        // A cancel stops a transfer.
        cancel.store(true, Ordering::Relaxed);
        assert_eq!(conn.upload(&local.join("a.txt"), &join(&dir, "b.txt"), &none, &cancel).await.unwrap_err(), "Canceled");
        cancel.store(false, Ordering::Relaxed);
        let mut conn = if server.is_sftp() { conn } else { connect(&server).await.unwrap() };
        assert!(conn.stat(&join(&dir, "b.txt")).await.unwrap().is_none());

        conn.rename(&remote, &join(&dir, "sub/renamed.txt")).await.unwrap();
        assert!(conn.stat(&remote).await.unwrap().is_none());
        assert_eq!(conn.stat(&join(&dir, "sub/renamed.txt")).await.unwrap().unwrap().size, 11);
        conn.remove(&dir, true).await.unwrap();
        assert!(conn.stat(&dir).await.unwrap().is_none());
        std::fs::remove_dir_all(&local).unwrap();
    }

    fn test_server(protocol: &str, port: u16, user: &str, auth: &str, key_file: String, secret: &str) -> Server {
        Server { protocol: protocol.into(), host: "127.0.0.1".into(), port, user: user.into(), auth: auth.into(), key_file, passive: true, insecure_tls: false, account: String::new(), secret: Some(secret.into()) }
    }

    #[tokio::test]
    #[ignore]
    async fn sftp_round_trip() {
        let folder = PathBuf::from(std::env::var("TUSK_DEPLOY_TEST").expect("Run scripts/deploy-test-servers.sh and set TUSK_DEPLOY_TEST"));
        let known = folder.join("known_hosts");
        let _ = std::fs::remove_file(&known);
        std::env::set_var("TUSK_KNOWN_HOSTS", &known);
        let key = crate::slash(folder.join("sshd/client_key"));
        let server = test_server("sftp", 2222, &whoami(), "key", key.clone(), "");
        // The first connection asks to trust the server's key, and the next one is let in.
        let Err(e) = connect(&server).await else { panic!("connected to an unknown host") };
        let problem: serde_json::Value = serde_json::from_str(e.strip_prefix("host-key:").expect(&e)).unwrap();
        assert_eq!(problem["kind"], "unknown");
        assert!(problem["fingerprint"].as_str().unwrap().starts_with("SHA256:"));
        deploy_trust_host("127.0.0.1".into(), 2222, problem["key"].as_str().unwrap().into(), None).unwrap();
        // A key whose passphrase is missing, or wrong, says so.
        let pw_key = crate::slash(folder.join("sshd/client_key_pw"));
        assert!(connect(&test_server("sftp", 2222, &whoami(), "key", pw_key.clone(), "")).await.err().unwrap().contains("passphrase"));
        assert!(connect(&test_server("sftp", 2222, &whoami(), "key", pw_key.clone(), "secret phrase")).await.is_ok());
        assert!(connect(&test_server("sftp", 2222, "nobody-here", "key", key.clone(), "")).await.err().unwrap().contains("refused the key"));
        round_trip(server.clone(), &crate::slash(folder.join("www"))).await;

        // A changed key is refused and named, and trusting it replaces the old entry.
        let other = PublicKey::from_openssh("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl").unwrap();
        std::fs::write(&known, format!("# comment\n[127.0.0.1]:2222 {}\n", other.to_openssh().unwrap())).unwrap();
        let Err(e) = connect(&server).await else { panic!("connected with a changed key") };
        let problem: serde_json::Value = serde_json::from_str(e.strip_prefix("host-key:").unwrap()).unwrap();
        assert_eq!(problem["kind"], "changed");
        deploy_trust_host("127.0.0.1".into(), 2222, problem["key"].as_str().unwrap().into(), problem["line"].as_u64().map(|l| l as usize)).unwrap();
        assert!(connect(&server).await.is_ok());
        assert_eq!(std::fs::read_to_string(&known).unwrap().lines().count(), 2);

        // A replaced file keeps its group, when it's one of yours other than the one a new file gets.
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let www = folder.join("www");
            let local = folder.join("group.txt");
            std::fs::write(&local, "v1").unwrap();
            let remote = crate::slash(www.join("group.txt"));
            let mut conn = connect(&server).await.unwrap();
            conn.upload(&local, &remote, &|_, _| {}, &AtomicBool::new(false)).await.unwrap();
            let given = std::fs::metadata(www.join("group.txt")).unwrap().gid();
            let groups = String::from_utf8(std::process::Command::new("id").arg("-G").output().unwrap().stdout).unwrap();
            if let Some(other) = groups.split_whitespace().filter_map(|g| g.parse::<u32>().ok()).find(|&g| g != given) {
                std::os::unix::fs::chown(www.join("group.txt"), None, Some(other)).unwrap();
                std::fs::write(&local, "v2, longer").unwrap();
                conn.upload(&local, &remote, &|_, _| {}, &AtomicBool::new(false)).await.unwrap();
                assert_eq!(std::fs::read_to_string(www.join("group.txt")).unwrap(), "v2, longer");
                assert_eq!(std::fs::metadata(www.join("group.txt")).unwrap().gid(), other);
            }
            std::fs::remove_file(www.join("group.txt")).unwrap();
        }

        // A host alias from ~/.ssh/config connects to its HostName, port, user, and key, through its ProxyJump host.
        let config = folder.join("ssh_config");
        std::fs::write(
            &config,
            format!(
                "Host tusk-jump\n  HostName 127.0.0.1\n  Port 2222\n  IdentityFile {key}\n  IdentitiesOnly yes\n\
                 Host tusk-target\n  HostName 127.0.0.1\n  Port 2222\n  User {user}\n  IdentityFile {key}\n  IdentitiesOnly yes\n  ProxyJump tusk-jump\n\
                 Host tusk-direct\n  HostName 127.0.0.1\n  Port 2222\n  IdentityFile {key}\n",
                user = whoami()
            ),
        )
        .unwrap();
        std::env::set_var("TUSK_SSH_CONFIG", &config);
        let direct = test_server("sftp", 22, "", "key", String::new(), "");
        let mut conn = connect(&Server { host: "tusk-direct".into(), ..direct.clone() }).await.unwrap();
        assert!(conn.stat(&crate::slash(folder.join("www"))).await.unwrap().is_some_and(|e| e.dir));
        let Conn::Sftp { _jumps, .. } = connect(&Server { host: "tusk-target".into(), ..direct.clone() }).await.unwrap() else { unreachable!() };
        assert_eq!(_jumps.len(), 1);

        // Jump hosts that want a password, or a key's passphrase: in-process servers that forward to the sshd.
        let host_key = russh::keys::load_secret_key(folder.join("sshd/host_key"), None).unwrap();
        let pw_public = load_key(Path::new(&pw_key), "secret phrase").unwrap().public_key().clone();
        let password_jump = start_jump(host_key.clone(), Some("jump pw"), None).await;
        let key_jump = start_jump(host_key, None, Some(pw_public)).await;
        let target = |jump: &str| format!("  HostName 127.0.0.1\n  Port 2222\n  User {}\n  IdentityFile {key}\n  IdentitiesOnly yes\n  ProxyJump {jump}\n", whoami());
        std::fs::write(
            &config,
            format!(
                "Host tusk-pw-jump\n  HostName 127.0.0.1\n  Port {password_jump}\n  User jumper\n  IdentitiesOnly yes\n\
                 Host tusk-key-jump\n  HostName 127.0.0.1\n  Port {key_jump}\n  User jumper\n  IdentityFile {pw_key}\n  IdentitiesOnly yes\n\
                 Host tusk-via-pw\n{}Host tusk-via-key\n{}\
                 Host tusk-proxy\n  HostName 127.0.0.1\n  Port 2222\n  IdentityFile {key}\n  IdentitiesOnly yes\n  ProxyCommand nc %h %p\n  HostKeyAlias tusk-test-alias\n\
                 Host tusk-proxy-broken\n  HostName 127.0.0.1\n  Port 2222\n  IdentityFile {key}\n  ProxyCommand nc %h 1\n",
                target("tusk-pw-jump"),
                target("tusk-key-jump"),
            ),
        )
        .unwrap();
        let named = |host: &str| Server { host: host.into(), ..direct.clone() };
        let login = |e: String| -> serde_json::Value { serde_json::from_str(e.strip_prefix("ssh-login:").expect(&e)).unwrap() };
        // Each new jump host's key is trusted first, as the frontend's dialog would.
        for (host, port) in [("tusk-via-pw", password_jump), ("tusk-via-key", key_jump)] {
            let Err(e) = connect(&named(host)).await else { panic!("connected through an unknown jump host") };
            let problem: serde_json::Value = serde_json::from_str(e.strip_prefix("host-key:").expect(&e)).unwrap();
            assert_eq!(problem["port"], port);
            deploy_trust_host("127.0.0.1".into(), port, problem["key"].as_str().unwrap().into(), None).unwrap();
        }
        // No password saved: the error asks for one; a wrong one says so; the right one connects.
        let asked = login(connect(&named("tusk-via-pw")).await.err().unwrap());
        assert_eq!((asked["kind"].as_str(), asked["hop"].as_str(), asked["wrong"].as_bool()), (Some("password"), Some("tusk-pw-jump"), Some(false)));
        let account = asked["account"].as_str().unwrap().to_string();
        assert_eq!(account, format!("ssh:jumper@127.0.0.1:{password_jump}"));
        SECRETS.lock().unwrap().insert(account.clone(), "not it".into());
        assert_eq!(login(connect(&named("tusk-via-pw")).await.err().unwrap())["wrong"], true);
        SECRETS.lock().unwrap().insert(account, "jump pw".into());
        assert!(connect(&named("tusk-via-pw")).await.is_ok());
        // A jump host's key with a passphrase asks for the passphrase, naming the key.
        let asked = login(connect(&named("tusk-via-key")).await.err().unwrap());
        assert_eq!((asked["kind"].as_str(), asked["key"].as_str()), (Some("passphrase"), Some(pw_key.as_str())));
        SECRETS.lock().unwrap().insert(asked["account"].as_str().unwrap().into(), "secret phrase".into());
        let Conn::Sftp { _jumps, .. } = connect(&named("tusk-via-key")).await.unwrap() else { unreachable!() };
        assert_eq!(_jumps.len(), 1);

        // A ProxyCommand carries the connection; HostKeyAlias keeps the server's key under its own name, no port.
        let Err(e) = connect(&named("tusk-proxy")).await else { panic!("connected with an unknown alias") };
        let problem: serde_json::Value = serde_json::from_str(e.strip_prefix("host-key:").expect(&e)).unwrap();
        assert_eq!((problem["host"].as_str(), problem["port"].as_u64(), problem["shown"].as_str()), (Some("tusk-test-alias"), Some(22), Some("127.0.0.1:2222")));
        deploy_trust_host("tusk-test-alias".into(), 22, problem["key"].as_str().unwrap().into(), None).unwrap();
        assert!(std::fs::read_to_string(&known).unwrap().lines().any(|l| l.starts_with("tusk-test-alias ")));
        let mut conn = connect(&named("tusk-proxy")).await.unwrap();
        assert!(matches!(&conn, Conn::Sftp { _proxy: Some(_), .. }));
        assert!(conn.stat(&crate::slash(folder.join("www"))).await.unwrap().is_some_and(|e| e.dir));
        let e = connect(&named("tusk-proxy-broken")).await.err().unwrap();
        assert!(e.contains("ProxyCommand"), "{e}");
        std::env::remove_var("TUSK_SSH_CONFIG");
    }

    pub(super) static SECRETS: LazyLock<std::sync::Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);

    /// A jump host for the tests, on a free port: it takes `password` or `key`, and forwards connections.
    async fn start_jump(host_key: russh::keys::PrivateKey, password: Option<&'static str>, key: Option<PublicKey>) -> u16 {
        struct Jump {
            password: Option<&'static str>,
            key: Option<PublicKey>,
        }
        impl russh::server::Handler for Jump {
            type Error = russh::Error;
            async fn auth_password(&mut self, _: &str, password: &str) -> Result<russh::server::Auth, Self::Error> {
                Ok(if Some(password) == self.password { russh::server::Auth::Accept } else { russh::server::Auth::reject() })
            }
            async fn auth_publickey(&mut self, _: &str, key: &PublicKey) -> Result<russh::server::Auth, Self::Error> {
                Ok(if self.key.as_ref().is_some_and(|k| k.key_data() == key.key_data()) { russh::server::Auth::Accept } else { russh::server::Auth::reject() })
            }
            async fn channel_open_direct_tcpip(&mut self, channel: russh::Channel<russh::server::Msg>, host: &str, port: u32, _: &str, _: u32, reply: russh::server::ChannelOpenHandle, _: &mut russh::server::Session) -> Result<(), Self::Error> {
                let mut target = tokio::net::TcpStream::connect((host, port as u16)).await?;
                reply.accept().await;
                tokio::spawn(async move {
                    let _ = tokio::io::copy_bidirectional(&mut channel.into_stream(), &mut target).await;
                });
                Ok(())
            }
        }
        let methods: &[russh::MethodKind] = if password.is_some() { &[russh::MethodKind::Password] } else { &[russh::MethodKind::PublicKey] };
        let config = Arc::new(russh::server::Config { keys: vec![host_key], methods: methods.into(), auth_rejection_time: Duration::from_millis(10), ..Default::default() });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                if let Ok(session) = russh::server::run_stream(config.clone(), socket, Jump { password, key: key.clone() }).await {
                    tokio::spawn(session);
                }
            }
        });
        port
    }

    #[tokio::test]
    #[ignore]
    async fn ftp_round_trip() {
        std::env::var("TUSK_DEPLOY_TEST").expect("Run scripts/deploy-test-servers.sh and set TUSK_DEPLOY_TEST");
        assert!(connect(&test_server("ftp", 2121, "tusk", "", String::new(), "wrong")).await.err().unwrap().contains("refused the user name or password"));
        round_trip(test_server("ftp", 2121, "tusk", "", String::new(), "tusk"), "/").await;
    }

    #[tokio::test]
    #[ignore]
    async fn ftps_round_trip() {
        std::env::var("TUSK_DEPLOY_TEST").expect("Run scripts/deploy-test-servers.sh and set TUSK_DEPLOY_TEST");
        // The test server's certificate is self-signed: refused unless the settings say not to check it.
        let mut server = test_server("ftps", 2990, "tusk", "", String::new(), "tusk");
        assert!(connect(&server).await.err().unwrap().contains("certificate"));
        server.insecure_tls = true;
        round_trip(server, "/").await;
    }

    #[tokio::test]
    #[ignore]
    async fn implicit_ftps_round_trip() {
        std::env::var("TUSK_DEPLOY_TEST").expect("Run scripts/deploy-test-servers.sh and set TUSK_DEPLOY_TEST");
        let mut server = test_server("ftps-implicit", 2991, "tusk", "", String::new(), "tusk");
        assert!(connect(&server).await.err().unwrap().contains("certificate"));
        server.insecure_tls = true;
        round_trip(server, "/").await;
    }
}
