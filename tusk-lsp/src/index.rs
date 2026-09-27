//! The project index: every PHP file of the project, its `vendor` folder, and PHP's built-in stubs, scanned
//! into one populated [`CodebaseMetadata`] that answers "what is this class, method, or function".
//!
//! Each file's scan is merged in on its own, so a change replaces that file's symbols and repopulates only
//! them and the classes that inherit from them.

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use foldhash::HashSet;
use globset::{Glob, GlobSet, GlobSetBuilder};
use mago_allocator::LocalArena;
use mago_codex::metadata::{CodebaseEntryKeys, CodebaseMetadata};
use mago_codex::populator::populate_codebase;
use mago_codex::reference::SymbolReferences;
use mago_codex::scanner::scan_program;
use mago_database::file::{File, FileId, FileType};
use mago_names::resolver::NameResolver;
use mago_php_version::PHPVersion;
use mago_prelude::Prelude;
use mago_word::{Word, WordSet};
use rayon::prelude::*;

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
}

impl IndexConfig {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into(), exclude: vec![], stubs: vec![], php_version: PHPVersion::PHP84 }
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

/// What the index keeps of each file: enough to take its symbols out again.
#[derive(Debug)]
pub struct IndexedFile {
    pub path: PathBuf,
    pub file_type: FileType,
    keys: CodebaseEntryKeys,
}

pub struct Index {
    pub config: IndexConfig,
    pub codebase: CodebaseMetadata,
    pub files: HashMap<FileId, IndexedFile>,
    by_path: HashMap<PathBuf, FileId>,
    excluded: GlobSet,
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

fn scan(path: &Path, file_type: FileType, contents: Vec<u8>, php_version: PHPVersion, arena: &LocalArena) -> CodebaseMetadata {
    let (file, program) = crate::analysis::parse_balanced(arena, path, file_type, contents);
    let names = NameResolver::new(arena).resolve(program);
    scan_program(arena, &file, program, &names, php_version)
}

impl Index {
    /// An index of PHP's built-ins only. Files arrive with [`Index::build`] or [`Index::update`].
    pub fn empty(config: IndexConfig) -> Self {
        let excluded = config.exclusions();
        Self { config, codebase: prelude().metadata.clone(), files: HashMap::new(), by_path: HashMap::new(), excluded }
    }

    /// Whether `path` belongs in the index: a PHP file under the root that no exclusion covers, or a stub.
    pub fn includes(&self, path: &Path) -> bool {
        if path.extension().is_none_or(|e| e != "php") {
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
                        !hidden && !(rel.as_os_str().len() > 0 && excluded.is_match(rel))
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

    /// Scans `paths` in parallel and merges them in. `read` supplies each file's text, so open documents can
    /// win over the disk. `progress` is called with the count done so far.
    pub fn build(
        &mut self,
        paths: Vec<PathBuf>,
        read: impl Fn(&Path) -> Option<Vec<u8>> + Sync,
        progress: impl Fn(usize, usize) + Sync,
    ) {
        let total = paths.len();
        let done = std::sync::atomic::AtomicUsize::new(0);
        let php_version = self.config.php_version;
        let scans: Vec<(PathBuf, FileType, CodebaseMetadata)> = paths
            .into_par_iter()
            .filter_map(|path| {
                let contents = read(&path)?;
                let file_type = self.file_type(&path);
                let meta = scan(&path, file_type, contents, php_version, &LocalArena::new());
                let n = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                if n % 500 == 0 {
                    progress(n, total);
                }
                Some((path, file_type, meta))
            })
            .collect();
        for (_, _, meta) in &scans {
            self.codebase.extend_ref(meta);
        }
        for (path, file_type, meta) in scans {
            let id = file_id(&path);
            let keys = meta.extract_owned_keys(&self.codebase);
            self.by_path.insert(path.clone(), id);
            self.files.insert(id, IndexedFile { path, file_type, keys });
        }
        let mut refs = prelude().symbol_references.clone();
        populate_codebase(&mut self.codebase, &mut refs, WordSet::default(), HashSet::default());
        self.codebase.safe_symbols.clear();
        progress(total, total);
    }

    /// Replaces a file's symbols with those in `contents`, or removes them when `contents` is `None`.
    pub fn update(&mut self, path: &Path, contents: Option<Vec<u8>>) {
        self.update_many(vec![(path.to_path_buf(), contents)]);
    }

    pub fn update_many(&mut self, changes: Vec<(PathBuf, Option<Vec<u8>>)>) {
        let arena = LocalArena::new();
        let mut dirty = WordSet::default();
        let mut scans = vec![];
        for (path, contents) in changes {
            let id = file_id(&path);
            if let Some(old) = self.files.remove(&id) {
                dirty.extend(old.keys.class_like_names.iter().copied());
                dirty.extend(old.keys.function_like_keys.iter().filter(|k| k.1.is_empty()).map(|k| k.0));
                dirty.extend(old.keys.constant_names.iter().copied());
                self.codebase.remove_entries_by_keys(&old.keys);
                self.by_path.remove(&path);
            }
            let Some(contents) = contents else { continue };
            if !self.includes(&path) {
                continue;
            }
            let file_type = self.file_type(&path);
            let meta = scan(&path, file_type, contents, self.config.php_version, &arena);
            dirty.extend(meta.class_likes.keys().copied());
            dirty.extend(meta.function_likes.keys().filter(|k| k.1.is_empty()).map(|k| k.0));
            dirty.extend(meta.constants.keys().copied());
            scans.push((path, file_type, meta));
        }
        for (_, _, meta) in &scans {
            self.codebase.extend_ref(meta);
        }
        for (path, file_type, meta) in scans {
            let id = file_id(&path);
            let keys = meta.extract_owned_keys(&self.codebase);
            self.by_path.insert(path.clone(), id);
            self.files.insert(id, IndexedFile { path, file_type, keys });
        }
        self.repopulate(dirty);
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
        safe.extend(self.codebase.function_likes.keys().filter(|k| k.1.is_empty() && !dirty.contains(&k.0)).map(|k| k.0));
        safe.extend(self.codebase.constants.keys().filter(|k| !dirty.contains(*k)).copied());
        // An empty safe set would repopulate everything, which is also correct.
        let mut refs = SymbolReferences::new();
        populate_codebase(&mut self.codebase, &mut refs, safe, HashSet::default());
        // The analyzer skips "safe" symbols only in its diff mode, but nothing here needs the set kept.
        self.codebase.safe_symbols.clear();
    }

    pub fn path_of(&self, id: FileId) -> Option<&Path> {
        self.files.get(&id).map(|f| f.path.as_path())
    }

    pub fn contains(&self, path: &Path) -> bool {
        self.by_path.contains_key(path)
    }

    /// Project files (not `vendor` or stubs).
    pub fn project_files(&self) -> impl Iterator<Item = &Path> {
        self.files.values().filter(|f| f.file_type == FileType::Host).map(|f| f.path.as_path())
    }
}

/// An index behind a shared pointer, for passing to request threads.
pub type SharedIndex = Arc<parking_lot::RwLock<Index>>;

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(!idx.includes(Path::new("/elsewhere/x.php")));
    }
}
