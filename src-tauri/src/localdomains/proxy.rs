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
    let (status, message) = match port {
        Some(port) => match TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await {
            Ok(mut upstream) => {
                let _ = tokio::io::copy_bidirectional(&mut tls, &mut upstream).await;
                return;
            }
            Err(_) => ("502 Bad Gateway", format!("{host} is registered but its server isn't answering on port {port}.")),
        },
        None => ("404 Not Found", format!("{host} isn't running. Run its configuration in Tusk.")),
    };
    let head = read_head(&mut tls).await;
    // Links to the other names keep the proxy's port, as when it runs on 8443.
    let host_header = header(&head, "host").unwrap_or_default();
    let suffix = host_header.rsplit_once(':').filter(|(_, p)| p.parse::<u16>().is_ok()).map_or(String::new(), |(_, p)| format!(":{p}"));
    let label = host.strip_suffix(".test").unwrap_or_default();
    if port.is_none() && request_line(&head) == Some(("POST", RUN_PATH)) {
        let _ = tls.write_all(&respond(run_status(&head, &host, &suffix, || inner.request_run(label)), "text/plain", "", "Cache-Control: no-store\r\n")).await;
        let _ = tls.shutdown().await;
        return;
    }
    let (kind, body) = if accepts_html(&head) {
        let runnable = port.is_none().then(|| inner.runnable(label)).flatten();
        ("text/html", page(&host, port, &inner.names(), &suffix, runnable.as_deref()))
    } else {
        ("text/plain", format!("{message}\n"))
    };
    let extra = "Retry-After: 2\r\nCache-Control: no-store\r\nX-Tusk-Proxy: unavailable\r\n";
    let _ = tls.write_all(&respond(status, kind, &body, extra)).await;
    let _ = tls.shutdown().await;
}

/// Where the page's Run button posts. Only the proxy answers it, since nothing serves the name yet.
const RUN_PATH: &str = "/__tusk/run";

/// The reply to the page's Run button. It must come from the page itself: the same origin, and a header that a
/// form can't send and that another site's fetch can't send without a preflight, which the proxy never allows.
fn run_status(head: &[u8], host: &str, suffix: &str, run: impl FnOnce() -> bool) -> &'static str {
    let ours = header(head, "origin").is_some_and(|o| o == format!("https://{host}{suffix}")) && header(head, "x-tusk").as_deref() == Some("run");
    if !ours {
        "403 Forbidden"
    } else if run() {
        "202 Accepted"
    } else {
        "404 Not Found"
    }
}

/// The request's method and path.
fn request_line(head: &[u8]) -> Option<(&str, &str)> {
    let line = std::str::from_utf8(head.split(|b| *b == b'\r').next()?).ok()?;
    let mut words = line.split(' ');
    Some((words.next()?, words.next()?))
}

const PAGE: &str = include_str!("page.html");
/// Tusk's icon, shown on the page and as its favicon.
const ICON: &str = include_str!("../../../design/icon.svg");

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

/// Replaces each `{{key}}` in `template` in one pass, so a value can't bring in another placeholder.
fn fill(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some((before, after)) = rest.split_once("{{") {
        let (key, after) = after.split_once("}}").unwrap_or((after, ""));
        out.push_str(before);
        out.push_str(values.iter().find(|(k, _)| *k == key).map_or("", |(_, v)| v));
        rest = after;
    }
    out.push_str(rest);
    out
}

/// The page for `host` that isn't served: not running, or, with its `port`, not answering. The not-running
/// page links to the `running` names, with `suffix` (such as `:8443`) after each, and offers to run the
/// configuration named `runnable` when a window has one that serves `host`.
fn page(host: &str, port: Option<u16>, running: &[String], suffix: &str, runnable: Option<&str>) -> String {
    use base64::Engine;
    let host = escape(host);
    let (tone, code, reason, verb, waiting) = match port {
        Some(_) => ("down", "502", "Bad Gateway", "answering", "Waiting for the server to answer"),
        None => ("off", "404", "Not Found", "running", "Waiting for it to start"),
    };
    let explanation = match (port, runnable) {
        (Some(port), _) => format!("Tusk is serving this address, but nothing answers on port <code>{port}</code> yet. The server may still be starting, or it stopped. Check its terminal tab in Tusk. This page opens your site as soon as it answers."),
        (None, Some(_)) => "Nothing is serving this address yet. Run it from here or from Tusk, and this page opens your site as soon as it&#39;s up.".to_string(),
        (None, None) => "Nothing in Tusk is serving this address. Run its configuration in Tusk, and this page opens your site as soon as it&#39;s up.".to_string(),
    };
    let action = match (port, runnable) {
        (None, Some(config)) => format!(
            "\n  <div class=\"actions\">\n    <button class=\"run\" id=\"run\" type=\"button\"><span class=\"glyph\" aria-hidden=\"true\"></span><span id=\"run-label\">Run <code>{host}</code></span></button>\n    <div class=\"hint\" id=\"run-hint\">Runs “{}” in Tusk</div>\n  </div>",
            escape(config)
        ),
        _ => String::new(),
    };
    let running = match port {
        None if !running.is_empty() => {
            let rows: String = running
                .iter()
                .map(|name| {
                    let name = escape(name);
                    let suffix = escape(suffix);
                    format!("\n      <li><a href=\"https://{name}.test{suffix}/\"><code>{name}.test</code></a></li>")
                })
                .collect();
            format!("\n  <section class=\"running\">\n    <h2>Running in Tusk</h2>\n    <ul>{rows}\n    </ul>\n  </section>")
        }
        _ => String::new(),
    };
    let title = format!("{code} · {host} isn&#39;t {verb}");
    let favicon = format!("data:image/svg+xml;base64,{}", base64::engine::general_purpose::STANDARD.encode(ICON));
    fill(
        PAGE,
        &[
            ("title", &title),
            ("favicon", &favicon),
            ("icon", ICON),
            ("tone", tone),
            ("code", code),
            ("reason", reason),
            ("host", &host),
            ("verb", verb),
            ("explanation", &explanation),
            ("action", &action),
            ("waiting", waiting),
            ("running", &running),
        ],
    )
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
    let (kind, body) = if accepts_html(head) {
        let text = escape(text);
        ("text/html", format!("<!doctype html><meta charset=\"utf-8\"><title>{text}</title><p>{text}</p>\n"))
    } else {
        ("text/plain", format!("{text}\n"))
    };
    let location = location.map(|l| format!("Location: {l}\r\n")).unwrap_or_default();
    respond(status, kind, &body, &location)
}

fn accepts_html(head: &[u8]) -> bool {
    header(head, "accept").is_some_and(|a| a.contains("text/html"))
}

/// A response with `extra` header lines, each ending in CRLF.
fn respond(status: &str, kind: &str, body: &str, extra: &str) -> Vec<u8> {
    format!("HTTP/1.1 {status}\r\n{extra}Content-Type: {kind}; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
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

    #[test]
    fn pages() {
        let running = ["shop".to_string(), "a\"b".to_string()];
        let off = page("<script>", None, &running, ":8443", None);
        assert!(off.contains("<title>404 · &lt;script&gt; isn&#39;t running</title>") && off.contains("<body class=\"off\">"));
        assert!(off.contains("<div class=\"code\" aria-hidden=\"true\">404</div>") && off.contains("404 Not Found</footer>"));
        assert!(off.contains("<h1><code>&lt;script&gt;</code> isn't running</h1>") && !off.contains("<script>\""), "{off}");
        assert!(off.contains("Nothing in Tusk is serving this address.") && off.contains("Waiting for it to start"));
        assert!(off.contains("Running in Tusk") && off.contains("<a href=\"https://shop.test:8443/\"><code>shop.test</code></a>"));
        assert!(off.contains("https://a&quot;b.test:8443/") && !off.contains("{{"));
        // Tusk's icon, inline and as the favicon.
        assert!(off.contains("<div class=\"logo\" aria-hidden=\"true\"><svg") && off.contains("href=\"data:image/svg+xml;base64,"));
        assert!(!page("shop.test", None, &[], "", None).contains("Running in Tusk"));

        let down = page("shop.test", Some(18803), &running, "", Some("Serve"));
        assert!(down.contains("<body class=\"down\">") && down.contains(">502</div>") && down.contains("<code>shop.test</code> isn't answering"));
        assert!(down.contains("nothing answers on port <code>18803</code> yet") && !down.contains("Running in Tusk"));
        assert!(!down.contains("id=\"run\""), "a server that's starting gets no Run button");

        let runnable = page("blog.test", None, &[], "", Some("Serve <blog>"));
        assert!(runnable.contains("<button class=\"run\" id=\"run\" type=\"button\">") && runnable.contains("Run <code>blog.test</code>"));
        assert!(runnable.contains("Runs “Serve &lt;blog&gt;” in Tusk") && runnable.contains("Run it from here or from Tusk"));
        assert!(!off.contains("id=\"run\""));
    }

    #[test]
    fn run_requests() {
        let head = |headers: &str| format!("POST /__tusk/run HTTP/1.1\r\nHost: blog.test:8443\r\n{headers}\r\n").into_bytes();
        assert_eq!(request_line(&head("")), Some(("POST", "/__tusk/run")));
        let ours = head("Origin: https://blog.test:8443\r\nX-Tusk: run\r\n");
        assert_eq!(run_status(&ours, "blog.test", ":8443", || true), "202 Accepted");
        assert_eq!(run_status(&ours, "blog.test", ":8443", || false), "404 Not Found");
        // Another site's form or fetch: a different origin, or no header without a preflight.
        let mut ran = false;
        assert_eq!(run_status(&head("Origin: https://evil.example\r\nX-Tusk: run\r\n"), "blog.test", ":8443", || (ran = true, true).1), "403 Forbidden");
        assert_eq!(run_status(&head("Origin: https://blog.test:8443\r\n"), "blog.test", ":8443", || (ran = true, true).1), "403 Forbidden");
        assert_eq!(run_status(&head("X-Tusk: run\r\n"), "blog.test", ":8443", || (ran = true, true).1), "403 Forbidden");
        assert!(!ran);
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
