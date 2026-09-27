//! Adding `use` imports: how to write a class name at a position, and the edit that imports it.

use lsp_types::{Position, Range, TextEdit};
use mago_names::kind::NameKind;
use mago_span::HasSpan;
use mago_syntax::cst::{NamespaceBody, Program, Statement};

use crate::documents::Document;
use crate::scope::scope_at;

/// How to refer to a class at a position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reference {
    /// The name to write.
    pub name: String,
    /// The `use` line to add first, if any.
    pub edit: Option<TextEdit>,
}

fn namespace_of(fqn: &str) -> &str {
    fqn.rsplit_once('\\').map_or("", |(ns, _)| ns)
}

fn short(fqn: &str) -> &str {
    fqn.rsplit('\\').next().unwrap_or(fqn)
}

/// How to write `fqn` at `offset`: its short name if it's imported or in the same namespace, else its short
/// name with a new import, or its fully qualified name when the short name is taken by another import.
pub fn reference(doc: &Document, program: &Program<'_>, offset: u32, fqn: &str, kind: NameKind) -> Reference {
    let fqn = fqn.trim_start_matches('\\');
    let scope = scope_at(program, offset);
    let namespace = scope.namespace_name().map(|n| String::from_utf8_lossy(n).into_owned()).unwrap_or_default();
    let short = short(fqn);
    match scope.resolve_alias(kind, short.as_bytes()) {
        Some(bound) if String::from_utf8_lossy(&bound).eq_ignore_ascii_case(fqn) => {
            return Reference { name: short.into(), edit: None };
        }
        Some(_) => return Reference { name: format!("\\{fqn}"), edit: None },
        None => {}
    }
    if namespace_of(fqn).eq_ignore_ascii_case(&namespace) {
        return Reference { name: short.into(), edit: None };
    }
    // Functions and constants fall back to the global namespace, so global ones need no import.
    if kind != NameKind::Default && namespace_of(fqn).is_empty() {
        return Reference { name: short.into(), edit: None };
    }
    Reference { name: short.into(), edit: Some(import_edit(doc, program, offset, fqn, kind)) }
}

/// The edit that adds `use fqn;` among the imports of the namespace at `offset`, keeping them sorted.
pub fn import_edit(doc: &Document, program: &Program<'_>, offset: u32, fqn: &str, kind: NameKind) -> TextEdit {
    let keyword = match kind {
        NameKind::Function => "use function",
        NameKind::Constant => "use const",
        _ => "use",
    };
    let line = format!("{keyword} {fqn};\n");
    let text = &doc.text;
    // The statements of the namespace at `offset`, or of the file.
    let mut statements: Vec<&Statement<'_>> = program.statements.iter().collect();
    let mut namespace_end: Option<u32> = None;
    for statement in program.statements.iter() {
        if let Statement::Namespace(ns) = statement {
            let span = ns.span();
            let inside = span.start.offset <= offset
                && (matches!(ns.body, NamespaceBody::Implicit(_)) || offset <= span.end.offset);
            if inside {
                statements = match &ns.body {
                    NamespaceBody::Implicit(body) => body.statements.iter().collect(),
                    NamespaceBody::BraceDelimited(block) => block.statements.iter().collect(),
                };
                namespace_end = Some(match &ns.body {
                    NamespaceBody::Implicit(body) => body.terminator.span().end.offset,
                    NamespaceBody::BraceDelimited(block) => block.left_brace.end.offset,
                });
            }
        }
    }
    let uses: Vec<(u32, u32, String)> = statements
        .iter()
        .filter_map(|s| match s {
            Statement::Use(u) => {
                let span = u.span();
                let text = &text[span.start.offset as usize..span.end.offset as usize];
                Some((span.start.offset, span.end.offset, text.to_string()))
            }
            _ => None,
        })
        .collect();
    let at = |offset: u32| doc.position(offset);
    let insert = |pos: Position, text: String| TextEdit { range: Range { start: pos, end: pos }, new_text: text };
    if !uses.is_empty() {
        // Before the first import that sorts after it, among imports of the same kind.
        let same_kind: Vec<_> = uses
            .iter()
            .filter(|(_, _, t)| {
                let t = t.to_ascii_lowercase();
                match kind {
                    NameKind::Function => t.starts_with("use function"),
                    NameKind::Constant => t.starts_with("use const"),
                    _ => !t.starts_with("use function") && !t.starts_with("use const"),
                }
            })
            .collect();
        let key = line.to_ascii_lowercase();
        if let Some((start, _, _)) = same_kind.iter().find(|(_, _, t)| t.to_ascii_lowercase().as_str() > key.trim_end()) {
            return insert(at(*start), line);
        }
        let last = same_kind.last().copied().unwrap_or_else(|| uses.last().unwrap());
        let line_end = text[last.1 as usize..].find('\n').map_or(text.len(), |i| last.1 as usize + i + 1);
        return insert(at(line_end as u32), line);
    }
    // After `namespace …;` or `<?php`, with a blank line between.
    let after = match namespace_end {
        Some(end) => end as usize,
        None => text.find("<?php").map_or(0, |i| i + "<?php".len()),
    };
    let line_end = text[after..].find('\n').map_or(text.len(), |i| after + i + 1);
    let blank_after = text[line_end..].starts_with('\n');
    TextEdit {
        range: Range { start: at(line_end as u32), end: at(line_end as u32) },
        new_text: if blank_after { format!("\n{}", line.trim_end()) + "\n" } else { format!("\n{line}\n") },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::Parsed;
    use mago_allocator::LocalArena;
    use std::str::FromStr;

    fn apply(text: &str, fqn: &str) -> (String, String) {
        let doc = Document::new(lsp_types::Uri::from_str("file:///t.php").unwrap(), "/t.php".into(), "php".into(), 1, text.into());
        let arena = LocalArena::new();
        let parsed = Parsed::new(&arena, &doc.path, text);
        let offset = text.find("HERE").unwrap() as u32;
        let r = reference(&doc, parsed.program, offset, fqn, NameKind::Default);
        let mut out = text.to_string();
        if let Some(edit) = r.edit {
            let start = doc.offset(edit.range.start) as usize;
            out.insert_str(start, &edit.new_text);
        }
        (r.name, out)
    }

    #[test]
    fn inserts_imports_in_sorted_order() {
        let text = "<?php\n\nnamespace App;\n\nuse App\\Models\\Post;\nuse Illuminate\\Support\\Str;\n\nHERE\n";
        let (name, out) = apply(text, "App\\Models\\User");
        assert_eq!(name, "User");
        assert_eq!(out, "<?php\n\nnamespace App;\n\nuse App\\Models\\Post;\nuse App\\Models\\User;\nuse Illuminate\\Support\\Str;\n\nHERE\n");
        let (_, out) = apply(text, "Zed\\Last");
        assert!(out.contains("use Illuminate\\Support\\Str;\nuse Zed\\Last;\n"));
        let (_, out) = apply(text, "Aardvark");
        assert!(out.contains("namespace App;\n\nuse Aardvark;\nuse App\\Models\\Post;"));
    }

    #[test]
    fn adds_the_first_import_after_the_namespace() {
        let (_, out) = apply("<?php\n\nnamespace App;\n\nclass A { HERE }\n", "Foo\\Bar");
        assert_eq!(out, "<?php\n\nnamespace App;\n\nuse Foo\\Bar;\n\nclass A { HERE }\n");
        let (_, out) = apply("<?php\nHERE\n", "Foo\\Bar");
        assert_eq!(out, "<?php\n\nuse Foo\\Bar;\n\nHERE\n");
    }

    #[test]
    fn needs_no_import_for_imported_or_same_namespace_names() {
        let text = "<?php\nnamespace App;\nuse Foo\\User;\nHERE";
        assert_eq!(apply(text, "Foo\\User"), ("User".into(), text.into()));
        assert_eq!(apply(text, "App\\Post"), ("Post".into(), text.into()));
        // Another class already has the short name.
        assert_eq!(apply(text, "Bar\\User"), ("\\Bar\\User".into(), text.into()));
    }
}
