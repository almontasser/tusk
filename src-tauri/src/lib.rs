mod fs;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_mcp_bridge::Builder::new().bind_address("127.0.0.1").build());
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(fs::WatchState::default())
        .invoke_handler(tauri::generate_handler![fs::read_dir, fs::read_file, fs::write_file, fs::watch])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
