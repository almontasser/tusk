use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize)]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Default)]
pub struct WatchState(Mutex<Option<notify::RecommendedWatcher>>);

#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut entries: Vec<Entry> = std::fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| !matches!(e.file_name().to_str(), Some(".git" | ".DS_Store")))
        .map(|e| Entry {
            name: e.file_name().to_string_lossy().into(),
            path: e.path().to_string_lossy().into(),
            is_dir: e.file_type().map(|t| t.is_dir()).unwrap_or(false),
        })
        .collect();
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    std::fs::rename(from, to).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) }.map_err(|e| e.to_string())
}

/// Watches `path` recursively and emits `fs-change` with the changed paths.
/// Replaces any previous watcher, so only one project is watched at a time.
#[tauri::command]
pub fn watch(app: AppHandle, state: State<WatchState>, path: String) -> Result<(), String> {
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let paths: Vec<String> = event.paths.iter().map(|p| p.to_string_lossy().into()).collect();
            let _ = app.emit("fs-change", paths);
        }
    })
    .map_err(|e| e.to_string())?;
    watcher.watch(path.as_ref(), RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = Some(watcher);
    Ok(())
}
