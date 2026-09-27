//! Laravel features. See `framework/mod.rs` for the shared string-argument detection and PHP runner.

use lsp_types::{CodeLens, CompletionItem, Diagnostic, DocumentLink, Hover, Location};

use crate::features::Ctx;

pub fn completion(_ctx: &Ctx<'_>, _offset: u32) -> Option<Vec<CompletionItem>> {
    None
}

pub fn definition(_ctx: &Ctx<'_>, _offset: u32) -> Vec<Location> {
    vec![]
}

pub fn hover(_ctx: &Ctx<'_>, _offset: u32) -> Option<Hover> {
    None
}

pub fn diagnostics(_ctx: &Ctx<'_>) -> Vec<Diagnostic> {
    vec![]
}

#[allow(dead_code)]
pub fn code_lenses(_ctx: &Ctx<'_>) -> Vec<CodeLens> {
    vec![]
}

#[allow(dead_code)]
pub fn document_links(_ctx: &Ctx<'_>) -> Vec<DocumentLink> {
    vec![]
}
