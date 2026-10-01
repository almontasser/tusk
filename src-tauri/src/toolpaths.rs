// The paths of the tools the app runs by name (php, git, node…), from Settings > Tools and the project's PHP
// interpreter. Each set path gets a small script named after the tool in a folder of shims, and that folder comes
// first in the PATH of every program the app starts, so the choice reaches everything: commands, terminals, the
// language servers, and the programs they start in turn, such as the PHP server's own `php`. A tool without a
// path is found on the login shell's PATH, as before.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};
use tauri::{AppHandle, Emitter, Manager};

/// Tools the app runs by bare name, and how errors name them.
const TOOLS: &[(&str, &str)] = &[("php", "PHP"), ("composer", "Composer"), ("node", "Node.js"), ("git", "Git"), ("gh", "GitHub CLI (gh)"), ("docker", "Docker")];

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// Paths by tool name; a missing or empty one means the tool is found on PATH.
    paths: HashMap<String, String>,
    /// The terminal's shell, empty for `$SHELL`.
    shell: String,
    /// The shell's arguments, split at spaces. None until the frontend sends them: `-l`.
    shell_args: Option<String>,
}

static CONFIG: RwLock<Option<Config>> = RwLock::new(None);
static SHIMS: OnceLock<PathBuf> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Sets where the shims go. Call it once in setup, before any command runs.
pub fn init(app: &AppHandle) {
    if let Ok(dir) = app.path().app_local_data_dir() {
        let dir = dir.join("bin");
        // Shims from the last run point where the settings said then; the frontend writes them again.
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        let _ = SHIMS.set(dir);
    }
    let _ = APP.set(app.clone());
}

/// PATH for a program the app starts: the shims, then the login shell's PATH. Windows has no shims (a `.cmd` file
/// isn't found by programs that start `php`), so each set path's folder comes first instead.
pub fn path_env() -> std::ffi::OsString {
    crate::login_path();
    let path = std::env::var_os("PATH").unwrap_or_default();
    #[cfg(windows)]
    let first: Vec<PathBuf> = CONFIG.read().unwrap().as_ref().map_or(vec![], |c| {
        TOOLS.iter().filter_map(|(name, _)| Some(Path::new(c.paths.get(*name).filter(|p| !p.is_empty())?).parent()?.to_path_buf())).collect()
    });
    #[cfg(not(windows))]
    let first: Vec<PathBuf> = SHIMS.get().cloned().into_iter().collect();
    std::env::join_paths(first.into_iter().chain(std::env::split_paths(&path))).unwrap_or(path)
}

/// A command that runs `program` with `path_env()` as its PATH. On Windows it finds the program as a shell would,
/// runs `/bin/sh` and `/usr/bin/env` from Git for Windows, and opens no console window.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let path = path_env();
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new(resolve(&program.as_ref().to_string_lossy()));
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        command
    };
    #[cfg(not(windows))]
    let mut command = std::process::Command::new(program);
    command.env("PATH", path);
    command
}

/// The file Windows runs for `program`: a set or PATH tool by name, with its extension (`composer` is
/// `composer.bat`), or Git for Windows' copy of a Unix program the frontend names. Elsewhere, `program` itself.
pub fn resolve(program: &str) -> String {
    #[cfg(windows)]
    {
        let found = match program {
            "/bin/sh" => git_unix_tool("sh.exe"),
            "/usr/bin/env" => git_unix_tool("env.exe"),
            _ if !program.contains(['/', '\\']) => find_in(std::env::split_paths(&path_env()), program),
            _ => None,
        };
        if let Some(found) = found {
            return found.to_string_lossy().into_owned();
        }
    }
    program.to_string()
}

/// A Unix program that Git for Windows ships, such as `sh.exe`, found from where Git is.
#[cfg(windows)]
fn git_unix_tool(exe: &str) -> Option<PathBuf> {
    let set = CONFIG.read().unwrap().as_ref().and_then(|c| c.paths.get("git").filter(|p| !p.is_empty()).map(PathBuf::from));
    let git = set.or_else(|| which("git")).unwrap_or_else(|| PathBuf::from(r"C:\Program Files\Git\cmd\git.exe"));
    git.ancestors().flat_map(|dir| [dir.join("usr/bin").join(exe), dir.join("bin").join(exe)]).find(|p| p.is_file())
}

#[cfg(unix)]
fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
fn executable(path: &Path) -> bool {
    path.is_file()
}

/// The first `name` in `dirs`; on Windows, also with each extension in PATHEXT.
fn find_in(dirs: impl Iterator<Item = PathBuf>, name: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let names: Vec<String> = std::iter::once(name.to_string())
        .chain(std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into()).split(';').filter(|e| !e.is_empty()).map(|e| format!("{name}{}", e.to_ascii_lowercase())))
        .collect();
    #[cfg(not(windows))]
    let names = [name.to_string()];
    dirs.flat_map(|d| names.iter().map(move |n| d.join(n)).collect::<Vec<_>>()).find(|p| executable(p))
}

/// Where a program is on the login shell's PATH, without the shims.
fn which(name: &str) -> Option<PathBuf> {
    crate::login_path();
    find_in(std::env::split_paths(&std::env::var_os("PATH")?), name)
}

/// The tool a command runs, looking past `/usr/bin/env VAR=value`.
fn tool_of(command: &[String]) -> Option<&str> {
    let mut words = command.iter().map(String::as_str);
    let first = words.next()?;
    if first == "/usr/bin/env" {
        return words.find(|w| !w.contains('=') && !w.starts_with('-'));
    }
    Some(first)
}

/// Fails with an error that says where to fix it when a command's tool is missing: its set path doesn't exist,
/// or, without one, it isn't on PATH. The error also goes out as a `tool-missing` event, so callers that stay quiet
/// on failure, such as the model introspection, still tell you.
pub fn check(command: &[String]) -> Result<(), String> {
    let Some(name) = tool_of(command) else { return Ok(()) };
    // Shell scripts run with Git for Windows' sh, so they need Git.
    let name = if cfg!(windows) && matches!(command.first().map(String::as_str), Some("/bin/sh" | "/usr/bin/env")) && resolve("/bin/sh") == "/bin/sh" { "git" } else { name };
    let Some((_, label)) = TOOLS.iter().find(|(n, _)| *n == name) else { return Ok(()) };
    let set = CONFIG.read().unwrap().as_ref().and_then(|c| c.paths.get(name).filter(|p| !p.is_empty()).cloned());
    let error = match set {
        Some(path) if !executable(Path::new(&path)) => format!("{label} wasn't found at {path}. Set its path in Settings > Tools."),
        None if which(name).is_none() => format!("{label} wasn't found. Install it, or set its path in Settings > Tools."),
        _ => return Ok(()),
    };
    if let Some(app) = APP.get() {
        let _ = app.emit("tool-missing", &error);
    }
    Err(error)
}

/// The terminal's shell and its arguments.
pub fn shell() -> Vec<String> {
    let config = CONFIG.read().unwrap();
    let shell = config.as_ref().map(|c| c.shell.clone()).filter(|s| !s.is_empty());
    // Git Bash sets $SHELL to a path only its own programs understand, such as /usr/bin/bash.
    let shell = shell.or_else(|| std::env::var("SHELL").ok().filter(|_| !cfg!(windows))).unwrap_or_else(|| default_shell().into());
    let args = config.as_ref().and_then(|c| c.shell_args.clone()).unwrap_or_else(|| if cfg!(windows) { "-NoLogo" } else { "-l" }.into());
    std::iter::once(shell).chain(args.split_whitespace().map(String::from)).collect()
}

/// The shell when neither the settings nor `$SHELL` name one.
pub fn default_shell() -> &'static str {
    if cfg!(windows) {
        "powershell.exe"
    } else if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/sh"
    }
}

/// A shell word for `sh`: the text in single quotes.
#[cfg_attr(windows, allow(dead_code))]
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// Applies Settings > Tools: writes a shim for each tool with a path, removes the others, and keeps the terminal's shell.
#[tauri::command]
pub fn tools_configure(config: Config) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let dir = SHIMS.get().ok_or("The app's data folder isn't available")?;
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        for (name, _) in TOOLS {
            let shim = dir.join(name);
            match config.paths.get(*name).filter(|p| !p.is_empty()) {
                Some(path) => {
                    // Written beside and renamed, so a program starting now never runs half a file.
                    let part = dir.join(format!(".{name}.part"));
                    std::fs::write(&part, format!("#!/bin/sh\nexec {} \"$@\"\n", quote(path))).map_err(|e| e.to_string())?;
                    std::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
                    std::fs::rename(&part, &shim).map_err(|e| e.to_string())?;
                }
                None => _ = std::fs::remove_file(&shim),
            }
        }
    }
    *CONFIG.write().unwrap() = Some(config);
    Ok(())
}

/// Where a tool is on the login shell's PATH, for Settings > Tools' "Detected" note.
#[tauri::command(async)]
pub fn tool_which(name: String) -> Option<String> {
    which(&name).map(crate::slash)
}

/// Whether Settings > Tools lets the app check for app and tool updates by itself. Read from settings.json, so it
/// holds from launch, before the frontend has loaded.
pub fn auto_checks(app: &AppHandle) -> bool {
    let Ok(dir) = app.path().app_config_dir() else { return true };
    let Ok(text) = std::fs::read_to_string(dir.join("settings.json")) else { return true };
    serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|v| v["checkForUpdates"].as_bool()).unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_tool_behind_env() {
        let words = |s: &str| s.split(' ').map(String::from).collect::<Vec<_>>();
        assert_eq!(tool_of(&words("php artisan serve")), Some("php"));
        assert_eq!(tool_of(&words("/usr/bin/env XDEBUG_MODE=debug php artisan serve")), Some("php"));
        assert_eq!(tool_of(&words("/usr/bin/env A=1")), None);
        assert_eq!(quote("it's"), r"'it'\''s'");
    }
}
