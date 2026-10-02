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
    let command = command.filter(|c| !c.is_empty()).unwrap_or_else(|| follow_location(crate::toolpaths::shell()));
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

/// Windows keeps a process's folder in its process parameters, which only the process itself has an API for, so this
/// reads them from its memory: the PEB, its `ProcessParameters` (at 0x20), and their `CurrentDirectory` (at 0x38), a
/// counted UTF-16 string. The offsets are the 64-bit layout's, which every Windows the app runs on uses.
#[cfg(windows)]
fn process_cwd(pid: u32) -> Option<String> {
    use windows_sys::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation};
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_BASIC_INFORMATION, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
        if process.is_null() {
            return None;
        }
        let read = |address: usize, buf: &mut [u8]| ReadProcessMemory(process, address as _, buf.as_mut_ptr().cast(), buf.len(), std::ptr::null_mut()) != 0;
        let cwd = (|| {
            let mut info = PROCESS_BASIC_INFORMATION::default();
            let size = std::mem::size_of::<PROCESS_BASIC_INFORMATION>() as u32;
            if NtQueryInformationProcess(process, ProcessBasicInformation, (&mut info as *mut PROCESS_BASIC_INFORMATION).cast(), size, std::ptr::null_mut()) != 0 {
                return None;
            }
            let mut params = [0u8; 8];
            read(info.PebBaseAddress as usize + 0x20, &mut params).then_some(())?;
            let mut dir = [0u8; 16];
            read(usize::from_le_bytes(params) + 0x38, &mut dir).then_some(())?;
            // Length in bytes, then the buffer's address after 4 bytes of padding. A folder is under 32,767 characters.
            let len = u16::from_le_bytes([dir[0], dir[1]]) as usize;
            let mut text = vec![0u8; len];
            read(usize::from_le_bytes(dir[8..].try_into().ok()?), &mut text).then_some(())?;
            let wide: Vec<u16> = text.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            Some(String::from_utf16_lossy(&wide))
        })();
        CloseHandle(process);
        cwd.map(|dir| without_trailing_separator(&dir).to_string())
    }
}

/// A Windows folder as its process keeps it, `C:\Users\me\`, without the separator at the end, which a drive's root keeps.
#[cfg_attr(not(windows), allow(dead_code))]
fn without_trailing_separator(dir: &str) -> &str {
    let trimmed = dir.trim_end_matches('\\');
    if trimmed.ends_with(':') { dir } else { trimmed }
}

/// PowerShell's `cd` moves PowerShell's own location, not its process's folder, which is what `pty_cwd` reads. So the
/// terminal's PowerShell gets a prompt that moves the folder along, wrapping the prompt from your profile. A shell from
/// Settings that runs its own command or script keeps its arguments.
fn follow_location(mut shell: Vec<String>) -> Vec<String> {
    const PROMPT: &str = "$global:TuskPrompt = $function:prompt\n\
        function global:prompt { if ($PWD.Provider.Name -eq 'FileSystem') { [Environment]::CurrentDirectory = $PWD.ProviderPath }; & $global:TuskPrompt }";
    let name = std::path::Path::new(&shell[0]).file_stem().map(|s| s.to_string_lossy().to_lowercase());
    // -Command, -File, -EncodedCommand, or -NoExit, by any prefix PowerShell takes (not -ExecutionPolicy), or a script.
    let own = shell[1..].iter().any(|a| {
        let a = a.to_lowercase();
        ["-c", "-f", "-noe", "-ec", "-en"].iter().any(|p| a.starts_with(p)) || a == "-e" || !a.starts_with('-')
    });
    if matches!(name.as_deref(), Some("powershell" | "pwsh")) && !own {
        use base64::Engine;
        let utf16: Vec<u8> = PROMPT.encode_utf16().flat_map(u16::to_le_bytes).collect();
        shell.extend(["-NoExit".into(), "-EncodedCommand".into(), base64::engine::general_purpose::STANDARD.encode(utf16)]);
    }
    shell
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
    use super::{follow_location, take_utf8, without_trailing_separator};

    #[test]
    fn powershell_moves_its_folder_with_its_location() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let shell = follow_location(args(&["powershell.exe", "-NoLogo"]));
        assert_eq!(shell[1..4], args(&["-NoLogo", "-NoExit", "-EncodedCommand"]));
        assert!(shell[4].len() > 100);
        assert_eq!(follow_location(args(&[r"C:\Program Files\PowerShell\7\pwsh.exe", "-ExecutionPolicy", "Bypass"])).len(), 3);
        assert_eq!(follow_location(args(&["pwsh", "-ExecutionPolicy", "RemoteSigned"]))[1..], args(&["-ExecutionPolicy", "RemoteSigned"]));
        assert_eq!(follow_location(args(&["pwsh", "-NoLogo"])).len(), 5);
        // Its own command, script, or -NoExit: left as it is.
        for own in [&["pwsh", "-Command", "Get-Date"][..], &["pwsh", "-c", "x"], &["powershell", "-File", "a.ps1"], &["pwsh", "-NoExit"], &["pwsh", "a.ps1"]] {
            assert_eq!(follow_location(args(own)), args(own));
        }
        assert_eq!(follow_location(args(&["cmd.exe"])), args(&["cmd.exe"]));
        assert_eq!(follow_location(args(&["bash", "-l"])), args(&["bash", "-l"]));
    }

    #[test]
    fn a_windows_folder_loses_its_trailing_separator() {
        assert_eq!(without_trailing_separator(r"C:\Users\me\"), r"C:\Users\me");
        assert_eq!(without_trailing_separator(r"C:\"), r"C:\");
        assert_eq!(without_trailing_separator(r"\\server\share\dir\"), r"\\server\share\dir");
    }

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
