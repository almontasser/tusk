//! Memory over many edits: `cargo run --release --example edit_soak <root> <file>`.
use std::time::Instant;
use tusk_lsp::index::{Index, IndexConfig};
fn rss() -> u64 {
    let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse::<u64>().unwrap_or(0) / 1024
}
fn main() {
    let root = std::env::args().nth(1).unwrap();
    let file = std::path::PathBuf::from(std::env::args().nth(2).unwrap());
    let mut idx = Index::empty(IndexConfig::new(&root));
    let paths = idx.discover();
    idx.build(paths, |p| std::fs::read(p).ok(), |_, _| {});
    let text = std::fs::read_to_string(&file).unwrap();
    println!("after build: {} MB", rss());
    let t = Instant::now();
    for i in 0..500 {
        // A new method name each time, as typing one does.
        let edited = text.replacen("{", &format!("{{ public function typed{i}(int $v{i}): string {{ return (string) $v{i}; }}"), 1);
        idx.update(&file, Some(edited.into_bytes()));
        if i % 100 == 99 { println!("after {} edits: {} MB ({:?} each)", i + 1, rss(), t.elapsed() / (i + 1)); }
    }
}
