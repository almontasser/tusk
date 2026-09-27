//! Where symbols are declared, and turning Mago spans into LSP locations.

use lsp_types::Location;
use mago_codex::metadata::CodebaseMetadata;
use mago_database::file::FileId;
use mago_span::{HasSpan, Span};
use mago_syntax::cst::Node;

use crate::analysis::Parsed;
use crate::index::Index;
use crate::server::Snapshot;
use crate::symbol::Symbol;
use crate::text::{LineIndex, path_to_uri};

/// A span in some file of the index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Place {
    pub file: FileId,
    pub start: u32,
    pub end: u32,
}

impl From<Span> for Place {
    fn from(span: Span) -> Self {
        Place { file: span.file_id, start: span.start.offset, end: span.end.offset }
    }
}

/// Where each symbol is declared, by the name's span when known. Built-ins from PHP's stubs have no file.
pub fn declaration(symbol: &Symbol, codebase: &CodebaseMetadata) -> Option<Place> {
    match symbol {
        Symbol::Class(name) => {
            let class = codebase.get_class_like(name.as_bytes())?;
            Some(class.name_span.unwrap_or(class.span).into())
        }
        Symbol::Function(name) => {
            let f = codebase.get_function(name.as_bytes())?;
            Some(f.name_span.unwrap_or(f.span).into())
        }
        Symbol::Constant(name) => Some(codebase.get_constant(name.as_bytes())?.span.into()),
        Symbol::Method { class, name } => {
            let m = codebase.get_declaring_method(class.as_bytes(), name.as_bytes())?;
            Some(m.name_span.unwrap_or(m.span).into())
        }
        Symbol::Property { class, name } => {
            let prop = format!("${name}");
            let p = codebase
                .get_declaring_property(class.as_bytes(), prop.as_bytes())
                .or_else(|| codebase.get_property(class.as_bytes(), prop.as_bytes()))
                .or_else(|| codebase.get_declaring_magic_property(class.as_bytes(), prop.as_bytes()))?;
            p.name_span.or(p.span).map(Into::into)
        }
        Symbol::ClassConstant { class, name } => {
            if let Some(case) = codebase.get_enum_case(class.as_bytes(), name.as_bytes()) {
                return Some(case.name_span.into());
            }
            // The span covers `NAME = value`; the name starts it.
            let constant = codebase.get_class_constant(class.as_bytes(), name.as_bytes())?;
            let start = constant.span.start.offset;
            Some(Place { file: constant.span.file_id, start, end: start + constant.name.len() as u32 })
        }
        Symbol::Variable { .. } => None,
    }
}

impl Snapshot {
    /// The location of a span in an indexed file.
    pub fn location(&self, index: &Index, place: Place) -> Option<Location> {
        let path = index.path_of(place.file)?;
        let text = self.read(path)?;
        let lines = LineIndex::new(&text);
        Some(Location { uri: path_to_uri(path), range: lines.range(&text, place.start, place.end) })
    }

    /// The locations of several spans, reading each file once.
    pub fn locations(&self, index: &Index, places: impl IntoIterator<Item = Place>) -> Vec<Location> {
        let mut by_file: std::collections::BTreeMap<std::path::PathBuf, Vec<Place>> = Default::default();
        for place in places {
            if let Some(path) = index.path_of(place.file) {
                by_file.entry(path.to_path_buf()).or_default().push(place);
            }
        }
        let mut out = vec![];
        for (path, mut places) in by_file {
            let Some(text) = self.read(&path) else { continue };
            let lines = LineIndex::new(&text);
            places.sort_by_key(|p| (p.start, p.end));
            places.dedup();
            let uri = path_to_uri(&path);
            out.extend(places.into_iter().map(|p| Location { uri: uri.clone(), range: lines.range(&text, p.start, p.end) }));
        }
        out
    }
}

/// Every node of a program with the path of its ancestors, depth first.
pub fn walk<'a>(parsed: &Parsed<'a>, mut f: impl FnMut(Node<'a, 'a>, &[Node<'a, 'a>])) {
    fn go<'a>(node: Node<'a, 'a>, path: &mut Vec<Node<'a, 'a>>, f: &mut impl FnMut(Node<'a, 'a>, &[Node<'a, 'a>])) {
        f(node, path);
        path.push(node);
        node.visit_children(|child| go(child, path, f));
        path.pop();
    }
    go(Node::Program(parsed.program), &mut vec![], &mut f);
}

/// The spans of the variable `$name` (without `$`, in the returned spans too) within the function-like whose
/// span is `scope`, skipping nested functions and closures that have scopes of their own. A closure's `use`
/// list belongs to the outer scope.
pub fn variable_spans(parsed: &Parsed<'_>, name: &str, scope: (u32, u32)) -> Vec<(u32, u32)> {
    let target = format!("${name}");
    let mut out = vec![];
    walk(parsed, |node, path| {
        let Node::DirectVariable(var) = node else { return };
        if var.name != target.as_bytes() {
            return;
        }
        let owner = variable_scope(parsed, path);
        if owner == scope {
            out.push((var.span.start.offset + 1, var.span.end.offset));
        }
    });
    out
}

/// The span of the function whose locals include a variable at the end of `path`: the innermost function,
/// method, hook, or closure, else the file. Arrow functions share their parent's variables, and a closure's
/// `use` list belongs to the scope around the closure.
pub fn variable_scope(parsed: &Parsed<'_>, path: &[Node<'_, '_>]) -> (u32, u32) {
    for (i, n) in path.iter().enumerate().rev() {
        match n {
            Node::Function(_) | Node::Method(_) | Node::PropertyHook(_) => return (n.span().start.offset, n.span().end.offset),
            Node::Closure(_) if !path[i..].iter().any(|p| matches!(p, Node::ClosureUseClause(_))) => {
                return (n.span().start.offset, n.span().end.offset);
            }
            _ => {}
        }
    }
    (parsed.program.span().start.offset, parsed.program.span().end.offset)
}
