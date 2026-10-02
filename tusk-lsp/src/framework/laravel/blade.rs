//! Blade views: the PHP in their echoes and directives, laid out as a PHP file at the same offsets, and the
//! component and Livewire tags, which are HTML rather than PHP.

use std::ops::Range;

/// Directives whose arguments name views, translations, or abilities, so they're read as calls. Others are
/// left out: `@foreach ($a as $b)` isn't a valid call and would only add parse errors.
const CALL_DIRECTIVES: &[&str] = &[
    "include", "includeIf", "includeWhen", "includeUnless", "includeFirst", "extends", "extendsFirst", "each", "component",
    "componentFirst", "can", "cannot", "canany", "lang", "livewire", "method", "error", "section", "yield", "push",
    "stack", "props", "env", "json", "vite",
];

/// A Blade view's PHP at the offsets it has in the view, so string positions in it are positions in the view.
/// `{{ route('home') }}` becomes `   route('home');`, and `@include('nav')` becomes `_include('nav');`: the `@`
/// turns into `_`, which [`directive_name`] maps back. Everything else becomes spaces, keeping line breaks.
/// Text from `upto` on is left out, for completing what's being typed there.
pub fn virtual_php(text: &str, upto: usize) -> String {
    let src = &text.as_bytes()[..upto.min(text.len())];
    let mut out: Vec<u8> = src.iter().map(|b| if *b == b'\n' { b'\n' } else { b' ' }).collect();
    if out.len() < 3 {
        return String::from_utf8(out).unwrap_or_default();
    }
    // A short opening tag (`<?` and a space, which Mago's lexer accepts) goes in the first three bytes without
    // a line break before any echo or directive, so the view's line breaks stay where they are.
    let first = src.iter().position(|b| matches!(b, b'{' | b'@')).unwrap_or(src.len());
    let tag = (0..first.saturating_sub(2)).find(|p| !src[*p..p + 3].contains(&b'\n')).unwrap_or(0);
    out[tag..tag + 3].copy_from_slice(b"<? ");
    let copy = |out: &mut Vec<u8>, from: usize, to: usize| out[from..to].copy_from_slice(&src[from..to]);
    // A view that starts with a directive, such as `@extends('layouts.app')`, has no room for the tag before it, so
    // the tag takes the directive's first three bytes and its name becomes a short one ([`SHORT`]).
    let mut i = if src[0] == b'@' { 0 } else { tag + 3 };
    while i < src.len() {
        if src[i..].starts_with(b"{{--") {
            i = find(src, i + 4, b"--}}").map_or(src.len(), |e| e + 4);
        } else if let Some((open, close)) = [(&b"{!!"[..], &b"!!}"[..]), (b"{{{", b"}}}"), (b"{{", b"}}")].into_iter().find(|(o, _)| src[i..].starts_with(o)) {
            let start = i + open.len();
            match find(src, start, close) {
                Some(end) => {
                    copy(&mut out, start, end);
                    out[end] = b';';
                    i = end + close.len();
                }
                None => {
                    // An echo still being typed runs to the end.
                    copy(&mut out, start, src.len());
                    break;
                }
            }
        } else if src[i] == b'@' && (i == 0 || !(src[i - 1].is_ascii_alphanumeric() || src[i - 1] == b'@')) {
            let name_end = i + 1 + src[i + 1..].iter().take_while(|b| b.is_ascii_alphanumeric() || **b == b'_').count();
            let name = std::str::from_utf8(&src[i + 1..name_end]).unwrap_or("");
            let paren = name_end + src[name_end..].iter().take_while(|b| **b == b' ').count();
            if !CALL_DIRECTIVES.contains(&name) || src.get(paren) != Some(&b'(') {
                i = name_end.max(i + 1);
                continue;
            }
            if i == 0 {
                let short = CALL_DIRECTIVES.iter().position(|d| *d == name).and_then(|at| SHORT.get(at)).filter(|_| name_end >= 5);
                let Some(short) = short else {
                    i = name_end;
                    continue;
                };
                out[..5].copy_from_slice(&[b'<', b'?', b' ', b'_', *short]);
            } else {
                out[i] = b'_';
                copy(&mut out, i + 1, name_end);
            }
            match matching_paren(src, paren) {
                Some(close) => {
                    copy(&mut out, paren, close + 1);
                    if close + 1 < src.len() && src[close + 1] != b'\n' {
                        out[close + 1] = b';';
                    }
                    i = close + 1;
                }
                None => {
                    // An unfinished directive: its arguments run to the end of the line, or to `upto`.
                    let end = src[paren..].iter().position(|b| *b == b'\n').map_or(src.len(), |n| paren + n);
                    copy(&mut out, paren, end);
                    i = end;
                }
            }
        } else {
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_default()
}

/// Laravel's directives that take PHP arguments, for [`checked_php`]. Others, such as `@media` in CSS, stay
/// text, as Blade leaves them.
const PHP_DIRECTIVES: &[&str] = &[
    "if", "elseif", "unless", "isset", "empty", "switch", "case", "break", "continue", "foreach", "forelse", "for",
    "while", "php", "json", "js", "class", "style", "checked", "selected", "disabled", "readonly", "required",
    "include", "includeIf", "includeWhen", "includeUnless", "includeFirst", "each", "extends", "extendsFirst",
    "componentFirst", "section", "yield", "hasSection", "sectionMissing", "hasStack", "push", "pushIf", "prepend", "pushOnce", "prependOnce",
    "stack", "component", "slot", "props", "aware", "can", "cannot", "canany", "elsecan", "elsecannot",
    "elsecanany", "auth", "guest", "elseauth", "elseguest", "env", "production", "session", "context", "error",
    "method", "lang", "choice", "inject", "dd", "dump", "vite", "once", "fragment", "livewire", "use",
];

/// A Blade view as a PHP file for Mago's analyzer, from [`checked_php`].
pub struct Checked {
    pub php: String,
    /// The length of the first line, which holds `<?php`, the view's `@use` imports, and its variables.
    pub head: usize,
    /// The PHP that isn't the view's, such as the `if(isset` of `@isset(…)`: the view offset it goes before, and its
    /// length, in order.
    added: Vec<(usize, usize)>,
    /// The ranges of the view where "possibly null" problems can't be trusted.
    pub unsure: Vec<Range<usize>>,
    /// The ranges of the view where a user is logged in, such as the body of `@auth`.
    pub authed: Vec<Range<usize>>,
}

impl Checked {
    /// The offset in the PHP of the view's `offset`.
    pub fn php_offset(&self, offset: usize) -> usize {
        self.head + offset + self.added.iter().take_while(|(at, _)| *at <= offset).map(|(_, len)| len).sum::<usize>()
    }

    /// The view's offset at `offset` in the PHP, or `Err` with where PHP was added for an offset in what was added.
    /// An offset in the first line is the view's start.
    pub fn view_offset(&self, offset: usize) -> Result<usize, usize> {
        let mut view = offset.saturating_sub(self.head);
        for (at, len) in &self.added {
            if view < *at {
                break;
            }
            if view < at + len {
                return Err(*at);
            }
            view -= len;
        }
        Ok(view)
    }
}

/// A Blade view as a PHP file for Mago's analyzer. After the first line comes the view with everything but its PHP
/// blanked, at the view's offsets but for the PHP that Laravel adds around a directive's arguments, which
/// [`Checked::view_offset`] maps. Each piece of PHP becomes a statement that starts with `;` in place of its
/// delimiter: `{{ $a }}` reads `;[ $a ]`, a directive's arguments `;  [$a]` (an array, since they may be a list),
/// and `@php … @endphp` and `<?php … ?>` keep their code as is. `@foreach` keeps its keyword, as `;foreach (…)`,
/// and its body is a block from the next statement, which starts with `{` instead, to `@endforeach`, which reads
/// `;}`. Conditionals read as Laravel compiles them, in PHP's `if (…): … endif;` form, so they narrow types: the
/// next statement starts with `:`, `@if` and `@else` keep their keywords, `@isset($a)` reads `;     if(isset($a))`,
/// `@auth` reads `;    if(auth()->guard()->check())`, and `@endisset` reads `;endif`. `@switch`, `@case`, `@default`,
/// `@break`, and `@continue` keep their keywords too. Unlike [`virtual_php`], it reads every directive, loop, and
/// component attribute, to check them all.
///
/// `vars`, the view's variables with their docblock types, are declared on the first line, so Mago checks their
/// uses. Blocks that don't nest, such as an `@if` without its `@endif`, read as their arguments only, and [`pair`]
/// marks the ranges around them as unsure.
pub fn checked_php(text: &str, vars: &[(String, String)]) -> Checked {
    let src = text.as_bytes();
    let mut out: Vec<u8> = src.iter().map(|b| if matches!(b, b'\n' | b'\r') { *b } else { b' ' }).collect();
    let put = |out: &mut Vec<u8>, at: usize, s: &[u8]| out[at..at + s.len()].copy_from_slice(s);
    let keep = |out: &mut Vec<u8>, from: usize, to: usize| {
        if from < to {
            out[from..to].copy_from_slice(&src[from..to]);
        }
    };
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let pieces = pieces(src);
    let directives: Vec<_> = pieces
        .iter()
        .enumerate()
        .filter_map(|(k, p)| {
            let Piece::Directive { at, name, end, .. } = p else { return None };
            // A `switch`'s first statement must be a case, so a `@switch` with anything else first is left unpaired.
            let cases = name != "switch"
                || matches!(pieces.get(k + 1), Some(Piece::Directive { name, end, .. }) if matches!(name.as_str(), "default" | "endswitch") || (name == "case" && end.is_some()));
            Some((*at, name.as_str(), end.is_some() && cases))
        })
        .collect();
    let (paired, mut unsure) = pair(&directives, src.len());
    // PHP to add, by the view offset it goes before.
    let mut adds: Vec<(usize, String)> = vec![];
    let mut imports: Vec<String> = vec![];
    // The paired blocks open around a piece, by their directive's name, with where the branch a user is logged in
    // for started and whether a conditional is past its `@else`, and what starts the next statement when it's the
    // first in a loop's body (`{`) or a conditional's branch (`:`).
    let mut blocks: Vec<(&str, Option<usize>, bool)> = vec![];
    let mut authed = vec![];
    let mut pending: Option<u8> = None;
    for piece in &pieces {
        match *piece {
            Piece::Echo { at, from, end } => {
                lead(&mut out, at, &mut pending);
                out[at + 1] = b'[';
                keep(&mut out, from, end);
                out[end] = b']';
            }
            Piece::Php { at, from, end } => {
                lead(&mut out, at, &mut pending);
                keep(&mut out, from, end);
                if end < src.len() {
                    out[end] = b';';
                }
            }
            Piece::Directive { at: i, ref name, name_end, open, end } => {
                let name = name.as_str();
                let top = blocks.last().map(|b| b.0);
                // A branch after `@else` isn't PHP.
                let in_cond = blocks.last().is_some_and(|b| block(b.0) == Some(Block::Cond) && !b.2);
                // The loop or `@switch` a `@break` ends.
                let breaks = blocks.iter().rev().find_map(|b| match block(b.0) {
                    Some(Block::Loop) | Some(Block::Switch) => Some(b.0),
                    _ => None,
                });
                let mut args = true;
                if paired.contains(&i) && name.starts_with("end") {
                    let (opened, logged_in, _) = blocks.pop().unwrap_or_default();
                    if let Some(from) = logged_in {
                        authed.push(from..i);
                    }
                    match block(opened) {
                        Some(Block::Loop) => put(&mut out, i, if pending.take().is_some() { b"{}" } else { b";}" }),
                        Some(Block::Cond) => {
                            lead(&mut out, i, &mut pending);
                            put(&mut out, i + 1, b"endif");
                        }
                        Some(Block::Switch) => {
                            lead(&mut out, i, &mut pending);
                            keep(&mut out, i + 1, name_end);
                        }
                        _ => {}
                    }
                    continue;
                }
                let opens = paired.contains(&i);
                match name {
                    _ if opens && block(name) == Some(Block::Loop) => {
                        put(&mut out, i, if name == "forelse" { b";foreach" } else { b";" });
                        lead(&mut out, i, &mut pending);
                        if name != "forelse" {
                            keep(&mut out, i + 1, name_end);
                        }
                        keep(&mut out, open, end.unwrap_or(open));
                        // The statements up to the loop's end are its body, which the next statement opens.
                        pending = Some(b'{');
                        args = false;
                    }
                    "switch" if opens => {
                        lead(&mut out, i, &mut pending);
                        keep(&mut out, i + 1, name_end);
                        keep(&mut out, open, end.unwrap_or(open));
                        pending = Some(b':');
                        args = false;
                    }
                    "else" | "elseif" | "elseauth" | "elseguest" | "elsecan" | "elsecannot" | "elsecanany" if in_cond && (end.is_some() || !matches!(name, "elseif" | "elsecan" | "elsecannot" | "elsecanany")) => {
                        if let Some(b) = blocks.last_mut() {
                            if let Some(from) = b.1.take() {
                                authed.push(from..i);
                            }
                            // `@guest`'s `@else` is for a logged-in user.
                            b.1 = (name == "elseauth" || (name == "else" && b.0 == "guest")).then_some(i);
                            b.2 = name == "else";
                        }
                        condition(src, &mut out, &mut adds, &mut pending, i, name, name_end, open, end);
                        args = false;
                    }
                    "case" | "default" if top == Some("switch") && (name == "default") == end.is_none() => {
                        lead(&mut out, i, &mut pending);
                        keep(&mut out, i + 1, name_end);
                        keep(&mut out, open, end.unwrap_or(open));
                        pending = Some(b':');
                        args = false;
                    }
                    // `@empty` without arguments ends a `@forelse`'s loop, and starts what it shows for no items.
                    "empty" if end.is_none() && top == Some("forelse") => {
                        put(&mut out, i, if pending.take().is_some() { b"{}" } else { b";}" });
                        if let Some(b) = blocks.last_mut() {
                            b.0 = "forelse-empty";
                        }
                    }
                    // `continue` in a `switch` acts as `break`, with a warning, so it's left out there.
                    "break" | "continue" if breaks.is_some_and(|b| name == "break" || b != "switch") => {
                        lead(&mut out, i, &mut pending);
                        match end {
                            // `@break($a)` is `if($a) break;`, with a `;` of its own, so an `@else` after it isn't the `if`'s.
                            Some(end) => {
                                adds.push((open, "if".into()));
                                keep(&mut out, open, end);
                                adds.push((end, format!(" {name};")));
                            }
                            None => keep(&mut out, i + 1, name_end),
                        }
                        args = false;
                    }
                    "use" => {
                        // @use('App\Models\Post', 'P') imports a class, as `use` at the top of a file.
                        let mut quoted = vec![];
                        let mut rest = &text[open..end.unwrap_or(open)];
                        while let Some(q) = rest.find(['\'', '"']) {
                            let quote = &rest[q..q + 1];
                            let Some(len) = rest[q + 1..].find(quote) else { break };
                            quoted.push(&rest[q + 1..q + 1 + len]);
                            rest = &rest[q + 2 + len..];
                        }
                        if let Some(class) = quoted.first().filter(|c| !c.is_empty()) {
                            let alias = quoted.get(1).filter(|a| !a.is_empty()).map(|a| format!(" as {a}")).unwrap_or_default();
                            imports.push(format!("use {}{alias};", class.trim_start_matches('\\')));
                        }
                        args = false;
                    }
                    _ if opens && block(name) == Some(Block::Cond) => {
                        condition(src, &mut out, &mut adds, &mut pending, i, name, name_end, open, end);
                        args = false;
                    }
                    // A loop's arguments, such as `$a as $b`, aren't an expression.
                    _ if block(name) == Some(Block::Loop) => args = false,
                    _ => {}
                }
                if opens {
                    blocks.push((name, (name == "auth").then_some(i), false));
                }
                if let Some(end) = end.filter(|_| args) {
                    lead(&mut out, i, &mut pending);
                    out[open] = b'[';
                    keep(&mut out, open + 1, end - 1);
                    out[end - 1] = b']';
                }
            }
            Piece::Tag(i) => {
                // A component's bound attributes, such as :title="$post->title", hold PHP. ::title is Alpine's, escaped.
                let mut end = i;
                let mut quote = None;
                while end < src.len() && (quote.is_some() || src[end] != b'>') {
                    match quote {
                        Some(q) if src[end] == q => quote = None,
                        None if matches!(src[end], b'"' | b'\'') => quote = Some(src[end]),
                        _ => {}
                    }
                    end += 1;
                }
                let mut p = i;
                while p + 1 < end {
                    let bound = src[p].is_ascii_whitespace() && src[p + 1] == b':' && src.get(p + 2) != Some(&b':');
                    // :$post is short for :post="$post".
                    if bound && src.get(p + 2) == Some(&b'$') {
                        let name = p + 3 + src[p + 3..end].iter().take_while(|b| word(**b)).count();
                        if name > p + 3 && name < src.len() {
                            lead(&mut out, p, &mut pending);
                            out[p + 1] = b'[';
                            keep(&mut out, p + 2, name);
                            out[name] = b']';
                        }
                        p = name;
                        continue;
                    }
                    let name = p + 2 + src[p + 2..end].iter().take_while(|b| word(**b) || matches!(b, b'-' | b':' | b'.')).count();
                    let eq = name + src[name..end].iter().take_while(|b| b.is_ascii_whitespace()).count();
                    if !bound || name == p + 2 || src.get(eq) != Some(&b'=') {
                        p += 1;
                        continue;
                    }
                    let q = eq + 1 + src[eq + 1..end].iter().take_while(|b| b.is_ascii_whitespace()).count();
                    let Some(close) = src.get(q).filter(|b| matches!(b, b'"' | b'\'')).and_then(|b| find(src, q + 1, &[*b])) else {
                        p += 1;
                        continue;
                    };
                    lead(&mut out, eq, &mut pending);
                    out[q] = b'[';
                    keep(&mut out, q + 1, close);
                    out[close] = b']';
                    p = close + 1;
                }
            }
        }
    }
    // `@var` on an assignment types each variable; the `$x` read before it is undefined, which isn't reported.
    let vars: String = vars.iter().map(|(name, t)| format!(" /** @var {t} ${name} */ ${name} = ${name};")).collect();
    let head = format!("<?php {}{vars}\n", imports.join(" "));
    // A loop left open at the end is closed there, as one being typed.
    let loops = blocks.iter().filter(|b| block(b.0) == Some(Block::Loop)).count();
    let tail = format!("{}{}", if pending.is_some() { "{" } else { ";" }, "}".repeat(loops));
    adds.sort_by_key(|(at, _)| *at);
    let mut php = head.clone();
    let mut from = 0;
    for (at, add) in &adds {
        php.push_str(std::str::from_utf8(&out[from..*at]).unwrap_or_default());
        php.push_str(add);
        from = *at;
    }
    php.push_str(std::str::from_utf8(&out[from..]).unwrap_or_default());
    php.push_str(&tail);
    unsure.sort_by_key(|r| r.start);
    Checked { php, head: head.len(), added: adds.iter().map(|(at, add)| (*at, add.len())).collect(), unsure, authed }
}

/// A piece of a Blade view that holds PHP, from [`pieces`].
enum Piece {
    /// `{{ … }}` or `{!! … !!}`: where its statement starts, which is a byte before its PHP, and the PHP's range.
    Echo { at: usize, from: usize, end: usize },
    /// `@php … @endphp` or `<?php … ?>`: where it starts, and its code's range.
    Php { at: usize, from: usize, end: usize },
    /// A directive at `at`, by its name in lowercase, as Laravel's are matched, where the name ends, and where its
    /// arguments' `(` is and the offset after their `)`, if it has them.
    Directive { at: usize, name: String, name_end: usize, open: usize, end: Option<usize> },
    /// A component tag, from its `<`.
    Tag(usize),
}

/// The pieces of `src`, a Blade view, that hold PHP, in order. An echo or `@php` left open ends them.
fn pieces(src: &[u8]) -> Vec<Piece> {
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let at_word = |i: usize, w: &[u8]| src[i..].starts_with(w) && !src.get(i + w.len()).is_some_and(|b| word(*b));
    let mut out = vec![];
    let mut i = 0;
    while i < src.len() {
        let rest = &src[i..];
        if rest.starts_with(b"{{--") {
            i = find(src, i, b"--}}").map_or(src.len(), |e| e + 4);
        } else if rest.starts_with(b"@{{") || rest.starts_with(b"@@") {
            i += 2;
        } else if rest.starts_with(b"{{") || rest.starts_with(b"{!!") {
            let raw = rest[1] == b'!';
            let Some(end) = find(src, i, if raw { b"!!}" } else { b"}}" }) else { break };
            out.push(Piece::Echo { at: if raw { i + 1 } else { i }, from: i + if raw { 3 } else { 2 }, end });
            i = end + if raw { 3 } else { 2 };
        } else if at_word(i, b"<?php") || (at_word(i, b"@php") && src[i + 4..].iter().find(|b| !b.is_ascii_whitespace()) != Some(&b'(')) {
            let php = rest[0] == b'@';
            // A PHP file may leave out ?>.
            let end = match find(src, i, if php { b"@endphp" } else { b"?>" }) {
                Some(end) => end,
                None if php => break,
                None => src.len(),
            };
            out.push(Piece::Php { at: i, from: i + if php { 4 } else { 5 }, end });
            i = end + if php { 7 } else { 2 };
        } else if at_word(i, b"@verbatim") {
            i = find(src, i, b"@endverbatim").map_or(src.len(), |e| e + 12);
        } else if rest[0] == b'@' && !(i > 0 && word(src[i - 1])) {
            let name_end = i + 1 + src[i + 1..].iter().take_while(|b| word(**b)).count();
            let name = std::str::from_utf8(&src[i + 1..name_end]).unwrap_or("");
            let open = name_end + src[name_end..].iter().take_while(|b| matches!(b, b' ' | b'\t')).count();
            let end = (name_end > i + 1 && src.get(open) == Some(&b'(') && PHP_DIRECTIVES.contains(&name)).then(|| matching_paren(src, open)).flatten().map(|e| e + 1);
            if name_end > i + 1 {
                out.push(Piece::Directive { at: i, name: name.to_ascii_lowercase(), name_end, open, end });
            }
            i = end.unwrap_or(name_end.max(i + 1));
        } else if rest.starts_with(b"<x-") || rest.starts_with(b"<x:") {
            out.push(Piece::Tag(i));
            i += 2;
        } else {
            i += 1;
        }
    }
    out
}

/// The kinds of blocks directives open.
#[derive(Clone, Copy, PartialEq)]
enum Block {
    /// A conditional, which any `@end…` of one ends, since all compile to `endif;`.
    Cond,
    Loop,
    Switch,
    /// A directive Tusk doesn't know, such as a `Blade::if()`, from `@name` or `@unlessname` to `@endname`.
    Guard,
}

/// The block a directive opens, by its name in lowercase, if it's one of Laravel's.
fn block(name: &str) -> Option<Block> {
    match name {
        "if" | "unless" | "isset" | "empty" | "auth" | "guest" | "can" | "cannot" | "canany" | "env" | "production" | "hassection" | "sectionmissing" | "hasstack" => Some(Block::Cond),
        "foreach" | "forelse" | "for" | "while" => Some(Block::Loop),
        "switch" => Some(Block::Switch),
        _ => None,
    }
}

/// Blocks that compile to no PHP block, such as `@section … @endsection`, which are left unpaired.
const UNPAIRED: &[&str] = &[
    "section", "show", "stop", "append", "overwrite", "push", "prepend", "pushonce", "prependonce", "once", "fragment",
    "component", "componentfirst", "slot", "php", "verbatim", "persist", "teleport", "script", "assets",
];

/// What any conditional's end compiles to `endif;` from.
const COND_ENDS: &[&str] = &["endif", "endunless", "endisset", "endempty", "endauth", "endguest", "endcan", "endcannot", "endcanany", "endenv", "endproduction"];

/// Pairs the blocks `directives` open and end, by their offsets, names, and whether they have arguments, as Laravel's
/// compiled PHP pairs them: the offsets of the directives that open and end blocks that nest, and the ranges of the
/// view, `len` long, where "possibly null" problems can't be trusted. Those are the bodies of `@switch`, whose cases
/// Mago narrows only in part, and of directives it doesn't know; from a block left unpaired to what ends the block
/// around it, or the view's end; and from the start of the block around an `@end…` that ends none to it, since what
/// it ends wasn't read. A loop left open at the end is paired, as one being typed.
fn pair(directives: &[(usize, &str, bool)], len: usize) -> (std::collections::HashSet<usize>, Vec<Range<usize>>) {
    let last: std::collections::HashMap<&str, usize> = directives.iter().enumerate().filter(|(_, d)| d.1.starts_with("end")).map(|(k, d)| (d.1, k)).collect();
    let mut paired = std::collections::HashSet::new();
    let mut unsure = vec![];
    // The blocks open, by their kind, name, and offset.
    let mut open: Vec<(Block, &str, usize)> = vec![];
    for (k, &(at, name, args)) in directives.iter().enumerate() {
        if UNPAIRED.contains(&name.strip_prefix("end").unwrap_or(name)) {
            continue;
        }
        let opens = match block(name) {
            // `@auth` and `@guest` may leave out their arguments, and `@production` has none.
            Some(Block::Cond) => match name {
                "auth" | "guest" => true,
                "production" => !args,
                _ => args,
            }
            .then_some((Block::Cond, name)),
            Some(b) => args.then_some((b, name)),
            None if name.starts_with("end") || name.starts_with("else") => None,
            None => [name, name.strip_prefix("unless").unwrap_or("")]
                .into_iter()
                .find(|n| !n.is_empty() && last.get(format!("end{n}").as_str()).is_some_and(|e| *e > k))
                .map(|n| (Block::Guard, n)),
        };
        if let Some((b, n)) = opens {
            open.push((b, n, at));
            continue;
        }
        if !name.starts_with("end") {
            continue;
        }
        let ends = |(b, n, _): &(Block, &str, usize)| if *b == Block::Cond { COND_ENDS.contains(&name) } else { name.strip_prefix("end") == Some(n) };
        match open.iter().rposition(ends) {
            Some(p) => {
                unsure.extend(open.drain(p + 1..).map(|(_, _, from)| from..at));
                let (b, _, from) = open.pop().unwrap_or((Block::Guard, "", at));
                paired.extend([from, at]);
                if matches!(b, Block::Switch | Block::Guard) {
                    unsure.push(from..at);
                }
            }
            None => unsure.push(open.last().map_or(0, |b| b.2)..at),
        }
    }
    for (b, _, from) in open {
        if b == Block::Loop {
            paired.insert(from);
        } else {
            unsure.push(from..len);
        }
    }
    (paired, unsure)
}

/// Lays out a conditional directive, `@isset(…)` or `@elseauth`, as Laravel compiles it, from `at`, where its name
/// ends, and its arguments' `(` and the offset after their `)`, if it has them. `@if`, `@elseif`, and `@else` keep
/// their keywords; the others' PHP is added around their arguments.
#[allow(clippy::too_many_arguments)]
fn condition(src: &[u8], out: &mut [u8], adds: &mut Vec<(usize, String)>, pending: &mut Option<u8>, at: usize, name: &str, name_end: usize, open: usize, end: Option<usize>) {
    const GATE: &str = "app(\\Illuminate\\Contracts\\Auth\\Access\\Gate::class)";
    let (keyword, before, after) = match name {
        "if" | "elseif" | "else" => (name, "", ""),
        "unless" => ("if", "!", ")"),
        "isset" | "empty" => ("if", if name == "isset" { "isset" } else { "empty" }, ")"),
        "auth" | "elseauth" => (if name == "auth" { "if" } else { "elseif" }, "auth()->guard", "->check())"),
        "guest" | "elseguest" => (if name == "guest" { "if" } else { "elseif" }, "auth()->guard", "->guest())"),
        "can" | "elsecan" => (if name == "can" { "if" } else { "elseif" }, "$gate->check", ")"),
        "cannot" | "elsecannot" => (if name == "cannot" { "if" } else { "elseif" }, "$gate->denies", ")"),
        "canany" | "elsecanany" => (if name == "canany" { "if" } else { "elseif" }, "$gate->any", ")"),
        "env" => ("if", "app()->environment", ")"),
        "production" => ("if", "app()->environment('production'", "))"),
        "hassection" => ("if", "! empty(trim($__env->yieldContent", ")))"),
        "sectionmissing" => ("if", "empty(trim($__env->yieldContent", ")))"),
        _ => ("if", "! $__env->isStackEmpty", ")"),
    };
    lead(out, at, pending);
    if let Some(end) = end {
        out[open..end].copy_from_slice(&src[open..end]);
    }
    if before.is_empty() {
        // `@if (…)` keeps its keyword, and its arguments are the condition's parentheses.
        out[at + 1..at + 1 + keyword.len()].copy_from_slice(keyword.as_bytes());
    } else {
        let mut add = format!("{keyword}({}", before.replace("$gate", GATE));
        // `@auth` and `@guest` may leave out the guard's name.
        if end.is_none() && name != "production" {
            add.push_str("()");
        }
        adds.push((if end.is_some() { open } else { name_end }, add));
        adds.push((end.unwrap_or(name_end), after.into()));
    }
    *pending = Some(b':');
}

/// Starts a statement at `at` with `;`, which ends the one before, or with what opens the block it's first in.
fn lead(out: &mut [u8], at: usize, pending: &mut Option<u8>) {
    out[at] = pending.take().unwrap_or(b';');
}

fn find(hay: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    hay.get(from..)?.windows(needle.len()).position(|w| w == needle).map(|p| p + from)
}

/// The `)` matching the `(` at `open`, skipping strings.
pub(super) fn matching_paren(src: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0;
    let mut quote = None;
    let mut i = open;
    while i < src.len() {
        let b = src[i];
        if let Some(q) = quote {
            if b == b'\\' {
                i += 1;
            } else if b == q {
                quote = None;
            }
        } else {
            match b {
                b'\'' | b'"' => quote = Some(b),
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }
    None
}

/// The directive a call in [`virtual_php`] stands for: `_include` is `@include`.
pub fn directive_name(function: &str) -> Option<String> {
    let name = function.strip_prefix('_')?;
    let short = (name.len() == 1).then(|| SHORT.iter().position(|c| name.as_bytes()[0] == *c)).flatten();
    let name = short.map_or(name, |at| CALL_DIRECTIVES[at]);
    CALL_DIRECTIVES.contains(&name).then(|| format!("@{name}"))
}

/// The one-letter names [`virtual_php`] gives [`CALL_DIRECTIVES`], in order, to one that starts the view: `_b` for
/// `@includeIf`. One with a three-letter name, such as `@can`, has no room for it.
const SHORT: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/// A component or Livewire tag on a line: `(start, end, name)` for `<x-alert`, `<flux:button`, or
/// `<livewire:counter`, where the span covers the tag name without `<` and `name` drops `x-` and `livewire:`.
pub fn tags(line: &str, prefixes: &[String]) -> Vec<(usize, usize, String, bool)> {
    let mut out = vec![];
    let bytes = line.as_bytes();
    let mut i = 0;
    while let Some(lt) = line[i..].find('<').map(|p| p + i) {
        let mut start = lt + 1;
        if bytes.get(start) == Some(&b'/') {
            start += 1;
        }
        let end = start + line[start..].find(|c: char| c.is_whitespace() || c == '>' || c == '/').unwrap_or(line.len() - start);
        let tag = &line[start..end];
        if let Some(name) = tag.strip_prefix("livewire:") {
            out.push((start, end, name.to_string(), true));
        } else if let Some(name) = tag.strip_prefix("x-") {
            out.push((start, end, name.to_string(), false));
        } else if let Some((prefix, _)) = tag.split_once(':')
            && prefixes.iter().any(|p| p == prefix)
        {
            out.push((start, end, tag.to_string(), false));
        }
        i = lt + 1;
    }
    out
}

/// The text to insert, and where, to import `fqn` in a view with `@use('fqn')`, or `None` when a `@use` imports it
/// already. It goes among the `@use` lines at the view's top, in order, or else after the `@props` and `@aware`
/// lines that start the view, or else first. `@use` compiles to a `use` statement, which PHP refuses inside a
/// block, so the top is where it works.
pub fn use_insert(text: &str, fqn: &str) -> Option<(usize, String)> {
    let fqn = fqn.trim_start_matches('\\');
    let src = text.as_bytes();
    let blank = |from: usize| from + src[from..].iter().take_while(|b| matches!(b, b' ' | b'\t')).count();
    // The class a `@use` imports, as written: `@use('App\Models\Post', 'P')` imports `App\Models\Post`.
    let imported = |open: usize, close: usize| {
        let first = text[open + 1..close].split(',').next().unwrap_or_default().trim().trim_matches(['\'', '"']);
        first.trim_start_matches('\\').to_string()
    };
    for (at, _) in text.match_indices("@use") {
        let open = blank(at + 4);
        if (at == 0 || !src[at - 1].is_ascii_alphanumeric())
            && src.get(open) == Some(&b'(')
            && let Some(close) = matching_paren(src, open)
            && imported(open, close).eq_ignore_ascii_case(fqn)
        {
            return None;
        }
    }
    // The lines at the top that are `@use`, `@props`, or `@aware`, each with where it starts and ends, and the
    // class a `@use` imports.
    let mut lead: Vec<(usize, usize, Option<String>)> = vec![];
    let mut at = 0;
    loop {
        let start = blank(at);
        let Some(name) = ["@use", "@props", "@aware"].into_iter().find(|d| text[start..].starts_with(d)) else { break };
        let open = blank(start + name.len());
        let Some(close) = (src.get(open) == Some(&b'(')).then(|| matching_paren(src, open)).flatten() else { break };
        let end = text[close..].find('\n').map_or(text.len(), |n| close + n + 1);
        lead.push((at, end, (name == "@use").then(|| imported(open, close))));
        at = end;
    }
    let lower = fqn.to_ascii_lowercase();
    let uses: Vec<&(usize, usize, Option<String>)> = lead.iter().filter(|l| l.2.is_some()).collect();
    let at = match uses.iter().find(|(_, _, class)| class.as_ref().is_some_and(|c| c.to_ascii_lowercase() > lower)) {
        Some((start, _, _)) => *start,
        None => uses.last().copied().or(lead.last()).map_or(0, |(_, end, _)| *end),
    };
    // After a last line without a line break.
    if at == text.len() && at > 0 && !text.ends_with('\n') {
        return Some((at, format!("\n@use('{fqn}')")));
    }
    Some((at, format!("@use('{fqn}')\n")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_a_class_with_use_at_the_views_top() {
        let insert = |text: &str, fqn: &str| use_insert(text, fqn).map(|(at, new)| format!("{}{new}{}", &text[..at], &text[at..]));
        // First, after the lines that start a component, and among the imports in order.
        assert_eq!(insert("<div>{{ $a }}</div>\n", "App\\Post").unwrap(), "@use('App\\Post')\n<div>{{ $a }}</div>\n");
        assert_eq!(insert("@props([\n  'a' => 1,\n])\n<div></div>", "App\\Post").unwrap(), "@props([\n  'a' => 1,\n])\n@use('App\\Post')\n<div></div>");
        let uses = "@use('App\\Models\\A')\n@use('App\\Models\\C', 'C')\n@aware(['x'])\n<p></p>\n";
        assert_eq!(insert(uses, "App\\Models\\B").unwrap(), "@use('App\\Models\\A')\n@use('App\\Models\\B')\n@use('App\\Models\\C', 'C')\n@aware(['x'])\n<p></p>\n");
        assert_eq!(insert(uses, "\\Zed").unwrap(), "@use('App\\Models\\A')\n@use('App\\Models\\C', 'C')\n@use('Zed')\n@aware(['x'])\n<p></p>\n");
        assert_eq!(insert("@props(['a'])", "App\\Post").unwrap(), "@props(['a'])\n@use('App\\Post')");
        // Never twice, wherever the view imports it, and whatever its alias.
        assert!(use_insert(uses, "app\\models\\c").is_none());
        assert!(use_insert("<p>\n@use(\"\\App\\Post\")\n</p>", "App\\Post").is_none());
    }

    #[test]
    fn lays_out_echoes_and_directives_at_their_offsets() {
        let blade = "<div>\n  {{ route('home') }} @include('nav', ['a' => 1])\n  @foreach($xs as $x) {!! __('auth.failed') !!} @endforeach\n</div>";
        let php = virtual_php(blade, blade.len());
        assert_eq!(php.len(), blade.len());
        let at = |s: &str| blade.find(s).unwrap();
        assert_eq!(&php[at("route")..at("route") + 13], "route('home')");
        assert_eq!(&php[at("@include")..at("@include") + 15], "_include('nav',");
        assert!(!php.contains("foreach"));
        assert_eq!(&php[at("__(")..at("__(") + 18], "__('auth.failed') ");
        assert_eq!(php.lines().count(), blade.lines().count());
        assert_eq!(directive_name("_include").as_deref(), Some("@include"));
        assert_eq!(directive_name("__"), None);
        // A view that starts with a directive gets the tag in its place, and the directive a short name.
        let php = virtual_php("@extends('app')\n@section('x')", usize::MAX);
        assert_eq!(php, "<? _f   ('app')\n_section('x')");
        assert_eq!(directive_name("_f").as_deref(), Some("@extends"));
        assert_eq!(virtual_php("@can('x')", 9), "<?       ");
    }

    /// The checked PHP without its first line.
    fn body(blade: &str) -> String {
        let checked = checked_php(blade, &[]);
        checked.php[checked.head..].to_string()
    }

    #[test]
    fn checks_the_php_where_it_is_in_the_view_and_blanks_the_rest() {
        let blade = "<h1 class=\"{{ $a }}\">{!! $b !!}</h1>\n@if ($c && f(')'))\n  @foreach ($posts as $post) x @endforeach\n@endif\n@php $d = 1; @endphp";
        let php = body(blade);
        assert_eq!(php.len(), blade.len() + 1);
        assert_eq!(php, "           ;[ $a ]    ;[ $b ]       \n;if ($c && f(')'))\n  :foreach ($posts as $post)   {}         \n;endif\n;    $d = 1; ;      ;");
    }

    #[test]
    fn checks_directive_lists_loops_use_and_bound_component_attributes() {
        assert_eq!(body("@include('a', ['x' => 1])"), ";       ['a', ['x' => 1]];");
        assert_eq!(body("@forelse($a as $b) @empty @endforelse"), ";foreach($a as $b) {}                ;");
        // A loop's body is a block, so its variables keep their types in it; an unclosed one is closed at the end.
        assert_eq!(body("@foreach ($a as $b) {{ $b }} @endforeach"), ";foreach ($a as $b) {[ $b ]  ;}         ;");
        assert_eq!(body("@while($a) @php $a--; @endphp"), ";while($a) {    $a--; ;      ;}");
        assert_eq!(body("<x-card :post=\"$post\" ::alpine=\"x\" title=\"t\" />"), "             ;[$post]                          ;");
        assert_eq!(body("<x-card :$post/>"), "       ;[$post] ;");
        assert!(checked_php("@use('App\\Models\\Post', 'P')", &[]).php.starts_with("<?php use App\\Models\\Post as P;\n"));
    }

    #[test]
    fn reads_conditionals_as_laravel_compiles_them() {
        assert_eq!(body("@if($a) {{ $a }} @elseif($b) @else {{ $c }} @endif"), ";if($a) :[ $a ]  ;elseif($b) :else :[ $c ]  ;endif;");
        assert_eq!(
            body("@isset($a->b) {{ $a }} @endisset @unless($c) x @else y @endunless @empty($d) z @endempty"),
            ";     if(isset($a->b)) :[ $a ]  ;endif    ;      if(!($c))   :else   :endif     ;     if(empty($d))   :endif   ;"
        );
        // Any conditional's end ends any conditional, as all compile to `endif;`.
        assert_eq!(body("@isset($a) x @endif"), ";     if(isset($a))   :endif;");
        let gate = "app(\\Illuminate\\Contracts\\Auth\\Access\\Gate::class)";
        assert_eq!(
            body("@can('edit', $p) a @elsecan('view', $p) b @cannot('x') @endcannot @endcan"),
            format!(";   if({gate}->check('edit', $p))   :       elseif({gate}->check('view', $p))   :      if({gate}->denies('x')) :endif     ;endif ;")
        );
        assert_eq!(
            body("@env('local') a @endenv @production b @endproduction @hasSection('x') @endif @hasStack('s') @endif"),
            ";   if(app()->environment('local'))   :endif  ;          if(app()->environment('production'))   :endif         ;          if(! empty(trim($__env->yieldContent('x')))) :endif ;        if(! $__env->isStackEmpty('s')) :endif;"
        );
        // Offsets on either side of the PHP added for `@isset` map to the view.
        let blade = "@isset($a) {{ $a->b }} @endisset";
        let checked = checked_php(blade, &[]);
        let at = |s: &str| checked.php.find(s).unwrap();
        assert_eq!(checked.view_offset(at("$a)")), Ok(7));
        assert_eq!(checked.view_offset(at("$a->b")), Ok(blade.find("$a->b").unwrap()));
        assert_eq!(checked.view_offset(at("if(isset")), Err(6));
        assert_eq!(checked.php_offset(blade.find("$a->b").unwrap()), at("$a->b"));
    }

    #[test]
    fn marks_where_a_user_is_logged_in() {
        let blade = "@auth('admin') a @elseauth b @else c @endauth @guest d @elseguest('x') e @else f @endguest";
        let checked = checked_php(blade, &[]);
        assert_eq!(
            &checked.php[checked.head..],
            ";    if(auth()->guard('admin')->check())   :        elseif(auth()->guard()->check())   :else   :endif   ;     if(auth()->guard()->guest())   :         elseif(auth()->guard('x')->guest())   :else   :endif   ;"
        );
        assert_eq!(checked.authed, vec![0..17, 17..29, 73..81]);
        assert!(checked.unsure.is_empty());
    }

    #[test]
    fn reads_switch_break_and_continue() {
        let blade = "@switch($a) @case(1) x @break @case(2) y @break @default z @endswitch";
        let checked = checked_php(blade, &[]);
        assert_eq!(&checked.php[checked.head..], ";switch($a) :case(1)   :break ;case(2)   :break ;default   :endswitch;");
        // Mago narrows a case's value only in part.
        assert_eq!(checked.unsure, vec![0..59]);
        // `@continue` in a `@switch` acts as `@break`, so it's left out.
        assert_eq!(
            body("@foreach($a as $b) @break($b) @continue @switch($b) @case(1) @continue @break @endswitch @endforeach"),
            ";foreach($a as $b) {     if($b) break; ;continue ;switch($b) :case(1)           :break ;endswitch ;}         ;"
        );
        // Outside a loop or `@switch`, they're arguments or nothing.
        assert_eq!(body("@break @break($a) @continue @case(1) @default"), "       ;     [$a]           ;    [1]         ;");
        assert_eq!(body("@forelse($a as $b) {{ $b }} @empty none @endforelse"), ";foreach($a as $b) {[ $b ]  ;}                     ;");
    }

    #[test]
    #[allow(clippy::single_range_in_vec_init)]
    fn pairs_blocks_that_nest_and_marks_the_rest_unsure() {
        // `@else` belongs to the innermost block, here `@auth`.
        let blade = "@if($a) @auth {{ $a }} @else x @endauth @endif";
        let checked = checked_php(blade, &[]);
        assert_eq!(&checked.php[checked.head..], ";if($a) :    if(auth()->guard()->check()) :[ $a ]  ;else   :endif   ;endif;");
        assert_eq!(checked.authed, vec![8..23]);
        // A block left open reads as its arguments, unsure from it to the end of the block around it, and an `@end…`
        // that ends nothing makes the view unsure from the start of the block around it.
        let blade = "@if($a) @foreach($b as $c) @endif @endforeach {{ $d }}";
        let checked = checked_php(blade, &[]);
        assert_eq!(&checked.php[checked.head..], ";if($a)                    :endif             ;[ $d ] ;");
        assert_eq!(checked.unsure, vec![0..34, 8..27]);
        let checked = checked_php("@if($a) {{ $a }}", &[]);
        assert_eq!((&checked.php[checked.head..], checked.unsure), (";  [$a] ;[ $a ] ;", vec![0..16]));
        // A loop left open, as one being typed, is closed at the end.
        let checked = checked_php("@foreach($a as $b) @if($b)", &[]);
        assert_eq!((&checked.php[checked.head..], checked.unsure), (";foreach($a as $b) {  [$b];}", vec![19..26]));
        // A directive Tusk doesn't know, such as a `Blade::if()`, makes its body unsure, from `@name` or `@unlessname`.
        let checked = checked_php("@admin x @else y @endadmin @unlessadmin z @endadmin @error('f') {{ $message }} @enderror", &[]);
        assert_eq!(checked.unsure, vec![0..17, 27..42, 52..79]);
        // Without its own `@endadmin`, `@unlessadmin`'s `@endif` ends the `@if` early, and the second one ends nothing.
        let checked = checked_php("@if($a) @unlessadmin x @endif @endif", &[]);
        assert_eq!((&checked.php[checked.head..], checked.unsure), (";if($a)                :endif       ;", vec![0..30]));
        // Sections and stacks compile to calls, not blocks, so they're left out, even inline ones.
        let checked = checked_php("@section('title', 'x') @section('c') @if($a) @endif @endsection @push('s') @endpush", &[]);
        assert_eq!(&checked.php[checked.head..], ";       ['title', 'x'] ;       ['c'] ;if($a) :endif             ;    ['s']         ;");
        assert!(checked.unsure.is_empty());
    }

    #[test]
    fn leaves_comments_escapes_verbatim_and_unknown_directives_as_text() {
        for blade in ["{{-- {{ $a }} --}}", "@{{ vue }}", "@@if($a)", "@verbatim {{ $a }} @endverbatim", "@media (x: 1)", "a@if($x)"] {
            assert_eq!(body(blade).trim(), ";", "{blade}");
        }
    }

    /// Views of directives in any order, nested or not, as malformed or half-typed views have them, lay out as PHP
    /// that parses, at offsets that map back.
    #[test]
    fn lays_out_any_order_of_directives_as_php_that_parses() {
        let tokens = [
            "@if($a)", "@elseif($b)", "@else", "@endif", "@isset($c)", "@endisset", "@unless($d)", "@endunless", "@empty($e)", "@empty", "@endempty",
            "@auth", "@auth('w')", "@elseauth", "@endauth", "@guest", "@elseguest", "@endguest", "@can('x')", "@elsecan('y')", "@endcan", "@env('l')",
            "@endenv", "@production", "@endproduction", "@hasSection('s')", "@switch($s)", "@case(1)", "@default", "@break", "@break($x)", "@continue",
            "@continue($x)", "@endswitch", "@foreach($xs as $x)", "@endforeach", "@forelse($xs as $x)", "@endforelse", "@for($i = 0; $i < 1; $i++)",
            "@endfor", "@while($w)", "@endwhile", "@section('a')", "@endsection", "@admin", "@endadmin", "@unlessadmin", "@error('f')", "@enderror",
            "{{ $v }}", "x", "@php $z = 1; @endphp", "<x-a :b=\"$c\" />", "@endfoo", "@once", "@endonce", "@json($j)",
        ];
        let mut seed: u64 = 42;
        let mut next = |n: usize| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as usize) % n
        };
        for _ in 0..5000 {
            let view = (0..1 + next(20)).map(|_| tokens[next(tokens.len())]).collect::<Vec<_>>().join(" ");
            let checked = checked_php(&view, &[]);
            let arena = mago_allocator::LocalArena::new();
            let parsed = crate::analysis::Parsed::exact(&arena, std::path::Path::new("/a.php"), &checked.php);
            assert!(parsed.program.errors.is_empty(), "{view}\n{}", &checked.php[checked.head..]);
            assert!((0..=view.len()).all(|v| checked.view_offset(checked.php_offset(v)) == Ok(v)), "{view}");
        }
    }

    #[test]
    fn keeps_an_unfinished_directive() {
        let blade = "<p>\n@include('na\n</p>";
        let php = virtual_php(blade, blade.find("na").unwrap() + 2);
        assert!(php.ends_with("_include('na"), "{php:?}");
    }

    #[test]
    fn finds_component_tags() {
        let found = tags("<x-alert type=\"x\"/> <flux:button> </x-alert> <livewire:counter />", &["flux".into()]);
        let names: Vec<_> = found.iter().map(|t| (t.2.as_str(), t.3)).collect();
        assert_eq!(names, vec![("alert", false), ("flux:button", false), ("alert", false), ("counter", true)]);
        assert_eq!(found[0].0, 1);
    }
}

