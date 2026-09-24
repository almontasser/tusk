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

The backend plans to run every language server as a child process and merge
their answers, so the frontend sees one language server. Milestone 2 builds
this multiplexer.

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

| Tool | Version |
| --- | --- |
| Phpactor | 2026.06.23.0 |

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

### 2026-09-24: One language server until milestone 3

The multiplexer that merges several language servers arrives with the second
server (Laravel LSP) in milestone 3. Building it earlier would mean designing
merge rules without a second server to test them against.

### 2026-09-24: MCP bridge in debug builds only

`tauri-plugin-mcp-bridge` lets automated tools drive the app for testing. It
can run JavaScript in the webview, so it's compiled only into debug builds and
listens only on `127.0.0.1`.
