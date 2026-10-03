//! Eloquent's attributes in the analysis. A model reads its columns as properties through `__get()`, which Laravel
//! doesn't declare, so Mago types `$post->title` as `mixed` and reports it as a property that may not exist.
//! [`AttributeHook`] types it from the migrations' column and the model's casts ([`schema::attribute_type`]), and
//! drops the report for a column, a relationship, or an aggregate the file's queries add, such as the
//! `comments_count` of `withCount('comments')`.

use std::cell::RefCell;
use std::sync::Arc;

use mago_analyzer::code::IssueCode;
use mago_analyzer::plugin::{ExpressionHook, HookContext, HookResult, IssueFilterDecision, IssueFilterHook, Provider, ProviderMeta};
use mago_codex::metadata::CodebaseMetadata;
use mago_codex::ttype::atomic::TAtomic;
use mago_codex::ttype::atomic::object::TObject;
use mago_codex::ttype::atomic::object::named::TNamedObject;
use mago_codex::ttype::union::TUnion;
use mago_codex::ttype::{get_bool, get_float, get_int, get_mixed_keyed_array, get_null, get_numeric_string, get_string};
use mago_database::file::File;
use mago_reporting::{AnnotationKind, Issue};
use mago_span::HasSpan;
use mago_syntax::cst::{Access, Argument, ArrayElement, ClassLikeMemberSelector, Expression, Literal, Node, Program};

use super::forwarding::MODEL;
use super::schema::{self, Eloquent};

thread_local! {
    /// While a file is analyzed, the project's Eloquent facts and the aggregates the file's queries add.
    static FILE: RefCell<Option<(Arc<Eloquent>, Vec<Aggregate>)>> = const { RefCell::new(None) };
    /// Where this file reads attributes Laravel has, which Mago reports as properties that may not exist.
    static KNOWN: RefCell<Vec<(u32, u32)>> = const { RefCell::new(vec![]) };
}

/// Runs `f`, an analysis of `program`, with the project's Eloquent facts.
pub fn with_eloquent<T>(eloquent: Arc<Eloquent>, program: &Program<'_>, f: impl FnOnce() -> T) -> T {
    FILE.set(Some((eloquent, aggregates(program))));
    KNOWN.take();
    let out = f();
    FILE.take();
    KNOWN.take();
    out
}

/// An attribute a query adds to its models: `withCount('comments')` adds `comments_count`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Aggregate {
    pub name: String,
    /// The relationship it counts, without any alias: `comments`.
    pub relation: String,
    /// `count`, `exists`, `sum`, `avg`, `min`, or `max`.
    pub function: &'static str,
    /// Where the string naming it starts and ends.
    pub span: (u32, u32),
}

/// The methods that add aggregates, with the function each runs, and whether a column follows the relationship.
pub const AGGREGATE_METHODS: &[(&str, &str, bool)] = &[
    ("withcount", "count", false),
    ("loadcount", "count", false),
    ("withexists", "exists", false),
    ("withsum", "sum", true),
    ("loadsum", "sum", true),
    ("withavg", "avg", true),
    ("loadavg", "avg", true),
    ("withmin", "min", true),
    ("loadmin", "min", true),
    ("withmax", "max", true),
    ("loadmax", "max", true),
];

/// The attribute name Laravel gives an aggregate: `comments_count`, `items_sum_total`, or the alias of
/// `comments as approved_count`. Laravel's `withAggregate()` snake-cases the relationship, function, and column
/// with anything but letters, digits, spaces, and underscores taken out.
pub fn aggregate_name(relation: &str, function: &str, column: Option<&str>) -> (String, String) {
    if let Some((relation, alias)) = relation.split_once(" as ").or_else(|| relation.split_once(" AS ")) {
        return (alias.trim().to_string(), relation.trim().to_string());
    }
    let words = match column.filter(|c| *c != "*") {
        Some(column) => format!("{relation} {function} {column}"),
        None => format!("{relation} {function}"),
    };
    let cleaned: String = words.chars().filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '_').collect();
    // `Str::snake()` capitalizes each word, joins them, and splits them again at the capitals.
    let joined: String = cleaned
        .split_whitespace()
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect::<String>()).unwrap_or_default()
        })
        .collect();
    (schema::snake(&joined), relation.trim().to_string())
}

fn literal(expr: &Expression<'_>) -> Option<(String, (u32, u32))> {
    let Expression::Literal(Literal::String(s)) = expr else { return None };
    let value = String::from_utf8_lossy(s.value?).into_owned();
    Some((value, (s.span.start.offset + 1, s.span.end.offset.saturating_sub(1))))
}

/// The aggregates a call adds, if it's one of [`AGGREGATE_METHODS`]: from a string, a list of strings, or the keys of
/// an array of constraints.
pub fn call_aggregates(method: &[u8], arguments: &mago_syntax::cst::ArgumentList<'_>) -> Vec<Aggregate> {
    let Some((_, function, with_column)) = AGGREGATE_METHODS.iter().find(|(m, ..)| m.as_bytes().eq_ignore_ascii_case(method)) else { return vec![] };
    let args: Vec<&Expression<'_>> = arguments
        .arguments
        .iter()
        .map(|a| match a {
            Argument::Positional(p) => p.value,
            Argument::Named(n) => n.value,
        })
        .collect();
    let column = with_column.then(|| args.get(1).and_then(|e| literal(e)).map(|(c, _)| c)).flatten();
    if *with_column && column.is_none() {
        return vec![];
    }
    let mut relations = vec![];
    match args.first() {
        Some(Expression::Array(a)) => {
            for element in a.elements.iter() {
                match element {
                    ArrayElement::Value(v) => relations.extend(literal(v.value)),
                    ArrayElement::KeyValue(kv) => relations.extend(literal(kv.key)),
                    _ => {}
                }
            }
        }
        Some(e) => relations.extend(literal(e)),
        None => {}
    }
    relations
        .into_iter()
        .map(|(relation, span)| {
            let (name, relation) = aggregate_name(&relation, function, column.as_deref());
            Aggregate { name, relation, function, span }
        })
        .collect()
}

/// Every aggregate the queries in `program` add.
fn aggregates(program: &Program<'_>) -> Vec<Aggregate> {
    let mut out = vec![];
    let mut stack = vec![Node::Program(program)];
    while let Some(node) = stack.pop() {
        match node {
            Node::MethodCall(c) => out.extend(selector(&c.method).map(|m| call_aggregates(m, &c.argument_list)).unwrap_or_default()),
            Node::NullSafeMethodCall(c) => out.extend(selector(&c.method).map(|m| call_aggregates(m, &c.argument_list)).unwrap_or_default()),
            Node::StaticMethodCall(c) => out.extend(selector(&c.method).map(|m| call_aggregates(m, &c.argument_list)).unwrap_or_default()),
            _ => {}
        }
        node.visit_children(|child| stack.push(child));
    }
    out
}

fn selector<'a>(s: &ClassLikeMemberSelector<'a>) -> Option<&'a [u8]> {
    match s {
        ClassLikeMemberSelector::Identifier(id) => Some(id.value),
        _ => None,
    }
}

/// A type written as PHP writes it, such as `bool|int` or `\Illuminate\Support\Carbon`, as Mago's type; `None` when it
/// names a class the index doesn't have.
fn union_of(codebase: &CodebaseMetadata, ty: &str, nullable: bool) -> Option<TUnion> {
    let (ty, lenient) = match ty.strip_suffix("|lenient-null") {
        Some(ty) => (ty, true),
        None => (ty, false),
    };
    let mut atomics: Vec<TAtomic> = vec![];
    for part in ty.split('|') {
        let t = match part {
            "int" => get_int(),
            "string" => get_string(),
            "numeric-string" => get_numeric_string(),
            "float" => get_float(),
            "bool" => get_bool(),
            "array" => get_mixed_keyed_array(),
            class => {
                let class = codebase.get_class_like(class.trim_start_matches('\\').as_bytes())?;
                TUnion::from_atomic(TAtomic::Object(TObject::Named(TNamedObject::new(class.original_name))))
            }
        };
        atomics.extend(t.types.iter().cloned());
    }
    if nullable {
        atomics.extend(get_null().types.iter().cloned());
    }
    let mut t = TUnion::from_vec(atomics);
    t.set_ignore_nullable_issues(lenient);
    Some(t)
}

/// The attributes `$post->` reads through Eloquent on a model `class`: its columns with their types, its
/// relationships, and the aggregates the file's queries add. Empty for a class that isn't a model.
pub fn members(index: &crate::index::Index, program: &Program<'_>, class: &str) -> Vec<(String, String)> {
    let codebase = &index.codebase;
    if !codebase.is_instance_of(class.as_bytes(), MODEL.as_bytes()) {
        return vec![];
    }
    let eloquent = &index.eloquent;
    let mut out: Vec<(String, String)> = vec![];
    for column in eloquent.table_of(codebase, class).map(|t| t.columns.as_slice()).unwrap_or_default() {
        let ty = schema::attribute_type(eloquent, codebase, class, &column.name)
            .map(|(ty, nullable)| {
                let ty = ty.trim_end_matches("|lenient-null").trim_start_matches('\\').to_string();
                if nullable && !ty.contains('|') { format!("?{ty}") } else { ty }
            })
            .unwrap_or_else(|| "mixed".into());
        out.push((column.name.clone(), ty));
    }
    for r in eloquent.relations(codebase, class) {
        let related = r.related.as_deref().map(|c| c.rsplit('\\').next().unwrap_or(c)).unwrap_or("Model");
        out.push((r.name.clone(), format!("{related} ({})", r.kind)));
    }
    for a in aggregates(program) {
        out.push((a.name, match a.function { "count" => "int", "exists" => "bool", _ => "mixed" }.to_string()));
    }
    out
}

pub struct AttributeHook;

impl Provider for AttributeHook {
    fn meta() -> &'static ProviderMeta {
        static META: ProviderMeta = ProviderMeta::new("tusk-eloquent-attributes", "Eloquent attributes", "Types a model's columns and aggregates read as properties.");
        &META
    }
}

impl ExpressionHook for AttributeHook {
    fn after_expression(&self, expr: &Expression<'_>, context: &mut HookContext<'_, '_>) -> HookResult<()> {
        let (object, property) = match expr {
            Expression::Access(Access::Property(a)) => (a.object, &a.property),
            Expression::Access(Access::NullSafeProperty(a)) => (a.object, &a.property),
            _ => return Ok(()),
        };
        let Some(name) = selector(property) else { return Ok(()) };
        // Only what Mago couldn't type: a declared property or an `@property` tag answers itself.
        if context.get_expression_type(expr).is_some_and(|t| !t.is_mixed()) {
            return Ok(());
        }
        let Some(receiver) = context.get_expression_type(object) else { return Ok(()) };
        let classes: Vec<String> = receiver
            .types
            .iter()
            .filter_map(|a| match a {
                TAtomic::Object(TObject::Named(n)) => Some(n.name.as_str_lossy().into_owned()),
                _ => None,
            })
            .collect();
        let [class] = classes.as_slice() else { return Ok(()) };
        if !context.is_instance_of(class.as_bytes(), MODEL.as_bytes()) {
            return Ok(());
        }
        let name = String::from_utf8_lossy(name).into_owned();
        let codebase = context.codebase();
        let Some((t, known)) = FILE.with_borrow(|file| {
            let (eloquent, aggregates) = file.as_ref()?;
            if let Some(a) = aggregates.iter().find(|a| a.name == name) {
                let t = match a.function {
                    "count" => Some(get_int()),
                    "exists" => Some(get_bool()),
                    // A sum or an average comes back as the database gives it: an int, a float, or a numeric string.
                    _ => None,
                };
                return Some((t, true));
            }
            let class = codebase.get_class_like(class.as_bytes())?.original_name.as_str_lossy().into_owned();
            if let Some((ty, nullable)) = schema::attribute_type(eloquent, codebase, &class, &name) {
                return Some((union_of(codebase, &ty, nullable), true));
            }
            let column = eloquent.table_of(codebase, &class).is_some_and(|t| t.column(&name).is_some());
            let relation = eloquent.relations(codebase, &class).iter().any(|r| r.name == name);
            Some((None, column || relation))
        }) else {
            return Ok(());
        };
        if known {
            let span = expr.span();
            KNOWN.with_borrow_mut(|k| k.push((span.start.offset, span.end.offset)));
        }
        if let Some(t) = t {
            // Mago remembers `$post->title` as a variable after its first use, as it does a declared property, so
            // the next read, and narrowing such as a null check, see the type too.
            if let (Expression::Variable(mago_syntax::cst::Variable::Direct(v)), Expression::Access(Access::Property(_))) = (object, expr) {
                let id = [v.name, b"->", name.as_bytes()].concat();
                if context.get_variable_type(&id).is_none_or(|t| t.is_mixed()) {
                    context.set_variable_type(&id, t.clone());
                }
            }
            context.set_expression_type(expr, t);
        }
        Ok(())
    }
}

impl IssueFilterHook for AttributeHook {
    /// Laravel has the attribute, so the report that it may not exist goes.
    fn filter_issue(&self, _: &File, issue: &Issue) -> HookResult<IssueFilterDecision> {
        if issue.code.as_deref() != Some(IssueCode::NonDocumentedProperty.as_str()) {
            return Ok(IssueFilterDecision::Keep);
        }
        let Some(at) = issue.annotations.iter().find(|a| a.kind == AnnotationKind::Primary).map(|a| a.span.start.offset) else { return Ok(IssueFilterDecision::Keep) };
        let known = KNOWN.with_borrow(|k| k.iter().any(|(s, e)| *s <= at && at < *e));
        Ok(if known { IssueFilterDecision::Remove } else { IssueFilterDecision::Keep })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fixture;
    use lsp_types::NumberOrString;

    const LARAVEL: &str = "<?php\nnamespace Illuminate\\Database\\Eloquent { abstract class Model { public function __get($key) { return null; } public static function query() {} } }\nnamespace Illuminate\\Database\\Eloquent\\Relations { class BelongsTo {} }\nnamespace Illuminate\\Support { class Carbon { public function format(string $f): string { return ''; } } }\n";
    const MODELS: &str = "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Post extends Model {\n    protected $casts = ['meta' => 'array', 'rating' => 'App\\\\Casts\\\\Custom'];\n    public function author() { return $this->belongsTo(User::class); }\n}\nclass User extends Model {}\n";
    const MIGRATION: &str = "<?php\nreturn new class {\n    public function up(): void {\n        Schema::create('posts', function ($table) {\n            $table->id();\n            $table->string('title');\n            $table->text('body')->nullable();\n            $table->json('meta');\n            $table->integer('rating');\n            $table->foreignId('author_id');\n            $table->timestamps();\n        });\n    }\n};\n";

    /// Mago's problems in `code`, and the type it gives the expression `$x` is assigned.
    fn check(code: &str) -> Vec<(String, u32)> {
        let fx = Fixture::new(&[("vendor/laravel.php", LARAVEL), ("app/Models/Post.php", MODELS), ("database/migrations/2024_01_01_000000_create_posts.php", MIGRATION), ("app/f.php", code)]);
        crate::diagnostics::php_problems(&fx.snap.index, &fx.doc("app/f.php"))
            .into_iter()
            .filter_map(|d| match d.code { Some(NumberOrString::String(c)) if d.source.as_deref() == Some("mago") => Some((c, d.range.start.line)), _ => None })
            .collect()
    }

    #[test]
    fn types_columns_from_migrations_and_casts() {
        let code = "<?php\nuse App\\Models\\Post;\nfunction f(Post $post): void {\n    $post->title->x();\n    $post->body->x();\n    $post->meta->x();\n    $post->created_at->format('Y');\n    $post->created_at->nope();\n    $post->rating->x();\n    $post->author->x();\n    $post->titel;\n}\n";
        let found = check(code);
        // A string, a nullable string, an array, a Carbon (Laravel fills timestamps on save); a custom cast and a
        // relationship stay unknown.
        assert!(found.contains(&("invalid-method-access".into(), 3)), "{found:?}");
        assert!(found.iter().any(|(c, l)| *l == 4 && c.contains("null")), "{found:?}");
        assert!(found.contains(&("invalid-method-access".into(), 5)), "{found:?}");
        assert!(!found.iter().any(|(_, l)| *l == 6), "{found:?}");
        assert!(found.iter().any(|(c, l)| *l == 7 && c == "non-existent-method"), "{found:?}");
        // Known attributes aren't reported as properties that may not exist; a misspelling is.
        let reported: Vec<u32> = found.iter().filter(|(c, _)| c == "non-documented-property").map(|(_, l)| *l).collect();
        assert_eq!(reported, vec![10], "{found:?}");
    }

    #[test]
    fn leaves_columns_untyped_when_casts_are_declared_where_the_project_isnt_read() {
        // Sanctum's token casts `expires_at` in `vendor`, and a package trait may merge casts when it initializes.
        let vendor = "<?php\nnamespace Laravel\\Sanctum { class PersonalAccessToken extends \\Illuminate\\Database\\Eloquent\\Model { protected $casts = ['expires_at' => 'datetime']; } }\nnamespace Pkg { trait Translates { public function initializeTranslates(): void {} } }\n";
        let models = "<?php\nnamespace App\\Models;\nclass Page extends \\Illuminate\\Database\\Eloquent\\Model { use \\Pkg\\Translates; }\nclass Note extends \\Illuminate\\Database\\Eloquent\\Model {}\n";
        let migration = "<?php\nreturn new class {\n    public function up(): void {\n        Schema::create('personal_access_tokens', function ($table) { $table->id(); $table->timestamp('expires_at')->nullable(); });\n        Schema::create('pages', function ($table) { $table->id(); $table->json('title'); });\n        Schema::create('notes', function ($table) { $table->id(); $table->string('body'); });\n    }\n};\n";
        let code = "<?php\nfunction f(\\Laravel\\Sanctum\\PersonalAccessToken $t, \\App\\Models\\Page $p, \\App\\Models\\Note $n): void {\n    $t->expires_at->isPast();\n    $p->title->x();\n    $n->body->x();\n}\n";
        let fx = Fixture::new(&[("vendor/laravel.php", LARAVEL), ("vendor/sanctum.php", vendor), ("app/Models/Page.php", models), ("database/migrations/2024_01_01_000000_create.php", migration), ("app/f.php", code)]);
        let found: Vec<(String, u32)> = crate::diagnostics::php_problems(&fx.snap.index, &fx.doc("app/f.php"))
            .into_iter()
            .filter_map(|d| match d.code { Some(NumberOrString::String(c)) if d.source.as_deref() == Some("mago") => Some((c, d.range.start.line)), _ => None })
            .collect();
        assert!(!found.iter().any(|(c, l)| c == "invalid-method-access" && (*l == 2 || *l == 3)), "{found:?}");
        // A model whose casts are all read is still typed.
        assert!(found.contains(&("invalid-method-access".into(), 4)), "{found:?}");
    }

    #[test]
    fn completes_attributes_after_the_arrow() {
        let code = "<?php\nuse App\\Models\\Post;\nfunction f(Post $post): void {\n    Post::query()->withCount('comments');\n    $post-><|>\n}\n";
        let fx = Fixture::new(&[("vendor/laravel.php", LARAVEL), ("app/Models/Post.php", MODELS), ("database/migrations/2024_01_01_000000_create_posts.php", MIGRATION), ("app/f.php", code)]);
        let params = lsp_types::CompletionParams { text_document_position: fx.at(), work_done_progress_params: Default::default(), partial_result_params: Default::default(), context: None };
        let Some(lsp_types::CompletionResponse::List(list)) = crate::features::completion::completion(&fx.snap, params).unwrap() else { panic!() };
        let detail = |name: &str| list.items.iter().find(|i| i.label == name && i.kind == Some(lsp_types::CompletionItemKind::PROPERTY)).and_then(|i| i.detail.clone());
        assert_eq!(detail("title").as_deref(), Some("string"));
        assert_eq!(detail("body").as_deref(), Some("?string"));
        assert_eq!(detail("created_at").as_deref(), Some("?Illuminate\\Support\\Carbon"));
        assert_eq!(detail("rating").as_deref(), Some("mixed"));
        assert_eq!(detail("author").as_deref(), Some("User (belongsTo)"));
        assert_eq!(detail("comments_count").as_deref(), Some("int"));
    }

    #[test]
    fn knows_the_aggregates_a_file_queries() {
        let code = "<?php\nuse App\\Models\\Post;\nfunction f(): void {\n    foreach (Post::query()->withCount(['comments', 'tags as tagged' => fn ($q) => $q])->withExists('author')->withSum('items', 'total')->get() as $post) {}\n    $post = new Post;\n    $post->comments_count->x();\n    $post->tagged->x();\n    $post->author_exists->x();\n    $post->items_sum_total;\n    $post->likes_count;\n}\n";
        let found = check(code);
        assert!(found.contains(&("invalid-method-access".into(), 5)), "{found:?}");
        assert!(found.contains(&("invalid-method-access".into(), 6)), "{found:?}");
        assert!(found.contains(&("invalid-method-access".into(), 7)), "{found:?}");
        let reported: Vec<u32> = found.iter().filter(|(c, _)| c == "non-documented-property").map(|(_, l)| *l).collect();
        assert_eq!(reported, vec![9], "{found:?}");
    }

    #[test]
    fn names_aggregates_as_laravel_does() {
        assert_eq!(aggregate_name("comments", "count", None).0, "comments_count");
        assert_eq!(aggregate_name("userPosts", "count", Some("*")).0, "user_posts_count");
        assert_eq!(aggregate_name("items", "sum", Some("total_amount")).0, "items_sum_total_amount");
        assert_eq!(aggregate_name("posts", "exists", None).0, "posts_exists");
        assert_eq!(aggregate_name("comments as approved_count", "count", None), ("approved_count".into(), "comments".into()));
    }
}

/// What typing attributes changes in a real app's problems, file by file, against the same analysis without the
/// migrations and model declarations: `TUSK_LARAVEL_APP=<root> cargo test -- --ignored --nocapture
/// attributes_in_a_real_app`. Every added problem should be real.
#[cfg(test)]
#[test]
#[ignore]
fn attributes_in_a_real_app() {
    use crate::documents::Document;
    use crate::index::{Index, IndexConfig};
    use crate::text::path_to_uri;
    let Ok(root) = std::env::var("TUSK_LARAVEL_APP") else { return };
    let root = std::path::PathBuf::from(root);
    crate::testing::on_server_stack(|| {
        let mut index = Index::empty(IndexConfig::new(&root));
        let paths = index.discover();
        index.build(paths, |p| std::fs::read(p).ok(), |_, _| {});
        let eloquent = index.eloquent.clone();
        let certain = eloquent.tables.values().filter(|t| eloquent.is_certain(t)).count();
        eprintln!("{} tables ({certain} certain), {} model declarations, all uncertain: {}", eloquent.tables.len(), eloquent.models.len(), eloquent.all_uncertain);
        let models: Vec<String> = index
            .codebase
            .class_likes
            .values()
            .filter(|c| index.is_project_file(c.span.file_id) && index.codebase.is_instance_of(c.name.as_bytes(), MODEL.as_bytes()))
            .map(|c| c.original_name.as_str_lossy().into_owned())
            .collect();
        for model in &models {
            let table = eloquent.table_name(&index.codebase, model);
            let found = eloquent.table(&table).map(|t| format!("{} columns{}", t.columns.len(), if eloquent.is_certain(t) { "" } else { ", uncertain" }));
            eprintln!("  {model} -> {table}: {}", found.unwrap_or_else(|| "no migration".into()));
        }
        let mut files: Vec<std::path::PathBuf> = index.project_files().filter(|p| !p.starts_with(root.join("vendor"))).map(|p| p.to_path_buf()).collect();
        files.extend(ignore::WalkBuilder::new(root.join("resources/views")).build().flatten().map(|e| e.path().to_path_buf()).filter(|p| p.to_string_lossy().ends_with(".blade.php")));
        let read = |p: &std::path::Path| std::fs::read_to_string(p).ok();
        let (mut added, mut removed) = (0, 0);
        for path in files {
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let blade = path.to_string_lossy().ends_with(".blade.php");
            let doc = Document::new(path_to_uri(&path), path.clone(), if blade { "blade" } else { "php" }.into(), 1, text);
            let problems = |index: &Index| if blade { crate::diagnostics::blade_problems_in(index, &doc, &read, None) } else { crate::diagnostics::php_problems_in(index, &doc) };
            let key = |d: &lsp_types::Diagnostic| format!("{}:{} {:?} {}", d.range.start.line + 1, d.range.start.character, d.code, d.message.lines().next().unwrap_or_default());
            index.eloquent = eloquent.clone();
            let with: Vec<String> = problems(&index).iter().map(key).collect();
            index.eloquent = Default::default();
            let without: Vec<String> = problems(&index).iter().map(key).collect();
            let rel = path.strip_prefix(&root).unwrap().display().to_string();
            for d in with.iter().filter(|d| !without.contains(d)) {
                added += 1;
                eprintln!("+ {rel}:{d}");
            }
            for d in without.iter().filter(|d| !with.contains(d)) {
                removed += 1;
                eprintln!("- {rel}:{d}");
            }
        }
        eprintln!("{added} problems added, {removed} gone");
    });
}
