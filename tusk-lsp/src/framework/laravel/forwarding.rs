//! Eloquent's forwarded calls in the analysis. A model passes a method it doesn't have to a new query on its
//! builder (`Model::__call()`, and `__callStatic()` for a static call), and the builder passes one it doesn't have
//! to the model's scopes. Laravel declares neither, so Mago types `Post::where()`, `$post->where()`, and
//! `Post::query()->published()` as `mixed`, and everything after them too. [`ForwardHook`] types them as they run:
//! as the builder's method with the builder's `TModel` bound to the model, or a scope's builder.

use std::cell::RefCell;

use mago_analyzer::code::IssueCode;
use mago_analyzer::plugin::{ExpressionHook, HookContext, HookResult, IssueFilterDecision, IssueFilterHook, Provider, ProviderMeta};
use mago_codex::metadata::CodebaseMetadata;
use mago_codex::identifier::method::MethodIdentifier;
use mago_codex::metadata::function_like::FunctionLikeMetadata;
use mago_codex::misc::GenericParent;
use mago_codex::ttype::atomic::TAtomic;
use mago_codex::ttype::atomic::object::TObject;
use mago_codex::ttype::atomic::object::named::TNamedObject;
use mago_codex::ttype::expander::{StaticClassType, TypeExpansionOptions, expand_union};
use mago_codex::ttype::get_mixed;
use mago_codex::ttype::template::TemplateResult;
use mago_codex::ttype::template::inferred_type_replacer;
use mago_codex::ttype::union::TUnion;
use mago_database::file::File;
use mago_reporting::{AnnotationKind, Issue};
use mago_span::HasSpan;
use mago_syntax::cst::{Argument, ArgumentList, Call, ClassLikeMemberSelector, Expression};
use mago_word::Word;

pub const MODEL: &str = "Illuminate\\Database\\Eloquent\\Model";
pub const ELOQUENT_BUILDER: &str = "Illuminate\\Database\\Eloquent\\Builder";
const QUERY_BUILDER: &str = "Illuminate\\Database\\Query\\Builder";

thread_local! {
    /// While a file is analyzed, its resolved class names by where they start: hooks see a static call's class only
    /// as written.
    static NAMES: RefCell<Vec<(u32, Box<[u8]>)>> = const { RefCell::new(vec![]) };
    /// This file's forwarded calls, which Mago reports as calls to methods that may not exist: where each starts and
    /// ends, and its method's name in lowercase.
    static FORWARDED: RefCell<Vec<(u32, u32, String)>> = const { RefCell::new(vec![]) };
}

/// Runs `f`, an analysis of a file, with the file's resolved names, from `(start, name)` pairs.
pub fn with_names<T>(names: impl Iterator<Item = (u32, Box<[u8]>)>, f: impl FnOnce() -> T) -> T {
    let mut names: Vec<_> = names.collect();
    names.sort_unstable_by_key(|(at, _)| *at);
    NAMES.set(names);
    FORWARDED.take();
    let out = f();
    NAMES.take();
    FORWARDED.take();
    out
}

fn resolved_name(at: u32) -> Option<Box<[u8]>> {
    NAMES.with_borrow(|names| names.binary_search_by_key(&at, |(a, _)| *a).ok().map(|i| names[i].1.clone()))
}

pub struct ForwardHook;

impl Provider for ForwardHook {
    fn meta() -> &'static ProviderMeta {
        static META: ProviderMeta = ProviderMeta::new("tusk-eloquent-forwarding", "Eloquent forwarding", "Types a model's forwarded builder calls and a builder's scopes.");
        &META
    }
}

impl ExpressionHook for ForwardHook {
    fn after_expression(&self, expr: &Expression<'_>, context: &mut HookContext<'_, '_>) -> HookResult<()> {
        let (model, method, arguments, through_builder) = match expr {
            Expression::Call(Call::StaticMethod(c)) => {
                let class = match c.class {
                    Expression::Identifier(id) => resolved_name(id.span().start.offset).map(|n| String::from_utf8_lossy(&n).into_owned()),
                    Expression::Static(_) | Expression::Self_(_) => context.current_class_name().map(|c| c.as_str_lossy().into_owned()),
                    _ => None,
                };
                let Some(class) = class else { return Ok(()) };
                (class, &c.method, &c.argument_list, false)
            }
            Expression::Call(Call::Method(c)) => {
                let Some(receiver) = context.get_expression_type(c.object).and_then(single_object) else { return Ok(()) };
                let builder = context.is_instance_of(receiver.name.as_bytes(), ELOQUENT_BUILDER.as_bytes());
                let class = if builder { builder_model(&receiver) } else { Some(receiver.name.as_str_lossy().into_owned()) };
                let Some(class) = class else { return Ok(()) };
                (class, &c.method, &c.argument_list, builder)
            }
            _ => return Ok(()),
        };
        let ClassLikeMemberSelector::Identifier(name) = method else { return Ok(()) };
        if !context.is_instance_of(model.as_bytes(), MODEL.as_bytes()) {
            return Ok(());
        }
        let codebase = context.codebase();
        let Some(model) = codebase.get_class_like(model.as_bytes()).map(|m| m.original_name) else { return Ok(()) };
        // A `#[Scope]` method is protected, so outside the model a call to it is forwarded too; inside, PHP calls it.
        let inside = context.current_class_name().is_some_and(|c| context.is_instance_of(c.as_bytes(), model.as_bytes()));
        let scope = is_scope(codebase, model, name.value) && !(inside && codebase.method_exists(model.as_bytes(), name.value));
        // Otherwise only what Mago couldn't type: a model's own methods, `@method` tags, and mixins already answer.
        if !scope && context.get_expression_type(expr).is_some_and(|t| !t.is_mixed()) {
            return Ok(());
        }
        let builder = builder_of(codebase, model);
        let t = if scope {
            Some(builder.clone())
        } else if through_builder {
            None
        } else {
            forwarded(context, &builder, model, name.value, arguments)
        };
        if let Some(t) = t {
            let span = expr.span();
            FORWARDED.with_borrow_mut(|f| f.push((span.start.offset, span.end.offset, String::from_utf8_lossy(name.value).to_lowercase())));
            context.set_expression_type(expr, t);
        }
        Ok(())
    }
}

impl IssueFilterHook for ForwardHook {
    /// Laravel has the forwarded method, so the report that it may not exist goes.
    fn filter_issue(&self, _: &File, issue: &Issue) -> HookResult<IssueFilterDecision> {
        // Also that a `#[Scope]` method is protected and not static: Laravel calls it on the builder.
        let codes = [IssueCode::NonDocumentedMethod, IssueCode::InvalidMethodAccess, IssueCode::InvalidStaticMethodAccess];
        if !codes.iter().any(|c| issue.code.as_deref() == Some(c.as_str())) {
            return Ok(IssueFilterDecision::Keep);
        }
        let Some(at) = issue.annotations.iter().find(|a| a.kind == AnnotationKind::Primary).map(|a| a.span.start.offset) else { return Ok(IssueFilterDecision::Keep) };
        // Mago names the method, as `name` or `Class::name`, and reports it within the call.
        let message = issue.message.to_lowercase();
        let forwarded = FORWARDED.with_borrow(|f| f.iter().any(|(start, end, method)| *start <= at && at < *end && (message.contains(&format!("`{method}`")) || message.contains(&format!("::{method}`")))));
        Ok(if forwarded { IssueFilterDecision::Remove } else { IssueFilterDecision::Keep })
    }
}

fn single_object(t: &TUnion) -> Option<TNamedObject> {
    match t.types.as_ref() {
        [TAtomic::Object(TObject::Named(n))] => Some(n.clone()),
        _ => None,
    }
}

/// The model of a `Builder<Post>`.
fn builder_model(builder: &TNamedObject) -> Option<String> {
    let model = builder.get_type_parameters()?.first()?;
    single_object(model).map(|n| n.name.as_str_lossy().into_owned())
}

/// The builder a model's queries use: what its `newEloquentBuilder()` returns when it declares a builder of its
/// own, else Eloquent's `Builder<Model>`.
fn builder_of(codebase: &CodebaseMetadata, model: Word) -> TUnion {
    let own = codebase
        .get_method(model.as_bytes(), b"newEloquentBuilder")
        .and_then(|m| m.return_type_metadata.as_ref())
        .and_then(|t| single_object(&t.type_union))
        .filter(|b| !b.name.as_bytes().eq_ignore_ascii_case(ELOQUENT_BUILDER.as_bytes()) && codebase.class_extends(b.name.as_bytes(), ELOQUENT_BUILDER.as_bytes()));
    let builder = own.unwrap_or_else(|| {
        let name = codebase.get_class_like(ELOQUENT_BUILDER.as_bytes()).map_or_else(|| mago_word::word(ELOQUENT_BUILDER), |b| b.original_name);
        TNamedObject::new_with_type_parameters(name, Some(vec![object(model)]))
    });
    TUnion::from_atomic(TAtomic::Object(TObject::Named(builder)))
}

fn object(name: Word) -> TUnion {
    TUnion::from_atomic(TAtomic::Object(TObject::Named(TNamedObject::new(name))))
}

/// Whether `method` is a local scope of `model`: a `scopeName()` method, or one with Laravel 12's `#[Scope]`.
fn is_scope(codebase: &CodebaseMetadata, model: Word, method: &[u8]) -> bool {
    if codebase.method_exists(model.as_bytes(), &[b"scope", method].concat()) {
        return true;
    }
    codebase.get_method(model.as_bytes(), method).is_some_and(|m| m.attributes.iter().any(|a| a.name.as_bytes().eq_ignore_ascii_case(b"Illuminate\\Database\\Eloquent\\Attributes\\Scope")))
}

/// The type of `method` called on `builder`, a query of `model`, as Eloquent's builder runs it: its own method, or
/// the query builder's, which returns the Eloquent builder where it returns itself.
fn forwarded(context: &HookContext<'_, '_>, builder: &TUnion, model: Word, method: &[u8], arguments: &ArgumentList<'_>) -> Option<TUnion> {
    let codebase = context.codebase();
    let builder_name = single_object(builder)?.name;
    let (declaring, f) = [builder_name.as_bytes(), QUERY_BUILDER.as_bytes()].into_iter().find_map(|class| inherited_method(codebase, class, method))?;
    let declared = f.return_type_metadata.as_ref()?.type_union.clone();
    let declared = branch(context, f, &declared, arguments);
    let templates = bound_templates(codebase, builder, model);
    let mut t = inferred_type_replacer::replace(&declared, &templates, codebase);
    let static_type = StaticClassType::Object(single_object(builder).map(TObject::Named)?);
    expand_union(codebase, &mut t, &TypeExpansionOptions { self_class: declaring, static_class_type: static_type, ..Default::default() });
    // The query builder returns the Eloquent builder where it returns itself.
    let t = TUnion::from_vec(t.types.iter().map(|a| match a {
        TAtomic::Object(TObject::Named(n)) if n.name.as_bytes().eq_ignore_ascii_case(QUERY_BUILDER.as_bytes()) => builder.types[0].clone(),
        _ => a.clone(),
    }).collect());
    Some(without_templates(&t))
}

/// `class`'s public `method`, wherever it's declared, as a trait's `first()` on a builder, with the class that
/// declares it.
fn inherited_method<'c>(codebase: &'c CodebaseMetadata, class: &[u8], method: &[u8]) -> Option<(Option<Word>, &'c FunctionLikeMetadata)> {
    let class = codebase.get_class_like(class)?;
    let id = codebase.get_declaring_method_identifier(&MethodIdentifier::new(class.original_name, mago_word::ascii_lowercase_word(method)));
    let f = codebase.get_method_by_id(&id)?;
    f.method_metadata.as_ref().is_none_or(|m| m.visibility.is_public()).then(|| (codebase.get_class_like(id.get_class_name().as_bytes()).map(|c| c.name), f))
}

/// The builder's templates with the model in them: Eloquent's builder's `TModel`, and the templates of the classes
/// and traits it uses, such as `BuildsQueries<TModel>`, whose `first()` returns its `TValue`. Templates are keyed by
/// the lowercase names Mago gives classes.
fn bound_templates(codebase: &CodebaseMetadata, builder: &TUnion, model: Word) -> TemplateResult {
    let mut templates = TemplateResult::default();
    let tmodel = mago_word::word("TModel");
    if let Some(eloquent) = codebase.get_class_like(ELOQUENT_BUILDER.as_bytes()) {
        templates.add_lower_bound(tmodel, GenericParent::ClassLike(eloquent.name), object(model));
    }
    let own = single_object(builder).and_then(|b| codebase.get_class_like(b.name.as_bytes()));
    for class in own.into_iter().chain(codebase.get_class_like(ELOQUENT_BUILDER.as_bytes())) {
        for (ancestor, parameters) in &class.template_extended_parameters {
            for (name, t) in parameters {
                let bound = inferred_type_replacer::replace(t, &templates, codebase);
                templates.add_lower_bound(*name, GenericParent::ClassLike(*ancestor), bound);
            }
        }
    }
    templates
}

/// `declared` with a conditional return type, as `find()`'s `($id is array ? Collection<int, TModel> : TModel|null)`,
/// resolved by its argument's type: the branch it surely takes, or both.
fn branch(context: &HookContext<'_, '_>, f: &FunctionLikeMetadata, declared: &TUnion, arguments: &ArgumentList<'_>) -> TUnion {
    let atomics = declared.types.iter().flat_map(|a| match a {
        TAtomic::Conditional(c) => {
            let parameter = match c.subject.types.as_ref() {
                [TAtomic::Variable(name)] => f.parameters.iter().position(|p| p.get_name().0 == *name),
                _ => None,
            };
            let argument = parameter.and_then(|i| argument(arguments, i, &f.parameters[i].get_name().0.as_bytes()[1..]));
            let given = argument.and_then(|e| context.get_expression_type(e));
            // An array or an object is the list `find()` takes; a scalar is one key.
            let listed = given.map(|g| (g.types.iter().all(|a| a.is_array() || a.is_object_type()), g.types.iter().all(|a| a.is_some_scalar() || a.is_null())));
            let (then, otherwise) = if c.negated { (&c.otherwise, &c.then) } else { (&c.then, &c.otherwise) };
            match listed {
                Some((true, false)) => then.types.to_vec(),
                Some((false, true)) => otherwise.types.to_vec(),
                _ => then.types.iter().chain(otherwise.types.iter()).cloned().collect(),
            }
        }
        _ => vec![a.clone()],
    });
    TUnion::from_vec(atomics.collect())
}

/// The argument for the `index`th parameter, named `name`.
fn argument<'a>(arguments: &ArgumentList<'a>, index: usize, name: &[u8]) -> Option<&'a Expression<'a>> {
    arguments.arguments.iter().find_map(|a| match a {
        Argument::Named(n) if n.name.value == name => Some(n.value),
        _ => None,
    }).or_else(|| match arguments.arguments.iter().nth(index)? {
        Argument::Positional(p) => Some(p.value),
        Argument::Named(_) => None,
    })
}

/// `t` with the method's own templates, which nothing here infers, as their constraints.
fn without_templates(t: &TUnion) -> TUnion {
    let atomics: Vec<TAtomic> = t.types.iter().flat_map(|a| match a {
        TAtomic::GenericParameter(g) => g.constraint.types.to_vec(),
        TAtomic::Object(TObject::Named(n)) if n.type_parameters.is_some() => {
            let mut n = n.clone();
            n.type_parameters = n.type_parameters.map(|p| p.iter().map(without_templates).collect());
            vec![TAtomic::Object(TObject::Named(n))]
        }
        _ => vec![a.clone()],
    }).collect();
    if atomics.is_empty() { get_mixed() } else { TUnion::from_vec(atomics) }
}
