//! How much of `vendor` a project reaches: `cargo run --release --example reach <root>`.
use std::collections::HashSet;
use mago_codex::metadata::CodebaseMetadata;
use mago_codex::ttype::{TType, TypeRef};
use mago_codex::ttype::atomic::TAtomic;
use mago_codex::ttype::atomic::object::TObject;
use mago_codex::ttype::union::TUnion;
use tusk_lsp::index::{Index, IndexConfig};

fn names_in(t: &TUnion, out: &mut Vec<String>) {
    for node in std::iter::once(TypeRef::Union(t)).chain(t.get_all_child_nodes()) {
        if let TypeRef::Atomic(a) = node {
            match a {
                TAtomic::Object(TObject::Named(n)) => out.push(n.name.as_str_lossy().to_ascii_lowercase()),
                TAtomic::Object(TObject::Enum(e)) => out.push(e.name.as_str_lossy().to_ascii_lowercase()),
                _ => {}
            }
        }
    }
}

fn refs(cb: &CodebaseMetadata, class: &str) -> Vec<String> {
    let mut out = vec![];
    let Some(c) = cb.get_class_like(class.as_bytes()) else { return out };
    out.extend(c.direct_parent_class.iter().map(|w| w.as_str_lossy().to_ascii_lowercase()));
    out.extend(c.direct_parent_interfaces.iter().chain(c.used_traits.iter()).map(|w| w.as_str_lossy().to_ascii_lowercase()));
    for m in &c.mixins { names_in(&m.type_union, &mut out); }
    for p in c.properties.values().chain(c.magic_properties.values()) { if let Some(t) = &p.type_metadata { names_in(&t.type_union, &mut out); } }
    for (k, f) in cb.function_likes.iter() {
        if k.0.as_str_lossy().to_ascii_lowercase() != class { continue; }
        if let Some(t) = &f.return_type_metadata { names_in(&t.type_union, &mut out); }
        for p in &f.parameters { if let Some(t) = &p.type_metadata { names_in(&t.type_union, &mut out); } }
    }
    out
}

fn main() {
    let root = std::env::args().nth(1).unwrap();
    let mut idx = Index::empty(IndexConfig::new(&root));
    let paths = idx.discover();
    let host: Vec<_> = paths.iter().filter(|p| !p.to_string_lossy().contains("/vendor/")).cloned().collect();
    idx.build(paths, |p| std::fs::read(p).ok(), |_, _| {});
    let cb = &idx.codebase;
    // Roots: every name the project's files use.
    let mut queue: Vec<String> = vec![];
    for p in &host {
        let text = std::fs::read_to_string(p).unwrap_or_default();
        let arena = mago_allocator::LocalArena::new();
        let parsed = tusk_lsp::analysis::Parsed::new(&arena, p, &text);
        for (_, _, n, _) in parsed.names.iter() { queue.push(String::from_utf8_lossy(n).to_ascii_lowercase()); }
    }
    for c in cb.class_likes.values() { if c.flags.is_user_defined() { queue.push(c.name.as_str_lossy().to_ascii_lowercase()); } }
    let mut seen: HashSet<String> = HashSet::new();
    while let Some(n) = queue.pop() {
        if !seen.insert(n.clone()) { continue; }
        queue.extend(refs(cb, &n));
    }
    let vendor_classes = cb.class_likes.values().filter(|c| !c.flags.is_user_defined()).count();
    let reached_classes = cb.class_likes.values().filter(|c| !c.flags.is_user_defined() && seen.contains(&c.name.as_str_lossy().to_ascii_lowercase())).count();
    let vendor_methods = cb.function_likes.iter().filter(|(k, f)| !k.0.is_empty() && !f.flags.is_user_defined()).count();
    let reached_methods = cb.function_likes.iter().filter(|(k, f)| !k.0.is_empty() && !f.flags.is_user_defined() && seen.contains(&k.0.as_str_lossy().to_ascii_lowercase())).count();
    println!("vendor classes reached {reached_classes} of {vendor_classes}; methods {reached_methods} of {vendor_methods}");
}
