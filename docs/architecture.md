# Architecture and decisions

This document describes how the editor fits together and why. Update it in the
same commit as the change it describes.

## Overview

The editor is a Tauri 2 app with two halves:

- The **frontend** (`src/`) is TypeScript without a UI framework. Monaco renders
  and edits the code.
- The **backend** (`src-tauri/`) is Rust. It does everything the webview can't:
  file access, file watching, and, in later milestones, running language
  servers, terminals, and `git`.

The frontend calls the backend with Tauri commands (`invoke`). The backend
pushes events to the frontend with Tauri events (`emit`).

## Planned components

| Component | Tool | Milestone |
| --- | --- | --- |
| PHP intelligence | Phpactor language server | 2 |
| Laravel intelligence | Laravel LSP (`laravel/lsp`) | 3 |
| Diagnostics and formatting | Mago and Larastan | 3 |
| Terminal | `xterm.js` and `portable-pty` | 4 |
| Git and pull requests | The `git` and `gh` command-line tools | 5 |
| Filament intelligence | A custom language server written in PHP | 6 |

The backend runs each language server as a child process. The frontend starts
one client per server, and Monaco merges their results.

## Editor shell (milestone 1)

### File system

`src-tauri/src/fs.rs` exposes four commands:

| Command | Purpose |
| --- | --- |
| `read_dir` | Lists one folder, folders first, sorted by name without regard to case. Hides `.git` and `.DS_Store`. |
| `read_file` | Returns a file as UTF-8 text. |
| `write_file` | Replaces a file's contents. |
| `watch` | Watches a folder recursively and emits `fs-change` with the changed paths. |

### File tree

The tree loads each folder only when you expand it, so large folders such as
`vendor` and `node_modules` cost nothing until opened. The frontend keeps a map
from each rendered folder to its list element. When `fs-change` arrives, it
re-renders only the parent folders of the changed paths.

### Tabs and models

Each open file is one Monaco model with a `file://` URI. Monaco picks the
language from the file extension. Language servers identify documents by the
same URI, so milestone 2 needs no path translation.

A tab is dirty when the model's alternative version ID differs from the ID
recorded at the last save. Undoing back to the saved text clears the dirty mark.

### External changes

The frontend batches `fs-change` events for 150 ms. For each changed file that
is open and has no unsaved edits, it reloads the file from disk. It never
overwrites unsaved edits.

## PHP intelligence (milestone 2)

### Bundled tools

`scripts/fetch-tools.sh` downloads each language tool at a pinned version,
checks its SHA-256 checksum, and stores it in `src-tauri/resources/tools/`.
Tauri runs the script before `dev` and `build`, and copies the folder into the
app bundle as `tools/`. To upgrade a tool, change its URL and checksum in the
script.

| Tool | Version | Form |
| --- | --- | --- |
| Phpactor | 2026.06.23.0 | PHP archive (`.phar`) |
| Laravel LSP | 0.0.32 | PHP archive (`.phar`) |
| Mago | 1.50.0 | Native binary for the build machine's architecture |

Downloads are cached in `src-tauri/target/tool-cache/`, so a rebuild doesn't
download again.

### Finding PHP

Apps opened from Finder get a minimal `PATH`. At startup, `lib.rs` runs your
login shell (`$SHELL -ilc`) once and adopts its `PATH`, so every tool the app
starts later (`php`, and in later milestones `git` and `gh`) resolves the same
way as in your terminal.

### Language server bridge

`src-tauri/src/lsp.rs` starts `php tools/phpactor.phar language-server` in the
project folder. A thread reads the server's `Content-Length` framed messages
from standard output and emits each one as an `lsp` event. The `lsp_send`
command writes a message to the server's standard input. Opening another folder
stops the old server.

The bridge doesn't parse messages. All protocol logic lives in `src/lsp.ts`.

### Language server client

`src/lsp.ts` is a small client written for this editor:

- It sends `initialize` with the client capabilities, then registers a Monaco
  provider only for features the server reports.
- It keeps the server in sync with every open PHP model through `didOpen`,
  `didChange` (full text), `didSave`, and `didClose`.
- It answers server requests: `workspace/applyEdit`, `workspace/configuration`,
  and the progress and registration requests.
- It shows `$/progress` and `window/showMessage` in the status bar.

| Feature | LSP method | Monaco feature |
| --- | --- | --- |
| Completion, including auto-import | `textDocument/completion` | Suggest widget |
| Hover | `textDocument/hover` | Hover widget |
| Signature help | `textDocument/signatureHelp` | Parameter hints |
| Go to definition, declaration, type definition, implementations | `textDocument/definition` and siblings | Go to and peek |
| Find references | `textDocument/references` | Peek references |
| Highlight occurrences | `textDocument/documentHighlight` | Word highlight |
| Outline | `textDocument/documentSymbol` | Quick outline |
| Code actions | `textDocument/codeAction`, `codeAction/resolve`, `workspace/executeCommand` | Light bulb and **Quick Fix** menu |
| Rename | `textDocument/prepareRename`, `textDocument/rename` | Rename box |
| Folding | `textDocument/foldingRange` | Folding |
| Smart select | `textDocument/selectionRange` | Expand and shrink selection |
| Inlay hints | `textDocument/inlayHint` | Parameter names and types inline |
| Diagnostics | `textDocument/publishDiagnostics` | Squiggles and markers |
| Formatting | `textDocument/formatting` | **Format Document**, when the server supports it |

Phpactor doesn't format code. Milestone 3 adds formatting through Mago.

Monaco has no UI for type hierarchy or workspace-wide symbol search. Milestone 4
adds workspace symbol search to search everywhere. Type hierarchy needs its own
panel and isn't built yet.

### Files outside the open tabs

Monaco can show a location only if a model exists for its file. Before the
client returns locations, it loads each target file into a model through the
`ensureModel` callback in `main.ts`. These models stay loaded and stay in sync
with the language server. When a file changes on disk, the watcher reloads its
model unless an open tab has unsaved edits in it.

### Workspace edits

`applyWorkspaceEdit` handles rename and code action results. For each text
edit, it loads the file into a model, applies the edits so that you can undo
them, and saves the file. It also runs file operations (create, rename, and
delete) through Rust commands. When a class rename renames its file, the open
tab moves to the new path.

## Laravel, diagnostics, and formatting (milestone 3)

### Several language servers

`lsp.rs` keeps running servers by name. `lsp_start` accepts only known names
(`phpactor` and `laravel`), so the frontend can't start arbitrary commands.
Each server's messages arrive as a separate event (`lsp:phpactor` and
`lsp:laravel`).

In `lsp.ts`, `startServer` creates one client per server with its own request
IDs, diagnostics, and Monaco providers. It passes the server's language list to
every provider registration:

| Server | Languages | Starts when |
| --- | --- | --- |
| Phpactor | `php` | Always |
| Laravel LSP | `php`, `blade` | The folder has an `artisan` file |

Monaco combines providers for the same language: it merges completion lists,
definitions, references, hovers, code actions, and links. Each server writes
its markers under its own owner (`lsp:phpactor` or `lsp:laravel`), so one
server's diagnostics never replace another's. A code action carries the
function that runs it, so it goes back to the server that created it.

### Server lifetime

Opening another folder stops the old clients and servers. Quitting the app
stops all servers through `LspState::stop_all`.

If the app crashes or is force-quit, that code never runs. Phpactor ignores the
LSP `processId` and keeps running, so each server starts through a small shell
watchdog (`WATCHDOG` in `lsp.rs`). The shell starts a loop that checks the
app's process ID every 2 seconds, then replaces itself with the server through
`exec`. The server keeps the shell's process ID, so stopping it normally still
works, and the loop kills it within 2 seconds after the app dies.

### Mago

Phpactor has a built-in Mago integration. The client turns it on and points it
at the bundled binary, so Mago's static analysis and lint results arrive as
Phpactor diagnostics while you type.

Formatting doesn't go through a language server. The `format_php` command pipes
the file through `mago format --stdin-input` in the project folder. Monaco
turns the whole-file result into minimal edits, so the cursor and undo history
stay useful.

### Default Mago configuration

Without a project `mago.toml`, Mago doesn't read `vendor`. The analyzer then
reports every facade method and framework helper as missing. On the test app,
Mago's default lint rules also produced 124 `literal-named-argument` warnings
and 30 `strict-types` warnings on standard Laravel code. The bundled
`resources/mago.toml` includes `vendor`, turns on the Laravel lint integration,
and turns those two rules off. The client passes it to Phpactor only when the
project has no `mago.toml`.

### PHPStan and Larastan

If the project has `vendor/bin/phpstan`, the client turns on Phpactor's PHPStan
integration. PHPStan reads the project's own configuration, so Larastan works
when the project installs it.

### Blade

Monaco has no Blade language. `editor.ts` registers `blade` for `.blade.php`
files, which takes precedence over `php` because the extension is longer. The
grammar is Monaco's PHP grammar with rules for Blade comments, echo delimiters,
and directives added in front. The PHP grammar's plain-text rule would consume
Blade syntax, so the Blade grammar replaces it with one that stops at `@`, `{`,
`}`, and `!`. Blade rules apply in HTML text, not inside tags or attributes.

Because Blade files have their own language, Phpactor doesn't receive them and
can't report PHP errors in template markup.

## Decision log

### 2026-09-24: Build on free language servers instead of writing one

Intelephense locks rename, find implementations, type hierarchy, inlay hints,
code actions, and code lens behind a paid licence. Phpactor (MIT) provides all
of them for free. Laravel LSP is first-party and MIT-licensed. Writing a PHP
language server from scratch would take years, so the editor only builds what
no free tool provides: Filament support.

If Phpactor is too slow on large projects, PHPantom (a Rust language server) can
replace it behind the same multiplexer.

### 2026-09-24: Tauri and Monaco instead of a native UI

You chose a fast desktop app over a pure native UI. Tauri keeps memory use low
because it uses the system webview. Monaco provides a mature editor and speaks
the same data model as the Language Server Protocol.

### 2026-09-24: No UI framework

The UI is a tree, a tab bar, and panels. Plain DOM code handles that in fewer
lines than a framework needs for setup. Revisit this if the panels in
milestones 4 and 5 become hard to maintain.

### 2026-09-24: Use the dialog plugin for confirmations

`window.confirm` is unreliable in WKWebView, so the app asks through
`@tauri-apps/plugin-dialog` instead.

### 2026-09-24: Bundle pinned tools instead of global installs

The editor must work on any machine. A global `composer global require` works
only where someone ran it, and it drifts to versions the editor wasn't tested
with. Bundled tools are pinned, verified by checksum, and work offline. PHP is
the only requirement, and every Laravel project needs it anyway.

### 2026-09-24: A small custom LSP client instead of `monaco-languageclient`

`monaco-languageclient` requires `@codingame/monaco-vscode-api`, which replaces
Monaco with a large emulation of VS Code services. The editor needs about 15
LSP features, and each maps directly to a Monaco provider. A client of about
450 lines covers them and is easier to debug.

### 2026-09-24: Refactorings save the files they change

Rename and code actions can touch files that aren't open, and a class rename
also renames the file on disk. If the edits stayed unsaved in memory, the file
rename would move the old contents. Saving every touched file avoids that, and
matches how PhpStorm behaves.

### 2026-09-24: Monaco merges language servers instead of a Rust multiplexer

The plan was a Rust multiplexer that merged several servers into one. Monaco
already merges results from several providers for the same language, and it
keeps markers apart by owner. One client per server needs no merge rules and
no protocol parsing in Rust.

### 2026-09-24: Watchdog shell instead of relying on `processId`

The LSP `processId` field asks servers to exit when the editor dies. Laravel LSP
does; Phpactor doesn't. Leaked servers keep indexing and using memory. A shell
loop that checks the app's process ID works for every server, and `exec` keeps
the server's process ID stable.

### 2026-09-24: Bundled default Mago configuration

Mago's defaults suit strict libraries, not Laravel apps. Without a
configuration, the editor showed false errors on every facade call. A small
bundled default makes Mago useful without setup, and a project's own
`mago.toml` always wins.

### 2026-09-24: MCP bridge in debug builds only

`tauri-plugin-mcp-bridge` lets automated tools drive the app for testing. It
can run JavaScript in the webview, so it's compiled only into debug builds and
listens only on `127.0.0.1`.
