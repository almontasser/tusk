//! A Livewire view's references to its component: `wire:model="title"`, `wire:click="save"`, `$wire.title` in
//! Alpine and `<script>`, and the attributes of a `<livewire:name>` tag. Blade's echoes, `@php` blocks, and comments
//! aren't HTML, so they're skipped.

use lsp_types::{CompletionItem, CompletionItemKind, CompletionTextEdit, Diagnostic, DiagnosticSeverity, Hover, HoverContents, Location, MarkupContent, MarkupKind, NumberOrString, TextEdit};

use super::{Component, Member, MemberKind, form_members, view_component};
use crate::features::Ctx;
use crate::symbol::Symbol;

/// An attribute of an HTML tag: its name's span, its value's without quotes, if it has one, and its tag's name.
#[derive(Debug, Clone)]
pub struct Attr {
    pub name: (usize, usize),
    pub value: Option<(usize, usize)>,
    pub tag: (usize, usize),
}

/// The HTML of a view that holds Alpine and Livewire: its tags' attributes, and its `<script>` bodies.
#[derive(Debug, Default)]
pub struct Scan {
    pub attrs: Vec<Attr>,
    pub scripts: Vec<(usize, usize)>,
}

impl Scan {
    /// Where JavaScript can be: attribute values and `<script>` bodies.
    pub fn js(&self) -> impl Iterator<Item = (usize, usize)> + '_ {
        self.attrs.iter().filter_map(|a| a.value).chain(self.scripts.iter().copied())
    }
}

fn find(src: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    src.get(from..)?.windows(needle.len()).position(|w| w.eq_ignore_ascii_case(needle)).map(|p| p + from)
}

/// The offset past an echo (`{{ }}`, `{!! !!}`, or a `{{-- --}}` comment) at `at`, if one starts there.
fn past_echo(src: &[u8], at: usize) -> Option<usize> {
    let rest = &src[at..];
    let close: &[u8] = if rest.starts_with(b"{{--") {
        b"--}}"
    } else if rest.starts_with(b"{!!") {
        b"!!}"
    } else if rest.starts_with(b"{{") {
        b"}}"
    } else {
        return None;
    };
    Some(find(src, at + 2, close).map_or(src.len(), |e| e + close.len()))
}

/// Scans a view's HTML for tags and scripts.
pub fn scan(text: &str) -> Scan {
    let src = text.as_bytes();
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let at_word = |i: usize, w: &[u8]| src[i..].starts_with(w) && !src.get(i + w.len()).is_some_and(|b| word(*b));
    let mut out = Scan::default();
    let mut i = 0;
    while i < src.len() {
        let rest = &src[i..];
        if let Some(end) = past_echo(src, i) {
            i = end;
        } else if rest.starts_with(b"@{{") || rest.starts_with(b"@@") {
            i += 3;
        } else if at_word(i, b"@php") && src[i + 4..].iter().find(|b| !b.is_ascii_whitespace()) != Some(&b'(') {
            i = find(src, i, b"@endphp").map_or(src.len(), |e| e + 7);
        } else if rest.starts_with(b"<?") {
            i = find(src, i, b"?>").map_or(src.len(), |e| e + 2);
        } else if at_word(i, b"@verbatim") {
            i = find(src, i, b"@endverbatim").map_or(src.len(), |e| e + 12);
        } else if rest.starts_with(b"<!--") {
            i = find(src, i, b"-->").map_or(src.len(), |e| e + 3);
        } else if rest[0] == b'<' && rest.get(1).is_some_and(u8::is_ascii_alphabetic) {
            i = tag(src, i, &mut out);
        } else {
            i += 1;
        }
    }
    out
}

/// Reads the tag at `at`, a `<`, into `out`, and returns the offset after it, or after a `<script>`'s or
/// `<style>`'s body.
fn tag(src: &[u8], at: usize, out: &mut Scan) -> usize {
    let tag_start = at + 1;
    let tag_end = tag_start + src[tag_start..].iter().take_while(|b| !b.is_ascii_whitespace() && !matches!(b, b'>' | b'/')).count();
    let mut j = tag_end;
    loop {
        j += src[j.min(src.len())..].iter().take_while(|b| b.is_ascii_whitespace()).count();
        let Some(&b) = src.get(j) else { break };
        if b == b'>' {
            j += 1;
            break;
        }
        if src[j..].starts_with(b"/>") {
            j += 2;
            break;
        }
        // A tag still being typed, before the next one.
        if b == b'<' {
            break;
        }
        if let Some(end) = past_echo(src, j) {
            j = end;
            continue;
        }
        // A directive with arguments among the attributes, such as `@if($a)` or `@class([...])`.
        if b == b'@' {
            let name_end = j + 1 + src[j + 1..].iter().take_while(|b| b.is_ascii_alphanumeric() || **b == b'_').count();
            let open = name_end + src[name_end..].iter().take_while(|b| matches!(b, b' ' | b'\t')).count();
            if src.get(open) == Some(&b'(') {
                j = super::super::blade::matching_paren(src, open).map_or(src.len(), |e| e + 1);
                continue;
            }
        }
        let name_start = j;
        while j < src.len() && !src[j].is_ascii_whitespace() && !matches!(src[j], b'=' | b'>' | b'"' | b'\'' | b'<') && !src[j..].starts_with(b"/>") {
            j += 1;
        }
        if j == name_start {
            j += 1;
            continue;
        }
        let name = (name_start, j);
        let mut k = j + src[j..].iter().take_while(|b| b.is_ascii_whitespace()).count();
        let mut value = None;
        if src.get(k) == Some(&b'=') {
            k += 1;
            k += src[k..].iter().take_while(|b| b.is_ascii_whitespace()).count();
            match src.get(k) {
                Some(&q @ (b'"' | b'\'')) => {
                    let mut e = k + 1;
                    while e < src.len() && src[e] != q {
                        e = past_echo(src, e).unwrap_or(e + 1);
                    }
                    value = Some((k + 1, e.min(src.len())));
                    k = (e + 1).min(src.len());
                }
                Some(_) => {
                    let e = k + src[k..].iter().take_while(|b| !b.is_ascii_whitespace() && **b != b'>').count();
                    value = Some((k, e));
                    k = e;
                }
                None => {}
            }
            j = k;
        }
        out.attrs.push(Attr { name, value, tag: (tag_start, tag_end) });
    }
    let name = std::str::from_utf8(&src[tag_start..tag_end]).unwrap_or_default();
    for body in ["script", "style"] {
        if name.eq_ignore_ascii_case(body) && !src[..j].ends_with(b"/>") {
            let end = find(src, j, format!("</{body}").as_bytes()).unwrap_or(src.len());
            if body == "script" {
                out.scripts.push((j, end));
            }
            return end;
        }
    }
    j
}

/// What a reference in the view names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefKind {
    /// A property, as `wire:model` binds it.
    Property,
    /// A property of the Form object in the component's property, as in `wire:model="form.title"`.
    FormProperty(String),
    /// A method, as `wire:click` calls it.
    Method,
    /// A property or a method, as `$wire.name` or `wire:target` names it.
    Member,
}

/// A name in the view that refers to its component's member.
#[derive(Debug, Clone)]
pub struct Ref {
    pub start: usize,
    pub end: usize,
    pub kind: RefKind,
    /// Whether a missing member is a problem: the name is all the value says, as Livewire reads it.
    pub checked: bool,
}

/// The `wire:` directives whose value is an action, `$wire.` and an expression, as Livewire binds any directive
/// it doesn't know to an event of its name. Others, such as `wire:loading` and `wire:navigate`, aren't checked.
const ACTIONS: &[&str] = &[
    "click", "dblclick", "submit", "change", "input", "keydown", "keyup", "keypress", "blur", "focus", "focusin", "focusout", "mouseenter",
    "mouseleave", "mousedown", "mouseup", "mouseover", "mouseout", "contextmenu", "scroll", "paste", "copy", "cut", "drop", "dragstart", "dragend",
    "select", "reset", "poll", "init", "intersect",
];

/// Livewire's magic actions, which `wire:click` and `$wire` know without the component.
const MAGIC: &[(&str, &str)] = &[
    ("$refresh", "Re-renders the component."),
    ("$set", "Sets a property: `$set('name', value)`."),
    ("$toggle", "Toggles a boolean property: `$toggle('name')`."),
    ("$dispatch", "Dispatches an event: `$dispatch('name', params)`."),
    ("$dispatchSelf", "Dispatches an event to this component only."),
    ("$dispatchTo", "Dispatches an event to another component: `$dispatchTo('component', 'name')`."),
    ("$parent", "The parent component, as `$parent.method()`."),
    ("$commit", "Sends pending updates and re-renders."),
];

/// `$wire`'s own properties and methods in JavaScript, besides the magic actions.
const WIRE_JS: &[&str] = &["$get", "$call", "$on", "$el", "$id", "$js", "$watch", "$entangle", "$hook", "$upload", "$uploadMultiple", "$removeUpload", "$cancelUpload"];

fn ident_len(s: &[u8]) -> usize {
    if !s.first().is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_') {
        return 0;
    }
    s.iter().take_while(|b| b.is_ascii_alphanumeric() || **b == b'_').count()
}

/// The directive of a `wire:` attribute, without its modifiers: `click` for `wire:click.prevent`.
fn directive<'t>(text: &'t str, attr: &Attr) -> Option<&'t str> {
    let name = text[attr.name.0..attr.name.1].strip_prefix("wire:")?;
    Some(name.split('.').next().unwrap_or(name))
}

/// The references in a property path at `at`, such as `form.title`: the property, and, after it, a Form object's.
fn path_refs(text: &str, at: usize, end: usize, out: &mut Vec<Ref>) {
    let src = text.as_bytes();
    let at = at + src[at..end].iter().take_while(|b| b.is_ascii_whitespace()).count();
    let first = ident_len(&src[at..end]);
    if first == 0 {
        return;
    }
    let after = at + first;
    let rest = text[after..end].trim_end();
    // `items.{{ $i }}` and `items[0]` are read up to the property.
    out.push(Ref { start: at, end: after, kind: RefKind::Property, checked: rest.is_empty() || rest.starts_with(['.', '[']) });
    if let Some(sub) = rest.strip_prefix('.') {
        let second = ident_len(sub.as_bytes());
        let next = sub[second..].trim_end();
        if second > 0 {
            let start = after + 1;
            let checked = next.is_empty() || next.starts_with(['.', '[']);
            out.push(Ref { start, end: start + second, kind: RefKind::FormProperty(text[at..after].to_string()), checked });
        }
    }
}

/// The references in an action, such as `save(1)`, `$set('title', '')`, or `$toggle('open')`.
fn action_refs(text: &str, at: usize, end: usize, out: &mut Vec<Ref>) {
    let src = text.as_bytes();
    let at = at + src[at..end].iter().take_while(|b| b.is_ascii_whitespace()).count();
    if src.get(at) == Some(&b'$') {
        let name = 1 + ident_len(&src[at + 1..end]);
        if matches!(&text[at..at + name], "$set" | "$toggle") {
            let open = at + name + src[at + name..end].iter().take_while(|b| b.is_ascii_whitespace()).count();
            if src.get(open) == Some(&b'(') {
                let q = open + 1 + src[open + 1..end].iter().take_while(|b| b.is_ascii_whitespace()).count();
                if let Some(&quote @ (b'\'' | b'"')) = src.get(q) {
                    let close = src[q + 1..end].iter().position(|b| *b == quote).map_or(end, |p| q + 1 + p);
                    path_refs(text, q + 1, close, out);
                }
            }
        }
        return;
    }
    let len = ident_len(&src[at..end]);
    if len == 0 {
        return;
    }
    let rest = text[at + len..end].trim();
    // `object.method()` isn't the component's.
    if rest.starts_with('.') {
        return;
    }
    let call_only = match rest.strip_prefix('(') {
        None => rest.is_empty() || rest == ";",
        Some(_) => {
            let open = at + len + text[at + len..end].find('(').unwrap_or(0);
            super::super::blade::matching_paren(&src[..end], open).is_some_and(|close| matches!(text[close + 1..end].trim(), "" | ";"))
        }
    };
    out.push(Ref { start: at, end: at + len, kind: RefKind::Method, checked: call_only });
}

/// Every reference in the view to its component.
pub fn refs(text: &str, scan: &Scan) -> Vec<Ref> {
    let mut out = vec![];
    for attr in &scan.attrs {
        let (Some(d), Some((start, end))) = (directive(text, attr), attr.value) else { continue };
        match d {
            "model" => path_refs(text, start, end, &mut out),
            "target" => {
                let mut at = start;
                for part in text[start..end].split(',') {
                    let lead = part.len() - part.trim_start().len();
                    let len = ident_len(part.trim_start().as_bytes());
                    if len > 0 {
                        out.push(Ref { start: at + lead, end: at + lead + len, kind: RefKind::Member, checked: false });
                    }
                    at += part.len() + 1;
                }
            }
            d if ACTIONS.contains(&d) => action_refs(text, start, end, &mut out),
            _ => {}
        }
    }
    for (start, end) in scan.js() {
        wire_refs(text, start, end, &mut out);
    }
    out.sort_by_key(|r| r.start);
    out
}

/// `$wire.name`, `$wire.form.title`, and the property or method names in `$wire.$set('name')`, `$wire.call('name')`,
/// and the like, in JavaScript from `start` to `end`.
fn wire_refs(text: &str, start: usize, end: usize, out: &mut Vec<Ref>) {
    let src = text.as_bytes();
    for (at, _) in text[start..end].match_indices("$wire.") {
        let at = start + at + 6;
        if src.get(at) == Some(&b'$') || at >= end {
            // `$wire.$set('name')`: the string names a property.
            let name = 1 + ident_len(&src[(at + 1).min(end)..end]);
            string_ref(text, at + name, end, &text[at..at + name], out);
            continue;
        }
        let len = ident_len(&src[at..end]);
        if len == 0 {
            continue;
        }
        let name = &text[at..at + len];
        if ["set", "get", "toggle", "entangle", "watch", "call"].contains(&name) && src.get(at + len) == Some(&b'(') {
            string_ref(text, at + len, end, &format!("${name}"), out);
            continue;
        }
        if ["on", "el", "id", "js", "hook", "commit", "dispatch", "dispatchTo", "dispatchSelf", "upload", "uploadMultiple", "removeUpload", "cancelUpload", "__instance"].contains(&name) {
            continue;
        }
        out.push(Ref { start: at, end: at + len, kind: RefKind::Member, checked: false });
        if src.get(at + len) == Some(&b'.') {
            let sub = ident_len(&src[at + len + 1..end]);
            if sub > 0 {
                out.push(Ref { start: at + len + 1, end: at + len + 1 + sub, kind: RefKind::FormProperty(name.to_string()), checked: false });
            }
        }
    }
}

/// The name in the string that a `$wire` method at `at` takes first, such as `title` in `$set('title', 1)`.
fn string_ref(text: &str, at: usize, end: usize, method: &str, out: &mut Vec<Ref>) {
    let src = text.as_bytes();
    let kind = match method {
        "$set" | "$get" | "$toggle" | "$entangle" | "$watch" => RefKind::Property,
        "$call" => RefKind::Method,
        _ => return,
    };
    if src.get(at) != Some(&b'(') {
        return;
    }
    let q = at + 1 + src[at + 1..end].iter().take_while(|b| b.is_ascii_whitespace()).count();
    let Some(&quote @ (b'\'' | b'"' | b'`')) = src.get(q) else { return };
    let close = src[q + 1..end].iter().position(|b| *b == quote).map_or(end, |p| q + 1 + p);
    let len = ident_len(&src[q + 1..close]);
    if len == 0 {
        return;
    }
    let property = kind == RefKind::Property;
    out.push(Ref { start: q + 1, end: q + 1 + len, kind, checked: false });
    if src.get(q + 1 + len) == Some(&b'.') && property {
        let sub = ident_len(&src[q + 2 + len..close]);
        if sub > 0 {
            out.push(Ref { start: q + 2 + len, end: q + 2 + len + sub, kind: RefKind::FormProperty(text[q + 1..q + 1 + len].to_string()), checked: false });
        }
    }
}

/// The member a reference names, if the component has it.
fn resolve(ctx: &Ctx<'_>, component: &Component, text: &str, r: &Ref) -> Option<Member> {
    let name = &text[r.start..r.end];
    match &r.kind {
        RefKind::Property => component.member(name, &[MemberKind::Property]).cloned(),
        RefKind::Method => component.member(name, &[MemberKind::Method]).cloned(),
        RefKind::Member => component.member(name, &[MemberKind::Property, MemberKind::Method]).cloned(),
        RefKind::FormProperty(parent) => {
            let form = component.member(parent, &[MemberKind::Property])?.form.clone()?;
            form_members(&ctx.index, &form).0.into_iter().find(|m| m.name == name)
        }
    }
}

/// The component of the Blade view in `ctx`, if it's a Livewire view.
fn component(ctx: &Ctx<'_>) -> Option<Component> {
    view_component(&ctx.index, &|p| ctx.snap.read(p), &ctx.doc.path, &ctx.doc.text)
}

pub fn diagnostics(ctx: &Ctx<'_>) -> Vec<Diagnostic> {
    let Some(component) = component(ctx) else { return vec![] };
    let text = &ctx.doc.text;
    let scan = scan(text);
    let on = if component.classes.is_empty() { "this Volt component".to_string() } else { format!("component [{}]", component.classes.join("|")) };
    let mut out = vec![];
    for r in refs(text, &scan).into_iter().filter(|r| r.checked) {
        let name = &text[r.start..r.end];
        let message = match &r.kind {
            RefKind::Property if component.all_properties && component.member(name, &[MemberKind::Property]).is_none() => {
                format!("Property [${name}] not found on {on}.")
            }
            RefKind::Method if component.all_methods && component.member(name, &[MemberKind::Method]).is_none() => {
                format!("Method [{name}] not found on {on}.")
            }
            RefKind::FormProperty(parent) => {
                let Some(form) = component.member(parent, &[MemberKind::Property]).and_then(|m| m.form.clone()) else { continue };
                let (members, all) = form_members(&ctx.index, &form);
                if !all || members.iter().any(|m| m.name == name) {
                    continue;
                }
                format!("Property [${name}] not found on form [{form}].")
            }
            _ => continue,
        };
        out.push(Diagnostic {
            range: ctx.doc.range(r.start as u32, r.end as u32),
            severity: Some(DiagnosticSeverity::WARNING),
            code: Some(NumberOrString::String("livewire".into())),
            source: Some(super::super::SOURCE.into()),
            message,
            ..Default::default()
        });
    }
    out
}

/// The symbol a member is, for its hover and declaration.
fn symbol(member: &Member) -> Option<Symbol> {
    let class = member.class.clone()?;
    let name = member.name.clone();
    Some(match member.kind {
        MemberKind::Property => Symbol::Property { class, name },
        MemberKind::Method => Symbol::Method { class, name },
        // A legacy `getNameProperty()` is found as `name`'s property, which falls back to the method.
        MemberKind::Computed => Symbol::Property { class, name },
    })
}

/// A member's hover, from its declaration.
pub fn member_hover(ctx: &Ctx<'_>, member: &Member, text: &str) -> Option<String> {
    if let Some((start, end)) = member.volt {
        return Some(format!("```php\n<?php\n{}\n```", text[start as usize..end as usize].trim()));
    }
    crate::features::hover::describe(ctx, &symbol(member)?, 0, 0)
}

/// A member's declaration.
pub fn member_location(ctx: &Ctx<'_>, member: &Member) -> Option<Location> {
    if let Some((start, end)) = member.volt {
        return Some(Location { uri: ctx.doc.uri.clone(), range: ctx.doc.range(start, end) });
    }
    let place = crate::locate::declaration(&symbol(member)?, &ctx.index.codebase)?;
    ctx.snap.location(&ctx.index, place)
}

fn at(refs: &[Ref], offset: usize) -> Option<&Ref> {
    refs.iter().find(|r| r.start <= offset && offset <= r.end)
}

pub fn hover(ctx: &Ctx<'_>, offset: u32) -> Option<Hover> {
    let text = &ctx.doc.text;
    let scan = scan(text);
    let refs = refs(text, &scan);
    let r = at(&refs, offset as usize)?;
    let component = component(ctx)?;
    let member = resolve(ctx, &component, text, r)?;
    Some(Hover {
        contents: HoverContents::Markup(MarkupContent { kind: MarkupKind::Markdown, value: member_hover(ctx, &member, text)? }),
        range: Some(ctx.doc.range(r.start as u32, r.end as u32)),
    })
}

pub fn definition(ctx: &Ctx<'_>, offset: u32) -> Vec<Location> {
    let text = &ctx.doc.text;
    let scan = scan(text);
    let refs = refs(text, &scan);
    let Some(r) = at(&refs, offset as usize) else { return vec![] };
    let Some(component) = component(ctx) else { return vec![] };
    resolve(ctx, &component, text, r).and_then(|m| member_location(ctx, &m)).into_iter().collect()
}

fn item(member: &Member, range: lsp_types::Range) -> CompletionItem {
    CompletionItem {
        label: member.name.clone(),
        kind: Some(if member.kind == MemberKind::Method { CompletionItemKind::METHOD } else { CompletionItemKind::PROPERTY }),
        detail: (!member.detail.is_empty()).then(|| member.detail.clone()),
        text_edit: Some(CompletionTextEdit::Edit(TextEdit { range, new_text: member.name.clone() })),
        ..Default::default()
    }
}

/// What a completion at the cursor offers.
enum Want {
    Properties,
    Methods,
    /// Properties and methods, with `$wire`'s own in JavaScript.
    Members { js: bool },
    /// A Form object's properties, in the component's property.
    Form(String),
    /// A component tag's properties and `mount()` parameters.
    Tag(String),
}

pub fn completion(ctx: &Ctx<'_>, offset: u32) -> Option<Vec<CompletionItem>> {
    let text = &ctx.doc.text;
    let offset = offset as usize;
    let src = text.as_bytes();
    let scan = scan(text);
    // The word being typed, `$` included for magic actions.
    let word = src[..offset].iter().rev().take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'$')).count();
    let start = offset - word;
    let attr = scan.attrs.iter().find(|a| a.value.is_some_and(|(s, e)| s <= offset && offset <= e));
    let in_js = scan.js().any(|(s, e)| s <= offset && offset <= e);
    let before = &text[..start];
    let want = if let Some(form) = before.strip_suffix('.').and_then(|b| b.rsplit("$wire.").next().filter(|_| b.contains("$wire.")).filter(|p| ident_len(p.as_bytes()) == p.len() && !p.is_empty())) {
        Want::Form(form.to_string())
    } else if before.ends_with("$wire.") && in_js {
        Want::Members { js: true }
    } else if let Some(want) = in_js.then(|| string_want(before)).flatten() {
        want
    } else if let Some(attr) = attr {
        let (value_start, _) = attr.value?;
        let typed = &text[value_start..start];
        match directive(text, attr) {
            Some("model") => match typed.trim_start().strip_suffix('.') {
                Some(parent) if ident_len(parent.as_bytes()) == parent.len() => Want::Form(parent.to_string()),
                None if typed.trim().is_empty() => Want::Properties,
                _ => return None,
            },
            Some("target") if typed.trim_end().is_empty() || typed.trim_end().ends_with(',') => Want::Members { js: false },
            Some(d) if ACTIONS.contains(&d) && typed.trim().is_empty() => Want::Methods,
            Some(d) if ACTIONS.contains(&d) => string_want(&text[..start])?,
            _ => return None,
        }
    } else {
        // An attribute's name in a `<livewire:name>` tag.
        let lt = before.rfind('<')?;
        let tag = &text[lt + 1..];
        let name = tag.strip_prefix("livewire:")?;
        let name = &name[..name.find(|c: char| c.is_whitespace() || c == '/' || c == '>')?];
        let between = &text[lt..start];
        if between.contains('>') || !before.trim_end_matches(':').ends_with(char::is_whitespace) {
            return None;
        }
        Want::Tag(name.to_string())
    };
    let range = ctx.doc.range(start as u32, offset as u32);
    let read = |p: &std::path::Path| ctx.snap.read(p);
    let items: Vec<CompletionItem> = match want {
        Want::Tag(name) => {
            let class = super::tag_class(&ctx.index, &read, &name)?;
            let component = super::component_of(&ctx.index, vec![class.clone()]);
            let mut items: Vec<CompletionItem> = component.members.iter().filter(|m| m.kind == MemberKind::Property).map(|m| item(m, range)).collect();
            let mount = ctx.index.codebase.get_method(class.as_bytes(), b"mount");
            for p in mount.iter().flat_map(|m| m.parameters.iter()) {
                let name = p.get_name().0.as_str_lossy().trim_start_matches('$').to_string();
                if !items.iter().any(|i| i.label == name) {
                    let detail = p.type_metadata.as_ref().map(|t| crate::types::display(&t.type_union));
                    items.push(CompletionItem { detail, ..item(&Member { name, kind: MemberKind::Property, class: None, volt: None, detail: String::new(), form: None }, range) });
                }
            }
            items
        }
        want => {
            let component = component(ctx)?;
            match want {
                Want::Properties => component.members.iter().filter(|m| m.kind == MemberKind::Property).map(|m| item(m, range)).collect(),
                Want::Methods => {
                    let mut items: Vec<CompletionItem> = component.members.iter().filter(|m| m.kind == MemberKind::Method && !super::lifecycle(&m.name)).map(|m| item(m, range)).collect();
                    items.extend(MAGIC.iter().map(|(name, doc)| magic(name, doc, range)));
                    items
                }
                Want::Members { js } => {
                    let mut items: Vec<CompletionItem> = component.members.iter().filter(|m| m.kind == MemberKind::Property || (m.kind == MemberKind::Method && !super::lifecycle(&m.name))).map(|m| item(m, range)).collect();
                    if js {
                        items.extend(MAGIC.iter().map(|(name, doc)| magic(name, doc, range)));
                        items.extend(WIRE_JS.iter().map(|name| magic(name, "", range)));
                    }
                    items
                }
                Want::Form(parent) => {
                    let form = component.member(&parent, &[MemberKind::Property])?.form.clone()?;
                    form_members(&ctx.index, &form).0.iter().map(|m| item(m, range)).collect()
                }
                Want::Tag(_) => vec![],
            }
        }
    };
    (!items.is_empty()).then_some(items)
}

/// What the string being typed at the end of `before` names, as the first argument of `$set('`, `$toggle('`,
/// `$wire.call('`, and the like.
fn string_want(before: &str) -> Option<Want> {
    let open = before.rfind(['\'', '"', '`'])?;
    if !before[open + 1..].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return None;
    }
    let call = before[..open].trim_end().strip_suffix('(')?.trim_end();
    let name_len = call.bytes().rev().take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'$')).count();
    let name = &call[call.len() - name_len..];
    let on_wire = call[..call.len() - name_len].ends_with("$wire.");
    match name {
        "$set" | "$toggle" | "$get" | "$entangle" | "$watch" => Some(Want::Properties),
        "set" | "get" | "entangle" | "watch" if on_wire => Some(Want::Properties),
        "$call" => Some(Want::Methods),
        "call" if on_wire => Some(Want::Methods),
        _ => None,
    }
}

fn magic(name: &str, doc: &str, range: lsp_types::Range) -> CompletionItem {
    CompletionItem {
        label: name.to_string(),
        kind: Some(CompletionItemKind::FUNCTION),
        detail: (!doc.is_empty()).then(|| doc.to_string()),
        sort_text: Some(format!("~{name}")),
        text_edit: Some(CompletionTextEdit::Edit(TextEdit { range, new_text: name.to_string() })),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(text: &str) -> Vec<(String, RefKind, bool)> {
        refs(text, &scan(text)).into_iter().map(|r| (text[r.start..r.end].to_string(), r.kind, r.checked)).collect()
    }

    #[test]
    fn finds_wire_directives_and_wire_in_alpine_and_scripts() {
        let view = r#"<div x-data="{ open: $wire.open }">
  <input wire:model.live.debounce.250ms="form.title" title="{{ __("a") }}">
  <button wire:click="save(1, '{{ $x }}')" wire:keydown.enter="search" wire:loading.attr="disabled" wire:target="save, title">Go</button>
  <a wire:click="$set('title', '')" @click="$wire.call('reset')" wire:submit="a(); b()" wire:change="obj.run()">x</a>
  {{-- <b wire:click="hidden"> --}}
  @php $y = '<b wire:click="php">'; @endphp
</div>
<script>let t = $wire.$get('count'); $wire.form.body = 1; $wire.$refresh()</script>"#;
        let p = RefKind::Property;
        let form = RefKind::FormProperty("form".into());
        assert_eq!(
            names(view),
            vec![
                ("open".into(), RefKind::Member, false),
                ("form".into(), p.clone(), true),
                ("title".into(), form.clone(), true),
                ("save".into(), RefKind::Method, true),
                ("search".into(), RefKind::Method, true),
                ("save".into(), RefKind::Member, false),
                ("title".into(), RefKind::Member, false),
                ("title".into(), p.clone(), true),
                ("reset".into(), RefKind::Method, false),
                ("a".into(), RefKind::Method, false),
                ("count".into(), p.clone(), false),
                ("form".into(), RefKind::Member, false),
                ("body".into(), form, false),
            ]
        );
    }

    #[test]
    fn reads_unfinished_tags_and_echoes_in_attributes() {
        let view = "<input wire:model=\"items.{{ $i }}\" @if($a) disabled @endif wire:click=\"go\"\n<p>";
        assert_eq!(names(view), vec![("items".into(), RefKind::Property, true), ("go".into(), RefKind::Method, true)]);
    }
}
