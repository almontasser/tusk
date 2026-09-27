//! Request handlers, one module per feature.

pub mod navigation;
pub mod references;

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
        self.analysis.get_or_init(|| analyze(&self.parsed, self.arena, &self.index.codebase, self.index.config.php_version))
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
    let index = snap.index.read();
    let ctx = Ctx { snap, doc: doc.clone(), arena: &arena, parsed, index, analysis: OnceCell::new() };
    Some(f(&ctx))
}
