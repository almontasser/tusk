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
| `watch` | Watches a folder recursively and emits `fs-change` with the changed paths, gathered for 50 ms and without duplicates. |
| `paths_exist` | Whether each of a batch of paths exists, in one call. |

### File tree

The tree loads each folder only when you expand it, so large folders such as
`vendor` and `node_modules` cost nothing until opened. The frontend keeps a map
from each rendered folder to its list element. When `fs-change` arrives, it
re-lists only the parent folders of the changed paths, and redraws one only if
its entries changed (`listings`), so saving a file redraws nothing.

### Tabs and models

Each open file is one Monaco model with a `file://` URI. Monaco picks the
language from the file extension. Language servers identify documents by the
same URI, so milestone 2 needs no path translation.

A tab is dirty when the model's alternative version ID differs from the ID
recorded at the last save. Undoing back to the saved text clears the dirty mark.

### Split panes

`main.ts` keeps a list of panes. Each pane has its own Monaco editor, tab bar,
and list of tabs (`Pane.paths`). `tabs` holds one model per open file, shared by
every pane that shows it, so an edit in one pane shows in the other at once.
`editor` and `active` always refer to the focused pane, so actions, the opener,
and saving work on whichever pane you're in. Other panes remember their file in
`Pane.active`. `addPane` sets up everything an editor needs: settings
(`addEditor`), git markers and blame (`trackEditor`), conflict shading
(`decorateConflicts`), session saving, and focus tracking.

The layout is the DOM itself. `#editor` is a `.split.row`; splitting a pane in
the direction of its group adds a sibling, and splitting across it wraps the
pane in a new `.split.row` or `.split.col` group. When a pane closes, a group
left with one child is replaced by that child. The session stores the tree
(`layoutOf`) and `buildLayout` rebuilds it. Older sessions without a layout open
every tab in one pane.

Closing a tab removes it from that pane only; the file closes, saving first,
when no other pane has it (`closeFile`). Renames and deletions go through
`retarget`, which updates every pane's tabs and shows another tab where the
current one went away. A pane left with no tabs closes, and Unsplit moves a
pane's tabs to the pane beside it.

Tabs drag with HTML drag and drop (`placeTab`). This needs `dragDropEnabled:
false` in `tauri.conf.json`: with Tauri's native file-drop handling on, the
webview gets `dragstart` and `dragend` but never `dragover` or `drop`, so
nothing can be dropped. The app doesn't use Tauri's file-drop events. A drop within the outer quarter
of a pane's editor, measured to the nearest edge, splits that pane there
(`splitPane`, which can put the new pane before or after), unless the tab is
its own pane's only tab or four panes are open. The `#editor` listeners run in
the capture phase, so Monaco never sees a tab dropped on its text as text to
insert. Borders between panes have no element of their own, which would have
to be skipped everywhere the layout reads a group's children: `sashAt` treats
a press within 4 pixels of a pane's or group's edge, next to a sibling, as a
resize. When a resize starts, each sibling's `flex-grow` becomes its size in
pixels (all measured before any is set, since each change reflows the rest),
and the two sides of the border trade pixels. Sizes go into the session as
`grow`. A new split takes half of the pane's `flex-grow`, and a new group takes
over the pane's.

### Markdown preview

`markdownpreview.ts` shows a Markdown model's preview as an editor view
(`showEditorView`), one per file. `markdown.ts` renders it with `marked`,
parsing each top-level block on its own inside a `<div data-line>` that holds
the block's first line, with the document's link definitions passed along.
DOMPurify sanitizes the HTML into a fragment, where relative image paths are
swapped for blob URLs of the file's bytes (`read_file_bytes`, a
`tauri::ipc::Response`, so no base64) before the fragment joins the page. The
preview renders again 150 ms after you stop typing. Every Monaco editor gets a
scroll listener once (`onDidCreateEditor`), and the preview for the editor's
model scrolls to the block at its top line, interpolating toward the next
block (`previewScrollTop`). The sync runs one way, editor to preview.

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

`apply` updates Monaco's editor options and calls `applyTheme` in
`src/themes.ts` with the theme in use: `theme`, or `darkTheme` or `lightTheme`
when `theme` is `system`, which follows `prefers-color-scheme` as it changes.
Other modules react through `onSettings`. No editor is created with a `theme`
option, because that would reset Monaco's global theme.

`apply` also calls `setVim` in `src/vim.ts` for each editor, and
`removeEditor` turns Vim off before a pane's editor is disposed. `monaco-vim`
loads with a dynamic `import()` the first time Vim is on, as its own chunk.
Each editor gets a span in `#vim-status` for monaco-vim's status bar (the
mode and the `:` input), and only the last focused editor's span shows. With
Vim on, the global key handler passes ⌃ and a letter (and ⌃[) to the editor
when it has focus, so Vim's ⌃D, ⌃R, and ⌃V work. `vite.config.ts` aliases
`monaco-vim` to its ES module build, since the `browser` export is UMD, and
maps its `monaco-editor/esm/vs/...` imports to monaco-editor 0.56's export
paths.

### Color themes

`src/themes.ts` lists every theme (`themeList`) and applies one
(`applyTheme`). The built-in `dark` and `light` themes are Monaco themes
defined in the same file, and use the stylesheet's own variables. The others
come from three places, all converted by `src/colortheme.ts`:

- **tm-themes**: 65 VS Code themes as JSON. Its index gives each theme's name
  and type, so the list needs no theme files.
- **monaco-themes**: about 50 TextMate themes in Monaco's format, with
  TextMate scopes as token names. Themes that tm-themes also has are left
  out, and the light ones are listed by hand.
- **Imported themes**: JSON files in the `themes` folder of the app's config
  folder, read when settings load.

Theme files are loaded with `import.meta.glob`, so each is its own chunk that
loads when you first choose it. A converted theme is cached, and a newer choice
wins over one still loading, so previewing in the picker stays quick.

`convert` turns a theme into three things:

- **Monaco rules.** Monaco's grammars emit their own tokens (`keyword.php`,
  `variable.php`), not TextMate scopes, so a theme's scopes can't be used as
  they are. Each role (keyword, string, variable, type, and so on) has a list
  of TextMate scopes, most specific first, such as `keyword.control.php`, then
  `keyword`. `styleOf` finds the style TextMate would give that scope, and
  `rules` turns the colors by role into Monaco rules. The built-in themes use
  the same `rules`. VS Code colors (`editor.*`, `editorWidget.*`, and so on) have
  the same names in Monaco and pass through.
- **Interface variables.** Each CSS variable in `styles.css` comes from the
  VS Code colors that mean the same (`sideBar.background` for `--panel`,
  `list.activeSelectionBackground` for `--selected`), or is mixed from the
  editor's background and text when the theme doesn't set them, as TextMate
  themes never do. They're set on the root element's style, and `data-theme`
  follows the theme's type, for the light-only rules.
- **Terminal colors** from `terminal.*`, for xterm.js. The terminal listens
  with `onTheme`.

Importing reads a VS Code theme (JSON with comments), following `include` and
a `tokenColors` file path, or a TextMate plist. `parsePlist` is a small parser
for the plist subset themes use. The theme is saved in VS Code's format, so the
folder holds one format. `src/colortheme.test.ts` converts every bundled theme.

The picker (`pickTheme` in `src/settings.ts`) is the palette with a `preview`
on each item, which runs as the selection moves. Escape applies the saved
theme again.

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
Double taps are keys such as `Shift Shift`: `doubleTap` sees two presses of the
same modifier within 350 ms with no key between, for both the global handler
and the recorder, so any of ⇧, ⌃, ⌥, and ⌘ tapped twice can be assigned.

### Menu bar

`src/menu.ts` lists the menus as action labels, separators, and native items
(Undo, Copy, Hide, Quit), and builds them with Tauri's JavaScript menu API.
`main.ts` rebuilds the menu when `settings.keymap` changes, and the old menu is
closed. Inside a submenu, a label loses the submenu's prefix, so "HTTP Client:
Import…" reads "Import…". A label with no matching action logs an error and is
left out.

The web view gets a key before the menu does, and the menu gets it only when
the page doesn't call `preventDefault`. That's why ⌘W closes a tab and not the
window. An editor-only action, or one with `when`, passes keys on in some cases,
so the menu would run it anyway. Those items, and double taps such as ⇧⇧, get
no accelerator (`accelerator()`, tested in `menu.test.ts`).

### EditorConfig

`src/editorconfig.ts` parses `.editorconfig` files and turns their section
globs into regexes (`*`, `**`, `?`, `[...]`, `{a,b}`, and `{1..3}`). A glob
without a slash matches the file name in any folder. For a file, `main.ts`
reads the `.editorconfig` of each folder from the project root down, cached
per folder, and applies the sections in order, so closer files and later
sections win, and `root = true` ignores the files above. A new model gets
`insertSpaces`, `tabSize`, and `indentSize` from them. Saving converts line
endings to `end_of_line` (`pushEOL`), trims trailing whitespace, and fixes the
final newline, each as an undoable edit, before the text is written. A model
with no line breaks yet takes `end_of_line` when it opens (`setEOL`), and its
tab stays clean, since the text on disk is the same. Monaco has only LF and
CRLF, so CR lines convert outside it: `readText` turns a file with CR alone
(`isCrOnly`) into LF and remembers the path, and `writeText` turns the text
back into CR (`toCr`) when `end_of_line = cr`, or when there's no
`end_of_line` and the file was read with CR (`savesCr`). The status bar shows
CR for such a model.

`charset` goes to `read_file` and `write_file` in `fs.rs`, through
`readText` and `writeText` in `src/projectfiles.ts`, which every feature that
reads or writes a project file's text uses: saving, refactorings
(`applyWorkspaceEdit`), Replace in Files, local history restores, and reloads.
Rust decodes and encodes by hand: Latin-1 maps bytes to the first 256 code points, UTF-16 uses
`String::from_utf16_lossy` and `encode_utf16`, and a byte-order mark is
dropped on reading and written again on saving (`utf-8-bom`, and UTF-16, which
is written with one). UTF-16 is decoded strictly, like UTF-8: an odd number of
bytes or an unpaired surrogate fails to open rather than losing bytes on save. Text that Latin-1 can't hold fails to save with the
character named, and the tab stays unsaved. Without a `charset`, files are
read as strict UTF-8 and written back unchanged, so a UTF-8 file with a
byte-order mark keeps it.

`readText` calls `read_text`, which is `read_file` plus detection: without a
charset, a file that isn't valid UTF-8 gets UTF-16 from its byte-order mark,
or else chardetng's guess, and fails as binary if it has a NUL byte. A guess
that can't decode every byte falls back to Windows-1252, which decodes any
byte, so nothing is lost on save. `projectfiles.ts` remembers the detected
encoding by path and `writeText` passes it back; any encoding name that
`encoding_rs` knows is decoded strictly and encoded with an error for
characters it can't hold. **Change File Encoding…** (or a click on the status
bar item) sets an encoding for the path that wins over `.editorconfig` for the
rest of the session: Reopen reads the file again in it, and Convert and Save
marks the tab changed and saves. The model's charset only shows in the status bar;
the rest of the editor (git, search, language servers) sees text.

### External changes

The frontend batches `fs-change` events for 150 ms. For each changed file that
is open and has no unsaved edits, it reloads the file from disk. It never
overwrites unsaved edits.

## PHP intelligence (milestone 2)

### Downloaded tools

`scripts/fetch-tools.sh` downloads each language tool at a pinned version,
checks its SHA-256 checksum, and stores it in its own folder, such as
`mago/mago` or `node/node_modules`. `scripts/publish-tools.ts` runs it for each
chip, packs each tool as a `.tar.gz` (once for tools without native code),
and uploads the packages that changed to the `tools` GitHub release, a
prerelease so the app's updater never reads it. `tools.json` lists every
package with its chip, checksum, size, and ID, a hash of the tool's files, so
a tool that didn't change keeps its package. The list is signed with the
updater's key. After uploading it, the script deletes the packages it no
longer lists; a copy that read the old list just before fails that download
and tries again at its next check. To upgrade a tool, change its URL and checksum in the script,
then publish.

The app keeps the tools in its data folder
(`~/Library/Application Support/ly.almontasser.tusk/tools/`).
`tools_ensure` in `tools.rs` runs once per launch, before any tool runs: the
frontend's `ensureTools` and `toolPath` in `lsp.ts` wait for it, and the
language servers, formatter, Composer, Problems, refactorings, debugger, and AI
completion all go through them. It
checks the list's signature against the public key in `tauri.conf.json`,
downloads each package it needs for this chip, checks its SHA-256, and
unpacks it into `.part-<name>`, renamed to `.next-<name>` once complete. With a
tool missing, as on the first launch, it swaps each one in right away and the
tools wait, with progress in the status bar. Otherwise it returns at once and
checks in the background (`check_tools`, which release builds also run every
six hours); updates stay staged and are swapped in at the next
launch, before anything runs, so a running server never has its files
replaced. Each installed folder records its package's ID in `.tusk-id`. The
editor's `mago.toml` and the Filament server still ship inside the app, since
they're part of this repository.

Every tool gets new files, never files rewritten in place: macOS caches a
binary's code signature per file, and a binary rewritten after it ran fails its
check and is killed partway through a large run.

| Tool | Version | Form |
| --- | --- | --- |
| Phpactor | 2026.06.23.0 | PHP archive (`.phar`) |
| Laravel LSP | 0.0.32 | PHP archive (`.phar`) |
| Mago | 1.50.0 | Native binary for the build's target |
| Tailwind CSS language server | 0.16.0 | npm package, run with Node |
| vtsls (TypeScript) | 0.3.0, with TypeScript 5.9.3 | npm package, run with Node |
| Vue language server | 3.3.11 | npm package, run with Node |
| Svelte language server | 0.18.4 | npm package, run with Node |
| Astro language server | 2.17.1 | npm package, run with Node |
| Angular language server | 22.2.0, with TypeScript 6.0.3 | npm package, run with Node |
| Prettier, with its Svelte and Astro plugins | 3.9.9 | npm packages, run with Node |
| `blade-formatter` | 1.44.4 | npm package, run with Node |
| PHP Debug (Xdebug adapter) | 1.40.2 | The `.vsix` from `xdebug/vscode-php-debug`, run with Node |
| `llama-server` (llama.cpp) | b11165 | Native binary and its libraries, for AI completion |
| `typos-lsp` | 0.1.56 | Native binary for the build's target |

Native tools follow the build's target: `TAURI_ENV_TARGET_TRIPLE`, which Tauri
sets for `beforeBuildCommand`, or this Mac's architecture. For
`universal-apple-darwin` (or `--universal`), the script downloads both
architectures, unpacks each under the cache, and joins each file with `lipo`.
llama.cpp's Intel build has no `libggml-metal`, so that library stays Apple
silicon only; no Intel file links to it. Among the Node packages, only the
Astro compiler is native per architecture (`fsevents` is universal already,
and Tailwind's watcher ships every platform); npm installs it for this Mac, so
the other architecture's package is downloaded from the lockfile's URL and
checked against its integrity hash, and a single-architecture build removes one
it doesn't need.

Downloads are cached in `src-tauri/target/tool-cache/`, so a rebuild doesn't
download again.

Node-based servers are listed in `node-tools/package.json` with a committed
lockfile. The fetch script copies both into the `node/` folder and runs
`npm ci --omit=dev --ignore-scripts`, which checks every package against the
lockfile's integrity hashes and runs no install scripts. It reinstalls only when
the lockfile changes. To upgrade, change the version in `node-tools/package.json`
and run `npm install --package-lock-only` in that folder.

### Finding PHP

Apps opened from Finder get a minimal `PATH`. At startup, `lib.rs` runs your
login shell (`$SHELL -ilc`) once and adopts its `PATH`, so every tool the app
starts later (`php`, and in later milestones `git` and `gh`) resolves the same
way as in your terminal. It runs on a thread, because a shell with plugins can
take a second or more, and the window shouldn't wait for it. Commands that start
a program call `login_path()` first, which waits for that thread.

### Language server bridge

`src-tauri/src/lsp.rs` starts `php tools/phpactor.phar language-server` in the
project folder. A thread reads the server's `Content-Length` framed messages
from standard output and emits each one as an `lsp` event. The `lsp_send`
command queues a message for a writer thread, one per server, which writes it to
the server's standard input. A busy server stops reading, its pipe fills, and a
write then blocks until it reads again; with the write on the main thread, that
froze the whole window while Phpactor worked through a large file. Opening
another folder stops the old server.

The bridge doesn't parse messages. All protocol logic lives in `src/lsp.ts`.

### Phpactor's index

Phpactor's indexer ignores `.gitignore`. The client passes
`indexer.exclude_patterns` that add hidden folders, `node_modules`, `storage`,
and `bootstrap/cache` to Phpactor's defaults. On a project with three git
worktrees under `.claude/`, this cut the index from 125,859 files to about
26,700.

Phpactor keeps index entries for files that later become excluded, which
would list classes twice. The client sets its own `indexer.index_path` with a
version suffix (`%project_id%-editor-2`). When the patterns change, bump the
suffix, and every project gets a fresh index.

### Laravel magic in Mago's results

Mago's analyzer has no Laravel plugin (its plugins are `stdlib`, `psl`,
`flow-php`, and `psr-container`), and a stub class with `@property` tags in
`includes` doesn't help: the project's own class wins. So a relationship read
as a property (`$sender->provider`) is `non-documented-property`, a forwarded
static call (`Message::create()`) is `non-documented-method`, and each use of
their values is a `mixed-*` issue, some of them errors.

`src/eloquent.ts` reads the project's models with `introspect.php models` (each
model's columns, relationships, accessors from `get…Attribute()` or
`Attribute` methods and `$appends`, and local scopes) and `introspect.php
builder` (the public methods of Eloquent's and the query builder), once per
project and again 1.5 seconds after a PHP file under `app/` or `database/` is
saved. It boots the app, which takes about half a second. `setMarkers` drops
Mago's `non-documented-property` when the class is a model that has the
property, or a request (`Illuminate\Http\Request`, or a class in
`App\Http\Requests`, whose input reads as properties), and
`non-documented-method` when the model has the scope or the builder has the
method. `withoutMagic` in `src/magic.ts` then drops the `mixed-*` issues that
follow: those in the same statement, from after the previous `;`, `{`, or `}`
to the next `;`, and those in later statements that use a variable such a
statement assigned, down the chain, until the next named function. Each
server's last diagnostics per file are kept, so they're filtered again when the
models are read. Anything left, such as a property a model doesn't have, or a
facade's `mixed` return, shows as a hint (`magicNoise`) rather than a problem,
as PhpStorm reports magic access only as a weak warning.

Laravel's root aliases (`use DB;`, `Route`, `Cache`, and the rest in
`config/app.php`) exist only at runtime, through `class_alias()`, so Phpactor
reported `Class "DB" not found` and Mago that its methods don't exist.
`aliasStubs` in `eloquent.ts` writes a stub file per project in the app's cache
folder (`alias-stubs/<project>/aliases.php`), one `class DB extends
\Illuminate\Support\Facades\DB {}` per alias, from `introspect.php aliases`
(Laravel's `AliasLoader`, so package aliases count too). Phpactor gets the
folder in `indexer.stub_paths`, after PHP's own stubs, which the setting
replaces; `worse_reflection.additive_stubs` doesn't resolve them. Phpactor
indexes stub paths only in a full build, so new stubs are followed by a full
reindex, and later starts check the aliases in the background and reindex only
if they changed. For projects without their own `mago.toml`, the editor's Mago
settings for the project (see "Types Mago reads wrong") add the folder to
`includes`, so Mago reads the facades' `@method` docs through the stubs. A facade call
(`DB::transaction(…)`, by alias or by an import from a `Facades` namespace)
also counts as magic for `withoutMagic`, since its documented return type is
often `mixed`.

In development, Tauri copies `filament-lsp/` into `target/debug/tools/` only
when the Rust side rebuilds, so a change to `introspect.php` reaches the running
app after the next Rust rebuild.

### Types Mago reads wrong

Laravel's docblocks are often wider than what code gets back, and Larastan
narrows them with PHPStan extensions that Mago can't load. A check of a whole
project (lamah-sms-gateway, about 950 files) found most of its 5,700 problems
came from a few such types. `introspect.php mago-stubs <folder>` writes copies
of those vendor files with the types fixed into the app's cache
(`mago-stubs/<project>/vendor/…`), and lists them; the editor adds the folder to
Mago's `includes` and the originals to its `excludes`. A copy is made only when
its patch applies, so another Laravel version keeps its own files. The patches:

- `__()` and `trans()` with a key return `string`, not `array|string`.
- `auth()` returns the `AuthManager`, and the manager's `@mixin` is a generated
  `EditorStubs\DefaultGuard` whose `user()` returns the default guard's model
  from `config/auth.php`; `Auth::user()` returns it too. (`Request::user()`
  stays `mixed`: an API guard, such as Sanctum's, can sign in another model.)
- `artisan()` in tests returns a `PendingCommand`, not `PendingCommand|int`.
- A service provider's `$app` is `Illuminate\Foundation\Application`, and
  `Storage::disk()` a `FilesystemAdapter` (with `assertExists()` and `url()`).
- Pest's `it()`, `test()`, and `beforeEach()` bind their closure to the test
  case `tests/Pest.php` extends, not to `TestCall` as Pest's
  `@param-closure-this` says.
- Collections' `TKey` and Eloquent's builder `TModel` are covariant, so
  `Collection<non-negative-int, X>` passes as `Collection<int, X>`, and
  `Builder<Post>` as `Builder<Model>` (Filament's `getEloquentQuery()`).
- `pluck()` returns `Collection<array-key, mixed>`: for `static<array-key,
  mixed>`, Mago keeps the original values' type.
- `Sanctum::$personalAccessTokenModel` is a `class-string` of the app's token
  model (read from the booted app), not of the `HasAbilities` interface its
  template is bound by, so `$model::findToken()` resolves.
- Methods that take more arguments than they declare, through
  `func_get_args()`, get a variadic `...$arguments`: those with no parameters
  (`Facade::shouldReceive()`), and those that take an array or a list
  (`is_array($columns) ? $columns : func_get_args()`, as `loadMissing()`).
  Others only pass their arguments on, so they keep their count.

The settings also get `php-version`: the lowest version composer.json allows
(`config.platform.php`, or else `require.php`), as PhpStorm sets its language
level. Mago otherwise assumes its newest (8.5). `magoConfigText` in
`src/diagnostics.ts` writes them; the bundled `mago.toml` keeps `includes` and
`excludes` on one line each for it. The copies are made again in the background
at each start, and the last start's list (`replaced.json`) is used until then.

`paths` becomes the project's top-level folders and PHP files, less hidden
ones, `vendor` (already an include), `node_modules`, and `storage`. Mago walks
every file under a path before it applies `excludes`, so with `.` each check
walked the worktrees in `.claude` and all of `node_modules`. A top-level folder
made later is read after the next start. Phpactor, which runs Mago as you type,
starts with `MAGO_THREADS` set to half the cores (`lsp_start`), so a check
costs about half the CPU; the Problems panel's scan and Mago's fixes run Mago
from the app, on every core.

### False problems the filters drop

`realProblems` in `src/diagnostics.ts` filters every server's diagnostics
before they become markers, for open files and the project's problems alike.
It has no editor imports, so `src/diagnostics.test.ts` runs it in Node. Besides
Laravel's magic (above), it drops:

- Phpactor's checks that Mago's analyzer makes too and gets right where
  Phpactor doesn't: members that don't exist (Phpactor misses facades, macros,
  typed class constants such as `const string A`, and methods declared without
  `public`, as Livewire's `Testable::set()`), undefined variables (`new
  readonly class`), unresolved names (trait `insteadof` rules), missing
  interface methods (it compares names with case, and misses a trait's
  traits), and missing generic tags (it ignores defaults, such as Filament's
  `@template TModel of Model = Model`).
- Phpactor's unused import that a docblock uses (`@use
  HasFactory<UserFactory>`), or that Mago reports on the same line; its "has
  not been defined" for a model's column set in the model; and its namespace
  hint in a file with no named class.
- A factory's `Model|Collection<int, Model>` (see `factoryUnion`), and the
  issues that follow from a factory call's value.
- A member used in a trait (the classes that use it have it), and a member of a
  Mockery mock.
- A view name given to a `view-string` property or parameter when the view
  exists (`introspect.php views` lists them): Mago doesn't know Larastan's type.
- An inherited docblock type (Filament's `getFilters()`), `'password' =>
  'hashed'` in casts, too few arguments where an array is spread, `$this` in
  `routes/console.php`, and PHP deprecations newer than the project's version
  (`ReflectionMethod::setAccessible()` in 8.5).
- A variable a closure captures by reference (`use (&$payload)`) taken for null
  or for the empty array it starts as: Mago doesn't see the closure assign it.

`severityOf` shows Mago's issues about types it can't prove as warnings rather
than errors: `possibly-*`, `less-specific-*`, a closure parameter narrower than
the callable asks for, a missing template argument, a class named by a
variable, and a docblock Mago can't read (`invalid-docblock`, `invalid-*-tag`),
such as an intersection of array types (`array<mixed>&array{id: string}`),
which PHPStan reads and `array{id: string, ...}` says for Mago too. Issues about using a `mixed` value, such as a `foreach` over one,
show as hints, like the `mixed-*` ones. After these, the remaining errors in
that project were all real: wrong `@var` and `@return` types, a package in
composer.json that `vendor` didn't have, a test calling `addMonth(3)`, and the
like.

### The project's problems

`src/problems.ts` scans the whole project for the Problems panel. Mago has no
server mode, but one `mago analyze` and one `mago lint` over the project (with
the editor's settings, `--reporting-format json --minimum-report-level
warning`) take about 3 seconds and 1.6 GB on a 1,000-file project.
`run_capture` takes `anyStatus` for them, since Mago exits with an error when it
finds problems. `magoIssuesByFile` converts the report as Phpactor's Mago
extension does, with Mago's UTF-8 byte offsets turned into UTF-16 positions.
Mago's message for a parse error is always "Parse error encountered during
parsing", so for code `parse` the scan takes the message on the error's
location instead, such as "Expected one of `Variable`, found `LeftBrace`".
Phpactor's extension keeps the generic message for open files. Both `mago
analyze` and `mago lint` report each parse error, so `realProblems` drops the
`mago` one when a `mago-lint` one has the same position and message. Both
paths map Mago's levels the same way: note to Information and help to Hint.
The panel shows neither, so the scan asks only for warnings and errors, and
open files show notes and help in the editor only.
Phpactor has no project-wide check, so its diagnostics command,
`language-server:diagnostics`, runs once per file with the file on standard
input and the editor's index path in `--config-extra`, half the cores at a time;
at about 1.5 seconds a file, 1,000 files take 2 to 4 minutes. Its results are
cached in the app's cache (`problems/<project>/phpactor.json`) by a hash of
each file's text. A file's results also depend on the files it uses, so only
the first scan after a project opens reads the cache; **Scan Project** runs
Phpactor on every file. Both go through `realProblems` and `severityOf`, as open
files do. Files open in the editor show their live markers instead, and a file
that closes keeps its last markers as its scan result, unless you close it
without saving its changes. Then it keeps its earlier scan result. Deleting or
moving a file drops its problems (`forgetPath`). A scan that a newer one
replaced (the project changed) checks its run number after each wait and stops
without publishing; **Scan Project** does nothing while a scan runs. The panel's Errors and
Warnings toggles filter the list, not the status bar counts, and are kept in
`localStorage` (`problemsShown`). The **Current File** toggle (`problemsCurrentFile`)
keeps the file in the editor, and the filter box keeps problems for which
`matchesFilter` in `diagnostics.ts` finds every word in the message, the
`source(code)` label, or the relative path. Files with errors sort first.

The panel keeps the selected row's key, a file's path or a problem's path,
position, and message, so a redraw keeps the selection. The list is a focusable
`role="tree"` that handles the arrow keys, Enter, and ⌘C itself; the context
menu is `showMenu` from `files.ts`. `main.ts` calls `followEditor` when the
cursor moves or the tabs redraw: it selects the row of the problem under the
cursor (keeping the selected one if the cursor is in it too, as with overlapping
problems), and redraws the panel when the file changes and **Current File** is on.
While the panel is hidden, it only records the cursor, and showing the panel
selects the row then.

`problemCounts` also returns the files with errors. `updateProblems` in
`main.ts`, which runs after the panel's debounced render and after the tabs
redraw, adds the folders above them (`withFolders` in `diagnostics.ts`) and
sets the `has-error` class on each matching tree row and tab. `renderDir` sets
it again on the rows it draws. The same function puts the error count, capped
at 99+, on the Problems button in the activity bar.

### Deprecations

Neither Phpactor nor Mago tags its deprecation reports as deprecated, so
`isDeprecation` in `diagnostics.ts` finds them by code (Mago's `deprecated-*`,
Phpactor's `worse.deprecated_usage`), and `setMarkers` gives their markers
Monaco's deprecated tag, which draws the code struck through. Mago reports the
whole call (`$method->setAccessible(true)`), so `realProblems` narrows its range
to the deprecated name from the message.

Unused imports (Phpactor's `worse.unused_import`, Mago's `no-redundant-use`)
show as VS Code shows them: hints over the whole `use …;` line with Monaco's
unnecessary tag, which fades them without an underline, and not counted as
problems (`isUnused`). An import the code uses with other letter case (`use
HasDescription, hasIcon;`) isn't reported: PHP's class names ignore case, and
both checkers compare with it.

### Hovers

Phpactor's hover shows a member's signature in a PHP code block, on one line
however many parameters it has, with a `// @deprecated …` comment and a `⚠`
before it. `formatHoverMarkdown` in `phptypes.ts` moves the deprecation to a
**Deprecated** line above the block, puts `<?php` (which Monaco needs to
highlight PHP) on a line of its own, and gives a signature longer than 80
characters one parameter per line.

### Problem popups and the problem page

Monaco's own problem hover shows the message as plain text in the editor's
font, with the checker's name (`mago(non-existent-method)`). `registerProblemHover`
in `lsp.ts` adds a hover for the markers under the pointer, rendered as
Markdown by `problemMarkdown` in `diagnostics.ts`: the first line in bold,
backticked and quoted names as code, notes as paragraphs, code past 100
characters cut short, then the checker and rule (`ruleLabel`, such as
`mago-lint(no-redundant-use)`) and a **Show Details** command link.
`styles.css` hides Monaco's message row (`:has(> .marker.hover-contents)`) and
keeps its View Problem and Quick Fix links. Monaco lists the newest hover
provider first, so the hover is registered again after each server's
providers. It's registered for the `**` pattern rather than a list of language
IDs, so languages registered later get it too; a matching pattern scores as
high as a matching language. `setMarkers` sets each marker's source to the
diagnostic's (Mago sends `mago` and `mago-lint`) or else the server's name, and
the Problems panel shows the same label with the line and column.

The client advertises `publishDiagnostics.tagSupport`, and `setMarkers` merges
the diagnostic's own tags, whose numbers match `MarkerTag`'s, with the ones
`isDeprecation` and `isUnused` infer, so servers such as vtsls fade unused code
and strike through deprecated code. Stopping a server removes its entries from
`lastDiagnostics`, so `onModelsRead` doesn't bring back its markers.

`lastDiagnostics` also keeps the diagnostics left after filtering, and a code
action request sends the ones that overlap the range, so a false problem that
the filters drop gets no quick fix. The hover's Quick Fix link lists only
actions of kind `quickfix`, while the light bulb lists every kind. A server
can answer with a bare `Command`, which has no kind, so the client gives such
a command the kind `quickfix` when problems overlap the range. Each action carries its
diagnostics as markers: the server's own for a `CodeAction`, and the
overlapping ones for a command.

Phpactor's hover over a docblock returns its parser's node name, such as
`ClassMembersNode`; the hover provider drops a hover that's only such a name.

The link runs `problems.openPage`, which `showProblemPage` in `problems.ts`
handles: a page in the editor area, like the diff view, with the message
(`messageParts`; code longer than 60 characters goes in a block, laid out by
`formatType` with one array-shape key per line), a read-only editor showing
four lines around the problem with its range underlined (a `problem` scheme
keeps it from the language servers), and Go to Code. It opens as an editor tab
(`showEditorView`).
The page remembers which of the editor, diff, history, and merge views it hid,
and closing it shows those again. For a `mago-lint` problem, the page adds an
**About this rule** section with the rule's description from
`mago lint --list-rules --json`. `ruleDescription` runs it once for each
project and Mago config and keeps the descriptions by rule code. The command
takes a few milliseconds, and it lists only the enabled rules, which include
every rule that can report a problem. The analyzer's codes have no
descriptions, so `mago` problems get no section.

### The cursor line's problem

With the `inlineProblems` setting on (off by default), `showInlineProblems` in
`problems.ts` adds an `after` decoration at the end of each pane editor's
cursor line, as the inline blame does. `inlineProblem` in `diagnostics.ts`
picks the line's worst error or warning, takes its message's first line, cuts
it at 120 characters, and appends `+n` for the line's other problems. The
decoration updates 250 ms after the cursor, the model, the markers, or the
settings change. An edit clears it at once, so it doesn't jump while you type.
Monaco keeps a marker's range fixed until the server publishes again, and the
wait covers that.

### Mago's fixes and suppressions

Mago reports fixes for many lint rules, but Phpactor's Mago extension drops
them, so a second code action provider for `php` in `lsp.ts` gets them from
Mago itself. On a request the user makes (`CodeActionTriggerType.Invoke`: ⌥⏎,
the hover's Quick Fix link, or Fix All) with `mago-lint` markers in the range,
it runs `mago lint --stdin-input <path> --reporting-format json` on the
buffer, once per model version. `magoFixes` in `diagnostics.ts` reads each
issue's `edits`: byte ranges and UTF-8 `new_text` bytes, and a `safety` of
`safe`, `potentiallyunsafe`, or `unsafe`. Each fix whose range touches a marker
with the same code becomes a `quickfix` action; only safe ones are preferred,
and the others say so in their title. `safeEdits` collects the safe fixes for
problems the file shows, leaving out fixes that overlap one before them, for
**Fix All Safe Mago Problems in File**. A fix for a problem the filters drop,
such as an unused import that a trait's `use` needs, isn't applied. The same action has the kind `source.fixAll.mago` when the
request asks for `source.fixAll`, so Monaco's `editor.action.fixAll` applies
it. The edits go through Monaco, so they're undoable and the file isn't saved.
They carry the model version Mago ran on, so Monaco refuses them if the text
changed while Mago ran.
The analyzer's fixes aren't offered, since `mago analyze` on one buffer still
reads the whole project.

Every `mago` and `mago-lint` marker also gets **Suppress *code* for this
line**, which doesn't run Mago, so the light bulb shows it too. `magoExpect`
writes `// @mago-expect lint:code` (`analysis:` for the analyzer) above the
marker's first line with its indentation, or adds `,code` to a
`// @mago-expect` or `@mago-ignore` comment for the same category in the
comment lines just above. Mago 1.50.0 ignores a comment that mixes `lint:` and
`analysis:` codes, so each category gets its own line. A line with `<?php` gets
no suppression, and neither do `parse` and `unfulfilled-expect`.

### Next and previous problem

F2 and ⇧F2 run Monaco's `editor.action.marker.next` and `marker.prev`, which
show the marker in Monaco's go-to-error zone widget. **Next Problem in Files**
runs `marker.nextInFiles`, which opens other files through the editor opener.
Monaco binds F8 and ⇧F8 to the in-files pair; the stepping actions have a
`when: isPaused`, so the keyboard handler lets those keys through to Monaco
while the debugger is idle. The built-in themes set `editorError.foreground`,
`editorWarning.foreground`, `editorInfo.foreground`, and
`editorHint.foreground` to the interface's colors, and Monaco derives the
widget's colors from them.

### Checking open files one at a time

Phpactor's diagnostics engine (`DiagnosticsEngine` in its language server
library) keeps one waiting document: each document opened, changed, or saved
replaces the one before, and it drops a document's results once another is
waiting. So when a session reopened several files, or indexing ended and the
editor asked for every open file again, only the last one got checked, and the
others showed no problems until you edited them. `checkOneByOne` in `lsp.ts`
sends `didSave` for one file at a time, when the server starts and when its
first indexing run ends. Later indexing runs follow a file created on disk,
such as by `artisan make`, and a pass then took the check away from the file
you were editing for up to a minute, so they don't start one. It moves to the next file half a second after a publish that has
results from both `mago` and `mago-lint`, 5 seconds after the last publish
(Mago takes about 2, and a checker that finds nothing publishes nothing), or
after 30 seconds. Moving on sooner would make Phpactor drop Mago's results for
the file. The client tracks the document Phpactor checks next
(`lastEnqueued`), and a publish for it marks the file as checked
(`diagnosed`). Until then, the Problems panel shows the scan's problems for an
open PHP file: other servers, such as the spell checker, publish first.

Before each check, `DiagnosticsEngine` publishes an empty list, then the list so
far as each checker finishes. A checker with no results publishes nothing, so
the empty list is the only way a file that became clean loses its problems.
Applying it at once made every squiggle vanish after each pause in typing and
come back in stages. The client holds an empty Phpactor publish for a file
that has problems for 4 seconds, and any later publish for the file replaces
it. A held publish doesn't mark the file as checked. Held markers keep their
old ranges: Monaco moves the squiggles as you type, but not the marker ranges
that the Problems panel reads.

### Docblocks Phpactor can't read

Phpactor's docblock parser drops a `@param` whose type it can't read, such as a
PHPStan array shape with quoted keys (`array{'code': string}`; unquoted keys
parse), and then reports `worse.docblock_missing_param` for a parameter the
docblock does document. `documentedAfterAll` in `lsp.ts` finds the docblock of
the function around the report (`docblockHasParam` in `phptypes.ts`: the
`/** … */` right before `function`, with only modifiers and attributes between)
and drops the report when it has `@param … $name`. The same goes for
`worse.docblock_missing_return_type` and `@return`: Phpactor can't read an open
array shape either (`array{id: string, ...}`), which Mago needs for
`array<mixed>&array{…}`.

### Unfinished first builds

Phpactor finds classes through Composer's autoloader even without an index,
but functions only through the index. A first build takes minutes, and its
update pass on later starts indexes only files newer than the index's last
update, which every file change moves forward. So a first build that stops
partway, because the server restarted or another project opened, leaves the
files it never reached out of the index for good, and a helper such as
Laravel's `response()` shows "Function not found" in every file. (One project
had a 133 MB index where a complete one is 537 MB.)

The client therefore records, per project in `localStorage`
(`phpactorIndexed:<root>`, set to the index path), that a full build finished.
Until it has, `checkComposerLock` asks for a full reindex at each start, and
file changes don't trigger the update pass, which would only move the timestamp
past the missing files. `reindex(false)` sets `awaitingFullIndex`; the next
`$/progress` run titled "Indexing…" is the full build, and its end marks the
index complete. `-editor-2` replaced `-editor-1`, whose indexes may be
incomplete; the old folders under `~/.cache/phpactor/index` can be deleted.

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
`$this->get()` works in a Pest test. Mago reads the type from the corrected
copy of Pest's functions (see "Types Mago reads wrong"). Phpactor reports
`$this` as undefined, so in files under `tests/` that call `it()`, `test()`,
`describe()`, or `arch()`, the filters drop problems that mention `$this`,
`TestCase`, or `mixed` on lines that use `$this`, and Phpactor's hint to add a
namespace. They also drop Mago's issues about Pest's own classes, which answer
through magic (`->not`, higher-order expectations such as `->name->toBe()`),
and calls on null along an `expect()` chain: `expect()` returns an
`Expectation<TValue|null>`.

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
  `didChange`, `didSave`, and `didClose`. A server that takes changes
  (sync kind 2, such as typos-lsp) gets each edit's ranges. A server that takes
  only whole documents (Phpactor, Laravel LSP, Tailwind, the Filament server)
  gets the full text once typing pauses for 150 ms, or before the next message
  to it, whichever comes first, so every request is answered for the current
  text. Sending the full text on every keystroke made Phpactor reparse a
  4,800-line file for each one, and it fell minutes behind. One copy of the text
  per version is shared by all servers (`textOf`).
- Providers pass Monaco's cancellation token. When Monaco drops a request, such
  as a completion list after the next keystroke, the client sends
  `$/cancelRequest` and resolves the request with `null`.
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
closure or a chain over several lines counts as one, and no other writes (compound assignment, `[]`, `->prop =`, `++`, `&`, `foreach … as`)
or closure `use` lists, which take a variable and can't take its value,
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

Change Signature also changes overrides. `descendantsOf` searches project
files for the class's short name as a whole word, keeps the types whose parsed
declaration really extends or implements it, and repeats for each one found,
to reach grandchildren. Searching for the name alone, rather than for
`extends … Name` on one line, finds headers split over several lines; the
search is line by line, so a pattern can't span them. `overridesOf` then
takes the method from each type's text. Phpactor's Go to Implementation would include `vendor`, but it
answers from the index, which misses classes created since the last full
index: in testing, file change events for new files didn't reach the index
until a reindex. Each override's parameter list gets the new text, and calls
through the override (`references:member` on its class) are rewritten too,
without duplicates. References that are declarations (`function name(`) are
skipped, since they have their own edit.

Constructors differ: Phpactor's `references:member` doesn't report `new`, and
a subclass's constructor isn't an override, since it may take different
parameters. So `callsOf` sends `__construct` to `constructorCallsOf`, which
collects the class and each descendant that inherits the constructor (no
`__construct` of its own, and its parent in the set), searches for `new` with
one of their short names, and reads those files, the class's, and the
descendants' with `constructorCalls` in `src/phptypes.ts`. That resolves each
`new Name(` through the file's `use` statements, `new self` and `new static`
to the enclosing type, and `new parent` and `parent::__construct(` to its
parent. Call Hierarchy and Safe Delete share `callsOf`, so they see these
calls too.

### Change Signature's dialog and preview

`declarationParts` in `src/refactorparse.ts` reads a declaration's modifiers,
name, parameters (each split into everything before the name, `&`, `...`, the
name, and the default), and return type, and whether the parameters sit one per
line. `src/signaturedialog.ts` edits that as a `Signature`, where each parameter
remembers its old name in `from`, so renames and reorders stay tied to the old
position; `signatureProblem` and `signatureWarning` check it as you type.

`plan` in `src/refactor.ts` then builds one `WorkspaceEdit`: the header from the
modifiers to the return type, parameter renames in the docblock and body
(`renameParams`), each override's header with `forOverride`, which matches its
parameters by position so it keeps its own names, and each call's name and
arguments. `rewriteArgs` fills a new parameter with its value for calls (or its
default only when a later positional argument needs the slot) and, once an
argument has to be named, names the rest, since a positional one after it
would take a named one's place. Calls whose arguments don't change keep their
text, and arguments one per line are written back one per line.

Edits must not overlap, but a call's arguments can hold other edits: a
renamed parameter in a recursive call, or a nested call to the same method.
So calls are collected first and rewritten innermost first (by the offset of
their `(`, descending), each applying the edits inside its arguments to their
text before splitting it, and replacing them with one edit. `matchBracket`,
`splitTopLevel`, and `statementEnd` skip comments as well as strings, so a
`// don't` doesn't open a string that swallows the rest of the body.

Introduce Parameter reuses the dialog: `changeSignature` adds the parameter
without text, which the dialog treats as new, and `plan` also replaces the
expression's uses in the body with the parameter.

`src/refactorpreview.ts` shows the edit before it's applied. `changedLines`
applies each file's edits line by line, and each row marks the part between
the text the old and new line share at both ends, as VS Code's Refactor
Preview does. The preview opens on its own when calls were left unchanged,
since those need a look.

### Extract Variable, Extract Constant, and Extract Method

Phpactor's Extract Expression names the variable `$newVariable` and wraps
whatever the range covers, and it offers no Extract Constant, so both are
written here. `src/extractparse.ts` tokenizes the file (comments masked, PHP
tags as `;`) and, for the token at the caret, walks out to the nearest
boundary (`;`, `,`, `=>`, assignments, a ternary's `?` and `:`, braces, and
keywords), splits that span into operands and binary operators, and lists the
operand's own chain (`$this->user()`, then `->name`), the operand with its
prefix (`!`, casts, `new`), and each enclosing binary expression, found by
splitting at the loosest operator with PHP 8's precedence. Then it steps out to
the brackets around the span, so `foo($a * $b)` follows `$a * $b`, stopping at
control structures' parentheses and at blocks. Assignment targets, foreach
variables, and an arrow function's body are skipped.

`occurrences` matches the same tokens, whatever the spacing, and keeps only
matches that are expressions of their own at their position, so `$a + $b`
doesn't match inside `$a + $b * $c`. `declarationPoint` walks back from the
first use to its statement's start, passing blocks that end before the last
use and joining `else`, `catch`, and the like to their statement, so the
declaration lands in the innermost block that holds every use.

The new name is typed in place: `applyNamed` in `src/extract.ts` replaces the
text from the first edit to the last with one snippet, the name a placeholder
at every use, so typing renames them together and ⌘Z undoes the extraction in
one step. A `tuskNaming` context key makes ⏎ and Escape end it, as PhpStorm's
in-place rename does, rather than add a line at every copy. Extract Method runs
Phpactor's `extract_method` and then does the same with the name Phpactor chose,
found as the one new `function` in the file.

Introduce Field uses the same expression and occurrence search. It places the
property after the last one `classProperties` finds, or where a constant would
go (`constantPoint`), and types it with `literalType`, which knows literals
and `new Foo()`; anything else gets no type rather than a guess.

Refactor This (⌃T) lists actions by name from `refactorings`, which checks each
against the caret, so the shortcuts shown follow the keymap. The choice
popups open below the caret (`pickAtCaret`), with a `preview` callback that
highlights what each option would change.

### Inline constant

Inline (⌥⌘N) tries a class constant first and falls back to Inline Variable.
`constantRefs` in `src/extractparse.ts` finds `X::NAME` tokens (so strings and
`$obj::NAME` don't count) and resolves `X` through the file's `use` statements,
`self` and `static` to the type around it, and `parent` to its parent.
`inlineConstant` in `src/refactor.ts` finds the owner's file through the
workspace symbols, reads the value with `constantDeclaration`, and searches the
project for `::NAME`, keeping references whose class is the owner or a
subclass that doesn't redeclare it. `inlinedValue` writes the owner's class
names in full and `shortenNames` shortens them again where the target file
imports them.

### Move class

`moveClass` in `src/refactor.ts` reuses the file tree's move (`move` in
`src/files.ts`): it lists namespaces from the folders of the project's PHP
files (`namespaceFor`), maps the chosen one to a path with `pathsFor`, and
moves the file there. `updateReferences` then asks Phpactor
(`workspace/willRenameFiles`) for the namespace and reference edits. Phpactor
maps paths to class names through Composer's autoloader, loaded when it
starts, so a project without `vendor/composer` gets no edits; the error it
returns now reaches the status bar instead of being dropped.

### Undo across files

`applyWorkspaceEdit` wraps each file's edit in undo stops, so it's one step, and
`linkUndo` watches the models it changed. The first undo in one of them undoes
the others and saves every file. A model edited in between leaves the group, so
a later undo there doesn't reach back into the refactoring.

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

### Generate

`src/generate.ts` is PhpStorm's ⌘N menu for PHP. Phpactor writes what it can:
getters and setters through its `generate_accessors` and `generate_mutators`
commands, called with the property names directly (its code action offers
only the properties inside the selection), and Implement Methods, Override
Methods, and the constructor transformers through its code actions for the
cursor, filtered by kind. The editor sets Phpactor's accessor prefix to `get`,
so getters match PhpStorm's names. Phpactor has no action that writes a
constructor from properties or a `__toString()`, so those are snippets:
`classProperties` in `src/refactorparse.ts` reads the class body's top-level
declarations and promoted parameters, and the snippet goes after the last
property or before the class's closing brace, indented with the file's
indentation.

Phpactor's Implement Methods covers interfaces and abstract parent classes,
but not the abstract methods a trait declares. `traitAbstracts` follows the
class's traits, and the traits they use, to their files through the workspace
symbols (`typeSymbol` in `src/lsp.ts`, which Type Hierarchy also uses), and
`abstractMethods` in `src/phptypes.ts` copies each declaration without
`abstract`, with class names in its types written in full, since the trait's
`use` statements don't apply in the class's file. `shortenNames` then writes
a full name short where the class's file already imports it or shares its
namespace. The stubs go before the class's closing brace, found again after
Phpactor's own edit. When Phpactor has nothing to implement, **Implement
Methods…** still shows for the trait methods alone.

⌘N is also **New File…**. The shortcut handler now takes the first action for
the keys that applies (an editor-only action needs the editor focused, and
`when` must pass), so **Generate…** runs in a PHP editor and **New File…**
everywhere else.

### Call hierarchy

Phpactor has no `textDocument/prepareCallHierarchy` either, so
`src/callhierarchy.ts` builds the tree the same way, reusing the type
hierarchy's styles.

- **Callers**: `callsOf` from `src/refactor.ts` (Phpactor's
  `references:member` for methods, `textDocument/references` for functions).
  Each reference is placed in the innermost method, constructor, or function
  around it, from `textDocument/documentSymbol` of its file.
- **Callees**: `callSites` in `src/phptypes.ts` finds the names followed by `(`
  in the body, leaving out language constructs, declarations, `new`, and
  variable calls. Each one gets `textDocument/definition`, and the declaration
  around the answer is the callee. Definitions inside Phpactor's `.phar` (PHP's
  own functions) are dropped, since they can't be opened.

As with types, the starting point is what Go to Definition finds under the
cursor, when that's a function of the same name; otherwise it's the function
around the cursor. Rows load their children when expanded.

### HTTP client

`.http` files stay the one copy of each request. The HTTP tab is a form over a
request's block of text, so there's no second store to keep in step, and the
files work in PhpStorm and VS Code's REST Client.

- `src/httpfile.ts` has no editor imports, so Node tests it. `parseHttp` reads
  blocks between `###` lines: file variables, tags, pre-request scripts, the
  request line (with indented continuation lines), headers (a commented-out
  header is one turned off), the body, the response handler, and `>>` output.
  Each request records its block's lines (`start`, `end`). `formatRequest`
  writes a request back as text. `prepare` replaces variables, resolves file
  bodies relative to the `.http` file, turns multipart bodies into curl form
  parts, and encodes `Basic user password`. It also builds curl arguments, reads
  curl's header dump, imports and exports curl commands (`shellWords` handles
  bash quoting, including `$'…'`), writes Laravel `Http::` code, and computes
  stress test statistics.
- `src/httpclient.ts` sends a request with `/usr/bin/curl` in a PTY
  (`pty_spawn`), so **Cancel** can kill it. `pty_spawn` takes a `channel` that
  names its output events, so the listeners are in place before curl starts and
  a request that finishes at once loses nothing; a terminal's events are named
  by its ID, which only comes back after the process starts. curl writes the
  headers (`-D`) and body (`-o`) to files in the app's cache and prints its
  `%{json}` write-out after a marker, with its own errors before it (`--stderr
  -`). A text body goes through a file too, since a PTY's input is a terminal.
  Bodies stay in files, so binary responses and large ones never pass through a
  JavaScript string unless shown. `-g` keeps brackets in URLs literal. Cookies
  go to a Netscape-format jar per project and environment (`-b` and `-c`). The
  history is an `index.json` of exchanges beside their body files, capped at
  100 unpinned ones. Global variables and the selected environment are in
  `localStorage`, per project.
- `@laravel-session` requests read `XSRF-TOKEN` from the jar, fetching
  `/sanctum/csrf-cookie` (or `/`) first when it's missing, and add
  `X-XSRF-TOKEN`, `Origin`, and `Referer`. Laravel rotates the token in its
  responses, and the jar keeps the newest.
- **Send with Debugger** starts the Xdebug listener and adds `XDEBUG_SESSION=1`
  to the query, which Xdebug reads in trigger mode. **Send with Profiler**
  swaps the URL's origin for the profiling server's (`profilingOrigin` in
  `src/profiler.ts`) and opens the profile written after the send.
- Requests from routes get a body from `validationRules` and
  `formRequestParameter` in `src/phptypes.ts`, which read the rules array of a
  FormRequest's `rules()` or a controller's `validate()` with bracket matching
  that skips strings and comments, and `bodyFromRules` in `src/httpfile.ts`,
  which picks each field's example value from its rules. **Go to Controller**
  matches the request to a route with `matchRoute`.
- Scripts run in `src/httpscript.worker.ts`, a worker with no access to Tauri's
  IPC, so a script in a cloned repository can't run commands. The worker is
  stopped after 5 seconds. It gets copies of the globals and variables and
  returns the changed ones, with test results and logs.
- `src/httpview.ts` is the tool window and the HTTP tab. The tab tracks its
  request with a model decoration on the request's first line, which moves as
  the file changes above it. Each form edit parses the model, changes the
  request, formats it, and replaces only the lines between the unchanged ones
  at the block's start and end, in one undoable edit. The parser keeps comments
  among the headers and in the body with their positions, and a URL written
  over several lines, so formatting puts them back. The file then saves, open
  in a tab or not, so a reload can't lose a form edit. Edits in the editor
  re-render the form unless focus is in it.
- A Laravel error response is read by `laravelException`: the JSON Laravel
  sends when asked for it, or file and line references in an HTML error page.
- WebSockets use the webview's `WebSocket`: curl in macOS has no WebSocket
  support, and a Rust client would be a new dependency for a console that
  mostly talks to Reverb or Pusher on the same machine.
- `src/httpload.ts` runs a file's requests in order through `send`, the
  stress test, and the monitor. The stress test is one curl process in
  parallel mode (`-Z --parallel-max`), repeating the URL with a glob range in
  its fragment, which isn't sent, and printing one line per request. It runs in
  a PTY so its output streams. Brackets and braces in the URL are escaped for
  the glob. A ramp-up runs one such process per concurrency level, each killed
  after its seconds. The monitor sends through `probe`, which skips scripts
  and history.

- `src/laraveltools.ts` has no editor imports, so Node tests it. `featureTest`
  builds a Pest test or PHPUnit method from a prepared request and its response:
  the path without the origin, the body as a PHP array (`phpValue`), a bearer
  token as `withToken`, other headers except the ones the helpers set, then
  `assertStatus` and an `assertJsonStructure` built from the response's keys (three
  levels, `*` for a list of objects). `addTest` adds a test to an existing file,
  and a name the file uses gets a number. `parseLaravelLog` reads Monolog's line
  format into entries, and `fileReferences` finds `file.php:12` and
  `file.php(12)`. `appAddresses` ranks where the app might answer from facts the
  caller gathers: `.env`, the compose file, Herd's or Valet's `config.json`,
  linked sites and certificates, and `lsof` output (`phpPorts`).
- `src/httplaravel.ts` is the interface for those tools: the Logs and Queries
  response tabs, **Generate Feature Test…**, and **Detect App Address**, which
  writes `host` into the shared environment file. It only defines functions, so
  its import of `httpview.ts`, which imports it back, is safe.
  `createEnvironmentFile` loads it with a dynamic import for the same reason.
- `send` and `resend` record the sizes of `laravel.log` and the newest daily log
  before curl runs. Afterwards they read what the files gained with `tail -c +N`,
  the last 200 KB at most, into `Exchange.appLog`. A file that shrank was rotated,
  so all of it counts. **Send with Profiler** gets the profile's path from
  `openProfileSince`, loads the SQL trace written next to it with `loadQueries`,
  and saves the queries to the exchange with `updateExchange`, so history keeps
  them.
- **Less typing.** `httpfile.ts` holds the pure parts. `jsonPathAt(text, offset)` walks the JSON text and returns the path of the deepest value, key or container at the offset. `CHECKS` defines each check kind's code template. `writeChecks` writes checks between the `// checks:start` and `// checks:end` markers in the response handler. `readChecks` reads them back with patterns built from the same templates, and reports the block as not editable when its code doesn't match. `envTable` and `envFiles` turn the two environment files into a table model and back. A variable in the private file is private, and every environment stays in the shared file so the menus list it.
- `httpchecks.ts` holds the Checks section of the Scripts tab and the response body's **Save as Variable…** action. The Checks section edits the handler's Monaco editor, so its changes go through the same `updateSoon` path as typing. `httpenv.ts` is the environment editor, shown with `showHttpPanel`. Both import from `httpview.ts`, which imports them back. That's safe because each only uses the other's exports inside functions.
- `send` passes `response.time` (curl's `time_total` in ms) to the response handler script.
- `requestItems()` in `httpview.ts` lists every request as palette items. **Go to Request…** and Search Everywhere use it.
- `src/graphqlschema.ts` has no editor imports, so Node tests it. `schemaFrom`
  reads an introspection result into a map of types, with fields, arguments,
  and type strings such as `[User!]!`. `contextAt` walks a document from the
  start, with a stack of types: an operation's `{` pushes its root type, a
  field's `{` pushes the field's named type, and `fragment … on T` and
  `... on T` push `T`. It tracks parentheses, so the cursor is either in a
  selection set, in a field's arguments at a name, or elsewhere. Strings and
  comments are skipped.
- `src/graphqleditor.ts` fetches a schema by sending the request as a
  `GRAPHQL` request whose body is the introspection query, through `probe`
  with `readBody`, so it has the request's URL, headers, variables, and auth.
  Schemas are cached by resolved URL for the session, failures included, so
  typing never sends a request per keystroke. It registers completion and
  hover providers for Monaco's built-in `graphql` language (the Query editor,
  whose model it maps to a schema source) and for `http`, where it reads a
  `GRAPHQL` request's body from its first line.
- WebSocket requests connect through `src-tauri/src/ws.rs`, since the webview's
  `WebSocket` can't set headers. `ws_connect` takes the URL, headers, `insecure`,
  and a caller-chosen `channel`, like `pty_spawn`, and emits `ws:<channel>`
  (`{ text }` or `{ binary }` as base64), `ws-error:<channel>`, and
  `ws-close:<channel>` (`{ code, reason }`). Each connection has a thread that
  reads with a 50 ms timeout, and between reads it sends the messages
  `ws_send` and `ws_close` queue.
- gRPC calls go through `src-tauri/src/grpc.rs`, since curl can't frame gRPC
  messages. `transmit` hands a `GRPC` request to `transmitGrpc`, which calls
  `grpc_call` and writes the JSON it returns as the body, so history, scripts,
  and the runner treat it as any response. tonic makes the call with a
  `DynamicCodec` that encodes and decodes prost-reflect's `DynamicMessage`s.
  Every call goes through tonic's streaming call, which covers the four method
  kinds: one message for unary, the body's JSON values one after another for
  client streaming. The schema comes from server reflection (v1, then v1alpha,
  whose messages are the same on the wire), asking for the file with the
  service and then each file it imports. Without reflection, `project_pool`
  compiles the first `.proto` file declaring the service with protox, a Rust
  protobuf compiler, with the file's folder and each one above it up to the
  root as import paths. The status maps to an HTTP status as Google's APIs do,
  so `response.status` checks and the runner's failure rule work unchanged.
  `grpc_cancel` ends a call through a oneshot channel. `grpc_methods` lists
  methods for completion; `httpclient.ts` caches non-empty lists per address.
- `prepare` carries `proxy`, `clientCert`, `clientKey` (absolute), `http`, and
  `budget` into `Prepared`. `connectionArgs` turns the first four into curl's
  `-x`, `--cert`, `--key`, and `--http2` or `--http1.1` for sending, stress
  tests, and **Copy as cURL**. The proxy comes from `@proxy`, or else the
  environment's `$proxy`. `overBudget` compares `time_total` with `budget`
  for the response summary and the runner.
- `toFetch`, `toAxios`, and `toGuzzle` share `bodyOf`, which classifies the
  prepared body as JSON, form fields, multipart parts, text, or a file. The
  JavaScript generators read files with Node's `openAsBlob`.
- `redact` in `src/httpfile.ts` hides secret values in a prepared request:
  headers such as Authorization (keeping its scheme) and cookies (keeping their
  names), and query parameters and JSON, form, and multipart fields whose names
  match token, secret, password, API key, and the like. It leaves `{{names}}`
  and already hidden values alone. The history cache in memory keeps real
  values for the session, so **Send Again** sends them; `saveHistory` writes
  `index.json` through `withoutSecrets`, which also hides `Set-Cookie` values,
  and marks an entry that lost secrets with `secrets`. `resend` prepares such
  an entry again from its file through `send`. The Request tab and copying go
  through `redact` unless you choose **Show secrets**. Response bodies aren't
  changed.
- `src/httpimport.ts` has no editor imports, so Node tests it.
  `importCollection` detects a Postman collection (v2), an Insomnia export (v4),
  or an OpenAPI 3 or Swagger 2 document, and returns one file's text and
  environments. It reads JSON with `JSON.parse` and anything else with the
  `yaml` package. OpenAPI bodies come from examples, or from a skeleton of the
  schema that follows `$ref` and stops at a cycle. `toOpenApi` goes the other
  way, and `junitReport` writes the runner's results as JUnit XML.
  `src/httpteam.ts` is the UI: it chooses the file with the dialog plugin,
  writes the result to `http/`, and merges environments without replacing
  existing values, sending secret names to the private file. It replaces the
  tool window's import action through `setImporter`, like `setRunners`.
- The runner (`runFiles` in `src/httpload.ts`) runs one file or every file in
  the project and keeps a `ReportCase` per request for **Save Report…**.

The `http` Monarch grammar embeds JSON bodies and JavaScript scripts. Monarch
only embeds a language whose tokenizer has loaded, and a zero-width rule enters
it only with `@rematch`, so the grammar registers after loading both. Hovers,
completion, and warnings for undefined variables read the same scopes as
sending, plus names the file's scripts set.

### Composer

`composer.phar` is bundled like the other tools, pinned with its checksum from
getcomposer.org. The tool window reads `composer show --direct --format=json`
first, then `composer outdated --direct --format=json`, which asks Packagist
and takes a second or two. `packages` in `src/composerdata.ts` joins them with
`require` and `require-dev` from `composer.json`, which mark dev and direct
packages. **All installed packages** drops `--direct` from both commands.
**Why Is It Installed?** runs `composer why <package>`, which has no JSON
output, so `dependents` reads its text rows (`<name> <version> requires
<package> (<constraint>)`); the project itself is the row whose version is
`-`. The list also reads `composer.lock`: `requiredBy` gives each indirect
package's "via" line without running `composer why` per package.
`composer audit --format=json` runs beside `composer outdated`, with any exit
status accepted, since it fails when it finds advisories; `advisories` reads it
(Composer writes an empty map as `[]`). For **unused?**, `namespaceChecks`
turns each direct dependency's PSR-4 and PSR-0 namespaces into one regex that
also matches the doubled backslashes in strings, and `files_matching` runs it
over the project's PHP files, one package at a time. Plugins, metapackages,
PHPStan extensions, packages with a `bin`, and packages without a namespace
are skipped, since code never names them. Packagist search goes through curl, like
the HTTP client. Commands that change packages run in terminal tabs, and the
tab's exit reloads the list. The `composer.lock` change they cause also
reindexes Phpactor.

### Spell checking

Spelling comes from `typos-lsp`, a language server for the `typos` checker,
bundled per architecture like Mago. `typos` checks words against a list of
known misspellings, not a dictionary, so it doesn't flag names, jargon, or
abbreviations, and it understands `camelCase` and `snake_case`. The server
reports misspellings as information, with a fix and an "ignore in the project"
code action, which writes `typos.toml`. The editor underlines them with a
green wave of their own (`typoDecorations` in `lsp.ts`), and next and previous
problem skip them. It's a native binary, so the bridge
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
ends before a line equal to the next non-blank line below. The request also
asks for each token's probability (`n_probs: 1`), and `leastLikely` finds each
line's least likely token. A suggestion ends before a line holding a token under
50% likely, and it's dropped when its first line holds one under 35%. A
suggestion that adds nothing is dropped too. Tab accepts all of it; ⌘→ (Monaco's
own) accepts the next word and ⌘⇧→ the next line, a rule added only while a
suggestion is in front of the cursor, so ⌘⇧→ still selects to the end of the
line otherwise. When a suggestion's first line ends with the rest of
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
   The classes of the names before `->` near the cursor come first, from
   Phpactor, so a variable's class is included even when the file never names
   it. `typedNames` lists the variables and properties before `->` in the 30
   lines before the cursor, nearest first, up to six, and the editor asks
   Phpactor for each one's type definition (`textDocument/typeDefinition`),
   whose file gives the class. A request never waits for Phpactor: it uses the
   types found so far and starts lookups for the rest, and a type that arrives
   readies the prompt again. A lookup often runs before Phpactor has the edit
   that declared the variable, so a name with no type is asked again after a
   second. Found types are kept until the file changes on disk.

   A Blade view has no classes of its own, so it gets them from the code that
   renders it. `viewCallers` searches the index for the view's name in quotes
   (`view('posts.show', …)`, `@include('posts.show')`, `Route::view`, a
   Livewire component's `render()`), and for a component
   (`resources/views/components/…`), its `<x-…>` tag. The first three matches
   each add the 12 lines before and 8 after, which is where the variables are
   passed, and the classes used around each match become the view's
   definitions. The classes that render the view (under `app/`) are outlined too,
   for a Livewire component's properties, and so is a component's own class
   under `app/View/Components/`.
   A JavaScript, TypeScript, or Vue file gets outlines of the project files it
   imports instead: `importedFiles` resolves each `import … from` (relative
   paths directly; an alias such as `@/` or `~/` as the shortest indexed path
   ending with the rest, since projects point aliases at different folders,
   koel at `resources/assets/js`) and orders them by the nearest use of their
   imported names. `outlineScript` keeps declarations, classes, interfaces, and
   objects, and replaces function bodies (a `{` after a `)`, a return type, or
   `=>`) with `{ … }`. For a Vue file, it outlines the `<script>` blocks.
2. **Models.** `introspect.php models` boots the app once, and describes
   every model under `app/`: columns from `Schema::getColumns` (or the model's
   fillable, casts, and timestamps without a database), casts, and
   relationships. It takes about 0.3 seconds, and runs again 5 seconds after a
   PHP file under `app/` or `database/migrations/` changes. In a Blade view,
   the referenced classes that are models go first, as an
   `_ide_helper_models.php` file of ide-helper docblocks, because models learned
   `@property` lines from real projects. PHP files don't get them: on Pinkary,
   they changed nothing measurable (see Measuring completion) and cost about 400
   tokens. Casts win over database types, and
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
repeated the code below. It times each request twice: cold, and after typing a
character with the prompt ready, which is what the editor's warm-ups leave.
Recent code isn't measured, since a benchmark has no history of where you
worked.

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
budget stays.

The `block` task measures multi-line suggestions: it hides the rest of a
block, 2 to 8 lines, from the start of a line, asks once per case, and scores
ways of ending the suggestion on the same replies. On 60 blocks with the 3B
model:

| Where a suggestion ends | Shown | Right lines per case | Wrong lines per case | Cases with a wrong line |
| --- | --- | --- | --- | --- |
| Where the model stopped | 100% | 0.85 | 2.60 | 76.7% |
| After the first line | 100% | 0.38 | 0.62 | 61.7% |
| At a blank line | 100% | 0.85 | 2.60 | 76.7% |
| Before a line with a token under 50% | 100% | 0.77 | 1.78 | 71.7% |
| Before a line with a token under 70% | 100% | 0.70 | 1.38 | 65.0% |
| Under 50%, and nothing when the first line has a token under 35% (the editor's) | 81.7% | 0.73 | 1.47 | 53.3% |

The editor's rule removes 43% of wrong lines and keeps 86% of right ones. On
60 single-line cases it hid 11.7% of suggestions and lost no exact matches
(71.7% either way): every hidden suggestion was wrong.

The same 300 cases with the 3B model: 48.0% with no context and 65.0% with
the editor's context, 5.3 points above the 1.5B model. It's half as fast:
it reads prompts at about 880 tokens a second against 1,800, and writes 66
tokens a second against 123. Over 120 cases, a suggestion after typing a
character, with the prompt ready, took 372 ms against 199 ms (the median, before
the editor's 250 ms pause), and a cold prompt 2.4 seconds against 1.3.

Speculative decoding doesn't speed up the 3B model here. With the 0.5B model
drafting (`-md`, `--spec-type draft-simple`), suggestions were the same but
slower: 452–472 ms after typing instead of 372, and 2.8 seconds cold instead of
2.4. Drafting from the prompt's own n-grams (`--spec-type ngram-simple` or
`ngram-mod`) saved under 10 ms. Suggestions are short, about 10–20 tokens, and
the draft model has to read each new prompt as well, which costs more than it
saves. Without `--spec-type`, the server loads a draft model but never uses it.
To try other server options, set `LLAMA_ARGS`, for example
`LLAMA_ARGS="--spec-type ngram-simple"`; it's split on spaces, so model paths
in it can't contain spaces.

JetBrains' Mellum 4B, in mradermacher's 4-bit build (`Q4_K_M`, 2.6 GB),
scored 58.3% on the same 120 cases, against 59.2% for Qwen2.5-Coder 1.5B and
67.5% for 3B. After typing it took 209 ms, like 1.5B, but a cold prompt took
4.9 seconds. It needs `--spm-infill`, since it expects the suffix before the
prefix. Its model file declares no file separator, so the server divides extra
files with `--- snippet ---`. Declaring its `<filename>` token as the separator
(`--override-kv tokenizer.ggml.fim_sep_token_id=int:5`), as its model card
shows, scored lower (47.5%), possibly because the server names the current
file `filename`.

Pinkary (588 files, 12 models, migrated to SQLite, with one MySQL-only
collation removed from a migration) measures what koel can't: a database, and
Blade views. Lines that are only a string in a list (Pinkary has thousands of
email domains in one class) are left out of every task, since no model can
guess them. With the 3B model:

| Task and cases | No context | Full context | Full context without models' columns |
| --- | --- | --- | --- |
| Lines in PHP classes, 60 | 50.0% | 61.7% | 61.7% |
| Reading a model's column after `->` in PHP (`CASES=columns`), 40 | – | 85.0% | 87.5% |
| After `$name->` in Blade views (`blade` task), 50 | 46.0% | 68.0% | 66.0% |

So views get the models' columns and PHP classes don't.

The `js` task measures lines in koel's TypeScript and Vue scripts (60 cases):
41.7% with no context, 63.3% with similar code only, and 66.7% with the
outlines of imported files too. The outlines doubled the context, from about
760 tokens to 1,620, so a cold prompt took 3.6 seconds instead of 2.0; the
editor's warm-up on focus hides most of that. On Pinkary, hiding
suggestions the model was unsure of lost one exact match in 60 PHP cases, and
none in the Blade cases.

The `types` configuration adds the classes Phpactor finds for the names before
`->`, using Phpactor's command line (`offset:info`). koel has no `vendor/`, so
the benchmark needs Phpactor's own index first (`phpactor.phar index:build`).
Over 600 cases, the types changed the context in 71, and the exact first line
went from 43 to 44 of those (62.7% to 62.8% overall). koel imports nearly
every class it uses, so the types rarely add a class the outlines lack, and
without a database there are no model columns, where a variable's type
matters most (`$playlist->` after `$playlist = $this->service->create()`).
The types stay: they cost about 50 tokens and a Phpactor request that doesn't
delay suggestions, and they help code that gets its objects from other
classes. Blade views aren't measured: the benchmark only hides code in PHP
classes. Run the benchmark again after changing the context, the
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

Laravel LSP covers translation keys on its own (`TranslationDocumentMapper` in
the phar): completion, hover with each locale's value, definition through its
links, and a warning for an unknown key that looks like `group.key`, for
`__`, `trans`, `trans_choice`, `@lang`, `Lang::get`, and the translator's
methods, reading `lang/*/*.php` and `lang/*.json` through a booted app. It
lists values in completion only below 200 keys, and packages' keys count.

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

Inside `<script>` and `<style>`, JavaScript or CSS is an embedded language
(`scriptEmbedded.<language>`), and while a language is embedded, Monarch only
tries the rules that leave it (`nextEmbedded: "@pop"`). So each Blade construct
leaves: `{{`, `{!!`, and `{{--` switch to `bladeEchoIn`, `bladeCommentIn`, or
`bladePhpIn` with the state to return to in the name
(`bladeEchoIn.scriptEmbedded.text/javascript`), the way the PHP grammar
handles `<?php … ?>` there, and the closing token switches back with
`nextEmbedded: "$S3"`. A directive can't be read while leaving, so a known
directive name leaves with `@rematch` to `bladeDirectiveIn`, which reads it and
goes on to `bladeArgsIn` for its parentheses, or straight back. Scripts get a
list of Blade's directives, so `@` elsewhere in JavaScript stays JavaScript,
and styles get echoes and comments only, since CSS has `@media` and Tailwind's
`@apply`.

Blade formatting runs the bundled `blade-formatter` (`--stdin`) after the
project's Prettier, if it has one, reports that it can't parse the file. The
Prettier plugin for Blade (`@shufo/prettier-plugin-blade`) wraps the same
formatter but pins its own Prettier, so the formatter itself is bundled. It
brings about 70 MB of dependencies to the Node tools, mostly Tailwind 3 for
sorting classes, a PHP parser, and Linguist's language data.

#### Checking the PHP in views

`bladeToPhp` in `src/bladephp.ts` turns a view into one PHP file: a first line
of `<?php` and the view's `@use` imports, then the view with everything but
its PHP replaced by spaces, one for each UTF-16 unit, keeping line breaks. So a
problem's line, less one, and column are the view's, with no position map.
Each piece of PHP becomes a statement that starts with `;` in place of its
delimiter: `{{ $a }}` reads `;[ $a ]`, a directive's arguments `;  [$a]` (an
array, since `@include('a', [...])` is a list), a bound component attribute
`:post="$post"` reads `;[$post]`, and `@foreach`, `@forelse`, `@for`, and
`@while` keep the loop, as `;foreach (…)`, whose body is the empty statement
that follows. `@php … @endphp` and `<?php … ?>` keep their code. Only
Laravel's own directives are read, not every `@word(`, so CSS's `@media` and
text stay text, as Blade leaves unknown directives; `{{-- --}}`, `@{{`, `@@`,
and `@verbatim` are skipped. Echo delimiters are found as Blade's own regex
finds them, without reading strings.

`checkBlade` in `lsp.ts` sends that file to `mago analyze --stdin-input` with
the view's path and the editor's Mago settings, a second after typing stops,
and puts the problems under the `blade` owner. They go through `realProblems`
as a PHP file's do, then `bladeProblems` drops undefined variables, unused
statements (every echo is one), and Laravel magic and uses of `mixed` values
(`magicNoise`), since the view's variables have no types. Mago has no server
mode, so only open views are checked; the project scan reads Blade files as
PHP with inline HTML, which has nothing to report. Blade views' markers count
in the Problems panel as soon as the view is open, since no Phpactor check
has to finish first.

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

The palette's input sits where the full-height palette would be centered
(`top: max(56px, calc(50vh - 260px))`) and the list grows down from it.
Centering the box as it is would move the input on every keystroke that
changes the number of results. With `anchor`, `pick` opens as a dropdown below
an element instead, as the project and branch buttons do.

Go to file, Search everywhere, and Compare with file open the picker at once
and fill it in when `list_files` returns, instead of waiting for the project
walk first. The Pull Requests, Composer, and Database views keep their last
list on screen while they refresh, and show "Loading…" only for a new project
or filter.

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
has focus, so they don't fire while you type in the palette. An action with a
`when` function claims its shortcut only while `when` returns true; otherwise
the key reaches Monaco. Double Shift is two Shift presses within 350 ms with no
other key between them.

### Terminal

`pty.rs` opens a pseudo-terminal with `portable-pty` and runs your login shell
(`$SHELL -l`) or a given command in the project folder. A thread reads output
into a channel, and another emits it as `pty:<id>` events, then emits
`pty-exit:<id>` when the process ends. The sender joins everything waiting in
the channel into one event, so a command that prints a lot sends a few large
events instead of thousands, and an echoed keystroke still goes out at once.
Input goes through a writer thread, so pasting into a program that isn't
reading can't block the app. The reader keeps a UTF-8 character that is split across two reads until
the rest arrives, so multibyte text never turns into replacement characters.

`src/terminal.ts` shows each session as a tab in a bottom panel, rendered by
`xterm.js`, which loads with the first terminal rather than with the app. Keystrokes go to `pty_write`, and the fit add-on resizes the
pseudo-terminal whenever the panel changes size. You can drag the top edge of
the panel to resize it.

Panel tabs reorder with HTML drag and drop on the tab bar: `dragover` marks the
tab under the pointer, and `drop` moves the dragged session before it in
`sessions`, or last on the bar's empty end. The tab and terminal context menus
use `showMenu` from `files.ts`. A capture-phase `pointerdown` and `focusin`
listener records whether you last used the panel, and **Close Tab** (⌘W) calls
`closeFocusedPanelTab` first, falling back to the editor tab. Clicks count, not
only focus, because panel views such as **Tests** have nothing that takes focus.

A panel tab dropped on an editor pane leaves `sessions` for `docked` in
`terminal.ts`, still running, and `main.ts` gives it a `view:N` path in the
pane's `paths`. No file path starts with `view:`, so tab order, dragging
between panes, splitting, and closing all work on it unchanged. `renderTabs`
calls `showViews`, which puts the shown view's element inside `.pane-editor`,
over the editor, and hides the others; the editor has no model meanwhile.
`activeFile()` is `""` while a view shows, so file actions, the breadcrumbs,
and the project tree ignore it. When code calls `showPanelView` for a view in a
pane, `terminal.ts` asks the editor to reveal that tab instead of adding a
second one. `showEditorView` opens a view straight in an editor tab
(`editorOnly`), as the diff, the merge tool, and the problem page do; such
tabs have no **Move to Panel** and can't be dragged to the panel. `closeView`
closes whichever tab shows an element. A closed view's element is hidden and
moved back under `body` rather than removed, since its module finds its parts
by ID. The panel's **+** opens a terminal, and the terminal button shows the
last running shell (`isShell`: not a command's tab, such as `git pull`, and not
exited) or opens one, hiding the panel only when a shell has focus. A command
opened with the title of a finished command's tab, such as a second `git pull`,
takes that tab's place instead of adding another. The session doesn't save views in panes: `runningTerminals`
includes docked terminals, which reopen in the panel. Opening another project
moves every view back to the panel first, so `closeTerminals` reaches them, and
closes editor-only views and the Git Log.

When the app exits, the operating system closes the pseudo-terminals, and the
processes in them receive `SIGHUP`. Terminal processes don't need the language
server watchdog.

### Comments

`src/comments.ts` scans text for comments while skipping strings, so
`"http://…"` and `'# not a comment'` stay code. It knows `//`, `#` (first on a
line or before a space, so a CSS `#fff` and `#[Attribute]` don't count),
`/* */`, `<!-- -->`, and Blade's `{{-- --}}`. Heredocs and nowdocs run to the
line with their identifier. Outside PHP tags (a PHP file starts there, before
`<?php`, and returns after `?>`), text is HTML, where an apostrophe opens no
string, and only HTML and Blade comments count. `commentMask` blanks every
comment and keeps offsets, for patterns that should only see code: test
detection, type declarations (`phptypes.ts`), and AI context
(`aicontext.ts`). The TODO view reads each file with matches and masks
it whole, so a keyword on any line of a multi-line comment counts; a file it
can't read falls back to `inComment`, which judges one line alone and also
counts a line that starts with `*`, as inside a docblock. The scanner doesn't
know JavaScript regex literals, whose text counts as code.

### Tests and Run Anything

`src/phptests.ts` finds tests with regexes over the whole source with its
comments blanked out (`commentMask`), so a declaration can span several lines,
and a commented-out test gets no link: public `test*` methods, methods after
`#[Test]` or `@test`, and Pest `it()` and `test()` calls. Each test gets a
`--filter` value that matches its name at the end, with an optional data set
suffix, so `test_a` doesn't also run `test_a_twice`. PHPUnit filters are
`::method`. Pest matches `Class::description`, where `describe()` blocks come
first as `` `group` → ``, so Pest filters are `::(?:.* → )?description`. The module has no editor imports, so `src/phptests.test.ts` runs
under Node.

`src/runner.ts` adds run buttons to files under `tests/` or named `*Test.php`:
glyph-margin decorations in the right lane, with the class `test-run`, updated
300 ms after an edit. `attachTestRunner` opens the run menu on a click, and
the breakpoint click handler skips that class. With the **Show run buttons for
tests in the gutter** setting off, the decorations go and a code lens provider
shows the links instead; its `onDidChange` fires on every settings change. It and runs tests and commands in terminal tabs through
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
and so on); a failure's message is the lines after its `Test Failed` event, up
to the next `Test … (…)` event. The runner checks for
`vendor/phpunit/phpunit/src/Event`, which PHPUnit 10 added, since older
versions reject the option; they, and Pest 1, get `--log-teamcity` instead,
whose `testStarted` lines carry each test's file (`locationHint`) and whose
`testFailed` lines carry the message and, in `details`, the failing line
(`parseTeamcity`). Every 500 ms, `showLive` reads the file and redraws the
tree, keeping the test you selected. PHPUnit's events name classes, not files,
so a row opens the file the class maps to through `composer.json`'s PSR-4
folders (`autoload-dev`, read once per project, the first candidate that
exists), or else Laravel's `tests/` layout (`classFile`), and finds the test in
it with `findTests`. When the
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

### Code coverage

A coverage run adds `--coverage-clover <app cache>/clover.xml` (in Sail,
`storage/logs/editor-clover.xml`) and, outside Sail, runs the command through
`/usr/bin/env XDEBUG_MODE=coverage`. PHPUnit picks PCOV when it's loaded, so
the variable only matters with Xdebug. The report is deleted before the run,
like the JUnit one. When the process exits, `loadCoverage` in
`src/coverage.ts` reads it with `parseClover` from `src/junit.ts` and maps
the container's folder (`containerRoot`) back to the project.

Clover has no per-test data, so the run also adds `--coverage-xml` with a
folder next to the report. PHPUnit's XML coverage has an `index.xml`, whose
`<project source>` and `<file href>` give each source file's report
(`coverageIndex`), and a report per file whose `<coverage>` section lists, for
each line, `<covered by="Class::method">` for every test that ran it
(`coveringTests`). Only the index is read after the run; a file's report is
read when its model is decorated, or for **Show Tests Covering Line**, and kept
until the next run. Decorating is synchronous, so a model is decorated at once
with hit counts and again with the tests' names once its report is read.
`testOf` turns an ID into a class and a readable name: PHPUnit adds a data set
as `#<name>`, which is dropped (and the list shows each test once), and Pest's
IDs have a `P\` prefix and a method of `__pest_evaluable_` plus the description
with `_` for spaces. Choosing a test opens it through `openTest` in `testresults.ts`, which
finds the declaration with `findTests` and `sameTest`, as the Tests tab does.
The Coverage tab's folders add up the lines of the files under each folder, from
Clover; clicking one filters the file list below by path prefix.

Only `type="stmt"` lines count. Clover also lists each method's declaration
line, which is covered whenever any statement in the method ran, so showing it
would paint a green mark above an uncovered first statement.

Marks are model decorations with `linesDecorationsClassName`, the same strip
as the git change markers. Coverage takes the first 3 pixels and git markers
start at 5, so both show on a changed line. Decorations stick to their lines
as you edit, and models created later, such as a file opened after the run,
get their marks in `onDidCreateModel`.

Each line of the report is a `Mark`: its hit count, its line in the report
(`at`), and its text when first decorated. `coverage` keeps each file's marks
by their line now. 300 ms after an edit, `sync` reads each decoration's line
and `moveMarks` (in `src/junit.ts`) rebuilds the file's map: a mark whose
line's text differs from its snapshot is stale, and a deleted line's mark,
which Monaco collapses onto a neighbor, loses to the neighbor's own mark. Then
the model is decorated again, stale marks with `coverage-stale`, and the
Coverage tab renders again. A model's marks sync once more when it's disposed,
so a closed file keeps its moved lines. Per-test lookups use `at`, since
PHPUnit's per-file reports number lines as they were at the run.

The Coverage tab is a panel view (`showPanelView`) that reuses the Tests tab's
toolbar styles and the Find view's file groups (`fileGroup` in `src/search.ts`,
generic over its items). `uncoveredRanges` in `src/junit.ts` joins uncovered
statement lines into runs, splitting a run only at a covered statement, since
blank lines and comments aren't in the report. A stale line goes to it with a
count of -1, so it splits runs like a covered line, and it's left out of the
percentages. A file's text comes from its model when it's open, and otherwise
is read when its rows first show, so collapsed files cost nothing. Rendering
again keeps each file group open or closed, by the `data-path` on its row.

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

The diff view is a Monaco diff editor in an editor tab, which each new diff
reuses. A staged change compares `HEAD` with the index, and an
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
  with the file at `HEAD` (`git show HEAD:<path>`, kept as lines until `HEAD`
  moves). It trims the lines both versions share at the start and end, then
  runs a longest common subsequence on the rest. It runs 200 ms after you stop
  typing, so the markers include unsaved edits. Each change carries a `block`
  in the diff editor's line-change shape, which maps it to the HEAD lines.
  **Rollback** replaces the block's lines with HEAD's in one undoable edit.
  **Stage** diffs the index (`git show :./<path>`) against the editor text,
  takes the blocks that overlap the change, and writes the result with
  `hash-object` and `update-index`, as Stage Selected does in the diff view.
  The inline diff is a view zone below the change, with the HEAD lines
  colorized by `monaco.editor.colorize`. PHP gets an opening tag first, or it
  colorizes as HTML. The zone closes on any edit, since the changes move.
- **Inline blame.** For the cursor line, the editor shows the author, age, and
  commit message as text after the line. Blame runs `git blame --porcelain
  --contents -` with the editor text on standard input, so lines you haven't
  saved show "Not committed yet". Results are cached per file and version,
  shared by panes, and only one blame runs per file at a time.
- **Annotations.** **Annotate with Git Blame** swaps the line numbers for a
  function that returns the commit, age, and author of each line. Monaco's
  `lineNumbers` option accepts a function, so this needs no custom gutter.

### Avoiding a refresh loop

`git status` refreshes cached file information in `.git/index`. The file
watcher reports that write, which triggers another refresh, which runs
`git status` again. Every git command runs with `--no-optional-locks`, which
stops read-only commands from writing the index and breaks the loop.

### History

`src/history.ts` shows the log as a bottom panel tab (`showPanelView`), as
PhpStorm does, so the editor tabs stay in view. It
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
moving it to the Trash.

For files that aren't open, the editor has no copy of the text before the
change, so `recordExternalChanges` keeps the text after it: the next change
then finds its earlier text in the history. The watcher batch in `main.ts`
passes it every changed path without a Monaco model. It skips folders in
`EXCLUDED_FOLDERS` (such as `vendor`, `node_modules`, and `.git`), `.env`
files, and anything `git check-ignore --stdin` names, in one call per batch.
`run_capture` fails on any non-zero exit: an empty error is exit status 1 (none
ignored), and "not a git repository" means there's nothing to ignore, but any
other failure, such as a path inside a submodule, skips the whole batch rather
than copying files git may ignore. A file with no history
yet first gets `git show :./<path>`, the staged version, when it differs, named
one millisecond earlier so it sorts before the new text. Unreadable files
(deleted, binary, or not UTF-8) and files over 1 MB are skipped, and a batch
keeps at most 200 files, so a branch switch doesn't copy the whole project;
git has those versions anyway.

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
`--autostash` sets aside uncommitted changes.

A range that contains merge commits is rebased with `--rebase-merges`, since a
plain `rebase -i` would flatten them. The dialog shows git's own todo list for
that, rather than rebuilding git's labeling in the app: `mergesTodo` adds a
throwaway detached worktree in the app cache, runs
`rebase -i --rebase-merges` there with a sequence editor that copies the list
out and empties it, so that rebase ends with "nothing to do", then removes the
worktree. The project's files, index, and HEAD are never touched, and a dirty
working tree doesn't stop it. Hooks are off for both commands.
`parseRebaseTodo` turns picks into steps whose action can change and keeps
`label`, `reset`, `merge`, and `update-ref` lines verbatim in `line`, which
`rebaseTodo` writes back unchanged. Those rows can't move, and a squash or
fixup must follow a commit or a merge, not a label or reset.

An `edit` step stops the rebase with the commit applied. git then writes
`rebase-merge/amend` with the commit's hash, which `detectOperation` reads to
tell an edit stop from a conflict. git refuses `--continue` while changes are
staged at an edit stop, so **Continue** there first runs
`git commit --amend --no-edit` when `git diff --cached --quiet` finds staged
changes.

**Split Commit** at an edit stop runs `git reset HEAD~`, which leaves the
commit's changes unstaged for the Commit view's partial staging, and puts the
commit's message in the message box. `detectOperation` then finds HEAD no
longer at the hash in `rebase-merge/amend` and sets `split`: the banner says to
commit the changes in parts, Split Commit is hidden, and **Continue** stops
amending, so staged leftovers aren't folded into the last new commit (git
itself refuses to continue until they're committed).

### Stash

Stash actions use the palette. **Stash Changes…** runs `git stash push`, with
`--include-untracked` as a second choice. **Stashes…** reads `git stash list`
and offers apply, pop, drop, and show files for the chosen stash. A stashed
file's diff compares the stash's first parent (the commit it was made on) with
the stash; untracked files come from the stash's third parent.

### Worktrees

**Worktrees…** reads `git worktree list --porcelain` (`parseWorktrees`, which
skips bare repositories). A new worktree goes beside the main one, named
`<main folder>-<branch>` with `/` turned into `-`. If a local or remote branch
has the typed name, `git worktree add <path> <branch>` checks it out (git sets
up tracking for a remote branch); otherwise `-b` creates the branch from HEAD.
Opening a worktree calls `openFolder`, so it replaces the project in the window,
with its own session. **Remove** runs `git worktree remove --force` after a
confirmation, and isn't offered for the main worktree or the open one.

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
local name contains a slash. It sorts by `-committerdate`, then puts the
current branch first and local branches before remote ones. Checking out a
remote branch runs `git checkout --track`.

### Pull requests

Descriptions and comments are Markdown from other people, and the webview can
call the app's commands, such as `run_capture`, so rendered HTML is a way to
run commands on your Mac. `marked` renders them, and DOMPurify removes scripts,
event handlers, `javascript:` links, iframes, forms, image maps (`<map>` and
`<area>`, which make links out of images), and inline styles. One click
handler on the rendered block opens every link in the browser through `open`,
never in the webview. Behind that, a small Tauri plugin (`stay-in-app` in
`lib.rs`) refuses any navigation of the window away from the app's own pages,
so a link that slips through can't replace the editor with another site.

Conversation comments are `gh pr comment`, reviews are a POST to
`pulls/<n>/reviews` (see [Pending reviews](#pending-reviews)), and merges are
`gh pr merge` with `--merge`, `--squash`, or `--rebase`. A merge always asks for confirmation first, in the palette, because
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
Zones are added with `suppressMouseDown`, so clicks reach their buttons instead
of moving the editor's cursor, and the zone stops `keydown` from bubbling, so
the diff editor's keybindings don't act on text typed into the comment box.
`drawZones()` removes every zone and draws them again (threads, pending
comments, and the open form) whenever one changes, without fetching the diff
again.

**Comment on Line** uses `diffCursor()` from `git.ts`: the side you last
clicked, and the selected lines (a selection ending at column 1 leaves that
line out). The form opens under the last line. A new comment is a POST to the
same endpoint with `commit_id` (the head commit, `headRefOid`), `path`,
`line`, and `side`, plus `start_line` and `start_side` for a range; a reply is
a POST to `comments/<id>/replies`. With the cursor on a thread's line and no
range selected, the form replies to that thread.

#### Resolving, editing, and deleting

REST has no resolved state for threads, so `lineComments` also asks GraphQL
for `reviewThreads` (the first 100), through `gh api graphql` with `-F
owner={owner} -F name={repo}`, which `gh` fills in from the repository. Each
GraphQL thread is matched to its REST thread by the `databaseId` of its first
comment, which is the REST comment ID. **Resolve** and **Unresolve** send
`resolveReviewThread` or `unresolveReviewThread` with the thread's node ID. If
GraphQL fails, the threads still load, without resolve state or the links.

`me()` reads your login once (`gh api user`). `commentBlock` renders a comment,
and for your own adds **Edit** (`PATCH`) and **Delete** (`DELETE`) on its REST
path: `pulls/comments/<id>` for line comments, and `issues/comments/<id>` for
conversation comments, whose ID comes from the `#issuecomment-<id>` in the URL
`gh pr view` returns. Which comment is being edited, or waits for its delete to
be confirmed, is module state; in the diff a change redraws every zone, since
a view zone's height is fixed when it's added, and in the sidebar it redraws
the one comment.

#### Pending reviews

Pending comments live in your pending review on GitHub, so the browser and the
editor show the same one. GitHub lists a pending review only to its author, so
`loadPending` finds yours in `pulls/<n>/reviews` (state `PENDING`) and reads its
comments from `reviews/<id>/comments`. The REST API can add comments to a
review only while creating it, so the first comment creates the review (a POST
to `pulls/<n>/reviews` with the comment and no `event`, which leaves it
pending), and later ones go through GraphQL's `addPullRequestReviewThread`
with the review's node ID; a reply goes through `addPullRequestReviewThreadReply`,
since GitHub takes no comment outside a pending review while one exists.
Deleting a pending comment is a `DELETE` on the comment, and deleting the last
one also deletes the empty review. Submitting sends the verdict (`COMMENT`,
`APPROVE`, or `REQUEST_CHANGES`) and the summary to `reviews/<id>/events`;
without a pending review, a review with only the summary is created. GitHub
anchors each comment to the review's commit, so comments from before a push
become outdated there, as in the browser. `shown` remembers the diff's model,
and `drawZones` does nothing once the diff shows something else, so a slow
request can't draw threads into, say, a file's history.

An earlier build kept pending comments in `localStorage`
(`review:<repository URL>#<number>`); those aren't read or moved to GitHub,
since they were short-lived.

The conversation is one timeline, oldest first, as on GitHub: the description,
then reviews (`submittedAt`), comments (`createdAt`), and line comment threads
(their first comment's `created_at`), sorted together, each with its age (`3h
ago`, from `age` in `gitparse.ts`) and the full date on hover. Refreshing the
pull request on screen, such as after you post a comment, leaves it in place
until the new version is ready; only another pull request shows "Loading…".

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
with the file at the head commit (`headRefOid`), which matches what GitHub
shows. The fetch doesn't touch your working tree or current branch.
`prepareDiff` does this once per pull request and head commit, and the pull
request's page starts it as soon as it opens, so clicking a file usually waits
only for two local `git show` calls; when the head commit is already in the
repository and the base branch has a ref, nothing is fetched. A push changes
`headRefOid`, so the next page load fetches again. Threads draw with the diff,
and pending comments come from the pending review load the page already
started (`pendingOf` shares one request per pull request), added when it
finishes.

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

### Options and state paths

`valueCompletion` runs before the string completions. `fieldAt` finds the
field a position belongs to: the last `X::make('name')` before it, whose chain
runs to the next `::make(` or `;`. So an option set after the cursor, as in
`->default('')->options(Status::class)`, still counts, and a `;` inside a
closure in the chain ends it early. `fieldEnum` takes the enum from
`->options(X::class)` or `->enum(X::class)`, resolving `X` through the file's
`use` statements and namespace, or else from the model's cast of the field
(`describeModel` reports `getCasts()`). `introspect.php enum <class>` lists
the cases with `cases()`; a class that isn't an enum returns an error, which
also filters casts such as `datetime`. Completions insert the enum's short
name when the file imports it or shares its namespace, and the fully qualified
name otherwise. `$get('…')` and `$set('…')` offer every `::make()` name in the
file, from the text alone. `(` is a trigger character, so `->options(` opens
the list without a keystroke; every other `(` in PHP gets an empty answer from
a few regexes.

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
| `terminals`, `panel` | The running shells (title and folder) and restorable commands (title, folder, and command), each with its earlier output (`scrollback`), and whether the panel showed. Older sessions have `shells`, a count of shells. |
| `debugging`, `profiling` | Whether the debugger listened (`isListening`), and whether the profiling server ran (`profilingServerRunning`) |

The editor saves 500 ms after a change (tabs, cursor, scroll, folders, or
sidebar view), when the page unloads or the window loses focus, and before it
opens another folder. Quitting with ⌘Q doesn't unload the page, and terminal
output and panel tabs change without editor events, so a terminal printing or
the panel's tabs changing (`onPanelChange` in `terminal.ts`) also saves within
a second. That save is throttled, not debounced, so a dev server that keeps
logging still gets saved. When it opens a folder, it expands the saved folders,
reopens the tabs, skips files that no longer exist, splits the panes again,
and reopens the terminals, after the language servers start.

A shell reopens in its last folder. `terminal.ts` can't see `cd`, so 500 ms
after you press Enter in a shell, it asks for the shell process's working
directory with `pty_cwd`, which calls macOS's `proc_pidinfo` with
`PROC_PIDVNODEPATHINFO` (no subprocess). A folder that no longer exists falls
back to the project folder.

Each reopened terminal writes its earlier output before its process starts,
followed by a dimmed `[Restored from the last session]` line. `scrollbackText`
in `src/scrollback.ts` reads xterm.js's normal buffer (not the alternate one
that `vim` or `less` draws on) as text: it joins the lines the terminal wrapped,
so they wrap again at the new width, drops trailing blank lines, and keeps the
last 50,000 characters, from a line start. With xterm.js's default of 1,000
lines of scrollback, that's most of a terminal's output. If `localStorage` is
full, `saveSession` saves the session again without the output, so the tabs
aren't lost.

A command tab comes back only if its caller opened it as restorable and it was
still running: Run Anything commands that keep running until stopped
(`LONG_RUNNING` in `runner.ts`: `artisan serve`, queue workers, Horizon,
Reverb, `npm run dev` and other dev or watch scripts, `vite` but not `vite
build`, and `sail up` or `docker compose up`), Tinker, and **Start Debug
Server**'s `artisan serve`. `openFolder` closes
every terminal (`closeTerminals`) once the old project's tabs have closed, so
one project's servers never land in another's session. Tests, git and Composer commands, and anything that
had finished don't run again, since repeating them unasked could push, rebase,
or change packages.

The debugger and the profiling server come back through their own start
functions, not as saved commands, because each sets up state first: the
debugger starts its adapter and listens, and the profiling server writes its
PHP settings and picks a free port. `openFolder` calls `startDebugging` and
`startProfilingServer` before it reopens the terminals, when the session's
`debugging` or `profiling` is set. The profiler loads only when used, so
`profiling` is false while it hasn't loaded. The profiling server's tab clears
`server` when its process exits or the tab closes. Restoring these tabs shows
the panel, so `openFolder` hides it again (`hidePanel`) if it was hidden.

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

## JSON schemas

`jsonschemas.ts` feeds Monaco's JSON worker its schemas through
`jsonDefaults.setDiagnosticsOptions({ schemas, enableSchemaRequest: false })`.
The bundled schemas live in `src/schemas`, fetched and minified by
`scripts/fetch-schemas.ts`, and load as separate chunks with the first JSON
model. Each one's `uri` is its `$id` or published URL, so a `$schema` or a
`$ref` naming that URL resolves to the bundled copy. The script replaces a
`$ref` to a schema that isn't bundled (package.json's refs to nodemon, ava,
stylelint, and others) with `{}`, since an unresolved one shows as a warning on
line 1 of every file using the schema. For a `$schema` that's a path
(`localSchemaPath` in `links.ts`), the worker resolves it against the file's
URI; the client reads that file, adds it under the same `file://` URI, and
updates it as you edit it in an open tab.

## Formatting (frontend step 2)

`src/format.ts` registers one formatting provider for PHP, Blade, JavaScript,
TypeScript, CSS, SCSS, Less, JSON, HTML, Markdown, YAML, Vue, Svelte, and
Astro. It pipes the
file's text through a formatter with `run_capture` in the project folder, so
each formatter finds the project's configuration:

1. Prettier (`node node_modules/prettier/bin/prettier.cjs --stdin-filepath`),
   the project's when it has one, and otherwise the bundled one from the Node
   tools, with `--plugin` pointing at the bundled `prettier-plugin-svelte` and
   `prettier-plugin-astro` for those two languages. The bundled Prettier skips
   PHP and Blade, since it has no plugin for them, which saves starting Node.
   If Prettier reports that no parser could be inferred for the file, the next
   step runs.
2. For PHP, Laravel Pint (`vendor/bin/pint - --stdin-filename`), when the
   project has it.
3. For PHP, the bundled Mago (`mago format --stdin-input`).

`detectFormatters` looks for Prettier and Pint when a folder opens. Monaco's
own formatters for CSS, HTML, JSON, and TypeScript are always off
(`setModeConfiguration`), since a Prettier is always there and they would
otherwise compete for those languages.

`node-tools/package.json` pins Prettier and the two plugins directly, rather
than relying on the copies the Svelte and Astro servers pull in. The Astro
plugin needs Prettier 3.5.3 or later, while the Svelte server asks for 3.3.x,
so npm nests 3.3.3 under the Svelte server and the newest 3.x is at the top. Monaco turns each whole-file result into minimal edits, so the cursor
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
model.

The Svelte server (`svelte-language-server`) and the Astro server
(`@astrojs/language-server`, built on Volar) start the same way, with their
first `.svelte` or `.astro` model. Unlike the Vue server, each runs TypeScript
itself, so nothing is forwarded to vtsls. Svelte's server has its own
TypeScript; Astro's gets the bundled TypeScript's `lib` folder as
`typescript.tsdk`. For the other direction, a `.ts` file importing a component,
vtsls loads `typescript-svelte-plugin` and `@astrojs/ts-plugin` from the
bundled tools, next to the Vue plugin. Svelte's server reports a missing Svelte
config in `vite.config` as an error on line 1, which is right for a Svelte
project and harmless in a Laravel one that has a stray `.svelte` file. With
Prettier and `yaml-language-server` (Astro's frontmatter), these add about
60 MB to the bundled Node tools.

The Angular server (`@angular/language-server`) starts only when the project's
`package.json` names `@angular/core`, with the first `typescript` or `html`
model, and serves both: `.html` templates and inline `template:` strings in
components. It runs next to vtsls, not through it, and Monaco merges their
answers. `lsp_start` passes `--tsProbeLocations` (the project root, then the
server's folder) and `--ngProbeLocations` (the server's folder), so the server
prefers the project's TypeScript and falls back to its own nested 6.0.3, and
always uses the bundled `@angular/language-service`. Its `angular/…` progress
notifications are ignored. While vtsls runs, Monaco's built-in TypeScript features are turned off,
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

A breakpoint can also be `disabled`; it stays in the gutter and in storage but
isn't sent. **Run to Line** sets a temporary breakpoint in `runTo`, which
`setBreakpoints` adds for that file until the next `stopped` event, when the
file's breakpoints go out again without it.

The gutter's context menu comes from Monaco's `onContextMenu` for the glyph
margin, line numbers, and line decorations, where Monaco shows no menu of its
own. `debug.ts` supplies the breakpoint items and `main.ts` adds blame,
Copy Reference, and Copy Remote URL. The link uses `git ls-remote --get-url` (the branch's remote,
or `origin`), the HEAD commit, and `git rev-parse --show-prefix` for a project
inside a larger repository; `remoteLineUrl` in `gitparse.ts` turns SSH and
HTTPS remotes into GitHub and GitLab `blob` links, or Bitbucket `src` links.
If no remote branch contains HEAD, the status bar says to push first.

Watches are a list of expressions per project in `localStorage`. After a frame
is selected, each one goes to `evaluate` with the `watch` context, and the
result renders with the same row as a variable, so objects expand.

Pause on exceptions sends exception filters. The adapter makes each filter an
Xdebug exception breakpoint on that class name, whatever the name (its own
filter list, such as `Notice`, is only what it suggests), and Xdebug also
matches subclasses. Without chosen classes the filters are `Exception` and
`Error`, which cover every `Throwable`. Turning it on or off is app-wide; the
classes and the other options are per project, all in `localStorage`.

Xdebug pauses at the throw, before PHP searches for a catch, and DBGp has no
notion of caught, so **Only uncaught** pauses where an uncaught exception
ends up instead. PHP turns one into an `E_ERROR` named `Fatal error`, and
Xdebug matches exception breakpoints on PHP error names too, so the filter
becomes `"Fatal error"`. The quotes are part of the name: the adapter writes
the filter unquoted into `breakpoint_set -x`, and Xdebug rejects a bare space.
At that pause the stack has unwound and the adapter can't evaluate, so the
class comes from the message (`uncaughtClass`) and matches by name only.
Laravel catches every exception itself, so for Laravel projects
`findHandler` reads `vendor/.../Foundation/Exceptions/Handler.php` when the
debugger starts, and `handlerLines` finds the first statement of `render` and
`renderForConsole`. `sendBreakpoints` adds a breakpoint there whose condition
is `$e instanceof \Class || …` for the chosen classes, so subclasses count.
When execution stops on one, `exceptionPause` evaluates `$e`'s class,
message, file, and line for the log.

**Skip exceptions thrown in** is checked by the client, since the adapter's
own `ignore` globs are a `launch` argument that can't change mid-session. On
an exception pause, `exceptionPause` matches the top frame's path (the
throw, or the file PHP's fatal error names), or at Laravel's handler,
`$e->getFile()` mapped to a local path, against the patterns with
`globToRegex` from `editorconfig.ts` (`thrownIn`), and resumes without
showing the pause when one matches.

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
that mentions Laravel Sail maps `/var/www/html`, and another Compose setup maps
where its service mounts the project.

`src/sail.ts` decides where commands run, as a `Container` whose `exec` turns
a project command (`php …` or `vendor/bin/…`) into a command line. A project
uses Sail when `vendor/bin/sail` exists and a compose file mentions Sail's
images, and Sail is running when `docker compose ps --status running --quiet`
prints anything. Sail's `exec` goes through Sail's own commands (`sail
artisan`, `sail php`, `sail bin`, and `sail debug` for Artisan with Xdebug),
which pick its app service.

Otherwise, `docker compose config --format json` gives the resolved services,
with absolute bind-mount sources, and `servicesMounting` keeps those that
mount the project folder or a folder above it; the mount's target plus the
rest of the path is where the project is inside. A service whose name or image
mentions PHP, `app`, or `laravel` is picked on its own; a service that only
mounts the project, such as a Node container for Vite, is used only when you
choose it, since it may have no PHP. **Choose Docker Service for Commands…**
reads the compose files again and saves a choice per project in `localStorage`
(`docker:service:<root>`), or `""` for this Mac. The config is kept per project
once read; a failed read isn't kept, so a compose file added later is found. The service runs
commands when `docker compose ps --status running --services` lists it, through
`docker compose exec -w <workdir> <service>`, with `-T` for captured output
such as `route:list --json`, and `-e` for Xdebug's variables. Both checks run
on every command, so starting or stopping the containers takes effect at once.

In a container, test runs write the JUnit report to
`storage/logs/editor-junit.xml`, which the container can write and git
ignores. `containerRoot` holds where the last container mounted the project,
and the Tests and Coverage tabs map it in reported paths back to the project.

The Debug tab lives in the bottom panel: `showPanelView` in `terminal.ts` lets
any element be a panel tab next to the terminals.

## Profiler

`src/profiler.ts` runs PHP with `XDEBUG_MODE=profile`, `XDEBUG_TRIGGER=1`, and
`XDEBUG_CONFIG=output_dir=<app cache>/profiles
profiler_output_name=cachegrind.out.%t.%p`. The environment reaches child
processes, which matters because `php artisan test` runs PHPUnit in a new
process. That writes two profiles, so after a run, the editor opens the
largest one written since the run started. The profiling server runs PHP's
built-in server with Laravel's `server.php`, as `artisan serve` does, instead
of `artisan serve` itself, because `serve` passes only some variables to the
server it starts and `XDEBUG_TRIGGER` isn't one of them. `server.php` finds
`public` from the working directory, so the server runs there.

The parser also sums each caller-to-callee pair's calls and time from the
`calls=` lines, and inverts them for callers. That's one entry per pair of
functions that called each other, not per call, so it stays small even for
millions of calls. The side pane of the Profiler tab lists these pairs.

The parser also sums the time of the calls made from each line (a `calls=`
line's cost line gives the call site), by the caller's file. The editor shows
these at the end of lines as injected text (`after` decorations). Their range
is empty, so they need `showIfCollapsed: true`; without it, Monaco keeps the
decoration but never draws it.

Memory comes from the second event, `Memory_(bytes)`. Xdebug measures it as
the growth in memory use over a call, so the own amounts don't add up to a
caller's, and the table shows only the total, counted like total time.

Profiles parse in Rust (`parse_profile` in `src-tauri/src/profile.rs`). A long
test's profile can be gigabytes of text: Rust decompresses it and reads it
line by line, so it never has to fit in memory, and a 1.6 GB profile parses in
about 7 seconds in a release build. Names are interned, so functions and files
are indexes while parsing. The result refers to functions by index, and
`fromRaw` in `src/cachegrind.ts` turns those into references.

Profile URL starts the profiling server when this session hasn't, or when its
port no longer answers, and requests the path with `curl`. Xdebug finishes a
profile when PHP shuts the request down, just after the response is sent, so
the editor waits until the newest profile stops growing before opening it.

With text in the filter, the call tree turns into back traces: the matching
functions are the roots, and a node's children are its function's callers.
Walking down from the root instead, through every function that can reach a
match, explodes in a Laravel app, where nearly everything passes through the
same pipeline and container functions. A caller row in a back trace shows no
time, because the pair's time is its own call to the row above, not time spent
reaching the match.

The totals above the table (Database, Autoloading, Views, HTTP calls, Redis)
sum the total time of known functions: PHP's `PDO` and `PDOStatement` methods,
Composer's `ClassLoader->loadClass`, Laravel's `View->render`, `curl_exec`, and
`Redis` methods. They add up without counting anything twice, because PHP's own
functions don't call each other and a function's total counts nested calls to
itself once. Queries count calls to `PDOStatement->execute`, `PDO->exec`, and
`PDO->query`.

Comparing matches functions by name between two profiles. A function the other
profile didn't run counts in full, and one that only the other profile ran
doesn't show. The editor names its profiles (the request or test) in
`localStorage` by path, since the files only carry the script Xdebug saw.

The call tree and the flame graph use the real tree of calls, with calls along
the same path merged: a node is a function under one path from the root. The
parser builds it with the same post-order claiming: a finished block becomes a
node and adopts its callees' nodes, merging those of the same function (and
their subtrees). A Laravel request has 20,000 to 30,000 such nodes, and every
node's children add up to no more than the node. When a profile opens, the tree
opens along the busiest child while it takes at least a tenth of the run.

The flame graph draws each node wider than a pixel as an absolutely positioned
`div`, about 1,300 for a Laravel request, and redraws when the panel resizes.
Zooming keeps the zoomed node's ancestors as full-width bars above it.

Queries come from a second Xdebug mode, tracing, run with the profiler
(`XDEBUG_MODE=profile,trace`). A trace of a whole request would be far larger
than its profile, so a file PHP runs first (`auto_prepend_file`) calls
`xdebug_set_filter` to keep only calls made from Laravel's
`Illuminate/Database/Connection.php`: about 400 lines for a request. The
settings live in an `.ini` file in the app cache, added through
`PHP_INI_SCAN_DIR` so that processes a run starts (PHPUnit under
`artisan test`) get them too. The variable replaces PHP's own scan folders, so
the editor reads them from `php --ini` and keeps them in front.
`XDEBUG_CONFIG` doesn't accept `trace_output_name`, so the trace's name is in
the `.ini` file too: `trace.%t.%p.%R`, matching its profile.

`parseSqlTrace` reads the tab-separated trace format: each `Connection->run`
entry holds the SQL and bindings as its first two arguments, in Xdebug's PHP
notation, and the exit record with the same call number gives its end time.
`groupQueries` groups by SQL and flags duplicates (same bindings more than
once) and repeats (three or more different bindings).

`hotSpots` sums own time (a node's time less its children's) per function over
a node's subtree, for the zoomed flame graph.

Profile names use Xdebug's `%R`, the request URI, which is empty on the command
line. The editor turns its underscores back into slashes to name a browser
request.

After a profiling run, the editor keeps the newest 50 profiles in its folder and
deletes older ones, since a Laravel request's profile can be several megabytes.
The profiling server checks ports from 8000 with `lsof` and takes the first
free one.

Xdebug gzips profiles by default. `flate2` decompresses them as they're read.
The SQL traces next to them are smaller and still go through macOS's
`/usr/bin/gzip -dc` and `run_capture`. `stat -f "%m %z %N"` lists
profiles with their time and size.

`parse` in `src-tauri/src/profile.rs` reads the format line by line. Xdebug
writes one block per call, after the call returns, so blocks come in post-order:
a block's callees are the last blocks no caller has claimed yet, one per
`calls=` line. Each block
carries a map from function to the time of that function's outermost calls in
its subtree. A caller merges its callees' maps (into the largest one) and sets
its own entry, which replaces any nested calls to itself. The roots' maps give
each function's total time with recursion counted once, direct or through other
functions, such as Laravel's middleware pipeline. On a real Laravel request,
every function's own time adds up to exactly the total, and a 700,000-line
profile parses in about 100 ms.

## Database

`src-tauri/src/db.rs` has `db_query`, which runs one statement and returns
column names, rows, and the number of changed rows, `db_batch`, which runs
statements in one transaction, and `db_tunnel`, for SSH. Every value comes
back as text or null, which is all the grid needs, so no driver's type mapping
leaks into the frontend:

| Driver | Crate | How values become text |
| --- | --- | --- |
| SQLite | `rusqlite` with its bundled SQLite | Each `ValueRef` is formatted. Blobs show their size. |
| MySQL, MariaDB | `mysql`, with `native-tls` | The text protocol (`query_iter`) returns every value as bytes. |
| PostgreSQL | `postgres`, with `postgres-native-tls` | The simple query protocol returns every value as text. |

TLS goes through `native-tls`, which is macOS's Security framework, so the
system's certificate authorities apply. `ssl_mode` follows libpq: PostgreSQL
defaults to `prefer`, which tries TLS and falls back to plain text; `allow`,
`prefer`, and `require` accept any certificate, as libpq does, `verify-ca` checks the
certificate but not the host name, and `verify-full` checks both. A CA file
may hold a bundle of certificates, as AWS RDS's does; each is trusted. MySQL
connects with `CLIENT_FOUND_ROWS`, so an `UPDATE` reports the rows it matched
rather than only those it changed, and a grid edit that sets a cell to an equal
value (`10.5` for `10.50`) still counts as one row. MySQL turns
TLS on with a CA file (`MYSQL_ATTR_SSL_CA`, the only TLS setting in Laravel's
MySQL config) or with `DB_SSLMODE` set to `require` or stricter.

`db_tunnel` runs the system's `ssh -N -L 127.0.0.1:<free port>:<host>:<port>
<destination>` under the same watchdog as the language servers, so it ends with
the app, and waits up to 15 seconds for the local port to accept connections.
`BatchMode=yes` makes a password prompt fail at once instead of hanging,
`ExitOnForwardFailure=yes` makes a failed forward end ssh, whose error message
is returned, and `ServerAliveInterval` ends a tunnel whose connection died,
such as after the Mac sleeps, so the next query opens a new one. Once the
tunnel works, a thread keeps reading ssh's error output, which would otherwise
fill its pipe and stop ssh. Tunnels are kept per destination and address, and reused while
ssh runs. `database.ts` keeps the destination per project and connection in
`localStorage` (`db:ssh:<root>` for `.env`'s, `db:ssh:<root>#<name>` for
another) and connects to the tunnel's port instead of the connection's.

Besides `.env`'s connection, `database.ts` offers saved ones and
`config/database.php`'s. Saved connections are a JSON list of names and URLs in
`localStorage` (`db:connections:<root>`), with the selected name in
`db:connection:<root>`. Passwords aren't in the URL: `db_password` and
`db_set_password` in `db.rs` keep them in the login Keychain as generic
passwords (service `Tusk database`, account `<root>#<name>`), through the
`security-framework` crate that `native-tls` already builds. `connectionFromUrl`
and `connectionUrl` in `dbconfig.ts` read and write the URLs, in the form
Laravel's `DB_URL` takes. `config/database.php`'s connections come from booting
the app with `php -r`, once per project (again on **Refresh**) and in the
background when the tool window loads, so the switcher opens at once. The
default connection is skipped, since `.env` gives it, and so is a connection
that only repeats `.env`'s `DB_` values under its own driver (`repeatsEnv`),
which is what Laravel's stock `mysql`, `mariadb`, and `pgsql` entries are.
Their passwords come from the booted config each time and are never stored.
A selected connection that no longer exists falls back to `.env`'s.

Each query opens a new connection and runs on a blocking thread, so a slow
server doesn't stall the app. Results come in pages of 1,000 rows. A table's
page is `LIMIT 1001 OFFSET n` in its SQL (the extra row tells whether there's a
next page), and its count is a `COUNT(*)` that fills in after the rows show.
For any other statement, `db_query` takes an `offset`, skips that many rows,
and returns `total`, every row the statement returned: MySQL's driver drains
the rest of a result anyway, and PostgreSQL's simple query protocol buffers it,
so counting costs nothing more. **Next** and **Previous** are disabled while
the grid has pending changes.

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

Grid edits are pending until **Submit**, as in PhpStorm. `makeEditable` keeps
new values by row and column, rows to delete, and rows to add, and
`statements()` turns them into SQL: one `DELETE` per deleted row first, so a
row edited to take a deleted row's key doesn't collide with it, then one
`UPDATE` per edited row, with every value as a string literal that the
database converts to the column's type, then one `INSERT` per new row, with only the
columns you filled in so the rest get their defaults (`DEFAULT VALUES`, or
`() VALUES ()` on MySQL, when none are filled in). Rows are found by their
primary key (`primaryKeyQuery`), using the values from before the edit, so
changing a key column still finds the row, and a row's edits share one
`UPDATE` for the same reason. Submit sends them to `db_batch` with
`one_row_each`: a statement that changes no row or several rolls the whole
batch back. Afterwards the grid's query runs again to show the result; Revert
runs it again without submitting.
`statementAt` finds the statement around the caret by splitting on semicolons,
and skips statements that are only comments. Results use `showPanelView`, like
the debugger.

## Bookmarks, snippets, and other small tools

- **Bookmarks** (`src/bookmarks.ts`) work like breakpoints: lines per file,
  saved in `localStorage` under `bookmarks:<project>`, and drawn as decorations
  on open models so they follow edits. They sit in the glyph margin's left lane,
  so a line can show a bookmark and a breakpoint together. Line changes from
  edits are saved on each change.
- **Snippets** (`src/snippets.ts`) come from `snippets.json` in the app's
  config folder, in VS Code's format. One completion provider for every
  language (`"*"`) filters them by `scope`. While the file is open in a tab, the
  provider reads the tab's text, so changes apply without a save or reload.
- **Postfix completion** is a second completion provider in `src/snippets.ts`,
  for PHP. `postfixStart` in `src/postfix.ts` walks back from the dot over
  names, `->`, `?->`, `::`, and bracket groups to find the expression, and
  rejects a bare word, so a sentence's period offers nothing. Each item's range
  starts at the expression and its `filterText` is `expr.key`, so Monaco
  filters on what you typed after the dot and replaces the expression with the
  template.
- **TODO** (`loadTodos` in `src/search.ts`) is a sidebar view that reuses
  `search_text` with a case-sensitive regex, so it respects `.gitignore` and
  the 20,000-match limit. `inComment` from `src/comments.ts` then keeps the
  matches that start inside a comment on their line. It shares the Find view's file groups
  (`fileGroup`), and reloads after file changes while it shows.
- **Routes** (`showRoutes` in `src/runner.ts`) parse `artisan route:list
  --json`. `routeTarget` in `src/phptypes.ts` reads the action; the class is
  found through composer.json's PSR-4 folders first (fast, and works before
  indexing ends), then through Phpactor's workspace symbols for `vendor`
  classes.
- **Tinker** is a terminal tab running `artisan tinker`, in Sail when it's up.
- **Compare with Clipboard** reads the clipboard with `pbpaste` through
  `run_capture`, because WebKit asks for permission on
  `navigator.clipboard.readText`. Both comparisons use the git diff view.

## Interface

### Layout

`index.html` lays out a title bar, a workbench (the tool bar, the sidebar, and
the editor area), and a status bar. The window has no native title bar
(`titleBarStyle: "Overlay"` in `tauri.conf.json`): macOS draws its window
buttons over the left edge of `#titlebar`, which starts its content 80 px in.
Empty parts of the title bar carry `data-tauri-drag-region`, so dragging them
moves the window; that needs the `core:window:allow-start-dragging` permission.

As in a native app, the interface's text can't be selected: `body` has
`user-select: none`, which WebKit reads only as `-webkit-user-select`, so every
rule sets both. Text worth copying opts back in: fields, comment and message
bodies, test failures, database cells, and hovers; Monaco and xterm.js handle
their own selection. Drag handles call `preventDefault` on `mousedown`, so a
resize never starts a selection. Long paths in right-to-left boxes (which put
the ellipsis at the start) begin with a left-to-right mark, or bidi rules move
a leading dot to the end (`.env.example` showed as `env.example.`).

### Styles and themes

`styles.css` defines colors, sizes, and fonts as variables on `:root`, with a
light set under `data-theme="light"`. Components use only the variables, so a
theme is one block of values, and other color themes override them on the
root element (see [Color themes](#color-themes)). `src/themes.ts` defines
matching Monaco themes, `editor-dark` and `editor-light`, with syntax colors
close to PhpStorm's schemes.

Buttons share one neutral style (a bordered button that shades on hover and
while pressed), with `.primary` for a dialog's main action. Selects draw one
chevron instead of macOS's up-and-down arrows. Popovers (the palette, menus,
dialogs, and toasts) have a hairline border mixed from `--text`, so they stand
out from a dark background in every theme. Each view in the sidebar scrolls as
a whole and its parts don't shrink, so a line above a long list keeps its
height.

Icons come from Monaco's icon font (codicons), which the page already loads, so
there's no icon dependency. Monaco's `.codicon[class*='codicon-']` rule sets
the icon size with high specificity, so the stylesheet uses `!important` where
it changes a size. `src/icons.ts` maps file and folder names to a codicon and a
color class; `src/icons.test.ts` covers it. Folders such as `vendor`,
`node_modules`, and `storage` are dimmed, as PhpStorm marks excluded folders.

### Breadcrumbs

`src/breadcrumbs.ts` follows the file's path in the status bar with the
symbols that enclose the cursor, outermost first. It asks Monaco's
`IOutlineModelService`, the internal service that sticky scroll uses, for the
file's outline. The service caches one outline per model version and merges
every server's document symbols, so breadcrumbs usually cost no request of
their own. The bar redraws 100 ms after the cursor stops moving, or 600 ms
after an edit: a new outline is a `textDocument/documentSymbol` request to
every server, and Phpactor first gets the whole file (see
[Full-document syncs](#performance)), so the longer wait keeps typing from
triggering one on every pause.

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

## Performance

These rules keep typing and file events cheap. Break one only with a
measurement.

- **Nothing blocking runs on the main thread.** In Tauri 2, a command that
  isn't `async` runs on the main thread, which also draws the window and
  handles every other command. File, process, and search commands run on the
  blocking pool (`blocking` in `lib.rs`); quick checks use
  `#[tauri::command(async)]`. Writes to a language server or a terminal go
  through a writer thread per process (`lsp_send`, `pty_write`).
- **Batch events at the source.** The watcher gathers paths for 50 ms, and the
  terminal joins output that piles up while an event is sent.
- **Per keystroke, do only what changed.** An edit updates its tab's unsaved
  dot (`showDirty`) instead of redrawing every tab bar, and the status bar
  listens to one cursor event and counts a selection with
  `getValueLengthInRange`. Conflict shading, change markers, blame, the inline
  problem, and the Problems panel wait for a pause.
- **Load rarely used code on first use.** `xterm.js`, `marked` and DOMPurify,
  and the profiler are separate chunks, which took the main bundle from 4.53 MB
  to 4.10 MB. Monaco is the rest of it.
- **Open a project in parallel.** The tree and the watcher start together,
  saved tabs are read at once, the language servers' setup checks run in one
  `Promise.all`, and the servers start before saved terminals reopen. Settings
  load before the project opens, so the servers start once, with the right
  settings.

### Measuring typing

Measure in the running app with a large file, such as a copy of Laravel's
4,800-line `Query/Builder.php`. Time `editor.trigger("keyboard", "type")` per
character, and wait between characters with a `MessageChannel` loop rather than
`setTimeout`. While the app is behind another window, macOS App Nap stretches
its timers to a second or more, and animation frames stop entirely, so timers
and `requestAnimationFrame` measure App Nap instead of the editor.

| Per keystroke, 4,800-line PHP file | Before | After |
| --- | --- | --- |
| Synchronous work, median (AI on) | 18 ms | 3 ms |
| Synchronous work, 95th percentile (AI on) | 26 ms | 9 ms |
| Longest event-loop stall | about 1 s, repeatedly | 28 ms |
| Whole-file copies sent to Phpactor per 55 keystrokes | 55 | 9 |

A bare Monaco editor with the same file takes 2 to 7 ms per keystroke in
development builds, so most of what's left is Monaco's own work.

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
with. Managed tools are pinned, verified by checksum, and work offline once downloaded. PHP is
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

### 2026-09-25: Small tools in the palette, except TODO

Bookmarks and routes list in the palette instead of sidebar views. The palette
already filters, ranks, and opens results, so each tool is a few lines, and
you usually glance at these lists and leave. TODO comments get a sidebar view,
because you work through them one by one and want the list to stay open.

### 2026-09-25: Clover for coverage, regex-parsed

PHPUnit and Pest write Clover, Cobertura, PHP, HTML, XML, and text coverage.
Clover is flat (a file, then its lines with hit counts), so the same regex
approach as the JUnit report reads it without an XML parser. The PHP format
would need PHP to read it back, and HTML and text are for people. Clover has
no per-test data, so runs also write PHPUnit's XML format for which tests ran
each line, read lazily, file by file; its `<coverage>` sections are regular
enough for the same regex approach.

### 2026-09-25: A function table first, then the merged call tree

PhpStorm's profiler shows execution statistics (a function table) and a call
tree. The table answers the common question, "where does the time go?", in one
sortable list, so it came first. Keeping every call would cost memory for
millions of calls, but merging calls along the same path keeps the tree at tens
of thousands of nodes for a Laravel request, which is small enough to keep for
the call tree and the flame graph.

### 2026-09-25: Trace queries with Xdebug, not with the app

Listing a request's queries needs their SQL, which a profile doesn't have. A
listener in the app (`DB::listen`) would need a change to the project, or code
run before Laravel exists, which can't register one. Xdebug's tracing needs
neither: filtered to Laravel's connection class, it records each query's SQL,
bindings, and time from outside the app, for web requests and tests alike. The
cost is an `auto_prepend_file` during profiled runs, which replaces the
project's own for those runs.

### 2026-09-25: Coalesce full-document syncs instead of switching servers

Phpactor, Laravel LSP, Tailwind, and the Filament server only accept whole
documents. Sending one on every keystroke let Phpactor fall minutes behind on a
large file, and the blocking write then froze the window. Holding edits until a
150 ms pause, and sending them before any other message, keeps every answer
current while sending a fraction of the text. Servers that accept ranges get
each edit as it happens.

### 2026-09-25: Bundle converted VS Code and TextMate themes

VS Code has the largest set of color themes, and their format (UI colors plus
TextMate token scopes) also covers TextMate and Sublime Text themes.
tm-themes (from Shiki) collects 65 popular ones with their licenses, and
monaco-themes adds the classic TextMate themes, so the app bundles both
instead of downloading themes. Importing a file covers every other theme.
Monaco's grammars don't emit TextMate scopes, so each theme is converted by
role (keyword, string, variable) rather than scope by scope. Using TextMate
grammars in Monaco instead (with Shiki or vscode-textmate and Oniguruma) would
match VS Code's colors exactly, but would replace every language's grammar,
including the Blade and HTTP grammars, and add a WebAssembly regex engine.

### 2026-09-25: Instant feedback over animation

To make the app feel quicker, the editor scrolls and moves the caret without
animation (Monaco's `smoothScrolling` and `cursorSmoothCaretAnimation` are
off), as in PhpStorm; the animated caret trailed each keystroke. Buttons shade
while pressed. Measured in the dev app on a 1,400-file project, startup to a
restored session took about 170 ms and a tab switch about 20 ms, so neither
changed. Go to file took about 55 ms to appear, waiting on the project walk; it
now appears in 1 to 2 ms. The file list isn't cached: the watcher doesn't say
whether a change added or removed a file, and Laravel's log writes would clear
a cache constantly.

### 2026-09-25: F2 goes to the next problem

F2 and ⇧F2 go to the next and previous problem, as in PhpStorm's keymap,
instead of Monaco's F2 rename; ⇧F6 renames. F8 and ⇧F8, VS Code's keys for the
same move across files, stay with the debugger while it's paused and reach
Monaco otherwise. Errors aren't visited before warnings: Monaco's widget walks
markers by position, and a wrapper that skips warnings can wait until the plain
order proves insufficient.

### 2026-09-25: Spelling has a squiggle of its own

Monaco styles markers by severity only, so spelling problems looked like any
other information. Their markers are now hints with the deprecated tag, which
Monaco draws without a squiggle, and a decoration per marker draws a green wavy
underline, as PhpStorm marks typos. The decorations follow marker changes, not
the server's publishes, so they clear with the markers. As hints, spelling
problems are skipped by F2 and F8, and don't mark the scrollbar.

### 2026-09-25: Problems show their checker and rule

Problem popups and Problems panel rows show `source(code)`, as VS Code does,
which reverses the earlier choice to show only the code. The label tells Mago's
analyzer from its linter and names the rule to turn off in `mago.toml`. It
shows even when only one checker reports, since `mago` and `mago-lint` would
make most PHP files count as several checkers anyway. The user confirmed
keeping the checker's name after trying it.

### 2026-09-25: Commands that answer problems count as quick fixes

A bare `Command` from `textDocument/codeAction` gets the kind `quickfix` when
problems overlap the range, so it shows in the hover's Quick Fix link. The
request sends the markers' filtered diagnostics, kept per model
and server, instead of matching Monaco's markers back to the server's raw
diagnostics by range, code, and message.

### 2026-09-25: Mago's fixes come from Mago, on request

The client runs `mago lint` itself for fixes, since Phpactor's extension drops
them, but only for requests the user makes with a lint problem in range, not
for the light bulb's automatic requests as the caret moves. Suppression uses
`@mago-expect` rather than `@mago-ignore`, so Mago reports the comment once
it's no longer needed. There's no action that turns a rule off in `mago.toml`:
the rule label in the popup names the rule, and a project-wide change is
better made in the file.

### 2026-09-25: Scan Project ignores the Phpactor cache

Phpactor's cached results are keyed by a hash of each file's text, but a
file's problems also depend on the classes it uses, so a change in one file
can leave another file's cached results wrong. **Scan Project** ignores the
cache and runs Phpactor on every file, which takes a few minutes on a large
project. Only the first scan after a project opens reads the cache, so the
panel fills quickly after a restart. Rescanning only the files that changed on
disk was left out: whether Mago on single paths gives correct cross-file
results is unproven.

### 2026-09-25: Phpactor's empty publish waits

The client holds Phpactor's empty publish for 4 seconds instead of applying it,
so problems don't flicker while you type. The cost is that a file you fix
keeps its last problems for up to 4 seconds. Checking open files one at a time
waits for results from both Mago checkers, or 5 seconds of quiet, rather than
3 seconds of quiet, which could move on while Mago was still running.

### 2026-09-25: The tree and tabs mark errors only

A file with errors shows its name in red with a wavy underline in the tree and
its tab, and the folders above it show their names in red, as in PhpStorm.
Warnings get no mark, and there's no setting for them: most PHP files have a
warning, so marking them would color most of the tree.

### 2026-09-25: The Problems panel filter is plain words

The filter matches plain words against the message, rule label, and path. It
has no `@source:` or `!exclude` syntax, no Info toggle, no Collapse All, and no
cap on rendered rows: add them when someone asks. Quick Fix isn't in the row's
context menu, since Enter and then ⌥⏎ do the same.

### 2026-09-25: The inline problem shows on the cursor line only, and is opt-in

Error Lens draws every line's problems, which clutters code with many
warnings. The editor shows only the cursor line's worst problem, and only with
the setting on, since the hover and F2 already show messages. The problem page
shows Mago's rule description only: no good and bad examples, and no link on
the rule code in the hover.

### Editor font and ligatures

The default font list is JetBrains Mono under its own name and the Nerd Font
build's names (`JetBrainsMono Nerd Font Mono`), then SF Mono and Menlo. The
system's SF Mono isn't available to web content by that name, so without
JetBrains Mono the editor draws in Menlo. With ligatures on, WebKit drew `::` in
Menlo narrower than Monaco's character grid, which left a gap after it
(`$model::findToken ($token)`). `installedFont` in `settings.ts` finds the first
font of the list that's installed (its text measures differently from both the
serif and sans-serif fallbacks), and ligatures are on only when that isn't a
system fallback. A settings file that still has the old default list gets the
new one.

### 2026-09-26: The HTTP client keeps requests in .http files

A request builder usually stores collections in its own format. Here the form
edits `.http` text instead, because the files already live in the project,
review well in pull requests, and open in PhpStorm and VS Code. The cost is
that the form rewrites a request's block, dropping comments inside it; the
editor stays available for anything the form can't express.

### 2026-09-26: Stress tests use curl's parallel mode, not a Rust HTTP client

curl ships with macOS and already sends every request, so a stress test sends
the same request with the same TLS, cookie, and redirect handling. One process
with `--parallel-max` holds the concurrency without a process per request. A
Rust client would measure more precisely at very high rates, but would add a
dependency and a second request path to keep in step.

### 2026-09-26: HTTP requests run in a PTY, named by a channel

`run_capture` can't be stopped, and **Cancel** needs to stop curl. A PTY can be
killed and streams output, which the stress test already needed. Its events
were named by the terminal's ID, which only comes back after the process
starts, so a request that finished at once could end before anyone listened.
The stress test worked around that with a 0.3-second head start. `pty_spawn`
now takes an optional `channel` for the event names, so the caller listens
first.

### 2026-09-26: The HTTP tab edits only the lines that change

Rewriting a request's whole block dropped comments among its headers and in its
body, and joined a URL written over several lines. The parser now keeps those,
with their positions, and an edit replaces only the lines that differ, so the
file reads as its author wrote it and diffs stay small.

### 2026-09-26: WebSocket requests use tungstenite in Rust, not the webview

The webview's `WebSocket` can't send headers, so a request couldn't
authenticate with `Authorization` or a cookie, and couldn't skip TLS
verification. curl 8.7.1 on macOS has no usable WebSocket client. tungstenite
was already in `Cargo.lock` through another dependency, and its sync API with
`native-tls` needs no async runtime. It runs one thread per connection, reading
with a short timeout so queued messages go out between reads. Events use a
channel name the caller chooses, as `pty_spawn` does, so the listeners are in
place before the connection opens.

### 2026-09-26: The history file keeps no secrets

Tokens, passwords, and cookies in `index.json` sat in plain text in the app's
cache. The history now writes requests through `redact`, and keeps the real
values in memory for the session only, so **Send Again** still works within a
session and prepares an older request from its file. Response bodies stay as
they came: hiding values in arbitrary bodies would change what you're
debugging.

### 2026-09-26: The app is Tusk

The app was PHP Editor, a name you can't search for. It's now Tusk, after PHP's
elephant mascot, with the identifier `ly.almontasser.tusk` from the author's
domain. A new identifier means new folders for settings, models, caches, and
web storage; the author's own folders were moved by hand, since nobody else
used the app yet. The npm package, the Rust crate, and the repository keep the name
`php-editor`: nothing a user sees shows them, and the dev build's web storage
folder is named after the crate's binary. The icon is SVG in
`design/`, rendered with headless Chrome; `pnpm tauri icon design/icon.png`
makes the app's icon files. The welcome screen showed an elephant mascot at first;
it was replaced the same day by the app icon, so the welcome screen and the Dock
show the same mark.

### 2026-09-26: The website is one static page

The site at tusk.almontasser.ly is a single HTML file with inline CSS and a few
lines of script, so it needs no build and hosts anywhere, such as GitHub Pages.
The waitlist posts to Formspree rather than a server of our own, since a static
host can't store emails. The site says Tusk is in beta and lists what that means
(macOS only, unsigned, no auto-update), so nobody downloads it expecting more.
The screenshots are real captures of the dev app on the test app, not mockups.
The design follows laravel.com's: a light page framed by dashed rails and
hairlines with accent squares at the corners, light-weight display type in
Instrument Sans, Geist Mono labels, and Tusk's indigo where Laravel uses red.

### 2026-09-26: A UI polish pass

A pass over every view fixed what looked unfinished. The Database view's
connection line was squeezed under the table list, since flex items in a
scrolling column shrink. The settings dialog's Done button wasn't blue, since
an ID rule beat its class rule; it now has `.primary`. Settings are grouped
under Appearance, Editor, AI, and Spelling, and the buttons stay in view while
the list scrolls. Toolbar buttons that had no hover shade (Problems, Hierarchy,
Merge, the problem page, and the rebase dialog's Cancel) now use the standard
button. Go to Class and Go to Symbol show a symbol icon for each kind, so their
rows line up with the file rows. Panel tabs have icons, and the activity bar's
Problems, Debug, and Terminal buttons show when their view is open. An empty
Problems panel says why it's empty. Context menus take the arrow keys and Enter.

### 2026-09-26: Views open as tabs, not in place of the editor

The diff, the merge tool, the problem page, and the Git Log used to hide the
whole editor area, tab bars included, and closing one had to remember what it
covered. Now the diff, merge, and problem page are editor tabs through the
`view:N` paths that docked panel tabs already used, and the Git Log is a panel
tab, as in PhpStorm. Switching away is a tab click, and nothing needs to
restore a covered view.

### 2026-09-26: No Write with Siri

macOS 27 shows a "Write with Siri" button beside the caret in any text field of
a WebKit view, including the terminal's and Monaco's hidden textareas. VS Code
(Chromium) and PhpStorm (Java) don't use WebKit's text input, so they never
show it. Neither `writingsuggestions="false"` nor a `WKWebViewConfiguration`
whose `writingToolsBehavior` is none stopped it: the button asks the text
client `allowsWritingToolsAffordance`, which WKWebView always answers yes. In
`setup`, `lib.rs` replaces that method on the webview's class (wry's `WKWebView`
subclass) with one that answers no. It only rewrites text, which a code editor
doesn't need, so it has no setting. The method was found by listing the
Objective-C runtime's classes in the running app, since Apple doesn't document
it; older macOS versions never call it.

### 2026-09-26: Ad-hoc signing and updates from GitHub releases

Notarizing needs a paid Apple Developer account, so the app is ad-hoc signed
(`signingIdentity: "-"`), which Apple silicon requires to run at all.
Gatekeeper still asks on the first install; updates don't, because the updater
downloads without the quarantine flag. `tauri-plugin-updater` reads
`latest.json` from the repository's latest GitHub release and checks each
archive against the public key in `tauri.conf.json`. The check runs in
`lib.rs` at launch and every six hours, in release builds only, and uses native
dialogs; the frontend only has the **Check for Updates…** action, which calls
the `check_update` command. The periodic check offers each version once, so
choosing Later isn't asked again every six hours, and it skips a version that's
already installed and waiting for the next launch. The download's progress shows in the status bar
through the `update-progress` event. After installing, **Restart Now** sends
`update-restart` to the frontend, which saves or asks about unsaved edits as
closing a tab does, then calls the `restart` command; it uses
`request_restart`, so the exit handler still stops the language servers.
**Later** leaves the new version for the next launch.
`scripts/release.sh` builds and publishes, since releases are built on this
Mac rather than in CI.

### 2026-09-26: Download the tools instead of bundling them

Bundled tools made the app about 380 MB, twice what one Mac needs, since the
universal build carried both chips' binaries, and every tool upgrade needed an
app release. The app now downloads its chip's tools on the first launch (about
90 MB compressed) and picks up newer ones in the background. They're still
pinned and checked by checksum, and the signed list means a changed release
asset can't swap in a tool; the cost is that the first launch needs the
network before the language servers start. The app itself stays universal:
without the tools, the second chip adds only the app's own binary, and one
download and one update archive serve every Mac.

### 2026-09-26: Terminal output saved as plain text

A reopened terminal shows its earlier output, saved in the session as text
without colors. xterm.js's serialize addon would keep colors, but it's another
dependency, and escape codes make the saved text larger; the output is there to
read, not to run again. Each terminal keeps its last 50,000 characters, so a
few terminals in a few projects stay well under WebKit's 5 MB `localStorage`
limit.

### 2026-09-26: Restart the debugger and profiling server with the session

A session saves whether the debugger listened and whether the profiling
server ran, and reopening the project starts them again with their own start
functions. Saving the profiling server's command instead would reuse a port
that may be taken now, and skip writing the PHP settings its command points
to. Starting them again is safe: the debugger only listens, and the server
serves on `127.0.0.1`.

### 2026-09-26: Coverage follows edits by line text

The Coverage tab showed the report's line numbers and the file's text on disk,
so after an edit its rows pointed at the wrong code. Now marks move with
Monaco's decorations and the tab renders from the moved lines. Deciding which
lines an edit made stale compares each line's text with its text at the run,
rather than tracking which lines each change touched: pressing Enter at the
end of a line doesn't change it, and undoing a change makes its line fresh
again. A line whose text only moved between lines, such as two swapped lines,
counts as changed, which is the safe side.

### 2026-09-26: Uncaught exceptions pause where they end up

Xdebug decides to pause on an exception in its throw hook, before the engine
looks for a `catch`, and DBGp reports nothing about catching, so the editor
can't know at the throw whether code will catch it. Guessing from the source,
by finding `try` blocks around each frame's call, would miss catches in
`vendor` code and `finally` rethrows. Instead, **Only uncaught** pauses where
an uncaught exception is sure to arrive: PHP's fatal error, and in Laravel,
which catches everything, the start of its handler's `render` methods. Both
come after the stack unwinds, so the pause isn't at the throw; in Laravel, `$e`
still holds the exception, and the log says where it was thrown. Skipping by
path runs in the client rather than through the adapter's `ignore` globs, so
changing it doesn't restart the listener.

### 2026-09-26: Result pages run the query again

Results stopped at 1,000 rows. Now they come in pages, and each page runs its
statement again. A server-side cursor would read only what you page to, but
needs a connection kept open between pages, and every query opens its own. A
query wrapped as `SELECT * FROM (…) LIMIT … OFFSET …` breaks on duplicate
column names in MySQL and loses the inner `ORDER BY` on MariaDB, so only table
browsing, whose SQL the editor writes, pages in SQL. Other statements skip rows
in Rust, which read every row before this change too.

### 2026-09-26: Database connections are URLs, with passwords in the Keychain

The editor connected to `.env`'s database only. Now you can save more per
project and switch between them. A connection is typed as one URL, in the form
Laravel's `DB_URL` takes, instead of in a form with a field per setting: the
command palette's picker already asks for text, and a URL is what hosting
dashboards hand out. The password goes to the Keychain, not to web storage,
which is a plain file in the app's data folder. The app had no secret store,
and `security-framework` was already in the build for TLS, so this adds no
download. An ad-hoc signed build changes its signature with each release, so
macOS may ask once per release to let Tusk read a saved password.
`config/database.php`'s other connections are read by booting the app, as
Laravel resolves them, rather than by parsing the PHP, since they're mostly
`env()` calls.

### 2026-09-26: CR line endings convert on read and save

Monaco's text model has only LF and CRLF, and it would read a file with CR
alone as lines but save it with LF. Rather than patch Monaco, `readText` and
`writeText` convert at the edge, so every feature sees LF text and a CR file,
or a file under `end_of_line = cr`, is written with CR. The cost is that the
conversion isn't an undoable edit, unlike LF and CRLF.

### 2026-09-26: Detect the encoding of files that aren't UTF-8

A legacy file used to fail to open until you set `charset` in `.editorconfig`.
Now `read_text` guesses with chardetng, the detector Firefox uses, and decodes
with `encoding_rs` (already in the dependency tree). Both are small pure-Rust
crates, so nothing is installed. Detection runs only when the bytes aren't
valid UTF-8, so UTF-8 files are never misread, and decoding stays strict,
falling back to Windows-1252, so a wrong guess shows odd characters but saves
the same bytes back. `read_file` keeps its strict UTF-8 default for the
callers that read config files.

### 2026-09-26: Double taps are shortcuts like any other

⇧⇧ and ⌃⌃ were hard-coded to Search Everywhere and Run Anything. The recorder
now records a double tap of any modifier and saves it in `keymap` like a
combination, and the double-tap handler runs whichever action has it. Double
taps of ⌥ and ⌘ come for free, since detection doesn't care which modifier it
is.

### 2026-09-26: Vim emulation with monaco-vim

monaco-vim ports CodeMirror's Vim keymap, the most complete Vim emulation for
Monaco, and is bundled from npm, so nothing is installed. It's off by default
and loads only when turned on, which keeps about 100 KB out of startup. It
targets older Monaco releases, so a few commands that reach into Monaco's
internals, such as `>>` on an empty line, may not behave like Vim. ⌃ letter
keys go to Vim in the editor, since Vim users expect ⌃D and ⌃R; the actions on
them (Type Hierarchy, Rerun) still work from ⌘⇧A or outside the editor.

### 2026-09-26: Read YAML imports with the `yaml` package

OpenAPI documents and Insomnia exports are often YAML, and asking you to
convert them first was a step every import of one needed. The `yaml` package
has no dependencies and parses YAML 1.2, which covers JSON, but text that
starts with `{` or `[` still goes through `JSON.parse`, which is faster on
large Postman collections.

### 2026-09-26: gRPC through tonic, prost-reflect, and protox

gRPC needs HTTP/2 framing and protobuf encoding, which curl can't do. tonic
already shares hyper and rustls with the updater's reqwest, so it adds little.
prost-reflect builds messages from a schema at run time, so no code is
generated per service, and protox compiles `.proto` files in Rust, so the
fallback for servers without reflection needs no `protoc`. A streaming
response is shown once the call ends, as a JSON array, rather than message by
message, which keeps it one response the history and scripts understand.

### 2026-09-26: Postfix templates as completion items

PhpStorm's postfix completion is a completion item whose range reaches back over
the expression, so Monaco's own list, filtering, and snippet placeholders do the
work, and no key handling is needed. There's no `.` trigger character: the list
would open after every concatenation such as `$a.`, and Enter would pick a
template. The list opens once you type a letter after the dot.

### 2026-09-26: Call hierarchy from references and definitions

Phpactor doesn't implement the call hierarchy requests. Callers reuse the
reference search that Change Signature and Safe Delete already trust, and
callees are one definition request per call in the body. That's a request per
call, but a method body has few, and they load only when a row expands.

### 2026-09-26: Generate reuses Phpactor where it can

Phpactor already writes getters, setters, implemented and overridden methods,
and completes constructors, so Generate lists those actions instead of
writing its own. It calls the accessor commands itself, since the code action
needs a selection over the properties. Only the constructor from properties
and `__toString()`, which Phpactor lacks, are written by the editor.

### 2026-09-26: Rebasing merges uses git's own todo list

Rebasing a range with merges needs `--rebase-merges`, whose todo list names
branch points with labels that git derives from the history and the merge
messages. Writing that list in the app would copy a tricky part of git and could
drift from it, so git writes it in a throwaway worktree and the dialog edits
only the picks. The cost is one checkout of HEAD each time the dialog opens for
such a range; a dry run in the project itself would have needed a clean
working tree or an autostash that rewrites the user's files.

### 2026-09-26: Split a commit with reset and the Commit view

Splitting a commit at an edit stop is `git reset HEAD~` followed by ordinary
commits, as git's documentation describes, so the app adds only the button and
leaves the parts to the Commit view, whose line-level staging already picks
what goes in each commit. A dedicated split dialog would repeat that staging UI.

### 2026-09-26: Angular templates through Angular's own language server

`@angular/language-server` is the server VS Code's Angular extension runs, so
templates get the same checks as `ng build`'s strict templates. It adds about
50 MB to the Node tools, half of it its own TypeScript, and a second TypeScript
program in memory. Starting it only for projects with `@angular/core` keeps
that off Laravel projects that only have a stray `.html` file.

### 2026-09-26: Markdown preview with the libraries pull requests already load

The preview reuses `marked` and DOMPurify, already loaded for pull request
descriptions, instead of Monaco's Markdown renderer, which can't map blocks to
lines. Images go through a bytes command rather than Tauri's asset protocol,
which would need a new Cargo feature and a file scope in `tauri.conf.json`.

### 2026-09-26: Bundle JSON schemas instead of letting Monaco download them

Monaco can fetch a schema by URL, but that sends requests from a page that can
call the app's commands, fails offline, and would download schemastore.org's
schemas at every launch. About 600 KB of schemas, loaded only with the first
JSON file, cover the config files PHP and frontend projects have. Refs to
schemas left out validate nothing rather than failing.

### 2026-09-26: Check Blade's PHP with Mago, without variables

Blade's PHP went unchecked because a view's variables come from its controller.
Rather than compile views as Laravel does (`CompilesEchoes` and the rest, which
needs PHP and a booted app, and maps positions through generated code), the
editor blanks everything but the PHP, so positions stay put, and runs the Mago
it already has. Undefined variables and every problem about their `mixed`
values are dropped, which still leaves syntax errors, unknown classes,
functions, methods, and constants, and wrong arguments. Reading variable types
from the controllers that render a view, or from a component's class, would
catch more, but a view can be rendered from many places with different
values; `@props` gives names without types, so it adds nothing once undefined
variables are dropped.

### 2026-09-26: Translation keys from Laravel LSP, not the editor

Laravel LSP 0.0.32 already completes, hovers, links, and validates translation
keys from PHP and JSON files, in PHP and Blade, so the editor adds nothing.
Checked against the test app with `php artisan lang:publish` and a `lang/en.json`.
It warns only about keys with a dot, since a sentence key falls back to itself.

### 2026-09-26: Make each Mago check cheaper instead of keeping Mago running

Mago 1.50.0, the newest release, still has no language server or cache between
runs. Its `analyze --watch` is experimental, reads files on disk rather than
unsaved text, and prints reports to the terminal, so Phpactor keeps running
one `mago analyze --stdin-input` per check. A trace (`MAGO_LOG=trace`) of a
check on lamah-sms-gateway (27,000 PHP files) showed two-thirds of its time in
loading files, most of it walking folders that `excludes` then dropped. Listing
the project's own folders in `paths` and giving Phpactor's runs half the cores
took a check from 2.3 s of wall time and 9.4 s of CPU to 1.3 s and 4.4 s
(medians of 15 alternating runs on a busy 12-core Mac). On the test app (14,000
files) it went from 0.9 s and 2.9 s to 0.8 s and 2.0 s. Phpactor already runs
at most one check per checker, and skips a queued one once newer text arrives.
Checking only the changed file against a saved codebase would need Mago to
save one, which it can't.
