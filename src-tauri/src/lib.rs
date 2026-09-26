mod db;
mod fs;
mod lsp;
mod profile;
mod pty;
mod search;
mod tools;
mod ws;

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

/// macOS 27 shows its "Write with Siri" button beside the caret of any text client that allows the Writing
/// Tools affordance, including the terminal's and the editor's hidden textareas. WKWebView always allows it,
/// and neither `writingToolsBehavior` nor `writingsuggestions` stops it, so the webview's own class (wry's
/// subclass) gets an `allowsWritingToolsAffordance` that answers no. Older macOS never asks.
#[cfg(target_os = "macos")]
fn hide_write_with_siri(webview: *mut std::ffi::c_void) {
    use std::ffi::{c_char, c_void};
    extern "C" {
        fn object_getClass(obj: *const c_void) -> *const c_void;
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn class_replaceMethod(cls: *const c_void, sel: *const c_void, imp: *const c_void, types: *const c_char) -> *const c_void;
    }
    extern "C" fn no(_this: *const c_void, _sel: *const c_void) -> bool {
        false
    }
    // Safety: adds a method that takes no arguments and returns BOOL ("B@:") to the webview's class.
    unsafe {
        class_replaceMethod(object_getClass(webview), sel_registerName(c"allowsWritingToolsAffordance".as_ptr()), no as *const c_void, c"B@:".as_ptr());
    }
}

/// Checks the latest GitHub release at launch and, if it's newer, offers to install it. The new version
/// replaces the app on disk but starts at the next launch, so nothing open, such as unsaved edits, is lost.
#[cfg(not(debug_assertions))]
async fn check_for_update(app: tauri::AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    use tauri_plugin_updater::UpdaterExt;
    let Ok(Some(update)) = async { app.updater()?.check().await }.await else {
        return;
    };
    let ask = format!("Tusk {} is available. You have {}.", update.version, update.current_version);
    let install = app
        .dialog()
        .message(ask)
        .title("Update available")
        .buttons(MessageDialogButtons::OkCancelCustom("Install".into(), "Later".into()))
        .blocking_show();
    if !install {
        return;
    }
    let done = match update.download_and_install(|_, _| {}, || {}).await {
        Ok(()) => format!("Tusk {} is installed. It opens the next time you start Tusk.", update.version),
        Err(e) => format!("The update couldn't be installed: {e}"),
    };
    app.dialog().message(done).title("Update").blocking_show();
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        // The window only ever shows the app. Rendered content, such as a pull request's Markdown, opens its
        // links in the browser; this stops any link that slips through from replacing the editor.
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("stay-in-app")
                .on_navigation(|_, url| {
                    matches!(url.scheme(), "tauri" | "about" | "data" | "blob")
                        || matches!(url.host_str(), Some("localhost" | "tauri.localhost" | "127.0.0.1"))
                })
                .build(),
        )
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            if let Some(window) = _app.get_webview_window("main") {
                window.with_webview(|w| hide_write_with_siri(w.inner()))?;
            }
            #[cfg(not(debug_assertions))]
            tauri::async_runtime::spawn(check_for_update(_app.handle().clone()));
            Ok(())
        })
        .manage(fs::WatchState::default())
        .manage(lsp::LspState::default())
        .manage(lsp::AiRequests::default())
        .manage(pty::PtyState::default())
        .manage(db::Tunnels::default())
        .manage(ws::WsState::default())
        .invoke_handler(tauri::generate_handler![
            db::db_query,
            db::db_batch,
            db::db_tunnel,
            fs::read_dir,
            fs::read_file,
            profile::parse_profile,
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
            pty::pty_cwd,
            ws::ws_connect,
            ws::ws_send,
            ws::ws_close,
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
