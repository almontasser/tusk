//! Reads the Cachegrind profiles that Xdebug's profiler writes. In Rust because a long test's profile can be
//! gigabytes of text: streamed here, it never has to fit in memory, and it parses in seconds.
//!
//! Xdebug writes one block per call, when the call returns: `fn=` names the function, the next cost line is its
//! own time, and each `calls=` line is followed by the time of one call it made. Names are compressed: `(3) name`
//! defines id 3, and a later `(3)` refers to it. Time is in 10 ns units since Xdebug 3 (`Time_(10ns)`), and
//! microseconds before.
//!
//! A function's total time counts only its outermost calls, so recursion (direct, or through other functions as
//! in Laravel's middleware pipeline) isn't counted twice. Blocks come in post-order, so a block's callees are the
//! last blocks that no caller has claimed yet. Each block carries, per function, the total time of that function's
//! outermost calls in its subtree; a caller merges its callees' totals and sets its own.
//!
//! Functions refer to each other by index into `functions`; `src/cachegrind.ts` turns those into references.
use serde::Serialize;
use rustc_hash::FxHashMap;
use std::io::{BufRead, BufReader, Read};

#[derive(Serialize, Default)]
pub struct Function {
    name: String,
    /// The file that defines it, or "php:internal" for PHP's own functions.
    file: String,
    line: u32,
    calls: u64,
    /// Time in the function's own code, and including what it called, in milliseconds.
    #[serde(rename = "self")]
    own: f64,
    inclusive: f64,
    /// How much memory in use grew over its outermost calls, including what it called, in bytes.
    memory: f64,
    /// The functions it called: [function, calls, time].
    callees: Vec<(usize, u64, f64)>,
}

/// A node of the call tree: a function called along one path from the root, with every call on that path merged.
#[derive(Serialize)]
pub struct Node {
    #[serde(rename = "fn")]
    function: usize,
    calls: u64,
    time: f64,
    children: Vec<Node>,
}

/// [line, time, calls]
type Site = (u32, f64, u64);

#[derive(Serialize)]
pub struct Profile {
    command: String,
    functions: Vec<Function>,
    /// The script's total time in milliseconds.
    total: f64,
    /// The call tree's roots: {main}, and anything PHP ran after it, such as shutdown functions.
    tree: Vec<Node>,
    /// Time spent in calls made from each line, by file: [file, [[line, time, calls]]].
    sites: Vec<(String, Vec<Site>)>,
}

#[tauri::command]
pub async fn parse_profile(path: String) -> Result<Profile, String> {
    crate::blocking(move || {
        let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        let input: Box<dyn Read> = if path.ends_with(".gz") { Box::new(flate2::read::MultiGzDecoder::new(file)) } else { Box::new(file) };
        parse(BufReader::with_capacity(1 << 20, input)).map_err(|e| format!("{path}: {e}"))
    })
    .await
}

type Totals = FxHashMap<usize, (f64, f64)>;

struct Block {
    function: usize,
    time: f64,
    memory: f64,
    calls: usize,
    totals: Totals,
    node: Node,
}

#[derive(PartialEq)]
enum Expect {
    Nothing,
    Own,
    Call,
}

/// Parse state. Names are interned: files and functions are indexes, and Xdebug's compressed ids map to them.
#[derive(Default)]
struct Parser {
    files: Vec<String>,
    file_index: FxHashMap<Vec<u8>, usize>,
    file_ids: FxHashMap<u64, usize>,
    function_index: FxHashMap<Vec<u8>, usize>,
    function_ids: FxHashMap<u64, usize>,
    functions: Vec<Function>,
    /// Each function's file, as an index into `files`.
    function_files: Vec<Option<usize>>,
    edges: FxHashMap<(usize, usize), (u64, f64)>,
    sites: FxHashMap<(usize, u32), (f64, u64)>,
    unclaimed: Vec<Block>,
}

/// Splits `(3) name` into (Some(3), Some(name)), `(3)` into (Some(3), None), and anything else into (None, Some(it)).
fn compressed(value: &[u8]) -> (Option<u64>, Option<&[u8]>) {
    if let Some(rest) = value.strip_prefix(b"(") {
        if let Some(close) = rest.iter().position(|&b| b == b')') {
            let id = std::str::from_utf8(&rest[..close]).ok().filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).and_then(|s| s.parse().ok());
            match (id, &rest[close + 1..]) {
                (Some(id), []) => return (Some(id), None),
                (Some(id), [b' ', name @ ..]) => return (Some(id), Some(name)),
                _ => {}
            }
        }
    }
    (None, Some(value))
}

fn intern(index: &mut FxHashMap<Vec<u8>, usize>, name: &[u8], add: impl FnOnce(String) -> usize) -> usize {
    if let Some(&i) = index.get(name) {
        return i;
    }
    let i = add(String::from_utf8_lossy(name).into_owned());
    index.insert(name.to_vec(), i);
    i
}

impl Parser {
    fn function(&mut self, name: &[u8]) -> usize {
        let (functions, files) = (&mut self.functions, &mut self.function_files);
        intern(&mut self.function_index, name, |name| {
            functions.push(Function { name, ..Default::default() });
            files.push(None);
            functions.len() - 1
        })
    }

    fn file(&mut self, name: &[u8]) -> usize {
        let files = &mut self.files;
        intern(&mut self.file_index, name, |name| {
            files.push(name);
            files.len() - 1
        })
    }

    fn resolve_function(&mut self, value: &[u8]) -> usize {
        match compressed(value) {
            (Some(id), Some(name)) => {
                let f = self.function(name);
                self.function_ids.insert(id, f);
                f
            }
            (Some(id), None) => match self.function_ids.get(&id) {
                Some(&f) => f,
                None => self.function(b""),
            },
            (None, name) => self.function(name.unwrap_or_default()),
        }
    }

    fn resolve_file(&mut self, value: &[u8]) -> usize {
        match compressed(value) {
            (Some(id), Some(name)) => {
                let f = self.file(name);
                self.file_ids.insert(id, f);
                f
            }
            (Some(id), None) => match self.file_ids.get(&id) {
                Some(&f) => f,
                None => self.file(b""),
            },
            (None, name) => self.file(name.unwrap_or_default()),
        }
    }

    /// Claims the finished block's callees and records its function's time in its subtree.
    fn finish(&mut self, block: Option<Block>) {
        let Some(mut block) = block else { return };
        let mut callees = self.unclaimed.split_off(self.unclaimed.len().saturating_sub(block.calls));
        // Reuse the largest callee map, so deep call chains don't copy every map at every level.
        callees.sort_by_key(|c| std::cmp::Reverse(c.totals.len()));
        let mut nodes = Vec::with_capacity(callees.len());
        let mut totals = Totals::default();
        for (i, callee) in callees.into_iter().enumerate() {
            if i == 0 {
                totals = callee.totals;
            } else {
                for (f, (time, memory)) in callee.totals {
                    let t = totals.entry(f).or_insert((0.0, 0.0));
                    t.0 += time;
                    t.1 += memory;
                }
            }
            nodes.push(callee.node);
        }
        totals.insert(block.function, (block.time, block.memory));
        block.node = Node { function: block.function, calls: 1, time: block.time, children: vec![] };
        adopt(&mut block.node, nodes);
        block.totals = totals;
        self.unclaimed.push(block);
    }

    fn end(mut self, command: String) -> Profile {
        let mut root = Node { function: usize::MAX, calls: 0, time: 0.0, children: vec![] };
        let unclaimed = std::mem::take(&mut self.unclaimed);
        let mut nodes = Vec::with_capacity(unclaimed.len());
        for block in unclaimed {
            for (f, (time, memory)) in block.totals {
                self.functions[f].inclusive += time;
                self.functions[f].memory += memory;
            }
            nodes.push(block.node);
        }
        adopt(&mut root, nodes);
        for ((caller, callee), (calls, time)) in self.edges {
            self.functions[caller].callees.push((callee, calls, time));
        }
        for (function, file) in self.functions.iter_mut().zip(&self.function_files) {
            if let Some(file) = file {
                function.file = self.files[*file].clone();
            }
        }
        let total = match self.function_index.get(b"{main}".as_slice()) {
            Some(&main) => self.functions[main].inclusive,
            None => self.functions.iter().map(|f| f.inclusive).fold(0.0, f64::max),
        };
        let mut by_file: FxHashMap<usize, Vec<Site>> = FxHashMap::default();
        for ((file, line), (time, calls)) in self.sites {
            by_file.entry(file).or_default().push((line, time, calls));
        }
        let sites = by_file.into_iter().map(|(file, lines)| (self.files[file].clone(), lines)).collect();
        Profile { command, functions: self.functions, total, tree: root.children, sites }
    }
}

/// Adds call nodes under a parent, merging each into the parent's node for the same function, if it has one.
fn adopt(parent: &mut Node, nodes: Vec<Node>) {
    for node in nodes {
        // Most nodes have a few children, where a scan beats a map.
        match parent.children.iter_mut().find(|n| n.function == node.function) {
            None => parent.children.push(node),
            Some(same) => {
                same.calls += node.calls;
                same.time += node.time;
                adopt(same, node.children);
            }
        }
    }
}

fn number(field: Option<&[u8]>) -> f64 {
    field.and_then(|f| std::str::from_utf8(f).ok()).and_then(|s| s.parse().ok()).unwrap_or(0.0)
}

fn parse(mut input: impl BufRead) -> std::io::Result<Profile> {
    let mut p = Parser::default();
    let mut command = String::new();
    let mut scale = 1.0 / 1000.0; // microseconds to milliseconds
    let mut file: Option<usize> = None;
    let mut block: Option<Block> = None;
    let mut callee = 0;
    let mut expect = Expect::Nothing;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        if input.read_until(b'\n', &mut buf)? == 0 {
            break;
        }
        let mut line = buf.as_slice();
        while let [rest @ .., b'\n' | b'\r'] = line {
            line = rest;
        }
        let (key, value) = match line.iter().position(|&b| b == b'=') {
            Some(eq) if eq > 0 => (&line[..eq], &line[eq + 1..]),
            _ => (&b""[..], &b""[..]),
        };
        match key {
            b"fl" | b"fi" | b"fe" => {
                if key == b"fl" {
                    p.finish(block.take());
                }
                file = Some(p.resolve_file(value));
            }
            b"cfl" | b"cfi" => {
                p.resolve_file(value);
            }
            b"fn" => {
                p.finish(block.take());
                let f = p.resolve_function(value);
                if p.function_files[f].is_none() {
                    p.function_files[f] = file;
                }
                p.functions[f].calls += 1;
                block = Some(Block { function: f, time: 0.0, memory: 0.0, calls: 0, totals: Totals::default(), node: Node { function: f, calls: 0, time: 0.0, children: vec![] } });
                expect = Expect::Own;
            }
            b"cfn" => callee = p.resolve_function(value),
            b"calls" => expect = Expect::Call,
            _ if line.first().is_some_and(u8::is_ascii_digit) && block.is_some() => {
                let mut parts = line.split(|&b| b == b' ');
                let position = number(parts.next()) as u32;
                let cost = number(parts.next()) * scale;
                let memory = number(parts.next());
                let b = block.as_mut().unwrap();
                b.time += cost;
                b.memory += memory;
                if expect == Expect::Own {
                    let function = &mut p.functions[b.function];
                    function.own += cost;
                    if function.line == 0 {
                        function.line = position;
                    }
                } else if expect == Expect::Call {
                    if let Some(file) = p.function_files[b.function] {
                        let site = p.sites.entry((file, position)).or_insert((0.0, 0));
                        site.0 += cost;
                        site.1 += 1;
                    }
                    b.calls += 1;
                    let call = p.edges.entry((b.function, callee)).or_insert((0, 0.0));
                    call.0 += 1;
                    call.1 += cost;
                }
                expect = Expect::Nothing;
            }
            _ if line.starts_with(b"cmd: ") => command = String::from_utf8_lossy(&line[5..]).into_owned(),
            _ if line.starts_with(b"events: ") && line.windows(11).any(|w| w == b"Time_(10ns)") => scale = 1.0 / 100_000.0,
            _ if line.starts_with(b"summary:") => p.finish(block.take()),
            _ => {}
        }
    }
    p.finish(block.take());
    Ok(p.end(command))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(text: &str) -> Profile {
        parse(text.as_bytes()).unwrap()
    }
    fn get<'a>(p: &'a Profile, name: &str) -> &'a Function {
        p.functions.iter().find(|f| f.name == name).unwrap()
    }
    fn index(p: &Profile, name: &str) -> usize {
        p.functions.iter().position(|f| f.name == name).unwrap()
    }
    fn close(actual: f64, expected: f64) {
        assert!((actual - expected).abs() < 1e-9, "{actual} ≠ {expected}");
    }
    const FIXTURE: &str = include_str!("profile.fixture.txt");

    #[test]
    fn reads_calls_self_and_total_time() {
        let p = profile(FIXTURE);
        assert_eq!(p.command, "/app/demo.php");
        let greet = get(&p, "Greeter->greet");
        assert_eq!((greet.calls, greet.file.as_str(), greet.line), (3, "/app/demo.php", 4));
        assert_eq!(get(&p, "php::strtoupper").file, "php:internal");
        close(greet.own, (658.0 + 158.0 + 53.0) / 100_000.0);
        close(greet.inclusive, (658.0 + 42.0 + 146.0 + 158.0 + 8.0 + 4.0 + 53.0 + 4.0 + 1.0) / 100_000.0);
        close(p.total, (2817.0 + 846.0 + 171.0 + 58.0 + 754.0) / 100_000.0);
    }

    #[test]
    fn counts_recursion_once() {
        let p = profile(FIXTURE);
        let fib = get(&p, "fib");
        assert_eq!(fib.calls, 15);
        // Only the outer fib(5) call counts, which {main} saw as 754 units (Xdebug times a call and its parts
        // separately, so they differ slightly).
        assert!((fib.inclusive - 754.0 / 100_000.0).abs() < 754.0 / 100_000.0 / 100.0);
    }

    #[test]
    fn counts_recursion_through_another_function_once() {
        // {main} calls a, a calls b, and b calls a again. Each block is written when its call returns.
        let p = profile(
            &["events: Time_(10ns)", "fl=(1) /x.php", "fn=(1) a", "1 10", "", "fl=(1)", "fn=(2) b", "1 20", "cfl=(1)", "cfn=(1)", "calls=1 0 0", "1 10", "", "fl=(1)", "fn=(1)", "1 30", "cfl=(1)", "cfn=(2)", "calls=1 0 0", "1 30", "", "fl=(1)", "fn=(3) {main}", "1 5", "cfl=(1)", "cfn=(1)", "calls=1 0 0", "1 60", ""]
                .join("\n"),
        );
        close(get(&p, "a").inclusive, 60.0 / 100_000.0); // The outer call only, not 60 + 10.
        close(get(&p, "b").inclusive, 30.0 / 100_000.0);
        close(get(&p, "a").own, 40.0 / 100_000.0);
        close(p.total, 65.0 / 100_000.0);
    }

    #[test]
    fn lists_callees() {
        let p = profile(FIXTURE);
        let mut callees: Vec<_> = get(&p, "Greeter->greet").callees.iter().map(|&(f, calls, _)| (p.functions[f].name.as_str(), calls)).collect();
        callees.sort();
        assert_eq!(callees, [("php::str_repeat", 3), ("php::strtoupper", 3)]);
        let upper = index(&p, "php::strtoupper");
        close(get(&p, "Greeter->greet").callees.iter().find(|c| c.0 == upper).unwrap().2, (42.0 + 8.0 + 4.0) / 100_000.0);
    }

    #[test]
    fn reads_memory_and_line_times() {
        let p = profile(FIXTURE);
        // Each Greeter->greet call grew memory by 48 bytes itself, and its two calls by 32 and 40.
        assert_eq!(get(&p, "Greeter->greet").memory, 3.0 * (48.0 + 32.0 + 40.0));
        let lines = &p.sites.iter().find(|(f, _)| f == "/app/demo.php").unwrap().1;
        let line5 = lines.iter().find(|l| l.0 == 5).unwrap();
        assert_eq!(line5.2, 6); // strtoupper and str_repeat, three times each
        close(line5.1, (42.0 + 146.0 + 8.0 + 4.0 + 4.0 + 1.0) / 100_000.0);
        assert_eq!(lines.iter().find(|l| l.0 == 9).unwrap().2, 3); // $g->greet() in the loop
    }

    #[test]
    fn keeps_the_call_tree_merging_calls_along_the_same_path() {
        let p = profile(FIXTURE);
        assert_eq!(p.tree.len(), 1);
        let main = &p.tree[0];
        assert_eq!(p.functions[main.function].name, "{main}");
        let greet = main.children.iter().find(|n| n.function == index(&p, "Greeter->greet")).unwrap();
        assert_eq!(greet.calls, 3);
        close(greet.time, (658.0 + 42.0 + 146.0 + 158.0 + 8.0 + 4.0 + 53.0 + 4.0 + 1.0) / 100_000.0);
        // fib(5) under {main}, then fib under fib, as deep as the recursion went.
        let fib = index(&p, "fib");
        let (mut depth, mut node) = (0, main.children.iter().find(|n| n.function == fib));
        while let Some(n) = node {
            depth += 1;
            node = n.children.iter().find(|c| c.function == fib);
        }
        assert_eq!(depth, 5);
    }
}
