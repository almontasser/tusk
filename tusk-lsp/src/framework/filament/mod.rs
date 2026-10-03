//! Filament features: the strings Filament resolves against Eloquent models, which general PHP analysis can't
//! check.
//!
//! ```php
//! TextInput::make('title')                 // field and column names
//! TextColumn::make('author.name')          // relationship paths
//! Select::make('author_id')
//!     ->relationship('author', 'name')     // relationship names and related columns
//! Select::make('status')
//!     ->options(Status::class)             // the enum the model casts the field to
//!     ->default('draft')                   // the field's option values
//! $get('status')                           // the form's field names (state paths)
//! ```
//!
//! The index finds resources, their files, and enums. The model's columns and relationships need the running
//! app, so `introspect.php` reports them, cached until a file under `app/`, `config/`, or `database/` changes.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use lsp_types::{
    CodeLens, Command, CompletionItem, CompletionItemKind, CompletionTextEdit, Diagnostic, DiagnosticSeverity, DocumentLink,
    Hover, Location, Position, Range, TextEdit,
};
use mago_codex::symbol::SymbolKind;
use mago_span::HasSpan;
use mago_syntax::cst::{Argument, ArrayElement, Expression, Literal, Node};
use serde_json::Value;

use super::{CallKind, StringArg, string_arg_at, string_args};

mod schema;
mod state;
use crate::features::Ctx;
use crate::index::file_id;
use crate::scope::{resolve_class, scope_at};
use crate::text::path_to_uri;

/// The script that describes resources and models, run in its own PHP process so edited classes load fresh.
const INTROSPECT: &str = include_str!("../../../php/introspect.php");

/// Folders whose changes can change what introspection reports.
const DEPENDS_ON: &[&str] = &["app/", "config/", "database/", "composer.lock"];

/// Whether the project uses Filament, checked once.
fn active(ctx: &Ctx<'_>) -> bool {
    let state = &ctx.snap.framework;
    let root = state.root().to_path_buf();
    state.remember("filament:active", &["composer.lock"], || Value::Bool(root.join("vendor/filament/filament").is_dir())).as_bool() == Some(true)
}

/// Runs `introspect.php` in `mode`, or `None` if it fails.
fn introspect(ctx: &Ctx<'_>, args: &[&str]) -> Option<Arc<Value>> {
    let state = &ctx.snap.framework;
    // The script runs in the project's root, and `.` names it inside a container too.
    let mut all = vec!["."];
    all.extend(args);
    let value = state.php(&format!("filament:{}", args.join("|")), INTROSPECT, &all, DEPENDS_ON)?;
    value.get("error").is_none().then_some(value)
}

/// The classes a file declares, first one first, with the offset of each name.
fn classes_in(ctx: &Ctx<'_>, path: &Path) -> Vec<(String, u32)> {
    let id = file_id(path);
    let mut out: Vec<(String, u32)> = ctx
        .index
        .codebase
        .class_likes
        .values()
        .filter(|c| c.span.file_id == id && c.kind == SymbolKind::Class)
        .map(|c| (c.original_name.as_str_lossy().into_owned(), c.name_span.unwrap_or(c.span).start.offset))
        .collect();
    out.sort_by_key(|(_, at)| *at);
    out
}

fn short(fqn: &str) -> &str {
    fqn.rsplit('\\').next().unwrap_or(fqn)
}

fn is_resource(ctx: &Ctx<'_>, class: &str) -> bool {
    let codebase = &ctx.index.codebase;
    codebase.is_instance_of(class.as_bytes(), b"Filament\\Resources\\Resource")
        || codebase.get_class_like(class.as_bytes()).and_then(|c| c.direct_parent_class).is_some_and(|p| short(&p.as_str_lossy()).eq_ignore_ascii_case("Resource"))
}

fn is_model(ctx: &Ctx<'_>, class: &str) -> bool {
    let codebase = &ctx.index.codebase;
    codebase.is_instance_of(class.as_bytes(), b"Illuminate\\Database\\Eloquent\\Model")
        || codebase
            .get_class_like(class.as_bytes())
            .and_then(|c| c.direct_parent_class)
            .is_some_and(|p| ["model", "authenticatable", "pivot"].contains(&short(&p.as_str_lossy()).to_ascii_lowercase().as_str()))
}

/// The resource a file belongs to: its own class if that's a resource, otherwise the class in the first
/// `*Resource.php` of its folder or a parent folder under `app/`. Filament 4 keeps pages, schemas, tables,
/// and relation managers in subfolders of the resource's folder.
fn resource_of(ctx: &Ctx<'_>, path: &Path) -> Option<String> {
    if let Some((class, _)) = classes_in(ctx, path).into_iter().find(|(c, _)| is_resource(ctx, c)) {
        return Some(class);
    }
    let app = ctx.snap.framework.root().join("app");
    let mut dir = path.parent()?.to_path_buf();
    while dir.starts_with(&app) && dir != app {
        let mut candidates: Vec<&PathBuf> = ctx
            .index
            .files
            .values()
            .map(|f| &f.path)
            .filter(|p| p.parent() == Some(dir.as_path()) && p.to_string_lossy().ends_with("Resource.php"))
            .collect();
        candidates.sort();
        if let Some(file) = candidates.first() {
            return classes_in(ctx, file).into_iter().next().map(|(c, _)| c);
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

/// Introspection for the resource the document belongs to: the resource, its pages and relation managers, and
/// the model its forms and tables work with (a relation manager's related model).
fn context(ctx: &Ctx<'_>) -> Option<Arc<Value>> {
    if !active(ctx) {
        return None;
    }
    let resource = resource_of(ctx, &ctx.doc.path)?;
    let own = classes_in(ctx, &ctx.doc.path).into_iter().next().map(|(c, _)| c).unwrap_or_default();
    let value = introspect(ctx, &["resource", &resource, &own])?;
    Some(crate::framework::laravel::schema::fill_guessed_columns(&ctx.index.eloquent, &ctx.index.codebase, value))
}

fn relation<'v>(model: &'v Value, name: &str) -> Option<&'v Value> {
    model["relations"].as_array()?.iter().find(|r| r["name"] == name)
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default()
}

/// Whether a call can be a Filament component's: on a Filament class, or on a receiver the analyzer couldn't
/// type, as in a project without Filament indexed.
fn filament_call(arg: &StringArg) -> bool {
    arg.call.classes.is_empty() || arg.call.classes.iter().any(|c| c.starts_with("Filament\\"))
}

/// A relationship name written in a string: `->relationship('name')`, or the first segment of a dotted
/// `::make('name.column')`. Returns its span and the name.
fn relationship_name(arg: &StringArg) -> Option<(u32, u32, String)> {
    if !filament_call(arg) || arg.in_array.is_some() || arg.index != 0 {
        return None;
    }
    let is_relationship = arg.call.kind == CallKind::Method && arg.call.name == "relationship";
    let is_dotted_make = arg.call.kind == CallKind::Static && arg.call.name == "make" && arg.value.contains('.');
    if !is_relationship && !is_dotted_make {
        return None;
    }
    let name: String = arg.value.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
    let whole = if is_relationship { name.len() == arg.value.len() } else { arg.value[name.len()..].starts_with('.') };
    (!name.is_empty() && whole).then(|| (arg.start, arg.start + name.len() as u32, name))
}

fn item(label: &str, kind: CompletionItemKind, detail: &str, range: Range, sort: Option<String>) -> CompletionItem {
    CompletionItem {
        label: label.to_string(),
        kind: Some(kind),
        detail: Some(detail.to_string()),
        text_edit: Some(CompletionTextEdit::Edit(TextEdit { range, new_text: label.to_string() })),
        sort_text: sort,
        ..Default::default()
    }
}

/// How to write a class at `offset`: its short name when imported or in the same namespace, else qualified.
fn class_reference(ctx: &Ctx<'_>, offset: u32, class: &str) -> String {
    let short = short(class);
    if resolve_class(&scope_at(ctx.parsed.program, offset), short).eq_ignore_ascii_case(class) {
        short.to_string()
    } else {
        format!("\\{class}")
    }
}

/// An enum's cases in declaration order, with each backed case's value as written.
fn enum_cases(ctx: &Ctx<'_>, class: &str) -> Option<Vec<(String, Option<String>)>> {
    let meta = ctx.index.codebase.get_enum(class.as_bytes())?;
    let mut cases: Vec<_> = meta.enum_cases.values().collect();
    cases.sort_by_key(|c| c.span.start.offset);
    let text = cases.first().and_then(|c| ctx.snap.text_of(&ctx.index, c.span.file_id));
    Some(
        cases
            .into_iter()
            .map(|c| {
                let value = text.as_deref().and_then(|t| {
                    let decl = t.get(c.span.start.offset as usize..c.span.end.offset as usize)?;
                    let (_, v) = decl.split_once('=')?;
                    Some(v.trim().trim_end_matches(';').trim().trim_matches(|q| q == '\'' || q == '"').to_string())
                });
                (c.name.as_str_lossy().into_owned(), value)
            })
            .collect(),
    )
}

/// The field a value call is part of: `Select::make('status')->options(…)->default(…)`. Returns the method
/// holding the cursor (`default`, `options`, or `enum`), the field's name, and the chain's calls before it.
struct FieldCall<'a> {
    method: String,
    field: String,
    chain: Vec<&'a mago_syntax::cst::MethodCall<'a>>,
}

fn field_call<'a>(ctx: &Ctx<'a>, offset: u32) -> Option<FieldCall<'a>> {
    let path = ctx.parsed.path_at(offset);
    let text = ctx.parsed.text();
    let name_of = |c: &mago_syntax::cst::MethodCall<'_>| text[c.method.span().start.offset as usize..c.method.span().end.offset as usize].to_string();
    let call = path.iter().rev().find_map(|n| match n {
        Node::MethodCall(c) if c.argument_list.left_parenthesis.end.offset <= offset && ["default", "options", "enum"].contains(&name_of(c).as_str()) => Some(*c),
        _ => None,
    })?;
    let mut chain = vec![];
    let mut object = call.object;
    loop {
        match object {
            Expression::Call(mago_syntax::cst::Call::Method(c)) => {
                chain.push(c);
                object = c.object;
            }
            Expression::Call(mago_syntax::cst::Call::StaticMethod(c)) => {
                let is_make = text[c.method.span().start.offset as usize..c.method.span().end.offset as usize] == *"make";
                let first = c.argument_list.arguments.iter().next()?;
                let Argument::Positional(p) = first else { return None };
                let Expression::Literal(Literal::String(s)) = p.value else { return None };
                let field = text[s.span.start.offset as usize + 1..s.span.end.offset as usize - 1].to_string();
                return is_make.then_some(FieldCall { method: name_of(call), field, chain });
            }
            _ => return None,
        }
    }
}

/// The class a chain names in `->options(X::class)` or `->enum(X::class)`.
fn chain_class(ctx: &Ctx<'_>, chain: &[&mago_syntax::cst::MethodCall<'_>]) -> Option<String> {
    let text = &ctx.doc.text;
    chain.iter().find_map(|c| {
        let name = &text[c.method.span().start.offset as usize..c.method.span().end.offset as usize];
        if name != "options" && name != "enum" {
            return None;
        }
        let Argument::Positional(p) = c.argument_list.arguments.iter().next()? else { return None };
        let Expression::Access(mago_syntax::cst::Access::ClassConstant(access)) = p.value else { return None };
        let class = ctx.resolver().classes_of_class_expr(access.class, &ctx.parsed.path_at(access.span().start.offset));
        class.into_iter().next()
    })
}

/// An enum the index knows, by its declared name; not a class or a cast such as `datetime`.
fn known_enum(ctx: &Ctx<'_>, class: &str) -> Option<String> {
    ctx.index.codebase.get_enum(class.as_bytes()).map(|e| e.original_name.as_str_lossy().into_owned())
}

/// The field's enum: from `->options(X::class)` or `->enum(X::class)`, or else the model's cast of the field.
fn field_enum(ctx: &Ctx<'_>, field: &FieldCall<'_>) -> Option<String> {
    let class = match chain_class(ctx, &field.chain) {
        Some(class) => class,
        None => context(ctx)?["model"]["casts"][&field.field].as_str()?.to_string(),
    };
    known_enum(ctx, &class)
}

/// Keys and values of a literal `->options([...])` array in the chain, or of one a closure returns.
fn literal_options(ctx: &Ctx<'_>, chain: &[&mago_syntax::cst::MethodCall<'_>]) -> Option<Vec<(String, Option<String>)>> {
    let text = &ctx.doc.text;
    let string = |e: &Expression<'_>| match e {
        Expression::Literal(Literal::String(s)) => text.get(s.span.start.offset as usize + 1..s.span.end.offset as usize - 1).map(String::from),
        _ => None,
    };
    chain.iter().find_map(|c| {
        if &text[c.method.span().start.offset as usize..c.method.span().end.offset as usize] != "options" {
            return None;
        }
        let Argument::Positional(p) = c.argument_list.arguments.iter().next()? else { return None };
        let mut value = p.value;
        // `fn () => [...]`, or a closure whose only statement returns the array.
        match value {
            Expression::ArrowFunction(f) => value = f.expression,
            Expression::Closure(f) => match f.body.statements.as_slice() {
                [mago_syntax::cst::Statement::Return(r)] => value = r.value?,
                _ => return None,
            },
            _ => {}
        }
        let elements = match value {
            Expression::Array(a) => &a.elements,
            Expression::LegacyArray(a) => &a.elements,
            _ => return None,
        };
        Some(
            elements
                .iter()
                .filter_map(|el| match el {
                    ArrayElement::KeyValue(kv) => Some((string(kv.key)?, string(kv.value))),
                    _ => None,
                })
                .collect(),
        )
    })
}

/// How long options read from the database are used before a request reads them again.
pub const OPTIONS_FRESH: std::time::Duration = std::time::Duration::from_secs(60);

/// One of a select's options: its key, written as PHP (`5`, `'draft'`), and its label.
pub struct OptionValue {
    pub key: String,
    pub php: String,
    pub label: Option<String>,
}

/// Options a field reads from the database: `->options(Model::pluck('name', 'id'))`, any query of literal
/// `where`s, orders, and scopes that ends in `pluck()`, also in a closure, or `->relationship('author', 'name')`
/// on a field of `model`'s form. `introspect.php` runs the query on its own thread, so this returns nothing
/// until it has, and whether there are more than it read. Options older than `fresh` are read again.
fn query_options(ctx: &Ctx<'_>, chain: &[&mago_syntax::cst::MethodCall<'_>], model: Option<&str>, fresh: std::time::Duration) -> Option<(Vec<OptionValue>, bool)> {
    let query = options_query(ctx, chain, model)?.to_string();
    let found = ctx.snap.framework.php_soon(&format!("filament:options|{query}"), INTROSPECT, vec![".".into(), "options".into(), query], DEPENDS_ON, fresh)?;
    let rows = found["rows"].as_array()?;
    let values = rows
        .iter()
        .filter_map(|row| {
            let (key, php) = match &row[0] {
                Value::Number(n) => (n.to_string(), n.to_string()),
                Value::String(s) => (s.clone(), format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))),
                _ => return None,
            };
            Some(OptionValue { key, php, label: row[1].as_str().map(String::from) })
        })
        .collect();
    Some((values, found["more"] == true))
}

/// The query `introspect.php options` runs for a field's options, if they come from one it can run safely.
fn options_query(ctx: &Ctx<'_>, chain: &[&mago_syntax::cst::MethodCall<'_>], model: Option<&str>) -> Option<Value> {
    let text = &ctx.doc.text;
    let name = |span: mago_span::Span| &text[span.start.offset as usize..span.end.offset as usize];
    if let Some(c) = chain.iter().find(|c| name(c.method.span()) == "options") {
        let Argument::Positional(p) = c.argument_list.arguments.iter().next()? else { return None };
        return pluck_query(ctx, returned_value(p.value)?);
    }
    let c = chain.iter().find(|c| name(c.method.span()) == "relationship")?;
    let args: Vec<_> = c.argument_list.arguments.iter().collect();
    let [Argument::Positional(relationship), Argument::Positional(title)] = args.as_slice() else { return None };
    let (Some(Value::String(relationship)), Some(Value::String(title))) = (literal_json(ctx, relationship.value), literal_json(ctx, title.value)) else {
        return None;
    };
    Some(serde_json::json!({ "model": model?, "relationship": relationship, "title": title }))
}

/// The value `fn () => …` or a one-statement closure returns, or the expression itself.
fn returned_value<'a>(e: &'a Expression<'a>) -> Option<&'a Expression<'a>> {
    match e {
        Expression::ArrowFunction(f) => Some(f.expression),
        Expression::Closure(f) => match f.body.statements.as_slice() {
            [mago_syntax::cst::Statement::Return(r)] => r.value,
            _ => None,
        },
        other => Some(other),
    }
}

/// `Model::query()->where('active', true)->pluck('name', 'id')` as the calls before `pluck()`, which must
/// have literal arguments, and `pluck()`'s columns.
fn pluck_query(ctx: &Ctx<'_>, e: &Expression<'_>) -> Option<Value> {
    let text = &ctx.doc.text;
    let name = |span: mago_span::Span| text[span.start.offset as usize..span.end.offset as usize].to_string();
    let args = |list: &mago_syntax::cst::ArgumentList<'_>| -> Option<Vec<Value>> {
        list.arguments
            .iter()
            .map(|a| match a {
                Argument::Positional(p) => literal_json(ctx, p.value),
                Argument::Named(_) => None,
            })
            .collect()
    };
    let mut calls = vec![];
    let mut e = e;
    let class = loop {
        match e {
            Expression::Call(mago_syntax::cst::Call::Method(m)) => {
                calls.push((name(m.method.span()), args(&m.argument_list)?));
                e = m.object;
            }
            Expression::Call(mago_syntax::cst::Call::StaticMethod(s)) => {
                calls.push((name(s.method.span()), args(&s.argument_list)?));
                let Expression::Identifier(id) = s.class else { return None };
                break resolve_class(&scope_at(ctx.parsed.program, id.span().start.offset), &String::from_utf8_lossy(id.value()));
            }
            _ => return None,
        }
    };
    let class = class.trim_start_matches('\\').to_string();
    if !is_model(ctx, &class) {
        return None;
    }
    calls.reverse();
    // What follows `pluck()` only turns the collection into an array.
    while calls.last().is_some_and(|(m, a)| a.is_empty() && ["toArray", "all"].contains(&m.as_str())) {
        calls.pop();
    }
    let (method, pluck) = calls.pop()?;
    if method != "pluck" || pluck.is_empty() || pluck.len() > 2 || !pluck.iter().all(Value::is_string) {
        return None;
    }
    // `query()`, `all()`, and `get()` start or end the query without changing it.
    calls.retain(|(m, a)| !(a.is_empty() && ["query", "newQuery", "all", "get"].contains(&m.as_str())));
    let calls: Vec<Value> = calls.into_iter().map(|(m, a)| serde_json::json!([m, a])).collect();
    Some(serde_json::json!({ "model": class, "calls": calls, "pluck": pluck }))
}

/// A literal's value: a string without escapes, a number, `true`, `false`, `null`, or an array of them.
fn literal_json(ctx: &Ctx<'_>, e: &Expression<'_>) -> Option<Value> {
    let text = &ctx.doc.text;
    Some(match e {
        Expression::Literal(Literal::String(s)) => {
            let inner = text.get(s.span.start.offset as usize + 1..s.span.end.offset as usize - 1)?;
            if inner.contains('\\') || inner.contains('$') {
                return None;
            }
            Value::String(inner.to_string())
        }
        Expression::Literal(Literal::Integer(i)) => Value::from(text[i.span.start.offset as usize..i.span.end.offset as usize].replace('_', "").parse::<i64>().ok()?),
        Expression::Literal(Literal::Float(f)) => Value::from(text[f.span.start.offset as usize..f.span.end.offset as usize].replace('_', "").parse::<f64>().ok()?),
        Expression::Literal(Literal::True(_)) => Value::Bool(true),
        Expression::Literal(Literal::False(_)) => Value::Bool(false),
        Expression::Literal(Literal::Null(_)) => Value::Null,
        Expression::Array(_) | Expression::LegacyArray(_) => {
            let elements: Vec<&ArrayElement<'_>> = match e {
                Expression::Array(a) => a.elements.iter().collect(),
                Expression::LegacyArray(a) => a.elements.iter().collect(),
                _ => unreachable!(),
            };
            if elements.iter().all(|el| matches!(el, ArrayElement::Value(_))) {
                Value::Array(elements.iter().map(|el| if let ArrayElement::Value(v) = el { literal_json(ctx, v.value) } else { None }).collect::<Option<_>>()?)
            } else {
                let mut map = serde_json::Map::new();
                for el in elements {
                    let ArrayElement::KeyValue(kv) = el else { return None };
                    let key = match literal_json(ctx, kv.key)? {
                        Value::String(s) => s,
                        Value::Number(n) => n.to_string(),
                        _ => return None,
                    };
                    map.insert(key, literal_json(ctx, kv.value)?);
                }
                Value::Object(map)
            }
        }
        _ => return None,
    })
}

/// Completion for option values: `->options(` and `->enum(` offer the field's enum, `->default(` its cases or
/// literal option keys.
fn value_completion(ctx: &Ctx<'_>, offset: u32) -> Option<Vec<CompletionItem>> {
    let field = field_call(ctx, offset)?;
    let text = &ctx.doc.text;
    let quoted = string_arg_at(ctx, offset);
    let typed_start = match &quoted {
        Some(arg) => arg.start as usize,
        None => {
            let before = &text[..offset as usize];
            before.len() - before.chars().rev().take_while(|c| c.is_alphanumeric() || matches!(c, '_' | '\\' | ':')).map(char::len_utf8).sum::<usize>()
        }
    };
    let range = ctx.doc.range(typed_start as u32, offset);
    let enum_class = field_enum(ctx, &field);
    if field.method != "default" {
        return Some(match (&enum_class, &quoted) {
            (Some(e), None) => vec![item(
                &format!("{}::class", class_reference(ctx, offset, e)),
                CompletionItemKind::ENUM,
                &format!("cast of {}", field.field),
                range,
                None,
            )],
            _ => vec![],
        });
    }
    if let Some(e) = enum_class {
        let cases = enum_cases(ctx, &e)?;
        let class = class_reference(ctx, offset, &e);
        return Some(if quoted.is_some() {
            cases
                .into_iter()
                .filter_map(|(name, value)| Some(item(&value?, CompletionItemKind::ENUM_MEMBER, &format!("{class}::{name}"), range, None)))
                .collect()
        } else {
            cases
                .into_iter()
                .map(|(name, value)| {
                    let detail = value.map_or_else(|| "case".to_string(), |v| format!("= {v}"));
                    item(&format!("{class}::{name}"), CompletionItemKind::ENUM_MEMBER, &detail, range, None)
                })
                .collect()
        });
    }
    if quoted.is_some()
        && let Some(options) = literal_options(ctx, &field.chain)
    {
        return Some(options.into_iter().map(|(k, v)| item(&k, CompletionItemKind::ENUM_MEMBER, v.as_deref().unwrap_or("option"), range, None)).collect());
    }
    // A relationship's options come from the form's model, which a call after the cursor can name.
    let model = state::with_schema(ctx, Some(offset), |schema, _| state::form_model(ctx, schema, schema.owner(offset)?));
    if let Some((options, more)) = query_options(ctx, &field.chain, model.as_deref(), OPTIONS_FRESH) {
        return Some(option_items(options, more, quoted.is_some(), range, |label| label.to_string()));
    }
    Some(vec![])
}

/// Completion items for options read from the database, in their order: the key as typed inside a string, or
/// as PHP outside one. `detail` describes an option by its label.
pub fn option_items(options: Vec<OptionValue>, more: bool, quoted: bool, range: Range, detail: impl Fn(&str) -> String) -> Vec<CompletionItem> {
    let shown = options.len();
    options
        .into_iter()
        .enumerate()
        .map(|(i, o)| {
            let text = if quoted { o.key.clone() } else { o.php.clone() };
            let mut it = item(&text, CompletionItemKind::ENUM_MEMBER, &detail(o.label.as_deref().unwrap_or("option")), range, Some(format!("{i:05}")));
            // The label finds the option too: typing "Acme" offers its `5`.
            it.filter_text = Some(format!("{text} {}", o.label.unwrap_or_default()));
            if more && i + 1 == shown {
                it.documentation = Some(lsp_types::Documentation::String(format!("The first {shown} options from the database.")));
            }
            it
        })
        .collect()
}

pub fn completion(ctx: &Ctx<'_>, offset: u32) -> Option<Vec<CompletionItem>> {
    if !active(ctx) {
        return None;
    }
    let Some(arg) = string_arg_at(ctx, offset) else { return state::value_completion(ctx, offset).or_else(|| value_completion(ctx, offset)) };
    let typed = ctx.doc.text.get(arg.start as usize..offset as usize)?.to_string();

    // $get('…') and $set('…'): the fields the closure's schema reaches.
    if state::is_state_arg(&arg)
        && let Some(items) = state::completion(ctx, offset, &arg)
    {
        return Some(items);
    }
    if arg.call.is_function(&["in_array"]) {
        return state::value_completion(ctx, offset);
    }
    if matches!(arg.call.name.as_str(), "default" | "options" | "enum") && arg.call.kind == CallKind::Method {
        return value_completion(ctx, offset);
    }
    if !filament_call(&arg) || arg.in_array.is_some() {
        return None;
    }
    let kind = match (arg.call.kind, arg.call.name.as_str(), arg.index) {
        (CallKind::Method, "relationship", 0) => "relationship",
        (CallKind::Method, "relationship", 1) => "relatedColumn",
        (CallKind::Static, "make", 0) => "field",
        _ => return None,
    };
    let context = context(ctx)?;
    let model = &context["model"];
    if !model.is_object() {
        return None;
    }
    let word = typed.rsplit('.').next().unwrap_or(&typed);
    let range = ctx.doc.range(offset - word.len() as u32, offset);
    let columns = |columns: &Value, of: &str| -> Vec<CompletionItem> {
        strings(columns).iter().map(|c| item(c, CompletionItemKind::FIELD, &format!("column of {of}"), range, Some(format!("1{c}")))).collect()
    };
    let relations = |relations: &Value| -> Vec<CompletionItem> {
        relations
            .as_array()
            .into_iter()
            .flatten()
            .map(|r| match r.as_str() {
                Some(name) => item(name, CompletionItemKind::REFERENCE, "relationship", range, Some(format!("0{name}"))),
                None => {
                    let name = r["name"].as_str().unwrap_or_default();
                    let detail = format!("{} {}", r["type"].as_str().unwrap_or_default(), r["related"].as_str().unwrap_or_default());
                    item(name, CompletionItemKind::REFERENCE, &detail, range, Some(format!("0{name}")))
                }
            })
            .collect()
    };
    let related_of = |name: &str| relation(model, name).map(|r| (r, r["related"].as_str().unwrap_or_default().to_string()));
    Some(match kind {
        "relationship" => relations(&model["relations"]),
        "relatedColumn" => {
            let Some(Some(first)) = arg.call.arguments.first().map(|a| a.1.clone()) else { return Some(vec![]) };
            related_of(&first).map(|(r, related)| columns(&r["columns"], &related)).unwrap_or_default()
        }
        _ => {
            let segments: Vec<&str> = typed.split('.').collect();
            match segments.as_slice() {
                [_] => {
                    let mut items = relations(&model["relations"]);
                    items.extend(columns(&model["columns"], model["class"].as_str().unwrap_or_default()));
                    items
                }
                [first, _] => match related_of(first) {
                    Some((r, related)) => {
                        let mut items = relations(&r["relations"]);
                        items.extend(columns(&r["columns"], &related));
                        items
                    }
                    None => vec![],
                },
                _ => vec![],
            }
        }
    })
}

/// Goes from a relationship name to its method on the model.
pub fn definition(ctx: &Ctx<'_>, offset: u32) -> Vec<Location> {
    if !active(ctx) {
        return vec![];
    }
    let Some(arg) = string_arg_at(ctx, offset) else { return vec![] };
    if state::is_state_arg(&arg) {
        return state::definition(ctx, offset);
    }
    let Some((start, end, name)) = relationship_name(&arg) else { return vec![] };
    if !(start <= offset && offset <= end) {
        return vec![];
    }
    let Some(context) = context(ctx) else { return vec![] };
    let Some(r) = relation(&context["model"], &name) else { return vec![] };
    let (Some(file), Some(line)) = (r["file"].as_str(), r["line"].as_u64()) else { return vec![] };
    let pos = Position::new(line.saturating_sub(1) as u32, 0);
    vec![Location { uri: path_to_uri(Path::new(file)), range: Range { start: pos, end: pos } }]
}

pub fn hover(ctx: &Ctx<'_>, offset: u32) -> Option<Hover> {
    if !active(ctx) {
        return None;
    }
    state::hover(ctx, offset)
}

/// Quick fixes for the problems [`diagnostics`] reports.
pub fn code_actions(ctx: &Ctx<'_>, range: Range) -> Vec<lsp_types::CodeAction> {
    if !active(ctx) || ctx.doc.language != "php" {
        return vec![];
    }
    state::code_actions(ctx, range)
}

/// Relationship names the model doesn't have, and state paths no field has.
pub fn diagnostics(ctx: &Ctx<'_>) -> Vec<Diagnostic> {
    if !active(ctx) || ctx.doc.language != "php" {
        return vec![];
    }
    let mut out = state::diagnostics(ctx);
    out.extend(relationship_diagnostics(ctx));
    out
}

fn relationship_diagnostics(ctx: &Ctx<'_>) -> Vec<Diagnostic> {
    let names: Vec<_> = string_args(ctx).iter().filter_map(relationship_name).collect();
    if names.is_empty() {
        return vec![];
    }
    let Some(context) = context(ctx) else { return vec![] };
    let model = &context["model"];
    let Some(class) = model["class"].as_str() else { return vec![] };
    // `make('settings.theme')` on a JSON column reads a key, not a relationship.
    let columns = strings(&model["columns"]);
    names
        .into_iter()
        .filter(|(_, _, name)| relation(model, name).is_none() && !columns.contains(name) && model["casts"].get(name).is_none())
        .map(|(start, end, name)| Diagnostic {
            range: ctx.doc.range(start, end),
            severity: Some(DiagnosticSeverity::WARNING),
            source: Some("filament".into()),
            message: format!("{class} has no relationship method {name}()."),
            ..Default::default()
        })
        .collect()
}

fn lens(line: u32, title: String, file: Option<&str>, target: u64) -> Option<CodeLens> {
    let pos = Position::new(line, 0);
    Some(CodeLens {
        range: Range { start: pos, end: pos },
        command: Some(Command {
            title,
            command: "phpEditor.open".into(),
            arguments: Some(vec![Value::String(path_to_uri(Path::new(file?)).as_str().to_string()), Value::from(target)]),
        }),
        data: None,
    })
}

/// Links between a resource, its pages, relation managers, and model, and from a model to its resources.
pub fn code_lenses(ctx: &Ctx<'_>) -> Vec<CodeLens> {
    if !active(ctx) {
        return vec![];
    }
    let Some((class, name_at)) = classes_in(ctx, &ctx.doc.path).into_iter().next() else { return vec![] };
    let line = ctx.doc.position(name_at).line;
    let entry = |v: &Value, title: String| lens(line, title, v["file"].as_str(), v["line"].as_u64().unwrap_or(1));

    if is_model(ctx, &class) {
        let Some(resources) = introspect(ctx, &["resources"]) else { return vec![] };
        return resources[&class]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| entry(r, format!("Filament: {}", short(r["class"].as_str().unwrap_or_default()))))
            .collect();
    }
    let Some(context) = context(ctx) else { return vec![] };
    let resource = &context["resource"];
    if resource["file"].as_str() != Some(&*ctx.doc.path.to_string_lossy()) {
        return entry(resource, format!("Resource: {}", short(resource["class"].as_str().unwrap_or_default()))).into_iter().collect();
    }
    let mut lenses = vec![entry(&context["model"], format!("Model: {}", short(context["resourceModel"].as_str().unwrap_or_default())))];
    for page in context["pages"].as_array().into_iter().flatten().chain(context["relationManagers"].as_array().into_iter().flatten()) {
        lenses.push(entry(page, short(page["class"].as_str().unwrap_or_default()).to_string()));
    }
    lenses.into_iter().flatten().collect()
}

#[allow(dead_code)]
pub fn document_links(_ctx: &Ctx<'_>) -> Vec<DocumentLink> {
    vec![]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::{with_ctx, with_ctx_at};
    use crate::testing::{Fixture, ROOT, on_server_stack, uri};
    use serde_json::json;

    const POST: &str = "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Post extends Model {}\n";
    const ENUM: &str = "<?php\nnamespace App\\Enums;\nenum PostStatus: string\n{\n    case Draft = 'draft';\n    case Published = 'published';\n}\n";
    const RESOURCE: &str = "<?php\nnamespace App\\Filament\\Resources\\Posts;\nuse Filament\\Resources\\Resource;\nclass PostResource extends Resource {}\n";

    fn context_json() -> Value {
        json!({
            "resource": {"class": "App\\Filament\\Resources\\Posts\\PostResource", "file": format!("{ROOT}/app/Filament/Resources/Posts/PostResource.php"), "line": 4},
            "model": {
                "class": "App\\Models\\Post", "file": format!("{ROOT}/app/Models/Post.php"), "line": 4,
                "columns": ["id", "title", "author_id", "status"],
                "casts": {"status": "App\\Enums\\PostStatus"},
                "relations": [{"name": "author", "type": "BelongsTo", "related": "App\\Models\\User", "file": format!("{ROOT}/app/Models/Post.php"), "line": 9, "columns": ["id", "name"], "relations": ["posts"]}],
            },
            "resourceModel": "App\\Models\\Post",
            "pages": [{"name": "index", "class": "App\\Filament\\Resources\\Posts\\Pages\\ListPosts", "file": format!("{ROOT}/app/Filament/Resources/Posts/Pages/ListPosts.php"), "line": 7}],
            "relationManagers": [],
        })
    }

    /// A project with a Post resource, whose form file is `form` (with a `<|>` cursor).
    fn fixture(form: &str) -> Fixture {
        let fx = Fixture::new(&[
            ("app/Models/Post.php", POST),
            ("app/Enums/PostStatus.php", ENUM),
            ("app/Filament/Resources/Posts/PostResource.php", RESOURCE),
            ("app/Filament/Resources/Posts/Schemas/PostForm.php", form),
        ]);
        fx.snap.framework.seed("filament:active", Value::Bool(true));
        fx.snap.framework.seed("filament:resource|App\\Filament\\Resources\\Posts\\PostResource|App\\Filament\\Resources\\Posts\\Schemas\\PostForm", context_json());
        fx
    }

    fn form(body: &str) -> String {
        format!("<?php\nnamespace App\\Filament\\Resources\\Posts\\Schemas;\nuse Filament\\Forms\\Components\\Select;\nclass PostForm\n{{\n    public static function configure($schema)\n    {{\n        return $schema->components([\n            {body}\n        ]);\n    }}\n}}\n")
    }

    fn complete(fx: &Fixture) -> Vec<CompletionItem> {
        let at = fx.at();
        with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| completion(ctx, ctx.offset(at.position))).flatten().unwrap_or_default()
    }

    fn labels(items: &[CompletionItem]) -> Vec<String> {
        items.iter().map(|i| i.label.clone()).collect()
    }

    #[test]
    fn completes_relationships_columns_and_fields() {
        assert_eq!(labels(&complete(&fixture(&form("Select::make('author_id')->relationship('<|>')")))), vec!["author"]);
        let items = complete(&fixture(&form("Select::make('author_id')->relationship('author', 'na<|>')")));
        assert_eq!(labels(&items), vec!["id", "name"]);
        let Some(CompletionTextEdit::Edit(edit)) = &items[0].text_edit else { panic!() };
        assert_eq!(edit.range.end.character - edit.range.start.character, 2);
        assert_eq!(labels(&complete(&fixture(&form("Select::make('<|>')")))), vec!["author", "id", "title", "author_id", "status"]);
        assert_eq!(labels(&complete(&fixture(&form("Select::make('author.<|>')")))), vec!["posts", "id", "name"]);
        let items = complete(&fixture(&form("Select::make('title'), Select::make('x')->visible(fn ($get) => $get('<|>')), Select::make('after')")));
        assert_eq!(labels(&items), vec!["title", "x", "after"]);
    }

    #[test]
    fn completes_enum_options_and_defaults() {
        let items = complete(&fixture(&form("Select::make('status')->options(<|>)")));
        assert_eq!(labels(&items), vec!["\\App\\Enums\\PostStatus::class"]);
        assert_eq!(labels(&complete(&fixture(&form("Select::make('status')->default('<|>')")))), vec!["draft", "published"]);
        let items = complete(&fixture(&form("Select::make('status')->options(\\App\\Enums\\PostStatus::class)->default(Pu<|>)")));
        assert_eq!(labels(&items), vec!["\\App\\Enums\\PostStatus::Draft", "\\App\\Enums\\PostStatus::Published"]);
        assert_eq!(items[1].detail.as_deref(), Some("= published"));
        assert!(complete(&fixture(&form("Select::make('status')->options(Missing::class)->default('<|>')"))).is_empty());
        let items = complete(&fixture(&form("Select::make('size')->options(['s' => 'Short', 'l' => 'Long'])->default('<|>')")));
        assert_eq!(labels(&items), vec!["s", "l"]);
        assert_eq!(items[0].detail.as_deref(), Some("Short"));
    }

    #[test]
    fn reports_and_goes_to_relationships() {
        let fx = fixture(&form("Select::make('writer.name'), Select::make('author.name'), Select::make('a')->relationship('au<|>thor')"));
        let found = with_ctx(&fx.snap, &uri("app/Filament/Resources/Posts/Schemas/PostForm.php"), diagnostics).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].message, "App\\Models\\Post has no relationship method writer().");
        let at = fx.at();
        let locations = with_ctx(&fx.snap, &at.text_document.uri, |ctx| definition(ctx, ctx.offset(at.position))).unwrap();
        assert_eq!(locations[0].range.start, Position::new(8, 0));
    }

    #[test]
    fn links_a_resource_to_its_model_and_pages() {
        let fx = fixture(&form(""));
        fx.snap.framework.seed("filament:resource|App\\Filament\\Resources\\Posts\\PostResource|App\\Filament\\Resources\\Posts\\PostResource", context_json());
        let titles = |name: &str| -> Vec<String> {
            with_ctx(&fx.snap, &uri(name), code_lenses).unwrap().into_iter().map(|l| l.command.unwrap().title).collect()
        };
        assert_eq!(titles("app/Filament/Resources/Posts/PostResource.php"), vec!["Model: Post", "ListPosts"]);
        assert_eq!(titles("app/Filament/Resources/Posts/Schemas/PostForm.php"), vec!["Resource: PostResource"]);
        fx.snap.framework.seed("filament:resources", json!({"App\\Models\\Post": [{"class": "App\\Filament\\Resources\\Posts\\PostResource", "file": "/x/PostResource.php", "line": 3}]}));
        let lenses = with_ctx(&fx.snap, &uri("app/Models/Post.php"), code_lenses).unwrap();
        let command = lenses[0].command.as_ref().unwrap();
        assert_eq!(command.title, "Filament: PostResource");
        assert_eq!(command.arguments.as_ref().unwrap()[1], json!(3));
    }

    const ORDER: &str = "TextInput::make('title'),
            Section::make('Details')->schema([
                Repeater::make('items')->schema([
                    TextInput::make('qty'),
                    TextInput::make('price')->label('Unit price')->live()->afterStateUpdated(fn ($get, $set) => $set(CURSOR, 1)),
                ]),
            ]),
            TextInput::make('total')";

    /// The Post form with a repeater inside a section, and `cursor` as the code a closure in the repeater runs.
    fn order(cursor: &str) -> Fixture {
        let body = ORDER.replace("CURSOR", cursor);
        fixture(&with_uses(&form(&body), &["TextInput", "Repeater"]).replace("use Filament\\Forms\\Components\\Repeater;", "use Filament\\Forms\\Components\\Repeater;\nuse Filament\\Schemas\\Components\\Section;"))
    }

    fn with_uses(text: &str, components: &[&str]) -> String {
        let uses: String = components.iter().map(|c| format!("\nuse Filament\\Forms\\Components\\{c};")).collect();
        text.replacen("use Filament\\Forms\\Components\\Select;", &format!("use Filament\\Forms\\Components\\Select;{uses}"), 1)
    }

    fn diagnose(fx: &Fixture) -> Vec<Diagnostic> {
        with_ctx(&fx.snap, &uri("app/Filament/Resources/Posts/Schemas/PostForm.php"), diagnostics).unwrap()
    }

    fn hover_text(fx: &Fixture) -> String {
        let at = fx.at();
        let shown = with_ctx(&fx.snap, &at.text_document.uri, |ctx| hover(ctx, ctx.offset(at.position))).flatten().expect("a hover");
        let lsp_types::HoverContents::Markup(m) = shown.contents else { panic!() };
        m.value
    }

    #[test]
    fn completes_state_paths_from_the_closures_schema() {
        on_server_stack(|| {
            let items = complete(&order("'<|>'"));
            assert_eq!(labels(&items), vec!["qty", "price", "../../title", "../../items", "../../total"]);
            assert_eq!(items[1].detail.as_deref(), Some("TextInput · Unit price"));
            assert_eq!(items[2].filter_text.as_deref(), Some("title"));
            assert!(items[0].sort_text < items[2].sort_text);
            // Typed with `../`, paths filter as written.
            assert_eq!(complete(&order("'../<|>'"))[2].filter_text, None);
        });
    }

    #[test]
    fn hovers_and_goes_to_state_paths() {
        on_server_stack(|| {
            let fx = order("'../../ti<|>tle'");
            let shown = hover_text(&fx);
            assert!(shown.contains("TextInput::make('title')") && shown.contains("**Title** · TextInput"), "{shown}");
            assert!(hover_text(&order("'pr<|>ice'")).contains("state path `items.*.price`"));
            let at = fx.at();
            let found = with_ctx(&fx.snap, &at.text_document.uri, |ctx| definition(ctx, ctx.offset(at.position))).unwrap();
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].range.start.line, 11);
            assert!(hover_text(&order("'../../../x<|>'")).contains("Livewire component"));
        });
    }

    #[test]
    fn reports_reads_of_fields_the_schema_lacks() {
        on_server_stack(|| {
            let found = diagnose(&order("'qty'"));
            assert!(found.is_empty(), "{found:?}");
            // `$get('total')` in an item reads the item's own `total`, which it doesn't have.
            let fx = order("$get('total') ? 'x' : 'y'");
            let found = diagnose(&fx);
            assert_eq!(found.len(), 1, "{found:?}");
            assert_eq!(found[0].message, "An item of repeater `items` has no field `total`. Did you mean `../../total`?");
            let at = found[0].range;
            let actions = with_ctx(&fx.snap, &uri("app/Filament/Resources/Posts/Schemas/PostForm.php"), |ctx| code_actions(ctx, at)).unwrap();
            assert_eq!(actions[0].title, "Change to ../../total");
            assert!(diagnose(&order("$get('qyt') ? 'x' : 'y'"))[0].message.ends_with("Did you mean `qty`?"));
            // The form's fields come with the record's columns; above the form are the component's properties.
            assert!(diagnose(&order("$get('../../id') . $get('../../../x') . $get('/data.id') . $get('/record.x')")).is_empty());
            // A resource's form is at `data`, so an absolute path is checked as one from the form.
            assert_eq!(diagnose(&order("$get('/data.nope')"))[0].message, "The form has no field `nope`.");
            assert_eq!(diagnose(&order("$get('../../nope')"))[0].message, "The form has no field `nope`.");
            // A path a `$set` writes is state too.
            assert!(diagnose(&order("$set('../../flag', 1) . $get('../../flag')")).is_empty());
            // A schema with children the file doesn't show is never certain.
            let open = form("Repeater::make('items')->schema([...self::fields(), TextInput::make('a')->visible(fn ($get) => $get('b'))])");
            assert!(diagnose(&fixture(&with_uses(&open, &["TextInput", "Repeater"]))).is_empty());
        });
    }

    #[test]
    fn keeps_builder_blocks_apart() {
        on_server_stack(|| {
            let body = "Builder::make('content')->blocks([
                Block::make('heading')->schema([TextInput::make('text'), TextInput::make('level')->visible(fn ($get) => $get('<|>'))]),
                Block::make('image')->schema([TextInput::make('url')]),
            ])";
            let text = with_uses(&form(body), &["Builder", "Builder\\Block", "TextInput"]);
            assert_eq!(labels(&complete(&fixture(&text))), vec!["text", "level", "../../../content"]);
            let found = diagnose(&fixture(&text.replace("$get('<|>')", "$get('url')")));
            assert_eq!(found[0].message, "Block `heading` has no field `url`.");
        });
    }

    #[test]
    fn completes_compared_values_and_reports_enum_comparisons() {
        on_server_stack(|| {
            let fx = fixture(&form("Select::make('size')->options(fn () => ['s' => 'Short', 'l' => 'Long']), Select::make('x')->visible(fn ($get) => $get('size') === '<|>')"));
            assert_eq!(labels(&complete(&fx)), vec!["s", "l"]);
            let fx = fixture(&form("Select::make('size')->options(['s' => 'Short']), Select::make('x')->visible(fn ($get) => in_array($get('size'), ['<|>']))"));
            assert_eq!(labels(&complete(&fx)), vec!["s"]);
            let status = "Select::make('status')->options(\\App\\Enums\\PostStatus::class), Select::make('x')->visible(fn ($get) => ";
            let fx = fixture(&form(&format!("{status}$get('status') === Pu<|>)")));
            fx.snap.framework.seed("filament:v4", Value::Bool(true));
            assert_eq!(labels(&complete(&fx)), vec!["\\App\\Enums\\PostStatus::Draft", "\\App\\Enums\\PostStatus::Published"]);
            let fx = fixture(&form(&format!("{status}match ($get('status')) {{ '<|>' => true, default => false }})")));
            fx.snap.framework.seed("filament:v4", Value::Bool(false));
            assert_eq!(labels(&complete(&fx)), vec!["draft", "published"]);
            // Before anything is typed: after the operator, in a new arm, and in a list or `match` left open.
            let cases = vec!["\\App\\Enums\\PostStatus::Draft", "\\App\\Enums\\PostStatus::Published"];
            for body in [
                "$get('status') === <|>)",
                "$get('status') !==<|>)",
                "match ($get('status')) { \\App\\Enums\\PostStatus::Draft => 1, <|> })",
                "match ($get('status')) { <|>",
                "match ($get('status')) {\n <|>\n",
            ] {
                let fx = fixture(&form(&format!("{status}{body}")));
                fx.snap.framework.seed("filament:v4", Value::Bool(true));
                assert_eq!(labels(&complete(&fx)), cases, "{body}");
            }
            let fx = fixture(&form("Select::make('size')->options(['s' => 'Short']), Select::make('x')->visible(fn ($get) => in_array($get('size'), ['<|>"));
            assert_eq!(labels(&complete(&fx)), vec!["s"]);
            // Not in an arm's result.
            let fx = fixture(&form(&format!("{status}match ($get('status')) {{ 'a' => <|> }})")));
            assert!(complete(&fx).is_empty());
            let fx = fixture(&form(&format!("{status}$get('status') === 'draft')")));
            fx.snap.framework.seed("filament:v4", Value::Bool(true));
            let found = diagnose(&fx);
            assert_eq!(found.len(), 1, "{found:?}");
            assert!(found[0].message.ends_with("Compare with `\\App\\Enums\\PostStatus::Draft`."), "{}", found[0].message);
        });
    }

    #[test]
    fn resolves_absolute_paths_from_the_component() {
        on_server_stack(|| {
            let items = complete(&order("'/<|>'"));
            assert_eq!(labels(&items), vec!["/data.title", "/data.items", "/data.total"]);
            assert_eq!(items[0].filter_text, None);
            let items = complete(&order("'<|>', 1, true"));
            assert_eq!(labels(&items), vec!["data.title", "data.items", "data.total"]);
            let fx = order("'/data.ti<|>tle'");
            assert!(hover_text(&fx).contains("**Title** · TextInput"));
            let at = fx.at();
            let found = with_ctx(&fx.snap, &at.text_document.uri, |ctx| definition(ctx, ctx.offset(at.position))).unwrap();
            assert_eq!(found[0].range.start.line, 11);
            assert!(hover_text(&order("'data.to<|>tal', 1, true")).contains("**Total**"));
            assert!(hover_text(&order("'/rec<|>ord.name'")).contains("isn't in the form's state"));
            assert!(diagnose(&order("$get('data.items', true) . $set('/data.flag', 1) . $get('/data.flag')")).is_empty());
        });
    }

    /// A Post form whose `status` select reads its options from the database, with those `rows` read already.
    fn with_options(body: &str, query: Value, rows: Value) -> Fixture {
        let fx = fixture(&form(body));
        fx.snap.framework.seed(&format!("filament:options|{query}"), json!({ "rows": rows, "more": false }));
        fx
    }

    #[test]
    fn suggests_options_from_the_database() {
        on_server_stack(|| {
            let pluck = json!({ "model": "App\\Models\\Post", "calls": [["where", ["status", "published"]]], "pluck": ["title", "id"] });
            let rows = json!([[1, "Hello"], [2, "World"]]);
            let select = "Select::make('post_id')->options(\\App\\Models\\Post::query()->where('status', 'published')->pluck('title', 'id'))";
            let fx = with_options(&format!("{select}, Select::make('x')->visible(fn ($get) => $get('post_id') === Wor<|>)"), pluck.clone(), rows.clone());
            let items = complete(&fx);
            assert_eq!(labels(&items), vec!["1", "2"]);
            assert_eq!(items[0].detail.as_deref(), Some("Post id · Hello"));
            assert_eq!(items[1].filter_text.as_deref(), Some("2 World"));
            let fx = with_options(&format!("{select}, Select::make('x')->visible(fn ($get) => in_array($get('post_id'), ['<|>']))"), pluck.clone(), rows.clone());
            assert_eq!(labels(&complete(&fx)), vec!["1", "2"]);
            // A string key is quoted outside a string.
            let fx = with_options(&format!("{select}, Select::make('x')->visible(fn ($get) => $get('post_id') === Q<|>)"), pluck.clone(), json!([["a'b", "Quote"]]));
            assert_eq!(labels(&complete(&fx)), vec!["'a\\'b'"]);
            // `->default()` too, and hover lists them.
            let fx = with_options(&format!("{select}->default(<|>)"), pluck.clone(), rows.clone());
            assert_eq!(labels(&complete(&fx)), vec!["1", "2"]);
            let fx = with_options(&format!("{select}, Select::make('x')->visible(fn ($get) => $get('post<|>_id'))"), pluck.clone(), rows.clone());
            assert!(hover_text(&fx).contains("Options from the database: `1` Hello, `2` World"), "{}", hover_text(&fx));
            // A relationship's records, by its title column.
            let related = json!({ "model": "App\\Models\\Post", "relationship": "author", "title": "name" });
            let fx = with_options("Select::make('author_id')->relationship('author', 'name'), Select::make('x')->visible(fn ($get) => $get('author_id') == '<|>')", related.clone(), json!([[7, "Ann"]]));
            assert_eq!(labels(&complete(&fx)), vec!["7"]);
            // `->default()` on a relationship's field, in a resource's form or a Livewire form naming its model.
            let fx = with_options("Select::make('author_id')->relationship('author', 'name')->default(<|>)", related.clone(), json!([[7, "Ann"]]));
            assert_eq!(labels(&complete(&fx)), vec!["7"]);
            let class = INVITE
                .replace("TextInput::make('name'),", "\\Filament\\Forms\\Components\\Select::make('author_id')->relationship('author', 'name')->default(<|>),")
                .replace("->statePath('data')", "->statePath('data')->model(\\App\\Models\\Post::class)");
            let fx = Fixture::new(&[("vendor/livewire/Component.php", LIVEWIRE), ("app/Livewire/Invite.php", &class)]);
            fx.snap.framework.seed("filament:active", Value::Bool(true));
            fx.snap.framework.seed(&format!("filament:options|{related}"), json!({ "rows": [[7, "Ann"]], "more": false }));
            assert_eq!(labels(&complete(&fx)), vec!["7"]);
            // Nothing until they've been read.
            let fx = fixture(&form(&format!("{select}, Select::make('x')->visible(fn ($get) => $get('post_id') === '<|>')")));
            fx.snap.framework.seed("filament:options|ignored", Value::Null);
            assert!(complete(&fx).is_empty());
        });
    }

    #[test]
    fn reads_only_queries_it_can_run_safely() {
        let query = |code: &str| {
            let fx = fixture(&form(&format!("Select::make('a')->options({code})")));
            with_ctx(&fx.snap, &uri("app/Filament/Resources/Posts/Schemas/PostForm.php"), |ctx| {
                let schema = schema::build(ctx, &ctx.parsed);
                let comp = schema.comps.iter().find(|c| c.name.as_ref().is_some_and(|n| n.0 == "a")).unwrap();
                options_query(ctx, &comp.chain, None)
            })
            .unwrap()
        };
        assert_eq!(query("\\App\\Models\\Post::pluck('title', 'id')"), Some(json!({ "model": "App\\Models\\Post", "calls": [], "pluck": ["title", "id"] })));
        assert_eq!(
            query("fn () => \\App\\Models\\Post::query()->published()->orderBy('title')->get()->pluck('title', 'id')->toArray()"),
            Some(json!({ "model": "App\\Models\\Post", "calls": [["published", []], ["orderBy", ["title"]]], "pluck": ["title", "id"] }))
        );
        assert_eq!(query("\\App\\Models\\Post::where('author_id', $this->author)->pluck('title', 'id')"), None);
        assert_eq!(query("\\App\\Models\\Post::where('title', \"x{$y}\")->pluck('title')"), None);
        assert_eq!(query("\\App\\Enums\\PostStatus::pluck('title')"), None);
        assert_eq!(query("\\App\\Models\\Post::pluck('title', 'id')->map(fn ($t) => strtoupper($t))"), None);
    }

    const ACTIONS: &str = "<?php\nnamespace App\\Filament\\Pages;\nuse Filament\\Actions\\Action;\nuse Filament\\Actions\\EditAction;\nuse Filament\\Forms\\Components\\TextInput;\nclass Tools\n{\n    public function actions(): array\n    {\n        return [BODY];\n    }\n}\n";

    fn action_problems(body: &str) -> Vec<String> {
        let fx = Fixture::new(&[("app/Filament/Pages/Tools.php", &ACTIONS.replace("BODY", body))]);
        fx.snap.framework.seed("filament:active", Value::Bool(true));
        let found = with_ctx(&fx.snap, &uri("app/Filament/Pages/Tools.php"), diagnostics).unwrap();
        found.into_iter().map(|d| d.message).collect()
    }

    #[test]
    fn reports_missing_fields_in_action_forms_it_sees_filled() {
        on_server_stack(|| {
            let fields = "[TextInput::make('name'), TextInput::make('email')->visible(fn ($get) => $get('nmae') && $get('role'))]";
            assert_eq!(
                action_problems(&format!("Action::make('invite')->schema({fields})")),
                vec!["The form has no field `nmae`. Did you mean `name`?", "The form has no field `role`."]
            );
            assert_eq!(action_problems(&format!("Action::make('invite')->form({fields})")).len(), 2);
            // A literal `fillForm()` adds its keys.
            assert_eq!(action_problems(&format!("Action::make('invite')->schema({fields})->fillForm(fn () => ['role' => 'admin'])")).len(), 1);
            assert_eq!(action_problems(&format!("EditAction::make()->fillForm(['role' => 1, 'nmae' => 2])->schema({fields})")).len(), 0);
            // Filled from a record, by code, or from a chain kept in a variable: anything can be there.
            assert!(action_problems(&format!("EditAction::make()->schema({fields})")).is_empty());
            assert!(action_problems(&format!("Action::make('invite')->schema({fields})->fillForm(fn ($record) => $record->toArray())")).is_empty());
            assert!(action_problems(&format!("Action::make('invite')->schema({fields})->mountUsing(fn ($schema) => $schema->fill())")).is_empty());
            assert!(action_problems(&format!("$a = Action::make('invite')->schema({fields})")).is_empty());
            // Filament 3's table, form, and bulk actions mount the same way; its `EditAction` fills from the record.
            for class in ["Tables\\Actions\\Action", "Tables\\Actions\\BulkAction", "Forms\\Components\\Actions\\Action", "Tables\\Actions\\CreateAction"] {
                assert_eq!(action_problems(&format!("\\Filament\\{class}::make('a')->form({fields})")).len(), 2, "{class}");
            }
            assert!(action_problems(&format!("\\Filament\\Tables\\Actions\\EditAction::make()->form({fields})")).is_empty());
        });
    }

    const LIVEWIRE: &str = "<?php\nnamespace Livewire;\nabstract class Component {}\n";
    const INVITE: &str = "<?php\nnamespace App\\Livewire;\nuse Filament\\Forms\\Components\\TextInput;\nuse Livewire\\Component;\nclass Invite extends Component\n{\n    public ?array $data = [];\n    public function mount(): void\n    {\n        $this->form->fill(['email' => 'a@b.c']);\n    }\n    public function form($schema)\n    {\n        return $schema->components([TextInput::make('name'), TextInput::make('code')->visible(fn ($get) => $get('email') && $get('nope'))])->statePath('data');\n    }\n    public function save(): void\n    {\n        $name = $this->data['name'] ?? null;\n        $state = $this->form->getState();\n    }\n    public function render()\n    {\n        return view('livewire.invite');\n    }\n}\n";

    fn livewire_problems(class: &str, view: &str) -> Vec<String> {
        let fx = Fixture::new(&[("vendor/livewire/Component.php", LIVEWIRE), ("app/Livewire/Invite.php", class), ("resources/views/livewire/invite.blade.php", view)]);
        fx.snap.framework.seed("filament:active", Value::Bool(true));
        let found = with_ctx(&fx.snap, &uri("app/Livewire/Invite.php"), diagnostics).unwrap();
        found.into_iter().map(|d| d.message).collect()
    }

    #[test]
    fn reports_missing_fields_in_livewire_forms_it_sees_filled() {
        on_server_stack(|| {
            let view = "<div>{{ $this->form }}</div>";
            assert_eq!(livewire_problems(INVITE, view), vec!["The form has no field `nope`."]);
            // Absolute paths start with the form's state path.
            let absolute = INVITE.replace("$get('nope')", "$get('/data.nope') . $get('/data.email') . $get('/other')");
            assert_eq!(livewire_problems(&absolute, view), vec!["The form has no field `nope`."]);
            // Anything else that could put keys in the state keeps it quiet.
            let quiet = [
                INVITE.replace("['email' => 'a@b.c']", "[...$this->defaults()]"),
                INVITE.replace("$name = $this->data['name'] ?? null;", "$this->data['nope'] = 1;"),
                INVITE.replace("$name = $this->data['name'] ?? null;", "data_set($this->data, 'nope', 1);"),
                INVITE.replace("public ?array $data = [];", "#[\\Livewire\\Attributes\\Url]\n    public ?array $data = [];"),
                INVITE.replace("->statePath('data')", ""),
                INVITE.replace("return view('livewire.invite');", "return view($this->view);"),
                INVITE.replace("extends Component", "extends \\App\\Livewire\\Base").replace("namespace App\\Livewire;", "namespace App\\Livewire;\nabstract class Base extends \\Livewire\\Component {}"),
            ];
            for class in &quiet {
                assert!(livewire_problems(class, view).is_empty(), "{class}");
            }
            assert!(livewire_problems(INVITE, "<input wire:model=\"data.nope\">").is_empty());
            assert!(livewire_problems(INVITE, "<input wire:model=\"data.{{ $k }}\">").is_empty());
            // A binding of another key, reads, and text that only looks like a path don't.
            let view = "<p>metadata.nope 'data'</p> {{ $data['name'] }} <input wire:model=\"data.other\">";
            assert_eq!(livewire_problems(INVITE, view), vec!["The form has no field `nope`."]);
        });
    }

    #[test]
    fn reports_missing_fields_in_relationship_repeaters_from_the_related_columns() {
        on_server_stack(|| {
            let body = "Repeater::make('comments')->relationship()->schema([TextInput::make('body'), TextInput::make('x')->visible(fn ($get) => $get('author_id') . $get('bdoy'))])";
            let text = with_uses(&form(body), &["TextInput", "Repeater"]);
            let mut context = context_json();
            context["model"]["relations"].as_array_mut().unwrap().push(json!({"name": "comments", "type": "HasMany", "related": "App\\Models\\Comment", "columns": ["id", "post_id", "author_id", "body"], "appends": ["excerpt"], "casts": {}, "columnsGuessed": false, "relations": []}));
            let seeded = |text: &str, context: &Value| {
                let fx = fixture(text);
                fx.snap.framework.seed("filament:resource|App\\Filament\\Resources\\Posts\\PostResource|App\\Filament\\Resources\\Posts\\Schemas\\PostForm", context.clone());
                diagnose(&fx).into_iter().map(|d| d.message).collect::<Vec<_>>()
            };
            assert_eq!(seeded(&text, &context), vec!["An item of repeater `comments` has no field `bdoy`. Did you mean `body`?"]);
            assert!(seeded(&text.replace("bdoy", "excerpt"), &context).is_empty());
            // A query or data closure, or columns the database didn't give, can add keys.
            assert!(seeded(&text.replace("->relationship()", "->relationship(modifyQueryUsing: fn ($q) => $q)"), &context).is_empty());
            assert!(seeded(&text.replace("->relationship()", "->relationship()->mutateRelationshipDataBeforeFillUsing(fn ($d) => $d)"), &context).is_empty());
            let mut guessed = context.clone();
            guessed["model"]["relations"][1]["columnsGuessed"] = Value::Bool(true);
            assert!(seeded(&text, &guessed).is_empty());
        });
    }

    /// Runs against the Filament demo app that `scripts/make-fixture.sh` builds, mirroring the old PHP server's
    /// tests: `TUSK_FILAMENT_FIXTURE=/path/to/fixtures/demo cargo test -- --ignored filament`.
    #[test]
    #[ignore]
    fn works_on_the_demo_app() {
        use crate::documents::{Document, Documents};
        use crate::index::{Index, IndexConfig};
        use crate::server::Snapshot;
        let root = PathBuf::from(std::env::var("TUSK_FILAMENT_FIXTURE").expect("TUSK_FILAMENT_FIXTURE"));
        let mut index = Index::empty(IndexConfig::new(&root));
        let paths = index.discover();
        index.build(paths, |p| std::fs::read(p).ok(), |_, _| {});
        let index = Arc::new(parking_lot::RwLock::new(index));
        let framework = Arc::new(super::super::State::new(root.clone()));
        let resources = root.join("app/Filament/Resources");
        let form = resources.join("Posts/Schemas/PostForm.php");
        let table = resources.join("Posts/Tables/PostsTable.php");
        let read = |p: &Path| std::fs::read_to_string(p).unwrap();

        // A snapshot with `path` open as `text`, and the cursor after the first `needle`.
        let open = |path: &Path, text: String| {
            let mut docs = Documents::default();
            docs.insert(Document::new(path_to_uri(path), path.to_path_buf(), "php".into(), 1, text));
            Snapshot { docs, index: index.clone(), root: root.clone(), framework: framework.clone(), client: None, cancel: Default::default() }
        };
        let run = |path: &Path, text: String, needle: &str| -> Vec<CompletionItem> {
            let offset = (text.find(needle).expect(needle) + needle.len()) as u32;
            let snap = open(path, text);
            let doc = snap.docs.get(path).unwrap().clone();
            with_ctx_at(&snap, &doc.uri, doc.position(offset), |ctx| completion(ctx, offset)).flatten().unwrap_or_default()
        };
        let has = |items: &[CompletionItem], l: &str| items.iter().any(|i| i.label == l);

        let src = read(&form).replace("->relationship('author', 'name')", "->relationship('')");
        assert_eq!(labels(&run(&form, src, "->relationship('")), vec!["author"]);
        let src = read(&form).replace("->relationship('author', 'name')", "->relationship('author', 'na')");
        let items = run(&form, src, "'author', 'na");
        assert!(has(&items, "name"));
        let src = read(&form).replace("TextInput::make('title')", "TextInput::make('')");
        let items = run(&form, src, "TextInput::make('");
        assert!(has(&items, "title") && has(&items, "author_id") && has(&items, "author"));
        let src = read(&table).replace("TextColumn::make('author.name')", "TextColumn::make('author.')");
        let items = run(&table, src, "make('author.");
        assert!(has(&items, "name") && has(&items, "posts") && !has(&items, "title"));
        let manager = resources.join("Authors/RelationManagers/PostsRelationManager.php");
        let src = read(&manager).replacen("TextInput::make('title')", "TextInput::make('')", 1);
        assert!(has(&run(&manager, src, "TextInput::make('"), "published"));

        let with_status = |chain: &str| read(&form).replace("TextInput::make('title')", &format!("Select::make('status'){chain},\n                TextInput::make('title')"));
        assert_eq!(labels(&run(&form, with_status("->options()"), "->options(")), vec!["\\App\\Enums\\PostStatus::class"]);
        assert_eq!(labels(&run(&form, with_status("->default('')"), "->default('")), vec!["draft", "published", "archived"]);
        let src = with_status("->options(PostStatus::class)->default(Pub)").replace("use Filament\\Schemas\\Schema;", "use Filament\\Schemas\\Schema;\nuse App\\Enums\\PostStatus;");
        assert_eq!(labels(&run(&form, src, "->default(Pub"))[1], "PostStatus::Published");
        assert!(run(&form, with_status("->options(Missing::class)->default('')"), "->default('").is_empty());
        let src = read(&form).replace("TextInput::make('title')", "TextInput::make('title')->options(['short' => 'Short', 'long' => 'Long'])->default('')");
        assert_eq!(labels(&run(&form, src, "->default('")), vec!["short", "long"]);
        let src = read(&form).replace("->required(),\n                TextInput", "->visible(fn ($get) => $get('')),\n                TextInput");
        let items = run(&form, src, "$get('");
        assert!(has(&items, "author_id") && has(&items, "published"));

        let src = read(&table);
        let offset = (src.find("make('aut").unwrap() + "make('aut".len()) as u32;
        let snap = open(&table, src);
        let found = with_ctx(&snap, &path_to_uri(&table), |ctx| definition(ctx, offset)).unwrap();
        assert_eq!(found[0].uri, path_to_uri(&root.join("app/Models/Post.php")));
        let post = read(&root.join("app/Models/Post.php"));
        assert!(post.lines().nth(found[0].range.start.line as usize).unwrap().contains("function author"));

        let diags = |path: &Path, text: String| with_ctx(&open(path, text), &path_to_uri(path), diagnostics).unwrap();
        assert!(diags(&form, read(&form)).is_empty());
        assert!(diags(&table, read(&table)).is_empty());
        let found = diags(&table, read(&table).replace("TextColumn::make('author.name')", "TextColumn::make('writer.name')"));
        assert!(found.len() == 1 && found[0].message.contains("writer()"));

        let titles = |path: &Path| -> Vec<String> {
            with_ctx(&open(path, read(path)), &path_to_uri(path), code_lenses).unwrap().into_iter().map(|l| l.command.unwrap().title).collect()
        };
        assert_eq!(titles(&resources.join("Posts/PostResource.php")), vec!["Model: Post", "ListPosts", "CreatePost", "EditPost"]);
        assert!(titles(&resources.join("Authors/AuthorResource.php")).contains(&"PostsRelationManager".to_string()));
        assert_eq!(titles(&form), vec!["Resource: PostResource"]);
        assert_eq!(titles(&root.join("app/Models/Post.php")), vec!["Filament: PostResource"]);
        assert!(titles(&root.join("app/Models/User.php")).is_empty());
    }

    /// Reads every `$get()` and `$set()` in a real Filament app and prints what each resolves to and the
    /// problems reported, which should all be real: `TUSK_FILAMENT_APP=<root> cargo test -- --ignored --nocapture
    /// state_paths_in_a_real_app`.
    #[test]
    #[ignore]
    fn state_paths_in_a_real_app() {
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
            let framework = Arc::new(super::super::State::new(root.clone()));
            let files: Vec<PathBuf> = index.read().files.values().map(|f| f.path.clone()).filter(|p| p.starts_with(root.join("app"))).collect();
            let (mut reads, mut resolved, mut reported) = (0, 0, 0);
            for path in files {
                let text = std::fs::read_to_string(&path).unwrap();
                if !text.contains("$get") && !text.contains("$set") {
                    continue;
                }
                let mut docs = Documents::default();
                docs.insert(Document::new(path_to_uri(&path), path.clone(), "php".into(), 1, text.clone()));
                let snap = Snapshot { docs, index: index.clone(), root: root.clone(), framework: framework.clone(), client: None, cancel: Default::default() };
                let uri = path_to_uri(&path);
                let rel = path.strip_prefix(&root).unwrap().display().to_string();
                with_ctx(&snap, &uri, |ctx| {
                    for arg in string_args(ctx).iter().filter(|a| state::is_state_arg(a)) {
                        let found = definition(ctx, arg.start);
                        let hovered = hover(ctx, arg.start).is_some();
                        if ["$get", "$set"].contains(&arg.call.name.as_str()) || hovered {
                            reads += 1;
                            resolved += usize::from(!found.is_empty());
                            if found.is_empty() {
                                eprintln!("unresolved {rel}:{} {}('{}')", ctx.doc.position(arg.start).line + 1, arg.call.name, arg.value);
                            }
                        }
                    }
                    for d in diagnostics(ctx).iter().filter(|d| d.source.as_deref() == Some("filament")) {
                        reported += 1;
                        eprintln!("problem {rel}:{} {}", d.range.start.line + 1, d.message);
                    }
                });
            }
            eprintln!("{reads} paths, {resolved} resolved to a field, {reported} problems");
        });
    }
}
