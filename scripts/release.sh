#!/bin/sh
# Builds a universal release and publishes it as a GitHub release that installed copies update from.
# Usage: scripts/release.sh 0.2.0
# Needs the updater's private key at ~/.tauri/tusk.key (or TAURI_SIGNING_PRIVATE_KEY_PATH) and gh signed in.
set -eu

version="${1:?Usage: scripts/release.sh <version>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
[ -z "$(git status --porcelain)" ] || { echo "Commit your changes first." >&2; exit 1; }

node -e '
  const fs = require("fs"), p = "src-tauri/tauri.conf.json", c = JSON.parse(fs.readFileSync(p));
  c.version = process.argv[1];
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
' "$version"

export TAURI_SIGNING_PRIVATE_KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/tusk.key}"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
pnpm tauri build --target universal-apple-darwin

bundle=src-tauri/target/universal-apple-darwin/release/bundle
dmg="$bundle/dmg/Tusk_${version}_universal.dmg"
archive="$bundle/macos/Tusk.app.tar.gz"
url="https://github.com/almontasser/tusk/releases/download/v$version/Tusk.app.tar.gz"

# The universal archive serves both chips.
node -e '
  const [version, url, sig] = process.argv.slice(1);
  const entry = { signature: sig, url };
  console.log(JSON.stringify({ version, pub_date: new Date().toISOString(),
    platforms: { "darwin-aarch64": entry, "darwin-x86_64": entry } }, null, 2));
' "$version" "$url" "$(cat "$archive.sig")" > "$bundle/latest.json"

git commit -qam "Release $version"
git tag "v$version"
git push -q origin HEAD "v$version"
gh release create "v$version" "$dmg" "$archive" "$bundle/latest.json" --title "Tusk $version" --generate-notes
