//! Open documents: the editor's text, which wins over the file on disk.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use lsp_types::{Position, Range, TextDocumentContentChangeEvent, Uri};

use crate::text::LineIndex;

#[derive(Debug)]
pub struct Document {
    pub uri: Uri,
    pub path: PathBuf,
    pub language: String,
    pub version: i32,
    pub text: String,
    pub lines: LineIndex,
}

impl Document {
    pub fn new(uri: Uri, path: PathBuf, language: String, version: i32, text: String) -> Self {
        let lines = LineIndex::new(&text);
        Self { uri, path, language, version, text, lines }
    }

    pub fn offset(&self, pos: Position) -> u32 {
        self.lines.offset(&self.text, pos)
    }

    pub fn position(&self, offset: u32) -> Position {
        self.lines.position(&self.text, offset)
    }

    pub fn range(&self, start: u32, end: u32) -> Range {
        self.lines.range(&self.text, start, end)
    }

    /// Applies edits in order, each against the text the previous one left.
    pub fn apply(&self, version: i32, changes: Vec<TextDocumentContentChangeEvent>) -> Self {
        let mut text = self.text.clone();
        let mut lines = self.lines.clone();
        for change in changes {
            match change.range {
                Some(range) => {
                    let start = lines.offset(&text, range.start) as usize;
                    let end = (lines.offset(&text, range.end) as usize).max(start);
                    text.replace_range(start..end, &change.text);
                }
                None => text = change.text,
            }
            lines = LineIndex::new(&text);
        }
        Self { uri: self.uri.clone(), path: self.path.clone(), language: self.language.clone(), version, text, lines }
    }
}

/// Open documents by path. Each is immutable and shared, so a request keeps the text it started with.
#[derive(Debug, Default, Clone)]
pub struct Documents(HashMap<PathBuf, Arc<Document>>);

impl Documents {
    pub fn get(&self, path: &Path) -> Option<&Arc<Document>> {
        self.0.get(path)
    }

    pub fn insert(&mut self, doc: Document) -> Arc<Document> {
        let doc = Arc::new(doc);
        self.0.insert(doc.path.clone(), doc.clone());
        doc
    }

    pub fn remove(&mut self, path: &Path) -> Option<Arc<Document>> {
        self.0.remove(path)
    }

    pub fn iter(&self) -> impl Iterator<Item = &Arc<Document>> {
        self.0.values()
    }

    /// The text of `path`: the open document's, else the file's on disk.
    pub fn read(&self, path: &Path) -> Option<String> {
        match self.0.get(path) {
            Some(doc) => Some(doc.text.clone()),
            None => std::fs::read(path).ok().map(|b| crate::text::decode(&b)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn applies_incremental_changes_in_order() {
        let doc = Document::new(Uri::from_str("file:///a.php").unwrap(), "/a.php".into(), "php".into(), 1, "<?php\necho 1;\n".into());
        let change = |l1, c1, l2, c2, t: &str| TextDocumentContentChangeEvent {
            range: Some(Range { start: Position::new(l1, c1), end: Position::new(l2, c2) }),
            range_length: None,
            text: t.into(),
        };
        let doc = doc.apply(2, vec![change(1, 5, 1, 6, "'é'"), change(1, 8, 1, 8, " . 2")]);
        assert_eq!(doc.text, "<?php\necho 'é' . 2;\n");
        assert_eq!(doc.version, 2);
        let whole = TextDocumentContentChangeEvent { range: None, range_length: None, text: "x".into() };
        assert_eq!(doc.apply(3, vec![whole]).text, "x");
    }
}
