//! A hint, off unless the `lazyLoadingHints` option turns it on, where a loop over a query's models reads a
//! relationship the query doesn't eager-load, so each pass runs a query of its own (the N+1 problem):
//!
//! ```php
//! foreach (Post::latest()->get() as $post) {
//!     echo $post->author->name;     // hint: add with('author')
//! }
//! Post::all()->each(fn ($post) => $post->author);
//! ```
//!
//! It's a heuristic: it only looks where the query is in view, in the same function or Blade view, as the loop's
//! expression or a variable assigned once from it, and it stays quiet when it can't tell what the query loads, such
//! as `with($relations)`. A model's `$with`, `load()` calls on the variable, and the app turning on
//! `Model::automaticallyEagerLoadRelationships()` count as eager-loading.

use std::collections::HashSet;

use lsp_types::{Diagnostic, DiagnosticSeverity, NumberOrString};
use mago_codex::ttype::atomic::TAtomic;
use mago_codex::ttype::atomic::object::TObject;
use mago_span::HasSpan;
use mago_syntax::cst::{Argument, ArgumentList, ArrayElement, Call, ClassLikeMemberSelector, Expression, ForeachTarget, Literal, Node, Variable};

use super::SOURCE;
use super::data::Data;
use super::relations::{Model, Models};
use crate::analysis::Parsed;
use crate::features::Ctx;

/// Calls that fetch a query's models.
const FETCH: &[&str] = &["get", "all", "paginate", "simplepaginate", "cursorpaginate", "cursor", "lazy", "lazybyid", "lazybyiddesc"];
/// Collection methods that keep the models a fetch gave.
const KEEP: &[&str] = &["filter", "reject", "where", "wherein", "wherenotin", "wherenull", "wherenotnull", "sortby", "sortbydesc", "sort", "values", "take", "skip", "reverse", "unique", "slice", "shuffle", "except", "only", "load", "loadmissing", "loadcount"];
/// Collection and builder methods that call a closure with each model.
const EACH: &[&str] = &["each", "map", "filter", "reject", "flatmap", "sortby", "sortbydesc", "sum", "every", "contains", "first", "groupby", "keyby", "mapwithkeys", "partition", "eachbyid"];
/// Calls that eager-load the relationships they name.
const LOADS: &[&str] = &["with", "load", "loadmissing", "withwherehas", "withonly"];

pub fn diagnostics(ctx: &Ctx<'_>, data: &Data<'_>) -> Vec<Diagnostic> {
    if !ctx.snap.framework.lazy_loading_hints() || ctx.index.eloquent.auto_eager_loads {
        return vec![];
    }
    let models = Models::new(data);
    let hints = if crate::features::is_blade(&ctx.doc) {
        let checked = super::blade::checked_php(&ctx.doc.text, &[]);
        let arena = mago_allocator::LocalArena::new();
        let parsed = Parsed::new(&arena, &ctx.doc.path, &checked.php);
        find(ctx, &models, &parsed, false)
            .into_iter()
            .filter_map(|(s, e, m)| Some((checked.view_offset(s as usize).ok()? as u32, checked.view_offset(e as usize).ok()? as u32, m)))
            .collect()
    } else {
        find(ctx, &models, &ctx.parsed, true)
    };
    hints
        .into_iter()
        .map(|(start, end, message)| Diagnostic {
            range: ctx.doc.range(start, end),
            severity: Some(DiagnosticSeverity::INFORMATION),
            code: Some(NumberOrString::String("lazy-loading".into())),
            source: Some(SOURCE.into()),
            message,
            ..Default::default()
        })
        .collect()
}

fn name_of<'a>(s: &ClassLikeMemberSelector<'a>) -> Option<String> {
    match s {
        ClassLikeMemberSelector::Identifier(id) => Some(String::from_utf8_lossy(id.value).to_ascii_lowercase()),
        _ => None,
    }
}

fn variable<'a>(e: &Expression<'a>) -> Option<&'a [u8]> {
    match e {
        Expression::Variable(Variable::Direct(v)) => Some(v.name),
        _ => None,
    }
}

/// A loop over models: the expression it iterates, the variable that holds each model, and the node of its body.
struct Loop<'a> {
    iterated: &'a Expression<'a>,
    var: &'a [u8],
    body: Node<'a, 'a>,
    /// The function, method, or closure the loop is in, or the whole file.
    scope: Node<'a, 'a>,
    /// The iterated expression fetches models, as a `foreach` needs, or is a builder, whose `each()` runs the query.
    needs_fetch: bool,
}

fn find(ctx: &Ctx<'_>, models: &Models, parsed: &Parsed<'_>, analysis: bool) -> Vec<(u32, u32, String)> {
    let mut loops = vec![];
    crate::locate::walk(parsed, |node, ancestors| {
        let scope = ancestors.iter().rev().find(|n| matches!(n, Node::Function(_) | Node::Method(_) | Node::Closure(_) | Node::ArrowFunction(_))).copied().unwrap_or(Node::Program(parsed.program));
        match node {
            Node::Foreach(f) => {
                let value = match &f.target {
                    ForeachTarget::Value(t) => t.value,
                    ForeachTarget::KeyValue(t) => t.value,
                };
                if let Some(var) = variable(value) {
                    loops.push(Loop { iterated: f.expression, var, body: Node::ForeachBody(&f.body), scope, needs_fetch: true });
                }
            }
            Node::MethodCall(c) if name_of(&c.method).is_some_and(|m| EACH.contains(&m.as_str())) => {
                let Some(Argument::Positional(first)) = c.argument_list.arguments.iter().next() else { return };
                let (params, body) = match first.value {
                    Expression::Closure(f) => (&f.parameter_list, Node::Block(&f.body)),
                    Expression::ArrowFunction(f) => (&f.parameter_list, Node::Expression(f.expression)),
                    _ => return,
                };
                let Some(p) = params.parameters.iter().next() else { return };
                loops.push(Loop { iterated: c.object, var: p.variable.name, body, scope, needs_fetch: false });
            }
            _ => {}
        }
    });
    let mut out = vec![];
    for l in loops {
        let Some((model, loaded)) = query_of(ctx, models, parsed, analysis, l.iterated, l.scope, l.needs_fetch) else { continue };
        out.extend(lazy_reads(ctx, models, &l, model, &loaded));
    }
    out
}

/// The model a visible query fetches and the relationships it eager-loads, with every prefix of a dotted path.
fn query_of(ctx: &Ctx<'_>, models: &Models, parsed: &Parsed<'_>, analysis: bool, iterated: &Expression<'_>, scope: Node<'_, '_>, needs_fetch: bool) -> Option<(Model, HashSet<String>)> {
    let mut loaded = HashSet::new();
    let mut expr = iterated;
    // A variable assigned once in the function, from the query, and loaded more with `->load()`.
    if let Some(var) = variable(iterated) {
        let mut assigned = vec![];
        let mut unknown = false;
        walk(scope, &mut |n| {
            match n {
                Node::Assignment(a) if variable(a.lhs) == Some(var) => assigned.push(a.rhs),
                Node::MethodCall(c) if variable(c.object) == Some(var) && name_of(&c.method).is_some_and(|m| LOADS.contains(&m.as_str())) => unknown |= !paths(&c.argument_list, &mut loaded),
                // Passed by reference, or captured by reference, it may change anywhere.
                Node::ClosureUseClauseVariable(u) if u.variable.name == var && u.ampersand.is_some() => unknown = true,
                _ => {}
            }
            true
        });
        let [rhs] = assigned.as_slice() else { return None };
        if unknown {
            return None;
        }
        expr = rhs;
    }
    let (mut fetched, mut root) = (false, None);
    let mut outer: Vec<String> = vec![];
    let mut e = expr;
    loop {
        match e {
            Expression::Call(Call::Method(c)) => {
                let method = name_of(&c.method)?;
                if LOADS.contains(&method.as_str()) && !paths(&c.argument_list, &mut loaded) {
                    return None;
                }
                // Outside the fetch, a collection method that changes what it holds, such as `map()`, ends the models.
                outer.push(method.clone());
                fetched |= FETCH.contains(&method.as_str());
                e = c.object;
            }
            Expression::Call(Call::StaticMethod(c)) => {
                let method = name_of(&c.method)?;
                if LOADS.contains(&method.as_str()) && !paths(&c.argument_list, &mut loaded) {
                    return None;
                }
                fetched |= FETCH.contains(&method.as_str());
                if let Expression::Identifier(id) = c.class {
                    root = parsed.names.resolve(&id.span()).map(|n| String::from_utf8_lossy(n).into_owned());
                }
                break;
            }
            Expression::Parenthesized(p) => e = p.expression,
            _ => break,
        }
    }
    if needs_fetch && !fetched {
        return None;
    }
    if let Some(at) = outer.iter().position(|m| FETCH.contains(&m.as_str()))
        && !outer[..at].iter().all(|m| KEEP.contains(&m.as_str()))
    {
        return None;
    }
    // A query that starts at a relationship, such as `$user->posts()->get()`, from what the analysis says it gives.
    // Only for the document itself, whose analysis the context has.
    let typed = analysis.then(|| ctx.analysis()).and_then(|a| {
        let span = iterated.span();
        let t = a.type_of(span.start.offset, span.end.offset)?;
        t.types.iter().find_map(|atomic| match atomic {
            TAtomic::Object(TObject::Named(n)) => n.type_parameters.iter().flatten().flat_map(|p| crate::types::class_names(p, &ctx.index.codebase)).find_map(|c| models.get(ctx, &c)),
            _ => None,
        })
    });
    if typed.is_none() && root.is_none() {
        return None;
    }
    let model = typed.or_else(|| models.get(ctx, root.as_deref()?))?;
    // The relationships the model's `$with` loads for every query.
    for decl in ctx.index.eloquent.decls(&ctx.index.codebase, &model.class) {
        for path in decl.eager.as_ref()? {
            add_path(&mut loaded, path);
        }
    }
    Some((model, loaded))
}

fn add_path(loaded: &mut HashSet<String>, path: &str) {
    let path = path.split(':').next().unwrap_or(path).trim();
    let mut prefix = String::new();
    for segment in path.split('.') {
        if !prefix.is_empty() {
            prefix.push('.');
        }
        prefix.push_str(segment);
        loaded.insert(prefix.clone());
    }
}

/// Adds the relationships a `with()` or `load()` names; false when one isn't a literal.
fn paths(list: &ArgumentList<'_>, loaded: &mut HashSet<String>) -> bool {
    let literal = |e: &Expression<'_>| match e {
        Expression::Literal(Literal::String(s)) => s.value.map(|v| String::from_utf8_lossy(v).into_owned()),
        _ => None,
    };
    for a in list.arguments.iter() {
        let Argument::Positional(p) = a else { return false };
        match p.value {
            Expression::Array(arr) => {
                for el in arr.elements.iter() {
                    let found = match el {
                        ArrayElement::Value(v) => literal(v.value),
                        ArrayElement::KeyValue(kv) => literal(kv.key),
                        _ => None,
                    };
                    match found {
                        Some(path) => add_path(loaded, &path),
                        None => return false,
                    }
                }
            }
            other => match literal(other) {
                Some(path) => add_path(loaded, &path),
                None => return false,
            },
        }
    }
    true
}

fn walk<'a>(node: Node<'a, 'a>, f: &mut impl FnMut(Node<'a, 'a>) -> bool) {
    if f(node) {
        node.visit_children(|child| walk(child, f));
    }
}

/// The relationships the loop's body reads on its variable without the query loading them: each path once, at its
/// first read.
fn lazy_reads(ctx: &Ctx<'_>, models: &Models, l: &Loop<'_>, model: Model, loaded: &HashSet<String>) -> Vec<(u32, u32, String)> {
    let var = l.var;
    let mut reassigned = false;
    let mut accesses: Vec<(Vec<Read>, u32)> = vec![];
    let mut written: Vec<u32> = vec![];
    walk(l.body, &mut |n| {
        match n {
            Node::Assignment(a) => {
                reassigned |= variable(a.lhs) == Some(var);
                written.push(a.lhs.span().start.offset);
            }
            Node::Expression(e) => {
                if let Some(chain) = property_chain(e, var) {
                    accesses.push((chain, e.span().start.offset));
                }
            }
            _ => {}
        }
        true
    });
    if reassigned {
        return vec![];
    }
    let mut seen = HashSet::new();
    let mut out = vec![];
    let noun = model.class.rsplit('\\').next().unwrap_or(&model.class).to_ascii_lowercase();
    for (chain, at) in accesses {
        if written.contains(&at) {
            continue;
        }
        let mut on = model.clone();
        let mut path = String::new();
        for (name, start, end) in chain {
            let Some(r) = on.relation(&name).cloned() else { break };
            if on.attributes.iter().any(|a| a.name == name) {
                break;
            }
            if !path.is_empty() {
                path.push('.');
            }
            path.push_str(&name);
            if !loaded.contains(&path) {
                if seen.insert(path.clone()) {
                    out.push((start, end, format!("Reading `{name}` here runs a query for each {noun}: the query doesn't eager-load it. Add `with('{path}')` to it.")));
                }
                break;
            }
            match r.related.as_deref().and_then(|c| models.get(ctx, c)) {
                Some(next) => on = next,
                None => break,
            }
        }
    }
    out
}

/// A property read: its name, and where the name starts and ends.
type Read = (String, u32, u32);

/// `$post->author->company` as `[author, company]` with each name's span, for a chain of property reads on `var`.
fn property_chain(e: &Expression<'_>, var: &[u8]) -> Option<Vec<Read>> {
    let mut names = vec![];
    let mut cur = e;
    loop {
        match cur {
            Expression::Access(mago_syntax::cst::Access::Property(a)) => {
                let ClassLikeMemberSelector::Identifier(id) = &a.property else { return None };
                names.push((String::from_utf8_lossy(id.value).into_owned(), id.span.start.offset, id.span.end.offset));
                cur = a.object;
            }
            Expression::Access(mago_syntax::cst::Access::NullSafeProperty(a)) => {
                let ClassLikeMemberSelector::Identifier(id) = &a.property else { return None };
                names.push((String::from_utf8_lossy(id.value).into_owned(), id.span.start.offset, id.span.end.offset));
                cur = a.object;
            }
            Expression::Variable(Variable::Direct(v)) if v.name == var && !names.is_empty() => break,
            _ => return None,
        }
    }
    names.reverse();
    Some(names)
}
