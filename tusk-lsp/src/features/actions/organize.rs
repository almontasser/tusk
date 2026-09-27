//! Organize Imports and unused imports: `use` statements whose name the file never mentions.
//!
//! Only statements that import one name are removed or sorted. A group (`use A\{B, C};`) or a list
//! (`use A, B;`) stays as written, and so does the run of imports around it.

use lsp_types::{Diagnostic, DiagnosticSeverity, DiagnosticTag, NumberOrString, Range, TextEdit, WorkspaceEdit};
use mago_span::HasSpan;
use mago_syntax::cst::{NamespaceBody, Node, Program, Statement, TriviaKind, Use, UseItems, UseType};
use serde_json::Value;

use super::{Candidate, file_edit};
use crate::analysis::Parsed;
use crate::documents::Document;
use crate::features::Ctx;
use crate::locate::walk;
use crate::symbol::docblock_type_names;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Kind {
    Class,
    Function,
    Const,
}

/// A `use` statement.
#[derive(Debug, Clone)]
struct Import {
    start: u32,
    end: u32,
    /// For a statement that imports one name: its kind, the name it's used by, and the imported name.
    single: Option<(Kind, String, String)>,
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn import_of(u: &Use<'_>) -> Import {
    let span = u.span();
    let one = |kind: Kind, name: &mago_syntax::cst::Identifier<'_>, alias: Option<&[u8]>| {
        let fqn = text(name.value()).trim_start_matches('\\').to_string();
        let alias = alias.map(text).unwrap_or_else(|| fqn.rsplit('\\').next().unwrap_or(&fqn).to_string());
        (kind, alias, fqn)
    };
    let single = match &u.items {
        UseItems::Sequence(s) if s.items.len() == 1 => {
            let item = s.items.iter().next().unwrap();
            Some(one(Kind::Class, &item.name, item.alias.as_ref().map(|a| a.identifier.value)))
        }
        UseItems::TypedSequence(s) if s.items.len() == 1 => {
            let item = s.items.iter().next().unwrap();
            let kind = match s.r#type {
                UseType::Function(_) => Kind::Function,
                UseType::Const(_) => Kind::Const,
            };
            Some(one(kind, &item.name, item.alias.as_ref().map(|a| a.identifier.value)))
        }
        _ => None,
    };
    Import { start: span.start.offset, end: span.end.offset, single }
}

/// The `use` statements of each namespace (or the file), in order.
fn imports(program: &Program<'_>) -> Vec<Vec<Import>> {
    let collect = |statements: Vec<&Statement<'_>>| -> Vec<Import> {
        statements
            .into_iter()
            .filter_map(|s| match s {
                Statement::Use(u) => Some(import_of(u)),
                _ => None,
            })
            .collect()
    };
    let mut out = vec![collect(program.statements.iter().collect())];
    for s in program.statements.iter() {
        if let Statement::Namespace(ns) = s {
            out.push(collect(match &ns.body {
                NamespaceBody::Implicit(b) => b.statements.iter().collect(),
                NamespaceBody::BraceDelimited(b) => b.statements.iter().collect(),
            }));
        }
    }
    out.retain(|group| !group.is_empty());
    out
}

/// The names the file's code and docblocks start with, outside `use` statements: the first segment of each,
/// in its case.
fn mentioned(parsed: &Parsed<'_>) -> Vec<String> {
    let mut out = vec![];
    walk(parsed, |node, ancestors| {
        let (Node::LocalIdentifier(_) | Node::QualifiedIdentifier(_)) = node else { return };
        if ancestors.iter().any(|a| matches!(a, Node::Use(_))) {
            return;
        }
        // Members and declarations are named like imports but never refer to one.
        let parent = ancestors.iter().rev().find(|a| !matches!(a, Node::Identifier(_) | Node::Expression(_)));
        if matches!(
            parent,
            Some(
                Node::ClassLikeMemberSelector(_)
                    | Node::ClassLikeConstantSelector(_)
                    | Node::Method(_)
                    | Node::Function(_)
                    | Node::Class(_)
                    | Node::Interface(_)
                    | Node::Trait(_)
                    | Node::Enum(_)
                    | Node::NamedArgument(_)
                    | Node::ClassLikeConstantItem(_)
                    | Node::EnumCaseUnitItem(_)
                    | Node::EnumCaseBackedItem(_)
                    | Node::ConstantItem(_)
                    | Node::Namespace(_)
            )
        ) {
            return;
        }
        let span = node.span();
        let written = &parsed.text()[span.start.offset as usize..span.end.offset as usize];
        out.push(written.split('\\').next().unwrap_or(written).to_string());
    });
    for t in parsed.program.trivia.iter().filter(|t| t.kind == TriviaKind::DocBlockComment) {
        for (_, _, name) in docblock_type_names(t.value, t.span.start.offset) {
            if !name.starts_with('\\') {
                out.push(name.split('\\').next().unwrap_or(&name).to_string());
            }
        }
    }
    out
}

/// Single-name imports the file never uses.
fn unused(parsed: &Parsed<'_>) -> Vec<Import> {
    let names = mentioned(parsed);
    let used = |kind: Kind, alias: &str| match kind {
        // Class and function names ignore case; constant names don't.
        Kind::Const => names.iter().any(|n| n == alias),
        _ => names.iter().any(|n| n.eq_ignore_ascii_case(alias)),
    };
    imports(parsed.program)
        .into_iter()
        .flatten()
        .filter(|i| i.single.as_ref().is_some_and(|(kind, alias, _)| !used(*kind, alias)))
        .collect()
}

/// A diagnostic for each unused import, which the editor fades.
pub fn diagnostics(parsed: &Parsed<'_>, doc: &Document) -> Vec<Diagnostic> {
    unused(parsed)
        .into_iter()
        .map(|i| {
            let (_, alias, _) = i.single.as_ref().unwrap();
            Diagnostic {
                range: doc.range(i.start, i.end),
                severity: Some(DiagnosticSeverity::HINT),
                code: Some(NumberOrString::String("unused_import".into())),
                source: Some("tusk".into()),
                message: format!("Unused import: `{alias}`"),
                tags: Some(vec![DiagnosticTag::UNNECESSARY]),
                ..Default::default()
            }
        })
        .collect()
}

/// The range of whole lines from the line holding `start` through the line holding `end`, with its newline.
fn lines_of(text: &str, start: u32, end: u32) -> (u32, u32) {
    let s = text[..start as usize].rfind('\n').map_or(0, |i| i + 1);
    let e = text[end as usize..].find('\n').map_or(text.len(), |i| end as usize + i + 1);
    (s as u32, e as u32)
}

/// The edits that remove unused imports and sort the rest.
fn organize(parsed: &Parsed<'_>, doc: &Document) -> Vec<TextEdit> {
    // The parsed text: an unfinished file's is longer, with the brackets it leaves open closed.
    let text = parsed.text();
    let unused: Vec<u32> = unused(parsed).iter().map(|i| i.start).collect();
    let mut edits = vec![];
    for group in imports(parsed.program) {
        // Runs of imports with only whitespace between them.
        let mut runs: Vec<Vec<Import>> = vec![];
        for import in group {
            match runs.last_mut() {
                Some(run) if text[run.last().unwrap().end as usize..import.start as usize].trim().is_empty() => run.push(import),
                _ => runs.push(vec![import]),
            }
        }
        for run in runs {
            let (first, last) = (run[0].start, run.last().unwrap().end);
            let sortable = run.iter().all(|i| i.single.is_some());
            if !sortable {
                // Keep the run's order; only take out its unused imports.
                for i in run.iter().filter(|i| unused.contains(&i.start)) {
                    let (s, e) = lines_of(text, i.start, i.end);
                    edits.push(TextEdit { range: doc.range(s, e), new_text: String::new() });
                }
                continue;
            }
            let mut kept: Vec<&Import> = run.iter().filter(|i| !unused.contains(&i.start)).collect();
            if kept.is_empty() {
                let (s, mut e) = lines_of(text, first, last);
                // Don't leave two blank lines where the imports were.
                let blank_before = text[..s as usize].ends_with("\n\n") || s == 0;
                if blank_before && text[e as usize..].starts_with('\n') {
                    e += 1;
                }
                edits.push(TextEdit { range: doc.range(s, e), new_text: String::new() });
                continue;
            }
            kept.sort_by_key(|i| {
                let (kind, _, fqn) = i.single.as_ref().unwrap();
                (*kind, fqn.to_ascii_lowercase())
            });
            let new_text = kept.iter().map(|i| &text[i.start as usize..i.end as usize]).collect::<Vec<_>>().join("\n");
            if new_text != text[first as usize..last as usize] {
                edits.push(TextEdit { range: doc.range(first, last), new_text });
            }
        }
    }
    edits
}

pub fn candidates(ctx: &Ctx<'_>, range: Range) -> Vec<Candidate> {
    let mut out = vec![Candidate::new("Organize imports", "source.organizeImports", "organize.organize", Value::Null)];
    let start = ctx.offset(range.start);
    if let Some(i) = unused(&ctx.parsed).into_iter().find(|i| i.start <= start && start <= i.end) {
        let mut c = Candidate::new("Remove unused import", "quickfix.remove_unused_import", "organize.remove", Value::from(i.start));
        c.preferred = true;
        out.push(c);
    }
    out
}

pub fn resolve(ctx: &Ctx<'_>, action: &str, _range: Range, arg: &Value) -> Option<WorkspaceEdit> {
    match action {
        "organize" => file_edit(ctx, organize(&ctx.parsed, &ctx.doc)),
        "remove" => {
            let start = arg.as_u64()? as u32;
            let i = unused(&ctx.parsed).into_iter().find(|i| i.start == start)?;
            let (s, e) = lines_of(ctx.parsed.text(), i.start, i.end);
            file_edit(ctx, vec![TextEdit { range: ctx.doc.range(s, e), new_text: String::new() }])
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::with_ctx;
    use crate::testing::{Fixture, uri};

    fn apply(doc: &Document, mut edits: Vec<TextEdit>) -> String {
        let mut text = doc.text.clone();
        edits.sort_by_key(|e| std::cmp::Reverse(doc.offset(e.range.start)));
        for e in edits {
            text.replace_range(doc.offset(e.range.start) as usize..doc.offset(e.range.end) as usize, &e.new_text);
        }
        text
    }

    fn organized(text: &str) -> String {
        let fx = Fixture::one(text);
        with_ctx(&fx.snap, &uri("test.php"), |ctx| apply(&ctx.doc, organize(&ctx.parsed, &ctx.doc))).unwrap()
    }

    #[test]
    fn removes_unused_imports_and_sorts_the_rest() {
        let text = "<?php\nnamespace App;\n\nuse function Str\\slug;\nuse Zed\\Last;\nuse Foo\\Unused;\nuse App\\Models\\User as Person;\nuse const Foo\\LIMIT;\nuse Carbon\\Carbon;\n\n/** @return Carbon */\nfunction f(Person $p): Last { return slug(LIMIT); }\n";
        let out = organized(text);
        assert_eq!(
            out,
            "<?php\nnamespace App;\n\nuse App\\Models\\User as Person;\nuse Carbon\\Carbon;\nuse Zed\\Last;\nuse function Str\\slug;\nuse const Foo\\LIMIT;\n\n/** @return Carbon */\nfunction f(Person $p): Last { return slug(LIMIT); }\n"
        );
        // Organizing again changes nothing.
        assert_eq!(organized(&out), out);
    }

    #[test]
    fn counts_attributes_static_calls_and_qualified_names_but_not_members() {
        let text = "<?php\nuse A\\Attr;\nuse B\\Facade;\nuse C\\Sub;\nuse D\\name;\n#[Attr]\nclass K { function f() { Facade::x(); new Sub\\Thing; $this->name; } }\n";
        assert_eq!(organized(text), "<?php\nuse A\\Attr;\nuse B\\Facade;\nuse C\\Sub;\n#[Attr]\nclass K { function f() { Facade::x(); new Sub\\Thing; $this->name; } }\n");
    }

    #[test]
    fn removes_a_run_that_is_all_unused_with_its_blank_line() {
        let text = "<?php\n\nuse Foo\\A;\nuse Foo\\B;\n\nclass K {}\n";
        assert_eq!(organized(text), "<?php\n\nclass K {}\n");
    }

    #[test]
    fn leaves_groups_in_place() {
        let text = "<?php\nuse Foo\\{A, B};\nuse Unused\\X;\nnew A;\n";
        assert_eq!(organized(text), "<?php\nuse Foo\\{A, B};\nnew A;\n");
    }

    #[test]
    fn reports_unused_imports_and_offers_their_removal() {
        let fx = Fixture::one("<?php\nuse Foo\\<|>Unused;\nuse Foo\\Used;\nnew Used;\n");
        let diags = with_ctx(&fx.snap, &uri("test.php"), |ctx| diagnostics(&ctx.parsed, &ctx.doc)).unwrap();
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].message, "Unused import: `Unused`");
        assert_eq!(diags[0].range.start.line, 1);
        let at = fx.at();
        let edit = with_ctx(&fx.snap, &at.text_document.uri, |ctx| {
            let range = Range { start: at.position, end: at.position };
            let c = candidates(ctx, range).into_iter().find(|c| c.id == "organize.remove").expect("a quickfix");
            resolve(ctx, "remove", range, &c.arg)
        })
        .flatten()
        .unwrap();
        let Some(lsp_types::DocumentChanges::Operations(ops)) = edit.document_changes else { panic!() };
        let lsp_types::DocumentChangeOperation::Edit(e) = &ops[0] else { panic!() };
        let lsp_types::OneOf::Left(e) = &e.edits[0] else { panic!() };
        assert_eq!((e.range.start.line, e.range.end.line, e.new_text.as_str()), (1, 2, ""));
    }
}
