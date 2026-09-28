use crate::lsp::{tool, tools_dir};
use std::io::Write;
use std::process::{Command, Stdio};
use tauri::AppHandle;

/// Path of a tool's file, such as `mago/mago`, for tools the frontend runs or passes to a language server.
#[tauri::command(async)]
pub fn tool_path(app: AppHandle, name: String) -> Result<String, String> {
    Ok(tool(&app, &name)?.to_string_lossy().into())
}

#[tauri::command(async)]
pub fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// Whether each path exists, in one call for a batch of file-system events.
#[tauri::command(async)]
pub fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| std::path::Path::new(p).exists()).collect()
}

/// Runs a program in `cwd` and returns its standard output, for short queries such as
/// `php artisan list --format=json`. `input`, if given, is written to standard input.
/// Fails with standard error if the program fails, unless `any_status`: checkers such as Mago
/// exit with an error when they find problems, and still print their report.
#[tauri::command]
pub async fn run_capture(cwd: String, program: String, args: Vec<String>, input: Option<String>, any_status: Option<bool>) -> Result<String, String> {
    crate::blocking(move || capture(cwd, program, args, input, any_status.unwrap_or(false))).await
}

fn capture(cwd: String, program: String, args: Vec<String>, input: Option<String>, any_status: bool) -> Result<String, String> {
    crate::toolpaths::check(&[&[program.clone()], &args[..]].concat())?;
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .env("PATH", crate::toolpaths::path_env())
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(input) = input {
        let mut stdin = child.stdin.take().unwrap();
        // Write on another thread, so a large input can't deadlock against a full stdout pipe.
        std::thread::spawn(move || stdin.write_all(input.as_bytes()));
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() && !(any_status && out.status.code().is_some()) {
        return Err(String::from_utf8_lossy(&out.stderr).into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into())
}

// Language tools are downloaded, not bundled, so the app stays small and tools update without an app
// release. scripts/publish-tools.ts packs each tool (per chip when it's native) as a `tools` GitHub release
// asset, listed with its checksum in tools.json, which is signed with the updater's key. Each tool unpacks
// into its own folder under `tools_dir`, with the package's ID in `.tusk-id`.

const MANIFEST: &str = "https://github.com/almontasser/tusk/releases/download/tools/tools.json";

#[derive(serde::Deserialize)]
struct Manifest {
    packages: Vec<Package>,
}

#[derive(serde::Deserialize)]
struct Package {
    name: String,
    /// `any`, `aarch64`, or `x86_64`.
    arch: String,
    /// A hash of the tool's files, which changes when the tool does.
    id: String,
    url: String,
    sha256: String,
    size: u64,
}

impl Manifest {
    /// The packages this Mac's chip needs.
    fn here(&self) -> impl Iterator<Item = &Package> {
        self.packages.iter().filter(|p| p.arch == "any" || p.arch == std::env::consts::ARCH)
    }
}

/// One install at a time, so a reload during a background update waits instead of swapping in a half-written folder.
static INSTALLING: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());
/// Staged updates are swapped in once per run, before any tool starts.
static SWAPPED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Makes sure the language tools are installed before the servers start. The first launch downloads them,
/// with progress as `tools-progress` events. After that it returns at once and checks for newer tools in the
/// background (`check_tools`); those are staged beside the live ones and swapped in at the next launch, so a running server
/// never sees its files change.
#[tauri::command]
pub async fn tools_ensure(app: AppHandle) -> Result<(), String> {
    let dir = tools_dir(&app)?;
    let lock = INSTALLING.lock().await;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if !SWAPPED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
            if let Some(name) = entry.file_name().to_str().and_then(|n| n.strip_prefix(".next-")) {
                swap_in(&dir, name)?;
            }
        }
    }
    let cached = std::fs::read(dir.join("tools.json")).ok().and_then(|b| serde_json::from_slice::<Manifest>(&b).ok());
    if !cached.is_some_and(|m| m.here().all(|p| dir.join(&p.name).is_dir())) {
        let manifest = fetch_manifest(&app, &dir).await.map_err(|e| format!("Couldn't download the language tools: {e}"))?;
        let failed = install(&app, &dir, &manifest, false).await.map_err(|e| format!("Couldn't install the language tools: {e}"))?;
        if !failed.is_empty() {
            // No tool at all, as on a first launch offline: the servers can't start. Otherwise those that need a missing
            // tool fail on their own, and the next launch tries it again, since its folder is missing.
            if !manifest.here().any(|p| dir.join(&p.name).is_dir()) {
                return Err(format!("Couldn't install the language tools: {}", failed.join("; ")));
            }
            use tauri::Emitter;
            let _ = app.emit("tools-failed", format!("Some language tools didn't install, and will be tried again at the next launch: {}", failed.join("; ")));
        }
        return Ok(());
    }
    drop(lock);
    if crate::toolpaths::auto_checks(&app) {
        tauri::async_runtime::spawn(check_tools(app));
    }
    Ok(())
}

/// Downloads newer tools in the background, staged for the next launch. Runs at launch and every six hours.
pub async fn check_tools(app: AppHandle) {
    let _lock = INSTALLING.lock().await;
    let Ok(dir) = tools_dir(&app) else { return };
    if let Ok(manifest) = fetch_manifest(&app, &dir).await {
        let _ = install(&app, &dir, &manifest, true).await;
    }
}

fn client() -> Result<reqwest::Client, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder().user_agent("Tusk").build().map_err(|e| e.to_string())
}

/// Downloads tools.json, checks its signature against the updater's public key, and caches it.
async fn fetch_manifest(app: &AppHandle, dir: &std::path::Path) -> Result<Manifest, String> {
    use base64::Engine;
    let client = client()?;
    let get = |url: String| {
        let request = client.get(url);
        async move { request.send().await?.error_for_status()?.bytes().await }
    };
    let json = get(MANIFEST.into()).await.map_err(|e| e.to_string())?;
    let sig = get(format!("{MANIFEST}.sig")).await.map_err(|e| e.to_string())?;
    let text = |b64: &[u8]| {
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim_ascii()).map_err(|e| e.to_string())?;
        String::from_utf8(bytes).map_err(|e| e.to_string())
    };
    let key = app.config().plugins.0.get("updater").and_then(|u| u["pubkey"].as_str()).ok_or("No public key")?;
    let key = minisign_verify::PublicKey::decode(&text(key.as_bytes())?).map_err(|e| e.to_string())?;
    let sig = minisign_verify::Signature::decode(&text(&sig)?).map_err(|e| e.to_string())?;
    key.verify(&json, &sig, true).map_err(|_| "tools.json isn't signed with Tusk's key".to_string())?;
    let manifest = serde_json::from_slice(&json).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("tools.json"), &json).map_err(|e| e.to_string())?;
    Ok(manifest)
}

/// Downloads and unpacks every package that isn't installed at its current ID. With `later`, each is left
/// staged as `.next-<name>`, for the next launch; otherwise it replaces the live folder now. A package that fails,
/// such as one missing from the release, doesn't stop the others. Returns each failure.
async fn install(app: &AppHandle, dir: &std::path::Path, manifest: &Manifest, later: bool) -> Result<Vec<String>, String> {
    use sha2::Digest;
    use tauri::Emitter;
    let id = |folder: String| std::fs::read_to_string(dir.join(folder).join(".tusk-id")).unwrap_or_default();
    let needed: Vec<_> = manifest
        .here()
        .filter(|p| id(p.name.clone()) != p.id && !(later && id(format!(".next-{}", p.name)) == p.id))
        .collect();
    let total = needed.iter().map(|p| p.size).sum::<u64>().max(1);
    let verb = if later { "Updating" } else { "Downloading" };
    let (client, mut done, mut shown) = (client()?, 0, u64::MAX);
    let mut failed = vec![];
    for p in needed {
        let result = async {
            let archive = dir.join(format!(".download-{}", p.name));
            let mut file = std::fs::File::create(&archive).map_err(|e| e.to_string())?;
            let mut hash = sha2::Sha256::new();
            let mut response = client.get(&p.url).send().await.and_then(|r| r.error_for_status()).map_err(|e| e.to_string())?;
            while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
                hash.update(&chunk);
                file.write_all(&chunk).map_err(|e| e.to_string())?;
                done += chunk.len() as u64;
                if done * 100 / total != shown {
                    shown = done * 100 / total;
                    let _ = app.emit("tools-progress", format!("{verb} language tools: {shown}%"));
                }
            }
            drop(file);
            if format!("{:x}", hash.finalize()) != p.sha256 {
                let _ = std::fs::remove_file(&archive);
                return Err(format!("{} doesn't match its checksum", p.name));
            }
            let (dir, name, id) = (dir.to_path_buf(), p.name.clone(), p.id.clone());
            crate::blocking(move || {
                let part = dir.join(format!(".part-{name}"));
                let _ = std::fs::remove_dir_all(&part);
                let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(std::fs::File::open(&archive).map_err(|e| e.to_string())?));
                tar.set_preserve_permissions(true);
                tar.unpack(&part).map_err(|e| format!("{name}: {e}"))?;
                std::fs::write(part.join(".tusk-id"), id).map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(&archive);
                let next = dir.join(format!(".next-{name}"));
                let _ = std::fs::remove_dir_all(&next);
                std::fs::rename(&part, &next).map_err(|e| e.to_string())?;
                if later { Ok(()) } else { swap_in(&dir, &name) }
            })
            .await
        }
        .await;
        if let Err(e) = result {
            let _ = std::fs::remove_file(dir.join(format!(".download-{}", p.name)));
            failed.push(format!("{}: {e}", p.name));
        }
    }
    let _ = app.emit("tools-progress", "");
    Ok(failed)
}

/// Replaces a tool's live folder with its staged `.next-<name>` folder.
fn swap_in(dir: &std::path::Path, name: &str) -> Result<(), String> {
    let live = dir.join(name);
    if live.exists() {
        std::fs::remove_dir_all(&live).map_err(|e| e.to_string())?;
    }
    std::fs::rename(dir.join(format!(".next-{name}")), live).map_err(|e| e.to_string())
}
