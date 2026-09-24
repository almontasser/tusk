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

### Split panes

`main.ts` keeps a list of panes. Each pane has its own Monaco editor and shows
one of the shared tabs. `editor` and `active` always refer to the focused pane,
so actions, the opener, and saving work on whichever pane you're in. Other panes
remember their file in `Pane.active`. `addPane` sets up everything an editor
needs: settings (`addEditor`), git markers and blame (`trackEditor`), conflict
shading (`decorateConflicts`), session saving, and focus tracking. When a tab
closes, moves, or is deleted, `updateOtherPanes` points other panes at another
tab, and a pane left with nothing to show closes.

### Saving

`saveFile` writes one tab if it has unsaved changes, then marks it saved, sends
`didSave` to the language servers, and lets git mark a resolved conflict. Files
save automatically, as in PhpStorm: `showModel` saves the tab you leave, closing
a tab saves it (and keeps it open if the save fails), and the window's `blur`
event saves every tab. ⌘S runs `saveAll`.

### Settings and themes

`src/settings.ts` keeps one settings object, loads it from `settings.json` in
the app's config folder (`appConfigDir`), and ignores unknown keys and values of
the wrong type. The dialog is built from one list of fields. Each change applies
at once (`apply`) and writes the file.

`apply` updates Monaco's editor options, calls `monaco.editor.setTheme`, and sets
`data-theme` on the root element. The stylesheet defines colors as variables,
with a light set under `:root[data-theme="light"]`. Other modules react through
`onSettings`, as the terminal does to switch its colors. No editor is created
with a `theme` option, because that would reset Monaco's global theme. The
"system" theme follows `prefers-color-scheme` as it changes.

Format on save formats the active editor through Monaco's format action, which
applies minimal edits and keeps the cursor in place, and formats other files
with one undoable edit.

### Keymap

Each action has a default shortcut in `main.ts`. `settings.keymap` overrides
them by action name, and an empty string removes a shortcut. An `onSettings`
listener sets each action's `keys` from the defaults and the overrides, so the
key handler, the palette, and Find Action all see the current shortcuts. The
recorder listens in the capture phase and sets `recording`, which the global
key handlers check, so the combination you press doesn't also run an action.

### EditorConfig

`src/editorconfig.ts` parses `.editorconfig` files and turns their section
globs into regexes (`*`, `**`, `?`, `[...]`, `{a,b}`, and `{1..3}`). A glob
without a slash matches the file name in any folder. For a file, `main.ts`
reads the `.editorconfig` of each folder from the project root down, cached
per folder, and applies the sections in order, so closer files and later
sections win, and `root = true` ignores the files above. A new model gets
`insertSpaces`, `tabSize`, and `indentSize` from them. Saving trims trailing
whitespace and fixes the final newline as one undoable edit, before the text is
written.

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
| Tailwind CSS language server | 0.16.0 | npm package, run with Node |
| vtsls (TypeScript) | 0.3.0, with TypeScript 5.9.3 | npm package, run with Node |
| Vue language server | 3.3.11 | npm package, run with Node |
| PHP Debug (Xdebug adapter) | 1.40.2 | The `.vsix` from `xdebug/vscode-php-debug`, run with Node |
| `llama-server` (llama.cpp) | b11165 | Native binary and its libraries, for AI completion |

Downloads are cached in `src-tauri/target/tool-cache/`, so a rebuild doesn't
download again.

Node-based servers are listed in `node-tools/package.json` with a committed
lockfile. The fetch script copies both into `resources/tools/node/` and runs
`npm ci --omit=dev --ignore-scripts`, which checks every package against the
lockfile's integrity hashes and runs no install scripts. It reinstalls only when
the lockfile changes. To upgrade, change the version in `node-tools/package.json`
and run `npm install --package-lock-only` in that folder.

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

### Reindexing after Composer changes

Composer extracts package files with the package's own modification times,
which are older than Phpactor's index. Phpactor's update pass at startup
compares times, so it skips a newly installed package, and its classes and
functions show as not found. `checkComposerLock` keeps a hash of
`composer.lock` per project in `localStorage`. When the hash differs, at
startup (so installs made while the editor was closed count) or when the file
watcher reports a change, `reindex()` sends Phpactor's
`phpactor/indexer/reindex` request with `soft: false`, which resets the index
and rebuilds it. The first time a project opens, there's no hash yet, so it
reindexes once.

### Files changed by other programs

Phpactor's index doesn't pick up PHP files that another program creates or
changes, such as `php artisan make:model` or a `git checkout`. The editor sends
`workspace/didChangeWatchedFiles` for them, and Phpactor registers for those
events, but in testing the classes stayed out of the index until a reindex; the
cause, somewhere in Phpactor's watcher, wasn't found. So `filesChanged` also
asks for a soft reindex (`soft: true`), which indexes only files modified since
the last pass, 2 seconds after the last such change. It skips files open in the
editor, which Phpactor already gets through the editor, and files in the
folders the index excludes (`vendor`, `node_modules`, `storage`,
`bootstrap/cache`, and hidden folders), so Laravel's own writes to `storage`
don't trigger it. A new class is in the index about 3 seconds after its file
appears.

### Diagnostics run in the server process

By default, Phpactor runs its own diagnostics in a child process,
`phpactor language-server:diagnostics`. That process reads only
`.phpactor.json` and the global config, not the settings the editor sends
with `initialize`, so it used Phpactor's default index path instead of the
editor's. That index can be missing newer packages, and functions from them
showed as not found even after a reindex. The editor sets
`language_server.diagnostic_outsource` to `false`, so diagnostics run in the
server process with the editor's settings.

### Pest in diagnostics

Pest binds test closures to the test case that `tests/Pest.php` sets, so
`$this->get()` works in a Pest test. Phpactor reports `$this` as undefined, and
Mago types it as `PHPUnit\Framework\TestCase`. In files under `tests/` that
call `it()`, `test()`, or `describe()`, `setMarkers` drops problems that mention
`$this`, `TestCase`, or `mixed` on lines that use `$this`, and Phpactor's hint
to add a namespace.

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

### Safe delete

`src/safedelete.ts` finds the declaration with `textDocument/documentSymbol`
and its usages with `textDocument/references`, leaving out references inside
the declaration itself, such as recursive calls. Phpactor misses Laravel's
calls by name, so a whole-word, case-sensitive text search over `*.php` adds
possible usages: a class's full name with single or double backslashes, or a
method's names from `laravelNames` (its own, its scope name, and its accessor
attribute name). A match that isn't a real usage only means you're asked
before deleting.

The confirmation is a palette choice, not a native dialog. A native dialog
that's open when the page reloads stays on screen and can't be answered. The
deletion also checks that the model's version hasn't changed since the check,
because the symbol's line numbers would be out of date, and only one Safe
Delete runs at a time. `deletionLines` in `src/phptypes.ts` widens the removed
lines to the docblock, attributes, and one blank line.

### Inline variable and change signature

`src/refactorparse.ts` holds the text work, tested in Node: `matchBracket` and
`splitTopLevel` scan brackets and strings (not heredocs), `planInline` checks
that a variable has exactly one plain assignment, starting its line and
ending at the first `;` outside brackets and strings (`statementEnd`), so a
closure or a chain over several lines counts as one, and no other writes (compound assignment, `[]`, `->prop =`, `++`, `&`, `foreach … as`),
and `rewriteArgs` maps a call's arguments to a new parameter list by name.
`src/refactor.ts` applies them: inlining is one undoable edit in the model;
a signature change becomes a `WorkspaceEdit` for `applyWorkspaceEdit`, which
edits and saves each file.

Calls of a method come from Phpactor's command line, `phpactor references:member
<class> <method> --format=json`, run with the editor's index path. The command
scans the project's files (`--filesystem=git`), while the language server's
`textDocument/references` relies on its index and missed calls in files it
hadn't indexed. Safe Delete uses the same search for methods. Functions, which
the command doesn't cover, still use the language server.

Change Signature also changes overrides. `overridesOf` searches project files
for `extends` or `implements` lines naming the class, keeps the types whose
parsed declaration really names it, and repeats for each one found, to reach
grandchildren. Phpactor's Go to Implementation would include `vendor`, but it
answers from the index, which misses classes created since the last full
index: in testing, file change events for new files didn't reach the index
until a reindex. Each override's parameter list gets the new text, and calls
through the override (`references:member` on its class) are rewritten too,
without duplicates. References that are declarations (`function name(`) are
skipped, since they have their own edit.

### Type hierarchy

Phpactor has no `textDocument/prepareTypeHierarchy`, so `src/hierarchy.ts`
builds the tree from requests it does support.

The starting type comes from the cursor. On a capitalized word, the view asks
Phpactor for its definition and reads the type declared at that line; the name
must match the word, so a constant or method doesn't count. Otherwise it takes
the type declared at or above the cursor line in the current file.

- **Supertypes**: `parseTypeDeclarations` in `src/phptypes.ts` reads every
  type a file declares and resolves the names after `extends` and `implements`,
  and the traits in `use` lines inside its body, through the file's
  `namespace` and `use` statements. Each parent's file comes from a
  workspace symbol search, matched on name and namespace.
- **Subtypes**: `textDocument/implementation` at the type's name. Phpactor
  answers from its index with every descendant, so the tree keeps the ones
  whose own declaration names the type, and deeper ones appear when you expand
  their parent. The request needs the file open in Phpactor, so the file gets a
  model (without a tab). Phpactor doesn't list a trait's users, so for a trait
  a text search finds `use` lines naming it, and the tree keeps the types
  whose declaration really uses it.

Children load when a row expands, so a large hierarchy, such as `Model`'s,
costs nothing until you open it.

### HTTP client

`src/httpfile.ts` parses `.http` files and curl's output, and Node tests both.
`src/httpclient.ts` registers an `http` language with a Monarch grammar, a
code lens per request, and ⌘⏎. A request runs `/usr/bin/curl -sS -i` through
`run_capture`, with the body on stdin (`--data-binary @-`) and the total time
appended by `--write-out` after a marker. curl ships with macOS, and running it
from Rust avoids the browser's CORS rules that `fetch` in the webview would
apply. Interim responses, such as `100 Continue`, are skipped when parsing.

### Composer

`composer.phar` is bundled like the other tools, pinned with its checksum from
getcomposer.org. The tool window reads `composer show --direct --format=json`
first, then `composer outdated --direct --format=json`, which asks Packagist
and takes a second or two. `packages` in `src/composerdata.ts` joins them with
`require-dev` from `composer.json`. Packagist search goes through curl, like
the HTTP client. Commands that change packages run in terminal tabs, and the
tab's exit reloads the list. The `composer.lock` change they cause also
reindexes Phpactor.

### Spell checking

Spelling comes from `typos-lsp`, a language server for the `typos` checker,
bundled per architecture like Mago. `typos` checks words against a list of
known misspellings, not a dictionary, so it doesn't flag names, jargon, or
abbreviations, and it understands `camelCase` and `snake_case`. The server
reports misspellings as information, with a fix and an "ignore in the project"
code action, which writes `typos.toml`. It's a native binary, so the bridge
runs it without a runtime (an empty runtime in `lsp.rs`). Changing the
**Check spelling** setting restarts the servers, which starts or stops it.

### AI code completion

`ai.ts` shows suggestions from a local model as Monaco inline completions
(ghost text). The model runs in `llama-server` from llama.cpp, bundled like
Mago. The fetch script keeps only the server, the libraries it loads, and the
licence (24 MB); the libraries keep their `.0.dylib` names because the server
finds them through `@loader_path`. It uses the GPU through Metal.

Models aren't bundled. The **AI completion model** setting picks one of three
Qwen2.5-Coder base models, which are trained for fill-in-the-middle. Each is
pinned to a Hugging Face revision and checked against its SHA-256 after
download. The download runs the system `curl` with `-C -` and `--retry`, so
it resumes after a dropped connection (Hugging Face's CDN resets long HTTP/2
downloads now and then). A download that still fails keeps its `.part` file,
and turning the setting on again continues it. The status bar shows progress by polling the size of
the `.part` file. Turning the setting on is the consent to download, since a
question in the palette would sit behind the modal Settings dialog.

`ai_start` in `lsp.rs` starts the server on a free port with the same
watchdog as the language servers, and stores it in the language server table
as `llama`. That way `lsp_stop("llama")` and quitting the app stop it too.
The client waits for `/health` before it asks for suggestions.
The server allows requests from any origin, so a web page in a browser could
call it and read the code in its prompt cache. Each start gets a random API key
(`--api-key`), which the client sends as a bearer token; only `/health` works
without it.

Each suggestion is a request to `/infill`. `infillRequest` in `aicontext.ts`
builds the body, so the editor and the benchmark send the same prompts. It
carries:

- The 150 lines before the cursor, the text before the cursor on its line, and
  the rest of the line plus 40 lines after it. The server keeps at most 3/4 of
  its batch size (`-b 2048`) in tokens before the cursor and 1/4 after it.
- Extra files (`input_extra`) from the project, described in the next section.
  Qwen2.5-Coder was trained on repositories laid out as files separated by
  `<|file_sep|>` and a path, and the server formats extra files that way, so
  each carries its path relative to the project root.
- `n_indent`, which stops the suggestion at a line indented less than the
  cursor's line, so a suggestion stays inside its block.
- Greedy decoding (`top_k: 1`), which scored 4 points higher than sampling in
  the benchmark, and gives the same suggestion for the same prompt.
- A limit of 1.5 seconds and 128 tokens for writing.

The request goes through `ai_request` in `lsp.rs`, a plain HTTP/1.1 POST over a
`TcpStream`, rather than `fetch`: the bundled app's page origin might block a
request to `http://127.0.0.1`. The client gives each request an ID. When Monaco
cancels a request because you typed again, `ai_cancel` shuts the socket, and
llama-server stops working on it when it sees the connection close. The server
has a single slot, so a request that was left running delayed the next one:
after a long request, the next one took 3.7 seconds when the first ran to the
end, and 0.9 seconds when it was cancelled.

The provider waits 250 ms after typing stops and skips the middle of a word.
`cleanSuggestion` then trims the reply. Small models often go on to repeat
the code below the cursor (5–6% of benchmark suggestions did), so a suggestion
ends before a line equal to the next non-blank line below. A suggestion that
adds nothing is dropped. When a suggestion's first line ends with the rest of
the current line, such as a closing bracket, it replaces that text instead of
adding a second copy.

### Context for AI completion

Autocomplete context follows what Copilot and llama.vim do rather than
embeddings. The query is the code before the cursor, not a question, and
comparing names finds the same code an embedding search would. That takes
milliseconds with no second model to run, and no minutes spent embedding the
project. Embeddings would pay off for a chat that answers questions about the
codebase.

`ai.ts` keeps an index of the project when completion is on: the text of up to
3,000 source files (`list_files`, so `.gitignore` applies, without `vendor`,
`node_modules`, `storage`, and `public`), each cut into 30-line chunks every 15
lines with the set of names in each. The file watcher updates changed files.
`aicontext.ts` holds the logic, free of editor imports so Node can test it.
Each request gets up to about 13,500 characters (about 4,000 tokens) of
extra files, in this order:

1. **Definitions, up to 7,000 characters.** `referencedClasses` finds the
   capitalized names in a PHP file outside strings, comments, and imports,
   resolves them through the file's imports and namespace, and orders them by
   distance from the cursor. The eight nearest that map to an indexed file
   through PSR-4 (`pathsFor`) are sent as outlines: the file without imports,
   with each method body replaced by `{ … }`, cut at 2,500 characters. Open
   files are outlined from their unsaved text.
2. **Models.** `introspect.php models` boots the app once, and describes
   every model under `app/`: columns from `Schema::getColumns` (or the model's
   fillable, casts, and timestamps without a database), casts, and
   relationships. It takes about 0.3 seconds, and runs again 5 seconds after a
   PHP file under `app/` or `database/migrations/` changes. The current class
   and the referenced classes that are models go first, as an
   `_ide_helper_models.php` file of ide-helper docblocks, because models learned
   `@property` lines from real projects. Casts win over database types, and
   `tinyint` counts as `bool`, which is what Laravel's `boolean()` creates in
   MySQL and SQLite.
3. **Recent code, up to 3,000 characters.** When an editor loses focus, the 30
   lines around its cursor join a list of the last six places, replacing a
   place in the same file within 20 lines. Places in the current file are left
   out.
4. **Similar code, up to 3,500 characters.** The chunks whose names overlap
   most (Jaccard similarity) with the 20 lines before the cursor, at least 10%
   and never two that overlap. The current file's own chunks come from its
   live text, except those already in the prompt. Chunks from outlined files,
   and ones that overlap the recent code, are left out. A search over 15,000
   chunks takes about 10 ms.

The order and the rules around it serve the server's prompt cache.
Processing the prompt runs at about 1,800 tokens a second for the 1.5B model on
an M4 Pro, whatever the batch or flash-attention settings, so a full prompt
takes 2 seconds cold. With the prompt cached, a request after a keystroke
takes about 0.1–0.3 seconds. The server reuses the prompt only up to the first
change, so the parts that change least come first. The classes are sorted by
file name, not by distance, so moving the cursor changes them only when the
set changes. Similar code is searched again only when the cursor moves to
another block of 10 lines. The recent code changes only when you leave an
editor.

When the prompt does change, the editor sends a request with `n_predict: 0`
beforehand, which processes the prompt without writing anything, as llama.vim
does. That happens 500 ms after an editor gains focus, and 1 second after the
cursor settles in a new block of 10 lines. A suggestion after that takes about
0.2 seconds instead of 1–2.

### Measuring completion

`scripts/ai-bench.ts` measures completion on a real project. It hides code in
method bodies of PHP classes under `app/`: either a whole line from its
indentation, or the rest of a line after a point where a developer would pause
(`->`, `::`, `(`, `= `, `, `, or `[`). Then it asks the model to fill it in with
each kind of context. It indexes the project the way the editor does, builds
prompts with the editor's own functions, and starts `llama-server` with the
same options. It scores the first line of each cleaned suggestion: exact
matches, edit similarity, empty suggestions, and how often the raw suggestion
repeated the code below. Recent code isn't measured, since a benchmark has no
history of where you worked.

```sh
node scripts/ai-bench.ts <project> <model.gguf> [cases] [configs]
```

Results on koel (2,428 files; no database, so no model columns), with 300
cases and the 1.5B model:

| Context | Exact first line | Edit similarity | Context tokens (median) |
| --- | --- | --- | --- |
| None | 48.0% | 73.3% | 0 |
| Class outlines | 51.3% | 75.3% | 919 |
| Outlines and similar code (what the editor sends) | 59.7% | 78.7% | 1,611 |
| Twice the budget for outlines and similar code | 59.7% | 78.3% | 2,441 |

A wider context adds tokens, and so time, without better suggestions, so the
budget stays. Run the benchmark again after changing the context, the
request, or the model.

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

Formatting doesn't go through a language server; see the next section.

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

Blade has its own Monaco language (`blade`), so PHP-only servers skip it. Its
grammar starts from Monaco's PHP grammar, which already handles HTML, `<script>`,
and `<style>`, and adds Blade states in front of it:

| State | Holds | Ends at |
| --- | --- | --- |
| `bladeEcho` | PHP in `{{ }}` and `{!! !!}` | `}}` or `!!}` |
| `bladeArgs` | PHP in a directive's parentheses, nested | the matching `)` |
| `bladePhp` | PHP between `@php` and `@endphp` | `@endphp` |
| `bladeTag` | A tag's attributes, with Blade in them | `>` or `/>` |
| `bladeBound` | PHP in a bound attribute, such as `:title="…"` | `"` |

The PHP inside uses the PHP grammar's own `phpRoot` rules. Monarch reads `@name`
in a regex as a reference to a grammar attribute, so the regexes spell the at
sign `[@]` before `php` and `endphp`. Tag names allow `-`, `.`, and `:` for
components, except `script` and `style`, which keep the PHP grammar's
embedded JavaScript and CSS.

Laravel LSP answers definitions and completions for component tags with the
component's view. A definition provider in `main.ts` adds the class of a
class-based component, from `componentClassPath` in `src/phptypes.ts`.

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
| Find in files | `search_text` in `search.rs`, shown in the Find view (`src/search.ts`) |
| Search everywhere | Classes, files, and actions together |

`search.rs` uses ripgrep's crates (`ignore` and `grep`). Both commands respect
`.gitignore` files, even outside a git repository, so `vendor` and
`node_modules` are skipped in Laravel projects. Both are `async`, so Tauri runs
them off the main thread.

### Find and replace in files

A `Query` holds the text and three options: case-sensitive, whole word, and
regex. `Query::pattern` builds one regular expression from it (the text is
escaped unless it's a regex, and whole words wrap it in `\b`). Search compiles
that pattern with `grep`'s matcher, and `replace_text` compiles the same
pattern with the `regex` crate, which uses the same syntax. So the matches the
Find view shows are exactly the text that Replace changes.

`search_text` returns one result per occurrence, up to 20,000, with start and
end columns in UTF-16 code units, which are also JavaScript string indexes. The
include field becomes `ignore` overrides, so `*.php` limits the walk to PHP
files.

`replace_text` takes a file's text and returns the new text and a count. In
regex mode, the replacement can use `$1` and `${name}`; otherwise it's literal
(`NoExpand`), so a `$` in the replacement stays a `$`. The Find view reads open
files from their Monaco models, so unsaved text is included. It applies the
result with `pushEditOperations`, which you can undo, and saves the file. Other
files are read and rewritten on disk.

Go to class hides symbols inside the bundled `phpactor.phar`, because Phpactor
also indexes the PHP stubs it ships and those files can't be opened.


Results stop at 20,000 matches (`MAX_MATCHES` in `search.rs`). To keep the
sidebar fast, files render their matches only when expanded, and they start
expanded while the total stays under 2,000 rows. Replace All asks
`files_matching` for every file with a match, with no limit, so it doesn't
depend on what's listed. A single match is replaced by running its text through
`replace_text`, so regex groups behave as in Replace All, after checking that
the file still holds the match where the search found it.

`list_files` takes `all`, which turns off `.gitignore` for Go to File's second
press.
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

`src/phptests.ts` finds tests with regexes over the whole source, so a
declaration can span several lines: public `test*` methods, methods after
`#[Test]` or `@test`, and Pest `it()` and `test()` calls. Each test gets a
`--filter` value that matches its name at the end, with an optional data set
suffix, so `test_a` doesn't also run `test_a_twice`. PHPUnit filters are
`::method`. Pest matches `Class::description`, where `describe()` blocks come
first as `` `group` → ``, so Pest filters are `::(?:.* → )?description`. The module has no editor imports, so `src/phptests.test.ts` runs
under Node.

`src/runner.ts` registers a Monaco code lens provider for files under `tests/`
or named `*Test.php`, and runs tests and commands in terminal tabs through
`openTerminal`. It remembers the last run for ⌃R.

Run Anything loads `php artisan list --format=json` once per project through
the `run_capture` command, and ranks command names against the first word you
type. The rest of the line becomes the command's arguments. Commands run
through `/bin/sh -c`, so quoting and pipes work.

### Test results

Every test run adds `--log-junit <app cache>/junit.xml`, which PHPUnit, Pest,
and `php artisan test` all accept. The report is deleted before the run, so a
run that fails to start doesn't show old results. `openTerminal` takes an
`onExit` callback, and when the process ends, `src/testresults.ts` reads the
report and shows the **Tests** tab.

For progress during the run, the command also gets `--log-events-text`, which
PHPUnit 10 and later write as events happen (`Test Prepared`, `Test Passed`,
and so on). The runner checks for `vendor/phpunit/phpunit/src/Event`, which
PHPUnit 10 added, since older versions reject the option. Every 500 ms,
`showLive` reads the file and redraws the tree with `parseEvents`. The events
name classes, not files, so a row opens the file the class name maps to
(`classFile`) and finds the test in it with `findTests`. When the
process exits, the JUnit report replaces the live tree. If there's no report,
for example because the run crashed, the live tree stays with its last state.

`src/junit.ts` parses the report with regexes, since the report has a fixed
shape and Node, which runs the tests, has no XML parser. The reports differ:

| | PHPUnit | Pest |
| --- | --- | --- |
| `file` | Absolute path | `tests/X.php::name`, or a label such as `Scratch (Tests\Unit\Scratch)::Fails` for PHPUnit-style classes |
| `line` | The test's line | Missing |
| Test name | Method name | Description, with `describe()` blocks as `` `group` → ``, or a readable label (`Fails` for `test_fails`) |
| Failure message | Starts with `Class::name` on its own line | Starts with the name, without a line break |

The parser strips the name from the message and takes the failure's line from
the last `file.php:line` in the message that points to the test file. When the
report has no real path, the file comes from that location or from the class
name, assuming Laravel's `Tests\` to `tests/` mapping. For a test without a
line, the tab finds the declaration with `findTests`, comparing names without
case, punctuation, or a `test` prefix (`sameTest`).

**Rerun failed tests** passes a `--filter` built from the failed names. For
PHPUnit, it's `::(names)( with data set .*)?$`. For Pest, it's one alternative
per class: `Class::(?:test_?)?(?:names)( with data set .*)?$`, with the full
reported name, `describe()` blocks included. Pest matches a filter,
case-insensitively, against method names for PHPUnit-style classes and against
descriptions for Pest tests, so each name's words are joined with `[_ ]?` and
an optional `test` prefix is allowed, to match both. The class and the `$`
anchor keep a failed `it works` from also running `it works fast`. The filter never
starts with `(`: PHP would read the parentheses as regex delimiters, and the
match would become case-sensitive.

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

### Partial staging

**Stage Selected** in a diff writes a new index version of the file instead of
building a patch for `git apply`. `applyBlocks` in `src/gitparse.ts` takes the
diff's original text and copies in the change blocks that the selection
touches, using the blocks that Monaco's diff editor computed
(`getLineChanges`). To stage, the original is the index version and the blocks
come from the working tree. To unstage, the staged text gets HEAD's lines back
(`mirror` turns the blocks around). The result goes in with
`git hash-object -w --stdin --path=<file>` and
`git update-index --cacheinfo <mode>,<hash>,<file>`, keeping the file's mode.

The selection counts on the side you last clicked, so you can select deleted
lines on the left.

With a text selection, `applyLines` stages single lines instead of whole
blocks. Within a block, `pairLines` pairs old and new lines in order by
similarity (the Dice coefficient of character pairs, at least 0.4, found with a
small dynamic program), and pairs any lines left between two matches by
position. A selected pair takes the new line; an old line with no pair is
removed only if selected, and a new line with no pair is added only if
selected. So in `welcome` → (`$x = 1;`, `home`), selecting `home` stages the
replacement without the added line.

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

### History

`src/history.ts` shows the log in place of the editor, like the diff view. It
reads `git log` in pages of 300 with a format of unit-separated fields
(`LOG_FORMAT`), parsed by `parseLog`. File history adds `--follow` to track
renames; `--follow` accepts only one file, so a folder's history runs without
it.

A commit's changed files come from `git diff-tree -r -M --name-status -z`
against its first parent, so a merge commit shows what the merge brought into
the branch. The first commit uses `--root`. A file's diff compares it at the
parent (using the old path for a rename) with it at the commit.

A diff opened from the history view returns there when it closes: `showDiff`
takes a function to run on close.

### Local history

`src/localhistory.ts` writes each saved file to
`<app data>/history/<project path>/<encoded relative path>/<milliseconds>.txt`.
A save that matches the newest version adds nothing. After each write,
`toPrune` in `src/retention.ts` picks the versions to delete: older than 14
days, or beyond the newest 100. Pruning a file's own folder on save keeps the
cost small, with no sweep over the whole history.

Viewing a version reuses the git diff view. `showDiff` takes an optional header
action, which **Stage Selected** also uses.

Two more moments add a version. When the file watcher reports that an open,
unmodified file changed on disk, the editor records the model's text before
reloading it. Deleting from the tree records the file, or each file in the
folder that `list_files` returns (ignored files left out, at most 500), before
moving it to the Trash. Only open files are covered for outside changes: the
editor has no earlier copy of the others to keep.

A deleted file's history stays in its folder. **Deleted Files** lists the
history folders whose project path no longer exists, and restoring creates the
missing parent folders.

### Interactive rebase

`src/rebase.ts` runs git's own `rebase -i` rather than replaying commits
itself, so conflicts, `--continue`, and `--abort` behave as in a terminal. The
dialog writes a todo list (`rebaseTodo` in `src/gitparse.ts`) to the app cache,
and `GIT_SEQUENCE_EDITOR='cp <todo>'` puts it in place of git's list. A reword
becomes `pick` plus `exec git commit --amend --file=<message>`, and
`GIT_EDITOR=true` keeps squash's combined message, so no editor ever opens.
`--autostash` sets aside uncommitted changes. Ranges that contain merge
commits are refused, since a plain `rebase -i` would flatten them.

An `edit` step stops the rebase with the commit applied. git then writes
`rebase-merge/amend` with the commit's hash, which `detectOperation` reads to
tell an edit stop from a conflict. git refuses `--continue` while changes are
staged at an edit stop, so **Continue** there first runs
`git commit --amend --no-edit` when `git diff --cached --quiet` finds staged
changes.

### Stash

Stash actions use the palette. **Stash Changes…** runs `git stash push`, with
`--include-untracked` as a second choice. **Stashes…** reads `git stash list`
and offers apply, pop, drop, and show files for the chosen stash. A stashed
file's diff compares the stash's first parent (the commit it was made on) with
the stash; untracked files come from the stash's third parent.

### Merge conflicts

`isConflict` in `gitparse.ts` recognizes the status pairs git uses for
unmerged files (`UU`, `AA`, `DD`, `AU`, `UA`, `DU`, `UD`). The commit view
lists those files on their own and leaves them out of staged and unstaged
changes.

`detectOperation` finds the operation in progress from git's state files in
the git folder (`git rev-parse --absolute-git-dir`): `rebase-merge` or
`rebase-apply`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, and `REVERT_HEAD`. **Abort**
runs `git <operation> --abort`. **Continue** runs `git <operation> --continue`
in a terminal with `GIT_EDITOR=true`, so git keeps its prepared message instead
of opening an editor. A merge finishes with a normal commit, and the message
box is prefilled from `MERGE_MSG`.

Accepting one side for a whole file runs `git checkout --ours` or `--theirs`,
then `git add`. If that side deleted the file, it runs `git rm` instead.

`src/conflicts.ts` handles conflicts inside a file. `parseConflicts` finds
blocks between `<<<<<<<` and `>>>>>>>`, including the base section that
`diff3` and `zdiff3` styles add. A code lens provider for every language adds
the three choices above each block, and decorations shade each side. A choice
replaces the whole block with an undoable edit. After a save, `afterSave` in
`git.ts` stages a conflicted file if it has no conflict blocks left.


The three-pane merge tool (`src/merge.ts`) reads the base, your side, and
their side from the index stages (`git show :1:`, `:2:`, and `:3:`). The side
panes get read-only models, highlighted with `lineChanges` against the base.
The middle pane uses the file's own model, so the inline links and conflict
colors from `conflicts.ts` work unchanged, and an open tab of the file shows the
same edits. **Mark Resolved** writes the model and runs `git add`. Saving a resolved file
that's open in a tab also runs `git add`, so `change` in `git.ts` runs
state-changing commands one at a time; two at once fail on git's `index.lock`. The panes are padded so that lines all three versions share sit side by side.
`alignmentGaps` in `src/gitparse.ts` finds anchors: result lines that match a
line in both sides, where lines that occur exactly once in both texts, in the
same order, match (`lineAnchors`, the idea behind patience diff). Between two
anchors, each pane has some number of lines; the shorter panes get a striped
view zone for the difference. Every pane is then the same height, so scrolling
copies one position to the others, with `ScrollType.Immediate` (a smooth scroll
fires its events after the `syncing` guard is released and would scroll the
panes back). The zones are recomputed 150 ms after the result changes.

The result pane turns off CodeLens and draws its own **Accept** buttons as
one-line view zones above each conflict, because a CodeLens takes height the
alignment can't count. Monaco draws its text layer above view zones, so a click
never reaches the buttons; `onMouseDown` reports a view-zone target with its
id, and the button under the pointer is found by position.
### Branches

The branch picker reads `git for-each-ref` with full ref names, which tell
local branches (`refs/heads/`) from remote ones (`refs/remotes/`) even when a
local name contains a slash. Checking out a remote branch runs
`git checkout --track`.

### Pull requests

Descriptions and comments are Markdown from other people, and the webview can
call the app's commands, such as `run_capture`, so rendered HTML is a way to
run commands on your Mac. `marked` renders them, and DOMPurify removes scripts,
event handlers, `javascript:` links, iframes, forms, and inline styles. Links
open in the browser through `open`, never in the webview.

Comments, reviews, and merges are `gh pr comment`, `gh pr review --approve` or
`--request-changes`, and `gh pr merge` with `--merge`, `--squash`, or
`--rebase`. A merge always asks for confirmation first, in the palette, because
it changes the repository on GitHub.

`gh pr view` has no line comments, so they come from
`gh api repos/{owner}/{repo}/pulls/<n>/comments`, with `--jq` printing one
object per line (`--paginate` would otherwise print one JSON array per page).
GitHub points every reply at the thread's first comment (`in_reply_to_id`),
which groups them into threads. A comment whose `line` is null is outdated:
the code it was on changed, so it shows in the conversation only.

In the diff, each thread is a view zone under its line, on the old side for
`side: LEFT` and the new side for `RIGHT`. A view zone needs its height when
it's added, so the thread is rendered into the page at the editor's visible
width, measured, and then moved into the zone. The diff is laid out first,
because it was hidden until then and has no width. Monaco stretches a zone to
the width of the longest line, so the thread keeps its own width inside it.
Clicks don't reach view zones, which is why threads are read-only.

**Comment on Line** uses `diffCursor()` from `git.ts`, the side and line you
last clicked. A new comment is a POST to the same endpoint with `commit_id`
(the head commit, `headRefOid`), `path`, `line`, and `side`; a reply is a POST
to `comments/<id>/replies`. Both post at once, without a pending review.

`markdown()` turns `#123` and `@name` in text into links after sanitizing,
walking the text nodes and skipping links and code, so a reference inside a
URL or code sample stays as it is.

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
| `panes`, `focused` | Each pane's file, left to right, and the focused pane |
| `shells`, `panel` | How many plain shells were open, and whether the panel showed |

The editor saves 500 ms after a change (tabs, cursor, scroll, folders, or
sidebar view), when the page unloads or the window loses focus, and before it
opens another folder. When it opens a folder, it expands the saved folders,
reopens the tabs, skips files that no longer exist, splits the panes again,
and opens the shells as new shells in the project folder. Terminal tabs that
ran a command, such as a test run or `artisan serve`, aren't restored, since
running a command again on its own can surprise you.

## Tailwind CSS (frontend step 1)

The client starts the Tailwind CSS language server with `node` when the
project's `package.json` mentions `tailwindcss`, for the `blade`, `php`,
`html`, `css`, `javascript`, `typescript`, and `vue` languages.

The server asks for its settings with `workspace/configuration` (the `editor`
and `tailwindCSS` sections). `startServer` accepts a settings object and
answers each request by section. `tailwindSettings` in `lsp.ts` sets:

- `experimental.classRegex` patterns for `'class' => '…'` in PHP arrays
  (Filament's `extraAttributes`) and for Blade's `@class([...])`.
- `files.exclude` for `.git`, `node_modules`, `vendor`, `storage`, and hidden
  folders, so git worktrees in `.claude/` aren't scanned.
- The defaults for lint rules, hovers, and color decorators.

Two client features were added for it, and any server can use them:

- **`completionItem/resolve`.** Tailwind sends a class's CSS only for the
  selected suggestion. The client keeps each server item in a `WeakMap` keyed by
  the Monaco suggestion and resolves it when Monaco asks.
- **`textDocument/documentColor`** and **`textDocument/colorPresentation`**,
  mapped to a Monaco color provider, which draws swatches and a color picker.

## Formatting (frontend step 2)

`src/format.ts` registers one formatting provider for PHP, Blade, JavaScript,
TypeScript, CSS, SCSS, Less, JSON, HTML, Markdown, YAML, and Vue. It pipes the
file's text through a formatter with `run_capture` in the project folder, so
each formatter finds the project's configuration:

1. Prettier (`node node_modules/prettier/bin/prettier.cjs --stdin-filepath`),
   when the project has it. If Prettier reports that no parser could be inferred
   for the file, the next step runs.
2. For PHP, Laravel Pint (`vendor/bin/pint - --stdin-filename`), when the
   project has it.
3. For PHP, the bundled Mago (`mago format --stdin-input`).

`detectFormatters` looks for Prettier and Pint when a folder opens. When a
project has Prettier, it turns off Monaco's own formatters for CSS, HTML, JSON,
and TypeScript (`setModeConfiguration`), which would otherwise compete for those
languages. Monaco turns each whole-file result into minimal edits, so the cursor
and undo history stay useful.

## JavaScript, TypeScript, and Vue (frontend step 3)

The TypeScript server is vtsls, which wraps TypeScript's `tsserver` and supports
`tsserver` plugins. Vue's language server works in "hybrid" mode: it handles
templates and styles, and relies on a TypeScript server with
`@vue/typescript-plugin` for everything TypeScript knows. The pieces connect
like this:

- vtsls serves `javascript`, `typescript`, and `vue`. Its settings (answered
  through `workspace/configuration`) load `@vue/typescript-plugin` from the
  bundled `tools/node` folder as a global plugin.
- The Vue server gets the bundled TypeScript's `lib` folder as `tsdk`. When it
  needs TypeScript information, it sends a `tsserver/request` notification. The
  client forwards each one to vtsls as the `typescript.tsserverRequest` command
  and sends the result back as `tsserver/response`. `startServer` takes an
  `onNotification` function for server-specific notifications like these.

Both start lazily (`startFrontendServersLazily`): vtsls with the first
JavaScript, TypeScript, or Vue model, and the Vue server with the first Vue
model. While vtsls runs, Monaco's built-in TypeScript features are turned off,
so completions and diagnostics don't appear twice. Formatting stays with
`format.ts`: the client doesn't register formatting providers from language
servers.

Monaco has no Vue grammar. `editor.ts` registers `vue` for `.vue` files with
Monaco's HTML grammar, which highlights `<script>` as JavaScript and `<style>`
as CSS.


### Component file grammars

Vue, Svelte, and Astro share `componentGrammar` in `editor.ts`: Monaco's HTML
grammar, which already embeds JavaScript in `<script>` and CSS in `<style>`,
with two rules in front. `lang="ts"` switches to the grammar's
`scriptWithCustomType` state with `typescript`, and `lang="scss"` or `"less"`
to `styleWithCustomType`, the states the grammar uses for `type="…"`. Astro
adds a `frontmatter` state for the `---` fence, embedding TypeScript; the
closing fence uses `switchTo`, not `next`, so popping it returns to the root
state.
## Debugging

The debugger is the Xdebug adapter from VS Code's PHP Debug extension. It
speaks the Debug Adapter Protocol (DAP), which frames messages like LSP, so the
Rust bridge runs it as the `xdebug` "server", and `lsp_stop` ends it.
`src/debug.ts` is a small DAP client:

1. `startDebugging` starts the adapter and sends `initialize`, then `launch`
   with port 9003. The adapter listens for Xdebug connections.
2. On the adapter's `initialized` event, the client sends every breakpoint
   (`setBreakpoints` per file), no exception filters, and `configurationDone`.
3. On a `stopped` event, it reads the `stackTrace`, opens the top frame's file
   at its line, marks the line, and loads the frame's `scopes`. Variables load
   one level at a time, when you expand them.
4. Stepping sends `continue`, `next`, `stepIn`, or `stepOut` for the stopped
   thread. `evaluate` runs in the selected frame.

Debugging starts processes with `XDEBUG_MODE=debug` and `XDEBUG_SESSION=1`, so
Xdebug connects without a `php.ini` change. `php artisan serve` passes both
variables to the PHP server it starts.

Breakpoints are model decorations with a glyph in the gutter, so they show in
every pane and move with the lines as you edit. The line numbers are saved per
project in `localStorage`.

Each breakpoint has options named as in the Debug Adapter Protocol:
`condition`, `hitCondition`, and `logMessage`, all optional. The decorations
map each decoration id to its options, so they move with the line as you edit.
Saved breakpoints are `[line, options]` pairs; the older formats, line numbers
and `[line, condition]` pairs, still load. `setBreakpoints` sends only the
options that are set. The adapter prints log messages as `output` events,
which the Debug tab already shows.

Watches are a list of expressions per project in `localStorage`. After a frame
is selected, each one goes to `evaluate` with the `watch` context, and the
result renders with the same row as a variable, so objects expand.

Pause on exceptions sends exception filters. The adapter makes each filter an
Xdebug exception breakpoint on that class name, whatever the name (its own
filter list, such as `Notice`, is only what it suggests), and Xdebug also
matches subclasses. Without chosen classes the filters are `Exception` and
`Error`, which cover every `Throwable`. Turning it on or off is app-wide; the
classes are per project, both in `localStorage`.

Changing a variable sends `setVariable` with the reference of the scope or
value that holds it. The adapter sets it through Xdebug's `property_set`, which
evaluates the text as PHP, and replies with the text as typed, so the row
reloads its parent's variables to show the value as PHP sees it.

Path mappings go in the `launch` request as `pathMappings`, from server paths
to local ones. The adapter translates breakpoint paths and stack frames, so the
rest of the client sees local paths only. The mappings are saved per project in
`localStorage` as typed (`/var/www/html, /opt/shared=packages/shared`), and
`parseMappings` reads them: an entry without `=` maps to the project folder,
and a relative local path is inside it. Without any, a `docker-compose.yml`
that mentions Laravel Sail maps `/var/www/html`.

`src/sail.ts` decides where commands run. A project uses Sail when
`vendor/bin/sail` exists and a compose file mentions Sail's images, and Sail is
running when `docker compose ps --status running --quiet` prints anything. It
checks on every run, so starting or stopping the containers takes effect at
once. In Sail, test runs write the JUnit report to
`storage/logs/editor-junit.xml`, which the container can write and git
ignores, and the Tests tab maps `/var/www/html` in reported paths back to the
project.

The Debug tab lives in the bottom panel: `showPanelView` in `terminal.ts` lets
any element be a panel tab next to the terminals.

## Database

`src-tauri/src/db.rs` has one command, `db_query`, which runs one statement and
returns column names, rows, and the number of changed rows. Every value comes
back as text or null, which is all the grid needs, so no driver's type mapping
leaks into the frontend:

| Driver | Crate | How values become text |
| --- | --- | --- |
| SQLite | `rusqlite` with its bundled SQLite | Each `ValueRef` is formatted. Blobs show their size. |
| MySQL, MariaDB | `mysql`, without TLS | The text protocol (`query_iter`) returns every value as bytes. |
| PostgreSQL | `postgres`, without TLS | The simple query protocol returns every value as text. |

Each query opens a new connection, and results stop at 1,000 rows. The query
runs on a blocking thread, so a slow server doesn't stall the app.

`src/dbconfig.ts` reads `.env` and fills in Laravel's defaults from
`config/database.php`. It also holds the schema queries: `sqlite_master` and
`pragma_table_info` for SQLite, and `information_schema` for the others. It's
free of editor imports, so Node tests it.

The query console is `console.sql` in the app's data folder, in a folder named
after the project path, so it never shows up in the project's git status. It
opens as a normal tab, so saving and session restore work unchanged. **Execute
Query** is a Monaco action bound to ⌘⏎ when the editor's language is SQL.
SQL completion loads every table's columns in one query (`schemaQuery`) and
keeps them until the connection reloads or a statement returns no rows, which
may have changed the schema. An alias is found with a pattern (`posts p`,
`posts as p`) anywhere in the file.

Cell edits apply at once, one `UPDATE` per cell, with every value as a string
literal that the database converts to the column's type. The row is found by
its primary key (`primaryKeyQuery`), using the values shown in the grid. If
the update doesn't change exactly one row, the editor reports it and keeps the
old value. There's no batch of pending edits to submit, as PhpStorm has.
**Add Row** runs one `INSERT` with only the columns you filled in, so the rest
get their defaults (`DEFAULT VALUES`, or `() VALUES ()` on MySQL, when none
are filled in). **Delete Rows** runs one `DELETE` per selected row, by primary
key, after a confirmation in the palette. Both run the grid's query again to
show the result.
`statementAt` finds the statement around the caret by splitting on semicolons,
and skips statements that are only comments. Results use `showPanelView`, like
the debugger.

## Interface

### Layout

`index.html` lays out a title bar, a workbench (the tool bar, the sidebar, and
the editor area), and a status bar. The window has no native title bar
(`titleBarStyle: "Overlay"` in `tauri.conf.json`): macOS draws its window
buttons over the left edge of `#titlebar`, which starts its content 80 px in.
Empty parts of the title bar carry `data-tauri-drag-region`, so dragging them
moves the window; that needs the `core:window:allow-start-dragging` permission.

### Styles and themes

`styles.css` defines colors, sizes, and fonts as variables on `:root`, with a
light set under `data-theme="light"`. Components use only the variables, so a
theme is one block of values. `src/themes.ts` defines matching Monaco themes,
`editor-dark` and `editor-light`, with syntax colors close to PhpStorm's schemes.

Icons come from Monaco's icon font (codicons), which the page already loads, so
there's no icon dependency. Monaco's `.codicon[class*='codicon-']` rule sets
the icon size with high specificity, so the stylesheet uses `!important` where
it changes a size. `src/icons.ts` maps file and folder names to a codicon and a
color class; `src/icons.test.ts` covers it. Folders such as `vendor`,
`node_modules`, and `storage` are dimmed, as PhpStorm marks excluded folders.

### Status and errors

The status bar shows the latest message from each source. Language server
progress uses a `<server>:progress` source, which shows a spinner and appears
only after the task has run for 800 ms, so short tasks such as resolving code
actions don't flash. Other messages clear themselves after 8 seconds. Messages
that report a failure (they contain words such as "failed", "error", or
"fatal") also appear as a toast.

Diagnostics for files inside `vendor` and `node_modules` are dropped
(`setMarkers` in `lsp.ts`). Those files open for go to definition and peeks, and
Phpactor and Mago analyze library code as strictly as your own, which filled the
counts with problems you can't fix. The counts cover open tabs and update when
markers or tabs change.

### Palette

`matchPositions` in `palette.ts` finds the letters to highlight: the query as
one block where it appears whole (its last occurrence, which is usually in the
file name), or else the letters of a fuzzy match. The folder part of a path is
dimmed.

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

### 2026-09-24: Ask questions in the palette

`window.confirm` is unreliable in WKWebView. The dialog plugin's native dialogs
replaced it at first, but one that's open when the page reloads (as it does on
every hot reload in development) stays on screen and can't be answered, even
with Escape. Every question now goes through `choose` and `confirm` in
`src/palette.ts`, which list the answers in the palette; Escape, or opening
another palette, counts as no answer. This covers deletes, discards, merges,
stash drops, Replace All, unsaved changes when closing a tab, and questions
from language servers (`window/showMessageRequest`), which now also show every
action a server offers rather than at most three. The dialog plugin remains
for choosing a folder.

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

PhpStorm deletes permanently but keeps a local history. This editor moves files
to the Trash and also keeps a local history version of each deleted file. Discarding an untracked file in the
commit view also moves it to the Trash.

### 2026-09-24: Rename prompts in the palette

Rename, new file, and new folder reuse the palette as a text prompt, with the
file name preselected up to its extension. Inline editing in the tree would need
its own input handling for little gain.

### 2026-09-24: Sessions in localStorage

A session is a convenience: if it's lost, you reopen a few tabs. `localStorage`
survives app restarts and needs no Rust command or file format. Terminal tabs
aren't saved, because their processes can't be restored.

### 2026-09-24: Node-based servers use the system Node

Bundling a Node runtime would add about 100 MB per architecture. Laravel
projects that use Vite already need Node, so the editor runs the bundled
JavaScript servers with the `node` on your `PATH`, as it does with `php`.

### 2026-09-24: Format with the project's tools

Projects choose their formatter, often in `lint-staged` or CI. Formatting with a
different tool than the project uses creates noisy diffs. The editor prefers
Prettier and Pint from the project, and uses Mago only when neither is there.

### 2026-09-24: vtsls with TypeScript 5.9, not TypeScript 7

TypeScript 7 is a native rewrite with its own language server (`tsc --lsp`),
and it's much faster. But it can't load `tsserver` plugins, and Vue's language
server depends on `@vue/typescript-plugin`. vtsls with TypeScript 5.9 serves
JavaScript, TypeScript, and Vue with one server. Revisit this when Vue's tooling
supports TypeScript 7.

### 2026-09-24: The PHP Debug adapter instead of a DBGp client

Xdebug speaks DBGp, an XML protocol over TCP. The PHP Debug adapter already
turns DBGp into the Debug Adapter Protocol and handles its details (connection
per request, property paging, evaluation). It runs over the same bridge as the
language servers.

### 2026-09-24: A PhpStorm-like interface

You come from PhpStorm, so the interface follows its new UI: a tool bar with
icons instead of text tabs, a title bar with the project and branch, file icons,
and syntax colors close to its schemes. The window's own title bar is hidden,
so the app's title bar can use that space.

### 2026-09-24: MCP bridge in debug builds only

`tauri-plugin-mcp-bridge` lets automated tools drive the app for testing. It
can run JavaScript in the webview, so it's compiled only into debug builds and
listens only on `127.0.0.1`.

### 2026-09-24: Database drivers compiled in

The editor must work on any Mac without global installs, so it can't rely on
the `mysql`, `psql`, or `sqlite3` clients. Laravel's own `php artisan db`
needs those clients too. Three small synchronous driver crates add a few
megabytes to the app. `sqlx` would cover all three, but it needs a Rust type per
column, and the grid only needs text.

### 2026-09-24: Phpactor diagnostics in the server process

Phpactor's separate diagnostics process ignores settings sent by the client,
including the index path. Passing them through the XDG config folder would
hide your own global Phpactor config, and writing `.phpactor.json` would change
the project. Running diagnostics in the server process can delay other
requests while a large file is checked, which is the cost.

### 2026-09-24: Sanitize Markdown with DOMPurify

Rendering Markdown needs a parser and an HTML sanitizer. A hand-written
sanitizer is a security boundary that's easy to get wrong, and DOMPurify is the
widely reviewed one, so the editor takes two small dependencies instead.

### 2026-09-24: typos instead of a dictionary spell checker

A dictionary checker such as Hunspell flags every identifier, abbreviation,
and package name in code unless it has large custom word lists. `typos` looks
only for known misspellings, which fits code with few false positives. The
cost is that a rare misspelling that isn't on its list goes unnoticed.
