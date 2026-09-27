//! Completion: members after `->` and `::`, variables in scope, class, function, and constant names with
//! automatic imports, keywords, and named arguments.

use lsp_types::{
    CompletionItem, CompletionItemKind, CompletionItemLabelDetails, CompletionList, CompletionParams, CompletionResponse,
    CompletionTextEdit, Documentation, InsertTextFormat, MarkupContent, MarkupKind, Range, TextEdit,
};
use mago_codex::metadata::CodebaseMetadata;
use mago_codex::metadata::class_like::ClassLikeMetadata;
use mago_codex::metadata::function_like::FunctionLikeMetadata;
use mago_codex::symbol::SymbolKind;
use mago_codex::visibility::Visibility;
use mago_names::kind::NameKind;
use mago_span::HasSpan;
use mago_syntax::cst::{Expression, Node};
use serde::{Deserialize, Serialize};

use super::hover::{docblock_before, docblock_markdown, signature};
use super::{Ctx, with_ctx_at};
use crate::imports::reference;
use crate::locate::{variable_scope, walk};
use crate::server::Snapshot;
use crate::types::display;

/// How many class, function, or constant names one response lists; typing more narrows it.
const NAME_LIMIT: usize = 150;

/// PHP's triggers, then Laravel's: a string's opening quote, a dotted key's `.`, a rule's `|`, and a Blade
/// directive's `@`.
pub const TRIGGERS: &[&str] = &["$", ">", ":", "\\", "'", "\"", ".", "|", "@"];

/// What `completionItem/resolve` needs to find an item's documentation.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "k")]
enum Data {
    Class { name: String },
    Function { name: String },
    Method { class: String, name: String },
    Property { class: String, name: String },
    Constant { class: String, name: String },
}

pub fn completion(snap: &Snapshot, params: CompletionParams) -> Result<Option<CompletionResponse>, String> {
    let at = params.text_document_position;
    let result = with_ctx_at(snap, &at.text_document.uri, at.position, |ctx| complete(ctx, ctx.offset(at.position))).flatten();
    Ok(result.map(|(items, incomplete)| CompletionResponse::List(CompletionList { is_incomplete: incomplete, items })))
}

fn is_name_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '\\' || !c.is_ascii()
}

/// The completions at `offset`, and whether typing more could bring others.
fn complete(ctx: &Ctx<'_>, offset: u32) -> Option<(Vec<CompletionItem>, bool)> {
    let text = &ctx.doc.text;
    let offset = offset as usize;
    let before = &text[..offset];
    // A Blade view isn't PHP; only the framework completes in it.
    if ctx.doc.language == "blade" || ctx.doc.path.to_string_lossy().ends_with(".blade.php") {
        return crate::framework::completion(ctx, offset as u32).map(|items| (items, false));
    }
    if in_string(ctx, offset as u32) {
        return crate::framework::completion(ctx, offset as u32).map(|items| (items, false));
    }
    if in_comment(ctx, offset as u32) {
        return None;
    }
    let word_start = before.len() - before.chars().rev().take_while(|c| is_name_char(*c)).map(char::len_utf8).sum::<usize>();
    let word = &before[word_start..];
    let range = Range { start: ctx.doc.position(word_start as u32), end: ctx.doc.position(offset as u32) };
    let lead = &before[..word_start];

    if lead.ends_with('$') {
        let range = Range { start: ctx.doc.position(word_start as u32 - 1), end: range.end };
        return Some((variables(ctx, offset as u32, word, range), false));
    }
    if lead.ends_with("->") {
        return Some((members(ctx, word_start as u32, word, range, false), false));
    }
    if lead.ends_with("::") {
        return Some((members(ctx, word_start as u32, word, range, true), false));
    }
    // A lone `:` or `>` trigger outside `::` and `->` completes nothing.
    if word.is_empty() && (lead.ends_with(':') || lead.ends_with('>')) {
        return None;
    }
    if word.is_empty() && !lead.ends_with('\\') {
        // Only named arguments are worth offering before anything is typed.
        let items = named_arguments(ctx, offset as u32, "", range);
        return (!items.is_empty()).then_some((items, false));
    }
    Some((names(ctx, word_start as u32, word, range), true))
}

/// Whether `offset` is inside a comment, where code completion doesn't apply.
fn in_comment(ctx: &Ctx<'_>, offset: u32) -> bool {
    ctx.parsed.program.trivia.iter().any(|t| {
        let s = t.span();
        t.kind.is_comment() && s.start.offset < offset && offset <= s.end.offset
    })
}

/// Whether `offset` is inside a string, where only the framework's completions apply.
fn in_string(ctx: &Ctx<'_>, offset: u32) -> bool {
    ctx.parsed.path_at(offset).iter().any(|n| match n {
        Node::LiteralString(s) => s.span().start.offset < offset && offset < s.span().end.offset,
        _ => false,
    })
}

fn item(label: &str, kind: CompletionItemKind, detail: Option<String>, range: Range) -> CompletionItem {
    CompletionItem {
        label: label.to_string(),
        kind: Some(kind),
        detail,
        text_edit: Some(CompletionTextEdit::Edit(TextEdit { range, new_text: label.to_string() })),
        ..Default::default()
    }
}

/// Whether a member declared in `declaring` with `visibility` is reachable from code in `from`.
fn visible(codebase: &CodebaseMetadata, visibility: Visibility, declaring: &str, from: Option<&str>) -> bool {
    match visibility {
        Visibility::Public => true,
        Visibility::Protected => from.is_some_and(|f| {
            f.eq_ignore_ascii_case(declaring) || codebase.class_extends(f.as_bytes(), declaring.as_bytes()) || codebase.class_extends(declaring.as_bytes(), f.as_bytes())
        }),
        Visibility::Private => from.is_some_and(|f| f.eq_ignore_ascii_case(declaring)),
    }
}

fn method_item(m: &FunctionLikeMetadata, class: &str, range: Range, ctx: &Ctx<'_>) -> CompletionItem {
    let name = m.original_name.as_str_lossy().into_owned();
    let label_detail = method_signature(ctx, m);
    let has_params = !m.parameters.is_empty();
    CompletionItem {
        label: name.clone(),
        kind: Some(if m.method_metadata.as_ref().is_some_and(|mm| mm.is_constructor) { CompletionItemKind::CONSTRUCTOR } else { CompletionItemKind::METHOD }),
        label_details: Some(CompletionItemLabelDetails { detail: Some(label_detail.params), description: label_detail.returns.clone() }),
        detail: label_detail.returns,
        filter_text: Some(name.clone()),
        insert_text_format: Some(InsertTextFormat::SNIPPET),
        text_edit: Some(CompletionTextEdit::Edit(TextEdit {
            range,
            new_text: if has_params { format!("{name}($0)") } else { format!("{name}()") },
        })),
        data: serde_json::to_value(Data::Method { class: class.to_string(), name }).ok(),
        ..Default::default()
    }
}

struct Signature {
    params: String,
    returns: Option<String>,
}

/// A function's parameter list and return type for display, from metadata so it costs no file reads.
fn method_signature(_ctx: &Ctx<'_>, m: &FunctionLikeMetadata) -> Signature {
    let params: Vec<String> = m
        .parameters
        .iter()
        .map(|p| {
            let mut s = String::new();
            if let Some(t) = p.type_declaration_metadata.as_ref().or(p.type_metadata.as_ref()) {
                s.push_str(&display(&t.type_union));
                s.push(' ');
            }
            if p.flags.is_variadic() {
                s.push_str("...");
            }
            s.push_str(&p.get_name().0.as_str_lossy());
            if p.flags.has_default() {
                s.push_str(" = …");
            }
            s
        })
        .collect();
    Signature {
        params: format!("({})", params.join(", ")),
        returns: m.return_type_metadata.as_ref().map(|t| display(&t.type_union)),
    }
}

/// Members of the classes the expression before `->` or `::` can be.
fn members(ctx: &Ctx<'_>, word_start: u32, _word: &str, range: Range, is_static: bool) -> Vec<CompletionItem> {
    let path = ctx.parsed.path_at(word_start);
    let resolver = ctx.resolver();
    let enclosing = resolver.enclosing_class(&path);
    // The access node whose `->` or `::` ends where the word starts.
    let mut classes = vec![];
    let mut through_this_or_self = false;
    for node in path.iter().rev() {
        let (object, sep_end, statically): (&Expression<'_>, u32, bool) = match node {
            Node::PropertyAccess(a) => (a.object, a.arrow.end.offset, false),
            Node::NullSafePropertyAccess(a) => (a.object, a.question_mark_arrow.end.offset, false),
            Node::MethodCall(c) => (c.object, c.arrow.end.offset, false),
            Node::NullSafeMethodCall(c) => (c.object, c.question_mark_arrow.end.offset, false),
            Node::StaticMethodCall(c) => (c.class, c.double_colon.end.offset, true),
            Node::StaticPropertyAccess(a) => (a.class, a.double_colon.end.offset, true),
            Node::ClassConstantAccess(a) => (a.class, a.double_colon.end.offset, true),
            _ => continue,
        };
        if sep_end != word_start {
            continue;
        }
        through_this_or_self = matches!(object, Expression::Self_(_) | Expression::Static(_) | Expression::Parent(_))
            || matches!(object, Expression::Variable(mago_syntax::cst::Variable::Direct(v)) if v.name == b"$this");
        classes = if statically { resolver.classes_of_class_expr(object, &path) } else { resolver.classes_of(object) };
        break;
    }
    let codebase = &ctx.index.codebase;
    let mut out: Vec<CompletionItem> = vec![];
    let mut seen = std::collections::HashSet::new();
    for class in &classes {
        let Some(meta) = codebase.get_class_like(class.as_bytes()) else { continue };
        for (key, id) in meta.appearing_method_ids.iter() {
            let Some(m) = codebase.get_method_by_id(id) else { continue };
            let Some(mm) = m.method_metadata.as_ref() else { continue };
            // `->` lists every method (static ones can be called through an instance); `::` lists static
            // methods, and inside the class all of them, since `parent::method()` and `self::method()` work.
            if is_static && !mm.is_static && !through_this_or_self {
                continue;
            }
            let declaring = id.get_class_name().as_str_lossy().into_owned();
            if !visible(codebase, mm.visibility, &declaring, enclosing.as_deref()) {
                continue;
            }
            if seen.insert(("m", key.as_str_lossy().into_owned())) {
                out.push(method_item(m, class, range, ctx));
            }
        }
        let pseudo_methods = if is_static { &meta.static_pseudo_methods } else { &meta.pseudo_methods };
        for pseudo in pseudo_methods.iter() {
            if let Some(m) = codebase.get_method(class.as_bytes(), pseudo.as_bytes())
                && seen.insert(("m", pseudo.as_str_lossy().to_ascii_lowercase()))
            {
                out.push(method_item(m, class, range, ctx));
            }
        }
        properties(ctx, meta, class, is_static, enclosing.as_deref(), range, &mut seen, &mut out);
        if is_static {
            constants(ctx, meta, class, range, &mut seen, &mut out);
            if seen.insert(("k", "class".into())) {
                out.push(item("class", CompletionItemKind::KEYWORD, Some(format!("{class}::class")), range));
            }
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn properties(
    ctx: &Ctx<'_>,
    meta: &ClassLikeMetadata,
    class: &str,
    is_static: bool,
    enclosing: Option<&str>,
    range: Range,
    seen: &mut std::collections::HashSet<(&'static str, String)>,
    out: &mut Vec<CompletionItem>,
) {
    let codebase = &ctx.index.codebase;
    let declared = meta.appearing_property_ids.iter().map(|(n, c)| (*n, *c, false));
    let magic = meta.magic_property_ids.iter().map(|(n, c)| (*n, *c, true));
    for (name, declaring, is_magic) in declared.chain(magic) {
        let declaring_name = declaring.as_str_lossy().into_owned();
        let p = if is_magic {
            codebase.get_magic_property(declaring.as_bytes(), name.as_bytes())
        } else {
            codebase.get_property(declaring.as_bytes(), name.as_bytes())
        };
        let Some(p) = p else { continue };
        if p.flags.is_static() != is_static {
            continue;
        }
        if !visible(codebase, p.read_visibility, &declaring_name, enclosing) {
            continue;
        }
        let bare = name.as_str_lossy().trim_start_matches('$').to_string();
        let label = if is_static { format!("${bare}") } else { bare.clone() };
        if !seen.insert(("p", label.clone())) {
            continue;
        }
        let ty = p.type_metadata.as_ref().map(|t| display(&t.type_union));
        let mut it = item(&label, CompletionItemKind::PROPERTY, ty.clone(), range);
        it.label_details = Some(CompletionItemLabelDetails { detail: None, description: ty });
        it.data = serde_json::to_value(Data::Property { class: class.to_string(), name: bare }).ok();
        out.push(it);
    }
}

fn constants(
    ctx: &Ctx<'_>,
    meta: &ClassLikeMetadata,
    class: &str,
    range: Range,
    seen: &mut std::collections::HashSet<(&'static str, String)>,
    out: &mut Vec<CompletionItem>,
) {
    let codebase = &ctx.index.codebase;
    for (name, case) in meta.enum_cases.iter() {
        let name = name.as_str_lossy().into_owned();
        if seen.insert(("c", name.clone())) {
            let detail = case.value_type.as_ref().map(|t| t.get_id().to_string());
            let mut it = item(&name, CompletionItemKind::ENUM_MEMBER, detail, range);
            it.data = serde_json::to_value(Data::Constant { class: class.to_string(), name }).ok();
            out.push(it);
        }
    }
    let ancestors = std::iter::once(meta.name).chain(codebase.get_class_ancestors(class.as_bytes()));
    for owner in ancestors {
        let Some(owner_meta) = codebase.get_class_like(owner.as_bytes()) else { continue };
        for (name, c) in owner_meta.constants.iter() {
            let name = name.as_str_lossy().into_owned();
            if !seen.insert(("c", name.clone())) {
                continue;
            }
            let detail = c.inferred_type.as_ref().map(|t| t.get_id().to_string());
            let mut it = item(&name, CompletionItemKind::CONSTANT, detail, range);
            it.data = serde_json::to_value(Data::Constant { class: class.to_string(), name }).ok();
            out.push(it);
        }
    }
}

use mago_codex::ttype::TType;

/// Variables mentioned in the function around `offset` before it, and `$this` in methods.
fn variables(ctx: &Ctx<'_>, offset: u32, _word: &str, range: Range) -> Vec<CompletionItem> {
    let path = ctx.parsed.path_at(offset);
    let scope = variable_scope(&ctx.parsed, &path);
    let mut names: Vec<(String, u32, u32)> = vec![];
    walk(&ctx.parsed, |node, ancestors| {
        let Node::DirectVariable(v) = node else { return };
        if v.span.start.offset >= offset.saturating_sub(1) {
            return;
        }
        let mut chain = ancestors.to_vec();
        chain.push(node);
        if variable_scope(&ctx.parsed, &chain) != scope {
            return;
        }
        let name = String::from_utf8_lossy(v.name).into_owned();
        // The latest mention before the cursor has the most useful type.
        match names.iter_mut().find(|(n, _, _)| *n == name) {
            Some(entry) => *entry = (name, v.span.start.offset, v.span.end.offset),
            None => names.push((name, v.span.start.offset, v.span.end.offset)),
        }
    });
    let in_method = path.iter().any(|n| matches!(n, Node::Method(m) if !m.modifiers.iter().any(|m| m.is_static())))
        || path.iter().any(|n| matches!(n, Node::Closure(_) | Node::ArrowFunction(_))) && path.iter().any(|n| matches!(n, Node::Method(_)));
    if in_method && !names.iter().any(|(n, _, _)| n == "$this") {
        names.push(("$this".into(), 0, 0));
    }
    let mut items: Vec<CompletionItem> = names
        .into_iter()
        .map(|(name, s, e)| {
            let ty = if e > 0 { ctx.analysis().type_at(s, e).map(|t| display(&t)) } else { None };
            let mut it = item(&name, CompletionItemKind::VARIABLE, ty.clone(), range);
            it.label_details = Some(CompletionItemLabelDetails { detail: None, description: ty });
            it
        })
        .collect();
    for global in ["$_GET", "$_POST", "$_SERVER", "$_SESSION", "$_COOKIE", "$_FILES", "$_REQUEST", "$_ENV", "$GLOBALS"] {
        let mut it = item(global, CompletionItemKind::VARIABLE, Some("superglobal".into()), range);
        it.sort_text = Some(format!("~{global}"));
        items.push(it);
    }
    items
}

/// The parameters of the call whose parentheses hold `offset`, as `name:` items.
fn named_arguments(ctx: &Ctx<'_>, offset: u32, word: &str, range: Range) -> Vec<CompletionItem> {
    let Some(function) = super::signature::called_function(ctx, offset) else { return vec![] };
    function
        .parameters
        .iter()
        .map(|p| p.get_name().0.as_str_lossy().trim_start_matches('$').to_string())
        .filter(|n| n.to_ascii_lowercase().starts_with(&word.to_ascii_lowercase()))
        .map(|n| {
            let mut it = item(&format!("{n}:"), CompletionItemKind::FIELD, Some("named argument".into()), range);
            it.text_edit = Some(CompletionTextEdit::Edit(TextEdit { range, new_text: format!("{n}: ") }));
            it.sort_text = Some(format!("0{n}"));
            it
        })
        .collect()
}

const KEYWORDS: &[&str] = &[
    "abstract", "array", "break", "case", "catch", "class", "clone", "const", "continue", "declare", "default", "do",
    "echo", "else", "elseif", "empty", "enum", "extends", "false", "final", "finally", "fn", "for", "foreach",
    "function", "global", "if", "implements", "include", "include_once", "instanceof", "insteadof", "interface",
    "isset", "list", "match", "namespace", "new", "null", "parent", "print", "private", "protected", "public",
    "readonly", "require", "require_once", "return", "self", "static", "switch", "throw", "trait", "true", "try",
    "unset", "use", "while", "yield",
];

const TYPES: &[&str] = &["array", "bool", "callable", "false", "float", "int", "iterable", "mixed", "never", "null", "object", "self", "static", "string", "true", "void"];

/// Where a name is being typed, which decides what kinds of names fit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Place {
    /// After `new`: instantiable classes.
    New,
    /// A parameter, return, or property type.
    Type,
    /// A `use` import.
    Use,
    /// Anywhere else in code.
    Code,
}

fn place(ctx: &Ctx<'_>, word_start: u32) -> Place {
    let before = ctx.doc.text[..word_start as usize].trim_end();
    if before.ends_with("new") && !before[..before.len() - 3].ends_with(|c: char| c.is_alphanumeric() || c == '_' || c == '$') {
        return Place::New;
    }
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    let line = before[line_start..].trim_start();
    if line == "use" || (line.starts_with("use ") && !line.contains('(')) {
        return Place::Use;
    }
    for node in ctx.parsed.path_at(word_start).iter().rev() {
        match node {
            Node::Hint(_) => return Place::Type,
            Node::FunctionLikeReturnTypeHint(_) => return Place::Type,
            Node::Block(_) | Node::Statement(_) => break,
            _ => {}
        }
    }
    if before.ends_with(':') && !before.ends_with("::") && before.ends_with(')') {
        return Place::Type;
    }
    Place::Code
}

/// How well a candidate matches what's typed: lower is better, `None` for no match.
fn score(candidate: &str, typed: &str) -> Option<u8> {
    if typed.is_empty() {
        return Some(3);
    }
    let c = candidate.to_ascii_lowercase();
    let t = typed.to_ascii_lowercase();
    if c == t {
        return Some(0);
    }
    if c.starts_with(&t) {
        return Some(1);
    }
    // Camel-case humps or any subsequence, such as `UsCo` for `UserController`.
    let mut chars = c.chars();
    if t.chars().all(|tc| chars.any(|cc| cc == tc)) {
        return Some(2);
    }
    None
}

/// Class, function, constant, and keyword names that match `word`.
fn names(ctx: &Ctx<'_>, word_start: u32, word: &str, range: Range) -> Vec<CompletionItem> {
    let codebase = &ctx.index.codebase;
    let place = place(ctx, word_start);
    let qualified = word.contains('\\');
    let typed_short = word.rsplit('\\').next().unwrap_or(word);
    let mut out = vec![];

    if place == Place::Code {
        out.extend(named_arguments(ctx, word_start, word, range));
    }

    let mut classes: Vec<(u8, bool, &ClassLikeMetadata)> = vec![];
    for meta in codebase.class_likes.values() {
        if meta.name.as_str_lossy().starts_with("class@anonymous") {
            continue;
        }
        let fqn = meta.original_name.as_str_lossy();
        let s = if qualified {
            let typed = word.trim_start_matches('\\');
            fqn.to_ascii_lowercase().starts_with(&typed.to_ascii_lowercase()).then_some(1)
        } else {
            score(fqn.rsplit('\\').next().unwrap_or(&fqn), typed_short)
        };
        let Some(s) = s else { continue };
        if place == Place::New && (meta.kind != SymbolKind::Class || meta.flags.is_abstract()) {
            continue;
        }
        let project = meta.flags.is_user_defined();
        classes.push((s, !project, meta));
    }
    classes.sort_by(|a, b| (a.0, a.1, a.2.original_name.as_str_lossy().len()).cmp(&(b.0, b.1, b.2.original_name.as_str_lossy().len())));
    for (rank, (s, vendor, meta)) in classes.into_iter().take(NAME_LIMIT).enumerate() {
        let fqn = meta.original_name.as_str_lossy().into_owned();
        let kind = match meta.kind {
            SymbolKind::Interface => CompletionItemKind::INTERFACE,
            SymbolKind::Enum => CompletionItemKind::ENUM,
            SymbolKind::Trait => CompletionItemKind::STRUCT,
            _ => CompletionItemKind::CLASS,
        };
        let short = fqn.rsplit('\\').next().unwrap_or(&fqn).to_string();
        let mut it = item(&short, kind, Some(fqn.clone()), range);
        it.label_details = Some(CompletionItemLabelDetails { detail: None, description: Some(fqn.clone()) });
        it.sort_text = Some(format!("{s}{}{rank:04}", u8::from(vendor)));
        it.filter_text = Some(if qualified { fqn.clone() } else { short.clone() });
        if place == Place::Use || qualified {
            it.text_edit = Some(CompletionTextEdit::Edit(TextEdit { range, new_text: fqn.clone() }));
        } else {
            let r = reference(&ctx.doc, ctx.parsed.program, word_start, &fqn, NameKind::Default);
            it.text_edit = Some(CompletionTextEdit::Edit(TextEdit { range, new_text: r.name }));
            it.additional_text_edits = r.edit.map(|e| vec![e]);
        }
        it.data = serde_json::to_value(Data::Class { name: fqn }).ok();
        out.push(it);
    }
    if matches!(place, Place::New | Place::Use) {
        return out;
    }
    if place == Place::Type {
        for t in TYPES.iter().filter(|t| score(t, word).is_some()) {
            out.push(item(t, CompletionItemKind::KEYWORD, None, range));
        }
        return out;
    }

    let mut functions: Vec<(u8, bool, &FunctionLikeMetadata)> = codebase
        .function_likes
        .iter()
        .filter(|((class, _), f)| class.is_empty() && f.kind.is_function())
        .filter_map(|(_, f)| {
            let name = f.original_name.as_str_lossy();
            let short = name.rsplit('\\').next().unwrap_or(&name);
            score(short, typed_short).map(|s| (s, !f.flags.is_user_defined(), f))
        })
        .collect();
    functions.sort_by_key(|(s, vendor, f)| (*s, *vendor, f.original_name.as_str_lossy().len()));
    for (rank, (s, vendor, f)) in functions.into_iter().take(NAME_LIMIT).enumerate() {
        let fqn = f.original_name.as_str_lossy().into_owned();
        let r = reference(&ctx.doc, ctx.parsed.program, word_start, &fqn, NameKind::Function);
        let sig = method_signature(ctx, f);
        let has_params = !f.parameters.is_empty();
        out.push(CompletionItem {
            label: fqn.rsplit('\\').next().unwrap_or(&fqn).to_string(),
            kind: Some(CompletionItemKind::FUNCTION),
            label_details: Some(CompletionItemLabelDetails { detail: Some(sig.params), description: sig.returns.clone() }),
            detail: Some(fqn.clone()),
            sort_text: Some(format!("{s}{}{rank:04}", u8::from(vendor))),
            insert_text_format: Some(InsertTextFormat::SNIPPET),
            text_edit: Some(CompletionTextEdit::Edit(TextEdit {
                range,
                new_text: if has_params { format!("{}($0)", r.name) } else { format!("{}()", r.name) },
            })),
            additional_text_edits: r.edit.map(|e| vec![e]),
            data: serde_json::to_value(Data::Function { name: fqn }).ok(),
            ..Default::default()
        });
    }
    let mut constants: Vec<(u8, String)> = codebase
        .constants
        .values()
        .filter_map(|c| {
            let name = c.name.as_str_lossy().into_owned();
            let short = name.rsplit('\\').next().unwrap_or(&name).to_string();
            score(&short, typed_short).map(|s| (s, name))
        })
        .collect();
    constants.sort();
    for (s, name) in constants.into_iter().take(NAME_LIMIT / 3) {
        let short = name.rsplit('\\').next().unwrap_or(&name).to_string();
        let mut it = item(&short, CompletionItemKind::CONSTANT, Some(name.clone()), range);
        it.sort_text = Some(format!("{s}2{short}"));
        out.push(it);
    }
    for k in KEYWORDS.iter().filter(|k| score(k, word).is_some_and(|s| s <= 1)) {
        let mut it = item(k, CompletionItemKind::KEYWORD, None, range);
        it.sort_text = Some(format!("{}0{k}", score(k, word).unwrap()));
        out.push(it);
    }
    out
}

/// Adds documentation to an item.
pub fn resolve(snap: &Snapshot, mut item: CompletionItem) -> Result<CompletionItem, String> {
    let Some(data) = item.data.clone().and_then(|d| serde_json::from_value::<Data>(d).ok()) else { return Ok(item) };
    let index = snap.index.read();
    let codebase = &index.codebase;
    let span = match &data {
        Data::Class { name } => codebase.get_class_like(name.as_bytes()).map(|c| c.span),
        Data::Function { name } => codebase.get_function(name.as_bytes()).map(|f| f.span),
        Data::Method { class, name } => codebase.get_declaring_method(class.as_bytes(), name.as_bytes()).map(|m| m.span),
        Data::Property { class, name } => {
            codebase.get_declaring_property(class.as_bytes(), format!("${name}").as_bytes()).and_then(|p| p.span)
        }
        Data::Constant { class, name } => codebase
            .get_enum_case(class.as_bytes(), name.as_bytes())
            .map(|c| c.span)
            .or_else(|| codebase.get_class_constant(class.as_bytes(), name.as_bytes()).map(|c| c.span)),
    };
    let Some(span) = span else { return Ok(item) };
    let Some(text) = snap.text_of(&index, span.file_id) else { return Ok(item) };
    let start = span.start.offset as usize;
    let mut value = String::new();
    if matches!(data, Data::Method { .. } | Data::Function { .. } | Data::Class { .. }) {
        let end = (span.end.offset as usize).min(text.len());
        value.push_str(&format!("```php\n<?php\n{}\n```", signature(&text[start..end])));
    }
    if let Some(doc) = docblock_before(&text, start).map(|d| docblock_markdown(&d)).filter(|d| !d.is_empty()) {
        if !value.is_empty() {
            value.push_str("\n\n");
        }
        value.push_str(&doc);
    }
    if !value.is_empty() {
        item.documentation = Some(Documentation::MarkupContent(MarkupContent { kind: MarkupKind::Markdown, value }));
    }
    Ok(item)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fixture;

    fn complete_at(files: &[(&str, &str)]) -> Vec<CompletionItem> {
        let fx = Fixture::new(files);
        match completion(&fx.snap, CompletionParams {
            text_document_position: fx.at(),
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
            context: None,
        })
        .unwrap()
        {
            Some(CompletionResponse::List(l)) => l.items,
            _ => vec![],
        }
    }

    fn labels(items: &[CompletionItem]) -> Vec<String> {
        let mut l: Vec<_> = items.iter().map(|i| i.label.clone()).collect();
        l.sort();
        l
    }

    const LIB: &str = "<?php\nnamespace App\\Models;\n/** @property-read int $magic */\nclass Base {\n    public function save(array $o = []): bool { return true; }\n    protected function guard(): void {}\n    private function secret(): void {}\n    public static function create(): static { return new static; }\n    public static int $count = 0;\n}\nclass User extends Base {\n    const ROLE = 'admin';\n    public string $name = '';\n    private int $age = 0;\n    public function posts(): array { return []; }\n}\nenum Status: string { case Active = 'a'; case Gone = 'g'; }\nfunction helper(int $x): string { return ''; }\n";

    #[test]
    fn completes_members_that_are_visible_from_here() {
        let files = |t| [("lib.php", LIB), ("t.php", t)];
        let items = complete_at(&files("<?php\nfunction f(\\App\\Models\\User $u) {\n    $u-><|>\n}\n"));
        assert_eq!(labels(&items), vec!["create", "magic", "name", "posts", "save"]);
        let save = items.iter().find(|i| i.label == "save").unwrap();
        let Some(CompletionTextEdit::Edit(edit)) = &save.text_edit else { panic!() };
        assert_eq!(edit.new_text, "save($0)");

        // Inside the class, protected and private members show too.
        let items = complete_at(&[("t.php", &LIB.replace("return []; }", "return []; }\n    function g() { $this->p<|> }"))]);
        assert!(labels(&items).contains(&"age".to_string()));
        assert!(labels(&items).contains(&"guard".to_string()));
        assert!(!labels(&items).contains(&"secret".to_string()));
    }

    #[test]
    fn completes_static_members_constants_and_enum_cases() {
        let files = |t| [("lib.php", LIB), ("t.php", t)];
        let items = complete_at(&files("<?php\nuse App\\Models\\User;\nUser::<|>\n"));
        assert_eq!(labels(&items), vec!["$count", "ROLE", "class", "create"]);
        let items = complete_at(&files("<?php\n\\App\\Models\\Status::<|>\n"));
        // Backed enums have `cases()`, `from()`, and `tryFrom()`.
        assert_eq!(labels(&items), vec!["Active", "Gone", "cases", "class", "from", "tryFrom"]);
    }

    #[test]
    fn completes_variables_in_scope() {
        let items = complete_at(&[("t.php", "<?php\nfunction f(int $count) {\n    $total = $count * 2;\n    return $<|>\n}\nfunction g($other) {}\n")]);
        let own: Vec<_> = labels(&items).into_iter().filter(|l| !l.starts_with("$_") && l != "$GLOBALS").collect();
        assert_eq!(own, vec!["$count", "$total"]);
        let count = items.iter().find(|i| i.label == "$count").unwrap();
        assert_eq!(count.detail.as_deref(), Some("int"));
    }

    #[test]
    fn completes_class_names_with_an_import() {
        let files = |t| [("lib.php", LIB), ("t.php", t)];
        let items = complete_at(&files("<?php\nnamespace App\\Http;\n\nfunction f() {\n    new Use<|>\n}\n"));
        let user = items.iter().find(|i| i.label == "User").expect("User");
        let edit = &user.additional_text_edits.as_ref().unwrap()[0];
        assert_eq!(edit.new_text, "\nuse App\\Models\\User;\n");
        // `new` only offers classes that can be instantiated.
        assert!(!items.iter().any(|i| i.label == "Status"));

        let items = complete_at(&files("<?php\nnamespace App\\Models;\nfunction f() { hel<|> }\n"));
        let helper = items.iter().find(|i| i.label == "helper").expect("helper");
        assert!(helper.additional_text_edits.is_none());
        assert!(items.iter().any(|i| i.label == "HEADER" || i.kind == Some(CompletionItemKind::FUNCTION)));
    }

    #[test]
    fn completes_named_arguments_and_nothing_in_comments() {
        let files = |t| [("lib.php", LIB), ("t.php", t)];
        let items = complete_at(&files("<?php \\App\\Models\\helper(<|>);"));
        assert_eq!(labels(&items), vec!["x:"]);
        assert!(complete_at(&files("<?php // Use<|>\n")).is_empty());
        assert!(complete_at(&files("<?php $s = 'Use<|>';\n")).is_empty());
    }
}
