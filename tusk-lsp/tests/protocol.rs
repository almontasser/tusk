//! Drives the real server over an in-memory connection: initialize, index, open, edit, and diagnostics.

use std::time::Duration;

use lsp_server::{Connection, ErrorCode, Message, Notification, Request, RequestId, Response};
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
        let mut c = Client { conn: client, next: 1, notifications: vec![], _dir: dir, root: root.clone() };
        let root_uri = c.uri("");
        let _: Value = c.request_raw(request::Initialize::METHOD, json!({
            "processId": null,
            "rootUri": root_uri,
            "workspaceFolders": [{ "uri": root_uri, "name": "p" }],
            "capabilities": {},
            // A hidden folder, which the index skips, so the cache goes with the project.
            "initializationOptions": { "cacheDir": root.join(".cache") },
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
            if let Message::Notification(n) = self.recv()
                && f(&n) {
                    self.notifications.retain(|m| m.method != n.method || m.params != n.params);
                    return n;
                }
        }
    }

    /// Sends a request without waiting for its answer.
    fn send(&mut self, method: &str, params: Value) -> RequestId {
        let id = RequestId::from(self.next);
        self.next += 1;
        self.conn.sender.send(Message::Request(Request::new(id.clone(), method.into(), params))).unwrap();
        id
    }

    /// The answers to `ids`, in any order they arrive.
    fn responses(&mut self, ids: &[RequestId]) -> Vec<Response> {
        let mut out = vec![];
        while out.len() < ids.len() {
            if let Message::Response(r) = self.recv()
                && ids.contains(&r.id) {
                    out.push(r);
                }
        }
        out
    }

    fn open(&self, name: &str, text: &str) -> String {
        let uri = self.uri(name);
        self.notify(notification::DidOpenTextDocument::METHOD, json!({
            "textDocument": { "uri": uri, "languageId": "php", "version": 1, "text": text }
        }));
        uri
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
    // The linter's style advice, such as `declare(strict_types=1)`, stays.
    assert!(diags.iter().all(|d| d.source.as_deref() == Some("mago-lint")), "{diags:?}");

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

fn indexed(files: &[(&str, &str)]) -> Client {
    let mut c = Client::start(files);
    c.wait_for(|n| n.method == "$/progress" && n.params["value"]["kind"] == "end");
    c
}

#[test]
fn cancelled_requests_are_answered_as_cancelled() {
    let files: Vec<(String, String)> =
        (0..40).map(|i| (format!("src/C{i}.php"), format!("<?php\nclass C{i} {{ function m(): int {{ return 'x'; }} }}\n"))).collect();
    let files: Vec<(&str, &str)> = files.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    let mut c = indexed(&files);
    // More than the pool runs at once, so most are still waiting when the cancellations arrive.
    let ids: Vec<RequestId> = (0..64).map(|_| c.send("tusk/projectProblems", json!({}))).collect();
    for id in &ids {
        let id: i32 = id.to_string().parse().unwrap();
        c.notify(notification::Cancel::METHOD, json!({ "id": id }));
    }
    let answers = c.responses(&ids);
    let cancelled = answers.iter().filter(|r| r.response_result.as_ref().is_err_and(|e| e.code == ErrorCode::RequestCanceled as i32)).count();
    assert!(cancelled > 0, "no request was cancelled");
    // The rest finished normally.
    assert!(answers.iter().all(|r| r.response_result.as_ref().is_ok_and(|v| v.is_object()) || r.response_result.is_err()));
    // A request after them is answered in full.
    let problems = c.request_raw("tusk/projectProblems", json!({}));
    assert_eq!(problems.as_object().unwrap().len(), 40);
}

#[test]
fn requests_racing_edits_answer_for_the_text_before_them() {
    let mut c = indexed(&[("src/Box.php", "<?php\nclass Box { public function open(): void {} }\n")]);
    let uri = c.open("src/use.php", "<?php\nfunction f(Box $b) {\n    $b->\n}\n");
    let mut ids = vec![];
    // Typing in the class file while completions are asked for in the other: each keystroke adds a method.
    let box_uri = c.open("src/Box.php", "<?php\nclass Box { public function open(): void {} }\n");
    for i in 0..30 {
        c.notify(notification::DidChangeTextDocument::METHOD, json!({
            "textDocument": { "uri": box_uri, "version": i + 2 },
            "contentChanges": [{ "range": { "start": { "line": 1, "character": 12 }, "end": { "line": 1, "character": 12 } },
                "text": format!("public function m{i}(): void {{}} ") }]
        }));
        ids.push(c.send(request::Completion::METHOD, json!({ "textDocument": { "uri": uri }, "position": { "line": 2, "character": 8 } })));
        ids.push(c.send(request::HoverRequest::METHOD, json!({ "textDocument": { "uri": box_uri }, "position": { "line": 1, "character": 8 } })));
    }
    let answers = c.responses(&ids);
    assert!(answers.iter().all(|r| r.response_result.is_ok()), "{answers:?}");
    // The last completion, sent after every edit, sees every method.
    let last = answers.iter().find(|r| r.id == ids[ids.len() - 2]).unwrap();
    let labels = last.response_result.as_ref().unwrap().to_string();
    assert!(labels.contains("m0") && labels.contains("m29") && labels.contains("open"), "{labels}");
}

#[test]
fn a_reindex_during_requests_answers_them_all() {
    let mut c = indexed(&[
        ("src/Box.php", "<?php\nclass Box { public function open(): void {} }\n"),
        ("src/use.php", "<?php\nfunction f(Box $b) { $b->open(); }\n"),
    ]);
    let uri = c.uri("src/use.php");
    let at = json!({ "textDocument": { "uri": uri }, "position": { "line": 1, "character": 27 } });
    let mut ids = vec![c.send(request::GotoDefinition::METHOD, at.clone())];
    ids.push(c.send("tusk/reindex", json!({})));
    for _ in 0..10 {
        ids.push(c.send(request::References::METHOD, json!({ "textDocument": { "uri": uri }, "position": { "line": 1, "character": 27 }, "context": { "includeDeclaration": true } })));
        ids.push(c.send(request::HoverRequest::METHOD, at.clone()));
    }
    let answers = c.responses(&ids);
    assert!(answers.iter().all(|r| r.response_result.is_ok()), "{answers:?}");
    // After the reindex, requests still find the method.
    let found = c.request_raw(request::GotoDefinition::METHOD, at);
    assert!(found.to_string().contains("Box.php"), "{found}");
}

#[test]
fn files_created_while_indexing_are_indexed() {
    let mut c = Client::start(&[("src/A.php", "<?php\nclass A {}\n")]);
    // Created and reported before the first build is known to have finished.
    let path = c.root.join("src/Late.php");
    std::fs::write(&path, "<?php\nclass Late {}\n").unwrap();
    c.notify(notification::DidChangeWatchedFiles::METHOD, json!({ "changes": [{ "uri": c.uri("src/Late.php"), "type": 1 }] }));
    let found = c.request_raw(request::WorkspaceSymbolRequest::METHOD, json!({ "query": "Late" }));
    assert!(found.to_string().contains("Late.php"), "{found}");
    // Deleted again, it's gone.
    std::fs::remove_file(&path).unwrap();
    c.notify(notification::DidChangeWatchedFiles::METHOD, json!({ "changes": [{ "uri": c.uri("src/Late.php"), "type": 3 }] }));
    let found = c.request_raw(request::WorkspaceSymbolRequest::METHOD, json!({ "query": "Late" }));
    assert!(!found.to_string().contains("Late.php"), "{found}");
}

#[test]
fn closing_a_file_goes_back_to_its_text_on_disk() {
    let mut c = indexed(&[("src/Box.php", "<?php\nclass Box {}\n")]);
    let uri = c.open("src/Box.php", "<?php\nclass Crate {}\n");
    let found = c.request_raw(request::WorkspaceSymbolRequest::METHOD, json!({ "query": "Crate" }));
    assert!(found.to_string().contains("Box.php"), "{found}");
    c.notify(notification::DidCloseTextDocument::METHOD, json!({ "textDocument": { "uri": uri } }));
    let found = c.request_raw(request::WorkspaceSymbolRequest::METHOD, json!({ "query": "Crate" }));
    assert!(!found.to_string().contains("Box.php"), "{found}");
    let found = c.request_raw(request::WorkspaceSymbolRequest::METHOD, json!({ "query": "Box" }));
    assert!(found.to_string().contains("Box.php"), "{found}");
}

#[test]
fn checks_the_php_in_blade_views_open_and_in_the_project_scan() {
    let view = "<h1>{{ $title }}</h1>\n{{ nope() }}\n";
    let mut c = indexed(&[("resources/views/home.blade.php", view)]);
    let uri = c.uri("resources/views/home.blade.php");
    c.notify(notification::DidOpenTextDocument::METHOD, json!({
        "textDocument": { "uri": uri, "languageId": "blade", "version": 1, "text": view }
    }));
    let diags = c.diagnostics(&uri, 1);
    let mago: Vec<_> = diags.iter().filter(|d| d.source.as_deref() == Some("mago")).collect();
    assert_eq!(mago.len(), 1, "{diags:?}");
    assert_eq!(mago[0].range.start, Position { line: 1, character: 3 });
    let problems = c.request_raw("tusk/projectProblems", json!({}));
    assert!(problems["resources/views/home.blade.php"].to_string().contains("non-existent-function"), "{problems}");
}

/// Searches read many files in parallel while holding the index, and other requests wait for the index to
/// catch up with edits. With requests on a rayon pool, a search waiting on its parallel work picked up a
/// request that waited for the index, which the search held: the server stopped answering.
#[test]
fn searches_racing_edits_and_other_requests_all_finish() {
    let mut files: Vec<(String, String)> = vec![("src/Box.php".into(), "<?php\nclass Box { public function open(): void {} }\n".into())];
    for i in 0..300 {
        files.push((format!("src/use{i}.php"), format!("<?php\nfunction f{i}(Box $b) {{ $b->open(); new Box(); }}\n")));
    }
    let files: Vec<(&str, &str)> = files.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    let mut c = indexed(&files);
    let box_uri = c.open("src/Box.php", "<?php\nclass Box { public function open(): void {} }\n");
    let open = json!({ "textDocument": { "uri": box_uri }, "position": { "line": 1, "character": 30 } });
    let item = c.request_raw(request::CallHierarchyPrepare::METHOD, open.clone())[0].clone();
    let mut ids = vec![];
    for i in 0..40 {
        ids.push(c.send(request::CallHierarchyIncomingCalls::METHOD, json!({ "item": item })));
        ids.push(c.send(request::References::METHOD, json!({ "textDocument": { "uri": box_uri }, "position": { "line": 1, "character": 30 }, "context": { "includeDeclaration": true } })));
        c.notify(notification::DidChangeTextDocument::METHOD, json!({
            "textDocument": { "uri": box_uri, "version": i + 2 },
            "contentChanges": [{ "range": { "start": { "line": 1, "character": 12 }, "end": { "line": 1, "character": 12 } },
                "text": format!("public function m{i}(): void {{}} ") }]
        }));
        ids.push(c.send(request::HoverRequest::METHOD, open.clone()));
    }
    let answers = c.responses(&ids);
    assert!(answers.iter().all(|r| r.response_result.is_ok()), "{answers:?}");
}

/// Filament's color classes and an icon set's package, as installed, without an app to boot.
const FILAMENT_VENDOR: &[(&str, &str)] = &[
    ("vendor/filament/filament/composer.json", "{}"),
    ("vendor/filament/support/src/Colors/Color.php", "<?php\nnamespace Filament\\Support\\Colors;\nclass Color {\n    public const WCAG = 4.5;\n    public const Red = [\n        400 => 'oklch(0.704 0.191 22.216)',\n        500 => 'oklch(0.637 0.237 25.331)',\n    ];\n}\n"),
    ("vendor/filament/support/src/Colors/ColorManager.php", "<?php\nclass ColorManager {\n    const DEFAULT_COLORS = [\n        'danger' => Color::Red,\n    ];\n}\n"),
    ("vendor/composer/installed.json", r#"{"packages": [{"name": "blade-ui-kit/blade-heroicons", "require": {"blade-ui-kit/blade-icons": "^1.6"}, "install-path": "../blade-ui-kit/blade-heroicons"}]}"#),
    ("vendor/blade-ui-kit/blade-heroicons/config/blade-heroicons.php", "<?php\nreturn [\n    'prefix' => 'heroicon',\n];\n"),
    ("vendor/blade-ui-kit/blade-heroicons/src/BladeHeroiconsServiceProvider.php", "<?php\n$this->callAfterResolving(Factory::class, function (Factory $factory, Container $container) {\n    $config = $container->make('config')->get('blade-heroicons', []);\n    $factory->add('heroicons', array_merge(['path' => __DIR__.'/../resources/svg'], $config));\n});\n"),
    ("vendor/blade-ui-kit/blade-heroicons/resources/svg/o-user.svg", "<svg stroke=\"currentColor\"/>"),
];

#[test]
fn shows_filament_color_swatches_and_icon_previews() {
    let mut c = indexed(FILAMENT_VENDOR);
    let uri = c.open("src/t.php", "<?php\nuse Filament\\Support\\Colors\\Color;\n$c->color('danger')->colors([Color::Red])->icon('heroicon-o-');\n");
    let colors = c.request_raw(request::DocumentColor::METHOD, json!({ "textDocument": { "uri": uri } }));
    let colors: Vec<ColorInformation> = serde_json::from_value(colors).unwrap();
    assert_eq!(colors.iter().map(|c| c.range.start.character).collect::<Vec<_>>(), vec![11, 29]);
    assert!((colors[0].color.red - 0.984).abs() < 0.01, "{:?}", colors[0].color);
    // Picking another color keeps the name.
    let presented = c.request_raw(request::ColorPresentationRequest::METHOD, json!({ "textDocument": { "uri": uri }, "color": colors[0].color, "range": colors[0].range }));
    assert_eq!(presented[0]["label"], "danger");

    let items = c.request_raw(request::Completion::METHOD, json!({ "textDocument": { "uri": uri }, "position": { "line": 2, "character": 59 } }));
    let item = items["items"].as_array().unwrap().iter().find(|i| i["label"] == "heroicon-o-user").expect("the icon").clone();
    assert!(item.get("documentation").is_none());
    let resolved = c.request_raw(request::ResolveCompletionItem::METHOD, item);
    assert!(resolved["documentation"]["value"].as_str().unwrap().starts_with("![heroicon-o-user](data:image/svg+xml;base64,"), "{resolved}");
}
