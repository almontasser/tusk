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

use crate::analysis::{Parsed, analyze};
use crate::documents::{Document, Documents};
use crate::index::SharedIndex;
use crate::server::Client;

pub enum Event {
    /// An open document changed. Its index update is queued.
    Edited(PathBuf),
    /// The indexer applied updates.
    IndexChanged,
}

/// How long edits must pause before documents other than the edited one are checked again.
const SETTLE: Duration = Duration::from_millis(600);

pub fn spawn(client: Client, docs: Arc<RwLock<Documents>>, index: SharedIndex) -> Sender<Event> {
    let (tx, rx) = crossbeam_channel::unbounded::<Event>();
    std::thread::Builder::new()
        .name("tusk-diagnostics".into())
        .stack_size(64 << 20)
        .spawn(move || {
            let mut edited: HashSet<PathBuf> = HashSet::new();
            let mut others_due = false;
            loop {
                let timeout = if others_due { after(SETTLE) } else { never() };
                select! {
                    recv(rx) -> event => match event {
                        Ok(Event::Edited(path)) => {
                            edited.insert(path);
                        }
                        Ok(Event::IndexChanged) => {
                            for path in edited.drain() {
                                if let Some(doc) = docs.read().get(&path).cloned() {
                                    publish(&client, &index, &doc);
                                }
                            }
                            others_due = true;
                        }
                        Err(_) => return,
                    },
                    recv(timeout) -> _ => {
                        others_due = false;
                        let open: Vec<_> = docs.read().iter().cloned().collect();
                        for doc in open {
                            publish(&client, &index, &doc);
                        }
                    }
                }
            }
        })
        .expect("the diagnostics thread starts");
    tx
}

fn publish(client: &Client, index: &SharedIndex, doc: &Document) {
    if doc.language != "php" {
        return;
    }
    let diagnostics = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| check(index, doc))).unwrap_or_default();
    client.notify::<PublishDiagnostics>(PublishDiagnosticsParams {
        uri: doc.uri.clone(),
        diagnostics,
        version: Some(doc.version),
    });
}

/// The problems in `doc`.
pub fn check(index: &SharedIndex, doc: &Document) -> Vec<Diagnostic> {
    let arena = LocalArena::new();
    // Syntax errors come from the text as written: the parse the analysis uses closes what's left open at
    // the end of the file, which would hide a missing `}`.
    let exact = Parsed::exact(&arena, &doc.path, &doc.text);
    let mut issues: Vec<Issue> = exact.program.errors.iter().map(Issue::from).collect();
    let parsed = if issues.is_empty() { exact } else { Parsed::new(&arena, &doc.path, &doc.text) };
    let index = index.read();
    let analysis = analyze(&parsed, &arena, &index.codebase, index.config.php_version);
    issues.extend(analysis.issues);
    issues.iter().filter_map(|issue| to_diagnostic(doc, &parsed, issue)).collect()
}

fn to_diagnostic(doc: &Document, parsed: &Parsed<'_>, issue: &Issue) -> Option<Diagnostic> {
    let primary = issue
        .annotations
        .iter()
        .filter(|a| a.span.file_id == parsed.file.id)
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
        source: Some("mago".into()),
        message,
        ..Default::default()
    })
}
