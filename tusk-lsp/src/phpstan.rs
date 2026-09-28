//! PHPStan (and Larastan), when the project has it: each PHP file is analyzed as it opens and each time it's
//! saved, with the project's own configuration, or the whole project on request. PHPStan reads files from disk, so
//! its problems describe the saved text and keep their lines until the next run. The editor's settings (the
//! `phpstan` option) turn it on or off and set its configuration file, level, memory limit, timeout, and when it
//! runs; each run's state goes to the editor as a `tusk/phpstan` notification.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::Sender;
use lsp_types::{Diagnostic, DiagnosticSeverity, NumberOrString, Position, Range};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// The editor's PHPStan settings.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// `auto` runs it when the project has `vendor/bin/phpstan`, `on` says so when it doesn't, `off` never runs it.
    pub enabled: String,
    /// The configuration file, relative to the root or absolute. Empty lets PHPStan find `phpstan.neon`,
    /// `phpstan.neon.dist`, or `phpstan.dist.neon`.
    pub config: String,
    /// `0` to `10` or `max`; empty uses the configuration's.
    pub level: String,
    /// PHP's memory limit for PHPStan, such as `2G`.
    pub memory_limit: String,
    /// Seconds one run may take. Larastan boots the app, and a cold cache is slow.
    pub timeout: u64,
    /// `save` checks files as they open and each time they're saved; `demand` only when you run it on the project.
    pub run: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self { enabled: "auto".into(), config: String::new(), level: String::new(), memory_limit: "2G".into(), timeout: 180, run: "save".into() }
    }
}

/// What PHPStan is doing, for the editor's status bar and Problems panel.
#[derive(Debug, Clone, Serialize)]
pub struct Status {
    /// `off`, `missing` (auto, and the project has no PHPStan), `idle`, `running`, or `failed`.
    pub state: &'static str,
    /// What's running, or why it failed.
    pub message: String,
}

enum Job {
    File(PathBuf),
    /// The whole project; the answer is its problems by path, or why the run failed.
    Project(Sender<Result<HashMap<PathBuf, Vec<Diagnostic>>, String>>),
}

pub struct PhpStan {
    root: PathBuf,
    results: Mutex<HashMap<PathBuf, Vec<Diagnostic>>>,
    settings: Mutex<Settings>,
    queue: Sender<Job>,
    /// Tells the editor the state, and the diagnostics thread which files' problems changed.
    report: Box<dyn Fn(Status) + Send + Sync>,
    refresh: Box<dyn Fn(PathBuf) + Send + Sync>,
}

impl PhpStan {
    /// Starts the runner's thread. `refresh` is called with each file whose problems changed.
    pub fn start(root: &Path, settings: Settings, report: impl Fn(Status) + Send + Sync + 'static, refresh: impl Fn(PathBuf) + Send + Sync + 'static) -> Arc<Self> {
        let (tx, rx) = crossbeam_channel::unbounded::<Job>();
        let this = Arc::new(Self {
            root: root.to_path_buf(),
            results: Default::default(),
            settings: Mutex::new(settings),
            queue: tx,
            report: Box::new(report),
            refresh: Box::new(refresh),
        });
        this.report_idle();
        let worker = this.clone();
        std::thread::Builder::new()
            .name("tusk-phpstan".into())
            .spawn(move || {
                while let Ok(first) = rx.recv() {
                    // Several saves in a row need one run per file.
                    let mut files: Vec<PathBuf> = vec![];
                    let mut projects = vec![];
                    for job in std::iter::once(first).chain(rx.try_iter()) {
                        match job {
                            Job::File(p) if !files.contains(&p) => files.push(p),
                            Job::File(_) => {}
                            Job::Project(reply) => projects.push(reply),
                        }
                    }
                    if !projects.is_empty() {
                        let found = worker.run(&[], "the project");
                        if let Ok(found) = &found {
                            worker.replace_all(found.clone());
                        }
                        for reply in projects {
                            let _ = reply.send(found.clone());
                        }
                        continue;
                    }
                    for path in files {
                        let rel = path.strip_prefix(&worker.root).unwrap_or(&path).display().to_string();
                        if let Ok(mut found) = worker.run(std::slice::from_ref(&path), &rel) {
                            worker.results.lock().insert(path.clone(), found.remove(&path).unwrap_or_default());
                            (worker.refresh)(path);
                        }
                    }
                }
            })
            .expect("the PHPStan thread starts");
        this
    }

    fn installed(&self) -> bool {
        self.root.join("vendor/bin/phpstan").exists()
    }

    /// Whether PHPStan runs at all, with these settings.
    fn active(&self, s: &Settings) -> bool {
        match s.enabled.as_str() {
            "off" => false,
            "on" => true,
            _ => self.installed(),
        }
    }

    fn report_idle(&self) {
        let s = self.settings.lock().clone();
        (self.report)(match s.enabled.as_str() {
            "off" => Status { state: "off", message: "PHPStan is off".into() },
            _ if !self.active(&s) => Status { state: "missing", message: "The project has no vendor/bin/phpstan".into() },
            _ => Status { state: "idle", message: String::new() },
        });
    }

    /// Applies new settings: drops the problems found with the old ones, and says whether files should be checked
    /// again, which the caller does for the open ones.
    pub fn configure(&self, settings: Settings) -> bool {
        if *self.settings.lock() == settings {
            return false;
        }
        *self.settings.lock() = settings.clone();
        self.replace_all(HashMap::new());
        self.report_idle();
        self.active(&settings) && settings.run != "demand"
    }

    /// Replaces every file's problems, and refreshes the files whose problems change.
    fn replace_all(&self, found: HashMap<PathBuf, Vec<Diagnostic>>) {
        let old = std::mem::replace(&mut *self.results.lock(), found);
        let now: Vec<PathBuf> = self.results.lock().keys().cloned().collect();
        for path in old.into_keys().chain(now) {
            (self.refresh)(path);
        }
    }

    /// Analyzes `path` in the background, if PHPStan runs on save.
    pub fn check(&self, path: &Path) {
        let s = self.settings.lock().clone();
        if self.active(&s) && s.run != "demand" && path.extension().is_some_and(|e| e == "php") && !path.to_string_lossy().ends_with(".blade.php") {
            let _ = self.queue.send(Job::File(path.to_path_buf()));
        }
    }

    /// Analyzes the whole project, after any run under way, and returns its problems by path. Blocks until done.
    pub fn check_project(&self) -> Result<HashMap<PathBuf, Vec<Diagnostic>>, String> {
        let s = self.settings.lock().clone();
        if s.enabled == "off" {
            return Err("PHPStan is off. Turn it on in Settings > PHPStan.".into());
        }
        if !self.installed() {
            return Err("The project has no vendor/bin/phpstan. Install it with composer require --dev phpstan/phpstan.".into());
        }
        let (tx, rx) = crossbeam_channel::bounded(1);
        let _ = self.queue.send(Job::Project(tx));
        rx.recv().map_err(|_| "PHPStan stopped".to_string())?
    }

    /// The last run's problems for `path`.
    pub fn problems(&self, path: &Path) -> Vec<Diagnostic> {
        self.results.lock().get(path).cloned().unwrap_or_default()
    }

    /// Runs PHPStan on `paths` (the configuration's paths when empty), reporting its state as it goes.
    fn run(&self, paths: &[PathBuf], what: &str) -> Result<HashMap<PathBuf, Vec<Diagnostic>>, String> {
        let s = self.settings.lock().clone();
        if !self.installed() {
            let message = "The project has no vendor/bin/phpstan. Install it with composer require --dev phpstan/phpstan.".to_string();
            (self.report)(Status { state: "failed", message: message.clone() });
            return Err(message);
        }
        (self.report)(Status { state: "running", message: format!("PHPStan: checking {what}") });
        let result = analyze(&self.root, paths, &s);
        match &result {
            Ok(_) => self.report_idle(),
            Err(e) => (self.report)(Status { state: "failed", message: e.clone() }),
        }
        result
    }
}

/// PHPStan's command line arguments for these settings.
pub fn arguments(settings: &Settings, paths: &[PathBuf]) -> Vec<String> {
    let mut args: Vec<String> = ["analyse", "--error-format=json", "--no-progress", "--no-interaction"].map(String::from).into();
    let memory = settings.memory_limit.trim();
    args.push(format!("--memory-limit={}", if memory.is_empty() { "2G" } else { memory }));
    if !settings.config.trim().is_empty() {
        args.push(format!("--configuration={}", settings.config.trim()));
    }
    if !settings.level.trim().is_empty() {
        args.push(format!("--level={}", settings.level.trim()));
    }
    if !paths.is_empty() {
        args.push("--".into());
        args.extend(paths.iter().map(|p| p.display().to_string()));
    }
    args
}

/// Runs PHPStan, and returns the problems by file, or why it failed.
fn analyze(root: &Path, paths: &[PathBuf], settings: &Settings) -> Result<HashMap<PathBuf, Vec<Diagnostic>>, String> {
    let mut child = Command::new("php")
        .arg(root.join("vendor/bin/phpstan"))
        .args(arguments(settings, paths))
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("PHPStan can't start PHP: {e}"))?;
    // Read on other threads, so a large report can't fill a pipe while this one waits.
    let read = |mut pipe: Box<dyn std::io::Read + Send>| {
        std::thread::spawn(move || {
            let mut out = String::new();
            pipe.read_to_string(&mut out).ok();
            out
        })
    };
    let stdout = read(Box::new(child.stdout.take().expect("piped")));
    let stderr = read(Box::new(child.stderr.take().expect("piped")));
    let started = Instant::now();
    let timeout = Duration::from_secs(settings.timeout.max(1));
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("PHPStan took longer than {} s and was stopped. Raise the timeout in Settings > PHPStan.", settings.timeout));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let out = stdout.join().unwrap_or_default();
    let err = stderr.join().unwrap_or_default();
    parse_report(&out, &err, root, settings)
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

/// PHPStan's output as problems by file, each covering its line's code, or why the run failed: out of memory, a
/// configuration error, or anything else PHPStan printed instead of its report.
pub fn parse_report(out: &str, err: &str, root: &Path, settings: &Settings) -> Result<HashMap<PathBuf, Vec<Diagnostic>>, String> {
    let all = format!("{out}\n{err}");
    if all.contains("Allowed memory size") || all.contains("Failed to set memory limit") {
        return Err(format!("PHPStan ran out of memory ({}). Raise the memory limit in Settings > PHPStan.", settings.memory_limit));
    }
    let report = out.find('{').and_then(|start| serde_json::from_str::<serde_json::Value>(&out[start..]).ok());
    let Some(report) = report else {
        let reason = all.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with("Note:") && !l.chars().all(|c| c == '-' || c == ' ')).unwrap_or("it printed no report");
        // PHP's warnings end with where they happened, a long path inside PHPStan's archive.
        let reason = reason.split(" in phar://").next().unwrap_or(reason);
        return Err(format!("PHPStan failed: {reason}"));
    };
    // PHP writes an empty `files` as `[]`.
    let files: HashMap<String, FileReport> = report.get("files").filter(|f| f.is_object()).and_then(|f| serde_json::from_value(f.clone()).ok()).unwrap_or_default();
    let first_error = report.get("errors").and_then(|e| e.get(0)).and_then(|e| e.as_str());
    if files.is_empty()
        && let Some(first) = first_error
    {
        return Err(format!("PHPStan failed: {}", first.lines().next().unwrap_or(first)));
    }
    Ok(files
        .into_iter()
        .map(|(name, file)| {
            let path = if Path::new(&name).is_absolute() { PathBuf::from(&name) } else { root.join(&name) };
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            let problems = diagnostics(&file.messages, &text);
            (path, problems)
        })
        .collect())
}

fn diagnostics(messages: &[Message], text: &str) -> Vec<Diagnostic> {
    let lines: Vec<&str> = text.lines().collect();
    messages
        .iter()
        .map(|m| {
            let line = m.line.unwrap_or(1).saturating_sub(1);
            let content = lines.get(line as usize).copied().unwrap_or("");
            let first = content.len() - content.trim_start().len();
            let utf16 = |s: &str| s.encode_utf16().count() as u32;
            let range = Range { start: Position::new(line, utf16(&content[..first])), end: Position::new(line, utf16(content.trim_end())) };
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
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("app")).unwrap();
        std::fs::write(dir.path().join("app/A.php"), "<?php\n\n    echo $x;\n").unwrap();
        let name = dir.path().join("app/A.php").display().to_string();
        let json = format!(
            r#"Note: something first
{{"totals":{{"errors":0,"file_errors":1}},"files":{{"{name}":{{"errors":1,"messages":[{{"message":"Undefined variable: $x","line":3,"ignorable":true,"identifier":"variable.undefined","tip":"Did you mean $y?"}}]}}}},"errors":[]}}"#
        );
        let found = parse_report(&json, "", dir.path(), &Settings::default()).unwrap();
        let found = &found[&dir.path().join("app/A.php")];
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].range, Range { start: Position::new(2, 4), end: Position::new(2, 12) });
        assert_eq!(found[0].code, Some(NumberOrString::String("variable.undefined".into())));
        assert_eq!(found[0].message, "Undefined variable: $x\nTip: Did you mean $y?");
    }

    #[test]
    fn says_why_a_run_failed() {
        let s = Settings::default();
        let root = Path::new("/p");
        let oom = parse_report("", "PHP Fatal error:  Allowed memory size of 134217728 bytes exhausted", root, &s).unwrap_err();
        assert!(oom.contains("ran out of memory (2G)"), "{oom}");
        assert!(parse_report("", "Warning: Failed to set memory limit to 8388608 bytes (Current memory usage is 27262976 bytes) in phar:///p/x.phar/a.php on line 110", root, &s).unwrap_err().contains("ran out of memory"));
        assert_eq!(parse_report("Fatal: oops in phar:///p/x.phar/a.php on line 3", "", root, &s).unwrap_err(), "PHPStan failed: Fatal: oops");
        let config = parse_report("", "\n Invalid configuration:\n Unexpected item 'parameters › foo'.\n", root, &s).unwrap_err();
        assert_eq!(config, "PHPStan failed: Invalid configuration:");
        let general = parse_report(r#"{"totals":{},"files":[],"errors":["Path /p/nope does not exist"]}"#, "", root, &s);
        assert_eq!(general.unwrap_err(), "PHPStan failed: Path /p/nope does not exist");
        assert!(parse_report(r#"{"files":[],"errors":[]}"#, "", root, &s).unwrap().is_empty());
    }

    #[test]
    fn passes_the_settings_on() {
        let s = Settings { config: "phpstan.ci.neon".into(), level: "6".into(), memory_limit: "1G".into(), ..Default::default() };
        let args = arguments(&s, &[PathBuf::from("/p/app/A.php")]);
        assert_eq!(args[4..], ["--memory-limit=1G", "--configuration=phpstan.ci.neon", "--level=6", "--", "/p/app/A.php"]);
        assert_eq!(arguments(&Settings::default(), &[])[4..], ["--memory-limit=2G"]);
    }
}
