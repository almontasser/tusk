//! Mago's own fixes for its problems: a quick fix for each problem in the request's context, and all the safe
//! ones in the file as `source.fixAll.mago`.
//!
//! The linter runs again for the request, which takes milliseconds; the analyzer only when an analysis problem
//! is in the context, since it takes longer and rarely has fixes.

use lsp_types::{CodeAction, CodeActionKind, CodeActionParams, Diagnostic, NumberOrString, TextEdit};
use mago_database::file::FileId;
use mago_reporting::{AnnotationKind, Issue};
use mago_text_edit::Safety;

use super::{Ctx, file_edit};

pub const FIX_ALL: &str = "source.fixAll.mago";

/// One issue's fix.
struct Fix {
    code: String,
    source: &'static str,
    title: String,
    /// The issue's primary span, where its problem is shown.
    span: (u32, u32),
    safety: Safety,
    edits: Vec<(u32, u32, String)>,
}

fn fixes_of(file: FileId, issues: &[Issue], source: &'static str) -> Vec<Fix> {
    issues
        .iter()
        .filter_map(|issue| {
            let code = issue.code.clone()?;
            let primary = issue.annotations.iter().find(|a| a.kind == AnnotationKind::Primary && a.span.file_id == file)?;
            let edits = issue.edits.get(&file).filter(|e| !e.is_empty())?;
            let safety = edits.iter().map(|e| e.safety).max_by_key(|s| risk(*s)).unwrap_or(Safety::Unsafe);
            let title = issue.help.as_deref().map(|h| h.trim_end_matches('.').to_string()).filter(|h| !h.is_empty()).unwrap_or_else(|| format!("Fix {code}"));
            Some(Fix {
                code,
                source,
                title,
                span: (primary.span.start.offset, primary.span.end.offset),
                safety,
                edits: edits.iter().map(|e| (e.range.start, e.range.end, String::from_utf8_lossy(&e.new_text).into_owned())).collect(),
            })
        })
        .collect()
}

fn risk(safety: Safety) -> u8 {
    match safety {
        Safety::Safe => 0,
        Safety::PotentiallyUnsafe => 1,
        _ => 2,
    }
}

/// Every fix Mago has for the document. Analysis fixes only when `analysis` is set.
fn all_fixes(ctx: &Ctx<'_>, analysis: bool) -> Vec<Fix> {
    let index = &ctx.index;
    let mago = index.config.mago.clone();
    let rel = ctx.doc.path.strip_prefix(&index.config.root).unwrap_or(&ctx.doc.path).to_path_buf();
    let mut out = vec![];
    if mago.lints(&rel) {
        let (file, issues) = crate::diagnostics::lint_issues(&ctx.doc, &rel, &mago);
        out.extend(fixes_of(file, &issues, "mago-lint"));
    }
    // The analysis parses the text with open brackets closed, so its offsets only match a complete file's.
    if analysis && ctx.parsed.text().len() == ctx.doc.text.len() {
        let settings = mago.analyzer_settings(index.config.php_version);
        let result = crate::analysis::analyze_with(&ctx.parsed, ctx.arena, &index.codebase, settings);
        let issues: Vec<Issue> = result.issues.iter().filter(|i| mago.reports_analysis(&rel, i.code.as_deref())).cloned().collect();
        out.extend(fixes_of(ctx.parsed.file.id, &issues, "mago"));
    }
    out
}

fn code_of(d: &Diagnostic) -> Option<&str> {
    match &d.code {
        Some(NumberOrString::String(c)) => Some(c),
        _ => None,
    }
}

/// Whether the fix is for the problem `d` reports: the same code, where the problem is.
fn answers(ctx: &Ctx<'_>, fix: &Fix, d: &Diagnostic) -> bool {
    let (start, end) = (ctx.offset(d.range.start), ctx.offset(d.range.end));
    d.source.as_deref() == Some(fix.source) && code_of(d) == Some(&fix.code) && fix.span.0 <= end && start <= fix.span.1
}

fn is_mago(d: &Diagnostic) -> bool {
    matches!(d.source.as_deref(), Some("mago" | "mago-lint")) && code_of(d).is_some()
}

fn text_edits(ctx: &Ctx<'_>, edits: &[(u32, u32, String)]) -> Vec<TextEdit> {
    edits.iter().map(|(s, e, text)| TextEdit { range: ctx.doc.range(*s, *e), new_text: text.clone() }).collect()
}

/// The actions for the request: fixes for the context's problems, and, when asked for with `only`, the file's
/// safe fixes as one `source.fixAll.mago` action. Fix All takes the fixes for the context's problems, so an
/// editor that hides some of them can leave those out; with no problems in the context it takes every fix.
pub fn code_actions(ctx: &Ctx<'_>, params: &CodeActionParams, fix_all: bool) -> Vec<CodeAction> {
    let problems: Vec<&Diagnostic> = params.context.diagnostics.iter().filter(|d| is_mago(d)).collect();
    if problems.is_empty() && !fix_all {
        return vec![];
    }
    let analysis = problems.iter().any(|d| d.source.as_deref() == Some("mago")) || (fix_all && problems.is_empty());
    let fixes = all_fixes(ctx, analysis);
    let mut out = vec![];
    if fix_all {
        // Fixes that overlap one before them are left for another run, as Mago leaves them.
        let mut kept: Vec<(u32, u32, String)> = vec![];
        for fix in fixes.iter().filter(|f| f.safety == Safety::Safe) {
            if !problems.is_empty() && !problems.iter().any(|d| answers(ctx, fix, d)) {
                continue;
            }
            if fix.edits.iter().any(|(s, e, _)| kept.iter().any(|(ks, ke, _)| (s < ke && ks < e) || s == ks)) {
                continue;
            }
            kept.extend(fix.edits.iter().cloned());
        }
        if !kept.is_empty() {
            out.push(CodeAction {
                title: "Fix All Safe Mago Problems in File".into(),
                kind: Some(CodeActionKind::from(FIX_ALL.to_string())),
                edit: file_edit(ctx, text_edits(ctx, &kept)),
                ..Default::default()
            });
        }
        return out;
    }
    for fix in &fixes {
        let answered: Vec<Diagnostic> = problems.iter().filter(|d| answers(ctx, fix, d)).map(|d| (*d).clone()).collect();
        if answered.is_empty() {
            continue;
        }
        let note = match fix.safety {
            Safety::Safe => "",
            Safety::PotentiallyUnsafe => " (may change behavior)",
            _ => " (unsafe)",
        };
        out.push(CodeAction {
            title: format!("{}{note}", fix.title),
            kind: Some(CodeActionKind::QUICKFIX),
            diagnostics: Some(answered),
            is_preferred: (fix.safety == Safety::Safe).then_some(true),
            edit: file_edit(ctx, text_edits(ctx, &fix.edits)),
            ..Default::default()
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Fixture, uri};
    use lsp_types::{CodeActionContext, Range, TextDocumentIdentifier};

    fn problems(fx: &Fixture) -> Vec<Diagnostic> {
        crate::diagnostics::php_problems(&fx.snap.index, &fx.doc("test.php"))
    }

    fn actions(fx: &Fixture, diagnostics: Vec<Diagnostic>, only: Option<&str>) -> Vec<CodeAction> {
        let params = CodeActionParams {
            text_document: TextDocumentIdentifier { uri: uri("test.php") },
            range: Range::default(),
            context: CodeActionContext { diagnostics, only: only.map(|k| vec![CodeActionKind::from(k.to_string())]), trigger_kind: None },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        };
        let found = super::super::code_actions(&fx.snap, params).unwrap().unwrap_or_default();
        found.into_iter().filter_map(|a| match a { lsp_types::CodeActionOrCommand::CodeAction(a) => Some(a), _ => None }).collect()
    }

    fn applied(fx: &Fixture, action: &CodeAction) -> String {
        let Some(lsp_types::DocumentChanges::Operations(ops)) = action.edit.as_ref().and_then(|e| e.document_changes.clone()) else { panic!("{action:?}") };
        let lsp_types::DocumentChangeOperation::Edit(edit) = &ops[0] else { panic!() };
        let doc = fx.doc("test.php");
        let mut edits: Vec<_> = edit.edits.iter().map(|e| match e { lsp_types::OneOf::Left(e) => e.clone(), lsp_types::OneOf::Right(e) => e.text_edit.clone() }).collect();
        edits.sort_by_key(|e| std::cmp::Reverse(doc.offset(e.range.start)));
        let mut text = doc.text.clone();
        for e in edits {
            text.replace_range(doc.offset(e.range.start) as usize..doc.offset(e.range.end) as usize, &e.new_text);
        }
        text
    }

    const CODE: &str = "<?php\n\ndeclare(strict_types=1);\n\nfunction f(): bool {\n    return (bool) true == true;\n}\n\n$a = array(1, 2);\n$b = array(3);\n";

    #[test]
    fn offers_mago_fixes_for_problems_in_the_context() {
        let fx = Fixture::one(CODE);
        let all = problems(&fx);
        let arrays: Vec<_> = all.iter().filter(|d| code_of(d) == Some("no-array-syntax") || code_of(d) == Some("array-style")).cloned().collect();
        assert_eq!(arrays.len(), 2, "{all:?}");
        let found = actions(&fx, vec![arrays[0].clone()], None);
        let fix = found.iter().find(|a| a.diagnostics.is_some()).expect("a fix for the problem");
        assert_eq!(fix.kind, Some(CodeActionKind::QUICKFIX));
        assert!(applied(&fx, fix).contains("$a = [1, 2];\n$b = array(3);"), "{}", applied(&fx, fix));
        // Nothing without Mago's problems.
        assert!(actions(&fx, vec![], None).iter().all(|a| a.diagnostics.is_none()));
    }

    #[test]
    fn fixes_all_safe_problems_the_context_names() {
        let fx = Fixture::one(CODE);
        let arrays: Vec<_> = problems(&fx).into_iter().filter(|d| matches!(code_of(d), Some("no-array-syntax" | "array-style"))).collect();
        // Every problem, when the context has none.
        let all = actions(&fx, vec![], Some("source.fixAll"));
        assert_eq!(all.len(), 1);
        assert!(applied(&fx, &all[0]).contains("$a = [1, 2];\n$b = [3];"));
        // Only the problems the context names.
        let one = actions(&fx, vec![arrays[1].clone()], Some("source.fixAll"));
        assert!(applied(&fx, &one[0]).contains("$a = array(1, 2);\n$b = [3];"));
    }
}
