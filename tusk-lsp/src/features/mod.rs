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

/// Whether `doc` is a Blade view, rather than PHP or the PHP of a Blade view ([`BLADE_PHP`]).
pub fn is_blade(doc: &Document) -> bool {
    doc.language == "blade" || (doc.language != BLADE_PHP && doc.path.to_string_lossy().ends_with(".blade.php"))
}

/// The language of the document [`with_blade_php`] gives, which is PHP at a Blade view's path.
const BLADE_PHP: &str = "blade-php";

/// The PHP of a Blade view as Mago checks it ([`checked_php`]), with the view's variables typed as the places
/// that render it pass them ([`view_types`]), standing in for the view, and a way back to the view's positions.
///
/// [`checked_php`]: crate::framework::laravel::blade::checked_php
/// [`view_types`]: crate::framework::laravel::views::view_types
pub struct BladePhp {
    view: Arc<Document>,
    checked: crate::framework::laravel::blade::Checked,
}

impl BladePhp {
    /// The offset in the PHP of the view's `offset`.
    pub fn php_offset(&self, offset: u32) -> u32 {
        self.checked.php_offset(offset as usize) as u32
    }

    /// Whether the view's character at `offset` is PHP, in the PHP `php`, rather than blanked text.
    pub fn in_php(&self, php: &Document, offset: u32) -> bool {
        php.text.as_bytes().get(self.php_offset(offset) as usize).is_some_and(|b| !b.is_ascii_whitespace())
    }

    /// The view's text.
    pub fn view_text(&self) -> &str {
        &self.view.text
    }

    /// The view's range for `range` in the PHP, unless that's PHP Laravel adds, such as the variables' declarations.
    pub fn view_range(&self, php: &Document, range: lsp_types::Range) -> Option<lsp_types::Range> {
        let at = |pos| self.checked.view_offset(php.offset(pos) as usize).ok().map(|o| self.view.position(o as u32));
        Some(lsp_types::Range { start: at(range.start)?, end: at(range.end)? })
    }
}

/// Runs `f` on the PHP of the Blade view at `uri` ([`BladePhp`]), cut at `offset` in the view with its open brackets
/// closed, as [`with_ctx_at`] does, when `at_cursor`. `None` when the document isn't a Blade view.
pub fn with_blade_php<R>(snap: &Snapshot, uri: &Uri, offset: u32, at_cursor: bool, f: impl FnOnce(&Ctx<'_>, &BladePhp) -> R) -> Option<R> {
    use crate::framework::laravel::{blade, blade_components, views};
    let view = snap.doc(uri)?;
    if !is_blade(&view) {
        return None;
    }
    let index = snap.index.read();
    let components = blade_components(&snap.framework);
    let vars = views::view_name(&index, &view.path).map(|v| views::view_types(&index, &|p| snap.read(p), components.as_deref(), &v)).unwrap_or_default();
    let checked = blade::checked_php(&view.text, &vars);
    let authed = checked.authed.iter().map(|r| (checked.php_offset(r.start) as u32, checked.php_offset(r.end) as u32)).collect();
    let doc = Arc::new(Document::new(view.uri.clone(), view.path.clone(), BLADE_PHP.into(), view.version, checked.php.clone()));
    let blade = BladePhp { view, checked };
    let arena = LocalArena::new();
    let original = Parsed::new(&arena, &doc.path, &doc.text);
    if crate::analysis::too_complex(original.program) {
        return None;
    }
    let parsed = match at_cursor.then(|| crate::repair::at_cursor(&original, blade.php_offset(offset))).flatten() {
        Some(text) => Parsed::exact(&arena, &doc.path, &text),
        None => original,
    };
    let ctx = Ctx { snap, doc, arena: &arena, parsed, index, analysis: OnceCell::new() };
    // `@auth`'s user is logged in, as when the view is checked.
    Some(crate::analysis::logged_in(authed, || f(&ctx, &blade)))
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
