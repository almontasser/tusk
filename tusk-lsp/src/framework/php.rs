//! Running the project's PHP, as Laravel LSP does: the PHP that Herd or Valet serves the site with, the
//! container's for Sail, Lando, and DDEV, else the `php` on `PATH`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::Value;

/// Warnings and deprecations the scripts don't care about, which would otherwise print before the JSON.
const ERROR_REPORTING: &str = "error_reporting=E_ALL & ~(E_WARNING | E_CORE_WARNING | E_COMPILE_WARNING | E_USER_WARNING | E_DEPRECATED | E_USER_DEPRECATED)";

/// How long one PHP script may run.
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a detection command may run, such as `sail ps` with Docker stopped.
const DETECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How to run PHP for the project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Php {
    /// The program and its leading arguments, such as `["./vendor/bin/sail", "php"]`.
    pub program: Vec<String>,
    /// The project's folder inside the container, for runners that run PHP in one. Scripts then live in the
    /// project, where the container sees them, and paths the scripts print are mapped back.
    pub container_root: Option<String>,
}

impl Php {
    fn local(binary: &str) -> Self {
        Self { program: vec![binary.to_string()], container_root: None }
    }
}

/// Runs a command in `root` and returns what it prints, if it succeeds in time.
fn output(root: &Path, command: &[&str], timeout: Duration) -> Option<String> {
    let mut child = crate::command(command[0])
        .args(&command[1..])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    // Read as it comes: a command that prints more than the pipe holds waits until it's read.
    let reader = std::thread::spawn(move || {
        let mut out = vec![];
        let _ = std::io::Read::read_to_end(&mut stdout, &mut out);
        out
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().ok()? {
            break status;
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let out = reader.join().ok()?;
    status.success().then(|| String::from_utf8_lossy(&out).into_owned())
}

/// The PHP to run the project's scripts with: Herd's, Valet's, Sail's, Lando's, DDEV's, or the local one, in
/// that order, the first that answers.
pub fn detect(root: &Path) -> Php {
    let binary = |out: Option<String>| out.map(|o| o.trim().to_string()).filter(|o| !o.is_empty() && !o.contains("No usable PHP version found"));
    if let Some(php) = binary(output(root, &["herd", "which-php"], DETECT_TIMEOUT)) {
        return Php::local(&php);
    }
    if let Some(php) = binary(output(root, &["valet", "which-php"], DETECT_TIMEOUT)) {
        return Php::local(&php);
    }
    let container = |program: &[&str], probe: &[&str]| -> Option<Php> {
        output(root, probe, DETECT_TIMEOUT)?;
        let mut cwd = program.to_vec();
        cwd.extend(["-r", "echo getcwd();"]);
        let inside = output(root, &cwd, DETECT_TIMEOUT).map(|o| o.trim().to_string()).filter(|o| o.starts_with('/'));
        Some(Php { program: program.iter().map(|s| s.to_string()).collect(), container_root: Some(inside.unwrap_or_else(|| "/var/www/html".into())) })
    };
    if root.join("vendor/bin/sail").is_file()
        && let Some(php) = container(&["./vendor/bin/sail", "php"], &["./vendor/bin/sail", "ps"])
    {
        return php;
    }
    if root.join(".lando.yml").is_file()
        && let Some(php) = container(&["lando", "php"], &["lando", "php", "-r", "echo PHP_BINARY;"])
    {
        return php;
    }
    if root.join(".ddev").is_dir()
        && let Some(php) = container(&["ddev", "php"], &["ddev", "php", "-r", "echo PHP_BINARY;"])
    {
        return php;
    }
    Php::local(&binary(output(root, &["php", "-r", "echo PHP_BINARY;"], DETECT_TIMEOUT)).unwrap_or_else(|| "php".into()))
}

/// The command line that runs `script` (a path as PHP sees it) with `args`. `tinker` runs it through
/// `artisan tinker`, for an app that can't boot from `bootstrap/app.php` alone.
pub fn command_line(php: &Php, script: &str, args: &[&str], tinker: bool) -> Vec<String> {
    let mut out = php.program.clone();
    out.extend(["-d".to_string(), ERROR_REPORTING.to_string()]);
    if tinker {
        out.extend(["artisan".into(), "tinker".into(), "--execute".into(), format!("require '{}';", script.replace('\'', "\\'"))]);
    } else {
        out.push(script.to_string());
    }
    out.extend(args.iter().map(|a| a.to_string()));
    out
}

/// A script's output with the container's paths turned into the project's, in plain and JSON-escaped form.
pub fn map_paths(text: &str, container_root: &str, root: &Path) -> String {
    let root = root.to_string_lossy();
    let escaped = |s: &str| s.replace('/', "\\/");
    text.replace(&format!("{container_root}/"), &format!("{root}/"))
        .replace(&format!("{}\\/", escaped(container_root)), &format!("{}\\/", escaped(&root)))
}

/// A name no other run uses at the same time.
fn unique() -> String {
    use std::hash::{Hash, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed), Instant::now().elapsed().as_nanos(), std::time::SystemTime::now()).hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Runs `script` with the project's PHP and returns the JSON it prints. The output may be preceded by noise
/// such as notices, so parsing starts at the first `{` or `[`.
pub fn run(root: &Path, php: &Php, script: &str, args: &[&str], tinker: bool) -> Option<Value> {
    // A container sees only the project, so the script goes where Laravel LSP puts it, and is removed after.
    // Locally it's written once outside the project, named by its content.
    let (file, arg, temporary): (PathBuf, String, bool) = match &php.container_root {
        Some(_) => {
            let rel = format!("storage/framework/lsp-{}.php", unique());
            std::fs::create_dir_all(root.join("storage/framework")).ok()?;
            (root.join(&rel), rel, true)
        }
        None => {
            let dir = std::env::temp_dir().join("tusk-lsp");
            std::fs::create_dir_all(&dir).ok()?;
            let hash = {
                use std::hash::{Hash, Hasher};
                let mut h = std::collections::hash_map::DefaultHasher::new();
                script.hash(&mut h);
                h.finish()
            };
            let file = dir.join(format!("script-{hash:016x}.php"));
            let arg = file.to_string_lossy().into_owned();
            (file, arg, false)
        }
    };
    if temporary || !file.exists() {
        std::fs::write(&file, script).ok()?;
    }
    let line = command_line(php, &arg, args, tinker);
    let parts: Vec<&str> = line.iter().map(String::as_str).collect();
    let text = output(root, &parts, SCRIPT_TIMEOUT);
    if temporary {
        let _ = std::fs::remove_file(&file);
    }
    let mut text = text?;
    if let Some(inside) = &php.container_root {
        text = map_paths(&text, inside, root);
    }
    let start = text.find(['{', '['])?;
    serde_json::from_str(&text[start..]).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_command_lines() {
        let local = Php::local("/opt/php");
        assert_eq!(command_line(&local, "/tmp/s.php", &["."], false), vec!["/opt/php", "-d", ERROR_REPORTING, "/tmp/s.php", "."]);
        let sail = Php { program: vec!["./vendor/bin/sail".into(), "php".into()], container_root: Some("/var/www/html".into()) };
        assert_eq!(
            command_line(&sail, "storage/framework/lsp-1.php", &[], true),
            vec!["./vendor/bin/sail", "php", "-d", ERROR_REPORTING, "artisan", "tinker", "--execute", "require 'storage/framework/lsp-1.php';"]
        );
    }

    #[test]
    fn maps_container_paths_to_the_project() {
        let text = r#"{"file":"/var/www/html/app/Models/User.php","escaped":"\/var\/www\/html\/routes\/web.php","other":"/var/www/htmlx"}"#;
        assert_eq!(
            map_paths(text, "/var/www/html", Path::new("/Users/me/app")),
            r#"{"file":"/Users/me/app/app/Models/User.php","escaped":"\/Users\/me\/app\/routes\/web.php","other":"/var/www/htmlx"}"#
        );
    }
}
