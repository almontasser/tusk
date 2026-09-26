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
pub async fn read_dir(path: String) -> Result<Vec<Entry>, String> {
    crate::blocking(move || list_dir(&path)).await
}

fn list_dir(path: &str) -> Result<Vec<Entry>, String> {
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
    entries.sort_by_cached_key(|e| (!e.is_dir, e.name.to_lowercase()));
    Ok(entries)
}

#[tauri::command]
pub async fn read_file(path: String, charset: Option<String>) -> Result<String, String> {
    crate::blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        decode(bytes, charset.as_deref())
    })
    .await
}

/// A file's bytes, such as an image in a Markdown preview, which the page gets as an `ArrayBuffer`.
#[tauri::command]
pub async fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    crate::blocking(move || std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())).await
}

/// Writes a file, encoded in `charset` (an `.editorconfig` value) or else UTF-8.
#[tauri::command]
pub async fn write_file(path: String, contents: String, charset: Option<String>) -> Result<(), String> {
    crate::blocking(move || {
        let bytes = encode(&contents, charset.as_deref())?;
        std::fs::write(path, bytes).map_err(|e| e.to_string())
    })
    .await
}

const BOM: &str = "\u{feff}";

/// Decodes a file in one of `.editorconfig`'s charsets. UTF-8 (the default) must be valid; the
/// others can't fail. A byte-order mark is dropped, and `encode` adds it back.
fn decode(bytes: Vec<u8>, charset: Option<&str>) -> Result<String, String> {
    // Strict, like UTF-8: a file that isn't really UTF-16 would lose bytes when saved again.
    let utf16 = |bom: [u8; 2], unit: fn([u8; 2]) -> u16| {
        let body = bytes.strip_prefix(&bom[..]).unwrap_or(&bytes);
        let units: Vec<u16> = body.chunks_exact(2).map(|c| unit([c[0], c[1]])).collect();
        if body.len() % 2 == 1 {
            return Err("The file isn't valid UTF-16: it has an odd number of bytes.".to_string());
        }
        String::from_utf16(&units).map_err(|_| "The file isn't valid UTF-16.".to_string())
    };
    Ok(match charset {
        Some("latin1") => bytes.iter().map(|&b| b as char).collect(),
        Some("utf-16le") => utf16([0xff, 0xfe], u16::from_le_bytes)?,
        Some("utf-16be") => utf16([0xfe, 0xff], u16::from_be_bytes)?,
        Some("utf-8-bom") => {
            let text = String::from_utf8(bytes).map_err(|_| "The file isn't valid UTF-8.".to_string())?;
            text.strip_prefix(BOM).map(str::to_string).unwrap_or(text)
        }
        _ => String::from_utf8(bytes).map_err(|_| "The file isn't valid UTF-8. If it uses another encoding, set `charset` in .editorconfig.".to_string())?,
    })
}

/// Encodes text for `write_file`. Without a charset, the text is written as it is, so a UTF-8
/// file that starts with a byte-order mark keeps it; with one, the charset decides.
fn encode(text: &str, charset: Option<&str>) -> Result<Vec<u8>, String> {
    if charset.is_none() {
        return Ok(text.as_bytes().to_vec());
    }
    let text = text.strip_prefix(BOM).unwrap_or(text);
    Ok(match charset {
        Some("latin1") => text
            .chars()
            .map(|c| u8::try_from(c as u32).map_err(|_| format!("{c:?} can't be saved in Latin-1, the file's charset in .editorconfig.")))
            .collect::<Result<_, _>>()?,
        Some("utf-16le") => [0xff, 0xfe].into_iter().chain(text.encode_utf16().flat_map(u16::to_le_bytes)).collect(),
        Some("utf-16be") => [0xfe, 0xff].into_iter().chain(text.encode_utf16().flat_map(u16::to_be_bytes)).collect(),
        Some("utf-8-bom") => [BOM, text].concat().into_bytes(),
        _ => text.as_bytes().to_vec(),
    })
}

#[tauri::command(async)]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    // std::fs::rename silently replaces an existing file, so refuse instead.
    // Allow a change of case only, such as post.php to Post.php on a case-insensitive disk.
    if std::path::Path::new(&to).exists() && !from.eq_ignore_ascii_case(&to) {
        return Err(format!("{to} already exists"));
    }
    if let Some(parent) = std::path::Path::new(&to).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(from, to).map_err(|e| e.to_string())
}

/// Creates a file with `contents`, and any missing parent folders. Fails if the file exists.
#[tauri::command(async)]
pub fn create_file(path: String, contents: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(p).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => format!("{path} already exists"),
        _ => e.to_string(),
    })?;
    std::io::Write::write_all(&mut file, contents.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())
}

/// Moves a file or folder to the Trash, so a mistaken delete can be undone in Finder.
#[tauri::command]
pub async fn trash_path(path: String) -> Result<(), String> {
    crate::blocking(move || trash::delete(path).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn remove_path(path: String) -> Result<(), String> {
    crate::blocking(move || {
        let p = std::path::Path::new(&path);
        if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) }.map_err(|e| e.to_string())
    })
    .await
}

/// Watches `path` recursively and emits `fs-change` with the changed paths.
/// Replaces any previous watcher, so only one project is watched at a time.
/// Events are gathered for 50 ms and sent once without duplicates: `composer install` or a
/// checkout makes thousands of events, and one IPC message each would flood the webview.
#[tauri::command(async)]
pub fn watch(app: AppHandle, state: State<'_, WatchState>, path: String) -> Result<(), String> {
    let changed = std::sync::Arc::new(Mutex::new(std::collections::HashSet::<String>::new()));
    let pending = std::sync::Arc::downgrade(&changed);
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            changed.lock().unwrap().extend(event.paths.iter().map(|p| p.to_string_lossy().into_owned()));
        }
    })
    .map_err(|e| e.to_string())?;
    // The watcher owns the only strong reference, so this thread ends when the watcher is replaced.
    std::thread::spawn(move || {
        while let Some(changed) = pending.upgrade() {
            let paths: Vec<String> = changed.lock().unwrap().drain().collect();
            drop(changed);
            if !paths.is_empty() {
                let _ = app.emit("fs-change", paths);
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    });
    watcher.watch(path.as_ref(), RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = Some(watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_editorconfig_charsets() {
        let text = "é ✓\n";
        for charset in ["utf-8", "utf-8-bom", "utf-16le", "utf-16be"] {
            let bytes = encode(text, Some(charset)).unwrap();
            assert_eq!(decode(bytes, Some(charset)).unwrap(), text, "{charset}");
        }
        assert_eq!(encode("é", Some("latin1")).unwrap(), vec![0xe9]);
        assert_eq!(decode(vec![0xe9], Some("latin1")).unwrap(), "é");
        assert!(encode("✓", Some("latin1")).is_err());
        assert_eq!(&encode("a", Some("utf-8-bom")).unwrap()[..3], &[0xef, 0xbb, 0xbf]);
        assert_eq!(encode("a", Some("utf-16le")).unwrap(), vec![0xff, 0xfe, b'a', 0]);
        // Without a charset, a byte-order mark stays, and invalid UTF-8 is refused.
        assert_eq!(encode("\u{feff}a", None).unwrap(), "\u{feff}a".as_bytes());
        assert!(decode(vec![0xe9], None).is_err());
        assert!(decode(vec![0xff, 0xfe, b'a'], Some("utf-16le")).is_err());
    }

    #[test]
    fn never_overwrites_existing_files() {
        let dir = std::env::temp_dir().join(format!("php-editor-fs-{}", std::process::id()));
        let path = |name: &str| dir.join(name).to_string_lossy().to_string();
        std::fs::create_dir_all(&dir).unwrap();

        create_file(path("nested/a.php"), "a".into()).unwrap();
        assert!(create_file(path("nested/a.php"), "b".into()).is_err());
        create_file(path("b.php"), "b".into()).unwrap();

        assert!(rename_path(path("b.php"), path("nested/a.php")).is_err());
        assert_eq!(std::fs::read_to_string(path("nested/a.php")).unwrap(), "a");

        rename_path(path("b.php"), path("moved/deeper/b.php")).unwrap();
        assert_eq!(std::fs::read_to_string(path("moved/deeper/b.php")).unwrap(), "b");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
