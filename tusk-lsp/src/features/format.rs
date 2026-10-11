//! Formatting with Mago's formatter, configured by `mago.toml`'s `[formatter]`: the whole document, or the
//! statements a selection touches.

use std::borrow::Cow;
use std::sync::Arc;

use lsp_types::{DocumentFormattingParams, DocumentRangeFormattingParams, TextEdit, Uri};
use mago_allocator::LocalArena;
use mago_database::file::File;
use mago_formatter::Formatter;
use mago_syntax::error::ParseError;

use crate::documents::Document;
use crate::server::Snapshot;

/// Runs `f` with Mago's formatter for the PHP document at `uri`, unless it isn't PHP or `mago.toml` excludes it.
fn with_formatter<R>(snap: &Snapshot, uri: &Uri, f: impl FnOnce(&Formatter<'_, LocalArena>, &Arc<Document>, Vec<u8>) -> Result<Option<R>, String>) -> Result<Option<R>, String> {
    let Some(doc) = snap.doc(uri) else { return Ok(None) };
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
    let formatter = Formatter::new(&arena, version, settings);
    f(&formatter, &doc, crate::index::mago_name(rel))
}

/// Says where the first syntax error is, since a file with one isn't formatted.
fn syntax_error(doc: &Document, e: &ParseError) -> String {
    let at = doc.position(mago_span::HasSpan::span(e).start.offset);
    format!("The file has a syntax error at line {}: {e}", at.line + 1)
}

/// The whole document, formatted, as one edit; none when it's already formatted or `mago.toml` excludes it.
/// A file with syntax errors isn't formatted, and says where the first one is.
pub fn formatting(snap: &Snapshot, params: DocumentFormattingParams) -> Result<Option<Vec<TextEdit>>, String> {
    with_formatter(snap, &params.text_document.uri, |formatter, doc, name| {
        let formatted = formatter.format_code(Cow::Owned(name), Cow::Owned(doc.text.clone().into_bytes())).map_err(|e| syntax_error(doc, &e))?;
        Ok(Some(whole(doc, formatted)))
    })
}

/// The smallest statements, class members, or group of `use` imports that hold the selection, formatted as one
/// edit, indented to fit where they are. Text outside them is left as it is. An empty selection formats the
/// statement at the cursor. None when the selection is only HTML, Mago is told to ignore it, or it's formatted.
pub fn range_formatting(snap: &Snapshot, params: DocumentRangeFormattingParams) -> Result<Option<Vec<TextEdit>>, String> {
    with_formatter(snap, &params.text_document.uri, |formatter, doc, name| {
        let file = File::ephemeral(Cow::Owned(name), Cow::Owned(doc.text.clone().into_bytes()));
        let selected = doc.offset(params.range.start)..doc.offset(params.range.end);
        let Some(edit) = formatter.format_range(&file, selected).map_err(|e| syntax_error(doc, &e))? else { return Ok(Some(vec![])) };
        let new_text = String::from_utf8_lossy(edit.new_text).into_owned();
        Ok(Some(vec![TextEdit { range: doc.range(edit.range.start, edit.range.end), new_text }]))
    })
}

fn whole(doc: &Document, formatted: &[u8]) -> Vec<TextEdit> {
    let formatted = String::from_utf8_lossy(formatted);
    if formatted == doc.text {
        return vec![];
    }
    vec![TextEdit { range: doc.range(0, doc.text.len() as u32), new_text: formatted.into_owned() }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Fixture, uri};
    use lsp_types::{FormattingOptions, Position, Range, TextDocumentIdentifier};

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

    fn format_range(fx: &Fixture, start: Position, end: Position) -> Result<Option<Vec<TextEdit>>, String> {
        range_formatting(&fx.snap, DocumentRangeFormattingParams {
            text_document: TextDocumentIdentifier { uri: uri("test.php") },
            range: Range { start, end },
            options: FormattingOptions::default(),
            work_done_progress_params: Default::default(),
        })
    }

    #[test]
    fn formats_only_the_selected_statement() {
        let fx = Fixture::one("<?php
function f() {
$a=  1;
$b=[ 'x' ,2 ];
$c=  3;
}
");
        let edits = format_range(&fx, Position::new(3, 4), Position::new(3, 6)).unwrap().unwrap();
        let doc = fx.doc("test.php");
        let mut text = doc.text.clone();
        let (start, end) = (doc.offset(edits[0].range.start) as usize, doc.offset(edits[0].range.end) as usize);
        text.replace_range(start..end, &edits[0].new_text);
        assert_eq!(text, "<?php
function f() {
$a=  1;
    $b = ['x', 2];
$c=  3;
}
");

        // An empty selection formats the statement at the cursor; a formatted one has no edit.
        assert_eq!(format_range(&fx, Position::new(2, 1), Position::new(2, 1)).unwrap().unwrap()[0].new_text.trim(), "$a = 1;");
        let fx = Fixture::one("<?php

$a = 1;
");
        assert_eq!(format_range(&fx, Position::new(2, 0), Position::new(2, 7)).unwrap(), Some(vec![]));
        let fx = Fixture::one("<?php
$a = ;
");
        assert!(format_range(&fx, Position::new(1, 0), Position::new(1, 2)).unwrap_err().contains("line 2"));
    }
}
