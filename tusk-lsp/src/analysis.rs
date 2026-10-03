//! Parsing and analyzing one file against the index. Mago's syntax tree, names, and types all borrow from an
//! arena, so a request parses the file it needs, answers, and drops everything together.

use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;
use std::sync::LazyLock;

use mago_allocator::LocalArena;
use mago_analyzer::Analyzer;
use mago_analyzer::analysis_result::AnalysisResult;
use mago_analyzer::artifacts::AnalysisArtifacts;
use mago_analyzer::code::IssueCode;
use mago_analyzer::plugin::{IssueFilterDecision, IssueFilterHook};
use mago_analyzer::plugin::{ExpressionHook, ExpressionHookResult, FunctionReturnTypeProvider, FunctionTarget, HookContext, HookResult, InvocationInfo, PluginRegistry, Provider, ProviderContext, ProviderMeta};
use mago_analyzer::settings::Settings;
use mago_codex::reference::SymbolReferences;
use mago_codex::ttype::atomic::TAtomic;
use mago_codex::ttype::atomic::object::TObject;
use mago_codex::ttype::atomic::object::named::TNamedObject;
use mago_codex::ttype::get_mixed;
use mago_codex::ttype::union::TUnion;
use mago_database::file::{File, FileType};
use mago_names::ResolvedNames;
use mago_names::resolver::NameResolver;
use mago_php_version::PHPVersion;
use mago_reporting::{AnnotationKind, Issue, IssueCollection};
use mago_span::HasSpan;
use mago_syntax::cst::{Access, Argument, Call, ClassLikeMemberSelector, Expression, Node, Program, Variable};
use mago_syntax::parser::parse_file;
use mago_word::Word;

use crate::index::{Index, PHPUNIT_TEST_CASE, PestProps, source_file};

/// Parses a file. If brackets are left open at its end, as when a class is being written at the end of a file,
/// they're closed first, so the parser keeps the unfinished declaration. The index and every request parse the
/// same way, so spans agree.
pub fn parse_balanced<'a>(arena: &'a LocalArena, path: &Path, file_type: FileType, contents: Vec<u8>) -> (File, &'a Program<'a>) {
    let file = source_file(path, file_type, contents);
    let program = parse_file(arena, &file);
    if program.errors.is_empty() {
        return (file, program);
    }
    let balanced = crate::repair::balance_end(&crate::text::decode(&file.contents));
    let file = source_file(path, file_type, balanced.into_bytes());
    let program = parse_file(arena, &file);
    (file, program)
}

static PLUGINS: LazyLock<PluginRegistry> = LazyLock::new(|| {
    let mut plugins = PluginRegistry::with_library_providers();
    plugins.register_expression_hook(PestHook);
    plugins.register_expression_hook(AuthHook);
    plugins.register_function_provider(AuthHelper);
    plugins.register_expression_hook(FactoryHook);
    plugins.register_expression_hook(ExpectationHook);
    plugins.register_issue_filter_hook(ExpectationHook);
    plugins.register_expression_hook(ArtisanHook);
    plugins.register_function_provider(PestTestHelper);
    plugins.register_expression_hook(crate::framework::laravel::forwarding::ForwardHook);
    plugins.register_issue_filter_hook(crate::framework::laravel::forwarding::ForwardHook);
    plugins.register_expression_hook(crate::framework::laravel::livewire::computed::ComputedHook);
    plugins
});

thread_local! {
    /// While a file is analyzed for Pest, what the hook knows and learns.
    static PEST: RefCell<Option<Pest>> = const { RefCell::new(None) };
    /// While a Blade view is analyzed, the ranges of its PHP where a user is logged in, from [`logged_in`].
    static AUTHED: RefCell<Vec<(u32, u32)>> = const { RefCell::new(vec![]) };
}

/// Runs `f`, an analysis of a Blade view, with a user logged in over `ranges` of its PHP, such as the body of `@auth`.
pub fn logged_in<T>(ranges: Vec<(u32, u32)>, f: impl FnOnce() -> T) -> T {
    AUTHED.set(ranges);
    let out = f();
    AUTHED.take();
    out
}

/// Takes `null` out of what a `user()` call returns where a Blade view says a user is logged in ([`logged_in`]):
/// `Auth::user()` and a guard's `user()` return `null` only for a guest. So does a variable that may hold an
/// `Authenticatable`, such as `$user` that a controller passes as `Auth::user()`.
struct AuthHook;

impl Provider for AuthHook {
    fn meta() -> &'static ProviderMeta {
        static META: ProviderMeta = ProviderMeta::new("tusk-auth", "Auth", "Types the user as logged in inside a Blade view's @auth.");
        &META
    }
}

impl ExpressionHook for AuthHook {
    fn after_expression(&self, expr: &Expression<'_>, context: &mut HookContext<'_, '_>) -> HookResult<()> {
        let method = match expr {
            Expression::Call(Call::Method(c)) => Some(&c.method),
            Expression::Call(Call::NullSafeMethod(c)) => Some(&c.method),
            Expression::Call(Call::StaticMethod(c)) => Some(&c.method),
            Expression::Variable(_) => None,
            _ => return Ok(()),
        };
        let at = expr.span().start.offset;
        if method.is_some_and(|m| !matches!(m, ClassLikeMemberSelector::Identifier(id) if id.value.eq_ignore_ascii_case(b"user"))) || !AUTHED.with_borrow(|r| r.iter().any(|(s, e)| *s <= at && at < *e)) {
            return Ok(());
        }
        let user = |t: &TUnion| t.types.iter().any(|a| matches!(a, TAtomic::Object(TObject::Named(n)) if context.is_instance_of(n.name.as_bytes(), b"Illuminate\\Contracts\\Auth\\Authenticatable")));
        if let Some(t) = context.get_expression_type(expr).filter(|t| t.has_null() && (method.is_some() || user(t))) {
            let t = t.to_non_nullable();
            context.set_expression_type(expr, t);
        }
        Ok(())
    }
}

/// Laravel's auth manager, which `auth()` returns and passes the default guard's calls on to through its `@mixin`s.
pub const AUTH_MANAGER: &str = "Illuminate\\Auth\\AuthManager";

/// Types `auth()` and `auth(null)` as what they return at runtime, the auth manager, rather than the
/// `Illuminate\Contracts\Auth\Factory` Laravel declares, which has no `user()`. The manager is intersected with
/// its mixins, the default guard's contracts, so the guard's methods are known, and listed and described where the
/// manager is. A guard's name, as in `auth('admin')`, keeps Laravel's type.
struct AuthHelper;

impl Provider for AuthHelper {
    fn meta() -> &'static ProviderMeta {
        static META: ProviderMeta = ProviderMeta::new("tusk-auth-helper", "auth()", "Types auth() as the auth manager and its default guard.");
        &META
    }
}

impl FunctionReturnTypeProvider for AuthHelper {
    fn targets() -> FunctionTarget {
        FunctionTarget::exact(b"auth")
    }

    fn get_return_type(&self, context: &ProviderContext<'_, '_, '_>, invocation: &InvocationInfo<'_, '_, '_>) -> Option<TUnion> {
        if let Some(guard) = invocation.get_argument(0, &[b"guard"]) {
            context.get_expression_type(guard).filter(|t| t.is_null())?;
        }
        let manager = context.codebase().get_class_like(AUTH_MANAGER.as_bytes())?;
        let mixins: Vec<TAtomic> = manager.mixins.iter().flat_map(|m| m.type_union.types.iter().cloned()).filter(|a| matches!(a, TAtomic::Object(TObject::Named(_)))).collect();
        let mut named = TNamedObject::new(manager.original_name);
        named.intersection_types = (!mixins.is_empty()).then_some(mixins);
        Some(TUnion::from_atomic(TAtomic::Object(TObject::Named(named))))
    }
}

/// Laravel's model factory, whose `create()`, `make()`, and `createQuietly()` return a model or a collection of them.
const FACTORY: &str = "Illuminate\\Database\\Eloquent\\Factories\\Factory";
const ELOQUENT_COLLECTION: &str = "Illuminate\\Database\\Eloquent\\Collection";

/// Types `User::factory()->create()` as the one model it makes rather than the `TModel|Collection<int, TModel>`
/// Laravel declares, as Larastan does: a factory makes a collection only when it's given a count, by
/// `factory(3)`, `count()`, or `times()`. Only a chain that starts at `factory()` or a factory's `new()` is narrowed,
/// since a factory in a variable may have been given a count elsewhere.
struct FactoryHook;

impl Provider for FactoryHook {
    fn meta() -> &'static ProviderMeta {
        static META: ProviderMeta = ProviderMeta::new("tusk-factory", "Model factories", "Types a factory's create() and make() as one model when no count is given.");
        &META
    }
}

impl ExpressionHook for FactoryHook {
    fn after_expression(&self, expr: &Expression<'_>, context: &mut HookContext<'_, '_>) -> HookResult<()> {
        let Expression::Call(Call::Method(c)) = expr else { return Ok(()) };
        let ClassLikeMemberSelector::Identifier(method) = &c.method else { return Ok(()) };
        if ![&b"create"[..], b"make", b"createQuietly"].iter().any(|m| method.value.eq_ignore_ascii_case(m)) || !makes_one(c.object, context) {
            return Ok(());
        }
        let Some(t) = context.get_expression_type(expr) else { return Ok(()) };
        let collection = |a: &TAtomic| matches!(a, TAtomic::Object(TObject::Named(n)) if context.is_instance_of(n.name.as_bytes(), ELOQUENT_COLLECTION.as_bytes()));
        let one: Vec<TAtomic> = t.types.iter().filter(|a| !collection(a)).cloned().collect();
        if !one.is_empty() && one.len() < t.types.len() {
            context.set_expression_type(expr, TUnion::from_vec(one));
        }
        Ok(())
    }
}

/// Whether `expr` is a factory chain that makes one model: it starts at `Model::factory()` without a count, or at a
/// factory's `new()`, and doesn't call `count()` or `times()` on the way.
fn makes_one(expr: &Expression<'_>, context: &HookContext<'_, '_>) -> bool {
    let is_factory = |e: &Expression<'_>| context.get_expression_type(e).is_some_and(|t| t.types.iter().any(|a| matches!(a, TAtomic::Object(TObject::Named(n)) if context.is_instance_of(n.name.as_bytes(), FACTORY.as_bytes()))));
    let named = |m: &ClassLikeMemberSelector<'_>, name: &[u8]| matches!(m, ClassLikeMemberSelector::Identifier(id) if id.value.eq_ignore_ascii_case(name));
    match expr {
        Expression::Call(Call::Method(c)) => is_factory(expr) && !named(&c.method, b"count") && !named(&c.method, b"times") && makes_one(c.object, context),
        Expression::Call(Call::StaticMethod(c)) if named(&c.method, b"new") => is_factory(expr),
        // `factory($count = null, $state = [])`: an int is a count; an array or a closure is state.
        Expression::Call(Call::StaticMethod(c)) if named(&c.method, b"factory") => {
            let count = c.argument_list.arguments.iter().find_map(|a| match a {
                Argument::Positional(p) => Some(p.value),
                Argument::Named(n) if n.name.value.eq_ignore_ascii_case(b"count") => Some(n.value),
                Argument::Named(_) => None,
            });
            let state = |t: &TUnion| t.is_null() || t.is_array() || t.types.iter().all(|a| matches!(a, TAtomic::Callable(_) | TAtomic::Array(_) | TAtomic::Null) || matches!(a, TAtomic::Object(TObject::Named(n)) if n.name.as_bytes().eq_ignore_ascii_case(b"closure")));
            is_factory(expr) && count.is_none_or(|e| context.get_expression_type(e).is_some_and(state))
        }
        _ => false,
    }
}

const EXPECTATION: &str = "Pest\\Expectation";
/// Pest's class that declares the expectations, such as `toBe()`, as an `@mixin` of `Pest\Expectation`.
const EXPECTATION_MIXIN: &str = "Pest\\Mixins\\Expectation";

/// Types a higher-order expectation, such as `expect($user)->name->toBe('Ada')`, as an expectation of the property:
/// `Expectation<string>` when the value is a `User` whose `$name` is a string, else `Expectation<mixed>`.
/// `Expectation::__get()` declares a union with the value itself, on which the next expectation reads as `mixed`,
/// and its `HigherOrderExpectation` sends the next call to a mixin that has no properties. At runtime each
/// expectation and property in the chain runs against the original value, as typed here. Properties the
/// expectation declares, such as `not` and `each`, keep their types.
struct ExpectationHook;

impl Provider for ExpectationHook {
    fn meta() -> &'static ProviderMeta {
        static META: ProviderMeta = ProviderMeta::new("tusk-expectation", "Pest expectations", "Types Pest's higher-order expectations.");
        &META
    }
}

impl ExpressionHook for ExpectationHook {
    fn after_expression(&self, expr: &Expression<'_>, context: &mut HookContext<'_, '_>) -> HookResult<()> {
        // An expectation such as `toBe()` returns the expectation it's called on, but Pest declares it on the mixin
        // as `self`, so it reads as the mixin, which has no higher-order properties.
        if let Expression::Call(Call::Method(_)) = expr {
            let Some(t) = context.get_expression_type(expr) else { return Ok(()) };
            let [TAtomic::Object(TObject::Named(n))] = t.types.as_ref() else { return Ok(()) };
            if !n.name.as_bytes().eq_ignore_ascii_case(EXPECTATION_MIXIN.as_bytes()) {
                return Ok(());
            }
            let Some(expectation) = context.codebase().get_class_like(EXPECTATION.as_bytes()) else { return Ok(()) };
            let t = TNamedObject::new_with_type_parameters(expectation.original_name, n.type_parameters.clone());
            context.set_expression_type(expr, TUnion::from_atomic(TAtomic::Object(TObject::Named(t))));
            return Ok(());
        }
        let Expression::Access(Access::Property(a)) = expr else { return Ok(()) };
        let ClassLikeMemberSelector::Identifier(name) = &a.property else { return Ok(()) };
        let property = [b"$", name.value].concat();
        let codebase = context.codebase();
        let Some(value) = context.get_expression_type(a.object).and_then(|t| match t.types.as_ref() {
            [TAtomic::Object(TObject::Named(n))] if n.name.as_bytes().eq_ignore_ascii_case(EXPECTATION.as_bytes()) => Some(n.get_type_parameters().and_then(|p| p.first()).cloned()),
            _ => None,
        }) else {
            return Ok(());
        };
        let Some(expectation) = codebase.get_class_like(EXPECTATION.as_bytes()).filter(|_| !codebase.property_exists(EXPECTATION.as_bytes(), &property)) else { return Ok(()) };
        // The property's declared type, on a value of one class. `expect()` declares its value nullable.
        let of = value.map(|v| v.to_non_nullable()).and_then(|v| match v.types.as_ref() {
            [TAtomic::Object(TObject::Named(n))] => codebase.get_property_type(n.name.as_bytes(), &property).cloned(),
            _ => None,
        });
        let t = TNamedObject::new_with_type_parameters(expectation.original_name, Some(vec![of.unwrap_or_else(get_mixed)]));
        context.set_expression_type(expr, TUnion::from_atomic(TAtomic::Object(TObject::Named(t))));
        Ok(())
    }
}

impl IssueFilterHook for ExpectationHook {
    /// A property or method the expectation doesn't declare is a higher-order expectation on its value, which Pest
    /// allows, not a magic member that may not exist.
    fn filter_issue(&self, _: &File, issue: &Issue) -> HookResult<IssueFilterDecision> {
        let magic = [IssueCode::NonDocumentedProperty.as_str(), IssueCode::NonDocumentedMethod.as_str()].contains(&issue.code.as_deref().unwrap_or_default());
        let on_expectation = issue.message.ends_with(&format!("on class `{EXPECTATION}`."));
        Ok(if magic && on_expectation { IssueFilterDecision::Remove } else { IssueFilterDecision::Keep })
    }
}

const PENDING_COMMAND: &str = "Illuminate\\Testing\\PendingCommand";

/// Types a test's `artisan()`, the test case's method and Pest's function, as the `PendingCommand` it returns in
/// tests rather than `PendingCommand|int`: it returns the exit code only when a test turns off console mocking.
struct ArtisanHook;

impl Provider for ArtisanHook {
    fn meta() -> &'static ProviderMeta {
        static META: ProviderMeta = ProviderMeta::new("tusk-artisan", "Artisan in tests", "Types a test's artisan() as a PendingCommand.");
        &META
    }
}

impl ExpressionHook for ArtisanHook {
    fn after_expression(&self, expr: &Expression<'_>, context: &mut HookContext<'_, '_>) -> HookResult<()> {
        let artisan = match expr {
            Expression::Call(Call::Method(c)) => matches!(&c.method, ClassLikeMemberSelector::Identifier(id) if id.value.eq_ignore_ascii_case(b"artisan")),
            Expression::Call(Call::Function(f)) => matches!(f.function, Expression::Identifier(id) if id.value().rsplit(|b| *b == b'\\').next().is_some_and(|n| n.eq_ignore_ascii_case(b"artisan"))),
            _ => false,
        };
        let Some(t) = context.get_expression_type(expr).filter(|_| artisan) else { return Ok(()) };
        let pending = |a: &TAtomic| matches!(a, TAtomic::Object(TObject::Named(n)) if n.name.as_bytes().eq_ignore_ascii_case(PENDING_COMMAND.as_bytes()));
        if t.types.iter().any(pending) && t.has_int() {
            let command: Vec<TAtomic> = t.types.iter().filter(|a| pending(a)).cloned().collect();
            context.set_expression_type(expr, TUnion::from_vec(command));
        }
        Ok(())
    }
}

/// Types Pest's `test()` without arguments, which returns the running test, as the test case the file's closures
/// run in, rather than the `HigherOrderTapProxy|TestCall` Pest declares. Helper functions in a test file call it
/// for the test's properties, as in `test()->user`.
struct PestTestHelper;

impl Provider for PestTestHelper {
    fn meta() -> &'static ProviderMeta {
        static META: ProviderMeta = ProviderMeta::new("tusk-pest-test", "test()", "Types Pest's test() as the running test case.");
        &META
    }
}

impl FunctionReturnTypeProvider for PestTestHelper {
    fn targets() -> FunctionTarget {
        FunctionTarget::exact(b"test")
    }

    fn get_return_type(&self, _: &ProviderContext<'_, '_, '_>, invocation: &InvocationInfo<'_, '_, '_>) -> Option<TUnion> {
        if !invocation.has_no_arguments() {
            return None;
        }
        let case = PEST.with_borrow(|p| p.as_ref().and_then(|p| p.case))?;
        Some(TUnion::from_atomic(TAtomic::Object(TObject::Named(TNamedObject::new(case)))))
    }
}

/// `user` in `test()->user`, where `test()` without arguments is Pest's running test.
fn running_test_property<'a>(expr: &Expression<'a>) -> Option<&'a [u8]> {
    let Expression::Access(Access::Property(a)) = expr else { return None };
    let Expression::Call(Call::Function(f)) = a.object else { return None };
    let Expression::Identifier(id) = f.function else { return None };
    let test = f.argument_list.arguments.is_empty() && id.value().rsplit(|b| *b == b'\\').next().is_some_and(|n| n.eq_ignore_ascii_case(b"test"));
    match &a.property {
        ClassLikeMemberSelector::Identifier(name) if test => Some(name.value),
        _ => None,
    }
}

#[derive(Default)]
struct Pest {
    /// The class the file's test closures run in, or `None` to leave closures as they are.
    case: Option<Word>,
    /// The type of each property tests set on `$this` that the test case doesn't declare.
    props: PestProps,
    /// Every `$this->name = …`: where it starts, the name, and the value's type.
    sets: Vec<(u32, Vec<u8>, TUnion)>,
    /// Properties the test case doesn't declare, read before anything above set them.
    unset_reads: Vec<Vec<u8>>,
    /// Where tests set a property the test case doesn't declare, which Pest allows and Mago reports.
    dynamic: Vec<(u32, u32)>,
}

/// Binds a Pest test file's closures to the file's test case rather than PHPUnit's, and types the properties its
/// tests set on `$this` that the test case doesn't declare from the values they're given. The analyzer reaches a
/// file's closures in order, so what a closure sets types the closures after it; [`analyze_with`] covers the rest.
struct PestHook;

impl Provider for PestHook {
    fn meta() -> &'static ProviderMeta {
        static META: ProviderMeta = ProviderMeta::new("tusk-pest", "Pest", "Binds Pest's test closures to the file's test case.");
        &META
    }
}

impl ExpressionHook for PestHook {
    fn before_expression(&self, expr: &Expression<'_>, context: &mut HookContext<'_, '_>) -> HookResult<ExpressionHookResult> {
        PEST.with_borrow_mut(|pest| {
            let Some(Pest { case: Some(case), props, unset_reads, .. }) = pest else { return Ok(ExpressionHookResult::Continue) };
            if let Expression::Closure(_) | Expression::ArrowFunction(_) = expr
                && let Some(scope) = &mut context.artifacts_mut().closure_bind_scope
                && scope.class_name.is_some_and(|c| c.as_str_lossy().eq_ignore_ascii_case(PHPUNIT_TEST_CASE))
            {
                scope.class_name = Some(*case);
            }
            // `test()->user` in a helper function reads what the tests set, as `$this->user` does in them.
            if let Some(t) = running_test_property(expr).and_then(|name| props.get(name)) {
                return Ok(ExpressionHookResult::SkipWithType(t.clone()));
            }
            let Some(name) = this_property(expr).filter(|_| in_class(context, *case)) else { return Ok(ExpressionHookResult::Continue) };
            match props.get(name) {
                Some(t) => Ok(ExpressionHookResult::SkipWithType(t.clone())),
                None => {
                    if !context.codebase().property_exists(case.as_bytes(), &[b"$", name].concat()) {
                        unset_reads.push(name.to_vec());
                    }
                    Ok(ExpressionHookResult::Continue)
                }
            }
        })
    }

    fn after_expression(&self, expr: &Expression<'_>, context: &mut HookContext<'_, '_>) -> HookResult<()> {
        let Expression::Assignment(a) = expr else { return Ok(()) };
        let Some(name) = this_property(a.lhs) else { return Ok(()) };
        PEST.with_borrow_mut(|pest| {
            let Some(pest) = pest else { return };
            let t = context.get_expression_type(a.rhs).filter(|_| a.operator.is_assign());
            if let Some(t) = t {
                pest.sets.push((a.span().start.offset, name.to_vec(), t.clone()));
            }
            let Some(case) = pest.case.filter(|c| in_class(context, *c)) else { return };
            if !context.codebase().property_exists(case.as_bytes(), &[b"$", name].concat()) {
                pest.dynamic.push((a.lhs.span().start.offset, a.lhs.span().end.offset));
                if let Some(t) = t {
                    pest.props.insert(name.to_vec(), t.clone());
                }
            }
        });
        Ok(())
    }
}

/// Every `$this->name = …` in `parsed`: where it starts, the name, and the value's type. Pest's `tests/Pest.php` is
/// analyzed with this for what its `beforeEach()` hooks set.
pub fn this_assignments(parsed: &Parsed<'_>, arena: &LocalArena, index: &Index) -> Vec<(u32, Vec<u8>, TUnion)> {
    if too_complex(parsed.program) {
        return vec![];
    }
    PEST.set(Some(Pest::default()));
    run(parsed, arena, index, settings(index.config.php_version));
    PEST.take().map(|p| p.sets).unwrap_or_default()
}

fn in_class(context: &HookContext<'_, '_>, class: Word) -> bool {
    context.current_class_name().is_some_and(|c| c.as_str_lossy().eq_ignore_ascii_case(&class.as_str_lossy()))
}

/// `user` in `$this->user`.
pub(crate) fn this_property<'a>(expr: &Expression<'a>) -> Option<&'a [u8]> {
    let Expression::Access(Access::Property(a)) = expr else { return None };
    match (a.object, &a.property) {
        (Expression::Variable(Variable::Direct(v)), ClassLikeMemberSelector::Identifier(id)) if v.name == b"$this" => Some(id.value),
        _ => None,
    }
}

/// A parsed file with its names resolved.
pub struct Parsed<'a> {
    pub file: File,
    pub program: &'a Program<'a>,
    pub names: ResolvedNames<'a>,
}

impl<'a> Parsed<'a> {
    /// Parses `text`, with brackets left open at its end closed the way the index closes them.
    pub fn new(arena: &'a LocalArena, path: &Path, text: &str) -> Self {
        let (file, program) = parse_balanced(arena, path, FileType::Host, text.as_bytes().to_vec());
        let names = NameResolver::new(arena).resolve(program);
        Self { file, program, names }
    }

    /// Parses `text` as it is, for a repaired copy of a document.
    pub fn exact(arena: &'a LocalArena, path: &Path, text: &str) -> Self {
        let file = source_file(path, FileType::Host, text.as_bytes().to_vec());
        let program = parse_file(arena, &file);
        let names = NameResolver::new(arena).resolve(program);
        Self { file, program, names }
    }

    pub fn text(&self) -> &str {
        // Built from a `&str`, so always UTF-8.
        std::str::from_utf8(&self.file.contents).unwrap_or_default()
    }

    /// The chain of nodes from the program down to the innermost one whose span contains `offset`. At a
    /// boundary between two nodes, the one that starts there wins, so a cursor just before a name selects it.
    pub fn path_at(&self, offset: u32) -> Vec<Node<'a, 'a>> {
        let mut path = vec![Node::Program(self.program)];
        loop {
            let node = *path.last().unwrap();
            let mut next = None;
            node.visit_children(|child| {
                let span = child.span();
                if span.start.offset <= offset && offset <= span.end.offset {
                    // Prefer a later sibling that starts exactly at the offset over one that ends there.
                    if next.is_none() || span.start.offset == offset {
                        next = Some(child);
                    }
                }
            });
            match next {
                Some(child) => path.push(child),
                None => return path,
            }
        }
    }

    /// The fully qualified name the resolver gave the identifier at `offset`, with its span.
    pub fn name_at(&self, offset: u32) -> Option<(u32, u32, String, bool)> {
        self.names
            .at_offset(offset)
            .map(|(start, end, name, imported)| (start, end, String::from_utf8_lossy(name).into_owned(), imported))
    }
}

/// What the analyzer found in a file: expression types and problems.
pub struct Analysis {
    pub artifacts: AnalysisArtifacts,
    pub issues: IssueCollection,
}

impl Analysis {
    /// The type of the smallest expression whose span contains `start..end`.
    pub fn type_at(&self, start: u32, end: u32) -> Option<Rc<TUnion>> {
        self.artifacts
            .expression_types
            .iter()
            .filter(|((s, e), _)| *s <= start && end <= *e)
            .min_by_key(|((s, e), _)| e - s)
            .map(|(_, t)| t.clone())
    }

    /// The type of the expression spanning exactly `start..end`.
    pub fn type_of(&self, start: u32, end: u32) -> Option<Rc<TUnion>> {
        self.artifacts.expression_types.get(&(start, end)).cloned()
    }
}

pub fn settings(version: PHPVersion) -> Settings {
    Settings {
        version,
        use_colors: false,
        // Unused-code checks need the whole project analyzed, which a single file's analysis can't see.
        find_unused_definitions: false,
        ..Settings::new(version)
    }
}

/// Deeper syntax trees than any real code has, such as a generated expression of thousands of terms. Mago's analyzer
/// and linter take time quadratic in such a chain's length and recurse once per level. Real code nests at most about
/// 850 levels deep (a Symfony bundle's configuration chain).
pub const MAX_DEPTH: usize = 1000;

/// More branches in one `if`, `switch`, or `match` than real code has: Mago's analyzer takes 0.7 s on a `match` of
/// 1,000 arms and minutes on 20,000 `elseif`s. Real code has at most about 800 (a `switch` in WordPress).
pub const MAX_BRANCHES: usize = 1000;

/// Whether `program` is beyond what the analyzer and requests handle in reasonable time: nested deeper than
/// [`MAX_DEPTH`], or with more than [`MAX_BRANCHES`] branches in one statement. Walks with its own stack, so any depth
/// is safe.
pub fn too_complex(program: &Program<'_>) -> bool {
    let mut stack = vec![(Node::Program(program), 0)];
    while let Some((node, depth)) = stack.pop() {
        if depth > MAX_DEPTH {
            return true;
        }
        let mut branches = 0;
        node.visit_children(|child| {
            if matches!(child, Node::IfStatementBodyElseIfClause(_) | Node::IfColonDelimitedBodyElseIfClause(_) | Node::SwitchCase(_) | Node::MatchArm(_)) {
                branches += 1;
            }
            stack.push((child, depth + 1));
        });
        if branches > MAX_BRANCHES {
            return true;
        }
    }
    false
}

pub fn analyze(parsed: &Parsed<'_>, arena: &LocalArena, index: &Index) -> Analysis {
    analyze_with(parsed, arena, index, settings(index.config.php_version))
}

pub fn analyze_with(parsed: &Parsed<'_>, arena: &LocalArena, index: &Index, settings: Settings) -> Analysis {
    if too_complex(parsed.program) {
        return Analysis { artifacts: Default::default(), issues: Default::default() };
    }
    match index.pest_binding(parsed) {
        Some(binding) => analyze_pest(parsed, arena, index, settings, binding),
        None => {
            PEST.set(None);
            run(parsed, arena, index, settings)
        }
    }
}

fn run(parsed: &Parsed<'_>, arena: &LocalArena, index: &Index, settings: Settings) -> Analysis {
    let mut result = AnalysisResult::new(SymbolReferences::new());
    let analyzer = Analyzer::new(arena, &parsed.file, &parsed.names, &index.codebase, &PLUGINS, settings);
    let names = parsed.names.iter().map(|(start, _, name, _)| (start, Box::from(name)));
    let artifacts = crate::framework::laravel::forwarding::with_names(names, || analyzer.analyze_with_artifacts(parsed.program, &mut result).unwrap_or_default());
    Analysis { artifacts, issues: result.issues }
}

fn analyze_pest(parsed: &Parsed<'_>, arena: &LocalArena, index: &Index, settings: Settings, (case, seed, hooks, partial): (Word, PestProps, Vec<(u32, u32)>, bool)) -> Analysis {
    let start = |props| PEST.set(Some(Pest { case: Some(case), props, ..Default::default() }));
    start(seed.clone());
    let mut analysis = run(parsed, arena, index, settings.clone());
    let mut pest = PEST.take().unwrap_or_default();
    // A test that reads a property before the file's `beforeEach()` sets it, as when the hook comes later or the
    // property is read in a hook above it: analyzed again with what the file's hooks set.
    let late: PestProps = pest
        .sets
        .into_iter()
        .filter(|(at, name, _)| hooks.iter().any(|(s, e)| s <= at && at < e) && pest.unset_reads.contains(name))
        .map(|(_, name, t)| (name, t))
        .collect();
    if !late.is_empty() {
        start(seed.into_iter().chain(late).collect());
        analysis = run(parsed, arena, index, settings);
        pest = PEST.take().unwrap_or_default();
    }
    // Setting a property the test case doesn't declare is how Pest tests share values. Bound to the test case
    // without the traits the file names, as when the analysis runs on a `uses()` the index doesn't have yet, any
    // missing member may be a trait's.
    let issues = analysis.issues.into_iter().filter(|i| {
        let dynamic = i.code.as_deref() == Some(IssueCode::NonExistentProperty.as_str());
        if partial && (dynamic || i.code.as_deref() == Some(IssueCode::NonExistentMethod.as_str())) {
            return false;
        }
        let at = i.annotations.iter().find(|a| a.kind == AnnotationKind::Primary).map(|a| a.span.start.offset);
        !(dynamic && at.is_some_and(|at| pest.dynamic.iter().any(|(s, e)| *s <= at && at < *e)))
    });
    Analysis { artifacts: analysis.artifacts, issues: issues.collect() }
}
