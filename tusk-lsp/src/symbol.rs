//! Which symbol a position names: a class, function, constant, class member, or variable.

use mago_codex::metadata::CodebaseMetadata;
use mago_names::kind::NameKind;
use mago_span::HasSpan;
use mago_syntax::cst::*;
use mago_syntax::cst::TriviaKind;

use crate::analysis::{Analysis, Parsed};
use crate::scope::{resolve_class, resolve_function_or_constant, scope_at};
use crate::types::{class_names, display_class};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Symbol {
    Class(String),
    Function(String),
    Constant(String),
    Method { class: String, name: String },
    /// A property, named without its `$`.
    Property { class: String, name: String },
    /// A class constant or an enum case.
    ClassConstant { class: String, name: String },
    /// A local variable, named without its `$`, in the function (or file) whose span is `scope`.
    Variable { name: String, scope: (u32, u32) },
}

/// A symbol found at a position.
#[derive(Debug, Clone)]
pub struct Found {
    /// More than one when the receiver's type is a union of classes.
    pub symbols: Vec<Symbol>,
    /// The span of the name, without `$` for properties.
    pub start: u32,
    pub end: u32,
    /// Whether the position is on the symbol's declaration.
    pub declaration: bool,
}

pub struct Resolver<'p, 'a> {
    pub parsed: &'p Parsed<'a>,
    pub analysis: Option<&'p Analysis>,
    pub codebase: &'p CodebaseMetadata,
}

fn span_of(node: &impl HasSpan) -> (u32, u32) {
    let s = node.span();
    (s.start.offset, s.end.offset)
}

fn contains(node: &impl HasSpan, offset: u32) -> bool {
    let (s, e) = span_of(node);
    s <= offset && offset <= e
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

impl<'p, 'a> Resolver<'p, 'a> {
    pub fn new(parsed: &'p Parsed<'a>, analysis: Option<&'p Analysis>, codebase: &'p CodebaseMetadata) -> Self {
        Self { parsed, analysis, codebase }
    }

    /// The symbol at `offset`.
    pub fn at(&self, offset: u32) -> Option<Found> {
        if let Some(found) = self.in_docblock(offset) {
            return Some(found);
        }
        let path = self.parsed.path_at(offset);
        // The innermost node that names something.
        let i = path.iter().rposition(|n| {
            matches!(
                n,
                Node::LocalIdentifier(_)
                    | Node::QualifiedIdentifier(_)
                    | Node::FullyQualifiedIdentifier(_)
                    | Node::DirectVariable(_)
                    | Node::Keyword(_)
            )
        })?;
        let name = path[i];
        let (start, end) = span_of(&name);
        // The nearest ancestor that isn't just a wrapper around the name.
        let parent = path[..i].iter().rev().copied().find(|n| {
            !matches!(
                n,
                Node::Identifier(_)
                    | Node::Variable(_)
                    | Node::Expression(_)
                    | Node::ClassLikeMemberSelector(_)
                    | Node::ClassLikeConstantSelector(_)
            )
        })?;
        let found = |symbols: Vec<Symbol>, declaration| {
            (!symbols.is_empty()).then(|| Found { symbols, start, end, declaration })
        };
        let enclosing = || self.enclosing_class(&path);

        match parent {
            Node::MethodCall(call) if contains(&call.method, offset) => {
                found(self.members(call.object, &name, |class, name| Symbol::Method { class, name }), false)
            }
            Node::NullSafeMethodCall(call) if contains(&call.method, offset) => {
                found(self.members(call.object, &name, |class, name| Symbol::Method { class, name }), false)
            }
            Node::MethodPartialApplication(call) if contains(&call.method, offset) => {
                found(self.members(call.object, &name, |class, name| Symbol::Method { class, name }), false)
            }
            Node::PropertyAccess(access) if contains(&access.property, offset) => {
                found(self.members(access.object, &name, |class, name| Symbol::Property { class, name }), false)
            }
            Node::NullSafePropertyAccess(access) if contains(&access.property, offset) => {
                found(self.members(access.object, &name, |class, name| Symbol::Property { class, name }), false)
            }
            Node::StaticMethodCall(call) if contains(&call.method, offset) => {
                let classes = self.classes_of_class_expr(call.class, &path);
                let name = self.name_text(&name);
                found(classes.into_iter().map(|class| Symbol::Method { class, name: name.clone() }).collect(), false)
            }
            Node::StaticMethodPartialApplication(call) if contains(&call.method, offset) => {
                let classes = self.classes_of_class_expr(call.class, &path);
                let name = self.name_text(&name);
                found(classes.into_iter().map(|class| Symbol::Method { class, name: name.clone() }).collect(), false)
            }
            Node::StaticPropertyAccess(access) if contains(&access.property, offset) => {
                let classes = self.classes_of_class_expr(access.class, &path);
                let prop = self.name_text(&name);
                let symbols: Vec<_> = classes.into_iter().map(|class| Symbol::Property { class, name: prop.clone() }).collect();
                (!symbols.is_empty()).then(|| Found { symbols, start: start + 1, end, declaration: false })
            }
            Node::ClassConstantAccess(access) if contains(&access.constant, offset) => {
                let classes = self.classes_of_class_expr(access.class, &path);
                let constant = self.name_text(&name);
                if constant.eq_ignore_ascii_case("class") {
                    return found(classes.into_iter().map(Symbol::Class).collect(), false);
                }
                found(classes.into_iter().map(|class| Symbol::ClassConstant { class, name: constant.clone() }).collect(), false)
            }
            Node::Method(method) if contains(&method.name, offset) => {
                let class = enclosing()?;
                found(vec![Symbol::Method { class, name: text(method.name.value) }], true)
            }
            Node::Class(c) if contains(&c.name, offset) => found(vec![self.declared_class(&c.name)], true),
            Node::Interface(c) if contains(&c.name, offset) => found(vec![self.declared_class(&c.name)], true),
            Node::Trait(c) if contains(&c.name, offset) => found(vec![self.declared_class(&c.name)], true),
            Node::Enum(c) if contains(&c.name, offset) => found(vec![self.declared_class(&c.name)], true),
            Node::Function(f) if contains(&f.name, offset) => {
                let fqn = self.parsed.names.resolve(&f.name.span).map(text).unwrap_or_else(|| text(f.name.value));
                found(vec![Symbol::Function(fqn)], true)
            }
            Node::ClassLikeConstantItem(item) if contains(&item.name, offset) => {
                found(vec![Symbol::ClassConstant { class: enclosing()?, name: text(item.name.value) }], true)
            }
            Node::EnumCaseUnitItem(item) if contains(&item.name, offset) => {
                found(vec![Symbol::ClassConstant { class: enclosing()?, name: text(item.name.value) }], true)
            }
            Node::EnumCaseBackedItem(item) if contains(&item.name, offset) => {
                found(vec![Symbol::ClassConstant { class: enclosing()?, name: text(item.name.value) }], true)
            }
            Node::ConstantItem(item) if contains(&item.name, offset) => {
                let fqn = self.parsed.names.resolve(&item.name.span).map(text).unwrap_or_else(|| text(item.name.value));
                found(vec![Symbol::Constant(fqn)], true)
            }
            Node::PropertyAbstractItem(_) | Node::PropertyConcreteItem(_) => {
                let class = enclosing()?;
                Some(Found {
                    symbols: vec![Symbol::Property { class, name: self.name_text(&name) }],
                    start: start + 1,
                    end,
                    declaration: true,
                })
            }
            Node::FunctionCall(call) if contains(call.function, offset) => {
                let written = self.name_text(&name);
                let fqn = self.parsed.names.resolve(&name.span()).map(text);
                found(vec![Symbol::Function(self.function_name(offset, &written, fqn))], false)
            }
            Node::FunctionPartialApplication(call) if contains(call.function, offset) => {
                let written = self.name_text(&name);
                let fqn = self.parsed.names.resolve(&name.span()).map(text);
                found(vec![Symbol::Function(self.function_name(offset, &written, fqn))], false)
            }
            Node::ConstantAccess(_) => {
                let written = self.name_text(&name);
                if ["true", "false", "null"].contains(&written.to_ascii_lowercase().as_str()) {
                    return None;
                }
                let scope = scope_at(self.parsed.program, offset);
                let (fqn, fallback) = resolve_function_or_constant(&scope, NameKind::Constant, &written);
                let name = match fallback {
                    Some(global) if !self.codebase.constant_exists(fqn.as_bytes()) => global,
                    _ => fqn,
                };
                found(vec![Symbol::Constant(name)], false)
            }
            _ => self.name_or_variable(&path, name, offset, start, end),
        }
    }

    /// A class name in a docblock type, such as `User` in `@param list<User> $users`.
    fn in_docblock(&self, offset: u32) -> Option<Found> {
        let comment = self.parsed.program.trivia.iter().find(|t| {
            t.kind == TriviaKind::DocBlockComment && t.span.start.offset <= offset && offset <= t.span.end.offset
        })?;
        let (start, end, name) = docblock_type_names(comment.value, comment.span.start.offset)
            .into_iter()
            .find(|(s, e, _)| *s <= offset && offset <= *e)?;
        let fqn = resolve_class(&scope_at(self.parsed.program, start), &name);
        let lower = fqn.to_ascii_lowercase();
        if matches!(lower.as_str(), "self" | "static" | "parent" | "this") || !self.codebase.class_like_exists(fqn.as_bytes()) {
            return None;
        }
        Some(Found { symbols: vec![Symbol::Class(display_class(&fqn, self.codebase))], start, end, declaration: false })
    }

    fn name_or_variable(&self, path: &[Node<'a, 'a>], name: Node<'a, 'a>, offset: u32, start: u32, end: u32) -> Option<Found> {
        let found = |symbols: Vec<Symbol>, declaration| Some(Found { symbols, start, end, declaration });
        match name {
            Node::DirectVariable(var) => {
                let written = text(var.name);
                if written == "$this" {
                    return found(vec![Symbol::Class(self.enclosing_class(path)?)], false);
                }
                let declaration = path.iter().any(|n| matches!(n, Node::FunctionLikeParameter(p) if p.variable.span == var.span));
                found(vec![Symbol::Variable { name: written[1..].to_string(), scope: self.variable_scope(path) }], declaration)
            }
            Node::Keyword(k) => {
                let word = text(k.value).to_ascii_lowercase();
                match word.as_str() {
                    "self" | "static" => found(vec![Symbol::Class(self.enclosing_class(path)?)], false),
                    "parent" => found(vec![Symbol::Class(self.parent_class(path)?)], false),
                    _ => None,
                }
            }
            _ => {
                let written = self.name_text(&name);
                let lower = written.to_ascii_lowercase();
                if ["self", "static"].contains(&lower.as_str()) {
                    return found(vec![Symbol::Class(self.enclosing_class(path)?)], false);
                }
                if lower == "parent" {
                    return found(vec![Symbol::Class(self.parent_class(path)?)], false);
                }
                // Names in `use` statements, type hints, `new`, `extends`, attributes, and the like.
                let fqn = match self.parsed.names.resolve(&name.span()) {
                    Some(fqn) => text(fqn),
                    None => resolve_class(&scope_at(self.parsed.program, offset), &written),
                };
                // A `use function` or `use const` import names a function or constant.
                let in_use = path.iter().rev().find_map(|n| match n {
                    Node::Use(u) => Some(u),
                    _ => None,
                });
                if let Some(u) = in_use {
                    let text = &self.parsed.text()[u.span().start.offset as usize..u.span().end.offset as usize];
                    let lowered = text.to_ascii_lowercase();
                    if lowered.starts_with("use function") {
                        return found(vec![Symbol::Function(fqn)], false);
                    }
                    if lowered.starts_with("use const") {
                        return found(vec![Symbol::Constant(fqn)], false);
                    }
                }
                found(vec![Symbol::Class(display_class(&fqn, self.codebase))], false)
            }
        }
    }

    /// The name's text, without a `$`.
    fn name_text(&self, name: &Node<'_, '_>) -> String {
        let (s, e) = span_of(name);
        self.parsed.text()[s as usize..e as usize].trim_start_matches('$').to_string()
    }

    fn function_name(&self, offset: u32, written: &str, resolved: Option<String>) -> String {
        let scope = scope_at(self.parsed.program, offset);
        let (fqn, fallback) = resolve_function_or_constant(&scope, NameKind::Function, written);
        let fqn = resolved.unwrap_or(fqn);
        match fallback {
            Some(global) if !self.codebase.function_exists(fqn.as_bytes()) => global,
            _ => fqn,
        }
    }

    fn declared_class(&self, name: &LocalIdentifier<'_>) -> Symbol {
        let fqn = self.parsed.names.resolve(&name.span).map(text).unwrap_or_else(|| text(name.value));
        Symbol::Class(fqn)
    }

    /// Members named `name` on the classes `object` can be.
    fn members(&self, object: &Expression<'_>, name: &Node<'_, '_>, make: impl Fn(String, String) -> Symbol) -> Vec<Symbol> {
        let member = self.name_text(name);
        self.classes_of(object).into_iter().map(|class| make(class, member.clone())).collect()
    }

    /// The classes an expression's value can be an instance of.
    pub fn classes_of(&self, expr: &Expression<'_>) -> Vec<String> {
        let (s, e) = span_of(expr);
        if let Some(t) = self.analysis.and_then(|a| a.type_of(s, e)) {
            let names = class_names(&t, self.codebase);
            if !names.is_empty() {
                return names;
            }
        }
        // `$this` has no recorded type where the analyzer didn't reach, such as in broken code.
        if let Expression::Variable(Variable::Direct(v)) = expr
            && v.name == b"$this"
        {
            let path = self.parsed.path_at(s);
            return self.enclosing_class(&path).into_iter().collect();
        }
        vec![]
    }

    /// The classes a `Class::` expression refers to.
    pub fn classes_of_class_expr(&self, expr: &Expression<'_>, path: &[Node<'_, '_>]) -> Vec<String> {
        match expr {
            Expression::Self_(_) | Expression::Static(_) => self.enclosing_class(path).into_iter().collect(),
            Expression::Parent(_) => self.parent_class(path).into_iter().collect(),
            Expression::Identifier(id) => {
                let fqn = match self.parsed.names.resolve(&id.span()) {
                    Some(fqn) => text(fqn),
                    None => resolve_class(&scope_at(self.parsed.program, id.span().start.offset), &text(id.value())),
                };
                vec![display_class(&fqn, self.codebase)]
            }
            _ => self.classes_of(expr),
        }
    }

    /// The class, interface, trait, or enum the path is inside.
    pub fn enclosing_class(&self, path: &[Node<'_, '_>]) -> Option<String> {
        for node in path.iter().rev() {
            let name = match node {
                Node::Class(c) => &c.name,
                Node::Interface(c) => &c.name,
                Node::Trait(c) => &c.name,
                Node::Enum(c) => &c.name,
                Node::AnonymousClass(c) => {
                    let name = CodebaseMetadata::get_anonymous_class_name(&self.parsed.file, c.span());
                    return Some(name.as_str_lossy().into_owned());
                }
                _ => continue,
            };
            return self.parsed.names.resolve(&name.span).map(text);
        }
        None
    }

    fn parent_class(&self, path: &[Node<'_, '_>]) -> Option<String> {
        let class = self.enclosing_class(path)?;
        let meta = self.codebase.get_class_like(class.as_bytes())?;
        let parent = meta.direct_parent_class?;
        Some(display_class(&parent.as_str_lossy(), self.codebase))
    }

    fn variable_scope(&self, path: &[Node<'_, '_>]) -> (u32, u32) {
        crate::locate::variable_scope(self.parsed, path)
    }
}

/// The names in a docblock that could be types: words not starting a tag (`@param`) or a variable (`$x`),
/// with their spans. `base` is the docblock's offset.
pub fn docblock_type_names(docblock: &[u8], base: u32) -> Vec<(u32, u32, String)> {
    let text = String::from_utf8_lossy(docblock);
    let bytes = text.as_bytes();
    let is_name = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'\\' || b >= 0x80;
    let mut out = vec![];
    let mut i = 0;
    while i < bytes.len() {
        if !is_name(bytes[i]) || bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && is_name(bytes[i]) {
            i += 1;
        }
        let before = if start > 0 { bytes[start - 1] } else { b' ' };
        if matches!(before, b'$' | b'@' | b'-' | b'.' | b':') {
            continue;
        }
        let word = &text[start..i];
        // A description's words start lowercase more often than types do; types in PHP code are classes.
        let first = word.trim_start_matches('\\').chars().next().unwrap_or('a');
        if first.is_uppercase() || word.starts_with('\\') {
            out.push((base + start as u32, base + i as u32, word.to_string()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::analyze;
    use crate::testing::Fixture;
    use mago_allocator::LocalArena;

    fn symbol_at(files: &[(&str, &str)]) -> Option<Found> {
        let fx = Fixture::new(files);
        let (uri, pos) = fx.cursor.clone().unwrap();
        let doc = fx.snap.doc(&uri).unwrap();
        let arena = LocalArena::new();
        let parsed = Parsed::new(&arena, &doc.path, &doc.text);
        let index = fx.snap.index.read();
        let analysis = analyze(&parsed, &arena, &index.codebase, index.config.php_version);
        Resolver::new(&parsed, Some(&analysis), &index.codebase).at(doc.offset(pos))
    }

    fn symbols(text: &str) -> Vec<Symbol> {
        symbol_at(&[("test.php", text)]).map(|f| f.symbols).unwrap_or_default()
    }

    const CLASSES: &str = "<?php namespace App;
        class User { public int $id = 0; const ROLE = 'a'; public function name(): string { return ''; } public static function make(): static { return new static; } }
        class Admin extends User {}
        enum Status: string { case Active = 'a'; }
        function helper(): User { return new User; }
        const LIMIT = 3;";

    fn with_classes(text: &str) -> Vec<Symbol> {
        symbol_at(&[("classes.php", CLASSES), ("test.php", text)]).map(|f| f.symbols).unwrap_or_default()
    }

    fn method(class: &str, name: &str) -> Symbol {
        Symbol::Method { class: class.into(), name: name.into() }
    }

    #[test]
    fn finds_members_through_inferred_types() {
        assert_eq!(with_classes("<?php use App\\User; function f(User $u) { $u->na<|>me(); }"), vec![method("App\\User", "name")]);
        assert_eq!(with_classes("<?php function f() { \\App\\helper()->na<|>me(); }"), vec![method("App\\User", "name")]);
        assert_eq!(
            with_classes("<?php use App\\User; function f(User $u) { return $u->i<|>d; }"),
            vec![Symbol::Property { class: "App\\User".into(), name: "id".into() }]
        );
        assert_eq!(with_classes("<?php use App\\Admin; Admin::ma<|>ke();"), vec![method("App\\Admin", "make")]);
        assert_eq!(
            with_classes("<?php \\App\\User::RO<|>LE;"),
            vec![Symbol::ClassConstant { class: "App\\User".into(), name: "ROLE".into() }]
        );
        assert_eq!(
            with_classes("<?php \\App\\Status::Act<|>ive;"),
            vec![Symbol::ClassConstant { class: "App\\Status".into(), name: "Active".into() }]
        );
        // A union receiver names the member on each class.
        assert_eq!(
            with_classes("<?php function f(\\App\\User|\\App\\Admin $u) { $u->na<|>me(); }"),
            vec![method("App\\User", "name"), method("App\\Admin", "name")]
        );
    }

    #[test]
    fn finds_names_and_declarations() {
        assert_eq!(with_classes("<?php use App\\Us<|>er;"), vec![Symbol::Class("App\\User".into())]);
        assert_eq!(with_classes("<?php namespace App; new Adm<|>in;"), vec![Symbol::Class("App\\Admin".into())]);
        assert_eq!(with_classes("<?php function f(): \\App\\Us<|>er {}"), vec![Symbol::Class("App\\User".into())]);
        assert_eq!(with_classes("<?php namespace App; hel<|>per();"), vec![Symbol::Function("App\\helper".into())]);
        assert_eq!(with_classes("<?php namespace App; strl<|>en('');"), vec![Symbol::Function("strlen".into())]);
        assert_eq!(with_classes("<?php namespace App; echo LIM<|>IT;"), vec![Symbol::Constant("App\\LIMIT".into())]);
        assert_eq!(with_classes("<?php namespace App; echo PHP_EO<|>L;"), vec![Symbol::Constant("PHP_EOL".into())]);
        assert_eq!(with_classes("<?php use App\\User; $x instanceof Us<|>er;"), vec![Symbol::Class("App\\User".into())]);

        let found = symbol_at(&[("test.php", "<?php namespace A; class B { public function c<|>d() {} }")]).unwrap();
        assert!(found.declaration);
        assert_eq!(found.symbols, vec![method("A\\B", "cd")]);
        let found = symbol_at(&[("test.php", "<?php namespace A; class B { private ?int $co<|>unt; }")]).unwrap();
        assert_eq!(found.symbols, vec![Symbol::Property { class: "A\\B".into(), name: "count".into() }]);
        assert_eq!(symbols("<?php namespace A; class B<|>c {}"), vec![Symbol::Class("A\\Bc".into())]);
        assert_eq!(
            symbols("<?php namespace A; class B { function f() { return self::X<|>Y; } const XY = 1; }"),
            vec![Symbol::ClassConstant { class: "A\\B".into(), name: "XY".into() }]
        );
    }

    #[test]
    fn finds_classes_in_docblocks() {
        assert_eq!(
            with_classes("<?php use App\\User;\n/** @param list<Us<|>er> $users */\nfunction f($users) {}"),
            vec![Symbol::Class("App\\User".into())]
        );
        assert!(with_classes("<?php\n/** Returns the Us<|>er. */\nfunction f() {}").is_empty());
    }

    #[test]
    fn scopes_variables_to_their_function() {
        let found = symbol_at(&[("test.php", "<?php function f($a) { return $<|>a; } function g($a) {}")]).unwrap();
        let Symbol::Variable { name, scope } = &found.symbols[0] else { panic!() };
        assert_eq!(name, "a");
        assert_eq!(scope.0, 6);
        // `$this` is the enclosing class.
        assert_eq!(symbols("<?php class K { function f() { $th<|>is; } }"), vec![Symbol::Class("K".into())]);
    }
}
