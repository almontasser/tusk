//! Actions that write members: implement abstract methods, override parent methods, complete or promote a
//! constructor, declare properties assigned without a declaration, and Generate's constructor, getters,
//! setters, and `__toString()`.

use lsp_types::{Range, TextEdit, WorkspaceEdit};
use mago_allocator::LocalArena;
use mago_codex::metadata::CodebaseMetadata;
use mago_codex::metadata::function_like::FunctionLikeMetadata;
use mago_codex::symbol::SymbolKind;
use mago_codex::ttype::atomic::TAtomic;
use mago_codex::ttype::atomic::scalar::TScalar;
use mago_codex::ttype::union::TUnion;
use mago_codex::visibility::Visibility;
use mago_names::kind::NameKind;
use mago_span::HasSpan;
use mago_syntax::cst::{
    ClassLikeMember, Expression, FunctionLikeParameter, Method, MethodBody, Node, Property, Sequence, Statement, Variable,
};
use serde_json::{Value, json};

use super::{Candidate, file_edit, indent_unit, line_indent};
use crate::analysis::Parsed;
use crate::features::Ctx;
use crate::features::hover::signature;
use crate::imports::{import_edits, reference};
use crate::types::display_class;

/// The class-like the cursor is in, with what the actions need to edit it.
pub struct ClassAt<'a> {
    pub fqn: String,
    pub kind: SymbolKind,
    pub members: &'a Sequence<'a, ClassLikeMember<'a>>,
    /// The offsets of the body's braces.
    pub open: u32,
    pub close: u32,
    /// The indentation of members.
    pub indent: String,
}

pub fn class_at<'a>(ctx: &Ctx<'a>, offset: u32) -> Option<ClassAt<'a>> {
    let path = ctx.parsed.path_at(offset);
    let text = ctx.parsed.text();
    for node in path.iter().rev() {
        let (name, members, open, close, kind) = match node {
            Node::Class(c) => (&c.name, &c.members, c.left_brace, c.right_brace, SymbolKind::Class),
            Node::Trait(c) => (&c.name, &c.members, c.left_brace, c.right_brace, SymbolKind::Trait),
            Node::Enum(c) => (&c.name, &c.members, c.left_brace, c.right_brace, SymbolKind::Enum),
            Node::Interface(c) => (&c.name, &c.members, c.left_brace, c.right_brace, SymbolKind::Interface),
            _ => continue,
        };
        let fqn = ctx.parsed.names.resolve(&name.span).map(|n| String::from_utf8_lossy(n).into_owned())?;
        let indent = match members.iter().next() {
            Some(m) => line_indent(text, m.span().start.offset as usize),
            None => format!("{}{}", line_indent(text, node.span().start.offset as usize), indent_unit(text)),
        };
        return Some(ClassAt { fqn, kind, members, open: open.end.offset, close: close.start.offset, indent });
    }
    None
}

/// An edit that adds `members` (each a block of lines, without trailing newlines) at the end of a class body.
fn append_members(ctx: &Ctx<'_>, class: &ClassAt<'_>, members: &[String]) -> TextEdit {
    let text = ctx.parsed.text();
    let close = class.close as usize;
    let line_start = text[..close].rfind('\n').map_or(0, |i| i + 1);
    let brace_alone = text[line_start..close].trim().is_empty();
    let at = if brace_alone { line_start } else { close };
    let before = text[..at].trim_end();
    let mut new_text = String::new();
    if !brace_alone {
        new_text.push('\n');
    }
    if !before.ends_with('{') {
        new_text.push('\n');
    }
    new_text.push_str(&members.join("\n\n"));
    new_text.push('\n');
    if !brace_alone {
        new_text.push_str(&line_indent(text, class.open as usize));
    }
    let pos = ctx.doc.position(at as u32);
    TextEdit { range: Range { start: pos, end: pos }, new_text }
}

fn method_block(indent: &str, unit: &str, signature: &str, body: &[String]) -> String {
    let mut out = format!("{indent}{signature}\n{indent}{{\n");
    for line in body {
        out.push_str(&format!("{indent}{unit}{line}\n"));
    }
    out.push_str(&format!("{indent}}}"));
    out
}

/// Where a declaration's signature ends: the first `{` or `;` outside brackets and strings.
fn signature_end(text: &str, start: usize) -> usize {
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    for (i, c) in text[start..].char_indices() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            '(' | '[' => depth += 1,
            ')' | ']' => depth -= 1,
            '{' | ';' if depth <= 0 => return start + i,
            _ => {}
        }
    }
    text.len()
}

/// A method's signature as its declaring file writes it, with class names rewritten for this file, and the
/// imports that needs. `abstract` is dropped, since the copy has a body.
fn transplant(ctx: &Ctx<'_>, method: &FunctionLikeMetadata, at: u32) -> Option<(String, Vec<String>)> {
    let source = ctx.snap.text_of(&ctx.index, method.span.file_id)?;
    let start = method.span.start.offset as usize;
    // The index can be ahead of or behind the file's text, so its span may not fit.
    source.get(start..)?;
    let end = signature_end(&source, start);
    let arena = LocalArena::new();
    let path = std::path::PathBuf::from(String::from_utf8_lossy(&[]).as_ref()).join("declaring.php");
    let parsed = Parsed::exact(&arena, &path, &source);
    let mut names: Vec<(u32, u32, String)> = parsed
        .names
        .iter()
        .filter(|(s, e, _, _)| *s as usize >= start && *e as usize <= end)
        .map(|(s, e, fqn, _)| (s, e, String::from_utf8_lossy(fqn).into_owned()))
        .collect();
    names.sort_by_key(|n| std::cmp::Reverse(n.0));
    let mut text = source[start..end].to_string();
    let mut imports = vec![];
    for (s, e, fqn) in names {
        let r = reference(&ctx.doc, ctx.parsed.program, at, &fqn, NameKind::Default);
        if r.edit.is_some() && !imports.contains(&fqn) {
            imports.push(fqn.clone());
        }
        text.replace_range(s as usize - start..e as usize - start, &r.name);
    }
    let sig = signature(&text);
    let sig = sig.split(' ').filter(|w| *w != "abstract").collect::<Vec<_>>().join(" ");
    Some((sig, imports))
}

/// A type as a PHP declaration can write it, if it can: `list<int>` is an `array`, `int(3)` an `int`.
pub fn writable_type(t: &TUnion, ctx: &Ctx<'_>, at: u32, imports: &mut Vec<String>) -> Option<String> {
    let mut parts: Vec<String> = vec![];
    let mut nullable = false;
    for atomic in t.types.iter() {
        let part = match atomic {
            TAtomic::Null => {
                nullable = true;
                continue;
            }
            TAtomic::Scalar(s) => match s {
                TScalar::Bool(b) if b.is_true() => "true".into(),
                TScalar::Bool(b) if b.is_false() => "false".into(),
                TScalar::Bool(_) => "bool".into(),
                TScalar::Integer(_) => "int".into(),
                TScalar::Float(_) => "float".into(),
                TScalar::String(_) | TScalar::ClassLikeString(_) => "string".into(),
                _ => return None,
            },
            TAtomic::Array(_) => "array".into(),
            TAtomic::Iterable(_) => "iterable".into(),
            TAtomic::Callable(_) => "callable".into(),
            TAtomic::Void => "void".into(),
            TAtomic::Never => "never".into(),
            TAtomic::Object(mago_codex::ttype::atomic::object::TObject::Named(n)) => {
                if n.is_this || n.is_static {
                    "static".into()
                } else {
                    class_ref(ctx, at, &n.name.as_str_lossy(), imports)
                }
            }
            TAtomic::Object(mago_codex::ttype::atomic::object::TObject::Enum(e)) => class_ref(ctx, at, &e.name.as_str_lossy(), imports),
            TAtomic::Object(mago_codex::ttype::atomic::object::TObject::Any) => "object".into(),
            _ => return None,
        };
        if !parts.contains(&part) {
            parts.push(part);
        }
    }
    // `true|false` is `bool`.
    if parts.contains(&"true".to_string()) && parts.contains(&"false".to_string()) {
        parts.retain(|p| p != "true" && p != "false");
        parts.push("bool".into());
    }
    match (parts.len(), nullable) {
        (0, true) => Some("null".into()),
        (0, false) => None,
        (1, true) if parts[0] != "mixed" => Some(format!("?{}", parts[0])),
        (_, true) => Some(format!("{}|null", parts.join("|"))),
        _ => Some(parts.join("|")),
    }
}

fn class_ref(ctx: &Ctx<'_>, at: u32, fqn: &str, imports: &mut Vec<String>) -> String {
    let fqn = display_class(fqn, &ctx.index.codebase);
    let r = reference(&ctx.doc, ctx.parsed.program, at, &fqn, NameKind::Default);
    if r.edit.is_some() && !imports.contains(&fqn) {
        imports.push(fqn);
    }
    r.name
}

/// Methods the class must implement: abstract ones from its interfaces, parents, and traits.
fn unimplemented<'c>(codebase: &'c CodebaseMetadata, class: &str) -> Vec<&'c FunctionLikeMetadata> {
    let Some(meta) = codebase.get_class_like(class.as_bytes()) else { return vec![] };
    let mut out: Vec<&FunctionLikeMetadata> = meta
        .appearing_method_ids
        .values()
        .filter(|id| !id.get_class_name().as_str_lossy().eq_ignore_ascii_case(class))
        .filter_map(|id| {
            let m = codebase.get_method_by_id(id)?;
            let declaring = codebase.get_class_like(id.get_class_name().as_bytes())?;
            let abstract_ = m.method_metadata.as_ref().is_some_and(|mm| mm.is_abstract) || declaring.kind == SymbolKind::Interface;
            abstract_.then_some(m)
        })
        .collect();
    out.sort_by_key(|m| m.original_name.as_str_lossy().to_ascii_lowercase());
    out
}

/// Parent methods the class could override: inherited from a class, not private, final, or abstract.
fn overridable<'c>(codebase: &'c CodebaseMetadata, class: &str) -> Vec<(&'c FunctionLikeMetadata, String)> {
    let Some(meta) = codebase.get_class_like(class.as_bytes()) else { return vec![] };
    let mut out: Vec<(&FunctionLikeMetadata, String)> = meta
        .appearing_method_ids
        .values()
        .filter(|id| !id.get_class_name().as_str_lossy().eq_ignore_ascii_case(class))
        .filter_map(|id| {
            let m = codebase.get_method_by_id(id)?;
            let mm = m.method_metadata.as_ref()?;
            let declaring = codebase.get_class_like(id.get_class_name().as_bytes())?;
            let ok = declaring.kind != SymbolKind::Interface && !mm.is_abstract && !mm.is_final && mm.visibility != Visibility::Private;
            ok.then(|| (m, declaring.original_name.as_str_lossy().into_owned()))
        })
        .collect();
    out.sort_by_key(|(m, _)| m.original_name.as_str_lossy().to_ascii_lowercase());
    out
}

fn constructor<'a>(class: &ClassAt<'a>) -> Option<&'a Method<'a>> {
    class.members.iter().find_map(|m| match m {
        ClassLikeMember::Method(m) if m.name.value.eq_ignore_ascii_case(b"__construct") => Some(m),
        _ => None,
    })
}

fn param_name(p: &FunctionLikeParameter<'_>) -> String {
    String::from_utf8_lossy(&p.variable.name[1..]).into_owned()
}

/// The class's declared (non-promoted) properties by name, with their statement's span and whether the
/// statement declares only that one.
fn declared_properties<'a>(class: &ClassAt<'a>) -> Vec<(String, &'a Property<'a>, bool)> {
    let mut out = vec![];
    for m in class.members.iter() {
        let ClassLikeMember::Property(p) = m else { continue };
        match p {
            Property::Plain(plain) => {
                let single = plain.items.len() == 1;
                for item in plain.items.iter() {
                    let name = String::from_utf8_lossy(&item.variable().name[1..]).into_owned();
                    out.push((name, p, single));
                }
            }
            Property::Hooked(h) => out.push((String::from_utf8_lossy(&h.item.variable().name[1..]).into_owned(), p, true)),
        }
    }
    out
}

/// Whether a block assigns `$this->name = $name;`, and that statement's span.
fn assignment_of<'a>(body: &'a mago_syntax::cst::Block<'a>, name: &str) -> Option<(u32, u32)> {
    for s in body.statements.iter() {
        let Statement::Expression(es) = s else { continue };
        let Expression::Assignment(a) = es.expression else { continue };
        let Expression::Access(mago_syntax::cst::Access::Property(pa)) = a.lhs else { continue };
        let Expression::Variable(Variable::Direct(this)) = pa.object else { continue };
        if this.name != b"$this" {
            continue;
        }
        let prop = match &pa.property {
            mago_syntax::cst::ClassLikeMemberSelector::Identifier(id) => id.value,
            _ => continue,
        };
        let Expression::Variable(Variable::Direct(v)) = a.rhs else { continue };
        if prop == name.as_bytes() && &v.name[1..] == name.as_bytes() {
            return Some((s.span().start.offset, s.span().end.offset));
        }
    }
    None
}

/// `$this->name = …` assignments in the class's methods to properties it doesn't have, with the assigned
/// value's span.
fn missing_properties(ctx: &Ctx<'_>, class: &ClassAt<'_>) -> Vec<(String, u32, u32)> {
    let codebase = &ctx.index.codebase;
    let mut out: Vec<(String, u32, u32)> = vec![];
    crate::locate::walk(&ctx.parsed, |node, _| {
        let Node::Assignment(a) = node else { return };
        if a.span().start.offset < class.open || a.span().end.offset > class.close {
            return;
        }
        let Expression::Access(mago_syntax::cst::Access::Property(pa)) = a.lhs else { return };
        let Expression::Variable(Variable::Direct(this)) = pa.object else { return };
        let mago_syntax::cst::ClassLikeMemberSelector::Identifier(id) = &pa.property else { return };
        if this.name != b"$this" {
            return;
        }
        let name = String::from_utf8_lossy(id.value).into_owned();
        let prop = format!("${name}");
        let known = codebase.property_exists(class.fqn.as_bytes(), prop.as_bytes())
            || codebase.get_declaring_magic_property(class.fqn.as_bytes(), prop.as_bytes()).is_some()
            || codebase.method_exists(class.fqn.as_bytes(), b"__set");
        if !known && !out.iter().any(|(n, _, _)| *n == name) {
            out.push((name, a.rhs.span().start.offset, a.rhs.span().end.offset));
        }
    });
    out
}

pub fn candidates(ctx: &Ctx<'_>, range: Range) -> Vec<Candidate> {
    let offset = ctx.offset(range.start);
    let Some(class) = class_at(ctx, offset) else { return vec![] };
    let codebase = &ctx.index.codebase;
    let mut out = vec![];
    let is_abstract = codebase.get_class_like(class.fqn.as_bytes()).is_some_and(|c| c.flags.is_abstract());
    if class.kind != SymbolKind::Interface && !is_abstract {
        let missing = unimplemented(codebase, &class.fqn);
        if !missing.is_empty() {
            out.push(Candidate::new("Implement contracts", "quickfix.implement_contracts", "generate.implement", Value::Null));
        }
    }
    if class.kind == SymbolKind::Class {
        for (m, owner) in overridable(codebase, &class.fqn) {
            let name = m.original_name.as_str_lossy().into_owned();
            let short = owner.rsplit('\\').next().unwrap_or(&owner).to_string();
            out.push(Candidate::new(format!("Override {short}::{name}()"), "source.generate.override", "generate.override", json!({ "method": name })));
        }
    }
    if let Some(ctor) = constructor(&class)
        && let MethodBody::Concrete(body) = &ctor.body
    {
        let declared = declared_properties(&class);
        let params: Vec<&FunctionLikeParameter<'_>> = ctor.parameter_list.parameters.iter().filter(|p| p.modifiers.is_empty()).collect();
        let undeclared = |name: &str| {
            !declared.iter().any(|(n, _, _)| n == name) && !codebase.property_exists(class.fqn.as_bytes(), format!("${name}").as_bytes())
        };
        if params.iter().any(|p| assignment_of(body, &param_name(p)).is_none() || undeclared(&param_name(p))) {
            out.push(Candidate::new("Complete constructor", "quickfix.complete_constructor", "generate.complete_constructor", Value::Null));
        }
        let promotable = params.iter().any(|p| {
            let name = param_name(p);
            assignment_of(body, &name).is_some() && declared.iter().any(|(n, _, single)| *n == name && *single)
        });
        if promotable {
            out.push(Candidate::new("Promote constructor", "quickfix.promote_constructor", "generate.promote_constructor", Value::Null));
        }
    }
    if class.kind != SymbolKind::Interface && !missing_properties(ctx, &class).is_empty() {
        out.push(Candidate::new("Add missing properties", "quickfix.add_missing_properties", "generate.add_missing_properties", Value::Null));
    }
    out.extend(generate_candidates(ctx, &class));
    out
}

pub fn resolve(ctx: &Ctx<'_>, action: &str, range: Range, arg: &Value) -> Option<WorkspaceEdit> {
    let offset = ctx.offset(range.start);
    let class = class_at(ctx, offset)?;
    let unit = indent_unit(&ctx.doc.text);
    let codebase = &ctx.index.codebase;
    let mut imports: Vec<String> = vec![];
    let mut edits: Vec<TextEdit> = vec![];
    match action {
        "implement" => {
            let mut members = vec![];
            for m in unimplemented(codebase, &class.fqn) {
                let (sig, needed) = transplant(ctx, m, offset)?;
                imports.extend(needed.into_iter().filter(|n| !imports.contains(n)).collect::<Vec<_>>());
                let name = m.original_name.as_str_lossy();
                members.push(method_block(&class.indent, &unit, &sig, &[format!("// TODO: Implement {name}() method.")]));
            }
            edits.push(append_members(ctx, &class, &members));
        }
        "override" => {
            let wanted = arg.get("method")?.as_str()?;
            let (m, _) = overridable(codebase, &class.fqn).into_iter().find(|(m, _)| m.original_name.as_str_lossy().eq_ignore_ascii_case(wanted))?;
            let (sig, needed) = transplant(ctx, m, offset)?;
            imports.extend(needed);
            let args: Vec<String> = m
                .parameters
                .iter()
                .map(|p| format!("{}{}", if p.flags.is_variadic() { "..." } else { "" }, p.get_name().0.as_str_lossy()))
                .collect();
            let call = format!("parent::{}({})", m.original_name.as_str_lossy(), args.join(", "));
            let returns = m
                .return_type_metadata
                .as_ref()
                .is_some_and(|t| !t.type_union.is_void() && !t.type_union.is_never())
                && !m.method_metadata.as_ref().is_some_and(|mm| mm.is_constructor);
            let body = if returns { format!("return {call};") } else { format!("{call};") };
            edits.push(append_members(ctx, &class, &[method_block(&class.indent, &unit, &sig, &[body])]));
        }
        "complete_constructor" => {
            let ctor = constructor(&class)?;
            let MethodBody::Concrete(body) = &ctor.body else { return None };
            let declared = declared_properties(&class);
            let text = ctx.parsed.text();
            let body_indent = format!("{}{}", line_indent(text, ctor.span().start.offset as usize), unit);
            let mut assignments = String::new();
            let mut properties = String::new();
            for p in ctor.parameter_list.parameters.iter().filter(|p| p.modifiers.is_empty()) {
                let name = param_name(p);
                if assignment_of(body, &name).is_none() {
                    assignments.push_str(&format!("{body_indent}$this->{name} = ${name};\n"));
                }
                let inherited = codebase.property_exists(class.fqn.as_bytes(), format!("${name}").as_bytes());
                if !declared.iter().any(|(n, _, _)| *n == name) && !inherited {
                    let hint = p.hint.as_ref().map(|h| format!("{} ", &text[h.span().start.offset as usize..h.span().end.offset as usize])).unwrap_or_default();
                    properties.push_str(&format!("{}private {hint}${name};\n", class.indent));
                }
            }
            // Assignments go at the end of the body; properties before the constructor.
            let close = body.right_brace.start.offset as usize;
            let line_start = text[..close].rfind('\n').map_or(0, |i| i + 1);
            let at = if text[line_start..close].trim().is_empty() { line_start } else { close };
            let pos = ctx.doc.position(at as u32);
            let lead = if at == close { "\n" } else { "" };
            if !assignments.is_empty() {
                edits.push(TextEdit { range: Range { start: pos, end: pos }, new_text: format!("{lead}{assignments}") });
            }
            if !properties.is_empty() {
                let ctor_line = text[..ctor.span().start.offset as usize].rfind('\n').map_or(0, |i| i + 1);
                let ctor_line = docblock_start(text, ctor_line);
                let pos = ctx.doc.position(ctor_line as u32);
                edits.push(TextEdit { range: Range { start: pos, end: pos }, new_text: format!("{properties}\n") });
            }
        }
        "promote_constructor" => {
            let ctor = constructor(&class)?;
            let MethodBody::Concrete(body) = &ctor.body else { return None };
            let declared = declared_properties(&class);
            let text = ctx.parsed.text();
            for p in ctor.parameter_list.parameters.iter().filter(|p| p.modifiers.is_empty()) {
                let name = param_name(p);
                let Some(assignment) = assignment_of(body, &name) else { continue };
                let Some((_, prop, true)) = declared.iter().find(|(n, _, _)| *n == name) else { continue };
                let Property::Plain(plain) = prop else { continue };
                // The property's modifiers and type move onto the parameter.
                let modifiers: Vec<String> = plain.modifiers.iter().map(|m| String::from_utf8_lossy(m.get_keyword().value).into_owned()).collect();
                let modifiers = if modifiers.iter().any(|m| m == "public" || m == "protected" || m == "private") {
                    modifiers.join(" ")
                } else {
                    format!("public {}", modifiers.join(" ")).trim().to_string()
                };
                let hint = plain.hint.as_ref().map(|h| text[h.span().start.offset as usize..h.span().end.offset as usize].to_string());
                let param_hint = p.hint.as_ref().map(|h| text[h.span().start.offset as usize..h.span().end.offset as usize].to_string());
                let start = p.span().start.offset;
                let rest_start = p.hint.as_ref().map_or(p.variable.span.start.offset, |h| h.span().end.offset);
                let ty = param_hint.or(hint).map(|h| format!("{h} ")).unwrap_or_default();
                let range = ctx.doc.range(start, rest_start);
                let rest = &text[rest_start as usize..p.variable.span.start.offset as usize];
                let _ = rest;
                edits.push(TextEdit { range, new_text: format!("{modifiers} {}", ty.trim_end()).trim_end().to_string() + if ty.is_empty() { "" } else { " " } });
                if p.hint.is_some() {
                    // `Type $x` becomes `private Type $x`: the edit above replaced `Type`, so drop the extra space.
                    let last = edits.last_mut().unwrap();
                    last.new_text = last.new_text.trim_end().to_string();
                }
                edits.push(remove_lines(ctx, assignment.0, assignment.1));
                let prop_start = docblock_start(text, text[..prop.span().start.offset as usize].rfind('\n').map_or(0, |i| i + 1));
                edits.push(remove_lines(ctx, prop_start as u32, prop.span().end.offset));
            }
        }
        "add_missing_properties" => {
            let mut declarations = String::new();
            for (name, s, e) in missing_properties(ctx, &class) {
                let ty = ctx.analysis().type_of(s, e).and_then(|t| writable_type(&t, ctx, offset, &mut imports));
                let ty = ty.filter(|t| t != "null" && t != "void" && t != "never");
                declarations.push_str(&format!("{}private {}${name};\n", class.indent, ty.map(|t| format!("{t} ")).unwrap_or_default()));
            }
            let text = ctx.parsed.text();
            let after_open = text[class.open as usize..].find('\n').map_or(class.open as usize, |i| class.open as usize + i + 1);
            let pos = ctx.doc.position(after_open as u32);
            let has_members = class.members.iter().next().is_some();
            edits.push(TextEdit { range: Range { start: pos, end: pos }, new_text: if has_members { format!("{declarations}\n") } else { declarations } });
        }
        "constructor" => {
            let (unset, _, _) = generatable(ctx, &class);
            edits.push(constructor_edit(ctx, &class, &unset)?);
        }
        "to_string" => {
            edits.push(append_members(ctx, &class, &[method_block(&class.indent, &unit, "public function __toString(): string", &["return '';".into()])]));
        }
        "getters" | "setters" => {
            let names = strings(arg.get("names"));
            return accessors_edit(ctx, offset, &names, action == "getters");
        }
        "accessors" => {
            // Each getter, then each setter.
            let getters = strings(arg.get("getters"));
            let setters = strings(arg.get("setters"));
            let mut members = vec![];
            for (names, getter) in [(&getters, true), (&setters, false)] {
                for name in names {
                    members.push(accessor(ctx, &class, name, getter, offset, &mut imports));
                }
            }
            edits.push(append_members(ctx, &class, &members));
        }
        _ => return None,
    }
    edits.extend(import_edits(&ctx.doc, ctx.parsed.program, offset, &imports, NameKind::Default));
    file_edit(ctx, edits)
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(|n| n.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

/// Where the docblock above the line at `line_start` starts, or `line_start` if there's none.
fn docblock_start(text: &str, line_start: usize) -> usize {
    let before = text[..line_start].trim_end();
    if before.ends_with("*/")
        && let Some(open) = before.rfind("/**")
    {
        return text[..open].rfind('\n').map_or(0, |i| i + 1);
    }
    line_start
}

/// An edit removing the lines from the one holding `start` through the one holding `end`.
fn remove_lines(ctx: &Ctx<'_>, start: u32, end: u32) -> TextEdit {
    let text = ctx.parsed.text();
    let from = text[..start as usize].rfind('\n').map_or(0, |i| i + 1);
    let to = text[end as usize..].find('\n').map_or(text.len(), |i| end as usize + i + 1);
    TextEdit { range: ctx.doc.range(from as u32, to as u32), new_text: String::new() }
}

/// Getters (`getTitle()`) or setters (`setTitle()`) for the named properties of the class at `offset`.
fn accessors_edit(ctx: &Ctx<'_>, offset: u32, names: &[String], getters: bool) -> Option<WorkspaceEdit> {
    let class = class_at(ctx, offset)?;
    let mut imports = vec![];
    let members: Vec<String> = names.iter().map(|n| accessor(ctx, &class, n, getters, offset, &mut imports)).collect();
    if members.is_empty() {
        return None;
    }
    let mut edits = vec![append_members(ctx, &class, &members)];
    edits.extend(import_edits(&ctx.doc, ctx.parsed.program, offset, &imports, NameKind::Default));
    file_edit(ctx, edits)
}

/// A property's getter or setter, typed as the property is.
fn accessor(ctx: &Ctx<'_>, class: &ClassAt<'_>, name: &str, getter: bool, offset: u32, imports: &mut Vec<String>) -> String {
    let unit = indent_unit(&ctx.doc.text);
    let prop = format!("${name}");
    let ty = ctx
        .index
        .codebase
        .get_declaring_property(class.fqn.as_bytes(), prop.as_bytes())
        .and_then(|p| p.type_declaration_metadata.as_ref().or(p.type_metadata.as_ref()))
        .and_then(|t| writable_type(&t.type_union, ctx, offset, imports));
    let upper = upper_first(name);
    if getter {
        let ret = ty.as_ref().map(|t| format!(": {t}")).unwrap_or_default();
        method_block(&class.indent, &unit, &format!("public function get{upper}(){ret}"), &[format!("return $this->{name};")])
    } else {
        let param = ty.as_ref().map(|t| format!("{t} ")).unwrap_or_default();
        method_block(&class.indent, &unit, &format!("public function set{upper}({param}${name}): void"), &[format!("$this->{name} = ${name};")])
    }
}

fn upper_first(name: &str) -> String {
    let mut chars = name.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

/// A property as Generate lists them: declared in the class body, or promoted in its constructor.
struct Prop {
    name: String,
    /// The type as written.
    hint: Option<String>,
    is_static: bool,
    readonly: bool,
    has_default: bool,
    promoted: bool,
    /// Where its declaration ends.
    end: u32,
}

fn properties(ctx: &Ctx<'_>, class: &ClassAt<'_>) -> Vec<Prop> {
    let text = ctx.parsed.text();
    let written = |span: mago_span::Span| text.get(span.start.offset as usize..span.end.offset as usize).map(str::to_string);
    let readonly_class = ctx.index.codebase.get_class_like(class.fqn.as_bytes()).is_some_and(|c| c.flags.is_readonly());
    let mut out = vec![];
    for member in class.members.iter() {
        match member {
            ClassLikeMember::Property(p) => {
                let modifiers = p.modifiers();
                let is_static = modifiers.iter().any(|m| matches!(m, mago_syntax::cst::Modifier::Static(_)));
                let readonly = readonly_class || modifiers.iter().any(|m| matches!(m, mago_syntax::cst::Modifier::Readonly(_)));
                let (hint, items): (_, Vec<&mago_syntax::cst::PropertyItem<'_>>) = match p {
                    Property::Plain(plain) => (plain.hint.as_ref().and_then(|h| written(h.span())), plain.items.iter().collect()),
                    Property::Hooked(h) => (h.hint.as_ref().and_then(|h| written(h.span())), vec![&h.item]),
                };
                for item in items {
                    out.push(Prop {
                        name: String::from_utf8_lossy(&item.variable().name[1..]).into_owned(),
                        hint: hint.clone(),
                        is_static,
                        readonly,
                        has_default: matches!(item, mago_syntax::cst::PropertyItem::Concrete(_)),
                        promoted: false,
                        end: p.span().end.offset,
                    });
                }
            }
            ClassLikeMember::Method(m) if m.name.value.eq_ignore_ascii_case(b"__construct") => {
                for param in m.parameter_list.parameters.iter().filter(|p| !p.modifiers.is_empty()) {
                    out.push(Prop {
                        name: param_name(param),
                        hint: param.hint.as_ref().and_then(|h| written(h.span())),
                        is_static: false,
                        readonly: readonly_class || param.modifiers.iter().any(|m| matches!(m, mago_syntax::cst::Modifier::Readonly(_))),
                        has_default: false,
                        promoted: true,
                        end: param.span().end.offset,
                    });
                }
            }
            _ => {}
        }
    }
    out
}

/// Whether the class body declares the method itself.
fn declares(class: &ClassAt<'_>, method: &str) -> bool {
    class.members.iter().any(|m| matches!(m, ClassLikeMember::Method(m) if m.name.value.eq_ignore_ascii_case(method.as_bytes())))
}

/// The properties a constructor would take, getters and setters would be written for, in that order.
fn generatable(ctx: &Ctx<'_>, class: &ClassAt<'_>) -> (Vec<String>, Vec<String>, Vec<String>) {
    let props: Vec<Prop> = properties(ctx, class).into_iter().filter(|p| !p.is_static).collect();
    let unset = props.iter().filter(|p| !p.promoted && !p.has_default).map(|p| p.name.clone()).collect();
    let getters = props.iter().filter(|p| !declares(class, &format!("get{}", upper_first(&p.name)))).map(|p| p.name.clone()).collect();
    let setters = props.iter().filter(|p| !p.readonly && !declares(class, &format!("set{}", upper_first(&p.name)))).map(|p| p.name.clone()).collect();
    (unset, getters, setters)
}

fn listed(names: &[String]) -> String {
    names.iter().map(|n| format!("${n}")).collect::<Vec<_>>().join(", ")
}

/// Generate's actions (⌘N): a constructor for the properties without a value, `__toString()`, getters, and
/// setters. They're `source.generate.*`, so the light bulb doesn't list them.
fn generate_candidates(ctx: &Ctx<'_>, class: &ClassAt<'_>) -> Vec<Candidate> {
    if !matches!(class.kind, SymbolKind::Class | SymbolKind::Trait) {
        return vec![];
    }
    let (unset, getters, setters) = generatable(ctx, class);
    let mut out = vec![];
    if class.kind == SymbolKind::Class && !unset.is_empty() && !declares(class, "__construct") {
        out.push(Candidate::new(format!("Constructor for {}", listed(&unset)), "source.generate.constructor", "generate.constructor", Value::Null));
    }
    if !getters.is_empty() {
        out.push(Candidate::new(format!("Getters for {}", listed(&getters)), "source.generate.getters", "generate.getters", json!({ "names": getters })));
    }
    if !setters.is_empty() {
        out.push(Candidate::new(format!("Setters for {}", listed(&setters)), "source.generate.setters", "generate.setters", json!({ "names": setters })));
    }
    if !getters.is_empty() && !setters.is_empty() {
        out.push(Candidate::new("Getters and setters", "source.generate.accessors", "generate.accessors", json!({ "getters": getters, "setters": setters })));
    }
    if !declares(class, "__toString") {
        out.push(Candidate::new("__toString()", "source.generate.toString", "generate.to_string", Value::Null));
    }
    out
}

/// A constructor that takes and assigns `names`, below the last property's declaration.
fn constructor_edit(ctx: &Ctx<'_>, class: &ClassAt<'_>, names: &[String]) -> Option<TextEdit> {
    let props = properties(ctx, class);
    let unit = indent_unit(&ctx.doc.text);
    let params: Vec<String> = names
        .iter()
        .filter_map(|n| props.iter().find(|p| p.name == *n))
        .map(|p| format!("{}${}", p.hint.as_ref().map(|h| format!("{h} ")).unwrap_or_default(), p.name))
        .collect();
    let body: Vec<String> = names.iter().map(|n| format!("$this->{n} = ${n};")).collect();
    let block = method_block(&class.indent, &unit, &format!("public function __construct({})", params.join(", ")), &body);
    let text = ctx.parsed.text();
    let last = props.iter().filter(|p| !p.promoted).map(|p| p.end).max()?;
    let at = text[last as usize..].find('\n').map_or(text.len(), |i| last as usize + i + 1);
    let pos = ctx.doc.position(at as u32);
    Some(TextEdit { range: Range { start: pos, end: pos }, new_text: format!("\n{block}\n") })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::actions::{code_actions, resolve as resolve_action};
    use crate::testing::Fixture;
    use lsp_types::{CodeActionContext, CodeActionOrCommand, CodeActionParams, DocumentChangeOperation, DocumentChanges, OneOf, TextDocumentIdentifier};

    /// The titles of the actions at the cursor, and the text after applying the one titled `title`.
    fn run(files: &[(&str, &str)], title: &str) -> (Vec<String>, String) {
        let fx = Fixture::new(files);
        let at = fx.at();
        let actions = code_actions(&fx.snap, CodeActionParams {
            text_document: TextDocumentIdentifier { uri: at.text_document.uri.clone() },
            range: Range { start: at.position, end: at.position },
            context: CodeActionContext::default(),
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        })
        .unwrap()
        .unwrap_or_default();
        let titles: Vec<String> = actions.iter().map(|a| match a { CodeActionOrCommand::CodeAction(a) => a.title.clone(), CodeActionOrCommand::Command(c) => c.title.clone() }).collect();
        let Some(CodeActionOrCommand::CodeAction(action)) = actions.into_iter().find(|a| matches!(a, CodeActionOrCommand::CodeAction(a) if a.title == title)) else {
            return (titles, String::new());
        };
        let resolved = resolve_action(&fx.snap, action).unwrap();
        let doc = fx.snap.doc(&at.text_document.uri).unwrap();
        (titles, apply(&doc, resolved.edit.unwrap()))
    }

    fn apply(doc: &crate::documents::Document, edit: WorkspaceEdit) -> String {
        let Some(DocumentChanges::Operations(ops)) = edit.document_changes else { panic!() };
        let mut text = doc.text.clone();
        for op in ops {
            let DocumentChangeOperation::Edit(e) = op else { continue };
            let mut list: Vec<_> = e.edits.into_iter().map(|e| match e { OneOf::Left(e) => e, OneOf::Right(a) => a.text_edit }).collect();
            list.sort_by_key(|e| std::cmp::Reverse((doc.offset(e.range.start), doc.offset(e.range.end))));
            for e in list {
                text.replace_range(doc.offset(e.range.start) as usize..doc.offset(e.range.end) as usize, &e.new_text);
            }
        }
        text
    }

    const CONTRACTS: &str = "<?php\nnamespace App\\Contracts;\nuse App\\Models\\User;\ninterface Greets {\n    /** Says hi. */\n    public function greet(User $user, string $how = 'warmly'): string;\n}\nabstract class Base {\n    abstract protected function name(): ?string;\n    public function save(array $options = []): bool { return true; }\n    final public function id(): int { return 1; }\n}\n";

    #[test]
    fn implements_interface_and_abstract_methods_with_imports() {
        let (titles, out) = run(
            &[("lib.php", CONTRACTS), ("t.php", "<?php\nnamespace App;\n\nuse App\\Contracts\\Base;\nuse App\\Contracts\\Greets;\n\nclass Hello extends Base implements Greets\n{<|>\n}\n")],
            "Implement contracts",
        );
        assert!(titles.contains(&"Override Base::save()".to_string()), "{titles:?}");
        assert!(!titles.iter().any(|t| t.contains("id()")));
        assert_eq!(
            out,
            "<?php\nnamespace App;\n\nuse App\\Contracts\\Base;\nuse App\\Contracts\\Greets;\nuse App\\Models\\User;\n\nclass Hello extends Base implements Greets\n{\n    public function greet(User $user, string $how = 'warmly'): string\n    {\n        // TODO: Implement greet() method.\n    }\n\n    protected function name(): ?string\n    {\n        // TODO: Implement name() method.\n    }\n}\n"
        );
    }

    #[test]
    fn overrides_a_parent_method_calling_the_parent() {
        let (_, out) = run(
            &[("lib.php", CONTRACTS), ("t.php", "<?php\nclass Post extends \\App\\Contracts\\Base\n{\n    protected function name(): ?string { return null; }<|>\n}\n")],
            "Override Base::save()",
        );
        assert_eq!(
            out,
            "<?php\nclass Post extends \\App\\Contracts\\Base\n{\n    protected function name(): ?string { return null; }\n\n    public function save(array $options = []): bool\n    {\n        return parent::save($options);\n    }\n}\n"
        );
    }

    #[test]
    fn completes_and_promotes_constructors() {
        let (_, out) = run(
            &[("t.php", "<?php\nclass A\n{\n    public function __construct(int $count, string $name)\n    {<|>\n        $this->count = $count;\n    }\n}\n")],
            "Complete constructor",
        );
        assert_eq!(
            out,
            "<?php\nclass A\n{\n    private int $count;\n    private string $name;\n\n    public function __construct(int $count, string $name)\n    {\n        $this->count = $count;\n        $this->name = $name;\n    }\n}\n"
        );

        let (_, out) = run(
            &[("t.php", "<?php\nclass A\n{\n    /** @var int */\n    private readonly int $count;\n\n    public function __construct(int $count)\n    {<|>\n        $this->count = $count;\n    }\n}\n")],
            "Promote constructor",
        );
        assert_eq!(out, "<?php\nclass A\n{\n\n    public function __construct(private readonly int $count)\n    {\n    }\n}\n");
    }

    #[test]
    fn declares_missing_properties_with_inferred_types() {
        let (_, out) = run(
            &[("t.php", "<?php\nclass A\n{\n    public function f(): void\n    {<|>\n        $this->count = 3;\n        $this->names = ['a'];\n        $this->at = new \\DateTimeImmutable();\n    }\n}\n")],
            "Add missing properties",
        );
        assert_eq!(
            out,
            "<?php\nclass A\n{\n    private int $count;\n    private array $names;\n    private DateTimeImmutable $at;\n\n    public function f(): void\n    {\n        $this->count = 3;\n        $this->names = ['a'];\n        $this->at = new \\DateTimeImmutable();\n    }\n}\n"
        );
    }

    #[test]
    fn offers_generate_actions_for_what_the_class_lacks() {
        let class = "<?php\nclass A\n{\n    private string $title;\n    private ?int $count = null;\n    private static int $made = 0;\n\n    public function __construct() {}\n}\n";
        let fx = Fixture::one(&class.replace("class A\n{", "class A\n{<|>").replace("    public function __construct() {}\n", ""));
        let titles = |fx: &Fixture| {
            let at = fx.at();
            code_actions(&fx.snap, CodeActionParams {
                text_document: TextDocumentIdentifier { uri: at.text_document.uri.clone() },
                range: Range { start: at.position, end: at.position },
                context: CodeActionContext { only: Some(vec!["source.generate".to_string().into()]), ..Default::default() },
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
            })
            .unwrap()
            .unwrap_or_default()
            .into_iter()
            .map(|a| match a { CodeActionOrCommand::CodeAction(a) => a.title, CodeActionOrCommand::Command(c) => c.title })
            .collect::<Vec<_>>()
        };
        assert_eq!(titles(&fx), vec!["Constructor for $title", "Getters for $title, $count", "Setters for $title, $count", "Getters and setters", "__toString()"]);
        // With a constructor, readonly properties, and a getter and __toString() already there.
        let fx = Fixture::one("<?php\nreadonly class B\n{<|>\n    public function __construct(public string $name) {}\n    public function getName(): string { return ''; }\n    public function __toString(): string { return ''; }\n}\n");
        assert!(titles(&fx).is_empty(), "{:?}", titles(&fx));
    }

    #[test]
    fn generates_a_constructor_and_to_string() {
        let files = |text: &str| vec![("t.php", text.to_string())];
        let code = "<?php\nclass A\n{<|>\n    private string $title;\n    private ?int $count;\n    private bool $done = false;\n\n    public function run(): void {}\n}\n";
        let owned = files(code);
        let refs: Vec<(&str, &str)> = owned.iter().map(|(a, b)| (*a, b.as_str())).collect();
        let (_, out) = run(&refs, "Constructor for $title, $count");
        assert_eq!(
            out,
            "<?php\nclass A\n{\n    private string $title;\n    private ?int $count;\n    private bool $done = false;\n\n    public function __construct(string $title, ?int $count)\n    {\n        $this->title = $title;\n        $this->count = $count;\n    }\n\n    public function run(): void {}\n}\n"
        );
        let (_, out) = run(&refs, "__toString()");
        assert!(out.ends_with("    public function run(): void {}\n\n    public function __toString(): string\n    {\n        return '';\n    }\n}\n"), "{out}");
        let (_, out) = run(&refs, "Getters and setters");
        assert!(out.contains("public function getTitle(): string") && out.contains("public function setDone(bool $done): void"), "{out}");
    }

    #[test]
    fn generates_getters_and_setters() {
        let fx = Fixture::one("<?php\nclass A\n{\n    private ?string $title = null;\n    private bool $done = false;\n}\n");
        let uri = crate::testing::uri("test.php");
        let names = |n: &[&str]| n.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let edit = crate::features::with_ctx(&fx.snap, &uri, |ctx| accessors_edit(ctx, 7, &names(&["title", "done"]), true)).flatten().unwrap();
        let out = apply(&fx.doc("test.php"), edit);
        assert_eq!(
            out,
            "<?php\nclass A\n{\n    private ?string $title = null;\n    private bool $done = false;\n\n    public function getTitle(): ?string\n    {\n        return $this->title;\n    }\n\n    public function getDone(): bool\n    {\n        return $this->done;\n    }\n}\n"
        );
        let edit = crate::features::with_ctx(&fx.snap, &uri, |ctx| accessors_edit(ctx, 7, &names(&["title"]), false)).flatten().unwrap();
        assert!(apply(&fx.doc("test.php"), edit).contains("    public function setTitle(?string $title): void\n    {\n        $this->title = $title;\n    }\n}"));
    }
}
