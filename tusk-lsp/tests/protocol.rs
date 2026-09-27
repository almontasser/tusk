//! Drives the real server over an in-memory connection: initialize, index, open, edit, and diagnostics.

use std::time::Duration;

use lsp_server::{Connection, Message, Notification, Request, RequestId, Response};
use lsp_types::notification::Notification as _;
use lsp_types::request::Request as _;
use lsp_types::*;
use serde_json::{Value, json};

struct Client {
    conn: Connection,
    next: i32,
    pub notifications: Vec<Notification>,
    _dir: tempfile::TempDir,
    root: std::path::PathBuf,
}

impl Client {
    fn start(files: &[(&str, &str)]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        for (name, text) in files {
            let path = root.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        let (server, client) = Connection::memory();
        std::thread::spawn(move || tusk_lsp::server::run(server));
        let mut c = Client { conn: client, next: 1, notifications: vec![], _dir: dir, root };
        let root_uri = c.uri("");
        let _: Value = c.request_raw(request::Initialize::METHOD, json!({
            "processId": null,
            "rootUri": root_uri,
            "workspaceFolders": [{ "uri": root_uri, "name": "p" }],
            "capabilities": {},
        }));
        c.notify(notification::Initialized::METHOD, json!({}));
        c
    }

    fn uri(&self, name: &str) -> String {
        format!("file://{}/{}", self.root.display(), name).trim_end_matches('/').to_string()
    }

    fn notify(&self, method: &str, params: Value) {
        self.conn.sender.send(Message::Notification(Notification::new(method.into(), params))).unwrap();
    }

    fn request_raw(&mut self, method: &str, params: Value) -> Value {
        let id = RequestId::from(self.next);
        self.next += 1;
        self.conn.sender.send(Message::Request(Request::new(id.clone(), method.into(), params))).unwrap();
        loop {
            match self.recv() {
                Message::Response(r) if r.id == id => {
                    return r.response_result.unwrap_or_else(|e| panic!("{method} failed: {}", e.message));
                }
                _ => {}
            }
        }
    }

    /// The next message, answering the server's own requests with `null` and keeping notifications.
    fn recv(&mut self) -> Message {
        let msg = self.conn.receiver.recv_timeout(Duration::from_secs(20)).expect("the server answers");
        match &msg {
            Message::Request(req) => {
                self.conn.sender.send(Message::Response(Response::new_ok(req.id.clone(), Value::Null))).unwrap();
            }
            Message::Notification(n) => self.notifications.push(n.clone()),
            _ => {}
        }
        msg
    }

    /// Waits for a notification matching `f`, looking at ones already received first.
    fn wait_for(&mut self, f: impl Fn(&Notification) -> bool) -> Notification {
        if let Some(i) = self.notifications.iter().position(&f) {
            return self.notifications.remove(i);
        }
        loop {
            if let Message::Notification(n) = self.recv() {
                if f(&n) {
                    self.notifications.retain(|m| m.method != n.method || m.params != n.params);
                    return n;
                }
            }
        }
    }

    fn diagnostics(&mut self, uri: &str, version: i32) -> Vec<Diagnostic> {
        let n = self.wait_for(|n| {
            n.method == notification::PublishDiagnostics::METHOD
                && n.params["uri"] == uri
                && n.params["version"] == version
        });
        serde_json::from_value(n.params["diagnostics"].clone()).unwrap()
    }
}

#[test]
fn indexes_reports_progress_and_publishes_diagnostics_after_edits() {
    let mut c = Client::start(&[("src/Greeter.php", "<?php\nnamespace App;\nclass Greeter { public function hi(): string { return 'hi'; } }\n")]);
    // Indexing reports progress with a title the editor recognizes.
    let begin = c.wait_for(|n| n.method == "$/progress" && n.params["value"]["kind"] == "begin");
    assert_eq!(begin.params["value"]["title"], "Indexing");
    c.wait_for(|n| n.method == "$/progress" && n.params["value"]["kind"] == "end");

    let uri = c.uri("src/use.php");
    c.notify(notification::DidOpenTextDocument::METHOD, json!({
        "textDocument": { "uri": uri, "languageId": "php", "version": 1,
            "text": "<?php\nfunction f(\\App\\Greeter $g): int { return $g->hi(); }\n" }
    }));
    let diags = c.diagnostics(&uri, 1);
    assert!(diags.iter().any(|d| d.source.as_deref() == Some("mago")), "expected a return type problem: {diags:?}");

    // An incremental edit that fixes the return type clears it.
    c.notify(notification::DidChangeTextDocument::METHOD, json!({
        "textDocument": { "uri": uri, "version": 2 },
        "contentChanges": [{ "range": { "start": { "line": 1, "character": 29 }, "end": { "line": 1, "character": 32 } }, "text": "string" }]
    }));
    let diags = c.diagnostics(&uri, 2);
    assert!(diags.is_empty(), "{diags:?}");

    // A syntax error is reported too.
    c.notify(notification::DidChangeTextDocument::METHOD, json!({
        "textDocument": { "uri": uri, "version": 3 },
        "contentChanges": [{ "text": "<?php\nfunction f( {}\n" }]
    }));
    let diags = c.diagnostics(&uri, 3);
    assert!(!diags.is_empty());

    // Unknown requests fail without taking the server down.
    let id = RequestId::from(999);
    c.conn.sender.send(Message::Request(Request::new(id.clone(), "tusk/nope".into(), json!({})))).unwrap();
    loop {
        if let Message::Response(r) = c.recv() {
            assert_eq!(r.id, id);
            assert!(r.response_result.is_err());
            break;
        }
    }
    let result = c.request_raw(request::Shutdown::METHOD, Value::Null);
    assert_eq!(result, Value::Null);
}
