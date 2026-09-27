//! Type hierarchy and call hierarchy.
//!
//! Items carry what identifies them in `data` (a class name, or a method's class and name), so the follow-up
//! requests answer from the index rather than from positions that an edit may have moved.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use lsp_types::{
    CallHierarchyIncomingCall, CallHierarchyIncomingCallsParams, CallHierarchyItem, CallHierarchyOutgoingCall,
    CallHierarchyOutgoingCallsParams, CallHierarchyPrepareParams, Position, Range, SymbolKind, TypeHierarchyItem,
    TypeHierarchyPrepareParams, TypeHierarchySubtypesParams, TypeHierarchySupertypesParams, Uri,
};
use mago_allocator::LocalArena;
use mago_codex::metadata::CodebaseMetadata;
use mago_span::HasSpan;
use mago_syntax::cst::{Expression, Node};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::references::search;
use super::with_ctx;
use crate::analysis::Parsed;
use crate::index::Index;
use crate::locate::{Place, declaration, walk};
use crate::server::Snapshot;
use crate::symbol::{Resolver, Symbol};
use crate::text::{LineIndex, path_to_uri};
use crate::types::display_class;

/// What an item stands for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Target {
    Type { fqn: String },
    Function { fqn: String },
    Method { class: String, name: String },
    /// Code outside any function, such as a routes file.
    File,
}

fn target_of(data: &Option<Value>) -> Result<Target, String> {
    data.clone().and_then(|d| serde_json::from_value(d).ok()).ok_or_else(|| "The item has no data from Tusk's server".to_string())
}

fn short(fqn: &str) -> &str {
    fqn.rsplit('\\').next().unwrap_or(fqn)
}

fn namespace(fqn: &str) -> Option<String> {
    fqn.rsplit_once('\\').map(|(ns, _)| ns.to_string())
}

/// Anonymous classes have generated names, which no one can write.
fn is_anonymous(name: &str) -> bool {
    name.contains(['@', ':', '{', '/'])
}

/// A declaration's whole span and its name's, as a location in its file. PHP's built-ins have no file, and get
/// a `tusk://builtin/` address the editor doesn't open.
struct Where {
    uri: Uri,
    range: Range,
    selection: Range,
}

fn locate(snap: &Snapshot, index: &Index, spans: Option<(Place, Place)>, fallback: &str) -> Where {
    if let Some((whole, name)) = spans
        && let Some(path) = index.path_of(whole.file)
        && let Some(text) = snap.read(path)
    {
        let lines = LineIndex::new(&text);
        let range = lines.range(&text, whole.start, whole.end);
        let selection = lines.range(&text, name.start, name.end);
        return Where { uri: path_to_uri(path), range, selection };
    }
    let uri = format!("tusk://builtin/{}", fallback.replace('\\', "/")).parse().expect("a valid URI");
    Where { uri, range: Range::default(), selection: Range::default() }
}

// ---- Type hierarchy ----

fn type_item(snap: &Snapshot, index: &Index, fqn: &str) -> TypeHierarchyItem {
    let codebase = &index.codebase;
    let fqn = display_class(fqn, codebase);
    let meta = codebase.get_class_like(fqn.as_bytes());
    let kind = match meta.map(|m| m.kind) {
        Some(mago_codex::symbol::SymbolKind::Interface) => SymbolKind::INTERFACE,
        // As document symbols give them.
        Some(mago_codex::symbol::SymbolKind::Trait) => SymbolKind::STRUCT,
        Some(mago_codex::symbol::SymbolKind::Enum) => SymbolKind::ENUM,
        _ => SymbolKind::CLASS,
    };
    let at = locate(snap, index, meta.map(|m| (m.span.into(), m.name_span.unwrap_or(m.span).into())), &fqn);
    TypeHierarchyItem {
        name: short(&fqn).to_string(),
        kind,
        tags: None,
        detail: namespace(&fqn),
        uri: at.uri,
        range: at.range,
        selection_range: at.selection,
        data: serde_json::to_value(Target::Type { fqn }).ok(),
    }
}

/// The type named under the cursor, else the one the cursor is in.
pub fn prepare_type_hierarchy(snap: &Snapshot, params: TypeHierarchyPrepareParams) -> Result<Option<Vec<TypeHierarchyItem>>, String> {
    let at = params.text_document_position_params;
    let fqn = with_ctx(snap, &at.text_document.uri, |ctx| {
        let offset = ctx.offset(at.position);
        if let Some(found) = ctx.symbol_at(at.position)
            && let Some(Symbol::Class(fqn)) = found.symbols.first()
            && ctx.index.codebase.get_class_like(fqn.as_bytes()).is_some()
        {
            return Some(fqn.clone());
        }
        ctx.resolver().enclosing_class(&ctx.parsed.path_at(offset)).filter(|c| !is_anonymous(c))
    })
    .flatten();
    let Some(fqn) = fqn else { return Ok(None) };
    let index = snap.index.read();
    Ok(Some(vec![type_item(snap, &index, &fqn)]))
}

/// Its parent class, then its interfaces, then its traits.
pub fn supertypes(snap: &Snapshot, params: TypeHierarchySupertypesParams) -> Result<Option<Vec<TypeHierarchyItem>>, String> {
    let Target::Type { fqn } = target_of(&params.item.data)? else { return Ok(None) };
    let index = snap.index.read();
    let Some(meta) = index.codebase.get_class_like(fqn.as_bytes()) else { return Ok(Some(vec![])) };
    let sorted = |set: &mago_word::WordSet| {
        let mut names: Vec<String> = set.iter().map(|w| display_class(&w.as_str_lossy(), &index.codebase)).collect();
        names.sort_by_key(|n| n.to_ascii_lowercase());
        names
    };
    let names = meta
        .direct_parent_class
        .iter()
        .map(|p| p.as_str_lossy().into_owned())
        .chain(sorted(&meta.direct_parent_interfaces))
        .chain(sorted(&meta.used_traits));
    Ok(Some(names.map(|n| type_item(snap, &index, &n)).collect()))
}

/// The types that name it directly as their parent, an interface, or a trait they use.
pub fn subtypes(snap: &Snapshot, params: TypeHierarchySubtypesParams) -> Result<Option<Vec<TypeHierarchyItem>>, String> {
    let Target::Type { fqn } = target_of(&params.item.data)? else { return Ok(None) };
    let index = snap.index.read();
    let mut names = direct_subtypes(&index.codebase, &fqn);
    names.retain(|n| !is_anonymous(n));
    Ok(Some(names.iter().map(|n| type_item(snap, &index, n)).collect()))
}

fn direct_subtypes(codebase: &CodebaseMetadata, fqn: &str) -> Vec<String> {
    let lower = fqn.to_ascii_lowercase();
    let mut names: Vec<String> = match codebase.get_class_like(fqn.as_bytes()) {
        // Traits aren't parents, so their users are found by what each class uses. A class's traits include its
        // parent's, which don't count as using it directly.
        Some(meta) if meta.kind == mago_codex::symbol::SymbolKind::Trait => {
            let uses = |c: &mago_codex::metadata::class_like::ClassLikeMetadata| {
                c.used_traits.iter().any(|t| t.as_str_lossy().eq_ignore_ascii_case(&lower))
            };
            codebase
                .class_likes
                .values()
                .filter(|c| uses(c) && !c.direct_parent_class.and_then(|p| codebase.get_class_like(p.as_bytes())).is_some_and(uses))
                .map(|c| c.original_name.as_str_lossy().into_owned())
                .collect()
        }
        _ => codebase
            .direct_classlike_descendants
            .iter()
            .find(|(k, _)| k.as_str_lossy().eq_ignore_ascii_case(&lower))
            .map(|(_, children)| children.iter().map(|c| display_class(&c.as_str_lossy(), codebase)).collect())
            .unwrap_or_default(),
    };
    names.sort_by_key(|n| n.to_ascii_lowercase());
    names.dedup();
    names
}

// ---- Call hierarchy ----

fn call_item(snap: &Snapshot, index: &Index, target: &Target) -> Option<CallHierarchyItem> {
    let codebase = &index.codebase;
    let (name, detail, meta) = match target {
        Target::Function { fqn } => {
            let f = codebase.get_function(fqn.as_bytes())?;
            let fqn = f.original_name.as_str_lossy().into_owned();
            (short(&fqn).to_string(), namespace(&fqn), f)
        }
        Target::Method { class, name } => {
            let m = codebase.get_declaring_method(class.as_bytes(), name.as_bytes())?;
            let class = display_class(class, codebase);
            let name = m.original_name.as_str_lossy().into_owned();
            (format!("{}::{name}", short(&class)), Some(class), m)
        }
        _ => return None,
    };
    // Built-ins have nowhere to go.
    index.path_of(meta.span.file_id)?;
    let at = locate(snap, index, Some((meta.span.into(), meta.name_span.unwrap_or(meta.span).into())), &name);
    Some(CallHierarchyItem {
        name,
        kind: if matches!(target, Target::Method { .. }) { SymbolKind::METHOD } else { SymbolKind::FUNCTION },
        tags: None,
        detail,
        uri: at.uri,
        range: at.range,
        selection_range: at.selection,
        data: serde_json::to_value(target).ok(),
    })
}

/// A method identified by the class that declares it, so calls through subclasses are the same target.
fn method_target(codebase: &CodebaseMetadata, class: &str, name: &str) -> Option<Target> {
    let m = codebase.get_declaring_method(class.as_bytes(), name.as_bytes())?;
    let class = codebase.get_declaring_method_class(class.as_bytes(), name.as_bytes()).map_or_else(|| class.to_string(), |c| c.as_str_lossy().into_owned());
    let name = m.original_name.as_str_lossy().into_owned();
    Some(Target::Method { class: display_class(&class, codebase), name })
}

fn symbol_target(codebase: &CodebaseMetadata, symbol: &Symbol) -> Option<Target> {
    match symbol {
        Symbol::Method { class, name } => method_target(codebase, class, name),
        Symbol::Function(fqn) => codebase.get_function(fqn.as_bytes()).map(|_| Target::Function { fqn: fqn.clone() }),
        _ => None,
    }
}

/// The function or method around `offset`: the innermost named one, so a closure counts as the function it's in.
fn enclosing_function(parsed: &Parsed<'_>, resolver: &Resolver<'_, '_>, offset: u32) -> Option<Target> {
    let path = parsed.path_at(offset);
    for (i, node) in path.iter().enumerate().rev() {
        match node {
            Node::Method(m) => {
                let class = resolver.enclosing_class(&path[..i])?;
                return method_target(resolver.codebase, &class, &String::from_utf8_lossy(m.name.value));
            }
            Node::Function(f) => {
                let fqn = parsed.names.resolve(&f.name.span).map(|n| String::from_utf8_lossy(n).into_owned())?;
                return Some(Target::Function { fqn });
            }
            _ => {}
        }
    }
    None
}

/// The method or function called under the cursor, else the one the cursor is in.
pub fn prepare_call_hierarchy(snap: &Snapshot, params: CallHierarchyPrepareParams) -> Result<Option<Vec<CallHierarchyItem>>, String> {
    let at = params.text_document_position_params;
    let target = with_ctx(snap, &at.text_document.uri, |ctx| {
        let codebase = &ctx.index.codebase;
        if let Some(found) = ctx.symbol_at(at.position) {
            if let Some(t) = found.symbols.iter().find_map(|s| symbol_target(codebase, s)) {
                return Some(t);
            }
            // `new Foo` is a call of its constructor.
            if let Some(Symbol::Class(class)) = found.symbols.first()
                && is_instantiated(&ctx.parsed, found.start)
            {
                return method_target(codebase, class, "__construct");
            }
        }
        enclosing_function(&ctx.parsed, &ctx.resolver(), ctx.offset(at.position))
    })
    .flatten();
    let Some(target) = target else { return Ok(None) };
    let index = snap.index.read();
    Ok(call_item(snap, &index, &target).map(|item| vec![item]))
}

/// Whether the name at `offset` is the class of a `new` expression.
fn is_instantiated(parsed: &Parsed<'_>, offset: u32) -> bool {
    parsed.path_at(offset).iter().rev().any(|n| matches!(n, Node::Instantiation(new) if new.class.span().start.offset <= offset && offset <= new.class.span().end.offset))
}

/// The classes whose `new` runs `class`'s constructor: it, and its descendants that don't declare their own.
fn constructed_by(codebase: &CodebaseMetadata, class: &str) -> Vec<String> {
    let mut out = vec![display_class(class, codebase)];
    for child in super::navigation::descendants(codebase, class) {
        let declaring = codebase.get_declaring_method_class(child.as_bytes(), b"__construct");
        if declaring.is_some_and(|d| d.as_str_lossy().eq_ignore_ascii_case(class)) {
            out.push(child);
        }
    }
    out
}

/// Every call of a method or function in the project, without its declaration, by file.
fn calls_of(snap: &Snapshot, index: &Index, target: &Target) -> Vec<(PathBuf, String, Vec<(u32, u32)>)> {
    let (symbols, constructor) = match target {
        Target::Function { fqn } => (vec![Symbol::Function(fqn.clone())], vec![]),
        Target::Method { class, name } if name.eq_ignore_ascii_case("__construct") => {
            let classes = constructed_by(&index.codebase, class);
            (vec![Symbol::Method { class: class.clone(), name: name.clone() }], classes)
        }
        Target::Method { class, name } => (vec![Symbol::Method { class: class.clone(), name: name.clone() }], vec![]),
        _ => return vec![],
    };
    let declarations: Vec<Place> = symbols.iter().filter_map(|s| declaration(s, &index.codebase)).collect();
    let is_declaration = |path: &Path, (s, e): (u32, u32)| {
        declarations.iter().any(|d| index.path_of(d.file) == Some(path) && d.start <= s && e <= d.end)
    };
    let mut by_file: BTreeMap<PathBuf, (String, Vec<(u32, u32)>)> = BTreeMap::new();
    for (path, text, spans) in search(snap, index, &symbols) {
        let spans: Vec<_> = spans.into_iter().filter(|&span| !is_declaration(&path, span)).collect();
        if !spans.is_empty() {
            by_file.entry(path).or_insert_with(|| (text, vec![])).1.extend(spans);
        }
    }
    // `new Foo` names the class, not its constructor.
    for class in &constructor {
        for (path, text, spans) in search(snap, index, &[Symbol::Class(class.clone())]) {
            let arena = LocalArena::new();
            let parsed = Parsed::new(&arena, &path, &text);
            let spans: Vec<_> = spans.into_iter().filter(|&(s, _)| is_instantiated(&parsed, s)).collect();
            drop(parsed);
            if !spans.is_empty() {
                by_file.entry(path).or_insert_with(|| (text, vec![])).1.extend(spans);
            }
        }
    }
    // `new self`, `new static`, and `new parent` name no class, so the files declaring the classes are read too.
    if !constructor.is_empty()
        && let Target::Method { class, .. } = target
    {
        let codebase = &index.codebase;
        let mut files: Vec<PathBuf> = std::iter::once(class.clone())
            .chain(super::navigation::descendants(codebase, class))
            .filter_map(|c| declaration(&Symbol::Class(c), codebase))
            .filter_map(|d| index.path_of(d.file).map(Path::to_path_buf))
            .collect();
        files.sort();
        files.dedup();
        let classes: Vec<String> = constructor.iter().map(|c| c.to_ascii_lowercase()).collect();
        for path in files {
            let Some(text) = snap.read(&path) else { continue };
            let arena = LocalArena::new();
            let parsed = Parsed::new(&arena, &path, &text);
            let resolver = Resolver::new(&parsed, None, codebase);
            let mut spans = vec![];
            walk(&parsed, |node, ancestors| {
                let Node::Instantiation(new) = node else { return };
                if !matches!(new.class, Expression::Self_(_) | Expression::Static(_) | Expression::Parent(_)) {
                    return;
                }
                let runs = resolver.classes_of_class_expr(new.class, ancestors);
                if runs.first().is_some_and(|c| classes.contains(&c.to_ascii_lowercase())) {
                    spans.push((new.class.span().start.offset, new.class.span().end.offset));
                }
            });
            drop(parsed);
            if !spans.is_empty() {
                by_file.entry(path).or_insert_with(|| (text, vec![])).1.extend(spans);
            }
        }
    }
    by_file
        .into_iter()
        .map(|(path, (text, mut spans))| {
            spans.sort();
            spans.dedup();
            (path, text, spans)
        })
        .collect()
}

fn file_item(snap: &Snapshot, path: &Path, text: &str) -> CallHierarchyItem {
    let name = path.strip_prefix(&snap.root).unwrap_or(path).to_string_lossy().into_owned();
    let lines = LineIndex::new(text);
    let range = Range { start: Position::default(), end: lines.position(text, text.len() as u32) };
    CallHierarchyItem {
        name,
        kind: SymbolKind::FILE,
        tags: None,
        detail: None,
        uri: path_to_uri(path),
        range,
        selection_range: Range::default(),
        data: serde_json::to_value(Target::File).ok(),
    }
}

/// The methods and functions that call the item, each with its calls, in the order of their files.
pub fn incoming_calls(snap: &Snapshot, params: CallHierarchyIncomingCallsParams) -> Result<Option<Vec<CallHierarchyIncomingCall>>, String> {
    let target = target_of(&params.item.data)?;
    let index = snap.index.read();
    let mut out: Vec<CallHierarchyIncomingCall> = vec![];
    for (path, text, spans) in calls_of(snap, &index, &target) {
        let arena = LocalArena::new();
        let parsed = Parsed::new(&arena, &path, &text);
        let resolver = Resolver::new(&parsed, None, &index.codebase);
        let lines = LineIndex::new(&text);
        // Callers in the order of their first call in the file.
        let mut callers: Vec<(Option<Target>, Vec<Range>)> = vec![];
        for (s, e) in spans {
            let caller = enclosing_function(&parsed, &resolver, s);
            let range = lines.range(&text, s, e);
            match callers.iter_mut().find(|(c, _)| *c == caller) {
                Some((_, ranges)) => ranges.push(range),
                None => callers.push((caller, vec![range])),
            }
        }
        drop(parsed);
        for (caller, from_ranges) in callers {
            let from = match caller.and_then(|c| call_item(snap, &index, &c)) {
                Some(item) => item,
                None => file_item(snap, &path, &text),
            };
            out.push(CallHierarchyIncomingCall { from, from_ranges });
        }
        if snap.is_cancelled() {
            return Err(crate::server::CANCELLED.into());
        }
    }
    Ok(Some(out))
}

/// The methods and functions the item calls, in the order of their first call.
pub fn outgoing_calls(snap: &Snapshot, params: CallHierarchyOutgoingCallsParams) -> Result<Option<Vec<CallHierarchyOutgoingCall>>, String> {
    let item = params.item;
    let target = target_of(&item.data)?;
    if target == Target::File {
        return Ok(Some(vec![]));
    }
    let callees = with_ctx(snap, &item.uri, |ctx| {
        let codebase = &ctx.index.codebase;
        let (start, end) = (ctx.offset(item.range.start), ctx.offset(item.range.end));
        let resolver = ctx.resolver();
        let mut callees: Vec<(Target, Vec<Range>)> = vec![];
        walk(&ctx.parsed, |node, path| {
            let span = node.span();
            if span.start.offset < start || span.end.offset > end {
                return;
            }
            let (name, callee) = match node {
                // `new Foo`, `new self`, `new static`, and `new parent` run a constructor.
                Node::Instantiation(new) => {
                    let classes = resolver.classes_of_class_expr(new.class, path);
                    (new.class.span(), classes.first().and_then(|c| method_target(codebase, c, "__construct")))
                }
                _ => {
                    let name = match node {
                        Node::FunctionCall(call) => match call.function {
                            Expression::Identifier(id) => id.span(),
                            _ => return,
                        },
                        Node::MethodCall(call) => call.method.span(),
                        Node::NullSafeMethodCall(call) => call.method.span(),
                        Node::StaticMethodCall(call) => call.method.span(),
                        _ => return,
                    };
                    let Some(found) = resolver.at(name.start.offset) else { return };
                    (name, found.symbols.iter().find_map(|s| symbol_target(codebase, s)))
                }
            };
            let Some(callee) = callee else { return };
            let range = ctx.doc.range(name.start.offset, name.end.offset);
            match callees.iter_mut().find(|(c, _)| *c == callee) {
                Some((_, ranges)) => ranges.push(range),
                None => callees.push((callee, vec![range])),
            }
        });
        callees
    })
    .unwrap_or_default();
    let index = snap.index.read();
    Ok(Some(
        callees
            .into_iter()
            .filter_map(|(callee, from_ranges)| Some(CallHierarchyOutgoingCall { to: call_item(snap, &index, &callee)?, from_ranges }))
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fixture;
    use lsp_types::{PartialResultParams, WorkDoneProgressParams};

    fn prepare_type(fx: &Fixture) -> Option<TypeHierarchyItem> {
        prepare_type_hierarchy(&fx.snap, TypeHierarchyPrepareParams { text_document_position_params: fx.at(), work_done_progress_params: WorkDoneProgressParams::default() })
            .unwrap()
            .and_then(|v| v.into_iter().next())
    }

    fn names(items: Vec<TypeHierarchyItem>) -> Vec<String> {
        items.into_iter().map(|i| format!("{}\\{}", i.detail.unwrap_or_default(), i.name)).collect()
    }

    fn up(fx: &Fixture, item: TypeHierarchyItem) -> Vec<String> {
        names(supertypes(&fx.snap, TypeHierarchySupertypesParams { item, work_done_progress_params: Default::default(), partial_result_params: PartialResultParams::default() }).unwrap().unwrap())
    }

    fn down(fx: &Fixture, item: TypeHierarchyItem) -> Vec<String> {
        names(subtypes(&fx.snap, TypeHierarchySubtypesParams { item, work_done_progress_params: Default::default(), partial_result_params: PartialResultParams::default() }).unwrap().unwrap())
    }

    const TYPES: &str = "<?php\nnamespace App;\ninterface Named {}\ninterface Titled extends Named {}\ntrait Greets {}\nabstract class Base implements Named {}\nclass User extends Base implements Titled, \\Countable { use Greets; public function count(): int { return 0; } }\nclass Admin extends User {}\nclass Guest { use Greets; }\n";

    #[test]
    fn lists_supertypes_and_direct_subtypes() {
        let fx = Fixture::new(&[("app/types.php", TYPES), ("t.php", "<?php new \\App\\Us<|>er;")]);
        let user = prepare_type(&fx).unwrap();
        assert_eq!((user.name.as_str(), user.kind), ("User", SymbolKind::CLASS));
        assert!(user.uri.as_str().ends_with("types.php"));
        assert_eq!(user.selection_range.start.line, 6);
        assert_eq!(up(&fx, user.clone()), vec!["App\\Base", "App\\Titled", "\\Countable", "App\\Greets"]);
        assert_eq!(down(&fx, user), vec!["App\\Admin"]);

        let named = type_item(&fx.snap, &fx.snap.index.read(), "App\\Named");
        assert_eq!(down(&fx, named), vec!["App\\Base", "App\\Titled"]);
        let greets = type_item(&fx.snap, &fx.snap.index.read(), "App\\Greets");
        assert_eq!(greets.kind, SymbolKind::STRUCT);
        assert_eq!(down(&fx, greets), vec!["App\\Guest", "App\\User"]);
        // PHP's own interfaces have no file.
        let countable = type_item(&fx.snap, &fx.snap.index.read(), "Countable");
        assert_eq!(countable.uri.scheme().map(|s| s.as_str()), Some("tusk"));
    }

    #[test]
    fn prepares_the_type_the_cursor_is_in() {
        let fx = Fixture::one("<?php\nnamespace App;\nclass Box {\n    public function open(): void { $x = 1<|>; }\n}\n");
        assert_eq!(prepare_type(&fx).unwrap().name, "Box");
        let fx = Fixture::one("<?php\nfunction f() { return 1<|>; }\n");
        assert!(prepare_type(&fx).is_none());
    }

    fn prepare_call(fx: &Fixture) -> CallHierarchyItem {
        prepare_call_hierarchy(&fx.snap, CallHierarchyPrepareParams { text_document_position_params: fx.at(), work_done_progress_params: Default::default() })
            .unwrap()
            .unwrap()
            .remove(0)
    }

    fn incoming(fx: &Fixture, item: CallHierarchyItem) -> Vec<(String, Vec<u32>)> {
        incoming_calls(&fx.snap, CallHierarchyIncomingCallsParams { item, work_done_progress_params: Default::default(), partial_result_params: Default::default() })
            .unwrap()
            .unwrap()
            .into_iter()
            .map(|c| (c.from.name, c.from_ranges.iter().map(|r| r.start.line).collect()))
            .collect()
    }

    fn outgoing(fx: &Fixture, item: CallHierarchyItem) -> Vec<(String, Vec<u32>)> {
        outgoing_calls(&fx.snap, CallHierarchyOutgoingCallsParams { item, work_done_progress_params: Default::default(), partial_result_params: Default::default() })
            .unwrap()
            .unwrap()
            .into_iter()
            .map(|c| (c.to.name, c.from_ranges.iter().map(|r| r.start.line).collect()))
            .collect()
    }

    const CALLS: &str = "<?php\nnamespace App;\nclass Repo {\n    public function __construct() {}\n    public function save(): void { $this->log(); \\App\\helper(); }\n    private function log(): void {}\n}\nclass Cached extends Repo {}\nfunction helper(): void {}\n";

    #[test]
    fn finds_callers_by_function_and_the_files_top_level() {
        let fx = Fixture::new(&[
            ("app/Repo.php", CALLS),
            ("app/Jobs.php", "<?php\nnamespace App;\nclass Job {\n    public function run(Cached $c): void {\n        $c->save();\n        $f = fn() => $c->save();\n    }\n}\nfunction boot(Repo $r) { $r->sa<|>ve(); }\n"),
            ("routes.php", "<?php\n(new \\App\\Repo)->save();\n"),
        ]);
        let save = prepare_call(&fx);
        assert_eq!((save.name.as_str(), save.detail.as_deref()), ("Repo::save", Some("App\\Repo")));
        assert_eq!(save.selection_range.start.line, 4);
        assert_eq!(incoming(&fx, save.clone()), vec![("Job::run".into(), vec![4, 5]), ("boot".into(), vec![8]), ("routes.php".into(), vec![1])]);
        assert_eq!(outgoing(&fx, save), vec![("Repo::log".into(), vec![4]), ("helper".into(), vec![4])]);
    }

    #[test]
    fn finds_constructor_calls_through_new() {
        let fx = Fixture::new(&[
            ("app/Repo.php", CALLS),
            ("app/make.php", "<?php\nnamespace App;\nfunction make(): Repo {\n    new Cached;\n    return new Re<|>po();\n}\nclass Sub extends Repo {\n    public function __construct() { parent::__construct(); }\n    public static function copy(): static { return new parent(); }\n}\n"),
        ]);
        let ctor = prepare_call(&fx);
        assert_eq!(ctor.name, "Repo::__construct");
        assert_eq!(
            incoming(&fx, ctor),
            vec![("make".into(), vec![3, 4]), ("Sub::__construct".into(), vec![7]), ("Sub::copy".into(), vec![8])]
        );
        let make = call_item(&fx.snap, &fx.snap.index.read(), &Target::Function { fqn: "App\\make".into() }).unwrap();
        assert_eq!(outgoing(&fx, make), vec![("Repo::__construct".into(), vec![3, 4])]);
    }
}
