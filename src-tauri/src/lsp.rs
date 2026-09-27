use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// Runs its arguments as a command that is killed if this app dies. Language servers
/// often ignore the LSP `processId` and outlive a crashed or force-quit editor. The shell
/// starts a loop that watches the app's PID, then `exec`s the server, so the server keeps
/// the shell's PID and `Child::kill` still reaches it.
pub(crate) const WATCHDOG: &str = r#"app=$PPID; (while kill -0 "$app" && kill -0 $$; do sleep 2; done; kill $$) >/dev/null 2>&1 </dev/null & exec "$@""#;

/// Running language servers by name, each with a channel to the thread that writes its input.
#[derive(Default)]
pub struct LspState(Mutex<HashMap<String, (Child, Sender<Vec<u8>>)>>);

/// Writes messages to a server's input on a thread of its own. A busy server stops reading, its
/// pipe fills, and a write then blocks until it reads again; that must never be the main thread.
fn writer(mut stdin: ChildStdin) -> Sender<Vec<u8>> {
    let (tx, rx) = channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(msg) = rx.recv() {
            if stdin.write_all(&msg).and_then(|_| stdin.flush()).is_err() {
                break;
            }
        }
    });
    tx
}

impl LspState {
    pub fn stop_all(&self) {
        for (_, (mut child, _)) in self.0.lock().unwrap().drain() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Where the app downloads the language tools (see `tools::tools_ensure`), one folder per tool.
pub fn tools_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("tools"))
}

/// The path of a tool's file, such as `mago/mago`. The editor's mago.toml and introspect.php are
/// small files from this repository, so they ship inside the app instead.
pub fn tool(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    if path == "mago.toml" || path == "introspect.php" {
        return Ok(app.path().resource_dir().map_err(|e| e.to_string())?.join("tools").join(path));
    }
    Ok(tools_dir(app)?.join(path))
}

/// Starts the bundled language server `name` (`tusk`, `tailwind`, `typescript`, `vue`, `svelte`, `astro`, or `angular`) for `root`, replacing a running one with the
/// same name. Each message from the server is emitted as a `lsp:<name>` event (raw JSON).
/// Returns this app's process ID, which the client sends as `processId` so that servers
/// exit if the app dies without stopping them.
#[tauri::command(async)]
pub fn lsp_start(app: AppHandle, state: State<'_, LspState>, name: String, root: String) -> Result<u32, String> {
    crate::login_path();
    // The Angular server loads TypeScript and its language service from these folders: the project's first, then its own.
    let ng_dir = tool(&app, "node/node_modules/@angular/language-server")?.to_string_lossy().into_owned();
    let ts_probe = format!("{root},{ng_dir}");
    // (runtime, script inside the tools folder, arguments)
    let (runtime, script, args): (&str, &str, &[&str]) = match name.as_str() {
        // PHP, Laravel, and Filament: this app's own binary in its language server mode.
        "tusk" => ("", "", &["lsp"]),
        "tailwind" => ("node", "node/node_modules/@tailwindcss/language-server/bin/tailwindcss-language-server", &["--stdio"]),
        "typescript" => ("node", "node/node_modules/@vtsls/language-server/bin/vtsls.js", &["--stdio"]),
        "vue" => ("node", "node/node_modules/@vue/language-server/bin/vue-language-server.js", &["--stdio"]),
        "svelte" => ("node", "node/node_modules/svelte-language-server/bin/server.js", &["--stdio"]),
        "astro" => ("node", "node/node_modules/@astrojs/language-server/bin/nodeServer.js", &["--stdio"]),
        "angular" => ("node", "node/node_modules/@angular/language-server/index.js", &["--stdio", "--tsProbeLocations", &ts_probe, "--ngProbeLocations", &ng_dir]),
        // A native binary: the watchdog execs it directly (the runtime is the program itself).
        "typos" => ("", "typos-lsp/typos-lsp", &[]),
        // Not a language server: the Xdebug debug adapter. DAP frames messages the same way.
        "xdebug" => ("node", "php-debug/out/phpDebug.js", &[]),
        _ => return Err(format!("Unknown language server: {name}")),
    };
    // Laravel LSP ran its PHP helpers from the project, and a stopped one could leave them behind.
    if name == "tusk" {
        clean_laravel_helpers(Path::new(&root));
    }
    let program = if name == "tusk" { std::env::current_exe().map_err(|e| e.to_string())? } else { tool(&app, script)? };
    let mut child = Command::new("/bin/sh")
        .args(["-c", WATCHDOG, "sh"])
        .args((!runtime.is_empty()).then_some(runtime))
        .arg(program)
        .args(args)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Could not start {name}. Is {runtime} installed? ({e})"))?;
    let stdin = writer(child.stdin.take().unwrap());
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let pid = child.id();
    let old = state.0.lock().unwrap().insert(name.clone(), (child, stdin));
    if let Some((mut old, _)) = old {
        let _ = old.kill();
        let _ = old.wait();
    }
    let event = format!("lsp:{name}");
    let server = name.clone();
    std::thread::spawn(move || {
        while let Ok(Some(msg)) = read_message(&mut stdout) {
            let _ = app.emit(&event, msg);
        }
        // Stopping or replacing a server takes it out of the list first, so one still listed has exited on its own,
        // such as from a crash: the client is told, to start it again.
        let state = app.state::<LspState>();
        let mut servers = state.0.lock().unwrap();
        if servers.get(&server).is_some_and(|(c, _)| c.id() == pid) {
            let (mut child, _) = servers.remove(&server).unwrap();
            drop(servers);
            let _ = child.wait();
            let _ = app.emit("lsp-exit", server);
        }
    });
    Ok(std::process::id())
}

/// Laravel's language server runs its PHP helpers from `storage/framework/lsp-<hash>.php` and deletes each when it
/// finishes, so a server stopped mid-run (on reload, project switch, or quit) leaves them in the user's project.
/// Removes those older than a minute; a newer one may belong to another window's server.
fn clean_laravel_helpers(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root.join("storage/framework")) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let helper = name.strip_prefix("lsp-").and_then(|n| n.strip_suffix(".php")).is_some_and(|h| h.len() == 16 && h.bytes().all(|b| b.is_ascii_hexdigit()));
        let stale = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age.as_secs() > 60);
        if helper && stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Starts the bundled llama-server with the GGUF file `model` on a free local port, for
/// AI code completion, and returns the port. It's kept with the language servers as
/// `llama`, so `lsp_stop("llama")` and quitting the app stop it.
/// `key` is required on every request except `/health`, so a web page in a browser can't use the
/// server or read the code in its prompt cache.
#[tauri::command(async)]
pub fn ai_start(app: AppHandle, state: State<'_, LspState>, model: String, key: String) -> Result<u16, String> {
    let port = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map_err(|e| e.to_string())?.port();
    let mut child = Command::new("/bin/sh")
        .args(["-c", WATCHDOG, "sh"])
        .arg(tool(&app, "llama/llama-server")?)
        // --cache-reuse lets a request reuse the processed prompt even after text before the cursor shifts.
        // The server keeps up to 3/4 of -b tokens before the cursor, so 2048 allows about 150 lines.
        .args(["-m", &model, "--host", "127.0.0.1", "--port", &port.to_string(), "--api-key", &key])
        .args(["-ngl", "99", "-c", "8192", "-np", "1", "-b", "2048", "-ub", "1024", "--cache-reuse", "256"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not start llama-server: {e}"))?;
    let stdin = writer(child.stdin.take().unwrap());
    let old = state.0.lock().unwrap().insert("llama".into(), (child, stdin));
    if let Some((mut old, _)) = old {
        let _ = old.kill();
        let _ = old.wait();
    }
    Ok(port)
}

/// Open requests to llama-server by the client's ID, so a request for a suggestion that's no longer
/// wanted can be cancelled.
#[derive(Default)]
pub struct AiRequests(Mutex<HashMap<u32, std::net::TcpStream>>);

/// Posts `body` (JSON) to `path` on the local llama-server and returns the response body. Closing
/// the connection, which `ai_cancel` does, makes the server stop generating, so it's free sooner.
#[tauri::command]
pub async fn ai_request(state: State<'_, AiRequests>, id: u32, port: u16, key: String, path: String, body: String) -> Result<String, String> {
    use std::io::Read;
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    state.0.lock().unwrap().insert(id, stream.try_clone().map_err(|e| e.to_string())?);
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {key}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let result = tauri::async_runtime::spawn_blocking(move || {
        stream.write_all(request.as_bytes())?;
        let mut response = Vec::new();
        stream.read_to_end(&mut response)?;
        Ok::<_, std::io::Error>(response)
    })
    .await;
    state.0.lock().unwrap().remove(&id);
    let response = result.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    parse_response(&response)
}

/// The body of an HTTP/1.1 response with a Content-Length, or an error for a status other than 200.
fn parse_response(response: &[u8]) -> Result<String, String> {
    let text = String::from_utf8_lossy(response);
    let (head, body) = text.split_once("\r\n\r\n").ok_or("incomplete response")?;
    let status = head.split(' ').nth(1).unwrap_or("");
    if status != "200" {
        return Err(format!("HTTP {status}: {body}"));
    }
    Ok(body.to_string())
}

/// Cancels the request `id`, if it's still open.
#[tauri::command]
pub fn ai_cancel(state: State<AiRequests>, id: u32) {
    if let Some(stream) = state.0.lock().unwrap().remove(&id) {
        let _ = stream.shutdown(std::net::Shutdown::Both);
    }
}

/// Stops the server (or debug adapter) `name`, if it's running.
#[tauri::command(async)]
pub fn lsp_stop(state: State<'_, LspState>, name: String) -> Result<(), String> {
    let removed = state.0.lock().unwrap().remove(&name);
    if let Some((mut child, _)) = removed {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

/// Queues a message for the server's writer thread, so it returns at once even when the server is busy.
#[tauri::command]
pub fn lsp_send(state: State<LspState>, name: String, msg: String) -> Result<(), String> {
    let mut frame = format!("Content-Length: {}\r\n\r\n", msg.len()).into_bytes();
    frame.extend_from_slice(msg.as_bytes());
    let servers = state.0.lock().unwrap();
    let (_, stdin) = servers.get(&name).ok_or_else(|| format!("{name} is not running"))?;
    stdin.send(frame).map_err(|_| format!("{name} has stopped"))
}

/// Reads one `Content-Length`-framed JSON-RPC message. Returns `None` at end of stream.
fn read_message(r: &mut impl BufRead) -> std::io::Result<Option<String>> {
    let mut len = None;
    let mut line = String::new();
    loop {
        line.clear();
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
    Ok(Some(String::from_utf8(body).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())))
}

#[cfg(test)]
mod tests {
    use super::{clean_laravel_helpers, parse_response, read_message};

    #[test]
    fn reads_http_responses() {
        assert_eq!(parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").unwrap(), "{}");
        assert!(parse_response(b"HTTP/1.1 401 Unauthorized\r\n\r\nno").unwrap_err().contains("401"));
        assert!(parse_response(b"HTTP/1.1 200 OK").is_err());
    }

    #[test]
    fn removes_stale_laravel_helpers_only() {
        let root = std::env::temp_dir().join(format!("tusk-helpers-{}", std::process::id()));
        let dir = root.join("storage/framework");
        std::fs::create_dir_all(&dir).unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(120);
        for name in ["lsp-0123456789abcdef.php", "lsp-fedcba9876543210.php", "lsp-notahash.php", "routes.php"] {
            std::fs::write(dir.join(name), "<?php").unwrap();
        }
        for name in ["lsp-0123456789abcdef.php", "lsp-notahash.php", "routes.php"] {
            std::fs::File::options().write(true).open(dir.join(name)).unwrap().set_modified(old).unwrap();
        }
        clean_laravel_helpers(&root);
        let mut left: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        left.sort();
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(left, ["lsp-fedcba9876543210.php", "lsp-notahash.php", "routes.php"]);
    }

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
