//! Blade views: the PHP in their echoes and directives, laid out as a PHP file at the same offsets, and the
//! component and Livewire tags, which are HTML rather than PHP.

/// Directives whose arguments name views, translations, or abilities, so they're read as calls. Others are
/// left out: `@foreach ($a as $b)` isn't a valid call and would only add parse errors.
const CALL_DIRECTIVES: &[&str] = &[
    "include", "includeIf", "includeWhen", "includeUnless", "includeFirst", "extends", "each", "component", "can",
    "cannot", "canany", "lang", "livewire", "method", "error", "section", "yield", "push", "stack", "props", "env",
    "json",
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

fn find(hay: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    hay.get(from..)?.windows(needle.len()).position(|w| w == needle).map(|p| p + from)
}

/// The `)` matching the `(` at `open`, skipping strings.
fn matching_paren(src: &[u8], open: usize) -> Option<usize> {
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
