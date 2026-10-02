//! Extract Variable, Extract Constant, Introduce Field, and Introduce Parameter: an expression, and the other
//! occurrences of it chosen to go with it, become a new variable, class constant, property, or parameter.
//!
//! The editor asks `tusk/extractTargets` for the expressions it can offer at the caret or selection, innermost
//! first, each with its occurrences, then `tusk/extract` for the edit of the one chosen. That edit marks each
//! place the new name goes with `\0`, so the editor can rename them all in place as the name is typed. Other
//! editors get the first three as code actions on a selection, which replace every occurrence and keep the
//! suggested name. Introduce Parameter also rewrites calls, so the editor does that part through Change Signature.

use lsp_types::{Range, TextEdit, Uri, WorkspaceEdit};
use mago_names::kind::NameKind;
use mago_span::HasSpan;
use mago_syntax::cst::{
    Access, Call, ClassLikeConstantSelector, ClassLikeMember, ClassLikeMemberSelector, Expression, Literal, Node, Property,
    Statement, StringPart, UnaryPrefixOperator, Variable,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::extract::php_type;
use super::{Candidate, file_edit, indent_unit, line_indent};
use crate::features::{Ctx, with_ctx};
use crate::imports::import_edits;
use crate::locate::{variable_scope, walk};
use crate::server::Snapshot;

/// Where the name goes in an edit's text.
const NAME: char = '\0';

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Variable,
    Constant,
    Field,
    Parameter,
}

impl Kind {
    fn what(self) -> &'static str {
        match self {
            Kind::Variable => "extract it into a variable",
            Kind::Constant => "extract a constant",
            Kind::Field => "put it in a field",
            Kind::Parameter => "make it a parameter",
        }
    }
}

type Span = (u32, u32);

fn span(node: &impl HasSpan) -> Span {
    let s = node.span();
    (s.start.offset, s.end.offset)
}

fn contains(outer: Span, inner: Span) -> bool {
    outer.0 <= inner.0 && inner.1 <= outer.1
}

/// An expression that can be extracted, with what the extraction needs to know about where it is.
struct Target {
    span: Span,
    /// The span of the scope that holds its variables: a function, method, closure, or the file.
    scope: Span,
    /// The class, trait, interface, or enum around it, for constants and fields.
    owner: Option<Span>,
    /// For a field: the method is static, so the field is too.
    is_static: bool,
    /// Its value is a constant expression, so a field or parameter can take it as a default.
    constant: bool,
}

/// The innermost class-like node in `path`, with its kind.
fn owner_of<'a>(path: &[Node<'a, 'a>]) -> Option<(usize, Node<'a, 'a>)> {
    path.iter().enumerate().rev().find(|(_, n)| matches!(n, Node::Class(_) | Node::Interface(_) | Node::Trait(_) | Node::Enum(_) | Node::AnonymousClass(_))).map(|(i, n)| (i, *n))
}

fn members<'a>(owner: Node<'a, 'a>) -> Option<(&'a mago_syntax::cst::Sequence<'a, ClassLikeMember<'a>>, Span)> {
    let (members, l, r) = match owner {
        Node::Class(c) => (&c.members, c.left_brace, c.right_brace),
        Node::Interface(c) => (&c.members, c.left_brace, c.right_brace),
        Node::Trait(c) => (&c.members, c.left_brace, c.right_brace),
        Node::Enum(c) => (&c.members, c.left_brace, c.right_brace),
        Node::AnonymousClass(c) => (&c.members, c.left_brace, c.right_brace),
        _ => return None,
    };
    Some((members, (l.start.offset, r.end.offset)))
}

/// Nodes that hold a list of statements, before any one of which a declaration can go.
fn holds_statements(node: &Node<'_, '_>) -> bool {
    matches!(
        node,
        Node::Block(_)
            | Node::Program(_)
            | Node::NamespaceImplicitBody(_)
            | Node::SwitchExpressionCase(_)
            | Node::SwitchDefaultCase(_)
            | Node::IfColonDelimitedBody(_)
            | Node::IfColonDelimitedBodyElseIfClause(_)
            | Node::IfColonDelimitedBodyElseClause(_)
            | Node::ForeachColonDelimitedBody(_)
            | Node::ForColonDelimitedBody(_)
            | Node::WhileColonDelimitedBody(_)
            | Node::DeclareColonDelimitedBody(_)
    )
}

/// Whether the expression at the end of `path` is written to or referenced rather than read: an assignment's
/// target, `++`'s operand, a foreach variable, `isset()`'s argument, or the array or object such a thing reaches into.
fn written(path: &[Node<'_, '_>]) -> bool {
    let mut child = span(path.last().unwrap());
    for node in path[..path.len() - 1].iter().rev() {
        match node {
            Node::Assignment(a) => return contains(span(a.lhs), child),
            Node::UnaryPrefix(u) => return matches!(u.operator, UnaryPrefixOperator::PreIncrement(_) | UnaryPrefixOperator::PreDecrement(_) | UnaryPrefixOperator::Reference(_)),
            Node::UnaryPostfix(_)
            | Node::ForeachTarget(_)
            | Node::ForeachKeyValueTarget(_)
            | Node::ForeachValueTarget(_)
            | Node::IssetConstruct(_)
            | Node::EmptyConstruct(_)
            | Node::Unset(_)
            | Node::List(_)
            | Node::Global(_)
            | Node::StaticItem(_)
            | Node::StaticConcreteItem(_)
            | Node::ClosureUseClause(_)
            | Node::ArrayAppend(_) => return true,
            Node::ArrayAccess(a) if span(a.array) != child => return false,
            Node::PropertyAccess(p) if span(p.object) != child => return false,
            Node::NullSafePropertyAccess(p) if span(p.object) != child => return false,
            Node::ArrayAccess(_) | Node::PropertyAccess(_) | Node::NullSafePropertyAccess(_) | Node::StaticPropertyAccess(_) | Node::Expression(_) | Node::Access(_) | Node::Variable(_) => {}
            _ => return false,
        }
        child = span(node);
    }
    false
}

/// Whether the expression at the end of `path` names something rather than being a value: a called function's
/// name, or the class of `new`, `::`, or a static call.
fn names_something(path: &[Node<'_, '_>]) -> bool {
    let me = span(path.last().unwrap());
    path.iter().rev().skip(1).find(|n| !matches!(n, Node::Expression(_))).is_some_and(|parent| match parent {
        Node::FunctionCall(c) => span(c.function) == me,
        Node::Instantiation(i) => span(i.class) == me,
        Node::StaticMethodCall(c) => span(c.class) == me,
        Node::ClassConstantAccess(c) => span(c.class) == me,
        Node::StaticPropertyAccess(c) => span(c.class) == me,
        _ => false,
    })
}

/// Every node under `node`, itself included, with the path of its ancestors from `node` down.
fn walk_under<'a>(node: Node<'a, 'a>, f: &mut impl FnMut(Node<'a, 'a>, &[Node<'a, 'a>])) {
    fn go<'a>(node: Node<'a, 'a>, path: &mut Vec<Node<'a, 'a>>, f: &mut impl FnMut(Node<'a, 'a>, &[Node<'a, 'a>])) {
        f(node, path);
        path.push(node);
        node.visit_children(|child| go(child, path, f));
        path.pop();
    }
    go(node, &mut vec![], f);
}

/// The variables an expression reads from around it, without `$`: those of closures and arrow functions inside
/// it that are their own aren't.
fn free_variables(expr: Node<'_, '_>) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    walk_under(expr, &mut |node, ancestors| {
        let Node::DirectVariable(v) = node else { return };
        for (i, a) in ancestors.iter().enumerate() {
            match a {
                Node::Closure(_) if !ancestors[i..].iter().any(|c| matches!(c, Node::ClosureUseClause(_))) => return,
                Node::ArrowFunction(f) if f.parameter_list.parameters.iter().any(|p| p.variable.name == v.name) => return,
                _ => {}
            }
        }
        let name = String::from_utf8_lossy(&v.name[1..]).into_owned();
        if !out.contains(&name) {
            out.push(name);
        }
    });
    out
}

fn has_class_keyword(expr: Node<'_, '_>) -> bool {
    let mut found = false;
    walk_under(expr, &mut |node, _| found |= matches!(node, Node::Expression(Expression::Self_(_) | Expression::Static(_) | Expression::Parent(_))));
    found
}

const NOT_A_VALUE: &str = "Choose a value, such as $a + $b or $user->name.";

/// Whether the expression at the end of `path` can become a `kind`, or why not.
fn target(ctx: &Ctx<'_>, path: &[Node<'_, '_>], kind: Kind) -> Result<Target, String> {
    let node = *path.last().unwrap();
    let Node::Expression(expr) = node else { return Err("That isn't an expression.".into()) };
    let me = span(&node);
    let not_a_value = NOT_A_VALUE;
    match expr {
        Expression::Variable(_) | Expression::Identifier(_) | Expression::Self_(_) | Expression::Static(_) | Expression::Parent(_) | Expression::Error(_) => {
            return Err(not_a_value.into());
        }
        Expression::Assignment(_) | Expression::List(_) | Expression::ArrayAppend(_) => return Err("An assignment can't be extracted; choose its value.".into()),
        Expression::Yield(_) | Expression::Throw(_) => return Err("A yield or throw can't be extracted, as it would run at another time.".into()),
        Expression::Construct(mago_syntax::cst::Construct::Exit(_) | mago_syntax::cst::Construct::Die(_)) => return Err(not_a_value.into()),
        _ => {}
    }
    if names_something(path) {
        return Err(not_a_value.into());
    }
    if written(path) {
        return Err("The expression is written to here, not read.".into());
    }
    if path.iter().any(|n| matches!(n, Node::Attribute(_) | Node::DeclareItem(_))) {
        return Err(format!("Can't {} in an attribute or declare.", kind.what()));
    }
    let interpolated = path.len() >= 2 && matches!(path[path.len() - 2], Node::StringPart(StringPart::Expression(_)));
    let scope = variable_scope(&ctx.parsed, path);
    let owner = owner_of(path);
    let version = &ctx.index.config.php_version;
    let constant = expr.is_constant(version, false);

    if kind == Kind::Constant {
        let Some((_, owner_node)) = owner else { return Err("Extract Constant works inside a class, trait, interface, or enum.".into()) };
        if !constant {
            return Err("Only literals and constants, such as 'pending' or self::LIMIT * 2, can become a constant.".into());
        }
        if matches!(expr, Expression::ConstantAccess(_) | Expression::Access(Access::ClassConstant(_))) {
            return Err("It's a constant already.".into());
        }
        if path.iter().any(|n| matches!(n, Node::EnumCase(_))) {
            return Err("An enum case's value must be a literal.".into());
        }
        if interpolated {
            return Err("A constant can't be read inside a string.".into());
        }
        return Ok(Target { span: me, scope, owner: Some(span(&owner_node)), is_static: false, constant });
    }

    // The rest hold values computed in code, so not in declarations' constant expressions.
    if path.iter().any(|n| matches!(n, Node::FunctionLikeParameterDefaultValue(_) | Node::Property(_) | Node::ClassLikeConstant(_) | Node::EnumCase(_) | Node::Constant(_) | Node::StaticItem(_))) {
        return Err(format!("Can't {} in a declaration's default value.", kind.what()));
    }
    // An arrow function's parameters don't exist outside it.
    let free = free_variables(node);
    for n in path.iter() {
        if let Node::ArrowFunction(f) = n
            && contains(span(f.expression), me)
            && f.parameter_list.parameters.iter().any(|p| free.iter().any(|v| p.variable.name[1..] == *v.as_bytes()))
        {
            return Err("The expression uses the arrow function's parameters, which don't exist outside it.".into());
        }
    }

    match kind {
        Kind::Variable => Ok(Target { span: me, scope, owner: owner.map(|(_, o)| span(&o)), is_static: false, constant }),
        Kind::Field => {
            let Some((at, owner_node)) = owner else { return Err("Introduce Field works in a method of a class or trait.".into()) };
            match owner_node {
                Node::Interface(_) => return Err("An interface can't have properties.".into()),
                Node::Enum(_) => return Err("An enum can't have properties.".into()),
                _ => {}
            }
            let method = path[at..].iter().find_map(|n| match n {
                Node::Method(m) => Some(m),
                _ => None,
            });
            let Some(method) = method else { return Err("Introduce Field works in a method of a class or trait.".into()) };
            let is_static = method.modifiers.iter().any(|m| m.is_static());
            let static_closure = path[at..].iter().any(|n| match n {
                Node::Closure(c) => c.r#static.is_some(),
                Node::ArrowFunction(f) => f.r#static.is_some(),
                _ => false,
            });
            if static_closure && !is_static {
                return Err("A static closure can't use $this, so it can't read a new field.".into());
            }
            if interpolated && is_static {
                return Err("A static property can't be read inside a string.".into());
            }
            Ok(Target { span: me, scope, owner: Some(span(&owner_node)), is_static, constant })
        }
        Kind::Parameter => {
            let host = path.iter().rev().find(|n| matches!(n, Node::Function(_) | Node::Method(_) | Node::Closure(_)));
            match host {
                Some(Node::Closure(_)) => return Err("Introduce Parameter works in a method or function's own body, not in a closure.".into()),
                None => return Err("Introduce Parameter works inside a method or function.".into()),
                _ => {}
            }
            if free.iter().any(|v| v == "this") {
                return Err("The expression uses $this, which calls outside the class can't pass.".into());
            }
            if !free.is_empty() {
                return Err("The expression uses the method's variables, which calls can't pass. Extract a variable instead (⌥⌘V).".into());
            }
            // A default may name the class; a value that calls pass would name theirs instead.
            if !constant && has_class_keyword(node) {
                return Err("The expression uses self, static, or parent, which mean another class at the calls.".into());
            }
            let constant = constant || expr.is_constant(version, true);
            Ok(Target { span: me, scope, owner: owner.map(|(_, o)| span(&o)), is_static: false, constant })
        }
        Kind::Constant => unreachable!(),
    }
}

/// The path to the outermost expression node spanning exactly `s`.
fn path_to<'a>(ctx: &Ctx<'a>, s: Span) -> Option<Vec<Node<'a, 'a>>> {
    let path = ctx.parsed.path_at(s.0);
    let i = path.iter().position(|n| matches!(n, Node::Expression(_)) && span(n) == s)?;
    Some(path[..=i].to_vec())
}

/// The selection with surrounding whitespace dropped.
fn trimmed(text: &str, start: usize, end: usize) -> (u32, u32) {
    let (mut start, mut end) = (start.min(text.len()), end.min(text.len()));
    while start < end && text[start..].starts_with(char::is_whitespace) {
        start += text[start..].chars().next().map_or(1, char::len_utf8);
    }
    while end > start && text[..end].ends_with(char::is_whitespace) {
        end -= text[..end].chars().next_back().map_or(1, char::len_utf8);
    }
    (start as u32, end as u32)
}

/// The expressions to offer: around the caret, innermost first, or the selection, widened to the smallest whole
/// expression around it. `true` with a widened selection.
fn targets(ctx: &Ctx<'_>, range: Range, kind: Kind) -> Result<(Vec<Target>, bool), String> {
    let text = &ctx.doc.text;
    let (start, end) = (ctx.offset(range.start) as usize, ctx.offset(range.end) as usize);
    let (start, end) = if start == end { (start as u32, end as u32) } else { trimmed(text, start, end) };
    let path = ctx.parsed.path_at(start);
    let mut seen: Vec<Span> = vec![];
    let mut found = vec![];
    let mut reason = None;
    for i in (0..path.len()).rev() {
        let n = path[i];
        if !matches!(n, Node::Expression(_)) || !contains(span(&n), (start, end)) || seen.contains(&span(&n)) {
            continue;
        }
        seen.push(span(&n));
        match target(ctx, &path[..=i], kind) {
            Ok(t) => found.push(t),
            // A selection of exactly an expression that can't be extracted isn't widened past it.
            Err(e) if start != end && span(&n) == (start, end) => return Err(e),
            Err(e) => {
                // The innermost specific reason: a bare variable or name says less than what's around it.
                if reason.as_ref().is_none_or(|r: &String| r == NOT_A_VALUE) {
                    reason = Some(e);
                }
            }
        }
    }
    if start != end {
        // A selection is one expression: exactly it, or else the smallest one around it.
        let snapped = found.first().is_some_and(|t| t.span != (start, end));
        return match found.into_iter().next() {
            Some(t) => Ok((vec![t], snapped)),
            None => Err(reason.unwrap_or_else(|| format!("Select a whole expression to {}, such as $a + $b or $user->name.", kind.what()))),
        };
    }
    if found.is_empty() {
        return Err(reason.unwrap_or_else(|| format!("Put the cursor in an expression to {}.", kind.what())));
    }
    Ok((found, false))
}

/// The text of a span with comments and whitespace between tokens dropped, to compare expressions as code.
fn code_of(ctx: &Ctx<'_>, s: Span) -> String {
    let text = ctx.doc.text.as_bytes();
    let mut out = String::new();
    let mut at = s.0;
    for t in ctx.parsed.program.trivia.iter() {
        let (ts, te) = span(t);
        if te <= at || ts >= s.1 {
            continue;
        }
        out.push_str(&String::from_utf8_lossy(&text[at as usize..ts.max(at) as usize]));
        // Two words stay apart: `new Foo` isn't `newFoo`.
        let word = |b: Option<&u8>| b.is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b >= 0x80);
        if word(out.as_bytes().last()) && word(text.get(te as usize)) {
            out.push(' ');
        }
        at = te.min(s.1);
    }
    out.push_str(&String::from_utf8_lossy(&text[at as usize..s.1 as usize]));
    out
}

/// Every occurrence of the target where the same kind of extraction could replace it, in order, itself included.
fn occurrences(ctx: &Ctx<'_>, t: &Target, kind: Kind) -> Vec<Span> {
    let code = code_of(ctx, t.span);
    let region = if kind == Kind::Constant { t.owner.unwrap_or(t.scope) } else { t.scope };
    let mut found: Vec<Span> = vec![];
    walk(&ctx.parsed, |node, ancestors| {
        if !matches!(node, Node::Expression(_)) {
            return;
        }
        let s = span(&node);
        // The first and last characters are code, so a cheap look rules most out.
        let bytes = ctx.doc.text.as_bytes();
        let ends = |x: Span| (bytes[x.0 as usize], bytes[x.1 as usize - 1]);
        if !contains(region, s) || s.0 == s.1 || s.1 as usize > bytes.len() || found.contains(&s) || ends(s) != ends(t.span) || code_of(ctx, s) != code {
            return;
        }
        let mut path = ancestors.to_vec();
        path.push(node);
        let Ok(other) = target(ctx, &path, kind) else { return };
        // The same variables: a closure inside has its own, and a nested class its own `self`.
        let same = if kind == Kind::Constant { other.owner == t.owner } else { other.scope == t.scope };
        if same && !found.iter().any(|f| contains(*f, s) || contains(s, *f)) {
            found.push(s);
        }
    });
    if !found.contains(&t.span) {
        found.push(t.span);
    }
    found.sort();
    found
}

/// Where a statement that declares a value for `uses` goes: before the statement holding the first one, in the
/// innermost list of statements that holds them all.
struct Point {
    offset: u32,
    indent: String,
    /// The statement starts its line, so the declaration goes on a line of its own.
    own_line: bool,
    /// The statement is the one use alone, as `foo();`, which then becomes the assignment.
    replace: Option<Span>,
}

fn statement_point(ctx: &Ctx<'_>, uses: &[Span]) -> Result<Point, String> {
    let first = uses[0];
    let last = uses.iter().map(|u| u.1).max().unwrap_or(first.1);
    let path = path_to(ctx, first).ok_or("The expression is no longer there.")?;
    for i in (1..path.len()).rev() {
        let (Node::Statement(statement), holder) = (path[i], path[i - 1]) else { continue };
        if !holds_statements(&holder) || span(&holder).1 < last {
            continue;
        }
        if path[i + 1..].iter().any(|n| {
            matches!(n, Node::Class(_) | Node::Interface(_) | Node::Trait(_) | Node::Enum(_) | Node::AnonymousClass(_) | Node::Function(_) | Node::Method(_) | Node::Closure(_))
        }) {
            return Err("it's in a declaration, where statements can't go".into());
        }
        let (s, _) = span(statement);
        let text = &ctx.doc.text;
        let line_start = text[..s as usize].rfind('\n').map_or(0, |i| i + 1);
        let own_line = text[line_start..s as usize].trim().is_empty();
        let replace = match statement {
            Statement::Expression(e) if uses.len() == 1 && span(e.expression) == first => Some(first),
            _ => None,
        };
        return Ok(Point { offset: s, indent: line_indent(text, s as usize), own_line, replace });
    }
    Err("it isn't inside a function's statements".into())
}

/// The expression's text as a value on the right of `=`: without the parentheses around it, and with them for
/// `and`, `or`, and `xor`, which bind looser than `=`.
fn value_text(ctx: &Ctx<'_>, s: Span) -> String {
    let text = &ctx.doc.text;
    let path = path_to(ctx, s);
    let mut expr = path.as_ref().and_then(|p| match p.last() {
        Some(Node::Expression(e)) => Some(*e),
        _ => None,
    });
    while let Some(Expression::Parenthesized(p)) = expr {
        expr = Some(p.expression);
    }
    let Some(expr) = expr else { return text[s.0 as usize..s.1 as usize].to_string() };
    let inner = span(expr);
    let value = &text[inner.0 as usize..inner.1 as usize];
    match expr {
        Expression::Binary(b) if b.operator.is_low_precedence() => format!("({value})"),
        _ => value.to_string(),
    }
}

// ---- Names ----

fn words(text: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut word = String::new();
    let mut prev_lower = false;
    for c in text.chars() {
        if !c.is_alphanumeric() {
            if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
            prev_lower = false;
            continue;
        }
        if c.is_uppercase() && prev_lower && !word.is_empty() {
            out.push(std::mem::take(&mut word));
        }
        prev_lower = c.is_lowercase() || c.is_ascii_digit();
        word.push(c);
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

fn camel(text: &str) -> Option<String> {
    let parts = words(text);
    let first = parts.first()?;
    if first.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let mut out = first.to_lowercase();
    for p in &parts[1..] {
        let lower = p.to_lowercase();
        let mut chars = lower.chars();
        if let Some(c) = chars.next() {
            out.extend(c.to_uppercase());
            out.push_str(chars.as_str());
        }
    }
    Some(out)
}

fn selector_name(s: &ClassLikeMemberSelector<'_>) -> Option<String> {
    match s {
        ClassLikeMemberSelector::Identifier(i) => Some(String::from_utf8_lossy(i.value).into_owned()),
        _ => None,
    }
}

fn short(name: &[u8]) -> String {
    let name = String::from_utf8_lossy(name);
    name.rsplit('\\').next().unwrap_or(&name).to_string()
}

/// A variable or property name for an expression, as PhpStorm suggests: `$user->getEmail()` gives `email`,
/// `$item['unit_price']` gives `unitPrice`, `new Invoice()` gives `invoice`, and `count($a)` gives `count`.
fn suggested_base(ctx: &Ctx<'_>, s: Span) -> String {
    let path = path_to(ctx, s);
    let mut expr = path.as_ref().and_then(|p| match p.last() {
        Some(Node::Expression(e)) => Some(*e),
        _ => None,
    });
    while let Some(Expression::Parenthesized(p)) = expr {
        expr = Some(p.expression);
    }
    let accessor = |name: String| {
        let stripped = ["get", "is", "has"].iter().find_map(|p| name.strip_prefix(p).filter(|r| r.starts_with(|c: char| c.is_uppercase())).map(str::to_string));
        stripped.unwrap_or(name)
    };
    let name = match expr {
        Some(Expression::Instantiation(i)) => match i.class {
            Expression::Identifier(id) => Some(short(id.value())),
            _ => None,
        },
        Some(Expression::Call(Call::Method(c))) => selector_name(&c.method).map(accessor),
        Some(Expression::Call(Call::NullSafeMethod(c))) => selector_name(&c.method).map(accessor),
        Some(Expression::Call(Call::StaticMethod(c))) => selector_name(&c.method).map(accessor),
        Some(Expression::Call(Call::Function(c))) => match c.function {
            Expression::Identifier(id) => Some(short(id.value())),
            _ => None,
        },
        Some(Expression::Access(Access::Property(p))) => selector_name(&p.property),
        Some(Expression::Access(Access::NullSafeProperty(p))) => selector_name(&p.property),
        Some(Expression::Access(Access::StaticProperty(p))) => match &p.property {
            Variable::Direct(v) => Some(String::from_utf8_lossy(&v.name[1..]).into_owned()),
            _ => None,
        },
        Some(Expression::Access(Access::ClassConstant(c))) => match &c.constant {
            ClassLikeConstantSelector::Identifier(i) => Some(String::from_utf8_lossy(i.value).into_owned()),
            _ => None,
        },
        Some(Expression::ConstantAccess(c)) => Some(short(c.name.value())),
        Some(Expression::ArrayAccess(a)) => match a.index {
            Expression::Literal(Literal::String(s)) => s.value.map(|v| String::from_utf8_lossy(v).into_owned()),
            _ => None,
        },
        // A short word or two names itself, as `'price'` gives `price`.
        Some(Expression::Literal(Literal::String(s))) => Some(
            s.value
                .map(|v| String::from_utf8_lossy(v).into_owned())
                .filter(|v| !v.is_empty() && v.len() <= 24 && v.chars().all(|c| c.is_ascii_alphabetic() || matches!(c, ' ' | '_' | '-')) && words(v).len() <= 3)
                .unwrap_or_else(|| "string".into()),
        ),
        Some(Expression::CompositeString(_)) => Some("string".into()),
        Some(Expression::Closure(_) | Expression::ArrowFunction(_)) => Some("callback".into()),
        _ => None,
    };
    // Else the class of its type, when it's an object.
    let name = name.or_else(|| {
        let t = ctx.analysis().type_of(s.0, s.1)?;
        let [mago_codex::ttype::atomic::TAtomic::Object(mago_codex::ttype::atomic::object::TObject::Named(n))] = t.types.as_ref() else { return None };
        Some(short(n.name.as_str_lossy().as_bytes()))
    });
    match name.and_then(|n| camel(&n)) {
        Some(n) if !matches!(n.as_str(), "this" | "true" | "false" | "null") => n,
        _ => "value".into(),
    }
}

fn unique(base: &str, taken: impl Fn(&str) -> bool, sep: &str) -> String {
    (1..).map(|i| if i == 1 { base.to_string() } else { format!("{base}{sep}{i}") }).find(|n| !taken(n)).unwrap()
}

/// A constant's name: a short string's words, as `'pending review'` gives `PENDING_REVIEW`, else `VALUE`.
fn constant_base(ctx: &Ctx<'_>, s: Span) -> String {
    let path = path_to(ctx, s);
    if let Some(Node::Expression(Expression::Literal(Literal::String(lit)))) = path.as_ref().and_then(|p| p.last()) {
        let value = lit.value.map(|v| String::from_utf8_lossy(v).into_owned()).unwrap_or_default();
        let parts: Vec<String> = words(&value).into_iter().take(5).collect();
        if parts.first().is_some_and(|p| !p.starts_with(|c: char| c.is_ascii_digit())) {
            return parts.join("_").to_uppercase();
        }
    }
    "VALUE".into()
}

fn variables_in(ctx: &Ctx<'_>, scope: Span) -> Vec<String> {
    let mut out = vec![];
    walk(&ctx.parsed, |node, _| {
        if let Node::DirectVariable(v) = node
            && contains(scope, span(&node))
        {
            out.push(String::from_utf8_lossy(&v.name[1..]).into_owned());
        }
    });
    out
}

// ---- Class members ----

/// Where a member goes in a class body: after the last member of the kinds `after` chooses, or else after the
/// last member of the kinds `or_after` chooses, or else at the top. The text goes at the start of a line.
fn member_text(ctx: &Ctx<'_>, owner: Span, after: fn(&ClassLikeMember<'_>) -> bool, or_after: fn(&ClassLikeMember<'_>) -> bool, line: &str) -> Option<TextEdit> {
    let text = &ctx.doc.text;
    let path = ctx.parsed.path_at(owner.0);
    let node = path.iter().rev().find(|n| span(*n) == owner)?;
    let (list, (open, _)) = members(*node)?;
    let last_of = |f: fn(&ClassLikeMember<'_>) -> bool| list.iter().filter(|m| f(m)).map(|m| span(m).1).max();
    let first_member = list.iter().next().map(|m| span(m).0);
    let indent = match first_member {
        Some(s) => line_indent(text, s as usize),
        None => format!("{}{}", line_indent(text, owner.0 as usize), indent_unit(text)),
    };
    let line_after = |at: u32| text[at as usize..].find('\n').map_or(text.len(), |i| at as usize + i + 1);
    let (offset, gap_before, gap_after) = match (last_of(after), last_of(or_after)) {
        (Some(end), _) => (line_after(end), false, false),
        (None, Some(end)) => (line_after(end), true, true),
        (None, None) => (line_after(open), false, true),
    };
    let next = text[offset..].lines().next().unwrap_or("").trim();
    let gap_after = gap_after && !next.is_empty() && next != "}";
    let new_text = format!("{}{indent}{line}\n{}", if gap_before { "\n" } else { "" }, if gap_after { "\n" } else { "" });
    Some(TextEdit { range: ctx.doc.range(offset as u32, offset as u32), new_text })
}

fn is_constant_member(m: &ClassLikeMember<'_>) -> bool {
    matches!(m, ClassLikeMember::Constant(_))
}
fn is_header_member(m: &ClassLikeMember<'_>) -> bool {
    matches!(m, ClassLikeMember::TraitUse(_) | ClassLikeMember::EnumCase(_))
}
fn is_property_member(m: &ClassLikeMember<'_>) -> bool {
    matches!(m, ClassLikeMember::Property(_))
}
fn is_before_properties(m: &ClassLikeMember<'_>) -> bool {
    matches!(m, ClassLikeMember::TraitUse(_) | ClassLikeMember::EnumCase(_) | ClassLikeMember::Constant(_))
}

fn class_names(ctx: &Ctx<'_>, owner: Span) -> (Vec<String>, Vec<String>, Option<String>) {
    let path = ctx.parsed.path_at(owner.0);
    let Some(node) = path.iter().rev().find(|n| span(*n) == owner).copied() else { return Default::default() };
    let (mut constants, mut properties) = (vec![], vec![]);
    if let Some((list, _)) = members(node) {
        for m in list.iter() {
            match m {
                ClassLikeMember::Constant(c) => constants.extend(c.items.iter().map(|i| String::from_utf8_lossy(i.name.value).into_owned())),
                ClassLikeMember::EnumCase(c) => constants.push(String::from_utf8_lossy(c.item.name().value).into_owned()),
                ClassLikeMember::Property(Property::Plain(p)) => properties.extend(p.items.iter().map(|i| String::from_utf8_lossy(&i.variable().name[1..]).into_owned())),
                ClassLikeMember::Property(Property::Hooked(p)) => properties.push(String::from_utf8_lossy(&p.item.variable().name[1..]).into_owned()),
                ClassLikeMember::Method(m) => {
                    for p in m.parameter_list.parameters.iter().filter(|p| p.is_promoted_property()) {
                        properties.push(String::from_utf8_lossy(&p.variable.name[1..]).into_owned());
                    }
                }
                _ => {}
            }
        }
    }
    let mut chain = path.clone();
    chain.truncate(path.iter().position(|n| span(n) == owner).map_or(chain.len(), |i| i + 1));
    let fqn = crate::symbol::Resolver::new(&ctx.parsed, None, &ctx.index.codebase).enclosing_class(&chain);
    (constants, properties, fqn)
}

// ---- Edits ----

/// The edit for extracting `t` and the chosen `uses` of it, with the new name marked by `\0`, and the name.
pub struct Extraction {
    pub edits: Vec<TextEdit>,
    pub name: String,
    /// For a parameter: its type, when the analyzer knows it.
    pub r#type: Option<String>,
    pub constant: bool,
}

fn extraction(ctx: &Ctx<'_>, t: &Target, uses: &[Span], kind: Kind) -> Result<Extraction, String> {
    let value = value_text(ctx, t.span);
    let mut imports: Vec<String> = vec![];
    let replaced = |reference: &str, s: Span| -> TextEdit {
        let interpolated = path_to(ctx, s).is_some_and(|p| p.len() >= 2 && matches!(p[p.len() - 2], Node::StringPart(StringPart::Expression(_))));
        let new_text = if interpolated { format!("{{{reference}}}") } else { reference.to_string() };
        TextEdit { range: ctx.doc.range(s.0, s.1), new_text }
    };
    let n = NAME;
    let mut edits: Vec<TextEdit> = vec![];
    let name;
    let mut r#type = None;
    match kind {
        Kind::Variable | Kind::Field => {
            type Taken<'t> = Box<dyn Fn(&str) -> bool + 't>;
            let (reference, taken): (String, Taken<'_>) = if kind == Kind::Variable {
                let vars = variables_in(ctx, t.scope);
                (format!("${n}"), Box::new(move |c: &str| vars.iter().any(|v| v == c)))
            } else {
                let (_, props, fqn) = class_names(ctx, t.owner.unwrap_or_default());
                let codebase = &ctx.index.codebase;
                let reference = if t.is_static { format!("self::${n}") } else { format!("$this->{n}") };
                (
                    reference,
                    Box::new(move |c: &str| {
                        props.iter().any(|p| p == c) || fqn.as_ref().is_some_and(|f| codebase.property_exists(f.as_bytes(), format!("${c}").as_bytes()))
                    }),
                )
            };
            name = unique(&suggested_base(ctx, t.span), taken, "");
            // A field with a constant value gets it as its default; others are set where the expression was.
            let default = kind == Kind::Field && t.constant;
            if !default {
                let point = statement_point(ctx, uses).map_err(|e| format!("Can't {}: {e}.", kind.what()))?;
                match point.replace {
                    Some(s) => edits.push(TextEdit { range: ctx.doc.range(s.0, s.1), new_text: format!("{reference} = {value}") }),
                    None => {
                        let sep = if point.own_line { format!("\n{}", point.indent) } else { " ".into() };
                        edits.push(TextEdit { range: ctx.doc.range(point.offset, point.offset), new_text: format!("{reference} = {value};{sep}") });
                        edits.extend(uses.iter().map(|&u| replaced(&reference, u)));
                    }
                }
            } else {
                edits.extend(uses.iter().map(|&u| replaced(&reference, u)));
            }
            if kind == Kind::Field {
                let hint = ctx.analysis().type_of(t.span.0, t.span.1).and_then(|ty| php_type(ctx, &ty, &mut imports)).filter(|h| h != "null" && h != "void" && h != "never");
                let hint = hint.map(|h| format!("{h} ")).unwrap_or_default();
                let modifiers = if t.is_static { "private static" } else { "private" };
                let default = if default { format!(" = {value}") } else { String::new() };
                let line = format!("{modifiers} {hint}${n}{default};");
                edits.push(member_text(ctx, t.owner.unwrap_or_default(), is_property_member, is_before_properties, &line).ok_or("Can't find the class body.")?);
            }
        }
        Kind::Constant => {
            let owner = t.owner.unwrap_or_default();
            let (constants, _, fqn) = class_names(ctx, owner);
            let codebase = &ctx.index.codebase;
            name = unique(&constant_base(ctx, t.span), |c| constants.iter().any(|k| k == c) || fqn.as_ref().is_some_and(|f| codebase.class_constant_exists(f.as_bytes(), c.as_bytes())), "_");
            let interface = ctx.parsed.path_at(owner.0).iter().any(|n| matches!(n, Node::Interface(_)) && span(n) == owner);
            let visibility = if interface { "public" } else { "private" };
            edits.push(member_text(ctx, owner, is_constant_member, is_header_member, &format!("{visibility} const {n} = {value};")).ok_or("Can't find the class body.")?);
            edits.extend(uses.iter().map(|&u| replaced(&format!("self::{n}"), u)));
        }
        Kind::Parameter => {
            let taken = variables_in(ctx, t.scope);
            name = unique(&suggested_base(ctx, t.span), |c| taken.iter().any(|v| v == c), "");
            // Written in full where the file doesn't import the class, since the dialog writes it as it is.
            r#type = ctx.analysis().type_of(t.span.0, t.span.1).and_then(|ty| {
                let mut needed = vec![];
                let hint = php_type(ctx, &ty, &mut needed)?;
                Some(needed.iter().fold(hint, |h, fqn| {
                    let short = fqn.rsplit('\\').next().unwrap_or(fqn);
                    h.split('|').map(|p| if p.trim_start_matches('?') == short { p.replacen(short, &format!("\\{fqn}"), 1) } else { p.to_string() }).collect::<Vec<_>>().join("|")
                }))
            });
            r#type = r#type.filter(|h| h != "null" && h != "void" && h != "never");
        }
    }
    edits.extend(import_edits(&ctx.doc, ctx.parsed.program, t.span.0, &imports, NameKind::Default));
    Ok(Extraction { edits, name, r#type, constant: t.constant })
}

// ---- Requests ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    text_document: lsp_types::TextDocumentIdentifier,
    range: Range,
    kind: Kind,
    #[serde(default)]
    all: bool,
}

/// `tusk/extractTargets`: the expressions that can become a `kind` at a range, innermost first, each with its
/// occurrences, and whether a selection was widened to a whole expression. An error says why there are none.
pub fn targets_request(snap: &Snapshot, params: Value) -> Result<Value, String> {
    let p: Params = serde_json::from_value(params).map_err(|e| e.to_string())?;
    with_ctx(snap, &p.text_document.uri, |ctx| {
        let (found, snapped) = targets(ctx, p.range, p.kind)?;
        let list: Vec<Value> = found
            .iter()
            .map(|t| {
                let occurrences: Vec<Range> = occurrences(ctx, t, p.kind).into_iter().map(|(s, e)| ctx.doc.range(s, e)).collect();
                json!({ "range": ctx.doc.range(t.span.0, t.span.1), "text": &ctx.doc.text[t.span.0 as usize..t.span.1 as usize], "occurrences": occurrences })
            })
            .collect();
        Ok(json!({ "targets": list, "snapped": snapped }))
    })
    .unwrap_or_else(|| Err("The file is too complex to refactor, or isn't open.".into()))
}

/// `tusk/extract`: the edit that extracts the expression at exactly `range` and, with `all`, its occurrences.
/// Each place the name goes holds `\0`; `name` is the suggestion. For a parameter there's no edit: the editor
/// adds it through Change Signature with the `name`, `type`, and whether the value is `constant`.
pub fn extract_request(snap: &Snapshot, params: Value) -> Result<Value, String> {
    let p: Params = serde_json::from_value(params).map_err(|e| e.to_string())?;
    let x = run(snap, &p.text_document.uri, p.range, p.kind, p.all)?;
    Ok(json!({ "edits": x.edits, "name": x.name, "type": x.r#type, "constant": x.constant }))
}

fn run(snap: &Snapshot, uri: &Uri, range: Range, kind: Kind, all: bool) -> Result<Extraction, String> {
    with_ctx(snap, uri, |ctx| {
        let (found, _) = targets(ctx, range, kind)?;
        let t = found.into_iter().next().ok_or("There's nothing to extract.")?;
        let uses = if all { occurrences(ctx, &t, kind) } else { vec![t.span] };
        extraction(ctx, &t, &uses, kind)
    })
    .unwrap_or_else(|| Err("The file is too complex to refactor, or isn't open.".into()))
}

// ---- Code actions, for other editors ----

/// Each action's kind, title, code action kind, and id.
const ACTIONS: [(Kind, &str, &str, &str); 3] = [
    (Kind::Variable, "Extract variable", "refactor.extract.variable", "extract.variable"),
    (Kind::Constant, "Extract constant", "refactor.extract.constant", "extract.constant"),
    (Kind::Field, "Introduce field", "refactor.extract.field", "extract.field"),
];

/// On a selection, the extractions that apply to it, replacing every occurrence with the suggested name.
pub fn candidates(ctx: &Ctx<'_>, range: Range) -> Vec<Candidate> {
    if range.start == range.end {
        return vec![];
    }
    ACTIONS
        .iter()
        .filter(|(kind, ..)| targets(ctx, range, *kind).is_ok())
        .map(|(_, title, code_kind, id)| Candidate::new(*title, code_kind, id, Value::Null))
        .collect()
}

pub fn resolve(ctx: &Ctx<'_>, action: &str, range: Range) -> Option<WorkspaceEdit> {
    let kind = ACTIONS.iter().find(|(.., id)| id.strip_prefix("extract.") == Some(action))?.0;
    let (found, _) = targets(ctx, range, kind).ok()?;
    let t = found.into_iter().next()?;
    let uses = occurrences(ctx, &t, kind);
    let x = extraction(ctx, &t, &uses, kind).ok()?;
    let edits = x.edits.into_iter().map(|e| TextEdit { new_text: e.new_text.replace(NAME, &x.name), ..e }).collect();
    file_edit(ctx, edits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Fixture, uri};

    /// Runs `kind` at the `«selection»` or `<|>` caret in `test.php`, picking the first target, with every
    /// occurrence when `all`, and returns the text with the name filled in, or the refusal.
    fn apply(text: &str, kind: Kind, all: bool) -> Result<String, String> {
        let mut t = text.replace("<|>", "«»");
        let a = t.find('«').expect("a «selection» or <|>");
        t = t.replacen('«', "", 1);
        let b = t.find('»').unwrap();
        t = t.replacen('»', "", 1);
        let fx = Fixture::one(&t);
        let doc = fx.doc("test.php");
        let range = Range { start: doc.position(a as u32), end: doc.position(b as u32) };
        let x = run(&fx.snap, &uri("test.php"), range, kind, all)?;
        let mut edits = x.edits;
        edits.sort_by_key(|e| std::cmp::Reverse((doc.offset(e.range.start), doc.offset(e.range.end))));
        let mut out = doc.text.clone();
        for e in edits {
            out.replace_range(doc.offset(e.range.start) as usize..doc.offset(e.range.end) as usize, &e.new_text.replace(NAME, &x.name));
        }
        Ok(out)
    }

    fn offered(text: &str, kind: Kind) -> Result<Vec<String>, String> {
        let at = text.find("<|>").unwrap();
        let fx = Fixture::one(&text.replace("<|>", ""));
        let doc = fx.doc("test.php");
        let range = Range { start: doc.position(at as u32), end: doc.position(at as u32) };
        let v = targets_request(&fx.snap, json!({ "textDocument": { "uri": uri("test.php") }, "range": range, "kind": kind }))?;
        Ok(v["targets"].as_array().unwrap().iter().map(|t| t["text"].as_str().unwrap().to_string()).collect())
    }

    fn method(body: &str) -> String {
        format!("<?php\nclass A\n{{\n    public function run(array $items, int $n): mixed\n    {{\n{body}\n    }}\n}}\n")
    }

    #[test]
    fn offers_the_expressions_around_the_caret_innermost_first() {
        let found = offered(&method("        return $this->f(count($it<|>ems) * 2);"), Kind::Variable).unwrap();
        assert_eq!(found, ["count($items)", "count($items) * 2", "$this->f(count($items) * 2)"]);
    }

    #[test]
    fn offers_whole_ternaries_matches_and_heredocs() {
        let found = offered(&method("        return $n > 1 ? 'm<|>any' : 'one';"), Kind::Variable).unwrap();
        assert!(found.contains(&"$n > 1 ? 'many' : 'one'".to_string()), "{found:?}");
        let found = offered(&method("        return match ($n) { 1 => 'o<|>ne', default => 'many' };"), Kind::Variable).unwrap();
        assert_eq!(found.last().unwrap(), "match ($n) { 1 => 'one', default => 'many' }");
        let heredoc = "        $s = <<<TXT\n            Hello {$this->na<|>me()}\n            TXT;\n        return $s;";
        let found = offered(&method(heredoc), Kind::Variable).unwrap();
        assert_eq!(found[0], "$this->name()");
        assert!(found[1].starts_with("<<<TXT"), "{found:?}");
    }

    #[test]
    fn extracts_a_variable_before_the_statement() {
        let out = apply(&method("        $x = «count($items) * 2» + 1;\n        return $x;"), Kind::Variable, false).unwrap();
        assert!(out.contains("        $value = count($items) * 2;\n        $x = $value + 1;"), "{out}");
    }

    #[test]
    fn replaces_every_occurrence_in_the_same_scope_only() {
        let body = "        $a = «count($items)»;\n        $b = count( $items ) + 1;\n        $f = function () use ($items) { return count($items); };\n        return [$a, $b, $f];";
        let out = apply(&method(body), Kind::Variable, true).unwrap();
        assert!(out.contains("        $count = count($items);\n        $a = $count;\n        $b = $count + 1;"), "{out}");
        assert!(out.contains("{ return count($items); }"), "{out}");
    }

    #[test]
    fn a_statement_of_the_expression_alone_becomes_the_assignment() {
        let out = apply(&method("        «$this->load($n)»;\n        return null;"), Kind::Variable, false).unwrap();
        assert!(out.contains("        $load = $this->load($n);\n        return null;"), "{out}");
    }

    #[test]
    fn names_follow_the_expression() {
        let name = |code: &str| {
            let out = apply(&method(&format!("        return «{code}»;")), Kind::Variable, false).unwrap();
            out.lines().find(|l| l.contains(" = ")).unwrap().trim().split(' ').next().unwrap().to_string()
        };
        assert_eq!(name("$this->getEmail()"), "$email");
        assert_eq!(name("$items['unit_price']"), "$unitPrice");
        assert_eq!(name("new \\ArrayObject()"), "$arrayObject");
        assert_eq!(name("$n + 1"), "$value");
        assert_eq!(name("'unit price'"), "$unitPrice");
        assert_eq!(name("'Hello, world!'"), "$string");
        // Not a name the method already uses.
        assert_eq!(name("count($items)"), "$count");
        let out = apply(&method("        $count = 1;\n        return «count($items)»;"), Kind::Variable, false).unwrap();
        assert!(out.contains("$count2 = count($items);"), "{out}");
    }

    #[test]
    fn interpolated_uses_get_braces() {
        let out = apply(&method("        return \"Hi «$this->name» and $this->name\";"), Kind::Variable, true).unwrap();
        assert!(out.contains("$name = $this->name;\n        return \"Hi {$name} and {$name}\";"), "{out}");
    }

    #[test]
    fn low_precedence_operators_keep_parentheses_and_others_lose_them() {
        let out = apply(&method("        return «($n and $items)»;"), Kind::Variable, false).unwrap();
        assert!(out.contains("$value = ($n and $items);\n        return $value;"), "{out}");
        let out = apply(&method("        return 2 * «($n + 1)»;"), Kind::Variable, false).unwrap();
        assert!(out.contains("$value = $n + 1;\n        return 2 * $value;"), "{out}");
    }

    #[test]
    fn widens_a_partial_selection_and_refuses_targets() {
        let fx_text = method("        return $this->f(co«unt($ite»ms));");
        let out = apply(&fx_text, Kind::Variable, false).unwrap();
        assert!(out.contains("$count = count($items);"), "{out}");
        assert!(apply(&method("        «$n» = 2;\n        return $n;"), Kind::Variable, false).is_err());
        assert!(apply(&method("        $items[«$n»] = 1;\n        return 1;"), Kind::Variable, false).is_err());
        let err = apply(&method("        return array_map(fn($i) => «$i * 2», $items);"), Kind::Variable, false).unwrap_err();
        assert!(err.contains("arrow function"), "{err}");
        // Not using the arrow function's parameters, it goes before the statement.
        let out = apply(&method("        return array_map(fn($i) => $i * «$n», $items);"), Kind::Variable, false);
        assert!(out.is_err(), "a bare variable isn't offered");
        let out = apply(&method("        return array_map(fn($i) => $i * «($n + 1)», $items);"), Kind::Variable, false).unwrap();
        assert!(out.contains("$value = $n + 1;\n        return array_map(fn($i) => $i * $value, $items);"), "{out}");
    }

    #[test]
    fn places_the_declaration_in_the_innermost_list_of_statements() {
        // On a line with code before it, the declaration stays on that line.
        let out = apply(&method("        if ($n) { return «$n + 1»; }\n        return 0;"), Kind::Variable, false).unwrap();
        assert!(out.contains("        if ($n) { $value = $n + 1; return $value; }"), "{out}");
        let out = apply(&method("        switch ($n) {\n            case 1:\n                return «$n * 3»;\n        }\n        return 0;"), Kind::Variable, false).unwrap();
        assert!(out.contains("            case 1:\n                $value = $n * 3;\n                return $value;"), "{out}");
        // Uses in two branches: before the statement that holds both.
        let out = apply(&method("        if ($n) {\n            echo «$n * 3»;\n        } else {\n            echo $n * 3;\n        }\n        return 0;"), Kind::Variable, true).unwrap();
        assert!(out.contains("        $value = $n * 3;\n        if ($n) {\n            echo $value;\n        } else {\n            echo $value;\n        }"), "{out}");
        let out = apply("<?php\n$n = 2;\necho «$n * 3»;\n", Kind::Variable, false).unwrap();
        assert_eq!(out, "<?php\n$n = 2;\n$value = $n * 3;\necho $value;\n");
    }

    #[test]
    fn moves_a_heredoc_whole() {
        let body = "        return strtoupper(«<<<TXT\n            Hello $n\n            TXT»);";
        let out = apply(&method(body), Kind::Variable, false).unwrap();
        assert!(out.contains("        $string = <<<TXT\n            Hello $n\n            TXT;\n        return strtoupper($string);"), "{out}");
    }

    #[test]
    fn extracts_inside_a_closure_body() {
        let out = apply(&method("        return function () use ($n) {\n            return «$n * 2»;\n        };"), Kind::Variable, false).unwrap();
        assert!(out.contains("        return function () use ($n) {\n            $value = $n * 2;\n            return $value;\n        };"), "{out}");
    }

    #[test]
    fn extracts_constants_after_the_last_one() {
        let text = "<?php\nclass A\n{\n    use T;\n\n    public function f(): string\n    {\n        return «'pending review'» . 'pending review';\n    }\n}\n";
        let out = apply(text, Kind::Constant, true).unwrap();
        assert_eq!(out, "<?php\nclass A\n{\n    use T;\n\n    private const PENDING_REVIEW = 'pending review';\n\n    public function f(): string\n    {\n        return self::PENDING_REVIEW . self::PENDING_REVIEW;\n    }\n}\n");
        let text = "<?php\ninterface I\n{\n    const A = 1;\n    public function f($x = «10»);\n}\n";
        let out = apply(text, Kind::Constant, false).unwrap();
        assert!(out.contains("    const A = 1;\n    public const VALUE = 10;\n    public function f($x = self::VALUE);"), "{out}");
        let text = "<?php\nfunction f() { return «'x'»; }\n";
        assert!(apply(text, Kind::Constant, false).unwrap_err().contains("inside a class"));
        let text = "<?php\nclass A { function f($n) { return «$n + 1»; } }\n";
        assert!(apply(text, Kind::Constant, false).is_err());
    }

    #[test]
    fn introduces_fields() {
        let text = "<?php\nclass A\n{\n    private int $a = 1;\n\n    public function f(): int\n    {\n        return «strlen('abc')» + 1;\n    }\n}\n";
        let out = apply(text, Kind::Field, false).unwrap();
        assert!(out.contains("    private int $a = 1;\n    private int $strlen;\n"), "{out}");
        assert!(out.contains("        $this->strlen = strlen('abc');\n        return $this->strlen + 1;"), "{out}");
        // A constant value becomes the default.
        let text = "<?php\nclass A\n{\n    public static function f(): int\n    {\n        return «42»;\n    }\n}\n";
        let out = apply(text, Kind::Field, false).unwrap();
        assert!(out.contains("{\n    private static int $value = 42;\n\n    public static function f"), "{out}");
        assert!(out.contains("return self::$value;"), "{out}");
        let text = "<?php\nenum E { case A; public function f() { return «1 + 1»; } }\n";
        assert!(apply(text, Kind::Field, false).unwrap_err().contains("enum"));
    }

    #[test]
    fn checks_parameters() {
        let text = "<?php\nclass A { public function f(int $n) { return «$n + 1»; } }\n";
        assert!(apply(text, Kind::Parameter, false).unwrap_err().contains("variables"));
        // At a bare variable, the reason comes from the expression around it.
        let err = offered("<?php\nclass A { public function f(int $n) { return $<|>n + 1; } }\n", Kind::Parameter).unwrap_err();
        assert!(err.contains("variables"), "{err}");
        let text = "<?php\nclass A { public function f() { return function () { return «1 + 1»; }; } }\n";
        assert!(apply(text, Kind::Parameter, false).unwrap_err().contains("closure"));
        let fx = Fixture::one("<?php\nclass A { public function f() { return strlen('abc') * 2; } }\n");
        let doc = fx.doc("test.php");
        let s = doc.text.find("strlen").unwrap() as u32;
        let range = Range { start: doc.position(s), end: doc.position(s + 13) };
        let v = extract_request(&fx.snap, json!({ "textDocument": { "uri": uri("test.php") }, "range": range, "kind": "parameter" })).unwrap();
        assert_eq!(v["name"], "strlen");
        assert_eq!(v["type"], "int");
        assert_eq!(v["constant"], false);
    }

    #[test]
    fn lists_code_actions_on_a_selection_with_every_occurrence() {
        let text = "<?php\nclass A { public function f() { return 'x' . 'x'; } }\n";
        let fx = Fixture::one(text);
        let doc = fx.doc("test.php");
        let s = text.find("'x'").unwrap() as u32;
        let range = Range { start: doc.position(s), end: doc.position(s + 3) };
        let kinds: Vec<String> = with_ctx(&fx.snap, &uri("test.php"), |ctx| candidates(ctx, range)).unwrap().into_iter().map(|c| c.kind.as_str().to_string()).collect();
        assert_eq!(kinds, ["refactor.extract.variable", "refactor.extract.constant", "refactor.extract.field"]);
        let edit = with_ctx(&fx.snap, &uri("test.php"), |ctx| resolve(ctx, "constant", range)).flatten().unwrap();
        let text = serde_json::to_string(&edit).unwrap();
        assert_eq!(text.matches("self::X").count(), 2, "{text}");
    }
}
