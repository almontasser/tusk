//! Route parameters: the keys of the parameters `route()`, `to_route()`, `action()`, and the URL generator's and
//! redirector's calls like them pass, from the route's URI (`{post}`, `{post?}`, `{post:slug}`).
//!
//! A required parameter left out is reported only when the call's parameters are sure: an array of plain string
//! keys, or none at all. Laravel fills required parameters from positional values and from `URL::defaults()`
//! too, so any positional value, spread, or other expression turns the check off, and so do the keys the project's
//! `defaults()` calls fill, or any such call whose keys aren't plain.

use lsp_types::{CompletionItem, CompletionItemKind, Diagnostic, DiagnosticSeverity, NumberOrString};
use mago_span::HasSpan;
use mago_syntax::cst::{Argument, ArrayElement, Expression, Node};
use serde_json::Value;

use super::facts::{Fact, facts};
use super::{Data, REDIRECTORS, SOURCE, completion_item, replacement};
use crate::features::Ctx;
use crate::framework::{Call, InArray, StringArg};

/// A parameter in a route's URI.
#[derive(Debug, PartialEq, Eq)]
struct Parameter {
    name: String,
    optional: bool,
    /// The column a model binds by, as in `{post:slug}`.
    field: Option<String>,
}

/// The parameters in a URI, in order.
fn uri_parameters(uri: &str) -> Vec<Parameter> {
    let mut out = vec![];
    let mut rest = uri;
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}') else { break };
        let inner = &rest[open + 1..open + close];
        let (inner, optional) = inner.strip_suffix('?').map_or((inner, false), |i| (i, true));
        let (name, field) = inner.split_once(':').map_or((inner, None), |(n, f)| (n, Some(f.to_string())));
        out.push(Parameter { name: name.to_string(), optional, field });
        rest = &rest[open + close + 1..];
    }
    out
}

/// Which argument of a route URL call holds its parameters, and whether it names the route by its controller
/// action rather than its name.
fn parameters_index(call: &Call, codebase: &mago_codex::metadata::CodebaseMetadata) -> Option<(usize, bool)> {
    let on = || call.on(codebase, REDIRECTORS);
    if call.is_function(&["route", "to_route"]) || (call.is_method(&["route", "signedRoute", "redirectToRoute"]) && on()) {
        Some((1, false))
    } else if call.is_method(&["temporarySignedRoute"]) && on() {
        Some((2, false))
    } else if call.is_function(&["action", "to_action"]) || (call.is_method(&["action", "redirectToAction"]) && on()) {
        Some((1, true))
    } else {
        None
    }
}

/// The arguments of the call at `span` in the parsed file: each one's name if named, its value, and whether it's
/// spread.
fn arguments<'a>(ctx: &Ctx<'a>, span: (u32, u32)) -> Option<Vec<(Option<String>, &'a Expression<'a>, bool)>> {
    let path = ctx.parsed.path_at(span.0);
    let list = path.iter().rev().find_map(|n| {
        let s = n.span();
        if (s.start.offset, s.end.offset) != span {
            return None;
        }
        match n {
            Node::FunctionCall(c) => Some(&c.argument_list),
            Node::MethodCall(c) => Some(&c.argument_list),
            Node::NullSafeMethodCall(c) => Some(&c.argument_list),
            Node::StaticMethodCall(c) => Some(&c.argument_list),
            _ => None,
        }
    })?;
    Some(
        list.arguments
            .iter()
            .map(|a| match a {
                Argument::Positional(p) => (None, p.value, p.ellipsis.is_some()),
                Argument::Named(n) => (Some(String::from_utf8_lossy(n.name.value).into_owned()), n.value, false),
            })
            .collect(),
    )
}

fn plain_string(ctx: &Ctx<'_>, expr: &Expression<'_>) -> Option<String> {
    let Expression::Literal(mago_syntax::cst::Literal::String(s)) = expr else { return None };
    let (start, end) = (s.span.start.offset + 1, s.span.end.offset.saturating_sub(1));
    (start <= end).then(|| ctx.parsed.text()[start as usize..end as usize].to_string())
}

/// The route a call names: by its name, or by its controller action, `'PostController@show'` or
/// `[PostController::class, 'show']`, matched as the routes list name actions, by the end of the class's name.
fn route_of<'v>(ctx: &Ctx<'_>, call: &Call, action: bool, routes: &'v Value) -> Option<&'v Value> {
    let routes = routes.as_array()?;
    if !action {
        let name = call.arguments.first()?.1.as_deref()?;
        return routes.iter().find(|r| r["name"].as_str() == Some(name));
    }
    let wanted = match call.arguments.first()?.1.clone() {
        Some(s) => s.trim_start_matches('\\').replace("\\\\", "\\"),
        None => {
            let args = arguments(ctx, call.span)?;
            let Expression::Array(a) = args.first()?.1 else { return None };
            let mut elements = a.elements.iter().map(|e| match e {
                ArrayElement::Value(v) => Some(v.value),
                _ => None,
            });
            let class = match elements.next()?? {
                Expression::Access(mago_syntax::cst::Access::ClassConstant(c)) => {
                    let Expression::Identifier(id) = c.class else { return None };
                    String::from_utf8_lossy(ctx.parsed.names.resolve(&id.span())?).trim_start_matches('\\').to_string()
                }
                _ => return None,
            };
            match elements.next().flatten().and_then(|m| plain_string(ctx, m)) {
                Some(m) => format!("{class}@{m}"),
                None => class,
            }
        }
    };
    let matches = |a: &str| {
        let a = a.strip_suffix("@__invoke").filter(|_| !wanted.contains('@')).unwrap_or(a);
        a == wanted || a.ends_with(&format!("\\{wanted}"))
    };
    // A later route with the same action replaces an earlier one, as in Laravel's list of routes by action.
    routes.iter().rev().find(|r| r["action"].as_str().is_some_and(matches))
}

/// A route's parameters: those in its URI, then others it lists, such as its domain's, which may be optional.
fn route_parameters(route: &Value) -> Vec<Parameter> {
    let mut out = uri_parameters(route["uri"].as_str().unwrap_or(""));
    for name in route["parameters"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        if !out.iter().any(|p| p.name == name) {
            out.push(Parameter { name: name.to_string(), optional: true, field: None });
        }
    }
    out
}

fn describe(p: &Parameter) -> String {
    let mut out = if p.optional { "optional".to_string() } else { "required".to_string() };
    if let Some(f) = &p.field {
        out.push_str(&format!(", binds by `{f}`"));
    }
    out
}

/// The route parameters a string in a route URL call's parameters can be a key of.
fn site<'v>(ctx: &Ctx<'_>, arg: &StringArg, routes: &'v Value, typing: bool) -> Option<(&'v Value, Vec<Parameter>)> {
    let (index, action) = parameters_index(&arg.call, &ctx.index.codebase)?;
    let named = arg.name.as_deref() == Some("parameters");
    // A value with no key yet is a key being typed.
    let key = arg.in_array == Some(InArray::Key) || (typing && arg.in_array == Some(InArray::Value(None)));
    if !key || !(named || (arg.name.is_none() && arg.index == index)) {
        return None;
    }
    let route = route_of(ctx, &arg.call, action, routes)?;
    Some((route, route_parameters(route)))
}

pub(super) fn completion(ctx: &Ctx<'_>, data: &Data<'_>, arg: &StringArg, offset: u32) -> Option<Vec<CompletionItem>> {
    let routes = data.routes()?;
    let (_, parameters) = site(ctx, arg, &routes, true)?;
    let range = replacement(ctx, arg.start, offset);
    Some(
        parameters
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let mut item = completion_item(&p.name, Some(CompletionItemKind::VARIABLE), range);
                item.detail = Some(describe(p).replace('`', ""));
                item.sort_text = Some(format!("{i:03}"));
                item
            })
            .collect(),
    )
}

pub(super) fn hover(ctx: &Ctx<'_>, data: &Data<'_>, arg: &StringArg) -> Option<String> {
    let routes = data.routes()?;
    let (route, parameters) = site(ctx, arg, &routes, false)?;
    let p = parameters.iter().find(|p| p.name == arg.value)?;
    let name = route["name"].as_str().map(|n| format!(" of `{n}`")).unwrap_or_default();
    Some(format!("Route parameter{name}, {}\n\n[{}] {}", describe(p), route["method"].as_str().unwrap_or(""), route["uri"].as_str().unwrap_or("")))
}

/// The keys a call's parameters surely give, and the span of its parameters, if it passes any.
type Given = (Vec<String>, Option<(u32, u32)>);

/// The keys the call's parameters surely give, or `None` when they may give more: anything but an array of
/// plain string keys, or nothing.
fn given_keys(ctx: &Ctx<'_>, call: &Call, index: usize) -> Option<Given> {
    let args = arguments(ctx, call.span)?;
    if args.iter().any(|(_, _, spread)| *spread) {
        return None;
    }
    let named = args.iter().any(|(n, _, _)| n.is_some());
    let given = if named { args.iter().find(|(n, _, _)| n.as_deref() == Some("parameters")) } else { args.get(index) };
    let Some((_, expr, _)) = given else { return Some((vec![], None)) };
    let elements = match expr {
        Expression::Array(a) => &a.elements,
        Expression::LegacyArray(a) => &a.elements,
        _ => return None,
    };
    let keys = elements
        .iter()
        .map(|e| match e {
            ArrayElement::KeyValue(kv) => plain_string(ctx, kv.key),
            _ => None,
        })
        .collect::<Option<Vec<String>>>()?;
    Some((keys, Some((expr.span().start.offset, expr.span().end.offset))))
}

/// Required parameters a route URL call leaves out, for each call whose route name is a plain string.
pub(super) fn diagnostics(ctx: &Ctx<'_>, data: &Data<'_>, args: &[StringArg]) -> Vec<Diagnostic> {
    let codebase = &ctx.index.codebase;
    let mut calls: Vec<(&StringArg, usize, bool)> = args
        .iter()
        .filter(|a| a.index == 0 && a.name.is_none() && !a.value.contains('$'))
        .filter_map(|a| parameters_index(&a.call, codebase).map(|(i, action)| (a, i, action)))
        // A route's name is the argument itself, and an action may be `[Controller::class, 'method']`.
        .filter(|(a, _, action)| a.in_array.is_none() || (*action && a.in_array == Some(InArray::Value(None))))
        .collect();
    calls.dedup_by_key(|(a, _, _)| a.call.span);
    if calls.is_empty() {
        return vec![];
    }
    let Some(routes) = data.routes() else { return vec![] };
    let facts = facts(ctx.snap, &ctx.index);
    let mut defaults: Vec<String> = vec![];
    for (fact, _) in facts.iter() {
        match fact {
            Fact::Defaults { keys: Some(keys) } => defaults.extend(keys.iter().cloned()),
            // Fills parameters no one can tell.
            Fact::Defaults { keys: None } => return vec![],
            _ => {}
        }
    }
    let mut out = vec![];
    for (arg, index, action) in calls {
        let Some(route) = route_of(ctx, &arg.call, action, &routes) else { continue };
        let Some((keys, span)) = given_keys(ctx, &arg.call, index) else { continue };
        let listed: Vec<&str> = route["parameters"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        let missing: Vec<String> = uri_parameters(route["uri"].as_str().unwrap_or(""))
            .into_iter()
            .filter(|p| !p.optional && listed.contains(&p.name.as_str()) && !keys.contains(&p.name))
            .filter(|p| !defaults.iter().any(|d| *d == p.name || p.field.as_ref().is_some_and(|f| *d == format!("{}:{f}", p.name))))
            .map(|p| p.name)
            .collect();
        if missing.is_empty() {
            continue;
        }
        let (start, end) = span.unwrap_or((arg.start, arg.end));
        let route_name = route["name"].as_str().unwrap_or(&arg.value);
        out.push(Diagnostic {
            range: ctx.doc.range(start, end),
            severity: Some(DiagnosticSeverity::WARNING),
            code: Some(NumberOrString::String("routeParameter".into())),
            source: Some(SOURCE.into()),
            message: format!("Missing required parameter{} [{}] for route [{route_name}].", if missing.len() > 1 { "s" } else { "" }, missing.join(", ")),
            ..Default::default()
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framework::laravel::tests::{fixture_with, labels};
    use serde_json::json;

    #[test]
    fn reads_uri_parameters() {
        let p = uri_parameters("teams/{team}/posts/{post:slug}/{page?}");
        assert_eq!(
            p,
            vec![
                Parameter { name: "team".into(), optional: false, field: None },
                Parameter { name: "post".into(), optional: false, field: Some("slug".into()) },
                Parameter { name: "page".into(), optional: true, field: None },
            ]
        );
    }

    /// Laravel's helpers and facades for route URLs that the shared stubs leave out.
    const HELPERS: &str = "<?php\nnamespace Illuminate\\Support\\Facades { class URL {} }\nnamespace { function to_route($route, $parameters = []) {} function action($name, $parameters = []) {} function now() {} }\n";

    fn with_routes(file: &str, text: &str) -> crate::testing::Fixture {
        let fx = fixture_with(&[("vendor/helpers.php", HELPERS), (file, text)]);
        seed_routes(&fx);
        fx
    }

    fn seed_routes(fx: &crate::testing::Fixture) {
        fx.snap.framework.seed(
            "laravel:routes",
            json!([
                {"method": "GET", "uri": "teams/{team}/posts/{post:slug}/{page?}", "name": "posts.show", "action": "App\\Http\\Controllers\\PostController@show", "parameters": ["team", "post", "page"], "filename": "routes/web.php", "line": 4},
                {"method": "GET", "uri": "/", "name": "home", "action": "App\\Http\\Controllers\\HomeController", "parameters": [], "filename": "routes/web.php", "line": 2},
                {"method": "GET", "uri": "{account}/dash", "name": "dash", "action": "Closure", "parameters": ["account", "sub"], "filename": "routes/web.php", "line": 6},
            ]),
        );
    }

    fn complete_routes(text: &str) -> Vec<CompletionItem> {
        let fx = with_routes("t.php", text);
        let at = fx.at();
        crate::features::with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| crate::framework::completion(ctx, ctx.offset(at.position))).flatten().unwrap_or_default()
    }

    fn diagnose(text: &str) -> Vec<String> {
        let fx = with_routes("t.php", text);
        crate::features::with_ctx(&fx.snap, &crate::testing::uri("t.php"), super::super::diagnostics)
            .unwrap()
            .into_iter()
            .filter(|d| d.code == Some(NumberOrString::String("routeParameter".into())))
            .map(|d| d.message)
            .collect()
    }

    #[test]
    fn completes_and_shows_parameters_from_the_uri() {
        let items = complete_routes("<?php route('posts.show', ['<|>' => 1]);");
        assert_eq!(items.iter().map(|i| (i.label.as_str(), i.detail.as_deref().unwrap())).collect::<Vec<_>>(), vec![("team", "required"), ("post", "required, binds by slug"), ("page", "optional")]);
        for call in [
            "to_route('posts.show', ['<|>'])",
            "redirect()->route('posts.show', ['<|>'])",
            "\\Illuminate\\Support\\Facades\\URL::temporarySignedRoute('posts.show', now(), ['<|>'])",
            "\\Illuminate\\Support\\Facades\\URL::signedRoute('posts.show', ['<|>'])",
            "route('posts.show', parameters: ['<|>'])",
            "action([\\App\\Http\\Controllers\\PostController::class, 'show'], ['<|>'])",
            "action('PostController@show', ['<|>'])",
        ] {
            assert_eq!(complete_routes(&format!("<?php {call};")).len(), 3, "{call}");
        }
        // Not the expiration of a temporary signed route.
        assert!(complete_routes("<?php \\Illuminate\\Support\\Facades\\URL::temporarySignedRoute('posts.show', ['<|>']);").is_empty());
        // A domain's parameter, from the route's list.
        assert_eq!(labels(&complete_routes("<?php route('dash', ['<|>']);")), vec!["account", "sub"]);

        let fx = with_routes("t.php", "<?php route('posts.show', ['po<|>st' => 1]);");
        let at = fx.at();
        let hover = crate::features::with_ctx(&fx.snap, &at.text_document.uri, |ctx| super::super::hover(ctx, ctx.offset(at.position))).flatten().unwrap();
        let lsp_types::HoverContents::Markup(m) = hover.contents else { panic!() };
        assert_eq!(m.value, "Route parameter of `posts.show`, required, binds by `slug`\n\n[GET] teams/{team}/posts/{post:slug}/{page?}");
    }

    #[test]
    fn reports_required_parameters_left_out_only_when_sure() {
        assert_eq!(diagnose("<?php route('posts.show', ['team' => 1]);"), vec!["Missing required parameter [post] for route [posts.show]."]);
        assert_eq!(diagnose("<?php to_route('posts.show');"), vec!["Missing required parameters [team, post] for route [posts.show]."]);
        assert_eq!(diagnose("<?php action([\\App\\Http\\Controllers\\PostController::class, 'show'], ['post' => 1]);"), vec!["Missing required parameter [team] for route [posts.show]."]);
        let fine = [
            "route('posts.show', ['team' => 1, 'post' => 2])",
            "route('posts.show', ['team' => 1, 'post' => 2, 'q' => 'x'])",
            // Positional values fill the rest.
            "route('posts.show', [1, 2])",
            "route('posts.show', ['team' => 1, $post])",
            "route('posts.show', $post)",
            "route('posts.show', [...$all])",
            "route('posts.show', compact('team', 'post'))",
            "route($name, [])",
            "route('home')",
            // A domain's parameter isn't in the URI.
            "route('dash', ['account' => 1])",
            "route('missing', [])",
            "\\Illuminate\\Support\\Facades\\URL::temporarySignedRoute('posts.show', now(), ['team' => 1, 'post' => 2])",
        ];
        for call in fine {
            assert!(diagnose(&format!("<?php {call};")).is_empty(), "{call}");
        }
    }

    #[test]
    fn counts_the_keys_url_defaults_fill() {
        let count = |defaults: &str| {
            let middleware = format!("<?php\nuse Illuminate\\Support\\Facades\\URL;\n{defaults}\n");
            let fx = fixture_with(&[("vendor/helpers.php", HELPERS), ("t.php", "<?php route('posts.show', ['post' => 1]);"), ("app/Http/Middleware/Defaults.php", &middleware)]);
            seed_routes(&fx);
            crate::features::with_ctx(&fx.snap, &crate::testing::uri("t.php"), super::super::diagnostics).unwrap().len()
        };
        assert_eq!(count("URL::defaults(['team' => 1]);"), 0);
        assert_eq!(count("URL::defaults(['locale' => 1]);"), 1);
        assert_eq!(count("URL::defaults($request->all());"), 0);
    }
}
