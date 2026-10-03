//! The types of validated data. Laravel declares `validated()` and `validate()` as returning `mixed` or `array`;
//! [`ValidatedHook`] types them as an array shape from the rules: a form request's, a Livewire component's, or the
//! literal array passed to the call.
//!
//! Each key's type is what can pass its rules, never less. Input arrives as strings unless a JSON body or a cast
//! gave something else, so `integer` gives `int|float|numeric-string|true`, as `filter_var()` accepts, and only
//! `integer:strict` gives `int`. A rule other than an implicit one (`required`, `filled`, `accepted`) skips an empty
//! string, so a key without one can also be `''`. `nullable` adds `null`. A key is optional unless it's
//! `required`, `accepted`, or `present`, without `sometimes` or an `exclude` rule. A shape stays open (`...`), since
//! Livewire's form objects and a validator's hooks can add keys.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::sync::Arc;

use mago_analyzer::plugin::{ExpressionHook, HookContext, HookResult, Provider, ProviderMeta};
use mago_codex::ttype::atomic::TAtomic;
use mago_codex::ttype::atomic::array::TArray;
use mago_codex::ttype::atomic::array::key::ArrayKey;
use mago_codex::ttype::atomic::array::keyed::TKeyedArray;
use mago_codex::ttype::atomic::array::list::TList;
use mago_codex::ttype::atomic::object::TObject;
use mago_codex::ttype::union::TUnion;
use mago_codex::ttype::{get_arraykey, get_bool, get_float, get_int, get_literal_int, get_literal_string, get_mixed, get_non_empty_string, get_numeric, get_numeric_string, get_string, get_true};
use mago_syntax::cst::{Argument, Call, ClassLikeMemberSelector, Expression, Literal};

use super::validation::{self, ByClass, FORM_REQUEST, LIVEWIRE_COMPONENT, LIVEWIRE_FORM, REQUEST, Rules};
use crate::index::Index;

thread_local! {
    /// While a file is analyzed, the project's rules by class.
    static RULES: RefCell<Option<Arc<ByClass>>> = const { RefCell::new(None) };
    /// Turns the hook off, for comparing what the analyzer reports without it.
    #[cfg(test)]
    pub static OFF: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Runs `f`, an analysis of a file, with the project's rules at hand.
pub fn with_rules<T>(index: &Index, f: impl FnOnce() -> T) -> T {
    RULES.set(Some(validation::by_class(index)));
    let out = f();
    RULES.take();
    out
}

pub struct ValidatedHook;

impl Provider for ValidatedHook {
    fn meta() -> &'static ProviderMeta {
        static META: ProviderMeta = ProviderMeta::new("tusk-validated", "Validated data", "Types validated() and validate() from the validation rules.");
        &META
    }
}

const VALIDATORS: &[&str] = &["Illuminate\\Contracts\\Validation\\Validator", "Illuminate\\Validation\\Validator"];

impl ExpressionHook for ValidatedHook {
    fn after_expression(&self, expr: &Expression<'_>, context: &mut HookContext<'_, '_>) -> HookResult<()> {
        #[cfg(test)]
        if OFF.get() {
            return Ok(());
        }
        let Expression::Call(Call::Method(c)) = expr else { return Ok(()) };
        let ClassLikeMemberSelector::Identifier(id) = &c.method else { return Ok(()) };
        let method = id.value.to_ascii_lowercase();
        if !matches!(method.as_slice(), b"validated" | b"validate" | b"validatewithbag") {
            return Ok(());
        }
        // Only where Laravel's declared type says nothing more: `mixed`, or an array of anything.
        if context.get_expression_type(expr).is_some_and(|t| !t.is_mixed() && !t.types.iter().all(plain_array)) {
            return Ok(());
        }
        let Some(class) = context.get_expression_type(c.object).and_then(single_class) else { return Ok(()) };
        let is = |parent: &str| context.is_instance_of(class.as_bytes(), parent.as_bytes()) || class.eq_ignore_ascii_case(parent);
        let arguments: Vec<&Expression<'_>> = c.argument_list.arguments.iter().map(Argument::value).collect();
        let literal = |i: usize| arguments.get(i).and_then(|e| validation::array_rules("", e)).filter(|r| r.complete);
        let class_rules = || {
            let by_class = RULES.with_borrow(Clone::clone)?;
            validation::class_rules(context.codebase(), &by_class, &class).filter(|f| f.sure).map(|f| f.rules)
        };
        let (rules, key) = match method.as_slice() {
            b"validated" if is(FORM_REQUEST) => match arguments.as_slice() {
                [] => (class_rules(), None),
                [key] => (class_rules(), Some(string(key))),
                _ => return Ok(()),
            },
            b"validated" | b"validate" if VALIDATORS.iter().any(|v| is(v)) && arguments.is_empty() => (made_rules(c.object), None),
            b"validate" if is(LIVEWIRE_COMPONENT) || is(LIVEWIRE_FORM) => (if arguments.is_empty() { class_rules() } else { literal(0) }, None),
            b"validate" if is(REQUEST) => (literal(0), None),
            b"validatewithbag" if is(REQUEST) => (literal(1), None),
            // A controller's `$this->validate($request, [...])`, from `ValidatesRequests`.
            b"validate" if declared_by(context, &class, "Illuminate\\Foundation\\Validation\\ValidatesRequests") => (literal(1), None),
            _ => return Ok(()),
        };
        let Some(rules) = rules else { return Ok(()) };
        let tree = tree(&rules);
        let t = match key {
            None => Some(tree.shape()),
            Some(Some(key)) => tree.at(&key),
            Some(None) => None,
        };
        if let Some(t) = t {
            context.set_expression_type(expr, t);
        }
        Ok(())
    }
}

fn plain_array(a: &TAtomic) -> bool {
    match a {
        TAtomic::Array(TArray::Keyed(k)) => k.known_items.is_none() && k.parameters.as_ref().is_none_or(|(_, v)| v.is_mixed()),
        TAtomic::Array(TArray::List(l)) => l.known_elements.is_none() && l.element_type.is_mixed(),
        _ => false,
    }
}

fn single_class(t: &TUnion) -> Option<String> {
    match t.types.as_ref() {
        [TAtomic::Object(TObject::Named(n))] => Some(n.name.as_str_lossy().into_owned()),
        _ => None,
    }
}

fn string(expr: &Expression<'_>) -> Option<String> {
    match expr {
        Expression::Literal(Literal::String(s)) => s.value.map(|v| String::from_utf8_lossy(v).into_owned()),
        _ => None,
    }
}

/// Whether `class`'s `validate()` comes from `source`, a trait.
fn declared_by(context: &HookContext<'_, '_>, class: &str, source: &str) -> bool {
    let codebase = context.codebase();
    let Some(meta) = codebase.get_class_like(class.as_bytes()) else { return false };
    let id = mago_codex::identifier::method::MethodIdentifier::new(meta.original_name, mago_word::ascii_lowercase_word(b"validate"));
    codebase.get_declaring_method_identifier(&id).get_class_name().as_bytes().eq_ignore_ascii_case(source.as_bytes())
}

/// The literal rules of the validator a `Validator::make($data, [...])` or `validator($data, [...])` right before
/// makes.
fn made_rules(object: &Expression<'_>) -> Option<Rules> {
    let arguments = match object {
        Expression::Call(Call::StaticMethod(s)) if matches!(&s.method, ClassLikeMemberSelector::Identifier(id) if id.value.eq_ignore_ascii_case(b"make")) => &s.argument_list,
        Expression::Call(Call::Function(f)) if matches!(f.function, Expression::Identifier(id) if id.value().eq_ignore_ascii_case(b"validator")) => &f.argument_list,
        _ => return None,
    };
    validation::array_rules("", arguments.arguments.iter().nth(1)?.value()).filter(|r| r.complete)
}

/// The keys of rules as a tree: `items.*.id` is `id` in each element of `items`.
#[derive(Default, Debug)]
struct Key {
    /// The key's own rules, and whether they're all known.
    rules: Option<(Vec<String>, bool)>,
    children: BTreeMap<String, Key>,
    each: Option<Box<Key>>,
}

fn tree(rules: &Rules) -> Key {
    let mut root = Key::default();
    for f in &rules.fields {
        let mut key = &mut root;
        for part in f.key.split('.') {
            key = if part == "*" { key.each.get_or_insert_with(Default::default) } else { key.children.entry(part.to_string()).or_default() };
        }
        // A key given twice keeps the last rules, as PHP's array does.
        key.rules = Some((f.rules.clone(), f.known));
    }
    root
}

/// The base type a key's rules give it.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Base {
    String,
    Integer { strict: bool },
    Numeric { strict: bool },
    Boolean { strict: bool },
    Array,
    List,
}

/// What a key's own rules say.
#[derive(Debug, Default)]
struct Facts {
    /// The key is in the validated data whenever validation passes.
    present: bool,
    /// An empty string or `null` fails, as `required` and `filled` make it.
    strict: bool,
    nullable: bool,
    base: Option<Base>,
    /// The rules say nothing about the type: unknown rules, or `missing` and `prohibited`.
    unknown: bool,
}

fn facts(rules: &[String], known: bool) -> Facts {
    let mut f = Facts { unknown: !known, ..Default::default() };
    let (mut sometimes, mut excluded) = (false, false);
    for rule in rules {
        let (name, params) = rule.split_once(':').unwrap_or((rule, ""));
        let name = name.trim().to_ascii_lowercase();
        let strict = params.trim().eq_ignore_ascii_case("strict");
        let base = match name.as_str() {
            "required" | "accepted" | "declined" => {
                (f.present, f.strict) = (true, true);
                None
            }
            "present" => {
                f.present = true;
                None
            }
            "filled" => {
                f.strict = true;
                None
            }
            "sometimes" => {
                sometimes = true;
                None
            }
            "nullable" => {
                f.nullable = true;
                None
            }
            n if n == "exclude" || n.starts_with("exclude_") => {
                excluded = true;
                None
            }
            n if n.starts_with("missing") || n.starts_with("prohibited") => {
                f.unknown = true;
                None
            }
            "string" => Some(Base::String),
            "integer" | "int" => Some(Base::Integer { strict }),
            "numeric" => Some(Base::Numeric { strict }),
            "decimal" => Some(Base::Numeric { strict: false }),
            "boolean" | "bool" => Some(Base::Boolean { strict }),
            "array" => Some(Base::Array),
            "list" => Some(Base::List),
            _ => None,
        };
        // Every rule must pass, so the first type is as true as any.
        if f.base.is_none() {
            f.base = base;
        }
    }
    f.present &= !sometimes && !excluded;
    f
}

fn atoms(t: TUnion) -> Vec<TAtomic> {
    t.types.into_owned()
}

fn union(parts: Vec<TUnion>) -> TUnion {
    let mut out: Vec<TAtomic> = vec![];
    for a in parts.into_iter().flat_map(atoms) {
        if !out.contains(&a) {
            out.push(a);
        }
    }
    TUnion::from_vec(out)
}

impl Key {
    /// The key's type, and whether it's always in the validated data.
    fn typed(&self) -> (TUnion, bool) {
        let nested = !self.children.is_empty() || self.each.is_some();
        let Some((rules, known)) = &self.rules else {
            // Only in the data through its keys: `address.city` sets `address`.
            return (self.nested(false), self.children.values().any(|k| k.typed().1));
        };
        let f = facts(rules, *known);
        let mut parts = match (f.base, f.unknown) {
            (_, true) | (None, _) => return (get_mixed(), f.present),
            (Some(Base::Array | Base::List), _) if nested => vec![self.nested(f.base == Some(Base::List))],
            // A key with keys of its own that isn't an array can be anything that passes its own rules.
            (Some(_), _) if nested => return (get_mixed(), f.present),
            (Some(base), _) => vec![base_type(base, f.strict)],
        };
        // Without an implicit rule, an empty string skips the rules.
        if !f.strict && f.base != Some(Base::String) {
            parts.push(get_string());
        }
        if f.nullable && !f.strict {
            parts.push(mago_codex::ttype::get_null());
        }
        (union(parts), f.present)
    }

    /// The array the key's own keys make: a shape of its named keys, or of each element's type.
    fn nested(&self, list: bool) -> TUnion {
        let any = || (Arc::new(get_arraykey()), Arc::new(get_mixed()));
        let atomic = match (&self.each, self.children.is_empty()) {
            (Some(each), true) => {
                let value = Arc::new(each.typed().0);
                if list { TArray::List(TList::new(value)) } else { TArray::Keyed(TKeyedArray::new_with_parameters(Arc::new(get_arraykey()), value)) }
            }
            (None, false) => {
                let items = self.children.iter().map(|(name, k)| {
                    let (t, present) = k.typed();
                    (ArrayKey::from_string(mago_word::word(name)), (!present, t))
                });
                let (key, value) = any();
                TArray::Keyed(TKeyedArray::new_with_parameters(key, value).with_known_items(items.collect()))
            }
            _ => {
                let (key, value) = any();
                TArray::Keyed(TKeyedArray::new_with_parameters(key, value))
            }
        };
        TUnion::from_atomic(TAtomic::Array(atomic))
    }

    /// The validated data: a shape of the top-level keys.
    fn shape(&self) -> TUnion {
        self.nested(false)
    }

    /// The type `validated('a.b')` returns: the key's, or `null` where it can be missing. `None` past a `*`.
    fn at(&self, key: &str) -> Option<TUnion> {
        let mut node = self;
        let mut always = true;
        for part in key.split('.') {
            node = node.children.get(part)?;
            always &= node.typed().1;
        }
        let (t, _) = node.typed();
        Some(if always { t } else { union(vec![t, mago_codex::ttype::get_null()]) })
    }
}

fn base_type(base: Base, strict: bool) -> TUnion {
    match base {
        Base::String if strict => get_non_empty_string(),
        Base::String => get_string(),
        Base::Integer { strict: true } => get_int(),
        // `filter_var()` takes `5.0` and `true` as integers.
        Base::Integer { strict: false } => union(vec![get_int(), get_float(), get_numeric_string(), get_true()]),
        Base::Numeric { strict: true } => union(vec![get_int(), get_float()]),
        Base::Numeric { strict: false } => get_numeric(),
        Base::Boolean { strict: true } => get_bool(),
        Base::Boolean { strict: false } => union(vec![get_bool(), get_literal_int(0), get_literal_int(1), get_literal_string(mago_word::word("0")), get_literal_string(mago_word::word("1"))]),
        Base::Array => TUnion::from_atomic(TAtomic::Array(TArray::Keyed(TKeyedArray::new_with_parameters(Arc::new(get_arraykey()), Arc::new(get_mixed()))))),
        Base::List => TUnion::from_atomic(TAtomic::Array(TArray::List(TList::new(Arc::new(get_mixed()))))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framework::laravel::validation::Field;
    use mago_codex::ttype::TType;

    fn rules(pairs: &[(&str, &str)]) -> Rules {
        let fields = pairs.iter().map(|(k, v)| Field { key: k.to_string(), rules: v.split('|').map(String::from).collect(), known: true, span: (0, 0) }).collect();
        Rules { fields, complete: true }
    }

    fn shape(pairs: &[(&str, &str)]) -> String {
        tree(&rules(pairs)).shape().get_id().to_string()
    }

    #[test]
    fn types_keys_as_their_rules_let_them_through() {
        assert_eq!(shape(&[("title", "required|string|max:255")]), "array{'title': non-empty-string, ...}");
        // Without `required`, an empty string passes, and the key can be missing.
        assert_eq!(shape(&[("age", "nullable|integer")]), "array{'age'?: float|int|null|numeric-string|string|true, ...}");
        assert_eq!(shape(&[("age", "required|integer:strict")]), "array{'age': int, ...}");
        assert_eq!(shape(&[("ok", "required|boolean")]), "array{'ok': bool|int(0)|int(1)|string('0')|string('1'), ...}");
        assert_eq!(shape(&[("ok", "sometimes|required|boolean:strict")]), "array{'ok'?: bool, ...}");
        assert_eq!(shape(&[("x", "required|exclude_if:y,1|string")]), "array{'x'?: non-empty-string, ...}");
        assert_eq!(shape(&[("x", "required|max:3")]), "array{'x': mixed, ...}");
    }

    #[test]
    fn types_nested_and_wildcard_keys() {
        assert_eq!(shape(&[("tags", "required|array"), ("tags.*", "required|string")]), "array{'tags': array<array-key, non-empty-string>, ...}");
        assert_eq!(shape(&[("tags", "required|list"), ("tags.*", "required|integer:strict")]), "array{'tags': list<int>, ...}");
        assert_eq!(shape(&[("address.city", "required|string")]), "array{'address': array{'city': non-empty-string, ...}, ...}");
        // A key with keys that isn't an array could be any value.
        assert_eq!(shape(&[("a", "required"), ("a.b", "string")]), "array{'a': mixed, ...}");
        let t = tree(&rules(&[("address.city", "string"), ("name", "required|string")]));
        assert_eq!(t.at("name").unwrap().get_id().to_string(), "non-empty-string");
        assert_eq!(t.at("address.city").unwrap().get_id().to_string(), "null|string");
        assert!(t.at("nope").is_none());
    }
}
