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
/// it refused one, for `connect` to report.
struct Client {
    host: String,
    port: u16,
    refusal: Arc<std::sync::Mutex<Option<String>>>,
}

/// Why a key was refused, as JSON the frontend reads to ask whether to trust it: `host-key:{…}`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostKeyProblem {
    kind: &'static str,
    host: String,
    port: u16,
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
    Sftp { ssh: russh::client::Handle<Client>, sftp: SftpSession },
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
    let config = russh::client::Config { keepalive_interval: Some(Duration::from_secs(30)), ..Default::default() };
    let refusal = Arc::new(std::sync::Mutex::new(None));
    let client = Client { host: server.host.clone(), port: server.port, refusal: refusal.clone() };
    let mut ssh = match russh::client::connect(Arc::new(config), (server.host.as_str(), server.port), client).await {
        Ok(ssh) => ssh,
        Err(e) => return Err(refusal.lock().unwrap().take().unwrap_or_else(|| friendly(e))),
    };
    let user = if server.user.is_empty() { whoami() } else { server.user.clone() };
    let ok = match server.auth.as_str() {
        "password" => ssh.authenticate_password(&user, server.secret()).await.map_err(friendly)?.success(),
        "agent" => agent_auth(&mut ssh, &user).await?,
        _ => key_auth(&mut ssh, &user, server).await?,
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
    Ok(Conn::Sftp { ssh, sftp })
}

fn whoami() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default()
}

/// Logs in with a key file, or with ~/.ssh's usual keys when none is set, as `ssh` tries them.
async fn key_auth(ssh: &mut russh::client::Handle<Client>, user: &str, server: &Server) -> Result<bool, String> {
    let home = std::env::home_dir().unwrap_or_default();
    let files: Vec<PathBuf> = if server.key_file.is_empty() {
        ["id_ed25519", "id_ecdsa", "id_rsa"].iter().map(|n| home.join(".ssh").join(n)).filter(|p| p.exists()).collect()
    } else {
        vec![PathBuf::from(server.key_file.replacen('~', &home.to_string_lossy(), 1))]
    };
    if files.is_empty() {
        return Err("There's no key in ~/.ssh. Choose a key file, or log in with your SSH agent.".into());
    }
    let passphrase = server.secret();
    for file in files {
        let key = match russh::keys::load_secret_key(&file, (!passphrase.is_empty()).then_some(passphrase.as_str())) {
            Ok(key) => key,
            Err(russh::keys::Error::KeyIsEncrypted) => return Err(format!("{} has a passphrase. Type it in the server's settings.", file.display())),
            Err(e) if server.key_file.is_empty() => {
                eprintln!("deploy: skipping {}: {e}", file.display());
                continue;
            }
            Err(e) => return Err(format!("Can't read {}: {e}. A wrong passphrase reads as a corrupt key.", file.display())),
        };
        let hash = if key.algorithm().is_rsa() { ssh.best_supported_rsa_hash().await.map_err(friendly)?.flatten() } else { None };
        if ssh.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await.map_err(friendly)?.success() {
            return Ok(true);
        }
    }
    Ok(false)
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
        "ftps-implicit" => AsyncRustlsFtpStream::connect_secure_implicit(address, tls()?, &server.host).await.map_err(friendly)?,
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
                        Entry { name: e.file_name(), dir: m.is_dir(), link: m.is_symlink(), size: m.size.unwrap_or(0), mtime: m.mtime.unwrap_or(0) as i64, mode: m.permissions.map(|p| p & 0o7777) }
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
                Ok(m) => Ok(Some(Entry { name: name_of(path).into(), dir: m.is_dir(), link: m.is_symlink(), size: m.size.unwrap_or(0), mtime: m.mtime.unwrap_or(0) as i64, mode: m.permissions.map(|p| p & 0o7777) })),
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

    /// Sets a file's modification time and permissions, where the server allows it. Failures don't matter: a
    /// later comparison reads the contents when the times differ.
    async fn set_attrs(&mut self, path: &str, mtime: i64, mode: Option<u32>) {
        match self {
            Conn::Sftp { sftp, .. } => {
                let attrs = FileAttributes { atime: Some(mtime as u32), mtime: Some(mtime as u32), permissions: mode, ..FileAttributes::empty() };
                if sftp.set_metadata(path, attrs).await.is_err() && mode.is_some() {
                    let _ = sftp.set_metadata(path, FileAttributes { permissions: mode, ..FileAttributes::empty() }).await;
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
        self.set_attrs(&target, mtime, mode).await;
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
    Entry { name: f.name().to_string(), dir: f.is_directory(), link: f.is_symlink(), size: f.size() as u64, mtime: secs(f.modified()), mode: (mode != 0).then_some(mode) }
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
}
