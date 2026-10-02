//! Test fixtures: an in-memory project whose files are all open documents, with a `<|>` cursor marker.

use std::path::PathBuf;
use std::sync::Arc;

use lsp_types::{Position, TextDocumentIdentifier, TextDocumentPositionParams, Uri};
use parking_lot::RwLock;

use crate::documents::{Document, Documents};
use crate::index::{Index, IndexConfig};
use crate::server::Snapshot;
use crate::text::path_to_uri;

pub const ROOT: &str = "/project";
pub const CURSOR: &str = "<|>";

/// Pest's functions as Pest declares them, PHPUnit's test case, and a project's test case that `tests/Pest.php` binds.
pub const PEST: &[(&str, &str)] = &[
    ("vendor/pest.php", "<?php\nnamespace PHPUnit\\Framework { abstract class TestCase { public function assertTrue($c): void {} } }\nnamespace {\n    /** @param-closure-this \\PHPUnit\\Framework\\TestCase $closure */\n    function it(string $description, ?Closure $closure = null) {}\n    /** @param-closure-this \\PHPUnit\\Framework\\TestCase $closure */\n    function beforeEach(?Closure $closure = null) {}\n    function uses(string ...$classAndTraits) {}\n}\n"),
    ("tests/TestCase.php", "<?php\nnamespace Tests;\nabstract class TestCase extends \\PHPUnit\\Framework\\TestCase { public function get(string $uri): void {} }\n"),
    ("tests/Pest.php", "<?php\nuse Tests\\TestCase;\npest()->extend(TestCase::class)->in('Feature');\n"),
];

/// Laravel's trait for tests that use the database, as a library file.
pub const REFRESH_DATABASE: &str = "<?php\nnamespace Illuminate\\Foundation\\Testing;\ntrait RefreshDatabase { public function refreshDatabase(): void {} }\n";

/// Laravel's auth helper, contracts, manager, and facade, as Laravel 12 declares them, as a library file.
pub const LARAVEL_AUTH: (&str, &str) = (
    "vendor/auth.php",
    "<?php\nnamespace Illuminate\\Contracts\\Auth {\n    interface Authenticatable { public function getAuthIdentifier(); }\n    interface Guard {\n        /** @return bool */\n        public function check();\n        /** @return int|string|null */\n        public function id();\n        /** @return \\Illuminate\\Contracts\\Auth\\Authenticatable|null */\n        public function user();\n    }\n    interface StatefulGuard extends Guard {\n        /** @return void */\n        public function login(Authenticatable $user, $remember = false);\n        /** @return void */\n        public function logout();\n    }\n    interface Factory {\n        /** @return \\Illuminate\\Contracts\\Auth\\Guard|\\Illuminate\\Contracts\\Auth\\StatefulGuard */\n        public function guard($name = null);\n    }\n}\nnamespace Illuminate\\Auth {\n    /**\n     * @mixin \\Illuminate\\Contracts\\Auth\\Guard\n     * @mixin \\Illuminate\\Contracts\\Auth\\StatefulGuard\n     */\n    class AuthManager implements \\Illuminate\\Contracts\\Auth\\Factory {\n        public function guard($name = null) { return null; }\n        public function __call($method, $parameters) { return null; }\n    }\n}\nnamespace Illuminate\\Support\\Facades {\n    /** @method static \\Illuminate\\Contracts\\Auth\\Authenticatable|null user() */\n    class Auth { public static function __callStatic($method, $args) {} }\n}\nnamespace {\n    use Illuminate\\Contracts\\Auth\\Factory as AuthFactory;\n    use Illuminate\\Contracts\\Auth\\Guard;\n    /** @return ($guard is null ? \\Illuminate\\Contracts\\Auth\\Factory : \\Illuminate\\Contracts\\Auth\\Guard) */\n    function auth($guard = null): AuthFactory|Guard {}\n}\n",
);

pub struct Fixture {
    pub snap: Snapshot,
    /// The file and position of the cursor marker, if a file had one.
    pub cursor: Option<(Uri, Position)>,
}

pub fn path(name: &str) -> PathBuf {
    PathBuf::from(format!("{ROOT}/{name}"))
}

pub fn uri(name: &str) -> Uri {
    path_to_uri(&path(name))
}

impl Fixture {
    pub fn new(files: &[(&str, &str)]) -> Self {
        let mut docs = Documents::default();
        let mut cursor = None;
        for (name, text) in files {
            let path = path(name);
            let mut text = text.to_string();
            if let Some(at) = text.find(CURSOR) {
                text.replace_range(at..at + CURSOR.len(), "");
                let doc = Document::new(path_to_uri(&path), path.clone(), "php".into(), 1, text.clone());
                cursor = Some((doc.uri.clone(), doc.position(at as u32)));
            }
            docs.insert(Document::new(path_to_uri(&path), path, "php".into(), 1, text));
        }
        let mut index = Index::empty(IndexConfig::new(ROOT));
        let paths = docs.iter().map(|d| d.path.clone()).collect();
        index.build(paths, |p| docs.get(p).map(|d| d.text.clone().into_bytes()), |_, _| {});
        let snap = Snapshot {
            docs,
            index: Arc::new(RwLock::new(index)),
            root: PathBuf::from(ROOT),
            framework: Arc::new(crate::framework::State::new(PathBuf::from(ROOT))),
            client: None,
            cancel: Default::default(),
        };
        Self { snap, cursor }
    }

    /// One file, `test.php`.
    pub fn one(text: &str) -> Self {
        Self::new(&[("test.php", text)])
    }

    pub fn at(&self) -> TextDocumentPositionParams {
        let (uri, position) = self.cursor.clone().expect("a file has a <|> cursor");
        TextDocumentPositionParams { text_document: TextDocumentIdentifier { uri }, position }
    }

    pub fn doc(&self, name: &str) -> Arc<Document> {
        self.snap.docs.get(&path(name)).unwrap().clone()
    }
}

/// Runs a test on a thread with the server's stack: indexing deeply nested code, such as a Filament schema,
/// needs more than a test thread's 2 MB in a debug build.
pub fn on_server_stack(f: impl FnOnce() + Send) {
    std::thread::scope(|s| std::thread::Builder::new().stack_size(64 << 20).spawn_scoped(s, f).unwrap().join().unwrap());
}
