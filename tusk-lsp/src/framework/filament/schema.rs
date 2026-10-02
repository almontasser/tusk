//! Filament schemas as a file writes them: which component holds which, and the state path each field gets,
//! so `$get('../../title')` resolves as Filament resolves it.
//!
//! ```php
//! $schema->components([                      // a root: state path `data` on a page, written as []
//!     TextInput::make('title'),              // ["title"]
//!     Section::make('Details')->schema([     // layouts add nothing to the path
//!         Repeater::make('items')->schema([  // ["items"]; its items' schemas are at ["items", "*"]
//!             TextInput::make('qty')         // ["items", "*", "qty"]
//!                 ->live()
//!                 ->afterStateUpdated(fn (Set $set) => $set('../../total', 0)),
//!         ]),
//!     ]),
//! ])
//! ```
//!
//! A closure's `$get` belongs to the component whose chain passes it, and resolves paths against the schema
//! that component is in: `../` leaves one segment of that schema's path, and a repeater item's path has two,
//! the repeater's name and the item's key. A builder block's fields are at `["content", "*", "data"]`; the
//! item key is written `*block` there so that one block's fields don't count as another's.

use std::collections::HashSet;

use mago_span::HasSpan;
use mago_syntax::cst::{Argument, ArrayElement, Call, Expression, Literal, MethodCall, Node, StaticMethodCall};

use crate::analysis::Parsed;
use crate::features::Ctx;
use crate::locate::walk;
use crate::scope::{resolve_class, scope_at};

/// The base classes of schema components in Filament 4 and later, and in Filament 3's forms and infolists.
const COMPONENTS: &[&str] =
    &["Filament\\Schemas\\Components\\Component", "Filament\\Forms\\Components\\Component", "Filament\\Infolists\\Components\\Component"];
const FIELDS: &[&str] = &["Filament\\Forms\\Components\\Field", "Filament\\Infolists\\Components\\Entry"];
/// Filament's components that hold others without state of their own, for a project whose index lacks them.
const LAYOUTS: &[&str] = &[
    "Actions",
    "Callout",
    "Card",
    "Component",
    "Div",
    "EmptyState",
    "Fieldset",
    "Flex",
    "Form",
    "FusedGroup",
    "Grid",
    "Group",
    "Html",
    "Icon",
    "Image",
    "Livewire",
    "Placeholder",
    "Section",
    "Split",
    "Step",
    "Tab",
    "Tabs",
    "Text",
    "UnorderedList",
    "View",
    "Wizard",
];
/// The methods that take a component's child components (or, for `make`, may: `Group::make([...])`).
const CHILDREN: &[&str] = &["schema", "components", "childComponents", "tabs", "steps", "blocks", "simple"];
/// `Get`'s methods that read a path, such as `$get->string('title')`.
pub const GET_METHODS: &[&str] = &["string", "integer", "float", "boolean", "array", "date", "enum", "filled", "blank"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A component with state: a form field or an infolist entry.
    Field,
    Repeater,
    Builder,
    /// A builder's block: `Block::make('heading')`, whose name is a type, not a field.
    Block,
    /// A component without state, such as a section.
    Layout,
}

pub struct Comp<'a> {
    pub class: String,
    pub kind: Kind,
    pub make: &'a StaticMethodCall<'a>,
    /// The calls after `make`, first one first.
    pub chain: Vec<&'a MethodCall<'a>>,
    /// The span of the whole chain.
    pub span: (u32, u32),
    pub root: usize,
    /// The state path of the schema the component is in, from its root.
    pub container: Vec<String>,
    /// A field's name as written, and the span of its text without quotes.
    pub name: Option<(String, u32, u32)>,
}

impl Comp<'_> {
    /// A field's state path from its root.
    pub fn path(&self) -> Option<Vec<String>> {
        let (name, ..) = self.name.as_ref()?;
        let mut path = self.container.clone();
        path.extend(segments(name));
        Some(path)
    }

    pub fn short_class(&self) -> &str {
        self.class.rsplit('\\').next().unwrap_or(&self.class)
    }
}

pub struct Root {
    /// Whether the file lists every component: a literal array passed to `->components()` or `->schema()`.
    pub complete: bool,
    /// Whether it's a page's or resource's form (`$schema->components([...])`), filled from the record.
    pub form: bool,
}

/// Where a path leads from a schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolved {
    Path(Vec<String>),
    /// Above the root, into the Livewire component's own properties.
    Outside,
    /// An absolute path, which starts with the form's own state path, such as `data`.
    Absolute,
}

#[derive(Default)]
pub struct Schema<'a> {
    pub comps: Vec<Comp<'a>>,
    pub roots: Vec<Root>,
    /// Schemas, by root and path, whose children the file doesn't fully list.
    open: HashSet<(usize, Vec<String>)>,
    /// Schemas filled from a relationship's records, so they hold the related model's attributes too.
    related: HashSet<(usize, Vec<String>)>,
    containers: HashSet<(usize, Vec<String>)>,
    /// Paths written with `$set`, which reads with `$get` find even without a field.
    written: HashSet<(usize, Vec<String>)>,
    /// Variables that hold `Get` and `Set` utilities, besides `$get` and `$set`.
    pub getters: HashSet<String>,
    pub setters: HashSet<String>,
}

pub fn segments(path: &str) -> Vec<String> {
    path.split('.').filter(|s| !s.is_empty()).map(String::from).collect()
}

/// Whether two path segments can be the same: equal, or one of them a repeater item's key.
fn same(a: &str, b: &str) -> bool {
    a == b || (a.starts_with('*') != b.starts_with('*'))
}

/// Whether `prefix` starts `path`, segment by segment.
fn starts(path: &[String], prefix: &[String]) -> bool {
    prefix.len() <= path.len() && prefix.iter().zip(path).all(|(a, b)| same(a, b))
}

/// Resolves `path` from a schema at `container`, as Filament's `resolveRelativeStatePath()` does.
pub fn resolve(container: &[String], path: &str, absolute: bool) -> Resolved {
    if absolute || path.starts_with('/') {
        return Resolved::Absolute;
    }
    let mut at = container.to_vec();
    let mut rest = path;
    while let Some(r) = rest.strip_prefix("../") {
        if at.pop().is_none() {
            return Resolved::Outside;
        }
        rest = r;
    }
    at.extend(segments(rest));
    Resolved::Path(at)
}

impl<'a> Schema<'a> {
    /// The component a closure at `offset` belongs to: the innermost one whose chain holds it.
    pub fn owner(&self, offset: u32) -> Option<&Comp<'a>> {
        self.comps.iter().filter(|c| c.span.0 <= offset && offset <= c.span.1).min_by_key(|c| c.span.1 - c.span.0)
    }

    /// The fields at a path in a root.
    pub fn fields_at(&self, root: usize, path: &[String]) -> Vec<&Comp<'a>> {
        self.comps.iter().filter(|c| c.root == root && c.path().is_some_and(|p| p.len() == path.len() && starts(&p, path))).collect()
    }

    /// Whether a path in a root holds state: a field's, a part of one (`tags.0`), the state of a schema or of
    /// a field's parent (`meta` for `meta.title`), or a path a `$set` writes.
    pub fn known(&self, root: usize, path: &[String]) -> bool {
        // A path inside a field's or a written value is known unless a schema of its own lays it out, as a
        // repeater's items schema does.
        let laid_out = |p: &[String]| self.containers.iter().any(|(r, c)| *r == root && c.len() > p.len() && starts(c, p));
        let inside = |c: &Comp<'_>, p: &[String]| c.kind == Kind::Field && !laid_out(p) && starts(path, p);
        let mut written = self.written.iter().filter(|(r, p)| *r == root && !p.is_empty()).map(|(_, p)| p);
        self.comps.iter().filter(|c| c.root == root).any(|c| c.path().is_some_and(|p| starts(&p, path) || inside(c, &p)))
            || written.any(|p| starts(p, path) || (starts(path, p) && !laid_out(p)))
            || self.containers.iter().any(|(r, p)| *r == root && starts(p, path))
    }

    /// Whether the file lists every field of the schema at `path`, so a read of a missing one surely finds
    /// nothing: a repeater's or builder's items, or a page's or resource's form when `form_ok` is true.
    pub fn certain(&self, root: usize, path: &[String], form_ok: bool) -> bool {
        let key = (root, path.to_vec());
        if !self.containers.contains(&key) || self.open.contains(&key) || self.related.contains(&key) {
            return false;
        }
        let r = &self.roots[root];
        !path.is_empty() || (r.complete && r.form && form_ok)
    }

    /// Fields reachable from a schema at `container`, as each is written from there: siblings by name, the
    /// others with `../` to the schema they share. Returns each field, how to write its path, and how many
    /// schemas up that goes.
    pub fn reachable(&self, root: usize, container: &[String]) -> Vec<(&Comp<'a>, String, usize)> {
        let mut out = vec![];
        for comp in self.comps.iter().filter(|c| c.root == root) {
            let Some(path) = comp.path() else { continue };
            // The longest shared start, leaving at least the field's own name.
            let shared = container.iter().zip(&path).take_while(|(a, b)| same(a, b)).count().min(path.len() - 1);
            // An item's fields can't be reached from outside it without the item's key.
            if path[shared..].iter().any(|s| s.starts_with('*')) {
                continue;
            }
            let up = container.len() - shared;
            out.push((comp, format!("{}{}", "../".repeat(up), path[shared..].join(".")), up));
        }
        out
    }
}

struct Builder<'c, 'a> {
    ctx: &'c Ctx<'c>,
    parsed: &'c Parsed<'a>,
    schema: Schema<'a>,
    /// Array literals already read as lists of children, by start.
    arrays: HashSet<u32>,
    /// Chains already read, by start.
    chains: HashSet<u32>,
}

enum Chain<'a> {
    Component(&'a StaticMethodCall<'a>, Vec<&'a MethodCall<'a>>, String),
    /// A `make()` chain of something else, such as an action.
    Other,
    None,
}

/// Reads every schema in a parsed file.
pub fn build<'a>(ctx: &Ctx<'_>, parsed: &Parsed<'a>) -> Schema<'a> {
    let mut b = Builder { ctx, parsed, schema: Schema::default(), arrays: HashSet::new(), chains: HashSet::new() };
    walk(parsed, |node, path| b.visit(node, path));
    let mut schema = b.schema;
    schema.written = written(ctx, &schema);
    schema
}

impl<'c, 'a> Builder<'c, 'a> {
    fn visit(&mut self, node: Node<'a, 'a>, path: &[Node<'a, 'a>]) {
        match node {
            Node::FunctionLikeParameter(p) => {
                let Some(hint) = &p.hint else { return };
                let hint = self.text(hint.span().start.offset, hint.span().end.offset);
                let var = String::from_utf8_lossy(p.variable.name).into_owned();
                match hint.rsplit('\\').next() {
                    Some("Get") => {
                    self.schema.getters.insert(var);
                }
                    Some("Set") => {
                    self.schema.setters.insert(var);
                }
                    _ => {}
                }
            }
            Node::Array(a) => self.root_array(a.span().start.offset, a.elements.iter(), path),
            Node::LegacyArray(a) => self.root_array(a.span().start.offset, a.elements.iter(), path),
            // A component outside any array, such as one a method returns, starts a schema the file only shows
            // part of. Its chain's inner calls start where it does, so they're skipped.
            Node::Expression(e @ Expression::Call(_)) if !self.chains.contains(&e.span().start.offset) => {
                if let Chain::Component(make, chain, class) = self.chain(e) {
                    let root = self.root(false, false);
                    self.add(make, chain, class, (e.span().start.offset, e.span().end.offset), root, &[]);
                }
            }
            _ => {}
        }
    }
}

/// The paths `$set` calls write, resolved from each one's schema.
fn written(ctx: &Ctx<'_>, schema: &Schema<'_>) -> HashSet<(usize, Vec<String>)> {
    let text = &ctx.doc.text;
    let mut out = HashSet::new();
    for var in schema.setters.iter().map(String::as_str).chain(["$set"]) {
        let call = format!("{var}(");
        for (at, _) in text.match_indices(&call) {
            let rest = text[at + call.len()..].trim_start();
            let Some(quote) = rest.chars().next().filter(|q| *q == '\'' || *q == '"') else {
                continue;
            };
            let Some(end) = rest[1..].find(quote) else {
                continue;
            };
            let Some(owner) = schema.owner(at as u32) else {
                continue;
            };
            if let Resolved::Path(p) = resolve(&owner.container, &rest[1..1 + end], false) {
                out.insert((owner.root, p));
            }
        }
    }
    out
}

impl<'c, 'a> Builder<'c, 'a> {
    fn text(&self, start: u32, end: u32) -> &str {
        self.parsed.text().get(start as usize..end as usize).unwrap_or_default()
    }

    fn root(&mut self, complete: bool, form: bool) -> usize {
        self.schema.roots.push(Root { complete, form });
        let root = self.schema.roots.len() - 1;
        self.schema.containers.insert((root, vec![]));
        if !complete {
            self.schema.open.insert((root, vec![]));
        }
        root
    }

    /// An array of components that isn't a component's children starts a schema of its own.
    fn root_array(&mut self, start: u32, elements: impl Iterator<Item = &'a ArrayElement<'a>> + Clone, path: &[Node<'a, 'a>]) {
        if self.arrays.contains(&start) || !elements.clone().any(|e| self.element_is_component(e)) {
            return;
        }
        // The call it's passed to: `$schema->components([...])` lists a whole form; an action's
        // `->schema([...])` its modal's.
        let call = path
            .iter()
            .rev()
            .find(|n| !matches!(n, Node::Expression(_) | Node::Argument(_) | Node::PositionalArgument(_) | Node::NamedArgument(_) | Node::ArgumentList(_)))
            .and_then(|n| match n {
                Node::MethodCall(c) => Some(*c),
                _ => None,
            });
        let (complete, form) = match call {
            Some(c) if ["components", "schema"].contains(&self.text(c.method.span().start.offset, c.method.span().end.offset)) => {
                let mut base = c.object;
                while let Expression::Call(Call::Method(m)) = base {
                    base = m.object;
                }
                (true, matches!(base, Expression::Variable(_)))
            }
            _ => (false, false),
        };
        let root = self.root(complete, form);
        self.arrays.insert(start);
        for e in elements {
            self.element(e, root, &[]);
        }
    }

    fn element_is_component(&self, e: &'a ArrayElement<'a>) -> bool {
        match e {
            ArrayElement::Value(v) => matches!(self.chain(v.value), Chain::Component(..)),
            ArrayElement::KeyValue(kv) => matches!(self.chain(kv.value), Chain::Component(..)),
            _ => false,
        }
    }

    fn element(&mut self, e: &'a ArrayElement<'a>, root: usize, container: &[String]) {
        match e {
            ArrayElement::Value(v) => self.item(v.value, root, container),
            ArrayElement::KeyValue(kv) => self.item(kv.value, root, container),
            ArrayElement::Variadic(_) => {
                self.schema.open.insert((root, container.to_vec()));
            }
            ArrayElement::Missing(_) => {}
        }
    }

    /// One child: a component, a condition choosing between components, or something the file doesn't show.
    fn item(&mut self, expr: &'a Expression<'a>, root: usize, container: &[String]) {
        match expr {
            Expression::Parenthesized(p) => return self.item(p.expression, root, container),
            Expression::Conditional(c) => {
                if let Some(then) = c.then {
                    self.item(then, root, container);
                }
                return self.item(c.r#else, root, container);
            }
            Expression::Literal(Literal::Null(_)) => return,
            _ => {}
        }
        match self.chain(expr) {
            Chain::Component(make, chain, class) => {
                self.add(make, chain, class, (expr.span().start.offset, expr.span().end.offset), root, container);
            }
            Chain::Other => {}
            Chain::None => {
                self.schema.open.insert((root, container.to_vec()));
            }
        }
    }

    /// Reads a `X::make(...)->...` chain.
    fn chain(&self, expr: &'a Expression<'a>) -> Chain<'a> {
        let mut chain = vec![];
        let mut e = expr;
        loop {
            match e {
                Expression::Call(Call::Method(c)) => {
                    chain.push(c);
                    e = c.object;
                }
                Expression::Parenthesized(p) => e = p.expression,
                Expression::Call(Call::StaticMethod(s)) => {
                    if self.text(s.method.span().start.offset, s.method.span().end.offset) != "make" {
                        return Chain::None;
                    }
                    let Expression::Identifier(id) = s.class else {
                        return Chain::None;
                    };
                    let class = match self.parsed.names.resolve(&id.span()) {
                        Some(fqn) => String::from_utf8_lossy(fqn).into_owned(),
                        None => resolve_class(&scope_at(self.parsed.program, id.span().start.offset), &String::from_utf8_lossy(id.value())),
                    };
                    let class = class.trim_start_matches('\\').to_string();
                    if !self.is_component(&class) {
                        return Chain::Other;
                    }
                    chain.reverse();
                    return Chain::Component(s, chain, class);
                }
                _ => return Chain::None,
            }
        }
    }

    fn is_component(&self, class: &str) -> bool {
        let codebase = &self.ctx.index.codebase;
        if codebase.get_class_like(class.as_bytes()).is_some() {
            return COMPONENTS.iter().any(|b| codebase.is_instance_of(class.as_bytes(), b.as_bytes()));
        }
        class.starts_with("Filament\\") && class.contains("\\Components\\")
    }

    fn kind(&self, class: &str) -> Kind {
        let codebase = &self.ctx.index.codebase;
        let is = |want: &str| class.eq_ignore_ascii_case(want) || codebase.is_instance_of(class.as_bytes(), want.as_bytes());
        if codebase.get_class_like(class.as_bytes()).is_some() {
            return if is("Filament\\Forms\\Components\\Builder\\Block") {
                Kind::Block
            } else if is("Filament\\Forms\\Components\\Repeater") {
                Kind::Repeater
            } else if is("Filament\\Forms\\Components\\Builder") {
                Kind::Builder
            } else if FIELDS.iter().any(|f| is(f)) {
                Kind::Field
            } else {
                Kind::Layout
            };
        }
        match class.rsplit('\\').next().unwrap_or(class) {
            "Repeater" | "TableRepeater" => Kind::Repeater,
            "Builder" => Kind::Builder,
            "Block" => Kind::Block,
            short if LAYOUTS.contains(&short) => Kind::Layout,
            _ => Kind::Field,
        }
    }

    /// The first argument of a call when it's a plain string, with the span of its text.
    fn first_string(&self, list: &'a mago_syntax::cst::ArgumentList<'a>) -> Option<(String, u32, u32)> {
        let value = match list.arguments.iter().next()? {
            Argument::Positional(p) => p.value,
            Argument::Named(n) => n.value,
        };
        let Expression::Literal(Literal::String(s)) = value else {
            return None;
        };
        let (start, end) = (s.span.start.offset + 1, s.span.end.offset.saturating_sub(1));
        (start <= end).then(|| (self.text(start, end).to_string(), start, end))
    }

    fn method_name(&self, c: &MethodCall<'_>) -> &str {
        self.text(c.method.span().start.offset, c.method.span().end.offset)
    }

    fn add(
        &mut self,
        make: &'a StaticMethodCall<'a>,
        chain: Vec<&'a MethodCall<'a>>,
        class: String,
        span: (u32, u32),
        root: usize,
        container: &[String],
    ) {
        self.chains.insert(span.0);
        let kind = self.kind(&class);
        let stateful = matches!(kind, Kind::Field | Kind::Repeater | Kind::Builder);
        let name = if stateful { self.first_string(&make.argument_list) } else { None };
        if stateful && name.is_none() {
            // A field named by a variable: its schema has a field the file doesn't name.
            self.schema.open.insert((root, container.to_vec()));
        }
        let comp = Comp { class, kind, make, chain: chain.clone(), span, root, container: container.to_vec(), name };
        let path = comp.path();
        // The schema the component's children are in.
        let mut related = false;
        let children: Option<Vec<String>> = match kind {
            Kind::Repeater | Kind::Builder => path.map(|mut p| {
                related = kind == Kind::Repeater && chain.iter().any(|c| self.method_name(c) == "relationship");
                p.push("*".into());
                p
            }),
            Kind::Block => {
                let block = self.first_string(&make.argument_list).map(|(n, ..)| n).unwrap_or_default();
                let mut p = container.to_vec();
                if p.last().is_some_and(|s| s == "*") {
                    p.pop();
                    p.push(format!("*{block}"));
                }
                p.push("data".into());
                Some(p)
            }
            Kind::Field => path,
            Kind::Layout => {
                let mut p = container.to_vec();
                for c in &chain {
                    let method = self.method_name(c).to_string();
                    if method == "statePath" || method == "relationship" {
                        match self.first_string(&c.argument_list) {
                            Some((s, ..)) => p.extend(segments(&s)),
                            None => {
                                self.schema.open.insert((root, container.to_vec()));
                            }
                        }
                        related |= method == "relationship";
                    }
                }
                Some(p)
            }
        };
        self.schema.comps.push(comp);
        let Some(children) = children else { return };
        self.schema.containers.insert((root, children.clone()));
        if related {
            self.schema.related.insert((root, children.clone()));
        }
        for arg in make.argument_list.arguments.iter() {
            let (Argument::Positional(mago_syntax::cst::PositionalArgument { value, .. })
            | Argument::Named(mago_syntax::cst::NamedArgument { value, .. })) = arg;
            if matches!(value, Expression::Array(_) | Expression::LegacyArray(_)) {
                self.children(value, root, &children);
            }
        }
        for c in chain {
            if !CHILDREN.contains(&self.method_name(c)) {
                continue;
            }
            for arg in c.argument_list.arguments.iter() {
                let value = match arg {
                    Argument::Positional(p) => p.value,
                    Argument::Named(n) => n.value,
                };
                self.children(value, root, &children);
            }
        }
    }

    /// The children passed as one argument: an array, a closure returning arrays, or a single component.
    fn children(&mut self, expr: &'a Expression<'a>, root: usize, container: &[String]) {
        match expr {
            Expression::Array(a) => {
                self.arrays.insert(a.span().start.offset);
                for e in a.elements.iter() {
                    self.element(e, root, container);
                }
            }
            Expression::LegacyArray(a) => {
                self.arrays.insert(a.span().start.offset);
                for e in a.elements.iter() {
                    self.element(e, root, container);
                }
            }
            Expression::ArrowFunction(f) => self.children(f.expression, root, container),
            Expression::Closure(c) => {
                let mut returns = vec![];
                returned(Node::Block(&c.body), &mut returns);
                if returns.is_empty() {
                    self.schema.open.insert((root, container.to_vec()));
                }
                for r in returns {
                    self.children(r, root, container);
                }
            }
            Expression::Parenthesized(p) => self.children(p.expression, root, container),
            Expression::Conditional(c) => {
                if let Some(then) = c.then {
                    self.children(then, root, container);
                }
                self.children(c.r#else, root, container);
            }
            Expression::Literal(Literal::Null(_)) => {}
            other => self.item(other, root, container),
        }
    }
}

/// The values a function body returns, outside nested functions.
fn returned<'a>(node: Node<'a, 'a>, out: &mut Vec<&'a Expression<'a>>) {
    match node {
        Node::Closure(_) | Node::ArrowFunction(_) | Node::Function(_) | Node::AnonymousClass(_) => {}
        Node::Return(r) => out.extend(r.value),
        _ => node.visit_children(|child| returned(child, out)),
    }
}

/// Filament's label for a field without `->label()`: its name's last segment in words.
pub fn default_label(name: &str) -> String {
    let last = name.rsplit('.').next().unwrap_or(name);
    let mut words = String::new();
    for (i, c) in last.chars().enumerate() {
        if c == '_' || c == '-' {
            words.push(' ');
        } else if c.is_uppercase() && i > 0 {
            words.push(' ');
            words.extend(c.to_lowercase());
        } else {
            words.push(c);
        }
    }
    let mut chars = words.chars();
    chars.next().map(|f| f.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Vec<String> {
        segments(s)
    }

    #[test]
    fn resolves_paths_as_filament_does() {
        assert_eq!(resolve(&p("items.*"), "qty", false), Resolved::Path(p("items.*.qty")));
        assert_eq!(resolve(&p("items.*"), "../../total", false), Resolved::Path(p("total")));
        assert_eq!(resolve(&p("items.*"), "../", false), Resolved::Path(p("items")));
        assert_eq!(resolve(&[], "../x", false), Resolved::Outside);
        assert_eq!(resolve(&[], "/data.x", false), Resolved::Absolute);
        assert_eq!(resolve(&[], "x", true), Resolved::Absolute);
        assert_eq!(default_label("author_id"), "Author id");
        assert_eq!(default_label("meta.firstName"), "First name");
    }
}
