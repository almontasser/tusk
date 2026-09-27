//! Go to definition, declaration, type definition, and implementation.

use lsp_types::request::{GotoDeclarationParams, GotoImplementationParams, GotoTypeDefinitionParams};
use lsp_types::{GotoDefinitionParams, GotoDefinitionResponse, Location};
use mago_codex::metadata::CodebaseMetadata;
use mago_codex::ttype::union::TUnion;
use mago_span::HasSpan;

use super::{Ctx, with_ctx};
use crate::locate::{Place, declaration, variable_spans};
use crate::server::Snapshot;
use crate::symbol::{Found, Symbol};
use crate::types::{class_names, display_class};

fn response(locations: Vec<Location>) -> Option<GotoDefinitionResponse> {
    (!locations.is_empty()).then_some(GotoDefinitionResponse::Array(locations))
}

pub fn definition(snap: &Snapshot, params: GotoDefinitionParams) -> Result<Option<GotoDefinitionResponse>, String> {
    let at = params.text_document_position_params;
    Ok(with_ctx(snap, &at.text_document.uri, |ctx| {
        let Some(found) = ctx.symbol_at(at.position) else {
            return response(crate::framework::definition(ctx, ctx.offset(at.position)));
        };
        response(definitions(ctx, &found))
    })
    .flatten())
}

fn definitions(ctx: &Ctx<'_>, found: &Found) -> Vec<Location> {
    let mut places = vec![];
    let mut locations = vec![];
    for symbol in &found.symbols {
        match symbol {
            Symbol::Variable { name, scope } => {
                // The first mention in its function: a parameter or the first assignment.
                if let Some(&(start, end)) = variable_spans(&ctx.parsed, name, *scope).first() {
                    locations.push(Location { uri: ctx.doc.uri.clone(), range: ctx.doc.range(start, end) });
                }
            }
            _ => places.extend(declaration(symbol, &ctx.index.codebase)),
        }
    }
    locations.extend(ctx.snap.locations(&ctx.index, places));
    locations
}

/// A method's declaration is the interface or parent method it implements, where there is one.
pub fn declaration_request(snap: &Snapshot, params: GotoDeclarationParams) -> Result<Option<GotoDefinitionResponse>, String> {
    let at = params.text_document_position_params;
    Ok(with_ctx(snap, &at.text_document.uri, |ctx| {
        let found = ctx.symbol_at(at.position)?;
        let codebase = &ctx.index.codebase;
        let mut places = vec![];
        for symbol in &found.symbols {
            if let Symbol::Method { class, name } = symbol {
                places.extend(overridden(codebase, class, name));
            }
        }
        if places.is_empty() {
            return response(definitions(ctx, &found));
        }
        response(ctx.snap.locations(&ctx.index, places))
    })
    .flatten())
}

/// The declarations a method overrides or implements in its parents and interfaces.
fn overridden(codebase: &CodebaseMetadata, class: &str, method: &str) -> Vec<Place> {
    let Some(meta) = codebase.get_class_like(class.as_bytes()) else { return vec![] };
    let lower = method.to_ascii_lowercase();
    let Some(ids) = meta.overridden_method_ids.iter().find(|(k, _)| k.as_str_lossy() == lower).map(|(_, v)| v) else {
        return vec![];
    };
    ids.values()
        .filter_map(|id| codebase.get_method_by_id(id))
        .map(|m| m.name_span.unwrap_or(m.span).into())
        .collect()
}

pub fn type_definition(snap: &Snapshot, params: GotoTypeDefinitionParams) -> Result<Option<GotoDefinitionResponse>, String> {
    let at = params.text_document_position_params;
    Ok(with_ctx(snap, &at.text_document.uri, |ctx| {
        let found = ctx.symbol_at(at.position)?;
        let codebase = &ctx.index.codebase;
        let mut classes: Vec<String> = vec![];
        let mut add = |t: &TUnion| {
            for c in class_names(t, codebase) {
                if !classes.contains(&c) {
                    classes.push(c);
                }
            }
        };
        for symbol in &found.symbols {
            match symbol {
                Symbol::Class(name) => {
                    add(&TUnion::from_atomic(mago_codex::ttype::atomic::TAtomic::Object(
                        mago_codex::ttype::atomic::object::TObject::Named(
                            mago_codex::ttype::atomic::object::named::TNamedObject::new(mago_word::word(name.as_bytes())),
                        ),
                    )));
                }
                Symbol::Method { class, name } => {
                    if let Some(t) = codebase
                        .get_declaring_method(class.as_bytes(), name.as_bytes())
                        .and_then(|m| m.return_type_metadata.as_ref())
                    {
                        add(&t.type_union);
                    }
                }
                Symbol::Function(name) => {
                    if let Some(t) = codebase.get_function(name.as_bytes()).and_then(|m| m.return_type_metadata.as_ref()) {
                        add(&t.type_union);
                    }
                }
                Symbol::Property { class, name } => {
                    if let Some(t) = codebase.get_property_type(class.as_bytes(), format!("${name}").as_bytes()) {
                        add(t);
                    }
                }
                Symbol::Variable { .. } | Symbol::Constant(_) | Symbol::ClassConstant { .. } => {
                    // The type of the expression under the cursor, as the analyzer inferred it.
                    if let Some(t) = ctx.analysis().type_at(found.start, found.end) {
                        add(&t);
                    }
                }
            }
        }
        let places = classes.iter().filter_map(|c| declaration(&Symbol::Class(c.clone()), codebase));
        response(ctx.snap.locations(&ctx.index, places))
    })
    .flatten())
}

/// A class's or interface's descendants, all of them, or the methods overriding a method.
pub fn implementation(snap: &Snapshot, params: GotoImplementationParams) -> Result<Option<GotoDefinitionResponse>, String> {
    let at = params.text_document_position_params;
    Ok(with_ctx(snap, &at.text_document.uri, |ctx| {
        let found = ctx.symbol_at(at.position)?;
        let codebase = &ctx.index.codebase;
        let mut places = vec![];
        for symbol in &found.symbols {
            match symbol {
                Symbol::Class(class) => {
                    for child in descendants(codebase, class) {
                        places.extend(declaration(&Symbol::Class(child), codebase));
                    }
                }
                Symbol::Method { class, name } => {
                    let lower = name.to_ascii_lowercase();
                    for child in descendants(codebase, class) {
                        let Some(meta) = codebase.get_class_like(child.as_bytes()) else { continue };
                        if meta.methods.iter().any(|m| m.as_str_lossy() == lower) {
                            places.extend(declaration(&Symbol::Method { class: child, name: name.clone() }, codebase));
                        }
                    }
                }
                _ => {}
            }
        }
        response(ctx.snap.locations(&ctx.index, places))
    })
    .flatten())
}

pub fn descendants(codebase: &CodebaseMetadata, class: &str) -> Vec<String> {
    let mut out: Vec<String> =
        codebase.get_all_descendants(class.as_bytes()).iter().map(|d| display_class(&d.as_str_lossy(), codebase)).collect();
    out.sort();
    out
}

#[allow(dead_code)]
fn span_start(node: &impl HasSpan) -> u32 {
    node.span().start.offset
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Fixture, uri};
    use lsp_types::{PartialResultParams, Position, Range, WorkDoneProgressParams};

    fn locations(r: Option<GotoDefinitionResponse>) -> Vec<(String, Range)> {
        match r {
            Some(GotoDefinitionResponse::Array(ls)) => {
                ls.into_iter().map(|l| (l.uri.as_str().rsplit('/').next().unwrap().to_string(), l.range)).collect()
            }
            None => vec![],
            other => panic!("{other:?}"),
        }
    }

    fn range(l1: u32, c1: u32, l2: u32, c2: u32) -> Range {
        Range { start: Position::new(l1, c1), end: Position::new(l2, c2) }
    }

    fn goto(files: &[(&str, &str)]) -> Vec<(String, Range)> {
        let fx = Fixture::new(files);
        let params = GotoDefinitionParams {
            text_document_position_params: fx.at(),
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
        };
        locations(definition(&fx.snap, params).unwrap())
    }

    const MODELS: &str = "<?php\nnamespace App;\nclass Base {\n    public function save(): static { return $this; }\n}\nclass User extends Base {\n    public string $name = '';\n    const ROLE = 'x';\n}\ninterface Named { public function name(): string; }\nclass Admin extends User implements Named { public function name(): string { return ''; } }\n";

    #[test]
    fn goes_to_classes_members_and_functions_in_other_files() {
        let files = |text| [("app/Models.php", MODELS), ("test.php", text)];
        assert_eq!(goto(&files("<?php use App\\User; new Us<|>er;")), vec![("Models.php".into(), range(5, 6, 5, 10))]);
        // An inherited method goes to the parent's declaration.
        assert_eq!(
            goto(&files("<?php function f(\\App\\User $u) { $u->sa<|>ve(); }")),
            vec![("Models.php".into(), range(3, 20, 3, 24))]
        );
        // Through a method's `static` return type.
        assert_eq!(
            goto(&files("<?php function f(\\App\\User $u) { $u->save()->na<|>me; }")),
            vec![("Models.php".into(), range(6, 18, 6, 23))]
        );
        assert_eq!(goto(&files("<?php \\App\\User::RO<|>LE;")), vec![("Models.php".into(), range(7, 10, 7, 14))]);
        // PHP's built-ins have no file to go to.
        assert_eq!(goto(&files("<?php strl<|>en('');")), vec![]);
    }

    #[test]
    fn goes_to_the_method_behind_a_relation_property() {
        let files = [
            ("app/Post.php", "<?php\nnamespace App;\nclass Post {\n    public function author(): Author { return new Author; }\n}\nclass Author {}\n"),
            ("t.php", "<?php\nfunction f(\\App\\Post $p) { return $p->aut<|>hor; }\n"),
        ];
        assert_eq!(goto(&files), vec![("Post.php".into(), range(3, 20, 3, 26))]);
    }

    #[test]
    fn goes_to_a_variables_first_mention() {
        assert_eq!(
            goto(&[("test.php", "<?php\nfunction f(int $count) {\n    return $cou<|>nt + 1;\n}")]),
            vec![("test.php".into(), range(1, 16, 1, 21))]
        );
    }

    #[test]
    fn finds_implementations_and_declarations() {
        let fx = Fixture::new(&[("app/Models.php", MODELS), ("test.php", "<?php function f(\\App\\Base $b) { $b; } interface I {} ")]);
        let at = |text: &str, needle: &str| {
            let doc = fx.doc(text);
            let offset = doc.text.find(needle).unwrap() as u32;
            lsp_types::TextDocumentPositionParams {
                text_document: lsp_types::TextDocumentIdentifier { uri: uri(text) },
                position: doc.position(offset + 1),
            }
        };
        let imp = |p| {
            locations(
                implementation(&fx.snap, GotoImplementationParams {
                    text_document_position_params: p,
                    work_done_progress_params: Default::default(),
                    partial_result_params: Default::default(),
                })
                .unwrap(),
            )
        };
        // All descendants, not just direct children.
        let found: Vec<_> = imp(at("app/Models.php", "Base {")).into_iter().map(|(_, r)| r.start.line).collect();
        assert_eq!(found, vec![5, 10]);
        let found: Vec<_> = imp(at("app/Models.php", "name(): string;")).into_iter().map(|(_, r)| r.start.line).collect();
        assert_eq!(found, vec![10]);

        let decl = declaration_request(&fx.snap, GotoDeclarationParams {
            text_document_position_params: at("app/Models.php", "name(): string { return"),
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        })
        .unwrap();
        assert_eq!(locations(decl), vec![("Models.php".into(), range(9, 34, 9, 38))]);
    }
}
