//! Volt's class-based components, which declare their class in the view: `<?php ... new class extends Component
//! { ... } ?>`. The class isn't in the index, so its members are read from its declaration, and what it extends
//! and uses from the index. Volt's functional API (`state()`, closures) isn't read.

use std::path::Path;

use mago_allocator::LocalArena;
use mago_span::HasSpan;
use mago_syntax::cst::{ClassLikeMember, Modifier, Node, Property, PropertyItem};

use super::{COMPUTED, Component, Member, MemberKind, class_members, livewires};
use crate::analysis::Parsed;
use crate::index::Index;
use crate::locate::walk;

/// The Volt component the view declares, if any.
pub fn component(index: &Index, path: &Path, text: &str) -> Option<Component> {
    let src = text.as_bytes();
    // The `<?php` block that declares the class.
    let class = text.find("new class")?;
    let start = text[..class].rfind("<?php")?;
    let end = text[start..].find("?>").map_or(text.len(), |e| start + e);
    if end < class {
        return None;
    }
    // The block alone, at its offsets in the view.
    let php: String = src.iter().enumerate().map(|(i, b)| if (start..end).contains(&i) || *b == b'\n' { *b as char } else { ' ' }).collect();
    let php = if php.is_char_boundary(end) { php } else { return None };
    let arena = LocalArena::new();
    let parsed = Parsed::new(&arena, path, &php);
    let resolve = |span: mago_span::Span| parsed.names.resolve(&span).map(|n| String::from_utf8_lossy(n).into_owned());
    let mut found = None;
    walk(&parsed, |node, _| {
        if found.is_some() {
            return;
        }
        let Node::AnonymousClass(class) = node else { return };
        let codebase = &index.codebase;
        let parent = class.extends.as_ref().and_then(|e| e.types.first()).and_then(|t| resolve(t.span()));
        // The index holds what the app's PHP reaches, which may leave out Volt's base class when only views use it.
        let named = |p: &str| ["livewire\\component", "livewire\\volt\\component"].contains(&p.to_ascii_lowercase().as_str());
        if !parent.as_deref().is_some_and(|p| named(p) || super::is_component(codebase, p)) {
            return;
        }
        let mut component = Component { classes: vec![], members: vec![], all_properties: true, all_methods: true };
        let mut bases: Vec<String> = parent.into_iter().collect();
        let public = |modifiers: &mago_syntax::cst::Sequence<'_, Modifier<'_>>| {
            let visibility = modifiers.iter().find(|m| matches!(m, Modifier::Public(_) | Modifier::Protected(_) | Modifier::Private(_)));
            !modifiers.iter().any(|m| matches!(m, Modifier::Static(_))) && !matches!(visibility, Some(Modifier::Protected(_) | Modifier::Private(_)))
        };
        let source = |span: mago_span::Span| text[span.start.offset as usize..span.end.offset as usize].to_string();
        for member in class.members.iter() {
            match member {
                ClassLikeMember::TraitUse(u) => bases.extend(u.trait_names.iter().filter_map(|t| resolve(t.span()))),
                ClassLikeMember::Property(p) => {
                    let (modifiers, hint, variables): (_, _, Vec<_>) = match p {
                        Property::Plain(p) => (&p.modifiers, &p.hint, p.items.iter().map(PropertyItem::variable).collect()),
                        Property::Hooked(p) => (&p.modifiers, &p.hint, vec![p.item.variable()]),
                    };
                    if !public(modifiers) {
                        continue;
                    }
                    for v in variables {
                        let span = p.span();
                        component.members.push(Member {
                            name: String::from_utf8_lossy(v.name).trim_start_matches('$').to_string(),
                            kind: MemberKind::Property,
                            class: None,
                            volt: Some((span.start.offset, span.end.offset)),
                            detail: hint.as_ref().map(|h| source(h.span())).unwrap_or_default(),
                            form: hint.as_ref().and_then(|h| resolve(h.span())).filter(|c| codebase.is_instance_of(c.as_bytes(), super::FORM.as_bytes())),
                        });
                    }
                }
                ClassLikeMember::Method(m) => {
                    let name = String::from_utf8_lossy(m.name.value).into_owned();
                    let signature = (m.span().start.offset, m.parameter_list.span().end.offset.max(m.return_type_hint.as_ref().map_or(0, |r| r.span().end.offset)));
                    let returns = m.return_type_hint.as_ref().map(|r| source(r.hint.span())).unwrap_or_default();
                    let computed = m.attribute_lists.iter().flat_map(|l| l.attributes.iter()).any(|a| resolve(a.name.span()).is_some_and(|n| n.eq_ignore_ascii_case(COMPUTED)));
                    if computed {
                        component.members.push(Member { name: name.clone(), kind: MemberKind::Computed, class: None, volt: Some(signature), detail: returns.clone(), form: None });
                    }
                    if public(&m.modifiers) && !name.starts_with("__") {
                        let detail = format!("{}{}", source(m.parameter_list.span()), if returns.is_empty() { String::new() } else { format!(": {returns}") });
                        component.members.push(Member { name: name.clone(), kind: MemberKind::Method, class: None, volt: Some(signature), detail, form: None });
                    }
                    // A `__get()` or `__call()` of its own may answer for any name.
                    if name.eq_ignore_ascii_case("__get") {
                        component.all_properties = false;
                    }
                    if name.eq_ignore_ascii_case("__call") {
                        component.all_methods = false;
                    }
                }
                _ => {}
            }
        }
        for base in bases {
            if livewires(&base) {
                continue;
            }
            let (props, methods) = class_members(index, &base, &mut component.members);
            component.all_properties &= props;
            component.all_methods &= methods;
        }
        found = Some(component);
    });
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fixture;

    #[test]
    fn reads_a_volt_components_members_from_its_view() {
        let livewire = "<?php\nnamespace Livewire { abstract class Component { public function __get($p) {} } }\nnamespace Livewire\\Volt { abstract class Component extends \\Livewire\\Component {} }\nnamespace Livewire\\Attributes { #[\\Attribute] class Computed {} }\nnamespace App { trait Sorts { public string $sort = ''; public function sortBy(string $c): void {} } }\n";
        let view = "<?php\nuse Livewire\\Volt\\Component;\nuse Livewire\\Attributes\\Computed;\nnew class extends Component {\n    use \\App\\Sorts;\n    public string $title = '';\n    protected int $hidden = 0;\n    public function save(int $id): void {}\n    #[Computed]\n    public function posts(): array { return []; }\n};\n?>\n<div wire:click=\"save\">{{ $title }}</div>\n";
        let fx = Fixture::new(&[("vendor/livewire.php", livewire), ("resources/views/livewire/x.blade.php", view)]);
        // Without the index's Livewire, its base classes still count, with nothing of their own.
        let bare = Fixture::new(&[("app/x.php", "<?php\n")]);
        let bare_index = bare.snap.index.read();
        assert!(component(&bare_index, &crate::testing::path("resources/views/livewire/x.blade.php"), &view.replace("use \\App\\Sorts;", "")).is_some_and(|c| c.all_methods));
        let index = fx.snap.index.read();
        let c = component(&index, &crate::testing::path("resources/views/livewire/x.blade.php"), view).expect("a Volt component");
        let names: Vec<(String, MemberKind)> = c.members.iter().map(|m| (m.name.clone(), m.kind)).collect();
        assert!(names.contains(&("title".into(), MemberKind::Property)), "{names:?}");
        assert!(names.contains(&("save".into(), MemberKind::Method)));
        assert!(names.contains(&("posts".into(), MemberKind::Computed)));
        assert!(names.contains(&("sort".into(), MemberKind::Property)));
        assert!(names.contains(&("sortBy".into(), MemberKind::Method)));
        assert!(!names.iter().any(|(n, _)| n == "hidden"));
        assert!(c.all_properties && c.all_methods);
        let save = c.members.iter().find(|m| m.name == "save").unwrap();
        assert_eq!(save.detail, "(int $id): void");
        assert!(component(&index, &crate::testing::path("resources/views/a.blade.php"), "<div></div>").is_none());
    }
}
