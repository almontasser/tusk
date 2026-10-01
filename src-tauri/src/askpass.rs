// Answers git's and ssh's prompts, such as a password or a key's passphrase, in a dialog. Git commands that may
// prompt (`gitOutput` in src/git.ts) run with GIT_ASKPASS and SSH_ASKPASS set to this app's binary and
// TUSK_ASKPASS set to a socket the app listens on. The binary started that way (see main.rs) sends the prompt
// over the socket, the app shows it, and the answer comes back on standard output. Answers are never stored.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;

static WAITING: Mutex<Option<HashMap<u64, mpsc::Sender<Option<String>>>>> = Mutex::new(None);
static SOCKET: OnceLock<String> = OnceLock::new();

#[derive(Clone, serde::Serialize)]
struct Prompt {
    id: u64,
    prompt: String,
    /// ssh's yes-or-no confirmation (SSH_ASKPASS_PROMPT=confirm), answered by the exit code alone.
    confirm: bool,
}

/// Run as the askpass program: sends the prompt to the app and prints its answer. Exits 1 when the dialog was
/// canceled or the app can't be reached, which git and ssh treat as no answer.
pub fn client(socket: &str) -> ! {
    let prompt = std::env::args().skip(1).collect::<Vec<_>>().join(" ");
    let confirm = std::env::var("SSH_ASKPASS_PROMPT").as_deref() == Ok("confirm");
    match request(socket, confirm, &prompt) {
        Some(answer) => {
            if !confirm {
                println!("{answer}");
            }
            std::process::exit(0)
        }
        None => std::process::exit(1),
    }
}

fn request(socket: &str, confirm: bool, prompt: &str) -> Option<String> {
    let mut stream = UnixStream::connect(socket).ok()?;
    write!(stream, "{}\n{prompt}", if confirm { "confirm" } else { "" }).ok()?;
    stream.shutdown(std::net::Shutdown::Write).ok()?;
    let mut reply = String::new();
    stream.read_to_string(&mut reply).ok()?;
    reply.strip_prefix('1').map(str::to_string)
}

/// Reads one prompt from `stream`, asks `ask`, and writes the answer back.
fn handle(mut stream: UnixStream, ask: impl FnOnce(bool, String) -> Option<String>) {
    let mut text = String::new();
    if stream.read_to_string(&mut text).is_err() {
        return;
    }
    let (flag, prompt) = text.split_once('\n').unwrap_or(("", &text));
    let reply = match ask(flag == "confirm", prompt.to_string()) {
        Some(answer) => format!("1{answer}"),
        None => "0".into(),
    };
    let _ = stream.write_all(reply.as_bytes());
}

/// Listens for prompts and shows each one in the window, as the `askpass` event.
pub fn start(app: tauri::AppHandle) {
    let path = std::env::temp_dir().join(format!("tusk-askpass-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let Ok(listener) = UnixListener::bind(&path) else { return };
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    let _ = SOCKET.set(path.to_string_lossy().into());
    std::thread::spawn(move || {
        let mut next = 0u64;
        for stream in listener.incoming().flatten() {
            next += 1;
            let (id, app) = (next, app.clone());
            std::thread::spawn(move || {
                handle(stream, |confirm, prompt| {
                    let (tx, rx) = mpsc::channel();
                    WAITING.lock().unwrap().get_or_insert_default().insert(id, tx);
                    let _ = app.emit("askpass", Prompt { id, prompt, confirm });
                    // A dialog nobody answers, such as after git was stopped, gives up rather than holding a thread.
                    let answer = rx.recv_timeout(Duration::from_secs(600)).ok().flatten();
                    WAITING.lock().unwrap().get_or_insert_default().remove(&id);
                    answer
                })
            });
        }
    });
}

/// The askpass program and socket for `gitOutput`, or None when the socket couldn't be opened.
#[tauri::command]
pub fn askpass_env() -> Option<(String, String)> {
    Some((std::env::current_exe().ok()?.to_string_lossy().into(), SOCKET.get()?.clone()))
}

/// Answers a prompt from the `askpass` event; None cancels it.
#[tauri::command]
pub fn askpass_answer(id: u64, answer: Option<String>) {
    if let Some(tx) = WAITING.lock().unwrap().get_or_insert_default().remove(&id) {
        let _ = tx.send(answer);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let path = std::env::temp_dir().join(format!("tusk-askpass-test-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();
        let server = std::thread::spawn(move || {
            for answer in [Some("s3cret"), None] {
                let (stream, _) = listener.accept().unwrap();
                handle(stream, |confirm, prompt| {
                    assert!(!confirm);
                    assert_eq!(prompt, "Password for 'https://me@github.com': ");
                    answer.map(str::to_string)
                });
            }
        });
        let socket = path.to_str().unwrap();
        assert_eq!(request(socket, false, "Password for 'https://me@github.com': ").as_deref(), Some("s3cret"));
        assert_eq!(request(socket, false, "Password for 'https://me@github.com': "), None);
        server.join().unwrap();
        assert_eq!(request(socket, false, "x"), None, "no listener counts as canceled");
        let _ = std::fs::remove_file(&path);
    }
}
