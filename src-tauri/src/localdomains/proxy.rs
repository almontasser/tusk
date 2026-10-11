// The listeners: HTTPS routed by SNI to each name's local port, a redirect from HTTP, and the DNS responder.
use super::{dns, Inner, Ports};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;

/// The running listeners. Dropping it stops them; connections already open carry on.
#[derive(Default)]
pub struct Listening {
    pub https_port: u16,
    pub http_port: Option<u16>,
    pub dns_port: Option<u16>,
    /// Problems that leave the proxy working, such as the DNS port being taken.
    pub notes: Vec<String>,
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for Listening {
    fn drop(&mut self) {
        self.tasks.iter().for_each(JoinHandle::abort);
    }
}

impl Listening {
    /// Stops the listeners and waits until their sockets are closed, so the ports can be bound again.
    pub async fn stop(mut self) {
        for task in std::mem::take(&mut self.tasks) {
            task.abort();
            let _ = task.await;
        }
    }
}

/// Binds the listeners: HTTPS on `ports.https`, or else `ports.fallback` with no HTTP redirect, and DNS.
pub async fn listen(inner: Arc<Inner>, ports: &Ports) -> Result<Listening, String> {
    let (https, https_port, v6) = match bind_checked(ports.https).await {
        Ok(bound) => bound,
        Err(first) => match bind_checked(ports.fallback).await {
            Ok(bound) => bound,
            // Another dev tool often holds the fallback too, so let the system pick a free port.
            Err(e) => bind_checked(0).await.map_err(|_| {
                format!("Tusk couldn't listen on port {} ({first}) or port {} ({e}).", ports.https, ports.fallback)
            })?,
        },
    };
    let mut l = Listening::default();
    l.https_port = https_port;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(Resolver(inner.clone())));
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    let acceptor = TlsAcceptor::from(Arc::new(config));
    for listener in https {
        let (inner, acceptor) = (inner.clone(), acceptor.clone());
        l.tasks.push(tokio::spawn(accept(listener, move |tcp| {
            tokio::spawn(serve_tls(tcp, inner.clone(), acceptor.clone()));
        })));
    }
    if let (true, Some(port)) = (https_port == ports.https, ports.http) {
        if let Ok((http, port, _)) = bind_checked(port).await {
            l.http_port = Some(port);
            for listener in http {
                l.tasks.push(tokio::spawn(accept(listener, |tcp| drop(tokio::spawn(serve_http(tcp))))));
            }
        }
    }
    match retry_bind(|| UdpSocket::bind((Ipv4Addr::LOCALHOST, ports.dns))).await {
        Ok(socket) => {
            l.dns_port = Some(ports.dns);
            l.tasks.push(tokio::spawn(dns::serve(socket, v6)));
        }
        Err(_) if dns::probe(ports.dns).await => {}
        Err(_) => l.notes.push(format!("Port {} is in use by another program, so .test names may not resolve to this computer.", ports.dns)),
    }
    Ok(l)
}

/// Retries a bind that fails because the port is in use, as when the process that held it is exiting.
async fn retry_bind<T, F: std::future::Future<Output = std::io::Result<T>>>(bind: impl Fn() -> F) -> std::io::Result<T> {
    let mut tries = 0;
    loop {
        match bind().await {
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && tries < 3 => tries += 1,
            result => return result,
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Binds `port` on loopback, and whether IPv6 works too. macOS refuses unprivileged binds to 127.0.0.1 on low
/// ports but allows the wildcard address, so there it's `[::]` (dual-stack) with remote peers turned away.
async fn bind(port: u16) -> std::io::Result<(Vec<TcpListener>, bool)> {
    if cfg!(target_os = "macos") {
        return Ok((vec![TcpListener::bind((Ipv6Addr::UNSPECIFIED, port)).await?], true));
    }
    let v4 = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?;
    // With port 0, the system picks the port for IPv4 and IPv6 takes the same one.
    let port = v4.local_addr()?.port();
    match TcpListener::bind((Ipv6Addr::LOCALHOST, port)).await {
        Ok(v6) => Ok((vec![v4, v6], true)),
        Err(_) => Ok((vec![v4], false)),
    }
}

/// Binds `port`, or a port the system picks for 0, and checks that a connection to 127.0.0.1 reaches it. tokio sets SO_REUSEADDR, so on macOS a
/// wildcard bind can succeed while another process's 127.0.0.1 bind on the same port takes the loopback traffic.
async fn bind_checked(port: u16) -> Result<(Vec<TcpListener>, u16, bool), String> {
    let (listeners, v6) = retry_bind(|| bind(port)).await.map_err(|e| e.to_string())?;
    let first = &listeners[0];
    let port = first.local_addr().map_err(|e| e.to_string())?.port();
    let check = async {
        let client = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.ok()?;
        let me = client.local_addr().ok()?;
        loop {
            let (_, peer) = first.accept().await.ok()?;
            if peer.port() == me.port() && peer.ip().to_canonical() == me.ip().to_canonical() {
                return Some(());
            }
        }
    };
    match tokio::time::timeout(Duration::from_secs(1), check).await {
        Ok(Some(())) => Ok((listeners, port, v6)),
        _ => Err("another program receives its connections".into()),
    }
}

/// Accepts connections from this computer and hands them to `serve`.
async fn accept(listener: TcpListener, serve: impl Fn(TcpStream)) {
    loop {
        match listener.accept().await {
            Ok((tcp, peer)) if peer.ip().to_canonical().is_loopback() => serve(tcp),
            Ok(_) => {}
            // Out of file descriptors, say: wait rather than spin.
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}

#[derive(Clone)]
struct Resolver(Arc<Inner>);

impl std::fmt::Debug for Resolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Resolver")
    }
}

impl rustls::server::ResolvesServerCert for Resolver {
    fn resolve(&self, hello: rustls::server::ClientHello<'_>) -> Option<Arc<rustls::sign::CertifiedKey>> {
        let name = hello.server_name()?.to_ascii_lowercase();
        if !name.ends_with(".test") {
            return None;
        }
        self.0.ca().leaf(&name)
    }
}

// ponytail: a byte copy with no X-Forwarded headers. The PHP side marks requests as HTTPS through its router script.
async fn serve_tls(tcp: TcpStream, inner: Arc<Inner>, acceptor: TlsAcceptor) {
    let Ok(Ok(mut tls)) = tokio::time::timeout(Duration::from_secs(10), acceptor.accept(tcp)).await else { return };
    let host = tls.get_ref().1.server_name().unwrap_or_default().to_ascii_lowercase();
    let port = host.strip_suffix(".test").and_then(|label| inner.lookup(label));
    let message = match port {
        Some(port) => match TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await {
            Ok(mut upstream) => {
                let _ = tokio::io::copy_bidirectional(&mut tls, &mut upstream).await;
                return;
            }
            Err(_) => format!("{host} is registered but its server isn't answering on port {port}."),
        },
        None => format!("{host} isn't running. Run its configuration in Tusk."),
    };
    let head = read_head(&mut tls).await;
    let _ = tls.write_all(&reply("502 Bad Gateway", &head, &message, None)).await;
    let _ = tls.shutdown().await;
}

/// Redirects `http://name.test/path` to HTTPS.
async fn serve_http(mut tcp: TcpStream) {
    let head = read_head(&mut tcp).await;
    let target = String::from_utf8_lossy(&head).split_whitespace().nth(1).unwrap_or_default().to_string();
    let host = header(&head, "host").unwrap_or_default().to_ascii_lowercase();
    let host = host.rsplit_once(':').filter(|(_, port)| port.parse::<u16>().is_ok()).map_or(host.as_str(), |(h, _)| h);
    let valid = host.ends_with(".test") && host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    let response = if valid && target.starts_with('/') {
        let location = format!("https://{host}{target}");
        reply("301 Moved Permanently", &head, &format!("Moved to {location}"), Some(&location))
    } else {
        reply("400 Bad Request", &head, "Tusk only redirects .test addresses to HTTPS.", None)
    };
    let _ = tcp.write_all(&response).await;
    let _ = tcp.shutdown().await;
}

/// The request's head, up to the blank line, at most 16 KB, or whatever arrives within 5 seconds.
async fn read_head(stream: &mut (impl AsyncRead + Unpin)) -> Vec<u8> {
    let mut head = Vec::new();
    let read = async {
        let mut buf = [0u8; 4096];
        while head.len() < 16 * 1024 && !head.windows(4).any(|w| w == b"\r\n\r\n") {
            match stream.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => head.extend_from_slice(&buf[..n]),
            }
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(5), read).await;
    head
}

fn header(head: &[u8], name: &str) -> Option<String> {
    String::from_utf8_lossy(head)
        .lines()
        .skip(1)
        .take_while(|line| !line.is_empty())
        .filter_map(|line| line.split_once(':'))
        .find(|(n, _)| n.trim().eq_ignore_ascii_case(name))
        .map(|(_, v)| v.trim().to_string())
}

/// A response with `text` as short HTML when the request accepts it, else as plain text.
fn reply(status: &str, head: &[u8], text: &str, location: Option<&str>) -> Vec<u8> {
    let (kind, body) = if header(head, "accept").is_some_and(|a| a.contains("text/html")) {
        let text = text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
        ("text/html", format!("<!doctype html><meta charset=\"utf-8\"><title>{text}</title><p>{text}</p>\n"))
    } else {
        ("text/plain", format!("{text}\n"))
    };
    let location = location.map(|l| format!("Location: {l}\r\n")).unwrap_or_default();
    format!("HTTP/1.1 {status}\r\n{location}Content-Type: {kind}; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
        .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies() {
        let html = String::from_utf8(reply("502 Bad Gateway", b"GET / HTTP/1.1\r\nAccept: text/html,*/*\r\n\r\n", "a <b>", None)).unwrap();
        assert!(html.starts_with("HTTP/1.1 502 Bad Gateway\r\n") && html.contains("text/html") && html.contains("a &lt;b&gt;"));
        let plain = String::from_utf8(reply("502 Bad Gateway", b"GET / HTTP/1.1\r\n\r\n", "x", None)).unwrap();
        assert!(plain.contains("text/plain") && plain.ends_with("\r\n\r\nx\n"));
    }

    #[tokio::test]
    async fn redirects_http() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(accept(listener, |tcp| drop(tokio::spawn(serve_http(tcp)))));
        for (request, expect) in [
            ("GET /a?b=1 HTTP/1.1\r\nHost: Shop.test:80\r\n\r\n", "Location: https://shop.test/a?b=1\r\n"),
            ("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n", "HTTP/1.1 400"),
        ] {
            let mut tcp = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap();
            tcp.write_all(request.as_bytes()).await.unwrap();
            let mut response = String::new();
            tcp.read_to_string(&mut response).await.unwrap();
            assert!(response.contains(expect), "{response}");
        }
    }
}
