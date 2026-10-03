//! What the project's own code says about how Laravel wires it together, read from the syntax of every project
//! file: where events, jobs, notifications, and mail are dispatched or sent, which listeners, observers, and
//! policies go with which classes, and the broadcast channels, Pennant features, Context keys, and
//! `URL::defaults()` keys it defines.
//!
//! Only names are resolved, so no file is analyzed. Each file's facts are kept by a hash of its text, and the
//! project's by the index's [`generation`](Index::generation), so after an edit only the edited file is parsed
//! again. Files that mention none of the calls read here aren't parsed at all.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use mago_allocator::LocalArena;
use mago_span::HasSpan;
use mago_syntax::cst::{ArrayElement, Expression, Hint, Node, PartialArgument, Property, PropertyItem};
use parking_lot::Mutex;
use rayon::prelude::*;

use crate::analysis::Parsed;
use crate::index::Index;
use crate::locate::walk;
use crate::server::Snapshot;

/// Where a fact was found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Site {
    pub path: PathBuf,
    pub offset: u32,
    /// The 0-based line.
    pub line: u32,
    /// The method or function it's in, as `OrderController@store`, or the file's name and line outside one.
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fact {
    /// `event(new X)`, `X::dispatch()`, `->notify(new X)`, `Mail::to($u)->send(new X)`: the class, and the call
    /// that takes it, lowercase (`event`, `dispatch`, `notify`, `send`).
    Dispatch { class: String, via: String },
    /// `X::class => [Y::class]` in `$listen`, `Event::listen(X::class, Y::class)`, `Event::listen(fn (X $e) …)`,
    /// or the `handle(X $event)` of a listener in `app/Listeners`, which Laravel discovers (`discovered`).
    /// `listener` is `None` for a closure.
    Listen { event: String, listener: Option<String>, discovered: bool },
    /// The project turns off event discovery: an event service provider's `shouldDiscoverEvents()` returns false.
    NoDiscovery,
    /// `#[ObservedBy(X::class)]` or `Model::observe(X::class)`.
    Observe { model: String, observer: String },
    /// `#[UsePolicy(X::class)]`, `Gate::policy(Model::class, X::class)`, or `$policies`.
    Policy { model: String, policy: String },
    /// `Broadcast::channel('orders.{id}', …)`: the name, `None` when it isn't a plain string, and the callback's
    /// source.
    Channel { name: Option<String>, callback: String },
    /// `Feature::define('name', …)`: the name, or `None` when it isn't a plain string or a class.
    Feature { name: Option<String> },
    /// A key `Context::add()` and the calls like it set.
    ContextKey { key: String },
    /// The keys `URL::defaults([...])` or a route's `defaults()` fill, or `None` when they aren't all plain.
    Defaults { keys: Option<Vec<String>> },
}

/// Facts, each with where it was found.
pub type Facts = Arc<Vec<(Fact, Site)>>;

/// Words one of the calls read here has, lowercase: a file without any isn't parsed.
const WORDS: &[&str] = &[
    "dispatch", "event(", "broadcast", "notify", "notification", "mail", "send(", "queue(", "later(", "chain(", "batch(", "push(", "listen", "observe",
    "policy", "polic", "channel", "feature", "context", "defaults(", "shoulddiscoverevents",
];

/// The calls a dispatched or sent object is passed to.
const DISPATCHERS: &[&str] = &[
    "event", "broadcast", "dispatch", "dispatch_sync", "dispatchsync", "dispatchnow", "dispatchafterresponse", "notify", "notifynow", "send", "sendnow",
    "queue", "later", "push", "pushon", "lateron", "chain", "batch",
];

/// The project's facts, for the index's generation.
pub fn facts(snap: &Snapshot, index: &Index) -> Facts {
    static CACHE: LazyLock<Mutex<(u64, Facts)>> = LazyLock::new(Default::default);
    static FILES: LazyLock<Mutex<HashMap<PathBuf, (u64, Facts)>>> = LazyLock::new(Default::default);
    // Held while it reads, so requests at the same time read the files once.
    let mut cache = CACHE.lock();
    if cache.0 == index.generation {
        return cache.1.clone();
    }
    let root = snap.root.clone();
    let mut paths: Vec<PathBuf> = index.project_files().map(Path::to_path_buf).collect();
    paths.sort();
    let known = std::mem::take(&mut *FILES.lock());
    let read: Vec<(PathBuf, u64, Facts)> = crate::index::scan_pool().install(|| {
        paths
            .into_par_iter()
            .filter_map(|path| {
                let text = snap.read(&path)?;
                let mut hasher = std::hash::DefaultHasher::new();
                text.hash(&mut hasher);
                let hash = hasher.finish();
                if let Some((h, found)) = known.get(&path)
                    && *h == hash
                {
                    return Some((path, hash, found.clone()));
                }
                let found = Arc::new(file_facts(&root, &path, &text));
                Some((path, hash, found))
            })
            .collect()
    });
    let mut all = vec![];
    let mut files = FILES.lock();
    for (path, hash, found) in read {
        all.extend(found.iter().cloned());
        files.insert(path, (hash, found));
    }
    *cache = (index.generation, Arc::new(all));
    cache.1.clone()
}

/// The facts one file states.
pub fn file_facts(root: &Path, path: &Path, text: &str) -> Vec<(Fact, Site)> {
    let lower = text.to_ascii_lowercase();
    let listeners = path.starts_with(root.join("app/Listeners"));
    let features = path.starts_with(root.join("app/Features"));
    if !listeners && !features && !WORDS.iter().any(|w| lower.contains(w)) {
        return vec![];
    }
    let arena = LocalArena::new();
    let parsed = Parsed::new(&arena, path, text);
    let mut out = vec![];
    let r = Reader { parsed: &parsed, path, text, features };
    walk(&parsed, |node, ancestors| r.node(node, ancestors, listeners, &mut out));
    out
}

struct Reader<'p, 'a> {
    parsed: &'p Parsed<'a>,
    path: &'p Path,
    text: &'p str,
    /// Whether the file is in `app/Features`, where Pennant discovers class-based features.
    features: bool,
}

impl<'a> Reader<'_, 'a> {
    fn site(&self, offset: u32, ancestors: &[Node<'_, '_>]) -> Site {
        let line = self.text[..offset as usize].matches('\n').count() as u32;
        let file = self.path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
        let mut class = None;
        let mut function = None;
        for node in ancestors.iter().rev() {
            match node {
                Node::Method(m) if function.is_none() => function = Some(self.span_text(m.name.span())),
                Node::Function(f) if function.is_none() => function = Some(self.span_text(f.name.span())),
                Node::Class(c) if class.is_none() => class = Some(self.span_text(c.name.span())),
                Node::Trait(c) if class.is_none() => class = Some(self.span_text(c.name.span())),
                Node::Enum(c) if class.is_none() => class = Some(self.span_text(c.name.span())),
                _ => {}
            }
        }
        let label = match (class, function) {
            (Some(c), Some(f)) => format!("{c}@{f}"),
            (Some(c), None) => c,
            (None, Some(f)) => format!("{f}()"),
            (None, None) => format!("{file}:{}", line + 1),
        };
        Site { path: self.path.to_path_buf(), offset, line, label }
    }

    fn span_text(&self, span: mago_span::Span) -> String {
        self.text[span.start.offset as usize..span.end.offset as usize].to_string()
    }

    fn resolved(&self, span: mago_span::Span) -> Option<String> {
        self.parsed.names.resolve(&span).map(|n| String::from_utf8_lossy(n).trim_start_matches('\\').to_string())
    }

    /// The class `X` in `X::class`, or a class name used as an expression, as in `new X` or `X::dispatch()`.
    fn class(&self, expr: &Expression<'_>) -> Option<String> {
        match expr {
            Expression::Identifier(id) => self.resolved(id.span()),
            Expression::Access(mago_syntax::cst::Access::ClassConstant(a))
                if matches!(&a.constant, mago_syntax::cst::ClassLikeConstantSelector::Identifier(id) if id.value.eq_ignore_ascii_case(b"class")) =>
            {
                self.class(a.class)
            }
            Expression::Parenthesized(p) => self.class(p.expression),
            _ => None,
        }
    }

    /// The classes an expression names: `X::class`, `new X`, or a list of them.
    fn classes(&self, expr: &Expression<'_>) -> Vec<String> {
        match expr {
            Expression::Array(a) => a.elements.iter().flat_map(|e| self.element_classes(e)).collect(),
            Expression::LegacyArray(a) => a.elements.iter().flat_map(|e| self.element_classes(e)).collect(),
            Expression::Instantiation(i) => self.class(i.class).into_iter().collect(),
            other => self.class(other).into_iter().collect(),
        }
    }

    fn element_classes(&self, element: &ArrayElement<'_>) -> Vec<String> {
        match element {
            ArrayElement::Value(v) => self.classes(v.value),
            _ => vec![],
        }
    }

    fn string(&self, expr: &Expression<'_>) -> Option<String> {
        let Expression::Literal(mago_syntax::cst::Literal::String(s)) = expr else { return None };
        let (start, end) = (s.span.start.offset + 1, s.span.end.offset.saturating_sub(1));
        (start <= end).then(|| self.text[start as usize..end as usize].to_string())
    }

    /// The classes a parameter's type names, other than PHP's own types.
    fn hint_classes(&self, hint: &Hint<'_>) -> Vec<String> {
        match hint {
            Hint::Identifier(id) => self.resolved(id.span()).into_iter().collect(),
            Hint::Nullable(n) => self.hint_classes(n.hint),
            Hint::Parenthesized(p) => self.hint_classes(p.hint),
            Hint::Union(u) => [self.hint_classes(u.left), self.hint_classes(u.right)].concat(),
            _ => vec![],
        }
    }

    /// The types of a closure's or arrow function's first parameter.
    fn closure_event(&self, expr: &Expression<'_>) -> Option<Vec<String>> {
        let list = match expr {
            Expression::Closure(c) => &c.parameter_list,
            Expression::ArrowFunction(f) => &f.parameter_list,
            // `queueable(function (X $e) {...})`
            Expression::Call(mago_syntax::cst::Call::Function(f)) => return f.argument_list.arguments.first().and_then(|a| self.closure_event(a.value())),
            _ => return None,
        };
        Some(list.parameters.first().and_then(|p| p.hint.as_ref()).map(|h| self.hint_classes(h)).unwrap_or_default())
    }

    fn node(&self, node: Node<'_, '_>, ancestors: &[Node<'_, '_>], listeners: bool, out: &mut Vec<(Fact, Site)>) {
        match node {
            Node::Instantiation(i) => {
                let Some(class) = self.class(i.class).filter(|c| !c.starts_with("Illuminate\\")) else { return };
                if let Some(via) = self.dispatcher_of(ancestors) {
                    out.push((Fact::Dispatch { class, via }, self.site(i.span().start.offset, ancestors)));
                }
            }
            Node::StaticMethodCall(c) => {
                let method = self.span_text(c.method.span()).to_ascii_lowercase();
                let Some(class) = self.class(c.class) else { return };
                let args: Vec<&Expression<'_>> = c.argument_list.arguments.iter().map(|a| a.value()).collect();
                let site = || self.site(c.span().start.offset, ancestors);
                let facade = class.rsplit('\\').next().unwrap_or(&class).to_ascii_lowercase();
                let framework = class.starts_with("Illuminate\\") || class.starts_with("Laravel\\") || !class.contains('\\');
                match (facade.as_str(), method.as_str()) {
                    ("event", "listen") if framework => {
                        let Some(first) = args.first() else { return };
                        let (events, listener) = match self.closure_event(first) {
                            Some(events) => (events, None),
                            None => (self.classes(first), args.get(1).and_then(|l| self.listener(l))),
                        };
                        for event in events {
                            out.push((Fact::Listen { event, listener: listener.clone(), discovered: false }, site()));
                        }
                    }
                    ("gate", "policy") if framework => {
                        if let (Some(model), Some(policy)) = (args.first().and_then(|a| self.class(a)), args.get(1).and_then(|a| self.class(a))) {
                            out.push((Fact::Policy { model, policy }, site()));
                        }
                    }
                    ("broadcast", "channel") if framework => {
                        let callback = args.get(1).map(|a| self.span_text(a.span())).unwrap_or_default();
                        let name = args.first().and_then(|a| self.string(a));
                        out.push((Fact::Channel { name, callback }, site()));
                    }
                    ("feature", "define") if framework => {
                        let name = args.first().and_then(|a| self.string(a).or_else(|| self.class(a)));
                        out.push((Fact::Feature { name }, site()));
                    }
                    // Classes from folders other than `app/Features`, which no one can list.
                    ("feature", "discover") if framework && !args.is_empty() => out.push((Fact::Feature { name: None }, site())),
                    ("context", "add" | "addhidden" | "addif" | "addhiddenif" | "push" | "pushhidden" | "increment" | "decrement" | "remember" | "rememberhidden")
                        if framework =>
                    {
                        let keys = match args.first() {
                            Some(Expression::Array(a)) => a.elements.iter().filter_map(|e| if let ArrayElement::KeyValue(kv) = e { self.string(kv.key) } else { None }).collect(),
                            Some(a) => self.string(a).into_iter().collect(),
                            None => vec![],
                        };
                        for key in keys {
                            out.push((Fact::ContextKey { key }, site()));
                        }
                    }
                    (_, "defaults") => out.push((Fact::Defaults { keys: self.defaults(&args) }, site())),
                    (_, "observe") if !framework => {
                        for observer in args.first().map(|a| self.classes(a)).unwrap_or_default() {
                            out.push((Fact::Observe { model: class.clone(), observer }, site()));
                        }
                    }
                    (_, m) if (m.starts_with("dispatch") || m == "broadcast") && !framework => {
                        out.push((Fact::Dispatch { class, via: "dispatch".into() }, site()));
                    }
                    _ => {}
                }
            }
            Node::MethodCall(c) => {
                if self.span_text(c.method.span()).eq_ignore_ascii_case("defaults") {
                    let args: Vec<&Expression<'_>> = c.argument_list.arguments.iter().map(|a| a.value()).collect();
                    out.push((Fact::Defaults { keys: self.defaults(&args) }, self.site(c.span().start.offset, ancestors)));
                }
            }
            Node::Attribute(a) => {
                let Some(name) = self.resolved(a.name.span()) else { return };
                let attribute = name.rsplit('\\').next().unwrap_or(&name);
                if !matches!(attribute, "ObservedBy" | "UsePolicy") {
                    return;
                }
                let Some(model) = self.enclosing_class(ancestors) else { return };
                let classes: Vec<String> = a
                    .argument_list
                    .iter()
                    .flat_map(|l| l.arguments.iter())
                    .flat_map(|arg| match arg {
                        PartialArgument::Positional(p) => self.classes(p.value),
                        PartialArgument::Named(n) => self.classes(n.value),
                        _ => vec![],
                    })
                    .collect();
                let site = self.site(a.span().start.offset, ancestors);
                for class in classes {
                    let fact = if attribute == "ObservedBy" { Fact::Observe { model: model.clone(), observer: class } } else { Fact::Policy { model: model.clone(), policy: class } };
                    out.push((fact, site.clone()));
                }
            }
            // A class-based Pennant feature, named by its class or its `$name`.
            Node::Class(c) if self.features => {
                let Some(class) = self.resolved(c.name.span()) else { return };
                out.push((Fact::Feature { name: Some(class) }, self.site(c.name.span().start.offset, ancestors)));
            }
            Node::Property(Property::Plain(p)) => {
                for item in p.items.iter() {
                    let PropertyItem::Concrete(item) = item else { continue };
                    let name = self.span_text(item.variable.span());
                    if self.features && name == "$name" {
                        out.push((Fact::Feature { name: self.string(item.value) }, self.site(item.variable.span().start.offset, ancestors)));
                    }
                    if name != "$listen" && name != "$policies" {
                        continue;
                    }
                    let Expression::Array(array) = item.value else { continue };
                    for element in array.elements.iter() {
                        let ArrayElement::KeyValue(kv) = element else { continue };
                        let Some(key) = self.class(kv.key) else { continue };
                        let site = self.site(kv.key.span().start.offset, ancestors);
                        for value in self.classes(kv.value) {
                            let fact = if name == "$listen" {
                                Fact::Listen { event: key.clone(), listener: Some(value), discovered: false }
                            } else {
                                Fact::Policy { model: key.clone(), policy: value }
                            };
                            out.push((fact, site.clone()));
                        }
                    }
                }
            }
            Node::Method(m) => {
                let name = self.span_text(m.name.span());
                if name.eq_ignore_ascii_case("shouldDiscoverEvents") && self.span_text(m.body.span()).contains("false") {
                    out.push((Fact::NoDiscovery, self.site(m.span().start.offset, ancestors)));
                }
                if !listeners || !(name == "handle" || name == "__invoke") {
                    return;
                }
                let Some(listener) = self.enclosing_class(ancestors) else { return };
                let events = m.parameter_list.parameters.first().and_then(|p| p.hint.as_ref()).map(|h| self.hint_classes(h)).unwrap_or_default();
                for event in events {
                    out.push((Fact::Listen { event, listener: Some(listener.clone()), discovered: true }, self.site(m.span().start.offset, ancestors)));
                }
            }
            _ => {}
        }
    }

    /// The listener class an `Event::listen()` names: `X::class`, `[X::class, 'method']`, or `'X@method'`.
    fn listener(&self, expr: &Expression<'_>) -> Option<String> {
        match expr {
            Expression::Array(a) => a.elements.iter().next().and_then(|e| self.element_classes(e).into_iter().next()),
            other => self.class(other).or_else(|| self.string(other).map(|s| s.split('@').next().unwrap_or(&s).trim_start_matches('\\').replace("\\\\", "\\"))),
        }
    }

    /// The keys a `defaults()` call fills: an array's keys, or a route's `defaults('key', $value)`.
    fn defaults(&self, args: &[&Expression<'_>]) -> Option<Vec<String>> {
        match args.first()? {
            Expression::Array(a) => a
                .elements
                .iter()
                .map(|e| match e {
                    ArrayElement::KeyValue(kv) => self.string(kv.key),
                    _ => None,
                })
                .collect(),
            other => self.string(other).map(|k| vec![k]),
        }
    }

    fn enclosing_class(&self, ancestors: &[Node<'_, '_>]) -> Option<String> {
        ancestors.iter().rev().find_map(|n| match n {
            Node::Class(c) => self.resolved(c.name.span()),
            _ => None,
        })
    }

    /// The call an object is passed to, if it's one that dispatches or sends it: `event(new X)`,
    /// `->notify(new X)`, or `Bus::chain([new X, new Y])`.
    fn dispatcher_of(&self, ancestors: &[Node<'_, '_>]) -> Option<String> {
        let mut in_arguments = false;
        for node in ancestors.iter().rev() {
            match node {
                Node::Expression(_) | Node::Array(_) | Node::LegacyArray(_) | Node::ArrayElement(_) | Node::ValueArrayElement(_) | Node::Parenthesized(_) => {}
                Node::PositionalArgument(_) | Node::NamedArgument(_) | Node::Argument(_) => {}
                Node::ArgumentList(_) => in_arguments = true,
                Node::FunctionCall(f) if in_arguments => {
                    let name = self.span_text(f.function.span());
                    let name = name.rsplit('\\').next().unwrap_or(&name).to_ascii_lowercase();
                    return DISPATCHERS.contains(&name.as_str()).then_some(name);
                }
                Node::MethodCall(_) | Node::NullSafeMethodCall(_) | Node::StaticMethodCall(_) if in_arguments => {
                    let method = match node {
                        Node::MethodCall(c) => c.method.span(),
                        Node::NullSafeMethodCall(c) => c.method.span(),
                        Node::StaticMethodCall(c) => c.method.span(),
                        _ => return None,
                    };
                    let name = self.span_text(method).to_ascii_lowercase();
                    return DISPATCHERS.iter().any(|d| d.eq_ignore_ascii_case(&name)).then_some(name);
                }
                _ => return None,
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(path: &str, text: &str) -> Vec<Fact> {
        file_facts(Path::new("/p"), &Path::new("/p").join(path), text).into_iter().map(|(f, _)| f).collect()
    }

    fn dispatch(class: &str, via: &str) -> Fact {
        Fact::Dispatch { class: class.into(), via: via.into() }
    }

    #[test]
    fn reads_where_objects_are_dispatched_and_sent() {
        let found = read(
            "app/Http/Controllers/OrderController.php",
            "<?php\nnamespace App\\Http\\Controllers;\nuse App\\Events\\Shipped;\nuse App\\Jobs\\Ship;\nuse Illuminate\\Support\\Facades\\Mail;\nclass OrderController {\n    function store($u) {\n        event(new Shipped(1));\n        Ship::dispatch(2);\n        $u->notify(new \\App\\Notifications\\Paid);\n        Mail::to($u)->send(new \\App\\Mail\\Receipt);\n        \\Illuminate\\Support\\Facades\\Bus::chain([new Ship, new \\App\\Jobs\\Bill]);\n        (new Shipped)->handle();\n        $x = new Shipped;\n    }\n}\n",
        );
        assert_eq!(
            found,
            vec![
                dispatch("App\\Events\\Shipped", "event"),
                dispatch("App\\Jobs\\Ship", "dispatch"),
                dispatch("App\\Notifications\\Paid", "notify"),
                dispatch("App\\Mail\\Receipt", "send"),
                dispatch("App\\Jobs\\Ship", "chain"),
                dispatch("App\\Jobs\\Bill", "chain"),
            ]
        );
        let sites = file_facts(Path::new("/p"), Path::new("/p/app/x.php"), "<?php\nclass A { function b() {\n    event(new E);\n} }\nevent(new F);\n");
        assert_eq!(sites.iter().map(|(_, s)| (s.line, s.label.as_str())).collect::<Vec<_>>(), vec![(2, "A@b"), (4, "x.php:5")]);
    }

    #[test]
    fn reads_listeners_observers_and_policies() {
        let provider = "<?php\nnamespace App\\Providers;\nuse App\\Events\\Shipped;\nuse App\\Listeners\\Notify;\nuse Illuminate\\Support\\Facades\\Event;\nuse Illuminate\\Support\\Facades\\Gate;\nclass EventServiceProvider {\n    protected $listen = [Shipped::class => [Notify::class]];\n    protected $policies = [\\App\\Models\\Post::class => \\App\\Policies\\PostPolicy::class];\n    function boot() {\n        Event::listen(Shipped::class, [Notify::class, 'handle']);\n        Event::listen(function (Shipped|\\App\\Events\\Lost $e) {});\n        Gate::policy(\\App\\Models\\User::class, \\App\\Policies\\UserPolicy::class);\n        \\App\\Models\\Post::observe([\\App\\Observers\\PostObserver::class]);\n    }\n    public function shouldDiscoverEvents(): bool { return false; }\n}\n";
        let listen = |e: &str, l: Option<&str>| Fact::Listen { event: e.into(), listener: l.map(String::from), discovered: false };
        assert_eq!(
            read("app/Providers/EventServiceProvider.php", provider),
            vec![
                listen("App\\Events\\Shipped", Some("App\\Listeners\\Notify")),
                Fact::Policy { model: "App\\Models\\Post".into(), policy: "App\\Policies\\PostPolicy".into() },
                listen("App\\Events\\Shipped", Some("App\\Listeners\\Notify")),
                listen("App\\Events\\Shipped", None),
                listen("App\\Events\\Lost", None),
                Fact::Policy { model: "App\\Models\\User".into(), policy: "App\\Policies\\UserPolicy".into() },
                Fact::Observe { model: "App\\Models\\Post".into(), observer: "App\\Observers\\PostObserver".into() },
                Fact::NoDiscovery,
            ]
        );
        let model = "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Attributes\\ObservedBy;\nuse Illuminate\\Database\\Eloquent\\Attributes\\UsePolicy;\n#[ObservedBy([\\App\\Observers\\ReportObserver::class])]\n#[UsePolicy(\\App\\Policies\\ReportPolicy::class)]\nclass Report {}\n";
        assert_eq!(
            read("app/Models/Report.php", model),
            vec![
                Fact::Observe { model: "App\\Models\\Report".into(), observer: "App\\Observers\\ReportObserver".into() },
                Fact::Policy { model: "App\\Models\\Report".into(), policy: "App\\Policies\\ReportPolicy".into() },
            ]
        );
        let listener = "<?php\nnamespace App\\Listeners;\nuse App\\Events\\Shipped;\nclass Notify { public function handle(Shipped $event): void {} }\n";
        assert_eq!(read("app/Listeners/Notify.php", listener), vec![Fact::Listen { event: "App\\Events\\Shipped".into(), listener: Some("App\\Listeners\\Notify".into()), discovered: true }]);
        // Only `app/Listeners` is discovered.
        assert!(read("app/Other/Notify.php", listener).is_empty());
    }

    #[test]
    fn reads_channels_features_context_keys_and_defaults() {
        let found = read(
            "routes/channels.php",
            "<?php\nuse Illuminate\\Support\\Facades\\Broadcast;\nuse Illuminate\\Support\\Facades\\Context;\nuse Laravel\\Pennant\\Feature;\nuse Illuminate\\Support\\Facades\\URL;\nBroadcast::channel('orders.{id}', fn ($u, $id) => true);\nBroadcast::channel($name, fn () => true);\nFeature::define('new-api', fn () => true);\nFeature::define(\\App\\Features\\Beta::class);\nContext::add('trace', 1);\nContext::add(['user' => 1, 'team' => 2]);\nURL::defaults(['locale' => 'en']);\nURL::defaults($all);\n",
        );
        assert_eq!(
            found,
            vec![
                Fact::Channel { name: Some("orders.{id}".into()), callback: "fn ($u, $id) => true".into() },
                Fact::Channel { name: None, callback: "fn () => true".into() },
                Fact::Feature { name: Some("new-api".into()) },
                Fact::Feature { name: Some("App\\Features\\Beta".into()) },
                Fact::ContextKey { key: "trace".into() },
                Fact::ContextKey { key: "user".into() },
                Fact::ContextKey { key: "team".into() },
                Fact::Defaults { keys: Some(vec!["locale".into()]) },
                Fact::Defaults { keys: None },
            ]
        );
        let feature = "<?php\nnamespace App\\Features;\nclass NewApi { public $name = 'new-api'; public function resolve($u) { return true; } }\n";
        assert_eq!(read("app/Features/NewApi.php", feature), vec![Fact::Feature { name: Some("App\\Features\\NewApi".into()) }, Fact::Feature { name: Some("new-api".into()) }]);
    }
}
