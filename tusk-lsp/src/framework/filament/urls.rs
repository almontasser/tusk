//! Resource page names in `PostResource::getUrl('edit', ['record' => $post])`, and in a page's
//! `static::getResource()::getUrl('index')`: completion, hover, and go to definition from the resource's
//! `getPages()`, and problems with a name it doesn't register, for which Filament has no route.

use lsp_types::{CompletionItem, CompletionItemKind, Diagnostic, DiagnosticSeverity, Hover, HoverContents, Location, MarkupContent, MarkupKind, NumberOrString};

use super::closures::{ClassFacts, Page, class_facts, resource_by_folder};
use super::{CallKind, StringArg, is_resource_in, item, short, string_arg_at, string_args};
use crate::features::Ctx;
use mago_span::HasSpan;
use crate::locate::declaration;
use crate::symbol::Symbol;

/// The resource a `getUrl()` page name is for, if the string is one.
fn resource_of_arg(ctx: &Ctx<'_>, arg: &StringArg) -> Option<String> {
    let page_name = (arg.index == 0 && arg.name.is_none()) || arg.name.as_deref() == Some("name");
    if arg.call.kind != CallKind::Static || arg.call.name != "getUrl" || !page_name || arg.in_array.is_some() {
        return None;
    }
    let resource = |c: &String| is_resource_in(&ctx.index, c) && !ctx.index.codebase.get_class_like(c.as_bytes()).is_some_and(|m| m.flags.is_abstract());
    if let Some(class) = arg.call.classes.iter().find(|c| resource(c)) {
        return Some(class.clone());
    }
    // `static::getResource()::getUrl()` in a page: the page's own `$resource`, or the resource of its folder.
    let receiver = ctx.doc.text.get(arg.call.span.0 as usize..arg.start as usize)?;
    if !receiver.contains("getResource()::") {
        return None;
    }
    let page = ctx.parsed.path_at(arg.start).iter().rev().find_map(|n| match n {
        mago_syntax::cst::Node::Class(c) => {
            let name = String::from_utf8_lossy(c.name.value);
            Some(crate::scope::resolve_class(&crate::scope::scope_at(ctx.parsed.program, c.span().start.offset), &name).trim_start_matches('\\').to_string())
        }
        _ => None,
    });
    let own = page.and_then(|p| class_facts(&ctx.index, &ctx.snap.docs, &p)).and_then(|f| f.classes.get("resource").cloned());
    own.or_else(|| resource_by_folder(&ctx.index, &ctx.doc.path)).filter(resource)
}

/// The pages a resource registers, if its `getPages()` returns a literal array, its own or a parent's in the app.
fn pages(ctx: &Ctx<'_>, resource: &str) -> Option<Vec<Page>> {
    let declaring = ctx.index.codebase.get_declaring_method_class(resource.as_bytes(), b"getPages")?;
    let class = ctx.index.codebase.get_class_like(declaring.as_bytes())?;
    if !ctx.index.is_project_file(class.span.file_id) {
        return None;
    }
    let facts: ClassFacts = class_facts(&ctx.index, &ctx.snap.docs, &class.original_name.as_str_lossy())?;
    facts.pages
}

pub fn completion(ctx: &Ctx<'_>, offset: u32, arg: &StringArg) -> Option<Vec<CompletionItem>> {
    let resource = resource_of_arg(ctx, arg)?;
    let range = ctx.doc.range(arg.start, offset.max(arg.start));
    Some(
        pages(ctx, &resource)?
            .into_iter()
            .map(|p| item(&p.name, CompletionItemKind::VALUE, p.class.as_deref().map_or("page", short), range, None))
            .collect(),
    )
}

fn page_at(ctx: &Ctx<'_>, offset: u32) -> Option<(StringArg, String, Page)> {
    let arg = string_arg_at(ctx, offset)?;
    let resource = resource_of_arg(ctx, &arg)?;
    let page = pages(ctx, &resource)?.into_iter().find(|p| p.name == arg.value)?;
    Some((arg, resource, page))
}

/// Goes from a page name to its page class.
pub fn definition(ctx: &Ctx<'_>, offset: u32) -> Vec<Location> {
    let Some((_, _, page)) = page_at(ctx, offset) else { return vec![] };
    let Some(class) = page.class else { return vec![] };
    declaration(&Symbol::Class(class), &ctx.index.codebase).and_then(|place| ctx.snap.location(&ctx.index, place)).into_iter().collect()
}

pub fn hover(ctx: &Ctx<'_>, offset: u32) -> Option<Hover> {
    let (arg, resource, page) = page_at(ctx, offset)?;
    let class = page.class.as_deref().map_or_else(String::new, |c| format!(": `{}`", short(c)));
    Some(Hover {
        contents: HoverContents::Markup(MarkupContent { kind: MarkupKind::Markdown, value: format!("Page `{}` of `{}`{class}", page.name, short(&resource)) }),
        range: Some(ctx.doc.range(arg.start, arg.end)),
    })
}

/// Page names a resource whose `getPages()` returns a literal array doesn't register.
pub fn diagnostics(ctx: &Ctx<'_>) -> Vec<Diagnostic> {
    if !ctx.doc.text.contains("getUrl(") {
        return vec![];
    }
    let mut out = vec![];
    for arg in string_args(ctx) {
        let Some(resource) = resource_of_arg(ctx, &arg) else { continue };
        let Some(pages) = pages(ctx, &resource) else { continue };
        if pages.iter().any(|p| p.name == arg.value) {
            continue;
        }
        let names: Vec<String> = pages.iter().map(|p| format!("`{}`", p.name)).collect();
        out.push(Diagnostic {
            range: ctx.doc.range(arg.start, arg.end),
            severity: Some(DiagnosticSeverity::WARNING),
            code: Some(NumberOrString::String("filament-resource-page".into())),
            source: Some("filament".into()),
            message: format!("{} has no page `{}`: its getPages() registers {}.", short(&resource), arg.value, names.join(", ")),
            ..Default::default()
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::{with_ctx, with_ctx_at};
    use crate::testing::{Fixture, uri};

    const FILAMENT: &str = "<?php\nnamespace Filament\\Resources {\n    abstract class Resource {\n        public static function getUrl(?string $name = null, array $parameters = []): string { return ''; }\n        public static function getPages(): array { return []; }\n    }\n}\nnamespace Filament\\Resources\\Pages {\n    abstract class Page {\n        protected static string $resource;\n        /** @return class-string<\\Filament\\Resources\\Resource> */\n        public static function getResource(): string { return static::$resource; }\n        public static function route(string $path): array { return []; }\n    }\n}\n";
    const RESOURCE: &str = "<?php\nnamespace App\\Filament\\Resources\\Posts;\nuse Filament\\Resources\\Resource;\nclass PostResource extends Resource\n{\n    public static function getPages(): array\n    {\n        return ['index' => Pages\\ListPosts::route('/'), 'edit' => Pages\\EditPost::route('/{record}/edit')];\n    }\n}\n";
    const LIST: &str = "<?php\nnamespace App\\Filament\\Resources\\Posts\\Pages;\nclass ListPosts extends \\Filament\\Resources\\Pages\\Page { protected static string $resource = \\App\\Filament\\Resources\\Posts\\PostResource::class; }\n";

    fn fixture(code: &str) -> Fixture {
        let edit = format!("<?php\nnamespace App\\Filament\\Resources\\Posts\\Pages;\nuse App\\Filament\\Resources\\Posts\\PostResource;\nclass EditPost extends \\Filament\\Resources\\Pages\\Page\n{{\n    protected static string $resource = PostResource::class;\n    public function go(): string\n    {{\n        return {code};\n    }}\n}}\n");
        let fx = Fixture::new(&[
            ("vendor/filament.php", FILAMENT),
            ("app/Filament/Resources/Posts/PostResource.php", RESOURCE),
            ("app/Filament/Resources/Posts/Pages/ListPosts.php", LIST),
            ("app/Filament/Resources/Posts/Pages/EditPost.php", &edit),
        ]);
        fx.snap.framework.seed("filament:active", serde_json::Value::Bool(true));
        fx
    }

    const EDIT: &str = "app/Filament/Resources/Posts/Pages/EditPost.php";

    #[test]
    fn completes_and_goes_to_resource_pages() {
        for code in ["PostResource::getUrl('<|>')", "static::getResource()::getUrl('<|>', ['record' => 1])", "PostResource::getUrl(name: '<|>')"] {
            let fx = fixture(code);
            let at = fx.at();
            let items = with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| super::super::completion(ctx, ctx.offset(at.position))).flatten().unwrap_or_default();
            let labels: Vec<(String, String)> = items.into_iter().map(|i| (i.label, i.detail.unwrap_or_default())).collect();
            assert_eq!(labels, vec![("index".into(), "ListPosts".into()), ("edit".into(), "EditPost".into())], "{code}");
        }
        let fx = fixture("PostResource::getUrl('ed<|>it')");
        let at = fx.at();
        let found = with_ctx(&fx.snap, &at.text_document.uri, |ctx| super::super::definition(ctx, ctx.offset(at.position))).unwrap();
        assert_eq!(found[0].uri, uri(EDIT));
        assert_eq!(found[0].range.start.line, 3);
        let shown = with_ctx(&fx.snap, &at.text_document.uri, |ctx| hover(ctx, ctx.offset(at.position))).flatten().unwrap();
        let HoverContents::Markup(m) = shown.contents else { panic!() };
        assert_eq!(m.value, "Page `edit` of `PostResource`: `EditPost`");
    }

    #[test]
    fn reports_pages_a_resource_doesnt_register() {
        let problems = |code: &str| -> Vec<String> {
            let fx = fixture(code);
            with_ctx(&fx.snap, &uri(EDIT), diagnostics).unwrap().into_iter().map(|d| d.message).collect()
        };
        assert_eq!(problems("PostResource::getUrl('view')"), vec!["PostResource has no page `view`: its getPages() registers `index`, `edit`."]);
        assert_eq!(problems("static::getResource()::getUrl('show')").len(), 1);
        assert!(problems("PostResource::getUrl('edit') . PostResource::getUrl() . PostResource::getUrl($name)").is_empty());
    }
}
