//! The deepest syntax trees in a folder's PHP files: `cargo run --release --example depth <dir>`.
use mago_allocator::LocalArena;
use mago_span::HasSpan;
use mago_syntax::cst::Node;
fn main() {
    let dir = std::env::args().nth(1).unwrap();
    let mut found: Vec<(usize, String)> = ignore::WalkBuilder::new(&dir)
        .standard_filters(false)
        .build()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "php"))
        .filter_map(|e| {
            let text = std::fs::read_to_string(e.path()).ok()?;
            let arena = LocalArena::new();
            let parsed = tusk_lsp::analysis::Parsed::new(&arena, e.path(), &text);
            let mut max = 0;
            let mut stack = vec![(Node::Program(parsed.program), 0)];
            while let Some((node, depth)) = stack.pop() {
                let mut branches = 0;
                node.visit_children(|c| {
                    if matches!(c, Node::IfStatementBodyElseIfClause(_) | Node::IfColonDelimitedBodyElseIfClause(_) | Node::SwitchCase(_) | Node::MatchArm(_)) {
                        branches += 1;
                    }
                    stack.push((c, depth + 1))
                });
                // With BRANCHES set, the most branches of one if, switch, or match instead of depth.
                max = max.max(if std::env::var("BRANCHES").is_ok() { branches } else { depth });
            }
            let _ = parsed.program.span();
            Some((max, e.path().display().to_string()))
        })
        .collect();
    found.sort();
    for (d, p) in found.iter().rev().take(8) {
        println!("{d:>6} {p}");
    }
}
