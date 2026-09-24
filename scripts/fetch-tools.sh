#!/bin/sh
# Downloads the pinned language tools that ship inside the app bundle.
# Each download is verified against its SHA-256 checksum. To upgrade a tool,
# change its URL and checksum here, then test the editor against it.
set -eu

dest="$(dirname "$0")/../src-tauri/resources/tools"
mkdir -p "$dest"

fetch() { # name url sha256
  if [ -f "$dest/$1" ] && echo "$3  $dest/$1" | shasum -a 256 -c - >/dev/null 2>&1; then
    return
  fi
  echo "Downloading $1"
  curl -fsSL -o "$dest/$1.tmp" "$2"
  echo "$3  $dest/$1.tmp" | shasum -a 256 -c - >/dev/null || { echo "Checksum mismatch for $1" >&2; rm "$dest/$1.tmp"; exit 1; }
  mv "$dest/$1.tmp" "$dest/$1"
}

fetch phpactor.phar \
  https://github.com/phpactor/phpactor/releases/download/2026.06.23.0/phpactor.phar \
  25645647d9aa2dc69536fb4f75c976e33ef1a7b5533534a8456736e5e6fd5079
