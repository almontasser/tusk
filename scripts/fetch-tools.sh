#!/bin/sh
# Downloads the pinned language tools that ship inside the app bundle.
# Each download is verified against its SHA-256 checksum. To upgrade a tool,
# change its URL and checksum here, then test the editor against it.
# Native binaries are fetched for the build's target: the one Tauri passes in
# TAURI_ENV_TARGET_TRIPLE, or this Mac's. For universal-apple-darwin (or with
# --universal), both architectures are fetched and joined with lipo.
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

case "${1:-${TAURI_ENV_TARGET_TRIPLE:-}}" in
  --universal | universal-apple-darwin) archs="aarch64 x86_64" ;;
  aarch64-apple-darwin) archs=aarch64 ;;
  x86_64-apple-darwin) archs=x86_64 ;;
  *) case "$(uname -m)" in
       arm64) archs=aarch64 ;;
       x86_64) archs=x86_64 ;;
       *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
     esac ;;
esac

# sha <tool> <arch>: the pinned checksum of a tool's download for one architecture.
sha() {
  case "$1-$2" in
    mago-aarch64) echo 99e75c1261f2287784cf2700c59f062da2f21a2ce54ea3068c879eb4384a96bd ;;
    mago-x86_64) echo b4ff313db87ef3fc8ed04e6920a193fc31a466a62d6dc53f9a7f3d26b4c9eaaa ;;
    typos-aarch64) echo c57edf504147dc74dab985f3b56170969e2ab00d4b1b1f1dcb5fb7eb0e3c9b89 ;;
    typos-x86_64) echo e9069658eedfc575033451bf146980b05fe911e357f8013672d1a375f49bc0a1 ;;
    llama-aarch64) echo 70f06308f7993891085ee620dca5eb796a46ba4ec70a0410da7ee3933b0951c5 ;;
    llama-x86_64) echo 3563ba2fa6fe7a98cdabc33eced4d1986d5ae63aa11fc1d997b635990f60feda ;;
  esac
}
llama_arch() { [ "$1" = aarch64 ] && echo arm64 || echo x64; }

# join <output> <file for each arch…>: one file as is, or several joined into a universal binary.
join() {
  out="$1"
  shift
  if [ $# -eq 1 ]; then cp "$1" "$out"; else lipo -create "$@" -output "$out"; fi
}

# Each architecture's native tools are unpacked under the cache, then joined into the bundle.
for arch in $archs; do
  fetch "mago-1.50.0-$arch.tar.gz" \
    "https://github.com/carthage-software/mago/releases/download/1.50.0/mago-1.50.0-$arch-apple-darwin.tar.gz" \
    "$(sha mago "$arch")"
  # Spell checking: typos-lsp, a language server for the typos checker, which knows code's naming styles.
  fetch "typos-lsp-0.1.56-$arch.tar.gz" \
    "https://github.com/tekumara/typos-lsp/releases/download/v0.1.56/typos-lsp-v0.1.56-$arch-apple-darwin.tar.gz" \
    "$(sha typos "$arch")"
  mkdir -p "$cache/$arch"
  tar -xzf "$cache/mago-1.50.0-$arch.tar.gz" -C "$cache/$arch" --strip-components 1 "mago-1.50.0-$arch-apple-darwin/mago"
  tar -xzf "$cache/typos-lsp-0.1.56-$arch.tar.gz" -C "$cache/$arch" typos-lsp
done
join "$dest/mago" $(for a in $archs; do echo "$cache/$a/mago"; done)
join "$dest/typos-lsp" $(for a in $archs; do echo "$cache/$a/typos-lsp"; done)

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
# npm installs a native package for this Mac only, so the Astro compiler's for another architecture comes from
# the lockfile's URL, checked against its integrity hash. One the target doesn't need, left by an earlier
# universal build, is removed.
for arch in aarch64 x86_64; do
  case " $archs " in *" $arch "*) ;; *) rm -rf "$node_dest/node_modules/@astrojs/compiler-binding-darwin-$([ "$arch" = aarch64 ] && echo arm64 || echo x64)"; continue ;; esac
  pkg="@astrojs/compiler-binding-darwin-$([ "$arch" = aarch64 ] && echo arm64 || echo x64)"
  [ -d "$node_dest/node_modules/$pkg" ] && continue
  url=$(node -p "require('$node_dest/package-lock.json').packages['node_modules/$pkg'].resolved")
  integrity=$(node -p "require('$node_dest/package-lock.json').packages['node_modules/$pkg'].integrity")
  curl -fsSL -o "$cache/binding.tgz" "$url"
  [ "sha512-$(openssl dgst -sha512 -binary "$cache/binding.tgz" | base64)" = "$integrity" ] || { echo "Integrity mismatch for $pkg" >&2; exit 1; }
  mkdir -p "$node_dest/node_modules/$pkg"
  tar -xzf "$cache/binding.tgz" -C "$node_dest/node_modules/$pkg" --strip-components 1
  rm "$cache/binding.tgz"
done

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

# llama-server from llama.cpp, for AI code completion with a model the user downloads.
# Only the server and the libraries it loads (under their .0 names, through @loader_path) are kept. For a
# universal build, each file is joined; a library only one architecture has is kept for that one.
llama_marker="$dest/llama/.version-b11165-$(echo $archs | tr ' ' '-')"
if [ ! -f "$llama_marker" ]; then
  rm -rf "$dest/llama"
  mkdir -p "$dest/llama"
  for arch in $archs; do
    la=$(llama_arch "$arch")
    fetch "llama-b11165-$la.tar.gz" \
      "https://github.com/ggml-org/llama.cpp/releases/download/b11165/llama-b11165-bin-macos-$la.tar.gz" \
      "$(sha llama "$arch")"
    rm -rf "$cache/llama-$arch"
    mkdir -p "$cache/llama-$arch"
    tar -xzf "$cache/llama-b11165-$la.tar.gz" -C "$cache/llama-$arch" --strip-components 1
  done
  first=$(echo $archs | cut -d' ' -f1)
  cp "$cache/llama-$first/LICENSE" "$dest/llama/"
  # cp and lipo follow the release's symlinks, such as libggml.0.dylib to the versioned file.
  for name in llama-server libllama-server-impl.dylib $(for a in $archs; do (cd "$cache/llama-$a" && ls lib*[a-z].0.dylib); done | sort -u); do
    files=""
    for a in $archs; do [ -e "$cache/llama-$a/$name" ] && files="$files $cache/llama-$a/$name"; done
    join "$dest/llama/$name" $files
  done
  for a in $archs; do rm -rf "$cache/llama-$a"; done
  touch "$llama_marker"
fi
