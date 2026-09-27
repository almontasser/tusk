//! Making unfinished code parse. Mago's parser drops a whole statement it can't finish, and while you type,
//! the statement at the cursor is rarely finished.
//!
//! The analyzer recognizes a declaration by its exact span, so a repair never moves a declaration that the
//! index knows: [`balance_end`] only appends, and [`at_cursor`] keeps the text's length and everything outside
//! the function being edited.

use mago_database::file::FileId;
use mago_span::HasSpan;
use mago_syntax::cst::{Block, Node};
use mago_syntax::lexer::Lexer;
use mago_syntax::settings::LexerSettings;
use mago_syntax::token::TokenKind;
use mago_syntax_core::input::Input;

use crate::analysis::Parsed;

/// What closes each bracket still open at the end of `code` (a fragment inside PHP tags, or a whole file),
/// ending the statement inside each block.
fn closers(code: &str, in_php: bool) -> String {
    let input = Input::new(FileId::zero(), code.as_bytes());
    let mut lexer = if in_php { Lexer::scripting(input, LexerSettings::default()) } else { Lexer::new(input, LexerSettings::default()) };
    let mut open: Vec<char> = vec![];
    // A string still open at the end: its quote closes it before any bracket.
    let mut quote: Option<char> = None;
    let mut in_double = false;
    while let Some(token) = lexer.advance() {
        let Ok(token) = token else { continue };
        quote = None;
        match token.kind {
            TokenKind::PartialLiteralString => quote = token.value.first().map(|q| *q as char),
            TokenKind::DoubleQuote => in_double = !in_double,
            TokenKind::LeftBrace | TokenKind::DollarLeftBrace => open.push('}'),
            TokenKind::LeftBracket | TokenKind::HashLeftBracket => open.push(']'),
            TokenKind::LeftParenthesis => open.push(')'),
            TokenKind::RightBrace | TokenKind::RightBracket | TokenKind::RightParenthesis => {
                open.pop();
            }
            _ => {}
        }
    }
    let mut out = String::new();
    if let Some(q) = quote {
        out.push(q);
    } else if in_double {
        out.push('"');
    }
    for closer in open.iter().rev() {
        if *closer == '}' {
            out.push(';');
        }
        out.push(*closer);
    }
    if !out.is_empty() {
        out.push(';');
    }
    out
}

/// `text` with closers appended for brackets left open at its end and a `;` for an unfinished last
/// statement, so a class being written at the end of a file still parses.
pub fn balance_end(text: &str) -> String {
    let closers = closers(text, false);
    format!("{text}{}", if closers.is_empty() { ";" } else { &closers })
}

/// The text with the statement at `offset` ended there: closers for the brackets opened since the start of
/// the innermost function body, then spaces up to that body's closing brace. The result has the same length,
/// so every declaration keeps its span. `None` when the cursor isn't in a function body with room for them.
pub fn at_cursor(parsed: &Parsed<'_>, offset: u32) -> Option<String> {
    let text = parsed.text();
    let path = parsed.path_at(offset);
    let body: &Block<'_> = path.iter().rev().find_map(|n| match n {
        Node::Function(f) => Some(&f.body),
        Node::Method(m) => match &m.body {
            mago_syntax::cst::MethodBody::Concrete(b) => Some(b),
            _ => None,
        },
        Node::Closure(c) => Some(&c.body),
        _ => None,
    })?;
    let open = body.left_brace.end.offset as usize;
    let close = body.right_brace.start.offset as usize;
    // Inside a finished string, such as one the editor closed as you typed its opening quote, the statement
    // ends after the string, so what's typed in it stays a string. A string that runs on past the cursor's
    // line is one left open, which swallowed the code after it.
    let offset = path
        .iter()
        .rev()
        .find_map(|n| match n {
            Node::LiteralString(s) if s.span().start.offset < offset && offset < s.span().end.offset => {
                let rest = &text[offset as usize..s.span().end.offset as usize];
                (!rest.contains('\n')).then(|| s.span().end.offset)
            }
            _ => None,
        })
        .unwrap_or(offset) as usize;
    if !(open <= offset && offset <= close) || body.right_brace.is_zero() {
        return None;
    }
    let closers = closers(&text[open..offset], true);
    if offset + closers.len() > close {
        return None;
    }
    let mut out = String::with_capacity(text.len());
    out.push_str(&text[..offset]);
    out.push_str(&closers);
    out.extend(std::iter::repeat_n(' ', close - offset - closers.len()));
    out.push_str(&text[close..]);
    debug_assert_eq!(out.len(), text.len());
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mago_allocator::LocalArena;

    #[test]
    fn closes_brackets_left_open_at_the_end() {
        let text = "<?php class A { function f() { $x->send('(', [1, // ) ]\n";
        assert_eq!(balance_end(text), format!("{text}]);}};}};"));
        assert_eq!(balance_end("<?php f(1)"), "<?php f(1);");
        assert_eq!(balance_end("<?php route('ho"), "<?php route('ho');");
        assert_eq!(balance_end("<?php f(\"a {$b} c"), "<?php f(\"a {$b} c\");");
    }

    #[test]
    fn ends_the_statement_at_the_cursor_without_moving_declarations() {
        let text = "<?php\nclass A {\n    function f() {\n        if ($a) { $m->send('x', [1, \n    }\n    function g() {}\n}\n";
        let arena = LocalArena::new();
        let parsed = Parsed::new(&arena, std::path::Path::new("/a.php"), text);
        let cursor = text.find("[1, ").unwrap() + 4;
        let repaired = at_cursor(&parsed, cursor as u32).unwrap();
        assert_eq!(repaired.len(), parsed.text().len());
        assert!(repaired.starts_with(&format!("{}]);}};", &text[..cursor])), "{repaired}");
        // The rest of the function body is blanked up to its closing brace, wherever the parser put it.
        assert!(repaired[cursor..].trim_start_matches([']', ')', ';', '}', ' ']).len() < text.len() - cursor, "{repaired}");
    }
}
