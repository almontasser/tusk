use serde_json::json;

use super::*;
use crate::features::{with_ctx, with_ctx_at};
use crate::testing::{Fixture, uri};
use lsp_types::{DocumentChangeOperation, DocumentChanges, OneOf, ResourceOp};

/// Enough of Laravel's classes and helpers for the analyzer to type the calls.
const STUBS: &str = r#"<?php
namespace Illuminate\Routing { class Redirector { public function route($name, $parameters = []) {} } class Router {} class UrlGenerator {} }
namespace Illuminate\Http { class Request { public function routeIs(...$patterns) {} public function validate(array $rules) {} } }
namespace Illuminate\Support\Facades { class Route {} class Config {} class Lang {} class View {} class Gate {} class Storage {} class App {} class Vite {} }
namespace Illuminate\Foundation\Http { class FormRequest {} }
namespace Illuminate\Contracts\View { interface Factory { public function make($view, $data = []); public function exists($view); } interface View {} }
namespace Illuminate\Database\Eloquent {
    abstract class Model {
        /** @return \Illuminate\Database\Eloquent\Builder<static> */
        public static function query() {}
    }
    /** @template TModel of Model */
    class Builder {
        /** @return $this */
        public function where($column, $operator = null, $value = null) {}
        /** @return $this */
        public function orderBy($column) {}
        /** @return $this */
        public function whereHas($relation, ?\Closure $callback = null) {}
    }
}
namespace Illuminate\Database\Eloquent\Relations {
    abstract class Relation {}
    /**
     * @template TRelatedModel of \Illuminate\Database\Eloquent\Model
     * @template TDeclaringModel of \Illuminate\Database\Eloquent\Model
     */
    class HasMany extends Relation {
        /** @return $this */
        public function where($column, $operator = null, $value = null) {}
    }
}
namespace App\Models {
    class User extends \Illuminate\Database\Eloquent\Model {
        /** @return \Illuminate\Database\Eloquent\Relations\HasMany<Post, $this> */
        public function posts() {}
    }
    class Post extends \Illuminate\Database\Eloquent\Model {}
}
namespace Illuminate\Support\Facades { class Artisan {} class Schedule {} }
namespace Illuminate\Contracts\Console { interface Kernel { public function call($command, array $parameters = []); } }
namespace Illuminate\Console { class Command { public function call($command, array $arguments = []) {} } }
namespace Illuminate\Console\Scheduling { class Schedule { public function command($command, array $parameters = []) {} } }
namespace Illuminate\Foundation\Testing { abstract class TestCase { public function artisan($command, $parameters = []) {} } }
namespace Pest\Laravel { function artisan(string $command, array $parameters = []) {} }
namespace {
    function route($name, $parameters = [], $absolute = true) {}
    function redirect($to = null): \Illuminate\Routing\Redirector {}
    /** @return ($view is null ? \Illuminate\Contracts\View\Factory : \Illuminate\Contracts\View\View) */
    function view($view = null, $data = []) {}
    function config($key = null, $default = null) {}
    function env($key, $default = null) {}
    function __($key = null, $replace = [], $locale = null) {}
    function trans_choice($key, $number, array $replace = [], $locale = null) {}
    function asset($path) {}
    function storage_path($path = '') {}
    function inertia($component = null, $props = []) {}
}
"#;

fn fixture(file: &str, text: &str) -> Fixture {
    let fx = Fixture::new(&[("stubs.php", STUBS), (file, text)]);
    let state = &fx.snap.framework;
    state.seed("laravel:active", json!(true));
    state.seed(
        "laravel:routes",
        json!([
            {"method": "GET", "uri": "/", "name": "home", "action": "App\\Http\\Controllers\\HomeController@index", "parameters": [], "filename": "app/Http/Controllers/HomeController.php", "line": 12},
            {"method": "GET", "uri": "posts/{post}", "name": "posts.show", "action": "Closure", "parameters": ["post"], "filename": "routes/web.php", "line": 4},
        ]),
    );
    state.seed(
        "laravel:views",
        json!([
            {"key": "welcome", "path": "resources/views/welcome.blade.php", "isVendor": false},
            {"key": "mail::message", "path": "vendor/x/message.blade.php", "isVendor": true},
            {"key": "livewire.counter", "path": "resources/views/livewire/counter.blade.php", "isVendor": false, "livewire": {"props": [{"name": "count", "type": "int", "hasDefaultValue": true, "defaultValue": 0}], "files": ["app/Livewire/Counter.php"]}},
        ]),
    );
    state.seed(
        "laravel:configs",
        json!([
            {"name": "app.name", "value": "Tusk", "file": "config/app.php", "line": 16},
            {"name": "app.debug", "value": false, "file": "config/app.php", "line": 20},
            {"name": "filesystems.disks.local", "value": "array(...)", "file": "config/filesystems.php", "line": 30},
            {"name": "filesystems.disks.local.root", "value": "/x", "file": "config/filesystems.php", "line": 31},
        ]),
    );
    state.seed("laravel:env", json!({"APP_NAME": {"value": "Tusk", "line": 1}, "APP_KEY": {"value": "", "line": 2}}));
    state.seed(
        "laravel:translations",
        json!({"default": "en", "languages": ["en", "ar"], "paths": ["lang/en/auth.php"], "values": ["Failed :attempts times.", "It's"], "params": [["attempts"]],
            "translations": {"auth.failed": {"en": [0, 0, 5, 0]}, "auth.quote": {"en": [1, 0, 6, null]}}}),
    );
    state.seed("laravel:middleware", json!({"auth": {"class": "App\\Http\\Middleware\\Authenticate", "path": "app/Http/Middleware/Authenticate.php", "line": 9, "parameters": "guards...", "groups": []}}));
    state.seed("laravel:blade-components", json!({"components": {"alert": {"isVendor": false, "paths": ["resources/views/components/alert.blade.php"], "props": "@props(['type'])"}, "flux::button": {"isVendor": true, "paths": ["vendor/flux/button.blade.php"], "props": []}}, "prefixes": ["flux"]}));
    state.seed("laravel:blade-directives", json!([{"name": "money", "hasParams": true}]));
    state.seed(
        "laravel:models",
        json!({"models": {
            "App\\Models\\User": {"attributes": [{"name": "email", "fillable": true, "cast": null}, {"name": "full_name", "fillable": false, "cast": "accessor"}], "relations": [{"name": "posts", "related": "App\\Models\\Post"}]},
            "App\\Models\\Post": {"attributes": [{"name": "title", "fillable": true, "cast": null}], "relations": [{"name": "author", "related": "App\\Models\\User"}]},
        }}),
    );
    state.seed(
        "laravel:commands",
        json!({
            "commands": [
                {"name": "messages:archive", "alias": false, "description": "Archive old messages", "hidden": false, "class": "App\\Console\\Commands\\ArchiveMessages", "path": "app/Console/Commands/ArchiveMessages.php", "line": 12,
                 "arguments": [{"name": "month", "required": true, "array": false, "description": "The month, as YYYY-MM"}],
                 "options": [{"name": "company", "shortcut": "c", "value": true, "array": false, "description": "Only this company"}, {"name": "force", "shortcut": null, "value": false, "array": false, "description": ""}]},
                {"name": "inspire", "alias": false, "description": "Display an inspiring quote", "hidden": false, "class": "Illuminate\\Foundation\\Console\\ClosureCommand", "path": "routes/console.php", "line": 8, "arguments": [], "options": []},
            ],
            "global": [{"name": "env", "shortcut": null, "value": true, "array": false, "description": "The environment"}, {"name": "verbose", "shortcut": "v|vv|vvv", "value": false, "array": false, "description": ""}],
        }),
    );
    fx
}

fn complete(file: &str, text: &str) -> Vec<CompletionItem> {
    let fx = fixture(file, text);
    let at = fx.at();
    with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| crate::framework::completion(ctx, ctx.offset(at.position)))
        .flatten()
        .unwrap_or_default()
}

fn labels(items: &[CompletionItem]) -> Vec<String> {
    let mut l: Vec<_> = items.iter().map(|i| i.label.clone()).collect();
    l.sort();
    l
}

fn problems(file: &str, text: &str) -> Vec<(String, String)> {
    let fx = fixture(file, text);
    with_ctx(&fx.snap, &uri(file), diagnostics)
        .unwrap()
        .into_iter()
        .map(|d| {
            let NumberOrString::String(code) = d.code.unwrap() else { panic!() };
            assert_eq!(d.source.as_deref(), Some(SOURCE));
            (code, d.message)
        })
        .collect()
}

#[test]
fn completes_route_names_in_single_and_double_quotes() {
    let items = complete("t.php", "<?php\nfunction f() {\n    route('ho<|>');\n}\n");
    assert_eq!(labels(&items), vec!["home", "posts.show"]);
    let home = items.iter().find(|i| i.label == "home").unwrap();
    assert_eq!(home.kind, Some(CompletionItemKind::ENUM));
    assert_eq!(home.detail.as_deref(), Some("App\\Http\\Controllers\\HomeController@index\n\n[GET] /"));
    // The edit replaces what's typed in the string.
    let Some(CompletionTextEdit::Edit(edit)) = &home.text_edit else { panic!() };
    assert_eq!((edit.range.start.character, edit.range.end.character), (11, 13));
    assert_eq!(labels(&complete("t.php", "<?php\nfunction f() {\n    route(\"<|>\");\n}\n")).len(), 2);
    // Through an inferred receiver: `redirect()` returns a Redirector.
    assert_eq!(labels(&complete("t.php", "<?php\nfunction f() {\n    redirect()->route('<|>');\n}\n")).len(), 2);
    // An unfinished string still completes.
    assert_eq!(labels(&complete("t.php", "<?php\nfunction f() {\n    route('<|>\n}\n")).len(), 2);
}

#[test]
fn completes_route_parameters_and_translation_details() {
    assert_eq!(labels(&complete("t.php", "<?php route('posts.show', ['<|>' => 1]);")), vec!["post"]);
    let items = complete("t.php", "<?php __('<|>');");
    assert_eq!(labels(&items), vec!["auth.failed", "auth.quote"]);
    assert_eq!(items.iter().find(|i| i.label == "auth.failed").unwrap().detail.as_deref(), Some("Failed :attempts times."));
    assert_eq!(labels(&complete("t.php", "<?php __('auth.failed', ['<|>' => 3]);")), vec!["attempts"]);
    assert_eq!(labels(&complete("t.php", "<?php __('auth.failed', [], '<|>');")), vec!["ar", "en"]);
}

#[test]
fn completes_config_env_views_middleware_and_disks() {
    assert_eq!(labels(&complete("t.php", "<?php config('<|>');")), vec!["app.debug", "app.name", "filesystems.disks.local", "filesystems.disks.local.root"]);
    let env = complete("t.php", "<?php env('<|>');");
    assert_eq!(env.iter().find(|i| i.label == "APP_NAME").unwrap().detail.as_deref(), Some("Tusk"));
    let views = complete("t.php", "<?php view('<|>');");
    assert_eq!(labels(&views), vec!["livewire.counter", "mail::message", "welcome"]);
    assert_eq!(views.iter().find(|i| i.label == "mail::message").unwrap().sort_text.as_deref(), Some("1mail::message"));
    assert_eq!(labels(&complete("t.php", "<?php \\Illuminate\\Support\\Facades\\Route::middleware(['<|>']);")), vec!["auth"]);
    assert_eq!(labels(&complete("t.php", "<?php \\Illuminate\\Support\\Facades\\Storage::disk('<|>');")), vec!["local"]);
}

#[test]
fn completes_validation_rules_and_eloquent_attributes() {
    let rules = complete("t.php", "<?php function f(\\Illuminate\\Http\\Request $r) { $r->validate(['email' => 'required|em<|>']); }");
    assert!(labels(&rules).contains(&"email".to_string()));
    let between = rules.iter().find(|i| i.label == "between").unwrap();
    let Some(CompletionTextEdit::Edit(edit)) = &between.text_edit else { panic!() };
    assert_eq!(edit.new_text, "between:${1:min},${2:max}");
    let form = complete("t.php", "<?php class StoreUser extends \\Illuminate\\Foundation\\Http\\FormRequest { public function rules() { return ['name' => 'req<|>']; } }");
    assert!(labels(&form).contains(&"required".to_string()));
    assert_eq!(labels(&complete("t.php", "<?php \\App\\Models\\User::where('<|>');")), vec!["email"]);
    assert_eq!(labels(&complete("t.php", "<?php \\App\\Models\\User::with('<|>');")), vec!["posts"]);
}

#[test]
fn completes_eloquent_attributes_through_builder_chains() {
    let user = vec!["email".to_string()];
    let post = vec!["title".to_string()];
    // A builder's model comes from its type argument.
    assert_eq!(labels(&complete("t.php", "<?php \\App\\Models\\User::query()->where('<|>');")), user);
    // A chain the analyzer can't type counts as its root's class.
    assert_eq!(labels(&complete("t.php", "<?php \\App\\Models\\User::where('email', 1)->orderBy('<|>');")), user);
    // A relation's related model.
    assert_eq!(labels(&complete("t.php", "<?php function f(\\App\\Models\\User $u) { $u->posts()->where('<|>'); }")), post);
    // A closure passed to a relation method queries the relation's model.
    assert_eq!(labels(&complete("t.php", "<?php \\App\\Models\\Post::whereHas('author', fn ($q) => $q->where('<|>'));")), user);
    assert_eq!(labels(&complete("t.php", "<?php \\App\\Models\\User::query()->whereHas('posts', function ($q) { $q->where('<|>'); });")), post);
}

#[test]
fn reports_unknown_names_and_skips_what_it_cant_check() {
    let found = problems(
        "t.php",
        "<?php\nroute('home'); route('missing'); route('admin.*');\nview('nope'); config('app.nam'); env('NOPE');\n__('auth.failed'); __('auth.nope'); __('Just a sentence.');\n\\Illuminate\\Support\\Facades\\Route::middleware(['auth', 'guest']);\n",
    );
    assert_eq!(
        found,
        vec![
            ("route".into(), "Route [missing] not found.".into()),
            ("view".into(), "View [nope] not found.".into()),
            ("config".into(), "Config [app.nam] not found.".into()),
            ("env".into(), "Env [NOPE] not found.".into()),
            ("translation".into(), "Translation [auth.nope] not found.".into()),
            ("middleware".into(), "Middleware [guest] not found.".into()),
        ]
    );
    // Facts that failed to load report nothing: no assets were seeded, and asset() has no PHP behind it,
    // but auth has no data at all.
    assert!(problems("t.php", "<?php \\Illuminate\\Support\\Facades\\Gate::allows('edit');").is_empty());
}

#[test]
fn completes_and_checks_vite_assets() {
    let fx = fixture("resources/views/app.blade.php", "<head>\n    @vite(['resources/css/app.css', '<|>'])\n</head>\n");
    fx.snap.framework.seed("laravel:vite-files", json!(["resources/css/app.css", "resources/js/app.js"]));
    let at = fx.at();
    let items = with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| crate::framework::completion(ctx, ctx.offset(at.position))).flatten().unwrap();
    assert_eq!(labels(&items), vec!["resources/css/app.css", "resources/js/app.js"]);
    // The fixture's files aren't on disk, so each named file is missing.
    let found = problems("t.php", "<?php \\Illuminate\\Support\\Facades\\Vite::asset('resources/images/logo.png');");
    assert_eq!(found, vec![("vite".into(), "Vite asset [resources/images/logo.png] not found.".into())]);
}

#[test]
fn offers_to_create_what_a_name_is_missing() {
    let fx = fixture("t.php", "<?php\nview('admin.users.index');\nenv('NOPE');\ninertia('Users/Show');\n");
    fx.snap.framework.seed("laravel:inertia", json!({"page_paths": ["resources/js/Pages"], "page_extensions": ["vue"]}));
    fx.snap.framework.seed("laravel:inertia-pages", json!({"pages": {"Home": "resources/js/Pages/Home.tsx"}, "paths": ["resources/js/Pages"], "extensions": ["vue"]}));
    let actions = with_ctx(&fx.snap, &uri("t.php"), |ctx| actions::code_actions(ctx, Range { start: Position::new(0, 0), end: Position::new(4, 0) })).unwrap();
    let summary: Vec<(String, String, Vec<serde_json::Value>)> = actions
        .iter()
        .map(|a| {
            let Some(DocumentChanges::Operations(ops)) = &a.edit.as_ref().unwrap().document_changes else { panic!() };
            let created = ops.iter().find_map(|o| match o {
                DocumentChangeOperation::Op(ResourceOp::Create(c)) => Some(c.uri.as_str().to_string()),
                _ => None,
            });
            let command = a.command.as_ref().unwrap();
            assert_eq!(command.command, "phpEditor.open");
            (a.title.clone(), created.unwrap(), command.arguments.clone().unwrap())
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            ("Create missing view".into(), "file:///project/resources/views/admin/users/index.blade.php".into(), vec![json!("file:///project/resources/views/admin/users/index.blade.php"), json!(1)]),
            ("Add variable to .env".into(), "file:///project/.env".into(), vec![json!("file:///project/.env"), json!(1)]),
            // The extension the existing pages use.
            ("Create resources/js/Pages/Users/Show.tsx".into(), "file:///project/resources/js/Pages/Users/Show.tsx".into(), vec![json!("file:///project/resources/js/Pages/Users/Show.tsx"), json!(1)]),
        ]
    );
}

#[test]
fn places_new_env_variables_by_their_prefix() {
    let env = "APP_NAME=Tusk\nAPP_ENV=local\n\nDB_HOST=127.0.0.1\n";
    assert_eq!(actions::env_insertion(env, "APP_KEY="), (2, "APP_KEY=\n".into()));
    assert_eq!(actions::env_insertion(env, "MAIL_HOST="), (4, "\nMAIL_HOST=\n".into()));
    assert_eq!(actions::env_insertion("", "X="), (0, "X=\n".into()));
}

#[test]
fn turns_env_variables_into_vite_ones() {
    let fx = Fixture::new(&[(".env", "APP_NAME=Tusk\nPUSHER_KEY=abc\nVITE_APP_NAME=\"${APP_NAME}\"\n")]);
    fx.snap.framework.seed("laravel:active", json!(true));
    let actions = with_ctx(&fx.snap, &uri(".env"), |ctx| actions::code_actions(ctx, Range { start: Position::new(0, 0), end: Position::new(1, 5) })).unwrap();
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0].title, "Create Vite env variable from \"PUSHER_KEY\"");
    let changes = &actions[0].edit.as_ref().unwrap();
    let Some(DocumentChanges::Operations(ops)) = &changes.document_changes else { panic!() };
    let DocumentChangeOperation::Edit(e) = &ops[0] else { panic!() };
    let OneOf::Left(edit) = &e.edits[0] else { panic!() };
    assert_eq!((edit.range.start.line, edit.new_text.as_str()), (3, "\nVITE_PUSHER_KEY=\"${PUSHER_KEY}\"\n"));
}

#[test]
fn matches_policies_to_the_calls_model() {
    let text = "<?php\nuse Illuminate\\Support\\Facades\\Gate;\nfunction f(\\App\\Models\\Post $post, $thing) {\n    Gate::allows('update', $post);\n    Gate::allows('update', \\App\\Models\\User::class);\n    Gate::allows('update', $thing);\n    Gate::has('update');\n    Gate::allows('nope');\n}\n";
    let fx = fixture("t.php", text);
    fx.snap.framework.seed(
        "laravel:auth",
        json!({"policies": {"update": [{"policy": "App\\Policies\\PostPolicy", "uri": "app/Policies/PostPolicy.php", "line": 20, "model": "\\App\\Models\\Post"}]}}),
    );
    let (found, links) = with_ctx(&fx.snap, &uri("t.php"), |ctx| (diagnostics(ctx), document_links(ctx))).unwrap();
    let found: Vec<(u32, String)> = found.into_iter().map(|d| (d.range.start.line, d.message)).collect();
    assert_eq!(found, vec![(4, "Policy/Model match [update] not found.".into()), (7, "Policy [nope] not found.".into())]);
    // A link needs exactly one matching policy: the typed `$post` and `has()` have it; an untyped model doesn't.
    let lines: Vec<u32> = links.iter().map(|l| l.range.start.line).collect();
    assert_eq!(lines, vec![3, 6]);
    // A `Gate::before` hook, as spatie/laravel-permission adds, may grant any ability.
    fx.snap.framework.seed("laravel:auth", json!({"before": true, "policies": {}}));
    assert!(with_ctx(&fx.snap, &uri("t.php"), diagnostics).unwrap().is_empty());
}

#[test]
fn matches_controller_actions_by_their_short_name() {
    let found = problems(
        "t.php",
        "<?php\n\\Illuminate\\Support\\Facades\\Route::get('/', 'HomeController@index');\n\\Illuminate\\Support\\Facades\\Route::get('/x', 'HomeController@nope');\n",
    );
    assert_eq!(found, vec![("controllerAction".into(), "Controller/Method [HomeController@nope] not found.".into())]);
}

#[test]
fn links_hovers_and_definitions() {
    let fx = fixture("t.php", "<?php config('app.na<|>me'); route('home');");
    let at = fx.at();
    let (defs, hover, links) = with_ctx(&fx.snap, &at.text_document.uri, |ctx| {
        let offset = ctx.offset(at.position);
        (definition(ctx, offset), super::hover(ctx, offset), document_links(ctx))
    })
    .unwrap();
    assert!(defs[0].uri.as_str().ends_with("/project/config/app.php"));
    assert_eq!(defs[0].range.start.line, 15);
    let HoverContents::Markup(m) = hover.unwrap().contents else { panic!() };
    assert_eq!(m.value, "`Tusk`\n\n[config/app.php](file:///project/config/app.php#L16)");
    let targets: Vec<_> = links.iter().map(|l| l.target.as_ref().unwrap().as_str().to_string()).collect();
    assert_eq!(targets, vec!["file:///project/config/app.php#L16", "file:///project/app/Http/Controllers/HomeController.php#L12"]);
}

#[test]
fn works_in_blade_views() {
    let blade = "<div>\n  {{ route('home') }}\n  @include('nope')\n  <x-alert type=\"x\" />\n</div>\n";
    let found = problems("resources/views/t.blade.php", blade);
    assert_eq!(found, vec![("view".into(), "View [nope] not found.".into())]);

    let items = complete("resources/views/t.blade.php", "<div>\n  @include('<|>')\n</div>");
    assert!(labels(&items).contains(&"welcome".to_string()));
    let items = complete("resources/views/t.blade.php", "<div>\n  {{ __('au<|>') }}\n</div>");
    assert_eq!(labels(&items), vec!["auth.failed", "auth.quote"]);
    let items = complete("resources/views/t.blade.php", "<div>\n  <x-al<|>\n</div>");
    assert_eq!(labels(&items), vec!["x-alert", "x-flux::button"]);
    let items = complete("resources/views/t.blade.php", "<div>\n  <livewire:<|>\n</div>");
    assert_eq!(labels(&items), vec!["counter"]);
    let items = complete("resources/views/t.blade.php", "<div>\n  @fore<|>\n</div>");
    assert!(labels(&items).contains(&"@foreach(...)".to_string()));
    assert!(labels(&items).contains(&"@money(...)".to_string()));
    // Only after `<`: a word ending in x isn't a component.
    assert!(complete("resources/views/t.blade.php", "<div>\n  box<|>\n</div>").is_empty());

    let fx = fixture("resources/views/t.blade.php", "<div>\n  <x-al<|>ert />\n</div>");
    let at = fx.at();
    let (hover, defs) = with_ctx(&fx.snap, &at.text_document.uri, |ctx| {
        let offset = ctx.offset(at.position);
        (super::hover(ctx, offset), definition(ctx, offset))
    })
    .unwrap();
    let HoverContents::Markup(m) = hover.unwrap().contents else { panic!() };
    assert!(m.value.contains("```blade\n@props(['type'])\n```"), "{}", m.value);
    assert!(defs[0].uri.as_str().ends_with("components/alert.blade.php"));
}

#[test]
fn reads_inertia_props() {
    let vue = "<script setup lang=\"ts\">\ndefineProps<{\n  user: { name: string };\n  canEdit?: boolean;\n}>()\n</script>";
    assert_eq!(inertia_props(vue), vec!["user", "canEdit"]);
    assert_eq!(inertia_props("defineProps({ post: Object, 'tags': Array })"), vec!["post", "tags"]);
}

#[test]
fn recognizes_translation_keys() {
    assert!(looks_like_translation_key("auth.failed"));
    assert!(looks_like_translation_key("pkg::messages.hi"));
    assert!(!looks_like_translation_key("Hello there."));
    assert!(!looks_like_translation_key("single"));
}

/// Boots a real Laravel app through PHP. Run with `TUSK_LARAVEL_APP=<root> cargo test -- --ignored`.
#[test]
#[ignore]
fn loads_facts_from_a_real_app() {
    let Ok(root) = std::env::var("TUSK_LARAVEL_APP") else { return };
    let state = crate::framework::State::new(root.into());
    let data = Data(&state);
    assert!(data.active());
    for (name, value) in [("routes", data.routes()), ("views", data.views()), ("configs", data.configs()), ("translations", data.translations()), ("middleware", data.middleware())] {
        let value = value.unwrap_or_else(|| panic!("{name} failed to load"));
        let count = value.as_array().map(Vec::len).or_else(|| value.as_object().map(|o| o.len())).unwrap_or(0);
        eprintln!("{name}: {count}");
        assert!(count > 0, "{name} is empty");
    }
    let keys = data.translations().unwrap()["keys"].as_object().map_or(0, |k| k.len());
    eprintln!("translation keys: {keys}");
    // These may be empty in a given app, but must run.
    for (name, value) in [("auth", data.auth()), ("app-bindings", data.app_bindings()), ("blade-components", data.blade_components()), ("blade-directives", data.blade_directives()), ("paths", data.paths()), ("models", data.models())] {
        assert!(value.is_some(), "{name} failed to load");
    }
    eprintln!("controllers: {}, assets: {}", data.controllers().as_array().map_or(0, Vec::len), data.assets().as_array().map_or(0, Vec::len));
}

#[test]
fn env_files_complete_keys_other_env_files_and_config_name() {
    let envs = [(".env.example".to_string(), "# c\nAPP_KEY=\nexport DB_HOST=127.0.0.1\n".to_string()), (".env".to_string(), "APP_KEY=secret\nAPP_NAME=Tusk\nREDIS_PASSWORD=hunter2\n".to_string())];
    let configs = [("app.php".to_string(), "'key' => env('APP_KEY'), 'url' => env(\"APP_URL\", 'http://localhost'), 'x' => env('MAIL_FROM', 'Tusk app')".to_string())];
    let got = env_candidates("APP_NAME=Mine\n", &envs, &configs);
    let got: Vec<_> = got.iter().map(|(k, v, s)| (k.as_str(), v.as_str(), s.as_str())).collect();
    assert_eq!(
        got,
        vec![("APP_KEY", "", ".env.example"), ("DB_HOST", "127.0.0.1", ".env.example"), ("REDIS_PASSWORD", "", ".env"), ("APP_URL", "http://localhost", "config/app.php"), ("MAIL_FROM", "", "config/app.php")]
    );
    let line = "'url' => env( 'APP_URL'),";
    assert_eq!(env_calls(line).iter().map(|(at, k, _)| &line[*at..*at + k.len()]).collect::<Vec<_>>(), vec!["APP_URL"]);
}

#[test]
fn reads_each_view_in_a_list_of_views() {
    let sources = [
        ("t.php", "<?php \\Illuminate\\Support\\Facades\\Route::view('/x', 'wel<|>come');"),
        ("t.php", "<?php \\Illuminate\\Support\\Facades\\View::first(['nope', 'wel<|>come']);"),
        ("t.php", "<?php view()->first(['nope', 'wel<|>come']);"),
        ("t.php", "<?php view()->make('wel<|>come');"),
        ("resources/views/t.blade.php", "<div>@includeFirst(['nope', 'wel<|>come'])</div>"),
        ("resources/views/t.blade.php", "@extendsFirst(['nope', 'wel<|>come'])"),
        ("resources/views/t.blade.php", "@componentFirst(['nope', 'wel<|>come']) @endcomponent"),
    ];
    for (file, src) in sources {
        let fx = fixture(file, src);
        let at = fx.at();
        let (hover, defs, found) = with_ctx(&fx.snap, &at.text_document.uri, |ctx| {
            let offset = ctx.offset(at.position);
            (super::hover(ctx, offset), definition(ctx, offset), diagnostics(ctx))
        })
        .unwrap();
        assert!(hover.is_some(), "{src}");
        assert!(defs[0].uri.as_str().ends_with("/resources/views/welcome.blade.php"), "{src}");
        // The first view that exists renders, so a missing one before it is a fallback, not a problem.
        assert!(found.is_empty(), "{src}: {found:?}");
        let typed = src.replace("wel<|>come", "<|>");
        assert!(labels(&complete(file, &typed)).contains(&"welcome".to_string()), "{src}");
    }
    let found = problems("t.php", "<?php view()->first(['nope', 'gone']); view()->first([$x, 'gone']);");
    assert_eq!(found, vec![("view".into(), "View [nope] not found.".into()), ("view".into(), "View [gone] not found.".into()), ("view".into(), "View [gone] not found.".into())]);
}

#[test]
fn completes_and_checks_artisan_commands() {
    let names = vec!["inspire".to_string(), "messages:archive".to_string()];
    // Wherever a command runs: Artisan, a test, Pest's function, a command, and the scheduler.
    for call in ["\\Illuminate\\Support\\Facades\\Artisan::call('<|>')", "\\Illuminate\\Support\\Facades\\Schedule::command('<|>')", "\\Pest\\Laravel\\artisan('<|>')"] {
        assert_eq!(labels(&complete("t.php", &format!("<?php {call};"))), names, "{call}");
    }
    let in_class = |body: &str, parent: &str| format!("<?php class T extends {parent} {{ function f() {{ {body}; }} }}");
    assert_eq!(labels(&complete("t.php", &in_class("$this->artisan('<|>')", "\\Illuminate\\Foundation\\Testing\\TestCase"))), names);
    assert_eq!(labels(&complete("t.php", &in_class("$this->call('<|>')", "\\Illuminate\\Console\\Command"))), names);
    let archive = complete("t.php", "<?php \\Illuminate\\Support\\Facades\\Artisan::call('mess<|>');");
    assert_eq!(archive.iter().find(|i| i.label == "messages:archive").unwrap().detail.as_deref(), Some("Archive old messages"));
    // Options after the name, and the parameters' keys: the command's own first, then the application's.
    let options = vec!["--company", "--env", "--force", "--verbose", "-c", "-v", "-vv", "-vvv"];
    assert_eq!(labels(&complete("t.php", "<?php \\Illuminate\\Support\\Facades\\Artisan::call('messages:archive 2026-05 --<|>');")), options);
    let keys = complete("t.php", "<?php \\Illuminate\\Support\\Facades\\Artisan::call('messages:archive', ['<|>' => 1]);");
    let mut all = [vec!["month"], options].concat();
    all.sort();
    assert_eq!(labels(&keys), all);
    // Arguments first, then the command's options, then the application's.
    let sort = |label: &str| keys.iter().find(|i| i.label == label).unwrap().sort_text.clone();
    assert!(sort("month") < sort("--company"));
    let company = keys.iter().find(|i| i.label == "--company").unwrap();
    assert_eq!(company.detail.as_deref(), Some("option, takes a value"));
    assert!(company.sort_text < keys.iter().find(|i| i.label == "--env").unwrap().sort_text);

    let found = problems(
        "t.php",
        "<?php\nuse Illuminate\\Support\\Facades\\Artisan;\nArtisan::call('messages:archive 2026-05 --force -v --env=testing');\nArtisan::call('messages:archvie');\nArtisan::call('messages:archive --forse');\nArtisan::call('messages:archive 2026-05 extra');\nArtisan::call('messages:archive', ['month' => '2026-05', '--company' => 1, '--company=2' => 1, '-c' => 1]);\nArtisan::call('messages:archive', ['monht' => '2026-05', '--forse' => true]);\nArtisan::call('App\\\\Console\\\\Commands\\\\Archive');\nArtisan::call(\"messages:$name\");\n",
    );
    assert_eq!(
        found,
        vec![
            ("command".into(), "Command [messages:archvie] not found.".into()),
            ("command".into(), "Option [--forse] not found on command [messages:archive].".into()),
            ("command".into(), "Argument [extra] not found on command [messages:archive].".into()),
            ("command".into(), "Argument [monht] not found on command [messages:archive].".into()),
            ("command".into(), "Option [--forse] not found on command [messages:archive].".into()),
        ]
    );
}

#[test]
fn shows_and_goes_to_artisan_commands() {
    let fx = fixture("t.php", "<?php \\Illuminate\\Support\\Facades\\Artisan::call('messages:arc<|>hive --force', ['--company' => 1]);");
    let at = fx.at();
    let hover = with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| super::hover(ctx, ctx.offset(at.position))).flatten().unwrap();
    let lsp_types::HoverContents::Markup(m) = hover.contents else { panic!() };
    assert!(m.value.starts_with("`messages:archive [--company=COMPANY] [--force] <month>`\n\nArchive old messages\n\n[App\\Console\\Commands\\ArchiveMessages]("), "{}", m.value);
    let found = with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| definition(ctx, ctx.offset(at.position))).unwrap();
    assert_eq!(found.len(), 1);
    assert!(found[0].uri.as_str().ends_with("app/Console/Commands/ArchiveMessages.php") && found[0].range.start.line == 11, "{found:?}");
    // A key of the parameters shows the option, and goes to its command.
    let fx = fixture("t.php", "<?php \\Illuminate\\Support\\Facades\\Artisan::call('messages:archive', ['--comp<|>any' => 1]);");
    let at = fx.at();
    let hover = with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| super::hover(ctx, ctx.offset(at.position))).flatten().unwrap();
    let lsp_types::HoverContents::Markup(m) = hover.contents else { panic!() };
    assert_eq!(m.value, "`--company`, takes a value\n\nOnly this company");
    let found = with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| definition(ctx, ctx.offset(at.position))).unwrap();
    assert!(found[0].uri.as_str().ends_with("ArchiveMessages.php"), "{found:?}");
    // A closure command goes to its file.
    let fx = fixture("t.php", "<?php \\Illuminate\\Support\\Facades\\Artisan::call('insp<|>ire');");
    let at = fx.at();
    let found = with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| definition(ctx, ctx.offset(at.position))).unwrap();
    assert!(found[0].uri.as_str().ends_with("routes/console.php") && found[0].range.start.line == 7, "{found:?}");
}
