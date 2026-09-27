//! Inlay hints: parameter names before positional arguments, and the inferred type after a variable's first
//! assignment.

use lsp_types::{InlayHint, InlayHintKind, InlayHintLabel, InlayHintParams};
use mago_span::HasSpan;
use mago_syntax::cst::{Argument, ArgumentList, AssignmentOperator, Expression, Node, Variable};

use super::signature::called;
use super::with_ctx;
use crate::locate::{variable_scope, variable_spans};
use crate::server::Snapshot;
use crate::types::display;

pub fn inlay_hints(snap: &Snapshot, params: InlayHintParams) -> Result<Option<Vec<InlayHint>>, String> {
    Ok(with_ctx(snap, &params.text_document.uri, |ctx| {
        let (from, to) = (ctx.offset(params.range.start), ctx.offset(params.range.end));
        let resolver = ctx.resolver();
        let analysis = ctx.analysis();
        let text = ctx.parsed.text();
        let mut hints = vec![];
        let hint = |offset: u32, label: String, kind| InlayHint {
            position: ctx.doc.position(offset),
            label: InlayHintLabel::String(label),
            kind: Some(kind),
            text_edits: None,
            tooltip: None,
            padding_left: Some(kind == InlayHintKind::TYPE),
            padding_right: Some(kind == InlayHintKind::PARAMETER),
            data: None,
        };
        crate::locate::walk(&ctx.parsed, |node, path| {
            let span = node.span();
            if span.end.offset < from || span.start.offset > to {
                return;
            }
            let call: Option<(&ArgumentList<'_>, u32, bool)> = match node {
                Node::FunctionCall(c) => Some((&c.argument_list, c.function.span().end.offset.saturating_sub(1), false)),
                Node::MethodCall(c) => Some((&c.argument_list, c.method.span().start.offset, false)),
                Node::NullSafeMethodCall(c) => Some((&c.argument_list, c.method.span().start.offset, false)),
                Node::StaticMethodCall(c) => Some((&c.argument_list, c.method.span().start.offset, false)),
                Node::Instantiation(i) => i.argument_list.as_ref().map(|l| (l, i.class.span().start.offset, true)),
                _ => None,
            };
            if let Some((list, name_at, constructor)) = call {
                if list.arguments.is_empty() {
                    return;
                }
                let Some(function) = called(ctx, &resolver, name_at, constructor) else { return };
                for (i, argument) in list.arguments.iter().enumerate() {
                    // After a named argument, or at an unpacked one, positions stop matching parameters.
                    let Argument::Positional(arg) = argument else { break };
                    if arg.ellipsis.is_some() {
                        break;
                    }
                    let Some(param) = function.parameters.get(i) else { break };
                    let name = param.get_name().0.as_str_lossy().trim_start_matches('$').to_string();
                    let s = arg.value.span();
                    if !(from..=to).contains(&s.start.offset) {
                        continue;
                    }
                    let written = text[s.start.offset as usize..s.end.offset as usize].trim_start_matches('$');
                    if written.eq_ignore_ascii_case(&name) {
                        continue;
                    }
                    let variadic = param.flags.is_variadic();
                    hints.push(hint(s.start.offset, format!("{}{name}:", if variadic { "..." } else { "" }), InlayHintKind::PARAMETER));
                    if variadic {
                        break;
                    }
                }
                return;
            }
            // `$x = value` where it's the variable's first mention in its function.
            let Node::Assignment(a) = node else { return };
            let (AssignmentOperator::Assign(_), Expression::Variable(Variable::Direct(var))) = (&a.operator, a.lhs) else { return };
            if matches!(a.rhs, Expression::Literal(_) | Expression::Instantiation(_) | Expression::Array(_) | Expression::LegacyArray(_)) {
                return;
            }
            let end = var.span.end.offset;
            if !(from..=to).contains(&end) {
                return;
            }
            let name = String::from_utf8_lossy(&var.name[1..]);
            let scope = variable_scope(&ctx.parsed, path);
            if variable_spans(&ctx.parsed, &name, scope).first().is_some_and(|(s, _)| *s != var.span.start.offset + 1) {
                return;
            }
            let rhs = a.rhs.span();
            let Some(t) = analysis.type_of(rhs.start.offset, rhs.end.offset).or_else(|| analysis.type_of(span.start.offset, span.end.offset)) else {
                return;
            };
            if t.is_mixed() || t.is_never() {
                return;
            }
            // `static` narrows a class to the called one, which the hint's short label has no room to explain.
            hints.push(hint(end, format!(": {}", display(&t).replace("&static", "")), InlayHintKind::TYPE));
        });
        hints.sort_by_key(|h| (h.position.line, h.position.character));
        hints
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Fixture, uri};
    use lsp_types::{Position, Range, TextDocumentIdentifier};

    fn hints(text: &str) -> Vec<String> {
        let fx = Fixture::one(text);
        let params = InlayHintParams {
            text_document: TextDocumentIdentifier { uri: uri("test.php") },
            range: Range { start: Position::new(0, 0), end: Position::new(999, 0) },
            work_done_progress_params: Default::default(),
        };
        inlay_hints(&fx.snap, params)
            .unwrap()
            .unwrap()
            .into_iter()
            .map(|h| {
                let InlayHintLabel::String(l) = h.label else { panic!() };
                format!("{}:{} {l}", h.position.line, h.position.character)
            })
            .collect()
    }

    #[test]
    fn names_positional_arguments() {
        let text = "<?php\nfunction send(string $to, int $times = 1, string ...$tags) {}\n$to = 'a';\nsend($to, 2, 'x', 'y');\nsend('b', times: 3);\n";
        let found = hints(text);
        assert!(found.contains(&"3:10 times:".to_string()), "{found:?}");
        assert!(found.contains(&"3:13 ...tags:".to_string()), "{found:?}");
        // Not for a variable named like the parameter, a named argument, or the rest of a variadic.
        assert!(!found.iter().any(|h| h.starts_with("3:5 ")), "{found:?}");
        assert!(!found.iter().any(|h| h.starts_with("3:18")), "{found:?}");
        assert!(found.contains(&"4:5 to:".to_string()), "{found:?}");
        assert!(!found.iter().any(|h| h.starts_with("4:10")), "{found:?}");
    }

    #[test]
    fn shows_inferred_types_after_first_assignments() {
        let text = "<?php\nclass A { function make(): static { return $this; } }\nfunction f(A $a) {\n    $b = $a->make();\n    $b = $a->make();\n    $n = 1;\n    $o = new A;\n}\n";
        let found = hints(text);
        assert_eq!(found.iter().filter(|h| h.contains(": A")).count(), 1, "{found:?}");
        assert!(found.contains(&"3:6 : A".to_string()), "{found:?}");
        assert!(!found.iter().any(|h| h.starts_with("5:") || h.starts_with("6:")), "{found:?}");
    }
}
