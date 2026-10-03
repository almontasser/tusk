use lsp_types::HoverContents;

use crate::features::{with_ctx, with_ctx_at};
use crate::testing::{Fixture, uri};

/// Livewire as it declares itself: a component with `__get()` and `__call()`, a Form, and its attributes.
const LIVEWIRE: &str = "<?php
namespace Livewire {
    abstract class Component {
        public function __get($property) {}
        public function __call($method, $params) {}
        public function dispatch($event, ...$params) {}
        public function validate($rules = null) {}
    }
    class Form { public function __construct(protected Component $component, protected $propertyName) {} public function reset(...$properties) {} }
}
namespace Livewire\\Attributes {
    #[\\Attribute] class Computed {}
    #[\\Attribute] class On { public function __construct(public $event) {} }
    #[\\Attribute] class Modelable {}
}
namespace Livewire\\Volt { abstract class Component extends \\Livewire\\Component {} }
";

const FORM: &str = "<?php
namespace App\\Livewire\\Forms;
class PostForm extends \\Livewire\\Form {
    public string $title = '';
    public string $body = '';
}
";

const EDIT: &str = "<?php
namespace App\\Livewire;
use Livewire\\Attributes\\Computed;
use Livewire\\Attributes\\On;
use App\\Livewire\\Forms\\PostForm;
class EditPost extends \\Livewire\\Component {
    public PostForm $form;
    public string $search = '';
    public static int $hits = 0;
    protected int $secret = 0;
    public function save(int $id = 0): void { $this->dispatch('post-saved'); }
    protected function helper(): void {}
    public function mount(): void {}
    #[Computed]
    public function posts(): \\App\\Models\\Post { return new \\App\\Models\\Post; }
    #[On('post-created')]
    public function refreshList(): void {}
    public function render() { return view('livewire.edit-post')->layout('layouts.app'); }
}
";

const MODELS: &str = "<?php\nnamespace App\\Models;\nclass Post { public string $title = ''; }\n";

fn fixture(view: &str, extra: &[(&str, &str)]) -> Fixture {
    let mut files = vec![("vendor/livewire.php", LIVEWIRE), ("app/Livewire/Forms/PostForm.php", FORM), ("app/Livewire/EditPost.php", EDIT), ("app/Models/Post.php", MODELS), ("resources/views/livewire/edit-post.blade.php", view)];
    files.extend_from_slice(extra);
    Fixture::new(&files)
}

fn problems(view: &str, extra: &[(&str, &str)]) -> Vec<String> {
    let fx = fixture(view, extra);
    with_ctx(&fx.snap, &uri("resources/views/livewire/edit-post.blade.php"), super::diagnostics).unwrap().into_iter().map(|d| d.message).collect()
}

fn complete(fx: &Fixture) -> Vec<String> {
    let at = fx.at();
    let mut labels: Vec<String> = with_ctx_at(&fx.snap, &at.text_document.uri, at.position, |ctx| crate::framework::completion(ctx, ctx.offset(at.position)))
        .flatten()
        .unwrap_or_default()
        .into_iter()
        .map(|i| i.label)
        .collect();
    labels.sort();
    labels
}

fn hover(fx: &Fixture) -> String {
    let at = fx.at();
    let hover = with_ctx(&fx.snap, &at.text_document.uri, |ctx| crate::framework::hover(ctx, ctx.offset(at.position))).flatten();
    match hover.map(|h| h.contents) {
        Some(HoverContents::Markup(m)) => m.value,
        _ => String::new(),
    }
}

fn definition(fx: &Fixture) -> Vec<(String, u32)> {
    let at = fx.at();
    with_ctx(&fx.snap, &at.text_document.uri, |ctx| crate::framework::definition(ctx, ctx.offset(at.position)))
        .unwrap_or_default()
        .into_iter()
        .map(|l| (l.uri.as_str().rsplit('/').next().unwrap_or_default().to_string(), l.range.start.line))
        .collect()
}

#[test]
fn checks_wire_model_and_actions_against_the_component() {
    let view = "<form wire:submit=\"save\">\n<input wire:model.live.debounce.250ms=\"form.title\">\n<input wire:model=\"serach\">\n<input wire:model.blur=\"form.titel\">\n<button wire:click=\"delete(1)\">x</button>\n<button wire:click=\"helper\">x</button>\n<button wire:click=\"$set('form.body', '')\" wire:keydown.enter=\"$refresh\">x</button>\n<button wire:click=\"$toggle('nope')\">x</button>\n</form>";
    assert_eq!(
        problems(view, &[]),
        vec![
            "Property [$serach] not found on component [App\\Livewire\\EditPost].",
            "Property [$titel] not found on form [App\\Livewire\\Forms\\PostForm].",
            "Method [delete] not found on component [App\\Livewire\\EditPost].",
            "Method [helper] not found on component [App\\Livewire\\EditPost].",
            "Property [$nope] not found on component [App\\Livewire\\EditPost].",
        ]
    );
}

#[test]
fn warns_only_when_sure() {
    // Static properties aren't bound, but the rest here is fine or can't be known.
    let fine = "<input wire:model=\"search\"> <input wire:model=\"{{ $field }}\"> <input wire:model=\"$parent.x\">\n<input wire:model=\"search.{{ $i }}\">\n<button wire:click=\"save(); other()\" wire:click.outside=\"obj.run()\" wire:loading=\"nope\" wire:target=\"nope\" wire:navigate>x</button>\n<div x-data=\"{ a: $wire.nope }\" wire:poll.5s></div>";
    assert!(problems(fine, &[]).is_empty(), "{:?}", problems(fine, &[]));
    // A `__get()` or `__call()` of the component's own answers for any name.
    let magic = EDIT.replace("protected function helper(): void {}", "public function __get($p) {}\n    public function __call($m, $a) {}");
    let unknown = "<input wire:model=\"anything\"> <button wire:click=\"whatever\">x</button>";
    assert!(problems(unknown, &[("app/Livewire/EditPost.php", &magic)]).is_empty());
    // A parent the index doesn't have may declare anything.
    let orphan = EDIT.replace("extends \\Livewire\\Component", "extends \\Vendor\\Missing\\Base");
    assert!(problems(unknown, &[("app/Livewire/EditPost.php", &orphan)]).is_empty());
    // A view no component renders isn't checked.
    let fx = fixture("", &[("resources/views/other.blade.php", unknown)]);
    assert!(with_ctx(&fx.snap, &uri("resources/views/other.blade.php"), super::diagnostics).unwrap().is_empty());
    // Members from a parent class and a trait count.
    let base = "<?php\nnamespace App\\Livewire;\ntrait Sorts { public string $sort = ''; public function sortBy(): void {} }\nabstract class Base extends \\Livewire\\Component { use Sorts; public function close(): void {} }\n";
    let child = EDIT.replace("extends \\Livewire\\Component", "extends Base");
    let inherited = "<input wire:model=\"sort\"> <button wire:click=\"sortBy\" wire:dblclick=\"close\">x</button>";
    assert!(problems(inherited, &[("app/Livewire/Base.php", base), ("app/Livewire/EditPost.php", &child)]).is_empty());
}

#[test]
fn finds_a_views_component_by_convention_and_by_a_view_property() {
    let counter = "<?php\nnamespace App\\Livewire\\Admin;\nclass UserCounter extends \\Livewire\\Component { public int $count = 0; }\n";
    let page = "<?php\nnamespace App\\Filament;\nclass Settings extends \\Livewire\\Component { protected string $view = 'filament.settings'; public function submit(): void {} }\n";
    let fx = fixture("", &[("app/Livewire/Admin/UserCounter.php", counter), ("app/Filament/Settings.php", page), ("resources/views/livewire/admin/user-counter.blade.php", "<b wire:click=\"nope\"></b>"), ("resources/views/filament/settings.blade.php", "<form wire:submit=\"nope\"></form>")]);
    let check = |view: &str| with_ctx(&fx.snap, &uri(view), super::diagnostics).unwrap().into_iter().map(|d| d.message).collect::<Vec<_>>();
    assert_eq!(check("resources/views/livewire/admin/user-counter.blade.php"), vec!["Method [nope] not found on component [App\\Livewire\\Admin\\UserCounter]."]);
    assert_eq!(check("resources/views/filament/settings.blade.php"), vec!["Method [nope] not found on component [App\\Filament\\Settings]."]);
    // A layout that `->layout()` names isn't the component's view.
    let fx = fixture("", &[("resources/views/layouts/app.blade.php", "<b wire:click=\"nope\"></b>")]);
    assert!(with_ctx(&fx.snap, &uri("resources/views/layouts/app.blade.php"), super::diagnostics).unwrap().is_empty());
}

#[test]
fn completes_members_in_wire_attributes_and_wire_in_alpine() {
    let at = |view: &str| complete(&fixture(view, &[]));
    assert_eq!(at("<input wire:model.live=\"<|>\">"), vec!["form", "search"]);
    assert_eq!(at("<input wire:model=\"form.<|>\">"), vec!["body", "title"]);
    let methods = at("<button wire:click=\"<|>\">");
    assert!(methods.contains(&"save".to_string()) && methods.contains(&"$refresh".to_string()), "{methods:?}");
    // Lifecycle hooks, protected methods, and computed properties aren't actions.
    assert!(!methods.iter().any(|m| ["mount", "render", "helper", "posts"].contains(&m.as_str())), "{methods:?}");
    assert_eq!(at("<button wire:click=\"$set('<|>')\">"), vec!["form", "search"]);
    let wire = at("<div x-data=\"{ open: $wire.<|> }\">");
    assert!(wire.contains(&"search".to_string()) && wire.contains(&"save".to_string()) && wire.contains(&"$entangle".to_string()), "{wire:?}");
    assert_eq!(at("<script>$wire.form.<|></script>"), vec!["body", "title"]);
    assert_eq!(at("<div x-init=\"$wire.$watch('<|>')\">"), vec!["form", "search"]);
}

#[test]
fn completes_a_livewire_tags_properties_and_mount_parameters() {
    let tag = "<?php\nnamespace App\\Livewire;\nclass ShowPost extends \\Livewire\\Component { public int $postId = 0; public function mount(\\App\\Models\\Post $post, bool $compact = false): void {} }\n";
    let fx = fixture("", &[("app/Livewire/ShowPost.php", tag), ("resources/views/page.blade.php", "<livewire:show-post :<|> />")]);
    assert_eq!(complete(&fx), vec!["compact", "post", "postId"]);
}

#[test]
fn shows_and_goes_to_members() {
    let fx = fixture("<input wire:model=\"sea<|>rch\">", &[]);
    assert!(hover(&fx).contains("public string $search"), "{}", hover(&fx));
    assert_eq!(definition(&fx), vec![("EditPost.php".into(), 7)]);
    let fx = fixture("<button wire:click=\"sa<|>ve(1)\">", &[]);
    assert!(hover(&fx).contains("function save(int $id = 0): void"), "{}", hover(&fx));
    assert_eq!(definition(&fx), vec![("EditPost.php".into(), 10)]);
    let fx = fixture("<input wire:model=\"form.ti<|>tle\">", &[]);
    assert_eq!(definition(&fx), vec![("PostForm.php".into(), 3)]);
}

#[test]
fn types_computed_properties_in_the_class_and_its_view() {
    let class = EDIT.replace("public function mount(): void {}", "public function mount(): void { $t = $this->posts->titel; $u = $this->getPostsTitle(); }\n    public function getPostsTitleProperty(): string { return ''; }");
    let fx = fixture("{{ $this->posts->titel }}", &[("app/Livewire/EditPost.php", &class)]);
    let doc = fx.doc("app/Livewire/EditPost.php");
    let found: Vec<String> = crate::diagnostics::php_problems_in(&fx.snap.index.read(), &doc).into_iter().map(|d| d.message).collect();
    assert!(found.iter().any(|m| m.contains("titel")), "{found:?}");
    // In the view, `$this` is the component.
    let view = fx.doc("resources/views/livewire/edit-post.blade.php");
    let view = crate::documents::Document::new(view.uri.clone(), view.path.clone(), "blade".into(), 1, view.text.clone());
    let found: Vec<String> = crate::diagnostics::blade_problems_in(&fx.snap.index.read(), &view, &|p| fx.snap.read(p), None).into_iter().map(|d| d.message).collect();
    assert!(found.iter().any(|m| m.contains("titel")), "{found:?}");
    // Livewire renders the view in the component's scope, so its protected members are in reach.
    let fx = fixture("{{ $this->secret }} {{ $this->helper() }} {{ $this->posts->title }}", &[]);
    let view = fx.doc("resources/views/livewire/edit-post.blade.php");
    let view = crate::documents::Document::new(view.uri.clone(), view.path.clone(), "blade".into(), 1, view.text.clone());
    let found: Vec<String> = crate::diagnostics::blade_problems_in(&fx.snap.index.read(), &view, &|p| fx.snap.read(p), None).into_iter().map(|d| d.message).collect();
    assert!(found.is_empty(), "{found:?}");
    let doc = fx.doc("app/Livewire/EditPost.php");
    let class = crate::diagnostics::php_problems_in(&fx.snap.index.read(), &doc).into_iter().filter(|d| d.source.as_deref() == Some("mago")).map(|d| d.message).collect::<Vec<_>>();
    assert!(!class.iter().any(|m| m.contains("posts")), "{class:?}");
}

#[test]
fn links_dispatched_events_to_their_listeners() {
    let feed = "<?php\nnamespace App\\Livewire;\nclass Feed extends \\Livewire\\Component {\n    protected $listeners = ['feed-refresh' => 'reload'];\n    public function reload(): void {}\n    public function add(): void { $this->dispatch('post-<|>created'); }\n}\n";
    let fx = fixture("", &[("app/Livewire/Feed.php", feed)]);
    assert!(hover(&fx).contains("App\\Livewire\\EditPost::refreshList"), "{}", hover(&fx));
    assert_eq!(definition(&fx), vec![("EditPost.php".into(), 15)]);
    let fx = fixture("", &[("app/Livewire/Feed.php", &feed.replace("post-<|>created", "<|>"))]);
    assert_eq!(complete(&fx), vec!["feed-refresh", "post-created"]);
    // From Blade, and from a listener back to its dispatches.
    let fx = fixture("<button wire:click=\"$dispatch('<|>')\">", &[("app/Livewire/Feed.php", &feed.replace("<|>", ""))]);
    assert_eq!(complete(&fx), vec!["feed-refresh", "post-created"]);
    let on = EDIT.replace("#[On('post-created')]", "#[On('post-<|>saved')]");
    let fx = fixture("", &[("app/Livewire/EditPost.php", &on)]);
    assert!(hover(&fx).contains("Dispatched from"), "{}", hover(&fx));
    assert_eq!(definition(&fx), vec![("EditPost.php".into(), 10)]);
}

#[test]
fn reads_volt_components_in_their_views() {
    let view = "<?php\nuse Livewire\\Volt\\Component;\nnew class extends Component {\n    public string $name = '';\n    public function greet(): void {}\n};\n?>\n<input wire:model=\"nmae\"> <button wire:click=\"greet\" wire:dblclick=\"nope\">x</button>\n<input wire:model=\"na<|>me\">";
    let fx = Fixture::new(&[("vendor/livewire.php", LIVEWIRE), ("resources/views/livewire/greeter.blade.php", view)]);
    let found: Vec<String> = with_ctx(&fx.snap, &uri("resources/views/livewire/greeter.blade.php"), super::diagnostics).unwrap().into_iter().map(|d| d.message).collect();
    assert_eq!(found, vec!["Property [$nmae] not found on this Volt component.", "Method [nope] not found on this Volt component."]);
    assert!(hover(&fx).contains("public string $name"), "{}", hover(&fx));
    assert_eq!(definition(&fx), vec![("greeter.blade.php".into(), 3)]);
}


/// Runs the Livewire checks over a real app and prints what they find, which should all be real: its views and the
/// views of the Filament and Livewire packages in its `vendor`, by the classes that render them, and the events its
/// code dispatches. `TUSK_LARAVEL_APP=<root> cargo test -- --ignored --nocapture livewire_in_a_real_app`.
#[test]
#[ignore]
fn livewire_in_a_real_app() {
    use std::path::PathBuf;
    use std::sync::Arc;

    use crate::documents::{Document, Documents};
    use crate::index::{Index, IndexConfig};
    use crate::server::Snapshot;
    use crate::text::path_to_uri;

    let Ok(root) = std::env::var("TUSK_LARAVEL_APP") else { return };
    let root = PathBuf::from(root);
    crate::testing::on_server_stack(|| {
        let mut index = Index::empty(IndexConfig::new(&root));
        let paths = index.discover();
        index.build(paths, |p| std::fs::read(p).ok(), |_, _| {});
        let index = Arc::new(parking_lot::RwLock::new(index));
        let framework = Arc::new(crate::framework::State::new(root.clone()));
        let snap_for = |path: &PathBuf, text: &str| {
            let mut docs = Documents::default();
            docs.insert(Document::new(path_to_uri(path), path.clone(), "php".into(), 1, text.to_string()));
            Snapshot { docs, index: index.clone(), root: root.clone(), framework: framework.clone(), client: None, cancel: Default::default() }
        };
        // Package views, by the Livewire classes in `vendor` that render them: `filament-panels::x` is in
        // `vendor/filament/panels/resources/views/x.blade.php`.
        let mut package: Vec<(PathBuf, Vec<String>)> = vec![];
        {
            let index = index.read();
            let mut by_view: std::collections::BTreeMap<PathBuf, Vec<String>> = Default::default();
            let vendor: Vec<PathBuf> = ignore::WalkBuilder::new(root.join("vendor")).standard_filters(false).build().flatten().map(|e| e.into_path()).filter(|p| p.extension().is_some_and(|e| e == "php") && !p.to_string_lossy().ends_with(".blade.php") && p.to_string_lossy().contains("/src/")).collect();
            for path in vendor {
                let Ok(text) = std::fs::read_to_string(&path) else { continue };
                if !text.contains("view") || !text.contains("Livewire") && !text.contains("extends") {
                    continue;
                }
                for (view, class) in super::rendered_views(&index, &path, &text).iter() {
                    let Some((ns, rel)) = view.split_once("::") else { continue };
                    // The package whose folder the namespace names, as `filament-panels` names `filament/panels`.
                    let pkg = ns.strip_prefix("filament-").unwrap_or(ns);
                    let Some(file) = std::fs::read_dir(root.join("vendor")).into_iter().flatten().flatten().flat_map(|vendor| std::fs::read_dir(vendor.path()).into_iter().flatten().flatten()).map(|dir| dir.path()).filter(|dir| dir.file_name().is_some_and(|n| n == pkg || n == ns)).map(|dir| dir.join(format!("resources/views/{}.blade.php", rel.replace('.', "/")))).find(|f| f.is_file()) else { continue };
                    {
                        let classes = by_view.entry(file).or_default();
                        if !classes.contains(class) {
                            classes.push(class.clone());
                        }
                    }
                }
            }
            package.extend(by_view);
        }
        let (mut views, mut resolved, mut refs_total, mut refs_found, mut reported) = (0, 0, 0, 0, 0);
        let report = |rel: &str, text: &str, component: &super::Component, snap: &Snapshot, path: &PathBuf, reported: &mut usize, refs_total: &mut usize, refs_found: &mut usize| {
            let scan = super::view::scan(text);
            let refs = super::view::refs(text, &scan);
            let lines = crate::text::LineIndex::new(text);
            with_ctx(snap, &path_to_uri(path), |ctx| {
                for r in &refs {
                    *refs_total += 1;
                    let found = super::view::definition(ctx, r.start as u32);
                    if found.is_empty() {
                        eprintln!("unresolved {rel}:{} {:?} `{}`", lines.position(text, r.start as u32).line + 1, r.kind, &text[r.start..r.end]);
                    } else {
                        *refs_found += 1;
                    }
                }
                for d in super::view::diagnostics(ctx) {
                    *reported += 1;
                    eprintln!("problem {rel}:{} {}", d.range.start.line + 1, d.message);
                }
                let _ = component;
            });
        };
        for path in crate::framework::laravel::views::blade_views(&root) {
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            views += 1;
            let snap = snap_for(&path, &text);
            let index_guard = index.read();
            let component = super::view_component(&index_guard, &|p| snap.read(p).or_else(|| std::fs::read_to_string(p).ok()), &path, &text);
            drop(index_guard);
            let Some(component) = component else { continue };
            resolved += 1;
            let rel = path.strip_prefix(&root).unwrap().display().to_string();
            eprintln!("view {rel} -> {:?} ({} members, props known {}, methods known {})", component.classes, component.members.len(), component.all_properties, component.all_methods);
            report(&rel, &text, &component, &snap, &path, &mut reported, &mut refs_total, &mut refs_found);
            // The view's PHP, with `$this` as the component.
            let doc = Document::new(path_to_uri(&path), path.clone(), "blade".into(), 1, text.clone());
            for d in crate::diagnostics::blade_problems_in(&index.read(), &doc, &|p| std::fs::read_to_string(p).ok(), None) {
                eprintln!("php {rel}:{} [{:?}] {}", d.range.start.line + 1, d.code, d.message);
            }
        }
        let package_views = package.len();
        for (path, classes) in &package {
            let text = std::fs::read_to_string(path).unwrap_or_default();
            let component = super::component_of(&index.read(), classes.clone());
            let rel = path.strip_prefix(&root).unwrap().display().to_string();
            // A package view is checked against the classes that render it, as the app's are.
            let scan = super::view::scan(&text);
            let refs = super::view::refs(&text, &scan);
            let lines = crate::text::LineIndex::new(&text);
            for r in refs.iter() {
                refs_total += 1;
                let name = &text[r.start..r.end];
                let found = match &r.kind {
                    super::view::RefKind::Property => component.member(name, &[super::MemberKind::Property]).is_some(),
                    super::view::RefKind::Method => component.member(name, &[super::MemberKind::Method]).is_some(),
                    super::view::RefKind::Member => component.member(name, &[super::MemberKind::Property, super::MemberKind::Method]).is_some(),
                    super::view::RefKind::FormProperty(_) => true,
                };
                refs_found += usize::from(found);
                let sure = r.checked && match &r.kind {
                    super::view::RefKind::Property => component.all_properties,
                    super::view::RefKind::Method => component.all_methods,
                    _ => false,
                };
                if !found && sure {
                    reported += 1;
                    eprintln!("problem {rel}:{} {:?} `{name}` on {:?}", lines.position(&text, r.start as u32).line + 1, r.kind, classes);
                }
            }
        }
        // Events: each dispatch with what listens for it.
        let sites = super::events::sites(&index.read(), &|p| std::fs::read_to_string(p).ok());
        for s in sites.iter().filter(|s| s.role == super::events::Role::Dispatch) {
            let heard = sites.iter().filter(|l| l.role != super::events::Role::Dispatch && l.name == s.name).count();
            eprintln!("event {} dispatched at {}:{} heard by {heard}", s.name, s.path.strip_prefix(&root).unwrap_or(&s.path).display(), s.start);
        }
        eprintln!("{views} views, {resolved} Livewire views, {package_views} package views, {refs_total} references, {refs_found} resolved, {reported} problems, {} event sites", sites.len());
    });
}
