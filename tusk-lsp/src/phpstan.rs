//! PHPStan (and Larastan), when the project has it: each PHP file is analyzed as it opens and each time it's
//! saved, with the project's own configuration. PHPStan reads files from disk, so its problems describe the saved
//! text and keep their lines until the next run.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use crossbeam_channel::Sender;
use lsp_types::{Diagnostic, DiagnosticSeverity, NumberOrString, Position, Range};
use parking_lot::Mutex;
use serde::Deserialize;

/// How long one run may take. Larastan boots the app, and a cold cache is slow.
const TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Default)]
pub struct PhpStan {
    results: Mutex<HashMap<PathBuf, Vec<Diagnostic>>>,
    queue: OnceLock<Sender<PathBuf>>,
}

impl PhpStan {
    /// Starts the runner if `root` has `vendor/bin/phpstan`. `done` is called with each file analyzed.
    pub fn start(self: &Arc<Self>, root: &Path, done: impl Fn(PathBuf) + Send + 'static) {
        if !root.join("vendor/bin/phpstan").exists() {
            return;
        }
        let (tx, rx) = crossbeam_channel::unbounded::<PathBuf>();
        if self.queue.set(tx).is_err() {
            return;
        }
        let worker = self.clone();
        let root = root.to_path_buf();
        std::thread::Builder::new()
            .name("tusk-phpstan".into())
            .spawn(move || {
                while let Ok(first) = rx.recv() {
                    // Several saves in a row need one run per file.
                    let mut paths = vec![first];
                    for p in rx.try_iter() {
                        if !paths.contains(&p) {
                            paths.push(p);
                        }
                    }
                    for path in paths {
                        if let Some(found) = analyze(&root, &path) {
                            worker.results.lock().insert(path.clone(), found);
                            done(path);
                        }
                    }
                }
            })
            .expect("the PHPStan thread starts");
    }

    /// Analyzes `path` in the background.
    pub fn check(&self, path: &Path) {
        if let Some(q) = self.queue.get()
            && path.extension().is_some_and(|e| e == "php")
            && !path.to_string_lossy().ends_with(".blade.php")
        {
            let _ = q.send(path.to_path_buf());
        }
    }

    /// The last run's problems for `path`.
    pub fn problems(&self, path: &Path) -> Vec<Diagnostic> {
        self.results.lock().get(path).cloned().unwrap_or_default()
    }
}

#[derive(Deserialize)]
struct Report {
    #[serde(default)]
    files: HashMap<String, FileReport>,
}

#[derive(Deserialize)]
struct FileReport {
    messages: Vec<Message>,
}

#[derive(Deserialize)]
struct Message {
    message: String,
    line: Option<u32>,
    #[serde(default)]
    identifier: Option<String>,
    #[serde(default)]
    tip: Option<String>,
}

/// Runs PHPStan on one file. `None` if it couldn't run, so earlier results stay.
fn analyze(root: &Path, path: &Path) -> Option<Vec<Diagnostic>> {
    let mut child = Command::new("php")
        .arg(root.join("vendor/bin/phpstan"))
        .args(["analyse", "--error-format=json", "--no-progress", "--no-interaction", "--memory-limit=2G", "--"])
        .arg(path)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // Read on another thread, so a large report can't fill the pipe while this one waits.
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        std::io::Read::read_to_string(&mut stdout, &mut out).ok();
        out
    });
    let started = Instant::now();
    loop {
        if child.try_wait().ok()?.is_some() {
            break;
        }
        if started.elapsed() > TIMEOUT {
            let _ = child.kill();
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let out = reader.join().ok()?;
    let text = std::fs::read_to_string(path).unwrap_or_default();
    Some(parse(&out, path, &text))
}

/// PHPStan's JSON report for `path` as diagnostics, each covering its line's code.
pub fn parse(json: &str, path: &Path, text: &str) -> Vec<Diagnostic> {
    let Some(start) = json.find('{') else { return vec![] };
    let Ok(report) = serde_json::from_str::<Report>(&json[start..]) else { return vec![] };
    let lines: Vec<&str> = text.lines().collect();
    let key = path.to_string_lossy();
    let Some(file) = report.files.iter().find(|(k, _)| k.as_str() == key || k.ends_with(&*key)).map(|(_, f)| f) else {
        return vec![];
    };
    file.messages
        .iter()
        .map(|m| {
            let line = m.line.unwrap_or(1).saturating_sub(1);
            let content = lines.get(line as usize).copied().unwrap_or("");
            let first = content.len() - content.trim_start().len();
            let utf16 = |s: &str| s.encode_utf16().count() as u32;
            let range = Range {
                start: Position::new(line, utf16(&content[..first])),
                end: Position::new(line, utf16(content.trim_end())),
            };
            let mut message = m.message.clone();
            if let Some(tip) = &m.tip {
                message.push_str(&format!("\nTip: {tip}"));
            }
            Diagnostic {
                range,
                severity: Some(DiagnosticSeverity::ERROR),
                code: m.identifier.clone().map(NumberOrString::String),
                source: Some("phpstan".into()),
                message,
                ..Default::default()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_phpstans_json_report() {
        let json = r#"Note: something first
{"totals":{"errors":0,"file_errors":1},"files":{"/p/app/A.php":{"errors":1,"messages":[{"message":"Undefined variable: $x","line":3,"ignorable":true,"identifier":"variable.undefined","tip":"Did you mean $y?"}]}},"errors":[]}"#;
        let found = parse(json, Path::new("/p/app/A.php"), "<?php\n\n    echo $x;\n");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].range, Range { start: Position::new(2, 4), end: Position::new(2, 12) });
        assert_eq!(found[0].code, Some(NumberOrString::String("variable.undefined".into())));
        assert_eq!(found[0].message, "Undefined variable: $x\nTip: Did you mean $y?");
        assert!(parse("not json", Path::new("/p/app/A.php"), "").is_empty());
    }
}
