//! The namespace and `use` imports in effect at a point in a file, for resolving names the name resolver
//! doesn't record (docblock types, constants, `instanceof` operands) and for choosing how to write a new name.

use mago_names::kind::NameKind;
use mago_names::scope::NamespaceScope;
use mago_span::HasSpan;
use mago_syntax::cst::{NamespaceBody, Program, Statement};

/// The scope at `offset`.
pub fn scope_at(program: &Program<'_>, offset: u32) -> NamespaceScope {
    let mut scope = NamespaceScope::global();
    for statement in program.statements.iter() {
        match statement {
            Statement::Namespace(ns) => {
                let span = ns.span();
                // An implicit body runs to the next namespace; a braced one ends at its brace.
                let inside = span.start.offset <= offset
                    && match &ns.body {
                        NamespaceBody::BraceDelimited(_) => offset <= span.end.offset,
                        NamespaceBody::Implicit(_) => true,
                    };
                if !inside {
                    continue;
                }
                scope = match &ns.name {
                    Some(name) => NamespaceScope::for_namespace(name.value().to_vec()),
                    None => NamespaceScope::global(),
                };
                let statements = match &ns.body {
                    NamespaceBody::BraceDelimited(block) => block.statements.iter().collect::<Vec<_>>(),
                    NamespaceBody::Implicit(body) => body.statements.iter().collect(),
                };
                for s in statements {
                    if let Statement::Use(u) = s {
                        scope.populate_from_use(u);
                    }
                }
            }
            Statement::Use(u) if u.span().start.offset < offset => scope.populate_from_use(u),
            _ => {}
        }
    }
    scope
}

/// A class name as written at `offset`, fully qualified. A leading `\` means it's already qualified.
pub fn resolve_class(scope: &NamespaceScope, name: &str) -> String {
    if let Some(fq) = name.strip_prefix('\\') {
        return fq.to_string();
    }
    match name.to_ascii_lowercase().as_str() {
        // Reserved type names are never classes.
        "self" | "static" | "parent" | "this" => return name.to_string(),
        _ => {}
    }
    let (resolved, _) = scope.resolve(NameKind::Default, name.as_bytes());
    String::from_utf8_lossy(&resolved).into_owned()
}

/// A function or constant name as written, with the global name PHP falls back to when the namespaced one
/// doesn't exist.
pub fn resolve_function_or_constant(scope: &NamespaceScope, kind: NameKind, name: &str) -> (String, Option<String>) {
    if let Some(fq) = name.strip_prefix('\\') {
        return (fq.to_string(), None);
    }
    let (resolved, imported) = scope.resolve(kind, name.as_bytes());
    let resolved = String::from_utf8_lossy(&resolved).into_owned();
    let fallback = (!imported && !name.contains('\\') && resolved != name).then(|| name.to_string());
    (resolved, fallback)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::Parsed;
    use mago_allocator::LocalArena;

    #[test]
    fn resolves_through_namespaces_and_imports() {
        let text = "<?php\nnamespace App\\Http;\nuse App\\Models\\User;\nuse Illuminate\\Support\\Str as S;\n/* here */\n";
        let arena = LocalArena::new();
        let parsed = Parsed::new(&arena, std::path::Path::new("/t.php"), text);
        let scope = scope_at(parsed.program, text.find("here").unwrap() as u32);
        assert_eq!(resolve_class(&scope, "User"), "App\\Models\\User");
        assert_eq!(resolve_class(&scope, "S"), "Illuminate\\Support\\Str");
        assert_eq!(resolve_class(&scope, "Request"), "App\\Http\\Request");
        assert_eq!(resolve_class(&scope, "\\Foo"), "Foo");
        assert_eq!(resolve_class(&scope, "User\\Admin"), "App\\Models\\User\\Admin");
        let (f, fallback) = resolve_function_or_constant(&scope, NameKind::Function, "strlen");
        assert_eq!((f.as_str(), fallback.as_deref()), ("App\\Http\\strlen", Some("strlen")));
    }
}
