//! Where the index's memory goes: `cargo run --release --example mem_breakdown <root>`.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use tusk_lsp::index::{Index, IndexConfig};

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 { LIVE.fetch_add(l.size(), Ordering::Relaxed); unsafe { System.alloc(l) } }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) { LIVE.fetch_sub(l.size(), Ordering::Relaxed); unsafe { System.dealloc(p, l) } }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 { LIVE.fetch_add(n, Ordering::Relaxed); LIVE.fetch_sub(l.size(), Ordering::Relaxed); unsafe { System.realloc(p, l, n) } }
}
#[global_allocator]
static A: Counting = Counting;
fn live() -> usize { LIVE.load(Ordering::Relaxed) / 1_000_000 }
fn rss() -> u64 {
    let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse::<u64>().unwrap_or(0) / 1024
}
fn main() {
    let root = std::env::args().nth(1).unwrap();
    let _ = tusk_lsp::index::prelude();
    println!("prelude: {} MB rss, {} MB live", rss(), live());
    let mut idx = Index::empty(IndexConfig::new(&root));
    let paths = idx.discover();
    idx.build(paths, |p| std::fs::read(p).ok(), |_, _| {});
    println!("built: {} MB rss, {} MB live", rss(), live());
    // macOS's allocator keeps freed pages until asked to return them.
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" { fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize; }
        let freed = unsafe { malloc_zone_pressure_relief(std::ptr::null_mut(), 0) };
        println!("pressure relief freed {} MB -> {} MB rss", freed / 1_000_000, rss());
    }
    let before = live();
    let issues: usize = idx.codebase.class_likes.values().map(|c| c.issues.len()).sum::<usize>() + idx.codebase.function_likes.values().map(|f| f.issues.len()).sum::<usize>();
    println!("issues kept in metadata: {issues}");
    for c in idx.codebase.class_likes.values_mut() { c.issues.clear(); c.issues.shrink_to_fit(); }
    for f in idx.codebase.function_likes.values_mut() { f.issues.clear(); f.issues.shrink_to_fit(); }
    println!("after dropping issues: {} MB live (-{})", live(), before - live());
    macro_rules! drop_field { ($label:expr, $f:expr) => {{ let before = live(); for f in idx.codebase.function_likes.values_mut() { $f(f); } println!("{}: -{} MB", $label, before - live()); }}; }
    drop_field!("type_resolution_context", |f: &mut mago_codex::metadata::function_like::FunctionLikeMetadata| f.type_resolution_context = None);
    drop_field!("attributes", |f: &mut mago_codex::metadata::function_like::FunctionLikeMetadata| { f.attributes = Vec::new(); });
    drop_field!("assertions", |f: &mut mago_codex::metadata::function_like::FunctionLikeMetadata| { f.assertions.clear(); f.if_true_assertions.clear(); f.if_false_assertions.clear(); });
    drop_field!("thrown_types", |f: &mut mago_codex::metadata::function_like::FunctionLikeMetadata| { f.thrown_types = Vec::new(); });
    drop_field!("template_types", |f: &mut mago_codex::metadata::function_like::FunctionLikeMetadata| { f.template_types = Default::default(); });
    drop_field!("return types", |f: &mut mago_codex::metadata::function_like::FunctionLikeMetadata| { f.return_type_metadata = None; f.return_type_declaration_metadata = None; });
    drop_field!("parameters", |f: &mut mago_codex::metadata::function_like::FunctionLikeMetadata| { f.parameters = Vec::new(); });
    drop_field!("where/globals/method", |f: &mut mago_codex::metadata::function_like::FunctionLikeMetadata| { f.globals_accessed = Default::default(); f.method_metadata = None; });
    let before = live();
    let n = idx.codebase.function_likes.len();
    idx.codebase.function_likes.clear(); idx.codebase.function_likes.shrink_to_fit();
    println!("function_likes remaining ({n} structs): -{} MB", before - live());
    let before = live();
    idx.codebase.class_likes.clear();
    println!("class_likes: -{} MB, left {} MB", before - live(), live());
    let before = live();
    idx.codebase.function_likes.retain(|_, f| f.flags.is_user_defined() || !(f.kind.is_closure() || f.kind.is_arrow_function()));
    println!("after dropping vendor closures: {} MB live (-{})", live(), before - live());
    let before = live();
    for c in idx.codebase.class_likes.values_mut() { c.inheritable_method_ids = Default::default(); c.overridden_method_ids = Default::default(); }
    println!("inheritable+overridden maps: -{} MB", before - live());
    let mut kinds = std::collections::BTreeMap::new();
    for ((_, _), f) in idx.codebase.function_likes.iter() {
        let user = f.flags.is_user_defined();
        *kinds.entry((format!("{:?}", f.kind), user)).or_insert(0usize) += 1;
    }
    for (k, n) in kinds { println!("{k:?}: {n}"); }
    let params: usize = idx.codebase.function_likes.values().map(|f| f.parameters.len()).sum();
    println!("params: {params}");
    let (mut ap, mut dp, mut ip, mut ov) = (0, 0, 0, 0);
    for c in idx.codebase.class_likes.values() { ap += c.appearing_method_ids.len(); dp += c.declaring_method_ids.len(); ip += c.inheritable_method_ids.len(); ov += c.overridden_method_ids.values().map(|m| m.len()).sum::<usize>(); }
    println!("method id maps: appearing {ap} declaring {dp} inheritable {ip} overridden {ov}");
}
