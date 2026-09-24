use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// Runs its arguments as a command that is killed if this app dies. Language servers
/// often ignore the LSP `processId` and outlive a crashed or force-quit editor. The shell
/// starts a loop that watches the app's PID, then `exec`s the server, so the server keeps
/// the shell's PID and `Child::kill` still reaches it.
const WATCHDOG: &str = r#"app=$PPID; (while kill -0 "$app" && kill -0 $$; do sleep 2; done; kill $$) >/dev/null 2>&1 </dev/null & exec "$@""#;

/// Running language servers by name.
#[derive(Default)]
pub struct LspState(Mutex<HashMap<String, (Child, ChildStdin)>>);

impl LspState {
    pub fn stop_all(&self) {
        for (_, (mut child, _)) in self.0.lock().unwrap().drain() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub fn tools_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().resource_dir().map_err(|e| e.to_string())?.join("tools"))
}

/// Starts the bundled language server `name` for `root`, replacing a running one with the
/// same name. Each message from the server is emitted as a `lsp:<name>` event (raw JSON).
/// Returns this app's process ID, which the client sends as `processId` so that servers
/// exit if the app dies without stopping them.
#[tauri::command]
pub fn lsp_start(app: AppHandle, state: State<LspState>, name: String, root: String) -> Result<u32, String> {
    let args = match name.as_str() {
        "phpactor" => vec!["phpactor.phar", "language-server"],
        "laravel" => vec!["laravel-lsp.phar"],
        _ => return Err(format!("Unknown language server: {name}")),
    };
    let tools = tools_dir(&app)?;
    let mut child = Command::new("/bin/sh")
        .args(["-c", WATCHDOG, "sh", "php"])
        .arg(tools.join(args[0]))
        .args(&args[1..])
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Could not start PHP. Is `php` installed? ({e})"))?;
    let stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let event = format!("lsp:{name}");
    std::thread::spawn(move || {
        while let Ok(Some(msg)) = read_message(&mut stdout) {
            let _ = app.emit(&event, msg);
        }
    });
    if let Some((mut old, _)) = state.0.lock().unwrap().insert(name, (child, stdin)) {
        let _ = old.kill();
        let _ = old.wait();
    }
    Ok(std::process::id())
}

#[tauri::command]
pub fn lsp_send(state: State<LspState>, name: String, msg: String) -> Result<(), String> {
    let mut servers = state.0.lock().unwrap();
    let (_, stdin) = servers.get_mut(&name).ok_or_else(|| format!("{name} is not running"))?;
    write!(stdin, "Content-Length: {}\r\n\r\n{msg}", msg.len())
        .and_then(|_| stdin.flush())
        .map_err(|e| e.to_string())
}

/// Reads one `Content-Length`-framed JSON-RPC message. Returns `None` at end of stream.
fn read_message(r: &mut impl BufRead) -> std::io::Result<Option<String>> {
    let mut len = None;
    loop {
        let mut line = String::new();
        if r.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some(v) = line.strip_prefix("Content-Length:") {
            len = v.trim().parse::<usize>().ok();
        }
    }
    let mut body = vec![0; len.ok_or_else(|| std::io::Error::other("missing Content-Length"))?];
    r.read_exact(&mut body)?;
    Ok(Some(String::from_utf8_lossy(&body).into()))
}

#[cfg(test)]
mod tests {
    use super::read_message;

    #[test]
    fn reads_framed_messages() {
        let body = r#"{"jsonrpc":"2.0","id":1,"result":"é"}"#;
        let input = format!(
            "Content-Length: {}\r\nContent-Type: application/vscode-jsonrpc\r\n\r\n{body}Content-Length: 2\r\n\r\n{{}}",
            body.len()
        );
        let mut r = input.as_bytes();
        assert_eq!(read_message(&mut r).unwrap().as_deref(), Some(body));
        assert_eq!(read_message(&mut r).unwrap().as_deref(), Some("{}"));
        assert_eq!(read_message(&mut r).unwrap(), None);
    }
}
