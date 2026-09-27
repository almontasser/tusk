//! Compares lazy library loading with loading everything: memory, time, and every project file's problems.
//! `cargo run --release --example lazy_check <root> [all]`
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;
use tusk_lsp::documents::{Document, Documents};
use tusk_lsp::index::{Index, IndexConfig};
fn rss() -> u64 {
    let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse::<u64>().unwrap_or(0) / 1024
}
fn main() {
    let root = std::path::PathBuf::from(std::env::args().nth(1).unwrap());
    let mut config = IndexConfig::new(&root);
    config.load_all = std::env::args().nth(2).as_deref() == Some("all");
    let _ = tusk_lsp::index::prelude();
    let mut idx = Index::empty(config);
    let t = Instant::now();
    let paths = idx.discover();
    idx.build(paths, |p| std::fs::read(p).ok(), |_, _| {});
    println!("build {:?}, {} class-likes loaded, rss {} MB", t.elapsed(), idx.codebase.class_likes.len(), rss());
    let project: Vec<_> = idx.project_files().map(|p| p.to_path_buf()).collect();
    let shared = Arc::new(parking_lot::RwLock::new(idx));
    let mut codes: BTreeMap<String, usize> = BTreeMap::new();
    let pool = rayon::ThreadPoolBuilder::new().stack_size(64 << 20).build().unwrap();
    let t = Instant::now();
    let all: Vec<Vec<lsp_types::Diagnostic>> = pool.install(|| {
        use rayon::prelude::*;
        project.par_iter().map(|p| {
            let text = std::fs::read_to_string(p).unwrap_or_default();
            let doc = Document::new(tusk_lsp::text::path_to_uri(p), p.clone(), "php".into(), 0, text);
            tusk_lsp::diagnostics::php_problems(&shared, &doc)
        }).collect()
    });
    for d in all.iter().flatten() {
        if let Some(lsp_types::NumberOrString::String(c)) = &d.code { *codes.entry(format!("{}:{c}", d.source.clone().unwrap_or_default())).or_default() += 1; }
    }
    println!("checked {} files in {:?}, rss {} MB", project.len(), t.elapsed(), rss());
    for (c, n) in codes { println!("{c} {n}"); }
    let _ = Documents::default();
}
