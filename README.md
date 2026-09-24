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
| Type hierarchy | It shows the type that the current file declares, not the type under the cursor. Traits aren't shown. A file declaring several types shows the first. |
| Find in files | Results stop at 2,000 matches, and Replace All changes only the files in those results. There's no replace for a single match. |
| Go to file | Files ignored by `.gitignore`, such as `vendor`, aren't listed. Go to class still finds `vendor` classes. |
| Test results | While tests run, the tree can't open tests yet (PHPUnit's event stream has no file paths); that works once the run ends. Projects on PHPUnit 9 or earlier see results only at the end. Test lines without a failure come from the patterns in `src/phptests.ts`. Rerun Failed matches names as patterns, so it can also run other tests whose names contain a failed one's. |
| Test detection | Line-based patterns in `src/phptests.ts` miss declarations split across lines. |
| Blade | PHP inside Blade isn't checked for errors: a view's variables come from its controller, so a checker would report most of them as undefined. Blade inside `<script>` blocks isn't highlighted as PHP. |
| Formatting | Formatting runs only when you ask (⌥⌘L), not on save. Without Prettier, only PHP files format. |
| First indexing | Phpactor indexes a new project once, which takes minutes for a full Laravel app. Progress shows in the status bar. Hidden folders, `node_modules`, `storage`, and `bootstrap/cache` are skipped. |
| Mago analysis | Mago has no server mode, so it parses the project again for each check: about 2 seconds of wall time, and several seconds of CPU, on a project with 27,000 PHP files. It runs 1 second after you stop typing. |
| Unsaved files | Language servers sync the full text on every change, which may lag on very large files (`track` in `src/lsp.ts`). |
| Filament | The Filament server knows field names, relationships, and resource structure. It doesn't check column names (virtual attributes make that unreliable), suggest enum or option values, or understand custom `->state()` paths. |
| Database | The editor connects to the connection in `.env` only, without SSH tunnels or TLS. Results stop at 1,000 rows. You can edit cells of a table's data, but not add or delete rows. |
| Pull requests | There are no comments on specific lines of the diff, and GitHub references such as `#123` and `@name` aren't links (`src/prs.ts`). |
| Platform | macOS only, and a build contains Mago for the build machine's architecture only (not a universal binary). |

### Missing

| Area | Gap |
| --- | --- |
| Session restore | Terminal tabs and the terminal panel aren't restored. |
| Split editors | Two panes at most, side by side, sharing one tab bar. The split isn't restored when the project reopens. |
| Settings | `.editorconfig`'s `end_of_line` and `charset` aren't applied; files keep their own line endings and are read as UTF-8. Double-tap shortcuts (⇧⇧, ⌃⌃) can't be reassigned. |
| Debugger | Pause on exceptions stops on every exception, with no filter by class. A path mapping covers the project folder only. You can't change a variable's value while paused. |
| Frontend languages | Svelte, Astro, and Angular templates have no language server. Vue files use HTML highlighting, so `<script lang="ts">` is colored as JavaScript. |
| Git | There's no interactive rebase. Partial staging works per change block, not per single line within a block. Conflicts resolve inline, not in a three-pane merge tool. |
| Local history | Versions are kept on save only, not before external changes such as `git checkout`, and there's no history of deleted files (they go to the Trash). |
| Refactoring | Phpactor provides rename, extract method, extract constant, generate methods, and import class through ⌥⏎. Moving a file moves its class. Change signature and inline aren't available. Safe Delete can't see calls made through dynamic names, such as `$this->$method()`. |
| Tools | Spell checking flags known misspellings, not every word missing from a dictionary, so rare typos can slip through. The Composer window lists direct dependencies only, and doesn't explain why a package is installed (`composer why`). Docker setups other than Sail run commands on this Mac. The HTTP client has no response history, no `< file` bodies or multipart uploads, and no scripts. |
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
cargo test --manifest-path src-tauri/Cargo.toml db -- --ignored   # MySQL and PostgreSQL, needs the servers in src-tauri/src/db.rs
php -d zend.assertions=1 filament-lsp/tests.php fixtures/demo   # Filament server, needs the test app
```

## Build a release

```sh
pnpm tauri build
```

The `.app` bundle and the `.dmg` file are written to
`src-tauri/target/release/bundle/`.

## The window

- **Title bar:** the project name (click it to switch to a recent project or open
  a folder), the current branch and its pull request, a **Search everywhere**
  box, and buttons for the debug server, the terminal, and settings.
- **Tool bar on the left:** icons for the **Project**, **Commit**, **Pull
  Requests**, and **Find** views. Click the active icon to hide the sidebar,
  and drag the sidebar's edge to resize it. The icons at the bottom open the
  **Git Log**, the **Debug** panel, and the terminal.
- **Status bar:** error and warning counts for open files (click them to list
  the problems), background work such as indexing, the cursor position,
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
| ⌘⇧O | Go to file |
| ⌥⌘O | Go to symbol in the project |
| ⌘E | Recent files |
| ⌘⇧F | Find in files |
| ⌘⇧R | Replace in files |
| ⌃H | Type hierarchy of the current file's class |
| ⌘⌦ | Safe delete the class, method, or function at the cursor |
| ⌘⇧F10 | Open the query console |
| ⌘⏎ | Run the SQL statement under the caret |
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
| ⇧⌘F8 | Edit the breakpoint on the current line: condition, hit count, or log message |
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
Folder…** action.

## Settings

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
| Check spelling | On |

### EditorConfig

If the project has `.editorconfig` files, the editor follows them:
`indent_style`, `indent_size`, and `tab_width` set each file's indentation (the
status bar shows it), and saving applies `trim_trailing_whitespace` and
`insert_final_newline`. Without one, the editor detects indentation from each
file's content. Changes to `.editorconfig` apply to open files at once.

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

## Type hierarchy

Press ⌃H in a PHP file to open the **Hierarchy** tab for the class,
interface, trait, or enum that the file declares.

- **Subtypes** lists the classes that extend it or implement it, including
  classes in `vendor`. Expand one to see its own subtypes.
- **Supertypes** lists its parent class and its interfaces. Expand one to go
  further up.

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
An update shows in green when it fits the version constraint in
`composer.json`, and in yellow when it needs a new constraint.

- Click a package to update it, upgrade it to its latest version (which
  changes the constraint), remove it, or open it on Packagist.
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

## Laravel features

In Laravel projects (folders with an `artisan` file), the app also runs Laravel
LSP. It adds completion, hover, go to definition, links, and diagnostics for
config keys, routes, views, translations, environment variables, middleware,
and container bindings, in PHP and Blade files. For example, ⌘-click on
`view('welcome')` opens `resources/views/welcome.blade.php`.

### Blade

Blade files highlight their HTML, the PHP inside `{{ }}`, `{!! !!}`,
directive arguments such as `@if (…)` and `@class([…])`, and `@php` blocks,
also inside tags and attribute values. Component tags such as
`<x-card.header>` and bound attributes such as `:title="$post->title"` are
recognized. Laravel LSP completes component names after `<x-`. ⌘B on a
component tag opens its view, and for a class-based component also its class
in `app/View/Components`.

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
and `test()` calls, including those inside `describe()`. Tests run through
`php artisan test` in Laravel projects, and through `vendor/bin/pest` or
`vendor/bin/phpunit` otherwise. To run the whole suite, run **Run All Tests**
from ⌘⇧A.

While tests run, the **Tests** tab shows progress: how many tests have run,
how many failed, and a spinner on the test in progress. When the run ends, it
shows the results as a tree of test classes and files. Classes with failures start expanded.

- Click a test to see its failure message and open it at the failing line, or
  at its declaration when it passed.
- Click **Rerun failed tests** (next to **Rerun**) to run only the tests that
  failed.

The terminal tab keeps the runner's full output.

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

To stage part of a file, open its diff from **Changes**, select lines in the
changes you want (or click in one), and click **Stage Selected**. Every change
block that the selection touches is staged, and the rest stay unstaged. In a
diff from **Staged**, the button is **Unstage Selected**.

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
and outside git. To see a file's versions, run **Show Local History** from
⌘⇧A, or right-click the file in the tree. Choose a version to compare it with
the file as it is now, and click **Restore This Version** to put it back. The
current text is kept as a version first, so a restore can be undone the same
way. Versions older than 14 days are deleted, and each file keeps at most 100.
Files over 1 MB aren't kept.

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
and comments. Descriptions and comments render as GitHub Markdown, and their
links open in your browser. Click a changed file to see its diff without checking out the
branch. Click **Check Out** to switch to the branch. When the current branch
has a pull request, its number and check status appear next to the branch name
in the status bar.

Below the conversation, write a comment and click **Comment**, **Approve**, or
**Request Changes** (which needs a comment). **Merge…** asks how to merge (a
merge commit, squash, or rebase) and asks you to confirm before it merges on
GitHub.

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
shows the exception's class and message.

### Docker and Sail

In a Sail project (its compose file uses Laravel Sail) whose containers are
running, tests, **Debug** on tests, and Artisan commands from Run Anything run
in the container through `vendor/bin/sail`. Their terminal tabs say "(Sail)".
When the containers are stopped, everything runs on this Mac. The database
tool connects through the port Sail forwards (`FORWARD_DB_PORT`, or
`DB_PORT`), because `DB_HOST` names a container that your Mac can't resolve.

When PHP runs in a container, its paths differ from yours, so the debugger has
to map them. For a Sail project (its `docker-compose.yml` uses Laravel Sail),
the editor maps `/var/www/html` to the project folder on its own. For another
setup, run **Set Server Path for Debugging…** from ⌘⇧A and enter the project's
path in the container.

Xdebug in the container must connect back to your Mac. With Sail, set
`SAIL_XDEBUG_MODE=develop,debug` in `.env` and rebuild the containers; Sail
already points Xdebug at `host.docker.internal`.

## Database

The **Database** tool window (the cylinder icon) connects to the database in
your project's `.env`, as Laravel does: `DB_CONNECTION`, `DB_HOST`, `DB_PORT`,
`DB_DATABASE`, `DB_USERNAME`, and `DB_PASSWORD`, with Laravel's defaults for
anything missing. SQLite, MySQL, MariaDB, and PostgreSQL work without
installing a client, because the drivers are built into the app.

- Click a table to see its columns. A `?` after a type marks a nullable column.
- Double-click a table to show its first 500 rows. Double-click a cell to
  edit it, and press Enter to save the change to the database, or Escape to
  cancel. Type `NULL` for a null value. Tables without a primary key are
  read-only.
- Press ⌘⇧F10 (**Open Query Console**) to open the project's console, then
  press ⌘⏎ to run the statement under the caret, or the selection. ⌘⏎ also runs
  SQL in any `.sql` file.
- SQL completion suggests your tables and columns. After `name.`, it suggests
  the columns of that table, or of the table that `name` is an alias for.

Results show in the **Database** tab of the bottom panel. After you change
`.env`, click **Refresh** in the tool window.

## Diagnostics and formatting

When `composer.lock` changes, for example after `composer require`, the editor
rebuilds Phpactor's index, so new packages' classes and functions are found.
This also happens when you open a project whose `composer.lock` changed while
the editor was closed. To do it yourself, run **Reindex Project** from ⌘⇧A.

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
Filament 4, an `Author` model, a `Post` model, a Filament resource for posts,
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
| `src/icons.ts` | File and folder icons |
| `src/themes.ts` | Monaco color themes |
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
