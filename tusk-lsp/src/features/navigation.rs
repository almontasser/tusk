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
        // A `.env` key leads to the code that reads it.
        if ctx.doc.language == "dotenv" {
            return response(crate::framework::laravel::env_key_usages(ctx, ctx.offset(at.position)));
        }
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

#[derive(serde::Serialize)]
pub struct Super {
    /// `Class::method`, or a class's short name.
    label: String,
    location: Location,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    /// `method` or `class`.
    kind: &'static str,
    name: String,
    /// The whole declaration and its name.
    range: lsp_types::Range,
    selection: lsp_types::Range,
    /// A method: what it overrides or implements. A class: its parent class and the interfaces it names.
    supers: Vec<Super>,
    /// Whether every super is abstract or an interface's, so the method implements rather than overrides.
    implements: bool,
    /// Whether it's an interface or an abstract method, so its descendants implement rather than override it.
    #[serde(rename = "abstract")]
    is_abstract: bool,
    /// Whether a descendant overrides the method, or extends or implements the class.
    overridden: bool,
}

/// `tusk/overrides`: each class and method the document declares, with what it overrides and whether it's
/// overridden, for Go to Super Method and the gutter icons. Positions come from the document, names from the index.
pub fn overrides(snap: &Snapshot, params: serde_json::Value) -> Result<serde_json::Value, String> {
    let uri: lsp_types::Uri = params
        .pointer("/textDocument/uri")
        .and_then(|u| u.as_str())
        .and_then(|u| u.parse().ok())
        .ok_or("tusk/overrides needs textDocument.uri")?;
    let members = with_ctx(snap, &uri, |ctx| {
        use mago_codex::symbol::SymbolKind;
        use mago_syntax::cst::Node;
        let codebase = &ctx.index.codebase;
        let resolver = crate::symbol::Resolver::new(&ctx.parsed, None, codebase);
        let mut out = vec![];
        crate::locate::walk(&ctx.parsed, |node, path| {
            let (name, span, name_span, class, method) = match node {
                Node::Method(m) => {
                    let Some(class) = resolver.enclosing_class(path) else { return };
                    (String::from_utf8_lossy(m.name.value).into_owned(), m.span(), m.name.span, class, true)
                }
                Node::Class(_) | Node::Interface(_) | Node::Enum(_) => {
                    let name = match node {
                        Node::Class(c) => &c.name,
                        Node::Interface(c) => &c.name,
                        Node::Enum(c) => &c.name,
                        _ => unreachable!(),
                    };
                    let Some(class) = resolver.enclosing_class(&[node]) else { return };
                    (String::from_utf8_lossy(name.value).into_owned(), node.span(), name.span, class, false)
                }
                _ => return,
            };
            let Some(meta) = codebase.get_class_like(class.as_bytes()) else { return };
            let short = |fqn: &str| display_class(fqn, codebase).rsplit('\\').next().unwrap_or_default().to_string();
            let interface = meta.kind == SymbolKind::Interface;
            let (supers, implements, is_abstract, overridden): (Vec<(String, Place)>, bool, bool, bool) = if method {
                let lower = name.to_ascii_lowercase();
                let ids = meta.overridden_method_ids.iter().find(|(k, _)| k.as_str_lossy() == lower).map(|(_, v)| v);
                let ids: Vec<_> = ids.into_iter().flat_map(|ids| ids.values()).collect();
                // Interface methods aren't flagged abstract.
                let implements = !ids.is_empty()
                    && ids.iter().all(|id| {
                        codebase.get_class_like(id.get_class_name().as_bytes()).is_some_and(|c| c.kind == SymbolKind::Interface)
                            || codebase.get_method_by_id(id).is_some_and(|m| m.flags.is_abstract())
                    });
                let overridden = codebase.get_all_descendants(class.as_bytes()).iter().any(|d| {
                    codebase.get_class_like(d.as_bytes()).is_some_and(|c| c.methods.iter().any(|m| m.as_str_lossy() == lower))
                });
                let supers = ids
                    .iter()
                    .filter_map(|id| codebase.get_method_by_id(id).map(|m| (id, m)))
                    .map(|(id, m)| (format!("{}::{}", short(&id.get_class_name().as_str_lossy()), m.original_name.as_str_lossy()), m.name_span.unwrap_or(m.span).into()))
                    .collect();
                let is_abstract = interface || codebase.get_method(class.as_bytes(), name.as_bytes()).is_some_and(|m| m.flags.is_abstract());
                (supers, implements, is_abstract, overridden)
            } else {
                let parents = meta.direct_parent_class.iter().chain(meta.direct_parent_interfaces.iter());
                let supers = parents
                    .filter_map(|p| declaration(&Symbol::Class(p.as_str_lossy().into_owned()), codebase).map(|at| (short(&p.as_str_lossy()), at)))
                    .collect();
                (supers, false, interface, !codebase.get_all_descendants(class.as_bytes()).is_empty())
            };
            out.push(Member {
                kind: if method { "method" } else { "class" },
                name,
                range: ctx.doc.range(span.start.offset, span.end.offset),
                selection: ctx.doc.range(name_span.start.offset, name_span.end.offset),
                supers: supers
                    .into_iter()
                    .filter_map(|(label, at)| Some(Super { label, location: ctx.snap.locations(&ctx.index, [at]).pop()? }))
                    .collect(),
                implements,
                is_abstract,
                overridden,
            });
        });
        out
    })
    .unwrap_or_default();
    serde_json::to_value(members).map_err(|e| e.to_string())
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

    fn declarations(files: &[(&str, &str)]) -> Vec<(String, u32)> {
        let fx = Fixture::new(files);
        let decl = declaration_request(&fx.snap, GotoDeclarationParams {
            text_document_position_params: fx.at(),
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        })
        .unwrap();
        locations(decl).into_iter().map(|(f, r)| (f, r.start.line)).collect()
    }

    #[test]
    fn finds_super_methods_the_way_laravel_code_overrides_them() {
        let vendor = "<?php\nnamespace V;\ninterface Contract { public function handle(): void; }\nabstract class Model {\n    protected function casts(): array { return []; }\n}\nabstract class Resource {\n    public static function form($s) { return $s; }\n}\nabstract class Job implements Contract {}\ntrait HasName { abstract public function name(): string; }\nclass Middle extends Model {}\n";
        let with = |text| [("vendor/V.php", vendor), ("app/A.php", text)];
        // A protected method overriding a parent's.
        assert_eq!(declarations(&with("<?php\nclass U extends \\V\\Model {\n    protected function cas<|>ts(): array { return []; }\n}\n")), vec![("V.php".into(), 4)]);
        // A static method.
        assert_eq!(declarations(&with("<?php\nclass R extends \\V\\Resource {\n    public static function fo<|>rm($s) { return $s; }\n}\n")), vec![("V.php".into(), 7)]);
        // An interface method, implemented through an abstract parent.
        assert_eq!(declarations(&with("<?php\nclass J extends \\V\\Job {\n    public function han<|>dle(): void {}\n}\n")), vec![("V.php".into(), 2)]);
        // A grandparent's method, which the parent doesn't declare.
        assert_eq!(declarations(&with("<?php\nclass G extends \\V\\Middle {\n    protected function cas<|>ts(): array { return []; }\n}\n")), vec![("V.php".into(), 4)]);
        // A trait's abstract method.
        assert_eq!(declarations(&with("<?php\nclass T { use \\V\\HasName;\n    public function na<|>me(): string { return ''; }\n}\n")), vec![("V.php".into(), 10)]);
    }

    #[test]
    fn lists_members_with_their_supers_and_overrides() {
        let fx = Fixture::new(&[("app/Models.php", MODELS)]);
        let v = overrides(&fx.snap, serde_json::json!({ "textDocument": { "uri": uri("app/Models.php") } })).unwrap();
        let summary: Vec<String> = v
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                let lines: Vec<String> = m["supers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| format!("{}@{}", s["label"].as_str().unwrap(), s["location"]["range"]["start"]["line"]))
                    .collect();
                format!("{} {:?} implements={} abstract={} overridden={}", m["name"].as_str().unwrap(), lines, m["implements"], m["abstract"], m["overridden"])
            })
            .collect();
        assert_eq!(summary, vec![
            "Base [] implements=false abstract=false overridden=true",
            "save [] implements=false abstract=false overridden=false",
            "User [\"Base@2\"] implements=false abstract=false overridden=true",
            "Named [] implements=false abstract=true overridden=true",
            "name [] implements=false abstract=true overridden=true",
            "Admin [\"User@5\", \"Named@9\"] implements=false abstract=false overridden=false",
            "name [\"Named::name@9\"] implements=true abstract=false overridden=false",
        ]);
    }
}
