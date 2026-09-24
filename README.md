# PHP Editor

A fast macOS desktop editor for PHP, Laravel, and Filament projects. It aims for
PhpStorm-class navigation and refactoring using only free, open-source language
servers.

The app is built with Tauri 2 (Rust backend) and the Monaco editor.

## Status

| Milestone | State |
| --- | --- |
| 1. Editor shell: folders, file tree, tabs, save, highlighting, file watcher | Done |
| 2. PHP intelligence through Phpactor | Done |
| 3. Laravel LSP, Mago, and Larastan diagnostics | Done |
| 4. Terminal, Artisan, test runner, search | Not started |
| 5. Git, blame, and pull requests | Not started |
| 6. Filament language server | Not started |

For the design and the reasons behind each choice, see
[Architecture and decisions](docs/architecture.md).

## Requirements

To use the app, you need:

- macOS
- PHP 8.1 or later on your `PATH`. The app finds PHP through your login shell,
  so installs from Homebrew and Laravel Herd work.

To build the app, you also need:

- Rust 1.97 or later
- Node.js 24 or later, and pnpm

The app bundles its language tools (Phpactor, Laravel LSP, and Mago), so you
don't install them yourself. If your project has PHPStan or Larastan in
`vendor/bin/phpstan`, the app runs it too. The build downloads pinned versions with `scripts/fetch-tools.sh` and
checks each download against its SHA-256 checksum.

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
| F12 or ⌘-click | Go to definition |
| ⇧F12 | Find references |
| ⌘F12 | Go to implementations |
| F2 | Rename symbol (also renames the file for a class) |
| ⌘. | Show quick fixes and code actions |
| ⌃⇧⌘→ and ⌃⇧⌘← | Expand and shrink the selection |
| ⇧⌘O | Go to a symbol in the file |
| ⌃Space | Show completions |
| ⌥⌘L or ⇧⌥F | Format the file with Mago |

The app reopens the last folder when it starts. Refactorings such as rename
save every file they change.

## Laravel features

In Laravel projects (folders with an `artisan` file), the app also runs Laravel
LSP. It adds completion, hover, go to definition, links, and diagnostics for
config keys, routes, views, translations, environment variables, middleware,
and container bindings, in PHP and Blade files. For example, ⌘-click on
`view('welcome')` opens `resources/views/welcome.blade.php`.

## Diagnostics and formatting

Mago checks PHP files as you type (static analysis and lint) and formats them.
If your project has a `mago.toml` file, Mago uses it. Otherwise the app uses
defaults tuned for Laravel, in `src-tauri/resources/mago.toml`: the analyzer
reads `vendor`, and two rules that flag normal Laravel code on nearly every file
(`strict-types` and `literal-named-argument`) are off.

## Test app

`scripts/make-fixture.sh` creates `fixtures/demo`, a Laravel 12 app with
Filament 4, an `Author` model, a `Post` model, and a Filament resource for posts.
Use it to try navigation and refactoring by hand. The `fixtures` folder isn't
committed.

```sh
./scripts/make-fixture.sh
```

## Project layout

| Path | Contents |
| --- | --- |
| `src/main.ts` | Layout, file tree, tabs, save, and keyboard shortcuts |
| `src/editor.ts` | Monaco setup, web workers, and the Blade language |
| `src/lsp.ts` | Language Server Protocol client and Monaco providers |
| `src-tauri/src/lib.rs` | Tauri setup and command registration |
| `src-tauri/src/fs.rs` | File system commands and the file watcher |
| `src-tauri/src/lsp.rs` | Starts the language servers and relays their messages |
| `src-tauri/src/tools.rs` | Tool paths and Mago formatting |
| `src-tauri/resources/mago.toml` | Default Mago configuration |
| `scripts/fetch-tools.sh` | Downloads the pinned language tools |
| `scripts/make-fixture.sh` | Creates the test app |
| `docs/architecture.md` | Architecture and decision log |
