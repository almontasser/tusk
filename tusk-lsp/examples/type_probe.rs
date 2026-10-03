//! Prints Mago's problems for PHP read from stdin as if it were `<root>/<rel>`. `cargo run --release --example type_probe <root> <rel> < code.php`
use std::io::Read;
use std::sync::Arc;
use tusk_lsp::documents::Document;
use tusk_lsp::index::{Index, IndexConfig};
fn main() {
    let root = std::path::PathBuf::from(std::env::args().nth(1).unwrap());
    let rel = std::env::args().nth(2).unwrap();
    let mut code = String::new();
    std::io::stdin().read_to_string(&mut code).unwrap();
    let _ = tusk_lsp::index::prelude();
    let mut idx = Index::empty(IndexConfig::new(&root));
    let paths = idx.discover();
    idx.build(paths, |p| std::fs::read(p).ok(), |_, _| {});
    let path = root.join(&rel);
    idx.update(&path, Some(code.clone().into_bytes()));
    let shared = Arc::new(parking_lot::RwLock::new(idx));
    let doc = Document::new(tusk_lsp::text::path_to_uri(&path), path, "php".into(), 0, code);
    for d in tusk_lsp::diagnostics::php_problems(&shared, &doc) {
        let code = match &d.code { Some(lsp_types::NumberOrString::String(c)) => c.clone(), _ => String::new() };
        println!("{}: {} {}", d.range.start.line + 1, code, d.message.lines().next().unwrap_or(""));
    }
}
