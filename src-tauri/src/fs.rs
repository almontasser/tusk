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
            path: crate::slash(e.path()),
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

#[derive(Serialize)]
pub struct Text {
    text: String,
    /// The encoding detected for a file that isn't valid UTF-8, when no charset was given.
    charset: Option<String>,
}

/// Reads a project file like `read_file`, but without a charset, a file that isn't valid UTF-8
/// opens in the encoding it most likely has, which `write_file` then takes.
#[tauri::command]
pub async fn read_text(path: String, charset: Option<String>) -> Result<Text, String> {
    crate::blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        if charset.is_some() || std::str::from_utf8(&bytes).is_ok() {
            return Ok(Text { text: decode(bytes, charset.as_deref())?, charset: None });
        }
        let detected = detect(&bytes)?;
        Ok(Text { text: decode(bytes, Some(detected))?, charset: Some(detected.to_string()) })
    })
    .await
}

/// The encoding of text that isn't UTF-8: UTF-16 from its byte-order mark, or chardetng's guess.
fn detect(bytes: &[u8]) -> Result<&'static str, String> {
    match encoding_rs::Encoding::for_bom(bytes) {
        Some((e, _)) if e == encoding_rs::UTF_16LE => return Ok("utf-16le"),
        Some((e, _)) if e == encoding_rs::UTF_16BE => return Ok("utf-16be"),
        _ => {}
    }
    if bytes.contains(&0) {
        return Err("The file looks binary.".to_string());
    }
    let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
    detector.feed(bytes, true);
    let guess = detector.guess(None, chardetng::Utf8Detection::Deny);
    // A guess that can't decode every byte would lose some when saved. Windows-1252 decodes any bytes.
    Ok(if guess.decode_without_bom_handling_and_without_replacement(bytes).is_some() { guess } else { encoding_rs::WINDOWS_1252 }.name())
}

/// A file's bytes, such as an image in a Markdown preview, which the page gets as an `ArrayBuffer`.
#[tauri::command]
pub async fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    crate::blocking(move || std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())).await
}

/// Writes a file, encoded in `charset` (an `.editorconfig` value or an encoding name) or else UTF-8.
#[tauri::command]
pub async fn write_file(path: String, contents: String, charset: Option<String>) -> Result<(), String> {
    crate::blocking(move || {
        let bytes = encode(&contents, charset.as_deref())?;
        std::fs::write(path, bytes).map_err(|e| e.to_string())
    })
    .await
}

const BOM: &str = "\u{feff}";

/// Decodes a file in one of `.editorconfig`'s charsets, or in an encoding by name. Every one is
/// strict, so the text saves back as the same bytes. A byte-order mark is dropped, and `encode`
/// adds it back.
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
        Some(label) if label != "utf-8" => encoding(label)?
            .decode_without_bom_handling_and_without_replacement(&bytes)
            .ok_or_else(|| format!("The file isn't valid {label}."))?
            .into_owned(),
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
        Some(label) if label != "utf-8" => {
            let (bytes, _, unmappable) = encoding(label)?.encode(text);
            if unmappable {
                return Err(format!("The text has characters that {label}, the file's encoding, can't hold."));
            }
            bytes.into_owned()
        }
        _ => text.as_bytes().to_vec(),
    })
}

/// An encoding by name, such as `windows-1252` or `Shift_JIS`.
fn encoding(label: &str) -> Result<&'static encoding_rs::Encoding, String> {
    encoding_rs::Encoding::for_label(label.as_bytes()).ok_or_else(|| format!("Unknown encoding {label}."))
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

/// Removes a folder only when it's empty, as after undoing a refactoring that created a file in a new folder.
#[tauri::command]
pub fn remove_empty_dir(path: String) -> Result<(), String> {
    std::fs::remove_dir(path).map_err(|e| e.to_string())
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
            changed.lock().unwrap().extend(event.paths.iter().map(crate::slash));
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
    fn detects_other_encodings() {
        // "Größe café" in Windows-1252.
        let latin = b"Gr\xf6\xdfe caf\xe9".to_vec();
        assert_eq!(detect(&latin).unwrap(), "windows-1252");
        let text = decode(latin.clone(), Some("windows-1252")).unwrap();
        assert_eq!(text, "Größe café");
        assert_eq!(encode(&text, Some("windows-1252")).unwrap(), latin);
        assert!(encode("✓", Some("windows-1252")).is_err());
        // Bytes Windows-1252 leaves undefined still save back as they were.
        let odd = b"\x81\x8d\x8f\x90\x9d".to_vec();
        assert_eq!(encode(&decode(odd.clone(), Some("windows-1252")).unwrap(), Some("windows-1252")).unwrap(), odd);
        // "日本語のテキスト" in Shift_JIS.
        let sjis = b"\x93\xfa\x96\x7b\x8c\xea\x82\xcc\x83\x65\x83\x4c\x83\x58\x83\x67".to_vec();
        assert_eq!(detect(&sjis).unwrap(), "Shift_JIS");
        assert_eq!(decode(sjis, Some("Shift_JIS")).unwrap(), "日本語のテキスト");
        assert_eq!(detect(&[0xff, 0xfe, b'a', 0]).unwrap(), "utf-16le");
        assert!(detect(&[0x89, b'P', b'N', b'G', 0, 0]).is_err());
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
