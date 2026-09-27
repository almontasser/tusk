//! Times inlay hints and folding for one file of a real project:
//! `cargo run --release --example inlay_bench <root> <file>`.
use std::sync::Arc;
use std::time::Instant;

use lsp_types::{InlayHintParams, Position, Range, TextDocumentIdentifier};
use tusk_lsp::documents::Documents;
use tusk_lsp::features::inlay::inlay_hints;
use tusk_lsp::index::{Index, IndexConfig};
use tusk_lsp::server::Snapshot;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut idx = Index::empty(IndexConfig::new(&args[1]));
    let paths = idx.discover();
    idx.build(paths, |p| std::fs::read(p).ok(), |_, _| {});
    let snap = Snapshot { docs: Documents::default(), index: Arc::new(parking_lot::RwLock::new(idx)), root: args[1].clone().into(), framework: Arc::new(tusk_lsp::framework::State::new(args[1].clone().into())), client: None };
    let uri = tusk_lsp::text::path_to_uri(std::path::Path::new(&args[2]));
    let pool = rayon::ThreadPoolBuilder::new().stack_size(64 << 20).build().unwrap();
    for _ in 0..3 {
        let params = InlayHintParams {
            text_document: TextDocumentIdentifier { uri: uri.clone() },
            range: Range { start: Position::new(0, 0), end: Position::new(100_000, 0) },
            work_done_progress_params: Default::default(),
        };
        let t = Instant::now();
        let hints = pool.install(|| inlay_hints(&snap, params)).unwrap().unwrap_or_default();
        println!("{} inlay hints in {:?}", hints.len(), t.elapsed());
    }
}
