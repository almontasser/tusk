//! Hovers: a symbol's signature as declared, its docblock, and for variables the inferred type.

use lsp_types::{Hover, HoverContents, HoverParams, MarkupContent, MarkupKind};
use mago_codex::metadata::CodebaseMetadata;
use mago_span::Span;

use super::{Ctx, is_blade, with_blade_php, with_ctx};
use crate::server::Snapshot;
use crate::symbol::Symbol;
use crate::types::display;

pub fn hover(snap: &Snapshot, params: HoverParams) -> Result<Option<Hover>, String> {
    let at = params.text_document_position_params;
    let uri = &at.text_document.uri;
    let found = with_ctx(snap, uri, |ctx| {
        // A Blade view's names come first, then its PHP.
        if is_blade(&ctx.doc) {
            return crate::framework::hover(ctx, ctx.offset(at.position)).map(Some).ok_or(ctx.offset(at.position));
        }
        let Some(found) = ctx.symbol_at(at.position) else {
            return Ok(crate::framework::hover(ctx, ctx.offset(at.position)));
        };
        Ok(symbol_hover(ctx, &found))
    });
    Ok(match found {
        Some(Ok(hover)) => hover,
        Some(Err(offset)) => with_blade_php(snap, uri, offset, false, |ctx, blade| {
            if !blade.in_php(&ctx.doc, offset) {
                return None;
            }
            let found = ctx.resolver().at(blade.php_offset(offset))?;
            let hover = symbol_hover(ctx, &found)?;
            Some(Hover { range: blade.view_range(&ctx.doc, hover.range?), ..hover })
        })
        .flatten(),
        None => None,
    })
}

fn symbol_hover(ctx: &Ctx<'_>, found: &crate::symbol::Found) -> Option<Hover> {
    let parts: Vec<String> = found.symbols.iter().filter_map(|s| describe(ctx, s, found.start, found.end)).collect();
    if parts.is_empty() {
        return None;
    }
    Some(Hover {
        contents: HoverContents::Markup(MarkupContent { kind: MarkupKind::Markdown, value: parts.join("\n\n---\n\n") }),
        range: Some(ctx.doc.range(found.start, found.end)),
    })
}

fn code(text: &str) -> String {
    format!("```php\n<?php\n{text}\n```")
}

/// The source text of a declaration and the docblock above it.
pub struct Source {
    pub signature: String,
    pub docblock: Option<String>,
}

pub fn source(ctx: &Ctx<'_>, span: Span) -> Option<Source> {
    let text = ctx.snap.text_of(&ctx.index, span.file_id)?;
    let start = span.start.offset as usize;
    let end = (span.end.offset as usize).min(text.len());
    // The index can be ahead of or behind this text, so its span may not fit.
    Some(Source { signature: signature(text.get(start..end)?), docblock: docblock_before(&text, start) })
}

/// The declaration statement around a name, such as a property's modifiers, type, and default value.
fn statement_around(ctx: &Ctx<'_>, name: Span) -> Option<Source> {
    let text = ctx.snap.text_of(&ctx.index, name.file_id)?;
    let at = name.start.offset as usize;
    let start = text.get(..at)?.rfind([';', '{', '}', '(', ',', ']']).map_or(0, |i| i + 1);
    let start = match text[start..at].find("*/") {
        Some(i) => start + i + 2,
        None => start,
    };
    let start = start + (text[start..].len() - text[start..].trim_start().len());
    let rest = &text[start..];
    let end = end_of_item(rest);
    Some(Source { signature: signature(&rest[..end]), docblock: docblock_before(&text, start) })
}

/// Where a property or parameter ends: the first `;`, `,`, or `)` outside brackets and strings.
fn end_of_item(text: &str) -> usize {
    let mut depth = 0;
    let mut quote = None;
    let mut escaped = false;
    for (i, c) in text.char_indices() {
        if let Some(q) = quote {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            ';' | ',' | ')' | '{' if depth == 0 => return i,
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            _ => {}
        }
    }
    text.len()
}

/// A declaration up to its body: everything before the first `{` or `;` outside brackets, without
/// attributes, on one line.
pub fn signature(decl: &str) -> String {
    let mut depth = 0i32;
    let mut out = String::new();
    let mut chars = decl.char_indices().peekable();
    let mut in_string: Option<char> = None;
    while let Some((i, c)) = chars.next() {
        if let Some(q) = in_string {
            out.push(c);
            if c == '\\' {
                if let Some((_, n)) = chars.next() {
                    out.push(n);
                }
            } else if c == q {
                in_string = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => in_string = Some(c),
            '(' | '[' => depth += 1,
            ')' | ']' => depth -= 1,
            '{' | ';' if depth <= 0 => break,
            // An attribute: skip to its closing bracket.
            '#' if decl[i..].starts_with("#[") && depth == 0 => {
                let mut d = 0;
                for (_, c) in chars.by_ref() {
                    match c {
                        '[' => d += 1,
                        ']' => {
                            d -= 1;
                            if d == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                continue;
            }
            _ => {}
        }
        out.push(c);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ").replace("( ", "(").replace(" )", ")").replace(" ,", ",")
}

/// The docblock (`/** … */`) that ends just before `offset`, apart from whitespace and attributes.
pub fn docblock_before(text: &str, offset: usize) -> Option<String> {
    let before = text.get(..offset.min(text.len()))?.trim_end();
    let before = strip_trailing_attributes(before);
    let end = before.strip_suffix("*/")?;
    let start = end.rfind("/**")?;
    Some(end[start + 3..].to_string())
}

fn strip_trailing_attributes(mut s: &str) -> &str {
    while s.ends_with(']') {
        let Some(open) = s.rfind("#[") else { break };
        s = s[..open].trim_end();
    }
    s
}

/// A docblock as Markdown: its description, then its tags.
pub fn docblock_markdown(raw: &str) -> String {
    let lines: Vec<&str> = raw
        .lines()
        .map(|l| {
            let l = l.trim();
            let l = l.strip_prefix('*').unwrap_or(l);
            l.strip_prefix(' ').unwrap_or(l)
        })
        .collect();
    let mut description = vec![];
    let mut tags = vec![];
    for line in lines {
        if line.starts_with('@') {
            tags.push(line.to_string());
        } else if let Some(last) = tags.last_mut().filter(|_| !line.is_empty()) {
            // A tag's description continues on the lines after it.
            last.push(' ');
            last.push_str(line);
        } else if tags.is_empty() {
            description.push(line);
        }
    }
    let mut out = description.join("\n").trim().to_string();
    let tags: Vec<String> = tags
        .into_iter()
        .filter(|t| !t.starts_with("@deprecated"))
        .map(|t| {
            let (tag, rest) = t.split_once(' ').unwrap_or((&t, ""));
            format!("_{tag}_ `{}`", rest.trim()).replace(" ``", "")
        })
        .collect();
    if !tags.is_empty() {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&tags.join("  \n"));
    }
    out
}

/// A `@deprecated` tag's reason, or an empty string for a bare tag.
pub fn deprecation(raw: &str) -> Option<String> {
    let at = raw.find("@deprecated")?;
    let rest = &raw[at + "@deprecated".len()..];
    let line = rest.lines().next().unwrap_or("").trim().trim_end_matches("*/").trim();
    Some(line.to_string())
}

fn render(heading: Option<String>, signature: &str, docblock: Option<&str>) -> String {
    let mut out = String::new();
    if let Some(h) = heading {
        out.push_str(&format!("{h}\n\n"));
    }
    if let Some(why) = docblock.and_then(deprecation) {
        out.push_str(&if why.is_empty() { "**Deprecated**\n\n".to_string() } else { format!("**Deprecated**: {why}\n\n") });
    }
    out.push_str(&code(signature));
    if let Some(doc) = docblock.map(docblock_markdown).filter(|d| !d.is_empty()) {
        out.push_str(&format!("\n\n{doc}"));
    }
    out
}

pub(crate) fn describe(ctx: &Ctx<'_>, symbol: &Symbol, start: u32, end: u32) -> Option<String> {
    let codebase: &CodebaseMetadata = &ctx.index.codebase;
    let from_source = |span: Span, heading: Option<String>, fallback: String| -> String {
        match source(ctx, span) {
            Some(s) => render(heading, &s.signature, s.docblock.as_deref()),
            None => render(heading, &fallback, None),
        }
    };
    match symbol {
        Symbol::Class(name) => {
            let class = codebase.get_class_like(name.as_bytes())?;
            let fqn = class.original_name.as_str_lossy().into_owned();
            Some(from_source(class.span, Some(format!("`{fqn}`")), format!("class {fqn}")))
        }
        Symbol::Function(name) => {
            let f = codebase.get_function(name.as_bytes())?;
            let fqn = f.original_name.as_str_lossy().into_owned();
            Some(from_source(f.span, None, format!("function {fqn}(…)")))
        }
        Symbol::Constant(name) => {
            let c = codebase.get_constant(name.as_bytes())?;
            let value = c.inferred_type.as_ref().map(display).unwrap_or_default();
            Some(render(None, &format!("const {name} = {value}"), None))
        }
        Symbol::Method { class, name } => {
            let declaring = codebase.get_declaring_method_class(class.as_bytes(), name.as_bytes());
            let m = codebase.get_declaring_method(class.as_bytes(), name.as_bytes())?;
            let owner = declaring.map_or(class.clone(), |w| crate::types::display_class(&w.as_str_lossy(), codebase));
            let fallback = format!("function {}(…)", m.original_name.as_str_lossy());
            let mut out = from_source(m.span, Some(format!("`{owner}`")), fallback);
            // A generic method's return type as it applies here.
            if let Some(t) = ctx.analysis().type_at(start, end) {
                let declared = m.return_type_metadata.as_ref().map(|r| display(&r.type_union));
                let actual = display(&t);
                if declared.as_deref() != Some(actual.as_str()) && !t.is_never() {
                    out.push_str(&format!("\n\nReturns `{actual}` here."));
                }
            }
            Some(out)
        }
        Symbol::Property { class, name } => {
            let prop = format!("${name}");
            let owner = codebase
                .get_declaring_property_class(class.as_bytes(), prop.as_bytes())
                .map_or(class.clone(), |w| crate::types::display_class(&w.as_str_lossy(), codebase));
            let (p, magic) = match codebase.get_declaring_property(class.as_bytes(), prop.as_bytes()) {
                Some(p) => (p, false),
                None => match codebase.get_declaring_magic_property(class.as_bytes(), prop.as_bytes()) {
                    Some(p) => (p, true),
                    // Eloquent reads a relation method as a property: `$post->author` for `author()`.
                    None => return describe(ctx, &Symbol::Method { class: class.clone(), name: name.clone() }, start, end),
                },
            };
            let ty = p.type_metadata.as_ref().map(|t| display(&t.type_union)).unwrap_or_else(|| "mixed".into());
            let fallback = format!("{ty} {prop}");
            let heading = Some(format!("`{owner}`"));
            if magic {
                return Some(render(heading, &format!("@property {fallback}"), None));
            }
            match p.name_span.and_then(|span| statement_around(ctx, span)) {
                Some(s) => Some(render(heading, &s.signature, s.docblock.as_deref())),
                None => Some(render(heading, &fallback, None)),
            }
        }
        Symbol::ClassConstant { class, name } => {
            if let Some(case) = codebase.get_enum_case(class.as_bytes(), name.as_bytes()) {
                let mut out = from_source(case.span, Some(format!("`{class}`")), format!("case {name}"));
                // A case of Filament's `Heroicon` enum shows its icon.
                let declaration = ctx.snap.text_of(&ctx.index, case.span.file_id).and_then(|t| t.get(case.span.start.offset as usize..case.span.end.offset as usize).map(String::from));
                if let Some(preview) = declaration.and_then(|d| crate::framework::icons::heroicon_case(&ctx.snap.framework, class, &d)) {
                    out = format!("{preview}\n\n{out}");
                }
                return Some(out);
            }
            let c = codebase.get_class_constant(class.as_bytes(), name.as_bytes())?;
            let src = source(ctx, c.span);
            let sig = src.as_ref().map(|s| format!("const {}", s.signature)).unwrap_or_else(|| format!("const {name}"));
            let doc = src.and_then(|s| s.docblock);
            Some(render(Some(format!("`{class}`")), &sig, doc.as_deref()))
        }
        Symbol::Variable { name, .. } => {
            let t = ctx.analysis().type_at(start, end)?;
            // A Livewire view's `$this`, which its PHP reads as another variable.
            let name = if name == crate::framework::laravel::blade::THIS { "this" } else { name };
            Some(code(&format!("{} ${name}", display(&t))))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fixture;

    fn hover_text(files: &[(&str, &str)]) -> String {
        let fx = Fixture::new(files);
        let h = hover(&fx.snap, HoverParams { text_document_position_params: fx.at(), work_done_progress_params: Default::default() })
            .unwrap()
            .expect("a hover");
        let HoverContents::Markup(m) = h.contents else { panic!() };
        m.value
    }

    const LIB: &str = "<?php\nnamespace App;\n/**\n * A person who can sign in.\n */\n#[Attr]\nfinal class User\n{\n    /**\n     * Saves the user.\n     *\n     * @param array<string, mixed> $options Extra options\n     * @return bool Whether it worked\n     * @deprecated Use store()\n     */\n    public function save(array $options = ['a' => 1], ?string $why = null): bool { return true; }\n    /** @var list<string> */\n    public array $tags = [];\n}\n";

    #[test]
    fn shows_declared_signatures_and_docblocks() {
        let h = hover_text(&[("lib.php", LIB), ("t.php", "<?php function f(\\App\\User $u) { $u->sa<|>ve(); }")]);
        assert_eq!(
            h,
            "`App\\User`\n\n**Deprecated**: Use store()\n\n```php\n<?php\npublic function save(array $options = ['a' => 1], ?string $why = null): bool\n```\n\nSaves the user.\n\n_@param_ `array<string, mixed> $options Extra options`  \n_@return_ `bool Whether it worked`"
        );
        let h = hover_text(&[("lib.php", LIB), ("t.php", "<?php new \\App\\Us<|>er;")]);
        assert_eq!(h, "`App\\User`\n\n```php\n<?php\nfinal class User\n```\n\nA person who can sign in.");
        let h = hover_text(&[("lib.php", LIB), ("t.php", "<?php function f(\\App\\User $u) { $u->ta<|>gs; }")]);
        assert_eq!(h, "`App\\User`\n\n```php\n<?php\npublic array $tags = []\n```\n\n_@var_ `list<string>`");
    }

    #[test]
    fn shows_built_in_functions_from_phps_stubs() {
        let h = hover_text(&[("t.php", "<?php str_con<|>tains('a', 'b');")]);
        assert!(h.contains("function str_contains(string $haystack, string $needle): bool"), "{h}");
    }

    #[test]
    fn shows_the_default_guards_methods_on_auth() {
        let h = hover_text(&[crate::testing::LARAVEL_AUTH, ("app/f.php", "<?php\nauth()->us<|>er();\n")]);
        assert!(h.starts_with("`Illuminate\\Contracts\\Auth\\Guard`") && h.contains("public function user()"), "{h}");
    }

    #[test]
    fn shows_inferred_variable_types() {
        let h = hover_text(&[("t.php", "<?php function f() { $x = [1, 2]; return $<|>x; }")]);
        assert!(h.starts_with("```php\n<?php\nlist{"), "{h}");
    }
}
