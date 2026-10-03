//! Eloquent's data read from the project's files, for when the app can't boot or reach its database: the tables
//! and columns the migrations build, what models declare (`$table`, casts, relationship methods), and the
//! aliases `Relation::morphMap()` gives models. The index reads each file's facts from its syntax tree as it
//! scans the file ([`read_file`]) and combines them into an [`Eloquent`] after each change.
//!
//! ```php
//! Schema::create('posts', function (Blueprint $table) {
//!     $table->id();                              // id: int
//!     $table->string('title');                   // title: string
//!     $table->timestamp('published_at')->nullable();
//!     $table->foreignId('author_id')->constrained();
//!     $table->timestamps();                      // created_at, updated_at: nullable
//! });
//! ```
//!
//! Only what's surely read counts. A blueprint call inside an `if` or a loop, a column named by a variable, a
//! macro, or raw SQL that names the table makes the table uncertain: its columns still complete and type, but
//! no warning is based on them. An `ALTER` the migrations can't place, such as `Schema::table($name, …)`, makes
//! every table uncertain.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use mago_codex::metadata::CodebaseMetadata;
use mago_span::HasSpan;
use mago_syntax::cst::{
    Access, Argument, ArgumentList, ArrayElement, Call, ClassLikeConstantSelector, ClassLikeMember, ClassLikeMemberSelector, Expression,
    Literal, MethodBody, NamespaceBody, Node, Property, PropertyItem, Statement, Variable,
};

use crate::analysis::Parsed;

/// A column a migration gives a table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Column {
    pub name: String,
    /// The PHP type the database gives back without a cast, such as `int` or `string`; empty when unknown.
    pub ty: &'static str,
    pub nullable: bool,
    /// A date or time column, which a model's timestamps or `$dates` turn into Carbon.
    pub date: bool,
}

/// A table the migrations build.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Table {
    pub columns: Vec<Column>,
    /// Whether every change to the table was read. An uncertain table's columns complete and type, but no
    /// warning is based on them.
    pub certain: bool,
}

impl Table {
    pub fn column(&self, name: &str) -> Option<&Column> {
        self.columns.iter().find(|c| c.name == name)
    }
}

/// A change to a table's columns inside a blueprint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ColumnOp {
    Add(Column),
    /// `->change()`: the column's new definition.
    Change(Column),
    Drop(String),
    Rename(String, String),
}

/// What a migration's `up()` does to the schema, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Op {
    Create { table: String, columns: Vec<ColumnOp>, certain: bool },
    Alter { table: String, columns: Vec<ColumnOp>, certain: bool },
    Rename { from: String, to: String },
    Drop(String),
    /// A change the migration makes that can't be read: to this table, or to any table when `None`.
    Uncertain(Option<String>),
}

/// A relationship method a model declares: `posts()` returning `$this->hasMany(Post::class)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelationDecl {
    pub name: String,
    /// The method that makes it, such as `hasMany`.
    pub kind: String,
    /// The related model, fully qualified, when the method names it with `::class`.
    pub related: Option<String>,
    /// The morph name of a `morphTo()`, or the one a `morphMany()`, `morphOne()`, `morphToMany()`, or
    /// `morphedByMany()` points back through.
    pub morph: Option<String>,
    /// Where the method's name is, in its file.
    pub offset: u32,
}

/// What a class declares that Eloquent reads, from its own body. A class's parents and traits add theirs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelDecl {
    /// The fully qualified name.
    pub class: String,
    pub table: Option<String>,
    /// `$casts` and `casts()`, by attribute; `None` when `casts()` returns something other than a literal array, so
    /// any attribute may have a cast.
    pub casts: Option<Vec<(String, String)>>,
    /// `$timestamps`, when the class sets it.
    pub timestamps: Option<bool>,
    /// `$fillable`, when it's a literal list.
    pub fillable: Option<Vec<String>>,
    /// `$with`, the relationships every query eager-loads: `None` when it isn't a literal list.
    pub eager: Option<Vec<String>>,
    pub relations: Vec<RelationDecl>,
}

/// Everything one file says about Eloquent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileFacts {
    /// For a migration, what its `up()` does.
    pub migration: Option<Vec<Op>>,
    pub models: Vec<ModelDecl>,
    /// `Relation::morphMap()` and `enforceMorphMap()` entries: alias, class.
    pub morph_map: Vec<(String, String)>,
    pub enforces_morph_map: bool,
    /// Calls `Model::automaticallyEagerLoadRelationships()`, so nothing lazy-loads.
    pub auto_eager_loads: bool,
    /// Calls `resolveRelationUsing()`, which adds relationships no method declares.
    pub dynamic_relations: bool,
}

impl FileFacts {
    pub fn is_empty(&self) -> bool {
        self.migration.is_none() && self.models.is_empty() && self.morph_map.is_empty() && !self.enforces_morph_map && !self.auto_eager_loads && !self.dynamic_relations
    }
}

/// What a project file says about Eloquent, or `None` when it says nothing. `rel` is the file's path relative to
/// the project.
pub fn read_file(parsed: &Parsed<'_>, rel: &Path) -> Option<FileFacts> {
    let mut facts = FileFacts::default();
    if rel.parent() == Some(Path::new("database/migrations")) {
        facts.migration = Some(migration_ops(parsed));
    }
    for statement in top_statements(parsed) {
        let (name, members, attributes) = match statement {
            Statement::Class(c) => (&c.name, &c.members, Some(&c.attribute_lists)),
            Statement::Trait(t) => (&t.name, &t.members, None),
            _ => continue,
        };
        let Some(class) = parsed.names.resolve(&name.span()) else { continue };
        let decl = model_decl(parsed, String::from_utf8_lossy(class).into_owned(), members.iter(), attributes.map(|a| a.iter()));
        if decl.table.is_some() || decl.casts.as_ref().is_none_or(|c| !c.is_empty()) || decl.timestamps.is_some() || decl.fillable.is_some() || decl.eager.as_ref().is_none_or(|e| !e.is_empty()) || !decl.relations.is_empty() {
            facts.models.push(decl);
        }
    }
    let text = parsed.text();
    if text.contains("orphMap") {
        read_morph_map(parsed, &mut facts);
    }
    facts.dynamic_relations = text.contains("resolveRelationUsing(");
    if text.contains("automaticallyEagerLoadRelationships") {
        crate::locate::walk(parsed, |node, _| {
            if let Node::StaticMethodCall(c) = node
                && method_name(&c.method).is_some_and(|m| m.eq_ignore_ascii_case(b"automaticallyEagerLoadRelationships"))
            {
                facts.auto_eager_loads = true;
            }
        });
    }
    (!facts.is_empty()).then_some(facts)
}

/// What a project file's `contents` say about Eloquent, parsed only when they may say something.
pub fn scan_file(root: &Path, path: &Path, contents: &[u8]) -> Option<FileFacts> {
    let rel = path.strip_prefix(root).ok()?;
    let migration = rel.parent() == Some(Path::new("database/migrations"));
    const HINTS: &[&[u8]] = &[b"$table", b"casts", b"$timestamps", b"$fillable", b"$with", b"EagerLoadRelationships", b"resolveRelationUsing", b"Table(", b"orphMap", b"$this->has", b"$this->belongs", b"$this->morph"];
    if !migration && !HINTS.iter().any(|h| contents.windows(h.len()).any(|w| w == *h)) {
        return None;
    }
    let arena = mago_allocator::LocalArena::new();
    let parsed = Parsed::new(&arena, path, &String::from_utf8_lossy(contents));
    read_file(&parsed, rel)
}

/// The file's statements, and those inside its namespaces.
fn top_statements<'p, 'a>(parsed: &'p Parsed<'a>) -> Vec<&'p Statement<'a>> {
    let mut out = vec![];
    for statement in parsed.program.statements.iter() {
        match statement {
            Statement::Namespace(ns) => match &ns.body {
                NamespaceBody::BraceDelimited(block) => out.extend(block.statements.iter()),
                NamespaceBody::Implicit(body) => out.extend(body.statements.iter()),
            },
            other => out.push(other),
        }
    }
    out
}

fn string(expr: &Expression<'_>) -> Option<String> {
    match expr {
        Expression::Literal(Literal::String(s)) => s.value.map(|v| String::from_utf8_lossy(v).into_owned()),
        Expression::Parenthesized(p) => string(p.expression),
        _ => None,
    }
}

/// The class `X::class` names, fully qualified.
fn class_constant(parsed: &Parsed<'_>, expr: &Expression<'_>) -> Option<String> {
    let Expression::Access(Access::ClassConstant(a)) = expr else { return None };
    let ClassLikeConstantSelector::Identifier(id) = &a.constant else { return None };
    if !id.value.eq_ignore_ascii_case(b"class") {
        return None;
    }
    let Expression::Identifier(class) = a.class else { return None };
    parsed.names.resolve(&class.span()).map(|n| String::from_utf8_lossy(n).into_owned())
}

/// The positional arguments, or `None` when one is named, spread, or unpacked.
fn positional<'a>(list: &ArgumentList<'a>) -> Option<Vec<&'a Expression<'a>>> {
    list.arguments
        .iter()
        .map(|a| match a {
            Argument::Positional(p) if p.ellipsis.is_none() => Some(p.value),
            _ => None,
        })
        .collect()
}

/// The argument at `index`, or the one named `name`.
fn argument<'a>(list: &ArgumentList<'a>, index: usize, name: &str) -> Option<&'a Expression<'a>> {
    list.arguments
        .iter()
        .find_map(|a| match a {
            Argument::Named(n) if n.name.value == name.as_bytes() => Some(n.value),
            _ => None,
        })
        .or_else(|| match list.arguments.iter().nth(index)? {
            Argument::Positional(p) if p.ellipsis.is_none() => Some(p.value),
            _ => None,
        })
}

fn method_name<'a>(selector: &ClassLikeMemberSelector<'a>) -> Option<&'a [u8]> {
    match selector {
        ClassLikeMemberSelector::Identifier(id) => Some(id.value),
        _ => None,
    }
}

// ---- Models ----

/// The methods that make a relationship, as `$this->hasMany(…)` calls them.
pub const RELATION_KINDS: &[&str] = &[
    "hasOne", "hasMany", "belongsTo", "belongsToMany", "hasOneThrough", "hasManyThrough", "morphTo", "morphOne", "morphMany", "morphToMany",
    "morphedByMany", "hasOneDeep", "hasManyDeep",
];

fn model_decl<'a>(
    parsed: &Parsed<'a>,
    class: String,
    members: impl Iterator<Item = &'a ClassLikeMember<'a>>,
    attributes: Option<impl Iterator<Item = &'a mago_syntax::cst::AttributeList<'a>>>,
) -> ModelDecl {
    let mut decl = ModelDecl { class, casts: Some(vec![]), eager: Some(vec![]), ..Default::default() };
    // Laravel 13's `#[Table('posts')]` or `#[Table(name: 'posts')]`.
    for list in attributes.into_iter().flatten() {
        for attribute in list.attributes.iter() {
            let resolved = parsed.names.resolve(&attribute.name.span()).unwrap_or_default();
            if !resolved.eq_ignore_ascii_case(b"Illuminate\\Database\\Eloquent\\Attributes\\Table") {
                continue;
            }
            let args = attribute.argument_list.as_ref().map(|l| l.arguments.iter().collect::<Vec<_>>()).unwrap_or_default();
            decl.table = args.iter().enumerate().find_map(|(i, a)| match a {
                mago_syntax::cst::PartialArgument::Positional(p) if i == 0 => string(p.value),
                mago_syntax::cst::PartialArgument::Named(n) if n.name.value == b"name" => string(n.value),
                _ => None,
            });
        }
    }
    let mut property_casts = vec![];
    let mut method_casts = Some(vec![]);
    for member in members {
        match member {
            ClassLikeMember::Property(Property::Plain(p)) => {
                for item in p.items.iter() {
                    let PropertyItem::Concrete(item) = item else { continue };
                    match item.variable.name {
                        b"$table" => decl.table = string(item.value),
                        b"$timestamps" => {
                            decl.timestamps = match item.value {
                                Expression::Literal(Literal::True(_)) => Some(true),
                                Expression::Literal(Literal::False(_)) => Some(false),
                                _ => None,
                            }
                        }
                        b"$casts" => property_casts = literal_casts(parsed, item.value).unwrap_or_default(),
                        b"$fillable" => decl.fillable = strings(item.value),
                        b"$with" => decl.eager = strings(item.value),
                        _ => {}
                    }
                }
            }
            ClassLikeMember::Method(m) => {
                let MethodBody::Concrete(body) = &m.body else { continue };
                let name = String::from_utf8_lossy(m.name.value).into_owned();
                if name.eq_ignore_ascii_case("casts") {
                    // Only `return [...]`; anything else may add casts the editor can't see.
                    method_casts = match body.statements.iter().collect::<Vec<_>>().as_slice() {
                        [Statement::Return(r)] => r.value.and_then(|v| literal_casts(parsed, v)),
                        _ => None,
                    };
                    continue;
                }
                if m.parameter_list.parameters.iter().any(|p| p.default_value.is_none() && p.ellipsis.is_none()) {
                    continue;
                }
                let returned = body.statements.iter().rev().find_map(|s| match s {
                    Statement::Return(r) => r.value,
                    _ => None,
                });
                if let Some(relation) = returned.and_then(|e| relation_call(parsed, e, &name, m.name.span.start.offset)) {
                    decl.relations.push(relation);
                }
            }
            _ => {}
        }
    }
    decl.casts = method_casts.map(|mut casts| {
        // `casts()` wins over `$casts`, key by key.
        for (k, v) in property_casts {
            if !casts.iter().any(|(c, _)| *c == k) {
                casts.push((k, v));
            }
        }
        casts
    });
    decl
}

/// `['published_at' => 'datetime', 'status' => Status::class]`, with class constants fully qualified. `None` when
/// an entry isn't a literal.
fn literal_casts(parsed: &Parsed<'_>, expr: &Expression<'_>) -> Option<Vec<(String, String)>> {
    let elements = match expr {
        Expression::Array(a) => a.elements.iter().collect::<Vec<_>>(),
        Expression::LegacyArray(a) => a.elements.iter().collect(),
        _ => return None,
    };
    elements
        .into_iter()
        .map(|e| match e {
            ArrayElement::KeyValue(kv) => Some((string(kv.key)?, string(kv.value).or_else(|| class_constant(parsed, kv.value))?)),
            _ => None,
        })
        .collect()
}

/// The relationship `$this->hasMany(Post::class)->latest()` makes, from the call at the root of the chain.
fn relation_call(parsed: &Parsed<'_>, expr: &Expression<'_>, name: &str, offset: u32) -> Option<RelationDecl> {
    let mut e = expr;
    loop {
        let Expression::Call(Call::Method(c)) = e else { return None };
        if let Expression::Variable(Variable::Direct(v)) = c.object
            && v.name == b"$this"
        {
            let kind = String::from_utf8_lossy(method_name(&c.method)?).into_owned();
            let kind = RELATION_KINDS.iter().find(|k| k.eq_ignore_ascii_case(&kind))?.to_string();
            let first = argument(&c.argument_list, 0, if kind == "morphTo" { "name" } else { "related" });
            let (related, morph) = if kind == "morphTo" {
                (None, Some(first.and_then(string).unwrap_or_else(|| snake(name))))
            } else {
                let related = first.and_then(|e| class_constant(parsed, e).or_else(|| string(e)));
                let morph = matches!(kind.as_str(), "morphOne" | "morphMany" | "morphToMany" | "morphedByMany").then(|| argument(&c.argument_list, 1, "name").and_then(string)).flatten();
                (related, morph)
            };
            return Some(RelationDecl { name: name.to_string(), kind, related, morph, offset });
        }
        e = c.object;
    }
}

fn read_morph_map(parsed: &Parsed<'_>, facts: &mut FileFacts) {
    crate::locate::walk(parsed, |node, _| {
        let Node::StaticMethodCall(c) = node else { return };
        let Some(method) = method_name(&c.method) else { return };
        let enforce = method.eq_ignore_ascii_case(b"enforceMorphMap");
        if !enforce && !method.eq_ignore_ascii_case(b"morphMap") {
            return;
        }
        let Expression::Identifier(class) = c.class else { return };
        let resolved = parsed.names.resolve(&class.span()).unwrap_or_default();
        if !resolved.ends_with(b"Relation") {
            return;
        }
        facts.enforces_morph_map |= enforce;
        let Some(map) = argument(&c.argument_list, 0, "map") else { return };
        let elements = match map {
            Expression::Array(a) => a.elements.iter().collect::<Vec<_>>(),
            Expression::LegacyArray(a) => a.elements.iter().collect(),
            _ => return,
        };
        for element in elements {
            let ArrayElement::KeyValue(kv) = element else { continue };
            if let (Some(alias), Some(class)) = (string(kv.key), class_constant(parsed, kv.value).or_else(|| string(kv.value))) {
                facts.morph_map.push((alias, class.trim_start_matches('\\').to_string()));
            }
        }
    });
}

// ---- Migrations ----

/// Whether `expr` names the `Schema` facade or its builder: `Schema::` or `Schema::connection('x')->`.
fn is_schema(parsed: &Parsed<'_>, expr: &Expression<'_>) -> bool {
    match expr {
        Expression::Identifier(id) => {
            let name = parsed.names.resolve(&id.span()).unwrap_or(id.value());
            name.rsplit(|b| *b == b'\\').next().is_some_and(|n| n.eq_ignore_ascii_case(b"Schema"))
        }
        Expression::Call(Call::StaticMethod(c)) => method_name(&c.method).is_some_and(|m| m.eq_ignore_ascii_case(b"connection")) && is_schema(parsed, c.class),
        _ => false,
    }
}

/// The schema call `expr` is, if any: `(method, arguments)`.
fn schema_call<'a>(parsed: &Parsed<'a>, expr: &'a Expression<'a>) -> Option<(String, &'a ArgumentList<'a>)> {
    let (on, method, list) = match expr {
        Expression::Call(Call::StaticMethod(c)) => (c.class, &c.method, &c.argument_list),
        Expression::Call(Call::Method(c)) => (c.object, &c.method, &c.argument_list),
        _ => return None,
    };
    let method = String::from_utf8_lossy(method_name(method)?).to_ascii_lowercase();
    (method != "connection" && is_schema(parsed, on)).then_some((method, list))
}

const SCHEMA_CHANGES: &[&str] = &["create", "table", "rename", "drop", "dropifexists", "dropcolumns"];

/// What a migration's `up()` methods do, in order.
fn migration_ops(parsed: &Parsed<'_>) -> Vec<Op> {
    let mut ops = vec![];
    crate::locate::walk(parsed, |node, _| {
        let Node::Method(m) = node else { return };
        if !m.name.value.eq_ignore_ascii_case(b"up") {
            return;
        }
        let MethodBody::Concrete(body) = &m.body else { return };
        let mut read: Vec<(u32, u32)> = vec![];
        for statement in body.statements.iter() {
            let Statement::Expression(s) = statement else { continue };
            if let Some(op) = schema_op(parsed, s.expression) {
                let span = s.expression.span();
                read.push((span.start.offset, span.end.offset));
                ops.extend(op);
            }
        }
        // Schema changes elsewhere in `up()`, as inside an `if` or a loop, and raw SQL.
        walk_node(Node::Block(body), &mut |node| {
            let Node::Expression(e) = node else { return true };
            let span = e.span();
            if read.iter().any(|(s, end)| *s <= span.start.offset && span.end.offset <= *end) {
                return false;
            }
            if let Some((method, list)) = schema_call(parsed, e)
                && SCHEMA_CHANGES.contains(&method.as_str())
            {
                ops.push(Op::Uncertain(argument(list, 0, "table").and_then(string).filter(|_| method != "rename")));
                return false;
            }
            if let Expression::Call(Call::StaticMethod(c)) = e
                && let Expression::Identifier(id) = c.class
                && parsed.names.resolve(&id.span()).unwrap_or(id.value()).rsplit(|b| *b == b'\\').next().is_some_and(|n| n.eq_ignore_ascii_case(b"DB"))
                && method_name(&c.method).is_some_and(|m| m.eq_ignore_ascii_case(b"statement") || m.eq_ignore_ascii_case(b"unprepared"))
            {
                match argument(&c.argument_list, 0, "query").and_then(string) {
                    Some(sql) => ops.push(Op::Uncertain(Some(format!("sql:{sql}")))),
                    None => ops.push(Op::Uncertain(None)),
                }
            }
            true
        });
    });
    ops
}

/// Visits `node` and its descendants, depth first, while `f` returns true for a node.
fn walk_node<'a>(node: Node<'a, 'a>, f: &mut impl FnMut(Node<'a, 'a>) -> bool) {
    if f(node) {
        node.visit_children(|child| walk_node(child, f));
    }
}

/// The ops of a statement at the top of `up()`, or `None` when it isn't a schema change.
fn schema_op(parsed: &Parsed<'_>, expr: &Expression<'_>) -> Option<Vec<Op>> {
    let (method, list) = schema_call(parsed, expr)?;
    let table = argument(list, 0, "table").and_then(string);
    Some(match method.as_str() {
        // A table whose name isn't a literal, such as spatie/laravel-permission's from config, can't be one the
        // models know, so creating it changes nothing known.
        "create" => match table {
            Some(table) => {
                let (columns, certain) = argument(list, 1, "callback").map(blueprint).unwrap_or((vec![], false));
                vec![Op::Create { table, columns, certain }]
            }
            None => vec![],
        },
        "table" => match table {
            Some(table) => {
                let (columns, certain) = argument(list, 1, "callback").map(blueprint).unwrap_or((vec![], false));
                vec![Op::Alter { table, columns, certain }]
            }
            None => vec![Op::Uncertain(None)],
        },
        "rename" => match (table, argument(list, 1, "to").and_then(string)) {
            (Some(from), Some(to)) => vec![Op::Rename { from, to }],
            _ => vec![Op::Uncertain(None)],
        },
        "drop" | "dropifexists" => table.map(Op::Drop).into_iter().collect(),
        "dropcolumns" => match (table, argument(list, 1, "columns").map(|c| strings(c))) {
            (Some(table), Some(Some(columns))) => vec![Op::Alter { table, columns: columns.into_iter().map(ColumnOp::Drop).collect(), certain: true }],
            (table, _) => vec![Op::Uncertain(table)],
        },
        _ => return None,
    })
}

/// A string or a list of strings.
fn strings(expr: &Expression<'_>) -> Option<Vec<String>> {
    match expr {
        Expression::Array(a) => a.elements.iter().map(|e| if let ArrayElement::Value(v) = e { string(v.value) } else { None }).collect(),
        Expression::LegacyArray(a) => a.elements.iter().map(|e| if let ArrayElement::Value(v) = e { string(v.value) } else { None }).collect(),
        other => string(other).map(|s| vec![s]),
    }
}

/// The column changes a blueprint closure makes, and whether all of it was read.
fn blueprint(callback: &Expression<'_>) -> (Vec<ColumnOp>, bool) {
    let (parameter, statements): (&[u8], Vec<&Expression<'_>>) = match callback {
        Expression::Closure(c) => {
            let Some(p) = c.parameter_list.parameters.iter().next() else { return (vec![], false) };
            let mut expressions = vec![];
            for statement in c.body.statements.iter() {
                match statement {
                    Statement::Expression(s) => expressions.push(s.expression),
                    Statement::Noop(_) => {}
                    // An `if`, a loop, or a `return` may or may not change the table.
                    _ => return (vec![], false),
                }
            }
            (p.variable.name, expressions)
        }
        Expression::ArrowFunction(f) => {
            let Some(p) = f.parameter_list.parameters.iter().next() else { return (vec![], false) };
            (p.variable.name, vec![f.expression])
        }
        _ => return (vec![], false),
    };
    let mut ops = vec![];
    let mut certain = true;
    for expr in statements {
        match column_statement(parameter, expr) {
            Some(found) => ops.extend(found),
            None => certain = false,
        }
    }
    (ops, certain)
}

/// The column changes of one statement on the blueprint `$table`, or `None` when it can't be read.
fn column_statement(table: &[u8], expr: &Expression<'_>) -> Option<Vec<ColumnOp>> {
    // `$table->engine = 'InnoDB';` sets a table option.
    if let Expression::Assignment(a) = expr
        && let Expression::Access(Access::Property(p)) = a.lhs
        && matches!(p.object, Expression::Variable(Variable::Direct(v)) if v.name == table)
    {
        return Some(vec![]);
    }
    // The chain, from the call on `$table` out: `$table->string('a')->nullable()->change()`.
    let mut chain = vec![];
    let mut e = expr;
    loop {
        match e {
            Expression::Call(Call::Method(c)) => {
                chain.push((String::from_utf8_lossy(method_name(&c.method)?).to_ascii_lowercase(), &c.argument_list));
                e = c.object;
            }
            Expression::Variable(Variable::Direct(v)) if v.name == table => break,
            _ => {
                // Something that doesn't touch the blueprint, such as a `DB::` call, changes no column.
                let mut touches = false;
                walk_node(Node::Expression(expr), &mut |n| {
                    touches |= matches!(n, Node::DirectVariable(v) if v.name == table);
                    !touches
                });
                return (!touches).then(Vec::new);
            }
        }
    }
    chain.reverse();
    let (method, list) = chain.first()?;
    let modifiers = &chain[1..];
    let has = |name: &str| modifiers.iter().find(|(m, _)| m == name);
    let nullable = match has("nullable") {
        Some((_, list)) => match argument(list, 0, "value") {
            None => true,
            Some(Expression::Literal(Literal::True(_))) => true,
            Some(Expression::Literal(Literal::False(_))) => false,
            Some(_) => return None,
        },
        None => false,
    };
    let change = has("change").is_some();
    let name = || argument(list, 0, "column").and_then(string);
    let col = |name: String, ty: &'static str, date: bool| Column { name, ty, nullable, date };
    let add = |c: Column| if change { ColumnOp::Change(c) } else { ColumnOp::Add(c) };
    let m = method.as_str();
    if let Some(ty) = column_type(m) {
        let date = DATE_COLUMNS.contains(&m);
        let name = match m {
            "id" | "increments" if argument(list, 0, "column").is_none() => "id".to_string(),
            "remembertoken" => return Some(vec![add(Column { name: "remember_token".into(), ty: "string", nullable: true, date: false })]),
            _ => name()?,
        };
        return Some(vec![add(col(name, ty, date))]);
    }
    let timestamp = |name: &str, nullable: bool| ColumnOp::Add(Column { name: name.into(), ty: "string", nullable, date: true });
    Some(match m {
        "timestamps" | "nullabletimestamps" | "timestampstz" | "datetimes" => vec![timestamp("created_at", true), timestamp("updated_at", true)],
        "softdeletes" | "softdeletestz" | "softdeletesdatetime" => vec![timestamp(&argument(list, 0, "column").and_then(string).unwrap_or_else(|| "deleted_at".into()), true)],
        "morphs" | "nullablemorphs" | "uuidmorphs" | "nullableuuidmorphs" | "ulidmorphs" | "nullableulidmorphs" | "numericmorphs" | "nullablenumericmorphs" => {
            let name = name()?;
            let nullable = m.starts_with("nullable");
            // `morphs()` uses Laravel's default morph key type, which an app can change.
            let id = if m.contains("uuid") || m.contains("ulid") { "string" } else if m.contains("numeric") { "int" } else { "" };
            vec![
                ColumnOp::Add(Column { name: format!("{name}_type"), ty: "string", nullable, date: false }),
                ColumnOp::Add(Column { name: format!("{name}_id"), ty: id, nullable, date: false }),
            ]
        }
        "foreignidfor" => return None,
        "dropcolumn" | "dropcolumns" => {
            let columns: Option<Vec<String>> = match positional(list)?.as_slice() {
                [one] => strings(one),
                many => many.iter().map(|e| string(e)).collect(),
            };
            columns?.into_iter().map(ColumnOp::Drop).collect()
        }
        "dropconstrainedforeignid" => vec![ColumnOp::Drop(name()?)],
        "renamecolumn" => vec![ColumnOp::Rename(name()?, argument(list, 1, "to").and_then(string)?)],
        "droptimestamps" | "droptimestampstz" => vec![ColumnOp::Drop("created_at".into()), ColumnOp::Drop("updated_at".into())],
        "dropsoftdeletes" | "dropsoftdeletestz" => vec![ColumnOp::Drop(argument(list, 0, "column").and_then(string).unwrap_or_else(|| "deleted_at".into()))],
        "dropremembertoken" => vec![ColumnOp::Drop("remember_token".into())],
        "dropmorphs" => {
            let name = name()?;
            vec![ColumnOp::Drop(format!("{name}_type")), ColumnOp::Drop(format!("{name}_id"))]
        }
        _ if NOT_COLUMNS.contains(&m) => vec![],
        // A macro or a method this list doesn't know.
        _ => return None,
    })
}

/// Blueprint methods that change no column: indexes, keys, and table options.
const NOT_COLUMNS: &[&str] = &[
    "primary", "unique", "index", "fulltext", "spatialindex", "rawindex", "foreign", "dropprimary", "dropunique", "dropindex", "dropfulltext",
    "dropspatialindex", "dropforeign", "dropforeignidfor", "renameindex", "engine", "charset", "collation", "comment", "temporary", "innodb",
    "dropifexists", "drop", "create",
];

/// Column methods whose values are dates or times.
const DATE_COLUMNS: &[&str] = &["date", "datetime", "datetimetz", "time", "timetz", "timestamp", "timestamptz"];

/// The PHP type a column method's values come back as, without a cast: `""` when it depends on the database.
fn column_type(method: &str) -> Option<&'static str> {
    Some(match method {
        "id" | "increments" | "integerincrements" | "tinyincrements" | "smallincrements" | "mediumincrements" | "bigincrements" | "integer"
        | "tinyinteger" | "smallinteger" | "mediuminteger" | "biginteger" | "unsignedinteger" | "unsignedtinyinteger" | "unsignedsmallinteger"
        | "unsignedmediuminteger" | "unsignedbiginteger" | "foreignid" | "year" => "int",
        "string" | "char" | "text" | "tinytext" | "mediumtext" | "longtext" | "uuid" | "ulid" | "foreignuuid" | "foreignulid" | "ipaddress"
        | "macaddress" | "enum" | "set" | "binary" | "json" | "jsonb" | "date" | "datetime" | "datetimetz" | "time" | "timetz" | "timestamp"
        | "timestamptz" | "remembertoken" => "string",
        // PDO gives decimals as numeric strings.
        "decimal" | "unsigneddecimal" => "numeric-string",
        "float" | "double" | "unsignedfloat" | "unsigneddouble" => "float",
        // MySQL's TINYINT(1) comes back as an int; PostgreSQL's and SQLite's booleans as bools.
        "boolean" => "bool|int",
        "geometry" | "geography" | "point" | "linestring" | "polygon" | "multipoint" | "multilinestring" | "multipolygon" | "geometrycollection" | "vector"
        | "computed" => "",
        _ => return None,
    })
}

// ---- The whole project ----

/// What the project's files say about Eloquent, combined.
#[derive(Debug, Default)]
pub struct Eloquent {
    pub tables: BTreeMap<String, Table>,
    /// Set when a migration may have changed any table, such as `Schema::table($name, …)`.
    pub all_uncertain: bool,
    /// By lowercase class name.
    pub models: HashMap<String, ModelDecl>,
    /// `Relation::morphMap()` entries: alias, class.
    pub morph_map: Vec<(String, String)>,
    pub enforces_morph_map: bool,
    /// The app eager-loads every relationship it reads.
    pub auto_eager_loads: bool,
    /// The app adds relationships with `resolveRelationUsing()`, so a name no method has may be one.
    pub dynamic_relations: bool,
}

impl Eloquent {
    /// Combines files' facts. Migrations run in the order of their file names, as Laravel runs them.
    pub fn new<'f>(files: impl Iterator<Item = (&'f Path, &'f FileFacts)>) -> Self {
        let mut out = Eloquent::default();
        let mut migrations: Vec<(&std::ffi::OsStr, &[Op])> = vec![];
        for (path, facts) in files {
            if let (Some(ops), Some(name)) = (&facts.migration, path.file_name()) {
                migrations.push((name, ops));
            }
            for decl in &facts.models {
                out.models.insert(decl.class.to_ascii_lowercase(), decl.clone());
            }
            out.morph_map.extend(facts.morph_map.iter().cloned());
            out.enforces_morph_map |= facts.enforces_morph_map;
            out.auto_eager_loads |= facts.auto_eager_loads;
            out.dynamic_relations |= facts.dynamic_relations;
        }
        migrations.sort_by_key(|(name, _)| *name);
        let mut sql: Vec<String> = vec![];
        for op in migrations.into_iter().flat_map(|(_, ops)| ops) {
            out.apply(op, &mut sql);
        }
        // Raw SQL that names a table may change it.
        for statement in sql {
            let lower = statement.to_ascii_lowercase();
            for (name, table) in &mut out.tables {
                let named = lower.match_indices(name.as_str()).any(|(at, _)| {
                    let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
                    !word(lower[..at].chars().next_back()) && !word(lower[at + name.len()..].chars().next())
                });
                if named {
                    table.certain = false;
                }
            }
        }
        out.morph_map.sort();
        out.morph_map.dedup();
        out
    }

    fn apply(&mut self, op: &Op, sql: &mut Vec<String>) {
        match op {
            Op::Create { table, columns, certain } => {
                let mut t = Table { columns: vec![], certain: *certain };
                apply_columns(&mut t, columns);
                self.tables.insert(table.clone(), t);
            }
            Op::Alter { table, columns, certain } => {
                // A table the migrations didn't create, as one from a schema dump, has columns they don't know.
                let t = self.tables.entry(table.clone()).or_default();
                t.certain &= *certain;
                apply_columns(t, columns);
            }
            Op::Rename { from, to } => {
                let t = self.tables.remove(from).unwrap_or_default();
                self.tables.insert(to.clone(), t);
            }
            Op::Drop(table) => {
                self.tables.remove(table);
            }
            Op::Uncertain(Some(raw)) if raw.starts_with("sql:") => sql.push(raw[4..].to_string()),
            Op::Uncertain(Some(table)) => self.tables.entry(table.clone()).or_default().certain = false,
            Op::Uncertain(None) => self.all_uncertain = true,
        }
    }

    /// A table, if the migrations build it.
    pub fn table(&self, name: &str) -> Option<&Table> {
        self.tables.get(name)
    }

    /// Whether warnings may be based on a table's columns.
    pub fn is_certain(&self, table: &Table) -> bool {
        table.certain && !self.all_uncertain
    }

    pub fn decl(&self, class: &str) -> Option<&ModelDecl> {
        self.models.get(&class.trim_start_matches('\\').to_ascii_lowercase())
    }

    /// The declarations that apply to `class`, its own first, then its traits', then its parents' and theirs.
    pub fn decls<'s>(&'s self, codebase: &CodebaseMetadata, class: &str) -> Vec<&'s ModelDecl> {
        let mut names = vec![class.trim_start_matches('\\').to_string()];
        if let Some(meta) = codebase.get_class_like(class.as_bytes()) {
            names.extend(meta.used_traits.iter().map(|t| t.as_str_lossy().into_owned()));
            for parent in meta.all_parent_classes.iter() {
                names.push(parent.as_str_lossy().into_owned());
                if let Some(p) = codebase.get_class_like(parent.as_bytes()) {
                    names.extend(p.used_traits.iter().map(|t| t.as_str_lossy().into_owned()));
                }
            }
        }
        let mut seen = std::collections::HashSet::new();
        names.into_iter().filter(|n| seen.insert(n.to_ascii_lowercase())).filter_map(|n| self.decl(&n)).collect()
    }

    /// The table `class`'s queries use: the `$table` it or a parent declares, else Laravel's name for it, the plural of
    /// its name in snake case (a pivot model's is singular).
    pub fn table_name(&self, codebase: &CodebaseMetadata, class: &str) -> String {
        if let Some(table) = self.decls(codebase, class).into_iter().find_map(|d| d.table.clone()) {
            return table;
        }
        let base = class.rsplit('\\').next().unwrap_or(class);
        let pivot = codebase.class_extends(class.as_bytes(), b"Illuminate\\Database\\Eloquent\\Relations\\Pivot");
        if pivot { snake(base).replace('\\', "") } else { snake(&plural_studly(base)) }
    }

    /// The table of `class`, when the migrations build it.
    pub fn table_of(&self, codebase: &CodebaseMetadata, class: &str) -> Option<&Table> {
        self.table(&self.table_name(codebase, class))
    }

    /// Every relationship `class` declares, its own first.
    pub fn relations<'s>(&'s self, codebase: &CodebaseMetadata, class: &str) -> Vec<&'s RelationDecl> {
        let mut out: Vec<&RelationDecl> = vec![];
        for decl in self.decls(codebase, class) {
            for r in &decl.relations {
                if !out.iter().any(|o| o.name.eq_ignore_ascii_case(&r.name)) {
                    out.push(r);
                }
            }
        }
        out
    }

    /// The casts `class` declares, or `None` when they can't all be read.
    pub fn casts(&self, codebase: &CodebaseMetadata, class: &str) -> Option<Vec<(String, String)>> {
        if !self.casts_known(codebase, class) {
            return None;
        }
        let mut out: Vec<(String, String)> = vec![];
        for decl in self.decls(codebase, class) {
            for (k, v) in decl.casts.as_ref()? {
                if !out.iter().any(|(o, _)| o == k) {
                    out.push((k.clone(), v.clone()));
                }
            }
        }
        Some(out)
    }

    /// Whether every cast `class` gets is in a declaration read from the project. A class the project's files don't
    /// declare that has `$casts` or `casts()` of its own, such as Sanctum's `PersonalAccessToken` in `vendor`, or a
    /// trait outside Eloquent with an `initialize…()` method, which may merge casts, leaves them unknown. Eloquent's own
    /// classes and traits add none but soft deletes' `deleted_at`, which [`attribute_type`] knows.
    fn casts_known(&self, codebase: &CodebaseMetadata, class: &str) -> bool {
        let Some(meta) = codebase.get_class_like(class.as_bytes()) else { return true };
        let eloquent = |name: &str| name.trim_start_matches('\\').to_ascii_lowercase().starts_with("illuminate\\database\\eloquent\\");
        let unread = |name: &str| !eloquent(name) && self.decl(name).is_none();
        let property = meta.declaring_property_ids.iter().find(|(k, _)| k.as_bytes() == b"$casts").map(|(_, c)| c.as_str_lossy().into_owned());
        let method = codebase.get_declaring_method_class(class.as_bytes(), b"casts").map(|c| c.as_str_lossy().into_owned());
        if property.iter().chain(method.iter()).any(|c| unread(c)) {
            return false;
        }
        let mut traits: Vec<String> = meta.used_traits.iter().map(|t| t.as_str_lossy().into_owned()).collect();
        for parent in meta.all_parent_classes.iter() {
            if let Some(p) = codebase.get_class_like(parent.as_bytes()) {
                traits.extend(p.used_traits.iter().map(|t| t.as_str_lossy().into_owned()));
            }
        }
        !traits.iter().filter(|t| !eloquent(t)).any(|t| {
            let short = t.rsplit('\\').next().unwrap_or(t);
            codebase.method_exists(t.as_bytes(), format!("initialize{short}").as_bytes())
        })
    }

    /// The class an alias stands for in morph columns, such as `post` for `App\Models\Post`.
    pub fn morph_class(&self, alias: &str) -> Option<&str> {
        self.morph_map.iter().find(|(a, _)| a == alias).map(|(_, c)| c.as_str())
    }

    /// What a morph column holds for `class`: its alias, or its class name when the map doesn't list it.
    pub fn morph_alias<'a>(&'a self, class: &'a str) -> &'a str {
        self.morph_map.iter().find(|(_, c)| c.eq_ignore_ascii_case(class)).map_or(class, |(a, _)| a.as_str())
    }
}

/// Introspection of a Filament resource (`introspect.php resource`), with the migrations' columns where the
/// database couldn't be read: its model's, and each relationship's related model's. A table the migrations surely
/// build replaces the guess from `$fillable` and casts, so its columns back warnings; an uncertain one adds to it.
pub fn fill_guessed_columns(eloquent: &Eloquent, codebase: &CodebaseMetadata, value: std::sync::Arc<serde_json::Value>) -> std::sync::Arc<serde_json::Value> {
    use serde_json::{Value, json};
    let guessed = |m: &Value| m["columnsGuessed"] == true;
    let model = &value["model"];
    if !guessed(model) && !model["relations"].as_array().is_some_and(|r| r.iter().any(guessed)) {
        return value;
    }
    let fill = |target: &mut Value, class: Option<&str>| {
        let Some(table) = class.and_then(|c| eloquent.table_of(codebase, c)) else { return };
        let mut columns: Vec<Value> = table.columns.iter().map(|c| json!(c.name)).collect();
        if eloquent.is_certain(table) {
            target["columnsGuessed"] = json!(false);
        } else {
            for c in target["columns"].as_array().into_iter().flatten() {
                if !columns.contains(c) {
                    columns.push(c.clone());
                }
            }
        }
        target["columns"] = Value::Array(columns);
    };
    let mut out = (*value).clone();
    if guessed(model) {
        let class = model["class"].as_str().map(String::from);
        fill(&mut out["model"], class.as_deref());
    }
    for r in out["model"]["relations"].as_array_mut().into_iter().flatten() {
        if guessed(r) {
            let class = r["related"].as_str().map(String::from);
            fill(r, class.as_deref());
        }
    }
    std::sync::Arc::new(out)
}

fn apply_columns(table: &mut Table, ops: &[ColumnOp]) {
    for op in ops {
        match op {
            ColumnOp::Add(c) | ColumnOp::Change(c) => match table.columns.iter_mut().find(|o| o.name == c.name) {
                Some(old) => *old = c.clone(),
                None => table.columns.push(c.clone()),
            },
            ColumnOp::Drop(name) => table.columns.retain(|c| c.name != *name),
            ColumnOp::Rename(from, to) => {
                if let Some(c) = table.columns.iter_mut().find(|c| c.name == *from) {
                    c.name = to.clone();
                }
            }
        }
    }
}

// ---- Names ----

/// Laravel's `Str::snake()`: `EmergencySOS` gives `emergency_s_o_s`.
pub fn snake(name: &str) -> String {
    if name.chars().all(|c| !c.is_uppercase()) {
        return name.to_string();
    }
    let mut out = String::new();
    let chars: Vec<char> = name.chars().filter(|c| !c.is_whitespace()).collect();
    for (i, c) in chars.iter().enumerate() {
        if i > 0 && c.is_uppercase() {
            out.push('_');
        }
        out.extend(c.to_lowercase());
    }
    out
}

/// Laravel's `Str::pluralStudly()`: the plural of the last word, `MunicipalityBranch` giving
/// `MunicipalityBranches`.
pub fn plural_studly(name: &str) -> String {
    let at = name.char_indices().rfind(|(_, c)| c.is_uppercase()).map_or(0, |(i, _)| i);
    format!("{}{}", &name[..at], plural(&name[at..]))
}

/// English plurals, after the rules of Doctrine's inflector that Laravel uses, keeping the word's case.
// ponytail: the common rules and exceptions only; Doctrine has a few hundred. A model whose table this names wrongly
// gets no columns, not wrong ones, unless another table has that name.
pub fn plural(word: &str) -> String {
    const UNCOUNTABLE: &[&str] = &[
        "audio", "bison", "cattle", "chassis", "compensation", "coreopsis", "data", "deer", "education", "emoji", "equipment", "evidence",
        "feedback", "firmware", "fish", "furniture", "gold", "hardware", "information", "jedi", "kin", "knowledge", "love", "media",
        "metadata", "money", "moose", "music", "news", "nutrition", "offspring", "plankton", "pokemon", "police", "rain", "recommended",
        "related", "rice", "series", "sheep", "software", "species", "staff", "swine", "traffic", "wheat",
    ];
    const IRREGULAR: &[(&str, &str)] = &[
        ("person", "people"), ("man", "men"), ("woman", "women"), ("child", "children"), ("ox", "oxen"), ("foot", "feet"), ("tooth", "teeth"),
        ("goose", "geese"), ("mouse", "mice"), ("leaf", "leaves"), ("life", "lives"), ("wife", "wives"), ("knife", "knives"), ("half", "halves"),
        ("wolf", "wolves"), ("shelf", "shelves"), ("thief", "thieves"), ("calf", "calves"), ("loaf", "loaves"), ("self", "selves"),
        ("criterion", "criteria"), ("phenomenon", "phenomena"), ("cactus", "cacti"), ("alumnus", "alumni"), ("focus", "foci"),
        ("syllabus", "syllabi"), ("datum", "data"), ("medium", "media"), ("curriculum", "curricula"), ("index", "indices"),
        ("matrix", "matrices"), ("vertex", "vertices"), ("appendix", "appendixes"), ("lens", "lenses"), ("quiz", "quizzes"), ("move", "moves"), ("hero", "heroes"),
        ("potato", "potatoes"), ("tomato", "tomatoes"), ("echo", "echoes"), ("veto", "vetoes"), ("axis", "axes"), ("genus", "genera"),
        ("octopus", "octopuses"), ("virus", "viri"),
    ];
    if word.is_empty() {
        return String::new();
    }
    let lower = word.to_ascii_lowercase();
    let plural = if UNCOUNTABLE.iter().any(|u| lower.ends_with(u) && (lower.len() == u.len())) {
        lower.clone()
    } else if let Some((_, p)) = IRREGULAR.iter().find(|(s, _)| lower == *s) {
        p.to_string()
    } else if lower.ends_with("sis") {
        format!("{}ses", &lower[..lower.len() - 3])
    } else if ["ss", "x", "z", "ch", "sh"].iter().any(|e| lower.ends_with(e)) || (lower.ends_with('s') && lower[..lower.len() - 1].ends_with(['a', 'e', 'i', 'o', 'u'])) {
        format!("{lower}es")
    } else if lower.ends_with('s') {
        // A word that ends in a consonant and `s`, such as `settings`, is taken to be plural already.
        lower.clone()
    } else if lower.ends_with('y') && !lower[..lower.len() - 1].ends_with(['a', 'e', 'i', 'o', 'u']) {
        format!("{}ies", &lower[..lower.len() - 1])
    } else {
        format!("{lower}s")
    };
    // Laravel matches the word's case: all capitals, or a capital first.
    if word.chars().all(|c| !c.is_lowercase()) {
        plural.to_uppercase()
    } else if word.starts_with(char::is_uppercase) {
        let mut c = plural.chars();
        c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
    } else {
        plural
    }
}

/// `camelCase` for a `snake_case` name, as `Str::camel()` gives.
pub fn camel(name: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for c in name.chars() {
        if c == '_' || c == '-' || c == ' ' {
            upper = !out.is_empty();
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// The PHP type a cast gives an attribute, or `None` for a cast whose type isn't known, such as a custom cast class.
pub fn cast_type(codebase: &CodebaseMetadata, cast: &str) -> Option<String> {
    let base = cast.split(':').next().unwrap_or(cast).trim_start_matches('\\');
    Some(match base.to_ascii_lowercase().as_str() {
        "int" | "integer" | "timestamp" => "int".into(),
        "real" | "float" | "double" => "float".into(),
        "decimal" => "numeric-string".into(),
        "string" | "hashed" | "encrypted" => "string".into(),
        "bool" | "boolean" => "bool".into(),
        "array" | "json" | "encrypted:array" | "encrypted:json" => "array".into(),
        "object" | "encrypted:object" => "\\stdClass".into(),
        "collection" | "encrypted:collection" => "\\Illuminate\\Support\\Collection".into(),
        "date" | "datetime" | "custom_datetime" => "\\Illuminate\\Support\\Carbon".into(),
        "immutable_date" | "immutable_datetime" | "immutable_custom_datetime" => "\\Carbon\\CarbonImmutable".into(),
        _ if codebase.enum_exists(base.as_bytes()) => format!("\\{}", codebase.get_class_like(base.as_bytes())?.original_name.as_str_lossy()),
        "illuminate\\database\\eloquent\\casts\\asarrayobject" | "illuminate\\database\\eloquent\\casts\\asencryptedarrayobject" => {
            "\\Illuminate\\Database\\Eloquent\\Casts\\ArrayObject".into()
        }
        "illuminate\\database\\eloquent\\casts\\ascollection" | "illuminate\\database\\eloquent\\casts\\asencryptedcollection" => {
            "\\Illuminate\\Support\\Collection".into()
        }
        "illuminate\\database\\eloquent\\casts\\asstringable" => "\\Illuminate\\Support\\Stringable".into(),
        _ => return None,
    })
}

/// The type `class`'s `column` attribute has, as Laravel reads it from the migrations' column and the model's casts:
/// `(type, nullable)`, where a type that ends in `|lenient-null` is null only before the model is saved. `None` when unknown: no such column, a cast of unknown type, casts that can't be read, or an
/// accessor of that name.
pub fn attribute_type(eloquent: &Eloquent, codebase: &CodebaseMetadata, class: &str, column: &str) -> Option<(String, bool)> {
    let table = eloquent.table_of(codebase, class)?;
    let c = table.column(column)?;
    // An accessor, `getTitleAttribute()` or `title(): Attribute`, decides the value.
    let studly = {
        let camel = camel(column);
        let mut chars = camel.chars();
        chars.next().map(|f| f.to_uppercase().chain(chars).collect::<String>()).unwrap_or_default()
    };
    if codebase.method_exists(class.as_bytes(), format!("get{studly}Attribute").as_bytes()) || codebase.method_exists(class.as_bytes(), camel(column).as_bytes()) {
        return None;
    }
    let casts = eloquent.casts(codebase, class)?;
    if let Some((_, cast)) = casts.iter().find(|(k, _)| k == column) {
        return Some((cast_type(codebase, cast)?, c.nullable));
    }
    // Timestamps and soft deletes are dates, which Laravel gives as Carbon.
    let timestamps = eloquent.decls(codebase, class).into_iter().find_map(|d| d.timestamps).unwrap_or(true);
    // `timestamps()` makes nullable columns, which Laravel fills on every save: null only on a model not saved yet,
    // as in a `creating` observer. So null is allowed, but calls on them aren't reported as calls on null.
    if c.date && timestamps && (column == "created_at" || column == "updated_at") {
        return Some(("\\Illuminate\\Support\\Carbon|lenient-null".into(), true));
    }
    if c.date && column == "deleted_at" && uses_trait(codebase, class, "Illuminate\\Database\\Eloquent\\SoftDeletes") {
        return Some(("\\Illuminate\\Support\\Carbon".into(), c.nullable));
    }
    (!c.ty.is_empty()).then(|| (c.ty.to_string(), c.nullable))
}

fn uses_trait(codebase: &CodebaseMetadata, class: &str, name: &str) -> bool {
    let Some(meta) = codebase.get_class_like(class.as_bytes()) else { return false };
    meta.used_traits.iter().any(|t| t.as_bytes().eq_ignore_ascii_case(name.as_bytes()))
        || meta.all_parent_classes.iter().any(|p| codebase.get_class_like(p.as_bytes()).is_some_and(|p| p.used_traits.iter().any(|t| t.as_bytes().eq_ignore_ascii_case(name.as_bytes()))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(rel: &str, text: &str) -> FileFacts {
        let arena = mago_allocator::LocalArena::new();
        let path = Path::new("/project").join(rel);
        let parsed = Parsed::new(&arena, &path, text);
        read_file(&parsed, Path::new(rel)).unwrap_or_default()
    }

    fn schema(files: &[(&str, &str)]) -> Eloquent {
        let all: Vec<(std::path::PathBuf, FileFacts)> = files.iter().map(|(name, text)| (Path::new(name).to_path_buf(), facts(name, text))).collect();
        Eloquent::new(all.iter().map(|(p, f)| (p.as_path(), f)))
    }

    fn migration(body: &str) -> String {
        format!("<?php\nuse Illuminate\\Database\\Migrations\\Migration;\nuse Illuminate\\Database\\Schema\\Blueprint;\nuse Illuminate\\Support\\Facades\\Schema;\nreturn new class extends Migration {{\n    public function up(): void\n    {{\n{body}\n    }}\n    public function down(): void {{ Schema::dropIfExists('posts'); }}\n}};\n")
    }

    fn columns(e: &Eloquent, table: &str) -> Vec<(String, &'static str, bool)> {
        e.table(table).unwrap().columns.iter().map(|c| (c.name.clone(), c.ty, c.nullable)).collect()
    }

    #[test]
    fn builds_tables_from_migrations_in_file_name_order() {
        let create = migration(
            "Schema::create('posts', function (Blueprint $table) {
                $table->id();
                $table->string('title');
                $table->text('body')->nullable();
                $table->boolean('draft')->default(true);
                $table->decimal('price', 8, 2);
                $table->foreignId('author_id')->constrained();
                $table->morphs('commentable');
                $table->rememberToken();
                $table->timestamps();
                $table->softDeletes();
                $table->index(['title']);
                $table->engine = 'InnoDB';
            });",
        );
        let alter = migration(
            "Schema::table('posts', function (Blueprint $table) {
                $table->string('title')->nullable()->change();
                $table->renameColumn('body', 'content');
                $table->dropColumn(['price', 'remember_token']);
                $table->uuid('ref')->nullable()->after('id');
            });
            Schema::rename('posts', 'articles');",
        );
        // Out of order on purpose: names decide.
        let e = schema(&[("database/migrations/2024_02_01_000000_alter.php", &alter), ("database/migrations/2024_01_01_000000_create.php", &create)]);
        assert!(e.table("posts").is_none());
        assert_eq!(
            columns(&e, "articles"),
            vec![
                ("id".into(), "int", false),
                ("title".into(), "string", true),
                ("content".into(), "string", true),
                ("draft".into(), "bool|int", false),
                ("author_id".into(), "int", false),
                ("commentable_type".into(), "string", false),
                ("commentable_id".into(), "", false),
                ("created_at".into(), "string", true),
                ("updated_at".into(), "string", true),
                ("deleted_at".into(), "string", true),
                ("ref".into(), "string", true),
            ]
        );
        assert!(e.is_certain(e.table("articles").unwrap()));
    }

    #[test]
    fn marks_what_it_cannot_read_uncertain() {
        let conditional = migration(
            "if (! Schema::hasTable('tags')) { Schema::create('tags', function (Blueprint $table) { $table->id(); }); }
            Schema::create('posts', function (Blueprint $table) {
                $table->id();
                if (config('x')) { $table->string('extra'); }
            });
            Schema::create('users', function (Blueprint $table) { $table->id(); $table->macroColumn('x'); });
            Schema::create('teams', fn (Blueprint $table) => $table->string($name));
            Schema::create('roles', function (Blueprint $table) { $table->id(); });
            DB::statement('ALTER TABLE roles ADD COLUMN x int');
            Schema::create('plain', function (Blueprint $table) { $table->id(); DB::table('x')->insert([]); });",
        );
        let e = schema(&[("database/migrations/2024_01_01_000000_a.php", &conditional)]);
        for t in ["tags", "posts", "users", "teams", "roles"] {
            assert!(!e.is_certain(e.table(t).unwrap()), "{t}");
        }
        assert!(e.is_certain(e.table("plain").unwrap()));
        assert!(!e.all_uncertain);
        // A table altered by a name that isn't a literal could be any table.
        let any = migration("Schema::table($this->table, function (Blueprint $table) { $table->string('x'); });");
        assert!(schema(&[("database/migrations/2024_01_01_000000_a.php", &any)]).all_uncertain);
        // One the migrations didn't create, as from a schema dump, has columns they don't show.
        let alter = migration("Schema::table('legacy', function (Blueprint $table) { $table->string('x'); });");
        let e = schema(&[("database/migrations/2024_01_01_000000_a.php", &alter)]);
        assert!(!e.is_certain(e.table("legacy").unwrap()));
        // Files outside the migrations folder aren't migrations.
        assert!(facts("app/Foo.php", &migration("Schema::create('x', function ($t) { $t->id(); });")).migration.is_none());
    }

    #[test]
    fn reads_model_declarations_and_morph_maps() {
        let model = "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nuse Illuminate\\Database\\Eloquent\\Attributes\\Table;\n#[Table('blog_posts')]\nclass Post extends Model {\n    public $timestamps = false;\n    protected $casts = ['published_at' => 'datetime', 'status' => 'string'];\n    protected function casts(): array { return ['status' => Status::class]; }\n    public function author() { return $this->belongsTo(User::class)->withDefault(); }\n    public function comments(): MorphMany { return $this->morphMany(Comment::class, 'commentable'); }\n    public function commentable() { return $this->morphTo(); }\n    public function scopeX($q, $y) { return $this->hasMany(User::class); }\n}\n";
        let f = facts("app/Models/Post.php", model);
        let decl = &f.models[0];
        assert_eq!(decl.class, "App\\Models\\Post");
        assert_eq!(decl.table.as_deref(), Some("blog_posts"));
        assert_eq!(decl.timestamps, Some(false));
        assert_eq!(decl.casts, Some(vec![("status".into(), "App\\Models\\Status".into()), ("published_at".into(), "datetime".into())]));
        let relations: Vec<_> = decl.relations.iter().map(|r| (r.name.as_str(), r.kind.as_str(), r.related.as_deref(), r.morph.as_deref())).collect();
        assert_eq!(
            relations,
            vec![
                ("author", "belongsTo", Some("App\\Models\\User"), None),
                ("comments", "morphMany", Some("App\\Models\\Comment"), Some("commentable")),
                ("commentable", "morphTo", None, Some("commentable")),
            ]
        );
        // `casts()` that isn't a literal array may add any cast.
        let merged = facts("app/Models/A.php", "<?php\nclass A { protected function casts(): array { return array_merge(parent::casts(), []); } }");
        assert_eq!(merged.models[0].casts, None);
        let provider = "<?php\nnamespace App\\Providers;\nuse Illuminate\\Database\\Eloquent\\Relations\\Relation;\nuse App\\Models\\Post;\nclass AppServiceProvider { public function boot(): void { Relation::enforceMorphMap(['post' => Post::class, 'video' => 'App\\Models\\Video']); } }";
        let f = facts("app/Providers/AppServiceProvider.php", provider);
        assert!(f.enforces_morph_map);
        assert_eq!(f.morph_map, vec![("post".into(), "App\\Models\\Post".into()), ("video".into(), "App\\Models\\Video".into())]);
    }

    #[test]
    fn fills_columns_the_database_did_not_give() {
        let create = migration("Schema::create('posts', function (Blueprint $table) { $table->id(); $table->string('title'); });\n        Schema::create('comments', function (Blueprint $table) { $table->id(); if (true) { $table->text('x'); } });");
        let e = schema(&[("database/migrations/2024_01_01_000000_create.php", &create)]);
        let codebase = CodebaseMetadata::default();
        let value = serde_json::json!({"model": {"class": "App\\Models\\Post", "columns": ["id", "title_guess"], "columnsGuessed": true, "relations": [
            {"name": "comments", "related": "App\\Models\\Comment", "columns": ["id", "body"], "columnsGuessed": true},
            {"name": "tags", "related": "App\\Models\\Tag", "columns": ["id"], "columnsGuessed": true},
        ]}});
        let out = fill_guessed_columns(&e, &codebase, std::sync::Arc::new(value));
        // A certain table replaces the guess; an uncertain one adds to it; one the migrations don't build stays.
        assert_eq!(out["model"]["columns"], serde_json::json!(["id", "title"]));
        assert_eq!(out["model"]["columnsGuessed"], false);
        assert_eq!(out["model"]["relations"][0]["columns"], serde_json::json!(["id", "body"]));
        assert_eq!(out["model"]["relations"][0]["columnsGuessed"], true);
        assert_eq!(out["model"]["relations"][1]["columns"], serde_json::json!(["id"]));
        // What the database gave stays as it is.
        let live = std::sync::Arc::new(serde_json::json!({"model": {"class": "App\\Models\\Post", "columns": ["id"], "columnsGuessed": false, "relations": []}}));
        assert!(std::sync::Arc::ptr_eq(&fill_guessed_columns(&e, &codebase, live.clone()), &live));
    }

    #[test]
    fn names_tables_as_laravel_does() {
        assert_eq!(snake(&plural_studly("MunicipalityBranch")), "municipality_branches");
        assert_eq!(snake(&plural_studly("Category")), "categories");
        assert_eq!(snake(&plural_studly("Person")), "people");
        assert_eq!(snake(&plural_studly("Media")), "media");
        assert_eq!(snake(&plural_studly("Status")), "statuses");
        assert_eq!(snake(&plural_studly("Day")), "days");
        assert_eq!(snake(&plural_studly("FAQ")), "f_a_q_s");
        assert_eq!(snake("EmergencySOS"), "emergency_s_o_s");
        assert_eq!(snake(&plural_studly("EmergencySOS")), "emergency_s_o_s");
        assert_eq!(snake(&plural_studly("UserSettings")), "user_settings");
        assert_eq!(snake(&plural_studly("Address")), "addresses");
        assert_eq!(snake(&plural_studly("Bonus")), "bonuses");
        assert_eq!(snake(&plural_studly("Fly")), "flies");
        assert_eq!(camel("created_at"), "createdAt");
    }
}
