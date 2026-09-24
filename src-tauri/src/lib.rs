mod fs;
mod lsp;
mod pty;
mod search;
mod tools;

use tauri::Manager;

/// Apps opened from Finder get a minimal PATH, so tools installed through
/// Homebrew, Herd, or Composer are missing. Adopt the login shell's PATH instead.
fn use_login_shell_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let Ok(out) = std::process::Command::new(shell)
        .args(["-ilc", "printf '\\n__PATH__%s__PATH__' \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .output()
    else {
        return;
    };
    let out = String::from_utf8_lossy(&out.stdout);
    if let Some(path) = out.split("__PATH__").nth(1).filter(|p| !p.is_empty()) {
        std::env::set_var("PATH", path);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use_login_shell_path();
    let mut builder = tauri::Builder::default();
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_mcp_bridge::Builder::new().bind_address("127.0.0.1").build());
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(fs::WatchState::default())
        .manage(lsp::LspState::default())
        .manage(pty::PtyState::default())
        .invoke_handler(tauri::generate_handler![
            fs::read_dir,
            fs::read_file,
            fs::write_file,
            fs::rename_path,
            fs::remove_path,
            fs::create_file,
            fs::create_dir,
            fs::trash_path,
            fs::watch,
            lsp::lsp_start,
            lsp::lsp_send,
            tools::tool_path,
            tools::path_exists,
            tools::format_php,
            tools::run_capture,
            search::list_files,
            search::search_text,
            search::replace_text,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Language servers keep running when their parent dies, so stop them on quit.
            if let tauri::RunEvent::Exit = event {
                app.state::<lsp::LspState>().stop_all();
            }
        });
}
