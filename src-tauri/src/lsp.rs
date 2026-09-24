use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct LspState(Mutex<Option<(Child, ChildStdin)>>);

/// Starts the bundled Phpactor language server for `root`, replacing any running one.
/// Each message from the server is emitted to the frontend as an `lsp` event (raw JSON).
#[tauri::command]
pub fn lsp_start(app: AppHandle, state: State<LspState>, root: String) -> Result<(), String> {
    let phar = app.path().resource_dir().map_err(|e| e.to_string())?.join("tools/phpactor.phar");
    let mut child = Command::new("php")
        .arg(phar)
        .arg("language-server")
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Could not start PHP. Is `php` installed? ({e})"))?;
    let stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    std::thread::spawn(move || {
        while let Ok(Some(msg)) = read_message(&mut stdout) {
            let _ = app.emit("lsp", msg);
        }
    });
    if let Some((mut old, _)) = state.0.lock().unwrap().replace((child, stdin)) {
        let _ = old.kill();
        let _ = old.wait();
    }
    Ok(())
}

#[tauri::command]
pub fn lsp_send(state: State<LspState>, msg: String) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    let (_, stdin) = guard.as_mut().ok_or("Language server is not running")?;
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
