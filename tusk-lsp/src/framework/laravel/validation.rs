//! Validation: the rules a form request, a `validate()` call, or a Livewire component declares, and what they tell
//! the strings that name input keys and the tables of `exists` and `unique`.
//!
//! ```php
//! public function rules(): array {
//!     return ['title' => 'required|string', 'tags.*' => 'exists:tags,id'];  // tables and their columns
//! }
//! $request->validated('title');      // the rules' keys, checked when the rules are all known
//! $request->safe()->only(['title']); // the same
//! $request->input('title');          // the rules' keys, offered but never checked: input can have any key
//! ```
//!
//! The index reads each project class's rules when it reads the file ([`scan`]), so a controller sees its form
//! request's rules without opening it, and the analyzer types `validated()` from them ([`super::validated`]).

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use lsp_types::{CompletionItem, CompletionItemKind, Diagnostic, DiagnosticSeverity, Location, NumberOrString, Range};
use mago_database::file::FileId;
use mago_span::HasSpan;
use mago_syntax::cst::{
    Argument, ArrayElement, AssignmentOperator, ClassLikeMember, ClassLikeMemberSelector, Expression, Literal, MethodBody, Node,
    PartialArgument, Property, Variable,
};
use parking_lot::Mutex;
use serde_json::Value;

use super::data::Data;
use super::{SOURCE, completion_item, link, replacement, rule_items};
use crate::analysis::Parsed;
use crate::features::Ctx;
use crate::framework::{CallKind, InArray, StringArg};
use crate::index::Index;

pub const REQUEST: &str = "Illuminate\\Http\\Request";
pub const FORM_REQUEST: &str = "Illuminate\\Foundation\\Http\\FormRequest";
pub const VALIDATED_INPUT: &str = "Illuminate\\Support\\ValidatedInput";
pub const LIVEWIRE_COMPONENT: &str = "Livewire\\Component";
pub const LIVEWIRE_FORM: &str = "Livewire\\Form";

/// One key of a rules array, such as `'tags.*' => ['string', Rule::in($tags)]`.
#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    pub key: String,
    /// Each rule: a string rule as written (`max:255`), or a rule object's source (`Rule::in($tags)`).
    pub rules: Vec<String>,
    /// Whether the rules are all here: the value is a string, or a list of strings and rule objects.
    pub known: bool,
    /// The key's contents in its file, without the quotes.
    pub span: (u32, u32),
}

/// The keys of a rules array.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Rules {
    pub fields: Vec<Field>,
    /// Whether these are all the keys: one array literal whose keys are all plain strings, with no spread.
    pub complete: bool,
}

impl Rules {
    /// The fields whose key covers `key`: the same key, a key inside it, or the array it's inside. `*` matches any
    /// one part, on either side.
    pub fn covering(&self, key: &str) -> Vec<&Field> {
        self.fields.iter().filter(|f| same_path(&f.key, key)).collect()
    }
}

/// Whether two dotted keys are the same, or one is inside the other, with `*` matching any one part.
fn same_path(a: &str, b: &str) -> bool {
    a.split('.').zip(b.split('.')).all(|(x, y)| x == y || x == "*" || y == "*")
}

/// The rules a class declares: `rules()`, and for Livewire, `#[Validate]` on its properties.
#[derive(Debug, Clone, PartialEq)]
pub struct ClassRules {
    pub class: String,
    pub rules: Option<Rules>,
    /// Whether the class changes its validator in a way that can add keys or replace the rules: it declares
    /// `withValidator()`, `validator()`, `getValidatorInstance()`, or `validated()`.
    pub custom: bool,
}

/// The rules each class in a parsed file declares. Reads only the classes at the top of the file or of a namespace,
/// so a file of any depth costs nothing.
pub fn scan(parsed: &Parsed<'_>) -> Vec<ClassRules> {
    use mago_syntax::cst::Statement;
    let mut out = vec![];
    for statement in parsed.program.statements.iter() {
        match statement {
            Statement::Class(c) => out.extend(class(parsed, None, c)),
            Statement::Namespace(ns) => {
                let name = ns.name.as_ref().map(|n| String::from_utf8_lossy(n.value()).into_owned());
                for s in ns.statements().iter() {
                    if let Statement::Class(c) = s {
                        out.extend(class(parsed, name.as_deref(), c));
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn class(parsed: &Parsed<'_>, namespace: Option<&str>, c: &mago_syntax::cst::Class<'_>) -> Option<ClassRules> {
    let text = parsed.text();
    let name = String::from_utf8_lossy(c.name.value);
    let class = match namespace {
        Some(ns) if !ns.is_empty() => format!("{ns}\\{name}"),
        _ => name.into_owned(),
    };
    let (mut rules, mut custom, mut attributes) = (None, false, Rules { fields: vec![], complete: true });
    for member in c.members.iter() {
        match member {
            ClassLikeMember::Method(m) => match m.name.value.to_ascii_lowercase().as_slice() {
                b"rules" => rules = Some(method_rules(text, m)),
                b"withvalidator" | b"validator" | b"getvalidatorinstance" | b"validated" => custom = true,
                _ => {}
            },
            ClassLikeMember::Property(p) => attributes.fields.extend(attribute_rules(parsed, p)),
            _ => {}
        }
    }
    // Livewire merges the attributes' rules with `rules()`'s.
    if !attributes.fields.is_empty() {
        rules = Some(match rules {
            Some(mut r) => {
                r.fields.extend(attributes.fields);
                r
            }
            None => attributes,
        });
    }
    (rules.is_some() || custom).then_some(ClassRules { class, rules, custom })
}

/// A plain string literal's contents and their span.
fn literal(expr: &Expression<'_>) -> Option<(String, (u32, u32))> {
    let Expression::Literal(Literal::String(s)) = expr else { return None };
    let value = s.value?;
    Some((String::from_utf8_lossy(value).into_owned(), (s.span.start.offset + 1, s.span.end.offset.saturating_sub(1))))
}

fn source(text: &str, expr: &Expression<'_>) -> String {
    let span = expr.span();
    let s = text.get(span.start.offset as usize..span.end.offset as usize).unwrap_or_default();
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn elements<'a>(expr: &'a Expression<'a>) -> Option<&'a mago_syntax::cst::TokenSeparatedSequence<'a, ArrayElement<'a>>> {
    match expr {
        Expression::Array(a) => Some(&a.elements),
        Expression::LegacyArray(a) => Some(&a.elements),
        Expression::Parenthesized(p) => elements(p.expression),
        _ => None,
    }
}

/// The fields of a rules array literal, or `None` if `expr` isn't one.
pub fn array_rules(text: &str, expr: &Expression<'_>) -> Option<Rules> {
    let mut rules = Rules { fields: vec![], complete: true };
    for element in elements(expr)?.iter() {
        match element {
            ArrayElement::KeyValue(kv) => match literal(kv.key) {
                Some((key, span)) => {
                    let (list, known) = value_rules(text, kv.value);
                    rules.fields.push(Field { key, rules: list, known, span });
                }
                None => rules.complete = false,
            },
            ArrayElement::Missing(_) => {}
            ArrayElement::Value(_) | ArrayElement::Variadic(_) => rules.complete = false,
        }
    }
    Some(rules)
}

/// A key's rules: a string's, split at `|`, or a list's, each string one rule and each object its source.
fn value_rules(text: &str, value: &Expression<'_>) -> (Vec<String>, bool) {
    if let Some((s, _)) = literal(value) {
        return (s.split('|').map(str::trim).filter(|r| !r.is_empty()).map(String::from).collect(), true);
    }
    let Some(list) = elements(value) else { return (vec![source(text, value)], false) };
    let mut known = true;
    let mut out = vec![];
    for element in list.iter() {
        match element {
            ArrayElement::Value(v) => out.push(literal(v.value).map_or_else(|| source(text, v.value), |(s, _)| s.trim().to_string())),
            ArrayElement::Missing(_) => {}
            _ => known = false,
        }
    }
    (out, known)
}

/// The rules `rules()` returns: complete when its one `return` returns an array literal, and otherwise what can
/// be read from the arrays it returns, merges, or builds in a variable.
fn method_rules(text: &str, method: &mago_syntax::cst::Method<'_>) -> Rules {
    let MethodBody::Concrete(block) = &method.body else { return Rules::default() };
    // The method's own returns and assignments, not those of closures inside it.
    let mut returns = vec![];
    let mut assignments = vec![];
    fn collect<'a>(node: Node<'a, 'a>, depth: u32, returns: &mut Vec<&'a Expression<'a>>, assignments: &mut Vec<&'a mago_syntax::cst::Assignment<'a>>) {
        if depth > 64 {
            return;
        }
        match node {
            Node::Closure(_) | Node::ArrowFunction(_) | Node::AnonymousClass(_) | Node::Function(_) => return,
            Node::Return(r) => returns.extend(r.value),
            Node::Assignment(a) => assignments.push(a),
            _ => {}
        }
        node.visit_children(|child| collect(child, depth + 1, returns, assignments));
    }
    collect(Node::Block(block), 0, &mut returns, &mut assignments);
    if let [only] = returns.as_slice()
        && let Some(rules) = array_rules(text, only)
    {
        return rules;
    }
    let mut out = Rules::default();
    let mut add = |rules: Option<Rules>| out.fields.extend(rules.into_iter().flat_map(|r| r.fields));
    for value in returns {
        match value {
            Expression::Variable(Variable::Direct(var)) => {
                for a in &assignments {
                    if !matches!(a.operator, AssignmentOperator::Assign(_)) {
                        continue;
                    }
                    match a.lhs {
                        Expression::Variable(Variable::Direct(v)) if v.name == var.name => add(array_rules(text, a.rhs)),
                        Expression::ArrayAccess(access) if matches!(access.array, Expression::Variable(Variable::Direct(v)) if v.name == var.name) => {
                            if let Some((key, span)) = literal(access.index) {
                                let (list, known) = value_rules(text, a.rhs);
                                add(Some(Rules { fields: vec![Field { key, rules: list, known, span }], complete: false }));
                            }
                        }
                        _ => {}
                    }
                }
            }
            // `array_merge(parent::rules(), [...])` and the like.
            Expression::Call(mago_syntax::cst::Call::Function(c)) => {
                for arg in c.argument_list.arguments.iter() {
                    add(array_rules(text, arg.value()));
                }
            }
            other => add(array_rules(text, other)),
        }
    }
    out
}

/// The rules of Livewire's `#[Validate]` (or its older name, `#[Rule]`) on a property: the property's own, or for
/// an array given with keys, those keys'.
fn attribute_rules(parsed: &Parsed<'_>, property: &Property<'_>) -> Vec<Field> {
    let text = parsed.text();
    let (lists, variables) = match property {
        Property::Plain(p) => (&p.attribute_lists, property.variables()),
        Property::Hooked(p) => (&p.attribute_lists, vec![p.item.variable()]),
    };
    let mut out = vec![];
    for attribute in lists.iter().flat_map(|l| l.attributes.iter()) {
        let Some(name) = parsed.names.resolve(&attribute.name.span()) else { continue };
        if !(name.eq_ignore_ascii_case(b"Livewire\\Attributes\\Validate") || name.eq_ignore_ascii_case(b"Livewire\\Attributes\\Rule")) {
            continue;
        }
        let Some(arguments) = &attribute.argument_list else { continue };
        let value = arguments.arguments.iter().find_map(|a| match a {
            PartialArgument::Positional(p) => Some(p.value),
            PartialArgument::Named(n) if n.name.value == b"rule" => Some(n.value),
            _ => None,
        });
        let Some(value) = value else { continue };
        // With keys, the array's keys are the fields: `#[Validate(['todos.*' => 'required'])]`.
        if let Some(rules) = array_rules(text, value).filter(|r| !r.fields.is_empty()) {
            out.extend(rules.fields);
            continue;
        }
        let (list, known) = value_rules(text, value);
        for var in &variables {
            let name = String::from_utf8_lossy(var.name).trim_start_matches('$').to_string();
            out.push(Field { key: name, rules: list.clone(), known, span: (var.span.start.offset + 1, var.span.end.offset) });
        }
    }
    out
}

/// Each project class's rules by its lowercase name, with the file that declares them, for the index's generation.
pub type ByClass = HashMap<String, (FileId, Arc<ClassRules>)>;

pub fn by_class(index: &Index) -> Arc<ByClass> {
    static CACHE: LazyLock<Mutex<(u64, Arc<ByClass>)>> = LazyLock::new(Default::default);
    let mut cache = CACHE.lock();
    if cache.0 != index.generation {
        let mut map = ByClass::new();
        for (file, list) in &index.validation {
            for rules in list {
                map.insert(rules.class.to_ascii_lowercase(), (*file, rules.clone()));
            }
        }
        *cache = (index.generation, Arc::new(map));
    }
    cache.1.clone()
}

/// The rules a class validates with: its own, or the nearest parent's that declares them.
#[derive(Debug, Clone)]
pub struct Found {
    /// The class that declares the rules, as declared.
    pub class: String,
    pub file: FileId,
    pub rules: Rules,
    /// Whether every key the class's validated data can have is in `rules`.
    pub sure: bool,
}

pub fn class_rules(codebase: &mago_codex::metadata::CodebaseMetadata, by_class: &ByClass, class: &str) -> Option<Found> {
    let mut class = codebase.get_class_like(class.as_bytes())?;
    let mut custom = false;
    for _ in 0..32 {
        if let Some((file, found)) = by_class.get(&class.original_name.as_str_lossy().to_ascii_lowercase()) {
            custom |= found.custom;
            if let Some(rules) = &found.rules {
                return Some(Found { class: found.class.clone(), file: *file, rules: rules.clone(), sure: rules.complete && !custom });
            }
        }
        class = codebase.get_class_like(class.direct_parent_class?.as_bytes())?;
    }
    None
}

/// The methods whose first argument is an input key, on a request or its `safe()` input.
const INPUT_METHODS: &[&str] = &[
    "validated", "input", "string", "str", "integer", "float", "boolean", "date", "enum", "enums", "array", "collect", "has", "hasAny",
    "filled", "anyFilled", "isNotFilled", "missing", "whenHas", "whenFilled", "exists", "only", "except", "post", "query", "file", "hasFile",
];
/// Of those, the ones that take a list of keys, as an array or one key per argument.
const LIST_METHODS: &[&str] = &["has", "hasAny", "filled", "anyFilled", "isNotFilled", "missing", "only", "except"];

/// Where an input key's string gets its keys.
enum Source {
    /// A form request's rules, or a Livewire component's. `checked` says the call reads only validated input, so a
    /// key the rules don't have is a mistake.
    Class { found: Found, checked: bool },
    /// The rules a `validate()` or `Validator::make()` in the same function gives.
    Local(Vec<Rules>),
}

/// The call node a string argument is in.
fn call_node<'a>(ctx: &Ctx<'a>, arg: &StringArg) -> Option<(Vec<Node<'a, 'a>>, usize)> {
    let path = ctx.parsed.path_at(arg.start);
    let i = path.iter().rposition(|n| (n.span().start.offset, n.span().end.offset) == arg.call.span)?;
    Some((path, i))
}

/// Where the keys for an input key's string come from, if it's one.
fn source_of(ctx: &Ctx<'_>, arg: &StringArg) -> Option<Source> {
    if arg.call.kind != CallKind::Method || !arg.call.is_method(INPUT_METHODS) && !arg.call.is_method(&["validateOnly"]) {
        return None;
    }
    let list = arg.call.is_method(LIST_METHODS);
    let placed = match &arg.in_array {
        None => arg.index == 0 || list,
        Some(InArray::Value(None)) => list,
        _ => false,
    };
    if !placed {
        return None;
    }
    let codebase = &ctx.index.codebase;
    let is = |classes: &[String], parent: &str| classes.iter().any(|c| c.eq_ignore_ascii_case(parent) || codebase.is_instance_of(c.as_bytes(), parent.as_bytes()));
    let by_class = by_class(&ctx.index);
    let rules_of = |classes: &[String]| classes.iter().find_map(|c| class_rules(codebase, &by_class, c));
    if arg.call.is_method(&["validateOnly"]) {
        return is(&arg.call.classes, LIVEWIRE_COMPONENT).then(|| rules_of(&arg.call.classes)).flatten().map(|found| Source::Class { found, checked: false });
    }
    // `$request->safe()->only([...])` reads the validated input of the request before `safe()`.
    if is(&arg.call.classes, VALIDATED_INPUT) {
        let (path, i) = call_node(ctx, arg)?;
        let object = match path[i] {
            Node::MethodCall(c) => c.object,
            Node::NullSafeMethodCall(c) => c.object,
            _ => return None,
        };
        let Expression::Call(mago_syntax::cst::Call::Method(safe)) = object else { return None };
        if !matches!(&safe.method, ClassLikeMemberSelector::Identifier(id) if id.value.eq_ignore_ascii_case(b"safe")) || !safe.argument_list.arguments.is_empty() {
            return None;
        }
        let classes = ctx.resolver().classes_of(safe.object);
        return is(&classes, FORM_REQUEST).then(|| rules_of(&classes)).flatten().map(|found| Source::Class { found, checked: true });
    }
    if !is(&arg.call.classes, REQUEST) {
        return None;
    }
    if is(&arg.call.classes, FORM_REQUEST)
        && let Some(found) = rules_of(&arg.call.classes)
    {
        return Some(Source::Class { found, checked: arg.call.is_method(&["validated"]) });
    }
    let local = local_rules(ctx, arg.start);
    (!local.is_empty()).then_some(Source::Local(local))
}

/// The literal rules a `validate()`, `validateWithBag()`, `Validator::make()`, or `validator()` call passes in the
/// function-like around `at`.
fn local_rules(ctx: &Ctx<'_>, at: u32) -> Vec<Rules> {
    let path = ctx.parsed.path_at(at);
    let Some(scope) = path.iter().rev().find(|n| matches!(n, Node::Method(_) | Node::Function(_) | Node::Closure(_) | Node::ArrowFunction(_))) else { return vec![] };
    let text = ctx.parsed.text();
    let mut out = vec![];
    fn go<'a>(node: Node<'a, 'a>, text: &str, out: &mut Vec<Rules>) {
        let (name, arguments) = match node {
            Node::MethodCall(c) => (&c.method, &c.argument_list),
            Node::StaticMethodCall(c) => (&c.method, &c.argument_list),
            Node::FunctionCall(c) => {
                if matches!(c.function, Expression::Identifier(id) if id.value().eq_ignore_ascii_case(b"validator")) {
                    out.extend(c.argument_list.arguments.iter().nth(1).and_then(|a| array_rules(text, a.value())));
                }
                node.visit_children(|child| go(child, text, out));
                return;
            }
            _ => {
                node.visit_children(|child| go(child, text, out));
                return;
            }
        };
        if let ClassLikeMemberSelector::Identifier(id) = name {
            let index = match id.value.to_ascii_lowercase().as_slice() {
                // `$request->validate([...])`, or a controller's `$this->validate($request, [...])`.
                b"validate" => Some(if matches!(arguments.arguments.first().map(Argument::value), Some(Expression::Array(_) | Expression::LegacyArray(_))) { 0 } else { 1 }),
                b"validatewithbag" | b"make" => Some(1),
                _ => None,
            };
            out.extend(index.and_then(|i| arguments.arguments.iter().nth(i)).and_then(|a| array_rules(text, a.value())));
        }
        node.visit_children(|child| go(child, text, out));
    }
    go(*scope, text, &mut out);
    out
}

/// Each field as a completion, in the rules' order.
fn field_items(rules: &[&Rules], range: Range) -> Vec<CompletionItem> {
    let mut seen = std::collections::HashSet::new();
    let mut out = vec![];
    for (i, f) in rules.iter().flat_map(|r| &r.fields).enumerate() {
        if !seen.insert(f.key.clone()) {
            continue;
        }
        let mut item = completion_item(&f.key, Some(CompletionItemKind::FIELD), range);
        item.detail = Some(f.rules.join("|"));
        item.sort_text = Some(format!("{i:04}"));
        out.push(item);
    }
    out
}

/// Completion for strings that name input keys, and for the tables and columns of rules.
pub fn string_completion(ctx: &Ctx<'_>, arg: &StringArg, offset: u32) -> Option<Vec<CompletionItem>> {
    if let Some(items) = rule_object_completion(ctx, arg, offset) {
        return Some(items);
    }
    // `Rule::in([...])` beside the key's `Rule::enum(X::class)`.
    if arg.call.kind == CallKind::Static && arg.call.is_method(&["in", "notIn"]) && arg.call.on(&ctx.index.codebase, &["Illuminate\\Validation\\Rule"]) {
        let range = replacement(ctx, arg.start, offset);
        return Some(field_enum(ctx, arg.start).map(|e| enum_items(ctx, &e, range)).unwrap_or_default());
    }
    let range = replacement(ctx, arg.start, offset);
    match source_of(ctx, arg)? {
        Source::Class { found, .. } => Some(field_items(&[&found.rules], range)),
        Source::Local(rules) => Some(field_items(&rules.iter().collect::<Vec<_>>(), range)),
    }
}

/// The members `$request->` offers for a form request's rules, which Laravel reads as input: each top-level key
/// that's a PHP name, unless the class has a member of that name.
pub fn member_items(ctx: &Ctx<'_>, classes: &[String], taken: &dyn Fn(&str) -> bool, range: Range) -> Vec<CompletionItem> {
    let codebase = &ctx.index.codebase;
    let by_class = by_class(&ctx.index);
    let Some(found) = classes.iter().filter(|c| codebase.is_instance_of(c.as_bytes(), FORM_REQUEST.as_bytes())).find_map(|c| class_rules(codebase, &by_class, c)) else { return vec![] };
    let mut seen = std::collections::HashSet::new();
    let mut out = vec![];
    for f in &found.rules.fields {
        let top = f.key.split('.').next().unwrap_or_default();
        let name = !top.is_empty() && !top.starts_with(|c: char| c.is_ascii_digit()) && top.chars().all(|c| c.is_alphanumeric() || c == '_');
        if !name || taken(top) || !seen.insert(top.to_string()) {
            continue;
        }
        let mut item = completion_item(top, Some(CompletionItemKind::FIELD), range);
        let rules: Vec<String> = found.rules.covering(top).iter().filter(|f| f.key == top).map(|f| f.rules.join("|")).collect();
        item.detail = Some(if rules.is_empty() { "input".to_string() } else { format!("input: {}", rules.join(", ")) });
        out.push(item);
    }
    out
}

/// The Markdown that describes the fields covering `key`, with a link to where the rules are.
fn fields_hover(ctx: &Ctx<'_>, found: Option<&Found>, rules: &Rules, key: &str) -> Option<String> {
    let mut fields = rules.covering(key);
    if fields.is_empty() {
        return None;
    }
    fields.sort_by_key(|f| f.key != key);
    let mut lines: Vec<String> = fields.iter().map(|f| format!("`{}`: `{}`", f.key, f.rules.join("|"))).collect();
    if let Some(found) = found
        && let Some(path) = ctx.index.path_of(found.file)
    {
        let line = ctx.snap.read(path).map(|t| t[..(fields[0].span.0 as usize).min(t.len())].matches('\n').count() as u32 + 1);
        lines.push(link(path, line, &found.class));
    }
    Some(lines.join("\n\n"))
}

pub fn hover(ctx: &Ctx<'_>, data: &Data<'_>, arg: &StringArg, offset: u32) -> Option<String> {
    if let Some(text) = rule_hover(ctx, data, arg, offset) {
        return Some(text);
    }
    match source_of(ctx, arg)? {
        Source::Class { found, .. } => fields_hover(ctx, Some(&found), &found.rules, &arg.value),
        Source::Local(rules) => rules.iter().find_map(|r| fields_hover(ctx, None, r, &arg.value)),
    }
}

/// Where an input key's rule is: the key in the class's rules.
pub fn definition(ctx: &Ctx<'_>, arg: &StringArg) -> Option<Location> {
    let Source::Class { found, .. } = source_of(ctx, arg)? else { return None };
    let mut fields = found.rules.covering(&arg.value);
    fields.sort_by_key(|f| f.key != arg.value);
    let field = fields.first()?;
    let path = ctx.index.path_of(found.file)?;
    let text = ctx.snap.read(path)?;
    let doc = crate::documents::Document::new(crate::text::path_to_uri(path), path.to_path_buf(), "php".into(), 0, text);
    Some(Location { uri: crate::text::path_to_uri(path), range: doc.range(field.span.0, field.span.1) })
}

/// A validated input key the rules don't have, where every key is known.
pub fn problems(ctx: &Ctx<'_>, args: &[StringArg]) -> Vec<Diagnostic> {
    let mut out = vec![];
    for arg in args {
        let v = &arg.value;
        // Only validated input is checked; skipping the rest early spares reading the function for local rules.
        let validated = arg.call.is_method(&["validated"]) || arg.call.classes.iter().any(|c| c.eq_ignore_ascii_case(VALIDATED_INPUT));
        if !validated || v.is_empty() || (arg.double_quoted && v.contains('$')) {
            continue;
        }
        let Some(Source::Class { found, checked: true }) = source_of(ctx, arg) else { continue };
        if !found.sure || !found.rules.covering(v).is_empty() {
            continue;
        }
        out.push(warning(ctx, arg.start, arg.end, "validation", format!("Validated input [{v}] not found in the rules of {}.", found.class)));
    }
    out
}

fn warning(ctx: &Ctx<'_>, start: u32, end: u32, code: &str, message: String) -> Diagnostic {
    Diagnostic {
        range: ctx.doc.range(start, end),
        severity: Some(DiagnosticSeverity::WARNING),
        code: Some(NumberOrString::String(code.into())),
        source: Some(SOURCE.into()),
        message,
        ..Default::default()
    }
}

// Tables and columns in rules.

/// The table, and possibly column, a rule names, with each one's span in the file.
#[derive(Debug, Clone, PartialEq)]
struct TableRef {
    table: Option<(String, (u32, u32))>,
    /// The model class a table is given as, as in `exists:App\Models\User,id` or `Rule::exists(User::class)`.
    model: Option<String>,
    column: Option<(String, (u32, u32))>,
}

/// The `exists:` and `unique:` rules in a rule string at `start`: `exists:table,column`, where the table may be a
/// model class or `connection.table`.
fn rule_string_refs(value: &str, start: u32) -> Vec<TableRef> {
    let mut out = vec![];
    let mut at = 0;
    for segment in value.split('|') {
        let lead = segment.len() - segment.trim_start().len();
        let rule = segment.trim_start();
        let name = rule.split(':').next().unwrap_or_default();
        if (name == "exists" || name == "unique") && rule.len() > name.len() {
            let params_start = at + lead + name.len() + 1;
            let mut params = rule[name.len() + 1..].splitn(3, ',');
            let span = |s: &str, from: usize| (start + from as u32, start + (from + s.len()) as u32);
            let table = params.next().unwrap_or_default();
            let column = params.next();
            out.push(TableRef {
                table: Some((table.trim().to_string(), span(table, params_start))),
                model: None,
                column: column.map(|c| (c.trim().to_string(), span(c, params_start + table.len() + 1))),
            });
        }
        at += segment.len() + 1;
    }
    out
}

/// A rule in a list nested in a rules array argument, as in `validate(['tags' => ['array', 'exists:tags,id']])`, which
/// [`string_args`](crate::framework::string_args) leaves out, as an element of the argument.
fn nested_rule_arg(ctx: &Ctx<'_>, path: &[Node<'_, '_>], literal: &mago_syntax::cst::LiteralString<'_>) -> Option<StringArg> {
    let (start, end) = (literal.span.start.offset + 1, literal.span.end.offset.saturating_sub(1).max(literal.span.start.offset + 1));
    let mut depth = 0;
    let mut i = path.len();
    while i > 0 {
        i -= 1;
        match &path[i] {
            Node::Expression(_) | Node::Literal(_) | Node::LiteralString(_) | Node::ArrayElement(_) | Node::Array(_) | Node::LegacyArray(_) => {}
            Node::ValueArrayElement(_) => depth += 1,
            Node::KeyValueArrayElement(el) if el.key.span().start.offset != literal.span.start.offset => depth += 1,
            Node::PositionalArgument(_) | Node::NamedArgument(_) | Node::Argument(_) => {}
            Node::ArgumentList(l) if depth >= 2 => {
                let call_node = path[..i].iter().rev().find(|n| matches!(n, Node::FunctionCall(_) | Node::MethodCall(_) | Node::NullSafeMethodCall(_) | Node::StaticMethodCall(_)))?;
                let call = crate::framework::call_of(ctx, call_node, &path[..i])?;
                let arg_start = path.get(i + 1)?.span().start.offset;
                let index = l.arguments.iter().take_while(|a| a.span().start.offset < arg_start).count();
                let value = ctx.parsed.text().get(start as usize..end as usize)?.to_string();
                let double_quoted = literal.kind == mago_syntax::cst::LiteralStringKind::DoubleQuoted;
                return Some(StringArg { value, start, end, double_quoted, call, index, name: None, in_array: Some(InArray::Value(None)) });
            }
            _ => return None,
        }
    }
    None
}

/// The rule string at `offset` in a list nested in a rules array argument.
fn nested_rule_at(ctx: &Ctx<'_>, offset: u32) -> Option<StringArg> {
    let path = ctx.parsed.path_at(offset);
    let (i, literal) = path.iter().enumerate().rev().find_map(|(i, n)| match n {
        Node::LiteralString(s) if s.span.start.offset < offset && offset < s.span.end.offset => Some((i, *s)),
        _ => None,
    })?;
    nested_rule_arg(ctx, &path[..=i], literal).filter(|a| super::is_validation(a, &ctx.index.codebase))
}

/// Completion in a rule list nested in a rules array argument.
pub fn nested_rule_completion(ctx: &Ctx<'_>, offset: u32) -> Option<Vec<CompletionItem>> {
    let arg = nested_rule_at(ctx, offset)?;
    Some(rule_completion(ctx, arg.start, offset))
}

/// Whether a string is in a rules array or rule string: passed to `validate()`, `Validator::make()`, or Livewire's
/// `#[Validate]`, or returned by a form request's or Livewire class's `rules()`.
fn in_rules(ctx: &Ctx<'_>, path: &[Node<'_, '_>], literal_start: u32) -> bool {
    // Not a key, and directly a value or an element of a list of rules.
    let mut i = path.len();
    while i > 0 {
        i -= 1;
        match &path[i] {
            Node::Expression(_) | Node::Literal(_) | Node::LiteralString(_) | Node::ArrayElement(_) | Node::Array(_) | Node::LegacyArray(_) | Node::ValueArrayElement(_) => {}
            Node::KeyValueArrayElement(el) => {
                if el.key.span().start.offset == literal_start {
                    return false;
                }
            }
            Node::Return(_) => break,
            _ => return false,
        }
    }
    let Some(method) = path.iter().rev().find_map(|n| match n {
        Node::Method(m) => Some(m),
        _ => None,
    }) else {
        return false;
    };
    if !method.name.value.eq_ignore_ascii_case(b"rules") || path.iter().any(|n| matches!(n, Node::Closure(_) | Node::ArrowFunction(_))) {
        return false;
    }
    let Some(class) = ctx.resolver().enclosing_class(path) else { return false };
    let codebase = &ctx.index.codebase;
    [FORM_REQUEST, LIVEWIRE_FORM, LIVEWIRE_COMPONENT].iter().any(|p| codebase.is_instance_of(class.as_bytes(), p.as_bytes()))
}

/// The rule strings and rule objects in the file that name tables, with what they name.
fn table_refs(ctx: &Ctx<'_>, args: &[StringArg]) -> Vec<TableRef> {
    let codebase = &ctx.index.codebase;
    let mut out = vec![];
    for arg in args {
        if super::is_validation(arg, codebase) {
            out.extend(rule_string_refs(&arg.value, arg.start));
        } else if let Some(r) = rule_object_ref(arg, codebase) {
            out.push(r);
        }
    }
    crate::locate::walk(&ctx.parsed, |node, ancestors| {
        let Node::LiteralString(s) = node else { return };
        let mut path = ancestors.to_vec();
        path.push(node);
        if in_rules(ctx, &path, s.span.start.offset)
            && let Some(value) = s.value
        {
            out.extend(rule_string_refs(&String::from_utf8_lossy(value), s.span.start.offset + 1));
        } else if let Some(arg) = nested_rule_arg(ctx, &path, s).filter(|a| super::is_validation(a, codebase)) {
            out.extend(rule_string_refs(&arg.value, arg.start));
        }
    });
    out
}

/// `Rule::exists('table', 'column')`, `Rule::unique(...)`, and `new Exists(...)` or `new Unique(...)`: the table
/// or column a string argument of one names.
fn rule_object_ref(arg: &StringArg, codebase: &mago_codex::metadata::CodebaseMetadata) -> Option<TableRef> {
    let rule = ["Illuminate\\Validation\\Rule", "Rule"];
    let on = |classes: &[&str]| arg.call.on(codebase, classes);
    let is = match arg.call.kind {
        CallKind::Static => arg.call.is_method(&["exists", "unique"]) && on(&rule),
        CallKind::New => on(&["Illuminate\\Validation\\Rules\\Exists", "Illuminate\\Validation\\Rules\\Unique"]),
        _ => false,
    };
    if !is || arg.in_array.is_some() || arg.index > 1 {
        return None;
    }
    let span = (arg.start, arg.end);
    if arg.index == 0 {
        return Some(TableRef { table: Some((arg.value.clone(), span)), model: None, column: None });
    }
    let table = arg.call.arguments.first().and_then(|a| a.1.clone());
    let model = arg.call.argument_classes.first().and_then(|c| c.first().cloned());
    Some(TableRef { table: table.map(|t| (t, (0, 0))), model, column: Some((arg.value.clone(), span)) })
}

/// The table a reference names: a model's, by its class, or the table as written. `None` for a model or a
/// `connection.table` the data can't place.
fn table_of(tables: &Value, r: &TableRef) -> Option<String> {
    let model = r.model.clone().or_else(|| r.table.as_ref().map(|t| t.0.clone()).filter(|t| t.contains('\\')));
    if let Some(class) = model {
        let class = class.trim_start_matches('\\');
        return tables["models"].as_object()?.iter().find(|(k, _)| k.eq_ignore_ascii_case(class)).and_then(|(_, t)| t.as_str().map(String::from));
    }
    let name = r.table.as_ref()?.0.clone();
    (!name.contains('.') && !name.is_empty()).then_some(name)
}

/// A table's columns, matching its name without case.
fn columns<'v>(tables: &'v Value, table: &str) -> Option<&'v Vec<Value>> {
    tables["tables"].as_object()?.iter().find(|(k, _)| k.eq_ignore_ascii_case(table)).and_then(|(_, c)| c.as_array())
}

fn table_items(tables: &Value, range: Range) -> Vec<CompletionItem> {
    let Some(all) = tables["tables"].as_object() else { return vec![] };
    all.iter()
        .map(|(name, cols)| {
            let mut item = completion_item(name, Some(CompletionItemKind::CLASS), range);
            item.detail = Some(format!("{} columns", cols.as_array().map_or(0, Vec::len)));
            item
        })
        .collect()
}

fn column_items(tables: &Value, table: &str, range: Range) -> Vec<CompletionItem> {
    columns(tables, table)
        .into_iter()
        .flatten()
        .filter_map(|c| c.as_str())
        .enumerate()
        .map(|(i, c)| {
            let mut item = completion_item(c, Some(CompletionItemKind::FIELD), range);
            item.detail = Some(format!("column of {table}"));
            item.sort_text = Some(format!("{i:04}"));
            item
        })
        .collect()
}

fn tables_of(ctx: &Ctx<'_>) -> Option<Arc<Value>> {
    super::data::tables(&ctx.snap.framework)
}

/// Completion in a rule string or list, at `offset` in a string whose contents start at `start`: tables after
/// `exists:` and `unique:` and their columns after the comma, and otherwise the rules.
pub fn rule_completion(ctx: &Ctx<'_>, start: u32, offset: u32) -> Vec<CompletionItem> {
    let typed = ctx.doc.text.get(start as usize..offset as usize).unwrap_or_default();
    let segment = typed.rsplit('|').next().unwrap_or_default().trim_start();
    let name = segment.split(':').next().unwrap_or_default();
    if (name == "exists" || name == "unique") && segment.len() > name.len()
        && let Some(tables) = tables_of(ctx)
    {
        let params = &segment[name.len() + 1..];
        let current = params.rsplit(',').next().unwrap_or_default();
        let range = ctx.doc.range(offset - current.len() as u32, offset);
        return match params.matches(',').count() {
            0 => table_items(&tables, range),
            1 => {
                let r = TableRef { table: params.split(',').next().map(|t| (t.trim().to_string(), (0, 0))), model: None, column: None };
                table_of(&tables, &r).map(|t| column_items(&tables, &t, range)).unwrap_or_default()
            }
            _ => vec![],
        };
    }
    if (name == "in" || name == "not_in") && segment.len() > name.len() {
        let current = segment.rsplit([':', ',']).next().unwrap_or_default();
        let range = ctx.doc.range(offset - current.len() as u32, offset);
        return field_enum(ctx, start).map(|e| enum_items(ctx, &e, range)).unwrap_or_default();
    }
    rule_items(replacement(ctx, start, offset))
}

/// The enum a rules key's own rules name with `Rule::enum(X::class)` or `new Enum(X::class)`, for the key whose
/// rules hold `at`.
fn field_enum(ctx: &Ctx<'_>, at: u32) -> Option<String> {
    let path = ctx.parsed.path_at(at);
    let element = path.iter().rev().find_map(|n| match n {
        Node::KeyValueArrayElement(el) => Some(*el),
        _ => None,
    })?;
    let codebase = &ctx.index.codebase;
    let resolver = ctx.resolver();
    elements(element.value)?.iter().find_map(|el| {
        let ArrayElement::Value(v) = el else { return None };
        let (class, arguments) = match v.value {
            Expression::Call(mago_syntax::cst::Call::StaticMethod(c)) if matches!(&c.method, ClassLikeMemberSelector::Identifier(id) if id.value.eq_ignore_ascii_case(b"enum")) => {
                let classes = resolver.classes_of_class_expr(c.class, &path);
                (classes.iter().any(|c| c.eq_ignore_ascii_case("Illuminate\\Validation\\Rule")).then_some(()), &c.argument_list)
            }
            Expression::Instantiation(i) => {
                let classes = resolver.classes_of_class_expr(i.class, &path);
                (classes.iter().any(|c| c.eq_ignore_ascii_case("Illuminate\\Validation\\Rules\\Enum")).then_some(()), i.argument_list.as_ref()?)
            }
            _ => return None,
        };
        class?;
        let Expression::Access(mago_syntax::cst::Access::ClassConstant(a)) = arguments.arguments.first()?.value() else { return None };
        resolver.classes_of_class_expr(a.class, &path).into_iter().find(|c| codebase.get_enum(c.as_bytes()).is_some())
    })
}

/// A backed enum's values, which `in:` and `Rule::in()` take.
fn enum_items(ctx: &Ctx<'_>, class: &str, range: Range) -> Vec<CompletionItem> {
    let cases = crate::framework::filament::enum_cases(ctx, class).unwrap_or_default();
    cases
        .into_iter()
        .filter_map(|(name, value)| {
            let mut item = completion_item(&value?, Some(CompletionItemKind::ENUM_MEMBER), range);
            item.detail = Some(format!("{}::{name}", class.rsplit('\\').next().unwrap_or(class)));
            Some(item)
        })
        .collect()
}

/// Enums for `Rule::enum(` and `new Enum(`, as `X::class`.
pub fn enum_class_completion(ctx: &Ctx<'_>, offset: u32) -> Option<Vec<CompletionItem>> {
    let path = ctx.parsed.path_at(offset);
    let (i, list) = path.iter().enumerate().rev().find_map(|(i, n)| match n {
        Node::ArgumentList(l) => Some((i, *l)),
        _ => None,
    })?;
    // In the first argument, or an empty list.
    if list.arguments.iter().next().is_some_and(|a| offset > a.span().end.offset) {
        return None;
    }
    let call_node = path[..i].iter().rev().find(|n| matches!(n, Node::StaticMethodCall(_) | Node::Instantiation(_)))?;
    let call = crate::framework::call_of(ctx, call_node, &path[..i])?;
    let codebase = &ctx.index.codebase;
    let is = match call.kind {
        CallKind::Static => call.is_method(&["enum"]) && call.on(codebase, &["Illuminate\\Validation\\Rule"]),
        CallKind::New => call.on(codebase, &["Illuminate\\Validation\\Rules\\Enum"]),
        _ => false,
    };
    if !is {
        return None;
    }
    let before = &ctx.doc.text[..offset as usize];
    let typed = before.chars().rev().take_while(|c| c.is_alphanumeric() || matches!(c, '_' | '\\' | ':')).map(char::len_utf8).sum::<usize>();
    let range = ctx.doc.range(offset - typed as u32, offset);
    let root = ctx.snap.framework.root().to_path_buf();
    let mut items: Vec<CompletionItem> = codebase
        .class_likes
        .values()
        .filter(|c| c.kind == mago_codex::symbol::SymbolKind::Enum)
        .filter(|c| ctx.index.path_of(c.span.file_id).is_some_and(|p| p.starts_with(&root)))
        .map(|c| {
            let fqn = c.original_name.as_str_lossy().into_owned();
            let text = format!("{}::class", crate::framework::filament::class_reference(ctx, offset, &fqn));
            let mut item = completion_item(&text, Some(CompletionItemKind::ENUM), range);
            item.detail = Some(fqn);
            item
        })
        .collect();
    items.sort_by(|a, b| a.label.cmp(&b.label));
    (!items.is_empty()).then_some(items)
}

/// Completion for `Rule::exists('…', '…')` and the like: the tables, then the table's columns.
fn rule_object_completion(ctx: &Ctx<'_>, arg: &StringArg, offset: u32) -> Option<Vec<CompletionItem>> {
    let r = rule_object_ref(arg, &ctx.index.codebase)?;
    let tables = tables_of(ctx)?;
    let range = replacement(ctx, arg.start, offset);
    Some(match &r.column {
        None => table_items(&tables, range),
        Some(_) => column_items(&tables, &table_of(&tables, &r)?, range),
    })
}

/// The table or column a rule names under the cursor, with the table's columns.
fn rule_hover(ctx: &Ctx<'_>, _data: &Data<'_>, arg: &StringArg, offset: u32) -> Option<String> {
    let codebase = &ctx.index.codebase;
    let refs = if super::is_validation(arg, codebase) { rule_string_refs(&arg.value, arg.start) } else { vec![rule_object_ref(arg, codebase)?] };
    let tables = tables_of(ctx)?;
    let inside = |span: &(u32, u32)| span.0 <= offset && offset <= span.1;
    let r = refs.iter().find(|r| r.table.as_ref().is_some_and(|t| inside(&t.1)) || r.column.as_ref().is_some_and(|c| inside(&c.1)))?;
    let table = table_of(&tables, r)?;
    let list: Vec<String> = columns(&tables, &table)?.iter().filter_map(|c| c.as_str()).map(|c| format!("`{c}`")).collect();
    let guessed = if tables["live"] == true { "" } else { "\n\nFrom the model; the database couldn't be read." };
    Some(format!("Table `{table}`: {}{guessed}", list.join(", ")))
}

/// Hover for a rule string in a `rules()` method, which isn't a call's argument.
pub fn rules_method_hover(ctx: &Ctx<'_>, offset: u32) -> Option<(String, Range)> {
    let path = ctx.parsed.path_at(offset);
    let (i, s) = path.iter().enumerate().rev().find_map(|(i, n)| match n {
        Node::LiteralString(s) if s.span.start.offset < offset && offset < s.span.end.offset => Some((i, *s)),
        _ => None,
    })?;
    if !in_rules(ctx, &path[..=i], s.span.start.offset) && nested_rule_at(ctx, offset).is_none() {
        return None;
    }
    let tables = tables_of(ctx)?;
    let r = rule_string_refs(&String::from_utf8_lossy(s.value?), s.span.start.offset + 1)
        .into_iter()
        .find(|r| r.table.as_ref().is_some_and(|t| t.1.0 <= offset && offset <= t.1.1) || r.column.as_ref().is_some_and(|c| c.1.0 <= offset && offset <= c.1.1))?;
    let table = table_of(&tables, &r)?;
    let list: Vec<String> = columns(&tables, &table)?.iter().filter_map(|c| c.as_str()).map(|c| format!("`{c}`")).collect();
    let span = r.table.as_ref()?.1;
    Some((format!("Table `{table}`: {}", list.join(", ")), ctx.doc.range(span.0, span.1)))
}

/// Tables and columns the rules name that the database doesn't have. Only when the tables were read from the
/// database: the models' guesses leave tables and columns out.
pub fn table_problems(ctx: &Ctx<'_>, args: &[StringArg]) -> Vec<Diagnostic> {
    let Some(tables) = tables_of(ctx).filter(|t| t["live"] == true) else { return vec![] };
    let mut out = vec![];
    for r in table_refs(ctx, args) {
        let Some(table) = table_of(&tables, &r) else { continue };
        // A model's table that isn't in the database is the model's problem, not the rule's.
        let written = r.model.is_none() && !r.table.as_ref().is_some_and(|t| t.0.contains('\\'));
        let Some(cols) = columns(&tables, &table) else {
            if written && let Some((name, span)) = &r.table && span.1 > span.0 {
                out.push(warning(ctx, span.0, span.1, "table", format!("Table [{name}] not found.")));
            }
            continue;
        };
        if let Some((column, span)) = &r.column
            && !column.is_empty()
            && !column.eq_ignore_ascii_case("NULL")
            && !cols.iter().any(|c| c.as_str().is_some_and(|c| c.eq_ignore_ascii_case(column)))
        {
            out.push(warning(ctx, span.0, span.1, "column", format!("Column [{column}] not found on table [{table}].")));
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

    /// Laravel's request, validator, and rule classes, and Livewire's, as they declare the methods here.
    const STUBS: &str = r#"<?php
namespace Illuminate\Http { /** @method array validate(array $rules, ...$params) */ class Request { public function input($key = null, $default = null) {} public function only($keys) {} public function has($key) {} public function routeIs(...$p) {} } }
namespace Illuminate\Support { class ValidatedInput { public function only($keys) {} public function input($key, $default = null) {} } }
namespace Illuminate\Foundation\Http { class FormRequest extends \Illuminate\Http\Request {
    /** @return mixed */
    public function validated($key = null, $default = null) {}
    public function safe(?array $keys = null): \Illuminate\Support\ValidatedInput {}
} }
namespace Illuminate\Validation { class Rule { public static function exists($table, $column = 'NULL') {} public static function unique($table, $column = 'NULL') {} } class Validator { /** @return array */ public function validate() {} } }
namespace Illuminate\Validation\Rules { class Exists { public function __construct($table, $column = 'NULL') {} } }
namespace Illuminate\Support\Facades { class Validator { public static function make(array $data, array $rules): \Illuminate\Validation\Validator {} } }
namespace Livewire { abstract class Component { public function validate($rules = null) {} public function validateOnly($field) {} } abstract class Form { public function validate($rules = null) {} } }
namespace Livewire\Attributes { #[\Attribute] class Validate { public function __construct($rule = null, $attribute = null, $as = null) {} } }
namespace App\Models { class User {} }
"#;

    const STORE_POST: &str = "<?php\nnamespace App\\Http\\Requests;\nuse Illuminate\\Foundation\\Http\\FormRequest;\nclass StorePost extends FormRequest {\n    public function rules(): array {\n        return [\n            'title' => 'required|string|max:255',\n            'tags' => ['nullable', 'array'],\n            'tags.*' => 'string|exists:tags,name',\n            'author.name' => 'required|string',\n        ];\n    }\n}\n";

    fn fixture(file: &str, text: &str) -> Fixture {
        let fx = Fixture::new(&[("stubs.php", STUBS), ("app/Http/Requests/StorePost.php", STORE_POST), (file, text)]);
        fx.snap.framework.seed("laravel:active", json!(true));
        fx.snap.framework.seed("laravel:tables", json!({"live": true, "tables": {"users": ["id", "email"], "tags": ["id", "name"]}, "models": {"App\\Models\\User": "users"}}));
        fx
    }

    fn complete(text: &str) -> Vec<String> {
        let fx = fixture("app/t.php", text);
        let at = fx.at();
        let items = with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| crate::framework::completion(ctx, ctx.offset(at.position))).flatten().unwrap_or_default();
        items.into_iter().map(|i| i.label).collect()
    }

    fn problems(text: &str) -> Vec<String> {
        let fx = fixture("app/t.php", text);
        with_ctx(&fx.snap, &uri("app/t.php"), crate::framework::laravel::diagnostics).unwrap().into_iter().map(|d| d.message).collect()
    }

    fn controller(body: &str) -> String {
        format!("<?php\nuse App\\Http\\Requests\\StorePost;\nuse Illuminate\\Http\\Request;\nuse Illuminate\\Validation\\Rule;\nclass PostController {{\n    public function store(StorePost $request, Request $plain) {{\n        {body}\n    }}\n}}\n")
    }

    #[test]
    fn reads_the_rules_classes_declare() {
        let fx = fixture("app/t.php", "<?php\n");
        let index = fx.snap.index.read();
        let found = class_rules(&index.codebase, &by_class(&index), "App\\Http\\Requests\\StorePost").unwrap();
        let keys: Vec<&str> = found.rules.fields.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(keys, ["title", "tags", "tags.*", "author.name"]);
        assert_eq!(found.rules.fields[1].rules, ["nullable", "array"]);
        assert!(found.sure);
        // Merged rules are read but not all known; a rules variable gets the keys it's given.
        let partial = "<?php\nclass A extends \\Illuminate\\Foundation\\Http\\FormRequest {\n    public function rules(): array { $r = ['a' => 'string']; $r['b'] = 'int'; return $r; }\n}\nclass B extends A {\n    public function rules(): array { return array_merge(parent::rules(), ['c' => 'string']); }\n}\nclass C extends A { public function withValidator($v) {} }\n";
        let fx = fixture("app/t.php", partial);
        let index = fx.snap.index.read();
        let by = by_class(&index);
        let keys = |class: &str| class_rules(&index.codebase, &by, class).map(|f| (f.rules.fields.iter().map(|f| f.key.clone()).collect::<Vec<_>>(), f.sure));
        assert_eq!(keys("A"), Some((vec!["a".into(), "b".into()], false)));
        assert_eq!(keys("B"), Some((vec!["c".into()], false)));
        // A subclass gets its parent's rules, but changes to its validator make them unsure.
        assert_eq!(keys("C"), Some((vec!["a".into(), "b".into()], false)));
    }

    #[test]
    fn completes_input_keys_from_the_rules() {
        let all = ["title", "tags", "tags.*", "author.name"];
        assert_eq!(complete(&controller("$request->validated('<|>');")), all);
        assert_eq!(complete(&controller("$request->input('<|>');")), all);
        assert_eq!(complete(&controller("$request->safe()->only(['title', '<|>']);")), all);
        assert_eq!(complete(&controller("$request->has('title', '<|>');")), all);
        // A plain request gets the keys of a `validate()` in the same method.
        assert_eq!(complete(&controller("$plain->validate(['email' => 'required|email']); $plain->input('<|>');")), ["email"]);
        assert!(complete(&controller("$plain->input('<|>');")).is_empty());
        // Inside the form request, `$this` is the request.
        let inside = STORE_POST.replace("return [", "$this->input('<|>');\n        return [");
        let fx = Fixture::new(&[("stubs.php", STUBS), ("app/Http/Requests/StorePost.php", &inside)]);
        fx.snap.framework.seed("laravel:active", json!(true));
        let at = fx.at();
        let items = with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| crate::framework::completion(ctx, ctx.offset(at.position))).flatten().unwrap();
        assert_eq!(items.len(), 4);
    }

    #[test]
    fn checks_only_validated_keys_when_every_key_is_known() {
        let found = problems(&controller("$request->validated('title'); $request->validated('tags.0'); $request->validated('author'); $request->validated('nope'); $request->safe()->only(['author.name', 'missing']); $request->input('anything'); $plain->validate(['a' => 'string']); $plain->input('b');"));
        assert_eq!(found, ["Validated input [nope] not found in the rules of App\\Http\\Requests\\StorePost.", "Validated input [missing] not found in the rules of App\\Http\\Requests\\StorePost."]);
        // Rules not all known, or a validator the class changes, check nothing.
        let merged = "<?php\nclass A extends \\Illuminate\\Foundation\\Http\\FormRequest {\n    public function rules(): array { return [...parent::rules(), 'a' => 'string']; }\n}\nclass B extends \\Illuminate\\Foundation\\Http\\FormRequest {\n    public function rules(): array { return ['a' => 'string']; }\n    public function withValidator($v) {}\n}\nfunction f(A $a, B $b) { $a->validated('x'); $b->validated('x'); }\n";
        assert!(problems(merged).is_empty());
    }

    #[test]
    fn shows_and_goes_to_a_keys_rules() {
        let text = controller("$request->validated('title');");
        let fx = fixture("app/t.php", &text);
        let at = text.find("'title'").unwrap() as u32 + 2;
        let hover = with_ctx(&fx.snap, &uri("app/t.php"), |ctx| crate::framework::hover(ctx, at)).flatten().unwrap();
        let lsp_types::HoverContents::Markup(m) = hover.contents else { panic!() };
        assert!(m.value.starts_with("`title`: `required|string|max:255`"), "{}", m.value);
        let found = with_ctx(&fx.snap, &uri("app/t.php"), |ctx| crate::framework::definition(ctx, at)).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].range.start, lsp_types::Position::new(6, 13));
    }

    #[test]
    fn offers_a_form_requests_input_as_members() {
        let text = controller("$request-><|>");
        let fx = fixture("app/t.php", &text);
        let items = crate::features::completion::completion(&fx.snap, lsp_types::CompletionParams {
            text_document_position: fx.at(),
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
            context: None,
        })
        .unwrap();
        let Some(lsp_types::CompletionResponse::List(list)) = items else { panic!() };
        let labels: Vec<&str> = list.items.iter().map(|i| i.label.as_str()).collect();
        assert!(labels.contains(&"title") && labels.contains(&"author") && labels.contains(&"validated"), "{labels:?}");
        assert!(!labels.contains(&"tags.*"));
    }

    fn type_of(text: &str, expr: &str) -> String {
        let fx = fixture("app/t.php", text);
        let start = text.find(expr).unwrap() as u32;
        with_ctx(&fx.snap, &uri("app/t.php"), |ctx| {
            use mago_codex::ttype::TType;
            ctx.analysis().type_of(start, start + expr.len() as u32).map(|t| t.get_id().to_string()).unwrap_or_default()
        })
        .unwrap()
    }

    #[test]
    fn types_validated_data_from_the_rules() {
        let text = controller("$a = $request->validated(); $b = $request->validated('title'); $c = $plain->validate(['n' => 'required|integer:strict']); $d = \\Illuminate\\Support\\Facades\\Validator::make([], ['n' => 'nullable|string'])->validate(); $e = $request->validated('tags');");
        assert_eq!(
            type_of(&text, "$request->validated()"),
            "array{'author': array{'name': non-empty-string, ...}, 'tags'?: array<array-key, string>|null|string, 'title': non-empty-string, ...}"
        );
        assert_eq!(type_of(&text, "$request->validated('title')"), "non-empty-string");
        assert_eq!(type_of(&text, "$request->validated('tags')"), "array<array-key, string>|null|string");
        assert_eq!(type_of(&text, "$plain->validate(['n' => 'required|integer:strict'])"), "array{'n': int, ...}");
        assert_eq!(type_of(&text, "\\Illuminate\\Support\\Facades\\Validator::make([], ['n' => 'nullable|string'])->validate()"), "array{'n'?: null|string, ...}");
        // Rules not all known keep Laravel's type.
        let text = controller("$x = $plain->validate($rules);");
        assert_eq!(type_of(&text, "$plain->validate($rules)"), "array<array-key, mixed>");
    }

    #[test]
    fn livewire_rules_complete_and_type() {
        let component = "<?php\nuse Livewire\\Attributes\\Validate;\nclass Edit extends \\Livewire\\Component {\n    #[Validate('required|min:3')]\n    public $title = '';\n    #[Validate(['tags.*' => 'required|string'])]\n    public $tags = [];\n    public function save() { $data = $this->validate(); $this->validateOnly(''); }\n}\n";
        assert_eq!(type_of(component, "$this->validate()"), "array{'tags'?: array<array-key, non-empty-string>, 'title': mixed, ...}");
        assert!(complete(&component.replace("'required|min:3'", "'required|mi<|>'")).contains(&"min".to_string()));
        assert_eq!(complete(&component.replace("validateOnly('')", "validateOnly('<|>')")), ["title", "tags.*"]);
    }

    #[test]
    fn completes_and_checks_tables_and_columns() {
        assert!(complete(&controller("$plain->validate(['a' => 'required|exists:<|>']);")).contains(&"users".to_string()));
        assert_eq!(complete(&controller("$plain->validate(['a' => 'required|exists:users,<|>']);")), ["id", "email"]);
        assert_eq!(complete(&controller("$plain->validate(['a' => 'unique:App\\Models\\User,<|>']);")), ["id", "email"]);
        assert_eq!(complete(&controller("Rule::exists('users', '<|>');")), ["id", "email"]);
        // In a list of rules too.
        assert_eq!(complete(&controller("$plain->validate(['a' => ['required', 'exists:users,<|>']]);")), ["id", "email"]);
        assert!(complete(&controller("$plain->validate(['a' => ['required', 'ma<|>']]);")).contains(&"max".to_string()));
        assert_eq!(complete(&controller("Rule::unique(\\App\\Models\\User::class, '<|>');")), ["id", "email"]);
        assert!(complete(&controller("new \\Illuminate\\Validation\\Rules\\Exists('<|>');")).contains(&"tags".to_string()));
        let found = problems(&controller("$plain->validate(['a' => 'exists:userz,id', 'b' => 'unique:users,mail', 'c' => 'exists:users,email', 'd' => 'exists:mysql.other,id', 'e' => ['exists:users'], 'f' => ['required', 'exists:users,nom']]); Rule::exists('users', 'nope');"));
        assert_eq!(found, ["Table [userz] not found.", "Column [mail] not found on table [users].", "Column [nope] not found on table [users].", "Column [nom] not found on table [users]."]);
        // In a form request's rules too.
        let rules = STORE_POST.replace("exists:tags,name", "exists:tags,nom");
        let fx = Fixture::new(&[("stubs.php", STUBS), ("app/Http/Requests/StorePost.php", &rules)]);
        fx.snap.framework.seed("laravel:active", json!(true));
        fx.snap.framework.seed("laravel:tables", json!({"live": true, "tables": {"tags": ["id", "name"]}, "models": {}}));
        let found: Vec<String> = with_ctx(&fx.snap, &uri("app/Http/Requests/StorePost.php"), crate::framework::laravel::diagnostics).unwrap().into_iter().map(|d| d.message).collect();
        assert_eq!(found, ["Column [nom] not found on table [tags]."]);
        // Tables guessed from the models check nothing.
        fx.snap.framework.seed("laravel:tables", json!({"live": false, "tables": {"tags": ["id"]}, "models": {}}));
        assert!(with_ctx(&fx.snap, &uri("app/Http/Requests/StorePost.php"), crate::framework::laravel::diagnostics).unwrap().is_empty());
    }

    #[test]
    fn completes_enums_and_their_values() {
        let status = "<?php\nnamespace App\\Enums;\nenum Status: string { case Draft = 'draft'; case Live = 'live'; }\n";
        let stubs = format!("{STUBS}\nnamespace Illuminate\\Validation {{ class Rule {{ public static function enum($type) {{}} public static function in($values) {{}} }} }}\nnamespace Illuminate\\Validation\\Rules {{ class Enum {{ public function __construct($type) {{}} }} }}\n").replace("class Rule { public static function exists", "class RuleX { public static function exists");
        let run = |body: &str| {
            let text = controller(body);
            let fx = Fixture::new(&[("stubs.php", stubs.as_str()), ("app/Enums/Status.php", status), ("app/Http/Requests/StorePost.php", STORE_POST), ("app/t.php", &text)]);
            fx.snap.framework.seed("laravel:active", json!(true));
            let at = fx.at();
            let items = with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| crate::framework::completion(ctx, ctx.offset(at.position))).flatten().unwrap_or_default();
            items.into_iter().map(|i| i.label).collect::<Vec<_>>()
        };
        assert_eq!(run("Rule::enum(<|>);"), ["\\App\\Enums\\Status::class"]);
        assert_eq!(run("new \\Illuminate\\Validation\\Rules\\Enum(<|>);"), ["\\App\\Enums\\Status::class"]);
        assert_eq!(run("$plain->validate(['s' => ['required', Rule::enum(\\App\\Enums\\Status::class), 'in:draft,<|>']]);"), ["draft", "live"]);
        assert_eq!(run("$plain->validate(['s' => [new \\Illuminate\\Validation\\Rules\\Enum(\\App\\Enums\\Status::class), Rule::in(['<|>'])]]);"), ["draft", "live"]);
        // Without an enum on the key, `in:` offers nothing.
        assert!(run("$plain->validate(['s' => 'in:<|>']);").is_empty());
    }

    #[test]
    fn shows_a_rules_table() {
        let fx = fixture("app/t.php", "<?php
");
        let at = STORE_POST.find("exists:tags").unwrap() as u32 + 8;
        let hover = with_ctx(&fx.snap, &uri("app/Http/Requests/StorePost.php"), |ctx| crate::framework::hover(ctx, at)).flatten().unwrap();
        let lsp_types::HoverContents::Markup(m) = hover.contents else { panic!() };
        assert_eq!(m.value, "Table `tags`: `id`, `name`");
    }

    /// Runs the validation features over every file of a real app and prints what they find: the key sites and
    /// the keys they get, the problems reported, and how the analyzer's problems change with validated data
    /// typed. Every problem should be real. `TUSK_LARAVEL_APP=<root> cargo test -- --ignored --nocapture
    /// validation_in_a_real_app`.
    #[test]
    #[ignore]
    fn validation_in_a_real_app() {
        use std::path::PathBuf;
        use crate::documents::{Document, Documents};
        use crate::index::IndexConfig;
        use crate::server::Snapshot;
        use crate::text::path_to_uri;
        let Ok(root) = std::env::var("TUSK_LARAVEL_APP") else { return };
        let root = PathBuf::from(root);
        crate::testing::on_server_stack(|| {
            let mut index = Index::empty(IndexConfig::new(&root));
            let paths = index.discover();
            index.build(paths, |p| std::fs::read(p).ok(), |_, _| {});
            let classes = index.validation.values().flatten().filter(|r| r.rules.is_some()).count();
            let sure = index.validation.values().flatten().filter(|r| r.rules.as_ref().is_some_and(|r| r.complete) && !r.custom).count();
            eprintln!("classes with rules: {classes}, every key known: {sure}");
            let index = Arc::new(parking_lot::RwLock::new(index));
            let framework = Arc::new(crate::framework::State::new(root.clone()));
            let started = std::time::Instant::now();
            let tables = loop {
                if let Some(t) = super::super::data::tables(&framework) {
                    break Some(t);
                }
                if started.elapsed() > std::time::Duration::from_secs(90) {
                    break None;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            };
            match &tables {
                Some(t) => eprintln!("tables: {} (live: {}), models: {}", t["tables"].as_object().map_or(0, |o| o.len()), t["live"], t["models"].as_object().map_or(0, |o| o.len())),
                None => eprintln!("tables: none"),
            }
            let files: Vec<PathBuf> = index.read().project_files().filter(|p| !p.starts_with(root.join("vendor"))).map(|p| p.to_path_buf()).collect();
            let (mut sites, mut keyed, mut reported, mut added, mut removed, mut refs) = (0, 0, 0, 0, 0, 0);
            for path in &files {
                let text = std::fs::read_to_string(path).unwrap_or_default();
                let mut docs = Documents::default();
                docs.insert(Document::new(path_to_uri(path), path.clone(), "php".into(), 1, text.clone()));
                let snap = Snapshot { docs, index: index.clone(), root: root.clone(), framework: framework.clone(), client: None, cancel: Default::default() };
                let uri = path_to_uri(path);
                let rel = path.strip_prefix(&root).unwrap().display().to_string();
                with_ctx(&snap, &uri, |ctx| {
                    let args = crate::framework::string_args(ctx);
                    for arg in &args {
                        if let Some(source) = source_of(ctx, arg) {
                            sites += 1;
                            let has = match &source {
                                Source::Class { found, .. } => !found.rules.covering(&arg.value).is_empty(),
                                Source::Local(rules) => rules.iter().any(|r| !r.covering(&arg.value).is_empty()),
                            };
                            keyed += usize::from(has);
                            if !has {
                                eprintln!("no rule {rel}:{} {}('{}')", ctx.doc.position(arg.start).line + 1, arg.call.name, arg.value);
                            }
                        }
                    }
                    refs += table_refs(ctx, &args).len();
                    crate::locate::walk(&ctx.parsed, |node, _| {
                        let Node::MethodCall(c) = node else { return };
                        if !matches!(&c.method, ClassLikeMemberSelector::Identifier(id) if id.value.starts_with(b"validate")) {
                            return;
                        }
                        let span = node.span();
                        if let Some(t) = ctx.analysis().type_of(span.start.offset, span.end.offset) {
                            use mago_codex::ttype::TType;
                            eprintln!("type {rel}:{} {}", ctx.doc.position(span.start.offset).line + 1, t.get_id());
                        }
                    });
                    for d in crate::framework::laravel::diagnostics(ctx) {
                        if matches!(&d.code, Some(NumberOrString::String(c)) if ["validation", "table", "column"].contains(&c.as_str())) {
                            reported += 1;
                            eprintln!("problem {rel}:{} {}", d.range.start.line + 1, d.message);
                        }
                    }
                });
                if text.contains("validate") {
                    let doc = Document::new(uri.clone(), path.clone(), "php".into(), 1, text);
                    let key = |d: &Diagnostic| format!("{}: {}", d.range.start.line + 1, d.message.lines().next().unwrap_or_default());
                    let on: Vec<String> = crate::diagnostics::php_problems(&index, &doc).iter().map(key).collect();
                    super::super::validated::OFF.set(true);
                    let off: Vec<String> = crate::diagnostics::php_problems(&index, &doc).iter().map(key).collect();
                    super::super::validated::OFF.set(false);
                    for d in on.iter().filter(|d| !off.contains(d)) {
                        added += 1;
                        eprintln!("mago added {rel}:{d}");
                    }
                    for d in off.iter().filter(|d| !on.contains(d)) {
                        removed += 1;
                        eprintln!("mago removed {rel}:{d}");
                    }
                }
            }
            eprintln!("{} files, {sites} key sites ({keyed} with a rule), {refs} table rules, {reported} problems, mago: {added} added, {removed} removed", files.len());
        });
    }
}
