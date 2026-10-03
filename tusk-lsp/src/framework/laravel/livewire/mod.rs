//! Livewire: a component's Blade view and its class. A view's `wire:model` and `wire:click` values, and `$wire.` in
//! its Alpine expressions, complete, describe, and go to the class's public properties and methods, and are
//! checked against them; `#[Computed]` methods type `$this->name`; and events link `dispatch('name')` to the
//! components that listen with `#[On('name')]`.
//!
//! A view's class is the Livewire component that renders it: one whose `render()` (or any method) passes the
//! view's name to `view()`, one whose `$view` property names it, as a Filament page's does, or, without a
//! `render()`, the class Livewire's naming convention gives (`livewire.posts.edit-post` for
//! `App\Livewire\Posts\EditPost`). A Volt view declares its class in itself, as `new class extends Component`.

pub mod computed;
pub mod events;
pub mod view;
mod volt;

#[cfg(test)]
mod tests;

use std::path::Path;
use std::sync::{Arc, LazyLock};

use mago_allocator::LocalArena;
use mago_codex::metadata::CodebaseMetadata;
use mago_codex::ttype::atomic::TAtomic;
use mago_codex::ttype::atomic::object::TObject;
use mago_span::HasSpan;
use mago_syntax::cst::{Argument, Expression, Node};

use crate::analysis::Parsed;
use crate::index::Index;
use crate::locate::walk;
use crate::symbol::Resolver;

pub const COMPONENT: &str = "Livewire\\Component";
pub const FORM: &str = "Livewire\\Form";
const BASE_FORM: &str = "Livewire\\Features\\SupportFormObjects\\Form";
pub const COMPUTED: &str = "Livewire\\Attributes\\Computed";

/// What a component's member is, as its view reaches it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberKind {
    /// A public property, which `wire:model` binds and `$wire.name` reads.
    Property,
    /// A public method, which `wire:click` and `$wire.name()` call.
    Method,
    /// A `#[Computed]` method, or a `getNameProperty()` one, which the view reads as `$this->name`.
    Computed,
}

/// A public property or method of a component, or a computed property.
#[derive(Debug, Clone)]
pub struct Member {
    pub name: String,
    pub kind: MemberKind,
    /// The class that has it, for its hover and declaration, or `None` for a Volt component's own member.
    pub class: Option<String>,
    /// A Volt component's own member: its declaration's start and end in the view.
    pub volt: Option<(u32, u32)>,
    /// A property's type, or a method's parameters and return type, as a completion's detail.
    pub detail: String,
    /// A property's Form object class, whose public properties `wire:model="form.title"` reaches.
    pub form: Option<String>,
}

/// A Livewire component as its view sees it.
#[derive(Debug, Clone, Default)]
pub struct Component {
    pub classes: Vec<String>,
    pub members: Vec<Member>,
    /// Whether `members` lists every property the view can bind, so one that isn't there is surely missing: the
    /// classes and everything they extend and use are known, and none has a `__get()` of its own.
    pub all_properties: bool,
    /// Whether `members` lists every method the view can call, likewise, with no `__call()` of its own.
    pub all_methods: bool,
}

impl Component {
    pub fn member(&self, name: &str, kinds: &[MemberKind]) -> Option<&Member> {
        self.members.iter().find(|m| m.name == name && kinds.contains(&m.kind))
    }
}

/// The component whose view is the Blade file at `path` with `text`, if it's a Livewire view.
pub fn view_component(index: &Index, read: &dyn Fn(&Path) -> Option<String>, path: &Path, text: &str) -> Option<Component> {
    if let Some(component) = volt::component(index, path, text) {
        return Some(component);
    }
    let view = super::views::view_name(index, path)?;
    let classes = view_classes(index, read, &view);
    (!classes.is_empty()).then(|| component_of(index, classes))
}

/// The component of the Livewire classes `classes`, with the members any of them has.
pub fn component_of(index: &Index, classes: Vec<String>) -> Component {
    let mut component = Component { classes: vec![], members: vec![], all_properties: true, all_methods: true };
    for class in classes {
        let (props, methods) = class_members(index, &class, &mut component.members);
        component.all_properties &= props;
        component.all_methods &= methods;
        component.classes.push(class);
    }
    component
}

/// The Livewire classes that render `view`, by its name: those that pass it to `view()`, `View::make()`, or
/// `->view()`, or name it in a `$view` property, and the one Livewire's convention names for it, when that class
/// has no `render()`.
pub fn view_classes(index: &Index, read: &dyn Fn(&Path) -> Option<String>, view: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mentioned = super::views::code_mentions(index, read);
    for path in mentioned.get(view).into_iter().flatten().filter(|p| !p.to_string_lossy().ends_with(".blade.php")) {
        let Some(text) = read(path) else { continue };
        for (name, class) in rendered_views(index, path, &text).iter() {
            if name == view && !out.contains(class) {
                out.push(class.clone());
            }
        }
    }
    for class in conventional_classes(index, read, view) {
        if !out.contains(&class) {
            out.push(class);
        }
    }
    out
}

/// The views each Livewire class in `path` renders, as [`view_classes`] reads them, cached by the file's text.
fn rendered_views(index: &Index, path: &Path, text: &str) -> Arc<Vec<(String, String)>> {
    static FOUND: super::views::Cache<Arc<Vec<(String, String)>>> = LazyLock::new(Default::default);
    super::views::cached(&FOUND, index, (path, text), || Arc::new(find_rendered_views(index, path, text)))
}

fn find_rendered_views(index: &Index, path: &Path, text: &str) -> Vec<(String, String)> {
    let arena = LocalArena::new();
    let parsed = Parsed::new(&arena, path, text);
    let resolver = Resolver::new(&parsed, None, &index.codebase);
    let mut out = vec![];
    walk(&parsed, |node, ancestors| {
        let Node::LiteralString(lit) = node else { return };
        let Some(value) = lit.value.and_then(|v| std::str::from_utf8(v).ok()).filter(|v| !v.is_empty()) else { return };
        if !(renders(text, ancestors, lit.span.start.offset) || view_property(ancestors)) {
            return;
        }
        let Some(class) = resolver.enclosing_class(ancestors) else { return };
        if is_component(&index.codebase, &class) {
            out.push((value.to_string(), class));
        }
    });
    out
}

/// Whether the literal at `at` is the first argument of `view()`, `View::make()`, or `->view()`.
fn renders(text: &str, ancestors: &[Node<'_, '_>], at: u32) -> bool {
    let Some(i) = ancestors.iter().rposition(|n| matches!(n, Node::ArgumentList(_))) else { return false };
    let Node::ArgumentList(list) = ancestors[i] else { return false };
    let first = list.arguments.first().is_some_and(|a| matches!(a, Argument::Positional(p) if p.value.span().start.offset == at));
    let source = |span: mago_span::Span| &text[span.start.offset as usize..span.end.offset as usize];
    first
        && match ancestors[..i].iter().rev().find(|n| matches!(n, Node::FunctionCall(_) | Node::MethodCall(_) | Node::StaticMethodCall(_))) {
            Some(Node::FunctionCall(c)) => matches!(c.function, Expression::Identifier(id) if id.value().rsplit(|b| *b == b'\\').next().is_some_and(|n| n.eq_ignore_ascii_case(b"view"))),
            Some(Node::MethodCall(c)) => source(c.method.span()).eq_ignore_ascii_case("view"),
            Some(Node::StaticMethodCall(c)) => source(c.method.span()).eq_ignore_ascii_case("make"),
            _ => false,
        }
}

/// Whether a literal is the default of a property named `$view`, as a Filament page names its view.
pub(super) fn view_property(ancestors: &[Node<'_, '_>]) -> bool {
    ancestors.iter().rev().find_map(|n| match n {
        Node::PropertyConcreteItem(item) => Some(item.variable.name == b"$view"),
        Node::Method(_) | Node::Closure(_) | Node::ArrowFunction(_) | Node::Function(_) => Some(false),
        _ => None,
    }) == Some(true)
}

pub fn is_component(codebase: &CodebaseMetadata, class: &str) -> bool {
    codebase.is_instance_of(class.as_bytes(), COMPONENT.as_bytes())
}

/// The class namespaces Livewire's convention names components from: `config/livewire.php`'s
/// `class_namespace`, or `App\Livewire`.
fn namespaces(index: &Index, read: &dyn Fn(&Path) -> Option<String>) -> Vec<String> {
    let config = read(&index.config.root.join("config/livewire.php")).unwrap_or_default();
    let configured = config.find("'class_namespace'").and_then(|at| {
        let rest = &config[at + 17..];
        let rest = rest.trim_start().strip_prefix("=>")?.trim_start();
        let q = rest.chars().next().filter(|c| matches!(c, '\'' | '"'))?;
        let value = &rest[1..1 + rest[1..].find(q)?];
        Some(value.replace("\\\\", "\\"))
    });
    vec![configured.unwrap_or_else(|| "App\\Livewire".into())]
}

/// The class Livewire's convention names for a view in `resources/views/livewire`, when it exists, is a
/// component, and has no `render()`, which would name its view itself.
pub(super) fn conventional_classes(index: &Index, read: &dyn Fn(&Path) -> Option<String>, view: &str) -> Vec<String> {
    let Some(rest) = view.strip_prefix("livewire.") else { return vec![] };
    let studly = |part: &str| part.split(['-', '_']).map(|w| {
        let mut c = w.chars();
        c.next().map(|f| f.to_uppercase().chain(c).collect::<String>()).unwrap_or_default()
    }).collect::<String>();
    let relative: Vec<String> = rest.split('.').map(studly).collect();
    let codebase = &index.codebase;
    namespaces(index, read)
        .into_iter()
        .map(|ns| format!("{}\\{}", ns.trim_matches('\\'), relative.join("\\")))
        .filter(|class| is_component(codebase, class) && !codebase.method_exists(class.as_bytes(), b"render"))
        .map(|class| crate::types::display_class(&class, codebase))
        .collect()
}

/// The Livewire component class a `<livewire:name>` tag or `@livewire('name')` renders, by Livewire's convention.
pub fn tag_class(index: &Index, read: &dyn Fn(&Path) -> Option<String>, name: &str) -> Option<String> {
    let codebase = &index.codebase;
    // `Livewire::component('name', Class::class)` registrations aren't read; the convention covers the rest.
    let studly = |part: &str| part.split(['-', '_']).map(|w| {
        let mut c = w.chars();
        c.next().map(|f| f.to_uppercase().chain(c).collect::<String>()).unwrap_or_default()
    }).collect::<String>();
    let relative: Vec<String> = name.split('.').map(studly).collect();
    namespaces(index, read).into_iter().find_map(|ns| {
        let base = format!("{}\\{}", ns.trim_matches('\\'), relative.join("\\"));
        // `posts` may be `Posts\Index` too, as Livewire looks it up.
        [base.clone(), format!("{base}\\Index"), format!("{base}\\{}", relative.last()?)]
            .into_iter()
            .find(|c| is_component(codebase, c))
            .map(|c| crate::types::display_class(&c, codebase))
    })
}

/// Whether a method is one of Livewire's lifecycle hooks, which the view can call but has no reason to.
fn lifecycle(name: &str) -> bool {
    const HOOKS: &[&str] = &["mount", "boot", "booted", "hydrate", "dehydrate", "updating", "updated", "rendering", "rendered", "render", "exception", "placeholder"];
    HOOKS.iter().any(|h| name == *h || name.strip_prefix(h).is_some_and(|rest| rest.starts_with(char::is_uppercase)))
}

/// Whether the class `declaring` is Livewire's own, whose members a view doesn't reach.
fn livewires(declaring: &str) -> bool {
    declaring.to_ascii_lowercase().starts_with("livewire\\")
}

/// Adds `class`'s members to `out`, and says whether they're all its properties and all its methods. As Livewire
/// reads them, a property is public and not static, a method is public, not static, and not declared by
/// `Livewire\Component` (or Volt's), and a computed property is a `#[Computed]` method or a `getNameProperty()` one.
fn class_members(index: &Index, class: &str, out: &mut Vec<Member>) -> (bool, bool) {
    let codebase = &index.codebase;
    let Some(meta) = codebase.get_class_like(class.as_bytes()) else { return (false, false) };
    let owner = meta.original_name.as_str_lossy().into_owned();
    let known = meta.invalid_dependencies.is_empty()
        && meta.all_parent_classes.iter().all(|p| codebase.class_like_exists(p.as_bytes()))
        && meta.used_traits.iter().all(|t| codebase.class_like_exists(t.as_bytes()));
    let own = |magic: &[u8]| codebase.get_declaring_method_class(class.as_bytes(), magic).is_some_and(|d| !livewires(&d.as_str_lossy()));
    for (name, declaring) in meta.declaring_property_ids.iter() {
        let Some(p) = codebase.get_property(declaring.as_bytes(), name.as_bytes()) else { continue };
        if !p.read_visibility.is_public() || p.flags.is_static() || livewires(&declaring.as_str_lossy()) {
            continue;
        }
        let t = p.type_metadata.as_ref().or(p.type_declaration_metadata.as_ref()).map(|t| &t.type_union);
        let form = t.and_then(|t| match t.types.as_ref() {
            [TAtomic::Object(TObject::Named(n))] if codebase.is_instance_of(n.name.as_bytes(), FORM.as_bytes()) => Some(crate::types::display_class(&n.name.as_str_lossy(), codebase)),
            _ => None,
        });
        out.push(Member {
            name: name.as_str_lossy().trim_start_matches('$').to_string(),
            kind: MemberKind::Property,
            class: Some(owner.clone()),
            volt: None,
            detail: t.map(crate::types::display).unwrap_or_default(),
            form,
        });
    }
    for id in meta.appearing_method_ids.values() {
        let declaring = codebase.get_declaring_method_identifier(id);
        let Some(m) = codebase.get_method_by_id(&declaring) else { continue };
        let Some(mm) = m.method_metadata.as_ref() else { continue };
        let name = m.original_name.as_str_lossy().into_owned();
        let computed = m.attributes.iter().any(|a| a.name.as_bytes().eq_ignore_ascii_case(COMPUTED.as_bytes()));
        let legacy = name.strip_prefix("get").and_then(|n| n.strip_suffix("Property")).filter(|n| n.starts_with(char::is_uppercase));
        let returns = m.return_type_metadata.as_ref().or(m.return_type_declaration_metadata.as_ref()).map(|t| crate::types::display(&t.type_union));
        if computed || legacy.is_some() {
            let property = legacy.map_or(name.clone(), |n| {
                let mut c = n.chars();
                c.next().map(|f| f.to_lowercase().chain(c).collect()).unwrap_or_default()
            });
            out.push(Member { name: property, kind: MemberKind::Computed, class: Some(owner.clone()), volt: None, detail: returns.clone().unwrap_or_default(), form: None });
        }
        // A computed property's method throws when it's called.
        if computed || legacy.is_some() || !mm.visibility.is_public() || mm.is_static || livewires(&declaring.get_class_name().as_str_lossy()) || name.starts_with("__") {
            continue;
        }
        let params: Vec<String> = m.parameters.iter().map(|p| format!("${}", p.name.0.as_str_lossy().trim_start_matches('$'))).collect();
        let detail = format!("({}){}", params.join(", "), returns.map(|r| format!(": {r}")).unwrap_or_default());
        out.push(Member { name, kind: MemberKind::Method, class: Some(owner.clone()), volt: None, detail, form: None });
    }
    (known && !own(b"__get"), known && !own(b"__call"))
}

/// The public properties of a Livewire Form object, and whether they're all of them.
pub fn form_members(index: &Index, form: &str) -> (Vec<Member>, bool) {
    let codebase = &index.codebase;
    let Some(meta) = codebase.get_class_like(form.as_bytes()) else { return (vec![], false) };
    let known = meta.invalid_dependencies.is_empty() && meta.all_parent_classes.iter().all(|p| codebase.class_like_exists(p.as_bytes()));
    let magic = codebase.get_declaring_method_class(form.as_bytes(), b"__get").is_some_and(|d| !livewires(&d.as_str_lossy()));
    let mut out = vec![];
    for (name, declaring) in meta.declaring_property_ids.iter() {
        let Some(p) = codebase.get_property(declaring.as_bytes(), name.as_bytes()) else { continue };
        let base = [FORM, BASE_FORM].iter().any(|b| declaring.as_bytes().eq_ignore_ascii_case(b.as_bytes()));
        if !p.read_visibility.is_public() || p.flags.is_static() || base {
            continue;
        }
        let t = p.type_metadata.as_ref().or(p.type_declaration_metadata.as_ref()).map(|t| crate::types::display(&t.type_union));
        out.push(Member {
            name: name.as_str_lossy().trim_start_matches('$').to_string(),
            kind: MemberKind::Property,
            class: Some(meta.original_name.as_str_lossy().into_owned()),
            volt: None,
            detail: t.unwrap_or_default(),
            form: None,
        });
    }
    (out, known && !magic)
}

/// Completions in a Livewire view's `wire:` and Alpine attributes and `<livewire:name>` tags, and in event names.
pub fn completion(ctx: &crate::features::Ctx<'_>, offset: u32) -> Option<Vec<lsp_types::CompletionItem>> {
    if crate::features::is_blade(&ctx.doc)
        && let Some(items) = view::completion(ctx, offset)
    {
        return Some(items);
    }
    events::completion(ctx, offset)
}

pub fn hover(ctx: &crate::features::Ctx<'_>, offset: u32) -> Option<lsp_types::Hover> {
    if crate::features::is_blade(&ctx.doc)
        && let Some(hover) = view::hover(ctx, offset)
    {
        return Some(hover);
    }
    events::hover(ctx, offset)
}

pub fn definition(ctx: &crate::features::Ctx<'_>, offset: u32) -> Vec<lsp_types::Location> {
    let mut out = if crate::features::is_blade(&ctx.doc) { view::definition(ctx, offset) } else { vec![] };
    if out.is_empty() {
        out = events::definition(ctx, offset);
    }
    out
}

pub fn diagnostics(ctx: &crate::features::Ctx<'_>) -> Vec<lsp_types::Diagnostic> {
    if crate::features::is_blade(&ctx.doc) { view::diagnostics(ctx) } else { vec![] }
}
