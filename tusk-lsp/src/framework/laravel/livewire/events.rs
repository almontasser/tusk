//! Livewire's events: where the project dispatches each one and where it listens for it. A component listens with
//! `#[On('name')]` or its `$listeners`; Blade and JavaScript listen with `Livewire.on('name')`, `$wire.$on('name')`,
//! `addEventListener('name')`, and Alpine's `@name.window`. They dispatch with `$this->dispatch('name')` in PHP, and
//! `$dispatch('name')`, `$wire.dispatch('name')`, and `Livewire.dispatch('name')` in Blade and JavaScript. Event
//! names complete, describe, and go to each other in those calls. A dispatched event with no listener isn't
//! reported: Alpine, JavaScript bundles, and packages' views listen in ways the project's files don't all show.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use lsp_types::{CompletionItem, CompletionItemKind, CompletionTextEdit, Hover, HoverContents, Location, MarkupContent, MarkupKind, TextEdit};
use mago_allocator::LocalArena;
use mago_span::HasSpan;
use mago_syntax::cst::{ArrayElement, ClassLikeMemberSelector, Expression, Literal, Node, PartialArgument};
use parking_lot::Mutex;

use crate::analysis::Parsed;
use crate::features::Ctx;
use crate::framework::{CallKind, string_arg_at};
use crate::index::Index;
use crate::locate::walk;
use crate::text::{LineIndex, path_to_uri};

pub const ON: &str = "Livewire\\Attributes\\On";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Role {
    Dispatch,
    /// A component's listener, by `#[On]` or `$listeners`, or JavaScript's, by `Livewire.on()` or `$wire.$on()`.
    Listen,
    /// A DOM listener, by `addEventListener()` or Alpine's `@name`, which Livewire's browser events also reach.
    Dom,
}

/// One place an event is dispatched or listened for.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Site {
    pub name: String,
    pub role: Role,
    pub path: PathBuf,
    /// The span of the name, without quotes.
    pub start: usize,
    pub end: usize,
    /// What's there: the listener's `Class::method`, or empty.
    pub label: String,
    /// A PHP dispatch on `$this`, which counts only in a Livewire component: the enclosing class.
    pub this_class: Option<String>,
}

/// Whether `name` is one Livewire's server sends through Laravel Echo, which the project doesn't dispatch.
fn echo(name: &str) -> bool {
    name.starts_with("echo:") || name.starts_with("echo-private:") || name.starts_with("echo-presence:") || name.starts_with("echo-notification:")
}

/// Whether a listener's name, which may hold `{placeholders}` (`post-updated.{post.id}`), matches a dispatched one.
fn matches(listener: &str, dispatched: &str) -> bool {
    let mut rest = dispatched;
    let mut parts = listener.split('{').peekable();
    let Some(first) = parts.next() else { return false };
    let Some(after) = rest.strip_prefix(first) else { return false };
    rest = after;
    if parts.peek().is_none() {
        return rest.is_empty();
    }
    for part in parts {
        let Some((_, literal)) = part.split_once('}') else { return false };
        // The placeholder takes up to the next literal part.
        match (literal.is_empty(), rest.find(literal)) {
            (true, _) if !rest.is_empty() => rest = "",
            (true, _) => return false,
            (false, Some(at)) if at > 0 => rest = &rest[at + literal.len()..],
            _ => return false,
        }
    }
    rest.is_empty()
}

fn hash(key: impl Hash) -> u64 {
    let mut h = std::hash::DefaultHasher::new();
    key.hash(&mut h);
    h.finish()
}

/// `find()`, or what it gave for the same file and text, in a cache that starts over past a few thousand entries.
fn cached(path: &Path, text: &str, find: impl FnOnce() -> Vec<Site>) -> Arc<Vec<Site>> {
    static CACHE: LazyLock<Mutex<HashMap<u64, Arc<Vec<Site>>>>> = LazyLock::new(Default::default);
    let key = hash((path, text));
    if let Some(found) = CACHE.lock().get(&key) {
        return found.clone();
    }
    let found = Arc::new(find());
    let mut cache = CACHE.lock();
    if cache.len() > 8192 {
        cache.clear();
    }
    cache.insert(key, found.clone());
    found
}

/// Every place the project dispatches or listens for an event: its PHP, its Blade views, and its JavaScript in
/// `resources/js`.
pub fn sites(index: &Index, read: &dyn Fn(&Path) -> Option<String>) -> Vec<Site> {
    let mut out = vec![];
    for path in index.project_files() {
        let Some(text) = read(path) else { continue };
        if !(text.contains("dispatch(") || text.contains("Attributes\\On") || text.contains("$listeners")) {
            continue;
        }
        out.extend(cached(path, &text, || php_sites(path, &text)).iter().filter(|s| !s.name.is_empty() && s.this_class.as_ref().is_none_or(|c| super::is_component(&index.codebase, c))).cloned());
    }
    let root = &index.config.root;
    for path in super::super::views::blade_views(root) {
        let Some(text) = read(&path) else { continue };
        out.extend(cached(&path, &text, || blade_sites(&path, &text)).iter().filter(|s| !s.name.is_empty()).cloned());
    }
    let scripts = ignore::WalkBuilder::new(root.join("resources/js")).standard_filters(true).build().flatten().map(|e| e.into_path());
    for path in scripts.filter(|p| p.extension().is_some_and(|e| ["js", "ts", "mjs", "vue", "jsx", "tsx"].contains(&e.to_string_lossy().as_ref()))) {
        let Some(text) = read(&path) else { continue };
        out.extend(cached(&path, &text, || js_sites(&path, &text, &[(0, text.len())])).iter().filter(|s| !s.name.is_empty()).cloned());
    }
    out
}

/// The listeners and `$this->dispatch()` calls in a PHP file.
fn php_sites(path: &Path, text: &str) -> Vec<Site> {
    let arena = LocalArena::new();
    let parsed = Parsed::new(&arena, path, text);
    let resolver = crate::symbol::Resolver::new(&parsed, None, empty_codebase());
    let mut out = vec![];
    let literal = |e: &Expression<'_>| match e {
        Expression::Literal(Literal::String(s)) if s.value.is_some() => Some((String::from_utf8_lossy(s.value.unwrap_or_default()).into_owned(), s.span.start.offset as usize + 1, s.span.end.offset as usize - 1)),
        _ => None,
    };
    let site = |(name, start, end): (String, usize, usize), role, label: String, this_class| Site { name, role, path: path.to_path_buf(), start, end, label, this_class };
    walk(&parsed, |node, ancestors| {
        let class = || resolver.enclosing_class(ancestors).unwrap_or_default();
        let method = || ancestors.iter().rev().find_map(|n| if let Node::Method(m) = n { Some(String::from_utf8_lossy(m.name.value).into_owned()) } else { None });
        match node {
            Node::Attribute(a) if parsed.names.resolve(&a.name.span()).is_some_and(|n| n.eq_ignore_ascii_case(ON.as_bytes())) => {
                let Some(list) = &a.argument_list else { return };
                let value = list.arguments.iter().find_map(|arg| match arg {
                    PartialArgument::Positional(p) => Some(p.value),
                    PartialArgument::Named(n) if n.name.value == b"event" => Some(n.value),
                    _ => None,
                });
                let label = format!("{}::{}", class(), method().unwrap_or_else(|| "$refresh".into()));
                let values: Vec<&Expression<'_>> = match value {
                    Some(Expression::Array(a)) => a.elements.iter().filter_map(|e| if let ArrayElement::Value(v) = e { Some(v.value) } else { None }).collect(),
                    Some(e) => vec![e],
                    None => vec![],
                };
                out.extend(values.into_iter().filter_map(literal).map(|l| site(l, Role::Listen, label.clone(), None)));
            }
            Node::PropertyConcreteItem(item) if item.variable.name == b"$listeners" => {
                let Expression::Array(a) = item.value else { return };
                for e in a.elements.iter() {
                    match e {
                        ArrayElement::KeyValue(kv) => {
                            let target = literal(kv.value).map(|(m, _, _)| m).unwrap_or_else(|| "$refresh".into());
                            out.extend(literal(kv.key).map(|l| site(l, Role::Listen, format!("{}::{target}", class()), None)));
                        }
                        ArrayElement::Value(v) => out.extend(literal(v.value).map(|l| {
                            let label = format!("{}::{}", class(), l.0);
                            site(l, Role::Listen, label, None)
                        })),
                        _ => {}
                    }
                }
            }
            Node::MethodCall(c) if matches!(&c.method, ClassLikeMemberSelector::Identifier(id) if id.value == b"dispatch") => {
                let Some(first) = c.argument_list.arguments.first() else { return };
                let Some(name) = literal(first.value()) else { return };
                let this = matches!(c.object, Expression::Variable(mago_syntax::cst::Variable::Direct(v)) if v.name == b"$this");
                // Filament passes the component to closures as `$livewire`.
                let livewire = matches!(c.object, Expression::Variable(mago_syntax::cst::Variable::Direct(v)) if matches!(v.name, b"$livewire" | b"$component"));
                if this || livewire {
                    out.push(site(name, Role::Dispatch, String::new(), this.then(class)));
                }
            }
            _ => {}
        }
    });
    out
}

/// A codebase with nothing in it, for resolving names without the index.
fn empty_codebase() -> &'static mago_codex::metadata::CodebaseMetadata {
    static EMPTY: LazyLock<mago_codex::metadata::CodebaseMetadata> = LazyLock::new(Default::default);
    &EMPTY
}

/// The JavaScript calls that dispatch or listen for events, by the text before their `(`, and the position of the
/// argument that names the event.
const JS_CALLS: &[(&str, Role, usize)] = &[
    ("$dispatch", Role::Dispatch, 0),
    ("$dispatchSelf", Role::Dispatch, 0),
    ("$dispatchTo", Role::Dispatch, 1),
    ("$wire.dispatch", Role::Dispatch, 0),
    ("$wire.dispatchSelf", Role::Dispatch, 0),
    ("$wire.dispatchTo", Role::Dispatch, 1),
    ("Livewire.dispatch", Role::Dispatch, 0),
    ("Livewire.dispatchTo", Role::Dispatch, 1),
    ("Livewire.on", Role::Listen, 0),
    ("$wire.on", Role::Listen, 0),
    ("$wire.$on", Role::Listen, 0),
    ("addEventListener", Role::Dom, 0),
];

/// The event names that JavaScript calls in `ranges` of `text` pass.
fn js_sites(path: &Path, text: &str, ranges: &[(usize, usize)]) -> Vec<Site> {
    let src = text.as_bytes();
    let mut out = vec![];
    for &(start, end) in ranges {
        let js = &text[start..end];
        for (at, _) in js.match_indices('(') {
            let before = &js[..at];
            let callee_len = before.bytes().rev().take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'$' | b'.')).count();
            let callee = &before[before.len() - callee_len..];
            // `this.$dispatch(...)` and `window.Livewire.dispatch(...)` too.
            let Some(&(_, role, index)) = JS_CALLS.iter().find(|(name, _, _)| callee == *name || callee.ends_with(&format!(".{name}"))) else { continue };
            let mut p = start + at + 1;
            for _ in 0..index {
                // Past the first argument, a string, to the comma after it.
                p += src[p..end].iter().take_while(|b| b.is_ascii_whitespace()).count();
                let Some(&q @ (b'\'' | b'"' | b'`')) = src.get(p) else { break };
                let Some(close) = src[p + 1..end].iter().position(|b| *b == q) else { break };
                p += close + 2;
                p += src[p..end].iter().take_while(|b| b.is_ascii_whitespace()).count();
                if src.get(p) != Some(&b',') {
                    break;
                }
                p += 1;
            }
            p += src[p.min(end)..end].iter().take_while(|b| b.is_ascii_whitespace()).count();
            let Some(&q @ (b'\'' | b'"')) = src.get(p) else { continue };
            let Some(len) = src[p + 1..end].iter().position(|b| *b == q || *b == b'\n') else { continue };
            let name = &text[p + 1..p + 1 + len];
            if src[p + 1 + len] == q && !name.contains("{{") {
                out.push(Site { name: name.to_string(), role, path: path.to_path_buf(), start: p + 1, end: p + 1 + len, label: String::new(), this_class: None });
            }
        }
    }
    out
}

/// The events a Blade view dispatches and listens for: in its JavaScript ([`js_sites`]), and its Alpine listeners,
/// `x-on:name` and `@name`.
fn blade_sites(path: &Path, text: &str) -> Vec<Site> {
    let scan = super::view::scan(text);
    let ranges: Vec<(usize, usize)> = scan.js().collect();
    let mut out = js_sites(path, text, &ranges);
    for attr in &scan.attrs {
        let name = &text[attr.name.0..attr.name.1];
        let Some(rest) = name.strip_prefix("x-on:").map(|r| (5, r)).or_else(|| name.strip_prefix('@').map(|r| (1, r))) else { continue };
        let event = rest.1.split('.').next().unwrap_or_default();
        if !event.is_empty() {
            let start = attr.name.0 + rest.0;
            out.push(Site { name: event.to_string(), role: Role::Dom, path: path.to_path_buf(), start, end: start + event.len(), label: String::new(), this_class: None });
        }
    }
    out
}

/// The event string at `offset` in the file in `ctx`, and whether it's dispatched (rather than listened for).
fn event_at(ctx: &Ctx<'_>, offset: u32) -> Option<(usize, usize, String, Role)> {
    let offset = offset as usize;
    if crate::features::is_blade(&ctx.doc) {
        return blade_sites(&ctx.doc.path, &ctx.doc.text).into_iter().find(|s| s.role != Role::Dom && s.start <= offset && offset <= s.end).map(|s| (s.start, s.end, s.name, s.role));
    }
    let arg = string_arg_at(ctx, offset as u32)?;
    let role = php_role(ctx, &arg)?;
    Some((arg.start as usize, arg.end as usize, arg.value, role))
}

/// Whether a PHP string argument names an event: dispatched by a component's `dispatch()`, or listened for by `#[On]`.
fn php_role(ctx: &Ctx<'_>, arg: &crate::framework::StringArg) -> Option<Role> {
    let codebase = &ctx.index.codebase;
    let call = &arg.call;
    if call.kind == CallKind::Attribute && call.on(codebase, &[ON]) && (arg.index == 0 || arg.name.as_deref() == Some("event")) && arg.in_array != Some(crate::framework::InArray::Key) {
        return Some(Role::Listen);
    }
    let receiver = ctx.parsed.text().get(call.span.0 as usize..).unwrap_or_default();
    let livewire = call.on(codebase, &[super::COMPONENT]) || (call.classes.is_empty() && (receiver.starts_with("$livewire") || receiver.starts_with("$component")));
    (call.is_method(&["dispatch"]) && call.kind == CallKind::Method && livewire && arg.index == 0 && arg.in_array.is_none()).then_some(Role::Dispatch)
}

/// The sites that answer `name` with the given role: the listeners of a dispatched event, or the dispatches of a
/// listened one.
fn answers(all: &[Site], name: &str, role: Role) -> Vec<Site> {
    let mut out: Vec<Site> = all
        .iter()
        .filter(|s| match role {
            Role::Dispatch => s.role != Role::Dispatch && matches(&s.name, name),
            _ => s.role == Role::Dispatch && matches(name, &s.name),
        })
        .cloned()
        .collect();
    out.dedup();
    out
}

fn location(ctx: &Ctx<'_>, site: &Site) -> Option<(Location, u32)> {
    let text = ctx.snap.read(&site.path)?;
    let lines = LineIndex::new(&text);
    let range = lines.range(&text, site.start as u32, site.end as u32);
    Some((Location { uri: path_to_uri(&site.path), range }, range.start.line + 1))
}

pub fn definition(ctx: &Ctx<'_>, offset: u32) -> Vec<Location> {
    let Some((_, _, name, role)) = event_at(ctx, offset) else { return vec![] };
    let all = sites(&ctx.index, &|p| ctx.snap.read(p));
    // A dispatch goes to the components that listen; a listener to where it's dispatched.
    let mut found: Vec<Site> = answers(&all, &name, role);
    if role == Role::Dispatch && found.iter().any(|s| s.role == Role::Listen) {
        found.retain(|s| s.role == Role::Listen);
    }
    found.iter().filter_map(|s| location(ctx, s).map(|(l, _)| l)).collect()
}

pub fn hover(ctx: &Ctx<'_>, offset: u32) -> Option<Hover> {
    let (start, end, name, role) = event_at(ctx, offset)?;
    let all = sites(&ctx.index, &|p| ctx.snap.read(p));
    let found = answers(&all, &name, role);
    let root = &ctx.index.config.root;
    let line = |s: &Site| {
        let (l, n) = location(ctx, s)?;
        let rel = s.path.strip_prefix(root).unwrap_or(&s.path).to_string_lossy().into_owned();
        let label = if s.label.is_empty() { format!("{rel}:{n}") } else { format!("`{}` ({rel}:{n})", s.label) };
        Some(format!("- [{label}]({}#L{n})", l.uri.as_str()))
    };
    let section = |title: &str, role: Role| {
        let lines: Vec<String> = found.iter().filter(|s| s.role == role).filter_map(line).collect();
        (!lines.is_empty()).then(|| format!("{title}:\n{}", lines.join("\n")))
    };
    let parts: Vec<String> = match role {
        Role::Dispatch => [section("Listened for by", Role::Listen), section("Also heard by browser listeners", Role::Dom)].into_iter().flatten().collect(),
        _ => section("Dispatched from", Role::Dispatch).into_iter().collect(),
    };
    let heading = format!("Livewire event `{name}`");
    let value = if parts.is_empty() { format!("{heading}\n\nNo {} in the project.", if role == Role::Dispatch { "listener" } else { "dispatch" }) } else { format!("{heading}\n\n{}", parts.join("\n\n")) };
    Some(Hover { contents: HoverContents::Markup(MarkupContent { kind: MarkupKind::Markdown, value }), range: Some(ctx.doc.range(start as u32, end as u32)) })
}

pub fn completion(ctx: &Ctx<'_>, offset: u32) -> Option<Vec<CompletionItem>> {
    let (start, _, _, role) = event_at(ctx, offset)?;
    let all = sites(&ctx.index, &|p| ctx.snap.read(p));
    let range = ctx.doc.range(start as u32, offset);
    let mut names: Vec<(&str, &str)> = vec![];
    for s in &all {
        let wanted = match role {
            Role::Dispatch => s.role == Role::Listen && !echo(&s.name),
            _ => s.role == Role::Dispatch,
        };
        if wanted && !names.iter().any(|(n, _)| *n == s.name) {
            names.push((&s.name, &s.label));
        }
    }
    let items: Vec<CompletionItem> = names
        .into_iter()
        .map(|(name, label)| CompletionItem {
            label: name.to_string(),
            kind: Some(CompletionItemKind::EVENT),
            detail: (!label.is_empty()).then(|| label.to_string()),
            text_edit: Some(CompletionTextEdit::Edit(TextEdit { range, new_text: name.to_string() })),
            ..Default::default()
        })
        .collect();
    (!items.is_empty()).then_some(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_placeholders_in_listener_names() {
        assert!(matches("post-created", "post-created"));
        assert!(!matches("post-created", "post-created.1"));
        assert!(matches("post-updated.{post.id}", "post-updated.5"));
        assert!(matches("{a}.saved", "x.saved"));
        assert!(!matches("post-updated.{id}", "post-updated."));
        assert!(!matches("post-updated.{id}", "other.5"));
    }

    #[test]
    fn finds_events_in_javascript_and_alpine() {
        let view = "<button wire:click=\"$dispatch('post-created', { id: 1 })\" @post-created.window=\"x\" x-on:saved=\"y\">\n<script>Livewire.on('refreshed', () => {}); $wire.dispatchTo('feed', 'loaded'); window.addEventListener('notify', f); this.$dispatch('open-modal')</script>";
        let found: Vec<(String, Role)> = blade_sites(Path::new("/v.blade.php"), view).into_iter().map(|s| (s.name, s.role)).collect();
        assert_eq!(
            found,
            vec![
                ("post-created".into(), Role::Dispatch),
                ("refreshed".into(), Role::Listen),
                ("loaded".into(), Role::Dispatch),
                ("notify".into(), Role::Dom),
                ("open-modal".into(), Role::Dispatch),
                ("post-created".into(), Role::Dom),
                ("saved".into(), Role::Dom),
            ]
        );
    }

    #[test]
    fn finds_listeners_and_dispatches_in_php() {
        let php = "<?php\nnamespace App;\nuse Livewire\\Attributes\\On;\nclass Feed extends \\Livewire\\Component {\n    protected $listeners = ['refresh-feed' => 'reload', 'ping'];\n    #[On('post-created')]\n    #[On(event: ['a', 'b'])]\n    public function add() { $this->dispatch('feed-updated'); $other->dispatch('job'); }\n}\n";
        let found: Vec<(String, Role, String)> = php_sites(Path::new("/f.php"), php).into_iter().map(|s| (s.name, s.role, s.label)).collect();
        assert_eq!(
            found,
            vec![
                ("refresh-feed".into(), Role::Listen, "App\\Feed::reload".into()),
                ("ping".into(), Role::Listen, "App\\Feed::ping".into()),
                ("post-created".into(), Role::Listen, "App\\Feed::add".into()),
                ("a".into(), Role::Listen, "App\\Feed::add".into()),
                ("b".into(), Role::Listen, "App\\Feed::add".into()),
                ("feed-updated".into(), Role::Dispatch, String::new()),
            ]
        );
    }
}
