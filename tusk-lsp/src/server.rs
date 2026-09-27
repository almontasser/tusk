//! The protocol loop: document sync, the indexer thread, and dispatching requests to a thread pool.
//!
//! The main loop never waits on analysis. Edits update the open document at once and queue an index update on
//! the indexer thread; each request runs on the pool once the index has caught up with the edits made before it.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};
use lsp_server::{Connection, ErrorCode, Message, Notification, Request, RequestId, Response};
use lsp_types::notification::Notification as _;
use lsp_types::request::Request as _;
use lsp_types::*;
use parking_lot::{Condvar, Mutex, RwLock};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::documents::{Document, Documents};
use crate::index::{Index, IndexConfig, SharedIndex};
use crate::text::{path_to_uri, uri_to_path};
use crate::{capabilities, diagnostics, handlers};

/// `initializationOptions`, all optional.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Options {
    /// Globs relative to the project root that the index skips, on top of its defaults.
    pub exclude: Vec<String>,
    /// Extra PHP files or folders to index as library code.
    pub stubs: Vec<PathBuf>,
    /// The PHP version to analyze for, such as `8.3`. By default, from `mago.toml` or `composer.json`.
    pub php_version: Option<String>,
    /// The Mago configuration to use. By default, the project's `mago.toml`.
    pub mago_config: Option<PathBuf>,
    /// Index every library file in full, not only what the project reaches. Uses several times the memory.
    pub load_all_libraries: bool,
}

/// The index's configuration from the options and the project's files.
pub fn index_config(root: &Path, options: &Options) -> IndexConfig {
    let mut config = IndexConfig::new(root);
    let mago_path = options.mago_config.clone().unwrap_or_else(|| root.join("mago.toml"));
    let mago = crate::mago_config::MagoConfig::load(&mago_path, root).unwrap_or_else(|e| {
        eprintln!("tusk: {e}");
        Default::default()
    });
    config.exclude = options.exclude.clone();
    // Hidden folders are skipped anyway, and `vendor` is indexed as library code.
    config.exclude.extend(mago.excludes.iter().filter(|e| !e.starts_with('.') && *e != "vendor").cloned());
    config.stubs = options.stubs.clone();
    config.stubs.extend(mago.includes.iter().cloned());
    config.php_version = options
        .php_version
        .as_deref()
        .and_then(parse_php_version)
        .or(mago.php_version)
        .or_else(|| composer_php_version(root))
        .unwrap_or(config.php_version);
    config.mago = Arc::new(mago);
    config.load_all = options.load_all_libraries;
    config
}

/// What a request handler reads: the open documents as they were when it arrived, and the index.
pub struct Snapshot {
    pub docs: Documents,
    pub index: SharedIndex,
    pub root: PathBuf,
    pub framework: Arc<crate::framework::State>,
    /// The editor, for requests such as applying an edit. `None` in tests.
    pub client: Option<Client>,
    /// Set when the editor cancels the request. Long requests check it and return [`CANCELLED`].
    pub cancel: Arc<AtomicBool>,
}

/// The error of a request the editor cancelled, answered with the protocol's cancellation code.
pub const CANCELLED: &str = "Cancelled";

impl Snapshot {
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// The open document at `uri`, or the file on disk as a document.
    pub fn doc(&self, uri: &Uri) -> Option<Arc<Document>> {
        let path = uri_to_path(uri)?;
        if let Some(doc) = self.docs.get(&path) {
            return Some(doc.clone());
        }
        let text = std::fs::read(&path).ok()?;
        Some(Arc::new(Document::new(uri.clone(), path, "php".into(), 0, String::from_utf8_lossy(&text).into_owned())))
    }

    pub fn read(&self, path: &Path) -> Option<String> {
        self.docs.read(path)
    }
}

enum Job {
    /// Discover and index the whole project, replacing the index, with a new configuration if given.
    Build(Option<IndexConfig>),
    /// A file's new text, or `None` if it's gone. Open documents give their text; closed ones are read from disk.
    Change(PathBuf, Option<Vec<u8>>),
}

/// The thread that owns index updates, so a slow reader never holds up the main loop.
struct Indexer {
    tx: Sender<Job>,
    queued: AtomicU64,
    applied: Arc<(Mutex<u64>, Condvar)>,
}

impl Indexer {
    fn send(&self, job: Job) {
        self.queued.fetch_add(1, Ordering::SeqCst);
        let _ = self.tx.send(job);
    }

    /// A ticket that [`wait`] returns for once every job queued so far is applied.
    fn ticket(&self) -> u64 {
        self.queued.load(Ordering::SeqCst)
    }
}

fn wait(applied: &(Mutex<u64>, Condvar), ticket: u64) {
    let mut done = applied.0.lock();
    while *done < ticket {
        applied.1.wait(&mut done);
    }
}

/// Sends messages to the client from any thread, numbering the server's own requests.
#[derive(Clone)]
pub struct Client {
    sender: Sender<Message>,
    next_id: Arc<AtomicI32>,
    /// Requests the server sent and is waiting on, by ID.
    waiting: Arc<Mutex<HashMap<RequestId, Sender<Response>>>>,
}

impl Client {
    pub fn notify<N: lsp_types::notification::Notification>(&self, params: N::Params) {
        let _ = self.sender.send(Message::Notification(Notification::new(N::METHOD.into(), params)));
    }

    pub fn request<R: lsp_types::request::Request>(&self, params: R::Params) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let _ = self.sender.send(Message::Request(Request::new(RequestId::from(format!("tusk/{id}")), R::METHOD.into(), params)));
    }

    /// Sends a request and waits up to `timeout` for the answer.
    pub fn request_and_wait<R: lsp_types::request::Request>(&self, params: R::Params, timeout: Duration) -> Option<R::Result> {
        let id = RequestId::from(format!("tusk/{}", self.next_id.fetch_add(1, Ordering::Relaxed)));
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.waiting.lock().insert(id.clone(), tx);
        let _ = self.sender.send(Message::Request(Request::new(id.clone(), R::METHOD.into(), params)));
        let answer = rx.recv_timeout(timeout).ok();
        self.waiting.lock().remove(&id);
        serde_json::from_value(answer?.response_result.ok()?).ok()
    }

    /// Asks the editor to apply an edit, and whether it did.
    pub fn apply_edit(&self, label: &str, edit: WorkspaceEdit) -> bool {
        self.request_and_wait::<request::ApplyWorkspaceEdit>(
            ApplyWorkspaceEditParams { label: Some(label.into()), edit },
            Duration::from_secs(30),
        )
        .is_some_and(|r| r.applied)
    }

    /// Hands an answer to a request the server sent to whoever waits on it.
    fn answered(&self, response: Response) {
        if let Some(tx) = self.waiting.lock().remove(&response.id) {
            let _ = tx.send(response);
        }
    }

    fn respond(&self, response: Response) {
        let _ = self.sender.send(Message::Response(response));
    }

    /// Reports a long task's progress. Titles starting with "Indexing" drive the editor's status bar.
    pub fn progress(&self, token: &str, value: WorkDoneProgress) {
        self.notify::<notification::Progress>(ProgressParams {
            token: NumberOrString::String(token.into()),
            value: ProgressParamsValue::WorkDone(value),
        });
    }
}

pub struct Server {
    client: Client,
    docs: Arc<RwLock<Documents>>,
    index: SharedIndex,
    indexer: Indexer,
    diagnostics: Sender<diagnostics::Event>,
    framework: Arc<crate::framework::State>,
    phpstan: Arc<crate::phpstan::PhpStan>,
    pool: rayon::ThreadPool,
    /// Requests being answered, by ID, with their cancellation flags.
    running: Arc<Mutex<HashMap<RequestId, Arc<AtomicBool>>>>,
    root: PathBuf,
    options: Options,
    shutting_down: bool,
}

/// Runs a language server on stdin and stdout until the client disconnects.
pub fn run_stdio() {
    let (connection, io) = Connection::stdio();
    run(connection);
    let _ = io.join();
}

pub fn run(connection: Connection) {
    let Ok((id, params)) = connection.initialize_start() else { return };
    let params: InitializeParams = serde_json::from_value(params).unwrap_or_default();
    let root = root_of(&params).unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let options: Options =
        params.initialization_options.clone().and_then(|o| serde_json::from_value(o).ok()).unwrap_or_default();
    let result = InitializeResult {
        capabilities: capabilities::server(),
        server_info: Some(ServerInfo { name: "tusk".into(), version: Some(env!("CARGO_PKG_VERSION").into()) }),
    };
    if connection.initialize_finish(id, serde_json::to_value(result).unwrap()).is_err() {
        return;
    }
    let mut server = Server::new(connection.sender.clone(), root, options);
    server.main_loop(&connection.receiver);
}

fn root_of(params: &InitializeParams) -> Option<PathBuf> {
    if let Some(folder) = params.workspace_folders.as_ref().and_then(|f| f.first()) {
        return uri_to_path(&folder.uri);
    }
    #[allow(deprecated)]
    params.root_uri.as_ref().and_then(uri_to_path)
}

/// The PHP version from `composer.json`: `config.platform.php`, else the lowest version `require.php` allows.
pub fn composer_php_version(root: &Path) -> Option<mago_php_version::PHPVersion> {
    let json: Value = serde_json::from_slice(&std::fs::read(root.join("composer.json")).ok()?).ok()?;
    let spec = json.pointer("/config/platform/php").or_else(|| json.pointer("/require/php"))?.as_str()?;
    parse_php_version(spec)
}

/// The first `major.minor` in a version or constraint such as `^8.2|^8.3` or `>=8.1.0`.
pub fn parse_php_version(spec: &str) -> Option<mago_php_version::PHPVersion> {
    let start = spec.find(|c: char| c.is_ascii_digit())?;
    let mut parts = spec[start..].split(|c: char| !c.is_ascii_digit());
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|m| m.parse().ok()).unwrap_or(0);
    Some(mago_php_version::PHPVersion::new(major, minor, 0))
}

impl Server {
    fn new(sender: Sender<Message>, root: PathBuf, options: Options) -> Self {
        let client = Client { sender, next_id: Arc::new(AtomicI32::new(1)), waiting: Default::default() };
        let config = index_config(&root, &options);
        let index: SharedIndex = Arc::new(RwLock::new(Index::empty(config)));
        let docs = Arc::new(RwLock::new(Documents::default()));
        let (tx, rx) = crossbeam_channel::unbounded();
        let applied = Arc::new((Mutex::new(0), Condvar::new()));
        let framework = Arc::new(crate::framework::State::new(root.clone()));
        let phpstan = Arc::new(crate::phpstan::PhpStan::default());
        let diagnostics = diagnostics::spawn(client.clone(), docs.clone(), index.clone(), framework.clone(), phpstan.clone(), root.clone());
        let refresh = diagnostics.clone();
        phpstan.start(&root, move |path| {
            let _ = refresh.send(diagnostics::Event::Refresh(path));
        });
        spawn_indexer(rx, index.clone(), docs.clone(), applied.clone(), client.clone(), diagnostics.clone());
        let indexer = Indexer { tx, queued: AtomicU64::new(0), applied };
        indexer.send(Job::Build(None));
        let pool = rayon::ThreadPoolBuilder::new()
            .thread_name(|i| format!("tusk-request-{i}"))
            // Mago's analyzer recurses deeply on large files.
            .stack_size(64 << 20)
            .build()
            .expect("the request pool starts");
        Self { client, docs, index, indexer, diagnostics, framework, phpstan, pool, running: Default::default(), root, options, shutting_down: false }
    }

    fn main_loop(&mut self, receiver: &Receiver<Message>) {
        for message in receiver {
            match message {
                Message::Request(req) => {
                    if req.method == request::Shutdown::METHOD {
                        self.shutting_down = true;
                        self.client.respond(Response::new_ok(req.id, ()));
                        continue;
                    }
                    if self.shutting_down {
                        self.client.respond(Response::new_err(req.id, ErrorCode::InvalidRequest as i32, "Shutting down".into()));
                        continue;
                    }
                    self.request(req);
                }
                Message::Notification(note) => {
                    if note.method == notification::Exit::METHOD {
                        return;
                    }
                    self.notification(note);
                }
                // Answers to the server's own requests: most (progress tokens, registrations) need no handling.
                Message::Response(response) => self.client.answered(response),
            }
        }
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            docs: self.docs.read().clone(),
            index: self.index.clone(),
            root: self.root.clone(),
            framework: self.framework.clone(),
            client: Some(self.client.clone()),
            cancel: Default::default(),
        }
    }

    /// Runs a request on the pool after the index catches up. A panic answers with an error instead of taking
    /// the server down.
    fn spawn(&self, id: RequestId, run: impl FnOnce(&Snapshot) -> Result<Value, String> + Send + 'static) {
        let snapshot = self.snapshot();
        let ticket = self.indexer.ticket();
        let applied = self.indexer.applied.clone();
        let client = self.client.clone();
        let running = self.running.clone();
        running.lock().insert(id.clone(), snapshot.cancel.clone());
        self.pool.spawn(move || {
            wait(&applied, ticket);
            let result = match snapshot.is_cancelled() {
                true => Ok(Err(CANCELLED.to_string())),
                false => std::panic::catch_unwind(AssertUnwindSafe(|| run(&snapshot))),
            };
            running.lock().remove(&id);
            let response = match result {
                Ok(Err(message)) if message == CANCELLED => Response::new_err(id, ErrorCode::RequestCanceled as i32, message),
                Ok(Ok(value)) => Response::new_ok(id, value),
                Ok(Err(message)) => Response::new_err(id, ErrorCode::RequestFailed as i32, message),
                Err(panic) => {
                    let message = panic
                        .downcast_ref::<String>()
                        .cloned()
                        .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                        .unwrap_or_default();
                    Response::new_err(id, ErrorCode::InternalError as i32, format!("tusk crashed: {message}"))
                }
            };
            client.respond(response);
        });
    }

    fn request(&mut self, req: Request) {
        let Request { id, method, params } = req;
        if let Some(handler) = handlers::find(&method) {
            self.spawn(id, move |snap| handler(snap, params));
            return;
        }
        match method.as_str() {
            "tusk/reindex" => {
                self.framework.clear();
                // The configuration may have changed too, such as a regenerated mago.toml.
                self.indexer.send(Job::Build(Some(index_config(&self.root, &self.options))));
                self.client.respond(Response::new_ok(id, ()));
            }
            _ => self.client.respond(Response::new_err(id, ErrorCode::MethodNotFound as i32, format!("Unknown method {method}"))),
        }
    }

    fn notification(&mut self, note: Notification) {
        match note.method.as_str() {
            notification::Cancel::METHOD => {
                let Some(p) = extract::<CancelParams>(note) else { return };
                let id = match p.id {
                    NumberOrString::Number(n) => RequestId::from(n),
                    NumberOrString::String(s) => RequestId::from(s),
                };
                if let Some(cancel) = self.running.lock().get(&id) {
                    cancel.store(true, Ordering::Relaxed);
                }
            }
            notification::DidOpenTextDocument::METHOD => {
                let Some(p) = extract::<DidOpenTextDocumentParams>(note) else { return };
                let Some(path) = uri_to_path(&p.text_document.uri) else { return };
                let doc = Document::new(p.text_document.uri, path.clone(), p.text_document.language_id, p.text_document.version, p.text_document.text);
                self.phpstan.check(&path);
                self.changed(path, doc);
            }
            notification::DidChangeTextDocument::METHOD => {
                let Some(p) = extract::<DidChangeTextDocumentParams>(note) else { return };
                let Some(path) = uri_to_path(&p.text_document.uri) else { return };
                let Some(old) = self.docs.read().get(&path).cloned() else { return };
                let doc = old.apply(p.text_document.version, p.content_changes);
                self.changed(path, doc);
            }
            notification::DidCloseTextDocument::METHOD => {
                let Some(p) = extract::<DidCloseTextDocumentParams>(note) else { return };
                let Some(path) = uri_to_path(&p.text_document.uri) else { return };
                self.docs.write().remove(&path);
                // The index goes back to the file on disk, which may lack unsaved edits.
                self.indexer.send(Job::Change(path.clone(), std::fs::read(&path).ok()));
                self.client.notify::<notification::PublishDiagnostics>(PublishDiagnosticsParams {
                    uri: p.text_document.uri,
                    diagnostics: vec![],
                    version: None,
                });
            }
            notification::DidSaveTextDocument::METHOD => {
                let Some(p) = extract::<DidSaveTextDocumentParams>(note) else { return };
                if let Some(path) = uri_to_path(&p.text_document.uri) {
                    self.framework.changed(&path);
                    self.phpstan.check(&path);
                }
            }
            notification::DidChangeWatchedFiles::METHOD => {
                let Some(p) = extract::<DidChangeWatchedFilesParams>(note) else { return };
                let mut reconfigure = false;
                let open = self.docs.read().clone();
                for change in p.changes {
                    let Some(path) = uri_to_path(&change.uri) else { continue };
                    self.framework.changed(&path);
                    if path.file_name().is_some_and(|n| n == "mago.toml") || path.file_name().is_some_and(|n| n == "composer.lock") {
                        reconfigure = true;
                    }
                    if path.extension().is_none_or(|e| e != "php") {
                        continue;
                    }
                    // An open document's text wins over the disk until it closes.
                    if open.get(&path).is_some() {
                        continue;
                    }
                    let contents = if change.typ == FileChangeType::DELETED { None } else { std::fs::read(&path).ok() };
                    self.indexer.send(Job::Change(path, contents));
                }
                // A new mago.toml, or packages installed or removed, change what's indexed and how.
                if reconfigure {
                    self.indexer.send(Job::Build(Some(index_config(&self.root, &self.options))));
                }
            }
            notification::Initialized::METHOD => {
                // Ask for changes the editor sees on disk, such as a branch switch or a `composer update`.
                self.client.request::<request::RegisterCapability>(RegistrationParams {
                    registrations: vec![Registration {
                        id: "tusk-watch".into(),
                        method: notification::DidChangeWatchedFiles::METHOD.into(),
                        register_options: serde_json::to_value(DidChangeWatchedFilesRegistrationOptions {
                            watchers: ["**/*.php", "**/.env", "lang/**/*.json", "public/**", "composer.lock", "mago.toml"]
                                .into_iter()
                                .map(|g| FileSystemWatcher { glob_pattern: GlobPattern::String(g.into()), kind: None })
                                .collect(),
                        })
                        .ok(),
                    }],
                });
            }
            _ => {}
        }
    }

    fn changed(&mut self, path: PathBuf, doc: Document) {
        let text = doc.text.clone().into_bytes();
        self.docs.write().insert(doc);
        self.indexer.send(Job::Change(path.clone(), Some(text)));
        let _ = self.diagnostics.send(diagnostics::Event::Edited(path));
    }
}

fn extract<P: DeserializeOwned>(note: Notification) -> Option<P> {
    serde_json::from_value(note.params).ok()
}

fn spawn_indexer(
    rx: Receiver<Job>,
    index: SharedIndex,
    docs: Arc<RwLock<Documents>>,
    applied: Arc<(Mutex<u64>, Condvar)>,
    client: Client,
    diagnostics: Sender<diagnostics::Event>,
) {
    std::thread::Builder::new()
        .name("tusk-indexer".into())
        .stack_size(64 << 20)
        .spawn(move || {
            while let Ok(first) = rx.recv() {
                // Take everything already waiting, so a burst of keystrokes costs one update.
                let mut jobs = vec![first];
                jobs.extend(rx.try_iter());
                let count = jobs.len() as u64;
                let mut build: Option<Option<IndexConfig>> = None;
                let mut changes: HashMap<PathBuf, Option<Vec<u8>>> = HashMap::new();
                for job in jobs {
                    match job {
                        Job::Build(config) => {
                            // A later build's configuration wins; one without keeps an earlier one's.
                            build = Some(config.or(build.flatten()));
                            changes.clear();
                        }
                        Job::Change(path, contents) => {
                            changes.insert(path, contents);
                        }
                    }
                }
                let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                    if let Some(config) = build.clone() {
                        rebuild(&index, &docs, &client, config);
                    }
                    if !changes.is_empty() {
                        index.write().update_many(changes.into_iter().collect());
                    }
                }));
                if result.is_err() {
                    // Mago panicked on some file. A rebuild from scratch is the safe state to return to.
                    eprintln!("tusk: the index update failed; rebuilding");
                    let _ = std::panic::catch_unwind(AssertUnwindSafe(|| rebuild(&index, &docs, &client, None)));
                }
                *applied.0.lock() += count;
                applied.1.notify_all();
                let _ = diagnostics.send(diagnostics::Event::IndexChanged);
            }
        })
        .expect("the indexer thread starts");
}

fn rebuild(index: &SharedIndex, docs: &Arc<RwLock<Documents>>, client: &Client, config: Option<IndexConfig>) {
    let token = "tusk/indexing";
    client.request::<request::WorkDoneProgressCreate>(WorkDoneProgressCreateParams {
        token: NumberOrString::String(token.into()),
    });
    client.progress(token, WorkDoneProgress::Begin(WorkDoneProgressBegin {
        title: "Indexing".into(),
        cancellable: Some(false),
        message: None,
        percentage: Some(0),
    }));
    let started = Instant::now();
    let config = config.unwrap_or_else(|| index.read().config.clone());
    let mut fresh = Index::empty(config);
    let paths = fresh.discover();
    let open = docs.read().clone();
    let last = Mutex::new(Instant::now());
    fresh.build(
        paths,
        |path| match open.get(path) {
            Some(doc) => Some(doc.text.clone().into_bytes()),
            None => std::fs::read(path).ok(),
        },
        |done, total| {
            let mut last = last.lock();
            if last.elapsed() > Duration::from_millis(200) {
                *last = Instant::now();
                client.progress(token, WorkDoneProgress::Report(WorkDoneProgressReport {
                    cancellable: None,
                    message: Some(format!("{done}/{total} files")),
                    percentage: Some((done * 100 / total.max(1)) as u32),
                }));
            }
        },
    );
    let files = fresh.files.len();
    *index.write() = fresh;
    client.progress(token, WorkDoneProgress::End(WorkDoneProgressEnd {
        message: Some(format!("Indexed {files} files in {:.1} s", started.elapsed().as_secs_f32())),
    }));
}

pub fn uri(path: &Path) -> Uri {
    path_to_uri(path)
}
