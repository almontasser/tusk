use lsp_types::{Range, WorkspaceEdit};
use serde_json::Value;

use super::Candidate;
use crate::features::Ctx;

pub fn candidates(_ctx: &Ctx<'_>, _range: Range) -> Vec<Candidate> {
    vec![]
}

pub fn resolve(_ctx: &Ctx<'_>, _action: &str, _range: Range, _arg: &Value) -> Option<WorkspaceEdit> {
    None
}
