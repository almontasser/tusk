#!/bin/sh
# Builds Tusk for macOS (universal), Windows (x64), and Linux (x64), and publishes them as a GitHub release that
# installed copies update from. The files get names without the version, so the website links to
# releases/latest/download/<name>.
# Usage: scripts/release.sh 0.2.0
# Needs bwnote in ~/.zshrc with the tusk-signing-key note in Bitwarden, gh signed in, and for Windows, cargo-xwin
# (cargo install cargo-xwin), NSIS (brew install nsis), LLVM (brew install llvm), and the Windows Rust target
# (rustup target add x86_64-pc-windows-msvc). Linux builds in Docker (scripts/linux/Dockerfile), emulating x64 on an
# Apple silicon Mac, which makes it the slow one.
set -eu

version="${1:?Usage: scripts/release.sh <version>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
[ -z "$(git status --porcelain)" ] || { echo "Commit your changes first." >&2; exit 1; }

# The updater's private key lives in Bitwarden, never on disk. bwnote (a zsh function in ~/.zshrc) unlocks
# with Touch ID; its unlock message can come first, so only the last line is the key.
TAURI_SIGNING_PRIVATE_KEY="$(zsh -ic 'bwnote tusk-signing-key' 2>/dev/null | tail -n 1)"
echo "$TAURI_SIGNING_PRIVATE_KEY" | grep -Eq '^[A-Za-z0-9+/]{100,}=*$' || { echo "Couldn't read tusk-signing-key with bwnote." >&2; exit 1; }
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

node -e '
  const fs = require("fs"), p = "src-tauri/tauri.conf.json", c = JSON.parse(fs.readFileSync(p));
  c.version = process.argv[1];
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
' "$version"

pnpm tauri build --target universal-apple-darwin
# Windows is cross-built: cargo-xwin links against Microsoft's SDK, and NSIS makes the installer, which is also the
# update. It isn't code-signed, so SmartScreen warns on its first run.
pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
# Linux: an AppImage, which also updates itself, and a .deb. The container keeps its own node_modules, Cargo cache,
# and target folder in volumes, since this Mac's are built for macOS.
docker build --platform linux/amd64 -t tusk-release-linux scripts/linux
linux=src-tauri/target/linux-release
rm -rf "$linux" && mkdir -p "$linux"
docker run --rm --platform linux/amd64 -v "$root:/src" -v tusk-release-node:/src/node_modules -v tusk-release-pnpm:/root/.pnpm-store \
  -v tusk-release-cargo:/root/.cargo/registry -v tusk-release-target:/src/src-tauri/target -v "$root/$linux:/out" \
  -e TAURI_SIGNING_PRIVATE_KEY -e TAURI_SIGNING_PRIVATE_KEY_PASSWORD tusk-release-linux \
  sh -c 'pnpm install --frozen-lockfile --store-dir /root/.pnpm-store && pnpm tauri build --bundles appimage,deb && cp src-tauri/target/release/bundle/appimage/*.AppImage* src-tauri/target/release/bundle/deb/*.deb /out/'

# Every file under the name the website and latest.json give it.
out=src-tauri/target/release-files
rm -rf "$out" && mkdir -p "$out"
mac=src-tauri/target/universal-apple-darwin/release/bundle
win=src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis
cp "$mac/dmg/Tusk_${version}_universal.dmg" "$out/Tusk-universal.dmg"
cp "$mac/macos/Tusk.app.tar.gz" "$out/Tusk.app.tar.gz"
cp "$win/Tusk_${version}_x64-setup.exe" "$out/Tusk-x64-setup.exe"
cp "$linux/Tusk_${version}_amd64.AppImage" "$out/Tusk-x86_64.AppImage"
cp "$linux/Tusk_${version}_amd64.deb" "$out/Tusk-amd64.deb"

# The universal archive serves both Mac chips.
node -e '
  const [version, download, macSig, winSig, linuxSig] = process.argv.slice(1);
  const entry = (file, signature) => ({ signature, url: `${download}/${file}` });
  const mac = entry("Tusk.app.tar.gz", macSig);
  console.log(JSON.stringify({ version, pub_date: new Date().toISOString(), platforms: {
    "darwin-aarch64": mac, "darwin-x86_64": mac,
    "windows-x86_64": entry("Tusk-x64-setup.exe", winSig),
    "linux-x86_64": entry("Tusk-x86_64.AppImage", linuxSig),
  } }, null, 2));
' "$version" "https://github.com/almontasser/tusk/releases/download/v$version" \
  "$(cat "$mac/macos/Tusk.app.tar.gz.sig")" "$(cat "$win/Tusk_${version}_x64-setup.exe.sig")" "$(cat "$linux/Tusk_${version}_amd64.AppImage.sig")" > "$out/latest.json"

git commit -qam "Release $version"
git tag "v$version"
git push -q origin HEAD "v$version"
gh release create "v$version" "$out"/* --title "Tusk $version" --generate-notes
