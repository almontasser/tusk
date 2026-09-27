//! Quick fixes: importing a class name that doesn't resolve, and matching a file's namespace and class name
//! to where PSR-4 expects them.

use lsp_types::{Range, TextEdit, WorkspaceEdit};
use mago_names::kind::NameKind;
use mago_span::HasSpan;
use mago_syntax::cst::{NamespaceBody, Statement};
use serde_json::{Value, json};

use super::{Candidate, file_edit};
use crate::features::Ctx;
use crate::features::moves::{namespace_for, psr4};
use crate::imports::import_edit;
use crate::symbol::Symbol;

/// Classes named `short`, by their fully qualified names, project classes first.
fn classes_named(ctx: &Ctx<'_>, short: &str) -> Vec<String> {
    let mut found: Vec<(bool, String)> = ctx
        .index
        .codebase
        .class_likes
        .values()
        .filter(|c| {
            let name = c.original_name.as_str_lossy();
            name.rsplit('\\').next().is_some_and(|s| s.eq_ignore_ascii_case(short))
        })
        .map(|c| (!c.flags.is_user_defined(), c.original_name.as_str_lossy().into_owned()))
        .collect();
    found.sort();
    found.into_iter().map(|(_, n)| n).take(20).collect()
}

/// A class name at `offset` that resolves to no class, with the name as written.
fn unresolved_class(ctx: &Ctx<'_>, offset: u32) -> Option<String> {
    let found = ctx.resolver().at(offset)?;
    let Symbol::Class(fqn) = found.symbols.first()? else { return None };
    if ctx.index.codebase.class_like_exists(fqn.as_bytes()) {
        return None;
    }
    let written = &ctx.doc.text[found.start as usize..found.end as usize];
    (!written.contains('\\')).then(|| written.to_string())
}

/// The file's namespace statement's name span and text, and its single class-like's name span and text.
fn declarations(ctx: &Ctx<'_>) -> (Option<(u32, u32, String)>, Vec<(u32, u32, String)>) {
    let text = ctx.parsed.text();
    let mut namespace = None;
    let mut classes = vec![];
    let mut take = |s: &Statement<'_>| {
        let name = match s {
            Statement::Class(c) => &c.name,
            Statement::Interface(c) => &c.name,
            Statement::Trait(c) => &c.name,
            Statement::Enum(c) => &c.name,
            _ => return,
        };
        classes.push((name.span.start.offset, name.span.end.offset, String::from_utf8_lossy(name.value).into_owned()));
    };
    for s in ctx.parsed.program.statements.iter() {
        take(s);
        if let Statement::Namespace(ns) = s {
            if let Some(name) = &ns.name {
                let span = name.span();
                namespace = Some((span.start.offset, span.end.offset, text[span.start.offset as usize..span.end.offset as usize].to_string()));
            }
            match &ns.body {
                NamespaceBody::Implicit(b) => b.statements.iter().for_each(&mut take),
                NamespaceBody::BraceDelimited(b) => b.statements.iter().for_each(&mut take),
            }
        }
    }
    (namespace, classes)
}

/// The namespace PSR-4 expects for this file, if a mapped folder holds it.
fn expected_namespace(ctx: &Ctx<'_>) -> Option<String> {
    let composer = ctx.snap.read(&ctx.snap.root.join("composer.json"))?;
    namespace_for(&ctx.snap.root, &psr4(&composer), &ctx.doc.path)
}

pub fn candidates(ctx: &Ctx<'_>, range: Range) -> Vec<Candidate> {
    let offset = ctx.offset(range.start);
    let mut out = vec![];
    if let Some(short) = unresolved_class(ctx, offset) {
        let options = classes_named(ctx, &short);
        let only = options.len() == 1;
        for fqn in options {
            let mut c = Candidate::new(format!("Import class {fqn}"), "quickfix.import_class", "fixes.import", json!({ "fqn": fqn }));
            c.preferred = only;
            out.push(c);
        }
    }
    let (namespace, classes) = declarations(ctx);
    if let Some(expected) = expected_namespace(ctx) {
        let current = namespace.as_ref().map(|n| n.2.clone()).unwrap_or_default();
        if current != expected {
            out.push(Candidate::new(
                format!("Change namespace to {}", if expected.is_empty() { "the global namespace" } else { &expected }),
                "quickfix.fix_namespace_class_name",
                "fixes.namespace",
                Value::Null,
            ));
        }
    }
    let stem = ctx.doc.path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    if let [(_, _, name)] = classes.as_slice()
        && *name != stem
        && crate::features::rename::is_identifier(&stem)
    {
        out.push(Candidate::new(format!("Rename class to {stem}"), "quickfix.fix_namespace_class_name", "fixes.class_name", Value::Null));
    }
    out
}

pub fn resolve(ctx: &Ctx<'_>, action: &str, range: Range, arg: &Value) -> Option<WorkspaceEdit> {
    let offset = ctx.offset(range.start);
    match action {
        "import" => {
            let fqn = arg.get("fqn")?.as_str()?;
            file_edit(ctx, vec![import_edit(&ctx.doc, ctx.parsed.program, offset, fqn, NameKind::Default)])
        }
        "namespace" => {
            let expected = expected_namespace(ctx)?;
            let (namespace, _) = declarations(ctx);
            let edit = match namespace {
                Some((s, e, _)) => TextEdit { range: ctx.doc.range(s, e), new_text: expected },
                None => {
                    let text = &ctx.doc.text;
                    let after = text.find("<?php").map_or(0, |i| i + 5) as u32;
                    TextEdit { range: ctx.doc.range(after, after), new_text: format!("\n\nnamespace {expected};") }
                }
            };
            file_edit(ctx, vec![edit])
        }
        "class_name" => {
            let stem = ctx.doc.path.file_stem()?.to_string_lossy().into_owned();
            let (_, classes) = declarations(ctx);
            let [(s, e, _)] = classes.as_slice() else { return None };
            file_edit(ctx, vec![TextEdit { range: ctx.doc.range(*s, *e), new_text: stem }])
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use crate::features::actions::code_actions;
    use crate::testing::Fixture;
    use lsp_types::{CodeActionContext, CodeActionOrCommand, CodeActionParams, Range, TextDocumentIdentifier};

    fn titles(files: &[(&str, &str)]) -> Vec<String> {
        let fx = Fixture::new(files);
        let at = fx.at();
        code_actions(&fx.snap, CodeActionParams {
            text_document: TextDocumentIdentifier { uri: at.text_document.uri.clone() },
            range: Range { start: at.position, end: at.position },
            context: CodeActionContext::default(),
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        })
        .unwrap()
        .unwrap_or_default()
        .into_iter()
        .map(|a| match a {
            CodeActionOrCommand::CodeAction(a) => a.title,
            CodeActionOrCommand::Command(c) => c.title,
        })
        // Organize Imports is offered everywhere.
        .filter(|t| t != "Organize imports")
        .collect()
    }

    #[test]
    fn offers_imports_for_unknown_class_names() {
        let lib = "<?php\nnamespace App\\Models;\nclass User {}\nnamespace Other;\nclass User {}\n";
        let t = titles(&[("lib.php", lib), ("app/x.php", "<?php\nnamespace App;\nfunction f(Us<|>er $u) {}\n")]);
        assert_eq!(t, vec!["Import class App\\Models\\User", "Import class Other\\User"]);
    }

    #[test]
    fn fixes_namespaces_and_class_names_to_match_psr4() {
        let composer = r#"{"autoload": {"psr-4": {"App\\": "app/"}}}"#;
        let t = titles(&[("composer.json", composer), ("app/Models/Post.php", "<?php\nnamespace App;\nclass Po<|>sts {}\n")]);
        assert_eq!(t, vec!["Change namespace to App\\Models", "Rename class to Post"]);
    }
}
