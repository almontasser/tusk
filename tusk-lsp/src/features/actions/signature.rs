//! Change Signature: a method's or function's new name, parameters, and return type, written into its declaration,
//! the methods that override it, and every call. The editor's dialog is the UI: it asks `tusk/signature` for the
//! declaration as it is, then `tusk/changeSignature` for the edit. Introduce Parameter comes here too when its
//! dialog changes more than the new parameter.
//!
//! Calls are matched to the parameters by name: positional arguments move to their parameter's new place, named
//! ones stay named, and a parameter left out before a later argument gets its default. Values written into calls,
//! such as a new parameter's, are read as code of the declaration's file, so they mean the same at each call.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use lsp_types::{Position, Range, TextEdit};
use mago_allocator::LocalArena;
use mago_names::kind::NameKind;
use mago_syntax::cst::{Argument, ArgumentList, Node, StringPart, TriviaKind};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::inline::{Dest, Source, StaticAs, line_of, moved, reads_by_name, rewrite, short, slice, with_docblock};
use super::introduce::{Kind, contains, occurrences, path_to, span, targets};
use super::{indent_unit, line_indent};
use crate::analysis::Parsed;
use crate::documents::Document;
use crate::features::hierarchy::{Target as Callee, calls_of};
use crate::features::rename::{Edits, is_identifier};
use crate::features::{Ctx, with_ctx};
use crate::imports::import_edits;
use crate::locate::{declaration, variable_scope, walk};
use crate::server::Snapshot;
use crate::symbol::{Resolver, Symbol};
use crate::text::{LineIndex, path_to_uri};

type Span = (u32, u32);

/// A parameter, as the dialog shows it.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Param {
    /// What comes before the name: attributes, a promoted property's modifiers, and the type.
    #[serde(rename = "type", default)]
    pub hint: String,
    pub name: String,
    #[serde(default)]
    pub by_ref: bool,
    #[serde(default)]
    pub variadic: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
    /// In a new signature, the old parameter's name; none for a new one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// For a new parameter, what existing calls pass, when not its default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_value: Option<String>,
    /// Its code as written, which a parameter that doesn't change keeps.
    #[serde(default)]
    pub text: String,
}

fn filled(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

impl Param {
    /// Its declaration, as `private readonly int &...$name = 1`.
    fn declared(&self) -> String {
        let hint = if self.hint.trim().is_empty() { String::new() } else { format!("{} ", self.hint.trim()) };
        let default = filled(&self.default_value).map(|d| format!(" = {d}")).unwrap_or_default();
        format!("{hint}{}{}${}{default}", if self.by_ref { "&" } else { "" }, if self.variadic { "..." } else { "" }, self.name)
    }

    fn declares_as(&self, old: &Param) -> bool {
        self.hint.trim() == old.hint.trim() && self.name == old.name && self.by_ref == old.by_ref && self.variadic == old.variadic && filled(&self.default_value) == filled(&old.default_value)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    #[serde(default)]
    pub modifiers: String,
    pub name: String,
    #[serde(default)]
    pub return_type: String,
    pub params: Vec<Param>,
}

/// A method's or function's declaration, read from its node.
struct Decl {
    /// From its modifiers, or `function`, to the end of its return type, or of its parameter list.
    header: Span,
    /// The node, whose span is its variables' scope.
    scope: Span,
    modifiers: String,
    by_ref: bool,
    name: String,
    return_type: String,
    params: Vec<Param>,
    /// The parameters' indentation when each is on its own line.
    indent: Option<String>,
    /// The indentation of the header's line.
    header_indent: String,
}

fn read_decl(text: &str, node: Node<'_, '_>) -> Option<Decl> {
    let (modifiers, function, by_ref, name, list, ret) = match node {
        Node::Method(m) => (m.modifiers.iter().map(span).collect::<Vec<_>>(), span(&m.function), m.ampersand.is_some(), span(&m.name), &m.parameter_list, m.return_type_hint.as_ref()),
        Node::Function(f) => (vec![], span(&f.function), f.ampersand.is_some(), span(&f.name), &f.parameter_list, f.return_type_hint.as_ref()),
        _ => return None,
    };
    let start = modifiers.first().map_or(function.0, |m| m.0);
    let end = ret.map_or(list.right_parenthesis.end.offset, |r| span(&r.hint).1);
    let params = list
        .parameters
        .iter()
        .map(|p| {
            let name_at = [p.ampersand.map(|a| a.start.offset), p.ellipsis.map(|e| e.start.offset), Some(p.variable.span.start.offset)].into_iter().flatten().min().unwrap_or_default();
            Param {
                hint: slice(text, (span(p).0, name_at)).trim().to_string(),
                name: String::from_utf8_lossy(&p.variable.name[1..]).into_owned(),
                by_ref: p.ampersand.is_some(),
                variadic: p.ellipsis.is_some(),
                default_value: p.default_value.as_ref().map(|d| slice(text, span(d.value)).to_string()),
                text: slice(text, span(p)).to_string(),
                ..Default::default()
            }
        })
        .collect();
    let inner = slice(text, (list.left_parenthesis.end.offset, list.right_parenthesis.start.offset));
    let indent = list.parameters.first().filter(|_| inner.contains('\n')).map(|p| line_indent(text, span(p).0 as usize));
    Some(Decl {
        header: (start, end),
        scope: span(&node),
        modifiers: modifiers.iter().map(|m| slice(text, *m)).collect::<Vec<_>>().join(" "),
        by_ref,
        name: slice(text, name).to_string(),
        return_type: ret.map(|r| slice(text, span(&r.hint)).to_string()).unwrap_or_default(),
        params,
        indent,
        header_indent: line_indent(text, start as usize),
    })
}

/// The header for `params`, keeping each parameter's code as written where it doesn't change, and one per line
/// when the declaration had them so.
fn header(d: &Decl, modifiers: &str, name: &str, params: &[Param], return_type: &str) -> String {
    let texts: Vec<String> = params
        .iter()
        .map(|p| match p.from.as_ref().and_then(|f| d.params.iter().find(|o| &o.name == f)) {
            Some(old) if p.declares_as(old) => old.text.clone(),
            _ => p.declared(),
        })
        .collect();
    let list = match &d.indent {
        Some(indent) if !texts.is_empty() => format!("\n{}\n{}", texts.iter().map(|t| format!("{indent}{t},")).collect::<Vec<_>>().join("\n"), d.header_indent),
        _ => texts.join(", "),
    };
    let modifiers = if modifiers.trim().is_empty() { String::new() } else { format!("{} ", modifiers.trim()) };
    let ret = if return_type.trim().is_empty() { String::new() } else { format!(": {}", return_type.trim()) };
    format!("{modifiers}function {}{name}({list}){ret}", if d.by_ref { "&" } else { "" })
}

/// The spans of `$name` (without `$`) in the scope `scope`: in closures that take it with `use` too, but not where an
/// arrow function's own parameter of that name hides it.
fn variable_uses(parsed: &Parsed<'_>, name: &str, scope: Span) -> Vec<Span> {
    let target = format!("${name}");
    let mut out = vec![];
    let mut closures = vec![];
    walk(parsed, |node, ancestors| match node {
        Node::DirectVariable(v) if v.name == target.as_bytes() => {
            let mut path = ancestors.to_vec();
            path.push(node);
            let hidden = ancestors.iter().any(|n| matches!(n, Node::ArrowFunction(f) if f.parameter_list.parameters.iter().any(|p| p.variable.name == target.as_bytes())));
            if variable_scope(parsed, &path) == scope && !hidden {
                out.push((v.span.start.offset + 1, v.span.end.offset));
            }
        }
        Node::Closure(c) if c.use_clause.as_ref().is_some_and(|u| u.variables.iter().any(|v| v.variable.name == target.as_bytes())) && variable_scope(parsed, ancestors) == scope => {
            closures.push(span(&node));
        }
        _ => {}
    });
    for c in closures {
        out.extend(variable_uses(parsed, name, c));
    }
    out
}

/// The edits that rename parameters, as (old, new) pairs, in a declaration's body and docblock.
fn renames(parsed: &Parsed<'_>, text: &str, d: &Decl, pairs: &[(String, String)]) -> Vec<(Span, String)> {
    let mut out = vec![];
    let doc = with_docblock(parsed, text, d.scope);
    for (old, new) in pairs {
        // The header is written whole.
        out.extend(variable_uses(parsed, old, d.scope).into_iter().filter(|s| !contains(d.header, *s)).map(|s| (s, new.clone())));
        // `@param int $old` in the docblock.
        let target = format!("${old}");
        let block = slice(text, (doc.0, d.scope.0));
        for (i, _) in block.match_indices(&target) {
            let after = block[i + target.len()..].chars().next();
            if !after.is_some_and(|c| c.is_alphanumeric() || c == '_') {
                let at = doc.0 + i as u32 + 1;
                out.push(((at, at + old.len() as u32), new.clone()));
            }
        }
    }
    out
}

/// What's wrong with a new signature, or None.
fn problem(s: &Signature, d: &Decl, constructor: bool) -> Option<String> {
    if !is_identifier(&s.name) {
        return Some("The name must be a valid PHP name.".into());
    }
    if constructor && !s.name.eq_ignore_ascii_case(&d.name) {
        return Some("A constructor's name can't change.".into());
    }
    let mut seen = HashSet::new();
    for (i, p) in s.params.iter().enumerate() {
        if !is_identifier(&p.name) {
            return Some(if p.name.is_empty() { "Each parameter needs a name.".into() } else { format!("${} isn't a valid parameter name.", p.name) });
        }
        if !seen.insert(&p.name) {
            return Some(format!("Two parameters are named ${}.", p.name));
        }
        if p.variadic && i + 1 < s.params.len() {
            return Some(format!("The variadic parameter ${} must come last.", p.name));
        }
        match p.from.as_ref().map(|f| d.params.iter().find(|o| &o.name == f)) {
            Some(None) => return Some(format!("${} isn't a parameter of {}.", p.from.as_deref().unwrap_or_default(), d.name)),
            Some(Some(old)) if constructor && old.name != p.name && old.hint.split_whitespace().any(|w| ["public", "protected", "private", "readonly"].contains(&w)) => {
                return Some(format!("${} is a promoted property. Rename it with Rename (⇧F6).", old.name));
            }
            None if filled(&p.default_value).is_none() && filled(&p.call_value).is_none() && !p.variadic => {
                return Some(format!("The new parameter ${} needs a default value or a value for existing calls.", p.name));
            }
            _ => {}
        }
    }
    None
}

/// The same change for an override, which may name its parameters differently: parameters match by position and
/// keep the override's own name, type, and default unless the change set new ones. Parameters only the override
/// has stay, after the others.
fn for_override(before: &[Param], after: &[Param], own: &[Param]) -> Vec<Param> {
    let mut out: Vec<Param> = after
        .iter()
        .map(|p| {
            let Some(i) = p.from.as_ref().and_then(|f| before.iter().position(|b| &b.name == f)) else { return p.clone() };
            let (Some(mine), old) = (own.get(i), &before[i]) else { return p.clone() };
            Param {
                from: Some(mine.name.clone()),
                name: if p.name == old.name { mine.name.clone() } else { p.name.clone() },
                hint: if p.hint.trim() == old.hint.trim() { mine.hint.clone() } else { p.hint.clone() },
                default_value: if filled(&p.default_value) == filled(&old.default_value) { mine.default_value.clone() } else { p.default_value.clone() },
                ..p.clone()
            }
        })
        .collect();
    out.extend(own.iter().skip(before.len()).map(|p| Param { from: Some(p.name.clone()), ..p.clone() }));
    out
}

/// Whether calls' arguments must change: parameters added, removed, moved, or renamed.
fn moves(before: &[Param], after: &[Param]) -> bool {
    before.len() != after.len() || after.iter().zip(before).any(|(a, b)| a.from.as_deref() != Some(b.name.as_str()) || a.name != b.name)
}

// ---- Calls ----

/// A declaration whose calls are rewritten against its parameters: the method, or an override of it.
struct Group {
    callee: Callee,
    /// The class whose `self` the declaration's code means.
    owner: Option<String>,
    /// The file it's in, whose names values written into calls are read with.
    path: PathBuf,
    /// Where values can be read as that file's code: before the class or function around the declaration.
    insert_at: u32,
    before: Vec<Param>,
    after: Vec<Param>,
}

/// A value for calls, written to mean the same at one call, with the imports it needs there.
type Written = Result<(String, Vec<String>), String>;

/// A call to rewrite: where its name is, its group, and each value it may need, by its text in the dialog.
struct Site {
    name: Span,
    group: usize,
    values: HashMap<String, Written>,
}

/// The values a group's calls may need: new parameters' values for calls and the defaults that a later positional
/// argument can need written.
fn values_of(g: &Group) -> Vec<String> {
    let mut out: Vec<String> = g.after.iter().flat_map(|p| [filled(&p.call_value), filled(&p.default_value)]).flatten().map(str::to_string).collect();
    out.sort();
    out.dedup();
    out
}

/// What a call passes, as read from its node.
enum CallArgs<'a> {
    List(&'a ArgumentList<'a>),
    /// `new Order` without parentheses: where they'd go.
    Bare(u32),
    /// `f(...)`, which passes none.
    Callable,
    /// A name that isn't called, such as a callable string.
    NotCalled,
}

fn call_args<'a>(path: &[Node<'a, 'a>], m: Span) -> CallArgs<'a> {
    for n in path.iter().rev() {
        match n {
            Node::FunctionCall(c) if contains(span(c.function), m) => return CallArgs::List(&c.argument_list),
            Node::MethodCall(c) if contains(span(&c.method), m) => return CallArgs::List(&c.argument_list),
            Node::NullSafeMethodCall(c) if contains(span(&c.method), m) => return CallArgs::List(&c.argument_list),
            Node::StaticMethodCall(c) if contains(span(&c.method), m) => return CallArgs::List(&c.argument_list),
            Node::Instantiation(i) if contains(span(i.class), m) => return i.argument_list.as_ref().map_or(CallArgs::Bare(span(i.class).1), CallArgs::List),
            Node::FunctionPartialApplication(_) | Node::MethodPartialApplication(_) | Node::StaticMethodPartialApplication(_) => return CallArgs::Callable,
            _ => {}
        }
    }
    CallArgs::NotCalled
}

/// An argument: the name it's passed by, if any, and its code.
#[derive(Clone, PartialEq, Debug)]
struct Arg {
    name: Option<String>,
    code: String,
    /// The original argument it is, for the comment after it.
    was: Option<usize>,
}

/// The arguments for a call after the change, or why it can't change. `write` gives a value's code at the call.
fn rewrite_args(args: &[Arg], before: &[Param], after: &[Param], named_arguments: bool, write: &mut dyn FnMut(&str) -> Result<String, String>) -> Result<Vec<Arg>, String> {
    let mut passed: HashMap<&str, (&Arg, bool)> = HashMap::new();
    let mut positional = 0;
    for a in args {
        match &a.name {
            Some(n) => {
                if !before.iter().any(|p| &p.name == n) {
                    return Err(format!("it names no parameter ${n}"));
                }
                passed.insert(n.as_str(), (a, true));
            }
            None => {
                let Some(p) = before.get(positional) else { return Err("it passes more arguments than the function declares".into()) };
                if p.variadic {
                    return Err("it passes variadic arguments".into());
                }
                passed.insert(p.name.as_str(), (a, false));
                positional += 1;
            }
        }
    }
    let mut out: Vec<Arg> = vec![];
    let mut pending: Vec<&str> = vec![];
    let mut named: Vec<Arg> = vec![];
    // Once an argument has to be named, every one after it must be too: a positional one would take its place.
    let mut naming = false;
    for p in after {
        let (code, was) = match p.from.as_deref().and_then(|f| passed.get(f)) {
            Some((a, by_name)) => {
                naming |= *by_name;
                (a.code.clone(), a.was)
            }
            None => match (filled(&p.call_value), filled(&p.default_value)) {
                (Some(v), _) => (write(v)?, None),
                // A default is written only when a later positional argument needs its place.
                (None, Some(d)) => {
                    if !naming {
                        pending.push(d);
                    }
                    continue;
                }
                (None, None) if p.variadic => continue,
                (None, None) => return Err(format!("it passes nothing for ${}, which has no default", p.name)),
            },
        };
        if naming {
            if p.variadic {
                return Err(format!("it would pass the variadic ${} after named arguments", p.name));
            }
            if !named_arguments {
                return Err("it would need named arguments, which PHP 8 added".into());
            }
            named.push(Arg { name: Some(p.name.clone()), code, was });
        } else {
            for d in pending.drain(..) {
                out.push(Arg { name: None, code: write(d)?, was: None });
            }
            out.push(Arg { name: None, code, was });
        }
    }
    out.extend(named);
    Ok(out)
}

/// The new argument list's text, written as the old one was: one per line with trailing commas when it was, and
/// whenever an argument keeps a line comment, which would otherwise swallow what follows it.
fn format_args(text: &str, list: &ArgumentList<'_>, args: &[Arg], comments: &HashMap<usize, String>) -> String {
    let (open, close) = (list.left_parenthesis.end.offset, list.right_parenthesis.start.offset);
    let inner = slice(text, (open, close));
    let line_comment = comments.values().any(|c| c.starts_with("//") || c.starts_with('#'));
    let item = |a: &Arg| match &a.name {
        Some(n) => format!("{n}: {}", a.code),
        None => a.code.clone(),
    };
    if args.is_empty() || !(inner.contains('\n') || line_comment) {
        return args.iter().map(|a| match a.was.and_then(|w| comments.get(&w)) {
            Some(c) => format!("{} {c}", item(a)),
            None => item(a),
        }).collect::<Vec<_>>().join(", ");
    }
    let call_indent = line_indent(text, open as usize);
    let first = list.arguments.iter().next().map(|a| span(a).0);
    let own_line = |at: u32| slice(text, (text[..at as usize].rfind('\n').map_or(0, |i| i as u32 + 1), at)).trim().is_empty();
    let indent = match first {
        Some(at) if own_line(at) => line_indent(text, at as usize),
        _ => format!("{call_indent}{}", indent_unit(text)),
    };
    let close_indent = if own_line(close) { line_indent(text, close as usize) } else { call_indent };
    let lines: Vec<String> = args
        .iter()
        .map(|a| match a.was.and_then(|w| comments.get(&w)) {
            Some(c) => format!("{indent}{}, {c}", item(a)),
            None => format!("{indent}{},", item(a)),
        })
        .collect();
    format!("\n{}\n{close_indent}", lines.join("\n"))
}

/// The comments between a call's parentheses, outside its arguments, each by the argument it follows on the same
/// line. An error when one stands elsewhere, such as on a line of its own, where moving arguments would lose it.
fn arg_comments(parsed: &Parsed<'_>, text: &str, list: &ArgumentList<'_>) -> Result<HashMap<usize, String>, String> {
    let (open, close) = (list.left_parenthesis.end.offset, list.right_parenthesis.start.offset);
    let spans: Vec<Span> = list.arguments.iter().map(span).collect();
    let mut out: HashMap<usize, String> = HashMap::new();
    for t in parsed.program.trivia.iter() {
        let c = span(t);
        if t.kind == TriviaKind::WhiteSpace || !contains((open, close), c) || spans.iter().any(|s| contains(*s, c)) {
            continue;
        }
        let follows = spans.iter().rposition(|s| s.1 <= c.0).filter(|&i| !slice(text, (spans[i].1, c.0)).contains('\n'));
        match follows {
            Some(i) if !out.contains_key(&i) => {
                out.insert(i, slice(text, c).trim_end().to_string());
            }
            _ => return Err("it has comments between its arguments, which moving them would lose".into()),
        }
    }
    Ok(out)
}

// ---- The change ----

/// Calls left as they were, or places to look at: the file, the line, and why.
type Skipped = Vec<(PathBuf, u32, String)>;

/// The innermost method or function around `offset`, not a closure.
fn host_at<'a>(parsed: &Parsed<'a>, offset: u32) -> Option<Node<'a, 'a>> {
    parsed.path_at(offset).into_iter().rev().find(|n| matches!(n, Node::Method(_) | Node::Function(_)))
}

/// Where values can be read as a file's code: before the class-like or function statement around `decl`.
fn insert_point(parsed: &Parsed<'_>, decl: Span) -> u32 {
    let path = parsed.path_at(decl.0);
    path.iter()
        .find(|n| matches!(n, Node::Class(_) | Node::Interface(_) | Node::Trait(_) | Node::Enum(_) | Node::Function(_)))
        .map_or(decl.0, |n| span(n).0)
}

fn symbol_of(ctx: &Ctx<'_>, host: Node<'_, '_>) -> Result<Symbol, String> {
    let name = match host {
        Node::Method(m) => span(&m.name),
        Node::Function(f) => span(&f.name),
        _ => unreachable!(),
    };
    match ctx.resolver().at(name.0).and_then(|f| f.symbols.into_iter().next()) {
        Some(s @ (Symbol::Method { .. } | Symbol::Function(_))) => Ok(s),
        _ => Err("Can't read the method's name.".into()),
    }
}

fn label_of(symbol: &Symbol) -> String {
    match symbol {
        Symbol::Method { class, name } => format!("{}::{name}()", short(class)),
        Symbol::Function(f) => format!("{}()", short(f)),
        _ => String::new(),
    }
}

/// The declaration at the caret, for the dialog.
fn read(ctx: &Ctx<'_>, position: Position) -> Result<Value, String> {
    let host = host_at(&ctx.parsed, ctx.doc.offset(position)).ok_or("Put the cursor in a method or function to change its signature.")?;
    let d = read_decl(&ctx.doc.text, host).ok_or("Can't read the declaration.")?;
    let symbol = symbol_of(ctx, host)?;
    let kind = match &symbol {
        Symbol::Method { name, .. } if name.eq_ignore_ascii_case("__construct") => "constructor",
        Symbol::Method { .. } => "method",
        _ => "function",
    };
    let title = label_of(&symbol).trim_end_matches("()").to_string();
    let signature = Signature { modifiers: d.modifiers.clone(), name: d.name.clone(), return_type: d.return_type.clone(), params: d.params.clone() };
    Ok(json!({ "kind": kind, "title": title, "signature": signature }))
}

/// Introduce Parameter's expression, when the change comes from it: its uses become the new parameter.
pub struct Introduced {
    pub range: Range,
    pub all: bool,
    /// The new parameter that holds it; else the new one whose value is the expression.
    pub name: Option<String>,
}

/// The edits for a new signature of the method or function at `position`, the places left as they were, and a
/// message.
fn change(ctx: &Ctx<'_>, position: Position, s: &Signature, introduced: Option<&Introduced>) -> Result<(Edits, Skipped, String), String> {
    let text = ctx.doc.text.as_str();
    let host = host_at(&ctx.parsed, ctx.doc.offset(position)).ok_or("Put the cursor in a method or function to change its signature.")?;
    let d = read_decl(text, host).ok_or("Can't read the declaration.")?;
    let symbol = symbol_of(ctx, host)?;
    let codebase = &ctx.index.codebase;
    let label = label_of(&symbol);
    let (owner, name) = match &symbol {
        Symbol::Method { class, name } => (Some(class.clone()), name.clone()),
        Symbol::Function(f) => (None, f.clone()),
        _ => unreachable!(),
    };
    let constructor = owner.is_some() && name.eq_ignore_ascii_case("__construct");
    if let Some(why) = problem(s, &d, constructor) {
        return Err(why);
    }
    let arguments_move = moves(&d.params, &s.params);
    let pairs: Vec<(String, String)> = s.params.iter().filter_map(|p| p.from.as_ref().filter(|f| **f != p.name).map(|f| (f.clone(), p.name.clone()))).collect();
    if arguments_move && let Some(how) = reads_by_name(&ctx.parsed, d.scope) {
        return Err(format!("Can't change the parameters of {label}: it reads its variables by name, with {how}."));
    }
    // A new name mustn't be a variable the body already has.
    for p in &s.params {
        let new = p.from.as_ref() != Some(&p.name);
        if new && !d.params.iter().any(|o| o.name == p.name) && !variable_uses(&ctx.parsed, &p.name, d.scope).is_empty() {
            return Err(format!("${} is already a variable in {label}. Choose another name.", p.name));
        }
    }

    let mut skipped: Skipped = vec![];
    let mut texts: BTreeMap<PathBuf, String> = BTreeMap::new();
    let mut edits: BTreeMap<PathBuf, Vec<(Span, String)>> = BTreeMap::new();
    texts.insert(ctx.doc.path.clone(), text.to_string());
    let own = edits.entry(ctx.doc.path.clone()).or_default();
    own.push((d.header, header(&d, &s.modifiers, &s.name, &s.params, &s.return_type)));
    own.extend(renames(&ctx.parsed, text, &d, &pairs));
    // A removed parameter still read in the body: worth a look before applying.
    for old in d.params.iter().filter(|o| !s.params.iter().any(|p| p.from.as_ref() == Some(&o.name))) {
        if let Some(u) = variable_uses(&ctx.parsed, &old.name, d.scope).into_iter().find(|u| !contains(d.header, *u)) {
            skipped.push((ctx.doc.path.clone(), line_of(text, u.0), format!("${} is removed, but the body still uses it", old.name)));
        }
    }
    // Introduce Parameter: the expression's uses read the new parameter.
    if let Some(intro) = introduced {
        let t = targets(ctx, intro.range, Kind::Parameter)?.0.into_iter().next().ok_or("There's nothing to make a parameter.")?;
        let expression = slice(text, t.span).trim().to_string();
        let added = match &intro.name {
            Some(n) => s.params.iter().find(|p| p.from.is_none() && &p.name == n),
            None => s.params.iter().find(|p| p.from.is_none() && (filled(&p.call_value) == Some(&expression) || filled(&p.default_value) == Some(&expression))),
        };
        if let Some(p) = added {
            let uses = if intro.all { occurrences(ctx, &t, Kind::Parameter) } else { vec![t.span] };
            for u in uses.into_iter().filter(|u| contains(d.scope, *u)) {
                let interpolated = path_to(ctx, u).is_some_and(|path| path.len() >= 2 && matches!(path[path.len() - 2], Node::StringPart(StringPart::Expression(_))));
                own.push((u, if interpolated { format!("{{${}}}", p.name) } else { format!("${}", p.name) }));
            }
        }
    }

    let insert_at = insert_point(&ctx.parsed, d.scope);
    let mut groups = vec![Group {
        callee: match &owner {
            Some(o) => Callee::Method { class: o.clone(), name: name.clone() },
            None => Callee::Function { fqn: name.clone() },
        },
        owner: owner.clone(),
        path: ctx.doc.path.clone(),
        insert_at,
        before: d.params.clone(),
        after: s.params.clone(),
    }];
    let lower = name.to_ascii_lowercase();
    if let Some(o) = owner.as_ref().filter(|_| !constructor) {
        // Methods that override it change with it.
        let children = crate::features::navigation::descendants(codebase, o)
            .into_iter()
            .filter(|c| codebase.get_declaring_method_class(c.as_bytes(), lower.as_bytes()).is_some_and(|w| w.as_str_lossy().eq_ignore_ascii_case(c)));
        for child in children {
            let Some(place) = declaration(&Symbol::Method { class: child.clone(), name: name.clone() }, codebase) else { continue };
            let Some(path) = ctx.index.path_of(place.file).map(Path::to_path_buf) else { continue };
            if !ctx.index.is_project_file(place.file) {
                continue;
            }
            let child_text = texts.entry(path.clone()).or_insert_with(|| ctx.snap.read(&path).unwrap_or_default()).clone();
            let arena = LocalArena::new();
            let parsed = Parsed::new(&arena, &path, &child_text);
            let mut node = None;
            walk(&parsed, |n, _| {
                if let Node::Method(m) = n
                    && span(&m.name).0 == place.start
                {
                    node = Some(n);
                }
            });
            let Some(cd) = node.and_then(|n| read_decl(&child_text, n)) else { continue };
            let after = for_override(&d.params, &s.params, &cd.params);
            let return_type = if cd.return_type.trim() != d.return_type.trim() { cd.return_type.clone() } else { s.return_type.clone() };
            let child_pairs: Vec<(String, String)> = after.iter().filter_map(|p| p.from.as_ref().filter(|f| **f != p.name).map(|f| (f.clone(), p.name.clone()))).collect();
            let list = edits.entry(path.clone()).or_default();
            list.push((cd.header, header(&cd, &cd.modifiers, &s.name, &after, &return_type)));
            list.extend(renames(&parsed, &child_text, &cd, &child_pairs));
            groups.push(Group { callee: Callee::Method { class: child.clone(), name: name.clone() }, owner: Some(child), path: path.clone(), insert_at: insert_point(&parsed, cd.scope), before: cd.params, after });
        }
        // The method it overrides keeps its signature, which PHP may then find incompatible.
        let parents = codebase.get_class_like(o.as_bytes()).and_then(|m| m.overridden_method_ids.get(&mago_word::word(lower.as_bytes())).map(|ids| ids.keys().map(|k| codebase.get_class_like(k.as_bytes()).map_or_else(|| k.as_str_lossy().into_owned(), |m| m.original_name.as_str_lossy().into_owned())).collect::<Vec<_>>())).unwrap_or_default();
        for parent in parents {
            let Some(place) = declaration(&Symbol::Method { class: parent.clone(), name: name.clone() }, codebase) else { continue };
            let Some(path) = ctx.index.path_of(place.file).map(Path::to_path_buf) else { continue };
            let parent_text = ctx.snap.read(&path).unwrap_or_default();
            skipped.push((path, line_of(&parent_text, place.start), format!("{label} overrides {}::{}(), whose signature stays; change it there to change both", short(&parent), d.name)));
        }
    }

    // Each call, by the group of the most specific declaration it reaches: overrides before the method.
    let renamed = s.name != d.name && !constructor;
    let named_arguments = ctx.index.config.php_version.is_at_least(8, 0, 0);
    let mut sites: BTreeMap<PathBuf, Vec<Site>> = BTreeMap::new();
    let mut seen: HashSet<(PathBuf, Span)> = HashSet::new();
    for gi in (0..groups.len()).rev() {
        let g = &groups[gi];
        if !renamed && !moves(&g.before, &g.after) {
            continue;
        }
        // The group's values, read as code of its file at `insert_at`.
        let values = values_of(g);
        let decl_text = texts.entry(g.path.clone()).or_insert_with(|| ctx.snap.read(&g.path).unwrap_or_default()).clone();
        let mut source_text = decl_text[..g.insert_at as usize].to_string();
        let mut spans: Vec<(String, Span)> = vec![];
        for v in &values {
            let at = source_text.len() as u32;
            source_text.push_str(v);
            spans.push((v.clone(), (at, source_text.len() as u32)));
            source_text.push_str(";\n");
        }
        source_text.push_str(&decl_text[g.insert_at as usize..]);
        let arena = LocalArena::new();
        let source = Parsed::new(&arena, &g.path, &source_text);
        for (v, vs) in &spans {
            let is_expression = source.path_at(vs.0).iter().any(|n| matches!(n, Node::Expression(_)) && span(n) == *vs);
            if !is_expression {
                return Err(format!("`{v}` isn't a PHP expression. Check the values in the dialog."));
            }
        }
        let src = Source { parsed: &source, text: &source_text, path: &g.path, owner: g.owner.as_deref() };
        for (path, call_text, found) in calls_of(ctx.snap, &ctx.index, &g.callee) {
            let call_text = texts.entry(path.clone()).or_insert(call_text).clone();
            let doc = Document::new(path_to_uri(&path), path.clone(), "php".into(), 0, call_text.clone());
            let call_arena = LocalArena::new();
            let parsed = Parsed::new(&call_arena, &path, &call_text);
            let resolver = Resolver::new(&parsed, None, codebase);
            for m in found {
                if !seen.insert((path.clone(), m)) {
                    continue;
                }
                let at = parsed.path_at(m.0);
                // A declaration's own name, such as an override's, has its edit.
                if at.iter().any(|n| matches!(n, Node::Method(x) if span(&x.name) == m) || matches!(n, Node::Function(x) if span(&x.name) == m)) {
                    continue;
                }
                let enclosing = resolver.enclosing_class(&at);
                let same_class = matches!((&enclosing, &g.owner), (Some(e), Some(o)) if e.eq_ignore_ascii_case(o));
                let dest = Dest { doc: &doc, parsed: &parsed, offset: m.0, same_class, statik: StaticAs::in_class(same_class) };
                let written = spans
                    .iter()
                    .map(|(v, vs)| {
                        let mut imports = vec![];
                        (v.clone(), moved(&src, *vs, &dest, codebase, vec![], &mut imports).map(|code| (code, imports)))
                    })
                    .collect();
                sites.entry(path.clone()).or_default().push(Site { name: m, group: gi, values: written });
            }
        }
    }

    // Each file's calls, innermost first, so a call takes in the edits inside its arguments and no two overlap.
    let mut calls = 0;
    for (path, list) in sites {
        let call_text = texts[&path].clone();
        let arena = LocalArena::new();
        let parsed = Parsed::new(&arena, &path, &call_text);
        let file_edits = edits.entry(path.clone()).or_default();
        let mut imports: Vec<String> = vec![];
        let first = list.iter().map(|s| s.name.0).min().unwrap_or(0);
        let mut order: Vec<(usize, u32)> = list
            .iter()
            .enumerate()
            .map(|(i, site)| match call_args(&parsed.path_at(site.name.0), site.name) {
                CallArgs::List(l) => (i, l.left_parenthesis.start.offset),
                _ => (i, site.name.0),
            })
            .collect();
        order.sort_by_key(|(_, key)| std::cmp::Reverse(*key));
        for (i, _) in order {
            let site = &list[i];
            let g = &groups[site.group];
            let line = line_of(&call_text, site.name.0);
            let path_nodes = parsed.path_at(site.name.0);
            let args_move = moves(&g.before, &g.after);
            let mut used: Vec<String> = vec![];
            let mut write = |v: &str| -> Result<String, String> {
                let (code, needs) = site.values.get(v).cloned().unwrap_or_else(|| Err(format!("`{v}` can't be read")))?;
                used.extend(needs);
                Ok(code)
            };
            let result: Result<Option<(Span, String)>, String> = match call_args(&path_nodes, site.name) {
                _ if !args_move => Ok(None),
                CallArgs::Callable => Ok(None),
                CallArgs::NotCalled => Err("it isn't a call, such as a callable string".into()),
                CallArgs::Bare(at) => rewrite_args(&[], &g.before, &g.after, named_arguments, &mut write).map(|args| {
                    (!args.is_empty()).then(|| ((at, at), format!("({})", args.iter().map(|a| a.name.as_ref().map_or(a.code.clone(), |n| format!("{n}: {}", a.code))).collect::<Vec<_>>().join(", "))))
                }),
                CallArgs::List(l) => (|| {
                    let region = (l.left_parenthesis.end.offset, l.right_parenthesis.start.offset);
                    let arg_spans: Vec<(Span, Span)> = l
                        .arguments
                        .iter()
                        .map(|a| {
                            let value = match a {
                                Argument::Positional(p) => span(p.value),
                                Argument::Named(n) => span(n.value),
                            };
                            (span(a), value)
                        })
                        .collect();
                    if l.arguments.iter().any(|a| matches!(a, Argument::Positional(p) if p.ellipsis.is_some())) {
                        return Err("it spreads its arguments (...)".to_string());
                    }
                    let inside: Vec<(Span, String)> = file_edits.iter().filter(|(e, _)| e.0 < region.1 && region.0 < e.1).cloned().collect();
                    if inside.iter().any(|(e, _)| !arg_spans.iter().any(|(_, v)| contains(*v, *e))) {
                        return Err("another change touches its arguments".to_string());
                    }
                    let args: Vec<Arg> = l
                        .arguments
                        .iter()
                        .zip(&arg_spans)
                        .enumerate()
                        .map(|(i, (a, (_, v)))| Arg {
                            name: match a {
                                Argument::Named(n) => Some(String::from_utf8_lossy(n.name.value).into_owned()),
                                Argument::Positional(_) => None,
                            },
                            code: rewrite(&call_text, *v, inside.clone()),
                            was: Some(i),
                        })
                        .collect();
                    let new = rewrite_args(&args, &g.before, &g.after, named_arguments, &mut write)?;
                    let same = new.len() == args.len() && new.iter().zip(&args).all(|(n, o)| n.name == o.name && n.was == o.was);
                    if same {
                        return Ok(None);
                    }
                    let comments = arg_comments(&parsed, &call_text, l)?;
                    file_edits.retain(|(e, _)| !inside.iter().any(|(x, _)| x == e));
                    Ok(Some((region, format_args(&call_text, l, &new, &comments))))
                })(),
            };
            match result {
                Ok(edit) => {
                    if edit.is_none() && !renamed {
                        continue;
                    }
                    file_edits.extend(edit);
                    if renamed {
                        let written = slice(&call_text, site.name);
                        let last = written.rsplit('\\').next().unwrap_or(written);
                        file_edits.push(((site.name.1 - last.len() as u32, site.name.1), s.name.clone()));
                    }
                    imports.extend(used);
                    calls += 1;
                }
                Err(why) => skipped.push((path.clone(), line, why)),
            }
        }
        imports.sort();
        imports.dedup();
        if !imports.is_empty() {
            let doc = Document::new(path_to_uri(&path), path.clone(), "php".into(), 0, call_text.clone());
            let lines = LineIndex::new(&call_text);
            for e in import_edits(&doc, parsed.program, first, &imports, NameKind::Default) {
                file_edits.push(((lines.offset(&call_text, e.range.start), lines.offset(&call_text, e.range.end)), e.new_text));
            }
        }
    }

    let mut out = Edits::default();
    let files = edits.values().filter(|l| !l.is_empty()).count();
    for (path, mut list) in edits {
        let t = &texts[&path];
        let lines = LineIndex::new(t);
        list.sort_by_key(|(s, _)| *s);
        list.dedup();
        for (s, new) in list {
            out.add(&path, TextEdit { range: lines.range(t, s.0, s.1), new_text: new });
        }
    }
    let message = format!(
        "Changed {label} and {calls} {} in {files} {}.",
        if calls == 1 { "call" } else { "calls" },
        if files == 1 { "file" } else { "files" }
    );
    Ok((out, skipped, message))
}

/// Introduce Parameter without the dialog: the method or function around the expression at `range` takes `param`
/// before a variadic parameter, or last, and the expression's uses, or all its occurrences, read it.
pub fn add_parameter(ctx: &Ctx<'_>, range: Range, all: bool, param: Param) -> Result<(Edits, Skipped, String), String> {
    let at = ctx.doc.offset(range.start);
    let host = host_at(&ctx.parsed, at).ok_or("Introduce Parameter works inside a method or function.")?;
    let d = read_decl(&ctx.doc.text, host).ok_or("Can't read the declaration.")?;
    let mut params: Vec<Param> = d.params.iter().map(|p| Param { from: Some(p.name.clone()), ..p.clone() }).collect();
    let position = params.iter().position(|p| p.variadic).unwrap_or(params.len());
    let name = param.name.clone();
    params.insert(position, param);
    let s = Signature { modifiers: d.modifiers.clone(), name: d.name.clone(), return_type: d.return_type.clone(), params };
    change(ctx, range.start, &s, Some(&Introduced { range, all, name: Some(name) }))
}

// ---- Requests ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadParams {
    text_document: lsp_types::TextDocumentIdentifier,
    position: Position,
}

/// `tusk/signature`: the method or function around the caret, as the dialog shows it, with its kind and title.
pub fn signature_request(snap: &Snapshot, params: Value) -> Result<Value, String> {
    let p: ReadParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
    with_ctx(snap, &p.text_document.uri, |ctx| read(ctx, p.position)).unwrap_or_else(|| Err(TOO_COMPLEX.into()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IntroducedParams {
    range: Range,
    #[serde(default)]
    all: bool,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangeParams {
    text_document: lsp_types::TextDocumentIdentifier,
    position: Position,
    signature: Signature,
    #[serde(default)]
    introduce: Option<IntroducedParams>,
}

const TOO_COMPLEX: &str = "The file is too complex to refactor, or isn't open.";

/// `tusk/changeSignature`: the edit for a new signature of the method or function around `position`, the calls it
/// couldn't change and other places to look at, with why, and a message.
pub fn change_request(snap: &Snapshot, params: Value) -> Result<Value, String> {
    let p: ChangeParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
    let introduced = p.introduce.map(|i| Introduced { range: i.range, all: i.all, name: i.name });
    let (edits, skipped, message) = with_ctx(snap, &p.text_document.uri, |ctx| change(ctx, p.position, &p.signature, introduced.as_ref())).unwrap_or_else(|| Err(TOO_COMPLEX.into()))?;
    let skipped: Vec<Value> = skipped.into_iter().map(|(path, line, reason)| json!({ "uri": path_to_uri(&path), "line": line, "reason": reason })).collect();
    Ok(json!({ "edit": edits.into_workspace_edit(snap, vec![]), "skipped": skipped, "message": message }))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use lsp_types::{DocumentChanges, OneOf, WorkspaceEdit};

    use super::*;
    use crate::testing::Fixture;
    use crate::text::uri_to_path;

    fn p(from: Option<&str>, name: &str, hint: &str, default: Option<&str>, call: Option<&str>) -> Param {
        Param { from: from.map(String::from), name: name.into(), hint: hint.into(), default_value: default.map(String::from), call_value: call.map(String::from), ..Default::default() }
    }

    fn sig(name: &str, params: Vec<Param>) -> Signature {
        Signature { modifiers: "public".into(), name: name.into(), return_type: String::new(), params }
    }

    fn function(name: &str, return_type: &str, params: Vec<Param>) -> Signature {
        Signature { modifiers: String::new(), name: name.into(), return_type: return_type.into(), params }
    }

    /// Changes the signature at the `<|>` and returns each changed file's text, by file name, and the skipped places.
    fn change(files: &[(&str, &str)], s: Signature) -> Result<(BTreeMap<String, String>, Vec<String>), String> {
        let fx = Fixture::new(files);
        let at = fx.at();
        let v = change_request(&fx.snap, json!({ "textDocument": at.text_document, "position": at.position, "signature": s }))?;
        let edit: WorkspaceEdit = serde_json::from_value(v["edit"].clone()).unwrap();
        let mut out = BTreeMap::new();
        let Some(DocumentChanges::Edits(list)) = edit.document_changes else { panic!("{edit:?}") };
        for e in list {
            let path = uri_to_path(&e.text_document.uri).unwrap();
            let doc = fx.snap.docs.get(&path).unwrap();
            let mut text = doc.text.clone();
            let mut edits: Vec<_> = e.edits.into_iter().map(|e| match e { OneOf::Left(e) => e, OneOf::Right(a) => a.text_edit }).collect();
            edits.sort_by_key(|e| std::cmp::Reverse((doc.offset(e.range.start), doc.offset(e.range.end))));
            for e in edits {
                text.replace_range(doc.offset(e.range.start) as usize..doc.offset(e.range.end) as usize, &e.new_text);
            }
            out.insert(path.file_name().unwrap().to_string_lossy().into_owned(), text);
        }
        let skipped = v["skipped"].as_array().unwrap().iter().map(|s| format!("{}:{}", s["line"], s["reason"].as_str().unwrap())).collect();
        Ok((out, skipped))
    }

    #[test]
    fn reads_the_declaration_for_the_dialog() {
        let fx = Fixture::one("<?php\nclass A\n{\n    public static function make(#[Attr] private readonly int &$a, string ...$rest): ?static\n    {\n        return n<|>ull;\n    }\n}\n");
        let at = fx.at();
        let v = signature_request(&fx.snap, json!({ "textDocument": at.text_document, "position": at.position })).unwrap();
        assert_eq!(v["kind"], "method");
        assert_eq!(v["title"], "A::make");
        let s: Signature = serde_json::from_value(v["signature"].clone()).unwrap();
        assert_eq!((s.modifiers.as_str(), s.name.as_str(), s.return_type.as_str()), ("public static", "make", "?static"));
        assert_eq!(s.params[0].hint, "#[Attr] private readonly int");
        assert!(s.params[0].by_ref && s.params[1].variadic, "{s:?}");
    }

    #[test]
    fn reorders_renames_and_adds_across_files() {
        let files = [
            ("app/Order.php", "<?php\nnamespace App;\n\nclass Order\n{\n    /** @param int $qty how many */\n    public function a<|>dd(string $sku, int $qty = 1): void\n    {\n        echo $sku, $qty;\n    }\n}\n"),
            ("app/use.php", "<?php\nuse App\\Order;\n\nfunction f(Order $o)\n{\n    $o->add('a', 2);\n    $o->add(qty: 3, sku: 'b');\n    $o->add('c');\n}\n"),
        ];
        let mut s = sig("put", vec![p(Some("qty"), "count", "int", Some("1"), None), p(Some("sku"), "sku", "string", None, None), p(None, "note", "?string", Some("null"), None)]);
        s.return_type = "void".into();
        let (files, skipped) = change(&files, s).unwrap();
        assert!(skipped.is_empty(), "{skipped:?}");
        assert!(files["Order.php"].contains("    /** @param int $count how many */\n    public function put(int $count = 1, string $sku, ?string $note = null): void\n    {\n        echo $sku, $count;"), "{}", files["Order.php"]);
        assert!(files["use.php"].contains("    $o->put(2, 'a');\n    $o->put(count: 3, sku: 'b');\n    $o->put(1, 'c');\n"), "{}", files["use.php"]);
    }

    #[test]
    fn writes_values_as_the_declarations_code_means_them() {
        let files = [
            ("app/Order.php", "<?php\nnamespace App;\n\nuse App\\Support\\Money;\n\nclass Order\n{\n    const RATE = 2;\n\n    public function to<|>tal(int $cents): int\n    {\n        return $cents;\n    }\n}\n"),
            ("app/Money.php", "<?php\nnamespace App\\Support;\n\nclass Money { const ZERO = 0; }\n"),
            ("app/use.php", "<?php\nnamespace Shop;\n\nfunction f(\\App\\Order $o)\n{\n    return $o->total(5);\n}\n"),
        ];
        let mut s = sig("total", vec![p(Some("cents"), "cents", "int", None, None), p(None, "rate", "int", None, Some("self::RATE + Money::ZERO"))]);
        s.return_type = "int".into();
        let (files, _) = change(&files, s).unwrap();
        assert!(files["use.php"].contains("use App\\Support\\Money;"), "{}", files["use.php"]);
        assert!(files["use.php"].contains("return $o->total(5, Order::RATE + Money::ZERO);"), "{}", files["use.php"]);
    }

    #[test]
    fn changes_overrides_by_position_and_their_calls() {
        let text = "<?php\nclass A\n{\n    public function m<|>(int $a, int $b): int { return $a - $b; }\n}\nclass B extends A\n{\n    public function m(int $p, int $q): int { return $q - $p; }\n}\nfunction f(A $x, B $y) { return $x->m(1, 2) + $y->m(q: 3, p: 4); }\n";
        let mut s = sig("m", vec![p(Some("b"), "b", "int", None, None), p(Some("a"), "a", "int", None, None)]);
        s.return_type = "int".into();
        let (files, skipped) = change(&[("test.php", text)], s).unwrap();
        assert!(skipped.is_empty(), "{skipped:?}");
        let out = &files["test.php"];
        assert!(out.contains("public function m(int $b, int $a): int { return $a - $b; }"), "{out}");
        assert!(out.contains("public function m(int $q, int $p): int { return $q - $p; }"), "{out}");
        assert!(out.contains("return $x->m(2, 1) + $y->m(q: 3, p: 4);"), "{out}");
    }

    #[test]
    fn passes_new_constructor_arguments_at_new_and_parent_calls() {
        let text = "<?php\nclass A\n{\n    public function __con<|>struct(int $a) {}\n\n    public static function make(): static { return new static(1); }\n}\nclass B extends A\n{\n    public function __construct() { parent::__construct(2); }\n}\nclass C extends A {}\n$x = new A(3);\n$y = new C(4);\n";
        let s = sig("__construct", vec![p(Some("a"), "a", "int", None, None), p(None, "b", "int", None, Some("0"))]);
        let (files, skipped) = change(&[("test.php", text)], s).unwrap();
        assert!(skipped.is_empty(), "{skipped:?}");
        let out = &files["test.php"];
        assert!(out.contains("public function __construct(int $a, int $b) {}"), "{out}");
        for call in ["new static(1, 0)", "parent::__construct(2, 0)", "new A(3, 0)", "new C(4, 0)"] {
            assert!(out.contains(call), "{call}: {out}");
        }
    }

    #[test]
    fn merges_edits_inside_arguments() {
        let text = "<?php\nfunction f<|>(int $a, int $b): int\n{\n    return $a ? f($a - 1, $b) : $b;\n}\necho f(f(1, 2), 3);\n";
        let s = function("f", "int", vec![p(Some("b"), "b", "int", None, None), p(Some("a"), "n", "int", None, None)]);
        let (files, skipped) = change(&[("test.php", text)], s).unwrap();
        assert!(skipped.is_empty(), "{skipped:?}");
        assert_eq!(files["test.php"], "<?php\nfunction f(int $b, int $n): int\n{\n    return $n ? f($b, $n - 1) : $b;\n}\necho f(3, f(2, 1));\n");
    }

    #[test]
    fn keeps_arguments_one_per_line_with_their_comments() {
        let text = "<?php\nfunction f<|>(int $a, int $b) {}\nf(\n    1, // first\n    2,\n);\n";
        let s = function("f", "", vec![p(Some("b"), "b", "int", None, None), p(Some("a"), "a", "int", None, None)]);
        let (files, _) = change(&[("test.php", text)], s).unwrap();
        assert!(files["test.php"].ends_with("f(\n    2,\n    1, // first\n);\n"), "{}", files["test.php"]);
    }

    #[test]
    fn introduces_a_parameter_with_other_changes() {
        let fx = Fixture::one("<?php\nfunction pr<|>ice(int $cents): int\n{\n    return $cents * 100 + 100;\n}\necho price(5);\n");
        let at = fx.at();
        let doc = fx.snap.docs.get(&uri_to_path(&at.text_document.uri).unwrap()).unwrap();
        let start = doc.text.find("100").unwrap() as u32;
        let s = function("price", "int", vec![p(None, "factor", "int", None, Some("100")), p(Some("cents"), "amount", "int", None, None)]);
        let introduce = json!({ "range": doc.range(start, start + 3), "all": true });
        let v = change_request(&fx.snap, json!({ "textDocument": at.text_document, "position": at.position, "signature": s, "introduce": introduce })).unwrap();
        let edit: WorkspaceEdit = serde_json::from_value(v["edit"].clone()).unwrap();
        let Some(DocumentChanges::Edits(list)) = edit.document_changes else { panic!() };
        let mut text = doc.text.clone();
        let mut edits: Vec<_> = list.into_iter().flat_map(|e| e.edits).map(|e| match e { OneOf::Left(e) => e, OneOf::Right(a) => a.text_edit }).collect();
        edits.sort_by_key(|e| std::cmp::Reverse(doc.offset(e.range.start)));
        for e in edits {
            text.replace_range(doc.offset(e.range.start) as usize..doc.offset(e.range.end) as usize, &e.new_text);
        }
        assert_eq!(text, "<?php\nfunction price(int $factor, int $amount): int\n{\n    return $amount * $factor + $factor;\n}\necho price(100, 5);\n");
        assert_eq!(v["message"], "Changed price() and 1 call in 1 file.");
    }

    #[test]
    fn lists_what_it_leaves_and_refuses_what_it_cant_do() {
        let text = "<?php\ninterface I { public function m(int $a): int; }\nclass A implements I\n{\n    public function m<|>(int $a): int { return $a; }\n}\nfunction f(A $x, array $args) { return $x->m(...$args); }\n";
        let mut s = sig("m", vec![p(None, "z", "int", Some("0"), None)]);
        s.return_type = "int".into();
        let (_, skipped) = change(&[("test.php", text)], s).unwrap();
        assert_eq!(skipped, [
            "5:$a is removed, but the body still uses it",
            "2:A::m() overrides I::m(), whose signature stays; change it there to change both",
            "7:it spreads its arguments (...)",
        ]);
        let text = "<?php\nfunction f<|>(int $a) { return compact('a'); }\n";
        let err = change(&[("test.php", text)], function("f", "", vec![p(Some("a"), "b", "int", None, None)])).unwrap_err();
        assert!(err.contains("compact()"), "{err}");
        let text = "<?php\nfunction f<|>(int $a) { $b = 1; return $a + $b; }\n";
        let err = change(&[("test.php", text)], function("f", "", vec![p(Some("a"), "b", "int", None, None)])).unwrap_err();
        assert!(err.contains("$b is already a variable"), "{err}");
        let err = change(&[("test.php", text)], function("f", "", vec![p(Some("a"), "a", "int", None, None), p(None, "c", "int", None, Some("1 +"))])).unwrap_err();
        assert!(err.contains("isn't a PHP expression"), "{err}");
    }
}
