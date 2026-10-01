//! The variables a Blade view gets where it's rendered, with their types, so its PHP is checked against them.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use mago_allocator::LocalArena;
use mago_codex::ttype::atomic::TAtomic;
use mago_codex::ttype::atomic::array::TArray;
use mago_codex::ttype::atomic::array::key::ArrayKey;
use mago_codex::ttype::atomic::object::TObject;
use mago_codex::ttype::atomic::scalar::TScalar;
use mago_codex::ttype::union::TUnion;
use mago_span::HasSpan;
use mago_syntax::cst::{Argument, ArgumentList, ArrayElement, Expression, Literal, Node};

use crate::analysis::{Parsed, analyze};
use crate::index::Index;
use crate::locate::walk;
use crate::symbol::Resolver;

use super::blade;

/// Calls whose argument names a view, with the view's data in the next argument: `view('x', $data)`,
/// `View::make('x', $data)`, `response()->view('x', $data)`, and `Route::view('/url', 'x', $data)`.
const RENDERS: &[&str] = &["view", "make", "markdown"];

/// The view's name for a file under `resources/views`, such as `posts.show`.
pub fn view_name(index: &Index, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(index.config.root.join("resources/views")).ok()?.to_str()?;
    Some(rel.strip_suffix(".blade.php")?.replace('/', "."))
}

/// Every Blade view in `resources/views`.
pub fn blade_views(root: &Path) -> Vec<PathBuf> {
    // ponytail: only the app's own views folder; views that packages or modules register elsewhere are left out.
    ignore::WalkBuilder::new(root.join("resources/views"))
        .standard_filters(false)
        .build()
        .flatten()
        .map(|e| e.into_path())
        .filter(|p| p.to_string_lossy().ends_with(".blade.php"))
        .collect()
}

/// The variables `view` gets, as `(name, docblock type)`: what each place in the project that renders it passes,
/// in a data array, `compact()`, or `->with()`, a Livewire component's (or Filament page's) public properties,
/// and what each view that includes it passes ([`included_by`]). A variable is left out unless every such place
/// passes it with a type that can be written; places with different types give a union. `read` gives a project
/// file's text.
pub fn view_types(index: &Index, read: &dyn Fn(&Path) -> Option<String>, view: &str) -> Vec<(String, String)> {
    types(index, read, &blade_views(&index.config.root), &mut vec![view.to_string()])
}

/// [`view_types`] for the last view in `stack`, which is included by the ones before it, among `views`.
fn types(index: &Index, read: &dyn Fn(&Path) -> Option<String>, views: &[PathBuf], stack: &mut Vec<String>) -> Vec<(String, String)> {
    let view = stack.last().cloned().unwrap_or_default();
    let quoted = [format!("'{view}'"), format!("\"{view}\"")];
    // Each place that renders the view, with the variables it passes.
    let mut sites: Vec<BTreeMap<String, Option<String>>> = vec![];
    // ponytail: reads every project file per view check; keep a map of render sites if large projects lag.
    for path in index.project_files() {
        let Some(text) = read(path).filter(|t| quoted.iter().any(|q| t.contains(q.as_str()))) else { continue };
        let arena = LocalArena::new();
        let parsed = Parsed::new(&arena, path, &text);
        let analysis = analyze(&parsed, &arena, &index);
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
    // The variables the view reads, which a view that includes it passes as they are there.
    let child = index.config.root.join(format!("resources/views/{}.blade.php", view.replace('.', "/")));
    let names = read(&child).map(|t| read_vars(&t)).unwrap_or_default();
    for path in views {
        let Some(text) = read(path).filter(|t| quoted.iter().any(|q| t.contains(q.as_str()))) else { continue };
        sites.extend(included_by(index, read, views, stack, path, &text, &quoted, &names));
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

/// The places in `text`, the Blade view at `path`, that include the view `quoted` names, with the variables each
/// passes: its data array's, and those in `names` as they are where it includes it, since an include gets them
/// all. `@include` and `@includeIf` take the view first, `@includeWhen` and `@includeUnless` after their
/// condition. Other directives that name it, such as `@each` and `@extends`, pass nothing known.
#[allow(clippy::too_many_arguments)]
fn included_by(index: &Index, read: &dyn Fn(&Path) -> Option<String>, views: &[PathBuf], stack: &mut Vec<String>, path: &Path, text: &str, quoted: &[String; 2], names: &BTreeSet<String>) -> Vec<BTreeMap<String, Option<String>>> {
    let src = text.as_bytes();
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut sites = vec![];
    // The view with each include's variables echoed just before it, `{{ $post }}`, so their types there are read.
    let mut probed = String::new();
    // Each include: the offset of its `(` in `probed`, the view's position among its arguments, and its echoes.
    let mut found = vec![];
    let mut last = 0;
    for (at, _) in text.match_indices('@').filter(|(at, _)| *at == 0 || !word(src[at - 1])) {
        let name_end = at + 1 + src[at + 1..].iter().take_while(|b| word(**b)).count();
        let open = name_end + src[name_end..].iter().take_while(|b| matches!(b, b' ' | b'\t')).count();
        let Some(close) = (src.get(open) == Some(&b'(')).then(|| blade::matching_paren(src, open)).flatten() else { continue };
        if !quoted.iter().any(|q| text[open..close].contains(q.as_str())) {
            continue;
        }
        let position = match &text[at + 1..name_end] {
            "include" | "includeIf" => 0,
            "includeWhen" | "includeUnless" => 1,
            "includeFirst" | "each" | "extends" | "extendsFirst" | "component" => {
                sites.push(BTreeMap::new());
                continue;
            }
            _ => continue,
        };
        probed.push_str(&text[last..at]);
        let mut echoes = vec![];
        for name in names {
            let start = probed.len() + 3;
            probed.push_str(&format!("{{{{ ${name} }}}}"));
            echoes.push((name.clone(), start, start + 1 + name.len()));
        }
        found.push((probed.len() + open - at, position, echoes));
        last = at;
    }
    probed.push_str(&text[last..]);
    let Some(parent) = view_name(index, path).filter(|_| !found.is_empty()) else { return sites };
    // A view that includes itself, directly or through others, passes nothing known to itself.
    if stack.contains(&parent) {
        sites.extend(found.iter().map(|_| BTreeMap::new()));
        return sites;
    }
    stack.push(parent);
    let vars = types(index, read, views, stack);
    stack.pop();
    let (php, head, _) = blade::checked_php(&probed, &vars);
    let arena = LocalArena::new();
    let parsed = Parsed::new(&arena, path, &php);
    let analysis = analyze(&parsed, &arena, index);
    let type_of = |e: &Expression<'_>| analysis.type_of(e.span().start.offset, e.span().end.offset);
    // The directives' arguments, which read as arrays.
    let mut arrays = vec![];
    walk(&parsed, |node, _| {
        if let Node::Array(a) = node {
            arrays.push(a);
        }
    });
    for (open, position, echoes) in found {
        // One in a comment isn't read.
        let Some(array) = arrays.iter().find(|a| a.left_bracket.start.offset as usize == head + open) else { continue };
        let args: Vec<Option<&Expression<'_>>> = array.elements.iter().map(|e| if let ArrayElement::Value(v) = e { Some(v.value) } else { None }).collect();
        let names_it = |e: &Expression<'_>| matches!(e, Expression::Literal(Literal::String(s)) if quoted.iter().any(|q| &php[s.span.start.offset as usize..s.span.end.offset as usize] == q));
        if !args.get(position).copied().flatten().is_some_and(names_it) {
            continue;
        }
        let mut vars: BTreeMap<String, Option<String>> = echoes.into_iter().map(|(name, s, e)| (name, analysis.type_of((head + s) as u32, (head + e) as u32).and_then(|t| docblock_type(&t)))).collect();
        if let Some(data) = args.get(position + 1) {
            let t = data.and_then(|d| type_of(d));
            // Data whose keys aren't all known may replace any variable.
            if !matches!(t.as_deref().map(|t| &t.types[..]), Some([TAtomic::Array(TArray::Keyed(k))]) if k.parameters.is_none()) {
                vars.clear();
            }
            entries(t.as_deref(), &mut vars);
        }
        sites.push(vars);
    }
    sites
}

/// The variables a view reads, by name without `$`.
fn read_vars(text: &str) -> BTreeSet<String> {
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    text.split('$').skip(1).map(|s| &s[..s.find(|c| !word(c)).unwrap_or(s.len())]).filter(|n| n.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') && *n != "this").map(str::to_string).collect()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Fixture, path};

    #[test]
    fn types_an_included_views_variables_from_the_view_that_includes_it() {
        let models = "<?php\nnamespace App;\nclass User {}\nclass Comment {}\nclass Post { /** @var list<Comment> */ public array $comments = []; public ?User $author = null; }\n";
        let controller = "<?php\nnamespace App;\nclass PostController {\n    public function show(Post $post, array $extra) { return view('posts.show', compact('post', 'extra')); }\n    public function tree(Comment $c) { return view('tree', ['node' => $c]); }\n}\n";
        let show = "@foreach ($post->comments as $comment) @include('posts.comment', ['n' => 1]) @endforeach\n@include('posts.meta')\n@includeWhen($post->author, 'posts.byline', ['by' => $post->author])\n{{-- @include('posts.meta', ['post' => 1]) --}}\n@include('posts.extra', $extra) @each('posts.each', $post->comments, 'comment')\n";
        let views = [
            ("resources/views/posts/show.blade.php", show),
            ("resources/views/posts/comment.blade.php", "{{ $comment }} {{ $post }} {{ $n }} {{ $nope }}"),
            ("resources/views/posts/meta.blade.php", "{{ $post }}"),
            ("resources/views/posts/byline.blade.php", "{{ $by }} {{ $post }}"),
            ("resources/views/posts/extra.blade.php", "{{ $post }}"),
            ("resources/views/posts/each.blade.php", "{{ $comment }}"),
            ("resources/views/tree.blade.php", "{{ $node }} @include('tree', ['node' => $node])"),
        ];
        let mut files = vec![("app/Models.php", models), ("app/PostController.php", controller)];
        files.extend(views);
        let fx = Fixture::new(&files);
        let paths: Vec<PathBuf> = views.iter().map(|(p, _)| path(p)).collect();
        let types_of = |view: &str| types(&fx.snap.index.read(), &|p| fx.snap.read(p), &paths, &mut vec![view.to_string()]);
        let owned = |pairs: &[(&str, &str)]| pairs.iter().map(|(n, t)| (n.to_string(), t.to_string())).collect::<Vec<_>>();
        // A loop variable as it is in the loop, the includer's own variables, and the include's data.
        assert_eq!(types_of("posts.comment"), owned(&[("comment", "\\App\\Comment"), ("n", "int"), ("post", "\\App\\Post")]));
        assert_eq!(types_of("posts.meta"), owned(&[("post", "\\App\\Post")]));
        assert_eq!(types_of("posts.byline"), owned(&[("by", "null|\\App\\User"), ("post", "\\App\\Post")]));
        // Data of unknown keys, `@each`, and a view that includes itself pass nothing known.
        assert!(types_of("posts.extra").is_empty());
        assert!(types_of("posts.each").is_empty());
        assert!(types_of("tree").is_empty());
    }
}
