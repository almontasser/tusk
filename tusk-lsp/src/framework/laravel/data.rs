//! Facts about a Laravel app: from Laravel LSP's PHP scripts, which boot the app, and from files read directly
//! where no PHP is needed (`.env`, `public/`, the Mix manifest, controllers, Inertia pages).
//!
//! Each fact is cached in [`State`] until a file it depends on changes. A script that fails caches nothing
//! useful, and the features built on it then report no problems rather than flag every call.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value, json};

use crate::framework::State;

const GLOBAL: &str = include_str!("../../../php/laravel/global.php");

/// Loads the app's facts, each once until its files change.
pub struct Data<'a>(pub &'a State);

/// Runs after the app boots, so each script sees the app's container, config, and routes.
const BOOT: &str = "<?php
define('LARAVEL_START', microtime(true));
require getcwd() . '/vendor/autoload.php';
$app = require getcwd() . '/bootstrap/app.php';
$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();
error_reporting(error_reporting() & ~(E_WARNING | E_CORE_WARNING | E_COMPILE_WARNING | E_USER_WARNING | E_DEPRECATED | E_USER_DEPRECATED));
";

fn body(script: &str) -> &str {
    script.trim_start().strip_prefix("<?php").unwrap_or(script)
}

/// The paths (relative to the root) each fact depends on, from Laravel LSP's watchers. A path is a prefix.
const PROVIDERS: &[&str] = &["app/Providers/"];
const VIEWS: &[&str] = &["resources/views/", "Modules/", "app/View/"];

impl Data<'_> {
    pub fn root(&self) -> &Path {
        self.0.root()
    }

    /// Whether the project is a Laravel app.
    pub fn active(&self) -> bool {
        let artisan = self.root().join("artisan");
        self.0.remember("laravel:active", &["artisan"], || Value::Bool(artisan.is_file())).as_bool() == Some(true)
    }

    /// A path from a script or the data, made absolute against the root.
    pub fn abs(&self, path: &str) -> PathBuf {
        let p = Path::new(path);
        if p.is_absolute() { p.to_path_buf() } else { self.root().join(p) }
    }

    pub(super) fn script(&self, key: &str, template: &str, depends_on: &[&str]) -> Option<Arc<Value>> {
        // An app without `vendor/autoload.php` and `bootstrap/app.php` boots through `artisan tinker` instead,
        // as Laravel LSP does. A project PHP can't boot fails here, and the failure is cached like any result.
        let bootable = self.root().join("vendor/autoload.php").is_file() && self.root().join("bootstrap/app.php").is_file();
        let script = format!("{}{}\n{}", if bootable { BOOT } else { "<?php\n" }, body(GLOBAL), body(template));
        self.0.php_script(&format!("laravel:{key}"), &script, &[], depends_on, !bootable)
    }

    pub fn routes(&self) -> Option<Arc<Value>> {
        self.script("routes", include_str!("../../../php/laravel/routes.php"), &["routes/", "app/", "bootstrap/app.php"])
    }

    pub fn views(&self) -> Option<Arc<Value>> {
        self.script("views", include_str!("../../../php/laravel/views.php"), VIEWS)
    }

    pub fn configs(&self) -> Option<Arc<Value>> {
        self.script("configs", include_str!("../../../php/laravel/configs.php"), &["config/", ".env"])
    }

    pub fn middleware(&self) -> Option<Arc<Value>> {
        self.script("middleware", include_str!("../../../php/laravel/middleware.php"), &["app/Http/Kernel.php", "bootstrap/app.php"])
    }

    pub fn auth(&self) -> Option<Arc<Value>> {
        self.script("auth", include_str!("../../../php/laravel/auth.php"), &["app/Providers/", "app/Models/", "app/Policies/"])
    }

    pub fn app_bindings(&self) -> Option<Arc<Value>> {
        self.script("app-bindings", include_str!("../../../php/laravel/app-bindings.php"), PROVIDERS)
    }

    pub fn blade_components(&self) -> Option<Arc<Value>> {
        self.script("blade-components", include_str!("../../../php/laravel/blade-components.php"), &["resources/views/", "Modules/", "app/View/", "app/Providers/"])
    }

    pub fn blade_directives(&self) -> Option<Arc<Value>> {
        self.script("blade-directives", include_str!("../../../php/laravel/blade-directives.php"), &["app/"])
    }

    pub fn models(&self) -> Option<Arc<Value>> {
        self.script("models", include_str!("../../../php/laravel/models.php"), &["app/", "database/migrations/", "composer.json", "composer.lock"])
    }

    /// Artisan commands: `{commands: [{name, alias, description, hidden, class, path, line, arguments, options}],
    /// global: [options]}`, where `global` is what every command takes from the application, such as `--env`.
    pub fn commands(&self) -> Option<Arc<Value>> {
        self.script("commands", include_str!("../../../php/laravel/commands.php"), &["app/Console/", "routes/console.php", "bootstrap/app.php", "app/Providers/", "composer.lock"])
    }

    pub fn paths(&self) -> Option<Arc<Value>> {
        self.script("paths", include_str!("../../../php/laravel/paths.php"), &["config/"])
    }

    /// Translations by key, then locale: `{value, path, line, params}`. The script's output is compressed
    /// into shared tables of values, paths, and parameters, expanded here once.
    pub fn translations(&self) -> Option<Arc<Value>> {
        let raw = self.script("translations", include_str!("../../../php/laravel/translations.php"), &["lang/", "resources/lang/"])?;
        let expanded = self.0.remember("laravel:translations-expanded", &["lang/", "resources/lang/"], || expand_translations(&raw));
        (!expanded.is_null()).then_some(expanded)
    }

    /// `.env` variables: `{KEY: {value, line}}`, with 1-based lines. Quotes stay as written.
    pub fn env(&self) -> Option<Arc<Value>> {
        let path = self.root().join(".env");
        let value = self.0.remember("laravel:env", &[".env"], || match std::fs::read_to_string(&path) {
            Ok(text) => parse_env(&text),
            Err(_) => Value::Null,
        });
        (!value.is_null()).then_some(value)
    }

    /// Files in `public/`, relative to it, other than PHP.
    pub fn assets(&self) -> Arc<Value> {
        let public = self.root().join("public");
        self.0.remember("laravel:assets", &["public/"], || {
            let mut out: Vec<String> = ignore::WalkBuilder::new(&public)
                .standard_filters(false)
                .max_depth(Some(10))
                .build()
                .flatten()
                .filter(|e| e.file_type().is_some_and(|t| t.is_file()) && e.path().extension().is_none_or(|x| x != "php"))
                .filter_map(|e| e.path().strip_prefix(&public).ok().map(|p| p.to_string_lossy().into_owned()))
                .collect();
            out.sort();
            json!(out)
        })
    }

    /// Files under `resources/` other than views and translations, relative to the root: what `@vite()` and
    /// `Vite::asset()` usually name.
    pub fn vite_files(&self) -> Arc<Value> {
        let root = self.root().to_path_buf();
        self.0.remember("laravel:vite-files", &["resources/"], || {
            let resources = root.join("resources");
            let mut out: Vec<String> = ignore::WalkBuilder::new(&resources)
                .standard_filters(false)
                .max_depth(Some(10))
                .filter_entry(|e| !(e.depth() == 1 && matches!(e.file_name().to_str(), Some("views" | "lang"))))
                .build()
                .flatten()
                .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
                .filter_map(|e| e.path().strip_prefix(&root).ok().map(|p| p.to_string_lossy().into_owned()))
                .collect();
            out.sort();
            json!(out)
        })
    }

    /// The Mix manifest: `{"/js/app.js": "/js/app.js?id=…"}`.
    pub fn mix(&self) -> Option<Arc<Value>> {
        let path = self.root().join("public/mix-manifest.json");
        let value = self.0.remember("laravel:mix", &["public/mix-manifest.json"], || {
            std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null)
        });
        (!value.is_null()).then_some(value)
    }

    /// Controller actions: `Sub\Controller@method` and `Controller@method`, or the class alone for an
    /// invokable controller, found by reading `app/Http/Controllers`.
    pub fn controllers(&self) -> Arc<Value> {
        let dir = self.root().join("app/Http/Controllers");
        self.0.remember("laravel:controllers", &["app/Http/Controllers/"], || {
            let mut out: Vec<String> = vec![];
            for entry in ignore::WalkBuilder::new(&dir).standard_filters(false).build().flatten() {
                let path = entry.path();
                if path.extension().is_none_or(|e| e != "php") || entry.metadata().map_or(true, |m| m.len() > 50_000) {
                    continue;
                }
                let Ok(text) = std::fs::read_to_string(path) else { continue };
                out.extend(controller_actions(&text));
            }
            out.dedup();
            json!(out)
        })
    }

    /// Inertia pages: `{name: path}`, from the configured page folders and extensions.
    pub fn inertia(&self) -> Arc<Value> {
        let config = self.script("inertia", include_str!("../../../php/laravel/inertia.php"), &["config/"]);
        let root = self.root().to_path_buf();
        self.0.remember("laravel:inertia-pages", &["resources/js/", "config/"], || {
            let list = |key: &str| -> Vec<String> {
                config.as_ref().and_then(|c| c[key].as_array().cloned()).unwrap_or_default().iter().filter_map(|v| v.as_str().map(String::from)).collect()
            };
            let mut paths = list("page_paths");
            if paths.is_empty() {
                paths = vec!["resources/js/Pages".into(), "resources/js/pages".into()];
            }
            let mut extensions: Vec<String> = list("page_extensions").into_iter().map(|e| e.trim_start_matches('.').to_string()).collect();
            if extensions.is_empty() {
                extensions = vec!["vue".into()];
            }
            let mut pages = Map::new();
            for dir in paths {
                let base = root.join(&dir);
                for entry in ignore::WalkBuilder::new(&base).standard_filters(false).build().flatten() {
                    let path = entry.path();
                    let Some(ext) = path.extension().map(|e| e.to_string_lossy().into_owned()) else { continue };
                    if !extensions.contains(&ext) || !entry.file_type().is_some_and(|t| t.is_file()) {
                        continue;
                    }
                    let Ok(rel) = path.strip_prefix(&base) else { continue };
                    let name = rel.with_extension("").to_string_lossy().into_owned();
                    pages.entry(name).or_insert_with(|| json!(format!("{dir}/{}", rel.to_string_lossy())));
                }
            }
            json!({ "pages": pages, "paths": list("page_paths"), "extensions": extensions })
        })
    }
}

fn parse_env(text: &str) -> Value {
    let mut out = Map::new();
    for (i, line) in text.split('\n').enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        out.insert(key.trim().to_string(), json!({ "value": value.trim(), "line": i + 1 }));
    }
    Value::Object(out)
}

/// The actions a controller file declares, as routes name them.
fn controller_actions(text: &str) -> Vec<String> {
    let Some(namespace) = text.split("namespace ").nth(1).and_then(|r| r.split(';').next()).map(str::trim) else { return vec![] };
    let Some((_, sub)) = namespace.split_once("\\Http\\Controllers").or_else(|| namespace.strip_suffix("Http\\Controllers").map(|_| ("", ""))) else {
        return vec![];
    };
    let sub = sub.trim_start_matches('\\');
    let Some(class) = text.split("class ").skip(1).find_map(|rest| {
        let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
        (!name.is_empty() && rest[name.len()..].trim_start().starts_with("extends")).then_some(name)
    }) else {
        return vec![];
    };
    let mut out = vec![];
    for rest in text.split("public function ").skip(1) {
        let method: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
        if method.is_empty() || method == "__construct" || !rest[method.len()..].trim_start().starts_with('(') {
            continue;
        }
        let action = if method == "__invoke" { class.clone() } else { format!("{class}@{method}") };
        if !sub.is_empty() {
            out.push(format!("{sub}\\{action}"));
        }
        out.push(action);
    }
    out
}

fn expand_translations(raw: &Value) -> Value {
    let table = |key: &str| raw[key].as_array().cloned().unwrap_or_default();
    let (values, paths, params) = (table("values"), table("paths"), table("params"));
    let Some(translations) = raw["translations"].as_object() else { return Value::Null };
    let mut out = Map::new();
    for (key, locales) in translations {
        let Some(locales) = locales.as_object() else { continue };
        let mut expanded = Map::new();
        for (locale, t) in locales {
            let at = |i: usize| t.get(i).and_then(Value::as_u64).map(|n| n as usize);
            expanded.insert(
                locale.clone(),
                json!({
                    "value": at(0).and_then(|i| values.get(i)).cloned().unwrap_or(Value::Null),
                    "path": at(1).and_then(|i| paths.get(i)).cloned().unwrap_or(Value::Null),
                    "line": t.get(2).cloned().unwrap_or(Value::Null),
                    "params": at(3).and_then(|i| params.get(i)).cloned().unwrap_or(json!([])),
                }),
            );
        }
        out.insert(key.clone(), Value::Object(expanded));
    }
    json!({ "default": raw["default"], "languages": raw["languages"], "keys": out })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_controller_actions() {
        let text = "<?php\nnamespace App\\Http\\Controllers\\Admin;\nclass UserController extends Controller {\n    public function __construct() {}\n    public function index() {}\n    public function __invoke() {}\n}\n";
        assert_eq!(controller_actions(text), vec!["Admin\\UserController@index", "UserController@index", "Admin\\UserController", "UserController"]);
        let root = "<?php\nnamespace App\\Http\\Controllers;\nclass HomeController extends Controller { public function show($id) {} }";
        assert_eq!(controller_actions(root), vec!["HomeController@show"]);
    }

    #[test]
    fn parses_env_files() {
        let env = parse_env("# comment\nAPP_NAME=\"Tusk\"\n\nDB_HOST = 127.0.0.1\n");
        assert_eq!(env["APP_NAME"], json!({"value": "\"Tusk\"", "line": 2}));
        assert_eq!(env["DB_HOST"]["line"], 4);
    }

    #[test]
    fn expands_compressed_translations() {
        let raw = json!({"default": "en", "languages": ["en"], "paths": ["lang/en/auth.php"], "values": ["Hi :name"], "params": [["name"]],
            "translations": {"auth.hi": {"en": [0, 0, 3, 0]}}});
        let t = expand_translations(&raw);
        assert_eq!(t["keys"]["auth.hi"]["en"], json!({"value": "Hi :name", "path": "lang/en/auth.php", "line": 3, "params": ["name"]}));
    }
}
