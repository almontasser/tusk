//! Parsing and analyzing one file against the index. Mago's syntax tree, names, and types all borrow from an
//! arena, so a request parses the file it needs, answers, and drops everything together.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;
use std::sync::LazyLock;

use mago_allocator::LocalArena;
use mago_analyzer::Analyzer;
use mago_analyzer::analysis_result::AnalysisResult;
use mago_analyzer::artifacts::AnalysisArtifacts;
use mago_analyzer::plugin::{ExpressionHook, ExpressionHookResult, HookContext, HookResult, PluginRegistry, Provider, ProviderMeta};
use mago_analyzer::settings::Settings;
use mago_codex::reference::SymbolReferences;
use mago_codex::ttype::union::TUnion;
use mago_database::file::{File, FileType};
use mago_names::ResolvedNames;
use mago_names::resolver::NameResolver;
use mago_php_version::PHPVersion;
use mago_reporting::IssueCollection;
use mago_span::HasSpan;
use mago_syntax::cst::{Access, ClassLikeMemberSelector, Expression, Node, Program, Variable};
use mago_syntax::parser::parse_file;
use mago_word::Word;

use crate::index::{Index, PHPUNIT_TEST_CASE, source_file};

/// Parses a file. If brackets are left open at its end, as when a class is being written at the end of a file,
/// they're closed first, so the parser keeps the unfinished declaration. The index and every request parse the
/// same way, so spans agree.
pub fn parse_balanced<'a>(arena: &'a LocalArena, path: &Path, file_type: FileType, contents: Vec<u8>) -> (File, &'a Program<'a>) {
    let file = source_file(path, file_type, contents);
    let program = parse_file(arena, &file);
    if program.errors.is_empty() {
        return (file, program);
    }
    let balanced = crate::repair::balance_end(&crate::text::decode(&file.contents));
    let file = source_file(path, file_type, balanced.into_bytes());
    let program = parse_file(arena, &file);
    (file, program)
}

static PLUGINS: LazyLock<PluginRegistry> = LazyLock::new(|| {
    let mut plugins = PluginRegistry::with_library_providers();
    plugins.register_expression_hook(PestHook);
    plugins
});

thread_local! {
    /// While a Pest test file is analyzed: its test case, and the type of each property its tests set on `$this`.
    static PEST: RefCell<Option<(Word, HashMap<Vec<u8>, TUnion>)>> = const { RefCell::new(None) };
}

/// Binds a Pest test file's closures to the file's test case rather than PHPUnit's, and types the properties its
/// tests set on `$this` that the test case doesn't declare from the values they're given. The analyzer reaches a
/// file's closures in order, so what `beforeEach()` sets types the tests after it.
struct PestHook;

impl Provider for PestHook {
    fn meta() -> &'static ProviderMeta {
        static META: ProviderMeta = ProviderMeta::new("tusk-pest", "Pest", "Binds Pest's test closures to the file's test case.");
        &META
    }
}

impl ExpressionHook for PestHook {
    fn before_expression(&self, expr: &Expression<'_>, context: &mut HookContext<'_, '_>) -> HookResult<ExpressionHookResult> {
        PEST.with_borrow(|pest| {
            let Some((case, props)) = pest else { return Ok(ExpressionHookResult::Continue) };
            if let Expression::Closure(_) | Expression::ArrowFunction(_) = expr
                && let Some(scope) = &mut context.artifacts_mut().closure_bind_scope
                && scope.class_name.is_some_and(|c| c.as_str_lossy().eq_ignore_ascii_case(PHPUNIT_TEST_CASE))
            {
                scope.class_name = Some(*case);
            }
            match this_property(expr).and_then(|name| props.get(name)) {
                Some(t) if in_class(context, *case) => Ok(ExpressionHookResult::SkipWithType(t.clone())),
                _ => Ok(ExpressionHookResult::Continue),
            }
        })
    }

    fn after_expression(&self, expr: &Expression<'_>, context: &mut HookContext<'_, '_>) -> HookResult<()> {
        let Expression::Assignment(a) = expr else { return Ok(()) };
        let Some(name) = this_property(a.lhs).filter(|_| a.operator.is_assign()) else { return Ok(()) };
        PEST.with_borrow_mut(|pest| {
            let Some((case, props)) = pest else { return };
            let declared = context.codebase().property_exists(case.as_bytes(), &[b"$", name].concat());
            if let (true, false, Some(t)) = (in_class(context, *case), declared, context.get_expression_type(a.rhs)) {
                props.insert(name.to_vec(), t.clone());
            }
        });
        Ok(())
    }
}

fn in_class(context: &HookContext<'_, '_>, class: Word) -> bool {
    context.current_class_name().is_some_and(|c| c.as_str_lossy().eq_ignore_ascii_case(&class.as_str_lossy()))
}

/// `user` in `$this->user`.
fn this_property<'a>(expr: &Expression<'a>) -> Option<&'a [u8]> {
    let Expression::Access(Access::Property(a)) = expr else { return None };
    match (a.object, &a.property) {
        (Expression::Variable(Variable::Direct(v)), ClassLikeMemberSelector::Identifier(id)) if v.name == b"$this" => Some(id.value),
        _ => None,
    }
}

/// A parsed file with its names resolved.
pub struct Parsed<'a> {
    pub file: File,
    pub program: &'a Program<'a>,
    pub names: ResolvedNames<'a>,
}

impl<'a> Parsed<'a> {
    /// Parses `text`, with brackets left open at its end closed the way the index closes them.
    pub fn new(arena: &'a LocalArena, path: &Path, text: &str) -> Self {
        let (file, program) = parse_balanced(arena, path, FileType::Host, text.as_bytes().to_vec());
        let names = NameResolver::new(arena).resolve(program);
        Self { file, program, names }
    }

    /// Parses `text` as it is, for a repaired copy of a document.
    pub fn exact(arena: &'a LocalArena, path: &Path, text: &str) -> Self {
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

/// Deeper syntax trees than any real code has, such as a generated expression of thousands of terms. Mago's analyzer
/// and linter take time quadratic in such a chain's length and recurse once per level. Real code nests at most about
/// 850 levels deep (a Symfony bundle's configuration chain).
pub const MAX_DEPTH: usize = 1000;

/// More branches in one `if`, `switch`, or `match` than real code has: Mago's analyzer takes 0.7 s on a `match` of
/// 1,000 arms and minutes on 20,000 `elseif`s. Real code has at most about 800 (a `switch` in WordPress).
pub const MAX_BRANCHES: usize = 1000;

/// Whether `program` is beyond what the analyzer and requests handle in reasonable time: nested deeper than
/// [`MAX_DEPTH`], or with more than [`MAX_BRANCHES`] branches in one statement. Walks with its own stack, so any depth
/// is safe.
pub fn too_complex(program: &Program<'_>) -> bool {
    let mut stack = vec![(Node::Program(program), 0)];
    while let Some((node, depth)) = stack.pop() {
        if depth > MAX_DEPTH {
            return true;
        }
        let mut branches = 0;
        node.visit_children(|child| {
            if matches!(child, Node::IfStatementBodyElseIfClause(_) | Node::IfColonDelimitedBodyElseIfClause(_) | Node::SwitchCase(_) | Node::MatchArm(_)) {
                branches += 1;
            }
            stack.push((child, depth + 1));
        });
        if branches > MAX_BRANCHES {
            return true;
        }
    }
    false
}

pub fn analyze(parsed: &Parsed<'_>, arena: &LocalArena, index: &Index) -> Analysis {
    analyze_with(parsed, arena, index, settings(index.config.php_version))
}

pub fn analyze_with(parsed: &Parsed<'_>, arena: &LocalArena, index: &Index, settings: Settings) -> Analysis {
    let mut result = AnalysisResult::new(SymbolReferences::new());
    if too_complex(parsed.program) {
        return Analysis { artifacts: Default::default(), issues: result.issues };
    }
    PEST.set(index.pest_case(parsed).map(|case| (case, HashMap::new())));
    let analyzer = Analyzer::new(arena, &parsed.file, &parsed.names, &index.codebase, &PLUGINS, settings);
    let artifacts = analyzer.analyze_with_artifacts(parsed.program, &mut result).unwrap_or_default();
    PEST.set(None);
    Analysis { artifacts, issues: result.issues }
}
