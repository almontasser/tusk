//! ~/.ssh/config, as `ssh` reads it, for deployment's SFTP servers: a server whose host is a `Host` alias connects
//! to its HostName, port, and user, with its keys, through its ProxyJump hosts.
//!
//! As in ssh, the first value found for a keyword wins, `Host` patterns take `*`, `?`, and `!`, and `Include` reads
//! other files in place, relative to ~/.ssh. `Match` blocks aren't evaluated: their settings are skipped.
//! IdentityFile collects every value, in order.

use std::path::{Path, PathBuf};

use globset::GlobBuilder;
use serde::Serialize;

/// What ~/.ssh/config says for one host.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostConfig {
    pub host_name: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_files: Vec<String>,
    pub identities_only: bool,
    /// Jump hosts, first first, as ProxyJump lists them: `[user@]host[:port]`, each read through this file again.
    pub proxy_jump: Vec<String>,
}

/// A `Host` alias for the Servers dialog: a name without wildcards, and what it resolves to.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Alias {
    pub alias: String,
    #[serde(flatten)]
    pub config: HostConfig,
}

/// One line that matters: a keyword and its arguments, after `Include`s are read in.
struct Line {
    key: String,
    args: Vec<String>,
}

pub fn home() -> PathBuf {
    std::env::home_dir().unwrap_or_default()
}

/// ~/.ssh/config; tests point TUSK_SSH_CONFIG elsewhere.
fn config_path() -> PathBuf {
    std::env::var_os("TUSK_SSH_CONFIG").map(PathBuf::from).unwrap_or_else(|| home().join(".ssh").join("config"))
}

/// A line's keyword (lower case) and arguments: `Key value`, `Key=value`, and `"quoted values"`.
fn split(line: &str) -> Option<(String, Vec<String>)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(line.len());
    let key = line[..end].to_lowercase();
    let rest = line[end..].trim_start().trim_start_matches('=').trim_start();
    let mut args = Vec::new();
    let mut chars = rest.chars().peekable();
    while chars.peek().is_some() {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        let mut arg = String::new();
        let mut quoted = false;
        while let Some(&c) = chars.peek() {
            if c == '"' {
                quoted = !quoted;
            } else if c.is_whitespace() && !quoted {
                break;
            } else {
                arg.push(c);
            }
            chars.next();
        }
        if !arg.is_empty() {
            args.push(arg);
        }
    }
    Some((key, args))
}

/// The file's lines with `Include`d files read in their place, at most 16 deep.
fn read(path: &Path, depth: usize, out: &mut Vec<Line>) {
    let Ok(text) = std::fs::read_to_string(path) else { return };
    for (key, args) in text.lines().filter_map(split) {
        if key != "include" {
            out.push(Line { key, args });
            continue;
        }
        if depth >= 16 {
            continue;
        }
        for pattern in args {
            let pattern = expand_tilde(&pattern);
            let full = if Path::new(&pattern).is_absolute() { pattern } else { crate::slash(home().join(".ssh").join(pattern)) };
            let mut files: Vec<PathBuf> = glob_files(&full);
            files.sort();
            for file in files {
                read(&file, depth + 1, out);
            }
        }
    }
}

/// The files a path with `*` or `?` in its file name matches, or the path itself.
fn glob_files(pattern: &str) -> Vec<PathBuf> {
    let path = Path::new(pattern);
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if !name.contains(['*', '?']) {
        return vec![path.to_path_buf()];
    }
    let Some(dir) = path.parent() else { return vec![] };
    let Ok(glob) = GlobBuilder::new(&name).literal_separator(true).build() else { return vec![] };
    let matcher = glob.compile_matcher();
    std::fs::read_dir(dir).map(|d| d.flatten().map(|e| e.path()).filter(|p| p.file_name().is_some_and(|n| matcher.is_match(n))).collect()).unwrap_or_default()
}

fn expand_tilde(path: &str) -> String {
    match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{}{rest}", crate::slash(home())),
        _ => path.to_string(),
    }
}

/// Whether `host` matches a `Host` line's patterns: any positive one matches and no negated one does.
fn host_matches(patterns: &[String], host: &str) -> bool {
    let matches = |p: &str| GlobBuilder::new(p).case_insensitive(true).build().is_ok_and(|g| g.compile_matcher().is_match(host));
    let mut any = false;
    for p in patterns {
        if let Some(negated) = p.strip_prefix('!') {
            if matches(negated) {
                return false;
            }
        } else if matches(p) {
            any = true;
        }
    }
    any
}

fn resolve_in(lines: &[Line], host: &str) -> HostConfig {
    let mut c = HostConfig::default();
    let mut port: Option<Option<u16>> = None;
    let mut identities_only = None;
    let mut jump: Option<Vec<String>> = None;
    // Lines before the first Host apply to every host.
    let mut active = true;
    for Line { key, args } in lines {
        match key.as_str() {
            "host" => active = host_matches(args, host),
            "match" => active = false,
            _ if !active => {}
            "hostname" => c.host_name = c.host_name.take().or_else(|| args.first().cloned()),
            "port" => port = port.or_else(|| Some(args.first().and_then(|p| p.parse().ok()))),
            "user" => c.user = c.user.take().or_else(|| args.first().cloned()),
            "identityfile" => c.identity_files.extend(args.first().cloned()),
            "identitiesonly" => identities_only = identities_only.or_else(|| args.first().map(|v| v.eq_ignore_ascii_case("yes"))),
            "proxyjump" => jump = jump.or_else(|| Some(args.first().map(|v| if v.eq_ignore_ascii_case("none") { vec![] } else { v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect() }).unwrap_or_default())),
            _ => {}
        }
    }
    c.port = port.flatten();
    c.identities_only = identities_only.unwrap_or(false);
    c.proxy_jump = jump.unwrap_or_default();
    // %h is the host name after HostName; %u the local user; %r the remote user; %p the port; %d home; %% a %.
    let host_name = c.host_name.as_deref().map(|h| h.replace("%h", host)).unwrap_or_else(|| host.to_string());
    let tokens = |s: &str| {
        let mut out = String::new();
        let mut chars = s.chars();
        while let Some(ch) = chars.next() {
            if ch != '%' {
                out.push(ch);
                continue;
            }
            match chars.next() {
                Some('h') => out.push_str(&host_name),
                Some('n') => out.push_str(host),
                Some('u') => out.push_str(&crate::deploy::whoami()),
                Some('r') => out.push_str(c.user.as_deref().unwrap_or(&crate::deploy::whoami())),
                Some('p') => out.push_str(&c.port.unwrap_or(22).to_string()),
                Some('d') => out.push_str(&crate::slash(home())),
                Some('%') => out.push('%'),
                Some(other) => {
                    out.push('%');
                    out.push(other);
                }
                None => out.push('%'),
            }
        }
        out
    };
    c.identity_files = c.identity_files.iter().map(|f| expand_tilde(&tokens(f))).collect();
    if c.host_name.is_some() {
        c.host_name = Some(host_name);
    }
    c
}

/// What ~/.ssh/config says for `host`.
pub fn resolve(host: &str) -> HostConfig {
    let mut lines = Vec::new();
    read(&config_path(), 0, &mut lines);
    resolve_in(&lines, host)
}

/// The aliases in ~/.ssh/config that name one host (no wildcards or negations), each resolved.
fn aliases_in(lines: &[Line]) -> Vec<Alias> {
    let mut names: Vec<String> = Vec::new();
    for Line { key, args } in lines {
        if key == "host" {
            for a in args {
                if !a.contains(['*', '?', '!']) && !names.contains(a) {
                    names.push(a.clone());
                }
            }
        }
    }
    names.into_iter().map(|alias| Alias { config: resolve_in(lines, &alias), alias }).collect()
}

#[tauri::command(async)]
pub fn deploy_ssh_hosts() -> Vec<Alias> {
    let mut lines = Vec::new();
    read(&config_path(), 0, &mut lines);
    aliases_in(&lines)
}

/// A ProxyJump entry, `[user@]host[:port]` (or `ssh://` with them), as its parts.
pub fn parse_jump(spec: &str) -> (Option<String>, String, Option<u16>) {
    let spec = spec.strip_prefix("ssh://").unwrap_or(spec);
    let (user, rest) = match spec.rsplit_once('@') {
        Some((u, r)) => (Some(u.to_string()), r),
        None => (None, spec),
    };
    // [::1]:22, or host:22, or host.
    if let Some(inner) = rest.strip_prefix('[') {
        if let Some((h, after)) = inner.split_once(']') {
            return (user, h.to_string(), after.strip_prefix(':').and_then(|p| p.parse().ok()));
        }
    }
    match rest.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => (user, h.to_string(), p.parse().ok()),
        _ => (user, rest.to_string(), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> Vec<Line> {
        text.lines().filter_map(split).map(|(key, args)| Line { key, args }).collect()
    }

    #[test]
    fn first_value_wins_and_patterns_match() {
        let l = lines(
            "Host staging\n  HostName 203.0.113.5\n  User forge\n  Port 2222\n  IdentityFile ~/.ssh/staging\n  ProxyJump bastion\n\
             Host *.example.com !secret.example.com\n  User web\n\
             Host bastion\n  HostName=bastion.example.com\n  User \"jump user\"\n\
             Match host *\n  User nobody\n\
             Host *\n  User fallback\n  IdentityFile ~/.ssh/id_%h\n  IdentitiesOnly yes\n",
        );
        let s = resolve_in(&l, "staging");
        assert_eq!(s.host_name.as_deref(), Some("203.0.113.5"));
        assert_eq!(s.user.as_deref(), Some("forge"));
        assert_eq!(s.port, Some(2222));
        let home = crate::slash(home());
        assert_eq!(s.identity_files, [format!("{home}/.ssh/staging"), format!("{home}/.ssh/id_203.0.113.5")]);
        assert!(s.identities_only);
        assert_eq!(s.proxy_jump, ["bastion"]);
        assert_eq!(resolve_in(&l, "www.EXAMPLE.com").user.as_deref(), Some("web"));
        assert_eq!(resolve_in(&l, "secret.example.com").user.as_deref(), Some("fallback"));
        assert_eq!(resolve_in(&l, "bastion").user.as_deref(), Some("jump user"));
        assert_eq!(resolve_in(&l, "other").host_name, None);
        let names: Vec<_> = aliases_in(&l).into_iter().map(|a| a.alias).collect();
        assert_eq!(names, ["staging", "bastion"]);
    }

    #[test]
    fn includes_read_in_place() {
        let dir = std::env::temp_dir().join(format!("tusk-sshconfig-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("conf.d")).unwrap();
        std::fs::write(dir.join("conf.d/a.conf"), "Host app\n  HostName app.internal\n").unwrap();
        std::fs::write(dir.join("conf.d/b.conf"), "Host db\n  HostName db.internal\n").unwrap();
        std::fs::write(dir.join("config"), format!("Include {}/conf.d/*.conf\nHost app\n  HostName ignored\n", crate::slash(&dir))).unwrap();
        let mut l = Vec::new();
        read(&dir.join("config"), 0, &mut l);
        assert_eq!(resolve_in(&l, "app").host_name.as_deref(), Some("app.internal"));
        assert_eq!(resolve_in(&l, "db").host_name.as_deref(), Some("db.internal"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn jump_specs() {
        assert_eq!(parse_jump("bastion"), (None, "bastion".into(), None));
        assert_eq!(parse_jump("me@bastion:2200"), (Some("me".into()), "bastion".into(), Some(2200)));
        assert_eq!(parse_jump("ssh://me@[::1]:22"), (Some("me".into()), "::1".into(), Some(22)));
        assert_eq!(resolve_in(&lines("Host a\n ProxyJump none\nHost *\n ProxyJump x"), "a").proxy_jump, Vec::<String>::new());
    }
}
