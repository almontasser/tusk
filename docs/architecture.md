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
| PHP intelligence | Tusk's own language server in Rust (`tusk-lsp/`); Phpactor until September 2026 | 2 |
| Laravel intelligence | `tusk-lsp/`; Laravel LSP (`laravel/lsp`) until September 2026 | 3 |
| Diagnostics and formatting | Mago, in `tusk-lsp/` and on the command line | 3 |
| Terminal | `xterm.js` and `portable-pty` | 4 |
| Git and pull requests | The `git` and `gh` command-line tools | 5 |
| Filament intelligence | `tusk-lsp/`; a server written in PHP (`filament-lsp/`) until September 2026 | 6 |

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

`src/settings.ts` keeps one settings object and loads it from `settings.json`
in the app's config folder (`appConfigDir`). The dialog is built from one list
of fields. Each change applies at once (`apply`) and writes the file.

Reading and writing never lose what's in the file (`src/settingsdata.ts`, with
tests):

- A file that isn't a JSON object blocks writes (`blocked`). The defaults apply,
  a toast and a banner in the dialog offer **Open settings.json**, and saving
  the file in the editor (`settingsFileSaved`, called from `saveFile`) reads it
  again.
- A value of the wrong type or out of its range is set aside (`invalid`): the
  default applies, the dialog notes it under the setting, and the saved value
  is written back unchanged until you change that setting.
- The write starts from the file's own object (`raw`), so keys this version
  doesn't know, such as those of a newer build, survive.
- A failed write shows an error with **Retry**.

To add a setting:

- In `src/settings.ts`: add the key to `Settings` and `defaults`, and a `Field`
  to `fields` with its `group`. A new group appears where its first field is.
- From another module, without touching `settings.ts`: call
  `registerSettings(group, defaults, fields)` when the module loads. It returns
  the settings object typed with the group's keys, which always holds the
  current values; use `onSettings` to react to changes.

```ts
type Field = { key; label; help?; group; shown?: () => boolean } &
  ({ type: "checkbox" } | { type: "number"; min; max } | { type: "text"; placeholder? } | { type: "select"; options });
registerSettings<T>(group: string, defaults: T, fields: Omit<Field, "group">[]): T
onSettings(fn)          // now and after every change
updateSetting(key, v)   // apply and save
openSettings(query?)    // the dialog, optionally filtered
openSettingsFile()      // settings.json in the editor
```

`shown` hides a field that doesn't apply; the search matches a field's group,
label, help, and key.

Two more kinds of entries, for what plain fields can't hold:

```ts
registerProjectSettings<T>(group, key, defaults: T, fields, onChange?): () => T
registerSettingsSection({ group, keywords, shown?, render(): HTMLElement | Promise<HTMLElement> })
listEditor({ label, items, placeholder, empty, add(v): Promise<string[]>, remove(v): Promise<string[]> })
openPath(path)          // a file in the editor, such as a tool's configuration
```

- `registerProjectSettings` adds fields for the open project, kept as one
  object under `key` in the project's state (`projectstate.ts`), not in
  `settings.json`. Values equal to their defaults aren't saved, and a saved value
  of the wrong type reads as its default. The group's heading says **This
  project** and has a **Share in tusk.json** box (`setProjectScope`). The fields
  show only while a project is open, and **Reset All** leaves them alone.
  `onChange` runs after a change in the dialog and when `tusk.json` changes on
  disk. Add the key to `SHAREABLE` and the tusk.json schema too.
- `registerSettingsSection` adds a part the module draws itself under a
  group's heading, such as the dictionaries or Mago's rules. `render` runs each
  time the dialog opens; the dialog shows "Loading…" until it resolves, and
  the error in place if it fails. The search matches its group and `keywords`,
  and shows or hides the whole section.
- `listEditor` is the list of strings such sections use: a box that adds an
  entry on Enter or **Add**, and the entries with remove buttons. `add` and
  `remove` save and return the new list; a failure shows with `showError` and
  keeps the list.

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
  follows the theme's type, for the light-only rules. A theme's input border,
  button text, and description color are kept only when they contrast with
  what they sit on (`contrast`, the WCAG ratio); otherwise they're mixed as for
  TextMate themes. One Dark, for example, draws inputs with its sidebar's
  color, which hid every secondary button's outline.
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
and the menu would then run it anyway. So every item gets its accelerator
(except double taps and chords), and `passedOn()` makes such an action's item
do nothing within 500 ms of a key press: a key the page passed on is the only
way the menu runs it that soon, since picking an item takes longer. Both are
tested in `menu.test.ts`.

### Monaco's commands as actions

`src/editorcommands.ts` is a table of Monaco's editing commands: label, Monaco
action id, default keys, and a menu group. `main.ts` turns each row into an
editor-only action, and `menu.ts` places each group with `commandsIn(group)`,
so a command is one row. Keys are PhpStorm's where it has the command, else
Monaco's. A chord such as `Meta+K Meta+X` is shown but never matches the app's
key handler, which compares single combinations, so Monaco's own binding runs
it. Code > Folding follows PhpStorm, which keeps folding in the Code menu.

`showMenu` in `src/files.ts` takes submenus (`{ label, items }`). Each level is
its own `.context-menu` list; hovering, clicking, or → opens a submenu beside
its row (on the left when there's no room), and ← or Escape closes it.

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
replaced. Each installed folder records its package's ID in `.tusk-id`. A
package that fails, such as one the list names but the release lacks, doesn't
stop the others: the rest install, a toast (`tools-failed`) names the failures,
and the next launch tries again, since the folder is missing. It fails outright
only when no tool is installed afterwards, as on a first launch offline.
`publish-tools.ts` uploads a new list whenever the packages differ from the
published one, so removing a tool also removes it from the list. The
editor's `mago.toml` and `introspect.php` ship inside the app, since they're
part of this repository. The PHP language server is the app's own binary, so
it isn't a tool at all.

Every tool gets new files, never files rewritten in place: macOS caches a
binary's code signature per file, and a binary rewritten after it ran fails its
check and is killed partway through a large run.

| Tool | Version | Form |
| --- | --- | --- |
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
starts later (`php`, `git`, `gh`) resolves the same way as in your terminal. It
runs on a thread, because a shell with plugins can take a second or more, and
the window shouldn't wait for it. Commands that start a program call
`login_path()` first, which waits for that thread.

### Tool paths

**Settings > Tools** (`src/toolpaths.ts`) sets the paths of PHP, Composer,
Node.js, Git, `gh`, and Docker, and a project can set its own PHP
(`phpInterpreter`, shareable in `tusk.json`). Call sites don't read these
settings: they keep running `php` or `git` by name, and the backend resolves
the name.

- `toolpaths.rs` keeps a folder of shims (`bin/` in the app's local data
  folder). For each tool with a path, `tools_configure` writes a two-line
  script named after the tool that `exec`s the path, and removes the scripts of
  tools without one. The folder is emptied at launch.
- `path_env()` is the shims' folder followed by the login `PATH`. `run_capture`,
  `pty_spawn`, and `lsp_start` start every program with it, so a set path
  reaches commands, terminal tabs, `/usr/bin/env php …`, the language servers,
  and what they start in turn, such as the PHP server's own `php`. A shim is a
  script rather than a symlink so that version managers that read the name they
  were run as, such as mise, see their own path.
- `check(command)` runs before a program starts. It finds the tool, looking
  past `/usr/bin/env VAR=value`, and fails when a set path isn't an executable
  file or, without one, when the tool isn't on `PATH`. The error names the fix
  ("PHP wasn't found at /x. Set its path in Settings > Tools."), and the
  `tool-missing` event carries it to a toast with **Open Settings**, so callers
  that stay quiet on failure, such as the model introspection, still tell you.
- The frontend sends the paths with `configureTools` after each settings
  change, when a project opens (before its servers start), and when `tusk.json`
  changes the project's PHP. A change of PHP or Node.js offers to restart the
  language servers.
- Composer runs as `composer` when you set its path, and as `php` with the
  bundled `composer.phar` otherwise (`composerCommand`).
- The terminal's shell and arguments come with the same call; `pty_spawn` runs
  them when it gets no command.
- Settings' `path` field type (`src/settings.ts`) draws the text box with
  **Browse…**, **Test**, a note from the field's `describe`, and a datalist of
  `suggest`ed values. `describe` runs `--version` on the set path, or says what
  `tool_which` finds on the login `PATH` ("Detected: …").
- `FIND_INTERPRETERS` (`src/toolpathsdata.ts`, with tests) is a shell loop over
  the usual PHP locations; `parseInterpreters` keeps each real binary once.
- `auto_checks` reads `checkForUpdates` from `settings.json` in Rust, so the
  six-hour update and tool checks and the launch tool check honor it before the
  frontend has loaded. **Check for Updates…** also checks the tools.

### Language server bridge

`src-tauri/src/lsp.rs` starts each language server in the project folder. For
PHP, it starts the app's own binary with `lsp` (`std::env::current_exe()`), which
`main.rs` hands to `tusk_lsp::run_stdio()` before Tauri starts. A thread reads the server's `Content-Length` framed messages
from standard output and emits each one as an `lsp` event. The `lsp_send`
command queues a message for a writer thread, one per server, which writes it to
the server's standard input. A busy server stops reading, its pipe fills, and a
write then blocks until it reads again; with the write on the main thread, that
froze the whole window while a server worked through a large file. Opening
another folder stops the old server.

The bridge doesn't parse messages. All protocol logic lives in `src/lsp.ts`.

### Index exclusions

Each project has a list of vendor folders to skip, which
`exclusionsFor` in `src/lsp.ts` reads from the project state (see "Project
state"): the `indexExclude` value, in `tusk.json` when shared or else on this
Mac, and `DEFAULT_EXCLUDES` in `src/indexexclude.ts` when it isn't set. The defaults are folders that declare no
classes, functions, or constants: AWS's API data, Carbon's and every package's
translations, package Blade views, and `voku/portable-ascii`'s tables. The list
goes to the PHP server as `exclude` in `initializationOptions`, on top of its
own defaults (see "Tusk's language server"), and to Mago's `excludes`, where a
folder glob needs `/**` because Mago matches globs against files, not folders.
On a Laravel and Filament app, all 6,154 such files declared nothing. AWS's
data is 39 MB of that app's 110 MB of vendor PHP. Rector's bundled `vendor`
stays, since its `vendor/rector` holds the rule sets `rector.php` uses.
Changing the list restarts the servers, which index again with it.

`symbol_free_folders` in `search.rs` suggests more folders to skip. It reads
every PHP file in `vendor` except tests and `vendor/composer`, checks each with a
regex for a class, interface, trait, enum, function, constant, `define(`, or
`class_alias(` declaration, and returns the topmost folders where no file
declares anything, at 100 KB or more. The regex errs toward seeing a
declaration, so a wrong call only leaves a folder out. Opening the files is
most of the cost, so they're read on every core: 0.6 seconds for 26,000 files,
against 3.8 seconds one after another.

Whenever `checkComposerLock` sees a new `composer.lock`, which includes a
project's first open, `suggestExclusions` runs the scan in the background. When
it finds folders that the list doesn't cover and no earlier scan offered
(`indexExcludeOffered:<root>`), it shows a hint toast (`toast` in `dom.ts`,
with an action) whose **Review** opens the dialog with the scan's result. So a
package installed later that brings only data gets offered too, and a folder
you left out isn't offered again. It never blocks the servers: an earlier version
opened the dialog itself, which asked every user to make a choice before
they'd written a line.

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
`config/app.php`) exist only at runtime, through `class_alias()`, so the
index had no `DB` and Mago reported that its methods don't exist.
`aliasStubs` in `eloquent.ts` writes a stub file per project in the app's cache
folder (`alias-stubs/<project>/aliases.php`), one `class DB extends
\Illuminate\Support\Facades\DB {}` per alias, from `introspect.php aliases`
(Laravel's `AliasLoader`, so package aliases count too). Tusk's server gets the
folder in `stubs` and indexes it as library code. Later starts check the
aliases in the background and ask the server to reindex only if they changed. For projects without their own `mago.toml`, the editor's Mago
settings for the project (see "Types Mago reads wrong") add the folder to
`includes`, so Mago reads the facades' `@method` docs through the stubs. A facade call
(`DB::transaction(…)`, by alias or by an import from a `Facades` namespace)
also counts as magic for `withoutMagic`, since its documented return type is
often `mixed`.

`introspect.php` lives in `tusk-lsp/php/`. Tusk's server compiles it in with
`include_str!`, and the app bundles a copy as `tools/introspect.php` for the
editor's own calls. In development, Tauri copies it into `target/debug/tools/`
only when the Rust side rebuilds, so a change reaches the running app after the
next Rust rebuild.

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
made later is read after the next start. Mago's fixes and Blade's checks run
Mago's command line from the app, on every core.

### False problems the filters drop

`realProblems` in `src/diagnostics.ts` filters every server's diagnostics
before they become markers, for open files and the project's problems alike.
It has no editor imports, so `src/diagnostics.test.ts` runs it in Node. Besides
Laravel's magic (above), it drops:

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

`src/problems.ts` scans the whole project for the Problems panel with one
`tusk/projectProblems` request. The server checks every project PHP file in its
own process, in parallel, with the same checks as open files (Mago's analyzer
and linter, and its own), and returns the problems by path relative to the
root. That takes a few seconds, where running Mago's command line over the
project and Phpactor's diagnostics command per file took minutes, so there's
no cache: a file's results depend on the files it uses, and every scan checks
every file again. The results go through `realProblems` and `severityOf`, as
open files do. Files open in the editor show their live markers instead, and a
file that closes keeps its last markers as its scan result, unless you close
it without saving its changes. Then it keeps its earlier scan result. Deleting
or moving a file drops its problems (`forgetPath`). A scan that a newer one
replaced (the project changed) checks its run number and stops without
publishing; **Scan Project** does nothing while a scan runs. The panel's Errors and
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

Mago doesn't tag its deprecation reports as deprecated, so
`isDeprecation` in `diagnostics.ts` finds them by code (`deprecated-*`), and `setMarkers` gives their markers
Monaco's deprecated tag, which draws the code struck through. Mago reports the
whole call (`$method->setAccessible(true)`), so `realProblems` narrows its range
to the deprecated name from the message.

Unused imports (Tusk's `unused_import`, Mago's `no-redundant-use`)
show as VS Code shows them: hints over the whole `use …;` line with Monaco's
unnecessary tag, which fades them without an underline, and not counted as
problems (`isUnused`). An import the code uses with other letter case (`use
HasDescription, hasIcon;`) isn't reported: PHP's class names ignore case, and
both checkers compare with it.

### Hovers

Tusk's hover shows a declaration's signature as its source writes it, on one
line, in a PHP code block that starts with `<?php` (which Monaco needs to
highlight PHP), after a **Deprecated** line when its docblock has
`@deprecated`, and followed by the docblock. `formatHoverMarkdown` in
`phptypes.ts` gives a signature longer than 80 characters one parameter per
line.

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
the filters drop gets no quick fix. With an empty selection, Monaco widens the
range to the whole problem under the cursor, so a method-wide problem such as
`halstead` would take in every problem inside the method. When the focused
editor's empty selection is inside the range, only the problems at the cursor
go. The hover's Quick Fix link lists only
actions of kind `quickfix`, while the light bulb lists every kind. A server
can answer with a bare `Command`, which has no kind, so the client gives such
a command the kind `quickfix` when problems overlap the range. Each action carries its
diagnostics as markers: the server's own for a `CodeAction`, and the
overlapping ones for a command.

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

Tusk's server offers Mago's own fixes as code actions with their edits
(`features/actions/mago.rs`). For each `mago-lint` or `mago` problem in the
request's context, it runs the linter on the document again, in process (the
analyzer too when an analysis problem is there), and each issue with edits
whose code matches the problem and whose span touches it becomes a
`quickfix`. Only safe fixes are preferred; the others say so in their title
("may change behavior" or "unsafe"). The linter takes milliseconds, so the
light bulb shows the fixes as the caret moves.

`source.fixAll.mago` collects the safe fixes for the problems in the context,
leaving out fixes that overlap one before them, as Mago leaves them for its
next run; with no problems in the context, every safe fix. The editor sends
only the problems its filters keep, so a fix for a problem the filters drop,
such as an unused import that a trait's `use` needs, isn't applied. Monaco's
`editor.action.fixAll` asks for `source.fixAll` and reaches the server
through the generic provider. The provider for `php` in `lsp.ts` also offers
it as the quick fix **Fix All Safe Mago Problems in File** on a request the
user makes (⌥⏎ or the hover's Quick Fix link) with `mago-lint` markers,
asking for `source.fixAll.mago` over the whole file with every problem the
file shows. Edits carry the document's version, so a stale one is refused.

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

### Open files' problems

The PHP server publishes each open file's problems whole, with the document's
version, as soon as its index has the edit, and the other open files' once edits
pause (see "Tusk's language server"). So a publish for a file marks it as
checked (`diagnosed` in `lsp.ts`), and until then the Problems panel shows the
scan's problems for an open PHP file. Phpactor needed three workarounds that
are gone: asking for one file at a time (its diagnostics engine kept one
waiting document), holding its empty publishes for 4 seconds (it published an
empty list before each check), and rechecking open files after its first
index. So are its index's workarounds: a recorded full build per project, a
reindex after `composer.lock` changed, and a soft reindex after other programs
changed files, since the server indexes from scratch at each start and follows
`workspace/didChangeWatchedFiles`.

### Files changed by other programs

`filesChanged` in `lsp.ts` sends `workspace/didChangeWatchedFiles` for PHP
files, `.env`, `composer.lock`, `mago.toml`, `lang/**/*.json`, and `public/`
files that another program creates, changes, or deletes, such as `php artisan
make:model` or a `git checkout`. The server indexes PHP files it doesn't have
open, forgets cached Laravel and Filament facts that depend on the paths, and
indexes the project again with its configuration read again when
`composer.lock` or `mago.toml` changes.

### Pest in diagnostics

Pest binds test closures to the test case that `tests/Pest.php` sets, so
`$this->get()` works in a Pest test. Mago reads the type from the corrected
copy of Pest's functions (see "Types Mago reads wrong"). In files under
`tests/` that call `it()`, `test()`, `describe()`, or `arch()`, the filters
drop problems that mention `$this`, `TestCase`, or `mixed` on lines that use
`$this`. They also drop Mago's issues about Pest's own classes, which answer
through magic (`->not`, higher-order expectations such as `->name->toBe()`),
and calls on null along an `expect()` chain: `expect()` returns an
`Expectation<TValue|null>`.

### Questions from servers

A server can ask a question with `window/showMessageRequest`. The client
shows the question as a native dialog with the server's options as buttons (up
to three) and sends back the option you choose. The **Restart Language
Servers** action restarts every server.

### Status bar

Each language server has its own status slot, and the status bar shows the
most recent message that is still set. Otherwise one server finishing a task
would clear another server's indexing progress.

### Errors and progress

`src/status.ts` is the one place the app reports what's happening. Use it
instead of writing to the status bar or `toast()` directly:

```ts
status(text, source = "app", kind?: "error" | "info")
showError(message, error?, action?: { label, run })
errorText(error): string
withProgress<T>(label, task: (signal: AbortSignal, progress: (label) => void) => Promise<T>, { cancellable?, error? }): Promise<T | undefined>
installErrorHandlers()
```

- `status` sets a message per source. A source ending in `:progress` shows a
  spinner until you clear it; any other message clears after 8 seconds. Pass
  `"error"` to toast it too. Without a kind, a message that reads like a
  failure ("failed", "can't") still toasts, for the modules whose `Host.status`
  predates `kind`.
- `showError("Can't merge #12", e)` shows "Can't merge #12: <reason>" as a
  toast and in the status bar, and logs `e` with its stack. `errorText` reads
  an `Error`, a Tauri command's error string, or anything else, drops Git's
  `hint:` lines, and keeps it to one line.
- `withProgress` runs a task under a spinner and reports its failure with
  `showError`. The task gets `report(text)` too, which replaces the label while
  it runs, such as with "12 of 40 files". With `cancellable: true`, the status bar shows **Cancel**, which
  aborts the signal the task gets; the task checks `signal.throwIfAborted()`
  between steps or passes the signal on, and calls `progress` with a new
  label, such as "Deleted 500 of 2,000 keys…", to show how far it got. A canceled task shows "Canceled", not
  an error. It resolves to `undefined` when the task failed or was canceled, so
  callers that need to stop check for that. Tauri commands can't be aborted,
  so a task that waits on a slow command stops at its next step.
- `installErrorHandlers` (called once in `main.ts`) turns unhandled promise
  rejections and uncaught errors into a toast. Monaco's `Canceled` errors,
  `AbortError`, and `ResizeObserver` loop warnings are dropped. `toast()`
  shows a message once while an identical one is on screen.
- The palette shows a failing source's error as a row, rather than an empty
  list that reads as "no results".

A search that a destructive action depends on, such as Safe Delete's usages or
Inline Constant's uses, fails rather than falling back to "none found", so the
action stops instead of working on incomplete results.

### Lists and trees

`src/listnav.ts` gives a list or tree PhpStorm's keyboard: ↑↓, Home and End,
Page Up and Page Down, Enter, → and ← for tree nodes, and type-ahead. Use it for
every new list rather than writing another keydown handler.

```ts
const nav = listNav(container, {
  rows?: string,                                // default "[data-key]"
  open?(row, e),                                // Enter; default row.click()
  toggle?(row, expand),                         // → ← on a row with aria-expanded; default row.click()
  onSelect?(row),                               // the selection moved
  label?(row),                                  // type-ahead text; default data-label or text
});
nav.select(key, { scroll? }); nav.selected(); nav.selectedRow(); nav.refresh();
```

- Give each row a `data-key` that names it across redraws. The helper keeps
  the selection by key and reapplies it after the list renders again (a
  `MutationObserver`), so callers just replace their rows.
- The container keeps the focus and points at the row with
  `aria-activedescendant`, so the rows need no tabindex. Set the container's
  role (`listbox`, `tree`) and the rows' (`option`, `treeitem`).
- A tree is `aria-expanded` on rows that open and `aria-level` on every row;
  ← goes to the nearest row above with a lower level, so the rows can be a flat
  list, as in the Profiler's table.
- The helper sets `selected`, `aria-selected`, and the `list-nav` class, whose
  CSS in `styles.css` draws the selection with theme variables
  (`--selected`, `--accent`), so it shows in every theme. Keys with ⌘, ⌃, or ⌥
  pass through for the caller's own handler, such as ⌘C in Problems.

It replaced the Problems panel's handler and the Profiler table's. `fileGroup`
in `src/search.ts` marks its file and item rows as a tree, so Search, TODO,
and Coverage's file list use it too, and so do the Database tool's tree, whose
tables, Redis folders, and keys are treeitems in one `listNav`, and the Data
Sources list.

### Language server client

`src/lsp.ts` is a small client written for this editor:

- It sends `initialize` with the client capabilities, then registers a Monaco
  provider only for features the server reports.
- It keeps the server in sync with every open PHP model through `didOpen`,
  `didChange`, `didSave`, and `didClose`. A server that takes changes
  (sync kind 2, such as Tusk's server and typos-lsp) gets each edit's ranges.
  A server that takes only whole documents (Tailwind) gets the full text once
  typing pauses for 150 ms, or before the next message to it, whichever comes
  first, so every request is answered for the current text. Sending the full
  text on every keystroke made Phpactor reparse a 4,800-line file for each one,
  and it fell minutes behind. One copy of the text
  per version is shared by all servers (`textOf`).
- Providers pass Monaco's cancellation token. When Monaco drops a request, such
  as a completion list after the next keystroke, the client sends
  `$/cancelRequest` and resolves the request with `null`. Tusk's server skips a
  cancelled request that hasn't started, and stops references and project
  problems part way.
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

Tusk's server formats PHP with Mago's formatter (see "Formatting" under "Tusk's language server"). The editor asks for it only when Prettier and Pint don't apply (see "Formatting").

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
the declaration itself, such as recursive calls. References miss Laravel's
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

Calls of a method come from Tusk's server, `tusk/memberReferences` with the
class and method: every call in the project, through subclasses too, without
the declarations. Safe Delete uses the same search for methods. Functions use
`textDocument/references`.

Change Signature also changes overrides. `descendantsOf` searches project
files for the class's short name as a whole word, keeps the types whose parsed
declaration really extends or implements it, and repeats for each one found,
to reach grandchildren. Searching for the name alone, rather than for
`extends … Name` on one line, finds headers split over several lines; the
search is line by line, so a pattern can't span them. `overridesOf` then
takes the method from each type's text. Go to Implementation would include
`vendor`, but the text search keeps Change Signature to files you can edit.
Each override's parameter list gets the new text, and calls through the
override (`tusk/memberReferences` on its class) are rewritten too,
without duplicates. References that are declarations (`function name(`) are
skipped, since they have their own edit.

Constructors differ: a method search doesn't report `new`, and
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

Extract Variable and Extract Constant are written here, since they need the
editor's in-place naming. `src/extractparse.ts` tokenizes the file (comments masked, PHP
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
the server's `tusk.extractMethod` command (see "Tusk's language server"), which
applies its edit through the editor before it returns, and then does the same
with the name the server chose, found as the one new `function` in the file.

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

### Inline method

`methodToInline` in `src/extractparse.ts` reads the method: its parameters,
and its body split into statements and one final `return`, counting only the
method's own tokens (`scopeOpen`), so a closure's `return` doesn't count. It
refuses several returns, `yield`, `static` or `global` variables, variable
variables, `compact()` and the like, and parameters inside double-quoted
strings.

`inlineCall` maps a call's arguments (positional and named) to the parameters.
`varUses` classifies each use of a parameter: writes (assignment, `++`,
`unset`, `foreach` and `catch` variables, destructuring, `&`, built-ins that
take it by reference) and places that need a variable (`isset`, a closure's
`use`, a closure or arrow function reading it later), skipping closures that
declare their own variable of that name. An argument replaces its parameter
only when that can't change what runs: a caller's variable the body only
reads, a pure value (no call, `new`, `clone`, `include`, or write) where an
expression may stand, or the one argument with side effects, read once, first,
and outside any block, loop, or closure. Anything else runs first into a
variable, in argument order after the receiver, as PHP evaluates them, which
also lets the body change it. Locals that clash with the caller's variables get
a number. `reindentCode` moves the body to the call's indentation, leaving the
lines of multi-line strings alone.

`inlineMethod` in `src/refactor.ts` finds the declaration with Go to
Definition, refuses methods a subclass overrides, and, for a call from another
class, bodies that reach members not declared `public` or call `parent::`. It
places each call's code
with `declarationPoint`: statements before the statement holding the call,
which it allows only for `$x = …`, `return …`, `echo …`, and the like, where
nothing else in the statement runs first. `qualifyNames` writes the method's
class names in full for another file (`X::`, `new X`, `instanceof X`,
`catch (X`), and `shortenNames` shortens them where that file imports them.

### Move class

`moveClass` in `src/refactor.ts` reuses the file tree's move (`move` in
`src/files.ts`): it lists namespaces from the folders of the project's PHP
files (`namespaceFor`), maps the chosen one to a path with `pathsFor`, and
moves the file there. `updateReferences` then asks Tusk's server
(`workspace/willRenameFiles`) for the namespace and reference edits. The server
maps paths to namespaces through the PSR-4 map in `composer.json`, so no
Composer autoloader is needed; when no mapped folder holds the new path, its
error reaches the status bar.

### Pull Members Up and Extract Interface

`src/classparse.ts` holds the logic, free of editor imports so Node tests it.
`classBody` walks a class body over comment-masked code: each member's kind,
name, modifiers, a one-line signature, and offsets from its docblock or
attributes to its end, then promoted constructor properties, which can't move
on their own. `memberRefs` finds what code uses through `$this->`, `self::`,
`static::`, and `parent::`, which gives `dependencies` (a member's uses of other
members) and `needsProtected` (private members that move while staying members
use them).

Moved code has to mean the same in another file. `classNameRefs` finds class
names by where they can appear: `new`, `::`, `instanceof`, `catch`, attributes,
anonymous classes' `extends` and `implements`, the types in function and closure
headers (with default values blanked, so `= [A, B]` isn't read as types) and
properties, and docblock tags. `requalify` resolves each through the source
file's imports, then writes it for the target: short when the target's imports
or namespace give the same class, with a new import when the short name is
free, and in full otherwise. `importEdits` inserts imports in order among the
file's own.

Functions and constants resolve differently: an unqualified name means the one
the file imports with `use function` or `use const`, or else its namespace's
when one is declared there, or else the global one. `functionConstRefs` finds
calls and upper-case constant names outside member and class positions, and
`requalify` compares what each means in the source (`globalMeaning`) with what
it would mean in the target, writing it in full when they differ. The
project's namespaced functions and constants (`declaredGlobals`) come from one
text search for top-level `function` and `const` lines, which excludes
methods and class constants, since those are indented.

A promoted constructor property moves as a declaration built from its
parameter's modifiers and type (`Member.param` holds their offsets). `demote`
removes the modifiers from the parameter and adds `$this->name = $name;` to the
constructor, after a leading `parent::__construct()`. `pullUpProblems` reads
the lowest PHP version from `composer.json` (`phpMinimum`) to decide whether a
readonly one may be set from the subclass, which PHP allows from 8.4.

Extract Interface's type hints come from `typeHintsFor`, run on each file
that names the class. It finds the class in parameter types of functions,
methods, and closures, and in declared property types, and replaces one only
when its uses allow: every `$param` in the function body calls an interface
method, reads an interface constant, or is tested with `instanceof`, and every
`$this->property` in the class is such a call or an assignment. Private
properties only, since subclasses and other code may use more of a protected
or public one. A parameter of a method without a body stays, since changing it
would change what implementations must accept. `bindingEdits` adds the
container binding to `register()`, replacing Laravel's stock `//`
placeholder.

`planPullUp` returns edits for both files. The source loses each moved member's
lines with `deletionLines` (its docblock, attributes, and one blank line), and
imports only that code used. The target gets constants and properties after its
own, and methods at the end, re-indented to its members' indentation; a method
made abstract, or pulled into an interface, becomes its declaration without
attributes, with `abstract` before the visibility as PSR-12 has it. Making one
abstract adds `abstract` to the parent class. `pullUpProblems` reports clashes
with the target's members (errors), and uses of members left behind, `parent::`
calls, a parent that becomes abstract, and siblings missing an abstract method
(warnings). Siblings come from `descendantsOf` in `src/refactor.ts`.
`planExtractInterface` builds the interface file from a skeleton, so `requalify`
and `importEdits` work on it as on any file, and edits the class's `implements`.

`src/classrefactor.ts` finds the targets (`locate` tries the PSR-4 path, then
the workspace symbols) and runs `memberDialog`, which both refactorings
share: rows with badges and a per-row switch, a colorized preview of the new
code, and problems with fixes, all recomputed on each change. The dialog is
modal and both files' text is checked again before applying, so the edits never
land on changed text. A new file goes through `applyWorkspaceEdit`'s `create`
operation, which uses `create_file` and so never replaces an existing file, and
`linkUndo` deletes a created file when an undo empties it, and then
the folders created for it, with `remove_empty_dir`, which fails rather than
delete a folder that has anything in it.

### Refactoring popups

The refactorings ask their questions in `pick` (`src/palette.ts`) with a
`title`, which makes a compact popup: a header instead of a search box (what
you type to filter shows in the header), rows sized to their content, and,
with `numbered`, 1 to 9 choosing a row. `pickAtCaret` in `src/extract.ts`
anchors it below the caret, and `pick` moves it above when there's no room
below. The Change Signature dialog colors its signature with
`monaco.editor.colorize`, dropping the `<?php ` that switches the colorizer
into PHP. While you type a new name, Monaco's snippet placeholders are framed
and a content widget above the name says how to finish.

### Undo across files

`applyWorkspaceEdit` wraps each file's edit in undo stops, so it's one step, and
`linkUndo` watches the models it changed. The first undo in one of them undoes
the others and saves every file. A model edited in between leaves the group, so
a later undo there doesn't reach back into the refactoring.

### Type hierarchy

`src/hierarchy.ts` shows the tree that Tusk's server gives:
`textDocument/prepareTypeHierarchy` for the starting type, then
`typeHierarchy/supertypes` or `typeHierarchy/subtypes` for each row as it
expands, so a large hierarchy, such as `Model`'s, costs nothing until you open
it. See "Type and call hierarchy" under "Tusk's language server" for how the
server answers.

### Super methods

`src/supermethod.ts` asks Tusk's server for `tusk/overrides`, a request of its
own: each class, interface, enum, and method the document declares, with its
whole range and name range from the document's text, and from the index what
it overrides or implements (Mago's `overridden_method_ids`, or the parent class
and interfaces), whether that is abstract, and whether a descendant overrides
it. One answer serves both Go to Super Method (⌘U), which picks the innermost
member around the caret, and the gutter arrows, which ask again when the
server publishes the file's problems (it does after indexing an edit) or two
seconds after an edit. The arrows use the glyph margin's right lane, as the
test run buttons do; the debugger's click handler skips them. Clicking a
"down" arrow runs Monaco's Go to Implementation at the member's name.

### Generate

`src/generate.ts` is PhpStorm's ⌘N menu for PHP. It lists the code actions
Tusk's server offers for the class at the cursor, asking for
`source.generate` and `quickfix`, and runs the chosen one with
`runTuskAction`, which resolves its edit:

- `source.generate.constructor`, `.getters`, `.setters`, `.accessors` (getters
  and setters), `.toString`, and `.override` (Override Methods, one action per
  method), from `generate_candidates` in
  `features/actions/generate.rs`. The server reads the class's properties from
  the syntax tree: declared ones, and those promoted in its constructor.
  Static properties are left out, readonly ones (or a readonly class's) get no
  setter, and a method the class declares itself isn't offered again. The
  constructor takes the properties without a default and goes after the last
  property. Getters are named `getTitle` and setters `setTitle`, as PhpStorm
  names them, typed as the property is. The light bulb doesn't list
  `source` actions.
  Override Methods was a quick fix, so the light bulb listed every parent
  method at any point in a class.
- The quick fixes Implement Methods (including a trait's abstract methods),
  Complete Constructor, Promote Constructor, and Add Missing
  Properties.

The menu shows them in that order, with the properties or the overridden
method as each row's detail.

⌘N is also **New File…**. The shortcut handler now takes the first action for
the keys that applies (an editor-only action needs the editor focused, and
`when` must pass), so **Generate…** runs in a PHP editor and **New File…**
everywhere else.

### Call hierarchy

`src/callhierarchy.ts` shows the tree that Tusk's server gives:
`textDocument/prepareCallHierarchy`, then `callHierarchy/incomingCalls` or
`callHierarchy/outgoingCalls` as each row expands, reusing the type
hierarchy's styles. A caller with several calls gets a row for each call, so
each row opens its call.

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
  FormRequest's `rules()` or a controller's `validate()` or
  `Validator::make()` (its second argument, since the data before it is often
  an array too) with bracket matching that skips strings and comments.
  `routeRules` in `src/runner.ts` also tries each `$this->` method the action
  calls, for rules in a helper such as `validateRequest()`. `bodyFromRules`
  in `src/httpfile.ts` picks each field's example value from the rules. **Go to Controller**
  matches the request to a route with `matchRoute`.
- Scripts run in `src/httpscript.worker.ts`, a worker with no access to Tauri's
  IPC, so a script in a cloned repository can't run commands. The worker is
  stopped after 5 seconds. It gets copies of the globals and variables and
  returns the changed ones, with test results and logs.
- `src/httpview.ts` is the tool window and the HTTP tab. The tab has a
  `RequestTab` per open request. Each tracks its request with a model
  decoration on the request's first line, which moves as the file changes
  above it, and keeps its own response (`exchange`), its send in progress
  (`sending`, so a response lands in the tab that sent it), and a WebSocket
  log (`live`). A preview tab (`preview`) is replaced by the next request
  opened as a preview, and becomes a lasting tab when you edit or send it.
  `requestsIn` caches each model's parse by version, since every tab label
  parses its file.
- Form edits go to the tab's `draft`: the request, formatted, while it differs
  from `formatRequest` of the file's request. So unsaved state is per tab, not
  per file, and the file's model changes only when a tab is saved.
  `requestOf` gives the draft with the file request's line numbers, so the
  history and the tool window still match it. `saveRequestTab` writes the
  draft over the request's block with `writeRequest`, which replaces only the
  lines between the unchanged ones at the block's start and end, in one
  undoable edit (the parser keeps comments among the headers and in the body,
  and a URL over several lines, so formatting puts them back), and saves the
  file, unless its editor tab has unsaved changes, which would be saved with
  it. `renderRequestTabs` drops a draft the file has come to match.
- `main.ts` keeps `held`, the files request tabs use, so closing a file's
  editor tab keeps the model (reverted to the disk's text on **Don't Save**)
  and the tabs' decorations. A moved file's tabs follow it
  (`requestFileMoved`), and a deleted one's close with its model
  (`onWillDispose`). ⌘S and ⌘W act on the request tab when focus is in the
  HTTP tab (`saveFocusedRequest`, `closeFocusedRequest`). Actions in the tool
  window, such as deleting a request, save the file only when its editor tab
  has no unsaved changes (`edited`).
- The session keeps the request tabs (`HttpSession`) as file, line, key
  (`@name`, or else method and URL, of the file's request, since a draft may
  change them), and draft. Restoring finds the request with the same key
  nearest its old line, since the file may have changed, and keeps a draft of
  a request that's gone, which saving puts at the file's end. Since drafts
  come back, quitting and opening another project don't ask about them; only
  closing a tab does.
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
- Sync with Routes is `src/httpsync.ts`, loaded with `import()` the first time
  it's used. `routeSync` in `httpfile.ts` matches requests to `{{host}}` with
  routes by `matchRoute`, and lists the changes: an `add` for each route no
  request calls, an `update` when `syncBody` changes a JSON body (fields the
  rules add, with `bodyFromRules`' example values, and fields no rule
  validates removed, keeping the body's order, values, and indentation), and a
  `remove` for each request no route answers. `syncBody` leaves a body alone
  when there are no rules, since they may be unreadable, or when it isn't a
  plain JSON object. `syncEdits` turns the ticked changes into line edits that
  don't overlap, which `applyLineEdits` makes to text for **View Diff** and
  `toMonaco` makes to the model in one undoable edit, so request tabs keep
  their decorations. The view keeps the model's version: if the file changes
  before you apply, it works the list out again instead of applying stale line
  numbers. The scope is API routes unless the file calls a route outside
  `api/`. A removed request's tabs close first (`dropTabsIn`).
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
  `grpc_call` also emits `grpc:<id>` with each reply's JSON as it arrives;
  `transmitGrpc` listens when the `Cancel` it gets has `onMessage`, which
  `sendIn` in `httpview.ts` sets to show a server stream's messages and count
  while the call runs. The final body replaces them.
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
  through `redact` unless you choose **Show secrets**.
- Response bodies follow the `httpHistoryBodies` setting (`registerSettings`
  in `httpclient.ts`). Before `remember` adds an exchange, `protectBody` moves
  the body as it came to `<cache>/http-session/<project>/` and, for "redact",
  writes `redactBody`'s copy (secret JSON and form fields hidden, the same
  names as requests) where the history keeps it; for "drop", nothing. The
  exchange in memory points at the session copy and remembers the history's
  in `savedBody`, and `withoutSecrets` writes `savedBody` as `bodyPath`, with
  `bodyHidden` saying what happened, so the body view shows a notice. The
  session folder is removed the first time a project's history loads, and by
  **Clear History**. A history file that can't be parsed is renamed
  `index.json.bad` rather than overwritten by the next send.
- `sendIn` in `httpview.ts` runs every send from the HTTP tab, including
  **Send Again**: the tab's spinner, clock, and **Cancel**, the stream view,
  and, on failure, the error with **Retry** (`errorPane`). Reading a body
  shows "Loading the body…" and an error with **Retry**. The tree and history
  use `listNav`; the request and response split uses `splitter` (saved as
  `httpRequest`).
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
makes Tusk's server index the project again.

### Spell checking

Spelling comes from `typos-lsp`, a language server for the `typos` checker,
bundled per architecture like Mago. `typos` checks words against a list of
known misspellings, not a dictionary, so it doesn't flag names, jargon, or
abbreviations, and it understands `camelCase` and `snake_case`. The server
reports misspellings as information with their corrections. The editor
underlines them with a green wave of their own (`typoDecorations` in
`lsp.ts`), or shows them as warnings or errors when **Show misspellings as**
says so (`spelling.severity`, applied in `toMarker`), and next and previous
problem skip them. It's a native binary, so the bridge runs it without a
runtime (an empty runtime in `lsp.rs`). Changing the **Check spelling**
setting restarts the servers, which starts or stops it.

`src/spelling.ts` owns the rest, and sets `spelling` in `lsp.ts` (the
languages, the severity, and the user dictionary's path) rather than
`lsp.ts` importing it:

- A dictionary is `word = "word"` entries under `[default.extend-words]`. The
  project's is the `typos.toml`, `_typos.toml`, or `.typos.toml` it has, else
  `_typos.toml`. The user's is `spelling.toml` in the app's config folder,
  passed as typos-lsp's `config` option, which it merges over the project's
  file: `extend-words` from both apply. (Its `extend-ignore-re` replaces the
  project's instead, so the user file holds only words; that rules out a
  per-line suppression comment.) The file is created before the server starts,
  since typos-lsp drops every configuration when its `config` file is missing.
- Saving a word runs typos-lsp's own `ignore-in-project` command with the
  chosen file: the server writes the file with `toml_edit` and checks every
  open file again, without a restart. The command doesn't fail when it can't
  write, so `addWord` reads the file back to confirm. With the server stopped,
  the Tauri command `toml_edit` writes the word.
- Removing a word, or **Don't check spelling in this file** (`[files]
  extend-exclude`), edits the file with `toml_edit`, then `restartSpelling`
  starts typos-lsp alone again, since it reads its files only as it starts.
  Changing the file types does the same.
- Monaco's code action provider for every language (`"*"`) offers the
  dictionary actions for markers from `typos`; the generic provider drops
  typos-lsp's own "Ignore in the project" actions.
- **Settings > Spelling** adds a section (`registerSettingsSection`) with the
  file types (`spellingSkip`, the languages you turned off) and a
  `listEditor` for each dictionary.

`toml_edit` and `toml_read` (`src-tauri/src/lsp.rs`) are the app's TOML
access. `toml_edit` applies `{ path, value, inline? }` edits through
`tusk_lsp::config_edit`, which keeps comments, key order, and keys it doesn't
touch; a null value removes a key, and a table left empty goes with it.

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
   Tusk's server, so a variable's class is included even when the file never names
   it. `typedNames` lists the variables and properties before `->` in the 30
   lines before the cursor, nearest first, up to six, and the editor asks
   the server for each one's type definition (`textDocument/typeDefinition`),
   whose file gives the class. A request never waits for the server: it uses the
   types found so far and starts lookups for the rest, and a type that arrives
   readies the prompt again. A lookup often runs before the server has the edit
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

The `types` configuration adds the classes of the names before `->`, found as
the editor finds them: the benchmark runs Tusk's server (build it first with
`cargo build --release --manifest-path tusk-lsp/Cargo.toml`) and asks
`textDocument/typeDefinition` for each name. The results below came from
Phpactor's command line (`offset:info`), before the switch. Over 600 cases, the types changed the context in 71, and the exact first line
went from 43 to 44 of those (62.7% to 62.8% overall). koel imports nearly
every class it uses, so the types rarely add a class the outlines lack, and
without a database there are no model columns, where a variable's type
matters most (`$playlist->` after `$playlist = $this->service->create()`).
The types stay: they cost about 50 tokens and a server request that doesn't
delay suggestions, and they help code that gets its objects from other
classes. Blade views aren't measured: the benchmark only hides code in PHP
classes. Run the benchmark again after changing the context, the
request, or the model.

## Laravel, diagnostics, and formatting (milestone 3)

### Several language servers

`lsp.rs` keeps running servers by name. `lsp_start` accepts only known names
(`tusk`, `tailwind`, `typos`, and the frontend servers), so the frontend can't
start arbitrary commands. Each server's messages arrive as a separate event,
such as `lsp:tusk`.

In `lsp.ts`, `startServer` creates one client per server with its own request
IDs, diagnostics, and Monaco providers. It passes the server's language list to
every provider registration. Tusk's server takes `php` and `blade` and always
starts; it turns its Laravel features on when the folder has an `artisan` file,
and its Filament features when it has `vendor/filament/filament`.

Laravel LSP ran its PHP helpers from `storage/framework/lsp-<hash>.php`, and a
server stopped mid-run left one in the user's project. `lsp_start` still
removes helpers older than a minute when Tusk's server starts, for projects
that used an earlier build.

Monaco combines providers for the same language: it merges completion lists,
definitions, references, hovers, code actions, and links. Each server writes
its markers under its own owner (such as `lsp:tusk`), so one server's
diagnostics never replace another's. A code action carries the function that
runs it, so it goes back to the server that created it.

### Server lifetime

Opening another folder stops the old clients and servers. Quitting the app
stops all servers through `LspState::stop_all`.

If the app crashes or is force-quit, that code never runs. Many servers ignore
the LSP `processId` and keep running, so each server starts through a small shell
watchdog (`WATCHDOG` in `lsp.rs`). The shell starts a loop that checks the
app's process ID every 2 seconds, then replaces itself with the server through
`exec`. The server keeps the shell's process ID, so stopping it normally still
works, and the loop kills it within 2 seconds after the app dies.

A server that exits on its own, such as from a crash, is restarted. Stopping or
replacing a server removes it from `LspState` before killing it, so when a
server's output ends while it's still listed, it exited by itself: `lsp_start`'s
reader thread removes it and emits `lsp-exit` with its name. The client fails
that server's pending requests and restarts the servers (`serverExited`),
unless servers exited more than 3 times in 5 minutes, when the status bar asks
you to reopen the project instead.

### Mago

Tusk's server runs Mago's analyzer and linter in its own process on each edit
(see "Tusk's language server"), so their problems arrive with sources `mago`
and `mago-lint` while you type. Mago's command line still checks Blade views,
lists the linter's rules for the Problems panel, and computes Mago's fixes.

Formatting doesn't go through a language server; see the next section.

### Default Mago configuration

The bundled `resources/mago.toml`, used when a project has no `mago.toml`,
sets:

- `paths = ["."]` and `includes = ["vendor"]`, so project classes and
  framework classes such as facades resolve on the command line. Project
  folders must not go in `includes`, because Mago never lints included files.
- `excludes` for hidden folders (`.*`), `node_modules`, `storage`, and
  `bootstrap/cache`. Hidden folders can hold whole copies of the project, such
  as git worktrees in `.claude/`. `projectMagoConfig` adds the project's
  index exclusions.
- The Laravel lint integration, with `strict-types` and
  `literal-named-argument` turned off. On the test app, those two rules
  produced 154 warnings on standard Laravel code.

`projectMagoConfig` writes the project's copy to the app's cache and passes
its path to Tusk's server as `magoConfig`. The server reads its analyzer and
linter options, and its `includes` and `excludes` for the index. The file is
outside the project, so the client asks the server to reindex after it writes
the file again with corrected vendor copies.

### Mago's settings page

`src/magosettings.ts` draws **Settings > PHP Analysis** and the quick fixes
that change `mago.toml`:

- The Tauri command `mago_settings(root, path)` reads a configuration through
  `tusk_lsp::mago_config::describe`: its `php-version` and composer.json's,
  the analyzer's switches (the file's value and the default from
  `analysis::settings`), its excludes and ignores, the linter's excludes, and
  every rule whose requirements the configured PHP version and integrations
  meet (`RuleRegistry::build` with disabled rules, and each rule's
  `RuleMeta`: name, description, and category). Each rule's `enabled` and
  `level` come from `filter_rules_settings`, and its defaults from the rule.
  Nothing is listed by hand, so the page follows Mago's crates when they're
  upgraded. `path` is the project's `mago.toml`, or `magoConfigPath`, the
  editor's copy, when there's none.
- Every change goes through `editMago`, which applies `toml_edit` edits to
  the project's `mago.toml`. A value equal to Mago's default removes the key,
  and a rule's table is inline (`no-empty = { level = "warning" }`), as the
  bundled file writes them; `config_edit` formats an inline table again after
  a key is added. Without a `mago.toml`, the first change creates it from
  `newMagoConfigText` (the bundled defaults with the project's PHP version and
  top-level folders), then `useProjectMagoConfig` drops `magoConfig` from the
  server's options (`configureTusk`), which reindexes with the new file, and
  Blade checks read it too. Otherwise `reindex` reads the file again at once
  rather than waiting for the file watcher.
- The page keeps its controls as you change them, so a toggle doesn't lose
  the rules list's scroll or filter; a failed write draws the page again from
  the file.
- The quick fixes, a provider for `php`: **Disable *rule* in mago.toml** and
  **Change *rule*'s level…** (a `choose` picker) for `mago-lint` problems, and
  **Ignore *code* in mago.toml** (`[analyzer] ignore`) for `mago` ones.

The page's first two settings, `loadAllLibraries` and `stubs`, are the
server's own options, not Mago's: project settings under `phpAnalysis`, sent
through `tuskOptions`. `tuskSettings` adds list options together, so the user's
stub folders join Laravel's alias stubs. Stub paths are made absolute and
normalized: the index compares paths by their text, and a `..` in one made its
files project code under a wrong path.

### PHPStan and Larastan

The server (`phpstan.rs`) runs `php vendor/bin/phpstan analyse
--error-format=json` on a PHP file when it opens and each time it's saved, one
run at a time on a thread of its own, with the project's own configuration.
PHPStan reads files from disk, so its problems (source `phpstan`, severity
Error, the identifier as the code) cover their line and keep it until the next
run. A run that fails keeps the last results.

The `phpstan` option (`phpstan::Settings`: `enabled`, `config`, `level`,
`memoryLimit`, `timeout`, `run`) comes from `src/phpstan.ts`, which registers
it as project settings (`registerProjectSettings`, key `phpstan`, shareable)
and as one of `tuskOptions` in `lsp.ts`. A change sends every option again
with `workspace/didChangeConfiguration` (`configureTusk`). The server gives
PHPStan's part to `PhpStan::configure`, which drops the problems found with
the old settings and checks the open files again; any other option that
changed rebuilds the index. PHPStan's arguments are `arguments()`:
`--configuration`, `--level`, and `--memory-limit` only when set.

Each run reports its state with a `tusk/phpstan` notification (`off`,
`missing`, `idle`, `running`, `failed`, and a message). `parse_report` reads
the reason for a failure: out of memory (PHP's "Allowed memory size" or
"Failed to set memory limit"), the report's first general error when no file
has problems (such as a path that doesn't exist), or the first line PHPStan
printed instead of a report, without PHP's `in phar://…` location. PHP writes
an empty `files` as `[]`, so the report is read as JSON first. A run past the
timeout is killed. `phpstan.ts` shows a running check as a status bar spinner,
toasts a failure once per new reason, and hands the state to the Problems
panel's **PHPStan** button (`setPhpStanState`), which is hidden while the
project has no PHPStan and nobody turned it on.

`tusk/phpstanProject` runs PHPStan with no paths, so it checks the
configuration's `paths`, on the PHPStan thread after any file run, and answers
with the problems by relative path. It waits on a thread of its own, not the
request pool, since it takes minutes on a large project. Its results replace
every file's PHPStan problems, so open files show them too, and
`runPhpStan` in `problems.ts` keeps them in `phpstanFound`, beside the Mago
scan's `scanned`, so each scan leaves the other's results alone.

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
in the Problems panel as soon as the view is open, since no server check
has to finish first.

Tusk's server answers definitions and completions for component tags with the
component's view. A definition provider in `main.ts` adds the class of a
class-based component, from `componentClassPath` in `src/phptypes.ts`.

## Search and navigation (milestone 4)

### Palette

`src/palette.ts` has one picker, `pick`, used by every search. It takes a
source function that returns items for a query. Slow sources (language server
and disk searches) run after a short delay, and results from an older query are
dropped if a newer one already ran. `fuzzy` scores a subsequence match and
favors consecutive letters and letters that start a word, such as the `P` and
`C` in `PostController`. The query as one block scores more, and more again in
the file name and at its start, so `user` finds `User.php` before
`tests/Unit/SettingResourceTest.php`, whose word starts spell it out.
`src/palette.test.ts` covers it.

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

Go to class hides symbols inside a `.phar`, whose files can't be opened. Tusk's
server leaves PHP's own built-ins out of workspace symbols for the same reason.


Results stop at 20,000 matches (`MAX_MATCHES` in `search.rs`). To keep the
sidebar fast, files render their matches only when expanded, and they start
expanded while the total stays under 2,000 rows. Replace All asks
`files_matching` for every file with a match, with no limit, so it doesn't
depend on what's listed. A single match is replaced by running its text through
`replace_text`, so regex groups behave as in Replace All, after checking that
the file still holds the match where the search found it.

`list_files` takes `all`, which turns off `.gitignore` for Go to File's second
press.
Searches cancel for real: each Find view search passes an `id` to
`search_text`, and a newer one calls `search_cancel(id)`, which sets the
search's flag in `RUNNING` (a map in `search.rs`); the walk checks it between
files and fails with "Cancelled", which the view ignores. `exclude` adds
negated globs to the same overrides as `include`. The field history is
localStorage (`findHistory`), since it's per user, shown through each input's
`<datalist>`.

Replace All opens `src/replacepreview.ts`. `replacements` in `search.rs`
works out each match's replacement against its line at its column
(`captures_at`), so anchors and lookarounds see the same text the search did,
in one call for every match. The preview's checkboxes pick which ones
`applyKept` in `search.ts` applies, through `applyReplacements` in
`src/replacedata.ts` (with tests), which leaves a line alone when it no
longer reads as the search saw it. `nextMatch` walks the results by key
(`<path>\n<index>`), opening a collapsed file first.

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

The terminal's font comes from the Terminal settings group, which
`terminal.ts` adds with `registerSettings`: an empty font or size follows the
editor's, and `onSettings` updates open terminals and refits them. The search
add-on (`@xterm/addon-search`, which needs `allowProposedApi` for its match
highlights) backs the find bar, which **Find in Terminal** (⌘F with a `when`
of `terminalFocused`, so ⌘F still reaches Monaco in the editor) opens over the
focused terminal. The web-links add-on opens URLs with `open`. A link provider
finds file references in each line with `fileLinks` in `src/termlinks.ts`
(tested), resolves them with `candidatePaths` (the container root from
`src/sail.ts` maps to the project; a relative path tries the shell's folder,
then the project's), checks that the file exists with `path_exists` (cached),
and opens it through the docking host's `openAt`. Tabs are a `tablist` with a
roving tabindex: ← and → move between them, and double-clicking a terminal's
tab renames it in place.

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
shows the links instead; its `onDidChange` fires on every settings change.

Run Anything loads `php artisan list --format=json` once per project through
the `run_capture` command, and ranks command names against the first word you
type. The rest of the line becomes the command's arguments. When artisan
prints something that isn't JSON, its first two lines become a row that says
why, which runs `artisan list` in a terminal. Shell lines run through
`/bin/sh -c`, so quoting and pipes work.

### Run configurations

`src/runconfig.ts` holds the model, free of editor imports so Node tests it:
the `RunConfig` type (one flat object; each type reads the fields it needs),
`TYPES` (each type's label, icon, whether it runs PHP, defaults, and form
fields), `commandFor` (the argv a configuration runs, relative to the project,
before the container and reports), `validate`, `shellWords` for the arguments
fields, and `addTemporary`, which keeps the five newest temporary
configurations. The dialog (`src/runconfigdialog.ts`) builds its form from
`TYPES[type].fields` plus the common fields, so a new type is an entry in
`TYPES` and a case in `commandFor`.

`src/runner.ts` keeps configurations in the project state under four keys:
`runConfigurations` (shared, in `tusk.json`), `localRunConfigurations`,
`temporaryRunConfigurations`, and `selectedRunConfiguration` (all local). A
configuration's place is its list, so **Store in tusk.json (share)** moves it
between the first two. Names identify configurations, so before-launch steps
refer to them by name, and a rename in the dialog updates those steps.

`runConfig` validates, asks to stop an earlier run unless the configuration
allows several, runs before-launch steps one after another (each waits for
its exit code, and anything but 0 stops the launch), and then `launch` builds
the command: `commandFor`, then the test reports, then the container
(`runningContainer`, when the configuration runs in Docker) or `/usr/bin/env`
with the environment and Xdebug's variables on this Mac. Composer runs through
the bundled `composer.phar` on the Mac. Runs are tracked while their terminal
runs, for the widget's running dot and Stop. `pty-exit` events carry the exit
code: after the output ends, `pty.rs` polls `try_wait` for up to a second.
`openTerminal` returns a `TerminalRun` whose `stop` writes ⌃C to the terminal
and kills the process 3 seconds later, or at once on a second call.

The gutter's run buttons, **Run Test at Cursor**, **Run All Tests**, and Run
Anything make temporary configurations through `runTemporary`, which selects
the new one; when a saved configuration has the same settings, it runs that
one instead. **Rerun** repeats the last run with its mode, and **Rerun Failed
Tests** runs the last test configuration with a `filter` scope built by
`filterFor`, without saving it.

### Test results

Every test run adds `--log-junit <app cache>/junit-<n>.xml`, which PHPUnit, Pest,
and `php artisan test` all accept, numbered per run so two test runs don't
share files. The reports are deleted before the run, so a run that fails to
start doesn't show old results, and after it, once read. `openTerminal` takes an
`onExit` callback, and when the process ends, `src/testresults.ts` reads the
report and shows the **Tests** tab.

Every run also writes a TeamCity log (`--log-teamcity`). Pest's JUnit report
leaves out assertion diffs, and PHPUnit's has only a unified diff of the lines
around changes, but the log's `testFailed` lines carry `expected` and `actual`
in full (`type='comparisonFailure'`) and the whole stack in `details`, for
Pest and PHPUnit alike. `withDetails` joins them to the report's results by
`testKey`, the class and the name without case, punctuation, or a `test`
prefix, which matches JUnit's readable labels to the log's method names.
`parseFailure` splits a message into its text, the comparison (the log's, or
else PHPUnit's `--- Expected`/`+++ Actual` diff, where context lines go to both
sides), and the stack frames (`path:line`, Pest's `at path:line`, and PHP's
`#0 path(line)`). `localPath` maps a container's paths to the project, and a
frame from another container root is tried by its `app/`, `tests/`, or
`vendor/` part under the project.

The tab keeps one list of rows for the live and the final views, keyed by
`testKey`, so the selection survives the switch to the report. It draws a flat
list of `treeitem` rows with `aria-level` and `aria-expanded` for `listNav`:
selecting a row shows its detail, Enter or a double-click opens the source,
and → and ← expand and collapse a class. The view options (show passed, show
ignored, sort by duration, track the running test) are per user, in
localStorage. The diff link opens the Git diff view with the expected and
actual values.

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
folder. `pull`, `push`, and `fetch` run through `gitOutput` (see
[Commands with messages](#commands-with-messages)) with credential prompts off,
and a failure that needs a password offers to run the command in a terminal
tab. `src/gitparse.ts` parses the machine-readable
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

`src/commitview.ts` draws the Commit view's files as one tree (`listNav`):
group rows for conflicts, staged, and unstaged files, optional folder rows, and
file rows keyed `<group>:<path>`. It splits files by `git status` letter: a
file with an index letter is staged, and a file with a working tree letter has
unstaged changes. A file can be in both groups. `listNav` moves one cursor; the
view keeps its own set of picked rows for multi-select, updated by ⌘ and ⇧
clicks and by ⇧ with the arrow keys (a capturing keydown listener notes ⇧
before `listNav` moves). Bulk actions take the picked rows when the row acted
on is one of them.

If `git status` fails, `gitStatusError` keeps git's message, so the empty view
tells "not a git repository" (with **Initialize Repository**) from git missing
or a folder git doesn't trust.

A commit runs through `gitOutput` under `withProgress`, with the buttons off
until it ends, so a double click can't commit twice, and a failing hook's
output is kept for **Show Details**.

### Push and update

`src/sync.ts` has the Push dialog and Update Project. The dialog lists
`git log <upstream>..HEAD`, or `HEAD --not --remotes` for a branch with no
upstream, and pushes `HEAD:refs/heads/<branch>` with `--porcelain`, `-u` for a
first push, and optionally `--force-with-lease`. `rejected` and `authFailed`
read git's output to choose the next step. Update runs
`git pull --autostash` with `--no-rebase` or `--rebase` from the
`gitUpdateMethod` setting, and counts the new commits from HEAD before and
after.

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
(`LOG_FORMAT`), parsed by `parseLog`. The header's filters become `git log`
arguments, so they search the whole history: `--grep` with
`--fixed-strings --regexp-ignore-case` for the text, `--author`, a branch or
`--all`, and a path after `--`. Text that looks like a hash also runs
`git log -1 <text>^{commit}`, and that commit goes first. A counter drops the
results of a search that a newer one replaced.

Without filters, the list has a branch graph. `graphRows` in `gitparse.ts`
lays it out from each commit's parents: every lane waits for a commit, a
commit takes the lane that waits for it and hands it to its first parent, and
merged parents join a lane that waits for them or take a free one. Lanes don't
shift, so lines that pass a row are straight, and each row is its own small
SVG. The graph needs children before parents, so the log runs with
`--date-order` while it shows; the default order breaks that when commits share
a timestamp. Filters leave gaps in the parents, so the graph hides then.

Clicking a blame annotation (a `GUTTER_LINE_NUMBERS` mouse target while the
editor is annotated) opens `showCommitPopup` with the commit's message and
files. `blameMenu` gives the gutter's context menu the same actions. File history adds `--follow` to track
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

Each version's file name carries what kept it: `<ms>~<action>.txt`, with the
action URI-encoded (`src/localhistorydata.ts`, with tests); older `<ms>.txt`
files read as **Saved**. `recordVersion(path, text, action)` takes the action;
"external" and "before external" become the current activity, which
`historyActivity` sets for ten seconds: `change` in `git.ts` sets
`git <command>`, and a revert sets `revert`, so the file watcher's versions
name their cause. `applyWorkspaceEdit` in `lsp.ts` records the text before and
after each file's refactoring, since its saves bypass `saveFile`. Labels are
`labels.json` in the project's history folder, the newest 100.

The **Local History** tab (`src/localhistoryview.ts`, loaded on first use) is
a panel view: a `listNav` list of versions and labels, a `splitter`, and its
own Monaco diff editor with `localhistory:` URIs, so the language servers
don't see the models. A folder's history reads every history folder whose
path starts with the folder, under `withProgress` with Cancel and an "N of M
files" count. `revertFiles` records each current text as "Before revert",
then writes through the host's `setText`, which edits an open model as one
undo step and writes the file, and returns what `undoRevert` needs. A label's
revert takes each file's newest version at or before the label
(`versionAt`).

Two more moments add a version. When the file watcher reports that an open,
unmodified file changed on disk, the editor records the model's text before
reloading it. Deleting from the tree records the file, or each file in the
folder that `list_files` returns (ignored files left out, at most 500), before
moving it to the Trash.

For files that aren't open, the editor has no copy of the text before the
change, so `recordExternalChanges` keeps the text after it: the next change
then finds its earlier text in the history. The watcher batch in `main.ts`
passes it every changed path without a Monaco model. It skips folders in
the project tree's hidden and excluded patterns (`skippedPath` in
`src/treehidden.ts`, such as `vendor` and `node_modules`), `.env`
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
history folders whose project path no longer exists and opens the tab for
one, and reverting creates the missing parent folders.

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

The dialog's list uses `listNav`. Each step keeps a key as it moves, so the
selection follows it. ⌥↑ and ⌥↓ move a commit, and a letter sets its action,
in a capturing listener that runs before `listNav`'s type-ahead. Drag and drop
uses the HTML drag events, dropping before or after a row by which half the
pointer is over. Merge commands (label, reset, merge) never move, and no commit
moves past one. Building the merges list runs under `withProgress`, since it
checks out a temporary worktree.

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

`src/stash.ts` draws the **Stashes** tab of the Commit tool window, a tree with
`listNav`. It reads `git stash list --format=%gd%x1f%H%x1f%ct%x1f%gs`
(`parseStashList` takes the branch and message from the reflog subject) and
keys rows by commit hash, since `stash@{n}` refs shift when an older stash is
dropped. A stash's files come from
`git stash show --include-untracked --name-status -z`, read once per hash
because a stash never changes. A stashed file's diff compares the stash's first
parent (the commit it was made on) with the stash; untracked files come from
the stash's third parent. The tab reloads after each git refresh while it's
shown (`refreshListeners` in `git.ts`), so stashes made in a terminal appear.

Apply, pop, and unstash as a branch (`git stash branch`) run through
`gitOutput`, which returns git's combined output and exit code instead of
failing with standard error only, so a conflicting apply can say so and offer
the merge tool.

### Diffs of several files

`showDiffs` in `git.ts` shows one file of a list, such as a stash's or a
commit's files, with a file picker and previous and next buttons (⌥⌘← and
⌥⌘→) in the diff's header. Each file loads when you move to it, under
`withProgress`, so a slow `git show` shows a spinner rather than nothing.

### Commands with messages

`run_capture` returns standard output on success and standard error on
failure, so a command's messages are lost either way for commands such as
`push`, whose news goes to standard error, or `stash apply`, which reports
conflicts on standard output and fails. `gitOutput` runs git through
`/bin/sh` with `2>&1` and appends the exit code, and sets
`GIT_TERMINAL_PROMPT=0`, since no terminal can answer a credential prompt.
It writes git's process ID to a file in the app cache, so an aborted signal
can `kill` it: Tauri commands can't be aborted, and this avoids a Rust
command for it.

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

The view first shows a loading cover and a spinner while the three `git show`
calls and `git ls-files -u` run. A missing stage 2 or 3 in `ls-files -u` means
that side deleted the file, which the titles and a bar with **Keep File**
(`git add`) and **Delete File** (`git rm`) show.

**Apply Non-Conflicting Changes** runs `resolveSimple` in `gitparse.ts` on each
conflict: it diffs each side against the base and applies both sets of changes
when no two overlap or insert at the same place. The base comes from the
block's diff3 section, or, for the default conflict style, from
`git merge-file -p --diff3` run on the three stages in the app cache, matched
to the file's conflicts by the text of both sides. All the merges go in as one
undoable edit.

The list of conflicted files on the left is the files `git status` still
reports as conflicted, plus those resolved in the tool since, until none are
left. **Mark Resolved** reports a failed save or `git add` and keeps the file
open; otherwise it moves to the next conflicted file.

The result pane turns off CodeLens and draws its own **Accept** buttons as
one-line view zones above each conflict, because a CodeLens takes height the
alignment can't count. Monaco draws its text layer above view zones, so a click
never reaches the buttons; `onMouseDown` reports a view-zone target with its
id, and the button under the pointer is found by position.
### Branches

`src/branches.ts` draws the branches popup with the palette, anchored below
the title bar's branch name or above the status bar's. It reads
`git for-each-ref` in `REF_FORMAT` (`parseRefs` in `gitparse.ts`), with full
ref names, which tell local branches (`refs/heads/`) from remote ones
(`refs/remotes/`) even when a local name contains a slash, and
`%(upstream:track)` for the ahead and behind counts. It sorts by
`-committerdate`, then puts local branches before remote ones and the current
branch first. A branch's actions open as a second, numbered popup, as
PhpStorm's submenu does; the palette has no submenus.

Actions that change the repository run through `gitTask` in `git.ts`:
`gitOutput` under `withProgress`, then a refresh. A failure shows git's
message, with **Show Details** for output longer than a line; a failure that
left conflicted files offers the merge tool instead. Checking out a remote
branch runs `git checkout --track`, or checks out the local branch of the same
name. When checkout fails, `git checkout --dry-run` tells whether local changes
were in the way, and only then offers Smart Checkout (stash, check out, pop).
Delete tries `git branch -d` and asks before `-D` when git says the branch
isn't fully merged; the hash it had goes into a **Restore** action.

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

## Filament intelligence (milestone 6)

Tusk's server completes Filament's fluent methods, such as
`TextInput::make()->required()`, because they are ordinary typed PHP. Its
Filament features (`tusk-lsp/src/framework/filament.rs`, see "Filament" under
"Tusk's language server") cover what no general PHP server knows: the strings
Filament resolves against Eloquent models at run time. Until September 2026 a
separate server written in PHP (`filament-lsp/server.php`) did this; the Rust
port keeps its behavior.

### Why a subprocess

PHP can't unload a class, so reading the project's classes in one long-lived
PHP process would never see edits to models and resources. The server runs
`introspect.php` in a new process, which boots the app, reads the classes
through reflection, and exits. The server caches each result until a file it
depends on changes (`app/`, `config/`, `database/`, or `composer.lock`). A
call takes about 0.3 seconds on the test app.

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

### Strings and options

The server finds the strings in `::make('…')`, `->relationship('…')`, and
`->relationship('…', '…')` calls through the parsed code, and counts a call
only when the analyzer types its receiver as a Filament class (or can't type
it). Diagnostics check only relationship names (from `->relationship()` and
dotted `::make()` paths), because plain field names can be virtual attributes
that aren't columns. For `->options(`, `->enum(`, and `->default(`, the enum
comes from `->options(X::class)` or `->enum(X::class)` before the cursor in
the chain, or else from the model's cast of the field, and its cases from the
index. `$get('…')` and `$set('…')` offer every `::make()` name in the file.

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

Tusk's server implements `workspace/willRenameFiles`: given the old and new
paths, it returns edits for the class name, the namespace, and every reference. It
reads each file at its new path, so the editor moves the file on disk first,
then asks for the edits and applies them (`updateReferences` in `lsp.ts`). For
a folder, it sends one rename for each PHP file inside.

The server's index follows the edits as they're applied to open models, and
the file watcher's changes through `workspace/didChangeWatchedFiles`, which the
server registers for: a file that exists is reported as changed, and a missing
file as deleted. So a second move right after the first still finds every
reference.

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

## Project state

`src/projectstate.ts` keeps per-project values in two scopes. **Shared** values
live in the project's `tusk.json`, as top-level keys, so a team can commit
them. **Local** values live in `<appDataDir>/projects/<folder>-<hash>.json`
(`localFileName`, an FNV-1a hash of the project path), as
`{ root, migrated, values }`. Neither is localStorage, so resetting the web view
loses nothing. A value lives in one scope at a time; reads take `tusk.json`'s
first.

The API, for the rest of the app:

| Function | What it does |
| --- | --- |
| `openProjectState(root)` | Reads both files when a folder opens, and the first time, moves older localStorage values into the local file. `openFolder` awaits it before anything reads a value. |
| `projectValue<T>(key)` | The value, synchronously, or undefined. |
| `projectScope(key)` | `"shared"`, `"local"`, or undefined when unset. |
| `setProjectValue(key, value, scope?)` | Sets a value, or removes it with undefined. Without `scope`, it stays where it is; a new value is local. The other scope loses its copy. Rejects, without writing, when `tusk.json` is involved and invalid. |
| `setProjectScope(key, scope)` | Moves a value as it is. |
| `onProjectValue(key, f)` | Runs `f` when `tusk.json` changes the value on disk. Not for your own writes, and not when another project opens. |
| `shareItem(keys, what)` | A palette row that shares keys in `tusk.json` or keeps them local, for pickers that set them. |
| `SHAREABLE`, `chooseSharedState()` | The values a team may share, and **Share Project Settings in tusk.json…**, which lists them. |
| `projectFilesChanged(paths)` | Called from `main.ts`'s file watcher batch; rereads `tusk.json` when it changed. |

`src/projectstatedata.ts` holds the pure parts, with tests:
`parseShared` (values, or why the text can't be read), `writeShared` (applies
changes to the text, keeping unknown keys, their order, the indentation, and
the final newline; "" when no key is left, so the file is removed; throws on
an invalid file), `changedKeys`, and `migrate` with `LEGACY`, the table of
localStorage keys earlier versions used.

Writes go through one promise chain, so they land in order. The file watcher
reports our own writes too; `projectFilesChanged` waits for pending writes and
compares the text with the last text read or written, so only other programs'
changes notify. An invalid `tusk.json` shows a toast with **Open tusk.json**,
keeps the last values read, and refuses shared writes; local values still
work. `src/schemas/tusk.json` is the file's JSON schema, registered in
`src/jsonschemas.ts`.

Who uses which key:

| Key | Module | Default scope |
| --- | --- | --- |
| `indexExclude` | `lsp.ts` (`exclusionsFor`, `saveExclusions`); a change on disk restarts the servers | Local; the dialog's checkbox shares it |
| `breakpoints`, `debugWatches`, `debugExceptions`, `debugPathMappings` | `debug.ts`; breakpoints are saved with paths relative to the project | Local |
| `dockerService` | `sail.ts`, through `setServiceChoice` from `main.ts`, so `sail.ts` loads in tests without the app's modules | Local |
| `databaseConnections`, `databaseSsh`, `databaseReadOnly`, `databaseConnection` | `database.ts`; URLs come from `connectionUrl`, which leaves the password out | Local; Data Sources' checkbox shares the first three; the selection never shares |
| `databaseEnvOverride`, `databaseHistory` | `database.ts`: a URL that replaces `.env`'s connection on this Mac, and the last 100 statements run | Local only |
| `phpstan` | `phpstan.ts`, through `registerProjectSettings`; sent to Tusk's server as the `phpstan` option | Local; the settings group's box shares it |
| `profilerUrl`, `httpLoadTest` | `profiler.ts`, `httpload.ts` | Local only |
| `bookmarks` | `bookmarks.ts` | Local only |

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
3. For PHP, Tusk's server (`textDocument/formatting`), which formats its copy
   of the open file with Mago's formatter.

That order is **Auto**. The project's `formatters` value (the Formatters
dialog, `src/formattersdialog.ts`) picks a formatter per language group, and
format on save per group; `src/formatdata.ts` (with tests) holds the groups and
the lookups, `formatterFor` and `formatsOnSave`.

- A specific formatter runs alone: no fallback, and a missing one (Pint or PHP
  CS Fixer without `vendor/bin`, Prettier for PHP without the project's own)
  throws `Missing`, which shows with how to install it and a **Formatters…**
  button. Other failures go to the status bar, as before.
- PHP CS Fixer formats a copy in the temporary folder
  (`php-cs-fixer fix --using-cache=no <copy>`), run from the project so it
  reads the project's config; with an explicit path, its Finder doesn't apply.
- The provider is registered again when the choices change, for every language
  except those set to Built-in. Monaco's own formatters for CSS, HTML, JSON,
  and TypeScript (`setModeConfiguration`) are on only for those, or for Auto
  while Node.js is missing, so the two never compete.
- After formatting, `status("Formatted with …", "format")` names the formatter.
- `saveFile` asks `formatOnSave(language)` instead of reading the setting.

`detectFormatters` looks for Prettier, Pint, and PHP CS Fixer when a folder
opens.

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
   with the port, `stopOnEntry`, and `xdebugSettings` (`max_children`,
   `max_data`, and `max_depth` 1) from the **Debugger** settings group, which
   `debug.ts` adds with `registerSettings`. The adapter listens for Xdebug
   connections. When those settings change while nothing is being debugged,
   the listener restarts with them.
2. On the adapter's `initialized` event, the client sends every breakpoint
   (`setBreakpoints` per file), no exception filters, and `configurationDone`.
3. On a `stopped` event, it reads the `stackTrace`, opens the top frame's file
   at its line, marks the line, and loads the frame's `scopes` and each cheap
   scope's variables at once: the first scope shows open, the names feed the
   console's completion, and the first scope's values show at the ends of the
   lines above the paused one (`inlineValues`). Deeper values load one level at
   a time, when you expand them.
4. Stepping sends `continue`, `next`, `stepIn`, or `stepOut` for the stopped
   thread. `evaluate` runs in the selected frame.

Debugging starts processes with `xdebugEnv()`: `XDEBUG_MODE=debug`,
`XDEBUG_SESSION=<IDE key>`, and `XDEBUG_CONFIG=client_port=<port>` (plus
`client_host=<container host>` for a container, through `containerXdebugEnv`),
so Xdebug connects to the port the debugger listens on without a `php.ini`
change. `XDEBUG_CONFIG` overrides `xdebug.client_port` in `php.ini`. `php
artisan serve` passes all three variables to the PHP server it starts. Sail's
`sail debug` sets its own Xdebug configuration from `SAIL_XDEBUG_CONFIG`, so
there the port comes from `.env`.

Every DAP request fails instead of waiting forever when the bridge can't send
it (the adapter exited), and `stopDebugging` rejects the requests still
pending. Failures show where they happen: a `stackTrace` failure replaces the
call stack with the reason and **Retry**, a `scopes` failure does the same in
the variables, a `variables` failure shows under the row you expanded, and a
failed step shows an error and restores the paused state unless the
connection closed. When `launch` fails with `EADDRINUSE`, `portBusy` names the
program on the port (`lsof -Fcp`) and offers **Choose Another Port**, which
saves the setting and listens again; the adapter's own dump of Node's error is
dropped while starting.

A restart for new settings, or any stop, bumps `generation` and clears
`adapterUp` first, so the old adapter's late events and the failures of its
pending requests don't reach the new session's log. A `continued` event for
the paused thread, which the adapter sends only when the connection closes,
logs that PHP disconnected.

The panel tracks Xdebug connections from the adapter's `thread` events, so its
state reads Not listening, Listening on port N (with how to trigger a
connection), Running, or Paused at a file and line.

Breakpoints are model decorations with a glyph in the gutter, so they show in
every pane and move with the lines as you edit. They're saved in the project
state (`breakpoints`).

The **Breakpoints** tab (`src/breakpointsview.ts`) is a panel view, not a modal
dialog as in PhpStorm, so the gutter stays usable and changes there show in it
at once: `debug.ts` calls `view.refresh()` from `update`, `loadBreakpoints`, the
exception options, and edits that move a breakpoint. The view doesn't import
`debug.ts`; it gets an `Api` object of functions, which avoids an import cycle.
The tree is a flat run of rows with `aria-level`, driven by `listNav`; the
right side edits the selected item and applies each field on `change`, and it
isn't redrawn while one of its fields has focus. A line's code comes from its
model when the file is open, or else from one `read_file` per file each time
the tab opens.

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

Watches are a list of expressions in the project state (`debugWatches`). After a frame
is selected, each one goes to `evaluate` with the `watch` context, and the
result renders with the same row as a variable, so objects expand.

Pause on exceptions sends exception filters. The adapter makes each filter an
Xdebug exception breakpoint on that class name, whatever the name (its own
filter list, such as `Notice`, is only what it suggests), and Xdebug also
matches subclasses. Without chosen classes the filters are `Exception` and
`Error`, which cover every `Throwable`. Turning it on or off is app-wide; the
classes and the other options are per project, in the project state
(`debugExceptions`). The Breakpoints tab edits them; the toolbar's zap button
turns them on and off and the arrow beside it opens them.

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
evaluates the text as PHP, and replies with the text as typed. The adapter also
keeps a value's children as first read, so the row evaluates the variable's
`evaluateName` to show the value as PHP now sees it. **Copy Value** on an array
or object evaluates `print_r(<name>, true)`.

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
statements in one transaction, `db_cancel`, which stops a running query, and
`db_tunnel`, for SSH. Every value comes
back as text or null, which is all the grid needs, so no driver's type mapping
leaks into the frontend:

| Driver | Crate | How values become text |
| --- | --- | --- |
| SQLite | `rusqlite` with its bundled SQLite | Each `ValueRef` is formatted. Blobs come back as `\x` and hex, as PostgreSQL shows `bytea`. |
| MySQL, MariaDB | `mysql`, with `native-tls` | The text protocol (`query_iter`) returns every value as bytes; bytes that aren't UTF-8 come back as `\x` and hex. |
| PostgreSQL | `postgres`, with `postgres-native-tls` | The simple query protocol returns every value as text. |
| Redis | None: a RESP2 client in `db.rs`, with `native-tls` for `rediss://` | Bulk strings are read as UTF-8 text, and integers are formatted. |

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
<destination>`, with `-i <key> -o IdentitiesOnly=yes` when the connection has
a key file, under the same watchdog as the language servers, so it ends with
the app, and waits up to 15 seconds for the local port to accept connections.
`BatchMode=yes` makes a password prompt fail at once instead of hanging,
`ExitOnForwardFailure=yes` makes a failed forward end ssh, whose error message
is returned, and `ServerAliveInterval` ends a tunnel whose connection died,
such as after the Mac sleeps, so the next query opens a new one. Once the
tunnel works, a thread keeps reading ssh's error output, which would otherwise
fill its pipe and stop ssh. Tunnels are kept per destination and address, and reused while
ssh runs. `database.ts` keeps the tunnel per project and connection in
`databaseSsh` (a destination, or one with an `identityFile`) and connects to
the tunnel's port instead of the connection's.

Besides `.env`'s connection, `database.ts` offers saved ones and
`config/database.php`'s. Saved connections are a JSON list of names and URLs in
`databaseConnections`, with the selected name in `databaseConnection`.
Passwords aren't in the URL: `db_password` and
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

`src/datasources.ts` is the Data Sources dialog. It edits copies of the
connections (drafts) and returns only what changed, which `applySources` in
`database.ts` writes: URLs to `databaseConnections`, passwords to the
Keychain, and tunnels and read-only choices to their keys. A rename moves the
password, tunnel, and read-only choice to the new name, and the selection
follows it. The URL field and the form are two views of one `Connection`:
typing in a field rewrites the URL with `connectionUrl`, and a pasted URL fills
the fields with `connectionFromUrl`. Passwords are read from the Keychain only
when a connection needs one, such as for Test Connection, so opening the
switcher or the dialog asks the Keychain nothing. `.env`'s connection is
read-only in the form; **Override on This Mac** stores a URL in
`databaseEnvOverride` (password in the Keychain under the empty name), and
`envConnection` uses it instead of `.env`'s values. Test Connection opens the
tunnel and runs `versionQuery`.

Each query opens a new connection and runs on a blocking thread, so a slow
server doesn't stall the app. The connection the frontend sends carries the
Database settings (`page_size`, `connect_timeout`, `read_timeout`) and
`read_only`, so no command needs more arguments. Results come in pages of
`page_size` rows (1,000 by default; 0 for every row, which Export uses). A
binary value comes back as `\x` and hex, up to 64 KB, and its column is listed
in `binary`, which the grid keeps read-only, since writing the text back would
store text. A table's page is `LIMIT page+1 OFFSET n` in its SQL (the extra row
tells whether there's a next page), and its count is a `COUNT(*)` with the same
`WHERE` that fills in after the rows show.

Read-only is enforced by the database, not only the frontend: SQLite opens
the file with `SQLITE_OPEN_READ_ONLY`, MySQL runs `SET SESSION TRANSACTION READ
ONLY` as it connects, PostgreSQL starts with
`default_transaction_read_only=on`, and `db_batch` refuses. `readsOnly` in
`dbconfig.ts` refuses a statement that isn't a `SELECT`, `WITH`, `SHOW`,
`EXPLAIN`, or reading `PRAGMA` before it's sent, for a clearer message.

`db_query` takes an `id`. It registers the query in `RUNNING` before it
connects, and once connected stores how to stop it: SQLite's
`InterruptHandle`, MySQL's connection ID, or PostgreSQL's `CancelToken`.
`db_cancel(id)` takes the entry and interrupts SQLite, runs `KILL QUERY <id>`
on a second MySQL connection, or sends PostgreSQL's cancel request (what
`pg_cancel_backend` does). A query still connecting finds its entry gone and
stops once it connects. `db_query` returns "Canceled." whenever its entry was
taken, since MySQL's `SLEEP` returns early rather than failing. The query
timeout setting is the frontend calling `db_cancel` on a timer, which leaves the
connection usable where a socket read timeout would break it mid-result.
Redis keeps its socket read timeout (`read_timeout`, the Redis command timeout
setting) and has no cancel.
For any other statement, `db_query` takes an `offset`, skips that many rows,
and returns `total`, every row the statement returned: MySQL's driver drains
the rest of a result anyway, and PostgreSQL's simple query protocol buffers it,
so counting costs nothing more. **Next** and **Previous** are disabled while
the grid has pending changes.

### Redis

`db.rs` speaks RESP2 itself (see the decision log). `Redis::open` connects
with a 10-second timeout, signs in with `AUTH` (with the user name when there
is one, for ACLs), and runs `SELECT` for a database other than 0. TLS uses the
same `tls_connector` as PostgreSQL, so `ssl_mode` means the same thing, and a
`rediss://` URL defaults to `verify-full`, as phpredis checks certificates by
default. A read times out after 60 seconds, so a blocking command such as
`BLPOP 0` can't hold its thread.

Connections are pooled (`REDIS_POOL`), up to four idle ones per server, user,
and database, since the key browser makes a call per click and a new
connection costs a TLS handshake and `AUTH`. A connection is taken out of the
pool while it's used, so concurrent calls never share one. `with_redis` runs a
call on a pooled connection, and when that fails with an I/O error, as after
the server's idle timeout or the Mac's sleep, runs it again on a new one.

Two commands reach Redis:

- `redis_call` sends several commands in one write and reads their replies,
  as JSON: a string, a number, null, an array, `{"error": …}`, or
  `{"binary": length, "hex": …}` for a value that isn't UTF-8, which the
  frontend shows as hex and never writes back. With `atomic`, the commands go
  between `MULTI` and `EXEC`, so a command Redis refuses discards them all.
  The key browser uses it for everything.
- `db_query`, for one console command, splits the line with `split_command`
  (as `redis-cli` does) and shapes the reply into the SQL grid: pairs for
  `HGETALL`, `CONFIG GET`, and `WITHSCORES` or `WITHVALUES`, a row per inner
  array for replies such as `XRANGE`'s, and a `value` column otherwise. `SCAN`
  follows its cursor to the end and sorts the keys.

`src/redis.ts` is the key browser. It scans in batches: `SCAN` with
`COUNT 1000` until 500 new keys or a second has passed, then one pipelined
`TYPE` per key, so a batch is a few round trips. `DBSIZE` rides along with
the first. A newer scan, such as after a filter change, bumps a generation
number, and an older one drops its results. `keyTree` and `visibleRows` in
`src/redisdata.ts` build the folder tree, which renders as a flat list with
indentation, so the arrow keys move through it in order. Rows are treeitems with
`data-key` (`k:` and a key, or `f:` and a folder), `aria-level`, and
`aria-expanded`, so the Database tool's `listNav` gives the tree its keys; only
⌘⌫ has a handler of its own. A key whose name isn't UTF-8 comes back as bytes,
can't be sent back in a command, and is counted in `scan.skipped`, which the
tree's footer shows. Deleting a folder counts its keys with `SCAN`, asks, then
sends `UNLINK`s in batches of 5,000 keys under `withProgress`, updating its
label after each and checking the signal between them, so Cancel keeps what's
deleted and forgets only those keys. `friendlyError` explains a `MOVED` reply:
the server is a Cluster node and the key lives on the node the reply names.

A key shows in the panel with `TYPE`, `PTTL`, and `MEMORY USAGE` in one call,
then its value. A string or RedisJSON document opens in Monaco, and ⌘S saves
with `SET … KEEPTTL` (Redis 6) or `JSON.SET`. A hash, list, set, sorted set, or
stream shows in the grid from `src/dbgrid.ts`, the same editing as SQL tables.
Pages are 1,000 rows: `LRANGE` and `ZRANGE` by index, `HSCAN` and `SSCAN` by
cursor (reading until a page's worth, since `COUNT` is a hint), and `XRANGE`
from the last entry's ID, exclusive with `(`, which needs Redis 6.2. Each page
remembers its offset and where it started, so **Previous** goes back without
reading again from the start. `editCommands` turns the grid's changes into
commands for `redis_call`'s transaction. A list has no delete by index, so a
deleted element is set to a unique marker and `LREM` removes the markers.

Console completion reads `COMMAND DOCS` (Redis 7) once per connection and
builds each command's syntax from its arguments (`commandDocs`); older servers
get `COMMAND`'s names. Keys come from the tree and from one `SCAN` for the
typed prefix. Signature help shows the command's syntax after a space.

`redisFromEnv` in `dbconfig.ts` builds Laravel's `default` and `cache` Redis
connections from `.env`, as `config/database.php` does, and `database.ts`
lists them as **redis** and **redis cache**, reached through
`namedConnection` like `config/database.php`'s. They come from `.env` rather
than from the booted config because the config's `redis` section isn't in
`database.connections`, and because Sail's `REDIS_HOST=redis` needs
`FORWARD_REDIS_PORT` on this Mac.

`src/dbconfig.ts` reads `.env` and fills in Laravel's defaults from
`config/database.php`. It also holds the schema queries: `sqlite_master` and
`pragma_table_info` for SQLite, and `information_schema` for the others. It's
free of editor imports, so Node tests it.

The query console is `console.sql` in the app's data folder, in a folder named
after the project path, so it never shows up in the project's git status. It
opens as a normal tab, so saving and session restore work unchanged. **Execute
Query** is a Monaco action bound to ⌘⏎ when the editor's language is SQL, and
**Execute All Statements** runs the file. `splitStatements` in `dbconfig.ts`
splits a script at semicolons outside strings, quoted names, comments, and
dollar quotes, with MySQL's backslash escapes; `statementAt` picks the one
around the caret. `execute` runs statements one after another, each in its own
tab, and stops at the first that fails or is canceled. `runQuery` shows a
spinner with the elapsed time and **Cancel**, and records each statement in
`databaseHistory` (the last 100, newest first), which **Query History** lists.
SQL completion loads every table's columns in one query (`schemaQuery`) and
keeps them until the connection reloads or a statement returns no rows, which
may have changed the schema. An alias is found with a pattern (`posts p`,
`posts as p`) anywhere in the file.

`src/dbgrid.ts` is the grid. `dataGrid` takes the columns and rows and returns
an element; it draws only the rows in view, plus 30 above and below, as
absolutely positioned CSS grid rows of 22 pixels, so a page of 100,000 rows
scrolls as fast as one of 100. Column widths are in `ch` from the values'
lengths, since the font is monospaced, until you drag one to pixels. The grid
keeps its own selection, a rectangle from an anchor to the active cell, with
`aria-activedescendant` on the focused scroller. Sorting calls `onSort` for a
table, which runs it again with `ORDER BY`, and otherwise sorts the rows in the
grid (`sortOrder` in `dbgriddata.ts`: NULL first, numbers by value, text
naturally). `formatRows` writes CSV, TSV, JSON, SQL `INSERT`, and Markdown for
copying and export. The value viewer is a textarea beside the grid, behind a
`splitter`; it shows JSON indented and binary values as `hexDump`.
`confirmDiscard` asks before anything replaces a grid with pending changes:
running a query, opening a table or a key, sorting, filtering, or paging.

Grid edits are pending until **Submit**, as in PhpStorm. The grid keeps
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
drops them in the grid. **Set Default** writes `DEFAULT`; SQLite's `UPDATE` has
no `DEFAULT`, so for SQLite the grid writes the column's default expression
from `pragma_table_info`.
`statementAt` finds the statement around the caret by splitting on semicolons,
and skips statements that are only comments. Results use `showPanelView`, like
the debugger.

## Bookmarks, snippets, and other small tools

- **Bookmarks** (`src/bookmarks.ts`) work like breakpoints: one ordered list
  of `{ path, line, mnemonic?, description? }`, saved as the local project
  value `bookmarks` with paths relative to the project, and drawn as
  decorations on open models so they follow edits. `syncLines` reads the lines
  back from the decorations (kept in the same order as the file's bookmarks)
  before any change to the list, and edits that move lines save them. They
  sit in the glyph margin's left lane, so a line can show a bookmark and a
  breakpoint together. A mnemonic shows through one generated CSS class per
  character (`bookmark-m-<char>`), since Monaco's glyph margin takes only class
  names. `loadBookmarks` moves the old `bookmarks:<project>` localStorage
  value into project state once. `src/bookmarksdata.ts` (with tests) reads the
  saved list, keeping each file's bookmarks together, and reorders it for
  drag and drop. The **Bookmarks** tab is a panel view with a `listNav` tree;
  closed files' lines are read once each time it opens.
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
  indexing ends), then through the workspace symbols for `vendor`
  classes.
- **Tinker** is a terminal tab running `artisan tinker`, in Sail when it's up.
- **Compare with Clipboard** reads the clipboard with `pbpaste` through
  `run_capture`, because WebKit asks for permission on
  `navigator.clipboard.readText`. Both comparisons use the git diff view.

## Interface

### Layout

`index.html` lays out a title bar, a workbench (the tool bar, the sidebar, and
the editor area), and a status bar. Inside the workbench, `#workarea` is a
column that holds `#workrow` (the sidebar and `main`, the editor area) and,
when the bottom panel spans the full width, the panel under both.
`src/layout.ts` moves `#panel` between `main` and `#workarea`, and sets
`panel-full-width` and `panel-maximized` on `#workbench`; CSS does the rest.
Maximized, the panel fills its column: `main`, or with a full-width panel all
of `#workarea`, since CSS hides `#workrow`. A `MutationObserver` on the panel's
`hidden` attribute restores the size and moves focus back to the editor
whenever the panel hides, so every way of hiding it (⇧⎋, the terminal toggle,
closing the last tab) behaves the same. The full-width choice is in
localStorage (`panelFullWidth`), since it's per user.

`src/splitter.ts` makes every resizable split: the sidebar, the panel, and
the splits inside the Debug, Tests, Git Log, and Profiler tabs.
`splitter(handle, options)` sizes one pane (the target) in pixels, on the x or
y axis, from a handle at the target's start or end edge. The handle gets
`role="separator"`, focus, and the ARIA values; the arrow keys move it by
10 px (Shift: 50 px), Home and End go to the limits, and a double-click or
Enter removes the inline size, so the CSS default applies again. It clamps
between `min` and the container's size minus `minRest`, and doesn't clamp by
a container that isn't showing yet. With `save`, the size is kept in
localStorage under `split:<window label>:<name>`, so each window keeps its
own. Handles between panes (`.pane-splitter`) draw the border between them;
the sidebar's and panel's handles are absolute strips over the edge. Panes with
a saved width also have a CSS `max-width`, so a narrower window never pushes
the pane beside them out of view. The window has no native title bar
(`titleBarStyle: "Overlay"` in `tauri.conf.json`): macOS draws its window
buttons over the left edge of `#titlebar`, which starts its content 80 px in.
Empty parts of the title bar carry `data-tauri-drag-region`, so dragging them
moves the window; that needs the `core:window:allow-start-dragging` permission.

As in a native app, the interface's text can't be selected: `body` has
`user-select: none`, which WebKit reads only as `-webkit-user-select`, so every
rule sets both. Text worth copying opts back in: fields, comment and message
bodies, test failures, database cells, and hovers; Monaco and xterm.js handle
their own selection. Drag handles call `preventDefault` on `pointerdown`, so a
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
color class; `src/icons.test.ts` covers it. Excluded entries are dimmed, as
PhpStorm marks excluded folders.

### Hidden and excluded files

The project values `treeHidden` and `treeExcluded` (`src/treehidden.ts`, with
defaults and the matcher in `src/treefilter.ts`, tested) decide how the tree
shows each entry: `treeState(rel)` returns `omit`, `hidden` (when **Show hidden
files and folders** is on), `excluded`, or nothing, and `renderDir` filters and
classes the rows with it. A pattern without `/` matches a name at any depth; one
with `/` goes through `covers` from `indexexclude.ts`, relative to the project.
`folderIcon` takes the excluded flag from the row instead of a fixed set. A
change to either list or the setting redraws the tree from the root, which
keeps open folders open. The fixed `EXCLUDED_FOLDERS` in `icons.ts` remains
only as `folderIcon`'s default.

### Limits

`src/limits.ts` registers the **Limits** and **Local History** settings groups,
and each module reads them when it needs the value: recent projects
(`rememberProject`), Find in Files and TODO (`search_text` takes a `limit`;
other callers keep the backend's 20,000), the HTTP history's size and the
largest response body shown, and local history's `toPrune` arguments and file
size cap.

### Breadcrumbs

`src/breadcrumbs.ts` follows the file's path in the status bar with the
symbols that enclose the cursor, outermost first. It asks Monaco's
`IOutlineModelService`, the internal service that sticky scroll uses, for the
file's outline. The service caches one outline per model version and merges
every server's document symbols, so breadcrumbs usually cost no request of
their own. The bar redraws 100 ms after the cursor stops moving, or 600 ms
after an edit: a new outline is a `textDocument/documentSymbol` request to
every server, so the longer wait keeps typing from triggering one on every
pause.

### Status and errors

The status bar shows the latest message from each source. Language server
progress uses a `<server>:progress` source, which shows a spinner and appears
only after the task has run for 800 ms, so short tasks such as resolving code
actions don't flash. Other messages clear themselves after 8 seconds. Messages
that report a failure (they contain words such as "failed", "error", or
"fatal") also appear as a toast.

Diagnostics for files inside `vendor` and `node_modules` are dropped
(`setMarkers` in `lsp.ts`). Those files open for go to definition and peeks, and
Mago analyzes library code as strictly as your own, which filled the
counts with problems you can't fix. The counts cover open tabs and update when
markers or tabs change.

### Palette

`matchPositions` in `palette.ts` finds the letters to highlight: the query as
one block where it appears whole (its last occurrence, which is usually in the
file name), or else the letters of a fuzzy match. The folder part of a path is
dimmed.

## Filament designer

The designer (`src/filamentdesigner.ts`) edits a resource through its code.
There's no model of the resource besides the code: each change is a set of
edits to the files, applied with `applyWorkspaceEdit` (saved, with local
history), after which the designer reads the files again and redraws.

### Reading code

`tusk/phpOutline` in Tusk's server (`tusk-lsp/src/features/outline.rs`) parses a
file's text with Mago and returns its classes: properties, constants, methods,
and each method's `return` expressions as trees of nodes. Nodes are static calls,
chains of calls, arrays, literals, class constants, closures, and the like, with
names resolved to fully qualified classes and ranges in UTF-16 offsets, as
JavaScript counts them. It takes the text rather than a file, so the designer
reads the editor's unsaved text, and the request needs no index.

- `src/phpcode.ts` holds the outline's types and the edits: insert, remove,
  move, and replace array items; set and remove calls in a chain; set static
  properties; add and remove members; and `Imports`, which names a class the way
  the file can (its alias, a name under an imported namespace, or the short name
  with a new `use` line sorted into the others). Edits follow the file's layout:
  a chain written one call per line gets its new call on a line of its own, an
  array keeps its trailing comma or lack of one, and indentation comes from the
  lines around the edit.
- `src/filamentschema.ts` reads a form, table, or infolist method: a chain of
  calls on the method's parameter, or a call that hands the work to another
  class, as Filament 4 writes `PostForm::configure($schema)`, which the designer
  follows to that class's file. A component is a `Class::make()` call with its
  chain; array arguments that hold components are its slots. A path of slot names
  and indexes names each component, so the selection survives reading the code
  again.

Anything else in a slot, such as a variable or a spread, is a code entry the
designer shows, moves, and deletes, but never rewrites.

### Keeping the code safe

The designer never writes back less than the code held:

- **Readable values only:** an editor edits a value only when it can read all of
  it. `mapValue` in `src/phpcode.ts` reads options with plain or translated
  (`__()`) labels, and other editors check the node's kind (`readable` in
  `src/filamentinspector.ts`). Anything else shows as a code chip that opens
  the code. A relationship's query closure, extra arguments, and root settings
  written as code are kept the same way.
- **Overridden settings:** a resource setting that a method decides, such as
  `$navigationLabel` under `getNavigationLabel()`, shows as code, since a
  property there would be ignored. So does a `getNavigationBadge()` the
  designer didn't write.
- **Asking first:** switching options written as code to a list, enum, or
  relationship, and changing a component's type when the new type lacks some of
  its settings, ask before replacing them.
- **One change at a time:** each change waits for the previous one
  (`settled`), and `applyNow` drops an edit whose text changed since it was
  computed, such as by typing in the code editor. Edits computed from old
  text would otherwise land in the wrong place.
- **Syntax errors:** a file that doesn't parse can be read wrong, so the
  designer shows it with a warning and doesn't change it until the errors are
  fixed.
- **Imports:** `droppedImports` removes, in the same edit, the imports a change
  leaves unused, such as `RichEditor` after changing its field to a textarea.
  Imports that were unused before stay.

`introspect.php` sends PHP's notices to stderr, since an older package on a newer
PHP can print deprecations while it loads, before the JSON; the editor also
skips anything printed before the JSON. A project that requires Filament but
hasn't installed its packages, such as a fresh clone, is offered
`composer install` rather than a Filament install.

The designers were checked against open-source Filament apps (the official demo,
relaticle, academico, dewakoding-project-management, and simple-cms): they read
2,626 components, and everything they leave as code is a call to the app's own
helpers. After designer edits and a resource from the wizard, the demo's own
test suite gave the same results as before.

When the app can't boot, often because of a mistake in a file Filament loads,
`introspect.php filament-app` reports the exception's message, file, and line,
and lists the resource files it finds by reading the source. The tool window
shows the error with a link to the line, and the files can still be opened.

### The project's components

`introspect.php filament-catalog` reflects every concrete class with a static
`make()` in Filament's packages, in packages that require Filament (plugins),
and under `app/Filament`, and sorts them by the Filament class they extend:
fields, layout components, entries, columns, filters, actions, bulk actions, and
action groups. For each class, it lists the public methods that return `static`,
grouped by the class or trait that declares them, which the file and line
ranges tell apart, since reflection reports a trait's methods as the using
class's. It also lists the enums those methods take, with their cases, the
static properties of `Resource`, and Heroicon's cases. On a Filament 4 app it
takes about 0.7 seconds and lists about 150 classes and 1,350 methods.

`src/filamentcatalog.ts` resolves a class's methods in PHP's order and picks
each one's editor from its parameters: a switch for `bool $condition = true`, a
number, text, a list of an enum's cases, an icon, a color, a list, a map, or
code for closures. What it adds by hand is taste: palette groups and icons, the
settings each kind of component shows first, and methods to hide.

`introspect.php filament-app` lists the panels with their resources (model,
labels, navigation, pages, relation managers) from the booted app, and
`model <class>` describes a model's table, columns, indexes, foreign keys, and
declarations. `src/filamentapp.ts` loads and caches them per project until the
app's files change, and runs Artisan's generators, in Sail when it's up.

### Suggested components

`src/filamentgen.ts` chooses the component for a database column from its type,
cast, name, and relationships: a searchable relationship select for a belongs-to
foreign key, a select of an enum's cases for an enum cast, a date and time
picker, a toggle, and so on. The same column gives a table column, a filter,
and an infolist entry. It also writes the closures behind "visible when"
conditions and reads back the ones it wrote.

### The canvas and the inspector

`src/filamentcanvas.ts` draws components as Filament does, in its shapes and
the theme's colors: fields with their labels, required marks, affixes, and
helper text; sections, grids, fieldsets, tabs, wizards, and repeaters with
their column spans; and tables with sample rows made from the column names.
Drag and drop uses the HTML drag events, with the drag's payload in a module
variable because `dataTransfer` can't be read during `dragover`. A slot takes
only what fits: tabs take tabs, table lanes take their kinds, and nothing drops
into itself.

`src/filamentinspector.ts` shows the selected component's settings, and
`src/filamentpages.ts` the Relations, Pages, and Settings tabs and the root's
settings. `src/filamentview.ts` is the tool window, the palette commands, and
the **Open in Designer** code lens.

### The New Resource wizard

`src/filamentwizard.ts` runs `make:filament-resource` with the choices as
options (`--panel`, `--cluster`, `--simple`, `--view`, `--soft-deletes`,
`--record-title-attribute`, and `--embed-schemas` with `--embed-table` when you
don't want separate classes), without `--generate`, since that needs the table
in the database. It finds the resource's file from the command's output, then
replaces the generator's empty arrays with the chosen components: each root is
found as the designer finds it, following `PostForm::configure()` to its class.
Settings go in with `setProperty`. The components come from `src/filamentgen.ts`
with the wizard's changes: another field type keeps only the settings that type
has, as `methodsOf` reports them.

### Page actions and action forms

- **Page actions:** `readRoot(cls, "actions")` reads a page's
  `getHeaderActions()`, or the older `getActions()`, whose return value is an
  array: the root's one slot, `actions`. The designer's **Page actions** tab
  reads the page it shows (`actionsPage`) with the resource's other files, so
  edits, undo, and the palette work as on the other tabs.
- **Action forms:** an action's `schema([...])` is a slot like a section's.
  `modalAction` finds the action that holds the selection, and the canvas draws
  its modal under the page. While it's open, the palette and the + menus offer
  fields, and model columns become form fields (`inActionForm`), whatever the tab.
- **What it does:** `src/filamentactions.ts` writes the closure of
  `->action(...)` for a behavior and scope (a record, the selected records, or
  none), and reads it back with `readBehavior`. Anything else is custom and
  shows as code. The record parameter is typed as the resource's model.

### Access

- **Reading:** `introspect.php policy <model>` asks the Gate for the model's
  policy and its file, and, with spatie/laravel-permission, lists the roles
  with their permissions, whether the user model has `HasRoles`, and whether
  Filament Shield is installed. With Shield and a resource, it asks
  `FilamentShield::getDefaultPermissionKeys()` for the resource's permission
  names, which follow Shield's config or the app's own key builder (the config
  alone can be wrong: an app can replace the builder). Abilities Shield gives no
  key get names in the same pattern, found from the keys it gave.
  `introspect.php permission` creates a role or
  permission, or grants or revokes one, through Spatie's models.
- **Rules:** `src/policygen.ts` reads each ability method whose body is one
  `return`: `true`, `false`, or conditions joined by `||` or `&&`, each
  `$user->can(…)` (or `hasPermissionTo`), `$user->hasRole(…)`, or
  `$user->id === $record->column`. The parameter names are the method's own.
  Anything else, including statements before the return, is custom. A rule is
  written back over the return's expression, or as a new method typed like the
  others. `src/filamentaccess.ts` draws the tab against `AccessHost`, which
  the resource designer implements, and so does `src/accessview.ts`, the
  model's own Access view, with the designer's way of applying edits.
- **New policies:** `make:policy <Model>Policy --model=…` puts it in
  `App\Policies`, where Laravel's discovery finds it for nested models too.
  Laravel's stub returns `false` everywhere, which would hide the resource
  from everyone, so the designer opens those rules.

### Translations

- **Reading:** `introspect.php translations` reads `lang_path()`: each
  `<locale>.json`, and each `<locale>/*.php` flattened to `file.key` keys, with
  the app's locale and fallback. The designer reads them without waiting, since
  they only change the preview.
- **Preview:** `setTranslator` gives the canvas a function from key to text,
  which `text()`, `labelOf`, and headings use for translated values. The canvas
  gets `dir="rtl"` for right-to-left languages.
- **Writing:** `src/translations.ts` edits the files as text. A key goes to the
  locale's JSON file, keeping its order, indentation, and `json_encode` escapes;
  a key a PHP file already has is changed there when the file has exactly one
  entry for it. `src/translationfiles.ts` writes through the editor's models,
  so open files and local history stay in step; the resource and enum
  designers both use it. The enum designer stages translations and writes
  them on Apply, after renaming the keys of labels that changed.

### Panel settings

- **Reading:** `src/panelgen.ts` reads the calls on `$panel` in the provider's
  `panel()`: the returned chain, and chains in the body's own statements,
  such as `$panel = $panel->…;` or `$panel->path(…);`. The outline gives a
  method's top-level expression statements in `statements` for this. A setting
  is read from the last call that sets it; new calls go on the longest chain.
  A value the settings don't write, such as `brandLogo(fn () => …)`, shows as
  code.
- **Writing:** flags go back to Filament's default by removing the call, so a
  provider only says what differs. Turning on a call that's there keeps its
  arguments, such as a custom login page. Colors are `Color::` palettes or hex
  strings; navigation groups are labels, or `NavigationGroup::make()` once
  they get an icon or start collapsed; plugins are `Plugin::make()` in
  `plugins([...])`.
- **Options:** `introspect.php panel-options` reads Filament's palettes (their
  500 shade, for swatches and the preview), the Filament plugins Composer
  installed (a `*Plugin` class in a package that requires Filament that
  implements its Plugin contract), the app's name, and the user model with the
  contracts tenancy needs. `src/panelsettings.ts` draws the view.

### Import and export

- **Reading:** `introspect.php porters` lists the app's importers and
  exporters with their models, whether the `imports`, `exports`,
  `failed_import_rows`, `job_batches`, and `notifications` tables exist, and
  the queue connection.
- **Actions:** `essentials()` gives ImportAction, ExportAction, and
  ExportBulkAction an Importer or Exporter row in place of "What it does",
  and the designer shows no modal lane for them, since Filament draws theirs.
  New importers and exporters come from `make:filament-importer --generate`,
  whose `[Class]` in the output names the new class.
- **Designing:** `src/portergen.ts` reads `getColumns()` as a list of
  `ImportColumn` or `ExportColumn` chains and changes one call at a time, so
  calls it doesn't write, such as a relationship's `resolveUsing`, stay.
  `resolveRecord()` is one of three forms: `new Model()`, `firstOrNew()` by a
  column, or `query()->where()->first()`. `src/porterdesigner.ts` draws the
  view.

### Custom pages

- **Reading:** `introspect.php filament-app` lists each panel's pages that
  aren't dashboards, with their navigation, and its page and widget folders.
  The designer opens a page in a mode of its own: a class extending `Page`
  without a `$resource`. Its form and table are the instance methods
  `form()` and `table()`, read like a relation manager's; its header actions
  are its own; its model is the one its table queries or its `getRecord()`
  returns.
- **New pages:** `src/pagegen.ts` writes a form page that fills from
  `getRecord()` (the user, or `firstOrNew()`, filled from the fields' defaults
  when the record isn't saved yet) and saves on submit, or a table page with
  `HasTable`. Both draw `content()`, with `EmbeddedSchema` or `EmbeddedTable`,
  as Filament 4's own pages do. `formField` gives a field its column's default
  and makes it required when the column can't be null, since a new record's
  empty field would otherwise insert null.
- **Access:** `readEntry` and `entryEdits` in `src/policygen.ts` read and
  write `canAccess()` or `canView()` as one rule on the signed-in user, or
  Shield's trait. `introspect.php entry-access` asks Shield for the class's
  permission. `renderEntryAccess` in `src/filamentaccess.ts` reuses the
  Access tab's conditions and roles grid.

### Dashboards and widgets

- **Reading:** `introspect.php widgets <panel>` asks the panel for its widgets,
  sorted as Filament sorts them, with each one's kind, sort, column span, and
  heading, read from an instance. It lists each dashboard page with its
  columns, and its own widget list when the page overrides `getWidgets()`,
  since Filament only sorts the panel's list. Widgets that turned discovery off
  are listed too, so they can be shown again.
- **Arranging:** `src/dashboarddesigner.ts` reorders the panel's dashboard by
  writing `$sort` to each project widget in the new order (packages' widgets
  keep theirs), and a dashboard's own list by moving its items. Hiding removes
  a widget from the provider's `widgets([...])` when it's there, and otherwise
  sets `$isDiscovered = false`. `src/codeapply.ts` applies edits to several
  files at once, each computed from its current code.
- **Widgets:** `src/widgetgen.ts` writes and reads values as
  `Model::query()` with `where` conditions and a count or aggregate, reading
  them back from the code with its layout squashed, so a value the designer
  wrote reads the same after a formatter changes its lines. Charts are one
  return of `getData()`; the designer changes a dataset's `label` and `data`
  and the `labels` in place, so other keys, such as colors, stay.
  `src/widgetdesigner.ts` draws the view. New widgets are written by the
  designer, not `make:filament-widget`, which asks for a table widget's model
  and a chart's type interactively.
- **Live data:** `introspect.php widget-data <class>` runs the widget's
  `getStats()` or `getData()` as the first user, and the preview shows what it
  returns, or why it failed.
- **Resource pages:** `src/pagewidgets.ts` adds a widget to both the
  resource's `getWidgets()`, which registers it, and the page's
  `getHeaderWidgets()`. A page that returns its resource's `getWidgets()`
  changes the resource's list.

## Model designer

`src/modeldesigner.ts` stages changes to a model and writes them on Apply,
unlike the Filament designer, which saves each change: a migration is a unit
that runs once, so it should hold the whole change.

- **Reading:** `introspect.php model <class>` reports the table's columns (type,
  full type, nullable, default), indexes, and foreign keys from the database's
  schema builder, and the model's fillable, hidden, casts, relationships, and
  traits. `columnFromDatabase` in `src/modelgen.ts` turns each column into the
  designer's `ColumnSpec`, using the cast where the database is vague, as
  SQLite is about booleans. Each column keeps its `original`.
- **A new model:** `make:model` makes the class, and the factory, seeder, and
  policy when asked, so their paths and namespaces follow the project. Tusk then
  writes the model, the factory, the create migration, and a pivot migration for
  each many-to-many relationship, a second apart so they run in order.
- **An existing model:** `diffColumns` compares each column with its
  `original` and yields adds, drops, renames, and changes; `alterMigration`
  writes them with a `down()` in reverse order. The class is edited through the
  outline, as the Filament designer edits resources: `$fillable` or Laravel
  13's `#[Fillable]`, new entries in `casts()` or `$casts`, the `SoftDeletes`
  trait, and new relationship methods, with their imports.
- **Names:** `tableFor`, `plural`, and `singular` follow Laravel's pluralizer for
  the common cases, so the designer's table name matches the one Eloquent uses.

## Enum designer

`src/enumdesigner.ts` stages changes to an enum, as the model designer does, and
`src/enumgen.ts` turns them into code.

- **Reading:** `readEnum` takes the cases from the outline, and each Filament
  contract's method (`getLabel()`, `getColor()`, and so on) when it returns a
  `match ($this)` whose arms are `self::Case` to a string, a translated string,
  or a Heroicon case. `readMatch` reads shared arms (`self::A, self::B =>`) and
  `default`. A method written otherwise is not readable, and the designer shows
  its column as code.
- **Writing:** `enumEdits` rewrites the case block and the readable matches,
  adds and removes methods and their contracts in `implements`, and renames a
  renamed case's other `self::` references. Cases with the same value share an
  arm. A `default => null` arm makes the method's return type nullable.
- **New enums** are written whole by `enumFile`, into the namespace's PSR-4
  folder. `make:enum` would make an empty class that Tusk would then replace.

## New Laravel projects and elements

`src/laravelnew.ts` uses `laravel/installer` rather than
`composer create-project`, because starter kits, WorkOS, teams, Pest, and Boost
are the installer's options, and it keeps up with Laravel's changes to them.
The editor must not depend on global tools, so the installer lives in
`<app data>/tools/laravel-installer`, made with the bundled Composer's
`create-project` and updated before each use. The installer runs `composer`
from `PATH`, so a `composer` shim that runs the bundled phar goes first on the
terminal's `PATH`. `src/laravelnewdata.ts` turns the dialog's choices into the
installer's flags (always `--no-interaction`, so it asks nothing) and the
script the terminal runs: the installer, then `composer require
filament/filament`, `filament:install --panels`, and, on SQLite,
`make:filament-user` with the dialog's name, email, and password. Other
databases need their server and credentials first, so the first user is left
to you.

`src/laravelelements.ts` reads `artisan list --format=json`, which describes
each command's arguments and options (required, array, takes a value, repeats),
and builds a form for any `make:` command from it. `commandLine` in
`src/laravelnewdata.ts` writes the arguments. Some generators report failures,
such as a class that exists, with an `ERROR` line and a success status, so a
run that made no files and printed one counts as failed.

## Tusk's language server

`tusk-lsp/` is the PHP language server the editor runs, written in Rust. It
replaced Phpactor, Laravel LSP, and the Filament server in September 2026 (see
the decision log). It serves PHP and Blade: navigation, completion, hovers,
diagnostics, refactorings, and the Laravel and Filament features.

It's built on Mago's crates, pinned to `=1.50.0` because their API changes
between minor versions:

- `mago-syntax` parses.
- `mago-names` resolves names.
- `mago-codex` holds the codebase's classes, functions, and types.
- `mago-analyzer` infers expression types and reports problems.
- `mago-prelude` provides PHP's built-in functions and classes.
- `mago-linter` runs the linter's rules.

### Startup

The server is the app itself: `src-tauri/Cargo.toml` depends on `tusk-lsp` by
path, and `main.rs` calls `tusk_lsp::run_stdio()` when the first argument is
`lsp`, before Tauri starts. `lsp_start` in `lsp.rs` runs `current_exe() lsp`
through the watchdog as the server `tusk`, so there's no separate binary to
bundle or download. Release builds unwind on panic, rather than abort, so the
server's guards can turn a panic in a request into an error answer.

`startLsp` in `lsp.ts` sends these `initializationOptions`:

| Option | Value |
| --- | --- |
| `exclude` | The project's index exclusions (`indexexclude.ts`), relative to the root |
| `stubs` | The folder with Laravel's alias stubs |
| `magoConfig` | The editor's `mago.toml` for the project, when the project has none of its own |

The server also accepts `phpVersion` (otherwise from `mago.toml` or
`composer.json`) and `loadAllLibraries` (load every library file, not only
what the project reaches; see Index below), which the editor doesn't send.

The server needs no index on disk: it indexes the project each time it starts,
with `$/progress` titled "Indexing". `tusk/reindex` indexes it again with its
configuration read again, which the editor asks for when the alias stubs or its
`mago.toml` change. The server also does it by itself when `composer.lock` or
the project's `mago.toml` changes.

### Diagnostics

For each open PHP document, the server publishes syntax errors from the text as
written, Mago's analyzer (source `mago`) and linter (source `mago-lint`) in its
own process, unused imports (source `tusk`), and, for PHP and Blade, the
framework's problems (sources `Laravel Extension` and `filament`).
`mago_config.rs` reads the `mago.toml` options it uses: `php-version`, the
analyzer's switches, `excludes`, and `ignore` (codes, optionally by path), the
linter's `integrations`, `rules`, and `excludes`, and the source's `includes`
and `excludes`, which feed the index. The linter's rule registry is built once
per configuration. Its rules match excluded paths against the file's name, so
the linter gets the file named by its path relative to the root. Mago's
`@mago-expect` and `@mago-ignore` comments work as on the command line.

### Requests of its own

| Method | Params | Result |
| --- | --- | --- |
| `tusk/reindex` | none | Indexes the project again, with the configuration read again |
| `tusk/memberReferences` | `class`, `method` | Every call of the method in the project, through subclasses too, without its declarations |
| `tusk/projectProblems` | none | Every project PHP file's problems, by path relative to the root |
| `tusk/phpOutline` | `text`, optional `path` | The classes in the text, with their properties, constants, methods, and return expressions as a tree of nodes with UTF-16 ranges. It parses the text without the index. The Filament designer and the model designer read and edit code through it |

The command (`workspace/executeCommand`) `tusk.extractMethod` applies its edit
by sending `workspace/applyEdit` and waiting for the editor's answer before it
returns.

### Index

`index.rs` scans the project's PHP files in parallel into one
`CodebaseMetadata`, with the library code they reach, then populates it
(resolves inheritance and types).

- **Library code, as far as the project reaches:** every library file
  (`vendor` and stubs) is parsed once for the names it declares, which the
  index keeps with their locations (`Declared`). Library files are loaded in
  full only for the names the project's files use, in code or in docblocks,
  and then for whatever loaded code depends on: parents, interfaces, traits,
  mixins, and every class in a signature, property, constant, or template
  (`dependencies`), until nothing new is reached (`ensure_loaded`). An edit
  that starts using a name loads it the same way, and a library file open in
  the editor is loaded in full. Completion, Import Class, and Go to Symbol list
  names from `Index::names`, loaded or not.
- **What it saves:** on a Laravel and Filament app with 23,000 files, the
  project reaches 1,900 of `vendor`'s 16,000 classes; memory drops from
  1.3 GB to 370 MB and indexing from 1.4 s to 0.8 s. The analyzer's problems
  in all 425 project files are the same either way (`examples/lazy_check.rs`
  compares them). `loadAllLibraries` in `initializationOptions` loads
  everything, should a project need it.
- **Building in chunks:** files are scanned 1,024 at a time, and each scan is
  cloned into the index and dropped before the next chunk: the allocator keeps
  what the process peaks at, and holding every scan until the end doubled the
  peak. Clones are allocated at their size, so the index holds no spare
  capacity from scanning.

- **Excluded paths:** `vendor`'s tests, `vendor/composer`, `node_modules`, `storage`, `bootstrap/cache`, and
  hidden folders), plus the `exclude` globs in `initializationOptions`.
- **Inheritance cycles:** a class that extends itself, or classes (or
  interfaces) that extend each other, are cut at the link that closes the
  cycle before Mago populates (`break_inheritance_cycles`). PHP refuses such
  code, but typing leaves it for a moment: `<?php$x->` swallows a file's
  `namespace`, so Symfony's `UnexpectedValueException` extended PHP's own, and
  Mago's populator, which follows parent chains without a limit, never
  finished. After a change, only the changed classes' chains are walked.
- **Changes:** each file keeps the names it declared. A change removes the
  ones the index still has from that file (two files can declare the same
  class, and only one wins the merge), scans the new text, and repopulates
  only the file's symbols and the classes that inherit from them. Everything
  else is passed to the populator as safe.
- **Measurements** on a Laravel and Filament project with 23,000 PHP files,
  on an M-series Mac: indexing takes 0.8 s, a model's update 10 ms, and
  memory 370 MB.

### Threads

- **Main loop:** applies document changes at once and never waits on
  analysis.
- **Indexer thread:** applies index updates, merging a burst of edits into
  one.
- **Request pool:** each request runs on the pool once the index has every
  edit made before it (`Indexer::ticket`), so it sees its own file's latest
  symbols. A panic in a request answers with an error instead of stopping the
  server. `$/cancelRequest` sets the request's flag (`Snapshot::cancel`): a
  request that hasn't started answers `RequestCancelled` at once, and
  references and project problems check it between files.
  The pool is plain threads (`RequestPool`), not a rayon pool: a rayon thread
  waiting on its own parallel work runs other queued jobs meanwhile, and a
  search holding the index's read lock once picked up a request waiting for
  the index to catch up with an edit, which the lock blocked. The server
  stopped answering (`searches_racing_edits_and_other_requests_all_finish` in
  `tests/protocol.rs` reproduces it).
- **Parallel work in requests:** references, call hierarchy, rename's file
  moves, and project problems read files in parallel on the scan pool. That
  work never takes the index's lock: the request takes it once and passes the
  index down (`php_problems_in`).
- **Diagnostics thread:** checks an edited document as soon as the index has
  its change, and the other open documents once edits pause for 600 ms,
  since they may depend on it.
- **Stacks:** threads get 64 MB stacks, because Mago's parser and analyzer
  recurse once per level of nesting. So do the threads that scan files for the
  index (`scan_pool`); rayon's global pool has 2 MB.
- **Pathological files:** a file whose syntax tree nests deeper than 1,000
  levels, such as a generated expression of thousands of terms, or with more
  than 1,000 branches in one `if`, `switch`, or `match`
  (`analysis::too_complex`), gets only syntax errors: the analyzer, linter,
  and requests skip it. Mago takes time quadratic in such a chain's length:
  minutes at 10,000 terms, and 4 s per request on a `match` of 2,000 arms.
  Real code stays under both limits: at most about 850 levels (a Symfony
  bundle's configuration chain) and 800 branches (a `switch` in WordPress). A
  file reports at most 100 syntax errors.

### Symbols

- **Document symbols** (`features/symbols.rs`):
  - The outline lists classes, interfaces, traits, enums, functions, and
    constants, including those declared inside an `if`, such as
    `if (!function_exists())`.
  - Traits have kind 23 (struct), as Phpactor gave them; Safe Delete
    (`safedelete.ts`) looks for that kind.
  - Promoted constructor parameters are listed as properties.
- **Workspace symbols:** these cover classes, interfaces, traits, enums,
  functions, and constants, and the methods of the classes the index has
  loaded (the project's, and the library classes it reaches).
  - `name` is the short name, and `containerName` the namespace, or a
    method's class. `typeSymbol` in `lsp.ts` matches name and namespace among
    the type kinds (`TYPE_KINDS`), and Go to Symbol labels a method
    `Class::method`.
  - A query matches the short name, or the fully qualified name when the query
    has a `\`. A query with `::` matches methods as `Class::method`, by the
    class's short name.
  - Results rank exact matches first, then prefixes, substrings, and
    subsequences. Within each rank, types come before methods, and project
    files before `vendor`.
  - Results are capped at 200. PHP's built-ins have no file, so they're left
    out.

### Folding and selection ranges

- **Folding** (`features/folding.rs`):
  - A bracketed region folds to the line before its closing bracket, so the
    bracket stays visible, as VS Code folds.
  - Comments fold whole.
  - Consecutive `use` lines fold as imports; a blank line splits them into
    separate groups.
- **Selection ranges:** the chain of syntax nodes around the cursor, innermost
  first, with duplicate ranges dropped.

### Inlay hints

`features/inlay.rs` shows two kinds of hints:

- **Parameter names** before positional arguments. There's no hint for an
  argument written as the parameter's name (such as `$to` for `$to`), and none
  after a named or unpacked argument. A variadic parameter gets one hint,
  `...tags:`.
- **Inferred types** after a variable's first assignment in its function.
  There's no hint for literals, arrays, or `new`, whose type is plain to see,
  or for `mixed`.

Signature help and inlay hints find the called function the same way
(`signature::called`). On a 855-line controller, the whole file's hints take
about 9 ms (`examples/inlay_bench.rs`).

### Filament

`framework/filament.rs` ports the PHP Filament server, `filament-lsp/server.php`,
now deleted, with the same
completion items, relationship definitions and diagnostics (source
`filament`), and code lenses (`phpEditor.open`). Its features run only
when `vendor/filament/filament` exists.

- **Resources and files:** the index finds which resource a file belongs
  to. That's its own class if the class is a resource, otherwise the first
  `*Resource.php` in its folder or a parent folder under `app/`.
- **Running app:** the model's columns, casts, and relationships, and the
  resource's pages and relation managers, need the running app.
  `introspect.php` is compiled into the server and still reports them. Its
  results are cached until a file under `app/`, `config/`, or `database/`
  changes, or `composer.lock` does.
- **Enums:** enum cases and their values come from the index, so an enum
  the index doesn't know offers nothing.
- **Relationship calls:** a `relationship` or `::make` call counts when the
  analyzer types its receiver as a Filament class, or can't type it at all.
- **`$get` and `$set`:** these read field names from the whole text,
  because the parse for completion ends at the cursor.
- **Triggers:** `'`, `"`, and `.` trigger completion. `(` doesn't, because
  named arguments would show at every call, so `->options(` completes when
  you ask for it.
- **Demo app test:** a test marked `#[ignore]` mirrors the old PHP tests on
  the demo app. Build the app with `scripts/make-fixture.sh`, then run
  `TUSK_FILAMENT_FIXTURE=fixtures/demo cargo test -- --ignored filament`.

### Formatting

`features/format.rs` answers `textDocument/formatting` for PHP with
`mago-formatter`, as `mago format` would: one edit of the whole document, none
when it's already formatted, and `null` for a file `[formatter]`'s `excludes`
lists. `mago_config.rs` reads `[formatter]` as Mago does: the `preset`'s
settings (Mago's default without one), with the section's other options over
them. An option the formatter doesn't know makes only the formatter an error,
which each request reports, as the command line refuses the file; the
analyzer and linter keep their settings. A file with a syntax error isn't
formatted, and the error names its line.

### Type and call hierarchy

`features/hierarchy.rs` answers the LSP's type and call hierarchy requests.
`lsp-types` has no capability field for type hierarchy, so
`capabilities::server_json` adds `typeHierarchyProvider`. Each item's `data`
names what it stands for (a type, a function, or a method by its declaring
class), so the follow-up requests answer from the index rather than from
positions an edit may have moved.

- **Starting point:** the type, method, or function named under the cursor
  (`new Foo` counts as `Foo`'s constructor), else the one the cursor is in. A
  closure counts as the function around it.
- **Supertypes:** the parent class, then the interfaces, then the traits, from
  the class's metadata. PHP's own types have no file, and get a
  `tusk://builtin/` address the editor doesn't open.
- **Subtypes:** the types that name it directly as parent or interface
  (Mago's `direct_classlike_descendants`), or, for a trait, the classes that
  use it and whose parent doesn't. Library classes the project doesn't reach
  aren't loaded, so they aren't listed.
- **Incoming calls:** the references search, without declarations, grouped by
  the method or function around each call; code outside one is listed by its
  file (kind `File`). A method is identified by its declaring class, so calls
  through subclasses count. A constructor's calls also include `new` of its
  class and of subclasses that don't declare their own (one search for all of
  them, since `Model` has hundreds), and `new self`, `new static`, and
  `new parent` in the files declaring those classes.
- **Outgoing calls:** every function call, method call, and `new` inside the
  item's range, resolved as Go to Definition resolves them. Callees without a
  file (PHP's own functions) are left out.

### Extract Method

The editor lists the action with `only: ["refactor.extract.method"]` and runs
its command, `tusk.extractMethod`. The command sends the edit as
`workspace/applyEdit` and waits for the editor to apply it before it answers,
because `extract.ts` diffs the text for the new `function` next. Other clients
can resolve the action's edit instead.

- **Selection:** whole statements of one block, or exactly one expression.
  Surrounding whitespace doesn't count.
- **Parameters:** the variables the selection reads that the function mentions
  before it, in order of first use.
- **Return value:** the variables the selection sets that the function reads
  after it. One comes back as itself, several as an array that the call
  destructures.
- **`return` statements:** a selection with one works only at the end of its
  function, where the call is returned.
- **Where it goes:** a method in a class is `private`, and `static` when its
  function is, and follows that function. In a plain function it becomes a
  function after it. It's named `newMethod`, or the next free
  `newMethod2`…, for the editor to rename in place.
- **Types:** come from the analyzer. Types PHP can't declare are narrowed:
  `list<int>` to `array`, `int<0, max>` or a literal to `int`, and so on. Class
  names are written for the file, with imports added. A type that includes
  `mixed` is left out.

### Organize imports and unused imports

- **What counts as used:** names in code, attributes, and docblock types (with
  `@method` and `@property` lines), outside `use` statements. Member names and
  declarations don't count, even when an import has the same name.
- **Matching:** a qualified name such as `Sub\Thing` uses its first part.
  Class and function names match without regard to case, and constants with
  it.
- **What's removed:** only a `use` statement that imports one name.
- **Sorting:** classes, then functions, then constants, without regard to
  case. It only applies within a run of imports that has only whitespace
  between them.
- **Groups and lists:** a group (`use A\{B, C};`) or a list (`use A, B;`)
  keeps its run in its written order, apart from removing unused imports.
- **Diagnostics:** each unused import is reported with source `tusk`, code
  `unused_import`, and the Unnecessary tag. The quickfix "Remove unused import"
  deletes its line.
### Laravel

`framework/laravel/` ports Laravel LSP (laravel/lsp v0.0.32). It covers
routes, controller actions, views, Blade components, Livewire, Blade
directives, config, env, translations, middleware, auth, container bindings,
assets, Mix, storage disks, Inertia, validation rules, Eloquent, and path
helpers. Labels, kinds, messages, and codes match the original, and problems
come from the source `Laravel Extension`. It runs only when the project has
an `artisan` file.

- **Matching calls:** a string's call is matched on the classes the analyzer
  infers for its receiver, so `redirect()->route('home')` is a call on
  `Illuminate\Routing\Redirector`. Facade calls are static calls on the
  facade, so each pattern lists the facade, its short alias, and the class
  behind it.
- **Untyped chains:** a receiver the analyzer can't type, such as a call
  Laravel forwards through `__callStatic` (`User::where(...)->orderBy(...)`),
  counts as the class at the root of its chain, as Laravel LSP reads it. A call
  also keeps its receiver type's type arguments (`User` in `Builder<User>`,
  `Post` in `HasMany<Post, User>`) and each argument's classes (`Post::class`,
  or a typed `$post`).
- **Eloquent's model:** the receiver's class, else a model in its type
  arguments, else, inside a closure passed to a relation method
  (`whereHas('author', fn ($q) => …)`), the relation's related model from the
  models script.
- **Gates:** an ability check with a second argument (other than `has`)
  matches policies by the model class of that argument; with a known class and
  no policy for it, it's reported as `Policy/Model match [x] not found.`
- **Facts about the app:** Laravel LSP's PHP scripts (`php/laravel/`,
  embedded in the binary) run after the app boots, with the project root as
  the working directory. `State` caches each result until a file it depends
  on changes. A script that fails caches a failure. Features built on it then
  report no problems, rather than flag every call as Laravel LSP did.
- **Which PHP:** `framework/php.rs` detects it once per server, in Laravel
  LSP's order: `herd which-php`, `valet which-php`, then Sail (`sail ps`),
  Lando, and DDEV when the project has their files, then `php -r 'echo
  PHP_BINARY;'`. A local PHP runs the script from the system's temporary
  folder. A container sees only the project, so its script goes in
  `storage/framework/lsp-<16 hex>.php` and is removed after the run, and the
  container's paths in the output (from `getcwd()` inside it) are mapped back
  to the project's. An app without `vendor/autoload.php` and
  `bootstrap/app.php` runs the scripts through `artisan tinker --execute`.
- **Quick fixes:** `laravel/actions.rs` offers Laravel LSP's fixes for the
  problems at the cursor, which it finds itself rather than from the editor's
  context: create a missing view or Inertia page, add a variable to `.env`
  (after the variables sharing its prefix) or the value from `.env.example`,
  and, in `.env` files, `VITE_` copies of the selected variables. They carry
  their edit and the editor's `phpEditor.open` command, which the client runs
  itself. `.env` files have a `dotenv` language so the server sees them.
- **Facts read directly:** `.env`, `public/`, the Mix manifest, Inertia
  pages, and controller actions (read from `app/Http/Controllers`).
- **Blade:** a view becomes "virtual PHP" of the same length.
  - `{{ expr }}` keeps `expr` at its offsets, and `@include('x')` becomes
    `_include('x')`, so string positions in the virtual text are positions in
    the view.
  - Everything else turns into spaces, keeping line breaks.
  - A short open tag (`<? `) goes in the first line-break-free gap before any
    echo or directive.
  - Only directives that take names become calls. `@foreach ($a as $b)`
    isn't a valid call.
  - Component and Livewire tags are found on the line, and must follow `<`.
- **Fixes over Laravel LSP:**
  - Completion works in double-quoted and unfinished strings, including
    unfinished directives.
  - Positions are UTF-16.
  - `HomeController@index` matches a route's full action name by its end.
  - A class name passed to `app()` isn't reported as a missing binding.
  - `@includeIf`, `@includeWhen`, `@includeUnless`, `@includeFirst`, and
    `@livewire` are recognized.
  - `@vite(...)` and `Vite::asset()` complete files under `resources/`, link
    to them, and report a file that doesn't exist (code `vite`).
  - A gate's model can come from a typed variable, not only `X::class`.
  - A link's `#L<line>` opens at the line: Monaco reads the fragment as a
    selection without an end, which the editor opener turns into a position.
- **Left out on purpose:**
  - The Pest helper file: it would be written into the project, and the
    functions it declares would duplicate Pest's own in the index. Pest's
    `$this` problems are filtered in `diagnostics.ts` instead.
  - The `laravel/data` request: VS Code's pickers use it, and Tusk's route
    list needs `artisan route:list`'s fields.

### Tests

Run the tests with `cargo test` in `tusk-lsp/`. `cargo test -- --ignored`
also runs the integration tests, against Filament's demo app (`fixtures/demo`)
and a real Laravel app, which need PHP.

- **Feature tests** build an in-memory project (`testing.rs`) with a `<|>`
  cursor marker and call handlers directly.
- **Protocol tests** (`tests/protocol.rs`) run the real server over an
  in-memory connection, including requests racing edits, a reindex, and file
  events, and cancelled requests.
- **Unfinished files:** a test in `handlers.rs` cuts a file at every point
  and runs each request and every code action's resolve on it. An unfinished
  file parses with its open brackets closed, so spans can run past the
  document's end; slice the parsed text (`Parsed::text`), not the document's.
  A span from the index can also be stale, such as right after a file changes
  on disk, so text taken from another file uses `str::get`.
- **Encodings:** files read from disk go through `text::decode`, which turns
  each byte that isn't UTF-8 (a Latin-1 file's accents) into `?`, so offsets
  match the parser's, which reads raw bytes. `from_utf8_lossy` puts a 3-byte
  character in each one's place.
- **Stress test:** `cargo run --release --example stress <root> [max files]
  [seed]` runs the real server over a project: every request at random places
  in each file, then with the file cut off at random points. It reports caught
  panics, requests unanswered for 30 s, and each method's mean and slowest
  time; a stack overflow ends it, after the file it was on. Run it on
  projects unlike the ones the tests use, such as Symfony, WordPress, and
  Magento. `examples/depth.rs` lists a folder's most deeply nested files (with
  `BRANCHES=1`, those with the most branches in one statement).

  Results on 2026-09-27, 200 sampled files per project, on an M-series Mac,
  with type and call hierarchy, formatting, Fix All, and workspace symbols
  added to the requests:

  | Project | Files indexed | Index | Mean hover | Slowest references | Slowest incoming calls |
  |---|---|---|---|---|---|
  | PHP-Parser | 341 | 0.0 s | 1.8 ms | 0.1 s | 2.7 s |
  | Laravel framework | 2,981 | 0.4 s | 2.2 ms | 0.3 s | 0.7 s |
  | Symfony | 11,919 | 0.6 s | 2.1 ms | 4.3 s | 4.2 s |
  | WordPress | 1,899 | 0.2 s | 1.9 ms | 2.5 s | 4.6 s |
  | Magento 2 | 25,580 | 2.2 s | 2.8 ms | 1.3 s | 2.0 s |

  No request crashed or hung after the fixes the runs led to: requests on
  plain threads (see Threads), inheritance cycles cut before populating (see
  Index), one search for a constructor's classes, and spans from the index
  sliced with `str::get`. References, rename, and incoming calls analyze
  every project file that mentions the name, so a common name in a large
  project takes seconds; all three can be cancelled.
- **Benchmark:** `cargo run --release --example index_bench <root> [file]`
  times indexing a real project.

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

### Measuring indexing

Time Tusk's server's index against a project, and one file's update:

```sh
cd tusk-lsp
cargo run --release --example index_bench <project> [file]
```

`examples/refs_bench.rs` times a references search the same way, and
`examples/inlay_bench.rs` a file's inlay hints.

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
| Whole-file copies sent to Phpactor per 55 keystrokes (before the switch to Tusk's server, which gets edits) | 55 | 9 |

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
for choosing a folder. The question shows as the popup's wrapped title
(`question` in `pick`'s options) with numbered answers, since as the search
box's placeholder a long one, such as a delete with a deep path, was cut off.

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
and `__toString()`, which Phpactor lacked, were written by the editor until Tusk's server offered them.

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

### 2026-09-27: Redis through a hand-written RESP client

The `redis` crate would bring a connection manager, a parser crate, and
features for clusters and async, while the tool needs one command per
connection with text replies. RESP2 is a line-based protocol, so a reader and
writer take about 60 lines, and TLS reuses `native-tls`, which was already in
the build. RESP3's maps would name hash replies by type, but they need Redis 6
(`HELLO 3`), so the few commands that return pairs are named instead.

### 2026-09-27: Redis keys in a tree, with the frontend driving commands

The first Redis support ran one command per click through `db_query`, which
opened a connection each time and returned only text in a grid. The key
browser needs more: types for a whole batch of keys, several reads per key,
and edits that apply together. So the backend gained one generic primitive,
`redis_call`, a pipeline with an optional transaction that returns replies as
JSON. The frontend builds every browser feature on it, which keeps the Rust
side free of per-command knowledge and puts the logic where Node tests it.
Connections are pooled because a TLS handshake per click is visible on a
remote server. Keys load in batches instead of all at once, since `SCAN` to
the end on a production keyspace of millions takes minutes.

### 2026-09-27: Pull Members Up and Extract Interface plan text edits

Phpactor has no Pull Members Up, and its class generation doesn't move members
or rewrite names. Both refactorings plan plain text edits over the source, as
the other refactorings here do, so the Refactoring Preview, one-step undo, and
saving work unchanged. The member dialog recomputes the whole plan on every
change, rather than validating the choice at the end, because it is cheap (a few
regex passes over two files) and lets the dialog show the exact code and
problems as you choose, as PhpStorm's does.


### 2026-09-27: The editor's context menu is the app's

Monaco's menu listed VS Code's commands with VS Code's shortcuts (⌘F12, ⇧F12,
F1 for its command palette), which contradicted the PhpStorm keymap everywhere
else. The main panes set `contextmenu: false`, and `codeMenu` in `src/main.ts`
builds the menu from the Find Action list by label, so a shortcut changed in the
keymap shows in the menu too. It moves the caret to a click outside the
selection first, as Monaco's menu did. `showMenu` drops separators around empty
groups, so callers can list groups without checking each one. Other editors
(the query console, the HTTP response) keep Monaco's menu for their own items.

### 2026-09-27: Quitting waits for unsaved edits

Quitting (⌘Q or the window's close button) ended the app at once, and the
blur that auto-saves doesn't reliably fire first, so edits could be lost. The
close button's `CloseRequested` goes to `onCloseRequested` in `src/main.ts`,
and ⌘Q is the **Quit Tusk** action instead of the native item. Both run
`readyToLeave`, the check the update restart already used: save with auto-save
on, otherwise Save, Don't Save, or Cancel. The window is then destroyed, which
ends the app through the normal exit, so language servers still stop. This
needs the `core:window:allow-destroy` permission.

### 2026-09-28: Per-project state in tusk.json and a file per project, not localStorage

Breakpoints, debugger options, database connections, and other per-project
values were in localStorage, which a team can't share, backup tools don't see,
and a reset of the web view wipes. They now live in `tusk.json` when shared, or
in a file per project in the app's data folder. One module owns both, so each
feature picks a key and a default scope instead of its own storage code, and
sharing is a move between scopes rather than a feature of each tool.

Values stay top-level keys in `tusk.json`, as `indexExclude` already was, so
the file stays readable and each key can move on its own. `tusk.json` is
rewritten from parsed JSON with the file's own indentation, not patched as
text: it keeps unknown keys and their order, but not comments (the file is
plain JSON, and an invalid file is never written) or custom spacing inside
values. Migration copies localStorage values once and leaves them in place,
so an earlier build still finds them. Local reads are synchronous from memory,
since `debug.ts` and `database.ts` read their values while they render.

### 2026-09-28: One splitter, and a panel that moves between two parents

Each resizable split had its own `mousedown` handler, and the Debug, Tests,
and Git Log splits had fixed percentages. `splitter.ts` now makes all of them,
with the keyboard, reset, limits, and saved sizes in one place. Pixel sizes,
not fractions, because PhpStorm keeps tool window sizes that way and because a
list's useful width doesn't grow with the window.

For the full-width bottom panel, the panel element moves between `main` and
`#workarea` instead of the workbench becoming a CSS grid. A grid needs `main`
to be `display: contents`, which puts the editor, diff, merge, and empty-state
views in one cell, and drops `main` from the accessibility tree in WebKit.
Moving the element keeps the terminals running: xterm.js and the
`ResizeObserver` that fits them follow the element.

### 2026-09-27: Tusk's own PHP language server replaces Phpactor, Laravel LSP, and the Filament server

The editor now runs one PHP language server of its own, `tusk-lsp/`, written in
Rust on Mago's crates, instead of Phpactor, Laravel LSP, and the PHP Filament
server. The earlier choice to build on free servers ("Build on free language
servers instead of writing one") assumed a server would take years; Mago's
published parser, codebase index, and analyzer make it a matter of features.

- **Speed:** Phpactor's first index of a Laravel and Filament app with 23,000
  PHP files took about 90 seconds and then needed its own bookkeeping; the new
  server indexes it in about a second at every start, with no index on disk.
  Mago runs in the server's process on each edit, where Phpactor ran its
  command line for every check, parsing the project again each time. The
  Problems panel's scan takes seconds instead of minutes.
- **One server instead of three PHP processes**, each with whole-file syncs,
  and the workarounds they needed: checking open files one at a time, holding
  empty publishes, tracking unfinished first builds, and soft reindexes after
  other programs changed files.
- **Control over behavior:** completion, code actions, rename, and Move Class
  work the way the editor needs, and fixes don't wait on upstream releases.
- **No `.phar` downloads:** the server is the app's own binary.

The costs: memory was about 1.3 GB on that large app at first, nearly all of
it `vendor`'s symbols (370 MB since the index loads only the library code the
project reaches); Mago's crates are
pinned to `=1.50.0`, because their API changes between minor versions, and
upgrading them is deliberate work.

### 2026-09-28: Super methods from one request per file

Go to Super Method and the gutter's override arrows share one custom request,
`tusk/overrides`, rather than using `textDocument/declaration` and the type
hierarchy. The standard requests work at a position, so the gutter would need
one per method and ⌘U inside a method body would first need the enclosing
method from document symbols. The custom request walks the parsed document
once and reads the rest from the index. `textDocument/declaration` still
answers ⌘B-style requests for a method's parent declaration.

### 2026-09-28: Monaco's commands from a table

With Monaco's command palette and context menu turned off, its editing commands
had no menu entries. Rather than an action per command, `EDITOR_COMMANDS` lists
them with their menu group, and the menu bar and the editor's context menu
place them by label. The editor's context menu gained submenus (Go To,
Refactor, Folding, Git) to hold PhpStorm's layout without growing past the
screen.

### 2026-09-28: Every action has a menu entry

Actions that only Find Action or a shortcut reached now sit in the menus:
Next and Previous Change and Select Opened File in Project in Navigate, Copy
Reference (now an action, ⌥⇧⌘C) in File, Markdown Preview in View, Copy Remote
URL in Git, Switch Connection in Tools > Database, Sync with Laravel Routes in
Tools > HTTP Client, and Pause on Exceptions Options in Run. **Send HTTP
Request** and **Execute Query** are app actions on ⌘⏎ with a `when` for their
languages, so they're in Find Action and the keymap editor; their Monaco
actions in `httpview.ts` and `database.ts` keep ⌘⏎ for the editors outside the
panes, so rebinding them adds a key rather than moving ⌘⏎ there. A Markdown
file's pane shows a preview button after its tabs.

### 2026-09-28: Menus show editor-only shortcuts

Editor-only actions and debugger steps had no accelerators, so the menus hid
shortcuts such as ⌘D and F8. They now have them, and a menu item for such an
action ignores a run that follows a key press by less than 500 ms, which is
when the page passed the key on. The alternative, drawing the shortcut into the
item's title, doesn't align with the native shortcut column.

### 2026-09-28: One module for errors and progress

Failures were reported three ways: `status()` toasted any message that matched
a regex for failure words, modules wrote their own "Loading…" and error text,
and many `invoke` calls had no catch at all, so they failed silently.
`src/status.ts` now holds `status`, `showError`, `withProgress`, and a global
handler for unhandled rejections. The regex stays as a fallback for the
`Host.status` callers that don't pass a kind, rather than changing every
module's `Host` type at once. `withProgress` takes an `AbortSignal` so long
operations added later (the debugger, git, database, HTTP) share one cancel
button in the status bar rather than each drawing its own.

### 2026-09-28: Settings never overwrite a file they can't read

An invalid `settings.json` used to fall back to the defaults silently, and the
next change wrote the defaults over it. Now Tusk refuses to write a file it
can't parse, rather than backing it up and replacing it, because the file you
wrote stays where you expect it, and fixing it in the editor applies it at
once. Values of the wrong type and unknown keys are kept for the same reason.
Other modules register their own settings groups (`registerSettings`), so the
features added next (tools, formatters, the terminal, the debugger) don't all
edit one list in `settings.ts`.

### 2026-09-28: One keyboard helper for lists, driven by the DOM

The Problems panel, the Redis tree, and the Profiler each had their own arrow
key handler, and most lists had none. `listNav` reads the rows from the DOM by
`data-key`, `aria-expanded`, and `aria-level` instead of taking a data model,
so a list that renders with `replaceChildren` needs only those attributes, and
the same code serves flat lists, nested trees, and a table whose tree is a flat
run of rows. It uses `aria-activedescendant` rather than a roving tabindex, so
a redraw doesn't move the focus.

### 2026-09-28: The terminal follows the editor's font, and its links open files

The terminal had a fixed font list and size 12. It now uses the editor's font
unless you set its own, so one change applies to both. File references in the
output are found with one regex over each line rather than per-tool parsers,
since PHPUnit, Pest, Mago, PHPStan, and PHP errors all print `path:line` or
`path(line)`, and a reference becomes a link only when the file exists, which
keeps false matches, such as version numbers, from turning into links.

### 2026-09-28: Breakpoints in a panel tab, and the debugger's settings in Settings

PhpStorm lists breakpoints in a modal dialog. Here they're a tab in the bottom
panel, because a modal blocks the gutter, and adding a breakpoint while you
look at the list is the common case. The exception options moved from a
palette flow behind a right-click to the same tab, with the zap button's arrow
as the visible way in. The port, limits, pause at the first line, IDE key, and
container host are app settings, not project state: they describe this Mac's
PHP and other listeners, not the project. Inline values scan the lines above
the paused one for `$names` rather than asking the language server for the
variables in scope, which keeps them to one pass over at most 50 lines; a name
from another scope can show a value it doesn't have there, which PhpStorm's
own heuristic also allows.

### 2026-09-28: Run configurations are flat objects keyed by name

PhpStorm keeps run configurations as typed XML with a template per type.
Tusk keeps one flat `RunConfig` object whose fields each type reads as it
needs, since the types share most fields (working directory, environment,
Docker, before launch) and a flat object reads well in `tusk.json`. Names are
the keys, as in PhpStorm, so before-launch steps and the selection are
readable in the files. Shared and local configurations are two project-state
keys rather than one key with a flag, because a value lives in one place in
`projectstate.ts`; for the same reason they aren't in `SHAREABLE`, whose
toggle moves a whole key.

### 2026-09-28: Test failures read the TeamCity log too

Pest's JUnit report has no expected and actual values, and PHPUnit's has a
diff of the changed lines only. Rather than parse the runner's terminal
output, whose format changes with Collision's versions, every test run also
writes a TeamCity log, which PHPUnit 9 through 11 and Pest 1 through 3 write
the same way, with full values and stacks. The JUnit report stays the source
of the results and times, since the log has no data sets' names in Pest.

### 2026-09-28: Stashes in a tab of the Commit tool window

PhpStorm keeps stashes in a tab beside the commit view, and so does Tusk,
rather than the palette pickers it had: a list shows each stash's branch and
age, and its files and diffs, at a glance. `stash@{n}` names shift, so rows
are keyed by the stash's commit hash, and actions use the ref only when they
run.

### 2026-09-28: Branch actions in a second popup

PhpStorm's branches popup opens a submenu per branch. The palette has no
submenus, and a custom popup would need its own search, keyboard, and
placement, so choosing a branch opens a numbered popup of its actions at the
same place. It keeps the popup's search and keys, and a number picks an action.

### 2026-09-28: Push, pull, and fetch in the background

They ran in terminal tabs so you could answer credential prompts, but then a
rejected push or a conflicting pull never reached the UI. Most setups
authenticate without a prompt (the macOS keychain helper, an SSH agent), so
they now run in the background with `GIT_TERMINAL_PROMPT=0`, and only a failure
that needed a prompt falls back to a terminal tab.

### 2026-09-28: The log searches through git

The log's filter used to match the loaded page of commits only, so an older
commit never matched. Each filter now maps to a `git log` option and runs a new
query, as PhpStorm's does, with pages of 300 still loading on demand.

### 2026-09-28: Resolve simple conflicts in the app, not with git's options

git's `merge-file` and `-X` strategies resolve a conflict for a whole side, not
by merging two sides that changed different lines of one block. The merge tool
therefore merges such blocks itself (`resolveSimple`), on request, as
PhpStorm's magic wand does, and leaves blocks where both sides changed the same
lines.

### 2026-09-28: Queries cancel in the database, and the grid draws what shows

Closing the results used to leave a query running on the server. Cancel now
stops it where it runs: SQLite's interrupt, MySQL's `KILL QUERY` from a second
connection, and PostgreSQL's cancel request, each registered by the query as
it connects. The query timeout is the same cancel on a timer, rather than a
socket timeout, because a timed-out socket leaves the server running the query
and the connection unusable. The drivers still open a connection per query;
keeping one would allow cancel without a second connection, but it would also
need transaction state per console, which the editor doesn't have.

The grid was a `<table>` of every row, with editing patched onto its cells.
It's now one component that owns its rows, selection, and edits and draws only
the rows in view, since a `<table>` of 10,000 rows took seconds to lay out and
row heights had to be fixed for virtual scrolling anyway. Rows are CSS grid
rows sharing one `grid-template-columns`, so resizing a column is one variable.

Connections are edited in a dialog, as in PhpStorm's Data Sources, instead of a
URL typed into the palette, because TLS, SSH keys, and read-only mode don't fit
in a URL a team shares. The URL stays as a field kept in step with the form,
since that's how Laravel's `DB_URL` and hosting providers give connections.

### 2026-09-28: Tool paths through shims on PATH, not at each call site

Settings > Tools could have replaced each `"php"` in the frontend with a lookup,
but PHP also runs from places the frontend doesn't see: `/usr/bin/env php` in
terminal commands, Sail's scripts, and the PHP server's own helpers. A folder of
shim scripts first on every child's `PATH` covers all of them with no call-site
changes, applies to the next program without a restart, and keeps merges with
the modules that run tools trivial. The backend checks the tool before it
starts a program, so a missing one fails with an error that names the setting,
not a raw spawn error. The tools manifest's URL stays fixed: packages are
signed with the updater's key, so a mirror would need Tusk's key anyway.

### 2026-09-28: Formatters per language in project state

A team's formatter is part of the project, as its `lint-staged` and CI show, so
the choice per language lives in `formatters`, shareable in `tusk.json`, not in
personal settings. Auto keeps the old order, so a project that sets nothing
formats as before. Format on save stays a personal setting, with a per-language
override in the same value rather than a second setting, so one dialog shows
both. Built-in unregisters Tusk's provider for the language instead of
returning nothing from it, because Monaco uses one provider when several apply.

### 2026-09-28: Which hardcoded limits became settings

The recent projects cap, the Find in Files limit, local history's retention,
the HTTP history's size and largest shown body, and the tree's hidden and
excluded folders became settings; the tree's lists are project state, since a
team's generated folders are part of the project. The Git log's page of 300
stayed: the log already loads the next page on demand, so the size only tunes
how often it asks. AI completion's internal limits stayed, since they're tuned
against the model's context. The tools manifest URL stayed, since a mirror
would need a list signed with Tusk's key.


### 2026-09-28: Language tool settings

Spelling, PHPStan, and Mago got settings pages. `settings.ts` grew project
groups (`registerProjectSettings`) and module-drawn sections
(`registerSettingsSection`, `listEditor`) instead of a second settings system,
so every setting is in one dialog with one search. Tool settings that the tool
reads itself stay in its file (`_typos.toml`, `mago.toml`), edited with
`toml_edit` so hand-written comments survive; the rest is project state.

### 2026-09-28: Hide secrets in history response bodies by default

The history file already hid request secrets, but a login response's token
stayed in its body file. Hiding by field name, as `redact` does for requests,
catches the common cases (`access_token`, `password`) without guessing at
values. You still need to see and copy the real body during the session, so
the history gets the redacted copy and the session keeps the original in a
folder that's removed next time, rather than redacting what you're looking
at. A setting keeps bodies as they came or drops them, since some teams want
full replays and others want nothing on disk.

### 2026-09-28: Local history names versions in their file names

The Local History window needs to say what kept each version. A sidecar
index would need locking and could disagree with the files on disk, so the
action goes in the version's name, which pruning and listing already read.
Other programs' changes can't say who made them, so the editor sets a short-lived
activity (a git command, a revert) that the watcher's versions pick up. The
tab has its own diff editor rather than the git diff view, so the list and
the diff show side by side, as in PhpStorm.

### 2026-09-28: Bookmarks are one ordered list in local project state

The Bookmarks tab can be reordered by dragging, so the order is data: one
list, rather than a map from files to lines, with each file's bookmarks kept
together. Bookmarks are personal, like PhpStorm's by default, so they stay in
the local project state and don't go in `tusk.json`. The tab is a bottom panel
view like Breakpoints, which it resembles, instead of another sidebar view.

### 2026-09-28: Long checks report counts through `$/progress` tokens the caller owns

The project problems scan runs as one request in Tusk's server. Rather than
split it into per-file requests, the request takes a `workDoneToken`, and the
server reports "done/total files" against it. `tuskRequest` routes a token's
progress to the caller instead of the status bar's generic line, and cancels
the request when the caller's `AbortSignal` aborts, which the server's
`is_cancelled` check already honors between files. `withProgress` gained a
`report` callback so the count shows next to **Cancel**.

### 2026-09-28: The Filament designer edits code, and keeps no model of its own

A visual designer could keep its own description of a resource and write the
PHP from it. Real resources have comments that explain workarounds, closures,
translated labels, and code no designer understands, and writing the file again
would lose them. So the designer reads the code through Tusk's server, shows
what it understands, and makes each change as a small edit at the range it read.
Code it doesn't understand stays as written. The components and their settings
come from reflecting the project's own Filament and plugins, not from a list in
Tusk, so a new Filament version or a plugin works without an update.

### 2026-09-28: The model designer stages changes and writes one migration

Each change to a table could be its own migration, as each change to a resource
is its own edit. But migrations run once and in order, and a dozen small ones
for one sitting's work are noise in `database/migrations`. So the model designer
keeps changes until Apply and writes one migration with all of them, shown in
the preview first. It never edits a migration that exists, since one that has
run won't run again.

### 2026-09-28: The enum designer keeps methods it can't read

An enum's `getIcon()` can resolve icons through a helper, as Filament's demo
does. The designer could rewrite such a method from its table, but that would
lose the helper. So a method that isn't a plain `match` stays as it is, its
column shows as code, and a new case that such a method would throw for is
called out, with the method opened after Apply.

### 2026-09-28: Policy rules are the code, not a permission table

Tools like Shield generate a permission per ability and check it in every
policy method. The Access tab could store rules elsewhere and generate the
policy, but a policy is code people edit, often with a helper that narrows
access, as in "a permission, and a member of the project". So the designer
reads and writes the methods themselves, understands the common shapes, and
keeps anything else as code. Permissions stay in Spatie's tables, which the
tab changes through Spatie's own models.

### 2026-09-28: New projects use Laravel's installer, kept in Tusk's tools

`composer create-project laravel/laravel` would need no installer, but the
starter kits and their options (authentication, teams, Pest, Boost) are the
installer's, and they change with Laravel. So Tusk runs the installer itself,
from its own tools folder, where the bundled Composer installs and updates it.
Nothing is installed globally, as the editor promises.

