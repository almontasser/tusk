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
| Filament intelligence | A custom language server written in PHP (`filament-lsp/`) | 6 |

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

### Phpactor's index

Phpactor's indexer ignores `.gitignore`. The client passes
`indexer.exclude_patterns` that add hidden folders, `node_modules`, `storage`,
and `bootstrap/cache` to Phpactor's defaults. On a project with three git
worktrees under `.claude/`, this cut the index from 125,859 files to about
26,700.

Phpactor keeps index entries for files that later become excluded, which
would list classes twice. The client sets its own `indexer.index_path` with a
version suffix (`%project_id%-editor-1`). When the patterns change, bump the
suffix, and every project gets a fresh index.

### Rechecking after indexing

Phpactor checks a file when you open it. During the first indexing, names
defined in files that aren't indexed yet, such as Laravel's `config()` helper,
can show as not found, and Phpactor doesn't recheck them when indexing ends.
The client remembers the title of each `$/progress` token. When the progress
titled "Indexing workspace" ends, it sends `didSave` for every open PHP file,
which makes Phpactor check them again against the full index.

### Questions from servers

A server can ask a question with `window/showMessageRequest`. Phpactor does
this when a project has a `.phpactor.json`, because that file can run code:
it asks whether to trust the file. The client shows the question as a native
dialog with the server's options as buttons (up to three) and sends back the
option you choose. Phpactor saves the answer in
`~/.local/share/phpactor/trust.json`.

After you trust the file, Phpactor asks for a restart to load it. The client
restarts the language servers when a server's message asks for that. The
**Restart Language Servers** action does the same by hand.

### Status bar

Each language server has its own status slot, and the status bar shows the
most recent message that is still set. Otherwise one server finishing a task
would clear another server's indexing progress.

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

Phpactor sends Mago one file at a time on standard input. Mago then uses the
files in `paths` (the project's own code) and `includes` (library code) as
context, and reports problems only in the file it received. The bundled
`resources/mago.toml`, used when a project has no `mago.toml`, sets:

- `paths = ["."]` and `includes = ["vendor"]`, so project classes and
  framework classes such as facades resolve. Project folders must not go in
  `includes`, because Mago never lints included files.
- `excludes` for hidden folders (`.*`), `node_modules`, `storage`, and
  `bootstrap/cache`. Hidden folders can hold whole copies of the project, such
  as git worktrees in `.claude/`.
- The Laravel lint integration, with `strict-types` and
  `literal-named-argument` turned off. On the test app, those two rules
  produced 154 warnings on standard Laravel code.

Mago has no server mode, so each analysis parses the project again. It takes
about 0.6 seconds on the test app and about 2 seconds on a project with 27,000
PHP files. Lint takes milliseconds.

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

## Search and navigation (milestone 4)

### Palette

`src/palette.ts` has one picker, `pick`, used by every search. It takes a
source function that returns items for a query. Slow sources (language server
and disk searches) run after a short delay, and results from an older query are
dropped if a newer one already ran. `fuzzy` scores a subsequence match and
favors consecutive letters and letters that start a word, such as the `P` and
`C` in `PostController`. `src/palette.test.ts` covers it.

### Searches

| Search | Source |
| --- | --- |
| Go to file | `list_files` in `search.rs` |
| Go to class and go to symbol | `workspace/symbol` from every server that supports it |
| Find in files | `search_text` in `search.rs` |
| Search everywhere | Classes, files, and actions together |

`search.rs` uses ripgrep's crates (`ignore` and `grep`). Both commands respect
`.gitignore` files, even outside a git repository, so `vendor` and
`node_modules` are skipped in Laravel projects. Find in files returns at most
2000 matches and is case-sensitive only when the query has a capital letter.
Both commands are `async`, so Tauri runs them off the main thread.

Go to class hides symbols inside the bundled `phpactor.phar`, because Phpactor
also indexes the PHP stubs it ships and those files can't be opened.

### Actions and shortcuts

`main.ts` keeps one list of actions. Each action has a label, an optional
shortcut, and a function. The keyboard handler, **Find Action**, and **Search
Everywhere** all read this list, so a new action needs one line.

The handler listens in the capture phase and stops matched events, so these
shortcuts win over Monaco's defaults (for example, ⌘⇧O is **Go to File**, not
Monaco's quick outline). Editor actions, such as ⌘D, run only while the editor
has focus, so they don't fire while you type in the palette. Double Shift is
two Shift presses within 350 ms with no other key between them.

### Terminal

`pty.rs` opens a pseudo-terminal with `portable-pty` and runs your login shell
(`$SHELL -l`) or a given command in the project folder. A thread reads output
and emits it as `pty:<id>` events, then emits `pty-exit:<id>` when the process
ends. The reader keeps a UTF-8 character that is split across two reads until
the rest arrives, so multibyte text never turns into replacement characters.

`src/terminal.ts` shows each session as a tab in a bottom panel, rendered by
`xterm.js`. Keystrokes go to `pty_write`, and the fit add-on resizes the
pseudo-terminal whenever the panel changes size. You can drag the top edge of
the panel to resize it.

When the app exits, the operating system closes the pseudo-terminals, and the
processes in them receive `SIGHUP`. Terminal processes don't need the language
server watchdog.

### Tests and Run Anything

`src/phptests.ts` finds tests with line-based patterns: `test*` methods,
methods after `#[Test]` or `@test`, and top-level Pest `it()` and `test()`
calls. Each test gets a `--filter` value. PHPUnit filters match
`::method` at the end of the name, with an optional data set suffix, so
`test_a` doesn't also run `test_a_twice`. Pest filters are the escaped
description. The module has no editor imports, so `src/phptests.test.ts` runs
under Node.

`src/runner.ts` registers a Monaco code lens provider for files under `tests/`
or named `*Test.php`, and runs tests and commands in terminal tabs through
`openTerminal`. It remembers the last run for ⌃R.

Run Anything loads `php artisan list --format=json` once per project through
the `run_capture` command, and ranks command names against the first word you
type. The rest of the line becomes the command's arguments. Commands run
through `/bin/sh -c`, so quoting and pipes work.

While a terminal has focus, shortcuts with ⌃ or ⌥ go to the shell (for example,
⌃R searches shell history), except ⌥F12, which hides the panel.

## Git (milestone 5)

### Commands

`src/git.ts` runs `git` through the `run_capture` command in the project
folder. Commands that can prompt for credentials (`pull`, `push`, and `fetch`)
run in terminal tabs instead. `src/gitparse.ts` parses the machine-readable
output, and `src/gitparse.test.ts` covers it:

| Parser | Input |
| --- | --- |
| `parseStatus` | `git status --porcelain=v1 -z --branch` |
| `parseHunks` | `git diff -U0` |
| `parseBlame` | `git blame --porcelain` |

### Refreshing

The app reruns `git status` when you open a folder, show the commit view, or
change git state, and after each batch of file watcher events. The watcher
also reports changes inside `.git`, so commits and checkouts made in a
terminal show up too.

### Commit view and diffs

The commit view splits files by `git status` letter: a file with an index
letter is staged, and a file with a working tree letter has unstaged changes.
A file can be in both lists.

The diff view is a Monaco diff editor that replaces the code editor until you
close it or open a file. A staged change compares `HEAD` with the index, and an
unstaged change compares the index with the file on disk. Both sides are
read-only models with a `git` URI scheme, so the language servers ignore them.

### Change markers and blame

`trackEditor` in `git.ts` adds three things to the code editor:

- **Change markers.** `lineChanges` in `gitparse.ts` compares the editor text
  with the file at `HEAD` (`git show HEAD:<path>`, cached until the next git
  refresh). It trims the lines both versions share at the start and end, then
  runs a longest common subsequence on the rest. It runs 200 ms after you stop
  typing, so the markers include unsaved edits.
- **Inline blame.** For the cursor line, the editor shows the author, age, and
  commit message as text after the line. Blame runs `git blame --porcelain
  --contents -` with the editor text on standard input, so lines you haven't
  saved show "Not committed yet". Results are cached per model version.
- **Annotations.** **Annotate with Git Blame** swaps the line numbers for a
  function that returns the commit, age, and author of each line. Monaco's
  `lineNumbers` option accepts a function, so this needs no custom gutter.

### Avoiding a refresh loop

`git status` refreshes cached file information in `.git/index`. The file
watcher reports that write, which triggers another refresh, which runs
`git status` again. Every git command runs with `--no-optional-locks`, which
stops read-only commands from writing the index and breaks the loop.

### Branches

The branch picker reads `git for-each-ref` with full ref names, which tell
local branches (`refs/heads/`) from remote ones (`refs/remotes/`) even when a
local name contains a slash. Checking out a remote branch runs
`git checkout --track`.

### Pull requests

`src/prs.ts` runs the GitHub CLI (`gh pr list`, `gh pr view`) through
`run_capture` and reads its JSON output. `checksSummary` in `gitparse.ts`
reduces `statusCheckRollup` to one state. It accepts both check runs (with
`status` and `conclusion`) and commit statuses (with `state`).

To diff a pull request file without checking it out, the view fetches the pull
request head into `refs/remotes/pr/<number>` and the base branch into
`refs/remotes/origin/<base>`. It then compares the file at their merge base
with the file at the head, which matches what GitHub shows. The fetch doesn't
touch your working tree or current branch.

The pull request for the current branch (`gh pr view` without a number) loads
when the branch or project changes, through `branchListeners` in `git.ts`.
It makes a network call, so it doesn't run on every refresh.

Descriptions and comments render as plain text (`textContent`), so content
from GitHub can't inject HTML into the editor.

## Filament language server (milestone 6)

Phpactor already completes Filament's fluent methods, such as
`TextInput::make()->required()`, because they are ordinary typed PHP. The
Filament server covers what no general PHP server knows: the strings Filament
resolves against Eloquent models at run time.

### Structure

The server is plain PHP with no dependencies, in `filament-lsp/`. The app
bundles the folder as `tools/filament-lsp/` and starts it with
`php server.php` in the project folder when `vendor/filament/filament` exists.

| File | Role |
| --- | --- |
| `server.php` | LSP over standard input and output: completion, definition, code lenses, and diagnostics |
| `introspect.php` | Boots the project and prints JSON about a resource, its model, and its relationships |
| `tests.php` | Tests against the test app |

### Why a subprocess

PHP can't unload a class. If the server loaded the project's classes itself,
edits to models and resources would never show up. So the server runs
`introspect.php` in a new process, which boots the app, reads the classes
through reflection, and exits. The server caches each result until you save any
file. A call takes about 0.3 seconds on the test app.

### Finding the model for a file

1. If the file declares a class that extends `Resource`, it's the resource.
   Otherwise the server looks for a `*Resource.php` file in the file's folder,
   then in each parent folder up to `app/`. Filament 4 keeps pages, schemas,
   tables, and relation managers in subfolders of the resource's folder.
2. `introspect.php` calls `Resource::getModel()`, `getPages()`, and
   `getRelations()`.
3. For a relation manager, the subject is the related model of its
   `$relationship` on the resource's model.

### Models

Relationships are public methods with no required parameters whose declared
return type extends Eloquent's `Relation`. The introspector calls each one to
find the related model, which doesn't query the database. Columns come from the
schema builder when the app boots and connects. Otherwise they come from the
model's key, `$fillable`, casts, and timestamps. Related models are described
one level deep, which covers paths such as `author.name`.

### Text patterns

The server finds strings with line-based patterns: `::make('…')`,
`->relationship('…')`, and `->relationship('…', '…')`. Diagnostics check only
relationship names (from `->relationship()` and dotted `::make()` paths),
because plain field names can be virtual attributes that aren't columns.

### Links

Code lenses carry the command `phpEditor.open` with a file URI and a line.
`lsp.ts` registers that command and opens the file. Any other code lens
command goes back to its server through `workspace/executeCommand`.

## File operations

`src/files.ts` handles creating, renaming, moving, and deleting from the tree.
The Rust side protects your files:

| Command | Behavior |
| --- | --- |
| `create_file` | Creates missing parent folders and fails if the file exists (`create_new`). |
| `rename_path` | Fails if the target exists, because `std::fs::rename` would replace it silently. A change of case only is allowed. Creates missing parent folders. |
| `trash_path` | Moves to the macOS Trash with the `trash` crate, instead of deleting. |

### Moving PHP files

Phpactor implements `workspace/willRenameFiles`: given the old and new paths,
it returns edits for the class name, the namespace, and every reference. It
reads each file at its new path, so the editor moves the file on disk first,
then asks for the edits and applies them (`updateReferences` in `lsp.ts`). For
a folder, it sends one rename for each PHP file inside.

Two protocol details keep Phpactor's index current, so a second move right
after the first still finds every reference:

- **`didSave` after refactoring edits.** Phpactor reindexes open files when
  they're saved. `applyWorkspaceEdit` writes each edited file and then sends
  `didSave`.
- **File events.** The client declares support for
  `workspace/didChangeWatchedFiles`. Phpactor then stops polling the disk (every
  5 seconds) and relies on the editor, and Laravel LSP also registers for
  events. The file watcher's changes to PHP files go to every registered
  server: a file that exists is reported as changed, and a missing file as
  deleted.

### New PHP files

`newFileContent` in `src/psr4.ts` reads the `autoload` and `autoload-dev`
PSR-4 mappings from `composer.json`, picks the mapping whose folder is the
longest match for the new file, and builds the namespace from the remaining
folders. `src/psr4.test.ts` covers it.

### Tabs

When a file moves, its tab moves in place (`renamed` in `main.ts`): the tab
keeps its position, and any unsaved text carries over to the new path. When a
file or folder goes to the Trash, `forget` closes its tabs and drops their
models.

## Sessions

Monaco keeps one editor and swaps models when you switch tabs, and swapping
drops the cursor, selection, scroll position, and folds. `showModel` in
`main.ts` saves the outgoing tab's view state (`saveViewState`) and restores the
incoming tab's (`restoreViewState`). Every tab switch goes through it, including
closing, deleting, and moving files.

Each project's session is saved in `localStorage` under `session:<root>`:

| Field | Contents |
| --- | --- |
| `tabs` | Open file paths, in tab order |
| `active` | The active tab |
| `views` | Monaco view state for each open tab |
| `dirs` | Expanded folders in the tree |
| `view` | The sidebar view: project, commit, or pull requests |

The editor saves 500 ms after a change (tabs, cursor, scroll, folders, or
sidebar view), when the page unloads, and before it opens another folder. When
it opens a folder, it expands the saved folders, reopens the tabs, and skips
files that no longer exist.

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

### 2026-09-24: PhpStorm keymap

You use PhpStorm, so the editor adopts its macOS keymap instead of Monaco's.
⌘O is **Go to Class**, as in PhpStorm, so opening a folder moved to a sidebar
button and an action.

### 2026-09-24: Node's test runner for frontend logic

Node 24 runs TypeScript directly, so `node --test` covers pure frontend logic
without a test framework. Test files reference Node's types on their own, so
the app code keeps browser types.

### 2026-09-24: Tests and commands run in terminal tabs

PhpStorm has a separate Run tool window. A terminal tab shows the same colored
output, accepts input for interactive Artisan prompts, and needs no second
output view. A structured test tree, which parses JUnit output, can come later
if you want it.

### 2026-09-24: Change markers diff in the frontend

Git can only diff files on disk, so `git diff` markers would lag until you
save. A line diff in TypeScript against the cached `HEAD` version updates while
you type and needs no process per keystroke.

### 2026-09-24: The GitHub CLI instead of the GitHub API

`gh` already handles sign-in, tokens, GitHub Enterprise hosts, and repository
detection from the git remote. Calling it keeps credentials out of the editor.

### 2026-09-24: The Filament server is PHP without dependencies

Reading Filament resources correctly needs the project's own classes, and only
PHP can load them. Writing the server in PHP with no Composer dependencies means
no build step and no bundled PHP archive, and it runs on the PHP that the
project needs anyway.

### 2026-09-24: Exclude hidden folders from indexing and analysis

Tools such as Claude Code keep git worktrees inside hidden folders of the
project. Each worktree is a full copy with its own `vendor`, so indexing it
multiplies the work and duplicates every class. Hidden folders rarely hold PHP
that belongs to the project, so the editor excludes them from Phpactor's index
and from Mago.

### 2026-09-24: Delete to the Trash

PhpStorm deletes permanently but keeps a local history. This editor has no
local history, so the Trash is the undo. Discarding an untracked file in the
commit view also moves it to the Trash.

### 2026-09-24: Rename prompts in the palette

Rename, new file, and new folder reuse the palette as a text prompt, with the
file name preselected up to its extension. Inline editing in the tree would need
its own input handling for little gain.

### 2026-09-24: Sessions in localStorage

A session is a convenience: if it's lost, you reopen a few tabs. `localStorage`
survives app restarts and needs no Rust command or file format. Terminal tabs
aren't saved, because their processes can't be restored.

### 2026-09-24: MCP bridge in debug builds only

`tauri-plugin-mcp-bridge` lets automated tools drive the app for testing. It
can run JavaScript in the webview, so it's compiled only into debug builds and
listens only on `127.0.0.1`.
