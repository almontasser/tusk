//! Problems in open documents: parse errors and Mago's analysis, published after each edit.
//!
//! An edited document is checked as soon as the index has its change. Other open documents may depend on it,
//! so they're checked again once edits pause.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel::{Sender, after, never, select};
use lsp_types::notification::PublishDiagnostics;
use lsp_types::{Diagnostic, DiagnosticSeverity, NumberOrString, PublishDiagnosticsParams};
use mago_allocator::LocalArena;
use mago_reporting::{AnnotationKind, Issue, Level};
use parking_lot::RwLock;

use crate::analysis::{Parsed, analyze_with};
use crate::documents::{Document, Documents};
use crate::index::SharedIndex;
use crate::server::{Client, Snapshot};

pub enum Event {
    /// Something other than an edit changed a document's problems, such as a PHPStan run ending.
    Refresh(PathBuf),
    /// An open document changed. Its index update is queued.
    Edited(PathBuf),
    /// The indexer applied updates.
    IndexChanged,
}

/// How long edits must pause before documents other than the edited one are checked again.
const SETTLE: Duration = Duration::from_millis(600);

pub fn spawn(
    client: Client,
    docs: Arc<RwLock<Documents>>,
    index: SharedIndex,
    framework: Arc<crate::framework::State>,
    phpstan: Arc<crate::phpstan::PhpStan>,
    root: PathBuf,
) -> Sender<Event> {
    let (tx, rx) = crossbeam_channel::unbounded::<Event>();
    std::thread::Builder::new()
        .name("tusk-diagnostics".into())
        .stack_size(64 << 20)
        .spawn(move || {
            let snapshot = |docs: &Arc<RwLock<Documents>>| Snapshot {
                docs: docs.read().clone(),
                index: index.clone(),
                root: root.clone(),
                framework: framework.clone(),
                client: None,
                cancel: Default::default(),
            };
            let mut edited: HashSet<PathBuf> = HashSet::new();
            let mut others_due = false;
            loop {
                let timeout = if others_due { after(SETTLE) } else { never() };
                select! {
                    recv(rx) -> event => match event {
                        Ok(Event::Edited(path)) => {
                            edited.insert(path);
                        }
                        Ok(Event::Refresh(path)) => {
                            let snap = snapshot(&docs);
                            if let Some(doc) = snap.docs.get(&path).cloned() {
                                publish(&client, &snap, &doc, &phpstan);
                            }
                        }
                        Ok(Event::IndexChanged) => {
                            let snap = snapshot(&docs);
                            for path in edited.drain() {
                                if let Some(doc) = snap.docs.get(&path).cloned() {
                                    publish(&client, &snap, &doc, &phpstan);
                                }
                            }
                            others_due = true;
                        }
                        Err(_) => return,
                    },
                    recv(timeout) -> _ => {
                        others_due = false;
                        let snap = snapshot(&docs);
                        for doc in snap.docs.iter() {
                            publish(&client, &snap, doc, &phpstan);
                        }
                    }
                }
            }
        })
        .expect("the diagnostics thread starts");
    tx
}

fn publish(client: &Client, snap: &Snapshot, doc: &Document, phpstan: &crate::phpstan::PhpStan) {
    if !matches!(doc.language.as_str(), "php" | "blade") {
        return;
    }
    let mut diagnostics = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| check(snap, doc))).unwrap_or_default();
    diagnostics.extend(phpstan.problems(&doc.path));
    client.notify::<PublishDiagnostics>(PublishDiagnosticsParams {
        uri: doc.uri.clone(),
        diagnostics,
        version: Some(doc.version),
    });
}

/// The problems in `doc`: Mago's, and the framework's.
pub fn check(snap: &Snapshot, doc: &Document) -> Vec<Diagnostic> {
    let mut out = if doc.language == "php" {
        php_problems(&snap.index, doc)
    } else {
        // Before the index's lock, since it may run PHP.
        let components = crate::framework::laravel::blade_components(&snap.framework);
        blade_problems_in(&snap.index.read(), doc, &|p| snap.read(p), components.as_deref())
    };
    let framework = crate::features::with_ctx(snap, &doc.uri, crate::framework::diagnostics).unwrap_or_default();
    out.extend(framework);
    out
}

pub fn php_problems(index: &SharedIndex, doc: &Document) -> Vec<Diagnostic> {
    php_problems_in(&index.read(), doc)
}

/// [`php_problems`] with the index already locked, for work that runs in parallel and mustn't take the lock.
pub fn php_problems_in(index: &crate::index::Index, doc: &Document) -> Vec<Diagnostic> {
    let arena = LocalArena::new();
    let (parsed, issues) = analysis_issues(index, &arena, &doc.path, &doc.text);
    let mago = index.config.mago.clone();
    let rel = doc.path.strip_prefix(&index.config.root).unwrap_or(&doc.path).to_path_buf();
    let out: Vec<Diagnostic> = issues.iter().filter_map(|i| to_diagnostic(doc, parsed.file.id, i, "mago")).collect();
    if crate::analysis::too_complex(parsed.program) {
        return out;
    }
    let mut out = out;
    if mago.lints(&rel) {
        out.extend(lint(doc, &rel, &mago));
    }
    out.extend(crate::features::actions::organize::diagnostics(&parsed, doc));
    out
}

/// Mago's syntax errors and the analysis issues its configuration reports for `text`, a file at `path`.
fn analysis_issues<'a>(index: &crate::index::Index, arena: &'a LocalArena, path: &std::path::Path, text: &str) -> (Parsed<'a>, Vec<Issue>) {
    // Syntax errors come from the text as written: the parse the analysis uses closes what's left open at
    // the end of the file, which would hide a missing `}`.
    let exact = Parsed::exact(arena, path, text);
    // After the first errors, the rest are mostly the parser losing its way, and each costs a position lookup.
    let mut issues: Vec<Issue> = exact.program.errors.iter().take(100).map(Issue::from).collect();
    let parsed = if issues.is_empty() { exact } else { Parsed::new(arena, path, text) };
    let mago = &index.config.mago;
    let rel = path.strip_prefix(&index.config.root).unwrap_or(path);
    let analysis = analyze_with(&parsed, arena, index, mago.analyzer_settings(index.config.php_version));
    issues.extend(analysis.issues.into_iter().filter(|i| mago.reports_analysis(rel, i.code.as_deref())));
    (parsed, issues)
}

/// Mago's problems in the PHP of `doc`, a Blade view, read as [`checked_php`] lays it out, at the view's
/// positions. The view's variables get the types that the places rendering it pass ([`view_types`]); `read`
/// gives a project file's text for finding them, and `components` the app's Blade components. Others are
/// unknown, which drops undefined variables, uses of their `mixed` values, and Laravel's magic properties and
/// methods, leaving syntax errors, unknown classes, functions, methods, constants, and properties, and wrong
/// arguments.
///
/// [`view_types`]: crate::framework::laravel::views::view_types
/// [`checked_php`]: crate::framework::laravel::blade::checked_php
pub fn blade_problems_in(index: &crate::index::Index, doc: &Document, read: &dyn Fn(&std::path::Path) -> Option<String>, components: Option<&serde_json::Value>) -> Vec<Diagnostic> {
    use crate::framework::laravel::views;
    let vars = views::view_name(index, &doc.path).map(|v| views::view_types(index, read, components, &v)).unwrap_or_default();
    let checked = crate::framework::laravel::blade::checked_php(&doc.text, &vars);
    let authed = checked.authed.iter().map(|r| (checked.php_offset(r.start) as u32, checked.php_offset(r.end) as u32)).collect();
    let arena = LocalArena::new();
    let (parsed, issues) = crate::analysis::logged_in(authed, || analysis_issues(index, &arena, &doc.path, &checked.php));
    // The first line, `<?php` and the imports, is the view's start.
    let at = |offset: u32| checked.view_offset(offset as usize).unwrap_or_else(|at| at) as u32;
    // What Laravel's compiled PHP adds, such as the `isset(` of `@isset(…)`, isn't the view's to fix.
    let added = |i: &&Issue| i.annotations.iter().find(|a| a.kind == AnnotationKind::Primary).is_some_and(|a| checked.view_offset(a.span.start.offset as usize).is_err());
    let guarded = |d: &Diagnostic| possibly_null(d) && checked.unsure.iter().any(|r| r.contains(&(doc.offset(d.range.start) as usize)));
    issues
        .iter()
        .filter(|i| !added(i))
        .filter_map(|i| to_diagnostic_at(doc, parsed.file.id, i, "mago", at))
        .filter(|d| !blade_noise(d) && !guarded(d))
        .collect()
}

/// Whether `d` is a "possibly null" problem, such as `possibly-null-property-access`.
fn possibly_null(d: &Diagnostic) -> bool {
    matches!(&d.code, Some(NumberOrString::String(c)) if c.starts_with("possibly-null-") || c == "possible-method-access-on-null")
}

/// Whether `d` is about a Blade view's variables, which [`blade_problems_in`] drops.
fn blade_noise(d: &Diagnostic) -> bool {
    let Some(NumberOrString::String(code)) = &d.code else { return false };
    let on_mixed = matches!(code.as_str(), "invalid-iterator" | "invalid-callable" | "invalid-array-element" | "invalid-destructuring-source" | "invalid-type-cast")
        && (d.message.contains("`mixed`") || d.message.contains("`nonnull`"));
    matches!(code.as_str(), "undefined-variable" | "possibly-undefined-variable" | "unused-statement" | "no-value" | "non-documented-property" | "non-documented-method")
        || code.starts_with("mixed-")
        // Typed variables make a view's guards look needless, but the guards are for other places that render it.
        || code.starts_with("redundant-")
        || code.starts_with("unreachable-")
        || code.starts_with("impossible-")
        // Other "possibly" problems, such as on a union of the types two places pass, aren't checked yet.
        || ((code.starts_with("possibly-") || code.starts_with("possible-")) && !possibly_null(d))
        || on_mixed
}

/// Mago's linter on the document. Its rules match excluded paths against the file's name, so the file is
/// named by its path relative to the project, as Mago names it.
fn lint(doc: &Document, rel: &std::path::Path, mago: &crate::mago_config::MagoConfig) -> Vec<Diagnostic> {
    let (file, issues) = lint_issues(doc, rel, mago);
    issues.iter().filter_map(|i| to_diagnostic(doc, file, i, "mago-lint")).collect()
}

/// The linter's issues, with their fixes, and the ID of the file they're in.
pub fn lint_issues(doc: &Document, rel: &std::path::Path, mago: &crate::mago_config::MagoConfig) -> (mago_database::file::FileId, Vec<Issue>) {
    let arena = LocalArena::new();
    let name = crate::index::mago_name(rel);
    let file = mago_database::file::File::new(
        std::borrow::Cow::Owned(name),
        mago_database::file::FileType::Host,
        Some(doc.path.clone()),
        std::borrow::Cow::Owned(doc.text.clone().into_bytes()),
    );
    let program = mago_syntax::parser::parse_file(&arena, &file);
    let names = mago_names::resolver::NameResolver::new(&arena).resolve(program);
    let linter = mago_linter::Linter::from_registry(&arena, mago.rules.clone(), mago.linter.php_version);
    (file.id, linter.lint(&file, program, &names).into_iter().collect())
}

pub fn to_diagnostic(doc: &Document, file: mago_database::file::FileId, issue: &Issue, source: &str) -> Option<Diagnostic> {
    to_diagnostic_at(doc, file, issue, source, |offset| offset)
}

/// [`to_diagnostic`] for an issue in other text than the document's, whose offsets `at` maps to the document's.
fn to_diagnostic_at(doc: &Document, file: mago_database::file::FileId, issue: &Issue, source: &str, at: impl Fn(u32) -> u32) -> Option<Diagnostic> {
    let primary = issue
        .annotations
        .iter()
        .filter(|a| a.span.file_id == file)
        .find(|a| a.kind == AnnotationKind::Primary)?;
    let severity = match issue.level {
        Level::Error => DiagnosticSeverity::ERROR,
        Level::Warning => DiagnosticSeverity::WARNING,
        Level::Help => DiagnosticSeverity::HINT,
        Level::Note => DiagnosticSeverity::INFORMATION,
    };
    let mut message = issue.message.clone();
    if let Some(label) = primary.message.as_deref().filter(|m| !m.is_empty() && *m != issue.message) {
        message.push_str(&format!("\n{label}"));
    }
    for note in &issue.notes {
        message.push_str(&format!("\n{note}"));
    }
    if let Some(help) = &issue.help {
        message.push_str(&format!("\nHelp: {help}"));
    }
    Some(Diagnostic {
        range: doc.range(at(primary.span.start.offset), at(primary.span.end.offset)),
        severity: Some(severity),
        code: issue.code.clone().map(NumberOrString::String),
        source: Some(source.into()),
        message,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fixture;

    fn problems(text: &str, mago_toml: &str) -> Vec<(String, String)> {
        let fx = Fixture::one(text);
        {
            let mut index = fx.snap.index.write();
            index.config.mago = std::sync::Arc::new(crate::mago_config::MagoConfig::parse(mago_toml, std::path::Path::new(crate::testing::ROOT)).unwrap());
        }
        let doc = fx.doc("test.php");
        let mut out: Vec<(String, String)> = php_problems(&fx.snap.index, &doc)
            .into_iter()
            .map(|d| (d.source.unwrap_or_default(), match d.code { Some(NumberOrString::String(c)) => c, _ => String::new() }))
            .collect();
        out.sort();
        out
    }

    #[test]
    fn reports_analysis_and_lint_problems_as_configured() {
        let code = "<?php\n\nfunction f(): int { return 'x'; }\n";
        let all = problems(code, "");
        assert!(all.contains(&("mago".into(), "invalid-return-statement".into())), "{all:?}");
        assert!(all.contains(&("mago-lint".into(), "strict-types".into())), "{all:?}");
        let configured = problems(code, "[analyzer]\nignore = [\"invalid-return-statement\"]\n[linter.rules]\nstrict-types = { enabled = false }\n");
        assert!(!configured.iter().any(|(_, c)| c == "invalid-return-statement" || c == "strict-types"), "{configured:?}");
    }

    #[test]
    fn checks_the_php_in_blade_views_at_their_positions() {
        let fx = Fixture::new(&[("app/Post.php", "<?php\nnamespace App;\nclass Post { public static function find(int $id): ?self { return null; } }\n")]);
        let blade = "@use('App\\Post')\n<h1>{{ $title->name }}</h1>\n@foreach ($posts as $post)\n  <x-card :post=\"Post::find('x')\" />\n@endforeach\n@php nope(); @endphp\n";
        let doc = Document::new(crate::testing::uri("resources/views/a.blade.php"), crate::testing::path("resources/views/a.blade.php"), "blade".into(), 1, blade.into());
        let found: Vec<_> = blade_problems_in(&fx.snap.index.read(), &doc, &|p| fx.snap.read(p), None)
            .into_iter()
            .map(|d| (match d.code { Some(NumberOrString::String(c)) => c, _ => String::new() }, d.range.start.line, d.range.start.character))
            .collect();
        // The undefined `$title`, `$posts`, and what's read from them are the controller's to define.
        assert_eq!(found, vec![("invalid-argument".into(), 3, 28), ("non-existent-function".into(), 5, 5)], "{found:?}");
    }

    #[test]
    fn types_a_views_variables_from_where_it_is_rendered() {
        let models = "<?php\nnamespace App;\nclass Post { public string $title = ''; }\nclass User { public string $name = ''; }\n";
        let controller = "<?php\nnamespace App;\nclass PostController {\n    /** @param list<Post> $all */\n    public function show(Post $post, array $all, int $n, $any) {\n        return view('posts.show', compact('post', 'all'))->with('n', $n)->with(['any' => $any, 'user' => new User]);\n    }\n    public function other(Post $post) {\n        return \\Illuminate\\Support\\Facades\\View::make(\"posts.show\", ['post' => $post, 'all' => [$post], 'n' => 1, 'any' => 2]);\n    }\n}\n";
        let livewire = "<?php\nnamespace Livewire;\nabstract class Component {}\nnamespace App;\nclass Counter extends \\Livewire\\Component {\n    public int $count = 0;\n    public function render() { return view('livewire.counter'); }\n}\n";
        let fx = Fixture::new(&[("app/Models.php", models), ("app/PostController.php", controller), ("app/Counter.php", livewire)]);
        let check = |name: &str, blade: &str| {
            let doc = Document::new(crate::testing::uri(name), crate::testing::path(name), "blade".into(), 1, blade.into());
            blade_problems_in(&fx.snap.index.read(), &doc, &|p| fx.snap.read(p), None)
                .into_iter()
                .map(|d| (match d.code { Some(NumberOrString::String(c)) => c, _ => String::new() }, d.range.start.line, d.range.start.character))
                .collect::<Vec<_>>()
        };
        // `$post` and `$all` are typed by both places; `$user` is passed by one only and `$any` is untyped.
        let blade = "{{ $post->titel }}\n@foreach ($all as $p) {{ $p->nope }} @endforeach\n{{ $n->x }}\n{{ $user->whatever }} {{ $any->x }} {{ $post->title }}\n";
        let found = check("resources/views/posts/show.blade.php", blade);
        assert!(found.contains(&("non-existent-property".into(), 0, 10)), "{found:?}");
        assert!(found.contains(&("non-existent-property".into(), 1, 29)), "{found:?}");
        assert!(found.iter().any(|f| f.1 == 2), "{found:?}");
        assert!(!found.iter().any(|f| f.1 == 3), "{found:?}");
        let found = check("resources/views/livewire/counter.blade.php", "{{ $count->x }}\n");
        assert_eq!(found.len(), 1, "{found:?}");
        // Guards that typed variables make redundant aren't reported: the view may be rendered elsewhere too.
        let found = check("resources/views/posts/show.blade.php", "@if ($post) @endif @isset($post) @endisset {{ $post?->title }} {{ $n ?? 0 }} @if ($post instanceof \\App\\Post) @endif {{ is_null($n) }}\n");
        assert!(found.is_empty(), "{found:?}");
        // A view nothing renders keeps its variables untyped.
        assert!(check("resources/views/other.blade.php", "{{ $post->titel }}\n").is_empty());
    }

    /// Laravel's auth helper, guard, and facade, as declared, with a model and a controller that renders `posts.show`
    /// with a `Post`, a `?Post`, and the user.
    fn narrowing_fixture() -> Fixture {
        let auth = "<?php\nnamespace Illuminate\\Contracts\\Auth {\n    interface Authenticatable { public function getAuthIdentifier(); }\n    interface Guard {\n        /** @return bool */\n        public function check();\n        /** @return \\Illuminate\\Contracts\\Auth\\Authenticatable|null */\n        public function user();\n    }\n    interface Factory {\n        /** @return \\Illuminate\\Contracts\\Auth\\Guard */\n        public function guard($name = null);\n    }\n}\nnamespace Illuminate\\Support\\Facades {\n    /** @method static \\Illuminate\\Contracts\\Auth\\Authenticatable|null user() */\n    class Auth {}\n}\nnamespace {\n    /** @return ($guard is null ? \\Illuminate\\Contracts\\Auth\\Factory : \\Illuminate\\Contracts\\Auth\\Guard) */\n    function auth($guard = null) {}\n}\n";
        let models = "<?php\nnamespace App;\nclass User { public string $name = ''; }\nclass Post { public string $title = ''; public ?User $author = null; }\n";
        let controller = "<?php\nnamespace App;\nclass PostController {\n    public function show(Post $post, ?Post $maybe) {\n        $user = \\Illuminate\\Support\\Facades\\Auth::user();\n        return view('posts.show', compact('post', 'maybe', 'user'));\n    }\n}\n";
        Fixture::new(&[("app/auth.php", auth), ("app/Models.php", models), ("app/PostController.php", controller)])
    }

    /// The codes of the problems in `blade` as the `posts.show` view of [`narrowing_fixture`].
    fn view_problems(fx: &Fixture, blade: &str) -> Vec<String> {
        let doc = Document::new(crate::testing::uri("resources/views/posts/show.blade.php"), crate::testing::path("resources/views/posts/show.blade.php"), "blade".into(), 1, blade.into());
        blade_problems_in(&fx.snap.index.read(), &doc, &|p| fx.snap.read(p), None).into_iter().map(|d| match d.code { Some(NumberOrString::String(c)) => c, _ => String::new() }).collect()
    }

    #[test]
    fn narrows_a_views_variables_in_conditionals() {
        let fx = narrowing_fixture();
        let null = "possibly-null-property-access";
        // An access reports once: after it, Mago takes the value as not null.
        for (blade, found) in [
            ("{{ $post->author->name }}", vec![null]),
            ("@if ($post->author) {{ $post->author->name }} @endif", vec![]),
            // `$maybe` is null in the `@elseif`.
            ("@if ($maybe) {{ $maybe->title }} @elseif ($post->author) {{ $maybe->title }} @endif", vec!["null-property-access"]),
            ("@isset($post->author) {{ $post->author->name }} @endisset", vec![]),
            ("@isset($maybe, $post->author) {{ $maybe->title }} {{ $post->author->name }} @endisset", vec![]),
            ("@isset($maybe) @else {{ $maybe->title }} @endisset", vec!["null-property-access"]),
            ("@unless(is_null($maybe)) {{ $maybe->title }} @else {{ $post->author?->name }} @endunless", vec![]),
            ("@unless($maybe) @else {{ $maybe->title }} @endunless", vec![]),
            ("@empty($maybe) x @else {{ $maybe->title }} @endempty", vec![]),
            ("@isset($maybe) {{ $maybe->title }} @endif", vec![]),
            ("@foreach ([1, 2] as $i) @continue($maybe === null) {{ $maybe->title }} @endforeach", vec![]),
            ("@foreach ([1, 2] as $i) @if (! $post->author) @break @endif {{ $post->author->name }} @endforeach", vec![]),
            // Mago narrows a `switch`'s cases only in part, so they aren't checked.
            ("@switch($maybe) @case(null) @break @default {{ $maybe->title }} @endswitch", vec![]),
            // These say nothing about the view's variables.
            ("@can('edit', $post) {{ $post->author->name }} @endcan", vec![null]),
            ("@env('local') {{ $post->author->name }} @endenv", vec![null]),
            ("@auth {{ $maybe->title }} @else x @endauth", vec![null]),
            ("@hasSection('a') x @else {{ $maybe->title }} @endif", vec![null]),
            // Guards that typed variables make needless aren't reported: the view may be rendered elsewhere too.
            ("@isset($post) @else {{ $post->title }} @endisset @switch(1) @case(2) @endswitch", vec![]),
        ] {
            assert_eq!(view_problems(&fx, blade), found, "{blade}");
        }
    }

    #[test]
    fn types_the_user_as_logged_in_inside_auth() {
        let fx = narrowing_fixture();
        let user = "{{ \\Illuminate\\Support\\Facades\\Auth::user()->getAuthIdentifier() }} {{ auth()->guard('admin')->user()->getAuthIdentifier() }}";
        let null = "possible-method-access-on-null";
        for (blade, found) in [
            (format!("@auth {user} @php $u = \\Illuminate\\Support\\Facades\\Auth::user(); @endphp {{{{ $u->getAuthIdentifier() }}}} @else x @endauth"), vec![]),
            (format!("@auth('admin') x @elseauth {user} @endauth"), vec![]),
            (format!("@guest x @else {user} @endguest"), vec![]),
            (format!("@guest {user} @endguest"), vec![null, null]),
            (format!("@auth x @else {user} @endauth"), vec![null, null]),
            (user.to_string(), vec![null, null]),
            // So is a variable that may hold the user, as `$user` does from the controller.
            ("@auth {{ $user->getAuthIdentifier() }} @endauth".to_string(), vec![]),
            ("{{ $user->getAuthIdentifier() }}".to_string(), vec![null]),
        ] {
            assert_eq!(view_problems(&fx, &blade), found, "{blade}");
        }
    }

    #[test]
    fn reads_views_whose_blocks_dont_nest_without_false_problems() {
        let fx = narrowing_fixture();
        let lines = |blade: &str| view_problems(&fx, blade);
        let null = vec!["possibly-null-property-access".to_string()];
        // An `@end…` that ends nothing leaves what's before it unsure, but what's after it is checked and narrowed.
        assert!(lines("{{ $post->author->name }}\n@if ($post) @foreach ([] as $x) @endif @endforeach\n").is_empty());
        assert_eq!(lines("@endif\n{{ $post->author->name }}\n@if ($maybe) {{ $maybe->title }} @endif\n"), null);
        // A block left open leaves what's after it unsure.
        assert_eq!(lines("{{ $post->author->name }}\n@if ($maybe)\n{{ $maybe->title }}\n"), null);
        assert!(lines("@isset($maybe)\n{{ $maybe->title }}\n@endforeach\n{{ $maybe->title }}\n").is_empty());
        // Directives Tusk doesn't know, such as a `Blade::if()`, may narrow.
        assert!(lines("@admin {{ $maybe->title }} @endadmin @unlessadmin {{ $maybe->title }} @endadmin @error('title') {{ $maybe->title }} @enderror").is_empty());
        // The PHP that Laravel adds, which calls helpers that aren't here, isn't the view's to fix.
        assert!(lines("@can('x') @endcan @env('local') @endenv @production @endproduction @hasSection('a') @endif @sectionMissing('b') @endif @hasStack('c') @endif @auth('web') @endauth @guest @endguest").is_empty());
    }

    #[test]
    fn drops_problems_about_a_views_variables() {
        let d = |code: &str, message: &str| Diagnostic { code: Some(NumberOrString::String(code.into())), message: message.into(), ..Default::default() };
        let noise = ["undefined-variable", "possibly-undefined-variable", "unused-statement", "no-value", "non-documented-method", "mixed-property-access", "redundant-condition", "possibly-non-existent-method"];
        assert!(noise.iter().all(|c| blade_noise(&d(c, ""))));
        assert!(blade_noise(&d("invalid-iterator", "of type `mixed`")) && !blade_noise(&d("invalid-iterator", "of type `int`")));
        assert!(!blade_noise(&d("non-existent-function", "")) && !blade_noise(&d("parse", "")));
    }

    #[test]
    fn checks_this_in_pest_tests_against_the_bound_test_case() {
        let mago = |fx: &Fixture| {
            php_problems(&fx.snap.index, &fx.doc("tests/Feature/HomeTest.php"))
                .into_iter()
                .filter_map(|d| match d.code { Some(NumberOrString::String(c)) if d.source.as_deref() == Some("mago") => Some((c, d.range.start.line)), _ => None })
                .collect::<Vec<_>>()
        };
        let problems_in = |pest: &str, head: &str| {
            let mut files = crate::testing::PEST.to_vec();
            files.retain(|(name, _)| *name != "tests/Pest.php");
            files.push(("tests/Pest.php", pest));
            let test = format!("<?php\n{head}beforeEach(function () {{ $this->get('/'); }});\nit('loads', function () {{\n    $this->get('/');\n    $this->gte('/');\n}});\n");
            files.push(("tests/Feature/HomeTest.php", &test));
            mago(&Fixture::new(&files))
        };
        let problems = |pest: &str| problems_in(pest, "");
        let bound = vec![("non-existent-method".into(), 4)];
        // Bound to Tests\TestCase, by `pest()->extend()` or Pest 1's `uses()`: only the misspelled call is reported.
        assert_eq!(problems("<?php\nuse Tests\\TestCase;\npest()->extend(TestCase::class)->in('Feature');\n"), bound);
        assert_eq!(problems("<?php\nuses(Tests\\TestCase::class)->in('Feature');\n"), bound);
        assert_eq!(problems("<?php\npest()->use(Tests\\TestCase::class)->in('Unit', 'Feat*');\n"), bound);
        assert_eq!(problems("<?php\nuses(Tests\\TestCase::class)->in(__DIR__);\n"), bound);
        // By the test file's own `uses()`.
        assert_eq!(problems_in("<?php\n", "uses(Tests\\TestCase::class);\n").into_iter().map(|(c, l)| (c, l - 1)).collect::<Vec<_>>(), bound);
        // Without one, or with one for another folder, PHPUnit's TestCase, which has no `get()`.
        for pest in ["<?php\n", "<?php\nuses(Tests\\TestCase::class)->in('Unit');\n", "<?php\nuses(Tests\\TestCase::class);\n"] {
            let unbound = problems(pest);
            assert_eq!(unbound.iter().filter(|(c, _)| c == "non-existent-method").count(), 3, "{pest}: {unbound:?}");
        }
        // Editing Pest.php binds again.
        let mut files = crate::testing::PEST.to_vec();
        files.push(("tests/Feature/HomeTest.php", "<?php\nit('loads', function () { $this->get('/'); });\n"));
        let fx = Fixture::new(&files);
        assert!(mago(&fx).is_empty());
        fx.snap.index.write().update(&crate::testing::path("tests/Pest.php"), Some(b"<?php\n".to_vec()));
        assert_eq!(mago(&fx), vec![("non-existent-method".into(), 1)]);
    }

    #[test]
    fn binds_the_traits_pest_adds_to_this() {
        let problems = |pest: &str, test: &str, name: &str| {
            let mut files = crate::testing::PEST.to_vec();
            files.retain(|(name, _)| *name != "tests/Pest.php");
            files.extend([("tests/Pest.php", pest), (name, test), ("vendor/refresh.php", crate::testing::REFRESH_DATABASE)]);
            let fx = Fixture::new(&files);
            mago_codes(&fx, name)
        };
        let test = "<?php\nit('loads', function () {\n    $this->get('/');\n    $this->refreshDatabase();\n    $this->refreshDatabse();\n});\n";
        let bound = vec![("non-existent-method".into(), 4)];
        // Added by a Pest.php chain, Pest 1's `uses()`, or the file's own `uses()`: only the misspelled call is reported.
        let chain = "<?php\npest()->extend(Tests\\TestCase::class)->use(Illuminate\\Foundation\\Testing\\RefreshDatabase::class)->in('Feature');\n";
        assert_eq!(problems(chain, test, "tests/Feature/HomeTest.php"), bound);
        let uses = "<?php\nuses(Tests\\TestCase::class, Illuminate\\Foundation\\Testing\\RefreshDatabase::class)->in('Feature');\n";
        assert_eq!(problems(uses, test, "tests/Feature/HomeTest.php"), bound);
        let own = test.replace("<?php\n", "<?php\nuses(Illuminate\\Foundation\\Testing\\RefreshDatabase::class);\n");
        let own_bound = vec![("non-existent-method".into(), 5)];
        assert_eq!(problems(crate::testing::PEST[2].1, &own, "tests/Feature/HomeTest.php"), own_bound);
        // A `uses()` the index doesn't have yet, such as one just typed: until the index makes a class with the
        // trait, missing members aren't reported. (Closures after the edit wait for the index anyway.)
        let mut files = crate::testing::PEST.to_vec();
        files.extend([("tests/Feature/HomeTest.php", test), ("vendor/refresh.php", crate::testing::REFRESH_DATABASE)]);
        let typed = format!("{test}uses(Illuminate\\Foundation\\Testing\\RefreshDatabase::class);\n");
        let doc = Document::new(crate::testing::uri("tests/Feature/HomeTest.php"), crate::testing::path("tests/Feature/HomeTest.php"), "php".into(), 2, typed);
        // Whether or not another file loaded the trait (until the index loads it, it's reported as not found).
        for other in [None, Some(("tests/Unit/OtherTest.php", own.as_str()))] {
            let fx = Fixture::new(&files.iter().copied().chain(other).collect::<Vec<_>>());
            let found = php_problems(&fx.snap.index, &doc);
            assert!(!found.iter().any(|d| d.code == Some(NumberOrString::String("non-existent-method".into()))), "{other:?}: {found:?}");
        }
        // A trait without a test case runs in PHPUnit's, which has no `get()`.
        let unbound = problems("<?php\n", &own, "tests/Feature/HomeTest.php");
        assert_eq!(unbound.iter().map(|(_, l)| *l).collect::<Vec<_>>(), vec![3, 5], "{unbound:?}");
        // Another folder doesn't get them.
        assert_eq!(problems(chain, test, "tests/Unit/HomeTest.php").len(), 3);
        // Editing Pest.php binds again.
        let unit = chain.replace("'Feature'", "'Unit'");
        let mut files = crate::testing::PEST.to_vec();
        files.retain(|(name, _)| *name != "tests/Pest.php");
        files.extend([("tests/Pest.php", unit.as_str()), ("tests/Feature/HomeTest.php", test), ("vendor/refresh.php", crate::testing::REFRESH_DATABASE)]);
        let fx = Fixture::new(&files);
        assert_eq!(mago_codes(&fx, "tests/Feature/HomeTest.php").len(), 3);
        fx.snap.index.write().update(&crate::testing::path("tests/Pest.php"), Some(chain.as_bytes().to_vec()));
        assert_eq!(mago_codes(&fx, "tests/Feature/HomeTest.php"), bound);
        fx.snap.index.write().update(&crate::testing::path("tests/Pest.php"), Some(unit.into_bytes()));
        assert_eq!(mago_codes(&fx, "tests/Feature/HomeTest.php").len(), 3);
    }

    fn mago_codes(fx: &Fixture, name: &str) -> Vec<(String, u32)> {
        php_problems(&fx.snap.index, &fx.doc(name))
            .into_iter()
            .filter_map(|d| match d.code { Some(NumberOrString::String(c)) if d.source.as_deref() == Some("mago") => Some((c, d.range.start.line)), _ => None })
            .collect()
    }

    #[test]
    fn types_properties_pest_tests_set_on_this() {
        let codes = |pest: &str, test: &str| {
            let mut files = crate::testing::PEST.to_vec();
            files.retain(|(name, _)| *name != "tests/Pest.php");
            files.extend([("tests/Pest.php", pest), ("tests/Feature/HomeTest.php", test)]);
            mago_codes(&Fixture::new(&files), "tests/Feature/HomeTest.php")
        };
        let pest = crate::testing::PEST[2].1;
        let user = "class User { public function posts(): void {} }\n";
        let set = "beforeEach(function () {\n    $this->user = new User;\n});\n";
        let read = "it('loads', function () {\n    $this->user->posts();\n    $this->user->psts();\n});\n";
        // Setting the property isn't reported, as Pest allows it; reading it gives a `User`.
        assert_eq!(codes(pest, &format!("<?php\n{user}{set}{read}")), vec![("non-existent-method".into(), 7)]);
        // Whatever the order.
        assert_eq!(codes(pest, &format!("<?php\n{user}{read}{set}")), vec![("non-existent-method".into(), 4)]);
        // Set by a Pest.php chain's `beforeEach()` for the files it covers.
        let chained = format!("<?php\n{user}pest()->extend(Tests\\TestCase::class)->beforeEach(function () {{\n    $this->user = new User;\n}})->in('Feature');\n");
        assert_eq!(codes(&chained, &format!("<?php\n{read}")), vec![("non-existent-method".into(), 3)]);
        // Never set: reading it is reported.
        let unset = codes(pest, &format!("<?php\n{user}{read}"));
        assert!(unset.contains(&("non-existent-property".into(), 3)), "{unset:?}");
        // A Pest.php hook's type follows the files it depends on.
        let mut files = crate::testing::PEST.to_vec();
        files.retain(|(name, _)| *name != "tests/Pest.php");
        let hooked = "<?php\npest()->extend(Tests\\TestCase::class)->beforeEach(function () {\n    $this->user = make_user();\n})->in('Feature');\n";
        let helper = |returns: &str| format!("<?php\nclass User {{ public function posts(): void {{}} }}\nclass Post {{}}\nfunction make_user(): {returns} {{ return new {returns}; }}\n");
        let user = helper("User");
        files.extend([("tests/Pest.php", hooked), ("app/helpers.php", user.as_str()), ("tests/Feature/HomeTest.php", "<?php\nit('loads', function () {\n    $this->user->posts();\n});\n")]);
        let fx = Fixture::new(&files);
        assert!(mago_codes(&fx, "tests/Feature/HomeTest.php").is_empty());
        fx.snap.index.write().update(&crate::testing::path("app/helpers.php"), Some(helper("Post").into_bytes()));
        assert_eq!(mago_codes(&fx, "tests/Feature/HomeTest.php"), vec![("non-existent-method".into(), 2)]);
    }

    #[test]
    fn honors_expect_pragmas() {
        let code = "<?php\n\ndeclare(strict_types=1);\n\nfunction f(): int {\n    // @mago-expect analysis:invalid-return-statement\n    return 'x';\n}\n";
        let found = problems(code, "");
        assert!(!found.iter().any(|(_, c)| c == "invalid-return-statement"), "{found:?}");
    }

    #[test]
    fn skips_analysis_of_pathological_files() {
        // Mago's analyzer takes minutes on each and recurses once per term; the syntax check still runs.
        let deep = vec!["1"; 20_000].join(" + ");
        let branches: String = (0..5_000).map(|i| format!("{i} => {i}, ")).collect();
        for body in [format!("$a = {deep};"), format!("$a = match ($b) {{ {branches} }};")] {
            let code = format!("<?php\n\nfunction f(): int {{ return 'x'; }}\n{body}\n$b = (;\n");
            let started = std::time::Instant::now();
            // On a stack as large as the server's threads have.
            let found = std::thread::Builder::new().stack_size(64 << 20).spawn(move || problems(&code, "")).unwrap().join().unwrap();
            assert!(started.elapsed() < std::time::Duration::from_secs(5), "{:?}", started.elapsed());
            assert!(found.iter().all(|(s, _)| s == "mago") && !found.iter().any(|(_, c)| c == "invalid-return-statement"), "{found:?}");
            assert!(!found.is_empty());
        }
    }
}
