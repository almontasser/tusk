use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

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

/// Starts `command` (or the shell from Settings > Terminal) in a pseudo-terminal. Output arrives as
/// `pty:<id>` events, and `pty-exit:<id>` fires when the process ends. With a `channel`, the
/// events are `pty:<channel>` and `pty-exit:<channel>` instead, so the caller can listen before
/// the process starts and miss nothing from a command that finishes at once.
#[tauri::command(async)]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    cwd: String,
    command: Option<Vec<String>>,
    rows: u16,
    cols: u16,
    channel: Option<String>,
) -> Result<u32, String> {
    let command = command.filter(|c| !c.is_empty()).unwrap_or_else(crate::toolpaths::shell);
    crate::toolpaths::check(&command)?;
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(crate::toolpaths::resolve(&command[0]));
    cmd.args(&command[1..]);
    cmd.cwd(cwd);
    cmd.env("PATH", crate::toolpaths::path_env_for(&command[0]));
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
        let name = channel.unwrap_or_else(|| id.to_string());
        let event = format!("pty:{name}");
        let mut pending = Vec::new();
        while let Ok(chunk) = output.recv() {
            pending.extend_from_slice(&chunk);
            pending.extend(output.try_iter().flatten());
            let text = take_utf8(&mut pending);
            if !text.is_empty() {
                let _ = app.emit(&event, text);
            }
        }
        let _ = app.emit(&format!("pty-exit:{name}"), exit_code(&app, id));
    });
    Ok(id)
}

/// The exit code of a session's process once its output has ended, or None when it was killed or takes over a
/// second to exit. The output ends when the process closes the terminal, which is usually as it exits.
fn exit_code(app: &AppHandle, id: u32) -> Option<u32> {
    for _ in 0..50 {
        let state = app.state::<PtyState>();
        let mut sessions = state.0.lock().unwrap();
        match sessions.get_mut(&id)?.child.try_wait() {
            Ok(Some(status)) => return Some(status.exit_code()),
            Ok(None) => {}
            Err(_) => return None,
        }
        drop(sessions);
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    None
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

/// The folder a terminal's process is in, such as a shell after `cd`, so a restored shell starts there.
#[tauri::command]
pub fn pty_cwd(state: State<PtyState>, id: u32) -> Option<String> {
    let pid = state.0.lock().unwrap().get(&id)?.child.process_id()?;
    process_cwd(pid).map(crate::slash)
}

#[cfg(target_os = "macos")]
fn process_cwd(pid: u32) -> Option<String> {
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let read = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDVNODEPATHINFO, 0, &mut info as *mut _ as *mut libc::c_void, size) };
    if read != size {
        return None;
    }
    let path = unsafe { std::ffi::CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr() as *const libc::c_char) };
    Some(path.to_string_lossy().into_owned())
}

#[cfg(target_os = "linux")]
fn process_cwd(pid: u32) -> Option<String> {
    Some(std::fs::read_link(format!("/proc/{pid}/cwd")).ok()?.to_string_lossy().into_owned())
}

/// Windows doesn't let one process read another's folder simply, so a restored shell starts where it first did.
#[cfg(windows)]
fn process_cwd(_pid: u32) -> Option<String> {
    None
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
