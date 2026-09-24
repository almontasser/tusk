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
| 4. Terminal, Artisan, test runner, search | Done |
| 5. Git, blame, and pull requests | Not started |
| 6. Filament language server | Not started |

For the design and the reasons behind each choice, see
[Architecture and decisions](docs/architecture.md).

## Known gaps

These PhpStorm features are missing or limited. Each one names the file to
change when you add it.

| Area | Gap |
| --- | --- |
| Type hierarchy | Phpactor can provide it, but Monaco has no view for it. It needs its own panel. |
| Find in files | Plain text only. There's no regex option, and case sensitivity is automatic: the search is case-sensitive only when the query has a capital letter (`search_text` in `src-tauri/src/search.rs` already accepts both options; `findInFiles` in `src/main.ts` needs toggles). |
| Go to file | Files ignored by `.gitignore`, such as `vendor`, aren't listed. Go to class still finds `vendor` classes. |
| Test results | Tests print to a terminal tab. There's no tree of passed and failed tests (it would parse JUnit output in `src/runner.ts`). |
| Test detection | Line-based patterns in `src/phptests.ts` miss declarations split across lines. |
| Blade | Blade rules color HTML text only, not tags or attributes. PHP inside Blade gets no Phpactor diagnostics. |
| Formatting | Only PHP files format (through Mago). |
| First indexing | Phpactor indexes a new project once, which takes minutes for a full Laravel app. Progress shows in the status bar. |
| Unsaved files | Language servers sync the full text on every change, which may lag on very large files (`track` in `src/lsp.ts`). |
| Platform | macOS only, and a build contains Mago for the build machine's architecture only (not a universal binary). |

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

## Run the tests

```sh
pnpm test                          # Frontend logic, with Node's test runner
cargo test --manifest-path src-tauri/Cargo.toml   # Rust
```

## Build a release

```sh
pnpm tauri build
```

The `.app` bundle and the `.dmg` file are written to
`src-tauri/target/release/bundle/`.

## Keyboard shortcuts

Shortcuts follow PhpStorm's macOS keymap. To see every action and its
shortcut, press ⌘⇧A (**Find Action**).

| Shortcut | Action |
| --- | --- |
| ⇧⇧ | Search everywhere: classes, files, and actions |
| ⌘⇧A | Find action |
| ⌘O | Go to class |
| ⌘⇧O | Go to file |
| ⌥⌘O | Go to symbol in the project |
| ⌘E | Recent files |
| ⌘⇧F | Find in files |
| ⌘F12 | File structure |
| ⌘B or ⌘-click | Go to declaration |
| ⌥⌘B | Go to implementation |
| ⌃⇧B | Go to type declaration |
| ⌥F7 | Find usages |
| ⇧F6 | Rename (also renames the file for a class) |
| ⌥⏎ | Show context actions and quick fixes |
| ⌘P | Parameter info |
| F1 | Quick documentation |
| ⌥↑ and ⌥↓ | Extend and shrink the selection |
| ⌥⇧↑ and ⌥⇧↓ | Move the line up or down |
| ⌘D | Duplicate the line |
| ⌘⌫ | Delete the line |
| ⌃⌥O | Optimize imports |
| ⌥⌘L | Reformat the file with Mago |
| ⌥F12 | Show or hide the terminal |
| ⌃⌃ | Run anything: Artisan commands or shell commands |
| ⌃⇧R | Run the test at the cursor, or all tests in the file |
| ⌃R | Rerun the last test or command |
| ⌘S | Save |
| ⌘W | Close the tab |
| ⌃Space | Show completions |

To open a folder, click **Open Folder…** in the sidebar or run the **Open
Folder…** action. The app reopens the last folder when it starts. Refactorings such as rename
save every file they change.

## Laravel features

In Laravel projects (folders with an `artisan` file), the app also runs Laravel
LSP. It adds completion, hover, go to definition, links, and diagnostics for
config keys, routes, views, translations, environment variables, middleware,
and container bindings, in PHP and Blade files. For example, ⌘-click on
`view('welcome')` opens `resources/views/welcome.blade.php`.

## Tests and commands

In test files, **▶ Run test** and **▶ Run all tests in file** links appear above
PHPUnit test methods (`test*` methods, `#[Test]`, and `@test`) and Pest `it()`
and `test()` calls. Tests run through `php artisan test` in Laravel projects,
and through `vendor/bin/pest` or `vendor/bin/phpunit` otherwise.

Press ⌃⌃ and type an Artisan command with its arguments, such as
`make:model Comment -m`. The command name is matched fuzzily, so `mk:mod`
works. To run any other command, choose the last item. Tests and commands run
in terminal tabs, and ⌃R reruns the last one.

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
| `src/terminal.ts` | Terminal panel |
| `src/runner.ts` | Test runner, run links, and Run Anything |
| `src/phptests.ts` | Finds PHPUnit and Pest tests in a file |
| `src/palette.ts` | The picker used by search and actions, and fuzzy matching |
| `src-tauri/src/lib.rs` | Tauri setup and command registration |
| `src-tauri/src/fs.rs` | File system commands and the file watcher |
| `src-tauri/src/lsp.rs` | Starts the language servers and relays their messages |
| `src-tauri/src/tools.rs` | Tool paths and Mago formatting |
| `src-tauri/src/search.rs` | Project file listing and text search |
| `src-tauri/src/pty.rs` | Pseudo-terminals for the terminal panel |
| `src-tauri/resources/mago.toml` | Default Mago configuration |
| `scripts/fetch-tools.sh` | Downloads the pinned language tools |
| `scripts/make-fixture.sh` | Creates the test app |
| `docs/architecture.md` | Architecture and decision log |
