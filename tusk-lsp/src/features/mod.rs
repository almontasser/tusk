//! Request handlers, one module per feature.

pub mod actions;
pub mod completion;
pub mod custom;
pub mod folding;
pub mod format;
pub mod hierarchy;
pub mod hover;
pub mod inlay;
pub mod links;
pub mod moves;
pub mod navigation;
pub mod outline;
pub mod references;
pub mod rename;
pub mod signature;
pub mod symbols;

use std::cell::OnceCell;
use std::sync::Arc;

use lsp_types::{Position, Uri};
use mago_allocator::LocalArena;
use parking_lot::RwLockReadGuard;

use crate::analysis::{Analysis, Parsed, analyze};
use crate::documents::Document;
use crate::index::Index;
use crate::server::Snapshot;
use crate::symbol::{Found, Resolver};

/// One file, parsed, with the index locked for reading and the analysis run on first use.
pub struct Ctx<'a> {
    pub snap: &'a Snapshot,
    pub doc: Arc<Document>,
    pub arena: &'a LocalArena,
    pub parsed: Parsed<'a>,
    pub index: RwLockReadGuard<'a, Index>,
    analysis: OnceCell<Analysis>,
}

impl<'a> Ctx<'a> {
    pub fn analysis(&self) -> &Analysis {
        self.analysis.get_or_init(|| analyze(&self.parsed, self.arena, &self.index))
    }

    pub fn resolver(&self) -> Resolver<'_, 'a> {
        Resolver::new(&self.parsed, Some(self.analysis()), &self.index.codebase)
    }

    pub fn offset(&self, pos: Position) -> u32 {
        self.doc.offset(pos)
    }

    pub fn symbol_at(&self, pos: Position) -> Option<Found> {
        self.resolver().at(self.offset(pos))
    }
}

/// Runs `f` on the document at `uri` (open, else read from disk).
pub fn with_ctx<R>(snap: &Snapshot, uri: &Uri, f: impl FnOnce(&Ctx<'_>) -> R) -> Option<R> {
    let doc = snap.doc(uri)?;
    let arena = LocalArena::new();
    let parsed = Parsed::new(&arena, &doc.path, &doc.text);
    // Beyond the analyzer, and walks that measure spans at every level, in reasonable time.
    if crate::analysis::too_complex(parsed.program) {
        return None;
    }
    let index = snap.index.read();
    let ctx = Ctx { snap, doc: doc.clone(), arena: &arena, parsed, index, analysis: OnceCell::new() };
    Some(f(&ctx))
}

/// Like [`with_ctx`], but parses the text cut at `pos` with its open brackets closed, for features that work
/// on the statement being typed. Offsets before `pos` are the same as in the document.
pub fn with_ctx_at<R>(snap: &Snapshot, uri: &Uri, pos: Position, f: impl FnOnce(&Ctx<'_>) -> R) -> Option<R> {
    let doc = snap.doc(uri)?;
    let offset = doc.offset(pos);
    let arena = LocalArena::new();
    let original = Parsed::new(&arena, &doc.path, &doc.text);
    if crate::analysis::too_complex(original.program) {
        return None;
    }
    let parsed = match crate::repair::at_cursor(&original, offset) {
        Some(text) => Parsed::exact(&arena, &doc.path, &text),
        None => original,
    };
    let index = snap.index.read();
    let ctx = Ctx { snap, doc: doc.clone(), arena: &arena, parsed, index, analysis: OnceCell::new() };
    Some(f(&ctx))
}

/// Runs `f` on `text` standing in for the document `doc`, such as the PHP a Blade view's echoes and
/// directives hold, laid out at the same offsets. Positions still convert through `doc`.
pub fn with_text<R>(snap: &Snapshot, doc: Arc<Document>, text: &str, f: impl FnOnce(&Ctx<'_>) -> R) -> R {
    let arena = LocalArena::new();
    let parsed = Parsed::new(&arena, &doc.path, text);
    let index = snap.index.read();
    let ctx = Ctx { snap, doc, arena: &arena, parsed, index, analysis: OnceCell::new() };
    f(&ctx)
}
