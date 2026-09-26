<p align="center"><img src="design/icon.png" width="128" alt="Tusk's icon: an ivory tusk on an indigo tile" /></p>

# Tusk

Tusk is a fast macOS desktop editor for PHP, Laravel, and Filament projects. It
aims for PhpStorm-class navigation and refactoring using only free, open-source
language servers. Its name comes from PHP's
elePHPant.

The app is built with Tauri 2 (Rust backend) and the Monaco editor.

## Status

| Milestone | State |
| --- | --- |
| 1. Editor shell: folders, file tree, tabs, save, highlighting, file watcher | Done |
| 2. PHP intelligence through Phpactor | Done |
| 3. Laravel LSP, Mago, and Larastan diagnostics | Done |
| 4. Terminal, Artisan, test runner, search | Done |
| 5. Git, blame, and pull requests | Done |
| 6. Filament language server | Done |

For the design and the reasons behind each choice, see
[Architecture and decisions](docs/architecture.md).

Typing stays at about 3 ms of work per keystroke, even in a 4,800-line PHP file
with AI completion on, and language servers never block the window. For how
that's kept, and how to measure it, see
[Performance](docs/architecture.md#performance).

## Known gaps

These PhpStorm features are missing or limited. Where it helps, a gap names the
file to change when you add it.

### Limited

| Area | Gap |
| --- | --- |
| Find in files | Results stop at 20,000 matches (Replace All still changes every matching file). |
| Test results | On PHPUnit 10 and later, a running test's file is found from its class name through `composer.json`'s PSR-4 folders, so a class outside them opens at a guess. |
| Type hierarchy | A trait's users are found in project files, not in `vendor`. |
| Call hierarchy | Callers come from the same search as Change Signature, so calls through dynamic names such as `$this->$method()` are missed, and so are calls of a constructor through `new`. Callees are found with Go to Definition on each call, so calls on a value whose type Phpactor can't infer are missed. |
| TODO comments | The search stops at 20,000 matches, counted before those outside comments are dropped. |
| Test detection | `src/phptests.ts` reads tests with regexes over the code outside comments, so a test declared inside a heredoc string still gets a run link. |
| Blade | The PHP in a view is checked without its variables' types, which come from the controller, so mistakes on a variable, such as a misspelled property, aren't reported. Only open views are checked. Directives inside `<style>` aren't highlighted, since CSS has at-rules of its own. |
| First indexing | Phpactor indexes a new project once, which takes minutes for a full Laravel app. Progress shows in the status bar. Hidden folders, `node_modules`, `storage`, and `bootstrap/cache` are skipped. |
| Mago analysis | Mago has no server mode, so it parses the project again for each check: about 2 seconds of wall time, and several seconds of CPU, on a project with 27,000 PHP files. It runs 1 second after you stop typing. |
| Unsaved files | Phpactor, Laravel LSP, Tailwind, and the Filament server accept only whole-file syncs, so each gets the full text after every 150 ms pause in typing (`track` in `src/lsp.ts`). |
| Filament | The Filament server knows field names, relationships, options, and resource structure. It doesn't check column names (virtual attributes make that unreliable). `$get()` and `$set()` suggest every field name in the file, not only those in the same form, and don't resolve `../` paths. Options from a closure or a query aren't suggested. |
| Database | Only SQLite, MySQL, MariaDB, and PostgreSQL connections work. SSH tunnels need key or agent authentication, and `verify-full` fails through a tunnel, since the host is then `127.0.0.1`. Running another query drops pending changes. |
| Pull requests | Comments on lines outside the diff's changes are rejected by GitHub. Pending comments saved on this Mac by an earlier build aren't moved to GitHub. Resolve state loads for the first 100 threads. You can't edit a review's summary. |
| HTTP client | GraphQL highlighting shows in the Query editor only, not in `.http` files. gRPC calls ignore `# @insecure`, proxies, and client certificates, don't stress test or copy as code, and show a streaming response once the call ends. The history keeps the last 100 unpinned requests per project, without secrets, so a request from an earlier session is sent again from its file. Response bodies in the history aren't redacted. Stress tests and monitoring run no scripts. Request bodies from validation rules come from regexes over the PHP (`validationRules` in `src/phptypes.ts`), so rules built in loops or from other methods are missed. Herd and Valet detection (`appAddresses` in `src/laraveltools.ts`) reads Valet's config layout. |
| Split editors | Up to four panes. |
| Platform | macOS only. AI completion on Intel Macs runs on the CPU, since llama.cpp's Intel build has no Metal support. |

### Missing

| Area | Gap |
| --- | --- |
| Debugger | Xdebug can't tell at a throw whether code will catch the exception, so **Only uncaught** pauses later: in Laravel, when its handler starts rendering the exception, and elsewhere, at PHP's fatal error, when the stack is gone and chosen classes match by name only, without their subclasses. A queued job's exception isn't rendered, so it doesn't pause. |
| Local history | A closed file's text before its first change by another program is kept only if git has it staged. One burst of changes by other programs keeps at most 200 closed files, so a branch switch that rewrites more keeps only some. Deleting a folder keeps its first 500 files, leaving out ignored ones such as `vendor`. |
| Refactoring | Phpactor provides rename, extract method, extract constant, generate methods, and import class through ⌥⏎. Moving a file moves its class. Change Signature finds overriding methods only in project files, not `vendor`, and misses a class whose `extends` or `implements` list is split over several lines. Neither it nor Safe Delete sees calls made through dynamic names, such as `$this->$method()`. Inline Variable works within one function. |
| Tools | Spell checking flags known misspellings, not every word missing from a dictionary, so rare typos can slip through. AI completion reads the classes PHP and Blade files use, and the project files JavaScript, TypeScript, and Vue files import, but not the types of packages in `node_modules`. It indexes at most 3,000 files. |
| Coverage | Which tests ran a line comes from PHPUnit's XML coverage, which only records lines of the folders in `phpunit.xml`'s `<source>`. |
| Profiler | Requests you make in a browser are named by URL from the profile's file name, where Xdebug turns `/`, `.`, `?`, and `&` into `_`, so a query string reads as more path. The table shows up to 500 functions at a time; filter to find the rest. Profiling runs on this Mac, not in Sail. |
| Deployment | There's no remote deployment or sync over SFTP or FTP. |
| Code signing | The app is ad-hoc signed, not notarized, so on another Mac, Gatekeeper blocks the first install until you allow it in **System Settings > Privacy & Security**. Notarizing needs a paid Apple Developer account. |

## Requirements

To use the app, you need:

- macOS
- PHP 8.1 or later on your `PATH`. The app finds PHP through your login shell,
  so installs from Homebrew and Laravel Herd work.
- Git, and optionally the GitHub CLI (`gh`) for pull requests.
- Node.js, for Tailwind CSS, JavaScript, TypeScript, and Vue support. Laravel
  projects that use Vite already need it.

To build the app, you also need:

- Rust 1.97 or later
- Node.js 24 or later, and pnpm

The app manages its own tools (Phpactor, Laravel LSP, Mago, Composer, `typos-lsp`,
the Xdebug adapter, `llama-server` for AI completion, and the Tailwind CSS, TypeScript, and Vue language
servers), and compiles in the database drivers, so you don't install them
yourself. The first launch downloads the tools for your Mac's chip (about
90 MB) into `~/Library/Application Support/ly.almontasser.tusk/tools/`, and
checks for newer versions at launch and every six hours. Sail support needs
Docker, which Sail itself needs. If your project has PHPStan or Larastan in
`vendor/bin/phpstan`, the app runs it too.

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
cargo test --manifest-path src-tauri/Cargo.toml db -- --ignored   # MySQL and PostgreSQL, needs the servers in src-tauri/src/db.rs
php -d zend.assertions=1 filament-lsp/tests.php fixtures/demo   # Filament server, needs the test app
node scripts/ai-bench.ts <project> <model.gguf>   # AI completion quality, see docs/architecture.md
```

## Build a release

```sh
pnpm tauri build
```

The `.app` bundle and the `.dmg` file are written to
`src-tauri/target/release/bundle/`. The build runs on Macs with the same chip
as the one that built it.

To build one app for both Apple silicon and Intel Macs, add Rust's Intel target
once, then build for both:

```sh
rustup target add x86_64-apple-darwin
pnpm tauri build --target universal-apple-darwin
```

The bundle is written to `src-tauri/target/universal-apple-darwin/release/bundle/`.

### Publish new tools

To upgrade a language tool, change its URL and checksum in
`scripts/fetch-tools.sh` (or its version in `node-tools/package.json`), then
run:

```sh
node scripts/publish-tools.ts
```

The script fetches the tools for both chips, packs each tool whose files
changed, and uploads them to the `tools` GitHub release with a `tools.json`
list signed with the key in Bitwarden, then deletes packages the list no longer
uses. Installed copies check at launch and every six hours, download the
changes in the background, and use them from the next launch. No app release
is needed.

### Publish an update

Installed copies check the latest GitHub release at launch and every six hours
after, and offer each new version once. **Tusk > Check for Updates…** checks
right away. To publish one, commit your changes, then run:

```sh
scripts/release.sh 0.2.0
```

The script sets the version, builds the universal app, signs the update
archive with the private key from the `tusk-signing-key` note in Bitwarden
(through `bwnote` from your `~/.zshrc`, which unlocks the vault with Touch ID
if it's locked), writes `latest.json`, commits and tags the version, and creates the
GitHub release with `gh`. The key is kept only in Bitwarden: without it,
installed copies can't verify a new version, and you must ship a new key in a
DMG that everyone installs by hand.

## The window

- **Title bar:** the project name (click it for a dropdown to switch to a
  recent project or open a folder), the current branch and its pull request, a **Search everywhere**
  box, and buttons for the debug server, the terminal, and settings.
- **Tool bar on the left:** icons for the **Project**, **Commit**, **Pull
  Requests**, and **Find** views. Click the active icon to hide the sidebar,
  and drag the sidebar's edge to resize it. The icons at the bottom open the
  **Git Log**, the **Debug** panel, and the terminal.
- **Status bar:** error and warning counts for open files (click them to list
  the problems), the file's path followed by breadcrumbs for the class and
  method at the cursor (click one to go to it), background work such as
  indexing, the cursor position,
  indentation, line endings, and the file's language.
- **Welcome screen:** without an open folder, the window lists your recent
  projects.

Errors, such as a failed git command, also appear briefly in the lower-right
corner.

## Keyboard shortcuts

Shortcuts follow PhpStorm's macOS keymap. To see every action and its
shortcut, press ⌘⇧A (**Find Action**).

The menu bar (File, Edit, View, Navigate, Code, Refactor, Run, Tools, Git,
Window, and Help) runs the same actions. It shows the shortcuts of actions that
work everywhere. Editor-only actions, such as **Duplicate Line**, and debugger
steps don't show their shortcuts there, so the keys still reach text fields and
the terminal. To search the menus, use the search field in Help.

To change a shortcut, run **Keymap…** from ⌘⇧A (or click **Keymap…** in
Settings), choose the action, and press the new shortcut, or tap ⇧, ⌃, ⌥, or ⌘
twice for a double tap such as ⇧⇧. Backspace removes the
shortcut, and **Reset to Default** restores it. If another action had that
shortcut, the other action loses it. Changes are saved in `settings.json` as
`keymap`.

| Shortcut | Action |
| --- | --- |
| ⇧⇧ | Search everywhere: classes, files, and actions |
| ⌘⇧A | Find action |
| ⌘O | Go to class |
| ⌘⇧O | Go to file (press again to include ignored files, such as `vendor`) |
| ⌥⌘O | Go to symbol in the project |
| ⌘E | Recent files |
| ⌘⇧F | Find in files |
| ⌘⇧R | Replace in files |
| ⌃H | Type hierarchy of the type under the cursor, or the one the cursor is in |
| ⌃⌥H | Call hierarchy of the method or function under the cursor, or the one the cursor is in |
| ⌘⌦ | Safe delete the class, method, or function at the cursor |
| ⌥⌘N | Inline the variable at the cursor |
| ⌘F6 | Change the signature of the method or function at the cursor |
| ⌘⇧F10 | Open the query console |
| ⌘⏎ | Run the SQL statement under the caret |
| ⌘F12 | File structure |
| F3 | Toggle a bookmark on the current line |
| ⌘F3 | Show bookmarks |
| ⌘B or ⌘-click | Go to declaration |
| ⌥⌘B | Go to implementation |
| ⌃⇧B | Go to type declaration |
| ⌥F7 | Find usages |
| ⇧F6 | Rename (also renames the file for a class) |
| F2 and ⇧F2 | Next and previous problem in the file |
| ⌥⏎ | Show context actions and quick fixes |
| ⌘P | Parameter info |
| F1 | Quick documentation |
| ⌥↑ and ⌥↓ | Extend and shrink the selection |
| ⌥⇧↑ and ⌥⇧↓ | Move the line up or down |
| ⌘D | Duplicate the line |
| ⌘⌫ | Delete the line |
| ⌃⌥O | Optimize imports |
| ⌥⌘L | Reformat the file with the project's formatter |
| ⌘N | In a PHP file, generate code (constructor, getters and setters, `__toString()`, methods to implement or override); elsewhere, a new file in the selected folder |
| ⇧⌘C | Copy the path of the selected or active file |
| ⌥F12 | Show or hide the terminal |
| ⌃⌃ | Run anything: Artisan commands or shell commands |
| ⌃⇧R | Run the test at the cursor, or all tests in the file |
| ⌃R | Rerun the last test or command |
| ⌃⇧D | Debug the test at the cursor |
| ⌘F8 | Toggle a breakpoint on the current line |
| ⇧⌘F8 | Edit the breakpoint on the current line: condition, hit count, or log message |
| F9 | Resume (while debugging) |
| F8, F7, ⇧F8 | Step over, step into, step out (when not paused, F8 and ⇧F8 go to the next and previous problem across files) |
| ⌘F2 | Stop debugging |
| ⌘K | Commit |
| ⌘⇧K | Push |
| ⌘T | Update the project (`git pull`) |
| ⌘1 | Show the project tree |
| ⌘\ | Split the editor to the right, or move to the next pane |
| ⌘⇧\ | Split the editor down |
| ⌘9 | Git log |
| ⌘S | Save all files |
| ⌘, | Settings |
| ⌘W | Close the tab |
| ⌃\` | Color theme |
| ⌃Space | Show completions |

To open a folder, click **Open Folder…** in the sidebar or run the **Open
Folder…** action.

## Settings

Press ⌘, to open **Settings**. Settings are grouped under Appearance, Editor,
AI, and Spelling. Changes apply immediately and are saved in
`~/Library/Application Support/ly.almontasser.tusk/settings.json`.

| Setting | Default |
| --- | --- |
| Theme: one of about 110 color themes, or match the system | Dark |
| Dark and light themes for Match the system | Dark, Light |
| Editor font and font size | JetBrains Mono (or its Nerd Font build), or else Menlo, at 13; ligatures are on only with a font that has them |
| Wrap long lines | Off |
| Show the minimap | Off |
| Show inlay hints | On |
| Show the cursor line's problem at the end of the line | Off |
| Vim emulation | Off |
| Save files automatically | On |
| Format files when saving | Off |
| Check spelling | On |
| AI code completion, and its model | Off, Qwen2.5-Coder 3B |

### Vim emulation

Turn on **Vim emulation** in Settings to edit with Vim keys, through
[monaco-vim](https://github.com/brijeshb42/monaco-vim). It switches on and off
at once, without a restart. The status bar shows the mode, such as `--NORMAL--`,
and the `:` command line. While you type in the editor, ⌃ and a letter, such
as ⌃D or ⌃R, go to Vim instead of the app's shortcut; ⌘ shortcuts still work.

### Color themes

The editor comes with about 110 color themes, and you can import more:

- **Dark** and **Light**, built in, with syntax colors close to PhpStorm's.
- 65 VS Code themes from [tm-themes](https://github.com/shikijs/textmate-grammars-themes),
  such as One Dark Pro, Dracula, GitHub, Catppuccin, Tokyo Night, Nord, Gruvbox,
  Rosé Pine, Solarized, Night Owl, Material, Ayu, Kanagawa, and Everforest.
- 45 classic TextMate themes from [monaco-themes](https://github.com/brijeshb42/monaco-themes),
  such as Cobalt, Monokai Bright, Tomorrow Night, Twilight, Oceanic Next, and Xcode.

A theme colors the code, the interface, and the terminal. To choose one, press
⌃\` or run **Color Theme…**. Use the arrow keys to preview each theme, Enter
to keep one, and Escape to go back. You can also choose a theme in Settings,
where **Match the system** switches between a dark and a light theme with
macOS.

To use any other theme, run **Import Color Theme…** (or click **Import Theme…**
in Settings) and choose one of these files:

- A VS Code theme (`.json`). In a VS Code extension, themes are in the
  `themes` folder; to get the files from a `.vsix`, unzip it.
- A TextMate or Sublime Text theme (`.tmTheme`).

Imported themes are saved in the `themes` folder next to `settings.json`, and
you can copy theme files there too. To delete one, run **Remove Imported Color
Theme…**.

### EditorConfig

If the project has `.editorconfig` files, the editor follows them:
`indent_style`, `indent_size`, and `tab_width` set each file's indentation (the
status bar shows it), and saving applies `trim_trailing_whitespace` and
`insert_final_newline`. `charset` sets the encoding files are read and saved
in: `utf-8`, `utf-8-bom`, `latin1`, `utf-16le`, or `utf-16be` (the status bar
shows it). `end_of_line` (`lf` or `crlf`) applies to new files, and converts a
file's line endings when you save it; ⌘Z undoes the conversion. `cr` (old Mac
line endings) converts when saving too, but the editor shows CR lines as LF, so
⌘Z can't undo it. Without `.editorconfig`, the editor detects indentation from
each file's content, keeps each file's line endings (CR included), and reads
files as UTF-8. Changes to
`.editorconfig` apply to open files at once.

Without a `charset`, a file that isn't valid UTF-8 opens in the encoding it
most likely has, such as Windows-1252 or Shift_JIS, and saves back in it. The
status bar shows the encoding and line endings. To pick another encoding,
click it, or run **Change File Encoding…**: **Reopen** reads the file again in
that encoding, and **Convert and Save** saves the text in it. The choice lasts
until you restart the app.

Press ⌘\ to split the editor to the right, or ⌘⇧\ to split it down: the
current file opens in a new pane, up to four panes. With four, ⌘\ moves to the
next pane. Each pane has its own tabs, and a file open in two panes shows your
edits in both. Closing a pane's last tab closes the pane. Run **Move Tab to Next
Pane** to move the current tab, or drag a tab: within its tab bar to reorder
it, onto another pane's tabs or editor to move it there, or onto the edge of any
pane's editor to split that pane with it. The shaded half shows where the new
pane goes. Drag the border
between two panes to resize them. Run **Unsplit** to close the focused pane and
move its tabs to the pane beside it. The panes, and the shell terminals, come
back when the project reopens.

Right-click an editor tab to close it, the others, or all of its pane's tabs, to
split it right or down, or to copy or reveal its path. Bottom panel tabs, such
as the terminals, **Tests**, and **Problems**, work the same way: right-click
one to close it, the others, or all; middle-click to close it; and drag it along
the tab bar to reorder it. ⌘W closes the panel tab when you last clicked in the
panel, and the editor tab otherwise. Right-click a terminal to copy, paste,
select all, or clear it. Click **+** at the end of the panel's tab bar for a
new terminal. The terminal button shows the last shell you used, or opens
one, even while another panel tab shows. It skips command tabs, such as
`git pull`, and shells that have exited.

Diffs, the merge tool, and problem pages open as editor tabs, so your other tabs
stay in view. The Git Log opens in the bottom panel.

Drag a panel tab into the editor area to open it as an editor tab: onto a
pane's tabs or editor to add it there, or onto the edge of a pane's editor to
split that pane with it. A terminal keeps running when it moves. To put the tab
back, drag it onto the panel's tab bar, or right-click it and choose **Move to
Panel**. Terminals in the editor area come back in the panel when the project
reopens.

Files save automatically, as in PhpStorm: when you switch tabs, close a tab, or
switch to another app. ⌘S saves every changed file. If you turn automatic saving
off, closing a changed tab asks whether to save it.

The app reopens the last folder when it starts, with the tabs you had open in
it. Each tab keeps its cursor, selection, scroll position, and folded code, both
when you switch tabs and when you reopen the project. Expanded folders in the
tree and the sidebar view come back too. Shells reopen in the folder you last
`cd`'d to. Servers and watchers you started from Run Anything, such as `npm run dev`,
`php artisan serve`, `queue:work`, or `sail up`, and Tinker, run again if they
were still running when you closed the project. Each reopened terminal shows
its earlier output first, as plain text without colors, up to its last 50,000
characters. If the debugger was listening, it listens again, and the profiling
server and **Start Debug Server**'s server start again if they were running.
Other commands, tests, and git commands don't run again. Opening another
project closes the terminals of the one before. If a project has a
`.phpactor.json` file, Phpactor asks whether to trust it, because the file can
run code. After you choose **Yes**, the language servers restart and load it. Refactorings such as rename
save every file they change.

## Files

Right-click the project tree for **New File…**, **New Folder…**, **Rename…**,
**Move to Trash**, **Copy Path**, **Copy Relative Path**, and **Reveal in
Finder**. In the tree, you can also press:

- ↑ and ↓ to move between rows, and ⏎ to open a file or folder.
- F2 or ⇧F6 to rename.
- ⌘⌫ or Delete to move to the Trash.

Drag a file or folder onto a folder to move it there.

- **New PHP files** get a class skeleton with the namespace from your
  `composer.json` PSR-4 mappings. A name ending in `Interface`, `Trait`, or
  `Enum` creates that kind of type instead. Type `Support/Money.php` to create
  folders too.
- **Renaming or moving a PHP file** renames its class to match the file name,
  updates its namespace, and updates every reference to it, as in PhpStorm.
  Moving a folder does this for every PHP file inside it. Open tabs follow
  their files and keep unsaved changes.
- **Deleting** moves files to the macOS Trash, so you can restore them.
- **No overwrites.** Renaming or creating never replaces an existing file.

### Markdown preview

To preview a Markdown file, run **Markdown Preview** from ⌘⇧A, or right-click
its tab and choose **Open Preview**. The preview opens in the pane to the
right, splitting the editor when there's only one pane. It updates as you type
and scrolls with the editor. Images with relative paths load from the file's
folder. Links to other files open them in the editor, and web links open in
your browser. Raw HTML in the file is sanitized, so scripts don't run.

## Find and replace in files

Press ⌘⇧F to open the **Find** view in the sidebar, or ⌘⇧R to go straight to
the replace field. If you have a single line selected in the editor, it
becomes the query.

- Toggle **Aa** for a case-sensitive search, **W** for whole words, and **.\***
  for a regular expression.
- To limit the search, list globs in the include field, such as
  `*.php, *.blade.php` or `app/**`. Files ignored by `.gitignore` are never
  searched.
- Results are grouped by file, with each match highlighted. Click a match to
  open it. Files start expanded until about 2,000 matches show; click a file
  to expand or collapse it.
- **Replace All**, or ⏎ in the replace field, replaces every match in every
  matching file after you confirm, including files beyond the listed results.
  Hover over a file for **Replace** to change only that file, or over a match
  for its replace button to change only that match. In regex mode, `$1` or
  `${name}` inserts a captured group.
- Files open in the editor change through an undoable edit, including any
  unsaved text, and are saved. Other files are rewritten on disk.

### TODO comments

Click the checklist icon in the tool window bar, or run **TODO** from ⌘⇧A, to
open the **TODO** view. It lists every `TODO`, `FIXME`, and `XXX` in the
comments of the project's files, grouped by file; the words in strings and
names don't count. Click one to open it. The list updates when
files change, and the refresh button reloads it. Files that `.gitignore`
excludes, such as `vendor`, aren't searched.

## Bookmarks

Press F3 to bookmark the current line, and F3 again to remove the bookmark. A
bookmark shows as a blue marker in the gutter and moves with its line as you
edit. You can also right-click the gutter at a line and choose **Add
Bookmark**. Press ⌘F3 to list bookmarks and jump to one. Bookmarks are saved
per project.

## Snippets

Snippets work like PhpStorm's live templates: type a snippet's prefix, choose
it from the completion list, and press Tab to move between its placeholders.

Run **Edit Snippets (Live Templates)** from ⌘⇧A to open `snippets.json`. The
first time, the file is created with two examples. It uses VS Code's snippet
format, so you can paste snippets from VS Code:

```json
{
  "Laravel route": {
    "scope": "php",
    "prefix": "rget",
    "body": ["Route::get('/${1:path}', [${2:Controller}::class, '${3:index}']);"],
    "description": "A GET route to a controller method"
  }
}
```

`scope` lists language IDs, such as `php,blade`. Leave it out to offer the
snippet in every file. Changes apply as you type in the file.

### Postfix completion

In PHP files, type a dot and a template name after an expression to wrap it, as
in PhpStorm: `$user.if` becomes `if ($user) {}`. The expression can be a
variable, a call, or a chain such as `$this->posts()->first()`.

| Template | Result |
| --- | --- |
| `.if`, `.notnull`, `.null`, `.isset` | `if (expr)`, `if (expr !== null)`, `if (expr === null)`, `if (isset(expr))` |
| `.foreach` | `foreach (expr as $item)` |
| `.return`, `.throw` | `return expr;`, `throw expr;` |
| `.var` | `$var = expr;` |
| `.not`, `.par` | `!expr`, `(expr)` |
| `.dd`, `.dump` | `dd(expr);`, `dump(expr);` |

## Compare files

With a file open, run one of these from ⌘⇧A to open the diff view:

- **Compare with Clipboard** compares the file with the clipboard's text.
- **Compare with File…** compares it with another project file that you
  choose.

The diff shows the editor's text, including unsaved changes.

## Safe delete

Press ⌘⌦ in a class, interface, trait, enum, method, or function to delete it
only if nothing uses it. The editor looks for usages with Phpactor, and also
searches the project's PHP files for the names Laravel uses: a class's full
name in strings (as in config files), and a method's name, its scope name
(`scopePublished` as `published`), or its attribute name (`getFullNameAttribute`
as `full_name`). So `->relationship('author')` counts as a use of `author()`.

- If something uses it, the palette lists the usages. Choose one to open it,
  or choose **Delete anyway**.
- If nothing does, confirm in the palette. A method or function is removed with
  its docblock and attributes (undo with ⌘Z). A class that's alone in its file
  moves the file to the Trash.

## Inline variable and change signature

Press ⌥⌘N on a variable to replace it with its value and remove the
assignment. It works when the variable is assigned once, in a statement that
starts its line (it may continue over several lines, such as a query builder
chain), and never changed afterwards, within the same function; otherwise it
says why it can't. The value gets parentheses when it's an expression, such as
`($a + $b)`.

Press ⌘F6 in a method or function to change its parameters. Edit the list, for
example to reorder, remove, or add parameters, and press ⏎. A new parameter
needs a default value. The editor finds every call, shows how many it will
change, and on **Apply** rewrites the declaration and the calls: positional
arguments move with their parameters, named arguments stay named, and a
skipped position gets the parameter's default. Methods in subclasses and
implementing classes that override it get the same parameters, and their calls
change too. Calls it can't rewrite safely,
such as ones that spread `...$args`, are listed and left unchanged.

## Type hierarchy

Press ⌃H in a PHP file to open the **Hierarchy** tab. With the cursor on a
type's name, such as `Model` in `extends Model` or a trait in `use HasFactory;`,
the tab shows that type. Otherwise, it shows the class, interface, trait, or
enum that the cursor is in.

- **Subtypes** lists the classes that extend it or implement it, including
  classes in `vendor`. For a trait, it lists the types that use it, in project
  files only. Expand one to see its own subtypes.
- **Supertypes** lists its parent class, its interfaces, and its traits.
  Expand one to go further up.

Click a type to open it. Types that Phpactor's index doesn't know are listed
without a file.

## Generate code

Press ⌘N in a PHP file, or choose **Code > Generate…**, to add code to the
class, trait, or enum at the cursor. The list offers what the class lacks:

- **Constructor**: takes and assigns each property that has no default value
  and isn't static. It's offered when the class has no constructor.
- **Getters**, **Setters**, and **Getters and Setters**: `getTitle()` and
  `setTitle()` for each property, including promoted ones, that doesn't have
  one yet. Readonly properties get no setter. Phpactor writes them.
- **`__toString()`**, with the cursor in its `return`.
- **Implement Methods…** and **Override Methods…**, from Phpactor, when the
  class has interface or abstract methods to write, or parent methods to
  override. Override asks which method.
- Phpactor's **Complete Constructor**, **Promote Constructor**, and **Add
  missing properties**, when they apply.

## Call hierarchy

Press ⌃⌥H in a PHP file to open the **Call Hierarchy** tab for the method or
function called under the cursor, or else the one the cursor is in.

- **Callers** lists the methods and functions that call it, one row per call.
  Code outside a function, such as a route file, is listed by its file. Expand
  a caller to see its own callers.
- **Callees** lists the project's and packages' methods and functions it calls.
  PHP's own functions aren't listed.

Click a caller to open the call, or a callee to open its declaration.

## HTTP client

Requests live in `.http` files in the project, in the format PhpStorm and VS
Code's REST Client read, so you commit them and your team uses them too. Click
the globe icon in the tool window bar, or run **HTTP Client** from ⌘⇧A.

### The tool window

The **HTTP Client** tool window lists every request in the project's `.http` and
`.rest` files, grouped by file, with a filter box and the selected environment
at the top.

- Click a request to edit it in the **HTTP** tab. Double-click it to open its
  file. Hover over it and click ▶ to send it.
- Right-click a request to send, rename, duplicate, delete, or stress test it.
  Right-click a file to add a request to it or run all of its requests.
- **+** adds a request to a file you choose, or to a new file in `http/`.
- The import icon imports a curl command, such as one from your browser's
  developer tools (**Copy as cURL**), a Postman collection (v2 or v2.1), an
  Insomnia export (v4), or an OpenAPI 3 or Swagger 2 document, in JSON or YAML. A
  collection becomes one file in `http/`, with each request titled by its
  folders. Postman's variables become file variables, and its auth becomes
  headers; its scripts stay as comments, since they don't run here. An OpenAPI
  document gives a request per operation, titled `[tag] summary`, with
  `{{host}}` for the server, a variable per path parameter, and a JSON body
  from the example or the schema. Environment variables go to
  `http-client.env.json` (secrets, such as tokens, to
  `http-client.private.env.json`), keeping values you already have.
  **HTTP Client: Import…** in ⌘⇧A does the same.
- The run icon runs every request in the project, file by file.
- The method icon makes requests from `php artisan route:list`: one route, all
  API routes, or every route. Each gets `{{host}}` for the app's address and a
  variable for each route parameter. A `POST`, `PUT`, or `PATCH` request's JSON
  body lists the fields its controller validates, read from the FormRequest it
  takes or its `validate()` call, with a value of the right type for each. A web
  route gets Laravel session auth, and an API route behind `auth:sanctum` a
  bearer token. When artisan fails, such as on an error while the app boots,
  the message says why.
- **History** lists the last 100 requests you sent in the project, with their
  responses, and a filter. Click one to see it again. Right-click one to send it
  again, pin it (pinned requests stay at the top and don't count toward the
  100), compare it with the response on screen, or copy it as cURL or Laravel
  code. The history file doesn't keep secrets: tokens, passwords, cookies, and
  API keys in requests, and cookie values in responses. Response bodies are kept
  as they came. **Send Again** sends a request from this session exactly as it
  went, and prepares one from an earlier session again from its file, running
  its scripts.
- **Go to Request** (⌥⇧⌘O) finds any request in the project by name. Search
  Everywhere lists requests too.

### The HTTP tab

The top bar holds the method, the URL, **Send** (⌘⏎ anywhere in the tab), a
menu, and the environment. Under the URL, you see it with its variables
replaced, and the names nothing defines. While a request runs, **Send** becomes
**Cancel** and the time it's taken counts up.

When a request uses a variable nothing defines, **Send** asks for its value
first. **Send** uses the values you type, and can save them to the environment
in the private environment file. **Send Anyway** sends `{{name}}` as written.

The request's tabs edit its text in the `.http` file, and edits in the editor
show in the tabs. Each change rewrites only the lines it touches, keeping
comments and a URL split over several lines, and saves the file.

| Tab | What you set |
| --- | --- |
| Params | The URL's query parameters |
| Headers | Headers, each of which you can turn off (it's commented out in the file) |
| Body | None, JSON (with **Format**), form fields, multipart fields and files, text, or a file (`< ./path`, or `<@ ./path` to replace variables in it) |
| Auth | A bearer token, a user and password (`Authorization: Basic user password`, encoded when sent, as in PhpStorm), or a Laravel session |
| Scripts | Checks you set up without code, and JavaScript that runs before the request and after the response, with snippets for common tests |
| Settings | Title, name for scripts, redirects, cookies, TLS verification, history, timeouts, a time budget, a proxy, a client certificate and key, the HTTP version, and a file to save the response to |

The response shows its status, time, size, and test results. Choosing a request
shows its last response from the history. The response has these tabs:

- **Body**: formatted and highlighted, or raw. HTML and images also have a
  preview. Copy it, save it, open it in an editor tab, or compare it with an
  earlier response to the same request in a diff. A JSON body has a filter:
  type a path such as `$.data[*].id` to see only what it selects. When Laravel
  answers with an exception (with `APP_DEBUG` on), the body starts with its
  class, message, and the files and lines of the stack trace, which open when
  you click them. Paths in Sail's container map to the project.
- **Headers**, including each redirect on the way.
- **Cookies** the response set, and those kept for the environment.
- **Timing**: DNS lookup, connecting, TLS, waiting, and downloading.
- **Tests**: each test's result, and what scripts logged.
- **Request**: the request as sent, as a curl command and as Laravel `Http::`
  code, each with **Copy**, or as fetch, axios, or Guzzle code, chosen in a
  menu. Secrets, such as tokens, passwords, and cookies, are hidden until you
  choose **Show secrets**. Copying, here and from menus, uses what's shown.
  **Generate…** writes a feature test for the request.
- **Logs** lists what Laravel wrote to `storage/logs/laravel.log`, or to the
  newest daily `laravel-YYYY-MM-DD.log`, while the request ran: each entry's
  level, message, and time, with its stack trace folded. Click a file and line
  to open it; paths in Sail's container map to the project. Other requests
  running at the same time can add entries too.
- **Queries** lists the SQL a request ran when you send it with **Send with
  Profiler**: how many queries and how long they took, grouped by SQL with
  duplicates and N+1 queries flagged, and each run's bindings and time.

To save a value from a JSON response for later requests, right-click it and
choose **Save as Variable…**. The request's response handler saves it with
`client.global.set`, and later requests use it as `{{name}}` right away.

The menu next to **Send** also has:

- **Send with Debugger**: starts listening for Xdebug and sends the request
  with `XDEBUG_SESSION`, so it stops at your breakpoints. The server's PHP needs
  Xdebug in debug mode, as **Start Debug Server** runs it.
- **Send with Profiler**: sends the request to the profiling server, starting
  it if needed, and opens the request's profile.
- **Copy as cURL**, **Copy as Laravel HTTP**, **Copy as fetch**, **Copy as
  axios**, and **Copy as Guzzle**.
- **Generate Feature Test…**: writes a test for the request to `tests/Feature`:
  Pest when the project uses it, or else PHPUnit. It sends the request with
  Laravel's test helpers (`postJson`, `get`, and so on) and checks the last
  response's status and, for JSON, its structure. Name the file, such as
  `NotesTest.php`; an existing file gets the test added.
- **Run All Requests in File**, **Stress Test…**, and **Monitor…**.
- **Go to Controller**: opens the controller method of the route the request
  calls, matched by method and path.
- **Open in Editor**, **Duplicate**, and **Delete**.

In the editor, each request has **▶ Send Request** and **Open in HTTP Client**
above it, and the first shows the environment and **Run All**. The editor
completes methods, headers, header values, tags, and `{{variables}}`. Hover over
a variable to see its value and where it comes from. A variable nothing defines
is underlined.

```http
@api = {{host}}/api

### Log in
POST {{api}}/login
Content-Type: application/json

{"email": "{{email}}", "password": "{{password}}"}

> {%
    client.global.set("token", response.body.token);
    client.test("Logged in", () => client.assert(response.status === 200));
%}

### My posts
# @no-redirect
GET {{api}}/posts?filter[status]=draft
Authorization: Bearer {{token}}
```

### Variables

A request's `{{name}}` comes from the first of these that defines it:

1. A value the request's own pre-request script set (`request.variables.set`).
2. A global value a script saved (`client.global.set`). Globals last until you
   clear them with **HTTP Client: Global Variables…** in ⌘⇧A.
3. A file variable: `@name = value` in the `.http` file.
4. The selected environment, from `http-client.env.json` next to the file or in
   the project root. `http-client.private.env.json` overrides it for secrets.
   **Edit Private Environments…** in the environment menu creates it and adds it
   to `.gitignore`. Values in a `$shared` environment apply to every
   environment.

Dynamic values change each time you send: `{{$uuid}}`, `{{$timestamp}}`,
`{{$isoTimestamp}}`, `{{$randomInt}}`, `{{$random.integer(1, 10)}}`,
`{{$random.float(0, 1)}}`, `{{$random.alphabetic(8)}}`,
`{{$random.alphanumeric(8)}}`, `{{$random.hexadecimal(8)}}`,
`{{$random.numeric(6)}}`, `{{$random.email}}`, and `{{$random.bool}}`.
`{{$dotenv.NAME}}` reads the project's `.env`.

```json
{ "local": { "host": "http://localhost:8000" }, "staging": { "host": "https://staging.example.com" } }
```

**Edit Environments…** in the environment menu creates `http-client.env.json`
with a `local` environment for `APP_URL` from `.env`.

To edit every environment in one table, choose **Edit Environments…** in an
environment menu, or run **HTTP Client: Edit Environments**. Private variables
go in `http-client.private.env.json`, which is added to `.gitignore`, and the
rest go in `http-client.env.json`. Names that look secret start as private.
Empty cells that other environments fill are highlighted. **Open JSON** and
**Open Private JSON** open the files.

**Detect App Address…**, in the environment menu or as **HTTP Client: Detect
App Address** in ⌘⇧A, finds where the app answers and sets it as `host` in the
selected environment: Sail's `APP_PORT`, a Herd or Valet site for the project
(https when it's secured), a PHP server such as `artisan serve`, or `APP_URL`.
A new environment file starts with the best of these.

### Scripts and tests

Scripts are JavaScript, as in PhpStorm. They run in a worker without access to
the editor, and stop after 5 seconds.

| Object | What it offers |
| --- | --- |
| `client` | `global.set/get/clear/clearAll/isEmpty`, `test(name, fn)`, `assert(condition, message)`, `log(...)` |
| `response` | `status`, `body` (parsed when it's JSON), `headers.valueOf(name)`, `headers.valuesOf(name)`, `contentType.mimeType` |
| `request` | `method`, `url`, `body`, `headers`, `variables.set/get`, `environment.get` |
| `jsonPath(value, path)` | Reads a path such as `$.data[0].id` |

`> ./script.js` and `< ./script.js` run a script from a file instead.

**Checks** at the top of the Scripts tab test the response without code: *Status
is*, *JSON path exists*, *JSON path equals*, *Header contains*, *Response time
under (ms)*, and *Body contains*. They're saved as `client.test()` calls between
`// checks:start` and `// checks:end` in the response handler, so your own code
around them stays. Scripts can read `response.time` in milliseconds.

### Tags

Put these comments above the request line:

| Tag | Effect |
| --- | --- |
| `# @name login` | A name for scripts and the tool window |
| `# @no-redirect` | Don't follow redirects |
| `# @no-cookie-jar` | Don't send or keep cookies |
| `# @no-log` | Leave it out of the history |
| `# @timeout 5` | Seconds before giving up (60 by default) |
| `# @connection-timeout 2` | Seconds to wait for the connection |
| `# @insecure` | Accept any TLS certificate. PhpStorm reads it as a comment |
| `# @laravel-session` | Sign in with Laravel's session, as **Auth** > **Laravel session** sets it. A path after it, such as `/csrf`, is where to get the XSRF token. PhpStorm reads it as a comment |
| `# @proxy http://127.0.0.1:8888` | Send through a proxy. A `"$proxy"` value in the environment applies to every request without the tag. PhpStorm reads it as a comment |
| `# @client-cert ./client.pem` | A client certificate for mutual TLS, relative to the `.http` file. PhpStorm reads it as a comment |
| `# @client-key ./client.key` | The client certificate's key. PhpStorm reads it as a comment |
| `# @http2`, `# @http1` | Use HTTP/2 or HTTP/1.1. Without them, curl asks for HTTP/2 over HTTPS and uses HTTP/1.1 otherwise. `HTTP/2` on the request line, as PhpStorm writes it, works too. PhpStorm reads the tags as comments |
| `# @budget 300` | Milliseconds the response may take. A slower response shows **Over budget** and fails in **Run All**. PhpStorm reads it as a comment |

An environment's `"$proxy"` starts with `$` so it can't clash with a variable
of your own:

```json
{ "office": { "host": "https://staging.example.com", "$proxy": "http://proxy.internal:3128" } }
```

After the body, `>> ./out.json` saves the response to a file, adding a number
when it exists, and `>>! ./out.json` replaces it.

Cookies work like a browser's: responses' cookies are kept per environment and
sent with later requests. **HTTP Client: Clear Cookies** in ⌘⇧A forgets them.

### Laravel session auth

Web routes and Sanctum's SPA authentication check a session cookie and a CSRF
token, as a browser sends them. With **Laravel session** auth, a request first
gets Laravel's `XSRF-TOKEN` cookie from `/sanctum/csrf-cookie` (or `/`) when the
environment's cookies don't have one, then sends it back as `X-XSRF-TOKEN`, with
`Origin`, `Referer`, and `Accept: application/json`. Send your login request,
such as `POST /login` with an email and password, with this auth, and the
requests after it with the same auth use the session.

### GraphQL

A `GRAPHQL` request sends a query, and optionally variables, as a JSON `POST`.
Its Body tab has a Query editor and a Variables editor. In the file, the
variables are a JSON object after a blank line:

```http
GRAPHQL {{host}}/graphql

query Posts($first: Int) { posts(first: $first) { id title } }

{"first": 10}
```

The Query editor highlights GraphQL and completes fields and arguments from the
endpoint's schema, with their types and descriptions. Hover over a field to see
its type. The first completion fetches the schema with an introspection query,
sent with the request's URL, headers, and variables, and keeps it for the
session. **Refresh Schema** fetches it again. Completion works in `GRAPHQL`
requests in the editor too.

### WebSockets

A `WEBSOCKET` request connects when you click **Connect**, and the response
side becomes a console: what you send and receive, with times and formatted
JSON, and a box to send more (⌘⏎). The file's messages, each after a line of
`===`, are sent once connected. A line of `=== wait-for-server` waits for a
message from the server before the next. Pings from Pusher and Laravel Reverb
are answered, so the connection stays open. The request's headers, such as
`Authorization`, go with the opening handshake, and `# @insecure` accepts any
TLS certificate for `wss://`.

```http
WEBSOCKET ws://localhost:8080/app/{{reverbKey}}
===
{"event": "pusher:subscribe", "data": {"channel": "posts"}}
```

### gRPC

A `GRPC` request calls a method, written as `host:port/package.Service/Method`
in JetBrains' format, with the request message as JSON. Use `grpcs://` before
the address for TLS. Headers go as metadata.

```http
GRPC localhost:50051/helloworld.Greeter/SayHello
Authorization: Bearer {{token}}

{"name": "Ada"}
```

The message types come from the server's reflection service. When the server
doesn't have one, the project's `.proto` files are compiled instead, with
imports found from the file's folder and each folder above it. There's nothing
to install: no `protoc`. The response shows as JSON, with every field, and a
server streaming method's messages as an array. For a client streaming method,
write the messages one after another. The status shows as the HTTP status gRPC
maps to, such as `404 NOT_FOUND`, with `grpc-status` and `grpc-message` among
the headers, so scripts and the runner treat a failed call as a failed request.
After the address and `/`, completion lists the server's methods.

### Running a file

**Run All Requests in File** sends each request in order, so a login request's
token reaches the requests after it. The **HTTP Runner** tab lists each result,
with its status, time, and tests. Click one to see its response.

### Running requests in CI

**Run All Requests in File**, and **HTTP Client: Run All Requests in Project**
in ⌘⇧A, show each request's status, time, and tests. **Save Report…** writes
the results as JUnit XML: a test suite per file and a test case per request. A
request fails on a status of 400 or more, no response, a failed `client.test`,
or a response over its budget, and its failure lists every test's result.

To run the same files in CI, use JetBrains' free `ijhttp` command-line client:

```sh
ijhttp --env-file http-client.env.json --env local --report http/*.http
```

`--report` writes JUnit XML to `reports/`. To run it in Docker, use the
`jetbrains/intellij-http-client` image:

```sh
docker run --rm -v "$PWD":/workdir jetbrains/intellij-http-client \
  --env-file http-client.env.json --env local --report http/*.http
```

ijhttp may not understand the tags and request types only this editor adds,
such as `# @insecure`, `# @laravel-session`, `# @budget`, and `WEBSOCKET`.
**HTTP Client: Export to OpenAPI…** writes the project's requests as an OpenAPI
3.0 document.

### Stress testing

**Stress Test…** sends one request many times at once and shows, as it runs,
requests per second, failures, the median, 95th, and 99th percentile response
times, requests completed each second, a histogram of response times, and the
status codes. Choose a number of requests or a number of seconds, and how many
run at a time (up to 500). Scripts don't run, and the environment's cookies are
sent. Only test servers you're allowed to load.

**Ramp up** steps through 1, 2, 5, 10, 20, 50, and more requests at a time, up
to the number you choose, for the seconds per step you choose. It charts
requests per second and the 95th percentile response time at each step, marking
steps with failures, so you see where the server slows down.

### Monitoring

**Monitor…** sends the request every few seconds, such as to watch an endpoint
during a deploy. The **Monitor** tab shows the last status, how often it was
up, the median, 95th percentile, and slowest response times, a chart of the
last 60 checks with failures in red, and the latest checks. Scripts don't run,
and checks stay out of the history.

## Composer

The **Composer** tool window (the package icon) lists the project's direct
dependencies, with dev dependencies marked, and checks Packagist for updates.
Switch the list to **All installed packages** to include the packages your
dependencies need, marked **indirect**.
An update shows in green when it fits the version constraint in
`composer.json`, and in yellow when it needs a new constraint.

- Click or right-click a package to update it, upgrade it to its latest version
  (which changes the constraint), remove it, or open it on Packagist. An
  indirect package can only be updated within its constraints.
- An indirect package shows the packages that require it under its name. Click
  it, then **Why Is It Installed?**, to list them with their version
  constraints. Choose one of them to see why that one is installed, up to
  `composer.json`.
- `composer audit` checks installed packages for security advisories. A package
  with one is marked **advisory**; click it to open the advisory.
- A direct dependency is marked **unused?** when no PHP file in the project
  names its namespace. It may still be used through Laravel's package
  discovery, a helper function, or configuration, so check before you remove
  it. Plugins and command-line tools, such as Pint, aren't checked.
- Click **+** to search Packagist and require a package, as a dependency or a
  dev dependency.
- Click the arrow to run `composer update` for everything.

Commands run in terminal tabs with the Composer that ships with the editor, and
the list reloads when they finish.

## Spell checking

The editor marks misspellings in comments, strings, and names with a green
wavy underline, in PHP, Blade, JavaScript, TypeScript, Vue, Markdown, and more. It
splits names such as `$userAdress` and `get_adress` into words. Press ⌥⏎ on a
misspelling to replace it with the suggestion, or to ignore the word in the
project, which adds it to `typos.toml` in the project root. Commit that file
so the rest of the team skips the word too. To turn spell checking off, clear
**Check spelling** in Settings.

## AI code completion

The editor can suggest code as you type, like GitHub Copilot, with a model
that runs on your Mac. No code leaves the machine. Suggestions appear as gray
text after the cursor: press Tab to accept one, or keep typing to ignore it. To
take only part of it, press ⌘→ for the next word, or ⌘⇧→ for the next line. While
the list of completions is open, a suggestion shows only if it agrees with the
selected item; press Escape to close the list and see it.

To turn it on, select **AI code completion** in Settings, or run
**Toggle AI Completion** from the palette. The first time, the editor
downloads the model into
`~/Library/Application Support/ly.almontasser.tusk/models/`, and the
status bar shows the progress. While it's on, the status bar shows **AI**;
click it to turn completion off.

Choose the model in **AI completion model**:

| Model | Download | Notes |
| --- | --- | --- |
| Qwen2.5-Coder 1.5B | 1.6 GB | The fastest: each suggestion takes about 0.2 s less, with about 5–8 fewer exact suggestions in 100 |
| Qwen2.5-Coder 3B | 3.3 GB | The default: the best suggestions for their speed |
| Qwen2.5-Coder 7B | 8.1 GB | The best suggestions, but slower, and needs 16 GB of memory or more |

The first start takes about 15 seconds while macOS prepares the GPU code;
later starts take a second or two. The model uses a little more memory than
its download size while completion is on (1.9 GB for the 1.5B model, 3.5 GB for 3B). Turning
completion off stops it and frees that memory. To delete a downloaded model,
remove its file from the `models` folder.

### What the model sees

Besides the code around the cursor, each suggestion draws on the rest of the
project, so the model uses your classes, methods, and columns instead of
guessing:

- **Classes used near the cursor:** the declarations, properties, and method
  signatures of up to eight of the project's classes that the code near the
  cursor refers to, found through the PSR-4 folders in `composer.json`.
- **Imported files, in JavaScript, TypeScript, and Vue:** outlines of the
  project files the script imports (relative paths, or aliases such as `@/`),
  with function bodies left out. For a Vue file, its `<script>`.
- **Types of variables:** when the code near the cursor calls methods on a
  variable or property, such as `$publisher->` after
  `$publisher = $this->factory->publisher();`, the editor asks Phpactor for its
  type and adds that class, even when the file never names it.
- **Where a Blade view gets its variables:** in `resources/views/posts/show.blade.php`,
  the code that renders `posts.show`, such as
  `return view('posts.show', compact('post'));`, with the classes and model
  columns used there. For a component, the `<x-…>` tags that use it and its
  class. So `{{ $post->` knows which model `$post` is.
- **Model columns, in Blade views:** each Eloquent model's columns used where the
  view is rendered, with their types from the database and the model's casts,
  and its relationships, written the way Laravel IDE Helper writes them. They
  update a few seconds after you save a model or a migration. PHP files don't
  get them: the code around already shows the columns, and a benchmark found
  no gain there.
- **What you worked on lately:** the code around the cursor in the last six
  places you left in other files.
- **Similar code:** the parts of the project that share the most names with the
  lines before the cursor, such as another controller that does the same thing.

For example, in a controller that uses a `PostPublisher` service,
`$this->publisher->` completes to `publishNow($post)` from that class, where
without the project the model guessed a `publish()` method that doesn't
exist.

The editor keeps the project's source files in memory for this: up to 3,000
PHP, JavaScript, TypeScript, and Vue files, leaving out `vendor`,
`node_modules`, and files that `.gitignore` excludes. Indexing 1,500 files takes
under half a second.

In a benchmark on an open-source Laravel app, the project context raised the
share of suggestions that match the hidden line exactly from 48% to 60%.
Suggestions also stop before code that's already below the cursor, instead of
repeating it, and before a line the model is unsure of. When the model is
unsure from the first line, the editor shows nothing: in the benchmark, every
suggestion hidden that way was wrong.

A suggestion usually appears about 0.4 seconds after you stop typing. When you
type again before it arrives, the editor cancels the request, so the model
moves on to the new text at once. When you
open a file or move to another part of it, the model needs up to 2 seconds to
read the new context, so the editor has it read the context as soon as you
arrive, before you type.

## Laravel features

In Laravel projects (folders with an `artisan` file), the app also runs Laravel
LSP. It adds completion, hover, go to definition, links, and diagnostics for
config keys, routes, views, translations, environment variables, middleware,
and container bindings, in PHP and Blade files. For example, ⌘-click on
`view('welcome')` opens `resources/views/welcome.blade.php`.

Translation keys in `__()`, `trans()`, `trans_choice()`, `@lang()`, and
`Lang::get()` complete from `lang/*/*.php`, `lang/*.json`, and packages'
translations. Hover shows the value in each locale with its file, and ⌘B or
⌘-click opens the line that defines it. An unknown key that looks like
`group.key` shows a warning; a key without a dot, such as `__('Welcome back')`,
doesn't, since Laravel shows the key itself when no JSON file has it. When a
project has more than 200 keys, completion lists the keys without their values.

- **Routes**, from ⌘⇧A, lists the app's routes from `php artisan route:list`.
  Search by method, path, route name, or controller, and choose a route to
  open its controller method. Routes to classes in `vendor`, such as Filament
  pages, open once Phpactor has indexed them. If `route:list` fails, it runs in
  a terminal tab so you can see the error.
- **Laravel Tinker**, from ⌘⇧A, opens `php artisan tinker` in a terminal tab.

When Sail's containers are running, both commands run in the container.

### Blade

Blade files highlight their HTML, the PHP inside `{{ }}`, `{!! !!}`,
directive arguments such as `@if (…)` and `@class([…])`, and `@php` blocks,
also inside tags and attribute values. Component tags such as
`<x-card.header>` and bound attributes such as `:title="$post->title"` are
recognized. Inside `<script>`, echoes, comments, `@json(…)` and other
directives, and `@php` blocks highlight as Blade and PHP, with the JavaScript
around them intact; inside `<style>`, echoes and comments do. Laravel LSP
completes component names after `<x-`. ⌘B on a component tag opens its view,
and for a class-based component also its class in `app/View/Components`.

Mago checks the PHP in open Blade files a second after you stop typing: echoes,
`@php` blocks, `<?php` blocks, the arguments of Laravel's directives (`@if`,
`@foreach`, `@include`, `@class`, `@props`, and the rest), and bound attributes
on component tags. It reports syntax errors, and unknown classes, functions,
methods, and constants, and wrong arguments, at their place in the view.
`@use` imports count. A view's variables come from the controller or component
that renders it, so the check doesn't report undefined variables or anything
about a variable's value. Custom directives aren't checked.

Blade files format (⌥⌘L) with the bundled `blade-formatter`, which indents
Blade, HTML, and scripts, and reads your project's `.bladeformatterrc` when it
has one. When your project's own Prettier has a Blade plugin, that runs
instead.

## Filament features

In projects that install Filament (`vendor/filament/filament`), a Filament
language server understands the strings Filament resolves against your
Eloquent models:

- **Completion.** In `::make('…')`, it suggests the model's columns and
  relationships. After a relationship and a dot, such as `'author.'`, it
  suggests the related model's columns. In `->relationship('…')`, it suggests
  relationship names. In the second argument, such as
  `->relationship('author', '…')`, it suggests the related model's columns.
- **Options and state paths.** In `->options(` or `->enum(` on a field the
  model casts to an enum, it suggests that enum, such as `PostStatus::class`.
  In `->default('…')`, it suggests the field's option values: the backed
  values of its enum (from `->options(…::class)`, `->enum(…::class)`, or the
  model's cast), or the keys of a literal `->options([...])` array. Without
  quotes, `->default(` suggests the enum's cases, such as
  `PostStatus::Published`. In `$get('…')` and `$set('…')`, it suggests the
  names of the fields in the file.
- **Go to declaration.** ⌘B on `'author'` in `->relationship('author')` or
  `'author.name'` opens the model's `author()` method.
- **Warnings.** A relationship name that the model doesn't define is
  underlined as you type.
- **Links between files.** A resource shows links to its model, pages, and
  relation managers above the class. Pages, schemas, tables, and relation
  managers link back to their resource, and a model links to its resources.

Forms and tables in a relation manager use the related model. For example,
fields in `PostsRelationManager` on `AuthorResource` complete `Post` columns.

Columns come from the database when the app can boot and connect. Otherwise
they come from the model's `$fillable`, casts, primary key, and timestamps.

## Tailwind CSS

In projects whose `package.json` lists `tailwindcss`, the Tailwind CSS language
server adds:

- Class name completion, showing each class's CSS, in Blade, PHP, HTML, CSS,
  and JavaScript files.
- The generated CSS when you hover over a class.
- Color swatches next to color classes. Click a swatch to pick a new color.
- Warnings for conflicting classes, such as `flex` with `grid`, and for invalid
  `@apply` and `@variant` use.

Classes are recognized in `class` attributes, in PHP arrays such as Filament's
`->extraAttributes(['class' => '…'])`, and in Blade's `@class([...])`. The
server reads your Tailwind setup from your CSS entry file (Tailwind 4) or
`tailwind.config.js` (Tailwind 3), and uses the project's installed
`tailwindcss` when `node_modules` exists.

## JavaScript, TypeScript, and Vue

JavaScript, TypeScript, and Vue files get a full TypeScript language server
(vtsls), with project-wide completion, hover, go to definition, find
references, rename, code actions, inlay hints, and type errors. In `.vue`
files, the Vue language server adds template and style support, and TypeScript
features work inside templates too, such as hover and completion in
`{{ … }}`.

The servers start the first time you open a JavaScript, TypeScript, or Vue
file, so PHP-only work doesn't pay for them. They use the project's own
TypeScript version when `node_modules/typescript` exists.


Vue, Svelte, and Astro files highlight their HTML, `<script lang="ts">` as
TypeScript, `<style lang="scss">` or `lang="less"` as those languages, and an
Astro file's `---` frontmatter as TypeScript. `.svelte` and `.astro` files get
their own language servers (Svelte's and Astro's), with completion, hover, go
to definition, and type errors in markup, scripts, and styles. Each starts the
first time you open one of its files. TypeScript files see the types of the
Svelte and Astro components they import.

In a project whose `package.json` lists `@angular/core`, the Angular language
server adds completion, hover, go to definition, and type errors to component
templates, both `.html` files and inline `template:` strings. It starts the
first time you open a TypeScript or HTML file, and uses the project's
TypeScript when `node_modules/typescript` exists.
## Tests and commands

In test files, a green ▶ appears in the gutter beside PHPUnit test methods
(`test*` methods, `#[Test]`, and `@test`), Pest `it()` and `test()` calls
(including those inside `describe()`), and the class, which runs every test in
the file. Click it, or right-click the gutter at that line, to run, debug, run
with coverage, or profile the test. To see **▶ Run test**, **Debug**, and
**Profile** links above each test instead, turn off **Show run buttons for
tests in the gutter** in Settings. Tests run through
`php artisan test` in Laravel projects, and through `vendor/bin/pest` or
`vendor/bin/phpunit` otherwise. To run the whole suite, run **Run All Tests**
from ⌘⇧A.

While tests run, the **Tests** tab shows progress: how many tests have run,
how many failed, and a spinner on the test in progress. A test that fails
shows at once; click it to read why and open it, while the rest keep running.
This works on every PHPUnit and Pest version. When the run ends, the tab shows the results as a tree of test classes and
files. Classes with failures start expanded.

- Click a test to see its failure message and open it at the failing line, or
  at its declaration when it passed.
- Click **Rerun failed tests** (next to **Rerun**) to run only the tests that
  failed. A test whose name contains a failed test's name doesn't run with
  them.

The terminal tab keeps the runner's full output.

### Code coverage

Run **Run All Tests with Coverage** or **Run Test at Cursor with Coverage**
from ⌘⇧A. When the run ends, the status bar shows the share of lines covered,
and the gutter marks each executable line: green if it ran, red if it didn't.
Hover over a mark to see how many times the line ran and which tests ran it.
To list those tests, put the cursor on the line and run **Show Tests Covering
Line** from ⌘⇧A; choose one to open it. Marks follow their lines as you edit
and stay until the next coverage run, or until you run **Hide Coverage**. A line
you change gets a dashed gray mark instead, since the run didn't see its new
code; undo the change and its mark comes back. ⌃R reruns with coverage too.

The **Coverage** tab in the bottom panel starts with each folder's coverage,
nested, such as `app/Models 45% · 9/20`. Click a folder to list only its
files, and click it again to list them all. Below, it lists every file with
uncovered lines, least covered first, with each file's percentage. Under each file, a row shows
a run of uncovered lines, such as `15–17`, and the code on its first line.
Click a row to open it there. The tab follows your edits: its line numbers and
code are the lines as they are now, and lines you changed count as neither
covered nor uncovered, so the summary and each file show how many changed. The
tab's buttons rerun with coverage and hide coverage.

Coverage needs PCOV or Xdebug for PHP. PHPUnit uses PCOV when it's loaded, and
the editor sets `XDEBUG_MODE=coverage` for Xdebug. Only the folders in
`phpunit.xml`'s `<source>` are measured. In Sail, the container's PHP must have
one of them, as Sail's images do when `SAIL_XDEBUG_MODE` includes `coverage`.

In Pest files, `$this` in a test is the project's test case, which Phpactor and
Mago can't see, so the editor hides their problems about `$this` on those
lines.

Press ⌃⌃ and type an Artisan command with its arguments, such as
`make:model Comment -m`. The command name is matched fuzzily, so `mk:mod`
works. To run any other command, choose the last item. Tests and commands run
in terminal tabs, and ⌃R reruns the last one.

## Git

The **Commit** tab in the sidebar lists staged changes and unstaged changes,
including new files. Click a file to see its diff. Hover over a file for
buttons to open, stage, unstage, or discard it. The message box sits at the
bottom of the view, and stays in view while a long list of changes scrolls.
Write a message and press ⌘⏎ or click **Commit**. **Commit and Push** also pushes, and sets the upstream
branch on the first push.

To stage part of a file, open its diff from **Changes** and click **Stage
Selected**:

- Click in a change (without selecting) to stage the whole change.
- Select lines to stage only those. On the right, select new or changed lines;
  on the left, select removed lines. A changed line pairs with its new version,
  so selecting the new line stages the replacement.

The rest stays unstaged. In a diff from **Staged**, the button is **Unstage
Selected**, and works the same way.

The editor marks lines that differ from the last commit in the gutter: green
for added lines, blue for changed lines, and a gray triangle where lines were
deleted. The markers update as you type. Click a marker to see the lines as
they are at HEAD in a box below the change. Its buttons move to the previous
or next change, stage the change, or roll it back. Press Esc to close it.
Right-click a changed line for **Show Change**, **Rollback Change**, and
**Stage Change**. Staging a change adds only that change to the index.
**Next Change** (⌃⌥⇧↓) and **Previous Change** (⌃⌥⇧↑) move the cursor between
changes. The line with the cursor shows who
last changed it, when, and the commit message. To show the commit, age, and
author of every line in place of line numbers, run **Annotate with Git Blame**
from ⌘⇧A. Run it again to hide them.

Press ⌘9 for the **Git Log** in the bottom panel: the commits of the current branch, or of every
branch, with branch and tag labels. Filter them by message, author, hash, or
branch name. Select a commit to see its message and changed files, and click a
file to see its diff against the previous commit. From a commit, you can copy
its hash, check it out, create a branch at it, cherry-pick it onto the current
branch, or revert it. To see the commits that changed one file, run **Show File
History**, or right-click the file in the tree and choose **Show History**. File
history follows renames.

### Local history

Each time you save a file, the editor keeps a copy of it, outside the project
and outside git. It also keeps one before another program, such as a
`git checkout`, changes a file you have open, and after another program
changes a project file you don't have open, such as a file an Artisan `make:`
command or a formatter rewrites. The first time that happens to a file, the
version git has staged is kept too, so you can go back to it. Files git
ignores, and `.env` files, aren't kept. It also keeps a version before you delete a file or
folder from the tree. To see a file's versions, run **Show Local History** from
⌘⇧A, or right-click the file in the tree. Choose a version to compare it with
the file as it is now, and click **Restore This Version** to put it back. The
current text is kept as a version first, so a restore can be undone the same
way. Versions older than 14 days are deleted, and each file keeps at most 100.
Files over 1 MB aren't kept.

To get back a deleted file, run **Local History: Deleted Files…** from ⌘⇧A,
choose the file, then a version, and click **Restore This Version**. Its folder
is recreated if needed.

### Interactive rebase

To rewrite recent commits, open a commit in the Git Log and choose
**Interactive Rebase from Here…**, or run **Interactive Rebase…** from ⌘⇧A and
choose the commit to rebase onto. The commits after it are listed, oldest
first. For each, choose **Pick**, **Reword** (and edit its message), **Edit**
(stop at it to change its files), **Squash into previous**, **Fixup** (squash
and discard its message), or **Drop**, and use the arrows to reorder them.
If the commits include merges, the merges are kept: the list also shows git's
**Label**, **Reset**, and **Merge** steps, which rebuild each merged branch and
merge it again, and they stay where they are.
**Start Rebase** runs `git rebase -i` in a terminal tab; uncommitted changes
are stashed and restored. If a commit conflicts, resolve it, then click
**Continue** in the Commit view. At an **Edit** commit, the rebase stops and
the Commit view says so: change files, stage what belongs in the commit, and
click **Continue**. The staged changes are added to that commit. To split the
commit into several instead, click **Split Commit**: the commit is undone and
its changes are left unstaged, with its message in the message box. Stage part
of them, even single lines from the diff, commit, and repeat, then click
**Continue**.

### Stash

Run **Stash Changes…** (from ⌘⇧A or the branch menu) to set your uncommitted
changes aside, optionally with a message and including new files. **Stashes…**
lists them: choose one to **Apply** it, **Pop** it (apply, then delete), **Drop**
it, or **Show Files** to see each file's diff.

### Worktrees

Run **Worktrees…** (from ⌘⇧A or the branch menu) to list the repository's
worktrees. Choose one to **Open** it in this window, or **Remove** it (the
folder is deleted, and the branch stays). To create one, type a branch name and
press ⏎: the worktree goes in a folder beside the main one, named after the
branch, such as `app-fix-login` for `fix/login`. An existing branch is checked
out; otherwise a new branch starts from HEAD. A new worktree has no `vendor` or
`node_modules`, so run `composer install` and your package manager in it.

### Merge conflicts

When a merge, rebase, cherry-pick, or revert stops for conflicts, the
**Commit** view shows a banner with **Abort**, plus **Continue** for a rebase,
cherry-pick, or revert. Conflicted files are listed under **Merge Conflicts**.
Hover over a file to keep **Yours** or **Theirs** for the whole file, or ✓ to
mark it resolved as it is.

Click a conflicted file, or run **Resolve Conflicts in Merge Tool** from ⌘⇧A,
to open the merge tool. Your version is on the left
and theirs on the right, each with the lines it changed from the common base
highlighted. The middle pane is the file itself: above each conflict, choose
**Accept Yours**, **Accept Theirs**, or **Accept Both**, or edit it directly.
Where one version has lines the others don't, the others show striped blank
space, so the lines all three share stay side by side. **Accept All Yours** and **Accept All Theirs** resolve every
remaining conflict at once, and **Mark Resolved** saves and stages the file
when no conflicts are left. The panes scroll together. The same links appear when a conflicted file is
open in a tab, and saving it with no conflicts left also marks it resolved.
For a merge, the commit message is filled in, so you can click **Commit** to
finish.

The branch name in the title bar shows commits ahead (↑) and behind (↓) the
upstream branch. Click it for a dropdown with pull, push, and fetch at the top,
then the current branch, local branches, and remote branches, most recently
committed first. Choose a branch to check it out, or type a name to create one.
The **Commit** view's header also has fetch, pull, and push buttons. Pull, push,
and fetch run in a terminal tab, so you can answer credential prompts. Running one
again reuses its tab once the last run has finished.

## Pull requests

The **Pull Requests** tab lists the repository's pull requests through the
GitHub CLI. Filter by open pull requests, ones you created, or ones waiting for
your review. Each row shows check status (✓ passed, ✗ failed, ● running) and
the review decision.

Click a pull request to see its checks, changed files, description, reviews,
and comments. Descriptions and comments render as GitHub Markdown, and their
links open in your browser. `#123` links to that issue or pull request, and
`@name` to that person's profile. Click a changed file to see its diff without
checking out the branch. A 💬 count marks files with line comments.

Line comments appear in the conversation under the file and lines they're on.
Click one to open the diff at that line. In the diff, each thread shows under
its line, with **Reply** and **Resolve** links. A resolved thread shows as one
line; click **Show** to read it or **Unresolve** to reopen it. Your own
comments, in the diff and in the conversation, have **Edit** and **Delete**
links. Deleting asks you to click **Delete** again to confirm.

To comment on code in the diff:

1. Click a line, or select several lines, on the new side or the old side.
2. Click **Comment on Line**. A comment box opens under the line.
3. Write the comment (Markdown, on as many lines as you like), then click
   **Add to Review** to keep it for your review, or **Comment Now** to post it
   at once. ⌘⏎ adds it to the review, and Escape closes the box.

**Add to Review** puts the comment in your pending review on GitHub, which only
you can see until you submit it. It's the same review as in the browser: a
review you started on GitHub shows here, and one started here shows there.
Pending comments show in the diff with a yellow edge and on the pull request's
page under **Pending review**, where you can delete them. While you have a
pending review, replies join it too, and **Comment Now** isn't offered, since
GitHub takes no comment outside the review. To submit, write an optional summary
below the conversation and click **Submit Review**, **Approve**, or **Request
Changes**. Without a pending review, **Comment** adds a comment to the
conversation, and **Request Changes** needs one.

Click **Check Out** to switch to the branch. When the current branch has a pull
request, its number and check status appear next to the branch name in the
status bar. **Merge…** asks how to merge (a merge commit, squash, or rebase)
and asks you to confirm before it merges on GitHub.

Pull requests need the GitHub CLI (`gh`), signed in with `gh auth login`.

## Debugging

The editor debugs PHP with Xdebug, which must be installed in your PHP
(`php -m` lists it). You don't need to change your `php.ini`: the editor turns
debugging on for the processes it starts.

1. Click the gutter to the left of a line number, or press ⌘F8, to set a
   breakpoint. Breakpoints are saved with the project.
2. Start a debug session in one of these ways:
   - Click **Debug** above a test, or press ⌃⇧D in a test. The test runs with
     Xdebug on.
   - Run **Start Debug Server** from ⌘⇧A. It runs `php artisan serve` with
     Xdebug on, so every page you open in the browser stops at your breakpoints.
   - For another setup, such as Herd or Valet, run **Start Listening for PHP
     Debug Connections**, then start a request with Xdebug's trigger (the
     `XDEBUG_SESSION` cookie, which browser extensions set) and
     `xdebug.mode=debug` in your PHP configuration.
3. When execution stops, the **Debug** tab in the bottom panel shows the call
   stack and variables. Click a frame to see its variables, expand objects and
   arrays, and type an expression, such as `$request->all()`, to evaluate it.
   To change a variable, double-click its value, type a PHP expression, such as
   `'text'` (with quotes), `42`, or `null`, and press Enter.
   Use F9 to resume, F8 to step over, F7 to step into, ⇧F8 to step out, and ⌘F2
   to stop.

### Breakpoint options, watches, and exceptions

Right-click the gutter at a line to add, remove, disable, or edit its
breakpoint, add a conditional breakpoint or a logpoint, remove the file's or
all breakpoints, annotate the file with Git blame, or copy the line's
reference (`path:line`) or its link on the remote, such as GitHub, at the
current commit. **Copy Remote URL** in ⌘⇧A
copies the link to the selected lines. While execution is paused, **Run to Line** resumes
and pauses at that line once. Press ⇧⌘F8 to edit the breakpoint at the cursor:

- **Condition:** pause only when a PHP expression is true, such as
  `$user->id === 5`.
- **Hit count:** pause only on a given hit: `5` (the fifth time), `>= 5`, or
  `% 3` (every third time).
- **Log message:** print a message to the Debug tab instead of pausing. Put
  expressions in braces, such as `Saving {$post->id}`.

A breakpoint with a condition or hit count shows a `?`, a log breakpoint
is an orange diamond, and a disabled breakpoint is hollow.

To watch an expression, type it in the field above the variables in the Debug
tab and press Enter. Watches are evaluated in the selected frame every time
execution pauses, expand like variables, and are saved with the project.

To pause wherever an exception is thrown, even if the code catches it, turn
on **Pause on exceptions** (the lightning icon in the Debug tab). The log
shows the exception's class and message. To narrow it, right-click the icon,
or run **Pause on Exceptions Options…** from ⌘⇧A:

- **Classes:** enter them separated by commas, such as
  `App\Exceptions\PaymentFailed`. Their subclasses count too. Leave the field
  empty to pause on every exception again. **Pause on Exception Classes…** in
  ⌘⇧A opens the same field.
- **When:** choose **Only uncaught** to skip exceptions that code catches. In a
  Laravel project, execution then pauses in Laravel's exception handler, as it
  starts to render the exception into an error page or console output, with the
  exception in `$e`; the log names its class, message, and where it was thrown.
  Elsewhere, execution pauses at PHP's fatal error for the exception, at the
  line that threw it, where the log shows PHP's stack trace but the variables
  are gone.
- **Skip exceptions thrown in:** enter path patterns relative to the project,
  such as `vendor/**`, to keep going when the exception comes from those files.

The options are saved per project.

### Docker and Sail

In a Sail project (its compose file uses Laravel Sail) whose containers are
running, tests, **Debug** on tests, Artisan commands from Run Anything,
**Routes**, and Tinker run in the container through `vendor/bin/sail`. Their
terminal tabs say "(Sail)".

Other Docker Compose setups work the same way: the editor finds the service
that mounts the project folder (preferring one named or built for PHP, such as
`app` or `php`) and runs those commands in it with `docker compose exec`, in
the folder where the project is mounted. A service that only mounts the
project without being named or built for PHP, such as a Node container for
Vite, isn't used unless you choose it. Terminal tabs name the service, such
as "Tests (app)". To pick another service, or to run on this Mac instead, run
**Choose Docker Service for Commands…** from ⌘⇧A. When the containers are
stopped, everything runs on this Mac. The database
tool connects through the port Sail forwards (`FORWARD_DB_PORT`, or
`DB_PORT`), because `DB_HOST` names a container that your Mac can't resolve.

When PHP runs in a container, its paths differ from yours, so the debugger has
to map them. For a Sail project (its `docker-compose.yml` uses Laravel Sail),
the editor maps `/var/www/html` to the project folder on its own, and for
another Compose setup, the folder where the service mounts the project. To
change it, run **Set Server Paths for Debugging…** from ⌘⇧A and enter the
project's path in the container. When other folders are mounted elsewhere, add
them after a comma as `server path=local path`, such as
`/var/www/html, /opt/shared=packages/shared`. A local path without a leading
`/` is inside the project.

Xdebug in the container must connect back to your Mac. With Sail, set
`SAIL_XDEBUG_MODE=develop,debug` in `.env` and rebuild the containers; Sail
already points Xdebug at `host.docker.internal`. With another setup, the
container's PHP needs Xdebug installed; **Debug** on a test sets
`XDEBUG_MODE=debug` and points it at `host.docker.internal`.

## Profiling

The editor runs Xdebug's profiler and shows the result in the **Profiler** tab
of the bottom panel. Run these from ⌘⇧A:

- **Profile Test at Cursor**, or the **Profile** link above a test, runs the
  test with the profiler and opens its profile when the run ends.
- **Profile URL…** asks for a path, such as `/posts?page=2`, requests it
  through the profiling server (starting the server if needed), and opens that
  request's profile. The status bar shows the response code and time.
- While the profiling server runs, pages you open in a browser, where you can
  sign in, are profiled too. They're listed in **Open Xdebug Profile…** by
  their URL.
- **Start Profiling Server (PHP's server with the Xdebug profiler)** serves the
  app at `http://127.0.0.1:8000`, as `php artisan serve` does, or on the next
  free port if 8000 is taken. Each request writes a profile.
- **Open Xdebug Profile…** lists profiles from the editor's runs and from
  Xdebug's own `xdebug.output_dir`, newest first. The editor's profiles are
  named by what they profiled, such as `GET /admin/login (200)` or a test.
  **Choose File…** opens any other `cachegrind.out` file, compressed or not.

The Profiler tab lists every function with its calls, its own time, its total
time (which includes the functions it called), and its memory. Both times also
show as a share of the whole run, and a line under the own time shows that
share at a glance. Recursive functions count their nested calls once. Memory is
how much memory in use grew over the function's calls, as Xdebug measures it:
memory freed before a call returns doesn't count.

Click **Call tree** to see each function under the function that called it,
with its calls and time on that path. The tree opens along the busiest path,
and → and ← open and close a node.

Click **Flame graph** to see the same tree as bars: each function's bar sits
under its caller's and is as wide as its time there, busiest first. Blue bars
are your code, yellow are `vendor`, and gray are PHP's own functions. Hover
over a bar for its time and calls, click it to zoom in (the bars above it stay,
and clicking one zooms back out), press Escape to zoom out one level, and
double-click to open the function. Type in the filter to highlight matching
functions. When you zoom in, the side pane lists the functions with the most
own time inside the zoomed bar: where that part of the run is slow.

In a Laravel app, profiled runs also record the database queries. Click
**Queries**, or the **Database** total, to list them: queries with the same SQL
are grouped, slowest first, and a group opens to each run with its bindings
and time. Two flags point at common problems:

- **Duplicate**: the same SQL with the same bindings ran more than once, so
  its result could be reused.
- **Repeated**: the same SQL ran three or more times with different bindings,
  often once per item in a loop (an N+1 query), which eager loading such as
  `with('author')` can replace with one query.

Select a query to see its full SQL, copy it with its bindings in place for a
database console, or jump to the code that ran queries.

Type in the filter while the call tree shows to find a function's back trace:
the matching functions are listed first, each opening to the functions that
called it, and the busiest chain of callers of the first match opens at once.

With **Times in editor** on, open files show how long the calls on each line
took, at the end of the line, such as `199 ms · 74.6%`. A function's
declaration shows its total time and how often it ran, such as
`⏱ 334 ms · 89.1% · 1 call`. Lines over 10% of the
run are orange, and over 1% yellow. Hover over a time to see how many calls it
covers. Lines under a thousandth of the run are left out.

- Above the table, totals show where the time went: **Database** (queries and
  their time), **Autoloading** (classes loaded), **Views** (views rendered),
  and **HTTP calls** and **Redis** when the run used them. Click one to select
  its function and see what called it, such as the code that ran each query.
- Click a column header to sort by it, and type in the filter to find
  functions.
- Select **Project code only** to hide `vendor` packages and PHP's own
  functions. The choice is remembered.
- Click a function to see, beside the table, the functions that called it and
  the functions it called, each with the number of calls and their time. Click
  one there to move to it.
- Double-click a function, or press ⏎, to open it. ↑ and ↓ move through the
  list.
- To see what a change did, click the compare button and choose the profile
  from before it. The table shows each function's change in own and total
  time, slowest first, in red when slower and green when faster, and the row
  above it shows the change in the whole run. Click **Stop comparing** to go
  back.
- The folder button opens another profile, and the reveal button shows the
  profile's file in Finder. Drag the side pane's edge to resize it.

Profiling needs Xdebug. The editor sets `XDEBUG_MODE=profile` and
`XDEBUG_TRIGGER`, so it works whether your `php.ini` starts Xdebug always or on
a trigger. Profiles from the editor go to the app's cache folder, which keeps
the newest 50. Profiling doesn't run in Sail's containers.

To record queries, the editor also turns on Xdebug's tracing, limited to
Laravel's database connection, through a small PHP file that runs before the
app. It's added with PHP's `PHP_INI_SCAN_DIR`, keeping PHP's own settings
folders, and takes the place of any `auto_prepend_file` your settings have
during profiled runs.

## Database

The **Database** tool window (the cylinder icon) connects to the database in
your project's `.env`, as Laravel does: `DB_CONNECTION`, `DB_HOST`, `DB_PORT`,
`DB_DATABASE`, `DB_USERNAME`, and `DB_PASSWORD`, with Laravel's defaults for
anything missing. SQLite, MySQL, MariaDB, and PostgreSQL work without
installing a client, because the drivers are built into the app.

To use another database, click the connection line under the tool window's
title, or run **Database: Switch Connection…** from ⌘⇧A. The list shows `.env`'s
connection, the ones you saved, and the other connections in the app's
`config/database.php`, such as a read replica. **Add Connection…** asks for a
URL, such as `mysql://forge:secret@203.0.113.5:3306/laravel`,
`pgsql://user@host/app?sslmode=require`, or `sqlite:database/other.sqlite`,
and then a name. Saved connections are kept per project; their passwords are
kept in your Mac's Keychain. Select a saved connection to see **Edit** and
**Remove** in the list. When you edit one, leave the password out of the URL to
keep the saved password.

TLS follows the same `.env` settings as Laravel's `config/database.php`:
`DB_SSLMODE` (`disable`, `prefer`, `require`, `verify-ca`, or `verify-full`,
as in PostgreSQL; PostgreSQL defaults to `prefer`), and `MYSQL_ATTR_SSL_CA` or
`DB_SSLROOTCERT` for the certificate authority. `require` encrypts without
checking the server's certificate, and `verify-full` checks it and the host
name.

To reach a database on a server, run **Database: Connect over SSH…** from ⌘⇧A
and type the SSH destination, such as `forge@203.0.113.5`,
`ssh://user@host:2222`, or a host from `~/.ssh/config`. The editor opens a
tunnel with your Mac's `ssh`, using your keys or SSH agent (it can't ask for a
password), and `DB_HOST` and `DB_PORT` are then as the server sees them, such
as `127.0.0.1:3306`. Leave the destination empty to connect directly again.
Each connection keeps its own SSH destination.

- Click a table to see its columns. A `?` after a type marks a nullable column.
- Double-click a table to show its rows, 1,000 at a time. Click **Next** and
  **Previous** to page through a table or a query's results; the summary shows
  which rows you see, and how many there are. Pages don't change while you
  have pending changes.
- Double-click a cell to edit it, and press Enter to keep the change, or
  Escape to cancel. Type `NULL` for a null value. Tables without a primary key are read-only.
- To add a row, click **Add Row**, fill in the values, and press Enter. Leave a
  value empty to use the column's default.
- To delete rows, click a row's number to select it (⌘-click to select
  several), and click **Delete Rows**.
- Changes wait, marked in the grid (yellow for edited cells, green for new
  rows, and struck through for deleted ones), until you click **Submit** or
  press ⌘⏎. They apply together, in one transaction: if one fails, none do.
  Hover over **Submit** to see the SQL. **Revert** drops them.
- Press ⌘⇧F10 (**Open Query Console**) to open the project's console, then
  press ⌘⏎ to run the statement under the caret, or the selection. ⌘⏎ also runs
  SQL in any `.sql` file.
- SQL completion suggests your tables and columns. After `name.`, it suggests
  the columns of that table, or of the table that `name` is an alias for.

Results show in the **Database** tab of the bottom panel. After you change
`.env`, click **Refresh** in the tool window.

## Diagnostics and formatting

The **Problems** panel (⌘6, or click the error and warning counts in the
status bar) lists errors and warnings across the whole project, grouped by
file; click one to go to it. The **Errors** and **Warnings** buttons, which show
their counts, turn each kind on and off, and the panel remembers your choice.
**Current File** lists only the file in the editor, and the filter box keeps
problems whose message, rule, or path contains every word you type. Files with
errors come first, each with its error and warning counts. The problem under the
cursor is selected in the panel. In the panel, ↑ and ↓ move the selection, ← and
→ collapse and expand a file, Enter opens the problem, and ⌘C copies it as
`path:line:column severity rule message`. Right-click a problem to copy it or
its message, or to show its details.
A file with errors shows its name in red with a wavy underline in the file
tree and on its tab, and the folders that contain it show their names in red.
The Problems button in the activity bar shows the error count.

JSON config files are checked against their schemas, with completion and
hovers from them too: `composer.json`, `package.json`, `tsconfig.json` (and
`tsconfig.*.json`), `jsconfig.json`, `.eslintrc.json`, `.prettierrc.json`,
`.babelrc.json`, and `babel.config.json`. The schemas ship with the editor, so
this works offline. A file whose `$schema` names one of these schemas' URLs
gets the bundled copy, and a file whose `$schema` is a path, such as
`"./config.schema.json"`, is checked against that file. Other URLs aren't
downloaded.

Deprecated methods, classes, and functions show struck through, and unused
imports faded, as in VS Code. Hovers lay out long signatures with one parameter per line.

Press F2 or ⇧F2 to go to the next or previous problem in the file, with its
message in a panel below the line. **Next Problem in Files** and **Previous
Problem in Files** in ⌘⇧A, or F8 and ⇧F8 while you aren't debugging, move on to
other files. In the Dark and Light themes, squiggles use the interface's red,
yellow, and blue.

Pointing at a problem in the editor shows it with code formatted as code, and
the checker's notes as paragraphs, and the checker and rule below it, such as
`mago-lint(no-redundant-use)`. Rows in the Problems panel show the same label
and the line and column. **Show Details** in that popup, or the button at the
end of a row in the Problems panel, shows the problem on a page of its own: the
whole message, with long types such as array shapes laid out one key per line,
the code around the problem, and **Go to Code**. The page opens as an editor
tab, and Escape closes it. For a Mago lint problem, the page
also shows Mago's explanation of the rule under **About this rule**.

To see the cursor line's worst problem at the end of the line, as the Error Lens
extension does, turn on **Show the cursor line's problem at the end of the
line** in Settings, or run **Toggle Inline Problems** from ⌘⇧A. Long messages
are cut short, and `+2` counts the line's other problems. The message hides
while you type and comes back when you pause.

The first time you open the Problems panel, it scans the project:
Mago checks every file in a few seconds, and then Phpactor's own checks, such
as deprecated classes and unused imports, run file by file in the background
(a few minutes for about 1,000 files, using half the cores). Phpactor's results
are cached by each file's contents for the first scan after the project opens.
**Scan Project** rechecks every file, since a change in one file can change
another's problems. Open files show their live problems as you type; after a fix, a
problem can stay for up to 4 seconds while the checks run again. Mago's notes
and help show in the editor only, not in the panel. The status bar counts cover
the project once it has been scanned. Laravel LSP's and Tailwind's problems
show for open files only.

When `composer.lock` changes, for example after `composer require`, the editor
rebuilds Phpactor's index, so new packages' classes and functions are found.
This also happens when you open a project whose `composer.lock` changed while
the editor was closed. To do it yourself, run **Reindex Project** from ⌘⇧A.
PHP files that other programs create or change, such as `php artisan make:model`
or a `git checkout`, are indexed a few seconds later.

**Formatting** (⌥⌘L) uses your project's own tools:

1. **Prettier**, for every file its configuration can parse: the project's own
   when it has one in `node_modules`, and otherwise the bundled Prettier, which
   formats JavaScript, TypeScript, CSS, SCSS, Less, JSON, HTML, Markdown, YAML,
   Vue, Svelte, and Astro. With `@prettier/plugin-php` or a Blade plugin in
   the project, the project's Prettier formats PHP and Blade files too.
2. **Laravel Pint**, for PHP files Prettier doesn't handle, when the project has
   `vendor/bin/pint`.
3. **Mago**, the bundled fallback for PHP.

Prettier, including the bundled one, and Pint read the project's own
configuration files, and Prettier follows `.editorconfig`.

Mago checks PHP files as you type (static analysis and lint).
If your project has a `mago.toml` file, Mago uses it. Otherwise the app uses
defaults tuned for Laravel, in `src-tauri/resources/mago.toml`: the analyzer
reads the project and `vendor` but skips hidden folders, `node_modules`, and
`storage`, rules that flag normal Laravel code (`strict-types`,
`literal-named-argument`, and `prefer-first-class-callable`, since Filament
fills closure parameters by name) are off, rules about code size and
complexity (such as `cyclomatic-complexity` and `too-many-methods`) and style
show as warnings rather than errors, and tests, factories, and seeders may
set literal passwords. Mago checks against the lowest PHP version your
`composer.json` allows. Mago's analyzer doesn't know Laravel's
magic, such as Eloquent attributes and relationships (`$post->author`),
forwarded calls (`Post::create()`), or request input (`$request->email`). The
editor reads your models' columns, relationships, accessors, and scopes, and
hides those reports, and the ones they cause further on, when Laravel really
has the member; anything left shows as a hint (dots you can hover), not as a
problem. Laravel's root aliases, such as `use DB;`, resolve too: the editor
writes stubs for them that Phpactor and Mago read. It also gives Mago corrected
copies of the Laravel and Pest files whose types are wider than what your code
gets back, as Larastan does: `__()` returns a string, `auth()->user()` your
user model, a test's `$this` your test case, and `shouldReceive()` takes
arguments. Problems Mago can't prove, such as a value that may be null, show
as warnings; using a value of unknown type shows as a hint.

⌥⏎ on a Mago problem offers Mago's own fix, such as removing an unused import,
and **Fix All Safe Mago Problems in File**. A fix that may change what the
code does says so in its title. **Fix All Safe Problems in File** in ⌘⇧A
applies the safe fixes without the menu. **Suppress *rule* for this line**
adds a `// @mago-expect lint:rule` comment (`analysis:` for the analyzer)
above the line, or adds the rule to one already there. Mago reports the
comment once the problem is gone, and its fix removes the comment.

## Test app

`scripts/make-fixture.sh` creates `fixtures/demo`, a Laravel 12 app with
Filament 4, an `Author` model, a `Post` model with a `PostStatus` enum cast, a Filament resource for posts,
and Pest with one Pest test file next to Laravel's PHPUnit examples.
Use it to try navigation and refactoring by hand. The `fixtures` folder isn't
committed.

```sh
./scripts/make-fixture.sh
```

## Website

`website/` is the static site for [tusk.almontasser.ly](https://tusk.almontasser.ly):
one `index.html` with inline CSS, the screenshots in `website/img/`, and a
`CNAME` file for GitHub Pages. It has no build step; serve the folder as it is.

The waitlist form posts each email as JSON to a Formspree form. Before you
publish, create a form at [formspree.io](https://formspree.io) and set
`WAITLIST_ENDPOINT` near the end of `index.html` to its endpoint.

The screenshots come from the dev app with `fixtures/demo` open, taken at
1400 × 900 through the Tauri MCP bridge, cropped, and saved as WebP with
`cwebp -q 88`.

## Project layout

| Path | Contents |
| --- | --- |
| `src/main.ts` | Layout, file tree, tabs, save, and keyboard shortcuts |
| `src/editor.ts` | Monaco setup, web workers, and the Blade, Vue, Svelte, and Astro grammars |
| `src/lsp.ts` | Language Server Protocol client and Monaco providers |
| `src/diagnostics.ts` | Filters false problems out of the servers' diagnostics, and reads Mago's report |
| `src/problems.ts` | Problems panel: the project's errors and warnings |
| `src/terminal.ts` | Terminal panel |
| `src/git.ts` | Commit view, diff view, partial staging, branches, and stash |
| `src/history.ts` | Git log, file history, and commit actions |
| `src/conflicts.ts` | Inline merge conflict resolution |
| `src/merge.ts` | The three-pane merge tool |
| `src/rebase.ts` | Interactive rebase |
| `src/gitparse.ts` | Parsers for git output, line diffs, partial staging, merge alignment, and rebase todo lists |
| `src/prs.ts` | Pull requests through the GitHub CLI |
| `src/runner.ts` | Test runner, run links, Run Anything, routes, and Tinker |
| `src/testresults.ts` | The Tests tab: live progress and the results tree |
| `src/junit.ts` | Reads JUnit reports, PHPUnit's event stream, and Clover coverage reports, and builds rerun filters |
| `src/coverage.ts` | Code coverage marks in the gutter and the Coverage tab |
| `src/profiler.ts` | Profiling runs, the profile list, and the Profiler tab |
| `src/cachegrind.ts` | Xdebug's profiles as the Profiler tab uses them, and the queries from its traces |
| `src/phptests.ts` | Finds PHPUnit and Pest tests in a file |
| `src/sail.ts` | Runs commands in Laravel Sail or a Docker Compose service when its containers are up |
| `src/files.ts` | File operations and the tree's context menu |
| `src/psr4.ts` | Namespaces from `composer.json` for new PHP files |
| `src/search.ts` | The Find view: find and replace in files, and TODO comments |
| `src/bookmarks.ts` | Bookmarks |
| `src/snippets.ts` | Your snippets from `snippets.json` |
| `src/format.ts` | Formatting with the project's Prettier or Pint, or Mago |
| `src/markdownpreview.ts` | The Markdown preview tab |
| `src/markdown.ts` | Renders Markdown for the preview, and its scroll position |
| `src/links.ts` | Resolves paths files name relative to their folder: Markdown links and `$schema` |
| `src/jsonschemas.ts` | Checks JSON config files against the bundled schemas in `src/schemas` |
| `src/localhistory.ts` | Local history of saved, changed, and deleted files |
| `src/retention.ts` | Which local history versions to delete |
| `src/editorconfig.ts` | Reads `.editorconfig` files |
| `src/settings.ts` | Settings, the settings dialog, and the color theme picker and import |
| `src/debug.ts` | The Xdebug debugger: breakpoints and their options, watches, stepping, and the Debug panel |
| `src/debugexceptions.ts` | Where an exception was thrown, the class of an uncaught one, and where Laravel renders them, for pausing on exceptions |
| `src/database.ts` | The Database tool window, query console, and results grid |
| `src/dbconfig.ts` | Database connections from `.env`, URLs, and `config/database.php`, schema queries, and cell updates |
| `src/composer.ts` | The Composer tool window |
| `src/composerdata.ts` | Joins `composer show` and `composer outdated` output |
| `src/httpclient.ts` | The HTTP client's sending, variables, cookies, history, and `http` language |
| `src/httpview.ts` | The HTTP Client tool window and the HTTP tab |
| `src/httpload.ts` | The HTTP client's runner and stress test |
| `src/httpscript.worker.ts` | Runs `.http` request scripts |
| `src/httpfile.ts` | Reads and writes `.http` files, builds curl arguments, converts requests, and hides secrets |
| `src/httpimport.ts` | Postman, Insomnia, and OpenAPI import, OpenAPI export, and JUnit reports |
| `src/httpteam.ts` | The HTTP client's import and export commands |
| `src/httplaravel.ts` | The HTTP client's Laravel tools: logs, queries, feature tests, and the app's address |
| `src/laraveltools.ts` | Feature test generation, Laravel log parsing, and app address detection |
| `src/httpchecks.ts` | Checks without code, and Save as Variable |
| `src/httpenv.ts` | The environment table editor |
| `src/graphqlschema.ts` | Reads GraphQL schemas and finds the type at the cursor |
| `src/graphqleditor.ts` | GraphQL schema completion and hovers |
| `src/hierarchy.ts` | The type hierarchy view |
| `src/safedelete.ts` | Safe Delete |
| `src/refactor.ts` | Inline Variable and Change Signature |
| `src/refactorparse.ts` | Argument, parameter, and assignment parsing for the refactorings |
| `src/phptypes.ts` | Reads PHP declarations, Laravel's names for methods and components, and route actions |
| `src/icons.ts` | File and folder icons |
| `src/themes.ts` | The color theme list, imported themes, and applying a theme |
| `src/colortheme.ts` | Converts VS Code, TextMate, and Monaco themes for the editor, interface, and terminal |
| `src/menu.ts` | The menu bar, built from the actions |
| `src/palette.ts` | The picker used by search and actions, and fuzzy matching |
| `src-tauri/src/lib.rs` | Tauri setup and command registration |
| `src-tauri/src/fs.rs` | File system commands and the file watcher |
| `src-tauri/src/lsp.rs` | Starts the language servers and relays their messages |
| `src-tauri/src/tools.rs` | Tool paths and running commands |
| `src-tauri/src/search.rs` | Project file listing, text search, and replace |
| `src-tauri/src/db.rs` | Database queries for SQLite, MySQL, MariaDB, and PostgreSQL |
| `src-tauri/src/pty.rs` | Pseudo-terminals for the terminal panel |
| `src-tauri/src/ws.rs` | WebSocket connections for the HTTP client |
| `src-tauri/src/grpc.rs` | gRPC calls for the HTTP client, with schemas from server reflection or the project's `.proto` files |
| `src-tauri/src/profile.rs` | Reads Xdebug's Cachegrind profiles |
| `src-tauri/resources/mago.toml` | Default Mago configuration |
| `filament-lsp/server.php` | Filament language server |
| `filament-lsp/introspect.php` | Reads resources and models from the project |
| `filament-lsp/tests.php` | Filament server tests |
| `node-tools/` | The pinned Node language servers (`package.json` and lockfile) |
| `scripts/fetch-tools.sh` | Downloads the pinned language tools, one folder per tool |
| `scripts/fetch-schemas.ts` | Downloads the JSON schemas in `src/schemas` |
| `scripts/publish-tools.ts` | Publishes the tools the app downloads |
| `scripts/make-fixture.sh` | Creates the test app |
| `docs/architecture.md` | Architecture and decision log |
| `website/` | The Tusk website |
