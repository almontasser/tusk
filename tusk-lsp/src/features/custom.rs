//! Tusk's own requests, for editor features beyond the protocol.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use lsp_types::{Diagnostic, Location, WorkDoneProgress, WorkDoneProgressBegin, WorkDoneProgressEnd, WorkDoneProgressReport};
use parking_lot::Mutex;
use rayon::prelude::*;
use serde::Deserialize;
use serde_json::Value;

use super::references::search;
use crate::documents::Document;
use crate::locate::declaration;
use crate::server::Snapshot;
use crate::symbol::Symbol;
use crate::text::{LineIndex, path_to_uri};

#[derive(Deserialize)]
struct MemberParams {
    class: String,
    method: String,
}

/// `tusk/memberReferences`: every call of a method in the project, through subclasses too, without its
/// declarations. Change Signature, Inline Method, Safe Delete, and the call hierarchy use it.
pub fn member_references(snap: &Snapshot, params: Value) -> Result<Value, String> {
    let p: MemberParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
    let index = snap.index.read();
    let symbol = Symbol::Method { class: p.class, name: p.method };
    let declarations: Vec<_> = declaration(&symbol, &index.codebase).into_iter().collect();
    let mut out: Vec<Location> = vec![];
    for (path, text, spans) in search(snap, &index, std::slice::from_ref(&symbol)) {
        let lines = LineIndex::new(&text);
        for (s, e) in spans {
            let is_declaration = declarations.iter().any(|d| index.path_of(d.file) == Some(path.as_path()) && d.start <= s && e <= d.end);
            if !is_declaration {
                out.push(Location { uri: path_to_uri(&path), range: lines.range(&text, s, e) });
            }
        }
    }
    serde_json::to_value(out).map_err(|e| e.to_string())
}

/// `tusk/projectProblems`: the problems in every project file, by path relative to the root, as open files get
/// them, and Mago's in the Blade views in `resources/views`. The Problems panel shows these for files that aren't
/// open. With a `workDoneToken` in the params, it reports "<done>/<total> files" as `$/progress` while it checks.
pub fn project_problems(snap: &Snapshot, params: Value) -> Result<Value, String> {
    // ponytail: only the app's own views folder; views that packages or modules register elsewhere are left out.
    let views: Vec<PathBuf> = ignore::WalkBuilder::new(snap.root.join("resources/views"))
        .standard_filters(false)
        .build()
        .flatten()
        .map(|e| e.into_path())
        .filter(|p| p.to_string_lossy().ends_with(".blade.php"))
        .collect();
    let index = snap.index.read();
    let paths: Vec<PathBuf> = index.project_files().map(|p| p.to_path_buf()).chain(views).collect();
    let index = &*index;
    let token = params.get("workDoneToken").and_then(Value::as_str).map(str::to_owned);
    let progress = |value: WorkDoneProgress| {
        if let (Some(client), Some(token)) = (&snap.client, &token) {
            client.progress(token, value);
        }
    };
    let total = paths.len();
    progress(WorkDoneProgress::Begin(WorkDoneProgressBegin { title: "Checking the project".into(), cancellable: Some(true), message: Some(format!("0/{total} files")), percentage: Some(0) }));
    let done = AtomicUsize::new(0);
    let last = Mutex::new(Instant::now());
    let results: BTreeMap<String, Vec<Diagnostic>> = crate::index::scan_pool().install(|| paths
        .into_par_iter()
        .filter_map(|path| {
            if snap.is_cancelled() {
                return None;
            }
            let found = (|| {
                let text = snap.read(&path)?;
                let blade = path.to_string_lossy().ends_with(".blade.php");
                let doc = Document::new(path_to_uri(&path), path.clone(), if blade { "blade" } else { "php" }.into(), 0, text);
                let check = if blade { crate::diagnostics::blade_problems_in } else { crate::diagnostics::php_problems_in };
                let problems = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| check(index, &doc))).ok()?;
                let rel = path.strip_prefix(&snap.root).ok()?.to_string_lossy().into_owned();
                (!problems.is_empty()).then_some((rel, problems))
            })();
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            let mut last = last.lock();
            if last.elapsed() > Duration::from_millis(150) {
                *last = Instant::now();
                progress(WorkDoneProgress::Report(WorkDoneProgressReport { cancellable: Some(true), message: Some(format!("{n}/{total} files")), percentage: Some((n * 100 / total.max(1)) as u32) }));
            }
            found
        })
        .collect());
    progress(WorkDoneProgress::End(WorkDoneProgressEnd { message: None }));
    if snap.is_cancelled() {
        return Err(crate::server::CANCELLED.into());
    }
    serde_json::to_value(results).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fixture;
    use serde_json::json;

    #[test]
    fn finds_member_calls_without_declarations() {
        let fx = Fixture::new(&[
            ("app/A.php", "<?php\nnamespace App;\nclass A { public function run(): void {} }\nclass B extends A {}\n"),
            ("app/use.php", "<?php\nfunction f(\\App\\B $b) { $b->run(); }\n"),
        ]);
        let found: Vec<Location> = serde_json::from_value(member_references(&fx.snap, json!({ "class": "App\\A", "method": "run" })).unwrap()).unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].uri.as_str().ends_with("use.php"));
    }

    #[test]
    fn reports_problems_in_every_project_file() {
        let fx = Fixture::new(&[("app/ok.php", "<?php\n\ndeclare(strict_types=1);\n\nfunction ok(): int { return 1; }\n"), ("app/bad.php", "<?php\nfunction bad(): int { return 'x'; }\n")]);
        let found: BTreeMap<String, Vec<Diagnostic>> = serde_json::from_value(project_problems(&fx.snap, Value::Null).unwrap()).unwrap();
        assert!(found["app/bad.php"].iter().any(|d| d.source.as_deref() == Some("mago")));
        assert!(!found.contains_key("app/ok.php"), "{found:?}");
    }
}
