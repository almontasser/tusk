//! Color swatches, which only the framework features provide: `textDocument/documentColor`, and a presentation
//! that keeps the name as written, since a name such as `danger` has no other way to write a picked color.

use lsp_types::{ColorInformation, ColorPresentation, ColorPresentationParams, DocumentColorParams};

use super::with_ctx;
use crate::server::Snapshot;

pub fn document_colors(snap: &Snapshot, params: DocumentColorParams) -> Result<Vec<ColorInformation>, String> {
    Ok(with_ctx(snap, &params.text_document.uri, crate::framework::document_colors).unwrap_or_default())
}

pub fn color_presentations(snap: &Snapshot, params: ColorPresentationParams) -> Result<Vec<ColorPresentation>, String> {
    let Some(doc) = snap.doc(&params.text_document.uri) else { return Ok(vec![]) };
    let (start, end) = (doc.offset(params.range.start) as usize, doc.offset(params.range.end) as usize);
    let label = doc.text.get(start..end).unwrap_or_default().to_string();
    Ok(vec![ColorPresentation { label, text_edit: None, additional_text_edits: None }])
}
