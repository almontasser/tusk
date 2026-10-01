#!/bin/sh
# Downloads the pinned language tools into TOOLS_DEST (default src-tauri/target/tools), one folder per tool,
# the layout the app installs them in. scripts/publish-tools.ts packs and publishes them for the app to
# download. Each download is verified against its SHA-256 checksum. To upgrade a tool, change its URL and
# checksum here, then publish.
# Native binaries are fetched for the target in the first argument (or TAURI_ENV_TARGET_TRIPLE), or this
# computer's: aarch64 and x86_64 for macOS and Linux (gnu), x86_64 for Windows (msvc). For universal-apple-darwin
# (or --universal), both architectures are joined with lipo.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
dest="${TOOLS_DEST:-$root/src-tauri/target/tools}"
cache="$root/src-tauri/target/tool-cache"
mkdir -p "$dest" && dest="$(cd "$dest" && pwd)"
mkdir -p "$dest/composer" "$dest/mago" "$dest/typos-lsp" "$cache"

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

# Composer, for the Composer tool window. Checksum from getcomposer.org.
fetch composer-2.10.2.phar \
  https://getcomposer.org/download/2.10.2/composer.phar \
  5ee7125f8a30a34d246cefdc0bc85b8a783b28f2aec968994118512350d28027
cp "$cache/composer-2.10.2.phar" "$dest/composer/composer.phar"

target="${1:-${TAURI_ENV_TARGET_TRIPLE:-}}"
case "$target" in
  --universal | universal-apple-darwin) os=macos archs="aarch64 x86_64" ;;
  aarch64-apple-darwin | x86_64-apple-darwin) os=macos archs="${target%%-*}" ;;
  aarch64-unknown-linux-gnu | x86_64-unknown-linux-gnu) os=linux archs="${target%%-*}" ;;
  x86_64-pc-windows-msvc) os=windows archs=x86_64 ;;
  "") case "$(uname -s)" in Darwin) os=macos ;; Linux) os=linux ;; *) os=windows ;; esac
      case "$(uname -m)" in
       arm64 | aarch64) archs=aarch64 ;;
       x86_64) archs=x86_64 ;;
       *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
     esac ;;
  *) echo "Unsupported target: $target" >&2; exit 1 ;;
esac
# Windows programs end in .exe.
exe=""; [ "$os" = windows ] && exe=.exe

# sha <tool> <os>-<arch>: the pinned checksum of a tool's download for one system and architecture.
sha() {
  case "$1-$2" in
    mago-macos-aarch64) echo 99e75c1261f2287784cf2700c59f062da2f21a2ce54ea3068c879eb4384a96bd ;;
    mago-macos-x86_64) echo b4ff313db87ef3fc8ed04e6920a193fc31a466a62d6dc53f9a7f3d26b4c9eaaa ;;
    mago-linux-aarch64) echo 72b549cb66c71a158b3182a36efdb2c935a0fd79d9c555780a0b739cb857b919 ;;
    mago-linux-x86_64) echo 5eb5d8aa26d378eaf6574ac52a84a9fe69ff8909b441498a96af29b66d7ba642 ;;
    mago-windows-x86_64) echo dbff448ef9ef52a8abef6b1f2f9e58a376f62846af9074ac6eed0ea19846c769 ;;
    typos-macos-aarch64) echo c57edf504147dc74dab985f3b56170969e2ab00d4b1b1f1dcb5fb7eb0e3c9b89 ;;
    typos-macos-x86_64) echo e9069658eedfc575033451bf146980b05fe911e357f8013672d1a375f49bc0a1 ;;
    typos-linux-aarch64) echo e4ed859acefdb76d5b0da32f4cd4669052c5b3a9fffa1d995d21eb89da61be60 ;;
    typos-linux-x86_64) echo 48e841ddd9a4ac6997a49aee99629a72c1f427bfe614fe4b52f719caaa2718b4 ;;
    typos-windows-x86_64) echo 506fbaf50117d205f945924b96df48754ead75e1088397295b8c5204a22777f9 ;;
    llama-macos-aarch64) echo 70f06308f7993891085ee620dca5eb796a46ba4ec70a0410da7ee3933b0951c5 ;;
    llama-macos-x86_64) echo 3563ba2fa6fe7a98cdabc33eced4d1986d5ae63aa11fc1d997b635990f60feda ;;
    llama-linux-aarch64) echo 4abb9304c44d9d9eea927454a80e40f52ceb369616e4a63c668beb59257a79c9 ;;
    llama-linux-x86_64) echo 98a707653de65d8ce533780a8fe44d9ca26822f1853ac98017dba91375b797d0 ;;
    llama-windows-x86_64) echo 89aafbbabc8802f6853dd23d984d818f22dc243e77c1b31ff34e025a2c5737eb ;;
  esac
}
llama_arch() { [ "$1" = aarch64 ] && echo arm64 || echo x64; }
# The Rust target triple that mago and typos-lsp name their downloads by.
triple() {
  case "$os" in
    macos) echo "$1-apple-darwin" ;;
    linux) echo "$1-unknown-linux-gnu" ;;
    windows) echo "$1-pc-windows-msvc" ;;
  esac
}
# unpack <archive> <folder>: a .tar.gz or a .zip.
unpack() {
  mkdir -p "$2"
  case "$1" in *.zip) unzip -qo "$1" -d "$2" ;; *) tar -xzf "$1" -C "$2" ;; esac
}

# join <output> <file for each arch…>: one file as is, or several joined into a universal binary.
join() {
  out="$1"
  shift
  if [ $# -eq 1 ]; then cp "$1" "$out"; else lipo -create "$@" -output "$out"; fi
}

# Each architecture's native tools are unpacked under the cache, then joined into the bundle.
for arch in $archs; do
  t=$(triple "$arch")
  ext=tar.gz; [ "$os" = windows ] && ext=zip
  # Mac downloads keep their first cache names, from before other systems.
  key="$arch"; [ "$os" = macos ] || key="$t"
  fetch "mago-1.50.0-$key.$ext" \
    "https://github.com/carthage-software/mago/releases/download/1.50.0/mago-1.50.0-$t.$ext" \
    "$(sha mago "$os-$arch")"
  # Spell checking: typos-lsp, a language server for the typos checker, which knows code's naming styles.
  fetch "typos-lsp-0.1.56-$key.$ext" \
    "https://github.com/tekumara/typos-lsp/releases/download/v0.1.56/typos-lsp-v0.1.56-$t.$ext" \
    "$(sha typos "$os-$arch")"
  rm -rf "$cache/unpack" && mkdir -p "$cache/$key"
  unpack "$cache/mago-1.50.0-$key.$ext" "$cache/unpack"
  unpack "$cache/typos-lsp-0.1.56-$key.$ext" "$cache/unpack"
  cp "$cache/unpack/mago-1.50.0-$t/mago$exe" "$(find "$cache/unpack" -name "typos-lsp$exe" -type f | head -1)" "$cache/$key/"
  rm -rf "$cache/unpack"
done
keys=$(for a in $archs; do if [ "$os" = macos ]; then echo "$a"; else triple "$a"; fi; done)
# A tool built for another system, left by an earlier run for it, is replaced.
rm -f "$dest/mago/mago" "$dest/mago/mago.exe" "$dest/typos-lsp/typos-lsp" "$dest/typos-lsp/typos-lsp.exe"
join "$dest/mago/mago$exe" $(for k in $keys; do echo "$cache/$k/mago$exe"; done)
join "$dest/typos-lsp/typos-lsp$exe" $(for k in $keys; do echo "$cache/$k/typos-lsp$exe"; done)

# Node-based language servers, pinned by node-tools/package-lock.json. npm ci checks every
# package against the lockfile's integrity hashes. Install scripts are skipped, since the
# servers are plain JavaScript. Reinstall only when the lockfile changes.
node_dest="$dest/node"
if ! cmp -s "$root/node-tools/package-lock.json" "$node_dest/package-lock.json" || [ "$(cat "$node_dest/.target" 2>/dev/null)" != "$os $archs" ]; then
  echo "Installing Node language servers"
  rm -rf "$node_dest"
  mkdir -p "$node_dest"
  cp "$root/node-tools/package.json" "$root/node-tools/package-lock.json" "$node_dest/"
  (cd "$node_dest" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
fi
# npm installs the native packages for this computer only, so the Astro compiler's for the target comes from the
# lockfile's URL, checked against its integrity hash. Those the target doesn't need, such as this Mac's, are removed,
# with fsevents, which only macOS has.
binding() {
  case "$os-$1" in
    macos-aarch64) echo darwin-arm64 ;;
    macos-x86_64) echo darwin-x64 ;;
    linux-aarch64) echo linux-arm64-gnu ;;
    linux-x86_64) echo linux-x64-gnu ;;
    windows-x86_64) echo win32-x64-msvc ;;
  esac
}
wanted=$(for a in $archs; do echo "@astrojs/compiler-binding-$(binding "$a")"; done)
for dir in "$node_dest"/node_modules/@astrojs/compiler-binding-*; do
  pkg="@astrojs/${dir##*/}"
  echo "$wanted" | grep -qx "$pkg" || rm -rf "$dir"
done
[ "$os" = macos ] || rm -rf "$node_dest/node_modules/fsevents"
for pkg in $wanted; do
  [ -d "$node_dest/node_modules/$pkg" ] && continue
  url=$(node -p "require('$node_dest/package-lock.json').packages['node_modules/$pkg'].resolved")
  integrity=$(node -p "require('$node_dest/package-lock.json').packages['node_modules/$pkg'].integrity")
  curl -fsSL -o "$cache/binding.tgz" "$url"
  [ "sha512-$(openssl dgst -sha512 -binary "$cache/binding.tgz" | base64)" = "$integrity" ] || { echo "Integrity mismatch for $pkg" >&2; exit 1; }
  mkdir -p "$node_dest/node_modules/$pkg"
  tar -xzf "$cache/binding.tgz" -C "$node_dest/node_modules/$pkg" --strip-components 1
  rm "$cache/binding.tgz"
done
# Windows can't unpack npm's links to the servers' scripts without Developer Mode, and the app runs the scripts by path.
if [ "$os" = windows ]; then rm -rf "$node_dest/node_modules/.bin"; find "$node_dest" -type l -delete; fi
# npm ci again for another system's target puts back what this one removed.
echo "$os $archs" > "$node_dest/.target"

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

# llama-server from llama.cpp, for AI code completion with a model the user downloads. On a Mac only the server and
# the libraries it loads (under their .0 names, through @loader_path) are kept; for a universal build, each file is
# joined, and a library only one architecture has is kept for that one. Linux and Windows get the Vulkan build, which
# uses the GPU when its drivers have Vulkan and the CPU otherwise, with every library beside the server.
llama_marker="$dest/llama/.version-b11165-$os-$(echo $archs | tr ' ' '-')"
if [ ! -f "$llama_marker" ]; then
  rm -rf "$dest/llama"
  mkdir -p "$dest/llama"
  for arch in $archs; do
    la=$(llama_arch "$arch")
    case "$os" in
      macos) name="llama-b11165-$la.tar.gz" asset="llama-b11165-bin-macos-$la.tar.gz" ;;
      linux) name="llama-b11165-ubuntu-vulkan-$la.tar.gz" asset="llama-b11165-bin-ubuntu-vulkan-$la.tar.gz" ;;
      windows) name="llama-b11165-win-vulkan-$la.zip" asset="llama-b11165-bin-win-vulkan-$la.zip" ;;
    esac
    fetch "$name" "https://github.com/ggml-org/llama.cpp/releases/download/b11165/$asset" "$(sha llama "$os-$arch")"
    rm -rf "$cache/llama-$arch"
    mkdir -p "$cache/llama-$arch"
    case "$name" in
      *.zip) unzip -qo "$cache/$name" -d "$cache/llama-$arch" ;;
      *) tar -xzf "$cache/$name" -C "$cache/llama-$arch" --strip-components 1 ;;
    esac
  done
  first=$(echo $archs | cut -d' ' -f1)
  case "$os" in
    macos)
      cp "$cache/llama-$first/LICENSE" "$dest/llama/"
      # cp and lipo follow the release's symlinks, such as libggml.0.dylib to the versioned file.
      for name in llama-server libllama-server-impl.dylib $(for a in $archs; do (cd "$cache/llama-$a" && ls lib*[a-z].0.dylib); done | sort -u); do
        files=""
        for a in $archs; do [ -e "$cache/llama-$a/$name" ] && files="$files $cache/llama-$a/$name"; done
        join "$dest/llama/$name" $files
      done ;;
    linux) (cd "$cache/llama-$first" && cp -P LICENSE llama-server lib*.so* "$dest/llama/") ;;
    windows) (cd "$cache/llama-$first" && cp LICENSE* llama-server.exe *.dll "$dest/llama/") ;;
  esac
  for a in $archs; do rm -rf "$cache/llama-$a"; done
  touch "$llama_marker"
fi
