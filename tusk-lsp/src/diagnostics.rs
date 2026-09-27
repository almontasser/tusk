//! Problems in open documents: parse errors and Mago's analysis, published after each edit.
//!
//! An edited document is checked as soon as the index has its change. Other open documents may depend on it,
//! so they're checked again once edits pause.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel::{Sender, after, never, select};
use lsp_types::notification::PublishDiagnostics;
use lsp_types::{Diagnostic, DiagnosticSeverity, NumberOrString, PublishDiagnosticsParams};
use mago_allocator::LocalArena;
use mago_reporting::{AnnotationKind, Issue, Level};
use parking_lot::RwLock;

use crate::analysis::{Parsed, analyze_with};
use crate::documents::{Document, Documents};
use crate::index::SharedIndex;
use crate::server::{Client, Snapshot};

pub enum Event {
    /// Something other than an edit changed a document's problems, such as a PHPStan run ending.
    Refresh(PathBuf),
    /// An open document changed. Its index update is queued.
    Edited(PathBuf),
    /// The indexer applied updates.
    IndexChanged,
}

/// How long edits must pause before documents other than the edited one are checked again.
const SETTLE: Duration = Duration::from_millis(600);

pub fn spawn(
    client: Client,
    docs: Arc<RwLock<Documents>>,
    index: SharedIndex,
    framework: Arc<crate::framework::State>,
    phpstan: Arc<crate::phpstan::PhpStan>,
    root: PathBuf,
) -> Sender<Event> {
    let (tx, rx) = crossbeam_channel::unbounded::<Event>();
    std::thread::Builder::new()
        .name("tusk-diagnostics".into())
        .stack_size(64 << 20)
        .spawn(move || {
            let snapshot = |docs: &Arc<RwLock<Documents>>| Snapshot {
                docs: docs.read().clone(),
                index: index.clone(),
                root: root.clone(),
                framework: framework.clone(),
                client: None,
                cancel: Default::default(),
            };
            let mut edited: HashSet<PathBuf> = HashSet::new();
            let mut others_due = false;
            loop {
                let timeout = if others_due { after(SETTLE) } else { never() };
                select! {
                    recv(rx) -> event => match event {
                        Ok(Event::Edited(path)) => {
                            edited.insert(path);
                        }
                        Ok(Event::Refresh(path)) => {
                            let snap = snapshot(&docs);
                            if let Some(doc) = snap.docs.get(&path).cloned() {
                                publish(&client, &snap, &doc, &phpstan);
                            }
                        }
                        Ok(Event::IndexChanged) => {
                            let snap = snapshot(&docs);
                            for path in edited.drain() {
                                if let Some(doc) = snap.docs.get(&path).cloned() {
                                    publish(&client, &snap, &doc, &phpstan);
                                }
                            }
                            others_due = true;
                        }
                        Err(_) => return,
                    },
                    recv(timeout) -> _ => {
                        others_due = false;
                        let snap = snapshot(&docs);
                        for doc in snap.docs.iter() {
                            publish(&client, &snap, doc, &phpstan);
                        }
                    }
                }
            }
        })
        .expect("the diagnostics thread starts");
    tx
}

fn publish(client: &Client, snap: &Snapshot, doc: &Document, phpstan: &crate::phpstan::PhpStan) {
    if !matches!(doc.language.as_str(), "php" | "blade") {
        return;
    }
    let mut diagnostics = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| check(snap, doc))).unwrap_or_default();
    diagnostics.extend(phpstan.problems(&doc.path));
    client.notify::<PublishDiagnostics>(PublishDiagnosticsParams {
        uri: doc.uri.clone(),
        diagnostics,
        version: Some(doc.version),
    });
}

/// The problems in `doc`: Mago's for PHP, and the framework's for PHP and Blade.
pub fn check(snap: &Snapshot, doc: &Document) -> Vec<Diagnostic> {
    let mut out = if doc.language == "php" { php_problems(&snap.index, doc) } else { vec![] };
    let framework = crate::features::with_ctx(snap, &doc.uri, crate::framework::diagnostics).unwrap_or_default();
    out.extend(framework);
    out
}

pub fn php_problems(index: &SharedIndex, doc: &Document) -> Vec<Diagnostic> {
    php_problems_in(&index.read(), doc)
}

/// [`php_problems`] with the index already locked, for work that runs in parallel and mustn't take the lock.
pub fn php_problems_in(index: &crate::index::Index, doc: &Document) -> Vec<Diagnostic> {
    let arena = LocalArena::new();
    // Syntax errors come from the text as written: the parse the analysis uses closes what's left open at
    // the end of the file, which would hide a missing `}`.
    let exact = Parsed::exact(&arena, &doc.path, &doc.text);
    // After the first errors, the rest are mostly the parser losing its way, and each costs a position lookup.
    let syntax: Vec<Issue> = exact.program.errors.iter().take(100).map(Issue::from).collect();
    let parsed = if syntax.is_empty() { exact } else { Parsed::new(&arena, &doc.path, &doc.text) };
    let mago = index.config.mago.clone();
    let rel = doc.path.strip_prefix(&index.config.root).unwrap_or(&doc.path).to_path_buf();
    let complex = crate::analysis::too_complex(parsed.program);
    let analysis = analyze_with(&parsed, &arena, &index.codebase, mago.analyzer_settings(index.config.php_version));
    let mut out: Vec<Diagnostic> = syntax.iter().filter_map(|i| to_diagnostic(doc, parsed.file.id, i, "mago")).collect();
    out.extend(
        analysis
            .issues
            .iter()
            .filter(|i| mago.reports_analysis(&rel, i.code.as_deref()))
            .filter_map(|i| to_diagnostic(doc, parsed.file.id, i, "mago")),
    );
    if complex {
        return out;
    }
    if mago.lints(&rel) {
        out.extend(lint(doc, &rel, &mago));
    }
    out.extend(crate::features::actions::organize::diagnostics(&parsed, doc));
    out
}

/// Mago's linter on the document. Its rules match excluded paths against the file's name, so the file is
/// named by its path relative to the project, as Mago names it.
fn lint(doc: &Document, rel: &std::path::Path, mago: &crate::mago_config::MagoConfig) -> Vec<Diagnostic> {
    let (file, issues) = lint_issues(doc, rel, mago);
    issues.iter().filter_map(|i| to_diagnostic(doc, file, i, "mago-lint")).collect()
}

/// The linter's issues, with their fixes, and the ID of the file they're in.
pub fn lint_issues(doc: &Document, rel: &std::path::Path, mago: &crate::mago_config::MagoConfig) -> (mago_database::file::FileId, Vec<Issue>) {
    let arena = LocalArena::new();
    let name = rel.to_string_lossy().into_owned().into_bytes();
    let file = mago_database::file::File::new(
        std::borrow::Cow::Owned(name),
        mago_database::file::FileType::Host,
        Some(doc.path.clone()),
        std::borrow::Cow::Owned(doc.text.clone().into_bytes()),
    );
    let program = mago_syntax::parser::parse_file(&arena, &file);
    let names = mago_names::resolver::NameResolver::new(&arena).resolve(program);
    let linter = mago_linter::Linter::from_registry(&arena, mago.rules.clone(), mago.linter.php_version);
    (file.id, linter.lint(&file, program, &names).into_iter().collect())
}

pub fn to_diagnostic(doc: &Document, file: mago_database::file::FileId, issue: &Issue, source: &str) -> Option<Diagnostic> {
    let primary = issue
        .annotations
        .iter()
        .filter(|a| a.span.file_id == file)
        .find(|a| a.kind == AnnotationKind::Primary)?;
    let severity = match issue.level {
        Level::Error => DiagnosticSeverity::ERROR,
        Level::Warning => DiagnosticSeverity::WARNING,
        Level::Help => DiagnosticSeverity::HINT,
        Level::Note => DiagnosticSeverity::INFORMATION,
    };
    let mut message = issue.message.clone();
    if let Some(label) = primary.message.as_deref().filter(|m| !m.is_empty() && *m != issue.message) {
        message.push_str(&format!("\n{label}"));
    }
    for note in &issue.notes {
        message.push_str(&format!("\n{note}"));
    }
    if let Some(help) = &issue.help {
        message.push_str(&format!("\nHelp: {help}"));
    }
    Some(Diagnostic {
        range: doc.range(primary.span.start.offset, primary.span.end.offset),
        severity: Some(severity),
        code: issue.code.clone().map(NumberOrString::String),
        source: Some(source.into()),
        message,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fixture;

    fn problems(text: &str, mago_toml: &str) -> Vec<(String, String)> {
        let fx = Fixture::one(text);
        {
            let mut index = fx.snap.index.write();
            index.config.mago = std::sync::Arc::new(crate::mago_config::MagoConfig::parse(mago_toml, std::path::Path::new(crate::testing::ROOT)).unwrap());
        }
        let doc = fx.doc("test.php");
        let mut out: Vec<(String, String)> = php_problems(&fx.snap.index, &doc)
            .into_iter()
            .map(|d| (d.source.unwrap_or_default(), match d.code { Some(NumberOrString::String(c)) => c, _ => String::new() }))
            .collect();
        out.sort();
        out
    }

    #[test]
    fn reports_analysis_and_lint_problems_as_configured() {
        let code = "<?php\n\nfunction f(): int { return 'x'; }\n";
        let all = problems(code, "");
        assert!(all.contains(&("mago".into(), "invalid-return-statement".into())), "{all:?}");
        assert!(all.contains(&("mago-lint".into(), "strict-types".into())), "{all:?}");
        let configured = problems(code, "[analyzer]\nignore = [\"invalid-return-statement\"]\n[linter.rules]\nstrict-types = { enabled = false }\n");
        assert!(!configured.iter().any(|(_, c)| c == "invalid-return-statement" || c == "strict-types"), "{configured:?}");
    }

    #[test]
    fn honors_expect_pragmas() {
        let code = "<?php\n\ndeclare(strict_types=1);\n\nfunction f(): int {\n    // @mago-expect analysis:invalid-return-statement\n    return 'x';\n}\n";
        let found = problems(code, "");
        assert!(!found.iter().any(|(_, c)| c == "invalid-return-statement"), "{found:?}");
    }

    #[test]
    fn skips_analysis_of_pathological_files() {
        // Mago's analyzer takes minutes on each and recurses once per term; the syntax check still runs.
        let deep = vec!["1"; 20_000].join(" + ");
        let branches: String = (0..5_000).map(|i| format!("{i} => {i}, ")).collect();
        for body in [format!("$a = {deep};"), format!("$a = match ($b) {{ {branches} }};")] {
            let code = format!("<?php\n\nfunction f(): int {{ return 'x'; }}\n{body}\n$b = (;\n");
            let started = std::time::Instant::now();
            // On a stack as large as the server's threads have.
            let found = std::thread::Builder::new().stack_size(64 << 20).spawn(move || problems(&code, "")).unwrap().join().unwrap();
            assert!(started.elapsed() < std::time::Duration::from_secs(5), "{:?}", started.elapsed());
            assert!(found.iter().all(|(s, _)| s == "mago") && !found.iter().any(|(_, c)| c == "invalid-return-statement"), "{found:?}");
            assert!(!found.is_empty());
        }
    }
}
