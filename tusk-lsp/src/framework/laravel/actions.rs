//! Laravel LSP's quick fixes: create a missing view or Inertia page, add a missing variable to `.env`, and turn
//! `.env` variables into Vite ones. Each opens what it created or changed with the editor's `phpEditor.open`.

use std::path::{Path, PathBuf};

use lsp_types::{
    CodeAction, CodeActionKind, Command, CreateFile, CreateFileOptions, Diagnostic, DocumentChangeOperation, DocumentChanges, NumberOrString,
    OneOf, OptionalVersionedTextDocumentIdentifier, Position, Range, ResourceOp, TextDocumentEdit, TextEdit, WorkspaceEdit,
};
use serde_json::json;

use super::data::Data;
use crate::features::Ctx;
use crate::text::path_to_uri;

fn open(path: &Path, line: u32) -> Command {
    Command { title: "Open file".into(), command: "phpEditor.open".into(), arguments: Some(vec![json!(path_to_uri(path).as_str()), json!(line)]) }
}

/// Creates `path` unless it exists, then inserts `text` at `at` in it.
fn create_and_insert(path: &Path, at: Position, text: Option<String>) -> WorkspaceEdit {
    let uri = path_to_uri(path);
    let mut ops = vec![DocumentChangeOperation::Op(ResourceOp::Create(CreateFile {
        uri: uri.clone(),
        options: Some(CreateFileOptions { overwrite: Some(false), ignore_if_exists: Some(true) }),
        annotation_id: None,
    }))];
    if let Some(text) = text {
        ops.push(DocumentChangeOperation::Edit(TextDocumentEdit {
            text_document: OptionalVersionedTextDocumentIdentifier { uri, version: None },
            edits: vec![OneOf::Left(TextEdit { range: Range { start: at, end: at }, new_text: text })],
        }));
    }
    WorkspaceEdit { changes: None, document_changes: Some(DocumentChanges::Operations(ops)), change_annotations: None }
}

fn action(title: String, diagnostic: Option<&Diagnostic>, preferred: bool, edit: WorkspaceEdit, command: Command) -> CodeAction {
    CodeAction {
        title,
        kind: Some(CodeActionKind::QUICKFIX),
        diagnostics: diagnostic.map(|d| vec![d.clone()]),
        is_preferred: preferred.then_some(true),
        edit: Some(edit),
        command: Some(command),
        ..Default::default()
    }
}

fn overlaps(a: &Range, b: &Range) -> bool {
    a.start <= b.end && b.start <= a.end
}

/// Where a new `.env` line goes, and the text to insert: after the last variable sharing the new one's prefix
/// (`DB_` for `DB_PORT`), else at the end after a blank line. Returns the insertion line and the text.
pub fn env_insertion(env: &str, line: &str) -> (u32, String) {
    if env.trim().is_empty() {
        return (0, format!("{line}\n"));
    }
    let lines: Vec<&str> = env.split('\n').collect();
    let key = line.split('=').next().unwrap_or(line);
    let prefix = key.split('_').next().map(|p| format!("{p}_"));
    let last = prefix.as_deref().and_then(|p| lines.iter().rposition(|l| l.starts_with(p)));
    match last {
        Some(i) => (i as u32 + 1, format!("{line}\n")),
        None => {
            // `split` counts a trailing newline's empty last line, which is where the new text goes.
            let at = lines.len().saturating_sub(usize::from(env.ends_with('\n'))) as u32;
            (at, format!("\n{line}\n"))
        }
    }
}

/// The value `.env.example` gives `key`, if it has it.
fn example_value(root: &Path, key: &str) -> Option<String> {
    let text = std::fs::read_to_string(root.join(".env.example")).ok()?;
    text.lines().find_map(|l| {
        let (k, v) = l.split_once('=')?;
        (k.trim() == key).then(|| v.trim().to_string())
    })
}

fn is_env_file(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n.to_string_lossy().starts_with(".env"))
}

pub fn code_actions(ctx: &Ctx<'_>, range: Range) -> Vec<CodeAction> {
    let data = Data(&ctx.snap.framework);
    if !data.active() {
        return vec![];
    }
    let root = data.root().to_path_buf();
    if is_env_file(&ctx.doc.path) {
        return vite_actions(ctx, range).into_iter().collect();
    }
    let mut out = vec![];
    for d in super::diagnostics(ctx).iter().filter(|d| overlaps(&d.range, &range)) {
        let Some(NumberOrString::String(code)) = &d.code else { continue };
        let start = ctx.doc.offset(d.range.start) as usize;
        let end = ctx.doc.offset(d.range.end) as usize;
        let missing = ctx.doc.text[start..end].to_string();
        match code.as_str() {
            "view" if !missing.contains("::") => {
                let path = root.join("resources/views").join(format!("{}.blade.php", missing.replace('.', "/")));
                out.push(action("Create missing view".into(), Some(d), true, create_and_insert(&path, Position::default(), None), open(&path, 1)));
            }
            "env" => {
                let path = root.join(".env");
                let env = std::fs::read_to_string(&path).unwrap_or_default();
                let mut add = |title: String, line: String, preferred: bool| {
                    let (at, text) = env_insertion(&env, &line);
                    // The new variable's 1-based line: after the blank line the text may start with.
                    let line_no = at + 1 + u32::from(text.starts_with('\n'));
                    out.push(action(title, Some(d), preferred, create_and_insert(&path, Position::new(at, 0), Some(text)), open(&path, line_no)));
                };
                add("Add variable to .env".into(), format!("{missing}="), true);
                if let Some(value) = example_value(&root, &missing) {
                    add("Add value from .env.example".into(), format!("{missing}={value}"), false);
                }
            }
            "inertia" => out.extend(inertia_actions(&data, &root, d, &missing)),
            _ => {}
        }
    }
    out
}

/// One action per configured page folder, creating the page with the extension pages already use.
fn inertia_actions(data: &Data<'_>, root: &Path, d: &Diagnostic, missing: &str) -> Vec<CodeAction> {
    let inertia = data.inertia();
    let strings = |key: &str| -> Vec<String> { inertia[key].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect() };
    let mut paths = strings("paths");
    if paths.is_empty() {
        paths = vec!["resources/js/Pages".into()];
    }
    let existing = inertia["pages"].as_object().and_then(|p| p.values().find_map(|v| v.as_str()).and_then(|p| Path::new(p).extension()).map(|e| e.to_string_lossy().into_owned()));
    let ext = existing.or_else(|| strings("extensions").into_iter().next()).unwrap_or_else(|| "vue".into());
    paths
        .iter()
        .map(|dir| {
            let rel = format!("{dir}/{missing}.{ext}");
            let path: PathBuf = root.join(&rel);
            let template = (ext == "vue").then(|| "<script setup>\n\n</script>\n\n<template>\n\n</template>".to_string());
            action(format!("Create {rel}"), Some(d), true, create_and_insert(&path, Position::default(), template), open(&path, 1))
        })
        .collect()
}

/// `VITE_KEY="${KEY}"` for the `.env` variables in the selection that don't have one yet.
fn vite_actions(ctx: &Ctx<'_>, range: Range) -> Option<CodeAction> {
    let text = &ctx.doc.text;
    let lines: Vec<&str> = text.split('\n').collect();
    let has = |key: &str| lines.iter().any(|l| l.starts_with(&format!("VITE_{key}=")));
    let keys: Vec<&str> = (range.start.line..=range.end.line)
        .filter_map(|i| lines.get(i as usize))
        .filter_map(|l| l.split_once('=').map(|(k, _)| k.trim()))
        .filter(|k| !k.is_empty() && !k.starts_with('#') && !k.starts_with("VITE_") && !has(k))
        .collect();
    if keys.is_empty() {
        return None;
    }
    let value = keys.iter().map(|k| format!("VITE_{k}=\"${{{k}}}\"")).collect::<Vec<_>>().join("\n");
    let last_vite = lines.iter().rposition(|l| l.starts_with("VITE_"));
    let content_lines = lines.len() - usize::from(text.ends_with('\n'));
    let at = last_vite.map_or(content_lines, |i| i + 1) as u32;
    let at_end = at as usize >= content_lines;
    let new_text = format!("{}{value}\n", if last_vite.is_none() || at_end { "\n" } else { "" });
    let title = match keys.as_slice() {
        [one] => format!("Create Vite env variable from \"{one}\""),
        _ => "Create Vite env variables from selection".into(),
    };
    let line_no = at + 1 + u32::from(new_text.starts_with('\n'));
    let edit = crate::features::actions::file_edit(ctx, vec![TextEdit { range: Range { start: Position::new(at, 0), end: Position::new(at, 0) }, new_text }])?;
    Some(CodeAction { title, kind: Some(CodeActionKind::QUICKFIX), edit: Some(edit), command: Some(open(&ctx.doc.path, line_no)), ..Default::default() })
}
