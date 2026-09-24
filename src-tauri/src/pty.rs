use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// Open terminal sessions by ID. When the app exits, the operating system closes the
/// pseudo-terminals and their processes receive SIGHUP, so nothing outlives the app.
#[derive(Default)]
pub struct PtyState(Mutex<HashMap<u32, Session>>);

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// Starts `command` (or a login shell) in a pseudo-terminal. Output arrives as
/// `pty:<id>` events, and `pty-exit:<id>` fires when the process ends.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<PtyState>,
    cwd: String,
    command: Option<Vec<String>>,
    rows: u16,
    cols: u16,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let mut cmd = match command.as_deref() {
        Some([program, args @ ..]) => {
            let mut c = CommandBuilder::new(program);
            c.args(args);
            c
        }
        _ => {
            let mut c = CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()));
            c.arg("-l");
            c
        }
    };
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    state.0.lock().unwrap().insert(id, Session { writer, master: pair.master, child });

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending = Vec::new();
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            pending.extend_from_slice(&buf[..n]);
            let text = take_utf8(&mut pending);
            if !text.is_empty() {
                let _ = app.emit(&format!("pty:{id}"), text);
            }
        }
        let _ = app.emit(&format!("pty-exit:{id}"), ());
    });
    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<PtyState>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = state.0.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("Terminal is closed")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<PtyState>, id: u32, rows: u16, cols: u16) -> Result<(), String> {
    let sessions = state.0.lock().unwrap();
    let s = sessions.get(&id).ok_or("Terminal is closed")?;
    s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<PtyState>, id: u32) {
    if let Some(mut s) = state.0.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
}

/// Takes the longest valid UTF-8 prefix from `buf`, leaving a character that was split
/// across reads for the next call. Invalid bytes become U+FFFD.
fn take_utf8(buf: &mut Vec<u8>) -> String {
    let valid = match std::str::from_utf8(buf) {
        Ok(_) => buf.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(), // Incomplete character at the end.
        Err(_) => buf.len(),                                  // Invalid bytes: decode lossily.
    };
    let text = String::from_utf8_lossy(&buf[..valid]).into_owned();
    buf.drain(..valid);
    text
}

#[cfg(test)]
mod tests {
    use super::take_utf8;

    #[test]
    fn keeps_split_characters_for_the_next_read() {
        let bytes = "é✓".as_bytes(); // 2 + 3 bytes
        let mut buf = bytes[..3].to_vec(); // "é" plus the first byte of "✓"
        assert_eq!(take_utf8(&mut buf), "é");
        assert_eq!(buf.len(), 1);
        buf.extend_from_slice(&bytes[3..]);
        assert_eq!(take_utf8(&mut buf), "✓");
        assert!(buf.is_empty());

        let mut invalid = vec![b'a', 0xff, b'b'];
        assert_eq!(take_utf8(&mut invalid), "a\u{fffd}b");
    }
}
