//! Eloquent's strings in query calls: attribute names (`where('title')`), relationship paths (`with('posts.comments')`,
//! `whereHas('posts.comments', …)`, `with('posts:id,title')`), the aggregates a chain adds (`withCount('comments')`
//! then `orderBy('comments_count')`), and morph aliases (`where('commentable_type', 'post')`).
//!
//! A model's attributes and relationships come from the booted app (`models.php`, which reads the database) when
//! it has them, else from what the index reads: the migrations' columns and the relationship methods models declare
//! ([`schema`]). Only the booted app's list is complete, so only it backs a warning about a relationship that
//! doesn't exist.

use std::sync::Arc;

use lsp_types::{CompletionItem, CompletionItemKind, Diagnostic, DiagnosticSeverity, Hover, HoverContents, Location, MarkupContent, MarkupKind, NumberOrString};
use mago_span::HasSpan;
use mago_syntax::cst::{ClassLikeMemberSelector, Expression, Node};
use serde_json::Value;

use super::attributes::call_aggregates;
use super::data::Data;
use super::forwarding::{ELOQUENT_BUILDER, MODEL};
use super::{SOURCE, completion_item};
use crate::features::Ctx;
use crate::framework::{Call, CallKind, InArray, StringArg};
use crate::symbol::Symbol;

/// The methods whose first argument names a relationship, or a dotted path of them.
pub const RELATION_METHODS: &[&str] = &[
    "doesntHave", "doesntHaveMorph", "has", "hasMorph", "orDoesntHave", "orDoesntHaveMorph", "orHas", "orHasMorph", "orWhereDoesntHave",
    "orWhereDoesntHaveMorph", "orWhereHas", "orWhereHasMorph", "whereDoesntHave", "whereDoesntHaveMorph", "whereHas", "whereHasMorph", "with",
    "withWhereHas", "without", "withOnly", "whereRelation", "orWhereRelation", "withAggregate", "withAvg", "withCount", "withExists", "withMax",
    "withMin", "withSum", "load", "loadMissing", "loadAggregate", "loadAvg", "loadCount", "loadExists", "loadMax", "loadMin", "loadSum",
];

/// Relationship methods whose second argument names a column of the related model.
const COLUMN_SECOND: &[&str] = &["withAggregate", "withAvg", "withMax", "withMin", "withSum", "loadAggregate", "loadAvg", "loadMax", "loadMin", "loadSum", "whereRelation", "orWhereRelation"];

/// Methods whose first argument is an attribute.
const FIRST: &[&str] = &[
    "create", "fill", "firstWhere", "make", "max", "orderBy", "orderByDesc", "orWhere", "select", "sum", "update", "where", "whereColumn", "whereIn",
    "whereNotIn", "whereNull", "whereNotNull", "pluck", "value", "latest", "oldest", "min", "avg", "increment", "decrement", "groupBy", "having",
];
/// Methods whose array arguments' keys are attributes.
const ANY: &[&str] = &["createOrFirst", "firstOrNew", "firstOrCreate", "updateOrCreate"];

const ELOQUENT_COLLECTION: &str = "Illuminate\\Database\\Eloquent\\Collection";
const RELATION: &str = "Illuminate\\Database\\Eloquent\\Relations\\Relation";

/// What a model has that query strings name.
#[derive(Debug, Clone)]
pub struct Model {
    pub class: String,
    pub attributes: Vec<Attribute>,
    pub relations: Vec<Relation>,
    /// From the booted app, so the relationships are all there.
    pub live: bool,
}

#[derive(Debug, Clone)]
pub struct Attribute {
    pub name: String,
    pub fillable: bool,
    /// An accessor's attribute, which no query can use.
    pub accessor: bool,
    /// The column's type, when known.
    pub ty: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Relation {
    pub name: String,
    /// Its class's short name, such as `HasMany`, or the method that makes it, such as `hasMany`.
    pub kind: String,
    pub related: Option<String>,
}

impl Model {
    pub fn relation(&self, name: &str) -> Option<&Relation> {
        self.relations.iter().find(|r| r.name == name)
    }
}

/// The app's models: the booted app's facts when it has them, else the index's.
pub struct Models {
    live: Option<Arc<Value>>,
}

fn live_named<'m>(models: &'m serde_json::Map<String, Value>, class: &str) -> Option<(&'m String, &'m Value)> {
    let class = class.trim_start_matches('\\');
    models.iter().find(|(k, _)| k.trim_start_matches('\\').eq_ignore_ascii_case(class))
}

impl Models {
    pub fn new(data: &Data<'_>) -> Self {
        Models { live: data.models() }
    }

    pub fn get(&self, ctx: &Ctx<'_>, class: &str) -> Option<Model> {
        if let Some((name, m)) = self.live.as_ref().and_then(|l| l["models"].as_object()).and_then(|ms| live_named(ms, class)) {
            let attributes = m["attributes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|a| {
                    Some(Attribute {
                        name: a["name"].as_str()?.to_string(),
                        fillable: a["fillable"].as_bool() == Some(true),
                        accessor: matches!(a["cast"].as_str(), Some("accessor" | "attribute")),
                        ty: a["type"].as_str().map(String::from),
                    })
                })
                .collect();
            let relations = m["relations"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|r| Some(Relation { name: r["name"].as_str()?.to_string(), kind: r["type"].as_str().unwrap_or_default().to_string(), related: r["related"].as_str().map(String::from) }))
                .collect();
            return Some(Model { class: name.trim_start_matches('\\').to_string(), attributes, relations, live: true });
        }
        let codebase = &ctx.index.codebase;
        let meta = codebase.get_class_like(class.trim_start_matches('\\').as_bytes())?;
        if meta.flags.is_abstract() || !codebase.is_instance_of(meta.name.as_bytes(), MODEL.as_bytes()) {
            return None;
        }
        let class = meta.original_name.as_str_lossy().into_owned();
        let eloquent = &ctx.index.eloquent;
        let fillable = eloquent.decls(codebase, &class).into_iter().find_map(|d| d.fillable.clone());
        let mut attributes: Vec<Attribute> = eloquent
            .table_of(codebase, &class)
            .map(|t| t.columns.iter().map(|c| Attribute { name: c.name.clone(), fillable: fillable.as_ref().is_none_or(|f| f.contains(&c.name)), accessor: false, ty: (!c.ty.is_empty()).then(|| c.ty.to_string()) }).collect())
            .unwrap_or_default();
        for name in fillable.iter().flatten() {
            if !attributes.iter().any(|a| a.name == *name) {
                attributes.push(Attribute { name: name.clone(), fillable: true, accessor: false, ty: None });
            }
        }
        let relations = eloquent.relations(codebase, &class).into_iter().map(|r| Relation { name: r.name.clone(), kind: r.kind.clone(), related: r.related.clone() }).collect();
        Some(Model { class, attributes, relations, live: false })
    }

    /// The model at the end of a relationship path such as `posts.comments`, from `model`.
    pub fn walk(&self, ctx: &Ctx<'_>, model: Model, path: &[&str]) -> Option<Model> {
        let mut model = model;
        for name in path {
            let related = model.relation(name)?.related.clone()?;
            model = self.get(ctx, &related)?;
        }
        Some(model)
    }
}

/// Whether `class` answers Eloquent strings in `method`: a model, its builder, or a relation, and a collection of
/// models for `load()` and its attribute methods, such as `where()`. A collection's `has('key')` names a key.
fn answers(ctx: &Ctx<'_>, class: &str, method: &str) -> bool {
    let codebase = &ctx.index.codebase;
    let is = |parent: &str| class.eq_ignore_ascii_case(parent) || codebase.is_instance_of(class.as_bytes(), parent.as_bytes());
    let collection_method = method.to_ascii_lowercase().starts_with("load") || !RELATION_METHODS.iter().any(|m| m.eq_ignore_ascii_case(method));
    is(MODEL) || is(ELOQUENT_BUILDER) || is(RELATION) || (collection_method && is(ELOQUENT_COLLECTION))
}

/// The model a query call works on: the receiver when it's a model, the model a `Builder<User>`,
/// `HasMany<Post, User>`, or collection is of, or, inside a closure passed to a relationship method such as
/// `whereHas('author', fn ($q) => $q->where('…'))` or `with(['posts' => fn ($q) => …])`, the related model.
pub fn model_of(ctx: &Ctx<'_>, models: &Models, call: &Call, at: u32, depth: u8) -> Option<Model> {
    let receivers: Vec<&String> = call.classes.iter().filter(|c| answers(ctx, c, &call.name)).collect();
    if !receivers.is_empty() {
        if let Some(m) = receivers.iter().find_map(|c| models.get(ctx, c)) {
            return Some(m);
        }
        if let Some(m) = call.type_args.iter().find_map(|c| models.get(ctx, c)) {
            return Some(m);
        }
    }
    if depth > 4 {
        return None;
    }
    let path = ctx.parsed.path_at(at);
    let closure = path.iter().rposition(|n| matches!(n, Node::Closure(_) | Node::ArrowFunction(_)))?;
    let (i, outer_node) = path[..closure].iter().enumerate().rev().find(|(_, n)| matches!(n, Node::MethodCall(_) | Node::NullSafeMethodCall(_) | Node::StaticMethodCall(_)))?;
    let outer = crate::framework::call_of(ctx, outer_node, &path[..=i])?;
    if !outer.is_method(RELATION_METHODS) {
        return None;
    }
    // The relationship: the call's first argument, or the key the closure is the value of.
    let key = path[i..closure].iter().rev().find_map(|n| match n {
        Node::KeyValueArrayElement(kv) => match kv.key {
            Expression::Literal(mago_syntax::cst::Literal::String(s)) => s.value.map(|v| String::from_utf8_lossy(v).into_owned()),
            _ => None,
        },
        _ => None,
    });
    let relation = key.or_else(|| outer.arguments.first()?.1.clone())?;
    let model = model_of(ctx, models, &outer, outer.span.0, depth + 1)?;
    let (segments, _) = parse_path(&relation);
    models.walk(ctx, model, &segments.iter().map(|(_, _, s)| *s).collect::<Vec<_>>())
}

/// A relationship's name in a path, with where it starts and ends in the string.
pub type Segment<'a> = (usize, usize, &'a str);

/// The segments of a relationship path, `posts.comments:id,body as recent`: each name with where it starts and
/// ends in the string, and the column list after `:` with where it starts. An alias after ` as ` is left out.
pub fn parse_path(value: &str) -> (Vec<Segment<'_>>, Option<(usize, &str)>) {
    let end = value.to_ascii_lowercase().find(" as ").unwrap_or(value.len());
    let path = &value[..end];
    let (relations, columns) = match path.split_once(':') {
        Some((r, c)) => (r, Some((r.len() + 1, c))),
        None => (path, None),
    };
    let mut out = vec![];
    let mut at = 0;
    for segment in relations.split('.') {
        out.push((at, at + segment.len(), segment));
        at += segment.len() + 1;
    }
    (out, columns)
}

/// Whether `arg` is a relationship string: the first argument of a relationship method, alone, in a list, or as a key
/// of constraints.
fn is_relation_arg(arg: &StringArg) -> bool {
    matches!(arg.call.kind, CallKind::Method | CallKind::Static)
        && arg.call.is_method(RELATION_METHODS)
        && arg.index == 0
        && matches!(arg.in_array, None | Some(InArray::Key) | Some(InArray::Value(None)))
}

/// The aggregates the chain a call is on adds before it: `withCount('comments')` in
/// `Post::withCount('comments')->orderBy('…')`.
fn chain_aggregates(ctx: &Ctx<'_>, call: &Call) -> Vec<String> {
    let path = ctx.parsed.path_at(call.span.0);
    let Some(node) = path.iter().rev().find(|n| n.span().start.offset == call.span.0 && n.span().end.offset == call.span.1 && matches!(n, Node::MethodCall(_))) else {
        return vec![];
    };
    let Node::MethodCall(c) = node else { return vec![] };
    let mut out = vec![];
    let mut e = c.object;
    loop {
        let (method, list, next) = match e {
            Expression::Call(mago_syntax::cst::Call::Method(c)) => (&c.method, &c.argument_list, Some(c.object)),
            Expression::Call(mago_syntax::cst::Call::NullSafeMethod(c)) => (&c.method, &c.argument_list, Some(c.object)),
            Expression::Call(mago_syntax::cst::Call::StaticMethod(c)) => (&c.method, &c.argument_list, None),
            _ => break,
        };
        if let ClassLikeMemberSelector::Identifier(id) = method {
            out.extend(call_aggregates(id.value, list).into_iter().map(|a| a.name));
        }
        match next {
            Some(n) => e = n,
            None => break,
        }
    }
    out
}

fn items(labels: impl IntoIterator<Item = (String, Option<String>)>, kind: CompletionItemKind, range: lsp_types::Range) -> Vec<CompletionItem> {
    let mut seen = std::collections::HashSet::new();
    labels
        .into_iter()
        .filter(|(l, _)| seen.insert(l.clone()))
        .map(|(l, detail)| CompletionItem { detail, ..completion_item(&l, Some(kind), range) })
        .collect()
}

/// Completions for an Eloquent string, or `None` when `arg` isn't one.
pub fn completion(ctx: &Ctx<'_>, data: &Data<'_>, arg: &StringArg, offset: u32) -> Option<Vec<CompletionItem>> {
    let method = arg.call.name.as_str();
    let relation_method = arg.call.is_method(RELATION_METHODS);
    let relevant = matches!(arg.call.kind, CallKind::Method | CallKind::Static) && (relation_method || arg.call.is_method(FIRST) || arg.call.is_method(ANY));
    if !relevant {
        return None;
    }
    let models = Models::new(data);
    let model = model_of(ctx, &models, &arg.call, arg.start, 0)?;
    let typed = &arg.value[..(offset.saturating_sub(arg.start) as usize).min(arg.value.len())];
    let range_from = |start: usize| ctx.doc.range(arg.start + start as u32, offset);
    let columns = |m: &Model, fillable_only: bool| -> Vec<(String, Option<String>)> {
        m.attributes.iter().filter(|a| if fillable_only { a.fillable } else { !a.accessor }).map(|a| (a.name.clone(), a.ty.clone())).collect()
    };
    if relation_method {
        if is_relation_arg(arg) {
            if typed.to_ascii_lowercase().contains(" as ") {
                return Some(vec![]);
            }
            let (segments, list) = parse_path(typed);
            let names: Vec<&str> = segments.iter().map(|(_, _, s)| *s).collect();
            if let Some((at, cols)) = list {
                // `posts:id,ti` lists the related model's columns.
                let related = models.walk(ctx, model, &names)?;
                let start = at + cols.rfind(',').map_or(0, |i| i + 1);
                return Some(items(columns(&related, false), CompletionItemKind::FIELD, range_from(start)));
            }
            let (last_start, _, _) = *segments.last()?;
            let from = models.walk(ctx, model, &names[..names.len() - 1])?;
            let labels = from.relations.iter().map(|r| (r.name.clone(), r.related.as_ref().map(|c| format!("{} {}", r.kind, short(c)))));
            return Some(items(labels, CompletionItemKind::VALUE, range_from(last_start)));
        }
        // `withSum('items', 'total')` and `whereRelation('author', 'name', …)` take a column of the related model.
        if arg.index == 1 && arg.in_array.is_none() && arg.call.is_method(COLUMN_SECOND) {
            let relation = arg.call.arguments.first()?.1.clone()?;
            let (segments, _) = parse_path(&relation);
            let related = models.walk(ctx, model, &segments.iter().map(|(_, _, s)| *s).collect::<Vec<_>>())?;
            return Some(items(columns(&related, false), CompletionItemKind::FIELD, super::replacement(ctx, arg.start, offset)));
        }
        return None;
    }
    let range = super::replacement(ctx, arg.start, offset);
    // `where('commentable_type', '…')` holds a morph alias.
    if let Some(items) = morph_completion(ctx, &model, arg, range) {
        return Some(items);
    }
    let labels: Vec<(String, Option<String>)> = if arg.call.is_method(ANY) {
        columns(&model, arg.index != 0)
    } else if arg.index > 0 {
        return None;
    } else if ["create", "make", "fill", "update"].contains(&method) {
        if arg.in_array != Some(InArray::Key) {
            return None;
        }
        columns(&model, true)
    } else {
        let mut labels = columns(&model, false);
        labels.extend(chain_aggregates(ctx, &arg.call).into_iter().map(|a| (a, Some("aggregate".to_string()))));
        labels
    };
    Some(items(labels, CompletionItemKind::FIELD, range))
}

fn short(class: &str) -> &str {
    class.rsplit('\\').next().unwrap_or(class)
}

/// The morph name a `*_type` column holds, when the model has a `morphTo()` of that name or such a column.
fn morph_column<'a>(ctx: &Ctx<'_>, model: &Model, column: &'a str) -> Option<&'a str> {
    let name = column.strip_suffix("_type")?;
    let codebase = &ctx.index.codebase;
    let eloquent = &ctx.index.eloquent;
    let morph_to = eloquent.relations(codebase, &model.class).into_iter().any(|r| r.kind == "morphTo" && r.morph.as_deref() == Some(name));
    (morph_to || model.attributes.iter().any(|a| a.name == column)).then_some(name)
}

/// The values a morph column `name` can hold: for each model with a `morphMany()`, `morphOne()`, or `morphToMany()`
/// through that name, its alias in the morph map or its class; with none found, the map's aliases.
fn morph_values(ctx: &Ctx<'_>, name: &str) -> Vec<(String, String)> {
    let eloquent = &ctx.index.eloquent;
    let mut out: Vec<(String, String)> = vec![];
    for decl in eloquent.models.values() {
        if decl.relations.iter().any(|r| r.kind != "morphTo" && r.morph.as_deref() == Some(name)) {
            out.push((eloquent.morph_alias(&decl.class).to_string(), decl.class.clone()));
        }
    }
    if out.is_empty() {
        out = eloquent.morph_map.clone();
    }
    out.sort();
    out.dedup();
    out
}

fn morph_completion(ctx: &Ctx<'_>, model: &Model, arg: &StringArg, range: lsp_types::Range) -> Option<Vec<CompletionItem>> {
    if !arg.call.is_method(&["where", "orWhere", "whereIn", "whereNot", "firstWhere"]) || arg.index == 0 {
        return None;
    }
    let column = arg.call.arguments.first()?.1.as_deref()?;
    let name = morph_column(ctx, model, column)?;
    let values = morph_values(ctx, name);
    (!values.is_empty()).then(|| items(values.into_iter().map(|(alias, class)| (alias.clone(), (alias != class).then_some(class))), CompletionItemKind::ENUM_MEMBER, range))
}

/// The relationship segment of `arg` at `offset`: the model it's on, the segment's name, and where it starts and ends.
fn segment_at(ctx: &Ctx<'_>, models: &Models, arg: &StringArg, offset: u32) -> Option<(Model, String, u32, u32)> {
    if !is_relation_arg(arg) {
        return None;
    }
    let model = model_of(ctx, models, &arg.call, arg.start, 0)?;
    let at = offset.checked_sub(arg.start)? as usize;
    let (segments, _) = parse_path(&arg.value);
    let i = segments.iter().position(|(s, e, _)| *s <= at && at <= *e)?;
    let names: Vec<&str> = segments.iter().map(|(_, _, s)| *s).collect();
    let on = models.walk(ctx, model, &names[..i])?;
    let (s, e, name) = segments[i];
    Some((on, name.to_string(), arg.start + s as u32, arg.start + e as u32))
}

/// Goes from a relationship segment to its method.
pub fn definition(ctx: &Ctx<'_>, data: &Data<'_>, arg: &StringArg, offset: u32) -> Option<Vec<Location>> {
    let models = Models::new(data);
    let (model, name, ..) = segment_at(ctx, &models, arg, offset)?;
    let place = crate::locate::declaration(&Symbol::Method { class: model.class.clone(), name }, &ctx.index.codebase)?;
    Some(ctx.snap.location(&ctx.index, place).into_iter().collect())
}

pub fn hover(ctx: &Ctx<'_>, data: &Data<'_>, arg: &StringArg, offset: u32) -> Option<Hover> {
    let models = Models::new(data);
    let markdown = |value: String, start: u32, end: u32| Hover { contents: HoverContents::Markup(MarkupContent { kind: MarkupKind::Markdown, value }), range: Some(ctx.doc.range(start, end)) };
    if let Some((model, name, start, end)) = segment_at(ctx, &models, arg, offset) {
        let r = model.relation(&name)?;
        let related = r.related.as_deref().map_or(String::new(), |c| format!("<{}>", short(c)));
        let mut text = format!("```php\n{}::{}(): {}{related}\n```", model.class, r.name, r.kind);
        // A `morphTo()` relates the models that point back through its name.
        if r.related.is_none() {
            let morph = ctx.index.eloquent.relations(&ctx.index.codebase, &model.class).into_iter().find(|d| d.name == name).and_then(|d| d.morph.clone()).unwrap_or_else(|| name.clone());
            let classes: Vec<String> = morph_values(ctx, &morph).into_iter().map(|(alias, class)| if alias == class { format!("`{class}`") } else { format!("`{class}` (`{alias}`)") }).collect();
            if !classes.is_empty() {
                text.push_str(&format!("\n\nOne of {}", classes.join(", ")));
            }
        }
        return Some(markdown(text, start, end));
    }
    // A morph alias names a class.
    if arg.index > 0 && arg.call.is_method(&["where", "orWhere", "whereIn", "whereNot", "firstWhere"]) {
        let model = model_of(ctx, &models, &arg.call, arg.start, 0)?;
        morph_column(ctx, &model, arg.call.arguments.first()?.1.as_deref()?)?;
        let class = ctx.index.eloquent.morph_class(&arg.value)?;
        return Some(markdown(format!("Morph alias of `{class}`"), arg.start, arg.end));
    }
    None
}

/// Relationship segments the model doesn't have, when the booted app listed the model's relationships and the class
/// has no method of that name.
pub fn diagnostics(ctx: &Ctx<'_>, data: &Data<'_>, args: &[StringArg]) -> Vec<Diagnostic> {
    let relation_args: Vec<&StringArg> = args.iter().filter(|a| is_relation_arg(a)).collect();
    if relation_args.is_empty() {
        return vec![];
    }
    let models = Models::new(data);
    let codebase = &ctx.index.codebase;
    let mut out = vec![];
    for arg in relation_args {
        let Some(mut model) = model_of(ctx, &models, &arg.call, arg.start, 0) else { continue };
        let (segments, _) = parse_path(&arg.value);
        for (s, e, name) in segments {
            if !model.live || name.is_empty() {
                break;
            }
            match model.relation(name) {
                Some(r) => match r.related.as_deref().and_then(|c| models.get(ctx, c)) {
                    Some(next) => model = next,
                    // A `morphTo()`'s model depends on the row.
                    None => break,
                },
                None => {
                    // A method the app's scan didn't take for a relationship, as one defined in a way it doesn't read.
                    if !codebase.method_exists(model.class.as_bytes(), name.as_bytes()) && codebase.class_like_exists(model.class.as_bytes()) {
                        out.push(Diagnostic {
                            range: ctx.doc.range(arg.start + s as u32, arg.start + e as u32),
                            severity: Some(DiagnosticSeverity::WARNING),
                            code: Some(NumberOrString::String("relation".into())),
                            source: Some(SOURCE.into()),
                            message: format!("{} has no relationship {name}().", model.class),
                            ..Default::default()
                        });
                    }
                    break;
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::features::{with_ctx, with_ctx_at};
    use crate::testing::{Fixture, uri};

    const LARAVEL: &str = r#"<?php
namespace Illuminate\Database\Eloquent {
    abstract class Model {
        /** @return \Illuminate\Database\Eloquent\Builder<static> */
        public static function query() {}
        public function load($relations) { return $this; }
    }
    /** @template TModel of Model */
    class Builder {
        /** @return $this */
        public function where($column, $operator = null, $value = null) { return $this; }
        /** @return $this */
        public function with($relations) { return $this; }
        /** @return $this */
        public function has($relation) { return $this; }
        /** @return $this */
        public function whereHas($relation, ?\Closure $callback = null) { return $this; }
        /** @return $this */
        public function withCount($relations) { return $this; }
        /** @return $this */
        public function withSum($relation, $column) { return $this; }
        /** @return $this */
        public function orderBy($column) { return $this; }
    }
}
namespace Illuminate\Database\Eloquent\Relations {
    abstract class Relation {}
    class HasMany extends Relation {}
    class BelongsTo extends Relation {}
    class MorphMany extends Relation {}
    class MorphTo extends Relation {}
    class Relation2 { public static function enforceMorphMap(array $map) {} }
}
namespace Illuminate\Support { class Collection { public function has($key) { return true; } } }
"#;

    const MODELS: &str = r#"<?php
namespace App\Models;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
class User extends Model {
    protected $fillable = ['name'];
    public function posts(): HasMany { return $this->hasMany(Post::class); }
}
class Post extends Model {
    public function author() { return $this->belongsTo(User::class); }
    public function comments() { return $this->morphMany(Comment::class, 'commentable'); }
    public function scopePublished($q) {}
    public function latestComment() { return $this->comments()->one(); }
}
class Comment extends Model {
    public function commentable() { return $this->morphTo(); }
    public function author() { return $this->belongsTo(User::class); }
}
"#;

    const MIGRATION: &str = "<?php\nreturn new class {\n    public function up(): void {\n        Schema::create('users', function ($table) { $table->id(); $table->string('name'); $table->string('email'); });\n        Schema::create('posts', function ($table) { $table->id(); $table->string('title'); $table->foreignId('user_id'); });\n        Schema::create('comments', function ($table) { $table->id(); $table->text('body'); $table->morphs('commentable'); });\n    }\n};\n";

    const PROVIDER: &str = "<?php\nnamespace App\\Providers;\nuse Illuminate\\Database\\Eloquent\\Relations\\Relation;\nclass AppServiceProvider { public function boot() { Relation::morphMap(['post' => \\App\\Models\\Post::class]); } }\n";

    /// A project whose models the booted app describes when `live`, else only the index does.
    fn fixture(text: &str, live: bool) -> Fixture {
        let fx = Fixture::new(&[
            ("vendor/laravel.php", LARAVEL),
            ("app/Models/Models.php", MODELS),
            ("app/Providers/AppServiceProvider.php", PROVIDER),
            ("database/migrations/2024_01_01_000000_create_tables.php", MIGRATION),
            ("t.php", text),
        ]);
        fx.snap.framework.seed("laravel:active", json!(true));
        // Without a booted app, models.php reports no models.
        let models = if live {
            json!({"models": {
                "App\\Models\\User": {"attributes": [{"name": "id", "fillable": false}, {"name": "name", "fillable": true}, {"name": "email", "fillable": false}], "relations": [{"name": "posts", "type": "HasMany", "related": "App\\Models\\Post"}]},
                "App\\Models\\Post": {"attributes": [{"name": "id"}, {"name": "title"}], "relations": [{"name": "author", "type": "BelongsTo", "related": "App\\Models\\User"}, {"name": "comments", "type": "MorphMany", "related": "App\\Models\\Comment"}]},
                "App\\Models\\Comment": {"attributes": [{"name": "body"}, {"name": "commentable_type"}], "relations": [{"name": "commentable", "type": "MorphTo", "related": null}, {"name": "author", "type": "BelongsTo", "related": "App\\Models\\User"}]},
            }})
        } else {
            json!({"models": {}})
        };
        fx.snap.framework.seed("laravel:models", models);
        fx
    }

    fn complete(text: &str, live: bool) -> Vec<String> {
        let fx = fixture(text, live);
        let at = fx.at();
        let items = with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| crate::framework::completion(ctx, ctx.offset(at.position))).flatten().unwrap_or_default();
        let mut labels: Vec<String> = items.iter().map(|i| i.label.clone()).collect();
        labels.sort();
        labels
    }

    fn problems(text: &str, live: bool) -> Vec<String> {
        let fx = fixture(text, live);
        with_ctx(&fx.snap, &uri("t.php"), super::super::diagnostics).unwrap().into_iter().map(|d| format!("{}:{} {}", d.range.start.character, d.range.end.character, d.message)).collect()
    }

    #[test]
    fn completes_each_segment_of_a_relationship_path() {
        for live in [true, false] {
            assert_eq!(complete("<?php \\App\\Models\\User::with('posts.<|>');", live), vec!["author", "comments"], "{live}");
            assert_eq!(complete("<?php \\App\\Models\\User::query()->whereHas('posts.comments.<|>');", live), vec!["author", "commentable"], "{live}");
            assert_eq!(complete("<?php \\App\\Models\\User::with(['posts.<|>' => fn ($q) => $q]);", live), vec!["author", "comments"], "{live}");
            assert_eq!(complete("<?php \\App\\Models\\User::with(['posts', '<|>']);", live), vec!["posts"], "{live}");
            assert_eq!(complete("<?php function f(\\App\\Models\\Post $p) { $p->load('author.<|>'); }", live), vec!["posts"], "{live}");
            // `with('posts:id,title')` selects the related model's columns.
            assert_eq!(complete("<?php \\App\\Models\\User::with('posts:id,<|>');", live), vec!["id", "title"].into_iter().chain((!live).then_some("user_id")).collect::<Vec<_>>(), "{live}");
            // `withSum('posts', '…')` sums a column of the related model.
            assert!(complete("<?php \\App\\Models\\User::query()->withSum('posts', '<|>');", live).contains(&"title".to_string()), "{live}");
            // A closure in a constraints array queries the related model.
            assert!(complete("<?php \\App\\Models\\User::with(['posts.comments' => fn ($q) => $q->where('<|>')]);", live).contains(&"body".to_string()), "{live}");
        }
        // Without the app, columns come from the migrations, and `create()` takes `$fillable`.
        assert_eq!(complete("<?php \\App\\Models\\User::where('<|>');", false), vec!["email", "id", "name"]);
        // A collection's `has()` names a key, not a relationship.
        assert!(complete("<?php function f(\\Illuminate\\Support\\Collection $c) { $c->has('<|>'); }", true).is_empty());
    }

    #[test]
    fn completes_the_aggregates_a_chain_adds() {
        let labels = complete("<?php \\App\\Models\\User::withCount(['posts as published_count'])->withSum('posts', 'id')->orderBy('<|>');", true);
        assert!(labels.contains(&"published_count".to_string()) && labels.contains(&"posts_sum_id".to_string()), "{labels:?}");
        assert!(!complete("<?php \\App\\Models\\User::query()->orderBy('<|>');", true).contains(&"posts_count".to_string()));
    }

    #[test]
    fn completes_morph_aliases() {
        assert_eq!(complete("<?php \\App\\Models\\Comment::query()->where('commentable_type', '<|>');", true), vec!["post"]);
        assert_eq!(complete("<?php \\App\\Models\\Comment::query()->where('commentable_type', '=', '<|>');", false), vec!["post"]);
    }

    #[test]
    fn reports_unknown_segments_only_when_the_app_listed_the_relationships() {
        let code = "<?php \\App\\Models\\User::with(['posts.coments', 'pots', 'posts.comments.commentable.whatever', 'posts:id,title', 'posts as p'])->has('posts.author.posts');";
        assert_eq!(problems(code, true), vec!["37:44 App\\Models\\Post has no relationship coments().", "48:52 App\\Models\\User has no relationship pots()."]);
        // From the index alone, the relationships may be incomplete.
        assert!(problems(code, false).is_empty());
        // A method the app didn't take for a relationship isn't reported.
        assert!(problems("<?php \\App\\Models\\Post::with('latestComment');", true).is_empty());
    }

    #[test]
    fn hovers_and_goes_to_each_segment() {
        let fx = fixture("<?php \\App\\Models\\User::with('posts.comm<|>ents');", true);
        let at = fx.at();
        let hover = with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| crate::framework::hover(ctx, ctx.offset(at.position))).flatten().unwrap();
        let HoverContents::Markup(m) = hover.contents else { panic!() };
        assert!(m.value.contains("App\\Models\\Post::comments(): MorphMany<Comment>"), "{}", m.value);
        let found = with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| crate::framework::definition(ctx, ctx.offset(at.position))).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].uri.clone(), found[0].range.start.line), (uri("app/Models/Models.php"), 10));
        // A `morphTo()` lists the models that point back through it, by their morph alias.
        let fx = fixture("<?php \\App\\Models\\Comment::with('commen<|>table');", true);
        let at = fx.at();
        let hover = with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| crate::framework::hover(ctx, ctx.offset(at.position))).flatten().unwrap();
        let HoverContents::Markup(m) = hover.contents else { panic!() };
        assert!(m.value.ends_with("One of `App\\Models\\Post` (`post`)"), "{}", m.value);
    }

    fn hints(text: &str, on: bool) -> Vec<String> {
        let fx = fixture(text, true);
        fx.snap.framework.set_lazy_loading_hints(on);
        let path = if text.starts_with("<?php") { "t.php" } else { "resources/views/t.blade.php" };
        let fx = if path == "t.php" { fx } else {
            let fx2 = Fixture::new(&[("vendor/laravel.php", LARAVEL), ("app/Models/Models.php", MODELS), ("database/migrations/2024_01_01_000000_create_tables.php", MIGRATION), (path, text)]);
            fx2.snap.framework.seed("laravel:active", json!(true));
            fx2.snap.framework.seed("laravel:models", json!({"models": {}}));
            fx2.snap.framework.set_lazy_loading_hints(on);
            fx2
        };
        with_ctx(&fx.snap, &uri(path), super::super::diagnostics)
            .unwrap()
            .into_iter()
            .filter(|d| d.code == Some(NumberOrString::String("lazy-loading".into())))
            .map(|d| format!("{}:{} {}", d.range.start.line, d.range.start.character, d.message.split(':').next().unwrap_or_default()))
            .collect()
    }

    #[test]
    fn hints_at_relationships_a_loop_lazy_loads() {
        let code = "<?php\nuse App\\Models\\Post;\nfunction f() {\n    foreach (Post::query()->latest()->get() as $post) {\n        echo $post->author->name;\n        echo $post->author->posts;\n        $post->comments()->count();\n    }\n}\n";
        assert_eq!(hints(code, true), vec!["4:20 Reading `author` here runs a query for each post"]);
        // Off unless the option turns it on.
        assert!(hints(code, false).is_empty());
        // Eager-loaded, nested, through a variable assigned once, or loaded later.
        let loaded = "<?php\nuse App\\Models\\Post;\nfunction f() {\n    $posts = Post::with('author')->get();\n    foreach ($posts as $post) {\n        echo $post->author->name;\n        echo $post->author->posts;\n    }\n}\n";
        assert_eq!(hints(loaded, true), vec!["6:28 Reading `posts` here runs a query for each post"]);
        assert!(hints(&loaded.replace("with('author')", "with(['author.posts' => fn ($q) => $q])"), true).is_empty());
        assert!(hints(&loaded.replace("    foreach", "    $posts->load('author.posts');\n    foreach"), true).is_empty());
        // What can't be known stays quiet: a `with()` of a variable, a variable assigned twice, a query out of view.
        assert!(hints(&loaded.replace("with('author')", "with($relations)"), true).is_empty());
        assert!(hints(&loaded.replace("    foreach", "    $posts = collect();\n    foreach"), true).is_empty());
        assert!(hints("<?php\nfunction f($posts) {\n    foreach ($posts as $post) {\n        echo $post->author->name;\n    }\n}\n", true).is_empty());
        // A closure each model is passed to.
        assert_eq!(hints("<?php\nuse App\\Models\\Post;\nPost::all()->each(fn ($post) => $post->author);\n", true), vec!["2:39 Reading `author` here runs a query for each post"]);
        // A Blade view's own query.
        assert_eq!(hints("@foreach (\\App\\Models\\Post::all() as $post)\n    {{ $post->author->name }}\n@endforeach\n", true), vec!["1:14 Reading `author` here runs a query for each post"]);
    }
}

/// Runs the relationship checks and the lazy-loading hint over every PHP file and Blade view of a real app, with
/// the models the booted app reports, and prints what they find: `TUSK_LARAVEL_APP=<root> cargo test -- --ignored
/// --nocapture relations_in_a_real_app`. Every warning should be real.
#[cfg(test)]
#[test]
#[ignore]
fn relations_in_a_real_app() {
    use crate::documents::{Document, Documents};
    use crate::index::{Index, IndexConfig};
    use crate::server::Snapshot;
    use crate::text::path_to_uri;
    let Ok(root) = std::env::var("TUSK_LARAVEL_APP") else { return };
    let root = std::path::PathBuf::from(root);
    crate::testing::on_server_stack(|| {
        let mut index = Index::empty(IndexConfig::new(&root));
        let paths = index.discover();
        index.build(paths, |p| std::fs::read(p).ok(), |_, _| {});
        let index = Arc::new(parking_lot::RwLock::new(index));
        let framework = Arc::new(crate::framework::State::new(root.clone()));
        framework.set_lazy_loading_hints(true);
        let live = Data(&framework).models().and_then(|m| m["models"].as_object().map(|o| o.len())).unwrap_or(0);
        eprintln!("the booted app describes {live} models");
        let mut files: Vec<std::path::PathBuf> = index.read().project_files().filter(|p| !p.starts_with(root.join("vendor"))).map(|p| p.to_path_buf()).collect();
        files.extend(ignore::WalkBuilder::new(root.join("resources/views")).build().flatten().map(|e| e.path().to_path_buf()).filter(|p| p.to_string_lossy().ends_with(".blade.php")));
        let (mut strings, mut warnings, mut hints) = (0, 0, 0);
        for path in files {
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let language = if path.to_string_lossy().ends_with(".blade.php") { "blade" } else { "php" };
            let mut docs = Documents::default();
            docs.insert(Document::new(path_to_uri(&path), path.clone(), language.into(), 1, text));
            let snap = Snapshot { docs, index: index.clone(), root: root.clone(), framework: framework.clone(), client: None, cancel: Default::default() };
            let rel = path.strip_prefix(&root).unwrap().display().to_string();
            crate::features::with_ctx(&snap, &path_to_uri(&path), |ctx| {
                if language == "php" {
                    // Each relationship string's segments, resolved through the models: what's unresolved would be
                    // reported if the app had listed the model's relationships, unless the class has the method.
                    let data = Data(&framework);
                    let models = Models::new(&data);
                    for arg in crate::framework::string_args(ctx).iter().filter(|a| is_relation_arg(a)) {
                        strings += 1;
                        let Some(mut model) = model_of(ctx, &models, &arg.call, arg.start, 0) else {
                            eprintln!("no model {rel}:{} {}('{}')", ctx.doc.position(arg.start).line + 1, arg.call.name, arg.value);
                            continue;
                        };
                        for (_, _, name) in parse_path(&arg.value).0 {
                            match model.relation(name).and_then(|r| r.related.clone()).and_then(|c| models.get(ctx, &c)) {
                                Some(next) => model = next,
                                None => {
                                    if model.relation(name).is_none() {
                                        let method = ctx.index.codebase.method_exists(model.class.as_bytes(), name.as_bytes());
                                        eprintln!("unresolved {rel}:{} {}('{}') at {name} on {} (method exists: {method})", ctx.doc.position(arg.start).line + 1, arg.call.name, arg.value, model.class);
                                    }
                                    break;
                                }
                            }
                        }
                    }
                }
                // Filament's problems with the migrations' columns filling what the database didn't give, against
                // without them.
                if rel.starts_with("app/Filament") {
                    let key = |d: &Diagnostic| format!("{}:{} {}", d.range.start.line + 1, d.range.start.character, d.message);
                    let with: Vec<String> = crate::framework::filament::diagnostics(ctx).iter().map(key).collect();
                    for d in &with {
                        eprintln!("filament {rel}:{d}");
                    }
                }
                for d in super::diagnostics(ctx) {
                    let code = match &d.code {
                        Some(NumberOrString::String(c)) => c.clone(),
                        _ => String::new(),
                    };
                    if code == "relation" || code == "lazy-loading" {
                        if code == "relation" { warnings += 1 } else { hints += 1 }
                        eprintln!("{code} {rel}:{} {}", d.range.start.line + 1, d.message);
                    }
                }
            });
        }
        eprintln!("{strings} relationship strings, {warnings} warnings, {hints} lazy-loading hints");
    });
}
