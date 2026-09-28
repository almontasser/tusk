use grep::matcher::Matcher;
use grep::regex::{RegexMatcher, RegexMatcherBuilder};
use grep::searcher::{sinks::UTF8, Searcher};
use ignore::{overrides::OverrideBuilder, WalkBuilder};
use serde::{Deserialize, Serialize};

/// The default most matches; Find in Files and TODO pass the Limits setting.
const MAX_MATCHES: usize = 20_000;

/// Walks the project like ripgrep: respects .gitignore (even outside a git repo),
/// includes dotfiles, and skips .git. `include` is a comma-separated list of globs,
/// such as `*.php, *.blade.php`; empty means every file. With `all`, ignored files
/// such as vendor count too.
fn walk(root: &str, include: &str, all: bool) -> Result<impl Iterator<Item = ignore::DirEntry>, String> {
    let mut overrides = OverrideBuilder::new(root);
    for glob in include.split(',').map(str::trim).filter(|g| !g.is_empty()) {
        overrides.add(glob).map_err(|e| e.to_string())?;
    }
    Ok(WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .git_ignore(!all)
        .git_exclude(!all)
        .ignore(!all)
        .overrides(overrides.build().map_err(|e| e.to_string())?)
        .filter_entry(|e| e.file_name() != ".git")
        .build()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_some_and(|t| t.is_file())))
}

/// Project files as paths relative to `root`. With `all`, files that .gitignore excludes too.
#[tauri::command]
pub async fn list_files(root: String, all: Option<bool>) -> Vec<String> {
    crate::blocking(move || {
        Ok(walk(&root, "", all.unwrap_or(false))
            .map(|files| files.filter_map(|e| e.path().strip_prefix(&root).ok().map(|p| p.to_string_lossy().into())).collect())
            .unwrap_or_default())
    })
    .await
    .unwrap_or_default()
}

/// A folder of PHP files that declare nothing, relative to the project, with its PHP files' count and size.
#[derive(Serialize)]
pub struct Folder {
    path: String,
    files: usize,
    bytes: u64,
}

/// The topmost folders in `vendor` whose PHP files declare no class, function, or constant, such as data arrays
/// and translations, at 100 KB or more, largest first: what the index can skip without losing a symbol. Test
/// folders and `vendor/composer` are left out, since the index skips them already.
#[tauri::command]
pub async fn symbol_free_folders(root: String) -> Result<Vec<Folder>, String> {
    crate::blocking(move || find_symbol_free(&root)).await
}

fn find_symbol_free(root: &str) -> Result<Vec<Folder>, String> {
    let root = std::path::Path::new(root);
    let vendor = root.join("vendor");
    if !vendor.is_dir() {
        return Ok(vec![]);
    }
    // ponytail: a regex, not a parser. A miss here only means a folder isn't suggested; a declaration it wrongly
    // saw would hide one, so it errs on seeing too many (a `function name` in a comment counts).
    let declares = regex::bytes::RegexBuilder::new(r"^\s*((abstract|final|readonly)\s+)*(class|interface|trait|enum|function)\s+\w|^\s*const\s|define\(|class_alias\(")
        .multi_line(true)
        .build()
        .map_err(|e| e.to_string())?;
    let files: Vec<std::path::PathBuf> = walk(&vendor.to_string_lossy(), "*.php", true)?
        .filter_map(|e| e.path().strip_prefix(root).ok().map(|p| p.to_path_buf()))
        .filter(|rel| !rel.starts_with("vendor/composer") && !rel.components().any(|c| matches!(c.as_os_str().to_str(), Some("tests" | "Tests"))))
        .collect();
    // Opening each file is most of the time (about 3 seconds for 26,000 files, one after another), so read on every core.
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    let scanned: Vec<(&std::path::PathBuf, u64, bool)> = std::thread::scope(|s| {
        let workers: Vec<_> = files
            .chunks(files.len().div_ceil(threads).max(1))
            .map(|chunk| {
                let declares = &declares;
                s.spawn(move || chunk.iter().filter_map(|rel| std::fs::read(root.join(rel)).ok().map(|text| (rel, text.len() as u64, !declares.is_match(&text)))).collect::<Vec<_>>())
            })
            .collect();
        workers.into_iter().flat_map(|w| w.join().unwrap_or_default()).collect()
    });
    // Per folder: PHP files, their bytes, and whether none declares anything.
    let mut folders: std::collections::HashMap<&std::path::Path, (usize, u64, bool)> = Default::default();
    for (rel, bytes, free) in scanned {
        for dir in rel.ancestors().skip(1).take_while(|d| !d.as_os_str().is_empty()) {
            let f = folders.entry(dir).or_insert((0, 0, true));
            f.0 += 1;
            f.1 += bytes;
            f.2 &= free;
        }
    }
    let mut found: Vec<Folder> = folders
        .iter()
        .filter(|(dir, (_, bytes, free))| *free && *bytes >= 100 * 1024 && dir.parent().and_then(|p| folders.get(p)).is_some_and(|parent| !parent.2))
        .map(|(dir, (files, bytes, _))| Folder { path: dir.to_string_lossy().into(), files: *files, bytes: *bytes })
        .collect();
    found.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    Ok(found)
}

/// Search options, shared by search and replace so both match exactly the same text.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    text: String,
    regex: bool,
    case_sensitive: bool,
    whole_word: bool,
}

impl Query {
    /// The regular expression: the text escaped unless it's a regex, wrapped in word boundaries if asked.
    fn pattern(&self) -> String {
        let p = if self.regex { self.text.clone() } else { regex::escape(&self.text) };
        if self.whole_word { format!(r"\b(?:{p})\b") } else { p }
    }

    fn matcher(&self) -> Result<RegexMatcher, String> {
        RegexMatcherBuilder::new().case_insensitive(!self.case_sensitive).build(&self.pattern()).map_err(|e| e.to_string())
    }

    fn regex(&self) -> Result<regex::Regex, String> {
        regex::RegexBuilder::new(&self.pattern())
            .case_insensitive(!self.case_sensitive)
            .multi_line(true)
            .build()
            .map_err(|e| e.to_string())
    }
}

#[derive(Serialize)]
pub struct Match {
    path: String,
    line: u64,
    /// 1-based start and end columns in UTF-16 code units, as Monaco counts them.
    column: usize,
    end: usize,
    text: String,
}

/// Every occurrence of the query in the project, up to 20,000.
#[tauri::command]
pub async fn search_text(root: String, query: Query, include: String, limit: Option<usize>) -> Result<Vec<Match>, String> {
    crate::blocking(move || find_text(root, query, include, limit.unwrap_or(MAX_MATCHES))).await
}

fn find_text(root: String, query: Query, include: String, limit: usize) -> Result<Vec<Match>, String> {
    if query.text.is_empty() {
        return Ok(vec![]);
    }
    let matcher = query.matcher()?;
    let mut searcher = Searcher::new();
    let mut matches = Vec::new();
    for entry in walk(&root, &include, false)? {
        let path = entry.path();
        let _ = searcher.search_path(
            &matcher,
            path,
            UTF8(|line, text| {
                let utf16 = |byte: usize| text[..byte].encode_utf16().count() + 1;
                let _ = matcher.find_iter(text.as_bytes(), |m| {
                    matches.push(Match {
                        path: path.to_string_lossy().into(),
                        line,
                        column: utf16(m.start()),
                        end: utf16(m.end()),
                        text: text.trim_end().into(),
                    });
                    matches.len() < limit
                });
                Ok(matches.len() < limit)
            }),
        );
        if matches.len() >= limit {
            break;
        }
    }
    Ok(matches)
}

/// Every file with at least one match, with no limit, for Replace All.
#[tauri::command]
pub async fn files_matching(root: String, query: Query, include: String) -> Result<Vec<String>, String> {
    crate::blocking(move || find_files(root, query, include)).await
}

fn find_files(root: String, query: Query, include: String) -> Result<Vec<String>, String> {
    let matcher = query.matcher()?;
    let mut searcher = Searcher::new();
    let mut files = Vec::new();
    for entry in walk(&root, &include, false)? {
        let mut found = false;
        let _ = searcher.search_path(
            &matcher,
            entry.path(),
            UTF8(|_, _| {
                found = true;
                Ok(false) // One match is enough.
            }),
        );
        if found {
            files.push(entry.path().to_string_lossy().into());
        }
    }
    Ok(files)
}

#[derive(Serialize)]
pub struct Replaced {
    text: String,
    count: usize,
}

/// Replaces every occurrence of the query in `text`. In regex mode, `$1` and `${name}` in the
/// replacement refer to capture groups; otherwise the replacement is literal.
#[tauri::command(async)]
pub fn replace_text(text: String, query: Query, replacement: String) -> Result<Replaced, String> {
    let re = query.regex()?;
    let count = re.find_iter(&text).count();
    let text = if query.regex {
        re.replace_all(&text, replacement.as_str()).into_owned()
    } else {
        re.replace_all(&text, regex::NoExpand(&replacement)).into_owned()
    };
    Ok(Replaced { text, count })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(text: &str, regex: bool, case_sensitive: bool, whole_word: bool) -> Query {
        Query { text: text.into(), regex, case_sensitive, whole_word }
    }

    #[test]
    fn finds_every_occurrence_and_respects_gitignore_and_include() {
        let dir = std::env::temp_dir().join(format!("php-editor-search-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("vendor")).unwrap();
        std::fs::write(dir.join(".gitignore"), "vendor/\n").unwrap();
        std::fs::write(dir.join("a.php"), "<?php\n$x = 'Café Needle needle';\n").unwrap();
        std::fs::write(dir.join("b.txt"), "needle").unwrap();
        std::fs::write(dir.join("vendor/c.php"), "needle").unwrap();
        let root = dir.to_string_lossy().to_string();
        let search = |query: Query, include: &str| tauri::async_runtime::block_on(search_text(root.clone(), query, include.into(), None)).unwrap();

        let found = search(q("needle", false, false, false), "");
        assert_eq!(found.len(), 3); // Two in a.php, one in b.txt; vendor is ignored.
        let first = found.iter().find(|m| m.path.ends_with("a.php")).unwrap();
        assert_eq!((first.line, first.column, first.end), (2, 12, 18));

        assert_eq!(search(q("needle", false, true, false), "").len(), 2);
        assert_eq!(search(q("needle", false, false, false), "*.php").len(), 2);
        assert_eq!(search(q("Need", false, false, true), "").len(), 0);
        assert!(tauri::async_runtime::block_on(search_text(root.clone(), q("(", true, false, false), "".into(), None)).is_err());

        let files = tauri::async_runtime::block_on(list_files(root.clone(), None));
        assert!(files.contains(&"a.php".to_string()) && !files.iter().any(|f| f.starts_with("vendor")));
        let all = tauri::async_runtime::block_on(list_files(root.clone(), Some(true)));
        assert!(all.iter().any(|f| f.starts_with("vendor")));
        let matching = tauri::async_runtime::block_on(files_matching(root.clone(), q("needle", false, false, false), "".into())).unwrap();
        assert_eq!(matching.len(), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn finds_vendor_folders_that_declare_nothing() {
        let dir = std::env::temp_dir().join(format!("php-editor-symbol-free-{}", std::process::id()));
        let write = |path: &str, text: &str| {
            let path = dir.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        let data = format!("<?php\nreturn ['{}'];\n", "x".repeat(60 * 1024));
        write("vendor/aws/sdk/src/data/s3/api.php", &data);
        write("vendor/aws/sdk/src/data/ec2/api.php", &data);
        write("vendor/aws/sdk/src/S3Client.php", "<?php\nfinal class S3Client {}\n");
        write("vendor/mixed/lib/data/a.php", &data);
        write("vendor/mixed/lib/data/b.php", &format!("{data}\nif (true) {{\n    function helper() {{}}\n}}\n"));
        write("vendor/small/lib/lang/en.php", "<?php return [];");
        write("vendor/big/lib/src/One.php", "<?php\ninterface One {}\n");
        write("vendor/big/lib/tests/fixtures/a.php", &data);
        write("vendor/big/lib/tests/fixtures/b.php", &data);

        let found = find_symbol_free(&dir.to_string_lossy()).unwrap();
        let paths: Vec<&str> = found.iter().map(|f| f.path.as_str()).collect();
        // The data folder, not its subfolders; not a folder with one declaration, one under 100 KB, or tests.
        assert_eq!(paths, ["vendor/aws/sdk/src/data"]);
        assert_eq!(found[0].files, 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn replaces_literally_or_with_capture_groups() {
        let text = "$a = 1; $ab = 2; $A = 3;\n";
        let r = replace_text(text.into(), q("$a", false, true, false), "$1".into()).unwrap();
        assert_eq!((r.text.as_str(), r.count), ("$1 = 1; $1b = 2; $A = 3;\n", 2));

        let r = replace_text(text.into(), q("a", false, false, true), "x".into()).unwrap();
        assert_eq!(r.text, "$x = 1; $ab = 2; $x = 3;\n");

        let r = replace_text("foo(1, 2)".into(), q(r"foo\((\d), (\d)\)", true, true, false), "bar($2, $1)".into()).unwrap();
        assert_eq!(r.text, "bar(2, 1)");
    }
}
