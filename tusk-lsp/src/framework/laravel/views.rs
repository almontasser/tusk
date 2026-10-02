//! The variables a Blade view gets where it's rendered, with their types, so its PHP is checked against them.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;

use mago_allocator::LocalArena;
use mago_codex::ttype::atomic::TAtomic;
use mago_codex::ttype::atomic::array::TArray;
use mago_codex::ttype::atomic::array::key::ArrayKey;
use mago_codex::ttype::atomic::object::TObject;
use mago_codex::ttype::atomic::scalar::TScalar;
use mago_codex::ttype::union::TUnion;
use mago_span::HasSpan;
use mago_syntax::cst::{Argument, ArgumentList, ArrayElement, Expression, Literal, Node};
use serde_json::Value;

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
/// in a data array, `compact()`, or `->with()`, a Livewire component's (or Filament page's) or class component's
/// public properties, what each view that includes it or renders it with `@each` passes ([`sites_in`]), and,
/// for an anonymous component, what each tag that uses it passes ([`tag_site`]). A variable is left out unless
/// every such place passes it with a type that can be written; places with different types give a union. A view
/// that renders itself gets the types that are stable when its own places pass what they're given
/// ([`Walk::types`]). `read` gives a project file's text, and `components` the app's Blade components, as
/// [`blade_components`](super::blade_components) reports them, for the tags of those registered outside the defaults.
pub fn view_types(index: &Index, read: &dyn Fn(&Path) -> Option<String>, components: Option<&Value>, view: &str) -> Vec<(String, String)> {
    types_among(index, read, components, &blade_views(&index.config.root), view)
}

/// [`view_types`], with `paths` as the project's views.
fn types_among(index: &Index, read: &dyn Fn(&Path) -> Option<String>, components: Option<&Value>, paths: &[PathBuf], view: &str) -> Vec<(String, String)> {
    let views: Vec<(PathBuf, String)> = paths.iter().filter_map(|p| Some((p.clone(), read(p)?))).collect();
    let mut named: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, (_, text)) in views.iter().enumerate() {
        for name in mentions(text) {
            named.entry(name).or_default().push(i);
        }
    }
    Walk { index, read, components, views: &views, named: &named, code: code_mentions(index, read), stack: vec![], known: HashMap::new(), cut: false, contexts: HashMap::new(), including: vec![] }.types(view)
}

/// The names `text` mentions: its quoted strings without spaces, `'posts.show'` as `posts.show`, and its
/// component tags, `<x-card` or `<x:card` as `<x-card`, and `<x-dynamic-component component="card"` as `<x-card` too.
fn mentions(text: &str) -> BTreeSet<String> {
    let src = text.as_bytes();
    let mut found = BTreeSet::new();
    for (at, b) in src.iter().enumerate() {
        if matches!(b, b'\'' | b'"') {
            let len = src[at + 1..].iter().take(200).position(|c| c == b || c.is_ascii_whitespace());
            if let Some(len) = len.filter(|len| *len > 0 && src[at + 1 + len] == *b) {
                found.insert(text[at + 1..at + 1 + len].to_string());
            }
        } else if *b == b'<' && (src[at + 1..].starts_with(b"x-") || src[at + 1..].starts_with(b"x:")) {
            let len = src[at + 3..].iter().take_while(|c| c.is_ascii_alphanumeric() || b"_-:.".contains(c)).count();
            let name = &text[at + 3..at + 3 + len];
            let dynamic = (name == "dynamic-component").then(|| dynamic_name(text, at + 3 + len)).flatten();
            found.insert(format!("<x-{}", dynamic.as_deref().unwrap_or(name)));
        }
    }
    found
}

/// The project files that mention each name ([`mentions`]), for the index's generation, since the index has the
/// project's code as the editor does.
fn code_mentions(index: &Index, read: &dyn Fn(&Path) -> Option<String>) -> Arc<Mentioned> {
    static FOUND: LazyLock<Mutex<(u64, Arc<Mentioned>)>> = LazyLock::new(Default::default);
    // Held while it reads, so the project scan's threads read the files once.
    let mut found = FOUND.lock();
    if found.0 != index.generation {
        let mut named = Mentioned::new();
        for path in index.project_files() {
            for name in mentions(&read(path).unwrap_or_default()) {
                named.entry(name).or_default().push(path.to_path_buf());
            }
        }
        *found = (index.generation, Arc::new(named));
    }
    found.1.clone()
}

/// The files that mention each name.
type Mentioned = HashMap<String, Vec<PathBuf>>;

/// What one place that renders a view passes: each variable, with its docblock type when it's known.
type Site = BTreeMap<String, Option<String>>;

/// The props a component declares in `@props`: each name, with its default's type when it has a default.
type Props = Vec<(String, Option<Option<String>>)>;

/// One [`view_types`] call, which types the views that include a view to type what they pass to it.
struct Walk<'a> {
    index: &'a Index,
    read: &'a dyn Fn(&Path) -> Option<String>,
    components: Option<&'a Value>,
    /// The project's views, with their text.
    views: &'a [(PathBuf, String)],
    /// The views that mention each name ([`mentions`]), by their position in `views`.
    named: &'a HashMap<String, Vec<usize>>,
    /// The project files that mention each name.
    code: Arc<Mentioned>,
    /// The views being typed, each included by the ones before it.
    stack: Vec<String>,
    /// The views typed so far, other than those whose types left out a view that includes itself through others.
    known: HashMap<String, Vec<(String, String)>>,
    /// Whether such a view was left out since the last view on `stack` started.
    cut: bool,
    /// The views [`Walk::contexts`] answered so far.
    contexts: HashMap<String, Vec<Around>>,
    /// The views [`Walk::contexts`] is answering, each included by the one before it.
    including: Vec<String>,
}

/// What a component tag that leaves out an `@aware` variable is inside, where Laravel looks for it: `None` for no
/// component, so it gets its default, `Some(None)` for a component whose data isn't known, and `Some(Some(site))`
/// for an anonymous component's tag that passes `site`.
type Around = Option<Option<Site>>;

/// What [`code_sites`] and [`sites_in`] found, by a hash of what they read, for the index's
/// [`generation`](Index::generation), since every view check reads them for each view that includes it. Each
/// edit of a view adds an entry until the project's code changes, so a cache past [`CACHED`] entries starts over.
static CODE_SITES: Cache<Arc<HashMap<String, Vec<Site>>>> = LazyLock::new(Default::default);
static VIEW_SITES: Cache<Vec<Site>> = LazyLock::new(Default::default);
static AROUND_SITES: Cache<Vec<Option<Site>>> = LazyLock::new(Default::default);
type Cache<T> = LazyLock<Mutex<(u64, HashMap<u64, T>)>>;
const CACHED: usize = 4096;

/// `find()`, or what it gave for the same `key` with the same index.
fn cached<T: Clone>(cache: &Mutex<(u64, HashMap<u64, T>)>, index: &Index, key: impl Hash, find: impl FnOnce() -> T) -> T {
    let mut hasher = std::hash::DefaultHasher::new();
    key.hash(&mut hasher);
    let key = hasher.finish();
    {
        let mut cache = cache.lock();
        if cache.0 != index.generation {
            *cache = (index.generation, HashMap::new());
        }
        if let Some(found) = cache.1.get(&key) {
            return found.clone();
        }
    }
    let found = find();
    let mut cache = cache.lock();
    if cache.0 == index.generation {
        if cache.1.len() >= CACHED {
            cache.1.clear();
        }
        cache.1.insert(key, found.clone());
    }
    found
}

impl Walk<'_> {
    /// The variables `view` gets. A view that includes itself through others passes nothing known to itself.
    fn types(&mut self, view: &str) -> Vec<(String, String)> {
        if let Some(known) = self.known.get(view) {
            return known.clone();
        }
        self.stack.push(view.to_string());
        let outer = std::mem::take(&mut self.cut);
        let types = self.compute(view);
        self.stack.pop();
        if !self.cut {
            self.known.insert(view.to_string(), types.clone());
        }
        self.cut |= outer;
        types
    }

    fn compute(&mut self, view: &str) -> Vec<(String, String)> {
        let (index, read) = (self.index, self.read);
        let quoted = [format!("'{view}'"), format!("\"{view}\"")];
        let mut sites: Vec<Site> = vec![];
        for path in self.code.clone().get(view).into_iter().flatten() {
            let Some(text) = read(path) else { continue };
            let found = cached(&CODE_SITES, index, (path, &text), || Arc::new(code_sites(index, path, &text)));
            sites.extend(found.get(view).cloned().unwrap_or_default());
        }
        // The variables the view reads, which a view that includes it passes as they are there.
        let child = index.config.root.join(format!("resources/views/{}.blade.php", view.replace('.', "/")));
        let child_text = read(&child).unwrap_or_default();
        let names = read_vars(&child_text);
        let components = self.components;
        let tags = component_tags(index, read, components, view);
        let props = if tags.is_empty() { None } else { self::props(index, &child_text, "@props") };
        let names_aware: Props = if tags.is_empty() { vec![] } else { self::props(index, &child_text, "@aware").unwrap_or_default() };
        let anonymous = |tag: &str| anonymous(index, read, components, tag);
        let aware = |parent: &str, text: &str| {
            // A component's own view: an anonymous one's tags pass what it reads, and a class component's aren't known.
            // ponytail: a class component's view outside `components`, or a view included from a component's view,
            // reads as a page, though Laravel looks in that component's data first; check the renderers if it bites.
            let own = if names_aware.is_empty() {
                None
            } else if component_tags(index, read, components, parent).is_empty() {
                parent.starts_with("components.").then(|| Some(vec![]))
            } else {
                Some(self::props(index, text, "@props"))
            };
            Aware { names: &names_aware, own, anonymous: &anonymous }
        };
        let named = |name: &str| self.named.get(name).into_iter().flatten().copied();
        let renderers: BTreeSet<usize> = named(view).chain(tags.iter().flat_map(|tag| named(&format!("<x-{tag}")))).collect();
        let mut own = None;
        for (path, text) in renderers.into_iter().map(|i| &self.views[i]) {
            let Some(parent) = view_name(index, path) else { continue };
            if parent == view {
                own = Some((path, text));
                continue;
            }
            if self.stack.contains(&parent) {
                self.cut = true;
                sites.push(Site::new());
                continue;
            }
            let aware = aware(&parent, text);
            // Where a tag with no component around it in the view is, through the views that include that view.
            let outer = if aware.names.is_empty() || aware.own.is_some() { vec![] } else { self.contexts(&parent) };
            sites.extend(sites_in(index, path, text, &quoted, &tags, props.as_ref(), &aware, &outer, &names, &mut || self.types(&parent)));
        }
        let mut vars = merge(&sites);
        let Some((path, text)) = own.filter(|_| !sites.is_empty()) else { return vars };
        // A view that renders itself, such as a comment that includes itself for its replies: start from what the
        // other places pass, and add what it passes itself with those types, until they don't change.
        for _ in 0..4 {
            let mut all = sites.clone();
            all.extend(sites_in(index, path, text, &quoted, &tags, props.as_ref(), &aware(view, text), &[], &names, &mut || vars.clone()));
            let next = merge(&all);
            if next == vars {
                return vars;
            }
            vars = next;
        }
        vec![]
    }

    /// The components `view`'s content is inside where Laravel renders it ([`Around`]), as `@aware` looks for its
    /// variables: for each include of it, the component tag open around the include, or if none, what the view
    /// that includes it is inside, in turn, and no component where the project's code renders it. A view included
    /// in a component's own view, or in itself, is inside a component whose data isn't known.
    fn contexts(&mut self, view: &str) -> Vec<Around> {
        if let Some(known) = self.contexts.get(view) {
            return known.clone();
        }
        if self.including.iter().any(|v| v == view) {
            return vec![Some(None)];
        }
        self.including.push(view.to_string());
        let (index, read, components, views) = (self.index, self.read, self.components, self.views);
        let quoted = [format!("'{view}'"), format!("\"{view}\"")];
        let mut out: Vec<Around> = vec![];
        if self.code.get(view).is_some_and(|files| files.iter().any(|f| !f.to_string_lossy().ends_with(".blade.php"))) {
            out.push(None);
        }
        for i in self.named.get(view).cloned().unwrap_or_default() {
            let (path, text) = &views[i];
            let Some(parent) = view_name(index, path).filter(|p| p != view) else { continue };
            let component = parent.starts_with("components.") || !component_tags(index, read, components, &parent).is_empty();
            let comments = comments(text);
            let mut tags = vec![];
            for at in includes(text, &quoted).into_iter().filter(|at| !comments.iter().any(|c| c.contains(at))) {
                match enclosing(text, at, &comments) {
                    Some(Some((tag, attrs))) if anonymous(index, read, components, &tag) => tags.push((tag, attrs)),
                    Some(_) => out.push(Some(None)),
                    None if component => out.push(Some(None)),
                    None => out.extend(self.contexts(&parent)),
                }
            }
            if !tags.is_empty() {
                let vars = self.types(&parent);
                out.extend(around_sites(index, path, text, &vars, &tags).into_iter().map(Some));
            }
        }
        if out.is_empty() {
            out.push(None);
        }
        let mut unique: Vec<Around> = vec![];
        for around in out {
            if !unique.contains(&around) {
                unique.push(around);
            }
        }
        self.including.pop();
        self.contexts.insert(view.to_string(), unique.clone());
        unique
    }
}

/// Whether `<x-{tag}>` is an anonymous component's, whose attributes are what it passes.
fn anonymous(index: &Index, read: &dyn Fn(&Path) -> Option<String>, components: Option<&Value>, tag: &str) -> bool {
    match component_files(components, tag) {
        Some(files) => files.iter().all(|f| f.ends_with(".blade.php")),
        None => components.is_none() && default_view(index, read, tag).is_some(),
    }
}

/// Where each `{{-- --}}` comment in `text` is.
fn comments(text: &str) -> Vec<std::ops::Range<usize>> {
    text.match_indices("{{--").map(|(at, _)| at..text[at..].find("--}}").map_or(text.len(), |e| at + e)).collect()
}

/// Where each directive in `text` that includes the view `quoted` names starts: `@include` and its variants, and
/// `@each`.
fn includes(text: &str, quoted: &[String; 2]) -> Vec<usize> {
    let src = text.as_bytes();
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut found = vec![];
    for (at, _) in text.match_indices('@').filter(|(at, _)| *at == 0 || !word(src[at - 1])) {
        let name_end = at + 1 + src[at + 1..].iter().take_while(|b| word(**b)).count();
        if !matches!(&text[at + 1..name_end], "include" | "includeIf" | "includeWhen" | "includeUnless" | "includeFirst" | "each") {
            continue;
        }
        let open = name_end + src[name_end..].iter().take_while(|b| matches!(b, b' ' | b'\t')).count();
        let Some(close) = (src.get(open) == Some(&b'(')).then(|| blade::matching_paren(src, open)).flatten() else { continue };
        if quoted.iter().any(|q| text[open..close].contains(q.as_str())) {
            found.push(at);
        }
    }
    found
}

/// What each of `tags`, component tags in `text`, the Blade view at `path` whose variables `vars` gives, passes:
/// each by its name and where its attributes start, as [`enclosing`] gives them, or `None` when its attributes
/// can't be read.
fn around_sites(index: &Index, path: &Path, text: &str, vars: &[(String, String)], tags: &[(String, usize)]) -> Vec<Option<Site>> {
    cached(&AROUND_SITES, index, (path, text, vars, tags), || {
        let checked = blade::checked_php(text, vars);
        let arena = LocalArena::new();
        let parsed = Parsed::new(&arena, path, &checked.php);
        let analysis = analyze(&parsed, &arena, index);
        let mut arrays = HashMap::new();
        walk(&parsed, |node, _| {
            if let Node::Array(a) = node
                && let offset = a.left_bracket.start.offset as usize
                && offset >= checked.head
                && let Ok(at) = checked.view_offset(offset)
            {
                arrays.insert(at, a);
            }
        });
        let bound = |at: usize| bound_type(arrays.get(&at).copied(), &analysis);
        tags.iter().map(|(tag, at)| tag_attrs(text, *at, tag).map(|(attrs, _, _)| attr_types(attrs, &bound))).collect()
    })
}

/// The type of a bound attribute, which [`blade::checked_php`] reads as an array of its value.
fn bound_type(array: Option<&mago_syntax::cst::Array<'_>>, analysis: &crate::analysis::Analysis) -> Option<String> {
    match array?.elements.first() {
        Some(ArrayElement::Value(v)) => analysis.type_of(v.value.span().start.offset, v.value.span().end.offset).and_then(|t| docblock_type(&t)),
        _ => None,
    }
}

/// A tag's attributes with their types, a bound one's from `bound`, by where its value starts.
fn attr_types(attrs: Vec<(String, Attr)>, bound: &dyn Fn(usize) -> Option<String>) -> Site {
    attrs
        .into_iter()
        .map(|(name, attr)| {
            let t = match attr {
                Attr::Bound(at) => bound(at),
                Attr::Text => Some("string".into()),
                Attr::Flag => Some("true".into()),
                Attr::Unknown => None,
            };
            (name, t)
        })
        .collect()
}

/// The variables every one of `sites` passes with a known type, with the union of their types.
fn merge(sites: &[Site]) -> Vec<(String, String)> {
    let Some(first) = sites.first() else { return vec![] };
    first
        .keys()
        .filter_map(|name| {
            let mut parts: Vec<&str> = vec![];
            for site in sites {
                let t = site.get(name)?.as_deref()?;
                if !parts.contains(&t) {
                    parts.push(t);
                }
            }
            Some((name.clone(), parts.join("|")))
        })
        .collect()
}

/// The places in `path`, a project file, that render views, by view name: a view name that's an argument of
/// `view()` and the like, with what that call passes, and any in a Livewire component or a class component, which
/// pass their public properties.
fn code_sites(index: &Index, path: &Path, text: &str) -> HashMap<String, Vec<Site>> {
    let mut sites: HashMap<String, Vec<Site>> = HashMap::new();
    let arena = LocalArena::new();
    let parsed = Parsed::new(&arena, path, text);
    let analysis = analyze(&parsed, &arena, index);
    let resolver = Resolver::new(&parsed, Some(&analysis), &index.codebase);
    let type_of = |e: &Expression<'_>| analysis.type_of(e.span().start.offset, e.span().end.offset);
    let source = |span: mago_span::Span| &text[span.start.offset as usize..span.end.offset as usize];
    let except = if text.contains("except") { except_changes(&parsed, &resolver) } else { ExceptChanges::new() };
    walk(&parsed, |node, path| {
        let Node::LiteralString(lit) = node else { return };
        let Some(view) = lit.value.and_then(|v| std::str::from_utf8(v).ok()).filter(|v| !v.is_empty() && !v.contains(char::is_whitespace)) else { return };
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
                                with(&m.argument_list, text, &type_of, &mut vars);
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
        // A Livewire component or Filament page passes its public properties, and so does a class component, with
        // its slot.
        let class = resolver.enclosing_class(path);
        let component = class.as_ref().is_some_and(|c| index.codebase.is_instance_of(c.as_bytes(), b"Illuminate\\View\\Component"));
        if let Some(class) = class.filter(|c| component || index.codebase.is_instance_of(c.as_bytes(), b"Livewire\\Component")) {
            renders = true;
            let meta = index.codebase.get_class_like(class.as_bytes());
            // `None` when the constructor changes `$except` in a way that isn't read, so any of them may be left out.
            let ignored = if component { component_ignored(index, &except, &class) } else { Some(vec![]) };
            let unsure = ignored.is_none();
            let ignored = ignored.unwrap_or_default();
            for (name, declaring) in meta.iter().flat_map(|m| m.declaring_property_ids.iter()) {
                let Some(p) = index.codebase.get_property(declaring.as_bytes(), name.as_bytes()) else { continue };
                let name = name.as_str_lossy().trim_start_matches('$').to_string();
                if p.read_visibility.is_public() && !p.flags.is_static() && !skipped(&ignored, &name) {
                    let t = p.type_metadata.as_ref().or(p.type_declaration_metadata.as_ref()).and_then(|t| docblock_type(&t.type_union));
                    vars.entry(name).or_insert(t.filter(|_| !unsure));
                }
            }
            if component {
                vars.entry("slot".into()).or_insert_with(|| known_class(index, SLOT));
                vars.extend(component_methods(index, &class, &ignored).into_iter().map(|(name, t)| (name, t.filter(|_| !unsure))));
            }
        }
        if renders {
            sites.entry(view.to_string()).or_default().push(vars);
        }
    });
    sites
}

const BAG: &str = "Illuminate\\View\\ComponentAttributeBag";
const SLOT: &str = "Illuminate\\View\\ComponentSlot";

/// The names a class component keeps from its view, as `Component::ignoredMethods()` lists them: Laravel's own
/// methods and the component's `$except`, as its default sets it and then `changes`, its constructor's
/// ([`except_changes`]), change it. `None` when one of them isn't read.
fn component_ignored(index: &Index, changes: &ExceptChanges, class: &str) -> Option<Vec<String>> {
    let own = ["data", "render", "resolve", "resolveView", "shouldRender", "view", "withName", "withAttributes", "flushCache", "forgetFactory", "forgetComponentsResolver", "resolveComponentsUsing"];
    let mut names: Vec<String> = own.map(String::from).to_vec();
    let mut except = vec![];
    let default = index.codebase.get_declaring_property(class.as_bytes(), b"$except").and_then(|p| p.default_type_metadata.as_ref());
    for atomic in default.into_iter().flat_map(|t| t.type_union.types.iter()) {
        let TAtomic::Array(TArray::List(list)) = atomic else { continue };
        except.extend(list.known_elements.iter().flatten().filter_map(|(_, (_, t))| t.get_single_literal_string_value()).map(|v| String::from_utf8_lossy(v).into_owned()));
    }
    for change in changes.get(&class.to_ascii_lowercase()).into_iter().flatten() {
        except = match change.as_ref()? {
            Change::Add(name) => [except, vec![name.clone()]].concat(),
            Change::Set(lists) => lists.iter().map(|list| list.clone().unwrap_or_else(|| except.clone())).collect::<Vec<_>>().concat(),
        };
    }
    names.extend(except);
    Some(names)
}

/// A change to a component's `$except` in its constructor ([`except_changes`]).
enum Change {
    /// `$this->except[] = 'name'`.
    Add(String),
    /// `$this->except = [...]`, or `array_merge()` of such lists and, as `None`, `$this->except`.
    Set(Vec<Option<Vec<String>>>),
}

/// Each class's changes to `$except`, by its lowercase name, in order, with `None` for one that isn't read.
type ExceptChanges = HashMap<String, Vec<Option<Change>>>;

/// The changes to `$this->except` in `parsed`, which [`component_ignored`] reads: assignments of a list of strings,
/// of `array_merge()` of such lists and `$this->except`, and `$this->except[] = 'name'`, unconditionally in a
/// constructor. Any other change, or one elsewhere, isn't read. Walked before [`code_sites`]' walk, not inside it,
/// so the two walks' depths don't add up.
fn except_changes(parsed: &Parsed<'_>, resolver: &Resolver<'_, '_>) -> ExceptChanges {
    let string = |e: &Expression<'_>| match e {
        Expression::Literal(Literal::String(s)) => s.value.and_then(|v| std::str::from_utf8(v).ok()).map(str::to_string),
        _ => None,
    };
    let strings = |e: &Expression<'_>| match e {
        Expression::Array(a) => a.elements.iter().map(|el| if let ArrayElement::Value(v) = el { string(v.value) } else { None }).collect::<Option<Vec<_>>>(),
        _ => None,
    };
    let mut changes = ExceptChanges::new();
    walk(parsed, |node, path| {
        let Node::Assignment(a) = node else { return };
        let (append, target) = match a.lhs {
            Expression::ArrayAppend(append) => (true, append.array),
            lhs => (false, lhs),
        };
        if crate::analysis::this_property(target) != Some(b"except") {
            return;
        }
        let Some(class) = resolver.enclosing_class(path) else { return };
        // The constructor, with nothing between it and the assignment that may skip or repeat it.
        let method = path.iter().rposition(|n| matches!(n, Node::Method(m) if m.name.value.eq_ignore_ascii_case(b"__construct")));
        let plain = method.is_some_and(|m| {
            !path[m + 1..].iter().any(|n| {
                matches!(n, Node::If(_) | Node::Match(_) | Node::Switch(_) | Node::Conditional(_) | Node::Binary(_) | Node::Foreach(_) | Node::For(_) | Node::While(_) | Node::DoWhile(_) | Node::Try(_) | Node::Closure(_) | Node::ArrowFunction(_))
            })
        });
        let change = match (plain && a.operator.is_assign(), append, a.rhs) {
            (false, ..) => None,
            (true, true, value) => string(value).map(Change::Add),
            (true, false, Expression::Call(mago_syntax::cst::Call::Function(call))) if matches!(call.function, Expression::Identifier(id) if id.value().eq_ignore_ascii_case(b"array_merge")) => call
                .argument_list
                .arguments
                .iter()
                .map(|arg| match arg {
                    Argument::Positional(p) if crate::analysis::this_property(p.value) == Some(b"except") => Some(None),
                    Argument::Positional(p) => strings(p.value).map(Some),
                    _ => None,
                })
                .collect::<Option<Vec<_>>>()
                .map(Change::Set),
            (true, false, value) => strings(value).map(|list| Change::Set(vec![Some(list)])),
        };
        changes.entry(class.to_ascii_lowercase()).or_default().push(change);
    });
    changes
}

/// Whether Laravel keeps a class component's public property or method `name` from its view ([`component_ignored`]).
fn skipped(ignored: &[String], name: &str) -> bool {
    name.starts_with("__") || ignored.iter().any(|i| i == name)
}

/// A class component's public methods, as its view gets them: one without parameters as an
/// `InvokableComponentVariable`, which calls it when it's echoed, invoked, or iterated, and one with parameters as a
/// closure with its signature, as `Component::createVariableFromMethod()` makes them.
fn component_methods(index: &Index, class: &str, ignored: &[String]) -> Vec<(String, Option<String>)> {
    let codebase = &index.codebase;
    let Some(meta) = codebase.get_class_like(class.as_bytes()) else { return vec![] };
    let mut out = vec![];
    for id in meta.appearing_method_ids.values() {
        let Some(m) = codebase.get_method_by_id(&codebase.get_declaring_method_identifier(id)) else { continue };
        let name = m.original_name.as_str_lossy().into_owned();
        if !m.method_metadata.as_ref().is_some_and(|mm| mm.visibility.is_public()) || skipped(ignored, &name) {
            continue;
        }
        let t = if m.parameters.is_empty() {
            known_class(index, "Illuminate\\View\\InvokableComponentVariable")
        } else {
            let written = |t: Option<&mago_codex::metadata::ttype::TypeMetadata>| t.and_then(|t| docblock_type(&t.type_union)).unwrap_or_else(|| "mixed".into());
            let params: Vec<String> = m
                .parameters
                .iter()
                .map(|p| {
                    let t = written(p.type_metadata.as_ref().or(p.type_declaration_metadata.as_ref()));
                    let suffix = if p.flags.is_variadic() { "..." } else if p.flags.has_default() { "=" } else { "" };
                    format!("{t}{suffix}")
                })
                .collect();
            let returns = written(m.return_type_metadata.as_ref().or(m.return_type_declaration_metadata.as_ref()));
            Some(format!("\\Closure({}): {returns}", params.join(", ")))
        };
        out.push((name, t));
    }
    out
}

/// `class` as a docblock type, when the project has it.
fn known_class(index: &Index, class: &str) -> Option<String> {
    index.codebase.class_like_exists(class.as_bytes()).then(|| format!("\\{class}"))
}

/// The tags that render `view` as an anonymous component: in `resources/views/components`, `foo.bar`, for
/// `<x-foo.bar>`, renders `components.foo.bar`, or else `components.foo.bar.index` or `components.foo.bar.bar`,
/// as Laravel looks them up, unless a class takes the name; elsewhere, a tag that `components` lists with the view
/// as its only file, such as `ui::button` from `Blade::anonymousComponentPath(resource_path('views/ui'), 'ui')`.
fn component_tags(index: &Index, read: &dyn Fn(&Path) -> Option<String>, components: Option<&Value>, view: &str) -> Vec<String> {
    let mut tags = vec![];
    if let Some(name) = view.strip_prefix("components.") {
        let last = |t: &str| t.rsplit('.').next().unwrap_or_default().to_string();
        tags.push(name.to_string());
        tags.extend(name.strip_suffix(".index").map(str::to_string));
        tags.extend(name.rsplit_once('.').filter(|(dir, file)| last(dir) == *file).map(|(dir, _)| dir.to_string()));
        // One the app registers with a class, such as with `Blade::component()`, isn't anonymous.
        tags.retain(|tag| default_view(index, read, tag).as_deref() == Some(view) && component_files(components, tag).is_none_or(|f| f.iter().all(|p| p.ends_with(".blade.php"))));
    }
    let rel = format!("resources/views/{}.blade.php", view.replace('.', "/"));
    let path = index.config.root.join(&rel);
    for (tag, c) in components.and_then(|c| c["components"].as_object()).into_iter().flatten() {
        let Some([file]) = c["paths"].as_array().map(Vec::as_slice) else { continue };
        let Some(file) = file.as_str().filter(|f| *f == rel || Path::new(f) == path) else { continue };
        // `flux:button` is another tag for `flux::button`.
        let name = tag.split_once("::").map_or(tag.as_str(), |(_, n)| n);
        // The file must be where the tag's name leads, as the list's names are its files' names in kebab case.
        let (dir, last) = (name.replace('.', "/"), name.rsplit('.').next().unwrap_or_default());
        let at = [format!("/{dir}.blade.php"), format!("/{dir}/index.blade.php"), format!("/{dir}/{last}.blade.php")];
        if !name.contains(':') && !tags.contains(tag) && at.iter().any(|e| file.ends_with(e.as_str())) {
            tags.push(tag.clone());
        }
    }
    tags
}

/// The view in `resources/views/components` that `<x-{tag}>` renders, unless a class in `App\View\Components`
/// takes the name.
fn default_view(index: &Index, read: &dyn Fn(&Path) -> Option<String>, tag: &str) -> Option<String> {
    // ponytail: the default `App` namespace; a class component in another one is found only through `components`.
    let last = tag.rsplit('.').next().unwrap_or_default();
    let exists = |v: &String| read(&index.config.root.join(format!("resources/views/components/{}.blade.php", v.replace('.', "/")))).is_some();
    let found = [tag.to_string(), format!("{tag}.index"), format!("{tag}.{last}")].into_iter().find(exists)?;
    let studly = |s: &str| {
        let name = camel(s);
        name.chars().next().map(|c| c.to_uppercase().chain(name.chars().skip(1)).collect::<String>()).unwrap_or_default()
    };
    let class = format!("App\\View\\Components\\{}", tag.split('.').map(studly).collect::<Vec<_>>().join("\\"));
    let classes = [format!("{class}\\{}", studly(last)), class];
    (!classes.iter().any(|c| index.codebase.class_like_exists(c.as_bytes()))).then(|| format!("components.{found}"))
}

/// The files `components` lists for the component `tag`, or `None` when it doesn't list it.
fn component_files<'v>(components: Option<&'v Value>, tag: &str) -> Option<Vec<&'v str>> {
    Some(components?["components"].get(tag)?["paths"].as_array()?.iter().filter_map(Value::as_str).collect())
}

/// The props a component view declares with `@props([...])`, or `None` without it, or with `@aware([...])` when
/// `directive` is `@aware`.
fn props(index: &Index, text: &str, directive: &str) -> Option<Props> {
    let src = text.as_bytes();
    let at = text.match_indices(directive).map(|(at, _)| at).find(|at| *at == 0 || !(src[at - 1].is_ascii_alphanumeric() || src[at - 1] == b'_'))?;
    let at = at + directive.len();
    let open = at + src[at..].iter().take_while(|b| matches!(b, b' ' | b'\t')).count();
    let Some(close) = (src.get(open) == Some(&b'(')).then(|| blade::matching_paren(src, open)).flatten() else { return Some(vec![]) };
    let php = format!("<?php {};", &text[open + 1..close]);
    let arena = LocalArena::new();
    let parsed = Parsed::new(&arena, Path::new("props.php"), &php);
    let analysis = analyze(&parsed, &arena, index);
    let mut props = vec![];
    let name = |e: &Expression<'_>| match e {
        Expression::Literal(Literal::String(s)) => s.value.and_then(|v| std::str::from_utf8(v).ok()).filter(|v| identifier(v)).map(str::to_string),
        _ => None,
    };
    walk(&parsed, |node, _| {
        let Node::Array(a) = node else { return };
        if a.left_bracket.start.offset != 6 {
            return;
        }
        for element in a.elements.iter() {
            match element {
                ArrayElement::KeyValue(kv) => {
                    let default = analysis.type_of(kv.value.span().start.offset, kv.value.span().end.offset).and_then(|t| docblock_type(&t));
                    props.extend(name(kv.key).map(|n| (n, Some(default))));
                }
                ArrayElement::Value(v) => props.extend(name(v.value).map(|n| (n, None))),
                _ => {}
            }
        }
    });
    Some(props)
}

fn identifier(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// An attribute of a component tag, as it's passed.
enum Attr {
    /// `:post="$post"` or `:$post`, whose PHP [`blade::checked_php`] reads as an array at this offset.
    Bound(usize),
    /// `title="Hi"`.
    Text,
    /// `disabled`, which passes `true`.
    Flag,
    /// `:count=5`, whose PHP isn't read.
    Unknown,
}

/// A component tag's attributes from `at`, past its name, by their camelCase names, with the names of the slots
/// between it and its closing tag, `<x-slot:footer>`, and whether it also passes attributes whose names aren't
/// known, as `{{ $attributes }}` does; or `None` when it passes a slot with a bound name.
#[allow(clippy::type_complexity)]
fn tag_attrs(text: &str, mut at: usize, tag: &str) -> Option<(Vec<(String, Attr)>, Vec<String>, bool)> {
    let src = text.as_bytes();
    let start = at;
    let mut attrs = vec![];
    let mut spread = false;
    let closed = loop {
        at += src[at..].iter().take_while(|b| b.is_ascii_whitespace()).count();
        match src.get(at) {
            None => break true,
            Some(b'>') => break false,
            Some(b'/') if src.get(at + 1) == Some(&b'>') => break true,
            Some(b'{') => {
                spread = true;
                at = src[at..].windows(2).position(|w| w == b"}}").map_or(src.len(), |e| at + e + 2);
                continue;
            }
            _ => {}
        }
        let name_end = at + src[at..].iter().take_while(|b| !b.is_ascii_whitespace() && !matches!(b, b'=' | b'>' | b'/' | b'"' | b'\'')).count().max(1);
        let name = &text[at..name_end];
        at = name_end;
        let value = (src.get(at) == Some(&b'=')).then(|| {
            at += 1;
            at += src[at..].iter().take_while(|b| b.is_ascii_whitespace()).count();
            let q = at;
            at = match src.get(q) {
                Some(b'"' | b'\'') => src[q + 1..].iter().position(|b| *b == src[q]).map_or(src.len(), |e| q + e + 2),
                _ => q + src[q..].iter().take_while(|b| !b.is_ascii_whitespace() && **b != b'>').count(),
            };
            q
        });
        let attr = match (name.strip_prefix(':'), value) {
            (Some(var), None) if var.starts_with('$') => (&var[1..], Attr::Bound(name_end - name.len())),
            // `::x-data` is Alpine's.
            (Some(n), _) if n.starts_with(':') => continue,
            (Some(n), Some(q)) if matches!(src.get(q), Some(b'"' | b'\'')) => (n, Attr::Bound(q)),
            (Some(n), _) => (n, Attr::Unknown),
            (None, Some(_)) => (name, Attr::Text),
            (None, None) => (name, Attr::Flag),
        };
        attrs.push((camel(attr.0), attr.1));
    };
    if closed {
        return Some((attrs, vec![], spread));
    }
    // The tag's content, to its closing tag, past those of the same component inside it.
    let opens = |i: usize| ["<x-", "<x:"].iter().any(|p| text[i..].starts_with(p) && text[i + 3..].starts_with(tag) && !text[i + 3 + tag.len()..].starts_with(|c: char| c.is_alphanumeric() || "_-:.".contains(c)));
    let mut depth = 0;
    let mut end = text.len();
    for (i, _) in text[at..].match_indices('<').map(|(i, _)| (at + i, ())) {
        if opens(i) {
            depth += 1;
        } else if text[i..].starts_with("</") && opens(i + 1) {
            if depth == 0 {
                end = i;
                break;
            }
            depth -= 1;
        }
    }
    let mut slots = vec![];
    for (i, _) in text[at..end].match_indices("<x-slot") {
        // One inside another component's tag is that component's.
        if enclosing(text, at + i, &[]).flatten().is_none_or(|(_, open)| open != start) {
            continue;
        }
        let rest = &text[at + i + 7..end];
        let name = if let Some(inline) = rest.strip_prefix(':') {
            inline[..inline.find(|c: char| !(c.is_alphanumeric() || c == '_' || c == '-')).unwrap_or(inline.len())].to_string()
        } else {
            let tag_end = rest.find('>').unwrap_or(rest.len());
            let quoted = |q: &str| rest[..tag_end].find(&format!(" name={q}")).map(|n| &rest[n + 7..]).and_then(|v| v.find(q).map(|e| v[..e].to_string()));
            quoted("\"").or_else(|| quoted("'"))?
        };
        slots.push(camel(&name));
    }
    Some((attrs, slots, spread))
}

/// The offset past the `>` that ends a tag whose attributes start at `at`, and whether it closes itself.
fn tag_end(src: &[u8], mut at: usize) -> (usize, bool) {
    while at < src.len() {
        match src[at] {
            q @ (b'"' | b'\'') => at += src[at + 1..].iter().position(|b| *b == q).map_or(src.len(), |e| e + 1),
            b'{' if src.get(at + 1) == Some(&b'{') => at += src[at..].windows(2).position(|w| w == b"}}").unwrap_or(src.len()),
            b'>' => return (at + 1, src[at - 1] == b'/'),
            _ => {}
        }
        at += 1;
    }
    (src.len(), false)
}

/// The component a `<x-dynamic-component` tag renders, from `at` past its name, when its `component` attribute names
/// it literally: `component="alert"` or `:component="'alert'"`.
fn dynamic_name(text: &str, at: usize) -> Option<String> {
    let src = text.as_bytes();
    let end = tag_end(src, at).0;
    let (found, _) = text[at..end].match_indices("component=").find(|(i, _)| {
        let before = &src[..at + i];
        before.ends_with(b" ") || before.ends_with(b"\n") || before.ends_with(b"\t") || (before.ends_with(b":") && before[..before.len() - 1].last().is_some_and(u8::is_ascii_whitespace))
    })?;
    let value = &text[at + found + 10..end];
    let q = value.chars().next().filter(|q| matches!(q, '"' | '\''))?;
    let mut value = &value[1..value[1..].find(q)? + 1];
    if src[at + found - 1] == b':' {
        value = value.trim().strip_prefix(['\'', '"']).and_then(|v| v.strip_suffix(['\'', '"']))?;
    }
    (!value.is_empty() && value.chars().all(|c| c.is_alphanumeric() || "_-:.".contains(c))).then(|| value.to_string())
}

/// The innermost component tag open at `at` in `text`, outside `comments`: `None` for none, or else its name and
/// where its attributes start, or `None` for one with another prefix, such as `<flux:card>`. `<x-slot>` isn't one.
fn enclosing(text: &str, at: usize, comments: &[std::ops::Range<usize>]) -> Option<Option<(String, usize)>> {
    let src = text.as_bytes();
    let mut open: Vec<Option<(String, usize)>> = vec![];
    for (i, _) in text[..at].match_indices('<') {
        let close = src.get(i + 1) == Some(&b'/');
        let start = i + 1 + close as usize;
        let len = src[start..].iter().take_while(|c| c.is_ascii_alphanumeric() || b"_-:.".contains(c)).count();
        let tag = &text[start..start + len];
        let name = match tag.strip_prefix("x-").or_else(|| tag.strip_prefix("x:")) {
            Some(name) if name == "slot" || name.starts_with("slot:") => continue,
            Some(name) => Some(name),
            None if tag.contains(':') && !tag.starts_with("livewire:") => None,
            None => continue,
        };
        if comments.iter().any(|c| c.contains(&i)) {
            continue;
        }
        if close {
            if let Some(o) = open.iter().rposition(|o| o.as_ref().map(|(n, _)| n.as_str()) == name) {
                open.truncate(o);
            }
        } else if !tag_end(src, start + len).1 {
            open.push(name.map(|n| (n.to_string(), start + len)));
        }
    }
    open.pop()
}

/// `user-name` as `userName`, as Laravel names a component's data.
fn camel(name: &str) -> String {
    let mut out = String::new();
    for (i, word) in name.split(['-', '_']).enumerate() {
        let mut chars = word.chars();
        if let (true, Some(c)) = (i > 0, chars.next()) {
            out.extend(c.to_uppercase());
            out.push_str(chars.as_str());
        } else {
            out.push_str(word);
        }
    }
    out
}

/// What a component tag passes to its view: each of its `props` that the tag passes, with its type, or that it
/// leaves out and has a default, with the default's type, and `$attributes` and `$slot`. A prop with a default
/// that's passed `null` gets the default. Without `@props`, it's each attribute. `tag` is `None` when what the
/// tag passes isn't known, and `spread` when it also passes attributes whose names aren't known, which may pass
/// the props it leaves out.
fn tag_site(index: &Index, tag: Option<Site>, props: Option<&Props>, spread: bool) -> Site {
    let mut site = Site::from([("attributes".to_string(), known_class(index, BAG)), ("slot".to_string(), known_class(index, SLOT))]);
    let Some(props) = props else {
        site.extend(tag.into_iter().flatten().filter(|(name, _)| identifier(name)));
        return site;
    };
    for (name, default) in props {
        let t = match (tag.as_ref().map(|t| t.get(name)), default) {
            (None, _) | (Some(None), _) if spread => None,
            (None, _) => None,
            (Some(Some(Some(t))), Some(default)) if parts(t).contains(&"null") => {
                let mut kept: Vec<&str> = parts(t).into_iter().filter(|p| *p != "null").collect();
                default.as_deref().map(|d| {
                    kept.extend(parts(d).into_iter().filter(|p| !kept.contains(p)).collect::<Vec<_>>());
                    kept.join("|")
                })
            }
            (Some(Some(t)), _) => t.clone(),
            (Some(None), Some(default)) => default.clone(),
            (Some(None), None) => continue,
        };
        site.insert(name.clone(), t);
    }
    site
}

/// The members of a docblock union, `a|array<int, b|c>` as `a` and `array<int, b|c>`.
fn parts(t: &str) -> Vec<&str> {
    let (mut out, mut depth, mut start) = (vec![], 0, 0);
    for (i, c) in t.char_indices() {
        match c {
            '<' | '(' | '{' => depth += 1,
            '>' | ')' | '}' => depth -= 1,
            '|' if depth == 0 => {
                out.push(&t[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&t[start..]);
    out
}

/// A component's `@aware` variables, and where its tags in a view that leave one out get it, as Laravel looks
/// for it: in the data of the component whose view it is, then in that of the component tags around the tag.
struct Aware<'a> {
    /// Each variable, with its default's type when it has a default, which it gets when no component tag around
    /// the tag passes it.
    names: &'a Props,
    /// In a component's own view, its `@props` (`None` without them): its variables that are props without a
    /// default, or all of them without `@props`, are what every one of its tags passed. A class component's view
    /// has no props here, since what its tags pass isn't known. `None` in other views, where a variable comes from
    /// the component tag around the tag, when that's an anonymous component's and passes it.
    own: Option<Option<Props>>,
    /// Whether a tag is an anonymous component's, whose attributes are what it passes.
    anonymous: &'a dyn Fn(&str) -> bool,
}

/// The places in `text`, the Blade view at `path` whose variables `vars` gives, that render the view `quoted` names:
/// its includes, with what their data arrays pass and the variables in `names` as they are at the include, since an
/// include gets them all; its `@each`es, with the item and its `$key`; and its component tags among `tags`, or
/// `<x-dynamic-component>`s that name one of them literally ([`tag_site`], with `aware`'s variables).
/// `@include` and `@includeIf` take the view first, `@includeWhen` and `@includeUnless` after their condition, and
/// `@includeFirst` in its list of views. Other directives that name it, such as `@extends`, pass nothing known.
#[allow(clippy::too_many_arguments)]
fn sites_in(index: &Index, path: &Path, text: &str, quoted: &[String; 2], tags: &[String], props: Option<&Props>, aware: &Aware<'_>, outer: &[Around], names: &BTreeSet<String>, vars: &mut dyn FnMut() -> Vec<(String, String)>) -> Vec<Site> {
    let src = text.as_bytes();
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut sites = vec![];
    // The view with each include's variables echoed just before it, `{{ $post }}`, so their types there are read.
    let mut probed = String::new();
    // Where the echoes go in the view, and how long they are.
    let mut inserted = vec![];
    // Each include and `@each`: the offset of its `(` in the view, the view's position among its arguments (`None`
    // for `@each`), and its echoes.
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
            "include" | "includeIf" | "includeFirst" => 0,
            "includeWhen" | "includeUnless" => 1,
            "each" => {
                found.push((open, None, vec![]));
                continue;
            }
            "extends" | "extendsFirst" | "component" => {
                sites.push(Site::new());
                continue;
            }
            _ => continue,
        };
        probed.push_str(&text[last..at]);
        let mut echoes = vec![];
        let from = probed.len();
        for name in names {
            let start = probed.len() + 3;
            probed.push_str(&format!("{{{{ ${name} }}}}"));
            echoes.push((name.clone(), start, start + 1 + name.len()));
        }
        inserted.push((at, probed.len() - from));
        found.push((open, Some(position), echoes));
        last = at;
    }
    probed.push_str(&text[last..]);
    // An offset in the view as one in `probed`.
    let shift = |offset: usize| offset + inserted.iter().filter(|(at, _)| *at <= offset).map(|(_, len)| len).sum::<usize>();
    // Each component tag that renders the view, outside comments.
    let comments = comments(text);
    let mut uses = vec![];
    for tag in tags.iter().map(String::as_str).chain(["dynamic-component"]) {
        for prefix in ["<x-", "<x:"] {
            let opening = format!("{prefix}{tag}");
            for (at, _) in text.match_indices(&opening) {
                let after = at + opening.len();
                if text[after..].starts_with(|c: char| c.is_alphanumeric() || "_-:.".contains(c)) || comments.iter().any(|c| c.contains(&at)) {
                    continue;
                }
                let mut attrs = tag_attrs(text, after, tag);
                if tag == "dynamic-component" {
                    if !dynamic_name(text, after).is_some_and(|name| tags.contains(&name)) {
                        continue;
                    }
                    if let Some((attrs, _, _)) = &mut attrs {
                        attrs.retain(|(name, _)| name != "component");
                    }
                }
                // `None` when no component tag is open around it, so an `@aware` variable that it doesn't pass gets
                // its default, and `Some(None)` when what the tag around it passes isn't known.
                let around = if aware.names.is_empty() || aware.own.is_some() {
                    Some(None)
                } else {
                    enclosing(text, at, &comments).map(|open| open.filter(|(tag, _)| (aware.anonymous)(tag)))
                };
                uses.push((attrs, around));
            }
        }
    }
    if found.is_empty() && uses.is_empty() {
        return sites;
    }
    let vars = vars();
    let arounds: Vec<_> = uses.iter().map(|(_, around)| around.clone()).collect();
    let key = (path, text, quoted, tags, props, names, &vars, (aware.names, &aware.own, arounds, outer));
    let found_sites = cached(&VIEW_SITES, index, key, || {
        let mut sites = vec![];
        let checked = blade::checked_php(&probed, &vars);
        let php = &checked.php;
        let arena = LocalArena::new();
        let parsed = Parsed::new(&arena, path, php);
        let analysis = analyze(&parsed, &arena, index);
        let type_of = |e: &Expression<'_>| analysis.type_of(e.span().start.offset, e.span().end.offset);
        // The directives' arguments and the tags' bound attributes, which read as arrays.
        let mut arrays = HashMap::new();
        walk(&parsed, |node, _| {
            if let Node::Array(a) = node
                && let offset = a.left_bracket.start.offset as usize
                && offset >= checked.head
                && let Ok(at) = checked.view_offset(offset)
            {
                arrays.insert(at, a);
            }
        });
        let literal = |e: &Expression<'_>| matches!(e, Expression::Literal(Literal::String(s)) if quoted.iter().any(|q| &php[s.span.start.offset as usize..s.span.end.offset as usize] == q));
        let names_it = |e: Option<&Expression<'_>>| match e {
            Some(Expression::Array(list)) => list.elements.iter().any(|e| matches!(e, ArrayElement::Value(v) if literal(v.value))),
            Some(e) => literal(e),
            None => false,
        };
        for (open, position, echoes) in found {
            // One in a comment isn't read.
            let Some(array) = arrays.get(&shift(open)) else { continue };
            let args: Vec<Option<&Expression<'_>>> = array.elements.iter().map(|e| if let ArrayElement::Value(v) = e { Some(v.value) } else { None }).collect();
            let arg = |i: usize| args.get(i).copied().flatten();
            let Some(position) = position else {
                // `@each('view', $items, 'item')` passes each item and its key, and its empty view, fourth, nothing.
                if names_it(arg(0)) {
                    let iterable = arg(1).and_then(&type_of).filter(|t| t.types.len() == 1);
                    let kv = iterable.and_then(|t| mago_codex::ttype::get_iterable_parameters(&t.types[0], &index.codebase));
                    let item = match arg(2) {
                        Some(Expression::Literal(Literal::String(s))) => s.value.and_then(|v| std::str::from_utf8(v).ok()).filter(|v| identifier(v)),
                        _ => None,
                    };
                    sites.push(match item {
                        Some(item) => Site::from([("key".to_string(), kv.as_ref().and_then(|(k, _)| docblock_type(k))), (item.to_string(), kv.as_ref().and_then(|(_, v)| docblock_type(v)))]),
                        None => Site::new(),
                    });
                } else if names_it(arg(3)) {
                    sites.push(Site::new());
                }
                continue;
            };
            if !names_it(arg(position)) {
                continue;
            }
            let mut vars: Site = echoes.into_iter().map(|(name, s, e)| (name, analysis.type_of(checked.php_offset(s) as u32, checked.php_offset(e) as u32).and_then(|t| docblock_type(&t)))).collect();
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
        let bound = |at: usize| bound_type(arrays.get(&shift(at)).copied(), &analysis);
        let typed = |attrs: Vec<(String, Attr)>| attr_types(attrs, &bound);
        for (used, around) in uses {
            let spread = used.as_ref().is_some_and(|(_, _, spread)| *spread);
            let tag = used.map(|(attrs, slots, _)| {
                let mut site = typed(attrs);
                // A prop may be passed as a slot.
                site.extend(slots.into_iter().map(|s| (s, known_class(index, SLOT))));
                site
            });
            let site = tag_site(index, tag.clone(), props, spread);
            // With no component tag around it in the view, it's inside what the view is included in.
            let arounds: Vec<Around> = match around {
                None if !outer.is_empty() => outer.to_vec(),
                None => vec![None],
                Some(around) => vec![Some(around.and_then(|(name, at)| tag_attrs(text, at, &name)).map(|(attrs, _, _)| typed(attrs)))],
            };
            for around in arounds {
                let mut site = site.clone();
                for (name, default) in aware.names {
                    let t = tag.as_ref().and_then(|tag| match (tag.get(name), &aware.own) {
                        (Some(t), _) => t.clone(),
                        // `{{ $attributes }}` may pass it.
                        (None, _) if spread => None,
                        (None, Some(own)) if own.as_ref().is_none_or(|props| props.contains(&(name.clone(), None))) => vars.iter().find(|(n, _)| n == name).map(|(_, t)| t.clone()),
                        (None, Some(_)) => None,
                        // No component around it passes it, so it gets its default.
                        (None, None) if around.is_none() => default.clone().flatten(),
                        (None, None) => around.as_ref().and_then(Option::as_ref).and_then(|around| around.get(name).cloned().flatten()),
                    });
                    site.insert(name.clone(), t);
                }
                sites.push(site);
            }
        }
        sites
    });
    sites.extend(found_sites);
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
        let models = "<?php\nnamespace App;\nclass User {}\nclass Comment { /** @var list<Comment> */ public array $replies = []; }\nclass Post { /** @var list<Comment> */ public array $comments = []; public ?User $author = null; }\n";
        let controller = "<?php\nnamespace App;\nclass PostController {\n    public function show(Post $post, array $extra) { return view('posts.show', compact('post', 'extra')); }\n    public function tree(Comment $c) { return view('tree', ['node' => $c]) ?: view('bad', ['node' => $c]); }\n}\n";
        let show = "@foreach ($post->comments as $comment) @include('posts.comment', ['n' => 1]) @endforeach\n@include('posts.meta')\n@includeWhen($post->author, 'posts.byline', ['by' => $post->author])\n{{-- @include('posts.meta', ['post' => 1]) --}}\n@include('posts.extra', $extra) @each('posts.each', $post->comments, 'comment', 'posts.none')\n@includeFirst(['custom', 'posts.first'], ['n' => 2])\n";
        let views = [
            ("resources/views/posts/show.blade.php", show),
            ("resources/views/posts/comment.blade.php", "{{ $comment }} {{ $post }} {{ $n }} {{ $nope }}"),
            ("resources/views/posts/meta.blade.php", "{{ $post }}"),
            ("resources/views/posts/byline.blade.php", "{{ $by }} {{ $post }}"),
            ("resources/views/posts/extra.blade.php", "{{ $post }}"),
            ("resources/views/posts/each.blade.php", "{{ $comment }}"),
            ("resources/views/posts/none.blade.php", "{{ $comment }}"),
            ("resources/views/posts/first.blade.php", "{{ $post }} {{ $n }}"),
            ("resources/views/tree.blade.php", "@foreach ($node->replies as $reply) @include('tree', ['node' => $reply]) @endforeach"),
            ("resources/views/bad.blade.php", "@include('bad', ['node' => $node->nope])"),
        ];
        let mut files = vec![("app/Models.php", models), ("app/PostController.php", controller)];
        files.extend(views);
        let fx = Fixture::new(&files);
        let paths: Vec<PathBuf> = views.iter().map(|(p, _)| path(p)).collect();
        let index = fx.snap.index.read();
        let read = |p: &Path| fx.snap.read(p);
        let types_of = |view: &str| types_among(&index, &read, None, &paths, view);
        let owned = |pairs: &[(&str, &str)]| pairs.iter().map(|(n, t)| (n.to_string(), t.to_string())).collect::<Vec<_>>();
        // A loop variable as it is in the loop, the includer's own variables, and the include's data.
        assert_eq!(types_of("posts.comment"), owned(&[("comment", "\\App\\Comment"), ("n", "int"), ("post", "\\App\\Post")]));
        assert_eq!(types_of("posts.meta"), owned(&[("post", "\\App\\Post")]));
        assert_eq!(types_of("posts.byline"), owned(&[("by", "null|\\App\\User"), ("post", "\\App\\Post")]));
        // Data of unknown keys passes nothing known; `@each` passes the item and its key.
        assert!(types_of("posts.extra").is_empty());
        assert_eq!(types_of("posts.each"), owned(&[("comment", "\\App\\Comment"), ("key", "int")]));
        assert!(types_of("posts.none").is_empty());
        assert_eq!(types_of("posts.first"), owned(&[("n", "int"), ("post", "\\App\\Post")]));
        // A view that includes itself passes what it's given.
        assert_eq!(types_of("tree"), owned(&[("node", "\\App\\Comment")]));
        assert!(types_of("bad").is_empty());
    }

    #[test]
    fn types_a_components_props_from_the_tags_that_use_it() {
        let models = "<?php\nnamespace App;\nclass Comment { /** @var list<Comment> */ public array $replies = []; }\nclass Post { /** @var list<Comment> */ public array $comments = []; }\n";
        let laravel = "<?php\nnamespace Illuminate\\View;\nclass ComponentAttributeBag {}\nclass ComponentSlot {}\nclass InvokableComponentVariable {}\nabstract class Component { public function data() {} public function resolveView() {} }\n";
        let alert = "<?php\nnamespace App\\View\\Components;\nclass Alert extends \\Illuminate\\View\\Component {\n    public string $type = 'info';\n    public static int $count = 0;\n    public int $hidden = 0;\n    protected $except = ['hidden', 'secret'];\n    public function __construct() {}\n    public function render() { return view('components.alert'); }\n    public function isActive(): bool { return true; }\n    /** @return list<string> */\n    public function labels(string $prefix, int $count = 1, \\App\\Post ...$posts): array { return []; }\n    public function secret(): int { return 1; }\n    protected function inner(): int { return 1; }\n}\n";
        let controller = "<?php\nnamespace App;\nclass PostController {\n    public function show(Post $post, ?string $size) { return view('show', compact('post', 'size')); }\n}\n";
        let show = "<x-card :post=\"$post\" title=\"Hi\" data-x=\"1\" />\n<x-card :$post title=\"Hi\" size=\"lg\" disabled>body</x-card>\n<x-card :post=\"$post\" :size=\"$size\" title=\"Hi\"><x-card :post=\"$post\" title=\"x\"></x-card><x-slot:footer>f</x-slot></x-card>\n{{-- <x-card :post=\"1\" /> --}}\n<x-alert type=\"x\" />\n<x-forms.input :value=\"$post->comments\" wire:model=\"v\" />\n@foreach ($post->comments as $c) <x-tree :node=\"$c\" /> @endforeach\n<x-spread {{ $attributes }} :post=\"$post\" />\n<x-cards :post=\"1\" />\n";
        let views = [
            ("resources/views/show.blade.php", show),
            ("resources/views/components/card.blade.php", "@props(['post', 'title', 'size' => 'md', 'disabled' => false, 'footer' => null])\n{{ $post }}"),
            ("resources/views/components/cards.blade.php", "{{ $post }}"),
            ("resources/views/components/alert.blade.php", "{{ $type }}"),
            ("resources/views/components/forms/input/index.blade.php", "{{ $value }}"),
            ("resources/views/components/tree.blade.php", "@props(['node'])\n@foreach ($node->replies as $r) <x-tree :node=\"$r\" /> @endforeach"),
            ("resources/views/components/spread.blade.php", "@props(['post'])"),
        ];
        let mut files = vec![("app/Models.php", models), ("vendor/View.php", laravel), ("app/View/Components/Alert.php", alert), ("app/PostController.php", controller)];
        files.extend(views);
        let fx = Fixture::new(&files);
        let paths: Vec<PathBuf> = views.iter().map(|(p, _)| path(p)).collect();
        let index = fx.snap.index.read();
        let read = |p: &Path| fx.snap.read(p);
        let types_of = |view: &str| types_among(&index, &read, None, &paths, view);
        let owned = |pairs: &[(&str, &str)]| pairs.iter().map(|(n, t)| (n.to_string(), t.to_string())).collect::<Vec<_>>();
        let (bag, slot) = (("attributes", "\\Illuminate\\View\\ComponentAttributeBag"), ("slot", "\\Illuminate\\View\\ComponentSlot"));
        // Bound and plain attributes, `:$post`, defaults where a tag leaves a prop out or passes null, and a prop
        // passed as a slot, though not one inside another component's tag.
        let footer = ("footer", "null|\\Illuminate\\View\\ComponentSlot");
        assert_eq!(types_of("components.card"), owned(&[bag, ("disabled", "false|true"), footer, ("post", "\\App\\Post"), ("size", "string"), slot, ("title", "string")]));
        // A class component's view gets its public properties and methods, not the tag's attributes, leaving out
        // Laravel's own and the `$except` ones. A method without parameters is invoked as it's used.
        let labels = ("labels", "\\Closure(string, int=, \\App\\Post...): list<string>");
        let active = ("isActive", "\\Illuminate\\View\\InvokableComponentVariable");
        assert_eq!(types_of("components.alert"), owned(&[active, labels, slot, ("type", "string")]));
        // Without `@props`, each attribute is a variable; `index.blade.php` answers to its folder's name.
        assert_eq!(types_of("components.forms.input.index"), owned(&[bag, slot, ("value", "list<\\App\\Comment>")]));
        // A component that renders itself, and one passed attributes whose names aren't known.
        assert_eq!(types_of("components.tree"), owned(&[bag, ("node", "\\App\\Comment"), slot]));
        // `{{ $attributes }}` may pass the props a tag leaves out, but not those it passes.
        assert_eq!(types_of("components.spread"), owned(&[bag, ("post", "\\App\\Post"), slot]));
    }

    #[test]
    fn types_aware_variables_through_the_views_that_include_a_tag() {
        let models = "<?php\nnamespace App;\nclass Post {}\n";
        let laravel = "<?php\nnamespace Illuminate\\View;\nclass ComponentAttributeBag {}\nclass ComponentSlot {}\nabstract class Component {}\n";
        let controller = "<?php\nnamespace App;\nclass PageController {\n    public function show(Post $post) { return view('page', compact('post')) ?: view('plain'); }\n}\n";
        let views = [
            // Included in a component's slot, directly and through another view.
            ("resources/views/page.blade.php", "<x-menu :color=\"$post\">\n  @include('partials.items')\n  @include('partials.wrap')\n</x-menu>\n<x-menu :color=\"$post\">@include('partials.mixed')</x-menu>\n"),
            ("resources/views/partials/items.blade.php", "<x-menu.item />"),
            ("resources/views/partials/wrap.blade.php", "@include('partials.deep')"),
            ("resources/views/partials/deep.blade.php", "<x-menu.link />"),
            // Also included outside any component, where it gets the default.
            ("resources/views/plain.blade.php", "@include('partials.mixed')"),
            ("resources/views/partials/mixed.blade.php", "<x-menu.dot />"),
            // Included in a component's own view, whose data isn't known.
            ("resources/views/components/panel.blade.php", "@include('partials.inner')"),
            ("resources/views/partials/inner.blade.php", "<x-menu.tip />"),
            ("resources/views/components/menu.blade.php", "@props(['color' => 'gray'])"),
            ("resources/views/components/menu/item.blade.php", "@aware(['color' => 'gray'])"),
            ("resources/views/components/menu/link.blade.php", "@aware(['color' => 'gray'])"),
            ("resources/views/components/menu/dot.blade.php", "@aware(['color' => 'gray'])"),
            ("resources/views/components/menu/tip.blade.php", "@aware(['color' => 'gray'])"),
        ];
        let mut files = vec![("app/Models.php", models), ("vendor/View.php", laravel), ("app/PageController.php", controller)];
        files.extend(views);
        let fx = Fixture::new(&files);
        let paths: Vec<PathBuf> = views.iter().map(|(p, _)| path(p)).collect();
        let index = fx.snap.index.read();
        let read = |p: &Path| fx.snap.read(p);
        let color = |view: &str| types_among(&index, &read, None, &paths, view).into_iter().find(|(n, _)| n == "color").map(|(_, t)| t);
        assert_eq!(color("components.menu.item").as_deref(), Some("\\App\\Post"));
        assert_eq!(color("components.menu.link").as_deref(), Some("\\App\\Post"));
        assert_eq!(color("components.menu.dot").as_deref(), Some("\\App\\Post|string"));
        assert_eq!(color("components.menu.tip"), None);
    }

    #[test]
    fn reads_what_a_components_constructor_does_to_except() {
        let laravel = "<?php\nnamespace Illuminate\\View;\nclass ComponentAttributeBag {}\nclass ComponentSlot {}\nclass InvokableComponentVariable {}\nabstract class Component {}\n";
        let component = |name: &str, constructor: &str| {
            format!("<?php\nnamespace App\\View\\Components;\nclass {name} extends \\Illuminate\\View\\Component {{\n    public string $type = 'info';\n    public int $count = 0;\n    protected $except = ['count'];\n    public function __construct(bool $flag = false) {{ {constructor} }}\n    public function render() {{ return view('components.{}'); }}\n    public function label(): string {{ return ''; }}\n}}\n", name.to_lowercase())
        };
        // Added to, merged, and replaced in order; anything else, or a change that may not run, isn't known.
        let added = component("Added", "$this->except[] = 'label'; $this->except = array_merge($this->except, ['type']);");
        let replaced = component("Replaced", "$this->except = ['type'];");
        let unknown = component("Unknown", "$this->except = $flag ? ['type'] : [];");
        let conditional = component("Conditional", "if ($flag) { $this->except[] = 'type'; }");
        let views = ["added", "replaced", "unknown", "conditional"].map(|v| (format!("resources/views/components/{v}.blade.php"), "{{ $type }}"));
        let mut files: Vec<(&str, &str)> = vec![("vendor/View.php", laravel)];
        for (name, text) in [("Added", &added), ("Replaced", &replaced), ("Unknown", &unknown), ("Conditional", &conditional)] {
            files.push((Box::leak(format!("app/View/Components/{name}.php").into_boxed_str()), text));
        }
        files.extend(views.iter().map(|(p, t)| (p.as_str(), *t)));
        let fx = Fixture::new(&files);
        let paths: Vec<PathBuf> = views.iter().map(|(p, _)| path(p)).collect();
        let index = fx.snap.index.read();
        let read = |p: &Path| fx.snap.read(p);
        let names = |view: &str| types_among(&index, &read, None, &paths, view).into_iter().map(|(n, _)| n).collect::<Vec<_>>();
        assert_eq!(names("components.added"), vec!["slot"]);
        assert_eq!(names("components.replaced"), vec!["count", "label", "slot"]);
        assert_eq!(names("components.unknown"), vec!["slot"]);
        assert_eq!(names("components.conditional"), vec!["slot"]);
    }

    #[test]
    fn types_registered_dynamic_and_aware_components() {
        let models = "<?php\nnamespace App;\nclass Post {}\n";
        let laravel = "<?php\nnamespace Illuminate\\View;\nclass ComponentAttributeBag {}\nclass ComponentSlot {}\nabstract class Component {}\n";
        let select = "<?php\nnamespace App\\View\\Components\\Forms;\nclass Select extends \\Illuminate\\View\\Component { public array $options = []; public function render() { return view('components.forms.select'); } }\n";
        let controller = "<?php\nnamespace App;\nclass PageController {\n    public function show(Post $post, string $name) { return view('page', compact('post', 'name')); }\n}\n";
        let page = "<x-dynamic-component component=\"alert\" :post=\"$post\" />\n<x-dynamic-component :component=\"'alert'\" :post=\"$post\"></x-dynamic-component>\n<x-dynamic-component :component=\"$name\" :post=\"1\" />\n<x-ui::button :size=\"5\" />\n<x-card title=\"x\" />\n<x-menu color=\"red\"><div><x-menu.item /></div></x-menu>\n<x-menu><x-menu.dot /></x-menu>\n<x-menu color=\"red\"><x-menu.dot /></x-menu>\n<x-nav :color=\"$post\" />\n<x-badge />\n<x-menu><x-chip /></x-menu>\n<x-chip />\n";
        let views = [
            ("resources/views/page.blade.php", page),
            ("resources/views/components/alert.blade.php", "@props(['post'])"),
            ("resources/views/ui/button.blade.php", "{{ $size }}"),
            ("resources/views/components/card.blade.php", "{{ $title }}"),
            ("resources/views/components/forms/select.blade.php", "{{ $options }}"),
            ("resources/views/components/menu.blade.php", "@props(['color' => 'gray'])"),
            ("resources/views/components/menu/item.blade.php", "@aware(['color' => 'gray'])"),
            ("resources/views/components/menu/dot.blade.php", "@aware(['color' => 'gray'])"),
            ("resources/views/components/nav.blade.php", "@props(['color'])\n<x-nav.link />"),
            ("resources/views/components/nav/link.blade.php", "@aware(['color'])"),
            ("resources/views/components/badge.blade.php", "@aware(['tone' => 1])"),
            ("resources/views/components/chip.blade.php", "@aware(['tone' => 1])"),
        ];
        let mut files = vec![("app/Models.php", models), ("vendor/View.php", laravel), ("app/View/Components/Forms/Select.php", select), ("app/PageController.php", controller)];
        files.extend(views);
        let fx = Fixture::new(&files);
        let paths: Vec<PathBuf> = views.iter().map(|(p, _)| path(p)).collect();
        let index = fx.snap.index.read();
        let read = |p: &Path| fx.snap.read(p);
        let anonymous = |tag: &str| (tag.to_string(), serde_json::json!({"paths": [format!("resources/views/components/{}.blade.php", tag.replace('.', "/"))]}));
        let mut listed: serde_json::Map<String, Value> = ["alert", "menu", "menu.item", "menu.dot", "nav", "nav.link", "badge", "chip"].into_iter().map(anonymous).collect();
        listed.insert("ui::button".into(), serde_json::json!({"paths": ["resources/views/ui/button.blade.php"]}));
        listed.insert("card".into(), serde_json::json!({"paths": ["app/View/Components/Card.php", "resources/views/components/card.blade.php"]}));
        let components = serde_json::json!({"components": listed});
        let types_of = |view: &str| types_among(&index, &read, Some(&components), &paths, view);
        let owned = |pairs: &[(&str, &str)]| pairs.iter().map(|(n, t)| (n.to_string(), t.to_string())).collect::<Vec<_>>();
        let (bag, slot) = (("attributes", "\\Illuminate\\View\\ComponentAttributeBag"), ("slot", "\\Illuminate\\View\\ComponentSlot"));
        // A dynamic component with a literal name is its tag; one without isn't read.
        assert_eq!(types_of("components.alert"), owned(&[bag, ("post", "\\App\\Post"), slot]));
        // A component the app registers, by its tag, and one it registers with a class.
        assert_eq!(types_of("ui.button"), owned(&[bag, ("size", "int"), slot]));
        assert!(types_of("components.card").is_empty());
        assert_eq!(types_among(&index, &read, None, &paths, "components.card"), owned(&[bag, slot, ("title", "string")]));
        assert_eq!(types_of("components.forms.select"), owned(&[("options", "array"), slot]));
        // `@aware` from the tag around it, unless that leaves it out, and in a component's view, from its tags.
        assert_eq!(types_of("components.menu.item"), owned(&[bag, ("color", "string"), slot]));
        assert_eq!(types_of("components.menu.dot"), owned(&[bag, slot]));
        assert_eq!(types_of("components.nav.link"), owned(&[bag, ("color", "\\App\\Post"), slot]));
        // Its default where no component tag is around it, but not where one is that leaves it out.
        assert_eq!(types_of("components.badge"), owned(&[bag, slot, ("tone", "int")]));
        assert_eq!(types_of("components.chip"), owned(&[bag, slot]));
    }

    /// Types a class component's view with Laravel's own `Component`, from a real app's `vendor`. Run with
    /// `TUSK_LARAVEL_APP=<root> cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn types_a_class_components_view_with_laravels_component() {
        let Ok(root) = std::env::var("TUSK_LARAVEL_APP") else { return };
        let view = Path::new(&root).join("vendor/laravel/framework/src/Illuminate/View");
        let read = |name: &str| std::fs::read_to_string(view.join(name)).unwrap();
        let laravel: Vec<(String, String)> = ["Component.php", "ComponentAttributeBag.php", "ComponentSlot.php", "InvokableComponentVariable.php"].iter().map(|f| (format!("vendor/{f}"), read(f))).collect();
        let alert = "<?php\nnamespace App\\View\\Components;\nclass Alert extends \\Illuminate\\View\\Component {\n    public string $type = 'info';\n    protected $except = ['secret'];\n    public function render() { return view('components.alert'); }\n    public function isActive(): bool { return true; }\n    public function secret(): int { return 1; }\n    /** @return list<string> */\n    public function labels(string $prefix): array { return []; }\n}\n";
        let mut files: Vec<(&str, &str)> = laravel.iter().map(|(p, t)| (p.as_str(), t.as_str())).collect();
        files.extend([("app/View/Components/Alert.php", alert), ("resources/views/components/alert.blade.php", "{{ $type }}")]);
        let fx = Fixture::new(&files);
        let index = fx.snap.index.read();
        let types = types_among(&index, &|p| fx.snap.read(p), None, &[path("resources/views/components/alert.blade.php")], "components.alert");
        let names: Vec<&str> = types.iter().map(|(n, _)| n.as_str()).collect();
        eprintln!("{types:?}");
        // Laravel's public static `ignoredParameterNames()` isn't on its ignore list, so views get it too.
        assert_eq!(names, vec!["attributes", "componentName", "ignoredParameterNames", "isActive", "labels", "slot", "type"]);
        let type_of = |name: &str| types.iter().find(|(n, _)| n == name).map(|(_, t)| t.as_str());
        assert_eq!(type_of("attributes"), Some("\\Illuminate\\View\\ComponentAttributeBag"));
        assert_eq!(type_of("isActive"), Some("\\Illuminate\\View\\InvokableComponentVariable"));
        assert_eq!(type_of("labels"), Some("\\Closure(string): list<string>"));
    }
}
