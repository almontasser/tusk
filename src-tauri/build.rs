fn main() {
    tauri_build::build();
    fresh_executables();
}

/// Tauri copies resources over the previous build's files in place. macOS caches a binary's code signature per
/// file, so a tool rewritten in place while the running app had used it (Mago) fails its check afterwards, and
/// macOS kills it partway through larger runs. Writing each executable as a new file clears that.
fn fresh_executables() {
    use std::os::unix::fs::PermissionsExt;
    let Some(tools) = std::env::var_os("OUT_DIR").map(|out| std::path::PathBuf::from(out).join("../../../tools")) else { return };
    let Ok(entries) = std::fs::read_dir(&tools) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let executable = entry.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0);
        let fresh = path.with_extension("fresh");
        if executable && std::fs::copy(&path, &fresh).is_ok() {
            let _ = std::fs::rename(&fresh, &path);
        }
    }
}
