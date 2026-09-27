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
use crate::features::Ctx;
use crate::index::file_id;
use crate::scope::{resolve_class, scope_at};
use crate::text::path_to_uri;

/// The script that describes resources and models, run in its own PHP process so edited classes load fresh.
const INTROSPECT: &str = include_str!("../../../filament-lsp/introspect.php");

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
    let root = state.root().to_string_lossy().into_owned();
    let mut all = vec![root.as_str()];
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
    introspect(ctx, &["resource", &resource, &own])
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

/// The field's enum: from `->options(X::class)` or `->enum(X::class)`, or else the model's cast of the field.
/// Only an enum the index knows counts, not a cast such as `datetime`.
fn field_enum(ctx: &Ctx<'_>, field: &FieldCall<'_>) -> Option<String> {
    let text = ctx.parsed.text();
    let from_chain = field.chain.iter().find_map(|c| {
        let name = &text[c.method.span().start.offset as usize..c.method.span().end.offset as usize];
        if name != "options" && name != "enum" {
            return None;
        }
        let Argument::Positional(p) = c.argument_list.arguments.iter().next()? else { return None };
        let Expression::Access(mago_syntax::cst::Access::ClassConstant(access)) = p.value else { return None };
        let class = ctx.resolver().classes_of_class_expr(access.class, &ctx.parsed.path_at(access.span().start.offset));
        class.into_iter().next()
    });
    let class = match from_chain {
        Some(c) => c,
        None => context(ctx)?["model"]["casts"][&field.field].as_str()?.to_string(),
    };
    ctx.index.codebase.get_enum(class.as_bytes()).map(|e| e.original_name.as_str_lossy().into_owned())
}

/// Keys and values of a literal `->options([...])` array in the chain.
fn literal_options(ctx: &Ctx<'_>, field: &FieldCall<'_>) -> Option<Vec<(String, Option<String>)>> {
    let text = ctx.parsed.text();
    let string = |e: &Expression<'_>| match e {
        Expression::Literal(Literal::String(s)) => Some(text[s.span.start.offset as usize + 1..s.span.end.offset as usize - 1].to_string()),
        _ => None,
    };
    field.chain.iter().find_map(|c| {
        if &text[c.method.span().start.offset as usize..c.method.span().end.offset as usize] != "options" {
            return None;
        }
        let Argument::Positional(p) = c.argument_list.arguments.iter().next()? else { return None };
        let elements = match p.value {
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
        && let Some(options) = literal_options(ctx, &field)
    {
        return Some(options.into_iter().map(|(k, v)| item(&k, CompletionItemKind::ENUM_MEMBER, v.as_deref().unwrap_or("option"), range, None)).collect());
    }
    Some(vec![])
}

/// The names in `::make('name')` calls, in order and without repeats. Read from the whole text: the parse
/// for completion ends at the cursor, and fields after it count too.
fn field_names(text: &str) -> Vec<String> {
    let mut names: Vec<String> = vec![];
    for (at, _) in text.match_indices("::make(") {
        let rest = text[at + "::make(".len()..].trim_start();
        let Some(quote) = rest.chars().next().filter(|q| *q == '\'' || *q == '"') else { continue };
        let name: String = rest[1..].chars().take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '.').collect();
        if !name.is_empty() && rest[1 + name.len()..].starts_with(quote) && !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

pub fn completion(ctx: &Ctx<'_>, offset: u32) -> Option<Vec<CompletionItem>> {
    if !active(ctx) {
        return None;
    }
    let Some(arg) = string_arg_at(ctx, offset) else { return value_completion(ctx, offset) };
    let typed = ctx.doc.text.get(arg.start as usize..offset as usize)?.to_string();

    // $get('…') and $set('…') in a form: the names of its fields.
    if arg.call.kind == CallKind::Closure && ["$get", "$set"].contains(&arg.call.name.as_str()) && arg.index == 0 {
        let range = ctx.doc.range(arg.start, offset);
        return Some(field_names(&ctx.doc.text).iter().map(|n| item(n, CompletionItemKind::FIELD, "field", range, None)).collect());
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
    let Some(arg) = string_arg_at(ctx, offset) else { return vec![] };
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

pub fn hover(_ctx: &Ctx<'_>, _offset: u32) -> Option<Hover> {
    None
}

/// Relationship names the model doesn't have.
pub fn diagnostics(ctx: &Ctx<'_>) -> Vec<Diagnostic> {
    if !active(ctx) || ctx.doc.language != "php" {
        return vec![];
    }
    let names: Vec<_> = string_args(ctx).iter().filter_map(relationship_name).collect();
    if names.is_empty() {
        return vec![];
    }
    let Some(context) = context(ctx) else { return vec![] };
    let model = &context["model"];
    let Some(class) = model["class"].as_str() else { return vec![] };
    names
        .into_iter()
        .filter(|(_, _, name)| relation(model, name).is_none())
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
    use crate::testing::{Fixture, ROOT, uri};
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
        let found = with_ctx(&fx.snap, &uri("app/Filament/Resources/Posts/Schemas/PostForm.php"), |ctx| diagnostics(ctx)).unwrap();
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
            with_ctx(&fx.snap, &uri(name), |ctx| code_lenses(ctx)).unwrap().into_iter().map(|l| l.command.unwrap().title).collect()
        };
        assert_eq!(titles("app/Filament/Resources/Posts/PostResource.php"), vec!["Model: Post", "ListPosts"]);
        assert_eq!(titles("app/Filament/Resources/Posts/Schemas/PostForm.php"), vec!["Resource: PostResource"]);
        fx.snap.framework.seed("filament:resources", json!({"App\\Models\\Post": [{"class": "App\\Filament\\Resources\\Posts\\PostResource", "file": "/x/PostResource.php", "line": 3}]}));
        let lenses = with_ctx(&fx.snap, &uri("app/Models/Post.php"), |ctx| code_lenses(ctx)).unwrap();
        let command = lenses[0].command.as_ref().unwrap();
        assert_eq!(command.title, "Filament: PostResource");
        assert_eq!(command.arguments.as_ref().unwrap()[1], json!(3));
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
            Snapshot { docs, index: index.clone(), root: root.clone(), framework: framework.clone() }
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

        let diags = |path: &Path, text: String| with_ctx(&open(path, text), &path_to_uri(path), |ctx| diagnostics(ctx)).unwrap();
        assert!(diags(&form, read(&form)).is_empty());
        assert!(diags(&table, read(&table)).is_empty());
        let found = diags(&table, read(&table).replace("TextColumn::make('author.name')", "TextColumn::make('writer.name')"));
        assert!(found.len() == 1 && found[0].message.contains("writer()"));

        let titles = |path: &Path| -> Vec<String> {
            with_ctx(&open(path, read(path)), &path_to_uri(path), |ctx| code_lenses(ctx)).unwrap().into_iter().map(|l| l.command.unwrap().title).collect()
        };
        assert_eq!(titles(&resources.join("Posts/PostResource.php")), vec!["Model: Post", "ListPosts", "CreatePost", "EditPost"]);
        assert!(titles(&resources.join("Authors/AuthorResource.php")).contains(&"PostsRelationManager".to_string()));
        assert_eq!(titles(&form), vec!["Resource: PostResource"]);
        assert_eq!(titles(&root.join("app/Models/Post.php")), vec!["Filament: PostResource"]);
        assert!(titles(&root.join("app/Models/User.php")).is_empty());
    }
}
