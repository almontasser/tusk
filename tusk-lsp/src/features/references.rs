//! Find references and document highlights.
//!
//! A search reads the project's files (open documents first), keeps those whose text mentions the name, and
//! resolves every mention in them in parallel. Members match when they resolve to the same declaration, so
//! `$admin->save()` finds calls made through a parent class too.

use std::path::{Path, PathBuf};

use lsp_types::{DocumentHighlight, DocumentHighlightKind, DocumentHighlightParams, Location, ReferenceParams};
use mago_allocator::LocalArena;
use mago_codex::metadata::CodebaseMetadata;
use mago_span::HasSpan;
use mago_syntax::cst::Node;
use rayon::prelude::*;

use super::with_ctx;
use crate::analysis::{Analysis, Parsed, analyze};
use crate::index::Index;
use crate::locate::{declaration, variable_spans, walk};
use crate::server::Snapshot;
use crate::symbol::{Resolver, Symbol};
use crate::text::{LineIndex, path_to_uri};

/// A symbol reduced to what identifies it: members by their declaring class, names in lowercase where PHP
/// ignores case.
fn key(symbol: &Symbol, codebase: &CodebaseMetadata) -> Symbol {
    let declaring = |class: &str, found: Option<mago_word::Word>| {
        found.map_or_else(|| class.to_ascii_lowercase(), |w| w.as_str_lossy().to_ascii_lowercase())
    };
    match symbol {
        Symbol::Class(name) => Symbol::Class(name.to_ascii_lowercase()),
        Symbol::Function(name) => Symbol::Function(name.to_ascii_lowercase()),
        Symbol::Constant(name) => Symbol::Constant(name.clone()),
        Symbol::Method { class, name } => Symbol::Method {
            class: declaring(class, codebase.get_declaring_method_class(class.as_bytes(), name.as_bytes())),
            name: name.to_ascii_lowercase(),
        },
        Symbol::Property { class, name } => Symbol::Property {
            class: declaring(class, codebase.get_declaring_property_class(class.as_bytes(), format!("${name}").as_bytes())),
            name: name.clone(),
        },
        Symbol::ClassConstant { class, name } => {
            // Constants aren't tracked by declaring class, so walk up to the one that declares it.
            let mut owner = class.to_ascii_lowercase();
            let ancestors = codebase.get_class_ancestors(class.as_bytes());
            for a in std::iter::once(mago_word::word(class.as_bytes())).chain(ancestors) {
                if let Some(meta) = codebase.get_class_like(a.as_bytes())
                    && (meta.constants.keys().any(|k| k.as_str_lossy() == *name)
                        || meta.enum_cases.keys().any(|k| k.as_str_lossy() == *name))
                {
                    owner = meta.name.as_str_lossy().to_ascii_lowercase();
                    break;
                }
            }
            Symbol::ClassConstant { class: owner, name: name.clone() }
        }
        Symbol::Variable { .. } => symbol.clone(),
    }
}

/// The short name a mention of `symbol` is written with, used to skip files that can't mention it.
fn short_name(symbol: &Symbol) -> String {
    let name = match symbol {
        Symbol::Class(n) | Symbol::Function(n) | Symbol::Constant(n) => n.rsplit('\\').next().unwrap_or(n),
        Symbol::Method { name, .. } | Symbol::Property { name, .. } | Symbol::ClassConstant { name, .. } => name,
        Symbol::Variable { name, .. } => name,
    };
    name.to_ascii_lowercase()
}

/// The spans in one parsed file that mention any of `targets` (already keyed).
fn mentions(parsed: &Parsed<'_>, analysis: &Analysis, codebase: &CodebaseMetadata, targets: &[Symbol], short: &str) -> Vec<(u32, u32)> {
    let resolver = Resolver::new(parsed, Some(analysis), codebase);
    let text = parsed.text();
    let mut candidates = vec![];
    walk(parsed, |node, _| {
        let (s, e) = match node {
            Node::LocalIdentifier(_) | Node::QualifiedIdentifier(_) | Node::FullyQualifiedIdentifier(_) | Node::DirectVariable(_) => {
                (node.span().start.offset, node.span().end.offset)
            }
            _ => return,
        };
        let written = text[s as usize..e as usize].trim_start_matches('$');
        let last = written.rsplit('\\').next().unwrap_or(written);
        // An alias (`use Foo as Bar`) is written differently from the class it names.
        let aliased = matches!(targets.first(), Some(Symbol::Class(_))) && parsed.names.resolve(&node.span()).is_some();
        if last.eq_ignore_ascii_case(short) || aliased {
            candidates.push(s);
        }
    });
    let mut out = vec![];
    for offset in candidates {
        let Some(found) = resolver.at(offset) else { continue };
        if found.symbols.iter().any(|s| targets.contains(&key(s, codebase))) {
            out.push((found.start, found.end));
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Every mention of `symbols` in the project and open documents, as (path, text, spans).
pub fn search(snap: &Snapshot, index: &Index, symbols: &[Symbol]) -> Vec<(PathBuf, String, Vec<(u32, u32)>)> {
    let codebase = &index.codebase;
    let targets: Vec<Symbol> = symbols.iter().map(|s| key(s, codebase)).collect();
    let Some(first) = symbols.first() else { return vec![] };
    let short = short_name(first);
    let mut paths: Vec<PathBuf> = index.project_files().map(Path::to_path_buf).collect();
    paths.extend(snap.docs.iter().filter(|d| d.language == "php").map(|d| d.path.clone()));
    paths.sort();
    paths.dedup();
    let php_version = index.config.php_version;
    paths
        .into_par_iter()
        .filter_map(|path| {
            let text = snap.read(&path)?;
            // Class names may also appear through an alias, which only the `use` line spells out.
            if !text.to_ascii_lowercase().contains(&short) {
                return None;
            }
            let arena = LocalArena::new();
            let parsed = Parsed::new(&arena, &path, &text);
            let analysis = analyze(&parsed, &arena, codebase, php_version);
            let spans = mentions(&parsed, &analysis, codebase, &targets, &short);
            drop(parsed);
            (!spans.is_empty()).then_some((path, text, spans))
        })
        .collect()
}

pub fn references(snap: &Snapshot, params: ReferenceParams) -> Result<Option<Vec<Location>>, String> {
    let at = params.text_document_position;
    let include_declaration = params.context.include_declaration;
    let Some(Some(found)) = with_ctx(snap, &at.text_document.uri, |ctx| ctx.symbol_at(at.position)) else { return Ok(None) };

    // Variables live in one file.
    if let Some(Symbol::Variable { name, scope }) = found.symbols.first() {
        let doc = snap.doc(&at.text_document.uri).ok_or("The document isn't open")?;
        let arena = LocalArena::new();
        let parsed = Parsed::new(&arena, &doc.path, &doc.text);
        let spans = variable_spans(&parsed, name, *scope);
        let skip = if include_declaration { 0 } else { 1 };
        return Ok(Some(spans.into_iter().skip(skip).map(|(s, e)| Location { uri: doc.uri.clone(), range: doc.range(s, e) }).collect()));
    }

    let index = snap.index.read();
    let declarations: Vec<_> = found.symbols.iter().filter_map(|s| declaration(s, &index.codebase)).collect();
    let mut out = vec![];
    for (path, text, spans) in search(snap, &index, &found.symbols) {
        let lines = LineIndex::new(&text);
        let uri = path_to_uri(&path);
        for (s, e) in spans {
            let is_declaration = declarations.iter().any(|d| index.path_of(d.file) == Some(path.as_path()) && d.start <= s && e <= d.end);
            if is_declaration && !include_declaration {
                continue;
            }
            out.push(Location { uri: uri.clone(), range: lines.range(&text, s, e) });
        }
    }
    Ok(Some(out))
}

/// Mentions of the symbol under the cursor in its own file.
pub fn highlight(snap: &Snapshot, params: DocumentHighlightParams) -> Result<Option<Vec<DocumentHighlight>>, String> {
    let at = params.text_document_position_params;
    Ok(with_ctx(snap, &at.text_document.uri, |ctx| {
        let found = ctx.symbol_at(at.position)?;
        let spans = match found.symbols.first()? {
            Symbol::Variable { name, scope } => variable_spans(&ctx.parsed, name, *scope),
            first => {
                let codebase = &ctx.index.codebase;
                let targets: Vec<Symbol> = found.symbols.iter().map(|s| key(s, codebase)).collect();
                mentions(&ctx.parsed, ctx.analysis(), codebase, &targets, &short_name(first))
            }
        };
        let highlights = spans
            .into_iter()
            .map(|(s, e)| DocumentHighlight {
                range: ctx.doc.range(s, e),
                kind: Some(if s == found.start && found.declaration { DocumentHighlightKind::WRITE } else { DocumentHighlightKind::TEXT }),
            })
            .collect::<Vec<_>>();
        (!highlights.is_empty()).then_some(highlights)
    })
    .flatten())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Fixture, uri};
    use lsp_types::{ReferenceContext, TextDocumentIdentifier, TextDocumentPositionParams};

    fn refs(fx: &Fixture, include_declaration: bool) -> Vec<(String, u32, u32)> {
        let mut out: Vec<_> = references(&fx.snap, ReferenceParams {
            text_document_position: fx.at(),
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
            context: ReferenceContext { include_declaration },
        })
        .unwrap()
        .unwrap_or_default()
        .into_iter()
        .map(|l| (l.uri.as_str().rsplit('/').next().unwrap().to_string(), l.range.start.line, l.range.start.character))
        .collect();
        out.sort();
        out
    }

    const MODELS: &str = "<?php\nnamespace App;\nclass Base {\n    public function save(): void {}\n}\nclass User extends Base {\n    public function other(): void { $this->save(); }\n}\nclass Unrelated { public function save(): void {} }\n";

    #[test]
    fn finds_method_calls_through_subclasses_but_not_unrelated_classes() {
        let fx = Fixture::new(&[
            ("app/Models.php", MODELS),
            ("app/use.php", "<?php\nuse App\\User;\nuse App\\Unrelated;\nfunction f(User $u, Unrelated $x) {\n    $u->save();\n    $x->save();\n    $u->sa<|>ve();\n}\n"),
        ]);
        assert_eq!(
            refs(&fx, true),
            vec![("Models.php".into(), 3, 20), ("Models.php".into(), 6, 43), ("use.php".into(), 4, 8), ("use.php".into(), 6, 8)]
        );
        assert_eq!(refs(&fx, false).len(), 3);
    }

    #[test]
    fn finds_classes_through_aliases_and_hints() {
        let fx = Fixture::new(&[
            ("app/Models.php", MODELS),
            ("app/use.php", "<?php\nuse App\\User as Person;\nfunction f(Person $p): \\App\\User { return new Person; }\nclass X extends \\App\\Us<|>er {}\n"),
        ]);
        let found: Vec<_> = refs(&fx, false).into_iter().map(|(f, l, c)| format!("{f}:{l}:{c}")).collect();
        assert_eq!(found, vec!["use.php:1:4", "use.php:2:11", "use.php:2:23", "use.php:2:46", "use.php:3:16"]);
    }

    #[test]
    fn highlights_variables_and_members_in_the_file() {
        let fx = Fixture::one("<?php\nfunction f($a) {\n    $b = $a;\n    return fn() => $<|>a + $b;\n}\nfunction g($a) {}\n");
        let h = highlight(&fx.snap, DocumentHighlightParams {
            text_document_position_params: fx.at(),
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        })
        .unwrap()
        .unwrap();
        let lines: Vec<_> = h.iter().map(|h| (h.range.start.line, h.range.start.character)).collect();
        assert_eq!(lines, vec![(1, 12), (2, 10), (3, 20)]);

        let _ = TextDocumentPositionParams { text_document: TextDocumentIdentifier { uri: uri("test.php") }, position: Default::default() };
    }
}
