//! Quick fixes: importing a class name that doesn't resolve, and matching a file's namespace and class name
//! to where PSR-4 expects them.

use lsp_types::{Range, TextEdit, WorkspaceEdit};
use mago_names::kind::NameKind;
use mago_span::HasSpan;
use mago_syntax::cst::{NamespaceBody, Statement};
use serde_json::{Value, json};

use super::{Candidate, file_edit};
use crate::features::{BladePhp, Ctx};
use crate::features::moves::{namespace_for, psr4};
use crate::imports::import_edit;
use crate::symbol::Symbol;

/// Classes named `short`, by their fully qualified names, project classes first.
fn classes_named(ctx: &Ctx<'_>, short: &str) -> Vec<String> {
    let mut found: Vec<(crate::index::Origin, String)> = ctx
        .index
        .names()
        .into_iter()
        .filter(|(d, _)| matches!(d.kind, crate::index::DeclKind::Class(_)))
        .map(|(d, origin)| (origin, d.name.as_str_lossy().into_owned()))
        .filter(|(_, name)| name.rsplit('\\').next().is_some_and(|s| s.eq_ignore_ascii_case(short)))
        .collect();
    found.sort();
    found.dedup_by(|a, b| a.1 == b.1);
    found.into_iter().map(|(_, n)| n).take(20).collect()
}

/// A class name at `offset` that resolves to no class: where it is, and the name as written.
fn unresolved_class(ctx: &Ctx<'_>, offset: u32) -> Option<Named> {
    let found = ctx.resolver().at(offset)?;
    let Symbol::Class(fqn) = found.symbols.first()? else { return None };
    if ctx.index.codebase.class_like_exists(fqn.as_bytes()) {
        return None;
    }
    let written = &ctx.doc.text[found.start as usize..found.end as usize];
    (!written.contains('\\')).then(|| (found.start, found.end, written.to_string()))
}

/// [`candidates`]' imports in a Blade view, whose PHP `ctx` has, at `offset` in the view.
pub fn blade_candidates(ctx: &Ctx<'_>, blade: &BladePhp, offset: u32) -> Vec<Candidate> {
    let Some((_, _, short)) = unresolved_class(ctx, blade.php_offset(offset)) else { return vec![] };
    import_candidates(ctx, &short, "fixes.blade_import")
}

/// The edit of a Blade view that imports `fqn` for the class name at `offset` in the view: a `@use` line, or the
/// name written in full.
pub fn blade_resolve(ctx: &Ctx<'_>, blade: &BladePhp, offset: u32, arg: &Value) -> Option<WorkspaceEdit> {
    let fqn = arg.get("fqn")?.as_str()?;
    let (start, end, mut name) = unresolved_class(ctx, blade.php_offset(offset))?;
    let written = name.clone();
    let mut edits = crate::framework::laravel::blade_import(&ctx.index, blade.view(), fqn, &mut name, &written);
    if name != written {
        let range = blade.view().range(blade.view_offset(start)?, blade.view_offset(end)?);
        edits.push(TextEdit { range, new_text: name });
    }
    file_edit(ctx, edits)
}

/// An "Import class" action for each class named `short`, resolved by `id`.
fn import_candidates(ctx: &Ctx<'_>, short: &str, id: &'static str) -> Vec<Candidate> {
    let options = classes_named(ctx, short);
    let only = options.len() == 1;
    options
        .into_iter()
        .map(|fqn| {
            let mut c = Candidate::new(format!("Import class {fqn}"), "quickfix.import_class", id, json!({ "fqn": fqn }));
            c.preferred = only;
            c
        })
        .collect()
}

/// A name's span and text.
type Named = (u32, u32, String);

/// The file's namespace statement's name, and its class-likes' names.
fn declarations(ctx: &Ctx<'_>) -> (Option<Named>, Vec<Named>) {
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
    if let Some((_, _, short)) = unresolved_class(ctx, offset) {
        out.extend(import_candidates(ctx, &short, "fixes.import"));
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
            // Quick fixes only: Organize Imports and Generate's actions are offered everywhere.
            context: CodeActionContext { only: Some(vec![lsp_types::CodeActionKind::QUICKFIX]), ..Default::default() },
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
        .collect()
    }

    #[test]
    fn offers_imports_for_unknown_class_names() {
        let lib = "<?php\nnamespace App\\Models;\nclass User {}\nnamespace Other;\nclass User {}\n";
        let t = titles(&[("lib.php", lib), ("app/x.php", "<?php\nnamespace App;\nfunction f(Us<|>er $u) {}\n")]);
        assert_eq!(t, vec!["Import class App\\Models\\User", "Import class Other\\User"]);
    }

    /// The view at `resources/views/v.blade.php` after the only "Import class" fix, as the editor applies it.
    fn import_in_view(files: &[(&str, &str)]) -> String {
        use lsp_types::{CodeActionOrCommand, DocumentChangeOperation, DocumentChanges, OneOf};
        let fx = Fixture::new(files);
        let at = fx.at();
        let actions = code_actions(&fx.snap, CodeActionParams {
            text_document: TextDocumentIdentifier { uri: at.text_document.uri.clone() },
            range: Range { start: at.position, end: at.position },
            context: CodeActionContext { only: Some(vec![lsp_types::CodeActionKind::QUICKFIX]), ..Default::default() },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        })
        .unwrap()
        .unwrap_or_default();
        let [CodeActionOrCommand::CodeAction(action)] = actions.as_slice() else { panic!("{actions:?}") };
        assert_eq!(action.title, "Import class App\\Models\\Post");
        let resolved = crate::features::actions::resolve(&fx.snap, action.clone()).unwrap();
        let doc = fx.doc("resources/views/v.blade.php");
        let Some(DocumentChanges::Operations(ops)) = resolved.edit.unwrap().document_changes else { panic!() };
        let mut text = doc.text.clone();
        for op in ops {
            let DocumentChangeOperation::Edit(e) = op else { continue };
            let mut list: Vec<_> = e.edits.into_iter().map(|e| match e { OneOf::Left(e) => e, OneOf::Right(a) => a.text_edit }).collect();
            list.sort_by_key(|e| std::cmp::Reverse(doc.offset(e.range.start)));
            for e in list {
                text.replace_range(doc.offset(e.range.start) as usize..doc.offset(e.range.end) as usize, &e.new_text);
            }
        }
        text
    }

    #[test]
    fn imports_an_unknown_class_in_a_blade_view() {
        let post = ("app/Models/Post.php", "<?php\nnamespace App\\Models;\nclass Post { public static function count(): int { return 0; } }\n");
        let blade_use = ("vendor/laravel/CompilesUseStatements.php", "<?php\nnamespace Illuminate\\View\\Compilers\\Concerns;\ntrait CompilesUseStatements {}\n");
        let view = ("resources/views/v.blade.php", "@props(['a'])\n<p>{{ Po<|>st::count() }}</p>\n");
        // With `@use` among the view's first lines, and else, on an older Laravel, written in full.
        assert_eq!(import_in_view(&[post, blade_use, view]), "@props(['a'])\n@use('App\\Models\\Post')\n<p>{{ Post::count() }}</p>\n");
        assert_eq!(import_in_view(&[post, view]), "@props(['a'])\n<p>{{ \\App\\Models\\Post::count() }}</p>\n");
    }

    #[test]
    fn fixes_namespaces_and_class_names_to_match_psr4() {
        let composer = r#"{"autoload": {"psr-4": {"App\\": "app/"}}}"#;
        let t = titles(&[("composer.json", composer), ("app/Models/Post.php", "<?php\nnamespace App;\nclass Po<|>sts {}\n")]);
        assert_eq!(t, vec!["Change namespace to App\\Models", "Rename class to Post"]);
    }
}
