//! Times indexing a project and one incremental update: `cargo run --release --example index_bench <root> [file]`.
//! With `CACHE=<file>`, the index keeps its cache there.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;
use std::time::Instant;
use tusk_lsp::index::{Index, IndexConfig};

fn main() {
    let root = std::env::args().nth(1).expect("project root");
    let t = Instant::now();
    let _ = tusk_lsp::index::prelude();
    println!("prelude: {:?}", t.elapsed());
    rss("after prelude");
    let mut config = IndexConfig::new(&root);
    config.cache = std::env::var_os("CACHE").map(Into::into);
    let mut idx = Index::empty(config);
    let t = Instant::now();
    let paths = idx.discover();
    println!("discover: {} files in {:?}", paths.len(), t.elapsed());
    let t = Instant::now();
    idx.build(paths, |p| std::fs::read(p).ok(), |_, _| {});
    println!("build: {:?} ({} class-likes)", t.elapsed(), idx.codebase.class_likes.len());
    rss("after build");
    if let Some(file) = std::env::args().nth(2) {
        let text = std::fs::read(&file).unwrap();
        for _ in 0..3 {
            let t = Instant::now();
            idx.update(std::path::Path::new(&file), Some(text.clone()));
            println!("update: {:?}", t.elapsed());
        }
    }
}

fn rss(label: &str) {
    let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().unwrap();
    println!("rss {label}: {} MB", String::from_utf8_lossy(&out.stdout).trim().parse::<u64>().unwrap_or(0) / 1024);
}
