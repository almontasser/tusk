//! Document symbols (the outline) and workspace symbols (Go to Class and Go to Symbol).

use lsp_types::{
    DocumentSymbol, DocumentSymbolParams, DocumentSymbolResponse, Location, OneOf, SymbolKind, WorkspaceSymbol,
    WorkspaceSymbolParams, WorkspaceSymbolResponse,
};
use mago_span::{HasSpan, Span};
use mago_syntax::cst::*;

use super::{Ctx, with_ctx};
use crate::locate::Place;
use crate::server::Snapshot;

pub fn document_symbols(snap: &Snapshot, params: DocumentSymbolParams) -> Result<Option<DocumentSymbolResponse>, String> {
    Ok(with_ctx(snap, &params.text_document.uri, |ctx| {
        let mut out = vec![];
        statements(ctx, ctx.parsed.program.statements.iter(), &mut out);
        DocumentSymbolResponse::Nested(out)
    }))
}

fn text(ctx: &Ctx<'_>, span: Span) -> String {
    let t = ctx.parsed.text();
    t[span.start.offset as usize..(span.end.offset as usize).min(t.len())].split_whitespace().collect::<Vec<_>>().join(" ")
}

#[allow(deprecated)]
fn symbol(ctx: &Ctx<'_>, name: &str, kind: SymbolKind, whole: Span, name_span: Span, detail: Option<String>, children: Vec<DocumentSymbol>) -> DocumentSymbol {
    DocumentSymbol {
        name: name.to_string(),
        detail,
        kind,
        tags: None,
        deprecated: None,
        range: ctx.doc.range(whole.start.offset, whole.end.offset),
        selection_range: ctx.doc.range(name_span.start.offset, name_span.end.offset),
        children: Some(children),
    }
}

/// `(int $a): string` for a function-like.
fn detail(ctx: &Ctx<'_>, params: &FunctionLikeParameterList<'_>, ret: Option<&FunctionLikeReturnTypeHint<'_>>) -> String {
    let end = ret.map_or(params.span().end, |r| r.span().end);
    super::hover::signature(&text(ctx, Span::new(params.span().file_id, params.span().start, end)))
}

/// Declarations among `statements`, descending into namespaces and blocks (such as `if (!function_exists())`).
fn statements<'s, 'a: 's>(ctx: &Ctx<'_>, statements: impl Iterator<Item = &'s Statement<'a>>, out: &mut Vec<DocumentSymbol>) {
    for statement in statements {
        match statement {
            Statement::Namespace(ns) => match &ns.body {
                NamespaceBody::BraceDelimited(block) => self::statements(ctx, block.statements.iter(), out),
                NamespaceBody::Implicit(body) => self::statements(ctx, body.statements.iter(), out),
            },
            Statement::Block(block) => self::statements(ctx, block.statements.iter(), out),
            Statement::If(_) => {
                // Conditional declarations: walk the branches' statements.
                let mut nested = vec![];
                Node::Statement(statement).visit_children(|c| collect_nested(c, &mut nested));
                self::statements(ctx, nested.into_iter(), out);
            }
            Statement::Class(c) => out.push(class_like(ctx, c.span(), &c.name, SymbolKind::CLASS, c.members.iter())),
            Statement::Interface(c) => out.push(class_like(ctx, c.span(), &c.name, SymbolKind::INTERFACE, c.members.iter())),
            // Phpactor reports traits as structs, and the editor's Safe Delete looks for that kind.
            Statement::Trait(c) => out.push(class_like(ctx, c.span(), &c.name, SymbolKind::STRUCT, c.members.iter())),
            Statement::Enum(c) => out.push(class_like(ctx, c.span(), &c.name, SymbolKind::ENUM, c.members.iter())),
            Statement::Function(f) => {
                let d = detail(ctx, &f.parameter_list, f.return_type_hint.as_ref());
                let name = String::from_utf8_lossy(f.name.value);
                out.push(symbol(ctx, &name, SymbolKind::FUNCTION, f.span(), f.name.span, Some(d), vec![]));
            }
            Statement::Constant(c) => {
                for item in c.items.iter() {
                    let name = String::from_utf8_lossy(item.name.value);
                    out.push(symbol(ctx, &name, SymbolKind::CONSTANT, c.span(), item.name.span, None, vec![]));
                }
            }
            _ => {}
        }
    }
}

/// The statements directly inside an `if`'s branches.
fn collect_nested<'a>(node: Node<'a, 'a>, out: &mut Vec<&'a Statement<'a>>) {
    match node {
        Node::Statement(s) => out.push(s),
        Node::Expression(_) => {}
        other => other.visit_children(|c| collect_nested(c, out)),
    }
}

fn class_like<'s, 'a: 's>(
    ctx: &Ctx<'_>,
    whole: Span,
    name: &LocalIdentifier<'_>,
    kind: SymbolKind,
    members: impl Iterator<Item = &'s ClassLikeMember<'a>>,
) -> DocumentSymbol {
    let mut children = vec![];
    for member in members {
        match member {
            ClassLikeMember::Method(m) => {
                let method = String::from_utf8_lossy(m.name.value);
                let kind = if method.eq_ignore_ascii_case("__construct") { SymbolKind::CONSTRUCTOR } else { SymbolKind::METHOD };
                // Promoted constructor parameters are properties too, listed before the constructor.
                for p in m.parameter_list.parameters.iter().filter(|p| !p.modifiers.is_empty()) {
                    let var = &p.variable;
                    let prop = String::from_utf8_lossy(&var.name[1..]);
                    children.push(symbol(ctx, &prop, SymbolKind::PROPERTY, p.span(), var.span, None, vec![]));
                }
                let d = detail(ctx, &m.parameter_list, m.return_type_hint.as_ref());
                children.push(symbol(ctx, &method, kind, m.span(), m.name.span, Some(d), vec![]));
            }
            ClassLikeMember::Property(p) => {
                for var in p.variables() {
                    let prop = String::from_utf8_lossy(&var.name[1..]);
                    children.push(symbol(ctx, &prop, SymbolKind::PROPERTY, p.span(), var.span, None, vec![]));
                }
            }
            ClassLikeMember::Constant(c) => {
                for item in c.items.iter() {
                    let constant = String::from_utf8_lossy(item.name.value);
                    children.push(symbol(ctx, &constant, SymbolKind::CONSTANT, c.span(), item.name.span, None, vec![]));
                }
            }
            ClassLikeMember::EnumCase(c) => {
                let n = c.item.name();
                let case = String::from_utf8_lossy(n.value);
                children.push(symbol(ctx, &case, SymbolKind::ENUM_MEMBER, c.span(), n.span, None, vec![]));
            }
            ClassLikeMember::TraitUse(_) => {}
        }
    }
    let class = String::from_utf8_lossy(name.value);
    symbol(ctx, &class, kind, whole, name.span, None, children)
}

/// How well `name` matches `query` (both lowercase): lower is better, `None` for no match.
fn rank(name: &str, query: &str) -> Option<u8> {
    if query.is_empty() {
        return Some(3);
    }
    if name == query {
        return Some(0);
    }
    if name.starts_with(query) {
        return Some(1);
    }
    if name.contains(query) {
        return Some(2);
    }
    let mut chars = name.chars();
    query.chars().all(|q| chars.any(|c| c == q)).then_some(3)
}

const LIMIT: usize = 200;

/// Classes, interfaces, traits, enums, functions, and constants whose short name matches the query, or whose
/// qualified name does when the query has a `\`. The namespace goes in `containerName`, as Phpactor gives it.
pub fn workspace_symbols(snap: &Snapshot, params: WorkspaceSymbolParams) -> Result<Option<WorkspaceSymbolResponse>, String> {
    let query = params.query.to_ascii_lowercase();
    let qualified = query.contains('\\');
    let query = query.trim_start_matches('\\').to_string();
    let index = snap.index.read();

    // (rank, vendor, name, fqn, kind, place)
    let mut hits: Vec<(u8, bool, String, String, SymbolKind, Place)> = vec![];
    let mut consider = |fqn: String, kind: SymbolKind, span: Span| {
        if index.path_of(span.file_id).is_none() {
            return;
        }
        let library = !index.is_project_file(span.file_id);
        let short = fqn.rsplit('\\').next().unwrap_or(&fqn).to_string();
        let target = if qualified { fqn.to_ascii_lowercase() } else { short.to_ascii_lowercase() };
        if let Some(r) = rank(&target, &query) {
            hits.push((r, library, short, fqn, kind, span.into()));
        }
    };
    // Every name the project and its libraries declare, loaded or not. PHP's built-ins have no file to go to.
    for (d, origin) in index.names() {
        if origin == crate::index::Origin::BuiltIn {
            continue;
        }
        let fqn = d.name.as_str_lossy().into_owned();
        // Anonymous classes have generated names.
        if fqn.contains(['@', ':', '{', '/']) {
            continue;
        }
        let kind = match d.kind {
            crate::index::DeclKind::Class(mago_codex::symbol::SymbolKind::Interface) => SymbolKind::INTERFACE,
            crate::index::DeclKind::Class(mago_codex::symbol::SymbolKind::Trait) => SymbolKind::STRUCT,
            crate::index::DeclKind::Class(mago_codex::symbol::SymbolKind::Enum) => SymbolKind::ENUM,
            crate::index::DeclKind::Class(_) => SymbolKind::CLASS,
            crate::index::DeclKind::Function => SymbolKind::FUNCTION,
            crate::index::DeclKind::Constant => SymbolKind::CONSTANT,
        };
        consider(fqn, kind, d.span);
    }
    hits.sort_by(|a, b| (a.0, a.1, a.2.len(), &a.3).cmp(&(b.0, b.1, b.2.len(), &b.3)));
    hits.truncate(LIMIT);

    // Each file is read once for its line breaks.
    let mut files: std::collections::HashMap<mago_database::file::FileId, (String, crate::text::LineIndex)> = Default::default();
    let mut out = vec![];
    for (_, _, short, fqn, kind, place) in hits {
        let Some(path) = index.path_of(place.file) else { continue };
        if !files.contains_key(&place.file) {
            let Some(text) = snap.read(path) else { continue };
            let lines = crate::text::LineIndex::new(&text);
            files.insert(place.file, (text, lines));
        }
        let (text, lines) = &files[&place.file];
        let container = fqn.rsplit_once('\\').map(|(ns, _)| ns.to_string());
        out.push(WorkspaceSymbol {
            name: short,
            kind,
            tags: None,
            container_name: container,
            location: OneOf::Left(Location { uri: crate::text::path_to_uri(path), range: lines.range(text, place.start, place.end) }),
            data: None,
        });
    }
    Ok(Some(WorkspaceSymbolResponse::Nested(out)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Fixture, uri};
    use lsp_types::TextDocumentIdentifier;

    fn outline(text: &str) -> Vec<String> {
        let fx = Fixture::one(text);
        let params = DocumentSymbolParams {
            text_document: TextDocumentIdentifier { uri: uri("test.php") },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        };
        let Some(DocumentSymbolResponse::Nested(symbols)) = document_symbols(&fx.snap, params).unwrap() else { panic!() };
        fn flatten(s: &[DocumentSymbol], depth: usize, out: &mut Vec<String>) {
            for s in s {
                let detail = s.detail.as_deref().map(|d| format!(" {d}")).unwrap_or_default();
                out.push(format!("{}{:?} {}{detail} @{}", "  ".repeat(depth), s.kind, s.name, s.selection_range.start.line));
                flatten(s.children.as_deref().unwrap_or(&[]), depth + 1, out);
            }
        }
        let mut out = vec![];
        flatten(&symbols, 0, &mut out);
        out
    }

    #[test]
    fn outlines_declarations_with_members() {
        let text = "<?php\nnamespace App;\nconst LIMIT = 1;\n#[Attr]\nfinal class User {\n    const ROLE = 'a';\n    public int $id, $age;\n    public function __construct(private string $name, int $plain) {}\n    public function greet(int $times = 1): string { return ''; }\n}\ninterface Named {}\ntrait Greets { function hi() {} }\nenum Status: string { case Active = 'a'; }\nif (!function_exists('helper')) {\n    function helper(\n        array $a\n    ): void {}\n}\n";
        assert_eq!(
            outline(text),
            vec![
                "Constant LIMIT @2",
                "Class User @4",
                "  Constant ROLE @5",
                "  Property id @6",
                "  Property age @6",
                "  Property name @7",
                "  Constructor __construct (private string $name, int $plain) @7",
                "  Method greet (int $times = 1): string @8",
                "Interface Named @10",
                "Struct Greets @11",
                "  Method hi () @11",
                "Enum Status @12",
                "  EnumMember Active @12",
                "Function helper (array $a): void @14",
            ]
        );
    }

    fn search(fx: &Fixture, query: &str) -> Vec<(String, Option<String>)> {
        let params = WorkspaceSymbolParams { query: query.into(), work_done_progress_params: Default::default(), partial_result_params: Default::default() };
        let Some(WorkspaceSymbolResponse::Nested(found)) = workspace_symbols(&fx.snap, params).unwrap() else { panic!() };
        found.into_iter().map(|s| (s.name, s.container_name)).collect()
    }

    #[test]
    fn ranks_workspace_symbols_and_names_their_namespace() {
        let fx = Fixture::new(&[
            ("app/a.php", "<?php namespace App\\Models; class UserProfile {} class User {} trait Uses {} function user_name() {} const USER_MAX = 1;"),
            ("vendor/x/b.php", "<?php namespace Lib; class User {}"),
        ]);
        let found = search(&fx, "user");
        // Exact matches first, project files before vendor, then prefixes, then subsequences.
        assert_eq!(found[0], ("User".into(), Some("App\\Models".into())));
        assert_eq!(found[1], ("User".into(), Some("Lib".into())));
        assert!(found.iter().any(|f| f.0 == "user_name"));
        assert!(found.iter().any(|f| f.0 == "UserProfile"));
        assert!(found.iter().any(|f| f.0 == "USER_MAX"));
        assert_eq!(search(&fx, "usrpr"), vec![("UserProfile".into(), Some("App\\Models".into()))]);
        assert_eq!(search(&fx, "lib\\user"), vec![("User".into(), Some("Lib".into()))]);
        // PHP's built-ins have no file.
        assert!(search(&fx, "ArrayObject").is_empty());
    }
}
