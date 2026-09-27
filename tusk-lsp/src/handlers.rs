//! Request handlers by method. Each takes a snapshot and the raw params and returns the raw result.

use serde_json::Value;

use crate::server::Snapshot;

pub type Handler = fn(&Snapshot, Value) -> Result<Value, String>;

/// Wraps a typed handler as a [`Handler`].
macro_rules! typed {
    ($req:ty, $f:path) => {
        |snap: &Snapshot, params: Value| -> Result<Value, String> {
            let params: <$req as lsp_types::request::Request>::Params = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let result: <$req as lsp_types::request::Request>::Result = $f(snap, params)?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
    };
}

pub fn find(method: &str) -> Option<Handler> {
    use crate::features::*;
    use lsp_types::request::*;
    let handler: Handler = match method {
        GotoDefinition::METHOD => typed!(GotoDefinition, navigation::definition),
        GotoDeclaration::METHOD => typed!(GotoDeclaration, navigation::declaration_request),
        GotoTypeDefinition::METHOD => typed!(GotoTypeDefinition, navigation::type_definition),
        GotoImplementation::METHOD => typed!(GotoImplementation, navigation::implementation),
        References::METHOD => typed!(References, references::references),
        DocumentHighlightRequest::METHOD => typed!(DocumentHighlightRequest, references::highlight),
        HoverRequest::METHOD => typed!(HoverRequest, hover::hover),
        SignatureHelpRequest::METHOD => typed!(SignatureHelpRequest, signature::signature_help),
        Completion::METHOD => typed!(Completion, completion::completion),
        ResolveCompletionItem::METHOD => typed!(ResolveCompletionItem, completion::resolve),
        DocumentSymbolRequest::METHOD => typed!(DocumentSymbolRequest, symbols::document_symbols),
        WorkspaceSymbolRequest::METHOD => typed!(WorkspaceSymbolRequest, symbols::workspace_symbols),
        FoldingRangeRequest::METHOD => typed!(FoldingRangeRequest, folding::folding_ranges),
        SelectionRangeRequest::METHOD => typed!(SelectionRangeRequest, folding::selection_ranges),
        InlayHintRequest::METHOD => typed!(InlayHintRequest, inlay::inlay_hints),
        CodeLensRequest::METHOD => typed!(CodeLensRequest, links::code_lenses),
        DocumentLinkRequest::METHOD => typed!(DocumentLinkRequest, links::document_links),
        _ => return None,
    };
    Some(handler)
}
