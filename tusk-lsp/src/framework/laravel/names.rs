//! Names the project's own code defines and other code uses as strings: broadcast channels
//! (`Broadcast::channel('orders.{id}', …)`, used by `new PrivateChannel('orders.'.$id)`), Pennant features
//! (`Feature::define('new-api', …)` or a class in `app/Features`, used by `Feature::active('new-api')` and
//! `@feature`), and Context keys (`Context::add('trace', …)`, used by `Context::get('trace')`). The definitions
//! come from the project's [`facts`](super::facts).

use std::path::PathBuf;

use lsp_types::{CompletionItem, CompletionItemKind, CompletionTextEdit, Diagnostic, DiagnosticSeverity, NumberOrString, TextEdit};
use mago_span::HasSpan;
use mago_syntax::cst::{BinaryOperator, CompositeString, Expression, Node, StringPart};
use serde_json::Value;

use super::facts::{Fact, Facts, Site, facts};
use super::{Data, SOURCE, completion_item, link, replacement};
use crate::features::Ctx;
use crate::framework::{CallKind, InArray, StringArg};
use crate::locate::walk;

/// What a string names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Feature,
    ContextKey,
}

const CHANNELS: &[&str] = &[
    "Illuminate\\Broadcasting\\Channel",
    "Illuminate\\Broadcasting\\PrivateChannel",
    "Illuminate\\Broadcasting\\PresenceChannel",
    "Illuminate\\Broadcasting\\EncryptedPrivateChannel",
];

const FEATURES: &[&str] = &["Feature", "Laravel\\Pennant\\Feature", "Laravel\\Pennant\\FeatureManager", "Laravel\\Pennant\\Drivers\\Decorator", "Laravel\\Pennant\\PendingScopedFeatureInteraction"];

const FEATURE_METHODS: &[&str] = &[
    "active", "inactive", "value", "values", "allAreActive", "someAreActive", "allAreInactive", "someAreInactive", "when", "unless", "activate", "deactivate",
    "forget", "load", "loadMissing", "activateForEveryone", "deactivateForEveryone", "purge",
];

const CONTEXTS: &[&str] = &["Context", "Illuminate\\Support\\Facades\\Context", "Illuminate\\Log\\Context\\Repository"];

const CONTEXT_METHODS: &[&str] = &[
    "get", "has", "pull", "missing", "getHidden", "hasHidden", "pullHidden", "missingHidden", "forget", "forgetHidden", "only", "except", "onlyHidden",
    "exceptHidden", "increment", "decrement", "push", "pop", "pushHidden", "popHidden", "stackContains", "hiddenStackContains",
];

/// What a string argument names, if it's a feature or a Context key.
fn kind_of(ctx: &Ctx<'_>, arg: &StringArg) -> Option<Kind> {
    let s = super::Site { arg, codebase: &ctx.index.codebase };
    let listed = arg.in_array.is_none() || arg.in_array == Some(InArray::Value(None));
    if !listed {
        return None;
    }
    let feature = s.method(FEATURE_METHODS, FEATURES, &[0])
        || s.function(&["@feature", "@featureany"], &[0])
        || s.method(&["using"], &["Laravel\\Pennant\\Middleware\\EnsureFeaturesAreActive"], &[0, 1, 2, 3, 4, 5, 6, 7]);
    if feature {
        return Some(Kind::Feature);
    }
    s.method(CONTEXT_METHODS, CONTEXTS, &[0]).then_some(Kind::ContextKey)
}

/// The definitions a kind's names come from: each name with where it's defined.
fn definitions(facts: &Facts, kind: Kind) -> Vec<(Option<&str>, &Site)> {
    facts
        .iter()
        .filter_map(|(f, site)| match (f, kind) {
            (Fact::Feature { name }, Kind::Feature) => Some((name.as_deref(), site)),
            (Fact::ContextKey { key }, Kind::ContextKey) => Some((Some(key.as_str()), site)),
            _ => None,
        })
        .collect()
}

/// A broadcast channel's name in use: the literal at its start, whether the literal is all of it, and whether
/// the channel needs authorizing (private, presence).
struct ChannelUse {
    start: u32,
    end: u32,
    value: String,
    whole: bool,
    private: bool,
}

/// The literal start of a channel name: a plain string, the left of a concatenation, or the start of an
/// interpolated string.
fn literal_start(expr: &Expression<'_>, whole: bool) -> Option<(u32, u32, bool)> {
    match expr {
        Expression::Literal(mago_syntax::cst::Literal::String(s)) => Some((s.span.start.offset + 1, s.span.end.offset.saturating_sub(1).max(s.span.start.offset + 1), whole)),
        Expression::Binary(b) if matches!(b.operator, BinaryOperator::StringConcat(_)) => literal_start(b.lhs, false),
        Expression::Parenthesized(p) => literal_start(p.expression, whole),
        Expression::CompositeString(CompositeString::Interpolated(i)) => match i.parts.first()? {
            StringPart::Literal(l) => Some((l.span.start.offset, l.span.end.offset, false)),
            _ => None,
        },
        _ => None,
    }
}

/// The broadcast channel names the file uses: in `new PrivateChannel(…)` and the other channel classes, and in
/// `Broadcast::on()`, `private()`, and `presence()`.
fn channel_uses(ctx: &Ctx<'_>) -> Vec<ChannelUse> {
    let text = ctx.parsed.text();
    let resolved = |expr: &Expression<'_>| match expr {
        Expression::Identifier(id) => ctx.parsed.names.resolve(&id.span()).map(|n| String::from_utf8_lossy(n).trim_start_matches('\\').to_string()),
        _ => None,
    };
    let mut out = vec![];
    walk(&ctx.parsed, |node, _| {
        let (first, private) = match node {
            Node::Instantiation(i) => {
                let Some(class) = resolved(i.class).filter(|c| CHANNELS.contains(&c.as_str())) else { return };
                let Some(first) = i.argument_list.as_ref().and_then(|l| l.arguments.first()) else { return };
                (first.value(), !class.ends_with("\\Channel"))
            }
            Node::StaticMethodCall(c) => {
                let Some(class) = resolved(c.class).filter(|c| c == "Broadcast" || c == "Illuminate\\Support\\Facades\\Broadcast") else { return };
                let _ = class;
                let method = &text[c.method.span().start.offset as usize..c.method.span().end.offset as usize];
                if !["on", "private", "presence"].contains(&method) {
                    return;
                }
                let Some(first) = c.argument_list.arguments.first() else { return };
                (first.value(), method != "on")
            }
            _ => return,
        };
        if let Some((start, end, whole)) = literal_start(first, true) {
            out.push(ChannelUse { start, end, value: text[start as usize..end as usize].to_string(), whole, private });
        }
    });
    out
}

/// Whether a channel name matches a channel's pattern, as Laravel's `channelNameMatchesPattern()` does, with
/// each `{parameter}` matching characters other than `.`; with `prefix`, whether some name that starts with it
/// does.
fn channel_matches(pattern: &str, name: &str, prefix: bool) -> bool {
    fn go(p: &[u8], n: &[u8], prefix: bool) -> bool {
        if n.is_empty() && prefix {
            return true;
        }
        match p.first() {
            None => n.is_empty(),
            Some(b'{') if p.contains(&b'}') => {
                let close = p.iter().position(|c| *c == b'}').unwrap_or(0);
                let rest = &p[close + 1..];
                (1..=n.len()).take_while(|i| n[i - 1] != b'.').any(|i| go(rest, &n[i..], prefix))
            }
            Some(c) => n.first() == Some(c) && go(&p[1..], &n[1..], prefix),
        }
    }
    let name = name.strip_prefix("private-").or_else(|| name.strip_prefix("presence-")).unwrap_or(name);
    go(pattern.as_bytes(), name.as_bytes(), prefix)
}

/// The project's channels: each name, if plain, with its callback and where it's defined.
fn channels(facts: &Facts) -> Vec<(Option<&str>, &str, &Site)> {
    facts
        .iter()
        .filter_map(|(f, site)| match f {
            Fact::Channel { name, callback } => Some((name.as_deref(), callback.as_str(), site)),
            _ => None,
        })
        .collect()
}

fn channel_hover(data: &Data<'_>, name: &str, callback: &str, site: &Site) -> String {
    let callback = if callback.len() > 600 { format!("{}…", &callback[..callback.floor_char_boundary(600)]) } else { callback.to_string() };
    let rel = site.path.strip_prefix(data.root()).unwrap_or(&site.path).display().to_string();
    format!("```php\nBroadcast::channel('{name}', {callback})\n```\n\n{}", link(&site.path, Some(site.line + 1), &format!("{rel}:{}", site.line + 1)))
}

pub(super) fn completion(ctx: &Ctx<'_>, arg: &StringArg, offset: u32) -> Option<Vec<CompletionItem>> {
    let channel = arg.index == 0 && arg.in_array.is_none() && {
        let s = super::Site { arg, codebase: &ctx.index.codebase };
        (arg.call.kind == CallKind::New && arg.call.on(&ctx.index.codebase, CHANNELS)) || s.facade(&["on", "private", "presence"], "Broadcast", &[], &[0])
    };
    if channel {
        let facts = facts(ctx.snap, &ctx.index);
        // The whole name typed so far, dots included.
        let range = ctx.doc.range(arg.start, offset);
        let mut seen = vec![];
        let items = channels(&facts)
            .into_iter()
            .filter_map(|(name, _, site)| {
                let name = name?;
                if seen.contains(&name) {
                    return None;
                }
                seen.push(name);
                let mut item = completion_item(name, Some(CompletionItemKind::VALUE), range);
                // A channel with parameters gets its name up to the first, for the code that follows to finish.
                let insert = name.split('{').next().unwrap_or(name);
                item.text_edit = Some(CompletionTextEdit::Edit(TextEdit { range, new_text: insert.to_string() }));
                item.detail = Some(site.label.clone());
                Some(item)
            })
            .collect::<Vec<_>>();
        return Some(items);
    }
    let kind = kind_of(ctx, arg)?;
    let facts = facts(ctx.snap, &ctx.index);
    let range = replacement(ctx, arg.start, offset);
    let mut seen = vec![];
    let items = definitions(&facts, kind)
        .into_iter()
        .filter_map(|(name, site)| {
            let name = name?;
            if seen.contains(&name) {
                return None;
            }
            seen.push(name);
            let mut item = completion_item(name, Some(if kind == Kind::Feature { CompletionItemKind::ENUM_MEMBER } else { CompletionItemKind::VALUE }), range);
            item.detail = Some(site.label.clone());
            Some(item)
        })
        .collect::<Vec<_>>();
    Some(items)
}

/// Where the name at `offset` is defined.
pub(super) fn definition(ctx: &Ctx<'_>, args: &[StringArg], offset: u32) -> Vec<(PathBuf, u32)> {
    if let Some(used) = channel_uses(ctx).into_iter().find(|u| u.start <= offset && offset <= u.end) {
        let facts = facts(ctx.snap, &ctx.index);
        return channels(&facts)
            .into_iter()
            .filter(|(name, _, _)| name.is_some_and(|n| channel_matches(n, &used.value, !used.whole)))
            .map(|(_, _, s)| (s.path.clone(), s.line + 1))
            .collect();
    }
    let Some(arg) = args.iter().find(|a| a.start <= offset && offset <= a.end) else { return vec![] };
    let Some(kind) = kind_of(ctx, arg) else { return vec![] };
    let facts = facts(ctx.snap, &ctx.index);
    definitions(&facts, kind).into_iter().filter(|(n, _)| *n == Some(arg.value.as_str())).map(|(_, s)| (s.path.clone(), s.line + 1)).collect()
}

pub(super) fn hover(ctx: &Ctx<'_>, args: &[StringArg], offset: u32) -> Option<(String, (u32, u32))> {
    let data = Data(&ctx.snap.framework);
    if let Some(used) = channel_uses(ctx).into_iter().find(|u| u.start <= offset && offset <= u.end) {
        let facts = facts(ctx.snap, &ctx.index);
        let found: Vec<String> = channels(&facts)
            .into_iter()
            .filter_map(|(name, callback, site)| Some((name?, callback, site)))
            .filter(|(name, _, _)| channel_matches(name, &used.value, !used.whole))
            .map(|(name, callback, site)| channel_hover(&data, name, callback, site))
            .collect();
        return (!found.is_empty()).then(|| (found.join("\n\n---\n\n"), (used.start, used.end)));
    }
    let arg = args.iter().find(|a| a.start <= offset && offset <= a.end)?;
    let kind = kind_of(ctx, arg)?;
    let facts = facts(ctx.snap, &ctx.index);
    let sites: Vec<String> = definitions(&facts, kind)
        .into_iter()
        .filter(|(n, _)| *n == Some(arg.value.as_str()))
        .map(|(_, s)| link(&s.path, Some(s.line + 1), &s.label))
        .collect();
    if sites.is_empty() {
        return None;
    }
    let what = if kind == Kind::Feature { "Pennant feature, defined in" } else { "Context key, set in" };
    Some((format!("{what} {}", sites.join(", ")), (arg.start, arg.end)))
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

/// A private or presence channel no channel definition matches, and a feature no definition names, when the
/// name is all plain and every definition in the project is too.
pub(super) fn diagnostics(ctx: &Ctx<'_>, args: &[StringArg]) -> Vec<Diagnostic> {
    let features = args.iter().filter(|a| kind_of(ctx, a) == Some(Kind::Feature)).collect::<Vec<_>>();
    let is_blade = super::is_blade(ctx);
    let uses: Vec<ChannelUse> = if is_blade { vec![] } else { channel_uses(ctx).into_iter().filter(|u| u.whole && u.private && !u.value.contains('$')).collect() };
    if features.is_empty() && uses.is_empty() {
        return vec![];
    }
    let facts = facts(ctx.snap, &ctx.index);
    let mut out = vec![];
    let defined = channels(&facts);
    if !defined.is_empty() && defined.iter().all(|(n, _, _)| n.is_some()) {
        for u in uses.iter().filter(|u| !u.value.is_empty()) {
            if !defined.iter().any(|(n, _, _)| n.is_some_and(|n| channel_matches(n, &u.value, false))) {
                out.push(warning(ctx, u.start, u.end, "channel", format!("Broadcast channel [{}] not found.", u.value)));
            }
        }
    }
    let defined = definitions(&facts, Kind::Feature);
    let state = &ctx.snap.framework;
    let pennant = state.remember("laravel:pennant", &["composer.lock"], || Value::Bool(state.root().join("vendor/laravel/pennant").is_dir())).as_bool() == Some(true);
    if pennant && !defined.is_empty() && defined.iter().all(|(n, _)| n.is_some()) {
        for a in features {
            let v = &a.value;
            // A class's name, which Pennant resolves as a class-based feature.
            if v.is_empty() || v.contains('$') || v.contains('\\') || defined.iter().any(|(n, _)| *n == Some(v.as_str())) {
                continue;
            }
            out.push(warning(ctx, a.start, a.end, "feature", format!("Feature [{v}] not found.")));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::{with_ctx, with_ctx_at};
    use crate::framework::laravel::tests::{fixture_with, labels};
    use crate::testing::{Fixture, uri};

    const VENDOR: &str = "<?php\nnamespace Illuminate\\Broadcasting { class Channel { public function __construct($name) {} } class PrivateChannel extends Channel {} class PresenceChannel extends Channel {} }\nnamespace Illuminate\\Support\\Facades { class Broadcast {} class Context {} }\nnamespace Laravel\\Pennant { class Feature {} }\n";
    const CHANNELS_FILE: &str = "<?php\nuse Illuminate\\Support\\Facades\\Broadcast;\nBroadcast::channel('orders.{order}', function ($user, $order) {\n    return true;\n});\nBroadcast::channel('chat', fn () => true);\n";
    const DEFINES: &str = "<?php\nuse Laravel\\Pennant\\Feature;\nuse Illuminate\\Support\\Facades\\Context;\nclass AppServiceProvider {\n    function boot() {\n        Feature::define('new-api', fn () => true);\n        Context::add('trace_id', 1);\n    }\n}\n";

    fn fx(text: &str) -> Fixture {
        let fx = fixture_with(&[("vendor/more.php", VENDOR), ("routes/channels.php", CHANNELS_FILE), ("app/Providers/AppServiceProvider.php", DEFINES), ("app/t.php", text)]);
        fx.snap.framework.seed("laravel:pennant", serde_json::json!(true));
        fx
    }

    fn complete(text: &str) -> Vec<CompletionItem> {
        let fx = fx(text);
        let at = fx.at();
        with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| crate::framework::completion(ctx, ctx.offset(at.position))).flatten().unwrap_or_default()
    }

    fn at_cursor<R>(text: &str, f: impl FnOnce(&Ctx<'_>, u32) -> R) -> R {
        let fx = fx(text);
        let at = fx.at();
        with_ctx(&fx.snap, &at.text_document.uri, |ctx| f(ctx, ctx.offset(at.position))).unwrap()
    }

    fn diagnose(text: &str) -> Vec<String> {
        let fx = fx(text);
        with_ctx(&fx.snap, &uri("app/t.php"), super::super::diagnostics).unwrap().into_iter().map(|d| d.message).collect()
    }

    #[test]
    fn matches_channel_names_as_laravel_does() {
        assert!(channel_matches("orders.{order}", "orders.5", false));
        assert!(!channel_matches("orders.{order}", "orders.5.x", false));
        assert!(!channel_matches("orders.{order}", "orders.", false));
        assert!(channel_matches("orders.{order}", "orders.", true));
        assert!(channel_matches("orders.{order}.items", "orders.5.it", true));
        assert!(!channel_matches("chat", "orders.", true));
        assert!(channel_matches("App.Models.User.{id}", "private-App.Models.User.1", false));
    }

    #[test]
    fn completes_shows_and_goes_to_channels() {
        let items = complete("<?php new \\Illuminate\\Broadcasting\\PrivateChannel('<|>');");
        assert_eq!(labels(&items), vec!["chat", "orders.{order}"]);
        let orders = items.iter().find(|i| i.label == "orders.{order}").unwrap();
        let Some(CompletionTextEdit::Edit(edit)) = &orders.text_edit else { panic!() };
        assert_eq!(edit.new_text, "orders.");
        assert_eq!(labels(&complete("<?php \\Illuminate\\Support\\Facades\\Broadcast::private('<|>');")).len(), 2);

        let text = "<?php\nuse Illuminate\\Broadcasting\\PrivateChannel;\nfunction f($o) { return new PrivateChannel('ord<|>ers.'.$o->id); }\n";
        let found = at_cursor(text, super::super::definition);
        assert_eq!(found.len(), 1);
        assert!(found[0].uri.as_str().ends_with("routes/channels.php") && found[0].range.start.line == 2, "{found:?}");
        let hover = at_cursor(text, super::super::hover).unwrap();
        let lsp_types::HoverContents::Markup(m) = hover.contents else { panic!() };
        assert!(m.value.starts_with("```php\nBroadcast::channel('orders.{order}', function ($user, $order) {\n    return true;\n})\n```\n\n[routes/channels.php:3]("), "{}", m.value);
        // An interpolated name.
        let found = at_cursor("<?php function f($o) { return new \\Illuminate\\Broadcasting\\PresenceChannel(\"ord<|>ers.{$o->id}\"); }", super::super::definition);
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn reports_private_channels_nothing_defines_only_when_sure() {
        assert_eq!(diagnose("<?php new \\Illuminate\\Broadcasting\\PrivateChannel('order.5');"), vec!["Broadcast channel [order.5] not found."]);
        for fine in [
            "new \\Illuminate\\Broadcasting\\PrivateChannel('orders.5')",
            "new \\Illuminate\\Broadcasting\\PrivateChannel('chat')",
            // Public channels need no definition.
            "new \\Illuminate\\Broadcasting\\Channel('anything')",
            "new \\Illuminate\\Broadcasting\\PrivateChannel('order.'.$id)",
            "new \\Illuminate\\Broadcasting\\PrivateChannel(\"order.$id\")",
        ] {
            assert!(diagnose(&format!("<?php {fine};")).is_empty(), "{fine}");
        }
    }

    #[test]
    fn completes_shows_and_checks_features_and_context_keys() {
        assert_eq!(labels(&complete("<?php \\Laravel\\Pennant\\Feature::active('<|>');")), vec!["new-api"]);
        assert_eq!(labels(&complete("<?php \\Laravel\\Pennant\\Feature::someAreActive(['<|>']);")), vec!["new-api"]);
        assert_eq!(labels(&complete("<?php \\Illuminate\\Support\\Facades\\Context::get('<|>');")), vec!["trace_id"]);
        let hover = at_cursor("<?php \\Laravel\\Pennant\\Feature::active('new-<|>api');", super::super::hover).unwrap();
        let lsp_types::HoverContents::Markup(m) = hover.contents else { panic!() };
        assert!(m.value.starts_with("Pennant feature, defined in [AppServiceProvider@boot]("), "{}", m.value);
        let found = at_cursor("<?php \\Illuminate\\Support\\Facades\\Context::get('trace<|>_id');", super::super::definition);
        assert_eq!(found[0].range.start.line, 6);
        assert_eq!(diagnose("<?php \\Laravel\\Pennant\\Feature::active('new-apy'); \\Laravel\\Pennant\\Feature::active('new-api'); \\Illuminate\\Support\\Facades\\Context::get('nope');"), vec!["Feature [new-apy] not found."]);
        // Pennant resolves a class's name as a class-based feature.
        assert!(diagnose("<?php \\Laravel\\Pennant\\Feature::active('App\\Features\\Beta');").is_empty());
    }

    #[test]
    fn completes_features_in_blade() {
        let fx = fixture_with(&[("vendor/more.php", VENDOR), ("app/Providers/AppServiceProvider.php", DEFINES), ("resources/views/home.blade.php", "@feature('<|>')\n@endfeature\n")]);
        let at = fx.at();
        let items = with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| crate::framework::completion(ctx, ctx.offset(at.position))).flatten().unwrap_or_default();
        assert_eq!(labels(&items), vec!["new-api"]);
    }
}
