#!/bin/sh
# Downloads the pinned language tools that ship inside the app bundle.
# Each download is verified against its SHA-256 checksum. To upgrade a tool,
# change its URL and checksum here, then test the editor against it.
# Native binaries are fetched for the architecture of the build machine.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/src-tauri/resources/tools"
cache="$root/src-tauri/target/tool-cache"
mkdir -p "$dest" "$cache"

# fetch <cache file name> <url> <sha256>: downloads into the cache once, verified.
fetch() {
  if [ -f "$cache/$1" ] && echo "$3  $cache/$1" | shasum -a 256 -c - >/dev/null 2>&1; then
    return
  fi
  echo "Downloading $1"
  curl -fsSL -o "$cache/$1.tmp" "$2"
  echo "$3  $cache/$1.tmp" | shasum -a 256 -c - >/dev/null || { echo "Checksum mismatch for $1" >&2; rm "$cache/$1.tmp"; exit 1; }
  mv "$cache/$1.tmp" "$cache/$1"
}

fetch phpactor-2026.06.23.0.phar \
  https://github.com/phpactor/phpactor/releases/download/2026.06.23.0/phpactor.phar \
  25645647d9aa2dc69536fb4f75c976e33ef1a7b5533534a8456736e5e6fd5079
cp "$cache/phpactor-2026.06.23.0.phar" "$dest/phpactor.phar"

fetch laravel-lsp-0.0.32.phar \
  https://github.com/laravel/lsp/releases/download/v0.0.32/laravel-lsp \
  86d43f017b2247f1da428891a84a7db66d1f4443a0858301fe3a0d38482c5a51
cp "$cache/laravel-lsp-0.0.32.phar" "$dest/laravel-lsp.phar"

# Composer, for the Composer tool window. Checksum from getcomposer.org.
fetch composer-2.10.2.phar \
  https://getcomposer.org/download/2.10.2/composer.phar \
  5ee7125f8a30a34d246cefdc0bc85b8a783b28f2aec968994118512350d28027
cp "$cache/composer-2.10.2.phar" "$dest/composer.phar"

case "$(uname -m)" in
  arm64) arch=aarch64; mago_sha=99e75c1261f2287784cf2700c59f062da2f21a2ce54ea3068c879eb4384a96bd ;;
  x86_64) arch=x86_64; mago_sha=b4ff313db87ef3fc8ed04e6920a193fc31a466a62d6dc53f9a7f3d26b4c9eaaa ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
fetch "mago-1.50.0-$arch.tar.gz" \
  "https://github.com/carthage-software/mago/releases/download/1.50.0/mago-1.50.0-$arch-apple-darwin.tar.gz" \
  "$mago_sha"
tar -xzf "$cache/mago-1.50.0-$arch.tar.gz" -C "$dest" --strip-components 1 "mago-1.50.0-$arch-apple-darwin/mago"

# Node-based language servers, pinned by node-tools/package-lock.json. npm ci checks every
# package against the lockfile's integrity hashes. Install scripts are skipped, since the
# servers are plain JavaScript. Reinstall only when the lockfile changes.
node_dest="$dest/node"
if ! cmp -s "$root/node-tools/package-lock.json" "$node_dest/package-lock.json"; then
  echo "Installing Node language servers"
  rm -rf "$node_dest"
  mkdir -p "$node_dest"
  cp "$root/node-tools/package.json" "$root/node-tools/package-lock.json" "$node_dest/"
  (cd "$node_dest" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
fi

# The Xdebug adapter from VS Code's PHP Debug extension. It speaks the Debug Adapter
# Protocol and ships as a .vsix (a zip) with its dependencies included.
fetch php-debug-1.40.2.vsix \
  https://github.com/xdebug/vscode-php-debug/releases/download/v1.40.2/php-debug-1.40.2.vsix \
  17631993fe800083a2fc89a6782c8bf58a79603ad201ddff60d9b59ba2345d5f
if [ ! -f "$dest/php-debug/.version-1.40.2" ]; then
  rm -rf "$dest/php-debug" "$cache/php-debug"
  unzip -q "$cache/php-debug-1.40.2.vsix" 'extension/*' -d "$cache/php-debug"
  mv "$cache/php-debug/extension" "$dest/php-debug"
  rm -rf "$cache/php-debug"
  touch "$dest/php-debug/.version-1.40.2"
fi
