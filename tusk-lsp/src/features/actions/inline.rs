//! Inline Variable, Inline Constant, and Inline Method (⌥⌘N): the extractions in [`super::introduce`] run
//! backwards. A variable's uses take its value, a constant's uses its value, and a call the method's body.
//!
//! The editor asks `tusk/inlineTarget` what the caret is on: what would be inlined, the choices PhpStorm offers
//! (every use and remove the declaration, every use and keep it, or this use only), the uses in the file to
//! highlight while choosing, and warnings, such as a call that would run more than once. `tusk/inline` then
//! returns the edit, with the uses it skipped and why. Other editors get each as a `refactor.inline` code action,
//! which inlines every use it can.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use lsp_types::{Position, Range, TextEdit, Uri, WorkspaceEdit};
use mago_allocator::LocalArena;
use mago_names::kind::NameKind;
use mago_span::HasSpan;
use mago_syntax::cst::{
    Argument, AssignmentOperator, ClassLikeConstantSelector, ClassLikeMemberSelector, Construct, Expression,
    MagicConstant, MethodBody, Node, Statement, TriviaKind, UnaryPrefixOperator, Variable,
};
use mago_syntax::token::{GetPrecedence, Precedence};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::Candidate;
use super::introduce::{contains, free_variables, holds_statements, span, unique, written};
use crate::analysis::Parsed;
use crate::documents::Document;
use crate::features::rename::Edits;
use crate::features::{Ctx, with_ctx};
use crate::imports::{import_edits, reference};
use crate::locate::{declaration, variable_scope, walk};
use crate::server::Snapshot;
use crate::symbol::{Resolver, Symbol};
use crate::text::{LineIndex, path_to_uri};

type Span = (u32, u32);

// ---- Text ----

pub(super) fn slice(text: &str, s: Span) -> &str {
    let len = text.len();
    &text[(s.0 as usize).min(len)..(s.1 as usize).min(len)]
}

/// Code cut to one short line, for a message.
pub(super) fn snippet(text: &str, s: Span) -> String {
    let one = slice(text, s).split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > 40 { format!("{}…", one.chars().take(39).collect::<String>().trim_end()) } else { one }
}

fn line_start(text: &str, at: u32) -> u32 {
    text[..(at as usize).min(text.len())].rfind('\n').map_or(0, |i| i as u32 + 1)
}

/// The offset of the newline ending the line holding `at`, or the end of the text.
fn line_end(text: &str, at: u32) -> u32 {
    let at = (at as usize).min(text.len());
    text[at..].find('\n').map_or(text.len(), |i| at + i) as u32
}

pub(super) fn line_of(text: &str, at: u32) -> u32 {
    text[..(at as usize).min(text.len())].matches('\n').count() as u32 + 1
}

fn indent_at(text: &str, at: u32) -> String {
    super::line_indent(text, at as usize)
}

/// What deletes `s`: its lines when nothing else is on them, with a blank line that would otherwise be left
/// doubled, or next to a brace; else `s` and the spaces after it.
fn deletion(text: &str, s: Span) -> Span {
    let (ls, le) = (line_start(text, s.0), line_end(text, s.1));
    let before = &text[ls as usize..s.0 as usize];
    let after = &text[s.1 as usize..le as usize];
    if !(before.trim().is_empty() && after.trim().is_empty()) {
        let trailing = after.len() - after.trim_start().len();
        return (s.0, s.1 + trailing as u32);
    }
    let end = (le as usize + 1).min(text.len());
    let prev = (ls > 0).then(|| slice(text, (line_start(text, ls - 1), ls - 1)).trim().to_string());
    let next_end = line_end(text, end as u32);
    let next = (end < text.len()).then(|| slice(text, (end as u32, next_end)).trim().to_string());
    match (prev.as_deref(), next.as_deref()) {
        (Some(p), Some("")) if p.is_empty() || p.ends_with('{') => (ls, (next_end as usize + 1).min(text.len()) as u32),
        (Some(""), Some(n)) if n.starts_with('}') => (line_start(text, ls - 1), end as u32),
        _ => (ls, end as u32),
    }
}

/// `s` with the docblock right before it.
pub(super) fn with_docblock(parsed: &Parsed<'_>, text: &str, s: Span) -> Span {
    let before = parsed.program.trivia.iter().rfind(|t| t.kind != TriviaKind::WhiteSpace && span(*t).1 <= s.0);
    match before {
        Some(t) if t.kind == TriviaKind::DocBlockComment && slice(text, (span(t).1, s.0)).trim().is_empty() => (span(t).0, s.1),
        _ => s,
    }
}

/// The spans of the strings in `s` that span lines, which moving code mustn't reindent, and for each whether it's a
/// heredoc or nowdoc that can move whole.
fn multiline_strings(parsed: &Parsed<'_>, text: &str, s: Span) -> Vec<(Span, bool)> {
    let mut out = vec![];
    walk(parsed, |node, _| {
        let doc = matches!(node, Node::DocumentString(_));
        if !(doc || matches!(node, Node::LiteralString(_) | Node::InterpolatedString(_) | Node::ShellExecuteString(_))) {
            return;
        }
        let n = span(&node);
        if contains(s, n) && slice(text, n).contains('\n') {
            out.push((n, doc));
        }
    });
    out
}

/// The edits that move the lines of `s` after its first to `indent`, keeping their indentation past the
/// shallowest one's. A line inside a string keeps its text, unless it's a heredoc whose every line is indented
/// at least that much, which moves whole, since PHP strips its closing marker's indentation from its lines.
fn reindent(parsed: &Parsed<'_>, text: &str, s: Span, indent: &str) -> Vec<(Span, String)> {
    let strings = multiline_strings(parsed, text, s);
    let mut lines: Vec<u32> = vec![];
    let mut at = s.0;
    while let Some(i) = text[at as usize..s.1 as usize].find('\n') {
        at += i as u32 + 1;
        lines.push(at);
    }
    let width = |l: u32| {
        let rest = &text[l as usize..line_end(text, l) as usize];
        (!rest.trim().is_empty()).then(|| rest.len() - rest.trim_start_matches([' ', '\t']).len())
    };
    let inside = |l: u32| strings.iter().find(|((a, b), _)| *a < l && l < *b);
    // The code's own indentation is its first line's.
    let first = line_start(text, s.0);
    let common = slice(text, (first, s.0)).len() - slice(text, (first, s.0)).trim_start_matches([' ', '\t']).len();
    let whole = |(str_span, doc): &(Span, bool)| *doc && lines.iter().filter(|l| str_span.0 < **l && **l < str_span.1).all(|l| width(*l).is_none_or(|w| w >= common));
    lines
        .iter()
        .copied()
        .filter(|l| inside(*l).is_none_or(whole))
        .filter_map(|l| {
            let w = width(l)?;
            Some(((l, l + w.min(common) as u32), indent.to_string()))
        })
        .collect()
}

/// Applies `edits` (spans in `text`, not overlapping) to the part of `text` in `s`.
pub(super) fn rewrite(text: &str, s: Span, mut edits: Vec<(Span, String)>) -> String {
    edits.retain(|(e, _)| contains(s, *e));
    edits.sort_by_key(|(e, _)| *e);
    let mut out = String::new();
    let mut at = s.0;
    for (e, new) in edits {
        if e.0 < at {
            continue;
        }
        out.push_str(slice(text, (at, e.0)));
        out.push_str(&new);
        at = e.1;
    }
    out.push_str(slice(text, (at, s.1)));
    out
}

// ---- Syntax ----

/// The path to the outermost expression spanning exactly `s`, else the outermost node that does.
fn path_to<'a>(parsed: &Parsed<'a>, s: Span) -> Option<Vec<Node<'a, 'a>>> {
    let path = parsed.path_at(s.0);
    let i = path.iter().position(|n| matches!(n, Node::Expression(_)) && span(n) == s).or_else(|| path.iter().position(|n| span(n) == s))?;
    Some(path[..=i].to_vec())
}

/// The path down to the innermost node of `kind` around `s`.
fn path_through<'a>(parsed: &Parsed<'a>, s: Span, kind: impl Fn(&Node<'a, 'a>) -> bool) -> Option<Vec<Node<'a, 'a>>> {
    let path = parsed.path_at(s.0);
    let i = path.iter().rposition(|n| kind(n) && contains(span(n), s))?;
    Some(path[..=i].to_vec())
}

fn expression_of<'a>(path: &[Node<'a, 'a>]) -> Option<&'a Expression<'a>> {
    match path.last()? {
        Node::Expression(e) => Some(*e),
        _ => None,
    }
}

fn unparenthesized<'a>(mut e: &'a Expression<'a>) -> &'a Expression<'a> {
    while let Expression::Parenthesized(p) = e {
        e = p.expression;
    }
    e
}

const SUPERGLOBALS: [&str; 10] = ["this", "GLOBALS", "_GET", "_POST", "_SERVER", "_COOKIE", "_FILES", "_ENV", "_REQUEST", "_SESSION"];

/// Whether running the expression can change something or be seen: a call, `new`, a write, output, or the like.
/// Closures and arrow functions only create a value; what's inside runs later.
fn impure(node: Node<'_, '_>) -> bool {
    fn go(node: Node<'_, '_>, found: &mut bool) {
        if *found || matches!(node, Node::Closure(_) | Node::ArrowFunction(_) | Node::AnonymousClass(_)) {
            return;
        }
        *found = matches!(
            node,
            Node::FunctionCall(_)
                | Node::MethodCall(_)
                | Node::NullSafeMethodCall(_)
                | Node::StaticMethodCall(_)
                | Node::Instantiation(_)
                | Node::Assignment(_)
                | Node::UnaryPostfix(_)
                | Node::Yield(_)
                | Node::Throw(_)
                | Node::Clone(_)
                | Node::Pipe(_)
                | Node::ShellExecuteString(_)
                | Node::IndirectVariable(_)
                | Node::NestedVariable(_)
                | Node::PrintConstruct(_)
                | Node::ExitConstruct(_)
                | Node::DieConstruct(_)
                | Node::EvalConstruct(_)
                | Node::IncludeConstruct(_)
                | Node::IncludeOnceConstruct(_)
                | Node::RequireConstruct(_)
                | Node::RequireOnceConstruct(_)
        ) || matches!(node, Node::UnaryPrefix(u) if matches!(u.operator, UnaryPrefixOperator::PreIncrement(_) | UnaryPrefixOperator::PreDecrement(_)));
        node.visit_children(|c| go(c, found));
    }
    let mut found = false;
    go(node, &mut found);
    found
}

/// Whether the expression at the end of `path` is passed to a parameter that takes it by reference, as
/// `sort($items)` takes `$items`.
fn by_reference(resolver: &Resolver<'_, '_>, path: &[Node<'_, '_>]) -> bool {
    let me = span(path.last().unwrap());
    let Some(at) = path.iter().rposition(|n| matches!(n, Node::ArgumentList(_))) else { return false };
    let Node::ArgumentList(list) = path[at] else { return false };
    // The argument is the use itself, not something it's inside of.
    let Some((i, arg)) = list.arguments.iter().enumerate().find(|(_, a)| contains(span(*a), me)) else { return false };
    let value = match arg {
        Argument::Positional(p) => p.value,
        Argument::Named(n) => n.value,
    };
    if span(unparenthesized(value)) != me {
        return false;
    }
    let name_at = match path.get(at.wrapping_sub(1)) {
        Some(Node::FunctionCall(c)) => span(c.function).0,
        Some(Node::MethodCall(c)) => span(&c.method).0,
        Some(Node::NullSafeMethodCall(c)) => span(&c.method).0,
        Some(Node::StaticMethodCall(c)) => span(&c.method).0,
        _ => return false,
    };
    let Some(found) = resolver.at(name_at) else { return false };
    let codebase = resolver.codebase;
    found.symbols.iter().any(|s| {
        let meta = match s {
            Symbol::Function(f) => codebase.get_function(f.as_bytes()),
            Symbol::Method { class, name } => codebase.get_method(class.as_bytes(), name.as_bytes()),
            _ => None,
        };
        let Some(meta) = meta else { return false };
        let param = match arg {
            Argument::Named(n) => meta.parameters.iter().find(|p| p.get_name().0.as_str_lossy()[1..].as_bytes() == n.name.value),
            Argument::Positional(_) => meta.parameters.get(i).or_else(|| meta.parameters.last().filter(|p| p.flags.is_variadic())),
        };
        param.is_some_and(|p| p.flags.is_by_reference())
    })
}

/// When the code at the end of `path` runs only some of the times the statement around it runs: the condition, as
/// "when $n > 1 is true", from the innermost `&&`, `||`, `??`, ternary, `match` arm, or `?->` around it in the statement.
pub(super) fn runs_only(text: &str, path: &[Node<'_, '_>]) -> Option<String> {
    condition(text, path, false)
}

/// The same, up to the function around it: `if`, `elseif`, and `else` count too.
pub(super) fn runs_only_in_function(text: &str, path: &[Node<'_, '_>]) -> Option<String> {
    condition(text, path, true)
}

fn condition(text: &str, path: &[Node<'_, '_>], through_statements: bool) -> Option<String> {
    let mut in_else = false;
    for i in (1..path.len()).rev() {
        let child = span(&path[i]);
        let clause = match path[i - 1] {
            Node::Closure(_) | Node::ArrowFunction(_) | Node::Function(_) | Node::Method(_) => return None,
            Node::Statement(_) if !through_statements => return None,
            Node::IfStatementBodyElseIfClause(c) if !contains(span(c.condition), child) => Some(format!("when {} is true", snippet(text, span(c.condition)))),
            Node::IfColonDelimitedBodyElseIfClause(c) if !contains(span(c.condition), child) => Some(format!("when {} is true", snippet(text, span(c.condition)))),
            Node::IfStatementBodyElseClause(_) | Node::IfColonDelimitedBodyElseClause(_) => {
                in_else = true;
                None
            }
            Node::If(f) if !contains(span(f.condition), child) => {
                let condition = snippet(text, span(f.condition));
                Some(if in_else { format!("when {condition} is false") } else { format!("when {condition} is true") })
            }
            Node::Binary(b) if contains(span(b.rhs), child) => {
                let lhs = snippet(text, span(b.lhs));
                match b.operator {
                    mago_syntax::cst::BinaryOperator::And(_) | mago_syntax::cst::BinaryOperator::LowAnd(_) => Some(format!("when {lhs} is true")),
                    mago_syntax::cst::BinaryOperator::Or(_) | mago_syntax::cst::BinaryOperator::LowOr(_) => Some(format!("when {lhs} is false")),
                    mago_syntax::cst::BinaryOperator::NullCoalesce(_) => Some(format!("when {lhs} is null")),
                    _ => None,
                }
            }
            Node::Conditional(c) if !contains(span(c.condition), child) => {
                let condition = snippet(text, span(c.condition));
                if contains(span(c.r#else), child) { Some(format!("when {condition} is false")) } else { Some(format!("when {condition} is true")) }
            }
            Node::MatchExpressionArm(arm) if contains(span(arm.expression), child) => {
                let conditions: Vec<String> = arm.conditions.iter().map(|c| snippet(text, span(*c))).collect();
                Some(format!("when the match picks {}", conditions.join(" or ")))
            }
            Node::MatchDefaultArm(arm) if contains(span(arm.expression), child) => Some("when no other match arm applies".to_string()),
            Node::NullSafeMethodCall(c) if !contains(span(c.object), child) => Some(format!("when {} isn't null", snippet(text, span(c.object)))),
            Node::NullSafePropertyAccess(c) if !contains(span(c.object), child) => Some(format!("when {} isn't null", snippet(text, span(c.object)))),
            _ => None,
        };
        if clause.is_some() {
            return clause;
        }
    }
    None
}

/// The nodes of `path` inside the node spanning `scope`, not that node or the ones wrapping it.
fn inside<'p, 'a>(path: &'p [Node<'a, 'a>], scope: Span) -> impl Iterator<Item = &'p Node<'a, 'a>> {
    path.iter().skip_while(move |n| span(*n) != scope).skip_while(move |n| span(*n) == scope)
}

/// The statement around the end of `path` in a list of statements: its index in `path`.
fn statement_in_list(path: &[Node<'_, '_>]) -> Option<usize> {
    (1..path.len()).rev().find(|&i| matches!(path[i], Node::Statement(_)) && holds_statements(&path[i - 1]))
}

/// Every DirectVariable `$name` in the scope `scope`, with its path, but not an arrow function's own parameter
/// of that name.
fn occurrences<'a>(parsed: &Parsed<'a>, name: &str, scope: Span) -> Vec<(Span, Vec<Node<'a, 'a>>)> {
    let target = format!("${name}");
    let mut out = vec![];
    walk(parsed, |node, ancestors| {
        let Node::DirectVariable(v) = node else { return };
        if v.name != target.as_bytes() {
            return;
        }
        let mut path = ancestors.to_vec();
        path.push(node);
        if variable_scope(parsed, &path) != scope {
            return;
        }
        let shadowed = path.iter().any(|n| matches!(n, Node::ArrowFunction(f) if f.parameter_list.parameters.iter().any(|p| p.variable.name == target.as_bytes())));
        if !shadowed {
            out.push((span(&node), path));
        }
    });
    out
}

/// Whether the scope reads its variables by name, so no variable in it can be renamed or removed.
pub(super) fn reads_by_name(parsed: &Parsed<'_>, scope: Span) -> Option<String> {
    let mut found = None;
    walk(parsed, |node, _| {
        if found.is_some() || !contains(scope, span(&node)) {
            return;
        }
        found = match node {
            Node::FunctionCall(c) => match c.function {
                Expression::Identifier(id) => {
                    let name = String::from_utf8_lossy(id.value()).to_ascii_lowercase();
                    let name = name.trim_start_matches('\\');
                    ["compact", "extract", "get_defined_vars", "func_get_args", "func_get_arg", "func_num_args", "eval"].contains(&name).then(|| format!("{name}()"))
                }
                _ => None,
            },
            Node::IndirectVariable(_) | Node::NestedVariable(_) => Some("$$".into()),
            Node::EvalConstruct(_) => Some("eval()".into()),
            _ => None,
        };
    });
    found
}

// ---- Placing a value ----

/// What decides how an expression must be written where another one stood.
#[derive(Clone, Copy, Debug)]
struct Shape {
    precedence: Precedence,
    /// It can be followed by `->`, `[`, `(`, or `::` as it is.
    dereferencable: bool,
    /// A plain variable, as `$total`.
    variable: bool,
    /// It starts with `$`, so it can go in braces in a string.
    dollar: bool,
    /// It starts with a sign, which mustn't touch another one: `- -1`, not `--1`.
    sign: bool,
}

fn shape(e: &Expression<'_>, text: &str) -> Shape {
    let precedence = match e {
        Expression::Binary(b) => b.operator.precedence(),
        Expression::UnaryPrefix(u) => u.operator.precedence(),
        Expression::UnaryPostfix(u) => u.operator.precedence(),
        Expression::Conditional(_) => Precedence::ElvisOrConditional,
        Expression::Assignment(_) => Precedence::Assignment,
        Expression::Yield(_) => Precedence::Yield,
        Expression::Construct(Construct::Print(_)) => Precedence::Print,
        Expression::Construct(Construct::Include(_) | Construct::IncludeOnce(_) | Construct::Require(_) | Construct::RequireOnce(_)) => Precedence::Lowest,
        Expression::ArrowFunction(_) | Expression::Throw(_) => Precedence::Lowest,
        Expression::Clone(_) => Precedence::Clone,
        Expression::Pipe(_) => Precedence::Pipe,
        Expression::Instantiation(i) if i.argument_list.is_none() => Precedence::New,
        _ => Precedence::Highest,
    };
    let dereferencable = matches!(
        e,
        Expression::Variable(_) | Expression::Call(_) | Expression::Access(_) | Expression::ArrayAccess(_) | Expression::Parenthesized(_) | Expression::Array(_) | Expression::LegacyArray(_)
    ) || matches!(e, Expression::Literal(mago_syntax::cst::Literal::String(_)));
    let written = slice(text, span(e));
    Shape {
        precedence,
        dereferencable,
        variable: matches!(e, Expression::Variable(Variable::Direct(_))),
        dollar: written.starts_with('$') && dereferencable,
        sign: written.starts_with(['-', '+']),
    }
}

/// The shape of code that's been rewritten, read again.
fn shape_of_code(code: &str) -> Shape {
    let arena = LocalArena::new();
    let source = format!("<?php {code};");
    let parsed = Parsed::exact(&arena, Path::new("/inline.php"), &source);
    let expression = parsed.program.statements.iter().find_map(|s| match s {
        Statement::Expression(e) => Some(e.expression),
        _ => None,
    });
    match expression {
        Some(e) => shape(e, &source),
        None => Shape { precedence: Precedence::Lowest, dereferencable: false, variable: false, dollar: false, sign: false },
    }
}

fn right_associative(p: Precedence) -> bool {
    matches!(p, Precedence::Pow | Precedence::NullCoalesce | Precedence::Assignment)
}

fn non_associative(p: Precedence) -> bool {
    matches!(p, Precedence::Equality | Precedence::Comparison | Precedence::Instanceof)
}

/// How `value`, of shape `s`, is written to stand where the node at the end of `path` stands in `text`: the span
/// it replaces and the text. Parentheses go around it where the code around would bind tighter, and braces in a
/// string, where only a variable, or a value starting with `$` in braces, can go.
fn placed(value: &str, s: Shape, path: &[Node<'_, '_>], text: &str) -> Result<(Span, String), String> {
    let at = span(path.last().unwrap());
    let place = Placement::of(text, path);
    if let UseKind::StringSimple { part } = place.kind
        && !s.variable
        && s.dollar
    {
        return Ok((part, format!("{{{}}}", rewrite(text, part, vec![(at, value.to_string())]))));
    }
    place.write(value, s).map(|t| (at, t)).ok_or_else(|| "it's used in a string, where only a value that starts with $ can go".into())
}

// ---- Moving code ----

/// Where code comes from: its file's syntax and text, and the class it's in.
#[derive(Clone, Copy)]
pub(super) struct Source<'s, 'a> {
    pub parsed: &'s Parsed<'a>,
    pub text: &'s str,
    pub path: &'s Path,
    pub owner: Option<&'s str>,
}

/// Where code goes: the file, the offset in it, and how `self`, `static`, and `parent` can be kept there.
pub(super) struct Dest<'s, 'a> {
    pub doc: &'s Document,
    pub parsed: &'s Parsed<'a>,
    pub offset: u32,
    /// The class around the place is the owner, so `self` and `parent` mean the same.
    pub same_class: bool,
    /// What `static` becomes there.
    pub statik: StaticAs,
}

/// What `static` in moved code becomes: kept where it means the same class, written as the class or object it
/// means (`Sub`, `$order`), or refused with the reason.
pub(super) enum StaticAs {
    Keep,
    Write(String),
    Unknown(String),
}

impl StaticAs {
    /// Kept in the owner's own class, and else unknown.
    pub(super) fn in_class(same_class: bool) -> Self {
        if same_class { StaticAs::Keep } else { StaticAs::Unknown("it uses static::, which means the object's own class".into()) }
    }
}

/// The text of `s` in `src`, written to mean the same at `dest`: class names as the file there writes them (the
/// imports it needs go in `imports`), functions and constants of a namespace in full, and `self`, `static`,
/// `parent`, and `__CLASS__` naming the owner where they'd mean another class. `extra` holds other replacements.
pub(super) fn moved(src: &Source<'_, '_>, s: Span, dest: &Dest<'_, '_>, codebase: &mago_codex::metadata::CodebaseMetadata, mut extra: Vec<(Span, String)>, imports: &mut Vec<String>) -> Result<String, String> {
    let same_file = src.path == dest.doc.path;
    let owner_name = |imports: &mut Vec<String>| -> Option<String> {
        let owner = src.owner?;
        let r = reference(dest.doc, dest.parsed.program, dest.offset, owner, NameKind::Default);
        if r.edit.is_some() {
            imports.push(owner.trim_start_matches('\\').to_string());
        }
        Some(r.name)
    };
    let mut error = None;
    let mut keyword_edits = vec![];
    let mut static_edits = vec![];
    walk(src.parsed, |node, ancestors| {
        if error.is_some() || !contains(s, span(&node)) {
            return;
        }
        let n = span(&node);
        match node {
            Node::Expression(Expression::Self_(_)) if !dest.same_class => keyword_edits.push((n, None)),
            Node::Expression(Expression::Static(_)) => match &dest.statik {
                StaticAs::Keep => {}
                // A closure sees no outer variable it doesn't `use`; an arrow function sees them all.
                StaticAs::Write(v) if v.starts_with('$') && ancestors.iter().any(|a| matches!(a, Node::Closure(_)) && contains(s, span(a))) => {
                    error = Some(format!("it uses static:: inside a closure, which can't see {v}"));
                }
                StaticAs::Write(v) => static_edits.push((n, v.clone())),
                StaticAs::Unknown(why) => error = Some(why.clone()),
            },
            Node::Expression(Expression::Parent(_)) if !dest.same_class => error = Some("it uses parent::, which means another class there".to_string()),
            Node::MagicConstant(MagicConstant::Class(_)) if !dest.same_class => keyword_edits.push((n, Some("::class"))),
            Node::MagicConstant(MagicConstant::Function(_) | MagicConstant::Method(_)) => error = Some("it uses __FUNCTION__ or __METHOD__, which would name another function there".to_string()),
            _ => {}
        }
    });
    if let Some(e) = error {
        return Err(e);
    }
    extra.extend(static_edits);
    for (n, suffix) in keyword_edits {
        let name = owner_name(imports).ok_or("it uses self outside a class")?;
        extra.push((n, format!("{name}{}", suffix.unwrap_or(""))));
    }
    if !same_file {
        for (start, end, fqn, imported) in src.parsed.names.iter() {
            if !contains(s, (start, end)) || extra.iter().any(|(e, _)| contains(*e, (start, end))) {
                continue;
            }
            let fqn = String::from_utf8_lossy(fqn).into_owned();
            let written = slice(src.text, (start, end));
            if ["self", "static", "parent"].iter().any(|k| written.eq_ignore_ascii_case(k)) {
                continue;
            }
            let path = src.parsed.path_at(start);
            let at = path.iter().rposition(|n| span(n) == (start, end)).unwrap_or(path.len().saturating_sub(1));
            let parent = path[..at].iter().rev().find(|n| span(*n) != (start, end));
            let kind = match parent {
                Some(Node::FunctionCall(_)) => NameKind::Function,
                Some(Node::ConstantAccess(_)) => NameKind::Constant,
                _ if matches!(path.get(at), Some(Node::Expression(Expression::ConstantAccess(_)))) => NameKind::Constant,
                _ => NameKind::Default,
            };
            let new = match kind {
                NameKind::Default => {
                    let r = reference(dest.doc, dest.parsed.program, dest.offset, &fqn, NameKind::Default);
                    if r.edit.is_some() {
                        imports.push(fqn.clone());
                    }
                    r.name
                }
                _ if written.starts_with('\\') => continue,
                // A function or constant of a namespace, written short, is that one only if it exists; else PHP
                // falls back to the global one, which needs no change.
                _ => {
                    let exists = if kind == NameKind::Function { codebase.function_exists(fqn.as_bytes()) } else { codebase.constant_exists(fqn.as_bytes()) };
                    if (imported || exists) && fqn.contains('\\') { format!("\\{fqn}") } else { continue }
                }
            };
            if new != written {
                extra.push(((start, end), new));
            }
        }
    }
    Ok(rewrite(src.text, s, extra))
}

// ---- Plans ----

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Every use, and the declaration goes.
    All,
    /// Every use, keeping the declaration.
    Keep,
    /// The use at the caret only.
    This,
}

#[derive(Serialize)]
struct Choice {
    mode: Mode,
    label: String,
    detail: Option<String>,
    /// What this choice alone would run differently.
    warning: Option<String>,
    /// The places in the file it changes.
    highlight: Vec<Range>,
}

/// What `tusk/inlineTarget` tells the editor.
#[derive(Serialize)]
pub struct Target {
    kind: &'static str,
    title: String,
    choices: Vec<Choice>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
struct Skipped {
    uri: Uri,
    line: u32,
    reason: String,
}

/// The edit `tusk/inline` returns, the uses it left, and a message for the status bar.
pub struct Outcome {
    edits: Edits,
    skipped: Vec<(PathBuf, u32, String)>,
    message: String,
}

enum Asked {
    Target,
    Edit(Mode),
}

enum Answer {
    Target(Target),
    Edit(Outcome),
}

fn choices_for(count: usize, here: bool, what: &str, removable: Result<(), String>, all: Vec<Range>, this: Vec<Range>) -> Vec<Choice> {
    let n = if count == 1 { "the only use".to_string() } else { format!("all {count} uses") };
    let mut out = vec![];
    match removable {
        Ok(()) => out.push(Choice { mode: Mode::All, label: format!("Inline {n} and remove the {what}"), detail: None, warning: None, highlight: all.clone() }),
        Err(why) => out.push(Choice { mode: Mode::Keep, label: format!("Inline {n} and keep the {what}"), detail: Some(why), warning: None, highlight: all.clone() }),
    }
    if here && count > 1 {
        out.push(Choice { mode: Mode::This, label: "Inline this use only".into(), detail: None, warning: None, highlight: this });
    }
    out
}

fn run(ctx: &Ctx<'_>, position: Position, asked: Asked) -> Result<Answer, String> {
    let offset = ctx.offset(position);
    // A variable: right at the caret, or ending just before it.
    let path = ctx.parsed.path_at(offset);
    let variable = path.last().filter(|n| matches!(n, Node::DirectVariable(_))).map(|_| path.clone()).or_else(|| {
        let before = ctx.parsed.path_at(offset.saturating_sub(1));
        before.last().filter(|n| matches!(n, Node::DirectVariable(_)) && span(*n).1 == offset).map(|_| before.clone())
    });
    if let Some(path) = variable {
        return inline_variable(ctx, &path, asked);
    }
    let found = ctx.symbol_at(position).or_else(|| ctx.resolver().at(offset.saturating_sub(1)));
    let Some(found) = found else { return Err(NOTHING.into()) };
    match found.symbols.first() {
        Some(Symbol::ClassConstant { .. } | Symbol::Constant(_)) => inline_constant(ctx, &found, asked),
        Some(Symbol::Method { .. } | Symbol::Function(_)) => {
            if found.symbols.len() > 1 {
                return Err("The call may run one of several methods, depending on the object.".into());
            }
            inline_method(ctx, &found, asked)
        }
        _ => Err(NOTHING.into()),
    }
}

const NOTHING: &str = "Put the cursor on a variable, a constant, or a method or function call to inline it.";

// ---- Inline Variable ----

fn inline_variable(ctx: &Ctx<'_>, path: &[Node<'_, '_>], asked: Asked) -> Result<Answer, String> {
    let text = ctx.parsed.text();
    let Node::DirectVariable(v) = path.last().unwrap() else { unreachable!() };
    let name = String::from_utf8_lossy(&v.name[1..]).into_owned();
    let fail = |why: String| format!("Can't inline ${name}: {why}");
    if SUPERGLOBALS.contains(&name.as_str()) {
        return Err(format!("${name} isn't a local variable, so it can't be inlined."));
    }
    let scope = variable_scope(&ctx.parsed, path);
    if let Some(how) = reads_by_name(&ctx.parsed, scope) {
        return Err(fail(format!("the code reads its variables by name, with {how}.")));
    }
    // A parameter, or a closure's captured variable, gets its value from outside.
    let parameter = path.iter().rev().find(|n| span(*n) == scope).is_some_and(|f| {
        let params = match f {
            Node::Function(f) => Some(&f.parameter_list),
            Node::Method(m) => Some(&m.parameter_list),
            Node::Closure(c) => Some(&c.parameter_list),
            _ => None,
        };
        params.is_some_and(|l| l.parameters.iter().any(|p| p.variable.name == v.name))
    });
    if parameter {
        return Err(fail("it's a parameter, so its value comes from each call.".into()));
    }
    let captured = path.iter().rev().find(|n| span(*n) == scope).is_some_and(|f| matches!(f, Node::Closure(c) if c.use_clause.as_ref().is_some_and(|u| u.variables.iter().any(|x| x.variable.name == v.name))));
    if captured {
        return Err(fail("a closure captures it with use (…), so its value comes from outside the closure.".into()));
    }
    let all = occurrences(&ctx.parsed, &name, scope);
    let resolver = ctx.resolver();
    let mut assignment: Option<(Span, Span, &Expression<'_>)> = None;
    let mut uses: Vec<(Span, Vec<Node<'_, '_>>)> = vec![];
    for (s, p) in &all {
        if p.iter().any(|n| matches!(n, Node::ClosureUseClause(_))) {
            return Err(fail(format!("a closure captures it with use (line {}).", line_of(text, s.0))));
        }
        if p.iter().any(|n| matches!(n, Node::Global(_) | Node::Static(_))) {
            return Err(fail("it's a global or static variable.".into()));
        }
        if !written(p) && !by_reference(&resolver, p) {
            uses.push((*s, p.clone()));
            continue;
        }
        // A write: the assignment, as a statement of its own, or something else that changes it.
        let at = p.len() - 1;
        let plain = p[..at].iter().rposition(|n| matches!(n, Node::Assignment(_))).and_then(|i| {
            let Node::Assignment(a) = p[i] else { return None };
            let lhs = matches!(a.lhs, Expression::Variable(Variable::Direct(_))) && span(a.lhs) == *s;
            let statement = p[..i].iter().rposition(|n| matches!(n, Node::ExpressionStatement(_)))?;
            let Node::ExpressionStatement(st) = p[statement] else { return None };
            (lhs && matches!(a.operator, AssignmentOperator::Assign(_)) && span(st.expression) == span(&p[i]) && matches!(p[statement - 1], Node::Statement(_)) && holds_statements(&p[statement.saturating_sub(2)]))
                .then(|| (span(&p[statement - 1]), a.rhs))
        });
        match (plain, assignment) {
            (Some((statement, rhs)), None) => assignment = Some((statement, *s, rhs)),
            (Some(_), Some((first, ..))) => {
                return Err(fail(format!("it's assigned more than once, on lines {} and {}.", line_of(text, first.0), line_of(text, s.0))));
            }
            (None, _) => return Err(fail(format!("it's changed on line {}, which isn't a plain assignment.", line_of(text, s.0)))),
        }
    }
    let Some((statement, target, rhs)) = assignment else { return Err(fail("it isn't assigned here.".into())) };
    let value = unparenthesized(rhs);
    let value_span = span(value);
    if let Some((s, _)) = uses.iter().find(|(s, _)| s.0 < statement.1) {
        return Err(fail(format!("it's used on line {} before it's assigned.", line_of(text, s.0))));
    }
    if uses.is_empty() {
        return Err(fail("it's never used. Safe Delete (⌘⌦) removes it.".into()));
    }
    // The statement list holding the assignment must hold the uses too.
    let assigned_path = all.iter().find(|(s, _)| *s == target).map(|(_, p)| p.clone()).unwrap();
    let holder = statement_in_list(&assigned_path).map(|i| span(&assigned_path[i - 1])).unwrap_or(scope);
    if let Some((s, _)) = uses.iter().find(|(s, _)| !contains(holder, *s)) {
        return Err(fail(format!("it's assigned inside a block, and used after it on line {}.", line_of(text, s.0))));
    }
    // The variables the value reads must hold the same until the last use.
    let last = uses.iter().map(|(s, _)| s.1).max().unwrap();
    let loops: Vec<Span> = uses.iter().flat_map(|(_, p)| p.iter().filter(|n| matches!(n, Node::While(_) | Node::DoWhile(_) | Node::For(_) | Node::Foreach(_))).map(span).filter(|l| !contains(*l, statement)).collect::<Vec<_>>()).collect();
    for read in free_variables(Node::Expression(value)) {
        if read == "this" {
            continue;
        }
        for (s, p) in occurrences(&ctx.parsed, &read, scope) {
            let between = s.0 > statement.1 && s.0 < last;
            let in_loop = loops.iter().any(|l| contains(*l, s));
            if (between || in_loop) && (written(&p) || by_reference(&resolver, &p)) {
                return Err(fail(format!("${read} changes on line {}, between the assignment and a use.", line_of(text, s.0))));
            }
        }
    }
    let value_shape = shape(value, text);
    let use_indent = |s: Span| indent_at(text, s.0);
    let value_text = |s: Span| rewrite(text, value_span, reindent(&ctx.parsed, text, value_span, &use_indent(s)));
    let mut replacements = vec![];
    for (s, p) in &uses {
        let at = (1..=p.len()).rev().map(|i| &p[..i]).find(|q| matches!(q.last(), Some(Node::Expression(_))) && span(q.last().unwrap()) == *s).unwrap_or(p);
        replacements.push(placed(&value_text(*s), value_shape, at, text).map_err(|e| fail(format!("{e} (line {}).", line_of(text, s.0))))?);
    }

    let snip = snippet(text, value_span);
    let mut warnings = vec![];
    let runs_more = impure(Node::Expression(value));
    if runs_more {
        if !loops.is_empty() {
            warnings.push(format!("{snip} will run on every pass of the loop."));
        } else if uses.iter().any(|(_, p)| p.iter().any(|n| matches!(n, Node::ArrowFunction(_)))) {
            warnings.push(format!("{snip} will run each time the arrow function runs."));
        } else if uses.len() == 1 {
            let first = uses[0].0;
            let mut between = false;
            walk(&ctx.parsed, |node, _| between |= contains((statement.1, first.0), span(&node)) && impure(node));
            if between {
                warnings.push(format!("{snip} will run later, after the code between the assignment and the use."));
            }
        }
        for (_, p) in &uses {
            if let Some(when) = runs_only(text, p) {
                warnings.push(format!("{snip} will run only {when}."));
                break;
            }
        }
    }
    let here = uses.iter().position(|(s, _)| contains(*s, span(path.last().unwrap())));
    let range = |s: Span| ctx.doc.range(s.0, s.1);
    match asked {
        Asked::Target => {
            let mut choices = choices_for(uses.len(), here.is_some(), "variable", Ok(()), uses.iter().map(|(s, _)| range(*s)).collect(), here.map(|i| range(uses[i].0)).into_iter().collect());
            // A call runs once for each place that gets it, and once more in the assignment that stays.
            for c in choices.iter_mut().filter(|_| runs_more) {
                c.warning = match c.mode {
                    Mode::This => Some(format!("{snip} will run twice: in the assignment and here.")),
                    _ if uses.len() > 1 => Some(format!("{snip} will run {} times instead of once.", uses.len())),
                    _ => None,
                };
            }
            Ok(Answer::Target(Target { kind: "variable", title: format!("Inline ${name} = {snip}"), choices, warnings }))
        }
        Asked::Edit(mode) => {
            let mut edits = Edits::default();
            let chosen: Vec<usize> = match (mode, here) {
                (Mode::This, Some(i)) => vec![i],
                (Mode::This, None) => return Err("Put the cursor on a use of the variable to inline that use.".into()),
                _ => (0..uses.len()).collect(),
            };
            for i in &chosen {
                let (s, t) = &replacements[*i];
                edits.add(&ctx.doc.path, TextEdit { range: range(*s), new_text: t.clone() });
            }
            let removed = chosen.len() == uses.len();
            if removed {
                edits.add(&ctx.doc.path, TextEdit { range: range(deletion(text, statement)), new_text: String::new() });
            }
            let n = chosen.len();
            let message = format!("Inlined ${name} in {n} {}{}.", if n == 1 { "place" } else { "places" }, if removed { " and removed it" } else { "" });
            Ok(Answer::Edit(Outcome { edits, skipped: vec![], message }))
        }
    }
}

// ---- Inline Constant ----

fn inline_constant(ctx: &Ctx<'_>, found: &crate::symbol::Found, asked: Asked) -> Result<Answer, String> {
    let symbol = found.symbols[0].clone();
    let codebase = &ctx.index.codebase;
    let (owner, name) = match &symbol {
        Symbol::ClassConstant { class, name } => {
            if codebase.get_enum_case(class.as_bytes(), name.as_bytes()).is_some() {
                return Err(format!("{name} is an enum case, an object rather than a value, so it can't be inlined."));
            }
            let declaring = codebase.get_class_constant(class.as_bytes(), name.as_bytes()).map(|_| {
                // Constants aren't tracked by declaring class: the first ancestor that has it declares it.
                let mut owner = class.clone();
                for a in std::iter::once(mago_word::word(class.as_bytes())).chain(codebase.get_class_ancestors(class.as_bytes())) {
                    if let Some(meta) = codebase.get_class_like(a.as_bytes())
                        && meta.constants.keys().any(|k| k.as_str_lossy() == *name)
                    {
                        owner = meta.original_name.as_str_lossy().into_owned();
                        break;
                    }
                }
                owner
            });
            (declaring, name.clone())
        }
        Symbol::Constant(name) => (None, name.clone()),
        _ => unreachable!(),
    };
    let label = match &owner {
        Some(o) => format!("{}::{name}", o.rsplit('\\').next().unwrap_or(o)),
        None => name.clone(),
    };
    let symbol = match &owner {
        Some(o) => Symbol::ClassConstant { class: o.clone(), name: name.clone() },
        None => symbol,
    };
    let fail = |why: &str| format!("Can't inline {label}: {why}");
    let place = declaration(&symbol, codebase).ok_or_else(|| fail("its declaration isn't in the project."))?;
    let decl_path = ctx.index.path_of(place.file).map(Path::to_path_buf).ok_or_else(|| fail("it's built into PHP."))?;
    if !ctx.index.is_project_file(place.file) {
        return Err(fail("it's declared in a library."));
    }
    if let Some(o) = &owner {
        let lower = name.as_str();
        if let Some(child) = super::super::navigation::descendants(codebase, o).into_iter().find(|c| codebase.get_class_like(c.as_bytes()).is_some_and(|m| m.constants.keys().any(|k| k.as_str_lossy() == lower))) {
            return Err(fail(&format!("{child} declares it again, so static::{name} can mean another value.")));
        }
    }
    let arena = LocalArena::new();
    let decl_text = if decl_path == ctx.doc.path { ctx.doc.text.clone() } else { ctx.snap.read(&decl_path).ok_or_else(|| fail("its file can't be read."))? };
    let own = decl_path == ctx.doc.path;
    let other;
    let decl: &Parsed<'_> = if own {
        &ctx.parsed
    } else {
        other = Parsed::new(&arena, &decl_path, &decl_text);
        &other
    };
    // The item, its statement, and its value.
    let mut item: Option<(Span, Span, usize, &Expression<'_>)> = None;
    walk(decl, |node, ancestors| {
        let (name_span, value) = match node {
            Node::ClassLikeConstantItem(i) => (span(&i.name), i.value),
            Node::ConstantItem(i) => (span(&i.name), i.value),
            _ => return,
        };
        if name_span.0 != place.start {
            return;
        }
        let Some(statement) = ancestors.iter().rev().find(|n| matches!(n, Node::ClassLikeConstant(_) | Node::Constant(_))) else { return };
        let count = match statement {
            Node::ClassLikeConstant(c) => c.items.len(),
            Node::Constant(c) => c.items.len(),
            _ => 1,
        };
        item = Some((span(&node), span(statement), count, value));
    });
    let Some((item_span, statement, count, value)) = item else { return Err(fail("it's declared with define(), which can't be read as code.")) };
    let decl_text = decl.text();
    let value_shape = shape(unparenthesized(value), decl_text);
    let value_span = span(unparenthesized(value));

    // Every use, without the declaration.
    let mut uses: Vec<(PathBuf, Span)> = vec![];
    for (path, text, spans) in crate::features::references::search(ctx.snap, &ctx.index, std::slice::from_ref(&symbol)) {
        let arena = LocalArena::new();
        let parsed = Parsed::new(&arena, &path, &text);
        for s in spans {
            if path == decl_path && contains(item_span, s) {
                continue;
            }
            let access = path_through(&parsed, s, |n| matches!(n, Node::ClassConstantAccess(_) | Node::ConstantAccess(_))).map(|p| span(p.last().unwrap()));
            uses.push((path.clone(), access.unwrap_or(s)));
        }
    }
    uses.sort();
    if uses.is_empty() {
        return Err(fail("nothing uses it. Safe Delete (⌘⌦) removes it."));
    }
    let caret = found.start;
    let here = uses.iter().position(|(p, s)| *p == ctx.doc.path && s.0 <= caret && caret <= s.1);
    let range = |s: Span| ctx.doc.range(s.0, s.1);
    let in_file: Vec<Range> = uses.iter().filter(|(p, _)| *p == ctx.doc.path).map(|(_, s)| range(*s)).collect();
    let value_snip = snippet(decl_text, value_span);
    let _ = value_span;
    let mode = match asked {
        Asked::Target => {
            return Ok(Answer::Target(Target {
                kind: "constant",
                title: format!("Inline {label} = {value_snip}"),
                choices: choices_for(uses.len(), here.is_some(), "constant", Ok(()), in_file, here.map(|i| range(uses[i].1)).into_iter().collect()),
                warnings: vec![],
            }));
        }
        Asked::Edit(m) => m,
    };
    let chosen: Vec<usize> = match (mode, here) {
        (Mode::This, Some(i)) => vec![i],
        (Mode::This, None) => return Err("Put the cursor on a use of the constant to inline that use.".into()),
        _ => (0..uses.len()).collect(),
    };
    let src = Source { parsed: decl, text: decl_text, path: &decl_path, owner: owner.as_deref() };
    let mut edits = Edits::default();
    let mut skipped = vec![];
    let mut done = 0;
    let mut by_file: Vec<(PathBuf, Vec<Span>)> = vec![];
    for i in chosen {
        let (p, s) = &uses[i];
        match by_file.iter_mut().find(|(q, _)| q == p) {
            Some((_, list)) => list.push(*s),
            None => by_file.push((p.clone(), vec![*s])),
        }
    }
    for (path, spans) in by_file {
        let text = if path == ctx.doc.path { ctx.doc.text.clone() } else { ctx.snap.read(&path).unwrap_or_default() };
        let doc = Document::new(path_to_uri(&path), path.clone(), "php".into(), 0, text.clone());
        let arena = LocalArena::new();
        let parsed = Parsed::new(&arena, &path, &text);
        let resolver = Resolver::new(&parsed, None, codebase);
        let lines = LineIndex::new(&text);
        let mut imports = vec![];
        let spans_start = spans[0].0;
        for s in spans {
            let Some(at) = path_to(&parsed, s) else { continue };
            let enclosing = resolver.enclosing_class(&at);
            let same_class = matches!((&enclosing, &owner), (Some(e), Some(o)) if e.eq_ignore_ascii_case(o));
            let dest = Dest { doc: &doc, parsed: &parsed, offset: s.0, same_class, statik: StaticAs::in_class(same_class) };
            let result = constant_visible(codebase, &src, value_span, owner.as_deref(), enclosing.as_deref())
                .and_then(|()| moved(&src, value_span, &dest, codebase, vec![], &mut imports))
                .and_then(|v| placed(&v, value_shape, &at, &text));
            match result {
                Ok((r, t)) => {
                    edits.add(&path, TextEdit { range: lines.range(&text, r.0, r.1), new_text: t });
                    done += 1;
                }
                Err(why) => skipped.push((path.clone(), line_of(&text, s.0), why)),
            }
        }
        imports.sort();
        imports.dedup();
        for e in import_edits(&doc, parsed.program, spans_start, &imports, NameKind::Default) {
            edits.add(&path, e);
        }
    }
    let removed = mode == Mode::All && done == uses.len();
    if removed {
        let delete = if count == 1 { deletion(decl_text, with_docblock(decl, decl_text, statement)) } else { item_with_comma(decl_text, item_span) };
        let lines = LineIndex::new(decl_text);
        edits.add(&decl_path, TextEdit { range: lines.range(decl_text, delete.0, delete.1), new_text: String::new() });
    }
    let message = format!("Inlined {label} in {done} {}{}.", if done == 1 { "place" } else { "places" }, if removed { " and removed it" } else { "" });
    Ok(Answer::Edit(Outcome { edits, skipped, message }))
}

/// One item of a declaration of several, with the comma that separates it from the next or the one before.
fn item_with_comma(text: &str, s: Span) -> Span {
    let after = &text[s.1 as usize..];
    let trimmed = after.trim_start();
    if trimmed.starts_with(',') {
        let comma = s.1 + (after.len() - trimmed.len()) as u32 + 1;
        let rest = &text[comma as usize..];
        return (s.0, comma + (rest.len() - rest.trim_start().len()) as u32);
    }
    let before = text[..s.0 as usize].trim_end();
    (before.strip_suffix(',').map_or(s.0, |b| b.len() as u32), s.1)
}

/// Whether the class constants a value names through `self` or `static` can be read where it goes.
fn constant_visible(codebase: &mago_codex::metadata::CodebaseMetadata, src: &Source<'_, '_>, s: Span, owner: Option<&str>, enclosing: Option<&str>) -> Result<(), String> {
    let Some(owner) = owner else { return Ok(()) };
    let mut error = Ok(());
    walk(src.parsed, |node, _| {
        let Node::ClassConstantAccess(c) = node else { return };
        if !contains(s, span(&node)) || error.is_err() || !matches!(c.class, Expression::Self_(_) | Expression::Static(_)) {
            return;
        }
        let ClassLikeConstantSelector::Identifier(id) = &c.constant else { return };
        let member = String::from_utf8_lossy(id.value).into_owned();
        if let Some(meta) = codebase.get_class_constant(owner.as_bytes(), member.as_bytes())
            && let Err(e) = visible(codebase, meta.visibility, owner, enclosing, &format!("{}::{member}", short(owner)))
        {
            error = Err(e);
        }
    });
    error
}

pub(super) fn short(fqn: &str) -> &str {
    fqn.rsplit('\\').next().unwrap_or(fqn)
}

/// Whether a member with `visibility` declared in `owner` can be reached from code in `enclosing`.
fn visible(codebase: &mago_codex::metadata::CodebaseMetadata, visibility: mago_codex::visibility::Visibility, owner: &str, enclosing: Option<&str>, what: &str) -> Result<(), String> {
    use mago_codex::visibility::Visibility;
    let same = enclosing.is_some_and(|e| e.eq_ignore_ascii_case(owner));
    let family = enclosing.is_some_and(|e| same || codebase.is_instance_of(e.as_bytes(), owner.as_bytes()) || codebase.is_instance_of(owner.as_bytes(), e.as_bytes()));
    match visibility {
        Visibility::Private if !same => Err(format!("it uses {what}, which is private there")),
        Visibility::Protected if !family => Err(format!("it uses {what}, which is protected there")),
        _ => Ok(()),
    }
}

// ---- Inline Method ----

/// A call's receiver.
enum Receiver {
    /// `$this`, or `self::`, `static::`, or `parent::` on an instance method: the same object.
    This,
    /// A static method, or a function.
    None,
    /// Another object in a variable.
    Variable(String),
    /// Another object from an expression.
    Expression(Span),
}

fn inline_method(ctx: &Ctx<'_>, found: &crate::symbol::Found, asked: Asked) -> Result<Answer, String> {
    let codebase = &ctx.index.codebase;
    let (symbol, owner, name, meta) = match &found.symbols[0] {
        Symbol::Method { class, name } => {
            let meta = codebase.get_declaring_method(class.as_bytes(), name.as_bytes()).ok_or("Can't find the method's declaration.")?;
            let owner = codebase.get_declaring_method_class(class.as_bytes(), name.as_bytes()).map(|w| w.as_str_lossy().into_owned()).unwrap_or_else(|| class.clone());
            let owner = codebase.get_class_like(owner.as_bytes()).map_or(owner, |m| m.original_name.as_str_lossy().into_owned());
            (Symbol::Method { class: owner.clone(), name: name.clone() }, Some(owner), name.clone(), meta)
        }
        Symbol::Function(f) => {
            let meta = codebase.get_function(f.as_bytes()).ok_or("Can't find the function's declaration.")?;
            (Symbol::Function(f.clone()), None, short(f).to_string(), meta)
        }
        _ => unreachable!(),
    };
    let label = match &owner {
        Some(o) => format!("{}::{name}()", short(o)),
        None => format!("{name}()"),
    };
    let fail = |why: &str| format!("Can't inline {label}: {why}");
    let method = meta.method_metadata.as_ref();
    if method.is_some_and(|m| m.is_constructor) || name.eq_ignore_ascii_case("__construct") {
        return Err(fail("a constructor can't be inlined."));
    }
    if name.starts_with("__") {
        return Err(fail("PHP calls it by itself, so not every call can be found."));
    }
    if method.is_some_and(|m| m.is_abstract) {
        return Err(fail("it's abstract, so it has no body to inline."));
    }
    let owner_meta = owner.as_ref().and_then(|o| codebase.get_class_like(o.as_bytes()));
    let is_trait = owner_meta.is_some_and(|m| m.kind == mago_codex::symbol::SymbolKind::Trait);
    if let Some(o) = &owner {
        let lower = name.to_ascii_lowercase();
        let overriding = super::super::navigation::descendants(codebase, o).into_iter().find(|c| {
            codebase.get_declaring_method_class(c.as_bytes(), lower.as_bytes()).is_some_and(|d| d.as_str_lossy().eq_ignore_ascii_case(c))
        });
        if let Some(child) = overriding {
            return Err(fail(&format!("{}::{name}() overrides it, so a call may run that one.", short(&child))));
        }
    }
    // It can go only when nothing else needs it: not when it implements or overrides another class's method.
    let implements = owner_meta.and_then(|m| m.overridden_method_ids.get(&mago_word::word(name.to_ascii_lowercase().as_bytes())).and_then(|ids| ids.keys().next().map(|k| k.as_str_lossy().into_owned())));
    let place = declaration(&symbol, codebase).ok_or_else(|| fail("its declaration isn't in the project."))?;
    let decl_path = ctx.index.path_of(place.file).map(Path::to_path_buf).ok_or_else(|| fail("it's built into PHP."))?;
    if !ctx.index.is_project_file(place.file) {
        return Err(fail("it's declared in a library."));
    }
    let arena = LocalArena::new();
    let own = decl_path == ctx.doc.path;
    let decl_text_owned = if own { ctx.doc.text.clone() } else { ctx.snap.read(&decl_path).ok_or_else(|| fail("its file can't be read."))? };
    let other;
    let decl: &Parsed<'_> = if own {
        &ctx.parsed
    } else {
        other = Parsed::new(&arena, &decl_path, &decl_text_owned);
        &other
    };
    let decl_text = decl.text();

    // The declaration: its span, parameters, and body.
    let mut found_decl: Option<(Span, &mago_syntax::cst::FunctionLikeParameterList<'_>, &mago_syntax::cst::Block<'_>, bool)> = None;
    walk(decl, |node, _| {
        let (n, params, body, by_ref) = match node {
            Node::Method(m) => match &m.body {
                MethodBody::Concrete(b) => (span(&m.name), &m.parameter_list, b, m.ampersand.is_some()),
                _ => return,
            },
            Node::Function(f) => (span(&f.name), &f.parameter_list, &f.body, f.ampersand.is_some()),
            _ => return,
        };
        if n.0 == place.start {
            found_decl = Some((span(&node), params, body, by_ref));
        }
    });
    let Some((decl_span, params, body, by_ref)) = found_decl else { return Err(fail("its body can't be read.")) };
    if by_ref {
        return Err(fail("it returns by reference."));
    }
    for p in params.parameters.iter() {
        let pname = String::from_utf8_lossy(p.variable.name).into_owned();
        if p.ampersand.is_some() {
            return Err(fail(&format!("it takes {pname} by reference.")));
        }
        if p.ellipsis.is_some() {
            return Err(fail(&format!("it takes variadic arguments (...{pname}).")));
        }
    }
    let scope = decl_span;
    if let Some(how) = reads_by_name(decl, scope) {
        return Err(fail(&format!("it reads its variables by name, with {how}.")));
    }
    // Its own statements: not those of closures, functions, or classes inside it.
    let own_node = |path: &[Node<'_, '_>]| !inside(path, scope).any(|n| matches!(n, Node::Closure(_) | Node::ArrowFunction(_) | Node::Function(_) | Node::AnonymousClass(_) | Node::Class(_)));
    let mut returns: Vec<(Span, Option<Span>)> = vec![];
    let mut refusal = None;
    walk(decl, |node, ancestors| {
        if refusal.is_some() || !contains(span(&body), span(&node)) || !own_node(ancestors) {
            return;
        }
        match node {
            Node::Return(r) => returns.push((span(&node), r.value.map(span))),
            Node::Yield(_) | Node::YieldFrom(_) => refusal = Some("it's a generator (yield).".to_string()),
            Node::Static(_) => refusal = Some("it has static variables.".to_string()),
            Node::Global(_) => refusal = Some("it uses global variables.".to_string()),
            Node::Goto(_) | Node::Label(_) => refusal = Some("it uses goto.".to_string()),
            Node::MagicConstant(MagicConstant::Function(_) | MagicConstant::Method(_)) => refusal = Some("it uses __FUNCTION__ or __METHOD__, which would name the caller.".to_string()),
            _ => {}
        }
    });
    if let Some(r) = refusal {
        return Err(fail(&r));
    }
    let statements: Vec<Span> = body.statements.iter().map(span).collect();
    let (result, last_return) = match returns.as_slice() {
        [] => (None, None),
        [(r, value)] if statements.last() == Some(r) => (*value, Some(*r)),
        _ => {
            let early = returns.iter().find(|(r, _)| statements.last() != Some(r)).map_or(returns[0].0, |(r, _)| *r);
            return Err(fail(&format!("it returns early on line {}. Only a method with one return, at its end, can be inlined.", line_of(decl_text, early.0))));
        }
    };
    let body_code: Option<Span> = {
        let end = last_return.map_or_else(|| statements.last().map(|s| s.1), |r| statements.iter().filter(|s| s.1 <= r.0).map(|s| s.1).max());
        match (statements.first(), end) {
            (Some(first), Some(end)) if first.0 < end => Some((first.0, end)),
            _ => None,
        }
    };

    // Calls, without the declaration, and those inside it, which make it recursive.
    let mut calls: Vec<(PathBuf, Span)> = vec![];
    let mut recursive = false;
    for (path, _, spans) in crate::features::references::search(ctx.snap, &ctx.index, std::slice::from_ref(&symbol)) {
        for s in spans {
            if path == decl_path && s.0 == place.start {
                continue;
            }
            if path == decl_path && contains(decl_span, s) {
                recursive = true;
                continue;
            }
            calls.push((path.clone(), s));
        }
    }
    calls.sort();
    if calls.is_empty() {
        return Err(fail("nothing calls it."));
    }
    let caret = found.start;
    let here = (!found.declaration).then(|| calls.iter().position(|(p, s)| *p == ctx.doc.path && s.0 <= caret && caret <= s.1)).flatten();
    let what = if owner.is_some() { "method" } else { "function" };
    let removable = if recursive {
        Err("It calls itself, so it stays.".to_string())
    } else if let Some(parent) = &implements {
        Err(format!("It stays, since it implements {}::{name}().", short(parent)))
    } else {
        Ok(())
    };
    let range = |s: Span| ctx.doc.range(s.0, s.1);
    let mode = match asked {
        Asked::Target => {
            let mut choices = choices_for(calls.len(), here.is_some(), what, removable.clone(), calls.iter().filter(|(p, _)| *p == ctx.doc.path).map(|(_, s)| range(*s)).collect(), here.map(|i| range(calls[i].1)).into_iter().collect());
            for c in &mut choices {
                c.label = c.label.replace("use", "call");
            }
            // From the declaration, keeping it is a choice too.
            if removable.is_ok() {
                let n = if calls.len() == 1 { "the only call".to_string() } else { format!("all {} calls", calls.len()) };
                choices.insert(1, Choice { mode: Mode::Keep, label: format!("Inline {n} and keep the {what}"), detail: None, warning: None, highlight: choices[0].highlight.clone() });
            }
            return Ok(Answer::Target(Target { kind: "method", title: format!("Inline {label}"), choices, warnings: vec![] }));
        }
        Asked::Edit(m) => m,
    };
    let chosen: Vec<usize> = match (mode, here) {
        (Mode::This, Some(i)) => vec![i],
        (Mode::This, None) => return Err("Put the cursor on a call to inline that call.".into()),
        _ => (0..calls.len()).collect(),
    };

    let param_list: Vec<(String, Option<Span>)> = params.parameters.iter().map(|p| (String::from_utf8_lossy(&p.variable.name[1..]).into_owned(), p.default_value.as_ref().map(|d| span(d.value)))).collect();
    let src = Source { parsed: decl, text: decl_text, path: &decl_path, owner: owner.as_deref() };
    let facts = BodyFacts::read(decl, decl_text, scope, span(&body), &param_list, codebase);

    let mut edits = Edits::default();
    let mut skipped: Vec<(PathBuf, u32, String)> = vec![];
    let mut done = 0;
    let mut by_file: Vec<(PathBuf, Vec<Span>)> = vec![];
    for i in chosen {
        let (p, s) = &calls[i];
        match by_file.iter_mut().find(|(q, _)| q == p) {
            Some((_, list)) => list.push(*s),
            None => by_file.push((p.clone(), vec![*s])),
        }
    }
    for (path, spans) in by_file {
        let text = if path == ctx.doc.path { ctx.doc.text.clone() } else { ctx.snap.read(&path).unwrap_or_default() };
        let doc = Document::new(path_to_uri(&path), path.clone(), "php".into(), 0, text.clone());
        let arena = LocalArena::new();
        let parsed = Parsed::new(&arena, &path, &text);
        let lines = LineIndex::new(&text);
        let mut imports = vec![];
        let mut file_edits: Vec<(Span, String)> = vec![];
        let spans_start = spans[0].0;
        // A trait's method needs the class of the object it's called on, which the analyzer knows.
        let analysis = (is_trait && path != ctx.doc.path).then(|| crate::analysis::analyze(&parsed, &arena, &ctx.index));
        let analysis = if !is_trait { None } else if path == ctx.doc.path { Some(ctx.analysis()) } else { analysis.as_ref() };
        for s in spans {
            let call = Call_ { owner: owner.as_deref(), is_trait, name: &name, src: &src, facts: &facts, result, body_code, params: &param_list, codebase };
            match call.inline(&doc, &parsed, analysis, s, &mut imports) {
                Ok(list) => {
                    if list.iter().any(|(e, _)| file_edits.iter().any(|(o, _)| e.0 < o.1 && o.0 < e.1 || (e.0 == o.0 && e.1 == o.1 && e.0 != e.1))) {
                        skipped.push((path.clone(), line_of(&text, s.0), "it's inside another call being inlined".into()));
                        continue;
                    }
                    file_edits.extend(list);
                    done += 1;
                }
                Err(why) => skipped.push((path.clone(), line_of(&text, s.0), why)),
            }
        }
        for (s, t) in file_edits {
            edits.add(&path, TextEdit { range: lines.range(&text, s.0, s.1), new_text: t });
        }
        imports.sort();
        imports.dedup();
        for e in import_edits(&doc, parsed.program, spans_start, &imports, NameKind::Default) {
            edits.add(&path, e);
        }
    }
    let removed = mode == Mode::All && removable.is_ok() && skipped.is_empty() && done == calls.len();
    if removed {
        let delete = deletion(decl_text, with_docblock(decl, decl_text, decl_span));
        let lines = LineIndex::new(decl_text);
        edits.add(&decl_path, TextEdit { range: lines.range(decl_text, delete.0, delete.1), new_text: String::new() });
    }
    let message = format!("Inlined {label} in {done} {}{}.", if done == 1 { "place" } else { "places" }, if removed { " and removed it" } else { "" });
    Ok(Answer::Edit(Outcome { edits, skipped, message }))
}

/// What a method's body does with its parameters, variables, and `$this`, read once for every call.
struct BodyFacts {
    /// Each parameter's uses in the body, and whether any writes it or needs a variable (isset(), a closure's
    /// use list, a string), or sits in a closure or arrow function, which runs later.
    params: Vec<ParamUses>,
    /// The body's own variables, other than parameters, with each one's uses, closures' copies included.
    locals: Vec<(String, Vec<Span>)>,
    /// `$this` in the body.
    this: Vec<Span>,
    /// `$this` in a closure, which binds the object it's created on.
    this_in_closure: bool,
    /// Members reached through `$this`, `self::`, or `static::`, as (kind, name).
    members: Vec<(&'static str, String)>,
    /// `static` in the body, which means the class the call runs on.
    statics: bool,
    /// Where the first code with side effects in the body ends, for the one argument that may stay in place: a
    /// use before that runs first.
    first_impure: Option<u32>,
}

struct ParamUses {
    uses: Vec<(Span, Placement)>,
    writes: bool,
    needs_variable: bool,
    later: bool,
}

/// How a use of a parameter is written, given the argument's text and shape.
#[derive(Clone)]
struct Placement {
    /// The parent nodes that decide parentheses and braces, from the use up.
    precedence_parent: Option<Precedence>,
    kind: UseKind,
    sign_before: bool,
    conditional: bool,
    in_loop: bool,
}

#[derive(Clone, PartialEq)]
enum UseKind {
    Plain,
    Binary { right: bool, non_assoc: bool, instanceof_rhs: bool },
    Unary,
    Ternary { condition_or_else: bool },
    Assigned,
    Dereferenced,
    New,
    /// In `"$x"` or `"$x->name"`: the part.
    StringSimple { part: Span },
    StringBraced,
}

impl Placement {
    fn of(text: &str, path: &[Node<'_, '_>]) -> Self {
        let at = span(path.last().unwrap());
        let mut i = path.len() - 1;
        while i > 0 && span(&path[i - 1]) == at {
            i -= 1;
        }
        let mut kind = UseKind::Plain;
        let mut precedence_parent = None;
        for j in (0..path.len()).rev() {
            match path[j] {
                Node::BracedExpressionStringPart(_) => {
                    kind = UseKind::StringBraced;
                    break;
                }
                Node::StringPart(part) => {
                    kind = UseKind::StringSimple { part: span(part) };
                    break;
                }
                Node::Statement(_) | Node::Closure(_) | Node::ArrowFunction(_) => break,
                _ => {}
            }
        }
        if kind == UseKind::Plain && i > 0 {
            match path[i - 1] {
                Node::Binary(b) => {
                    let op = b.operator.precedence();
                    let lhs = contains(span(b.lhs), at);
                    precedence_parent = Some(op);
                    kind = UseKind::Binary { right: !lhs, non_assoc: non_associative(op), instanceof_rhs: !lhs && matches!(b.operator, mago_syntax::cst::BinaryOperator::Instanceof(_)) };
                }
                Node::UnaryPrefix(u) => {
                    precedence_parent = Some(u.operator.precedence());
                    kind = UseKind::Unary;
                }
                Node::UnaryPostfix(_) => {
                    precedence_parent = Some(Precedence::IncDec);
                    kind = UseKind::Unary;
                }
                Node::Clone(_) => {
                    precedence_parent = Some(Precedence::Clone);
                    kind = UseKind::Unary;
                }
                Node::Conditional(c) => kind = UseKind::Ternary { condition_or_else: contains(span(c.condition), at) || contains(span(c.r#else), at) },
                Node::Assignment(_) => kind = UseKind::Assigned,
                Node::Pipe(_) => {
                    precedence_parent = Some(Precedence::Pipe);
                    kind = UseKind::Unary;
                }
                Node::PropertyAccess(a) if span(a.object) == at => kind = UseKind::Dereferenced,
                Node::NullSafePropertyAccess(a) if span(a.object) == at => kind = UseKind::Dereferenced,
                Node::MethodCall(c) if span(c.object) == at => kind = UseKind::Dereferenced,
                Node::NullSafeMethodCall(c) if span(c.object) == at => kind = UseKind::Dereferenced,
                Node::ArrayAccess(a) if span(a.array) == at => kind = UseKind::Dereferenced,
                Node::FunctionCall(c) if span(c.function) == at => kind = UseKind::Dereferenced,
                Node::StaticMethodCall(c) if span(c.class) == at => kind = UseKind::Dereferenced,
                Node::StaticPropertyAccess(c) if span(c.class) == at => kind = UseKind::Dereferenced,
                Node::ClassConstantAccess(c) if span(c.class) == at => kind = UseKind::Dereferenced,
                Node::Instantiation(n) if span(n.class) == at => kind = UseKind::New,
                _ => {}
            }
        }
        let in_loop = path.iter().any(|n| matches!(n, Node::While(_) | Node::DoWhile(_) | Node::For(_) | Node::Foreach(_)));
        Placement { precedence_parent, kind, sign_before: text[..at.0 as usize].ends_with(['-', '+']), conditional: runs_only(text, path).is_some(), in_loop }
    }

    /// The text for a value of shape `s` here, or None where only a variable can go.
    fn write(&self, value: &str, s: Shape) -> Option<String> {
        let p = s.precedence;
        let wrap = |cond: bool| if cond || (self.sign_before && s.sign) { format!("({value})") } else { value.to_string() };
        Some(match &self.kind {
            UseKind::StringSimple { .. } => {
                if s.variable {
                    value.to_string()
                } else {
                    return None;
                }
            }
            UseKind::StringBraced => {
                if s.dollar {
                    value.to_string()
                } else {
                    return None;
                }
            }
            UseKind::Binary { right, non_assoc, instanceof_rhs } => {
                let op = self.precedence_parent.unwrap();
                if *instanceof_rhs { wrap(!s.variable) } else { wrap(p < op || (p == op && (*non_assoc || !*right == right_associative(op)))) }
            }
            UseKind::Unary => wrap(p < self.precedence_parent.unwrap()),
            UseKind::Ternary { condition_or_else } => wrap(if *condition_or_else { p <= Precedence::ElvisOrConditional } else { p < Precedence::Assignment }),
            UseKind::Assigned => wrap(p < Precedence::Assignment),
            UseKind::Dereferenced => wrap(!s.dereferencable),
            UseKind::New => wrap(!s.variable),
            UseKind::Plain => wrap(false),
        })
    }
}

impl BodyFacts {
    fn read(decl: &Parsed<'_>, text: &str, scope: Span, body: Span, params: &[(String, Option<Span>)], codebase: &mago_codex::metadata::CodebaseMetadata) -> Self {
        let resolver = Resolver::new(decl, None, codebase);
        let params = params
            .iter()
            .map(|(p, _)| {
                let mut out = ParamUses { uses: vec![], writes: false, needs_variable: false, later: false };
                for (s, path) in occurrences(decl, p, scope) {
                    if !contains(body, s) {
                        continue;
                    }
                    out.writes |= written(&path) || by_reference(&resolver, &path);
                    out.needs_variable |= path.iter().any(|n| matches!(n, Node::IssetConstruct(_) | Node::EmptyConstruct(_) | Node::Unset(_) | Node::ClosureUseClause(_)));
                    out.later |= inside(&path, scope).any(|n| matches!(n, Node::Closure(_) | Node::ArrowFunction(_)));
                    let expr_path = (1..=path.len()).rev().map(|i| &path[..i]).find(|q| matches!(q.last(), Some(Node::Expression(_))) && span(q.last().unwrap()) == s).unwrap_or(&path);
                    out.uses.push((s, Placement::of(text, expr_path)));
                }
                out
            })
            .collect();
        let mut local_names: Vec<String> = variable_names_in_scope(decl, scope);
        local_names.retain(|l| !SUPERGLOBALS.contains(&l.as_str()));
        let mut locals = vec![];
        for l in local_names {
            let mut spans: Vec<Span> = occurrences(decl, &l, scope).into_iter().map(|(s, _)| s).collect();
            // Closures that capture it by `use` have it too.
            walk(decl, |node, _| {
                if let Node::Closure(c) = node
                    && contains(body, span(&node))
                    && c.use_clause.as_ref().is_some_and(|u| u.variables.iter().any(|v| v.variable.name[1..] == *l.as_bytes()))
                {
                    spans.extend(occurrences(decl, &l, span(&node)).into_iter().map(|(s, _)| s));
                }
            });
            spans.sort();
            spans.dedup();
            locals.push((l, spans));
        }
        let mut this = vec![];
        let mut this_in_closure = false;
        let mut members = vec![];
        let mut statics = false;
        let mut first_impure = None;
        walk(decl, |node, ancestors| {
            let n = span(&node);
            if !contains(body, n) {
                return;
            }
            let in_closure = inside(ancestors, scope).any(|a| matches!(a, Node::Closure(_) | Node::ArrowFunction(_)));
            statics |= matches!(node, Node::Expression(Expression::Static(_)));
            match node {
                Node::DirectVariable(v) if v.name == b"$this" => {
                    this.push(n);
                    this_in_closure |= in_closure;
                }
                Node::PropertyAccess(a) if is_this(a.object) => members.extend(member_name(&a.property).map(|m| ("property", m))),
                Node::NullSafePropertyAccess(a) if is_this(a.object) => members.extend(member_name(&a.property).map(|m| ("property", m))),
                Node::MethodCall(c) if is_this(c.object) => members.extend(member_name(&c.method).map(|m| ("method", m))),
                Node::NullSafeMethodCall(c) if is_this(c.object) => members.extend(member_name(&c.method).map(|m| ("method", m))),
                Node::StaticMethodCall(c) if matches!(c.class, Expression::Self_(_) | Expression::Static(_)) => members.extend(member_name(&c.method).map(|m| ("method", m))),
                Node::StaticPropertyAccess(c) if matches!(c.class, Expression::Self_(_) | Expression::Static(_)) => {
                    if let Variable::Direct(v) = &c.property {
                        members.push(("property", String::from_utf8_lossy(&v.name[1..]).into_owned()));
                    }
                }
                Node::ClassConstantAccess(c) if matches!(c.class, Expression::Self_(_) | Expression::Static(_)) => {
                    if let ClassLikeConstantSelector::Identifier(id) = &c.constant {
                        members.push(("constant", String::from_utf8_lossy(id.value).into_owned()));
                    }
                }
                _ => {}
            }
            if !in_closure && matches!(node, Node::Expression(_)) && impure_shallow(node) {
                first_impure = Some(first_impure.map_or(n.1, |f: u32| f.min(n.1)));
            }
        });
        let _ = text;
        Self { params, locals, this, this_in_closure, members, statics, first_impure }
    }
}

/// Whether the node itself, not what's inside it, has a side effect.
fn impure_shallow(node: Node<'_, '_>) -> bool {
    match node {
        Node::Expression(e) => matches!(
            e,
            Expression::Call(_) | Expression::Instantiation(_) | Expression::Assignment(_) | Expression::UnaryPostfix(_) | Expression::Yield(_) | Expression::Throw(_) | Expression::Clone(_) | Expression::Construct(_)
        ) || matches!(e, Expression::UnaryPrefix(u) if matches!(u.operator, UnaryPrefixOperator::PreIncrement(_) | UnaryPrefixOperator::PreDecrement(_))),
        _ => false,
    }
}

fn is_this(e: &Expression<'_>) -> bool {
    matches!(e, Expression::Variable(Variable::Direct(v)) if v.name == b"$this")
}

fn member_name(s: &ClassLikeMemberSelector<'_>) -> Option<String> {
    match s {
        ClassLikeMemberSelector::Identifier(i) => Some(String::from_utf8_lossy(i.value).into_owned()),
        _ => None,
    }
}

/// The variables of the scope itself, not of closures inside it.
fn variable_names_in_scope(parsed: &Parsed<'_>, scope: Span) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    walk(parsed, |node, ancestors| {
        let Node::DirectVariable(v) = node else { return };
        let mut path = ancestors.to_vec();
        path.push(node);
        if variable_scope(parsed, &path) == scope {
            let name = String::from_utf8_lossy(&v.name[1..]).into_owned();
            if !out.contains(&name) {
                out.push(name);
            }
        }
    });
    out
}

/// One method, ready to inline at its calls.
#[allow(non_camel_case_types)]
struct Call_<'s, 'a> {
    owner: Option<&'s str>,
    is_trait: bool,
    name: &'s str,
    src: &'s Source<'s, 'a>,
    facts: &'s BodyFacts,
    result: Option<Span>,
    body_code: Option<Span>,
    params: &'s [(String, Option<Span>)],
    codebase: &'s mago_codex::metadata::CodebaseMetadata,
}

impl Call_<'_, '_> {
    /// The class whose copy of the trait's method a call runs: where the method appears in the class of the object
    /// it's called on. Refused where that class can't be told, or where a subclass has a method of its own.
    fn trait_user(&self, resolver: &Resolver<'_, '_>, call: Node<'_, '_>, path: &[Node<'_, '_>]) -> Result<String, String> {
        let t = self.owner.unwrap_or_default();
        let classes = match call {
            Node::MethodCall(c) => resolver.classes_of(c.object),
            Node::StaticMethodCall(c) => resolver.classes_of_class_expr(c.class, path),
            _ => vec![],
        };
        let lower = mago_word::word(self.name.to_ascii_lowercase().as_bytes());
        let runs_trait = |class: &str| self.codebase.get_declaring_method_class(class.as_bytes(), self.name.as_bytes()).is_some_and(|d| d.as_str_lossy().eq_ignore_ascii_case(t));
        let mut users: Vec<String> = vec![];
        for class in &classes {
            let Some(meta) = self.codebase.get_class_like(class.as_bytes()) else { continue };
            if !runs_trait(class) {
                return Err(format!("the object can be {}, whose {}() is another method", short(class), self.name));
            }
            if let Some(child) = super::super::navigation::descendants(self.codebase, class).into_iter().find(|d| !runs_trait(d)) {
                return Err(format!("{}::{}() overrides it, so this call may run that one", short(&child), self.name));
            }
            let Some(appears) = meta.appearing_method_ids.get(&lower).map(|id| id.get_class_name()) else { continue };
            let user = self.codebase.get_class_like(appears.as_bytes()).map_or_else(|| appears.as_str_lossy().into_owned(), |m| m.original_name.as_str_lossy().into_owned());
            if !users.iter().any(|u| u.eq_ignore_ascii_case(&user)) {
                users.push(user);
            }
        }
        match users.as_slice() {
            [] => Err("it's a trait's method, and the class of the object it's called on can't be told".into()),
            [one] => Ok(one.clone()),
            [a, b, ..] => Err(format!("it's a trait's method, and the object can be {} or {}, which each use the trait", short(a), short(b))),
        }
    }

    /// The edits that inline the call whose name is at `s` in `parsed`, or why it can't be.
    fn inline(&self, doc: &Document, parsed: &Parsed<'_>, analysis: Option<&crate::analysis::Analysis>, s: Span, imports: &mut Vec<String>) -> Result<Vec<(Span, String)>, String> {
        let text = parsed.text();
        let path = parsed.path_at(s.0);
        let at = path
            .iter()
            .rposition(|n| match n {
                Node::FunctionCall(c) => contains(span(c.function), s),
                Node::MethodCall(c) => contains(span(&c.method), s),
                Node::NullSafeMethodCall(c) => contains(span(&c.method), s),
                Node::StaticMethodCall(c) => contains(span(&c.method), s),
                Node::FunctionPartialApplication(_) | Node::MethodPartialApplication(_) | Node::StaticMethodPartialApplication(_) => contains(span(n), s),
                _ => false,
            })
            .ok_or("it isn't a call, such as a callable string or [$this, 'method']")?;
        let call_node = path[at];
        let (receiver, args) = match call_node {
            Node::FunctionCall(c) => (Receiver::None, &c.argument_list),
            Node::MethodCall(c) => {
                let receiver = match c.object {
                    e if is_this(e) => Receiver::This,
                    Expression::Variable(Variable::Direct(v)) => Receiver::Variable(String::from_utf8_lossy(v.name).into_owned()),
                    e => Receiver::Expression(span(e)),
                };
                (receiver, &c.argument_list)
            }
            Node::StaticMethodCall(c) => {
                let instance = self.codebase.get_method(self.owner.unwrap_or_default().as_bytes(), self.name.as_bytes()).and_then(|m| m.method_metadata.as_ref()).is_some_and(|m| !m.is_static);
                let receiver = if instance && matches!(c.class, Expression::Self_(_) | Expression::Static(_) | Expression::Parent(_)) { Receiver::This } else { Receiver::None };
                (receiver, &c.argument_list)
            }
            Node::NullSafeMethodCall(_) => return Err("it's a nullsafe call (?->)".into()),
            _ => return Err("it's a first-class callable, such as $this->method(...)".into()),
        };
        // Up to the outermost node that is the call.
        let call_span = span(&call_node);
        let outermost = path[..=at].iter().position(|n| span(n) == call_span).unwrap_or(at);
        let call_path: Vec<Node<'_, '_>> = path[..=outermost].to_vec();
        let resolver = Resolver::new(parsed, analysis, self.codebase);
        let enclosing = resolver.enclosing_class(&path[..=at]);
        // A keyword call (`self::`, `static::`, `parent::`) forwards the class it runs on, as `$this->` keeps the object.
        let keyword = matches!(call_node, Node::StaticMethodCall(c) if matches!(c.class, Expression::Self_(_) | Expression::Static(_) | Expression::Parent(_)));
        // A trait's method runs as a copy in the class that uses the trait, so `self` there means that class.
        let owner: Option<String> = match self.owner {
            Some(t) if self.is_trait => {
                let in_trait = enclosing.as_deref().is_some_and(|e| e.eq_ignore_ascii_case(t));
                if in_trait && (matches!(receiver, Receiver::This) || keyword) { Some(t.to_string()) } else { Some(self.trait_user(&resolver, call_node, &path[..=at])?) }
            }
            o => o.map(str::to_string),
        };
        let owner = owner.as_deref();
        let same_class = matches!((owner, &enclosing), (Some(o), Some(e)) if e.eq_ignore_ascii_case(o));
        let same_object = matches!(receiver, Receiver::This);
        let src = Source { owner, ..*self.src };
        if let Some(owner) = owner
            && !same_class
        {
            for (kind, member) in &self.facts.members {
                let visibility = match *kind {
                    "method" => self.codebase.get_method_visibility(owner.as_bytes(), member.as_bytes()),
                    "property" => self.codebase.get_declaring_property(owner.as_bytes(), format!("${member}").as_bytes()).map(|p| p.read_visibility),
                    _ => self.codebase.get_class_constant(owner.as_bytes(), member.as_bytes()).map(|c| c.visibility),
                };
                if let Some(v) = visibility {
                    let what = match *kind {
                        "method" => format!("{}()", member),
                        "property" => format!("${member}"),
                        _ => member.clone(),
                    };
                    visible(self.codebase, v, owner, enclosing.as_deref(), &format!("{}::{what}", short(owner)))?;
                }
            }
        }
        if !self.facts.this.is_empty() && self.facts.this_in_closure && !same_object {
            return Err("it uses $this inside a closure, which can't see another object".into());
        }

        // The arguments, matched to the parameters.
        let mut values: Vec<Option<(Span, bool)>> = vec![None; self.params.len()];
        let mut positional = 0;
        for a in args.arguments.iter() {
            match a {
                Argument::Positional(p) if p.ellipsis.is_some() => return Err("it spreads its arguments (...)".into()),
                Argument::Positional(p) => {
                    if positional >= self.params.len() {
                        return Err("it passes more arguments than the method takes".into());
                    }
                    values[positional] = Some((span(p.value), impure(Node::Expression(p.value))));
                    positional += 1;
                }
                Argument::Named(n) => {
                    let named = String::from_utf8_lossy(n.name.value).into_owned();
                    let i = self.params.iter().position(|(p, _)| *p == named).ok_or_else(|| format!("it names no parameter ${named}"))?;
                    values[i] = Some((span(n.value), impure(Node::Expression(n.value))));
                }
            }
        }
        let call_scope = variable_scope(parsed, &path[..=at]);
        let mut taken: HashSet<String> = variable_names_in_scope(parsed, call_scope).into_iter().collect();
        taken.extend(SUPERGLOBALS.iter().map(|s| s.to_string()));
        let mut before: Vec<String> = vec![];
        let mut extra: Vec<(Span, String)> = vec![];
        let fresh = |base: &str, taken: &mut HashSet<String>| {
            let n = unique(base, |c| taken.contains(c), "");
            taken.insert(n.clone());
            n
        };
        // `$this`: the object the call ran on.
        let mut object = None;
        match &receiver {
            Receiver::Variable(v) => extra.extend(self.facts.this.iter().map(|s| (*s, v.clone()))),
            Receiver::Expression(e) => {
                let receiver_text = slice(text, *e).to_string();
                if !self.facts.this.is_empty() || self.facts.statics {
                    let temp = format!("${}", fresh("object", &mut taken));
                    before.push(format!("{temp} = {receiver_text};"));
                    extra.extend(self.facts.this.iter().map(|s| (*s, temp.clone())));
                    object = Some(temp);
                } else if path_to(parsed, *e).and_then(|p| p.last().copied()).is_some_and(impure) {
                    before.push(format!("{receiver_text};"));
                }
            }
            _ => {}
        }
        // `static`: the class the call runs on, which a keyword call or `$this->` forwards.
        let statik = match (&receiver, call_node) {
            (Receiver::This, _) => StaticAs::Keep,
            _ if keyword => StaticAs::Keep,
            (_, Node::StaticMethodCall(c)) => match c.class {
                Expression::Identifier(_) | Expression::Variable(Variable::Direct(_)) => StaticAs::Write(slice(text, span(c.class)).to_string()),
                _ => StaticAs::Unknown("it uses static::, and the class it's called on can't be told".into()),
            },
            (Receiver::Variable(v), _) => StaticAs::Write(v.clone()),
            (Receiver::Expression(_), _) => object.map_or(StaticAs::Keep, StaticAs::Write),
            (Receiver::None, _) => StaticAs::Keep,
        };
        let dest = Dest { doc, parsed, offset: call_span.0, same_class, statik };
        // The locals, apart from the caller's variables, before the parameters take their temporaries' names.
        let param_names: HashSet<&str> = self.params.iter().map(|(p, _)| p.as_str()).collect();
        for (l, spans) in &self.facts.locals {
            if param_names.contains(l.as_str()) || l == "this" {
                continue;
            }
            if taken.contains(l) {
                let n = fresh(l, &mut taken);
                extra.extend(spans.iter().map(|s| (*s, format!("${n}"))));
            } else {
                taken.insert(l.clone());
            }
        }
        let impure_args = values.iter().flatten().filter(|(_, i)| *i).count();
        for (i, (pname, default)) in self.params.iter().enumerate() {
            let uses = &self.facts.params[i];
            let (value, is_impure) = match (values[i], default) {
                (Some((v, imp)), _) => (slice(text, v).to_string(), imp),
                (None, Some(d)) => (moved(&src, *d, &dest, self.codebase, vec![], imports)?, false),
                (None, None) => return Err(format!("it doesn't pass ${pname}, which has no default")),
            };
            let value_shape = match values[i] {
                Some((v, _)) => path_to(parsed, v).and_then(|p| expression_of(&p).map(|e| shape(unparenthesized(e), text))),
                None => default.and_then(|d| path_to(src.parsed, d)).and_then(|p| expression_of(&p).map(|e| shape(unparenthesized(e), src.text))),
            };
            let Some(value_shape) = value_shape else { return Err(format!("its argument for ${pname} can't be read")) };
            if uses.uses.is_empty() {
                if is_impure {
                    before.push(format!("{value};"));
                }
                continue;
            }
            let plain_variable = value_shape.variable && value != "$this";
            let in_place = |v: &str| -> Option<Vec<(Span, String)>> { uses.uses.iter().map(|(s, p)| p.write(v, value_shape).map(|t| (*s, t))).collect() };
            let first_read = || {
                let (s, p) = &uses.uses[0];
                uses.uses.len() == 1 && !p.conditional && !p.in_loop && self.facts.first_impure.is_none_or(|f| f > s.0)
            };
            // In place: a variable, a value without side effects, or the one argument with them, read once and first.
            let stays = !uses.writes && !uses.needs_variable && (plain_variable || (!uses.later && (!is_impure || (impure_args == 1 && first_read()))));
            let direct = if stays { in_place(&value) } else { None };
            match direct {
                Some(list) => extra.extend(list),
                None => {
                    let temp = format!("${}", fresh(pname, &mut taken));
                    before.push(format!("{temp} = {value};"));
                    extra.extend(uses.uses.iter().map(|(s, _)| (*s, temp.clone())));
                }
            }
        }

        // The body, at the statement's indentation.
        let statement_at = statement_in_list(&call_path);
        let (statement, indent) = match statement_at {
            Some(i) => (span(&call_path[i]), indent_at(text, span(&call_path[i]).0)),
            None => return Err("it isn't inside a function's statements".into()),
        };
        let code = match self.body_code {
            Some(b) => {
                let mut list = extra.clone();
                list.extend(reindent(src.parsed, src.text, b, &indent));
                Some(moved(&src, b, &dest, self.codebase, list, imports)?)
            }
            None => None,
        };
        let result = match self.result {
            Some(r) => Some(moved(&src, r, &dest, self.codebase, {
                let mut list = extra.clone();
                list.extend(reindent(src.parsed, src.text, r, &indent));
                list
            }, imports)?),
            None => None,
        };
        let lead: Vec<String> = before.into_iter().chain(code).collect();
        let alone = match call_path[statement_at.unwrap()] {
            Node::Statement(Statement::Expression(e)) => span(e.expression) == call_span,
            _ => false,
        };
        if alone {
            let mut lines = lead;
            if let (Some(r), Some(rp)) = (&result, self.result) {
                let returned = path_to(src.parsed, rp).and_then(|p| p.last().copied());
                if returned.is_some_and(impure) || returned.is_none() {
                    lines.push(format!("{r};"));
                }
            }
            if lines.is_empty() {
                return Ok(vec![(deletion(text, statement), String::new())]);
            }
            return Ok(vec![(statement, lines.join(&format!("\n{indent}")))]);
        }
        let Some(result) = result else { return Err("it returns nothing, but the call's value is used".into()) };
        let (call_at, call_text) = placed(&result, shape_of_code(&result), &call_path, text)?;
        if lead.is_empty() {
            return Ok(vec![(call_at, call_text)]);
        }
        // The body's statements go before the statement, which must run the call every time, right away.
        if let Some(when) = runs_only(text, &call_path) {
            return Err(format!("the method has statements, and this call runs only {when}"));
        }
        let header = call_path[..statement_at.unwrap()].iter().rev().chain(std::iter::once(&call_path[statement_at.unwrap()])).find_map(|n| match n {
            Node::While(w) if contains(span(w.condition), call_span) => Some("a while loop's condition"),
            Node::DoWhile(w) if contains(span(w.condition), call_span) => Some("a do-while loop's condition"),
            Node::For(f) if !f.body.span().contains(&mago_span::Position::new(call_span.0)) => Some("a for loop's header"),
            Node::IfStatementBodyElseIfClause(c) if contains(span(c.condition), call_span) => Some("an elseif condition"),
            Node::IfColonDelimitedBodyElseIfClause(c) if contains(span(c.condition), call_span) => Some("an elseif condition"),
            _ => None,
        });
        if let Some(place) = header {
            return Err(format!("the method has statements, and the call is in {place}, which runs more than once or only sometimes"));
        }
        if call_path[statement_at.unwrap()..].iter().any(|n| matches!(n, Node::ArrowFunction(_))) {
            return Err("the method has statements, which can't go inside an arrow function".into());
        }
        let mut runs_first = false;
        walk(parsed, |node, _| runs_first |= contains((statement.0, call_span.0), span(&node)) && impure_shallow(node));
        if runs_first {
            return Err("something before the call in its statement runs first, and the method's statements would run before it".into());
        }
        Ok(vec![(call_at, call_text), ((statement.0, statement.0), format!("{}\n{indent}", lead.join(&format!("\n{indent}"))))])
    }
}

// ---- Requests ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    text_document: lsp_types::TextDocumentIdentifier,
    position: Position,
    #[serde(default)]
    mode: Option<Mode>,
}

/// `tusk/inlineTarget`: what inlining at a position would do, and the choices to offer. An error says why it can't.
pub fn target_request(snap: &Snapshot, params: Value) -> Result<Value, String> {
    let p: Params = serde_json::from_value(params).map_err(|e| e.to_string())?;
    match with_ctx(snap, &p.text_document.uri, |ctx| run(ctx, p.position, Asked::Target)) {
        Some(Ok(Answer::Target(t))) => serde_json::to_value(t).map_err(|e| e.to_string()),
        Some(Err(e)) => Err(e),
        _ => Err(TOO_COMPLEX.into()),
    }
}

const TOO_COMPLEX: &str = "The file is too complex to refactor, or isn't open.";

/// `tusk/inline`: the edit for a `mode`, the uses skipped, with the reason for each, and a message.
pub fn inline_request(snap: &Snapshot, params: Value) -> Result<Value, String> {
    let p: Params = serde_json::from_value(params).map_err(|e| e.to_string())?;
    let mode = p.mode.unwrap_or(Mode::All);
    let outcome = match with_ctx(snap, &p.text_document.uri, |ctx| run(ctx, p.position, Asked::Edit(mode))) {
        Some(Ok(Answer::Edit(o))) => o,
        Some(Err(e)) => return Err(e),
        _ => return Err(TOO_COMPLEX.into()),
    };
    let skipped: Vec<Skipped> = outcome.skipped.into_iter().map(|(path, line, reason)| Skipped { uri: path_to_uri(&path), line, reason }).collect();
    Ok(json!({ "edit": outcome.edits.into_workspace_edit(snap, vec![]), "skipped": skipped, "message": outcome.message }))
}

// ---- Code actions, for other editors ----

/// At the caret, Inline when it applies: a variable when it can be inlined, which reads only its file, and a
/// constant or a method declared in the project, which the full check, reading the project, may still refuse.
pub fn candidates(ctx: &Ctx<'_>, range: Range) -> Vec<Candidate> {
    if range.start != range.end {
        return vec![];
    }
    let offset = ctx.offset(range.start);
    let title = match ctx.parsed.path_at(offset).last() {
        Some(Node::DirectVariable(v)) if run(ctx, range.start, Asked::Target).is_ok() => format!("Inline variable {}", String::from_utf8_lossy(v.name)),
        Some(Node::DirectVariable(_)) => return vec![],
        _ => {
            let Some(symbol) = ctx.symbol_at(range.start).and_then(|f| f.symbols.into_iter().next()) else { return vec![] };
            let in_project = declaration(&symbol, &ctx.index.codebase).is_some_and(|p| ctx.index.is_project_file(p.file));
            match symbol {
                _ if !in_project => return vec![],
                Symbol::ClassConstant { name, .. } | Symbol::Constant(name) => format!("Inline constant {name}"),
                Symbol::Method { name, .. } => format!("Inline method {name}()"),
                Symbol::Function(name) => format!("Inline function {}()", short(&name)),
                _ => return vec![],
            }
        }
    };
    vec![Candidate::new(title, "refactor.inline", "inline.all", Value::Null)]
}

pub fn resolve(ctx: &Ctx<'_>, range: Range) -> Option<WorkspaceEdit> {
    let mode = match run(ctx, range.start, Asked::Target).ok()? {
        Answer::Target(t) => t.choices.first()?.mode,
        Answer::Edit(_) => return None,
    };
    match run(ctx, range.start, Asked::Edit(mode)).ok()? {
        Answer::Edit(o) if !o.edits.is_empty() => Some(o.edits.into_workspace_edit(ctx.snap, vec![])),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use lsp_types::{DocumentChangeOperation, DocumentChanges, OneOf};

    use super::*;
    use crate::testing::Fixture;
    use crate::text::uri_to_path;

    fn params(fx: &Fixture, mode: Option<Mode>) -> Value {
        let at = fx.at();
        json!({ "textDocument": at.text_document, "position": at.position, "mode": mode })
    }

    /// Inlines at the `<|>` with `mode` and returns each changed file's text, by file name, and the skipped uses.
    fn inline(files: &[(&str, &str)], mode: Mode) -> Result<(BTreeMap<String, String>, Vec<String>), String> {
        let fx = Fixture::new(files);
        let v = inline_request(&fx.snap, params(&fx, Some(mode)))?;
        let edit: WorkspaceEdit = serde_json::from_value(v["edit"].clone()).unwrap();
        let mut out = BTreeMap::new();
        let edits = match edit.document_changes {
            Some(DocumentChanges::Operations(ops)) => ops.into_iter().filter_map(|op| match op {
                DocumentChangeOperation::Edit(e) => Some(e),
                _ => None,
            }).collect(),
            Some(DocumentChanges::Edits(edits)) => edits,
            None => vec![],
        };
        {
            for e in edits {
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
        }
        let skipped = v["skipped"].as_array().unwrap().iter().map(|s| format!("{}:{}", s["line"], s["reason"].as_str().unwrap())).collect();
        Ok((out, skipped))
    }

    fn one(text: &str, mode: Mode) -> Result<String, String> {
        inline(&[("test.php", text)], mode).map(|(files, _)| files.get("test.php").cloned().unwrap_or_default())
    }

    fn target(text: &str) -> Result<Value, String> {
        let fx = Fixture::one(text);
        target_request(&fx.snap, params(&fx, None))
    }

    fn method(body: &str) -> String {
        format!("<?php\nclass A\n{{\n    public function run(array $items, int $n): mixed\n    {{\n{body}\n    }}\n}}\n")
    }

    // ---- Variables ----

    #[test]
    fn inlines_a_variable_with_parentheses_where_needed() {
        let out = one(&method("        $total = $n + 1;\n        return $to<|>tal * 2;"), Mode::All).unwrap();
        assert!(out.contains("    {\n        return ($n + 1) * 2;\n    }"), "{out}");
        let out = one(&method("        $total = $n * 3;\n        $x = $total + 1;\n        return [$x, $to<|>tal];"), Mode::All).unwrap();
        assert!(out.contains("        $x = $n * 3 + 1;\n        return [$x, $n * 3];"), "{out}");
        let out = one(&method("        $neg = -1;\n        return -$ne<|>g;"), Mode::All).unwrap();
        assert!(out.contains("return -(-1);"), "{out}");
        let out = one(&method("        $c = $n > 1 ? 'a' : 'b';\n        return $<|>c ?: 'z';"), Mode::All).unwrap();
        assert!(out.contains("return ($n > 1 ? 'a' : 'b') ?: 'z';"), "{out}");
        let out = one(&method("        $o = new \\ArrayObject();\n        return $<|>o->count();"), Mode::All).unwrap();
        assert!(out.contains("return (new \\ArrayObject())->count();"), "{out}");
    }

    #[test]
    fn inlines_one_use_and_keeps_the_assignment() {
        let out = one(&method("        $s = $n + 1;\n        $a = $<|>s;\n        return $s + $a;"), Mode::This).unwrap();
        assert!(out.contains("        $s = $n + 1;\n        $a = $n + 1;\n        return $s + $a;"), "{out}");
        let t = target(&method("        $s = $n + 1;\n        $a = $<|>s;\n        return $s + $a;")).unwrap();
        let modes: Vec<_> = t["choices"].as_array().unwrap().iter().map(|c| c["mode"].as_str().unwrap().to_string()).collect();
        assert_eq!(modes, ["all", "this"]);
        assert_eq!(t["choices"][0]["highlight"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn inlines_into_strings_with_braces() {
        let out = one(&method("        $name = $this->user->name;\n        return \"Hi $na<|>me and {$name}!\";"), Mode::All).unwrap();
        assert!(out.contains("return \"Hi {$this->user->name} and {$this->user->name}!\";"), "{out}");
        let err = one(&method("        $name = strtoupper('x');\n        return \"Hi $na<|>me\";"), Mode::All).unwrap_err();
        assert!(err.contains("string"), "{err}");
    }

    #[test]
    fn moves_a_heredoc_and_multiline_values() {
        let body = "        $s = <<<TXT\n            Hello $n\n            TXT;\n        if ($n) {\n            return strtoupper($<|>s);\n        }\n        return '';";
        let out = one(&method(body), Mode::All).unwrap();
        assert!(out.contains("        if ($n) {\n            return strtoupper(<<<TXT\n                Hello $n\n                TXT);\n        }"), "{out}");
        let body = "        $list = [\n            'a' => 1,\n        ];\n        if ($n) {\n            return $li<|>st;\n        }\n        return [];";
        let out = one(&method(body), Mode::All).unwrap();
        assert!(out.contains("            return [\n                'a' => 1,\n            ];"), "{out}");
    }

    #[test]
    fn refuses_variables_it_cant_inline_safely() {
        let cases = [
            ("        $s = 1;\n        $s = 2;\n        return $<|>s;", "more than once"),
            ("        $s = 1;\n        $s++;\n        return $<|>s;", "changed"),
            ("        echo $s;\n        $s = 1;\n        return $<|>s;", "before"),
            ("        $s = $n;\n        $n++;\n        return $<|>s;", "$n changes"),
            ("        $s = 1;\n        return function () use ($s) { return $<|>s; };", "captures"),
            ("        $s = 1;\n        return compact('s') + [$<|>s];", "by name"),
            ("        if ($n) {\n            $s = 1;\n        }\n        return $<|>s;", "inside a block"),
            ("        return $<|>n;", "parameter"),
            ("        $s = [];\n        sort($s);\n        return $<|>s;", "changed"),
        ];
        for (body, why) in cases {
            let err = one(&method(body), Mode::All).unwrap_err();
            assert!(err.contains(why), "{body}: {err}");
        }
    }

    #[test]
    fn warns_when_a_call_would_run_another_number_of_times() {
        let t = target(&method("        $u = $this->load();\n        return [$u, $<|>u];")).unwrap();
        assert_eq!(t["choices"][0]["warning"], "$this->load() will run 2 times instead of once.");
        assert_eq!(t["choices"][1]["warning"], "$this->load() will run twice: in the assignment and here.");
        assert!(t["warnings"].as_array().unwrap().is_empty());
        let t = target(&method("        $u = $this->load();\n        return $n > 1 && $<|>u;")).unwrap();
        assert_eq!(t["warnings"][0], "$this->load() will run only when $n > 1 is true.");
        let t = target(&method("        $u = $n + 1;\n        return [$u, $<|>u];")).unwrap();
        assert!(t["warnings"].as_array().unwrap().is_empty());
    }

    // ---- Constants ----

    const ORDER: &str = "<?php\nnamespace App;\n\nuse App\\Support\\Money;\n\nclass Order\n{\n    public const BASE = 10;\n\n    /** The most items an order holds. */\n    public const LIMIT = self::BASE * Money::UNIT;\n\n    public function full(int $n): bool\n    {\n        return $n >= self::LIMIT;\n    }\n}\n";

    #[test]
    fn inlines_a_constant_everywhere_and_removes_it() {
        let files = [
            ("app/Support/Money.php", "<?php\nnamespace App\\Support;\nclass Money { public const UNIT = 100; }\n"),
            ("app/Order.php", ORDER),
            ("app/use.php", "<?php\nnamespace Other;\n\nuse App\\Order;\n\nfunction f() { return Order::LI<|>MIT / 2; }\n"),
        ];
        let (files, skipped) = inline(&files, Mode::All).unwrap();
        assert!(skipped.is_empty(), "{skipped:?}");
        assert_eq!(files["use.php"], "<?php\nnamespace Other;\n\nuse App\\Order;\nuse App\\Support\\Money;\n\nfunction f() { return Order::BASE * Money::UNIT / 2; }\n");
        let order = &files["Order.php"];
        assert!(order.contains("    public const BASE = 10;\n\n    public function full"), "{order}");
        assert!(order.contains("return $n >= self::BASE * Money::UNIT;"), "{order}");
    }

    #[test]
    fn inlines_one_use_of_a_constant_or_one_of_several_items() {
        let text = "<?php\nclass A\n{\n    const X = 1, Y = 2;\n    function f() { return self::<|>Y + self::Y; }\n}\n";
        let out = one(text, Mode::This).unwrap();
        assert!(out.contains("const X = 1, Y = 2;") && out.contains("return 2 + self::Y;"), "{out}");
        let out = one(text, Mode::All).unwrap();
        assert!(out.contains("    const X = 1;\n") && out.contains("return 2 + 2;"), "{out}");
        let out = one("<?php\nconst GREETING = 'hi';\necho GREE<|>TING;\n", Mode::All).unwrap();
        assert_eq!(out, "<?php\necho 'hi';\n");
        let err = one("<?php\nenum E { case A; }\necho E::<|>A;\n", Mode::All).unwrap_err();
        assert!(err.contains("enum case"), "{err}");
    }

    #[test]
    fn skips_uses_that_cant_see_what_the_value_names() {
        let files = [
            ("a.php", "<?php\nclass A\n{\n    private const SECRET = 1;\n    public const SHOWN = self::SECRET + 1;\n}\n"),
            ("b.php", "<?php\necho A::SHO<|>WN;\n"),
        ];
        let (files, skipped) = inline(&files, Mode::All).unwrap();
        assert_eq!(skipped, ["2:it uses A::SECRET, which is private there"]);
        assert!(files.get("a.php").is_none_or(|a| a.contains("SHOWN")), "{files:?}");
    }

    // ---- Methods ----

    #[test]
    fn inlines_a_method_on_this() {
        let text = "<?php\nclass A\n{\n    private int $n = 1;\n\n    public function run(): int\n    {\n        $x = $this->dou<|>ble(3) + 1;\n        return $x;\n    }\n\n    private function double(int $v): int\n    {\n        return $v * 2 + $this->n;\n    }\n}\n";
        let out = one(text, Mode::All).unwrap();
        assert_eq!(out, "<?php\nclass A\n{\n    private int $n = 1;\n\n    public function run(): int\n    {\n        $x = 3 * 2 + $this->n + 1;\n        return $x;\n    }\n}\n");
    }

    #[test]
    fn inlines_statements_before_the_statement_and_keeps_argument_order() {
        let text = "<?php\nclass A\n{\n    public function run(): int\n    {\n        return $this->sc<|>ore($this->load(), 2) * 3;\n    }\n\n    public function score(int $base, int $times): int\n    {\n        $sum = 0;\n        for ($i = 0; $i < $times; $i++) {\n            $sum += $base;\n        }\n        return $sum;\n    }\n\n    public function load(): int { return 1; }\n}\n";
        let out = one(text, Mode::Keep).unwrap();
        assert!(
            out.contains("        $base = $this->load();\n        $sum = 0;\n        for ($i = 0; $i < 2; $i++) {\n            $sum += $base;\n        }\n        return $sum * 3;"),
            "{out}"
        );
        assert!(out.contains("public function score"), "{out}");
    }

    #[test]
    fn a_call_alone_becomes_the_body() {
        let text = "<?php\nclass A\n{\n    public function run(array $log): void\n    {\n        $this->wri<|>te($log, 'x');\n    }\n\n    public function write(array $log, string $line): void\n    {\n        $log[] = $line;\n        echo count($log);\n    }\n}\n";
        let out = one(text, Mode::Keep).unwrap();
        assert!(out.contains("    {\n        $log2 = $log;\n        $log2[] = 'x';\n        echo count($log2);\n    }\n\n    public function write"), "{out}");
    }

    #[test]
    fn renames_locals_that_clash_with_the_callers() {
        let text = "<?php\nfunction twice(int $v): int\n{\n    $sum = $v + $v;\n    return $sum;\n}\nfunction run(): int\n{\n    $sum = 5;\n    $r = tw<|>ice($sum);\n    return $sum + $r;\n}\n";
        let out = one(text, Mode::All).unwrap();
        assert_eq!(out, "<?php\nfunction run(): int\n{\n    $sum = 5;\n    $sum2 = $sum + $sum;\n    $r = $sum2;\n    return $sum + $r;\n}\n");
    }

    #[test]
    fn inlines_across_files_with_the_receiver_for_this_and_imports() {
        let files = [
            ("app/Money.php", "<?php\nnamespace App\\Support;\nclass Money { public static function of(int $c): self { return new self(); } }\n"),
            ("app/Order.php", "<?php\nnamespace App;\n\nuse App\\Support\\Money;\n\nclass Order\n{\n    public int $cents = 0;\n\n    public function total(): Money\n    {\n        return Money::of($this->cents);\n    }\n}\n"),
            ("app/use.php", "<?php\nnamespace Other;\n\nfunction f(\\App\\Order $order) { return $order->to<|>tal(); }\n"),
        ];
        let (files, skipped) = inline(&files, Mode::All).unwrap();
        assert!(skipped.is_empty(), "{skipped:?}");
        assert_eq!(files["use.php"], "<?php\nnamespace Other;\n\nuse App\\Support\\Money;\n\nfunction f(\\App\\Order $order) { return Money::of($order->cents); }\n");
        assert!(!files["Order.php"].contains("function total"), "{}", files["Order.php"]);
    }

    #[test]
    fn skips_calls_it_cant_inline_and_keeps_the_method() {
        let files = [
            ("app/Order.php", "<?php\nclass Order\n{\n    private int $cents = 0;\n\n    public function total(): int\n    {\n        return $this->cents;\n    }\n\n    public function show(): int { return $this->to<|>tal(); }\n}\n"),
            ("app/use.php", "<?php\nfunction f(Order $o, bool $b) { return $o->total(); }\n"),
        ];
        let (files, skipped) = inline(&files, Mode::All).unwrap();
        assert_eq!(skipped, ["2:it uses Order::$cents, which is private there"]);
        assert!(files["Order.php"].contains("public function show(): int { return $this->cents; }"), "{}", files["Order.php"]);
        assert!(files["Order.php"].contains("function total"), "kept: {}", files["Order.php"]);
    }

    #[test]
    fn inlines_a_traits_method_on_another_object_as_the_class_that_uses_it() {
        let files = [
            ("app/HasTotal.php", "<?php\ntrait HasTotal\n{\n    public function total(): int\n    {\n        return $this->cents * self::RATE + static::BONUS;\n    }\n}\n"),
            ("app/Base.php", "<?php\nclass Base\n{\n    use HasTotal;\n\n    const RATE = 2;\n    const BONUS = 1;\n    public int $cents = 0;\n}\nclass Order extends Base {}\n"),
            ("app/use.php", "<?php\nfunction f(Order $o) { return $o->to<|>tal(); }\nfunction g(Base $b) { return $b->total(); }\n"),
        ];
        let (files, skipped) = inline(&files, Mode::All).unwrap();
        assert!(skipped.is_empty(), "{skipped:?}");
        // `self` is the class that uses the trait; `static` is the object's own class.
        assert_eq!(files["use.php"], "<?php\nfunction f(Order $o) { return $o->cents * Base::RATE + $o::BONUS; }\nfunction g(Base $b) { return $b->cents * Base::RATE + $b::BONUS; }\n");
        assert!(!files["HasTotal.php"].contains("function total"), "{}", files["HasTotal.php"]);
    }

    #[test]
    fn skips_a_traits_method_where_the_class_cant_be_told() {
        let files = [
            ("app/T.php", "<?php\ntrait T\n{\n    public function label(): string\n    {\n        return self::class;\n    }\n}\nclass A { use T; }\nclass B { use T; }\nclass C { use T; public function show() { return $this->lab<|>el(); } }\n"),
            ("app/use.php", "<?php\nfunction g(A|B $ab) { return $ab->label(); }\n"),
        ];
        let (files, skipped) = inline(&files, Mode::All).unwrap();
        assert_eq!(skipped, ["2:it's a trait's method, and the object can be A or B, which each use the trait"]);
        assert!(files["T.php"].contains("public function show() { return self::class; }"), "{}", files["T.php"]);
        assert!(files["T.php"].contains("function label"), "kept: {}", files["T.php"]);
    }

    #[test]
    fn writes_static_as_the_class_the_call_runs_on() {
        let text = "<?php\nclass Model\n{\n    public static function make(): static\n    {\n        return new static();\n    }\n\n    public static function fresh(): static\n    {\n        return static::make();\n    }\n}\nclass User extends Model\n{\n    public static function again(): static\n    {\n        return self::make();\n    }\n}\n$u = User::ma<|>ke();\n$m = Model::make();\n$c = $u->make();\n";
        let out = one(text, Mode::All).unwrap();
        // A keyword call forwards the class it runs on, so `static` stays; a named class or an object is written.
        assert!(out.contains("        return new static();\n    }\n}\nclass User"), "{out}");
        assert!(out.contains("    public static function again(): static\n    {\n        return new static();"), "{out}");
        assert!(out.contains("$u = new User();\n$m = new Model();\n$c = new $u();\n"), "{out}");
        assert!(!out.contains("function make"), "{out}");
    }

    #[test]
    fn skips_static_in_a_closure_on_another_object() {
        let text = "<?php\nclass A\n{\n    public function each(): \\Closure\n    {\n        return function () { return static::class; };\n    }\n}\nfunction f(A $a) { return $a->ea<|>ch(); }\n";
        let (_, skipped) = inline(&[("test.php", text)], Mode::All).unwrap();
        assert_eq!(skipped, ["9:it uses static:: inside a closure, which can't see $a"]);
    }

    #[test]
    fn refuses_methods_it_cant_inline() {
        let cases = [
            ("public function f(int $n) { if ($n) { return 1; } return 2; }", "returns early"),
            ("public function f(int $n) { yield $n; }", "generator"),
            ("public function f(int &$n) { return $n; }", "by reference"),
            ("public function f(int ...$n) { return $n; }", "variadic"),
            ("public function f(int $n) { static $c = 0; return $n; }", "static variables"),
            ("public function f(int $n) { return __METHOD__; }", "__METHOD__"),
        ];
        for (decl, why) in cases {
            let text = format!("<?php\nclass A\n{{\n    {decl}\n    public function g() {{ return $this-><|>f(1); }}\n}}\n");
            let err = one(&text, Mode::All).unwrap_err();
            assert!(err.contains(why), "{decl}: {err}");
        }
        let text = "<?php\nclass A { public function f() { return 1; } public function g() { return $this-><|>f(); } }\nclass B extends A { public function f() { return 2; } }\n";
        assert!(one(text, Mode::All).unwrap_err().contains("overrides"));
    }

    #[test]
    fn skips_calls_whose_statements_would_run_at_another_time() {
        let text = "<?php\nclass A\n{\n    public function f(): int\n    {\n        $a = 1;\n        return $a;\n    }\n\n    public function g(bool $b): bool\n    {\n        return $b && $this-><|>f() > 0;\n    }\n}\n";
        let (_, skipped) = inline(&[("test.php", text)], Mode::All).unwrap();
        assert_eq!(skipped.len(), 1);
        assert!(skipped[0].contains("runs only when $b is true"), "{skipped:?}");
    }

    #[test]
    fn named_arguments_and_defaults_fill_the_parameters() {
        let text = "<?php\nfunction greet(string $name, string $greeting = 'Hello'): string\n{\n    return \"$greeting, $name\";\n}\necho gre<|>et(greeting: 'Hi', name: $user);\necho greet('Ann');\n";
        let out = one(text, Mode::All).unwrap();
        assert_eq!(out, "<?php\n$greeting = 'Hi';\necho \"$greeting, $user\";\n$name = 'Ann';\n$greeting = 'Hello';\necho \"$greeting, $name\";\n");
    }

    #[test]
    fn lists_code_actions_at_the_caret() {
        let fx = Fixture::one(&method("        $s = $n + 1;\n        return $<|>s;"));
        let at = fx.at();
        let range = Range { start: at.position, end: at.position };
        let titles: Vec<String> = with_ctx(&fx.snap, &at.text_document.uri, |ctx| candidates(ctx, range)).unwrap().into_iter().map(|c| c.title).collect();
        assert_eq!(titles, ["Inline variable $s"]);
        let edit = with_ctx(&fx.snap, &at.text_document.uri, |ctx| resolve(ctx, range)).flatten().unwrap();
        assert!(serde_json::to_string(&edit).unwrap().contains("$n + 1"));
    }
}
