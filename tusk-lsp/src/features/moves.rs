//! Moving PHP files (Move Class): the moved file's namespace and class name follow its new path through
//! composer.json's PSR-4 map, and every reference to its classes follows them.
//!
//! The editor moves the files first and then asks, so moved files are read at their new paths.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use lsp_types::{FileRename, RenameFilesParams, TextEdit, WorkspaceEdit};
use mago_allocator::LocalArena;
use mago_names::kind::NameKind;
use mago_span::HasSpan;
use mago_syntax::cst::{NamespaceBody, Program, Statement, TriviaKind};
use rayon::prelude::*;
use serde_json::Value;

use super::rename::Edits;
use crate::analysis::Parsed;
use crate::documents::Document;
use crate::imports::import_edits;
use crate::scope::{resolve_class, scope_at};
use crate::server::Snapshot;
use crate::symbol::docblock_type_names;
use crate::text::{LineIndex, path_to_uri, uri_to_path};

/// composer.json's PSR-4 map: namespace prefix (without a trailing `\`) and folder, relative to the root.
pub fn psr4(composer_json: &str) -> Vec<(String, PathBuf)> {
    let Ok(json) = serde_json::from_str::<Value>(composer_json) else { return vec![] };
    let mut out = vec![];
    for section in ["/autoload/psr-4", "/autoload-dev/psr-4"] {
        let Some(map) = json.pointer(section).and_then(Value::as_object) else { continue };
        for (prefix, dirs) in map {
            let dirs: Vec<&str> = match dirs {
                Value::String(d) => vec![d.as_str()],
                Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
                _ => vec![],
            };
            for d in dirs {
                out.push((prefix.trim_end_matches('\\').to_string(), PathBuf::from(d.trim_end_matches('/'))));
            }
        }
    }
    out
}

/// The namespace PSR-4 gives a file at `path`, or `None` if no mapped folder holds it.
pub fn namespace_for(root: &Path, map: &[(String, PathBuf)], path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let (prefix, dir) = map.iter().filter(|(_, d)| rel.starts_with(d)).max_by_key(|(_, d)| d.as_os_str().len())?;
    let inner = rel.strip_prefix(dir).ok()?.parent()?;
    let mut ns = prefix.clone();
    for part in inner.components() {
        let part = part.as_os_str().to_string_lossy();
        if !ns.is_empty() {
            ns.push('\\');
        }
        ns.push_str(&part);
    }
    Some(ns)
}

/// The namespace statement's name span, the file's namespace, and its top-level class-likes (name span, name).
struct Declarations {
    namespace: Option<(u32, u32, String)>,
    classes: Vec<(u32, u32, String)>,
}

fn declarations(program: &Program<'_>, text: &str) -> Declarations {
    let mut namespace = None;
    let mut classes = vec![];
    let visit = |statements: Vec<&Statement<'_>>, classes: &mut Vec<(u32, u32, String)>| {
        for s in statements {
            let name = match s {
                Statement::Class(c) => &c.name,
                Statement::Interface(c) => &c.name,
                Statement::Trait(c) => &c.name,
                Statement::Enum(c) => &c.name,
                _ => continue,
            };
            classes.push((name.span.start.offset, name.span.end.offset, String::from_utf8_lossy(name.value).into_owned()));
        }
    };
    visit(program.statements.iter().collect(), &mut classes);
    for s in program.statements.iter() {
        if let Statement::Namespace(ns) = s {
            if let Some(name) = &ns.name {
                let span = name.span();
                namespace = Some((span.start.offset, span.end.offset, text[span.start.offset as usize..span.end.offset as usize].to_string()));
            }
            let inner = match &ns.body {
                NamespaceBody::Implicit(b) => b.statements.iter().collect(),
                NamespaceBody::BraceDelimited(b) => b.statements.iter().collect(),
            };
            visit(inner, &mut classes);
        }
    }
    Declarations { namespace, classes }
}

/// The spans of `use` statements in a program, top level and in namespaces.
fn use_spans(program: &Program<'_>) -> Vec<(u32, u32)> {
    let mut out = vec![];
    for s in program.statements.iter() {
        match s {
            Statement::Use(u) => out.push((u.span().start.offset, u.span().end.offset)),
            Statement::Namespace(ns) => {
                let inner: Vec<&Statement<'_>> = match &ns.body {
                    NamespaceBody::Implicit(b) => b.statements.iter().collect(),
                    NamespaceBody::BraceDelimited(b) => b.statements.iter().collect(),
                };
                out.extend(inner.iter().filter_map(|s| match s {
                    Statement::Use(u) => Some((u.span().start.offset, u.span().end.offset)),
                    _ => None,
                }));
            }
            _ => {}
        }
    }
    out
}

fn namespace_of(fqn: &str) -> &str {
    fqn.rsplit_once('\\').map_or("", |(ns, _)| ns)
}

fn short(fqn: &str) -> &str {
    fqn.rsplit('\\').next().unwrap_or(fqn)
}

pub fn will_rename(snap: &Snapshot, params: RenameFilesParams) -> Result<Option<WorkspaceEdit>, String> {
    let moves: Vec<(PathBuf, PathBuf)> = params
        .files
        .iter()
        .filter_map(|FileRename { old_uri, new_uri }| {
            let from = uri_to_path(&old_uri.parse().ok()?)?;
            let to = uri_to_path(&new_uri.parse().ok()?)?;
            (to.extension().is_some_and(|e| e == "php") && !to.to_string_lossy().ends_with(".blade.php")).then_some((from, to))
        })
        .collect();
    if moves.is_empty() {
        return Ok(None);
    }
    let map = psr4(&snap.read(&snap.root.join("composer.json")).unwrap_or_default());
    if map.is_empty() {
        return Err("Moving classes needs a PSR-4 autoload map in composer.json.".into());
    }

    // Each moved class's old and new fully qualified name.
    let mut renamed: BTreeMap<String, String> = BTreeMap::new();
    let mut moved_files = vec![];
    for (from, to) in &moves {
        let text = snap.read(to).or_else(|| snap.read(from)).ok_or_else(|| format!("Can't read {}.", to.display()))?;
        let arena = LocalArena::new();
        let parsed = Parsed::new(&arena, to, &text);
        let decl = declarations(parsed.program, &text);
        let old_ns = decl.namespace.as_ref().map(|n| n.2.clone()).unwrap_or_default();
        let Some(new_ns) = namespace_for(&snap.root, &map, to) else {
            return Err(format!("No PSR-4 folder in composer.json holds {}.", to.strip_prefix(&snap.root).unwrap_or(to).display()));
        };
        let old_stem = from.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let new_stem = to.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        for (_, _, name) in &decl.classes {
            let new_name = if *name == old_stem { new_stem.clone() } else { name.clone() };
            let qualify = |ns: &str, n: &str| if ns.is_empty() { n.to_string() } else { format!("{ns}\\{n}") };
            renamed.insert(qualify(&old_ns, name), qualify(&new_ns, &new_name));
        }
        moved_files.push((to.clone(), text, old_ns, new_ns, old_stem, new_stem));
    }
    let renamed_lower: BTreeMap<String, String> = renamed.iter().map(|(k, v)| (k.to_ascii_lowercase(), v.clone())).collect();

    let mut edits = Edits::default();
    let mut imports: HashSet<(PathBuf, String)> = HashSet::new();

    // The moved files: namespace, class names, and imports for what they used from their old namespace.
    for (path, text, old_ns, new_ns, old_stem, new_stem) in &moved_files {
        let arena = LocalArena::new();
        let parsed = Parsed::new(&arena, path, text);
        let lines = LineIndex::new(text);
        let doc = Document::new(path_to_uri(path), path.clone(), "php".into(), 0, text.clone());
        let decl = declarations(parsed.program, text);
        if old_ns != new_ns {
            match &decl.namespace {
                Some((s, e, _)) => edits.add(path, TextEdit { range: lines.range(text, *s, *e), new_text: new_ns.clone() }),
                None => {
                    let after = text.find("<?php").map_or(0, |i| i + 5) as u32;
                    edits.add(path, TextEdit { range: lines.range(text, after, after), new_text: format!("\n\nnamespace {new_ns};") });
                }
            }
        }
        for (s, e, name) in &decl.classes {
            if name == old_stem && old_stem != new_stem {
                edits.add(path, TextEdit { range: lines.range(text, *s, *e), new_text: new_stem.clone() });
            }
        }
        if old_ns == new_ns {
            continue;
        }
        let uses = use_spans(parsed.program);
        let mut needed: Vec<String> = vec![];
        let own: HashSet<String> = decl.classes.iter().map(|(_, _, n)| n.to_ascii_lowercase()).collect();
        for (s, _e, fqn, imported) in parsed.names.iter() {
            let fqn = String::from_utf8_lossy(fqn).into_owned();
            let written = &text[s as usize.._e as usize];
            if imported || written.contains('\\') || uses.iter().any(|(us, ue)| *us <= s && s < *ue) {
                continue;
            }
            // An unqualified name that PHP resolved in the old namespace.
            if !namespace_of(&fqn).eq_ignore_ascii_case(old_ns) || own.contains(&short(&fqn).to_ascii_lowercase()) {
                continue;
            }
            let target = renamed_lower.get(&fqn.to_ascii_lowercase()).cloned().unwrap_or(fqn.clone());
            if !snap.index.read().codebase.class_like_exists(fqn.as_bytes()) && !renamed_lower.contains_key(&fqn.to_ascii_lowercase()) {
                continue;
            }
            if namespace_of(&target).eq_ignore_ascii_case(new_ns) {
                continue;
            }
            if imports.insert((path.clone(), target.to_ascii_lowercase())) {
                needed.push(target);
            }
        }
        for e in import_edits(&doc, parsed.program, text.len() as u32, &needed, NameKind::Default) {
            edits.add(path, e);
        }
    }

    // Every file that mentions a moved class.
    let mut paths: Vec<PathBuf> = snap.index.read().project_files().map(Path::to_path_buf).collect();
    paths.extend(snap.docs.iter().filter(|d| d.language == "php").map(|d| d.path.clone()));
    paths.extend(moved_files.iter().map(|m| m.0.clone()));
    let moved_old: HashSet<PathBuf> = moves.iter().map(|m| m.0.clone()).collect();
    paths.retain(|p| !moved_old.contains(p));
    paths.sort();
    paths.dedup();
    let shorts: Vec<String> = renamed.keys().map(|k| short(k).to_ascii_lowercase()).collect();
    let per_file: Vec<(PathBuf, Vec<TextEdit>, Vec<String>)> = paths
        .into_par_iter()
        .filter_map(|path| {
            let text = snap.read(&path)?;
            let lower = text.to_ascii_lowercase();
            if !shorts.iter().any(|s| lower.contains(s.as_str())) {
                return None;
            }
            let (edits, imports) = file_edits(&path, &text, &renamed_lower, &moved_files);
            (!edits.is_empty() || !imports.is_empty()).then_some((path, edits, imports))
        })
        .collect();
    for (path, file_edits, needed) in per_file {
        for e in file_edits {
            edits.add(&path, e);
        }
        let text = snap.read(&path).unwrap_or_default();
        let arena = LocalArena::new();
        let parsed = Parsed::new(&arena, &path, &text);
        let doc = Document::new(path_to_uri(&path), path.clone(), "php".into(), 0, text.clone());
        let needed: Vec<String> = needed.into_iter().filter(|f| imports.insert((path.clone(), f.to_ascii_lowercase()))).collect();
        for e in import_edits(&doc, parsed.program, text.len() as u32, &needed, NameKind::Default) {
            edits.add(&path, e);
        }
    }
    Ok(Some(edits.into_workspace_edit(snap, vec![])))
}

/// The edits one file needs for the moved classes, and the imports it now needs.
fn file_edits(
    path: &Path,
    text: &str,
    renamed: &BTreeMap<String, String>,
    moved_files: &[(PathBuf, String, String, String, String, String)],
) -> (Vec<TextEdit>, Vec<String>) {
    let arena = LocalArena::new();
    let parsed = Parsed::new(&arena, path, text);
    let lines = LineIndex::new(text);
    let uses = use_spans(parsed.program);
    let is_moved = moved_files.iter().any(|m| m.0 == path);
    let file_ns = declarations(parsed.program, text).namespace.map(|n| n.2).unwrap_or_default();
    // A moved file's own namespace changes, so compare against where it's going.
    let file_ns = moved_files.iter().find(|m| m.0 == path).map_or(file_ns, |m| m.3.clone());
    let mut edits = vec![];
    let mut needed = vec![];
    let mut mentions: Vec<(u32, u32, String, bool)> = parsed
        .names
        .iter()
        .map(|(s, e, fqn, imported)| (s, e, String::from_utf8_lossy(fqn).into_owned(), imported))
        .collect();
    // Class names in docblock types.
    for t in parsed.program.trivia.iter().filter(|t| t.kind == TriviaKind::DocBlockComment) {
        for (s, e, name) in docblock_type_names(t.value, t.span.start.offset) {
            let scope = scope_at(parsed.program, s);
            let imported = !name.contains('\\') && scope.resolve_alias(NameKind::Default, name.as_bytes()).is_some();
            mentions.push((s, e, resolve_class(&scope, &name), imported));
        }
    }
    for (s, e, fqn, imported) in mentions {
        let Some(new_fqn) = renamed.get(&fqn.to_ascii_lowercase()) else { continue };
        let written = &text[s as usize..e as usize];
        let in_use = uses.iter().any(|(us, ue)| *us <= s && s < *ue);
        let range = lines.range(text, s, e);
        if in_use {
            let lead = if written.starts_with('\\') { "\\" } else { "" };
            edits.push(TextEdit { range, new_text: format!("{lead}{new_fqn}") });
        } else if written.contains('\\') {
            edits.push(TextEdit { range, new_text: format!("\\{new_fqn}") });
        } else {
            let old_short = short(&fqn);
            let new_short = short(new_fqn);
            // Written through an alias: the `use` line changes instead.
            if !written.eq_ignore_ascii_case(old_short) {
                continue;
            }
            if written != new_short {
                edits.push(TextEdit { range, new_text: new_short.to_string() });
            }
            // It resolved through the file's namespace; now it needs an import, unless it moved there.
            if !imported && !namespace_of(new_fqn).eq_ignore_ascii_case(&file_ns) && !needed.contains(new_fqn) {
                needed.push(new_fqn.clone());
            }
        }
    }
    let _ = is_moved;
    (edits, needed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Fixture, ROOT, path};
    use lsp_types::{DocumentChangeOperation, DocumentChanges, OneOf};

    fn apply(fx: &Fixture, moves: &[(&str, &str)], moved_text: &[(&str, &str)]) -> BTreeMap<String, String> {
        // The editor has already moved the files: their text is at the new path.
        let mut docs = fx.snap.docs.clone();
        for (to, text) in moved_text {
            docs.insert(Document::new(crate::testing::uri(to), path(to), "php".into(), 1, text.to_string()));
        }
        for (from, _) in moves {
            docs.remove(&path(from));
        }
        let snap = Snapshot { docs, index: fx.snap.index.clone(), root: fx.snap.root.clone(), framework: fx.snap.framework.clone() };
        let edit = will_rename(&snap, RenameFilesParams {
            files: moves.iter().map(|(f, t)| FileRename { old_uri: crate::testing::uri(f).to_string(), new_uri: crate::testing::uri(t).to_string() }).collect(),
        })
        .unwrap()
        .unwrap();
        let Some(DocumentChanges::Operations(ops)) = edit.document_changes else { panic!() };
        let mut out = BTreeMap::new();
        for op in ops {
            let DocumentChangeOperation::Edit(e) = op else { continue };
            let p = uri_to_path(&e.text_document.uri).unwrap();
            let doc = snap.docs.get(&p).unwrap();
            let mut text = doc.text.clone();
            let mut list: Vec<_> = e.edits.into_iter().map(|e| match e { OneOf::Left(e) => e, OneOf::Right(a) => a.text_edit }).collect();
            list.sort_by_key(|e| std::cmp::Reverse((doc.offset(e.range.start), doc.offset(e.range.end))));
            for e in list {
                text.replace_range(doc.offset(e.range.start) as usize..doc.offset(e.range.end) as usize, &e.new_text);
            }
            out.insert(p.strip_prefix(ROOT).unwrap().to_string_lossy().trim_start_matches('/').to_string(), text);
        }
        out
    }

    const COMPOSER: &str = r#"{"autoload": {"psr-4": {"App\\": "app/"}}}"#;

    #[test]
    fn maps_paths_to_namespaces() {
        let map = psr4(r#"{"autoload":{"psr-4":{"App\\":"app/","App\\Tests\\":["tests/"]}}}"#);
        let root = Path::new("/r");
        let ns = |p: &str| namespace_for(root, &map, &root.join(p));
        assert_eq!(ns("app/Models/User.php").as_deref(), Some("App\\Models"));
        assert_eq!(ns("app/User.php").as_deref(), Some("App"));
        assert_eq!(ns("tests/Unit/A.php").as_deref(), Some("App\\Tests\\Unit"));
        assert_eq!(ns("lib/A.php"), None);
    }

    #[test]
    fn moves_a_class_to_another_namespace() {
        let user = "<?php\n\nnamespace App\\Models;\n\nclass User extends Base\n{\n    public function posts(): Post { return new Post; }\n}\n";
        let fx = Fixture::new(&[
            ("composer.json", COMPOSER),
            ("app/Models/User.php", user),
            ("app/Models/Base.php", "<?php\nnamespace App\\Models;\nclass Base {}\n"),
            ("app/Models/Post.php", "<?php\nnamespace App\\Models;\nclass Post { public function author(): User { return new User; } }\n"),
            ("app/Http/C.php", "<?php\nnamespace App\\Http;\n\nuse App\\Models\\User;\n\n/** @var \\App\\Models\\User $u */\nfunction f(User $u) {}\n"),
        ]);
        let out = apply(&fx, &[("app/Models/User.php", "app/Auth/Account.php")], &[("app/Auth/Account.php", user)]);
        assert_eq!(
            out["app/Auth/Account.php"],
            "<?php\n\nnamespace App\\Auth;\n\nuse App\\Models\\Base;\nuse App\\Models\\Post;\n\nclass Account extends Base\n{\n    public function posts(): Post { return new Post; }\n}\n"
        );
        assert_eq!(out["app/Models/Post.php"], "<?php\nnamespace App\\Models;\n\nuse App\\Auth\\Account;\n\nclass Post { public function author(): Account { return new Account; } }\n");
        assert_eq!(out["app/Http/C.php"], "<?php\nnamespace App\\Http;\n\nuse App\\Auth\\Account;\n\n/** @var \\App\\Auth\\Account $u */\nfunction f(Account $u) {}\n");
    }
}
