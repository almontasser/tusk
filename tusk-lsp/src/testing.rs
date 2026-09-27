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
