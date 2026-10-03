//! Where a string literal's value goes when it isn't a call's argument itself: an icon or color name that a
//! closure returns to the call, a property's default, or what a method returns.
//!
//! ```php
//! ->icon('heroicon-o-user')                             // an argument
//! ->color(fn ($state) => match ($state) { 'a' => 'danger', default => 'gray' })   // a closure's result
//! protected static ?string $navigationIcon = 'heroicon-o-users';                // a property's default
//! public function getColor(): string { return 'success'; }                      // a method's result
//! ```

use mago_span::HasSpan;
use mago_syntax::cst::{BinaryOperator, Node};

use super::{Call, InArray, argument, plain_string, text_of};
use crate::features::Ctx;
use crate::locate::walk;

/// What a string literal's value becomes.
#[derive(Debug, Clone)]
pub enum Target {
    /// An argument of `call`, directly or as what a closure passed there returns (`closure`).
    Arg { call: Call, index: usize, name: Option<String>, in_array: Option<InArray>, closure: bool },
    /// A property's default, named without its `$`.
    Property(String),
    /// What a method returns, in the class that declares it.
    Return { class: String, method: String },
}

/// A string literal and where its value goes.
#[derive(Debug, Clone)]
pub struct Site {
    /// The contents, without quotes.
    pub value: String,
    /// The span of the contents.
    pub start: u32,
    pub end: u32,
    pub target: Target,
}

/// The name of the call `node` is, as written, without resolving it: a method's name, or a function's last segment.
fn written_name(ctx: &Ctx<'_>, node: &Node<'_, '_>) -> Option<String> {
    let span = match node {
        Node::MethodCall(c) => c.method.span(),
        Node::NullSafeMethodCall(c) => c.method.span(),
        Node::StaticMethodCall(c) => c.method.span(),
        Node::FunctionCall(c) => c.function.span(),
        _ => return None,
    };
    let name = text_of(ctx, (span.start.offset, span.end.offset));
    Some(name.rsplit('\\').next().unwrap_or(&name).to_string())
}

fn within(inner: (u32, u32), outer: mago_span::Span) -> bool {
    outer.start.offset <= inner.0 && inner.1 <= outer.end.offset
}

/// Where the literal at the end of `path` goes, if it's one of the places [`Target`] lists. `calls` says which
/// calls, by their written name, are worth describing; others are skipped before their receiver is typed.
fn site(ctx: &Ctx<'_>, path: &[Node<'_, '_>], calls: &dyn Fn(&str) -> bool) -> Option<Site> {
    let Some(Node::LiteralString(literal)) = path.last() else { return None };
    let (start, end) = (literal.span.start.offset + 1, literal.span.end.offset.saturating_sub(1).max(literal.span.start.offset + 1));
    let value = text_of(ctx, (start, end));
    let mut in_array = None;
    let mut closure = false;
    // The span of what's been climbed so far, which must be a branch's value rather than its condition.
    let mut from = (literal.span.start.offset, literal.span.end.offset);
    let mut i = path.len() - 1;
    while i > 0 {
        i -= 1;
        let node = &path[i];
        match node {
            Node::Expression(_) | Node::Literal(_) | Node::LiteralString(_) | Node::Parenthesized(_) | Node::Match(_) | Node::MatchArm(_) => {}
            Node::MatchExpressionArm(arm) if within(from, arm.expression.span()) => {}
            Node::MatchDefaultArm(_) => {}
            Node::Conditional(c) if !within(from, c.condition.span()) => {}
            Node::Binary(b) if matches!(b.operator, BinaryOperator::NullCoalesce(_)) => {}
            Node::KeyValueArrayElement(el) if in_array.is_none() => {
                in_array = Some(if within(from, el.key.span()) { InArray::Key } else { InArray::Value(plain_string(ctx, el.key)) });
            }
            Node::ValueArrayElement(_) if in_array.is_none() => in_array = Some(InArray::Value(None)),
            Node::ArrayElement(_) | Node::Array(_) | Node::LegacyArray(_) => {}
            Node::PositionalArgument(_) | Node::NamedArgument(_) | Node::Argument(_) => {}
            Node::ArrowFunction(f) if within(from, f.expression.span()) && in_array.is_none() => closure = true,
            Node::Return(_) if in_array.is_none() && !closure => {
                // Up to the function the `return` is in: a closure passes its result on, a method is the target.
                loop {
                    if i == 0 {
                        return None;
                    }
                    i -= 1;
                    match &path[i] {
                        Node::Closure(_) => {
                            closure = true;
                            break;
                        }
                        Node::Method(m) => {
                            let class = ctx.resolver().enclosing_class(&path[..i])?;
                            let method = String::from_utf8_lossy(m.name.value).into_owned();
                            return Some(Site { value, start, end, target: Target::Return { class, method } });
                        }
                        Node::Function(_) | Node::ArrowFunction(_) => return None,
                        _ => {}
                    }
                }
            }
            Node::PropertyConcreteItem(p) if in_array.is_none() => {
                let name = String::from_utf8_lossy(p.variable.name).trim_start_matches('$').to_string();
                return Some(Site { value, start, end, target: Target::Property(name) });
            }
            Node::ArgumentList(_) => {
                let call_node = path[..i].iter().rev().find(|n| {
                    matches!(n, Node::FunctionCall(_) | Node::MethodCall(_) | Node::NullSafeMethodCall(_) | Node::StaticMethodCall(_) | Node::Instantiation(_) | Node::Attribute(_))
                })?;
                if !calls(&written_name(ctx, call_node)?) {
                    return None;
                }
                let (call, index, name) = argument(ctx, path, i)?;
                return Some(Site { value, start, end, target: Target::Arg { call, index, name, in_array, closure } });
            }
            _ => return None,
        }
        from = (node.span().start.offset, node.span().end.offset);
    }
    None
}

/// Every string literal in the file that goes to one of the places [`Target`] lists.
pub fn sites(ctx: &Ctx<'_>, calls: &dyn Fn(&str) -> bool) -> Vec<Site> {
    let mut out = vec![];
    walk(&ctx.parsed, |node, ancestors| {
        if let Node::LiteralString(_) = node {
            let mut path = ancestors.to_vec();
            path.push(node);
            if let Some(s) = site(ctx, &path, calls) {
                out.push(s);
            }
        }
    });
    out
}

/// The site whose contents hold `offset`, between its quotes or at either end of them.
pub fn site_at(ctx: &Ctx<'_>, offset: u32, calls: &dyn Fn(&str) -> bool) -> Option<Site> {
    let path = ctx.parsed.path_at(offset);
    let i = path.iter().rposition(|n| matches!(n, Node::LiteralString(_)))?;
    let Node::LiteralString(literal) = path[i] else { return None };
    if !(literal.span.start.offset < offset && offset < literal.span.end.offset) {
        return None;
    }
    site(ctx, &path[..=i], calls)
}

/// An attribute of a Blade component tag, with a literal value: `icon="heroicon-o-user"`.
#[derive(Debug, Clone)]
pub struct BladeAttribute {
    pub name: String,
    pub value: String,
    /// The span of the value, without quotes. An unclosed value runs to the end of its line.
    pub start: u32,
    pub end: u32,
}

/// A Blade component tag, `<x-filament::badge color="success">`, with the span of its name (`x-filament::badge`)
/// and its attributes, which may span lines. Attributes bound to PHP (`:icon`) and Alpine's (`x-on:`, `@click`)
/// are left out.
#[derive(Debug, Clone)]
pub struct BladeTag {
    pub name: String,
    pub start: u32,
    pub end: u32,
    pub attributes: Vec<BladeAttribute>,
}

/// The component tags in a Blade view: those whose name starts with `x-`.
pub fn blade_tags(text: &str) -> Vec<BladeTag> {
    let bytes = text.as_bytes();
    let name_char = |b: u8| b.is_ascii_alphanumeric() || b"-_.:".contains(&b);
    let mut out = vec![];
    let mut from = 0;
    while let Some(at) = text[from..].find("<x-").map(|i| from + i) {
        let start = at + 1;
        let mut i = start;
        while i < bytes.len() && name_char(bytes[i]) {
            i += 1;
        }
        let mut tag = BladeTag { name: text[start..i].to_string(), start: start as u32, end: i as u32, attributes: vec![] };
        // The attributes, up to the `>` that ends the tag outside quotes.
        while i < bytes.len() && bytes[i] != b'>' && bytes[i] != b'<' {
            if bytes[i].is_ascii_whitespace() || bytes[i] == b'/' {
                i += 1;
                continue;
            }
            let name_start = i;
            while i < bytes.len() && (name_char(bytes[i]) || bytes[i] == b'@') {
                i += 1;
            }
            if i == name_start {
                // Something else, such as `{{ $attributes }}`: skip past it.
                i += 1;
                continue;
            }
            let name = &text[name_start..i];
            if bytes.get(i) != Some(&b'=') {
                continue;
            }
            let Some(&q) = bytes.get(i + 1).filter(|q| **q == b'"' || **q == b'\'') else { continue };
            let value_start = i + 2;
            let close = text[value_start..].find(q as char).map(|n| value_start + n);
            let line_end = text[value_start..].find('\n').map_or(text.len(), |n| value_start + n);
            let value_end = close.unwrap_or(line_end);
            if !name.starts_with(':') && !name.starts_with('@') && !name.starts_with("x-") && !name.starts_with("wire:") {
                tag.attributes.push(BladeAttribute { name: name.to_string(), value: text[value_start..value_end].to_string(), start: value_start as u32, end: value_end as u32 });
            }
            i = close.map_or(value_end, |c| c + 1);
        }
        out.push(tag);
        from = start;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::with_ctx;
    use crate::testing::Fixture;

    fn summary(text: &str) -> Vec<String> {
        let fx = Fixture::one(text);
        with_ctx(&fx.snap, &crate::testing::uri("test.php"), |ctx| {
            sites(ctx, &|n| n == "color" || n == "icons")
                .into_iter()
                .map(|s| match s.target {
                    Target::Arg { call, index, in_array, closure, .. } => format!("{} #{index} {in_array:?} closure={closure} = {}", call.name, s.value),
                    Target::Property(p) => format!("${p} = {}", s.value),
                    Target::Return { class, method } => format!("{class}::{method}() = {}", s.value),
                })
                .collect()
        })
        .unwrap()
    }

    #[test]
    fn reads_blade_tags_and_attributes() {
        let tags = blade_tags("<x-filament::badge\n    color=\"success\" :icon=\"$i\" disabled>Hi</x-filament::badge>\n<x-heroicon-o-user/>\n<x-a icon=\"heroicon-o-");
        let summary: Vec<String> =
            tags.iter().map(|t| format!("{} {:?}", t.name, t.attributes.iter().map(|a| format!("{}={}@{}", a.name, a.value, a.start)).collect::<Vec<_>>())).collect();
        assert_eq!(summary, vec!["x-filament::badge [\"color=success@30\"]", "x-heroicon-o-user []", "x-a [\"icon=heroicon-o-@114\"]"]);
    }

    #[test]
    fn follows_values_through_closures_matches_and_returns() {
        let found = summary(
            "<?php\nclass A {\n    protected static ?string $navigationIcon = 'heroicon-o-users';\n    public function getColor(): string { if (1) { return 'success'; } return fn () => 'no'; }\n    function f($c) {\n        $c->color(fn ($state) => match ($state) { 'active' => 'success', default => $state ? 'gray' : 'info' });\n        $c->color(function () { return 'danger'; });\n        $c->icons(['heroicon-o-x' => 'draft']);\n        $c->label('nope');\n        $c->color('a' . 'b');\n    }\n}\n",
        );
        assert_eq!(
            found,
            vec![
                "$navigationIcon = heroicon-o-users",
                "A::getColor() = success",
                "color #0 None closure=true = success",
                "color #0 None closure=true = gray",
                "color #0 None closure=true = info",
                "color #0 None closure=true = danger",
                "icons #0 Some(Key) closure=false = heroicon-o-x",
                "icons #0 Some(Value(Some(\"heroicon-o-x\"))) closure=false = draft",
            ]
        );
    }
}
