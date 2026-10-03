//! Filament's colors: the names `->color()` and its kin take, with a swatch of each.
//!
//! ```php
//! ->color('danger')                                  // completes, shows a swatch, and checks the name
//! ->color(fn (string $state) => match ($state) { 'paid' => 'success', default => 'gray' })
//! ->colors(['primary' => Color::Amber])              // a swatch for the palette's shade 500
//! ```
//! ```blade
//! <x-filament::badge color="success">
//! ```
//!
//! The names are Filament's defaults, read from its `ColorManager`, and those the booted app registers
//! (`filament-colors.php`): each panel's `->colors()` and `FilamentColor::register()`. A swatch is the color's
//! shade 500: from Filament's `Color` class for its palettes, as `oklch()` in Filament 4 and 5 and `r, g, b` in
//! Filament 3, or from the booted app for the registered ones.

use std::collections::HashMap;
use std::sync::Arc;

use lsp_types::{
    Color, ColorInformation, CompletionItem, CompletionItemKind, CompletionTextEdit, Diagnostic, DiagnosticSeverity, Documentation, Hover,
    HoverContents, MarkupContent, MarkupKind, NumberOrString, TextEdit,
};
use mago_span::HasSpan;
use mago_syntax::cst::{ClassLikeConstantSelector, Node};
use serde_json::{Value, json};

use crate::features::{Ctx, is_blade};
use crate::framework::icons::{Owner, array_entry, owner, svg_image};
use crate::framework::values::{Site, Target, blade_tags, site_at, sites};
use crate::framework::{CallKind, State};
use crate::locate::walk;

const SCRIPT: &str = include_str!("../../../php/laravel/filament-colors.php");

/// What can change the registered colors: panel and other providers, config, and packages.
const DEPENDS_ON: &[&str] = &["app/Providers/", "config/", "bootstrap/providers.php", "composer.lock"];

const COLOR_CLASS: &str = "Filament\\Support\\Colors\\Color";

/// Filament's palettes and default colors, read from its source: `{palettes: {Amber: shade 500}, defaults:
/// {danger: Red}}`.
fn palettes(state: &State) -> Arc<Value> {
    let root = state.root().to_path_buf();
    state.remember("filament:palettes", &["composer.lock"], || {
        let colors = root.join("vendor/filament/support/src/Colors");
        let read = |f: &str| std::fs::read_to_string(colors.join(f)).unwrap_or_default();
        let mut palettes = serde_json::Map::new();
        let source = read("Color.php");
        for part in source.split("const ").skip(1) {
            let name: String = part.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            let Some(body) = part[name.len()..].trim_start().strip_prefix('=').map(str::trim_start).filter(|b| b.starts_with('[')) else { continue };
            let body = &body[..body.find("];").unwrap_or(body.len())];
            let Some(shade) = body.split("500 =>").nth(1).and_then(|r| r.trim_start().strip_prefix('\'')).and_then(|r| r.split('\'').next()) else { continue };
            palettes.insert(name, json!(shade));
        }
        let mut defaults = serde_json::Map::new();
        let manager = read("ColorManager.php");
        if let Some(block) = manager.split("DEFAULT_COLORS = [").nth(1).and_then(|b| b.split("];").next()) {
            for line in block.lines() {
                let Some((name, palette)) = line.split_once("=>") else { continue };
                let name = name.trim().trim_matches(|c| c == '\'' || c == '"');
                let palette = palette.trim().trim_end_matches(',').trim_start_matches("Color::");
                defaults.insert(name.to_string(), json!(palette));
            }
        }
        json!({ "palettes": palettes, "defaults": defaults })
    })
}

/// The colors Filament knows by name, each with its shade 500 if known, and whether the list is complete: read
/// from the booted app, with no panel's colors left unread.
pub struct Names {
    pub colors: Vec<(String, Option<String>)>,
    pub complete: bool,
}

fn names(state: &State) -> Names {
    let palettes = palettes(state);
    let booted = crate::framework::laravel::script(state, "filament-colors", SCRIPT, DEPENDS_ON);
    if let Some(booted) = booted.as_ref().filter(|b| b["colors"].is_object()) {
        let colors = booted["colors"].as_object().into_iter().flatten().map(|(k, v)| (k.clone(), v.as_str().map(String::from))).collect();
        return Names { colors, complete: booted["unsure"] != true };
    }
    let colors = palettes["defaults"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(name, palette)| (name.clone(), palette.as_str().and_then(|p| palettes["palettes"][p].as_str()).map(String::from)))
        .collect();
    Names { colors, complete: false }
}

/// Names the project may know colors by where the booted app doesn't see them: strings in its files that call
/// `FilamentColor::register()`, as in a `Filament::serving()` callback, and the `fi-color-*` classes its own CSS
/// styles. A name among them isn't reported.
fn mentioned(ctx: &Ctx<'_>) -> Arc<Value> {
    let root = ctx.snap.framework.root().to_path_buf();
    let app = root.join("app");
    let files: Vec<std::path::PathBuf> = ctx.index.files.values().map(|f| f.path.clone()).filter(|p| p.starts_with(&app)).collect();
    ctx.snap.framework.remember("filament:color-mentions", &["app/", "resources/"], || {
        let mut out: Vec<String> = vec![];
        for path in files {
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            if !text.contains("FilamentColor::register") {
                continue;
            }
            for (i, part) in text.split(['\'', '"']).enumerate() {
                if i % 2 == 1 && part.len() < 40 {
                    out.push(part.to_string());
                }
            }
        }
        let css = ignore::WalkBuilder::new(root.join("resources")).build().flatten().filter(|e| e.path().extension().is_some_and(|x| x == "css"));
        for entry in css {
            let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
            for (at, _) in text.match_indices("fi-color-") {
                let name: String = text[at + 9..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
                out.push(name);
            }
        }
        json!(out)
    })
}

/// A CSS color as Filament writes one, to red, green, and blue from 0 to 1: `oklch(0.637 0.237 25.331)`,
/// Filament 3's `239, 68, 68`, `rgb(…)`, or `#rrggbb`.
pub fn rgb(value: &str) -> Option<[f32; 3]> {
    let value = value.trim();
    let numbers = |s: &str| -> Option<Vec<f32>> {
        s.split([' ', ',', '/']).filter(|p| !p.is_empty()).map(|p| p.trim_end_matches('%').parse::<f32>().ok()).collect()
    };
    if let Some(hex) = value.strip_prefix('#') {
        let hex: String = if hex.len() == 3 { hex.chars().flat_map(|c| [c, c]).collect() } else { hex.to_string() };
        if hex.len() != 6 && hex.len() != 8 {
            return None;
        }
        let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok().map(|b| b as f32 / 255.0);
        return Some([byte(0)?, byte(2)?, byte(4)?]);
    }
    if let Some(inner) = value.strip_prefix("oklch(").and_then(|v| v.strip_suffix(')')) {
        let n = numbers(inner)?;
        let (mut l, c, h) = (*n.first()?, *n.get(1)?, n.get(2).copied().unwrap_or(0.0));
        if inner.split_whitespace().next()?.ends_with('%') || l > 1.0 {
            l /= 100.0;
        }
        let (a, b) = (c * h.to_radians().cos(), c * h.to_radians().sin());
        let l_ = (l + 0.396_337_78 * a + 0.215_803_76 * b).powi(3);
        let m_ = (l - 0.105_561_346 * a - 0.063_854_17 * b).powi(3);
        let s_ = (l - 0.089_484_18 * a - 1.291_485_5 * b).powi(3);
        let linear = [
            4.076_741_7 * l_ - 3.307_711_6 * m_ + 0.230_969_94 * s_,
            -1.268_438 * l_ + 2.609_757_4 * m_ - 0.341_319_38 * s_,
            -0.004_196_086_3 * l_ - 0.703_418_6 * m_ + 1.707_614_7 * s_,
        ];
        let gamma = |x: f32| {
            let x = x.clamp(0.0, 1.0);
            if x <= 0.003_130_8 { 12.92 * x } else { 1.055 * x.powf(1.0 / 2.4) - 0.055 }
        };
        return Some(linear.map(gamma));
    }
    let inner = value.strip_prefix("rgb(").or_else(|| value.strip_prefix("rgba(")).and_then(|v| v.strip_suffix(')')).unwrap_or(value);
    let n = numbers(inner)?;
    (n.len() >= 3 && n[..3].iter().all(|c| (0.0..=255.0).contains(c))).then(|| [n[0] / 255.0, n[1] / 255.0, n[2] / 255.0])
}

fn hex(rgb: [f32; 3]) -> String {
    let [r, g, b] = rgb.map(|c| (c * 255.0).round() as u8);
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// A swatch of a color, as a Markdown image.
fn swatch(rgb: [f32; 3], alt: &str) -> String {
    svg_image(&format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\"><rect width=\"16\" height=\"16\" rx=\"3\" fill=\"{}\"/></svg>", hex(rgb)), alt, 16)
}

/// Whether a method takes a color as its first argument, as Filament names them: `color()`, `iconColor()`.
/// `hexColor()` takes a flag, the image editor's fill color is CSS, and test assertions take a name first.
fn color_method(name: &str) -> bool {
    (name == "color" || name.ends_with("Color")) && !matches!(name, "hexColor" | "imageEditorEmptyFillColor") && !name.starts_with("assert")
}

fn color_call(name: &str) -> bool {
    color_method(name) || name == "colors"
}

/// Whether a site takes a color name: `Some(true)` when surely, `Some(false)` when it may, for an untyped receiver.
fn color_site(site: &Site, codebase: &mago_codex::metadata::CodebaseMetadata) -> Option<bool> {
    match &site.target {
        Target::Property(_) => None,
        Target::Return { class, method } => {
            (method == "getColor" && codebase.is_instance_of(class.as_bytes(), b"Filament\\Support\\Contracts\\HasColor")).then_some(true)
        }
        Target::Arg { call, index, name, in_array, closure } => {
            if !matches!(call.kind, CallKind::Method | CallKind::Static) {
                return None;
            }
            let typed = !call.classes.is_empty();
            let filament = |c: &String| c.starts_with("Filament\\") || codebase.is_instance_of(c.as_bytes(), b"Filament\\Support\\Components\\Component");
            if typed && !call.classes.iter().any(filament) {
                return None;
            }
            if call.name == "colors" {
                let entry = in_array.as_ref().filter(|_| *index == 0 && !closure)?;
                let owner = owner(&call.classes, codebase);
                // A panel's keys register colors rather than use them.
                if owner == Owner::Panel {
                    return None;
                }
                return match array_entry(owner, entry) {
                    Some(true) => Some(typed),
                    Some(false) => None,
                    None => Some(false),
                };
            }
            let first = *index == 0 || name.as_deref() == Some("color");
            (color_method(&call.name) && first && in_array.is_none()).then_some(typed)
        }
    }
}

/// A color name written somewhere it's surely or possibly one: `(start, end, value, sure)`.
type Written = (u32, u32, String, bool);

/// The `color` and `*-color` attributes of Filament's Blade components.
fn blade_colors(text: &str) -> Vec<Written> {
    blade_tags(text)
        .into_iter()
        .filter(|t| t.name.starts_with("x-filament::") || t.name.starts_with("x-filament."))
        .flat_map(|t| t.attributes)
        .filter(|a| (a.name == "color" || a.name.ends_with("-color")) && !a.value.contains("{{"))
        .map(|a| (a.start, a.end, a.value, true))
        .collect()
}

fn written(ctx: &Ctx<'_>) -> Vec<Written> {
    if is_blade(&ctx.doc) {
        return blade_colors(&ctx.doc.text);
    }
    let codebase = &ctx.index.codebase;
    sites(ctx, &color_call).into_iter().filter_map(|s| color_site(&s, codebase).map(|sure| (s.start, s.end, s.value, sure))).collect()
}

fn written_at(ctx: &Ctx<'_>, offset: u32) -> Option<Written> {
    if is_blade(&ctx.doc) {
        return blade_colors(&ctx.doc.text).into_iter().find(|(s, e, ..)| *s <= offset && offset <= *e);
    }
    let site = site_at(ctx, offset, &color_call)?;
    let sure = color_site(&site, &ctx.index.codebase)?;
    Some((site.start, site.end, site.value, sure))
}

fn looks_like_name(value: &str) -> bool {
    value.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn completion(ctx: &Ctx<'_>, offset: u32) -> Option<Vec<CompletionItem>> {
    if !super::active(ctx) {
        return None;
    }
    let (start, ..) = written_at(ctx, offset)?;
    let range = ctx.doc.range(start, offset);
    let names = names(&ctx.snap.framework);
    Some(
        names
            .colors
            .iter()
            .map(|(name, value)| {
                // Monaco draws a color item's swatch from documentation that starts with the color.
                let documentation = value.as_deref().and_then(rgb).map(|c| {
                    Documentation::MarkupContent(MarkupContent { kind: MarkupKind::Markdown, value: format!("{}\n\n`{}`", hex(c), value.as_deref().unwrap_or_default()) })
                });
                CompletionItem {
                    label: name.clone(),
                    kind: Some(CompletionItemKind::COLOR),
                    detail: Some("Filament color".into()),
                    documentation,
                    text_edit: Some(CompletionTextEdit::Edit(TextEdit { range, new_text: name.clone() })),
                    ..Default::default()
                }
            })
            .collect(),
    )
}

pub fn hover(ctx: &Ctx<'_>, offset: u32) -> Option<Hover> {
    if !super::active(ctx) {
        return None;
    }
    let (start, end, value, _) = written_at(ctx, offset)?;
    let names = names(&ctx.snap.framework);
    let shade = names.colors.iter().find(|(n, _)| *n == value)?.1.clone()?;
    let color = rgb(&shade)?;
    Some(Hover {
        contents: HoverContents::Markup(MarkupContent { kind: MarkupKind::Markdown, value: format!("{} `{value}` · `{shade}`", swatch(color, &value)) }),
        range: Some(ctx.doc.range(start, end)),
    })
}

/// Swatches for color names and for `Color::Amber`, its shade 500.
pub fn document_colors(ctx: &Ctx<'_>) -> Vec<ColorInformation> {
    if !super::active(ctx) {
        return vec![];
    }
    let info = |start: u32, end: u32, [red, green, blue]: [f32; 3]| ColorInformation { range: ctx.doc.range(start, end), color: Color { red, green, blue, alpha: 1.0 } };
    let found = written(ctx);
    let mut out = vec![];
    if !found.is_empty() {
        let names: HashMap<String, Option<String>> = names(&ctx.snap.framework).colors.into_iter().collect();
        for (start, end, value, _) in found {
            if let Some(color) = names.get(&value).cloned().flatten().as_deref().and_then(rgb) {
                out.push(info(start, end, color));
            }
        }
    }
    if is_blade(&ctx.doc) || !ctx.doc.text.contains("Color::") {
        return out;
    }
    let palettes = palettes(&ctx.snap.framework);
    walk(&ctx.parsed, |node, ancestors| {
        let Node::ClassConstantAccess(access) = node else { return };
        let ClassLikeConstantSelector::Identifier(id) = &access.constant else { return };
        let Some(shade) = palettes["palettes"][&*String::from_utf8_lossy(id.value)].as_str() else { return };
        let class = ctx.resolver().classes_of_class_expr(access.class, ancestors);
        if class.iter().any(|c| c.eq_ignore_ascii_case(COLOR_CLASS))
            && let Some(color) = rgb(shade)
        {
            let span = access.span();
            out.push(info(span.start.offset, span.end.offset, color));
        }
    });
    out
}

/// Color names Filament doesn't know, where the name surely is a color and the app's colors were all read.
pub fn diagnostics(ctx: &Ctx<'_>) -> Vec<Diagnostic> {
    if !super::active(ctx) {
        return vec![];
    }
    let found: Vec<Written> = written(ctx).into_iter().filter(|(_, _, value, sure)| *sure && looks_like_name(value)).collect();
    if found.is_empty() {
        return vec![];
    }
    let names = names(&ctx.snap.framework);
    if !names.complete {
        return vec![];
    }
    let mentioned = mentioned(ctx);
    let mentioned: Vec<&str> = mentioned.as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    found
        .into_iter()
        .filter(|(_, _, value, _)| !names.colors.iter().any(|(n, _)| n == value) && !mentioned.contains(&value.as_str()))
        .map(|(start, end, value, _)| Diagnostic {
            range: ctx.doc.range(start, end),
            severity: Some(DiagnosticSeverity::WARNING),
            code: Some(NumberOrString::String("color".into())),
            source: Some("filament".into()),
            message: format!("Filament has no color named {value}. Register it with ->colors() on the panel or FilamentColor::register()."),
            ..Default::default()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fixture;

    #[test]
    fn converts_filament_colors_to_rgb() {
        // Tailwind's red-500 in oklch, as Filament 4 writes it, and as Filament 3 does.
        assert_eq!(hex(rgb("oklch(0.637 0.237 25.331)").unwrap()), "#fb2c36");
        assert_eq!(hex(rgb("239, 68, 68").unwrap()), "#ef4444");
        assert_eq!(hex(rgb("rgb(239 68 68)").unwrap()), "#ef4444");
        assert_eq!(hex(rgb("#f00").unwrap()), "#ff0000");
        assert_eq!(hex(rgb("oklch(0.985 0 0)").unwrap()), "#fafafa");
        assert!(rgb("danger").is_none());
    }

    const FILAMENT: &str = "<?php\nnamespace Filament\\Support\\Components { class Component {} }\nnamespace Filament\\Support\\Colors { class Color { const Red = [500 => 'oklch(0.637 0.237 25.331)']; } }\nnamespace Filament\\Tables\\Columns { class Column extends \\Filament\\Support\\Components\\Component {\n    public static function make(string $name): static { return new static; }\n    public function color($c): static { return $this; }\n    public function colors($c): static { return $this; }\n    public function label($c): static { return $this; }\n} class TextColumn extends Column {} }\nnamespace Filament { class Panel { public function colors($c): static { return $this; } } }\nnamespace Filament\\Support\\Contracts { interface HasColor { public function getColor(): ?string; } }\n";

    fn fixture(files: &[(&str, &str)], unsure: bool) -> Fixture {
        let fx = Fixture::new(files);
        let state = &fx.snap.framework;
        state.seed("filament:active", json!(true));
        state.seed("laravel:active", json!(true));
        state.seed("laravel:filament-colors", json!({ "colors": { "danger": "oklch(0.637 0.237 25.331)", "brand": "#123456", "gray": null }, "unsure": unsure }));
        state.seed("filament:palettes", json!({ "palettes": { "Red": "oklch(0.637 0.237 25.331)" }, "defaults": { "danger": "Red" } }));
        state.seed("filament:color-mentions", json!(["serving"]));
        fx
    }

    fn problems(body: &str, unsure: bool) -> Vec<String> {
        let fx = fixture(&[("vendor/filament.php", FILAMENT), ("app/t.php", &format!("<?php\nuse Filament\\Tables\\Columns\\TextColumn;\n{body}\n"))], unsure);
        crate::features::with_ctx(&fx.snap, &crate::testing::uri("app/t.php"), diagnostics).unwrap().into_iter().map(|d| d.message.split('.').next().unwrap().to_string()).collect()
    }

    #[test]
    fn reports_unknown_colors_only_when_sure() {
        let body = "TextColumn::make('a')->color('danger')->color('dangr')->color(fn ($s) => match ($s) { 'paid' => 'brand', default => 'nope' })->color('#ff0000')->color('serving')->label('x');\nTextColumn::make('a')->colors(['wrong' => 'draft', 'danger' => fn () => true]);\n(new \\Filament\\Panel)->colors(['custom' => '#fff']);\n$untyped->color('maybe');\nenum S: string implements \\Filament\\Support\\Contracts\\HasColor { case A = 'a'; public function getColor(): ?string { return 'bad'; } }";
        assert_eq!(
            problems(body, false),
            vec!["Filament has no color named dangr", "Filament has no color named nope", "Filament has no color named wrong", "Filament has no color named bad"]
        );
        assert!(problems(body, true).is_empty());
    }

    #[test]
    fn completes_colors_with_swatches_and_shows_them() {
        let fx = fixture(&[("vendor/filament.php", FILAMENT), ("app/t.php", "<?php\nuse Filament\\Tables\\Columns\\TextColumn;\nuse Filament\\Support\\Colors\\Color;\nTextColumn::make('a')->color('<|>')->color('danger')->colors([Color::Red]);\n")], false);
        let at = fx.at();
        let items = crate::features::with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| completion(ctx, ctx.offset(at.position))).flatten().unwrap();
        let labels: Vec<_> = items.iter().map(|i| i.label.as_str()).collect();
        assert_eq!(labels, vec!["danger", "brand", "gray"]);
        let Some(Documentation::MarkupContent(doc)) = &items[0].documentation else { panic!() };
        assert!(doc.value.starts_with("#fb2c36"));
        let colors = crate::features::with_ctx(&fx.snap, &crate::testing::uri("app/t.php"), document_colors).unwrap();
        let spans: Vec<String> = colors.iter().map(|c| format!("{}:{} {}", c.range.start.line, c.range.start.character, hex([c.color.red, c.color.green, c.color.blue]))).collect();
        assert_eq!(spans, vec!["3:41 #fb2c36", "3:59 #fb2c36"]);
    }

    #[test]
    fn reads_blade_component_colors() {
        let fx = fixture(&[("v.blade.php", "<x-filament::badge color=\"danger\">A</x-filament::badge>\n<x-filament::button color=\"dangr\" icon-color=\"brand\" />\n<x-badge color=\"whatever\" />\n")], false);
        let uri = crate::testing::uri("v.blade.php");
        let found: Vec<String> = crate::features::with_ctx(&fx.snap, &uri, diagnostics).unwrap().into_iter().map(|d| d.message.split('.').next().unwrap().to_string()).collect();
        assert_eq!(found, vec!["Filament has no color named dangr"]);
        assert_eq!(crate::features::with_ctx(&fx.snap, &uri, document_colors).unwrap().len(), 2);
    }

    /// Reads Filament's palettes from a real app's vendor: `TUSK_FILAMENT_APP=<root> cargo test -- --ignored palettes`.
    #[test]
    #[ignore]
    fn reads_palettes_from_a_real_app() {
        let Ok(root) = std::env::var("TUSK_FILAMENT_APP") else { return };
        let state = State::new(root.into());
        let p = palettes(&state);
        assert_eq!(p["defaults"]["danger"], "Red");
        assert!(rgb(p["palettes"]["Amber"].as_str().unwrap()).is_some());
    }
}
