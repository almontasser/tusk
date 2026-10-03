//! The closures Filament calls with parameters it injects by name, as in `->visible(fn ($record, Get $get) => …)`.
//!
//! ```php
//! TextColumn::make('title')
//!     ->description(fn ($record) => $record->slug)   // `$record` is the table's model
//!     ->url(fn (string $page) => …)                  // Filament can't inject `$page`: it throws when it runs
//! ```
//!
//! Each component evaluates its closures with `evaluate()`, which resolves a parameter by the names its class's
//! `resolveDefaultClosureDependencyForEvaluationByName()` matches, the names the `evaluate()` call passes, its
//! `$evaluationIdentifier`, and then by type. The names come from that code in the project's `vendor`, read through
//! the index, so each Filament version and each component class gets its own. [`ClosureHook`] types the parameters
//! a closure leaves untyped (`$get`, `$set`, `$record`, `$livewire`, …) in the analysis, so their members complete
//! and are checked.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use lsp_types::{CompletionItem, CompletionItemKind, Diagnostic, DiagnosticSeverity, NumberOrString};
use mago_allocator::LocalArena;
use mago_analyzer::plugin::{ExpressionHook, HookContext, HookResult, IssueFilterDecision, IssueFilterHook, Provider, ProviderMeta};
use mago_codex::ttype::atomic::TAtomic;
use mago_codex::ttype::atomic::object::TObject;
use mago_codex::ttype::atomic::object::named::TNamedObject;
use mago_codex::ttype::union::TUnion;
use mago_database::file::File;
use mago_reporting::{AnnotationKind, Issue};
use mago_span::HasSpan;
use mago_syntax::cst::{Argument, ArrayElement, Expression, FunctionLikeParameterList, Hint, Literal, Node};
use parking_lot::Mutex;

use crate::analysis::Parsed;
use crate::documents::Documents;
use crate::features::Ctx;
use crate::index::Index;
use crate::scope::{resolve_class, scope_at};

/// Every node with its ancestors, depth first, as [`crate::locate::walk`] gives them but on a stack of its own: the
/// analysis runs this from inside other walks of deeply nested schemas.
pub(super) fn walk<'a>(parsed: &Parsed<'a>, mut f: impl FnMut(Node<'a, 'a>, &[Node<'a, 'a>])) {
    let mut stack = vec![(Node::Program(parsed.program), 0)];
    let mut path: Vec<Node<'a, 'a>> = vec![];
    let mut children = vec![];
    while let Some((node, depth)) = stack.pop() {
        path.truncate(depth);
        f(node, &path);
        path.push(node);
        node.visit_children(|c| children.push(c));
        stack.extend(children.drain(..).rev().map(|c| (c, depth + 1)));
    }
}

const RESOLVER: &str = "resolveDefaultClosureDependencyForEvaluationByName";
const EVALUATES: &str = "Filament\\Support\\Concerns\\EvaluatesClosures";
const MODEL: &str = "Illuminate\\Database\\Eloquent\\Model";

/// The names a Filament class can inject into the closures it evaluates.
#[derive(Debug, Default)]
pub struct Injections {
    /// The names its resolver matches, such as `record` and `get`, nearest class first.
    pub names: Vec<String>,
    /// Its `$evaluationIdentifier`, the name that gets the component itself, such as `component` or `column`.
    pub identifier: Option<String>,
    /// The names any `evaluate()` in its code passes, such as `old` for `afterStateUpdated()`.
    pub passed: HashSet<String>,
    /// Whether every resolver and `evaluate()` call of the class was read in full, so a name outside these is
    /// surely not injected.
    pub sure: bool,
    /// Whether Filament gives `null` to a parameter that allows it rather than throwing, as Filament 4 and later do.
    pub nulls: bool,
}

impl Injections {
    pub fn injects(&self, name: &str) -> bool {
        self.names.iter().any(|n| n == name) || self.identifier.as_deref() == Some(name) || self.passed.contains(name)
    }
}

/// The methods whose closure the component keeps and evaluates itself with `evaluate()`, in Filament 3, 4, and 5
/// alike, so a parameter it can't resolve surely throws. Other methods may call their closure directly, or have
/// another object evaluate it, with names of its own.
const EVALUATED: &[&str] = &[
    "afterStateHydrated",
    "afterStateUpdated",
    "color",
    "default",
    "dehydrateStateUsing",
    "description",
    "disabled",
    "formatStateUsing",
    "helperText",
    "hidden",
    "hint",
    "icon",
    "label",
    "options",
    "placeholder",
    "required",
    "tooltip",
    "url",
    "visible",
];

/// Facts read from a file, by its path and a hash of its text or its size and modification time.
static FILES: LazyLock<Mutex<HashMap<PathBuf, Keyed>>> = LazyLock::new(Default::default);
type Keyed = (u64, Arc<FileFacts>);
type Found = HashMap<String, Option<Arc<Injections>>>;
/// What [`injections`] found for each class, for the index's generation.
static CLASSES: LazyLock<Mutex<(u64, Found)>> = LazyLock::new(Default::default);

/// What a PHP file says that the features here use.
#[derive(Debug, Default)]
pub struct FileFacts {
    /// The keys of each `evaluate()` call's named injections, or `None` when a call passes them some other way.
    pub evaluated: Option<HashSet<String>>,
    /// Each class's facts, by its full name in lowercase.
    pub classes: HashMap<String, ClassFacts>,
}

/// What a class declares: the values of its properties, the related model of each relationship method, and its
/// resource pages.
#[derive(Debug, Default, Clone)]
pub struct ClassFacts {
    /// Properties set to `X::class` or a string, such as `$model` or `$relationship`, without `$`.
    pub classes: HashMap<String, String>,
    pub strings: HashMap<String, String>,
    /// Methods that return `$this->hasMany(X::class, …)` or another relationship, with `X`.
    pub related: HashMap<String, String>,
    /// `getPages()`'s keys when it returns a literal array: each name, its page class if it's `X::route(…)`, and
    /// where the key is.
    pub pages: Option<Vec<Page>>,
}

#[derive(Debug, Clone)]
pub struct Page {
    pub name: String,
    pub class: Option<String>,
    pub at: u32,
}

fn hash(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

/// The facts of the file at `path`.
pub fn file_facts(docs: &Documents, path: &Path) -> Option<Arc<FileFacts>> {
    // A closed file is known by its size and modification time, so `vendor`'s files aren't read again.
    let key = match docs.get(path) {
        Some(doc) => hash(&doc.text),
        None => {
            let meta = std::fs::metadata(path).ok()?;
            let modified = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos() as u64;
            modified ^ meta.len().rotate_left(32)
        }
    };
    if let Some((k, facts)) = FILES.lock().get(path)
        && *k == key
    {
        return Some(facts.clone());
    }
    let text = docs.read(path)?;
    let arena = LocalArena::new();
    let parsed = Parsed::new(&arena, path, &text);
    let facts = Arc::new(read_facts(&parsed));
    let mut files = FILES.lock();
    // A cache of every file read since the start would only grow; the files the features read are few.
    if files.len() > 4096 {
        files.clear();
    }
    files.insert(path.to_path_buf(), (key, facts.clone()));
    Some(facts)
}

/// Relationship methods of Eloquent models whose first argument is the related model.
const RELATIONSHIPS: &[&str] = &[
    "hasOne", "hasMany", "belongsTo", "belongsToMany", "morphOne", "morphMany", "morphToMany", "morphedByMany", "hasOneThrough", "hasManyThrough",
];

fn read_facts(parsed: &Parsed<'_>) -> FileFacts {
    let text = parsed.text();
    let name = |span: mago_span::Span| text.get(span.start.offset as usize..span.end.offset as usize).unwrap_or_default();
    let class_of = |e: &Expression<'_>| -> Option<String> {
        let Expression::Access(mago_syntax::cst::Access::ClassConstant(a)) = e else { return None };
        let mago_syntax::cst::ClassLikeConstantSelector::Identifier(c) = &a.constant else { return None };
        if !c.value.eq_ignore_ascii_case(b"class") {
            return None;
        }
        let Expression::Identifier(id) = a.class else { return None };
        let fqn = match parsed.names.resolve(&id.span()) {
            Some(n) => String::from_utf8_lossy(n).into_owned(),
            None => resolve_class(&scope_at(parsed.program, id.span().start.offset), &String::from_utf8_lossy(id.value())),
        };
        Some(fqn.trim_start_matches('\\').to_string())
    };
    let string_of = |e: &Expression<'_>| match e {
        Expression::Literal(Literal::String(s)) => text.get(s.span.start.offset as usize + 1..s.span.end.offset as usize - 1).map(String::from),
        _ => None,
    };
    let mut facts = FileFacts { evaluated: Some(HashSet::new()), classes: HashMap::new() };
    walk(parsed, |node, ancestors| {
        let class = || {
            ancestors.iter().rev().find_map(|n| match n {
                Node::Class(c) => {
                    let short = String::from_utf8_lossy(c.name.value);
                    Some(resolve_class(&scope_at(parsed.program, c.span().start.offset), &short).trim_start_matches('\\').to_ascii_lowercase())
                }
                _ => None,
            })
        };
        match node {
            Node::MethodCall(m) if name(m.method.span()) == "evaluate" => {
                let injections = m.argument_list.arguments.iter().enumerate().find_map(|(i, a)| match a {
                    Argument::Positional(p) if i == 1 => Some(p.value),
                    Argument::Named(n) if n.name.value == b"namedInjections" => Some(n.value),
                    _ => None,
                });
                let Some(injections) = injections else { return };
                let keys: Option<Vec<String>> = match injections {
                    Expression::Array(a) => a
                        .elements
                        .iter()
                        .map(|e| match e {
                            ArrayElement::KeyValue(kv) => string_of(kv.key),
                            _ => None,
                        })
                        .collect(),
                    _ => None,
                };
                match (keys, &mut facts.evaluated) {
                    (Some(keys), Some(all)) => all.extend(keys),
                    _ => facts.evaluated = None,
                }
            }
            Node::PropertyConcreteItem(item) => {
                let Some(class) = class() else { return };
                let entry = facts.classes.entry(class).or_default();
                let property = String::from_utf8_lossy(&item.variable.name[1..]).into_owned();
                if let Some(c) = class_of(item.value) {
                    entry.classes.insert(property, c);
                } else if let Some(s) = string_of(item.value) {
                    entry.strings.insert(property, s);
                }
            }
            Node::Method(m) => {
                let Some(class) = class() else { return };
                let method = String::from_utf8_lossy(m.name.value).into_owned();
                let mago_syntax::cst::MethodBody::Concrete(body) = &m.body else { return };
                let entry = facts.classes.entry(class).or_default();
                if method.eq_ignore_ascii_case("getPages") {
                    entry.pages = pages(parsed, body, &class_of, &string_of);
                    return;
                }
                // `return $this->hasMany(Comment::class, …)`, possibly with calls after it.
                let [mago_syntax::cst::Statement::Return(r)] = body.statements.as_slice() else { return };
                let mut e = r.value;
                while let Some(Expression::Call(mago_syntax::cst::Call::Method(c))) = e {
                    let is_this = matches!(c.object, Expression::Variable(mago_syntax::cst::Variable::Direct(v)) if v.name == b"$this");
                    if is_this && RELATIONSHIPS.contains(&name(c.method.span())) {
                        let first = c.argument_list.arguments.iter().next().map(|a| match a {
                            Argument::Positional(p) => p.value,
                            Argument::Named(n) => n.value,
                        });
                        if let Some(related) = first.and_then(class_of) {
                            entry.related.insert(method.to_ascii_lowercase(), related);
                        }
                        return;
                    }
                    e = Some(c.object);
                }
            }
            _ => {}
        }
    });
    facts
}

/// The pages a `getPages()` body returns, if it returns one literal array with string keys.
fn pages(
    parsed: &Parsed<'_>,
    body: &mago_syntax::cst::Block<'_>,
    class_of: &dyn Fn(&Expression<'_>) -> Option<String>,
    string_of: &dyn Fn(&Expression<'_>) -> Option<String>,
) -> Option<Vec<Page>> {
    let [mago_syntax::cst::Statement::Return(r)] = body.statements.as_slice() else { return None };
    let elements: Vec<&ArrayElement<'_>> = match r.value? {
        Expression::Array(a) => a.elements.iter().collect(),
        Expression::LegacyArray(a) => a.elements.iter().collect(),
        _ => return None,
    };
    elements
        .into_iter()
        .map(|e| {
            let ArrayElement::KeyValue(kv) = e else { return None };
            let name = string_of(kv.key)?;
            let class = match kv.value {
                Expression::Call(mago_syntax::cst::Call::StaticMethod(s)) => match s.class {
                    Expression::Identifier(id) => parsed.names.resolve(&id.span()).map(|n| String::from_utf8_lossy(n).trim_start_matches('\\').to_string()),
                    _ => None,
                },
                other => class_of(other),
            };
            Some(Page { name, class, at: kv.key.span().start.offset + 1 })
        })
        .collect()
}

/// The facts of `class`, from the file that declares it.
pub fn class_facts(index: &Index, docs: &Documents, class: &str) -> Option<ClassFacts> {
    let meta = index.codebase.get_class_like(class.as_bytes())?;
    let path = index.path_of(meta.span.file_id)?.to_path_buf();
    file_facts(docs, &path)?.classes.get(&class.trim_start_matches('\\').to_ascii_lowercase()).cloned()
}

/// The source of a span in a file the index knows.
fn source(index: &Index, docs: &Documents, span: mago_span::Span) -> Option<String> {
    let text = docs.read(index.path_of(span.file_id)?)?;
    text.get(span.start.offset as usize..span.end.offset as usize).map(String::from)
}

/// What a Filament class injects into its closures, or `None` if it doesn't evaluate closures.
pub fn injections(index: &Index, docs: &Documents, class: &str) -> Option<Arc<Injections>> {
    let key = class.trim_start_matches('\\').to_ascii_lowercase();
    {
        let mut cache = CLASSES.lock();
        if cache.0 != index.generation {
            *cache = (index.generation, HashMap::new());
        }
        if let Some(found) = cache.1.get(&key) {
            return found.clone();
        }
    }
    let found = compute(index, docs, &key).map(Arc::new);
    let mut cache = CLASSES.lock();
    if cache.0 == index.generation {
        cache.1.insert(key, found.clone());
    }
    found
}

fn compute(index: &Index, docs: &Documents, class: &str) -> Option<Injections> {
    let cb = &index.codebase;
    if !cb.method_exists(class.as_bytes(), b"evaluate") || !cb.method_exists(class.as_bytes(), RESOLVER.as_bytes()) {
        return None;
    }
    let declaring = |c: &str| cb.get_declaring_method_class(c.as_bytes(), RESOLVER.as_bytes()).map(|w| w.as_str_lossy().to_ascii_lowercase());
    let mut out = Injections { sure: true, ..Default::default() };
    // Each class that brings a resolver of its own, nearest first, down to `EvaluatesClosures`' empty one. Each
    // resolver must match names and leave the rest to its parent's.
    let mut current = Some(class.to_string());
    let mut reached_base = false;
    while let Some(c) = current {
        let Some(d) = declaring(&c) else { break };
        let parent = cb.get_class_like(c.as_bytes()).and_then(|m| m.direct_parent_class).map(|p| p.as_str_lossy().into_owned());
        if d == EVALUATES.to_ascii_lowercase() {
            reached_base = true;
            break;
        }
        if parent.as_deref().and_then(declaring).as_deref() != Some(d.as_str()) {
            let method = cb.get_method(d.as_bytes(), RESOLVER.as_bytes())?;
            match source(index, docs, method.span).and_then(|s| resolver_arms(&s)) {
                Some(names) => {
                    for n in names {
                        if !out.names.contains(&n) {
                            out.names.push(n);
                        }
                    }
                }
                None => out.sure = false,
            }
        }
        current = parent;
    }
    out.sure &= reached_base;
    // Its default, a literal string, which the type of the default holds: `string('component')`.
    out.identifier = cb.get_declaring_property(class.as_bytes(), b"$evaluationIdentifier").and_then(|p| {
        let shown = crate::types::display(&p.default_type_metadata.as_ref()?.type_union);
        Some(shown.strip_prefix("string('")?.strip_suffix("')")?.to_string())
    });
    out.nulls = cb.get_method(EVALUATES.as_bytes(), b"resolveClosureDependencyForEvaluation").and_then(|m| source(index, docs, m.span)).is_some_and(|s| s.contains("allowsNull()"));
    // The names any `evaluate()` in the class's own code, its parents', and their traits' passes.
    let mut seen = HashSet::new();
    let mut stack = vec![class.to_string()];
    if let Some(meta) = cb.get_class_like(class.as_bytes()) {
        stack.extend(meta.all_parent_classes.iter().map(|p| p.as_str_lossy().into_owned()));
    }
    let mut files = HashSet::new();
    while let Some(c) = stack.pop() {
        if !seen.insert(c.to_ascii_lowercase()) {
            continue;
        }
        let Some(meta) = cb.get_class_like(c.as_bytes()) else {
            out.sure = false;
            continue;
        };
        stack.extend(meta.used_traits.iter().map(|t| t.as_str_lossy().into_owned()));
        if let Some(path) = index.path_of(meta.span.file_id) {
            files.insert(path.to_path_buf());
        }
    }
    for path in files {
        match file_facts(docs, &path).and_then(|f| f.evaluated.clone()) {
            Some(keys) => out.passed.extend(keys),
            None => out.sure = false,
        }
    }
    Some(out)
}

/// The names a resolver's `match` gives, if it's `return match ($parameterName) { 'a', 'b' => …, default =>
/// parent::…($parameterName) }` with only literal names.
fn resolver_arms(method: &str) -> Option<Vec<String>> {
    let wrapped = format!("<?php class TuskResolver {{\n{method}\n}}");
    let arena = LocalArena::new();
    let parsed = Parsed::exact(&arena, Path::new("resolver.php"), &wrapped);
    let mut found = None;
    walk(&parsed, |node, _| {
        let Node::Method(m) = node else { return };
        let mago_syntax::cst::MethodBody::Concrete(body) = &m.body else { return };
        let [mago_syntax::cst::Statement::Return(r)] = body.statements.as_slice() else { return };
        let Some(Expression::Match(mat)) = r.value else { return };
        let mut names = vec![];
        let mut delegates = false;
        for arm in mat.arms.iter() {
            match arm {
                mago_syntax::cst::MatchArm::Expression(e) => {
                    for c in e.conditions.iter() {
                        let Expression::Literal(Literal::String(s)) = c else { return };
                        names.push(wrapped[s.span.start.offset as usize + 1..s.span.end.offset as usize - 1].to_string());
                    }
                }
                mago_syntax::cst::MatchArm::Default(d) => {
                    let Expression::Call(mago_syntax::cst::Call::StaticMethod(s)) = d.expression else { return };
                    let method = &wrapped[s.method.span().start.offset as usize..s.method.span().end.offset as usize];
                    delegates = matches!(s.class, Expression::Parent(_)) && method == RESOLVER;
                }
            }
        }
        if delegates {
            found = Some(names);
        }
    });
    found
}

/// A closure passed to a method of a Filament class that evaluates it.
pub struct Site<'a> {
    /// The closure.
    pub value: &'a Expression<'a>,
    pub params: &'a FunctionLikeParameterList<'a>,
    /// The closure's span, and its body's.
    pub span: (u32, u32),
    pub body: (u32, u32),
    /// The method it's passed to.
    pub method: String,
    /// The class of the call's receiver: the class of the chain's `X::make()`, or of `$this` or a parameter it
    /// starts at.
    pub class: String,
    /// The class around the closure.
    pub enclosing: Option<String>,
    /// Whether it's inside the children of a layout or repeater with a `->relationship()`, whose records are the
    /// related ones.
    pub related: bool,
}

fn resolve(parsed: &Parsed<'_>, id: &mago_syntax::cst::Identifier<'_>) -> String {
    let fqn = match parsed.names.resolve(&id.span()) {
        Some(n) => String::from_utf8_lossy(n).into_owned(),
        None => resolve_class(&scope_at(parsed.program, id.span().start.offset), &String::from_utf8_lossy(id.value())),
    };
    fqn.trim_start_matches('\\').to_string()
}

fn enclosing_class(parsed: &Parsed<'_>, ancestors: &[Node<'_, '_>]) -> Option<String> {
    ancestors.iter().rev().find_map(|n| match n {
        Node::Class(c) => {
            let short = String::from_utf8_lossy(c.name.value);
            Some(resolve_class(&scope_at(parsed.program, c.span().start.offset), &short).trim_start_matches('\\').to_string())
        }
        _ => None,
    })
}

/// The class a call chain starts at: `X::make()`'s `X`, `$this`'s class, or a parameter's declared class.
fn chain_class(parsed: &Parsed<'_>, mut e: &Expression<'_>, ancestors: &[Node<'_, '_>]) -> Option<String> {
    loop {
        e = match e {
            Expression::Call(mago_syntax::cst::Call::Method(c)) => c.object,
            Expression::Call(mago_syntax::cst::Call::NullSafeMethod(c)) => c.object,
            Expression::Parenthesized(p) => p.expression,
            Expression::Call(mago_syntax::cst::Call::StaticMethod(s)) => {
                return match s.class {
                    Expression::Identifier(id) => Some(resolve(parsed, id)),
                    Expression::Static(_) | Expression::Self_(_) => enclosing_class(parsed, ancestors),
                    _ => None,
                };
            }
            Expression::Variable(mago_syntax::cst::Variable::Direct(v)) if v.name == b"$this" => return enclosing_class(parsed, ancestors),
            Expression::Variable(mago_syntax::cst::Variable::Direct(v)) => {
                // The innermost function-like that declares it as a typed parameter.
                return ancestors.iter().rev().find_map(|n| {
                    let list = match n {
                        Node::Method(m) => &m.parameter_list,
                        Node::Function(f) => &f.parameter_list,
                        Node::Closure(c) => &c.parameter_list,
                        Node::ArrowFunction(f) => &f.parameter_list,
                        _ => return None,
                    };
                    let p = list.parameters.iter().find(|p| p.variable.name == v.name)?;
                    match &p.hint {
                        Some(Hint::Identifier(id)) => Some(resolve(parsed, id)),
                        _ => None,
                    }
                });
            }
            _ => return None,
        };
    }
}

/// The methods whose arguments are a component's children.
const CHILDREN: &[&str] = &["schema", "components", "childComponents", "tabs", "steps", "form"];

/// The names of every call in the chain that `call` is part of.
fn chain_names(text: &str, call: &mago_syntax::cst::MethodCall<'_>, outer: &[Node<'_, '_>]) -> Vec<String> {
    let name = |s: mago_span::Span| text[s.start.offset as usize..s.end.offset as usize].to_string();
    let mut out = vec![name(call.method.span())];
    let mut e = call.object;
    while let Expression::Call(mago_syntax::cst::Call::Method(m)) = e {
        out.push(name(m.method.span()));
        e = m.object;
    }
    let mut current = call.span();
    for n in outer.iter().rev() {
        match n {
            Node::MethodCall(m) if m.object.span() == current => {
                out.push(name(m.method.span()));
                current = m.span();
            }
            n if n.span() == current => {}
            _ => break,
        }
    }
    out
}

/// Every closure in the file passed to a method of a Filament class that evaluates closures.
pub fn sites<'a>(parsed: &Parsed<'a>, index: &Index, docs: &Documents) -> Vec<Site<'a>> {
    let text = parsed.text();
    let mut out = vec![];
    walk(parsed, |node, ancestors| {
        let Node::MethodCall(call) = node else { return };
        for arg in call.argument_list.arguments.iter() {
            let value = match arg {
                Argument::Positional(p) => p.value,
                Argument::Named(n) => n.value,
            };
            let (params, body) = match value {
                Expression::Closure(c) => (&c.parameter_list, c.body.span()),
                Expression::ArrowFunction(f) => (&f.parameter_list, f.expression.span()),
                _ => continue,
            };
            let mut path = ancestors.to_vec();
            path.push(node);
            let Some(class) = chain_class(parsed, call.object, &path) else { continue };
            if injections(index, docs, &class).is_none() {
                continue;
            }
            // Inside the children of a chain with `->relationship()`.
            let related = path.iter().enumerate().any(|(i, n)| match n {
                Node::MethodCall(m) => {
                    let method = &text[m.method.span().start.offset as usize..m.method.span().end.offset as usize];
                    let inside = m.argument_list.span().start.offset <= value.span().start.offset && value.span().end.offset <= m.argument_list.span().end.offset;
                    inside && CHILDREN.contains(&method) && chain_names(text, m, &path[..i]).iter().any(|n| n == "relationship")
                }
                _ => false,
            });
            out.push(Site {
                value,
                params,
                span: (value.span().start.offset, value.span().end.offset),
                body: (body.start.offset, body.end.offset),
                method: text[call.method.span().start.offset as usize..call.method.span().end.offset as usize].to_string(),
                class,
                enclosing: enclosing_class(parsed, &path),
                related,
            });
        }
    });
    out
}

/// The first of `classes` the index has, by its declared name.
fn known(index: &Index, classes: &[&str]) -> Option<mago_word::Word> {
    classes.iter().find_map(|c| index.codebase.get_class_like(c.as_bytes()).map(|m| m.original_name))
}

fn object(name: mago_word::Word, nullable: bool) -> TUnion {
    let named = TAtomic::Object(TObject::Named(TNamedObject::new(name)));
    if nullable { TUnion::from_vec(vec![named, TAtomic::Null]) } else { TUnion::from_atomic(named) }
}

/// The model a closure's `$record` is, and whether Filament may pass `null` for it.
fn record(index: &Index, docs: &Documents, site: &Site<'_>, path: &Path) -> Option<(mago_word::Word, bool)> {
    if site.related {
        return None;
    }
    let cb = &index.codebase;
    let is = |c: &str, base: &str| cb.is_instance_of(c.as_bytes(), base.as_bytes());
    let enclosing = site.enclosing.as_deref();
    let model = match enclosing {
        Some(e) if is(e, "Filament\\Resources\\RelationManagers\\RelationManager") || is(e, "Filament\\Resources\\Pages\\ManageRelatedRecords") => {
            related_model(index, docs, e, path)
        }
        Some(e) if is(e, "Filament\\Resources\\Pages\\Page") => resource_model(index, docs, &class_facts(index, docs, e)?.classes.get("resource")?.clone()),
        Some(e) if super::is_resource_in(index, e) => resource_model(index, docs, e),
        // A Livewire component of its own, such as a custom page or a widget, has no resource's record.
        Some(e) if is(e, "Livewire\\Component") => None,
        _ => resource_model(index, docs, &resource_by_folder(index, path)?),
    }?;
    let word = cb.get_class_like(model.as_bytes()).filter(|_| is(&model, MODEL))?.original_name;
    let columns = ["Filament\\Tables\\Columns\\Column", "Filament\\Tables\\Columns\\Layout\\Component"];
    Some((word, !columns.iter().any(|c| is(&site.class, c))))
}

/// The model a resource names with `$model`.
pub fn resource_model(index: &Index, docs: &Documents, resource: &str) -> Option<String> {
    class_facts(index, docs, resource)?.classes.get("model").cloned()
}

/// The related model of a relation manager or a `ManageRelatedRecords` page: its `$relatedResource`'s model, or
/// the relationship it names on its resource's model.
fn related_model(index: &Index, docs: &Documents, class: &str, path: &Path) -> Option<String> {
    let facts = class_facts(index, docs, class)?;
    if let Some(resource) = facts.classes.get("relatedResource") {
        return resource_model(index, docs, resource);
    }
    let relationship = facts.strings.get("relationship")?;
    let owner = match facts.classes.get("resource") {
        Some(r) => r.clone(),
        None => resource_by_folder(index, path)?,
    };
    let model = resource_model(index, docs, &owner)?;
    class_facts(index, docs, &model)?.related.get(&relationship.to_ascii_lowercase()).cloned()
}

/// The resource a file in a resource's folder belongs to: the one `*Resource.php` in its folder or a folder above
/// it under `app/`, or the one named after the folder it's in, as `PostResource/Pages/…` is in Filament 3.
pub fn resource_by_folder(index: &Index, path: &Path) -> Option<String> {
    let app = index.config.root.join("app");
    let mut dir = path.parent()?.to_path_buf();
    let mut child: Option<String> = None;
    while dir.starts_with(&app) && dir != app {
        let candidates: Vec<&Path> =
            index.project_files().filter(|p| p.parent() == Some(dir.as_path()) && p.to_string_lossy().ends_with("Resource.php")).collect();
        let named = child.as_ref().and_then(|c| candidates.iter().find(|p| p.file_stem().is_some_and(|s| s.to_string_lossy() == *c)));
        let file = match (named, candidates.as_slice()) {
            (Some(file), _) => Some(*file),
            (None, [one]) => Some(*one),
            (None, []) => None,
            // Several resources side by side: none of them is surely this file's.
            _ => return None,
        };
        if let Some(file) = file {
            let id = crate::index::file_id(file);
            let class = index.codebase.class_likes.values().find(|c| c.span.file_id == id && super::is_resource_in(index, &c.original_name.as_str_lossy()))?;
            return Some(class.original_name.as_str_lossy().into_owned());
        }
        child = dir.file_name().map(|n| n.to_string_lossy().into_owned());
        dir = dir.parent()?.to_path_buf();
    }
    None
}

/// The type Filament gives an injected name in a closure at `site`, when it's known.
fn injected_type(index: &Index, docs: &Documents, site: &Site<'_>, path: &Path, name: &str, inj: &Injections) -> Option<(TUnion, bool)> {
    let cb = &index.codebase;
    if inj.identifier.as_deref() == Some(name) {
        return Some((object(cb.get_class_like(site.class.as_bytes())?.original_name, false), false));
    }
    if !inj.names.iter().any(|n| n == name) {
        return None;
    }
    Some(match name {
        "get" => (object(known(index, &["Filament\\Schemas\\Components\\Utilities\\Get", "Filament\\Forms\\Get"])?, false), false),
        "set" => (object(known(index, &["Filament\\Schemas\\Components\\Utilities\\Set", "Filament\\Forms\\Set"])?, false), false),
        "operation" | "context" => (mago_codex::ttype::get_string(), false),
        "table" => (object(known(index, &["Filament\\Tables\\Table"])?, false), false),
        "livewire" => {
            let e = site.enclosing.as_deref().filter(|e| cb.is_instance_of(e.as_bytes(), b"Livewire\\Component"))?;
            (object(cb.get_class_like(e.as_bytes())?.original_name, false), false)
        }
        "record" => {
            let (model, nullable) = record(index, docs, site, path)?;
            (object(model, nullable), nullable)
        }
        _ => return None,
    })
}

/// A parameter Filament injects that the analysis types.
pub struct Typed {
    /// The closure's body, and the functions in it with a variable of the name of their own.
    body: (u32, u32),
    holes: Vec<(u32, u32)>,
    /// The name, with `$`.
    name: Vec<u8>,
    ty: TUnion,
    /// Whether "possibly null" problems on it are dropped, since a form's `$record` is `null` only when creating.
    nullable: bool,
}

impl Typed {
    fn covers(&self, at: u32) -> bool {
        self.body.0 <= at && at < self.body.1 && !self.holes.iter().any(|(s, e)| *s <= at && at < *e)
    }
}

/// The functions inside a closure whose `name` isn't the closure's: those that declare a parameter of that name,
/// and closures that don't `use` it.
fn holes(closure: &Expression<'_>, name: &[u8]) -> Vec<(u32, u32)> {
    let mut out = vec![];
    let mut stack = vec![];
    // The closure's own node, then what's in it.
    Node::Expression(closure).visit_children(|own| own.visit_children(|c| stack.push(c)));
    while let Some(node) = stack.pop() {
        let declares = |list: &FunctionLikeParameterList<'_>| list.parameters.iter().any(|p| p.variable.name == name);
        let hole = match node {
            Node::ArrowFunction(f) => declares(&f.parameter_list),
            Node::Closure(c) => declares(&c.parameter_list) || !c.use_clause.as_ref().is_some_and(|u| u.variables.iter().any(|v| v.variable.name == name)),
            _ => false,
        };
        if hole {
            out.push((node.span().start.offset, node.span().end.offset));
        } else {
            node.visit_children(|c| stack.push(c));
        }
    }
    out
}

thread_local! {
    /// While a file is analyzed, the parameters [`ClosureHook`] types.
    static TYPED: RefCell<Vec<Typed>> = const { RefCell::new(vec![]) };
    /// The open documents, for reading the project's files as the editor has them.
    static DOCS: RefCell<Option<Documents>> = const { RefCell::new(None) };
}

/// Runs `f`, which analyzes files, reading files as `docs` has them.
pub fn with_docs<T>(docs: Documents, f: impl FnOnce() -> T) -> T {
    let outer = DOCS.replace(Some(docs));
    let out = f();
    DOCS.set(outer);
    out
}

/// Runs `f`, an analysis of `parsed`, with the untyped parameters of its Filament closures typed.
pub fn typing<T>(parsed: &Parsed<'_>, index: &Index, f: impl FnOnce() -> T) -> T {
    #[cfg(test)]
    let off = OFF.get();
    #[cfg(not(test))]
    let off = false;
    let typed = if !off && parsed.text().contains("Filament") {
        DOCS.with_borrow(|docs| {
            let default = Documents::default();
            param_types(parsed, index, docs.as_ref().unwrap_or(&default))
        })
    } else {
        vec![]
    };
    let outer = TYPED.replace(typed);
    let out = f();
    TYPED.set(outer);
    out
}

fn param_types(parsed: &Parsed<'_>, index: &Index, docs: &Documents) -> Vec<Typed> {
    let Some(path) = parsed.file.path.clone() else { return vec![] };
    let mut out = vec![];
    for site in sites(parsed, index, docs) {
        let Some(inj) = injections(index, docs, &site.class) else { continue };
        for p in site.params.parameters.iter() {
            if p.hint.is_some() || p.default_value.is_some() || p.ellipsis.is_some() || p.ampersand.is_some() {
                continue;
            }
            let name = String::from_utf8_lossy(&p.variable.name[1..]).into_owned();
            if let Some((t, nullable)) = injected_type(index, docs, &site, &path, &name, &inj) {
                out.push(Typed { body: site.body, holes: holes(site.value, p.variable.name), name: p.variable.name.to_vec(), ty: t, nullable });
            }
        }
    }
    out
}

/// Types the untyped parameters of closures that Filament injects, from [`typing`]: on the first expression of a
/// closure's body, each parameter that's still `mixed` gets the injected type.
pub struct ClosureHook;

impl Provider for ClosureHook {
    fn meta() -> &'static ProviderMeta {
        static META: ProviderMeta = ProviderMeta::new("tusk-filament-closures", "Filament closures", "Types the parameters Filament injects into closures.");
        &META
    }
}

impl ExpressionHook for ClosureHook {
    fn before_expression(&self, expr: &Expression<'_>, context: &mut HookContext<'_, '_>) -> HookResult<mago_analyzer::plugin::ExpressionHookResult> {
        let at = expr.span().start.offset;
        TYPED.with_borrow(|typed| {
            for t in typed.iter().filter(|t| t.covers(at)) {
                if context.get_variable_type(&t.name).is_some_and(|v| v.is_mixed()) {
                    context.set_variable_type(&t.name, t.ty.clone());
                }
            }
        });
        Ok(mago_analyzer::plugin::ExpressionHookResult::Continue)
    }
}

impl IssueFilterHook for ClosureHook {
    /// A form's `$record` is `null` only while creating, which a closure often can't be called in: "possibly null"
    /// problems on it aren't sure.
    fn filter_issue(&self, file: &File, issue: &Issue) -> HookResult<IssueFilterDecision> {
        if !issue.code.as_deref().is_some_and(|c| c.starts_with("possibly-null") || c == "possible-method-access-on-null") {
            return Ok(IssueFilterDecision::Keep);
        }
        let Some(span) = issue.annotations.iter().find(|a| a.kind == AnnotationKind::Primary).map(|a| a.span) else { return Ok(IssueFilterDecision::Keep) };
        let text = &file.contents[span.start.offset as usize..];
        let on_record = TYPED.with_borrow(|typed| {
            typed.iter().any(|t| {
                t.nullable && t.covers(span.start.offset) && text.starts_with(&t.name) && !text.get(t.name.len()).is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
            })
        });
        Ok(if on_record { IssueFilterDecision::Remove } else { IssueFilterDecision::Keep })
    }
}

/// The closure parameter being typed at `offset`, in `fn ($re|` or `function (Get $get, $|`: the closure's site
/// and the typed word's start.
fn param_at<'a>(ctx: &Ctx<'a>, parsed: &Parsed<'a>, offset: u32) -> Option<(Site<'a>, u32)> {
    let text = parsed.text();
    let before = text.get(..offset as usize)?;
    let word = before.len() - before.chars().rev().take_while(|c| c.is_alphanumeric() || *c == '_').map(char::len_utf8).sum::<usize>();
    let start = before[..word].strip_suffix('$').map(|b| b.len())?;
    let site = sites(parsed, &ctx.index, &ctx.snap.docs)
        .into_iter()
        .filter(|s| s.params.left_parenthesis.end.offset <= start as u32 && offset <= s.params.right_parenthesis.start.offset)
        .min_by_key(|s| s.span.1 - s.span.0)?;
    Some((site, start as u32))
}

/// Completion of the names Filament injects, typed as `$` in a closure's parameters.
pub fn completion(ctx: &Ctx<'_>, offset: u32) -> Option<Vec<CompletionItem>> {
    let before = ctx.doc.text.get(..offset as usize)?;
    let trimmed = before.trim_end_matches(|c: char| c.is_alphanumeric() || c == '_');
    if !trimmed.ends_with('$') {
        return None;
    }
    // An unfinished closure, such as `fn ($)`, doesn't parse: it's completed with a name and a body first.
    let text = &ctx.doc.text;
    let mut patched = text[..offset as usize].to_string();
    if before.ends_with('$') {
        patched.push('x');
    }
    let after = &text[offset as usize..];
    let close = after.find(')').unwrap_or(after.len());
    patched.push_str(&after[..close]);
    let rest = after[close..].strip_prefix(')').unwrap_or("");
    patched.push(')');
    if !["=>", "{", "use", ":"].iter().any(|t| rest.trim_start().starts_with(t)) {
        patched.push_str(" => null");
    }
    patched.push_str(rest);
    let arena = LocalArena::new();
    let full = Parsed::new(&arena, &ctx.doc.path, &patched);
    let (site, start) = param_at(ctx, &full, offset)?;
    let inj = injections(&ctx.index, &ctx.snap.docs, &site.class)?;
    let taken: Vec<String> = site.params.parameters.iter().map(|p| String::from_utf8_lossy(&p.variable.name[1..]).into_owned()).collect();
    let range = ctx.doc.range(start, offset);
    let short = site.class.rsplit('\\').next().unwrap_or(&site.class).to_string();
    let mut names: Vec<String> = inj.names.clone();
    names.extend(inj.identifier.clone());
    let items = names
        .into_iter()
        .enumerate()
        .filter(|(_, n)| !taken.contains(n))
        .map(|(i, name)| {
            let ty = injected_type(&ctx.index, &ctx.snap.docs, &site, &ctx.doc.path, &name, &inj).map(|(t, _)| crate::types::display(&t));
            let label = format!("${name}");
            CompletionItem {
                label: label.clone(),
                kind: Some(CompletionItemKind::VARIABLE),
                detail: Some(match ty {
                    Some(t) => format!("{t} · injected by {short}"),
                    None => format!("injected by {short}"),
                }),
                text_edit: Some(lsp_types::CompletionTextEdit::Edit(lsp_types::TextEdit { range, new_text: label })),
                sort_text: Some(format!("{:03}{name}", common(&name).unwrap_or(100 + i))),
                ..Default::default()
            }
        })
        .collect();
    Some(items)
}

/// The order the most used names come in, first.
fn common(name: &str) -> Option<usize> {
    ["record", "state", "get", "set", "livewire", "operation", "component", "data"].iter().position(|n| *n == name)
}

/// Whether a parameter hint lets PHP pass `null`: `?X`, a union with `null`, or `mixed`.
fn allows_null(hint: &Hint<'_>) -> bool {
    match hint {
        Hint::Nullable(_) | Hint::Null(_) | Hint::Mixed(_) => true,
        Hint::Parenthesized(p) => allows_null(p.hint),
        Hint::Union(u) => allows_null(u.left) || allows_null(u.right),
        _ => false,
    }
}

/// Whether a hint names a class Filament could resolve from Laravel's container, or the record by its model.
fn names_class(hint: &Hint<'_>) -> bool {
    matches!(hint, Hint::Identifier(_) | Hint::Self_(_) | Hint::Static(_) | Hint::Parent(_) | Hint::Intersection(_))
        || matches!(hint, Hint::Nullable(n) if names_class(n.hint))
        || matches!(hint, Hint::Parenthesized(p) if names_class(p.hint))
}

/// Parameters Filament surely can't inject, where it throws `BindingResolutionException`: a name its class doesn't
/// resolve or pass, without a class type the container could give, a default, or (in Filament 4 and later) a type
/// that allows `null`.
pub fn diagnostics(ctx: &Ctx<'_>) -> Vec<Diagnostic> {
    let text = ctx.parsed.text();
    if !text.contains("Filament") {
        return vec![];
    }
    let cb = &ctx.index.codebase;
    let mut out = vec![];
    for site in sites(&ctx.parsed, &ctx.index, &ctx.snap.docs) {
        if !EVALUATED.contains(&site.method.as_str()) {
            continue;
        }
        // The method must be Filament's own, which these keep and evaluate.
        let declared = cb.get_declaring_method_class(site.class.as_bytes(), site.method.as_bytes()).map(|w| w.as_str_lossy().to_ascii_lowercase());
        if !declared.is_some_and(|d| d.starts_with("filament\\")) {
            continue;
        }
        let Some(inj) = injections(&ctx.index, &ctx.snap.docs, &site.class) else { continue };
        if !inj.sure {
            continue;
        }
        for p in site.params.parameters.iter() {
            let name = String::from_utf8_lossy(&p.variable.name[1..]).into_owned();
            if inj.injects(&name) || p.default_value.is_some() || p.ellipsis.is_some() {
                continue;
            }
            let throws = match &p.hint {
                None => !inj.nulls,
                Some(h) if names_class(h) => false,
                Some(h) => !inj.nulls || !allows_null(h),
            };
            if !throws {
                continue;
            }
            let short = site.class.rsplit('\\').next().unwrap_or(&site.class);
            let mut names: Vec<String> = inj.names.iter().map(|n| format!("`${n}`")).collect();
            names.extend(inj.identifier.iter().map(|n| format!("`${n}`")));
            out.push(Diagnostic {
                range: ctx.doc.range(p.variable.span.start.offset, p.variable.span.end.offset),
                severity: Some(DiagnosticSeverity::WARNING),
                code: Some(NumberOrString::String("filament-closure-parameter".into())),
                source: Some("filament".into()),
                message: format!(
                    "Filament can't inject `${name}` into {short}'s `{}()` closure, so it throws a BindingResolutionException when it calls it. {short} injects {}.",
                    site.method,
                    names.join(", ")
                ),
                ..Default::default()
            });
        }
    }
    out
}

#[cfg(test)]
thread_local! {
    /// Turns typing off, to compare the analysis with and without it.
    static OFF: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::with_ctx;
    use crate::testing::on_server_stack;
    use crate::text::path_to_uri;

    /// Filament's closure evaluation as Filament 4 writes it, cut down: a schema component and a table column with
    /// their resolvers, and a resource with a relation manager.
    const FILAMENT: &str = r#"<?php
namespace Filament\Support\Concerns {
    trait EvaluatesClosures {
        protected string $evaluationIdentifier;
        public function evaluate(mixed $value, array $namedInjections = [], array $typedInjections = []): mixed { return $value; }
        protected function resolveClosureDependencyForEvaluation($parameter, array $namedInjections, array $typedInjections): mixed
        {
            if ($parameter->isOptional() || $parameter->allowsNull()) { return null; }
            throw new \Exception();
        }
        protected function resolveDefaultClosureDependencyForEvaluationByName(string $parameterName): array { return []; }
    }
}
namespace Filament\Schemas\Components\Utilities { class Get {} class Set {} }
namespace Filament\Support\Components { abstract class Component { use \Filament\Support\Concerns\EvaluatesClosures; } }
namespace Filament\Schemas\Components {
    class Component extends \Filament\Support\Components\Component {
        protected string $evaluationIdentifier = 'component';
        protected $isVisible;
        protected array $afterStateUpdated = [];
        public static function make(?string $name = null): static { return new static; }
        public function visible($condition): static { $this->isVisible = $condition; return $this; }
        public function schema(array $components): static { return $this; }
        public function relationship(?string $name = null): static { return $this; }
        public function action($action): static { return $this; }
        public function afterStateUpdated($callback): static { $this->afterStateUpdated[] = $callback; return $this; }
        public function callAfterStateUpdated(): void { foreach ($this->afterStateUpdated as $callback) { $this->evaluate($callback, ['old' => 1]); } }
        protected function resolveDefaultClosureDependencyForEvaluationByName(string $parameterName): array
        {
            return match ($parameterName) {
                'context', 'operation' => [1],
                'get' => [1],
                'livewire' => [1],
                'record' => [1],
                'set' => [1],
                'state' => [1],
                default => parent::resolveDefaultClosureDependencyForEvaluationByName($parameterName),
            };
        }
    }
    class Section extends Component {}
}
namespace Filament\Forms\Components { class TextInput extends \Filament\Schemas\Components\Component {} class Repeater extends \Filament\Schemas\Components\Component {} }
namespace Filament\Tables\Columns {
    class Column extends \Filament\Support\Components\Component {
        protected string $evaluationIdentifier = 'column';
        protected $url;
        public static function make(string $name): static { return new static; }
        public function url($url): static { $this->url = $url; return $this; }
        public function getUrl(): ?string { return $this->evaluate($this->url); }
        protected function resolveDefaultClosureDependencyForEvaluationByName(string $parameterName): array
        {
            return match ($parameterName) {
                'livewire' => [1],
                'record' => [1],
                'rowLoop' => [1],
                'state' => [1],
                'table' => [1],
                default => parent::resolveDefaultClosureDependencyForEvaluationByName($parameterName),
            };
        }
    }
    class TextColumn extends Column {}
}
namespace Filament\Tables { class Table { public function columns(array $columns): static { return $this; } } }
namespace Filament\Resources { abstract class Resource {} }
namespace Filament\Resources\RelationManagers { abstract class RelationManager extends \Livewire\Component {} }
namespace Filament\Resources\Pages { abstract class Page extends \Livewire\Component {} class EditRecord extends Page {} }
namespace Livewire { abstract class Component {} }
"#;

    const POST: &str = "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Post extends Model\n{\n    public int $id = 0;\n    public function comments() { return $this->hasMany(Comment::class); }\n}\n";
    const COMMENT: &str = "<?php\nnamespace App\\Models;\nclass Comment extends \\Illuminate\\Database\\Eloquent\\Model { public string $body = ''; }\n";
    const RESOURCE: &str = "<?php\nnamespace App\\Filament\\Resources\\Posts;\nuse App\\Models\\Post;\nuse Filament\\Resources\\Resource;\nclass PostResource extends Resource\n{\n    protected static ?string $model = Post::class;\n    public static function getPages(): array\n    {\n        return ['index' => Pages\\ListPosts::route('/'), 'edit' => Pages\\EditPost::route('/{record}/edit')];\n    }\n}\n";

    /// A Post resource, with `body` as the code of its table's or form's `configure()`.
    fn fixture(file: &str, body: &str, filament: &str) -> crate::testing::Fixture {
        let class = format!(
            "<?php\nnamespace App\\Filament\\Resources\\Posts\\Schemas;\nuse Filament\\Forms\\Components\\TextInput;\nuse Filament\\Forms\\Components\\Repeater;\nuse Filament\\Schemas\\Components\\Section;\nuse Filament\\Tables\\Columns\\TextColumn;\nclass PostForm\n{{\n    public static function configure($schema)\n    {{\n        return $schema->components([\n            {body}\n        ]);\n    }}\n}}\n"
        );
        crate::testing::Fixture::new(&[
            crate::testing::ELOQUENT,
            ("vendor/filament.php", filament),
            ("app/Models/Post.php", POST),
            ("app/Models/Comment.php", COMMENT),
            ("app/Filament/Resources/Posts/PostResource.php", RESOURCE),
            (file, &class),
        ])
    }

    const FORM: &str = "app/Filament/Resources/Posts/Schemas/PostForm.php";

    /// The type the analysis gives the expression at the first `needle` in the form.
    fn type_at(body: &str, needle: &str) -> Option<String> {
        let fx = fixture(FORM, body, FILAMENT);
        with_ctx(&fx.snap, &crate::testing::uri(FORM), |ctx| {
            let at = ctx.doc.text.find(needle).unwrap() + needle.find('$').unwrap();
            let len = 1 + ctx.doc.text[at + 1..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').count();
            ctx.analysis().type_of(at as u32, (at + len) as u32).map(|t| crate::types::display(&t))
        })
        .unwrap()
    }

    #[test]
    fn types_the_parameters_filament_injects() {
        on_server_stack(|| {
            assert_eq!(type_at("TextColumn::make('title')->url(fn ($record) => $record->id)", "$record->"), Some("App\\Models\\Post".into()));
            assert_eq!(type_at("TextInput::make('title')->visible(fn ($record) => $record?->id)", "$record?"), Some("App\\Models\\Post|null".into()));
            assert_eq!(type_at("TextInput::make('title')->visible(function ($get) { return $get; })", "$get;"), Some("Filament\\Schemas\\Components\\Utilities\\Get".into()));
            assert_eq!(type_at("TextColumn::make('title')->url(fn ($column) => $column)", "=> $column"), Some("Filament\\Tables\\Columns\\TextColumn".into()));
            // A relationship's children get its records, and a typed parameter keeps its type.
            assert_eq!(type_at("Repeater::make('comments')->relationship()->schema([TextInput::make('body')->visible(fn ($record) => $record)])", "=> $record"), Some("mixed".into()));
            assert_eq!(type_at("TextColumn::make('title')->url(fn (int $record) => $record)", "=> $record"), Some("int".into()));
            // A function inside with a `$record` of its own keeps it.
            assert_eq!(type_at("TextColumn::make('title')->url(fn ($record) => array_map(fn ($record) => $record, []))", "=> $record,"), Some("mixed".into()));
            assert_eq!(type_at("TextColumn::make('title')->url(fn ($record) => fn () => $record)", "=> $record)"), Some("App\\Models\\Post".into()));
            // A name the class doesn't inject stays as it is.
            assert_eq!(type_at("TextColumn::make('title')->url(fn ($get) => $get)", "=> $get"), Some("mixed".into()));
        });
    }

    #[test]
    fn types_a_relation_managers_record_and_livewire() {
        on_server_stack(|| {
            let file = "app/Filament/Resources/Posts/RelationManagers/CommentsRelationManager.php";
            let manager = "<?php\nnamespace App\\Filament\\Resources\\Posts\\RelationManagers;\nuse Filament\\Tables\\Columns\\TextColumn;\nclass CommentsRelationManager extends \\Filament\\Resources\\RelationManagers\\RelationManager\n{\n    protected static string $relationship = 'comments';\n    public function table($table)\n    {\n        return $table->columns([TextColumn::make('body')->url(fn ($record, $livewire) => [$record, $livewire])]);\n    }\n}\n";
            let fx = crate::testing::Fixture::new(&[
                crate::testing::ELOQUENT,
                ("vendor/filament.php", FILAMENT),
                ("app/Models/Post.php", POST),
                ("app/Models/Comment.php", COMMENT),
                ("app/Filament/Resources/Posts/PostResource.php", RESOURCE),
                (file, manager),
            ]);
            let types = with_ctx(&fx.snap, &crate::testing::uri(file), |ctx| {
                ["[$record", "$livewire]"].map(|n| {
                    let at = (ctx.doc.text.find(n).unwrap() + n.find('$').unwrap()) as u32;
                    let len = n.trim_matches(['[', ']']).len() as u32;
                    ctx.analysis().type_of(at, at + len).map(|t| crate::types::display(&t))
                })
            })
            .unwrap();
            assert_eq!(types, [Some("App\\Models\\Comment".into()), Some("App\\Filament\\Resources\\Posts\\RelationManagers\\CommentsRelationManager".into())]);
        });
    }

    #[test]
    fn drops_possibly_null_problems_on_a_forms_record() {
        on_server_stack(|| {
            let fx = fixture(FORM, "TextInput::make('title')->visible(fn ($record) => $record->id > 1)", FILAMENT);
            let codes = with_ctx(&fx.snap, &crate::testing::uri(FORM), |ctx| ctx.analysis().issues.iter().filter_map(|i| i.code.clone()).collect::<Vec<_>>()).unwrap();
            assert!(!codes.iter().any(|c| c.starts_with("possibly-null")), "{codes:?}");
        });
    }

    fn complete(body: &str) -> Vec<(String, String)> {
        let fx = fixture(FORM, body, FILAMENT);
        let at = fx.at();
        crate::features::with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| completion(ctx, ctx.offset(at.position)))
            .flatten()
            .unwrap_or_default()
            .into_iter()
            .map(|i| (i.label, i.detail.unwrap_or_default()))
            .collect()
    }

    #[test]
    fn completes_the_names_a_class_injects() {
        on_server_stack(|| {
            let items = complete("TextColumn::make('title')->url(fn ($<|>)");
            let labels: Vec<&str> = items.iter().map(|(l, _)| l.as_str()).collect();
            assert_eq!(labels, vec!["$livewire", "$record", "$rowLoop", "$state", "$table", "$column"]);
            assert_eq!(items[1].1, "App\\Models\\Post · injected by TextColumn");
            let items = complete("TextInput::make('title')->visible(fn (Get $get, $re<|>) => 1)");
            assert!(items.iter().any(|(l, d)| l == "$record" && d.starts_with("App\\Models\\Post|null")), "{items:?}");
            assert!(!items.iter().any(|(l, _)| l == "$get"));
            // Not in a closure's parameters, or on something that isn't Filament's.
            assert!(complete("TextInput::make('title')->visible(fn ($record) => $<|>)").is_empty());
            assert!(complete("collect()->map(fn ($<|>)").is_empty());
        });
    }

    fn problems(body: &str, filament: &str) -> Vec<String> {
        let fx = fixture(FORM, body, filament);
        with_ctx(&fx.snap, &crate::testing::uri(FORM), diagnostics).unwrap().into_iter().map(|d| d.message).collect()
    }

    #[test]
    fn reports_parameters_filament_cant_inject() {
        on_server_stack(|| {
            let found = problems("TextColumn::make('title')->url(fn (string $page) => $page)", FILAMENT);
            assert_eq!(found.len(), 1, "{found:?}");
            assert!(found[0].starts_with("Filament can't inject `$page` into TextColumn's `url()` closure"), "{}", found[0]);
            assert!(found[0].ends_with("TextColumn injects `$livewire`, `$record`, `$rowLoop`, `$state`, `$table`, `$column`."), "{}", found[0]);
            // What Filament 4 resolves: injected names, passed ones, a class, a default, `null`, an untyped name.
            for ok in [
                "TextColumn::make('t')->url(fn (string $state, $record, ?string $page, \\App\\Models\\Post $post, int $n = 1, mixed $m, $x) => 1)",
                "TextInput::make('t')->afterStateUpdated(fn (string $old) => 1)",
                "TextInput::make('t')->visible(fn (string $context) => 1)",
                // A method the component may not evaluate itself.
                "TextInput::make('t')->action(fn (string $page) => 1)",
            ] {
                assert!(problems(ok, FILAMENT).is_empty(), "{ok}");
            }
            // Filament 3 throws for an untyped name or a type that allows `null` too.
            let v3 = FILAMENT.replace("$parameter->allowsNull()", "false");
            assert_eq!(problems("TextColumn::make('t')->url(fn ($page, ?string $other, $record) => 1)", &v3).len(), 2);
            // A resolver Tusk can't read in full is never sure.
            let open = FILAMENT.replace("'rowLoop' => [1],", "$this->name => [1],");
            assert!(problems("TextColumn::make('t')->url(fn (string $page) => 1)", &open).is_empty());
        });
    }

    /// Prints what each common Filament class injects in a real app, then every closure problem in it and every
    /// analysis problem the typing adds or removes, which should all be real: `TUSK_FILAMENT_APP=<root> cargo test
    /// -- --ignored --nocapture closures_in_a_real_app`.
    #[test]
    #[ignore]
    fn closures_in_a_real_app() {
        use crate::documents::{Document, Documents};
        use crate::index::{Index, IndexConfig};
        use crate::server::Snapshot;
        let Ok(root) = std::env::var("TUSK_FILAMENT_APP") else { return };
        let root = PathBuf::from(root);
        on_server_stack(|| {
            let mut index = Index::empty(IndexConfig::new(&root));
            let paths = index.discover();
            index.build(paths, |p| std::fs::read(p).ok(), |_, _| {});
            let index = Arc::new(parking_lot::RwLock::new(index));
            let framework = Arc::new(crate::framework::State::new(root.clone()));
            {
                let index = index.read();
                for class in [
                    "Filament\\Forms\\Components\\TextInput",
                    "Filament\\Forms\\Components\\Select",
                    "Filament\\Tables\\Columns\\TextColumn",
                    "Filament\\Actions\\Action",
                    "Filament\\Tables\\Table",
                    "Filament\\Schemas\\Components\\Section",
                    "Filament\\Infolists\\Components\\TextEntry",
                    "Filament\\Tables\\Filters\\SelectFilter",
                ] {
                    eprintln!("{class}: {:?}", injections(&index, &Documents::default(), class));
                }
            }
            let files: Vec<PathBuf> = index.read().files.values().map(|f| f.path.clone()).filter(|p| p.starts_with(root.join("app"))).collect();
            let (mut scanned, mut problems, mut typed, mut baseline, mut contexts, mut from_db) = (0, 0, 0, 0, 0, 0);
            let mut slowest = std::time::Duration::ZERO;
            for path in files {
                let text = std::fs::read_to_string(&path).unwrap();
                if !text.contains("Filament") {
                    continue;
                }
                scanned += 1;
                let mut docs = Documents::default();
                docs.insert(Document::new(path_to_uri(&path), path.clone(), "php".into(), 1, text.clone()));
                let snap = Snapshot { docs, index: index.clone(), root: root.clone(), framework: framework.clone(), client: None, cancel: Default::default() };
                let rel = path.strip_prefix(&root).unwrap().display().to_string();
                with_ctx(&snap, &path_to_uri(&path), |ctx| {
                    // Every Filament problem, these and the others, which should all be real.
                    for d in super::super::diagnostics(ctx) {
                        problems += 1;
                        eprintln!("problem {rel}:{} {:?} {}", d.range.start.line + 1, d.code, d.message);
                    }
                    if let Some(c) = super::super::context(ctx) {
                        contexts += 1;
                        from_db += usize::from(c["model"]["columnsGuessed"] == false);
                    }
                    let started = std::time::Instant::now();
                    typed += param_types(&ctx.parsed, &ctx.index, &ctx.snap.docs).len();
                    diagnostics(ctx);
                    slowest = slowest.max(started.elapsed());
                    let issues = |off: bool| -> Vec<String> {
                        OFF.set(off);
                        let a = crate::analysis::analyze(&ctx.parsed, ctx.arena, &ctx.index);
                        OFF.set(false);
                        a.issues.iter().map(|i| format!("{}:{} {}", ctx.doc.position(i.annotations.first().map_or(0, |a| a.span.start.offset)).line + 1, i.code.clone().unwrap_or_default(), i.message)).collect()
                    };
                    let (on, off) = (issues(false), issues(true));
                    baseline += off.iter().filter(|i| i.contains("non-documented-property")).count();
                    for i in on.iter().filter(|i| !off.contains(i)) {
                        eprintln!("added {rel}:{i}");
                    }
                    for i in off.iter().filter(|i| !on.contains(i)) {
                        eprintln!("removed {rel}:{i}");
                    }
                });
            }
            eprintln!("{scanned} files, {typed} parameters typed, {problems} closure problems, {baseline} non-documented-property problems without typing, {contexts} files with a resource, {from_db} with columns from the database, typing and checking closures took at most {slowest:?} a file");
        });
    }
}
