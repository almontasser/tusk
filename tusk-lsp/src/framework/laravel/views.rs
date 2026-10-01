//! The variables a Blade view gets where it's rendered, with their types, so its PHP is checked against them.

use std::collections::BTreeMap;
use std::path::Path;

use mago_allocator::LocalArena;
use mago_codex::ttype::atomic::TAtomic;
use mago_codex::ttype::atomic::array::TArray;
use mago_codex::ttype::atomic::array::key::ArrayKey;
use mago_codex::ttype::atomic::object::TObject;
use mago_codex::ttype::atomic::scalar::TScalar;
use mago_codex::ttype::union::TUnion;
use mago_span::HasSpan;
use mago_syntax::cst::{Argument, ArgumentList, Expression, Node};

use crate::analysis::{Parsed, analyze};
use crate::index::Index;
use crate::locate::walk;
use crate::symbol::Resolver;

/// Calls whose argument names a view, with the view's data in the next argument: `view('x', $data)`,
/// `View::make('x', $data)`, `response()->view('x', $data)`, and `Route::view('/url', 'x', $data)`.
const RENDERS: &[&str] = &["view", "make", "markdown"];

/// The view's name for a file under `resources/views`, such as `posts.show`.
pub fn view_name(index: &Index, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(index.config.root.join("resources/views")).ok()?.to_str()?;
    Some(rel.strip_suffix(".blade.php")?.replace('/', "."))
}

/// The variables `view` gets, as `(name, docblock type)`: what each place in the project that renders it passes,
/// in a data array, `compact()`, or `->with()`, and a Livewire component's (or Filament page's) public properties.
/// A variable is left out unless every such place passes it with a type that can be written; places with
/// different types give a union. `read` gives a project file's text.
pub fn view_types(index: &Index, read: &dyn Fn(&Path) -> Option<String>, view: &str) -> Vec<(String, String)> {
    let quoted = [format!("'{view}'"), format!("\"{view}\"")];
    // Each place that renders the view, with the variables it passes.
    let mut sites: Vec<BTreeMap<String, Option<String>>> = vec![];
    // ponytail: reads every project file per view check; keep a map of render sites if large projects lag.
    for path in index.project_files() {
        let Some(text) = read(path).filter(|t| quoted.iter().any(|q| t.contains(q.as_str()))) else { continue };
        let arena = LocalArena::new();
        let parsed = Parsed::new(&arena, path, &text);
        let analysis = analyze(&parsed, &arena, &index.codebase, index.config.php_version);
        let resolver = Resolver::new(&parsed, Some(&analysis), &index.codebase);
        let type_of = |e: &Expression<'_>| analysis.type_of(e.span().start.offset, e.span().end.offset);
        let source = |span: mago_span::Span| &text[span.start.offset as usize..span.end.offset as usize];
        walk(&parsed, |node, path| {
            let Node::LiteralString(lit) = node else { return };
            if !quoted.iter().any(|q| source(lit.span) == q) {
                return;
            }
            let mut vars = BTreeMap::new();
            let mut renders = false;
            // The call the string is an argument of, and its position there.
            if let Some(i) = path.iter().rposition(|n| matches!(n, Node::ArgumentList(_))) {
                let call = path[..i].iter().rev().find(|n| matches!(n, Node::FunctionCall(_) | Node::MethodCall(_) | Node::StaticMethodCall(_)));
                let named = |n: &[u8]| RENDERS.iter().any(|r| r.as_bytes().eq_ignore_ascii_case(n));
                let is_render = match call {
                    Some(Node::FunctionCall(c)) => matches!(c.function, Expression::Identifier(id) if named(id.value().rsplit(|b| *b == b'\\').next().unwrap_or_default())),
                    Some(Node::MethodCall(c)) => named(source(c.method.span()).as_bytes()),
                    Some(Node::StaticMethodCall(c)) => named(source(c.method.span()).as_bytes()),
                    _ => false,
                };
                if let (true, Node::ArgumentList(list), Some(call)) = (is_render, path[i], call) {
                    renders = true;
                    let at = list.arguments.iter().position(|a| a.span().start.offset <= lit.span.start.offset && lit.span.end.offset <= a.span().end.offset);
                    if let Some(Argument::Positional(data)) = at.and_then(|at| list.arguments.get(at + 1)) {
                        entries(type_of(data.value).as_deref(), &mut vars);
                    }
                    // `->with('post', $post)` and `->with([...])` chained on the call.
                    let mut inner = call.span();
                    for n in path[..i].iter().rev() {
                        match n {
                            Node::MethodCall(m) if m.object.span() == inner => {
                                if source(m.method.span()).eq_ignore_ascii_case("with") {
                                    with(&m.argument_list, &text, &type_of, &mut vars);
                                }
                                inner = m.span();
                            }
                            Node::Expression(_) | Node::Call(_) => {}
                            n if n.span() == inner => {}
                            _ => break,
                        }
                    }
                }
            }
            // A Livewire component or Filament page passes its public properties.
            if let Some(class) = resolver.enclosing_class(path).filter(|c| index.codebase.is_instance_of(c.as_bytes(), b"Livewire\\Component")) {
                renders = true;
                let meta = index.codebase.get_class_like(class.as_bytes());
                for (name, declaring) in meta.iter().flat_map(|m| m.declaring_property_ids.iter()) {
                    let Some(p) = index.codebase.get_property(declaring.as_bytes(), name.as_bytes()) else { continue };
                    if p.read_visibility.is_public() && !p.flags.is_static() {
                        let t = p.type_metadata.as_ref().or(p.type_declaration_metadata.as_ref()).and_then(|t| docblock_type(&t.type_union));
                        vars.entry(name.as_str_lossy().trim_start_matches('$').to_string()).or_insert(t);
                    }
                }
            }
            if renders {
                sites.push(vars);
            }
        });
    }
    let Some(first) = sites.first() else { return vec![] };
    first
        .keys()
        .filter_map(|name| {
            let mut parts: Vec<&str> = vec![];
            for site in &sites {
                let t = site.get(name)?.as_deref()?;
                if !parts.contains(&t) {
                    parts.push(t);
                }
            }
            Some((name.clone(), parts.join("|")))
        })
        .collect()
}

/// The entries of a keyed array type, such as `compact()`'s or a data array literal's.
fn entries(t: Option<&TUnion>, vars: &mut BTreeMap<String, Option<String>>) {
    let Some([TAtomic::Array(TArray::Keyed(keyed))]) = t.map(|t| &t.types[..]) else { return };
    for (key, (optional, value)) in keyed.known_items.iter().flatten() {
        if let ArrayKey::String(name) = key {
            vars.insert(name.as_str_lossy().into_owned(), (!optional).then(|| docblock_type(value)).flatten());
        }
    }
}

/// `->with('post', $post)` or `->with([...])`.
fn with(list: &ArgumentList<'_>, text: &str, type_of: &dyn Fn(&Expression<'_>) -> Option<std::rc::Rc<TUnion>>, vars: &mut BTreeMap<String, Option<String>>) {
    let args: Vec<&Expression<'_>> = list.arguments.iter().filter_map(|a| if let Argument::Positional(p) = a { Some(p.value) } else { None }).collect();
    match args[..] {
        [Expression::Literal(mago_syntax::cst::Literal::String(key)), value] => {
            let key = text[key.span.start.offset as usize + 1..key.span.end.offset as usize - 1].to_string();
            vars.insert(key, type_of(value).and_then(|t| docblock_type(&t)));
        }
        [data] => entries(type_of(data).as_deref(), vars),
        _ => {}
    }
}

/// `t` as a docblock type, with literals widened (`string` for `'x'`), or `None` for what can't be written or
/// isn't worth checking, such as `mixed`.
pub fn docblock_type(t: &TUnion) -> Option<String> {
    let mut parts: Vec<String> = vec![];
    for atomic in t.types.iter() {
        let part = match atomic {
            TAtomic::Null => "null".into(),
            TAtomic::Scalar(TScalar::Bool(b)) if b.is_true() => "true".into(),
            TAtomic::Scalar(TScalar::Bool(b)) if b.is_false() => "false".into(),
            TAtomic::Scalar(TScalar::Bool(_)) => "bool".into(),
            TAtomic::Scalar(TScalar::Integer(_)) => "int".into(),
            TAtomic::Scalar(TScalar::Float(_)) => "float".into(),
            TAtomic::Scalar(TScalar::String(_)) => "string".into(),
            TAtomic::Object(TObject::Enum(e)) => format!("\\{}", e.name.as_str_lossy()),
            TAtomic::Object(TObject::Named(n)) => {
                let params: Option<Vec<String>> = n.type_parameters.iter().flatten().map(docblock_type).collect();
                match params.filter(|p| !p.is_empty()) {
                    Some(p) => format!("\\{}<{}>", n.name.as_str_lossy(), p.join(", ")),
                    None => format!("\\{}", n.name.as_str_lossy()),
                }
            }
            TAtomic::Array(TArray::List(l)) => {
                // A literal list, such as `[$post]`, has its elements' types and `never` for the rest.
                let known = l.known_elements.iter().flatten().map(|(_, (_, t))| t);
                let elements: Option<Vec<String>> = known.chain((!l.element_type.is_never()).then_some(&*l.element_type)).map(docblock_type).collect();
                match elements.filter(|e| !e.is_empty()) {
                    Some(mut e) => {
                        e.dedup();
                        format!("list<{}>", e.join("|"))
                    }
                    None => "array".into(),
                }
            }
            TAtomic::Array(TArray::Keyed(k)) => match &k.parameters {
                Some((key, value)) => match (docblock_type(key), docblock_type(value)) {
                    (Some(key), Some(value)) => format!("array<{key}, {value}>"),
                    _ => "array".into(),
                },
                None => "array".into(),
            },
            _ => return None,
        };
        if !parts.contains(&part) {
            parts.push(part);
        }
    }
    (!parts.is_empty()).then(|| parts.join("|"))
}
