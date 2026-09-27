//! Drives the real server over a whole project, file by file: every request at random places in each file, then again
//! with the file cut off at random points, as typing leaves it. Reports crashes, hangs, and the slowest requests.
//!
//! `cargo run --release --example stress <root> [max files] [seed]`
//!
//! A crash is a request answered with "tusk crashed" (a caught panic); a stack overflow or abort ends this process,
//! and the last "file" line printed names the file. A hang is a request unanswered for 30 s.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use lsp_server::{Connection, Message, Notification, Request, RequestId, Response};
use serde_json::{Value, json};

struct Client {
    conn: Connection,
    next: i32,
    stats: BTreeMap<&'static str, Stat>,
    failures: Vec<String>,
    file: String,
}

#[derive(Default)]
struct Stat {
    count: u32,
    total: Duration,
    max: Duration,
    worst: String,
}

impl Client {
    fn notify(&self, method: &str, params: Value) {
        self.conn.sender.send(Message::Notification(Notification::new(method.into(), params))).unwrap();
    }

    /// Sends a request and waits for its answer, answering the server's own requests with null on the way.
    fn request(&mut self, method: &'static str, params: Value) -> Option<Value> {
        let id = RequestId::from(self.next);
        self.next += 1;
        let started = Instant::now();
        self.conn.sender.send(Message::Request(Request::new(id.clone(), method.into(), params.clone()))).unwrap();
        loop {
            let Ok(msg) = self.conn.receiver.recv_timeout(Duration::from_secs(30)) else {
                self.failures.push(format!("HANG {method} in {} at {params}", self.file));
                eprintln!("HANG {method} in {}", self.file);
                return None;
            };
            match msg {
                Message::Request(req) => {
                    self.conn.sender.send(Message::Response(Response::new_ok(req.id, Value::Null))).unwrap();
                }
                Message::Response(r) if r.id == id => {
                    let took = started.elapsed();
                    let stat = self.stats.entry(method).or_default();
                    stat.count += 1;
                    stat.total += took;
                    if took > stat.max {
                        stat.max = took;
                        stat.worst = format!("{} {}", self.file, params.get("position").map(|p| p.to_string()).unwrap_or_default());
                    }
                    return match r.response_result {
                        Err(e) if e.message.contains("crashed") => {
                            self.failures.push(format!("CRASH {method} in {} at {params}: {}", self.file, e.message));
                            eprintln!("CRASH {method} in {}: {}", self.file, e.message);
                            None
                        }
                        Err(_) => None,
                        Ok(v) => Some(v),
                    };
                }
                _ => {}
            }
        }
    }

    /// Waits for the index build to finish.
    fn wait_indexed(&mut self) {
        loop {
            match self.conn.receiver.recv_timeout(Duration::from_secs(600)).expect("indexing finishes") {
                Message::Request(req) => {
                    self.conn.sender.send(Message::Response(Response::new_ok(req.id, Value::Null))).unwrap();
                }
                Message::Notification(n) if n.method == "$/progress" && n.params.pointer("/value/kind") == Some(&json!("end")) => {
                    println!("{}", n.params.pointer("/value/message").and_then(Value::as_str).unwrap_or(""));
                    return;
                }
                _ => {}
            }
        }
    }
}

/// A small deterministic generator, so a failing run can be repeated with its seed.
struct Rng(u64);
impl Rng {
    fn below(&mut self, n: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % n.max(1) as u64) as usize
    }
}

/// The LSP position (UTF-16 columns) of a byte offset.
fn position(text: &str, offset: usize) -> Value {
    let before = &text[..offset];
    let line = before.matches('\n').count();
    let start = before.rfind('\n').map_or(0, |i| i + 1);
    json!({ "line": line, "character": before[start..].encode_utf16().count() })
}

fn end_of(text: &str) -> Value {
    position(text, text.len())
}

/// Byte offsets at a char boundary, favouring the middle of names, where requests do the most work.
fn offsets(text: &str, rng: &mut Rng, n: usize) -> Vec<usize> {
    let names: Vec<usize> = text.char_indices().filter(|(_, c)| c.is_alphanumeric() || *c == '$').map(|(i, _)| i).collect();
    (0..n).filter_map(|_| names.get(rng.below(names.len())).copied()).collect()
}

fn php_files(root: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = ignore::WalkBuilder::new(root)
        .standard_filters(false)
        .build()
        .flatten()
        .map(|e| e.into_path())
        .filter(|p| p.extension().is_some_and(|e| e == "php") && !p.components().any(|c| c.as_os_str() == "node_modules"))
        .collect();
    files.sort();
    files
}

fn main() {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(args.next().expect("a project root")).canonicalize().unwrap();
    let max: usize = args.next().map_or(usize::MAX, |n| n.parse().unwrap());
    let seed: u64 = args.next().map_or(0x9e3779b97f4a7c15, |n| n.parse().unwrap());
    let mut rng = Rng(seed);

    let (server, conn) = Connection::memory();
    std::thread::spawn(move || tusk_lsp::server::run(server));
    let mut c = Client { conn, next: 1, stats: BTreeMap::new(), failures: vec![], file: String::new() };
    let root_uri = format!("file://{}", root.display());
    let started = Instant::now();
    c.request("initialize", json!({ "processId": null, "rootUri": root_uri, "workspaceFolders": [{ "uri": root_uri, "name": "p" }], "capabilities": {} }));
    c.notify("initialized", json!({}));
    c.wait_indexed();
    println!("index ready after {:.1} s", started.elapsed().as_secs_f32());

    let mut files = php_files(&root);
    // Vendor code is the bulk of most projects; a sample of it is enough.
    if files.len() > max {
        let step = files.len() as f64 / max as f64;
        files = (0..max).map(|i| files[(i as f64 * step) as usize].clone()).collect();
    }
    let total = files.len();
    for (n, path) in files.iter().enumerate() {
        let Ok(text) = std::fs::read_to_string(path) else { continue };
        c.file = path.strip_prefix(&root).unwrap_or(path).display().to_string();
        println!("file {}/{total} {}", n + 1, c.file);
        let uri = format!("file://{}", path.display());
        let doc = json!({ "uri": uri });
        c.notify("textDocument/didOpen", json!({ "textDocument": { "uri": uri, "languageId": "php", "version": 1, "text": text } }));
        let mut version = 1;

        whole_file(&mut c, &doc, &text);
        for offset in offsets(&text, &mut rng, 6) {
            at(&mut c, &doc, &text, offset, true);
        }
        // Cut off where typing could leave it, then ask again where the cursor would be.
        for _ in 0..3 {
            let mut cut = rng.below(text.len());
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            let partial = &text[..cut];
            version += 1;
            c.notify("textDocument/didChange", json!({ "textDocument": { "uri": uri, "version": version }, "contentChanges": [{ "text": partial }] }));
            whole_file(&mut c, &doc, partial);
            at(&mut c, &doc, partial, cut, false);
            // And the same cut with the rest of the file still after it, as an edit in the middle leaves it.
            let typed = format!("{partial}$x->{}", &text[cut..]);
            version += 1;
            c.notify("textDocument/didChange", json!({ "textDocument": { "uri": uri, "version": version }, "contentChanges": [{ "text": typed }] }));
            at(&mut c, &doc, &typed, cut + 4, false);
        }
        c.notify("textDocument/didClose", json!({ "textDocument": { "uri": uri } }));
    }

    for query in ["", "a", "Controller", "zzzz"] {
        c.request("workspace/symbol", json!({ "query": query }));
    }
    c.file = "(project)".into();
    c.request("tusk/projectProblems", json!({}));

    println!("\n{:<36} {:>7} {:>9} {:>9}  slowest", "method", "count", "mean ms", "max ms");
    for (method, s) in &c.stats {
        let mean = s.total.as_secs_f64() * 1000.0 / s.count.max(1) as f64;
        println!("{method:<36} {:>7} {mean:>9.1} {:>9.1}  {}", s.count, s.max.as_secs_f64() * 1000.0, s.worst);
    }
    println!("\n{} files in {:.0} s, {} failures", total, started.elapsed().as_secs_f32(), c.failures.len());
    for f in &c.failures {
        println!("{f}");
    }
    c.request("shutdown", Value::Null);
    c.notify("exit", Value::Null);
    std::process::exit(if c.failures.is_empty() { 0 } else { 1 });
}

fn whole_file(c: &mut Client, doc: &Value, text: &str) {
    let range = json!({ "start": { "line": 0, "character": 0 }, "end": end_of(text) });
    c.request("textDocument/documentSymbol", json!({ "textDocument": doc }));
    c.request("textDocument/foldingRange", json!({ "textDocument": doc }));
    c.request("textDocument/inlayHint", json!({ "textDocument": doc, "range": range }));
    c.request("textDocument/codeLens", json!({ "textDocument": doc }));
    c.request("textDocument/documentLink", json!({ "textDocument": doc }));
}

/// Every position request at `offset`; `full` adds the ones that search the project.
fn at(c: &mut Client, doc: &Value, text: &str, offset: usize, full: bool) {
    let p = position(text, offset);
    let tp = json!({ "textDocument": doc, "position": p });
    c.request("textDocument/hover", tp.clone());
    c.request("textDocument/definition", tp.clone());
    c.request("textDocument/signatureHelp", tp.clone());
    c.request("textDocument/documentHighlight", tp.clone());
    c.request("textDocument/selectionRange", json!({ "textDocument": doc, "positions": [p] }));
    if let Some(list) = c.request("textDocument/completion", tp.clone()) {
        let items = list.get("items").or(Some(&list)).and_then(Value::as_array).cloned().unwrap_or_default();
        if let Some(item) = items.first() {
            c.request("completionItem/resolve", item.clone());
        }
    }
    let actions = c.request(
        "textDocument/codeAction",
        json!({ "textDocument": doc, "range": { "start": p, "end": p }, "context": { "diagnostics": [] } }),
    );
    // Resolving builds each action's edit, which is where most of their work is.
    for action in actions.and_then(|a| a.as_array().cloned()).unwrap_or_default() {
        if action.get("data").is_some() {
            c.request("codeAction/resolve", action);
        }
    }
    if full {
        c.request("textDocument/typeDefinition", tp.clone());
        c.request("textDocument/implementation", tp.clone());
        c.request("textDocument/references", json!({ "textDocument": doc, "position": p, "context": { "includeDeclaration": true } }));
        if c.request("textDocument/prepareRename", tp.clone()).is_some_and(|r| !r.is_null()) {
            c.request("textDocument/rename", json!({ "textDocument": doc, "position": p, "newName": "renamed" }));
        }
    }
}
