// The operating system's half of serving https://<name>.test: the system trusts Tusk's local CA, and .test lookups
// reach Tusk's DNS responder (see localdomains.rs). Each OS's setup runs as one elevated script, so you answer one
// password or UAC prompt, and `remove` undoes it. Tusk only touches files and entries that carry its marker or its
// certificate, so other tools' settings stay as they are.
// Root never reads a file you could change: each script, and the certificate and hosts file in it, travels inline.
//
// macOS: /etc/resolver/test, and trust in the login keychain. macOS asks for trust changes in its own dialog since
// Big Sur, even for root, so trust is set as you, outside the elevated script.
// Windows: an NRPT rule for .test, and the certificate in the machine's Root store.
// Linux: a systemd-resolved DNS delegate (systemd 258 or later), or else a block in /etc/hosts; the system's CA
// bundle; and Chrome's and Firefox's NSS databases, as you.
//
// Script builders and output parsers are plain functions that compile and are tested on every OS. Only running
// programs differs per OS.
// So outside tests, each OS leaves the other OSes' builders unused.
#![cfg_attr(not(test), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::process::Command;

/// What the OS should provide.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wanted {
    /// Tusk's CA certificate, as PEM.
    pub ca_pem: PathBuf,
    /// The UDP port of Tusk's DNS responder on 127.0.0.1.
    pub dns_port: u16,
    /// Site names, with or without `.test`. Used only where the OS lists names in the hosts file.
    pub names: Vec<String>,
}

/// What the OS provides now.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Status {
    /// The system trusts this CA certificate (matched by its bytes, not its name).
    pub ca_trusted: bool,
    /// .test lookups reach Tusk: through the DNS responder, or with `uses_hosts`, through the hosts file.
    pub resolver: bool,
    /// Names the hosts file lacks, with `.test`. Empty unless `uses_hosts`.
    pub missing_hosts: Vec<String>,
    /// Programs without privileges may listen on ports 80 and 443.
    pub low_ports: bool,
    /// The OS has no per-domain resolver hook, so names go in the hosts file.
    pub uses_hosts: bool,
}

const CA_NAME: &str = "Tusk Local CA";
/// Marks files Tusk wrote, so it removes only those.
const MARK: &str = "# Tusk";
const HOSTS_BEGIN: &str = "# BEGIN Tusk .test domains";
const HOSTS_END: &str = "# END Tusk .test domains";

/// The setup's state, without prompts or elevation.
pub fn status(w: &Wanted) -> Status {
    imp::status(w)
}

/// Sets up what `status` lacks, in one elevated run (plus, on Linux, the low ports when `low_ports`). Returns notes
/// for you, `Err("cancelled")` when the prompt was dismissed, or a readable reason.
pub fn apply(w: &Wanted, low_ports: bool) -> Result<Vec<String>, String> {
    let notes = imp::apply(w, low_ports)?;
    let s = status(w);
    let mut missing = vec![];
    if !s.ca_trusted {
        missing.push("the system doesn't trust Tusk's certificate".to_string());
    }
    if !s.resolver {
        missing.push(if s.uses_hosts { format!("/etc/hosts lacks {}", s.missing_hosts.join(", ")) } else { ".test names don't reach Tusk".into() });
    }
    if low_ports && !s.low_ports {
        missing.push("programs still can't listen on ports 80 and 443".into());
    }
    if missing.is_empty() {
        Ok(notes)
    } else {
        Err(format!("Setup ran, but {}.", missing.join(", and ")))
    }
}

/// Undoes everything `apply` did, in one elevated run.
pub fn remove(ca_pem: &Path) -> Result<(), String> {
    imp::remove(ca_pem)
}

// Shared helpers.

/// The DER bytes of each certificate in PEM `text`.
fn pem_certs(text: &str) -> Vec<Vec<u8>> {
    use base64::Engine;
    let mut certs = vec![];
    let mut body: Option<String> = None;
    for line in text.lines().map(str::trim) {
        if line == "-----BEGIN CERTIFICATE-----" {
            body = Some(String::new());
        } else if line == "-----END CERTIFICATE-----" {
            if let Some(der) = body.take().and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok()) {
                certs.push(der);
            }
        } else if let Some(body) = &mut body {
            body.push_str(line);
        }
    }
    certs
}

/// The CA's certificate, or why it can't be read.
fn ca_der(path: &Path) -> Result<Vec<u8>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("Tusk's certificate at {} can't be read: {e}", path.display()))?;
    pem_certs(&text).into_iter().next().ok_or_else(|| format!("{} holds no certificate", path.display()))
}

/// `der` as PEM, rebuilt from the parsed certificate so nothing else in the file reaches root.
fn der_pem(der: &[u8]) -> String {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(der);
    let lines: Vec<&str> = b64.as_bytes().chunks(64).map(|c| std::str::from_utf8(c).unwrap_or_default()).collect();
    format!("-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n", lines.join("\n"))
}

/// The SHA-1 fingerprint in uppercase hex: macOS's and Windows' name for a certificate.
fn sha1_hex(der: &[u8]) -> String {
    use sha1::Digest;
    sha1::Sha1::digest(der).iter().map(|b| format!("{b:02X}")).collect()
}

/// A program, with no console window on Windows. Not `toolpaths::command`: that waits for the login shell's PATH,
/// and these are system programs.
fn cmd(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

/// The text of a failed program's error output, or its exit status.
fn failure(out: &std::process::Output) -> String {
    let text = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if text.is_empty() { format!("it exited with {}", out.status) } else { text }
}

/// A private folder for the elevated script and its files, deleted when dropped unless kept. Only Linux needs one.
#[cfg(target_os = "linux")]
struct Scratch {
    dir: PathBuf,
    keep: bool,
}

#[cfg(target_os = "linux")]
impl Scratch {
    fn new() -> Result<Scratch, String> {
        use std::hash::BuildHasher;
        let random = std::hash::RandomState::new().hash_one(std::process::id());
        let dir = std::env::temp_dir().join(format!("tusk-setup-{random:016x}"));
        #[allow(unused_mut)]
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        // create, not create_all: a folder someone made beforehand fails here.
        builder.create(&dir).map_err(|e| format!("Couldn't make a folder for the setup script: {e}"))?;
        Ok(Scratch { dir, keep: false })
    }

    fn file(&self, name: &str, content: &[u8]) -> Result<PathBuf, String> {
        let path = self.dir.join(name);
        std::fs::write(&path, content).map_err(|e| format!("Couldn't write the setup script: {e}"))?;
        Ok(path)
    }
}

#[cfg(target_os = "linux")]
impl Drop for Scratch {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

// macOS.

const MAC_RESOLVER: &str = "/etc/resolver/test";
const MAC_PROMPT: &str = "Tusk needs your password to send .test names to Tusk, so https://<name>.test sites open in your browser.";
const MAC_REMOVE_PROMPT: &str = "Tusk needs your password to undo its .test setup.";

/// Whether /etc/resolver/test sends .test to 127.0.0.1 on `port`, and only there.
fn mac_resolver_ok(text: &str, port: u16) -> bool {
    let (mut servers, mut found) = (vec![], None);
    for line in text.lines() {
        let mut words = line.split_whitespace();
        match (words.next(), words.next()) {
            (Some("nameserver"), Some(server)) => servers.push(server),
            (Some("port"), Some(value)) => found = value.parse::<u16>().ok(),
            _ => {}
        }
    }
    servers == ["127.0.0.1"] && found == Some(port)
}

/// Whether a file carries Tusk's marker line.
fn is_tusk_file(text: &str) -> bool {
    text.lines().any(|l| l.trim() == MARK)
}

/// The elevated script that points .test at Tusk, replacing any other tool's /etc/resolver/test.
fn mac_apply_script(port: u16) -> String {
    format!(
        "set -e\nmkdir -p /etc/resolver\ncat > {MAC_RESOLVER} <<'TUSK'\n{MARK}\nnameserver 127.0.0.1\nport {port}\nTUSK\nchmod 644 {MAC_RESOLVER}\n\
         dscacheutil -flushcache\nkillall -HUP mDNSResponder || true\n"
    )
}

/// The elevated script that removes /etc/resolver/test when Tusk wrote it.
fn mac_remove_script() -> String {
    format!("if grep -qx '{MARK}' {MAC_RESOLVER} 2>/dev/null; then rm -f {MAC_RESOLVER}; fi\ndscacheutil -flushcache\nkillall -HUP mDNSResponder || true\n")
}

/// An AppleScript string literal.
fn applescript_string(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n"))
}

/// The AppleScript that runs `script` as root after the password prompt. The script travels inline, so root runs
/// no file you could change.
fn mac_osascript(script: &str, prompt: &str) -> String {
    format!("do shell script {} with administrator privileges with prompt {}", applescript_string(script), applescript_string(prompt))
}

/// The SHA-1 fingerprints of certificates labelled exactly "Tusk Local CA" in `security find-certificate -a -Z`'s output.
fn mac_tusk_certs(output: &str) -> Vec<String> {
    let (mut found, mut sha1) = (vec![], None::<String>);
    for line in output.lines().map(str::trim) {
        if let Some(hash) = line.strip_prefix("SHA-1 hash: ") {
            sha1 = Some(hash.trim().to_string());
        } else if line == format!("\"labl\"<blob>=\"{CA_NAME}\"") {
            found.extend(sha1.take());
        }
    }
    found
}

// Windows.

/// A PowerShell single-quoted string. PowerShell also ends such strings at curly single quotes.
fn ps_quote(text: &str) -> String {
    let mut quoted = String::from("'");
    for c in text.chars() {
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            quoted.push(c);
        }
        quoted.push(c);
    }
    quoted + "'"
}

/// A command for `powershell -EncodedCommand`: UTF-16LE in base64, so no quoting reaches the command line.
fn ps_encoded(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Lists the NRPT rules and whether the certificate is in a Root store, for `win_parse_status`.
fn win_status_script(thumbprint: &str) -> String {
    let tp = ps_quote(thumbprint);
    format!(
        "$ErrorActionPreference = 'SilentlyContinue'\n\
         Get-DnsClientNrptRule | ForEach-Object {{ \"nrpt`t\" + ($_.Namespace -join ',') + \"`t\" + ($_.NameServers -join ',') }}\n\
         \"cert`t\" + [bool]((Test-Path (Join-Path 'Cert:\\LocalMachine\\Root' {tp})) -or (Test-Path (Join-Path 'Cert:\\CurrentUser\\Root' {tp})))\n"
    )
}

/// (resolver, ca_trusted) from `win_status_script`'s output.
fn win_parse_status(output: &str) -> (bool, bool) {
    let (mut resolver, mut trusted) = (false, false);
    for line in output.lines() {
        let fields: Vec<&str> = line.trim_end().split('\t').collect();
        match fields.as_slice() {
            ["nrpt", spaces, servers] => {
                resolver |= spaces.split(',').any(|s| s.eq_ignore_ascii_case(".test")) && servers.split(',').any(|s| s == "127.0.0.1")
            }
            ["cert", value] => trusted = value.eq_ignore_ascii_case("true"),
            _ => {}
        }
    }
    (resolver, trusted)
}

// The elevated script can't hand text back (Start-Process -Verb RunAs has no output), and a log file in your temp
// folder is one you could have prepared, so each step reports through its own exit code instead.
const WIN_TRUST_FAILED: i32 = 10;
const WIN_DNS_FAILED: i32 = 11;

/// What a failed step's exit code means.
fn win_failure(code: i32) -> Option<&'static str> {
    match code {
        WIN_TRUST_FAILED => Some("Windows didn't change its trusted root certificates."),
        WIN_DNS_FAILED => Some("Windows didn't change its DNS rule for .test."),
        _ => None,
    }
}

/// A step that exits with `code` when it fails.
fn win_step(body: &str, code: i32) -> String {
    format!("try {{\n{body}}} catch {{ exit {code} }}\n")
}

/// Opens the machine's Root store as `$store`.
const WIN_OPEN_ROOT: &str = "  $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine')\n  $store.Open('ReadWrite')\n";

/// The elevated script: the certificate, embedded as DER, into the machine's Root store, replacing older Tusk CAs,
/// and the NRPT rule.
fn win_apply_script(der: &[u8], trust: bool, resolver: bool) -> String {
    use base64::Engine;
    let mut script = String::from("$ErrorActionPreference = 'Stop'\n");
    if trust {
        let body = format!(
            "  $cert = [Security.Cryptography.X509Certificates.X509Certificate2]::new([Convert]::FromBase64String('{}'))\n{WIN_OPEN_ROOT}\
             \x20 $store.Certificates | Where-Object {{ $_.GetNameInfo('SimpleName', $false) -eq {} -and $_.Thumbprint -ne $cert.Thumbprint }} | ForEach-Object {{ $store.Remove($_) }}\n\
             \x20 $store.Add($cert)\n  $store.Close()\n",
            base64::engine::general_purpose::STANDARD.encode(der),
            ps_quote(CA_NAME)
        );
        script += &win_step(&body, WIN_TRUST_FAILED);
    }
    if resolver {
        let body = "  Get-DnsClientNrptRule | Where-Object { $_.Comment -eq 'Tusk' } | ForEach-Object { Remove-DnsClientNrptRule -Name $_.Name -Force }\n\
                    \x20 Add-DnsClientNrptRule -Namespace '.test' -NameServers '127.0.0.1' -Comment 'Tusk'\n\
                    \x20 Clear-DnsClientCache\n";
        script += &win_step(body, WIN_DNS_FAILED);
    }
    script + "exit 0\n"
}

/// The elevated script that removes Tusk's NRPT rules and its certificates from the machine's Root store.
fn win_remove_script(thumbprint: Option<&str>) -> String {
    let by_print = thumbprint.map(|t| format!(" -or $_.Thumbprint -eq {}", ps_quote(t))).unwrap_or_default();
    let trust = format!(
        "{WIN_OPEN_ROOT}  $store.Certificates | Where-Object {{ $_.GetNameInfo('SimpleName', $false) -eq {}{by_print} }} | ForEach-Object {{ $store.Remove($_) }}\n  $store.Close()\n",
        ps_quote(CA_NAME)
    );
    let dns = "  Get-DnsClientNrptRule | Where-Object { $_.Comment -eq 'Tusk' -or (($_.Namespace -contains '.test') -and ($_.NameServers -contains '127.0.0.1')) } | ForEach-Object { Remove-DnsClientNrptRule -Name $_.Name -Force }\n\
               \x20 Clear-DnsClientCache\n";
    format!("$ErrorActionPreference = 'Stop'\n{}{}exit 0\n", win_step(&trust, WIN_TRUST_FAILED), win_step(dns, WIN_DNS_FAILED))
}

/// The command, for a plain `powershell -Command`, that runs `script` elevated after the UAC prompt and exits with
/// its code, or 1223 (ERROR_CANCELLED) when the prompt was declined. The script travels encoded on the elevated
/// command line, so the elevated PowerShell reads no file. The command holds no double quotes, so it passes through
/// the command line unchanged.
fn win_elevate_command(script: &str) -> String {
    format!(
        "try {{ $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden \
         -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','{}'); exit $p.ExitCode }} \
         catch {{ $e = $_.Exception; while ($e) {{ if ($e.NativeErrorCode -eq 1223) {{ exit 1223 }}; $e = $e.InnerException }}; \
         [Console]::Error.WriteLine($_.Exception.Message); exit 2 }}",
        ps_encoded(script)
    )
}

// Linux.

const LINUX_DELEGATE: &str = "/etc/systemd/dns-delegate.d/tusk.dns-delegate";
const LINUX_SYSCTL: &str = "/etc/sysctl.d/50-tusk-ports.conf";
#[cfg(target_os = "linux")]
const LINUX_PORTS: &str = "/proc/sys/net/ipv4/ip_unprivileged_port_start";
/// CA bundles the system's trust tools write.
#[cfg(target_os = "linux")]
const LINUX_BUNDLES: &[&str] = &["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/ca-bundle.pem"];

/// How this Linux adds a system CA.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Store {
    /// Debian and Ubuntu.
    Debian,
    /// Fedora and RHEL.
    Fedora,
    /// p11-kit's `trust`: Arch, openSUSE, and others.
    P11,
}

impl Store {
    /// Where the certificate goes, for the stores that take a file.
    fn file(self) -> Option<&'static str> {
        match self {
            Store::Debian => Some("/usr/local/share/ca-certificates/tusk-local-ca.crt"),
            Store::Fedora => Some("/etc/pki/ca-trust/source/anchors/tusk-local-ca.pem"),
            Store::P11 => None,
        }
    }

    fn update(self) -> &'static str {
        match self {
            Store::Debian => "update-ca-certificates",
            Store::Fedora => "update-ca-trust extract",
            Store::P11 => "",
        }
    }
}

/// The systemd-resolved delegate that sends only .test to Tusk. Delegates aren't a default route unless they say so
/// (`DefaultRoute=` is off by default), unlike resolved.conf's global DNS=.
fn delegate_conf(port: u16) -> String {
    format!("{MARK}\n[Delegate]\nDNS=127.0.0.1:{port}\nDomains=~test\nDefaultRoute=no\n")
}

/// Whether a delegate file sends .test to 127.0.0.1 on `port`.
fn delegate_ok(text: &str, port: u16) -> bool {
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    let dns = format!("DNS=127.0.0.1:{port}");
    lines.contains(&"[Delegate]") && lines.contains(&dns.as_str()) && lines.contains(&"Domains=~test")
}

/// The version in `resolvectl --version`'s first line: "systemd 258 (258.1-1)".
fn systemd_version(output: &str) -> Option<u32> {
    output.split_whitespace().skip_while(|w| *w != "systemd").nth(1)?.parse().ok()
}

/// Whether ip_unprivileged_port_start lets programs listen on 80.
fn low_ports_ok(text: &str) -> bool {
    text.trim().parse::<u32>().is_ok_and(|v| v <= 80)
}

/// Whether resolv.conf, at `target` after links, hands lookups to systemd-resolved.
fn uses_resolved(target: &Path, text: &str) -> bool {
    target.starts_with("/run/systemd/resolve") || text.lines().any(|l| l.split_whitespace().eq(["nameserver", "127.0.0.53"]))
}

/// What the elevated Linux script sets up. Everything travels inside the script, so root reads none of your files.
#[derive(Default)]
struct LinuxApply<'a> {
    /// The certificate as PEM, and the store it goes in.
    trust: Option<(&'a str, Store)>,
    /// The DNS port for a resolved delegate.
    delegate: Option<u16>,
    /// The new /etc/hosts.
    hosts: Option<&'a str>,
    low_ports: bool,
}

const HEREDOC_END: &str = "TUSK_EOF";

/// A quoted here-document holding `content`, which must end in a newline; an error if a line would end it early.
fn heredoc(content: &str) -> Result<String, String> {
    if content.lines().any(|l| l == HEREDOC_END) || !content.ends_with('\n') {
        return Err("Tusk couldn't build its setup script.".into());
    }
    Ok(format!("<<'{HEREDOC_END}'\n{content}{HEREDOC_END}\n"))
}

/// Writes `pem` to a private root-owned file for `trust anchor`, which takes only files, runs it, and deletes it.
fn p11_anchor(flag: &str, pem: &str) -> Result<String, String> {
    Ok(format!("f=$(mktemp)\ncat > \"$f\" {}trust anchor {flag} \"$f\" || {{ rm -f \"$f\"; exit 1; }}\nrm -f \"$f\"\n", heredoc(pem)?))
}

/// Runs `body` with `set -e`. The subshell turns every failure into exit 1, so pkexec's own 126 and 127 stay
/// distinct from a missing command's 127.
fn linux_script(body: &str) -> String {
    format!("#!/bin/sh\n(\nset -e\n{body}) || exit 1\n")
}

/// Replaces /etc/hosts with `text`, byte for byte. printf rather than a here-document, which would add a final
/// newline the file may not have. > keeps the file's owner, mode, and inode.
fn hosts_write(text: &str) -> String {
    format!("printf '%s' {} > /etc/hosts\n", crate::toolpaths::quote(text))
}

fn linux_apply_script(a: &LinuxApply) -> Result<String, String> {
    let mut body = String::new();
    match a.trust {
        Some((pem, Store::P11)) => body += &p11_anchor("--store", pem)?,
        Some((pem, store)) => {
            let file = store.file().unwrap_or_default();
            body += &format!("cat > {file} {}chmod 644 {file}\n{}\n", heredoc(pem)?, store.update());
        }
        None => {}
    }
    if let Some(port) = a.delegate {
        body += &format!("mkdir -p /etc/systemd/dns-delegate.d\ncat > {LINUX_DELEGATE} {}systemctl restart systemd-resolved\n", heredoc(&delegate_conf(port))?);
    }
    if let Some(hosts) = a.hosts {
        body += &hosts_write(hosts);
    }
    if a.low_ports {
        body += &format!("printf '%s\\n' '{MARK}' 'net.ipv4.ip_unprivileged_port_start=80' > {LINUX_SYSCTL}\nsysctl -w net.ipv4.ip_unprivileged_port_start=80\n");
    }
    Ok(linux_script(&body))
}

/// What the elevated Linux script removes.
#[derive(Default)]
struct LinuxRemove<'a> {
    /// The store to take the certificate out of, with the certificate as PEM for p11-kit.
    trust: Option<(Store, &'a str)>,
    delegate: bool,
    /// The new /etc/hosts, without Tusk's block.
    hosts: Option<&'a str>,
    sysctl: bool,
}

impl LinuxRemove<'_> {
    fn is_empty(&self) -> bool {
        self.trust.is_none() && !self.delegate && self.hosts.is_none() && !self.sysctl
    }
}

fn linux_remove_script(r: &LinuxRemove) -> Result<String, String> {
    let mut body = String::new();
    match r.trust {
        Some((Store::P11, pem)) => body += &p11_anchor("--remove", pem)?,
        Some((store, _)) => body += &format!("rm -f {}\n{}\n", store.file().unwrap_or_default(), store.update()),
        None => {}
    }
    if r.delegate {
        body += &format!("if grep -qx '{MARK}' {LINUX_DELEGATE}; then rm -f {LINUX_DELEGATE}; systemctl restart systemd-resolved; fi\n");
    }
    if let Some(hosts) = r.hosts {
        body += &hosts_write(hosts);
    }
    if r.sysctl {
        body += &format!("rm -f {LINUX_SYSCTL}\nsysctl -w net.ipv4.ip_unprivileged_port_start=1024\n");
    }
    Ok(linux_script(&body))
}

/// NSS databases of Chrome, Chromium, and Firefox profiles under `home`, including the snap and flatpak ones.
#[cfg(target_os = "linux")]
fn nss_dbs(home: &Path) -> Vec<PathBuf> {
    let mut dbs: Vec<PathBuf> = [".pki/nssdb", "snap/chromium/current/.pki/nssdb"].iter().map(|p| home.join(p)).filter(|p| p.join("cert9.db").is_file()).collect();
    for root in [".mozilla/firefox", "snap/firefox/common/.mozilla/firefox", ".var/app/org.mozilla.firefox/.mozilla/firefox", ".config/mozilla/firefox"] {
        for entry in std::fs::read_dir(home.join(root)).into_iter().flatten().flatten() {
            if entry.path().join("cert9.db").is_file() {
                dbs.push(entry.path());
            }
        }
    }
    dbs
}

// The hosts file block, for systems without a per-domain resolver.

/// A site name with `.test`, lowercase.
fn host_name(name: &str) -> String {
    let name = name.trim().trim_end_matches('.').to_ascii_lowercase();
    if name.ends_with(".test") { name } else { format!("{name}.test") }
}

/// The text before Tusk's block, the block, and the text after, split at line starts.
fn hosts_split(text: &str) -> (&str, Option<&str>, &str) {
    let mut start = None;
    let mut at = 0;
    for line in text.split_inclusive('\n') {
        let end = at + line.len();
        match (start, line.trim()) {
            (None, HOSTS_BEGIN) => start = Some(at),
            (Some(s), HOSTS_END) => return (&text[..s], Some(&text[s..end]), &text[end..]),
            _ => {}
        }
        at = end;
    }
    // A block without its end runs to the end of the file.
    match start {
        Some(s) => (&text[..s], Some(&text[s..]), ""),
        None => (text, None, ""),
    }
}

/// The names in Tusk's block.
fn hosts_names(text: &str) -> Vec<String> {
    let mut names: Vec<String> = vec![];
    for line in hosts_split(text).1.unwrap_or_default().lines() {
        if line.trim_start().starts_with('#') {
            continue;
        }
        for name in line.split_whitespace().skip(1) {
            if !names.iter().any(|n| n == name) {
                names.push(name.to_string());
            }
        }
    }
    names
}

/// `text` with `names` added to Tusk's block, keeping its line endings and everything outside the block.
fn hosts_with(text: &str, names: &[String]) -> String {
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let (before, block, after) = hosts_split(text);
    let mut all = hosts_names(text);
    for name in names.iter().map(|n| host_name(n)) {
        if !all.contains(&name) {
            all.push(name);
        }
    }
    let mut out = before.to_string();
    if block.is_none() && !out.is_empty() && !out.ends_with('\n') {
        out += eol;
    }
    out += HOSTS_BEGIN;
    out += eol;
    for name in &all {
        out += &format!("127.0.0.1 {name}{eol}::1 {name}{eol}");
    }
    out += HOSTS_END;
    out += eol;
    out + after
}

/// `text` without Tusk's block.
fn hosts_without(text: &str) -> String {
    let (before, _, after) = hosts_split(text);
    format!("{before}{after}")
}

// Running things, per OS.

#[cfg(target_os = "macos")]
mod imp {
    use super::*;

    const SECURITY: &str = "/usr/bin/security";

    fn login_keychain() -> String {
        format!("{}/Library/Keychains/login.keychain-db", std::env::var("HOME").unwrap_or_default())
    }

    pub fn status(w: &Wanted) -> Status {
        // verify-cert evaluates this exact certificate against the trust settings, offline (-L).
        let ca_trusted = cmd(SECURITY).args(["verify-cert", "-p", "basic", "-L", "-c"]).arg(&w.ca_pem).output().is_ok_and(|o| o.status.success());
        let resolver = std::fs::read_to_string(MAC_RESOLVER).is_ok_and(|t| mac_resolver_ok(&t, w.dns_port));
        Status { ca_trusted, resolver, missing_hosts: vec![], low_ports: true, uses_hosts: false }
    }

    /// Tusk CAs in the login keychain, by SHA-1.
    fn tusk_certs() -> Vec<String> {
        let out = cmd(SECURITY).args(["find-certificate", "-a", "-Z", "-c", CA_NAME, login_keychain().as_str()]).output();
        out.map(|o| mac_tusk_certs(&String::from_utf8_lossy(&o.stdout))).unwrap_or_default()
    }

    /// Runs `security`, mapping a dismissed trust dialog to "cancelled".
    fn security(args: &[&std::ffi::OsStr]) -> Result<(), String> {
        let out = cmd(SECURITY).args(args).output().map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(());
        }
        let error = failure(&out);
        if error.to_ascii_lowercase().contains("canceled by the user") { Err("cancelled".into()) } else { Err(format!("macOS didn't trust Tusk's certificate: {error}")) }
    }

    /// Deletes a certificate and its trust settings, or just the certificate when it has none.
    fn delete(sha1: &str) -> Result<(), String> {
        let keychain = login_keychain();
        let args: [&std::ffi::OsStr; 4] = ["delete-certificate".as_ref(), "-Z".as_ref(), sha1.as_ref(), keychain.as_ref()];
        match security(&[&args[..3], &["-t".as_ref()], &args[3..]].concat()) {
            Err(e) if e != "cancelled" => security(&args),
            result => result,
        }
    }

    fn elevate(script: &str, prompt: &str) -> Result<(), String> {
        let out = cmd("/usr/bin/osascript").arg("-e").arg(mac_osascript(script, prompt)).output().map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(());
        }
        let error = failure(&out);
        if error.contains("(-128)") {
            return Err("cancelled".into());
        }
        let error = error.split_once("execution error: ").map_or(error.as_str(), |(_, e)| e);
        Err(format!("Setup failed: {error}"))
    }

    pub fn apply(w: &Wanted, _low_ports: bool) -> Result<Vec<String>, String> {
        let before = status(w);
        if !before.ca_trusted {
            let ours = sha1_hex(&ca_der(&w.ca_pem)?);
            // Trust in your login keychain: macOS asks for it in its own dialog, root or not, and Safari, Chrome, and
            // Firefox all read it.
            for old in tusk_certs().into_iter().filter(|c| *c != ours) {
                delete(&old)?;
            }
            let keychain = login_keychain();
            // ponytail: security reads ca.pem as you, so a process running as you could swap it before the trust
            // dialog; that dialog doesn't show which certificate it trusts. Calling SecTrustSettingsSetTrustSettings
            // with the parsed bytes closes the gap, at the cost of Security framework bindings.
            security(&["add-trusted-cert".as_ref(), "-r".as_ref(), "trustRoot".as_ref(), "-k".as_ref(), keychain.as_ref(), w.ca_pem.as_os_str()])?;
        }
        if !before.resolver {
            elevate(&mac_apply_script(w.dns_port), MAC_PROMPT)?;
        }
        Ok(vec![])
    }

    pub fn remove(ca_pem: &Path) -> Result<(), String> {
        // Every Tusk CA, this one included: they all carry its name.
        let _ = ca_pem;
        for cert in tusk_certs() {
            delete(&cert)?;
        }
        if std::fs::read_to_string(MAC_RESOLVER).is_ok_and(|t| is_tusk_file(&t)) {
            elevate(&mac_remove_script(), MAC_REMOVE_PROMPT)?;
        }
        Ok(())
    }
}

#[cfg(windows)]
mod imp {
    use super::*;

    fn powershell(script: &str) -> std::io::Result<std::process::Output> {
        cmd("powershell.exe").args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &ps_encoded(script)]).output()
    }

    pub fn status(w: &Wanted) -> Status {
        let print = ca_der(&w.ca_pem).map(|d| sha1_hex(&d)).unwrap_or_default();
        let out = powershell(&win_status_script(&print)).map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
        let (resolver, trusted) = win_parse_status(&out);
        Status { ca_trusted: trusted && !print.is_empty(), resolver, missing_hosts: vec![], low_ports: true, uses_hosts: false }
    }

    /// Runs `script` elevated, once you accept the UAC prompt.
    fn elevate(script: &str) -> Result<(), String> {
        let out = cmd("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &win_elevate_command(script)]).output().map_err(|e| e.to_string())?;
        match out.status.code() {
            Some(0) => Ok(()),
            Some(1223) => Err("cancelled".into()),
            Some(code) if win_failure(code).is_some() => Err(format!("Setup failed: {}", win_failure(code).unwrap_or_default())),
            _ => Err(format!("Setup failed: {}", failure(&out))),
        }
    }

    pub fn apply(w: &Wanted, _low_ports: bool) -> Result<Vec<String>, String> {
        let before = status(w);
        if !before.resolver && w.dns_port != 53 {
            return Err(format!("Windows sends .test lookups to port 53 only, but Tusk's DNS responder is on port {}.", w.dns_port));
        }
        if before.ca_trusted && before.resolver {
            return Ok(vec![]);
        }
        elevate(&win_apply_script(&ca_der(&w.ca_pem)?, !before.ca_trusted, !before.resolver))?;
        Ok(vec![])
    }

    pub fn remove(ca_pem: &Path) -> Result<(), String> {
        let print = ca_der(ca_pem).ok().map(|d| sha1_hex(&d));
        elevate(&win_remove_script(print.as_deref()))
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;

    const NSS_NOTE: &str = "Chrome and Firefox keep their own certificate lists. Install libnss3-tools (Debian, Ubuntu) or nss-tools (Fedora), then set up again so Tusk can add its certificate to them.";
    const HOSTS_NOTE: &str = "This Linux has no per-domain DNS hook that Tusk can use, so it lists your sites in /etc/hosts. Set up again after you add a site.";

    fn home() -> PathBuf {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
    }

    /// Whether .test goes to a resolved delegate: systemd-resolved handles lookups and is 258 or later.
    fn delegates() -> bool {
        let conf = Path::new("/etc/resolv.conf");
        let target = std::fs::canonicalize(conf).unwrap_or_else(|_| conf.into());
        let text = std::fs::read_to_string(conf).unwrap_or_default();
        uses_resolved(&target, &text)
            && cmd("resolvectl").arg("--version").output().ok().and_then(|o| systemd_version(&String::from_utf8_lossy(&o.stdout))).is_some_and(|v| v >= 258)
    }

    fn store() -> Option<Store> {
        if Path::new("/usr/local/share/ca-certificates").is_dir() {
            Some(Store::Debian)
        } else if Path::new("/etc/pki/ca-trust/source/anchors").is_dir() {
            Some(Store::Fedora)
        } else if cmd("trust").arg("--help").output().is_ok() {
            Some(Store::P11)
        } else {
            None
        }
    }

    fn system_trusted(ca: &[u8]) -> bool {
        LINUX_BUNDLES.iter().any(|b| std::fs::read_to_string(b).is_ok_and(|t| pem_certs(&t).iter().any(|c| c == ca)))
    }

    fn certutil(db: &Path) -> Command {
        let mut c = cmd("certutil");
        c.arg("-d").arg(format!("sql:{}", db.display()));
        c
    }

    fn has_certutil() -> bool {
        cmd("certutil").arg("-H").output().is_ok()
    }

    fn nss_has(db: &Path, ca: &[u8]) -> bool {
        certutil(db).args(["-L", "-a", "-n", CA_NAME]).output().is_ok_and(|o| pem_certs(&String::from_utf8_lossy(&o.stdout)).iter().any(|c| c == ca))
    }

    /// Removes every certificate named "Tusk Local CA" from `db`.
    fn nss_delete(db: &Path) {
        for _ in 0..10 {
            if !certutil(db).args(["-D", "-n", CA_NAME]).output().is_ok_and(|o| o.status.success()) {
                break;
            }
        }
    }

    pub fn status(w: &Wanted) -> Status {
        let ca_trusted = ca_der(&w.ca_pem).is_ok_and(|ca| system_trusted(&ca) && (!has_certutil() || nss_dbs(&home()).iter().all(|db| nss_has(db, &ca))));
        let low_ports = std::fs::read_to_string(LINUX_PORTS).is_ok_and(|t| low_ports_ok(&t));
        if delegates() {
            let resolver = std::fs::read_to_string(LINUX_DELEGATE).is_ok_and(|t| delegate_ok(&t, w.dns_port));
            return Status { ca_trusted, resolver, missing_hosts: vec![], low_ports, uses_hosts: false };
        }
        let listed = hosts_names(&std::fs::read_to_string("/etc/hosts").unwrap_or_default());
        let mut missing: Vec<String> = w.names.iter().map(|n| host_name(n)).filter(|n| !listed.contains(n)).collect();
        missing.dedup();
        Status { ca_trusted, resolver: missing.is_empty(), missing_hosts: missing, low_ports, uses_hosts: true }
    }

    /// Runs `script` as root through polkit. Keeps the script when you have to run it yourself.
    /// Runs `script` as root through polkit, inline, so root runs no file you could change. When you have to run it
    /// yourself, it's kept in a file for `sudo sh`.
    fn elevate(script: &str) -> Result<(), String> {
        // A script over Linux's 128 KB argument limit, such as one carrying a very large /etc/hosts, fails to start
        // and takes the run-it-yourself path too.
        let reason = match cmd("pkexec").arg("/bin/sh").arg("-c").arg(script).output() {
            Ok(out) => match out.status.code() {
                Some(0) => return Ok(()),
                Some(126) => return Err("cancelled".into()),
                Some(127) => "you aren't authorized, or no polkit agent is running".to_string(),
                _ => return Err(format!("Setup failed: {}", failure(&out))),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => "pkexec isn't installed".into(),
            Err(e) => e.to_string(),
        };
        let mut scratch = Scratch::new()?;
        let path = scratch.file("tusk-setup.sh", script.as_bytes())?;
        scratch.keep = true;
        Err(format!("Tusk couldn't ask for your password: {reason}. Run this in a terminal, then try again: sudo sh {}", crate::toolpaths::quote(&path.to_string_lossy())))
    }

    pub fn apply(w: &Wanted, low_ports: bool) -> Result<Vec<String>, String> {
        let ca = ca_der(&w.ca_pem)?;
        let before = status(w);
        let mut notes = vec![];
        // Browsers' own lists, as you.
        if has_certutil() {
            for db in nss_dbs(&home()).iter().filter(|db| !nss_has(db, &ca)) {
                nss_delete(db);
                let out = certutil(db).args(["-A", "-t", "C,,", "-n", CA_NAME, "-i"]).arg(&w.ca_pem).output().map_err(|e| e.to_string())?;
                if !out.status.success() {
                    return Err(format!("Tusk couldn't add its certificate to {}: {}", db.display(), failure(&out)));
                }
            }
        } else {
            notes.push(NSS_NOTE.to_string());
        }
        let pem = der_pem(&ca);
        let hosts;
        let mut plan = LinuxApply { low_ports: low_ports && !before.low_ports, ..Default::default() };
        if !system_trusted(&ca) {
            let store = store().ok_or("This Linux has none of update-ca-certificates, update-ca-trust, or trust, so Tusk can't add its certificate.")?;
            plan.trust = Some((&pem, store));
        }
        if !before.resolver {
            if before.uses_hosts {
                hosts = hosts_with(&std::fs::read_to_string("/etc/hosts").unwrap_or_default(), &w.names);
                plan.hosts = Some(&hosts);
            } else {
                plan.delegate = Some(w.dns_port);
            }
        }
        if before.uses_hosts {
            notes.push(HOSTS_NOTE.to_string());
        }
        if plan.trust.is_some() || plan.delegate.is_some() || plan.hosts.is_some() || plan.low_ports {
            elevate(&linux_apply_script(&plan)?)?;
        }
        Ok(notes)
    }

    pub fn remove(ca_pem: &Path) -> Result<(), String> {
        let ca = ca_der(ca_pem).ok();
        if has_certutil() {
            for db in nss_dbs(&home()) {
                nss_delete(&db);
            }
        }
        let pem = ca.as_deref().map(der_pem).unwrap_or_default();
        let trust = match store() {
            Some(s @ (Store::Debian | Store::Fedora)) if s.file().is_some_and(|f| Path::new(f).exists()) => Some((s, pem.as_str())),
            Some(Store::P11) if ca.as_deref().is_some_and(system_trusted) => Some((Store::P11, pem.as_str())),
            _ => None,
        };
        let delegate = std::fs::read_to_string(LINUX_DELEGATE).is_ok_and(|t| is_tusk_file(&t));
        let text = std::fs::read_to_string("/etc/hosts").unwrap_or_default();
        let hosts = hosts_split(&text).1.map(|_| hosts_without(&text));
        let undo = LinuxRemove { trust, delegate, hosts: hosts.as_deref(), sysctl: Path::new(LINUX_SYSCTL).exists() };
        if undo.is_empty() {
            return Ok(());
        }
        elevate(&linux_remove_script(&undo)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_certificates_and_fingerprints() {
        let pem = "junk\n-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\r\n-----BEGIN CERTIFICATE-----\nZGVm\n-----END CERTIFICATE-----\n";
        assert_eq!(pem_certs(pem), vec![b"abc".to_vec(), b"def".to_vec()]);
        assert_eq!(sha1_hex(b"abc"), "A9993E364706816ABA3E25717850C26C9CD0D89D");
    }

    #[test]
    fn mac_resolver_file() {
        assert!(mac_resolver_ok("# Tusk\nnameserver 127.0.0.1\nport 15353\n", 15353));
        // dotest's file, on another port.
        assert!(!mac_resolver_ok("nameserver 127.0.0.1\nport 5354\n", 15353));
        assert!(!mac_resolver_ok("nameserver 127.0.0.1\n", 15353), "no port means 53");
        assert!(!mac_resolver_ok("nameserver 127.0.0.1\nnameserver 10.0.0.1\nport 15353\n", 15353));
        assert!(!mac_resolver_ok("", 15353));
        assert!(mac_resolver_ok(&mac_apply_script(15353).lines().skip(3).take(3).collect::<Vec<_>>().join("\n"), 15353));
        assert!(is_tusk_file("# Tusk\nnameserver 127.0.0.1\n"));
        assert!(!is_tusk_file("nameserver 127.0.0.1\nport 5354\n"));
    }

    #[test]
    fn mac_scripts() {
        let apply = mac_apply_script(15353);
        assert!(apply.contains("cat > /etc/resolver/test <<'TUSK'\n# Tusk\nnameserver 127.0.0.1\nport 15353\nTUSK\n"));
        assert!(apply.contains("dscacheutil -flushcache\nkillall -HUP mDNSResponder"));
        let remove = mac_remove_script();
        assert!(remove.starts_with("if grep -qx '# Tusk' /etc/resolver/test 2>/dev/null; then rm -f /etc/resolver/test; fi"));
        // The script goes inline, escaped for AppleScript.
        let script = mac_osascript("echo 'it''s' \"q\" \\x\nnext", MAC_PROMPT);
        assert_eq!(
            script,
            "do shell script \"echo 'it''s' \\\"q\\\" \\\\x\\nnext\" with administrator privileges \
             with prompt \"Tusk needs your password to send .test names to Tusk, so https://<name>.test sites open in your browser.\""
        );
        let apply = mac_osascript(&apply, MAC_PROMPT);
        assert!(apply.starts_with("do shell script \"set -e\\nmkdir -p /etc/resolver\\n") && !apply.contains("/bin/sh") && !apply.contains('\n'));
    }

    #[test]
    fn mac_finds_tusk_certificates() {
        let out = "SHA-256 hash: AA\nSHA-1 hash: 1111\nkeychain: \"/k\"\nattributes:\n    \"labl\"<blob>=\"Tusk Local CA\"\n\
                   SHA-256 hash: BB\nSHA-1 hash: 2222\nattributes:\n    \"labl\"<blob>=\"Tusk Local CA 2\"\n\
                   SHA-256 hash: CC\nSHA-1 hash: 3333\nattributes:\n    \"labl\"<blob>=\"Tusk Local CA\"\n";
        assert_eq!(mac_tusk_certs(out), ["1111", "3333"]);
    }

    #[test]
    fn powershell_quoting() {
        assert_eq!(ps_quote("C:\\Users\\O'Brien\\it\u{2019}s"), "'C:\\Users\\O''Brien\\it\u{2019}\u{2019}s'");
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(ps_encoded("é'")).unwrap();
        assert_eq!(bytes, [0xE9, 0, b'\'', 0]);
    }

    #[test]
    fn windows_scripts() {
        use base64::Engine;
        let der = [0x30u8, 0x82, 0xFF, 0x01];
        let apply = win_apply_script(&der, true, true);
        assert!(apply.starts_with("$ErrorActionPreference = 'Stop'\ntry {\n"));
        assert!(apply.contains("X509Certificate2]::new([Convert]::FromBase64String('MIL/AQ=='))"));
        assert!(apply.contains("X509Store]::new('Root', 'LocalMachine')"));
        assert!(apply.contains("Where-Object { $_.GetNameInfo('SimpleName', $false) -eq 'Tusk Local CA' -and $_.Thumbprint -ne $cert.Thumbprint } | ForEach-Object { $store.Remove($_) }"));
        assert!(apply.contains("  $store.Add($cert)\n  $store.Close()\n} catch { exit 10 }\n"));
        assert!(apply.contains("  Add-DnsClientNrptRule -Namespace '.test' -NameServers '127.0.0.1' -Comment 'Tusk'\n  Clear-DnsClientCache\n} catch { exit 11 }\nexit 0\n"));
        assert!(!apply.contains("-FilePath") && !apply.contains("Import-Certificate") && !apply.contains("Temp"));
        let only_dns = win_apply_script(&der, false, true);
        assert!(!only_dns.contains("X509") && only_dns.contains("Add-DnsClientNrptRule"));
        let remove = win_remove_script(Some("AB'CD"));
        assert!(remove.contains("-eq 'Tusk Local CA' -or $_.Thumbprint -eq 'AB''CD' } | ForEach-Object { $store.Remove($_) }"));
        assert!(remove.contains("$_.Comment -eq 'Tusk' -or (($_.Namespace -contains '.test') -and ($_.NameServers -contains '127.0.0.1'))"));
        assert!(!win_remove_script(None).contains("Thumbprint"));
        assert_eq!(win_failure(10), Some("Windows didn't change its trusted root certificates."));
        assert_eq!(win_failure(2), None);

        // The elevated script travels encoded, and the whole command line stays well under Windows' 32,767
        // characters for a large CA (an RSA 4096 CA is about 1.4 KB of DER; Tusk's P-256 one about 0.5 KB).
        let big = vec![0x30u8; 1400];
        let script = win_apply_script(&big, true, true);
        let elevate = win_elevate_command(&script);
        assert!(elevate.contains("-Verb RunAs -Wait -PassThru -WindowStyle Hidden"));
        assert!(elevate.contains(&format!("'-EncodedCommand','{}'); exit $p.ExitCode", ps_encoded(&script))));
        assert!(elevate.contains("NativeErrorCode -eq 1223) { exit 1223 }"));
        assert!(!elevate.contains('"') && !elevate.contains("'-File'"));
        let line = format!("powershell.exe -NoProfile -NonInteractive -Command \"{elevate}\"");
        assert!(line.len() < 12_000, "{} characters", line.len());
        let inner = base64::engine::general_purpose::STANDARD.decode(ps_encoded(&script)).unwrap();
        assert_eq!(inner.len(), script.encode_utf16().count() * 2);
        assert!(win_status_script("AB'CD").contains("Join-Path 'Cert:\\LocalMachine\\Root' 'AB''CD'"));
    }

    #[test]
    fn windows_status_output() {
        assert_eq!(win_parse_status("nrpt\t.test\t127.0.0.1\r\ncert\tTrue\r\n"), (true, true));
        assert_eq!(win_parse_status("nrpt\t.corp.example\t10.0.0.1\ncert\tFalse\n"), (false, false));
        assert_eq!(win_parse_status("nrpt\t.test\t10.0.0.1,192.168.1.1\ncert\tFalse\n"), (false, false));
        assert_eq!(win_parse_status("nrpt\t.x,.test\t::1,127.0.0.1\n"), (true, false));
        assert_eq!(win_parse_status(""), (false, false));
    }

    #[test]
    fn linux_parsers() {
        assert!(delegate_ok(&delegate_conf(15353), 15353));
        assert!(!delegate_ok(&delegate_conf(15353), 5354));
        assert!(!delegate_ok("[Resolve]\nDNS=127.0.0.1:15353\nDomains=~test\n", 15353));
        assert_eq!(systemd_version("systemd 258 (258.1-1ubuntu1)\n+PAM +AUDIT\n"), Some(258));
        assert_eq!(systemd_version("systemd 249 (249.11-0ubuntu3.12)\n"), Some(249));
        assert_eq!(systemd_version(""), None);
        assert!(low_ports_ok("80\n") && low_ports_ok("0\n"));
        assert!(!low_ports_ok("1024\n") && !low_ports_ok(""));
        assert!(uses_resolved(Path::new("/run/systemd/resolve/stub-resolv.conf"), ""));
        assert!(uses_resolved(Path::new("/etc/resolv.conf"), "# x\nnameserver 127.0.0.53\noptions edns0\n"));
        assert!(!uses_resolved(Path::new("/etc/resolv.conf"), "nameserver 192.168.1.1\n"));
    }

    #[test]
    fn linux_scripts() {
        let pem = der_pem(&[0x30u8; 100]);
        assert!(pem.starts_with("-----BEGIN CERTIFICATE-----\nMDAw") && pem.ends_with("=\n-----END CERTIFICATE-----\n"));
        assert_eq!(pem_certs(&pem), [vec![0x30u8; 100]]);
        let hosts = "127.0.0.1 localhost\n# it's\n127.0.0.1 a.test";
        let all = linux_apply_script(&LinuxApply { trust: Some((&pem, Store::Debian)), delegate: Some(15353), hosts: Some(hosts), low_ports: true }).unwrap();
        assert!(all.starts_with("#!/bin/sh\n(\nset -e\n") && all.ends_with(") || exit 1\n"));
        assert!(all.contains(&format!(
            "cat > /usr/local/share/ca-certificates/tusk-local-ca.crt <<'TUSK_EOF'\n{pem}TUSK_EOF\nchmod 644 /usr/local/share/ca-certificates/tusk-local-ca.crt\nupdate-ca-certificates\n"
        )));
        assert!(all.contains(
            "cat > /etc/systemd/dns-delegate.d/tusk.dns-delegate <<'TUSK_EOF'\n# Tusk\n[Delegate]\nDNS=127.0.0.1:15353\nDomains=~test\nDefaultRoute=no\nTUSK_EOF\nsystemctl restart systemd-resolved\n"
        ));
        // Byte for byte, without a final newline the file doesn't have.
        assert!(all.contains("printf '%s' '127.0.0.1 localhost\n# it'\\''s\n127.0.0.1 a.test' > /etc/hosts\n"));
        assert!(all.contains("> /etc/sysctl.d/50-tusk-ports.conf\nsysctl -w net.ipv4.ip_unprivileged_port_start=80\n"));
        let fedora = linux_apply_script(&LinuxApply { trust: Some((&pem, Store::Fedora)), ..Default::default() }).unwrap();
        assert!(fedora.contains("cat > /etc/pki/ca-trust/source/anchors/tusk-local-ca.pem <<'TUSK_EOF'\n") && fedora.contains("update-ca-trust extract\n") && !fedora.contains("systemctl"));
        let p11 = linux_apply_script(&LinuxApply { trust: Some((&pem, Store::P11)), ..Default::default() }).unwrap();
        assert!(p11.contains(&format!("f=$(mktemp)\ncat > \"$f\" <<'TUSK_EOF'\n{pem}TUSK_EOF\ntrust anchor --store \"$f\" || {{ rm -f \"$f\"; exit 1; }}\nrm -f \"$f\"\n")));

        let remove = linux_remove_script(&LinuxRemove { trust: Some((Store::Debian, "")), delegate: true, hosts: Some(hosts), sysctl: true }).unwrap();
        assert!(remove.contains("rm -f /usr/local/share/ca-certificates/tusk-local-ca.crt\nupdate-ca-certificates\n"));
        assert!(remove.contains("if grep -qx '# Tusk' /etc/systemd/dns-delegate.d/tusk.dns-delegate; then rm -f"));
        assert!(remove.contains("printf '%s' '127.0.0.1 localhost\n"));
        assert!(remove.contains("rm -f /etc/sysctl.d/50-tusk-ports.conf\nsysctl -w net.ipv4.ip_unprivileged_port_start=1024\n"));
        let p11 = linux_remove_script(&LinuxRemove { trust: Some((Store::P11, &pem)), ..Default::default() }).unwrap();
        assert!(p11.contains(&format!("<<'TUSK_EOF'\n{pem}TUSK_EOF\ntrust anchor --remove \"$f\"")));
        assert!(LinuxRemove::default().is_empty());

        // Root reads no file of yours: not ca.pem in your data folder, and no temp file.
        for script in [&all, &fedora, &p11, &remove] {
            assert!(!script.contains("/home/") && !script.contains("tusk-local-domains") && !script.contains("/tmp/") && !script.contains("cat '"), "{script}");
        }

        // Content that would end the here-document early fails instead of making a broken script.
        assert!(heredoc("a\nTUSK_EOF\nb\n").is_err());
        assert!(heredoc("no final newline").is_err());
        assert!(linux_apply_script(&LinuxApply { trust: Some(("x\nTUSK_EOF\n", Store::Debian)), ..Default::default() }).is_err());
        assert_eq!(heredoc("a\n TUSK_EOF\n").unwrap(), "<<'TUSK_EOF'\na\n TUSK_EOF\nTUSK_EOF\n");
    }

    #[test]
    fn hosts_block() {
        let names = |n: &[&str]| n.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let base = "127.0.0.1 localhost\n::1 localhost\n";
        let added = hosts_with(base, &names(&["shop", "blog.test"]));
        assert_eq!(
            added,
            "127.0.0.1 localhost\n::1 localhost\n# BEGIN Tusk .test domains\n127.0.0.1 shop.test\n::1 shop.test\n127.0.0.1 blog.test\n::1 blog.test\n# END Tusk .test domains\n"
        );
        assert_eq!(hosts_names(&added), ["shop.test", "blog.test"]);
        assert_eq!(hosts_with(&added, &names(&["shop", "BLOG.test"])), added, "idempotent");
        assert_eq!(hosts_without(&added), base);

        // Adding to a block in the middle keeps what follows it, and the earlier names.
        let middle = format!("{added}10.0.0.5 nas\n");
        let more = hosts_with(&middle, &names(&["api"]));
        assert!(more.ends_with("127.0.0.1 api.test\n::1 api.test\n# END Tusk .test domains\n10.0.0.5 nas\n"));
        assert_eq!(hosts_names(&more), ["shop.test", "blog.test", "api.test"]);
        assert_eq!(hosts_without(&more), format!("{base}10.0.0.5 nas\n"));

        // CRLF stays CRLF, and removal leaves the rest byte for byte.
        let crlf = "127.0.0.1 localhost\r\n# keep me  \r\n";
        let added = hosts_with(crlf, &names(&["a"]));
        assert_eq!(added, format!("{crlf}# BEGIN Tusk .test domains\r\n127.0.0.1 a.test\r\n::1 a.test\r\n# END Tusk .test domains\r\n"));
        assert_eq!(hosts_without(&added), crlf);

        // A file without a final newline, and an empty one.
        assert_eq!(hosts_with("127.0.0.1 localhost", &names(&["a"])), "127.0.0.1 localhost\n# BEGIN Tusk .test domains\n127.0.0.1 a.test\n::1 a.test\n# END Tusk .test domains\n");
        assert_eq!(hosts_with("", &[]), "# BEGIN Tusk .test domains\n# END Tusk .test domains\n");
        assert_eq!(hosts_without(base), base);
    }

    /// Runs `status` against a throwaway CA. Needs openssl: `cargo test localsystem -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_status() {
        let dir = std::env::temp_dir().join(format!("tusk-ca-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pem = dir.join("ca.pem");
        let ok = Command::new("openssl")
            .args(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-subj", "/CN=Tusk Local CA"])
            .args(["-addext", "basicConstraints=critical,CA:TRUE", "-addext", "nameConstraints=critical,permitted;DNS:.test", "-keyout"])
            .arg(dir.join("key.pem"))
            .arg("-out")
            .arg(&pem)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok);
        let w = Wanted { ca_pem: pem, dns_port: 15353, names: vec!["shop".into()] };
        let started = std::time::Instant::now();
        let s = status(&w);
        println!("status: {s:?} in {:?}", started.elapsed());
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!s.ca_trusted);
    }
}
