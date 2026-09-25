mod db;
mod fs;
mod lsp;
mod pty;
mod search;
mod tools;

use std::sync::LazyLock;
use tauri::Manager;

/// Apps opened from Finder get a minimal PATH, so tools installed through
/// Homebrew, Herd, or Composer are missing. The login shell's PATH is read on a thread at launch,
/// since an interactive shell with plugins can take a second or more; `login_path()` waits for it,
/// so call it before starting any program.
static LOGIN_PATH: LazyLock<()> = LazyLock::new(use_login_shell_path);

pub fn login_path() {
    LazyLock::force(&LOGIN_PATH);
}

/// Runs blocking work on Tauri's blocking thread pool, so it holds neither the main thread (which
/// draws the window and handles every command) nor the async workers.
pub async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

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
    std::thread::spawn(login_path);
    let mut builder = tauri::Builder::default();
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_mcp_bridge::Builder::new().bind_address("127.0.0.1").build());
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(fs::WatchState::default())
        .manage(lsp::LspState::default())
        .manage(lsp::AiRequests::default())
        .manage(pty::PtyState::default())
        .invoke_handler(tauri::generate_handler![
            db::db_query,
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
            lsp::lsp_stop,
            lsp::ai_start,
            lsp::ai_request,
            lsp::ai_cancel,
            tools::tool_path,
            tools::path_exists,
            tools::paths_exist,
            tools::run_capture,
            search::list_files,
            search::search_text,
            search::files_matching,
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
