// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The app's own binary is also its PHP language server, started as a child process by `lsp_start`.
    if std::env::args().nth(1).as_deref() == Some("lsp") {
        tusk_lsp::run_stdio();
        return;
    }
    // Started by git or ssh as GIT_ASKPASS or SSH_ASKPASS from a command the app ran (see askpass.rs).
    if let Ok(socket) = std::env::var("TUSK_ASKPASS") {
        php_editor_lib::askpass::client(&socket);
    }
    php_editor_lib::run()
}
