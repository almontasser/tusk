use crate::lsp::tools_dir;
use std::io::Write;
use std::process::{Command, Stdio};
use tauri::AppHandle;

/// Path of a bundled tool, for tools the frontend passes to a language server.
#[tauri::command]
pub fn tool_path(app: AppHandle, name: String) -> Result<String, String> {
    Ok(tools_dir(&app)?.join(name).to_string_lossy().into())
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// Formats PHP source with the bundled Mago. Mago reads the project's `mago.toml` from `root`.
#[tauri::command]
pub fn format_php(app: AppHandle, root: String, path: String, contents: String) -> Result<String, String> {
    let mut child = Command::new(tools_dir(&app)?.join("mago"))
        .args(["format", "--stdin-input", "--stdin-filepath", &path])
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child.stdin.take().unwrap().write_all(contents.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into());
    }
    String::from_utf8(out.stdout).map_err(|e| e.to_string())
}

/// Runs a program in `cwd` and returns its standard output, for short queries such as
/// `php artisan list --format=json`. `input`, if given, is written to standard input.
/// Fails with standard error if the program fails.
#[tauri::command]
pub async fn run_capture(cwd: String, program: String, args: Vec<String>, input: Option<String>) -> Result<String, String> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(input) = input {
        let mut stdin = child.stdin.take().unwrap();
        // Write on another thread, so a large input can't deadlock against a full stdout pipe.
        std::thread::spawn(move || stdin.write_all(input.as_bytes()));
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into())
}
