//! Laravel and Filament: features on the strings passed to framework calls (`route('home')`,
//! `->relationship('author')`), fed by facts about the running app that PHP scripts report.

pub mod filament;
pub mod icons;
pub mod laravel;
pub mod php;
pub mod values;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use lsp_types::{CodeLens, CompletionItem, Diagnostic, DocumentLink, Hover, Location};
use mago_span::HasSpan;
use mago_syntax::cst::{Argument, Expression, LiteralStringKind, Node, PartialArgument};
use parking_lot::Mutex;
use serde_json::Value;

use crate::features::Ctx;
use crate::locate::walk;
use crate::symbol::Symbol;

/// What kind of call a string is passed to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallKind {
    /// `route('home')`
    Function,
    /// `$request->routeIs('home')`
    Method,
    /// `Route::has('home')`
    Static,
    /// `new Content(view: 'mail')`
    New,
    /// `#[Config('app.name')]`
    Attribute,
    /// `$get('field')`, a closure in a variable. `name` holds the variable, such as `$get`.
    Closure,
}

/// The call a string is an argument of.
#[derive(Debug, Clone)]
pub struct Call {
    pub kind: CallKind,
    /// The function's resolved name, the method's name, or the variable for a closure. Empty for `new` and
    /// attributes.
    pub name: String,
    /// The classes the call is on: the receiver's inferred classes, the class of a static call, or the class
    /// being created. Empty for functions.
    pub classes: Vec<String>,
    /// Each argument's name if named, and its value if it's a plain string.
    pub arguments: Vec<(Option<String>, Option<String>)>,
    /// The classes each argument names or holds: `Post::class` names `Post`, and `$post` holds its inferred
    /// type. An array argument counts as its first element.
    pub argument_classes: Vec<Vec<String>>,
    /// The classes in the receiver type's type arguments, such as `User` for `Builder<User>` or `Post` for
    /// `HasMany<Post, User>`, in order.
    pub type_args: Vec<String>,
    /// The span of the whole call.
    pub span: (u32, u32),
}

impl Call {
    /// Whether the call is on one of `classes` or a subclass of one.
    pub fn on(&self, codebase: &mago_codex::metadata::CodebaseMetadata, classes: &[&str]) -> bool {
        self.classes.iter().any(|c| {
            classes.iter().any(|want| c.eq_ignore_ascii_case(want) || codebase.is_instance_of(c.as_bytes(), want.as_bytes()))
        })
    }

    pub fn is_method(&self, names: &[&str]) -> bool {
        matches!(self.kind, CallKind::Method | CallKind::Static) && names.iter().any(|n| n.eq_ignore_ascii_case(&self.name))
    }

    pub fn is_function(&self, names: &[&str]) -> bool {
        self.kind == CallKind::Function && names.iter().any(|n| n.eq_ignore_ascii_case(&self.name))
    }
}

/// Where in an array argument a string sits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InArray {
    Key,
    /// A value, with its key when that's a plain string.
    Value(Option<String>),
}

/// A string literal passed to a call, directly or inside an array argument.
#[derive(Debug, Clone)]
pub struct StringArg {
    /// The contents, without quotes. Escapes are left as written.
    pub value: String,
    /// The span of the contents, without the quotes.
    pub start: u32,
    pub end: u32,
    pub double_quoted: bool,
    pub call: Call,
    /// The argument's position.
    pub index: usize,
    /// The argument's name, if it's named.
    pub name: Option<String>,
    pub in_array: Option<InArray>,
}

fn text_of(ctx: &Ctx<'_>, span: (u32, u32)) -> String {
    ctx.parsed.text()[span.0 as usize..span.1 as usize].to_string()
}

fn plain_string(ctx: &Ctx<'_>, expr: &Expression<'_>) -> Option<String> {
    let Expression::Literal(mago_syntax::cst::Literal::String(s)) = expr else { return None };
    let (start, end) = (s.span.start.offset + 1, s.span.end.offset.saturating_sub(1));
    (start <= end).then(|| text_of(ctx, (start, end)))
}

/// Describes the call node `node`, if it's one.
pub(crate) fn call_of(ctx: &Ctx<'_>, node: &Node<'_, '_>, path: &[Node<'_, '_>]) -> Option<Call> {
    let resolver = ctx.resolver();
    let span = (node.span().start.offset, node.span().end.offset);
    let args = |list: &mago_syntax::cst::ArgumentList<'_>| -> Vec<(Option<String>, Option<String>)> {
        list.arguments
            .iter()
            .map(|a| match a {
                Argument::Positional(p) => (None, plain_string(ctx, p.value)),
                Argument::Named(n) => (Some(String::from_utf8_lossy(n.name.value).into_owned()), plain_string(ctx, n.value)),
            })
            .collect()
    };
    let name_of = |selector: &mago_syntax::cst::ClassLikeMemberSelector<'_>| text_of(ctx, (selector.span().start.offset, selector.span().end.offset));
    let arg_classes = |list: &mago_syntax::cst::ArgumentList<'_>| -> Vec<Vec<String>> {
        list.arguments
            .iter()
            .map(|a| match a {
                Argument::Positional(p) => expression_classes(ctx, p.value, path),
                Argument::Named(n) => expression_classes(ctx, n.value, path),
            })
            .collect()
    };
    let method = |object: &Expression<'_>, selector: &mago_syntax::cst::ClassLikeMemberSelector<'_>, list: &mago_syntax::cst::ArgumentList<'_>| {
        let (classes, type_args) = receiver(ctx, object, path);
        Call { kind: CallKind::Method, name: name_of(selector), classes, arguments: args(list), argument_classes: arg_classes(list), type_args, span }
    };
    Some(match node {
        Node::FunctionCall(c) => {
            if let Expression::Variable(v) = c.function {
                let var = text_of(ctx, (v.span().start.offset, v.span().end.offset));
                return Some(Call {
                    kind: CallKind::Closure,
                    name: var,
                    classes: vec![],
                    arguments: args(&c.argument_list),
                    argument_classes: arg_classes(&c.argument_list),
                    type_args: vec![],
                    span,
                });
            }
            let at = c.function.span().end.offset.saturating_sub(1);
            let name = match resolver.at(at)?.symbols.into_iter().next()? {
                Symbol::Function(f) => f,
                _ => return None,
            };
            Call { kind: CallKind::Function, name, classes: vec![], arguments: args(&c.argument_list), argument_classes: arg_classes(&c.argument_list), type_args: vec![], span }
        }
        Node::MethodCall(c) => method(c.object, &c.method, &c.argument_list),
        Node::NullSafeMethodCall(c) => method(c.object, &c.method, &c.argument_list),
        Node::StaticMethodCall(c) => Call {
            kind: CallKind::Static,
            name: name_of(&c.method),
            classes: resolver.classes_of_class_expr(c.class, path),
            arguments: args(&c.argument_list),
            argument_classes: arg_classes(&c.argument_list),
            type_args: vec![],
            span,
        },
        Node::Instantiation(i) => Call {
            kind: CallKind::New,
            name: String::new(),
            classes: resolver.classes_of_class_expr(i.class, path),
            arguments: i.argument_list.as_ref().map(args).unwrap_or_default(),
            argument_classes: i.argument_list.as_ref().map(arg_classes).unwrap_or_default(),
            type_args: vec![],
            span,
        },
        Node::Attribute(a) => {
            let fqn = ctx.parsed.names.resolve(&a.name.span()).map(|n| String::from_utf8_lossy(n).into_owned())?;
            let arguments = a
                .argument_list
                .as_ref()
                .map(|l| {
                    l.arguments
                        .iter()
                        .map(|a| match a {
                            PartialArgument::Positional(p) => (None, plain_string(ctx, p.value)),
                            PartialArgument::Named(n) => (Some(String::from_utf8_lossy(n.name.value).into_owned()), plain_string(ctx, n.value)),
                            _ => (None, None),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let argument_classes = a
                .argument_list
                .as_ref()
                .map(|l| {
                    l.arguments
                        .iter()
                        .map(|a| match a {
                            PartialArgument::Positional(p) => expression_classes(ctx, p.value, path),
                            PartialArgument::Named(n) => expression_classes(ctx, n.value, path),
                            _ => vec![],
                        })
                        .collect()
                })
                .unwrap_or_default();
            Call { kind: CallKind::Attribute, name: String::new(), classes: vec![fqn], arguments, argument_classes, type_args: vec![], span }
        }
        _ => return None,
    })
}

/// The classes a method call's receiver can be, and the classes in its type's type arguments. A receiver the
/// analyzer can't type, such as the result of a static call Laravel forwards through `__callStatic`
/// (`User::where(...)->orderBy(...)`), counts as the class at the root of its chain, as Laravel LSP reads it.
fn receiver(ctx: &Ctx<'_>, object: &Expression<'_>, path: &[Node<'_, '_>]) -> (Vec<String>, Vec<String>) {
    let resolver = ctx.resolver();
    let classes = resolver.classes_of(object);
    if !classes.is_empty() {
        return (classes, type_arguments(ctx, object));
    }
    let mut expr = object;
    loop {
        expr = match expr {
            Expression::Call(mago_syntax::cst::Call::Method(c)) => c.object,
            Expression::Call(mago_syntax::cst::Call::NullSafeMethod(c)) => c.object,
            Expression::Call(mago_syntax::cst::Call::StaticMethod(c)) => return (resolver.classes_of_class_expr(c.class, path), vec![]),
            Expression::Parenthesized(p) => p.expression,
            _ => return (vec![], vec![]),
        };
        let classes = resolver.classes_of(expr);
        if !classes.is_empty() {
            return (classes, type_arguments(ctx, expr));
        }
    }
}

/// The classes in the type arguments of an expression's type, such as `User` in `Builder<User>`.
fn type_arguments(ctx: &Ctx<'_>, expr: &Expression<'_>) -> Vec<String> {
    use mago_codex::ttype::atomic::TAtomic;
    use mago_codex::ttype::atomic::object::TObject;
    let span = expr.span();
    let Some(t) = ctx.analysis().type_of(span.start.offset, span.end.offset) else { return vec![] };
    let codebase = &ctx.index.codebase;
    let mut out: Vec<String> = vec![];
    for atomic in t.types.iter() {
        let TAtomic::Object(TObject::Named(named)) = atomic else { continue };
        for param in named.type_parameters.iter().flatten() {
            for class in crate::types::class_names(param, codebase) {
                if !out.contains(&class) {
                    out.push(class);
                }
            }
        }
    }
    out
}

/// The classes an argument names (`Post::class`) or holds (`$post`), or its first element's for an array.
fn expression_classes(ctx: &Ctx<'_>, expr: &Expression<'_>, path: &[Node<'_, '_>]) -> Vec<String> {
    match expr {
        Expression::Access(mago_syntax::cst::Access::ClassConstant(a))
            if matches!(&a.constant, mago_syntax::cst::ClassLikeConstantSelector::Identifier(id) if id.value.eq_ignore_ascii_case(b"class")) =>
        {
            ctx.resolver().classes_of_class_expr(a.class, path)
        }
        Expression::Array(a) => match a.elements.iter().next() {
            Some(mago_syntax::cst::ArrayElement::Value(v)) => expression_classes(ctx, v.value, path),
            Some(mago_syntax::cst::ArrayElement::KeyValue(kv)) => expression_classes(ctx, kv.value, path),
            _ => vec![],
        },
        Expression::Literal(_) => vec![],
        other => ctx.resolver().classes_of(other),
    }
}

/// The string argument a string literal at the end of `path` is, if any.
fn string_arg(ctx: &Ctx<'_>, path: &[Node<'_, '_>], literal: &mago_syntax::cst::LiteralString<'_>) -> Option<StringArg> {
    let (start, end) = (literal.span.start.offset + 1, literal.span.end.offset.saturating_sub(1).max(literal.span.start.offset + 1));
    let mut in_array = None;
    let mut i = path.len();
    // Climb from the literal to the argument that holds it, noting an array on the way.
    while i > 0 {
        i -= 1;
        match &path[i] {
            Node::Expression(_) | Node::Literal(_) | Node::LiteralString(_) => {}
            Node::KeyValueArrayElement(el) if in_array.is_none() => {
                in_array = Some(if el.key.span().start.offset <= literal.span.start.offset && literal.span.end.offset <= el.key.span().end.offset {
                    InArray::Key
                } else {
                    InArray::Value(plain_string(ctx, el.key))
                });
            }
            Node::ValueArrayElement(_) if in_array.is_none() => in_array = Some(InArray::Value(None)),
            Node::ArrayElement(_) | Node::Array(_) | Node::LegacyArray(_) => {}
            Node::PositionalArgument(_) | Node::NamedArgument(_) | Node::Argument(_) | Node::PartialArgument(_) => {}
            Node::ArgumentList(_) | Node::PartialArgumentList(_) => {
                let (call, index, name) = argument(ctx, path, i)?;
                return Some(StringArg {
                    value: text_of(ctx, (start, end)),
                    start,
                    end,
                    double_quoted: literal.kind == LiteralStringKind::DoubleQuoted,
                    call,
                    index,
                    name,
                    in_array,
                });
            }
            _ => return None,
        }
    }
    None
}

/// The call whose argument list is `path[i]`, and the position and name of the argument at `path[i + 1]`.
pub(crate) fn argument(ctx: &Ctx<'_>, path: &[Node<'_, '_>], i: usize) -> Option<(Call, usize, Option<String>)> {
    let call_node = path[..i].iter().rev().find(|n| {
        matches!(n, Node::FunctionCall(_) | Node::MethodCall(_) | Node::NullSafeMethodCall(_) | Node::StaticMethodCall(_) | Node::Instantiation(_) | Node::Attribute(_))
    })?;
    let call = call_of(ctx, call_node, &path[..i])?;
    // The argument's position: count arguments that start before the literal's argument.
    let arg_node = path.get(i + 1)?;
    let arg_start = arg_node.span().start.offset;
    let index = match &path[i] {
        Node::ArgumentList(l) => l.arguments.iter().take_while(|a| a.span().start.offset < arg_start).count(),
        Node::PartialArgumentList(l) => l.arguments.iter().take_while(|a| a.span().start.offset < arg_start).count(),
        _ => 0,
    };
    let name = match arg_node {
        Node::Argument(Argument::Named(n)) => Some(String::from_utf8_lossy(n.name.value).into_owned()),
        Node::NamedArgument(n) => Some(String::from_utf8_lossy(n.name.value).into_owned()),
        _ => None,
    };
    Some((call, index, name))
}

/// Every string argument in the file.
pub fn string_args(ctx: &Ctx<'_>) -> Vec<StringArg> {
    let mut out = vec![];
    walk(&ctx.parsed, |node, ancestors| {
        if let Node::LiteralString(literal) = node {
            let mut path = ancestors.to_vec();
            path.push(node);
            if let Some(arg) = string_arg(ctx, &path, literal) {
                out.push(arg);
            }
        }
    });
    out
}

/// The string argument whose contents hold `offset` (between its quotes, or at either end of them).
pub fn string_arg_at(ctx: &Ctx<'_>, offset: u32) -> Option<StringArg> {
    let path = ctx.parsed.path_at(offset);
    let (i, literal) = path.iter().enumerate().rev().find_map(|(i, n)| match n {
        Node::LiteralString(s) => Some((i, *s)),
        _ => None,
    })?;
    if !(literal.span.start.offset < offset && offset < literal.span.end.offset) {
        return None;
    }
    string_arg(ctx, &path[..=i], literal)
}

/// Facts about the running app that a PHP script reports, cached until a file they depend on changes.
pub struct State {
    root: PathBuf,
    cache: Mutex<HashMap<String, Cached>>,
    /// The project's PHP, found the first time a script runs.
    php: std::sync::OnceLock<php::Php>,
    /// Keys whose scripts [`State::php_soon`] is running.
    pending: Mutex<HashSet<String>>,
}

struct Cached {
    value: Arc<Value>,
    /// Paths (relative to the root) whose changes make it stale; a prefix matches a folder.
    depends_on: Vec<String>,
    at: Instant,
}

impl State {
    pub fn new(root: PathBuf) -> Self {
        Self { root, cache: Mutex::new(HashMap::new()), php: std::sync::OnceLock::new(), pending: Mutex::new(HashSet::new()) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The JSON a PHP script prints, run once and cached under `key` until a path in `depends_on` changes.
    /// The script runs in the project's root with the project's PHP, and its arguments follow it. `None` if
    /// PHP fails.
    pub fn php(&self, key: &str, script: &str, args: &[&str], depends_on: &[&str]) -> Option<Arc<Value>> {
        self.php_script(key, script, args, depends_on, false)
    }

    /// Like [`State::php`], optionally through `artisan tinker`, for an app that can't boot on its own.
    pub fn php_script(&self, key: &str, script: &str, args: &[&str], depends_on: &[&str], tinker: bool) -> Option<Arc<Value>> {
        if let Some(c) = self.cache.lock().get(key) {
            // A failed run is cached as null, so it isn't retried until a file it depends on changes.
            return (!c.value.is_null()).then(|| c.value.clone());
        }
        let php = self.php.get_or_init(|| php::detect(&self.root));
        let value = Arc::new(php::run(&self.root, php, script, args, tinker).unwrap_or(Value::Null));
        let depends_on = depends_on.iter().map(|s| s.to_string()).collect();
        self.cache.lock().insert(key.to_string(), Cached { value: value.clone(), depends_on, at: Instant::now() });
        (!value.is_null()).then_some(value)
    }

    /// Like [`State::php`] without waiting, for facts that requests can do without: the cached value, if any,
    /// while the script runs on its own thread when there's none or it's older than `fresh`, so a later request
    /// gets it. A failed run is retried once it's older than `fresh` too.
    pub fn php_soon(self: &Arc<Self>, key: &str, script: &'static str, args: Vec<String>, depends_on: &'static [&'static str], fresh: Duration) -> Option<Arc<Value>> {
        let cached = self.cache.lock().get(key).map(|c| (c.value.clone(), c.at.elapsed() < fresh));
        if !cached.as_ref().is_some_and(|(_, fresh)| *fresh) && self.pending.lock().insert(key.to_string()) {
            let (state, key) = (self.clone(), key.to_string());
            std::thread::spawn(move || {
                let php = state.php.get_or_init(|| php::detect(&state.root));
                let args: Vec<&str> = args.iter().map(String::as_str).collect();
                let value = Arc::new(php::run(&state.root, php, script, &args, false).unwrap_or(Value::Null));
                let depends_on = depends_on.iter().map(|s| s.to_string()).collect();
                state.cache.lock().insert(key.clone(), Cached { value, depends_on, at: Instant::now() });
                state.pending.lock().remove(&key);
            });
        }
        cached.map(|(v, _)| v).filter(|v| !v.is_null())
    }

    /// Stores a value computed without PHP, with the same invalidation.
    pub fn remember(&self, key: &str, depends_on: &[&str], compute: impl FnOnce() -> Value) -> Arc<Value> {
        if let Some(c) = self.cache.lock().get(key) {
            return c.value.clone();
        }
        let value = Arc::new(compute());
        let depends_on = depends_on.iter().map(|s| s.to_string()).collect();
        self.cache.lock().insert(key.to_string(), Cached { value: value.clone(), depends_on, at: Instant::now() });
        value
    }

    /// Forgets cached facts that depend on `path`. A path outside the project forgets nothing.
    pub fn changed(&self, path: &Path) {
        let Ok(rel) = path.strip_prefix(&self.root) else { return };
        let rel = rel.to_string_lossy();
        self.cache.lock().retain(|_, c| !c.depends_on.iter().any(|d| d == "*" || rel.starts_with(d.as_str())));
    }

    /// Stores a value as if a script had reported it, for tests.
    #[cfg(test)]
    pub fn seed(&self, key: &str, value: Value) {
        self.cache.lock().insert(key.to_string(), Cached { value: Arc::new(value), depends_on: vec![], at: Instant::now() });
    }

    /// Forgets everything, such as after a reindex.
    pub fn clear(&self) {
        self.cache.lock().clear();
    }

    /// How old a cached value is, for tests and logging.
    pub fn age(&self, key: &str) -> Option<Duration> {
        self.cache.lock().get(key).map(|c| c.at.elapsed())
    }
}

/// Completions inside a string argument.
pub fn completion(ctx: &Ctx<'_>, offset: u32) -> Option<Vec<CompletionItem>> {
    let mut items = laravel::completion(ctx, offset).unwrap_or_default();
    items.extend(filament::completion(ctx, offset).unwrap_or_default());
    items.extend(icons::completion(ctx, offset).unwrap_or_default());
    items.extend(filament::colors::completion(ctx, offset).unwrap_or_default());
    items.extend(laravel::livewire::completion(ctx, offset).unwrap_or_default());
    (!items.is_empty()).then_some(items)
}

/// Where a string argument at `offset` points: a route's definition, a view's file, a relationship's method.
pub fn definition(ctx: &Ctx<'_>, offset: u32) -> Vec<Location> {
    let mut out = laravel::definition(ctx, offset);
    out.extend(filament::definition(ctx, offset));
    out.extend(icons::definition(ctx, offset));
    out.extend(laravel::livewire::definition(ctx, offset));
    out
}

pub fn hover(ctx: &Ctx<'_>, offset: u32) -> Option<Hover> {
    laravel::hover(ctx, offset).or_else(|| filament::hover(ctx, offset)).or_else(|| icons::hover(ctx, offset)).or_else(|| filament::colors::hover(ctx, offset)).or_else(|| laravel::livewire::hover(ctx, offset))
}

/// Problems with the strings passed to framework calls, such as a route name that doesn't exist.
pub fn diagnostics(ctx: &Ctx<'_>) -> Vec<Diagnostic> {
    let mut out = laravel::diagnostics(ctx);
    out.extend(filament::diagnostics(ctx));
    out.extend(icons::diagnostics(ctx));
    out.extend(filament::colors::diagnostics(ctx));
    out.extend(laravel::livewire::diagnostics(ctx));
    out
}

/// Swatches for the colors framework calls name, such as Filament's `->color('danger')`.
pub fn document_colors(ctx: &Ctx<'_>) -> Vec<lsp_types::ColorInformation> {
    filament::colors::document_colors(ctx)
}

pub fn code_lenses(ctx: &Ctx<'_>) -> Vec<CodeLens> {
    let mut out = laravel::code_lenses(ctx);
    out.extend(filament::code_lenses(ctx));
    out
}

pub fn document_links(ctx: &Ctx<'_>) -> Vec<DocumentLink> {
    laravel::document_links(ctx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::with_ctx;
    use crate::testing::Fixture;

    const LIB: &str = "<?php\nnamespace Illuminate\\Http;\nclass Request { public function routeIs(string ...$p): bool { return true; } }\n";

    /// Needs `php` on `PATH`; skipped without it.
    #[test]
    fn runs_scripts_in_the_background_without_waiting() {
        if std::process::Command::new("php").arg("-v").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("tusk-php-soon-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = Arc::new(State::new(dir.clone()));
        const SCRIPT: &str = "<?php echo json_encode(['n' => (int) $argv[1]]);";
        let soon = || state.php_soon("k", SCRIPT, vec!["7".into()], &[], Duration::from_secs(60));
        assert!(soon().is_none());
        let started = Instant::now();
        let value = loop {
            if let Some(v) = soon() {
                break v;
            }
            assert!(started.elapsed() < Duration::from_secs(20), "the script never finished");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(value["n"], 7);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn finds_strings_passed_to_calls() {
        let fx = Fixture::new(&[
            ("lib.php", LIB),
            ("t.php", "<?php\nfunction route(string $name, array $p = []) {}\nfunction f(\\Illuminate\\Http\\Request $r) {\n    route('home', ['id' => 'x']);\n    $r->routeIs('admin.*');\n    new \\Foo(view: 'mail');\n    $get('email');\n}\n"),
        ]);
        let args = with_ctx(&fx.snap, &crate::testing::uri("t.php"), string_args).unwrap();
        let summary: Vec<String> = args
            .iter()
            .map(|a| format!("{:?} {} {:?} #{} {:?} {:?} = {}", a.call.kind, a.call.name, a.call.classes, a.index, a.name, a.in_array, a.value))
            .collect();
        assert_eq!(
            summary,
            vec![
                "Function route [] #0 None None = home",
                "Function route [] #1 None Some(Key) = id",
                "Function route [] #1 None Some(Value(Some(\"id\"))) = x",
                "Method routeIs [\"Illuminate\\\\Http\\\\Request\"] #0 None None = admin.*",
                "New  [\"Foo\"] #0 Some(\"view\") None = mail",
                "Closure $get [] #0 None None = email",
            ]
        );
    }

    #[test]
    fn finds_the_string_at_the_cursor_even_unfinished() {
        let fx = Fixture::one("<?php\nfunction route($n) {}\nfunction f() {\n    route('ho<|>\n}\n");
        let at = fx.at();
        let arg = crate::features::with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| {
            string_arg_at(ctx, ctx.offset(at.position))
        })
        .flatten()
        .expect("a string argument");
        assert_eq!((arg.call.name.as_str(), arg.value.as_str()), ("route", "ho"));
    }
}
