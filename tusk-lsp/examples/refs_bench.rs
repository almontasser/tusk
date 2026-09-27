//! Times a references search on a real project: `cargo run --release --example refs_bench <root> <class> <method>`.
use std::sync::Arc;
use std::time::Instant;
use tusk_lsp::documents::Documents;
use tusk_lsp::features::references::search;
use tusk_lsp::index::{Index, IndexConfig};
use tusk_lsp::server::Snapshot;
use tusk_lsp::symbol::Symbol;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut idx = Index::empty(IndexConfig::new(&args[1]));
    let paths = idx.discover();
    idx.build(paths, |p| std::fs::read(p).ok(), |_, _| {});
    let snap = Snapshot { docs: Documents::default(), index: Arc::new(parking_lot::RwLock::new(idx)), root: args[1].clone().into(), framework: Arc::new(tusk_lsp::framework::State::new(args[1].clone().into())) };
    let index = snap.index.read();
    let symbol = Symbol::Method { class: args[2].clone(), name: args[3].clone() };
    let pool = rayon::ThreadPoolBuilder::new().stack_size(64 << 20).build().unwrap();
    for _ in 0..2 {
        let t = Instant::now();
        let found = pool.install(|| search(&snap, &index, std::slice::from_ref(&symbol)));
        let n: usize = found.iter().map(|f| f.2.len()).sum();
        println!("{n} references in {} files, {:?}", found.len(), t.elapsed());
    }
}
