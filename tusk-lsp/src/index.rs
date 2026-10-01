//! The project index: the project's PHP files, its `vendor` folder, and PHP's built-in stubs, scanned into one
//! populated [`CodebaseMetadata`] that answers "what is this class, method, or function".
//!
//! Library code is loaded only as far as the project reaches it: every library file's declared names are
//! known, but its symbols are loaded when the project names them, or when something loaded depends on them
//! (a parent, a trait, a class in a signature). A project typically reaches a tenth of its `vendor` classes.
//!
//! Each file's scan is merged in on its own, so a change replaces that file's symbols and repopulates only
//! them and the classes that inherit from them.

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use foldhash::HashSet;
use globset::{Glob, GlobBuilder, GlobSet, GlobSetBuilder};
use mago_allocator::LocalArena;
use mago_codex::metadata::{CodebaseEntryKeys, CodebaseMetadata};
use mago_codex::symbol::SymbolKind;
use mago_codex::ttype::atomic::TAtomic;
use mago_codex::ttype::atomic::object::TObject;
use mago_codex::ttype::atomic::object::named::TNamedObject;
use mago_codex::ttype::atomic::reference::TReference;
use mago_codex::ttype::union::TUnion;
use mago_codex::ttype::{TType, TypeRef};
use mago_span::Span;
use mago_codex::populator::populate_codebase;
use mago_codex::reference::SymbolReferences;
use mago_codex::scanner::scan_program;
use mago_database::file::{File, FileId, FileType};
use mago_names::resolver::NameResolver;
use mago_php_version::PHPVersion;
use mago_prelude::Prelude;
use mago_word::{Word, WordSet};
use rayon::prelude::*;

use crate::analysis::Parsed;

/// Folders never indexed, relative to the project root. `vendor`'s tests and Composer's generated files only
/// add duplicate or unused classes.
pub const DEFAULT_EXCLUDES: &[&str] = &[
    "vendor/**/Tests/**",
    "vendor/**/tests/**",
    "vendor/composer/**",
    "vendor/rector/rector/stubs-rector/**",
    "node_modules/**",
    "storage/**",
    "bootstrap/cache/**",
];

#[derive(Debug, Clone)]
pub struct IndexConfig {
    pub root: PathBuf,
    /// Globs relative to the root, added to [`DEFAULT_EXCLUDES`]. A glob without a wildcard excludes a folder.
    pub exclude: Vec<String>,
    /// Extra files or folders scanned as library code, such as generated Facade alias stubs.
    pub stubs: Vec<PathBuf>,
    pub php_version: PHPVersion,
    /// The project's Mago configuration, for the analyzer and linter.
    pub mago: Arc<crate::mago_config::MagoConfig>,
    /// Load every library file, not only what the project reaches. Uses several times the memory.
    pub load_all: bool,
    /// The file that keeps what each library file declares between starts, so unchanged files aren't parsed again.
    pub cache: Option<PathBuf>,
}

impl IndexConfig {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into(), exclude: vec![], stubs: vec![], php_version: PHPVersion::PHP84, mago: Default::default(), load_all: false, cache: None }
    }

    fn exclusions(&self) -> GlobSet {
        let mut set = GlobSetBuilder::new();
        for pattern in DEFAULT_EXCLUDES.iter().map(|p| p.to_string()).chain(self.exclude.iter().cloned()) {
            let pattern = pattern.trim_matches('/');
            // `vendor/aws` excludes the folder's contents too.
            for p in [pattern.to_string(), format!("{pattern}/**")] {
                if let Ok(glob) = Glob::new(&p) {
                    set.add(glob);
                }
            }
        }
        set.build().unwrap_or_else(|_| GlobSet::empty())
    }
}

/// What the index keeps of each loaded file: enough to take its symbols out again.
#[derive(Debug)]
pub struct IndexedFile {
    pub path: PathBuf,
    pub file_type: FileType,
    /// Everything the file declared; see [`Index::owned`] for which of it the index got from this file.
    keys: CodebaseEntryKeys,
}

/// What kind of symbol a declaration is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum DeclKind {
    Class(SymbolKind),
    Function,
    Constant,
}

/// A class, function, or constant a file declares, known whether or not the file is loaded.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Declared {
    /// The name as declared, fully qualified.
    pub name: Word,
    pub kind: DeclKind,
    pub is_abstract: bool,
    /// The span of the name.
    pub span: Span,
}

/// Where a declaration comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Origin {
    Project,
    Library,
    BuiltIn,
}

/// A library file, loaded or not.
#[derive(Debug)]
struct LibraryFile {
    path: PathBuf,
    file_type: FileType,
}

pub struct Index {
    pub config: IndexConfig,
    pub codebase: CodebaseMetadata,
    /// Loaded files: every project file, and the library files the project reaches.
    pub files: HashMap<FileId, IndexedFile>,
    by_path: HashMap<PathBuf, FileId>,
    /// Every library file (`vendor` and stubs), loaded or not.
    library: HashMap<FileId, LibraryFile>,
    /// Library files by the lowercase names they declare.
    library_names: HashMap<String, Vec<FileId>>,
    /// What each file declares, for every project and library file.
    declared: HashMap<FileId, Vec<Declared>>,
    excluded: GlobSet,
    /// What `tests/Pest.php` binds with `in()`: each chain's classes and traits, the files and folders it covers,
    /// and the type of each property its `beforeEach()` hooks set on `$this`.
    pest_uses: Vec<(Vec<String>, GlobSet, PestProps)>,
    /// The classes and traits each test file binds itself to with its own `uses()`.
    pest_own: HashMap<FileId, Vec<String>>,
    /// The classes made for the test files bound to traits, by test case and traits; see [`Index::sync_pest_classes`].
    pest_classes: Vec<((String, Vec<String>), Word)>,
    /// Changes with each build and each change to the project's code, and is never the same for two indexes, so
    /// what's found with the index can be kept until it changes.
    pub generation: u64,
}

fn next_generation() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// PHP's built-in functions and classes, built once per process. Building needs a deep stack.
pub fn prelude() -> &'static Prelude {
    static PRELUDE: OnceLock<Prelude> = OnceLock::new();
    PRELUDE.get_or_init(|| {
        std::thread::Builder::new().stack_size(64 << 20).spawn(Prelude::build).unwrap().join().unwrap()
    })
}

/// A Mago file for `path`. Its name is the absolute path, which also makes its ID unique.
pub fn source_file(path: &Path, file_type: FileType, contents: Vec<u8>) -> File {
    let name = path.to_string_lossy().into_owned().into_bytes();
    File::new(Cow::Owned(name), file_type, Some(path.to_path_buf()), Cow::Owned(contents))
}

pub fn file_id(path: &Path) -> FileId {
    FileId::new(path.to_string_lossy().as_bytes())
}

/// A file's symbols, and with `uses`, the lowercase names its code mentions: classes, functions, and constants,
/// including class names in docblocks.
/// The threads that parse, scan, and analyze files in parallel, for the index and for requests that read many
/// files. Their stacks are as large as the server's other threads', since the parser recurses once per level of
/// nesting; rayon's global pool has the default 2 MB. Work on them must never wait on the index's lock: a
/// thread waiting for its own parallel work can pick up anyone's.
pub fn scan_pool() -> &'static rayon::ThreadPool {
    static POOL: std::sync::OnceLock<rayon::ThreadPool> = std::sync::OnceLock::new();
    POOL.get_or_init(|| rayon::ThreadPoolBuilder::new().thread_name(|i| format!("tusk-scan-{i}")).stack_size(64 << 20).build().expect("the scan pool starts"))
}

/// With `uses`, a test file's own Pest bindings too: the classes and traits its `uses()` names.
fn scan(path: &Path, file_type: FileType, contents: Vec<u8>, php_version: PHPVersion, arena: &LocalArena, uses: bool) -> (CodebaseMetadata, Vec<String>, Vec<String>) {
    let (file, program) = crate::analysis::parse_balanced(arena, path, file_type, contents);
    let names = NameResolver::new(arena).resolve(program);
    let meta = scan_program(arena, &file, program, &names, php_version);
    let parsed = Parsed { file, program, names };
    let names = &parsed.names;
    let pest = if uses && path.components().any(|c| c.as_os_str() == "tests") { own_pest_uses(&parsed) } else { vec![] };
    let mut used = vec![];
    if uses {
        for (_, _, name, _) in names.iter() {
            let name = String::from_utf8_lossy(name).to_ascii_lowercase();
            // An unqualified function or constant in a namespace falls back to the global one.
            if let Some((_, short)) = name.rsplit_once('\\') {
                used.push(short.to_string());
            }
            used.push(name);
        }
        for t in program.trivia.iter().filter(|t| t.kind == mago_syntax::cst::TriviaKind::DocBlockComment) {
            for (at, _, name) in crate::symbol::docblock_type_names(t.value, t.span.start.offset) {
                let scope = crate::scope::scope_at(program, at);
                used.push(crate::scope::resolve_class(&scope, &name).to_ascii_lowercase());
            }
        }
    }
    (meta, used, pest)
}

/// Pest's configuration file, relative to the project.
const PEST_FILE: &str = "tests/Pest.php";

/// The type of each property Pest tests set on `$this` that their test case doesn't declare, by name.
pub type PestProps = HashMap<Vec<u8>, TUnion>;

/// Whether a class is one the index made for Pest tests bound to traits, which no file declares, so navigation
/// leaves it out of a class's subclasses.
pub fn is_pest_class(name: &str) -> bool {
    name.contains(PEST_CLASS_JOIN)
}

/// What joins the test case and traits in the name of a class made for Pest tests.
const PEST_CLASS_JOIN: &str = "＆";

/// The test case Pest runs a file's tests in when nothing binds the file to another.
pub const PHPUNIT_TEST_CASE: &str = "PHPUnit\\Framework\\TestCase";

/// What each `uses()`, `pest()->extend()`, or `beforeEach()` chain in a Pest file binds: the classes and traits it
/// names, fully qualified, the targets its `in()` gives, relative to `tests/`, and the spans of its `beforeEach()`
/// hooks. A chain without `in()` binds its own file.
#[allow(clippy::type_complexity)]
fn pest_uses(parsed: &Parsed<'_>) -> Vec<(Vec<String>, Vec<String>, Vec<(u32, u32)>)> {
    use mago_span::HasSpan;
    use mago_syntax::cst::{Access, Argument, Call, ClassLikeConstantSelector, ClassLikeMemberSelector, Expression, Literal, MagicConstant, Node};
    let mut out = vec![];
    crate::locate::walk(parsed, |node, _| {
        let Node::ExpressionStatement(s) = node else { return };
        let (mut names, mut targets, mut hooks) = (vec![], vec![], vec![]);
        let mut e = s.expression;
        loop {
            let (name, args, object) = match e {
                Expression::Call(Call::Method(c)) => match &c.method {
                    ClassLikeMemberSelector::Identifier(id) => (id.value, &c.argument_list, Some(c.object)),
                    _ => return,
                },
                Expression::Call(Call::Function(c)) => match c.function {
                    Expression::Identifier(id) => (id.value(), &c.argument_list, None),
                    _ => return,
                },
                _ => return,
            };
            let name = name.to_ascii_lowercase();
            for arg in args.arguments.iter().map(Argument::value) {
                match (name.as_slice(), arg) {
                    (b"uses" | b"use" | b"extend" | b"extends", Expression::Access(Access::ClassConstant(a)))
                        if matches!(&a.constant, ClassLikeConstantSelector::Identifier(id) if id.value.eq_ignore_ascii_case(b"class")) =>
                    {
                        names.extend(parsed.name_at(a.class.span().start.offset).map(|(_, _, n, _)| n));
                    }
                    (b"in", Expression::Literal(Literal::String(s))) => targets.extend(s.value.map(|v| String::from_utf8_lossy(v).into_owned())),
                    (b"in", Expression::MagicConstant(MagicConstant::Directory(_))) => targets.push(".".into()),
                    (b"beforeeach", _) => hooks.push((arg.span().start.offset, arg.span().end.offset)),
                    _ => {}
                }
            }
            match object {
                Some(object) => e = object,
                None if matches!(name.as_slice(), b"uses" | b"pest" | b"beforeeach") => break,
                None => return,
            }
        }
        if !names.is_empty() || !hooks.is_empty() {
            out.push((names, targets, hooks));
        }
    });
    out
}

/// The classes and traits a test file binds itself to: those of its chains without `in()`.
fn own_pest_uses(parsed: &Parsed<'_>) -> Vec<String> {
    pest_uses(parsed).into_iter().filter(|(_, targets, _)| targets.is_empty()).flat_map(|(names, ..)| names).collect()
}

/// Pest.php's chains that have `in()`, with their targets as globs: Pest expands them with PHP's `glob()` from
/// `tests/`, and a folder covers the files under it. Each comes with the type of each property its `beforeEach()`
/// hooks set on `$this`, which needs the populated index.
fn pest_bindings(index: &Index, contents: &[u8]) -> Vec<(Vec<String>, GlobSet, PestProps)> {
    let arena = LocalArena::new();
    let parsed = Parsed::new(&arena, &index.config.root.join(PEST_FILE), &String::from_utf8_lossy(contents));
    let chains = pest_uses(&parsed);
    let sets = if chains.iter().any(|(_, _, hooks)| !hooks.is_empty()) { crate::analysis::this_assignments(&parsed, &arena, index) } else { vec![] };
    chains
        .into_iter()
        .filter(|(_, targets, _)| !targets.is_empty())
        .map(|(names, targets, hooks)| {
            let props = sets.iter().filter(|(at, ..)| hooks.iter().any(|(s, e)| s <= at && at < e)).map(|(_, n, t)| (n.clone(), t.clone())).collect();
            let mut set = GlobSetBuilder::new();
            for target in &targets {
                let target = target.trim_start_matches("./").trim_matches('/');
                if let Ok(glob) = GlobBuilder::new(if target == "." { "" } else { target }).literal_separator(true).build() {
                    set.add(glob);
                }
            }
            (names, set.build().unwrap_or_else(|_| GlobSet::empty()), props)
        })
        .collect()
}

/// The lowercase names of the classes, interfaces, and traits a type mentions.
fn classes_in(t: &TUnion, out: &mut Vec<String>) {
    for node in std::iter::once(TypeRef::Union(t)).chain(t.get_all_child_nodes()) {
        match node {
            TypeRef::Atomic(TAtomic::Object(TObject::Named(n))) => out.push(n.name.as_str_lossy().to_ascii_lowercase()),
            TypeRef::Atomic(TAtomic::Object(TObject::Enum(e))) => out.push(e.name.as_str_lossy().to_ascii_lowercase()),
            // Before population, a class in a type is still a reference to its name.
            TypeRef::Atomic(TAtomic::Reference(TReference::Symbol { name, .. })) => out.push(name.as_str_lossy().to_ascii_lowercase()),
            TypeRef::Atomic(TAtomic::Reference(TReference::Member { class_like_name, .. })) => {
                out.push(class_like_name.as_str_lossy().to_ascii_lowercase())
            }
            _ => {}
        }
    }
}

/// The lowercase names a file's declarations depend on: parents, interfaces, traits, mixins, and every class in a
/// signature, property, constant, or template. Loading these makes the file's symbols complete.
fn dependencies(meta: &CodebaseMetadata) -> Vec<String> {
    let mut out = vec![];
    let word = |w: &Word| w.as_str_lossy().to_ascii_lowercase();
    for c in meta.class_likes.values() {
        out.extend(c.direct_parent_class.iter().map(word));
        out.extend(c.direct_parent_interfaces.iter().chain(&c.used_traits).chain(&c.require_extends).chain(&c.require_implements).map(word));
        out.extend(c.attributes.iter().map(|a| word(&a.name)));
        for m in &c.mixins {
            classes_in(&m.type_union, &mut out);
        }
        for p in c.properties.values().chain(c.magic_properties.values()) {
            for t in [&p.type_metadata, &p.type_declaration_metadata].into_iter().flatten() {
                classes_in(&t.type_union, &mut out);
            }
        }
        for k in c.constants.values() {
            if let Some(t) = &k.type_metadata {
                classes_in(&t.type_union, &mut out);
            }
        }
        for t in c.template_types.values() {
            classes_in(&t.constraint, &mut out);
        }
        for types in c.template_extended_offsets.values() {
            for t in types {
                classes_in(t, &mut out);
            }
        }
    }
    for f in meta.function_likes.values() {
        for p in &f.parameters {
            for t in [&p.type_metadata, &p.type_declaration_metadata].into_iter().flatten() {
                classes_in(&t.type_union, &mut out);
            }
        }
        for t in [&f.return_type_metadata, &f.return_type_declaration_metadata].into_iter().flatten() {
            classes_in(&t.type_union, &mut out);
        }
        for t in &f.thrown_types {
            classes_in(&t.type_union, &mut out);
        }
        out.extend(f.attributes.iter().map(|a| word(&a.name)));
    }
    for c in meta.constants.values() {
        if let Some(t) = &c.type_metadata {
            classes_in(&t.type_union, &mut out);
        }
    }
    out.sort();
    out.dedup();
    out
}

/// What a scan declares, for the name list.
fn declarations_of(meta: &CodebaseMetadata) -> Vec<Declared> {
    let mut out: Vec<Declared> = meta
        .class_likes
        .values()
        .map(|c| Declared {
            name: c.original_name,
            kind: DeclKind::Class(c.kind),
            is_abstract: c.flags.is_abstract(),
            span: c.name_span.unwrap_or(c.span),
        })
        .collect();
    out.extend(meta.function_likes.values().filter(|f| f.kind.is_function()).map(|f| Declared {
        name: f.original_name,
        kind: DeclKind::Function,
        is_abstract: false,
        span: f.name_span.unwrap_or(f.span),
    }));
    out.extend(meta.constants.values().map(|c| Declared { name: c.name, kind: DeclKind::Constant, is_abstract: false, span: c.span }));
    out.extend(meta.class_like_alias_declarations().map(|(alias, _, span)| Declared {
        name: alias,
        kind: DeclKind::Class(SymbolKind::Class),
        is_abstract: false,
        span,
    }));
    out
}

impl Index {
    /// An index of PHP's built-ins only. Files arrive with [`Index::build`] or [`Index::update`].
    pub fn empty(config: IndexConfig) -> Self {
        let excluded = config.exclusions();
        Self {
            config,
            codebase: prelude().metadata.clone(),
            files: HashMap::new(),
            by_path: HashMap::new(),
            library: HashMap::new(),
            library_names: HashMap::new(),
            declared: HashMap::new(),
            excluded,
            pest_uses: vec![],
            pest_own: HashMap::new(),
            pest_classes: vec![],
            generation: next_generation(),
        }
    }

    /// Whether `path` belongs in the index: a PHP file under the root that no exclusion covers, or a stub.
    pub fn includes(&self, path: &Path) -> bool {
        if path.extension().is_none_or(|e| e != "php") || path.to_string_lossy().ends_with(".blade.php") {
            return false;
        }
        if self.config.stubs.iter().any(|s| path.starts_with(s)) {
            return true;
        }
        let Ok(rel) = path.strip_prefix(&self.config.root) else { return false };
        // Hidden folders (`.git`, `.idea`, …) hold no project code.
        if rel.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.')) {
            return false;
        }
        !self.excluded.is_match(rel)
    }

    fn file_type(&self, path: &Path) -> FileType {
        let vendor = path.strip_prefix(&self.config.root).is_ok_and(|rel| rel.starts_with("vendor"));
        if vendor || !path.starts_with(&self.config.root) { FileType::Vendored } else { FileType::Host }
    }

    /// Every PHP file the index covers, found on disk.
    pub fn discover(&self) -> Vec<PathBuf> {
        let mut roots = vec![self.config.root.clone()];
        roots.extend(self.config.stubs.iter().cloned());
        let mut out = vec![];
        for root in roots {
            let walker = ignore::WalkBuilder::new(&root)
                .standard_filters(false)
                .follow_links(true)
                .filter_entry({
                    let excluded = self.excluded.clone();
                    let project = self.config.root.clone();
                    move |e| {
                        let Ok(rel) = e.path().strip_prefix(&project) else { return true };
                        let hidden = e.depth() > 0 && e.file_name().to_string_lossy().starts_with('.');
                        !hidden && !(!rel.as_os_str().is_empty() && excluded.is_match(rel))
                    }
                })
                .build();
            out.extend(
                walker
                    .flatten()
                    .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
                    .map(|e| e.into_path())
                    .filter(|p| self.includes(p)),
            );
        }
        out.sort();
        out.dedup();
        out
    }

    /// Indexes `paths`: every project file in full, and of the library files, the names they declare, then in
    /// full those the project reaches. `read` supplies each file's text, so open documents can win over the disk.
    /// `progress` is called with the count done so far.
    pub fn build(
        &mut self,
        paths: Vec<PathBuf>,
        read: impl Fn(&Path) -> Option<Vec<u8>> + Sync,
        progress: impl Fn(usize, usize) + Sync,
    ) {
        let total = paths.len();
        let done = std::sync::atomic::AtomicUsize::new(0);
        let php_version = self.config.php_version;
        let tick = || {
            let n = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            if n.is_multiple_of(500) {
                progress(n, total);
            }
        };
        let (project, library): (Vec<PathBuf>, Vec<PathBuf>) = paths.into_iter().partition(|p| self.file_type(p) == FileType::Host);
        // Library files: only what they declare, from the cache when unchanged. Each scan is dropped at once, so
        // the build's memory stays near what the index keeps, which is what the process keeps after it.
        let key = cache_key(php_version);
        let cached = self.config.cache.as_deref().map(|p| DeclCache::load(p, &key)).unwrap_or_default();
        let mut fresh = DeclCache { key, files: HashMap::new() };
        let mut hits = 0;
        for chunk in library.chunks(1024) {
            let found: Vec<(PathBuf, FileType, Vec<Declared>, Option<Stamp>)> = scan_pool().install(|| chunk
                .par_iter()
                .filter_map(|path| {
                    let file_type = self.file_type(path);
                    let stamp = stamp(path);
                    if let Some((_, declared)) = cached.files.get(path).filter(|(s, _)| Some(*s) == stamp) {
                        tick();
                        return Some((path.clone(), file_type, declared.clone(), stamp));
                    }
                    let contents = read(path)?;
                    let (meta, ..) = scan(path, file_type, contents, php_version, &LocalArena::new(), false);
                    tick();
                    Some((path.clone(), file_type, declarations_of(&meta), stamp))
                })
                .collect());
            for (path, file_type, declared, stamp) in found {
                hits += cached.files.get(&path).is_some_and(|(s, _)| Some(*s) == stamp) as usize;
                // ponytail: an open library file's unsaved text is cached under the disk's stamp; it lasts until the
                // file changes on disk. Have `read` say where text came from if editing `vendor` becomes common.
                if let (Some(stamp), true) = (stamp, self.config.cache.is_some()) {
                    fresh.files.insert(path.clone(), (stamp, declared.clone()));
                }
                self.add_library_file(path, file_type, declared);
            }
        }
        // Written again only when something changed: a file parsed, or one gone.
        if let Some(path) = &self.config.cache
            && (hits != fresh.files.len() || hits != cached.files.len())
        {
            fresh.save(path);
        }
        drop((cached, fresh));
        // Project files, in full, with the names they use.
        let mut wanted: Vec<String> = vec![];
        for chunk in project.chunks(1024) {
            let scans: Vec<(PathBuf, CodebaseMetadata, Vec<String>, Vec<String>)> = scan_pool().install(|| chunk
                .par_iter()
                .filter_map(|path| {
                    let contents = read(path)?;
                    let (meta, used, pest) = scan(path, FileType::Host, contents, php_version, &LocalArena::new(), true);
                    tick();
                    Some((path.clone(), meta, used, pest))
                })
                .collect());
            for (path, meta, used, pest) in scans {
                wanted.extend(used);
                if !pest.is_empty() {
                    self.pest_own.insert(file_id(&path), pest);
                }
                wanted.extend(dependencies(&meta));
                self.merge(path, FileType::Host, meta);
            }
        }
        if self.config.load_all {
            wanted.extend(self.library_names.keys().cloned());
        }
        self.ensure_loaded(wanted, &read);
        let mut refs = prelude().symbol_references.clone();
        break_inheritance_cycles(&mut self.codebase, None);
        populate_codebase(&mut self.codebase, &mut refs, WordSet::default(), HashSet::default());
        self.codebase.safe_symbols.clear();
        self.bind_pest_closures();
        self.pest_uses = read(&self.config.root.join(PEST_FILE)).map(|c| pest_bindings(self, &c)).unwrap_or_default();
        self.sync_pest_classes();
        self.generation = next_generation();
        progress(total, total);
    }

    fn add_library_file(&mut self, path: PathBuf, file_type: FileType, declared: Vec<Declared>) {
        let id = file_id(&path);
        for d in &declared {
            let files = self.library_names.entry(d.name.as_str_lossy().to_ascii_lowercase()).or_default();
            if !files.contains(&id) {
                files.push(id);
            }
        }
        self.declared.insert(id, declared);
        self.library.insert(id, LibraryFile { path, file_type });
    }

    fn forget_library_file(&mut self, id: FileId) {
        for d in self.declared.remove(&id).unwrap_or_default() {
            let key = d.name.as_str_lossy().to_ascii_lowercase();
            if let Some(files) = self.library_names.get_mut(&key) {
                files.retain(|f| *f != id);
                if files.is_empty() {
                    self.library_names.remove(&key);
                }
            }
        }
        self.library.remove(&id);
    }

    /// Loads the library files that declare `names`, and what those depend on, until nothing new is needed.
    /// Returns the classes it loaded.
    fn ensure_loaded(&mut self, names: Vec<String>, read: &(dyn Fn(&Path) -> Option<Vec<u8>> + Sync)) -> WordSet {
        let mut loaded = WordSet::default();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut names = names;
        loop {
            let mut wave: Vec<FileId> = vec![];
            for name in names.drain(..) {
                if !seen.insert(name.clone()) {
                    continue;
                }
                for id in self.library_names.get(&name).into_iter().flatten() {
                    if !self.files.contains_key(id) && !wave.contains(id) {
                        wave.push(*id);
                    }
                }
            }
            if wave.is_empty() {
                return loaded;
            }
            let php_version = self.config.php_version;
            let jobs: Vec<(PathBuf, FileType)> =
                wave.iter().filter_map(|id| self.library.get(id)).map(|f| (f.path.clone(), f.file_type)).collect();
            let scans: Vec<(PathBuf, FileType, CodebaseMetadata)> = scan_pool().install(|| jobs
                .into_par_iter()
                .filter_map(|(path, file_type)| {
                    let contents = read(&path)?;
                    let (meta, ..) = scan(&path, file_type, contents, php_version, &LocalArena::new(), false);
                    Some((path, file_type, meta))
                })
                .collect());
            for (path, file_type, meta) in scans {
                names.extend(dependencies(&meta));
                loaded.extend(meta.class_likes.keys().copied());
                self.merge(path, file_type, meta);
            }
        }
    }

    /// Replaces a file's symbols with those in `contents`, or removes them when `contents` is `None`.
    pub fn update(&mut self, path: &Path, contents: Option<Vec<u8>>) {
        self.update_many(vec![(path.to_path_buf(), contents)]);
    }

    pub fn update_many(&mut self, changes: Vec<(PathBuf, Option<Vec<u8>>)>) {
        // A Blade view's changes leave the index as it was.
        if changes.iter().any(|(path, _)| self.includes(path) || self.by_path.contains_key(path) || self.library.contains_key(&file_id(path))) {
            self.generation = next_generation();
        }
        let arena = LocalArena::new();
        let mut dirty = WordSet::default();
        let mut scans = vec![];
        let mut wanted: Vec<String> = vec![];
        let mut pest_file = None;
        for (path, contents) in changes {
            let id = file_id(&path);
            if let Some(old) = self.files.remove(&id) {
                dirty.extend(old.keys.class_like_names.iter().copied());
                dirty.extend(old.keys.constant_names.iter().copied());
                let owned = self.owned(id, &old.keys);
                self.codebase.remove_entries_by_keys(&owned);
                self.by_path.remove(&path);
            }
            let library = self.library.contains_key(&id);
            if library {
                self.forget_library_file(id);
            }
            self.declared.remove(&id);
            self.pest_own.remove(&id);
            if path == self.config.root.join(PEST_FILE) {
                pest_file = Some(contents.clone());
            }
            let Some(contents) = contents else { continue };
            if !self.includes(&path) {
                continue;
            }
            let file_type = self.file_type(&path);
            let project = file_type == FileType::Host;
            let (meta, used, pest) = scan(&path, file_type, contents, self.config.php_version, &arena, project);
            if !pest.is_empty() {
                self.pest_own.insert(id, pest);
            }
            // A library file that changes is one the editor has open, or one changed on disk while loaded; both
            // are loaded in full, so navigating inside an open library file works.
            if !project {
                self.add_library_file(path.clone(), file_type, declarations_of(&meta));
            }
            dirty.extend(meta.class_likes.keys().copied());
            dirty.extend(meta.constants.keys().copied());
            wanted.extend(used);
            wanted.extend(dependencies(&meta));
            scans.push((path, file_type, meta));
        }
        for (path, file_type, meta) in scans {
            self.merge(path, file_type, meta);
        }
        // Names the edit started to use, from the disk: library files an editor has open are loaded already.
        self.ensure_loaded(wanted, &|p: &Path| std::fs::read(p).ok());
        self.repopulate(dirty);
        // Pest.php's hooks are typed against the updated index.
        // ponytail: only when Pest.php changes, so a hook's type that depends on another file can go stale; type them
        // after every update if that bites.
        if let Some(contents) = pest_file {
            self.pest_uses = contents.map(|c| pest_bindings(self, &c)).unwrap_or_default();
        }
        self.sync_pest_classes();
    }

    /// Moves a file's scan into the index, remembering what it declared.
    fn merge(&mut self, path: PathBuf, file_type: FileType, meta: CodebaseMetadata) {
        let keys = CodebaseEntryKeys {
            class_like_names: meta.class_likes.keys().copied().collect(),
            class_like_aliases: meta.class_like_alias_declarations().collect(),
            function_like_keys: meta.function_likes.keys().copied().collect(),
            constant_names: meta.constants.keys().copied().collect(),
            file_ids: vec![],
        };
        let id = file_id(&path);
        if file_type == FileType::Host {
            self.declared.insert(id, declarations_of(&meta));
        }
        // Cloned in, not moved: clones are allocated at their size, and a scan's collections have room to spare.
        self.codebase.extend_ref(&meta);
        drop(meta);
        self.by_path.insert(path.clone(), id);
        self.files.insert(id, IndexedFile { path, file_type, keys });
    }

    /// Of what file `id` declared, what the index still has from it. Two files can declare the same class, and
    /// only one of them wins the merge; removing the other mustn't take the winner's.
    fn owned(&self, id: FileId, declared: &CodebaseEntryKeys) -> CodebaseEntryKeys {
        let cb = &self.codebase;
        let aliases: Vec<(Word, Word, mago_span::Span)> = cb.class_like_alias_declarations().collect();
        CodebaseEntryKeys {
            class_like_names: declared.class_like_names.iter().filter(|k| cb.class_likes.get(*k).is_some_and(|m| m.span.file_id == id)).copied().collect(),
            class_like_aliases: declared.class_like_aliases.iter().filter(|a| aliases.contains(a)).copied().collect(),
            function_like_keys: declared.function_like_keys.iter().filter(|k| cb.function_likes.get(*k).is_some_and(|m| m.span.file_id == id)).copied().collect(),
            constant_names: declared.constant_names.iter().filter(|k| cb.constants.get(*k).is_some_and(|m| m.span.file_id == id)).copied().collect(),
            file_ids: vec![],
        }
    }

    /// Populates the changed symbols and everything that inherits from them, keeping the rest as it was.
    fn repopulate(&mut self, mut dirty: WordSet) {
        let descendants: Vec<Word> = dirty
            .iter()
            .filter_map(|name| self.codebase.all_class_like_descendants.get(name))
            .flatten()
            .copied()
            .collect();
        dirty.extend(descendants);
        let mut safe = WordSet::default();
        safe.extend(self.codebase.class_likes.keys().filter(|k| !dirty.contains(*k)).copied());
        // Functions are keyed `("", name)`, and the populator counts one as safe when the empty word is. A
        // function the change scanned is unpopulated, so it's populated either way.
        safe.insert(mago_word::empty_word());
        safe.extend(self.codebase.constants.keys().filter(|k| !dirty.contains(*k)).copied());
        // An empty safe set would repopulate everything, which is also correct.
        let mut refs = SymbolReferences::new();
        break_inheritance_cycles(&mut self.codebase, Some(&dirty));
        populate_codebase(&mut self.codebase, &mut refs, safe, HashSet::default());
        // The analyzer skips "safe" symbols only in its diff mode, but nothing here needs the set kept.
        self.codebase.safe_symbols.clear();
        self.bind_pest_closures();
    }

    /// Pest runs each test closure as a method of a test case. Its functions declare PHPUnit's `TestCase` as the
    /// closures' `$this` (Pest 2 declares `TestCall`), so this sets PHPUnit's `TestCase` for every version. The
    /// analysis then binds a test file's closures to its own test case, from [`Index::pest_binding`].
    fn bind_pest_closures(&mut self) {
        let Some(case) = self.codebase.get_class_like(PHPUNIT_TEST_CASE.as_bytes()).map(|c| c.original_name) else { return };
        // Pest's functions whose closure Pest binds; `describe()` and `beforeAll()` closures run unbound.
        for name in ["test", "it", "beforeeach", "aftereach"] {
            let Some(f) = self.codebase.function_likes.get_mut(&(mago_word::empty_word(), mago_word::ascii_lowercase_word(name.as_bytes()))) else { continue };
            for this in f.parameters.iter_mut().filter_map(|p| p.closure_this_type.as_mut()) {
                this.type_union = TUnion::from_atomic(TAtomic::Object(TObject::Named(TNamedObject::new(case))));
            }
        }
    }

    /// The test case and traits Pest runs a test file's closures with: the first class that extends PHPUnit's
    /// `TestCase` and every trait, among those the file's own `uses()` names (`own`) and those of the
    /// `tests/Pest.php` chains whose `in()` covers the file. PHPUnit's `TestCase` when only traits are named, and
    /// `None` when nothing binds the file or it isn't under `tests/`.
    fn pest_combo(&self, path: &Path, own: &[String]) -> Option<(String, Vec<String>)> {
        let rel = path.strip_prefix(self.config.root.join("tests")).ok()?;
        let bound = self.pest_uses.iter().filter(|(_, set, _)| rel.ancestors().any(|a| set.is_match(a))).flat_map(|(names, ..)| names);
        let names: Vec<&String> = own.iter().chain(bound).collect();
        let original = |n: &str| self.codebase.get_class_like(n.as_bytes()).map(|c| c.original_name.as_str_lossy().into_owned());
        let case = names.iter().find(|n| self.codebase.class_extends(n.as_bytes(), PHPUNIT_TEST_CASE.as_bytes())).and_then(|n| original(n));
        let mut traits: Vec<String> = names.iter().filter(|n| self.codebase.trait_exists(n.as_bytes())).filter_map(|n| original(n)).collect();
        traits.sort();
        traits.dedup();
        match case {
            Some(case) => Some((case, traits)),
            None if !traits.is_empty() => Some((original(PHPUNIT_TEST_CASE)?, traits)),
            None => None,
        }
    }

    /// How the analysis binds a Pest test file: the class its closures run in, the type of each property the
    /// `beforeEach()` hooks of the Pest.php chains that cover it set on `$this`, and the spans of its own hooks.
    /// `None` for a file nothing binds, which runs in PHPUnit's `TestCase`.
    #[allow(clippy::type_complexity)]
    pub fn pest_binding(&self, parsed: &Parsed<'_>) -> Option<(Word, PestProps, Vec<(u32, u32)>)> {
        let path = parsed.file.path.as_deref()?;
        let rel = path.strip_prefix(self.config.root.join("tests")).ok()?;
        let chains = pest_uses(parsed);
        let own: Vec<String> = chains.iter().filter(|(_, targets, _)| targets.is_empty()).flat_map(|(names, ..)| names.iter().cloned()).collect();
        let combo = self.pest_combo(path, &own)?;
        // A class made for the traits, or until the index catches up with a new `uses()`, the test case alone.
        let made = self.pest_classes.iter().find(|(k, _)| *k == combo).map(|(_, name)| *name);
        let case = made.or_else(|| self.codebase.get_class_like(combo.0.as_bytes()).map(|c| c.original_name))?;
        let props = self.pest_uses.iter().filter(|(_, set, _)| rel.ancestors().any(|a| set.is_match(a))).flat_map(|(.., props)| props.clone()).collect();
        let hooks = chains.into_iter().filter(|(_, targets, _)| targets.is_empty()).flat_map(|(.., hooks)| hooks).collect();
        Some((case, props, hooks))
    }

    /// Pest runs a test file's closures in a class that extends its test case and uses the traits Pest.php or the
    /// file's `uses()` add, such as `RefreshDatabase`. For each such pair of test case and traits the project's test
    /// files have, this adds a class that does the same, named for what it combines, such as
    /// `Tests\TestCase＆RefreshDatabase`, so `$this` has the traits' methods. The classes come from no file the
    /// index lists, so names, symbols, and the project's files leave them out.
    fn sync_pest_classes(&mut self) {
        let tests = self.config.root.join("tests");
        let mut wanted: Vec<(String, Vec<String>)> = self
            .files
            .iter()
            .filter(|(_, f)| f.file_type == FileType::Host && f.path.starts_with(&tests))
            .filter_map(|(id, f)| self.pest_combo(&f.path, self.pest_own.get(id).map_or(&[], Vec::as_slice)))
            .filter(|(_, traits)| !traits.is_empty())
            .collect();
        wanted.sort();
        wanted.dedup();
        if wanted.iter().eq(self.pest_classes.iter().map(|(k, _)| k)) {
            return;
        }
        let mut dirty = WordSet::default();
        dirty.extend(self.pest_classes.drain(..).map(|(_, name)| mago_word::ascii_lowercase_word(name.as_bytes())));
        let class_like_names = dirty.iter().copied().collect();
        self.codebase.remove_entries_by_keys(&CodebaseEntryKeys { class_like_names, class_like_aliases: vec![], function_like_keys: vec![], constant_names: vec![], file_ids: vec![] });
        let mut source = String::from("<?php\n");
        let mut names: Vec<String> = vec![];
        for (case, traits) in &wanted {
            let (namespace, short) = case.rsplit_once('\\').unwrap_or(("", case));
            let mut class = std::iter::once(short).chain(traits.iter().map(|t| t.rsplit('\\').next().unwrap_or(t))).collect::<Vec<_>>().join(PEST_CLASS_JOIN);
            // Traits of the same name from different namespaces.
            if names.iter().any(|n| n.eq_ignore_ascii_case(&format!("{namespace}\\{class}"))) {
                class = format!("{class}{}", names.len());
            }
            source.push_str(&format!("namespace {namespace} {{ class {class} extends \\{case} {{ use \\{}; }} }}\n", traits.join(", \\")));
            names.push(format!("{namespace}\\{class}"));
        }
        let path = tests.join(".pest-classes.php");
        let (meta, ..) = scan(&path, FileType::Host, source.into_bytes(), self.config.php_version, &LocalArena::new(), false);
        for (combo, name) in wanted.into_iter().zip(names) {
            let Some(class) = meta.get_class_like(name.trim_start_matches('\\').as_bytes()) else { continue };
            dirty.insert(mago_word::ascii_lowercase_word(class.original_name.as_bytes()));
            self.pest_classes.push((combo, class.original_name));
        }
        self.codebase.extend_ref(&meta);
        self.repopulate(dirty);
    }

    pub fn path_of(&self, id: FileId) -> Option<&Path> {
        self.files.get(&id).map(|f| f.path.as_path()).or_else(|| self.library.get(&id).map(|f| f.path.as_path()))
    }

    /// Whether the file is part of the project, rather than a library or PHP's built-ins.
    pub fn is_project_file(&self, id: FileId) -> bool {
        self.files.get(&id).is_some_and(|f| f.file_type == FileType::Host)
    }

    /// Where a class, function, or constant is declared, loaded or not.
    pub fn find_declared(&self, name: &str) -> Option<&Declared> {
        let key = name.trim_start_matches('\\').to_ascii_lowercase();
        let from_library = self.library_names.get(&key).into_iter().flatten().filter_map(|id| self.declared.get(id)).flatten();
        let from_project = self.files.keys().filter_map(|id| self.declared.get(id)).flatten();
        from_library.chain(from_project).find(|d| d.name.as_str_lossy().eq_ignore_ascii_case(&key))
    }

    /// Every class, function, and constant the project and its libraries declare, loaded or not, and PHP's
    /// built-ins, with where each comes from.
    pub fn names(&self) -> Vec<(Declared, Origin)> {
        let mut out: Vec<(Declared, Origin)> = self
            .declared
            .iter()
            .flat_map(|(id, list)| {
                let origin = if self.is_project_file(*id) { Origin::Project } else { Origin::Library };
                list.iter().map(move |d| (d.clone(), origin))
            })
            .collect();
        let cb = &self.codebase;
        out.extend(cb.class_likes.values().filter(|c| c.flags.is_built_in()).map(|c| {
            let d = Declared { name: c.original_name, kind: DeclKind::Class(c.kind), is_abstract: c.flags.is_abstract(), span: c.span };
            (d, Origin::BuiltIn)
        }));
        out.extend(cb.function_likes.values().filter(|f| f.flags.is_built_in() && f.kind.is_function()).map(|f| {
            (Declared { name: f.original_name, kind: DeclKind::Function, is_abstract: false, span: f.span }, Origin::BuiltIn)
        }));
        out.extend(cb.constants.values().filter(|c| c.flags.is_built_in()).map(|c| {
            (Declared { name: c.name, kind: DeclKind::Constant, is_abstract: false, span: c.span }, Origin::BuiltIn)
        }));
        out
    }

    pub fn contains(&self, path: &Path) -> bool {
        self.by_path.contains_key(path) || self.library.contains_key(&file_id(path))
    }

    /// Project files (not `vendor` or stubs).
    pub fn project_files(&self) -> impl Iterator<Item = &Path> {
        self.files.values().filter(|f| f.file_type == FileType::Host).map(|f| f.path.as_path())
    }
}

/// A file's modification time in nanoseconds and its size: when both match, its contents are taken to match.
type Stamp = (u128, u64);

fn stamp(path: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos(), meta.len()))
}

/// What the cache depends on besides each file: its format, the PHP version, and the server binary, which pins
/// Mago's version and Tusk's own scanning.
fn cache_key(php_version: PHPVersion) -> String {
    let exe = std::env::current_exe().ok().and_then(|p| stamp(&p));
    format!("1 {php_version:?} {exe:?}")
}

/// What each library file declares, by path, as of its [`Stamp`]. Entries depend only on their file, so a change of
/// exclusions or of `load_all` only changes which entries are used.
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct DeclCache {
    key: String,
    files: HashMap<PathBuf, (Stamp, Vec<Declared>)>,
}

impl DeclCache {
    /// The cache at `path`, or an empty one if it's missing, unreadable, or for another key.
    fn load(path: &Path, key: &str) -> Self {
        let cache: Self = std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        if cache.key == key { cache } else { Self::default() }
    }

    /// Writes to a file of its own, then renames it over the cache, so another instance never reads half of one.
    fn save(&self, path: &Path) {
        let tmp = path.with_extension(format!("tmp{}", std::process::id()));
        let written = path.parent().is_some_and(|dir| std::fs::create_dir_all(dir).is_ok())
            && serde_json::to_vec(self).is_ok_and(|bytes| std::fs::write(&tmp, bytes).is_ok());
        if !written || std::fs::rename(&tmp, path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

/// An index behind a shared pointer, for passing to request threads.
pub type SharedIndex = Arc<parking_lot::RwLock<Index>>;

/// Cuts each inheritance cycle at the link that closes it: a class that extends itself, classes that extend each
/// other, and the same for interfaces. PHP refuses such code, but typing leaves it for a moment, such as
/// `<?php$x->` swallowing a file's `namespace` so that its `UnexpectedValueException` extends PHP's own. Mago's
/// populator follows parent chains without a limit and would never finish. A new cycle runs through a class
/// that changed, so after a change only the `changed` classes' chains are walked.
fn break_inheritance_cycles(codebase: &mut CodebaseMetadata, changed: Option<&WordSet>) {
    let lower = |w: &Word| w.as_str_lossy().to_ascii_lowercase();
    let mut cut_class: Vec<(Word, Word)> = vec![];
    let mut cut_interface: Vec<(Word, Word)> = vec![];
    for (key, meta) in codebase.class_likes.iter() {
        if changed.is_some_and(|c| !c.contains(key)) {
            continue;
        }
        // Parent classes: one chain.
        let mut seen = vec![lower(key)];
        let mut current = (*key, meta.direct_parent_class);
        while let (from, Some(parent)) = current {
            if seen.contains(&lower(&parent)) {
                cut_class.push((from, parent));
                break;
            }
            seen.push(lower(&parent));
            current = (parent, codebase.get_class_like(parent.as_bytes()).and_then(|m| m.direct_parent_class));
        }
        // Parent interfaces: a tree, walked depth first along the current path.
        fn walk(codebase: &CodebaseMetadata, name: Word, path: &mut Vec<String>, cut: &mut Vec<(Word, Word)>, done: &mut HashSet<String>) {
            let Some(meta) = codebase.get_class_like(name.as_bytes()) else { return };
            for parent in meta.direct_parent_interfaces.iter() {
                let p = parent.as_str_lossy().to_ascii_lowercase();
                if path.contains(&p) {
                    cut.push((name, *parent));
                } else if done.insert(p.clone()) {
                    path.push(p);
                    walk(codebase, *parent, path, cut, done);
                    path.pop();
                }
            }
        }
        if meta.kind == SymbolKind::Interface {
            walk(codebase, *key, &mut vec![lower(key)], &mut cut_interface, &mut HashSet::default());
        }
    }
    // The map is keyed by lowercase names; a parent is named as written.
    let key = |w: &Word| mago_word::word(w.as_str_lossy().to_ascii_lowercase().as_bytes());
    for (class, parent) in cut_class {
        if let Some(meta) = codebase.class_likes.get_mut(&key(&class))
            && meta.direct_parent_class == Some(parent)
        {
            meta.direct_parent_class = None;
        }
    }
    for (interface, parent) in cut_interface {
        if let Some(meta) = codebase.class_likes.get_mut(&key(&interface)) {
            meta.direct_parent_interfaces.remove(&parent);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs `f` on a thread, failing if it takes longer than a few seconds.
    fn finishes(f: impl FnOnce() + Send + 'static) {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::Builder::new().stack_size(64 << 20).spawn(move || {
            f();
            let _ = tx.send(());
        }).unwrap();
        assert!(rx.recv_timeout(std::time::Duration::from_secs(10)).is_ok(), "it hangs");
    }

    /// A class that extends itself, or classes that extend each other, as typing can leave them: Mago's
    /// populator walks parent chains without a limit.
    #[test]
    fn inheritance_cycles_dont_hang() {
        let child = "<?php namespace App; class Child extends \\UnexpectedValueException { public function __toString(): string { return ''; } }";
        finishes(move || {
            // PHP's own class, redefined in the global namespace to extend itself.
            let mut idx = index(&[("app/Child.php", child)]);
            idx.update(Path::new("/p/app/Own.php"), Some(b"<?php class UnexpectedValueException extends \\UnexpectedValueException {}".to_vec()));
            // Two project classes that extend each other, below a class that overrides a method.
            let mut idx = index(&[
                ("app/A.php", "<?php namespace App; class A extends \\Exception {}"),
                ("app/B.php", "<?php namespace App; class B extends A { public function __toString(): string { return ''; } }"),
                ("app/C.php", "<?php namespace App; class C extends B { public function __toString(): string { return ''; } }"),
            ]);
            idx.update(Path::new("/p/app/A.php"), Some(b"<?php namespace App; class A extends B {}".to_vec()));
            assert!(idx.codebase.get_class_like(b"App\\C").is_some());
            // Interfaces that extend themselves.
            index(&[
                ("app/I.php", "<?php namespace App; interface I extends I { public function f(): void; }"),
                ("app/J.php", "<?php namespace App; class J implements I { public function f(): void {} }"),
            ]);
        });
    }

    fn index(files: &[(&str, &str)]) -> Index {
        let mut idx = Index::empty(IndexConfig::new("/p"));
        let owned: HashMap<PathBuf, Vec<u8>> =
            files.iter().map(|(p, t)| (PathBuf::from(format!("/p/{p}")), t.as_bytes().to_vec())).collect();
        idx.build(owned.keys().cloned().collect(), |p| owned.get(p).cloned(), |_, _| {});
        idx
    }

    fn return_type(idx: &Index, class: &str, method: &str) -> String {
        use mago_codex::ttype::TType;
        let m = idx.codebase.get_declaring_method(class.as_bytes(), method.as_bytes()).unwrap();
        m.return_type_metadata.as_ref().unwrap().type_union.get_id().to_string()
    }

    #[test]
    fn indexes_and_resolves_inherited_members() {
        let idx = index(&[
            ("app/Base.php", "<?php namespace App; class Base { public function name(): string { return ''; } }"),
            ("app/User.php", "<?php namespace App; class User extends Base {}"),
        ]);
        assert_eq!(return_type(&idx, "App\\User", "name"), "string");
        assert!(idx.codebase.class_extends(b"App\\User", b"App\\Base"));
        // Built-ins come from the prelude.
        assert!(idx.codebase.function_exists(b"strlen"));
    }

    #[test]
    fn updates_a_parent_and_repopulates_its_children() {
        let mut idx = index(&[
            ("app/Base.php", "<?php namespace App; class Base { public function name(): string { return ''; } }"),
            ("app/User.php", "<?php namespace App; class User extends Base {}"),
            ("app/Other.php", "<?php namespace App; class Other { public function id(): int { return 1; } }"),
        ]);
        idx.update(
            Path::new("/p/app/Base.php"),
            Some(b"<?php namespace App; class Base { public function name(): ?int { return 1; } public function extra(): void {} }".to_vec()),
        );
        assert_eq!(return_type(&idx, "App\\User", "name"), "int|null");
        assert!(idx.codebase.method_exists(b"App\\User", b"extra"));
        assert_eq!(return_type(&idx, "App\\Other", "id"), "int");

        // Removing the parent leaves the child without the inherited method.
        idx.update(Path::new("/p/app/Base.php"), None);
        assert!(!idx.codebase.class_like_exists(b"App\\Base"));
        assert!(!idx.codebase.method_exists(b"App\\User", b"extra"));
    }

    #[test]
    fn updates_functions_and_keeps_others_populated() {
        let mut idx = index(&[
            ("app/a.php", "<?php namespace App; function a(): int { return 1; }"),
            ("app/b.php", "<?php namespace App; function b(): \\App\\Thing { return new Thing; } class Thing {}"),
        ]);
        idx.update(Path::new("/p/app/a.php"), Some(b"<?php namespace App; function a(): string { return ''; }".to_vec()));
        use mago_codex::ttype::TType;
        let ret = |f: &str| idx.codebase.get_function(f.as_bytes()).unwrap().return_type_metadata.as_ref().unwrap().type_union.get_id().to_string();
        assert_eq!(ret("App\\a"), "string");
        assert_eq!(ret("App\\b"), "App\\Thing");
    }

    #[test]
    fn removing_a_duplicate_keeps_the_class_another_file_declares() {
        let mut idx = index(&[
            ("app/A.php", "<?php namespace App; class Thing { public function a(): int { return 1; } }"),
            ("app/B.php", "<?php namespace App; class Thing { public function b(): int { return 1; } }"),
        ]);
        let winner = idx.codebase.get_class_like(b"App\\Thing").unwrap().span.file_id;
        let loser = if winner == file_id(Path::new("/p/app/A.php")) { "/p/app/B.php" } else { "/p/app/A.php" };
        idx.update(Path::new(loser), None);
        assert!(idx.codebase.class_like_exists(b"App\\Thing"));
    }

    #[test]
    fn loads_only_the_library_code_the_project_reaches() {
        let idx = index(&[
            ("vendor/lib/Base.php", "<?php namespace Lib; class Base { public function make(): Made { return new Made; } }"),
            ("vendor/lib/Made.php", "<?php namespace Lib; class Made {}"),
            ("vendor/lib/Used.php", "<?php namespace Lib; trait Used {}"),
            ("vendor/lib/Unused.php", "<?php namespace Lib; class Unused {} function helper() {}"),
            ("app/A.php", "<?php namespace App; class A extends \\Lib\\Base { use \\Lib\\Used; }"),
        ]);
        // The parent, what its signatures name, and the trait are loaded; the rest is only named.
        for loaded in ["Lib\\Base", "Lib\\Made", "Lib\\Used"] {
            assert!(idx.codebase.class_like_exists(loaded.as_bytes()), "{loaded}");
        }
        assert!(!idx.codebase.class_like_exists(b"Lib\\Unused"));
        let names: Vec<String> = idx.names().into_iter().map(|(d, _)| d.name.as_str_lossy().into_owned()).collect();
        assert!(names.contains(&"Lib\\Unused".to_string()));
        assert!(names.contains(&"Lib\\helper".to_string()));
        assert_eq!(return_type(&idx, "App\\A", "make"), "Lib\\Made");

        // Using it in the project loads it, from the disk, as the editor's edits do.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("vendor/lib")).unwrap();
        std::fs::write(root.join("vendor/lib/Unused.php"), "<?php namespace Lib; class Unused {} function helper() {}").unwrap();
        let mut idx = Index::empty(IndexConfig::new(&root));
        let paths = idx.discover();
        idx.build(paths, |p| std::fs::read(p).ok(), |_, _| {});
        assert!(!idx.codebase.class_like_exists(b"Lib\\Unused"));
        idx.update(&root.join("app/B.php"), Some(b"<?php namespace App; function f() { return new \\Lib\\Unused; }".to_vec()));
        assert!(idx.codebase.class_like_exists(b"Lib\\Unused"));
    }

    /// What an unchanged library file declares comes from the cache; a changed one, or a cache that can't be read,
    /// is parsed again.
    #[test]
    fn caches_what_library_files_declare() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("vendor/lib")).unwrap();
        let lib = root.join("vendor/lib/A.php");
        std::fs::write(&lib, "<?php namespace Lib; class A {}").unwrap();
        let mut config = IndexConfig::new(&root);
        config.cache = Some(root.join(".cache/index.json"));
        // Which of the two names the index knows, with or without reading library files.
        let names = |read_library: bool| {
            let mut idx = Index::empty(config.clone());
            let paths = idx.discover();
            idx.build(paths, |p| if read_library || !p.starts_with(root.join("vendor")) { std::fs::read(p).ok() } else { None }, |_, _| {});
            ["Lib\\A", "Lib\\Bee"].map(|n| idx.find_declared(n).is_some())
        };
        // The first build parses the file; the second gets its names without reading it.
        assert_eq!(names(true), [true, false]);
        assert_eq!(names(false), [true, false]);
        // A change in size or time misses the cache.
        std::fs::write(&lib, "<?php namespace Lib; class Bee {}").unwrap();
        assert_eq!(names(false), [false, false]);
        assert_eq!(names(true), [false, true]);
        // A cache that can't be read is ignored, and written again.
        std::fs::write(root.join(".cache/index.json"), "{ not json").unwrap();
        assert_eq!(names(false), [false, false]);
        assert_eq!(names(true), [false, true]);
        assert_eq!(names(false), [false, true]);
    }

    #[test]
    fn renaming_a_class_drops_the_old_name() {
        let mut idx = index(&[("app/A.php", "<?php namespace App; class A {}")]);
        idx.update(Path::new("/p/app/A.php"), Some(b"<?php namespace App; class B {}".to_vec()));
        assert!(!idx.codebase.class_like_exists(b"App\\A"));
        assert!(idx.codebase.class_like_exists(b"App\\B"));
    }

    #[test]
    fn excludes_configured_and_default_folders() {
        let mut config = IndexConfig::new("/p");
        config.exclude = vec!["vendor/aws/aws-sdk-php/src/data".into(), "vendor/**/resources/lang".into()];
        let idx = Index::empty(config);
        assert!(idx.includes(Path::new("/p/app/User.php")));
        assert!(idx.includes(Path::new("/p/vendor/laravel/framework/src/Foo.php")));
        assert!(!idx.includes(Path::new("/p/vendor/laravel/framework/tests/FooTest.php")));
        assert!(!idx.includes(Path::new("/p/vendor/aws/aws-sdk-php/src/data/x.php")));
        assert!(!idx.includes(Path::new("/p/vendor/a/b/resources/lang/en/x.php")));
        assert!(!idx.includes(Path::new("/p/storage/framework/views/x.php")));
        assert!(!idx.includes(Path::new("/p/.git/x.php")));
        assert!(!idx.includes(Path::new("/p/app/readme.md")));
        assert!(!idx.includes(Path::new("/p/resources/views/home.blade.php")));
        assert!(!idx.includes(Path::new("/elsewhere/x.php")));
    }
}
