use crate::lsp::tools_dir;
use std::io::Write;
use std::process::{Command, Stdio};
use tauri::AppHandle;

/// Path of a bundled tool, for tools the frontend passes to a language server.
#[tauri::command(async)]
pub fn tool_path(app: AppHandle, name: String) -> Result<String, String> {
    Ok(tools_dir(&app)?.join(name).to_string_lossy().into())
}

#[tauri::command(async)]
pub fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// Whether each path exists, in one call for a batch of file-system events.
#[tauri::command(async)]
pub fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| std::path::Path::new(p).exists()).collect()
}

/// Runs a program in `cwd` and returns its standard output, for short queries such as
/// `php artisan list --format=json`. `input`, if given, is written to standard input.
/// Fails with standard error if the program fails, unless `any_status`: checkers such as Mago
/// exit with an error when they find problems, and still print their report.
#[tauri::command]
pub async fn run_capture(cwd: String, program: String, args: Vec<String>, input: Option<String>, any_status: Option<bool>) -> Result<String, String> {
    crate::blocking(move || capture(cwd, program, args, input, any_status.unwrap_or(false))).await
}

fn capture(cwd: String, program: String, args: Vec<String>, input: Option<String>, any_status: bool) -> Result<String, String> {
    crate::login_path();
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
    if !out.status.success() && !(any_status && out.status.code().is_some()) {
        return Err(String::from_utf8_lossy(&out.stderr).into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into())
}
