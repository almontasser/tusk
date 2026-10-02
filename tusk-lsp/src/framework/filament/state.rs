//! `$get()` and `$set()`: completion, hover, and go to definition for the state paths they take, problems
//! with reads of fields the schema doesn't have, and completion of the values a field's state is compared
//! with (`$get('status') === '…'`).

use lsp_types::{
    CodeAction, CodeActionKind, CompletionItem, CompletionItemKind, Diagnostic, DiagnosticSeverity, Documentation, Hover, HoverContents, Location,
    MarkupContent, MarkupKind, NumberOrString, Range, TextEdit,
};
use mago_allocator::LocalArena;
use mago_span::HasSpan;
use mago_syntax::cst::{Argument, Call, Expression, Literal, Node};
use serde_json::{Value, json};

use super::schema::{self, Comp, Fill, GET_METHODS, Kind, Resolved, Schema, default_label};
use super::{CallKind, StringArg, active, class_reference, context, enum_cases, item, string_arg_at, string_args};
use crate::analysis::Parsed;
use crate::features::Ctx;
use crate::locate::walk;

/// A `$get()` or `$set()` call's path argument.
pub struct StateCall {
    pub set: bool,
    /// `isAbsolute: true`, or a path that starts with `/`.
    pub absolute: bool,
    /// Whether it's `isAbsolute: true`, whose path doesn't start with `/`.
    pub absolute_flag: bool,
}

/// Runs `f` on the file's schemas. Completion's parse ends at the cursor, so it reads the whole text again,
/// falling back to the repaired copy when the code around the cursor doesn't parse without it.
pub fn with_schema<R>(ctx: &Ctx<'_>, completing: Option<u32>, f: impl FnOnce(&Schema<'_>, &Parsed<'_>) -> R) -> R {
    let Some(offset) = completing else { return f(&schema::build(ctx, &ctx.parsed), &ctx.parsed) };
    let arena = LocalArena::new();
    let full = Parsed::new(&arena, &ctx.doc.path, &ctx.doc.text);
    let schema = schema::build(ctx, &full);
    if schema.owner(offset).is_some() {
        return f(&schema, &full);
    }
    f(&schema::build(ctx, &ctx.parsed), &ctx.parsed)
}

fn is_getter(schema: &Schema<'_>, var: &str) -> bool {
    var == "$get" || schema.getters.contains(var)
}

fn is_setter(schema: &Schema<'_>, var: &str) -> bool {
    var == "$set" || schema.setters.contains(var)
}

/// Whether a string argument is the path of a `$get()`, `$get->string()`, or `$set()` call.
pub fn state_call(ctx: &Ctx<'_>, parsed: &Parsed<'_>, schema: &Schema<'_>, arg: &StringArg) -> Option<StateCall> {
    if arg.index != 0 || arg.in_array.is_some() {
        return None;
    }
    let (set, absolute_at) = match arg.call.kind {
        CallKind::Closure if is_getter(schema, &arg.call.name) => (false, 1),
        CallKind::Closure if is_setter(schema, &arg.call.name) => (true, 2),
        CallKind::Method if GET_METHODS.contains(&arg.call.name.as_str()) => {
            let receiver: String =
                ctx.doc.text[arg.call.span.0 as usize..].chars().take_while(|c| *c == '$' || c.is_alphanumeric() || *c == '_').collect();
            if !is_getter(schema, &receiver) {
                return None;
            }
            (
                false,
                match arg.call.name.as_str() {
                    "filled" | "blank" => 1,
                    "enum" => 3,
                    _ => 2,
                },
            )
        }
        _ => return None,
    };
    let absolute_flag = absolute_flag(parsed, arg, absolute_at);
    Some(StateCall { set, absolute: absolute_flag || arg.value.starts_with('/'), absolute_flag })
}

/// The variable a state call is on: `$get` in `$get('…')` and `$get->string('…')`.
fn variable(ctx: &Ctx<'_>, arg: &StringArg) -> String {
    match arg.call.kind {
        CallKind::Closure => arg.call.name.clone(),
        _ => ctx.doc.text[arg.call.span.0 as usize..].chars().take_while(|c| *c == '$' || c.is_alphanumeric() || *c == '_').collect(),
    }
}

/// The component whose `$get` a state call uses: the one passing the closure that declares the variable.
/// An arrow function sees its parent's variables, and a closure its `use`d ones, so a `$get` from an outer
/// closure, such as a `->schema(function (Get $get) {...})`, belongs to that closure's component.
fn owner_of<'s, 'a>(ctx: &Ctx<'_>, schema: &'s Schema<'a>, arg: &StringArg) -> Option<&'s Comp<'a>> {
    let var = variable(ctx, arg);
    let declares = |list: &mago_syntax::cst::FunctionLikeParameterList<'_>| list.parameters.iter().any(|p| p.variable.name == var.as_bytes());
    let uses =
        |c: &mago_syntax::cst::Closure<'_>| c.use_clause.as_ref().is_some_and(|u| u.variables.iter().any(|v| v.variable.name == var.as_bytes()));
    for node in ctx.parsed.path_at(arg.start).iter().rev() {
        match node {
            Node::ArrowFunction(f) if declares(&f.parameter_list) => return schema.owner(f.span().start.offset),
            Node::Closure(c) if declares(&c.parameter_list) => return schema.owner(c.span().start.offset),
            Node::Closure(c) if !uses(c) => return None,
            Node::Function(_) | Node::Method(_) | Node::PropertyHook(_) => return None,
            _ => {}
        }
    }
    None
}

/// Whether the call passes `true` for `isAbsolute`, by name or at position `at`.
fn absolute_flag(parsed: &Parsed<'_>, arg: &StringArg, at: usize) -> bool {
    let path = parsed.path_at(arg.start);
    let list = path.iter().rev().find_map(|n| match n {
        Node::FunctionCall(c) => Some(&c.argument_list),
        Node::MethodCall(c) => Some(&c.argument_list),
        _ => None,
    });
    let Some(list) = list else { return false };
    list.arguments.iter().enumerate().any(|(i, a)| match a {
        Argument::Positional(p) => i == at && matches!(p.value, Expression::Literal(Literal::True(_))),
        Argument::Named(n) => n.name.value == b"isAbsolute" && matches!(n.value, Expression::Literal(Literal::True(_))),
    })
}

/// A field's label: its `->label('…')`, or Filament's default from its name.
fn label(ctx: &Ctx<'_>, comp: &Comp<'_>) -> String {
    let text = &ctx.doc.text;
    let explicit = comp.chain.iter().find_map(|c| {
        if &text[c.method.span().start.offset as usize..c.method.span().end.offset as usize] != "label" {
            return None;
        }
        let Some(Argument::Positional(p)) = c.argument_list.arguments.iter().next() else {
            return None;
        };
        let Expression::Literal(Literal::String(s)) = p.value else {
            return None;
        };
        text.get(s.span.start.offset as usize + 1..s.span.end.offset as usize - 1).map(String::from)
    });
    explicit.unwrap_or_else(|| default_label(comp.name.as_ref().map(|n| n.0.as_str()).unwrap_or_default()))
}

/// The field's enum: from `->options(X::class)` or `->enum(X::class)`, or else, for a field of the form
/// itself, the model's cast. Whether it came from the field: Filament 4 then gives the state as a case.
pub fn field_enum(ctx: &Ctx<'_>, comp: &Comp<'_>) -> Option<(String, bool)> {
    if let Some(class) = super::chain_class(ctx, &comp.chain) {
        return super::known_enum(ctx, &class).map(|e| (e, true));
    }
    if !comp.container.is_empty() {
        return None;
    }
    let (name, ..) = comp.name.as_ref()?;
    super::known_enum(ctx, context(ctx)?["model"]["casts"][name].as_str()?).map(|e| (e, false))
}

/// Whether the project's Filament casts enum fields' state to cases (4 and later).
fn casts_enums(ctx: &Ctx<'_>) -> bool {
    let state = &ctx.snap.framework;
    let root = state.root().to_path_buf();
    state.remember("filament:v4", &["composer.lock"], || Value::Bool(root.join("vendor/filament/schemas").is_dir())).as_bool() == Some(true)
}

/// The model whose relationships a field at the top of a form uses, for `->relationship()` options: the one a
/// Livewire form names with `->model()`, or the record's, in a resource's form or a relation manager's.
pub fn form_model(ctx: &Ctx<'_>, schema: &Schema<'_>, comp: &Comp<'_>) -> Option<String> {
    let root = &schema.roots[comp.root];
    if !comp.container.is_empty() {
        return None;
    }
    if let Some(model) = &root.model {
        return Some(model.clone());
    }
    if root.fill != Fill::Record {
        return None;
    }
    context(ctx)?["model"]["class"].as_str().map(String::from)
}

/// The field's options from the database, once they've been read; see [`super::query_options`].
fn query_options(ctx: &Ctx<'_>, schema: &Schema<'_>, comp: &Comp<'_>, fresh: std::time::Duration) -> Option<(Vec<super::OptionValue>, bool)> {
    let text = &ctx.doc.text;
    let related = comp.chain.iter().any(|c| &text[c.method.span().start.offset as usize..c.method.span().end.offset as usize] == "relationship");
    let model = if related { form_model(ctx, schema, comp) } else { None };
    super::query_options(ctx, &comp.chain, model.as_deref(), fresh)
}

/// A short description of a field's options, if it has any.
fn options(ctx: &Ctx<'_>, schema: &Schema<'_>, comp: &Comp<'_>) -> Option<String> {
    let text = &ctx.doc.text;
    let list = |values: Vec<String>| {
        let more = values.len().saturating_sub(8);
        let mut out = values.into_iter().take(8).collect::<Vec<_>>().join(", ");
        if more > 0 {
            out.push_str(&format!(", and {more} more"));
        }
        out
    };
    if let Some((class, _)) = field_enum(ctx, comp) {
        let cases = enum_cases(ctx, &class)?;
        let short = class.rsplit('\\').next().unwrap_or(&class);
        return Some(format!(
            "Options: `{short}` ({})",
            list(cases.into_iter().map(|(name, value)| value.map_or(name, |v| format!("`{v}`"))).collect())
        ));
    }
    if let Some(found) = super::literal_options(ctx, &comp.chain) {
        return Some(format!(
            "Options: {}",
            list(found.into_iter().map(|(k, v)| format!("`{k}` {}", v.unwrap_or_default()).trim_end().to_string()).collect())
        ));
    }
    if let Some((found, more)) = query_options(ctx, schema, comp, super::OPTIONS_FRESH) {
        if found.is_empty() {
            return Some("Options from the database: none".into());
        }
        let mut shown = list(found.into_iter().map(|o| format!("`{}` {}", o.php, o.label.unwrap_or_default()).trim_end().to_string()).collect());
        if more && !shown.contains(", and ") {
            shown.push_str(", and more");
        }
        return Some(format!("Options from the database: {shown}"));
    }
    for c in &comp.chain {
        let method = &text[c.method.span().start.offset as usize..c.method.span().end.offset as usize];
        let args = &text[c.argument_list.left_parenthesis.end.offset as usize..c.argument_list.right_parenthesis.start.offset as usize];
        let args = args.split_whitespace().collect::<Vec<_>>().join(" ");
        match method {
            "relationship" => return Some(format!("Options from the relationship: `{args}`")),
            "options" if args.len() <= 80 => return Some(format!("Options: `{args}`")),
            "options" => return Some("Options: from code".into()),
            _ => {}
        }
    }
    None
}

/// Markdown describing a field, for hover and completion.
fn describe(ctx: &Ctx<'_>, schema: &Schema<'_>, comp: &Comp<'_>) -> String {
    let text = &ctx.doc.text;
    let make = &text[comp.make.span().start.offset as usize..comp.make.span().end.offset as usize];
    let mut out = format!("```php\n<?php\n{make}\n```\n\n**{}** · {}", label(ctx, comp), comp.short_class());
    if let Some(path) = comp.path().filter(|p| p.len() > 1) {
        let shown: Vec<&str> = path.iter().map(|s| if s.starts_with('*') { "*" } else { s.as_str() }).collect();
        out.push_str(&format!(" · state path `{}`", shown.join(".")));
    }
    if let Some(o) = options(ctx, schema, comp) {
        out.push_str("\n\n");
        out.push_str(&o);
    }
    out
}

fn kind(comp: &Comp<'_>) -> CompletionItemKind {
    match comp.kind {
        Kind::Repeater | Kind::Builder => CompletionItemKind::STRUCT,
        _ => CompletionItemKind::FIELD,
    }
}

/// Completion of a `$get()` or `$set()` path: the fields the closure's schema reaches, nearest first.
pub fn completion(ctx: &Ctx<'_>, offset: u32, arg: &StringArg) -> Option<Vec<CompletionItem>> {
    let typed = ctx.doc.text.get(arg.start as usize..offset as usize)?.to_string();
    with_schema(ctx, Some(offset), |schema, full| {
        let call = state_call(ctx, full, schema, arg)?;
        let range = ctx.doc.range(arg.start, offset);
        let owner = owner_of(ctx, schema, arg);
        let candidates: Vec<(&Comp<'_>, String, usize)> = match owner {
            // An absolute path starts at the Livewire component: the root's state path, then each field's.
            Some(owner) if call.absolute => {
                let Some(state_path) = &schema.roots[owner.root].state_path else { return Some(vec![]) };
                let slash = if call.absolute_flag && !typed.starts_with('/') { "" } else { "/" };
                let prefix: String = state_path.iter().map(|s| format!("{s}.")).collect();
                schema.reachable(owner.root, &[]).into_iter().map(|(c, text, _)| (c, format!("{slash}{prefix}{text}"), 0)).collect()
            }
            Some(owner) => schema.reachable(owner.root, &owner.container),
            // Outside a schema, such as in a method that builds one closure: every field by its own name.
            None if call.absolute => return Some(vec![]),
            None => schema.comps.iter().filter_map(|c| Some((c, c.name.as_ref()?.0.clone(), 0))).collect(),
        };
        let mut candidates = candidates;
        candidates.sort_by_key(|(_, _, up)| *up);
        let mut seen = std::collections::HashSet::new();
        let items = candidates
            .into_iter()
            .enumerate()
            .filter(|(_, (_, text, _))| seen.insert(text.clone()))
            .map(|(order, (comp, text, up))| {
                let detail = format!("{} · {}", comp.short_class(), label(ctx, comp));
                let mut item = item(&text, kind(comp), &detail, range, Some(format!("{up}{order:05}")));
                // Typed without `../`, a field further up still matches by its name.
                item.filter_text = (!typed.contains('/') && !call.absolute).then(|| text.trim_start_matches("../").to_string());
                item.documentation =
                    Some(Documentation::MarkupContent(MarkupContent { kind: MarkupKind::Markdown, value: describe(ctx, schema, comp) }));
                item
            })
            .collect();
        Some(items)
    })
}

pub fn hover(ctx: &Ctx<'_>, offset: u32) -> Option<Hover> {
    let arg = string_arg_at(ctx, offset)?;
    let value = with_schema(ctx, None, |schema, _| {
        let call = state_call(ctx, &ctx.parsed, schema, &arg)?;
        let owner = owner_of(ctx, schema, &arg)?;
        match schema.resolve(owner.root, &owner.container, &arg.value, call.absolute) {
            Resolved::Path(p) => schema.fields_at(owner.root, &p).first().map(|comp| describe(ctx, schema, comp)),
            Resolved::Outside => {
                let property = arg.value.trim_start_matches("../").trim_start_matches('/');
                Some(match call.absolute {
                    true => format!("Reads `{property}` from the Livewire component: the path isn't in the form's state."),
                    false => format!("Reads `{property}` from the Livewire component: the path goes above the form's state."),
                })
            }
            Resolved::Absolute => None,
        }
    })?;
    Some(Hover {
        contents: HoverContents::Markup(MarkupContent { kind: MarkupKind::Markdown, value }),
        range: Some(ctx.doc.range(arg.start, arg.end)),
    })
}

pub fn definition(ctx: &Ctx<'_>, offset: u32) -> Vec<Location> {
    let Some(arg) = string_arg_at(ctx, offset) else {
        return vec![];
    };
    with_schema(ctx, None, |schema, _| {
        let Some(call) = state_call(ctx, &ctx.parsed, schema, &arg) else {
            return vec![];
        };
        let Some(owner) = owner_of(ctx, schema, &arg) else {
            return vec![];
        };
        let Resolved::Path(p) = schema.resolve(owner.root, &owner.container, &arg.value, call.absolute) else {
            return vec![];
        };
        schema
            .fields_at(owner.root, &p)
            .into_iter()
            .filter_map(|c| c.name.as_ref().map(|(_, start, end)| Location { uri: ctx.doc.uri.clone(), range: ctx.doc.range(*start, *end) }))
            .collect()
    })
}

/// Edits between two names, counting two swapped letters as one, for suggesting a field whose name is close
/// to a mistyped one.
fn distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut d = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    d[0] = (0..=b.len()).collect();
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            d[i][j] = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1);
            }
        }
    }
    d[a.len()][b.len()]
}

/// The paths to suggest for a missing one: the same name in a schema further up, or a sibling with a close
/// name.
fn suggestions(schema: &Schema<'_>, owner: &Comp<'_>, typed: &str) -> Vec<String> {
    let name = typed.rsplit(['.', '/']).next().unwrap_or(typed);
    let reachable = schema.reachable(owner.root, &owner.container);
    let mut out: Vec<String> =
        reachable.iter().filter(|(_, text, _)| text.rsplit(['.', '/']).next() == Some(name) && text != typed).map(|(_, t, _)| t.clone()).collect();
    if out.is_empty() {
        let limit = (typed.len() / 3).clamp(1, 2);
        let mut close: Vec<(usize, String)> = reachable.into_iter().map(|(_, t, _)| (distance(&t, typed), t)).filter(|(d, _)| *d <= limit).collect();
        close.sort();
        out = close.into_iter().map(|(_, t)| t).take(3).collect();
    }
    out.dedup();
    out
}

/// What a schema is called in a message.
fn schema_name(path: &[String]) -> String {
    match path {
        [] => "The form".into(),
        [.., repeater, item] if item == "*" => format!("An item of repeater `{repeater}`"),
        [.., block, data] if data == "data" && block.starts_with('*') => {
            format!("Block `{}`", &block[1..])
        }
        _ => format!("`{}`", path.iter().map(|s| if s.starts_with('*') { "*" } else { s.as_str() }).collect::<Vec<_>>().join(".")),
    }
}

/// Reads of fields that the schema surely doesn't have, and comparisons of an enum field's state, a case in
/// Filament 4, with a string.
pub fn diagnostics(ctx: &Ctx<'_>) -> Vec<Diagnostic> {
    if !active(ctx) || ctx.doc.language != "php" {
        return vec![];
    }
    let args = string_args(ctx);
    if !args.iter().any(|a| a.call.kind == CallKind::Closure || a.call.kind == CallKind::Method) {
        return vec![];
    }
    let schema = schema::build(ctx, &ctx.parsed);
    if schema.comps.is_empty() {
        return vec![];
    }
    // Start reading options from the database now, so that they're there when a comparison is completed;
    // completion and hover read them again when they're old.
    for comp in &schema.comps {
        query_options(ctx, &schema, comp, std::time::Duration::MAX);
    }
    let mut out = vec![];
    // The form's own fields come with the record's attributes, so a read of a column isn't missing.
    let mut attributes: Option<Vec<String>> = None;
    for arg in &args {
        let Some(call) = state_call(ctx, &ctx.parsed, &schema, arg) else {
            continue;
        };
        if call.set {
            continue;
        }
        let Some(owner) = owner_of(ctx, &schema, arg) else {
            continue;
        };
        let Resolved::Path(path) = schema.resolve(owner.root, &owner.container, &arg.value, call.absolute) else {
            continue;
        };
        if path.is_empty() || schema.known(owner.root, &path) {
            continue;
        }
        let parent = &path[..path.len() - 1];
        let name = &path[path.len() - 1];
        let attributes_ok = if parent.is_empty() {
            let attributes = attributes.get_or_insert_with(|| model_attributes(ctx));
            !attributes.is_empty() && !attributes.contains(name)
        } else if let Some(relationship) = schema.relationship(owner.root, parent) {
            let attributes = related_attributes(ctx, relationship);
            !attributes.is_empty() && !attributes.contains(name)
        } else {
            false
        };
        if !schema.certain(owner.root, parent, attributes_ok) {
            continue;
        }
        let suggestions = suggestions(&schema, owner, &arg.value);
        let mut message = format!("{} has no field `{name}`.", schema_name(parent));
        match suggestions.as_slice() {
            [] => {}
            [one] => message.push_str(&format!(" Did you mean `{one}`?")),
            more => message.push_str(&format!(" Did you mean {}?", more.iter().map(|s| format!("`{s}`")).collect::<Vec<_>>().join(" or "))),
        }
        out.push(Diagnostic {
            range: ctx.doc.range(arg.start, arg.end),
            severity: Some(DiagnosticSeverity::WARNING),
            code: Some(NumberOrString::String("filament-state".into())),
            source: Some("filament".into()),
            message,
            data: Some(json!({ "replace": suggestions })),
            ..Default::default()
        });
    }
    if casts_enums(ctx) {
        out.extend(enum_comparisons(ctx, &schema));
    }
    out
}

/// The model's columns, relationships, and casts, which a resource's form state holds. Nothing when the
/// columns are only a guess, because the database couldn't be read.
fn model_attributes(ctx: &Ctx<'_>) -> Vec<String> {
    let Some(context) = context(ctx) else {
        return vec![];
    };
    let model = &context["model"];
    if model["columnsGuessed"] == true {
        return vec![];
    }
    let mut out = super::strings(&model["columns"]);
    out.extend(model["relations"].as_array().into_iter().flatten().filter_map(|r| r["name"].as_str().or_else(|| r.as_str()).map(String::from)));
    out.extend(model["casts"].as_object().into_iter().flatten().map(|(k, _)| k.clone()));
    out
}

/// The keys a related record's `attributesToArray()` gives a relationship's schema: the related model's
/// columns, casts, and appended attributes. Nothing unless the database told the columns.
fn related_attributes(ctx: &Ctx<'_>, relationship: &str) -> Vec<String> {
    let Some(context) = context(ctx) else {
        return vec![];
    };
    let Some(r) = super::relation(&context["model"], relationship) else {
        return vec![];
    };
    if r["columnsGuessed"] != false {
        return vec![];
    }
    let mut out = super::strings(&r["columns"]);
    out.extend(super::strings(&r["appends"]));
    out.extend(r["casts"].as_object().into_iter().flatten().map(|(k, _)| k.clone()));
    out
}

/// The field a `$get('…')` expression reads, and the offset inside its path.
fn read_of(ctx: &Ctx<'_>, schema: &Schema<'_>, expr: &Expression<'_>) -> Option<u32> {
    let (var, list) = match expr {
        Expression::Call(Call::Function(f)) => (f.function, &f.argument_list),
        Expression::Call(Call::Method(m)) => {
            let name = &ctx.doc.text[m.method.span().start.offset as usize..m.method.span().end.offset as usize];
            if !GET_METHODS.contains(&name) {
                return None;
            }
            (m.object, &m.argument_list)
        }
        Expression::Parenthesized(p) => return read_of(ctx, schema, p.expression),
        _ => return None,
    };
    let Expression::Variable(v) = var else {
        return None;
    };
    if !is_getter(schema, &ctx.doc.text[v.span().start.offset as usize..v.span().end.offset as usize]) {
        return None;
    }
    let Some(Argument::Positional(p)) = list.arguments.iter().next() else {
        return None;
    };
    let Expression::Literal(Literal::String(s)) = p.value else {
        return None;
    };
    Some(s.span.start.offset + 1)
}

/// The field a read at `offset` resolves to.
fn read_field<'s, 'a>(ctx: &Ctx<'_>, schema: &'s Schema<'a>, at: u32) -> Option<&'s Comp<'a>> {
    let arg = string_arg_at(ctx, at)?;
    let call = state_call(ctx, &ctx.parsed, schema, &arg)?;
    let owner = owner_of(ctx, schema, &arg)?;
    let Resolved::Path(p) = schema.resolve(owner.root, &owner.container, &arg.value, call.absolute) else {
        return None;
    };
    schema.fields_at(owner.root, &p).into_iter().next()
}

/// `$get('status') === 'draft'` on a field that casts its state to an enum's case is never true.
fn enum_comparisons(ctx: &Ctx<'_>, schema: &Schema<'_>) -> Vec<Diagnostic> {
    let mut out = vec![];
    walk(&ctx.parsed, |node, _| {
        let Node::Binary(b) = node else { return };
        if !b.operator.is_equality() {
            return;
        }
        let (read, other) = match (read_of(ctx, schema, b.lhs), read_of(ctx, schema, b.rhs)) {
            (Some(at), None) => (at, b.rhs),
            (None, Some(at)) => (at, b.lhs),
            _ => return,
        };
        let Expression::Literal(Literal::String(s)) = other else {
            return;
        };
        let Some(field) = read_field(ctx, schema, read) else {
            return;
        };
        let Some((class, true)) = field_enum(ctx, field) else {
            return;
        };
        let value = &ctx.doc.text[s.span.start.offset as usize + 1..s.span.end.offset as usize - 1];
        let case = enum_cases(ctx, &class).and_then(|cases| cases.into_iter().find(|(_, v)| v.as_deref() == Some(value)).map(|(name, _)| name));
        let reference = class_reference(ctx, s.span.start.offset, &class);
        let short = class.rsplit('\\').next().unwrap_or(&class);
        let fix = case.as_ref().map(|c| format!("{reference}::{c}"));
        let mut message = format!("This field's state is a `{short}` case, not a string, so this comparison is never true.");
        if let Some(fix) = &fix {
            message.push_str(&format!(" Compare with `{fix}`."));
        }
        out.push(Diagnostic {
            range: ctx.doc.range(s.span.start.offset, s.span.end.offset),
            severity: Some(DiagnosticSeverity::WARNING),
            code: Some(NumberOrString::String("filament-enum-state".into())),
            source: Some("filament".into()),
            message,
            data: Some(json!({ "replace": fix.into_iter().collect::<Vec<_>>() })),
            ..Default::default()
        });
    });
    out
}

fn overlaps(a: &Range, b: &Range) -> bool {
    a.start <= b.end && b.start <= a.end
}

/// Quick fixes for the problems above: write the suggested path or case.
pub fn code_actions(ctx: &Ctx<'_>, range: Range) -> Vec<CodeAction> {
    let mut out = vec![];
    for d in diagnostics(ctx).into_iter().filter(|d| overlaps(&d.range, &range)) {
        let replacements: Vec<String> = d.data.as_ref().and_then(|v| serde_json::from_value(v["replace"].clone()).ok()).unwrap_or_default();
        for (i, text) in replacements.into_iter().enumerate() {
            let Some(edit) = crate::features::actions::file_edit(ctx, vec![TextEdit { range: d.range, new_text: text.clone() }]) else {
                continue;
            };
            out.push(CodeAction {
                title: format!("Change to {text}"),
                kind: Some(CodeActionKind::QUICKFIX),
                diagnostics: Some(vec![d.clone()]),
                is_preferred: (i == 0).then_some(true),
                edit: Some(edit),
                ..Default::default()
            });
        }
    }
    out
}

/// The `$get()` read that the value at `offset` is compared with: `=== '…'`, `!= …`, a `match` arm's
/// condition, or `in_array($get('…'), ['…'])`. Returns the offset inside the read's path.
fn compared_read(ctx: &Ctx<'_>, schema: &Schema<'_>, parsed: &Parsed<'_>, offset: u32) -> Option<u32> {
    let path = parsed.path_at(offset);
    let inside = |e: &Expression<'_>| e.span().start.offset <= offset && offset <= e.span().end.offset;
    for (i, node) in path.iter().enumerate().rev() {
        match node {
            Node::Binary(b) if b.operator.is_equality() => {
                let other = if inside(b.rhs) { b.lhs } else { b.rhs };
                return read_of(ctx, schema, other);
            }
            // In an arm's condition, or between arms, where a new arm starts.
            Node::Match(m) => {
                let in_body = path[i..].iter().any(|n| match n {
                    Node::MatchExpressionArm(arm) => offset > arm.arrow.start.offset,
                    Node::MatchDefaultArm(_) => true,
                    _ => false,
                });
                let in_braces = m.left_brace.end.offset <= offset && offset <= m.right_brace.start.offset;
                return if in_braces && !in_body { read_of(ctx, schema, m.expression) } else { None };
            }
            Node::FunctionCall(c) => {
                let Expression::Identifier(id) = c.function else {
                    return None;
                };
                let mut args = c.argument_list.arguments.iter();
                let (Some(Argument::Positional(first)), Some(Argument::Positional(second))) = (args.next(), args.next()) else {
                    return None;
                };
                return (id.value().eq_ignore_ascii_case(b"in_array") && inside(second.value)).then(|| read_of(ctx, schema, first.value)).flatten();
            }
            Node::Statement(_) | Node::Closure(_) | Node::ArrowFunction(_) | Node::MethodCall(_) | Node::StaticMethodCall(_) => return None,
            _ => {}
        }
    }
    None
}

/// Completion of the values a field's state is compared with: an option's key or an enum's value in a
/// string, or a case of the enum Filament 4 casts the state to outside one.
pub fn value_completion(ctx: &Ctx<'_>, offset: u32) -> Option<Vec<CompletionItem>> {
    // Most completions aren't of a compared value: skip the parse below unless a read is close before.
    let before = &ctx.doc.text[..offset as usize];
    if !before[before.floor_char_boundary(before.len().saturating_sub(400))..].contains("get") {
        return None;
    }
    // The cursor's parse can end inside the comparison, as in an unfinished `match`, so the whole text's
    // parse comes first.
    with_schema(ctx, Some(offset), |schema, full| {
        let read = compared_read(ctx, schema, full, offset).or_else(|| compared_read(ctx, schema, &ctx.parsed, offset))?;
        let field = read_field(ctx, schema, read)?;
        let text = &ctx.doc.text;
        let quoted = full.path_at(offset).iter().rev().find_map(|n| match n {
            Node::LiteralString(s) if s.span.start.offset < offset && offset < s.span.end.offset => Some(s.span.start.offset + 1),
            _ => None,
        });
        let start = quoted.unwrap_or_else(|| {
            let before = &text[..offset as usize];
            (before.len()
                - before.chars().rev().take_while(|c| c.is_alphanumeric() || matches!(c, '_' | '\\' | ':')).map(char::len_utf8).sum::<usize>())
                as u32
        });
        let range = ctx.doc.range(start, offset);
        let detail = |extra: &str| format!("{} · {extra}", label(ctx, field));
        if let Some((class, cast)) = field_enum(ctx, field) {
            let cases = enum_cases(ctx, &class)?;
            let cast = cast && casts_enums(ctx);
            return Some(match (quoted.is_some(), cast) {
                (false, true) => {
                    let reference = class_reference(ctx, offset, &class);
                    cases
                        .into_iter()
                        .map(|(name, value)| {
                            item(
                                &format!("{reference}::{name}"),
                                CompletionItemKind::ENUM_MEMBER,
                                &detail(&value.map_or("case".into(), |v| format!("= {v}"))),
                                range,
                                None,
                            )
                        })
                        .collect()
                }
                (true, false) => cases
                    .into_iter()
                    .filter_map(|(name, value)| Some(item(&value?, CompletionItemKind::ENUM_MEMBER, &detail(&name), range, None)))
                    .collect(),
                _ => vec![],
            });
        }
        if let Some(found) = super::literal_options(ctx, &field.chain) {
            quoted?;
            return Some(
                found
                    .into_iter()
                    .map(|(k, v)| item(&k, CompletionItemKind::ENUM_MEMBER, &detail(v.as_deref().unwrap_or("option")), range, None))
                    .collect(),
            );
        }
        let (found, more) = query_options(ctx, schema, field, super::OPTIONS_FRESH)?;
        Some(super::option_items(found, more, quoted.is_some(), range, |label| detail(label)))
    })
}

/// Whether a string argument is a state path, for the module's dispatch.
pub fn is_state_arg(arg: &StringArg) -> bool {
    arg.index == 0
        && arg.in_array.is_none()
        && match arg.call.kind {
            CallKind::Closure => true,
            CallKind::Method => GET_METHODS.contains(&arg.call.name.as_str()),
            _ => false,
        }
}
