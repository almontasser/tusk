//! Folding ranges and selection ranges, both read off the syntax tree.

use lsp_types::{FoldingRange, FoldingRangeKind, FoldingRangeParams, SelectionRange, SelectionRangeParams};
use mago_span::{HasSpan, Span};
use mago_syntax::cst::{Node, NamespaceBody, Statement, TriviaKind};

use super::{Ctx, with_ctx};
use crate::locate::walk;
use crate::server::Snapshot;

pub fn folding_ranges(snap: &Snapshot, params: FoldingRangeParams) -> Result<Option<Vec<FoldingRange>>, String> {
    Ok(with_ctx(snap, &params.text_document.uri, folds))
}

fn folds(ctx: &Ctx<'_>) -> Vec<FoldingRange> {
    let line = |offset: u32| ctx.doc.position(offset).line;
    let mut out: Vec<FoldingRange> = vec![];
    // A bracketed region folds from its opening line to the line before its closing bracket, which stays
    // visible, as VS Code folds.
    let push =|open: Span, close: Span, out: &mut Vec<FoldingRange>| {
        if close.is_zero() {
            return;
        }
        let (start, end) = (line(open.start.offset), line(close.start.offset).saturating_sub(1));
        if end > start {
            out.push(FoldingRange { start_line: start, end_line: end, ..Default::default() });
        }
    };
    walk(&ctx.parsed, |node, _| match node {
        Node::Block(b) => push(b.left_brace, b.right_brace, &mut out),
        Node::Class(c) => push(c.left_brace, c.right_brace, &mut out),
        Node::Interface(c) => push(c.left_brace, c.right_brace, &mut out),
        Node::Trait(c) => push(c.left_brace, c.right_brace, &mut out),
        Node::Enum(c) => push(c.left_brace, c.right_brace, &mut out),
        Node::AnonymousClass(c) => push(c.left_brace, c.right_brace, &mut out),
        Node::Array(a) => push(a.left_bracket, a.right_bracket, &mut out),
        Node::LegacyArray(a) => push(a.left_parenthesis, a.right_parenthesis, &mut out),
        Node::ArgumentList(a) => push(a.left_parenthesis, a.right_parenthesis, &mut out),
        Node::FunctionLikeParameterList(p) => push(p.left_parenthesis, p.right_parenthesis, &mut out),
        Node::Match(m) => push(m.left_brace, m.right_brace, &mut out),
        Node::SwitchBraceDelimitedBody(s) => push(s.left_brace, s.right_brace, &mut out),
        _ => {}
    });
    // Comments fold whole, their last line included.
    for trivia in ctx.parsed.program.trivia.iter() {
        if matches!(trivia.kind, TriviaKind::MultiLineComment | TriviaKind::DocBlockComment) {
            let (start, end) = (line(trivia.span.start.offset), line(trivia.span.end.offset));
            if end > start {
                out.push(FoldingRange { start_line: start, end_line: end, kind: Some(FoldingRangeKind::Comment), ..Default::default() });
            }
        }
    }
    // Consecutive `use` imports fold together.
    let mut uses: Vec<(u32, u32)> = vec![];
    let mut collect = |statements: &mut dyn Iterator<Item = &Statement<'_>>| {
        for s in statements {
            if let Statement::Use(u) = s {
                uses.push((line(u.span().start.offset), line(u.span().end.offset)));
            }
        }
    };
    for s in ctx.parsed.program.statements.iter() {
        match s {
            Statement::Namespace(ns) => match &ns.body {
                NamespaceBody::BraceDelimited(b) => collect(&mut b.statements.iter()),
                NamespaceBody::Implicit(b) => collect(&mut b.statements.iter()),
            },
            other => collect(&mut std::iter::once(other)),
        }
    }
    let mut group: Option<(u32, u32)> = None;
    let flush =|group: Option<(u32, u32)>, out: &mut Vec<FoldingRange>| {
        if let Some((start, end)) = group.filter(|(s, e)| e > s) {
            out.push(FoldingRange { start_line: start, end_line: end, kind: Some(FoldingRangeKind::Imports), ..Default::default() });
        }
    };
    for (start, end) in uses {
        group = match group {
            Some((s, e)) if start <= e + 1 => Some((s, end.max(e))),
            other => {
                flush(other, &mut out);
                Some((start, end))
            }
        };
    }
    flush(group, &mut out);
    out.sort_by_key(|f| (f.start_line, f.end_line));
    out.dedup_by_key(|f| (f.start_line, f.end_line));
    out
}

/// For each position, the spans of the nodes around it, innermost first.
pub fn selection_ranges(snap: &Snapshot, params: SelectionRangeParams) -> Result<Option<Vec<SelectionRange>>, String> {
    Ok(with_ctx(snap, &params.text_document.uri, |ctx| {
        params
            .positions
            .iter()
            .map(|pos| {
                let offset = ctx.offset(*pos);
                let mut spans: Vec<(u32, u32)> = vec![];
                for node in ctx.parsed.path_at(offset).iter() {
                    let s = node.span();
                    let span = (s.start.offset, s.end.offset.min(ctx.doc.text.len() as u32));
                    if span.0 < span.1 && spans.last() != Some(&span) {
                        spans.push(span);
                    }
                }
                // Outermost first here; each range's parent is the one before it.
                let mut range: Option<SelectionRange> = None;
                for (s, e) in spans {
                    range = Some(SelectionRange { range: ctx.doc.range(s, e), parent: range.map(Box::new) });
                }
                range.unwrap_or(SelectionRange { range: lsp_types::Range { start: *pos, end: *pos }, parent: None })
            })
            .collect()
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Fixture, uri};
    use lsp_types::{Position, TextDocumentIdentifier};

    fn fold(text: &str) -> Vec<(u32, u32, Option<FoldingRangeKind>)> {
        let fx = Fixture::one(text);
        let params = FoldingRangeParams {
            text_document: TextDocumentIdentifier { uri: uri("test.php") },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        };
        folding_ranges(&fx.snap, params).unwrap().unwrap().into_iter().map(|f| (f.start_line, f.end_line, f.kind)).collect()
    }

    #[test]
    fn folds_bodies_arrays_comments_and_imports() {
        let text = "<?php\nnamespace App;\nuse A;\nuse B;\n\nuse C;\n/**\n * Doc.\n */\nclass K\n{\n    function f(\n        int $a,\n    ) {\n        return [\n            1,\n        ];\n    }\n    function g() {}\n}\n";
        assert_eq!(
            fold(text),
            vec![
                (2, 3, Some(FoldingRangeKind::Imports)),
                (6, 8, Some(FoldingRangeKind::Comment)),
                (10, 18, None),
                (11, 12, None),
                (13, 16, None),
                (14, 15, None),
            ]
        );
    }

    #[test]
    fn selects_outward_from_the_word() {
        let fx = Fixture::one("<?php\nfunction f() { return strlen('abc') + 1; }\n");
        let params = SelectionRangeParams {
            text_document: TextDocumentIdentifier { uri: uri("test.php") },
            positions: vec![Position::new(1, 24)],
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        };
        let r = selection_ranges(&fx.snap, params).unwrap().unwrap().remove(0);
        let doc = fx.doc("test.php");
        let mut texts = vec![];
        let mut cur = Some(Box::new(r));
        while let Some(r) = cur {
            let (s, e) = (doc.offset(r.range.start) as usize, doc.offset(r.range.end) as usize);
            texts.push(doc.text[s..e].to_string());
            cur = r.parent;
        }
        assert_eq!(texts[0], "strlen");
        assert!(texts.contains(&"strlen('abc')".to_string()));
        assert!(texts.contains(&"strlen('abc') + 1".to_string()));
        // Each range contains the one before it and no two are equal.
        assert!(texts.windows(2).all(|w| w[1].contains(&w[0]) && w[1] != w[0]));
    }
}
