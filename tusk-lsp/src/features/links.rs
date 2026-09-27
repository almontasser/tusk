//! Code lenses and document links, which only the framework features provide.

use lsp_types::{CodeLens, CodeLensParams, DocumentLink, DocumentLinkParams};

use super::with_ctx;
use crate::server::Snapshot;

pub fn code_lenses(snap: &Snapshot, params: CodeLensParams) -> Result<Option<Vec<CodeLens>>, String> {
    Ok(with_ctx(snap, &params.text_document.uri, |ctx| crate::framework::code_lenses(ctx)).filter(|l| !l.is_empty()))
}

pub fn document_links(snap: &Snapshot, params: DocumentLinkParams) -> Result<Option<Vec<DocumentLink>>, String> {
    Ok(with_ctx(snap, &params.text_document.uri, |ctx| crate::framework::document_links(ctx)).filter(|l| !l.is_empty()))
}
