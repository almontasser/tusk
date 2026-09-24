# PHP Editor

A fast macOS desktop editor for PHP, Laravel, and Filament projects. It aims for
PhpStorm-class navigation and refactoring using only free, open-source language
servers.

The app is built with Tauri 2 (Rust backend) and the Monaco editor.

## Status

| Milestone | State |
| --- | --- |
| 1. Editor shell: folders, file tree, tabs, save, highlighting, file watcher | Done |
| 2. PHP intelligence through Phpactor | Not started |
| 3. Laravel LSP, Mago, and Larastan diagnostics | Not started |
| 4. Terminal, Artisan, test runner, search | Not started |
| 5. Git, blame, and pull requests | Not started |
| 6. Filament language server | Not started |

For the design and the reasons behind each choice, see
[Architecture and decisions](docs/architecture.md).

## Requirements

- macOS
- Rust 1.97 or later
- Node.js 24 or later, and pnpm

## Run in development

1. Install the JavaScript dependencies:

   ```sh
   pnpm install
   ```

2. Start the app:

   ```sh
   pnpm tauri dev
   ```

   The first build compiles the Rust dependencies and takes a few minutes.

## Build a release

```sh
pnpm tauri build
```

The `.app` bundle and the `.dmg` file are written to
`src-tauri/target/release/bundle/`.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| ⌘O | Open a folder |
| ⌘S | Save the current file |
| ⌘W | Close the current tab |

The app reopens the last folder when it starts.

## Project layout

| Path | Contents |
| --- | --- |
| `src/main.ts` | Layout, file tree, tabs, save, and keyboard shortcuts |
| `src/editor.ts` | Monaco setup and web workers |
| `src-tauri/src/lib.rs` | Tauri setup and command registration |
| `src-tauri/src/fs.rs` | File system commands and the file watcher |
| `docs/architecture.md` | Architecture and decision log |
