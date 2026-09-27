//! Conversions between LSP positions (line and UTF-16 column), byte offsets, URIs, and paths.

use std::path::{Path, PathBuf};
use std::str::FromStr;

use lsp_types::{Position, Range, Uri};
use percent_encoding::{AsciiSet, CONTROLS, percent_decode_str, utf8_percent_encode};

/// Byte offsets where each line of a text starts.
#[derive(Debug, Clone)]
pub struct LineIndex {
    starts: Vec<u32>,
}

impl LineIndex {
    pub fn new(text: &str) -> Self {
        let mut starts = vec![0];
        starts.extend(text.bytes().enumerate().filter(|(_, b)| *b == b'\n').map(|(i, _)| i as u32 + 1));
        Self { starts }
    }

    /// The byte offset of an LSP position, clamped to the text.
    pub fn offset(&self, text: &str, pos: Position) -> u32 {
        let Some(&start) = self.starts.get(pos.line as usize) else { return text.len() as u32 };
        let end = self.starts.get(pos.line as usize + 1).map_or(text.len(), |e| *e as usize - 1);
        let line = &text[start as usize..end];
        let mut units = 0;
        for (i, c) in line.char_indices() {
            if units >= pos.character {
                return start + i as u32;
            }
            units += c.len_utf16() as u32;
        }
        end as u32
    }

    /// The LSP position of a byte offset. An offset inside a character counts as that character's start.
    pub fn position(&self, text: &str, offset: u32) -> Position {
        let offset = offset.min(text.len() as u32);
        let line = self.starts.partition_point(|&s| s <= offset) - 1;
        let start = self.starts[line] as usize;
        let mut end = offset as usize;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let character = text[start..end].chars().map(|c| c.len_utf16() as u32).sum();
        Position { line: line as u32, character }
    }

    pub fn range(&self, text: &str, start: u32, end: u32) -> Range {
        Range { start: self.position(text, start), end: self.position(text, end) }
    }
}

/// Characters kept as they are in a `file://` URI's path. Everything else is percent-encoded.
const PATH: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'[')
    .add(b']')
    .add(b'`')
    .add(b'{')
    .add(b'}')
    .add(b'^')
    .add(b'|');

pub fn path_to_uri(path: &Path) -> Uri {
    let encoded = utf8_percent_encode(&path.to_string_lossy(), PATH).to_string();
    Uri::from_str(&format!("file://{encoded}")).expect("a percent-encoded file path is a valid URI")
}

pub fn uri_to_path(uri: &Uri) -> Option<PathBuf> {
    let s = uri.as_str().strip_prefix("file://")?;
    // `file://localhost/path` and `file:///path` both mean `/path`.
    let s = s.strip_prefix("localhost").unwrap_or(s);
    Some(PathBuf::from(percent_decode_str(s).decode_utf8().ok()?.into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_positions_with_utf16_columns() {
        let text = "<?php\n$é = '😀';\nx";
        let idx = LineIndex::new(text);
        // `'` after the emoji: the emoji is 4 bytes and 2 UTF-16 units.
        let quote = text.rfind('\'').unwrap() as u32;
        let pos = idx.position(text, quote);
        assert_eq!(pos, Position { line: 1, character: 8 });
        assert_eq!(idx.offset(text, pos), quote);
        assert_eq!(idx.offset(text, Position { line: 2, character: 0 }), text.len() as u32 - 1);
        // Past the end of a line clamps to its end, past the last line to the text's end.
        assert_eq!(idx.offset(text, Position { line: 0, character: 99 }), 5);
        assert_eq!(idx.offset(text, Position { line: 9, character: 0 }), text.len() as u32);
    }

    #[test]
    fn round_trips_paths_through_uris() {
        let path = Path::new("/Users/me/My Project/a#b.php");
        let uri = path_to_uri(path);
        assert_eq!(uri.as_str(), "file:///Users/me/My%20Project/a%23b.php");
        assert_eq!(uri_to_path(&uri).unwrap(), path);
    }
}
