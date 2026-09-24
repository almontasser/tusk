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
| Find in files | Plain text only. There's no regex option, and case sensitivity is automatic: the search is case-sensitive only when the query has a capital letter (`search_text` in `src-tauri/src/search.rs` already accepts both options; `findInFiles` in `src/main.ts` needs toggles). |
| Go to file | Files ignored by `.gitignore`, such as `vendor`, aren't listed. Go to class still finds `vendor` classes. |
| Test results | Tests print to a terminal tab. There's no tree of passed and failed tests (it would parse JUnit output in `src/runner.ts`). |
| Test detection | Line-based patterns in `src/phptests.ts` miss declarations split across lines. |
| Blade | Blade rules color HTML text only, not tags or attributes. PHP inside Blade gets no Phpactor diagnostics. |
| Formatting | Only PHP files format (through Mago). |
| First indexing | Phpactor indexes a new project once, which takes minutes for a full Laravel app. Progress shows in the status bar. Hidden folders, `node_modules`, `storage`, and `bootstrap/cache` are skipped. |
| Mago analysis | Mago has no server mode, so it parses the project again for each check: about 2 seconds of wall time, and several seconds of CPU, on a project with 27,000 PHP files. It runs 1 second after you stop typing. |
| Unsaved files | Language servers sync the full text on every change, which may lag on very large files (`track` in `src/lsp.ts`). |
| Filament | The Filament server knows field names, relationships, and resource structure. It doesn't check column names (virtual attributes make that unreliable), suggest enum or option values, or understand custom `->state()` paths. |
| Pull requests | You can read pull requests but not comment, approve, or merge from the editor. Descriptions and comments show as plain text, not rendered Markdown (`src/prs.ts`). |
| Git history | There's no log or history view of past commits yet. |
| Platform | macOS only, and a build contains Mago for the build machine's architecture only (not a universal binary). |

### Missing

| Area | Gap |
| --- | --- |
| Session restore | Open tabs, cursor positions, and the panel layout aren't restored. Only the last folder is. |
| Split editors | There's one editor pane. Only the diff view shows two files side by side. |
| Replace in files | Find in files can't replace. |
| Saving | There's no **Save All** and no auto-save. |
| Settings | Font, font size, theme, and shortcuts are fixed in the code. There's no settings screen and no light theme. |
| Debugger | There's no Xdebug integration or step debugging. |
| Database | There's no database browser or query console. |
| Frontend languages | JavaScript, TypeScript, Vue, Tailwind, and CSS get only Monaco's built-in support, with no language server. |
| Git | There's no stash, rebase, cherry-pick, merge conflict resolution, or line-by-line staging. |
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

To build the app, you also need:

- Rust 1.97 or later
- Node.js 24 or later, and pnpm

The app bundles its language tools (Phpactor, Laravel LSP, and Mago), so you
don't install them yourself. If your project has PHPStan or Larastan in
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
| ⌥⌘L | Reformat the file with Mago |
| ⌥F12 | Show or hide the terminal |
| ⌃⌃ | Run anything: Artisan commands or shell commands |
| ⌃⇧R | Run the test at the cursor, or all tests in the file |
| ⌃R | Rerun the last test or command |
| ⌘K | Commit |
| ⌘⇧K | Push |
| ⌘T | Update the project (`git pull`) |
| ⌘1 | Show the project tree |
| ⌘S | Save |
| ⌘W | Close the tab |
| ⌃Space | Show completions |

To open a folder, click **Open Folder…** in the sidebar or run the **Open
Folder…** action. The app reopens the last folder when it starts. If a project has a
`.phpactor.json` file, Phpactor asks whether to trust it, because the file can
run code. After you choose **Yes**, the language servers restart and load it. Refactorings such as rename
save every file they change.

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

## Diagnostics and formatting

Mago checks PHP files as you type (static analysis and lint) and formats them.
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
| `src/gitparse.ts` | Parsers for git output, line diffs, and check summaries |
| `src/prs.ts` | Pull requests through the GitHub CLI |
| `src/runner.ts` | Test runner, run links, and Run Anything |
| `src/phptests.ts` | Finds PHPUnit and Pest tests in a file |
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
| `scripts/fetch-tools.sh` | Downloads the pinned language tools |
| `scripts/make-fixture.sh` | Creates the test app |
| `docs/architecture.md` | Architecture and decision log |
