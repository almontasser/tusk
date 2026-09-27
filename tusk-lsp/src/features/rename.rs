//! Rename: variables within their function; classes, functions, constants, and members across the project.
//!
//! A method or property is renamed in every class of its family that declares it (the interface, the parent,
//! and the overrides), since renaming one alone breaks the others. A class keeps its aliases (`use A as B`),
//! and its file is renamed too when the file is named after it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use lsp_types::{
    DocumentChangeOperation, DocumentChanges, OneOf, OptionalVersionedTextDocumentIdentifier, PrepareRenameResponse,
    RenameFile, RenameParams, ResourceOp, TextDocumentEdit, TextDocumentPositionParams, TextEdit, WorkspaceEdit,
};
use mago_codex::metadata::CodebaseMetadata;
use mago_database::file::FileType;

use super::references::search;
use super::with_ctx;
use crate::index::Index;
use crate::locate::{declaration, variable_spans};
use crate::server::Snapshot;
use crate::symbol::{Found, Symbol};
use crate::text::{LineIndex, path_to_uri};

fn short(name: &str) -> &str {
    name.rsplit('\\').next().unwrap_or(name)
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_alphabetic() || c == '_' || !c.is_ascii()) && chars.all(|c| c.is_alphanumeric() || c == '_' || !c.is_ascii())
}

/// Why a symbol can't be renamed, if it can't: it's declared in `vendor` or is one of PHP's built-ins.
fn refusal(found: &Found, index: &Index) -> Option<String> {
    for symbol in &found.symbols {
        if let Symbol::Variable { name, .. } = symbol {
            if name == "this" {
                return Some("`$this` can't be renamed.".into());
            }
            continue;
        }
        let Some(place) = declaration(symbol, &index.codebase) else {
            return Some("This is declared by PHP or an extension, so it can't be renamed.".into());
        };
        match index.files.get(&place.file) {
            Some(f) if f.file_type == FileType::Host => {}
            Some(_) => return Some("This is declared in a library, so it can't be renamed.".into()),
            None => return Some("This is declared by PHP or an extension, so it can't be renamed.".into()),
        }
    }
    None
}

pub fn prepare(snap: &Snapshot, params: TextDocumentPositionParams) -> Result<Option<PrepareRenameResponse>, String> {
    let result = with_ctx(snap, &params.text_document.uri, |ctx| {
        let found = ctx.symbol_at(params.position).ok_or_else(|| "There's nothing to rename here.".to_string())?;
        if let Some(why) = refusal(&found, &ctx.index) {
            return Err(why);
        }
        let start = if matches!(found.symbols[0], Symbol::Variable { .. }) { found.start + 1 } else { found.start };
        let written = &ctx.doc.text[start as usize..found.end as usize];
        // A qualified name (`\App\User`) renames its last part.
        let last = short(written);
        let start = found.end - last.len() as u32;
        Ok(PrepareRenameResponse::RangeWithPlaceholder { range: ctx.doc.range(start, found.end), placeholder: last.to_string() })
    });
    match result {
        Some(Ok(r)) => Ok(Some(r)),
        Some(Err(why)) => Err(why),
        None => Ok(None),
    }
}

/// The members of a method's or property's family that declare it: in its class, its ancestors, and its
/// descendants.
fn family(symbol: &Symbol, codebase: &CodebaseMetadata) -> Vec<Symbol> {
    let (class, name, is_method) = match symbol {
        Symbol::Method { class, name } => (class, name, true),
        Symbol::Property { class, name } => (class, name, false),
        _ => return vec![symbol.clone()],
    };
    let mut classes = vec![mago_word::word(class.as_bytes())];
    classes.extend(codebase.get_class_ancestors(class.as_bytes()));
    // Descendants of every ancestor, so a sibling implementing the same interface method is included.
    let roots = classes.clone();
    for c in roots {
        classes.extend(codebase.get_all_descendants(c.as_bytes()));
    }
    let lower = name.to_ascii_lowercase();
    let prop = format!("${name}");
    let mut out = vec![];
    for c in classes {
        let Some(meta) = codebase.get_class_like(c.as_bytes()) else { continue };
        if !meta.flags.is_user_defined() {
            continue;
        }
        let declares = if is_method {
            meta.methods.iter().any(|m| m.as_str_lossy() == lower)
        } else {
            meta.properties.keys().any(|p| p.as_str_lossy() == prop)
        };
        if declares {
            let class = meta.original_name.as_str_lossy().into_owned();
            let s = if is_method { Symbol::Method { class, name: name.clone() } } else { Symbol::Property { class, name: name.clone() } };
            if !out.contains(&s) {
                out.push(s);
            }
        }
    }
    if out.is_empty() {
        out.push(symbol.clone());
    }
    out
}

/// Edits by file, before they're turned into a workspace edit.
#[derive(Default)]
pub struct Edits(BTreeMap<PathBuf, Vec<TextEdit>>);

impl Edits {
    pub fn add(&mut self, path: &Path, edit: TextEdit) {
        let edits = self.0.entry(path.to_path_buf()).or_default();
        if !edits.iter().any(|e| e.range == edit.range && e.new_text == edit.new_text) {
            edits.push(edit);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The workspace edit, with open documents' versions, then `renames` of files.
    pub fn into_workspace_edit(self, snap: &Snapshot, renames: Vec<(PathBuf, PathBuf)>) -> WorkspaceEdit {
        let mut ops: Vec<DocumentChangeOperation> = self
            .0
            .into_iter()
            .map(|(path, edits)| {
                let version = snap.docs.get(&path).map(|d| d.version);
                DocumentChangeOperation::Edit(TextDocumentEdit {
                    text_document: OptionalVersionedTextDocumentIdentifier { uri: path_to_uri(&path), version },
                    edits: edits.into_iter().map(OneOf::Left).collect(),
                })
            })
            .collect();
        for (from, to) in renames {
            ops.push(DocumentChangeOperation::Op(ResourceOp::Rename(RenameFile {
                old_uri: path_to_uri(&from),
                new_uri: path_to_uri(&to),
                options: None,
                annotation_id: None,
            })));
        }
        WorkspaceEdit { changes: None, document_changes: Some(DocumentChanges::Operations(ops)), change_annotations: None }
    }
}

pub fn rename(snap: &Snapshot, params: RenameParams) -> Result<Option<WorkspaceEdit>, String> {
    let at = params.text_document_position;
    let new_name = params.new_name.trim().trim_start_matches('$').to_string();
    if !is_identifier(&new_name) {
        return Err(format!("`{new_name}` isn't a valid PHP name."));
    }
    let Some(found) = with_ctx(snap, &at.text_document.uri, |ctx| ctx.symbol_at(at.position)).flatten() else {
        return Ok(None);
    };
    let index = snap.index.read();
    if let Some(why) = refusal(&found, &index) {
        return Err(why);
    }
    let mut edits = Edits::default();
    let mut renames = vec![];

    match &found.symbols[0] {
        Symbol::Variable { name, scope } => {
            let doc = snap.doc(&at.text_document.uri).ok_or("The document isn't open.")?;
            let arena = mago_allocator::LocalArena::new();
            let parsed = crate::analysis::Parsed::new(&arena, &doc.path, &doc.text);
            for (s, e) in variable_spans(&parsed, name, *scope) {
                edits.add(&doc.path, TextEdit { range: doc.range(s, e), new_text: new_name.clone() });
            }
        }
        first => {
            let mut symbols: Vec<Symbol> = vec![];
            for s in &found.symbols {
                for member in family(s, &index.codebase) {
                    if !symbols.contains(&member) {
                        symbols.push(member);
                    }
                }
            }
            let old_short = match first {
                Symbol::Class(n) | Symbol::Function(n) | Symbol::Constant(n) => short(n).to_string(),
                Symbol::Method { name, .. } | Symbol::Property { name, .. } | Symbol::ClassConstant { name, .. } => name.clone(),
                Symbol::Variable { .. } => unreachable!(),
            };
            for (path, text, spans) in search(snap, &index, &symbols) {
                let lines = LineIndex::new(&text);
                for (s, e) in spans {
                    let written = &text[s as usize..e as usize];
                    let last = short(written.trim_start_matches('$'));
                    // An alias names the class differently; the `use` line that makes it gets renamed.
                    if !last.eq_ignore_ascii_case(&old_short) {
                        continue;
                    }
                    let start = e - last.len() as u32;
                    edits.add(&path, TextEdit { range: lines.range(&text, start, e), new_text: new_name.clone() });
                }
            }
            // A promoted property is also a parameter used by name in its constructor.
            for s in &symbols {
                if let Symbol::Property { class, name } = s {
                    rename_promoted_parameter(snap, &index, class, name, &new_name, &mut edits);
                }
            }
            if let Symbol::Class(class) = first
                && let Some(place) = declaration(first, &index.codebase)
                && let Some(path) = index.path_of(place.file)
                && path.file_stem().is_some_and(|s| s.to_string_lossy() == short(class))
            {
                renames.push((path.to_path_buf(), path.with_file_name(format!("{new_name}.php"))));
            }
        }
    }
    Ok(Some(edits.into_workspace_edit(snap, renames)))
}

/// Renames a promoted property's parameter uses inside its constructor.
fn rename_promoted_parameter(snap: &Snapshot, index: &Index, class: &str, name: &str, new_name: &str, edits: &mut Edits) {
    let Some(ctor) = index.codebase.get_method(class.as_bytes(), b"__construct") else { return };
    let is_promoted = ctor.parameters.iter().any(|p| p.flags.is_promoted_property() && p.get_name().0.as_str_lossy() == format!("${name}"));
    if !is_promoted {
        return;
    }
    let Some(path) = index.path_of(ctor.span.file_id) else { return };
    let Some(text) = snap.read(path) else { return };
    let arena = mago_allocator::LocalArena::new();
    let parsed = crate::analysis::Parsed::new(&arena, path, &text);
    let lines = LineIndex::new(&text);
    for (s, e) in variable_spans(&parsed, name, (ctor.span.start.offset, ctor.span.end.offset)) {
        edits.add(path, TextEdit { range: lines.range(&text, s, e), new_text: new_name.to_string() });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fixture;
    use crate::text::uri_to_path;

    /// Applies a rename and returns each changed file's new text, and the file renames.
    fn apply(fx: &Fixture, new_name: &str) -> (BTreeMap<String, String>, Vec<(String, String)>) {
        let edit = rename(&fx.snap, RenameParams {
            text_document_position: fx.at(),
            new_name: new_name.into(),
            work_done_progress_params: Default::default(),
        })
        .unwrap()
        .unwrap();
        let mut files = BTreeMap::new();
        let mut renames = vec![];
        let Some(DocumentChanges::Operations(ops)) = edit.document_changes else { panic!() };
        let name = |u: &lsp_types::Uri| u.as_str().rsplit('/').next().unwrap().to_string();
        for op in ops {
            match op {
                DocumentChangeOperation::Edit(e) => {
                    let path = uri_to_path(&e.text_document.uri).unwrap();
                    let doc = fx.snap.docs.get(&path).unwrap();
                    let mut text = doc.text.clone();
                    let mut edits: Vec<_> = e.edits.into_iter().map(|e| match e { OneOf::Left(e) => e, OneOf::Right(a) => a.text_edit }).collect();
                    edits.sort_by_key(|e| std::cmp::Reverse(doc.offset(e.range.start)));
                    for e in edits {
                        text.replace_range(doc.offset(e.range.start) as usize..doc.offset(e.range.end) as usize, &e.new_text);
                    }
                    files.insert(name(&e.text_document.uri), text);
                }
                DocumentChangeOperation::Op(ResourceOp::Rename(r)) => renames.push((name(&r.old_uri), name(&r.new_uri))),
                _ => {}
            }
        }
        (files, renames)
    }

    #[test]
    fn renames_a_method_across_its_family() {
        let fx = Fixture::new(&[
            ("app/Shape.php", "<?php\nnamespace App;\ninterface Shape { public function area(): float; }\nclass Square implements Shape { public function area(): float { return 1.0; } }\nclass Circle implements Shape { public function area(): float { return 2.0; } }\nclass Other { public function area(): int { return 0; } }\n"),
            ("app/use.php", "<?php\nfunction f(\\App\\Square $s, \\App\\Other $o) { return $s->ar<|>ea() + $o->area(); }\n"),
        ]);
        let (files, _) = apply(&fx, "surface");
        assert_eq!(
            files["Shape.php"],
            "<?php\nnamespace App;\ninterface Shape { public function surface(): float; }\nclass Square implements Shape { public function surface(): float { return 1.0; } }\nclass Circle implements Shape { public function surface(): float { return 2.0; } }\nclass Other { public function area(): int { return 0; } }\n"
        );
        assert_eq!(files["use.php"], "<?php\nfunction f(\\App\\Square $s, \\App\\Other $o) { return $s->surface() + $o->area(); }\n");
    }

    #[test]
    fn renames_a_class_its_file_and_mentions_but_not_aliases() {
        let fx = Fixture::new(&[
            ("app/User.php", "<?php\nnamespace App;\nclass Us<|>er {}\n"),
            ("app/use.php", "<?php\nuse App\\User;\nuse App\\User as Person;\n/** @param User $u */\nfunction f(User $u, Person $p): \\App\\User { return new User; }\n"),
        ]);
        let (files, renames) = apply(&fx, "Member");
        assert_eq!(files["User.php"], "<?php\nnamespace App;\nclass Member {}\n");
        assert_eq!(
            files["use.php"],
            "<?php\nuse App\\Member;\nuse App\\Member as Person;\n/** @param Member $u */\nfunction f(Member $u, Person $p): \\App\\Member { return new Member; }\n"
        );
        assert_eq!(renames, vec![("User.php".to_string(), "Member.php".to_string())]);
    }

    #[test]
    fn renames_properties_and_promoted_parameters() {
        let fx = Fixture::new(&[(
            "t.php",
            "<?php\nclass A {\n    public function __construct(private int $count) { $this->count = $count + 1; }\n    public function get(): int { return $this->cou<|>nt; }\n}\n",
        )]);
        let (files, _) = apply(&fx, "total");
        assert_eq!(
            files["t.php"],
            "<?php\nclass A {\n    public function __construct(private int $total) { $this->total = $total + 1; }\n    public function get(): int { return $this->total; }\n}\n"
        );
    }

    #[test]
    fn renames_variables_in_their_function_only() {
        let fx = Fixture::one("<?php\nfunction f($a) { $b = $<|>a; return fn() => $a; }\nfunction g($a) { return $a; }\n");
        let (files, _) = apply(&fx, "$first");
        assert_eq!(files["test.php"], "<?php\nfunction f($first) { $b = $first; return fn() => $first; }\nfunction g($a) { return $a; }\n");
    }

    #[test]
    fn refuses_built_ins_and_bad_names() {
        let fx = Fixture::one("<?php\nstrl<|>en('');\n");
        let err = prepare(&fx.snap, fx.at()).unwrap_err();
        assert!(err.contains("PHP"), "{err}");
        let fx = Fixture::one("<?php\nfunction f<|>oo() {}\n");
        assert!(rename(&fx.snap, RenameParams { text_document_position: fx.at(), new_name: "1x".into(), work_done_progress_params: Default::default() }).is_err());
        let Some(PrepareRenameResponse::RangeWithPlaceholder { placeholder, .. }) = prepare(&fx.snap, fx.at()).unwrap() else { panic!() };
        assert_eq!(placeholder, "foo");
    }
}
