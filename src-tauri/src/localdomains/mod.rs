// Serves a run configuration's PHP server at `https://<name>.test`. Every Tusk process, dev and release builds
// alike, shares one folder: the local CA, each process's routes, and the lock held by the one process that runs the
// listeners (the owner). When the owner quits, another process with routes takes over within seconds.
mod ca;
mod dns;
mod proxy;

use crate::localsystem;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::net::ToSocketAddrs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub use ca::ca_pem_path;

pub const HTTPS_PORT: u16 = 443;
/// Used when 443 can't be bound; URLs then carry the port.
pub const FALLBACK_PORT: u16 = 8443;
/// Redirects to HTTPS, bound only with 443.
pub const HTTP_PORT: u16 = 80;
/// The DNS responder's port on 127.0.0.1. Windows' NRPT rules can't name a port, so there it's 53.
pub const DNS_PORT: u16 = if cfg!(windows) { 53 } else { 15353 };
/// How often a process with routes checks whether the owner has quit.
const TICK: Duration = Duration::from_secs(2);

/// The folder every Tusk process shares. It's not the app's own folder, since dev builds use other identifiers.
pub fn shared_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().local_data_dir().map_err(|e| e.to_string())?.join("tusk-local-domains"))
}

/// The SHA-256 fingerprint of the CA certificate in `dir`, in lowercase hex, for the OS setup module.
#[allow(dead_code)]
pub fn ca_fingerprint(dir: &Path) -> Result<String, String> {
    use rustls::pki_types::{pem::PemObject, CertificateDer};
    let der = CertificateDer::from_pem_file(ca_pem_path(dir)).map_err(|e| e.to_string())?;
    Ok(ca::fingerprint(&der))
}

#[derive(Clone)]
pub struct Ports {
    pub https: u16,
    pub fallback: u16,
    pub http: Option<u16>,
    pub dns: u16,
}

#[derive(Serialize, Deserialize)]
struct OwnerInfo {
    pid: u32,
    https_port: u16,
    http_port: Option<u16>,
    dns_port: Option<u16>,
}

/// What the listeners need from this process: its routes, the shared folder, and the CA.
pub struct Inner {
    dir: PathBuf,
    id: String,
    routes: Mutex<BTreeMap<String, u16>>,
    ca: RwLock<Arc<ca::Ca>>,
}

impl Inner {
    fn ca(&self) -> Arc<ca::Ca> {
        self.ca.read().unwrap().clone()
    }

    /// The port serving `name`, from this process's routes or another live process's.
    // ponytail: re-reads every route file per connection; they're tiny. Watch the folder if there are ever many.
    fn lookup(&self, name: &str) -> Option<u16> {
        if let Some(port) = self.routes.lock().unwrap().get(name) {
            return Some(*port);
        }
        others(&self.dir, &self.id).into_iter().find_map(|routes| routes.get(name).copied())
    }

    /// Every name served now, by this process or another live one, sorted.
    fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.routes.lock().unwrap().keys().cloned().collect();
        names.extend(others(&self.dir, &self.id).into_iter().flat_map(HashMap::into_keys));
        names.sort();
        names.dedup();
        names
    }

    fn save(&self, routes: &BTreeMap<String, u16>) -> Result<(), String> {
        let path = self.dir.join("routes").join(format!("{}.json", self.id));
        write_atomic(&path, &serde_json::to_vec(routes).map_err(|e| e.to_string())?)
    }
}

fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    let temp = path.with_extension("tmp");
    fs::write(&temp, data).and_then(|_| fs::rename(&temp, path)).map_err(|e| e.to_string())
}

/// The routes of every other live process. A process whose lock can be taken is gone, so its files are removed.
fn others(dir: &Path, me: &str) -> Vec<HashMap<String, u16>> {
    let Ok(entries) = fs::read_dir(dir.join("routes")) else { return Vec::new() };
    let mut found = Vec::new();
    for path in entries.flatten().map(|e| e.path()) {
        if path.extension().is_none_or(|e| e != "json") || path.file_stem().is_some_and(|id| id == me) {
            continue;
        }
        let lock = path.with_extension("lock");
        // A lock that can't be opened or taken for another reason is treated as live.
        let dead = match OpenOptions::new().write(true).open(&lock) {
            Ok(file) => file.try_lock().is_ok(),
            Err(e) => e.kind() == std::io::ErrorKind::NotFound,
        };
        if dead {
            let _ = fs::remove_file(&path);
            let _ = fs::remove_file(&lock);
        } else if let Some(routes) = fs::read(&path).ok().and_then(|data| serde_json::from_slice(&data).ok()) {
            found.push(routes);
        }
    }
    found
}

struct Owner {
    listening: proxy::Listening,
    /// Held for as long as this process runs the listeners; the OS releases it if the process dies.
    _lock: File,
}

/// One process's part: its routes, and the listeners when it's the owner.
pub struct Instance {
    inner: Arc<Inner>,
    ports: Ports,
    owner: tokio::sync::Mutex<Option<Owner>>,
    /// Held for the instance's lifetime, so others can tell its routes are live.
    _lock: File,
}

impl Instance {
    /// Starts an instance in `dir`. It must be called inside a tokio runtime, which runs its takeover checks.
    pub fn new(dir: PathBuf, ports: Ports, ca: ca::Ca) -> Result<Arc<Self>, String> {
        let routes = dir.join("routes");
        fs::create_dir_all(&routes).map_err(|e| e.to_string())?;
        let id = random_id();
        let lock = File::create(routes.join(format!("{id}.lock"))).map_err(|e| e.to_string())?;
        lock.try_lock().map_err(|e| e.to_string())?;
        let inner = Arc::new(Inner { dir, id, routes: Mutex::default(), ca: RwLock::new(Arc::new(ca)) });
        let me = Arc::new(Instance { inner, ports, owner: tokio::sync::Mutex::new(None), _lock: lock });
        let weak: Weak<Instance> = Arc::downgrade(&me);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(TICK).await;
                let Some(me) = weak.upgrade() else { break };
                me.tick().await;
            }
        });
        Ok(me)
    }

    fn set_ca(&self, ca: ca::Ca) {
        if self.inner.ca().der != ca.der {
            *self.inner.ca.write().unwrap() = Arc::new(ca);
        }
    }

    fn names(&self) -> Vec<String> {
        self.inner.routes.lock().unwrap().keys().cloned().collect()
    }

    /// Why `name` can't be served here, if something already serves it.
    fn conflict(&self, name: &str) -> Option<String> {
        if self.inner.routes.lock().unwrap().contains_key(name) {
            return Some(format!("{name}.test is already running in this Tusk window. Stop it first, or pick another domain in the run configuration."));
        }
        others(&self.inner.dir, &self.inner.id)
            .iter()
            .any(|routes| routes.contains_key(name))
            .then(|| format!("{name}.test is already served by another Tusk window. Pick another domain in the run configuration."))
    }

    /// Routes `name` to `port` on 127.0.0.1.
    pub fn register(&self, name: &str, port: u16) -> Result<(), String> {
        // Taken so two processes can't both claim a name between checking and saving.
        let setup = OpenOptions::new().create(true).truncate(false).write(true).open(self.inner.dir.join("setup.lock")).map_err(|e| e.to_string())?;
        setup.lock().map_err(|e| e.to_string())?;
        if let Some(conflict) = self.conflict(name) {
            return Err(conflict);
        }
        let mut routes = self.inner.routes.lock().unwrap();
        routes.insert(name.to_string(), port);
        self.inner.save(&routes).inspect_err(|_| _ = routes.remove(name))
    }

    pub fn unregister(&self, name: &str) -> Result<(), String> {
        let mut routes = self.inner.routes.lock().unwrap();
        if routes.remove(name).is_none() {
            return Ok(());
        }
        self.inner.save(&routes)
    }

    /// Makes sure some process runs the listeners, becoming the owner if none does. Returns the HTTPS port and any
    /// notes from starting them.
    pub async fn ensure_listeners(&self) -> Result<(u16, Vec<String>), String> {
        for _ in 0..20 {
            let mut owner = self.owner.lock().await;
            if let Some(o) = owner.as_ref() {
                return Ok((o.listening.https_port, Vec::new()));
            }
            if let Some(notes) = self.try_own(&mut owner).await? {
                return Ok((owner.as_ref().map_or(0, |o| o.listening.https_port), notes));
            }
            drop(owner);
            // Another process owns the listeners; it writes owner.json once they're bound.
            if let Some(info) = self.owner_info() {
                return Ok((info.https_port, Vec::new()));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        Err("Another Tusk window runs the .test proxy but hasn't finished starting it. Try again in a moment.".into())
    }

    fn owner_info(&self) -> Option<OwnerInfo> {
        serde_json::from_slice(&fs::read(self.inner.dir.join("owner.json")).ok()?).ok()
    }

    /// Takes the owner lock and starts the listeners. Returns None when another process holds the lock.
    async fn try_own(&self, slot: &mut Option<Owner>) -> Result<Option<Vec<String>>, String> {
        let dir = &self.inner.dir;
        let lock = OpenOptions::new().create(true).truncate(false).write(true).open(dir.join("owner.lock")).map_err(|e| e.to_string())?;
        if lock.try_lock().is_err() {
            return Ok(None);
        }
        // A previous owner that died left its owner.json behind.
        let _ = fs::remove_file(dir.join("owner.json"));
        let mut listening = proxy::listen(self.inner.clone(), &self.ports).await?;
        self.write_owner_info(&listening)?;
        let notes = std::mem::take(&mut listening.notes);
        *slot = Some(Owner { listening, _lock: lock });
        Ok(Some(notes))
    }

    fn write_owner_info(&self, l: &proxy::Listening) -> Result<(), String> {
        let info = OwnerInfo { pid: std::process::id(), https_port: l.https_port, http_port: l.http_port, dns_port: l.dns_port };
        write_atomic(&self.inner.dir.join("owner.json"), &serde_json::to_vec(&info).map_err(|e| e.to_string())?)
    }

    /// Takes over the listeners when the owner has quit and this process has routes. An owner steps down when
    /// owner.json is gone, which means another process removed the setup, and it has no routes of its own.
    async fn tick(&self) {
        let no_routes = self.inner.routes.lock().unwrap().is_empty();
        let mut owner = self.owner.lock().await;
        if owner.is_some() {
            if no_routes && !self.inner.dir.join("owner.json").exists() {
                *owner = None;
            }
        } else if !no_routes {
            match self.try_own(&mut owner).await {
                Ok(Some(notes)) => notes.iter().for_each(|n| eprintln!("local domains: {n}")),
                Ok(None) => {}
                Err(e) => eprintln!("local domains: couldn't take over the proxy: {e}"),
            }
        }
    }

    /// Moves the owner's listeners to the main ports, after the fallback was used.
    async fn rebind(&self) -> Result<(), String> {
        let mut slot = self.owner.lock().await;
        let Some(owner) = slot.as_mut().filter(|o| o.listening.https_port != self.ports.https) else { return Ok(()) };
        std::mem::take(&mut owner.listening).stop().await;
        match proxy::listen(self.inner.clone(), &self.ports).await {
            Ok(listening) => {
                owner.listening = listening;
                self.write_owner_info(&owner.listening)?;
                match owner.listening.https_port {
                    port if port == self.ports.https => Ok(()),
                    port => Err(format!("Port {} still isn't available, so Tusk keeps using port {port}.", self.ports.https)),
                }
            }
            Err(e) => {
                let _ = fs::remove_file(self.inner.dir.join("owner.json"));
                *slot = None;
                Err(e)
            }
        }
    }
}

impl Drop for Instance {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.get_mut().take() {
            let _ = fs::remove_file(self.inner.dir.join("owner.json"));
            drop(owner);
        }
        let routes = self.inner.dir.join("routes");
        let _ = fs::remove_file(routes.join(format!("{}.json", self.inner.id)));
        let _ = fs::remove_file(routes.join(format!("{}.lock", self.inner.id)));
    }
}

/// A random ID for an instance. Process IDs get reused, so they're not enough.
fn random_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::hash::RandomState::new().build_hasher();
    hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
    hasher.write_u32(std::process::id());
    format!("{:016x}", hasher.finish())
}

/// This process's instance, made on first use.
static INSTANCE: Mutex<Option<Arc<Instance>>> = Mutex::new(None);

fn current() -> Option<Arc<Instance>> {
    INSTANCE.lock().unwrap().clone()
}

fn instance(dir: &Path, ca: ca::Ca) -> Result<Arc<Instance>, String> {
    let mut slot = INSTANCE.lock().unwrap();
    if let Some(me) = slot.as_ref() {
        me.set_ca(ca);
        return Ok(me.clone());
    }
    let ports = Ports { https: HTTPS_PORT, fallback: FALLBACK_PORT, http: Some(HTTP_PORT), dns: DNS_PORT };
    let me = Instance::new(dir.to_path_buf(), ports, ca)?;
    *slot = Some(me.clone());
    Ok(me)
}

/// Stops this process's routes and listeners, as the app exits.
pub fn shutdown() {
    INSTANCE.lock().unwrap().take();
}

fn valid_name(name: &str) -> bool {
    (1..=63).contains(&name.len())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-')
}

fn url(name: &str, https_port: u16) -> String {
    match https_port {
        443 => format!("https://{name}.test"),
        port => format!("https://{name}.test:{port}"),
    }
}

/// A free port on 127.0.0.1 for the PHP server.
fn free_port() -> Result<u16, String> {
    std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).and_then(|l| l.local_addr()).map(|a| a.port()).map_err(|e| e.to_string())
}

/// Whether `name.test` resolves to this computer, giving up after 2 seconds.
async fn resolves(name: &str) -> bool {
    let host = format!("{name}.test");
    let lookup = tokio::task::spawn_blocking(move || (host.as_str(), 443).to_socket_addrs().is_ok_and(|mut a| a.any(|a| a.ip().is_loopback())));
    matches!(tokio::time::timeout(Duration::from_secs(2), lookup).await, Ok(Ok(true)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainStart {
    url: String,
    /// The port on 127.0.0.1 for the PHP server to listen on.
    port: u16,
    notes: Vec<String>,
    can_use_port_443: bool,
}

/// Serves `https://<name>.test` from a new port for the PHP server, setting up the system first if needed.
#[tauri::command]
pub async fn local_domain_start(app: AppHandle, name: String) -> Result<DomainStart, String> {
    if !valid_name(&name) {
        return Err(format!("\"{name}\" can't be a .test domain. Use up to 63 lowercase letters, digits, and hyphens, not starting or ending with a hyphen."));
    }
    let dir = shared_dir(&app)?;
    let loaded = {
        let dir = dir.clone();
        crate::blocking(move || ca::ensure(&dir)).await?
    };
    let me = instance(&dir, loaded)?;
    // Checked before setup, so a taken name doesn't ask for a password first.
    if let Some(conflict) = me.conflict(&name) {
        return Err(conflict);
    }
    let mut names = me.names();
    names.push(name.clone());
    let wanted = localsystem::Wanted { ca_pem: ca_pem_path(&dir), dns_port: DNS_PORT, names };
    let label = name.clone();
    let mut notes = crate::blocking(move || {
        let status = localsystem::status(&wanted);
        if status.ca_trusted && status.resolver && status.missing_hosts.is_empty() {
            return Ok(Vec::new());
        }
        localsystem::apply(&wanted, false).map_err(|e| match e.as_str() {
            "cancelled" => format!("Setup was cancelled, so https://{label}.test can't be served."),
            _ => e,
        })
    })
    .await?;
    let port = free_port()?;
    me.register(&name, port)?;
    let https_port = match me.ensure_listeners().await {
        Ok((https_port, more)) => {
            notes.extend(more);
            https_port
        }
        Err(e) => {
            let _ = me.unregister(&name);
            return Err(e);
        }
    };
    if !resolves(&name).await {
        notes.push(format!("{name}.test doesn't resolve to this computer yet. The browser may need a minute, or a restart, to pick up the new DNS settings."));
    }
    Ok(DomainStart { url: url(&name, https_port), port, notes, can_use_port_443: cfg!(target_os = "linux") && https_port != HTTPS_PORT })
}

/// Stops serving `name` from this process. Stopping a name that isn't served does nothing.
#[tauri::command]
pub fn local_domain_stop(name: String) -> Result<(), String> {
    current().map_or(Ok(()), |me| me.unregister(&name))
}

/// Lets the proxy use ports 443 and 80 (Linux), then moves this process's listeners there if it's the owner.
#[tauri::command]
pub async fn local_domains_allow_port_443(app: AppHandle) -> Result<(), String> {
    let dir = shared_dir(&app)?;
    let names = current().map(|me| me.names()).unwrap_or_default();
    let wanted = localsystem::Wanted { ca_pem: ca_pem_path(&dir), dns_port: DNS_PORT, names };
    let notes = crate::blocking(move || localsystem::apply(&wanted, true)).await?;
    notes.iter().for_each(|n| eprintln!("local domains: {n}"));
    match current() {
        Some(me) => me.rebind().await,
        None => Ok(()),
    }
}

/// Stops serving .test domains and undoes the system setup, removing the CA.
#[tauri::command]
pub async fn local_domains_remove(app: AppHandle) -> Result<(), String> {
    let dir = shared_dir(&app)?;
    let me = current().map(|me| me.inner.id.clone()).unwrap_or_default();
    if others(&dir, &me).iter().any(|routes| !routes.is_empty()) {
        return Err("Other Tusk windows are serving .test domains. Stop them first.".into());
    }
    let ca_pem = ca_pem_path(&dir);
    crate::blocking(move || localsystem::remove(&ca_pem)).await?;
    shutdown();
    for file in ["ca.pem", "ca-key.pem", "owner.json"] {
        let _ = fs::remove_file(dir.join(file));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use std::net::Ipv4Addr;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tusk-local-domains-{}", random_id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn free() -> u16 {
        free_port().unwrap()
    }

    fn verifier(ca: &CertificateDer<'static>) -> Arc<rustls::client::WebPkiServerVerifier> {
        let mut roots = rustls::RootCertStore::empty();
        roots.add(ca.clone()).unwrap();
        rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), Arc::new(rustls::crypto::ring::default_provider())).build().unwrap()
    }

    #[test]
    fn names() {
        assert!(valid_name("shop") && valid_name("my-shop2") && valid_name(&"a".repeat(63)));
        assert!(!valid_name("") && !valid_name("-shop") && !valid_name("shop-") && !valid_name("Shop") && !valid_name("a.b") && !valid_name(&"a".repeat(64)));
        assert_eq!(url("shop", 443), "https://shop.test");
        assert_eq!(url("shop", 8443), "https://shop.test:8443");
    }

    #[test]
    fn certificates() {
        use rustls::client::danger::ServerCertVerifier;
        let dir = temp_dir();
        let made = ca::ensure(&dir).unwrap();
        let loaded = ca::ensure(&dir).unwrap();
        assert_eq!(made.der, loaded.der, "the saved CA is reused");
        assert_eq!(ca_fingerprint(&dir).unwrap(), ca::fingerprint(&made.der));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(dir.join("ca-key.pem")).unwrap().permissions().mode() & 0o777, 0o600);
        }

        let verifier = verifier(&loaded.der);
        let verify = |cert: &CertificateDer<'_>, name: &str| verifier.verify_server_cert(cert, &[], &ServerName::try_from(name.to_string()).unwrap(), &[], UnixTime::now());
        let leaf = loaded.leaf("shop.test").unwrap();
        verify(&leaf.cert[0], "shop.test").unwrap();
        assert!(verify(&leaf.cert[0], "other.test").is_err());
        // The name constraint stops the CA from vouching for anything outside .test.
        let outside = loaded.leaf("example.com").unwrap();
        let err = verify(&outside.cert[0], "example.com").unwrap_err();
        assert!(format!("{err:?}").contains("NameConstraint"), "{err:?}");
        let _ = fs::remove_dir_all(dir);
    }

    /// An upstream that answers every connection with `body`.
    async fn upstream(body: &'static str) -> u16 {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut tcp, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    let _ = tcp.read(&mut buf).await;
                    let _ = tcp.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
                });
            }
        });
        port
    }

    /// Requests `/` from `name` through the proxy on `port`, trusting `ca`.
    async fn get(port: u16, ca: &CertificateDer<'static>, name: &str) -> String {
        request(port, ca, name, "").await
    }

    /// Like `get`, with `headers`, each line ending in CRLF.
    async fn request(port: u16, ca: &CertificateDer<'static>, name: &str, headers: &str) -> String {
        let mut roots = rustls::RootCertStore::empty();
        roots.add(ca.clone()).unwrap();
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let tcp = tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap();
        let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
        let mut tls = connector.connect(ServerName::try_from(name.to_string()).unwrap(), tcp).await.unwrap();
        tls.write_all(format!("GET / HTTP/1.1\r\nHost: {name}\r\n{headers}\r\n").as_bytes()).await.unwrap();
        let mut response = Vec::new();
        let _ = tls.read_to_end(&mut response).await;
        String::from_utf8_lossy(&response).into_owned()
    }

    fn test_ports() -> Ports {
        Ports { https: free(), fallback: free(), http: None, dns: free() }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn proxies_by_name() {
        let dir = temp_dir();
        let ports = test_ports();
        let a = Instance::new(dir.clone(), ports.clone(), ca::ensure(&dir).unwrap()).unwrap();
        let shop = upstream("shop body").await;
        a.register("shop", shop).unwrap();
        let (https, notes) = a.ensure_listeners().await.unwrap();
        assert_eq!((https, notes.len()), (ports.https, 0));
        let ca = a.inner.ca().der.clone();
        assert!(get(https, &ca, "shop.test").await.ends_with("shop body"));
        let missing = get(https, &ca, "nope.test").await;
        assert!(missing.starts_with("HTTP/1.1 503") && missing.contains("text/plain") && missing.contains("nope.test isn't running"), "{missing}");
        assert!(missing.contains("\r\nX-Tusk-Proxy: unavailable\r\n") && missing.contains("\r\nRetry-After: 2\r\n"), "{missing}");
        let html = "Accept: text/html,*/*\r\n";
        let page = request(https, &ca, "nope.test", html).await;
        assert!(page.starts_with("HTTP/1.1 503 Service Unavailable\r\n") && page.contains("text/html"), "{page}");
        assert!(page.contains("\r\nX-Tusk-Proxy: unavailable\r\n") && page.contains("\r\nRetry-After: 2\r\n") && page.contains("\r\nCache-Control: no-store\r\n"));
        assert!(page.contains("<code>nope.test</code> isn't running") && page.contains("<a href=\"https://shop.test/\">"), "{page}");

        // Registered, but nothing listens on its port.
        a.register("down", free()).unwrap();
        assert!(get(https, &ca, "down.test").await.contains("isn't answering on port"));
        let page = request(https, &ca, "down.test", html).await;
        assert!(page.starts_with("HTTP/1.1 502 Bad Gateway\r\n") && page.contains("\r\nX-Tusk-Proxy: unavailable\r\n"), "{page}");
        assert!(page.contains("<code>down.test</code> isn't answering") && !page.contains("Running in Tusk"), "{page}");

        // The DNS responder runs beside the proxy.
        let socket = tokio::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        socket.send_to(&dns::query("shop.test", 1), (Ipv4Addr::LOCALHOST, ports.dns)).await.unwrap();
        let mut buf = [0u8; 512];
        let n = tokio::time::timeout(Duration::from_secs(2), socket.recv(&mut buf)).await.unwrap().unwrap();
        assert!(buf[..n].ends_with(&[127, 0, 0, 1]));
        assert!(dns::probe(ports.dns).await);
        drop(a);
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn falls_back_when_the_port_is_taken() {
        let dir = temp_dir();
        let ports = test_ports();
        // Another program on 127.0.0.1 takes loopback traffic even where a wildcard bind would succeed.
        let taken = TcpListener::bind((Ipv4Addr::LOCALHOST, ports.https)).await.unwrap();
        let a = Instance::new(dir.clone(), ports.clone(), ca::ensure(&dir).unwrap()).unwrap();
        a.register("shop", upstream("shop body").await).unwrap();
        let (https, _) = a.ensure_listeners().await.unwrap();
        assert_eq!(https, ports.fallback);
        assert!(get(https, &a.inner.ca().der.clone(), "shop.test").await.ends_with("shop body"));
        assert!(a.rebind().await.unwrap_err().contains("still isn't available"));

        // Once the port is free, the owner moves there.
        drop(taken);
        a.rebind().await.unwrap();
        assert_eq!(a.owner_info().unwrap().https_port, ports.https);
        assert!(get(ports.https, &a.inner.ca().der.clone(), "shop.test").await.ends_with("shop body"));
        drop(a);
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn falls_back_to_a_system_port_when_both_are_taken() {
        let dir = temp_dir();
        let ports = test_ports();
        let _https = TcpListener::bind((Ipv4Addr::LOCALHOST, ports.https)).await.unwrap();
        let _fallback = TcpListener::bind((Ipv4Addr::LOCALHOST, ports.fallback)).await.unwrap();
        let a = Instance::new(dir.clone(), ports.clone(), ca::ensure(&dir).unwrap()).unwrap();
        a.register("shop", upstream("shop body").await).unwrap();
        let (https, _) = a.ensure_listeners().await.unwrap();
        assert!(https != 0 && https != ports.https && https != ports.fallback);
        assert!(get(https, &a.inner.ca().der.clone(), "shop.test").await.ends_with("shop body"));
        drop(a);
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn shares_and_hands_over_the_proxy() {
        let dir = temp_dir();
        let ports = test_ports();
        let a = Instance::new(dir.clone(), ports.clone(), ca::ensure(&dir).unwrap()).unwrap();
        let b = Instance::new(dir.clone(), ports.clone(), ca::ensure(&dir).unwrap()).unwrap();
        let ca = a.inner.ca().der.clone();
        a.register("a", upstream("a body").await).unwrap();
        a.ensure_listeners().await.unwrap();
        b.register("b", upstream("b body").await).unwrap();
        let (https, _) = b.ensure_listeners().await.unwrap();
        assert_eq!(https, ports.https, "B uses A's listeners");
        assert!(b.owner.lock().await.is_none());
        assert!(get(https, &ca, "b.test").await.ends_with("b body"), "A serves B's route");

        assert!(a.register("b", 1).unwrap_err().contains("another Tusk window"));
        assert!(b.register("b", 1).unwrap_err().contains("this Tusk window"));

        // A dead process's routes are ignored and cleaned up.
        let routes = dir.join("routes");
        fs::write(routes.join("dead.json"), r#"{"zombie": 1}"#).unwrap();
        File::create(routes.join("dead.lock")).unwrap();
        assert_eq!(a.inner.lookup("zombie"), None);
        assert!(!routes.join("dead.json").exists() && !routes.join("dead.lock").exists());
        b.register("zombie", 1).unwrap();

        // A quits; B takes over on its next tick.
        drop(a);
        tokio::time::sleep(Duration::from_millis(200)).await;
        b.tick().await;
        assert!(b.owner.lock().await.is_some());
        assert!(get(https, &ca, "b.test").await.ends_with("b body"));
        assert!(get(https, &ca, "a.test").await.starts_with("HTTP/1.1 503"));
        drop(b);
        let _ = fs::remove_dir_all(dir);
    }
}
