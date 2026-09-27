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
        PrepareRenameRequest::METHOD => typed!(PrepareRenameRequest, rename::prepare),
        Rename::METHOD => typed!(Rename, rename::rename),
        WillRenameFiles::METHOD => typed!(WillRenameFiles, moves::will_rename),
        CodeActionRequest::METHOD => typed!(CodeActionRequest, actions::code_actions),
        CodeActionResolveRequest::METHOD => typed!(CodeActionResolveRequest, actions::resolve),
        ExecuteCommand::METHOD => typed!(ExecuteCommand, actions::execute_command),
        "tusk/memberReferences" => custom::member_references,
        "tusk/projectProblems" => custom::project_problems,
        _ => return None,
    };
    Some(handler)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::testing::{Fixture, uri};

    /// Every request, and every code action resolved, with the file cut off at each point typing passes through.
    /// Unfinished files parse with their open brackets closed, so the tree's spans run past the document's end.
    #[test]
    fn no_request_panics_on_unfinished_files() {
        let code = "<?php\nnamespace App;\n\nuse Foo\\Bar;\n\ninterface I { function f(int $a): string; }\n\nclass A extends B implements I {\n    public function __construct(int $x, private ?Bar $bar = null) {}\n    public function f(int $a): string { return $this->bar?->name($a, [1, 2]) . \"x{$a}\"; }\n}\n";
        let doc = json!({ "uri": uri("test.php") });
        for cut in (0..=code.len()).filter(|&i| code.is_char_boundary(i)) {
            let text = &code[..cut];
            let fx = Fixture::one(text);
            let end = fx.doc("test.php").position(cut as u32);
            let at = json!({ "textDocument": doc, "position": end });
            let whole = json!({ "start": { "line": 0, "character": 0 }, "end": end });
            let run = |method: &str, params: Value| {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| super::find(method).unwrap()(&fx.snap, params)));
                result.unwrap_or_else(|_| panic!("{method} panicked with the file cut at {cut}: {text:?}")).ok()
            };
            for method in ["textDocument/hover", "textDocument/completion", "textDocument/signatureHelp", "textDocument/definition", "textDocument/documentHighlight"] {
                run(method, at.clone());
            }
            run("textDocument/documentSymbol", json!({ "textDocument": doc }));
            run("textDocument/foldingRange", json!({ "textDocument": doc }));
            run("textDocument/inlayHint", json!({ "textDocument": doc, "range": whole }));
            for range in [json!({ "start": end, "end": end }), whole] {
                let actions = run("textDocument/codeAction", json!({ "textDocument": doc, "range": range, "context": { "diagnostics": [] } }));
                for action in actions.and_then(|a| a.as_array().cloned()).unwrap_or_default() {
                    run("codeAction/resolve", action);
                }
            }
        }
    }
}
