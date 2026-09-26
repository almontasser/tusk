// WebSocket connections for the HTTP client. The webview's WebSocket can't send headers, such as
// Authorization, so connections go through tungstenite on a thread each.
use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::{HeaderName, HeaderValue};
use tungstenite::{Connector, Error, Message};

enum Command {
    Send(String),
    Close,
}

/// Open connections by ID, each with the channel to its thread.
#[derive(Default)]
pub struct WsState(Mutex<HashMap<u32, Sender<Command>>>);

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// A message from the server: text, or binary data as base64.
#[derive(Serialize, Clone)]
struct Incoming {
    text: Option<String>,
    binary: Option<String>,
}

#[derive(Serialize, Clone)]
struct Closed {
    code: u16,
    reason: String,
}

/// Connects to `url` with `headers`, accepting any TLS certificate when `insecure` is set. Messages
/// arrive as `ws:<channel>` events, errors as `ws-error:<channel>`, and `ws-close:<channel>` fires
/// once an open connection ends. A connection that can't open returns an error instead. The caller
/// picks the channel, so it can listen before connecting.
#[tauri::command(async)]
pub fn ws_connect(app: AppHandle, state: State<'_, WsState>, url: String, headers: Vec<(String, String)>, insecure: bool, channel: String) -> Result<u32, String> {
    let mut request = url.as_str().into_client_request().map_err(|e| e.to_string())?;
    for (name, value) in headers {
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|e| format!("{name}: {e}"))?;
        let value = HeaderValue::from_str(&value).map_err(|e| format!("{name}: {e}"))?;
        request.headers_mut().insert(name, value);
    }
    let uri = request.uri();
    let host = uri.host().ok_or("The URL has no host")?.trim_matches(['[', ']']).to_string();
    let port = uri.port_u16().unwrap_or(if uri.scheme_str() == Some("wss") { 443 } else { 80 });
    let addr = (host.as_str(), port).to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("Couldn't resolve the host")?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(10)).map_err(|e| e.to_string())?;
    let socket = tcp.try_clone().map_err(|e| e.to_string())?;
    let tls = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(insecure)
        .danger_accept_invalid_hostnames(insecure)
        .build()
        .map_err(|e| e.to_string())?;
    let (mut ws, _) = tungstenite::client_tls_with_config(request, tcp, None, Some(Connector::NativeTls(tls))).map_err(|e| e.to_string())?;
    // Reads time out so the thread can send queued messages between them.
    socket.set_read_timeout(Some(Duration::from_millis(50))).map_err(|e| e.to_string())?;

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (commands, queue) = std::sync::mpsc::channel::<Command>();
    state.0.lock().unwrap().insert(id, commands);
    std::thread::spawn(move || {
        let mut closed = Closed { code: 1006, reason: String::new() };
        'outer: loop {
            for command in queue.try_iter() {
                let sent = match command {
                    Command::Send(text) => ws.send(Message::text(text)),
                    Command::Close => ws.close(None),
                };
                if let Err(e) = sent {
                    if !matches!(e, Error::ConnectionClosed | Error::AlreadyClosed) {
                        let _ = app.emit(&format!("ws-error:{channel}"), e.to_string());
                    }
                    break 'outer;
                }
            }
            match ws.read() {
                Ok(Message::Text(text)) => {
                    let _ = app.emit(&format!("ws:{channel}"), Incoming { text: Some(text.to_string()), binary: None });
                }
                Ok(Message::Binary(data)) => {
                    let binary = base64::engine::general_purpose::STANDARD.encode(&data);
                    let _ = app.emit(&format!("ws:{channel}"), Incoming { text: None, binary: Some(binary) });
                }
                // tungstenite answers the close frame; the next read ends the connection.
                Ok(Message::Close(frame)) => {
                    closed = frame.map_or(Closed { code: 1005, reason: String::new() }, |f| Closed { code: f.code.into(), reason: f.reason.to_string() });
                }
                Ok(_) => {} // Pings are answered by tungstenite.
                Err(Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                    let _ = ws.flush();
                }
                Err(Error::ConnectionClosed | Error::AlreadyClosed) => break,
                Err(e) => {
                    let _ = app.emit(&format!("ws-error:{channel}"), e.to_string());
                    break;
                }
            }
        }
        app.state::<WsState>().0.lock().unwrap().remove(&id);
        let _ = app.emit(&format!("ws-close:{channel}"), closed);
    });
    Ok(id)
}

#[tauri::command]
pub fn ws_send(state: State<WsState>, id: u32, text: String) -> Result<(), String> {
    let connections = state.0.lock().unwrap();
    let c = connections.get(&id).ok_or("The connection is closed")?;
    c.send(Command::Send(text)).map_err(|_| "The connection is closed".to_string())
}

#[tauri::command]
pub fn ws_close(state: State<WsState>, id: u32) {
    if let Some(c) = state.0.lock().unwrap().get(&id) {
        let _ = c.send(Command::Close);
    }
}
