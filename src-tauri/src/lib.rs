pub mod askpass;
mod db;
mod fs;
mod grpc;
mod lsp;
mod profile;
mod pty;
mod search;
mod tools;
mod toolpaths;
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

/// A path the way the frontend writes paths. On Windows that's with `/` between folders and a lowercase drive
/// letter, as in Monaco's URIs (`c:/Users/me/app`); Windows takes either separator.
pub fn slash(path: impl AsRef<std::path::Path>) -> String {
    let path = path.as_ref().to_string_lossy();
    #[cfg(windows)]
    {
        let mut path = path.replace('\\', "/");
        if path.as_bytes().get(1) == Some(&b':') {
            path[..1].make_ascii_lowercase();
        }
        path
    }
    #[cfg(not(windows))]
    path.into_owned()
}

/// Runs blocking work on Tauri's blocking thread pool, so it holds neither the main thread (which
/// draws the window and handles every command) nor the async workers.
pub async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

/// Windows apps get the full PATH from the registry, so there's nothing to read.
#[cfg(windows)]
fn use_login_shell_path() {}

#[cfg(not(windows))]
fn use_login_shell_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| toolpaths::default_shell().into());
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

/// Checks the latest GitHub release for a newer version and offers to install it. The new version replaces the
/// app on disk but starts at the next launch, so nothing open, such as unsaved edits, is lost. The periodic
/// check (`manual` false) stays quiet when there's nothing new and asks once per version; Check for Updates
/// always answers.
async fn update_check(app: tauri::AppHandle, manual: bool) {
    use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
    use tauri::Emitter;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    use tauri_plugin_updater::UpdaterExt;
    static CHECKING: AtomicBool = AtomicBool::new(false);
    static OFFERED: Mutex<Option<String>> = Mutex::new(None);
    static INSTALLED: Mutex<Option<String>> = Mutex::new(None);
    let say = |text: String| {
        app.dialog().message(text).title("Updates").blocking_show();
    };
    if cfg!(debug_assertions) {
        return say("Development builds don't update.".into());
    }
    if CHECKING.swap(true, Ordering::SeqCst) {
        return;
    }
    match async { app.updater()?.check().await }.await {
        Err(e) if manual => say(format!("Couldn't check for updates: {e}")),
        Ok(None) if manual => say(format!("Tusk {} is the latest version.", app.package_info().version)),
        Ok(Some(update)) if INSTALLED.lock().unwrap().as_ref() == Some(&update.version) => {
            if manual {
                say(format!("Tusk {} is installed. It opens the next time you start Tusk.", update.version));
            }
        }
        Ok(Some(update)) if manual || OFFERED.lock().unwrap().as_ref() != Some(&update.version) => {
            *OFFERED.lock().unwrap() = Some(update.version.clone());
            let install = app
                .dialog()
                .message(format!("Tusk {} is available. You have {}.", update.version, update.current_version))
                .title("Update available")
                .buttons(MessageDialogButtons::OkCancelCustom("Install".into(), "Later".into()))
                .blocking_show();
            if install {
                // Progress shows in the status bar, as the frontend's "update:progress" status.
                let progress = |text: String| _ = app.emit("update-progress", text);
                let (mut done, mut shown) = (0, String::new());
                let result = update
                    .download_and_install(
                        |chunk, total| {
                            done += chunk as u64;
                            let text = match total {
                                Some(t) => format!("Downloading Tusk {}: {}%", update.version, done * 100 / t.max(1)),
                                None => format!("Downloading Tusk {}: {} MB", update.version, done >> 20),
                            };
                            if text != shown {
                                progress(text.clone());
                                shown = text;
                            }
                        },
                        || progress(format!("Installing Tusk {}", update.version)),
                    )
                    .await;
                progress(String::new());
                match result {
                    Ok(()) => {
                        *INSTALLED.lock().unwrap() = Some(update.version.clone());
                        let restart = app
                            .dialog()
                            .message(format!("Tusk {} is installed. Restart now to use it, or it opens the next time you start Tusk.", update.version))
                            .title("Update installed")
                            .buttons(MessageDialogButtons::OkCancelCustom("Restart Now".into(), "Later".into()))
                            .blocking_show();
                        // The frontend saves or asks about unsaved edits first, then calls `restart`.
                        if restart {
                            _ = app.emit("update-restart", ());
                        }
                    }
                    Err(e) => say(format!("The update couldn't be installed: {e}")),
                }
            }
        }
        _ => {}
    }
    CHECKING.store(false, Ordering::SeqCst);
}

#[tauri::command]
async fn check_update(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(tools::check_tools(app.clone()));
    update_check(app, true).await;
}

/// Restarts through the normal exit, so language servers stop first.
#[tauri::command]
fn restart(app: tauri::AppHandle) {
    app.request_restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    std::thread::spawn(login_path);
    let builder = tauri::Builder::default();
    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::Builder::new().bind_address("127.0.0.1").build());
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
            toolpaths::init(_app.handle());
            askpass::start(_app.handle().clone());
            #[cfg(target_os = "macos")]
            if let Some(window) = _app.get_webview_window("main") {
                window.with_webview(|w| hide_write_with_siri(w.inner()))?;
            }
            #[cfg(not(debug_assertions))]
            {
                let app = _app.handle().clone();
                // Tools are also checked at launch, by `tools_ensure` once the tools are known to be installed.
                // Settings > Tools can turn the checks off, for offline or locked-down Macs; Check for Updates still works.
                std::thread::spawn(move || loop {
                    if toolpaths::auto_checks(&app) {
                        tauri::async_runtime::block_on(update_check(app.clone(), false));
                    }
                    std::thread::sleep(std::time::Duration::from_secs(6 * 60 * 60));
                    if toolpaths::auto_checks(&app) {
                        tauri::async_runtime::block_on(tools::check_tools(app.clone()));
                    }
                });
            }
            Ok(())
        })
        .manage(fs::WatchState::default())
        .manage(lsp::LspState::default())
        .manage(lsp::AiRequests::default())
        .manage(pty::PtyState::default())
        .manage(db::Tunnels::default())
        .manage(ws::WsState::default())
        .manage(grpc::GrpcState::default())
        .invoke_handler(tauri::generate_handler![
            askpass::askpass_env,
            askpass::askpass_answer,
            db::db_query,
            db::db_batch,
            db::db_cancel,
            db::redis_call,
            db::db_tunnel,
            db::db_password,
            db::db_set_password,
            fs::read_dir,
            fs::read_file,
            fs::read_text,
            fs::read_file_bytes,
            profile::parse_profile,
            fs::write_file,
            fs::rename_path,
            fs::remove_path,
            fs::create_file,
            fs::create_dir,
            fs::remove_empty_dir,
            fs::trash_path,
            fs::watch,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            lsp::toml_edit,
            lsp::toml_read,
            lsp::mago_settings,
            lsp::ai_start,
            lsp::ai_request,
            lsp::ai_cancel,
            tools::tool_path,
            tools::tools_ensure,
            tools::path_exists,
            tools::paths_exist,
            tools::run_capture,
            tools::open_url,
            tools::reveal_path,
            toolpaths::tools_configure,
            toolpaths::tool_which,
            search::list_files,
            search::search_text,
            search::search_cancel,
            search::files_matching,
            search::replace_text,
            search::replacements,
            search::symbol_free_folders,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_cwd,
            ws::ws_connect,
            ws::ws_send,
            ws::ws_close,
            grpc::grpc_call,
            grpc::grpc_cancel,
            grpc::grpc_methods,
            check_update,
            restart,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Language servers keep running when their parent dies, so stop them on quit.
            if let tauri::RunEvent::Exit = event {
                app.state::<lsp::LspState>().stop_all();
            }
            // A restart after an update starts the app itself, not through the Dock or Finder, so macOS leaves
            // it behind the app that was in front.
            if let tauri::RunEvent::Ready = event {
                if let Some(window) = app.get_webview_window("main") {
                    _ = window.set_focus();
                }
            }
        });
}
