//! `tusk/phpOutline`: the classes in a PHP text, with their members and the expressions a visual code designer
//! reads and edits, as a tree of nodes with UTF-16 ranges. It parses and resolves names only, without the index.

use std::path::Path;

use mago_allocator::LocalArena;
use mago_span::{HasSpan, Span};
use mago_syntax::cst::*;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::analysis::Parsed;

#[derive(Deserialize)]
struct Params {
    text: String,
    path: Option<String>,
}

pub fn php_outline(_: &crate::server::Snapshot, params: Value) -> Result<Value, String> {
    outline(params)
}

/// The outline of a PHP text, as `tusk/phpOutline` answers. `examples/outline.rs` prints it for the editor's tests.
pub fn outline_of(text: &str) -> Value {
    outline(json!({ "text": text })).unwrap_or(Value::Null)
}

fn outline(params: Value) -> Result<Value, String> {
    let p: Params = serde_json::from_value(params).map_err(|e| e.to_string())?;
    let arena = LocalArena::new();
    let parsed = Parsed::new(&arena, Path::new(p.path.as_deref().unwrap_or("outline.php")), &p.text);
    // A file with brackets left open at its end parses balanced, without errors.
    let errors = !parsed.program.errors.is_empty() || parsed.file.contents.len() != p.text.len();
    if crate::analysis::too_complex(parsed.program) {
        return Ok(json!({ "errors": true, "namespace": null, "uses": [], "useInsert": 0, "classes": [] }));
    }
    let o = Outliner::new(&parsed, &p.text);
    Ok(o.run(errors))
}

struct Outliner<'p, 'a> {
    parsed: &'p Parsed<'a>,
    /// The parsed text, which may run past the request's text with closing brackets.
    text: &'p str,
    /// The UTF-16 offset of each byte offset of the request's text, and one past its end.
    utf16: Vec<u32>,
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

impl<'p, 'a> Outliner<'p, 'a> {
    fn new(parsed: &'p Parsed<'a>, original: &str) -> Self {
        let mut utf16 = Vec::with_capacity(original.len() + 1);
        let mut units = 0u32;
        for c in original.chars() {
            utf16.extend(std::iter::repeat_n(units, c.len_utf8()));
            units += c.len_utf16() as u32;
        }
        utf16.push(units);
        Self { parsed, text: parsed.text(), utf16 }
    }

    fn at(&self, byte: u32) -> u32 {
        self.utf16.get(byte as usize).or(self.utf16.last()).copied().unwrap_or(0)
    }

    fn span(&self, s: Span) -> Value {
        json!([self.at(s.start.offset), self.at(s.end.offset)])
    }

    fn range(&self, start: u32, end: u32) -> Value {
        json!([self.at(start), self.at(end)])
    }

    fn src(&self, s: Span) -> &str {
        self.text.get(s.start.offset as usize..s.end.offset as usize).unwrap_or("")
    }

    /// A class name, fully qualified without a leading backslash.
    fn resolved(&self, id: &Identifier<'_>) -> String {
        let name = self.parsed.names.resolve(&id.span()).map(lossy).unwrap_or_else(|| lossy(id.value()));
        name.trim_start_matches('\\').to_string()
    }

    /// A function or constant name: as written when unqualified and not imported, since PHP falls back to the
    /// global one; resolved otherwise.
    fn function_name(&self, id: &Identifier<'_>) -> String {
        match id {
            Identifier::Local(l) if !self.parsed.names.is_imported(&l.span) => lossy(l.value),
            _ => self.resolved(id),
        }
    }

    fn line_after(&self, byte: u32) -> u32 {
        let from = (byte as usize).min(self.text.len());
        let end = self.text[from..].find('\n').map_or(self.text.len(), |i| from + i + 1);
        self.at(end as u32)
    }

    fn run(&self, errors: bool) -> Value {
        let mut namespace = None;
        let mut uses = vec![];
        let mut use_insert = None;
        let mut fallback = 0;
        let mut statements: Vec<&Statement<'_>> = self.parsed.program.statements.iter().collect();
        let mut i = 0;
        while i < statements.len() {
            match statements[i] {
                Statement::OpeningTag(t) if fallback == 0 => fallback = self.line_after(t.span().end.offset),
                Statement::Declare(d) => fallback = self.line_after(d.span().end.offset),
                Statement::Namespace(n) => {
                    if namespace.is_none() {
                        namespace = n.name.as_ref().map(|id| lossy(id.value()).trim_start_matches('\\').to_string());
                    }
                    match &n.body {
                        NamespaceBody::Implicit(b) => {
                            fallback = self.line_after(b.terminator.span().end.offset);
                            statements.splice(i + 1..i + 1, b.statements.iter());
                        }
                        NamespaceBody::BraceDelimited(b) => {
                            fallback = self.line_after(b.left_brace.end.offset);
                            statements.splice(i + 1..i + 1, b.statements.iter());
                        }
                    }
                }
                Statement::Use(u) if self.use_entries(u, &mut uses) => use_insert = Some(self.line_after(u.span().end.offset)),
                _ => {}
            }
            i += 1;
        }

        let mut found = vec![];
        let mut stack = vec![Node::Program(self.parsed.program)];
        while let Some(node) = stack.pop() {
            if matches!(node, Node::Class(_) | Node::Interface(_) | Node::Trait(_) | Node::Enum(_) | Node::AnonymousClass(_)) {
                found.push(node);
            }
            node.visit_children(|child| stack.push(child));
        }
        found.sort_by_key(|n| n.span().start.offset);
        let classes: Vec<Value> = found.into_iter().filter_map(|n| self.class(n)).collect();

        // A file's own statements, such as routes/console.php's, and what it returns, as bootstrap/app.php does.
        let returns: Vec<Value> = statements
            .iter()
            .filter_map(|s| match s {
                Statement::Return(r) => r.value.map(|e| self.node(e)),
                _ => None,
            })
            .collect();
        json!({
            "errors": errors,
            "namespace": namespace,
            "uses": uses,
            "useInsert": use_insert.unwrap_or(fallback),
            "classes": classes,
            "statements": self.statements(statements.iter().copied()),
            "returns": returns,
        })
    }

    /// Adds the names a `use` statement imports; true if it imports a class.
    fn use_entries(&self, u: &Use<'_>, out: &mut Vec<Value>) -> bool {
        let span = self.span(u.span());
        let kind_of = |t: Option<&UseType<'_>>| match t {
            Some(UseType::Function(_)) => "function",
            Some(UseType::Const(_)) => "const",
            None => "class",
        };
        let mut classes = false;
        let mut add = |prefix: Option<&Identifier<'_>>, item: &UseItem<'_>, kind: &'static str| {
            let written = lossy(item.name.value());
            let name = match prefix {
                Some(p) => format!("{}\\{}", lossy(p.value()).trim_matches('\\'), written.trim_start_matches('\\')),
                None => written.trim_start_matches('\\').to_string(),
            };
            let alias = match &item.alias {
                Some(a) => lossy(a.identifier.value),
                None => name.rsplit('\\').next().unwrap_or("").to_string(),
            };
            classes |= kind == "class";
            out.push(json!({ "alias": alias, "name": name, "kind": kind, "span": span }));
        };
        match &u.items {
            UseItems::Sequence(s) => s.items.iter().for_each(|i| add(None, i, "class")),
            UseItems::TypedSequence(s) => s.items.iter().for_each(|i| add(None, i, kind_of(Some(&s.r#type)))),
            UseItems::TypedList(l) => l.items.iter().for_each(|i| add(Some(&l.namespace), i, kind_of(Some(&l.r#type)))),
            UseItems::MixedList(l) => l.items.iter().for_each(|i| add(Some(&l.namespace), &i.item, kind_of(i.r#type.as_ref()))),
        }
        classes
    }

    fn class(&self, node: Node<'_, '_>) -> Option<Value> {
        let none: &[Modifier<'_>] = &[];
        let (kind, name, attributes, modifiers, extends, implements, left, members, right) = match node {
            Node::Class(c) => ("class", Some(&c.name), &c.attribute_lists, c.modifiers.nodes, c.extends.as_ref(), c.implements.as_ref(), c.left_brace, &c.members, c.right_brace),
            Node::Interface(c) => ("interface", Some(&c.name), &c.attribute_lists, none, c.extends.as_ref(), None, c.left_brace, &c.members, c.right_brace),
            Node::Trait(c) => ("trait", Some(&c.name), &c.attribute_lists, none, None, None, c.left_brace, &c.members, c.right_brace),
            Node::Enum(c) => ("enum", Some(&c.name), &c.attribute_lists, none, None, c.implements.as_ref(), c.left_brace, &c.members, c.right_brace),
            Node::AnonymousClass(c) => ("class", None, &c.attribute_lists, c.modifiers.nodes, c.extends.as_ref(), c.implements.as_ref(), c.left_brace, &c.members, c.right_brace),
            _ => return None,
        };
        let (name, fqn) = match name {
            Some(n) => {
                let fqn = self.parsed.names.resolve(&n.span).map(lossy).unwrap_or_else(|| lossy(n.value));
                (lossy(n.value), fqn.trim_start_matches('\\').to_string())
            }
            None => (String::new(), String::new()),
        };
        let mut o = json!({
            "kind": kind,
            "name": name,
            "fqn": fqn,
            "abstract": modifiers.iter().any(|m| matches!(m, Modifier::Abstract(_))),
            "final": modifiers.iter().any(|m| matches!(m, Modifier::Final(_))),
            "extends": extends.and_then(|e| e.types.iter().next()).map(|id| self.resolved(id)),
            "implements": implements.map(|i| i.types.iter().map(|id| self.resolved(id)).collect::<Vec<_>>()).unwrap_or_default(),
            "attributes": self.attributes(attributes),
            "span": self.span(node.span()),
            "bodyStart": self.at(left.end.offset),
            "bodyEnd": self.at(right.start.offset),
        });
        let (mut traits, mut constants, mut cases, mut properties, mut methods) = (vec![], vec![], vec![], vec![], vec![]);
        for member in members.iter() {
            match member {
                ClassLikeMember::TraitUse(t) => traits.extend(t.trait_names.iter().map(|id| self.resolved(id))),
                ClassLikeMember::Constant(c) => {
                    let span = self.span(c.span());
                    constants.extend(c.items.iter().map(|i| json!({ "name": lossy(i.name.value), "value": self.node(i.value), "span": span })));
                }
                ClassLikeMember::EnumCase(c) => {
                    let (name, value) = match &c.item {
                        EnumCaseItem::Unit(u) => (&u.name, Value::Null),
                        EnumCaseItem::Backed(b) => (&b.name, self.node(b.value)),
                    };
                    cases.push(json!({ "name": lossy(name.value), "value": value, "span": self.span(c.span()) }));
                }
                ClassLikeMember::Property(p) => properties.extend(self.properties(p)),
                ClassLikeMember::Method(m) => methods.push(self.method(m)),
            }
        }
        let map = o.as_object_mut()?;
        map.insert("traits".into(), json!(traits));
        map.insert("constants".into(), json!(constants));
        map.insert("cases".into(), json!(cases));
        map.insert("properties".into(), json!(properties));
        map.insert("methods".into(), json!(methods));
        Some(o)
    }

    fn visibility(modifiers: &Sequence<'_, Modifier<'_>>) -> &'static str {
        for m in modifiers.iter() {
            match m {
                Modifier::Protected(_) => return "protected",
                Modifier::Private(_) => return "private",
                Modifier::Public(_) => return "public",
                _ => {}
            }
        }
        "public"
    }

    fn properties(&self, p: &Property<'_>) -> Vec<Value> {
        let (attributes, modifiers, hint, items): (_, _, _, Vec<&PropertyItem<'_>>) = match p {
            Property::Plain(p) => (&p.attribute_lists, &p.modifiers, p.hint.as_ref(), p.items.iter().collect()),
            Property::Hooked(p) => (&p.attribute_lists, &p.modifiers, p.hint.as_ref(), vec![&p.item]),
        };
        let span = self.span(p.span());
        let attributes = self.attributes(attributes);
        items
            .into_iter()
            .map(|item| {
                let (variable, value) = match item {
                    PropertyItem::Abstract(a) => (&a.variable, Value::Null),
                    PropertyItem::Concrete(c) => (&c.variable, self.node(c.value)),
                };
                json!({
                    "name": var_name(variable),
                    "static": modifiers.iter().any(|m| matches!(m, Modifier::Static(_))),
                    "visibility": Self::visibility(modifiers),
                    "readonly": modifiers.iter().any(|m| matches!(m, Modifier::Readonly(_))),
                    "type": hint.map(|h| self.src(h.span())),
                    "value": value,
                    "span": span,
                    "attributes": attributes,
                })
            })
            .collect()
    }

    fn method(&self, m: &Method<'_>) -> Value {
        let span = m.span();
        let (body, returns, statements, body_statements) = match &m.body {
            MethodBody::Abstract(_) => (Value::Null, vec![], vec![], vec![]),
            MethodBody::Concrete(b) => {
                let mut found = vec![];
                let mut stack = vec![Node::Block(b)];
                while let Some(node) = stack.pop() {
                    match node {
                        Node::Closure(_) | Node::ArrowFunction(_) | Node::AnonymousClass(_) | Node::Function(_) | Node::Class(_) | Node::Interface(_) | Node::Trait(_) | Node::Enum(_) => continue,
                        Node::Return(r) => found.extend(r.value),
                        _ => {}
                    }
                    node.visit_children(|child| stack.push(child));
                }
                found.sort_by_key(|e| e.span().start.offset);
                // The body's own expression statements, such as `$panel->login();` or `$panel = $panel->…;`.
                let statements = self.statements(b.statements.iter());
                // Every top-level statement's span; an `if` with a braced block and no `else` also gives its
                // condition and its block's statements, as the automations designer writes rules.
                let body_statements = b.statements.iter().map(|s| self.body_statement(s)).collect();
                (self.range(b.left_brace.end.offset, b.right_brace.start.offset), found.into_iter().map(|e| self.node(e)).collect(), statements, body_statements)
            }
        };
        let params: Vec<Value> = m
            .parameter_list
            .parameters
            .iter()
            .map(|p| {
                json!({
                    "name": var_name(&p.variable),
                    "type": p.hint.as_ref().map(|h| self.src(h.span())),
                    "default": p.default_value.as_ref().map(|d| self.node(d.value)),
                    "span": self.span(p.span()),
                })
            })
            .collect();
        json!({
            "name": lossy(m.name.value),
            "static": m.modifiers.iter().any(|m| matches!(m, Modifier::Static(_))),
            "abstract": m.modifiers.iter().any(|m| matches!(m, Modifier::Abstract(_))),
            "visibility": Self::visibility(&m.modifiers),
            "params": params,
            "returnType": m.return_type_hint.as_ref().map(|r| self.src(r.hint.span())),
            "attributes": self.attributes(&m.attribute_lists),
            "span": self.span(span),
            "docStart": self.doc_start(span.start.offset),
            "body": body,
            "returns": returns,
            "statements": statements,
            "bodyStatements": body_statements,
        })
    }

    fn body_statement(&self, s: &Statement<'_>) -> Value {
        let span = self.span(s.span());
        match s {
            Statement::Expression(_) => json!({ "kind": "expression", "span": span }),
            Statement::If(i) => match &i.body {
                IfBody::Statement(b) if b.else_if_clauses.is_empty() && b.else_clause.is_none() => match b.statement {
                    Statement::Block(block) => json!({
                        "kind": "if",
                        "span": span,
                        "condition": self.span(i.condition.span()),
                        "then": block.statements.iter().map(|s| self.span(s.span())).collect::<Vec<_>>(),
                        "open": self.at(block.left_brace.end.offset),
                        "close": self.at(block.right_brace.start.offset),
                    }),
                    _ => json!({ "kind": "other", "span": span }),
                },
                _ => json!({ "kind": "other", "span": span }),
            },
            _ => json!({ "kind": "other", "span": span }),
        }
    }

    /// Expression statements, each with the variable it assigns, if any.
    fn statements<'s>(&self, list: impl Iterator<Item = &'s Statement<'s>>) -> Vec<Value>
    where
        'a: 's,
    {
        list.filter_map(|s| match s {
            Statement::Expression(es) => Some(match es.expression {
                Expression::Assignment(a) if matches!(a.operator, AssignmentOperator::Assign(_)) => match a.lhs {
                    Expression::Variable(Variable::Direct(v)) => json!({ "assigns": var_name(v), "value": self.node(a.rhs) }),
                    _ => json!({ "assigns": null, "value": self.node(es.expression) }),
                },
                e => json!({ "assigns": null, "value": self.node(e) }),
            }),
            _ => None,
        })
        .collect()
    }

    /// The start of the docblock directly above `offset`, with only whitespace between.
    fn doc_start(&self, offset: u32) -> Option<u32> {
        let trivia = self.parsed.program.trivia.nodes;
        let before = trivia.partition_point(|t| t.span.start.offset < offset);
        for t in trivia[..before].iter().rev() {
            match t.kind {
                TriviaKind::WhiteSpace => continue,
                TriviaKind::DocBlockComment => return Some(self.at(t.span.start.offset)),
                _ => return None,
            }
        }
        None
    }

    fn attributes(&self, lists: &Sequence<'_, AttributeList<'_>>) -> Vec<Value> {
        lists
            .iter()
            .flat_map(|list| {
                list.attributes.iter().map(move |a| {
                    json!({
                        "name": self.resolved(&a.name),
                        "args": a.argument_list.as_ref().map(|l| self.partial_args(l)),
                        "span": self.span(a.span()),
                        "list": self.span(list.span()),
                    })
                })
            })
            .collect()
    }

    fn args(&self, list: &ArgumentList<'_>) -> Value {
        let items: Vec<Value> = list
            .arguments
            .iter()
            .map(|a| match a {
                Argument::Positional(p) => self.arg(a.span(), None, p.value, p.ellipsis.is_some()),
                Argument::Named(n) => self.arg(a.span(), Some(lossy(n.name.value)), n.value, false),
            })
            .collect();
        json!({ "open": self.at(list.left_parenthesis.start.offset), "close": self.at(list.right_parenthesis.start.offset), "items": items })
    }

    fn partial_args(&self, list: &PartialArgumentList<'_>) -> Value {
        let items: Vec<Value> = list
            .arguments
            .iter()
            .filter_map(|a| match a {
                PartialArgument::Positional(p) => Some(self.arg(a.span(), None, p.value, p.ellipsis.is_some())),
                PartialArgument::Named(n) => Some(self.arg(a.span(), Some(lossy(n.name.value)), n.value, false)),
                _ => None,
            })
            .collect();
        json!({ "open": self.at(list.left_parenthesis.start.offset), "close": self.at(list.right_parenthesis.start.offset), "items": items })
    }

    fn arg(&self, span: Span, name: Option<String>, value: &Expression<'_>, spread: bool) -> Value {
        json!({ "name": name, "value": self.node(value), "span": self.span(span), "spread": spread })
    }

    fn selector_name(s: &ClassLikeMemberSelector<'_>) -> String {
        match s {
            ClassLikeMemberSelector::Identifier(id) => lossy(id.value),
            _ => String::new(),
        }
    }

    fn class_ref(&self, e: &Expression<'_>) -> Option<String> {
        match e {
            Expression::Identifier(id) => Some(self.resolved(id)),
            Expression::Self_(k) | Expression::Static(k) | Expression::Parent(k) => Some(lossy(k.value)),
            _ => None,
        }
    }

    fn string(&self, value: String, quote: &str, interpolated: bool) -> Value {
        json!({ "kind": "string", "value": value, "quote": quote, "interpolated": interpolated })
    }

    /// The node for an expression, with its span.
    fn node(&self, mut e: &Expression<'_>) -> Value {
        while let Expression::Parenthesized(p) = e {
            e = p.expression;
        }
        let mut v = self.node_kind(e);
        if let Some(map) = v.as_object_mut() {
            map.insert("span".into(), self.span(e.span()));
        }
        v
    }

    fn node_kind(&self, e: &Expression<'_>) -> Value {
        let other = json!({ "kind": "other" });
        match e {
            Expression::Literal(l) => match l {
                Literal::String(s) => {
                    let quote = if matches!(s.kind, LiteralStringKind::SingleQuoted) { "single" } else { "double" };
                    let raw = self.src(s.span);
                    let value = s.value.map(lossy).unwrap_or_else(|| raw.get(1..raw.len().saturating_sub(1)).unwrap_or("").to_string());
                    self.string(value, quote, false)
                }
                Literal::Integer(i) => json!({ "kind": "number", "value": i.value.map_or(f64::NAN, |v| v as f64), "raw": self.src(i.span) }),
                Literal::Float(f) => json!({ "kind": "number", "value": f.value.0, "raw": self.src(f.span) }),
                Literal::True(_) => json!({ "kind": "bool", "value": true }),
                Literal::False(_) => json!({ "kind": "bool", "value": false }),
                Literal::Null(_) => json!({ "kind": "null" }),
            },
            Expression::UnaryPrefix(u) if matches!(u.operator, UnaryPrefixOperator::Negation(_)) => {
                let value = match u.operand {
                    Expression::Literal(Literal::Integer(i)) => i.value.map(|v| -(v as f64)),
                    Expression::Literal(Literal::Float(f)) => Some(-f.value.0),
                    _ => None,
                };
                match value {
                    Some(value) => json!({ "kind": "number", "value": value, "raw": self.src(e.span()) }),
                    None => other,
                }
            }
            Expression::CompositeString(CompositeString::Interpolated(s)) => {
                let inner = self.src(Span::between(s.left_double_quote, s.right_double_quote));
                self.string(inner.get(1..inner.len().saturating_sub(1)).unwrap_or("").to_string(), "double", true)
            }
            Expression::CompositeString(CompositeString::Document(d)) => {
                let quote = if matches!(d.kind, DocumentKind::Heredoc) { "heredoc" } else { "nowdoc" };
                let mut value = String::new();
                let mut interpolated = false;
                for part in d.parts.iter() {
                    match part {
                        StringPart::Literal(l) => value.push_str(&lossy(l.value.unwrap_or(l.raw))),
                        _ => {
                            interpolated = true;
                            value.push_str(self.src(part.span()));
                        }
                    }
                }
                self.string(value, quote, interpolated)
            }
            Expression::Array(a) => self.array(a.left_bracket.start.offset, &a.elements, a.right_bracket.start.offset, false),
            Expression::LegacyArray(a) => self.array(a.array.span.start.offset, &a.elements, a.right_parenthesis.start.offset, true),
            Expression::Call(Call::StaticMethod(c)) => match self.class_ref(c.class) {
                Some(class) => json!({
                    "kind": "static",
                    "class": class,
                    "classSpan": self.span(c.class.span()),
                    "method": Self::selector_name(&c.method),
                    "args": self.args(&c.argument_list),
                }),
                None => other,
            },
            Expression::Call(Call::Method(_) | Call::NullSafeMethod(_)) => {
                let mut calls = vec![];
                let mut base = e;
                loop {
                    let (object, arrow, method, list, nullsafe) = match base {
                        Expression::Call(Call::Method(c)) => (c.object, c.arrow, &c.method, &c.argument_list, false),
                        Expression::Call(Call::NullSafeMethod(c)) => (c.object, c.question_mark_arrow, &c.method, &c.argument_list, true),
                        _ => break,
                    };
                    calls.push(json!({
                        "name": Self::selector_name(method),
                        "nullsafe": nullsafe,
                        "args": self.args(list),
                        "span": self.range(arrow.start.offset, list.right_parenthesis.end.offset),
                        "nameSpan": self.span(method.span()),
                    }));
                    base = object;
                }
                calls.reverse();
                json!({ "kind": "chain", "base": self.node(base), "calls": calls })
            }
            Expression::Call(Call::Function(c)) => match c.function {
                Expression::Identifier(id) => json!({
                    "kind": "func",
                    "name": self.function_name(id),
                    "nameSpan": self.span(id.span()),
                    "args": self.args(&c.argument_list),
                }),
                _ => other,
            },
            Expression::Access(Access::ClassConstant(a)) => match (self.class_ref(a.class), &a.constant) {
                (Some(class), ClassLikeConstantSelector::Identifier(id)) => {
                    json!({ "kind": "classConst", "class": class, "classSpan": self.span(a.class.span()), "name": lossy(id.value) })
                }
                _ => other,
            },
            Expression::Access(Access::StaticProperty(a)) => match (self.class_ref(a.class), &a.property) {
                (Some(class), Variable::Direct(v)) => json!({ "kind": "staticProp", "class": class, "name": var_name(v) }),
                _ => other,
            },
            Expression::Access(Access::Property(a)) => json!({ "kind": "prop", "object": self.node(a.object), "name": Self::selector_name(&a.property), "nullsafe": false }),
            Expression::Access(Access::NullSafeProperty(a)) => {
                json!({ "kind": "prop", "object": self.node(a.object), "name": Self::selector_name(&a.property), "nullsafe": true })
            }
            Expression::Variable(Variable::Direct(v)) => json!({ "kind": "var", "name": var_name(v) }),
            Expression::Instantiation(i) => match self.class_ref(i.class) {
                Some(class) => json!({ "kind": "new", "class": class, "args": i.argument_list.as_ref().map(|l| self.args(l)) }),
                None => other,
            },
            Expression::Closure(c) => json!({
                "kind": "closure",
                "arrow": false,
                "static": c.r#static.is_some(),
                "params": c.parameter_list.parameters.iter().map(|p| var_name(&p.variable)).collect::<Vec<_>>(),
                "body": self.range(c.body.left_brace.end.offset, c.body.right_brace.start.offset),
                "statements": self.statements(c.body.statements.iter()),
            }),
            Expression::ArrowFunction(f) => json!({
                "kind": "closure",
                "arrow": true,
                "static": f.r#static.is_some(),
                "params": f.parameter_list.parameters.iter().map(|p| var_name(&p.variable)).collect::<Vec<_>>(),
                "body": self.span(f.expression.span()),
            }),
            Expression::ConstantAccess(c) => json!({ "kind": "const", "name": self.function_name(&c.name) }),
            Expression::Identifier(id) => json!({ "kind": "const", "name": self.function_name(id) }),
            Expression::Binary(b) if matches!(b.operator, BinaryOperator::StringConcat(_)) => {
                let mut parts = vec![];
                let mut stack = vec![b.rhs, b.lhs];
                while let Some(part) = stack.pop() {
                    match part {
                        Expression::Binary(b) if matches!(b.operator, BinaryOperator::StringConcat(_)) => stack.extend([b.rhs, b.lhs]),
                        _ => parts.push(self.node(part)),
                    }
                }
                json!({ "kind": "concat", "parts": parts })
            }
            _ => other,
        }
    }

    fn array(&self, open: u32, elements: &TokenSeparatedSequence<'_, ArrayElement<'_>>, close: u32, legacy: bool) -> Value {
        let items: Vec<Value> = elements
            .iter()
            .filter_map(|el| {
                let (key, value, spread) = match el {
                    ArrayElement::KeyValue(kv) => (Some(self.node(kv.key)), kv.value, false),
                    ArrayElement::Value(v) => (None, v.value, false),
                    ArrayElement::Variadic(v) => (None, v.value, true),
                    ArrayElement::Missing(_) => return None,
                };
                Some(json!({ "key": key, "value": self.node(value), "span": self.span(el.span()), "spread": spread }))
            })
            .collect();
        json!({ "kind": "array", "items": items, "open": self.at(open), "close": self.at(close), "legacy": legacy })
    }
}

fn var_name(v: &DirectVariable<'_>) -> String {
    lossy(v.name).trim_start_matches('$').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str) -> Value {
        outline(json!({ "text": text })).unwrap()
    }

    /// The text at a `[start, end)` span of UTF-16 offsets.
    fn at(text: &str, span: &Value) -> String {
        let units: Vec<u16> = text.encode_utf16().collect();
        let (s, e) = (span[0].as_u64().unwrap() as usize, span[1].as_u64().unwrap() as usize);
        String::from_utf16(&units[s..e]).unwrap()
    }

    fn method<'v>(class: &'v Value, name: &str) -> &'v Value {
        class["methods"].as_array().unwrap().iter().find(|m| m["name"] == name).unwrap()
    }

    const RESOURCE: &str = r#"<?php

namespace App\Filament\Resources;

use App\Models\Post;
use BackedEnum;
use Filament\Forms;
use Filament\Resources\Resource as BaseResource;
use Filament\Schemas\{Schema, Components\Section};
use Filament\Support\Icons\Heroicon;
use Filament\Tables\Table;
use Filament\Forms\Components\TextInput;
use Filament\Tables\Columns\TextColumn;

class PostResource extends BaseResource
{
    protected static ?string $model = Post::class;

    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedRectangleStack;

    public static function form(Schema $schema): Schema
    {
        return $schema->components([
            TextInput::make('title')->required()->maxLength(255),
            Section::make('Meta')->schema([
                Forms\Components\Toggle::make('published'),
            ])->columns(2),
        ]);
    }

    public static function delegated(Schema $schema): Schema
    {
        return PostForm::configure($schema);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                TextColumn::make('title')->formatStateUsing(fn (string $state): string => strtoupper($state)),
            ])
            ->filters([])
            ->recordActions([]);
    }
}
"#;

    #[test]
    fn outlines_a_filament_resource() {
        let o = run(RESOURCE);
        assert_eq!(o["errors"], false);
        assert_eq!(o["namespace"], "App\\Filament\\Resources");
        let uses = o["uses"].as_array().unwrap();
        let alias = uses.iter().find(|u| u["alias"] == "BaseResource").unwrap();
        assert_eq!(alias["name"], "Filament\\Resources\\Resource");
        let section = uses.iter().find(|u| u["alias"] == "Section").unwrap();
        assert_eq!(section["name"], "Filament\\Schemas\\Components\\Section");
        let schema = uses.iter().find(|u| u["alias"] == "Schema").unwrap();
        assert_eq!(schema["span"], section["span"]);
        assert_eq!(at(RESOURCE, &schema["span"]), "use Filament\\Schemas\\{Schema, Components\\Section};");
        let insert = o["useInsert"].as_u64().unwrap() as usize;
        assert!(RESOURCE[..insert].ends_with("TextColumn;\n"));

        let class = &o["classes"][0];
        assert_eq!(class["fqn"], "App\\Filament\\Resources\\PostResource");
        assert_eq!(class["extends"], "Filament\\Resources\\Resource");
        assert_eq!(at(RESOURCE, &json!([class["bodyStart"], class["bodyEnd"]])).trim().lines().next().unwrap(), "protected static ?string $model = Post::class;");

        let props = class["properties"].as_array().unwrap();
        assert_eq!(props[0]["name"], "model");
        assert_eq!(props[0]["static"], true);
        assert_eq!(props[0]["visibility"], "protected");
        assert_eq!(props[0]["type"], "?string");
        assert_eq!(props[0]["value"]["kind"], "classConst");
        assert_eq!(props[0]["value"]["class"], "App\\Models\\Post");
        assert_eq!(props[0]["value"]["name"], "class");
        assert_eq!(at(RESOURCE, &props[0]["span"]), "protected static ?string $model = Post::class;");
        assert_eq!(props[1]["type"], "string|BackedEnum|null");
        assert_eq!(props[1]["value"]["class"], "Filament\\Support\\Icons\\Heroicon");
        assert_eq!(props[1]["value"]["name"], "OutlinedRectangleStack");

        let form = method(class, "form");
        assert_eq!(form["static"], true);
        assert_eq!(form["returnType"], "Schema");
        assert_eq!(form["params"][0]["name"], "schema");
        assert_eq!(form["params"][0]["type"], "Schema");
        let ret = &form["returns"][0];
        assert_eq!(ret["kind"], "chain");
        assert_eq!(ret["base"]["kind"], "var");
        assert_eq!(ret["base"]["name"], "schema");
        let components = &ret["calls"][0];
        assert_eq!(components["name"], "components");
        assert_eq!(at(RESOURCE, &components["span"]).lines().next().unwrap(), "->components([");
        assert_eq!(at(RESOURCE, &components["nameSpan"]), "components");
        let items = components["args"]["items"][0]["value"]["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);

        let title = &items[0]["value"];
        assert_eq!(title["kind"], "chain");
        assert_eq!(title["base"]["kind"], "static");
        assert_eq!(title["base"]["class"], "Filament\\Forms\\Components\\TextInput");
        assert_eq!(title["base"]["method"], "make");
        assert_eq!(title["base"]["args"]["items"][0]["value"]["value"], "title");
        assert_eq!(at(RESOURCE, &title["calls"][0]["span"]), "->required()");
        assert_eq!(at(RESOURCE, &title["calls"][1]["span"]), "->maxLength(255)");
        assert_eq!(title["calls"][1]["args"]["items"][0]["value"]["value"], 255.0);
        assert_eq!(at(RESOURCE, &items[0]["span"]), "TextInput::make('title')->required()->maxLength(255)");
        // Removing a call is removing the text between the previous one's end and its own.
        let calls = title["calls"].as_array().unwrap();
        let start = calls[0]["span"][1].as_u64().unwrap() as usize;
        let end = calls[1]["span"][1].as_u64().unwrap() as usize;
        let edited = format!("{}{}", &RESOURCE[..start], &RESOURCE[end..]);
        assert!(edited.contains("TextInput::make('title')->required(),"));

        let section = &items[1]["value"];
        assert_eq!(section["base"]["class"], "Filament\\Schemas\\Components\\Section");
        assert_eq!(section["calls"][0]["name"], "schema");
        assert_eq!(section["calls"][1]["name"], "columns");
        let nested = &section["calls"][0]["args"]["items"][0]["value"];
        assert_eq!(nested["kind"], "array");
        assert_eq!(&RESOURCE[nested["open"].as_u64().unwrap() as usize..][..1], "[");
        assert_eq!(&RESOURCE[nested["close"].as_u64().unwrap() as usize..][..1], "]");
        let toggle = &nested["items"][0]["value"];
        assert_eq!(toggle["kind"], "static");
        assert_eq!(toggle["class"], "Filament\\Forms\\Components\\Toggle");
        assert_eq!(at(RESOURCE, &toggle["span"]), "Forms\\Components\\Toggle::make('published')");
        assert_eq!(at(RESOURCE, &toggle["classSpan"]), "Forms\\Components\\Toggle");
    }

    #[test]
    fn outlines_delegation_and_tables() {
        let o = run(RESOURCE);
        let class = &o["classes"][0];
        let delegated = &method(class, "delegated")["returns"][0];
        assert_eq!(delegated["kind"], "static");
        assert_eq!(delegated["class"], "App\\Filament\\Resources\\PostForm");
        assert_eq!(delegated["method"], "configure");
        assert_eq!(delegated["args"]["items"][0]["value"]["kind"], "var");

        let table = &method(class, "table")["returns"][0];
        let names: Vec<&str> = table["calls"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["columns", "filters", "recordActions"]);
        assert_eq!(at(RESOURCE, &table["calls"][1]["span"]), "->filters([])");
        let column = &table["calls"][0]["args"]["items"][0]["value"]["items"][0]["value"];
        let closure = &column["calls"][0]["args"]["items"][0]["value"];
        assert_eq!(closure["kind"], "closure");
        assert_eq!(closure["arrow"], true);
        assert_eq!(closure["params"], json!(["state"]));
        assert_eq!(at(RESOURCE, &closure["body"]), "strtoupper($state)");
        let body = &closure["span"];
        assert_eq!(at(RESOURCE, body), "fn (string $state): string => strtoupper($state)");
    }

    #[test]
    fn offsets_count_utf16_code_units() {
        let text = "<?php\n// Straße 🦣\nclass A { public $x = ['ü' => TextInput::make('🦣')->label('ß')]; }\n";
        let o = run(text);
        let prop = &o["classes"][0]["properties"][0];
        assert_eq!(at(text, &prop["span"]), "public $x = ['ü' => TextInput::make('🦣')->label('ß')];");
        let item = &prop["value"]["items"][0];
        assert_eq!(at(text, &item["key"]["span"]), "'ü'");
        assert_eq!(item["value"]["base"]["args"]["items"][0]["value"]["value"], "🦣");
        assert_eq!(at(text, &item["value"]["calls"][0]["span"]), "->label('ß')");
    }

    #[test]
    fn outlines_literals_functions_and_concatenation() {
        let text = "<?php\nnamespace App;\nclass A {\n    const X = -5;\n    public $label = __('Label');\n    public $joined = 'a' . 'b' . PHP_EOL;\n    public $doc = <<<EOT\n    Hello\n    EOT;\n    public $quoted = 'it\\'s';\n    public $float = 1.5;\n    public $flag = true;\n    public $escaped = \"a\\t\\$b\";\n    public $mixed = \"x{$y}\";\n}\n";
        let class = &run(text)["classes"][0];
        let x = &class["constants"][0]["value"];
        assert_eq!((x["kind"].as_str(), x["value"].as_f64(), x["raw"].as_str()), (Some("number"), Some(-5.0), Some("-5")));
        let props = class["properties"].as_array().unwrap();
        assert_eq!(props[0]["value"]["kind"], "func");
        assert_eq!(props[0]["value"]["name"], "__");
        assert_eq!(props[0]["value"]["args"]["items"][0]["value"]["value"], "Label");
        let parts = props[1]["value"]["parts"].as_array().unwrap();
        assert_eq!(props[1]["value"]["kind"], "concat");
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[2]["kind"], "const");
        assert_eq!(parts[2]["name"], "PHP_EOL");
        assert_eq!(props[2]["value"]["quote"], "heredoc");
        assert_eq!(props[2]["value"]["interpolated"], false);
        assert_eq!(props[2]["value"]["value"], "Hello");
        assert_eq!(props[3]["value"]["value"], "it's");
        assert_eq!(props[4]["value"]["value"], 1.5);
        assert_eq!(props[5]["value"]["kind"], "bool");
        assert_eq!(props[6]["value"]["value"], "a\t$b");
        assert_eq!(props[6]["value"]["interpolated"], false);
        assert_eq!((props[7]["value"]["value"].as_str(), props[7]["value"]["interpolated"].as_bool()), (Some("x{$y}"), Some(true)));
    }

    #[test]
    fn outlines_anonymous_migrations() {
        let text = "<?php\n\nuse Illuminate\\Database\\Migrations\\Migration;\nuse Illuminate\\Support\\Facades\\Schema;\n\nreturn new class extends Migration {\n    public function up(): void\n    {\n        Schema::create('posts', function (Blueprint $table) {\n            $table->id();\n            return 1;\n        });\n    }\n};\n";
        let class = &run(text)["classes"][0];
        assert_eq!(class["name"], "");
        assert_eq!(class["fqn"], "");
        assert_eq!(class["extends"], "Illuminate\\Database\\Migrations\\Migration");
        let up = method(class, "up");
        assert_eq!(up["returnType"], "void");
        assert_eq!(up["returns"], json!([]));
    }

    #[test]
    fn outlines_models_and_enums() {
        let text = "<?php\nnamespace App\\Models;\n\nuse Illuminate\\Database\\Eloquent\\Attributes\\Fillable;\nuse Illuminate\\Database\\Eloquent\\Model;\n\nenum Status: string\n{\n    case Draft = 'draft';\n    case Published = 'published';\n}\n\n#[Fillable(['a', 'b'])]\nfinal class Post extends Model\n{\n    use HasFactory;\n\n    protected $fillable = ['title'];\n\n    protected function casts(): array\n    {\n        return ['published_at' => 'datetime', 'status' => Status::class];\n    }\n}\n";
        let o = run(text);
        let status = &o["classes"][0];
        assert_eq!(status["kind"], "enum");
        assert_eq!(status["cases"][1]["name"], "Published");
        assert_eq!(status["cases"][1]["value"]["value"], "published");
        let post = &o["classes"][1];
        assert_eq!(post["final"], true);
        assert_eq!(post["traits"], json!(["App\\Models\\HasFactory"]));
        let attribute = &post["attributes"][0];
        assert_eq!(attribute["name"], "Illuminate\\Database\\Eloquent\\Attributes\\Fillable");
        assert_eq!(at(text, &attribute["span"]), "Fillable(['a', 'b'])");
        assert_eq!(at(text, &attribute["list"]), "#[Fillable(['a', 'b'])]");
        assert_eq!(attribute["args"]["items"][0]["value"]["items"][1]["value"]["value"], "b");
        let fillable = &post["properties"][0];
        assert_eq!((fillable["name"].as_str(), fillable["static"].as_bool(), fillable["type"].is_null()), (Some("fillable"), Some(false), true));
        assert_eq!(fillable["value"]["items"][0]["value"]["value"], "title");
        let casts = &method(post, "casts")["returns"][0];
        assert_eq!(casts["items"][0]["key"]["value"], "published_at");
        assert_eq!(casts["items"][1]["value"]["class"], "App\\Models\\Status");
        assert_eq!(at(text, &casts["items"][1]["span"]), "'status' => Status::class");
        assert_eq!(o["useInsert"].as_u64().unwrap() as usize, text.find("\nenum").unwrap());
    }

    #[test]
    fn methods_keep_their_docblocks_and_skip_nested_returns() {
        let text = "<?php\nclass A\n{\n    /**\n     * Runs.\n     */\n    #[Pure]\n    public function run(): array\n    {\n        $f = function () { return 1; };\n        $g = fn () => 2;\n        if ($f) {\n            return [1];\n        }\n        return [2];\n    }\n\n    // Not a docblock.\n    abstract protected function other();\n}\n";
        let class = &run(text)["classes"][0];
        let run_method = method(class, "run");
        let doc = run_method["docStart"].as_u64().unwrap() as usize;
        assert!(text[doc..].starts_with("/**"));
        assert!(at(text, &run_method["span"]).starts_with("#[Pure]"));
        assert!(at(text, &run_method["span"]).ends_with('}'));
        let returns: Vec<String> = run_method["returns"].as_array().unwrap().iter().map(|r| at(text, &r["span"])).collect();
        assert_eq!(returns, ["[1]", "[2]"]);
        let other = method(class, "other");
        assert!(other["docStart"].is_null());
        assert!(other["body"].is_null());
        assert_eq!(other["abstract"], true);
        assert_eq!(other["visibility"], "protected");
    }

    #[test]
    fn gives_body_statements_with_if_blocks() {
        let text = "<?php\nclass O\n{\n    public function updated(Order $order): void\n    {\n        if ($order->wasChanged('status')) {\n            $order->user?->notify(new X($order));\n        }\n        log('x');\n        if ($a) { b(); } else { c(); }\n        foreach ($a as $b) {}\n    }\n}\n";
        let out = run(text);
        let stmts = method(&out["classes"][0], "updated")["bodyStatements"].as_array().unwrap().clone();
        let kinds: Vec<&str> = stmts.iter().map(|s| s["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["if", "expression", "other", "other"]);
        assert_eq!(at(text, &stmts[0]["condition"]), "$order->wasChanged('status')");
        assert_eq!(at(text, &stmts[0]["then"][0]), "$order->user?->notify(new X($order));");
        assert_eq!(at(text, &stmts[1]["span"]), "log('x');");
        assert!(at(text, &stmts[0]["span"]).ends_with('}'));
    }

    #[test]
    fn outlines_a_files_own_statements_and_closure_bodies() {
        let text = "<?php\n\nuse Illuminate\\Support\\Facades\\Schedule;\n\nSchedule::command('inspire')->hourly();\n$x = 1;\n\nreturn App::configure()->withSchedule(function ($schedule) {\n    $schedule->job(new Ping)->daily();\n})->create();\n";
        let o = run(text);
        let statements = o["statements"].as_array().unwrap();
        assert_eq!(statements.len(), 2);
        assert_eq!(statements[0]["value"]["base"]["class"], "Illuminate\\Support\\Facades\\Schedule");
        assert_eq!(at(text, &statements[0]["value"]["span"]), "Schedule::command('inspire')->hourly()");
        assert_eq!(statements[1]["assigns"], "x");
        let chain = &o["returns"][0];
        assert_eq!(chain["calls"][0]["name"], "withSchedule");
        let closure = &chain["calls"][0]["args"]["items"][0]["value"];
        assert_eq!(at(text, &closure["statements"][0]["value"]["span"]), "$schedule->job(new Ping)->daily()");
    }

    #[test]
    fn broken_code_still_outlines() {
        let text = "<?php\nclass A {\n    public static function form($schema) {\n        return $schema->components([\n            TextInput::make('a'),\n        ;\n    }\n    public $b = 1;\n}\n";
        let o = run(text);
        assert_eq!(o["errors"], true);
        assert_eq!(o["classes"][0]["name"], "A");
        for cut in (0..=RESOURCE.len()).filter(|&i| RESOURCE.is_char_boundary(i)) {
            run(&RESOURCE[..cut]);
        }
    }
}
