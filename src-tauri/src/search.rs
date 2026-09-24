use grep::matcher::Matcher;
use grep::regex::RegexMatcherBuilder;
use grep::searcher::{sinks::UTF8, Searcher};
use ignore::WalkBuilder;
use serde::Serialize;

const MAX_MATCHES: usize = 2000;

/// Walks the project like ripgrep: respects .gitignore (even outside a git repo),
/// includes dotfiles, and skips .git.
fn walk(root: &str) -> impl Iterator<Item = ignore::DirEntry> {
    WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
}

/// Project files as paths relative to `root`.
#[tauri::command]
pub async fn list_files(root: String) -> Vec<String> {
    walk(&root)
        .filter_map(|e| e.path().strip_prefix(&root).ok().map(|p| p.to_string_lossy().into()))
        .collect()
}

#[derive(Serialize)]
pub struct Match {
    path: String,
    line: u64,
    /// 1-based column in UTF-16 code units, as Monaco counts them.
    column: usize,
    text: String,
}

#[tauri::command]
pub async fn search_text(root: String, query: String, regex: bool, case_sensitive: bool) -> Result<Vec<Match>, String> {
    let matcher = RegexMatcherBuilder::new()
        .fixed_strings(!regex)
        .case_insensitive(!case_sensitive)
        .build(&query)
        .map_err(|e| e.to_string())?;
    let mut searcher = Searcher::new();
    let mut matches = Vec::new();
    for entry in walk(&root) {
        let path = entry.path();
        let _ = searcher.search_path(
            &matcher,
            path,
            UTF8(|line, text| {
                let start = matcher.find(text.as_bytes()).ok().flatten().map_or(0, |m| m.start());
                matches.push(Match {
                    path: path.to_string_lossy().into(),
                    line,
                    column: text[..start].encode_utf16().count() + 1,
                    text: text.trim_end().into(),
                });
                Ok(matches.len() < MAX_MATCHES)
            }),
        );
        if matches.len() >= MAX_MATCHES {
            break;
        }
    }
    Ok(matches)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_text_and_respects_gitignore() {
        let dir = std::env::temp_dir().join(format!("php-editor-search-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("vendor")).unwrap();
        std::fs::write(dir.join(".gitignore"), "vendor/\n").unwrap();
        std::fs::write(dir.join("a.php"), "<?php\n$x = 'Café Needle';\n").unwrap();
        std::fs::write(dir.join("vendor/b.php"), "needle").unwrap();
        let root = dir.to_string_lossy().to_string();

        let found = tauri::async_runtime::block_on(search_text(root.clone(), "needle".into(), false, false)).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].line, found[0].column), (2, 12));

        let files = tauri::async_runtime::block_on(list_files(root.clone()));
        assert!(files.contains(&"a.php".to_string()) && !files.iter().any(|f| f.starts_with("vendor")));

        assert!(tauri::async_runtime::block_on(search_text(root, "Needle".into(), false, true)).unwrap().len() == 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
