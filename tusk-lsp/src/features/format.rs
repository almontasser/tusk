//! Formatting with Mago's formatter, configured by `mago.toml`'s `[formatter]`.

use std::borrow::Cow;

use lsp_types::{DocumentFormattingParams, TextEdit};
use mago_allocator::LocalArena;

use crate::server::Snapshot;

/// The whole document, formatted, as one edit; none when it's already formatted or `mago.toml` excludes it.
/// A file with syntax errors isn't formatted, and says where the first one is.
pub fn formatting(snap: &Snapshot, params: DocumentFormattingParams) -> Result<Option<Vec<TextEdit>>, String> {
    let Some(doc) = snap.doc(&params.text_document.uri) else { return Ok(None) };
    if doc.language != "php" {
        return Ok(None);
    }
    let (mago, version) = {
        let index = snap.index.read();
        (index.config.mago.clone(), index.config.php_version)
    };
    let rel = doc.path.strip_prefix(&snap.root).unwrap_or(&doc.path);
    if !mago.formats(rel) {
        return Ok(None);
    }
    let settings = mago.format.clone()?;
    let arena = LocalArena::new();
    let formatter = mago_formatter::Formatter::new(&arena, version, settings);
    let name = crate::index::mago_name(rel);
    let formatted = formatter.format_code(Cow::Owned(name), Cow::Owned(doc.text.clone().into_bytes())).map_err(|e| {
        let at = doc.position(mago_span::HasSpan::span(&e).start.offset);
        format!("The file has a syntax error at line {}: {e}", at.line + 1)
    })?;
    let formatted = String::from_utf8_lossy(formatted);
    if formatted == doc.text {
        return Ok(Some(vec![]));
    }
    Ok(Some(vec![TextEdit { range: doc.range(0, doc.text.len() as u32), new_text: formatted.into_owned() }]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Fixture, uri};
    use lsp_types::{FormattingOptions, TextDocumentIdentifier};

    fn format(fx: &Fixture) -> Result<Option<Vec<TextEdit>>, String> {
        formatting(&fx.snap, DocumentFormattingParams {
            text_document: TextDocumentIdentifier { uri: uri("test.php") },
            options: FormattingOptions::default(),
            work_done_progress_params: Default::default(),
        })
    }

    #[test]
    fn formats_the_document_as_mago_does() {
        let fx = Fixture::one("<?php\nfunction f( $a ){return $a;}\n");
        let edits = format(&fx).unwrap().unwrap();
        assert_eq!(edits[0].new_text, "<?php\n\nfunction f($a)\n{\n    return $a;\n}\n");
        assert_eq!(edits[0].range.end, fx.doc("test.php").position(fx.doc("test.php").text.len() as u32));

        let fx = Fixture::one("<?php\n\nfunction f($a)\n{\n    return $a;\n}\n");
        assert_eq!(format(&fx).unwrap(), Some(vec![]));

        let fx = Fixture::one("<?php\n\nfunction f( {\n");
        assert!(format(&fx).unwrap_err().contains("line 3"));
    }
}
