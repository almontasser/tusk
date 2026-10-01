//! Laravel features, after Laravel LSP (laravel/lsp v0.0.32): completion, hovers, links, and problems for the
//! strings passed to Laravel's calls (routes, views, config, translations, and more), in PHP and Blade.
//!
//! A string's call is matched by the classes the analyzer infers, so `redirect()->route('home')` matches as
//! a call on `Illuminate\Routing\Redirector`. Facade calls are static calls on the facade class, so patterns
//! list the facade, its short alias, and the class behind it.

pub mod actions;
pub mod blade;
mod data;
mod tables;
pub mod views;

use std::path::{Path, PathBuf};

use lsp_types::{
    CompletionItem, CompletionItemKind, CompletionTextEdit, Diagnostic, DiagnosticSeverity, DocumentLink, Hover,
    HoverContents, InsertTextFormat, Location, MarkupContent, MarkupKind, NumberOrString, Position, Range, TextEdit, Uri,
};
use mago_codex::metadata::CodebaseMetadata;
use mago_span::HasSpan;
use mago_syntax::cst::Node;
use serde_json::Value;

use self::data::Data;
use crate::features::{Ctx, with_text};
use crate::framework::{CallKind, InArray, StringArg, string_arg_at, string_args};
use crate::text::path_to_uri;

pub const SOURCE: &str = "Laravel Extension";

/// What a string names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Route,
    /// A Volt or Livewire component a route renders, named without `livewire.`.
    Component,
    ControllerAction,
    View,
    Config,
    Env,
    Translation,
    Middleware,
    Auth,
    AppBinding,
    Asset,
    Mix,
    Storage,
    Inertia,
    /// A file under a path helper's folder, such as `storage_path('logs/x.log')`.
    Path,
    /// A file Vite builds or serves, relative to the root: `@vite('resources/js/app.js')`.
    Vite,
}

fn facade(name: &str) -> [String; 2] {
    [name.to_string(), format!("Illuminate\\Support\\Facades\\{name}")]
}

/// Matches a string argument's call against Laravel's call sites.
struct Site<'a> {
    arg: &'a StringArg,
    codebase: &'a CodebaseMetadata,
}

impl Site<'_> {
    fn at(&self, indexes: &[usize]) -> bool {
        indexes.contains(&self.arg.index)
    }

    fn function(&self, names: &[&str], indexes: &[usize]) -> bool {
        self.arg.call.is_function(names) && self.at(indexes)
    }

    /// A method or static call named one of `names` on one of `classes` (or their subclasses).
    fn method(&self, names: &[&str], classes: &[&str], indexes: &[usize]) -> bool {
        self.arg.call.is_method(names) && self.arg.call.on(self.codebase, classes) && self.at(indexes)
    }

    fn facade(&self, names: &[&str], facade_name: &str, others: &[&str], indexes: &[usize]) -> bool {
        let f = facade(facade_name);
        let mut classes: Vec<&str> = vec![&f[0], &f[1]];
        classes.extend(others);
        self.method(names, &classes, indexes)
    }

    fn object(&self, class: &str, indexes: &[usize]) -> bool {
        matches!(self.arg.call.kind, CallKind::New | CallKind::Attribute) && self.arg.call.on(self.codebase, &[class]) && self.at(indexes)
    }
}

const ROUTE_FUNCTIONS: &[&str] = &["route", "signedRoute", "to_route", "temporarySignedRoute", "redirectToRoute"];
const REDIRECTORS: &[&str] = &[
    "Redirect",
    "URL",
    "Response",
    "Illuminate\\Support\\Facades\\Redirect",
    "Illuminate\\Support\\Facades\\URL",
    "Illuminate\\Support\\Facades\\Response",
    "Illuminate\\Routing\\Redirector",
    "Illuminate\\Routing\\UrlGenerator",
    "Illuminate\\Routing\\ResponseFactory",
    "Illuminate\\Contracts\\Routing\\UrlGenerator",
    "Illuminate\\Contracts\\Routing\\ResponseFactory",
];
const ROUTERS: &[&str] = &["Illuminate\\Routing\\Router", "Illuminate\\Contracts\\Routing\\Registrar", "Illuminate\\Routing\\RouteRegistrar"];
const ROUTE_VERBS: &[&str] = &["get", "post", "patch", "put", "delete", "options", "any"];
const TRANSLATORS: &[&str] = &["Illuminate\\Contracts\\Translation\\Translator", "Illuminate\\Translation\\Translator"];

/// What the string names, if it's passed to a call Laravel reads it from.
fn kind_of(arg: &StringArg, codebase: &CodebaseMetadata) -> Option<Kind> {
    let s = Site { arg, codebase };
    let in_array = arg.in_array.is_some();
    let value_in_array = matches!(arg.in_array, Some(InArray::Value(_)));
    // Strings for these kinds may also be listed in an array argument.
    let list_ok = |kind| if !in_array || value_in_array { Some(kind) } else { None };

    if s.function(ROUTE_FUNCTIONS, &[0])
        || s.method(ROUTE_FUNCTIONS, REDIRECTORS, &[0])
        || s.object("Illuminate\\Foundation\\Http\\Attributes\\RedirectToRoute", &[0])
        || s.facade(&["is", "has"], "Route", ROUTERS, &[0])
        || s.facade(&["routeIs"], "Request", &["Illuminate\\Http\\Request"], &[0])
    {
        return (!in_array).then_some(Kind::Route);
    }
    if s.method(&["route"], &["Livewire\\Volt\\Volt"], &[1]) || s.facade(&["livewire"], "Route", ROUTERS, &[1]) || s.function(&["@livewire"], &[0]) {
        return (!in_array).then_some(Kind::Component);
    }
    if s.facade(ROUTE_VERBS, "Route", ROUTERS, &[1]) || s.facade(&["match", "addRoute", "newRoute"], "Route", ROUTERS, &[2]) || s.facade(&["fallback"], "Route", ROUTERS, &[0]) {
        return (!in_array).then_some(Kind::ControllerAction);
    }
    let view = s.method(&["view"], &["Illuminate\\Contracts\\Routing\\ResponseFactory", "Illuminate\\Routing\\ResponseFactory"], &[0])
        || s.method(&["make"], &["Illuminate\\Contracts\\View\\Factory", "Illuminate\\View\\Factory"], &[0])
        || s.facade(&["make", "first", "renderEach", "exists"], "View", &["Illuminate\\View\\Factory"], &[0])
        || s.facade(&["renderWhen", "renderUnless"], "View", &["Illuminate\\View\\Factory"], &[1])
        || s.facade(&["view"], "Route", ROUTERS, &[1])
        || s.method(&["markdown", "view"], &["Illuminate\\Notifications\\Messages\\MailMessage", "Illuminate\\Mail\\Mailable"], &[0])
        || s.method(&["assertViewIs"], &["Illuminate\\Testing\\TestResponse"], &[0])
        || (s.object("Illuminate\\Mail\\Mailables\\Content", &[0, 3]) && arg.name.is_none())
        || (s.object("Illuminate\\Mail\\Mailables\\Content", &[0, 1, 2, 3, 4, 5, 6]) && matches!(arg.name.as_deref(), Some("view" | "markdown" | "html" | "text")))
        || s.function(&["view", "markdown", "links", "assertViewIs"], &[0])
        || s.function(&["@each", "@extends", "@include", "@includeIf", "@includeFirst", "@component"], &[0])
        || s.function(&["@includeWhen", "@includeUnless"], &[1]);
    if view {
        return list_ok(Kind::View);
    }
    if s.function(&["config"], &[0])
        || s.object("Illuminate\\Container\\Attributes\\Config", &[0])
        || s.method(&["get", "prepend", "push", "has"], &["Illuminate\\Contracts\\Config\\Repository", "Illuminate\\Config\\Repository"], &[0])
        || s.facade(&["get", "string", "integer", "boolean", "float", "array", "prepend", "push", "has"], "Config", &[], &[0])
    {
        return (!in_array).then_some(Kind::Config);
    }
    if s.facade(&["getMany"], "Config", &["Illuminate\\Config\\Repository"], &[0]) {
        return value_in_array.then_some(Kind::Config);
    }
    if s.function(&["env"], &[0]) || s.method(&["get"], &["Illuminate\\Support\\Env"], &[0]) {
        return (!in_array).then_some(Kind::Env);
    }
    if s.method(&["get", "string", "choice", "has", "hasForLocale"], TRANSLATORS, &[0])
        || s.facade(&["has", "hasForLocale", "get", "string", "choice"], "Lang", &[], &[0])
        || s.function(&["__", "trans", "trans_choice", "@lang"], &[0])
    {
        return (!in_array).then_some(Kind::Translation);
    }
    if s.object("Illuminate\\Routing\\Attributes\\Controllers\\Middleware", &[0])
        || s.facade(
            &["middleware", "withoutMiddleware"],
            "Route",
            &[ROUTERS, &["Illuminate\\Routing\\Route", "Illuminate\\Routing\\PendingResourceRegistration", "Illuminate\\Routing\\Controller"]].concat(),
            &[0, 1, 2],
        )
    {
        return list_ok(Kind::Middleware);
    }
    let gates = ["Illuminate\\Contracts\\Auth\\Access\\Gate", "Illuminate\\Auth\\Access\\Gate"];
    if s.object("Illuminate\\Routing\\Attributes\\Controllers\\Authorize", &[0])
        || s.facade(&["has", "allows", "denies", "check", "any", "none", "authorize", "inspect"], "Gate", &gates, &[0])
        || s.method(&["can", "cannot", "canAny"], &["Illuminate\\Contracts\\Auth\\Access\\Authorizable", "Illuminate\\Foundation\\Auth\\User", "Illuminate\\Routing\\Route", "Illuminate\\Routing\\RouteRegistrar"], &[0])
        || s.facade(&["can", "cannot"], "Route", &[], &[0])
        || s.facade(&["can", "cannot"], "Auth", &[], &[0])
        || s.function(&["@can", "@cannot", "@canany"], &[0])
    {
        return list_ok(Kind::Auth);
    }
    let containers = ["Illuminate\\Contracts\\Container\\Container", "Illuminate\\Contracts\\Foundation\\Application", "Illuminate\\Container\\Container"];
    if s.object("Illuminate\\Container\\Attributes\\Bind", &[0])
        || s.object("Illuminate\\Container\\Attributes\\Give", &[0])
        || s.method(&["make", "bound"], &containers, &[0])
        || s.facade(&["make", "bound", "isShared"], "App", &[], &[0])
        || s.function(&["app", "resolve"], &[0])
    {
        return (!in_array).then_some(Kind::AppBinding);
    }
    if s.function(&["asset"], &[0]) || s.method(&["asset"], &["Illuminate\\Contracts\\Routing\\UrlGenerator", "Illuminate\\Routing\\UrlGenerator", "URL", "Illuminate\\Support\\Facades\\URL"], &[0]) {
        return (!in_array).then_some(Kind::Asset);
    }
    if s.function(&["mix"], &[0]) {
        return (!in_array).then_some(Kind::Mix);
    }
    if s.object("Illuminate\\Container\\Attributes\\Storage", &[0])
        || s.facade(&["disk", "fake", "persistentFake", "forgetDisk"], "Storage", &["Illuminate\\Filesystem\\FilesystemManager"], &[0])
    {
        return (!in_array).then_some(Kind::Storage);
    }
    if s.method(&["render", "modal"], &["Inertia\\Inertia", "Inertia\\ResponseFactory"], &[0]) || s.facade(&["inertia"], "Route", ROUTERS, &[1]) || s.function(&["inertia"], &[0]) {
        return (!in_array).then_some(Kind::Inertia);
    }
    if s.function(PATH_HELPERS, &[0]) {
        return (!in_array).then_some(Kind::Path);
    }
    if s.function(&["@vite"], &[0]) {
        return list_ok(Kind::Vite);
    }
    if s.facade(&["asset", "content"], "Vite", &["Illuminate\\Foundation\\Vite"], &[0]) {
        return (!in_array).then_some(Kind::Vite);
    }
    None
}

const PATH_HELPERS: &[&str] = &["base_path", "resource_path", "config_path", "app_path", "database_path", "lang_path", "public_path", "storage_path"];

/// One thing a string can name.
#[derive(Debug, Clone)]
struct Entry {
    key: String,
    kind: CompletionItemKind,
    detail: Option<String>,
    sort: Option<String>,
    /// The file and 1-based line it's declared at.
    target: Option<(PathBuf, u32)>,
    hover: Option<String>,
}

impl Entry {
    fn new(key: impl Into<String>, kind: CompletionItemKind) -> Self {
        Self { key: key.into(), kind, detail: None, sort: None, target: None, hover: None }
    }
}

/// A Markdown link to a file and line.
fn link(path: &Path, line: Option<u32>, label: &str) -> String {
    format!("[{label}]({})", target_uri(path, line).as_str())
}

fn target_uri(path: &Path, line: Option<u32>) -> Uri {
    let uri = path_to_uri(path);
    match line {
        Some(l) => format!("{}#L{}", uri.as_str(), l.max(1)).parse().unwrap_or(uri),
        None => uri,
    }
}

fn str_of(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty())
}

fn line_of(v: &Value) -> u32 {
    v.as_u64().unwrap_or(1).max(1) as u32
}

/// Everything a kind of string can name, or `None` if the facts it needs couldn't be loaded, in which case
/// no problems are reported for it.
fn entries(kind: Kind, data: &Data<'_>) -> Option<Vec<Entry>> {
    Some(match kind {
        Kind::Route => data
            .routes()?
            .as_array()?
            .iter()
            .filter_map(|r| {
                let name = str_of(&r["name"])?;
                let action = r["action"].as_str().unwrap_or("Closure");
                let mut e = Entry::new(name, CompletionItemKind::ENUM);
                e.detail = Some(format!("{action}\n\n[{}] {}", r["method"].as_str().unwrap_or(""), r["uri"].as_str().unwrap_or("")));
                if let Some(file) = str_of(&r["filename"]) {
                    let path = data.abs(file);
                    e.hover = Some(format!("{}\n\n{}", if action == "Closure" { "[Closure]" } else { action }, link(&path, None, file)));
                    e.target = Some((path, line_of(&r["line"])));
                }
                Some(e)
            })
            .collect(),
        Kind::Component => data
            .views()?
            .as_array()?
            .iter()
            .filter(|v| v.get("livewire").is_some_and(|l| !l.is_null()))
            .filter_map(|v| {
                let key = str_of(&v["key"])?;
                let mut e = Entry::new(key.strip_prefix("livewire.").unwrap_or(key), CompletionItemKind::CONSTANT);
                let path = data.abs(str_of(&v["path"])?);
                e.hover = Some(link(&path, None, str_of(&v["path"])?));
                e.target = Some((path, 1));
                Some(e)
            })
            .collect(),
        Kind::View => data
            .views()?
            .as_array()?
            .iter()
            .filter_map(|v| {
                let key = str_of(&v["key"])?;
                let mut e = Entry::new(key, CompletionItemKind::CONSTANT);
                e.sort = Some(format!("{}{key}", if v["isVendor"].as_bool() == Some(true) { 1 } else { 0 }));
                if let Some(p) = str_of(&v["path"]) {
                    let path = data.abs(p);
                    e.hover = Some(link(&path, None, p));
                    e.target = Some((path, 1));
                }
                Some(e)
            })
            .collect(),
        Kind::Config => configs(data)?,
        Kind::Storage => configs(data)?
            .into_iter()
            .filter_map(|mut e| {
                let disk = e.key.strip_prefix("filesystems.disks.")?.to_string();
                e.key = disk;
                e.detail = None;
                e.hover = None;
                Some(e)
            })
            .collect(),
        Kind::Env => {
            let env_path = data.root().join(".env");
            data.env()?
                .as_object()?
                .iter()
                .map(|(key, v)| {
                    let mut e = Entry::new(key, CompletionItemKind::CONSTANT);
                    let value = v["value"].as_str().unwrap_or("");
                    e.detail = Some(value.to_string());
                    e.hover = Some(format!("`{}`", if value.is_empty() { "[empty string]" } else { value }));
                    e.target = Some((env_path.clone(), line_of(&v["line"])));
                    e
                })
                .collect()
        }
        Kind::Translation => {
            let t = data.translations()?;
            let keys = t["keys"].as_object()?;
            let default = t["default"].as_str().unwrap_or("en");
            let few = keys.len() < 200;
            keys.iter()
                .map(|(key, locales)| {
                    let mut e = Entry::new(key, CompletionItemKind::VALUE);
                    let chosen = locales.get(default).or_else(|| locales.as_object().and_then(|o| o.values().next()));
                    if few {
                        e.detail = chosen.and_then(|c| c["value"].as_str()).map(String::from);
                    }
                    if let Some(c) = chosen
                        && let Some(p) = str_of(&c["path"])
                    {
                        e.target = Some((data.abs(p), line_of(&c["line"])));
                    }
                    let hover: Vec<String> = locales
                        .as_object()
                        .into_iter()
                        .flatten()
                        .map(|(locale, c)| {
                            let path = str_of(&c["path"]).unwrap_or("");
                            format!("`{locale}`: {}\n\n{}", c["value"].as_str().unwrap_or(""), link(&data.abs(path), Some(line_of(&c["line"])), path))
                        })
                        .collect();
                    e.hover = Some(hover.join("\n\n"));
                    e
                })
                .collect()
        }
        Kind::Middleware => data
            .middleware()?
            .as_object()?
            .iter()
            .map(|(alias, m)| {
                let mut e = Entry::new(alias, CompletionItemKind::ENUM);
                e.detail = Some(m["parameters"].as_str().unwrap_or("").to_string());
                if let Some(p) = str_of(&m["path"]) {
                    let path = data.abs(p);
                    e.hover = Some(link(&path, Some(line_of(&m["line"])), p));
                    e.target = Some((path, line_of(&m["line"])));
                } else if let Some(groups) = m["groups"].as_array() {
                    let lines: Vec<String> = groups
                        .iter()
                        .map(|g| match str_of(&g["path"]) {
                            Some(p) => link(&data.abs(p), Some(line_of(&g["line"])), p),
                            None => g["class"].as_str().unwrap_or("").to_string(),
                        })
                        .collect();
                    e.hover = Some(lines.join("\n\n"));
                }
                e
            })
            .collect(),
        Kind::Auth => data
            .auth()?
            .get("policies")?
            .as_object()?
            .iter()
            .map(|(ability, policies)| {
                let list = policies.as_array().cloned().unwrap_or_default();
                let mut e = Entry::new(ability, CompletionItemKind::VALUE);
                let classes: Vec<&str> = list.iter().filter_map(|p| p["policy"].as_str()).collect();
                e.detail = Some(classes.join("\n\n"));
                let hover: Vec<String> = list
                    .iter()
                    .filter_map(|p| {
                        let uri = str_of(&p["uri"])?;
                        Some(format!("`{}`\n\n{}", p["policy"].as_str().unwrap_or("Gate"), link(&data.abs(uri), Some(line_of(&p["line"])), uri)))
                    })
                    .collect();
                e.hover = (!hover.is_empty()).then(|| hover.join("\n\n"));
                if let [only] = list.as_slice()
                    && let Some(uri) = str_of(&only["uri"])
                {
                    e.target = Some((data.abs(uri), line_of(&only["line"])));
                }
                e
            })
            .collect(),
        Kind::AppBinding => data
            .app_bindings()?
            .as_object()?
            .iter()
            .map(|(abstract_, b)| {
                let mut e = Entry::new(abstract_, CompletionItemKind::CONSTANT);
                if let Some(p) = str_of(&b["path"]) {
                    let path = data.abs(p);
                    e.hover = Some(format!("`{}`\n\n{}", b["class"].as_str().unwrap_or(""), link(&path, Some(line_of(&b["line"])), p)));
                    e.target = Some((path, line_of(&b["line"])));
                }
                e
            })
            .collect(),
        Kind::Asset => {
            let public = data.root().join("public");
            data.assets()
                .as_array()?
                .iter()
                .filter_map(|p| p.as_str())
                .map(|p| {
                    let mut e = Entry::new(p, CompletionItemKind::CONSTANT);
                    e.target = Some((public.join(p), 1));
                    e
                })
                .collect()
        }
        Kind::Mix => {
            let public = data.root().join("public");
            data.mix()?
                .as_object()?
                .iter()
                .map(|(key, value)| {
                    let mut e = Entry::new(key, CompletionItemKind::VALUE);
                    // The file itself, without the manifest's `?id=` version.
                    let file = key.trim_start_matches('/');
                    e.hover = Some(link(&public.join(file), None, &format!("public/{}", value.as_str().unwrap_or(file).trim_start_matches('/'))));
                    e.target = Some((public.join(file), 1));
                    e
                })
                .collect()
        }
        Kind::Inertia => data.inertia()["pages"]
            .as_object()?
            .iter()
            .map(|(name, path)| {
                let mut e = Entry::new(name, CompletionItemKind::CONSTANT);
                let p = path.as_str().unwrap_or("");
                e.hover = Some(link(&data.abs(p), None, p));
                e.target = Some((data.abs(p), 1));
                e
            })
            .collect(),
        Kind::ControllerAction => data
            .controllers()
            .as_array()?
            .iter()
            .filter_map(|a| a.as_str())
            .map(|a| Entry::new(a, CompletionItemKind::ENUM))
            .collect(),
        Kind::Path => vec![],
        Kind::Vite => data
            .vite_files()
            .as_array()?
            .iter()
            .filter_map(|p| p.as_str())
            .map(|p| {
                let mut e = Entry::new(p, CompletionItemKind::FILE);
                e.target = Some((data.abs(p), 1));
                e
            })
            .collect(),
    })
}

fn configs(data: &Data<'_>) -> Option<Vec<Entry>> {
    Some(
        data.configs()?
            .as_array()?
            .iter()
            .filter_map(|c| {
                let name = str_of(&c["name"])?;
                let mut e = Entry::new(name, CompletionItemKind::VALUE);
                let value = match &c["value"] {
                    Value::String(s) => s.clone(),
                    Value::Null => String::new(),
                    Value::Bool(b) => b.to_string(),
                    Value::Number(n) => n.to_string(),
                    _ => "array(...)".into(),
                };
                if !(value.is_empty() || value == "false" || value == "0") {
                    e.detail = Some(value.clone());
                }
                let mut hover = format!("`{}`", if value.is_empty() && c["value"].is_string() { "[empty string]" } else { &value });
                if let Some(file) = str_of(&c["file"]) {
                    let line = c["line"].as_u64().map(|l| l as u32);
                    hover.push_str(&format!("\n\n{}", link(&data.abs(file), line, file)));
                    e.target = Some((data.abs(file), line.unwrap_or(1)));
                }
                e.hover = Some(hover);
                Some(e)
            })
            .collect(),
    )
}

/// The entry a value names.
fn find<'e>(kind: Kind, entries: &'e [Entry], value: &str) -> Option<&'e Entry> {
    match kind {
        Kind::Translation => {
            let value = value.replace('\\', "");
            let prefix = format!("{value}.");
            entries.iter().find(|e| e.key == value).or_else(|| entries.iter().find(|e| e.key.starts_with(&prefix)))
        }
        Kind::Middleware => {
            let name = value.split(':').next().unwrap_or(value);
            entries.iter().find(|e| e.key == name)
        }
        Kind::Asset => entries.iter().find(|e| e.key == value.trim_start_matches('/')),
        Kind::Mix => entries.iter().find(|e| e.key.trim_start_matches('/') == value.trim_start_matches('/')),
        _ => entries.iter().find(|e| e.key == value),
    }
}

/// The route whose action is `value`. Routes name actions by their full class name, which
/// `HomeController@index` matches by its end.
fn action_route(value: &str, data: &Data<'_>) -> Option<(PathBuf, u32)> {
    let value = value.trim_start_matches('\\');
    let routes = data.routes()?;
    let r = routes.as_array()?.iter().find(|r| r["action"].as_str().is_some_and(|a| a == value || a.ends_with(&format!("\\{value}"))))?;
    Some((data.abs(str_of(&r["filename"])?), line_of(&r["line"])))
}

/// Where the thing a string names is declared.
fn target(kind: Kind, arg: &StringArg, data: &Data<'_>) -> Option<(PathBuf, u32)> {
    match kind {
        Kind::ControllerAction => action_route(&arg.value, data),
        Kind::Path => {
            let paths = data.paths()?;
            let dir = paths.as_array()?.iter().find(|p| p["key"].as_str() == Some(arg.call.name.as_str()))?["path"].as_str()?.to_string();
            let file = Path::new(&dir).join(&arg.value);
            file.is_file().then_some((file, 1))
        }
        Kind::Route if arg.value.contains('*') => None,
        Kind::Vite => {
            let file = data.abs(&arg.value);
            file.is_file().then_some((file, 1))
        }
        // Only when one policy matches the call's model.
        Kind::Auth => match matching_policies(arg, data).as_slice() {
            [only] => Some((data.abs(str_of(&only["uri"])?), line_of(&only["line"]))),
            _ => None,
        },
        Kind::Translation => {
            // The locale argument's, if it's a plain string.
            let t = data.translations()?;
            let value = arg.value.replace('\\', "");
            let keys = t["keys"].as_object()?;
            let locales = keys.get(&value).or_else(|| keys.iter().find(|(k, _)| k.starts_with(&format!("{value}."))).map(|(_, v)| v))?;
            let locale = locale_index(&arg.call.name, arg.call.kind)
                .and_then(|i| arg.call.arguments.get(i).and_then(|a| a.1.clone()))
                .or_else(|| t["default"].as_str().map(String::from));
            let chosen = locale.and_then(|l| locales.get(&l)).or_else(|| locales.as_object().and_then(|o| o.values().next()))?;
            Some((data.abs(str_of(&chosen["path"])?), line_of(&chosen["line"])))
        }
        _ => {
            let entries = entries(kind, data)?;
            find(kind, &entries, &arg.value)?.target.clone()
        }
    }
}

/// The model an ability check is about: `None` when the call needs none (`Gate::has('x')`, or no second
/// argument), else the class of its second argument, `Post::class` or a `$post` the analyzer types, if known.
fn auth_model(arg: &StringArg) -> Option<Option<String>> {
    let call = &arg.call;
    let requires = matches!(call.kind, CallKind::Function | CallKind::Method | CallKind::Static) && call.name != "has" && call.arguments.len() > 1;
    requires.then(|| call.argument_classes.get(1).and_then(|c| c.first().cloned()))
}

/// The policies that define `ability` for the call's model, as `{policy, uri, line, model}`.
fn matching_policies(arg: &StringArg, data: &Data<'_>) -> Vec<Value> {
    let Some(auth) = data.auth() else { return vec![] };
    let all = auth["policies"][arg.value.as_str()].as_array().cloned().unwrap_or_default();
    match auth_model(arg) {
        None => all,
        Some(None) => vec![],
        Some(Some(class)) => {
            let same = |m: &str| m.trim_start_matches('\\').eq_ignore_ascii_case(class.trim_start_matches('\\'));
            all.into_iter().filter(|p| p["model"].as_str().is_some_and(same)).collect()
        }
    }
}

/// Which argument of a translation call holds the locale.
fn locale_index(method: &str, kind: CallKind) -> Option<usize> {
    let function = kind == CallKind::Function;
    match method {
        "__" | "trans" | "@lang" if function => Some(2),
        "trans_choice" if function => Some(3),
        "has" | "hasForLocale" if !function => Some(1),
        "get" | "string" if !function => Some(2),
        "choice" if !function => Some(3),
        _ => None,
    }
}

fn problem(kind: Kind, arg: &StringArg, entries: &[Entry], data: &Data<'_>, codebase: &CodebaseMetadata) -> Option<(&'static str, String)> {
    let v = &arg.value;
    if v.is_empty() || (arg.double_quoted && v.contains('$')) {
        return None;
    }
    let found = match kind {
        Kind::ControllerAction => action_route(v, data).is_some(),
        // A Vite input may be anywhere in the project, not only in `resources/`.
        Kind::Vite => data.abs(v).is_file(),
        _ => find(kind, entries, v).is_some(),
    };
    let (code, message) = match kind {
        Kind::Route if v.contains('*') => return None,
        Kind::Route => ("route", format!("Route [{v}] not found.")),
        Kind::Component => ("route", format!("Component [{v}] not found.")),
        Kind::ControllerAction if !v.contains('@') => return None,
        Kind::ControllerAction => ("controllerAction", format!("Controller/Method [{v}] not found.")),
        Kind::View => ("view", format!("View [{v}] not found.")),
        Kind::Config => ("config", format!("Config [{v}] not found.")),
        Kind::Env => ("env", format!("Env [{v}] not found.")),
        Kind::Translation if !looks_like_translation_key(v) => return None,
        Kind::Translation => ("translation", format!("Translation [{v}] not found.")),
        Kind::Middleware => ("middleware", format!("Middleware [{v}] not found.")),
        // A `Gate::before` hook decides abilities at run time.
        Kind::Auth if data.auth().is_some_and(|a| a["before"] == true) => return None,
        // A known ability that no policy for the call's model defines.
        Kind::Auth if found => {
            let model_known = matches!(auth_model(arg), Some(Some(_)));
            return (model_known && matching_policies(arg, data).is_empty()).then(|| ("auth", format!("Policy/Model match [{v}] not found.")));
        }
        Kind::Auth => ("auth", format!("Policy [{v}] not found.")),
        // A class name needs no binding: the container builds it.
        Kind::AppBinding if codebase.class_like_exists(v.trim_start_matches('\\').as_bytes()) => return None,
        Kind::AppBinding => ("appBinding", format!("App binding [{v}] not found.")),
        Kind::Asset => ("asset", format!("Asset [{v}] not found.")),
        Kind::Mix => ("mix", format!("Mix manifest item [{v}] not found.")),
        Kind::Storage => ("storage_disk", format!("Storage Disk [{v}] not found.")),
        Kind::Inertia => ("inertia", format!("Inertia view [{v}] not found.")),
        Kind::Path => return None,
        Kind::Vite => ("vite", format!("Vite asset [{v}] not found.")),
    };
    (!found).then_some((code, message))
}

/// A dotted key such as `auth.failed` or `pkg::messages.hi`, as opposed to a sentence used as its own key.
fn looks_like_translation_key(v: &str) -> bool {
    let part = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '/'));
    let rest = match v.split_once("::") {
        Some((ns, rest)) if part(ns) => rest,
        Some(_) => return false,
        None => v,
    };
    let parts: Vec<&str> = rest.split('.').collect();
    parts.len() >= 2 && parts.iter().all(|p| part(p))
}

fn is_blade(ctx: &Ctx<'_>) -> bool {
    ctx.doc.language == "blade" || ctx.doc.path.to_string_lossy().ends_with(".blade.php")
}

/// Runs `f` on the file's string arguments: a PHP file's own, or a Blade view's echoes and directives.
fn with_args<R>(ctx: &Ctx<'_>, upto: Option<u32>, f: impl FnOnce(&Ctx<'_>, Vec<StringArg>) -> R) -> R {
    if !is_blade(ctx) {
        let args = match upto {
            Some(offset) => string_arg_at(ctx, offset).into_iter().collect(),
            None => string_args(ctx),
        };
        return f(ctx, args);
    }
    let text = blade::virtual_php(&ctx.doc.text, upto.map_or(ctx.doc.text.len(), |o| o as usize));
    with_text(ctx.snap, ctx.doc.clone(), &text, |v| {
        let mut args = match upto {
            Some(offset) => string_arg_at(v, offset).into_iter().collect(),
            None => string_args(v),
        };
        for a in &mut args {
            if a.call.kind == CallKind::Function
                && let Some(d) = blade::directive_name(&a.call.name)
            {
                a.call.name = d;
            }
        }
        f(v, args)
    })
}

pub fn completion(ctx: &Ctx<'_>, offset: u32) -> Option<Vec<CompletionItem>> {
    let data = Data(&ctx.snap.framework);
    if !data.active() {
        return None;
    }
    if is_blade(ctx)
        && let Some(items) = blade_completion(ctx, &data, offset)
    {
        return Some(items);
    }
    with_args(ctx, Some(offset), |ctx, args| match args.first() {
        Some(arg) => string_completion(ctx, &data, arg, offset),
        None => rules_method_completion(ctx, offset),
    })
    .filter(|items| !items.is_empty())
}

/// Keys to offer while typing a key in a `.env` file: those the project's other `.env*` files assign and those
/// `config/` reads with `env()`, less the ones this file has. Values come only from `.env.example` and `env()`
/// defaults, so a secret in `.env` never lands in a committed file.
pub fn env_file_completion(ctx: &Ctx<'_>, offset: u32) -> Option<Vec<CompletionItem>> {
    let text = &ctx.doc.text;
    let line_start = text[..offset as usize].rfind('\n').map_or(0, |i| i + 1);
    let line = text[line_start..offset as usize].trim_start();
    let typed = line.strip_prefix("export ").map_or(line, str::trim_start);
    if !typed.chars().all(is_env_key_char) {
        return None;
    }
    let root = Data(&ctx.snap.framework).root().to_path_buf();
    let read = |dir: &Path, keep: &dyn Fn(&str) -> bool| -> Vec<(String, String)> {
        let mut files: Vec<_> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| keep(&e.file_name().to_string_lossy()) && e.path() != ctx.doc.path)
            .filter_map(|e| Some((e.file_name().to_string_lossy().into_owned(), std::fs::read_to_string(e.path()).ok()?)))
            .collect();
        // `.env.example` first: its values are the ones to offer.
        files.sort_by_key(|(name, _)| (name != ".env.example", name.clone()));
        files
    };
    let envs = read(&root, &|n| n.starts_with(".env"));
    let configs = read(&root.join("config"), &|n| n.ends_with(".php"));
    let range = ctx.doc.range(offset - typed.len() as u32, offset);
    let items: Vec<_> = env_candidates(text, &envs, &configs)
        .into_iter()
        .map(|(key, value, source)| CompletionItem {
            detail: Some(if value.is_empty() { source } else { format!("{value} ({source})") }),
            text_edit: Some(CompletionTextEdit::Edit(TextEdit { range, new_text: format!("{key}={value}") })),
            ..completion_item(&key, Some(CompletionItemKind::CONSTANT), range)
        })
        .collect();
    (!items.is_empty()).then_some(items)
}

/// Where the project reads the `.env` key under the cursor with `env('KEY')`, for ⌘-click on the key.
// ponytail: walks the project's PHP files from disk on each request; read the index's file list if it's slow.
pub fn env_key_usages(ctx: &Ctx<'_>, offset: u32) -> Vec<Location> {
    let text = &ctx.doc.text;
    let line_start = text[..offset as usize].rfind('\n').map_or(0, |i| i + 1);
    let line = text[line_start..].lines().next().unwrap_or("");
    let Some((key, _)) = env_assignments(line).next() else { return vec![] };
    let key_start = line_start + line.find(key).unwrap_or(0);
    if !(key_start..=key_start + key.len()).contains(&(offset as usize)) {
        return vec![];
    }
    let root = Data(&ctx.snap.framework).root().to_path_buf();
    let skip = ["vendor", "node_modules", "storage", "bootstrap"];
    let mut out = vec![];
    let walker = ignore::WalkBuilder::new(&root).filter_entry(move |e| !skip.iter().any(|s| e.file_name() == *s)).build();
    for entry in walker.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "php") {
            continue;
        }
        let Ok(php) = std::fs::read_to_string(path) else { continue };
        for (line_no, line) in php.lines().enumerate() {
            for (at, found, _) in env_calls(line) {
                if found == key {
                    let col = line[..at].encode_utf16().count() as u32;
                    let range = Range { start: Position::new(line_no as u32, col), end: Position::new(line_no as u32, col + key.len() as u32) };
                    out.push(Location { uri: path_to_uri(path), range });
                }
            }
        }
    }
    out.sort_by(|a, b| a.uri.as_str().cmp(b.uri.as_str()).then(a.range.start.line.cmp(&b.range.start.line)));
    out
}

fn is_env_key_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '.'
}

/// The assignments in `.env` text, as key and raw value.
fn env_assignments(text: &str) -> impl Iterator<Item = (&str, &str)> {
    text.lines().filter_map(|l| {
        let l = l.trim();
        let l = l.strip_prefix("export ").map_or(l, str::trim_start);
        let (key, value) = l.split_once('=')?;
        (!l.starts_with('#') && !key.trim().is_empty()).then(|| (key.trim(), value.trim()))
    })
}

/// The keys PHP reads with `env('KEY')`: each key's offset, the key, and the default when it's a quoted word.
fn env_calls(php: &str) -> Vec<(usize, &str, &str)> {
    let mut out = vec![];
    for (at, _) in php.match_indices("env(") {
        let after_paren = &php[at + 4..];
        let rest = after_paren.trim_start();
        let Some(q) = rest.chars().next().filter(|c| *c == '\'' || *c == '"') else { continue };
        let Some((key, after)) = rest[1..].split_once(q) else { continue };
        let default = after
            .trim_start()
            .strip_prefix(',')
            .map(str::trim_start)
            .and_then(|a| a.chars().next().filter(|c| *c == '\'' || *c == '"').and_then(|d| a[1..].split_once(d)).map(|(v, _)| v))
            .filter(|v| !v.contains(char::is_whitespace))
            .unwrap_or("");
        if !key.is_empty() && key.chars().all(is_env_key_char) {
            out.push((php.len() - rest.len() + 1, key, default));
        }
    }
    out
}

/// `(key, value, source)` for the keys other `.env*` files and `env()` calls name that `current` doesn't assign.
fn env_candidates(current: &str, envs: &[(String, String)], configs: &[(String, String)]) -> Vec<(String, String, String)> {
    let mut seen: std::collections::HashSet<String> = env_assignments(current).map(|(k, _)| k.to_string()).collect();
    let mut out = vec![];
    for (name, text) in envs {
        for (key, value) in env_assignments(text) {
            if seen.insert(key.to_string()) {
                let value = if name == ".env.example" { value } else { "" };
                out.push((key.to_string(), value.to_string(), name.clone()));
            }
        }
    }
    for (name, text) in configs {
        for (_, key, default) in env_calls(text) {
            if seen.insert(key.to_string()) {
                out.push((key.to_string(), default.to_string(), format!("config/{name}")));
            }
        }
    }
    out
}

/// The range completions replace: the word being typed in the string, up to the cursor.
fn replacement(ctx: &Ctx<'_>, arg_start: u32, offset: u32) -> Range {
    let text = &ctx.doc.text[arg_start as usize..offset as usize];
    let len: usize = text.chars().rev().take_while(|c| c.is_alphanumeric() || "-_.:\\/@".contains(*c)).map(char::len_utf8).sum();
    ctx.doc.range(offset - len as u32, offset)
}

fn completion_item(label: &str, kind: Option<CompletionItemKind>, range: Range) -> CompletionItem {
    CompletionItem {
        label: label.to_string(),
        kind,
        text_edit: Some(CompletionTextEdit::Edit(TextEdit { range, new_text: label.to_string() })),
        ..Default::default()
    }
}

fn string_completion(ctx: &Ctx<'_>, data: &Data<'_>, arg: &StringArg, offset: u32) -> Option<Vec<CompletionItem>> {
    let range = replacement(ctx, arg.start, offset);
    let codebase = &ctx.index.codebase;
    let simple = |labels: Vec<String>, kind| Some(labels.iter().map(|l| completion_item(l, Some(kind), range)).collect::<Vec<_>>());

    if let Some(items) = eloquent_completion(ctx, data, arg, range) {
        return Some(items);
    }
    let first_arg = arg.call.arguments.first().and_then(|a| a.1.clone());
    // Route parameters: `route('post.show', ['` offers the route's parameters.
    if arg.index == 1 && arg.in_array == Some(InArray::Key) && (arg.call.is_function(&["route", "signedRoute", "to_route", "temporarySignedRoute"]) || arg.call.is_method(&["route", "signedRoute", "temporarySignedRoute"]))
        && let Some(name) = &first_arg
    {
        let routes = data.routes()?;
        let route = routes.as_array()?.iter().find(|r| r["name"].as_str() == Some(name))?;
        let params = route["parameters"].as_array()?.iter().filter_map(|p| p.as_str().map(String::from)).collect();
        return simple(params, CompletionItemKind::VARIABLE);
    }
    if is_validation(arg, codebase) {
        return Some(rule_items(range));
    }
    // Translation parameters and locales.
    let translation_call = arg.call.is_function(&["__", "trans", "trans_choice", "@lang"])
        || arg.call.on(codebase, TRANSLATORS)
        || arg.call.on(codebase, &facade("Lang").iter().map(String::as_str).collect::<Vec<_>>());
    if translation_call && arg.index > 0 {
        let t = data.translations()?;
        let params_index = if arg.call.name == "trans_choice" || arg.call.name == "choice" { 2 } else { 1 };
        if arg.index == params_index && arg.in_array == Some(InArray::Key) {
            let key = first_arg.as_deref()?;
            let default = t["default"].as_str().unwrap_or("en");
            let params = t["keys"][key][default]["params"].as_array()?.iter().filter_map(|p| p.as_str().map(String::from)).collect();
            return simple(params, CompletionItemKind::VARIABLE);
        }
        let named_locale = arg.call.arguments.get(arg.index.saturating_sub(1)).and_then(|a| a.0.as_deref()) == Some("locale") || arg.name.as_deref() == Some("locale");
        if Some(arg.index) == locale_index(&arg.call.name, arg.call.kind) || named_locale {
            let langs = t["languages"].as_array()?.iter().filter_map(|l| l.as_str().map(String::from)).collect();
            return simple(langs, CompletionItemKind::VALUE);
        }
    }
    // Inertia page props: `Inertia::render('Users/Show', ['`.
    if arg.index == 1 && arg.in_array == Some(InArray::Key) && (arg.call.is_method(&["render", "modal"]) || arg.call.is_function(&["inertia"]))
        && let Some(page) = &first_arg
    {
        let pages = data.inertia();
        let path = data.abs(pages["pages"][page.as_str()].as_str()?);
        let props = inertia_props(&std::fs::read_to_string(path).ok()?);
        return simple(props, CompletionItemKind::CONSTANT);
    }

    let kind = kind_of(arg, codebase)?;
    let mut entries = entries(kind, data)?;
    if kind == Kind::Storage {
        entries.retain(|e| !e.key.contains('.'));
    }
    Some(
        entries
            .into_iter()
            .map(|e| {
                let mut item = completion_item(&e.key, Some(e.kind), range);
                item.detail = e.detail.filter(|d| !d.is_empty());
                item.sort_text = e.sort;
                if kind == Kind::Translation && e.key.contains(if arg.double_quoted { '"' } else { '\'' }) {
                    let q = if arg.double_quoted { "\"" } else { "'" };
                    item.text_edit = Some(CompletionTextEdit::Edit(TextEdit { range, new_text: e.key.replace(q, &format!("\\{q}")) }));
                }
                item
            })
            .collect(),
    )
}

/// Whether a string is a validation rule: a rules array passed to `validate()` or `Validator::make()`.
fn is_validation(arg: &StringArg, codebase: &CodebaseMetadata) -> bool {
    if matches!(arg.in_array, Some(InArray::Key)) {
        return false;
    }
    let request = ["Illuminate\\Http\\Request", "Request", "Illuminate\\Support\\Facades\\Request"];
    let validators = ["Validator", "Illuminate\\Support\\Facades\\Validator", "Illuminate\\Contracts\\Validation\\Factory", "Illuminate\\Contracts\\Validation\\Validator", "Illuminate\\Validation\\Factory", "Illuminate\\Validation\\Validator"];
    let s = Site { arg, codebase };
    s.method(&["validate", "validateWithBag"], &request, &[0])
        || s.function(&["validator"], &[1])
        || s.method(&["validate", "make", "sometimes"], &validators, &[1])
}

fn rule_items(range: Range) -> Vec<CompletionItem> {
    tables::RULES
        .iter()
        .map(|(label, snippet)| CompletionItem {
            label: label.to_string(),
            kind: Some(CompletionItemKind::ENUM),
            insert_text_format: Some(InsertTextFormat::SNIPPET),
            text_edit: Some(CompletionTextEdit::Edit(TextEdit { range, new_text: snippet.to_string() })),
            ..Default::default()
        })
        .collect()
}

/// Validation rules in a `rules()` method of a form request or Livewire form, which returns them rather than
/// passing them to a call.
fn rules_method_completion(ctx: &Ctx<'_>, offset: u32) -> Option<Vec<CompletionItem>> {
    let path = ctx.parsed.path_at(offset);
    let literal = path.iter().rev().find_map(|n| match n {
        Node::LiteralString(s) if s.span.start.offset < offset && offset < s.span.end.offset => Some(*s),
        _ => None,
    })?;
    let in_rules = path.iter().any(|n| matches!(n, Node::Method(m) if m.name.value == b"rules"));
    let is_key = path.iter().any(|n| matches!(n, Node::KeyValueArrayElement(el) if el.key.span().start.offset == literal.span.start.offset));
    if !in_rules || is_key {
        return None;
    }
    let class = ctx.resolver().enclosing_class(&path)?;
    let codebase = &ctx.index.codebase;
    let form = ["Illuminate\\Foundation\\Http\\FormRequest", "Livewire\\Form"].iter().any(|p| codebase.is_instance_of(class.as_bytes(), p.as_bytes()));
    form.then(|| rule_items(replacement(ctx, literal.span.start.offset + 1, offset)))
}

/// The props a Vue page declares with `defineProps`.
fn inertia_props(source: &str) -> Vec<String> {
    let Some(at) = source.find("defineProps") else { return vec![] };
    let rest = &source[at + "defineProps".len()..];
    let Some(open) = rest.find('{') else { return vec![] };
    let mut depth = 0;
    let mut body_end = rest.len();
    for (i, c) in rest[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    body_end = open + i;
                    break;
                }
            }
            _ => {}
        }
    }
    let body = &rest[open + 1..body_end];
    // Top-level members, split on `;`, `,`, or line breaks.
    let mut out = vec![];
    let mut depth = 0;
    let mut member = String::new();
    for c in body.chars().chain(std::iter::once(';')) {
        match c {
            '{' | '(' | '[' | '<' => depth += 1,
            '}' | ')' | ']' | '>' => depth -= 1,
            ';' | ',' | '\n' if depth == 0 => {
                if let Some((name, _)) = member.split_once(':') {
                    let name = name.trim().trim_end_matches('?').trim_matches(|c| c == '\'' || c == '"');
                    if !name.is_empty() && !out.iter().any(|n: &String| n == name) {
                        out.push(name.to_string());
                    }
                }
                member.clear();
                continue;
            }
            _ => {}
        }
        member.push(c);
    }
    out
}

/// The methods whose first argument names a relation.
const RELATION_METHODS: &[&str] = &[
    "doesntHave", "doesntHaveMorph", "has", "hasMorph", "orDoesntHave", "orDoesntHaveMorph", "orHas", "orHasMorph", "orWhereDoesntHave",
    "orWhereDoesntHaveMorph", "orWhereHas", "orWhereHasMorph", "whereDoesntHave", "whereDoesntHaveMorph", "whereHas", "whereHasMorph", "with",
    "withAggregate", "withAvg", "withCount", "withMax", "withMin", "withSum", "load", "loadMissing",
];

fn model_named<'m>(models: &'m serde_json::Map<String, Value>, class: &str) -> Option<&'m Value> {
    let class = class.trim_start_matches('\\');
    models.iter().find(|(k, _)| k.trim_start_matches('\\').eq_ignore_ascii_case(class)).map(|(_, v)| v)
}

/// The model a query call works on: the receiver when it's a model, the model a `Builder<User>`,
/// `HasMany<Post, User>`, or collection is of, or, inside a closure passed to a relation method such as
/// `whereHas('author', fn ($q) => $q->where('…'))`, the relation's related model.
fn model_of<'m>(ctx: &Ctx<'_>, models: &'m serde_json::Map<String, Value>, call: &crate::framework::Call, at: u32, depth: u8) -> Option<&'m Value> {
    if let Some(m) = call.classes.iter().chain(&call.type_args).find_map(|c| model_named(models, c)) {
        return Some(m);
    }
    if depth > 4 {
        return None;
    }
    let path = ctx.parsed.path_at(at);
    let closure = path.iter().rposition(|n| matches!(n, Node::Closure(_) | Node::ArrowFunction(_)))?;
    let (i, outer_node) = path[..closure].iter().enumerate().rev().find(|(_, n)| {
        matches!(n, Node::MethodCall(_) | Node::NullSafeMethodCall(_) | Node::StaticMethodCall(_))
    })?;
    let outer = crate::framework::call_of(ctx, outer_node, &path[..=i])?;
    if !outer.is_method(RELATION_METHODS) {
        return None;
    }
    let relation = outer.arguments.first()?.1.clone()?;
    let mut model = model_of(ctx, models, &outer, outer.span.0, depth + 1)?;
    // `author.posts` walks from relation to relation.
    for name in relation.split('.') {
        let related = model["relations"].as_array()?.iter().find(|r| r["name"].as_str() == Some(name))?["related"].as_str()?;
        model = model_named(models, related)?;
    }
    Some(model)
}

/// Attribute and relation names for Eloquent calls such as `User::where('` or `->with('`.
fn eloquent_completion(ctx: &Ctx<'_>, data: &Data<'_>, arg: &StringArg, range: Range) -> Option<Vec<CompletionItem>> {
    const RELATION: &[&str] = RELATION_METHODS;
    const FIRST: &[&str] = &["create", "fill", "firstWhere", "make", "max", "orderBy", "orderByDesc", "orWhere", "select", "sum", "update", "where", "whereColumn", "whereIn", "whereNotIn", "whereNull", "whereNotNull", "pluck", "value", "latest", "oldest", "min", "avg", "increment", "decrement", "groupBy"];
    const ANY: &[&str] = &["createOrFirst", "firstOrNew", "firstOrCreate", "updateOrCreate"];
    let method = arg.call.name.as_str();
    let relevant = matches!(arg.call.kind, CallKind::Method | CallKind::Static) && (RELATION.contains(&method) || FIRST.contains(&method) || ANY.contains(&method));
    if !relevant {
        return None;
    }
    let models = data.models()?;
    let models = models["models"].as_object()?;
    let model = model_of(ctx, models, &arg.call, arg.start, 0)?;
    let attrs = |fillable_only: bool| -> Vec<String> {
        model["attributes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| !fillable_only || a["fillable"].as_bool() == Some(true))
            .filter(|a| fillable_only || !matches!(a["cast"].as_str(), Some("accessor" | "attribute")))
            .filter_map(|a| a["name"].as_str().map(String::from))
            .collect()
    };
    let (labels, kind): (Vec<String>, _) = if RELATION.contains(&method) {
        if arg.index != 0 || matches!(arg.in_array, Some(InArray::Value(_))) {
            return None;
        }
        let relations = model["relations"].as_array().into_iter().flatten().filter_map(|r| r["name"].as_str().map(String::from)).collect();
        (relations, CompletionItemKind::VALUE)
    } else if ANY.contains(&method) {
        (attrs(arg.index != 0), CompletionItemKind::FIELD)
    } else if arg.index > 0 {
        return None;
    } else if ["create", "make", "fill", "update"].contains(&method) {
        if arg.in_array != Some(InArray::Key) {
            return None;
        }
        (attrs(true), CompletionItemKind::FIELD)
    } else {
        (attrs(false), CompletionItemKind::FIELD)
    };
    let mut seen = std::collections::HashSet::new();
    Some(labels.into_iter().filter(|l| seen.insert(l.clone())).map(|l| completion_item(&l, Some(kind), range)).collect())
}

/// Blade components after `<x-` or a registered prefix, Livewire components after `<livewire:`, and
/// directives after `@`.
fn blade_completion(ctx: &Ctx<'_>, data: &Data<'_>, offset: u32) -> Option<Vec<CompletionItem>> {
    let text = &ctx.doc.text[..offset as usize];
    let line = &text[text.rfind('\n').map_or(0, |i| i + 1)..];
    let token_len: usize = line.chars().rev().take_while(|c| c.is_alphanumeric() || "-_.:\\/@".contains(*c)).map(char::len_utf8).sum();
    let token = &line[line.len() - token_len..];
    let before_token = &line[..line.len() - token_len];
    let range_from = |start: usize| ctx.doc.range(start as u32, offset);

    if before_token.ends_with('<') {
        if let Some(name) = token.strip_prefix("livewire:") {
            let _ = name;
            let entries = entries(Kind::Component, data)?;
            let start = offset as usize - token_len + "livewire:".len();
            return Some(entries.iter().map(|e| completion_item(&e.key, Some(CompletionItemKind::CONSTANT), range_from(start))).collect());
        }
        let components = data.blade_components()?;
        let prefixes: Vec<String> = components["prefixes"].as_array().into_iter().flatten().filter_map(|p| p.as_str().map(String::from)).collect();
        let starts_component = token.starts_with('x') || prefixes.iter().any(|p| token.starts_with(p.as_str()) || p.starts_with(token));
        if !starts_component {
            return None;
        }
        let items = components["components"]
            .as_object()?
            .keys()
            .map(|key| {
                let label = if key.contains("::") || !key.contains(':') { format!("x-{key}") } else { key.clone() };
                completion_item(&label, None, range_from(offset as usize - token_len))
            })
            .collect();
        return Some(items);
    }
    if token.starts_with('@') {
        let range = range_from(offset as usize - token_len);
        let mut items: Vec<CompletionItem> = tables::DIRECTIVES
            .iter()
            .map(|(label, snippet)| CompletionItem {
                label: label.to_string(),
                kind: Some(CompletionItemKind::KEYWORD),
                insert_text_format: Some(InsertTextFormat::SNIPPET),
                text_edit: Some(CompletionTextEdit::Edit(TextEdit { range, new_text: snippet.to_string() })),
                ..Default::default()
            })
            .collect();
        if let Some(custom) = data.blade_directives() {
            for d in custom.as_array().into_iter().flatten() {
                let Some(name) = d["name"].as_str() else { continue };
                let params = d["hasParams"].as_bool() == Some(true);
                items.push(CompletionItem {
                    label: format!("@{name}{}", if params { "(...)" } else { "" }),
                    kind: Some(CompletionItemKind::KEYWORD),
                    insert_text_format: Some(InsertTextFormat::SNIPPET),
                    text_edit: Some(CompletionTextEdit::Edit(TextEdit { range, new_text: format!("@{name}{}", if params { "(${1})" } else { "" }) })),
                    ..Default::default()
                });
            }
        }
        return Some(items);
    }
    None
}

/// The app's Blade components, as `blade-components.php` reports them, or `None` outside a Laravel app or when PHP
/// fails.
pub fn blade_components(state: &crate::framework::State) -> Option<std::sync::Arc<Value>> {
    let data = Data(state);
    data.active().then(|| data.blade_components()).flatten()
}

/// The component or Livewire tag at `offset`, with its span.
fn tag_at(ctx: &Ctx<'_>, data: &Data<'_>, offset: u32) -> Option<(u32, u32, String, bool)> {
    let text = &ctx.doc.text;
    let line_start = text[..offset as usize].rfind('\n').map_or(0, |i| i + 1);
    let line_end = text[offset as usize..].find('\n').map_or(text.len(), |i| offset as usize + i);
    let prefixes: Vec<String> = data
        .blade_components()
        .map(|c| c["prefixes"].as_array().into_iter().flatten().filter_map(|p| p.as_str().map(String::from)).collect())
        .unwrap_or_default();
    blade::tags(&text[line_start..line_end], &prefixes)
        .into_iter()
        .map(|(s, e, name, livewire)| ((line_start + s) as u32, (line_start + e) as u32, name, livewire))
        .find(|(s, e, _, _)| *s <= offset && offset <= *e)
}

/// A component's files and hover.
fn component(data: &Data<'_>, name: &str, livewire: bool) -> Option<(Option<PathBuf>, String)> {
    if livewire {
        let views = data.views()?;
        let v = views.as_array()?.iter().find(|v| {
            let key = v["key"].as_str().unwrap_or("");
            key == format!("livewire.{name}") || (key == name && v.get("livewire").is_some_and(|l| !l.is_null()))
        })?;
        let path = data.abs(str_of(&v["path"])?);
        let mut hover: Vec<String> = v["livewire"]["files"].as_array().into_iter().flatten().filter_map(|f| f.as_str()).map(|f| link(&data.abs(f), None, f)).collect();
        let props: Vec<String> = v["livewire"]["props"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|p| {
                let default = if p["hasDefaultValue"].as_bool() == Some(true) { format!(" = {}", value_text(&p["defaultValue"])) } else { String::new() };
                format!("{} ${}{default};", p["type"].as_str().unwrap_or("mixed"), p["name"].as_str().unwrap_or(""))
            })
            .collect();
        if !props.is_empty() {
            hover.push(format!("```php\n<?php\n{}\n```", props.join("\n")));
        }
        return Some((Some(path), hover.join("\n\n")));
    }
    let components = data.blade_components()?;
    let c = components["components"].get(name)?;
    let paths: Vec<&str> = c["paths"].as_array().into_iter().flatten().filter_map(|p| p.as_str()).collect();
    let target = paths.iter().find(|p| p.ends_with(".blade.php")).or(paths.first()).map(|p| data.abs(p));
    let mut hover: Vec<String> = paths.iter().map(|p| link(&data.abs(p), None, p)).collect();
    match &c["props"] {
        Value::String(s) => hover.push(format!("```blade\n{s}\n```")),
        Value::Array(props) => {
            for p in props {
                let default = p.get("default").map(|d| format!(" = {}", value_text(d))).unwrap_or_default();
                hover.push(format!("`{}` `{}`{default}", p["type"].as_str().unwrap_or("mixed"), p["name"].as_str().unwrap_or("")));
            }
        }
        _ => {}
    }
    Some((target, hover.join("\n\n")))
}

fn value_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

pub fn definition(ctx: &Ctx<'_>, offset: u32) -> Vec<Location> {
    let data = Data(&ctx.snap.framework);
    if !data.active() {
        return vec![];
    }
    let to_location = |(path, line): (PathBuf, u32)| {
        let pos = Position::new(line.saturating_sub(1), 0);
        Location { uri: path_to_uri(&path), range: Range { start: pos, end: pos } }
    };
    if is_blade(ctx)
        && let Some((_, _, name, livewire)) = tag_at(ctx, &data, offset)
    {
        return component(&data, &name, livewire).and_then(|(t, _)| t).map(|p| vec![to_location((p, 1))]).unwrap_or_default();
    }
    with_args(ctx, None, |ctx, args| {
        args.iter()
            .filter(|a| a.start <= offset && offset <= a.end)
            .filter_map(|a| target(kind_of(a, &ctx.index.codebase)?, a, &data))
            .map(to_location)
            .collect()
    })
}

pub fn hover(ctx: &Ctx<'_>, offset: u32) -> Option<Hover> {
    let data = Data(&ctx.snap.framework);
    if !data.active() {
        return None;
    }
    let markdown = |value: String, range: Range| Hover {
        contents: HoverContents::Markup(MarkupContent { kind: MarkupKind::Markdown, value }),
        range: Some(range),
    };
    if is_blade(ctx)
        && let Some((s, e, name, livewire)) = tag_at(ctx, &data, offset)
    {
        let (_, text) = component(&data, &name, livewire)?;
        return Some(markdown(text, ctx.doc.range(s, e)));
    }
    with_args(ctx, None, |ctx, args| {
        let arg = args.iter().find(|a| a.start <= offset && offset <= a.end)?;
        let kind = kind_of(arg, &ctx.index.codebase)?;
        let entries = entries(kind, &data)?;
        let found = find(kind, &entries, &arg.value)?;
        let text = if kind == Kind::Auth {
            let lines: Vec<String> = matching_policies(arg, &data)
                .iter()
                .filter_map(|p| {
                    let uri = str_of(&p["uri"])?;
                    Some(format!("`{}`\n\n{}", p["policy"].as_str().unwrap_or("Gate"), link(&data.abs(uri), Some(line_of(&p["line"])), uri)))
                })
                .collect();
            (!lines.is_empty()).then(|| lines.join("\n\n"))?
        } else {
            found.hover.clone()?
        };
        Some(markdown(text, ctx.doc.range(arg.start, arg.end)))
    })
}

pub fn diagnostics(ctx: &Ctx<'_>) -> Vec<Diagnostic> {
    let data = Data(&ctx.snap.framework);
    if !data.active() {
        return vec![];
    }
    with_args(ctx, None, |ctx, args| {
        let codebase = &ctx.index.codebase;
        let mut cache: Vec<(Kind, Option<Vec<Entry>>)> = vec![];
        let mut out = vec![];
        for arg in &args {
            let Some(kind) = kind_of(arg, codebase) else { continue };
            if !cache.iter().any(|(k, _)| *k == kind) {
                cache.push((kind, entries(kind, &data)));
            }
            let Some((_, Some(entries))) = cache.iter().find(|(k, _)| *k == kind) else { continue };
            if let Some((code, message)) = problem(kind, arg, entries, &data, codebase) {
                out.push(Diagnostic {
                    range: ctx.doc.range(arg.start, arg.end),
                    severity: Some(DiagnosticSeverity::WARNING),
                    code: Some(NumberOrString::String(code.into())),
                    source: Some(SOURCE.into()),
                    message,
                    ..Default::default()
                });
            }
        }
        out
    })
}

pub fn document_links(ctx: &Ctx<'_>) -> Vec<DocumentLink> {
    let data = Data(&ctx.snap.framework);
    if !data.active() {
        return vec![];
    }
    let mut out: Vec<DocumentLink> = with_args(ctx, None, |ctx, args| {
        args.iter()
            .filter_map(|a| {
                let (path, line) = target(kind_of(a, &ctx.index.codebase)?, a, &data)?;
                Some(DocumentLink { range: ctx.doc.range(a.start, a.end), target: Some(target_uri(&path, Some(line))), tooltip: None, data: None })
            })
            .collect()
    });
    if is_blade(ctx) {
        let prefixes: Vec<String> = data
            .blade_components()
            .map(|c| c["prefixes"].as_array().into_iter().flatten().filter_map(|p| p.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let mut line_start = 0;
        for line in ctx.doc.text.split('\n') {
            for (s, e, name, livewire) in blade::tags(line, &prefixes) {
                if let Some((Some(path), _)) = component(&data, &name, livewire) {
                    let range = ctx.doc.range((line_start + s) as u32, (line_start + e) as u32);
                    out.push(DocumentLink { range, target: Some(path_to_uri(&path)), tooltip: None, data: None });
                }
            }
            line_start += line.len() + 1;
        }
    }
    out
}

#[allow(dead_code)]
pub fn code_lenses(_ctx: &Ctx<'_>) -> Vec<lsp_types::CodeLens> {
    vec![]
}

#[cfg(test)]
mod tests;
