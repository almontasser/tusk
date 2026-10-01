//! Blade views: the PHP in their echoes and directives, laid out as a PHP file at the same offsets, and the
//! component and Livewire tags, which are HTML rather than PHP.

/// Directives whose arguments name views, translations, or abilities, so they're read as calls. Others are
/// left out: `@foreach ($a as $b)` isn't a valid call and would only add parse errors.
const CALL_DIRECTIVES: &[&str] = &[
    "include", "includeIf", "includeWhen", "includeUnless", "includeFirst", "extends", "each", "component", "can",
    "cannot", "canany", "lang", "livewire", "method", "error", "section", "yield", "push", "stack", "props", "env",
    "json", "vite",
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
    let mut i = tag + 3;
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
            out[i] = b'_';
            copy(&mut out, i + 1, name_end);
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
    "section", "yield", "hasSection", "sectionMissing", "push", "pushIf", "prepend", "pushOnce", "prependOnce",
    "stack", "component", "slot", "props", "aware", "can", "cannot", "canany", "elsecan", "elsecannot",
    "elsecanany", "auth", "guest", "elseauth", "elseguest", "env", "production", "session", "context", "error",
    "method", "lang", "choice", "inject", "dd", "dump", "vite", "once", "fragment", "livewire", "use",
];

/// A Blade view as a PHP file for Mago's analyzer, the length of its first line, which holds `<?php` and the
/// view's `@use` imports, and the ranges of the view where "possibly null" problems can't be trusted. After the
/// first line comes the view with everything but its PHP blanked, so an offset past the first line, less its
/// length, is the view's. Each piece of PHP becomes a statement that starts with `;` in place of its delimiter:
/// `{{ $a }}` reads `;[ $a ]`, a directive's arguments `;  [$a]` (an array, since they may be a list), and
/// `@php … @endphp` and `<?php … ?>` keep their code as is. `@foreach` keeps its keyword, as `;foreach (…)`, and
/// its body is a block from the next statement, which starts with `{` instead, to `@endforeach`, which reads
/// `;}`. `@if` keeps its keyword too, in PHP's `if (…): … endif;` form, so it narrows types: the next statement
/// starts with `:`, `@elseif` and `@else` read `;elseif` and `;else`, and `@endif` reads `;endif`. Unlike
/// [`virtual_php`], it reads every directive, loop, and component attribute, to check them all.
///
/// `vars`, the view's variables with their docblock types, are declared on the first line, so Mago checks their
/// uses. The untrusted ranges are the bodies of blocks such as `@isset` and `@auth`, which guard what's in them
/// without narrowing, or the whole view when its `@if`s don't nest, which leaves them unread as branches.
pub fn checked_php(text: &str, vars: &[(String, String)]) -> (String, usize, Vec<std::ops::Range<usize>>) {
    laid_out(text, vars, true).unwrap_or_else(|| {
        let (php, head, _) = laid_out(text, vars, false).unwrap_or_default();
        (php, head, vec![0..text.len()])
    })
}

/// [`checked_php`], with `@if` read as a branch when `narrow`, or `None` when its blocks don't nest.
fn laid_out(text: &str, vars: &[(String, String)], narrow: bool) -> Option<(String, usize, Vec<std::ops::Range<usize>>)> {
    let src = text.as_bytes();
    let mut out: Vec<u8> = src.iter().map(|b| if matches!(b, b'\n' | b'\r') { *b } else { b' ' }).collect();
    let put = |out: &mut Vec<u8>, at: usize, s: &[u8]| out[at..at + s.len()].copy_from_slice(s);
    let keep = |out: &mut Vec<u8>, from: usize, to: usize| {
        if from < to {
            out[from..to].copy_from_slice(&src[from..to]);
        }
    };
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let at_word = |i: usize, w: &[u8]| src[i..].starts_with(w) && !src.get(i + w.len()).is_some_and(|b| word(*b));
    let mut imports: Vec<String> = vec![];
    // The blocks open around `i`, by their directive and offset, and what starts the next statement when it's the
    // first in a loop's body (`{`) or an `@if` branch (`:`).
    let mut blocks: Vec<(&str, usize)> = vec![];
    let mut pending: Option<u8> = None;
    let mut guarded = vec![];
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
            let at = if raw { i + 1 } else { i };
            lead(&mut out, at, &mut pending);
            out[at + 1] = b'[';
            keep(&mut out, i + if raw { 3 } else { 2 }, end);
            out[end] = b']';
            i = end + if raw { 3 } else { 2 };
        } else if at_word(i, b"<?php") || (at_word(i, b"@php") && src[i + 4..].iter().find(|b| !b.is_ascii_whitespace()) != Some(&b'(')) {
            let php = rest[0] == b'@';
            // A PHP file may leave out ?>.
            let end = match find(src, i, if php { b"@endphp" } else { b"?>" }) {
                Some(end) => end,
                None if php => break,
                None => src.len(),
            };
            lead(&mut out, i, &mut pending);
            keep(&mut out, i + if php { 4 } else { 5 }, end);
            if end < src.len() {
                out[end] = b';';
            }
            i = end + if php { 7 } else { 2 };
        } else if at_word(i, b"@verbatim") {
            i = find(src, i, b"@endverbatim").map_or(src.len(), |e| e + 12);
        } else if rest[0] == b'@' && !(i > 0 && word(src[i - 1])) {
            let name_end = i + 1 + src[i + 1..].iter().take_while(|b| word(**b)).count();
            let name = std::str::from_utf8(&src[i + 1..name_end]).unwrap_or("");
            let open = name_end + src[name_end..].iter().take_while(|b| matches!(b, b' ' | b'\t')).count();
            let end = (name_end > i + 1 && src.get(open) == Some(&b'(') && PHP_DIRECTIVES.contains(&name)).then(|| matching_paren(src, open)).flatten().map(|e| e + 1);
            let top = blocks.last().map(|b| b.0);
            // Whether `name` ends the innermost block: a loop's end, or `@empty` for a `@forelse`'s body, whose
            // `@empty` branch `@endforelse` ends; `@endif`, which also ends `@hasSection`; `@show` and the like for a
            // `@section`; and `@end…` for any other, such as `@endauth`.
            let closes = top.is_some_and(|top| match name {
                "empty" => end.is_none() && top == "forelse",
                "endforelse" => matches!(top, "forelse" | "forelse-empty"),
                "endif" => matches!(top, "if" | "hasSection" | "sectionMissing"),
                "show" | "stop" | "append" | "overwrite" => top == "section",
                _ => name.strip_prefix("end") == Some(top),
            });
            if closes {
                let (block, at) = blocks.pop().unwrap_or_default();
                match block {
                    "foreach" | "forelse" | "for" | "while" => {
                        put(&mut out, i, if pending.take().is_some() { b"{}" } else { b";}" });
                        if name == "empty" {
                            blocks.push(("forelse-empty", i));
                        }
                    }
                    "if" => {
                        lead(&mut out, i, &mut pending);
                        keep(&mut out, i + 1, name_end);
                    }
                    "forelse-empty" | "section" | "push" | "prepend" | "once" | "fragment" | "component" | "slot" => {}
                    // A guard, such as `@isset ($a->b)`, keeps `$a->b` possibly null inside.
                    _ => guarded.push(at..i),
                }
                i = name_end;
                continue;
            }
            if narrow && top == Some("if") && (name == "else" || (name == "elseif" && end.is_some())) {
                let to = end.unwrap_or(name_end);
                lead(&mut out, i, &mut pending);
                keep(&mut out, i + 1, to);
                pending = Some(b':');
                i = to;
                continue;
            }
            // An end that isn't the innermost block's, around an `@if`, means the blocks don't nest as read.
            if narrow && (name == "endif" || (top == Some("if") && name.starts_with("end"))) {
                return None;
            }
            // Any block opens, so `@else` is matched to its own: `@auth … @else … @endauth` too.
            let block = match name {
                "foreach" | "forelse" | "for" | "while" => end.is_some(),
                "if" => narrow && end.is_some(),
                "hasSection" | "sectionMissing" => narrow,
                "php" | "else" | "elseif" => false,
                _ => narrow && find(src, name_end, format!("@end{name}").as_bytes()).is_some(),
            };
            if block {
                blocks.push((name, i));
            }
            let Some(end) = end else {
                i = name_end;
                continue;
            };
            if name == "use" {
                // @use('App\Models\Post', 'P') imports a class, as `use` at the top of a file.
                let args = &text[open..end];
                let mut quoted = vec![];
                let mut rest = args;
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
            } else if matches!(name, "foreach" | "forelse" | "for" | "while") || name == "if" && narrow {
                put(&mut out, i, if name == "forelse" { b";foreach" } else { b";" });
                lead(&mut out, i, &mut pending);
                if name != "forelse" {
                    keep(&mut out, i + 1, name_end);
                }
                keep(&mut out, open, end);
                // The statements up to the block's end are its body, which the next statement opens.
                pending = Some(if name == "if" { b':' } else { b'{' });
            } else {
                lead(&mut out, i, &mut pending);
                out[open] = b'[';
                keep(&mut out, open + 1, end - 1);
                out[end - 1] = b']';
            }
            i = end;
        } else if rest.starts_with(b"<x-") || rest.starts_with(b"<x:") {
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
            i += 2;
        } else {
            i += 1;
        }
    }
    // `@var` on an assignment types each variable; the `$x` read before it is undefined, which isn't reported.
    let vars: String = vars.iter().map(|(name, t)| format!(" /** @var {t} ${name} */ ${name} = ${name};")).collect();
    let head = format!("<?php {}{vars}\n", imports.join(" "));
    if blocks.iter().any(|b| b.0 == "if") {
        return None;
    }
    let loops = blocks.iter().filter(|b| matches!(b.0, "foreach" | "forelse" | "for" | "while")).count();
    let tail = format!("{}{}", if pending.is_some() { "{" } else { ";" }, "}".repeat(loops));
    Some((format!("{head}{}{tail}", String::from_utf8(out).unwrap_or_default()), head.len(), guarded))
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
    CALL_DIRECTIVES.contains(&name).then(|| format!("@{name}"))
}

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

#[cfg(test)]
mod tests {
    use super::*;

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
    }

    /// The checked PHP without its first line.
    fn body(blade: &str) -> String {
        let (php, head, _) = checked_php(blade, &[]);
        php[head..].to_string()
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
        assert!(checked_php("@use('App\\Models\\Post', 'P')", &[]).0.starts_with("<?php use App\\Models\\Post as P;\n"));
    }

    #[test]
    fn reads_if_as_branches_and_marks_guarded_bodies() {
        assert_eq!(body("@if($a) {{ $a }} @elseif($b) @else {{ $c }} @endif"), ";if($a) :[ $a ]  ;elseif($b) :else :[ $c ]  ;endif;");
        // `@else` belongs to the innermost block, here `@auth`, whose body is guarded.
        let blade = "@if($a) @auth {{ $a }} @else x @endauth @endif";
        let (php, head, guarded) = checked_php(blade, &[]);
        assert_eq!(&php[head..], ";if($a)       :[ $a ]                   ;endif;");
        assert_eq!(guarded, vec![8..31]);
        // Blocks that don't nest leave `@if` as an expression, and the whole view guarded.
        let blade = "@if($a) @foreach($b as $c) @endif @endforeach";
        let (php, head, guarded) = checked_php(blade, &[]);
        assert_eq!(&php[head..], ";  [$a] ;foreach($b as $c)        {}         ;");
        assert_eq!(guarded, vec![0..blade.len()]);
        assert_eq!(checked_php("@if($a)", &[]).2, vec![0..7]);
    }

    #[test]
    fn leaves_comments_escapes_verbatim_and_unknown_directives_as_text() {
        for blade in ["{{-- {{ $a }} --}}", "@{{ vue }}", "@@if($a)", "@verbatim {{ $a }} @endverbatim", "@media (x: 1)", "a@if($x)"] {
            assert_eq!(body(blade).trim(), ";", "{blade}");
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

