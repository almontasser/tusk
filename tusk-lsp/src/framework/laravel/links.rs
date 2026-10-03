//! Code lenses that link a class to the classes Laravel pairs it with and to where it's used: an event to its
//! listeners and the places that dispatch it, a listener to its events, a model to its observers and policy,
//! and a job, notification, or mailable to the places that dispatch or send it. They come from the project's
//! [`facts`](super::facts), so they need no booted app.

use std::path::{Path, PathBuf};

use lsp_types::{CodeLens, Command, Position, Range};
use mago_codex::metadata::CodebaseMetadata;
use mago_syntax::cst::Node;
use serde_json::Value;

use super::facts::{Fact, Site, facts};
use crate::features::Ctx;
use crate::locate::walk;
use crate::symbol::Symbol;
use crate::text::path_to_uri;

/// How many places a lens lists one by one; past it, one more lens says how many are left.
const SITES: usize = 4;

fn short(fqn: &str) -> &str {
    fqn.rsplit('\\').next().unwrap_or(fqn)
}

fn same(a: &str, b: &str) -> bool {
    a.trim_start_matches('\\').eq_ignore_ascii_case(b.trim_start_matches('\\'))
}

/// A lens that opens `path` at the 1-based `line`.
fn lens(line: u32, title: String, path: &Path, target: u32) -> CodeLens {
    let pos = Position::new(line, 0);
    CodeLens {
        range: Range { start: pos, end: pos },
        command: Some(Command {
            title,
            command: "phpEditor.open".into(),
            arguments: Some(vec![Value::String(path_to_uri(path).as_str().to_string()), Value::from(target)]),
        }),
        data: None,
    }
}

/// Where a class is declared: its file and the 1-based line of its name.
fn class_place(ctx: &Ctx<'_>, class: &str) -> Option<(PathBuf, u32)> {
    let place = crate::locate::declaration(&Symbol::Class(class.to_string()), &ctx.index.codebase)?;
    let location = ctx.snap.location(&ctx.index, place)?;
    Some((crate::text::uri_to_path(&location.uri)?, location.range.start.line + 1))
}

/// Whether `class` is something Laravel dispatches or sends: a notification, a mailable, a queued job, a
/// broadcast event, or a class with Laravel's dispatching traits.
fn dispatchable(codebase: &CodebaseMetadata, class: &str) -> bool {
    let is = |parent: &str| codebase.is_instance_of(class.as_bytes(), parent.as_bytes());
    let uses = |t: &str| codebase.class_uses_trait(class.as_bytes(), t.as_bytes());
    sends(codebase, class)
        || is("Illuminate\\Contracts\\Queue\\ShouldQueue")
        || is("Illuminate\\Contracts\\Broadcasting\\ShouldBroadcast")
        || ["Illuminate\\Foundation\\Bus\\Dispatchable", "Illuminate\\Foundation\\Events\\Dispatchable", "Illuminate\\Bus\\Queueable", "Illuminate\\Foundation\\Queue\\Queueable"]
            .iter()
            .any(|t| uses(t))
}

/// Whether `class` is sent rather than dispatched: a notification or a mailable.
fn sends(codebase: &CodebaseMetadata, class: &str) -> bool {
    ["Illuminate\\Notifications\\Notification", "Illuminate\\Mail\\Mailable"].iter().any(|p| codebase.is_instance_of(class.as_bytes(), p.as_bytes()))
}

fn is_model(codebase: &CodebaseMetadata, class: &str) -> bool {
    codebase.is_instance_of(class.as_bytes(), b"Illuminate\\Database\\Eloquent\\Model")
}

/// The policies Laravel guesses for a model when nothing names one: `App\Policies\PostPolicy` and
/// `App\Models\Policies\PostPolicy` for `App\Models\Post`.
fn guessed_policies(model: &str) -> Vec<String> {
    let (dir, name) = model.rsplit_once('\\').unwrap_or(("", model));
    let mut out = vec![format!("{dir}\\Policies\\{name}Policy")];
    if let Some((app, _)) = model.split_once("\\Models\\") {
        out.insert(0, format!("{app}\\Policies\\{name}Policy"));
    }
    out
}

/// The first class the document declares, with the 0-based line of its name.
fn first_class(ctx: &Ctx<'_>) -> Option<(String, u32)> {
    let mut found = None;
    walk(&ctx.parsed, |node, _| {
        if found.is_none()
            && let Node::Class(c) = node
            && let Some(name) = ctx.parsed.names.resolve(&c.name.span)
        {
            found = Some((String::from_utf8_lossy(name).trim_start_matches('\\').to_string(), ctx.doc.position(c.name.span.start.offset).line));
        }
    });
    found
}

pub fn code_lenses(ctx: &Ctx<'_>) -> Vec<CodeLens> {
    if !super::Data(&ctx.snap.framework).active() || super::is_blade(ctx) {
        return vec![];
    }
    let Some((class, line)) = first_class(ctx) else { return vec![] };
    let facts = facts(ctx.snap, &ctx.index);
    let codebase = &ctx.index.codebase;
    let discovery = !facts.iter().any(|(f, _)| *f == Fact::NoDiscovery);
    let mut out: Vec<CodeLens> = vec![];
    let mut seen: Vec<String> = vec![];
    // A lens to another class, once per title.
    let mut to_class = |out: &mut Vec<CodeLens>, title: String, other: &str| {
        if seen.contains(&title) {
            return;
        }
        if let Some((path, target)) = class_place(ctx, other) {
            out.push(lens(line, title.clone(), &path, target));
            seen.push(title);
        }
    };
    let mut closures: Vec<&Site> = vec![];
    for (fact, site) in facts.iter() {
        match fact {
            Fact::Listen { event, listener, discovered } if same(event, &class) && (discovery || !discovered) => match listener {
                Some(l) => to_class(&mut out, format!("Listener: {}", short(l)), l),
                None => closures.push(site),
            },
            Fact::Listen { event, listener: Some(l), discovered } if same(l, &class) && (discovery || !discovered) => {
                to_class(&mut out, format!("Listens to: {}", short(event)), event)
            }
            Fact::Observe { model, observer } if same(model, &class) => to_class(&mut out, format!("Observer: {}", short(observer)), observer),
            Fact::Observe { model, observer } if same(observer, &class) => to_class(&mut out, format!("Observes: {}", short(model)), model),
            Fact::Policy { model, policy } if same(model, &class) => to_class(&mut out, format!("Policy: {}", short(policy)), policy),
            Fact::Policy { model, policy } if same(policy, &class) => to_class(&mut out, format!("Policy for: {}", short(model)), model),
            _ => {}
        }
    }
    for site in closures {
        out.push(lens(line, format!("Listener: closure in {}", site.label), &site.path, site.line + 1));
    }
    // A policy Laravel finds by its name, unless the project names one.
    let named_policy = facts.iter().any(|(f, _)| matches!(f, Fact::Policy { model, policy } if same(model, &class) || same(policy, &class)));
    if !named_policy {
        if is_model(codebase, &class) {
            if let Some(policy) = guessed_policies(&class).into_iter().find(|p| codebase.class_exists(p.as_bytes())) {
                to_class(&mut out, format!("Policy: {}", short(&policy)), &policy);
            }
        } else if let Some(name) = short(&class).strip_suffix("Policy").filter(|n| !n.is_empty())
            && let Some(model) = codebase
                .class_likes
                .values()
                .map(|c| c.original_name.as_str_lossy().into_owned())
                .find(|m| short(m) == name && is_model(codebase, m) && guessed_policies(m).iter().any(|p| same(p, &class)))
        {
            to_class(&mut out, format!("Policy for: {}", short(&model)), &model);
        }
    }
    // Where it's dispatched or sent.
    let has_listeners = facts.iter().any(|(f, _)| matches!(f, Fact::Listen { event, .. } if same(event, &class)));
    let eligible = has_listeners || dispatchable(codebase, &class);
    let mut sites: Vec<&Site> = facts
        .iter()
        .filter(|(f, _)| matches!(f, Fact::Dispatch { class: c, via } if same(c, &class) && (eligible || via == "event" || via == "broadcast")))
        .map(|(_, s)| s)
        .collect();
    sites.dedup_by(|a, b| a.path == b.path && a.line == b.line);
    // The app's own code before its tests.
    sites.sort_by_key(|s| s.path.components().any(|c| c.as_os_str() == "tests"));
    let verb = if sends(codebase, &class) { "Sent" } else { "Dispatched" };
    let shown = if sites.len() > SITES + 1 { SITES } else { sites.len() };
    for site in &sites[..shown] {
        out.push(lens(line, format!("{verb}: {}", site.label), &site.path, site.line + 1));
    }
    if let Some(next) = sites.get(shown) {
        out.push(lens(line, format!("{verb}: {} more places", sites.len() - shown), &next.path, next.line + 1));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::with_ctx;
    use crate::testing::{Fixture, uri};
    use serde_json::json;

    const LARAVEL: &str = "<?php\nnamespace Illuminate\\Foundation\\Events { trait Dispatchable { public static function dispatch(...$a) {} } }\nnamespace Illuminate\\Foundation\\Bus { trait Dispatchable { public static function dispatch(...$a) {} } }\nnamespace Illuminate\\Contracts\\Queue { interface ShouldQueue {} }\nnamespace Illuminate\\Notifications { class Notification {} }\nnamespace Illuminate\\Mail { class Mailable {} }\nnamespace Illuminate\\Database\\Eloquent { abstract class Model {} }\nnamespace Illuminate\\Support\\Facades { class Event {} class Mail {} class Gate {} }\n";

    fn titles(fx: &Fixture, file: &str) -> Vec<String> {
        with_ctx(&fx.snap, &uri(file), code_lenses).unwrap().into_iter().map(|l| l.command.unwrap().title).collect()
    }

    fn fixture(files: &[(&str, &str)]) -> Fixture {
        let mut all = vec![("vendor/laravel.php", LARAVEL)];
        all.extend_from_slice(files);
        let fx = Fixture::new(&all);
        fx.snap.framework.seed("laravel:active", json!(true));
        fx
    }

    #[test]
    fn links_events_listeners_and_dispatch_sites() {
        let fx = fixture(&[
            ("app/Events/Shipped.php", "<?php\nnamespace App\\Events;\nclass Shipped { use \\Illuminate\\Foundation\\Events\\Dispatchable; }\n"),
            ("app/Events/Unused.php", "<?php\nnamespace App\\Events;\nclass Unused {}\n"),
            ("app/Listeners/Notify.php", "<?php\nnamespace App\\Listeners;\nuse App\\Events\\Shipped;\nclass Notify { public function handle(Shipped $e): void {} }\n"),
            ("app/Listeners/Audit.php", "<?php\nnamespace App\\Listeners;\nclass Audit { public function handle($e): void {} }\n"),
            (
                "app/Providers/AppServiceProvider.php",
                "<?php\nnamespace App\\Providers;\nuse Illuminate\\Support\\Facades\\Event;\nclass AppServiceProvider {\n    function boot() {\n        Event::listen(\\App\\Events\\Shipped::class, \\App\\Listeners\\Audit::class);\n        Event::listen(function (\\App\\Events\\Shipped $e) {});\n    }\n}\n",
            ),
            (
                "app/Http/Controllers/OrderController.php",
                "<?php\nnamespace App\\Http\\Controllers;\nuse App\\Events\\Shipped;\nclass OrderController {\n    function store() { event(new Shipped); }\n    function update() { Shipped::dispatch(); }\n    function other() { $x = new Shipped; }\n}\n",
            ),
        ]);
        assert_eq!(
            titles(&fx, "app/Events/Shipped.php"),
            vec!["Listener: Notify", "Listener: Audit", "Listener: closure in AppServiceProvider@boot", "Dispatched: OrderController@store", "Dispatched: OrderController@update"]
        );
        assert_eq!(titles(&fx, "app/Listeners/Notify.php"), vec!["Listens to: Shipped"]);
        assert_eq!(titles(&fx, "app/Listeners/Audit.php"), vec!["Listens to: Shipped"]);
        assert!(titles(&fx, "app/Events/Unused.php").is_empty());
        let lenses = with_ctx(&fx.snap, &uri("app/Listeners/Notify.php"), code_lenses).unwrap();
        let args = lenses[0].command.as_ref().unwrap().arguments.clone().unwrap();
        assert!(args[0].as_str().unwrap().ends_with("app/Events/Shipped.php"));
        assert_eq!((lenses[0].range.start.line, args[1].clone()), (3, json!(3)));
    }

    #[test]
    fn turns_off_discovered_listeners_with_discovery() {
        let fx = fixture(&[
            ("app/Events/Shipped.php", "<?php\nnamespace App\\Events;\nclass Shipped {}\n"),
            ("app/Listeners/Notify.php", "<?php\nnamespace App\\Listeners;\nclass Notify { public function handle(\\App\\Events\\Shipped $e): void {} }\n"),
            ("app/Providers/EventServiceProvider.php", "<?php\nnamespace App\\Providers;\nclass EventServiceProvider { public function shouldDiscoverEvents(): bool { return false; } }\n"),
        ]);
        assert!(titles(&fx, "app/Events/Shipped.php").is_empty());
    }

    #[test]
    fn links_models_to_observers_and_policies() {
        let fx = fixture(&[
            ("app/Models/Post.php", "<?php\nnamespace App\\Models;\n#[\\Illuminate\\Database\\Eloquent\\Attributes\\ObservedBy(\\App\\Observers\\PostObserver::class)]\nclass Post extends \\Illuminate\\Database\\Eloquent\\Model {}\n"),
            ("app/Models/Tag.php", "<?php\nnamespace App\\Models;\nclass Tag extends \\Illuminate\\Database\\Eloquent\\Model {}\n"),
            ("app/Observers/PostObserver.php", "<?php\nnamespace App\\Observers;\nclass PostObserver {}\n"),
            ("app/Policies/PostPolicy.php", "<?php\nnamespace App\\Policies;\nclass PostPolicy {}\n"),
        ]);
        assert_eq!(titles(&fx, "app/Models/Post.php"), vec!["Observer: PostObserver", "Policy: PostPolicy"]);
        assert_eq!(titles(&fx, "app/Observers/PostObserver.php"), vec!["Observes: Post"]);
        assert_eq!(titles(&fx, "app/Policies/PostPolicy.php"), vec!["Policy for: Post"]);
        assert!(titles(&fx, "app/Models/Tag.php").is_empty());
    }

    #[test]
    fn links_jobs_notifications_and_mail_to_where_they_go() {
        let job = "<?php\nnamespace App\\Jobs;\nclass Ship implements \\Illuminate\\Contracts\\Queue\\ShouldQueue {}\n";
        let notification = "<?php\nnamespace App\\Notifications;\nclass Paid extends \\Illuminate\\Notifications\\Notification {}\n";
        let request = "<?php\nnamespace App\\Http;\nclass ApiRequest {}\n";
        let mut uses = String::from("<?php\nnamespace App;\nclass Uses {\n");
        for i in 0..7 {
            uses.push_str(&format!("    function a{i}($u, $client) {{ dispatch(new Jobs\\Ship); }}\n"));
        }
        uses.push_str("    function b($u, $client) { $u->notify(new Notifications\\Paid); $client->send(new Http\\ApiRequest); }\n}\n");
        let fx = fixture(&[("app/Jobs/Ship.php", job), ("app/Notifications/Paid.php", notification), ("app/Http/ApiRequest.php", request), ("app/Uses.php", &uses)]);
        assert_eq!(titles(&fx, "app/Jobs/Ship.php"), vec!["Dispatched: Uses@a0", "Dispatched: Uses@a1", "Dispatched: Uses@a2", "Dispatched: Uses@a3", "Dispatched: 3 more places"]);
        assert_eq!(titles(&fx, "app/Notifications/Paid.php"), vec!["Sent: Uses@b"]);
        // `send()` of a class that isn't Laravel's to send.
        assert!(titles(&fx, "app/Http/ApiRequest.php").is_empty());
    }
}

/// Prints every lens and every problem of the Laravel checks this branch adds, over every project file of a real
/// app, which should all be right: `TUSK_LARAVEL_APP=<root> cargo test -- --ignored --nocapture laravel_links_in_a_real_app`.
#[cfg(test)]
#[test]
#[ignore]
fn laravel_links_in_a_real_app() {
    use std::sync::Arc;

    use crate::documents::{Document, Documents};
    use crate::features::with_ctx;
    use crate::index::{Index, IndexConfig};
    use crate::server::Snapshot;
    let Ok(root) = std::env::var("TUSK_LARAVEL_APP") else { return };
    let root = PathBuf::from(root);
    crate::testing::on_server_stack(|| {
        let mut index = Index::empty(IndexConfig::new(&root));
        let paths = index.discover();
        index.build(paths, |p| std::fs::read(p).ok(), |_, _| {});
        let index = Arc::new(parking_lot::RwLock::new(index));
        let framework = Arc::new(crate::framework::State::new(root.clone()));
        let mut files: Vec<PathBuf> = index.read().project_files().map(Path::to_path_buf).collect();
        files.extend(ignore::WalkBuilder::new(root.join("resources/views")).build().flatten().map(|e| e.path().to_path_buf()).filter(|p| p.to_string_lossy().ends_with(".blade.php")));
        files.sort();
        let codes = ["routeParameter", "channel", "feature", "config", "auth"];
        let (mut lenses, mut problems, mut count) = (0, 0, 0);
        let started = std::time::Instant::now();
        for path in files {
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            count += 1;
            let mut docs = Documents::default();
            let language = if path.to_string_lossy().ends_with(".blade.php") { "blade" } else { "php" };
            docs.insert(Document::new(path_to_uri(&path), path.clone(), language.into(), 1, text));
            let snap = Snapshot { docs, index: index.clone(), root: root.clone(), framework: framework.clone(), client: None, cancel: Default::default() };
            let rel = path.strip_prefix(&root).unwrap().display().to_string();
            with_ctx(&snap, &path_to_uri(&path), |ctx| {
                for l in code_lenses(ctx) {
                    lenses += 1;
                    eprintln!("lens {rel}:{} {}", l.range.start.line + 1, l.command.unwrap().title);
                }
                for d in super::diagnostics(ctx) {
                    if matches!(&d.code, Some(lsp_types::NumberOrString::String(c)) if codes.contains(&c.as_str())) {
                        problems += 1;
                        eprintln!("problem {rel}:{} {}", d.range.start.line + 1, d.message);
                    }
                }
            });
        }
        eprintln!("{count} files, {lenses} lenses, {problems} problems, {:?}", started.elapsed());
    });
}
