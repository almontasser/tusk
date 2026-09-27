//! Parsing and analyzing one file against the index. Mago's syntax tree, names, and types all borrow from an
//! arena, so a request parses the file it needs, answers, and drops everything together.

use std::path::Path;
use std::rc::Rc;
use std::sync::LazyLock;

use mago_allocator::LocalArena;
use mago_analyzer::Analyzer;
use mago_analyzer::analysis_result::AnalysisResult;
use mago_analyzer::artifacts::AnalysisArtifacts;
use mago_analyzer::plugin::PluginRegistry;
use mago_analyzer::settings::Settings;
use mago_codex::metadata::CodebaseMetadata;
use mago_codex::reference::SymbolReferences;
use mago_codex::ttype::union::TUnion;
use mago_database::file::{File, FileType};
use mago_names::ResolvedNames;
use mago_names::resolver::NameResolver;
use mago_php_version::PHPVersion;
use mago_reporting::IssueCollection;
use mago_span::HasSpan;
use mago_syntax::cst::{Node, Program};
use mago_syntax::parser::parse_file;

use crate::index::source_file;

static PLUGINS: LazyLock<PluginRegistry> = LazyLock::new(PluginRegistry::with_library_providers);

/// A parsed file with its names resolved.
pub struct Parsed<'a> {
    pub file: File,
    pub program: &'a Program<'a>,
    pub names: ResolvedNames<'a>,
}

impl<'a> Parsed<'a> {
    pub fn new(arena: &'a LocalArena, path: &Path, text: &str) -> Self {
        let file = source_file(path, FileType::Host, text.as_bytes().to_vec());
        let program = parse_file(arena, &file);
        let names = NameResolver::new(arena).resolve(program);
        Self { file, program, names }
    }

    pub fn text(&self) -> &str {
        // Built from a `&str`, so always UTF-8.
        std::str::from_utf8(&self.file.contents).unwrap_or_default()
    }

    /// The chain of nodes from the program down to the innermost one whose span contains `offset`. At a
    /// boundary between two nodes, the one that starts there wins, so a cursor just before a name selects it.
    pub fn path_at(&self, offset: u32) -> Vec<Node<'a, 'a>> {
        let mut path = vec![Node::Program(self.program)];
        loop {
            let node = *path.last().unwrap();
            let mut next = None;
            node.visit_children(|child| {
                let span = child.span();
                if span.start.offset <= offset && offset <= span.end.offset {
                    // Prefer a later sibling that starts exactly at the offset over one that ends there.
                    if next.is_none() || span.start.offset == offset {
                        next = Some(child);
                    }
                }
            });
            match next {
                Some(child) => path.push(child),
                None => return path,
            }
        }
    }

    /// The fully qualified name the resolver gave the identifier at `offset`, with its span.
    pub fn name_at(&self, offset: u32) -> Option<(u32, u32, String, bool)> {
        self.names
            .at_offset(offset)
            .map(|(start, end, name, imported)| (start, end, String::from_utf8_lossy(name).into_owned(), imported))
    }
}

/// What the analyzer found in a file: expression types and problems.
pub struct Analysis {
    pub artifacts: AnalysisArtifacts,
    pub issues: IssueCollection,
}

impl Analysis {
    /// The type of the smallest expression whose span contains `start..end`.
    pub fn type_at(&self, start: u32, end: u32) -> Option<Rc<TUnion>> {
        self.artifacts
            .expression_types
            .iter()
            .filter(|((s, e), _)| *s <= start && end <= *e)
            .min_by_key(|((s, e), _)| e - s)
            .map(|(_, t)| t.clone())
    }

    /// The type of the expression spanning exactly `start..end`.
    pub fn type_of(&self, start: u32, end: u32) -> Option<Rc<TUnion>> {
        self.artifacts.expression_types.get(&(start, end)).cloned()
    }
}

pub fn settings(version: PHPVersion) -> Settings {
    Settings {
        version,
        use_colors: false,
        // Unused-code checks need the whole project analyzed, which a single file's analysis can't see.
        find_unused_definitions: false,
        ..Settings::new(version)
    }
}

pub fn analyze(parsed: &Parsed<'_>, arena: &LocalArena, codebase: &CodebaseMetadata, version: PHPVersion) -> Analysis {
    let mut result = AnalysisResult::new(SymbolReferences::new());
    let analyzer = Analyzer::new(arena, &parsed.file, &parsed.names, codebase, &PLUGINS, settings(version));
    let artifacts = analyzer.analyze_with_artifacts(parsed.program, &mut result).unwrap_or_default();
    Analysis { artifacts, issues: result.issues }
}
