//! Signature help: the parameters of the function, method, or constructor whose argument list the cursor is in.

use lsp_types::{
    Documentation, MarkupContent, MarkupKind, ParameterInformation, ParameterLabel, SignatureHelp, SignatureHelpParams,
    SignatureInformation,
};
use mago_codex::metadata::function_like::FunctionLikeMetadata;
use mago_span::HasSpan;
use mago_syntax::cst::{ArgumentList, Node};

use super::hover::{docblock_markdown, source};
use super::{Ctx, with_ctx_at};
use crate::server::Snapshot;
use crate::symbol::Symbol;

pub fn signature_help(snap: &Snapshot, params: SignatureHelpParams) -> Result<Option<SignatureHelp>, String> {
    let at = params.text_document_position_params;
    Ok(with_ctx_at(snap, &at.text_document.uri, at.position, |ctx| help(ctx, ctx.offset(at.position))).flatten())
}

/// The call whose parentheses hold `offset`, with the offset of the name that says what it calls.
/// Returns where the arguments start (after `(`), the offset of the called name, and whether it's `new`.
fn call_at(ctx: &Ctx<'_>, offset: u32) -> Option<(u32, u32, bool)> {
    let path = ctx.parsed.path_at(offset);
    let inside = |list: &ArgumentList<'_>| {
        list.left_parenthesis.end.offset <= offset
            && (offset <= list.right_parenthesis.start.offset || list.right_parenthesis.is_zero())
    };
    for node in path.iter().rev() {
        let (list, name, constructor) = match node {
            Node::FunctionCall(c) => (&c.argument_list, c.function.span().end.offset.saturating_sub(1), false),
            Node::MethodCall(c) => (&c.argument_list, c.method.span().start.offset, false),
            Node::NullSafeMethodCall(c) => (&c.argument_list, c.method.span().start.offset, false),
            Node::StaticMethodCall(c) => (&c.argument_list, c.method.span().start.offset, false),
            Node::Instantiation(i) => match &i.argument_list {
                Some(list) => (list, i.class.span().start.offset, true),
                None => continue,
            },
            _ => continue,
        };
        if inside(list) {
            return Some((list.left_parenthesis.end.offset, name, constructor));
        }
    }
    None
}

fn help(ctx: &Ctx<'_>, offset: u32) -> Option<SignatureHelp> {
    let (args_start, name_at, constructor) = call_at(ctx, offset)?;
    let found = ctx.resolver().at(name_at)?;
    let codebase = &ctx.index.codebase;
    let function: &FunctionLikeMetadata = match found.symbols.first()? {
        Symbol::Function(name) => codebase.get_function(name.as_bytes())?,
        Symbol::Method { class, name } => codebase.get_declaring_method(class.as_bytes(), name.as_bytes())?,
        Symbol::Class(class) if constructor => codebase.get_declaring_method(class.as_bytes(), b"__construct")?,
        _ => return None,
    };
    let src = source(ctx, function.span);
    let (label, ranges) = match &src {
        Some(s) => label_from_source(&s.signature)?,
        None => label_from_metadata(function),
    };
    let docs = src.as_ref().and_then(|s| s.docblock.as_deref());
    let text = ctx.parsed.text();
    let args = &text[args_start as usize..offset as usize];
    let names: Vec<String> = function.parameters.iter().map(|p| p.get_name().0.as_str_lossy().trim_start_matches('$').to_string()).collect();
    let active = active_parameter(args, &names).min(ranges.len().saturating_sub(1).max(0));
    let parameters = ranges
        .iter()
        .zip(names.iter().map(Some).chain(std::iter::repeat(None)))
        .map(|((s, e), name)| ParameterInformation {
            label: ParameterLabel::LabelOffsets([*s, *e]),
            documentation: name.and_then(|n| docs.and_then(|d| param_doc(d, n))).map(|d| {
                Documentation::MarkupContent(MarkupContent { kind: MarkupKind::Markdown, value: d })
            }),
        })
        .collect();
    Some(SignatureHelp {
        signatures: vec![SignatureInformation {
            label,
            documentation: docs.map(description).filter(|d| !d.is_empty()).map(|d| {
                Documentation::MarkupContent(MarkupContent { kind: MarkupKind::Markdown, value: d })
            }),
            parameters: Some(parameters),
            active_parameter: Some(active as u32),
        }],
        active_signature: Some(0),
        active_parameter: Some(active as u32),
    })
}

/// A declaration's name, parameters, and return type, with each parameter's UTF-16 offsets in it.
fn label_from_source(signature: &str) -> Option<(String, Vec<(u32, u32)>)> {
    let from = signature.find("function ").map_or(0, |i| i + "function ".len());
    let label = signature[from..].trim_start_matches('&').to_string();
    let open = label.find('(')?;
    let mut ranges = vec![];
    let mut depth = 0;
    let mut quote: Option<char> = None;
    let mut start = open + 1;
    for (i, c) in label.char_indices().skip_while(|(i, _)| *i <= open) {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            '(' | '[' | '{' => depth += 1,
            ')' if depth == 0 => {
                push_param(&label, start, i, &mut ranges);
                break;
            }
            ')' | ']' | '}' => depth -= 1,
            ',' if depth == 0 => {
                push_param(&label, start, i, &mut ranges);
                start = i + 1;
            }
            _ => {}
        }
    }
    Some((label, ranges))
}

fn push_param(label: &str, start: usize, end: usize, ranges: &mut Vec<(u32, u32)>) {
    let raw = &label[start..end];
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return;
    }
    let s = start + (raw.len() - raw.trim_start().len());
    let e = s + trimmed.len();
    let utf16 = |i: usize| label[..i].encode_utf16().count() as u32;
    ranges.push((utf16(s), utf16(e)));
}

fn label_from_metadata(function: &FunctionLikeMetadata) -> (String, Vec<(u32, u32)>) {
    let mut label = format!("{}(", function.original_name.as_str_lossy());
    let mut ranges = vec![];
    for (i, p) in function.parameters.iter().enumerate() {
        if i > 0 {
            label.push_str(", ");
        }
        let start = label.encode_utf16().count() as u32;
        if let Some(t) = &p.type_declaration_metadata {
            label.push_str(&crate::types::display(&t.type_union));
            label.push(' ');
        }
        label.push_str(&p.get_name().0.as_str_lossy());
        ranges.push((start, label.encode_utf16().count() as u32));
    }
    label.push(')');
    (label, ranges)
}

/// Which parameter the argument being typed fills: by name for `name: value`, else by position.
fn active_parameter(args: &str, names: &[String]) -> usize {
    let mut depth = 0;
    let mut quote: Option<char> = None;
    let mut index = 0;
    let mut current_start = 0;
    for (i, c) in args.char_indices() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            ',' if depth == 0 => {
                index += 1;
                current_start = i + 1;
            }
            _ => {}
        }
    }
    let current = args[current_start..].trim_start();
    if let Some((name, _)) = current.split_once(':')
        && !name.contains(['(', '$', '\'', '"', ':'])
        && let Some(i) = names.iter().position(|n| n == name.trim())
    {
        return i;
    }
    index
}

fn description(docblock: &str) -> String {
    let md = docblock_markdown(docblock);
    md.split("\n\n_@").next().unwrap_or("").to_string()
}

/// The description of `@param … $name`.
fn param_doc(docblock: &str, name: &str) -> Option<String> {
    let needle = format!("${name}");
    docblock.lines().find_map(|line| {
        let line = line.trim().trim_start_matches('*').trim();
        let rest = line.strip_prefix("@param")?;
        let at = rest.find(&needle)?;
        let after = &rest[at + needle.len()..];
        if after.starts_with(|c: char| c.is_alphanumeric() || c == '_') {
            return None;
        }
        let ty = rest[..at].trim();
        let desc = after.trim();
        Some(if desc.is_empty() { format!("`{ty}`") } else { format!("`{ty}` {desc}") })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fixture;

    fn sig(files: &[(&str, &str)]) -> Option<(String, u32, String)> {
        let fx = Fixture::new(files);
        let h = signature_help(&fx.snap, SignatureHelpParams {
            text_document_position_params: fx.at(),
            work_done_progress_params: Default::default(),
            context: None,
        })
        .unwrap()?;
        let s = &h.signatures[0];
        let active = h.active_parameter.unwrap();
        let ParameterLabel::LabelOffsets([a, b]) = s.parameters.as_ref().unwrap()[active as usize].label else { panic!() };
        let utf16: Vec<u16> = s.label.encode_utf16().collect();
        Some((s.label.clone(), active, String::from_utf16(&utf16[a as usize..b as usize]).unwrap()))
    }

    const LIB: &str = "<?php\nnamespace App;\nclass Mailer {\n    /** @param string $to Who gets it */\n    public function send(string $to, array $data = ['a', 'b'], ?callable $then = null): bool { return true; }\n    public function __construct(private int $retries = 3) {}\n}\nfunction greet(string $name, int $times = 1): void {}\n";

    #[test]
    fn follows_the_argument_being_typed() {
        let files = |t| [("lib.php", LIB), ("t.php", t)];
        let s = sig(&files("<?php function f(\\App\\Mailer $m) { $m->send('x', [1, 2], <|>); }")).unwrap();
        assert_eq!(s, ("send(string $to, array $data = ['a', 'b'], ?callable $then = null): bool".into(), 2, "?callable $then = null".into()));
        let s = sig(&files("<?php \\App\\greet(<|>)")).unwrap();
        assert_eq!((s.1, s.2.as_str()), (0, "string $name"));
        let s = sig(&files("<?php \\App\\greet(times: <|>)")).unwrap();
        assert_eq!((s.1, s.2.as_str()), (1, "int $times = 1"));
        let s = sig(&files("<?php new \\App\\Mailer(<|>);")).unwrap();
        assert_eq!(s.2, "private int $retries = 3");
        // Arguments nested in brackets don't count as separate arguments.
        let s = sig(&files("<?php \\App\\greet(strlen('a,b'), <|>)")).unwrap();
        assert_eq!(s.1, 1);
        // Built-in functions come from PHP's stubs.
        let s = sig(&files("<?php str_replace('a', <|>)")).unwrap();
        assert_eq!(s.1, 1);
        assert!(sig(&files("<?php \\App\\greet('a');<|>")).is_none());
    }

    #[test]
    fn works_in_unfinished_calls() {
        let s = sig(&[("lib.php", LIB), ("t.php", "<?php\nfunction f(\\App\\Mailer $m) {\n    $m->send('x', <|>\n}\n")]);
        assert_eq!(s.map(|s| s.1), Some(1));
    }
}
