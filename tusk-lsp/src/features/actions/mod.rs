//! Code actions and commands. Listing actions is cheap, since the editor asks on every cursor move: each
//! action carries what it needs in `data`, and its edit is computed by `codeAction/resolve`.

pub mod extract;
pub mod fixes;
pub mod generate;
pub mod inline;
pub mod introduce;
pub mod mago;
pub mod organize;

use lsp_types::{
    CodeAction, CodeActionKind, CodeActionOrCommand, CodeActionParams, CodeActionResponse, ExecuteCommandParams, Range,
    Uri, WorkspaceEdit,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Ctx, with_ctx};
use crate::server::Snapshot;

/// An action before its edit is computed.
pub struct Candidate {
    pub title: String,
    pub kind: CodeActionKind,
    /// Which module and action computes the edit, such as `generate.implement`.
    pub id: &'static str,
    /// Anything the action needs beyond the document and range.
    pub arg: Value,
    pub preferred: bool,
    /// A command to run instead of resolving an edit, for editors that expect one.
    pub command: Option<lsp_types::Command>,
}

impl Candidate {
    pub fn new(title: impl Into<String>, kind: &str, id: &'static str, arg: Value) -> Self {
        Self { title: title.into(), kind: CodeActionKind::from(kind.to_string()), id, arg, preferred: false, command: None }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct Data {
    uri: Uri,
    range: Range,
    id: String,
    arg: Value,
}

/// Whether an action of `kind` was asked for.
fn wanted(only: &Option<Vec<CodeActionKind>>, kind: &CodeActionKind) -> bool {
    match only {
        None => true,
        Some(kinds) => kinds.iter().any(|k| kind.as_str() == k.as_str() || kind.as_str().starts_with(&format!("{}.", k.as_str()))),
    }
}

pub fn code_actions(snap: &Snapshot, params: CodeActionParams) -> Result<Option<CodeActionResponse>, String> {
    let uri = params.text_document.uri.clone();
    let range = params.range;
    let only = params.context.only.clone();
    let fix_all = only.is_some() && wanted(&only, &CodeActionKind::from(mago::FIX_ALL.to_string()));
    let (candidates, complete) = with_ctx(snap, &uri, |ctx| {
        let mut complete = crate::framework::laravel::actions::code_actions(ctx, range);
        complete.extend(crate::framework::filament::code_actions(ctx, range));
        if fix_all || wanted(&only, &CodeActionKind::QUICKFIX) {
            complete.extend(mago::code_actions(ctx, &params, fix_all));
        }
        let mut out = vec![];
        out.extend(fixes::candidates(ctx, range));
        out.extend(generate::candidates(ctx, range));
        out.extend(organize::candidates(ctx, range));
        out.extend(extract::candidates(ctx, range));
        out.extend(introduce::candidates(ctx, range));
        out.extend(inline::candidates(ctx, range));
        // Laravel's and Mago's fixes come with their edits: they're only offered on a problem, so they're few.
        (out, complete)
    })
    .unwrap_or_default();
    // A Blade view's PHP: importing a class it names, when the cursor is at a name.
    let mut candidates = candidates;
    let name = |b: &u8| b.is_ascii_alphanumeric() || *b == b'_';
    let at_name = |d: &crate::documents::Document, at: usize| d.text.as_bytes().get(at).is_some_and(name) || at.checked_sub(1).and_then(|a| d.text.as_bytes().get(a)).is_some_and(name);
    if let Some(offset) = snap.doc(&uri).filter(|d| super::is_blade(d) && at_name(d, d.offset(range.start) as usize)).map(|d| d.offset(range.start)) {
        candidates.extend(super::with_blade_php(snap, &uri, offset, false, |ctx, blade| fixes::blade_candidates(ctx, blade, offset)).unwrap_or_default());
    }
    let complete = complete.into_iter().filter(|a| a.kind.as_ref().is_some_and(|k| wanted(&only, k))).map(CodeActionOrCommand::CodeAction);
    let actions: Vec<CodeActionOrCommand> = candidates
        .into_iter()
        .filter(|c| wanted(&only, &c.kind))
        .map(|c| {
            CodeActionOrCommand::CodeAction(CodeAction {
                title: c.title,
                kind: Some(c.kind),
                is_preferred: c.preferred.then_some(true),
                command: c.command,
                data: serde_json::to_value(Data { uri: uri.clone(), range, id: c.id.to_string(), arg: c.arg }).ok(),
                ..Default::default()
            })
        })
        .chain(complete)
        .collect();
    Ok((!actions.is_empty()).then_some(actions))
}

/// Computes an action's edit.
pub fn resolve(snap: &Snapshot, mut action: CodeAction) -> Result<CodeAction, String> {
    let Some(data) = action.data.clone().and_then(|d| serde_json::from_value::<Data>(d).ok()) else { return Ok(action) };
    let edit = if data.id == "fixes.blade_import" {
        let offset = snap.doc(&data.uri).map(|d| d.offset(data.range.start)).unwrap_or_default();
        super::with_blade_php(snap, &data.uri, offset, false, |ctx, blade| fixes::blade_resolve(ctx, blade, offset, &data.arg)).flatten()
    } else {
        with_ctx(snap, &data.uri, |ctx| edit_for(ctx, &data.id, data.range, &data.arg)).flatten()
    };
    match edit {
        Some(edit) => action.edit = Some(edit),
        None => return Err(format!("“{}” no longer applies here.", action.title)),
    }
    Ok(action)
}

fn edit_for(ctx: &Ctx<'_>, id: &str, range: Range, arg: &Value) -> Option<WorkspaceEdit> {
    let (module, action) = id.split_once('.')?;
    match module {
        "fixes" => fixes::resolve(ctx, action, range, arg),
        "generate" => generate::resolve(ctx, action, range, arg),
        "organize" => organize::resolve(ctx, action, range, arg),
        "extract" if action == "method" => extract::resolve(ctx, action, range, arg),
        "extract" => introduce::resolve(ctx, action, range),
        "inline" => inline::resolve(ctx, range),
        _ => None,
    }
}

/// The commands the server runs, which apply their edits through the editor.
pub const COMMANDS: &[&str] = &[extract::COMMAND];

pub fn execute_command(snap: &Snapshot, params: ExecuteCommandParams) -> Result<Option<Value>, String> {
    let edit = match params.command.as_str() {
        extract::COMMAND => Some(extract::command(snap, &params.arguments)?),
        other => return Err(format!("Unknown command {other}")),
    };
    let Some(edit) = edit else { return Ok(None) };
    let applied = snap.client.as_ref().is_some_and(|c| c.apply_edit(&params.command, edit));
    if !applied {
        return Err("The editor didn't apply the edit.".into());
    }
    Ok(None)
}

/// A workspace edit of the context's document.
pub fn file_edit(ctx: &Ctx<'_>, edits: Vec<lsp_types::TextEdit>) -> Option<WorkspaceEdit> {
    if edits.is_empty() {
        return None;
    }
    let mut all = super::rename::Edits::default();
    for e in edits {
        all.add(&ctx.doc.path, e);
    }
    Some(all.into_workspace_edit(ctx.snap, vec![]))
}

/// The file's indentation unit: a tab, or the smallest run of leading spaces, else four spaces.
pub fn indent_unit(text: &str) -> String {
    let mut smallest = usize::MAX;
    for line in text.lines() {
        if line.starts_with('\t') {
            return "\t".into();
        }
        let spaces = line.len() - line.trim_start_matches(' ').len();
        if spaces > 0 && spaces < line.len() && !line.trim_start().starts_with('*') {
            smallest = smallest.min(spaces);
        }
    }
    if smallest == usize::MAX || smallest > 8 { "    ".into() } else { " ".repeat(smallest) }
}

/// The indentation of the line holding `offset`.
pub fn line_indent(text: &str, offset: usize) -> String {
    let start = text[..offset.min(text.len())].rfind('\n').map_or(0, |i| i + 1);
    text[start..].chars().take_while(|c| *c == ' ' || *c == '\t').collect()
}
