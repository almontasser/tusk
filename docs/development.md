# Development

To build Tusk, you need Rust 1.97 or later, Node.js 24 or later, and pnpm, besides
what [Getting started](getting-started.md) lists for using it.

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
sh scripts/deploy-test-servers.sh <folder>   # Local SFTP, FTP, and FTPS servers for the next line
TUSK_DEPLOY_TEST=<folder> cargo test --manifest-path src-tauri/Cargo.toml --lib deploy -- --ignored   # Deployment against them
cargo test --manifest-path tusk-lsp/Cargo.toml   # The PHP language server
cargo test --manifest-path tusk-lsp/Cargo.toml -- --ignored   # Against Filament's demo app and a real Laravel app
cargo run --manifest-path tusk-lsp/Cargo.toml --release --example stress <project>   # Every request on every file, whole and cut off
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

To build the Windows installer on a Mac, install cargo-xwin, NSIS, and LLVM
once, then cross-build it:

```sh
cargo install cargo-xwin && brew install nsis llvm
rustup target add x86_64-pc-windows-msvc
pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
```

The Linux AppImage and `.deb` build in Docker on Ubuntu 22.04
(`scripts/linux/Dockerfile`); `scripts/release.sh` shows the command. On a
Linux computer, `pnpm tauri build` builds them directly.

### Publish new tools

To upgrade a language tool, change its URL and checksum in
`scripts/fetch-tools.sh` (or its version in `node-tools/package.json`), then
run:

```sh
node scripts/publish-tools.ts
```

The script fetches the tools for each system and chip, packs each tool whose files
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

The script sets the version, builds the universal Mac app, the Windows
installer, and the Linux AppImage and `.deb` (in Docker, emulating x64, which
takes the longest), signs the update files with the private key from the `tusk-signing-key` note in Bitwarden
(through `bwnote` from your `~/.zshrc`, which unlocks the vault with Touch ID
if it's locked), writes `latest.json`, commits and tags the version, and creates the
GitHub release with `gh`. The files are uploaded without their version in the
name (`Tusk-universal.dmg`, `Tusk-x64-setup.exe`, `Tusk-x86_64.AppImage`,
`Tusk-amd64.deb`), so the website's download buttons link to
`releases/latest/download/<name>`. Copies installed from the `.deb` don't update
themselves. The key is kept only in Bitwarden: without it,
installed copies can't verify a new version, and you must ship a new key in a
DMG that everyone installs by hand.


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
`CNAME` file. It has no build step; serve the folder as it is.

Each push to `main` that changes `website/` deploys it to GitHub Pages through
`.github/workflows/website.yml`. To deploy without a change, run the
**Website** workflow from the repository's Actions tab. The domain needs a
`CNAME` record for `tusk` pointing at `almontasser.github.io`.

The download buttons link to the latest GitHub release.

The screenshots come from the dev app with `fixtures/demo` open (the designer
screenshots with [Filament's demo app](https://github.com/filamentphp/demo)), taken at
1400 × 900 through the Tauri MCP bridge, cropped, and saved as WebP with
`cwebp -q 88`.

## Project layout

| Path | Contents |
| --- | --- |
| `src/main.ts` | Layout, file tree, tabs, save, and keyboard shortcuts |
| `src/editor.ts` | Monaco setup, web workers, and the Blade, Vue, Svelte, and Astro grammars |
| `src/docblock.ts` | Enter and Tab in PHP docblock lines |
| `src/lsp.ts` | Language Server Protocol client and Monaco providers |
| `src/indexexclude.ts`, `src/indexexcludedialog.ts` | The vendor folders the index and Mago skip, per project, and the dialog that edits them |
| `src/diagnostics.ts` | Filters false problems out of the servers' diagnostics, and reads Mago's report |
| `src/problems.ts` | Problems panel: the project's errors and warnings |
| `src/terminal.ts` | Terminal panel |
| `src/layout.ts` | The window's layout: the sidebar and panel sizes, the full-width bottom panel, and maximizing it |
| `src/splitter.ts` | Resizable splits, with the keyboard, reset, limits, and saved sizes |
| `src/projectstate.ts`, `src/projectstatedata.ts` | Per-project settings, in `tusk.json` when shared or else on this Mac |
| `src/git.ts` | Commit view, diff view, partial staging, and branches |
| `src/stash.ts` | The Stashes tab and the Stash Changes dialog |
| `src/branches.ts` | The branches popup, branch actions, and fetch |
| `src/commitview.ts` | The Commit view's file tree, bulk actions, and commit |
| `src/sync.ts` | The Push dialog and Update Project |
| `src/history.ts` | Git log, file history, and commit actions |
| `src/conflicts.ts` | Inline merge conflict resolution |
| `src/merge.ts` | The three-pane merge tool |
| `src/rebase.ts` | Interactive rebase |
| `src/gitparse.ts` | Parsers for git output, line diffs, partial staging, merge alignment, and rebase todo lists |
| `src/prs.ts` | Pull requests through the GitHub CLI |
| `src/runner.ts` | Runs run configurations, the run widget, test run links, Run Anything, routes, and Tinker |
| `src/runconfig.ts` | Run configuration types, their forms, validation, and the commands they build |
| `src/runconfigdialog.ts` | The Run/Debug Configurations dialog |
| `src/testresults.ts` | The Tests tab: live progress, the results tree, and failure details |
| `src/junit.ts` | Reads JUnit reports, PHPUnit's event stream, TeamCity logs, failure diffs and stacks, and Clover coverage reports, and builds rerun filters |
| `src/coverage.ts` | Code coverage marks in the gutter and the Coverage tab |
| `src/profiler.ts` | Profiling runs, the profile list, and the Profiler tab |
| `src/cachegrind.ts` | Xdebug's profiles as the Profiler tab uses them, and the queries from its traces |
| `src/phptests.ts` | Finds PHPUnit and Pest tests in a file |
| `src/sail.ts` | Runs commands in Laravel Sail or a Docker Compose service when its containers are up |
| `src/files.ts` | File operations and the tree's context menu |
| `src/psr4.ts` | Namespaces from `composer.json` for new PHP files |
| `src/search.ts` | The Find view: find and replace in files, and TODO comments |
| `src/replacepreview.ts` | Replace Preview: the matches to replace, with checkboxes |
| `src/replacedata.ts` | Applying the replacements you kept to a file's text |
| `src/bookmarks.ts` | Bookmarks and the Bookmarks tab |
| `src/bookmarksdata.ts` | Reading and reordering saved bookmarks |
| `src/snippets.ts` | Your snippets from `snippets.json` |
| `src/surround.ts` | Surround With's templates and Paste from History's list |
| `src/format.ts` | Formatting with the project's Prettier or Pint, or Tusk's server (Mago's formatter) |
| `src/markdownpreview.ts` | The Markdown preview tab |
| `src/markdown.ts` | Renders Markdown for the preview, and its scroll position |
| `src/links.ts` | Resolves paths files name relative to their folder: Markdown links and `$schema` |
| `src/jsonschemas.ts` | Checks JSON config files against the bundled schemas in `src/schemas` |
| `src/localhistory.ts` | Local history of saved, changed, and deleted files, and labels |
| `src/localhistoryview.ts` | The Local History tab: versions, diffs, revert, and labels |
| `src/localhistorydata.ts` | Version names, labels, and which version a time points at |
| `src/retention.ts` | Which local history versions to delete |
| `src/editorconfig.ts` | Reads `.editorconfig` files |
| `src/settings.ts` | Settings, the settings dialog, and the color theme picker and import |
| `src/debug.ts` | The Xdebug debugger: breakpoints and their options, watches, stepping, and the Debug panel |
| `src/debugexceptions.ts` | Where an exception was thrown, the class of an uncaught one, and where Laravel renders them, for pausing on exceptions |
| `src/database.ts` | The Database tool window, query console, and results |
| `src/dbconfig.ts` | Database connections from `.env`, URLs, and `config/database.php`, schema queries, and cell updates |
| `src/dbgrid.ts` | The results grid: drawing rows as they scroll into view, selection, sorting, copying, the value viewer, and editing, shared by SQL tables and Redis keys |
| `src/dbgriddata.ts` | The grid's copy and export formats, sort order, and hex dump |
| `src/datasources.ts` | The Data Sources dialog |
| `src/deploy.ts`, `src/deploydata.ts` | Deployment: the transfer queue, File Transfer, Sync with Deployed, Remote Host, and the mappings between project and server paths |
| `src/deployservers.ts` | The Deployment settings dialog and the server key prompt |
| `src/redis.ts` | The Redis key browser, key view, and console completion |
| `src/redisdata.ts` | The Redis key tree, TTLs, filters, command syntax, and the commands that apply grid edits |
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
| `src/refactor.ts` | Inline's popup, Change Signature, Introduce Parameter, and Move Class |
| `src/classrefactor.ts` | Pull Members Up and Extract Interface: the member dialog, targets, and applying the edits |
| `src/classparse.ts` | Class members, their dependencies, moving class names between files, and the edits both refactorings make |
| `src/refactorparse.ts` | Argument, parameter, and declaration parsing for Change Signature |
| `src/signaturedialog.ts` | The Change Signature dialog |
| `src/refactorpreview.ts` | The Refactoring Preview panel |
| `src/extract.ts` | Extract Variable, Extract Constant, Introduce Field, and Extract Method's popups, naming in place, refusal hints, and Refactor This |
| `src/dom.ts` | The `h()` helper that builds DOM elements |
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
| `src-tauri/src/db.rs` | Database queries for SQLite, MySQL, MariaDB, PostgreSQL, and Redis, and canceling them |
| `src-tauri/src/deploy.rs` | Deployment over SFTP, FTP, and FTPS: pooled connections, atomic uploads, listings, and comparisons |
| `src-tauri/src/pty.rs` | Pseudo-terminals for the terminal panel |
| `src-tauri/src/ws.rs` | WebSocket connections for the HTTP client |
| `src-tauri/src/grpc.rs` | gRPC calls for the HTTP client, with schemas from server reflection or the project's `.proto` files |
| `src-tauri/src/profile.rs` | Reads Xdebug's Cachegrind profiles |
| `src-tauri/src/askpass.rs` | Asks git's and ssh's password and passphrase prompts in a dialog |
| `src-tauri/resources/mago.toml` | Default Mago configuration |
| `tusk-lsp/` | The PHP language server, which the app runs as `tusk lsp`: indexing, navigation, completion, diagnostics, refactorings, and Laravel and Filament features |
| `tusk-lsp/php/introspect.php` | Reads resources and models from the project, for the server and the editor |
| `tusk-lsp/php/laravel/` | The PHP scripts that report Laravel's routes, views, config, and other facts |
| `node-tools/` | The pinned Node language servers (`package.json` and lockfile) |
| `scripts/fetch-tools.sh` | Downloads the pinned language tools, one folder per tool |
| `scripts/fetch-schemas.ts` | Downloads the JSON schemas in `src/schemas` |
| `scripts/publish-tools.ts` | Publishes the tools the app downloads |
| `scripts/make-fixture.sh` | Creates the test app |
| `docs/architecture.md` | Architecture and decision log |
| `website/` | The Tusk website |


## Milestones

| Milestone | State |
| --- | --- |
| 1. Editor shell: folders, file tree, tabs, save, highlighting, file watcher | Done |
| 2. PHP intelligence | Done |
| 3. Laravel intelligence and Mago diagnostics | Done |
| 4. Terminal, Artisan, test runner, search | Done |
| 5. Git, blame, and pull requests | Done |
| 6. Filament intelligence | Done |
| 7. Tusk's own PHP language server (`tusk-lsp/`), replacing Phpactor, Laravel LSP, and the Filament server | Done |
| 8. Visual designers: Filament resources, models, and new projects | Done |
| 9. App designers: notifications, automations, scheduled tasks, environment settings, navigation, generated tests, settings pages, and record history | Done |

For the design and the reasons behind each choice, see
[Architecture and decisions](architecture.md).

Typing stays at about 3 ms of work per keystroke, even in a 4,800-line PHP file
with AI completion on, and language servers never block the window. For how
that's kept, and how to measure it, see
[Performance](architecture.md#performance).
