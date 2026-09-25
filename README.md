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
| TODO comments | The search stops at 20,000 matches, counted before those outside comments are dropped. |
| Test detection | `src/phptests.ts` reads tests with regexes over the code outside comments, so a test declared inside a heredoc string still gets a run link. |
| Blade | PHP inside Blade isn't checked for errors: a view's variables come from its controller, so a checker would report most of them as undefined. Directives inside `<style>` aren't highlighted, since CSS has at-rules of its own. |
| First indexing | Phpactor indexes a new project once, which takes minutes for a full Laravel app. Progress shows in the status bar. Hidden folders, `node_modules`, `storage`, and `bootstrap/cache` are skipped. |
| Mago analysis | Mago has no server mode, so it parses the project again for each check: about 2 seconds of wall time, and several seconds of CPU, on a project with 27,000 PHP files. It runs 1 second after you stop typing. |
| Unsaved files | Phpactor, Laravel LSP, Tailwind, and the Filament server accept only whole-file syncs, so each gets the full text after every 150 ms pause in typing (`track` in `src/lsp.ts`). |
| Filament | The Filament server knows field names, relationships, options, and resource structure. It doesn't check column names (virtual attributes make that unreliable). `$get()` and `$set()` suggest every field name in the file, not only those in the same form, and don't resolve `../` paths. Options from a closure or a query aren't suggested. |
| Database | The editor connects to the connection in `.env` only. SSH tunnels need key or agent authentication, and `verify-full` fails through a tunnel, since the host is then `127.0.0.1`. Results stop at 1,000 rows. Running another query drops pending changes. |
| Pull requests | Comments on lines outside the diff's changes are rejected by GitHub. Pending comments saved on this Mac by an earlier build aren't moved to GitHub. Resolve state loads for the first 100 threads. You can't edit a review's summary. |
| Split editors | Up to four panes. |
| Platform | macOS only. AI completion on Intel Macs runs on the CPU, since llama.cpp's Intel build has no Metal support. |

### Missing

| Area | Gap |
| --- | --- |
| Session restore | Terminals come back without their earlier output. The debug and profiling servers aren't restarted. |
| Settings | `.editorconfig`'s `end_of_line = cr` (old Mac line endings) isn't supported, and without a `charset`, a file that isn't valid UTF-8 doesn't open. Double-tap shortcuts (⇧⇧, ⌃⌃) can't be reassigned. |
| Debugger | Pause on exceptions filters by class, not by where the exception is thrown or whether it's caught. |
| Frontend languages | Angular templates aren't supported. |
| Git | Interactive rebase can't rebase merge commits, or split a commit into several at an edit stop. |
| Local history | A closed file's text before its first change by another program is kept only if git has it staged. One burst of changes by other programs keeps at most 200 closed files, so a branch switch that rewrites more keeps only some. Deleting a folder keeps its first 500 files, leaving out ignored ones such as `vendor`. |
| Refactoring | Phpactor provides rename, extract method, extract constant, generate methods, and import class through ⌥⏎. Moving a file moves its class. Change Signature finds overriding methods only in project files, not `vendor`, and misses a class whose `extends` or `implements` list is split over several lines. Neither it nor Safe Delete sees calls made through dynamic names, such as `$this->$method()`. Inline Variable works within one function. |
| Tools | Spell checking flags known misspellings, not every word missing from a dictionary, so rare typos can slip through. AI completion reads the classes PHP and Blade files use, and the project files JavaScript, TypeScript, and Vue files import, but not the types of packages in `node_modules`. It indexes at most 3,000 files. The HTTP client has no response history, no `< file` bodies or multipart uploads, and no scripts. |
| Coverage | The Coverage tab shows the code as it was when you opened the tab, even after you edit the file. Which tests ran a line comes from PHPUnit's XML coverage, which only records lines of the folders in `phpunit.xml`'s `<source>`. |
| Profiler | Requests you make in a browser are named by URL from the profile's file name, where Xdebug turns `/`, `.`, `?`, and `&` into `_`, so a query string reads as more path. The table shows up to 500 functions at a time; filter to find the rest. Profiling runs on this Mac, not in Sail. |
| Deployment | There's no remote deployment or sync over SFTP or FTP. |
| Code signing | The app isn't signed or notarized, so on another Mac, Gatekeeper blocks it until you allow it in **System Settings > Privacy & Security**. Signing needs an Apple Developer account. |
| Updates | There's no auto-update. Each new version is a new DMG to install. |

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

The app bundles its tools (Phpactor, Laravel LSP, Mago, Composer, `typos-lsp`,
the Xdebug adapter, `llama-server` for AI completion, and the Tailwind CSS, TypeScript, and Vue language
servers), and compiles in the database drivers, so you don't install them
yourself. Sail support needs Docker, which Sail itself needs. If your project has PHPStan or Larastan in
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

The tools are then fetched for both chips and joined into universal binaries.
The bundle is written to `src-tauri/target/universal-apple-darwin/release/bundle/`.

## The window

- **Title bar:** the project name (click it to switch to a recent project or open
  a folder), the current branch and its pull request, a **Search everywhere**
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

To change a shortcut, run **Keymap…** from ⌘⇧A (or click **Keymap…** in
Settings), choose the action, and press the new shortcut. Backspace removes the
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
| ⌘N | New file in the selected folder |
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

Press ⌘, to open **Settings**. Changes apply immediately and are saved in
`~/Library/Application Support/dev.almontasser.phpeditor/settings.json`.

| Setting | Default |
| --- | --- |
| Theme: one of about 110 color themes, or match the system | Dark |
| Dark and light themes for Match the system | Dark, Light |
| Editor font and font size | JetBrains Mono (or its Nerd Font build), or else Menlo, at 13; ligatures are on only with a font that has them |
| Wrap long lines | Off |
| Show the minimap | Off |
| Show inlay hints | On |
| Save files automatically | On |
| Format files when saving | Off |
| Check spelling | On |
| AI code completion, and its model | Off, Qwen2.5-Coder 3B |

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
file's line endings when you save it; ⌘Z undoes the conversion. Without
`.editorconfig`, the editor detects indentation from each file's content,
keeps each file's line endings, and reads files as UTF-8. Changes to
`.editorconfig` apply to open files at once.

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

Files save automatically, as in PhpStorm: when you switch tabs, close a tab, or
switch to another app. ⌘S saves every changed file. If you turn automatic saving
off, closing a changed tab asks whether to save it.

The app reopens the last folder when it starts, with the tabs you had open in
it. Each tab keeps its cursor, selection, scroll position, and folded code, both
when you switch tabs and when you reopen the project. Expanded folders in the
tree and the sidebar view come back too. Shells reopen in the folder you last
`cd`'d to. Servers and watchers you started from Run Anything, such as `npm run dev`,
`php artisan serve`, `queue:work`, or `sail up`, and Tinker, run again if they
were still running when you closed the project. Other commands, tests, git
commands, and the debug and profiling servers don't run again. Opening another
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
edit. Press ⌘F3 to list bookmarks and jump to one. Bookmarks are saved per
project.

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

## HTTP client

Write requests in a `.http` file, as in PhpStorm, and click **▶ Send Request**
above one, or press ⌘⏎ in it. The response opens in the **HTTP** tab: status,
time, headers, and the body, with JSON formatted.

```http
### Create a post
POST {{host}}/api/posts
Content-Type: application/json
Authorization: Bearer {{token}}

{"title": "Hello"}

### List posts
GET {{host}}/api/posts
    ?page=2
```

Variables such as `{{host}}` come from `http-client.env.json` next to the
`.http` file or in the project root, with one set of values per environment.
Put secrets in `http-client.private.env.json`, which overrides the shared file,
and don't commit it. The first environment is used until you run **Select HTTP
Environment…** from ⌘⇧A.

```json
{ "local": { "host": "http://localhost:8000" }, "staging": { "host": "https://staging.example.com" } }
```

## Composer

The **Composer** tool window (the package icon) lists the project's direct
dependencies, with dev dependencies marked, and checks Packagist for updates.
Switch the list to **All installed packages** to include the packages your
dependencies need, marked **indirect**.
An update shows in green when it fits the version constraint in
`composer.json`, and in yellow when it needs a new constraint.

- Click a package to update it, upgrade it to its latest version (which
  changes the constraint), remove it, or open it on Packagist. An indirect
  package can only be updated within its constraints.
- Click a package, then **Why Is It Installed?**, to list the packages that
  require it, with their version constraints. Choose one of them to see why
  that one is installed, up to `composer.json`.
- Click **+** to search Packagist and require a package, as a dependency or a
  dev dependency.
- Click the arrow to run `composer update` for everything.

Commands run in terminal tabs with the Composer that ships with the editor, and
the list reloads when they finish.

## Spell checking

The editor marks misspellings in comments, strings, and names with a blue
underline, in PHP, Blade, JavaScript, TypeScript, Vue, Markdown, and more. It
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
`~/Library/Application Support/dev.almontasser.phpeditor/models/`, and the
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
## Tests and commands

In test files, **▶ Run test** and **▶ Run all tests in file** links appear above
PHPUnit test methods (`test*` methods, `#[Test]`, and `@test`) and Pest `it()`
and `test()` calls, including those inside `describe()`. Tests run through
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
and stay until the next coverage run, or until you run **Hide Coverage**. ⌃R
reruns with coverage too.

The **Coverage** tab in the bottom panel starts with each folder's coverage,
nested, such as `app/Models 45% · 9/20`. Click a folder to list only its
files, and click it again to list them all. Below, it lists every file with
uncovered lines, least covered first, with each file's percentage. Under each file, a row shows
a run of uncovered lines, such as `15–17`, and the code on its first line.
Click a row to open it there. The tab's buttons rerun with coverage and hide
coverage.

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
buttons to open, stage, unstage, or discard it. Write a message and press ⌘⏎
or click **Commit**. **Commit and Push** also pushes, and sets the upstream
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
deleted. The markers update as you type. The line with the cursor shows who
last changed it, when, and the commit message. To show the commit, age, and
author of every line in place of line numbers, run **Annotate with Git Blame**
from ⌘⇧A. Run it again to hide them.

Press ⌘9 for the **Git Log**: the commits of the current branch, or of every
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
**Start Rebase** runs `git rebase -i` in a terminal tab; uncommitted changes
are stashed and restored. If a commit conflicts, resolve it, then click
**Continue** in the Commit view. At an **Edit** commit, the rebase stops and
the Commit view says so: change files, stage what belongs in the commit, and
click **Continue**. The staged changes are added to that commit.

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

The branch name in the status bar shows commits ahead (↑) and behind (↓) the
upstream branch. Click it to check out a local or remote branch, create a
branch from the name you type, or pull, push, and fetch. Pull, push, and fetch
run in a terminal tab, so you can answer credential prompts.

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

Right-click the gutter at a line, or press ⇧⌘F8, to edit its breakpoint:

- **Condition:** pause only when a PHP expression is true, such as
  `$user->id === 5`.
- **Hit count:** pause only on a given hit: `5` (the fifth time), `>= 5`, or
  `% 3` (every third time).
- **Log message:** print a message to the Debug tab instead of pausing. Put
  expressions in braces, such as `Saving {$post->id}`.

A breakpoint with a condition or hit count shows a `?`, and a log breakpoint
is an orange diamond.

To watch an expression, type it in the field above the variables in the Debug
tab and press Enter. Watches are evaluated in the selected frame every time
execution pauses, expand like variables, and are saved with the project.

To pause wherever an exception is thrown, even if the code catches it, turn
on **Pause on exceptions** (the lightning icon in the Debug tab). The log
shows the exception's class and message. To pause only on some classes,
right-click the icon, or run **Pause on Exception Classes…** from ⌘⇧A, and
enter them separated by commas, such as `App\Exceptions\PaymentFailed`. Their
subclasses count too. Leave the field empty to pause on every exception again.
The classes are saved per project.

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

- Click a table to see its columns. A `?` after a type marks a nullable column.
- Double-click a table to show its first 500 rows. Double-click a cell to
  edit it, and press Enter to keep the change, or Escape to cancel. Type
  `NULL` for a null value. Tables without a primary key are read-only.
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
the code around the problem, and **Go to Code**. Escape closes the page and
brings back the view it covered, such as a diff. The first time you open it, it scans the project:
Mago checks every file in a few seconds, and then Phpactor's own checks, such
as deprecated classes and unused imports, run file by file in the background
(a few minutes for about 1,000 files, using half the cores). Phpactor's results
are cached by each file's contents, so **Scan Project** later rechecks only
what changed. Open files show their live problems as you type; after a fix, a problem can stay for up to 4 seconds while the checks run again. Mago's notes and help show in the editor only, not in the panel. The status bar
counts cover the project once it has been scanned. Laravel LSP's and Tailwind's
problems show for open files only.

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
| `src/cachegrind.ts` | Reads Xdebug's Cachegrind profiles |
| `src/phptests.ts` | Finds PHPUnit and Pest tests in a file |
| `src/sail.ts` | Runs commands in Laravel Sail or a Docker Compose service when its containers are up |
| `src/files.ts` | File operations and the tree's context menu |
| `src/psr4.ts` | Namespaces from `composer.json` for new PHP files |
| `src/search.ts` | The Find view: find and replace in files, and TODO comments |
| `src/bookmarks.ts` | Bookmarks |
| `src/snippets.ts` | Your snippets from `snippets.json` |
| `src/format.ts` | Formatting with the project's Prettier or Pint, or Mago |
| `src/localhistory.ts` | Local history of saved, changed, and deleted files |
| `src/retention.ts` | Which local history versions to delete |
| `src/editorconfig.ts` | Reads `.editorconfig` files |
| `src/settings.ts` | Settings, the settings dialog, and the color theme picker and import |
| `src/debug.ts` | The Xdebug debugger: breakpoints and their options, watches, stepping, and the Debug panel |
| `src/database.ts` | The Database tool window, query console, and results grid |
| `src/dbconfig.ts` | Database connection from `.env`, schema queries, and cell updates |
| `src/composer.ts` | The Composer tool window |
| `src/composerdata.ts` | Joins `composer show` and `composer outdated` output |
| `src/httpclient.ts` | The HTTP client for `.http` files |
| `src/httpfile.ts` | Reads `.http` files and curl's output |
| `src/hierarchy.ts` | The type hierarchy view |
| `src/safedelete.ts` | Safe Delete |
| `src/refactor.ts` | Inline Variable and Change Signature |
| `src/refactorparse.ts` | Argument, parameter, and assignment parsing for the refactorings |
| `src/phptypes.ts` | Reads PHP declarations, Laravel's names for methods and components, and route actions |
| `src/icons.ts` | File and folder icons |
| `src/themes.ts` | The color theme list, imported themes, and applying a theme |
| `src/colortheme.ts` | Converts VS Code, TextMate, and Monaco themes for the editor, interface, and terminal |
| `src/palette.ts` | The picker used by search and actions, and fuzzy matching |
| `src-tauri/src/lib.rs` | Tauri setup and command registration |
| `src-tauri/src/fs.rs` | File system commands and the file watcher |
| `src-tauri/src/lsp.rs` | Starts the language servers and relays their messages |
| `src-tauri/src/tools.rs` | Tool paths and running commands |
| `src-tauri/src/search.rs` | Project file listing, text search, and replace |
| `src-tauri/src/db.rs` | Database queries for SQLite, MySQL, MariaDB, and PostgreSQL |
| `src-tauri/src/pty.rs` | Pseudo-terminals for the terminal panel |
| `src-tauri/resources/mago.toml` | Default Mago configuration |
| `filament-lsp/server.php` | Filament language server |
| `filament-lsp/introspect.php` | Reads resources and models from the project |
| `filament-lsp/tests.php` | Filament server tests |
| `node-tools/` | The pinned Node language servers (`package.json` and lockfile) |
| `scripts/fetch-tools.sh` | Downloads the pinned language tools |
| `scripts/make-fixture.sh` | Creates the test app |
| `docs/architecture.md` | Architecture and decision log |
