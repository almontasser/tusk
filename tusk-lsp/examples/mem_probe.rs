use mago_allocator::LocalArena;
use rayon::prelude::*;
use tusk_lsp::index::{Index, IndexConfig, source_file, prelude};
fn rss(label: &str) {
    let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().unwrap();
    println!("rss {label}: {} MB", String::from_utf8_lossy(&out.stdout).trim().parse::<u64>().unwrap_or(0) / 1024);
}
fn main() {
    let root = std::env::args().nth(1).unwrap();
    let _ = prelude();
    let idx = Index::empty(IndexConfig::new(&root));
    let paths = idx.discover();
    rss("start"); sizes();
    let metas: Vec<_> = paths.par_iter().map(|p| {
        let f = source_file(p, mago_database::file::FileType::Vendored, std::fs::read(p).unwrap());
        let arena = LocalArena::new();
        let program = mago_syntax::parser::parse_file(&arena, &f);
        let names = mago_names::resolver::NameResolver::new(&arena).resolve(program);
        mago_codex::scanner::scan_program(&arena, &f, program, &names, mago_php_version::PHPVersion::PHP84)
    }).collect();
    rss("scanned");
    let mut cb = prelude().metadata.clone();
    for m in &metas { cb.extend_ref(m); }
    drop(metas);
    rss("merged, scans dropped");
    let fl: usize = cb.function_likes.len();
    println!("function_likes {fl}, class_likes {}", cb.class_likes.len());
    let mut refs = prelude().symbol_references.clone();
    mago_codex::populator::populate_codebase(&mut cb, &mut refs, Default::default(), Default::default());
    rss("populated");
    drop(refs);
    rss("refs dropped");
    let appearing: usize = cb.class_likes.values().map(|c| c.appearing_method_ids.len() + c.declaring_method_ids.len() + c.inheritable_method_ids.len() + c.overridden_method_ids.len()).sum();
    println!("method id entries {appearing}");
}
#[allow(dead_code)]
fn sizes() {
    println!("FunctionLikeMetadata {}", std::mem::size_of::<mago_codex::metadata::function_like::FunctionLikeMetadata>());
    println!("ClassLikeMetadata {}", std::mem::size_of::<mago_codex::metadata::class_like::ClassLikeMetadata>());
    println!("PropertyMetadata {}", std::mem::size_of::<mago_codex::metadata::property::PropertyMetadata>());
    println!("TUnion {}", std::mem::size_of::<mago_codex::ttype::union::TUnion>());
    println!("TAtomic {}", std::mem::size_of::<mago_codex::ttype::atomic::TAtomic>());
    println!("ParameterMeta {}", std::mem::size_of::<mago_codex::metadata::parameter::FunctionLikeParameterMetadata>());
}
