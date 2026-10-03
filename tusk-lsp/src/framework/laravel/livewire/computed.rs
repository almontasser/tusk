//! Livewire's computed properties in the analysis. `$this->posts` reads a `#[Computed]` method `posts()`, or a
//! `getPostsProperty()` one, through `Livewire\Component::__get()`, which Mago types as `mixed`. [`ComputedHook`]
//! types it as the method returns, in the class and, through `$this`, in its view.

use mago_analyzer::plugin::{ExpressionHook, HookContext, HookResult, Provider, ProviderMeta};
use mago_codex::metadata::CodebaseMetadata;
use mago_codex::metadata::function_like::FunctionLikeMetadata;
use mago_codex::ttype::atomic::TAtomic;
use mago_codex::ttype::atomic::object::TObject;
use mago_codex::ttype::expander::{StaticClassType, TypeExpansionOptions, expand_union};
use mago_syntax::cst::{Access, ClassLikeMemberSelector, Expression};

use super::{COMPONENT, COMPUTED};

pub struct ComputedHook;

impl Provider for ComputedHook {
    fn meta() -> &'static ProviderMeta {
        static META: ProviderMeta = ProviderMeta::new("tusk-livewire-computed", "Livewire computed properties", "Types a Livewire component's computed properties as their methods return.");
        &META
    }
}

/// The method behind the computed property `name` of `class`: a `#[Computed]` method of that name, or a
/// `getNameProperty()` one.
pub fn computed_method<'c>(codebase: &'c CodebaseMetadata, class: &str, name: &str) -> Option<&'c FunctionLikeMetadata> {
    let own = codebase.get_declaring_method(class.as_bytes(), name.as_bytes()).filter(|m| m.attributes.iter().any(|a| a.name.as_bytes().eq_ignore_ascii_case(COMPUTED.as_bytes())));
    own.or_else(|| {
        let mut c = name.chars();
        let studly: String = c.next()?.to_uppercase().chain(c).collect();
        codebase.get_declaring_method(class.as_bytes(), format!("get{studly}Property").as_bytes())
    })
}

impl ExpressionHook for ComputedHook {
    fn after_expression(&self, expr: &Expression<'_>, context: &mut HookContext<'_, '_>) -> HookResult<()> {
        let (object, property) = match expr {
            Expression::Access(Access::Property(a)) => (a.object, &a.property),
            Expression::Access(Access::NullSafeProperty(a)) => (a.object, &a.property),
            _ => return Ok(()),
        };
        let ClassLikeMemberSelector::Identifier(name) = property else { return Ok(()) };
        // Only what Mago couldn't type: a real property answers first, as PHP reads it.
        if context.get_expression_type(expr).is_some_and(|t| !t.is_mixed()) {
            return Ok(());
        }
        let Some(receiver) = context.get_expression_type(object) else { return Ok(()) };
        let [TAtomic::Object(TObject::Named(class))] = receiver.types.as_ref() else { return Ok(()) };
        let class = class.clone();
        if !context.is_instance_of(class.name.as_bytes(), COMPONENT.as_bytes()) {
            return Ok(());
        }
        let codebase = context.codebase();
        let name = String::from_utf8_lossy(name.value);
        if codebase.get_property(class.name.as_bytes(), format!("${name}").as_bytes()).is_some() {
            return Ok(());
        }
        let Some(method) = computed_method(codebase, &class.name.as_str_lossy(), &name) else { return Ok(()) };
        let Some(returns) = method.return_type_metadata.as_ref().or(method.return_type_declaration_metadata.as_ref()) else { return Ok(()) };
        let mut t = returns.type_union.clone();
        let declaring = codebase.get_declaring_method_class(class.name.as_bytes(), method.name.as_bytes());
        expand_union(codebase, &mut t, &TypeExpansionOptions { self_class: declaring, static_class_type: StaticClassType::Object(TObject::Named(class)), ..Default::default() });
        context.set_expression_type(expr, t);
        Ok(())
    }
}
