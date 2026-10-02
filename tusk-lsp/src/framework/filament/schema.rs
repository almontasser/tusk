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

use std::collections::{HashMap, HashSet};

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
    pub fill: Fill,
    /// The Livewire property path the schema's state is at, which absolute paths start with: `data` for a
    /// resource's form, a Livewire form's `->statePath()`, or nothing when its fields are properties themselves.
    /// `None` when the file doesn't show it, as for an action's modal (`mountedActions.0.data`).
    pub state_path: Option<Vec<String>>,
    /// The model a Livewire form names with `->model(X::class)`, whose relationships its fields use.
    pub model: Option<String>,
}

/// What a root schema's state holds besides its fields' state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fill {
    /// A resource's form, filled from the record: the model's attributes too.
    Record,
    /// Only its fields' state and the keys the file fills it with: an action modal that fills it with
    /// nothing or with a literal array, or a Livewire form whose class fills it only that way.
    Fields,
    /// Something the file doesn't show, such as an `EditAction`'s record or a `fill()` of a variable.
    Unknown,
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
    /// Schemas filled from a relationship's records, so they hold the related model's attributes too. A
    /// relationship repeater's items at the top of a form have the relationship's name, when no closure
    /// changes its query or the records' data, so the related model's attributes tell which keys they hold.
    related: HashMap<(usize, Vec<String>), Option<String>>,
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

/// Resolves `path` from a schema at `container`, as Filament's `resolveRelativeStatePath()` does. An absolute
/// path (`/data.title`, or any path with `isAbsolute: true`) starts at the Livewire component, so it's in the
/// schema when it starts with the root's `state_path`.
pub fn resolve(state_path: Option<&[String]>, container: &[String], path: &str, absolute: bool) -> Resolved {
    if let Some(rest) = path.strip_prefix('/').or(absolute.then_some(path)) {
        let Some(state_path) = state_path else { return Resolved::Absolute };
        let rest = segments(rest);
        return match rest.strip_prefix(state_path) {
            Some(inside) => Resolved::Path(inside.to_vec()),
            None => Resolved::Outside,
        };
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
    /// Resolves a path from a schema at `container` in `root`; see [`resolve`].
    pub fn resolve(&self, root: usize, container: &[String], path: &str, absolute: bool) -> Resolved {
        resolve(self.roots[root].state_path.as_deref(), container, path, absolute)
    }

    /// The relationship whose records fill the schema at `path`, if its items' keys can be known; see
    /// `related`.
    pub fn relationship(&self, root: usize, path: &[String]) -> Option<&str> {
        self.related.get(&(root, path.to_vec()))?.as_deref()
    }

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
    /// nothing: a repeater's or builder's items, a root that holds only its fields, or else what `attributes_ok`
    /// says, which the caller knows from the model: that a resource's form, or a relationship's items, have no
    /// attribute of that name.
    pub fn certain(&self, root: usize, path: &[String], attributes_ok: bool) -> bool {
        let key = (root, path.to_vec());
        if !self.containers.contains(&key) || self.open.contains(&key) {
            return false;
        }
        if let Some(relationship) = self.related.get(&key) {
            return relationship.is_some() && attributes_ok;
        }
        let r = &self.roots[root];
        !path.is_empty()
            || (r.complete
                && match r.fill {
                    Fill::Fields => true,
                    Fill::Record => attributes_ok,
                    Fill::Unknown => false,
                })
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
    /// Keys an action's `fillForm([...])` or a Livewire form's `fill([...])` puts in a root.
    filled: Vec<(usize, Vec<String>)>,
}

enum Chain<'a> {
    Component(&'a StaticMethodCall<'a>, Vec<&'a MethodCall<'a>>, String),
    /// A `make()` chain of something else, such as an action.
    Other,
    None,
}

/// Reads every schema in a parsed file.
pub fn build<'a>(ctx: &Ctx<'_>, parsed: &Parsed<'a>) -> Schema<'a> {
    let mut b = Builder { ctx, parsed, schema: Schema::default(), arrays: HashSet::new(), chains: HashSet::new(), filled: vec![] };
    walk(parsed, |node, path| b.visit(node, path));
    let mut schema = b.schema;
    schema.written = written(ctx, &schema);
    schema.written.extend(b.filled);
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
                    let root = self.root(false, Fill::Unknown, None);
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
            if let Resolved::Path(p) = schema.resolve(owner.root, &owner.container, &rest[1..1 + end], false) {
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

    fn root(&mut self, complete: bool, fill: Fill, state_path: Option<Vec<String>>) -> usize {
        self.schema.roots.push(Root { complete, fill, state_path, model: None });
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
        let at = path.iter().rposition(|n| {
            !matches!(n, Node::Expression(_) | Node::Argument(_) | Node::PositionalArgument(_) | Node::NamedArgument(_) | Node::ArgumentList(_))
        });
        let call = at.and_then(|i| match path[i] {
            Node::MethodCall(c) => Some((i, c)),
            _ => None,
        });
        let mut model = None;
        let (complete, fill, state_path, filled) = match call {
            Some((i, c)) if ["components", "schema", "form"].contains(&self.method_name(c)) => {
                let chain = self.whole_chain(&path[..i], c);
                let mut base = c.object;
                while let Expression::Call(Call::Method(m)) = base {
                    base = m.object;
                }
                match base {
                    Expression::Variable(_) => {
                        model = chain.0.iter().find(|m| self.method_name(m) == "model").and_then(|m| self.class_argument(&m.argument_list));
                        let (fill, state_path, filled) = self.form_root(path, &chain);
                        (true, fill, state_path, filled)
                    }
                    Expression::Call(Call::StaticMethod(make)) => {
                        let (fill, filled) = self.action_root(&chain, make);
                        (true, fill, None, filled)
                    }
                    _ => (true, Fill::Unknown, None, vec![]),
                }
            }
            _ => (false, Fill::Unknown, None, vec![]),
        };
        let root = self.root(complete, fill, state_path);
        self.schema.roots[root].model = model;
        self.filled.extend(filled.into_iter().map(|k| (root, vec![k])));
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

    /// The class a call's only argument names: `X::class`.
    fn class_argument(&self, list: &'a mago_syntax::cst::ArgumentList<'a>) -> Option<String> {
        let [Argument::Positional(p)] = list.arguments.as_slice() else { return None };
        let Expression::Access(mago_syntax::cst::Access::ClassConstant(access)) = p.value else { return None };
        let (Expression::Identifier(id), mago_syntax::cst::ClassLikeConstantSelector::Identifier(constant)) = (access.class, &access.constant) else {
            return None;
        };
        if !constant.value.eq_ignore_ascii_case(b"class") {
            return None;
        }
        let class = match self.parsed.names.resolve(&id.span()) {
            Some(fqn) => String::from_utf8_lossy(fqn).into_owned(),
            None => resolve_class(&scope_at(self.parsed.program, id.span().start.offset), &String::from_utf8_lossy(id.value())),
        };
        Some(class.trim_start_matches('\\').to_string())
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
        let comp_name = name.as_ref().map(|(n, ..)| n.clone());
        let comp = Comp { class, kind, make, chain: chain.clone(), span, root, container: container.to_vec(), name };
        let path = comp.path();
        // The schema the component's children are in, and whether a relationship's records fill it.
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
            let name = self.relationship_name(&comp_name, &chain, root, container);
            self.schema.related.insert((root, children.clone()), name);
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

    /// Every call of the chain that `call` is in, first one first, and the node around the whole chain.
    fn whole_chain(&self, ancestors: &[Node<'a, 'a>], call: &'a MethodCall<'a>) -> (Vec<&'a MethodCall<'a>>, Option<Node<'a, 'a>>) {
        let mut chain = vec![call];
        let mut e = call.object;
        while let Expression::Call(Call::Method(m)) = e {
            chain.push(m);
            e = m.object;
        }
        chain.reverse();
        let mut current = call.span();
        for node in ancestors.iter().rev() {
            match node {
                Node::MethodCall(m) if m.object.span() == current => {
                    chain.push(m);
                    current = m.span();
                }
                n if n.span() == current => {}
                n => return (chain, Some(*n)),
            }
        }
        (chain, None)
    }

    /// The class around `ancestors`, by its full name, with its node.
    fn class_of(&self, ancestors: &[Node<'a, 'a>]) -> Option<(String, &'a mago_syntax::cst::Class<'a>)> {
        ancestors.iter().rev().find_map(|n| match n {
            Node::Class(c) => {
                let name = String::from_utf8_lossy(c.name.value);
                Some((resolve_class(&scope_at(self.parsed.program, c.span().start.offset), &name).trim_start_matches('\\').to_string(), *c))
            }
            _ => None,
        })
    }

    fn is_a(&self, class: &str, base: &str) -> bool {
        self.ctx.index.codebase.is_instance_of(class.as_bytes(), base.as_bytes())
    }

    /// A form passed to a variable, as in `$schema->components([...])`: a resource's, filled from the record and
    /// at `data`, a relation manager's, in an action's modal, or a Livewire component's own, at its
    /// `->statePath()`.
    fn form_root(
        &self,
        ancestors: &[Node<'a, 'a>],
        chain: &(Vec<&'a MethodCall<'a>>, Option<Node<'a, 'a>>),
    ) -> (Fill, Option<Vec<String>>, Vec<String>) {
        let explicit =
            chain.0.iter().find(|c| self.method_name(c) == "statePath").map(|c| self.first_string(&c.argument_list).map(|(s, ..)| segments(&s)));
        let Some((class, node)) = self.class_of(ancestors) else { return (Fill::Record, explicit.unwrap_or(Some(vec!["data".into()])), vec![]) };
        if ["Filament\\Resources\\RelationManagers\\RelationManager", "Filament\\Resources\\Pages\\ManageRelatedRecords"]
            .iter()
            .any(|b| self.is_a(&class, b))
        {
            return (Fill::Record, explicit.flatten(), vec![]);
        }
        if self.is_a(&class, "Filament\\Resources\\Pages\\Page") || !self.is_a(&class, "Livewire\\Component") {
            return (Fill::Record, explicit.unwrap_or(Some(vec!["data".into()])), vec![]);
        }
        // A Livewire component's form: without `->statePath()`, its fields are the component's properties.
        let state_path = explicit.clone().unwrap_or(Some(vec![]));
        let form = ancestors.iter().rev().find_map(|n| match n {
            Node::Method(m) => Some(String::from_utf8_lossy(m.name.value).into_owned()),
            _ => None,
        });
        let filled = match (&explicit, form) {
            (Some(Some(path)), Some(form)) if path.len() == 1 => self.livewire_fill(&class, node, &form, &path[0]),
            _ => None,
        };
        match filled {
            Some(keys) => (Fill::Fields, state_path, keys),
            None => (Fill::Unknown, state_path, vec![]),
        }
    }

    /// The keys a Livewire form at property `property` holds besides its fields, if the class shows them all:
    /// its form `$this->{form}` is filled only with nothing or with literal arrays, the property is written
    /// nowhere else and has no attribute such as `#[Url]`, its view binds nothing in it, and neither the
    /// class's parent nor its traits are the app's own, which could fill it too.
    fn livewire_fill(&self, class: &str, node: &'a mago_syntax::cst::Class<'a>, form: &str, property: &str) -> Option<Vec<String>> {
        let codebase = &self.ctx.index.codebase;
        let meta = codebase.get_class_like(class.as_bytes())?;
        let parent = meta.direct_parent_class.as_ref()?.as_str_lossy().to_ascii_lowercase();
        if !["filament\\pages\\page", "filament\\pages\\simplepage", "livewire\\component"].contains(&parent.as_str()) {
            return None;
        }
        let framework = |t: &str| ["filament\\", "livewire\\", "illuminate\\"].iter().any(|p| t.to_ascii_lowercase().starts_with(p));
        if !meta.used_traits.iter().all(|t| framework(&t.as_str_lossy())) {
            return None;
        }
        let variable = format!("${property}");
        let this_property = |e: &Expression<'_>, name: &str| match e {
            Expression::Access(mago_syntax::cst::Access::Property(pa)) => is_this(pa.object) && selects(&pa.property, name),
            _ => false,
        };
        let (start, end) = (node.span().start.offset, node.span().end.offset);
        let mut keys = vec![];
        let mut closed = true;
        walk(self.parsed, |n, ancestors| {
            if !closed || n.span().start.offset < start || n.span().end.offset > end {
                return;
            }
            match n {
                Node::MethodCall(m) if this_property(m.object, form) => match self.method_name(m) {
                    "fill" => match m.argument_list.arguments.iter().next() {
                        None => {}
                        Some(Argument::Positional(p)) if m.argument_list.arguments.len() == 1 => match literal_keys(self, p.value) {
                            Some(k) => keys.extend(k),
                            None => closed = false,
                        },
                        _ => closed = false,
                    },
                    "fillPartially" | "rawState" | "partialRawState" | "state" | "constantState" => closed = false,
                    _ => {}
                },
                // Livewire's own `$this->fill([...])` sets properties.
                Node::MethodCall(m) if is_this(m.object) && self.method_name(m) == "fill" => closed = false,
                Node::PropertyAccess(pa) if is_this(pa.object) && selects(&pa.property, property) => {
                    // Only reads of keys: `$this->data['x']`, not `$this->data` itself or an assignment.
                    let mut current = pa.span();
                    let mut keyed = false;
                    for a in ancestors.iter().rev() {
                        match a {
                            Node::ArrayAccess(aa) if aa.array.span() == current => {
                                keyed = true;
                                current = aa.span();
                            }
                            Node::Assignment(x) if x.lhs.span() == current => {
                                closed = false;
                                break;
                            }
                            other if other.span() == current => {}
                            _ => break,
                        }
                    }
                    closed &= keyed;
                }
                Node::Property(mago_syntax::cst::Property::Plain(p)) => {
                    for item in p.items.iter() {
                        let mago_syntax::cst::PropertyItem::Concrete(c) = item else { continue };
                        if c.variable.name != variable.as_bytes() {
                            continue;
                        }
                        if !p.attribute_lists.is_empty() {
                            closed = false;
                        }
                        match c.value {
                            Expression::Literal(Literal::Null(_)) => {}
                            value => match literal_keys(self, value) {
                                Some(k) => keys.extend(k),
                                None => closed = false,
                            },
                        }
                    }
                }
                Node::Property(mago_syntax::cst::Property::Hooked(p)) if p.item.variable().name == variable.as_bytes() => closed = false,
                _ => {}
            }
        });
        if !closed {
            return None;
        }
        keys.extend(self.view_keys(node, property)?);
        Some(keys)
    }

    /// The keys that the component's view, named by a Filament page's `$view` or `render()`'s `view('…')`, binds
    /// in `property`, such as `extra` for `wire:model="data.extra"`; see [`view_keys`]. `None` when the view can't
    /// be found, or may write keys it doesn't name.
    fn view_keys(&self, node: &'a mago_syntax::cst::Class<'a>, property: &str) -> Option<Vec<String>> {
        let body = self.text(node.left_brace.start.offset, node.right_brace.end.offset);
        let named = |marker: &str| {
            let at = body.find(marker)? + marker.len();
            let rest = body[at..].trim_start().strip_prefix(['\'', '"'])?;
            Some(rest[..rest.find(['\'', '"'])?].to_string())
        };
        let view = named("$view =").or_else(|| named("view("))?;
        if view.contains("::") {
            return None;
        }
        let file = self.ctx.snap.root.join("resources/views").join(format!("{}.blade.php", view.replace('.', "/")));
        view_keys(&self.ctx.snap.read(&file)?, property)
    }

    /// An action's modal schema: its state holds only its fields when one of [`EMPTY_FILLED_ACTIONS`] fills it
    /// with nothing, or a literal `fillForm([...])` replaces what any of Filament's
    /// actions fills it with. A chain kept in a variable may be changed later.
    fn action_root(&self, chain: &(Vec<&'a MethodCall<'a>>, Option<Node<'a, 'a>>), make: &'a StaticMethodCall<'a>) -> (Fill, Vec<String>) {
        let unknown = (Fill::Unknown, vec![]);
        if matches!(chain.1, Some(Node::Assignment(_))) {
            return unknown;
        }
        let Expression::Identifier(id) = make.class else { return unknown };
        let class = match self.parsed.names.resolve(&id.span()) {
            Some(fqn) => String::from_utf8_lossy(fqn).into_owned(),
            None => resolve_class(&scope_at(self.parsed.program, id.span().start.offset), &String::from_utf8_lossy(id.value())),
        };
        let class = class.trim_start_matches('\\');
        let mut keys = None;
        for c in &chain.0 {
            match self.method_name(c) {
                "mountUsing" => return unknown,
                "fillForm" => match c.argument_list.arguments.iter().next() {
                    Some(Argument::Positional(p)) => match literal_keys(self, p.value) {
                        Some(k) => keys = Some(k),
                        None => return unknown,
                    },
                    _ => return unknown,
                },
                _ => {}
            }
        }
        match keys {
            Some(keys) if class.starts_with("Filament\\") => (Fill::Fields, keys),
            None if EMPTY_FILLED_ACTIONS.contains(&class) => (Fill::Fields, vec![]),
            _ => unknown,
        }
    }

    /// The relationship that fills a component's children, when they're at the top of a resource's form and no
    /// closure changes the query or the records' data: `->relationship()` names it, or a repeater's name does.
    fn relationship_name(&self, field: &Option<String>, chain: &[&'a MethodCall<'a>], root: usize, container: &[String]) -> Option<String> {
        if !container.is_empty() || self.schema.roots[root].fill != Fill::Record {
            return None;
        }
        let mut name = None;
        for c in chain {
            match self.method_name(c) {
                "relationship" => {
                    if c.argument_list.arguments.len() > 1 || c.argument_list.arguments.iter().any(|a| matches!(a, Argument::Named(_))) {
                        return None;
                    }
                    name = match c.argument_list.arguments.iter().next() {
                        Some(_) => Some(self.first_string(&c.argument_list)?.0),
                        None => field.clone(),
                    };
                }
                "mutateRelationshipDataBeforeFillUsing" => return None,
                _ => {}
            }
        }
        name
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

/// The keys a Livewire view binds in the component's `property`: `wire:model="data.extra"` on any element or
/// component, `$wire.set('data.extra', …)`, `$wire.$set`, a `wire:click`'s `$set`, `$wire.entangle`,
/// `$wire.$entangle`, `@entangle`, and `$wire.data.extra`. `None` when it may write keys it doesn't name: a binding
/// of the whole property or of a path built at runtime, `$wire.data` itself, or PHP that writes
/// `$this->{property}` or passes it on. Reads in PHP, such as `{{ $data['x'] }}`, change nothing, and neither do
/// comments or the text of the page.
pub fn view_keys(view: &str, property: &str) -> Option<Vec<String>> {
    // Blade's and HTML's comments bind nothing.
    let mut text = view.to_string();
    for (open, close) in [("{{--", "--}}"), ("<!--", "-->")] {
        let mut from = 0;
        while let Some(start) = text[from..].find(open).map(|i| i + from) {
            let end = text[start..].find(close).map_or(text.len(), |i| start + i + close.len());
            let blank: String = text[start..end].chars().map(|c| if c == '\n' { c } else { ' ' }).collect();
            text.replace_range(start..end, &blank);
            from = start + blank.len();
        }
    }
    let checked = crate::framework::laravel::blade::checked_php(&text, &[]);
    let php = checked.php.as_bytes();
    // A byte of the view's markup, rather than its PHP: blanked in the PHP Mago checks.
    let markup = |i: usize| php.get(checked.php_offset(i)) == Some(&b' ');
    let mut keys = vec![];
    // A path that a binding names: a key in the property, nothing (another property's), or `None` for the
    // property itself or a key that isn't written out.
    let mut path = |p: &str| -> Option<()> {
        let Some(rest) = p.strip_prefix(property) else { return Some(()) };
        let Some(rest) = rest.strip_prefix('.') else {
            // The property itself, or another one whose name starts with it.
            return (!rest.is_empty()).then_some(());
        };
        let key: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
        if key.is_empty() {
            return None;
        }
        keys.push(key);
        Some(())
    };
    let bytes = text.as_bytes();
    // `wire:model` and its modifiers, in markup.
    for (at, _) in text.match_indices("wire:model") {
        if !markup(at) || at.checked_sub(1).is_some_and(|b| bytes[b].is_ascii_alphanumeric() || bytes[b] == b'-') {
            continue;
        }
        let rest = text[at + "wire:model".len()..].trim_start_matches(|c: char| c.is_alphanumeric() || matches!(c, '.' | '-' | '_'));
        let Some(rest) = rest.trim_start().strip_prefix('=') else { continue };
        let rest = rest.trim_start();
        // An unquoted value isn't read: it may be the property's.
        let quote = rest.chars().next().filter(|q| *q == '"' || *q == '\'')?;
        let value = &rest[1..rest[1..].find(quote)? + 1];
        if value.contains("{{") || value.contains("{!!") {
            // A path built in PHP: unknown if it can be in the property.
            if value.starts_with(property) {
                return None;
            }
            continue;
        }
        path(value.trim())?;
    }
    // JavaScript and directives: calls that take a path, and `$wire`'s properties.
    for call in ["$wire.set(", "$wire.$set(", "$set(", "$wire.entangle(", "$wire.$entangle(", "@entangle(", "$wire.$get(", "$wire.get("] {
        for (at, _) in text.match_indices(call) {
            // `$set(` also matches inside `$wire.$set(`, read already.
            if call == "$set(" && text[..at].ends_with("$wire.") {
                continue;
            }
            let rest = text[at + call.len()..].trim_start();
            let Some(quote) = rest.chars().next().filter(|q| *q == '"' || *q == '\'') else {
                // A path in a variable: it may be the property's.
                if call.starts_with("$wire.$get") || call.starts_with("$wire.get") {
                    continue;
                }
                return None;
            };
            path(&rest[1..rest[1..].find(quote)? + 1])?;
        }
    }
    let member = format!("$wire.{property}");
    for (at, _) in text.match_indices(&member) {
        let rest = &text[at + member.len()..];
        if rest.starts_with(|c: char| c.is_alphanumeric() || c == '_') {
            continue;
        }
        let key: String = rest.strip_prefix('.')?.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
        if key.is_empty() {
            return None;
        }
        keys.push(key);
    }
    // PHP that writes the property or passes it on; reads of its keys are fine.
    let arena = mago_allocator::LocalArena::new();
    let parsed = Parsed::exact(&arena, std::path::Path::new("view.php"), &checked.php);
    let mut safe = true;
    walk(&parsed, |n, ancestors| {
        let Node::PropertyAccess(pa) = n else { return };
        if !is_this(pa.object) || !selects(&pa.property, property) {
            return;
        }
        let mut current = pa.span();
        let mut keyed = false;
        for a in ancestors.iter().rev() {
            match a {
                Node::ArrayAccess(aa) if aa.array.span() == current => {
                    keyed = true;
                    current = aa.span();
                }
                Node::Assignment(x) if x.lhs.span() == current => {
                    keyed = false;
                    break;
                }
                other if other.span() == current => {}
                _ => break,
            }
        }
        safe &= keyed;
    });
    keys.sort();
    keys.dedup();
    safe.then_some(keys)
}

/// Filament's actions that mount with an empty `fill()`, so that their modal's state holds only its fields:
/// each version's `Action`, `CreateAction`, and `BulkAction`, which keep `CanBeMounted`'s default. `EditAction`,
/// `ViewAction`, and `ReplicateAction` fill it from the record instead.
const EMPTY_FILLED_ACTIONS: &[&str] = &[
    "Filament\\Actions\\Action",
    "Filament\\Actions\\CreateAction",
    "Filament\\Actions\\BulkAction",
    // Filament 3's, whose tables, forms, and infolists have their own.
    "Filament\\Tables\\Actions\\Action",
    "Filament\\Tables\\Actions\\CreateAction",
    "Filament\\Tables\\Actions\\BulkAction",
    "Filament\\Forms\\Components\\Actions\\Action",
    "Filament\\Infolists\\Components\\Actions\\Action",
    "Filament\\Pages\\Actions\\Action",
];

fn is_this(e: &Expression<'_>) -> bool {
    matches!(e, Expression::Variable(mago_syntax::cst::Variable::Direct(v)) if v.name == b"$this")
}

fn selects(selector: &mago_syntax::cst::ClassLikeMemberSelector<'_>, name: &str) -> bool {
    matches!(selector, mago_syntax::cst::ClassLikeMemberSelector::Identifier(id) if id.value == name.as_bytes())
}

/// The string keys of a literal array, or of one an arrow function or a one-statement closure returns, if
/// every element has one.
fn literal_keys(b: &Builder<'_, '_>, expr: &Expression<'_>) -> Option<Vec<String>> {
    let value = match expr {
        Expression::ArrowFunction(f) => f.expression,
        Expression::Closure(f) => match f.body.statements.as_slice() {
            [mago_syntax::cst::Statement::Return(r)] => r.value?,
            _ => return None,
        },
        other => other,
    };
    let elements: Vec<&ArrayElement<'_>> = match value {
        Expression::Array(a) => a.elements.iter().collect(),
        Expression::LegacyArray(a) => a.elements.iter().collect(),
        _ => return None,
    };
    elements
        .into_iter()
        .map(|e| match e {
            ArrayElement::KeyValue(kv) => match kv.key {
                Expression::Literal(Literal::String(s)) => Some(b.text(s.span.start.offset + 1, s.span.end.offset.saturating_sub(1)).to_string()),
                _ => None,
            },
            _ => None,
        })
        .collect()
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
    fn reads_the_keys_a_livewire_view_binds() {
        let keys = |view: &str| view_keys(view, "data");
        assert_eq!(keys("<div>{{ $this->form }} {{ $data['name'] }} metadata.x 'data' {{-- wire:model=\"data\" --}}</div>"), Some(vec![]));
        assert_eq!(
            keys("<input wire:model.live.debounce=\"data.extra\"><x-input wire:model='other.x' /><button wire:click=\"$set('data.flag', 1)\" x-on:click=\"$wire.set('data.more', 2); $wire.data.seen\">"),
            Some(vec!["extra".into(), "flag".into(), "more".into(), "seen".into()])
        );
        assert_eq!(keys("<div x-data=\"{ open: @entangle('data.open') }\"></div>"), Some(vec!["open".into()]));
        // Anything that may write keys it doesn't name.
        for view in [
            "<input wire:model=\"data\">",
            "<input wire:model=\"data.{{ $key }}\">",
            "<div x-init=\"$wire.set(name, 1)\">",
            "<div x-data=\"{ s: $wire.$entangle('data') }\">",
            "<div x-init=\"$wire.data = {}\">",
            "@php $this->data['x'] = 1; @endphp",
            "{{ data_set($this->data, 'x', 1) }}",
        ] {
            assert_eq!(keys(view), None, "{view}");
        }
        assert_eq!(keys("{{ $this->data['name'] ?? '' }}"), Some(vec![]));
    }

    #[test]
    fn resolves_paths_as_filament_does() {
        let data = p("data");
        let at = Some(data.as_slice());
        assert_eq!(resolve(at, &p("items.*"), "qty", false), Resolved::Path(p("items.*.qty")));
        assert_eq!(resolve(at, &p("items.*"), "../../total", false), Resolved::Path(p("total")));
        assert_eq!(resolve(at, &p("items.*"), "../", false), Resolved::Path(p("items")));
        assert_eq!(resolve(at, &[], "../x", false), Resolved::Outside);
        // Absolute paths start at the component, wherever the closure is.
        assert_eq!(resolve(at, &p("items.*"), "/data.total", false), Resolved::Path(p("total")));
        assert_eq!(resolve(at, &p("items.*"), "data.items.1.qty", true), Resolved::Path(p("items.1.qty")));
        assert_eq!(resolve(at, &[], "/data", false), Resolved::Path(vec![]));
        assert_eq!(resolve(at, &[], "/record.title", false), Resolved::Outside);
        assert_eq!(resolve(Some(&[]), &[], "/title", false), Resolved::Path(p("title")));
        assert_eq!(resolve(None, &[], "/data.x", false), Resolved::Absolute);
        assert_eq!(resolve(None, &[], "x", true), Resolved::Absolute);
        assert_eq!(default_label("author_id"), "Author id");
        assert_eq!(default_label("meta.firstName"), "First name");
    }
}
