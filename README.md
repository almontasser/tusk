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

## Known gaps

These PhpStorm features are missing or limited. Where it helps, a gap names the
file to change when you add it.

### Limited

| Area | Gap |
| --- | --- |
| Type hierarchy | Phpactor can provide it, but Monaco has no view for it. It needs its own panel. |
| Find in files | Results stop at 2,000 matches, and Replace All changes only the files in those results. There's no replace for a single match. |
| Go to file | Files ignored by `.gitignore`, such as `vendor`, aren't listed. Go to class still finds `vendor` classes. |
| Test results | Tests print to a terminal tab. There's no tree of passed and failed tests (it would parse JUnit output in `src/runner.ts`). |
| Test detection | Line-based patterns in `src/phptests.ts` miss declarations split across lines. |
| Blade | Blade rules color HTML text only, not tags or attributes. PHP inside Blade gets no Phpactor diagnostics. |
| Formatting | Formatting runs only when you ask (⌥⌘L), not on save. Without Prettier, only PHP files format. |
| First indexing | Phpactor indexes a new project once, which takes minutes for a full Laravel app. Progress shows in the status bar. Hidden folders, `node_modules`, `storage`, and `bootstrap/cache` are skipped. |
| Mago analysis | Mago has no server mode, so it parses the project again for each check: about 2 seconds of wall time, and several seconds of CPU, on a project with 27,000 PHP files. It runs 1 second after you stop typing. |
| Unsaved files | Language servers sync the full text on every change, which may lag on very large files (`track` in `src/lsp.ts`). |
| Filament | The Filament server knows field names, relationships, and resource structure. It doesn't check column names (virtual attributes make that unreliable), suggest enum or option values, or understand custom `->state()` paths. |
| Pull requests | You can read pull requests but not comment, approve, or merge from the editor. Descriptions and comments show as plain text, not rendered Markdown (`src/prs.ts`). |
| Platform | macOS only, and a build contains Mago for the build machine's architecture only (not a universal binary). |

### Missing

| Area | Gap |
| --- | --- |
| Session restore | Terminal tabs and the terminal panel aren't restored. |
| Split editors | Two panes at most, side by side, sharing one tab bar. The split isn't restored when the project reopens. |
| Settings | Shortcuts can't be customized, and `.editorconfig` isn't read (the editor detects each file's indentation). |
| Debugger | Breakpoints have no conditions or hit counts, and there's no option to pause on exceptions. Projects in Docker or Sail need path mappings, which aren't supported yet. |
| Database | There's no database browser or query console. |
| Frontend languages | Svelte, Astro, and Angular templates have no language server. Vue files use HTML highlighting, so `<script lang="ts">` is colored as JavaScript. |
| Git | There's no interactive rebase or line-by-line staging. Conflicts resolve inline, not in a three-pane merge tool. |
| Local history | There's no history of saved versions outside git. |
| Refactoring | Phpactor provides rename, extract method, extract constant, generate methods, and import class through ⌥⏎. Move class, change signature, inline, and safe delete aren't available. |
| Tools | There's no HTTP client, Composer UI, Docker or Sail support, or spell checking. |
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

The app bundles its language tools (Phpactor, Laravel LSP, Mago, and the
Tailwind CSS, TypeScript, and Vue language servers), so you don't install them
yourself. If your project has PHPStan or Larastan in
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
php -d zend.assertions=1 filament-lsp/tests.php fixtures/demo   # Filament server, needs the test app
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
| ⌘⇧R | Replace in files |
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
| ⌥⌘L | Reformat the file with the project's formatter |
| ⌘N | New file in the selected folder |
| ⇧⌘C | Copy the path of the selected or active file |
| ⌥F12 | Show or hide the terminal |
| ⌃⌃ | Run anything: Artisan commands or shell commands |
| ⌃⇧R | Run the test at the cursor, or all tests in the file |
| ⌃R | Rerun the last test or command |
| ⌃⇧D | Debug the test at the cursor |
| ⌘F8 | Toggle a breakpoint on the current line |
| F9 | Resume (while debugging) |
| F8, F7, ⇧F8 | Step over, step into, step out |
| ⌘F2 | Stop debugging |
| ⌘K | Commit |
| ⌘⇧K | Push |
| ⌘T | Update the project (`git pull`) |
| ⌘1 | Show the project tree |
| ⌘\ | Split the editor, or move to the other pane |
| ⌘9 | Git log |
| ⌘S | Save all files |
| ⌘, | Settings |
| ⌘W | Close the tab |
| ⌃Space | Show completions |

To open a folder, click **Open Folder…** in the sidebar or run the **Open
Folder…** action. ## Settings

Press ⌘, to open **Settings**. Changes apply immediately and are saved in
`~/Library/Application Support/dev.almontasser.phpeditor/settings.json`.

| Setting | Default |
| --- | --- |
| Theme: dark, light, or match the system | Dark |
| Editor font and font size | JetBrains Mono, SF Mono, or Menlo at 13 |
| Wrap long lines | Off |
| Show the minimap | Off |
| Show inlay hints | On |
| Save files automatically | On |
| Format files when saving | Off |

Press ⌘\ to split the editor: the current file opens in a second pane on the
right. Clicking a tab opens it in the focused pane, and a tab shown in the other
pane is underlined in gray. Press ⌘\ again to move between panes, and run
**Unsplit** to close the focused pane.

Files save automatically, as in PhpStorm: when you switch tabs, close a tab, or
switch to another app. ⌘S saves every changed file. If you turn automatic saving
off, closing a changed tab asks whether to save it.

The app reopens the last folder when it starts, with the tabs you had open in
it. Each tab keeps its cursor, selection, scroll position, and folded code, both
when you switch tabs and when you reopen the project. Expanded folders in the
tree and the sidebar view come back too. If a project has a
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
  open it.
- **Replace All**, or ⏎ in the replace field, replaces every listed match after
  you confirm. Hover over a file for **Replace** to change only that file. In
  regex mode, `$1` or `${name}` inserts a captured group.
- Files open in the editor change through an undoable edit, including any
  unsaved text, and are saved. Other files are rewritten on disk.

## Laravel features

In Laravel projects (folders with an `artisan` file), the app also runs Laravel
LSP. It adds completion, hover, go to definition, links, and diagnostics for
config keys, routes, views, translations, environment variables, middleware,
and container bindings, in PHP and Blade files. For example, ⌘-click on
`view('welcome')` opens `resources/views/welcome.blade.php`.

## Filament features

In projects that install Filament (`vendor/filament/filament`), a Filament
language server understands the strings Filament resolves against your
Eloquent models:

- **Completion.** In `::make('…')`, it suggests the model's columns and
  relationships. After a relationship and a dot, such as `'author.'`, it
  suggests the related model's columns. In `->relationship('…')`, it suggests
  relationship names. In the second argument, such as
  `->relationship('author', '…')`, it suggests the related model's columns.
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

## Tests and commands

In test files, **▶ Run test** and **▶ Run all tests in file** links appear above
PHPUnit test methods (`test*` methods, `#[Test]`, and `@test`) and Pest `it()`
and `test()` calls. Tests run through `php artisan test` in Laravel projects,
and through `vendor/bin/pest` or `vendor/bin/phpunit` otherwise.

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

### Stash

Run **Stash Changes…** (from ⌘⇧A or the branch menu) to set your uncommitted
changes aside, optionally with a message and including new files. **Stashes…**
lists them: choose one to **Apply** it, **Pop** it (apply, then delete), **Drop**
it, or **Show Files** to see each file's diff.

### Merge conflicts

When a merge, rebase, cherry-pick, or revert stops for conflicts, the
**Commit** view shows a banner with **Abort**, plus **Continue** for a rebase,
cherry-pick, or revert. Conflicted files are listed under **Merge Conflicts**.
Hover over a file to keep **Yours** or **Theirs** for the whole file, or ✓ to
mark it resolved as it is.

Click a conflicted file to resolve it in the editor. Above each conflict,
choose **Accept Current**, **Accept Incoming**, or **Accept Both**. Your side is
shaded green, and the incoming side blue. When you save the file with no
conflicts left, it's marked as resolved. For a merge, the commit message is
filled in, so you can click **Commit** to finish.

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
and comments. Click a changed file to see its diff without checking out the
branch. Click **Check Out** to switch to the branch. When the current branch
has a pull request, its number and check status appear next to the branch name
in the status bar.

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
   Use F9 to resume, F8 to step over, F7 to step into, ⇧F8 to step out, and ⌘F2
   to stop.

## Diagnostics and formatting

**Formatting** (⌥⌘L) uses your project's own tools:

1. **Prettier**, when the project has it in `node_modules`, for every file its
   configuration can parse. With `@prettier/plugin-php` or a Blade plugin, that
   includes PHP and Blade files.
2. **Laravel Pint**, for PHP files Prettier doesn't handle, when the project has
   `vendor/bin/pint`.
3. **Mago**, the bundled fallback for PHP.

Prettier and Pint read the project's own configuration files.

Mago checks PHP files as you type (static analysis and lint).
If your project has a `mago.toml` file, Mago uses it. Otherwise the app uses
defaults tuned for Laravel, in `src-tauri/resources/mago.toml`: the analyzer
reads the project and `vendor` but skips hidden folders, `node_modules`, and
`storage`, and two rules that flag normal Laravel code on nearly every file
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
| `src/git.ts` | Commit view, diff view, and branches |
| `src/history.ts` | Git log, file history, and commit actions |
| `src/conflicts.ts` | Inline merge conflict resolution |
| `src/gitparse.ts` | Parsers for git output, line diffs, and check summaries |
| `src/prs.ts` | Pull requests through the GitHub CLI |
| `src/runner.ts` | Test runner, run links, and Run Anything |
| `src/phptests.ts` | Finds PHPUnit and Pest tests in a file |
| `src/files.ts` | File operations and the tree's context menu |
| `src/psr4.ts` | Namespaces from `composer.json` for new PHP files |
| `src/search.ts` | The Find view: find and replace in files |
| `src/settings.ts` | Settings, the settings dialog, and the theme |
| `src/debug.ts` | The Xdebug debugger: breakpoints, stepping, and the Debug panel |
| `src/palette.ts` | The picker used by search and actions, and fuzzy matching |
| `src-tauri/src/lib.rs` | Tauri setup and command registration |
| `src-tauri/src/fs.rs` | File system commands and the file watcher |
| `src-tauri/src/lsp.rs` | Starts the language servers and relays their messages |
| `src-tauri/src/tools.rs` | Tool paths and Mago formatting |
| `src-tauri/src/search.rs` | Project file listing and text search |
| `src-tauri/src/pty.rs` | Pseudo-terminals for the terminal panel |
| `src-tauri/resources/mago.toml` | Default Mago configuration |
| `filament-lsp/server.php` | Filament language server |
| `filament-lsp/introspect.php` | Reads resources and models from the project |
| `filament-lsp/tests.php` | Filament server tests |
| `node-tools/` | The pinned Node language servers (`package.json` and lockfile) |
| `scripts/fetch-tools.sh` | Downloads the pinned language tools |
| `scripts/make-fixture.sh` | Creates the test app |
| `docs/architecture.md` | Architecture and decision log |
