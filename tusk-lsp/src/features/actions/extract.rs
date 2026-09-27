//! Extract Method: moves the selected statements, or one expression, into a new method (or function) and
//! calls it from where they were.
//!
//! Variables the selection reads that were set before it become parameters. Variables it sets that are read
//! after it come back as the return value: one as itself, several as an array that the call destructures. A
//! selection with `return` statements works only at the end of its function, where the call is returned.
//!
//! The editor runs the action as the command `tusk.extractMethod`, which applies the edit before it returns,
//! then renames the new method, named `newMethod`, in place.

use lsp_types::{Command, Range, TextEdit, WorkspaceEdit};
use mago_codex::ttype::TType;
use mago_codex::ttype::atomic::TAtomic;
use mago_codex::ttype::atomic::object::TObject;
use mago_codex::ttype::union::TUnion;
use mago_names::kind::NameKind;
use mago_span::HasSpan;
use mago_syntax::cst::{Node, Statement};
use serde_json::Value;

use super::{Candidate, file_edit, indent_unit, line_indent};
use crate::features::{Ctx, with_ctx};
use crate::imports::{import_edits, reference};
use crate::locate::{variable_scope, walk};
use crate::server::Snapshot;
use crate::types::display_class;

pub const COMMAND: &str = "tusk.extractMethod";

/// What an extraction needs to know about the selection, found without the analyzer.
struct Plan {
    start: u32,
    end: u32,
    expression: bool,
    /// Where the new method goes: after the method or function holding the selection.
    host_end: u32,
    host_indent: String,
    /// The class holding the method, or `None` for a plain function.
    class: Option<String>,
    is_static: bool,
    /// Variables to pass in, with the span (including `$`) of each one's mentions.
    params: Vec<(String, Vec<(u32, u32)>)>,
    /// Variables to hand back, with the span of each one's mentions in the selection.
    returns: Vec<(String, Vec<(u32, u32)>)>,
    /// The selection ends the function and returns from it.
    tail_return: bool,
    /// The function's return type as written, for a tail selection.
    host_return: Option<String>,
}

/// One mention of a local variable.
struct Mention {
    name: String,
    start: u32,
    end: u32,
    assigned: bool,
}

fn span(node: &impl HasSpan) -> (u32, u32) {
    let s = node.span();
    (s.start.offset, s.end.offset)
}

fn plan(ctx: &Ctx<'_>, range: Range) -> Result<Plan, String> {
    let text = &ctx.doc.text;
    let (mut start, mut end) = (ctx.offset(range.start) as usize, ctx.offset(range.end) as usize);
    while start < end && text[start..].starts_with(char::is_whitespace) {
        start += text[start..].chars().next().map_or(1, char::len_utf8);
    }
    while end > start && text[..end].ends_with(char::is_whitespace) {
        end -= text[..end].chars().next_back().map_or(1, char::len_utf8);
    }
    if start >= end {
        return Err("Select statements or an expression to extract a method.".into());
    }
    let (start, end) = (start as u32, end as u32);
    let path = ctx.parsed.path_at(start);
    let within = |(s, e): (u32, u32)| s <= start && end <= e;

    // The method or function the selection is in.
    let (host, body) = path
        .iter()
        .rev()
        .find_map(|n| match n {
            Node::Method(m) => match &m.body {
                mago_syntax::cst::MethodBody::Concrete(b) => Some((*n, b)),
                _ => None,
            },
            Node::Function(f) => Some((*n, &f.body)),
            _ => None,
        })
        .filter(|(_, b)| within((b.left_brace.end.offset, b.right_brace.start.offset)))
        .ok_or("Extract Method works on code inside a function or method.")?;

    // Whole statements of one block, else exactly one expression.
    let block = path
        .iter()
        .rev()
        .find_map(|n| match n {
            Node::Block(b) if within((b.left_brace.end.offset, b.right_brace.start.offset)) => Some(*b),
            _ => None,
        })
        .ok_or("Extract Method works on code inside a function or method.")?;
    let chosen: Vec<&Statement<'_>> = block.statements.iter().filter(|s| within(span(*s)) || (start <= span(*s).0 && span(*s).1 <= end)).collect();
    let covered = chosen.iter().filter(|s| start <= span(**s).0 && span(**s).1 <= end).count();
    let statements = covered > 0
        && covered == chosen.len()
        && chosen.first().is_some_and(|s| span(*s).0 == start)
        && chosen.last().is_some_and(|s| span(*s).1 == end);
    let expression = !statements
        && ctx.parsed.path_at(start).iter().any(|n| matches!(n, Node::Expression(_)) && span(n) == (start, end));
    if !statements && !expression {
        return Err("Select whole statements or one expression to extract a method.".into());
    }

    let class = crate::symbol::Resolver::new(&ctx.parsed, None, &ctx.index.codebase).enclosing_class(&path);
    let is_static = matches!(host, Node::Method(m) if m.modifiers.iter().any(|m| m.is_static()));
    let host_span = span(&host);

    // `return` inside the selection, in its own function rather than a closure within it.
    let mut returns_inside = false;
    walk(&ctx.parsed, |node, ancestors| {
        if let Node::Return(_) = node {
            let (s, e) = span(&node);
            let own = ancestors.iter().rev().find(|a| matches!(a, Node::Function(_) | Node::Method(_) | Node::Closure(_) | Node::ArrowFunction(_)));
            if start <= s && e <= end && own.is_some_and(|o| span(o) == host_span) {
                returns_inside = true;
            }
        }
    });
    let tail = statements && body.statements.last().is_some_and(|s| span(s).1 == end);
    if returns_inside && !tail {
        return Err("The selection returns from the function, so only its last statements can be extracted.".into());
    }

    // The locals of the selection's scope.
    let scope = variable_scope(&ctx.parsed, &path);
    let mut mentions: Vec<Mention> = vec![];
    walk(&ctx.parsed, |node, ancestors| {
        let Node::DirectVariable(v) = node else { return };
        let (s, e) = (v.span.start.offset, v.span.end.offset);
        if v.name == b"$this" {
            return;
        }
        let mut chain = ancestors.to_vec();
        chain.push(node);
        if variable_scope(&ctx.parsed, &chain) != scope {
            return;
        }
        let assigned = ancestors.iter().any(|a| match a {
            Node::Assignment(asg) => {
                let (ls, le) = span(asg.lhs);
                ls <= s && e <= le
            }
            Node::ForeachTarget(t) => {
                let (ts, te) = span(*t);
                ts <= s && e <= te
            }
            _ => false,
        });
        mentions.push(Mention { name: String::from_utf8_lossy(&v.name[1..]).into_owned(), start: s, end: e, assigned });
    });
    let inside = |m: &Mention| start <= m.start && m.end <= end;
    let mut params: Vec<(String, Vec<(u32, u32)>)> = vec![];
    let mut returns: Vec<(String, Vec<(u32, u32)>)> = vec![];
    for m in mentions.iter().filter(|m| inside(m)) {
        let spans = |f: &dyn Fn(&Mention) -> bool| mentions.iter().filter(|o| o.name == m.name && f(o)).map(|o| (o.start, o.end)).collect::<Vec<_>>();
        let before = mentions.iter().any(|o| o.name == m.name && o.end <= start);
        if before && !params.iter().any(|(n, _)| *n == m.name) {
            params.push((m.name.clone(), spans(&|o| o.end <= end)));
        }
        let after = mentions.iter().any(|o| o.name == m.name && o.start >= end);
        let set_inside = mentions.iter().any(|o| o.name == m.name && inside(o) && o.assigned);
        if statements && set_inside && after && !returns.iter().any(|(n, _)| *n == m.name) {
            returns.push((m.name.clone(), spans(&|o| inside(o))));
        }
    }
    if tail && returns_inside && !returns.is_empty() {
        return Err("The selection both returns and sets variables used after it.".into());
    }
    let host_return = match host {
        Node::Method(m) => m.return_type_hint.as_ref().map(|h| span(&h.hint)),
        Node::Function(f) => f.return_type_hint.as_ref().map(|h| span(&h.hint)),
        _ => None,
    }
    .map(|(s, e)| text[s as usize..e as usize].to_string());

    Ok(Plan {
        start,
        end,
        expression,
        host_end: host_span.1,
        host_indent: line_indent(text, host_span.0 as usize),
        class,
        is_static,
        params,
        returns,
        tail_return: tail && returns_inside,
        host_return,
    })
}

/// A Mago type as a PHP type declaration, with class names written for this file and the imports they need.
/// `None` when it can't be written, such as `mixed` or a resource.
fn php_type(ctx: &Ctx<'_>, t: &TUnion, imports: &mut Vec<String>) -> Option<String> {
    let mut parts: Vec<String> = vec![];
    for atomic in t.types.iter() {
        let part = match atomic {
            TAtomic::Object(TObject::Named(n)) => {
                let fqn = display_class(&n.name.as_str_lossy(), &ctx.index.codebase);
                let r = reference(&ctx.doc, ctx.parsed.program, 0, &fqn, NameKind::Default);
                if r.edit.is_some() && !imports.contains(&fqn) {
                    imports.push(fqn);
                }
                r.name
            }
            TAtomic::Object(TObject::Enum(e)) => {
                let fqn = display_class(&e.name.as_str_lossy(), &ctx.index.codebase);
                let r = reference(&ctx.doc, ctx.parsed.program, 0, &fqn, NameKind::Default);
                if r.edit.is_some() && !imports.contains(&fqn) {
                    imports.push(fqn);
                }
                r.name
            }
            TAtomic::Null => "null".into(),
            TAtomic::Mixed(_) => return None,
            _ => {
                let id = atomic.get_id().to_string();
                let base = id.split(['<', '(', '{']).next().unwrap_or(&id);
                match base {
                    b if b == "int" || b.ends_with("-int") => "int".into(),
                    b if b == "string" || b.ends_with("-string") => "string".into(),
                    "float" => "float".into(),
                    "bool" | "true" | "false" => "bool".into(),
                    "array" | "list" | "non-empty-array" | "non-empty-list" => "array".into(),
                    "array-key" => "int|string".into(),
                    "numeric" => "int|float".into(),
                    "iterable" | "callable" | "object" | "void" | "never" => base.into(),
                    _ => return None,
                }
            }
        };
        for p in part.split('|') {
            if !parts.iter().any(|x| x == p) {
                parts.push(p.to_string());
            }
        }
    }
    match parts.as_slice() {
        [] => None,
        [a, b] if a == "null" && !b.contains('|') => Some(format!("?{b}")),
        [a, b] if b == "null" && !a.contains('|') => Some(format!("?{a}")),
        _ => Some(parts.join("|")),
    }
}

/// The type of a variable from the first of its mentions the analyzer typed, or of the assignment that sets it.
fn variable_type(ctx: &Ctx<'_>, spans: &[(u32, u32)]) -> Option<std::rc::Rc<TUnion>> {
    let analysis = ctx.analysis();
    spans.iter().rev().find_map(|&(s, e)| {
        analysis.type_of(s, e).or_else(|| {
            // An assignment's target has no type of its own; the assignment carries it.
            ctx.parsed.path_at(s).iter().rev().find_map(|n| match n {
                Node::Assignment(a) if span(a.lhs) == (s, e) => analysis.type_of(span(n).0, span(n).1),
                _ => None,
            })
        })
    })
}

/// A name for the new method or function that isn't taken.
fn free_name(ctx: &Ctx<'_>, class: Option<&str>) -> String {
    let codebase = &ctx.index.codebase;
    (1..)
        .map(|i| if i == 1 { "newMethod".to_string() } else { format!("newMethod{i}") })
        .find(|n| match class {
            Some(c) => !codebase.method_exists(c.as_bytes(), n.as_bytes()),
            None => !codebase.function_exists(n.as_bytes()) && !ctx.doc.text.contains(&format!("function {n}(")),
        })
        .unwrap()
}

fn edit(ctx: &Ctx<'_>, plan: &Plan) -> Option<WorkspaceEdit> {
    let text = &ctx.doc.text;
    let mut imports = vec![];
    let params: Vec<String> = plan
        .params
        .iter()
        .map(|(name, spans)| match variable_type(ctx, spans).and_then(|t| php_type(ctx, &t, &mut imports)) {
            Some(t) => format!("{t} ${name}"),
            None => format!("${name}"),
        })
        .collect();
    let return_type = if plan.tail_return {
        plan.host_return.clone()
    } else if plan.expression {
        ctx.analysis().type_of(plan.start, plan.end).and_then(|t| php_type(ctx, &t, &mut imports))
    } else {
        match plan.returns.as_slice() {
            [] => Some("void".into()),
            [(_, spans)] => variable_type(ctx, spans).and_then(|t| php_type(ctx, &t, &mut imports)),
            _ => Some("array".into()),
        }
    };

    let name = free_name(ctx, plan.class.as_deref());
    let args: Vec<String> = plan.params.iter().map(|(n, _)| format!("${n}")).collect();
    let receiver = match (&plan.class, plan.is_static) {
        (Some(_), true) => "self::",
        (Some(_), false) => "$this->",
        (None, _) => "",
    };
    let call = format!("{receiver}{name}({})", args.join(", "));
    let replacement = if plan.expression {
        call
    } else if plan.tail_return {
        format!("return {call};")
    } else {
        match plan.returns.as_slice() {
            [] => format!("{call};"),
            [(n, _)] => format!("${n} = {call};"),
            many => format!("[{}] = {call};", many.iter().map(|(n, _)| format!("${n}")).collect::<Vec<_>>().join(", ")),
        }
    };

    // The body, re-indented from where it was to one level inside the new method.
    let selected = &text[plan.start as usize..plan.end as usize];
    let mut body = if plan.expression { format!("return {selected};") } else { selected.to_string() };
    match plan.returns.as_slice() {
        [] => {}
        [(n, _)] => body.push_str(&format!("\nreturn ${n};")),
        many => body.push_str(&format!("\nreturn [{}];", many.iter().map(|(n, _)| format!("${n}")).collect::<Vec<_>>().join(", "))),
    }
    let base = line_indent(text, plan.start as usize);
    let inner = format!("{}{}", plan.host_indent, indent_unit(text));
    let body: Vec<String> = body
        .lines()
        .enumerate()
        .map(|(i, line)| match line {
            "" => String::new(),
            _ if i == 0 => format!("{inner}{line}"),
            _ => format!("{inner}{}", line.strip_prefix(base.as_str()).unwrap_or(line.trim_start())),
        })
        .collect();

    let hi = &plan.host_indent;
    let modifiers = match (&plan.class, plan.is_static) {
        (Some(_), true) => "private static ",
        (Some(_), false) => "private ",
        (None, _) => "",
    };
    let ret = return_type.map(|t| format!(": {t}")).unwrap_or_default();
    let method = format!("\n\n{hi}{modifiers}function {name}({}){ret}\n{hi}{{\n{}\n{hi}}}", params.join(", "), body.join("\n"));

    let mut edits = vec![
        TextEdit { range: ctx.doc.range(plan.start, plan.end), new_text: replacement },
        TextEdit { range: ctx.doc.range(plan.host_end, plan.host_end), new_text: method },
    ];
    edits.extend(import_edits(&ctx.doc, ctx.parsed.program, plan.start, &imports, NameKind::Default));
    file_edit(ctx, edits)
}

pub fn candidates(ctx: &Ctx<'_>, range: Range) -> Vec<Candidate> {
    if range.start == range.end || plan(ctx, range).is_err() {
        return vec![];
    }
    let mut c = Candidate::new("Extract method", "refactor.extract.method", "extract.method", Value::Null);
    c.command = Some(Command {
        title: "Extract method".into(),
        command: COMMAND.into(),
        arguments: Some(vec![serde_json::to_value(&ctx.doc.uri).unwrap_or_default(), serde_json::to_value(range).unwrap_or_default()]),
    });
    vec![c]
}

pub fn resolve(ctx: &Ctx<'_>, action: &str, range: Range, _arg: &Value) -> Option<WorkspaceEdit> {
    match action {
        "method" => edit(ctx, &plan(ctx, range).ok()?),
        _ => None,
    }
}

/// The edit for the command's `[uri, range]`, or why there's none.
pub fn command(snap: &Snapshot, args: &[Value]) -> Result<WorkspaceEdit, String> {
    let (Some(uri), Some(range)) = (args.first(), args.get(1)) else { return Err("Extract Method needs a document and a range.".into()) };
    let uri: lsp_types::Uri = serde_json::from_value(uri.clone()).map_err(|e| e.to_string())?;
    let range: Range = serde_json::from_value(range.clone()).map_err(|e| e.to_string())?;
    with_ctx(snap, &uri, |ctx| {
        let plan = plan(ctx, range)?;
        edit(ctx, &plan).ok_or_else(|| "There's nothing to extract.".to_string())
    })
    .unwrap_or_else(|| Err("The document isn't open.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Fixture, uri};
    use lsp_types::{DocumentChangeOperation, DocumentChanges, OneOf};

    /// Extracts the text between `«` and `»` in `test.php`, returning the new text or the refusal.
    fn extract(files: &[(&str, &str)]) -> Result<String, String> {
        let mut owned: Vec<(String, String)> = vec![];
        let mut range = None;
        for (name, text) in files {
            let mut t = text.to_string();
            if let (Some(a), Some(b)) = (t.find('«'), t.find('»')) {
                t = t.replacen('«', "", 1);
                let b = b - '«'.len_utf8();
                t = t.replacen('»', "", 1);
                range = Some((a, b));
            }
            owned.push((name.to_string(), t));
        }
        let refs: Vec<(&str, &str)> = owned.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let fx = Fixture::new(&refs);
        let (a, b) = range.expect("a «selection»");
        let doc = fx.doc("test.php");
        let range = Range { start: doc.position(a as u32), end: doc.position(b as u32) };
        let edit = command(&fx.snap, &[serde_json::to_value(uri("test.php")).unwrap(), serde_json::to_value(range).unwrap()])?;
        let Some(DocumentChanges::Operations(ops)) = edit.document_changes else { panic!() };
        let DocumentChangeOperation::Edit(e) = &ops[0] else { panic!() };
        let mut edits: Vec<TextEdit> = e.edits.iter().map(|e| match e { OneOf::Left(e) => e.clone(), OneOf::Right(a) => a.text_edit.clone() }).collect();
        edits.sort_by_key(|e| std::cmp::Reverse(doc.offset(e.range.start)));
        let mut text = doc.text.clone();
        for e in edits {
            text.replace_range(doc.offset(e.range.start) as usize..doc.offset(e.range.end) as usize, &e.new_text);
        }
        Ok(text)
    }

    #[test]
    fn extracts_statements_with_parameters_and_a_returned_variable() {
        let out = extract(&[(
            "test.php",
            "<?php\nclass A\n{\n    public function run(int $count): int\n    {\n        $base = 2;\n        «$total = $count * $base;\n        $total += 1;»\n        return $total;\n    }\n}\n",
        )])
        .unwrap();
        assert_eq!(
            out,
            "<?php\nclass A\n{\n    public function run(int $count): int\n    {\n        $base = 2;\n        $total = $this->newMethod($count, $base);\n        return $total;\n    }\n\n    private function newMethod(int $count, int $base): int\n    {\n        $total = $count * $base;\n        $total += 1;\n        return $total;\n    }\n}\n"
        );
    }

    #[test]
    fn extracts_an_expression_and_imports_its_type() {
        let out = extract(&[
            ("lib.php", "<?php\nnamespace Lib;\nclass Money { public function add(Money $m): Money { return $m; } }\n"),
            (
                "test.php",
                "<?php\nnamespace App;\n\nfunction total(\\Lib\\Money $a, \\Lib\\Money $b)\n{\n    return «$a->add($b)»;\n}\n",
            ),
        ])
        .unwrap();
        assert_eq!(
            out,
            "<?php\nnamespace App;\n\nuse Lib\\Money;\n\nfunction total(\\Lib\\Money $a, \\Lib\\Money $b)\n{\n    return newMethod($a, $b);\n}\n\nfunction newMethod(Money $a, Money $b): Money\n{\n    return $a->add($b);\n}\n"
        );
    }

    #[test]
    fn destructures_several_returned_variables_and_keeps_static_methods_static() {
        let out = extract(&[(
            "test.php",
            "<?php\nclass A\n{\n    public static function f(): string\n    {\n        «$a = 'x';\n        $b = 'y';»\n        return $a . $b;\n    }\n}\n",
        )])
        .unwrap();
        assert!(out.contains("[$a, $b] = self::newMethod();"), "{out}");
        assert!(out.contains("private static function newMethod(): array\n    {\n        $a = 'x';\n        $b = 'y';\n        return [$a, $b];\n    }"), "{out}");
    }

    #[test]
    fn returns_the_call_for_a_tail_with_returns() {
        let out = extract(&[(
            "test.php",
            "<?php\nclass A\n{\n    public function f(int $x): string\n    {\n        $y = $x + 1;\n        «if ($y > 2) {\n            return 'big';\n        }\n        return 'small';»\n    }\n}\n",
        )])
        .unwrap();
        assert!(out.contains("        return $this->newMethod($y);\n    }"), "{out}");
        assert!(out.contains("private function newMethod(int $y): string\n    {\n        if ($y > 2) {\n            return 'big';\n        }\n        return 'small';\n    }"), "{out}");
    }

    #[test]
    fn refuses_partial_statements_and_early_returns() {
        let text = "<?php\nfunction f($x) {\n    «if ($x) { return 1; }»\n    echo $x;\n}\n";
        assert!(extract(&[("test.php", text)]).unwrap_err().contains("last statements"));
        let text = "<?php\nfunction f($x) {\n    $a = «1;\n    $b» = 2;\n}\n";
        assert!(extract(&[("test.php", text)]).is_err());
        let text = "<?php\n$a = «1»;\n";
        assert!(extract(&[("test.php", text)]).is_err());
    }

    #[test]
    fn avoids_taken_names() {
        let out = extract(&[(
            "test.php",
            "<?php\nclass A\n{\n    public function f()\n    {\n        «echo 1;»\n    }\n    private function newMethod() {}\n}\n",
        )])
        .unwrap();
        assert!(out.contains("$this->newMethod2();"), "{out}");
    }

    #[test]
    fn lists_the_action_with_its_command() {
        let fx = Fixture::one("<?php\nfunction f() {\n    echo 1;\n}\n");
        let doc = fx.doc("test.php");
        let start = doc.text.find("echo").unwrap() as u32;
        let range = Range { start: doc.position(start), end: doc.position(start + 7) };
        let found = with_ctx(&fx.snap, &uri("test.php"), |ctx| candidates(ctx, range)).unwrap();
        assert_eq!(found[0].command.as_ref().map(|c| c.command.as_str()), Some(COMMAND));
    }
}
