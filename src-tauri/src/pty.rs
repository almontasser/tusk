use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

struct Session {
    /// Input goes through a thread, so pasting into a program that isn't reading can't block the app.
    writer: std::sync::mpsc::Sender<Vec<u8>>,
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
#[tauri::command(async)]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    cwd: String,
    command: Option<Vec<String>>,
    rows: u16,
    cols: u16,
) -> Result<u32, String> {
    crate::login_path();
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
    let mut input = pair.master.take_writer().map_err(|e| e.to_string())?;
    let (writer, keys) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(data) = keys.recv() {
            if input.write_all(&data).and_then(|_| input.flush()).is_err() {
                break;
            }
        }
    });
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    state.0.lock().unwrap().insert(id, Session { writer, master: pair.master, child });

    // One thread reads, and another sends: output that arrives while an event is being sent is
    // joined into the next one, so a command that prints a lot sends a few large events, not
    // thousands of small ones. Nothing waits, so an echoed keystroke goes out at once.
    let (chunks, output) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 65536];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || chunks.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    std::thread::spawn(move || {
        let event = format!("pty:{id}");
        let mut pending = Vec::new();
        while let Ok(chunk) = output.recv() {
            pending.extend_from_slice(&chunk);
            pending.extend(output.try_iter().flatten());
            let text = take_utf8(&mut pending);
            if !text.is_empty() {
                let _ = app.emit(&event, text);
            }
        }
        let _ = app.emit(&format!("pty-exit:{id}"), ());
    });
    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<PtyState>, id: u32, data: String) -> Result<(), String> {
    let sessions = state.0.lock().unwrap();
    let s = sessions.get(&id).ok_or("Terminal is closed")?;
    s.writer.send(data.into_bytes()).map_err(|_| "Terminal is closed".to_string())
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
