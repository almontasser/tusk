//! Icons from blade-icons sets, such as blade-heroicons: the names Filament's `->icon()` and its kin take,
//! `svg()` and `@svg()`, and `<x-heroicon-o-user />` tags.
//!
//! ```php
//! ->icon('heroicon-o-user')                         // completes, previews, and checks the name
//! protected static ?string $navigationIcon = 'heroicon-o-users';
//! Heroicon::OutlinedUser                            // previews Filament's enum case
//! ```
//! ```blade
//! <x-heroicon-o-user class="h-5" />  @svg('heroicon-o-user')  <x-filament::icon icon="heroicon-o-user" />
//! ```
//!
//! The sets come from the booted app (`icon-sets.php`), or, when it can't boot, from each installed package's
//! service provider and config. Each set's SVG names are listed once, cached until `composer.lock`, `config/`,
//! or a provider changes. A completion lists names only; `completionItem/resolve` adds the selected one's preview.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use lsp_types::{
    CompletionItem, CompletionItemKind, CompletionTextEdit, Diagnostic, DiagnosticSeverity, Hover, HoverContents, Location, MarkupContent,
    MarkupKind, NumberOrString, Position, Range, TextEdit,
};
use serde_json::{Value, json};

use super::values::{BladeTag, Site, Target, blade_tags, site_at, sites};
use super::{InArray, State};
use crate::features::{Ctx, is_blade, with_text};
use crate::text::path_to_uri;

const SCRIPT: &str = include_str!("../../php/laravel/icon-sets.php");

/// What can change the sets or their icons: packages, the app's config, and providers that add sets.
const DEPENDS_ON: &[&str] = &["composer.lock", "config/", "app/Providers/", "bootstrap/providers.php"];

/// An icon set: `prefix` names it in `heroicon-o-user`, and its icons are the SVG files under `paths`, as
/// `o-user` for `o-user.svg` and `sub.name` for `sub/name.svg`.
pub struct Set {
    pub name: String,
    pub prefix: String,
    pub paths: Vec<PathBuf>,
    /// Sorted.
    pub names: Vec<String>,
    /// Whether a name missing from `names` surely fails: the set is read from the booted app, from local folders,
    /// without a fallback icon.
    pub sure: bool,
}

/// The project's icon sets, read once until a file they depend on changes.
pub fn sets(state: &State) -> Arc<Vec<Set>> {
    // `State` caches JSON, so the sets go through it as JSON and are rebuilt from it; both are cheap next to
    // listing the folders, which happens once.
    let value = state.remember("icons:sets", DEPENDS_ON, || discover(state));
    parse_sets(&value)
}

fn parse_sets(value: &Value) -> Arc<Vec<Set>> {
    let strings = |v: &Value| -> Vec<String> { v.as_array().into_iter().flatten().filter_map(|s| s.as_str().map(String::from)).collect() };
    Arc::new(
        value["sets"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|s| Set {
                name: s["name"].as_str().unwrap_or_default().to_string(),
                prefix: s["prefix"].as_str().unwrap_or_default().to_string(),
                paths: strings(&s["paths"]).into_iter().map(PathBuf::from).collect(),
                names: strings(&s["names"]),
                sure: s["sure"] == true,
            })
            .collect(),
    )
}

/// Finds the sets and lists their icons.
fn discover(state: &State) -> Value {
    let root = state.root().to_path_buf();
    let booted = crate::framework::laravel::script(state, "icon-sets", SCRIPT, DEPENDS_ON);
    let (found, from_app) = match booted.as_ref().and_then(|b| b["sets"].as_array().cloned()) {
        Some(sets) => (sets, true),
        None => (static_sets(&root), false),
    };
    let mut out = vec![];
    for set in found {
        let prefix = set["prefix"].as_str().unwrap_or_default();
        if prefix.is_empty() || set["disk"] == true {
            continue;
        }
        let paths: Vec<PathBuf> = set["paths"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| p.as_str())
            .map(|p| if Path::new(p).is_absolute() { PathBuf::from(p) } else { root.join(p) })
            .collect();
        let mut names = vec![];
        for path in &paths {
            for entry in ignore::WalkBuilder::new(path).standard_filters(false).max_depth(Some(6)).build().flatten() {
                let file = entry.path();
                if file.extension().is_some_and(|e| e == "svg")
                    && let Ok(rel) = file.strip_prefix(path)
                {
                    names.push(rel.with_extension("").to_string_lossy().replace(['/', '\\'], "."));
                }
            }
        }
        names.sort();
        names.dedup();
        let paths: Vec<String> = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        out.push(json!({
            "name": set["name"], "prefix": prefix, "paths": paths, "names": names,
            "sure": from_app && set["fallback"] != true && !names.is_empty(),
        }));
    }
    json!({ "sets": out })
}

/// The sets the installed packages add, read from their service providers without booting the app: a package that
/// requires a `blade-ui-kit` package and calls `$factory->add('set', [...])`, with the set's folder as `__DIR__`
/// and a path, and its prefix in the call or as the one `prefix` of the config the provider reads, the project's
/// copy first. A set it can't read so is left out.
fn static_sets(root: &Path) -> Vec<Value> {
    let composer = root.join("vendor/composer");
    let Ok(installed) = std::fs::read(composer.join("installed.json")) else { return vec![] };
    let Ok(installed) = serde_json::from_slice::<Value>(&installed) else { return vec![] };
    let packages = installed["packages"].as_array().or(installed.as_array()).cloned().unwrap_or_default();
    let mut out = vec![];
    for package in packages {
        let uses_icons = package["require"].as_object().is_some_and(|r| r.keys().any(|k| k.starts_with("blade-ui-kit/")));
        let Some(dir) = package["install-path"].as_str().map(|p| composer.join(p)) else { continue };
        if !uses_icons {
            continue;
        }
        for entry in ignore::WalkBuilder::new(dir.join("src")).standard_filters(false).max_depth(Some(3)).build().flatten() {
            let file = entry.path();
            if !file.to_string_lossy().ends_with("ServiceProvider.php") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(file) else { continue };
            out.extend(provider_sets(&text, file.parent().unwrap_or(&dir), &dir, root));
        }
    }
    out
}

/// The sets a service provider's source adds, as [`static_sets`] reads them.
fn provider_sets(text: &str, provider_dir: &Path, package: &Path, root: &Path) -> Vec<Value> {
    let code: String = text.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
    let mut out = vec![];
    for (at, _) in code.match_indices("->add(") {
        let call = &code[at + 6..];
        let call = &call[..call.find(");").unwrap_or(call.len())];
        let Some(name) = quoted(call) else { continue };
        let paths: Vec<String> = call
            .match_indices("__DIR__")
            .filter_map(|(i, _)| {
                let rest = call[i + 7..].trim_start().strip_prefix('.')?;
                Some(provider_dir.join(quoted(rest)?.trim_start_matches('/')).to_string_lossy().into_owned())
            })
            .collect();
        let prefix = string_after(call, "'prefix'").or_else(|| {
            let key = ["->get(", "config("].iter().find_map(|f| code.find(f).and_then(|i| quoted(&code[i + f.len()..])))?;
            let read = |p: PathBuf| std::fs::read_to_string(p).ok();
            let config = read(root.join(format!("config/{key}.php"))).or_else(|| read(package.join(format!("config/{key}.php"))))?;
            let config: String = config.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
            (config.matches("'prefix'").count() == 1).then(|| string_after(&config, "'prefix'")).flatten()
        });
        if let (Some(prefix), false) = (prefix, paths.is_empty()) {
            out.push(json!({ "name": name, "prefix": prefix, "paths": paths }));
        }
    }
    out
}

/// The first single- or double-quoted string in `text`, if it starts it, after spaces.
fn quoted(text: &str) -> Option<String> {
    let text = text.trim_start();
    let q = text.chars().next().filter(|c| *c == '\'' || *c == '"')?;
    let rest = &text[1..];
    Some(rest[..rest.find(q)?].to_string())
}

/// The string after `key =>` in `text`.
fn string_after(text: &str, key: &str) -> Option<String> {
    let rest = text[text.find(key)? + key.len()..].trim_start().strip_prefix("=>")?;
    quoted(rest)
}

/// The set an icon name's prefix names, as blade-icons splits it at the first `-`, and the name within the set.
pub fn split<'s>(sets: &'s [Set], icon: &'s str) -> Option<(&'s Set, &'s str)> {
    let (prefix, name) = icon.split_once('-')?;
    sets.iter().find(|s| s.prefix == prefix).map(|s| (s, name))
}

/// The SVG file of an icon, if it exists.
pub fn file(sets: &[Set], icon: &str) -> Option<PathBuf> {
    let (set, name) = split(sets, icon)?;
    set.names.binary_search_by(|n| n.as_str().cmp(name)).ok()?;
    set.paths.iter().map(|p| p.join(format!("{}.svg", name.replace('.', "/")))).find(|p| p.is_file())
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() { BASE64[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// Markdown that shows an SVG image, `size` pixels square, as Monaco renders a `data:` image with its
/// `|width=,height=` suffix.
pub fn svg_image(svg: &str, alt: &str, size: u32) -> String {
    format!("![{alt}](data:image/svg+xml;base64,{}|width={size},height={size})", base64(svg.as_bytes()))
}

/// An icon's preview, as Markdown: its SVG drawn in a gray that reads on light and dark themes, since an image
/// has no `currentColor` of its own.
pub fn preview(path: &Path, icon: &str) -> Option<String> {
    let svg = std::fs::read_to_string(path).ok()?;
    if svg.len() > 64 * 1024 {
        return None;
    }
    Some(svg_image(&svg.replace("currentColor", "#8b8b8b"), icon, 48))
}

fn hover_text(path: &Path, icon: &str, set: &str) -> String {
    let file = path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
    let link = format!("[{file}]({})", path_to_uri(path).as_str());
    format!("{}\n\n`{icon}` · {set} · {link}", preview(path, icon).unwrap_or_default())
}

/// Whether a method takes an icon as its first argument, as Filament names them: `icon()`, `prefixIcon()`.
/// Filament's test assertions, such as `assertActionHasIcon()`, take the action's name first.
fn icon_method(name: &str) -> bool {
    (name == "icon" || name.ends_with("Icon")) && !name.starts_with("assert")
}

/// Whether a call by this written name may take an icon, so its receiver is worth typing.
fn icon_call(name: &str) -> bool {
    icon_method(name) || name == "icons" || name == "register" || name == "svg"
}

fn is_filament(class: &str, codebase: &mago_codex::metadata::CodebaseMetadata) -> bool {
    class.starts_with("Filament\\") || codebase.is_instance_of(class.as_bytes(), b"Filament\\Support\\Components\\Component")
}

/// What a component array method's keys and values hold, for `->icons([...])` and `->colors([...])`: a panel's
/// values are icons (by alias) and its keys colors it registers; a form field's values, by option; a table
/// column's or infolist entry's keys, when they're strings, else its values.
#[derive(Clone, Copy, PartialEq)]
pub enum Owner {
    Panel,
    Field,
    Column,
    Other,
}

pub fn owner(classes: &[String], codebase: &mago_codex::metadata::CodebaseMetadata) -> Owner {
    let is = |base: &str, namespace: &str| classes.iter().any(|c| c.starts_with(namespace) || codebase.is_instance_of(c.as_bytes(), base.as_bytes()));
    if is("Filament\\Panel", "Filament\\Panel") {
        Owner::Panel
    } else if is("Filament\\Forms\\Components\\Field", "Filament\\Forms\\") {
        Owner::Field
    } else if is("Filament\\Tables\\Columns\\Column", "Filament\\Tables\\") || is("Filament\\Infolists\\Components\\Entry", "Filament\\Infolists\\") {
        Owner::Column
    } else {
        Owner::Other
    }
}

/// Whether a component array's entry is a value the component reads as its own, by the [`Owner`] rules. `None`
/// when the owner's unknown.
pub fn array_entry(owner: Owner, in_array: &InArray) -> Option<bool> {
    match owner {
        Owner::Panel | Owner::Field => Some(matches!(in_array, InArray::Value(_))),
        Owner::Column => Some(matches!(in_array, InArray::Key | InArray::Value(None))),
        Owner::Other => None,
    }
}

/// Whether a site takes an icon: `Some(true)` when surely, `Some(false)` when it may, for an untyped receiver.
fn icon_site(site: &Site, codebase: &mago_codex::metadata::CodebaseMetadata) -> Option<bool> {
    match &site.target {
        Target::Property(name) => (name == "navigationIcon" || name == "activeNavigationIcon").then_some(true),
        Target::Return { class, method } => {
            (method == "getIcon" && codebase.is_instance_of(class.as_bytes(), b"Filament\\Support\\Contracts\\HasIcon")).then_some(true)
        }
        Target::Arg { call, index, name, in_array, closure } => {
            if call.is_function(&["svg"]) {
                return (*index == 0 && in_array.is_none() && !closure).then_some(true);
            }
            if call.is_method(&["register"]) {
                let facade = call.classes.iter().any(|c| c.ends_with("\\FilamentIcon") || c == "FilamentIcon");
                return (facade && matches!(in_array, Some(InArray::Value(_))) && !closure).then_some(true);
            }
            let typed = !call.classes.is_empty();
            if typed && !call.classes.iter().any(|c| is_filament(c, codebase)) {
                return None;
            }
            if call.is_method(&["icons"]) {
                let entry = in_array.as_ref().filter(|_| *index == 0 && !closure)?;
                return match array_entry(owner(&call.classes, codebase), entry) {
                    Some(true) => Some(typed),
                    Some(false) => None,
                    None => Some(false),
                };
            }
            let first = *index == 0 || name.as_deref() == Some("icon");
            (matches!(call.kind, super::CallKind::Method | super::CallKind::Static) && icon_method(&call.name) && first && in_array.is_none()).then_some(typed)
        }
    }
}

/// An icon name written in a Blade view: `(start, end, value, sure)`.
type BladeIcon = (u32, u32, String, bool);

/// Icon names in a Blade view's tags: `<x-filament::icon icon="…">`, any Filament component's `icon` and `*-icon`
/// attributes, `<x-icon name="…">`, and the tags blade-icons registers for each icon, `<x-heroicon-o-user>`, whose
/// span is the name after `x-`.
fn blade_icons(text: &str, sets: &[Set]) -> Vec<BladeIcon> {
    let mut out = vec![];
    for tag in blade_tags(text) {
        if let Some(name) = tag.name.strip_prefix("x-")
            && split(sets, name).is_some()
        {
            out.push((tag.start + 2, tag.end, name.to_string(), true));
        }
        out.extend(icon_attributes(&tag));
    }
    let mut from = 0;
    while let Some(at) = text[from..].find("svg(").map(|i| from + i) {
        from = at + 4;
        let before = text[..at].chars().next_back();
        if before.is_some_and(|c| c.is_alphanumeric() || "_>$:\\".contains(c)) {
            continue;
        }
        let rest = &text[at + 4..];
        let lead = rest.len() - rest.trim_start().len();
        let Some(q) = rest[lead..].chars().next().filter(|c| *c == '\'' || *c == '"') else { continue };
        let start = at + 4 + lead + 1;
        let end = text[start..].find([q, '\n']).map_or(text.len(), |i| start + i);
        out.push((start as u32, end as u32, text[start..end].to_string(), before == Some('@')));
    }
    out
}

fn icon_attributes(tag: &BladeTag) -> Vec<BladeIcon> {
    let filament = tag.name.starts_with("x-filament::") || tag.name.starts_with("x-filament.");
    tag.attributes
        .iter()
        .filter(|a| (filament && (a.name == "icon" || a.name.ends_with("-icon"))) || (tag.name == "x-icon" && a.name == "name"))
        .filter(|a| !a.value.contains("{{"))
        .map(|a| (a.start, a.end, a.value.clone(), true))
        .collect()
}

/// The icon sites of a PHP file: `(start, end, value, sure)`.
fn php_icons(ctx: &Ctx<'_>) -> Vec<BladeIcon> {
    let codebase = &ctx.index.codebase;
    sites(ctx, &icon_call).into_iter().filter_map(|s| icon_site(&s, codebase).map(|sure| (s.start, s.end, s.value, sure))).collect()
}

/// The icon written at `offset`, from any string literal or icon site: `(start, end, value, is_site)`. A string
/// literal that isn't a site counts when it names an icon that exists.
fn icon_at(ctx: &Ctx<'_>, offset: u32) -> Option<(u32, u32, String, bool)> {
    let hit = |s: u32, e: u32| s <= offset && offset <= e;
    if is_blade(&ctx.doc) {
        let sets = sets(&ctx.snap.framework);
        if let Some((s, e, v, _)) = blade_icons(&ctx.doc.text, &sets).into_iter().find(|(s, e, ..)| hit(*s, *e)) {
            return Some((s, e, v, true));
        }
        let text = crate::framework::laravel::blade::virtual_php(&ctx.doc.text, ctx.doc.text.len());
        return with_text(ctx.snap, ctx.doc.clone(), &text, |v| php_icon_at(v, offset));
    }
    php_icon_at(ctx, offset)
}

fn php_icon_at(ctx: &Ctx<'_>, offset: u32) -> Option<(u32, u32, String, bool)> {
    if let Some(site) = site_at(ctx, offset, &icon_call)
        && icon_site(&site, &ctx.index.codebase).is_some()
    {
        return Some((site.start, site.end, site.value, true));
    }
    let path = ctx.parsed.path_at(offset);
    let literal = path.iter().rev().find_map(|n| match n {
        mago_syntax::cst::Node::LiteralString(s) => Some(*s),
        _ => None,
    })?;
    let (start, end) = (literal.span.start.offset + 1, literal.span.end.offset.saturating_sub(1));
    (start <= end && start <= offset && offset <= end).then(|| (start, end, ctx.parsed.text()[start as usize..end as usize].to_string(), false))
}

pub fn completion(ctx: &Ctx<'_>, offset: u32) -> Option<Vec<CompletionItem>> {
    let sets = sets(&ctx.snap.framework);
    if sets.is_empty() {
        return None;
    }
    // A tag being typed: `<x-heroicon-o-us`.
    if is_blade(&ctx.doc) {
        let line = &ctx.doc.text[ctx.doc.text[..offset as usize].rfind('\n').map_or(0, |i| i + 1)..offset as usize];
        let token_len: usize = line.chars().rev().take_while(|c| c.is_alphanumeric() || "-_.:".contains(*c)).map(char::len_utf8).sum();
        let token = &line[line.len() - token_len..];
        if line[..line.len() - token_len].ends_with('<') && token.starts_with("x-") && !token.contains("::") {
            let range = ctx.doc.range(offset - token_len as u32, offset);
            return Some(items(&sets, range, "x-", "~"));
        }
    }
    let (start, _, value, is_site) = icon_at(ctx, offset)?;
    let typed = ctx.doc.text.get(start as usize..offset as usize)?;
    // Any string that starts with a set's prefix completes too, wherever it is.
    if !is_site && !sets.iter().any(|s| typed.starts_with(&format!("{}-", s.prefix))) {
        return None;
    }
    let _ = value;
    Some(items(&sets, ctx.doc.range(start, offset), "", ""))
}

/// Every icon as a completion, whose preview `completionItem/resolve` adds.
fn items(sets: &[Set], range: Range, lead: &str, sort: &str) -> Vec<CompletionItem> {
    let mut out = vec![];
    for set in sets {
        for name in &set.names {
            let icon = format!("{}-{name}", set.prefix);
            let label = format!("{lead}{icon}");
            out.push(CompletionItem {
                kind: Some(CompletionItemKind::VALUE),
                detail: Some(format!("{} icon", set.name)),
                text_edit: Some(CompletionTextEdit::Edit(TextEdit { range, new_text: label.clone() })),
                sort_text: Some(format!("{sort}{label}")),
                data: Some(json!({ "icon": icon })),
                label,
                ..Default::default()
            });
        }
    }
    out
}

/// Adds an icon completion's preview, for an item [`completion`] made.
pub fn resolve(state: &State, item: &mut CompletionItem) -> bool {
    let Some(icon) = item.data.as_ref().and_then(|d| d["icon"].as_str()).map(String::from) else { return false };
    let sets = sets(state);
    if let Some(path) = file(&sets, &icon)
        && let Some(markdown) = preview(&path, &icon)
    {
        item.documentation = Some(lsp_types::Documentation::MarkupContent(MarkupContent { kind: MarkupKind::Markdown, value: markdown }));
    }
    true
}

/// The preview of a case of Filament's `Heroicon` enum, from its declaration: `case OutlinedUser = 'o-user';`
/// draws `heroicon-o-user`, and a case without a style, which Filament draws by size, the solid icon.
pub fn heroicon_case(state: &State, class: &str, declaration: &str) -> Option<String> {
    if !class.trim_start_matches('\\').eq_ignore_ascii_case("Filament\\Support\\Icons\\Heroicon") {
        return None;
    }
    let value = quoted(declaration.split_once('=')?.1)?;
    let icon = if value.starts_with("o-") { format!("heroicon-{value}") } else { format!("heroicon-s-{value}") };
    let sets = sets(state);
    preview(&file(&sets, &icon)?, &icon).map(|p| format!("{p}\n\n`{icon}`"))
}

pub fn hover(ctx: &Ctx<'_>, offset: u32) -> Option<Hover> {
    let (start, end, value, _) = icon_at(ctx, offset)?;
    let sets = sets(&ctx.snap.framework);
    let path = file(&sets, &value)?;
    let (set, _) = split(&sets, &value)?;
    Some(Hover {
        contents: HoverContents::Markup(MarkupContent { kind: MarkupKind::Markdown, value: hover_text(&path, &value, &set.name) }),
        range: Some(ctx.doc.range(start, end)),
    })
}

/// Goes from an icon name to its SVG file.
pub fn definition(ctx: &Ctx<'_>, offset: u32) -> Vec<Location> {
    let Some((_, _, value, _)) = icon_at(ctx, offset) else { return vec![] };
    let sets = sets(&ctx.snap.framework);
    let Some(path) = file(&sets, &value) else { return vec![] };
    vec![Location { uri: path_to_uri(&path), range: Range::new(Position::new(0, 0), Position::new(0, 0)) }]
}

/// Icon names whose set is installed but has no such icon, where the name surely is an icon.
pub fn diagnostics(ctx: &Ctx<'_>) -> Vec<Diagnostic> {
    let sets = sets(&ctx.snap.framework);
    if !sets.iter().any(|s| s.sure) {
        return vec![];
    }
    let found = if is_blade(&ctx.doc) {
        let mut found = blade_icons(&ctx.doc.text, &sets);
        let text = crate::framework::laravel::blade::virtual_php(&ctx.doc.text, ctx.doc.text.len());
        // `svg()` in an echo, which [`blade_icons`] finds too, is read once.
        found.retain(|(.., sure)| *sure);
        found.extend(with_text(ctx.snap, ctx.doc.clone(), &text, php_icons));
        found
    } else {
        php_icons(ctx)
    };
    found
        .into_iter()
        .filter(|(.., sure)| *sure)
        .filter_map(|(start, end, value, _)| {
            let (set, name) = split(&sets, &value)?;
            if !set.sure || name.is_empty() || set.names.binary_search_by(|n| n.as_str().cmp(name)).is_ok() {
                return None;
            }
            Some(Diagnostic {
                range: ctx.doc.range(start, end),
                severity: Some(DiagnosticSeverity::WARNING),
                code: Some(NumberOrString::String("icon".into())),
                source: Some(crate::framework::laravel::SOURCE.into()),
                message: format!("The {} icon set has no icon {name}.", set.name),
                ..Default::default()
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fixture;

    #[test]
    fn encodes_base64() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"<svg/>"), "PHN2Zy8+");
    }

    #[test]
    fn reads_sets_from_providers() {
        let dir = tempfile::tempdir().unwrap();
        let (root, package) = (dir.path().join("app"), dir.path().join("pkg"));
        std::fs::create_dir_all(package.join("config")).unwrap();
        std::fs::create_dir_all(root.join("config")).unwrap();
        std::fs::write(package.join("config/blade-heroicons.php"), "<?php return [\n    'prefix' => 'heroicon',\n    'fallback' => '',\n];").unwrap();
        let provider = "$this->callAfterResolving(Factory::class, function (Factory $factory, Container $container) {\n    $config = $container->make('config')->get('blade-heroicons', []);\n    $factory->add('heroicons', array_merge(['path' => __DIR__.'/../resources/svg'], $config));\n});";
        let sets = provider_sets(provider, &package.join("src"), &package, &root);
        assert_eq!(sets[0]["prefix"], "heroicon");
        assert!(sets[0]["paths"][0].as_str().unwrap().ends_with("pkg/src/../resources/svg"));
        // The project's published config wins.
        std::fs::write(root.join("config/blade-heroicons.php"), "<?php return [\n    // 'prefix' => 'old',\n    'prefix' => 'hero',\n];").unwrap();
        assert_eq!(provider_sets(provider, &package.join("src"), &package, &root)[0]["prefix"], "hero");
        // A prefix in the call, as Filament's own set has.
        let filament = "$factory->add('filament', [\n    'path' => __DIR__ . '/../resources/svg',\n    'prefix' => 'fi',\n]);";
        assert_eq!(provider_sets(filament, &package, &package, &root)[0]["prefix"], "fi");
    }

    /// A project with the heroicons set seeded as `names`, read from the booted app.
    fn fixture(files: &[(&str, &str)], names: &[&str]) -> Fixture {
        let fx = Fixture::new(files);
        let names: Vec<String> = names.iter().map(|n| n.to_string()).collect();
        fx.snap.framework.seed("icons:sets", json!({ "sets": [{ "name": "heroicons", "prefix": "heroicon", "paths": ["/nowhere"], "names": names, "sure": true }] }));
        fx
    }

    const FILAMENT: &str = "<?php\nnamespace Filament\\Support\\Components { class Component {} }\nnamespace Filament\\Actions { class Action extends \\Filament\\Support\\Components\\Component {\n    public static function make(?string $name = null): static { return new static; }\n    public function icon($icon): static { return $this; }\n    public function label($label): static { return $this; }\n} }\nnamespace Filament\\Tables\\Columns { class Column extends \\Filament\\Support\\Components\\Component { public static function make(string $name): static { return new static; } public function icons($icons): static { return $this; } } class IconColumn extends Column {} }\nnamespace Filament\\Support\\Contracts { interface HasIcon { public function getIcon(): ?string; } }\n";

    fn problems(text: &str) -> Vec<String> {
        let fx = fixture(&[("vendor/filament.php", FILAMENT), ("test.php", text)], &["o-user", "s-user"]);
        crate::features::with_ctx(&fx.snap, &crate::testing::uri("test.php"), diagnostics).unwrap().into_iter().map(|d| d.message).collect()
    }

    #[test]
    fn reports_icons_the_set_lacks_only_where_surely_an_icon() {
        let found = problems(
            "<?php\nuse Filament\\Actions\\Action;\nuse Filament\\Tables\\Columns\\IconColumn;\nclass R { protected static ?string $navigationIcon = 'heroicon-o-usr'; }\nenum S: string implements \\Filament\\Support\\Contracts\\HasIcon { case A = 'a'; public function getIcon(): ?string { return match ($this) { self::A => 'heroicon-o-nope' }; } }\nAction::make('x')->icon('heroicon-o-user')->icon('heroicon-o-missing')->icon(fn () => 'heroicon-s-gone')->icon('fa-user')->icon('custom')->label('heroicon-o-label');\nIconColumn::make('s')->icons(['heroicon-o-bad' => 'draft', 'heroicon-o-user' => 'heroicon-o-x']);\n$untyped->icon('heroicon-o-unsure');\n",
        );
        assert_eq!(
            found,
            vec![
                "The heroicons icon set has no icon o-usr.",
                "The heroicons icon set has no icon o-nope.",
                "The heroicons icon set has no icon o-missing.",
                "The heroicons icon set has no icon s-gone.",
                "The heroicons icon set has no icon o-bad.",
            ]
        );
    }

    #[test]
    fn reports_icons_in_blade_tags_and_svg() {
        let fx = fixture(&[("v.blade.php", "<x-heroicon-o-user class=\"h-5\" />\n<x-heroicon-o-nope />\n@svg('heroicon-s-nope')\n<x-filament::icon\n    icon=\"heroicon-o-gone\" />\n<x-filament::button :icon=\"$i\" icon=\"heroicon-o-user\" />\n<x-alert icon=\"heroicon-o-skip\" />\n")], &["o-user"]);
        let found: Vec<String> =
            crate::features::with_ctx(&fx.snap, &crate::testing::uri("v.blade.php"), diagnostics).unwrap().into_iter().map(|d| d.message).collect();
        assert_eq!(found, vec!["The heroicons icon set has no icon o-nope.", "The heroicons icon set has no icon o-gone.", "The heroicons icon set has no icon s-nope."]);
    }

    fn complete(files: &[(&str, &str)]) -> Vec<CompletionItem> {
        let fx = fixture(files, &["o-user", "s-user"]);
        let at = fx.at();
        crate::features::with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| completion(ctx, ctx.offset(at.position))).flatten().unwrap_or_default()
    }

    #[test]
    fn completes_icon_names() {
        let labels = |items: Vec<CompletionItem>| items.into_iter().map(|i| i.label).collect::<Vec<_>>();
        let php = |body: &str| complete(&[("vendor/filament.php", FILAMENT), ("test.php", &format!("<?php\nuse Filament\\Actions\\Action;\n{body}\n"))]);
        assert_eq!(labels(php("Action::make('x')->icon('<|>');")), vec!["heroicon-o-user", "heroicon-s-user"]);
        assert_eq!(labels(php("$x->foo('heroicon-<|>');")), vec!["heroicon-o-user", "heroicon-s-user"]);
        assert!(php("Action::make('x')->label('<|>');").is_empty());
        let item = &php("Action::make('x')->icon('hero<|>');")[0];
        assert_eq!(item.data, Some(json!({ "icon": "heroicon-o-user" })));
        let blade = |text: &str| labels(complete(&[("v.blade.php", text)]));
        assert_eq!(blade("<x-hero<|>"), vec!["x-heroicon-o-user", "x-heroicon-s-user"]);
        assert_eq!(blade("<x-filament::icon icon=\"<|>\" />"), vec!["heroicon-o-user", "heroicon-s-user"]);
    }

    #[test]
    fn previews_icons_and_heroicon_cases() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("o-user.svg"), "<svg stroke=\"currentColor\"/>").unwrap();
        let fx = Fixture::one("<?php\n$x->icon('heroicon-o-us<|>er');\n");
        fx.snap.framework.seed("icons:sets", json!({ "sets": [{ "name": "heroicons", "prefix": "heroicon", "paths": [dir.path()], "names": ["o-user"], "sure": true }] }));
        let at = fx.at();
        let hover = crate::features::with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| hover(ctx, ctx.offset(at.position))).flatten().unwrap();
        let HoverContents::Markup(m) = hover.contents else { panic!() };
        assert!(m.value.starts_with(&format!("![heroicon-o-user](data:image/svg+xml;base64,{}|width=48,height=48)", base64(b"<svg stroke=\"#8b8b8b\"/>"))), "{}", m.value);
        let case = heroicon_case(&fx.snap.framework, "Filament\\Support\\Icons\\Heroicon", "case OutlinedUser = 'o-user';").unwrap();
        assert!(case.ends_with("`heroicon-o-user`"));
        let mut item = CompletionItem { data: Some(json!({ "icon": "heroicon-o-user" })), ..Default::default() };
        assert!(resolve(&fx.snap.framework, &mut item) && item.documentation.is_some());
    }

    /// Reads every icon and color in a real app's `app/` and `resources/views/` and prints the problems reported,
    /// which should all be real: `TUSK_FILAMENT_APP=<root> cargo test -- --ignored --nocapture icons_and_colors`.
    #[test]
    #[ignore]
    fn icons_and_colors_in_a_real_app() {
        use crate::documents::{Document, Documents};
        use crate::index::{Index, IndexConfig};
        use crate::server::Snapshot;
        let Ok(root) = std::env::var("TUSK_FILAMENT_APP") else { return };
        let root = PathBuf::from(root);
        crate::testing::on_server_stack(|| {
            let mut index = Index::empty(IndexConfig::new(&root));
            let paths = index.discover();
            index.build(paths, |p| std::fs::read(p).ok(), |_, _| {});
            let index = Arc::new(parking_lot::RwLock::new(index));
            let framework = Arc::new(State::new(root.clone()));
            let mut files: Vec<PathBuf> = vec![];
            for dir in ["app", "resources/views"] {
                files.extend(ignore::WalkBuilder::new(root.join(dir)).build().flatten().map(|e| e.into_path()).filter(|p| p.extension().is_some_and(|e| e == "php")));
            }
            let started = std::time::Instant::now();
            let (mut icons, mut previewed, mut colors, mut problems) = (0, 0, 0, 0);
            for path in files {
                let text = std::fs::read_to_string(&path).unwrap();
                let blade = path.to_string_lossy().ends_with(".blade.php");
                let mut docs = Documents::default();
                docs.insert(Document::new(path_to_uri(&path), path.clone(), if blade { "blade" } else { "php" }.into(), 1, text.clone()));
                let snap = Snapshot { docs, index: index.clone(), root: root.clone(), framework: framework.clone(), client: None, cancel: Default::default() };
                let rel = path.strip_prefix(&root).unwrap().display().to_string();
                crate::features::with_ctx(&snap, &path_to_uri(&path), |ctx| {
                    let sets = sets(&ctx.snap.framework);
                    let found = if blade { blade_icons(&ctx.doc.text, &sets) } else { php_icons(ctx) };
                    for (start, _, value, sure) in found {
                        icons += 1;
                        if file(&sets, &value).is_some() {
                            previewed += 1;
                        } else {
                            eprintln!("no file {rel}:{} {value} (sure: {sure})", ctx.doc.position(start).line + 1);
                        }
                    }
                    colors += crate::framework::filament::colors::document_colors(ctx).len();
                    let mut found = diagnostics(ctx);
                    found.extend(crate::framework::filament::colors::diagnostics(ctx));
                    for d in found {
                        problems += 1;
                        eprintln!("problem {rel}:{} {}", d.range.start.line + 1, d.message);
                    }
                });
            }
            eprintln!("{icons} icons, {previewed} with a file, {colors} color swatches, {problems} problems, in {:?}", started.elapsed());
            // Without booting the app, the providers name the same sets.
            let read: Vec<String> = static_sets(&root).iter().map(|s| format!("{} {}", s["prefix"], s["paths"][0])).collect();
            eprintln!("from providers: {read:?}");
            let booted: Vec<String> = sets(&framework).iter().map(|s| format!("{} {} icons", s.prefix, s.names.len())).collect();
            eprintln!("from the app: {booted:?}");
        });
    }
}
