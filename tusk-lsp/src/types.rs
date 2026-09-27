//! Reading Mago's types.

use mago_codex::metadata::CodebaseMetadata;
use mago_codex::ttype::TType;
use mago_codex::ttype::atomic::TAtomic;
use mago_codex::ttype::atomic::object::TObject;
use mago_codex::ttype::union::TUnion;

/// The classes a value of type `t` can be an instance of, in their declared case. Template types count as
/// their bounds, and intersections contribute each part.
pub fn class_names(t: &TUnion, codebase: &CodebaseMetadata) -> Vec<String> {
    let mut out = vec![];
    for atomic in t.types.iter() {
        collect(atomic, codebase, &mut out);
    }
    out.dedup();
    out
}

fn collect(atomic: &TAtomic, codebase: &CodebaseMetadata, out: &mut Vec<String>) {
    match atomic {
        TAtomic::Object(TObject::Named(named)) => {
            push(&named.name.as_str_lossy(), codebase, out);
            for part in named.intersection_types.iter().flatten() {
                collect(part, codebase, out);
            }
        }
        TAtomic::Object(TObject::Enum(e)) => push(&e.name.as_str_lossy(), codebase, out),
        TAtomic::GenericParameter(g) => {
            for atomic in g.constraint.types.iter() {
                collect(atomic, codebase, out);
            }
        }
        _ => {}
    }
}

fn push(name: &str, codebase: &CodebaseMetadata, out: &mut Vec<String>) {
    let name = display_class(name, codebase);
    if !out.contains(&name) {
        out.push(name);
    }
}

/// A class name in the case it was declared with, which a type may have lowercased.
pub fn display_class(name: &str, codebase: &CodebaseMetadata) -> String {
    codebase.get_class_like(name.as_bytes()).map_or_else(|| name.to_string(), |c| c.original_name.as_str_lossy().into_owned())
}

/// A type as PHP code would write it.
pub fn display(t: &TUnion) -> String {
    t.get_id().to_string()
}
