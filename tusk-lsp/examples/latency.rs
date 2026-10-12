//! Request latency while typing, as the editor drives the server: `cargo run --release --example latency <root> <file>`.
//!
//! Opens `file` right after `initialize` and asks for a completion and an outline at once, then types a few lines
//! into its first method a character at a time, asking for a completion at the cursor and a hover after each
//! keystroke, saving after each pass. Prints how long the first answers took, how long indexing took, and the p50,
//! p95, and slowest answers while typing. PHPStan is off. With `CACHE_DIR` set, the index keeps its cache there;
//! without it, in a fresh folder. With `SCAN=1`, a project scan for problems (`tusk/projectProblems`) starts with
//! each pass; with `WATCHED=<n>`, after the first pass, `n` of `vendor`'s files are reported changed on disk, as a
//! branch switch or `composer update` reports them.

use std::time::{Duration, Instant};

use lsp_server::{Connection, Message, Notification, Request, RequestId, Response};
use serde_json::{Value, json};

struct Client {
    conn: Connection,
    next: i32,
    started: Instant,
    indexed: Option<Duration>,
    /// Requests sent without waiting, with when and what, until answered.
    background: Vec<(RequestId, Instant, String)>,
}

impl Client {
    fn notify(&self, method: &str, params: Value) {
        self.conn.sender.send(Message::Notification(Notification::new(method.into(), params))).unwrap();
    }

    /// Sends a request and waits for its answer, noting when indexing ends on the way.
    fn request(&mut self, method: &str, params: Value) -> (Duration, Value) {
        let id = RequestId::from(self.next);
        self.next += 1;
        let sent = Instant::now();
        self.conn.sender.send(Message::Request(Request::new(id.clone(), method.into(), params))).unwrap();
        loop {
            match self.conn.receiver.recv_timeout(Duration::from_secs(120)).expect("an answer") {
                Message::Request(req) => self.conn.sender.send(Message::Response(Response::new_ok(req.id, Value::Null))).unwrap(),
                Message::Response(r) if r.id == id => return (sent.elapsed(), r.response_result.unwrap_or(Value::Null)),
                Message::Response(r) => self.answered(&r.id),
                Message::Notification(n) => self.saw(&n),
            }
        }
    }

    /// Sends a request without waiting for its answer, which is reported when it comes.
    fn send(&mut self, method: &str, params: Value) {
        let id = RequestId::from(self.next);
        self.next += 1;
        self.conn.sender.send(Message::Request(Request::new(id.clone(), method.into(), params))).unwrap();
        self.background.push((id, Instant::now(), method.into()));
    }

    fn answered(&mut self, id: &RequestId) {
        if let Some(i) = self.background.iter().position(|(b, ..)| b == id) {
            let (_, sent, method) = self.background.remove(i);
            println!("{method} answered after {:.0} ms", sent.elapsed().as_secs_f64() * 1000.0);
        }
    }

    fn saw(&mut self, n: &Notification) {
        if n.method == "$/progress" && n.params.pointer("/value/kind") == Some(&json!("end")) && self.indexed.is_none() {
            self.indexed = Some(self.started.elapsed());
            println!("{}", n.params.pointer("/value/message").and_then(Value::as_str).unwrap_or(""));
        }
    }

    fn wait_indexed(&mut self) {
        while self.indexed.is_none() {
            match self.conn.receiver.recv_timeout(Duration::from_secs(600)).expect("indexing finishes") {
                Message::Request(req) => self.conn.sender.send(Message::Response(Response::new_ok(req.id, Value::Null))).unwrap(),
                Message::Notification(n) => self.saw(&n),
                _ => {}
            }
        }
    }
}

/// The LSP position (UTF-16 columns) of a byte offset.
fn position(text: &str, offset: usize) -> Value {
    let before = &text[..offset];
    let line = before.matches('\n').count();
    let start = before.rfind('\n').map_or(0, |i| i + 1);
    json!({ "line": line, "character": before[start..].encode_utf16().count() })
}

fn percentiles(label: &str, mut times: Vec<Duration>) {
    times.sort();
    let at = |p: f64| times[((times.len() - 1) as f64 * p).round() as usize].as_secs_f64() * 1000.0;
    println!("{label:<12} n={:<4} p50 {:>7.1} ms  p95 {:>7.1} ms  max {:>7.1} ms", times.len(), at(0.5), at(0.95), at(1.0));
}

fn main() {
    let mut args = std::env::args().skip(1);
    let root = std::path::PathBuf::from(args.next().expect("a project root")).canonicalize().unwrap();
    let file = root.join(args.next().expect("a file in the project"));
    let cache = std::env::var_os("CACHE_DIR").map(std::path::PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join(format!("tusk-latency-{}", std::process::id())));
    let text = std::fs::read_to_string(&file).unwrap();
    let uri = format!("file://{}", file.display());
    let doc = json!({ "uri": uri });

    let (server, conn) = Connection::memory();
    std::thread::spawn(move || tusk_lsp::server::run(server));
    let mut c = Client { conn, next: 1, started: Instant::now(), indexed: None, background: vec![] };
    let root_uri = format!("file://{}", root.display());
    c.request("initialize", json!({ "processId": null, "rootUri": root_uri, "workspaceFolders": [{ "uri": root_uri, "name": "p" }], "capabilities": {}, "initializationOptions": { "cacheDir": cache, "phpstan": { "enabled": "off" } } }));
    c.notify("initialized", json!({}));
    c.notify("textDocument/didOpen", json!({ "textDocument": { "uri": uri, "languageId": "php", "version": 1, "text": text } }));
    let (outline, _) = c.request("textDocument/documentSymbol", json!({ "textDocument": doc }));
    println!("first outline after {:.0} ms", outline.as_secs_f64() * 1000.0);
    // The first method's body: after the `{` that follows `function`.
    let body = text.find("function ").and_then(|f| text[f..].find('{').map(|b| f + b + 1)).expect("a method");
    c.request("textDocument/completion", json!({ "textDocument": doc, "position": position(&text, body) }));
    println!("first completion after {:.0} ms", c.started.elapsed().as_secs_f64() * 1000.0);
    c.wait_indexed();
    println!("index ready after {:.1} s", c.indexed.unwrap().as_secs_f32());

    let typed = "\n        $this->a;\n        $value = str_c;\n        $other = new Coll;\n        $this->";
    let mut text = text;
    let mut version = 1;
    let (mut completions, mut hovers) = (vec![], vec![]);
    let mut cursor = body;
    let scan = std::env::var_os("SCAN").is_some();
    let watched: usize = std::env::var("WATCHED").ok().and_then(|n| n.parse().ok()).unwrap_or(0);
    for pass in 0..3 {
        if scan {
            c.send("tusk/projectProblems", json!({}));
        }
        if pass == 1 && watched > 0 {
            let changes: Vec<Value> = ignore::WalkBuilder::new(root.join("vendor"))
                .standard_filters(false)
                .build()
                .flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == "php"))
                .take(watched)
                .map(|e| json!({ "uri": format!("file://{}", e.path().display()), "type": 2 }))
                .collect();
            println!("reporting {} files changed", changes.len());
            c.notify("workspace/didChangeWatchedFiles", json!({ "changes": changes }));
        }
        for ch in typed.chars() {
            text.insert(cursor, ch);
            let at = position(&text, cursor);
            cursor += ch.len_utf8();
            version += 1;
            c.notify("textDocument/didChange", json!({
                "textDocument": { "uri": uri, "version": version },
                "contentChanges": [{ "range": { "start": at, "end": at }, "text": ch.to_string() }],
            }));
            let (took, _) = c.request("textDocument/completion", json!({ "textDocument": doc, "position": position(&text, cursor) }));
            completions.push(took);
            if took > Duration::from_millis(100) {
                println!("slow completion {:.0} ms after {:?}", took.as_secs_f64() * 1000.0, &text[cursor.saturating_sub(20)..cursor]);
            }
            // The first `->` call after the cursor.
            let hover_at = text[cursor..].find("->").map(|i| cursor + i + 3).unwrap_or(cursor);
            let (took, _) = c.request("textDocument/hover", json!({ "textDocument": doc, "position": position(&text, hover_at) }));
            hovers.push(took);
            // About as fast as people type, so the diagnostics thread works alongside.
            std::thread::sleep(Duration::from_millis(40));
        }
        // Saving forgets the framework's facts about the app, which the next checks load again.
        c.notify("textDocument/didSave", json!({ "textDocument": { "uri": uri } }));
    }
    percentiles("completion", completions);
    percentiles("hover", hovers);
    while !c.background.is_empty() {
        c.request("textDocument/hover", json!({ "textDocument": doc, "position": position(&text, cursor) }));
    }
    c.request("shutdown", Value::Null);
    c.notify("exit", Value::Null);
    if std::env::var_os("CACHE_DIR").is_none() {
        let _ = std::fs::remove_dir_all(&cache);
    }
}
